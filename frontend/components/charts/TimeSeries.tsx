import { onMount, onCleanup, createSignal, createEffect, on, Show, For, createMemo } from "solid-js";
import * as d3 from "d3";

import LoadingOverlay from "../utilities/Loading";

import { setHasSelection, setSelection, setSelectedRange, selectedRange, cutEvents, hasSelection, clearSelection, clearActiveSelection, selectedEvents, selectedRanges, isCut } from "../../store/selectionStore";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { filterByTwa, getCurrentFilterState } from "../../utils/commonFiltering";
import { getData, formatTime } from "../../utils/global";
import { registerActiveComponent, unregisterActiveComponent } from "../../pages/Dashboard";
import { apiEndpoints } from "@config/env";
import { persistantStore } from "../../store/persistantStore";
import { sourcesStore } from "../../store/sourcesStore";
import { getEventColor, getColorByIndex } from "../../utils/colorScale";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";

import { selectedTime, setSelectedTime, isPlaying, setIsPlaying, playbackSpeed, setIsManualTimeChange, isManualTimeChange, requestTimeControl, releaseTimeControl, timeWindow, getDisplayWindowReferenceTime, smoothPlaybackTimeForTrack } from "../../store/playbackStore";
import { debug, warn, info, log, error as logError, data as logData } from "../../utils/console";
import {
  applyLineTypeToSegment,
  normalizeLineType,
  isFiniteDisplayY,
  lineTypeDisplayLabel,
  lineTypeUsesAcrossSegmentCarry,
  dataResampleLegendBracket,
  buildExploreResampleFetchPlan,
  rawReadingPlotKeyForExploreChannel,
  useRawReadingsForCumulativeLineTypes,
  type ExploreResampleFetchPlan,
  type TransformedPoint,
  type TimeseriesLineType,
} from "../../utils/timeseriesSeriesTransforms";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName } = persistantStore;

/** Display name for a series: user-editable label or channel name. Used for legend, tooltips, titles only; data lookup uses series.yaxis.name. */
function seriesDisplayName(series: { label?: string; yaxis?: { name?: string } } | undefined): string {
  return series?.label ?? series?.yaxis?.name ?? "Series";
}

/** Unique sorted line-type labels for fleet chart corner caption (showLegendTable). */
function fleetChartLineTypeSummary(seriesList: Array<{ lineType?: unknown }>): string {
  if (!seriesList?.length) {
    return lineTypeDisplayLabel(undefined);
  }
  const unique = new Set<string>();
  for (const s of seriesList) {
    unique.add(lineTypeDisplayLabel(s.lineType));
  }
  return [...unique].sort((a, b) => a.localeCompare(b)).join(" · ");
}

// Persist across re-renders so we don't re-run "clear and reset" when effect re-fires after store updates.
let lastClearedZoomState = '';

let warnedCumulativeLineTypesNoRawProcessSync = false;

// Helper function to safely format a date to ISO string
const safeToISOString = (date: Date | number | string): string => {
  try {
    const d = new Date(date);
    return isNaN(d.getTime()) ? 'Invalid Date' : d.toISOString();
  } catch {
    return 'Invalid Date';
  }
};

function pointTimeMs(x: unknown): number {
  if (x instanceof Date) return x.getTime();
  return new Date(x as string | number).getTime();
}

/** Chronological order so in-window points are contiguous when iterating (merged RAW rows can arrive out of time order). */
function sortSeriesPointsByTime<T extends { x: unknown }>(data: T[] | undefined | null): T[] {
  return [...(data ?? [])].sort((a, b) => pointTimeMs(a.x) - pointTimeMs(b.x));
}

/**
 * Explore “Raw Value” (standard) with no multi-cut: literally one polyline — all in-window samples, time-sorted.
 * Avoids the generic segment walker (gaps, merge order) for the common case; still one SVG path via d3.line.
 */
function exploreStandardPolylineRawSegments(
  data: Array<{ x: Date; y: number | null | undefined }>,
  domainLo: Date,
  domainHi: Date
): Array<Array<{ x: Date; y: number }>> {
  const pts: Array<{ x: Date; y: number }> = [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (d.x < domainLo || d.x > domainHi) continue;
    if (d.y === null || d.y === undefined || Number.isNaN(Number(d.y)) || !isFinite(Number(d.y))) continue;
    const x = d.x instanceof Date ? d.x : new Date(d.x as unknown as string | number);
    pts.push({ x, y: Number(d.y) });
  }
  if (pts.length === 0) return [];
  pts.sort((a, b) => pointTimeMs(a.x) - pointTimeMs(b.x));
  return [pts];
}

/** Split series into contiguous segments inside [domainLo, domainHi] by time gap and optional cut-range boundaries. */
function splitSeriesIntoVisibleSegments(
  data: Array<{ x: Date; y: number | null | undefined }>,
  domainLo: Date,
  domainHi: Date,
  timeThresholdMs: number,
  getCutRangeIndex?: (point: { x: Date; y: number }) => number
): Array<Array<{ x: Date; y: number }>> {
  const segments: Array<Array<{ x: Date; y: number }>> = [];
  let current: Array<{ x: Date; y: number }> = [];
  const hasCut = typeof getCutRangeIndex === "function";

  for (let i = 0; i < data.length; i++) {
    const point = data[i];
    if (
      point.x >= domainLo &&
      point.x <= domainHi &&
      point.y !== null &&
      point.y !== undefined &&
      !Number.isNaN(Number(point.y))
    ) {
      const y = Number(point.y);
      let shouldBreak = false;
      if (current.length > 0) {
        const prevPoint = current[current.length - 1];
        const timeDiff = Math.abs(pointTimeMs(point.x) - pointTimeMs(prevPoint.x));
        if (timeDiff >= timeThresholdMs) {
          shouldBreak = true;
        }
        if (hasCut) {
          const prevIdx = getCutRangeIndex!({ x: prevPoint.x, y: prevPoint.y });
          const currIdx = getCutRangeIndex!({ x: point.x as Date, y });
          if (prevIdx !== currIdx && (prevIdx >= 0 || currIdx >= 0)) {
            shouldBreak = true;
          }
        }
      }
      if (shouldBreak) {
        if (current.length >= 1) {
          segments.push([...current]);
        }
        current = [{ x: point.x as Date, y }];
      } else {
        current.push({ x: point.x as Date, y });
      }
    } else if (current.length > 0) {
      if (current.length >= 1) {
        segments.push([...current]);
      }
      current = [];
    }
  }
  if (current.length >= 1) {
    segments.push(current);
  }
  return segments;
}

/** Finite raw `y` min/max over all visible segments (for percent_change scaling). */
function rawYMinMaxAcrossSegments(
  rawSegs: Array<Array<{ x: Date; y: number }>>
): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const seg of rawSegs) {
    for (const p of seg) {
      if (Number.isFinite(p.y)) {
        min = Math.min(min, p.y);
        max = Math.max(max, p.y);
      }
    }
  }
  if (min === Infinity || max === -Infinity) return undefined;
  return { min, max };
}

/** Apply transform per segment; cumulative-style line types keep one running total across segments. */
function applyLineTypeToSegmentsWithOptionalCarry(
  rawSegs: Array<Array<{ x: Date; y: number }>>,
  lineType: TimeseriesLineType
): TransformedPoint[][] {
  const useCarry = lineTypeUsesAcrossSegmentCarry(lineType);
  const percentOpts =
    lineType === "percent_change"
      ? { rawYRange: rawYMinMaxAcrossSegments(rawSegs) }
      : undefined;
  let carry = 0;
  const out: TransformedPoint[][] = [];
  for (const seg of rawSegs) {
    const t = applyLineTypeToSegment(seg, lineType, useCarry ? carry : 0, percentOpts);
    out.push(t);
    if (useCarry && t.length > 0) {
      const last = t[t.length - 1];
      if (isFiniteDisplayY(last)) {
        carry = last.displayY;
      }
    }
  }
  return out;
}

/**
 * Hold first/last sample y to the visible x-domain edges so resampled series (1 Hz / 10 Hz) draw to the same
 * horizontal extent as RAW; avoids polylines that stop short inside a wider zoom/domain.
 * Only for standard (raw value) lines — other line types need real samples at those times.
 */
function extendStandardSegmentsToVisibleDomain(
  segments: TransformedPoint[][],
  domainLo: Date,
  domainHi: Date
): TransformedPoint[][] {
  const loMs = domainLo.getTime();
  const hiMs = domainHi.getTime();
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs) || loMs >= hiMs) {
    return segments;
  }
  const n = segments.length;
  return segments.map((seg, idx) => {
    const finite = seg.filter(isFiniteDisplayY);
    if (finite.length === 0) {
      return seg;
    }
    const next = [...seg];
    const first = finite[0];
    const last = finite[finite.length - 1];
    const firstMs = pointTimeMs(first.x);
    const lastMs = pointTimeMs(last.x);
    if (idx === 0 && firstMs > loMs) {
      next.unshift({
        x: new Date(loMs),
        y: first.y,
        displayY: first.displayY,
      });
    }
    if (idx === n - 1 && lastMs < hiMs) {
      next.push({
        x: new Date(hiMs),
        y: last.y,
        displayY: last.displayY,
      });
    }
    return next.sort((a, b) => pointTimeMs(a.x) - pointTimeMs(b.x));
  });
}

function fillColorHalfOpacity(cssColor: string): string {
  const c = d3.color(cssColor);
  if (!c) {
    return "rgba(128, 128, 128, 0.5)";
  }
  c.opacity = 0.5;
  return c.formatRgb();
}

function collectFiniteDisplayYValues(
  series: { data: Array<{ x: Date; y: number | null | undefined }>; lineType?: unknown },
  domainLo: Date,
  domainHi: Date,
  timeThresholdMs: number,
  getCutRangeIndex?: (point: { x: Date; y: number }) => number
): number[] {
  const lineType = normalizeLineType(series.lineType);
  const rawSegs = splitSeriesIntoVisibleSegments(series.data, domainLo, domainHi, timeThresholdMs, getCutRangeIndex);
  const transformed = applyLineTypeToSegmentsWithOptionalCarry(rawSegs, lineType);
  const out: number[] = [];
  for (const t of transformed) {
    for (const p of t) {
      if (isFiniteDisplayY(p)) {
        out.push(p.displayY);
      }
    }
  }
  return out;
}

/** Raw finite y values whose x lies in [domainLo, domainHi] (for y-domain when transform path is empty). */
function collectVisibleWindowRawYValues(
  series: { data: Array<{ x: Date; y: number | null | undefined }> },
  domainLo: Date,
  domainHi: Date
): number[] {
  const out: number[] = [];
  for (const d of series.data) {
    if (d.x < domainLo || d.x > domainHi) continue;
    if (d.y === null || d.y === undefined || Number.isNaN(Number(d.y)) || !isFinite(Number(d.y))) continue;
    out.push(Number(d.y));
  }
  return out;
}

/** Nearest sample's displayY to `targetTimeMs` within segments in x-domain (for legend / tooltips). */
function getTransformedValueAtClosestTime(
  series: { data: Array<{ x: Date; y: number | null | undefined }>; lineType?: unknown },
  targetTimeMs: number,
  domainLo: Date,
  domainHi: Date,
  segmentGapMs: number,
  getCutRangeIndex?: (point: { x: Date; y: number }) => number,
  maxSampleDistanceMs: number = CLOSEST_SAMPLE_TOOLTIP_MAX_MS
): number | undefined {
  const lineType = normalizeLineType(series.lineType);
  const rawSegs = splitSeriesIntoVisibleSegments(series.data, domainLo, domainHi, segmentGapMs, getCutRangeIndex);
  const transformed = applyLineTypeToSegmentsWithOptionalCarry(rawSegs, lineType);
  let bestT: number | undefined;
  let bestY: number | undefined;
  for (const tseg of transformed) {
    for (const p of tseg) {
      if (!isFiniteDisplayY(p)) continue;
      const t = pointTimeMs(p.x);
      if (bestT === undefined || Math.abs(t - targetTimeMs) < Math.abs(bestT - targetTimeMs)) {
        bestT = t;
        bestY = p.displayY;
      }
    }
  }
  if (bestT !== undefined && bestY !== undefined && Math.abs(bestT - targetTimeMs) <= maxSampleDistanceMs) {
    return bestY;
  }
  // Nearest sample in visible window by raw y (standard line type only; avoids missing Sel on singleton segments / edge cases)
  if (normalizeLineType(series.lineType) !== "standard") {
    return undefined;
  }
  let rawBestT: number | undefined;
  let rawBestY: number | undefined;
  for (const d of series.data) {
    if (d.x < domainLo || d.x > domainHi) continue;
    if (d.y === null || d.y === undefined || Number.isNaN(Number(d.y)) || !isFinite(Number(d.y))) continue;
    const t = pointTimeMs(d.x);
    if (rawBestT === undefined || Math.abs(t - targetTimeMs) < Math.abs(rawBestT - targetTimeMs)) {
      rawBestT = t;
      rawBestY = Number(d.y);
    }
  }
  if (
    rawBestT !== undefined &&
    rawBestY !== undefined &&
    Math.abs(rawBestT - targetTimeMs) <= maxSampleDistanceMs
  ) {
    return rawBestY;
  }
  return undefined;
}

/**
 * One-time transformed timeline for a series in [domainLo, domainHi] (for explore stacked areas).
 * Avoids re-running split + line-type transforms per stack grid sample.
 */
function precomputeTransformedDisplayTimeline(
  series: { data: Array<{ x: Date; y: number | null | undefined }>; lineType?: unknown },
  domainLo: Date,
  domainHi: Date,
  segmentGapMs: number,
  getCutRangeIndex?: (point: { x: Date; y: number }) => number
): { t: number; y: number }[] {
  const lineType = normalizeLineType(series.lineType);
  const rawSegs = splitSeriesIntoVisibleSegments(series.data, domainLo, domainHi, segmentGapMs, getCutRangeIndex);
  const transformed = applyLineTypeToSegmentsWithOptionalCarry(rawSegs, lineType);
  const pts: { t: number; y: number }[] = [];
  for (const tseg of transformed) {
    for (const p of tseg) {
      if (!isFiniteDisplayY(p)) continue;
      pts.push({ t: pointTimeMs(p.x), y: p.displayY });
    }
  }
  if (pts.length === 0) return [];
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

function interpSortedTY(pts: { t: number; y: number }[], tMs: number): number | null {
  if (pts.length === 0) return null;
  if (tMs <= pts[0].t) return pts[0].y;
  if (tMs >= pts[pts.length - 1].t) return pts[pts.length - 1].y;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (a.t === b.t) return a.y;
  const u = (tMs - a.t) / (b.t - a.t);
  return a.y + u * (b.y - a.y);
}

/** Uniform time grid for stacking — avoids collecting/sorting every distinct timestamp in the window. */
const EXPLORE_STACK_GRID_POINTS = 1000;

function uniformStackGridTimesMs(domainLo: Date, domainHi: Date, pointCount: number): number[] {
  const lo = pointTimeMs(domainLo);
  const hi = pointTimeMs(domainHi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  const n = Math.max(2, Math.min(pointCount, 2000));
  if (hi <= lo) {
    return [lo, lo];
  }
  const out: number[] = new Array(n);
  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    out[i] = lo + (span * i) / (n - 1);
  }
  return out;
}

function exploreStackExtent(stacked: d3.Series<Record<string, number>, string>[]): [number, number] {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const layer of stacked) {
    for (let j = 0; j < layer.length; j++) {
      const d = layer[j];
      ymin = Math.min(ymin, d[0], d[1]);
      ymax = Math.max(ymax, d[0], d[1]);
    }
  }
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax)) return [0, 1];
  return [ymin, ymax];
}

type ExploreStackedPlan = {
  gridTimes: number[];
  stacked: d3.Series<Record<string, number>, string>[];
};

function buildExploreStackedRenderPlan(
  seriesList: Array<{ data: Array<{ x: Date; y: number | null | undefined }>; lineType?: unknown }>,
  domainLo: Date,
  domainHi: Date,
  segmentGapMs: number,
  getCutRangeIndex?: (point: { x: Date; y: number }) => number
): ExploreStackedPlan | null {
  if (seriesList.length === 0) return null;
  const gridTimes = uniformStackGridTimesMs(domainLo, domainHi, EXPLORE_STACK_GRID_POINTS);
  if (gridTimes.length < 2) return null;

  const timelines = seriesList.map((s) =>
    precomputeTransformedDisplayTimeline(s, domainLo, domainHi, segmentGapMs, getCutRangeIndex)
  );

  const keys = seriesList.map((_, i) => String(i));
  const rows: Record<string, number>[] = gridTimes.map((tMs) => {
    const row: Record<string, number> = {};
    for (let i = 0; i < seriesList.length; i++) {
      const y = interpSortedTY(timelines[i], tMs);
      row[String(i)] = y != null && Number.isFinite(y) ? y : 0;
    }
    return row;
  });
  const stacker = d3.stack<Record<string, number>>().keys(keys).order(d3.stackOrderNone).offset(d3.stackOffsetNone);
  const stacked = stacker(rows);
  return { gridTimes, stacked };
}

// Helper function to convert stroke style to SVG stroke-dasharray
const getStrokeDasharray = (strokeStyle: string | null | undefined): string | null => {
  if (
    !strokeStyle ||
    strokeStyle === "solid" ||
    strokeStyle === "filled-area" ||
    strokeStyle === "stacked-area"
  ) {
    return null; // null means no dasharray (solid line)
  }

  const styleMap: Record<string, string> = {
    dashed: "5,5",
    "dash-dash": "10,5,5,5",
    "bigdash-dash": "15,5,5,5",
    dotted: "2,2",
    "dash-dot": "10,5,2,5",
  };

  return styleMap[strokeStyle] ?? null;
};

/**
 * Compute a safe numeric y-domain from raw values.
 * 
 * RACE_NUMBER DUAL-ROLE: When Race_number is used as a data channel (y-axis):
 * - Data contains: Race_number: -1 (numeric) from backend
 * - This function: Converts to number, filters out NaN/non-finite
 * - Result: -1 is plotted on numeric scale (not "TRAINING" string)
 * 
 * INTEGER VALUES: For integer-based channels (e.g. Race_number, Leg_number),
 * centers the y-scale on median with ±10% padding instead of using min/max.
 * 
 * See: frontend/utils/raceValueUtils.ts for centralized race value handling
 */
function safeNumericYDomain(values: unknown[]): [number, number] {
  const numeric = values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((v) => !Number.isNaN(v) && Number.isFinite(v));
  const extent = d3.extent(numeric);
  const lo = extent[0];
  const hi = extent[1];
  if (lo != null && hi != null) {
    if (lo === hi) {
      // Single value: center it with padding so min < value < max
      const pad = lo === 0 ? 1 : Math.max(1, Math.abs(lo) * 0.1);
      return [lo - pad, lo + pad];
    }
    // Integer-based values: center on median with ±10% padding (extend to include all data)
    const allIntegers = numeric.every((v) => v === Math.floor(v) || v === Math.ceil(v));
    if (allIntegers) {
      const median = d3.median(numeric) ?? (lo + hi) / 2;
      const padding = median === 0 ? 1 : Math.max(1, Math.abs(median) * 0.1);
      const domainMin = Math.min(median - padding, lo);
      const domainMax = Math.max(median + padding, hi);
      return [domainMin, domainMax];
    }
    return [lo, hi];
  }
  return [0, 100];
}

// ----- Legend table (for FleetTimeSeries) -----
const LEGEND_TABLE_TIME_THRESHOLD_MS = 30000;

/** Time gap (ms) after which fleet charts split polylines. Explore uses Infinity so sparse RAW (merged timeline) stays one connected line; cuts / domain still split. */
const FLEET_TIME_SERIES_GAP_SPLIT_MS = 30000;

/** Max |sample − hover time| for chart tooltips (ms); skip value when cursor is far from data. */
const CLOSEST_SAMPLE_TOOLTIP_MAX_MS = 30000;

/** Scrub line, on-chart value dots, legend [Sel]: always use nearest in-window sample (sparse RAW can be ≫30s from click). */
const CLOSEST_SAMPLE_UI_MARKER_MAX_MS = Number.POSITIVE_INFINITY;

function exploreChartSegmentGapSplitMs(isExploreLayout: boolean): number {
  return isExploreLayout ? Number.POSITIVE_INFINITY : FLEET_TIME_SERIES_GAP_SPLIT_MS;
}

function legendTableFormatStat(val: number | undefined | null): string {
  if (val === undefined || val === null || Number.isNaN(val) || !Number.isFinite(val)) return "—";
  return String(Number(Math.round(val * 100) / 100));
}

export interface LegendRow {
  name: string;
  /** Display in table: team name only (part after " - ") */
  teamName: string;
  color: string;
  selected: string;
  avg: string;
  min: string;
  max: string;
  std: string;
}

/** Chart shape used by legend table (series with yaxis, color, data) */
interface LegendChartSeries {
  xaxis?: { name: string };
  yaxis?: { name: string };
  color?: string;
  lineType?: unknown;
  data: Array<{ x: Date; y: number }>;
}

interface LegendChartConfig {
  chart?: string;
  series: LegendChartSeries[];
}

/** Team label for fleet legend rows and swatch highlight (must match table dedupe key). */
function fleetTeamNameFromSeries(series: { yaxis?: { name?: string } }): string {
  const channelName = series.yaxis?.name ?? "";
  const dashIdx = channelName.indexOf(" - ");
  return dashIdx >= 0 ? channelName.slice(dashIdx + 3).trim() : channelName;
}

function legendTableToTimestamp(d: Date | number): number {
  const date = d instanceof Date ? d : new Date(d);
  return date.getTime();
}

/** Time range in ms for filtering series data to brush/selection */
type LegendTableRangeFilter = { start: number; end: number }[];

/** Convert selection store ranges to { start, end }[] in ms for legend table filtering */
function getLegendTableRangeFilter(): LegendTableRangeFilter | null {
  const brush = selectedRange();
  const multi = selectedRanges();
  const ranges: { start: number; end: number }[] = [];
  const add = (item: { start_time?: string; end_time?: string }) => {
    if (item?.start_time != null && item?.end_time != null) {
      const start = new Date(item.start_time).getTime();
      const end = new Date(item.end_time).getTime();
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end });
    }
  };
  if (brush?.length) brush.forEach(add);
  else if (multi?.length) multi.forEach(add);
  return ranges.length > 0 ? ranges : null;
}

/** Time-order and split by gap for fleet legend stats (no cut-aware split). */
function splitPointsByTimeGapForLegend(
  points: Array<{ x: Date; y: number }>,
  timeThresholdMs: number
): Array<Array<{ x: Date; y: number }>> {
  if (points.length === 0) return [];
  const sorted = [...points].sort(
    (a, b) => legendTableToTimestamp(a.x) - legendTableToTimestamp(b.x)
  );
  const segments: Array<Array<{ x: Date; y: number }>> = [];
  let cur: Array<{ x: Date; y: number }> = [];
  const flush = () => {
    if (cur.length > 0) {
      segments.push([...cur]);
      cur = [];
    }
  };
  for (const p of sorted) {
    if (cur.length === 0) {
      cur = [p];
    } else {
      const prev = cur[cur.length - 1];
      if (
        Math.abs(legendTableToTimestamp(p.x) - legendTableToTimestamp(prev.x)) >= timeThresholdMs
      ) {
        flush();
        cur = [p];
      } else {
        cur.push(p);
      }
    }
  }
  flush();
  return segments;
}

function collectDisplayYsForLegendTable(
  points: Array<{ x: Date; y: number }>,
  lineTypeRaw: unknown
): number[] {
  const lineType = normalizeLineType(lineTypeRaw);
  const segs = splitPointsByTimeGapForLegend(points, LEGEND_TABLE_TIME_THRESHOLD_MS);
  const transformed = applyLineTypeToSegmentsWithOptionalCarry(segs, lineType);
  const out: number[] = [];
  for (const t of transformed) {
    for (const p of t) {
      if (isFiniteDisplayY(p)) {
        out.push(p.displayY);
      }
    }
  }
  return out;
}

function computeLegendRows(
  chart: LegendChartConfig,
  currentTime: Date | null,
  rangeFilter: LegendTableRangeFilter | null,
  /** When set (fleet chart after draw), stats and Sel use the same visible x-domain and segment rules as the plot (critical for cumulative / derivative / etc.). */
  visibleXDomain: { lo: Date; hi: Date } | null
): LegendRow[] {
  if (!chart.series?.length) return [];
  const seenTeamNames = new Set<string>();
  return chart.series
    .map((series) => {
      let dataToUse = series.data || [];
      if (rangeFilter?.length) {
        dataToUse = dataToUse.filter((d) => {
          const t = legendTableToTimestamp(d.x);
          return rangeFilter.some((r) => t >= r.start && t <= r.end);
        });
      }
      const validPoints = dataToUse.filter(
        (d) => d.y != null && !Number.isNaN(d.y) && Number.isFinite(d.y)
      ) as Array<{ x: Date; y: number }>;

      let displayYs: number[];
      let min: number | undefined;
      let max: number | undefined;
      let avg: number | undefined;
      let std: number | undefined;

      if (visibleXDomain) {
        const { lo, hi } = visibleXDomain;
        displayYs = collectFiniteDisplayYValues(
          { data: series.data || [], lineType: series.lineType },
          lo,
          hi,
          LEGEND_TABLE_TIME_THRESHOLD_MS
        );
        const n = displayYs.length;
        if (n > 0) {
          min = Math.min(...displayYs);
          max = Math.max(...displayYs);
          const mean = displayYs.reduce((a, b) => a + b, 0) / n;
          avg = mean;
          std = Math.sqrt(displayYs.reduce((s, y) => s + (y - mean) ** 2, 0) / n);
        }
      } else {
        displayYs = collectDisplayYsForLegendTable(validPoints, series.lineType);
        const n = displayYs.length;
        min = n > 0 ? Math.min(...displayYs) : undefined;
        max = n > 0 ? Math.max(...displayYs) : undefined;
        avg = n > 0 ? displayYs.reduce((a, b) => a + b, 0) / n : undefined;
        std =
          n > 0 && avg != null
            ? Math.sqrt(displayYs.reduce((s, y) => s + (y - avg) ** 2, 0) / n)
            : undefined;
      }

      let selected: string = "—";
      if (currentTime) {
        const tMs = currentTime.getTime();
        if (visibleXDomain) {
          const selY = getTransformedValueAtClosestTime(
            { data: series.data || [], lineType: series.lineType },
            tMs,
            visibleXDomain.lo,
            visibleXDomain.hi,
            LEGEND_TABLE_TIME_THRESHOLD_MS,
            undefined,
            CLOSEST_SAMPLE_UI_MARKER_MAX_MS
          );
          if (selY !== undefined) {
            selected = legendTableFormatStat(selY);
          }
        } else if (validPoints.length > 0) {
          const tMin = new Date(
            Math.min(...validPoints.map((p) => legendTableToTimestamp(p.x)))
          );
          const tMax = new Date(
            Math.max(...validPoints.map((p) => legendTableToTimestamp(p.x)))
          );
          const selY = getTransformedValueAtClosestTime(
            { data: validPoints, lineType: series.lineType },
            tMs,
            tMin,
            tMax,
            LEGEND_TABLE_TIME_THRESHOLD_MS,
            undefined,
            CLOSEST_SAMPLE_UI_MARKER_MAX_MS
          );
          if (selY !== undefined) {
            selected = legendTableFormatStat(selY);
          }
        }
      }

      const fullName = seriesDisplayName(series);
      const teamName = fleetTeamNameFromSeries(series);

      return {
        name: fullName,
        teamName,
        color: series.color || "#1f77b4",
        selected,
        avg: legendTableFormatStat(avg),
        min: legendTableFormatStat(min),
        max: legendTableFormatStat(max),
        std: legendTableFormatStat(std),
      };
    })
    .filter((row) => {
      if (seenTeamNames.has(row.teamName)) return false;
      seenTeamNames.add(row.teamName);
      return true;
    });
}

function legendRowsToTsv(rows: LegendRow[]): string {
  const header = ["Series", "Sel", "Avg", "Min", "Max", "Std"];
  const lines = [header.join("\t")];
  for (const row of rows) {
    lines.push([row.teamName, row.selected, row.avg, row.min, row.max, row.std].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

type LegendSortKey = "teamName" | "selected" | "avg" | "min" | "max" | "std";

function parseLegendTableStatNumber(s: string): number | null {
  if (s === "—" || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Null / missing stats sort after finite numbers (stable relative order among nulls). */
function compareLegendTableStatCells(a: string, b: string, dir: 1 | -1): number {
  const na = parseLegendTableStatNumber(a);
  const nb = parseLegendTableStatNumber(b);
  const aNull = na === null;
  const bNull = nb === null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return (na - nb) * dir;
}

function sortLegendRows(rows: LegendRow[], key: LegendSortKey, dir: 1 | -1): LegendRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (key === "teamName") {
      return a.teamName.localeCompare(b.teamName, undefined, { sensitivity: "base" }) * dir;
    }
    return compareLegendTableStatCells(a[key], b[key], dir);
  });
  return out;
}

const LEGEND_TABLE_SORT_KEYS: { key: LegendSortKey; label: string }[] = [
  { key: "teamName", label: "Series" },
  { key: "selected", label: "Sel" },
  { key: "avg", label: "Avg" },
  { key: "min", label: "Min" },
  { key: "max", label: "Max" },
  { key: "std", label: "Std" },
];

/** HTML table legend: series name, selected value, min, max, std (used when showLegendTable in FleetTimeSeries) */
function LegendTable(props: {
  chart: LegendChartConfig;
  highlightedTeams: () => string[];
  onToggleTeam: (teamName: string) => void;
  /** Bumped after each fleet chart draw so zoom/pan (D3) re-runs stats. */
  chartLayoutEpoch?: () => number;
  /** Current x zoom domain; must match plot for cumulative / transformed line types. */
  getVisibleXDomain?: () => { lo: Date; hi: Date } | null;
}) {
  const rows = createMemo(() => {
    props.chartLayoutEpoch?.();
    const rangeFilter = getLegendTableRangeFilter();
    const visibleX = props.getVisibleXDomain?.() ?? null;
    return computeLegendRows(props.chart, selectedTime(), rangeFilter, visibleX);
  });

  const [sortKey, setSortKey] = createSignal<LegendSortKey>("teamName");
  const [sortDir, setSortDir] = createSignal<1 | -1>(1);

  const sortedRows = createMemo(() =>
    sortLegendRows(rows(), sortKey(), sortDir())
  );

  const toggleLegendSort = (key: LegendSortKey) => {
    if (sortKey() === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  const [isHovered, setIsHovered] = createSignal(false);
  const [showCopy, setShowCopy] = createSignal(false);
  const [copySuccess, setCopySuccess] = createSignal(false);

  createEffect(() => {
    if (isHovered()) {
      const timer = setTimeout(() => setShowCopy(true), 2000);
      onCleanup(() => clearTimeout(timer));
    } else {
      setShowCopy(false);
    }
  });

  const copyLegendToClipboard = async () => {
    try {
      const text = legendRowsToTsv(sortedRows());
      log("TimeSeries: copy fleet legend table to clipboard", { textLength: text.length });
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
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
      logError("TimeSeries: copy fleet legend table failed", err);
    }
  };

  return (
    <div
      class="copy-table-hover-wrapper"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <table class="timeseries-legend-table">
        <thead>
          <tr>
            <For each={LEGEND_TABLE_SORT_KEYS}>
              {(col) => {
                const active = () => sortKey() === col.key;
                const ariaSort = () =>
                  active() ? (sortDir() === 1 ? "ascending" : "descending") : "none";
                return (
                  <th scope="col" aria-sort={ariaSort()}>
                    <button
                      type="button"
                      class="timeseries-legend-th-btn"
                      classList={{ "timeseries-legend-th-btn-active": active() }}
                      onClick={() => toggleLegendSort(col.key)}
                    >
                      <span>{col.label}</span>
                      <span class="timeseries-legend-sort-ind" aria-hidden="true">
                        {active() ? (sortDir() === 1 ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                );
              }}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={sortedRows()} fallback={null}>
            {(row) => (
              <tr>
                <td>
                  <button
                    type="button"
                    class="timeseries-legend-swatch"
                    classList={{
                      "timeseries-legend-swatch-selected":
                        props.highlightedTeams().length > 0 &&
                        props.highlightedTeams().includes(row.teamName),
                    }}
                    style={{ "background-color": row.color }}
                    aria-label={`Highlight series ${row.teamName}`}
                    aria-pressed={props.highlightedTeams().includes(row.teamName)}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onToggleTeam(row.teamName);
                    }}
                  />
                  {row.teamName}
                </td>
                <td>{row.selected}</td>
                <td>{row.avg}</td>
                <td>{row.min}</td>
                <td>{row.max}</td>
                <td>{row.std}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={showCopy() && rows().length > 0}>
        <div class="copy-table-data-actions">
          <button
            type="button"
            class="copy-table-data-btn"
            classList={{ "copy-table-data-btn-success": copySuccess() }}
            onClick={copyLegendToClipboard}
          >
            {copySuccess() ? "✓ Copied!" : "Copy Table Data"}
          </button>
        </div>
      </Show>
    </div>
  );
}

// ----- End legend table -----

interface TimeSeriesProps {
  chart?: any;
  showLegendTable?: boolean;
  [key: string]: any;
}

const TimeSeries = (props: TimeSeriesProps) => {
  const [isZoomed, setZoom] = createSignal(false);
  // Store initial playback state
  const [initialPlayState, setInitialPlayState] = createSignal(false);
  const [datasetTimezone, setDatasetTimezone] = createSignal<string | null>(null);
  const [refsReady, setRefsReady] = createSignal(false);
  /** Incremented after each fleet multi-chart draw so legend table tracks D3 zoom domain. */
  const [fleetLegendTableEpoch, bumpFleetLegendTableEpoch] = createSignal(0);
  // Remove the signals but keep a ref for tracking last update
  let lastUpdateTime = 0;
  let lastTimeWindowRedrawTime = 0; // Throttle timeWindow-driven redraws when playing (FleetTimeSeries loop fix)
  let lastTimeWindowDebugLog = 0; // Throttle debug logging for time-window effect
  let timeWindowRafId: number | null = null;
  let animationFrameId: number | null = null;
  let isProgrammaticallyUpdatingBrush = false; // Flag to prevent infinite loops when updating brush programmatically
  let shouldSkipBrushRestoreAfterZoom = false; // Flag to skip brush restoration after zooming from brush selection
  let lastBrushCreateTime = 0; // When the current brush was created (ignore "end" with no selection shortly after create)

  // Set up timezone from dataset
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    let datasetId: number | null = null;

    if (typeof selectedDatasetId === 'function') {
      const dsId = selectedDatasetId();
      datasetId = dsId ? Number(dsId) : null;
    } else if (selectedDatasetId) {
      datasetId = Number(selectedDatasetId);
    }

    if (className && projectId && datasetId && datasetId > 0) {
      await setCurrentDataset(className, projectId, datasetId);
    }

    // Always check for timezone (works for both dataset mode and fleet/day mode)
    // In fleet/day mode, timezone is set via setCurrentDataset() from date endpoint
    // Calling getCurrentDatasetTimezone() here tracks the signal so effect re-runs when timezone changes
    const tz = getCurrentDatasetTimezone();
    setDatasetTimezone(tz);
  });
  let isTimeSeriesSettingSelectedRange = false; // Flag to track when TimeSeries component is setting selectedRange
  let isRedrawing = false; // Flag to prevent redraw from triggering selection clearing effect
  let appliedTimeWindowInitialization = false; // Guard to apply timeWindow-based range once on mount

  // Sliding-window burst detection for chart effect (lifetime counter falsely tripped after several legitimate fleet/filter updates)
  let chartChangesEffectTimestamps: number[] = [];
  const CHART_EFFECT_BURST_MS = 2000;
  const CHART_EFFECT_BURST_MAX = 20;
  let mapFilteringEffectCount = 0;
  let processDataForChartsCount = 0;
  let lastChartEffectTime = 0;
  let getDataFromUnifiedStoreCount = 0;

  // Brush activation functions (moved to component scope for cleanup)
  let activateBrush: (() => void) | null = null;
  let deactivateBrush: (() => void) | null = null;

  // SVG and wheel handler (moved to component scope for cleanup)
  let svg: d3.Selection<SVGElement, unknown, null, undefined> | null = null;
  let wheelHandler: ((event: WheelEvent) => void) | null = null;

  // Flags to prevent infinite loops
  let isProcessingData = false;
  let isFetchingData = false;
  let lastProcessDataTime = 0;
  let lastFetchDataTime = 0;
  let chartEffectTimeout: ReturnType<typeof setTimeout> | null = null;
  let mapFilterEffectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Resize detection variables
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;

  // Data fetching signals
  const [charts, setCharts] = createSignal<any[]>([]);
  const [fleetLegendHighlightNames, setFleetLegendHighlightNames] = createSignal<string[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);
  const [dataLoadingMessage, setDataLoadingMessage] = createSignal<string>('');
  const [isDataLoading, setIsDataLoading] = createSignal(false);

  let containerRef: HTMLElement | null = null;

  const requestFleetChartRedraw = () => {
    if (!containerRef) return;
    const refs = d3.select(containerRef).property("__timeSeriesRefs") as { redraw?: () => void } | undefined;
    refs?.redraw?.();
  };

  const toggleFleetLegendHighlight = (teamName: string) => {
    const key = String(teamName ?? "").trim();
    if (!key) return;
    setFleetLegendHighlightNames((prev) =>
      prev.includes(key) ? prev.filter((n) => n !== key) : [...prev, key]
    );
    queueMicrotask(() => {
      requestFleetChartRedraw();
    });
  };

  // Centralized filtering function for time series data
  const applyFilters = (data: any[]): any[] => {
    if (!data || !Array.isArray(data)) return data;

    // For time series, we need to filter the underlying data points
    // This assumes the data structure has the same format as map data
    const filterState = getCurrentFilterState();
    return filterByTwa(data, filterState.selectedStates, filterState.selectedRaces, filterState.selectedLegs, filterState.selectedGrades);
  };

  // Function to retrieve data from unified filtering system using IndexedDB
  const getDataFromUnifiedStore = async () => {
    getDataFromUnifiedStoreCount++;
    debug('🔄 TimeSeries: getDataFromUnifiedStore called', {
      callCount: getDataFromUnifiedStoreCount,
      hasChart: !!props.chart,
      chartType: typeof props.chart,
      isArray: Array.isArray(props.chart),
      isFetchingData,
      timestamp: new Date().toISOString()
    });

    // Fleet day explore (FleetTimeSeries): parent fetches per-boat data; global source is often "ALL".
    // Never run single-source channel-values with ALL — it always fails and spams unifiedDataAPI errors.
    if (props.showLegendTable) {
      debug('[TimeSeries] getDataFromUnifiedStore skipped: fleet explore (showLegendTable); data comes from parent only');
      return [];
    }

    // Prevent infinite loops
    if (isFetchingData) {
      warn('🔄 TimeSeries: getDataFromUnifiedStore already running, skipping');
      return [];
    }

    // Prevent rapid successive calls
    const now = Date.now();
    if (now - lastFetchDataTime < 100) {
      warn('🔄 TimeSeries: getDataFromUnifiedStore called too soon, skipping');
      return [];
    }
    lastFetchDataTime = now;

    isFetchingData = true;

    if (!props.chart) {
      debug('🔄 TimeSeries: No chart, returning empty array');
      isFetchingData = false;
      return [];
    }

    // Handle both single chart and array of charts
    const chartsToProcess = Array.isArray(props.chart) ? props.chart : [props.chart];

    if (chartsToProcess.length === 0) {
      isFetchingData = false;
      return [];
    }

    // Check if charts already have data (from fleet mode or other pre-populated scenarios)
    const hasPrePopulatedData = chartsToProcess.some(chart =>
      chart.series && chart.series.some(series =>
        series.data && Array.isArray(series.data) && series.data.length > 0
      )
    );

    if (hasPrePopulatedData) {
      debug('🔄 TimeSeries: Charts already have data, skipping data fetch');
      isFetchingData = false;
      // Return empty array - the data is already in the chart config
      return [];
    }

    // Extract required channels from all chart configurations
    // CRITICAL: Use name directly (preserves original casing like 'Tws_kts') - channel names are case-sensitive in the API
    // Handle fleet mode where channel names may have " - SourceName" suffix
    const requiredChannels = [];
    chartsToProcess.forEach((chart, chartIdx) => {
      if (chart.series && chart.series.length > 0) {
        chart.series.forEach((series, seriesIdx) => {
          if (series.xaxis && series.xaxis.name) {
            // Remove " - SourceName" suffix if present (fleet mode)
            // Use name directly - it has the correct casing like 'Tws_kts' that the API expects
            const xChannelName = series.xaxis.name.split(' - ')[0];
            debug(`[TimeSeries] Chart ${chartIdx}, Series ${seriesIdx}: xaxis.name = "${series.xaxis.name}" -> extracted "${xChannelName}"`);
            if (!requiredChannels.includes(xChannelName)) {
              requiredChannels.push(xChannelName);
            }
          }
          if (series.yaxis && series.yaxis.name) {
            // Remove " - SourceName" suffix if present (fleet mode)
            // Use name directly - it has the correct casing like 'Tws_kts' that the API expects
            const yChannelName = series.yaxis.name.split(' - ')[0];
            debug(`[TimeSeries] Chart ${chartIdx}, Series ${seriesIdx}: yaxis.name = "${series.yaxis.name}" -> extracted "${yChannelName}"`);
            if (!requiredChannels.includes(yChannelName)) {
              requiredChannels.push(yChannelName);
            }
          }
          if (series.colorChannel && series.colorChannel.name) {
            // Remove " - SourceName" suffix if present (fleet mode)
            // Use name directly - it has the correct casing that the API expects
            const colorChannelName = series.colorChannel.name.split(' - ')[0];
            debug(`[TimeSeries] Chart ${chartIdx}, Series ${seriesIdx}: colorChannel.name = "${series.colorChannel.name}" -> extracted "${colorChannelName}"`);
            if (!requiredChannels.includes(colorChannelName)) {
              requiredChannels.push(colorChannelName);
            }
          }
        });
      }
    });

    // Use the same logic as Overlay component - start with Datetime and add other channels
    let channel_items = [{ 'name': 'Datetime', 'type': 'datetime' }];
    requiredChannels.forEach(channel => {
      if (channel !== 'Datetime') {
        channel_items.push({ 'name': channel, 'type': 'float' });
      }
    });

    // Extract just the channel names for the API call
    // CRITICAL: Use channel names directly from chart objects - they already have the correct case
    // Chart objects preserve original case like 'Twa_deg', 'Tws_avg_kph', 'Bsp_kph'
    // No normalization needed - use them as-is
    const validChannels = channel_items.map(item => item.name);

    // Ensure common filter channels are present for downstream filtering (with correct case)
    ['Race_number', 'Leg_number', 'Grade'].forEach((ch) => {
      if (!validChannels.includes(ch)) {
        validChannels.push(ch);
      }
    });

    // Debug logging for channel requests
    warn(`[TimeSeries] 🔍 CHANNEL EXTRACTION DEBUG:`, {
      requiredChannelsFromChartObjects: requiredChannels,
      channelItems: channel_items,
      validChannelsForAPI: validChannels,
      caseCheck: requiredChannels.map(ch => ({
        channel: ch,
        hasUpperCase: /[A-Z]/.test(ch),
        isLowercase: ch === ch.toLowerCase(),
        originalFromChart: ch
      })),
      note: 'These channels should be in original case from chart objects. If lowercase, chart objects themselves are lowercase.'
    });

    const datasetIdForResample = selectedDatasetId();
    const exploreResampleFetchPlan: ExploreResampleFetchPlan | null | undefined =
      !datasetIdForResample || datasetIdForResample === 0
        ? undefined
        : buildExploreResampleFetchPlan(chartsToProcess) ?? undefined;
    const validChannelsForDataPoints = [
      ...new Set([...validChannels, ...(exploreResampleFetchPlan?.mergedYKeys ?? [])]),
    ];

    // Get dataset date for proper API calls
    // In fleet mode (selectedDatasetId = 0), use selectedDate from persistent store instead
    let formattedDate = '';
    /** Primary source for this dataset (from /datasets/info); used when global selection is fleet sentinel ALL */
    let datasetPrimarySourceName: string | null = null;
    if (!selectedDatasetId() || selectedDatasetId() === 0) {
      // Fleet mode - use selectedDate
      const { selectedDate } = persistantStore;
      const dateStr = selectedDate();
      if (dateStr) {
        formattedDate = dateStr.includes('-') ? dateStr.replace(/-/g, '') : dateStr;
        debug(`[TimeSeries] Using selectedDate for fleet mode:`, dateStr, 'formatted:', formattedDate);
      } else {
        isFetchingData = false;
        throw new Error("No selectedDate available in fleet mode.");
      }
    } else {
      // Regular mode - fetch from dataset info
      const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`);

      if (!datasetInfoResponse.success || !datasetInfoResponse.data) {
        isFetchingData = false;
        throw new Error("Failed to fetch dataset metadata.");
      }

      const di = datasetInfoResponse.data as Record<string, unknown>;
      const rawDate = di.date;
      formattedDate = String(rawDate ?? "").replace(/-/g, "");
      const sn = di.source_name ?? di.Source_name;
      if (typeof sn === "string" && sn.trim()) {
        datasetPrimarySourceName = sn.trim();
      }
    }

    // Dataset explore timeseries must use a real boat for channel-values, not fleet sentinel "ALL"
    const datasetIdNum = selectedDatasetId();
    let effectiveSourceName = selectedSourceName();
    let effectiveSourceId = selectedSourceId();
    if (datasetIdNum != null && datasetIdNum !== 0) {
      const persistedName = effectiveSourceName == null ? "" : String(effectiveSourceName).trim();
      const needsConcreteSource =
        !persistedName || persistedName.toUpperCase() === "ALL" || effectiveSourceId === 0;

      if (needsConcreteSource) {
        if (datasetPrimarySourceName) {
          effectiveSourceName = datasetPrimarySourceName;
          if (!sourcesStore.isReady()) {
            let w = 0;
            while (!sourcesStore.isReady() && w < 50) {
              await new Promise((r) => setTimeout(r, 100));
              w++;
            }
          }
          const rid = sourcesStore.getSourceId(effectiveSourceName);
          if (rid != null && rid !== 0) {
            effectiveSourceId = rid;
          }
        }
        if (
          (!effectiveSourceName || String(effectiveSourceName).trim().toUpperCase() === "ALL" || effectiveSourceId === 0) &&
          sourcesStore.isReady()
        ) {
          const allSrc = sourcesStore.sources();
          if (allSrc.length > 0) {
            effectiveSourceName = allSrc[0].source_name;
            effectiveSourceId = allSrc[0].source_id;
            warn(`[TimeSeries] Global source was ALL/unknown; using first project source for channel-values`, {
              effectiveSourceName,
              effectiveSourceId,
              datasetId: datasetIdNum,
            });
          }
        }
      }
      const finalName = effectiveSourceName == null ? "" : String(effectiveSourceName).trim();
      if (!finalName || finalName.toUpperCase() === "ALL") {
        isFetchingData = false;
        throw new Error(
          "Dataset timeseries needs a boat source, but the current source is ALL (fleet). Open this dataset from the sidebar or pick a source."
        );
      }
    }

    debug(`[TimeSeries] Channel-values source resolution`, {
      persistedName: selectedSourceName(),
      persistedId: selectedSourceId(),
      effectiveSourceName,
      effectiveSourceId,
      datasetPrimarySourceName,
      datasetId: datasetIdNum,
    });

    // Get data from unified data store using fetchDataWithChannelChecking
    // IMPORTANT: TimeSeries should ALWAYS load the full dataset, never filter by selectedRange
    // The selectedRange is only used for zooming the view, not for filtering data
    logData(`[TimeSeries] Fetching data for channels:`, validChannels);
    logData(`[TimeSeries] Parameters:`, {
      projectId: selectedProjectId().toString(),
      className: selectedClassName(),
      datasetId: selectedDatasetId().toString(),
      sourceName: effectiveSourceName,
      sourceId: effectiveSourceId,
      date: formattedDate,
      note: 'Always fetching full dataset - selectedRange only affects zoom, not data filtering'
    });

    // Set up loading state monitoring
    setIsDataLoading(true);
    setDataLoadingMessage('Loading data...'); // Set initial message
    let loadingInterval: ReturnType<typeof setInterval> | null = null;

    try {
      const checkLoadingState = () => {
        const message = unifiedDataStore.getDataLoadingMessage('ts', selectedClassName(), effectiveSourceId);
        debug(`[TimeSeries] Loading state check:`, { message });

        // Update message if we have a specific one
        if (message && message !== 'Loading data...') {
          setDataLoadingMessage(message);
        }

        // Keep loading visible if we have a specific loading message
        // The default "Loading data..." means we're waiting for specific loading states to be set
        const isActivelyLoading = message !== 'Loading data...' && message !== '';
        setIsDataLoading(isActivelyLoading);
      };

      // Check loading state periodically while fetching
      // Start checking after a small delay to allow loading states to be set
      loadingInterval = setInterval(checkLoadingState, 100);

      // CRITICAL: Never pass timeRange to fetchDataWithChannelCheckingFromFile for TimeSeries
      // TimeSeries needs the full dataset to allow scrolling, selectedRange only controls zoom
      // Use skipTimeRangeFilter flag to ensure the store never filters by timeRange for TimeSeries
      // Validates channels against file server (matching FileChannelPicker)
      let data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
        'ts',
        selectedClassName(),
        effectiveSourceId.toString(),
        validChannels,
        {
          projectId: selectedProjectId().toString(),
          className: selectedClassName(),
          datasetId: selectedDatasetId().toString(),
          sourceName: effectiveSourceName,
          sourceId: effectiveSourceId,
          date: formattedDate,
          applyGlobalFilters: false,
          skipTimeRangeFilter: true, // CRITICAL: TimeSeries should NEVER filter by timeRange
          exploreResampleFetchPlan: exploreResampleFetchPlan ?? undefined,
          // NOTE: We intentionally do NOT pass timeRange here
          // TimeSeries should always load full dataset and use zoom to show selection
        },
        'timeseries'
      );

      debug(`[TimeSeries] Received data:`, data ? `${data.length} points` : 'undefined');
      debug(`[TimeSeries] Data fetch complete - full dataset loaded (not filtered by selectedRange)`);


      if (!data || data.length === 0) {
        debug('No data returned from unified store');
        return [];
      }

      // Check for missing channels in the data
      // Use case-insensitive matching (consistent with unifiedDataStore)
      if (data.length > 0) {
        const availableFields = Object.keys(data[0] || {});
        const availableFieldsLower = new Set(availableFields.map(f => f.toLowerCase()));
        const missingChannels = validChannels.filter(channel => {
          // Skip metadata channels - they're derived, not data channels
          const METADATA_CHANNELS = new Set([
            'Datetime', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename',
            'Grade', 'grade', 'GRADE', 'Mainsail_code', 'mainsail_code',
            'TACK', 'tack', 'event_id'
          ]);
          const isMetadata = METADATA_CHANNELS.has(channel) || METADATA_CHANNELS.has(channel.toLowerCase()) || channel.toLowerCase().endsWith('_code');
          if (isMetadata) return false;
          // Case-insensitive check
          return !availableFieldsLower.has(channel.toLowerCase());
        });

        if (missingChannels.length > 0) {
          warn(`[TimeSeries] Missing channels in data:`, missingChannels);
          warn(`[TimeSeries] Available fields:`, availableFields);
          warn(`[TimeSeries] Required channels:`, validChannels);

          // Try to fetch missing channels using unifiedDataStore
          try {
            debug(`[TimeSeries] Attempting to fetch missing channels:`, missingChannels);

            const completeData = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
              'ts',
              selectedClassName(),
              effectiveSourceId.toString(),
              validChannels,
              {
                projectId: selectedProjectId().toString(),
                className: selectedClassName(),
                datasetId: selectedDatasetId().toString(),
                sourceName: effectiveSourceName,
                sourceId: effectiveSourceId,
                date: formattedDate,
                applyGlobalFilters: false,
                skipTimeRangeFilter: true,
                exploreResampleFetchPlan: exploreResampleFetchPlan ?? undefined,
              },
              'timeseries'
            );

            if (completeData && completeData.length > 0) {
              debug(`[TimeSeries] Successfully fetched complete data with all channels:`, completeData.length, 'records');
              // Update the data variable to use the complete data
              data = completeData;

              // Verify that the missing channels are now present (case-insensitive)
              const updatedAvailableFields = Object.keys(data[0] || {});
              const updatedAvailableFieldsLower = new Set(updatedAvailableFields.map(f => f.toLowerCase()));
              const stillMissingChannels = missingChannels.filter(channel =>
                !updatedAvailableFieldsLower.has(channel.toLowerCase())
              );

              if (stillMissingChannels.length === 0) {
                debug(`[TimeSeries] All missing channels successfully added to data`);
              } else {
                warn(`[TimeSeries] Some channels are still missing after fetch:`, stillMissingChannels);
              }
            }
          } catch (error: any) {
            warn(`[TimeSeries] Failed to fetch missing channels:`, error.message);
          }
        }
      }

      // Apply global filtering if no chart-specific filters were applied
      // NOTE: applyFilters only applies TWA filters (states, races, legs, grades)
      let filteredData = data;
      if (!chartsToProcess[0].filters || chartsToProcess[0].filters.length === 0) {
        filteredData = applyFilters(filteredData);
        debug(`[TimeSeries] Applied TWA filters - data length: ${filteredData.length}`);
      }

      // CRITICAL: Handle cuts vs selections differently
      // - If there's a CUT (cutEvents + isCut): Filter data to ONLY cut ranges
      // - If there's a SELECTION (selectedRange, no cuts): Load ALL data, zoom will show selection
      // - If neither: Load ALL data
      const currentCutEvents = cutEvents();
      const currentIsCut = isCut();
      const currentSelectedRange = selectedRange();
      const hasCuts = Array.isArray(currentCutEvents) && currentCutEvents.length > 0 && currentIsCut;
      const hasSelection = Array.isArray(currentSelectedRange) && currentSelectedRange.length > 0;

      if (hasCuts) {
        // CUT MODE: Filter data to only include cut ranges
        debug(`[TimeSeries] Cut mode active - filtering data to cut ranges only`, {
          cutRangesCount: currentCutEvents.length,
          beforeFilter: filteredData.length
        });

        // Helper to get timestamp from data point (before processing adds 'x' field)
        // Use case-insensitive matching to handle various datetime field name formats
        const getTimestamp = (d: any): number => {
          if (!d) return 0;

          // Try common datetime field names (case-insensitive)
          const commonDatetimeFields = ['Datetime', 'datetime', 'timestamp', 'Timestamp', 'TIME', 'time'];
          for (const field of commonDatetimeFields) {
            if (d[field] !== undefined && d[field] !== null) {
              const dt = d[field] instanceof Date ? d[field] : new Date(d[field]);
              if (!isNaN(dt.getTime())) {
                return dt.getTime();
              }
            }
          }

          // Try case-insensitive search through all fields
          const datetimeLower = 'datetime';
          for (const key in d) {
            if (key.toLowerCase() === datetimeLower || key.toLowerCase() === 'timestamp') {
              const value = d[key];
              if (value !== undefined && value !== null) {
                const dt = value instanceof Date ? value : new Date(value);
                if (!isNaN(dt.getTime())) {
                  return dt.getTime();
                }
              }
            }
          }

          // Fallback to x field if it exists (shouldn't at this point, but handle it)
          if (d.x instanceof Date) {
            return d.x.getTime();
          }

          return 0;
        };

        filteredData = filteredData.filter((d) => {
          const timestamp = getTimestamp(d);
          if (timestamp === 0) {
            warn(`[TimeSeries] Could not extract timestamp from data point:`, d);
            return false; // Exclude data points without valid timestamps
          }

          return currentCutEvents.some(range => {
            // Handle both time range objects and event IDs (for backward compatibility)
            if (typeof range === 'number') {
              return false; // Skip if it's an event ID instead of a time range
            }

            if (range.start_time && range.end_time) {
              const startTime = new Date(range.start_time).getTime();
              const endTime = new Date(range.end_time).getTime();
              return timestamp >= startTime && timestamp <= endTime;
            }

            return false;
          });
        });

        debug(`[TimeSeries] Cut filtering applied - data length: ${filteredData.length} (only cut data)`);
      } else if (hasSelection) {
        // SELECTION MODE: Keep ALL data, selectedRange will only control zoom
        debug(`[TimeSeries] Selection mode active - keeping full dataset, zoom will show selection`, {
          selectedRange: currentSelectedRange[0],
          dataLength: filteredData.length,
          note: 'Full dataset loaded - selectedRange only affects zoom, not data filtering'
        });
      } else {
        // NO SELECTION OR CUTS: Keep ALL data
        debug(`[TimeSeries] No selection or cuts - keeping full dataset`, {
          dataLength: filteredData.length
        });
      }

      // Process data for time series format
      const processedData = filteredData.map((item) => {
        const dataPoint: Record<string, unknown> = {
          Datetime: item.Datetime,
        };

        const getItemChannelValue = (name: string): any => {
          if (item[name] !== undefined) return item[name];
          const key = Object.keys(item).find((k) => k.toLowerCase() === name.toLowerCase());
          return key !== undefined ? item[key] : undefined;
        };

        // Include disambiguated Y columns when the same source channel is plotted at multiple resolutions
        validChannelsForDataPoints.forEach((channelName) => {
          const value = getItemChannelValue(channelName);
          if (value !== undefined) {
            dataPoint[channelName] = value;
          }
        });

        // Set x value from the first series xaxis (assuming all series use the same x-axis)
        // Use case-insensitive matching with fallbacks to common datetime field names
        if (chartsToProcess[0].series.length > 0 && chartsToProcess[0].series[0].xaxis && chartsToProcess[0].series[0].xaxis.name) {
          const xChannelName = chartsToProcess[0].series[0].xaxis.name;
          let timestamp: any = undefined;

          // Try exact match first
          if (item[xChannelName] !== undefined) {
            timestamp = item[xChannelName];
          } else {
            // Try case-insensitive match
            const xChannelNameLower = xChannelName.toLowerCase();
            for (const key in item) {
              if (key.toLowerCase() === xChannelNameLower) {
                timestamp = item[key];
                break;
              }
            }
          }

          // Fallback to common datetime field names if xaxis name not found
          if (timestamp === undefined) {
            const commonDatetimeFields = ['Datetime', 'datetime', 'timestamp', 'Timestamp', 'TIME', 'time'];
            for (const field of commonDatetimeFields) {
              if (item[field] !== undefined) {
                timestamp = item[field];
                break;
              }
            }
          }

          if (timestamp !== undefined) {
            // Convert timestamp to Date object for proper x-axis handling
            dataPoint.x = new Date(timestamp);
          }
        } else {
          // No xaxis specified - try common datetime fields as fallback
          const commonDatetimeFields = ['Datetime', 'datetime', 'timestamp', 'Timestamp', 'TIME', 'time'];
          for (const field of commonDatetimeFields) {
            if (item[field] !== undefined) {
              dataPoint.x = new Date(item[field]);
              break;
            }
          }
        }

        return dataPoint;
      });

      // Sort processed data by x-axis (timestamp) to ensure proper timeline order
      const sortedProcessedData = processedData.sort((a, b) => {
        if (!a.x || !b.x) return 0;
        return a.x.getTime() - b.x.getTime();
      });

      debug(`[TimeSeries] Sorted ${sortedProcessedData.length} data points by timestamp`);

      // Debug: Log first and last few timestamps to check for timeline issues
      if (sortedProcessedData.length > 0) {
        const firstFew = sortedProcessedData.slice(0, 3).map(d => d.x?.toISOString());
        const lastFew = sortedProcessedData.slice(-3).map(d => d.x?.toISOString());
        debug(`[TimeSeries] First 3 timestamps:`, firstFew);
        debug(`[TimeSeries] Last 3 timestamps:`, lastFew);

        // Check for any invalid timestamps
        const invalidTimestamps = sortedProcessedData.filter(d => !d.x || isNaN(d.x.getTime()));
        if (invalidTimestamps.length > 0) {
          warn(`[TimeSeries] Found ${invalidTimestamps.length} invalid timestamps:`, invalidTimestamps.slice(0, 5));
        }
      }

      return sortedProcessedData;
    } catch (error: any) {
      // Clear loading interval and state on error
      if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
      }
      setIsDataLoading(false);
      setDataLoadingMessage('');
      logError('🔄 TimeSeries: Error in getDataFromUnifiedStore:', error);
      logError('🔄 TimeSeries: getDataFromUnifiedStore Error Details:', {
        error: error,
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      return [];
    } finally {
      // Always clear the loading interval when function completes
      if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
      }
      // Clear loading state when data fetch completes
      setIsDataLoading(false);
      setDataLoadingMessage('');
      isFetchingData = false;
      debug('🔄 TimeSeries: getDataFromUnifiedStore completed, reset flag');
    }
  };


  // Async chart processing for large datasets
  const processChartsAsync = async (
    chartsToProcess: any[],
    data: any[],
    explorePlan?: ExploreResampleFetchPlan | null
  ) => {
    // For small datasets, process synchronously
    if (data.length < 1000) {
      return chartsToProcess.map((chart, idx) => processChartSync(chart, data, idx, explorePlan));
    }

    // For large datasets, process in chunks
    return new Promise<any[]>((resolve) => {
      const processedCharts: any[] = [];
      let chartIndex = 0;

      const processChart = () => {
        if (chartIndex >= chartsToProcess.length) {
          resolve(processedCharts);
          return;
        }

        const chart = chartsToProcess[chartIndex];
        const processedChart = processChartSync(chart, data, chartIndex, explorePlan);
        processedCharts.push(processedChart);

        chartIndex++;

        // Yield control and continue processing
        setTimeout(processChart, 0);
      };

      processChart();
    });
  };

  // Synchronous chart processing (for small datasets or fallback)
  const processChartSync = (
    chart: any,
    data: any[],
    chartIndex: number,
    explorePlan?: ExploreResampleFetchPlan | null
  ) => {
    return {
      ...chart,
      series: chart.series.map((series: any, seriesIndex: number) => {
        const xName = series.xaxis.name;
        const yName = series.yaxis.name;
        const yPlotKey =
          explorePlan?.seriesYPlotKeyByChartSeries[`${chartIndex}-${seriesIndex}`] ??
          series.yDataKey ??
          yName;

        const rawReadingKey =
          useRawReadingsForCumulativeLineTypes(series.lineType) && explorePlan
            ? rawReadingPlotKeyForExploreChannel(chart, chartIndex, yName, explorePlan)
            : null;
        if (
          useRawReadingsForCumulativeLineTypes(series.lineType) &&
          explorePlan &&
          !rawReadingKey &&
          !warnedCumulativeLineTypesNoRawProcessSync
        ) {
          warnedCumulativeLineTypesNoRawProcessSync = true;
          warn(
            "TimeSeries: cumulative / abs cumulative / abs cumulative diff need a RAW column for native samples; none found — using resampled y (bucket means)."
          );
        }

        const getFieldCaseInsensitive = (item: any, fieldName: string): any => {
          if (item[fieldName] !== undefined) return item[fieldName];
          const key = Object.keys(item).find((k) => k.toLowerCase() === fieldName.toLowerCase());
          return key !== undefined ? item[key] : undefined;
        };

        // Helper function to get y value with fallback logic
        const getYValue = (item: any): any => {
          if (item.y !== undefined && item.y !== null) {
            return item.y;
          }
          if (item[yPlotKey] !== undefined && item[yPlotKey] !== null) {
            return item[yPlotKey];
          }
          if (item[yName] !== undefined && item[yName] !== null) {
            return item[yName];
          }
          const lowerPlot = yPlotKey.toLowerCase();
          for (const key in item) {
            if (key.toLowerCase() === lowerPlot && item[key] !== undefined && item[key] !== null) {
              return item[key];
            }
          }
          const lowerYName = yName.toLowerCase();
          for (const key in item) {
            if (key.toLowerCase() === lowerYName && item[key] !== undefined && item[key] !== null) {
              return item[key];
            }
          }
          return undefined;
        };

        const getPathYValue = (item: any): any => {
          if (rawReadingKey) {
            const rv = getFieldCaseInsensitive(item, rawReadingKey);
            if (rv !== undefined && rv !== null) return rv;
          }
          return getYValue(item);
        };

        const bucketYForPlotKey = (item: any): any => {
          if (!rawReadingKey || rawReadingKey === yPlotKey) {
            return undefined;
          }
          const bv = getFieldCaseInsensitive(item, yPlotKey);
          if (bv !== undefined && bv !== null) return bv;
          return undefined;
        };

        const seriesData = sortSeriesPointsByTime(
          data
            .filter((item: any) => {
              const yVal = getPathYValue(item);
              return item.x !== undefined && yVal !== undefined && yVal !== null;
            })
            .map((item: any) => {
              const yVal = getPathYValue(item);
              const bucket = bucketYForPlotKey(item);
              const plotKeyStored = bucket !== undefined ? bucket : yVal;
              return {
                x: item.x,
                y: yVal,
                Datetime: item.Datetime,
                [xName]: item[xName],
                [yName]: yVal,
                [yPlotKey]: plotKeyStored,
              };
            })
        );

        return { ...series, yDataKey: yPlotKey, data: seriesData };
      }),
    };
  };

  // Process data from unified store into chart format
  const processDataForCharts = async () => {
    processDataForChartsCount++;
    debug('🔄 TimeSeries: processDataForCharts called', {
      callCount: processDataForChartsCount,
      hasChart: !!props.chart,
      isProcessingData,
      timestamp: new Date().toISOString(),
      stackTrace: new Error().stack?.split('\n').slice(1, 5).join('\n')
    });

    // Prevent infinite loops
    if (isProcessingData) {
      debug('🔄 TimeSeries: processDataForCharts already running, skipping');
      return;
    }

    // Prevent rapid successive calls (debounce)
    const now = Date.now();
    if (now - lastProcessDataTime < 100) {
      debug('🔄 TimeSeries: processDataForCharts called too soon, skipping (debounced)');
      return;
    }
    lastProcessDataTime = now;

    isProcessingData = true;

    try {
      setIsLoading(true);
      debug('🔄 TimeSeries: Set loading to true');

      if (!props.chart) {
        debug('🔄 TimeSeries: No chart, setting empty charts array');
        setCharts([]);
        // Clear loading state when there's no chart
        setIsDataLoading(false);
        setDataLoadingMessage('');
        return;
      }

      // Handle both single chart and array of charts
      const chartsToProcess = Array.isArray(props.chart) ? props.chart : [props.chart];

      // Check if charts already have data (from fleet mode or other pre-populated scenarios)
      const hasPrePopulatedData = chartsToProcess.some(chart =>
        chart.series && chart.series.some(series =>
          series.data && Array.isArray(series.data) && series.data.length > 0
        )
      );

      let processedCharts;

      if (hasPrePopulatedData) {
        debug('[TimeSeries] Charts already have data, using pre-populated data');
        processedCharts = chartsToProcess.map((chart) => ({
          ...chart,
          series: (chart.series || []).map((ser: any) => ({
            ...ser,
            data: sortSeriesPointsByTime(ser.data),
          })),
        }));
      } else if (props.showLegendTable) {
        // FleetTimeSeries: empty series means parent has no points yet or all filtered out — do not fetch with global ALL.
        debug('[TimeSeries] Fleet explore charts with no points yet — using parent series as-is (no unified store)');
        processedCharts = chartsToProcess.map((chart) => ({
          ...chart,
          series: (chart.series || []).map((ser: any) => ({
            ...ser,
            data: sortSeriesPointsByTime(Array.isArray(ser.data) ? ser.data : []),
          })),
        }));
      } else {
        // Get data from unified store
        debug('🔄 TimeSeries: Calling getDataFromUnifiedStore');
        const data = await getDataFromUnifiedStore();

        debug('[TimeSeries] Data from unified store:', {
          hasData: !!data,
          dataLength: data?.length || 0,
          dataType: typeof data,
          sampleData: data?.[0] || null
        });

        if (!data || data.length === 0) {
          warn('[TimeSeries] No data returned from unified store');
          setCharts([]);
          return;
        }

        const explorePlanForProcess =
          selectedDatasetId() && selectedDatasetId() !== 0
            ? buildExploreResampleFetchPlan(chartsToProcess) ?? undefined
            : undefined;
        processedCharts = await processChartsAsync(chartsToProcess, data, explorePlanForProcess);
      }


      info(`Processed ${processedCharts.length} charts with data`);
      info('[TimeSeries] Processed charts details:', {
        chartsLength: processedCharts.length,
        chartsType: typeof processedCharts,
        firstChart: processedCharts[0] ? {
          seriesCount: processedCharts[0].series?.length || 0,
          firstSeriesDataLength: processedCharts[0].series?.[0]?.data?.length || 0
        } : null
      });
      setCharts(processedCharts);
    } catch (error: any) {
      logError('Error processing charts data:', error);
      logError('🔄 TimeSeries: processDataForCharts Error Details:', {
        error: error,
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      setCharts([]);
    } finally {
      setIsLoading(false);
      isProcessingData = false;
      debug('🔄 TimeSeries: processDataForCharts completed, reset flag');
    }
  };

  const margin = { top: 25, right: 25, bottom: 25, left: 25 };
  const rowGap = 30;

  // Calculate dynamic height based on chart count - allow SVG to overflow
  const getChartHeight = () => {
    const chartsData = charts();
    const chartCount = chartsData.length;

    if (chartCount === 0) return 200;

    // Use a fixed height per chart to allow SVG to grow beyond container
    // This allows the SVG to overflow and be scrollable
    const heightPerChart = 300; // Fixed height per chart

    return heightPerChart;
  };

  const drawPlots = () => {
    debug('🎨 TimeSeries: drawPlots() called');

    // Safety check for containerRef
    if (!containerRef) {
      warn('🎨 TimeSeries: containerRef is null, skipping draw');
      return;
    }

    const chartsData = charts();

    // Don't draw if there's no data
    if (!chartsData || chartsData.length === 0) {
      debug('🎨 TimeSeries: No chart data, skipping draw');
      return;
    }

    const segmentGapForLayout = exploreChartSegmentGapSplitMs(!props.showLegendTable);

    // Multi-container path: one div per chart+table (FleetTimeSeries with legend table)
    if (props.showLegendTable) {
      const chartContainers = containerRef.querySelectorAll('.time-series-single-chart');
      if (chartContainers.length !== chartsData.length) {
        debug('🎨 TimeSeries: Chart container count mismatch, skipping multi-container draw', {
          containers: chartContainers.length,
          charts: chartsData.length
        });
        return;
      }
      const firstContainer = chartContainers[0] as HTMLElement;
      const multiContainerWidth = firstContainer.offsetWidth || 0;
      const multiWidth = Math.max(multiContainerWidth - margin.left - margin.right, 0);
      if (multiContainerWidth <= 0) {
        warn('🎨 TimeSeries: Multi-container has no width, skipping draw');
        return;
      }
      const multiHeight = getChartHeight();
      const multiXOffset = 10;
      isProgrammaticallyUpdatingBrush = true;
      if (containerRef && wheelHandler) {
        containerRef.removeEventListener('wheel', wheelHandler, { capture: true });
      }
      wheelHandler = null;
      chartContainers.forEach((el) => {
        const c = el as HTMLElement;
        const existing = c.querySelector('svg');
        if (existing) existing.remove();
      });
      const allXValuesMulti = chartsData.flatMap((chart) =>
        chart.series.flatMap((series) =>
          series.data
            .filter((d) => d.y !== null && d.y !== undefined && !isNaN(d.y))
            .map((d) => d.x)
        )
      ).filter((x): x is Date => {
        if (x == null || !(x instanceof Date)) return false;
        const time = x.getTime();
        if (isNaN(time) || !isFinite(time)) return false;
        if (time <= 24 * 60 * 60 * 1000) return false;
        if (time > Date.now() + 100 * 365 * 24 * 60 * 60 * 1000) return false;
        if (time < new Date('1900-01-01').getTime()) return false;
        return true;
      });
      let xExtentMulti: [Date, Date] | [undefined, undefined] = [undefined, undefined];
      const datasetEventTimeRange = props.datasetEventTimeRange as { start: Date | string | number; end: Date | string | number } | undefined;
      if (datasetEventTimeRange?.start && datasetEventTimeRange?.end) {
        const startTime = typeof datasetEventTimeRange.start === 'number' ? new Date(datasetEventTimeRange.start) : new Date(datasetEventTimeRange.start);
        const endTime = typeof datasetEventTimeRange.end === 'number' ? new Date(datasetEventTimeRange.end) : new Date(datasetEventTimeRange.end);
        if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime()) && startTime.getTime() < endTime.getTime()) {
          xExtentMulti = [startTime, endTime];
        }
      }
      if (!xExtentMulti[0] || !xExtentMulti[1]) {
        if (allXValuesMulti.length > 0) {
          xExtentMulti = d3.extent(allXValuesMulti) as [Date, Date] | [undefined, undefined];
        }
      }
      const fullDataExtentMulti: [Date, Date] | null = allXValuesMulti.length > 0 ? (d3.extent(allXValuesMulti) as [Date, Date]) : null;
      const xScaleMulti = d3.scaleTime().range([0, multiWidth]);
      if (xExtentMulti[0] && xExtentMulti[1] && !isNaN(xExtentMulti[0].getTime()) && xExtentMulti[0].getTime() !== xExtentMulti[1].getTime()) {
        xScaleMulti.domain(xExtentMulti as [Date, Date]);
      } else {
        const now = new Date();
        xScaleMulti.domain([new Date(now.getTime() - 86400000), now]);
      }
      const xZoomMulti = xScaleMulti.copy();
      const currentSelectedRange = selectedRange();
      if (currentSelectedRange?.length > 0 && !isCut()) {
        const rangeItem = currentSelectedRange[0];
        const startTime = new Date(rangeItem.start_time);
        const endTime = new Date(rangeItem.end_time);
        const fullDomain = xScaleMulti.domain();
        if (startTime >= fullDomain[0] && endTime <= fullDomain[1] && startTime < endTime) {
          xZoomMulti.domain([startTime, endTime]);
        }
      }
      const multiTotalHeight = multiHeight + margin.top + margin.bottom;
      const allSvgs: d3.Selection<SVGGElement, unknown, null, undefined>[] = [];
      const selectedTimeLinesMulti: d3.Selection<SVGLineElement, unknown, null, undefined>[] = [];
      const verticalLinesMulti: d3.Selection<SVGLineElement, unknown, null, undefined>[] = [];

      /** Shared multi-chart coord conversion: event + hit SVG -> clamped x in scale range. Same formula as mousemove so cursor and click stay aligned under CSS scale (<1620). */
      const multiChartEventToClampedX = (
        event: MouseEvent,
        svgEl: SVGElement | null,
        logicalWidth: number,
        marginLeft: number,
        xOffset: number,
        zoomRange: [number, number]
      ): number | null => {
        if (!svgEl) return null;
        const rect = svgEl.getBoundingClientRect();
        if (!(rect.width > 0)) return null;
        const logicalX = (event.clientX - rect.left) * (logicalWidth / rect.width);
        const rawX = logicalX - marginLeft - xOffset;
        const [r0, r1] = zoomRange;
        const rangeMin = Math.min(r0, r1);
        const rangeMax = Math.max(r0, r1);
        return rangeMax > rangeMin ? Math.max(rangeMin, Math.min(rangeMax, rawX)) : rangeMin;
      };

      for (let idx = 0; idx < chartsData.length; idx++) {
        const chartEl = chartContainers[idx] as HTMLElement;
        const singleSvg = d3.select(chartEl)
          .append("svg")
          .attr("width", multiContainerWidth)
          .attr("height", multiTotalHeight)
          .append("g")
          .attr("transform", `translate(${margin.left},${margin.top})`);
        const clipId = `clip-${idx}`;
        singleSvg.append("defs").append("clipPath").attr("id", clipId)
          .append("rect")
          .attr("width", multiWidth + multiXOffset)
          .attr("height", multiHeight);
        const group = singleSvg.append("g").attr("class", `chart-group chart-group-${idx}`);
        const chart = chartsData[idx];
        const yOffset = 0;
        const multiDomainLo = xZoomMulti.domain()[0];
        const multiDomainHi = xZoomMulti.domain()[1];
        const multiTimeThreshold = segmentGapForLayout;
        const visibleData = chart.series.flatMap((series) =>
          series.data.filter((d) => d.x >= multiDomainLo && d.x <= multiDomainHi)
        );
        const allYFromTransforms = chart.series.flatMap((s) =>
          collectFiniteDisplayYValues(s, multiDomainLo, multiDomainHi, multiTimeThreshold)
        );
        const allYValues =
          allYFromTransforms.length > 0
            ? allYFromTransforms
            : chart.series.flatMap((s) =>
              s.data
                .map((d) => d.y)
                .filter((v) => v != null && Number.isFinite(Number(v)))
                .map((v) => Number(v))
            );
        let yDomain = safeNumericYDomain(allYValues);
        if (visibleData.length > 0 && yDomain[1] > yDomain[0]) {
          yDomain = [yDomain[0], yDomain[1] + (yDomain[1] - yDomain[0]) * 0.2];
        }
        const yScale = d3.scaleLinear().domain(yDomain).range([multiHeight, 0]);
        const yScaleTranslated = (value: number) => yScale(value) + yOffset;
        const areaBaseY = yScaleTranslated(0);

        const highlightNames = fleetLegendHighlightNames();
        const hasHighlight = highlightNames.length > 0;

        type FleetMultiSegOp = {
          drawOrder: number;
          seriesIndex: number;
          segIndex: number;
          color: string;
          strokeWidth: number;
          strokeDasharray: string | null;
          useFilledArea: boolean;
          tseg: TransformedPoint[];
        };

        const fleetSegOps: FleetMultiSegOp[] = [];
        chart.series.forEach((series, seriesIndex) => {
          const color = series.color;
          const lineType = normalizeLineType(series.lineType);
          const rawSegs = splitSeriesIntoVisibleSegments(
            series.data,
            multiDomainLo,
            multiDomainHi,
            multiTimeThreshold
          );
          const transformedSegs = applyLineTypeToSegmentsWithOptionalCarry(rawSegs, lineType);
          const segmentsForDrawFleet =
            lineType === "standard"
              ? extendStandardSegmentsToVisibleDomain(transformedSegs, multiDomainLo, multiDomainHi)
              : transformedSegs;
          const strokeWidth = series.strokeWidth ?? 1;
          const strokeDasharray = getStrokeDasharray(series.strokeStyle);
          const useFilledArea = series.strokeStyle === "filled-area";
          const teamName = fleetTeamNameFromSeries(series);
          const isSeriesHighlighted = !hasHighlight || highlightNames.includes(teamName);
          const drawOrder = hasHighlight ? (isSeriesHighlighted ? 1 : 0) : 0;
          let segIndex = 0;
          segmentsForDrawFleet.forEach((tseg) => {
            if (tseg.length === 0) return;
            if (tseg.length === 1 && !isFiniteDisplayY(tseg[0])) return;
            fleetSegOps.push({
              drawOrder,
              seriesIndex,
              segIndex: segIndex++,
              color: color || "#888",
              strokeWidth,
              strokeDasharray,
              useFilledArea,
              tseg,
            });
          });
        });

        fleetSegOps.sort((a, b) => {
          if (a.drawOrder !== b.drawOrder) return a.drawOrder - b.drawOrder;
          if (a.seriesIndex !== b.seriesIndex) return a.seriesIndex - b.seriesIndex;
          return a.segIndex - b.segIndex;
        });

        fleetSegOps.forEach((op) => {
          const isBright = !hasHighlight || op.drawOrder === 1;
          const effStrokeW = hasHighlight
            ? isBright
              ? Math.max(op.strokeWidth, 2.5)
              : Math.min(op.strokeWidth, 0.5)
            : op.strokeWidth;
          const strokeOpacity = hasHighlight ? (isBright ? 1 : 0.2) : 1;
          const fillOpacity = hasHighlight ? (isBright ? 1 : 0.2) : 1;

          const finitePts = op.tseg.filter(isFiniteDisplayY);
          if (finitePts.length === 0) return;

          if (op.useFilledArea && finitePts.length >= 2) {
            const areaGen = d3
              .area<TransformedPoint>()
              .x((d) => xZoomMulti(d.x) + multiXOffset)
              .y0(areaBaseY)
              .y1((d) => yScaleTranslated(d.displayY))
              .defined((d) => isFiniteDisplayY(d));
            group
              .append("path")
              .datum(op.tseg)
              .attr("class", `area-${chart.chart}-${op.seriesIndex}`)
              .attr("fill", fillColorHalfOpacity(op.color))
              .attr("fill-opacity", fillOpacity)
              .attr("stroke", "none")
              .attr("clip-path", `url(#${clipId})`)
              .attr("pointer-events", "none")
              .attr("d", areaGen);
          }

          const lineGen = d3
            .line<TransformedPoint>()
            .x((d) => xZoomMulti(d.x) + multiXOffset)
            .y((d) => yScaleTranslated(d.displayY))
            .defined((d) => isFiniteDisplayY(d));

          let pathD: string;
          let lineCap: "round" | "butt" = "butt";
          if (finitePts.length === 1) {
            const p0 = finitePts[0];
            const cx = xZoomMulti(p0.x) + multiXOffset;
            const cy = yScaleTranslated(p0.displayY);
            pathD = `M${cx},${cy}L${cx},${cy}`;
            lineCap = "round";
          } else {
            pathD = lineGen(op.tseg) ?? "";
          }

          const path = group
            .append("path")
            .datum(op.tseg)
            .attr("class", `line-${chart.chart}-${op.seriesIndex}`)
            .attr("fill", "none")
            .attr("stroke", op.color)
            .attr("stroke-width", effStrokeW)
            .attr("stroke-opacity", strokeOpacity)
            .attr("stroke-linecap", lineCap)
            .attr("clip-path", `url(#${clipId})`)
            .attr("user-select", "none")
            .attr("pointer-events", "none")
            .attr("d", pathD);
          if (op.strokeDasharray) path.attr("stroke-dasharray", op.strokeDasharray);
        });
        if (chart.series.length > 0) {
          const firstName = seriesDisplayName(chart.series[0]);
          const channelName = firstName.includes(' - ') ? firstName.split(' - ')[0].trim() : firstName;
          group.append("text")
            .attr("class", "chart-channel-label")
            .attr("x", 20)
            .attr("y", yOffset + 14)
            .attr("fill", "white")
            .attr("font-size", "13px")
            .attr("user-select", "none")
            .attr("pointer-events", "none")
            .text(channelName);
          group
            .append("text")
            .attr("class", "chart-line-type-label")
            .attr("x", 20)
            .attr("y", yOffset + 28)
            .attr("user-select", "none")
            .attr("pointer-events", "none")
            .text(fleetChartLineTypeSummary(chart.series));
        }
        group.append("g")
          .attr("class", "y-axis")
          .attr("transform", `translate(${multiXOffset}, ${yOffset})`)
          .call(d3.axisLeft().scale(yScale).ticks(5));
        group.append("g")
          .attr("class", "x-axis")
          .attr("transform", `translate(${multiXOffset}, ${yOffset + multiHeight})`)
          .call(
            d3.axisBottom(xZoomMulti)
              .ticks(10)
              .tickFormat((d) => formatTime(new Date(d), datasetTimezone()) || new Date(d).toLocaleTimeString("en-US", { hour12: false }))
          );
        const mouseOverlayRect = singleSvg.insert("rect", ":first-child")
          .attr("class", "mouse-overlay")
          .attr("width", multiWidth)
          .attr("height", multiHeight)
          .attr("transform", `translate(${multiXOffset}, 0)`)
          .attr("fill", "none")
          .attr("pointer-events", "all")
          .style("cursor", "pointer");
        const vertLine = singleSvg.append("line")
          .attr("class", "vertical-line")
          .attr("visibility", "hidden")
          .attr("y1", 0)
          .attr("y2", multiHeight)
          .attr("pointer-events", "none");
        const selLine = singleSvg.append("line")
          .attr("class", "selected-time-line")
          .attr("y1", 0)
          .attr("y2", multiHeight)
          .attr("pointer-events", "none")
          .attr("visibility", "hidden");
        verticalLinesMulti.push(vertLine);
        selectedTimeLinesMulti.push(selLine);
        allSvgs.push(singleSvg);
        mouseOverlayRect.on("click", function (event: MouseEvent) {
          const svgEl = chartEl.querySelector("svg") as SVGElement | null;
          const range = xZoomMulti.range() as [number, number];
          const clampedX = multiChartEventToClampedX(event, svgEl, multiContainerWidth, margin.left, multiXOffset, range)
            ?? (() => {
              const pt = d3.pointer(event, chartEl);
              const rawX = pt[0] - margin.left - multiXOffset;
              const rangeMin = Math.min(range[0], range[1]);
              const rangeMax = Math.max(range[0], range[1]);
              return rangeMax > rangeMin ? Math.max(rangeMin, Math.min(rangeMax, rawX)) : rangeMin;
            })();
          const time = xZoomMulti.invert(clampedX);
          const timeMs = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : NaN;
          if (Number.isFinite(timeMs) && requestTimeControl('timeseries')) {
            setIsManualTimeChange(true);
            setSelectedTime(new Date(timeMs), 'timeseries');
          }
          updateSelectedTimeLineMulti();
        });
      }

      const updateSelectedTimeLineMulti = () => {
        const time = selectedTime();
        if (!time || selectedTimeLinesMulti.length === 0) return;
        const domain = xZoomMulti.domain();
        if (!domain || domain.length < 2) return;
        const isTimeVisible = time >= domain[0] && time <= domain[1];
        const x = xZoomMulti(time) + multiXOffset;
        selectedTimeLinesMulti.forEach((line) => {
          if (isTimeVisible && !isNaN(x) && isFinite(x)) {
            line.attr("x1", x).attr("x2", x).attr("visibility", "visible");
          } else {
            line.attr("visibility", "hidden");
          }
        });
        const timeThreshold = segmentGapForLayout;
        const mLo = domain[0];
        const mHi = domain[1];
        const dotHighlightNames = fleetLegendHighlightNames();
        const dotHasHighlight = dotHighlightNames.length > 0;
        chartsData.forEach((chart, chartIndex) => {
          const visibleData = chart.series.flatMap((series) =>
            series.data.filter((d) => d.x >= mLo && d.x <= mHi)
          );
          const perSeriesMulti = chart.series.map((s) =>
            collectFiniteDisplayYValues(s, mLo, mHi, timeThreshold, undefined)
          );
          const allYFromT = perSeriesMulti.flat();
          const supplementMulti = chart.series.flatMap((s, i) =>
            perSeriesMulti[i].length === 0 ? collectVisibleWindowRawYValues(s, mLo, mHi) : []
          );
          const mergedMulti = [...allYFromT, ...supplementMulti];
          const allYValues =
            mergedMulti.length > 0
              ? mergedMulti
              : chart.series.flatMap((s) =>
                s.data
                  .map((d) => d.y)
                  .filter((v) => v != null && Number.isFinite(Number(v)))
                  .map((v) => Number(v))
              );
          let yDomain = safeNumericYDomain(allYValues);
          if (visibleData.length > 0 && yDomain[1] > yDomain[0]) {
            yDomain = [yDomain[0], yDomain[1] + (yDomain[1] - yDomain[0]) * 0.2];
          }
          const yScale = d3.scaleLinear().domain(yDomain).range([multiHeight, 0]);
          const pointData: Array<{ id: string; x: number; y: number; color: string }> = [];
          chart.series.forEach((series, seriesIndex) => {
            if (series.data.length === 0) return;
            if (dotHasHighlight && !dotHighlightNames.includes(fleetTeamNameFromSeries(series))) {
              return;
            }
            const yDisp = getTransformedValueAtClosestTime(
              series,
              time.getTime(),
              mLo,
              mHi,
              timeThreshold,
              undefined,
              CLOSEST_SAMPLE_UI_MARKER_MAX_MS
            );
            if (yDisp !== undefined) {
              const xPos = xZoomMulti(time) + multiXOffset;
              const yPos = yScale(yDisp);
              if (
                !isNaN(xPos) && isFinite(xPos) && !isNaN(yPos) && isFinite(yPos) &&
                yPos >= 0 && yPos <= multiHeight && xPos >= 0 && xPos <= multiWidth + multiXOffset
              ) {
                pointData.push({
                  id: `${chartIndex}-${seriesIndex}`,
                  x: xPos,
                  y: yPos,
                  color: series.color
                });
              }
            }
          });
          const clipId = `clip-${chartIndex}`;
          const s = allSvgs[chartIndex];
          if (!s) return;
          const circles = s.selectAll("circle.time-value-label").data(pointData, (d: { id: string }) => d.id);
          circles.exit().remove();
          circles
            .enter()
            .append("circle")
            .attr("class", "time-value-label")
            .attr("r", 4)
            .attr("fill", (d) => d.color)
            .attr("stroke", "white")
            .attr("stroke-width", 1)
            .attr("clip-path", `url(#${clipId})`)
            .attr("cx", (d) => d.x)
            .attr("cy", (d) => d.y);
          circles.attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("fill", (d) => d.color).attr("clip-path", `url(#${clipId})`);
        });
      };

      const drawEventOverlaysMulti = () => {
        allSvgs.forEach((s, i) => {
          s.selectAll(".event-overlay").remove();
          s.selectAll(".cut-overlay").remove();
          s.selectAll(".event-overlays-group").remove();
          s.selectAll(".cut-overlays-group").remove();
          const events = selectedEvents();
          const ranges = selectedRanges();
          const currentIsCut = isCut();
          const currentCutEvents = cutEvents();
          const clipId = `clip-${i}`;
          const overlayGroup = s.insert("g", ":first-child")
            .attr("class", "event-overlays-group")
            .attr("clip-path", `url(#${clipId})`);
          if (events?.length && ranges?.length) {
            ranges.forEach((range) => {
              if (!range.event_id || !range.start_time || !range.end_time) return;
              const color = getEventColor(range.event_id, events);
              const startTime = new Date(range.start_time);
              const endTime = new Date(range.end_time);
              const x0 = xZoomMulti(startTime) + multiXOffset;
              const x1 = xZoomMulti(endTime) + multiXOffset;
              const domain = xZoomMulti.domain();
              if (endTime < domain[0] || startTime > domain[1]) return;
              overlayGroup.append("rect")
                .attr("class", "event-overlay")
                .attr("x", Math.min(x0, x1))
                .attr("y", 0)
                .attr("width", Math.abs(x1 - x0))
                .attr("height", multiHeight)
                .attr("fill", color)
                .attr("opacity", 0.2)
                .attr("pointer-events", "none")
                .style("mix-blend-mode", "multiply");
            });
          }
          if (currentIsCut && currentCutEvents && currentCutEvents.length > 1) {
            const cutOverlayGroup = s.insert("g", ":first-child")
              .attr("class", "cut-overlays-group")
              .attr("clip-path", `url(#${clipId})`);
            currentCutEvents.forEach((range, index) => {
              if (typeof range === 'number' || !range.start_time || !range.end_time) return;
              const startTime = new Date(range.start_time);
              const endTime = new Date(range.end_time);
              const x0 = xZoomMulti(startTime) + multiXOffset;
              const x1 = xZoomMulti(endTime) + multiXOffset;
              const domain = xZoomMulti.domain();
              if (endTime < domain[0] || startTime > domain[1]) return;
              cutOverlayGroup.append("rect")
                .attr("class", "cut-overlay")
                .attr("x", Math.min(x0, x1))
                .attr("y", 0)
                .attr("width", Math.abs(x1 - x0))
                .attr("height", multiHeight)
                .attr("fill", getColorByIndex(index))
                .attr("opacity", 0.2)
                .attr("pointer-events", "none")
                .style("mix-blend-mode", "multiply");
            });
          }
        });
      };

      const brushMulti = d3.brushX()
        .extent([[multiXOffset, 0], [multiWidth + multiXOffset, multiHeight]])
        .on("end", (event) => {
          if (isProgrammaticallyUpdatingBrush) return;
          if (event.selection) {
            const [x0, x1] = event.selection.map((x) => xZoomMulti.invert(x - multiXOffset));
            const t0 = x0 instanceof Date ? x0.getTime() : typeof x0 === 'number' ? x0 : NaN;
            const t1 = x1 instanceof Date ? x1.getTime() : typeof x1 === 'number' ? x1 : NaN;
            if (!Number.isFinite(t0) || !Number.isFinite(t1)) return;
            xZoomMulti.domain([x0, x1]);
            setSelectedRange([{ start_time: new Date(t0).toISOString(), end_time: new Date(t1).toISOString() }]);
            if (requestTimeControl('timeseries')) setSelectedTime(new Date(t0), 'timeseries');
            setZoom(true);
            setHasSelection(true);
            shouldSkipBrushRestoreAfterZoom = true;
            brushGroupsMulti.forEach((bg) => { bg.call(brushMulti.move, null); });
            const savedScrollTop = containerRef ? containerRef.scrollTop : null;
            const savedScrollLeft = containerRef ? containerRef.scrollLeft : null;
            redrawMulti();
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (containerRef && savedScrollTop != null && savedScrollLeft != null) {
                  containerRef.scrollTop = savedScrollTop;
                  containerRef.scrollLeft = savedScrollLeft;
                }
              });
            });
          } else {
            // Single click (no drag): set selectedTime from click position (same conversion as mousemove/overlay so cursor and click align under <1620)
            const se = event.sourceEvent as MouseEvent | undefined;
            if (se) {
              const targetEl = se.target as Element | null;
              const hitSvg = targetEl?.closest?.('svg') ?? (targetEl as SVGElement | null)?.ownerSVGElement ?? chartContainers[0]?.querySelector?.('svg') ?? null;
              const range = xZoomMulti.range() as [number, number];
              const clampedX = multiChartEventToClampedX(se, hitSvg as SVGElement | null, multiContainerWidth, margin.left, multiXOffset, range);
              if (clampedX != null) {
                const time = xZoomMulti.invert(clampedX);
                const timeMs = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : NaN;
                if (Number.isFinite(timeMs) && requestTimeControl('timeseries')) {
                  setIsManualTimeChange(true);
                  setSelectedTime(new Date(timeMs), 'timeseries');
                }
                updateSelectedTimeLineMulti();
              }
            }
          }
        });
      const brushGroupsMulti: d3.Selection<SVGGElement, unknown, null, undefined>[] = [];
      allSvgs.forEach((s) => {
        const bg = s.append("g").attr("class", "brush").attr("pointer-events", "all").call(brushMulti);
        brushGroupsMulti.push(bg);
      });
      const firstSvg = allSvgs[0];
      lastBrushCreateTime = Date.now();
      const handleDblclickMulti = () => {
        debug('🖱️ TimeSeries: Double-click (multi) - clearing selection and resetting zoom');
        setIsManualTimeChange(false);
        const currentIsCut = isCut();
        const currentCutEvents = cutEvents();
        const hasActiveCuts = currentIsCut && currentCutEvents && currentCutEvents.length > 0;
        if (hasActiveCuts) {
          clearActiveSelection();
        } else {
          clearSelection();
        }
        xZoomMulti.domain(xScaleMulti.domain());
        redrawMulti();
        updateSelectedTimeLineMulti();
      };
      allSvgs.forEach((s) => s.on("dblclick", handleDblclickMulti));
      updateSelectedTimeLineMulti();
      drawEventOverlaysMulti();
      d3.select(containerRef).select(".timeseries-scroll-spacer").remove();
      d3.select(containerRef)
        .append("div")
        .attr("class", "timeseries-scroll-spacer")
        .style("height", `${multiHeight * 1.5}px`)
        .style("width", "100%")
        .style("flex-shrink", "0");
      const redrawMulti = () => {
        drawPlots();
      };
      d3.select(containerRef).selectAll(".tooltip").remove();
      const tooltipMulti = d3.select(containerRef).append("div").attr("class", "tooltip")
        .style("position", "absolute").style("background", "#fff").style("border", "1px solid #ccc")
        .style("padding", "5px").style("border-radius", "5px").style("pointer-events", "none").style("visibility", "hidden");
      allSvgs.forEach((s, i) => {
        s.on("mousemove", function (event: MouseEvent) {
          // When window is narrow the media-container is CSS-scaled (e.g. <1620px). Use SVG's
          // getBoundingClientRect() so client coords are converted to chart logical coords correctly.
          const svgEl = (s.node() as SVGElement).ownerSVGElement;
          const rect = svgEl?.getBoundingClientRect();
          let lineXInG: number;
          if (rect && rect.width > 0) {
            const logicalX = (event.clientX - rect.left) * (multiContainerWidth / rect.width);
            lineXInG = logicalX - margin.left;
          } else {
            const pt = d3.pointer(event);
            lineXInG = pt[0];
          }
          const rawX = lineXInG - multiXOffset; // position in scale range [0, multiWidth]
          const range = xZoomMulti.range();
          const rangeMin = Math.min(range[0], range[1]);
          const rangeMax = Math.max(range[0], range[1]);
          const clampedX = rangeMax > rangeMin ? Math.max(rangeMin, Math.min(rangeMax, rawX)) : rangeMin;
          const xValueDate = xZoomMulti.invert(clampedX);
          const timeMs = xValueDate instanceof Date ? xValueDate.getTime() : typeof xValueDate === 'number' ? xValueDate : NaN;
          verticalLinesMulti[i].attr("x1", lineXInG).attr("x2", lineXInG).attr("visibility", "visible");
          if (!Number.isFinite(timeMs)) {
            tooltipMulti.style("visibility", "hidden");
            return;
          }
          let content = `Time: ${formatTime(xValueDate, datasetTimezone()) || xValueDate.toLocaleTimeString()}`;
          const tipD0 = xZoomMulti.domain()[0];
          const tipD1 = xZoomMulti.domain()[1];
          chartsData[i].series.forEach((series) => {
            if (series.data.length === 0) return;
            const tipY = getTransformedValueAtClosestTime(
              series,
              timeMs,
              tipD0,
              tipD1,
              segmentGapForLayout,
              undefined,
              CLOSEST_SAMPLE_TOOLTIP_MAX_MS
            );
            if (tipY !== undefined) {
              content += `<br>${seriesDisplayName(series)}: ${Round(tipY, 2)}`;
            }
          });
          tooltipMulti.style("top", `${event.clientY}px`).style("left", `${event.clientX}px`).style("visibility", "visible").html(content);
        });
        s.on("mouseout", function () {
          if (!isPlaying()) verticalLinesMulti[i].attr("visibility", "hidden");
          tooltipMulti.style("visibility", "hidden");
        });
      });
      d3.select(containerRef).property("__timeSeriesRefs", {
        verticalLine: verticalLinesMulti[0],
        selectedTimeLine: selectedTimeLinesMulti[0],
        selectedTimeLines: selectedTimeLinesMulti,
        verticalLines: verticalLinesMulti,
        xZoom: xZoomMulti,
        xScale: xScaleMulti,
        xOffset: multiXOffset,
        totalHeight: multiHeight,
        svg: firstSvg,
        allSvgs,
        margin,
        redraw: redrawMulti,
        brush: brushMulti,
        restoreBrushSelection: () => { /* multi-container: full redraw handles brush */ },
        updateSelectedTimeLine: updateSelectedTimeLineMulti,
        xScaleDomain: xScaleMulti.domain(),
        fullDataExtent: fullDataExtentMulti,
        drawEventOverlays: drawEventOverlaysMulti,
        isMultiContainer: true
      });
      // When playing with a time window, apply display window so time-window effect can scroll (same as single-chart path).
      const PLAYBACK_LEAD_MS = 10 * 1000;
      const twAfterRefs = (typeof timeWindow === 'function') ? timeWindow() : 0;
      if (twAfterRefs > 0 && isPlaying()) {
        const center = getDisplayWindowReferenceTime();
        if (center instanceof Date && !isNaN(center.getTime())) {
          const windowEnd = center.getTime() + PLAYBACK_LEAD_MS;
          const windowStart = windowEnd - (twAfterRefs * 60 * 1000);
          xZoomMulti.domain([windowStart, windowEnd]);
          redrawMulti();
        }
      }
      // Defer so time-window effect doesn't run in same tick as drawPlots (avoids lockup on play).
      requestAnimationFrame(() => setRefsReady(true));
      wheelHandler = (event: WheelEvent) => {
        if (!containerRef || !containerRef.contains(event.target as Node)) return;
        const refs = d3.select(containerRef).property("__timeSeriesRefs") as any;
        if (!refs?.xZoom || !refs.xScale || !refs.redraw) return;
        const currentXZoom = refs.xZoom as d3.ScaleTime<number, number>;
        const currentXScale = refs.xScale as d3.ScaleTime<number, number>;
        const zoomDomain = currentXZoom.domain();
        const scaleDomain = currentXScale.domain();
        if (zoomDomain.length !== 2 || scaleDomain.length !== 2) return;
        const fullExtent = refs.fullDataExtent as [Date, Date] | null | undefined;
        const dataMin = fullExtent?.[0] ?? scaleDomain[0];
        const dataMax = fullExtent?.[1] ?? scaleDomain[1];
        const zoomSpan = zoomDomain[1].getTime() - zoomDomain[0].getTime();
        const dataSpan = dataMax.getTime() - dataMin.getTime();
        const isActuallyZoomed = dataSpan > 0 && (
          zoomSpan < dataSpan - 1000 ||
          Math.abs(zoomDomain[0].getTime() - dataMin.getTime()) > 1000 ||
          Math.abs(zoomDomain[1].getTime() - dataMax.getTime()) > 1000
        );
        if (isActuallyZoomed) {
          event.preventDefault();
          event.stopPropagation();
          const [minX, maxX] = zoomDomain;
          const extent = maxX.getTime() - minX.getTime();
          const panAmount = extent * 0.1;
          const deltaX = typeof event.deltaX === 'number' ? event.deltaX : 0;
          const deltaY = typeof event.deltaY === 'number' ? event.deltaY : 0;
          const delta = Math.abs(deltaX) > 0 ? deltaX : deltaY;
          const direction = Math.sign(delta);
          let x0 = new Date(minX.getTime() + direction * panAmount);
          let x1 = new Date(maxX.getTime() + direction * panAmount);
          if (x0 < dataMin || x1 > dataMax) return;
          currentXZoom.domain([x0, x1]);
          const currentSelectedRange = selectedRange();
          if (currentSelectedRange?.length) {
            setSelectedRange([{ start_time: x0.toISOString(), end_time: x1.toISOString() }]);
            const currentSelectedTime = selectedTime();
            if (currentSelectedTime && (currentSelectedTime < x0 || currentSelectedTime > x1) && requestTimeControl('timeseries')) {
              setIsManualTimeChange(true);
              setSelectedTime(x0, 'timeseries');
            }
          }
          refs.redraw();
        }
      };
      if (containerRef) {
        containerRef.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
      }
      bumpFleetLegendTableEpoch((n) => n + 1);
      setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 150);
      return;
    }

    debug('🎨 TimeSeries: Drawing charts with data:', {
      chartCount: chartsData.length,
      timestamp: new Date().toISOString()
    });

    const containerWidth = containerRef?.offsetWidth || 0;
    const width = Math.max(containerWidth - margin.left - margin.right, 0);

    // Additional safety check for valid dimensions
    if (containerWidth <= 0) {
      warn('🎨 TimeSeries: Container has no width, skipping draw');
      return;
    }
    const height = getChartHeight();
    const totalHeight = chartsData.length * (height + rowGap) - rowGap + margin.top + margin.bottom;

    // Define xOffset at the outer scope so it's available to all functions
    const xOffset = 10;

    // Clear the container before redrawing
    debug('🎨 TimeSeries: Clearing existing SVG');
    // Prevent brush "end" (from teardown or new brush init) from clearing selectedRange
    isProgrammaticallyUpdatingBrush = true;
    // Clean up old wheel handler if it exists
    if (containerRef && wheelHandler) {
      containerRef.removeEventListener('wheel', wheelHandler, { capture: true });
    }
    d3.select(containerRef).select("svg").remove();
    svg = null;
    wheelHandler = null;

    // Create a new SVG container
    debug('🎨 TimeSeries: Creating new SVG container', {
      containerWidth,
      totalHeight,
      margin
    });
    svg = d3
      .select(containerRef)
      .append("svg")
      .attr("width", containerWidth)
      .attr("height", totalHeight)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    svg
      .append("defs")
      .append("clipPath")
      .attr("id", "clip")
      .append("rect")
      .attr("width", width + xOffset) // Include offset in the clip path width
      .attr("height", totalHeight - margin.bottom);

    // Extract and filter all x values (timestamps) from chart data
    // Debug: Log data structure to diagnose x value extraction
    if (chartsData.length > 0 && chartsData[0].series && chartsData[0].series.length > 0) {
      const firstSeries = chartsData[0].series[0];
      const sampleDataPoint = firstSeries.data && firstSeries.data.length > 0 ? firstSeries.data[0] : null;
      debug(`[TimeSeries] Extracting x values:`, {
        chartCount: chartsData.length,
        firstSeriesXAxis: firstSeries.xaxis?.name,
        sampleDataPointKeys: sampleDataPoint ? Object.keys(sampleDataPoint).slice(0, 10) : 'no data',
        sampleDataPointX: sampleDataPoint?.x,
        sampleDataPointDatetime: sampleDataPoint?.Datetime,
        totalDataPoints: chartsData.reduce((sum, chart) => sum + (chart.series?.reduce((s: number, ser: any) => s + (ser.data?.length || 0), 0) || 0), 0)
      });
    }

    const allXValues = chartsData.flatMap((chart) =>
      chart.series.flatMap((series) =>
        series.data
          .filter((d) => {
            // Check if y value is valid (not null, undefined, or NaN)
            // Allow 0 as it's a valid value
            return d.y !== null && d.y !== undefined && !isNaN(d.y);
          })
          .map((d) => d.x)
      )
    )
      .filter((x): x is Date => {
        // Filter out null, undefined, and invalid Date values
        if (x === null || x === undefined) return false;
        if (!(x instanceof Date)) return false;
        const time = x.getTime();

        // Filter out invalid dates
        if (isNaN(time) || !isFinite(time)) return false;

        // Filter out epoch dates (1970-01-01) and dates very close to epoch (within 1 day)
        // to catch timezone-adjusted epoch dates
        const oneDayInMs = 24 * 60 * 60 * 1000;
        if (time <= oneDayInMs) return false;

        // Filter out dates that are too far in the future (likely errors)
        // Use a reasonable upper bound: 100 years from now
        const now = Date.now();
        const oneHundredYearsInMs = 100 * 365 * 24 * 60 * 60 * 1000;
        if (time > now + oneHundredYearsInMs) return false;

        // Filter out dates that are too far in the past (before year 1900, likely errors)
        const year1900 = new Date('1900-01-01').getTime();
        if (time < year1900) return false;

        return true;
      });

    // Calculate extent using a more robust method to avoid outliers
    let xExtent: [Date, Date] | [undefined, undefined] = [undefined, undefined];

    // Check if dataset event time range is provided (for dataset or fleet mode)
    const datasetEventTimeRange = props.datasetEventTimeRange as { start: Date | string | number; end: Date | string | number } | undefined;
    if (datasetEventTimeRange && datasetEventTimeRange.start && datasetEventTimeRange.end) {
      // Use dataset event time range to limit x-scale
      const startTime = typeof datasetEventTimeRange.start === 'number'
        ? new Date(datasetEventTimeRange.start)
        : new Date(datasetEventTimeRange.start);
      const endTime = typeof datasetEventTimeRange.end === 'number'
        ? new Date(datasetEventTimeRange.end)
        : new Date(datasetEventTimeRange.end);

      if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime()) && startTime.getTime() < endTime.getTime()) {
        xExtent = [startTime, endTime];
        debug('🎨 TimeSeries: Using dataset event time range for x-scale', {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          rangeMs: endTime.getTime() - startTime.getTime(),
          rangeHours: ((endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60)).toFixed(2)
        });
      } else {
        warn('🎨 TimeSeries: Invalid dataset event time range, falling back to data extent', {
          startTime: datasetEventTimeRange.start,
          endTime: datasetEventTimeRange.end
        });
      }
    }

    // If dataset event time range not provided or invalid, calculate from data
    if (!xExtent[0] || !xExtent[1]) {
      if (allXValues.length > 0) {
        // Sort timestamps to enable outlier detection
        const sortedTimes = allXValues.map(d => d.getTime()).sort((a, b) => a - b);

        const fullMin = sortedTimes[0];
        const fullMax = sortedTimes[sortedTimes.length - 1];
        const fullRange = fullMax - fullMin;

        // Check for outliers: if the first/last few points are way outside the main cluster
        // Only use percentile filtering if we detect significant outliers
        let hasOutliers = false;

        if (sortedTimes.length > 100) {
          // Calculate interquartile range (IQR) to detect outliers
          const q1Index = Math.floor(sortedTimes.length * 0.25);
          const q3Index = Math.floor(sortedTimes.length * 0.75);
          const q1 = sortedTimes[q1Index];
          const q3 = sortedTimes[q3Index];
          const iqr = q3 - q1;

          // Check if min/max are outliers (more than 3 IQRs away from Q1/Q3)
          const outlierThreshold = 3 * iqr;
          const minOutlier = (fullMin < q1 - outlierThreshold);
          const maxOutlier = (fullMax > q3 + outlierThreshold);

          hasOutliers = minOutlier || maxOutlier;

          if (hasOutliers) {
            // Use 1st and 99th percentile to exclude outliers
            const percentile1 = Math.floor(sortedTimes.length * 0.01);
            const percentile99 = Math.floor(sortedTimes.length * 0.99);

            const minTime = sortedTimes[Math.max(0, percentile1)];
            const maxTime = sortedTimes[Math.min(sortedTimes.length - 1, percentile99)];

            xExtent = [new Date(minTime), new Date(maxTime)];
            debug('🎨 TimeSeries: Detected outliers, using percentile-based extent (1st-99th)', {
              totalPoints: sortedTimes.length,
              minTime: new Date(minTime).toISOString(),
              maxTime: new Date(maxTime).toISOString(),
              fullMin: new Date(fullMin).toISOString(),
              fullMax: new Date(fullMax).toISOString(),
              minOutlier,
              maxOutlier
            });
          }
        }

        // If no outliers detected, use full extent
        if (!hasOutliers) {
          xExtent = d3.extent(allXValues) as [Date, Date] | [undefined, undefined];
          debug('🎨 TimeSeries: Using full extent (no outliers detected)', {
            totalPoints: sortedTimes.length,
            extent: xExtent.map(d => d ? d.toISOString() : 'undefined'),
            rangeMs: fullRange,
            rangeHours: (fullRange / (1000 * 60 * 60)).toFixed(2)
          });
        }
      }
    }

    // Full data extent from chart data (for wheel pan: isActuallyZoomed and pan bounds when parent passes zoomed range as datasetEventTimeRange)
    const fullDataExtent: [Date, Date] | null = allXValues.length > 0
      ? (d3.extent(allXValues) as [Date, Date])
      : null;

    debug('🎨 TimeSeries: Creating scales', {
      allXValuesCount: allXValues.length,
      xExtent: xExtent.map(d => d ? d.toISOString() : 'undefined'),
      width
    });

    const xScale = d3
      .scaleTime()
      .range([0, width]);

    // Set domain only if we have valid extent values
    if (xExtent[0] && xExtent[1] && !isNaN(xExtent[0].getTime()) && !isNaN(xExtent[1].getTime()) && xExtent[0].getTime() !== xExtent[1].getTime()) {
      xScale.domain(xExtent as [Date, Date]);
    } else {
      // Fallback to a default time range if domain is invalid or no valid x values
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      xScale.domain([oneDayAgo, now]);
      warn('🎨 TimeSeries: No valid x values found, using default time range', {
        allXValuesCount: allXValues.length,
        xExtent: xExtent.map(d => d ? d.toISOString() : 'undefined')
      });
    }

    // Ensure xScale has a valid domain before creating xZoom
    const xDomain = xScale.domain();

    const xZoom = xScale.copy();

    // Apply zoom domain from selectedRange immediately if it exists
    // This prevents the flash of the full timeline when brush selection triggers a redraw
    const currentSelectedRange = selectedRange();
    if (currentSelectedRange && currentSelectedRange.length > 0 && !isCut()) {
      const rangeItem = currentSelectedRange[0];
      const startTime = new Date(rangeItem.start_time);
      const endTime = new Date(rangeItem.end_time);

      // Validate the times are within the full domain
      const fullDomain = xScale.domain();
      if (startTime >= fullDomain[0] && endTime <= fullDomain[1] && startTime < endTime) {
        debug('🎨 TimeSeries: Applying zoom domain from selectedRange in drawPlots', {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString()
        });
        xZoom.domain([startTime, endTime]);
      }
    }

    // Declare selectedTimeLine early so updateSelectedTimeLine can close over it without TDZ
    let selectedTimeLine: d3.Selection<SVGLineElement, unknown, null, undefined>;

    // Function to update legend text when selectedTime changes
    const updateLegendText = () => {
      if (props.showLegendTable) return; // Fleet mode: use side table only, no in-chart legend
      const time = selectedTime();
      const chartsData = charts();

      if (!chartsData || chartsData.length === 0) {
        return;
      }

      // Get the current xZoom from refs
      const refs = d3.select(containerRef).property("__timeSeriesRefs");
      const currentXZoom = refs?.xZoom || xZoom;

      if (!currentXZoom || !currentXZoom.domain || currentXZoom.domain().length === 0) {
        return;
      }

      const height = getChartHeight();

      const ltIsCut = isCut();
      const ltCutEvents = cutEvents();
      const ltHasMultipleCutRanges = ltIsCut && ltCutEvents && ltCutEvents.length > 1;
      const getCutRangeIndexLt = (point: { x: Date; y: number }) => {
        if (!ltHasMultipleCutRanges) return -1;
        const pointTime = point.x instanceof Date ? point.x.getTime() : new Date(point.x).getTime();
        for (let ci = 0; ci < ltCutEvents.length; ci++) {
          const range = ltCutEvents[ci];
          if (typeof range === "number") continue;
          if (range.start_time && range.end_time) {
            const startTime = new Date(range.start_time).getTime();
            const endTime = new Date(range.end_time).getTime();
            if (pointTime >= startTime && pointTime <= endTime) {
              return ci;
            }
          }
        }
        return -1;
      };

      const ltLo = currentXZoom.domain()[0];
      const ltHi = currentXZoom.domain()[1];
      const ltTimeTh = segmentGapForLayout;

      chartsData.forEach((chart, chartIndex) => {
        // Calculate max label length for padding (same as in redraw)
        const maxLabelLength = Math.max(
          ...chart.series.map(series => seriesDisplayName(series).length)
        );
        const paddedLength = maxLabelLength + 3;

        chart.series.forEach((series, seriesIndex) => {
          // Find the legend text element
          const legendText = svg.select(`.chart-group-${chartIndex} .legend-${seriesIndex}`);

          if (legendText.empty()) {
            return; // Legend doesn't exist yet
          }

          const lineType = normalizeLineType(series.lineType);
          const rawSegsLt = splitSeriesIntoVisibleSegments(
            series.data,
            ltLo,
            ltHi,
            ltTimeTh,
            ltHasMultipleCutRanges ? getCutRangeIndexLt : undefined
          );

          const transformedLt = applyLineTypeToSegmentsWithOptionalCarry(rawSegsLt, lineType);
          const flatDisplayLt: number[] = [];
          for (const tpts of transformedLt) {
            for (const p of tpts) {
              if (isFiniteDisplayY(p)) {
                flatDisplayLt.push(p.displayY);
              }
            }
          }

          let min: number | undefined;
          let max: number | undefined;
          let avg: number | undefined;
          let std: number | undefined;

          if (flatDisplayLt.length > 0) {
            min = d3.min(flatDisplayLt);
            max = d3.max(flatDisplayLt);
            avg = d3.mean(flatDisplayLt);
            std =
              avg !== undefined && avg !== null && !isNaN(avg) && flatDisplayLt.length > 0
                ? Math.sqrt(d3.mean(flatDisplayLt, (y) => Math.pow(y - avg!, 2)) ?? 0)
                : undefined;
          } else {
            const visibleRawLt = series.data.filter(
              (d) =>
                d.x >= ltLo &&
                d.x <= ltHi &&
                d.y !== null &&
                d.y !== undefined &&
                !isNaN(Number(d.y)) &&
                isFinite(Number(d.y))
            );
            const statSourceLt =
              visibleRawLt.length > 0
                ? visibleRawLt
                : series.data.filter(
                  (d) => d.y !== null && d.y !== undefined && !isNaN(d.y) && isFinite(d.y)
                );
            if (statSourceLt.length > 0) {
              min = d3.min(statSourceLt, (d) => Number(d.y));
              max = d3.max(statSourceLt, (d) => Number(d.y));
              avg = d3.mean(statSourceLt, (d) => Number(d.y));
              std =
                avg !== undefined && avg !== null && !isNaN(avg) && statSourceLt.length > 0
                  ? Math.sqrt(d3.mean(statSourceLt, (d) => Math.pow(Number(d.y) - avg, 2)) ?? 0)
                  : undefined;
            }
          }

          // Format statistics
          const formatStat = (val: number | undefined | null) => {
            if (val === undefined || val === null || isNaN(val) || !isFinite(val)) {
              return 'N/A';
            }
            return Round(val, 2);
          };

          let selectedValueText = '';
          if (time && series.data.length > 0) {
            const selDisp = getTransformedValueAtClosestTime(
              series,
              time.getTime(),
              ltLo,
              ltHi,
              ltTimeTh,
              ltHasMultipleCutRanges ? getCutRangeIndexLt : undefined,
              CLOSEST_SAMPLE_UI_MARKER_MAX_MS
            );
            if (selDisp !== undefined) {
              selectedValueText = ` [Sel: ${formatStat(selDisp)}]`;
            }
          }

          // Build the legend text
          const displayName = seriesDisplayName(series);
          let paddedName = displayName;
          if (displayName.length + 3 != paddedLength) {
            paddedName = displayName.padEnd(paddedLength, "\u00A0");
          }

          const legendTextContent = `${paddedName}${selectedValueText} [Min: ${formatStat(min)}] [Max: ${formatStat(max)}] [Avg: ${formatStat(avg)}] [Std: ${formatStat(std)}]${dataResampleLegendBracket(series.dataResample)} [Type: ${lineTypeDisplayLabel(series.lineType)}]`;

          // Update the text
          legendText.text(legendTextContent);
        });
      });
    };

    // Function to update the selected time line and value labels
    const updateSelectedTimeLine = () => {
      if (!selectedTimeLine) return; // Not yet created (avoid TDZ / early call)
      const time = selectedTime();

      if (!time) {
        selectedTimeLine.attr("visibility", "hidden");
        // Update legend text even when time is null to clear Sel value
        updateLegendText();
        return;
      }

      // Check if xZoom is properly initialized
      if (!xZoom || !xZoom.domain || xZoom.domain().length === 0) {

        selectedTimeLine.attr("visibility", "hidden");
        return;
      }

      // Check if time is within the domain
      const domain = xZoom.domain();
      const isTimeVisible = time >= domain[0] && time <= domain[1];

      if (!isTimeVisible) {
        selectedTimeLine.attr("visibility", "hidden");
      }

      // Update the persistent selected time line only if time is visible
      if (isTimeVisible) {
        const xPos = xZoom(time) + xOffset;

        // Check for NaN values and hide the line if invalid
        if (isNaN(xPos) || !isFinite(xPos)) {
          selectedTimeLine.attr("visibility", "hidden");
        } else {
          selectedTimeLine
            .attr("x1", xPos)
            .attr("x2", xPos)
            .attr("visibility", "visible");
        }
      }

      // Prepare data for all points that should be shown at the selected time (circles always; labels only when not using side table)
      const allPointData: Array<{ id: string; x: number; y: number; color: string; text: string; textX: number; textY: number }> = [];

      const height = getChartHeight();
      const stIsCut = isCut();
      const stCutEvents = cutEvents();
      const stHasMultipleCutRanges = stIsCut && stCutEvents && stCutEvents.length > 1;
      const getCutRangeIndexSt = (point: { x: Date; y: number }) => {
        if (!stHasMultipleCutRanges) return -1;
        const pointTime = point.x instanceof Date ? point.x.getTime() : new Date(point.x).getTime();
        for (let ci = 0; ci < stCutEvents.length; ci++) {
          const range = stCutEvents[ci];
          if (typeof range === "number") continue;
          if (range.start_time && range.end_time) {
            const startTime = new Date(range.start_time).getTime();
            const endTime = new Date(range.end_time).getTime();
            if (pointTime >= startTime && pointTime <= endTime) {
              return ci;
            }
          }
        }
        return -1;
      };
      const stLo = xZoom.domain()[0];
      const stHi = xZoom.domain()[1];
      const stTimeTh = segmentGapForLayout;

      chartsData.forEach((chart, chartIndex) => {
        const yOffset = chartIndex * (height + rowGap);

        const visibleData = chart.series.flatMap((series) =>
          series.data.filter((d) => d.x >= stLo && d.x <= stHi)
        );
        const allYFromT = chart.series.flatMap((s) =>
          collectFiniteDisplayYValues(s, stLo, stHi, stTimeTh, stHasMultipleCutRanges ? getCutRangeIndexSt : undefined)
        );
        const allYValuesForTime =
          allYFromT.length > 0
            ? allYFromT
            : chart.series.flatMap((series) =>
              series.data
                .map((d) => d.y)
                .filter((v) => v != null && Number.isFinite(Number(v)))
                .map((v) => Number(v))
            );
        let yDomainForTime = safeNumericYDomain(allYValuesForTime);
        if (visibleData.length > 0 && yDomainForTime[1] > yDomainForTime[0]) {
          const yPadding = (yDomainForTime[1] - yDomainForTime[0]) * 0.2;
          yDomainForTime = [yDomainForTime[0], yDomainForTime[1] + yPadding];
        }
        const yScale = d3.scaleLinear().domain(yDomainForTime).range([height, 0]);

        chart.series.forEach((series, seriesIndex) => {
          if (series.data.length === 0) return;
          const timeMs = time.getTime();
          const yDisp = getTransformedValueAtClosestTime(
            series,
            timeMs,
            stLo,
            stHi,
            stTimeTh,
            stHasMultipleCutRanges ? getCutRangeIndexSt : undefined,
            CLOSEST_SAMPLE_UI_MARKER_MAX_MS
          );
          if (yDisp !== undefined) {
            const closestPoint = series.data.reduce((prev, curr) => {
              const pt = prev.x instanceof Date ? prev.x.getTime() : new Date(prev.x).getTime();
              const ct = curr.x instanceof Date ? curr.x.getTime() : new Date(curr.x).getTime();
              return Math.abs(ct - timeMs) < Math.abs(pt - timeMs) ? curr : prev;
            });
            const pointTime = isTimeVisible
              ? time
              : closestPoint.x instanceof Date
                ? closestPoint.x
                : new Date(closestPoint.x);
            const xPos = xZoom(pointTime) + xOffset;
            const yPos = yScale(yDisp) + yOffset;
            if (
              !isNaN(xPos) &&
              isFinite(xPos) &&
              !isNaN(yPos) &&
              isFinite(yPos) &&
              yPos >= 0 &&
              yPos <= totalHeight &&
              xPos >= 0 &&
              xPos <= width + xOffset
            ) {
              allPointData.push({
                id: `${chartIndex}-${seriesIndex}`,
                x: xPos,
                y: yPos,
                color: series.color,
                text: `${seriesDisplayName(series)}: ${Round(yDisp, 2)}`,
                textX: xPos + 5,
                textY: yPos + 4,
              });
            }
          }
        });
      });

      // Determine if transitions should be used based on playback speed
      const isNormalSpeed = !isPlaying() || playbackSpeed() === 1;
      const transitionDuration = isNormalSpeed && isPlaying() ? 250 : 0;

      // Use D3's data join pattern for smooth transitions

      // Update circles
      const circles = svg.selectAll("circle.time-value-label")
        .data(allPointData, d => d.id);

      // Exit old circles
      circles.exit()
        .transition()
        .duration(transitionDuration)
        .style("opacity", 0)
        .remove();

      // Enter new circles
      circles.enter()
        .append("circle")
        .attr("class", "time-value-label")
        .attr("r", 4)
        .attr("fill", d => d.color)
        .attr("stroke", "white")
        .attr("stroke-width", 1)
        .attr("clip-path", "url(#clip)") // Add clip path to circles
        .style("opacity", 0)
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .transition()
        .duration(transitionDuration)
        .style("opacity", 1);

      // Update existing circles
      circles
        .attr("clip-path", "url(#clip)") // Ensure clip path is applied
        .transition()
        .duration(transitionDuration)
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("fill", d => d.color);

      // Update text labels (only when not using side legend table - points/circles always shown)
      const labelData = props.showLegendTable ? [] : allPointData;
      const texts = svg.selectAll("text.time-value-label")
        .data(labelData, (d: unknown) => (d as { id: string }).id);

      texts.exit()
        .transition()
        .duration(transitionDuration)
        .style("opacity", 0)
        .remove();

      texts.enter()
        .append("text")
        .attr("class", "time-value-label")
        .attr("font-size", "12px")
        .attr("text-anchor", "start")
        .attr("clip-path", "url(#clip)")
        .style("opacity", 0)
        .attr("fill", (d: { color: string }) => d.color)
        .text((d: { text: string }) => d.text)
        .attr("x", (d: { textX: number }) => d.textX)
        .attr("y", (d: { textY: number }) => d.textY)
        .transition()
        .duration(transitionDuration)
        .style("user-select", "none")
        .style("pointer-events", "none")
        .style("opacity", 1);

      texts
        .attr("clip-path", "url(#clip)")
        .transition()
        .duration(transitionDuration)
        .text((d: { text: string }) => d.text)
        .attr("x", (d: { textX: number }) => d.textX)
        .attr("y", (d: { textY: number }) => d.textY - 10)
        .attr("fill", (d: { color: string }) => d.color);

      // Update legend text with new Sel value
      updateLegendText();
    };

    // Modify the redraw function to properly handle segments when zoomed
    const redraw = () => {
      // Get the current xZoom from refs to ensure we're using the latest domain
      const refs = d3.select(containerRef).property("__timeSeriesRefs");
      const currentXZoom = refs?.xZoom || xZoom;

      debug('🔄 TimeSeries: Redraw called', {
        xZoomDomain: currentXZoom.domain(),
        xZoomDomainFormatted: currentXZoom.domain().map(d => safeToISOString(d)),
        isRedrawing
      });

      // Set flag to prevent selection clearing effect from triggering
      isRedrawing = true;

      // Clear all previously drawn chart features
      svg.selectAll(".chart-group").remove();

      // Group to hold all chart features
      const chartGroup = svg
        .selectAll(".chart-group")
        .data(charts)
        .enter()
        .append("g")
        .attr("class", (d, i) => `chart-group chart-group-${i}`);

      // Use xOffset defined in outer scope, no need to redefine it here

      chartGroup.each(function (chart, i) {
        const height = getChartHeight();
        const yOffset = i * (height + rowGap);
        const group = d3.select(this);

        const currentIsCut = isCut();
        const currentCutEvents = cutEvents();
        const hasMultipleCutRanges = currentIsCut && currentCutEvents && currentCutEvents.length > 1;

        const getCutRangeIndex = (point: { x: Date; y: number }) => {
          if (!hasMultipleCutRanges) return -1;
          const pointTime = point.x instanceof Date ? point.x.getTime() : new Date(point.x).getTime();
          for (let ci = 0; ci < currentCutEvents.length; ci++) {
            const range = currentCutEvents[ci];
            if (typeof range === "number") continue;
            if (range.start_time && range.end_time) {
              const startTime = new Date(range.start_time).getTime();
              const endTime = new Date(range.end_time).getTime();
              if (pointTime >= startTime && pointTime <= endTime) {
                return ci;
              }
            }
          }
          return -1;
        };

        const zoLo = currentXZoom.domain()[0];
        const zoHi = currentXZoom.domain()[1];
        const timeTh = segmentGapForLayout;

        const stackedAreaActive =
          chart.stackedArea === true && !props.showLegendTable && chart.series.length > 0;
        const stackedPlan = stackedAreaActive
          ? buildExploreStackedRenderPlan(
              chart.series,
              zoLo,
              zoHi,
              timeTh,
              hasMultipleCutRanges ? getCutRangeIndex : undefined
            )
          : null;
        const stackedDrawing = Boolean(stackedPlan && stackedPlan.stacked.length > 0);

        const visibleData = chart.series.flatMap((series) =>
          series.data.filter((d) => d.x >= zoLo && d.x <= zoHi)
        );

        let yDomain: [number, number];
        if (stackedDrawing && stackedPlan) {
          const [smin, smax] = exploreStackExtent(stackedPlan.stacked);
          yDomain = safeNumericYDomain([smin, smax]);
          if (visibleData.length > 0 && yDomain[1] > yDomain[0]) {
            const yPadding = (yDomain[1] - yDomain[0]) * 0.2;
            yDomain = [yDomain[0], yDomain[1] + yPadding];
          }
        } else {
          const perSeriesY = chart.series.map((s) =>
            collectFiniteDisplayYValues(s, zoLo, zoHi, timeTh, hasMultipleCutRanges ? getCutRangeIndex : undefined)
          );
          const allYFromTransforms = perSeriesY.flat();
          const supplementY = chart.series.flatMap((s, i) =>
            perSeriesY[i].length === 0 ? collectVisibleWindowRawYValues(s, zoLo, zoHi) : []
          );
          const mergedYDomain = [...allYFromTransforms, ...supplementY];
          const allYValues =
            mergedYDomain.length > 0
              ? mergedYDomain
              : chart.series.flatMap((series) =>
                  series.data
                    .map((d) => d.y)
                    .filter((v) => v != null && Number.isFinite(Number(v)))
                    .map((v) => Number(v))
                );
          yDomain = safeNumericYDomain(allYValues);
          if (visibleData.length > 0 && yDomain[1] > yDomain[0]) {
            const yPadding = (yDomain[1] - yDomain[0]) * 0.2;
            yDomain = [yDomain[0], yDomain[1] + yPadding];
          }
        }

        const yScale = d3.scaleLinear().domain(yDomain).range([height, 0]);

        const yScaleTranslated = (value: number) => yScale(value) + yOffset;
        const areaBaseY = yScaleTranslated(0);

        group.selectAll(".y-axis").remove();
        group.selectAll(".x-axis").remove();
        group.selectAll("[class^='legend-']").remove(); // Remove legend text to ensure it updates
        group.selectAll(".chart-channel-label, .chart-line-type-label").remove();

        chart.series.forEach((series, seriesIndex) => {
          const xDomain = currentXZoom.domain();
          const domainStart = xDomain[0] instanceof Date ? xDomain[0].getTime() : new Date(xDomain[0]).getTime();
          const domainEnd = xDomain[1] instanceof Date ? xDomain[1].getTime() : new Date(xDomain[1]).getTime();

          const lineType = normalizeLineType(series.lineType);
          const rawSegs =
            !props.showLegendTable && lineType === "standard" && !hasMultipleCutRanges
              ? exploreStandardPolylineRawSegments(series.data, zoLo, zoHi)
              : splitSeriesIntoVisibleSegments(
                  series.data,
                  zoLo,
                  zoHi,
                  timeTh,
                  hasMultipleCutRanges ? getCutRangeIndex : undefined
                );

          const transformedSegsRedraw = applyLineTypeToSegmentsWithOptionalCarry(rawSegs, lineType);
          const segmentsForDraw =
            lineType === "standard"
              ? extendStandardSegmentsToVisibleDomain(transformedSegsRedraw, zoLo, zoHi)
              : transformedSegsRedraw;

          const flatDisplay: number[] = [];
          for (const tpts of transformedSegsRedraw) {
            for (const p of tpts) {
              if (isFiniteDisplayY(p)) {
                flatDisplay.push(p.displayY);
              }
            }
          }

          let min: number | undefined;
          let max: number | undefined;
          let avg: number | undefined;
          let std: number | undefined;

          if (flatDisplay.length > 0) {
            min = d3.min(flatDisplay);
            max = d3.max(flatDisplay);
            avg = d3.mean(flatDisplay);
            std =
              avg !== undefined && avg !== null && !isNaN(avg) && flatDisplay.length > 0
                ? Math.sqrt(d3.mean(flatDisplay, (y) => Math.pow(y - avg!, 2)) ?? 0)
                : undefined;
          } else {
            const visibleRawRedraw = series.data.filter(
              (d) =>
                d.x >= zoLo &&
                d.x <= zoHi &&
                d.y !== null &&
                d.y !== undefined &&
                !isNaN(Number(d.y)) &&
                isFinite(Number(d.y))
            );
            const statSourceRedraw =
              visibleRawRedraw.length > 0
                ? visibleRawRedraw
                : series.data.filter(
                  (d) => d.y !== null && d.y !== undefined && !isNaN(d.y) && isFinite(d.y)
                );
            if (statSourceRedraw.length > 0) {
              debug(
                `[TimeSeries] No valid visible display points for ${series.yaxis.name}, using ${visibleRawRedraw.length > 0 ? "visible-window" : "global"} raw data (${statSourceRedraw.length} points) for statistics`
              );
              min = d3.min(statSourceRedraw, (d) => Number(d.y));
              max = d3.max(statSourceRedraw, (d) => Number(d.y));
              avg = d3.mean(statSourceRedraw, (d) => Number(d.y));
              std =
                avg !== undefined && avg !== null && !isNaN(avg) && statSourceRedraw.length > 0
                  ? Math.sqrt(d3.mean(statSourceRedraw, (d) => Math.pow(Number(d.y) - avg, 2)) ?? 0)
                  : undefined;
            } else {
              debug(`[TimeSeries] No valid data found for ${series.yaxis.name}`, {
                totalDataPoints: series.data.length,
                segmentCount: rawSegs.length,
                sampleData: series.data.slice(0, 3).map((d) => ({ x: d.x, y: d.y, yType: typeof d.y })),
              });
            }
          }

          if (min === undefined || max === undefined || avg === undefined || std === undefined) {
            debug(`[TimeSeries] Statistics calculation for ${series.yaxis.name}`, {
              min,
              max,
              avg,
              std,
              flatDisplayCount: flatDisplay.length,
              totalDataCount: series.data.length,
              domainStart: new Date(domainStart).toISOString(),
              domainEnd: new Date(domainEnd).toISOString(),
              hasValidYValues: series.data.some(
                (d) => d.y !== null && d.y !== undefined && !isNaN(d.y) && isFinite(d.y)
              ),
            });
          }

          const color = series.color;
          const strokeWidth = series.strokeWidth ?? 1;
          const strokeDasharray = getStrokeDasharray(series.strokeStyle);
          const useFilledArea = series.strokeStyle === "filled-area";

          if (!stackedDrawing) {
            segmentsForDraw.forEach((tseg) => {
              if (tseg.length === 0) {
                return;
              }

              const lineGenerator = d3
                .line<TransformedPoint>()
                .x((d) => currentXZoom(d.x) + xOffset)
                .y((d) => yScaleTranslated(d.displayY))
                .defined((d) => isFiniteDisplayY(d));

              const finitePts = tseg.filter(isFiniteDisplayY);
              if (finitePts.length === 0) {
                return;
              }

              if (useFilledArea && finitePts.length >= 2) {
                const areaGen = d3
                  .area<TransformedPoint>()
                  .x((d) => currentXZoom(d.x) + xOffset)
                  .y0(areaBaseY)
                  .y1((d) => yScaleTranslated(d.displayY))
                  .defined((d) => isFiniteDisplayY(d));
                group
                  .append("path")
                  .datum(tseg)
                  .attr("class", `area-${chart.chart}-${seriesIndex}`)
                  .attr("fill", fillColorHalfOpacity(color || "#888"))
                  .attr("stroke", "none")
                  .attr("clip-path", "url(#clip)")
                  .attr("pointer-events", "none")
                  .attr("d", areaGen);
              }

              let pathD: string;
              let lineCap: "round" | "butt" = "butt";
              if (finitePts.length === 1) {
                const p0 = finitePts[0];
                const cx = currentXZoom(p0.x) + xOffset;
                const cy = yScaleTranslated(p0.displayY);
                pathD = `M${cx},${cy}L${cx},${cy}`;
                lineCap = "round";
              } else {
                pathD = lineGenerator(tseg) ?? "";
              }

              const path = group
                .append("path")
                .datum(tseg)
                .attr("class", `line-${chart.chart}-${seriesIndex}`)
                .attr("fill", "none")
                .attr("stroke", color)
                .attr("stroke-width", strokeWidth)
                .attr("stroke-linecap", lineCap)
                .attr("clip-path", "url(#clip)")
                .attr("user-select", "none")
                .attr("pointer-events", "none")
                .attr("d", pathD);

              if (strokeDasharray !== null) {
                path.attr("stroke-dasharray", strokeDasharray);
              }
            });
          }

          // LEGEND: per-series legend only when not using side table (Fleet)
          if (!props.showLegendTable) {
            const maxLabelLength = Math.max(
              ...chart.series.map(series => seriesDisplayName(series).length)
            );
            const paddedLength = maxLabelLength + 3;
            // Stacked: first series is bottom layer, last is top — match legend top-to-bottom to stack top-to-bottom
            const legendSlot = stackedDrawing ? chart.series.length - 1 - seriesIndex : seriesIndex;
            group
              .append("text")
              .attr("class", `legend-${seriesIndex}`)
              .attr("x", 20)
              .attr("y", yOffset + 15 + legendSlot * 20)
              .attr("fill", color)
              .attr("font-size", "13px")
              .attr("user-select", "none")
              .attr("pointer-events", "none")
              .text(() => {
                const displayName = seriesDisplayName(series);
                let paddedName = displayName;
                if (displayName.length + 3 != paddedLength) {
                  paddedName = displayName.padEnd(paddedLength, "\u00A0");
                }
                const formatStat = (val: number | undefined | null) => {
                  if (val === undefined || val === null || isNaN(val) || !isFinite(val)) return 'N/A';
                  return Round(val, 2);
                };
                let selectedValueText = '';
                const currentSelectedTime = selectedTime();
                if (currentSelectedTime && series.data.length > 0) {
                  const selDisp = getTransformedValueAtClosestTime(
                    series,
                    currentSelectedTime.getTime(),
                    zoLo,
                    zoHi,
                    timeTh,
                    hasMultipleCutRanges ? getCutRangeIndex : undefined,
                    CLOSEST_SAMPLE_UI_MARKER_MAX_MS
                  );
                  if (selDisp !== undefined) {
                    selectedValueText = ` [Sel: ${formatStat(selDisp)}]`;
                  }
                }
                return `${paddedName}${selectedValueText} [Min: ${formatStat(min)}] [Max: ${formatStat(max)}] [Avg: ${formatStat(avg)}] [Std: ${formatStat(std)}]${dataResampleLegendBracket(series.dataResample)} [Type: ${lineTypeDisplayLabel(series.lineType)}]`;
              });
          }
        });

        if (stackedDrawing && stackedPlan) {
          const { gridTimes, stacked } = stackedPlan;
          stacked.forEach((layer, seriesIndex) => {
            const series = chart.series[seriesIndex];
            const color = series.color || "#888";
            const strokeWidth = series.strokeWidth ?? 1;
            const strokeDasharray = getStrokeDasharray(series.strokeStyle);
            const pts: Array<{ x: Date; y0: number; y1: number }> = gridTimes.map((t, j) => ({
              x: new Date(t),
              y0: layer[j][0],
              y1: layer[j][1],
            }));
            const areaGen = d3
              .area<{ x: Date; y0: number; y1: number }>()
              .x((d) => currentXZoom(d.x) + xOffset)
              .y0((d) => yScaleTranslated(d.y0))
              .y1((d) => yScaleTranslated(d.y1))
              .defined((d) => Number.isFinite(d.y0) && Number.isFinite(d.y1));
            if (pts.length >= 2) {
              group
                .append("path")
                .datum(pts)
                .attr("class", `area-stack-${chart.chart}-${seriesIndex}`)
                .attr("fill", fillColorHalfOpacity(color))
                .attr("stroke", "none")
                .attr("clip-path", "url(#clip)")
                .attr("pointer-events", "none")
                .attr("d", areaGen);
            }
            const lineGen = d3
              .line<{ x: Date; y0: number; y1: number }>()
              .x((d) => currentXZoom(d.x) + xOffset)
              .y((d) => yScaleTranslated(d.y1))
              .defined((d) => Number.isFinite(d.y1));
            const finiteY1 = pts.filter((d) => Number.isFinite(d.y1));
            if (finiteY1.length === 0) return;
            let pathD: string;
            let lineCap: "round" | "butt" = "butt";
            if (finiteY1.length === 1) {
              const p0 = finiteY1[0];
              const cx = currentXZoom(p0.x) + xOffset;
              const cy = yScaleTranslated(p0.y1);
              pathD = `M${cx},${cy}L${cx},${cy}`;
              lineCap = "round";
            } else {
              pathD = lineGen(pts) ?? "";
            }
            const path = group
              .append("path")
              .datum(pts)
              .attr("class", `line-${chart.chart}-${seriesIndex}`)
              .attr("fill", "none")
              .attr("stroke", color)
              .attr("stroke-width", strokeWidth)
              .attr("stroke-linecap", lineCap)
              .attr("clip-path", "url(#clip)")
              .attr("user-select", "none")
              .attr("pointer-events", "none")
              .attr("d", pathD);
            if (strokeDasharray !== null) {
              path.attr("stroke-dasharray", strokeDasharray);
            }
          });
        }

        // Fleet mode: white channel name + small line-type summary in upper left of each chart
        if (props.showLegendTable && chart.series.length > 0) {
          const firstName = seriesDisplayName(chart.series[0]);
          const channelName = firstName.includes(' - ') ? firstName.split(' - ')[0].trim() : firstName;
          group
            .append("text")
            .attr("class", "chart-channel-label")
            .attr("x", 20)
            .attr("y", yOffset + 14)
            .attr("fill", "white")
            .attr("font-size", "13px")
            .attr("user-select", "none")
            .attr("pointer-events", "none")
            .text(channelName);
          group
            .append("text")
            .attr("class", "chart-line-type-label")
            .attr("x", 20)
            .attr("y", yOffset + 28)
            .attr("user-select", "none")
            .attr("pointer-events", "none")
            .text(fleetChartLineTypeSummary(chart.series));
        }

        // Add the same offset to the chart axes
        group
          .append("g")
          .attr("class", "y-axis")
          .attr("transform", `translate(${xOffset}, ${yOffset})`)
          .call(
            d3
              .axisLeft()
              .scale(yScale)
              .ticks(5)
          );

        group
          .append("g")
          .attr("class", "x-axis")
          .attr("transform", `translate(${xOffset}, ${yOffset + height})`)
          .call(
            d3
              .axisBottom(currentXZoom)
              .ticks(10)
              .tickFormat((d) =>
                formatTime(new Date(d), datasetTimezone()) || new Date(d).toLocaleTimeString("en-US", { hour12: false })
              )
          );
      });

      // Update the selected time line after redrawing
      updateSelectedTimeLine();

      // Draw event overlays after redrawing
      drawEventOverlays();

      // Reset flag after redraw is complete
      isRedrawing = false;
    };

    // Add a transparent overlay for mouse interactions with correct offset
    const mouseOverlay = svg.append("rect")
      .attr("class", "mouse-overlay")
      .attr("width", width)
      .attr("height", totalHeight - margin.bottom)
      .attr("transform", `translate(${xOffset}, 0)`) // Add offset to the overlay
      .attr("fill", "none")
      .attr("pointer-events", "all")
      .style("cursor", "pointer"); // Add cursor for clickable indication

    // Add click handler to the mouse overlay
    mouseOverlay.on("click", function (event) {
      debug('🖱️ TimeSeries: Mouse overlay click received!', {
        target: event.target,
        targetClass: event.target?.className,
        brushPointerEvents: brushGroup.attr('pointer-events'),
        clientX: event.clientX,
        clientY: event.clientY
      });

      // Get mouse coordinates relative to the SVG container
      const svgPoint = d3.pointer(event);
      const rawX = svgPoint[0] - xOffset;
      // Clamp to scale range so invert() returns a valid date (works when dev tools narrow the view)
      const range = xZoom.range();
      const rangeMin = Math.min(range[0], range[1]);
      const rangeMax = Math.max(range[0], range[1]);
      const clampedX = rangeMax > rangeMin ? Math.max(rangeMin, Math.min(rangeMax, rawX)) : rangeMin;
      const time = xZoom.invert(clampedX);
      const timeMs = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : NaN;

      if (Number.isFinite(timeMs)) {
        debug('🖱️ TimeSeries: Timeline click detected', {
          mouseX: svgPoint[0],
          xOffset,
          convertedTime: time,
          timeISO: new Date(timeMs).toISOString()
        });
        if (requestTimeControl('timeseries')) {
          setIsManualTimeChange(true);
          const selectedTimeValue = new Date(timeMs);
          debug('🖱️ TimeSeries: Setting selectedTime', selectedTimeValue.toISOString());
          setSelectedTime(selectedTimeValue, 'timeseries');
          setTimeout(() => {
            const actualTime = selectedTime();
            debug('🖱️ TimeSeries: Verification - selectedTime after setting:', {
              requested: selectedTimeValue.toISOString(),
              actual: actualTime?.toISOString(),
              match: actualTime?.getTime() === selectedTimeValue.getTime()
            });
          }, 10);
        } else {
          debug('🖱️ TimeSeries: Time control denied - another component has higher priority');
        }
      }

      // Force update of the visualization to reflect the new selected time
      debug('🖱️ TimeSeries: Calling updateSelectedTimeLine');
      updateSelectedTimeLine();

      // Prevent event from propagating further to ensure no other handlers interfere
      event.stopPropagation();
    });

    const verticalLine = svg.append("line")
      .attr("class", "vertical-line")
      .attr("visibility", "hidden")
      .attr("y1", 0)
      .attr("y2", totalHeight - margin.bottom)
      .attr("pointer-events", "none");

    // Create a permanent selected time line that will be updated
    selectedTimeLine = svg.append("line")
      .attr("class", "selected-time-line")
      .attr("y1", 0)
      .attr("y2", totalHeight - margin.bottom)
      .attr("pointer-events", "none")
      .attr("visibility", "hidden");

    // Simple brush definition - restore from working version
    const brush = d3
      .brushX()
      .extent([[xOffset, 0], [width + xOffset, totalHeight - margin.bottom]])
      .on("end", (event) => {
        debug('🖌️ TimeSeries: Brush end event triggered', {
          hasSelection: !!event.selection,
          selection: event.selection,
          isProgrammaticallyUpdatingBrush
        });

        // Ignore end caused by programmatic move(null)
        if (isProgrammaticallyUpdatingBrush) {
          debug('🖌️ TimeSeries: Brush end ignored due to programmatic update');
          // Do NOT reset isProgrammaticallyUpdatingBrush here; let the setTimeout in the caller handle it
          return;
        }

        if (event.selection) {
          const [x0, x1] = event.selection.map(x => xZoom.invert(x - xOffset));
          const t0 = x0 instanceof Date ? x0.getTime() : typeof x0 === 'number' ? x0 : NaN;
          const t1 = x1 instanceof Date ? x1.getTime() : typeof x1 === 'number' ? x1 : NaN;
          if (!Number.isFinite(t0) || !Number.isFinite(t1)) return;

          debug('🖌️ TimeSeries: Brush selection made', {
            startTime: new Date(t0).toISOString(),
            endTime: new Date(t1).toISOString(),
            duration: t1 - t0
          });

          // Selections work normally on cut data - treat selections the same whether cut data or full dataset
          // Zoom the chart to the brush selection
          xZoom.domain([x0, x1]);

          // Set the selectedRange to match the brush selection (works normally on cut data)
          const range = { "start_time": new Date(t0).toISOString(), "end_time": new Date(t1).toISOString() };
          debug('🖌️ TimeSeries: Setting selectedRange', range);
          setSelectedRange([range]);

          // Set the selectedTime to the start of the brush selection
          const selectedTimeValue = new Date(t0);
          debug('🖌️ TimeSeries: Setting selectedTime to brush start', selectedTimeValue.toISOString());
          if (requestTimeControl('timeseries')) {
            setSelectedTime(selectedTimeValue, 'timeseries');
          }

          // Redraw and update states
          debug('🖌️ TimeSeries: Calling redraw...');

          // Save scroll position before redraw to maintain user's scroll position
          const savedScrollY = window.scrollY;
          const savedScrollX = window.scrollX;
          let savedContainerScrollTop: number | null = null;
          let savedContainerScrollLeft: number | null = null;
          if (containerRef) {
            savedContainerScrollTop = containerRef.scrollTop;
            savedContainerScrollLeft = containerRef.scrollLeft;
          }

          setZoom(true);
          setHasSelection(true);

          // Set flag to skip brush restoration after this zoom
          // restoreBrushSelection() will check this flag and clear the brush instead of restoring it
          shouldSkipBrushRestoreAfterZoom = true;

          // Clear the brush immediately before redraw to prevent it from being restored
          if (brushGroup && !brushGroup.empty()) {
            isProgrammaticallyUpdatingBrush = true;
            brushGroup.call(brush.move, null);
            debug('🖌️ TimeSeries: Brush cleared immediately before redraw');
          }

          // Redraw the chart (restoreBrushSelection will be called, but will skip restoration due to flag)
          redraw();

          // Restore scroll position after redraw completes
          // Use multiple requestAnimationFrame calls to ensure DOM has fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.scrollTo(savedScrollX, savedScrollY);
              if (containerRef && savedContainerScrollTop !== null && savedContainerScrollLeft !== null) {
                containerRef.scrollTop = savedContainerScrollTop;
                containerRef.scrollLeft = savedContainerScrollLeft;
              }
            });
          });

          // Ensure brush stays cleared after redraw completes (only if this SVG/brush is still current)
          setTimeout(() => {
            const currentBrushGroup = svg.select(".brush");
            const brushEl = currentBrushGroup.node();
            const stillCurrent = brushEl && (brushEl as Element).isConnected && containerRef?.contains(brushEl as Element);
            if (!stillCurrent) {
              shouldSkipBrushRestoreAfterZoom = false;
              return; // SVG was replaced by another drawPlots - do not call brush.move (would fire stale "end")
            }
            if (!currentBrushGroup.empty()) {
              isProgrammaticallyUpdatingBrush = true;
              currentBrushGroup.call(brush.move, null);
              debug('🖌️ TimeSeries: Brush cleared after zoom to allow continued interaction');
              setTimeout(() => {
                isProgrammaticallyUpdatingBrush = false;
                shouldSkipBrushRestoreAfterZoom = false; // Reset flag after clearing
              }, 100);
            } else {
              shouldSkipBrushRestoreAfterZoom = false; // Reset flag if no brush found
            }
          }, 200); // Slightly longer delay to ensure redraw completes
        } else {
          // Brush end with no selection: single click (set selectedTime only) or stale event.
          // Never clear zoom here - zoom resets only on double-click or selection banner clear.
          const brushNode = brushGroup?.node();
          if (!brushNode || !(brushNode as Element).isConnected) {
            debug('🖌️ TimeSeries: Brush end ignored - brush no longer in DOM (stale event)');
            return;
          }
          if (lastBrushCreateTime && Date.now() - lastBrushCreateTime < 800) {
            debug('🖌️ TimeSeries: Brush end ignored - too soon after brush create (init/stale)');
            return;
          }
          const alreadyEmpty = selectedRange().length === 0;
          const se = event.sourceEvent as MouseEvent | undefined;
          // Single click: set selectedTime from click position (whether zoomed or not). Do not clear zoom.
          if (se && containerRef) {
            const svgNode = containerRef.querySelector('svg');
            if (svgNode) {
              try {
                let mouseX: number;
                const mediaContainer = (svgNode as Element).closest("#media-container");
                const scaleFactor = mediaContainer
                  ? parseFloat(getComputedStyle(mediaContainer).getPropertyValue("--scale-factor").trim() || "1") || 1
                  : 1;
                const rect = (svgNode as SVGElement).getBoundingClientRect();
                if (rect.width > 0 && scaleFactor > 0) {
                  const displayedX = se.clientX - rect.left;
                  const logicalX = displayedX / scaleFactor;
                  mouseX = logicalX - margin.left - xOffset;
                } else {
                  const pt = d3.pointer(se, svgNode);
                  mouseX = pt[0] - margin.left - xOffset;
                }
                if (!Number.isFinite(mouseX)) {
                  debug('🖌️ TimeSeries: Brush end - pointer coordinates non-finite, skipping click handling');
                  return;
                }
                const range = xZoom.range();
                const rangeMin = Math.min(range[0], range[1]);
                const rangeMax = Math.max(range[0], range[1]);
                const clampedX = rangeMax > rangeMin ? Math.max(rangeMin, Math.min(rangeMax, mouseX)) : rangeMin;
                const time = xZoom.invert(clampedX);
                const timeMs = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : NaN;
                if (Number.isFinite(timeMs) && requestTimeControl('timeseries')) {
                  setIsManualTimeChange(true);
                  setSelectedTime(new Date(timeMs), 'timeseries');
                }
                updateSelectedTimeLine();
              } catch (err) {
                debug('🖌️ TimeSeries: Brush end - pointer/click handling failed (non-finite SVGPoint or stale context)', err);
                return;
              }
            }
            debug('🖌️ TimeSeries: Brush end with no selection - updated selectedTime from click; zoom unchanged (reset via double-click or selection banner)');
            return;
          }
          if (alreadyEmpty) {
            debug('🖌️ TimeSeries: Brush end with no selection, store already empty - skipping updates');
            return;
          }
          // Have zoom but no click event (e.g. programmatic or edge case): keep zoom, do not clear
          debug('🖌️ TimeSeries: Brush end with no selection - zoom kept (reset via double-click or selection banner)');
        }
      });

    // Function to restore brush selection based on current selectedRange
    const restoreBrushSelection = () => {
      debug('🔄 TimeSeries: restoreBrushSelection called', {
        hasBrush: !!brush,
        selectedRangeLength: selectedRange().length,
        cutEventsLength: cutEvents().length,
        shouldSkipBrushRestoreAfterZoom
      });

      if (!brush) {
        debug('🔄 TimeSeries: No brush available, skipping restoration');
        return;
      }

      // Get the brush group from the DOM
      const brushGroup = svg.select(".brush");
      if (brushGroup.empty()) {
        debug('🔄 TimeSeries: No brush group found, skipping restoration');
        return;
      }

      // If we just zoomed from a brush selection, skip restoration and clear the brush
      if (shouldSkipBrushRestoreAfterZoom) {
        debug('🔄 TimeSeries: Skipping brush restoration after zoom, clearing brush');
        isProgrammaticallyUpdatingBrush = true;
        brushGroup.call(brush.move, null);
        // Don't reset the flag here - let the setTimeout in brush end handler do it
        setTimeout(() => {
          isProgrammaticallyUpdatingBrush = false;
        }, 100);
        return;
      }

      // Check if we're in cut mode
      const currentIsCut = isCut();
      const currentCutEvents = cutEvents();
      const hasActiveCuts = currentIsCut && currentCutEvents && currentCutEvents.length > 0;
      const hasSelection = selectedRange().length > 0;

      // Set flag to prevent brush end handler from firing during programmatic updates
      isProgrammaticallyUpdatingBrush = true;

      // If there's a selection, restore brush normally (even in cut mode - selections work on cut data)
      if (hasSelection) {
        const rangeItem = selectedRange()[0];
        const startTime = new Date(rangeItem.start_time);
        const endTime = new Date(rangeItem.end_time);

        debug('🔄 TimeSeries: Restoring brush from selectedRange', {
          rangeItem,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          isCut: hasActiveCuts
        });

        const x0 = xZoom(startTime) + xOffset;
        const x1 = xZoom(endTime) + xOffset;
        brushGroup.call(brush.move, [x0, x1]);
        debug('🔄 TimeSeries: Brush restored from selectedRange');
      } else if (hasActiveCuts) {
        // No selection but in cut mode - clear brush (cut data is fresh dataset with no selection)
        debug('🔄 TimeSeries: Cut mode active with no selection - clearing brush (cut data is fresh dataset)');
        brushGroup.call(brush.move, null);
        brushGroup.attr("pointer-events", "none"); // Keep brush disabled
      } else {
        // No selection and no cuts - clear brush
        debug('🔄 TimeSeries: No ranges, clearing brush');
        brushGroup.call(brush.move, null);
      }

      // Reset flag after a delay to ensure the brush event fully propagates
      setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 100);
    };

    // (refs storage moved below after brush initialization)

    // Store the restore function globally for external access
    window.restoreTimeSeriesBrushSelection = restoreBrushSelection;
    // Provide a global helper to clear the brush immediately if needed
    window.clearTimeSeriesBrush = () => {
      try {
        const brushGroup = svg.select(".brush");
        if (!brushGroup.empty()) {
          brushGroup.call(brush.move, null);
        }
      } catch (e) {
        // ignore
      }
    };

    // Safety check for containerRef
    if (!containerRef) {
      warn('TimeSeries: containerRef is null, skipping tooltip creation');
      return;
    }

    const tooltip = d3.select(containerRef)
      .append("div")
      .attr("class", "tooltip")
      .style("position", "absolute")
      .style("background", "#fff")
      .style("border", "1px solid #ccc")
      .style("padding", "5px")
      .style("border-radius", "5px")
      .style("pointer-events", "none") // Make sure tooltip doesn't capture events
      .style("visibility", "hidden");

    // Create brush group - pointer-events all so click-drag brushes and zooms
    const brushGroup = svg.append("g")
      .attr("class", "brush")
      .attr("pointer-events", "all")
      .call(brush);
    lastBrushCreateTime = Date.now();

    // Brush group created with pointer-events disabled by default

    // Function to draw event overlays (colored rectangles for selected events and cut ranges)
    const drawEventOverlays = () => {
      // Remove existing overlays and overlay group
      svg.selectAll(".event-overlay").remove();
      svg.selectAll(".cut-overlay").remove();
      svg.selectAll(".event-overlays-group").remove();
      svg.selectAll(".cut-overlays-group").remove();

      const events = selectedEvents();
      const ranges = selectedRanges();
      const currentIsCut = isCut();
      const currentCutEvents = cutEvents();

      // Create a group for event overlays (behind everything else)
      const overlayGroup = svg.insert("g", ":first-child")
        .attr("class", "event-overlays-group")
        .attr("clip-path", "url(#clip)");

      // Draw overlays for selected events (active selections)
      if (events && events.length > 0 && ranges && ranges.length > 0) {
        debug('🎨 TimeSeries: Drawing event overlays', {
          eventCount: events.length,
          rangeCount: ranges.length
        });

        // Draw an overlay for each selected event
        ranges.forEach((range) => {
          const eventId = range.event_id;
          if (!eventId || !range.start_time || !range.end_time) {
            return;
          }

          // Get color for this event
          const color = getEventColor(eventId, events);

          // Convert time strings to Date objects
          const startTime = new Date(range.start_time);
          const endTime = new Date(range.end_time);

          // Calculate x positions using xZoom scale
          const x0 = xZoom(startTime) + xOffset;
          const x1 = xZoom(endTime) + xOffset;

          // Only draw if the range is visible in the current zoom
          const domain = xZoom.domain();
          if (endTime < domain[0] || startTime > domain[1]) {
            return; // Range is outside visible domain
          }

          // Draw a semi-transparent rectangle covering the full height
          overlayGroup.append("rect")
            .attr("class", "event-overlay")
            .attr("x", Math.min(x0, x1))
            .attr("y", 0)
            .attr("width", Math.abs(x1 - x0))
            .attr("height", totalHeight - margin.bottom)
            .attr("fill", color)
            .attr("opacity", 0.2) // Semi-transparent
            .attr("pointer-events", "none") // Don't interfere with interactions
            .style("mix-blend-mode", "multiply"); // Blend nicely with chart lines
        });
      }

      // Draw overlays for cut ranges (cut data)
      // Only show overlays if there are multiple cut ranges (skip single range)
      if (currentIsCut && currentCutEvents && currentCutEvents.length > 1) {
        debug('🎨 TimeSeries: Drawing cut overlays', {
          cutRangesCount: currentCutEvents.length
        });

        // Create a separate group for cut overlays (behind event overlays)
        const cutOverlayGroup = svg.insert("g", ":first-child")
          .attr("class", "cut-overlays-group")
          .attr("clip-path", "url(#clip)");

        // Draw an overlay for each cut range
        currentCutEvents.forEach((range, index) => {
          // Skip if it's an event ID instead of a time range
          if (typeof range === 'number') return;

          if (!range.start_time || !range.end_time) {
            return;
          }

          // Convert time strings to Date objects
          const startTime = new Date(range.start_time);
          const endTime = new Date(range.end_time);

          // Calculate x positions using xZoom scale
          const x0 = xZoom(startTime) + xOffset;
          const x1 = xZoom(endTime) + xOffset;

          // Only draw if the range is visible in the current zoom
          const domain = xZoom.domain();
          if (endTime < domain[0] || startTime > domain[1]) {
            return; // Range is outside visible domain
          }

          // Use colorscale.ts to get consistent colors for multiple ranges
          const cutColor = getColorByIndex(index);

          // Draw a semi-transparent rectangle covering the full height
          cutOverlayGroup.append("rect")
            .attr("class", "cut-overlay")
            .attr("x", Math.min(x0, x1))
            .attr("y", 0)
            .attr("width", Math.abs(x1 - x0))
            .attr("height", totalHeight - margin.bottom)
            .attr("fill", cutColor)
            .attr("opacity", 0.2) // Use opacity 0.2 as requested
            .attr("pointer-events", "none") // Don't interfere with interactions
            .style("mix-blend-mode", "multiply"); // Blend nicely with chart lines
        });

        debug('🎨 TimeSeries: Cut overlays drawn', {
          overlayCount: cutOverlayGroup.selectAll(".cut-overlay").size()
        });
      } else if (currentIsCut && currentCutEvents && currentCutEvents.length === 1) {
        // Single cut range - skip drawing overlay
        debug('🎨 TimeSeries: Skipping cut overlay for single range');
      }

      debug('🎨 TimeSeries: All overlays drawn', {
        eventOverlayCount: overlayGroup.selectAll(".event-overlay").size(),
        cutOverlayCount: svg.selectAll(".cut-overlay").size()
      });
    };

    // Add a spacer div at the end to ensure last chart is fully visible when scrolling
    // This matches the approach used in maneuver timeseries (chartHeight * 1.5)
    // This is especially important when content is scaled with CSS transform
    // Remove any existing spacer first to avoid duplicates
    const chartHeight = getChartHeight();
    d3.select(containerRef).select(".timeseries-scroll-spacer").remove();
    d3.select(containerRef)
      .append("div")
      .attr("class", "timeseries-scroll-spacer")
      .style("height", `${chartHeight * 1.5}px`)
      .style("width", "100%")
      .style("flex-shrink", "0");

    // Store references for access in the reactive effects (after brush is initialized)
    d3.select(containerRef).property("__timeSeriesRefs", {
      verticalLine,
      selectedTimeLine,
      xZoom,
      xScale,  // Store xScale reference for domain access
      xOffset,
      totalHeight,
      svg,
      updateSelectedTimeLine, // Store reference to the function
      margin,
      redraw,  // Add redraw function to the references
      brush,   // Store brush reference for selection restoration
      restoreBrushSelection,  // Store function to restore brush selection
      xScaleDomain: xScale.domain(), // Store full domain for reset
      fullDataExtent, // Full extent of chart data (for wheel pan when xScale is zoomed range)
      drawEventOverlays // Store function to draw event overlays
    });

    // When playing with a time window, apply display window immediately after building chart
    // so we never show full timeline (chart build is async; time-window effect may run before refs exist).
    // Playhead is PLAYBACK_WINDOW_LEAD_MS from the right edge when playing.
    const twAfterRefs = (typeof timeWindow === 'function') ? timeWindow() : 0;
    if (twAfterRefs > 0 && isPlaying()) {
      const center = getDisplayWindowReferenceTime();
      if (center instanceof Date && !isNaN(center.getTime())) {
        const windowEnd = center.getTime() + PLAYBACK_WINDOW_LEAD_MS;
        const windowStart = windowEnd - (twAfterRefs * 60 * 1000);
        xZoom.domain([windowStart, windowEnd]);
        setZoom(true);
        redraw();
      }
    }

    setRefsReady(true);

    // On first load, selectedTime may already be set (e.g. from store or another page). The playback
    // effect may have run before refs existed and skipped. Ensure circles/labels are drawn now.
    const currentTime = selectedTime();
    if (currentTime && currentTime >= new Date('1971-01-01T12:00:00Z')) {
      updateSelectedTimeLine();
    }

    // Allow brush "end" to affect selection again after draw/brush setup is complete
    setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 150);

    // Add direct click handler to main SVG (simpler than adding layers)
    svg.on("click", function (event) {
      debug('🖱️ TimeSeries: Click event received!', {
        target: event.target,
        targetClass: event.target?.className,
        isBrushTarget: event.target && event.target.closest('.brush'),
        brushPointerEvents: brushGroup.attr('pointer-events'),
        eventType: event.type,
        clientX: event.clientX,
        clientY: event.clientY
      });

      debug('🖱️ TimeSeries: Click event received', {
        target: event.target,
        targetClass: event.target?.className,
        isBrushTarget: event.target && event.target.closest('.brush'),
        eventType: event.type
      });

      // Skip if we're clicking on the brush (but only if brush is active)
      // For now, let's disable this check since brush should be disabled by default
      if (false && event.target && event.target.closest('.brush') && brushGroup.attr('pointer-events') === 'all') {
        debug('🖱️ TimeSeries: Click ignored - clicked on active brush');
        debug('🖱️ TimeSeries: Click ignored - clicked on active brush');
        return;
      }

      // Get mouse coordinates relative to the SVG container
      const svgPoint = d3.pointer(event);
      const rawX = svgPoint[0] - xOffset;
      // Clamp to scale range so invert() returns a valid date (works when dev tools narrow the view)
      const range = xZoom.range();
      const rangeMin = Math.min(range[0], range[1]);
      const rangeMax = Math.max(range[0], range[1]);
      const clampedX = rangeMax > rangeMin ? Math.max(rangeMin, Math.min(rangeMax, rawX)) : rangeMin;
      const time = xZoom.invert(clampedX);
      const timeMs = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : NaN;

      if (Number.isFinite(timeMs)) {
        debug('🖱️ TimeSeries: SVG Timeline click detected', {
          mouseX: svgPoint[0],
          xOffset,
          convertedTime: time,
          timeISO: new Date(timeMs).toISOString()
        });
        if (requestTimeControl('timeseries')) {
          setIsManualTimeChange(true);
          const selectedTimeValue = new Date(timeMs);
          debug('🖱️ TimeSeries: Setting selectedTime', selectedTimeValue.toISOString());
          setSelectedTime(selectedTimeValue, 'timeseries');
          setTimeout(() => {
            const actualTime = selectedTime();
            debug('🖱️ TimeSeries: SVG Click Verification - selectedTime after setting:', {
              requested: selectedTimeValue.toISOString(),
              actual: actualTime?.toISOString(),
              match: actualTime?.getTime() === selectedTimeValue.getTime()
            });
          }, 10);
        } else {
          debug('🖱️ TimeSeries: Time control denied - another component has higher priority');
        }
      }

      // Force update of the visualization to reflect the new selected time
      debug('🖱️ TimeSeries: Calling updateSelectedTimeLine');
      updateSelectedTimeLine();

      // Prevent event from propagating further to ensure no other handlers interfere
      event.stopPropagation();
    });

    // Brush is now enabled by default - no key activation needed

    // Add hover effects (mousemove), but without the red indicators
    svg.on("mousemove", function (event) {
      // Skip hover effects during playback
      if (isPlaying()) return;

      // Regular hover behavior when not playing
      const mouseX = d3.pointer(event)[0];
      const xValue = xZoom.invert(mouseX - xOffset);
      const xValueDate = new Date(xValue); // Convert timestamp to Date object

      verticalLine.attr("x1", mouseX).attr("x2", mouseX).attr("visibility", "visible");

      // Format tooltip content from the data
      const timezone = datasetTimezone();
      const timeString = formatTime(xValueDate, timezone) || xValueDate.toLocaleTimeString();
      let tooltipContent = `Time: ${timeString}`;

      const htLo = xZoom.domain()[0];
      const htHi = xZoom.domain()[1];
      const htTimeTh = segmentGapForLayout;
      const htIsCut = isCut();
      const htCutEvents = cutEvents();
      const htHasMultipleCutRanges = htIsCut && htCutEvents && htCutEvents.length > 1;
      const getCutRangeIndexHt = (point: { x: Date; y: number }) => {
        if (!htHasMultipleCutRanges) return -1;
        const pointTime = point.x instanceof Date ? point.x.getTime() : new Date(point.x).getTime();
        for (let ci = 0; ci < htCutEvents.length; ci++) {
          const range = htCutEvents[ci];
          if (typeof range === "number") continue;
          if (range.start_time && range.end_time) {
            const startTime = new Date(range.start_time).getTime();
            const endTime = new Date(range.end_time).getTime();
            if (pointTime >= startTime && pointTime <= endTime) {
              return ci;
            }
          }
        }
        return -1;
      };

      chartsData.forEach((chart) => {
        chart.series.forEach((series) => {
          if (series.data.length === 0) return;

          const tipY = getTransformedValueAtClosestTime(
            series,
            xValueDate.getTime(),
            htLo,
            htHi,
            htTimeTh,
            htHasMultipleCutRanges ? getCutRangeIndexHt : undefined,
            CLOSEST_SAMPLE_TOOLTIP_MAX_MS
          );
          if (tipY !== undefined) {
            tooltipContent += `<br>${seriesDisplayName(series)}: ${Round(tipY, 2)}`;
          }
        });
      });

      tooltip.style("top", `${event.clientY}px`)
        .style("left", `${event.clientX}px`)
        .style("visibility", "visible")
        .html(tooltipContent);
    });

    // Also update mouseout to respect playing state
    svg.on("mouseout", function () {
      if (!isPlaying()) {
        // Only hide the line when not playing
        verticalLine.attr("visibility", "hidden");
      }

      tooltip.style("visibility", "hidden");
      svg.selectAll(".temp-hover-indicator").remove();
    });

    // Restore the wheel event functionality for horizontal scrolling when zoomed
    // Use native addEventListener with explicit passive: false to suppress browser warnings
    // Attach to containerRef with capture: true to catch all wheel events, including those on child elements
    // Access xZoom and xScale from refs to ensure we always use the current scales (not stale closures)
    // Fallback to local xZoom/xScale if refs aren't available yet
    wheelHandler = (event: WheelEvent) => {
      // Only handle wheel when the target is inside the chart
      if (!containerRef || !containerRef.contains(event.target as Node)) {
        return;
      }
      // Try to get scales from refs first (most up-to-date), fallback to local variables
      let currentXZoom: d3.ScaleTime<number, number> | null = null;
      let currentXScale: d3.ScaleTime<number, number> | null = null;
      let currentRedraw: (() => void) | null = null;

      if (containerRef) {
        const refs = d3.select(containerRef).property("__timeSeriesRefs");
        if (refs && refs.xZoom && refs.xScale) {
          currentXZoom = refs.xZoom;
          currentXScale = refs.xScale;
          currentRedraw = refs.redraw || null;
        }
      }

      // Fallback to local xZoom/xScale if refs aren't available
      if (!currentXZoom || !currentXScale) {
        currentXZoom = xZoom;
        currentXScale = xScale;
        currentRedraw = redraw;
      }

      if (!currentXZoom || !currentXScale) {
        debug('🖱️ TimeSeries: Wheel handler - no scales available');
        return;
      }

      const zoomDomain = currentXZoom.domain();
      const scaleDomain = currentXScale.domain();

      if (zoomDomain.length !== 2 || scaleDomain.length !== 2) {
        return;
      }

      // Use full data extent from refs when available (FleetTimeSeries passes zoomed range as datasetEventTimeRange so xScale === xZoom)
      let dataMin: Date;
      let dataMax: Date;
      const refsForExtent = containerRef ? d3.select(containerRef).property("__timeSeriesRefs") : null;
      const fullExtent = refsForExtent?.fullDataExtent as [Date, Date] | null | undefined;
      if (fullExtent && fullExtent.length === 2 && fullExtent[0] && fullExtent[1]) {
        dataMin = fullExtent[0];
        dataMax = fullExtent[1];
      } else {
        dataMin = scaleDomain[0];
        dataMax = scaleDomain[1];
      }

      // Zoomed = visible window is narrower than or shifted from full data extent (so we can pan)
      const zoomSpan = zoomDomain[1].getTime() - zoomDomain[0].getTime();
      const dataSpan = dataMax.getTime() - dataMin.getTime();
      const isActuallyZoomed = dataSpan > 0 && (
        zoomSpan < dataSpan - 1000 ||
        Math.abs(zoomDomain[0].getTime() - dataMin.getTime()) > 1000 ||
        Math.abs(zoomDomain[1].getTime() - dataMax.getTime()) > 1000
      );

      if (isActuallyZoomed) {
        // Consume wheel only when zoomed so we can pan; when not zoomed let the event through for vertical scroll
        event.preventDefault();
        event.stopPropagation();
        debug('🖱️ TimeSeries: Wheel event on zoomed chart (horizontal scroll/pan)', {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          isZoomed: isZoomed(),
          isActuallyZoomed,
          zoomDomain: zoomDomain.map(d => d.toISOString()),
          dataExtent: [dataMin, dataMax].map(d => d.toISOString())
        });

        const [minX, maxX] = zoomDomain;
        const extent = maxX.getTime() - minX.getTime();
        const panAmount = extent * 0.1; // Adjust sensitivity

        // Horizontal pan: use deltaX (trackpad horizontal swipe) when present, else deltaY (vertical wheel)
        // Positive delta = scroll right = pan view right (later time); negative = pan left (earlier time)
        const deltaX = typeof event.deltaX === 'number' ? event.deltaX : 0;
        const deltaY = typeof event.deltaY === 'number' ? event.deltaY : 0;
        const hasHorizontal = Math.abs(deltaX) > 0;
        const delta = hasHorizontal ? deltaX : deltaY;
        const direction = Math.sign(delta); // -1 = pan left (earlier), +1 = pan right (later)

        // Calculate new domain
        let x0 = new Date(minX.getTime() + direction * panAmount);
        let x1 = new Date(maxX.getTime() + direction * panAmount);

        // Check if pan would go outside data bounds - if so, just stop (no zooming)
        if (x0 < dataMin || x1 > dataMax) {
          debug('🖱️ TimeSeries: Wheel pan hit boundary - stopping pan (no zoom)', {
            currentDomain: [minX, maxX].map(d => d.toISOString()),
            dataExtent: [dataMin, dataMax].map(d => d.toISOString()),
            attemptedPan: [x0, x1].map(d => d.toISOString()),
            hitLeftBoundary: x0 < dataMin,
            hitRightBoundary: x1 > dataMax
          });
          return; // Don't update zoom domain, just stop scrolling
        }

        debug('🖱️ TimeSeries: Wheel pan calculation', {
          currentDomain: [minX, maxX].map(d => d.toISOString()),
          dataExtent: [dataMin, dataMax].map(d => d.toISOString()),
          extent,
          panAmount,
          direction,
          newDomain: [x0, x1].map(d => d.toISOString())
        });

        // Check if we have an active selection
        const currentSelectedRange = selectedRange();
        const hasSelection = currentSelectedRange && currentSelectedRange.length > 0;

        // Update the x domain for scrolling (within data limits)
        currentXZoom.domain([x0, x1]);

        // Update selectedRange if we have an active selection (works normally on cut data too)
        // If no selection, just pan without creating one (whether in cut mode or not)
        if (hasSelection) {
          // Update selectedRange to match the new zoom domain (selections work normally on cut data)
          const range = { "type": "range", "start_time": x0.toISOString(), "end_time": x1.toISOString() };
          debug('🖱️ TimeSeries: Setting selectedRange from wheel pan', range);
          setSelectedRange([range]);

          // Check if selectedTime is outside the brush range and snap to start time if needed
          const currentSelectedTime = selectedTime();
          const brushStartTime = x0;
          const brushEndTime = x1;

          if (currentSelectedTime && (currentSelectedTime < brushStartTime || currentSelectedTime > brushEndTime)) {
            debug('🖱️ TimeSeries: selectedTime is outside brush range, snapping to start time', {
              currentSelectedTime: currentSelectedTime.toISOString(),
              brushStartTime: brushStartTime.toISOString(),
              brushEndTime: brushEndTime.toISOString(),
              isOutsideRange: currentSelectedTime < brushStartTime || currentSelectedTime > brushEndTime
            });

            // Request control and update selectedTime to brush start time
            if (requestTimeControl('timeseries')) {
              setIsManualTimeChange(true);
              setSelectedTime(brushStartTime, 'timeseries');
              debug('🖱️ TimeSeries: selectedTime snapped to brush start time', brushStartTime.toISOString());
            } else {
              debug('🖱️ TimeSeries: Time control denied - cannot snap selectedTime');
            }
          }
        } else {
          debug('🖱️ TimeSeries: No active selection - panning without creating selection');
        }

        // Redraw with rescaled y-axis based on visible data
        debug('🖱️ TimeSeries: Calling redraw after wheel pan');
        if (currentRedraw) {
          currentRedraw();
        }
      } else {
        debug('🖱️ TimeSeries: Wheel event ignored - not zoomed', {
          isZoomed: isZoomed(),
          isActuallyZoomed,
          zoomDomain: zoomDomain.map(d => d.toISOString()),
          scaleDomain: scaleDomain.map(d => d.toISOString()),
          timeDiff: [Math.abs(zoomDomain[0].getTime() - scaleDomain[0].getTime()), Math.abs(zoomDomain[1].getTime() - scaleDomain[1].getTime())]
        });
      }
    };

    // Always attach wheel handler to containerRef with capture: true to catch all wheel events
    // This ensures we capture events even if they occur on child elements like brush overlays
    if (containerRef) {
      containerRef.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
      debug('🖱️ TimeSeries: Wheel handler attached to containerRef');
    } else {
      warn('🖱️ TimeSeries: Cannot attach wheel handler - containerRef is null');
    }

    // Double-click handler - clear selection and reset zoom
    svg.on("dblclick", () => {
      debug('🖱️ TimeSeries: Double-click detected - clearing selection and resetting zoom');

      // Reset manual change flag to allow clearing effect to work
      setIsManualTimeChange(false);

      // Check if we're in cut mode - if so, only clear active selection (keep cut data)
      const currentIsCut = isCut();
      const currentCutEvents = cutEvents();
      const hasActiveCuts = currentIsCut && currentCutEvents && currentCutEvents.length > 0;

      if (hasActiveCuts) {
        // In cut mode: clear selection but keep cut data
        debug('🖱️ TimeSeries: Double-click in cut mode - clearing selection, keeping cut data');
        clearActiveSelection();
      } else {
        // Not in cut mode: clear everything
        debug('🖱️ TimeSeries: Double-click - clearing all selections');
        clearSelection();
      }

      // Reset zoom to full domain (will be cut data extent if in cut mode, full dataset otherwise)
      const fullDomain = xScale.domain();
      debug('🖱️ TimeSeries: Resetting zoom domain', {
        from: xZoom.domain(),
        to: fullDomain,
        isCut: hasActiveCuts
      });

      xZoom.domain(fullDomain);

      debug('🖱️ TimeSeries: Calling redraw after double-click');
      redraw();

      debug('🖱️ TimeSeries: Double-click reset completed');
    });

    redraw();

    // Draw event overlays on initial render
    drawEventOverlays();

    // Clear brush selection on initialization (don't restore from selectedRange)
    // Use setTimeout to ensure the brush is fully rendered before attempting to clear
    setTimeout(() => {
      const brushGroup = svg.select(".brush");
      if (!brushGroup.empty() && brush) {
        brushGroup.call(brush.move, null);
      }
    }, 0);

    // Ensure selectedTime is properly initialized after chart is drawn
    setTimeout(() => {
      if (!selectedTime() || selectedTime() < new Date('1971-01-01T12:00:00Z')) {
        const refs = d3.select(containerRef).property("__timeSeriesRefs");
        if (refs && refs.xScale) {
          const domain = refs.xScale.domain();

          // Check if domain is valid before proceeding
          if (domain && domain.length === 2 && !isNaN(domain[0]) && !isNaN(domain[1]) && domain[0] !== domain[1]) {
            const initialTime = domain[0];

            debug('⏰ TimeSeries: Delayed selectedTime initialization', {
              domain: domain.map(d => safeToISOString(d)),
              initialTime: safeToISOString(initialTime),
              currentSelectedTime: selectedTime()?.toISOString()
            });

            if (requestTimeControl('timeseries')) {
              debug('⏰ TimeSeries: Delayed time control granted, setting selectedTime');
              setSelectedTime(new Date(initialTime), 'timeseries');
              if (refs.updateSelectedTimeLine) {
                refs.updateSelectedTimeLine();
              }
            } else {
              debug('⏰ TimeSeries: Delayed time control denied, cannot set selectedTime');
            }
          } else {
            debug('⏰ TimeSeries: Delayed initialization skipped - invalid domain', domain);
          }
        }
      }
    }, 100); // Small delay to ensure chart is fully rendered

    // Initialize selectedTime if it's not set or is 0
    if (!selectedTime() || selectedTime() < new Date('1971-01-01T12:00:00Z')) {
      const domain = xScale.domain();

      // Check if domain is valid before proceeding
      if (!domain || domain.length !== 2 || isNaN(domain[0]) || isNaN(domain[1]) || domain[0] === domain[1]) {
        debug('⏰ TimeSeries: Invalid domain for selectedTime initialization, skipping');
        return;
      }

      // Use the first data point (minimum time) instead of the middle
      const initialTime = domain[0];

      debug('⏰ TimeSeries: Initializing selectedTime', {
        domain: domain.map(d => safeToISOString(d)),
        initialTime: safeToISOString(initialTime),
        currentSelectedTime: selectedTime()?.toISOString()
      });

      if (requestTimeControl('timeseries')) {
        debug('⏰ TimeSeries: Time control granted, setting selectedTime');
        setSelectedTime(new Date(initialTime), 'timeseries');
        updateSelectedTimeLine();
      } else {
        debug('⏰ TimeSeries: Time control denied, cannot set selectedTime');
      }
    }
  };

  // Watch for chart changes and process data — only when props.chart changes, not when selection/cut updates
  // Using on() prevents cross-window selection updates from retriggering this effect and causing an endless loop
  createEffect(
    on(
      () => props.chart,
      (chart) => {
        // Refs are not ready until drawPlots() has run and set __timeSeriesRefs
        setRefsReady(false);
        // Wrap async operation to catch all promise rejections
        (async () => {
          try {
            const burstNow = Date.now();
            chartChangesEffectTimestamps = chartChangesEffectTimestamps.filter(
              (t) => burstNow - t < CHART_EFFECT_BURST_MS
            );
            chartChangesEffectTimestamps.push(burstNow);
            if (chartChangesEffectTimestamps.length > CHART_EFFECT_BURST_MAX) {
              logError(
                '🚨 Chart changes effect burst: too many runs in',
                CHART_EFFECT_BURST_MS,
                'ms (possible loop). Count:',
                chartChangesEffectTimestamps.length
              );
              logError('🚨 Chart data:', chart);
              logError('🚨 Processing flags:', { isProcessingData, isFetchingData });
              logError('🚨 Stack trace:', new Error().stack);
              chartChangesEffectTimestamps = [];
              return;
            }

            // Prevent effect from running if already processing
            if (isProcessingData || isFetchingData) {
              return;
            }

            // Debounce rapid successive calls
            const now = Date.now();
            if (now - lastChartEffectTime < 100) {
              return;
            }
            lastChartEffectTime = now;

            // Clear any existing timeout
            if (chartEffectTimeout) {
              clearTimeout(chartEffectTimeout);
            }

            if (chart) {
              // Check if chart already has data (from parent component)
              const hasData = chart.some((c: { series?: Array<{ data?: unknown[] }> }) =>
                c.series && c.series.some((series: { data?: unknown[] }) =>
                  series.data && Array.isArray(series.data) && series.data.length > 0
                )
              );

              if (hasData) {
                // Chart already has data from parent, just draw it
                drawPlots();
                return;
              }

              // Chart doesn't have data, fetch it
              // Debounce the effect to prevent rapid successive calls
              chartEffectTimeout = setTimeout(async () => {
                try {
                  // Check if we're already processing data to prevent infinite loops
                  if (isProcessingData || isFetchingData) {
                    return;
                  }

                  await processDataForCharts();
                  drawPlots();
                } catch (error: any) {
                  logError('🔄 TimeSeries: Error in chart effect timeout callback:', {
                    error: error,
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                  });
                }
              }, 50); // 50ms debounce
            }
          } catch (error: any) {
            logError('🔄 TimeSeries: Chart changes effect Error Details:', {
              error: error,
              message: error.message,
              stack: error.stack,
              name: error.name,
            });
          }
        })().catch((error: unknown) => {
          // Catch any unhandled promise rejections from the async effect
          logError('🔄 TimeSeries: Unhandled promise rejection in chart changes effect:', {
            error: error,
            message: (error as Error)?.message,
            stack: (error as Error)?.stack,
            name: (error as Error)?.name
          });
        });
      },
      { defer: false }
    )
  );

  // Watch for map data filtering changes and refetch timeseries data
  let lastMapFilteredValue = 0; // Track previous value to detect actual changes
  createEffect(() => {
    // Wrap async operation to catch all promise rejections
    (async () => {
      try {
        mapFilteringEffectCount++;

        // Add aggressive debugging for infinite loop detection
        if (mapFilteringEffectCount > 5) {
          logError('🚨 INFINITE LOOP DETECTED: Map filtering effect called', mapFilteringEffectCount, 'times!');
          logError('🚨 Map filtered value:', unifiedDataStore.mapDataFiltered());
          logError('🚨 Chart data:', props.chart);
          logError('🚨 Processing flags:', { isProcessingData, isFetchingData });
          logError('🚨 Stack trace:', new Error().stack);
          return; // Prevent further execution
        }

        const mapFiltered = unifiedDataStore.mapDataFiltered();

        // Only proceed if the value actually changed (increased)
        // This prevents infinite loops when the value stays > 0
        if (mapFiltered > lastMapFilteredValue && mapFiltered > 0 && props.chart) {
          lastMapFilteredValue = mapFiltered; // Update tracked value

          // Clear any existing timeout
          if (mapFilterEffectTimeout) {
            clearTimeout(mapFilterEffectTimeout);
          }

          // Debounce the effect to prevent rapid successive calls
          mapFilterEffectTimeout = setTimeout(async () => {
            try {
              // Check if we're already processing data to prevent infinite loops
              if (isProcessingData || isFetchingData) {
                return;
              }

              await processDataForCharts();
              drawPlots();
            } catch (error: any) {
              logError('🔄 TimeSeries: Error in map filter effect timeout callback:', {
                error: error,
                message: error.message,
                stack: error.stack,
                name: error.name
              });
            }
          }, 200); // Standardized 200ms debounce
        } else if (mapFiltered === 0) {
          // Reset tracked value when mapDataFiltered is reset to 0
          lastMapFilteredValue = 0;
          mapFilteringEffectCount = 0; // Reset counter when value resets
        } else {
          debug('🗺️ TimeSeries: No map filtering change or chart data, skipping processing');
        }
      } catch (error: any) {
        logError('🔄 TimeSeries: Map filtering effect Error Details:', {
          error: error,
          message: error.message,
          stack: error.stack,
          name: error.name,
          callCount: mapFilteringEffectCount
        });
      }
    })().catch((error) => {
      // Catch any unhandled promise rejections from the async effect
      logError('🔄 TimeSeries: Unhandled promise rejection in map filtering effect:', {
        error: error,
        message: error?.message,
        stack: error?.stack,
        name: error?.name
      });
    });
  }, [unifiedDataStore.mapDataFiltered(), props.chart]);

  // Watch for selectedRange changes to reload data when selection is cleared
  // This ensures full dataset is available after returning from map view
  // Note: We do NOT reload when selectedRange is set (wasSet) - that would re-run drawPlots
  // ~200ms after brush zoom and reset the zoom. Brush zoom already calls redraw() in the brush handler.
  let lastSelectedRangeLength = selectedRange().length;
  let selectedRangeReloadTimeout: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const currentRangeLength = selectedRange().length;
    const wasCleared = lastSelectedRangeLength > 0 && currentRangeLength === 0;
    lastSelectedRangeLength = currentRangeLength;

    // Clear any existing timeout
    if (selectedRangeReloadTimeout) {
      clearTimeout(selectedRangeReloadTimeout);
      selectedRangeReloadTimeout = null;
    }

    // Reload if selection was cleared (went from having a range to empty)
    else if (wasCleared && props.chart && !isProcessingData && !isFetchingData) {
      debug('🔄 TimeSeries: selectedRange cleared (safeguard effect), will reload data to ensure full dataset', {
        previousLength: lastSelectedRangeLength,
        currentLength: currentRangeLength
      });

      // Debounce to avoid rapid successive calls and give the main effect a chance to run first
      selectedRangeReloadTimeout = setTimeout(async () => {
        try {
          // Double-check we're still not processing (main effect might have started)
          if (!isProcessingData && !isFetchingData && props.chart) {
            debug('🔄 TimeSeries: Safeguard - reloading data after selectedRange clear');
            await processDataForCharts();
            drawPlots();
            debug('🔄 TimeSeries: Data reloaded after selectedRange clear (safeguard)');
          } else {
            debug('🔄 TimeSeries: Safeguard reload skipped - data already being processed');
          }
        } catch (error: any) {
          logError('🔄 TimeSeries: Error reloading data after selectedRange clear (safeguard):', error);
        } finally {
          selectedRangeReloadTimeout = null;
        }
      }, 300); // Longer delay to let main effect run first
    }

    // Cleanup function
    return () => {
      if (selectedRangeReloadTimeout) {
        clearTimeout(selectedRangeReloadTimeout);
        selectedRangeReloadTimeout = null;
      }
    };
  });

  // Watch for cut events changes to reload data when cuts are set/cleared
  // This ensures data is filtered to cut ranges when cuts are active
  let lastCutEventsLength = cutEvents().length;
  let lastIsCut = isCut();
  let cutEventsReloadTimeout: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const currentCutEvents = cutEvents();
    const currentIsCut = isCut();
    const currentCutEventsLength = Array.isArray(currentCutEvents) ? currentCutEvents.length : 0;
    const cutsWereSet = lastCutEventsLength === 0 && currentCutEventsLength > 0 && currentIsCut;
    const cutsWereCleared = lastCutEventsLength > 0 && currentCutEventsLength === 0;
    const cutModeChanged = lastIsCut !== currentIsCut;

    lastCutEventsLength = currentCutEventsLength;
    lastIsCut = currentIsCut;

    // Clear any existing timeout
    if (cutEventsReloadTimeout) {
      clearTimeout(cutEventsReloadTimeout);
      cutEventsReloadTimeout = null;
    }

    // Reload data when cuts are set or cleared, or when cut mode changes
    if ((cutsWereSet || cutsWereCleared || cutModeChanged) && props.chart && !isProcessingData && !isFetchingData) {
      debug('🔄 TimeSeries: Cut events changed, reloading data', {
        cutsWereSet,
        cutsWereCleared,
        cutModeChanged,
        currentCutEventsLength,
        currentIsCut,
        previousLength: lastCutEventsLength,
        previousIsCut: lastIsCut,
        note: cutsWereSet || (currentIsCut && currentCutEventsLength > 0)
          ? 'Will filter to cut ranges only'
          : 'Will load full dataset'
      });

      // Debounce to avoid rapid successive calls
      cutEventsReloadTimeout = setTimeout(async () => {
        try {
          if (!isProcessingData && !isFetchingData && props.chart) {
            debug('🔄 TimeSeries: Reloading data after cut events change');
            await processDataForCharts();
            drawPlots();

            // When cuts are set, treat it as a fresh dataset - reset all zoom/selection state
            // When cuts are cleared, reset zoom to show full dataset
            if ((cutsWereSet || cutsWereCleared) && containerRef) {
              // When cuts are set, clear any local selection state (treat as fresh dataset)
              if (cutsWereSet) {
                debug('🔄 TimeSeries: Cuts applied - clearing selection state (treating as fresh dataset)');
                // Clear any local zoom/selection state
                setZoom(false);
                setHasSelection(false);
                // Clear brush visually - cut data should have no brush
                try {
                  if (typeof window !== 'undefined' && (window as any).clearTimeSeriesBrush) {
                    (window as any).clearTimeSeriesBrush();
                  }
                } catch (e) {
                  // ignore
                }
                // Also clear brush via refs if available (after drawPlots completes)
                setTimeout(() => {
                  const refs = d3.select(containerRef).property("__timeSeriesRefs");
                  if (refs && refs.svg && refs.brush) {
                    const brushGroup = refs.svg.select(".brush");
                    if (!brushGroup.empty()) {
                      brushGroup.call(refs.brush.move, null);
                      brushGroup.attr("pointer-events", "none");
                      debug('🔄 TimeSeries: Brush cleared after cuts applied');
                    }
                  }
                }, 150); // Wait for drawPlots to complete
              }

              // Wait a bit for drawPlots to complete and refs to be available
              setTimeout(() => {
                const refs = d3.select(containerRef).property("__timeSeriesRefs");
                if (refs && refs.xZoom && refs.xScale && typeof refs.xZoom.domain === 'function') {
                  // Get the full domain from the current xScale (which reflects the current data - cut or full)
                  const fullDomain = refs.xScale.domain();

                  debug('🔄 TimeSeries: Resetting zoom domain to full extent after cut change', {
                    cutsWereSet,
                    cutsWereCleared,
                    currentIsCut,
                    currentZoomDomain: refs.xZoom.domain(),
                    fullDomain: fullDomain,
                    fullDomainFormatted: fullDomain.map(d => safeToISOString(d))
                  });

                  // Reset zoom to show full extent of the current data
                  refs.xZoom.domain(fullDomain);

                  // Call redraw to update the visualization
                  if (typeof refs.redraw === 'function') {
                    debug('🔄 TimeSeries: Calling redraw after zoom reset for cut data');
                    refs.redraw();
                  }

                  setZoom(false); // Reset zoom state since we're showing full extent
                } else {
                  debug('🔄 TimeSeries: Skipping zoom reset - refs not ready yet', {
                    hasRefs: !!refs,
                    hasXZoom: !!(refs && refs.xZoom),
                    hasXScale: !!(refs && refs.xScale)
                  });
                }
              }, 100); // Small delay to ensure drawPlots has completed
            }

            debug('🔄 TimeSeries: Data reloaded after cut events change');
          } else {
            debug('🔄 TimeSeries: Reload skipped - data already being processed');
          }
        } catch (error: any) {
          logError('🔄 TimeSeries: Error reloading data after cut events change:', error);
        } finally {
          cutEventsReloadTimeout = null;
        }
      }, 200);
    }

    // Cleanup function
    return () => {
      if (cutEventsReloadTimeout) {
        clearTimeout(cutEventsReloadTimeout);
        cutEventsReloadTimeout = null;
      }
    };
  });

  onMount(() => {
    // Register this component as active
    registerActiveComponent('timeseries');


    // Add global error handler for unhandled errors
    const handleError = (event) => {
      // Skip null errors (often from resource loading failures, CORS, etc.)
      if (!event.error && !event.message && !event.filename) {
        return;
      }

      // Filter out ResizeObserver warnings (benign browser warning when callbacks trigger layout changes)
      const errorMessage = event.error?.message || event.message || '';
      if (errorMessage.includes('ResizeObserver loop completed with undelivered notifications') ||
        errorMessage.includes('ResizeObserver loop limit exceeded')) {
        // Silently ignore ResizeObserver warnings - these are harmless browser notifications
        return;
      }

      // Only log meaningful errors
      if (event.error || event.message || (event.filename && event.filename !== window.location.href)) {
        logError('🔄 TimeSeries: Unhandled Error:', {
          error: event.error,
          message: event.error?.message || event.message,
          stack: event.error?.stack,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        });
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', (event) => {
      logError('🔄 TimeSeries: Unhandled Promise Rejection:', {
        reason: event.reason,
        promise: event.promise
      });
    });

    // Add cross-window communication listener for selection updates
    const handleCrossWindowSelectionUpdate = (event) => {
      debug('🔄 TimeSeries: Received cross-window selection update', event.detail);

      const { type, selectedRange: incomingRange, hasSelection: incomingHasSelection } = event.detail;

      if (type === 'SELECTION_CHANGE' && incomingRange && incomingRange.length > 0) {
        debug('🔄 TimeSeries: Processing incoming range selection from map', {
          range: incomingRange[0],
          hasSelection: incomingHasSelection
        });

        // The selection store should already be updated by the Window component
        // We need to zoom to the range and restore the brush
        setTimeout(() => {
          if (containerRef) {
            const refs = d3.select(containerRef).property("__timeSeriesRefs");
            if (refs && refs.xZoom && typeof refs.xZoom.domain === 'function' && incomingRange.length > 0) {
              // Calculate combined extent of all ranges
              let minTime = Infinity;
              let maxTime = -Infinity;

              incomingRange.forEach(range => {
                if (range.start_time && range.end_time) {
                  const startTime = new Date(range.start_time).getTime();
                  const endTime = new Date(range.end_time).getTime();
                  minTime = Math.min(minTime, startTime);
                  maxTime = Math.max(maxTime, endTime);
                }
              });

              if (minTime !== Infinity && maxTime !== -Infinity) {
                const startTime = new Date(minTime);
                const endTime = new Date(maxTime);

                debug('🔄 TimeSeries: Zooming to cross-window selection ranges', {
                  rangeCount: incomingRange.length,
                  startTime: startTime.toISOString(),
                  endTime: endTime.toISOString()
                });

                // Set the zoom domain to show all ranges
                refs.xZoom.domain([startTime, endTime]);

                // Also update the local xZoom for consistency
                if (typeof xZoom !== 'undefined' && xZoom && typeof xZoom.domain === 'function') {
                  xZoom.domain([startTime, endTime]);
                }

                // Redraw the chart
                if (typeof refs.redraw === 'function') {
                  debug('🔄 TimeSeries: Redrawing after cross-window selection update');
                  refs.redraw();
                }

                // Restore brush to show the selection visually
                if (typeof restoreBrushSelection === 'function') {
                  debug('🔄 TimeSeries: Restoring brush after cross-window update');
                  setTimeout(() => restoreBrushSelection(), 50);
                }
              }
            }
          }
        }, 100); // Small delay to ensure selection store is updated
      } else if (type === 'SELECTION_CHANGE') {
        debug('🔄 TimeSeries: Received selection change but no range data', {
          type,
          incomingRange: incomingRange?.length || 0,
          hasSelection: incomingHasSelection
        });
      } else {
        debug('🔄 TimeSeries: Received non-selection update', { type });
      }
    };

    // Listen for cross-window selection updates
    window.addEventListener('selectionStoreUpdate', handleCrossWindowSelectionUpdate);

    // Capture the current playback state
    const wasPlaying = isPlaying();

    // If playing, temporarily pause to ensure proper initialization
    if (wasPlaying) {
      setInitialPlayState(true);
      setIsPlaying(false);
    }

    // Process data and draw plots
    if (props.chart) {
      processDataForCharts().then(() => {
        drawPlots();

        // Clear brush selection on initialization (don't restore from selectedRange)
        setTimeout(() => {
          if (window.clearTimeSeriesBrush) {
            window.clearTimeSeriesBrush();
          }
        }, 500);

        // Final fallback: ensure selectedTime is set after everything is loaded
        setTimeout(() => {
          if (!selectedTime() || selectedTime() < new Date('1971-01-01T12:00:00Z')) {
            debug('⏰ TimeSeries: Final fallback selectedTime initialization');

            // Try to get time from the first available data point
            const chartsData = charts();
            if (chartsData && chartsData.length > 0 && chartsData[0].series && chartsData[0].series.length > 0) {
              const firstSeries = chartsData[0].series[0];
              if (firstSeries.data && firstSeries.data.length > 0) {
                const firstDataPoint = firstSeries.data[0];
                if (firstDataPoint.x instanceof Date) {
                  debug('⏰ TimeSeries: Setting selectedTime from first data point', firstDataPoint.x.toISOString());

                  if (requestTimeControl('timeseries')) {
                    setSelectedTime(firstDataPoint.x, 'timeseries');
                  }
                }
              }
            }
          }
        }, 200);
      });
    }

    // Add comprehensive resize detection for responsive chart sizing
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const triggerChartResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        debug('TimeSeries: Triggering chart resize');
        d3.select(containerRef).select("svg").remove();
        drawPlots();
      }, 100); // Shorter debounce for better responsiveness
    };

    const handleResize = () => {
      triggerChartResize();
    };

    const setupResizeObservers = () => {
      const container = containerRef;
      if (!container) return;

      // ResizeObserver to watch for container size changes
      if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver((entries) => {
          debug('TimeSeries: ResizeObserver triggered');
          triggerChartResize();
        });
        resizeObserver.observe(container);

        // Also observe split-panel if we're in split view
        const splitPanel = container.closest('.split-panel');
        if (splitPanel) {
          debug('TimeSeries: Observing split-panel for resize');
          resizeObserver.observe(splitPanel);
        }
      }

      // MutationObserver to watch for sidebar class changes (only relevant outside split view)
      const sidebar = document.querySelector('.sidebar');
      if (sidebar && window.MutationObserver) {
        mutationObserver = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
              debug('TimeSeries: Sidebar class changed, triggering chart resize');
              // Add a small delay to allow CSS transition to complete
              setTimeout(triggerChartResize, 350);
            }
          });
        });
        mutationObserver.observe(sidebar, {
          attributes: true,
          attributeFilter: ['class']
        });
      }

      // Fallback: Periodic check for container size changes (every 2 seconds)
      debug('⏰ TimeSeries: Periodic container size check DISABLED to prevent unnecessary re-renders');
    };

    // Setup observers after chart is initialized
    setupResizeObservers();

    window.addEventListener("resize", handleResize);

    // Use a microtask to restore playback after initialization completes
    if (wasPlaying) {
      queueMicrotask(() => {
        // Small delay to ensure UI has fully rendered
        setTimeout(() => {
          if (initialPlayState()) {
            setIsPlaying(true);
          }
        }, 50);
      });
    }

    onCleanup(() => {
      // Unregister this component
      unregisterActiveComponent('timeseries');

      window.removeEventListener("resize", handleResize);

      // Clean up observers
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (mutationObserver) {
        mutationObserver.disconnect();
      }

      // Clean up periodic check
      if (window.timeSeriesPeriodicCheck) {
        clearInterval(window.timeSeriesPeriodicCheck);
        delete window.timeSeriesPeriodicCheck;
      }

      // Clean up error handlers
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleError);

      // Clean up cross-window communication listener
      window.removeEventListener('selectionStoreUpdate', handleCrossWindowSelectionUpdate);

      // Clean up brush key handlers
      if (activateBrush) {
        document.removeEventListener("keydown", activateBrush);
      }
      if (deactivateBrush) {
        document.removeEventListener("keyup", deactivateBrush);
      }

      // Clean up wheel event listener
      if (containerRef && wheelHandler) {
        containerRef.removeEventListener('wheel', wheelHandler, { capture: true });
      }

      // Cancel any pending time-window animation frame
      if (timeWindowRafId != null) {
        cancelAnimationFrame(timeWindowRafId);
        timeWindowRafId = null;
      }
      // Cancel any pending animation frame
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      // Clear debounce timeouts
      if (chartEffectTimeout) {
        clearTimeout(chartEffectTimeout);
        chartEffectTimeout = null;
      }
      if (mapFilterEffectTimeout) {
        clearTimeout(mapFilterEffectTimeout);
        mapFilterEffectTimeout = null;
      }
      if (selectedRangeReloadTimeout) {
        clearTimeout(selectedRangeReloadTimeout);
        selectedRangeReloadTimeout = null;
      }
      if (cutEventsReloadTimeout) {
        clearTimeout(cutEventsReloadTimeout);
        cutEventsReloadTimeout = null;
      }
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
        resizeTimeout = null;
      }

      if (containerRef) {
        const chartContainers = containerRef.querySelectorAll('.time-series-single-chart');
        if (chartContainers.length > 0) {
          chartContainers.forEach((el) => {
            const svg = (el as HTMLElement).querySelector('svg');
            if (svg) svg.remove();
          });
        } else {
          d3.select(containerRef).select("svg").remove();
        }
      }
      d3.select(window).on("keydown.brush", null);
      d3.select(window).on("keyup.brush", null);
    });

    // REMOVE the first createEffect that's causing labels to disappear

    // Keep only the optimized createEffect for updating time line and data points
    createEffect(() => {
      const time = selectedTime();
      debug('⏰ TimeSeries: selectedTime effect triggered', {
        hasTime: !!time,
        timeISO: time?.toISOString(),
        hasContainerRef: !!containerRef,
        isPlaying: isPlaying(),
        isZoomed: isZoomed()
      });

      if (!time || !containerRef) {
        debug('⏰ TimeSeries: No time or container, skipping');
        return;
      }

      const refs = d3.select(containerRef).property("__timeSeriesRefs");
      if (!refs) {
        debug('⏰ TimeSeries: No refs available, skipping');
        return;
      }

      const { selectedTimeLine, xZoom, xOffset, updateSelectedTimeLine, redraw } = refs;

      // Check if xZoom is properly initialized
      if (!xZoom || !xZoom.domain || xZoom.domain().length === 0) {
        debug('⏰ TimeSeries: xZoom not initialized, skipping');
        return;
      }

      // Check if time is within the current zoom window
      const [zoomMin, zoomMax] = xZoom.domain();
      const isOutsideZoom = time < zoomMin || time > zoomMax;

      debug('⏰ TimeSeries: Zoom window check', {
        zoomMin: safeToISOString(zoomMin),
        zoomMax: safeToISOString(zoomMax),
        isOutsideZoom,
        isZoomed: isZoomed(),
        isPlaying: isPlaying(),
        xZoomDomain: xZoom.domain(),
        xZoomDomainFormatted: xZoom.domain().map(d => safeToISOString(d))
      });

      // When zoomed in, never auto-adjust the zoom window on play — preserve the user's zoom.
      // The timeline may be off-screen until playback advances into the visible window.

      // Calculate position for the vertical line
      const xPos = xZoom(time) + xOffset;

      debug('⏰ TimeSeries: Timeline position calculated', {
        xPos,
        xOffset,
        time: time.toISOString()
      });

      // Determine behavior based on playback state and speed
      if (isPlaying()) {
        debug('⏰ TimeSeries: Playing state - updating timeline');
        // Use immediate updates for faster playback speeds
        const speed = playbackSpeed();
        const useTransitions = speed === 1;

        debug('⏰ TimeSeries: Playback settings', {
          speed,
          useTransitions,
          lastUpdateTime,
          now: Date.now()
        });

        // When playing, skip brush/range updates to avoid infinite loop (FleetMap + FleetTimeSeries).
        // Time window scrolling is handled by the timeWindow effect; only update visuals here.
        if (!isPlaying()) {
          // Check if we need to move the brush (when selectedTime is within 10 seconds of brush end)
          const currentRange = selectedRange();
          if (currentRange && currentRange.length > 0) {
            const rangeItem = currentRange[0];
            const brushStartTime = new Date(rangeItem.start_time);
            const brushEndTime = new Date(rangeItem.end_time);
            const brushDuration = brushEndTime.getTime() - brushStartTime.getTime();

            // Calculate how close we are to the brush end (in milliseconds)
            const timeToBrushEnd = brushEndTime.getTime() - time.getTime();
            const tenSecondsInMs = 10 * 1000; // 10 seconds in milliseconds

            debug('⏰ TimeSeries: Brush proximity check', {
              selectedTime: time.toISOString(),
              brushStartTime: brushStartTime.toISOString(),
              brushEndTime: brushEndTime.toISOString(),
              brushDuration: brushDuration,
              timeToBrushEnd: timeToBrushEnd,
              tenSecondsInMs: tenSecondsInMs,
              shouldMoveBrush: timeToBrushEnd <= tenSecondsInMs && timeToBrushEnd > 0
            });

            // If we're within 10 seconds of the brush end, move the brush forward
            if (timeToBrushEnd <= tenSecondsInMs && timeToBrushEnd > 0) {
              debug('⏰ TimeSeries: Moving brush forward - selectedTime is within 10 seconds of brush end');

              // Calculate animation step (same as playback store uses)
              // Use fixed 1Hz (1000ms) for non-live data
              const baseInterval = 1000; // Fixed 1Hz interval
              const animationStep = baseInterval;

              // Move both brush start and end by the animation step
              const newBrushStartTime = new Date(brushStartTime.getTime() + animationStep);
              const newBrushEndTime = new Date(brushEndTime.getTime() + animationStep);

              debug('⏰ TimeSeries: Brush movement calculation', {
                animationStep: animationStep,
                oldBrushStart: brushStartTime.toISOString(),
                oldBrushEnd: brushEndTime.toISOString(),
                newBrushStart: newBrushStartTime.toISOString(),
                newBrushEnd: newBrushEndTime.toISOString()
              });

              // Update the selectedRange with the new brush position
              const newRange = {
                "start_time": newBrushStartTime.toISOString(),
                "end_time": newBrushEndTime.toISOString()
              };

              debug('⏰ TimeSeries: Setting new selectedRange for moving brush', newRange);
              setSelectedRange([newRange]);

              // Update the zoom domain to match the new brush position
              xZoom.domain([newBrushStartTime, newBrushEndTime]);

              debug('⏰ TimeSeries: Updated zoom domain for moving brush', {
                newDomain: [newBrushStartTime.toISOString(), newBrushEndTime.toISOString()]
              });

              // Redraw the chart with the new brush position
              debug('⏰ TimeSeries: Redrawing chart with moved brush');
              redraw();
            }
          }
        }

        // Move the timeline - immediate update for faster playback
        if (useTransitions) {
          debug('⏰ TimeSeries: Using transition for timeline update');
          selectedTimeLine
            .interrupt()
            .transition()
            .duration(500)
            .ease(d3.easeLinear)
            .attr("x1", xPos)
            .attr("x2", xPos)
            .attr("visibility", "visible");
        } else {
          debug('⏰ TimeSeries: Using immediate timeline update');
          selectedTimeLine
            .interrupt()
            .attr("x1", xPos)
            .attr("x2", xPos)
            .attr("visibility", "visible");
        }

        // Adjust update interval based on playback speed
        const updateInterval = speed === 1 ? 100 : (100 / speed);

        // Always update on first play or after a navigation
        const isFirstPlayback = lastUpdateTime === 0;
        const now = Date.now();

        debug('⏰ TimeSeries: Update interval check', {
          updateInterval,
          isFirstPlayback,
          timeSinceLastUpdate: now - lastUpdateTime,
          shouldUpdate: isFirstPlayback || (now - lastUpdateTime >= updateInterval)
        });

        // Force update on component mount or new navigation
        if (isFirstPlayback || (now - lastUpdateTime >= updateInterval)) {
          lastUpdateTime = now;
          debug('⏰ TimeSeries: Updating data points and labels');

          // Update data points and labels
          if (updateSelectedTimeLine && typeof updateSelectedTimeLine === 'function') {
            updateSelectedTimeLine();
          }
        }
      } else {
        debug('⏰ TimeSeries: Not playing - immediate update');
        // Reset lastUpdateTime when not playing
        lastUpdateTime = 0;

        // Immediate update when not playing
        selectedTimeLine
          .interrupt()
          .attr("x1", xPos)
          .attr("x2", xPos)
          .attr("visibility", "visible");

        // Update the data points and labels without animation
        if (updateSelectedTimeLine && typeof updateSelectedTimeLine === 'function') {
          debug('⏰ TimeSeries: Updating data points and labels (not playing)');
          updateSelectedTimeLine();
        }
      }
    }, [selectedTime, playbackSpeed]); // Add playbackSpeed as dependency

    // Clear any active brush/selections when selectionBanner clears selection and reset to full domain
    let lastZoomState = ''; // Track last zoom state to prevent loops
    createEffect(() => {
      const ranges = selectedRange();
      const cuts = cutEvents();
      const hasSelectionValue = hasSelection();
      const currentIsCut = isCut();
      const isManualChange = isManualTimeChange();

      debug('🔄 TimeSeries: Selection effect triggered', {
        ranges: ranges?.length || 0,
        cuts: cuts?.length || 0,
        hasSelection: hasSelectionValue,
        isCut: currentIsCut,
        isRedrawing: isRedrawing,
        isManualChange: isManualChange
      });

      // Skip if we're currently redrawing to prevent circular dependency
      if (isRedrawing) {
        debug('🔄 TimeSeries: Skipping effect - currently redrawing');
        return;
      }

      // When playing, timeWindow effect drives the chart; skip selection effect to avoid endless loop (FleetTimeSeries).
      if (isPlaying()) {
        debug('🔄 TimeSeries: Skipping effect - playing, timeWindow effect owns the view');
        return;
      }

      // If this is a manual time change (user click), don't clear brush selection
      // Only clear brush when selection is explicitly cleared (not from user clicks)
      if (isManualChange) {
        debug('🔄 TimeSeries: Skipping effect - manual time change, preserving brush selection');
        // Reset the manual change flag after processing to allow future programmatic clears
        setTimeout(() => {
          setIsManualTimeChange(false);
          debug('🔄 TimeSeries: Reset isManualTimeChange flag');
        }, 100);
        return;
      }

      // Add throttling to prevent infinite loops, but allow clearing operations
      const now = Date.now();
      const noRanges = Array.isArray(ranges) ? ranges.length === 0 : true;
      const noCuts = Array.isArray(cuts) ? cuts.length === 0 : true;
      const isClearing = noRanges && noCuts && !hasSelectionValue && !currentIsCut;

      // Create a signature for the current zoom state to detect if we're in a loop
      const zoomState = `${noRanges}-${noCuts}-${hasSelectionValue}-${currentIsCut}-${cuts?.length || 0}`;
      if (zoomState === lastZoomState && !isClearing) {
        debug('🔄 TimeSeries: Skipping effect - same zoom state, preventing loop');
        return;
      }
      lastZoomState = zoomState;

      // Only throttle if we're not clearing and it's been less than 100ms
      if (!isClearing && now - lastProcessDataTime < 100) {
        debug('🔄 TimeSeries: Skipping effect - throttled');
        return;
      }
      lastProcessDataTime = now;

      if (!containerRef) {
        debug('🔄 TimeSeries: Skipping effect - no containerRef');
        return;
      }

      // When both ranges and cuts are empty, clear the brush and local selection state

      debug('🔄 TimeSeries: Selection state analysis', {
        noRanges,
        noCuts,
        isCut: currentIsCut,
        willResetZoom: noRanges && noCuts && !currentIsCut,
        willResetToCutData: noRanges && !noCuts && currentIsCut
      });

      // If selection is cleared but cuts exist, reset zoom to cut data extent
      if (noRanges && !noCuts && currentIsCut) {
        lastClearedZoomState = ''; // Allow clear path when user later clears cuts
        debug('🔄 TimeSeries: Selection cleared but cuts exist - resetting zoom to cut data extent');

        // Reset zoom to full extent of cut data (xScale already reflects cut data)
        const refs = d3.select(containerRef).property("__timeSeriesRefs");
        if (refs && refs.xZoom && refs.xScale && typeof refs.xZoom.domain === 'function') {
          const fullDomain = refs.xScale.domain(); // This is the cut data extent

          debug('🔄 TimeSeries: Resetting zoom to cut data extent', {
            currentZoomDomain: refs.xZoom.domain(),
            cutDataExtent: fullDomain,
            cutDataExtentFormatted: fullDomain.map(d => safeToISOString(d))
          });

          refs.xZoom.domain(fullDomain);

          if (typeof refs.redraw === 'function') {
            refs.redraw();
          }

          setZoom(false);
          setHasSelection(false);
        }
        return; // Don't proceed to full dataset reset
      }

      // If no ranges, no cuts, and not in cut mode - reset to full dataset
      if (noRanges && noCuts && !currentIsCut) {
        // Skip if we already ran the clear path for this state (prevents loop when store updates cause re-render)
        if (zoomState === lastClearedZoomState) {
          debug('🔄 TimeSeries: Already in cleared state, skipping reset to prevent loop');
          return;
        }
        lastClearedZoomState = zoomState;

        const tw = (typeof timeWindow === 'function') ? timeWindow() : 0;
        if (tw && tw > 0) {
          debug('🔄 TimeSeries: Selections cleared but timeWindow active - skipping full-domain reset');
          return;
        }
        debug('🔄 TimeSeries: Clearing selections and resetting zoom to full domain');

        // IMPORTANT: Reload data when selection is cleared to ensure full dataset is available
        // This fixes the issue where data appears "cut" after returning from map view
        if (props.chart && !isProcessingData && !isFetchingData) {
          debug('🔄 TimeSeries: Reloading data after selection clear');
          processDataForCharts().then(() => {
            // After data is reloaded, reset zoom and redraw
            const refs = d3.select(containerRef).property("__timeSeriesRefs");

            if (refs && refs.xZoom && typeof refs.xZoom.domain === 'function' && refs.xScale) {
              // Get the full domain from the current xScale (same as double-click handler)
              const fullDomain = refs.xScale.domain();

              debug('🔄 TimeSeries: Resetting zoom domain after data reload', {
                currentZoomDomain: refs.xZoom.domain(),
                fullDomain: fullDomain,
                fullDomainFormatted: fullDomain.map(d => new Date(d).toISOString())
              });

              refs.xZoom.domain(fullDomain);

              // Also update the local xZoom if it exists (for consistency)
              if (typeof xZoom !== 'undefined' && xZoom && typeof xZoom.domain === 'function') {
                xZoom.domain(fullDomain);
              }

              // Call the redraw function from refs
              if (typeof refs.redraw === 'function') {
                debug('🔄 TimeSeries: Calling redraw after zoom reset');
                refs.redraw();
              }

              setZoom(false);
              setHasSelection(false);
              setSelection([]);

              debug('🔄 TimeSeries: Zoom reset completed after data reload');
            } else {
              // Refs not available yet - this is expected during initialization
              debug('🔄 TimeSeries: Skipping zoom reset - refs not ready yet', {
                hasRefs: !!refs,
                hasXZoom: !!(refs && refs.xZoom),
                hasXScale: !!(refs && refs.xScale)
              });
            }
          }).catch((error) => {
            logError('🔄 TimeSeries: Error reloading data after selection clear:', error);
            // Fallback to just resetting zoom without reloading data
            const refs = d3.select(containerRef).property("__timeSeriesRefs");
            if (refs && refs.xZoom && typeof refs.xZoom.domain === 'function' && refs.xScale) {
              const fullDomain = refs.xScale.domain();
              refs.xZoom.domain(fullDomain);
              if (typeof xZoom !== 'undefined' && xZoom && typeof xZoom.domain === 'function') {
                xZoom.domain(fullDomain);
              }
              if (typeof refs.redraw === 'function') {
                refs.redraw();
              }
              setZoom(false);
              setHasSelection(false);
              setSelection([]);
            }
          });
        } else {
          // If we can't reload data, at least reset the zoom
          const refs = d3.select(containerRef).property("__timeSeriesRefs");

          if (refs && refs.xZoom && typeof refs.xZoom.domain === 'function' && refs.xScale) {
            // Get the full domain from the current xScale (same as double-click handler)
            const fullDomain = refs.xScale.domain();

            debug('🔄 TimeSeries: Resetting zoom domain (data reload skipped)', {
              currentZoomDomain: refs.xZoom.domain(),
              fullDomain: fullDomain,
              fullDomainFormatted: fullDomain.map(d => safeToISOString(d)),
              reason: !props.chart ? 'no chart' : isProcessingData ? 'processing' : isFetchingData ? 'fetching' : 'unknown'
            });

            refs.xZoom.domain(fullDomain);

            // Also update the local xZoom if it exists (for consistency)
            if (typeof xZoom !== 'undefined' && xZoom && typeof xZoom.domain === 'function') {
              xZoom.domain(fullDomain);
            }

            // Call the redraw function from refs
            if (typeof refs.redraw === 'function') {
              debug('🔄 TimeSeries: Calling redraw after zoom reset');
              refs.redraw();
            }

            setZoom(false);
            setHasSelection(false);
            setSelection([]);

            debug('🔄 TimeSeries: Zoom reset completed (without data reload)');
          } else {
            // Refs not available yet - this is expected during initialization
            debug('🔄 TimeSeries: Skipping zoom reset - refs not ready yet', {
              hasRefs: !!refs,
              hasXZoom: !!(refs && refs.xZoom),
              hasXScale: !!(refs && refs.xScale)
            });
          }
        }
      } else {
        lastClearedZoomState = ''; // Allow clear path to run again when user clears selection later
        debug('🔄 TimeSeries: Not resetting zoom - selections still exist', {
          ranges: ranges?.length || 0,
          cuts: cuts?.length || 0,
          isCut: currentIsCut
        });

        // Priority: If cut data exists, use cut ranges; otherwise use selectedRange
        // When cut data exists, we want to show the full extent of all cut ranges
        // BUT: Only zoom if we're actually in cut mode (isCut is true)
        // If cuts exist but isCut is false, it means they're being cleared
        const rangesToUse = (currentIsCut && cuts && cuts.length > 0) ? cuts : (ranges.length > 0 ? ranges : []);

        // Don't zoom if we have cuts but isCut is false (clearing in progress)
        if (cuts && cuts.length > 0 && !currentIsCut) {
          debug('🧹 TimeSeries: Cut events exist but isCut is false - clearing in progress, skipping zoom');
          return;
        }

        if (rangesToUse.length === 0) {
          debug('🧹 TimeSeries: No ranges to zoom to');
          return;
        }

        debug('🧹 TimeSeries: Range detected - zooming to show ranges', {
          isCut: currentIsCut,
          rangeCount: rangesToUse.length,
          ranges: rangesToUse,
          usingCutRanges: currentIsCut && cuts && cuts.length > 0
        });

        // Zoom to show all ranges (combined extent)
        const refs = d3.select(containerRef).property("__timeSeriesRefs");
        if (refs && refs.xZoom && refs.xScale) {
          // Calculate the combined extent of all ranges
          let minTime = Infinity;
          let maxTime = -Infinity;

          rangesToUse.forEach(range => {
            if (range.start_time && range.end_time) {
              const startTime = new Date(range.start_time).getTime();
              const endTime = new Date(range.end_time).getTime();
              minTime = Math.min(minTime, startTime);
              maxTime = Math.max(maxTime, endTime);
            }
          });

          if (minTime !== Infinity && maxTime !== -Infinity) {
            const startTime = new Date(minTime);
            const endTime = new Date(maxTime);

            debug('🧹 TimeSeries: Setting zoom domain to combined ranges', {
              rangeCount: rangesToUse.length,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              isCut: currentIsCut
            });

            // Set the zoom domain to show all ranges
            refs.xZoom.domain([startTime, endTime]);

            // Also update the local xZoom for consistency
            if (typeof xZoom !== 'undefined' && xZoom && typeof xZoom.domain === 'function') {
              xZoom.domain([startTime, endTime]);
            }

            // Call redraw to update the visualization
            if (typeof refs.redraw === 'function') {
              debug('🧹 TimeSeries: Redrawing after range zoom');
              refs.redraw();
            }

            // Restore brush selection only if not in cut mode (cut mode shows all data, no brush needed)
            if (!currentIsCut && typeof restoreBrushSelection === 'function') {
              debug('🧹 TimeSeries: Restoring brush to match range');
              setTimeout(() => restoreBrushSelection(), 50);
            } else if (currentIsCut) {
              debug('🧹 TimeSeries: Skipping brush restoration - cut mode active');
            }

            // Update local state
            setZoom(true);
            setHasSelection(true);
            setSelection(rangesToUse); // Set all ranges, not just the first one
            debug('🧹 TimeSeries: Range zoom completed', {
              rangeCount: rangesToUse.length,
              isCut: currentIsCut
            });
          }
        } else {
          warn('🧹 TimeSeries: Cannot zoom to range - missing refs', {
            hasRefs: !!refs,
            hasXZoom: !!(refs && refs.xZoom),
            hasXScale: !!(refs && refs.xScale)
          });
        }
      }
    }, [selectedRange, cutEvents, hasSelection, isManualTimeChange]); // Explicit dependencies

    // When a cut range is created, clear any active brush selection and selectedRange locally
    createEffect(() => {
      const cuts = cutEvents();

      debug('✂️ TimeSeries: Cut events effect triggered', {
        cutsLength: Array.isArray(cuts) ? cuts.length : 'not array',
        hasContainerRef: !!containerRef,
        cuts
      });

      if (!containerRef) {
        debug('✂️ TimeSeries: No container ref, skipping');
        return;
      }

      if (Array.isArray(cuts) && cuts.length > 0) {
        debug('✂️ TimeSeries: Cut events detected - will be handled by main selection effect');
        // The main selection clearing effect will handle zooming to cut events
        // No need to clear brush or selectedRange here
      } else {
        debug('✂️ TimeSeries: No cut events, skipping');
      }
    });

    // Remove reactive effect entirely to prevent infinite loops
    // Brush restoration will only happen during chart initialization

    // Reactive effect to update event overlays when selections or cut events change
    createEffect(() => {
      const events = selectedEvents();
      const ranges = selectedRanges();
      const currentIsCut = isCut();
      const currentCutEvents = cutEvents();

      // Access these to make the effect reactive
      const _ = events.length;
      const __ = ranges.length;
      const ___ = currentIsCut;
      const ____ = currentCutEvents?.length || 0;

      if (!containerRef) {
        return;
      }

      const refs = d3.select(containerRef).property("__timeSeriesRefs");
      if (refs && refs.drawEventOverlays && typeof refs.drawEventOverlays === 'function') {
        debug('🎨 TimeSeries: Updating overlays due to selection/cut change', {
          eventCount: events.length,
          rangeCount: ranges.length,
          isCut: currentIsCut,
          cutRangesCount: currentCutEvents?.length || 0
        });
        refs.drawEventOverlays();
      }
    });
  });

  // Removed: previously initialized selectedRange from timeWindow; we now avoid creating a brush for timeWindow

  /** When playing, position visible window so playhead is this many ms from the right edge (e.g. 10s lead). */
  const PLAYBACK_WINDOW_LEAD_MS = 10 * 1000;

  // With a non-zero global timeWindow, zoom in to that window and scroll it so the
  // window always ends at reference time (playhead at trailing edge = scrolling view).
  // Uses getDisplayWindowReferenceTime when playing so chart stays in sync with map smooth playback.
  // When playing, playhead is PLAYBACK_WINDOW_LEAD_MS from the right edge so the window scrolls with animation.
  // Throttled via requestAnimationFrame when playing for efficient animation (~8–10fps).
  // Explicitly read smoothPlaybackTimeForTrack() when playing so this effect re-runs and the window scrolls.
  createEffect(() => {
    const ready = refsReady();
    const tw = (typeof timeWindow === 'function') ? timeWindow() : 0;
    const playing = isPlaying();
    // When playing, explicitly depend on smooth time so effect re-runs and window scrolls with animation
    if (playing) {
      smoothPlaybackTimeForTrack();
    }
    const center = playing ? getDisplayWindowReferenceTime() : selectedTime();

    if (!ready) return;
    if (!tw || tw <= 0 || !(center instanceof Date) || isNaN(center.getTime())) return;
    if (!containerRef) return;

    // If the user has brushed to zoom in, do not override their zoom when they click to set selectedTime.
    // When playing, always drive the window from timeWindow so the chart scrolls with animation (avoids loop).
    const ranges = selectedRange();
    if (ranges && ranges.length > 0 && !playing) {
      return;
    }

    const refs = d3.select(containerRef).property("__timeSeriesRefs");
    if (!refs || !refs.xZoom || !refs.redraw) return;

    const { xZoom, redraw } = refs;
    // When playing, right edge = reference + lead so playhead is 10s from end; when not playing, playhead at right edge
    const windowEnd = playing ? center.getTime() + PLAYBACK_WINDOW_LEAD_MS : center.getTime();
    const windowStart = windowEnd - (tw * 60 * 1000);

    const domain = xZoom.domain && xZoom.domain();
    const currMinMs = Array.isArray(domain) && domain[0] ? (domain[0] as Date).getTime() : null;
    const currMaxMs = Array.isArray(domain) && domain[1] ? (domain[1] as Date).getTime() : null;
    const domainDiffers = currMinMs !== windowStart || currMaxMs !== windowEnd;

    // Throttled debug: log when effect runs and whether domain is updated (~every 500ms when playing)
    const now = Date.now();
    if (now - lastTimeWindowDebugLog >= 500) {
      lastTimeWindowDebugLog = now;
      debug('⏰ TimeSeries time-window effect', {
        ready,
        tw,
        playing,
        center: center?.toISOString?.(),
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
        domainDiffers,
        willApply: domainDiffers
      });
    }

    if (!domainDiffers) return;

    const applyDomainAndRedraw = () => {
      timeWindowRafId = null;
      if (!containerRef) return;
      const refsNow = d3.select(containerRef).property("__timeSeriesRefs");
      if (!refsNow?.xZoom || !refsNow.redraw) return;
      refsNow.xZoom.domain([windowStart, windowEnd]);
      // When playing, skip setZoom(true) to avoid re-triggering selectedTime effect every tick (prevents lockup).
      if (!playing) setZoom(true);
      refsNow.redraw();
    };

    if (playing) {
      if (timeWindowRafId != null) cancelAnimationFrame(timeWindowRafId);
      timeWindowRafId = requestAnimationFrame(() => {
        const now = Date.now();
        if (now - lastTimeWindowRedrawTime < 100) return;
        lastTimeWindowRedrawTime = now;
        applyDomainAndRedraw();
      });
    } else {
      if (timeWindowRafId != null) {
        cancelAnimationFrame(timeWindowRafId);
        timeWindowRafId = null;
      }
      applyDomainAndRedraw();
    }
  });

  // When timeWindow returns to Full (0), clear any zoom and show full domain
  createEffect(() => {
    const tw = (typeof timeWindow === 'function') ? timeWindow() : 0;
    if (tw !== 0) return;
    if (!containerRef) return;
    const refs = d3.select(containerRef).property("__timeSeriesRefs");
    if (!refs || !refs.xZoom || !refs.xScale || !refs.redraw) return;
    const fullDomain = refs.xScale.domain && refs.xScale.domain();
    if (!Array.isArray(fullDomain) || fullDomain.length !== 2) return;
    const current = refs.xZoom.domain && refs.xZoom.domain();
    if (!Array.isArray(current) || current.length !== 2) return;
    if (current[0] === fullDomain[0] && current[1] === fullDomain[1]) return;
    refs.xZoom.domain(fullDomain);
    setZoom(false);
    refs.redraw();
  });

  return (
    <>
      <Show when={isLoading() || isDataLoading()}>
        <LoadingOverlay
          message={isDataLoading() ? dataLoadingMessage() : "Loading time series data..."}
          type="spinner"
        />
      </Show>
      <Show when={!isLoading() && !isDataLoading()}>
        {props.showLegendTable ? (
          <div class="timeseries-with-legend" ref={(el) => (containerRef = el)}>
            <For each={charts()}>
              {(chart, i) => (
                <div class="timeseries-chart-and-table-pair" style={{
                  "opacity": (isLoading() || isDataLoading()) ? 0.2 : 1,
                  "pointer-events": (isLoading() || isDataLoading()) ? "none" : "auto",
                  "transition": "opacity 0.5s ease"
                }}>
                  <div class="time-series time-series-single-chart" data-chart-index={i()} />
                  <div class="timeseries-legend-tables">
                    <LegendTable
                      chart={chart}
                      highlightedTeams={fleetLegendHighlightNames}
                      onToggleTeam={toggleFleetLegendHighlight}
                      chartLayoutEpoch={fleetLegendTableEpoch}
                      getVisibleXDomain={() => {
                        if (!containerRef) return null;
                        const refs = d3.select(containerRef).property("__timeSeriesRefs") as
                          | { xZoom?: d3.ScaleTime<number, number> }
                          | undefined;
                        const xz = refs?.xZoom;
                        if (!xz || typeof xz.domain !== "function") return null;
                        const d = xz.domain();
                        if (!Array.isArray(d) || d.length !== 2) return null;
                        return { lo: d[0], hi: d[1] };
                      }}
                    />
                  </div>
                </div>
              )}
            </For>
          </div>
        ) : (
          <div class="time-series" ref={(el) => (containerRef = el)} style={{
            "opacity": (isLoading() || isDataLoading()) ? 0.2 : 1,
            "pointer-events": (isLoading() || isDataLoading()) ? "none" : "auto",
            "transition": "opacity 0.5s ease"
          }}>
          </div>
        )}
      </Show>
    </>
  );
};

// Utility function for consistent rounding
function Round(value, decimals) {
  return Number(Math.round(Number(value + "e" + decimals)) + "e-" + decimals);
}

export default TimeSeries;
