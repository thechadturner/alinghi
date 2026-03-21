import { onMount, onCleanup, createSignal, createEffect } from "solid-js";
import * as d3 from "d3";

import { themeStore } from "../../store/themeStore";
import { chart as logChart, error as logError, info as logInfo, warn as logWarn, debug as logDebug } from "../../utils/console";
import { persistantStore } from "../../store/persistantStore";
import { selectedTime } from "../../store/playbackStore";
import { config, apiEndpoints } from "../../config/env";
import { unifiedDataAPI } from "../../store/unifiedDataAPI";
import { getCookie, getData, getTimezoneForDate, formatDate, formatTime } from "../../utils/global";

interface MediaSource {
  id: string;
  name?: string;
}

interface MediaWindow {
  id?: string | number;
  start: Date;
  end: Date;
  fileName?: string;
  sourceId?: string;
  /** IANA timezone for this media (from media.timezone). Used for known-time local → UTC conversion. */
  timezone?: string | null;
}

interface BspDataPoint {
  Datetime: string | Date;
  Bsp: number;
}

interface VideoSyncTimeSeriesProps {
  onSelectSource?: (source: { id: string; name: string; fileName?: string }) => void;
  onSelectionChange?: (windows: MediaWindow[]) => void;
  onMediaWindowsChange?: (windows: MediaWindow[]) => void;
  onTimelineClick?: (time: Date) => void;
  /** Called when user double-clicks a timeline bar: (window) => enter full-screen that source, (null) => exit full-screen. */
  onWindowDoubleClick?: (window: MediaWindow | null) => void;
  ref?: (ref: { refreshData: (overrideDateYmd?: string) => Promise<void> }) => void;
  /** Dataset timezone from parent (e.g. VideoSync) so axis and "Time (local)" use the same TZ. */
  datasetTimezone?: string | null;
  /** Date (YYYYMMDD) from parent so timeline loads bars for the same day as the video grid. When set after mount, timeline refetches. */
  initialDateYmd?: string | null;
}

export default function VideoSyncTimeSeries(props: VideoSyncTimeSeriesProps) {
  let containerEl: HTMLElement | null = null;

  // UI state: bottom-sheet expand/contract
  const [isExpanded, setIsExpanded] = createSignal(true); // default expanded
  const showDebug = import.meta?.env?.VITE_VERBOSE === 'true' || import.meta?.env?.VITE_DEBUG_MODE === 'true';

  // Data state
  const [mediaSources, setMediaSources] = createSignal<MediaSource[]>([]); // [{ id, name }]
  const [mediaWindows, setMediaWindows] = createSignal<MediaWindow[]>([]); // [{ sourceId, start:Date, end:Date }]
  const [mapExtent, setMapExtent] = createSignal<[Date, Date] | null>(null); // [Date, Date]
  const [bspSeries, setBspSeries] = createSignal<BspDataPoint[]>([]); // [{Datetime, Bsp}]
  
  // Drag state
  const [draggableWindowId, setDraggableWindowId] = createSignal<string | number | null>(null); // ID of window that can be dragged
  
  // Selection state
  const [selectedWindowId, setSelectedWindowId] = createSignal<string | number | null>(null); // ID of window that is selected (single click)

  // Timezone for x-axis: show local time (dataset/date timezone) like MapTimeSeries, not UTC
  const [chartTimezone, setChartTimezone] = createSignal<string | null>(null);
  createEffect(() => {
    const className = (persistantStore.selectedClassName() || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const projectId = Number(persistantStore.selectedProjectId?.() ?? 0);
    const sd = persistantStore.selectedDate?.();
    const t = selectedTime();
    const dateStr = sd && String(sd).trim() !== ""
      ? String(sd).replace(/-/g, "").slice(0, 8)
      : t
        ? `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`
        : "";
    if (!className || !projectId || dateStr.length < 8) {
      setChartTimezone(null);
      return;
    }
    const dateDisplay = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    getTimezoneForDate(className, projectId, dateDisplay)
      .then((tz) => setChartTimezone(tz))
      .catch(() => setChartTimezone(null));
  });





  // Computed size for SVG area
  function getContainerSize(): { width: number; height: number } {
    if (!containerEl) return { width: 600, height: 200 };
    const parentWidth = containerEl.parentElement ? containerEl.parentElement.clientWidth : containerEl.clientWidth;
    const width = Math.max(parentWidth || 0, 300);
    // Use the actual rendered height of the container (fallback to 200)
    const measured = containerEl.clientHeight || (containerEl.parentElement ? containerEl.parentElement.clientHeight : 0);
    const height = Math.max(measured || 0, 120);
    return { width, height };
  }

  // Helpers
  const toYyyyMmDd = (d: Date): string => {
    try {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`; // local calendar date
    } catch (e) {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    }
  };

  const EPOCH_TIME_MS = new Date("1970-01-01T12:00:00.000Z").getTime();

  /** Date for API (YYYYMMDD): prefer selectedDate; else dataset date when selectedDatasetId and epoch time; else selectedTime in dataset TZ. */
  const getDateYmdForApi = async (): Promise<string> => {
    const sd = persistantStore.selectedDate?.();
    if (sd && String(sd).trim() !== "") {
      const ymd = String(sd).replace(/-/g, "").trim();
      if (ymd.length >= 8) {
        logDebug("VideoSyncTimeSeries: using selectedDate for API", { dateYmd: ymd.slice(0, 8) });
        return ymd.slice(0, 8);
      }
    }
    const t = selectedTime() || new Date();
    const datasetId = Number(persistantStore.selectedDatasetId?.() ?? 0);
    if (datasetId > 0 && t.getTime() === EPOCH_TIME_MS) {
      try {
        const className = (persistantStore.selectedClassName() || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const projectId = String(persistantStore.selectedProjectId?.() ?? "");
        const url = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`;
        const res = await getData(url);
        const raw = res?.data?.date ?? res?.date;
        if (raw) {
          const ymd = String(raw).replace(/-/g, "").trim().slice(0, 8);
          if (ymd.length === 8) {
            logDebug("VideoSyncTimeSeries: using dataset info date for API (selectedTime was epoch)", { dateYmd: ymd, datasetId });
            return ymd;
          }
        }
      } catch (e) {
        logWarn("VideoSyncTimeSeries: dataset info fetch failed, using selectedTime", e);
      }
    }
    const className = (persistantStore.selectedClassName() || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const projectId = Number(persistantStore.selectedProjectId?.() ?? 0);
    const utcYmd = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
    const dateDisplay = utcYmd.slice(0, 4) + "-" + utcYmd.slice(4, 6) + "-" + utcYmd.slice(6, 8);
    try {
      const tz = await getTimezoneForDate(className, projectId, dateDisplay);
      const formatted = formatDate(t, tz);
      if (formatted) {
        const ymd = formatted.replace(/-/g, "");
        logDebug("VideoSyncTimeSeries: date for API from selectedTime in dataset TZ", { timezone: tz, dateYmd: ymd });
        return ymd;
      }
    } catch (e) {
      logWarn("VideoSyncTimeSeries: getTimezoneForDate failed, using UTC date", e);
    }
    return utcYmd;
  };

  // Helpers for adjacent-day fallback (media can be stored under folder date that differs from dataset date, e.g. 20260215)
  function addDayYmd(ymd: string, delta: number): string {
    const y = parseInt(ymd.slice(0, 4), 10);
    const m = parseInt(ymd.slice(4, 6), 10) - 1;
    const d = parseInt(ymd.slice(6, 8), 10);
    const date = new Date(Date.UTC(y, m, d + delta));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  /** Try primary date, then next day, then previous day; return sources and the date that had them. */
  async function fetchMediaSourcesWithFallback(
    className: string,
    projectId: string,
    dateYmd: string
  ): Promise<{ sources: MediaSource[]; dateYmdUsed: string }> {
    const tryDate = async (d: string): Promise<MediaSource[]> => {
      const url = `/api/media/sources?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(d)}`;
      const response = await getData(url);
      if (!response.success || response.data == null) return [];
      const list = Array.isArray(response.data) ? response.data : [];
      return list.map((r: any, i: number) => ({ id: r.id || r.media_source || r.name || `src_${i}`, name: r.name || r.media_source || r.id || `Source ${i + 1}` }));
    };
    let sources = await tryDate(dateYmd);
    let dateYmdUsed = dateYmd;
    if (sources.length === 0) {
      const nextDay = addDayYmd(dateYmd, 1);
      sources = await tryDate(nextDay);
      if (sources.length > 0) {
        dateYmdUsed = nextDay;
        logDebug("VideoSyncTimeSeries: no sources for primary date, using next day", { primary: dateYmd, used: nextDay });
      }
    }
    if (sources.length === 0) {
      const prevDay = addDayYmd(dateYmd, -1);
      sources = await tryDate(prevDay);
      if (sources.length > 0) {
        dateYmdUsed = prevDay;
        logDebug("VideoSyncTimeSeries: no sources for primary date, using previous day", { primary: dateYmd, used: prevDay });
      }
    }
    return { sources, dateYmdUsed };
  }

  async function fetchMediaSources({ className, projectId, dateYmd }: { className: string; projectId: string; dateYmd: string }): Promise<MediaSource[]> {
    const url = `/api/media/sources?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateYmd)}`;
    logDebug(url);
    const response = await getData(url);
    if (!response.success || response.data == null) return [];
    const list = Array.isArray(response.data) ? response.data : [];
    return list.map((r: any, i: number) => ({ id: r.id || r.media_source || r.name || `src_${i}`, name: r.name || r.media_source || r.id || `Source ${i + 1}` }));
  }

  async function fetchMediaForSource({ className, projectId, dateYmd, mediaSource }: { className: string; projectId: string; dateYmd: string; mediaSource: string }): Promise<MediaWindow[]> {
    const url = `/api/media?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateYmd)}&media_source=${encodeURIComponent(mediaSource)}`;
    const response = await getData(url);
    if (!response.success || response.data == null) return [];
    const list = Array.isArray(response.data) ? response.data : [];
    logInfo("VideoSyncTimeSeries: raw API response", {
      mediaSource,
      responseLength: list.length,
      sampleRecord: list[0],
      allRecords: list
    });
    // Records expected to contain start_time/end_time or start/end
    return list
      .map((r) => {
        const start = r.start_time || r.start || r.begin || r.ts_start;
        const end = r.end_time || r.end || r.finish || r.ts_end;
        const startDate = start ? new Date(start) : null;
        const endDate = end ? new Date(end) : null;
        if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) return null;
        const fileName = r.file_name || r.file || r.filename || '';
        const id = r.media_id || r.id || undefined;
        const timezone = r.timezone != null && String(r.timezone).trim() !== '' ? String(r.timezone).trim() : undefined;
        return { start: startDate, end: endDate, fileName, id, timezone };
      })
      .filter(Boolean);
  }

  // Store xScale reference for click handlers
  let currentXScale: any = null;
  let currentPlot: any = null;
  let stableXExtent: [Date, Date] | null = null; // Store stable xExtent to prevent domain shifts
  
  // Track pending single-clicks to cancel them if double-click occurs
  const pendingSingleClicks = new Map<string, ReturnType<typeof setTimeout>>(); // Map<elementId, timeoutId>

  // Main draw routine
  function drawChart() {
    try {
      const { width: cw, height: ch } = getContainerSize();
      logInfo("VideoSyncTimeSeries drawChart start", { hasContainer: !!containerEl, cw, ch });
      const vids = mediaSources();
      const spans = mediaWindows();

      if (!containerEl) {
        d3.select(containerEl).select("svg").remove();
        return;
      }

      // Clear
      d3.select(containerEl).select("svg").remove();

      const { width, height } = getContainerSize();
      try {
        // Let CSS layout determine height; keep width 100%
        containerEl.style.height = '100%';
        containerEl.style.width = '100%';
      } catch {}
      // Expose current VideoSyncTimeSeries height to layout via CSS variable
      try {
        if (document && document.documentElement && typeof height === 'number') {
          document.documentElement.style.setProperty('--videosync-height', `${height}px`);
        }
      } catch {}
      // Use full width since no control panel needed, plus 25px extra
      const availableWidth = Math.max(100, width + 25);
      // Adjusted margins to reserve space for axes
      const margin = { top: 8, right: 10, bottom: 0, left: 135 };
      const chartHeight = height - margin.top - margin.bottom;
      // Make innerHeight a fixed padding from chartHeight to ensure axes fit
      const innerHeight = Math.max(60, chartHeight);
      const plotOffsetY = 0;

      // X-axis domain must be UTC so invert() returns a UTC instant for selectedTime. Media spans from API are UTC.
      const mediaMin = spans.length ? d3.min(spans, d => d.start) : null;
      const mediaMax = spans.length ? d3.max(spans, d => d.end) : null;
      let xExtent: [Date, Date] | null = null;
      if (mediaMin != null && mediaMax != null && !isNaN(mediaMin.getTime()) && !isNaN(mediaMax.getTime())) {
        const pad = Math.max(0, (mediaMax.getTime() - mediaMin.getTime()) * 0.02);
        xExtent = [new Date(mediaMin.getTime() - pad), new Date(mediaMax.getTime() + pad)];
        stableXExtent = xExtent;
      }
      if (!xExtent) {
        xExtent = mapExtent();
        if (xExtent && xExtent[0] && xExtent[1] && !isNaN(+xExtent[0]) && !isNaN(+xExtent[1])) {
          stableXExtent = xExtent;
        } else {
          xExtent = null;
          try {
            const freq = (window && window.mapFrequencyAnalysis) ? window.mapFrequencyAnalysis : null;
            const tr = freq && freq.timeRange ? freq.timeRange : null;
            if (tr && tr.start && tr.end) {
              const start = tr.start instanceof Date ? tr.start : new Date(tr.start);
              const end = tr.end instanceof Date ? tr.end : new Date(tr.end);
              if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
                xExtent = [start, end];
              }
            }
            if (!xExtent) {
              const mapScale = (window && window.chartTimeScale) ? window.chartTimeScale : null;
              if (mapScale && typeof mapScale.domain === 'function') {
                const dom = mapScale.domain();
                if (Array.isArray(dom) && dom[0] && dom[1]) {
                  xExtent = [new Date(dom[0]), new Date(dom[1])];
                }
              }
            }
          } catch {}
          if (!xExtent) {
            const bsp = bspSeries();
            const bspMin = bsp.length ? d3.min(bsp, d => new Date(d.Datetime)) : null;
            const bspMax = bsp.length ? d3.max(bsp, d => new Date(d.Datetime)) : null;
            const parts = [bspMin, bspMax].filter(Boolean) as Date[];
            if (parts.length >= 2) {
              const minAll = new Date(d3.min(parts, d => +d));
              const maxAll = new Date(d3.max(parts, d => +d));
              if (!isNaN(minAll.getTime()) && !isNaN(maxAll.getTime())) xExtent = [minAll, maxAll];
            }
          }
          if (!xExtent) {
            if (stableXExtent) {
              xExtent = stableXExtent;
            } else {
              const center = selectedTime() || new Date();
              xExtent = [new Date(center.getTime() - 30 * 60 * 1000), new Date(center.getTime() + 30 * 60 * 1000)];
              stableXExtent = xExtent;
            }
          } else {
            stableXExtent = xExtent;
          }
        }
      }
      const xScale = d3
        .scaleTime()
        .domain(xExtent)
        .range([0, availableWidth - margin.left - margin.right]);
      
      // Store xScale reference for click handlers
      currentXScale = xScale;

      // Y setup (match innerHeight so y=0 aligns with top of plot and y=max with x-axis)
      const n = Math.max(vids.length, 1);
      const isSingle = vids.length === 1;
      const yScale = d3
        .scaleLinear()
        .domain(isSingle ? [0, 2] : [-0.5, n - 0.5])
        .range([innerHeight, 0]);

      const svg = d3
        .select(containerEl)
        .append("svg")
        .attr("width", availableWidth)
        .attr("height", chartHeight)
        .style("display", "block") 
        .style("overflow", "visible")
        .append("g")
        .attr("transform", `translate(${margin.left}, ${margin.top})`);

      const axisColor = themeStore.isDark() ? "#ffffff" : "#0b0b0b";
      // X-axis: show local time in dataset/date timezone, same as MapTimeSeries (formatTime with timezone).
      const timezone = props.datasetTimezone ?? chartTimezone();
      const xAxis = d3.axisBottom(xScale).ticks(5).tickFormat((d) => {
        if (d instanceof Date) {
          const formatted = formatTime(d, timezone);
          return formatted ?? d.toLocaleTimeString();
        }
        return String(d);
      });
      // Y-axis with media source labels
      const tickValues = isSingle ? [1] : [...Array(n).keys()];
      const labelForIndex = (idx) => {
        try {
          if (isSingle) return (vids[0]?.name || vids[0]?.id || "");
          const safe = Math.max(0, Math.min(n - 1, Math.round(idx)));
          return (vids[safe]?.name || vids[safe]?.id || "");
        } catch {
          return "";
        }
      };
      const yAxis = d3
        .axisLeft(yScale)
        .tickValues(tickValues)
        .tickFormat(labelForIndex);

      // Create a plot group centered vertically
      const plotShiftX = -50;
      const plot = svg.append("g").attr("class", "plot").attr("transform", `translate(${plotShiftX}, ${plotOffsetY})`);
      
      // Store plot reference for click handlers
      currentPlot = plot;

      // X gridlines
      plot
        .append("g")
        .attr("class", "x-grid")
        .attr("transform", `translate(0, ${innerHeight})`)
        .call(d3.axisBottom(xScale).ticks(5).tickSize(-innerHeight).tickFormat(() => ""))
        .call((g) => g.selectAll("line").style("stroke", axisColor).style("stroke-opacity", 0.15).style("shape-rendering", "crispEdges").style("stroke-width", "1px"))
        .call((g) => g.selectAll("path").style("stroke", axisColor).style("stroke-opacity", 0.2).style("stroke-width", "1px").attr("fill", "none"));

      plot
        .append("g")
        .attr("class", "x-axis")
        .attr("transform", `translate(0, ${innerHeight})`)
        .call(xAxis)
        .call((g) => g.attr("style", "shape-rendering:crispEdges"))
        .call((g) => g.selectAll("path, line").style("stroke", axisColor).style("stroke-width", "1px").style("stroke-opacity", 1).attr("vector-effect", "non-scaling-stroke").attr("fill", "none"))
        .call((g) => g.selectAll("text").attr("fill", axisColor).attr("font-size", 10).attr("dy", "0.71em"));

      plot
        .append("g")
        .attr("class", "y-axis")
        .call(yAxis)
        .call((g) => g.attr("style", "shape-rendering:crispEdges"))
        .call((g) => g.selectAll("path, line").style("stroke", axisColor).style("stroke-width", "1px").style("stroke-opacity", 1).attr("vector-effect", "non-scaling-stroke").attr("fill", "none"))
        .call((g) => g.selectAll("text").attr("fill", axisColor).attr("font-size", 9));

      // Color per video source
      const color = d3.scaleOrdinal(d3.schemeSet2).domain(vids.map((v) => v.id));

      // Rect height and vertical placement - thinner when collapsed
      let rowHeight;
      if (isSingle) {
        rowHeight = isExpanded() ? 50 : 24;
      } else {
        rowHeight = Math.max(isExpanded() ? 14 : 8, Math.floor(innerHeight / n) - (isExpanded() ? 6 : 10));
      }

      const sourceIndexById = new Map(vids.map((v, i) => [v.id?.toLowerCase(), i]));

      // Draw rects inside plot space so Y aligns with axes
      const groups = plot.append("g").attr("class", "availability");

      // Store original data for drag calculations
      const originalWindowData = new Map();
      spans.forEach(d => {
        if (d.id) {
          originalWindowData.set(d.id, {
            start: new Date(d.start),
            end: new Date(d.end),
            duration: d.end.getTime() - d.start.getTime()
          });
        }
      });

      const rects = groups
        .selectAll("rect.avail")
        .data(spans, d => d.id || `${d.start}-${d.end}-${d.sourceId}`); // Use key function for proper updates
      
      // Enter: create new rectangles
      const rectsEnter = rects.enter()
        .append("rect")
        .attr("class", "avail");
      
      // Merge enter and update selections
      const rectsMerged = rectsEnter.merge(rects)
        .attr("class", "avail")
        .attr("x", (d) => xScale(d.start))
        .attr("y", (d) => {
          const idx = isSingle ? 1 : (sourceIndexById.get(d.sourceId?.toLowerCase()) ?? 0);
          const yCenter = yScale(idx);
          return yCenter - rowHeight / 2;
        })
        .attr("width", (d) => Math.max(0, xScale(d.end) - xScale(d.start)))
        .attr("height", rowHeight)
        .attr("rx", 3)
        .attr("ry", 3)
        .attr("fill", (d) => color(d.sourceId))
        .attr("opacity", (d) => {
          // Highlight draggable window
          const isDraggable = draggableWindowId() === d.id;
          return isDraggable ? 1 : 0.85;
        })
        .attr("stroke", (d) => {
          const isDraggable = draggableWindowId() === d.id;
          const isSelected = selectedWindowId() === d.id;
          
          // Priority: draggable (yellow) > selected (white) > none
          if (isDraggable) return '#ffd700'; // Yellow/gold for draggable
          if (isSelected) return themeStore.isDark() ? '#ffffff' : '#0b3d91'; // White in dark mode, dark blue in light mode
          return 'none';
        })
        .attr("stroke-width", (d) => {
          const isDraggable = draggableWindowId() === d.id;
          const isSelected = selectedWindowId() === d.id;
          
          if (isDraggable) return 4; // Thicker border for draggable
          if (isSelected) return 2; // Standard border for selected
          return 0;
        })
        .attr("stroke-opacity", (d) => {
          const isDraggable = draggableWindowId() === d.id;
          const isSelected = selectedWindowId() === d.id;
          
          return (isDraggable || isSelected) ? 1 : 0;
        })
        .style("cursor", (d) => {
          const isDraggable = draggableWindowId() === d.id;
          return isDraggable ? "move" : "pointer";
        })
        .style("pointer-events", "all") // Ensure rectangles receive all mouse events
        .on("click", function (event, d) {
          try {
            // Don't stop propagation immediately - let double-click register first
            // We'll handle single-click logic with a delay
            
            // Store references for delayed single-click handling
            const clickTarget = d;
            const rectElement = this;
            const elementId = d.id || `rect_${Date.now()}`;
            
            // Cancel any pending single-click for this element
            if (pendingSingleClicks.has(elementId)) {
              clearTimeout(pendingSingleClicks.get(elementId));
              pendingSingleClicks.delete(elementId);
            }
            
            // Use a timeout to distinguish single-click from double-click
            // Double-click fires immediately, so we delay single-click processing
            const timeoutId = setTimeout(() => {
              // Remove from pending map
              pendingSingleClicks.delete(elementId);
              
              // Now stop propagation for single-click
              event.stopPropagation();
              
              // Process as single-click - DO NOT set selectedTime, only handle selection
              // Toggle selection for this window
              const currentSelected = selectedWindowId();
              if (currentSelected === clickTarget.id) {
                // Deselect if clicking the same window
                setSelectedWindowId(null);
                logInfo('VideoSyncTimeSeries: Deselected window', clickTarget.id);
              } else {
                // Select this window (draggable state will be cleared by selectedTime change effect)
                setSelectedWindowId(clickTarget.id);
                logInfo('VideoSyncTimeSeries: Selected window', clickTarget.id);
                
                // Raise to top for visibility
                try {
                  rectElement.parentNode.appendChild(rectElement);
                } catch (e) {}
              }
              
              // Map sourceId to source name and notify parent
              const sources = mediaSources();
              const match = sources.find((s) => s.id?.toLowerCase() === clickTarget.sourceId?.toLowerCase());
              const name = match?.name || match?.id || String(clickTarget.sourceId);
              if (props && typeof props.onSelectSource === 'function') {
                props.onSelectSource({ id: clickTarget.sourceId, name, fileName: clickTarget.fileName });
              }
              
              // Notify parent of selection change
              if (props && typeof props.onSelectionChange === 'function') {
                const selectedId = selectedWindowId();
                const selectedWindows = selectedId ? [mediaWindows().find(w => w.id === selectedId)].filter(Boolean) : [];
                props.onSelectionChange(selectedWindows);
              }
              
              // Force immediate redraw to show visual feedback
              setTimeout(() => drawChart(), 0);
            }, 300); // Wait 300ms to allow double-click to fire first
            
            // Store timeout ID so we can cancel it on double-click
            pendingSingleClicks.set(elementId, timeoutId);
          } catch (e) {
            logWarn('VideoSyncTimeSeries: click handler error', e);
          }
        })
        .on("dblclick", function (event, d) {
          try {
            logDebug('VideoSyncTimeSeries: Double-click event fired!', { id: d?.id, event });
            
            // Stop all event propagation immediately
            event.stopPropagation();
            event.preventDefault();
            if (event.stopImmediatePropagation) {
              event.stopImmediatePropagation();
            }
            
            // Cancel any pending single-click for this element
            const elementId = d.id || `rect_${Date.now()}`;
            if (pendingSingleClicks.has(elementId)) {
              clearTimeout(pendingSingleClicks.get(elementId));
              pendingSingleClicks.delete(elementId);
            }
            
            logInfo('VideoSyncTimeSeries: Double-click detected on rectangle', { id: d.id, fileName: d.fileName });
            
            // Toggle draggable state for this window
            if (!d.id) {
              logWarn('VideoSyncTimeSeries: Cannot make window draggable - missing ID', d);
              return;
            }
            
            const currentDraggable = draggableWindowId();
            if (currentDraggable === d.id) {
              setDraggableWindowId(null);
              draggableJustSet = false;
              logInfo('VideoSyncTimeSeries: Deactivated dragging for window', d.id);
              props.onWindowDoubleClick?.(null);
            } else {
              draggableJustSet = true; // Mark that we just set draggable state
              setDraggableWindowId(d.id);
              setSelectedWindowId(null);
              logInfo('VideoSyncTimeSeries: Activated dragging for window', d.id);
              props.onWindowDoubleClick?.(d);
              try {
                this.parentNode.appendChild(this);
              } catch (e) {}
            }
            
            // Redraw to apply drag behavior and visual feedback
            setTimeout(() => drawChart(), 0);
          } catch (e) {
            logError('VideoSyncTimeSeries: double-click handler error', e);
          }
        });
      
      // Exit: remove rectangles that no longer exist
      rects.exit().remove();

      // Create drag behavior (will only be attached to draggable rectangles)
      const drag = d3.drag()
        .on("start", function(event, d) {
          logInfo('VideoSyncTimeSeries: Drag started for window', d.id);
          d3.select(this).attr("opacity", 0.7);
          
          // Store original position
          if (!originalWindowData.has(d.id)) {
            originalWindowData.set(d.id, {
              start: new Date(d.start),
              end: new Date(d.end),
              duration: d.end.getTime() - d.start.getTime()
            });
          }
          
          event.sourceEvent?.stopPropagation();
        })
        .on("drag", function(event, d) {
          event.sourceEvent?.preventDefault();
          
          // Calculate new start time based on mouse X position relative to plot group
          const [mouseX] = d3.pointer(event, plot.node());
          const newStartTime = xScale.invert(mouseX);
          
          // Get original duration
          const original = originalWindowData.get(d.id);
          if (!original) {
            logWarn('VideoSyncTimeSeries: No original data for window', d.id);
            return;
          }
          
          // Calculate new end time maintaining duration
          const newEndTime = new Date(newStartTime.getTime() + original.duration);
          
          // Update rectangle position visually
          const newX = xScale(newStartTime);
          d3.select(this)
            .attr("x", newX)
            .attr("width", Math.max(0, xScale(newEndTime) - newX));
          
          // Update the data bound to this element (for visual feedback only)
          d.start = newStartTime;
          d.end = newEndTime;
        })
        .on("end", async function(event, d) {
          // Only process if this window was being dragged
          if (draggableWindowId() !== d.id || !d.id) {
            return;
          }
          
          logInfo('VideoSyncTimeSeries: Drag ended for window', d.id);
          d3.select(this).attr("opacity", 1);
          
          // Get original duration
          const original = originalWindowData.get(d.id);
          if (!original) {
            logWarn('VideoSyncTimeSeries: No original data for window on drag end', d.id);
            return;
          }
          
          // Use the updated start time from the data (updated during drag)
          const finalStartTime = new Date(d.start);
          const finalEndTime = new Date(d.end);
          
          // Ensure duration is maintained
          const actualDuration = finalEndTime.getTime() - finalStartTime.getTime();
          if (Math.abs(actualDuration - original.duration) > 1000) {
            // Duration changed significantly, recalculate end time
            const correctedEndTime = new Date(finalStartTime.getTime() + original.duration);
            finalEndTime.setTime(correctedEndTime.getTime());
          }
          
          logInfo('VideoSyncTimeSeries: Updating media window', {
            id: d.id,
            oldStart: original.start.toISOString(),
            oldEnd: original.end.toISOString(),
            newStart: finalStartTime.toISOString(),
            newEnd: finalEndTime.toISOString()
          });
          
          // Update via API
          try {
            const className = (persistantStore.selectedClassName() || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
            const projectId = persistantStore.selectedProjectId();
            
            if (!className || !projectId) {
              throw new Error('Missing className or projectId');
            }
            
            // Get CSRF token for the request
            const csrfToken = getCookie('csrf_token') || '';
            
            // Always use relative URL - nginx handles routing
            const mediaUrl = '/api/admin/media';
            const response = await fetch(mediaUrl, {
              method: 'PUT',
              credentials: 'include',
              headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
              },
              body: JSON.stringify({
                class_name: className,
                project_id: projectId,
                media_id: Number(d.id),
                start_time: finalStartTime.toISOString(),
                end_time: finalEndTime.toISOString()
              })
            });
            
            if (!response.ok) {
              const errorText = await response.text().catch(() => '');
              throw new Error(`Failed to update media ${d.id}: ${response.status} ${errorText}`);
            }
            
            logInfo('VideoSyncTimeSeries: Successfully updated media window', d.id, {
              oldStart: original.start.toISOString(),
              oldEnd: original.end.toISOString(),
              newStart: finalStartTime.toISOString(),
              newEnd: finalEndTime.toISOString()
            });
            
            // Create new Date objects to ensure they're fresh
            const newStart = new Date(finalStartTime);
            const newEnd = new Date(finalEndTime);
            
            // Update local state with new Date objects
            const updatedWindows = mediaWindows().map(w => {
              if (w.id === d.id) {
                return {
                  ...w,
                  start: newStart,
                  end: newEnd
                };
              }
              return w;
            });
            
            // Update the originalWindowData map to reflect the new position
            // This ensures future drags use the correct baseline
            originalWindowData.set(d.id, {
              start: newStart,
              end: newEnd,
              duration: newEnd.getTime() - newStart.getTime()
            });
            
            logInfo('VideoSyncTimeSeries: Updating state with new window position', {
              id: d.id,
              newStart: newStart.toISOString(),
              newEnd: newEnd.toISOString(),
              windowsCount: updatedWindows.length
            });
            
            // Update state - the reactive effect will handle redrawing
            setMediaWindows(updatedWindows);
            
            // Notify parent of updated windows
            if (props && typeof props.onMediaWindowsChange === 'function') {
              props.onMediaWindowsChange(updatedWindows);
            }
            
            // Refresh media files cache so Video component gets updated start/end times
            // This ensures video lookup uses the new start/end times after drag
            try {
              const { mediaFilesService } = await import('../../services/mediaFilesService');
              const sourceId = d.sourceId || mediaSources()?.[0]?.id;
              if (sourceId) {
                // Clear and refresh cache for this source and date
                await mediaFilesService.refreshCache(sourceId, newStart);
                logInfo('VideoSyncTimeSeries: Refreshed media files cache after drag', { 
                  sourceId, 
                  date: newStart.toISOString(),
                  mediaId: d.id
                });
              } else {
                logWarn('VideoSyncTimeSeries: Cannot refresh cache - missing sourceId', { 
                  sourceId: d.sourceId,
                  availableSources: mediaSources().map(s => s.id)
                });
              }
            } catch (error) {
              logWarn('VideoSyncTimeSeries: Failed to refresh media files cache', error);
            }
            
            // The reactive effect watching mediaWindows() will automatically call drawChart()
            // But we also call it here to ensure immediate visual feedback
            // Use requestAnimationFrame to batch the verification and avoid setTimeout handler warnings
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                // Verify the update persisted (double RAF to ensure state has propagated)
                const currentWindows = mediaWindows();
                const updatedWindow = currentWindows.find(w => w.id === d.id);
                if (updatedWindow) {
                  const currentStart = new Date(updatedWindow.start).getTime();
                  const currentEnd = new Date(updatedWindow.end).getTime();
                  const expectedStart = newStart.getTime();
                  const expectedEnd = newEnd.getTime();
                  
                  if (Math.abs(currentStart - expectedStart) > 1000 || Math.abs(currentEnd - expectedEnd) > 1000) {
                    logWarn('VideoSyncTimeSeries: State reverted unexpectedly, forcing update', {
                      expected: { start: expectedStart, end: expectedEnd },
                      actual: { start: currentStart, end: currentEnd }
                    });
                    // Force update again
                    const forceUpdated = currentWindows.map(w => {
                      if (w.id === d.id) {
                        return { ...w, start: newStart, end: newEnd };
                      }
                      return w;
                    });
                    setMediaWindows(forceUpdated);
                  } else {
                    logInfo('VideoSyncTimeSeries: State update confirmed, position persisted');
                  }
                }
              });
            });
            
          } catch (error) {
            logError('VideoSyncTimeSeries: Error updating media window', error);
            // Revert local state on error
            const revertedWindows = mediaWindows().map(w => {
              if (w.id === d.id) {
                return {
                  ...w,
                  start: new Date(original.start),
                  end: new Date(original.end)
                };
              }
              return w;
            });
            setMediaWindows(revertedWindows);
            // Redraw to show original position
            drawChart();
          }
        });

      // Only attach drag behavior to the rectangle that is currently draggable
      // This prevents drag from consuming events on other rectangles
      const currentDraggableId = draggableWindowId();
      if (currentDraggableId) {
        rectsMerged.filter(d => d.id === currentDraggableId).call(drag);
      }

      // Hover effects: highlight on mouseover, restore on mouseout
      rectsMerged
        .on("mouseover", function () {
          try { d3.select(this).attr("opacity", 1); } catch {}
        })
        .on("mouseout", function () {
          try { d3.select(this).attr("opacity", 0.85); } catch {}
        });

      // Native tooltip via SVG <title>
      rectsMerged.selectAll("title").data(d => [d]).enter().append("title").text(d => d.fileName ? String(d.fileName) : `${d.start.toISOString()} — ${d.end.toISOString()}`);
      rectsMerged.selectAll("title").text(d => d.fileName ? String(d.fileName) : `${d.start.toISOString()} — ${d.end.toISOString()}`);


      // Labels inside rectangles
      // Removed labels for minimal timeline

      // Overlay BSP timeseries line with secondary y-scale (no extra axis)
      const bsp = bspSeries();
      if (bsp && bsp.length > 0) {
        const bspValues = bsp.map(d => +d.Bsp).filter(v => Number.isFinite(v));
        const yMin = d3.min(bspValues);
        const yMax = d3.max(bspValues);
        if (Number.isFinite(yMin) && Number.isFinite(yMax) && yMax > yMin) {
          const yScaleBsp = d3.scaleLinear().domain([yMin, yMax]).range([innerHeight, 0]);
          const bspColor = themeStore.isDark() ? "#ffffff" : "#0b3d91";
          const lineGen = d3.line()
            .x(d => xScale(new Date(d.Datetime)))
            .y(d => yScaleBsp(+d.Bsp))
            .defined(d => {
              const t = new Date(d.Datetime);
              const v = +d.Bsp;
              return !isNaN(t) && Number.isFinite(v);
            });
          plot.append("path")
            .datum(bsp)
            .attr("class", "bsp-line")
            .attr("fill", "none")
            .attr("stroke", bspColor)
            .attr("stroke-opacity", 0.5)
            .attr("stroke-width", 1)
            .attr("d", lineGen);
        }
      }

      // Ensure rectangles render on top of chart data and timeline click area
      try { groups.raise(); } catch {}

      // SelectedTime: highlight rect whose window contains the selected time first
      const currentSelected = selectedTime();
      if (currentSelected) {
        const xPos = xScale(currentSelected);

        // Highlight the rect whose window contains the selected time
        // BUT preserve draggable window styling (yellow border takes priority)
        try {
          const currentDraggableId = draggableWindowId();
          
          rects
            .attr('opacity', (d) => {
              // Draggable windows always have opacity 1
              if (currentDraggableId === d.id) return 1;
              return 0.85;
            })
            .classed('active-window', false);

          const currentSelectedId = selectedWindowId();
          
          const activeWindows = rects.filter(d => {
            // Don't override styling for draggable or manually selected window
            if (currentDraggableId === d.id || currentSelectedId === d.id) return false;
            return currentSelected >= d.start && currentSelected <= d.end;
          });
          
          activeWindows
            .attr('stroke', (d) => {
              // Don't override draggable or selected window stroke
              if (currentDraggableId === d.id) return '#ffd700';
              if (currentSelectedId === d.id) return themeStore.isDark() ? '#ffffff' : '#0b3d91';
              return themeStore.isDark() ? '#ffffff' : '#0b3d91';
            })
            .attr('stroke-width', (d) => {
              // Don't override draggable or selected window stroke width
              if (currentDraggableId === d.id) return 4;
              if (currentSelectedId === d.id) return 2;
              return 2;
            })
            .attr('opacity', 1)
            .classed('active-window', true)
            .each(function() { try { this.parentNode.appendChild(this); } catch {} });
          
          // Ensure selected window is also raised to top (but below draggable)
          if (currentSelectedId && currentSelectedId !== currentDraggableId) {
            const selectedRect = rects.filter(d => d.id === currentSelectedId);
            selectedRect.each(function() {
              try {
                this.parentNode.appendChild(this);
                logInfo('VideoSyncTimeSeries: Ensuring selected rectangle is on top', currentSelectedId);
              } catch {}
            });
          }
          
          // Ensure draggable window is always on top
          if (currentDraggableId) {
            const draggableRect = rects.filter(d => d.id === currentDraggableId);
            draggableRect.each(function() {
              try {
                this.parentNode.appendChild(this);
                logInfo('VideoSyncTimeSeries: Ensuring draggable rectangle is on top', currentDraggableId);
              } catch {}
            });
          }

          // Notify parent of the currently active window(s) based on selectedTime
          if (props && typeof props.onSelectionChange === 'function') {
            const activeWindowsData = activeWindows.data();
            logInfo("VideoSyncTimeSeries: active window changed based on selectedTime", { 
              selectedTime: currentSelected.toISOString(),
              activeWindowsCount: activeWindowsData.length,
              activeWindows: activeWindowsData.map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId }))
            });
            props.onSelectionChange(activeWindowsData);
          }
        } catch {}
      }

      // Add clickable timeline area for setting selectedTime (behind rectangles)
      // This must be added BEFORE rectangles are raised to ensure rectangles are on top
      const timelineArea = plot.insert("rect", ":first-child")
        .attr("class", "timeline-click-area")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", availableWidth - margin.left - margin.right)
        .attr("height", innerHeight)
        .attr("fill", "transparent")
        .attr("opacity", 0)
        .style("cursor", "crosshair")
        .style("pointer-events", "auto")
        .on("click", function(event) {
          try {
            // Only handle click if it's not on a rectangle
            const target = event.target;
            if (target && target.classList && target.classList.contains('avail')) {
              return; // Let rectangle handle it
            }
            logInfo("VideoSyncTimeSeries: timeline area clicked (not rectangle)");
            
            // Clear selection and draggable state when clicking on timeline background
            setSelectedWindowId(null);
            setDraggableWindowId(null);
            
            // Notify parent that selection was cleared
            if (props && typeof props.onSelectionChange === 'function') {
              props.onSelectionChange([]);
            }
            
            // Get mouse position relative to the plot group (same as drag handler)
            // Use the stored references to ensure we're using the current scale
            if (!currentPlot || !currentXScale) {
              logWarn('VideoSyncTimeSeries: Missing plot or xScale reference for timeline click');
              return;
            }
            const [mouseX] = d3.pointer(event, currentPlot.node());
            const clickedTime = currentXScale.invert(mouseX);
            // Scale domain is UTC (media windows / backend data), so invert() is a UTC instant. Pass same instant to parent.
            const utcInstant = clickedTime instanceof Date ? new Date(clickedTime.getTime()) : new Date(clickedTime);
            logInfo('VideoSyncTimeSeries: Timeline click calculated', {
              mouseX,
              clickedTime: utcInstant.toISOString(),
              xScaleDomain: currentXScale.domain().map(d => d.toISOString()),
              xScaleRange: currentXScale.range()
            });
            if (props && typeof props.onTimelineClick === 'function') {
              props.onTimelineClick(utcInstant);
            }
            
            // Force redraw to clear borders
            setTimeout(() => drawChart(), 0);
          } catch (e) {
            logWarn('VideoSyncTimeSeries: timeline click handler error', e);
          }
        })
        .on("dblclick", function(event) {
          // Only handle double-click if it's NOT on a rectangle
          const target = event.target;
          if (target && target.classList && target.classList.contains('avail')) {
            // This is a rectangle double-click - let it handle it by not stopping propagation
            logDebug('VideoSyncTimeSeries: Timeline area detected rectangle double-click, allowing it through');
            return; // Don't stop propagation - let rectangle handle it
          }
          // Prevent double-click on timeline area from interfering with rectangles
          event.stopPropagation();
          logInfo('VideoSyncTimeSeries: Timeline area double-clicked (ignored)');
        });
      
      // Ensure rectangles are on top of timeline click area
      try { groups.raise(); } catch {}

      // Draw selected-time line and triangle on top of rects (full visible height, red, 2px)
      // Line extends from top (y=0) to visible bottom (chartHeight - margin.top) so it is not clipped
      const currentSelectedForLine = selectedTime();
      if (currentSelectedForLine) {
        const xPosLine = xScale(currentSelectedForLine);
        const triangleSize = 6;
        const lineBottom = chartHeight - margin.top;
        plot.append("line")
          .attr("class", "selected-time-line")
          .attr("x1", xPosLine)
          .attr("x2", xPosLine)
          .attr("y1", 0)
          .attr("y2", lineBottom)
          .attr("stroke", "#e11")
          .attr("stroke-width", 2)
          .attr("opacity", 1)
          .style("pointer-events", "none");
        plot.append("polygon")
          .attr("class", "selected-time-line-triangle")
          .attr("points", `${xPosLine},0 ${xPosLine - triangleSize},${triangleSize * 2} ${xPosLine + triangleSize},${triangleSize * 2}`)
          .attr("fill", "#e11")
          .attr("stroke", "none")
          .style("pointer-events", "none");
      }
      
      // Ensure axes render above rectangles
      try {
        plot.select(".x-axis").raise();
        plot.select(".y-axis").raise();
      } catch {}

      logChart("VideoSyncTimeSeries chart drawn", { width: availableWidth, height, xExtent: xExtent?.map(d=>d?.toISOString?.()||d), sources: n, windows: spans.length });
    } catch (err) {
      logError("VideoSyncTimeSeries drawChart error", err);
    }
  }

  function handleResize() {
    drawChart();
  }

  // Track if draggable state was just set by double-click (to prevent immediate clearing)
  let draggableJustSet = false;
  
  // Clear draggable state whenever selectedTime changes (from external sources like timeline click)
  // But NOT immediately after double-click sets it
  let lastSelectedTime = selectedTime();
  createEffect(() => {
    const currentTime = selectedTime();
    const currentDraggable = draggableWindowId();
    
    // Only clear if selectedTime actually changed AND we have a draggable window
    // AND it wasn't just set by a double-click
    if (currentTime && currentDraggable && 
        currentTime.getTime() !== lastSelectedTime?.getTime() && 
        !draggableJustSet) {
      logInfo('VideoSyncTimeSeries: Clearing draggable state - selectedTime changed externally', {
        selectedTime: currentTime.toISOString(),
        previousDraggable: currentDraggable
      });
      setDraggableWindowId(null);
    }
    
    // Reset the flag after a short delay
    if (draggableJustSet) {
      setTimeout(() => { draggableJustSet = false; }, 200);
    }
    
    lastSelectedTime = currentTime;
  });

  // Auto-select video window when selectedTime changes (if not manually selected)
  createEffect(() => {
    const currentTime = selectedTime();
    const windows = mediaWindows();
    const currentSelected = selectedWindowId();
    
    // Only auto-select if there's no manual selection and we have a valid time
    if (!currentTime || windows.length === 0) return;
    
    // Find the window that contains the current selectedTime
    const containingWindow = windows.find(w => {
      if (!w.start || !w.end || !w.id) return false;
      const start = new Date(w.start).getTime();
      const end = new Date(w.end).getTime();
      const time = currentTime.getTime();
      return time >= start && time <= end;
    });
    
    if (containingWindow && containingWindow.id) {
      // Only auto-select if:
      // 1. No window is currently selected, OR
      // 2. The currently selected window doesn't contain the selectedTime
      const shouldAutoSelect = !currentSelected || 
        (currentSelected !== containingWindow.id && 
         !windows.find(w => w.id === currentSelected && 
           new Date(w.start).getTime() <= currentTime.getTime() && 
           new Date(w.end).getTime() >= currentTime.getTime()));
      
      if (shouldAutoSelect) {
        logInfo('VideoSyncTimeSeries: Auto-selecting window for selectedTime', {
          selectedTime: currentTime.toISOString(),
          windowId: containingWindow.id,
          currentSelected
        });
        setSelectedWindowId(containingWindow.id);
        
        // Notify parent of selection change
        if (props && typeof props.onSelectionChange === 'function') {
          props.onSelectionChange([containingWindow]);
        }
      }
    } else if (currentSelected) {
      // No window contains this time, but we have a selection
      // Check if the selected window still contains the time
      const selectedWindow = windows.find(w => w.id === currentSelected);
      if (selectedWindow) {
        const start = new Date(selectedWindow.start).getTime();
        const end = new Date(selectedWindow.end).getTime();
        const time = currentTime.getTime();
        if (time < start || time > end) {
          // Selected window no longer contains the time - clear selection
          logInfo('VideoSyncTimeSeries: Clearing selection - selectedTime outside window', {
            selectedTime: currentTime.toISOString(),
            windowStart: selectedWindow.start?.toISOString(),
            windowEnd: selectedWindow.end?.toISOString()
          });
          setSelectedWindowId(null);
          if (props && typeof props.onSelectionChange === 'function') {
            props.onSelectionChange([]);
          }
        }
      }
    }
  });

  // SolidJS reactive redraws when state changes
  createEffect(() => {
    // Re-run when sources/windows update or theme/expand or chart timezone (local time axis) changes
    const _s = mediaSources();
    const _w = mediaWindows();
    const _theme = themeStore.theme();
    const _expanded = isExpanded();
    const _sel = selectedTime();
    const _draggable = draggableWindowId(); // React to draggable state changes
    const _selected = selectedWindowId(); // React to selection state changes
    const _tz = props.datasetTimezone ?? chartTimezone(); // Redraw when timezone resolves so axis shows local time
    if (!containerEl) return;
    drawChart();
  });

  // Notify parent when media windows change
  createEffect(() => {
    const windows = mediaWindows();
    if (windows.length > 0 && props && typeof props.onMediaWindowsChange === 'function') {
      logInfo("VideoSyncTimeSeries: reactive effect - notifying parent of media windows", { 
        totalWindows: windows.length,
        windows: windows.map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId }))
      });
      props.onMediaWindowsChange(windows);
    }
  });

  // Click handlers for expand/contract
  function handleClick(e: MouseEvent) {
    // Single click: no action (expand/collapse via double-click only)
  }

  function handleDblClick(e: MouseEvent) {
    // Double click toggles expand/collapse
    setIsExpanded((prev) => !prev);
    drawChart();
  }

  // Expose refresh method to parent; optional overrideDateYmd uses same date as video grid when provided.
  const refreshData = async (overrideDateYmd?: string) => {
    logInfo("VideoSyncTimeSeries: refreshData called", overrideDateYmd ? { overrideDateYmd } : {});
    try {
      const className = (persistantStore.selectedClassName() || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const projectId = String(persistantStore.selectedProjectId() || '');
      const datasetId = String(persistantStore.selectedDatasetId?.() || '');
      const sourceName = String(persistantStore.selectedSourceName?.() || '');
      const dateYmd = overrideDateYmd && overrideDateYmd.length >= 8 ? overrideDateYmd.slice(0, 8) : await getDateYmdForApi();

      if (!className || !projectId) {
        logWarn("VideoSyncTimeSeries: missing className or projectId; cannot refresh");
        return;
      }

      // Re-fetch media sources (try adjacent days if primary date has no media) and windows
      const { sources: vids, dateYmdUsed } = await fetchMediaSourcesWithFallback(className, projectId, dateYmd);
      setMediaSources(vids);

      const results = await Promise.allSettled(
        vids.map((s) => fetchMediaForSource({ className, projectId, dateYmd: dateYmdUsed, mediaSource: s.id }))
      );

      const allWindows = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          r.value.forEach((w) => allWindows.push({ sourceId: vids[i].id, ...w }));
        }
      });
      setMediaWindows(allWindows);

      // Notify parent of updated media windows
      if (props && typeof props.onMediaWindowsChange === 'function') {
        props.onMediaWindowsChange(allWindows);
      }

      drawChart();
    } catch (err) {
      logError("VideoSyncTimeSeries refreshData error", err);
    }
  };

  // Expose refresh method to parent via ref
  if (props.ref) {
    props.ref({ refreshData });
  }

  // Cleanup: register synchronously in component body so Solid can run it on dispose (fixes "cleanups created outside createRoot" warning)
  onCleanup(() => {
    window.removeEventListener("resize", handleResize);
    try { if (containerEl?.__ro) (containerEl as any).__ro.disconnect?.(); } catch {}
    if (containerEl) d3.select(containerEl).select("svg").remove();
    try { document?.documentElement?.style?.removeProperty?.("--videosync-height"); } catch {}
  });

  // When parent passes initialDateYmd after mount (e.g. VideoSync finished loading), refetch so timeline shows bars.
  createEffect(() => {
    const dateYmd = props.initialDateYmd;
    if (!dateYmd || dateYmd.length < 8) return;
    const windows = mediaWindows();
    if (windows.length > 0) return; // Already have bars
    logInfo("VideoSyncTimeSeries: initialDateYmd from parent, refetching for timeline bars", { dateYmd });
    refreshData(dateYmd.slice(0, 8));
  });

  // Initial load
  onMount(async () => {
    try {
      logInfo("VideoSyncTimeSeries mount: starting");
      // Render a baseline timeline immediately (uses selectedTime fallback)
      drawChart();
      logInfo("VideoSyncTimeSeries mount: loading media sources and windows");

      const className = (persistantStore.selectedClassName() || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const projectId = String(persistantStore.selectedProjectId() || '');
      const datasetId = String(persistantStore.selectedDatasetId?.() || '');
      const sourceName = String(persistantStore.selectedSourceName?.() || '');
      // Use parent's date when provided so timeline matches video grid (avoids no bars when selectedTime was epoch on mount).
      const dateYmd = (props.initialDateYmd && props.initialDateYmd.length >= 8)
        ? props.initialDateYmd.slice(0, 8)
        : await getDateYmdForApi();
      logDebug("VideoSyncTimeSeries: date for API (local in UI, UTC/dataset date in backend)", { dateYmd, fromParent: !!props.initialDateYmd });

      if (!className || !projectId) {
        logWarn("VideoSyncTimeSeries: missing className or projectId; cannot fetch media");
        setMediaSources([]);
        setMediaWindows([]);
        drawChart();
      } else {
        // Try to compute map min/max using unified data API (map_data)
        try {
          const { data } = await unifiedDataAPI.getDataByChannels(["Datetime"], {
            projectId,
            className,
            datasetId,
            sourceName,
            date: dateYmd,
            dataTypes: ["map_data"]
          });
          if (Array.isArray(data) && data.length > 0) {
            const minD = new Date(d3.min(data, d => new Date(d.Datetime)));
            const maxD = new Date(d3.max(data, d => new Date(d.Datetime)));
            if (!isNaN(minD) && !isNaN(maxD)) setMapExtent([minD, maxD]);
          }
        } catch (e) {
          logWarn("VideoSyncTimeSeries: map min/max query failed", e?.message || e);
        }

        // Resolve dataset/date timezone for API and for x-axis (local time like MapTimeSeries)
        const dateDisplay = dateYmd.slice(0, 4) + "-" + dateYmd.slice(4, 6) + "-" + dateYmd.slice(6, 8);
        let resolvedTz: string | null = null;
        try {
          resolvedTz = await getTimezoneForDate(className, Number(projectId), dateDisplay);
          setChartTimezone(resolvedTz);
        } catch {}

        // Fetch BSP timeseries (Datetime, Bsp) with timezone for local display
        try {
          const { data: ts } = await unifiedDataAPI.getDataByChannels(["Datetime", "Bsp"], {
            projectId,
            className,
            datasetId,
            sourceName,
            date: dateYmd,
            timezone: resolvedTz || "UTC"
          });
          if (Array.isArray(ts) && ts.length > 0) {
            // Normalize datetimes to ISO strings
            const cleaned = ts.map(d => ({ Datetime: d.Datetime, Bsp: d.Bsp })).filter(d => d.Datetime != null && d.Bsp != null);
            setBspSeries(cleaned);
          } else {
            setBspSeries([]);
          }
        } catch (e) {
          logWarn("VideoSyncTimeSeries: BSP timeseries fetch failed", e?.message || e);
          setBspSeries([]);
        }

        const { sources: vids, dateYmdUsed } = await fetchMediaSourcesWithFallback(className, projectId, dateYmd);
        logDebug("VideoSyncTimeSeries: media sources", { count: vids.length, dateYmdUsed, primaryDate: dateYmd });
        setMediaSources(vids);

        // Fetch media windows for each source using the date that had sources (may be adjacent day)
        const results = await Promise.allSettled(
          vids.map((s) => fetchMediaForSource({ className, projectId, dateYmd: dateYmdUsed, mediaSource: s.id }))
        );

        logDebug("vids", vids)

        const allWindows = [];
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            r.value.forEach((w) => allWindows.push({ sourceId: vids[i].id, ...w }));
          } else {
            logWarn("VideoSyncTimeSeries: media fetch failed for source", { source: vids[i]?.id, reason: r.reason?.message || r.reason });
          }
        });
        logInfo("VideoSyncTimeSeries: loaded media windows", { 
          totalWindows: allWindows.length,
          windowsWithIds: allWindows.filter(w => w.id).length,
          sampleWindows: allWindows.slice(0, 3).map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId })),
          allWindows: allWindows
        });
        setMediaWindows(allWindows);

        // Notify parent of all media windows for use in VideoSyncHelper
        if (props && typeof props.onMediaWindowsChange === 'function') {
          logInfo("VideoSyncTimeSeries: notifying parent of media windows", { 
            totalWindows: allWindows.length,
            windows: allWindows.map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId }))
          });
          props.onMediaWindowsChange(allWindows);
        }

        drawChart();
      }

      window.addEventListener("resize", handleResize);

      // Observe parent/container size changes for responsive width
      try {
        if (window.ResizeObserver && containerEl && containerEl.parentElement) {
          const ro = new ResizeObserver(() => handleResize());
          ro.observe(containerEl.parentElement);
          (containerEl as any).__ro = ro;
        }
      } catch {}
    } catch (err) {
      logError("VideoSyncTimeSeries init error", err);
    }
  });

  return (
    <div 
      class="video-sync-timeseries w-full chart-container"
      ref={(el) => (containerEl = el)}
      style={`position: relative; height: 100%; width: 100%; z-index: 500; background: var(--color-bg-card); border-top: 1px solid var(--color-border-primary);`}
      onDblClick={handleDblClick}
    >
      {showDebug && (
        <div style="position:absolute; right:8px; top:8px; font-size:11px; opacity:0.7; pointer-events:none;">
          VideoSyncTimeSeries
        </div>
      )}
    </div>
  );
}


