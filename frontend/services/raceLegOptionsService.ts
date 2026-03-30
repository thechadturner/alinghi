/**
 * Shared service for retrieving race and leg filter options for settings forms.
 * Ensures HuniDB is kept up to date via preload/fetchEvents (API → storeEvents),
 * and provides a consistent method: day context uses preload + HuniDB with date/races API fallback;
 * dataset context uses fetchEvents + HuniDB.
 */

import { getData, getTimezoneForDate, getDayBoundsInTimezone } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { huniDBStore } from '../store/huniDBStore';
import { TableNames, escapeTableName } from '../store/huniDBTypes';
import { unifiedDataStore } from '../store/unifiedDataStore';
import { debug, info } from '../utils/console';

export type RaceOption = number | 'TRAINING';

export interface RaceLegOptionsResult {
  races: RaceOption[];
  legs: number[];
}

function normalizeDate(date: string): string {
  const dateNorm = String(date).replace(/[-/]/g, '');
  return dateNorm.length >= 8
    ? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`
    : String(date);
}

function sortRaces(a: RaceOption, b: RaceOption): number {
  if (a === 'TRAINING') return -1;
  if (b === 'TRAINING') return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function normalizeRaceFromRow(raceNum: unknown): RaceOption | null {
  if (raceNum === 'TRAINING' || raceNum === 'training' || raceNum === '-1' || raceNum === -1) return 'TRAINING';
  const num = Number(raceNum);
  if (Number.isFinite(num)) return num;
  if (raceNum != null && raceNum !== undefined) return raceNum as RaceOption;
  return null;
}

/**
 * Fetch race options from date/races API for day context when HuniDB has no data.
 */
async function fetchRacesFromDateApi(
  className: string,
  projectId: number,
  dateStr: string
): Promise<RaceOption[]> {
  const timezone = await getTimezoneForDate(className, projectId, dateStr);
  let url = `${apiEndpoints.app.datasets}/date/races?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}`;
  if (timezone) url += `&timezone=${encodeURIComponent(timezone)}`;
  const resp = await getData(url);
  const list = (resp && (resp as { data?: unknown[] }).data) ?? (Array.isArray(resp) ? resp : []);
  const extracted = (Array.isArray(list) ? list : []).map((r: { race_number?: number; Race_number?: number; [key: string]: unknown }) => {
    const raceNum = r?.race_number ?? r?.Race_number ?? r?.racenumber ?? r?.RaceNumber ?? r?.['Race_number'];
    if (raceNum === -1 || raceNum === '-1') return 'TRAINING' as const;
    const num = Number(raceNum);
    return Number.isFinite(num) ? num : null;
  }).filter((v): v is RaceOption => v !== null && v !== undefined);
  return [...new Set(extracted)].sort(sortRaces);
}

/**
 * Query distinct races from HuniDB agg.events with the given WHERE clause and params.
 */
async function queryRacesFromHuniDB(
  db: { query: (sql: string, params: unknown[]) => Promise<{ race_number?: unknown }[]> },
  eventsTable: string,
  whereClause: string,
  params: unknown[]
): Promise<RaceOption[]> {
  const racesSql = `SELECT DISTINCT COALESCE(json_extract(tags, '$.Race_number'), json_extract(tags, '$.race_number')) AS race_number FROM ${eventsTable} WHERE ${whereClause} AND (json_extract(tags, '$.Race_number') IS NOT NULL OR json_extract(tags, '$.race_number') IS NOT NULL)`;
  const raceRows = await db.query(racesSql, params);
  const races = raceRows
    .map((r) => normalizeRaceFromRow(r.race_number))
    .filter((v): v is RaceOption => v !== null && v !== undefined)
    .sort(sortRaces);
  return races;
}

/**
 * Query distinct legs from HuniDB agg.events; always include 0.
 */
async function queryLegsFromHuniDB(
  db: { query: (sql: string, params: unknown[]) => Promise<{ leg_number?: number }[]> },
  eventsTable: string,
  whereClause: string,
  params: unknown[]
): Promise<number[]> {
  const legsSql = `SELECT DISTINCT CAST(COALESCE(json_extract(tags, '$.Leg_number'), json_extract(tags, '$.leg_number')) AS INTEGER) AS leg_number FROM ${eventsTable} WHERE ${whereClause} AND (json_extract(tags, '$.Leg_number') IS NOT NULL OR json_extract(tags, '$.leg_number') IS NOT NULL) AND CAST(COALESCE(json_extract(tags, '$.Leg_number'), json_extract(tags, '$.leg_number')) AS REAL) >= 0 ORDER BY leg_number ASC`;
  const legRows = await db.query(legsSql, params);
  const legsFromDb = legRows
    .map((l) => l.leg_number)
    .filter((v): v is number => v != null && !Number.isNaN(v))
    .map(Number)
    .sort((a, b) => a - b);
  return legsFromDb.length > 0 ? [...new Set([0, ...legsFromDb])].sort((a, b) => a - b) : [0];
}

export type RaceLegContext = 'day' | 'dataset';

export interface GetRaceLegOptionsParams {
  context: RaceLegContext;
  className: string;
  projectId: number;
  date?: string;
  datasetId?: number;
  /** When true, in dataset context we call fetchEvents to ensure HuniDB is populated. */
  ensureEventsLoaded?: boolean;
}

/**
 * Get race and leg options for the current context. Uses a consistent method:
 * - Day context: triggers preloadEventsForDate (API → HuniDB), queries HuniDB; if no races, falls back to date/races API.
 * - Dataset context: optionally fetches events for the dataset, then queries HuniDB.
 */
export async function getRaceAndLegOptions(params: GetRaceLegOptionsParams): Promise<RaceLegOptionsResult> {
  const { context, className, projectId, date, datasetId, ensureEventsLoaded = true } = params;

  if (!className || !projectId) {
    return { races: [], legs: [0] };
  }

  const result: RaceLegOptionsResult = { races: [], legs: [0] };

  if (context === 'day') {
    if (!date || String(date).trim() === '') return result;
    const dateStr = normalizeDate(date);

    // Trigger preload so HuniDB is updated from API (non-blocking)
    unifiedDataStore.preloadEventsForDate(className, projectId, dateStr).catch(() => {});

    try {
      const db = await huniDBStore.getDatabase(className.toLowerCase());
      const eventsTable = escapeTableName(TableNames.events);
      const timezone = await getTimezoneForDate(className, projectId, dateStr);
      const { startMs, endMs } = getDayBoundsInTimezone(dateStr, timezone);
      const whereConditions = ['project_id = ?', 'start_time >= ?', 'start_time <= ?'];
      const whereParams: unknown[] = [String(projectId), startMs, endMs];
      const whereClause = whereConditions.join(' AND ');

      const racesFromDb = await queryRacesFromHuniDB(db, eventsTable, whereClause, whereParams);
      result.legs = await queryLegsFromHuniDB(db, eventsTable, whereClause, whereParams);

      // Union with date/races API so the UI lists all races for the day. HuniDB may only
      // contain events for a subset of races (sync lag / partial ingest); API is authoritative for the calendar day.
      const raceKey = (r: RaceOption): string => (r === 'TRAINING' ? 'TRAINING' : `n:${Number(r)}`);
      const merged = new Map<string, RaceOption>();
      for (const r of racesFromDb) merged.set(raceKey(r), r);
      try {
        const apiRaces = await fetchRacesFromDateApi(className, projectId, dateStr);
        for (const r of apiRaces) {
          const k = raceKey(r);
          if (!merged.has(k)) merged.set(k, r);
        }
        if (apiRaces.length > 0 && merged.size > racesFromDb.length) {
          info('raceLegOptionsService: Day context – merged date/races API into HuniDB list', {
            fromDb: racesFromDb.length,
            fromApi: apiRaces.length,
            merged: merged.size,
          });
        }
      } catch (apiErr) {
        debug('raceLegOptionsService: date/races API merge failed (day context)', apiErr);
      }
      result.races = [...merged.values()].sort(sortRaces);
      if (result.races.length === 0) {
        try {
          result.races = await fetchRacesFromDateApi(className, projectId, dateStr);
          if (result.races.length > 0) {
            info('raceLegOptionsService: Day context – no races after merge, used API only', { count: result.races.length });
          }
        } catch (apiErr2) {
          debug('raceLegOptionsService: date/races API fallback failed', apiErr2);
        }
      }
    } catch (err) {
      debug('raceLegOptionsService: HuniDB query failed (day context)', err);
      try {
        result.races = await fetchRacesFromDateApi(className, projectId, dateStr);
      } catch (apiErr) {
        debug('raceLegOptionsService: date/races API fallback failed', apiErr);
      }
    }
    return result;
  }

  // Dataset context
  if (!datasetId || datasetId <= 0) return result;

  if (ensureEventsLoaded) {
    try {
      await unifiedDataStore.fetchEvents(className, projectId, datasetId);
    } catch {
      // Non-blocking; we still query HuniDB
    }
  }

  try {
    const db = await huniDBStore.getDatabase(className.toLowerCase());
    const eventsTable = escapeTableName(TableNames.events);
    const whereConditions = ['project_id = ?', 'dataset_id = ?'];
    const whereParams: unknown[] = [String(projectId), String(datasetId)];
    const whereClause = whereConditions.join(' AND ');

    result.races = await queryRacesFromHuniDB(db, eventsTable, whereClause, whereParams);
    result.legs = await queryLegsFromHuniDB(db, eventsTable, whereClause, whereParams);
  } catch (err) {
    debug('raceLegOptionsService: HuniDB query failed (dataset context)', err);
  }

  return result;
}
