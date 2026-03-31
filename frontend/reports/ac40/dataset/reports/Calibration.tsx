import { createSignal, onMount, onCleanup, Show, For, createMemo, createEffect } from "solid-js";
import * as d3 from "d3";

import { getData, setupMediaContainerScaling } from "../../../../utils/global";
import { persistantStore } from "../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { debug, error as logError } from "../../../../utils/console";
import { logPageLoad } from "../../../../utils/logging";
import Loading from "../../../../components/utilities/Loading";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { resolveDataField } from "../../../../utils/colorScale";
import Violin from "../../../../components/charts/Violin";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName } = persistantStore;

/** Max magnitude (deg) for offset-vs-time curves: matches backend MAX_AWA_LWY_CALIBRATION_OFFSET_DEG. */
const CAL_OFFSET_DISPLAY_CLAMP_DEG = 5;

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

/** Channels: before = normalized + corrections pre-cal fusion (Awa_n_fused_deg, Aws_fused_norm_kph). After = _cor. Lwy_offset_norm_deg = propagated leeway offset (normalized deg). Awa_offset_deg = pipeline-recorded AWA correction (clamped server-side). AWS has no offset column. */
const CALIBRATION_CHANNELS = [
  "ts",
  "Datetime",
  "Awa_offset_deg",
  "Awa_n_deg",
  "Awa_n_fused_deg",
  "Awa_n_cor_deg",
  "Twa_n_deg",
  "Twa_n_cor_deg",
  "Lwy_n_deg",
  "Lwy_n_cor_deg",
  "Lwy_offset_norm_deg",
  "Cwa_n_deg",
  "Cwa_n_cor_deg",
  "Awa_bow_deg",
  "Awa_bow_cor_deg",
  "Awa_mhu_deg",
  "Awa_mhu_cor_deg",
  "Twa_deg",
  "Twa_cor_deg",
  "Tws_kts",
  "Tws_cor_kph",
  "Aws_kph",
  "Aws_fused_norm_kph",
  "Aws_fused_kph",
  "Aws_cor_kph",
  "Bsp_kph",
  "Bsp_kts",
  "Twd_deg",
  "Twd_cor_deg",
  "Race_number",
  "Leg_number",
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
  sensor: string;
  meanBefore: number;
  meanAfter: number;
  deltaMean: number;
  pctDiff: number;
  count: number;
}

interface PortStbdRow {
  channel: string;
  sensor: string;
  portMean: number;
  stbdMean: number;
  diff: number;
  pctDiff: number;
  count: number;
}

interface ManeuverAngleRow {
  eventType: string;
  count: number;
  /** Mean |Twa_cor| (fallback Twa_deg); grades 2–3; |TWA| &lt; 80 upwind, &gt; 115 downwind. */
  meanTwaCor: number;
  /** Mean |Cwa_n_cor_deg| where present; same row filter. */
  meanCwaCor: number;
  /** Mean |Lwy_n_cor_deg| where present; same row filter. */
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

function getTackFromTwa(twa: number): "port" | "stbd" {
  return twa < 0 ? "port" : "stbd";
}

/**
 * Wind sectors for calibration tables / violins (matches V2 AWA up/down split in cal_utils).
 * Upwind: |TWA| < 80°. Downwind: |TWA| > 115°. Mid band omitted from these views.
 */
const CALIBRATION_UPWIND_ABS_TWA_MAX = 80;
const CALIBRATION_DOWNWIND_ABS_TWA_MIN = 115;

function isCalibrationUpwindTwa(twa: number): boolean {
  return Math.abs(twa) < CALIBRATION_UPWIND_ABS_TWA_MAX;
}

function isCalibrationDownwindTwa(twa: number): boolean {
  return Math.abs(twa) > CALIBRATION_DOWNWIND_ABS_TWA_MIN;
}

/** Short filter line reused in legends (plain text; use in JSX with {' '} between spans if needed). */
const CAL_LEGEND_SECTOR =
  `Grade 2–3 · upwind |TWA| < ${CALIBRATION_UPWIND_ABS_TWA_MAX}° · downwind |TWA| > ${CALIBRATION_DOWNWIND_ABS_TWA_MIN}°`;

/** Offsets-vs-time uses every loaded row; violins/tables above still use Grade 2–3 + sector filters. */
const CAL_TIMESERIES_GRADES_NOTE =
  "All grades: offset curves use the full calibration dataset (offsets trained on grade ≥ 2 only). AWA Δ: Awa_offset_deg when present, else Awa_n_cor−before; 10 s box smooth; clamp ±5°. LWY Δ: Lwy_offset_norm_deg or Lwy_n_cor−Lwy_n; 5 min box smooth; clamp ±5°.";

/** Knots → km/h (matches AC40 `3_corrections.py` Tws_cor_kph from Tws_kts). */
const KTS_TO_KPH = 1.852;

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
    label: "BSP",
    before: "Bsp_kts",
    after: "Bsp_kph",
    unit: "kph",
    beforeScale: KTS_TO_KPH,
    afterScale: 1,
  },
  { label: "AWA", before: "Awa_n_deg", after: "Awa_n_cor_deg", unit: "°", useAbsMean: true },
  { label: "AWS", before: "Aws_kph", after: "Aws_cor_kph", unit: "kph" },
  { label: "TWA", before: "Twa_n_deg", after: "Twa_n_cor_deg", unit: "°", useAbsMean: true },
  { label: "CWA", before: "Cwa_n_deg", after: "Cwa_n_cor_deg", unit: "°", useAbsMean: true },
  { label: "LWY", before: "Lwy_n_deg", after: "Lwy_n_cor_deg", unit: "°", useAbsMean: true },
  {
    label: "TWS",
    before: "Tws_kts",
    after: "Tws_cor_kph",
    unit: "kph",
    beforeScale: KTS_TO_KPH,
    afterScale: 1,
  },
  { label: "TWD", before: "Twd_deg", after: "Twd_cor_deg", unit: "°" },
];

function findCalibrationPairForField(field: string): BeforeAfterPairConfig | undefined {
  const fromStatic = CALIBRATION_BEFORE_AFTER_PAIRS.find((p) => p.before === field || p.after === field);
  if (fromStatic) return fromStatic;
  if (field === "Awa_n_fused_deg") {
    return { label: "AWA", before: "Awa_n_fused_deg", after: "Awa_n_cor_deg", unit: "°", useAbsMean: true };
  }
  if (field === "Aws_fused_norm_kph" || field === "Aws_fused_kph") {
    const before = field === "Aws_fused_norm_kph" ? "Aws_fused_norm_kph" : "Aws_fused_kph";
    return { label: "AWS", before, after: "Aws_cor_kph", unit: "kph" };
  }
  return undefined;
}

/** Pre-cal fused AWS from corrections parquet; older files may only have Aws_fused_kph. */
function awsBeforeFieldForData(data: Record<string, unknown>[]): string {
  if (data.some((d) => getVal(d, "Aws_fused_norm_kph") !== null)) return "Aws_fused_norm_kph";
  if (data.some((d) => getVal(d, "Aws_fused_kph") !== null)) return "Aws_fused_kph";
  return "Aws_kph";
}

/** When bow+MHU exist, use fused baseline for AWA/AWS fused rows (same recipe as pipeline). */
function buildEffectiveBeforeAfterPairs(data: Record<string, unknown>[]): BeforeAfterPairConfig[] {
  const fusedAwa = data.some((d) => getVal(d, "Awa_n_fused_deg") !== null);
  const awsBefore = awsBeforeFieldForData(data);
  const fusedAws = awsBefore !== "Aws_kph";
  return CALIBRATION_BEFORE_AFTER_PAIRS.map((p) => {
    if (p.label === "AWA" && fusedAwa) return { ...p, before: "Awa_n_fused_deg" };
    if (p.label === "AWS" && fusedAws) return { ...p, before: awsBefore };
    return { ...p };
  });
}

/**
 * Map a raw channel value to what we average in the **Before vs After** summary tables only.
 * Angles: |·| for signed boat-frame °. TWS/BSP before: scale kts→kph where configured.
 * Port vs stbd tables use raw values (same as violins).
 */
function calibrationValueForMean(field: string, raw: number, channelIsBefore: boolean): number {
  const p = findCalibrationPairForField(field);
  if (p) {
    const scale = channelIsBefore ? (p.beforeScale ?? 1) : (p.afterScale ?? 1);
    let x = raw * scale;
    if (p.useAbsMean) x = Math.abs(x);
    return x;
  }
  if (/Awa_(bow|mhu)/i.test(field)) {
    return Math.abs(raw);
  }
  return raw;
}

/** Rows for calibration summary tables / violins: |TWA| < 80° (upwind) or > 115° (downwind). */
function includeRowForCalibrationSummary(
  d: Record<string, unknown>,
  twaField: string,
  wind: "upwind" | "downwind"
): boolean {
  const twa = getVal(d, twaField);
  if (twa === null) return false;
  return wind === "upwind" ? isCalibrationUpwindTwa(twa) : isCalibrationDownwindTwa(twa);
}

/** Grade column from calibration rows (matches violin filters). */
function calibrationRowGradeNum(d: Record<string, unknown>): number | null {
  const raw = (d as { Grade?: unknown; grade?: unknown; GRADE?: unknown }).Grade
    ?? (d as { grade?: unknown }).grade
    ?? (d as { GRADE?: unknown }).GRADE;
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Grades 2–3: violins and aligned calibration tables. */
const CALIBRATION_VIOLIN_GRADES: ReadonlySet<number> = new Set([2, 3]);

/** Same population as `buildBeforeAfterViolinData` / wind-sector tack violins. */
function isCalibrationViolinGradeRow(d: Record<string, unknown>): boolean {
  const g = calibrationRowGradeNum(d);
  return g !== null && CALIBRATION_VIOLIN_GRADES.has(g);
}

export default function CalibrationPage() {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [datasetInfo, setDatasetInfo] = createSignal<DatasetInfo | null>(null);
  const [channelData, setChannelData] = createSignal<Record<string, unknown>[]>([]);
  const [maneuversTack, setManeuversTack] = createSignal<Record<string, unknown>[]>([]);
  const [maneuversGybe, setManeuversGybe] = createSignal<Record<string, unknown>[]>([]);
  const [missingChannels, setMissingChannels] = createSignal<string[]>([]);
  let timeSeriesRef: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;


  function buildBeforeAfterRows(data: Record<string, unknown>[]): BeforeAfterRow[] {
    if (!data.length) return [];
    const pairs = buildEffectiveBeforeAfterPairs(data);
    const rows: BeforeAfterRow[] = [];
    for (const { label, before, after } of pairs) {
      const beforeVals = data
        .map((d) => getVal(d, before))
        .filter((v): v is number => v !== null)
        .map((v) => calibrationValueForMean(before, v, true));
      const afterVals = data
        .map((d) => getVal(d, after))
        .filter((v): v is number => v !== null)
        .map((v) => calibrationValueForMean(after, v, false));
      if (beforeVals.length === 0 && afterVals.length === 0) continue;
      const meanBefore = beforeVals.length ? d3.mean(beforeVals)! : 0;
      const meanAfter = afterVals.length ? d3.mean(afterVals)! : 0;
      const deltaMean = meanAfter - meanBefore;
      const ref = Math.abs(meanBefore) > 1e-6 ? meanBefore : 1;
      const pctDiff = (100 * deltaMean) / ref;
      rows.push({
        channel: label,
        sensor: "Fused",
        meanBefore,
        meanAfter,
        deltaMean,
        pctDiff,
        count: Math.max(beforeVals.length, afterVals.length),
      });
    }
    if (data.some((d) => getVal(d, "Awa_bow_deg") !== null)) {
      const bowBefore = data
        .map((d) => getVal(d, "Awa_bow_deg"))
        .filter((v): v is number => v !== null)
        .map((v) => calibrationValueForMean("Awa_bow_deg", v, true));
      const bowAfter = data
        .map((d) => getVal(d, "Awa_bow_cor_deg"))
        .filter((v): v is number => v !== null)
        .map((v) => calibrationValueForMean("Awa_bow_cor_deg", v, false));
      if (bowBefore.length || bowAfter.length) {
        const meanBefore = bowBefore.length ? d3.mean(bowBefore)! : 0;
        const meanAfter = bowAfter.length ? d3.mean(bowAfter)! : 0;
        const deltaMean = meanAfter - meanBefore;
        const ref = Math.abs(meanBefore) > 1e-6 ? meanBefore : 1;
        const pctDiff = (100 * deltaMean) / ref;
        rows.push({
          channel: "AWA",
          sensor: "Bow",
          meanBefore,
          meanAfter,
          deltaMean,
          pctDiff,
          count: Math.max(bowBefore.length, bowAfter.length),
        });
      }
    }
    if (data.some((d) => getVal(d, "Awa_mhu_deg") !== null)) {
      const mhuBefore = data
        .map((d) => getVal(d, "Awa_mhu_deg"))
        .filter((v): v is number => v !== null)
        .map((v) => calibrationValueForMean("Awa_mhu_deg", v, true));
      const mhuAfter = data
        .map((d) => getVal(d, "Awa_mhu_cor_deg"))
        .filter((v): v is number => v !== null)
        .map((v) => calibrationValueForMean("Awa_mhu_cor_deg", v, false));
      if (mhuBefore.length || mhuAfter.length) {
        const meanBefore = mhuBefore.length ? d3.mean(mhuBefore)! : 0;
        const meanAfter = mhuAfter.length ? d3.mean(mhuAfter)! : 0;
        const deltaMean = meanAfter - meanBefore;
        const ref = Math.abs(meanBefore) > 1e-6 ? meanBefore : 1;
        const pctDiff = (100 * deltaMean) / ref;
        rows.push({
          channel: "AWA",
          sensor: "MHU",
          meanBefore,
          meanAfter,
          deltaMean,
          pctDiff,
          count: Math.max(mhuBefore.length, mhuAfter.length),
        });
      }
    }
    return rows;
  }

  const twaFieldForFilter = createMemo(() =>
    channelData().some((d) => getVal(d, "Twa_cor_deg") !== null) ? "Twa_cor_deg" : "Twa_deg"
  );

  const beforeAfterTableUpwind = createMemo((): BeforeAfterRow[] => {
    const data = channelData();
    const twaF = twaFieldForFilter();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, twaF, "upwind"))
      .filter(isCalibrationViolinGradeRow);
    return buildBeforeAfterRows(filtered);
  });

  const beforeAfterTableDownwind = createMemo((): BeforeAfterRow[] => {
    const data = channelData();
    const twaF = twaFieldForFilter();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, twaF, "downwind"))
      .filter(isCalibrationViolinGradeRow);
    return buildBeforeAfterRows(filtered);
  });

  function buildPortStbdRows(data: Record<string, unknown>[], useBefore: boolean = false): PortStbdRow[] {
    if (!data.length) return [];
    const pairs = buildEffectiveBeforeAfterPairs(data);
    const twaField = data.some((d) => getVal(d, "Twa_cor_deg") !== null) ? "Twa_cor_deg" : "Twa_deg";
    const portMask = (d: Record<string, unknown>) => getTackFromTwa(getVal(d, twaField) ?? 0) === "port";
    const stbdMask = (d: Record<string, unknown>) => getTackFromTwa(getVal(d, twaField) ?? 0) === "stbd";
    const rows: PortStbdRow[] = [];
    const fieldPairs = useBefore
      ? pairs.map(({ before, label }) => ({ field: before, label }))
      : pairs.map(({ after, label }) => ({ field: after, label }));

    for (const { field, label } of fieldPairs) {
      const portVals = data
        .filter(portMask)
        .map((d) => getVal(d, field))
        .filter((v): v is number => v !== null);
      const stbdVals = data
        .filter(stbdMask)
        .map((d) => getVal(d, field))
        .filter((v): v is number => v !== null);
      if (portVals.length === 0 && stbdVals.length === 0) continue;
      const portMean = portVals.length ? d3.mean(portVals)! : 0;
      const stbdMean = stbdVals.length ? d3.mean(stbdVals)! : 0;
      const diff = stbdMean - portMean;
      const ref = Math.abs(portMean) > 1e-6 ? portMean : 1;
      const pctDiff = (100 * diff) / ref;
      rows.push({
        channel: label,
        sensor: "Fused",
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
    const twaF = twaFieldForFilter();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, twaF, "upwind"))
      .filter(isCalibrationViolinGradeRow);
    return buildPortStbdRows(filtered, true); // useBefore = true
  });

  const portStbdTableBeforeDownwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const twaF = twaFieldForFilter();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, twaF, "downwind"))
      .filter(isCalibrationViolinGradeRow);
    return buildPortStbdRows(filtered, true); // useBefore = true
  });

  const portStbdTableUpwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const twaF = twaFieldForFilter();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, twaF, "upwind"))
      .filter(isCalibrationViolinGradeRow);
    return buildPortStbdRows(filtered, false); // useBefore = false (after correction)
  });

  const portStbdTableDownwind = createMemo((): PortStbdRow[] => {
    const data = channelData();
    const twaF = twaFieldForFilter();
    const filtered = data
      .filter((d) => includeRowForCalibrationSummary(d, twaF, "downwind"))
      .filter(isCalibrationViolinGradeRow);
    return buildPortStbdRows(filtered, false); // useBefore = false (after correction)
  });

  const cwaVsTackGybeTable = createMemo((): ManeuverAngleRow[] => {
    const data = channelData();
    const tacks = maneuversTack();
    const gybes = maneuversGybe();
    if (!data.length || (!tacks.length && !gybes.length)) return [];

    const rows: ManeuverAngleRow[] = [];

    /** Grades 2–3; |TWA| < 80 (tack / upwind slice) vs > 115 (gybe / downwind slice). */
    const getSectorAbsMetrics = (wantUpwind: boolean): { twaVals: number[]; cwaVals: number[]; lwyVals: number[] } => {
      const twaVals: number[] = [];
      const cwaVals: number[] = [];
      const lwyVals: number[] = [];
      let checked = 0;
      let grade23Count = 0;
      let windMatchCount = 0;
      for (const d of data) {
        checked++;
        const grade = (d as any).Grade ?? (d as any).grade ?? (d as any).GRADE;
        const gradeNum = grade !== undefined && grade !== null ? Number(grade) : null;
        if (gradeNum === null || !CALIBRATION_VIOLIN_GRADES.has(gradeNum)) continue;
        grade23Count++;

        const twa = getVal(d, "Twa_cor_deg") ?? getVal(d, "Twa_deg");
        if (twa === null) continue;

        if (wantUpwind) {
          if (!isCalibrationUpwindTwa(twa)) continue;
        } else {
          if (!isCalibrationDownwindTwa(twa)) continue;
        }
        windMatchCount++;

        twaVals.push(Math.abs(twa));
        const cwa = getVal(d, "Cwa_n_cor_deg") ?? getVal(d, "Cwa_cor_deg");
        if (cwa !== null) cwaVals.push(Math.abs(cwa));
        const lwy = getVal(d, "Lwy_n_cor_deg") ?? getVal(d, "Lwy_cor_deg");
        if (lwy !== null) lwyVals.push(Math.abs(lwy));
      }
      debug("[Calibration] getSectorAbsMetrics", {
        wantUpwind,
        checked,
        grade23Count,
        windMatchCount,
        twaValsFound: twaVals.length,
        cwaValsFound: cwaVals.length,
        lwyValsFound: lwyVals.length,
        sampleTwa: twaVals.slice(0, 5),
      });
      return { twaVals, cwaVals, lwyVals };
    };

    // Tacks: maneuver Turn_angle grade > 1; channel means from grades 2–3, |TWA| < 80
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

    // Gybes: maneuver Turn_angle grade > 1; channel means from grades 2–3, |TWA| > 115
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
   * Uses one TWA column for wind sector (same rule as summary tables: `twaFieldForFilter()`),
   * so Before and After points from the same row share one classification — unlike filtering Before by
   * Twa_deg and After by Twa_cor separately, which skewed means and counts.
   * Grades 2–3 only.
   */
  function buildBeforeAfterViolinData(
    beforeField: string,
    afterField: string,
    twaFilterField: string,
    windFilter?: "upwind" | "downwind"
  ): { Phase: string; Value: number; Twa_signed: number }[] {
    const data = channelData();
    const out: { Phase: string; Value: number; Twa_signed: number }[] = [];
    for (const d of data) {
      if (!isCalibrationViolinGradeRow(d)) continue;

      const twa = getVal(d, twaFilterField);
      if (twa === null) continue;

      if (windFilter === "upwind" || windFilter === "downwind") {
        if (!includeRowForCalibrationSummary(d, twaFilterField, windFilter)) continue;
      } else if (!isCalibrationUpwindTwa(twa) && !isCalibrationDownwindTwa(twa)) {
        continue;
      }

      const beforeVal = getVal(d, beforeField);
      const afterVal = getVal(d, afterField);
      if (beforeVal !== null) out.push({ Phase: "Before", Value: beforeVal, Twa_signed: twa });
      if (afterVal !== null) out.push({ Phase: "After", Value: afterVal, Twa_signed: twa });
    }
    return out;
  }

  /**
   * TWS/BSP violins: Upwind (|TWA| < 80°) vs Downwind (|TWA| > 115°), port/stbd from signed TWA.
   * Grades 2–3; matches other calibration violins.
   */
  function buildWindSectorTackViolinData(
    valueField: string,
    twaField: string
  ): { Sector: "Upwind" | "Downwind"; Value: number; Twa_signed: number }[] {
    const data = channelData();
    const out: { Sector: "Upwind" | "Downwind"; Value: number; Twa_signed: number }[] = [];
    for (const d of data) {
      if (!isCalibrationViolinGradeRow(d)) continue;

      const twa = getVal(d, twaField);
      if (twa === null) continue;

      const val = getVal(d, valueField);
      if (val === null) continue;

      if (isCalibrationUpwindTwa(twa)) out.push({ Sector: "Upwind", Value: val, Twa_signed: twa });
      else if (isCalibrationDownwindTwa(twa)) out.push({ Sector: "Downwind", Value: val, Twa_signed: twa });
    }
    return out;
  }

  const twaFieldForViolins = createMemo(() =>
    channelData().some((d) => getVal(d, "Twa_cor_deg") !== null) ? "Twa_cor_deg" : "Twa_deg"
  );

  /** Violins label AWA “before” as fused; parquet from corrections includes this column. */
  function awaBeforeFieldForViolins(): "Awa_n_fused_deg" {
    return "Awa_n_fused_deg";
  }

  const twsViolinValueField = createMemo((): { field: string; yLabel: string } => {
    const data = channelData();
    if (!data.length) return { field: "Tws_kts", yLabel: "TWS (kts)" };
    if (data.some((d) => getVal(d, "Tws_kts") !== null)) return { field: "Tws_kts", yLabel: "TWS (kts)" };
    if (data.some((d) => getVal(d, "Tws_cor_kph") !== null)) return { field: "Tws_cor_kph", yLabel: "TWS (kph)" };
    return { field: "Tws_kts", yLabel: "TWS (kts)" };
  });

  const bspViolinValueField = createMemo((): { field: string; yLabel: string } => {
    const data = channelData();
    if (!data.length) return { field: "Bsp_kph", yLabel: "BSP (kph)" };
    if (data.some((d) => getVal(d, "Bsp_kph") !== null)) return { field: "Bsp_kph", yLabel: "BSP (kph)" };
    if (data.some((d) => getVal(d, "Bsp_kts") !== null)) return { field: "Bsp_kts", yLabel: "BSP (kts)" };
    return { field: "Bsp_kph", yLabel: "BSP (kph)" };
  });

  const violinTwsWindSector = createMemo(() =>
    buildWindSectorTackViolinData(twsViolinValueField().field, twaFieldForViolins())
  );
  const violinBspWindSector = createMemo(() =>
    buildWindSectorTackViolinData(bspViolinValueField().field, twaFieldForViolins())
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
        yaxis: { name: "°", dataField: "Value" },
        groupField: "Phase",
        originalData: [] as { Phase: string; Value: number; Twa_signed: number }[],
      },
    ],
  };

  const violinAwaUpwind = createMemo(() =>
    buildBeforeAfterViolinData(awaBeforeFieldForViolins(), "Awa_n_cor_deg", twaFieldForFilter(), "upwind")
  );
  const violinAwaDownwind = createMemo(() =>
    buildBeforeAfterViolinData(awaBeforeFieldForViolins(), "Awa_n_cor_deg", twaFieldForFilter(), "downwind")
  );
  const violinTwaUpwind = createMemo(() => buildBeforeAfterViolinData("Twa_n_deg", "Twa_n_cor_deg", twaFieldForFilter(), "upwind"));
  const violinTwaDownwind = createMemo(() => buildBeforeAfterViolinData("Twa_n_deg", "Twa_n_cor_deg", twaFieldForFilter(), "downwind"));
  const violinLwyUpwind = createMemo(() => buildBeforeAfterViolinData("Lwy_n_deg", "Lwy_n_cor_deg", twaFieldForFilter(), "upwind"));
  const violinLwyDownwind = createMemo(() => buildBeforeAfterViolinData("Lwy_n_deg", "Lwy_n_cor_deg", twaFieldForFilter(), "downwind"));
  const violinCwaUpwind = createMemo(() => buildBeforeAfterViolinData("Cwa_n_deg", "Cwa_n_cor_deg", twaFieldForFilter(), "upwind"));
  const violinCwaDownwind = createMemo(() => buildBeforeAfterViolinData("Cwa_n_deg", "Cwa_n_cor_deg", twaFieldForFilter(), "downwind"));

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

      // Full timeline: backend applies corrections to all grades; do not restrict to 2–3 here.
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

      // AWA Δ: pipeline Awa_offset_deg as stored (additive ° on signed AWA); fallback Awa_n_cor − Awa_n_fused.
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

      // LWY Δ: Lwy_offset_norm_deg from pipeline, or Lwy_n_cor − Lwy_n (same sign convention as stored columns).
      const lwyOffsetRaw = sorted.map((d) => {
        const directNorm = getVal(d, "Lwy_offset_norm_deg");
        if (directNorm !== null) {
          return clampCalibrationOffsetDisplayDeg(directNorm);
        }
        const before = getVal(d, "Lwy_n_deg");
        const after = getVal(d, "Lwy_n_cor_deg");
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

  onMount(async () => {
    // Safety timeout to ensure loading doesn't hang forever
    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      logError("[Calibration] Loading timeout - forcing loading to false");
      setLoading(false);
      setError("Loading timed out. Please refresh the page.");
      timeoutId = null;
    }, 30000); // 30 second timeout

    try {
      await logPageLoad("Calibration.tsx", "Calibration");
      const datasetId = selectedDatasetId();
      const projectId = selectedProjectId();
      const className = selectedClassName();
      const sourceId = selectedSourceId();
      if (!datasetId || !projectId || !className || !sourceId) {
        if (timeoutId) clearTimeout(timeoutId);
        setError("No dataset or project selected.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      const infoUrl = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`;
      const infoRes = await getData(infoUrl);
      if (!infoRes?.success || !infoRes?.data) {
        if (timeoutId) clearTimeout(timeoutId);
        setError("Failed to load dataset info.");
        setLoading(false);
        return;
      }
      const { date, source_name, timezone } = infoRes.data;
      setDatasetInfo({ date, source_name, timezone });

      const formattedDateStr = (date as string).replace(/-/g, "");

      // Use chartType 'ts' (same as TimeSeries/Explore) so we share the same cache key; the store
      // then returns in-memory cache when available and allowPartialData applies so we get data.
      // Use fetchDataWithChannelChecking (not FromFile) so we don't gate on file channel list and
      // the channel-values API is called with our calibration channels directly.
      // No global grade/TWA filters: backend writes _cor for all grades; we need every row here.
      const data = await unifiedDataStore.fetchDataWithChannelChecking(
        "ts",
        className,
        sourceId.toString(),
        CALIBRATION_CHANNELS,
        {
          projectId: projectId.toString(),
          className,
          datasetId: datasetId.toString(),
          sourceName: selectedSourceName() || source_name,
          date: formattedDateStr,
          timezone: timezone || undefined,
          applyGlobalFilters: false,
          use_v2: true,
          skipTimeRangeFilter: true,
        },
        "timeseries"
      );
      const arr = Array.isArray(data) ? data : [];
      setChannelData(arr);
      debug("[Calibration] Channel data loaded", { rows: arr.length });

      const missing = unifiedDataStore.getLastMissingChannels("ts");
      if (missing?.length) setMissingChannels(missing);

      const tackUrl = `${apiEndpoints.app.data}/maneuvers-table-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=TACK&channels=${encodeURIComponent(JSON.stringify(MANEUVERS_ANGLE_CHANNELS))}`;
      const gybeUrl = `${apiEndpoints.app.data}/maneuvers-table-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=GYBE&channels=${encodeURIComponent(JSON.stringify(MANEUVERS_ANGLE_CHANNELS))}`;

      const [tackRes, gybeRes] = await Promise.all([getData(tackUrl), getData(gybeUrl)]);
      if (tackRes?.success && Array.isArray(tackRes.data)) setManeuversTack(tackRes.data);
      if (gybeRes?.success && Array.isArray(gybeRes.data)) setManeuversGybe(gybeRes.data);
    } catch (e) {
      logError("[Calibration] Load error", e);
      setError(e instanceof Error ? e.message : "Failed to load calibration data.");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      setLoading(false);
      debug("[Calibration] Loading complete");
    }
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
                    <th>Sensor</th>
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
                        <td>{row.sensor}</td>
                        <td>{row.meanBefore.toFixed(2)}</td>
                        <td>{row.meanAfter.toFixed(2)}</td>
                        <td class={row.deltaMean > 0 ? "calibration-delta-positive" : row.deltaMean < 0 ? "calibration-delta-negative" : ""}>{row.deltaMean.toFixed(2)}</td>
                        <td class={row.pctDiff > 0 ? "calibration-delta-positive" : row.pctDiff < 0 ? "calibration-delta-negative" : ""}>{row.pctDiff.toFixed(1)}%</td>
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
                    <th>Sensor</th>
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
                        <td>{row.sensor}</td>
                        <td>{row.meanBefore.toFixed(2)}</td>
                        <td>{row.meanAfter.toFixed(2)}</td>
                        <td class={row.deltaMean > 0 ? "calibration-delta-positive" : row.deltaMean < 0 ? "calibration-delta-negative" : ""}>{row.deltaMean.toFixed(2)}</td>
                        <td class={row.pctDiff > 0 ? "calibration-delta-positive" : row.pctDiff < 0 ? "calibration-delta-negative" : ""}>{row.pctDiff.toFixed(1)}%</td>
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
                    <th>Sensor</th>
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
                        <td>{row.sensor}</td>
                        <td class="calibration-port-value">{row.portMean.toFixed(2)}</td>
                        <td class="calibration-stbd-value">{row.stbdMean.toFixed(2)}</td>
                        <td class={row.diff > 0 ? "calibration-delta-positive" : row.diff < 0 ? "calibration-delta-negative" : ""}>{row.diff.toFixed(2)}</td>
                        <td class={row.pctDiff > 0 ? "calibration-delta-positive" : row.pctDiff < 0 ? "calibration-delta-negative" : ""}>{row.pctDiff.toFixed(1)}%</td>
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
                    <th>Sensor</th>
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
                        <td>{row.sensor}</td>
                        <td class="calibration-port-value">{row.portMean.toFixed(2)}</td>
                        <td class="calibration-stbd-value">{row.stbdMean.toFixed(2)}</td>
                        <td class={row.diff > 0 ? "calibration-delta-positive" : row.diff < 0 ? "calibration-delta-negative" : ""}>{row.diff.toFixed(2)}</td>
                        <td class={row.pctDiff > 0 ? "calibration-delta-positive" : row.pctDiff < 0 ? "calibration-delta-negative" : ""}>{row.pctDiff.toFixed(1)}%</td>
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
                    <th>Sensor</th>
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
                        <td>{row.sensor}</td>
                        <td class="calibration-port-value">{row.portMean.toFixed(2)}</td>
                        <td class="calibration-stbd-value">{row.stbdMean.toFixed(2)}</td>
                        <td class={row.diff > 0 ? "calibration-delta-positive" : row.diff < 0 ? "calibration-delta-negative" : ""}>{row.diff.toFixed(2)}</td>
                        <td class={row.pctDiff > 0 ? "calibration-delta-positive" : row.pctDiff < 0 ? "calibration-delta-negative" : ""}>{row.pctDiff.toFixed(1)}%</td>
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
                    <th>Sensor</th>
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
                        <td>{row.sensor}</td>
                        <td class="calibration-port-value">{row.portMean.toFixed(2)}</td>
                        <td class="calibration-stbd-value">{row.stbdMean.toFixed(2)}</td>
                        <td class={row.diff > 0 ? "calibration-delta-positive" : row.diff < 0 ? "calibration-delta-negative" : ""}>{row.diff.toFixed(2)}</td>
                        <td class={row.pctDiff > 0 ? "calibration-delta-positive" : row.pctDiff < 0 ? "calibration-delta-negative" : ""}>{row.pctDiff.toFixed(1)}%</td>
                        <td>{row.count}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
          <p class="calibration-legend calibration-legend-right">
            <strong>Port–stbd:</strong> {CAL_LEGEND_SECTOR}. Tack via <code>{twaFieldForFilter()}</code>. Aligns with tack violins, not the aggregated before→after table.
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
            {CAL_LEGEND_SECTOR}. TWS left, BSP right. Red port / green stbd (TWA sign). Units from data (TWS kts, BSP kph typical).
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
            <h4 class="calibration-violin-metric-title">AWA · fused → corrected</h4>
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
                  <Violin chart={violinChartPhase} data={violinTwaUpwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Downwind</h5>
                <div class="violin-container">
                  <Violin chart={violinChartPhase} data={violinTwaDownwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
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
                  <Violin chart={violinChartPhase} data={violinCwaUpwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
                </div>
              </div>
              <div class="calibration-violin-cell">
                <h5 class="calibration-violin-wind-label">Downwind</h5>
                <div class="violin-container">
                  <Violin chart={violinChartPhase} data={violinCwaDownwind()} twaField="Twa_signed" portColor="#c00" stbdColor="#2ca02c" />
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
