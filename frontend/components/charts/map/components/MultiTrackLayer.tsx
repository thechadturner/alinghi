// @ts-nocheck
import { onMount, onCleanup, createEffect, createMemo, untrack } from "solid-js";
import type mapboxgl from "mapbox-gl";
import { sourcesStore } from "../../../../store/sourcesStore";
import { selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries } from "../../../../store/filterStore";
import { selectedEvents, selectedRanges, selectedRange, cutEvents, isCut } from "../../../../store/selectionStore";
import { selectedTime, timeWindow, playbackSpeed } from "../../../../store/playbackStore";
import { debug as logDebug, warn as logWarn } from "../../../../utils/console";
import { getColor } from "../utils/trackColors";
import { streamingStore } from "../../../../store/streamingStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { 
  getSampleRate, 
  sampleTrack, 
  shouldRedrawForZoom,
  getCombinedSampleRate,
  getExpandedViewportBounds
} from "../utils/lodUtils";
import { getInterpolatedPointAtTime } from "../../../../utils/trackInterpolation";

export interface MultiTrackLayerProps {
  data: any[];
  map: mapboxgl.Map;
  maptype: 'DEFAULT' | 'GRADE' | 'WIND' | 'VMG' | 'MANEUVERS';
  samplingFrequency: number;
  tilesAvailable?: boolean;
  selectedSourceIds: Set<number>;
  enableWebSocketUpdates?: boolean; // Flag to enable/disable WebSocket incremental updates (default: false)
  onPointClick?: (p: any) => void;
  onRangeSelect?: (a: any, b: any) => void;
  /** Source IDs to highlight (hovered + selected boats from FleetMap); tracks dim when non-empty */
  highlightedSourceIds?: Set<number>;
  /** When provided (time-window playback), use this instead of selectedTime so track ends at boat position */
  effectivePlaybackTime?: Date | null;
}

export default function MultiTrackLayer(props: MultiTrackLayerProps) {
  let d3: typeof import('d3') | null = null;
  let svgOverlay: any = null;
  let trackOverlay: any = null; // Group element inside SVG (like TrackLayer)
  let container: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;

  // Track last render time to throttle updates
  let lastRenderTime = 0;
  // Track last brush selection state to detect changes
  let lastBrushState = { hasSelection: false, rangeCount: 0, rangesCount: 0 };
  // Track last render state to detect timeWindow changes
  let lastRenderState: { timeWindow?: number } | null = null;
  // Track last processed data hash per source to avoid unnecessary updates
  const lastDataHash = new Map<number, string>();
  const GAP_THRESHOLD_MS = 10000; // 10 seconds
  // Bridge gap at consecutive leg boundary (e.g. leg 0 -> 1) up to same as normal threshold (LOD sampling can widen the apparent gap)
  const LEG_BOUNDARY_BRIDGE_MS = GAP_THRESHOLD_MS;
  const MIN_RENDER_INTERVAL_MS = 16; // ~60fps max during animation
  
  // LOD: Track last render zoom level for smart redraws
  let lastRenderZoom: number | null = null;

  const sourceKey = (d: any) => d?.source_id ?? d?.Source_id ?? d?.sourceId ?? d?.sourceID;

  // Get dynamic channel names from store
  const { latName, lngName } = defaultChannelsStore;

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

  // Helper function to get timestamp from data point
  const getTimestamp = (d: any): Date => {
    if (!d) return new Date(0);
    const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
    if (!timestamp) return new Date(0);
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date(0);
  };

  // Helper function to filter data by time window (same logic as TrackLayer)
  const filterDataByTimeWindow = (data: any[], currentTime: Date, windowMinutes: number): any[] => {
    if (windowMinutes === 0) return data; // Full window - return all data
    
    // Calculate window start (windowMinutes before currentTime)
    const windowStart = new Date(currentTime.getTime() - (windowMinutes * 60 * 1000));
    const windowEnd = currentTime;
    
    // Filter data to include past window
    const filteredData = data.filter(d => {
      const timestamp = getTimestamp(d);
      return timestamp >= windowStart && timestamp <= windowEnd;
    });
    
    return filteredData;
  };

  // Helper function to filter data by selected time ranges (brush selection)
  const filterDataBySelectedRanges = (data: any[]): any[] => {
    const ranges = selectedRanges();
    const singleRange = selectedRange();
    
    // Check if we have any range selection
    const activeRanges: Array<{ start_time: Date | string; end_time: Date | string }> = [];
    
    // Add selectedRanges (multiple ranges)
    if (Array.isArray(ranges) && ranges.length > 0) {
      activeRanges.push(...ranges);
    }
    
    // Add selectedRange (single range) if selectedRanges is empty
    if (activeRanges.length === 0 && Array.isArray(singleRange) && singleRange.length > 0) {
      activeRanges.push(...singleRange);
    }
    
    // If no ranges, return all data
    if (activeRanges.length === 0) {
      return data;
    }
    
    // Filter data to include only points within any of the selected ranges
    const filteredData = data.filter(d => {
      const timestamp = getTimestamp(d);
      const timestampMs = timestamp.getTime();
      
      // Check if point falls within any of the selected ranges
      return activeRanges.some(range => {
        const startTime = range.start_time instanceof Date 
          ? range.start_time.getTime() 
          : new Date(range.start_time).getTime();
        const endTime = range.end_time instanceof Date 
          ? range.end_time.getTime() 
          : new Date(range.end_time).getTime();
        
        return timestampMs >= startTime && timestampMs <= endTime;
      });
    });
    
    return filteredData;
  };


  // Group data by source and apply filtering (following TrackLayer pattern - no cache, filter props.data directly)
  const groupedData = createMemo(() => {
    // Track reactive dependencies to ensure memo updates
    const _selectedRange = selectedRange();
    const _selectedRanges = selectedRanges();
    const _selectedTime = selectedTime();
    const _effectiveTime = props.effectivePlaybackTime ?? null;
    const _timeWindow = Number(timeWindow()); // Coerce so chart and map use same window (sync may return string)
    // Use effective time (boat position) when provided so track ends at boat, not ahead of it
    const timeForFilter = _effectiveTime ?? _selectedTime;
    // Explicitly access props.data to create reactive dependency
    const _propsData = props.data;
    
    
    const groups = new Map<number, any[]>();
    let selected = props.selectedSourceIds || new Set<number>();
    const originalData = Array.isArray(_propsData) ? _propsData : [];

    // CRITICAL: Filter out data points without source_id before processing
    // This ensures we only process valid data points that can be grouped by source
    const validData = originalData.filter(pt => {
      const sid = sourceKey(pt);
      return sid !== undefined && sid !== null && Number.isFinite(Number(sid));
    });
    
    if (validData.length !== originalData.length) {
      logWarn('MultiTrackLayer: Filtered out data points without valid source_id', {
        originalCount: originalData.length,
        validCount: validData.length,
        filteredOut: originalData.length - validData.length
      });
    }

    // If no sources are selected but we have data, default to all sources in the data
    if (selected.size === 0 && validData.length > 0) {
      const sourcesInData = new Set<number>();
      for (const pt of validData) {
        const sid = Number(sourceKey(pt));
        if (Number.isFinite(sid)) {
          sourcesInData.add(sid);
        }
      }
      if (sourcesInData.size > 0) {
        selected = sourcesInData;
        logDebug('MultiTrackLayer: Auto-detected sources from data', {
          sourceCount: sourcesInData.size,
          sourceIds: Array.from(sourcesInData).slice(0, 10)
        });
      } else {
        logWarn('MultiTrackLayer: No valid sources found in data');
        return [];
      }
    } else if (selected.size === 0) {
      return [];
    }

    // Process each selected source
    for (const sid of selected) {
      const sourceId = Number(sid);
      if (!Number.isFinite(sourceId)) continue;
      
      // Get data for this source from validData (full timeline, already filtered for valid source_id)
      let sourceData = validData.filter(pt => Number(sourceKey(pt)) === sourceId);
      
      if (sourceData.length === 0) continue;
      
      // Store original source data before any filtering (for logging and fallback)
      const fullSourceData = [...sourceData];
      
      // Apply filtering following TrackLayer pattern:
      // 1. First apply brush selection filtering (if any)
      // 2. Then apply time window filtering (if timeWindow > 0)
      
      // Step 1: Apply brush selection filtering
      sourceData = filterDataBySelectedRanges(sourceData);
      
      // Step 2: Apply time window filtering if timeWindow > 0
      // CRITICAL: When timeWindow === 0, we MUST use the full data (after brush filtering only)
      // Do NOT apply time window filtering when timeWindow === 0
      if (_timeWindow > 0 && timeForFilter) {
        // Apply time window filter (use effectiveTime so track ends at boat position)
        const sourceDataBeforeWindow = sourceData;
        sourceData = filterDataByTimeWindow(sourceData, timeForFilter, _timeWindow);
        // Append interpolated point at timeForFilter so track extends smoothly to boat per source
        const interp = getInterpolatedPointAtTime(sourceDataBeforeWindow, timeForFilter, { getTimestamp, getLat, getLng });
        if (interp) sourceData = [...sourceData, interp];
      } else if (_timeWindow === 0) {
        // timeWindow === 0 means show ALL data (after brush filtering if needed)
        // sourceData already has brush filtering applied (or full data if no brush)
        // Verify we have the expected amount of data
        const expectedLength = fullSourceData.length; // Full data for this source
        const actualLength = sourceData.length;
        
        // If we somehow have less data than expected and there's no brush selection,
        // something went wrong - use the full source data as fallback
        if (actualLength < expectedLength && 
            !(Array.isArray(_selectedRange) && _selectedRange.length > 0) &&
            !(Array.isArray(_selectedRanges) && _selectedRanges.length > 0)) {
          logWarn('MultiTrackLayer: Data length mismatch, using full source data', {
            sourceId,
            actualLength,
            expectedLength
          });
          sourceData = fullSourceData;
        }
      }
      
      if (sourceData.length > 0) {
        groups.set(sourceId, sourceData);
      }
    }

    const result = Array.from(groups.entries()).map(([sid, data]) => {
      // Get source info for color
      const sources = sourcesStore.sources();
      const sourceInfo = sources.find(s => Number(s.source_id) === Number(sid));
      const color = sourceInfo?.color || '#1f77b4';
      const name = sourceInfo?.source_name || String(sid);

      //logDebug('MultiTrackLayer: Map Data', name, data)
      
      // Filter out invalid data points (must have coordinates)
      // Use dynamic channel names from store
      const validData = data.filter(d => {
        const lng = getLng(d);
        const lat = getLat(d);
        return lng !== undefined && lat !== undefined && Number.isFinite(lng) && Number.isFinite(lat);
      });
      
      // Sort data by timestamp/Datetime to ensure proper track rendering
      // This is critical - tracks must be drawn in chronological order
      const sortedData = [...validData].sort((a, b) => {
        const aTime = getTimestamp(a).getTime();
        const bTime = getTimestamp(b).getTime();
        return aTime - bTime;
      });
      
      // When timeWindow === 0 (full timeline), filter track data to include points up to 1 second ahead
      // of selectedTime. This ensures the track extends slightly ahead of the boat position during animation,
      // preventing the boat from appearing ahead of its track.
      let trackData = sortedData;
      if (_timeWindow === 0 && _selectedTime) {
        const currentTime = _selectedTime.getTime();
        const futureTime = currentTime + 1000; // 1 second ahead
        trackData = sortedData.filter(d => {
          const pointTime = getTimestamp(d).getTime();
          return pointTime <= futureTime;
        });
      } else {
        // For timeWindow > 0, the time window filtering already happened above
        // For other cases, use all sorted data
        trackData = sortedData;
      }
      
      return { sourceId: sid, sourceName: name, color, data: trackData };
    });

    // Log grouped data result for debugging
    if (result.length > 0) {
      logDebug('MultiTrackLayer: groupedData result', {
        groupsCount: result.length,
        totalPoints: result.reduce((sum, g) => sum + (g.data?.length || 0), 0),
        groups: result.map(g => ({
          sourceId: g.sourceId,
          sourceName: g.sourceName,
          dataLength: g.data?.length || 0,
          samplePoint: g.data?.[0] ? {
            hasLat: getLat(g.data[0]) !== undefined,
            hasLng: getLng(g.data[0]) !== undefined,
            source_id: g.data[0].source_id,
            keys: Object.keys(g.data[0]).slice(0, 10)
          } : null
        }))
      });
    } else {
      logDebug('MultiTrackLayer: groupedData returned empty result', {
        originalDataLength: originalData.length,
        selectedSourcesSize: selected.size,
        selectedSources: Array.from(selected)
      });
    }

    return result;
  });

  // Initialize SVG overlay
  const initSVG = () => {
    if (!props.map || !d3) {
      return;
    }

    // Wait for map to be fully loaded (not just style loaded)
    if (!props.map.loaded()) {
      props.map.once('load', () => {
        // Add a small delay to ensure container dimensions are calculated
        setTimeout(() => {
          initSVG();
        }, 50);
      });
      return;
    }

    // Also wait for style to be loaded
    if (!props.map.isStyleLoaded()) {
      props.map.once('styledata', () => {
        initSVG();
      });
      return;
    }

    // Remove existing overlay if present
    d3.select(".track-overlay").remove();

    // Use the same approach as TrackLayer - attach to mapboxgl-canvas-container
    let container: HTMLElement | null = null;
    
    // Try getCanvasContainer first (preferred method)
    if (props.map && typeof props.map.getCanvasContainer === 'function') {
      try {
        container = props.map.getCanvasContainer() as HTMLElement;
      } catch (e) {
        // Fallback to other methods
      }
    }
    
    // Fallback 1: Try to find mapboxgl-canvas-container via querySelector
    if (!container && props.map) {
      try {
        const mapContainer = props.map.getContainer();
        if (mapContainer) {
          container = mapContainer.querySelector('.mapboxgl-canvas-container') as HTMLElement;
        }
      } catch (e) {
        // Continue to next fallback
      }
    }
    
    // Fallback 2: Use .map element directly
    if (!container) {
      container = d3.select(".map").node() as HTMLElement;
    }
    
    if (!container) {
      setTimeout(() => {
        initSVG();
      }, 100);
      return;
    }
    
    const mapRect = container.getBoundingClientRect();
    const clientWidth = container.clientWidth || mapRect.width;
    const clientHeight = container.clientHeight || mapRect.height;
    const containerWidth = mapRect.width || clientWidth || 0;
    const containerHeight = mapRect.height || clientHeight || 0;
    
    // Use fallback dimensions like TrackLayer does (instead of retrying)
    const width = containerWidth || 800;
    const height = containerHeight || 600;
    
    
    const svg = d3.select(container)
      .append("svg")
      .attr("class", "track-overlay")
      .attr("width", width)
      .attr("height", height)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("pointer-events", "none")
      .style("z-index", "100");

    svgOverlay = svg;
    
    // Create group element inside SVG for tracks (like TrackLayer)
    trackOverlay = svg.append("g").attr("class", "track-layer");
    
    // If we used fallback dimensions, set up a ResizeObserver to update when real dimensions are available
    if (containerWidth === 0 || containerHeight === 0) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width: newWidth, height: newHeight } = entry.contentRect;
          if (newWidth > 0 && newHeight > 0 && svgOverlay) {
            svgOverlay
              .attr("width", newWidth)
              .attr("height", newHeight);
            // Trigger render once dimensions are available
            render();
            if (resizeObserver) {
              resizeObserver.disconnect();
              resizeObserver = null;
            }
          }
        }
      });
      resizeObserver.observe(container);
    }
    
    // Render tracks now that SVG is ready
    if (props.map) {
      render();
    }
  };

  // Project lat/lng to pixel coordinates (updated to match TrackLayer pattern)
  // Note: This function is kept for backward compatibility but line generator now uses direct projection

  // Simple hash function for data comparison
  const hashData = (data: any[]): string => {
    if (!data || data.length === 0) return '';
    // Use first, middle, and last point timestamps + length as hash
    const first = getTimestamp(data[0])?.getTime() || 0;
    const middle = getTimestamp(data[Math.floor(data.length / 2)])?.getTime() || 0;
    const last = getTimestamp(data[data.length - 1])?.getTime() || 0;
    return `${data.length}-${first}-${middle}-${last}`;
  };

  // Render all tracks
  const render = () => {
    if (!trackOverlay || !svgOverlay || !props.map || !d3) {
      logDebug('MultiTrackLayer: render() called but conditions not met', {
        hasTrackOverlay: !!trackOverlay,
        hasSvgOverlay: !!svgOverlay,
        hasMap: !!props.map,
        hasD3: !!d3
      });
      return;
    }
    
    logDebug('MultiTrackLayer: render() executing', {
      hasTrackOverlay: !!trackOverlay,
      hasSvgOverlay: !!svgOverlay,
      hasMap: !!props.map,
      dataLength: props.data?.length || 0,
      selectedTime: selectedTime()?.toISOString(),
      timeWindow: timeWindow()
    });

    // Throttle render calls during animation to reduce frequency
    // But allow immediate renders when time changes (for smooth animation)
    const now = performance.now();
    const timeSinceLastRender = now - lastRenderTime;
    if (timeSinceLastRender < MIN_RENDER_INTERVAL_MS) {
      // Only skip if this is a rapid re-render (not a time change)
      // Allow render if enough time has passed or if it's a time-based update
      const currentTime = selectedTime();
      const lastKnownTime = (window as any).lastMultiTrackLayerTime;
      const timeChanged = currentTime && lastKnownTime && currentTime.getTime() !== lastKnownTime.getTime();
      
      if (!timeChanged) {
        logDebug('MultiTrackLayer: Throttling render call', { timeSinceLastRender });
        return; // Skip this render call
      }
    }
    lastRenderTime = now;
    if (selectedTime()) {
      (window as any).lastMultiTrackLayerTime = selectedTime();
    }

    // LOD: Get current zoom level
    const currentZoom = props.map.getZoom();
    
    // LOD: Check if we need to redraw based on zoom level crossing even boundaries
    const needsRedraw = shouldRedrawForZoom(currentZoom, lastRenderZoom);
    
    // Check if zoom level crossed a threshold for logging (before updating lastRenderZoom)
    const shouldLogLOD = lastRenderZoom === null || 
                        Math.floor(currentZoom / 2) !== Math.floor((lastRenderZoom || 0) / 2);
    
    // Update lastRenderZoom
    lastRenderZoom = currentZoom;

    const groups = groupedData();
    
    logDebug('MultiTrackLayer: render() - groupedData', {
      groupsCount: groups.length,
      totalPoints: groups.reduce((sum, g) => sum + (g.data?.length || 0), 0),
      groups: groups.map(g => ({
        sourceId: g.sourceId,
        sourceName: g.sourceName,
        dataLength: g.data?.length || 0,
        color: g.color
      }))
    });
    
    if (groups.length === 0) {
      logDebug('MultiTrackLayer: No groups to render, clearing paths');
      trackOverlay.selectAll("path.track-line").remove();
      return;
    }
    
    // LOD: Get viewport bounds once for all groups
    const viewportBounds = getExpandedViewportBounds(props.map);
    
    // LOD: Apply sampling based on current zoom level and point density for each group
    const sampledGroups = groups.map(group => {
      const pointsBeforeLOD = group.data.length;
      
      // Get combined sample rate (maximum of zoom-based and density-based)
      const lodInfo = getCombinedSampleRate(
        currentZoom,
        group.data,
        viewportBounds,
        getLat,
        getLng,
        5000 // threshold: 5000 points
      );
      const sampleRate = lodInfo.sampleRate;
      
      // Apply sampling to data if needed
      let sampledData = group.data;
      if (sampleRate > 1 && group.data.length > 0) {
        sampledData = sampleTrack(group.data, sampleRate, currentZoom);
      }
      
      // Only log LOD info when zoom level crosses a threshold or on first render
      if (shouldLogLOD) {
        const densityInfo = lodInfo.pointCountInViewport > 0 
          ? `, Points in viewport: ${lodInfo.pointCountInViewport}, Density rate: ${lodInfo.densitySampleRate}x`
          : '';
        logDebug(`[MultiTrackLayer] LOD: Source ${group.sourceId}, Zoom ${currentZoom.toFixed(3)}, Zoom rate: ${lodInfo.zoomSampleRate}x${densityInfo}, Combined rate: ${sampleRate}x, Points before: ${pointsBeforeLOD}, Points after: ${sampledData.length} (${((sampledData.length / pointsBeforeLOD) * 100).toFixed(1)}%)`);
      }
      
      return {
        ...group,
        data: sampledData
      };
    });

    // Gap threshold: Use the constant defined at the top (10 seconds)
    // This prevents paths from breaking into too many small segments
    const gapThresholdMs = GAP_THRESHOLD_MS;
    
    // Check if we're in cut mode with multiple ranges
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    const hasMultipleCutRanges = currentIsCut && currentCutEvents && currentCutEvents.length > 1;
    
    // Helper to check which cut range a point belongs to
    const getCutRangeIndex = (point: any): number => {
      if (!hasMultipleCutRanges) return -1;
      const pointTime = new Date(point.Datetime || point.timestamp || point.time).getTime();
      
      for (let i = 0; i < currentCutEvents.length; i++) {
        const range = currentCutEvents[i];
        if (typeof range === 'number') continue;
        
        if (range.start_time && range.end_time) {
          const startTime = new Date(range.start_time).getTime();
          const endTime = new Date(range.end_time).getTime();
          if (pointTime >= startTime && pointTime <= endTime) {
            return i;
          }
        }
      }
      return -1;
    };
    
    // Helper to get leg number from a point
    const getLegNum = (p: any): number | undefined => {
      const v = p?.leg_number ?? p?.Leg_number ?? p?.LEG;
      if (v === undefined || v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // Helper to check if there's a gap between two points
    const hasGap = (d: any, i: number, data: any[]) => {
      if (i === 0) return false; // Always define first point (no gap before first point)
      const prev = data[i - 1];
      const prevTime = new Date(prev.Datetime || prev.timestamp || prev.time).getTime();
      const currTime = new Date(d.Datetime || d.timestamp || d.time).getTime();
      const gap = currTime - prevTime;
      
      // Check for time gap
      if (gap > gapThresholdMs) {
        // Don't create gap for small consecutive leg boundary (e.g. leg 0 -> 1)
        const prevLeg = getLegNum(prev);
        const currLeg = getLegNum(d);
        const bridgeLegBoundary =
          prevLeg !== undefined &&
          currLeg !== undefined &&
          gap <= LEG_BOUNDARY_BRIDGE_MS &&
          Math.abs((currLeg ?? 0) - (prevLeg ?? 0)) === 1;
        if (bridgeLegBoundary) return false;
        return true;
      }
      
      // Check for cut range boundary
      if (hasMultipleCutRanges) {
        const prevRangeIndex = getCutRangeIndex(prev);
        const currRangeIndex = getCutRangeIndex(d);
        if (prevRangeIndex !== currRangeIndex && (prevRangeIndex >= 0 || currRangeIndex >= 0)) {
          return true; // Different cut ranges - create gap
        }
      }
      
      return false;
    };

    // Create line generator with gap detection (matching TrackLayer pattern)
    const lineGenerator = d3.line()
      .x((d: any) => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) return 0;
        return props.map.project([dLng, dLat]).x;
      })
      .y((d: any) => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) return 0;
        return props.map.project([dLng, dLat]).y;
      })
      .defined((d: any, i: number, data: any[]) => {
        const lng = getLng(d);
        const lat = getLat(d);
        // Check if coordinates are valid
        if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
          return false;
        }
        // Create gap if time difference > threshold OR cut range boundary
        const hasGapResult = hasGap(d, i, data);
        return !hasGapResult;
      });

    // Render using trackOverlay group (like TrackLayer)
    // Generate path data first, validate it, then create/update paths
    sampledGroups.forEach((group) => {
      if (!group.data || group.data.length < 2) {
        logDebug('MultiTrackLayer: Skipping group with insufficient data', {
          sourceId: group.sourceId,
          dataLength: group.data?.length || 0
        });
        return;
      }

      // Generate path data first (matching TrackLayer pattern)
      // Skip the latest datapoint - exclude the last point from track rendering
      const trackData = group.data.length > 1 ? group.data.slice(0, -1) : group.data;
      const pathData = lineGenerator(trackData);
      
      // Debug: Check how many points were actually used in the path
      // Note: trackData excludes the last point, so we check against trackData
      const validPoints = trackData.filter((d: any, i: number) => {
        const lng = getLng(d);
        const lat = getLat(d);
        if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) return false;
        if (i === 0) return true; // First point always valid
        return !hasGap(d, i, trackData);
      });
      
      if (validPoints.length !== trackData.length) {
        logDebug('MultiTrackLayer: Some points filtered out in path generation', {
          sourceId: group.sourceId,
          sourceName: group.sourceName,
          totalPoints: group.data.length,
          trackDataPoints: trackData.length,
          validPoints: validPoints.length,
          filteredOut: trackData.length - validPoints.length,
          lastPointExcluded: group.data.length > 1
        });
      }
      
      // Validate path data before rendering (like TrackLayer line 214)
      if (!pathData || pathData === null || pathData === '' || pathData === 'MNaN,NaNMNaN,NaN') {
        logDebug('MultiTrackLayer: Skipping invalid path data', {
          sourceId: group.sourceId,
          sourceName: group.sourceName,
          dataLength: group.data.length,
          validPointsCount: validPoints.length,
          pathData: pathData,
          firstPoint: group.data[0] ? {
            lat: getLat(group.data[0]),
            lng: getLng(group.data[0]),
            projected: group.data[0] ? props.map.project([getLng(group.data[0]) || 0, getLat(group.data[0]) || 0]) : null
          } : null,
          sampleInvalidPoints: group.data.slice(0, 10).filter((d: any) => {
            const lng = getLng(d);
            const lat = getLat(d);
            return lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat);
          }).slice(0, 3).map((d: any) => ({
            hasLat: getLat(d) !== undefined,
            hasLng: getLng(d) !== undefined,
            keys: Object.keys(d).slice(0, 10)
          }))
        });
        return;
      }

      // Check if path already exists for this source
      // Use selectAll and filter to find the path with matching source ID
      const allPaths = trackOverlay.selectAll("path.track-line");
      const matchingPaths = allPaths.filter(function() {
        const sourceIdAttr = d3.select(this).attr("data-source-id");
        return sourceIdAttr && Number(sourceIdAttr) === group.sourceId;
      });
      
      if (matchingPaths.empty()) {
        // Create new path
        logDebug('MultiTrackLayer: Creating new path', {
          sourceId: group.sourceId,
          sourceName: group.sourceName,
          dataLength: group.data.length
        });
        
        trackOverlay.append("path")
          .attr("class", "track-line")
          .attr("data-source-id", group.sourceId)
          .attr("d", pathData)
          .attr("stroke", group.color)
          .attr("stroke-width", "1px")
          .attr("stroke-linecap", "round")
          .attr("stroke-linejoin", "round")
          .attr("fill", "none");
      } else {
        // Update existing path(s) - should only be one, but handle multiple just in case
        logDebug('MultiTrackLayer: Updating existing path', {
          sourceId: group.sourceId,
          sourceName: group.sourceName,
          dataLength: group.data.length,
          pathDataLength: pathData?.length || 0,
          pathDataPreview: pathData?.substring(0, 50),
          matchingPathsCount: matchingPaths.size()
        });
        matchingPaths
          .attr("d", pathData)
          .attr("stroke", group.color);
      }
    });
    
    // Remove paths for sources that are no longer in sampledGroups
    const currentSourceIds = new Set(sampledGroups.map(g => g.sourceId));
    trackOverlay.selectAll("path.track-line").each(function() {
      const pathEl = d3.select(this);
      const sourceId = pathEl.attr("data-source-id");
      if (sourceId && !currentSourceIds.has(Number(sourceId))) {
        logDebug('MultiTrackLayer: Removing path for deselected source', { sourceId });
        pathEl.remove();
      }
    });
    
    // Log final path count
    const finalPathCount = trackOverlay.selectAll("path.track-line").size();
    logDebug('MultiTrackLayer: Render complete', {
      finalPathCount,
      expectedCount: sampledGroups.length,
      trackOverlayExists: !!trackOverlay,
      svgOverlayExists: !!svgOverlay
    });
  };

  // Update on map move/zoom
  const updateOnMapChange = () => {
    if (!props.map || !d3) return;
    
    // For SVG, re-render on move/zoom
    props.map.on('move', render);
    props.map.on('zoom', render);
    
    // Also listen for resize to update SVG dimensions
    props.map.on('resize', () => {
      if (svgOverlay && d3) {
        const mapElement = d3.select(".map").node() as HTMLElement;
        if (mapElement) {
          const mapRect = mapElement.getBoundingClientRect();
          const containerWidth = mapRect.width || 0;
          const containerHeight = mapRect.height || 0;
          
          if (containerWidth > 0 && containerHeight > 0) {
            svgOverlay
              .attr("width", containerWidth)
              .attr("height", containerHeight);
            render();
          }
        }
      }
    });
  };

  // Cleanup
  const cleanup = () => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (trackOverlay) {
      trackOverlay.remove();
      trackOverlay = null;
    }
    if (svgOverlay) {
      svgOverlay.remove();
      svgOverlay = null;
    }
    if (props.map) {
      props.map.off('move');
      props.map.off('zoom');
      props.map.off('resize');
    }
    // Clear optimization hashes
    lastDataHash.clear();
  };

  // Mount
  onMount(async () => {
    // Load d3 dynamically
    d3 = await import('d3');
    
    if (props.map) {
      initSVG();
      updateOnMapChange();
    }
  });

  // Ensure SVG is initialized when map becomes available
  createEffect(() => {
    if (props.map && !svgOverlay) {
      initSVG();
      updateOnMapChange();
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    cleanup();
  });

  // Re-render when data or map changes
  createEffect(() => {
    // Track props.data and props.map directly - don't track groupedData's internal dependencies
    const _rawData = props.data;
    const _map = props.map;
    
    logDebug('MultiTrackLayer: Data effect triggered', {
      hasMap: !!_map,
      hasData: !!_rawData,
      dataLength: Array.isArray(_rawData) ? _rawData.length : 0,
      hasSvgOverlay: !!svgOverlay,
      mapLoaded: _map?.loaded(),
      mapStyleLoaded: _map?.isStyleLoaded()
    });
    
    if (_map && _rawData && Array.isArray(_rawData) && _rawData.length > 0 && trackOverlay && svgOverlay) {
      logDebug('MultiTrackLayer: Calling render() - all conditions met', {
        dataLength: _rawData.length,
        hasTrackOverlay: !!trackOverlay,
        hasSvgOverlay: !!svgOverlay
      });
      render();
    } else if (_map && _rawData && Array.isArray(_rawData) && _rawData.length > 0 && (!svgOverlay || !trackOverlay)) {
      // If we have data but no SVG, try to initialize
      logDebug('MultiTrackLayer: Data available but no overlay, initializing SVG', {
        dataLength: _rawData.length,
        mapLoaded: _map?.loaded(),
        mapStyleLoaded: _map?.isStyleLoaded(),
        hasSvgOverlay: !!svgOverlay,
        hasTrackOverlay: !!trackOverlay
      });
      initSVG();
    } else {
      logDebug('MultiTrackLayer: Not rendering - missing conditions', {
        hasMap: !!_map,
        hasData: !!_rawData,
        dataLength: Array.isArray(_rawData) ? _rawData.length : 0,
        hasSvgOverlay: !!svgOverlay,
        hasTrackOverlay: !!trackOverlay
      });
    }
  });


  // Re-render when maptype changes (for color schemes)
  createEffect(() => {
    const _maptype = props.maptype;
    if (_maptype) {
      render();
    }
  });

  // Re-render tracks immediately when selectedTime changes (matching TrackLayer pattern)
  // This is critical for time window filtering - when selectedTime changes, we need to recalculate
  // the time window filter and re-render the tracks
  createEffect(() => {
    const currentTime = selectedTime();
    const currentTimeWindow = timeWindow();
    
    if (!props.map || !props.data || props.data.length === 0 || !trackOverlay || !svgOverlay) return;
    
    // When timeWindow > 0, re-render immediately when selectedTime changes (like TrackLayer)
    if (currentTimeWindow > 0 && currentTime) {
      logDebug('MultiTrackLayer: selectedTime changed with active timeWindow - re-rendering', {
        currentTime: currentTime.toISOString(),
        timeWindow: currentTimeWindow
      });
      render();
    }
    // When timeWindow === 0, also re-render when selectedTime changes to update track extent
    // The groupedData memo will filter to show track up to selectedTime + 1 second
    else if (currentTimeWindow === 0 && currentTime) {
      logDebug('MultiTrackLayer: selectedTime changed with timeWindow=0 - re-rendering', {
        currentTime: currentTime.toISOString()
      });
      render();
    }
  });

  // Re-render tracks when brush selection (selectedRange/selectedRanges) changes
  createEffect(() => {
    const currentRange = selectedRange();
    const currentRanges = selectedRanges();
    
    if (!props.map || !props.data || props.data.length === 0 || !trackOverlay || !svgOverlay) return;
    
    const hasBrushSelection = (Array.isArray(currentRanges) && currentRanges.length > 0) ||
                              (Array.isArray(currentRange) && currentRange.length > 0);
    
    
    // Trigger render when brush selection changes
    // This ensures the filtered data from groupedData memo is rendered
    
    // Small debounce to avoid excessive renders if both change at once
    const timeoutId = setTimeout(() => {
      if (trackOverlay && svgOverlay && props.map) {
        render();
      }
    }, 50);
    
    return () => clearTimeout(timeoutId);
  });

  // Update map track opacity/stroke when fleet map boat hover/selection changes (same as MultiMapTimeSeries)
  createEffect(() => {
    const highlighted = props.highlightedSourceIds ?? new Set<number>();
    if (!trackOverlay || !d3) return;
    const hasHighlight = highlighted.size > 0;
    trackOverlay.selectAll("path.track-line").each(function() {
      const el = d3.select(this);
      const sourceIdAttr = el.attr("data-source-id");
      const sourceId = sourceIdAttr != null && sourceIdAttr !== "" ? Number(sourceIdAttr) : NaN;
      const isHighlighted = hasHighlight && Number.isFinite(sourceId) && highlighted.has(sourceId);
      el
        .style("stroke-width", isHighlighted ? "3px" : "1px")
        .style("opacity", isHighlighted ? 1 : (hasHighlight ? 0.3 : 1));
    });
  });

  return <div ref={container} style="display: none;" />;
}
