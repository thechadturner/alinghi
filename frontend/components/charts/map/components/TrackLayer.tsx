import { createEffect, onMount, onCleanup, untrack } from "solid-js";
import * as d3 from "d3";
import { useTrackRendering, TrackPoint, TrackConfig } from "../hooks/useTrackRendering";
import { selectedEvents, selectedRanges, selectedRange, hasSelection, cutEvents, triggerSelection, setTriggerSelection } from "../../../../store/selectionStore";
import { selectedTime, timeWindow } from "../../../../store/playbackStore";
import { tooltip, setTooltip } from "../../../../store/globalStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { warn, error as logError, debug } from "../../../../utils/console";
import { formatTime } from "../../../../utils/global";
import { renderSegmentedTracks } from "../renderers/SegmentedTrackRenderer";
import { renderContinuousTracks } from "../renderers/ContinuousTrackRenderer";
import {
  getSampleRate,
  getExpandedViewportBounds,
  isPointInViewport,
  sampleTrack,
  shouldRedrawForZoom,
  getCombinedSampleRate
} from "../utils/lodUtils";

import { persistantStore } from "../../../../store/persistantStore";
import { getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { getInterpolatedPointAtTime } from "../../../../utils/trackInterpolation";
import { bspValueFromRow, mapSpeedChannelTooltipLabelHtml, twsValueFromRow } from "../../../../utils/speedUnits";
const { selectedClassName } = persistantStore;

// Extend Window interface for timeout properties
declare global {
  interface Window {
    trackRenderTimeout?: ReturnType<typeof setTimeout> | null;
    trackRedrawTimeout?: ReturnType<typeof setTimeout> | null;
    trackLayerResizeHandler?: () => void;
  }
}

export interface TrackLayerProps {
  data: TrackPoint[];
  map: any;
  maptype: 'DEFAULT' | 'GRADE' | 'WIND' | 'VMG' | 'MANEUVERS';
  samplingFrequency: number;
  onPointClick?: (point: TrackPoint) => void;
  onRangeSelect?: (start: TrackPoint, end: TrackPoint) => void;
  showGaps?: boolean;
  gapThreshold?: number;
  tilesAvailable?: boolean;
  /** Optional override color used when maptype is DEFAULT and no selections */
  sourceColorHex?: string;
  /** Whether to show maneuver circles and labels */
  maneuversEnabled?: boolean;
  /** Current zoom level for LOD system */
  zoomLevel?: number;
  /** When provided (time-window playback), use this instead of selectedTime so track ends at boat position */
  effectivePlaybackTime?: Date | null;
}

export default function TrackLayer(props: TrackLayerProps) {
  // Read maptype directly from store to ensure reactivity when color option changes
  const { colorType: maptype } = persistantStore;

  // Configuration for track rendering - use store maptype for reactivity
  const config = {
    maptype: maptype(),
    samplingFrequency: props.samplingFrequency,
    showGaps: props.showGaps ?? true,
    gapThreshold: props.gapThreshold
  };

  const { initScales, getColor, getThickness, applyFilters, getTimestamp, sourceColor, sourceColorLoaded } = useTrackRendering(config as TrackConfig);

  // Get dynamic channel names from store
  const { latName, lngName, twsName, bspName } = defaultChannelsStore;

  // Helper function to get Lat/Lng values with case-insensitive fallback
  const getLat = (d: any): number | undefined => {
    if (!d) return undefined;
    const latField = latName();
    const val = d[latField] ?? d[latField.toLowerCase()] ?? d[latField.toUpperCase()] ?? d.Lat ?? d.lat;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };

  const getLng = (d: any): number | undefined => {
    if (!d) return undefined;
    const lngField = lngName();
    const val = d[lngField] ?? d[lngField.toLowerCase()] ?? d[lngField.toUpperCase()] ?? d.Lng ?? d.lng;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };

  // Wrapper to allow optional source color override
  const getColorWrapper = (d: TrackPoint, prev: TrackPoint | null, cfg: TrackConfig) => {
    const effectiveCfg = cfg || (config as TrackConfig);
    if (props.sourceColorHex) {
      return props.sourceColorHex as string;
    }
    return getColor(d, prev, effectiveCfg);
  };

  let trackOverlay: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;
  let svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any> | null = null;
  let overlayContainer: HTMLElement | null = null;
  let isDrawing = false;
  let currentFilteredData: TrackPoint[] = [];
  let isInitialized = false; // Flag to prevent premature renders during initialization
  let animationFrameId: number | null = null;
  let isUpdating = false;

  // LOD: Track original unfiltered data and last render zoom level
  let originalData: TrackPoint[] = [];
  let lastRenderZoom: number | null = null;

  // Helper function to filter data by time window
  const filterDataByTimeWindow = (data: TrackPoint[], currentTime: Date, windowMinutes: number): TrackPoint[] => {
    if (windowMinutes === 0) return data; // Full window - return all data

    // Calculate window start (windowMinutes before currentTime)
    const windowStart = new Date(currentTime.getTime() - (windowMinutes * 60 * 1000));
    const windowEnd = currentTime;

    // No future preview - show track only up to current time

    // Filter data to include only past window up to current time
    const filteredData = data.filter(d => {
      const timestamp = getTimestamp(d);
      return timestamp >= windowStart && timestamp <= windowEnd;
    });

    return filteredData;
  };

  // Helper function to calculate opacity based on data age
  const getDataOpacity = (dataPoint: TrackPoint, currentTime: Date, windowMinutes: number): number => {
    if (windowMinutes === 0) return 1.0; // Full opacity for full window

    const dataTime = getTimestamp(dataPoint);
    const oneMinuteMs = 60 * 1000; // 1 minute in milliseconds

    if (dataTime <= currentTime) {
      // Past data - taper to 0.4 within 1 minute of selected time
      const timeDiff = currentTime.getTime() - dataTime.getTime();
      if (timeDiff <= oneMinuteMs) {
        // Within 1 minute - taper from 1.0 to 0.4
        const opacity = 1 - (timeDiff / oneMinuteMs) * 0.6; // 1.0 to 0.4
        return Math.max(0.4, opacity);
      } else {
        // Beyond 1 minute - 0.4 opacity
        return 0.4;
      }
    } else {
      // Future data - 0.1 opacity for 10-second preview
      const futureTimeDiff = dataTime.getTime() - currentTime.getTime();
      if (futureTimeDiff <= 10000) { // 10 seconds
        return 0.1;
      } else {
        return 0; // Beyond 10 seconds - invisible
      }
    }
  };

  // Helper function to format tooltip content
  const getTooltipContent = (point: TrackPoint): string => {
    if (!point) return "";
    const timezone = getCurrentDatasetTimezone();
    const { twsName, bspName, twdName, twaName } = defaultChannelsStore;
    const twsField = twsName();
    const bspField = bspName();
    const twdField = twdName();
    const twaField = twaName();
    const displayUnit = persistantStore.defaultUnits();
    const twsLabelHtml =
      mapSpeedChannelTooltipLabelHtml(twsField, displayUnit) ?? "TWS";
    const bspLabelHtml =
      mapSpeedChannelTooltipLabelHtml(bspField, displayUnit) ?? "BSP";
    const row = point as unknown as Record<string, unknown>;
    const twsTooltip = (() => {
      const n = twsValueFromRow(row, twsField, Number.NaN);
      return Number.isFinite(n) ? String(n) : '';
    })();
    const bspTooltip = (() => {
      const n = bspValueFromRow(row, bspField, Number.NaN);
      return Number.isFinite(n) ? String(n) : '';
    })();

    if (selectedClassName() === 'ac40') {
      return `<table class='table-striped'>
        <tr><td>TIME</td><td>${formatTime(point.Datetime, timezone)}</td></tr>
        <tr><td>${twsLabelHtml}</td><td>${twsTooltip}</td></tr>
        <tr><td>TWD</td><td>${point[twdField] || ''}</td></tr>
        <tr><td>${bspLabelHtml}</td><td>${bspTooltip}</td></tr>
        <tr><td>TWA</td><td>${point[twaField] || ''}</td></tr>
        <tr><td>GRADE</td><td>${point.grade || point.Grade || ''}</td></tr>
        <tr><td>RACE</td><td>${point.race_number || point.Race_number || ''}</td></tr>
        <tr><td>LEG</td><td>${point.leg_number || point.Leg_number || ''}</td></tr>
        <tr><td>CONFIG</td><td>${point.Config || ''}</td></tr>
        <tr><td>MANEUVER</td><td>${point.Maneuver_type || ''}</td></tr>
        </table>`;
    } else {
      return `<table class='table-striped'>
        <tr><td>TIME</td><td>${formatTime(point.Datetime, timezone)}</td></tr>
        <tr><td>${twsLabelHtml}</td><td>${twsTooltip}</td></tr>
        <tr><td>TWD</td><td>${point[twdField] || ''}</td></tr>
        <tr><td>${bspLabelHtml}</td><td>${bspTooltip}</td></tr>
        <tr><td>TWA</td><td>${point[twaField] || ''}</td></tr>
        <tr><td>GRADE</td><td>${point.grade || point.Grade || ''}</td></tr>
        <tr><td>RACE</td><td>${point.race_number || point.Race_number || ''}</td></tr>
        <tr><td>LEG</td><td>${point.leg_number || point.Leg_number || ''}</td></tr>
        <tr><td>MANEUVER</td><td>${point.Maneuver_type || ''}</td></tr>
        </table>`;
    }

  };

  // Create track overlay
  const createTrackOverlay = () => {
    debug('TrackLayer: createTrackOverlay called');
    if (!props.map) {
      debug('TrackLayer: createTrackOverlay - no map available');
      return;
    }

    // Check if map is loaded
    if (!props.map.isStyleLoaded()) {
      props.map.on('styledata', () => {
        createTrackOverlay();
      });
      return;
    }
    // Remove only this map instance's overlay
    const existingContainer = overlayContainer || props.map.getCanvasContainer?.();
    if (existingContainer) {
      d3.select(existingContainer).selectAll(".track-overlay").remove();
    }

    // Create SVG overlay - attach to mapboxgl-canvas-container like RaceCourseLayer
    let container: HTMLElement | null = null;
    try {
      container = props.map.getCanvasContainer() as HTMLElement;
    } catch (e) {
      debug('TrackLayer: getCanvasContainer failed, trying .map element', e);
    }

    if (!container) {
      try {
        container = props.map.getContainer() as HTMLElement;
      } catch (e) {
        debug('TrackLayer: getContainer fallback failed', e);
      }
    }

    if (!container) {
      debug('TrackLayer: Container not found');
      return;
    }

    const mapRect = container.getBoundingClientRect();
    const clientWidth = container.clientWidth || mapRect.width;
    const clientHeight = container.clientHeight || mapRect.height;
    const width = mapRect.width || clientWidth || 0;
    const height = mapRect.height || clientHeight || 0;

    overlayContainer = container;
    svg = d3.select(container)
      .append("svg")
      .attr("class", "track-overlay")
      .attr("width", width || 800)
      .attr("height", height || 600)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("pointer-events", "none")
      .style("z-index", "100");

    trackOverlay = svg.append("g").attr("class", "track-layer");
    debug('TrackLayer: trackOverlay created:', !!trackOverlay);

    // If data is already available and we're initialized, render immediately
    // This handles the case where data arrived before the overlay was created
    if (isInitialized && props.data && props.data.length > 0 && props.map) {
      debug('TrackLayer: Overlay created, rendering existing data with', props.data.length, 'points');
      config.maptype = maptype(); // Use store maptype for reactivity
      // Use a small timeout to ensure overlay is fully set up
      setTimeout(() => {
        if (trackOverlay && props.data && props.data.length > 0) {
          renderTracks(props.data);
        }
      }, 0);
    }
    debug('TrackLayer: trackOverlay created:', trackOverlay);

    // Add a background rectangle that allows map interactions to pass through
    svg.append("rect")
      .attr("class", "map-interaction-background")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("fill", "transparent")
      .style("pointer-events", "none");

    // Add resize handler to update SVG dimensions
    const resizeHandler = () => {
      const newRect = container.getBoundingClientRect();
      if (svg) {
        svg.attr("width", newRect.width).attr("height", newRect.height);
      }
    };

    (window as any).trackLayerResizeHandler = resizeHandler;
    window.addEventListener('resize', resizeHandler);

    return trackOverlay;
  };

  // Render tracks using strategy pattern
  const renderTracks = (data: TrackPoint[], forceRedraw: boolean = false) => {
    // Don't render until source color is loaded
    if (!sourceColorLoaded()) {
      debug('[TrackLayer] Skipping render - source color not loaded yet');
      return;
    }

    if (!trackOverlay) {
      debug('[TrackLayer] Skipping render - trackOverlay is null');
      return;
    }

    if (!svg) {
      debug('[TrackLayer] Skipping render - svg is null');
      return;
    }

    if (!props.map) {
      debug('[TrackLayer] Skipping render - props.map is null');
      return;
    }

    if (isDrawing) {
      debug('[TrackLayer] Skipping render - already drawing');
      return;
    }

    isDrawing = true;

    try {
      // LOD: Store original data for redraw logic
      originalData = data;

      // LOD: Get current zoom level (from prop or map)
      const currentZoom = props.zoomLevel ?? props.map.getZoom();

      // LOD: Check if we need to redraw based on zoom level crossing even boundaries
      const needsRedraw = forceRedraw || shouldRedrawForZoom(currentZoom, lastRenderZoom);

      // Check timeWindow early to determine if we should force render
      // CRITICAL: Always render when timeWindow > 0 to ensure time window filtering is applied
      const currentTime = selectedTime();
      const effectiveTime = props.effectivePlaybackTime ?? null;
      const timeForFilter = effectiveTime ?? currentTime;
      const currentTimeWindow = timeWindow();
      const shouldRenderForTimeWindow = currentTimeWindow > 0;

      // Early return if no redraw needed and not forced (saves processing 26k+ points)
      // Note: forceRedraw=true is used when selection changes, so we always render in that case
      // When timeWindow is 0, we can skip if zoom hasn't changed (normal LOD behavior)
      if (!needsRedraw && !forceRedraw && !shouldRenderForTimeWindow) {
        isDrawing = false;
        return;
      }

      if (shouldRenderForTimeWindow) {
        debug('[TrackLayer] Forcing render due to active time window:', currentTimeWindow);
      }

      // Initialize scales and apply filters
      // Note: applyFilters only filters by selectedRange (brush) and cutEvents, not selectedRanges (events)
      // This allows the map to show full dataset with overlay for event selections
      untrack(() => { initScales(data, config); });
      const dataAfterBrush = applyFilters(data);
      let filteredData = dataAfterBrush;

      // Apply time window filtering if time window is active
      const beforeTimeWindowFilter = filteredData.length;
      if (currentTimeWindow > 0 && timeForFilter) {
        filteredData = filterDataByTimeWindow(filteredData, timeForFilter, currentTimeWindow);
        // Append interpolated point at timeForFilter so track extends smoothly to boat position
        const interp = getInterpolatedPointAtTime(dataAfterBrush, timeForFilter, { getTimestamp, getLat, getLng });
        if (interp) filteredData = [...filteredData, interp];
        debug(`[TrackLayer] Time window filter applied: ${beforeTimeWindowFilter} -> ${filteredData.length} points (window: ${currentTimeWindow} min, time: ${currentTime.toISOString()})`);
      } else if (currentTimeWindow === 0) {
        // When timeWindow === 0 (Full), show all data (after brush filtering if active)
        // applyFilters already handles brush selection, so filteredData is correct
        // No additional time-based filtering needed
        debug(`[TrackLayer] Time window is 0 (Full) - showing all data: ${filteredData.length} points`);
      } else {
        debug(`[TrackLayer] Time window filter skipped: timeWindow=${currentTimeWindow}, hasCurrentTime=${!!currentTime}`);
      }

      // LOD: Apply sampling based on current zoom level and point density
      const viewportBounds = getExpandedViewportBounds(props.map);
      const pointsBeforeLOD = filteredData.length;

      // Get combined sample rate (maximum of zoom-based and density-based)
      const lodInfo = getCombinedSampleRate(
        currentZoom,
        filteredData,
        viewportBounds,
        getLat,
        getLng,
        5000 // threshold: 5000 points
      );
      const sampleRate = lodInfo.sampleRate;

      // Apply sampling to data
      if (sampleRate > 1 && filteredData.length > 0) {
        // Sample the entire dataset as a single track
        filteredData = sampleTrack(filteredData, sampleRate, currentZoom);
      }

      // Calculate statistics for logging
      const totalPointsInData = data.reduce((sum, point) => sum + 1, 0);
      const totalPointsDrawn = filteredData.reduce((sum, point) => sum + 1, 0);
      const percentage = totalPointsInData > 0 ? ((totalPointsDrawn / totalPointsInData) * 100).toFixed(1) : '0.0';

      // Enhanced logging with density information
      const densityInfo = lodInfo.pointCountInViewport > 0
        ? `, Points in viewport: ${lodInfo.pointCountInViewport}, Density rate: ${lodInfo.densitySampleRate}x`
        : '';
      debug(`[TrackLayer] Map LOD: Zoom ${currentZoom.toFixed(2)}, Zoom rate: ${lodInfo.zoomSampleRate}x${densityInfo}, Combined rate: ${sampleRate}x, Points before LOD: ${pointsBeforeLOD}, Total points in data: ${totalPointsInData}, Points drawn: ${totalPointsDrawn} (${percentage}%)`);

      // Update lastRenderZoom to track current zoom level
      lastRenderZoom = currentZoom;

      // LOD: Update config with zoom level so it's available for gap detection in update functions
      config.zoomLevel = currentZoom;

      debug(`[TrackLayer] Before coordinate validation: ${filteredData.length} points`);

      // Validate that we have points with valid coordinates
      let validPoints: TrackPoint[] = [];
      let invalidCount = 0;
      filteredData.forEach((point, index) => {
        const lat = getLat(point);
        const lng = getLng(point);
        if (lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng)) {
          validPoints.push(point);
        } else {
          invalidCount++;
          if (invalidCount <= 3) {
            debug(`[TrackLayer] Invalid point ${index}: lat=${lat}, lng=${lng}, point keys:`, Object.keys(point));
          }
        }
      });

      debug(`[TrackLayer] Coordinate validation: ${validPoints.length} valid out of ${filteredData.length} total points (${invalidCount} invalid)`);

      if (validPoints.length < 2) {
        debug(`[TrackLayer] Not enough valid points to render: ${validPoints.length} valid out of ${filteredData.length} total`);
        return;
      }

      debug(`[TrackLayer] Validation passed, proceeding with ${validPoints.length} points`);

      // Use validated points
      filteredData = validPoints;
      currentFilteredData = filteredData; // Store for render function

      debug(`[TrackLayer] After validation: ${filteredData.length} points ready to render`);

      // Choose renderer based on maptype
      // Read props.maneuversEnabled - now tracked in the unified effect above
      // This will be reactive when the effect re-runs due to maneuversEnabled changes
      const maneuversEnabledValue = props.maneuversEnabled ?? true;

      // LOD: Adjust samplingFrequency based on the sample rate we applied
      // If we sampled at 4x, the effective frequency is 1/4 of original
      // This ensures gap detection works correctly with sampled data
      const effectiveSamplingFrequency = props.samplingFrequency / sampleRate;

      // LOD: Disable showGaps in config when zoom < 16 to prevent getColor/getThickness from returning transparent/0
      const effectiveConfig = {
        ...config,
        sourceColor: sourceColor(), // Pass the actual source color
        zoomLevel: currentZoom, // Pass zoom level for gap detection control
        showGaps: currentZoom >= 16 ? config.showGaps : false // Disable gap detection in color/thickness functions at low zoom
      };

      const rendererProps = {
        data: filteredData,
        map: props.map,
        svg: svg,
        trackOverlay: trackOverlay,
        config: effectiveConfig,
        onPointClick: props.onPointClick,
        onRangeSelect: props.onRangeSelect,
        onMouseOver: handleTrackMouseOver,
        onMouseOut: handleTrackMouseOut,
        samplingFrequency: effectiveSamplingFrequency,
        currentTime: currentTime,
        timeWindow: currentTimeWindow,
        tilesAvailable: props.tilesAvailable,
        getColor: getColorWrapper,
        getThickness: getThickness,
        maneuversEnabled: maneuversEnabledValue
      };

      debug(`[TrackLayer] About to render: filteredData.length=${filteredData.length}, maptype=${config.maptype}, hasMap=${!!props.map}, hasTrackOverlay=${!!trackOverlay}`);

      let result;
      if (config.maptype === "DEFAULT") {
        // Use continuous renderer for DEFAULT mode
        debug(`[TrackLayer] Using CONTINUOUS renderer (maptype=DEFAULT)`);
        result = renderContinuousTracks(rendererProps);
      } else {
        // Use segmented renderer for other modes
        debug(`[TrackLayer] Using SEGMENTED renderer (maptype=${config.maptype})`);
        result = renderSegmentedTracks(rendererProps);
      }

      if (!result.success) {
        logError('TrackLayer: renderer failed:', result.error);
      } else {
        debug(`[TrackLayer] Renderer succeeded: maptype=${config.maptype}, dataLength=${filteredData.length}`);
        // Ensure opacity is restored after rendering (in case it was hidden during zoom)
        if (trackOverlay) {
          trackOverlay.style('opacity', '1');
        }
      }

    } catch (error) {
      logError('TrackLayer: error in renderTracks:', error);
    } finally {
      isDrawing = false;
    }
  };

  // Hybrid track update system with movement detection and CSS transforms
  let isMapMoving = false;
  let lastUpdateTime = 0;
  let lastMapCenter = { lng: 0, lat: 0 };
  let lastZoom = 0;
  let lastBearing = 0;
  let lastPitch = 0;

  const UPDATE_THROTTLE_MS = 16; // ~60fps
  const MOVEMENT_THRESHOLD = 0.1; // pixels
  const ZOOM_THRESHOLD = 0.01;
  const ROTATION_THRESHOLD = 0.1; // degrees

  // Detect if map is currently moving
  const checkMapMovement = () => {
    if (!props.map) return false;

    const currentCenter = props.map.getCenter();
    const currentZoom = props.map.getZoom();
    const currentBearing = props.map.getBearing();
    const currentPitch = props.map.getPitch();

    const centerMoved = Math.abs(currentCenter.lng - lastMapCenter.lng) > MOVEMENT_THRESHOLD ||
      Math.abs(currentCenter.lat - lastMapCenter.lat) > MOVEMENT_THRESHOLD;
    const zoomChanged = Math.abs(currentZoom - lastZoom) > ZOOM_THRESHOLD;
    const bearingChanged = Math.abs(currentBearing - lastBearing) > ROTATION_THRESHOLD;
    const pitchChanged = Math.abs(currentPitch - lastPitch) > ROTATION_THRESHOLD;

    const moving = centerMoved || zoomChanged || bearingChanged || pitchChanged;

    if (moving) {
      lastMapCenter = currentCenter;
      lastZoom = currentZoom;
      lastBearing = currentBearing;
      lastPitch = currentPitch;
    }

    return moving;
  };

  // Update track positions with hybrid approach
  const updateTrackPositions = () => {
    if (!trackOverlay || !props.map || currentFilteredData.length === 0 || isUpdating) return;

    const now = performance.now();
    if (now - lastUpdateTime < UPDATE_THROTTLE_MS) return;

    // Check if map is moving
    isMapMoving = checkMapMovement();

    // Cancel any pending animation frame
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    // Use requestAnimationFrame to sync with browser rendering cycle
    animationFrameId = requestAnimationFrame(() => {
      performHybridTrackPositionUpdate();
      animationFrameId = null;
      lastUpdateTime = now;
    });
  };

  // Hybrid track position update logic
  const performHybridTrackPositionUpdate = () => {
    if (!trackOverlay || !props.map || currentFilteredData.length === 0 || isUpdating) return;

    isUpdating = true;

    if (isMapMoving) {
      // During movement, use CSS transforms for smooth performance
      performTransformBasedUpdate();
    } else {
      // When stationary, do full coordinate updates for accuracy
      performFullCoordinateUpdate();
    }

    isUpdating = false;
  };

  // Fast transform-based update during map movement
  const performTransformBasedUpdate = () => {
    if (!props.map) return;

    // Some map implementations don't expose getTransform().
    // If unavailable, fall back to a full coordinate update.
    const hasGetTransform = typeof (props.map as any).getTransform === 'function';
    if (hasGetTransform) {
      const transform = (props.map as any).getTransform();
      trackOverlay.attr('transform', `translate(${transform.x}, ${transform.y}) scale(${transform.scale})`);
      trackOverlay.style('opacity', '0.9');
      return;
    }

    // Fallback: recompute coordinates immediately
    performFullCoordinateUpdate();
    trackOverlay.style('opacity', '0.9');
  };

  // Full coordinate update when map is stationary
  const performFullCoordinateUpdate = () => {
    // Reset opacity to full when stationary
    trackOverlay.style('opacity', '1.0');

    // Update line positions (for segmented renderer)
    const lines = trackOverlay.selectAll(".interactive-line").filter("line");
    if (lines.size() > 0) {
      // LOD: Disable gap detection when zoom < 16 to prevent breaking sampled tracks
      const currentZoom = props.zoomLevel ?? props.map?.getZoom() ?? 16;
      const disableGapDetection = currentZoom < 16;
      const gapThresholdMs = disableGapDetection ? Infinity : 3000;

      // For segmented lines, update each line element
      // Track which line index we're updating (skip gaps)
      let lineIndex = 0;
      for (let i = 1; i < currentFilteredData.length && lineIndex < lines.size(); i++) {
        const prev = currentFilteredData[i - 1];
        const curr = currentFilteredData[i];

        // Check for time gap - if > threshold, skip this segment (unless small gap at consecutive leg boundary)
        // When zoom < 12, gap detection is disabled (gapThresholdMs = Infinity)
        if (prev && curr && prev.Datetime && curr.Datetime) {
          const timeDiff = Math.abs(new Date(curr.Datetime).getTime() - new Date(prev.Datetime).getTime());
          const prevLeg = getLegNum(prev);
          const currLeg = getLegNum(curr);
          const bridgeLegBoundary =
            prevLeg !== undefined &&
            currLeg !== undefined &&
            timeDiff > gapThresholdMs &&
            timeDiff <= LEG_BOUNDARY_BRIDGE_MS &&
            Math.abs((currLeg ?? 0) - (prevLeg ?? 0)) === 1;
          if (timeDiff > gapThresholdMs && !bridgeLegBoundary) {
            // Skip this segment - don't update this line (it should be hidden/removed)
            continue;
          }
        }

        const line = lines.nodes()[lineIndex];
        if (line && prev && curr) {
          const prevLat = getLat(prev);
          const prevLng = getLng(prev);
          const currLat = getLat(curr);
          const currLng = getLng(curr);

          if (prevLat === undefined || prevLng === undefined || currLat === undefined || currLng === undefined) {
            lineIndex++;
            continue;
          }

          const x1 = props.map.project([prevLng, prevLat]).x;
          const y1 = props.map.project([prevLng, prevLat]).y;
          const x2 = props.map.project([currLng, currLat]).x;
          const y2 = props.map.project([currLng, currLat]).y;
          d3.select(line)
            .attr("x1", x1)
            .attr("y1", y1)
            .attr("x2", x2)
            .attr("y2", y2)
            .style("opacity", 1); // Make sure line is visible
          lineIndex++;
        }
      }

      // Hide any remaining lines that shouldn't be visible (due to gaps or fewer segments)
      for (let i = lineIndex; i < lines.size(); i++) {
        const line = lines.nodes()[i];
        if (line) {
          d3.select(line)
            .style("opacity", 0); // Hide the line
        }
      }
    }

    // Update path positions (for continuous renderer)
    const paths = trackOverlay.selectAll(".interactive-line").filter("path");
    if (paths.size() > 0) {
      // For continuous paths, we need to regenerate the path data
      const lineGenerator = d3.line<TrackPoint>()
        .x(d => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          if (dLat === undefined || dLng === undefined) return 0;
          return props.map.project([dLng, dLat]).x;
        })
        .y(d => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          if (dLat === undefined || dLng === undefined) return 0;
          return props.map.project([dLng, dLat]).y;
        });

      // Create continuous segments with gap detection (same logic as ContinuousTrackRenderer)
      const segments = createContinuousSegmentsForUpdate(currentFilteredData, props.samplingFrequency, config);

      // Update each path with new coordinates
      // Selection overlay paths have data bound via .datum(), use that data
      // Regular paths use the segments array
      paths.each(function (d, i) {
        const pathElement = d3.select(this);
        const isSelection = pathElement.classed("selection-overlay");

        if (isSelection && d) {
          // For selection paths, the data is bound via .datum(segment)
          // This data will be automatically available as 'd' parameter
          if (d && Array.isArray(d) && d.length > 1) {
            // Re-generate path with updated coordinates using the bound data
            pathElement.attr("d", lineGenerator);
          }
        } else if (segments[i] && segments[i].length > 1) {
          // For regular tracks, use the segments array
          pathElement.attr("d", lineGenerator(segments[i]));
        }
      });
    }

    // Update maneuver marker positions
    trackOverlay.selectAll<SVGCircleElement, TrackPoint>(".maneuver-circle")
      .attr("cx", (d: TrackPoint) => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (dLat === undefined || dLng === undefined) return 0;
        return props.map.project([dLng, dLat]).x;
      })
      .attr("cy", (d: TrackPoint) => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (dLat === undefined || dLng === undefined) return 0;
        return props.map.project([dLng, dLat]).y;
      });

    trackOverlay.selectAll<SVGTextElement, TrackPoint>(".maneuver-label")
      .attr("x", (d: TrackPoint) => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (dLat === undefined || dLng === undefined) return 0;
        return props.map.project([dLng, dLat]).x + 5;
      })
      .attr("y", (d: TrackPoint) => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (dLat === undefined || dLng === undefined) return 0;
        return props.map.project([dLng, dLat]).y + 5;
      });
  };

  // Max gap (ms) we still bridge at a consecutive leg boundary (e.g. leg 0 -> leg 1)
  const LEG_BOUNDARY_BRIDGE_MS = 2500;
  const getLegNum = (p: TrackPoint): number | undefined => {
    const v = p?.leg_number ?? p?.Leg_number ?? p?.LEG;
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // Helper function to create continuous segments for path updates
  const createContinuousSegmentsForUpdate = (data: TrackPoint[], samplingFrequency: number, config: any): TrackPoint[][] => {
    const segments: TrackPoint[][] = [];
    let currentSegment: TrackPoint[] = [];

    // LOD: Disable gap detection when zoom < 16 to prevent breaking sampled tracks
    const zoomLevel = config.zoomLevel ?? props.map?.getZoom() ?? 16;
    const disableGapDetection = zoomLevel < 16;

    const expectedInterval = 1000 / samplingFrequency;
    const gapThreshold = disableGapDetection ? Infinity : (config.gapThreshold || (expectedInterval * 3));

    data.forEach((point, index) => {
      if (index === 0) {
        currentSegment.push(point);
      } else {
        const prevPoint = data[index - 1];
        const timeDiff = Math.abs(new Date(point.Datetime).getTime() - new Date(prevPoint.Datetime).getTime());
        const prevLeg = getLegNum(prevPoint);
        const currLeg = getLegNum(point);
        const bridgeLegBoundary =
          prevLeg !== undefined &&
          currLeg !== undefined &&
          timeDiff > gapThreshold &&
          timeDiff <= LEG_BOUNDARY_BRIDGE_MS &&
          Math.abs((currLeg ?? 0) - (prevLeg ?? 0)) === 1;

        // Break segment only on time gaps (not on grade/event changes for continuous rendering)
        // When zoom < 12, gap detection is disabled (gapThreshold = Infinity). Don't break for small leg-boundary gaps.
        if (timeDiff > gapThreshold && !bridgeLegBoundary) {
          // Complete the current segment
          if (currentSegment.length > 1) {
            segments.push([...currentSegment]);
          }
          currentSegment = [point]; // Start new segment
        } else {
          currentSegment.push(point);
        }
      }
    });

    // Add the last segment
    if (currentSegment.length > 1) {
      segments.push([...currentSegment]);
    }

    return segments;
  };

  // Handle track click for time selection
  const handleTrackClick = (event: MouseEvent, points: TrackPoint[]) => {
    if (!props.onPointClick) return;

    // Find the closest point to the click
    const [mouseX, mouseY] = d3.pointer(event, trackOverlay.node());
    let closestPoint = points[0];
    let minDistance = Infinity;

    points.forEach(point => {
      const pointLat = getLat(point);
      const pointLng = getLng(point);
      if (pointLat === undefined || pointLng === undefined) return;
      const mapPoint = props.map.project([pointLng, pointLat]);
      const distance = Math.sqrt(
        Math.pow(mouseX - mapPoint.x, 2) + Math.pow(mouseY - mapPoint.y, 2)
      );
      if (distance < minDistance) {
        minDistance = distance;
        closestPoint = point;
      }
    });

    props.onPointClick(closestPoint);
  };

  // Handle track mouse down for range selection
  const handleTrackMouseDown = (event: MouseEvent, points: TrackPoint[]) => {
    // Implementation for range selection start
    debug('Track mouse down');
  };

  // Handle track mouse move for range selection
  const handleTrackMouseMove = (event: MouseEvent, points: TrackPoint[]) => {
    // Implementation for range selection update
  };

  // Handle track mouse up for range selection
  const handleTrackMouseUp = (event: MouseEvent, points: TrackPoint[]) => {
    // Implementation for range selection end
  };

  // Handle track mouse over for tooltip
  const handleTrackMouseOver = (event: MouseEvent, point: TrackPoint) => {
    const tooltipContent = getTooltipContent(point);

    // Use viewport coordinates (clientX/clientY) since tooltip uses position: fixed
    setTooltip({
      visible: true,
      content: tooltipContent,
      x: event.clientX,
      y: event.clientY,
    });
  };

  // Handle track mouse out for tooltip
  const handleTrackMouseOut = (event: MouseEvent) => {
    setTooltip({
      visible: false,
      content: "",
      x: 0,
      y: 0,
    });
  };

  // Track last selectedRange to detect changes and force redraw
  let lastSelectedRangeHash: string | null = null;
  let lastUnifiedDataLength = 0;
  let lastMaptype: string | null = null;

  // Unified effect to render tracks when data, maptype, or global filters change
  createEffect(() => {
    const currentData = props.data;
    const currentMaptype = maptype(); // Use store maptype for reactivity
    const currentMap = props.map;
    const currentTimeWindow = timeWindow();
    // Watch selectedRange and cutEvents to trigger re-render when brush selection changes
    const currentSelectedRange = selectedRange();
    const currentCutEvents = cutEvents();
    const currentHasSelection = hasSelection();
    // Watch sourceColorLoaded to trigger render when color becomes available
    const colorLoaded = sourceColorLoaded();
    // Watch maneuversEnabled to trigger re-render when zoom or toggle changes
    const currentManeuversEnabled = props.maneuversEnabled;

    // Check if data length changed significantly (e.g., brush clear going from filtered to full data)
    const currentDataLength = currentData?.length || 0;
    const dataLengthChanged = currentDataLength !== lastUnifiedDataLength;
    const significantDataChange = dataLengthChanged && Math.abs(currentDataLength - lastUnifiedDataLength) > (lastUnifiedDataLength * 0.1); // 10% change threshold

    // Check if selectedRange changed to force redraw
    const currentSelectedRangeHash = JSON.stringify(currentSelectedRange || []);
    const selectedRangeChanged = currentSelectedRangeHash !== lastSelectedRangeHash;
    if (selectedRangeChanged) {
      lastSelectedRangeHash = currentSelectedRangeHash;
      debug('TrackLayer: selectedRange changed, will force redraw', {
        oldHash: lastSelectedRangeHash,
        newHash: currentSelectedRangeHash,
        oldLength: lastSelectedRangeHash ? JSON.parse(lastSelectedRangeHash || '[]').length : 0,
        newLength: currentSelectedRange?.length || 0
      });
    }

    // Also check if hasSelection changed (going from true to false when clearing)
    let lastHasSelection = window.lastTrackLayerHasSelection;
    const hasSelectionChanged = currentHasSelection !== lastHasSelection;
    if (hasSelectionChanged) {
      window.lastTrackLayerHasSelection = currentHasSelection;
      debug('TrackLayer: hasSelection changed, will force redraw', {
        old: lastHasSelection,
        new: currentHasSelection
      });
    }

    // Check if maptype (color scheme) changed to force redraw
    const maptypeChanged = currentMaptype !== lastMaptype;
    if (maptypeChanged) {
      lastMaptype = currentMaptype;
      debug('TrackLayer: maptype changed, will force redraw', {
        old: lastMaptype,
        new: currentMaptype
      });
    }

    // Force redraw if selectedRange, hasSelection, maptype, or data length changed significantly
    const shouldForceRedraw = selectedRangeChanged || hasSelectionChanged || significantDataChange || maptypeChanged;

    // Update last data length for next comparison
    if (dataLengthChanged) {
      lastUnifiedDataLength = currentDataLength;
    }

    if (!currentData || currentData.length === 0 || !trackOverlay || !currentMap) {
      debug('TrackLayer: Skipping render - data:', currentData?.length, 'trackOverlay:', !!trackOverlay, 'map:', !!currentMap);
      return;
    }

    // Don't render until source color is loaded
    if (!colorLoaded) {
      debug('TrackLayer: Skipping render - source color not loaded yet');
      return;
    }

    // Skip render during initialization to prevent multiple renders
    if (!isInitialized) {
      debug('TrackLayer: Skipping render during initialization');
      return;
    }

    // When timeWindow is 0, add debouncing to prevent excessive redraws during animation
    if (currentTimeWindow === 0) {
      // Clear any existing timeout
      if (window.trackRenderTimeout) {
        clearTimeout(window.trackRenderTimeout);
      }

      // Debounce track rendering for better performance during animation
      // But if selection changed, render immediately to show full track
      const delay = shouldForceRedraw ? 0 : 100;
      window.trackRenderTimeout = setTimeout(() => {
        // Update config with current maptype
        config.maptype = currentMaptype;
        renderTracks(currentData, shouldForceRedraw); // Force redraw if selection changed
        window.trackRenderTimeout = null;
      }, delay); // Skip delay if selection changed
    } else {
      // When timeWindow > 0, render immediately
      // Update config with current maptype
      config.maptype = currentMaptype;
      renderTracks(currentData, shouldForceRedraw); // Force redraw if selection changed
    }
  });

  // Effect to re-render tracks when time window changes (but not selectedTime changes)
  createEffect(() => {
    const currentTimeWindow = timeWindow();
    const currentData = props.data;
    const colorLoaded = sourceColorLoaded();

    // Don't render until source color is loaded
    if (!colorLoaded) {
      return;
    }

    // Only re-render tracks when time window changes, not when selectedTime changes during animation
    if (currentData && currentData.length > 0 && trackOverlay && currentTimeWindow > 0) {

      // Add 2-second delay for performance when timeWindow > 0
      // Clear any existing timeout
      if (window.trackRedrawTimeout) {
        clearTimeout(window.trackRedrawTimeout);
      }

      // Set new timeout for delayed redraw
      window.trackRedrawTimeout = setTimeout(() => {
        debug('TrackLayer: Delayed track redraw for time window:', currentTimeWindow, 'minutes');
        renderTracks(currentData);
        window.trackRedrawTimeout = null;
      }, 2000); // 2-second delay
    }
  });

  // Effect to update positions when map moves - use Mapbox's render event for smooth updates
  createEffect(() => {
    if (props.map) {
      // Initialize movement detection state
      lastMapCenter = props.map.getCenter();
      lastZoom = props.map.getZoom();
      lastBearing = props.map.getBearing();
      lastPitch = props.map.getPitch();

      // Use 'render' event for smooth, frame-synced updates during map movements
      props.map.on("render", updateTrackPositions);

      // Add movement detection events
      props.map.on("movestart", () => {
        isMapMoving = true;
        debug('TrackLayer: Map movement started - using transform-based updates');
      });

      props.map.on("zoomstart", () => {
        isMapMoving = true;
        debug('TrackLayer: Map zoom started - using transform-based updates');
        // LOD: Hide tracks during zoom for better performance
        if (trackOverlay) {
          trackOverlay.style('opacity', '0');
        }
      });

      props.map.on("rotatestart", () => {
        isMapMoving = true;
        debug('TrackLayer: Map rotation started - using transform-based updates');
      });

      props.map.on("pitchstart", () => {
        isMapMoving = true;
        debug('TrackLayer: Map pitch started - using transform-based updates');
      });

      // Keep other events for immediate updates when needed
      props.map.on("moveend", () => {
        isMapMoving = false;
        debug('TrackLayer: Map movement ended - switching to full coordinate updates');
        // LOD: Check if viewport changed significantly and redraw is needed
        const currentZoom = props.zoomLevel ?? props.map.getZoom();
        if (shouldRedrawForZoom(currentZoom, lastRenderZoom) && originalData.length > 0) {
          debug('TrackLayer: Viewport changed significantly, triggering full redraw');
          renderTracks(originalData, true);
        } else {
          updateTrackPositions();
        }
      });

      props.map.on("zoomend", () => {
        isMapMoving = false;
        debug('TrackLayer: Map zoom ended - switching to full coordinate updates');
        // LOD: Show tracks and check if redraw is needed
        if (trackOverlay) {
          trackOverlay.style('opacity', '1');
        }
        // Check if we need to redraw based on zoom level
        const currentZoom = props.zoomLevel ?? props.map.getZoom();
        if (shouldRedrawForZoom(currentZoom, lastRenderZoom) && originalData.length > 0) {
          debug('TrackLayer: Zoom boundary crossed, triggering full redraw');
          renderTracks(originalData, true);
        } else {
          updateTrackPositions();
        }
      });

      props.map.on("rotateend", () => {
        isMapMoving = false;
        debug('TrackLayer: Map rotation ended - switching to full coordinate updates');
        updateTrackPositions();
      });

      props.map.on("pitchend", () => {
        isMapMoving = false;
        debug('TrackLayer: Map pitch ended - switching to full coordinate updates');
        updateTrackPositions();
      });

      props.map.on("viewreset", updateTrackPositions);
    }
  });

  onMount(() => {
    debug('TrackLayer: onMount called with maptype:', config.maptype);

    // Set initialization flag before creating overlay
    // This allows the overlay creation to trigger a render if data is already available
    isInitialized = true;

    createTrackOverlay();

    // Render data if it's already available and overlay was created synchronously
    // (If overlay creation was async, the render will happen in createTrackOverlay)
    if (props.data && props.data.length > 0 && props.map && trackOverlay) {
      debug('TrackLayer: Initial render on mount with', props.data.length, 'points');
      config.maptype = maptype(); // Use store maptype for reactivity
      renderTracks(props.data);
    }
  });

  // Effect to handle race condition: ensure tracks render when both map and data become available
  // Track last data length to prevent unnecessary re-renders when data reference changes but content is same
  let lastDataLength = 0;
  let hasRenderedInitialData = false;
  createEffect(() => {
    const currentMap = props.map;
    const currentData = props.data;
    const colorLoaded = sourceColorLoaded();

    // Only proceed if initialized and both map and data are available
    if (!isInitialized) return;
    if (!currentMap || !currentData || currentData.length === 0) return;
    // Don't render until source color is loaded
    if (!colorLoaded) {
      debug('TrackLayer: Map and data available but source color not loaded yet');
      return;
    }

    // If overlay doesn't exist yet, try to create it
    if (!trackOverlay) {
      debug('TrackLayer: Map and data available but no overlay, creating overlay...');
      createTrackOverlay();
      // After creating overlay, check again (will be handled by the render in createTrackOverlay or next effect run)
      return;
    }

    // Only render if data length actually changed or this is the first render
    // This prevents re-rendering when props.data gets a new array reference but same content
    const dataLengthChanged = currentData.length !== lastDataLength;
    if (!hasRenderedInitialData || dataLengthChanged) {
      debug('TrackLayer: Map and data availability effect - map:', !!currentMap, 'data length:', currentData.length, 'sourceColorLoaded:', colorLoaded, 'dataLengthChanged:', dataLengthChanged);

      // Use a small delay to ensure map is fully ready
      const timeoutId = setTimeout(() => {
        if (currentMap && currentData && currentData.length > 0 && trackOverlay) {
          debug('TrackLayer: Rendering tracks after map/data availability check');
          config.maptype = maptype(); // Use store maptype for reactivity
          // Force redraw when data length changes significantly (e.g., brush clear)
          const significantDataChange = Math.abs(currentData.length - lastDataLength) > (lastDataLength * 0.1); // 10% change threshold
          renderTracks(currentData, significantDataChange);
          lastDataLength = currentData.length;
          hasRenderedInitialData = true;
        }
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  });

  // Re-render tracks immediately when selectedTime changes and timeWindow > 0
  createEffect(() => {
    const currentTime = selectedTime();
    const currentTimeWindow = timeWindow();
    const colorLoaded = sourceColorLoaded();

    if (!props.map || !props.data || props.data.length === 0) return;
    if (!isInitialized) return;
    // Don't render until source color is loaded
    if (!colorLoaded) return;

    if (currentTime && currentTimeWindow > 0) {
      debug('TrackLayer: selectedTime changed with active timeWindow - re-rendering');
      renderTracks(props.data);
    }
  });

  // Effect to reinitialize scales when selectedEvents or selectedRanges changes
  // Also watch triggerSelection to ensure updates from maneuver pages trigger re-render
  // Track last selection state to prevent unnecessary re-renders
  let lastSelectedEventsHash: string | null = null;
  let lastSelectedRangesHash: string | null = null;
  let isFirstSelectionCheck = true;
  createEffect(() => {
    const currentSelectedEvents = selectedEvents();
    const currentSelectedRanges = selectedRanges();
    const currentTriggerSelection = triggerSelection();
    const currentData = props.data;
    const colorLoaded = sourceColorLoaded();

    // Create hash of selection state to detect actual changes
    const eventsHash = currentSelectedEvents ? JSON.stringify([...currentSelectedEvents].sort((a, b) => a - b)) : '';
    const rangesHash = currentSelectedRanges ? JSON.stringify(currentSelectedRanges.map(r => ({ start: r.start_time, end: r.end_time })).sort((a, b) => a.start.localeCompare(b.start))) : '';

    // On first check, just store the hash and don't render (initial state)
    if (isFirstSelectionCheck) {
      lastSelectedEventsHash = eventsHash;
      lastSelectedRangesHash = rangesHash;
      isFirstSelectionCheck = false;
      return;
    }

    const selectionChanged = eventsHash !== lastSelectedEventsHash || rangesHash !== lastSelectedRangesHash || currentTriggerSelection;

    // Don't render until source color is loaded
    if (!colorLoaded) {
      debug('TrackLayer: Selection effect - source color not loaded yet');
      return;
    }

    // Only re-render if selection actually changed or triggerSelection is set
    if (selectionChanged && currentData && currentData.length > 0 && trackOverlay) {
      debug('TrackLayer: Reinitializing scales due to selection change');
      initScales(currentData, config);
      debug('TrackLayer: Re-rendering tracks due to selection change');
      // Pass forceRedraw=true to ensure render happens even if zoom hasn't changed
      renderTracks(currentData, true);

      // Update hashes to track current state
      lastSelectedEventsHash = eventsHash;
      lastSelectedRangesHash = rangesHash;

      // Clear triggerSelection after handling it (similar to ManeuverMap)
      if (currentTriggerSelection) {
        setTriggerSelection(false);
      }
    }
  });

  onCleanup(() => {
    if (trackOverlay) {
      trackOverlay.remove();
    }
    if (svg) {
      svg.remove();
    }
    overlayContainer = null;
    if ((window as any).trackLayerResizeHandler) {
      window.removeEventListener('resize', (window as any).trackLayerResizeHandler);
      delete (window as any).trackLayerResizeHandler;
    }
    // Clean up track redraw timeout
    if (window.trackRedrawTimeout) {
      clearTimeout(window.trackRedrawTimeout);
      window.trackRedrawTimeout = null;
    }
    // Clean up track render timeout
    if (window.trackRenderTimeout) {
      clearTimeout(window.trackRenderTimeout);
      window.trackRenderTimeout = null;
    }
    // Clean up animation frame
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  });

  return null;
}
