/**
 * Per-segment transforms for Time Series chart series (builder `lineType` → explore display).
 * Input segments are chronological; gap/cut splitting is done by the chart before calling here.
 * For cumulative-style line types, the chart passes `carryIn` / reads the last `displayY` so totals continue across segments.
 */

import { debug, info } from "./console";

export const TIMESERIES_LINE_TYPES = [
  "standard",
  "cumulative",
  "abs_cumulative",
  "abs_cumulative_diff",
  "derivative",
  "difference",
  "percent_change",
] as const;

export type TimeseriesLineType = (typeof TIMESERIES_LINE_TYPES)[number];

/** Persisted JSON value for default series; shown in UI as "Raw Value" (see LINE_TYPE_DISPLAY_LABELS). */
export const DEFAULT_TIMESERIES_LINE_TYPE: TimeseriesLineType = "standard";

/** Human-readable labels for UI (builder combo, chart legend). */
export const LINE_TYPE_DISPLAY_LABELS: Record<TimeseriesLineType, string> = {
  standard: "Raw Value",
  cumulative: "Cumulative",
  abs_cumulative: "Abs Cumulative",
  abs_cumulative_diff: "Abs Cumul Diff",
  derivative: "Derivative",
  difference: "Difference",
  percent_change: "Percent change",
};

export type TransformedPoint = {
  x: Date;
  /** Raw channel value (preserved for debugging / future use) */
  y: number;
  /** Value used for y-scale, line, area, stats, tooltips */
  displayY: number;
};

/** Optional context when transforming a segment (e.g. global raw range for percent_change). */
export type LineTypeSegmentOptions = {
  /** Min/max of raw `y` over all visible segments; used by `percent_change` as (delta / span) * 100. */
  rawYRange?: { min: number; max: number };
};

const LINE_TYPE_SET = new Set<string>(TIMESERIES_LINE_TYPES);

export function normalizeLineType(raw: unknown): TimeseriesLineType {
  if (typeof raw === "string" && LINE_TYPE_SET.has(raw)) {
    return raw as TimeseriesLineType;
  }
  return DEFAULT_TIMESERIES_LINE_TYPE;
}

/** Per-series data resampling for explore timeseries (builder → channel-values `resolution`). */
export const TIMESERIES_DATA_RESAMPLE_OPTIONS = ["RAW", "1HZ", "10HZ"] as const;
export type TimeseriesDataResample = (typeof TIMESERIES_DATA_RESAMPLE_OPTIONS)[number];
export const DEFAULT_TIMESERIES_DATA_RESAMPLE: TimeseriesDataResample = "1HZ";

const DATA_RESAMPLE_SET = new Set<string>(TIMESERIES_DATA_RESAMPLE_OPTIONS);

export function normalizeTimeseriesDataResample(raw: unknown): TimeseriesDataResample {
  if (typeof raw !== "string") {
    return DEFAULT_TIMESERIES_DATA_RESAMPLE;
  }
  const t = raw.trim();
  if (DATA_RESAMPLE_SET.has(t)) {
    return t as TimeseriesDataResample;
  }
  const compact = t.replace(/\s+/g, "").toUpperCase();
  if (compact === "RAW" || compact === "NONE") return "RAW";
  if (compact === "1HZ" || compact === "1S") return "1HZ";
  if (compact === "10HZ" || compact === "100MS") return "10HZ";
  return DEFAULT_TIMESERIES_DATA_RESAMPLE;
}

/**
 * Legend suffix before line type. Omit when `dataResample` is absent (e.g. fleet series) so we do not imply a default grid.
 * RAW is shown as "Resampling: None" per product wording.
 */
export function dataResampleLegendBracket(raw: unknown | undefined): string {
  if (raw === undefined) return "";
  const mode = normalizeTimeseriesDataResample(raw);
  if (mode === "RAW") return " [Resampling: None]";
  if (mode === "10HZ") return " [Resampling: 10 Hz]";
  return " [Resampling: 1 Hz]";
}

const RESAMPLE_RANK: Record<TimeseriesDataResample, number> = { RAW: 0, "10HZ": 1, "1HZ": 2 };

/** Finest grid wins (RAW > 10HZ > 1HZ). */
export function finerTimeseriesDataResample(a: TimeseriesDataResample, b: TimeseriesDataResample): TimeseriesDataResample {
  return RESAMPLE_RANK[a] <= RESAMPLE_RANK[b] ? a : b;
}

/** channel-values API: `null` = DuckDB raw rows (no bucket SQL). */
export type ChannelValuesApiResolution = null | "1s" | "100ms";

export function dataResampleToApiResolution(mode: TimeseriesDataResample): ChannelValuesApiResolution {
  if (mode === "RAW") return null;
  if (mode === "10HZ") return "100ms";
  return "1s";
}

/** Stable string for cache keys (sorted channel:mode). */
export function fingerprintChannelResampleModes(map: Record<string, TimeseriesDataResample> | undefined): string {
  if (!map || Object.keys(map).length === 0) return "";
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((k) => `${k}:${map[k]}`)
    .join(";");
}

function dataResampleModeForChannelName(
  ch: string,
  modeByChannel: Record<string, TimeseriesDataResample>
): TimeseriesDataResample {
  const direct = modeByChannel[ch];
  if (direct !== undefined) return normalizeTimeseriesDataResample(direct);
  const lower = ch.toLowerCase();
  for (const [k, v] of Object.entries(modeByChannel)) {
    if (k.toLowerCase() === lower) return normalizeTimeseriesDataResample(v);
  }
  return DEFAULT_TIMESERIES_DATA_RESAMPLE;
}

/** Split channel names into groups that share one channel-values `resolution`. */
export function groupChannelsByApiResolution(
  channels: string[],
  modeByChannel: Record<string, TimeseriesDataResample>
): Map<ChannelValuesApiResolution, string[]> {
  const m = new Map<ChannelValuesApiResolution, string[]>();
  for (const ch of channels) {
    const mode = dataResampleModeForChannelName(ch, modeByChannel);
    const apiRes = dataResampleToApiResolution(mode);
    const list = m.get(apiRes) ?? [];
    list.push(ch);
    m.set(apiRes, list);
  }
  return m;
}

type ChartLikeForResample = {
  series?: Array<{
    dataResample?: unknown;
    lineType?: unknown;
    xaxis?: { name?: string };
    yaxis?: { name?: string };
    colorChannel?: { name?: string };
  }>;
};

function chartHasRawSeriesForY(
  chart: ChartLikeForResample,
  yBase: string
): boolean {
  for (const ser of chart.series ?? []) {
    const yn = ser?.yaxis?.name;
    if (!yn) continue;
    if (stripFleetChannelSuffix(yn) !== yBase) continue;
    if (normalizeTimeseriesDataResample(ser.dataResample) === "RAW") {
      return true;
    }
  }
  return false;
}

export function stripFleetChannelSuffix(s: string): string {
  return s.split(" - ")[0].trim();
}

/**
 * Cumulative-style line types should use native RAW samples on the merged explore frame when available,
 * not resampled bucket means (same channel may also be plotted at 1 Hz / 10 Hz).
 */
export function useRawReadingsForCumulativeLineTypes(lineType: unknown): boolean {
  const lt = normalizeLineType(lineType);
  return lt === "cumulative" || lt === "abs_cumulative" || lt === "abs_cumulative_diff";
}

/**
 * Plot key for the RAW-resolution column of `yAxisName` on the merged explore frame (same chart index).
 * Used so cumulative / abs_cumulative / abs_cumulative_diff use native readings while legend still shows 1Hz/10Hz.
 */
export function rawReadingPlotKeyForExploreChannel(
  chart: {
    series?: Array<{
      dataResample?: unknown;
      yaxis?: { name?: string };
    }>;
  },
  chartIndex: number,
  yAxisName: string,
  plan: ExploreResampleFetchPlan | null | undefined
): string | null {
  if (!plan?.seriesYPlotKeyByChartSeries) {
    return null;
  }
  const base = stripFleetChannelSuffix(yAxisName);
  const list = chart.series ?? [];
  for (let si = 0; si < list.length; si++) {
    const ser = list[si];
    const yn = ser?.yaxis?.name;
    if (!yn) continue;
    if (stripFleetChannelSuffix(yn) !== base) continue;
    if (normalizeTimeseriesDataResample(ser.dataResample) !== "RAW") {
      continue;
    }
    return plan.seriesYPlotKeyByChartSeries[`${chartIndex}-${si}`] ?? yn;
  }
  const want = `${base}${EXPLORE_Y_RESAMPLE_INFIX}RAW`;
  for (const k of plan.mergedYKeys ?? []) {
    if (k === want) {
      return k;
    }
    if (k.toLowerCase() === want.toLowerCase()) {
      return k;
    }
  }
  return null;
}

/**
 * Per-channel resampling for explore (non-fleet) timeseries fetch.
 * Shared x/color/metadata use the finest mode across all series.
 */
export function buildChannelResampleModeMapFromCharts(charts: ChartLikeForResample[]): Record<string, TimeseriesDataResample> {
  let finest: TimeseriesDataResample = DEFAULT_TIMESERIES_DATA_RESAMPLE;
  for (const chart of charts) {
    for (const ser of chart.series || []) {
      const m = normalizeTimeseriesDataResample(ser.dataResample);
      finest = finerTimeseriesDataResample(finest, m);
    }
  }

  const map: Record<string, TimeseriesDataResample> = {};
  for (const chart of charts) {
    for (const ser of chart.series || []) {
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      if (ser.yaxis?.name) {
        const y = stripFleetChannelSuffix(ser.yaxis.name);
        const cur = map[y];
        map[y] = cur === undefined ? mode : finerTimeseriesDataResample(cur, mode);
      }
      if (ser.xaxis?.name) {
        const xn = stripFleetChannelSuffix(ser.xaxis.name);
        if (xn.toLowerCase() !== "datetime") {
          const cur = map[xn];
          map[xn] = cur === undefined ? mode : finerTimeseriesDataResample(cur, mode);
        }
      }
      if (ser.colorChannel?.name) {
        const c = stripFleetChannelSuffix(ser.colorChannel.name);
        const cur = map[c];
        map[c] = cur === undefined ? mode : finerTimeseriesDataResample(cur, mode);
      }
    }
  }

  for (const meta of ["Race_number", "Leg_number", "Grade"] as const) {
    map[meta] = finest;
  }
  return map;
}

/** Merged-frame column suffix when the same source channel is plotted at multiple resample modes. */
export const EXPLORE_Y_RESAMPLE_INFIX = "__rs__";

/** Y-axis source names that appear in more than one `dataResample` mode (needs separate merged columns). */
export function ySourcesNeedingResampleDisambiguation(charts: ChartLikeForResample[]): Set<string> {
  const modesByY = new Map<string, Set<TimeseriesDataResample>>();
  for (const chart of charts) {
    for (const ser of chart.series || []) {
      if (!ser.yaxis?.name) continue;
      const y = stripFleetChannelSuffix(ser.yaxis.name);
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      let s = modesByY.get(y);
      if (!s) {
        s = new Set();
        modesByY.set(y, s);
      }
      s.add(mode);
    }
  }
  const out = new Set<string>();
  for (const [y, set] of modesByY) {
    if (set.size > 1) out.add(y);
  }
  return out;
}

export function exploreSeriesYPlotKey(
  ySourceName: string,
  mode: TimeseriesDataResample,
  disambiguate: boolean
): string {
  if (!disambiguate) return ySourceName;
  return `${ySourceName}${EXPLORE_Y_RESAMPLE_INFIX}${mode}`;
}

export type ExploreResampleFetchGroup = {
  resolution: ChannelValuesApiResolution;
  /** Parquet/API channel names to request */
  requestChannels: string[];
  /** After each fetch: API column name → merged-frame column name */
  responseRename: Record<string, string>;
};

export type ExploreResampleFetchPlan = {
  groups: ExploreResampleFetchGroup[];
  /** `chartIndex-seriesIndex` → column name on merged rows for that series' Y values */
  seriesYPlotKeyByChartSeries: Record<string, string>;
  /** Distinct merged Y column names (extend validChannels when copying rows) */
  mergedYKeys: string[];
};

/**
 * Build parallel channel-values groups + per-series plot keys so the same source channel can be fetched
 * at 1HZ and 10HZ (etc.) without column collisions on merge.
 */
export function buildExploreResampleFetchPlan(charts: ChartLikeForResample[]): ExploreResampleFetchPlan | null {
  let hasYSeries = false;
  for (const chart of charts) {
    for (const ser of chart.series || []) {
      if (ser.yaxis?.name) {
        hasYSeries = true;
        break;
      }
    }
    if (hasYSeries) break;
  }
  if (!hasYSeries) return null;

  const disambig = ySourcesNeedingResampleDisambiguation(charts);
  const seriesYPlotKeyByChartSeries: Record<string, string> = {};
  const mergedYKeysSet = new Set<string>();

  type InternalGroup = { channelSet: Set<string>; rename: Record<string, string> };
  const groupMap = new Map<ChannelValuesApiResolution, InternalGroup>();

  const ensureGroup = (res: ChannelValuesApiResolution): InternalGroup => {
    let g = groupMap.get(res);
    if (!g) {
      g = { channelSet: new Set(), rename: {} };
      groupMap.set(res, g);
    }
    return g;
  };

  const addMeta = (g: InternalGroup) => {
    for (const meta of ["Race_number", "Leg_number", "Grade"] as const) {
      g.channelSet.add(meta);
    }
  };

  charts.forEach((chart, chartIndex) => {
    (chart.series || []).forEach((ser, seriesIndex) => {
      if (!ser.yaxis?.name) return;
      const y = stripFleetChannelSuffix(ser.yaxis.name);
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      const apiRes = dataResampleToApiResolution(mode);
      ensureGroup(apiRes).channelSet.add(y);
      addMeta(ensureGroup(apiRes));
    });
  });

  // Cumulative-style line types need native RAW samples; fetch RAW for Y when the chart has no explicit RAW series for that channel (avoids bucket means on merged frame).
  charts.forEach((chart) => {
    for (const ser of chart.series || []) {
      if (!ser.yaxis?.name) continue;
      const y = stripFleetChannelSuffix(ser.yaxis.name);
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      if (!useRawReadingsForCumulativeLineTypes(ser.lineType)) continue;
      if (mode === "RAW") continue;
      if (chartHasRawSeriesForY(chart, y)) continue;
      const rawG = ensureGroup(null);
      rawG.channelSet.add(y);
      addMeta(rawG);
    }
  });

  /** Multiple channel-values resolutions in one plan → same API column name on both responses; must rename before merge or first grid wins and the other is lost. */
  const needsMultiResolutionPlotKeys = groupMap.size > 1;

  charts.forEach((chart, chartIndex) => {
    (chart.series || []).forEach((ser, seriesIndex) => {
      if (!ser.yaxis?.name) return;
      const y = stripFleetChannelSuffix(ser.yaxis.name);
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      const useSuffix = needsMultiResolutionPlotKeys || disambig.has(y);
      const plotKey = exploreSeriesYPlotKey(y, mode, useSuffix);
      seriesYPlotKeyByChartSeries[`${chartIndex}-${seriesIndex}`] = plotKey;
      mergedYKeysSet.add(plotKey);

      const apiRes = dataResampleToApiResolution(mode);
      const g = ensureGroup(apiRes);
      if (plotKey !== y) g.rename[y] = plotKey;
    });
  });

  // Ensure merged column `y__rs__RAW` exists for cumulative-style series that rely on `rawReadingPlotKeyForExploreChannel` fallback (no same-chart RAW series).
  charts.forEach((chart) => {
    for (const ser of chart.series || []) {
      if (!ser.yaxis?.name) continue;
      const y = stripFleetChannelSuffix(ser.yaxis.name);
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      if (!useRawReadingsForCumulativeLineTypes(ser.lineType)) continue;
      if (mode === "RAW") continue;
      if (chartHasRawSeriesForY(chart, y)) continue;
      const mergedKey = `${y}${EXPLORE_Y_RESAMPLE_INFIX}RAW`;
      mergedYKeysSet.add(mergedKey);
      const rawIg = groupMap.get(null);
      if (rawIg) {
        const existing = rawIg.rename[y];
        if (existing === undefined || existing === y) {
          rawIg.rename[y] = mergedKey;
        }
      }
    }
  });

  const groups: ExploreResampleFetchGroup[] = [...groupMap.entries()].map(([resolution, ig]) => ({
    resolution,
    requestChannels: [...ig.channelSet],
    responseRename: { ...ig.rename },
  }));

  return {
    groups,
    seriesYPlotKeyByChartSeries,
    mergedYKeys: [...mergedYKeysSet],
  };
}

export function fingerprintExploreResamplePlan(plan: ExploreResampleFetchPlan | null | undefined): string {
  if (!plan?.groups?.length) return "";
  return plan.groups
    .map((g) => {
      const r = g.resolution === null ? "RAW" : g.resolution;
      const ch = [...g.requestChannels].sort().join(",");
      const ren = Object.keys(g.responseRename)
        .sort()
        .map((k) => `${k}>${g.responseRename[k]}`)
        .join(";");
      return `${r}(${ch})[${ren}]`;
    })
    .join("|");
}

/**
 * In-memory cache segment when only API `resolution` distinguishes fetches.
 * Explore multifetch clears `exploreResampleFetchPlan` on each branch; without this, 1s/100ms/RAW
 * requests for the same channels share one cache key and return the wrong grid.
 */
export function fingerprintApiResolutionForCache(resolution: string | null | undefined): string {
  if (resolution === undefined) return "";
  if (resolution === null) return "RAW";
  const t = String(resolution).trim();
  return t === "" ? "1s" : t;
}

/** Apply after each channel-values response before merging multifetch parts. */
export function applyExploreResponseRenames(rows: any[], rename: Record<string, string>): void {
  if (!rows?.length) return;
  const pairs = Object.entries(rename).filter(([from, to]) => from !== to && to !== "");
  if (pairs.length === 0) return;
  for (const row of rows) {
    const rowKeys = () => Object.keys(row as Record<string, unknown>);
    for (const [from, to] of pairs) {
      let sourceKey: string | undefined;
      if (Object.prototype.hasOwnProperty.call(row, from)) {
        sourceKey = from;
      } else {
        const found = rowKeys().find((k) => k.toLowerCase() === from.toLowerCase());
        if (found !== undefined) sourceKey = found;
      }
      if (sourceKey === undefined) continue;
      row[to] = row[sourceKey];
      if (sourceKey !== to) delete row[sourceKey];
    }
  }
}

/**
 * Outer-merge rows on time (ms key); fills missing columns across partial fetches.
 *
 * Audit note (RAW vs resampled explore): keys are **exact integer milliseconds** from
 * timestamp/Timestamp/Datetime/ts. RAW rows and bucketed rows (e.g. 100 ms buckets) usually land on
 * **different keys**, so the merged grid is a **union** of timestamps—not one row per bucket with all
 * columns filled. Series builders then filter rows per `yPlotKey`; point counts legitimately differ.
 * Second row at the same ms merges only **empty** slots (`null`/`undefined`/`""`); it does not overwrite
 * an existing channel value (avoids clobbering when duplicate keys occur).
 */
export function mergeTimeseriesDataPointsByTimestamp(rowArrays: any[][]): any[] {
  const toMs = (item: any): number | undefined => {
    let ts = item?.timestamp;
    if (ts != null && ts !== "") {
      const n = Number(ts);
      if (!Number.isFinite(n)) return undefined;
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    ts = item?.Timestamp;
    if (ts != null && ts !== "") {
      const n = Number(ts);
      if (!Number.isFinite(n)) return undefined;
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    const dt = item?.Datetime ?? item?.datetime;
    if (dt != null) {
      const t = new Date(dt).getTime();
      return Number.isFinite(t) ? t : undefined;
    }
    const tss = item?.ts;
    if (tss != null && tss !== "") {
      const n = Number(tss);
      if (!Number.isFinite(n)) return undefined;
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    return undefined;
  };

  const map = new Map<number, any>();
  for (const rows of rowArrays) {
    if (!rows?.length) continue;
    for (const item of rows) {
      const ms = toMs(item);
      if (ms == null || ms <= 0) continue;
      const existing = map.get(ms);
      if (!existing) {
        map.set(ms, { ...item, timestamp: item.timestamp ?? ms });
      } else {
        for (const [k, v] of Object.entries(item)) {
          if (v === null || v === undefined || v === "") continue;
          const cur = existing[k];
          if (cur === undefined || cur === null || cur === "") {
            existing[k] = v;
          }
        }
      }
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);
}

/** DuckDB per-bucket aggregate for channel-values when resampling (see channel_list[].bucket_aggregate). */
export type TimeseriesBucketAggregate = "sum" | "sum_abs";

export function bucketAggregateForLineType(raw: unknown): TimeseriesBucketAggregate | undefined {
  const lt = normalizeLineType(raw);
  if (lt === "cumulative") return "sum";
  if (lt === "abs_cumulative") return "sum_abs";
  return undefined;
}

export function lineTypeDisplayLabel(raw: unknown): string {
  return LINE_TYPE_DISPLAY_LABELS[normalizeLineType(raw)];
}

/** Running totals continue across chart segments (time gaps, cuts); see `applyLineTypeToSegment(..., carryIn)`. */
export function lineTypeUsesAcrossSegmentCarry(lineType: TimeseriesLineType): boolean {
  return (
    lineType === "cumulative" ||
    lineType === "abs_cumulative" ||
    lineType === "abs_cumulative_diff"
  );
}

function timeMs(x: Date): number {
  return x instanceof Date ? x.getTime() : new Date(x).getTime();
}

/** Keep cumulative-style displayY plottable: raw high-rate series can overflow to ±Infinity and drop the whole line via isFiniteDisplayY. */
function finiteCumulativeRun(run: number): number {
  if (Number.isFinite(run)) return run;
  if (Number.isNaN(run)) return 0;
  return run === Infinity || run > Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : -Number.MAX_SAFE_INTEGER;
}

/**
 * Apply line-type transform to one continuous segment (time-ordered).
 * For `derivative` and `difference`, first point in each segment has no defined value; caller should use `.defined()` on the line.
 * For cumulative-style types, `carryIn` is the running total from prior segments (default 0).
 */
export function applyLineTypeToSegment(
  points: { x: Date; y: number }[],
  lineType: TimeseriesLineType,
  carryIn: number = 0,
  segmentOptions?: LineTypeSegmentOptions
): TransformedPoint[] {
  if (points.length === 0) return [];

  if (lineType === "standard") {
    return points.map((p) => ({
      x: p.x,
      y: p.y,
      displayY: p.y,
    }));
  }

  const n = points.length;
  const out: TransformedPoint[] = [];

  if (lineType === "cumulative") {
    // Include every bucket value (matches DuckDB SUM per resample bucket + running total).
    // Non-finite increments are skipped like abs_cumulative so NaN does not poison the run.
    let run = finiteCumulativeRun(carryIn);
    for (let i = 0; i < n; i++) {
      const yi = points[i].y;
      run = finiteCumulativeRun(run + (Number.isFinite(yi) ? yi : 0));
      out.push({ x: points[i].x, y: points[i].y, displayY: run });
    }
    return out;
  }

  if (lineType === "abs_cumulative") {
    let run = finiteCumulativeRun(carryIn);
    for (let i = 0; i < n; i++) {
      const yi = points[i].y;
      run = finiteCumulativeRun(run + (Number.isFinite(yi) ? Math.abs(yi) : 0));
      out.push({ x: points[i].x, y: points[i].y, displayY: run });
    }
    return out;
  }

  if (lineType === "abs_cumulative_diff") {
    let run = finiteCumulativeRun(carryIn);
    out.push({ x: points[0].x, y: points[0].y, displayY: run });
    for (let i = 1; i < n; i++) {
      const yPrev = points[i - 1].y;
      const yi = points[i].y;
      const step =
        Number.isFinite(yPrev) && Number.isFinite(yi) ? Math.abs(yi - yPrev) : 0;
      run = finiteCumulativeRun(run + step);
      out.push({ x: points[i].x, y: points[i].y, displayY: run });
    }
    return out;
  }

  if (lineType === "difference") {
    out.push({
      x: points[0].x,
      y: points[0].y,
      displayY: Number.NaN,
    });
    for (let i = 1; i < n; i++) {
      const yPrev = points[i - 1].y;
      const yi = points[i].y;
      const delta =
        Number.isFinite(yPrev) && Number.isFinite(yi) ? yi - yPrev : Number.NaN;
      out.push({ x: points[i].x, y: points[i].y, displayY: delta });
    }
    return out;
  }

  if (lineType === "percent_change") {
    const range = segmentOptions?.rawYRange;
    const span =
      range &&
      Number.isFinite(range.min) &&
      Number.isFinite(range.max) &&
      range.max !== range.min
        ? range.max - range.min
        : Number.NaN;
    out.push({
      x: points[0].x,
      y: points[0].y,
      displayY: Number.NaN,
    });
    for (let i = 1; i < n; i++) {
      const yPrev = points[i - 1].y;
      const yi = points[i].y;
      const delta =
        Number.isFinite(yPrev) && Number.isFinite(yi) ? yi - yPrev : Number.NaN;
      const pct =
        Number.isFinite(delta) && Number.isFinite(span) && span !== 0
          ? (delta / span) * 100
          : Number.NaN;
      out.push({ x: points[i].x, y: points[i].y, displayY: pct });
    }
    return out;
  }

  // derivative — per second (forward difference); first sample undefined
  out.push({
    x: points[0].x,
    y: points[0].y,
    displayY: Number.NaN,
  });
  for (let i = 1; i < n; i++) {
    const t0 = timeMs(points[i - 1].x);
    const t1 = timeMs(points[i].x);
    const dtSec = (t1 - t0) / 1000;
    const dy = points[i].y - points[i - 1].y;
    const rate = dtSec !== 0 && Number.isFinite(dtSec) ? dy / dtSec : Number.NaN;
    out.push({
      x: points[i].x,
      y: points[i].y,
      displayY: rate,
    });
  }
  return out;
}

export function isFiniteDisplayY(d: TransformedPoint): boolean {
  return Number.isFinite(d.displayY) && !Number.isNaN(d.displayY);
}

/** Last sample per wall-clock bucket (used to audit RAW density vs 10 Hz abs cumulative diff). */
export function decimateSeriesLastPerBucketMs(
  points: Array<{ x: Date; y: number }>,
  bucketMs: number
): Array<{ x: Date; y: number }> {
  if (points.length === 0 || !Number.isFinite(bucketMs) || bucketMs <= 0) {
    return points;
  }
  const sorted = [...points].sort((a, b) => a.x.getTime() - b.x.getTime());
  const bins = new Map<number, { x: Date; y: number }>();
  for (const p of sorted) {
    const t = p.x.getTime();
    if (!Number.isFinite(t)) continue;
    const bin = Math.floor(t / bucketMs) * bucketMs;
    const cur = bins.get(bin);
    if (!cur || t >= cur.x.getTime()) {
      bins.set(bin, { x: p.x, y: p.y });
    }
  }
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

/** Terminal value of abs_cumulative_diff (max displayY along the running sum). */
export function maxTerminalAbsCumulativeDiff(points: { x: Date; y: number }[]): number | undefined {
  if (points.length === 0) return undefined;
  const tformed = applyLineTypeToSegment(points, "abs_cumulative_diff", 0);
  let m = -Infinity;
  for (const p of tformed) {
    if (Number.isFinite(p.displayY)) {
      m = Math.max(m, p.displayY);
    }
  }
  return m === -Infinity ? undefined : m;
}

function seriesPointsForAudit(series: { data?: unknown[] }): Array<{ x: Date; y: number }> {
  const data = series.data;
  if (!Array.isArray(data) || data.length === 0) return [];
  const out: Array<{ x: Date; y: number }> = [];
  for (const d of data as Array<{ x?: unknown; y?: unknown }>) {
    if (!(d.x instanceof Date)) continue;
    const y = d.y;
    if (y === null || y === undefined) continue;
    const n = Number(y);
    if (!Number.isFinite(n)) continue;
    out.push({ x: d.x, y: n });
  }
  return out;
}

/**
 * Explore-only audit: log per-series point counts / span when the same base Y channel is plotted at
 * multiple resample modes; for abs_cumulative_diff, compare RAW path vs 100 ms last-in-bin decimation vs 10 Hz series.
 */
export function logExploreMultiResampleAudit(
  charts: Array<{ chart?: string; series?: any[] }>,
  _plan: ExploreResampleFetchPlan | null | undefined
): void {
  type Entry = {
    chartLabel: string;
    seriesIndex: number;
    baseY: string;
    mode: TimeseriesDataResample;
    lineType: TimeseriesLineType;
    yDataKey: string | undefined;
    points: Array<{ x: Date; y: number }>;
  };
  const entries: Entry[] = [];
  for (let ci = 0; ci < charts.length; ci++) {
    const chart = charts[ci];
    const chartLabel = chart.chart ?? `chart_${ci}`;
    const seriesList = chart.series ?? [];
    for (let si = 0; si < seriesList.length; si++) {
      const ser = seriesList[si];
      const yName = ser?.yaxis?.name;
      if (!yName) continue;
      const baseY = stripFleetChannelSuffix(yName);
      const mode = normalizeTimeseriesDataResample(ser.dataResample);
      const lineType = normalizeLineType(ser.lineType);
      const points = seriesPointsForAudit(ser);
      entries.push({
        chartLabel,
        seriesIndex: si,
        baseY,
        mode,
        lineType,
        yDataKey: ser.yDataKey,
        points,
      });
    }
  }
  const byBase = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byBase.get(e.baseY) ?? [];
    list.push(e);
    byBase.set(e.baseY, list);
  }
  for (const [baseY, group] of byBase) {
    if (group.length < 2) continue;
    const modes = [...new Set(group.map((g) => g.mode))];
    if (modes.length < 2) continue;

    info("[ExploreResampleAudit] multi-resolution same Y channel", {
      baseY,
      chart: group[0]?.chartLabel,
      series: group.map((g) => ({
        mode: g.mode,
        lineType: g.lineType,
        yDataKey: g.yDataKey,
        pointCount: g.points.length,
        tStart: g.points[0]?.x?.toISOString?.() ?? null,
        tEnd: g.points[g.points.length - 1]?.x?.toISOString?.() ?? null,
        sampleY: g.points.slice(0, 3).map((p) => p.y),
      })),
    });

    const rawEntry = group.find((g) => g.mode === "RAW" && g.lineType === "abs_cumulative_diff");
    const hz10 = group.find((g) => g.mode === "10HZ" && g.lineType === "abs_cumulative_diff");
    if (rawEntry && hz10 && rawEntry.points.length > 0 && hz10.points.length > 0) {
      const maxFull = maxTerminalAbsCumulativeDiff(rawEntry.points);
      const dec100 = decimateSeriesLastPerBucketMs(rawEntry.points, 100);
      const maxDec = maxTerminalAbsCumulativeDiff(dec100);
      const max10 = maxTerminalAbsCumulativeDiff(hz10.points);
      debug("[ExploreResampleAudit] abs_cumulative_diff sanity (RAW vs 100ms decimate vs 10Hz series)", {
        baseY,
        maxTerminalRawSeries: maxFull,
        maxTerminalRawDecimated100msLastPerBin: maxDec,
        maxTerminalActual10HzSeries: max10,
        rawPointCount: rawEntry.points.length,
        decimatedPointCount: dec100.length,
        hz10PointCount: hz10.points.length,
        interpretation:
          maxDec != null && max10 != null && Math.abs(maxDec - max10) / Math.max(maxDec, max10, 1e-9) < 0.15
            ? "decimated_RAW_tracks_10Hz_likely_AVG_buckets_or_finer_RAW_density"
            : "decimated_RAW_not_close_to_10Hz_inspect_merge_or_server_bucket_values",
      });
    }
  }
}
