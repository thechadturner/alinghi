/**
 * Mark Wind Overlay
 *
 * Shows wind streaming off each mark. Each origin timestamp is its own cloud:
 * wind that left at time T uses the mark positions and TWD at T, so the cloud
 * spreads as TWD changes over time. Each cloud is drawn with a distinct color
 * (by age: oldest to newest).
 */

import { createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { BaseOverlayProps } from "./types";
import { normalizeAngle, calculateDestination } from "./mapUtils";
import { debug } from "../../../../utils/console";
import { selectedTime, isPlaying } from "../../../../store/playbackStore";
import { persistantStore } from "../../../../store/persistantStore";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { apiEndpoints } from "../../../../config/env";
import { getData } from "../../../../utils/global";

interface MarkwindTimestep {
  DATETIME: string;
  MARKS: Array<{
    NAME: string;
    LAT: string;
    LON: string;
    TWS?: string;
    TWD?: string;
  }>;
}

/** Points for a single origin timestamp (one cloud, one color). */
interface CloudByTimestamp {
  offsetSeconds: number;
  points: Array<{ lng: number; lat: number }>;
}

const PROPAGATION_SECONDS = 180;
/** TWS in markwind is km/h; convert to m/s */
const KMH_TO_MPS = 1 / 3.6;

function formatDateForAPI(date: string | number | null | undefined): string | null {
  if (!date) return null;
  const s = String(date);
  if (s.includes("-")) return s;
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

/** Contour updates only on this interval (ms) to avoid flashing during animation. */
const MARKWIND_UPDATE_INTERVAL_MS = 10 * 1000;

export default function MarkWindOverlay(props: BaseOverlayProps) {
  let overlayGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;
  let markwindData: MarkwindTimestep[] = [];
  let computedClouds: CloudByTimestamp[] = [];
  let abortController: AbortController | null = null;
  let updateTimeout: ReturnType<typeof setTimeout> | null = null;
  let contourIntervalId: ReturnType<typeof setInterval> | null = null;

  const fetchMarkwind = async (): Promise<MarkwindTimestep[]> => {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    if (!className || !projectId) return [];

    let dateStr: string | null = null;
    const datasetId = persistantStore.selectedDatasetId();
    if (datasetId && datasetId > 0) {
      try {
        const url = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`;
        const ctrl = new AbortController();
        abortController = ctrl;
        const response = await getData(url, ctrl.signal);
        if (response?.type === "AbortError") return [];
        if (response?.success && response?.data?.date) {
          let d = response.data.date;
          if (d.length === 8 && !d.includes("-")) {
            d = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
          }
          dateStr = d;
        }
      } catch (_) {
        // ignore
      }
    }
    if (!dateStr) {
      const selectedDate = persistantStore.selectedDate();
      dateStr = formatDateForAPI(selectedDate);
    }
    if (!dateStr) {
      const today = new Date();
      dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    }

    const cacheKey = `markwind_${className}_${dateStr}`;
    let cached = await unifiedDataStore.getObject(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached as MarkwindTimestep[];
    }

    try {
      const markwindUrl = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=markwind`;
      const ctrl = new AbortController();
      abortController = ctrl;
      const response = await getData(markwindUrl, ctrl.signal);
      if (response?.type === "AbortError") return [];
      let data: MarkwindTimestep[] = [];
      if (response?.success && response?.data) {
        const raw = (response.data as any)?.value ?? response.data;
        if (Array.isArray(raw)) data = raw;
        else if (typeof raw === "string") data = JSON.parse(raw);
      }
      if (data.length > 0) {
        await unifiedDataStore.storeObject(cacheKey, data);
      }
      return data;
    } catch (e) {
      debug("MarkWindOverlay: fetchMarkwind failed", e);
      return [];
    }
  };

  /**
   * Build one cloud per origin timestamp. Like bad air: each past timestep's
   * snapshot gives (position, TWD, TWS) and we propagate for that age. So older
   * points use the older TWS and TWD from that time. We also apply TWS ratios
   * (1.1, 1.05, ... 0.75) like bad air for a denser cloud.
   */
  const computeClouds = (
    data: MarkwindTimestep[],
    effectiveTime: Date
  ): CloudByTimestamp[] => {
    if (!data?.length) return [];
    const clouds: CloudByTimestamp[] = [];
    const effectiveMs = effectiveTime.getTime();
    const TWS_RATIOS = [1.1, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75];

    for (const timestep of data) {
      const stepMs = new Date(timestep.DATETIME).getTime();
      if (isNaN(stepMs)) continue;
      const ageSec = (effectiveMs - stepMs) / 1000;
      if (ageSec <= 0 || ageSec > PROPAGATION_SECONDS) continue;

      const points: Array<{ lng: number; lat: number }> = [];
      for (const mark of timestep.MARKS) {
        const lat = parseFloat(mark.LAT);
        const lng = parseFloat(mark.LON);
        const twsRaw = mark.TWS != null ? parseFloat(String(mark.TWS)) : NaN;
        const twdRaw = mark.TWD != null ? parseFloat(String(mark.TWD)) : NaN;
        if (isNaN(lat) || isNaN(lng) || isNaN(twsRaw) || twsRaw <= 0 || isNaN(twdRaw)) continue;

        const downwind = normalizeAngle(twdRaw - 180);
        for (const ratio of TWS_RATIOS) {
          const twsMps = twsRaw * KMH_TO_MPS * ratio;
          const meters = twsMps * ageSec;
          const dest = calculateDestination(lat, lng, meters, downwind);
          if (dest && !isNaN(dest.lat) && !isNaN(dest.lng)) {
            points.push({ lng: dest.lng, lat: dest.lat });
          }
        }
      }
      if (points.length > 0) {
        clouds.push({ offsetSeconds: Math.round(ageSec), points });
      }
    }
    return clouds;
  };

  const renderOverlay = () => {
    const playing = isPlaying();
    if (!props.enabled || !props.svg || !props.map || playing) {
      if (overlayGroup) {
        overlayGroup.remove();
        overlayGroup = null;
      }
      return;
    }

    const svgNode = props.svg.node();
    if (!svgNode?.parentNode) {
      debug("MarkWindOverlay: SVG not attached");
      return;
    }

    if (computedClouds.length === 0) {
      if (overlayGroup) overlayGroup.selectAll("path").remove();
      return;
    }

    if (!overlayGroup) {
      const existing = props.svg.select<SVGGElement>("g.markwind-overlay");
      if (!existing.empty()) {
        overlayGroup = existing;
      } else {
        overlayGroup = props.svg
          .append<SVGGElement>("g")
          .attr("class", "markwind-overlay")
          .style("pointer-events", "none");
      }
    }

    // Flatten all clouds to one set of points; project to screen for contour (pixel space = visible at any zoom)
    const allPoints: Array<{ lng: number; lat: number }> = [];
    for (const cloud of computedClouds) {
      allPoints.push(...cloud.points);
    }
    const projectedPoints = allPoints
      .map((d) => {
        try {
          const p = props.map!.project([d.lng, d.lat]);
          if (p && !isNaN(p.x) && !isNaN(p.y)) return { x: p.x, y: p.y };
        } catch (_) {}
        return null;
      })
      .filter((p): p is { x: number; y: number } => p !== null);

    if (projectedPoints.length === 0) {
      overlayGroup.selectAll("path").remove();
      return;
    }

    try {
      const CONTOUR_BANDWIDTH = 28;
      const CONTOUR_CELL_SIZE = 8;
      const CONTOUR_THRESHOLDS = 6;

      const densityData = d3
        .contourDensity<{ x: number; y: number }>()
        .x((d) => d.x)
        .y((d) => d.y)
        .size([props.width, props.height])
        .cellSize(CONTOUR_CELL_SIZE)
        .bandwidth(CONTOUR_BANDWIDTH)
        .thresholds(CONTOUR_THRESHOLDS)(projectedPoints);

      const dExtent = d3.extent(densityData, (d) => d.value);
      const dMax = dExtent[1];
      if (dExtent[0] == null || dMax == null) {
        overlayGroup.selectAll("path").remove();
        return;
      }

      // Extend the low end: use more of the density range and push white/red further so outer contour is visible (green = high density, red = mid)
      const maxVal = dMax * 0.7;
      const colorScale = d3
        .scaleLinear<string>()
        .domain([0, maxVal * 0.7, maxVal])
        .range(["rgba(255, 255, 255, 0.75)", "rgba(180, 0, 0, 0.6)", "rgba(0, 120, 0, 0.75)"]);

      const geoPath = d3.geoPath();

      overlayGroup.selectAll("path").remove();
      overlayGroup
        .selectAll<SVGPathElement, d3.ContourMultiPolygon>("path.markwind-contour")
        .data(densityData)
        .enter()
        .append("path")
        .attr("class", "markwind-contour")
        .attr("d", (d) => geoPath(d))
        .attr("fill", (d) => colorScale(d.value))
        .attr("fill-opacity", 0.55)
        .attr("stroke", "rgba(255, 255, 255, 0.1)")
        .attr("stroke-width", 1);
    } catch (e) {
      debug("MarkWindOverlay: contour render error", e);
      overlayGroup.selectAll("path").remove();
    }
  };

  const update = () => {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = setTimeout(async () => {
      if (!props.enabled || isPlaying()) {
        if (overlayGroup) {
          overlayGroup.remove();
          overlayGroup = null;
        }
        return;
      }
      markwindData = await fetchMarkwind();
      const effectiveTime = props.effectivePlaybackTime ?? selectedTime();
      if (!effectiveTime) {
        computedClouds = [];
      } else {
        computedClouds = computeClouds(markwindData, effectiveTime);
      }
      renderOverlay();
    }, 50);
  };

  createEffect(() => {
    const enabled = props.enabled;
    const svg = props.svg;
    const map = props.map;
    const playing = isPlaying();
    if (enabled && svg && map && !playing) {
      update();
    } else {
      if (overlayGroup) {
        overlayGroup.remove();
        overlayGroup = null;
      }
    }
  });

  // Refetch when class/project/date context changes
  createEffect(() => {
    if (!props.enabled) return;
    const _class = persistantStore.selectedClassName();
    const _project = persistantStore.selectedProjectId();
    const _dataset = persistantStore.selectedDatasetId();
    const _date = persistantStore.selectedDate();
    void _class;
    void _project;
    void _dataset;
    void _date;
    update();
  });

  // Update contour on a 10s interval only (do not subscribe to time steps — that causes flashing). When playing, overlay is hidden.
  createEffect(() => {
    if (!props.enabled || !props.svg || !props.map || isPlaying()) {
      if (contourIntervalId !== null) {
        clearInterval(contourIntervalId);
        contourIntervalId = null;
      }
      if (overlayGroup && isPlaying()) {
        overlayGroup.remove();
        overlayGroup = null;
      }
      return;
    }
    const refreshContour = () => {
      if (isPlaying()) return;
      const effectiveTime = selectedTime() ?? props.effectivePlaybackTime ?? null;
      if (!effectiveTime || markwindData.length === 0) return;
      computedClouds = computeClouds(markwindData, effectiveTime);
      renderOverlay();
    };
    // Only run from interval; do not read selectedTime() in effect body or we re-run every time step
    contourIntervalId = setInterval(refreshContour, MARKWIND_UPDATE_INTERVAL_MS);
    return () => {
      if (contourIntervalId !== null) {
        clearInterval(contourIntervalId);
        contourIntervalId = null;
      }
    };
  });

  createEffect(() => {
    if (!props.enabled || !props.map) return;
    const handleMove = () => {
      if (overlayGroup && computedClouds.length > 0) renderOverlay();
    };
    props.map.on("move", handleMove);
    props.map.on("zoom", handleMove);
    props.map.on("rotate", handleMove);
    return () => {
      props.map.off("move", handleMove);
      props.map.off("zoom", handleMove);
      props.map.off("rotate", handleMove);
    };
  });

  onCleanup(() => {
    if (updateTimeout) clearTimeout(updateTimeout);
    if (contourIntervalId !== null) {
      clearInterval(contourIntervalId);
      contourIntervalId = null;
    }
    if (abortController) abortController.abort();
    if (overlayGroup) {
      overlayGroup.remove();
      overlayGroup = null;
    }
  });

  return <></>;
}
