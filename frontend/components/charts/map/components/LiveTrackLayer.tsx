// @ts-nocheck
import { createEffect, onMount, onCleanup, createSignal } from "solid-js";
import type mapboxgl from "mapbox-gl";
import { streamingStore } from "../../../../store/streamingStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { selectedTime, isPlaying, timeWindow } from "../../../../store/playbackStore";
import { selectedRange, selectedRanges } from "../../../../store/selectionStore";
import { getInterpolatedPointAtTime } from "../../../../utils/trackInterpolation";
import { debug, warn } from "../../../../utils/console";

const SPLIT_VIEW_THROTTLE_MS = 150;

export interface LiveTrackLayerProps {
  map: mapboxgl.Map;
  selectedSourceIds: Set<number>;
  onPointClick?: (p: any) => void;
  pointSizePixels?: number; // Point size in pixels (default: 4)
  pointLineWidth?: number; // Line width of square outline in pixels (default: 1)
  historicalData?: any[]; // Historical data from MultiMapTimeSeries (IndexedDB query results)
  /** When provided (time-window playback), use this so track ends at boat position */
  effectivePlaybackTime?: Date | null;
  /** When true, throttle incremental updates to avoid stall with two map instances in split view */
  inSplitView?: boolean;
}

export default function LiveTrackLayer(props: LiveTrackLayerProps) {
  let d3: typeof import('d3') | null = null;
  
  let svg: any = null;
  let trackOverlay: any = null;
  // Use signals to track SVG/trackOverlay state so effects can react to changes
  const [svgReady, setSvgReady] = createSignal(false);
  const [trackOverlayReady, setTrackOverlayReady] = createSignal(false);
  let hasInitialized = false; // Track if we've done initial load
  let lastRedisLoadSourceKey = ''; // Avoid calling loadInitialDataFromRedis in a loop when Redis returns empty
  let lastProcessedTimestamps = new Map<number, number>(); // Track last processed timestamp per source
  let mapUpdateHandler: (() => void) | null = null; // Store map update handler for cleanup
  let lastIncrementalUpdateTime = 0; // Throttle incremental effect when inSplitView
  const GAP_THRESHOLD_MS = 10000; // 10 seconds
  
  // Helper to get timestamp from data point
  const getTimestamp = (d: any): number => {
    if (!d) return 0;
    const timestamp = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
    return Number.isFinite(timestamp) ? timestamp : 0;
  };

  // Helper to get coordinates from a point (checks all possible field names)
  const getCoordinates = (point: any): { lng: number; lat: number } | null => {
    if (!point) return null;
    
    // Try normalized names first (Lat/Lng)
    let lng = point.Lng ?? point.lng;
    let lat = point.Lat ?? point.lat;
    
    // If not found, try default channel names (Lat_dd/Lng_dd)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      try {
        const { defaultChannelsStore } = require('../../../../store/defaultChannelsStore');
        if (defaultChannelsStore.isReady()) {
          const lngName = defaultChannelsStore.lngName();
          const latName = defaultChannelsStore.latName();
          if (!Number.isFinite(lng)) lng = point[lngName];
          if (!Number.isFinite(lat)) lat = point[latName];
        }
      } catch (e) {
        // Store not available, continue with normalized names
      }
    }
    
    // Also check direct default channel names (Lat_dd/Lng_dd) as fallback
    if (!Number.isFinite(lng)) lng = point.Lng_dd ?? point.lng_dd;
    if (!Number.isFinite(lat)) lat = point.Lat_dd ?? point.lat_dd;
    
    // Also check InfluxDB field names as fallback
    if (!Number.isFinite(lng)) lng = point.LONGITUDE_GPS_unk ?? point.longitude_gps_unk;
    if (!Number.isFinite(lat)) lat = point.LATITUDE_GPS_unk ?? point.latitude_gps_unk;
    
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      return { lng, lat };
    }
    
    return null;
  };

  // Getters for track interpolation (live data shape)
  const getLatLive = (d: any): number | undefined => getCoordinates(d)?.lat;
  const getLngLive = (d: any): number | undefined => getCoordinates(d)?.lng;
  const liveInterpolateOptions = {
    getTimestamp: (d: any) => new Date(getTimestamp(d)),
    getLat: getLatLive,
    getLng: getLngLive,
  };

  // Helper to check if point has valid coordinates
  const hasValidCoordinates = (point: any): boolean => {
    return getCoordinates(point) !== null;
  };

  // Update path positions when map moves/zooms
  const updatePathPositions = () => {
    if (!trackOverlay || !props.map || !d3) return;
    
    // Get all path groups (one per source)
    const pathGroups = trackOverlay.selectAll<SVGGElement, any>("g.track-path-group");
    
    pathGroups.each(function(groupData) {
      const group = d3.select(this);
      const path = group.select<SVGPathElement>("path.track-path");
      
      if (!path.empty() && groupData && Array.isArray(groupData.data)) {
        // Regenerate path with updated coordinates using coordinate helper
        const lineGenerator = d3.line<any>()
          .x((d: any) => {
            const coords = getCoordinates(d);
            if (!coords) return 0;
            return props.map!.project([coords.lng, coords.lat]).x;
          })
          .y((d: any) => {
            const coords = getCoordinates(d);
            if (!coords) return 0;
            return props.map!.project([coords.lng, coords.lat]).y;
          })
          .defined((d: any) => hasValidCoordinates(d));
        
        // Apply gap detection
        const segments: any[][] = [];
        let currentSegment: any[] = [];
        
        for (let i = 0; i < groupData.data.length; i++) {
          const point = groupData.data[i];
          if (i === 0) {
            currentSegment.push(point);
          } else {
            const prevPoint = groupData.data[i - 1];
            const prevTime = getTimestamp(prevPoint);
            const currTime = getTimestamp(point);
            const gap = currTime - prevTime;
            
            if (gap > GAP_THRESHOLD_MS) {
              // Gap detected - start new segment
              if (currentSegment.length > 1) {
                segments.push([...currentSegment]);
              }
              currentSegment = [point];
            } else {
              currentSegment.push(point);
            }
          }
        }
        
        // Add last segment
        if (currentSegment.length > 1) {
          segments.push(currentSegment);
        }
        
        // Update path with all segments (d3.line handles multiple segments)
        if (segments.length > 0) {
          // For multiple segments, we need to create separate paths or use a path generator that handles gaps
          // For simplicity, we'll create one path per segment or combine them
          const allPoints = segments.flat();
          path.attr("d", lineGenerator(allPoints));
        }
      }
    });
  };

  // Create SVG overlay
  const createSVGOverlay = () => {
    if (!d3) return;
    
    debug('[LiveTrackLayer] createSVGOverlay called', {
      hasMap: !!props.map,
      isStyleLoaded: props.map?.isStyleLoaded(),
      selectedSources: Array.from(props.selectedSourceIds || [])
    });
    
    if (!props.map) {
      warn('[LiveTrackLayer] No map provided, cannot initialize');
      return;
    }
    
    // Check if map is loaded
    if (!props.map.isStyleLoaded()) {
      debug('[LiveTrackLayer] Map style not loaded, waiting...');
      props.map.once('styledata', () => {
        debug('[LiveTrackLayer] Map style loaded, retrying createSVGOverlay');
        createSVGOverlay();
      });
      return;
    }
    
    // Remove existing overlay
    d3.select(".live-track-overlay").remove();
    
    // Create SVG overlay - attach to map canvas container
    let container: HTMLElement | null = null;
    try {
      container = props.map.getCanvasContainer() as HTMLElement;
    } catch (e) {
      debug('[LiveTrackLayer] getCanvasContainer failed, trying .map element', e);
    }
    
    if (!container) {
      // Fallback to .map element
      container = d3.select(".map").node() as HTMLElement;
    }
    
    if (!container) {
      warn('[LiveTrackLayer] Container not found');
      return;
    }
    
    const mapRect = container.getBoundingClientRect();
    const clientWidth = container.clientWidth || mapRect.width;
    const clientHeight = container.clientHeight || mapRect.height;
    const width = mapRect.width || clientWidth || 0;
    const height = mapRect.height || clientHeight || 0;
    
    svg = d3.select(container)
      .append("svg")
      .attr("class", "live-track-overlay")
      .attr("width", width || 800)
      .attr("height", height || 600)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("pointer-events", "none")
      .style("z-index", "100");
    
    trackOverlay = svg.append("g").attr("class", "live-track-layer");
    
    // Mark as ready so effects can react
    setSvgReady(true);
    setTrackOverlayReady(true);
    
    // Add resize handler to update SVG dimensions
    const resizeHandler = () => {
      const newRect = container?.getBoundingClientRect();
      if (svg && newRect) {
        svg.attr("width", newRect.width).attr("height", newRect.height);
      }
      // Update path positions when container resizes
      updatePathPositions();
    };
    
    window.addEventListener('resize', resizeHandler);
    
    // Add map move/zoom handlers to update path positions
    mapUpdateHandler = () => {
      updatePathPositions();
    };
    
    props.map.on('move', mapUpdateHandler);
    props.map.on('zoom', mapUpdateHandler);
    props.map.on('rotate', mapUpdateHandler);
    props.map.on('pitch', mapUpdateHandler);
    
    debug('[LiveTrackLayer] SVG overlay created');
  };

  // Render paths using enter/append/exit pattern
  const renderPaths = (groups: Array<{ sourceId: number; sourceName: string; color: string; data: any[] }>) => {
    if (!trackOverlay || !props.map || !d3) return;
    
    // Use enter/append/exit pattern for path groups
    const pathGroups = trackOverlay.selectAll<SVGGElement, any>("g.track-path-group")
      .data(groups, (d: any) => d.sourceId);
    
    // Exit: remove groups for deselected sources
    pathGroups.exit().remove();
    
    // Enter: create new groups for new sources
    const pathGroupsEnter = pathGroups.enter()
      .append("g")
      .attr("class", "track-path-group")
      .attr("data-source-id", (d: any) => d.sourceId);
    
    // Create path in each new group
    pathGroupsEnter.append("path")
      .attr("class", "track-path")
      .style("fill", "none")
      .style("stroke-width", "1px");
    
    // Update: merge enter and update selections
    const pathGroupsUpdate = pathGroupsEnter.merge(pathGroups);
    
    // Update path data and styling
    pathGroupsUpdate.each(function(groupData) {
      const group = d3.select(this);
      const path = group.select<SVGPathElement>("path.track-path");
      
      if (!groupData.data || groupData.data.length === 0) {
        path.attr("d", "");
        return;
      }
      
      // Create line generator using coordinate helper
      const lineGenerator = d3.line<any>()
        .x((d: any) => {
          const coords = getCoordinates(d);
          if (!coords) return 0;
          return props.map!.project([coords.lng, coords.lat]).x;
        })
        .y((d: any) => {
          const coords = getCoordinates(d);
          if (!coords) return 0;
          return props.map!.project([coords.lng, coords.lat]).y;
        })
        .defined((d: any) => hasValidCoordinates(d));
      
      // Apply gap detection - create segments
      const segments: any[][] = [];
      let currentSegment: any[] = [];
      
      for (let i = 0; i < groupData.data.length; i++) {
        const point = groupData.data[i];
        if (i === 0) {
          currentSegment.push(point);
        } else {
          const prevPoint = groupData.data[i - 1];
          const prevTime = getTimestamp(prevPoint);
          const currTime = getTimestamp(point);
          const gap = currTime - prevTime;
          
          if (gap > GAP_THRESHOLD_MS) {
            // Gap detected - start new segment
            if (currentSegment.length > 1) {
              segments.push([...currentSegment]);
            }
            currentSegment = [point];
          } else {
            currentSegment.push(point);
          }
        }
      }
      
      // Add last segment
      if (currentSegment.length > 1) {
        segments.push(currentSegment);
      }
      
      // For multiple segments, we need to handle them properly
      // d3.line doesn't handle gaps well, so we'll create one path per segment or combine
      if (segments.length === 0) {
        path.attr("d", "");
      } else if (segments.length === 1) {
        path.attr("d", lineGenerator(segments[0]));
      } else {
        // Multiple segments - combine into one path with moveTo between segments
        let pathData = "";
        for (const segment of segments) {
          if (segment.length > 1) {
            const segmentPath = lineGenerator(segment);
            if (segmentPath) {
              if (pathData) {
                // Add moveTo to start of next segment to create gap
                const firstPoint = segment[0];
                const coords = getCoordinates(firstPoint);
                if (coords) {
                  const projected = props.map!.project([coords.lng, coords.lat]);
                  pathData += ` M ${projected.x},${projected.y}`;
                }
                // Remove the M from the segment path and append the rest
                const segmentPathWithoutMove = segmentPath.replace(/^M[^L]*/, "");
                pathData += segmentPathWithoutMove;
              } else {
                pathData = segmentPath;
              }
            }
          }
        }
        path.attr("d", pathData || "");
      }
      
      // Set color
      path.style("stroke", groupData.color);
    });
  };

  // Initialize SVG overlay
  onMount(async () => {
    // Load d3 and mapbox-gl dynamically
    d3 = await import('d3');
    
    debug('[LiveTrackLayer] onMount called', {
      hasMap: !!props.map,
      mapLoaded: props.map?.loaded(),
      selectedSources: Array.from(props.selectedSourceIds || [])
    });
    
    if (!props.map) {
      warn('[LiveTrackLayer] No map provided, cannot initialize');
      return;
    }

    // Wait for map to be fully loaded
    if (props.map.loaded()) {
      debug('[LiveTrackLayer] Map already loaded, creating SVG overlay');
      createSVGOverlay();
    } else {
      debug('[LiveTrackLayer] Waiting for map to load...');
      props.map.once('load', () => {
        debug('[LiveTrackLayer] Map loaded, creating SVG overlay');
        createSVGOverlay();
      });
    }
  });

  // INITIAL LOAD: Load historical data once when component mounts or sources change
  // Track SVG/trackOverlay state to trigger re-run when they become available
  createEffect(() => {
    const selected = props.selectedSourceIds || new Set<number>();
    // Use reactive signals to track when SVG is ready
    const overlayReady = trackOverlayReady();
    const svgIsReady = svgReady();
    
    debug('[LiveTrackLayer] Initial load effect running', {
      selectedCount: selected.size,
      selectedIds: Array.from(selected),
      overlayReady,
      svgIsReady
    });
    
    if (!overlayReady || !svgIsReady) {
      debug('[LiveTrackLayer] Initial load: Waiting for SVG overlay', {
        overlayReady,
        svgIsReady
      });
      return;
    }

    // Reset initialization if sources changed (new sources added)
    const currentSourceIds = Array.from(selected).sort().join(',');
    const lastSourceIds = Array.from(lastProcessedTimestamps.keys()).sort().join(',');
    if (currentSourceIds !== lastSourceIds && hasInitialized) {
      debug('[LiveTrackLayer] Source selection changed, resetting initialization', {
        current: currentSourceIds,
        last: lastSourceIds
      });
      hasInitialized = false;
      lastRedisLoadSourceKey = '';
      lastProcessedTimestamps.clear();
    }
    
    if (selected.size === 0) {
      debug('[LiveTrackLayer] ⚠️ No sources selected, cannot load data', {
        selectedSize: selected.size,
        hasInitialized
      });
      if (hasInitialized) {
        renderPaths([]);
        hasInitialized = false;
        lastProcessedTimestamps.clear();
      }
      return;
    }
    
    debug('[LiveTrackLayer] Sources selected, proceeding with load', {
      selectedSources: Array.from(selected),
      selectedCount: selected.size
    });

    // Only do initial load once per source selection
    if (hasInitialized) {
      debug('[LiveTrackLayer] Already initialized, skipping initial load');
      return;
    }

    debug('[LiveTrackLayer] 🎯 Starting initial load', {
      selectedSources: Array.from(selected),
      hasOverlay: !!trackOverlay,
      selectedCount: selected.size
    });

    // CRITICAL: Load initial data from Redis if not already loaded
    // Check if streamingStore has data for these sources (use raw data check - we just need to know if any data exists)
    const existingDataMap = streamingStore.getFilteredData(selected);
    const existingDataCounts = Array.from(existingDataMap.entries()).map(([id, data]) => ({
      sourceId: id,
      count: data.length
    }));
    const hasExistingData = Array.from(existingDataMap.values()).some(data => data.length > 0);
    
    debug('[LiveTrackLayer] Checking existing data', {
      hasExistingData,
      existingDataCounts,
      mapSize: existingDataMap.size
    });
    
    if (!hasExistingData) {
      const currentSourceKey = Array.from(selected).sort().join(',');
      // Avoid infinite loop: if we already triggered Redis load for this source set and still no data, mark initialized
      if (lastRedisLoadSourceKey === currentSourceKey) {
        debug('[LiveTrackLayer] Redis already loaded for these sources (no data), marking initialized for WebSocket updates');
        hasInitialized = true;
        return;
      }
      lastRedisLoadSourceKey = currentSourceKey;

      debug('[LiveTrackLayer] ⚠️ No existing data in streamingStore, loading from Redis...', {
        selectedSources: Array.from(selected),
        sourceCount: selected.size
      });
      // Call async function but don't await (createEffect can't be async)
      // Respect timeWindow setting - if timeWindow is 0, load all available (24 hours)
      // If timeWindow is set (e.g., 30 minutes), load data for that window
      const currentTimeWindow = Number(timeWindow());
      const currentTime = selectedTime();
      const defaultTime = new Date('1970-01-01T12:00:00Z');
      const isValidTime = currentTime && currentTime.getTime() !== defaultTime.getTime() && !isNaN(currentTime.getTime());
      
      // Use selectedTime if valid, otherwise fallback to Date.now()
      const endTime = isValidTime ? currentTime.getTime() : Date.now();
      
      // Calculate minutes for the API call
      // If timeWindow is 0, fetch all available data (24 hours)
      // If timeWindow > 0, fetch data for that specific window
      const minutes = currentTimeWindow > 0 ? currentTimeWindow : 0;
      
      debug('[LiveTrackLayer] Loading initial data with timeWindow', {
        timeWindow: currentTimeWindow,
        minutes,
        endTime: new Date(endTime).toISOString()
      });
      
      streamingStore.loadInitialDataFromRedis(selected, minutes, endTime)
        .then(() => {
          debug('[LiveTrackLayer] ✅ Loaded initial data from Redis, effect will re-run automatically');
          // The effect will re-run automatically when streamingStore data changes
          // No need to manually trigger - SolidJS reactivity will handle it
        })
        .catch((err) => {
          warn('[LiveTrackLayer] ❌ Failed to load initial data from Redis:', err);
        });
      // Return early - will re-run when data is loaded (or when version bumps with empty result)
      return;
    } else {
      lastRedisLoadSourceKey = ''; // Clear so future source changes can trigger Redis again
      debug('[LiveTrackLayer] ✅ Using existing data from streamingStore', {
        dataCounts: existingDataCounts
      });
    }

    // Get ALL raw data from streamingStore for initial load (includes Redis historical data)
    // NOTE: For initial load, we want to show ALL historical tracks, not filtered by time window
    // Time window filtering will be applied in the incremental update effect when playing
    // Use getRawData() to bypass time window filtering and show complete history
    const filteredDataMap = streamingStore.getRawData(selected);
    
    debug('[LiveTrackLayer] Got filtered data map', {
      mapSize: filteredDataMap.size,
      sourceIds: Array.from(filteredDataMap.keys()),
      dataCounts: Array.from(filteredDataMap.entries()).map(([id, data]) => ({ sourceId: id, count: data.length }))
    });
    
    // Combine all source data
    const accumulatingData: any[] = [];
    for (const [sourceId, data] of filteredDataMap.entries()) {
      accumulatingData.push(...data);
    }
    
    // Also include historicalData from props if provided
    const historicalData = props.historicalData;
    if (Array.isArray(historicalData) && historicalData.length > 0) {
      debug('[LiveTrackLayer] Adding historicalData from props', { count: historicalData.length });
      const existingTimestamps = new Set(accumulatingData.map(d => getTimestamp(d)));
      for (const point of historicalData) {
        const ts = getTimestamp(point);
        if (ts > 0 && !existingTimestamps.has(ts)) {
          accumulatingData.push(point);
        }
      }
    }

    debug('[LiveTrackLayer] Initial load data check', {
      accumulatingDataLength: accumulatingData.length,
      filteredDataMapSize: filteredDataMap.size,
      hasHistoricalData: Array.isArray(historicalData) && historicalData.length > 0
    });

    // If no data yet, mark as initialized anyway so incremental updates can work
    // The incremental update effect will handle the first websocket data
    if (accumulatingData.length === 0) {
      debug('[LiveTrackLayer] ⚠️ No initial data to load - marking as initialized, will use incremental updates');
      hasInitialized = true;
      return;
    }

    const sources = sourcesStore.sources();

    // Group data by source
    const groupsBySource = new Map<number, any[]>();
    for (const point of accumulatingData) {
      const sourceId = point.source_id;
      if (!sourceId || !selected.has(sourceId) || !hasValidCoordinates(point)) {
        continue;
      }

      if (!groupsBySource.has(sourceId)) {
        groupsBySource.set(sourceId, []);
      }
      groupsBySource.get(sourceId)!.push(point);
    }

    // Create groups for initial load
    const groupsToUpdate: Array<{ sourceId: number; sourceName: string; color: string; data: any[] }> = [];
    for (const [sourceId, points] of groupsBySource.entries()) {
      // Ensure sourcesStore is ready and find matching source
      if (!sourcesStore.isReady()) {
        debug('[LiveTrackLayer] ⚠️ sourcesStore not ready when assigning colors, using default');
      }
      // Prioritize matching by source_name from data (since boat labels use this and it's more reliable)
      let sourceInfo: any = null;
      const samplePoint = points[0];
      const pointSourceName = samplePoint?.source_name;
      
      if (pointSourceName) {
        // First try: match by source_name from data point (most reliable)
        sourceInfo = sources.find((s: any) => 
          s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
        );
      }
      
      // Fallback: try matching by source_id
      if (!sourceInfo) {
        sourceInfo = sources.find((s: any) => Number(s.source_id) === Number(sourceId));
      }
      
      const sourceName = sourceInfo?.source_name || pointSourceName || `Source ${sourceId}`;
      const color = sourceInfo?.color || sourcesStore.getSourceColor(sourceName) || '#1f77b4';
      
      // Debug color assignment (only log if there's an issue)
      if (!sourceInfo || !sourceInfo.color) {
        debug('[LiveTrackLayer] 🎨 Track color resolved (initial load)', {
          sourceId,
          sourceName,
          color,
          pointSourceName,
          foundBySourceName: pointSourceName ? !!sources.find((s: any) => 
            s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
          ) : false,
          foundBySourceId: !sourceInfo ? !!sources.find((s: any) => Number(s.source_id) === Number(sourceId)) : false,
          usedFallback: !sourceInfo || !sourceInfo.color,
          pointCount: points.length
        });
      }

      const sortedData = [...points].sort((a, b) => {
        return getTimestamp(a) - getTimestamp(b);
      });

      if (sortedData.length > 0) {
        groupsToUpdate.push({
          sourceId: sourceId,
          sourceName: sourceName,
          color: color,
          data: sortedData
        });
        
        // Track last processed timestamp for this source
        const lastTimestamp = getTimestamp(sortedData[sortedData.length - 1]);
        lastProcessedTimestamps.set(sourceId, lastTimestamp);
      }
    }

    debug('[LiveTrackLayer] 🎯 Initial load with historical data', {
      groupCount: groupsToUpdate.length,
      totalPoints: groupsToUpdate.reduce((sum, g) => sum + g.data.length, 0),
      sources: Array.from(groupsBySource.keys()),
      groups: groupsToUpdate.map(g => ({ sourceId: g.sourceId, pointCount: g.data.length }))
    });
    
    // Initial load: Render all historical data
    if (groupsToUpdate.length > 0) {
      renderPaths(groupsToUpdate);
    }
    hasInitialized = true;
  });

  // INCREMENTAL UPDATES: Append new websocket data points as they arrive
  // Also handles initial load if no historical data was available
  // Also reacts to brush selection changes to filter map tracks
  createEffect(() => {
    const selected = props.selectedSourceIds || new Set<number>();
    const currentTime = selectedTime();
    const effectiveTime = props.effectivePlaybackTime ?? null;
    const timeForFilter = effectiveTime ?? currentTime;
    const currentlyPlaying = isPlaying();

    // Throttle when in split view (only skip if we've rendered recently; don't set timestamp until we actually render)
    if (props.inSplitView && lastIncrementalUpdateTime > 0) {
      const now = Date.now();
      if (now - lastIncrementalUpdateTime < SPLIT_VIEW_THROTTLE_MS) return;
    }

    // Watch for brush selection changes (reactive)
    const currentRange = selectedRange();
    const currentRanges = selectedRanges();
    
    if (!trackOverlay || !svg || selected.size === 0) {
      return;
    }

    // When paused (isPlaying = false), do not update from websocket data
    // Only update when selectedTime changes manually or brush selection changes
    if (!currentlyPlaying && hasInitialized) {
      // Still allow manual selectedTime updates to work
      // Re-render tracks based on selectedTime
      // IMPORTANT: Apply brush selection to filter map tracks based on timeseries brush
      // This effect will re-run when brush selection changes (currentRange/currentRanges are tracked above)
      // NOTE: We intentionally do NOT watch newDataMap here when paused - only update on selectedTime/brush changes
      const filteredDataMap = streamingStore.getFilteredData(selected, {
        selectedRange: currentRange,
        selectedRanges: currentRanges,
        effectivePlaybackTime: effectiveTime
      });
      const sources = sourcesStore.sources();
      
      // Build groups from all current data
      // If there's a brush selection, show all data within the brush range (from start_time to end_time)
      // If there's no brush selection, filter data to only show up to selectedTime
      const hasBrushSelection = currentRange && currentRange.length > 0;
      const groupsBySource = new Map<number, any[]>();
      
      if (hasBrushSelection) {
        // Brush selection exists - get raw data and filter to brush range (start_time to end_time)
        const rawDataMap = streamingStore.getRawData(selected);
        const brushRange = currentRange[0]; // Get the first (and typically only) brush range
        if (brushRange && brushRange.start_time && brushRange.end_time) {
          const startTime = brushRange.start_time instanceof Date 
            ? brushRange.start_time.getTime() 
            : new Date(brushRange.start_time).getTime();
          const endTime = brushRange.end_time instanceof Date 
            ? brushRange.end_time.getTime() 
            : new Date(brushRange.end_time).getTime();
          
          for (const [sourceId, data] of rawDataMap.entries()) {
            if (selected.has(sourceId) && data.length > 0) {
              // Filter data to brush range (start_time to end_time)
              const filteredData = data.filter(p => {
                const ts = getTimestamp(p);
                return ts >= startTime && ts <= endTime;
              });
              if (filteredData.length > 0) {
                groupsBySource.set(sourceId, filteredData);
              }
            }
          }
        }
      } else {
        // No brush selection - use filtered data and filter to timeForFilter when paused
        for (const [sourceId, data] of filteredDataMap.entries()) {
          if (selected.has(sourceId) && data.length > 0) {
            // Filter data to only show up to timeForFilter (boat position when effectiveTime provided)
            if (timeForFilter instanceof Date) {
              const currentTimeMs = timeForFilter.getTime();
              const filteredData = data.filter(p => {
                const ts = getTimestamp(p);
                return ts <= currentTimeMs;
              });
              if (filteredData.length > 0) {
                groupsBySource.set(sourceId, filteredData);
              }
            } else {
              groupsBySource.set(sourceId, data);
            }
          }
        }
      }
      
      // Create groups for rendering
      const groupsToUpdate: Array<{ sourceId: number; sourceName: string; color: string; data: any[] }> = [];
      for (const [sourceId, points] of groupsBySource.entries()) {
        // Ensure sourcesStore is ready and find matching source
        if (!sourcesStore.isReady()) {
          debug('[LiveTrackLayer] ⚠️ sourcesStore not ready when assigning colors (paused mode), using default');
        }
        // Prioritize matching by source_name from data (since boat labels use this and it's more reliable)
        let sourceInfo: any = null;
        const samplePoint = points[0];
        const pointSourceName = samplePoint?.source_name;
        
        if (pointSourceName) {
          // First try: match by source_name from data point (most reliable)
          sourceInfo = sources.find((s: any) => 
            s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
          );
        }
        
        // Fallback: try matching by source_id
        if (!sourceInfo) {
          sourceInfo = sources.find((s: any) => Number(s.source_id) === Number(sourceId));
        }
        
        const sourceName = sourceInfo?.source_name || pointSourceName || `Source ${sourceId}`;
        const color = sourceInfo?.color || sourcesStore.getSourceColor(sourceName) || '#1f77b4';
        
        // Debug color assignment (only log if there's an issue)
        if (!sourceInfo || !sourceInfo.color) {
          debug('[LiveTrackLayer] 🎨 Track color resolved (paused mode)', {
            sourceId,
            sourceName,
            color,
            pointSourceName,
            foundBySourceName: pointSourceName ? !!sources.find((s: any) => 
              s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
            ) : false,
            foundBySourceId: !sourceInfo ? !!sources.find((s: any) => Number(s.source_id) === Number(sourceId)) : false,
            usedFallback: !sourceInfo || !sourceInfo.color,
            pointCount: points.length
          });
        }
        
        // Filter to valid coordinates and sort
        const validPoints = points.filter(p => hasValidCoordinates(p));
        let sortedData = [...validPoints].sort((a, b) => getTimestamp(a) - getTimestamp(b));
        // Append interpolated point at timeForFilter so track extends smoothly to boat
        if (timeForFilter instanceof Date && points.length > 0) {
          const interp = getInterpolatedPointAtTime(points, timeForFilter, liveInterpolateOptions);
          if (interp) sortedData = [...sortedData, interp];
        }
        if (sortedData.length > 0) {
          groupsToUpdate.push({
            sourceId: sourceId,
            sourceName: sourceName,
            color: color,
            data: sortedData
          });
        }
      }
      
      // Re-render paths based on selectedTime
      if (groupsToUpdate.length > 0) {
        debug('[LiveTrackLayer] ⏸️ Paused - updating tracks based on selectedTime', {
          groupCount: groupsToUpdate.length,
          selectedTime: currentTime instanceof Date ? currentTime.toISOString() : 'invalid'
        });
        if (props.inSplitView) lastIncrementalUpdateTime = Date.now();
        renderPaths(groupsToUpdate);
      } else if (selected.size > 0) {
        if (props.inSplitView) lastIncrementalUpdateTime = Date.now();
        renderPaths([]);
      }
      return; // Don't process websocket updates when paused
    }

    // Watch for new websocket data updates (reactive signal) - only when playing
    const newDataMap = streamingStore.getNewData()();
    // Also depend on live append version so we re-render when WebSocket appends even after getNewData() is cleared
    const _liveAppendVersion = streamingStore.getLiveDataAppendVersion()();

    // If not initialized yet and we have new data, do initial load with new data
    if (!hasInitialized && newDataMap && newDataMap.size > 0) {
      debug('[LiveTrackLayer] Not initialized yet, doing initial load with websocket data');
      const filteredDataMap = streamingStore.getFilteredData(selected, {
        effectivePlaybackTime: effectiveTime
      });
      
      const accumulatingData: any[] = [];
      for (const [sourceId, data] of filteredDataMap.entries()) {
        accumulatingData.push(...data);
      }
      
      if (accumulatingData.length > 0) {
        const sources = sourcesStore.sources();
        const groupsBySource = new Map<number, any[]>();
        
        for (const point of accumulatingData) {
          const sourceId = point.source_id;
          if (!sourceId || !selected.has(sourceId) || !hasValidCoordinates(point)) {
            continue;
          }
          
          if (!groupsBySource.has(sourceId)) {
            groupsBySource.set(sourceId, []);
          }
          groupsBySource.get(sourceId)!.push(point);
        }
        
        const groupsToUpdate: Array<{ sourceId: number; sourceName: string; color: string; data: any[] }> = [];
        for (const [sourceId, points] of groupsBySource.entries()) {
          // Try to find source by source_id first
          let sourceInfo = sources.find((s: any) => Number(s.source_id) === Number(sourceId));
          
          // If not found, try using source_name from the data points as fallback
          if (!sourceInfo && points.length > 0) {
            const samplePoint = points[0];
            const pointSourceName = samplePoint?.source_name;
            if (pointSourceName) {
              sourceInfo = sources.find((s: any) => 
                s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
              );
            }
          }
          
          const sourceName = sourceInfo?.source_name || points[0]?.source_name || `Source ${sourceId}`;
          const color = sourceInfo?.color || sourcesStore.getSourceColor(sourceName) || '#1f77b4';
          
          const sortedData = [...points].sort((a, b) => getTimestamp(a) - getTimestamp(b));
          
          if (sortedData.length > 0) {
            groupsToUpdate.push({
              sourceId: sourceId,
              sourceName: sourceName,
              color: color,
              data: sortedData
            });
            
            const lastTimestamp = getTimestamp(sortedData[sortedData.length - 1]);
            lastProcessedTimestamps.set(sourceId, lastTimestamp);
          }
        }
        
        if (groupsToUpdate.length > 0) {
          debug('[LiveTrackLayer] 🎯 Initial load with websocket data', {
            groupCount: groupsToUpdate.length,
            totalPoints: groupsToUpdate.reduce((sum, g) => sum + g.data.length, 0)
          });
          if (props.inSplitView) lastIncrementalUpdateTime = Date.now();
          renderPaths(groupsToUpdate);
          hasInitialized = true;
          return; // Done with initial load
        }
      }
      // WebSocket has new data but store has none (e.g. Redis just returned empty and overwrote) - mark initialized so incremental path runs next time
      if (!hasInitialized && newDataMap && newDataMap.size > 0) {
        debug('[LiveTrackLayer] New data signal present but no store data yet, marking initialized for next incremental update');
        hasInitialized = true;
      }
    }
    
    if (!hasInitialized) {
      return; // Still waiting for initial data
    }

    // When playing: always re-render from current store data so tracks update as effectivePlaybackTime advances.
    // Do NOT return when newDataMap is empty - it gets cleared by LiveMultiBoatLayer after 100ms, so we must
    // still redraw from getFilteredData (which uses historicalData) so the track extends smoothly to the boat.
    // When newDataMap has content we also get a fresh render; when only time advanced we still need to render.

    // For incremental updates, get all current data for each source and re-render
    // IMPORTANT: Apply brush selection and effectivePlaybackTime for time-window sync with boat
    const filteredDataMap = streamingStore.getFilteredData(selected, {
      selectedRange: currentRange,
      selectedRanges: currentRanges,
      effectivePlaybackTime: effectiveTime
    });
    const sources = sourcesStore.sources();
    
    // Build groups from all current data (historical + new)
    const groupsBySource = new Map<number, any[]>();
    for (const [sourceId, data] of filteredDataMap.entries()) {
      if (selected.has(sourceId) && data.length > 0) {
        groupsBySource.set(sourceId, data);
      }
    }
    
    // Create groups for rendering
    const groupsToUpdate: Array<{ sourceId: number; sourceName: string; color: string; data: any[] }> = [];
    for (const [sourceId, points] of groupsBySource.entries()) {
      // Ensure sourcesStore is ready and find matching source
      if (!sourcesStore.isReady()) {
        debug('[LiveTrackLayer] ⚠️ sourcesStore not ready when assigning colors (incremental update), using default');
      }
      
      // Prioritize matching by source_name from data (since boat labels use this and it's more reliable)
      let sourceInfo: any = null;
      const samplePoint = points[0];
      const pointSourceName = samplePoint?.source_name;
      
      if (pointSourceName) {
        // First try: match by source_name from data point (most reliable)
        sourceInfo = sources.find((s: any) => 
          s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
        );
      }
      
      // Fallback: try matching by source_id
      if (!sourceInfo) {
        sourceInfo = sources.find((s: any) => Number(s.source_id) === Number(sourceId));
      }
      
      const sourceName = sourceInfo?.source_name || pointSourceName || `Source ${sourceId}`;
      const color = sourceInfo?.color || sourcesStore.getSourceColor(sourceName) || '#1f77b4';
      
      // Debug color assignment (only log if there's an issue)
      if (!sourceInfo || !sourceInfo.color) {
        debug('[LiveTrackLayer] 🎨 Track color resolved (incremental update)', {
          sourceId,
          sourceName,
          color,
          pointSourceName,
          foundBySourceName: pointSourceName ? !!sources.find((s: any) => 
            s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
          ) : false,
          foundBySourceId: !sourceInfo ? !!sources.find((s: any) => Number(s.source_id) === Number(sourceId)) : false,
          usedFallback: !sourceInfo || !sourceInfo.color,
          pointCount: points.length
        });
      }
      
      // Filter to valid coordinates and sort
      const validPoints = points.filter(p => hasValidCoordinates(p));
      let sortedData = [...validPoints].sort((a, b) => getTimestamp(a) - getTimestamp(b));
      // Append interpolated point at effective time so track extends smoothly to boat
      if (effectiveTime instanceof Date && points.length > 0) {
        const interp = getInterpolatedPointAtTime(points, effectiveTime, liveInterpolateOptions);
        if (interp) sortedData = [...sortedData, interp];
      }
      if (sortedData.length > 0) {
        groupsToUpdate.push({
          sourceId: sourceId,
          sourceName: sourceName,
          color: color,
          data: sortedData
        });
        
        // Update last processed timestamp
        const lastTimestamp = getTimestamp(sortedData[sortedData.length - 1]);
        lastProcessedTimestamps.set(sourceId, lastTimestamp);
      }
    }
    
    // Re-render all paths (enter/append/exit will handle updates efficiently)
    if (groupsToUpdate.length > 0) {
      debug('[LiveTrackLayer] ✅ Incremental update - re-rendering paths', {
        groupCount: groupsToUpdate.length,
        totalPoints: groupsToUpdate.reduce((sum, g) => sum + g.data.length, 0)
      });
      if (props.inSplitView) lastIncrementalUpdateTime = Date.now();
      renderPaths(groupsToUpdate);
    } else if (selected.size > 0) {
      if (props.inSplitView) lastIncrementalUpdateTime = Date.now();
      renderPaths([]);
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    // Remove SVG overlay
    if (svg && d3) {
      d3.select(".live-track-overlay").remove();
      svg = null;
      trackOverlay = null;
    }
    
    // Remove map event listeners
    if (props.map && mapUpdateHandler) {
      props.map.off('move', mapUpdateHandler);
      props.map.off('zoom', mapUpdateHandler);
      props.map.off('rotate', mapUpdateHandler);
      props.map.off('pitch', mapUpdateHandler);
      mapUpdateHandler = null;
    }
  });

  return null; // This component doesn't render JSX, it manages SVG rendering
}
