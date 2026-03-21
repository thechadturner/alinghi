import { createSignal, createEffect, createMemo, Show, For, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import * as d3 from "d3";
import DropDownButton from "../../../../components/buttons/DropDownButton";
import LoadingOverlay from "../../../../components/utilities/Loading";
import RaceSettings from "../../../../components/menus/RaceSettings";
import PrestartReportMap, { type PrestartMark } from "../../../../components/maneuvers/prestart/PrestartReportMap";
import PrestartChart from "../../../../components/maneuvers/prestart/PrestartChart";
import { getData, getTimezoneForDate, setupMediaContainerScaling } from "../../../../utils/global";
import { persistantStore } from "../../../../store/persistantStore";
import { setSelectedGroupKeys } from "../../../../store/selectionStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { tooltip } from "../../../../store/globalStore";
import { apiEndpoints } from "@config/env";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../utils/logging";
import { log, debug as logDebug, error as logError } from "../../../../utils/console";
import { selectedSources as filterStoreSelectedSources } from "../../../../store/filterStore";

/** Source name cell color = default source color from sourcesStore (same as Race Summary TEAM cell). */
function getSourceColor(sourceName: string | null | undefined): string | undefined {
  if (sourceName == null || String(sourceName).trim() === "") return undefined;
  const color = sourcesStore.getSourceColor(String(sourceName));
  return color ?? undefined;
}

const { selectedClassName, selectedProjectId, selectedDate } = persistantStore;

const VIEW_OPTIONS = ["PRESTART", "ACCELERATION", "MAX BSP", "REACH", "LEG 1"] as const;
/** Map/timeseries desc index: PRESTART=0; max accel, max bsp and reach use index 1 (pre-start through reach); leg 1 only uses index 2. */
const VIEW_INDEX_MAP = { PRESTART: 0, ACCELERATION: 1, "MAX BSP": 1, REACH: 1, "LEG 1": 2 } as const;

/** Timeseries chart keys per desc, matching prestart.py addTimeSeriesData (Basics vs Details). */
const PRESTART_TIMESERIES_CHARTS: Record<string, string[]> = {
  "0_Basics": ["ttk_s", "bsp_kph", "polar_perc", "twa_n_deg", "accel_rate_mps2", "heel_n_deg", "rh_lwd_mm"],
  "1_Details": [
    "bsp_kph",
    "polar_perc",
    "twa_n_deg",
    "accel_rate_mps2",
    "heel_n_deg",
    "pitch_deg",
    "rh_lwd_mm",
    "rud_rake_ang_deg",
    "rud_diff_ang_deg",
    "db_rake_lwd_deg",
    "db_cant_lwd_deg",
    "db_cant_eff_lwd_deg",
    "wing_camber1_n_deg",
    "wing_total_twist_deg",
    "wing_clew_position_mm",
    "jib_sheet_load_kgf",
    "jib_cunno_load_kgf",
    "jib_lead_ang_deg",
  ],
  "2_Details": [
    "bsp_kph",
    "polar_perc",
    "twa_n_deg",
    "accel_rate_mps2",
    "heel_n_deg",
    "pitch_deg",
    "rh_lwd_mm",
    "rud_rake_ang_deg",
    "rud_diff_ang_deg",
    "db_rake_lwd_deg",
    "db_cant_lwd_deg",
    "db_cant_eff_lwd_deg",
    "wing_camber1_n_deg",
    "wing_total_twist_deg",
    "wing_clew_position_mm",
    "jib_sheet_load_kgf",
    "jib_cunno_load_kgf",
    "jib_lead_ang_deg",
  ],
};

/** Table API view param: prestart | acceleration | maxbsp | reach | leg1. */
function getTableViewKey(view: (typeof VIEW_OPTIONS)[number]): string {
  const v = String(view ?? "").trim();
  if (v === "PRESTART") return "prestart";
  if (v === "ACCELERATION") return "acceleration";
  if (v === "MAX BSP") return "maxbsp";
  if (v === "REACH") return "reach";
  if (v === "LEG 1") return "leg1";
  return "prestart";
}

/** Label shown below the table describing how rows are ranked for the current view. */
function getRankingLabel(view: (typeof VIEW_OPTIONS)[number]): string {
  const v = String(view ?? "").trim();
  if (v === "PRESTART") return "* Ranked by distance sailed to mark 1 in first 10 seconds";
  if (v === "REACH") return "* Rankings determined by distance sailed in first 25 seconds.";
  if (v === "LEG 1") return "* Rankings determined by position after 35 seconds from the start.";
  if (v === "ACCELERATION") return "* Ranked by max acceleration";
  if (v === "MAX BSP") return "* Ranked by max boat speed.";
  return "* Ranked by time to cross line perpendicular to course axis following mark 1";
}

/** Column name for team/source in table rows; API may return TEAM or source_name (casing can vary by driver). */
const TEAM_COLUMN_NAMES = ["TEAM", "source_name"] as const;

/** Get value from row by column key; tries exact key then case-insensitive match so API/driver casing (e.g. Twa_start vs twa_start) does not leave cells empty. */
function getRowValueByKey(row: Record<string, unknown>, col: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, col)) return row[col];
  const lower = col.toLowerCase();
  const key = Object.keys(row).find((k) => k.toLowerCase() === lower);
  return key != null ? row[key] : undefined;
}

/** Get team/source name from a table row (accept TEAM or source_name, any casing). */
function getTeamFromRow(row: Record<string, unknown>): string {
  for (const key of TEAM_COLUMN_NAMES) {
    const v = getRowValueByKey(row, key);
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/** Get the ranking column key for a given view. */
function getRankingColumnKey(view: (typeof VIEW_OPTIONS)[number]): string {
  const v = String(view ?? "").trim();
  if (v === "PRESTART") return "Prestart_dist";
  if (v === "ACCELERATION") return "Accel_max";
  if (v === "MAX BSP") return "Bsp_max";
  if (v === "REACH") return "Reach_dist";
  if (v === "LEG 1") return "Leg1_dist";
  return "Prestart_dist";
}

/** Determine if ranking should be ascending (true for position/time-based, false for performance-based). */
function isRankingAscending(view: (typeof VIEW_OPTIONS)[number]): boolean {
  const v = String(view ?? "").trim();
  // REACH and LEG 1: higher distance is better (rank descending)
  if (v === "REACH" || v === "LEG 1") return false;
  // Performance-based views: higher is better (descending)
  return false;
}

/** Recalculate RANK column for filtered rows based on the current view. */
function recalculateRankings(rows: Record<string, unknown>[], currentView: (typeof VIEW_OPTIONS)[number]): Record<string, unknown>[] {
  if (rows.length === 0) return rows;

  const rankingColumn = getRankingColumnKey(currentView);
  const ascending = isRankingAscending(currentView);

  // Sort rows by the ranking column
  const sorted = [...rows].sort((a, b) => {
    const aVal = getRowValueByKey(a, rankingColumn);
    const bVal = getRowValueByKey(b, rankingColumn);
    let aNum = typeof aVal === "number" ? aVal : Number(aVal);
    let bNum = typeof bVal === "number" ? bVal : Number(bVal);
    // Treat -999 (sentinel for no data) as sort last
    if (aNum === -999) aNum = ascending ? Infinity : -Infinity;
    if (bNum === -999) bNum = ascending ? Infinity : -Infinity;

    // Handle null/NaN values (put them at the end)
    if (!Number.isFinite(aNum) && !Number.isFinite(bNum)) return 0;
    if (!Number.isFinite(aNum)) return 1;
    if (!Number.isFinite(bNum)) return -1;

    return ascending ? aNum - bNum : bNum - aNum;
  });

  // Assign new ranks (1-based)
  sorted.forEach((row, index) => {
    // Find the RANK key (case-insensitive)
    const rankKey = Object.keys(row).find((k) => k.toUpperCase() === "RANK") || "RANK";
    row[rankKey] = index + 1;
  });

  return sorted;
}

/** Mark names to show on prestart map (SL1, SL2, MK1, M1). */
const PRESTART_MARK_NAMES = ["SL1", "SL2", "MK1", "M1"] as const;

/** Per-mode table config: column order, header names, and tooltips. Keys match API column names (case-insensitive match used). */
type ViewTableConfig = { columnOrder: string[]; columns: Record<string, { header: string; tooltip: string }> };

const PRESTART_TABLE_CONFIG: Record<string, ViewTableConfig> = {
  prestart: {
    columnOrder: [
      "RANK",
      "TEAM",
      "Prestart_dist",
      "Bsp_start",
      "Twa_start",
      "DTL_start",
      "LINE_PERC_start",
      "RATIO_turnback",
      "TTK_turnback",
      "TTK_burn",
      "Bsp_avg_pre",
      "Time_turnback",
      "DTL_turnback",
    ],
    columns: {
      RANK: { header: "Rank", tooltip: "Position ranked by distance sailed to mark 1 in first 10 seconds" },
      TEAM: { header: "Team", tooltip: "Boat / source name" },
      Prestart_dist: { header: "Distance [M]", tooltip: "Distance sailed toward mark 1 in first 10 seconds of race after crossing start line." },
      Bsp_start: { header: "BSP start", tooltip: "Boat speed (kts) at start" },
      Twa_start: { header: "TWA start", tooltip: "True wind angle (deg) at start" },
      DTL_start: { header: "DTL start", tooltip: "Distance to line (m) at start" },
      LINE_PERC_start: { header: "Line % start", tooltip: "Line percentage at start" },
      RATIO_turnback: { header: "Ratio turnback", tooltip: "Start ratio at turnback" },
      TTK_turnback: { header: "TTK turnback", tooltip: "Time to kill (s) at turnback" },
      TTK_burn: { header: "TTK burn", tooltip: "Time to kill (s) at burn / BSP min" },
      Bsp_avg_pre: { header: "BSP avg pre", tooltip: "Average boat speed (kts) before turnback" },
      Time_turnback: { header: "Time turnback", tooltip: "Time (s) at turnback" },
      DTL_turnback: { header: "DTL turnback", tooltip: "Distance to line (m) at turnback" },
    },
  },
  acceleration: {
    columnOrder: [
      "RANK",
      "TEAM",
      "Time_accmax",
      "Accel_max",
      "Bsp_accmax",
      "Twa_accmax",
      "Heel_accmax",
      "RH_lwd_accmax",
      "Cant_accmax",
      "Jib_sheet_load_accmax",
      "Jib_cunno_load_accmax",
      "Jib_lead_ang_accmax",
      "Wing_clew_pos_accmax",
      "Wing_twist_accmax",
      "CA1_accmax",
    ],
    columns: {
      RANK: { header: "Rank", tooltip: "Position ranked by max acceleration" },
      TEAM: { header: "Team", tooltip: "Boat / source name" },
      Time_accmax: { header: "Time at acc max", tooltip: "Time (s) when acceleration was maximum" },
      Accel_max: { header: "Accel max", tooltip: "Maximum acceleration (m/s²)" },
      Bsp_accmax: { header: "BSP at acc max", tooltip: "Boat speed (kts) at max acceleration" },
      Twa_accmax: { header: "TWA at acc max", tooltip: "True wind angle (deg) at max acceleration" },
      Heel_accmax: { header: "Heel at acc max", tooltip: "Heel angle (deg) at max acceleration" },
      RH_lwd_accmax: { header: "RH lwd at acc max", tooltip: "Rudder height (mm) at max acceleration" },
      Cant_accmax: { header: "Cant at acc max", tooltip: "Cant angle (deg) at max acceleration" },
      Jib_sheet_load_accmax: { header: "Jib sheet at acc max", tooltip: "Jib sheet load (kgf) at max acceleration" },
      Jib_cunno_load_accmax: { header: "Jib cunno at acc max", tooltip: "Jib cunningham load (kgf) at max acceleration" },
      Jib_lead_ang_accmax: { header: "Jib lead ang at acc max", tooltip: "Jib lead angle (deg) at max acceleration" },
      Wing_clew_pos_accmax: { header: "Wing clew at acc max", tooltip: "Wing clew position (mm) at max acceleration" },
      Wing_twist_accmax: { header: "Wing twist at acc max", tooltip: "Wing twist (deg) at max acceleration" },
      CA1_accmax: { header: "CA1 at acc max", tooltip: "CA1 angle (deg) at max acceleration" },
    },
  },
  maxbsp: {
    columnOrder: [
      "RANK",
      "TEAM",
      "Time_bspmax",
      "Bsp_max",
      "Twa_bspmax",
      "Heel_bspmax",
      "RH_lwd_bspmax",
      "Cant_bspmax",
      "Jib_sheet_load_bspmax",
      "Jib_cunno_load_bspmax",
      "Jib_lead_ang_bspmax",
      "Wing_clew_pos_bspmax",
      "Wing_twist_bspmax",
      "CA1_bspmax",
    ],
    columns: {
      RANK: { header: "Rank", tooltip: "Position ranked by max boat speed" },
      TEAM: { header: "Team", tooltip: "Boat / source name" },
      Time_bspmax: { header: "Time at BSP max", tooltip: "Time (s) when boat speed was maximum" },
      Bsp_max: { header: "BSP max", tooltip: "Maximum boat speed (kts)" },
      Twa_bspmax: { header: "TWA at BSP max", tooltip: "True wind angle (deg) at max boat speed" },
      Heel_bspmax: { header: "Heel at BSP max", tooltip: "Heel angle (deg) at max boat speed" },
      RH_lwd_bspmax: { header: "RH lwd at BSP max", tooltip: "Rudder height (mm) at max boat speed" },
      Cant_bspmax: { header: "Cant at BSP max", tooltip: "Cant angle (deg) at max boat speed" },
      Jib_sheet_load_bspmax: { header: "Jib sheet at BSP max", tooltip: "Jib sheet load (kgf) at max boat speed" },
      Jib_cunno_load_bspmax: { header: "Jib cunno at BSP max", tooltip: "Jib cunningham load (kgf) at max boat speed" },
      Jib_lead_ang_bspmax: { header: "Jib lead ang at BSP max", tooltip: "Jib lead angle (deg) at max boat speed" },
      Wing_clew_pos_bspmax: { header: "Wing clew at BSP max", tooltip: "Wing clew position (mm) at max boat speed" },
      Wing_twist_bspmax: { header: "Wing twist at BSP max", tooltip: "Wing twist (deg) at max boat speed" },
      CA1_bspmax: { header: "CA1 at BSP max", tooltip: "CA1 angle (deg) at max boat speed" },
    },
  },
  reach: {
    columnOrder: [
      "RANK",
      "TEAM",
      "Reach_dist",
      "Bsp_avg_reach",
      "TTK_turnback",
      "RATIO_turnback",
      "DTL_start",
      "LINE_PERC_start",
      "Bsp_start",
      "Twa_start",
      "Accel_max",
      "Bsp_max",
    ],
    columns: {
      RANK: { header: "Rank", tooltip: "Position ranked by reach distance (max distance = 1)" },
      TEAM: { header: "Team", tooltip: "Boat / source name" },
      Reach_dist: { header: "Reach dist [m]", tooltip: "Distance (m) sailed to reach the mark" },
      Bsp_avg_reach: { header: "BSP avg reach", tooltip: "Average boat speed (kts) over the reach leg" },
      TTK_turnback: { header: "TTK turnback", tooltip: "Time to kill (s) at turnback" },
      RATIO_turnback: { header: "Ratio turnback", tooltip: "Start ratio at turnback" },
      DTL_start: { header: "DTL start", tooltip: "Distance to line (m) at start" },
      LINE_PERC_start: { header: "Line % start", tooltip: "Line percentage at start" },
      Bsp_start: { header: "BSP start", tooltip: "Boat speed (kts) at start" },
      Twa_start: { header: "TWA start", tooltip: "True wind angle (deg) at start" },
      Accel_max: { header: "Accel max", tooltip: "Maximum acceleration (m/s²)" },
      Bsp_max: { header: "BSP max", tooltip: "Maximum boat speed (kts)" },
    },
  },
  leg1: {
    columnOrder: [
      "RANK",
      "TEAM",
      "Leg1_dist",
      "TTK_turnback",
      "RATIO_turnback",
      "DTL_start",
      "LINE_PERC_start",
      "Bsp_start",
      "Twa_start",
      "Accel_max",
      "Bsp_max",
    ],
    columns: {
      RANK: { header: "Rank", tooltip: "Position by leg1 distance (max distance = 1)" },
      TEAM: { header: "Team", tooltip: "Boat / source name" },
      Leg1_dist: { header: "Leg1 dist [m]", tooltip: "Distance (m) sailed on leg 1 (ranking metric)" },
      TTK_turnback: { header: "TTK turnback", tooltip: "Time to kill (s) at turnback" },
      RATIO_turnback: { header: "Ratio turnback", tooltip: "Start ratio at turnback" },
      DTL_start: { header: "DTL start", tooltip: "Distance to line (m) at start" },
      LINE_PERC_start: { header: "Line % start", tooltip: "Line percentage at start" },
      Bsp_start: { header: "BSP start", tooltip: "Boat speed (kts) at start" },
      Twa_start: { header: "TWA start", tooltip: "True wind angle (deg) at start" },
      Accel_max: { header: "Accel max", tooltip: "Maximum acceleration (m/s²)" },
      Bsp_max: { header: "BSP max", tooltip: "Maximum boat speed (kts)" },
    },
  },
};

/** Resolve actual column key from row (case-insensitive). */
function resolveColumnKey(rowKeys: string[], configKey: string): string | null {
  const lower = configKey.toLowerCase();
  return rowKeys.find((k) => k.toLowerCase() === lower) ?? null;
}

/** Get header name and tooltip for a column key in the given view. Falls back to key with underscores replaced by spaces. */
function getColumnDisplay(
  viewKey: string,
  colKey: string
): { header: string; tooltip: string } {
  const config = PRESTART_TABLE_CONFIG[viewKey];
  if (config?.columns) {
    const lower = colKey.toLowerCase();
    const entry = Object.entries(config.columns).find(([k]) => k.toLowerCase() === lower);
    if (entry) return entry[1];
  }
  return { header: colKey.replace(/_/g, " "), tooltip: colKey.replace(/_/g, " ") };
}

function dateNorm(): string {
  const d = selectedDate();
  if (!d || typeof d !== "string") return "";
  return String(d).replace(/[-/]/g, "");
}

/** Format date for marks/markwind API (YYYY-MM-DD). Matches RaceCourseLayer formatDateForAPI. */
function formatDateForMarksApi(dateNorm: string): string {
  if (!dateNorm || dateNorm.length !== 8) return dateNorm;
  return `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`;
}

export default function PrestartPage() {
  const [loading, setLoading] = createSignal(false);
  const [races, setRaces] = createSignal<string[]>([]);
  const [selectedRace, setSelectedRace] = createSignal<string>("");
  const [view, setView] = createSignal<typeof VIEW_OPTIONS[number]>("PRESTART");
  const [tableRows, setTableRows] = createSignal<Record<string, unknown>[]>([]);
  const [tableColumns, setTableColumns] = createSignal<string[]>([]);
  const [sortConfig, setSortConfig] = createSignal<{ key: string; direction: "asc" | "desc" }>({ key: "", direction: "asc" });
  const [columnScales, setColumnScales] = createSignal<Record<string, string>>({});
  const [formattedColumns, setFormattedColumns] = createSignal<string[]>([]);
  const [isHoveredTable, setIsHoveredTable] = createSignal(false);
  const [copySuccess, setCopySuccess] = createSignal(false);
  const [mapData, setMapData] = createSignal<{ event_id: number; source_name: string; points: { lat: number; lng: number; time?: number; hdg?: number; note?: string }[]; marks?: PrestartMark[] }[]>([]);
  /** All mark sets for the day: array of { datetime (ISO), marks } from markwind/marks object. */
  const [marksByTime, setMarksByTime] = createSignal<{ datetime: string; marks: PrestartMark[] }[]>([]);
  const [tsData, setTsData] = createSignal<{ event_id: number; source_name: string; charts: string[]; values: Record<string, number>[] }[]>([]);
  /** Course axis for map when table view doesn't return it; fetched from courseaxis view. */
  const [courseAxisFromApi, setCourseAxisFromApi] = createSignal<number | undefined>(undefined);
  /** Selected time (sec, race-relative) from timeseries click; drives red line, value labels, and map trim. Local to prestart page only. */
  const [selectedTimeSec, setSelectedTimeSec] = createSignal<number | null>(null);

  const viewIndex = () => VIEW_INDEX_MAP[view()];
  /**
   * Map data trim:
   * - PRESTART: untrimmed.
   * - REACH, ACCELERATION, MAX BSP, LEG 1: same as average leg 1 — 60 seconds, extended if needed so max BSP / max accel markers are visible.
   */
  const mapDataForView = createMemo(() => {
    const tracks = mapData();
    const currentView = view();
    if (currentView === "PRESTART") return tracks;
    // REACH, ACCELERATION, MAX BSP, LEG 1 all use leg1 map and same time range (average leg 1)
    const leg1Views = ["REACH", "ACCELERATION", "MAX BSP", "LEG 1"];
    const trimTime = leg1Views.includes(currentView) ? 60 : Infinity;
    if (!Number.isFinite(trimTime) || tracks.length === 0) return tracks;
    let finalTrim = trimTime;
    // Extend trim so map data includes points with note 'max bsp' / 'max accel' for star + golden boat markers
    const markerTimes = tracks.flatMap((track) =>
      track.points
        .filter((p) => (p.note === "max bsp" || p.note === "max accel") && typeof p.time === "number" && Number.isFinite(p.time))
        .map((p) => p.time as number)
    );
    finalTrim = markerTimes.length > 0 ? Math.max(trimTime, ...markerTimes) : trimTime;
    return tracks.map((track) => ({
      ...track,
      points: track.points.filter((p) => p.time == null || p.time <= finalTrim),
    }));
  });
  /** Timeseries data: PRESTART untrimmed; REACH, ACCELERATION, MAX BSP, LEG 1 use same time range as average leg 1 (60s). */
  const tsDataForView = createMemo(() => {
    const data = tsData();
    const currentView = view();
    if (currentView === "PRESTART") return data;
    const leg1Views = ["REACH", "ACCELERATION", "MAX BSP", "LEG 1"];
    const minTime = leg1Views.includes(currentView) ? 60 : Infinity;
    if (!Number.isFinite(minTime) || data.length === 0) return data;
    return data.map((row) => ({
      ...row,
      values: (row.values || []).filter((v) => {
        const t = (v as Record<string, unknown>).time;
        const time = typeof t === "number" && Number.isFinite(t) ? t : null;
        return time == null || time <= minTime;
      }),
    }));
  });
  const eventIds = createMemo(() =>
    tableRows()
      .map((r) => (r.event_id != null ? Number(r.event_id) : null))
      .filter((id): id is number => id != null && !Number.isNaN(id))
  );
  /** Source-of-truth for prestart selection (source_name). Synced to selectionStore as selectedGroupKeys. */
  const [selectedSourceNamesSignal, setSelectedSourceNamesSignal] = createSignal<string[]>([]);
  const selectedSourceNames = () => selectedSourceNamesSignal();

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
      logError('Prestart: Error getting selected source names', err);
      return null;
    }
  };

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
      if (!result?.success || !Array.isArray(result.data)) {
        setRaces([]);
        return;
      }
      const raceKeys = (result.data as { Race_number?: number }[])
        .map((r) => (r?.Race_number != null ? String(r.Race_number) : null))
        .filter((k): k is string => k != null && k !== "" && k !== "-1");
      setRaces(raceKeys);
      if (raceKeys.length > 0 && !selectedRace()) setSelectedRace(raceKeys[0]);
    } catch (err) {
      logError("Prestart: fetch races failed", err);
      setRaces([]);
    }
  };

  const fetchTable = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = dateNorm();
    const race = selectedRace();
    if (!className || !projectId || date.length !== 8 || !race) {
      setTableRows([]);
      setTableColumns([]);
      setCourseAxisFromApi(undefined);
      return;
    }
    setCourseAxisFromApi(undefined);
    try {
      const url = `${apiEndpoints.app.data}/prestart-summary?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}&race=${encodeURIComponent(race)}&view=${getTableViewKey(view())}`;
      const result = await getData(url);
      if (!result?.success || !result?.data?.rows) {
        setTableRows([]);
        setTableColumns([]);
        setSelectedSourceNamesSignal([]);
        setCourseAxisFromApi(undefined);
        return;
      }
      let rows = result.data.rows as Record<string, unknown>[];

      // Filter rows by global source selection from filterStore (same as FleetMap)
      const selectedSourceNames = getSelectedSourceNames();
      if (selectedSourceNames) {
        rows = rows.filter((row) => {
          const sourceName = getTeamFromRow(row as Record<string, unknown>);
          return sourceName && selectedSourceNames.has(sourceName.toLowerCase().trim());
        });
      }

      // Recalculate rankings after filtering
      rows = recalculateRankings(rows, view());

      setTableRows(rows);
      if (rows.length > 0) {
        const raw = Object.keys(rows[0]).filter((k) => k !== "event_id" && k !== "Course_axis" && k !== "course_axis" && k !== "race_start_time");
        const viewKey = getTableViewKey(view());
        const config = PRESTART_TABLE_CONFIG[viewKey];
        let cols: string[];
        if (config?.columnOrder?.length) {
          const ordered: string[] = [];
          for (const configKey of config.columnOrder) {
            const resolved = resolveColumnKey(raw, configKey);
            if (resolved) ordered.push(resolved);
          }
          const remaining = raw.filter((k) => !ordered.some((o) => o.toLowerCase() === k.toLowerCase())).sort((a, b) => a.localeCompare(b));
          cols = [...ordered, ...remaining];
        } else {
          const rankKey = raw.find((k) => k.toUpperCase() === "RANK");
          const teamKey = raw.find((k) => TEAM_COLUMN_NAMES.some((t) => t.toLowerCase() === k.toLowerCase()));
          const rest = raw.filter((k) => k !== rankKey && k !== teamKey).sort((a, b) => a.localeCompare(b));
          cols = [...(rankKey ? [rankKey] : []), ...(teamKey ? [teamKey] : []), ...rest];
        }
        setTableColumns(cols);
        const first = rows[0];
        const fromRow = first?.Course_axis ?? (first as Record<string, unknown>)?.course_axis;
        const numFromRow = typeof fromRow === "number" && Number.isFinite(fromRow) ? fromRow : null;
        if (numFromRow == null) {
          try {
            const axisUrl = `${apiEndpoints.app.data}/prestart-summary?class_name=${encodeURIComponent(className!)}&project_id=${encodeURIComponent(projectId!)}&date=${encodeURIComponent(date)}&race=${encodeURIComponent(race!)}&view=courseaxis`;
            const axisResult = await getData(axisUrl);
            const axisRows = axisResult?.success && axisResult?.data?.rows ? (axisResult.data.rows as Record<string, unknown>[]) : [];
            const axisVal = axisRows[0]?.Course_axis ?? (axisRows[0] as Record<string, unknown>)?.course_axis;
            setCourseAxisFromApi(typeof axisVal === "number" && Number.isFinite(axisVal) ? axisVal : undefined);
          } catch {
            setCourseAxisFromApi(undefined);
          }
        } else {
          setCourseAxisFromApi(undefined);
        }
        setSelectedSourceNamesSignal([]);
      } else {
        setTableColumns([]);
        setSelectedSourceNamesSignal([]);
        setCourseAxisFromApi(undefined);
      }
    } catch (err) {
      logError("Prestart: fetch table failed", err);
      setTableRows([]);
      setTableColumns([]);
      setSelectedSourceNamesSignal([]);
      setCourseAxisFromApi(undefined);
    }
  };

  const fetchMapData = async () => {
    const ids = eventIds();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const desc = `${viewIndex()}_prestart`;
    if (!className || !projectId || ids.length === 0) {
      setMapData([]);
      return;
    }
    try {
      const url = `${apiEndpoints.app.data}/prestart-mapdata?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&event_list=${encodeURIComponent(JSON.stringify(ids))}&desc=${encodeURIComponent(desc)}`;
      const result = await getData(url);
      const raw = result?.success ? result.data : null;
      const rows: { event_id: number; source_name: string; json?: string | { values?: { lat?: string; lng?: string; time?: string; Time?: string; hdg?: string; Hdg?: string }[] }; JSON?: unknown }[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { rows?: unknown[] })?.rows)
          ? (raw as { rows: typeof rows }).rows
          : [];
      let tracks = rows.map((row) => {
        let json: string | { values?: { lat?: string; lng?: string; time?: string; Time?: string; hdg?: string; Hdg?: string }[]; marks?: { NAME?: string; LAT?: number; LON?: number; lat?: number; lon?: number; lng?: number }[] } | undefined = (row.json ?? (row as { JSON?: unknown }).JSON) as string | { values?: { lat?: string; lng?: string; time?: string; Time?: string; hdg?: string; Hdg?: string }[]; marks?: { NAME?: string; LAT?: number; LON?: number; lat?: number; lon?: number; lng?: number }[] } | undefined;
        if (typeof json === "string") {
          try {
            json = JSON.parse(json) as { values?: { lat?: string; lng?: string; time?: string; Time?: string; hdg?: string; Hdg?: string }[]; marks?: { NAME?: string; LAT?: number; LON?: number; lat?: number; lon?: number; lng?: number }[] };
          } catch {
            json = undefined;
          }
        }
        const values = (json && typeof json === "object" && Array.isArray(json.values)) ? json.values : [];
        const points = values
          .map((v) => {
            const vv = v as { lat?: string; lng?: string; Lat?: string; Lng?: string; time?: string; Time?: string; hdg?: string; Hdg?: string; note?: string; Note?: string };
            const lat = vv.lat ?? vv.Lat;
            const lng = vv.lng ?? vv.Lng;
            const timeRaw = vv.time ?? vv.Time;
            const hdgRaw = vv.hdg ?? vv.Hdg;
            const noteRaw = vv.note ?? vv.Note;
            const latN = parseFloat(String(lat));
            const lngN = parseFloat(String(lng));
            const timeN = timeRaw != null && timeRaw !== "" ? parseFloat(String(timeRaw)) : undefined;
            const hdgN = hdgRaw != null && hdgRaw !== "" ? parseFloat(String(hdgRaw)) : undefined;
            const noteStr = typeof noteRaw === "string" && noteRaw.trim() !== "" ? noteRaw.trim() : undefined;
            return {
              lat: latN,
              lng: lngN,
              ...(typeof timeN === "number" && Number.isFinite(timeN) ? { time: timeN } : {}),
              ...(typeof hdgN === "number" && Number.isFinite(hdgN) ? { hdg: hdgN } : {}),
              ...(noteStr !== undefined ? { note: noteStr } : {}),
            };
          })
          .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lng) && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        let marks: PrestartMark[] | undefined;
        const rawMarks = (json && typeof json === "object" && Array.isArray((json as { marks?: unknown }).marks)) ? (json as { marks: { NAME?: string; LAT?: number; LON?: number; lat?: number; lon?: number; lng?: number }[] }).marks : undefined;
        if (rawMarks && rawMarks.length > 0) {
          marks = rawMarks
            .map((m) => {
              const name = (m?.NAME ?? "").toString().trim().toUpperCase();
              if (!name) return null;
              const lat = Number(m?.LAT ?? (m as { lat?: number }).lat);
              const lon = Number(m?.LON ?? (m as { lon?: number }).lon ?? (m as { lng?: number }).lng);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
              return { NAME: name, LAT: lat, LON: lon } as PrestartMark;
            })
            .filter((m): m is PrestartMark => m != null);
          if (marks.length === 0) marks = undefined;
        }
        return { event_id: row.event_id, source_name: (row as { source_name?: string }).source_name || "", points, ...(marks && marks.length > 0 ? { marks } : {}) };
      });

      // Filter tracks by global source selection from filterStore (same as FleetMap)
      const selectedSourceNames = getSelectedSourceNames();
      if (selectedSourceNames) {
        tracks = tracks.filter((track) =>
          track.source_name && selectedSourceNames.has(track.source_name.toLowerCase().trim())
        );
        logDebug('Prestart: Filtered map tracks by global source selection', {
          totalTracks: rows.length,
          filteredTracks: tracks.length,
          selectedSourceNames: Array.from(selectedSourceNames)
        });
      }

      const pointCounts = tracks.map((t) => t.points.length);
      logDebug("Prestart: mapdata", { desc, rows: rows.length, tracks: tracks.length, pointsPerTrack: pointCounts.join(","), totalPoints: pointCounts.reduce((a, b) => a + b, 0) });
      setMapData(tracks);
    } catch (err) {
      logError("Prestart: fetch mapdata failed", err);
      setMapData([]);
    }
  };

  const fetchTimeseries = async () => {
    const ids = eventIds();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!className || !projectId || ids.length === 0) {
      setTsData([]);
      return;
    }
    const idx = viewIndex();
    const desc = idx === 0 ? "0_Basics" : `${idx}_Details`;
    try {
      const url = `${apiEndpoints.app.data}/prestart-timeseries?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&event_list=${encodeURIComponent(JSON.stringify(ids))}&desc=${encodeURIComponent(desc)}`;
      const result = await getData(url);
      if (!result?.success || !Array.isArray(result.data)) {
        setTsData([]);
        return;
      }
      const rows = result.data as { event_id: number; source_name: string; json: string | { charts?: string[]; values?: Record<string, number>[] } }[];
      let parsed = rows.map((row) => {
        let J = row.json;
        if (typeof J === "string") {
          try {
            J = JSON.parse(J) as { charts?: string[]; values?: Record<string, number>[] };
          } catch {
            J = {};
          }
        }
        const charts = (J as { charts?: string[] }).charts || [];
        const values = (J as { values?: Record<string, number>[] }).values || [];
        return { event_id: row.event_id, source_name: row.source_name || "", charts, values };
      });

      // Filter timeseries by global source selection from filterStore (same as FleetMap)
      const selectedSourceNames = getSelectedSourceNames();
      if (selectedSourceNames) {
        parsed = parsed.filter((ts) =>
          ts.source_name && selectedSourceNames.has(ts.source_name.toLowerCase().trim())
        );
        logDebug('Prestart: Filtered timeseries by global source selection', {
          totalTimeseries: rows.length,
          filteredTimeseries: parsed.length,
          selectedSourceNames: Array.from(selectedSourceNames)
        });
      }

      setTsData(parsed);
    } catch (err) {
      logError("Prestart: fetch timeseries failed", err);
      setTsData([]);
    }
  };

  const getRowValue = (row: Record<string, unknown>, key: string): number | string | null => {
    const v = getRowValueByKey(row, key);
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    return String(v);
  };

  const valueKeys = createMemo(() => {
    const cols = tableColumns();
    return cols.filter(
      (k) => k.toUpperCase() !== "RANK" && !TEAM_COLUMN_NAMES.some((t) => t.toLowerCase() === k.toLowerCase())
    );
  });

  const sortAndFormat = (key: string) => {
    const rows = tableRows();
    const current = sortConfig();
    const direction = current.key === key && current.direction === "asc" ? "desc" : "asc";
    setSortConfig({ key, direction });
    if (valueKeys().includes(key)) {
      const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
      const values = rows.map((r) => getVal(r)).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
      const min = d3.min(values) ?? 0;
      const max = d3.max(values) ?? 0;
      setColumnScales((prev) => ({ ...prev, [key]: JSON.stringify({ domain: [min, max], range: [0, 6] }) }));
      setFormattedColumns((prev) => (prev.includes(key) ? prev : [...prev, key]));
    }
  };

  const clearFormatting = () => {
    setFormattedColumns([]);
    setColumnScales({});
    setSortConfig({ key: "", direction: "asc" });
  };

  const sortedRows = createMemo(() => {
    const rows = tableRows();
    const { key, direction } = sortConfig();
    const currentView = view();

    if (rows.length === 0) return rows;

    // For REACH and LEG 1 views, always sort with -999 values at the bottom
    const isReachOrLeg1View = currentView === "REACH" || currentView === "LEG 1";

    if (isReachOrLeg1View) {
      const rankKey = currentView === "LEG 1" ? "Leg1_dist" : "Reach_dist";

      return [...rows].sort((a, b) => {
        // First, check if either row has -999 in the ranking column (push to bottom)
        const aRankVal = getRowValue(a, rankKey);
        const bRankVal = getRowValue(b, rankKey);
        const aIs999 = typeof aRankVal === "number" && aRankVal === -999;
        const bIs999 = typeof bRankVal === "number" && bRankVal === -999;

        // If one has -999 and the other doesn't, push -999 to bottom
        if (aIs999 && !bIs999) return 1;
        if (!aIs999 && bIs999) return -1;

        // If no sort key is set, rank by distance descending (max = first)
        if (!key) {
          const aNum = typeof aRankVal === "number" ? aRankVal : Number(aRankVal);
          const bNum = typeof bRankVal === "number" ? bRankVal : Number(bRankVal);
          if (Number.isFinite(aNum) && Number.isFinite(bNum)) return bNum - aNum;
          return 0;
        }

        // Otherwise, apply normal sorting by the selected column
        const aV = getRowValue(a, key);
        const bV = getRowValue(b, key);

        if (aV == null && bV == null) return 0;
        if (aV == null) return direction === "asc" ? 1 : -1;
        if (bV == null) return direction === "asc" ? -1 : 1;

        const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
        return direction === "asc" ? cmp : -cmp;
      });
    }

    // For other views, use normal sorting
    if (!key) return rows;

    const getVal = (row: Record<string, unknown>) => getRowValue(row, key);
    return [...rows].sort((a, b) => {
      const aV = getVal(a);
      const bV = getVal(b);

      if (aV == null && bV == null) return 0;
      if (aV == null) return direction === "asc" ? 1 : -1;
      if (bV == null) return direction === "asc" ? -1 : 1;

      const cmp = typeof aV === "number" && typeof bV === "number" ? aV - bV : String(aV).localeCompare(String(bV));
      return direction === "asc" ? cmp : -cmp;
    });
  });

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

  const formatCell = (v: unknown): string => {
    if (v == null || v === "") return "—";
    const n = Number(v);
    if (!Number.isNaN(n)) return n.toFixed(1);
    return String(v);
  };

  /** Copy prestart table to clipboard (values only). */
  const copyPrestartTableToClipboard = async () => {
    try {
      const viewKey = getTableViewKey(view());
      const cols = tableColumns();
      const rowsList = sortedRows();
      if (cols.length === 0) return;
      const headers = cols.map((col) => getColumnDisplay(viewKey, col).header);
      let clipboardText = headers.join("\t") + "\n";
      for (const row of rowsList) {
        const cells = cols.map((col) => {
          const cellValue = getRowValueByKey(row as Record<string, unknown>, col);
          const isSourceCol = TEAM_COLUMN_NAMES.some((k) => k.toLowerCase() === col.toLowerCase());
          return isSourceCol ? String(cellValue ?? "—") : formatCell(cellValue);
        });
        clipboardText += cells.join("\t") + "\n";
      }
      log("Prestart: copy table to clipboard", { textLength: clipboardText.length });
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } else {
        const ta = document.createElement("textarea");
        ta.value = clipboardText;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }
    } catch (err: unknown) {
      logError("Prestart: copy table failed", err);
    }
  };

  /** Sync selected source names to selectionStore as selectedGroupKeys (sources = groups). */
  createEffect(() => {
    const names = selectedSourceNamesSignal();
    setSelectedGroupKeys(names);
  });

  /** When SelectionBanner Clear is clicked, clear local selection so table and map update. */
  createEffect(() => {
    const handler = () => setSelectedSourceNamesSignal([]);
    window.addEventListener("selection-banner-cleared", handler);
    onCleanup(() => window.removeEventListener("selection-banner-cleared", handler));
  });

  const toggleSourceSelection = (sourceName: string) => {
    const key = String(sourceName ?? "").trim();
    if (!key) return;
    setSelectedSourceNamesSignal((prev) =>
      prev.includes(key) ? prev.filter((n) => n !== key) : [...prev, key]
    );
  };

  const isSourceSelected = (sourceName: string) =>
    selectedSourceNamesSignal().includes(String(sourceName ?? "").trim());

  /** Star on map: in REACH/LEG 1 = time from map point with note 'max bsp'; in ACCELERATION = Time_accmax; in other views = Time_bspmax (max BSP). */
  const markerTimeBySource = createMemo((): Record<string, number> => {
    const v = view();
    const selected = selectedSourceNamesSignal();
    if (selected.length === 0) return {};
    const out: Record<string, number> = {};
    if (v === "REACH" || v === "LEG 1") {
      const tracks = mapData();
      for (const track of tracks) {
        if (!selected.includes(track.source_name)) continue;
        const pt = track.points.find((p) => p.note === "max bsp" && typeof p.time === "number" && Number.isFinite(p.time));
        if (pt != null) out[track.source_name] = pt.time as number;
      }
      return out;
    }
    const rows = tableRows();
    const timeKey = v === "ACCELERATION" ? "Time_accmax" : "Time_bspmax";
    for (const row of rows) {
      const sourceName = getTeamFromRow(row as Record<string, unknown>);
      if (!selected.includes(sourceName)) continue;
      const val = getRowValue(row as Record<string, unknown>, timeKey);
      if (val != null && typeof val === "number" && Number.isFinite(val) && val > -999) {
        out[sourceName] = val;
      }
    }
    return out;
  });

  /** Golden boat on map: only when NOT in ACCELERATION or MAX BSP view. In REACH/LEG 1 = time from map point with note 'max accel'; otherwise Time_accmax. */
  const markerTimeBySourceBoat = createMemo((): Record<string, number> => {
    const v = view();
    if (v === "ACCELERATION" || v === "MAX BSP") return {};
    const selected = selectedSourceNamesSignal();
    if (selected.length === 0) return {};
    const out: Record<string, number> = {};
    if (v === "REACH" || v === "LEG 1") {
      const tracks = mapData();
      for (const track of tracks) {
        if (!selected.includes(track.source_name)) continue;
        const pt = track.points.find((p) => p.note === "max accel" && typeof p.time === "number" && Number.isFinite(p.time));
        if (pt != null) out[track.source_name] = pt.time as number;
      }
      return out;
    }
    const rows = tableRows();
    for (const row of rows) {
      const sourceName = getTeamFromRow(row as Record<string, unknown>);
      if (!selected.includes(sourceName)) continue;
      const val = getRowValue(row as Record<string, unknown>, "Time_accmax");
      if (val != null && typeof val === "number" && Number.isFinite(val) && val > -999) {
        out[sourceName] = val;
      }
    }
    return out;
  });

  onMount(() => {
    logDebug("Prestart: mount - setting up scaling");
    logPageLoad("Prestart.tsx", "Start Summary", "Loaded");
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: "Prestart",
      scaleToWidth: true,
    });
    onCleanup(() => {
      logDebug("Prestart: cleanup - removing scaling");
      cleanupScaling();
    });
  });

  createEffect(() => {
    selectedClassName();
    selectedProjectId();
    selectedDate();
    fetchRaces();
  });

  createEffect(() => {
    const race = selectedRace();
    view();
    // Also watch filterStore for source selection changes
    filterStoreSelectedSources();
    setSelectedTimeSec(null);
    if (!race || !dateNorm()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        await fetchTable();
      } finally {
        setLoading(false);
      }
    })();
  });

  const fetchMarks = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = dateNorm();
    if (!className || !projectId || date.length !== 8) {
      setMarksByTime([]);
      return;
    }
    const dateStr = formatDateForMarksApi(date);
    try {
      for (const objName of ["markwind", "marks"] as const) {
        const url = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=${objName}`;
        const result = await getData(url);
        const data = result?.success ? result.data : null;
        if (!data) continue;
        let arr: { DATETIME?: string; Datetime?: string; datetime?: string; TIMESTAMP?: string; MARKS?: { NAME?: string; POSITION?: string; LAT?: number; LON?: number; lng?: number }[] }[] = [];
        const jsonValue = (data as { value?: unknown })?.value ?? data;
        if (Array.isArray(jsonValue)) {
          arr = jsonValue;
        } else if (typeof jsonValue === "string") {
          arr = JSON.parse(jsonValue) as typeof arr;
        } else if (jsonValue && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
          const single = (jsonValue as { MARKS?: { NAME?: string; POSITION?: string; LAT?: number; LON?: number; lng?: number }[] }).MARKS;
          if (Array.isArray(single)) arr = [{ MARKS: single }];
          else arr = [];
        } else {
          arr = Array.isArray(jsonValue) ? jsonValue : [];
        }
        const entries: { datetime: string; marks: PrestartMark[] }[] = [];
        for (const entry of arr) {
          const mar = entry?.MARKS;
          const dt = entry?.DATETIME ?? entry?.Datetime ?? entry?.datetime ?? entry?.TIMESTAMP ?? "";
          if (!Array.isArray(mar)) continue;
          const out: PrestartMark[] = [];
          for (const mark of mar) {
            const name = (mark?.NAME ?? mark?.POSITION ?? "").toString().trim().toUpperCase();
            if (!PRESTART_MARK_NAMES.includes(name as (typeof PRESTART_MARK_NAMES)[number])) continue;
            const lat = Number(mark?.LAT ?? (mark as { lat?: number }).lat);
            const lon = Number(mark?.LON ?? (mark as { lon?: number }).lon ?? (mark as { lng?: number }).lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            out.push({ NAME: name, LAT: lat, LON: lon });
          }
          if (out.length > 0) entries.push({ datetime: String(dt), marks: out });
        }
        if (entries.length > 0) {
          setMarksByTime(entries);
          return;
        }
      }
      setMarksByTime([]);
    } catch (err) {
      logError("Prestart: fetch marks failed", err);
      setMarksByTime([]);
    }
  };

  /** Parse a race start time (ISO string or timestamp) to ms for comparison. */
  function parseTimeToMs(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v < 1e13 ? v * 1000 : v;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n < 1e13 ? n * 1000 : n;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  /**
   * Marks for the current race: use same logic as fleet map (RaceCourseLayer findNearestByTime).
   * Prefer last entry at or before race_start_time; if none, use latest entry; else closest by time.
   */
  const marksForRace = createMemo(() => {
    const entries = marksByTime();
    const firstRow = tableRows()[0];
    const raceStart = firstRow?.race_start_time;
    if (entries.length === 0) return [];
    if (entries.length === 1) return entries[0].marks;
    const raceMs = parseTimeToMs(raceStart);
    if (raceMs == null) return entries[entries.length - 1].marks;
    const sorted = [...entries].sort((a, b) => {
      const ta = parseTimeToMs(a.datetime) ?? -Infinity;
      const tb = parseTimeToMs(b.datetime) ?? -Infinity;
      return ta - tb;
    });
    let lastAtOrBefore: typeof entries[0] | null = null;
    let lastAtOrBeforeMs = -Infinity;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const entry = sorted[i];
      const entryMs = parseTimeToMs(entry.datetime);
      if (entryMs == null) continue;
      if (entryMs <= raceMs && entryMs > lastAtOrBeforeMs) {
        lastAtOrBefore = entry;
        lastAtOrBeforeMs = entryMs;
      }
    }
    if (lastAtOrBefore) return lastAtOrBefore.marks;
    const latest = sorted[sorted.length - 1];
    if (latest && parseTimeToMs(latest.datetime) != null) return latest.marks;
    let best = sorted[0];
    let bestDiff = Infinity;
    for (const entry of sorted) {
      const entryMs = parseTimeToMs(entry.datetime);
      if (entryMs == null) continue;
      const diff = Math.abs(entryMs - raceMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = entry;
      }
    }
    return best.marks;
  });

  /** Marks for the prestart map: use marks from first selected source's track (or first track with marks).
   * Embedded marks are rotated and transposed with the map data so they align with tracks. Fallback to marksForRace() for old data without embedded marks. */
  const marksForMap = createMemo((): { marks: PrestartMark[]; alreadyRotated: boolean } => {
    const tracks = mapData();
    const selected = getSelectedSourceNames();
    if (tracks.length === 0) return { marks: marksForRace(), alreadyRotated: false };
    const withMarks = tracks.filter((t): t is typeof t & { marks: PrestartMark[] } => Array.isArray(t.marks) && t.marks.length > 0);
    if (withMarks.length === 0) return { marks: marksForRace(), alreadyRotated: false };
    const firstSelected = selected && selected.size > 0
      ? withMarks.find((t) => t.source_name && selected.has(t.source_name.toLowerCase().trim()))
      : null;
    const chosen = firstSelected ?? withMarks[0];
    return { marks: chosen.marks, alreadyRotated: true };
  });

  createEffect(() => {
    selectedClassName();
    selectedProjectId();
    selectedDate();
    if (dateNorm()) fetchMarks();
    else setMarksByTime([]);
  });

  createEffect(() => {
    view();
    // Also watch filterStore for source selection changes
    filterStoreSelectedSources();
    const ids = eventIds();
    if (ids.length === 0) {
      setMapData([]);
      setTsData([]);
      return;
    }
    setMapData([]);
    setTsData([]);
    fetchMapData();
    fetchTimeseries();
  });

  /** Timeseries desc for current view: 0_Basics (PRESTART), 1_Details (ACCELERATION/MAX BSP/REACH), 2_Details (LEG 1 only). */
  const tsDesc = () => {
    const idx = viewIndex();
    return idx === 0 ? "0_Basics" : `${idx}_Details`;
  };

  const tsCharts = createMemo(() => {
    const data = tsData();
    const desc = tsDesc();
    const expectedCharts = PRESTART_TIMESERIES_CHARTS[desc];
    if (expectedCharts && expectedCharts.length > 0) return expectedCharts;
    if (data.length === 0) return [];
    const charts = data[0].charts || [];
    return charts.filter((c) => c && typeof c === "string");
  });

  /** True when report should be hidden and "data not available" message shown. Only when there are no races for the date; once races exist we show the UI (table may be empty or loading). */
  const hasNoData = createMemo(() => {
    if (loading()) return false;
    const raceList = races();
    return raceList.length === 0;
  });

  const renderTable = createMemo(() => {
    const scales = columnScales();
    const formatted = formattedColumns();
    const cols = tableColumns();
    const rows = sortedRows();
    const viewKey = getTableViewKey(view());

    if (cols.length === 0) {
      return <div>Loading table...</div>;
    }

    // @ts-ignore - reactive dependency for selection
    const _selectedNames = selectedSourceNamesSignal();

    return (
      <table class="prestart-table">
        <thead>
          <tr>
            <For each={cols}>
              {(col) => {
                const { header, tooltip } = getColumnDisplay(viewKey, col);
                const thClass = "centered";
                return (
                  <th
                    class={thClass}
                    title={`${tooltip} — Click to sort`}
                    style={{ cursor: "pointer" }}
                    onClick={() => sortAndFormat(col)}
                  >
                    {header} {sortConfig().key === col ? (sortConfig().direction === "asc" ? "▲" : "▼") : ""}
                  </th>
                );
              }}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows}>
            {(row) => {
              const sourceName = getTeamFromRow(row as Record<string, unknown>);
              const selected = isSourceSelected(sourceName);
              const sourceColor = getSourceColor(sourceName || undefined);
              const rowColor = selected ? (sourceColor ?? "var(--color-bg-secondary)") : undefined;
              /* Same as maneuvers: full-row selection (tr gets background; cells inherit via CSS). Use same style string with !important. */
              const rowStyle =
                selected && rowColor
                  ? `background-color: ${rowColor} !important; color: white !important; cursor: pointer`
                  : "cursor: pointer";
              return (
                <tr
                  class={selected ? "row-selected" : ""}
                  style={rowStyle}
                  onClick={() => sourceName && toggleSourceSelection(sourceName)}
                >
                  <For each={cols}>
                    {(col) => {
                      const scaleClass = cellClassForScale(row as Record<string, unknown>, col, scales, formatted);
                      const isSourceCol = TEAM_COLUMN_NAMES.some((k) => k.toLowerCase() === col.toLowerCase());
                      const cellValue = getRowValueByKey(row as Record<string, unknown>, col);
                      const displayValue = isSourceCol ? String(cellValue ?? "—") : formatCell(cellValue);
                      const cellClass = ["centered", scaleClass].filter(Boolean).join(" ");
                      const cellStyle =
                        selected
                          ? (isSourceCol && sourceColor ? { "font-weight": "600" } : undefined)
                          : isSourceCol && sourceColor
                            ? { color: sourceColor, "font-weight": "600" }
                            : undefined;
                      return (
                        <td class={cellClass} style={cellStyle}>
                          {displayValue}
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
  });

  return (
    <div id="media-container" class="prestart-page">
      <div class="container">
        {/* Same scroll pattern as Race Summary: scroll container height set by setupMediaContainerScaling, scroll in inner */}
        <div class="performance-charts-scroll-container">
          <div class="performance-charts-scroll-inner" style={{ padding: "1.5rem", "box-sizing": "border-box" }}>
        <Show when={hasNoData()}>
          <div class="report-no-data-container">
            <p class="report-no-data-message">Data is not available yet.</p>
          </div>
        </Show>

        <Show when={!hasNoData()}>
          <div class="prestart-controls" style={{ "margin-bottom": "1rem", display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "0.5rem" }}>
            <RaceSettings />
            <DropDownButton
              options={[...VIEW_OPTIONS]}
              defaultText={view()}
              smallLabel="View"
              size="big"
              handleSelection={async (v) => {
                setView(v as typeof VIEW_OPTIONS[number]);
                const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                await logActivity(project_id, dataset_id, "Prestart.tsx", "Start Summary", `View changed to ${v}`);
              }}
            />
            <DropDownButton
              options={races().length > 0 ? races() : ["Select race"]}
              defaultText={selectedRace() || "Select race"}
              smallLabel="Races"
              size="big"
              handleSelection={async (v) => {
                if (v !== "Select race") {
                  setSelectedRace(v);
                  const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
                  await logActivity(project_id, dataset_id, "Prestart.tsx", "Start Summary", `Race changed to ${v}`);
                }
              }}
            />
          </div>

          <div class="prestart-content-area" style={{ position: "relative", "min-height": "200px" }}>
            <Show when={loading()}>
              <LoadingOverlay />
            </Show>

            <Show when={!loading()}>
              <div class="prestart-table-map-row">
                {/* Table: same structure as Race Summary — data-table-container + scrollable-container for fixed columns, wrapping headers, overflow scroll */}
                <section class="prestart-table-section" style={{ "margin-bottom": "1.5rem" }}>
                  <div
                    class="copy-table-hover-wrapper"
                    onMouseEnter={() => setIsHoveredTable(true)}
                    onMouseLeave={() => setIsHoveredTable(false)}
                  >
                    <div class="data-table-container">
                      <div class="scrollable-container">
                        {renderTable()}
                      </div>
                    </div>
                    {isHoveredTable() && tableRows().length > 0 && (
                      <div class="copy-table-data-actions">
                        <button
                          type="button"
                          class="copy-table-data-btn"
                          classList={{ "copy-table-data-btn-success": copySuccess() }}
                          onClick={copyPrestartTableToClipboard}
                        >
                          {copySuccess() ? "✓ Copied!" : "Copy Table Data"}
                        </button>
                      </div>
                    )}
                    <div class="prestart-table-actions-row">
                      <p class="prestart-ranking-label">{getRankingLabel(view())}</p>
                      <button class="btn" type="button" onClick={clearFormatting}>
                        Clear Formatting
                      </button>
                    </div>
                  </div>
                </section>

                {/* Map */}
                <section class="prestart-map-section">
                  <div class="prestart-map-wrapper">
                    <PrestartReportMap
                      tracks={mapDataForView()}
                      marks={marksForMap().marks}
                      marksAlreadyRotated={marksForMap().alreadyRotated}
                      courseAxisDeg={(() => {
                        // Use first table row's Course_axis so marks use one rotation; backend uses race-level course axis when available for alignment
                        const r = tableRows()[0];
                        const fromRow = r?.Course_axis ?? (r as Record<string, unknown> | undefined)?.course_axis;
                        const n = typeof fromRow === "number" && Number.isFinite(fromRow) ? fromRow : courseAxisFromApi();
                        return typeof n === "number" && Number.isFinite(n) ? n : undefined;
                      })()}
                      selectedSourceNames={selectedSourceNames()}
                      selectedTimeSec={selectedTimeSec()}
                      markerTimeBySource={markerTimeBySource()}
                      markerTimeBySourceBoat={markerTimeBySourceBoat()}
                      onTrackClick={toggleSourceSelection}
                      getSourceColor={getSourceColor}
                    />
                  </div>
                </section>
              </div>

              {/* Timeseries: full width below table+map row */}
              <section class="prestart-timeseries-section">
                <div class="prestart-timeseries-charts">
                  <Show when={tsCharts().length > 0} fallback={<p class="prestart-timeseries-empty">No timeseries data for this view. Run prestart processing to populate charts.</p>}>
                    <div class="prestart-timeseries-container">
                      <For each={tsCharts()}>
                        {(channelKey) => (
                          <div class="prestart-chart-wrap">
                            <PrestartChart
                              channelKey={channelKey}
                              tsData={tsDataForView()}
                              selectedSourceNames={selectedSourceNames()}
                              selectedTimeSec={selectedTimeSec()}
                              onTimeSelect={(t) => setSelectedTimeSec(t)}
                              onTimeClear={() => setSelectedTimeSec(null)}
                              markerTimesBySource={markerTimeBySource()}
                              onSourceClick={toggleSourceSelection}
                              getColorForSource={getSourceColor}
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </section>
            </Show>
          </div>
        </Show>
          </div>
        </div>
        <Portal mount={typeof document !== "undefined" ? document.body : undefined}>
          <div
            id="prestart-timeseries-tooltip"
            class="tooltip"
            style={{
              opacity: tooltip().visible ? 1 : 0,
              left: `${tooltip().x}px`,
              top: `${tooltip().y}px`,
              position: "fixed",
              "pointer-events": "none",
              "z-index": 9999,
            }}
            innerHTML={tooltip().content}
          />
        </Portal>
      </div>
    </div>
  );
}
