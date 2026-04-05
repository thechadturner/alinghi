/**
 * Canvas uPlot explore time series for high-frequency (RAW / 10 Hz) data.
 * Parity with D3 explore: brush zoom (drag), wheel pan when zoomed, dblclick reset, click scrub, upper-left stats.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import * as d3 from "d3";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { selectedTime, setSelectedTime, setIsManualTimeChange, requestTimeControl } from "../../store/playbackStore";
import {
  clearActiveSelection,
  clearSelection,
  cutEvents,
  isCut,
  selectedRange,
  setHasSelection,
  setSelectedRange,
} from "../../store/selectionStore";
import { getColorByIndex } from "../../utils/colorScale";
import { debug, error as logError } from "../../utils/console";
import { dataResampleLegendBracket, lineTypeDisplayLabel } from "../../utils/timeseriesSeriesTransforms";

const CHART_HEIGHT = 300;
const MARGIN = { top: 25, right: 25, bottom: 25, left: 45 };
/** Match PlaybackTimeSeries closest-sample tolerance so union-grid alignment does not null out every y. */
const ALIGN_THRESHOLD_MS = 30_000;

export type ExploreUPlotBridgeRefs = {
  resetZoomToFull: () => void;
  redraw: () => void;
  /** When `syncSelectionStore` is false (e.g. global time window), only the x scale updates. */
  setZoomDomainFromMs: (startMs: number, endMs: number, syncSelectionStore?: boolean) => void;
  getFullDomainMs: () => [number, number] | null;
  getZoomDomainMs: () => [number, number] | null;
};

function seriesDisplayName(series: { label?: string; yaxis?: { name?: string } }): string {
  return series?.label ?? series?.yaxis?.name ?? "Series";
}

function pointMs(x: unknown): number {
  if (x instanceof Date) return x.getTime();
  if (typeof x === "number" && Number.isFinite(x)) {
    const ax = Math.abs(x);
    // Heuristic: unix seconds ~1e9–1e10; epoch ms ~1e12–1e13 (prevents wrong 1970-era dates).
    if (ax > 0 && ax < 1e11) return x * 1000;
    return x;
  }
  if (typeof x === "string") {
    const t = x.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) {
        const ax = Math.abs(n);
        if (ax > 0 && ax < 1e11) return n * 1000;
        return n;
      }
    }
  }
  return new Date(x as string).getTime();
}

function formatStat(val: number | undefined | null): string {
  if (val === undefined || val === null || Number.isNaN(val) || !Number.isFinite(val)) return "N/A";
  return String(Number(Math.round(Number(val) * 100) / 100));
}

function indexAtOrBefore(data: Array<{ x: unknown }>, tMs: number): number {
  let lo = 0;
  let hi = data.length - 1;
  if (hi < 0 || pointMs(data[0].x) > tMs) return -1;
  if (pointMs(data[hi].x) <= tMs) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pointMs(data[mid].x) <= tMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

function closestY(
  sorted: Array<{ x: unknown; y?: number | null | undefined; displayY?: number | null | undefined }>,
  tMs: number,
  thresholdMs: number
): number | null {
  const pointValue = (p: { y?: number | null | undefined; displayY?: number | null | undefined }): number | null => {
    const v = p.displayY ?? p.y;
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const i = indexAtOrBefore(sorted, tMs);
  if (i < 0) {
    if (sorted.length === 0) return null;
    const d = pointMs(sorted[0].x);
    if (Math.abs(d - tMs) > thresholdMs) return null;
    return pointValue(sorted[0]);
  }
  const a = sorted[i];
  const aMs = pointMs(a.x);
  const ya = pointValue(a);
  if (i === sorted.length - 1) {
    return Math.abs(aMs - tMs) <= thresholdMs ? ya : null;
  }
  const b = sorted[i + 1];
  const bMs = pointMs(b.x);
  const yb = pointValue(b);
  const da = Math.abs(aMs - tMs);
  const db = Math.abs(bMs - tMs);
  const pickA = da <= db;
  const dist = pickA ? da : db;
  if (dist > thresholdMs) return null;
  return pickA ? ya : yb;
}

type BuiltChart = {
  data: uPlot.AlignedData;
  seriesMeta: { label: string; color: string; dataResample?: unknown; lineType?: unknown; rawSeries: any }[];
  fullMinSec: number;
  fullMaxSec: number;
};

function buildChartAligned(chart: any): BuiltChart | null {
  const seriesList = chart.series ?? [];
  if (seriesList.length === 0) return null;

  const timeSet = new Set<number>();
  for (const s of seriesList) {
    for (const p of s.data ?? []) {
      const t = pointMs(p.x);
      if (Number.isFinite(t)) timeSet.add(t);
    }
  }
  const timesMs = [...timeSet].sort((a, b) => a - b);
  if (timesMs.length === 0) return null;

  const xSec = timesMs.map((t) => t / 1000);
  const fullMinSec = xSec[0]!;
  const fullMaxSec = xSec[xSec.length - 1]!;

  const seriesMeta: BuiltChart["seriesMeta"] = [];
  const yCols: (number | null)[][] = [];

  seriesList.forEach((s: any, si: number) => {
    const label = seriesDisplayName(s);
    const color = typeof s.color === "string" && s.color ? s.color : getColorByIndex(si);
    seriesMeta.push({ label, color, dataResample: s.dataResample, lineType: s.lineType, rawSeries: s });
    const sorted = [...(s.data ?? [])].sort((a: any, b: any) => pointMs(a.x) - pointMs(b.x));
    const ys = timesMs.map((t) => closestY(sorted, t, ALIGN_THRESHOLD_MS));
    yCols.push(ys);
  });

  return {
    data: [xSec, ...yCols] as uPlot.AlignedData,
    seriesMeta,
    fullMinSec,
    fullMaxSec,
  };
}

function formatAxisTime(sec: number, tz: string | null): string {
  const d = new Date(sec * 1000);
  if (tz) {
    try {
      return d.toLocaleTimeString(undefined, {
        timeZone: tz,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      /* fall through */
    }
  }
  return d.toISOString().slice(11, 19);
}

function plotXFromTimeSec(u: uPlot, sec: number): number {
  return u.bbox.left + u.valToPos(sec, "x");
}

function correctedPointerPlotX(target: HTMLElement, clientX: number, plotWidth: number): number {
  const rect = target.getBoundingClientRect();
  if (!(rect.width > 0)) {
    return 0;
  }
  const scaleX = target.offsetWidth > 0 ? target.offsetWidth / rect.width : 1;
  const localX = (clientX - rect.left) * scaleX;
  return Math.max(0, Math.min(plotWidth, localX));
}

function statsForSeries(
  rawSeries: any,
  visLoMs: number,
  visHiMs: number,
  selMs: number | null
): { min?: number; max?: number; avg?: number; std?: number; sel?: number } {
  const data = rawSeries?.data as Array<{
    x: Date | unknown;
    y?: number | null | undefined;
    displayY?: number | null | undefined;
  }> | undefined;
  if (!data?.length) return {};
  const ys: number[] = [];
  for (const d of data) {
    const t = pointMs(d.x);
    if (t < visLoMs || t > visHiMs) continue;
    const val = d.displayY ?? d.y;
    if (val === null || val === undefined || Number.isNaN(Number(val)) || !Number.isFinite(Number(val))) continue;
    ys.push(Number(val));
  }
  if (ys.length === 0) return {};
  const min = d3.min(ys);
  const max = d3.max(ys);
  const avg = d3.mean(ys);
  const std =
    avg !== undefined && ys.length > 0
      ? Math.sqrt(d3.mean(ys, (y) => Math.pow(y - avg!, 2)) ?? 0)
      : undefined;

  let sel: number | undefined;
  if (selMs != null && Number.isFinite(selMs)) {
    const sorted = [...data].sort((a, b) => pointMs(a.x) - pointMs(b.x));
    const cy = closestY(sorted, selMs, Number.POSITIVE_INFINITY);
    if (cy != null) sel = cy;
  }

  return { min: min ?? undefined, max: max ?? undefined, avg: avg ?? undefined, std: std ?? undefined, sel };
}

export interface ExploreTimeSeriesUPlotProps {
  charts: any[];
  timezone: string | null;
  /** Bumped by parent to force redraw after external updates. */
  visualEpoch: number;
  getHostElement: () => HTMLElement | null;
  onBridgeReady: (refs: ExploreUPlotBridgeRefs | null) => void;
  onZoomedChange: (zoomed: boolean) => void;
}

export default function ExploreTimeSeriesUPlot(props: ExploreTimeSeriesUPlotProps) {
  let rootEl: HTMLDivElement | null = null;
  const instancesRef: { current: uPlot[] } = { current: [] };
  const interactionStateRef: WeakMap<uPlot, { hoverLeft: number | null; brushLeft: number | null; brushWidth: number | null }> =
    new WeakMap();
  const perChartLegendContainersRef: { current: (HTMLDivElement | null)[] } = { current: [] };
  const resizeObserversRef: { current: ResizeObserver[] } = { current: [] };
  const fullDomainRef: { current: { min: number; max: number } } = { current: { min: 0, max: 1 } };
  /** External zoom/pan targets live here; user brush zoom updates this after uPlot settles. */
  const xVisibleRangeRef: { current: { min: number; max: number } } = { current: { min: 0, max: 1 } };
  let programmaticScale = false;
  let wheelHandler: ((e: WheelEvent) => void) | null = null;
  let dblClickHandler: ((ev: MouseEvent) => void) | null = null;

  const [visibleDomainSec, setVisibleDomainSec] = createSignal<[number, number] | null>(null);

  const builtCharts = createMemo((): BuiltChart[] => {
    const list = props.charts ?? [];
    const out: BuiltChart[] = [];
    for (const ch of list) {
      const b = buildChartAligned(ch);
      if (b) out.push(b);
    }
    return out;
  });

  function refreshPerChartLegends() {
    const built = builtCharts();
    const containers = perChartLegendContainersRef.current;
    const dom = visibleDomainSec();
    const t = selectedTime();
    const selMs = t instanceof Date && Number.isFinite(t.getTime()) ? t.getTime() : null;

    containers.forEach((container) => {
      container?.replaceChildren();
    });

    if (!dom) return;
    const [loS, hiS] = dom;
    const visLoMs = loS * 1000;
    const visHiMs = hiS * 1000;

    built.forEach((bc, chartIdx) => {
      const container = containers[chartIdx];
      if (!container) return;

      let pad = 0;
      for (const sm of bc.seriesMeta) {
        pad = Math.max(pad, sm.label.length);
      }
      pad += 3;

      for (const sm of bc.seriesMeta) {
        const st = statsForSeries(sm.rawSeries, visLoMs, visHiMs, selMs);
        const padded = sm.label.length + 3 !== pad ? sm.label.padEnd(pad, "\u00A0") : sm.label;
        const lt = lineTypeDisplayLabel(sm.lineType);
        const bracket = dataResampleLegendBracket(sm.dataResample);
        const metricsText = `${st.sel !== undefined ? ` [Sel: ${formatStat(st.sel)}]` : ""} [Min: ${formatStat(st.min)}] [Max: ${formatStat(st.max)}] [Avg: ${formatStat(st.avg)}] [Std: ${formatStat(st.std)}]${bracket} [Type: ${lt}]`;

        const row = document.createElement("div");
        row.className = "explore-uplot-legend-line";
        row.textContent = `${padded}${metricsText}`;
        row.style.setProperty("color", sm.color);
        container.appendChild(row);
      }
    });
  }

  function destroyPlots() {
    if (wheelHandler && rootEl) {
      rootEl.removeEventListener("wheel", wheelHandler, { capture: true });
      wheelHandler = null;
    }
    if (dblClickHandler && rootEl) {
      rootEl.removeEventListener("dblclick", dblClickHandler, { capture: true });
      dblClickHandler = null;
    }
    for (const ro of resizeObserversRef.current) {
      try {
        ro.disconnect();
      } catch {
        /* noop */
      }
    }
    resizeObserversRef.current = [];
    for (const u of instancesRef.current) {
      try {
        u.destroy();
      } catch {
        /* noop */
      }
    }
    instancesRef.current = [];
    perChartLegendContainersRef.current = [];
    if (rootEl) {
      rootEl.querySelectorAll(".explore-uplot-chart-wrap").forEach((el) => el.remove());
    }
  }

  /** Sync selection store from visible x window (D3 TimeSeries parity). */
  function syncStoresForVisibleWindow(minSec: number, maxSec: number, kind: "zoom" | "pan" | "reset") {
    const full = fullDomainRef.current;
    const span = maxSec - minSec;
    const fullSpan = full.max - full.min;
    const tol = Math.max(1e-3, fullSpan * 0.002);
    const atFull =
      kind === "reset" ||
      fullSpan <= 0 ||
      (Math.abs(minSec - full.min) <= tol && Math.abs(maxSec - full.max) <= tol) ||
      span >= fullSpan - tol;

    if (atFull) {
      setSelectedRange([]);
      setHasSelection(false);
      props.onZoomedChange(false);
    } else {
      const t0 = new Date(minSec * 1000);
      const t1 = new Date(maxSec * 1000);
      setSelectedRange([{ start_time: t0.toISOString(), end_time: t1.toISOString() }]);
      setHasSelection(true);
      props.onZoomedChange(true);
      if (kind === "zoom") {
        if (requestTimeControl("timeseries")) {
          setIsManualTimeChange(true);
          setSelectedTime(t0, "timeseries");
        }
      } else if (kind === "pan") {
        const cur = selectedTime();
        if (cur instanceof Date && Number.isFinite(cur.getTime()) && (cur < t0 || cur > t1) && requestTimeControl("timeseries")) {
          setIsManualTimeChange(true);
          setSelectedTime(t0, "timeseries");
        }
      }
    }
    setVisibleDomainSec([minSec, maxSec]);
  }

  function applyXAll(minSec: number, maxSec: number) {
    const full = fullDomainRef.current;
    let mn = minSec;
    let mx = maxSec;
    if (!(Number.isFinite(mn) && Number.isFinite(mx) && mx > mn)) {
      mn = full.min;
      mx = full.max;
    } else {
      mn = Math.max(mn, full.min);
      mx = Math.min(mx, full.max);
      if (!(mx > mn)) {
        mn = full.min;
        mx = full.max;
      }
    }
    xVisibleRangeRef.current = { min: mn, max: mx };
    programmaticScale = true;
    try {
      for (const u of instancesRef.current) {
        u.setScale("x", { min: mn, max: mx });
      }
      setVisibleDomainSec([mn, mx]);
    } finally {
      queueMicrotask(() => {
        programmaticScale = false;
      });
    }
  }

  function clearAllBrushes() {
    for (const u of instancesRef.current) {
      const state = interactionStateRef.get(u);
      if (state) {
        state.brushLeft = null;
        state.brushWidth = null;
      }
      try {
        u.redraw();
      } catch {
        /* noop */
      }
    }
  }

  function mountPlots() {
    destroyPlots();
    const host = props.getHostElement();
    if (!rootEl || !host) return;

    const built = builtCharts();
    if (built.length === 0) {
      props.onBridgeReady(null);
      return;
    }

    const globalMin = Math.min(...built.map((b) => b.fullMinSec));
    const globalMax = Math.max(...built.map((b) => b.fullMaxSec));
    fullDomainRef.current = { min: globalMin, max: globalMax };
    xVisibleRangeRef.current = { min: globalMin, max: globalMax };

    const tz = props.timezone;
    perChartLegendContainersRef.current = built.map(() => null);

    built.forEach((bc, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "explore-uplot-chart-wrap";
      wrap.dataset.chartIndex = String(idx);
      rootEl!.appendChild(wrap);

      const legendInner = document.createElement("div");
      legendInner.className = "explore-uplot-chart-legend-inner";
      legendInner.setAttribute("aria-hidden", "true");

      const chartWidth = Math.max(wrap.offsetWidth || host.offsetWidth || 400, 100) - MARGIN.left - MARGIN.right;
      const chartHeight = CHART_HEIGHT;

      const opts: uPlot.Options = {
        width: Math.max(chartWidth + MARGIN.left + MARGIN.right, 100),
        height: chartHeight + MARGIN.top + MARGIN.bottom,
        series: [
          { label: "Time" },
          ...bc.seriesMeta.map((m) => ({
            label: m.label,
            stroke: m.color,
            scale: "y",
            width: 1,
            spanGaps: true,
            points: { show: false },
            value: (_u: uPlot, raw: number | null) => (raw == null ? "—" : String(Number(raw).toFixed(2))),
          })),
        ],
        scales: {
          x: {
            time: true,
            range: (_u, dataMin, dataMax) => {
              if (programmaticScale) {
                const r = xVisibleRangeRef.current;
                if (Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > r.min) {
                  return [r.min, r.max];
                }
              }
              const full = fullDomainRef.current;
              const lo = typeof dataMin === "number" && Number.isFinite(dataMin) ? dataMin : full.min;
              const hi = typeof dataMax === "number" && Number.isFinite(dataMax) ? dataMax : full.max;
              return hi > lo ? [lo, hi] : [lo, lo + 60];
            },
          },
          y: {
            range: (_u, dataMin, dataMax) => {
              const lo = dataMin ?? 0;
              const hi = dataMax ?? 1;
              const span = hi - lo;
              const basePad = span !== 0 ? Math.abs(span) : Math.max(Math.abs(lo), Math.abs(hi), 1);
              return [lo - (basePad * 0.05 || 1), hi + (basePad * 0.25 || 1)];
            },
          },
        },
        axes: [
          {
            stroke: "#ffffff",
            width: 1,
            grid: { show: false },
            ticks: { show: true, stroke: "#ffffff", width: 1 },
            font: "12px sans-serif",
            incrs: [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600],
            space: 80,
            side: 2,
            size: 40,
            values: (_u, vals) => vals.map((v) => formatAxisTime(v, tz)),
          },
          {
            stroke: "#ffffff",
            width: 1,
            grid: { show: false },
            ticks: { show: true, stroke: "#ffffff", width: 1 },
            font: "12px sans-serif",
            space: 50,
            side: 3,
            size: 44,
          },
        ],
        cursor: {
          x: false,
          y: false,
          points: { show: false },
          drag: { x: false, y: false, dist: 5, uni: 12, setScale: false },
        },
        select: { show: true, left: 0, top: 0, width: 0, height: 0 },
        legend: { show: false },
        hooks: {
          setScale: [
            (u, key) => {
              if (key !== "x") return;
              const mn = u.scales.x.min;
              const mx = u.scales.x.max;
              if (mn == null || mx == null || !Number.isFinite(mn) || !Number.isFinite(mx) || !(mx > mn)) return;
              xVisibleRangeRef.current = { min: mn, max: mx };
              if (programmaticScale) return;

              const prev = visibleDomainSec() ?? [fullDomainRef.current.min, fullDomainRef.current.max];
              const prevSpan = prev[1] - prev[0];
              const nextSpan = mx - mn;
              const tol = Math.max(1e-3, prevSpan * 0.002);
              const kind: "zoom" | "pan" = Math.abs(nextSpan - prevSpan) <= tol ? "pan" : "zoom";

              programmaticScale = true;
              try {
                for (const inst of instancesRef.current) {
                  if (inst === u) continue;
                  inst.setScale("x", { min: mn, max: mx });
                }
              } finally {
                queueMicrotask(() => {
                  programmaticScale = false;
                });
              }

              syncStoresForVisibleWindow(mn, mx, kind);
            },
          ],
          draw: [
            (u) => {
              const ctx = u.ctx;
              const { left, top, width, height } = u.bbox;
              ctx.save();
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 1;
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(left, top);
              ctx.lineTo(left, top + height);
              ctx.moveTo(left, top + height);
              ctx.lineTo(left + width, top + height);
              ctx.stroke();
              ctx.restore();
            },
            (u) => {
              const state = interactionStateRef.get(u);
              if (!state) return;
              const { top, height, left } = u.bbox;
              const { ctx } = u;
              if ((state.brushWidth ?? 0) > 0 && state.brushLeft != null) {
                ctx.save();
                ctx.fillStyle = "rgba(211, 211, 211, 0.28)";
                ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
                ctx.lineWidth = 1;
                ctx.fillRect(left + state.brushLeft, top, state.brushWidth ?? 0, height);
                ctx.strokeRect(left + state.brushLeft, top, state.brushWidth ?? 0, height);
                ctx.restore();
              }
              if (state.hoverLeft != null) {
                ctx.save();
                ctx.strokeStyle = "rgba(255,255,255,0.95)";
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(left + state.hoverLeft, top);
                ctx.lineTo(left + state.hoverLeft, top + height);
                ctx.stroke();
                ctx.restore();
              }
            },
            (u) => {
              const st = selectedTime();
              if (!(st instanceof Date) || !Number.isFinite(st.getTime())) return;
              const sec = st.getTime() / 1000;
              const x0 = plotXFromTimeSec(u, sec);
              if (!Number.isFinite(x0)) return;
              const { ctx } = u;
              const { top, height } = u.bbox;
              ctx.save();
              ctx.strokeStyle = "rgba(220,50,50,0.95)";
              ctx.lineWidth = 2;
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(x0, top);
              ctx.lineTo(x0, top + height);
              ctx.stroke();
              ctx.restore();
            },
          ],
          ready: [
            (u) => {
              const over = u.root.querySelector(".u-over") as HTMLElement | null;
              if (!over) return;
              const interactionState = { hoverLeft: null, brushLeft: null, brushWidth: null };
              interactionStateRef.set(u, interactionState);
              let activePointerId: number | null = null;
              let dragMoved = false;
              let dragStartClient: { x: number; y: number } | null = null;
              let dragStartLeft: number | null = null;

              const syncCursorToPointer = (clientX: number) => {
                const left = correctedPointerPlotX(over, clientX, u.bbox.width);
                interactionState.hoverLeft = left;
                return left;
              };

              const clearSelection = () => {
                interactionState.brushLeft = null;
                interactionState.brushWidth = null;
              };

              over.addEventListener("pointerdown", (ev: Event) => {
                const pe = ev as PointerEvent;
                activePointerId = pe.pointerId;
                dragStartClient = { x: pe.clientX, y: pe.clientY };
                dragStartLeft = syncCursorToPointer(pe.clientX);
                dragMoved = false;
                clearSelection();
                u.redraw();
                try {
                  over.setPointerCapture(pe.pointerId);
                } catch {
                  /* noop */
                }
              });
              over.addEventListener("pointermove", (ev: Event) => {
                const pe = ev as PointerEvent;
                const left = syncCursorToPointer(pe.clientX);
                if (activePointerId !== pe.pointerId || !dragStartClient || dragStartLeft == null) return;
                if (Math.abs(pe.clientX - dragStartClient.x) > 4 || Math.abs(pe.clientY - dragStartClient.y) > 4) {
                  dragMoved = true;
                }
                if (dragMoved) {
                  interactionState.brushLeft = Math.min(dragStartLeft, left);
                  interactionState.brushWidth = Math.abs(left - dragStartLeft);
                } else {
                  clearSelection();
                }
                u.redraw();
              });
              over.addEventListener("pointerup", (ev: Event) => {
                const pe = ev as PointerEvent;
                if (activePointerId !== pe.pointerId) return;
                const left = syncCursorToPointer(pe.clientX);
                const startClient = dragStartClient;
                const startLeft = dragStartLeft;
                activePointerId = null;
                dragStartClient = null;
                dragStartLeft = null;
                try {
                  over.releasePointerCapture(pe.pointerId);
                } catch {
                  /* noop */
                }
                if (!startClient || startLeft == null) {
                  dragMoved = false;
                  clearSelection();
                  return;
                }
                const dx = Math.abs(pe.clientX - startClient.x);
                if (dragMoved && dx > 6) {
                  const minLeft = Math.min(startLeft, left);
                  const maxLeft = Math.max(startLeft, left);
                  clearAllBrushes();
                  if (maxLeft - minLeft > 1) {
                    const minSec = u.posToVal(minLeft, "x");
                    const maxSec = u.posToVal(maxLeft, "x");
                    if (Number.isFinite(minSec) && Number.isFinite(maxSec) && maxSec > minSec) {
                      applyXAll(minSec, maxSec);
                      syncStoresForVisibleWindow(minSec, maxSec, "zoom");
                    }
                  }
                } else {
                  clearSelection();
                  const tSec = u.posToVal(left, "x");
                  if (Number.isFinite(tSec) && requestTimeControl("timeseries")) {
                    setIsManualTimeChange(true);
                    setSelectedTime(new Date(tSec * 1000), "timeseries");
                  }
                  u.redraw();
                }
                dragMoved = false;
              });
              over.addEventListener("pointercancel", () => {
                activePointerId = null;
                dragStartClient = null;
                dragStartLeft = null;
                dragMoved = false;
                interactionState.hoverLeft = null;
                clearSelection();
                u.redraw();
              });
              over.addEventListener("pointerleave", () => {
                if (activePointerId != null) return;
                interactionState.hoverLeft = null;
                clearSelection();
                u.redraw();
              });
            },
          ],
        },
      };

      try {
        const u = new uPlot(opts, bc.data, wrap);
        wrap.appendChild(legendInner);
        perChartLegendContainersRef.current[idx] = legendInner;
        instancesRef.current.push(u);
        const ro = new ResizeObserver(() => {
          const w = wrap.offsetWidth;
          if (w > 0) {
            try {
              u.setSize({
                width: Math.max(w, 100),
                height: chartHeight + MARGIN.top + MARGIN.bottom,
              });
              u.redraw();
            } catch {
              /* destroyed */
            }
          }
        });
        ro.observe(wrap);
        resizeObserversRef.current.push(ro);
      } catch (e) {
        logError("ExploreTimeSeriesUPlot: uPlot create error", e);
      }
    });

    applyXAll(globalMin, globalMax);
    setVisibleDomainSec([globalMin, globalMax]);

    const sr = selectedRange();
    if (sr && sr.length > 0 && sr[0].start_time && sr[0].end_time) {
      const s0 = new Date(sr[0].start_time).getTime() / 1000;
      const s1 = new Date(sr[0].end_time).getTime() / 1000;
      if (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) {
        const lo = Math.max(s0, globalMin);
        const hi = Math.min(s1, globalMax);
        if (hi > lo) {
          applyXAll(lo, hi);
          syncStoresForVisibleWindow(lo, hi, "zoom");
        } else {
          applyXAll(globalMin, globalMax);
          syncStoresForVisibleWindow(globalMin, globalMax, "reset");
        }
      }
    } else {
      props.onZoomedChange(false);
    }

    wheelHandler = (event: WheelEvent) => {
      if (!rootEl || !rootEl.contains(event.target as Node)) return;
      const u0 = instancesRef.current[0];
      if (!u0) return;
      const min = u0.scales.x.min;
      const max = u0.scales.x.max;
      if (min == null || max == null) return;
      const full = fullDomainRef.current;
      const span = max - min;
      const fullSpan = full.max - full.min;
      const isZoomed = fullSpan > 0 && (span < fullSpan - 0.05 || Math.abs(min - full.min) > 0.05 || Math.abs(max - full.max) > 0.05);
      if (!isZoomed) return;
      event.preventDefault();
      event.stopPropagation();
      const pan = span * 0.1;
      const deltaX = typeof event.deltaX === "number" ? event.deltaX : 0;
      const deltaY = typeof event.deltaY === "number" ? event.deltaY : 0;
      const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      const dir = Math.sign(delta);
      let n0 = min + (dir * pan) / 1;
      let n1 = max + (dir * pan) / 1;
      if (n0 < full.min) {
        const shift = full.min - n0;
        n0 += shift;
        n1 += shift;
      }
      if (n1 > full.max) {
        const shift = n1 - full.max;
        n0 -= shift;
        n1 -= shift;
      }
      if (n0 < full.min) n0 = full.min;
      if (n1 > full.max) n1 = full.max;
      applyXAll(n0, n1);
      syncStoresForVisibleWindow(n0, n1, "pan");
      for (const u of instancesRef.current) u.redraw();
    };
    rootEl.addEventListener("wheel", wheelHandler, { passive: false, capture: true });

    dblClickHandler = (ev: MouseEvent) => {
      if (!rootEl?.contains(ev.target as Node)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      setIsManualTimeChange(false);
      const cuts = cutEvents();
      const cutting = isCut() && Array.isArray(cuts) && cuts.length > 0;
      if (cutting) clearActiveSelection();
      else clearSelection();
      applyXAll(fullDomainRef.current.min, fullDomainRef.current.max);
      syncStoresForVisibleWindow(fullDomainRef.current.min, fullDomainRef.current.max, "reset");
      for (const u of instancesRef.current) u.redraw();
    };
    rootEl.addEventListener("dblclick", dblClickHandler, { capture: true });

    const bridge: ExploreUPlotBridgeRefs = {
      resetZoomToFull: () => {
        applyXAll(fullDomainRef.current.min, fullDomainRef.current.max);
        syncStoresForVisibleWindow(fullDomainRef.current.min, fullDomainRef.current.max, "reset");
        instancesRef.current.forEach((u) => u.redraw());
      },
      redraw: () => {
        instancesRef.current.forEach((u) => {
          try {
            u.redraw();
          } catch {
            /* noop */
          }
        });
      },
      setZoomDomainFromMs: (startMs, endMs, syncSelectionStore = true) => {
        const nextMin = startMs / 1000;
        const nextMax = endMs / 1000;
        const current = instancesRef.current[0];
        const currMin = current?.scales.x.min;
        const currMax = current?.scales.x.max;
        const sameDomain =
          currMin != null &&
          currMax != null &&
          Math.abs(currMin - nextMin) <= 1e-9 &&
          Math.abs(currMax - nextMax) <= 1e-9;
        if (!sameDomain) {
          applyXAll(nextMin, nextMax);
        }
        if (syncSelectionStore) {
          syncStoresForVisibleWindow(nextMin, nextMax, "zoom");
        } else {
          setVisibleDomainSec([nextMin, nextMax]);
        }
        instancesRef.current.forEach((u) => u.redraw());
      },
      getFullDomainMs: () => {
        const f = fullDomainRef.current;
        return [f.min * 1000, f.max * 1000];
      },
      getZoomDomainMs: () => {
        const u0 = instancesRef.current[0];
        if (!u0 || u0.scales.x.min == null || u0.scales.x.max == null) return null;
        return [u0.scales.x.min * 1000, u0.scales.x.max * 1000];
      },
    };
    props.onBridgeReady(bridge);
    refreshPerChartLegends();
  }

  createEffect(
    on(
      () => [props.charts, props.visualEpoch, props.timezone] as const,
      () => {
        queueMicrotask(() => mountPlots());
      }
    )
  );

  createEffect(() => {
    visibleDomainSec();
    builtCharts();
    props.visualEpoch;
    const t = selectedTime();
    void t;
    queueMicrotask(() => refreshPerChartLegends());
    instancesRef.current.forEach((u) => {
      try {
        u.redraw();
      } catch {
        /* noop */
      }
    });
  });

  onMount(() => {
    debug("ExploreTimeSeriesUPlot: mounted");
  });

  onCleanup(() => {
    destroyPlots();
    props.onBridgeReady(null);
  });

  return (
    <div class="explore-uplot-root" ref={(el) => (rootEl = el)}>
      <Show when={builtCharts().length === 0}>
        <div class="explore-uplot-empty">No chart data</div>
      </Show>
    </div>
  );
}
