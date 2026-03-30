import { createSignal, onMount, onCleanup, createEffect, Show, For, createMemo } from "solid-js";
import * as d3 from "d3";
import { persistantStore } from "../../../../store/persistantStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { getData, getTimezoneForDate, setupMediaContainerScaling } from "../../../../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../utils/logging";
import { log, debug as logDebug, error as logError } from "../../../../utils/console";
import Loading from "../../../../components/utilities/Loading";
import DropDownButton from "../../../../components/buttons/DropDownButton";
import { selectedSources as filterStoreSelectedSources } from "../../../../store/filterStore";
import RaceSettings from "../../../../components/menus/RaceSettings";

/** Inline style for TEAM cell: font color = default source color; undefined if no color. */
function getTeamCellStyle(sourceName: string | null | undefined): string | undefined {
  if (sourceName == null || String(sourceName).trim() === "") return undefined;
  const color = sourcesStore.getSourceColor(String(sourceName));
  if (!color) return undefined;
  return `color: ${color};`;
}

const { selectedClassName, selectedProjectId, selectedDate } = persistantStore;

/** Row from race-day-results API: position (total rank by elapsed time), source_name, race1, race2, ... average, total, total_elapsed_sec */
interface RaceDayResultRow {
  position?: number | null;
  source_name: string;
  average?: number | null;
  total: number;
  total_elapsed_sec?: number | null;
  [key: string]: string | number | null | undefined;
}

/** Row from race-summary API (data.js): source_name, vmg_avg, vmg_perc_avg, polar_perc_avg, tws_avg_kph, bsp_avg_kph, ... */
interface RaceSummaryRow {
  source_name: string;
  vmg_avg: number | null;
  vmg_perc_avg: number | null;
  polar_perc_avg: number | null;
  tws_avg_kph: number | null;
  bsp_avg_kph: number | null;
  start_speed: number | null;
  max_speed: number | null;
  rh300_perc: number | null;
  rh750_perc: number | null;
  rhgood_perc: number | null;
  rh1400_perc: number | null;
  foiling_perc: number | null;
  phase_dur_avg_sec: number | null;
  maneuver_count: number | null;
  tack_loss_avg: number | null;
  gybe_loss_avg: number | null;
  roundup_loss_avg: number | null;
  bearaway_loss_avg: number | null;
  position?: number | null;
  [key: string]: string | number | null | undefined;
}

/** Row from race-setup API (phase averages from events_aggregate): source_name, position, avg_* and std_* for setup channels */
interface RaceSetupRow {
  source_name: string;
  position: number | null;
  avg_tws: number | null;
  avg_bsp: number | null;
  avg_twa: number | null;
  avg_vmg_kph: number | null;
  avg_vmg_perc: number | null;
  avg_polar_perc: number | null;
  avg_heel: number | null;
  avg_pitch: number | null;
  avg_rh: number | null;
  avg_cant: number | null;
  avg_cant_eff: number | null;
  avg_rud_rake: number | null;
  avg_wing_clew: number | null;
  avg_wing_ca1: number | null;
  avg_wing_twist: number | null;
  avg_jib_sheet: number | null;
  avg_jib_lead: number | null;
  avg_jib_cunno: number | null;
  /** Phase std from events_aggregate (when data_mode=phases) */
  std_tws?: number | null;
  std_bsp?: number | null;
  std_twa?: number | null;
  std_vmg_kph?: number | null;
  std_vmg_perc?: number | null;
  std_polar_perc?: number | null;
  std_heel?: number | null;
  std_pitch?: number | null;
  std_rh?: number | null;
  std_cant?: number | null;
  std_cant_eff?: number | null;
  std_rud_rake?: number | null;
  std_wing_clew?: number | null;
  std_wing_ca1?: number | null;
  std_wing_twist?: number | null;
  std_jib_sheet?: number | null;
  std_jib_lead?: number | null;
  std_jib_cunno?: number | null;
  [key: string]: string | number | null | undefined;
}

/** Race summary table columns (vmg_perc_avg shown in place of vmg_avg for ordering) */
const RACE_SUMMARY_TABLE_COLUMNS: { key: keyof RaceSummaryRow; header: string }[] = [
  { key: "source_name", header: "TEAM" },
  { key: "vmg_perc_avg", header: "VMG [%]" },
  { key: "tws_avg_kph", header: "TWS [KPH]" },
  { key: "bsp_avg_kph", header: "BSP [KPH]" },
  { key: "start_speed", header: "START SPEED [KPH]" },
  { key: "max_speed", header: "MAX SPEED [KPH]" },
  { key: "rh300_perc", header: "RH < 300 [%]" },
  { key: "rh750_perc", header: "RH > 300 < 750 [%]" },
  { key: "rhgood_perc", header: "RH > 750 < 1400 [%]" },
  { key: "rh1400_perc", header: "RH > 1400 [%]" },
  { key: "foiling_perc", header: "FOILING [%]" },
  { key: "phase_dur_avg_sec", header: "AVG PHASE DUR [SEC]" },
  { key: "maneuver_count", header: "MANEUVER COUNT" },
  { key: "tack_loss_avg", header: "TACK LOSS [M]" },
  { key: "gybe_loss_avg", header: "GYBE LOSS [M]" },
  { key: "roundup_loss_avg", header: "ROUNDUP LOSS [M]" },
  { key: "bearaway_loss_avg", header: "BEARAWAY LOSS [M]" },
];

/** Averages table columns for upwind/downwind (VMG and VMG%) */
const AVERAGES_COLUMNS_UPWIND_DOWNWIND: { key: keyof RaceSetupRow; header: string }[] = [
  { key: "avg_tws", header: "TWS [KPH]" },
  { key: "avg_bsp", header: "BSP [KPH]" },
  { key: "avg_twa", header: "TWA [DEG]" },
  { key: "avg_vmg_kph", header: "VMG [KPH]" },
  { key: "avg_vmg_perc", header: "VMG [%]" },
  { key: "avg_heel", header: "HEEL_N [DEG]" },
  { key: "avg_pitch", header: "PITCH [DEG]" },
  { key: "avg_rh", header: "RH LWD [MM]" },
  { key: "avg_cant", header: "CANT [DEG]" },
  { key: "avg_cant_eff", header: "CANT_EFF [DEG]" },
  { key: "avg_rud_rake", header: "RUD_RAKE [DEG]" },
  { key: "avg_wing_clew", header: "WING CLEW [MM]" },
  { key: "avg_wing_ca1", header: "CA1 [DEG]" },
  { key: "avg_wing_twist", header: "TOTAL TWIST [DEG]" },
  { key: "avg_jib_sheet", header: "JIB SHT LOAD [KGF]" },
  { key: "avg_jib_lead", header: "JIB LEAD [DEG]" },
  { key: "avg_jib_cunno", header: "JIB CUN LOAD [KGF]" },
];

/** Averages table columns for reaching (POLAR % instead of VMG / VMG%) */
const AVERAGES_COLUMNS_REACHING: { key: keyof RaceSetupRow; header: string }[] = [
  { key: "avg_tws", header: "TWS [KPH]" },
  { key: "avg_bsp", header: "BSP [KPH]" },
  { key: "avg_twa", header: "TWA [DEG]" },
  { key: "avg_polar_perc", header: "POLAR [%]" },
  { key: "avg_heel", header: "HEEL_N [DEG]" },
  { key: "avg_pitch", header: "PITCH [DEG]" },
  { key: "avg_rh", header: "RH LWD [MM]" },
  { key: "avg_cant", header: "CANT [DEG]" },
  { key: "avg_cant_eff", header: "CANT_EFF [DEG]" },
  { key: "avg_rud_rake", header: "RUD_RAKE [DEG]" },
  { key: "avg_wing_clew", header: "WING CLEW [MM]" },
  { key: "avg_wing_ca1", header: "CA1 [DEG]" },
  { key: "avg_wing_twist", header: "TOTAL TWIST [DEG]" },
  { key: "avg_jib_sheet", header: "JIB SHT LOAD [KGF]" },
  { key: "avg_jib_lead", header: "JIB LEAD [DEG]" },
  { key: "avg_jib_cunno", header: "JIB CUN LOAD [KGF]" },
];

export default function RaceSummaryPage() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  /** Legacy: race-day-results table data (no longer shown; race summary section uses getRaceSummary_TableData with race=0 when All) */
  const [resultsRows, setResultsRows] = createSignal<RaceDayResultRow[]>([]);
  const [summaryRows, setSummaryRows] = createSignal<RaceSummaryRow[]>([]);
  const [races, setRaces] = createSignal<string[]>([]);
  /** Race keys excluded from total/average (≤3 teams); show position as (1), (2), (3) */
  const [excludedRacesFromResults, setExcludedRacesFromResults] = createSignal<Set<string>>(new Set<string>());
  /** Races from race-day-results API (all races with race_stats). Used for Results table columns when "All" so 3-team races appear. */
  const [resultsRacesFromApi, setResultsRacesFromApi] = createSignal<string[]>([]);
  const [averagesRows, setAveragesRows] = createSignal<RaceSetupRow[]>([]);

  /** "All" or a specific race key (e.g. "1180505") */
  const [selectedRace, setSelectedRace] = createSignal<string>("All");
  /** reaching | upwind | downwind - maps to REACH, UPWIND, DOWNWIND */
  const [legType, setLegType] = createSignal<string>("reaching");
  /** Setups section only: phases (race_stats) | best_modes (BIN 10 grade > 1) | displacement (BIN 10 state > 0) */
  const [dataMode, setDataMode] = createSignal<'phases' | 'best_modes' | 'displacement'>('phases');
  /** Show deltas from first row in single-race Results table */
  const [showDeltasResults, setShowDeltasResults] = createSignal(true);
  /** Show deltas from first row in Race Setups (averages) table */
  const [showDeltasAverages, setShowDeltasAverages] = createSignal(true);

  /* --- Results table (All): sort + conditional formatting (same as maneuver tables) --- */
  const [sortConfigResults, setSortConfigResults] = createSignal<{ key: string; direction: "asc" | "desc" }>({ key: "", direction: "asc" });
  const [columnScalesResults, setColumnScalesResults] = createSignal<Record<string, string>>({});
  const [formattedColumnsResults, setFormattedColumnsResults] = createSignal<string[]>([]);
  /* --- Summary table (single race): sort + conditional formatting; default order by vmg_perc_avg desc --- */
  const [sortConfigSummary, setSortConfigSummary] = createSignal<{ key: string; direction: "asc" | "desc" }>({ key: "vmg_perc_avg", direction: "desc" });
  const [columnScalesSummary, setColumnScalesSummary] = createSignal<Record<string, string>>({});
  const [formattedColumnsSummary, setFormattedColumnsSummary] = createSignal<string[]>([]);
  /* --- Averages table: sort + conditional formatting --- */
  const [sortConfigAvg, setSortConfigAvg] = createSignal<{ key: string; direction: "asc" | "desc" }>({ key: "", direction: "asc" });
  const [columnScalesAvg, setColumnScalesAvg] = createSignal<Record<string, string>>({});
  const [formattedColumnsAvg, setFormattedColumnsAvg] = createSignal<string[]>([]);
  /* --- Copy table data (hover + clipboard) --- */
  const [isHoveredSummary, setIsHoveredSummary] = createSignal(false);
  const [isHoveredAverages, setIsHoveredAverages] = createSignal(false);
  const [showCopySummary, setShowCopySummary] = createSignal(false);
  const [showCopyAverages, setShowCopyAverages] = createSignal(false);
  const [copySuccessSummary, setCopySuccessSummary] = createSignal(false);
  const [copySuccessAverages, setCopySuccessAverages] = createSignal(false);

  createEffect(() => {
    if (isHoveredSummary()) {
      const timer = setTimeout(() => setShowCopySummary(true), 2000);
      onCleanup(() => clearTimeout(timer));
    } else {
      setShowCopySummary(false);
    }
  });

  createEffect(() => {
    if (isHoveredAverages()) {
      const timer = setTimeout(() => setShowCopyAverages(true), 2000);
      onCleanup(() => clearTimeout(timer));
    } else {
      setShowCopyAverages(false);
    }
  });
  const [summaryLoading, setSummaryLoading] = createSignal(false);
  let summaryFetchSeq = 0;

  /** Get comparable value for sort/scale from a row by key. Tries key as-is then case-insensitive match (API/DB may return e.g. Vmg_perc_avg). */
  const getRowValue = (row: Record<string, unknown>, key: string): number | string | null => {
    if (key === "rank") return null; /* rank is 1-based index, not on row */
    let v = row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
    if (v === undefined) {
      const foundKey = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
      v = foundKey != null ? row[foundKey] : undefined;
    }
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    return String(v);
  };

  /** Sort rows by key and direction; optionally build scale for that key (min/max -> 0..6) and store. */
  const sortAndFormat = <T extends Record<string, unknown>>(
    rows: T[],
    key: string,
    currentSort: { key: string; direction: "asc" | "desc" },
    setSortConfig: (c: { key: string; direction: "asc" | "desc" }) => void,
    getScales: () => Record<string, string>,
    setScales: (s: Record<string, string>) => void,
    getFormatted: () => string[],
    setFormatted: (cols: string[]) => void,
    valueKeys: string[] /* keys that are numeric and get scale */
  ): T[] => {
    const direction = currentSort.key === key && currentSort.direction === "asc" ? "desc" : "asc";
    setSortConfig({ key, direction });

    const getVal = (row: T) => getRowValue(row as Record<string, unknown>, key);
    const sorted = [...rows].sort((a, b) => {
      const aV = getVal(a);
      const bV = getVal(b);
      if (aV == null && bV == null) return 0;
      if (aV == null) return 1;   /* nulls at bottom */
      if (bV == null) return -1; /* nulls at bottom */
      const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
      return direction === "asc" ? cmp : -cmp;
    });

    if (valueKeys.includes(key)) {
      const values = rows.map((r) => getVal(r)).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
      const min = d3.min(values) ?? 0;
      const max = d3.max(values) ?? 0;
      const scaleStr = JSON.stringify({ domain: [min, max], range: [0, 6] });
      setScales({ ...getScales(), [key]: scaleStr });
      const formattedCols = getFormatted();
      setFormatted(formattedCols.includes(key) ? formattedCols : [...formattedCols, key]);
    }
    return sorted;
  };

  /** Recompute scale (min/max -> 0..6) for each formatted column from current rows; returns new scales record. */
  const recomputeScalesFromData = (
    rows: Record<string, unknown>[],
    formattedKeys: string[],
    valueKeys: string[]
  ): Record<string, string> => {
    const newScales: Record<string, string> = {};
    for (const key of formattedKeys) {
      if (!valueKeys.includes(key) || rows.length === 0) continue;
      const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
      const values = rows.map((r) => getVal(r)).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
      const min = d3.min(values) ?? 0;
      const max = d3.max(values) ?? 0;
      newScales[key] = JSON.stringify({ domain: [min, max], range: [0, 6] });
    }
    return newScales;
  };

  /** Cell class for conditional formatting (c0..c6) when column has a scale. */
  const cellClassForScale = (
    row: Record<string, unknown>,
    key: string,
    scales: Record<string, string>,
    formatted: string[]
  ): string => {
    if (!formatted.includes(key) || !scales[key]) return "";
    try {
      const { domain, range } = JSON.parse(scales[key]) as { domain: number[]; range: number[] };
      const scale = d3.scaleLinear().domain(domain).range(range);
      const v = getRowValue(row, key);
      if (v == null || typeof v !== "number" || Number.isNaN(v)) return "";
      const x = scale(v);
      return `c${Math.round(Math.max(0, Math.min(6, x)))}`;
    } catch {
      return "";
    }
  };

  const dateNorm = (): string => {
    const d = selectedDate();
    if (!d) return "";
    return String(d).replace(/[-/]/g, "");
  };

  /** Get selected source names from filterStore (same as FleetMap uses) */
  const getSelectedSourceNames = (): Set<string> | null => {
    try {
      const sourceNames = filterStoreSelectedSources();
      if (Array.isArray(sourceNames) && sourceNames.length > 0) {
        // Normalize to lowercase for case-insensitive matching
        return new Set(sourceNames.map((name: string) => String(name).toLowerCase().trim()));
      }
      return null;
    } catch (err) {
      logError('RaceSummary: Error getting selected source names', err);
      return null;
    }
  };

  /** Fetch list of races for the date from events (datasets/date/races). Used for ALL + per-race buttons. */
  const fetchRaces = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = dateNorm();
    if (!className || !projectId || date.length !== 8) {
      setRaces([]);
      return;
    }
    try {
      const timezone = await getTimezoneForDate(className, Number(projectId), date);
      let url = `${apiEndpoints.app.datasets}/date/races?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}`;
      if (timezone) url += `&timezone=${encodeURIComponent(timezone)}`;
      const result = await getData(url);
      if (!result?.success) {
        setRaces([]);
        return;
      }
      const rows = result.data as { Race_number: number }[] | null | undefined;
      if (!Array.isArray(rows)) {
        setRaces([]);
        return;
      }
      const raceKeys = rows
        .map((r) => (r?.Race_number != null ? String(r.Race_number) : null))
        .filter((k): k is string => k != null && k !== "" && k !== "-1");
      setRaces(raceKeys);
    } catch (err) {
      logError("RaceSummary: fetch races (date/races) failed", err);
      setRaces([]);
    }
  };

  /** Fetch Results table from race-day-results. Only called when "All" is selected. */
  const fetchRaceDayResults = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = dateNorm();
    if (!className || !projectId || date.length !== 8) {
      setResultsRows([]);
      return;
    }
    try {
      const url = `${apiEndpoints.app.data}/race-day-results?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}`;
      const result = await getData(url);
      if (!result?.success) {
        setError(result?.message || "Failed to load race results");
        setResultsRows([]);
        setExcludedRacesFromResults(new Set<string>());
        setResultsRacesFromApi([]);
        return;
      }
      const payload = result.data as { rows?: Record<string, unknown>[]; races?: string[]; excludedRaces?: string[] };
      let raw = Array.isArray(payload?.rows) ? payload.rows : [];
      const apiRaces = Array.isArray(payload?.races) ? (payload.races as string[]) : [];
      const excludedSet = new Set<string>(Array.isArray(payload?.excludedRaces) ? (payload.excludedRaces as string[]) : []);

      // Filter rows by global source selection from filterStore (same as FleetMap)
      const selectedSourceNames = getSelectedSourceNames();
      if (selectedSourceNames) {
        raw = raw.filter((row) => {
          const sourceName = String(row.source_name ?? row.Source_name ?? row.SourceName ?? row.sourcename ?? '').toLowerCase().trim();
          return sourceName && selectedSourceNames.has(sourceName);
        });
        logDebug('RaceSummary (race-day-results): Filtered rows by global source selection', { 
          totalRows: payload?.rows?.length ?? 0, 
          filteredRows: raw.length,
          selectedSourceNames: Array.from(selectedSourceNames)
        });
      }

      // Build rows from API: copy only source_name and race1, race2, ... (omit total, average, position — we compute those below)
      const rows: RaceDayResultRow[] = raw.map((r) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        const out: Record<string, string | number | null | undefined> = {};
        const skipKeys = new Set(["total", "average", "position"]);
        for (const k of Object.keys(row)) {
          const keyLower = k.toLowerCase();
          if (skipKeys.has(keyLower)) continue;
          out[keyLower] = row[k] as string | number | null | undefined;
        }
        return out as RaceDayResultRow;
      });

      const qualifyingIndices = apiRaces
        .map((raceKey, i) => (excludedSet.has(raceKey) ? -1 : i))
        .filter((i) => i >= 0);
      const numQualifying = qualifyingIndices.length;

      if (numQualifying > 0) {
        // Ignore API total/average: compute from race positions only (so turning boats off adjusts ranking)
        const rowsWithTotals = rows.map((row) => {
          let total = 0;
          for (const i of qualifyingIndices) {
            const v = row[`race${i + 1}` as keyof RaceDayResultRow];
            const num = v != null && !Number.isNaN(Number(v)) ? Number(v) : null;
            // DNF: no rank (null) or stored as 10 (finisher count). Use 14 points.
            const n = num != null && num !== 10 ? num : 14;
            total += n;
          }
          return {
            ...row,
            total: Math.round(total * 100) / 100,
            average: Math.round((total / numQualifying) * 100) / 100,
          };
        });

        // Sort by total (ascending = better, lower total is better)
        rowsWithTotals.sort((a, b) => (a.total ?? 0) - (b.total ?? 0));

        // Assign TOTAL RANK from sorted order (1-based)
        rowsWithTotals.forEach((row, idx) => {
          row.position = idx + 1;
        });

        setResultsRows(rowsWithTotals);
      } else {
        setResultsRows(rows);
      }
      setExcludedRacesFromResults(excludedSet);
      setResultsRacesFromApi(apiRaces);
      setError(null);
    } catch (err) {
      logError("RaceSummary: fetch race-day-results failed", err);
      setError(err instanceof Error ? err.message : "Failed to load race results");
      setResultsRows([]);
      setExcludedRacesFromResults(new Set<string>());
      setResultsRacesFromApi([]);
    }
  };

  /** Fetch race summary from race-summary endpoint. When raceKey is "0", backend returns aggregates across all races (averages for most metrics; max_speed is the maximum across races). */
  const fetchRaceSummary = async (raceKey: string) => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = dateNorm();
    if (!className || !projectId || date.length !== 8) {
      setSummaryRows([]);
      setSummaryLoading(false);
      return;
    }
    let requestSeq = 0;
    try {
      requestSeq = ++summaryFetchSeq;
      setError(null);
      setSummaryLoading(true);
      setSummaryRows([]);
      const finishIfCurrent = () => {
        if (requestSeq === summaryFetchSeq) setSummaryLoading(false);
      };
      const url = `${apiEndpoints.app.data}/race-summary?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}&race=${encodeURIComponent(raceKey)}`;
      const result = await getData(url);
      if (requestSeq !== summaryFetchSeq) return;
      if (!result?.success) {
        setSummaryRows([]);
        finishIfCurrent();
        return;
      }
      const payload = result.data as { rows?: Record<string, unknown>[] };
      let raw = Array.isArray(payload?.rows) ? payload.rows : [];
      
      // Filter rows by global source selection from filterStore (same as FleetMap)
      const selectedSourceNames = getSelectedSourceNames();
      if (selectedSourceNames) {
        raw = raw.filter((row) => {
          const sourceName = String(row.source_name ?? row.Source_name ?? row.SourceName ?? row.sourcename ?? '').toLowerCase().trim();
          return sourceName && selectedSourceNames.has(sourceName);
        });
        logDebug('RaceSummary (race-summary): Filtered rows by global source selection', { 
          totalRows: payload?.rows?.length ?? 0, 
          filteredRows: raw.length,
          selectedSourceNames: Array.from(selectedSourceNames)
        });
      }
      
      const rows: RaceSummaryRow[] = raw.map((r) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        const out: Record<string, string | number | null | undefined> = {};
        for (const k of Object.keys(row)) {
          out[k.toLowerCase()] = row[k] as string | number | null | undefined;
        }
        return out as RaceSummaryRow;
      });
      setSummaryRows(rows);
      finishIfCurrent();
    } catch (err) {
      if (summaryFetchSeq === 0) return;
      logError("RaceSummary: fetch race-summary failed", err);
      setSummaryRows([]);
      if (requestSeq === summaryFetchSeq) setSummaryLoading(false);
    }
  };

  const fetchRaceSetup = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = dateNorm();
    const race = selectedRace() === "All" ? "" : selectedRace();
    if (!className || !projectId || date.length !== 8) {
      setAveragesRows([]);
      return;
    }
    try {
      let url = `${apiEndpoints.app.data}/race-setup?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}&leg_type=${encodeURIComponent(legType())}&data_mode=${encodeURIComponent(dataMode())}`;
      if (race) url += `&race=${encodeURIComponent(race)}`;
      const result = await getData(url);
      if (!result?.success) {
        setAveragesRows([]);
        return;
      }
      const payload = result.data as { rows?: unknown[] };
      let raw = Array.isArray(payload?.rows) ? payload.rows : [];
      
      // Filter rows by global source selection from filterStore (same as FleetMap)
      const selectedSourceNames = getSelectedSourceNames();
      if (selectedSourceNames) {
        raw = raw.filter((row) => {
          const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
          const sourceName = String(r.source_name ?? r.Source_name ?? r.SourceName ?? r.sourcename ?? '').toLowerCase().trim();
          return sourceName && selectedSourceNames.has(sourceName);
        });
        logDebug('RaceSummary (race-setup): Filtered rows by global source selection', { 
          totalRows: payload?.rows?.length ?? 0, 
          filteredRows: raw.length,
          selectedSourceNames: Array.from(selectedSourceNames)
        });
      }
      
      // Normalize row keys to lowercase (PostgreSQL / drivers may return lowercase)
      const rows: RaceSetupRow[] = raw.map((r: unknown) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
        const out: Record<string, string | number | null | undefined> = {};
        for (const k of Object.keys(row)) {
          out[k.toLowerCase()] = row[k] as string | number | null | undefined;
        }
        return out as RaceSetupRow;
      });
      setAveragesRows(rows);
    } catch (err) {
      logError("RaceSummary: fetch race-setup failed", err);
      setAveragesRows([]);
    }
  };

  onMount(() => {
    logDebug("RaceSummary: mount");
    logPageLoad("RaceSummary.tsx", "Race Summary", "Loaded");
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: "RaceSummary",
      scaleToWidth: true,
    });
    onCleanup(() => cleanupScaling());
    (async () => {
      setLoading(true);
      setError(null);
      await fetchRaces();
      if (selectedRace() === "All") await fetchRaceSummary("0");
      setLoading(false);
    })();
  });

  createEffect(() => {
    selectedClassName();
    selectedProjectId();
    selectedDate();
    selectedRace();
    // Also watch filterStore for source selection changes
    filterStoreSelectedSources();
    if (!loading()) {
      fetchRaces();
      if (selectedRace() === "All") fetchRaceSummary("0");
    }
  });

  /** Refetch race summary only when selected race or source filters change (summary API does not use legType/dataMode). */
  createEffect(() => {
    selectedRace();
    filterStoreSelectedSources();
    if (!loading() && dateNorm().length === 8) {
      const race = selectedRace();
      if (race === "All") fetchRaceSummary("0");
      else if (race) fetchRaceSummary(race);
      else setSummaryRows([]);
    }
  });

  /** Refetch Average Setups when race, leg type, data mode, or source filters change. */
  createEffect(() => {
    selectedRace();
    legType();
    dataMode();
    filterStoreSelectedSources();
    if (!loading() && dateNorm().length === 8) {
      fetchRaceSetup();
    }
  });

  /** When leg type changes, set default sort for Average Setup: reaching = avg_polar_perc desc, upwind/downwind = avg_vmg_perc desc. */
  createEffect(() => {
    const leg = legType();
    if (leg === "reaching") {
      setSortConfigAvg({ key: "avg_polar_perc", direction: "desc" });
    } else {
      setSortConfigAvg({ key: "avg_vmg_perc", direction: "desc" });
    }
  });

  /** Averages table columns: when reaching show POLAR % AVG (no VMG/VMG%); upwind/downwind show VMG [KPH] and VMG%. */
  const averagesTableColumns = createMemo(() =>
    legType() === "reaching" ? AVERAGES_COLUMNS_REACHING : AVERAGES_COLUMNS_UPWIND_DOWNWIND
  );

  /** When Average Setup data or leg type changes, recompute conditional formatting scales from current data. */
  createEffect(() => {
    legType(); /* depend on leg type so we re-run when user switches REACH/UPWIND/DOWNWIND */
    const rows = averagesRows() as unknown as Record<string, unknown>[];
    const formatted = formattedColumnsAvg();
    const cols = averagesTableColumns();
    if (formatted.length === 0 || rows.length === 0) return;
    const valueKeys = cols.map((c) => String(c.key));
    const newScales = recomputeScalesFromData(rows, formatted, valueKeys);
    if (Object.keys(newScales).length > 0) setColumnScalesAvg(newScales);
  });

  /** When Results (All) data changes, recompute conditional formatting scales from current data. */
  createEffect(() => {
    const rows = resultsRows() as unknown as Record<string, unknown>[];
    const formatted = formattedColumnsResults();
    if (formatted.length === 0 || rows.length === 0) return;
    const valueKeys = resultsValueKeys();
    const newScales = recomputeScalesFromData(rows, formatted, valueKeys);
    if (Object.keys(newScales).length > 0) setColumnScalesResults(newScales);
  });

  /** When Summary data changes, recompute conditional formatting scales from current data. */
  createEffect(() => {
    const rows = summaryRows() as unknown as Record<string, unknown>[];
    const formatted = formattedColumnsSummary();
    if (formatted.length === 0 || rows.length === 0) return;
    const valueKeys = RACE_SUMMARY_TABLE_COLUMNS.filter((c) => c.key !== "source_name").map((c) => String(c.key));
    const newScales = recomputeScalesFromData(rows, formatted, valueKeys);
    if (Object.keys(newScales).length > 0) setColumnScalesSummary(newScales);
  });

  /** Races list for Results table: when "All" use API list (includes all races with race_stats e.g. 3-team); else use global races for index. */
  const racesForResultsTable = (): string[] => {
    if (selectedRace() !== "All") return races();
    const apiRaces = resultsRacesFromApi();
    return apiRaces.length > 0 ? apiRaces : races();
  };

  /** Indices of race columns to show (0-based). When All: [0,1,...]; when one race: [idx]. Backend columns are race1, race2, ... */
  const resultRaceIndices = (): number[] => {
    const r = selectedRace();
    if (r === "All") return racesForResultsTable().map((_, i) => i);
    const idx = races().indexOf(r);
    return idx >= 0 ? [idx] : [];
  };

  const resultsTableRows = (): RaceDayResultRow[] => resultsRows();

  /** Numeric keys for Results table (for conditional formatting scale). */
  const resultsValueKeys = (): string[] => {
    const idx = resultRaceIndices();
    const keys: string[] = ["position", ...idx.map((i) => `race${i + 1}`)];
    keys.push("average");
    keys.push("total");
    return keys;
  };



  const sortDataSummary = (key: string) => {
    const rows = summaryRows();
    const current = sortConfigSummary();
    const valueKeys = RACE_SUMMARY_TABLE_COLUMNS.filter((c) => c.key !== "source_name").map((c) => String(c.key));
    sortAndFormat(
      rows as unknown as Record<string, unknown>[],
      key,
      current,
      setSortConfigSummary,
      () => columnScalesSummary(),
      setColumnScalesSummary,
      () => formattedColumnsSummary(),
      setFormattedColumnsSummary,
      valueKeys
    );
  };

  const clearFormattingSummary = () => {
    setFormattedColumnsSummary([]);
    setColumnScalesSummary({});
    setSortConfigSummary({ key: "", direction: "asc" });
  };

  const sortedSummaryRows = createMemo(() => {
    const rows = summaryRows();
    const { key, direction } = sortConfigSummary();
    if (!key || rows.length === 0) return rows;
    const getVal = (row: RaceSummaryRow) => getRowValue(row as unknown as Record<string, unknown>, key);
    return [...rows].sort((a, b) => {
      const aV = getVal(a);
      const bV = getVal(b);
      if (aV == null && bV == null) return 0;
      if (aV == null) return 1;   /* nulls at bottom */
      if (bV == null) return -1; /* nulls at bottom */
      const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
      return direction === "asc" ? cmp : -cmp;
    });
  });

  const sortDataAvg = (key: string) => {
    const rows = averagesRows();
    const current = sortConfigAvg();
    const valueKeys = averagesTableColumns().map((c) => String(c.key));
    sortAndFormat(
      rows as unknown as Record<string, unknown>[],
      key,
      current,
      setSortConfigAvg,
      () => columnScalesAvg(),
      setColumnScalesAvg,
      () => formattedColumnsAvg(),
      setFormattedColumnsAvg,
      valueKeys
    );
  };

  const clearFormattingAvg = () => {
    setFormattedColumnsAvg([]);
    setColumnScalesAvg({});
    setSortConfigAvg({ key: "", direction: "asc" });
  };

  const sortedAveragesRows = createMemo(() => {
    const rows = averagesRows();
    const { key, direction } = sortConfigAvg();
    if (!key || rows.length === 0) return rows;
    const getVal = (row: RaceSetupRow) => getRowValue(row as unknown as Record<string, unknown>, key);
    return [...rows].sort((a, b) => {
      const aV = getVal(a);
      const bV = getVal(b);
      if (aV == null && bV == null) return 0;
      if (aV == null) return 1;   /* nulls at bottom */
      if (bV == null) return -1; /* nulls at bottom */
      const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
      return direction === "asc" ? cmp : -cmp;
    });
  });

  const formatNum = (v: number | null | undefined): string => {
    if (v == null || Number.isNaN(Number(v))) return "—";
    const n = Number(v);
    return n.toFixed(1);
  };

  /** Format delta from first row for display (e.g. +12.3, -5.6), 1 decimal. */
  const formatDelta = (delta: number): string => {
    if (Number.isNaN(delta)) return "";
    const n = Number(delta);
    const prefix = n > 0 ? "+" : "";
    return `${prefix}${n.toFixed(1)}`;
  };

  /** Format seconds as min:sec (e.g. 125 → "2:05"). */
  const formatDurationMinSec = (sec: number | null | undefined): string => {
    if (sec == null || Number.isNaN(Number(sec))) return "—";
    const s = Math.floor(Number(sec));
    const m = Math.floor(s / 60);
    const remainderSec = s % 60;
    return `${m}:${String(remainderSec).padStart(2, "0")}`;
  };

  /** Format delta in seconds with 's' suffix (e.g. +12s, -5s). */
  const formatDeltaDurationSec = (deltaSec: number): string => {
    if (Number.isNaN(deltaSec)) return "";
    const n = Math.round(Number(deltaSec));
    const prefix = n > 0 ? "+" : "";
    return `${prefix}${n}s`;
  };

  /** Copy race summary table to clipboard (values only, no deltas). */
  const copySummaryToClipboard = async () => {
    try {
      const rowsList = sortedSummaryRows();
      let clipboardText = RACE_SUMMARY_TABLE_COLUMNS.map((c) => c.header).join("\t") + "\n";
      for (const row of rowsList) {
        const cells = RACE_SUMMARY_TABLE_COLUMNS.map((col) => {
          if (col.key === "source_name") return row.source_name != null ? String(row.source_name) : "—";
          const val = getRowValue(row as unknown as Record<string, unknown>, String(col.key));
          if (val == null || Number.isNaN(Number(val))) return "—";
          return formatNum(Number(val));
        });
        clipboardText += cells.join("\t") + "\n";
      }
      log("RaceSummary: copy summary table to clipboard", { textLength: clipboardText.length });
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        setCopySuccessSummary(true);
        setTimeout(() => setCopySuccessSummary(false), 2000);
      } else {
        const ta = document.createElement("textarea");
        ta.value = clipboardText;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopySuccessSummary(true);
        setTimeout(() => setCopySuccessSummary(false), 2000);
      }
    } catch (err: unknown) {
      logError("RaceSummary: copy summary table failed", err);
    }
  };

  /** Copy averages table to clipboard (values only, no deltas). */
  const copyAveragesToClipboard = async () => {
    try {
      const rowsList = sortedAveragesRows();
      const cols = averagesTableColumns();
      const headers = ["TEAM", ...cols.map((c) => c.header)];
      let clipboardText = headers.join("\t") + "\n";
      for (const row of rowsList) {
        const teamCell = row.source_name != null ? String(row.source_name) : "—";
        const valueCells = cols.map((col) => {
          const val = row[col.key];
          if (val == null || Number.isNaN(Number(val))) return "—";
          return formatNum(Number(val));
        });
        clipboardText += [teamCell, ...valueCells].join("\t") + "\n";
      }
      log("RaceSummary: copy averages table to clipboard", { textLength: clipboardText.length });
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        setCopySuccessAverages(true);
        setTimeout(() => setCopySuccessAverages(false), 2000);
      } else {
        const ta = document.createElement("textarea");
        ta.value = clipboardText;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopySuccessAverages(true);
        setTimeout(() => setCopySuccessAverages(false), 2000);
      }
    } catch (err: unknown) {
      logError("RaceSummary: copy averages table failed", err);
    }
  };

  /** True if averages table has rows but every metric value is null/empty (backend returned no leg data). */
  const averagesTableEmptyMetrics = (): boolean => {
    const rows = averagesRows();
    if (rows.length === 0) return false;
    const keys = averagesTableColumns().map((c) => c.key);
    return rows.every((row) => keys.every((k) => row[k] == null || Number.isNaN(Number(row[k]))));
  };

  /** True when report should be hidden and "data not available" message shown. Only when there are no races for the date; once races exist we show the UI (tables may be empty or loading). */
  const hasNoData = createMemo(() => {
    if (loading() || error()) return false;
    const raceList = races();
    return raceList.length === 0;
  });

  return (
    <div id="media-container" class="race-summary-page">
      <div class="container relative">
        {/* Same scroll pattern as FleetPerformance: scroll container height set by setupMediaContainerScaling, scroll in inner */}
        <div class="performance-charts-scroll-container">
          <div class="performance-charts-scroll-inner" style={{ padding: "1.5rem", "box-sizing": "border-box" }}>
            <h1 class="report-page-title" style={{ "margin-bottom": "1.5rem", "font-size": "1.5rem", "font-weight": "700" }}>
              Race Summary
            </h1>

      <Show when={loading()} fallback={null}>
        <Loading />
      </Show>

      <Show when={!loading() && error()}>
        <div class="p-4 rounded-md" style={{ "background": "var(--color-bg-secondary)", "color": "var(--color-text-primary)" }}>
          {error()}
        </div>
      </Show>

      <Show when={hasNoData()}>
        <div class="report-no-data-container">
          <p class="report-no-data-message">Data is not available yet.</p>
        </div>
      </Show>

      <Show when={!loading() && !error() && !hasNoData()}>
        {/* Settings and race dropdown above race summary table */}
        <div class="race-summary-dropdown-section" style={{ "margin-bottom": "1.5rem" }}>
          <RaceSettings />
          <DropDownButton
            options={["All", ...races()]}
            defaultText={selectedRace()}
            smallLabel="Races"
            size="big"
            handleSelection={async (item) => {
              setSelectedRace(item);
              const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
              await logActivity(project_id, dataset_id, "RaceSummary.tsx", "Race Summary", `Race changed to ${item}`);
            }}
          />
        </div>

        {/* Race summary section: getRaceSummary_TableData with race=0 when All, or specific race when selected */}
        <section style={{ "margin-bottom": "1.5rem" }}>
          <div
            class="copy-table-hover-wrapper"
            onMouseEnter={() => setIsHoveredSummary(true)}
            onMouseLeave={() => setIsHoveredSummary(false)}
          >
          <Show
            when={!summaryLoading()}
            fallback={
              <div class="race-summary-loading-state">
                <p class="race-summary-loading-label">Loading...</p>
              </div>
            }
          >
            <div class="data-table-container">
              <div class="scrollable-container">
                {(() => {
                  const scalesSummary = columnScalesSummary();
                  const formattedSummary = formattedColumnsSummary();
                  const summaryRowsList = sortedSummaryRows();
                  const firstSummaryRow = summaryRowsList.length > 0 ? summaryRowsList[0] : null;
                  const deltasEnabled = showDeltasResults();
                  return (
                    <table class="maneuvers-table">
                      <thead>
                        <tr>
                          <For each={RACE_SUMMARY_TABLE_COLUMNS}>
                            {(col) => {
                              const isAllRaces = selectedRace() === "All";
                              const showAvgLabel = isAllRaces && col.key !== "max_speed" && col.key !== "source_name";
                              return (
                                <th
                                  class="centered"
                                  style={{ cursor: "pointer" }}
                                  onClick={() => sortDataSummary(String(col.key))}
                                  title={`Sort by ${col.header}`}
                                >
                                  {showAvgLabel ? "AVG " : ""}{col.header} {sortConfigSummary().key === String(col.key) ? (sortConfigSummary().direction === "asc" ? "▲" : "▼") : ""}
                                </th>
                              );
                            }}
                          </For>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={summaryRowsList}>
                          {(row, index) => {
                            const rowIndex = index();
                            const showDelta = deltasEnabled && firstSummaryRow != null && rowIndex > 0;
                            const deltaClass = (d: number) =>
                              d > 0 ? "race-summary-delta race-summary-delta-positive" : d < 0 ? "race-summary-delta race-summary-delta-negative" : "race-summary-delta";
                            return (
                              <tr>
                                <For each={RACE_SUMMARY_TABLE_COLUMNS}>
                                  {(col) => {
                                    const keyStr = String(col.key);
                                    const scaleClass = cellClassForScale(
                                      row as unknown as Record<string, unknown>,
                                      keyStr,
                                      scalesSummary,
                                      formattedSummary
                                    );
                                    if (col.key === "source_name") {
                                      return (
                                        <td
                                          class={`centered ${scaleClass} team-cell`}
                                          style={getTeamCellStyle(row.source_name)}
                                        >
                                          {row.source_name ?? "—"}
                                        </td>
                                      );
                                    }
                                    const val = getRowValue(row as unknown as Record<string, unknown>, keyStr) as number | null | undefined;
                                    const firstVal = firstSummaryRow ? (getRowValue(firstSummaryRow as unknown as Record<string, unknown>, keyStr) as number | null | undefined) : null;
                                    const delta =
                                      showDelta &&
                                      val != null &&
                                      firstVal != null &&
                                      !Number.isNaN(Number(val)) &&
                                      !Number.isNaN(Number(firstVal))
                                        ? Number(val) - Number(firstVal)
                                        : null;
                                    const displayText = val != null ? formatNum(Number(val)) : "—";
                                    const deltaText = delta != null ? formatDelta(delta) : null;
                                    return (
                                      <td class={`centered ${scaleClass}`}>
                                        {displayText}
                                        {deltaText != null && (
                                          <span class={deltaClass(delta!)}>{deltaText}</span>
                                        )}
                                      </td>
                                    );
                                  }}
                                </For>
                              </tr>
                            );
                          }}
                        </For>
                        <Show when={summaryRows().length === 0}>
                          <tr>
                            <td colSpan={RACE_SUMMARY_TABLE_COLUMNS.length} class="centered" style={{ padding: "1rem", color: "var(--color-text-secondary)" }}>
                              {selectedRace() === "All"
                                ? "No race-summary data for this date (all races). Ensure data/race-summary has data (race=0)."
                                : "No race-summary data for this race. Ensure data/race-summary has data for the selected race."}
                            </td>
                          </tr>
                        </Show>
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          </Show>
          {showCopySummary() && !summaryLoading() && (
            <div class="copy-table-data-actions">
              <button
                type="button"
                class="copy-table-data-btn"
                classList={{ "copy-table-data-btn-success": copySuccessSummary() }}
                onClick={copySummaryToClipboard}
              >
                {copySuccessSummary() ? "✓ Copied!" : "Copy Table Data"}
              </button>
            </div>
          )}
          <div class="flex justify-between items-center mt-2 race-summary-table-actions" style={{ "margin-bottom": "1.5rem" }}>
            <div class="race-summary-actions-left">
              <label class="race-summary-deltas-checkbox">
                <input
                  type="checkbox"
                  checked={showDeltasResults()}
                  onChange={async (e) => {
                    const checked = e.currentTarget.checked;
                    setShowDeltasResults(checked);
                    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                    await logActivity(project_id, dataset_id, "RaceSummary.tsx", "Race Summary", `Show deltas (Results) ${checked ? "on" : "off"}`);
                  }}
                />
                <span>Show deltas</span>
              </label>
            </div>
            <div class="flex justify-end" style={{ "margin-left": "auto" }}>
              <button class="btn" type="button" onClick={clearFormattingSummary}>
                Clear Formatting
              </button>
            </div>
          </div>
          </div>
        </section>

        {/* Averages section */}
        <section style={{ "margin-bottom": "1rem" }}>
          <div class="race-summary-dropdown-section" style={{ "margin-bottom": "0.75rem" }}>
            <DropDownButton
              options={["PHASES", "BEST MODES", "DISPLACEMENT"]}
              defaultText={dataMode() === "phases" ? "PHASES" : dataMode() === "best_modes" ? "BEST MODES" : "DISPLACEMENT"}
              smallLabel="Data mode"
              size="big"
              handleSelection={async (item) => {
                const mode = item === "PHASES" ? "phases" : item === "BEST MODES" ? "best_modes" : "displacement";
                setDataMode(mode);
                const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                await logActivity(project_id, dataset_id, "RaceSummary.tsx", "Race Summary", `Data mode (Setups) changed to ${item}`);
              }}
            />
            <DropDownButton
              options={["REACH", "UPWIND", "DOWNWIND"]}
              defaultText={legType() === "reaching" ? "REACH" : legType() === "upwind" ? "UPWIND" : "DOWNWIND"}
              smallLabel="Point of Sail"
              size="big"
              handleSelection={async (item) => {
                const leg = item === "REACH" ? "reaching" : item === "UPWIND" ? "upwind" : "downwind";
                setLegType(leg);
                const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                await logActivity(project_id, dataset_id, "RaceSummary.tsx", "Race Summary", `Point of sail changed to ${item}`);
              }}
            />
          </div>
          <h2 class="report-section-heading" style={{ "font-size": "1rem", "font-weight": "600", "margin-bottom": "0.5rem" }}>
            {selectedRace() === "All"
              ? dataMode() === "phases"
                ? "Average Setup (phase averages):"
                : `Average Setup (BIN 10, ${dataMode() === "best_modes" ? "best modes" : "displacement"}):`
              : dataMode() === "phases"
                ? `Race ${selectedRace()} Setup (phase averages):`
                : `Race ${selectedRace()} Setup (BIN 10, ${dataMode() === "best_modes" ? "best modes" : "displacement"}):`}
          </h2>
          <div
            class="copy-table-hover-wrapper"
            onMouseEnter={() => setIsHoveredAverages(true)}
            onMouseLeave={() => setIsHoveredAverages(false)}
          >
          <div class="data-table-container" style={{ "overflow-x": "auto" }}>
            <Show
              when={averagesRows().length > 0}
              fallback={
                <p class="race-summary-empty-message">
                  No phase-averages data for this date and leg type. Check that race-setup data exists for the selected REACH / UPWIND / DOWNWIND.
                </p>
              }
            >
              <div class="scrollable-container">
                {/* Read signals in outer scope so formatting updates trigger re-render */}
                {(() => {
                  const scalesAvg = columnScalesAvg();
                  const formattedAvg = formattedColumnsAvg();
                  const avgRowsList = sortedAveragesRows();
                  const firstAvgRow = avgRowsList.length > 0 ? avgRowsList[0] : null;
                  const deltasAvgEnabled = showDeltasAverages();
                  const deltaAvgClass = (d: number) =>
                    d > 0 ? "race-summary-delta race-summary-delta-positive" : d < 0 ? "race-summary-delta race-summary-delta-negative" : "race-summary-delta";
                  return (
                <table class="maneuvers-table">
                  <thead>
                    <tr>
                      <th
                        class="centered"
                        style={{ cursor: "pointer" }}
                        onClick={() => sortDataAvg("source_name")}
                        title="Sort by team"
                      >
                        TEAM {sortConfigAvg().key === "source_name" ? (sortConfigAvg().direction === "asc" ? "▲" : "▼") : ""}
                      </th>
                      <For each={averagesTableColumns()}>
                        {(col) => (
                          <th
                            class="centered"
                            style={{ cursor: "pointer" }}
                            onClick={() => sortDataAvg(String(col.key))}
                            title={`Sort by ${col.header}`}
                          >
                            {col.header} {sortConfigAvg().key === String(col.key) ? (sortConfigAvg().direction === "asc" ? "▲" : "▼") : ""}
                          </th>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={avgRowsList}>
                      {(row, index) => {
                        const rowIndex = index();
                        const showDeltaAvg = deltasAvgEnabled && firstAvgRow != null && rowIndex > 0;
                        return (
                        <tr>
                          <td class="centered team-cell" style={getTeamCellStyle(row.source_name)}>
                            {row.source_name ?? "—"}
                          </td>
                          <For each={averagesTableColumns()}>
                            {(col) => {
                              const keyStr = String(col.key);
                              const scaleClass = cellClassForScale(
                                row as unknown as Record<string, unknown>,
                                keyStr,
                                scalesAvg,
                                formattedAvg
                              );
                              const val = row[col.key] as number | null | undefined;
                              const firstVal = firstAvgRow ? (firstAvgRow[col.key] as number | null | undefined) : null;
                              const deltaAvg =
                                showDeltaAvg &&
                                val != null &&
                                firstVal != null &&
                                !Number.isNaN(Number(val)) &&
                                !Number.isNaN(Number(firstVal))
                                  ? Number(val) - Number(firstVal)
                                  : null;
                              return (
                                <td class={`centered ${scaleClass}`}>
                                  {val != null ? formatNum(val) : "—"}
                                  {deltaAvg != null && (
                                    <span class={deltaAvgClass(deltaAvg)}>{formatDelta(deltaAvg)}</span>
                                  )}
                                </td>
                              );
                            }}
                          </For>
                        </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
                  );
                })()}
              </div>
            </Show>
          </div>
          {showCopyAverages() && averagesRows().length > 0 && (
            <div class="copy-table-data-actions">
              <button
                type="button"
                class="copy-table-data-btn"
                classList={{ "copy-table-data-btn-success": copySuccessAverages() }}
                onClick={copyAveragesToClipboard}
              >
                {copySuccessAverages() ? "✓ Copied!" : "Copy Table Data"}
              </button>
            </div>
          )}
          <Show when={averagesRows().length > 0}>
            <div class="flex justify-between items-center mt-2 race-summary-table-actions" style={{ "margin-bottom": "1.5rem" }}>
              <label class="race-summary-deltas-checkbox">
                <input
                  type="checkbox"
                  checked={showDeltasAverages()}
                  onChange={async (e) => {
                    const checked = e.currentTarget.checked;
                    setShowDeltasAverages(checked);
                    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                    await logActivity(project_id, dataset_id, "RaceSummary.tsx", "Race Summary", `Show deltas (Averages) ${checked ? "on" : "off"}`);
                  }}
                />
                <span>Show deltas</span>
              </label>
              <button class="btn" type="button" onClick={clearFormattingAvg}>
                Clear Formatting
              </button>
            </div>
          </Show>
          </div>
          {averagesRows().length > 0 && averagesTableEmptyMetrics() && (
            <p style={{ "color": "var(--color-text-secondary)", "font-size": "0.875rem", "margin-top": "0.5rem" }}>
              No metric values for this leg type — ensure <code>race_stats</code> has data for the selected date/race and REACH / UPWIND / DOWNWIND.
            </p>
          )}
        </section>
      </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
