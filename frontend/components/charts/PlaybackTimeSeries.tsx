/**
 * PlaybackTimeSeries — Canvas-based time series for animated playback only.
 * Read-only: displays data around the playback store's selectedTime and timeWindow.
 * Uses uPlot for efficient rendering; no brush/zoom/selection.
 */
import { onMount, onCleanup, createEffect, createMemo, createSignal, For, Show, on } from "solid-js";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { smoothPlaybackTimeForTrack, selectedTime, timeWindow, isPlaying } from "../../store/playbackStore";
import { getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";
import { debug } from "../../utils/console";

const CHART_HEIGHT = 300;
/** Extra px of chart height per series when series count exceeds this */
const CHART_EXTRA_HEIGHT_AFTER_SERIES = 8;
const LEGEND_TABLE_ROW_HEIGHT = 24;
const MARGIN = { top: 25, right: 25, bottom: 25, left: 45 };
/** End of visible window is selectedTime + this (e.g. 10s so selected time is 10s from the end) */
const PLAYBACK_WINDOW_LEAD_MS = 10_000;
const CLOSEST_POINT_THRESHOLD_MS = 30_000;
/** Max ms from selected time to show a value in the legend "Sel" column */
const LEGEND_TABLE_TIME_THRESHOLD_MS = 30_000;

type ChartSeries = {
  color?: string;
  label?: string;
  yaxis?: { name?: string };
  data: Array<{ x: Date | number; y: number | null }>;
};

type ChartConfig = {
  chart?: string;
  series: ChartSeries[];
};

export interface PlaybackTimeSeriesProps {
  charts: ChartConfig[];
  timeWindowMinutes: number;
  /** Current playback time; pass from parent so the chart updates when parent re-renders. */
  selectedTime?: Date | null;
}

function toUnixSeconds(d: Date | number): number {
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return ms / 1000;
}

function toMs(d: Date | number): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

/** Binary search: index of last point with x <= t, or -1 */
function indexAtOrBefore(data: Array<{ x: Date | number }>, tMs: number): number {
  let lo = 0;
  let hi = data.length - 1;
  if (hi < 0 || toMs(data[0].x) > tMs) return -1;
  if (toMs(data[hi].x) <= tMs) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (toMs(data[mid].x) <= tMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Closest point to tMs in sorted data; null if beyond threshold */
function closestPoint(
  data: Array<{ x: Date | number; y: number | null }>,
  tMs: number,
  thresholdMs: number
): number | null {
  const i = indexAtOrBefore(data, tMs);
  if (i < 0) {
    if (data.length === 0) return null;
    const d = toMs(data[0].x);
    return Math.abs(d - tMs) <= thresholdMs ? Number(data[0].y) : null;
  }
  const a = data[i];
  const aMs = toMs(a.x);
  const ya = a.y != null && Number.isFinite(Number(a.y)) ? Number(a.y) : null;
  if (i === data.length - 1) {
    return Math.abs(aMs - tMs) <= thresholdMs ? ya : null;
  }
  const b = data[i + 1];
  const bMs = toMs(b.x);
  const yb = b.y != null && Number.isFinite(Number(b.y)) ? Number(b.y) : null;
  const da = Math.abs(aMs - tMs);
  const db = Math.abs(bMs - tMs);
  const best = da <= db ? (da <= thresholdMs ? ya : null) : db <= thresholdMs ? yb : null;
  return best;
}

function buildAlignedData(chart: ChartConfig): {
  data: uPlot.AlignedData;
  seriesMeta: { label: string; color: string }[];
} {
  const seriesList = chart.series ?? [];
  const allTimeMs = new Set<number>();
  for (const s of seriesList) {
    for (const p of s.data || []) {
      const t = toMs(p.x);
      if (Number.isFinite(t)) allTimeMs.add(t);
    }
  }
  const timesMs = Array.from(allTimeMs).sort((a, b) => a - b);
  if (timesMs.length === 0) {
    return {
      data: [[], ...seriesList.map(() => [])],
      seriesMeta: seriesList.map((s) => ({
        label: s.label ?? s.yaxis?.name ?? "Series",
        color: s.color ?? "#1f77b4",
      })),
    };
  }

  const xSeconds = timesMs.map((t) => t / 1000);
  const seriesMeta: { label: string; color: string }[] = [];
  const yColumns: (number | null)[][] = [];

  for (const s of seriesList) {
    seriesMeta.push({
      label: s.label ?? s.yaxis?.name ?? "Series",
      color: s.color ?? "#1f77b4",
    });
    const sorted = [...(s.data || [])].sort((a, b) => toMs(a.x) - toMs(b.x));
    const ys = timesMs.map((t) => closestPoint(sorted, t, CLOSEST_POINT_THRESHOLD_MS));
    yColumns.push(ys);
  }

  const data: uPlot.AlignedData = [xSeconds, ...yColumns];
  return { data, seriesMeta };
}

/** Filter aligned data to points within [startSec, endSec]; only the filtered slice is drawn. */
function filterAlignedDataToWindow(
  fullData: uPlot.AlignedData,
  startSec: number,
  endSec: number
): uPlot.AlignedData {
  if (!fullData?.length || !Array.isArray(fullData[0])) {
    const numSeries = Math.max(0, (fullData?.length ?? 1) - 1);
    const emptyX = [startSec, endSec];
    return [emptyX, ...Array.from({ length: numSeries }, () => [null, null])] as uPlot.AlignedData;
  }
  const xArr = fullData[0] as number[];
  const numSeries = fullData.length - 1;
  if (xArr.length === 0) {
    const emptyX = [startSec, endSec];
    return [emptyX, ...Array.from({ length: numSeries }, () => [null, null])] as uPlot.AlignedData;
  }
  const indices: number[] = [];
  for (let i = 0; i < xArr.length; i++) {
    const x = xArr[i];
    if (x >= startSec && x <= endSec) indices.push(i);
  }
  if (indices.length === 0) {
    const emptyX = [startSec, endSec];
    return [emptyX, ...Array.from({ length: numSeries }, () => [null, null])] as uPlot.AlignedData;
  }
  const filteredX = indices.map((i) => xArr[i]);
  const filteredSeries = fullData.slice(1).map((series) => {
    const arr = Array.isArray(series) ? (series as (number | null)[]) : [];
    return indices.map((i) => (i >= 0 && i < arr.length ? arr[i] : null));
  });
  return [filteredX, ...filteredSeries] as uPlot.AlignedData;
}

function chartHeightForSeriesCount(seriesCount: number): number {
  const extra = Math.max(0, seriesCount - CHART_EXTRA_HEIGHT_AFTER_SERIES);
  return CHART_HEIGHT + extra * LEGEND_TABLE_ROW_HEIGHT;
}

function formatTime(seconds: number, tz: string | null): string {
  const d = new Date(seconds * 1000);
  if (tz) {
    try {
      return d.toLocaleTimeString(undefined, { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return d.toISOString().slice(11, 19);
    }
  }
  return d.toISOString().slice(11, 19);
}

function legendTableFormatStat(val: number | undefined | null): string {
  if (val === undefined || val === null || Number.isNaN(val) || !Number.isFinite(val)) return "—";
  return String(Number(Math.round(val * 100) / 100));
}

type PlaybackLegendRow = {
  teamName: string;
  color: string;
  selected: string;
  avg: string;
  min: string;
  max: string;
  std: string;
};

function computePlaybackLegendRows(
  chart: ChartConfig,
  currentTimeMs: number,
  timeWindowMinutes: number
): PlaybackLegendRow[] {
  if (!chart.series?.length) return [];
  const windowMs = timeWindowMinutes * 60 * 1000;
  const windowEnd = currentTimeMs + PLAYBACK_WINDOW_LEAD_MS;
  const windowStart = windowEnd - windowMs;
  const seenTeamNames = new Set<string>();
  return chart.series
    .map((series) => {
      const data = series.data || [];
      const inWindow = data.filter((d) => {
        const t = toMs(d.x);
        return t >= windowStart && t <= windowEnd;
      });
      const validY = inWindow
        .filter((d) => d.y != null && !Number.isNaN(Number(d.y)) && Number.isFinite(Number(d.y)))
        .map((d) => Number(d.y));
      const n = validY.length;
      const min = n > 0 ? Math.min(...validY) : undefined;
      const max = n > 0 ? Math.max(...validY) : undefined;
      const avg = n > 0 ? validY.reduce((a, b) => a + b, 0) / n : undefined;
      const std =
        n > 0 && avg != null
          ? Math.sqrt(validY.reduce((s, y) => s + (y - avg) ** 2, 0) / n)
          : undefined;
      let selected = "—";
      if (currentTimeMs > 0 && data.length > 0) {
        const closest = data.reduce((prev, curr) => {
          const pt = toMs(prev.x);
          const ct = toMs(curr.x);
          return Math.abs(ct - currentTimeMs) < Math.abs(pt - currentTimeMs) ? curr : prev;
        });
        const ct = toMs(closest.x);
        if (
          Math.abs(ct - currentTimeMs) <= LEGEND_TABLE_TIME_THRESHOLD_MS &&
          closest.y != null &&
          Number.isFinite(Number(closest.y))
        ) {
          selected = legendTableFormatStat(Number(closest.y));
        }
      }
      const channelName = series.yaxis?.name ?? series.label ?? "Series";
      const dashIdx = String(channelName).indexOf(" - ");
      const teamName = dashIdx >= 0 ? String(channelName).slice(dashIdx + 3).trim() : String(channelName);
      return {
        teamName,
        color: series.color ?? "#1f77b4",
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

function PlaybackLegendTable(props: {
  chart: ChartConfig;
  getCurrentTimeMs: () => number;
  getTimeWindowMinutes: () => number;
}) {
  const rows = createMemo(() =>
    computePlaybackLegendRows(props.chart, props.getCurrentTimeMs(), props.getTimeWindowMinutes())
  );
  return (
    <table class="timeseries-legend-table">
      <thead>
        <tr>
          <th>Series</th>
          <th>Sel</th>
          <th>Avg</th>
          <th>Min</th>
          <th>Max</th>
          <th>Std</th>
        </tr>
      </thead>
      <tbody>
        <For each={rows()} fallback={null}>
          {(row) => (
            <tr>
              <td>
                <span class="timeseries-legend-swatch" style={{ "background-color": row.color }} />
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
  );
}

export default function PlaybackTimeSeries(props: PlaybackTimeSeriesProps) {
  const charts = () => props.charts ?? [];
  const timeWindowMin = () => props.timeWindowMinutes ?? 0;

  const builtCharts = createMemo(() => {
    const list = charts();
    return list.map((chart) => buildAlignedData(chart));
  });

  let containerRef: HTMLDivElement | null = null;
  let applyScaleRafId: number | null = null;
  const xWindowRef = { min: 0, max: 0 };
  /** Full aligned data per chart, set once at init; never overwritten with filtered data. */
  const fullAlignedDataRef: { current: uPlot.AlignedData[] | null } = { current: null };
  const [chartExtents, setChartExtents] = createSignal<{ u: uPlot; minX: number; maxX: number; chartIndex: number }[]>([]);
  /** Plot bbox as fraction of chart width (0–1), per chart index. Used so playhead overlay matches x-axis. */
  const [plotFrac, setPlotFrac] = createSignal<Record<number, { left: number; width: number }>>({});

  // Local signal for playback time (ms). Updated from store effect and from playbackStoreUpdate
  // event so the scale effect reliably re-runs when selectedTime changes (same-window or
  // cross-window), even if the store's sync signal doesn't trigger Solid reactivity.
  const [playbackTimeMs, setPlaybackTimeMs] = createSignal(0);

  // Sync from store so same-window selectedTime changes trigger updates
  createEffect(() => {
    const t = selectedTime();
    const ref = smoothPlaybackTimeForTrack();
    const ms = (ref instanceof Date && Number.isFinite(ref.getTime()) ? ref.getTime() : 0) ||
      (t instanceof Date && Number.isFinite(t.getTime()) ? t.getTime() : 0);
    setPlaybackTimeMs(ms);
  });

  onMount(() => {
    const onTimeChange = (e: Event) => {
      const ev = e as CustomEvent;
      const d = ev.detail?.selectedTime;
      if (d == null) return;
      const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
      if (Number.isFinite(ms)) setPlaybackTimeMs(ms);
    };
    window.addEventListener("playbackStoreUpdate", onTimeChange as EventListener);
    window.addEventListener("playbackSelectedTimeChange", onTimeChange as EventListener);
    onCleanup(() => {
      window.removeEventListener("playbackStoreUpdate", onTimeChange as EventListener);
      window.removeEventListener("playbackSelectedTimeChange", onTimeChange as EventListener);
    });
  });

  const resizeObserversRef: { current: ResizeObserver[] } = { current: [] };

  onMount(() => {
    if (!containerRef || charts().length === 0) return;

    const chartDivs = containerRef.querySelectorAll(".playback-timeseries-chart");
    if (chartDivs.length === 0) return;

    const tz = getCurrentDatasetTimezone();

    requestAnimationFrame(() => {
      if (!containerRef) return;

      const built = builtCharts();
      fullAlignedDataRef.current = built.map((b) =>
        b.data.map((series) => (series as number[]).slice()) as uPlot.AlignedData
      ) as uPlot.AlignedData[];

      built.forEach((builtChart, idx) => {
        const el = chartDivs[idx] as HTMLElement;
        const fullData = fullAlignedDataRef.current?.[idx] ?? (builtChart.data as uPlot.AlignedData);
        const xArrForCheck = fullData?.[0];
        const hasX = Array.isArray(xArrForCheck) && (xArrForCheck as number[]).length > 0;
        if (!el || !fullData?.length || !hasX) return;
        if (builtChart.seriesMeta.length === 0) return;

      const seriesCount = builtChart.seriesMeta.length;
      const computedHeight = chartHeightForSeriesCount(seriesCount);
      const chartWidth = Math.max(el.offsetWidth || 400, 100);
      const chartHeight = Math.max(el.offsetHeight || computedHeight, 100);

        const xArr = fullData[0] as number[];
        const minX = xArr[0];
        const maxX = xArr[xArr.length - 1];
        const windowMinSec = timeWindowMin() * 60;
        const refTime = props.selectedTime ?? selectedTime();
        const refSec =
          refTime instanceof Date && Number.isFinite(refTime.getTime())
            ? refTime.getTime() / 1000
            : minX;
        const endSec = refSec + PLAYBACK_WINDOW_LEAD_MS / 1000;
        const startSec = endSec - windowMinSec;
        xWindowRef.min = startSec;
        xWindowRef.max = endSec > startSec ? endSec : startSec + 60;
        const initialFiltered = filterAlignedDataToWindow(fullData, startSec, endSec);

      const opts: uPlot.Options = {
        width: chartWidth,
        height: chartHeight,
          series: [
            { label: "Time" },
            ...builtChart.seriesMeta.map((m) => ({
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
              range: (u, dataMin, dataMax) => {
                const min = xWindowRef.min;
                const max = xWindowRef.max;
                if (max > min) return [min, max];
                const dMin = dataMin ?? min;
                const dMax = dataMax ?? min + 60;
                return [dMin, dMax > dMin ? dMax : dMin + 60];
              },
            },
            y: {
              range: (u, dataMin, dataMax) => {
                const min = dataMin ?? 0;
                const max = dataMax ?? 100;
                const pad = (max - min) * 0.05 || 1;
                return [min - pad, max + pad];
              },
            },
          },
          axes: [
            {
              stroke: "#fff",
              width: 1,
              font: "12px sans-serif",
              grid: { show: false },
              ticks: { show: true },
              incrs: [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600],
              values: (u, vals) => vals.map((v) => formatTime(v, tz)),
              space: 80,
              side: 2,
              size: 40,
            },
            {
              stroke: "#fff",
              width: 1,
              grid: { show: false },
              ticks: { show: true },
              space: 45,
              side: 3,
              size: 45,
            },
          ],
          cursor: {
            lock: true,
            x: true,
            y: false,
            points: { show: false },
            bind: {
              mousedown: () => null,
              mouseup: () => null,
              click: () => null,
              dblclick: () => null,
            },
          },
          select: { show: false },
          legend: { show: false },
          hooks: {
            draw: [
              (u) => {
                const channelOnly = (s: string) => {
                  const dash = s.indexOf(" - ");
                  return dash >= 0 ? s.slice(0, dash).trim() : s;
                };
                const channelLabels = [...new Set(builtChart.seriesMeta.map((m) => channelOnly(m.label)))].filter(Boolean);
                if (channelLabels.length === 0) return;
                const ctx = u.ctx;
                const { left, top } = u.bbox;
                const lineHeight = 14;
                ctx.save();
                ctx.fillStyle = "#fff";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "left";
                ctx.textBaseline = "top";
                channelLabels.forEach((label, i) => {
                  ctx.fillText(label, left + 15, top + 10 + i * lineHeight);
                });
                ctx.restore();
              },
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
              const full = u.ctx.canvas?.width ?? u.bbox.left + u.bbox.width;
              const left = full > 0 ? u.bbox.left / full : 0;
              const width = full > 0 ? u.bbox.width / full : 1;
              setPlotFrac((prev) => ({ ...prev, [idx]: { left, width } }));
            },
            ],
          },
        };

        try {
          const u = new uPlot(opts, initialFiltered, el);
          const xMin = startSec;
          const xMax = endSec > startSec ? endSec : startSec + 60;
          u.setScale("x", { min: xMin, max: xMax });
          u.redraw();

        const ro = new ResizeObserver(() => {
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          if (w > 0 && h > 0) {
            try {
              u.setSize({ width: w, height: h });
              u.redraw();
            } catch (_) {
              // chart may be destroyed
            }
          }
        });
        ro.observe(el);
        resizeObserversRef.current.push(ro);

        setChartExtents((prev) => [...prev, { u, minX, maxX, chartIndex: idx }]);
      } catch (e) {
        debug("PlaybackTimeSeries: uPlot create error", e);
      }
    });
    });
  });

  // On selectedTime or timeWindow change: re-filter full data to new window, setData, setScale, redraw.
  createEffect(
    on(
      () => {
        const propTime = props.selectedTime;
        const storeTime = selectedTime();
        const timeMs =
          (propTime instanceof Date && Number.isFinite(propTime.getTime()) ? propTime.getTime() : 0) ||
          playbackTimeMs() ||
          (storeTime instanceof Date && Number.isFinite(storeTime.getTime()) ? storeTime.getTime() : 0);
        const win = timeWindowMin();
        const extentsLen = chartExtents().length;
        return [timeMs, win, extentsLen] as const;
      },
      ([timeMs, win, extentsLen]) => {
        if (!(win > 0) || extentsLen === 0) return;
        if (timeMs === 0) return;
        const windowMs = win * 60 * 1000;
        const windowEnd = timeMs + PLAYBACK_WINDOW_LEAD_MS;
        const windowStart = windowEnd - windowMs;
        const startSec = windowStart / 1000;
        const endSec = windowEnd / 1000;

        if (applyScaleRafId != null) {
          cancelAnimationFrame(applyScaleRafId);
          applyScaleRafId = null;
        }
        applyScaleRafId = requestAnimationFrame(() => {
          applyScaleRafId = null;
          const extents = chartExtents();
          const fullDataList = fullAlignedDataRef.current;
          if (extents.length === 0 || !fullDataList?.length) return;
          xWindowRef.min = startSec;
          xWindowRef.max = endSec > startSec ? endSec : startSec + 60;
          extents.forEach((ext) => {
            const fullData = fullDataList[ext.chartIndex];
            if (!fullData) return;
            try {
              const filtered = filterAlignedDataToWindow(fullData, startSec, endSec);
              ext.u.setData(filtered);
              const xMax = endSec > startSec ? endSec : startSec + 60;
              ext.u.setScale("x", { min: startSec, max: xMax });
              ext.u.redraw();
            } catch (_) {
              // ignore if destroyed
            }
          });
        });
      },
      { defer: false }
    )
  );

  onCleanup(() => {
    if (applyScaleRafId != null) {
      cancelAnimationFrame(applyScaleRafId);
      applyScaleRafId = null;
    }
    resizeObserversRef.current.forEach((ro) => ro.disconnect());
    resizeObserversRef.current = [];
    chartExtents().forEach(({ u }) => {
      try {
        u.destroy();
      } catch (_) { }
    });
    setChartExtents([]);
  });

  const getCurrentTimeMs = () => {
    const t = props.selectedTime;
    const store = selectedTime();
    return (t instanceof Date && Number.isFinite(t.getTime()) ? t.getTime() : 0) ||
      playbackTimeMs() ||
      (store instanceof Date && Number.isFinite(store.getTime()) ? store.getTime() : 0);
  };

  return (
    <div class="playback-timeseries playback-timeseries-container timeseries-with-legend" ref={(el) => (containerRef = el)}>
      <For each={charts()}>
        {(chart, i) => {
          const seriesCount = chart.series?.length ?? 0;
          const heightPx = chartHeightForSeriesCount(seriesCount);
          const time = () => smoothPlaybackTimeForTrack() ?? selectedTime();
          const windowMin = () => timeWindowMin() * 60;
          const playheadLeftPercent = createMemo(() => {
            const t = time();
            if (!(t instanceof Date) || !Number.isFinite(t.getTime())) return null;
            const tSec = t.getTime() / 1000;
            const endSec = tSec + PLAYBACK_WINDOW_LEAD_MS / 1000;
            const startSec = endSec - windowMin();
            const range = endSec - startSec;
            if (range <= 0) return null;
            const frac = Math.max(0, Math.min(1, (tSec - startSec) / range));
            const box = plotFrac()[i()];
            if (!box) return null;
            const leftPct = (box.left + frac * box.width) * 100;
            return leftPct;
          });
          return (
            <div class="timeseries-chart-and-table-pair">
              <div
                class="playback-chart-wrapper"
                style={{
                  position: "relative",
                  flex: "1 1 auto",
                  "min-width": "0",
                  "min-height": `${heightPx}px`,
                  height: `${heightPx}px`,
                }}
              >
                <div
                  class="playback-timeseries-chart time-series-single-chart"
                  data-chart-index={i()}
                  style={{ "min-height": `${heightPx}px`, height: `${heightPx}px`, width: "100%" }}
                />
                <Show when={playheadLeftPercent() != null}>
                  <div
                    class="playback-playhead-line"
                    role="presentation"
                    style={{
                      position: "absolute",
                      left: `${playheadLeftPercent()!}%`,
                      top: 0,
                      bottom: 0,
                      width: "2px",
                      background: "#e11",
                      "pointer-events": "none",
                      "z-index": 1,
                      "box-sizing": "border-box",
                    }}
                  />
                </Show>
              </div>
              <div class="timeseries-legend-tables">
                <PlaybackLegendTable
                  chart={chart}
                  getCurrentTimeMs={getCurrentTimeMs}
                  getTimeWindowMinutes={timeWindowMin}
                />
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
