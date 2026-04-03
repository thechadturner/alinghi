import { createSignal, createEffect, onMount, Show, For, createMemo } from "solid-js";
import { user } from "../../../store/userStore";
import { persistantStore } from "../../../store/persistantStore";
import { unifiedDataStore } from "../../../store/unifiedDataStore";
import { selectedTime, timeWindow, isPlaying } from "../../../store/playbackStore";
import { sourcesStore } from "../../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { getData, getTimezoneForDate } from "../../../utils/global";
import { debug, error as logError } from "../../../utils/console";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

const defaultFleetTableChannels = (): string[] => [
  defaultChannelsStore.bspName(),
  defaultChannelsStore.twsName(),
];

const FLEET_DATATABLE_OBJECT = "fleet_datatable";
const TOP_OFFSET = 70;

function hexToRgba(hex: string, alpha: number): string {
  if (!hex) return `rgba(255, 255, 255, ${alpha})`;
  if (hex.startsWith("#")) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (hex.startsWith("rgba")) return hex.replace(/[\d.]+\)$/g, `${alpha})`);
  if (hex.startsWith("rgb")) return hex.replace("rgb", "rgba").replace(")", `, ${alpha})`);
  return hex;
}

function getSidebarWidth(): number {
  if (typeof window === "undefined") return 0;
  if (window.innerWidth <= 1000) return 0;
  const sidebar = document.querySelector(".sidebar:not(.mobile)");
  if (sidebar) return sidebar.classList.contains("collapsed") ? 64 : 275;
  return 0;
}

/** Relative luminance (0–1). Used to detect dark colors for glow styling. */
function getLuminance(color: string | null): number | null {
  if (!color || typeof color !== "string") return null;
  const t = color.trim();
  let r = 0, g = 0, b = 0;
  if (t.startsWith("#")) {
    const hex = t.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16) / 255;
      g = parseInt(hex[1] + hex[1], 16) / 255;
      b = parseInt(hex[2] + hex[2], 16) / 255;
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16) / 255;
      g = parseInt(hex.slice(2, 4), 16) / 255;
      b = parseInt(hex.slice(4, 6), 16) / 255;
    } else return null;
  } else if (t.startsWith("rgb")) {
    const m = t.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    r = Number(m[1]) / 255;
    g = Number(m[2]) / 255;
    b = Number(m[3]) / 255;
  } else return null;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** True if color is dark (low luminance). Glow style is applied only for dark team colors. */
function isDarkColor(color: string | null): boolean {
  const L = getLuminance(color);
  return L != null && L < 0.45;
}

function getTimeMs(d: any): number {
  const dt = d.Datetime ?? d.timestamp ?? d.time ?? d.datetime;
  if (dt == null) return NaN;
  const t = typeof dt === "number" ? dt : new Date(dt).getTime();
  return isNaN(t) ? NaN : t;
}

/** Resolve channel key from row (case-insensitive) so API keys match config channel names. */
function getChannelKey(row: any, channelName: string): string | null {
  if (!row || !channelName) return null;
  const chLower = channelName.toLowerCase();
  const key = Object.keys(row).find((k) => k.toLowerCase() === chLower);
  return key ?? null;
}

/** Convert selectedTime (Date or ISO string) to milliseconds. Returns 0 if invalid. */
function timeToMs(t: Date | string | null | undefined): number {
  if (t == null) return 0;
  if (typeof t?.getTime === "function") return (t as Date).getTime();
  if (typeof t === "string" && t) {
    const ms = new Date(t).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** If timeMs is 0 or out of range, return a fallback time from data (first row) so the table can show values. */
function effectiveTimeMs(timeMs: number, data: any[]): number {
  if (Number.isFinite(timeMs) && timeMs > 0) return timeMs;
  if (!data?.length) return timeMs;
  const first = data[0];
  const ms = getTimeMs(first);
  return Number.isFinite(ms) ? ms : timeMs;
}

function valueAtTime(data: any[], channelName: string, timeMs: number): number | null {
  if (!data?.length) return null;
  const withKey = data.filter((r) => {
    const key = getChannelKey(r, channelName);
    if (!key) return false;
    const v = r[key];
    return v != null && !Number.isNaN(Number(v));
  });
  if (!withKey.length) return null;
  const effectiveMs = effectiveTimeMs(timeMs, data);
  let best: any = withKey[0];
  let bestDiff = Math.abs(getTimeMs(best) - effectiveMs);
  for (let i = 1; i < withKey.length; i++) {
    const diff = Math.abs(getTimeMs(withKey[i]) - effectiveMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = withKey[i];
    }
  }
  const key = getChannelKey(best, channelName);
  if (!key) return null;
  const v = Number(best[key]);
  return Number.isFinite(v) ? v : null;
}

function averageInWindow(data: any[], channelName: string, startMs: number, endMs: number): number | null {
  if (!data?.length) return null;
  const inWindow = data.filter((r) => {
    const t = getTimeMs(r);
    if (!Number.isFinite(t) || t < startMs || t > endMs) return false;
    const key = getChannelKey(r, channelName);
    if (!key) return false;
    const v = r[key];
    return v != null && !Number.isNaN(Number(v));
  });
  if (!inWindow.length) return null;
  const sum = inWindow.reduce((acc, r) => {
    const key = getChannelKey(r, channelName);
    return acc + (key != null ? Number(r[key]) : 0);
  }, 0);
  return sum / inWindow.length;
}

function standardDeviationInWindow(data: any[], channelName: string, startMs: number, endMs: number): number | null {
  if (!data?.length) return null;
  const inWindow = data.filter((r) => {
    const t = getTimeMs(r);
    if (!Number.isFinite(t) || t < startMs || t > endMs) return false;
    const key = getChannelKey(r, channelName);
    if (!key) return false;
    const v = r[key];
    return v != null && !Number.isNaN(Number(v));
  });
  if (inWindow.length < 2) return null;
  const values = inWindow.map((r) => {
    const key = getChannelKey(r, channelName);
    return key != null ? Number(r[key]) : 0;
  });
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  return Number.isFinite(std) ? std : null;
}

export interface FleetDataTableConfig {
  channels: string[];
  backgroundColor: string;
  opacity: number;
  position: { x: number; y: number };
  /** "vertical" = sources as rows, channels as columns (expected default); "horizontal" = sources as columns, channels as rows */
  orientation?: "horizontal" | "vertical";
}

export interface FleetDataTableProps {
  /** Set of source IDs to show, or accessor so the table reacts when selection changes. */
  selectedSourceIds: Set<number> | (() => Set<number>);
  objectName?: string;
  /**
   * @deprecated Not used for loading. FleetDataTable must retrieve data from the API (timeseries) only—not from map cache—so the full channel set is available (same as Overlay). Kept for backward compatibility with MapContainer.
   */
  cachedMapData?: () => any[];
}

export default function FleetDataTable(props: FleetDataTableProps) {
  const objectName = () => props.objectName ?? FLEET_DATATABLE_OBJECT;
  const [config, setConfig] = createSignal<FleetDataTableConfig | null>(null);
  const [sourceRows, setSourceRows] = createSignal<Array<{ source_id: number; source_name: string; dataset_id: number }>>([]);
  const [dataBySource, setDataBySource] = createSignal<Record<number, any[]>>({});
  const [tablePosition, setTablePosition] = createSignal<{ x: number; y: number }>({ x: 50, y: 50 });
  const [isLoadingTable, setIsLoadingTable] = createSignal(false);
  let containerRef: HTMLDivElement | null = null;
  let lastLoadedLogKey: string = "";
  let draggableAttached = false;

  // Load overlay config from fleet_map parent (fleet map data table overlays), not "overlay"
  createEffect(async () => {
    const u = user();
    if (!u?.user_id) return;
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    if (!className || !projectId) return;
    try {
      const url = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&user_id=${encodeURIComponent(u.user_id)}&parent_name=fleet_map&object_name=${encodeURIComponent(objectName())}`;
      const response: any = await getData(url);
      if (!response?.success || !response?.data) {
        setConfig(null);
        return;
      }
      const chart =
        response.data.chart_info?.[0] ??
        (Array.isArray(response.data.chart_info) ? null : response.data);
      if (!chart) {
        setConfig(null);
        return;
      }
      const overlayType = (chart.overlayType || "").toLowerCase().replace(/\s/g, "");
      const isFleetDataTable =
        overlayType === "fleetdatatable" ||
        overlayType === "fleet" ||
        objectName() === FLEET_DATATABLE_OBJECT;
      const series = chart.series ?? [];
      const hasChannels = series.some((s: any) => s?.channel?.name ?? s?.name);
      if (!isFleetDataTable && !(objectName() === FLEET_DATATABLE_OBJECT && hasChannels)) {
        setConfig(null);
        return;
      }
      const channels = series.map((s: any) => s?.channel?.name ?? s?.name).filter(Boolean);
      const chartPosition =
        chart.position && typeof chart.position.x === "number" && typeof chart.position.y === "number"
          ? chart.position
          : { x: 50, y: 50 };
      const storageKey = `overlay_position_${objectName()}`;
      let finalPosition = chartPosition;
      // 1) Prefer user settings (API), then localStorage (legacy)
      const savedFromSettings = persistantStore.overlayPositions()[objectName()];
      if (
        savedFromSettings?.position &&
        typeof savedFromSettings.position.x === "number" &&
        typeof savedFromSettings.position.y === "number" &&
        savedFromSettings.position.x >= 0 &&
        savedFromSettings.position.x <= 100 &&
        savedFromSettings.position.y >= 0 &&
        savedFromSettings.position.y <= 100
      ) {
        finalPosition = savedFromSettings.position;
      } else {
        try {
          const saved = localStorage.getItem(storageKey);
          if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed?.position && typeof parsed.position.x === "number" && typeof parsed.position.y === "number") {
              finalPosition = parsed.position;
            }
          }
        } catch {
          // use chartPosition
        }
      }
      setTablePosition(finalPosition);
      const orientation =
        (chart.orientation || "vertical").toString().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
      setConfig({
        channels: channels.length ? channels : defaultFleetTableChannels(),
        backgroundColor: chart.backgroundColor ?? "#FFFFFF",
        opacity: typeof chart.opacity === "number" ? chart.opacity : 1,
        position: finalPosition,
        orientation,
      });
      debug("FleetDataTable: overlay config loaded (parent_name=fleet_map)", { objectName: objectName(), orientation, channels: channels.length ? channels : "(fallback)", fromChart: chart.orientation });
    } catch (e) {
      logError("FleetDataTable: Failed to load overlay config", e as Error);
      setConfig(null);
    }
  });

  // In-memory store only: always fetch from API (timeseries), not from map cache—same philosophy as Overlay (full channel set e.g. Twa_n_deg). No HuniDB.
  // Read context first so effect re-runs when store hydrates (e.g. after page load); otherwise table stays empty until user changes selection.
  createEffect(async () => {
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    const date = persistantStore.selectedDate?.();
    const cfg = config();
    const channels = cfg?.channels?.length ? cfg.channels : defaultFleetTableChannels();
    const sourceIds =
      typeof props.selectedSourceIds === "function" ? props.selectedSourceIds() : props.selectedSourceIds;

    if (!channels.length) {
      setSourceRows([]);
      setDataBySource({});
      setIsLoadingTable(false);
      return;
    }
    if (!className || !projectId || !date) {
      debug("FleetDataTable: Missing context, skipping update (keeping current table)", { hasClass: !!className, hasProject: !!projectId, hasDate: !!date });
      setIsLoadingTable(false);
      return;
    }
    const dateStr = String(date).replace(/[-/]/g, "");
    const dateDisplay =
      dateStr.length >= 8
        ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
        : String(date);
    const ymd = dateStr.length >= 8 ? dateStr.slice(0, 8) : dateStr;
    try {
      setIsLoadingTable(true);
      const timezone = await getTimezoneForDate(className, Number(projectId), dateDisplay);
      let url = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateDisplay)}`;
      if (timezone) url += `&timezone=${encodeURIComponent(timezone)}`;
      const resp: any = await getData(url);
      let list: any[] = Array.isArray(resp?.data) ? resp.data : Array.isArray(resp) ? resp : [];
      if (list.length === 0 && resp?.data && typeof resp.data === "object") {
        list = Array.isArray((resp.data as any).datasets) ? (resp.data as any).datasets : Array.isArray((resp.data as any).items) ? (resp.data as any).items : [];
      }
      const mapped = list.map((row: any) => ({
        source_id: Number(row.source_id ?? row.sourceId),
        source_name: row.source_name ?? row.sourceName ?? String(row.source_id ?? row.sourceId),
        dataset_id: Number(row.dataset_id ?? row.datasetId ?? 0),
      }));
      const rows =
        sourceIds?.size > 0
          ? mapped.filter((r: { source_id: number }) => Number.isFinite(r.source_id) && sourceIds.has(r.source_id))
          : mapped.filter((r: { source_id: number }) => Number.isFinite(r.source_id));
      setSourceRows(rows);

      // Always fetch from API (timeseries)—same philosophy as Overlay; do not use map cache
      const requiredChannels = ["Datetime", ...channels];
      const bySource: Record<number, any[]> = {};
      await Promise.all(
        rows.map(async (r: { source_id: number; source_name: string; dataset_id: number }) => {
          try {
            const data = await unifiedDataStore.fetchDataWithChannelChecking(
              "overlay",
              className,
              String(r.source_id),
              requiredChannels,
              {
                projectId: Number(projectId),
                className,
                datasetId: r.dataset_id,
                date: ymd,
                sourceName: r.source_name,
              },
              "timeseries"
            );
            bySource[r.source_id] = Array.isArray(data) ? data : [];
          } catch (err) {
            debug("FleetDataTable: Fetch failed for source", r.source_id, err);
            bySource[r.source_id] = [];
          }
        })
      );
      setDataBySource(bySource);
      setIsLoadingTable(false);
      const loadKey = `${dateDisplay}-${rows.length}`;
      if (lastLoadedLogKey !== loadKey) {
        lastLoadedLogKey = loadKey;
        debug("FleetDataTable: loaded from API", {
          sourceCount: rows.length,
          dateDisplay,
          dataBySourceKeys: Object.keys(bySource),
          rowCountsPerSource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, (v as any[]).length])),
        });
      }
    } catch (e) {
      logError("FleetDataTable: Failed to load dataset list or source data", e as Error);
      setSourceRows([]);
      setDataBySource({});
      setIsLoadingTable(false);
    }
  });

  // Apply position to container
  const applyPosition = () => {
    if (!containerRef) return;
    const pos = tablePosition();
    const sidebarWidth = getSidebarWidth();
    containerRef.style.position = "fixed";
    containerRef.style.zIndex = "6000";
    containerRef.style.left = "auto";
    containerRef.style.right = "auto";
    containerRef.style.top = "auto";
    containerRef.style.bottom = "auto";
    containerRef.style.transform = "none";
    if (pos.x === 0) {
      containerRef.style.left = `${sidebarWidth}px`;
    } else if (pos.x === 100) {
      containerRef.style.right = "0px";
    } else {
      containerRef.style.left = `${pos.x}%`;
    }
    if (pos.y === 0) {
      containerRef.style.top = `${TOP_OFFSET}px`;
    } else if (pos.y === 100) {
      containerRef.style.bottom = "0px";
    } else {
      containerRef.style.top = `${pos.y}%`;
    }
    const tx = [25, 50, 75].includes(pos.x) ? "translateX(-50%)" : "";
    const ty = [25, 50, 75].includes(pos.y) ? "translateY(-50%)" : "";
    containerRef.style.transform = [tx, ty].filter(Boolean).join(" ") || "none";
  };

  // Make overlay draggable with snap-to-grid (0, 25, 50, 75, 100) and save to localStorage
  const makeDraggable = (el: HTMLDivElement) => {
    if (!el) return;
    el.addEventListener("mousedown", (event: MouseEvent) => {
      const isClickInsideOverlay = el.contains(event.target as Node);
      const isInteractive =
        event.target &&
        ((event.target as HTMLElement).tagName === "BUTTON" ||
          (event.target as HTMLElement).tagName === "INPUT" ||
          (event.target as HTMLElement).tagName === "SELECT" ||
          (event.target as HTMLElement).tagName === "A" ||
          (event.target as HTMLElement).closest("button") ||
          (event.target as HTMLElement).closest("input") ||
          (event.target as HTMLElement).closest("select") ||
          (event.target as HTMLElement).closest("a"));
      if (!isClickInsideOverlay || isInteractive) return;

      const rect = el.getBoundingClientRect();
      if (el.style.bottom && el.style.bottom !== "auto") {
        el.style.top = `${rect.top}px`;
        el.style.bottom = "auto";
      }
      if (el.style.right && el.style.right !== "auto") {
        el.style.left = `${rect.left}px`;
        el.style.right = "auto";
      }
      if (el.style.left?.includes("%")) el.style.left = `${rect.left}px`;
      if (el.style.top?.includes("%")) el.style.top = `${rect.top}px`;
      const updatedRect = el.getBoundingClientRect();
      const offsetX = event.clientX - updatedRect.left;
      const offsetY = event.clientY - updatedRect.top;
      el.style.transform = "none";
      el.style.left = `${updatedRect.left}px`;
      el.style.top = `${updatedRect.top}px`;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sw = getSidebarWidth();
        const r = el.getBoundingClientRect();
        let newLeft = moveEvent.clientX - offsetX;
        let newTop = moveEvent.clientY - offsetY;
        newLeft = Math.max(sw, Math.min(vw - r.width, newLeft));
        newTop = Math.max(TOP_OFFSET, Math.min(vh - r.height, newTop));
        el.style.left = `${newLeft}px`;
        el.style.top = `${newTop}px`;
        el.style.bottom = "auto";
        el.style.right = "auto";
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sw = getSidebarWidth();
        const leftEdge = r.left;
        const rightEdge = r.right;
        const centerX = r.left + r.width / 2;
        const topEdge = r.top;
        const bottomEdge = r.bottom;
        const centerY = r.top + r.height / 2;
        const availH = vh - TOP_OFFSET;

        let newX: number;
        const leftThreshold = sw + (vw - sw) * 0.2;
        if (leftEdge <= leftThreshold) {
          newX = Math.abs(leftEdge - sw) <= 10 ? 0 : Math.max(0, ((leftEdge - sw) / (vw - sw)) * 100);
        } else if (rightEdge > vw * 0.8) {
          newX = Math.min(100, 100 - ((vw - rightEdge) / vw) * 100);
        } else {
          newX = Math.max(0, Math.min(100, ((centerX - sw) / (vw - sw)) * 100));
        }

        let newY: number;
        if (topEdge <= TOP_OFFSET + availH * 0.2) {
          newY = topEdge <= TOP_OFFSET + 10 ? 0 : ((topEdge - TOP_OFFSET) / availH) * 100;
        } else if (bottomEdge >= vh * 0.8) {
          newY = 100 - ((vh - bottomEdge) / vh) * 100;
          if (bottomEdge >= vh - 10) newY = 100;
        } else {
          newY = ((centerY - TOP_OFFSET) / availH) * 100;
        }
        newY = Math.max(0, Math.min(100, newY));

        const grid = [0, 25, 50, 75, 100];
        const snappedX = grid.reduce((a, b) => (Math.abs(newX - b) < Math.abs(newX - a) ? b : a));
        const snappedY = grid.reduce((a, b) => (Math.abs(newY - b) < Math.abs(newY - a) ? b : a));

        if (snappedX === 0) {
          el.style.left = `${sw}px`;
          el.style.right = "auto";
        } else if (snappedX === 100) {
          el.style.right = "0px";
          el.style.left = "auto";
        } else {
          el.style.left = `${snappedX}%`;
          el.style.right = "auto";
        }
        if (snappedY === 0) {
          el.style.top = `${TOP_OFFSET}px`;
          el.style.bottom = "auto";
        } else if (snappedY === 100) {
          el.style.bottom = "0px";
          el.style.top = "auto";
        } else {
          el.style.top = `${snappedY}%`;
          el.style.bottom = "auto";
        }
        const tx = [25, 50, 75].includes(snappedX) ? "translateX(-50%)" : "";
        const ty = [25, 50, 75].includes(snappedY) ? "translateY(-50%)" : "";
        el.style.transform = [tx, ty].filter(Boolean).join(" ") || "none";

        setTablePosition({ x: snappedX, y: snappedY });
        const pos = { x: snappedX, y: snappedY };
        const orientation = config()?.orientation ?? "vertical";
        const savedData = { position: pos, orientation };
        try {
          persistantStore.setOverlayPositions((prev) => ({
            ...prev,
            [objectName()]: savedData,
          }));
          persistantStore.savePersistentSettings();
          debug("FleetDataTable: Saved overlay position to user settings", { key: objectName(), pos });
        } catch (e) {
          logError("FleetDataTable: Failed to save position to user settings", e as Error);
        }
        const storageKey = `overlay_position_${objectName()}`;
        try {
          localStorage.setItem(storageKey, JSON.stringify({ position: pos }));
        } catch (e) {
          logError("FleetDataTable: Failed to save position to localStorage", e as Error);
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      event.preventDefault();
    });
  };

  onMount(() => {
    debug("FleetDataTable: mounted");
    applyPosition();
  });

  createEffect(() => {
    tablePosition();
    applyPosition();
  });

  // Log render state for diagnosis (empty vs with data)
  let lastRenderedSourceCount: number | null = null;
  createEffect(() => {
    const loading = isLoadingTable();
    const count = sourceRows().length;
    if (loading) return;
    if (count !== lastRenderedSourceCount) {
      lastRenderedSourceCount = count;
      if (count === 0) {
        debug("FleetDataTable: rendering with 0 sources (empty state) — table will show 'Select boats...'");
      } else {
        debug("FleetDataTable: rendering with N sources", { sourceCount: count });
      }
    }
  });

  // Reactive getters so JSX updates when config or time changes
  const channels = () => config()?.channels?.length ? config()!.channels : defaultFleetTableChannels();
  const backgroundColor = () => {
    const cfg = config();
    const bg = cfg?.backgroundColor ?? "#FFFFFF";
    const op = typeof cfg?.opacity === "number" ? cfg.opacity : 1;
    return hexToRgba(bg, Math.max(0.5, op));
  };
  /** Vertical = sources as rows, channels as columns. Reactive so layout updates when config loads. */
  const isVerticalLayout = () => (config()?.orientation ?? "vertical") === "vertical";
  
  // Reactive values for time-based calculations
  const currentTime = () => selectedTime();
  const windowMin = () => timeWindow();
  const playing = () => isPlaying();
  const showAvg = () => !playing() && windowMin() > 0 && Number.isFinite(windowMin());
  const windowMs = () => windowMin() * 60 * 1000;

  /** Rows for vertical layout: each row has source + cell display values. Re-runs when selectedTime/sourceRows/data change so For gets new list and updates. */
  const verticalBodyRows = createMemo(() => {
    const rows = sourceRows();
    if (!rows.length) return [];
    const data = dataBySource();
    const chs = channels();
    const show = showAvg();
    const wms = windowMs();
    const t = currentTime();
    const timeMs = timeToMs(t);
    return rows.map((s) => {
      const dataArr = data[s.source_id] ?? [];
      const cellTMs = effectiveTimeMs(timeMs, dataArr);
      const cellStartMs = cellTMs - wms;
      const cellEndMs = cellTMs;
      const cells = chs.map((ch) => {
        if (show) {
          const avg = averageInWindow(dataArr, ch, cellStartMs, cellEndMs);
          const std = standardDeviationInWindow(dataArr, ch, cellStartMs, cellEndMs);
          return { channel: ch, avgDisplay: avg != null ? formatNum1(avg) : "—", stdDisplay: std != null ? formatStd(std) : "—" };
        }
        const val = valueAtTime(dataArr, ch, cellTMs);
        return { channel: ch, valueDisplay: val != null ? formatNum(val) : "—" };
      });
      return { source_id: s.source_id, source_name: s.source_name, cells };
    });
  });

  /** Rows for horizontal layout: each row has channel + cell display values per source. Re-runs when selectedTime/sourceRows/data change. */
  const horizontalBodyRows = createMemo(() => {
    const rows = sourceRows();
    if (!rows.length) return [];
    const data = dataBySource();
    const chs = channels();
    const show = showAvg();
    const wms = windowMs();
    const t = currentTime();
    const timeMs = timeToMs(t);
    return chs.map((ch) => {
      const cells = rows.map((s) => {
        const dataArr = data[s.source_id] ?? [];
        const cellTMs = effectiveTimeMs(timeMs, dataArr);
        const cellStartMs = cellTMs - wms;
        const cellEndMs = cellTMs;
        if (show) {
          const avg = averageInWindow(dataArr, ch, cellStartMs, cellEndMs);
          const std = standardDeviationInWindow(dataArr, ch, cellStartMs, cellEndMs);
          return { source_id: s.source_id, source_name: s.source_name, avgDisplay: avg != null ? formatNum1(avg) : "—", stdDisplay: std != null ? formatStd(std) : "—" };
        }
        const val = valueAtTime(dataArr, ch, cellTMs);
        return { source_id: s.source_id, source_name: s.source_name, valueDisplay: val != null ? formatNum(val) : "—" };
      });
      return { channel: ch, cells };
    });
  });

  // Get source color by source_name
  const getSourceColorByName = (sourceName: string): string | null => {
    return sourcesStore.getSourceColor(sourceName);
  };

  /** Team name cell class: add -dark modifier only when color is dark so glow is applied only then. */
  const getTeamNameClass = (sourceName: string): string => {
    const base = "fleet-datatable-cell fleet-datatable-channel fleet-datatable-team-name";
    const color = getSourceColorByName(sourceName);
    return isDarkColor(color) ? `${base} fleet-datatable-team-name-dark` : base;
  };

  /** Team name header class (horizontal layout). */
  const getTeamNameHeaderClass = (sourceName: string): string => {
    const base = "fleet-datatable-cell fleet-datatable-header fleet-datatable-team-name";
    const color = getSourceColorByName(sourceName);
    return isDarkColor(color) ? `${base} fleet-datatable-team-name-dark` : base;
  };

  // Force this component to re-render when playback time changes (read at top of render so subscription is in this component's scope)
  selectedTime();

  return (
    <div
      ref={(el) => {
        containerRef = el;
        if (el) {
          applyPosition();
          if (!draggableAttached) {
            makeDraggable(el);
            draggableAttached = true;
          }
        }
      }}
      class="fleet-datatable overlay-container"
      style={{
        position: "fixed",
        "z-index": 6000,
        "background-color": backgroundColor(),
        cursor: "move",
        "border-radius": "6px",
        padding: "4px",
        "box-shadow": "0 1px 4px rgba(0,0,0,0.2)",
      }}
    >
      <Show
        when={!isLoadingTable()}
        fallback={
          <div class="fleet-datatable-loading" role="status" aria-label="Loading table data">
            <div class="fleet-datatable-spinner-wrap">
              <div
                class="spinner fleet-datatable-spinner"
                style={{
                  width: "28px",
                  height: "28px",
                  border: "3px solid var(--color-border-primary, #374151)",
                  "border-top": "3px solid var(--color-accent, #3b82f6)",
                  "border-radius": "50%",
                }}
              />
              <div class="fleet-datatable-loading-text">Loading…</div>
            </div>
          </div>
        }
      >
        <div class="fleet-datatable-table-wrap">
          <table
            class="fleet-datatable-table"
            data-selected-ms={selectedTime()?.getTime?.() ?? 0}
            data-orientation={isVerticalLayout() ? "vertical" : "horizontal"}
          >
            {!config() && sourceRows().length === 0 && (
              <caption class="fleet-datatable-caption">
                Select boats on the map to see data. Configure channels in Map Settings → Page Builder
              </caption>
            )}
            <thead>
              {isVerticalLayout() ? (
                showAvg() ? (
                  <>
                    <tr class="fleet-datatable-row">
                      <th class="fleet-datatable-cell fleet-datatable-header">TEAM</th>
                      <For each={channels()}>
                        {(ch) => (
                          <th class="fleet-datatable-cell fleet-datatable-header" colSpan={2} title={ch}>
                            {ch}
                          </th>
                        )}
                      </For>
                    </tr>
                    <tr class="fleet-datatable-row">
                      <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-subheader"></th>
                      <For each={channels()}>
                        {() => [
                          <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-subheader fleet-datatable-col-divider">AVG</th>,
                          <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-subheader">STD</th>,
                        ]}
                      </For>
                    </tr>
                  </>
                ) : (
                  <tr class="fleet-datatable-row">
                    <th class="fleet-datatable-cell fleet-datatable-header">TEAM</th>
                    <For each={channels()}>
                      {(ch) => (
                        <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-col-divider" title={ch}>
                          {ch}
                        </th>
                      )}
                    </For>
                  </tr>
                )
              ) : showAvg() ? (
                <>
                  <tr class="fleet-datatable-row">
                    <th class="fleet-datatable-cell fleet-datatable-header">Channel</th>
                    <For each={sourceRows()}>
                      {(s) => (
                        <th
                          class={getTeamNameHeaderClass(s.source_name)}
                          colSpan={2}
                          title={s.source_name}
                          style={{ color: getSourceColorByName(s.source_name) || undefined }}
                        >
                          {s.source_name}
                        </th>
                      )}
                    </For>
                  </tr>
                  <tr class="fleet-datatable-row">
                    <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-subheader"></th>
                    <For each={sourceRows()}>
                      {() => [
                        <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-subheader fleet-datatable-col-divider">AVG</th>,
                        <th class="fleet-datatable-cell fleet-datatable-header fleet-datatable-subheader">STD</th>,
                      ]}
                    </For>
                  </tr>
                </>
              ) : (
                <tr class="fleet-datatable-row">
                  <th class="fleet-datatable-cell fleet-datatable-header">Channel</th>
                  <For each={sourceRows()}>
                    {(s) => (
                      <th
                        class={`${getTeamNameHeaderClass(s.source_name)} fleet-datatable-col-divider`}
                        title={s.source_name}
                        style={{ color: getSourceColorByName(s.source_name) || undefined }}
                      >
                        {s.source_name}
                      </th>
                    )}
                  </For>
                </tr>
              )}
            </thead>
            <tbody>
              {isVerticalLayout() ? (
                sourceRows().length === 0 ? (
                  <tr class="fleet-datatable-row">
                    <td class="fleet-datatable-cell fleet-datatable-empty-message" colSpan={showAvg() ? 1 + channels().length * 2 : channels().length + 1}>
                      No boats selected — select boats in map settings to see values here
                    </td>
                  </tr>
                ) : (
                  <For each={verticalBodyRows()}>
                    {(row) => (
                      <tr class="fleet-datatable-row">
                        <td
                          class={getTeamNameClass(row.source_name)}
                          title={row.source_name}
                          style={{ color: getSourceColorByName(row.source_name) || undefined }}
                        >
                          {row.source_name}
                        </td>
                        {showAvg()
                          ? (
                            <For each={row.cells}>
                              {(cell) => [
                                <td class="fleet-datatable-cell fleet-datatable-avg fleet-datatable-col-divider" title={`${cell.channel} avg`}>
                                  {"avgDisplay" in cell ? cell.avgDisplay : "—"}
                                </td>,
                                <td class="fleet-datatable-cell fleet-datatable-std" title={`${cell.channel} std`}>
                                  {"stdDisplay" in cell ? cell.stdDisplay : "—"}
                                </td>,
                              ]}
                            </For>
                            )
                          : (
                            <For each={row.cells}>
                              {(cell) => (
                                <td class="fleet-datatable-cell fleet-datatable-col-divider" title={cell.channel}>
                                  {"valueDisplay" in cell ? cell.valueDisplay : "—"}
                                </td>
                              )}
                            </For>
                            )}
                      </tr>
                    )}
                  </For>
                )
              ) : sourceRows().length === 0 ? (
                <tr class="fleet-datatable-row">
                  <td class="fleet-datatable-cell fleet-datatable-empty-message" colSpan={showAvg() ? 1 + sourceRows().length * 2 : 1 + sourceRows().length}>
                    No boats selected — select boats in map settings to see values here
                  </td>
                </tr>
              ) : (
                <For each={horizontalBodyRows()}>
                  {(row) => (
                    <tr class="fleet-datatable-row">
                      <td class="fleet-datatable-cell fleet-datatable-channel">{row.channel}</td>
                      {showAvg()
                        ? (
                          <For each={row.cells}>
                            {(cell) => [
                              <td class="fleet-datatable-cell fleet-datatable-avg fleet-datatable-col-divider" title={`${cell.source_name} ${row.channel} avg`}>
                                {cell.avgDisplay}
                              </td>,
                              <td class="fleet-datatable-cell fleet-datatable-std" title={`${cell.source_name} ${row.channel} std`}>
                                {cell.stdDisplay}
                              </td>,
                            ]}
                          </For>
                          )
                        : (
                          <For each={row.cells}>
                            {(cell) => (
                              <td class="fleet-datatable-cell fleet-datatable-col-divider" title={row.channel}>
                                {cell.valueDisplay}
                              </td>
                            )}
                          </For>
                          )}
                    </tr>
                  )}
                </For>
              )}
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

const SMALL_THRESHOLD = 0.005;

/** Format numbers >= 1000 as e.g. 1.8k; no scientific notation. */
function formatWithK(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const scaled = abs / 1000;
  const str = scaled >= 10 ? Math.round(scaled).toString() : scaled.toFixed(1).replace(/\.0$/, "");
  return `${sign}${str}k`;
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return formatWithK(n);
  if (Math.abs(n) < SMALL_THRESHOLD) return "0.00";
  return n.toFixed(2);
}

function formatNum1(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return formatWithK(n);
  if (Math.abs(n) < SMALL_THRESHOLD) return "0.00";
  return n.toFixed(1);
}

/** Std display: very small values show as 0.00, otherwise max 2 decimals; no scientific notation. */
function formatStd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < SMALL_THRESHOLD) return "0.00";
  if (Math.abs(n) >= 1000) return formatWithK(n);
  return n.toFixed(2);
}

function formatTimeWindowDisplay(showAvg: boolean, avg: number | null, std: number | null, val: number | null): string {
  if (showAvg && avg != null) {
    const avgStr = `Avg: ${formatNum1(avg)}`;
    const stdStr = std != null ? `  Std: ${formatStd(std)}` : "";
    return `${avgStr}${stdStr}`;
  }
  if (val != null) return formatNum(val);
  return "—";
}
