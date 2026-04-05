import { createSignal, onMount, onCleanup, Show, For, createMemo, createEffect } from "solid-js";
import * as d3 from "d3";

import { getData, setupMediaContainerScaling } from "../../../../utils/global";
import { persistantStore } from "../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { debug, pageReport, warn, error as logError } from "../../../../utils/console";
import { logPageLoad } from "../../../../utils/logging";
import Loading from "../../../../components/utilities/Loading";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { resolveDataField } from "../../../../utils/colorScale";
import Violin from "../../../../components/charts/Violin";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId } = persistantStore;

/**
 * Channel names for violins / AWS baseline (single-sensor AC40: legacy ``Awa_deg`` / ``Aws_kts`` after normalize).
 * Request payloads use ``AC40_*`` where applicable; ``normalizeCalibrationChannelRows`` maps to legacy names
 * where we still use short keys. Normalized corrected leeway uses ``AC40_Leeway_n_cor_deg`` (legacy ``Lwy_n_cor_deg`` mirrored in normalize for old parquets). Optional: ``Aws_fused_kts``, ``Awa_n_fused_deg`` for older datasets.
 */
const CalParquet = {
  twsKnots: "Tws_kts",
  twsCorKnots: "Tws_cor_kts",
  twsCorMetric: "Tws_cor_kph",
  awsKnots: "Aws_kts",
  awsFusedKnots: "Aws_fused_kts",
  awsCorKnots: "Aws_cor_kts",
  bspKnots: "Bsp_kts",
  bspMetric: "Bsp_kph",
  /** Normalized corrected leeway (fusion / racesight public name). */
  lwyNCorDeg: "AC40_Leeway_n_cor_deg",
} as const;

const CalAxisLabel = {
  twsKnots: "TWS (kts)",
  twsMetric: "TWS (kph)",
  bspKnots: "BSP (kts)",
  bspMetric: "BSP (kph)",
} as const;

const CAL_VIOLIN_UNITS_NOTE =
  "TWS left, BSP right. Red port / green stbd (TWA sign). AWA/TWA/CWA/LWY angle violins: |°| after ±180° wrap (same as summary tables).";

/** Tighter y-scale for TWA/CWA magnitude violins (less padding than default; no d3.nice expansion). */
const CAL_VIOLIN_TWA_CWA_YPAD = 0.03;

/** Max magnitude (deg) for AWA offset vs time: matches backend MAX_AWA_CALIBRATION_OFFSET_DEG (leeway still ±5°). */
const CAL_OFFSET_DISPLAY_CLAMP_DEG = 3;

/** Symmetric box smooth for AWA offset vs time: full window width in seconds (±half around each sample). */
const CAL_OFFSET_TIMESERIES_SMOOTH_WIDTH_SEC = 10;

/** Symmetric box smooth for LWY offset vs time only (5 minutes total width). */
const CAL_LWY_OFFSET_TIMESERIES_SMOOTH_WIDTH_SEC = 5 * 60;

function clampCalibrationOffsetDisplayDeg(v: number): number {
  if (!Number.isFinite(v) || Number.isNaN(v)) return v;
  const lim = CAL_OFFSET_DISPLAY_CLAMP_DEG;
  return Math.max(-lim, Math.min(lim, v));
}

/** Min/max of plotted offset samples plus padding; used when the series has no finite points. */
function calibrationOffsetChartYDomain(values: number[], emptyFallback: [number, number]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return emptyFallback;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  if (!(lo < hi)) {
    const c = lo;
    const pad = Math.max(Math.abs(c) * 0.15, 0.25);
    return [c - pad, c + pad];
  }
  const span = hi - lo;
  const pad = Math.max(span * 0.06, 0.1);
  return [lo - pad, hi + pad];
}

/**
 * Mean of finite `values[j]` whose timestamps fall in `[t - halfWidth, t + halfWidth]` (seconds).
 * Assumes `timestampsSec` is non-decreasing (sorted rows). O(n) two-pointer.
 */
function smoothOffsetsByTimeSec(
  timestampsSec: number[],
  values: number[],
  halfWidthSec: number
): number[] {
  const n = values.length;
  const out: number[] = new Array(n);
  let start = 0;
  let end = 0;
  for (let i = 0; i < n; i++) {
    const t = timestampsSec[i];
    if (!Number.isFinite(t) || t <= 0) {
      out[i] = NaN;
      continue;
    }
    const tLo = t - halfWidthSec;
    const tHi = t + halfWidthSec;
    while (start < n && timestampsSec[start] < tLo) start++;
    if (end < start) end = start;
    while (end < n && timestampsSec[end] <= tHi) end++;
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      const v = values[j];
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}

/** AC40 (fetch / parquet) → legacy short names used by the rest of this report (mirrors ``2_processing`` + fusion). */
const AC40_TO_LEGACY_CALIBRATION: Record<string, string> = {
  AC40_Latitude: "Lat_dd",
  AC40_Longitude: "Lng_dd",
  AC40_BowWand_TWS_kts: "Tws_kts",
  AC40_HDG: "Hdg_deg",
  AC40_BowWand_TWD: "Twd_deg",
  AC40_Speed_kts: "Bsp_kts",
  AC40_TWA: "Twa_deg",
  AC40_TWA_n: "Twa_n_deg",
  AC40_CWA: "Cwa_deg",
  AC40_CWA_n: "Cwa_n_deg",
  AC40_VMG_kts: "Vmg_kts",
  AC40_COG: "Cog_deg",
  AC40_HullAltitude: "Hull_altitude",
  AC40_BowWand_AWA: "Awa_deg",
  AC40_BowWand_AWA_n: "Awa_n_deg",
  AC40_BowWand_AWS: "Aws_kts",
  AC40_Leeway: "Lwy_deg",
  AC40_Leeway_n: "Lwy_n_deg",
  AC40_BowWand_AWA_offset_deg: "Awa_offset_deg",
  AC40_Leeway_offset_deg: "Lwy_offset_deg",
  AC40_Leeway_offset_n_deg: "Lwy_offset_norm_deg",
  AC40_BowWand_AWA_cor_deg: "Awa_cor_deg",
  AC40_BowWand_AWS_cor_kts: "Aws_cor_kts",
  AC40_BowWand_TWS_cor_kts: "Tws_cor_kts",
  AC40_TWA_cor_deg: "Twa_cor_deg",
  AC40_BowWand_TWD_cor_deg: "Twd_cor_deg",
  AC40_Leeway_cor_deg: "Lwy_cor_deg",
  AC40_BowWand_AWA_n_cor_deg: "Awa_n_cor_deg",
  AC40_TWA_n_cor_deg: "Twa_n_cor_deg",
  AC40_Cse_cor_deg: "Cse_cor_deg",
  AC40_CWA_cor_deg: "Cwa_cor_deg",
  AC40_CWA_n_cor_deg: "Cwa_n_cor_deg",
};

/**
 * Map each row from AC40 column names to legacy names in place (copy when AC40 key has a value).
 */
function normalizeCalibrationChannelRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [ac40, legacy] of Object.entries(AC40_TO_LEGACY_CALIBRATION)) {
      if (Object.prototype.hasOwnProperty.call(out, ac40)) {
        const v = out[ac40];
        if (v !== undefined && v !== null) {
          out[legacy] = v;
        }
      }
    }
    const ac40LwyNCor = CalParquet.lwyNCorDeg;
    const legacyLwyNCor = "Lwy_n_cor_deg";
    if (
      out[legacyLwyNCor] != null &&
      out[legacyLwyNCor] !== undefined &&
      (out[ac40LwyNCor] === undefined || out[ac40LwyNCor] === null)
    ) {
      out[ac40LwyNCor] = out[legacyLwyNCor];
    }
    return out;
  });
}

/**
 * Channels for calibration time-series request (deduped). Request **AC40** names where applicable; normalize to legacy after fetch.
 * Single-sensor: no ``Awa1``/``Aws2`` numbered columns unless multi-sensor fusion adds them later.
 */
const CALIBRATION_CHANNELS = [
  "ts",
  "Datetime",
  "Grade",
  "Race_number",
  "Leg_number",
  "AC40_BowWand_AWA",
  "AC40_BowWand_AWA_n",
  "AC40_BowWand_AWS",
  "AC40_BowWand_TWS_kts",
  "AC40_BowWand_TWD",
  "AC40_Speed_kts",
  "AC40_TWA",
  "AC40_TWA_n",
  "AC40_CWA",
  "AC40_CWA_n",
  "AC40_VMG_kts",
  "AC40_HDG",
  "AC40_COG",
  "AC40_Leeway",
  "AC40_Leeway_n",
  "AC40_BowWand_AWA_offset_deg",
  "AC40_Leeway_offset_deg",
  "AC40_Leeway_offset_n_deg",
  "AC40_BowWand_AWA_cor_deg",
  "AC40_BowWand_AWS_cor_kts",
  "AC40_BowWand_TWS_cor_kts",
  "AC40_TWA_cor_deg",
  "AC40_BowWand_TWD_cor_deg",
  "AC40_Leeway_cor_deg",
  "AC40_BowWand_AWA_n_cor_deg",
  "AC40_TWA_n_cor_deg",
  "AC40_Leeway_n_cor_deg",
  "AC40_Cse_cor_deg",
  "AC40_CWA_cor_deg",
  "AC40_CWA_n_cor_deg",
  // Legacy column names (older processed/fusion parquets); AC40 values overwrite in normalize when present.
  "Awa_deg",
  "Awa_n_deg",
  "Aws_kts",
  "Tws_kts",
  "Twd_deg",
  "Bsp_kts",
  "Twa_deg",
  "Twa_n_deg",
  "Cwa_deg",
  "Cwa_n_deg",
  "Vmg_kts",
  "Hdg_deg",
  "Cog_deg",
  "Lwy_deg",
  "Lwy_n_deg",
  "Awa_offset_deg",
  "Lwy_offset_deg",
  "Lwy_offset_norm_deg",
  "Awa_cor_deg",
  "Aws_cor_kts",
  "Tws_cor_kts",
  "Twa_cor_deg",
  "Twd_cor_deg",
  "Lwy_cor_deg",
  "Awa_n_cor_deg",
  "Twa_n_cor_deg",
  "Lwy_n_cor_deg",
  "Cse_cor_deg",
  "Cwa_cor_deg",
  "Cwa_n_cor_deg",
  "Awa_n_fused_deg",
  "Aws_fused_kts",
];

/** Maneuver channels for tack/gybe angle comparison. Only request Twa_entry and Twa_exit; the API always returns event_id and Datetime in the SELECT. */
const MANEUVERS_ANGLE_CHANNELS = ["Twa_entry", "Twa_exit", "Turn_angle_max"];

interface DatasetInfo {
  date: string;
  source_name: string;
  timezone?: string;
}

interface BeforeAfterRow {
  channel: string;
  meanBefore: number | null;
  meanAfter: number | null;
  deltaMean: number | null;
  pctDiff: number | null;
  count: number;
}

interface PortStbdRow {
  channel: string;
  portMean: number | null;
  stbdMean: number | null;
  diff: number | null;
  pctDiff: number | null;
  count: number;
}

interface ManeuverAngleRow {
  eventType: string;
  count: number;
  /** Mean |Twa_cor| (fallback Twa_deg); Grade ≥ 2; |TWA| &lt; 80 upwind, &gt; 115 downwind. */
  meanTwaCor: number;
  /** Mean |Cwa_n_cor_deg| where present; same row filter. */
  meanCwaCor: number;
  /** Mean |AC40_Leeway_n_cor_deg| where present; same row filter. */
  meanLwyCor: number;
  /** Tack: mean(Turn_angle_max) ÷ 2. Gybe: 180° − mean(Turn_angle_max) ÷ 2. */
  turnRefDeg: number;
  /** meanCwaCor − meanTwaCor */
  cwaVsTwa: number;
  /** meanTwaCor − turnRefDeg (wind |TWA| vs heading-derived turn reference) */
  twaVsTurnAng: number;
}

function getVal(d: Record<string, unknown>, key: string): number | null {
  const v = resolveDataField(d, key) ?? (d as any)[key];
  if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
  return Number(v);
}

/** Log channel-values result for this report; full array on ``window.__calibrationChannelData`` for DevTools. */
function logCalibrationFetchOutput(rows: Record<string, unknown>[]): void {
  const n = rows.length;
  const first = n > 0 ? rows[0] : null;
  const columns = first ? Object.keys(first).sort() : [];
  const sampleHead = n > 0 ? rows.slice(0, Math.min(3, n)).map((r) => ({ ...r })) : [];
  const sampleTail = n > 3 ? rows.slice(-2).map((r) => ({ ...r })) : [];
  pageReport("[Calibration] channel-values data returned", {
    rowCount: n,
    columns,
    sampleHead,
    ...(n > 3 ? { sampleTail } : {}),
  });
  if (typeof window !== "undefined") {
    (window as unknown as { __calibrationChannelData?: Record<string, unknown>[] }).__calibrationChannelData =
      rows;
    debug(
      "[Calibration] Full data: window.__calibrationChannelData (same array as report; inspect or JSON.stringify a slice in console)"
    );
  }
}

/** AWS “before”: legacy ``Aws_fused_kts`` if present, else ``Aws_kts``. After is always ``Aws_cor_kts``. */
function awsBeforeFieldForData(data: Record<string, unknown>[]): string {
  const P = CalParquet;
  if (data.some((d) => getVal(d, P.awsFusedKnots) !== null)) return P.awsFusedKnots;
  return P.awsKnots;
}

function formatCalibrationTableMean(v: number | null): string {
  return v === null ? "—" : v.toFixed(2);
}

function formatCalibrationTablePct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

function calibrationDeltaCellClass(delta: number | null): string {
  if (delta === null) return "";
  return delta > 0 ? "calibration-delta-positive" : delta < 0 ? "calibration-delta-negative" : "";
}

/**
 * Map degrees to (-180, 180] (aligns with backend wrap180-style logic for display).
 * Stops 350° vs −10° from splitting violins / means before |·|.
 */
function wrapAngleSigned180Deg(deg: number): number {
  if (!Number.isFinite(deg)) return deg;
  let x = deg % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/** |angle| after wrap — used for TWA/CWA/LWY/AWA calibration magnitudes. */
function calibrationAngleMagnitudeDeg(deg: number): number {
  return Math.abs(wrapAngleSigned180Deg(deg));
}

function getTackFromTwa(twa: number): "port" | "stbd" {
  const w = wrapAngleSigned180Deg(twa);
  return w < 0 ? "port" : "stbd";
}

/** Port/stbd coloring in violins: prefer signed instrument TWA when present (wrapped ±180°). */
function twaSignedForViolinRow(d: Record<string, unknown>, twaFilterField: string): number | null {
  const inst = getVal(d, "Twa_deg");
  if (inst !== null) return wrapAngleSigned180Deg(inst);
  const cor = getVal(d, twaFilterField);
  if (cor !== null) return wrapAngleSigned180Deg(cor);
  return null;
}

/**
 * Wind sectors for calibration tables / violins (matches V2 AWA up/down split in cal_utils).
 * Upwind: |TWA| < 80°. Downwind: |TWA| > 115°. Mid band omitted from these views.
 */
const CALIBRATION_UPWIND_ABS_TWA_MAX = 80;
const CALIBRATION_DOWNWIND_ABS_TWA_MIN = 115;

function isCalibrationUpwindTwa(twa: number): boolean {
  return calibrationAngleMagnitudeDeg(twa) < CALIBRATION_UPWIND_ABS_TWA_MAX;
}

function isCalibrationDownwindTwa(twa: number): boolean {
  return calibrationAngleMagnitudeDeg(twa) > CALIBRATION_DOWNWIND_ABS_TWA_MIN;
}

/** Short filter line reused in legends (plain text; use in JSX with {' '} between spans if needed). */
const CAL_LEGEND_SECTOR =
  `Grade ≥ 2 · upwind |TWA| < ${CALIBRATION_UPWIND_ABS_TWA_MAX}° · downwind |TWA| > ${CALIBRATION_DOWNWIND_ABS_TWA_MIN}°`;

/** Offsets-vs-time uses every loaded row; tables/violins use Grade ≥ 2 + sector (matches AWA training grade floor). */
const CAL_TIMESERIES_GRADES_NOTE =
  "All grades: offset curves use the full calibration dataset (offsets trained on grade ≥ 2 only). AWA Δ: Awa_offset_deg when present, else Awa_n_cor−before; 10 s box smooth; clamp ±5°. LWY Δ: Lwy_offset_norm_deg or AC40_Leeway_n_cor−Lwy_n; 5 min box smooth; clamp ±5°.";

/** Fused-channel before/after row config. */
interface BeforeAfterPairConfig {
  label: string;
  before: string;
  after: string;
  unit?: string;
  /** Mean uses |x| so signed port/stbd geometry does not cancel (AWA/TWA/LWY/CWA). */
  useAbsMean?: boolean;
  beforeScale?: number;
  afterScale?: number;
}

/**
 * Fused before/after row order: BSP first; AWS after AWA; CWA after TWA; then LWY, TWS, TWD.
 * Drives both Before vs After and Port vs Stbd (fused) tables.
 */
const CALIBRATION_BEFORE_AFTER_PAIRS: BeforeAfterPairConfig[] = [
  {
    label: "BSP", before: 'Bsp_kts', after: 'Bsp_kts', unit: "kts", beforeScale: 1, afterScale: 1
  },
  { label: "AWA", before: "Awa_n_deg", after: "Awa_n_cor_deg", unit: "°", useAbsMean: true },
  { label: "AWS", before: "Aws_kts", after: "Aws_cor_kts", unit: "kts" },
  { label: "TWA", before: "Twa_n_deg", after: "Twa_n_cor_deg", unit: "°", useAbsMean: true },
  { label: "CWA", before: "Cwa_n_deg", after: "Cwa_n_cor_deg", unit: "°", useAbsMean: true },
  { label: "LWY", before: "Lwy_n_deg", after: CalParquet.lwyNCorDeg, unit: "°", useAbsMean: true },
  { label: "TWS", before: "Tws_kts", after: "Tws_cor_kts", unit: "kts", beforeScale: 1, afterScale: 1 },
  { label: "TWD", before: "Twd_deg", after: "Twd_cor_deg", unit: "°" },
];

function findCalibrationPairForField(field: string): BeforeAfterPairConfig | undefined {
  const fromStatic = CALIBRATION_BEFORE_AFTER_PAIRS.find((p) => p.before === field || p.after === field);
  if (fromStatic) return fromStatic;
  if (field === "Lwy_n_cor_deg" || field === CalParquet.lwyNCorDeg) {
    return CALIBRATION_BEFORE_AFTER_PAIRS.find((p) => p.label === "LWY");
  }
  if (field === "Cwa_deg") {
    return { label: "CWA", before: "Cwa_deg", after: "Cwa_n_cor_deg", unit: "°", useAbsMean: true };
  }
  if (field === "Awa_n_fused_deg") {
    return { label: "AWA", before: "Awa_n_fused_deg", after: "Awa_n_cor_deg", unit: "°", useAbsMean: true };
  }
  if (field === CalParquet.awsFusedKnots) {
    return { label: "AWS", before: CalParquet.awsFusedKnots, after: CalParquet.awsCorKnots, unit: "kts" };
  }
  return undefined;
}

/** When fused AWA/AWS columns exist, use them as the “before” baseline for fused summary rows. */
function buildEffectiveBeforeAfterPairs(data: Record<string, unknown>[]): BeforeAfterPairConfig[] {
  const awsBefore = awsBeforeFieldForData(data);
  const fusedAws = awsBefore !== CalParquet.awsKnots;
  return CALIBRATION_BEFORE_AFTER_PAIRS.map((p) => {
    if (p.label === "AWA") {
      const nFused = data.filter((d) => getVal(d, "Awa_n_fused_deg") !== null).length;
      const nNorm = data.filter((d) => getVal(d, "Awa_n_deg") !== null).length;
      if (nFused > 0 && nFused >= nNorm) return { ...p, before: "Awa_n_fused_deg" };
      return { ...p, before: "Awa_n_deg" };
    }
    if (p.label === "AWS" && fusedAws) return { ...p, before: awsBefore };
    return { ...p };
  });
}

/**
 * Map a raw channel value to what we average in **Before vs After** tables, port/stbd tables, and angle violins.
 * Boat angles with useAbsMean: wrap to ±180° then |·| (avoids ± wrap duplicates and mixed-sign CWA/TWA outliers).
 * TWS/BSP: scale knots→metric where configured.
 */
function calibrationValueForMean(field: string, raw: number, channelIsBefore: boolean): number {
  const p = findCalibrationPairForField(field);
  if (p) {
    const scale = channelIsBefore ? (p.beforeScale ?? 1) : (p.afterScale ?? 1);
    let x = raw * scale;
    if (p.useAbsMean) x = calibrationAngleMagnitudeDeg(x);
    return x;
  }
  if (
    field === "Awa_deg" ||
    field === "Awa_cor_deg" ||
    field === "Awa_bow_deg" ||
    field === "Awa_bow_cor_deg" ||
    field === "Awa_mhu_deg" ||
    field === "Awa_mhu_cor_deg"
  ) {
    return calibrationAngleMagnitudeDeg(raw);
  }
  return raw;
}

/**
 * TWA for upwind/downwind **sector** bands (|TWA| below 80° vs above 115°). Prefer **instrument** ``Twa_deg``
 * first so classification matches Explore scatter/map; ``Twa_cor_deg`` can sit in the 80–115° band while
 * ``Twa_deg`` is still VMG-upwind, which hid rows when corrected was preferred. Then normalized fallbacks.
 */
function calibrationWindSectorTwaDeg(d: Record<string, unknown>): number | null {
  return (
    getVal(d, "Twa_deg") ??
    getVal(d, "Twa_cor_deg") ??
    getVal(d, "Twa_n_deg") ??
    getVal(d, "Twa_n_cor_deg")
  );
}

/** Rows for calibration summary tables / violins: |TWA| < 80° (upwind) or > 115° (downwind). */
function includeRowForCalibrationSummary(d: Record<string, unknown>, wind: "upwind" | "downwind"): boolean {
  const twa = calibrationWindSectorTwaDeg(d);
  if (twa === null) return false;
  return wind === "upwind" ? isCalibrationUpwindTwa(twa) : isCalibrationDownwindTwa(twa);
}

/** Grade column from calibration rows (same field as ``isCalibrationSummaryGradeRow``). */
function calibrationRowGradeNum(d: Record<string, unknown>): number | null {
  const raw = (d as { Grade?: unknown; grade?: unknown; GRADE?: unknown }).Grade
    ?? (d as { grade?: unknown }).grade
    ?? (d as { GRADE?: unknown }).GRADE;
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Grade ≥ 2 only (strictly &gt; 1). Missing or non-finite Grade excluded.
 * Used for: before→after tables, port–stbd tables, maneuver check sector metrics, TWS/BSP sector violins, angle violins.
 */
function isCalibrationSummaryGradeRow(d: Record<string, unknown>): boolean {
  const g = calibrationRowGradeNum(d);
  if (g === null) return false;
  return g >= 2;
}

/** Console: how many rows pass grade vs TWA bands (spot mismatches vs scatter). */
function logCalibrationTableFilterDebug(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  let gradePass = 0;
  let upwindIfInstrumentTwa = 0;
  let upwindIfCorFirst = 0;
  let upwindSectorFinal = 0;
  for (const d of rows) {
    if (!isCalibrationSummaryGradeRow(d)) continue;
    gradePass++;
    const inst = getVal(d, "Twa_deg");
    if (inst !== null && isCalibrationUpwindTwa(inst)) upwindIfInstrumentTwa++;
    const corFirst =
      getVal(d, "Twa_cor_deg") ?? getVal(d, "Twa_deg") ?? getVal(d, "Twa_n_cor_deg") ?? getVal(d, "Twa_n_deg");
    if (corFirst !== null && isCalibrationUpwindTwa(corFirst)) upwindIfCorFirst++;
    const sector = calibrationWindSectorTwaDeg(d);
    if (sector !== null && isCalibrationUpwindTwa(sector)) upwindSectorFinal++;
  }
  pageReport("[Calibration] Table/violin filters vs row counts", {
    totalRows: rows.length,
    rowsPassingGradeGte2: gradePass,
    ofThose_upwind_ifTwa_degOnly: upwindIfInstrumentTwa,
    ofThose_upwind_ifTwa_corFirstOld: upwindIfCorFirst,
    ofThose_upwind_sectorColumnUsedNow: upwindSectorFinal,
    note: "Rows in 80°≤|TWA|≤115° are in neither upwind nor downwind tables.",
  });
}

export default function CalibrationPage() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [_datasetInfo, setDatasetInfo] = createSignal<DatasetInfo | null>(null);
  const [channelData, setChannelData] = createSignal<Record<string, unknown>[]>([]);
  const [maneuversTack, setManeuversTack] = createSignal<Record<string, unknown>[]>([]);
  const [maneuversGybe, setManeuversGybe] = createSignal<Record<string, unknown>[]>([]);
  const [missingChannels, setMissingChannels] = createSignal<string[]>([]);
  let timeSeriesRef: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;


  function beforeAfterValsForField(
    dataRows: Record<string, unknown>[],
    field: string,
    channelIsBefore: boolean
  ): number[] {
    return dataRows
      .map((d) => getVal(d, field))
      .filter((v): v is number => v !== null)
      .map((v) => calibrationValueForMean(field, v, channelIsBefore));
  }

  function buildBeforeAfterRows(data: Record<string, unknown>[]): BeforeAfterRow[] {
    if (!data.length) return [];
    const pairs = buildEffectiveBeforeAfterPairs(data);
    const rows: BeforeAfterRow[] = [];
    let suppressSignedAwaRow = false;

    for (const pair of pairs) {
      let beforeField = pair.before;
      const { label, after } = pair;
      const afterVals = beforeAfterValsForField(data, after, false);
      let beforeVals = beforeAfterValsForField(data, beforeField, true);

      if (label === "AWA" && beforeVals.length === 0 && afterVals.length > 0) {
        if (beforeField === "Awa_n_fused_deg") {
          beforeField = "Awa_n_deg";
          beforeVals = beforeAfterValsForField(data, beforeField, true);
        }
        if (beforeVals.length === 0 && data.some((d) => getVal(d, "Awa_deg") !== null)) {
          beforeField = "Awa_deg";
          beforeVals = beforeAfterValsForField(data, beforeField, true);
        } else if (beforeVals.length === 0 && data.some((d) => getVal(d, "Awa_bow_deg") !== null)) {
          beforeField = "Awa_bow_deg";
          beforeVals = beforeAfterValsForField(data, beforeField, true);
        } else if (beforeVals.length === 0 && data.some((d) => getVal(d, "Awa_mhu_deg") !== null)) {
          beforeField = "Awa_mhu_deg";
          beforeVals = beforeAfterValsForField(data, beforeField, true);
        }
      }
      if (label === "CWA" && beforeVals.length === 0 && afterVals.length > 0) {
        if (data.some((d) => getVal(d, "Cwa_deg") !== null)) {
          beforeField = "Cwa_deg";
          beforeVals = beforeAfterValsForField(data, beforeField, true);
        }
      }
      if (
        label === "AWA" &&
        (beforeField === "Awa_deg" || beforeField === "Awa_bow_deg" || beforeField === "Awa_mhu_deg")
      ) {
        suppressSignedAwaRow = true;
      }

      if (beforeVals.length === 0 && afterVals.length === 0) continue;

      const meanBefore = beforeVals.length ? d3.mean(beforeVals)! : null;
      const meanAfter = afterVals.length ? d3.mean(afterVals)! : null;
      let deltaMean: number | null = null;
      let pctDiff: number | null = null;
      if (meanBefore !== null && meanAfter !== null) {
        deltaMean = meanAfter - meanBefore;
        const ref =
          Math.abs(meanBefore) > 1e-6 ? meanBefore : Math.abs(meanAfter) > 1e-6 ? meanAfter : 1;
        pctDiff = (100 * deltaMean) / ref;
      }

      rows.push({
        channel: label,
        meanBefore,
        meanAfter,
        deltaMean,
        pctDiff,
        count: Math.max(beforeVals.length, afterVals.length),
      });
    }

    const hasSignedAwaBefore = data.some(
      (d) =>
        getVal(d, "Awa_deg") !== null ||
        getVal(d, "Awa_bow_deg") !== null ||
        getVal(d, "Awa_mhu_deg") !== null
    );
    if (hasSignedAwaBefore && !suppressSignedAwaRow) {
      const beforeKey = data.some((d) => getVal(d, "Awa_deg") !== null)
        ? "Awa_deg"
        : data.some((d) => getVal(d, "Awa_bow_deg") !== null)
          ? "Awa_bow_deg"
          : "Awa_mhu_deg";
      const afterKey = data.some((d) => getVal(d, "Awa_cor_deg") !== null)
        ? "Awa_cor_deg"
        : data.some((d) => getVal(d, "Awa_bow_cor_deg") !== null)
          ? "Awa_bow_cor_deg"
          : "Awa_mhu_cor_deg";
      const beforeVals = beforeAfterValsForField(data, beforeKey, true);
      const afterVals = beforeAfterValsForField(data, afterKey, false);
      if (beforeVals.length || afterVals.length) {
        const meanBefore = beforeVals.length ? d3.mean(beforeVals)! : null;
        const meanAfter = afterVals.length ? d3.mean(afterVals)! : null;
        let deltaMean: number | null = null;
        let pctDiff: number | null = null;
        if (meanBefore !== null && meanAfter !== null) {
          deltaMean = meanAfter - meanBefore;
          const ref =
            Math.abs(meanBefore) > 1e-6 ? meanBefore : Math.abs(meanAfter) > 1e-6 ? meanAfter : 1;
          pctDiff = (100 * deltaMean) / ref;
        }
        rows.push({
          channel: "AWA",
          meanBefore,
          meanAfter,
          deltaMean,
          pctDiff,
          count: Math.max(beforeVals.length, afterVals.length),
        });
      }
    }
    return rows;
  }

  const beforeAfterTableUpwind = createMemo((): BeforeAfterRow[] => {
    const data = channelData();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, "upwind"))
      .filter(isCalibrationSummaryGradeRow);
    return buildBeforeAfterRows(filtered);
  });

  const beforeAfterTableDownwind = createMemo((): BeforeAfterRow[] => {
    const data = channelData();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, "downwind"))
      .filter(isCalibrationSummaryGradeRow);
    return buildBeforeAfterRows(filtered);
  });

  function buildPortStbdRows(data: Record<string, unknown>[], useBefore: boolean = false): PortStbdRow[] {
    if (!data.length) return [];
    const pairs = buildEffectiveBeforeAfterPairs(data);
    const portMask = (d: Record<string, unknown>) => {
      const twa = calibrationWindSectorTwaDeg(d);
      if (twa === null) return false;
      return getTackFromTwa(twa) === "port";
    };
    const stbdMask = (d: Record<string, unknown>) => {
      const twa = calibrationWindSectorTwaDeg(d);
      if (twa === null) return false;
      return getTackFromTwa(twa) === "stbd";
    };
    const rows: PortStbdRow[] = [];

    for (const pair of pairs) {
      let field = useBefore ? pair.before : pair.after;
      const { label } = pair;

      const getTransformedVals = (mask: (d: Record<string, unknown>) => boolean) => {
        return data
          .filter(mask)
          .map((d) => {
            const raw = getVal(d, field);
            if (raw === null) return null;
            return calibrationValueForMean(field, raw, useBefore);
          })
          .filter((v): v is number => v !== null);
      };

      let portVals = getTransformedVals(portMask);
      let stbdVals = getTransformedVals(stbdMask);

      if (useBefore && portVals.length === 0 && stbdVals.length === 0) {
        if (label === "CWA" && data.some((d) => getVal(d, "Cwa_deg") !== null)) {
          field = "Cwa_deg";
          portVals = getTransformedVals(portMask);
          stbdVals = getTransformedVals(stbdMask);
        } else if (label === "AWA") {
          if (field === "Awa_n_fused_deg" && data.some((d) => getVal(d, "Awa_n_deg") !== null)) {
            field = "Awa_n_deg";
          } else if (data.some((d) => getVal(d, "Awa_deg") !== null)) {
            field = "Awa_deg";
          } else if (data.some((d) => getVal(d, "Awa_bow_deg") !== null)) {
            field = "Awa_bow_deg";
          } else if (data.some((d) => getVal(d, "Awa_mhu_deg") !== null)) {
            field = "Awa_mhu_deg";
          }
          if (field !== pair.before) {
            portVals = getTransformedVals(portMask);
            stbdVals = getTransformedVals(stbdMask);
          }
        }
      }

      if (portVals.length === 0 && stbdVals.length === 0) continue;
      const portMean = portVals.length ? d3.mean(portVals)! : null;
      const stbdMean = stbdVals.length ? d3.mean(stbdVals)! : null;
      let diff: number | null = null;
      let pctDiff: number | null = null;
      if (portMean !== null && stbdMean !== null) {
        diff = stbdMean - portMean;
        const ref =
          Math.abs(portMean) > 1e-6 ? portMean : Math.abs(stbdMean) > 1e-6 ? stbdMean : 1;
        pctDiff = (100 * diff) / ref;
      }
      rows.push({
        channel: label,
        portMean,
        stbdMean,
        diff,
        pctDiff,
        count: portVals.length + stbdVals.length,
      });
    }
    return rows;
  }

  const portStbdTableBeforeUpwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, "upwind"))
      .filter(isCalibrationSummaryGradeRow);
    return buildPortStbdRows(filtered, true); // useBefore = true
  });

  const portStbdTableBeforeDownwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, "downwind"))
      .filter(isCalibrationSummaryGradeRow);
    return buildPortStbdRows(filtered, true); // useBefore = true
  });

  const portStbdTableUpwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, "upwind"))
      .filter(isCalibrationSummaryGradeRow);
    return buildPortStbdRows(filtered, false); // useBefore = false (after correction)
  });

  const portStbdTableDownwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, "downwind"))
      .filter(isCalibrationSummaryGradeRow);
    return buildPortStbdRows(filtered, false); // useBefore = false (after correction)
  });

  const cwaVsTackGybeTable = createMemo((): ManeuverAngleRow[] => {
    const data = channelData();
    const tacks = maneuversTack();
    const gybes = maneuversGybe();
    if (!data.length || (!tacks.length && !gybes.length)) return [];

    const rows: ManeuverAngleRow[] = [];

    /** Same grade + |TWA| bands as summary tables (Grade ≥ 2). */
    const getSectorAbsMetrics = (wantUpwind: boolean): { twaVals: number[]; cwaVals: number[]; lwyVals: number[] } => {
      const twaVals: number[] = [];
      const cwaVals: number[] = [];
      const lwyVals: number[] = [];
      let checked = 0;
      let gradeBandCount = 0;
      let windMatchCount = 0;
      for (const d of data) {
        checked++;
        if (!isCalibrationSummaryGradeRow(d)) continue;
        gradeBandCount++;

        const twa = calibrationWindSectorTwaDeg(d);
        if (twa === null) continue;

        if (wantUpwind) {
          if (!isCalibrationUpwindTwa(twa)) continue;
        } else {
          if (!isCalibrationDownwindTwa(twa)) continue;
        }
        windMatchCount++;

        twaVals.push(calibrationAngleMagnitudeDeg(twa));
        const cwa = getVal(d, "Cwa_n_cor_deg") ?? getVal(d, "Cwa_cor_deg");
        if (cwa !== null) cwaVals.push(calibrationAngleMagnitudeDeg(cwa));
        const lwy = getVal(d, CalParquet.lwyNCorDeg) ?? getVal(d, "Lwy_cor_deg");
        if (lwy !== null) lwyVals.push(calibrationAngleMagnitudeDeg(lwy));
      }
      debug("[Calibration] getSectorAbsMetrics", {
        wantUpwind,
        checked,
        gradeBandCount,
        windMatchCount,
        twaValsFound: twaVals.length,
        cwaValsFound: cwaVals.length,
        lwyValsFound: lwyVals.length,
        sampleTwa: twaVals.slice(0, 5),
      });
      return { twaVals, cwaVals, lwyVals };
    };

    // Tacks: maneuver Turn_angle grade > 1; channel means from Grade ≥ 2 rows, |TWA| < 80
    if (tacks.length > 0) {
      // Filter tacks by grade > 1 (check tags.GRADE or direct Grade field)
      const gradeFilteredTacks = tacks.filter((m) => {
        const grade = (m as any).tags?.GRADE ?? (m as any).tags?.Grade ?? (m as any).Grade ?? (m as any).grade ?? (m as any).GRADE;
        const gradeNum = grade !== undefined && grade !== null ? Number(grade) : null;
        return gradeNum !== null && gradeNum > 1;
      });

      if (gradeFilteredTacks.length > 0) {
        // Use Turn_angle_max from maneuver data
        const turnAngles = gradeFilteredTacks
          .map((m) => getVal(m, "Turn_angle_max"))
          .filter((v): v is number => v !== null && v !== undefined);

        const meanTurn = turnAngles.length > 0 ? d3.mean(turnAngles)! : 0;
        const turnRefDeg = turnAngles.length > 0 ? meanTurn / 2 : 0;

        const { twaVals, cwaVals, lwyVals } = getSectorAbsMetrics(true);
        const meanTwaCor = twaVals.length > 0 ? d3.mean(twaVals)! : 0;
        const meanCwaCor = cwaVals.length > 0 ? d3.mean(cwaVals)! : 0;
        const meanLwyCor = lwyVals.length > 0 ? d3.mean(lwyVals)! : 0;
        const cwaVsTwa = meanCwaCor - meanTwaCor;
        const twaVsTurnAng = meanTwaCor - turnRefDeg;

        rows.push({
          eventType: "Tack",
          count: gradeFilteredTacks.length,
          meanTwaCor,
          meanCwaCor,
          meanLwyCor,
          turnRefDeg,
          cwaVsTwa,
          twaVsTurnAng,
        });
      }
    }

    // Gybes: maneuver Turn_angle grade > 1; channel means from Grade ≥ 2 rows, |TWA| > 115
    if (gybes.length > 0) {
      // Filter gybes by grade > 1 (check tags.GRADE or direct Grade field)
      const gradeFilteredGybes = gybes.filter((m) => {
        const grade = (m as any).tags?.GRADE ?? (m as any).tags?.Grade ?? (m as any).Grade ?? (m as any).grade ?? (m as any).GRADE;
        const gradeNum = grade !== undefined && grade !== null ? Number(grade) : null;
        return gradeNum !== null && gradeNum > 1;
      });

      if (gradeFilteredGybes.length > 0) {
        const turnAngles = gradeFilteredGybes
          .map((m) => getVal(m, "Turn_angle_max"))
          .filter((v): v is number => v !== null && v !== undefined);

        const meanTurn = turnAngles.length > 0 ? d3.mean(turnAngles)! : 0;
        const turnRefDeg = turnAngles.length > 0 ? 180 - meanTurn / 2 : 0;

        const { twaVals, cwaVals, lwyVals } = getSectorAbsMetrics(false);
        const meanTwaCor = twaVals.length > 0 ? d3.mean(twaVals)! : 0;
        const meanCwaCor = cwaVals.length > 0 ? d3.mean(cwaVals)! : 0;
        const meanLwyCor = lwyVals.length > 0 ? d3.mean(lwyVals)! : 0;
        const cwaVsTwa = meanCwaCor - meanTwaCor;
        const twaVsTurnAng = meanTwaCor - turnRefDeg;

        rows.push({
          eventType: "Gybe",
          count: gradeFilteredGybes.length,
          meanTwaCor,
          meanCwaCor,
          meanLwyCor,
          turnRefDeg,
          cwaVsTwa,
          twaVsTurnAng,
        });
      }
    }
    return rows;
  });

  /**
   * Combined before/after rows for violins: x-axis shows "Before" and "After", each with port/stbd halves.
   * Wind sector uses per-row `Twa_deg` then `Twa_cor_deg` (same as summary tables) so classification matches Explore.
   * Grade ≥ 2 (same filter as summary tables).
   */
  function buildBeforeAfterViolinData(
    beforeField: string,
    afterField: string,
    windFilter?: "upwind" | "downwind"
  ): { Phase: string; Value: number; Twa_signed: number }[] {
    const data = channelData();
    const out: { Phase: string; Value: number; Twa_signed: number }[] = [];
    for (const d of data) {
      if (!isCalibrationSummaryGradeRow(d)) continue;

      const twa = calibrationWindSectorTwaDeg(d);
      if (twa === null) continue;

      if (windFilter === "upwind" || windFilter === "downwind") {
        if (!includeRowForCalibrationSummary(d, windFilter)) continue;
      } else if (!isCalibrationUpwindTwa(twa) && !isCalibrationDownwindTwa(twa)) {
        continue;
      }

      const signedForViolin = twaSignedForViolinRow(d, "Twa_cor_deg") ?? twa;
      const beforeVal = getVal(d, beforeField);
      const afterVal = getVal(d, afterField);
      if (beforeVal !== null) {
        out.push({
          Phase: "Before",
          Value: calibrationValueForMean(beforeField, beforeVal, true),
          Twa_signed: signedForViolin,
        });
      }
      if (afterVal !== null) {
        out.push({
          Phase: "After",
          Value: calibrationValueForMean(afterField, afterVal, false),
          Twa_signed: signedForViolin,
        });
      }
    }
    return out;
  }

  /**
   * TWS/BSP violins: Upwind (|TWA| < 80°) vs Downwind (|TWA| > 115°), port/stbd from signed TWA.
   * Grade ≥ 2; matches other calibration violins.
   */
  function buildWindSectorTackViolinData(valueField: string): { Sector: "Upwind" | "Downwind"; Value: number; Twa_signed: number }[] {
    const data = channelData();
    const out: { Sector: "Upwind" | "Downwind"; Value: number; Twa_signed: number }[] = [];
    for (const d of data) {
      if (!isCalibrationSummaryGradeRow(d)) continue;

      const twa = calibrationWindSectorTwaDeg(d);
      if (twa === null) continue;

      const val = getVal(d, valueField);
      if (val === null) continue;

      const signedForViolin = twaSignedForViolinRow(d, "Twa_cor_deg") ?? twa;
      if (isCalibrationUpwindTwa(twa)) out.push({ Sector: "Upwind", Value: val, Twa_signed: signedForViolin });
      else if (isCalibrationDownwindTwa(twa)) out.push({ Sector: "Downwind", Value: val, Twa_signed: signedForViolin });
    }
    return out;
  }

  /** AWA before column: fused when present, else normalized raw (matches timeseries Δ fallback). */
  const awaBeforeFieldForViolins = createMemo((): "Awa_n_fused_deg" | "Awa_n_deg" => {
    const data = channelData();
    if (data.some((d) => getVal(d, "Awa_n_fused_deg") !== null)) return "Awa_n_fused_deg";
    return "Awa_n_deg";
  });

  const twsViolinValueField = createMemo((): { field: string; yLabel: string } => {
    const data = channelData();
    const P = CalParquet;
    const L = CalAxisLabel;
    if (!data.length) return { field: P.twsCorKnots, yLabel: L.twsKnots };
    if (data.some((d) => getVal(d, P.twsCorKnots) !== null)) return { field: P.twsCorKnots, yLabel: L.twsKnots };
    if (data.some((d) => getVal(d, P.twsKnots) !== null)) return { field: P.twsKnots, yLabel: L.twsKnots };
    if (data.some((d) => getVal(d, P.twsCorMetric) !== null)) return { field: P.twsCorMetric, yLabel: L.twsMetric };
    return { field: P.twsCorKnots, yLabel: L.twsKnots };
  });

  const bspViolinValueField = createMemo((): { field: string; yLabel: string } => {
    const data = channelData();
    const P = CalParquet;
    const L = CalAxisLabel;
    if (!data.length) return { field: P.bspKnots, yLabel: L.bspKnots };
    if (data.some((d) => getVal(d, P.bspKnots) !== null)) return { field: P.bspKnots, yLabel: L.bspKnots };
    if (data.some((d) => getVal(d, P.bspMetric) !== null)) return { field: P.bspMetric, yLabel: L.bspMetric };
    return { field: P.bspKnots, yLabel: L.bspKnots };
  });

  const violinTwsWindSector = createMemo(() =>
    buildWindSectorTackViolinData(twsViolinValueField().field)
  );
  const violinBspWindSector = createMemo(() =>
    buildWindSectorTackViolinData(bspViolinValueField().field)
  );

  const violinChartTwsWindSector = createMemo(() => ({
    series: [
      {
        xaxis: { name: "Sector" },
        yaxis: { name: twsViolinValueField().yLabel, dataField: "Value" },
        groupField: "Sector",
        originalData: [] as { Sector: string; Value: number; Twa_signed: number }[],
      },
    ],
  }));

  const violinChartBspWindSector = createMemo(() => ({
    series: [
      {
        xaxis: { name: "Sector" },
        yaxis: { name: bspViolinValueField().yLabel, dataField: "Value" },
        groupField: "Sector",
        originalData: [] as { Sector: string; Value: number; Twa_signed: number }[],
      },
    ],
  }));

  const violinChartPhase = {
    series: [
      {
        xaxis: { name: "Before / after" },
        yaxis: { name: "|°| magnitude", dataField: "Value" },
        groupField: "Phase",
        originalData: [] as { Phase: string; Value: number; Twa_signed: number }[],
      },
    ],
  };

  const violinAwaUpwind = createMemo(() =>
    buildBeforeAfterViolinData(awaBeforeFieldForViolins(), "Awa_n_cor_deg", "upwind")
  );
  const violinAwaDownwind = createMemo(() =>
    buildBeforeAfterViolinData(awaBeforeFieldForViolins(), "Awa_n_cor_deg", "downwind")
  );
  const violinTwaUpwind = createMemo(() => buildBeforeAfterViolinData("Twa_n_deg", "Twa_n_cor_deg", "upwind"));
  const violinTwaDownwind = createMemo(() => buildBeforeAfterViolinData("Twa_n_deg", "Twa_n_cor_deg", "downwind"));
  const violinLwyUpwind = createMemo(() =>
    buildBeforeAfterViolinData("Lwy_n_deg", CalParquet.lwyNCorDeg, "upwind")
  );
  const violinLwyDownwind = createMemo(() =>
    buildBeforeAfterViolinData("Lwy_n_deg", CalParquet.lwyNCorDeg, "downwind")
  );
  const violinCwaUpwind = createMemo(() => buildBeforeAfterViolinData("Cwa_n_deg", "Cwa_n_cor_deg", "upwind"));
  const violinCwaDownwind = createMemo(() => buildBeforeAfterViolinData("Cwa_n_deg", "Cwa_n_cor_deg", "downwind"));

  function drawTimeSeries() {
    try {
      const data = channelData();
      const el = timeSeriesRef;
      debug("[Calibration] drawTimeSeries called", {
        hasEl: !!el,
        dataLength: data.length,
        elWidth: el?.clientWidth,
        elHeight: el?.clientHeight
      });
      if (!el || !data.length) {
        debug("[Calibration] drawTimeSeries early return", { hasEl: !!el, dataLength: data.length });
        return;
      }

      // Full timeline: backend applies corrections to all grades; no grade filter on this chart.
      const filteredData = data;

      const getTs = (d: Record<string, unknown>): number => {
        const v = getVal(d, "ts");
        if (v !== null) return v;
        const dt = (d as any).Datetime ?? (d as any).datetime;
        if (typeof dt === "string") return new Date(dt).getTime() / 1000;
        if (dt instanceof Date) return dt.getTime() / 1000;
        return 0;
      };
      const sorted = [...filteredData].sort((a, b) => getTs(a) - getTs(b));
      const ts = sorted.map(getTs);

      // AWA Δ: ``Awa_offset_deg`` from pipeline; else Awa_n_cor − before (Awa_n_fused or Awa_n).
      const awaBeforeField = sorted.some((d) => getVal(d, "Awa_n_fused_deg") !== null) ? "Awa_n_fused_deg" : "Awa_n_deg";
      const awaOffsetRaw = sorted.map((d) => {
        const recorded = getVal(d, "Awa_offset_deg");
        if (recorded !== null) {
          return clampCalibrationOffsetDisplayDeg(recorded);
        }
        const before = getVal(d, awaBeforeField);
        const after = getVal(d, "Awa_n_cor_deg");
        if (before === null || after === null) return NaN;
        return clampCalibrationOffsetDisplayDeg(after - before);
      });

      // LWY Δ: Lwy_offset_norm_deg from pipeline, or AC40_Leeway_n_cor − Lwy_n (same sign convention as stored columns).
      const lwyOffsetRaw = sorted.map((d) => {
        const directNorm = getVal(d, "Lwy_offset_norm_deg");
        if (directNorm !== null) {
          return clampCalibrationOffsetDisplayDeg(directNorm);
        }
        const before = getVal(d, "Lwy_n_deg");
        const after = getVal(d, CalParquet.lwyNCorDeg);
        if (before === null || after === null) return NaN;
        return clampCalibrationOffsetDisplayDeg(after - before);
      });

      const awaOffset = smoothOffsetsByTimeSec(ts, awaOffsetRaw, CAL_OFFSET_TIMESERIES_SMOOTH_WIDTH_SEC / 2);
      const lwyOffset = smoothOffsetsByTimeSec(ts, lwyOffsetRaw, CAL_LWY_OFFSET_TIMESERIES_SMOOTH_WIDTH_SEC / 2);

      // Check if we have valid data
      const validTs = ts.filter((t) => !Number.isNaN(t) && t > 0);
      const validAwaOffset = awaOffset.filter(Number.isFinite);
      const validLwyOffset = lwyOffset.filter(Number.isFinite);

      // Add debug logging
      debug("[Calibration] Time series data", {
        totalData: data.length,
        filteredData: filteredData.length,
        validTs: validTs.length,
        validAwaOffset: validAwaOffset.length,
        validLwyOffset: validLwyOffset.length,
      });

      if (validTs.length === 0 || (validAwaOffset.length === 0 && validLwyOffset.length === 0)) {
        d3.select(el).selectAll("*").remove();
        // Add visual feedback when no data is available
        const svg = d3.select(el).append("svg").attr("width", 400).attr("height", 220);
        const textColor = "#888";
        svg
          .append("text")
          .attr("x", 200)
          .attr("y", 110)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle")
          .attr("fill", textColor)
          .attr("font-size", "14px")
          .text("No valid data available for time series plot");
        return;
      }

      const tsMin = Math.min(...validTs);
      const tsMax = Math.max(...validTs);

      const yEmptyFallback: [number, number] = [-1, 1];
      const [awaYMin, awaYMax] = calibrationOffsetChartYDomain(awaOffset, yEmptyFallback);
      const [lwyYMin, lwyYMax] = calibrationOffsetChartYDomain(lwyOffset, yEmptyFallback);

      d3.select(el).selectAll("*").remove();
      // Use container width if available, otherwise use fallback
      // If container width is 0, use fallback and it will resize on next render
      const containerWidth = el.clientWidth || el.offsetWidth || el.parentElement?.clientWidth || 500;
      const width = Math.max(400, containerWidth);
      const height = 220;
      const margin = { top: 12, right: 42, bottom: 24, left: 42 };

      // Convert timestamps (seconds) to Date objects (milliseconds) for time scale
      const timeMin = new Date(tsMin * 1000);
      const timeMax = new Date(tsMax * 1000);
      const xScale = d3.scaleTime().domain([timeMin, timeMax]).range([margin.left, width - margin.right]);

      // Create separate y-scales for AWA (left) and Lwy (right)
      const yScaleAwa = d3.scaleLinear().domain([awaYMin, awaYMax]).range([height - margin.bottom, margin.top]);
      const yScaleLwy = d3.scaleLinear().domain([lwyYMin, lwyYMax]).range([height - margin.bottom, margin.top]);

      const svg = d3
        .select(el)
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("display", "block")
        .style("background", "transparent");

      // Create line generators for AWA and Lwy with separate y-scales
      const lineAwa = d3.line<number>()
        .x((_, i) => xScale(new Date(ts[i] * 1000))) // Convert timestamp (seconds) to Date (milliseconds)
        .y((d) => yScaleAwa(d))
        .defined((d, i) => {
          // Check if value is valid
          if (!Number.isFinite(d) || Number.isNaN(d)) {
            return false;
          }
          // Check time gap: if this is not the first point, check gap from previous point
          if (i > 0) {
            const timeGap = ts[i] - ts[i - 1];
            if (timeGap > 300) { // 10 minutes = 300 seconds
              return false; // Hide this point if gap > 5 minutes
            }
          }
          return true;
        });

      const lineLwy = d3.line<number>()
        .x((_, i) => xScale(new Date(ts[i] * 1000))) // Convert timestamp (seconds) to Date (milliseconds)
        .y((d) => yScaleLwy(d))
        .defined((d, i) => {
          // Check if value is valid
          if (!Number.isFinite(d) || Number.isNaN(d)) {
            return false;
          }
          // Check time gap: if this is not the first point, check gap from previous point
          if (i > 0) {
            const timeGap = ts[i] - ts[i - 1];
            if (timeGap > 300) { // 10 minutes = 300 seconds
              return false; // Hide this point if gap > 5 minutes
            }
          }
          return true;
        });

      debug("[Calibration] Drawing paths", {
        validAwaOffset: validAwaOffset.length,
        validLwyOffset: validLwyOffset.length,
        width,
        height,
        tsRange: [tsMin, tsMax],
        awaYRange: [awaYMin, awaYMax],
        lwyYRange: [lwyYMin, lwyYMax]
      });

      if (validAwaOffset.length > 0) {
        const pathData = lineAwa(awaOffset);
        debug("[Calibration] AWA offset path", { pathData: pathData?.substring(0, 100) });
        svg
          .append("path")
          .datum(awaOffset)
          .attr("fill", "none")
          .attr("stroke", "#eab308")
          .attr("stroke-width", 1.2)
          .attr("d", lineAwa as any);
      }
      if (validLwyOffset.length > 0) {
        const pathData = lineLwy(lwyOffset);
        debug("[Calibration] Lwy offset path", { pathData: pathData?.substring(0, 100) });
        svg
          .append("path")
          .datum(lwyOffset)
          .attr("fill", "none")
          .attr("stroke", "#7dd3fc")
          .attr("stroke-width", 1.2)
          .attr("d", lineLwy as any);
      }

      // Format x-axis labels as local time (HH:MM:SS)
      const xAxis = d3.axisBottom(xScale)
        .ticks(6)
        .tickFormat((d) => {
          if (d instanceof Date) {
            return d3.timeFormat("%H:%M:%S")(d);
          }
          return String(d);
        });

      // Left y-axis for AWA offset
      const yAxisAwa = d3.axisLeft(yScaleAwa).ticks(6);
      svg.append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(yAxisAwa)
        .append("text")
        .attr("transform", "translate(-10, 95) rotate(-90)")
        .attr("y", 6)
        .attr("dy", "-2.5em")
        .attr("dx", "-1em")
        .style("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("fill", "#eab308")
        .text("AWA Δ °");

      // Right y-axis for Lwy offset
      const yAxisLwy = d3.axisRight(yScaleLwy).ticks(6);
      svg.append("g")
        .attr("transform", `translate(${width - margin.right},0)`)
        .call(yAxisLwy)
        .append("text")
        .attr("transform", "translate(20, 115) rotate(-90)")
        .attr("y", -6)
        .attr("dy", "2.5em")
        .attr("dx", "1em")
        .style("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("fill", "#7dd3fc")
        .text("LWY Δ °");

      // X-axis at bottom
      svg.append("g")
        .attr("transform", `translate(0,${height - margin.bottom})`)
        .call(xAxis);

      // Add zero reference lines for both scales
      if (awaYMin < 0 && awaYMax > 0) {
        svg
          .append("line")
          .attr("x1", margin.left)
          .attr("x2", width - margin.right)
          .attr("y1", yScaleAwa(0))
          .attr("y2", yScaleAwa(0))
          .attr("stroke", "#eab308")
          .attr("stroke-width", 0.5)
          .attr("stroke-dasharray", "2,2")
          .attr("opacity", 0.3);
      }
      if (lwyYMin < 0 && lwyYMax > 0) {
        svg
          .append("line")
          .attr("x1", margin.left)
          .attr("x2", width - margin.right)
          .attr("y1", yScaleLwy(0))
          .attr("y2", yScaleLwy(0))
          .attr("stroke", "#7dd3fc")
          .attr("stroke-width", 0.5)
          .attr("stroke-dasharray", "2,2")
          .attr("opacity", 0.3);
      }

      // Legend
      if (validAwaOffset.length > 0) {
        svg.append("text")
          .attr("x", margin.left + 10)
          .attr("y", margin.top + 8)
          .attr("font-size", "10px")
          .attr("fill", "#eab308")
          .text("AWA Δ");
      }
      if (validLwyOffset.length > 0) {
        svg.append("text")
          .attr("x", margin.left + 10)
          .attr("y", margin.top + 20)
          .attr("font-size", "10px")
          .attr("fill", "#7dd3fc")
          .text("LWY Δ");
      }
    } catch (e) {
      logError("[Calibration] Error drawing time series", e);
    }
  }

  createEffect(() => {
    try {
      const data = channelData();
      // Access timeSeriesRef directly - it's a ref that gets set when the element mounts
      const el = timeSeriesRef;

      debug("[Calibration] Time series effect triggered", {
        hasEl: !!el,
        dataLength: data.length,
        elWidth: el?.clientWidth
      });

      // Draw immediately if we have data and container
      if (el && data.length) {
        // Use a small delay to ensure the container is fully rendered
        const timeoutId = setTimeout(() => {
          debug("[Calibration] Time series timeout fired, calling drawTimeSeries");
          drawTimeSeries();
        }, 100);
        return () => clearTimeout(timeoutId);
      } else if (el && data.length === 0) {
        // Clear the container if we have no data
        debug("[Calibration] No data, clearing container");
        d3.select(el).selectAll("*").remove();
      } else {
        debug("[Calibration] Effect conditions not met", { hasEl: !!el, dataLength: data.length });
      }
      return undefined;
    } catch (e) {
      logError("[Calibration] Error in time series effect", e);
      return undefined;
    }
  });

  // Set up ResizeObserver once when container is available
  createEffect(() => {
    try {
      const el = timeSeriesRef;
      if (el && !resizeObserver) {
        resizeObserver = new ResizeObserver(() => {
          // Redraw when container size changes
          try {
            drawTimeSeries();
          } catch (e) {
            logError("[Calibration] Error in ResizeObserver callback", e);
          }
        });
        resizeObserver.observe(el);
      }
    } catch (e) {
      logError("[Calibration] Error setting up ResizeObserver", e);
    }
  });

  onCleanup(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  });

  onMount(() => {
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: "Calibration",
      scaleToWidth: true,
      onScale: () => {
        if (channelData().length) {
          requestAnimationFrame(() => drawTimeSeries());
        }
      },
    });
    onCleanup(cleanupScaling);
  });

  /**
   * Channel-values resolves files by `source_name` + calendar `date` (YYYYMMDD), not by dataset_id.
   * Always use the dataset row's `source_name` from `/datasets/info` — not `selectedSourceName()`,
   * or another boat's parquet can be loaded for the same date. Refetch when dataset/project/class changes.
   */
  createEffect(() => {
    const datasetId = selectedDatasetId();
    const projectId = selectedProjectId();
    const className = selectedClassName();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    onCleanup(() => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (typeof window !== "undefined") {
        delete (window as unknown as { __calibrationChannelData?: unknown }).__calibrationChannelData;
      }
    });

    if (!datasetId || !projectId || !className) {
      setError("No dataset or project selected.");
      setLoading(false);
      setChannelData([]);
      setManeuversTack([]);
      setManeuversGybe([]);
      setMissingChannels([]);
      return;
    }

    setLoading(true);
    setError(null);

    timeoutId = setTimeout(() => {
      if (cancelled) return;
      logError("[Calibration] Loading timeout - forcing loading to false");
      setLoading(false);
      setError("Loading timed out. Please refresh the page.");
      timeoutId = null;
    }, 30000);

    void (async () => {
      try {
        await logPageLoad("Calibration.tsx", "Calibration");

        const infoUrl = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`;
        const infoRes = await getData(infoUrl);
        if (cancelled) return;

        if (!infoRes?.success || !infoRes?.data) {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setError("Failed to load dataset info.");
          setLoading(false);
          return;
        }

        const di = infoRes.data as Record<string, unknown>;
        const date = di.date;
        const rawSn = di.source_name ?? di.Source_name;
        const datasetSourceName =
          typeof rawSn === "string" && rawSn.trim() ? rawSn.trim() : "";
        const timezone = di.timezone as string | undefined;

        if (!datasetSourceName) {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setError("Dataset has no source; cannot load calibration files.");
          setLoading(false);
          return;
        }

        setDatasetInfo({
          date: String(date ?? ""),
          source_name: datasetSourceName,
          timezone,
        });

        const formattedDateStr = String(date ?? "").replace(/-/g, "");

        if (!sourcesStore.isReady()) {
          let w = 0;
          while (!sourcesStore.isReady() && w < 50 && !cancelled) {
            await new Promise((r) => setTimeout(r, 100));
            w++;
          }
        }
        if (cancelled) return;

        let effectiveSourceId = sourcesStore.getSourceId(datasetSourceName);
        if (effectiveSourceId == null || effectiveSourceId === 0) {
          const fallback = selectedSourceId();
          warn("[Calibration] sourcesStore missing source_id for dataset source; falling back to selectedSourceId", {
            datasetSourceName,
            fallbackId: fallback,
          });
          effectiveSourceId = fallback != null && fallback !== 0 ? fallback : 0;
        }
        if (!effectiveSourceId) {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setError("Could not resolve source id for this dataset.");
          setLoading(false);
          return;
        }

        debug("[Calibration] Channel-values context (dataset boat + date)", {
          datasetId,
          datasetSourceName,
          effectiveSourceId,
          formattedDateStr,
        });

        // Omit resolution: unifiedDataAPI defaults to 1s — fast enough for the 30s UI timeout. RAW (null) can take
        // minutes on full days and was causing spurious timeouts; violins/tables still get diverse wind sectors at 1 Hz.
        const data = await unifiedDataStore.fetchDataWithChannelChecking(
          "ts",
          className,
          String(effectiveSourceId),
          CALIBRATION_CHANNELS,
          {
            projectId: projectId.toString(),
            className,
            datasetId: datasetId.toString(),
            sourceName: datasetSourceName,
            date: formattedDateStr,
            timezone: timezone || undefined,
            applyGlobalFilters: false,
            use_v2: true,
            skipTimeRangeFilter: true,
          },
          "timeseries"
        );
        if (cancelled) return;

        const rawArr = Array.isArray(data) ? data : [];
        const arr = normalizeCalibrationChannelRows(rawArr);
        setError(null);
        setChannelData(arr);
        logCalibrationFetchOutput(arr);
        logCalibrationTableFilterDebug(arr);
        debug("[Calibration] Channel data loaded", { rows: arr.length });

        const missing = unifiedDataStore.getLastMissingChannels("ts");
        setMissingChannels(missing?.length ? missing : []);

        const tackUrl = `${apiEndpoints.app.data}/maneuvers-table-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=TACK&channels=${encodeURIComponent(JSON.stringify(MANEUVERS_ANGLE_CHANNELS))}`;
        const gybeUrl = `${apiEndpoints.app.data}/maneuvers-table-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=GYBE&channels=${encodeURIComponent(JSON.stringify(MANEUVERS_ANGLE_CHANNELS))}`;

        const [tackRes, gybeRes] = await Promise.all([getData(tackUrl), getData(gybeUrl)]);
        if (cancelled) return;

        if (tackRes?.success && Array.isArray(tackRes.data)) setManeuversTack(tackRes.data);
        else setManeuversTack([]);
        if (gybeRes?.success && Array.isArray(gybeRes.data)) setManeuversGybe(gybeRes.data);
        else setManeuversGybe([]);
      } catch (e) {
        if (!cancelled) {
          logError("[Calibration] Load error", e);
          setError(e instanceof Error ? e.message : "Failed to load calibration data.");
        }
      } finally {
        if (!cancelled) {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          setLoading(false);
          debug("[Calibration] Loading complete");
        }
      }
    })();
  });

  return (
    <div id="media-container" class="calibration-page">
      <Show when={loading()}>
        <Loading message="Loading…" />
      </Show>
      <Show when={!loading() && error()}>
        <div class="calibration-error">
          <p>{error()}</p>
        </div>
      </Show>
      <Show when={!loading() && !error()}>
        <section class="calibration-summary">
          <h1 class="calibration-title">Calibration</h1>
          <Show when={missingChannels().length > 0}>
            <p class="calibration-missing">Missing: {missingChannels().join(", ")}</p>
          </Show>
        </section>

        <section class="calibration-tables">
          <h3>Before → after</h3>
          <div class="calibration-tables-split">
            <div class="calibration-table-block">
              <h4 class="calibration-table-block-title">Upwind</h4>
              <table class="calibration-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Δ</th>
                    <th>%</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={beforeAfterTableUpwind()}>
                    {(row) => (
                      <tr>
                        <td>{row.channel}</td>
                        <td>{formatCalibrationTableMean(row.meanBefore)}</td>
                        <td>{formatCalibrationTableMean(row.meanAfter)}</td>
                        <td class={calibrationDeltaCellClass(row.deltaMean)}>{formatCalibrationTableMean(row.deltaMean)}</td>
                        <td class={calibrationDeltaCellClass(row.pctDiff)}>{formatCalibrationTablePct(row.pctDiff)}</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <div class="calibration-table-block">
              <h4 class="calibration-table-block-title">Downwind</h4>
              <table class="calibration-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Δ</th>
                    <th>%</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={beforeAfterTableDownwind()}>
                    {(row) => (
                      <tr>
                        <td>{row.channel}</td>
                        <td>{formatCalibrationTableMean(row.meanBefore)}</td>
                        <td>{formatCalibrationTableMean(row.meanAfter)}</td>
                        <td class={calibrationDeltaCellClass(row.deltaMean)}>{formatCalibrationTableMean(row.deltaMean)}</td>
                        <td class={calibrationDeltaCellClass(row.pctDiff)}>{formatCalibrationTablePct(row.pctDiff)}</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
          <p class="calibration-legend calibration-legend-right">
            <strong>Filter:</strong> {CAL_LEGEND_SECTOR}. Tack from signed TWA (port &lt; 0).
          </p>

          <h3>Port–stbd · before</h3>
          <div class="calibration-tables-split">
            <div class="calibration-table-block">
              <h4 class="calibration-table-block-title">Upwind</h4>
              <table class="calibration-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Port</th>
                    <th>Stbd</th>
                    <th>Δ S−P</th>
                    <th>%</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={portStbdTableBeforeUpwind()}>
                    {(row) => (
                      <tr>
                        <td>{row.channel}</td>
                        <td class="calibration-port-value">{formatCalibrationTableMean(row.portMean)}</td>
                        <td class="calibration-stbd-value">{formatCalibrationTableMean(row.stbdMean)}</td>
                        <td class={calibrationDeltaCellClass(row.diff)}>{formatCalibrationTableMean(row.diff)}</td>
                        <td class={calibrationDeltaCellClass(row.pctDiff)}>{formatCalibrationTablePct(row.pctDiff)}</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <div class="calibration-table-block">
              <h4 class="calibration-table-block-title">Downwind</h4>
              <table class="calibration-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Port</th>
                    <th>Stbd</th>
                    <th>Δ S−P</th>
                    <th>%</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={portStbdTableBeforeDownwind()}>
                    {(row) => (
                      <tr>
                        <td>{row.channel}</td>
                        <td class="calibration-port-value">{formatCalibrationTableMean(row.portMean)}</td>
                        <td class="calibration-stbd-value">{formatCalibrationTableMean(row.stbdMean)}</td>
                        <td class={calibrationDeltaCellClass(row.diff)}>{formatCalibrationTableMean(row.diff)}</td>
                        <td class={calibrationDeltaCellClass(row.pctDiff)}>{formatCalibrationTablePct(row.pctDiff)}</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>

          <h3>Port–stbd · after</h3>
          <div class="calibration-tables-split">
            <div class="calibration-table-block">
              <h4 class="calibration-table-block-title">Upwind</h4>
              <table class="calibration-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Port</th>
                    <th>Stbd</th>
                    <th>Δ S−P</th>
                    <th>%</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={portStbdTableUpwind()}>
                    {(row) => (
                      <tr>
                        <td>{row.channel}</td>
                        <td class="calibration-port-value">{formatCalibrationTableMean(row.portMean)}</td>
                        <td class="calibration-stbd-value">{formatCalibrationTableMean(row.stbdMean)}</td>
                        <td class={calibrationDeltaCellClass(row.diff)}>{formatCalibrationTableMean(row.diff)}</td>
                        <td class={calibrationDeltaCellClass(row.pctDiff)}>{formatCalibrationTablePct(row.pctDiff)}</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <div class="calibration-table-block">
              <h4 class="calibration-table-block-title">Downwind</h4>
              <table class="calibration-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Port</th>
                    <th>Stbd</th>
                    <th>Δ S−P</th>
                    <th>%</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={portStbdTableDownwind()}>
                    {(row) => (
                      <tr>
                        <td>{row.channel}</td>
                        <td class="calibration-port-value">{formatCalibrationTableMean(row.portMean)}</td>
                        <td class="calibration-stbd-value">{formatCalibrationTableMean(row.stbdMean)}</td>
                        <td class={calibrationDeltaCellClass(row.diff)}>{formatCalibrationTableMean(row.diff)}</td>
                        <td class={calibrationDeltaCellClass(row.pctDiff)}>{formatCalibrationTablePct(row.pctDiff)}</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
          <p class="calibration-legend calibration-legend-right">
            <strong>Port–stbd:</strong> {CAL_LEGEND_SECTOR}. Tack from signed TWA: <code>Twa_cor_deg</code> when present, else <code>Twa_deg</code>. Aligns with tack violins, not the aggregated before→after table.
          </p>
        </section>

        <section class="calibration-time">
          <h3>Offsets vs time</h3>
          <p class="calibration-legend">{CAL_TIMESERIES_GRADES_NOTE}</p>
          <div
            class="calibration-timeseries-chart"
            ref={(el) => {
              timeSeriesRef = el;
              if (el) {
                debug("[Calibration] Time series container mounted", {
                  hasData: channelData().length > 0,
                  width: el.clientWidth,
                  height: el.clientHeight
                });
                // Trigger a draw attempt after a short delay to ensure DOM is ready
                setTimeout(() => {
                  if (channelData().length > 0) {
                    debug("[Calibration] Triggering draw from ref callback");
                    drawTimeSeries();
                  }
                }, 200);
              }
            }}
          />
        </section>

        <section class="calibration-violins">
          <h3>TWS & BSP by sector</h3>
          <p class="calibration-legend">
            {CAL_LEGEND_SECTOR}. {CAL_VIOLIN_UNITS_NOTE}
          </p>
          <div class="calibration-violin-metric-row">
            <div class="calibration-violin-split">
              <div class="calibration-violin-cell">
                <h4 class="calibration-violin-metric-title">TWS</h4>
                <div class="violin-container">
                  <Violin
                    chart={violinChartTwsWindSector()}
                    data={violinTwsWindSector()}
                    twaField="Twa_signed"
                    portColor="#c00"
                    stbdColor="#2ca02c"
                  />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h4 class="calibration-violin-metric-title">BSP</h4>
                <div class="violin-container">
                  <Violin
                    chart={violinChartBspWindSector()}
                    data={violinBspWindSector()}
                    twaField="Twa_signed"
                    portColor="#c00"
                    stbdColor="#2ca02c"
                  />
                </div>
              </div>
            </div>
          </div>

          <h3>Before / after · by sector</h3>
          <p class="calibration-legend">
            {CAL_LEGEND_SECTOR}. Upwind left, downwind right; before vs after × tack half.
          </p>
          <div class="calibration-violin-metric-row">
            <h4 class="calibration-violin-metric-title">AWA · before → corrected</h4>
            <div class="calibration-violin-split">
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Upwind</h5>
                <div class="violin-container">
                  <Violin chart={violinChartPhase} data={violinAwaUpwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Downwind</h5>
                <div class="violin-container">
                  <Violin chart={violinChartPhase} data={violinAwaDownwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
                </div>
              </div>
            </div>
          </div>
          <div class="calibration-violin-metric-row">
            <h4 class="calibration-violin-metric-title">LWY · before → after</h4>
            <div class="calibration-violin-split">
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Upwind</h5>
                <div class="violin-container">
                  <Violin chart={violinChartPhase} data={violinLwyUpwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Downwind</h5>
                <div class="violin-container">
                  <Violin chart={violinChartPhase} data={violinLwyDownwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
                </div>
              </div>
            </div>
          </div>
          <div class="calibration-violin-metric-row">
            <h4 class="calibration-violin-metric-title">TWA · before → after</h4>
            <div class="calibration-violin-split">
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Upwind</h5>
                <div class="violin-container">
                  <Violin
                    chart={violinChartPhase}
                    data={violinTwaUpwind()}
                    twaField="Twa_signed"
                    portColor="#c00"
                    stbdColor="#2ca02c"
                    yPaddingFraction={CAL_VIOLIN_TWA_CWA_YPAD}
                    yNice={false}
                    yClampMinZero
                  />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Downwind</h5>
                <div class="violin-container">
                  <Violin
                    chart={violinChartPhase}
                    data={violinTwaDownwind()}
                    twaField="Twa_signed"
                    portColor="#c00"
                    stbdColor="#2ca02c"
                    yPaddingFraction={CAL_VIOLIN_TWA_CWA_YPAD}
                    yNice={false}
                    yClampMinZero
                  />
                </div>
              </div>
            </div>
          </div>
          <div class="calibration-violin-metric-row">
            <h4 class="calibration-violin-metric-title">CWA · before → after</h4>
            <div class="calibration-violin-split">
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Upwind</h5>
                <div class="violin-container">
                  <Violin
                    chart={violinChartPhase}
                    data={violinCwaUpwind()}
                    twaField="Twa_signed"
                    portColor="#c00"
                    stbdColor="#2ca02c"
                    yPaddingFraction={CAL_VIOLIN_TWA_CWA_YPAD}
                    yNice={false}
                    yClampMinZero
                  />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Downwind</h5>
                <div class="violin-container">
                  <Violin
                    chart={violinChartPhase}
                    data={violinCwaDownwind()}
                    twaField="Twa_signed"
                    portColor="#c00"
                    stbdColor="#2ca02c"
                    yPaddingFraction={CAL_VIOLIN_TWA_CWA_YPAD}
                    yNice={false}
                    yClampMinZero
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="calibration-cwa">
          <h3>Maneuver check</h3>
          <p class="calibration-legend">
            {CAL_LEGEND_SECTOR}. Row means |TWA|, |CWA|, |LWY| (<code>_cor</code>, else raw). <strong>Tack</strong> turn = mean(Turn_angle_max) / 2. <strong>Gybe</strong> turn = 180° − mean(Turn_angle_max) / 2. <strong>Δ T−trn</strong> = mean |TWA| − Turn ° (heading-based reference).
          </p>
          <table class="calibration-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>n</th>
                <th>TWA °</th>
                <th>CWA °</th>
                <th>Turn °</th>
                <th>LWY °</th>
                <th>Δ C−T</th>
                <th>Δ T−trn</th>
              </tr>
            </thead>
            <tbody>
              <For each={cwaVsTackGybeTable()}>
                {(row) => {
                  const deltaClass = (v: number) =>
                    v > 0 ? "calibration-delta-positive" : v < 0 ? "calibration-delta-negative" : "";
                  return (
                    <tr>
                      <td>{row.eventType.toUpperCase()}</td>
                      <td>{row.count}</td>
                      <td>{row.meanTwaCor.toFixed(2)}</td>
                      <td>{row.meanCwaCor.toFixed(2)}</td>
                      <td>{row.turnRefDeg.toFixed(2)}</td>
                      <td>{row.meanLwyCor.toFixed(2)}</td>
                      <td class={deltaClass(row.cwaVsTwa)}>{row.cwaVsTwa.toFixed(2)}</td>
                      <td class={deltaClass(row.twaVsTurnAng)}>{row.twaVsTurnAng.toFixed(2)}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </section>
      </Show>
    </div>
  );
}
