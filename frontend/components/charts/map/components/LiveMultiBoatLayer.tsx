// @ts-nocheck
import { createEffect, onMount, onCleanup } from "solid-js";
import * as d3 from "d3";
import { streamingStore } from "../../../../store/streamingStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { selectedTime, isPlaying, smoothPlaybackTimeForTrack, timeWindow } from "../../../../store/playbackStore";
import { persistantStore } from "../../../../store/persistantStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { getInterpolatedPointAtTime } from "../../../../utils/trackInterpolation";
import { debug, warn } from "../../../../utils/console";

export interface LiveMultiBoatLayerProps {
  map: any;
  mapContainer: HTMLElement;
  samplingFrequency: number;
  selectedSourceIds: Set<number>;
  onBoatClick?: (p: any) => void;
  /** When true, passed for consistency with LiveTrackLayer; boat positions are not throttled so they stay in sync with tracks */
  inSplitView?: boolean;
}

// Track state per source: last position, last timestamp, boat icon
interface SourceState {
  lastPoint: any | null;
  lastTimestamp: number;
  boatIcon: d3.Selection<SVGGElement, unknown, null, undefined> | null;
  boatCreated: boolean;
  hasLoggedInvalidCoords?: boolean; // Track if we've already logged invalid coords warning for this source
}

export default function LiveMultiBoatLayer(props: LiveMultiBoatLayerProps) {
  // Track state per source
  const sourceStates = new Map<number, SourceState>();

  // Helper to get timestamp from data point
  const getTimestamp = (d: any): number => {
    if (!d) return 0;
    const timestamp = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
    return Number.isFinite(timestamp) ? timestamp : 0;
  };

  // Helper to get latest point from WebSocket data array
  const getLatestPoint = (points: any[]): any | null => {
    if (!points || points.length === 0) return null;
    const sorted = [...points].sort((a, b) => getTimestamp(b) - getTimestamp(a));
    return sorted[0] || null;
  };

  // Getters for interpolation (live data shape: Lat_dd/Lng_dd/Hdg_deg or channel names)
  const getLatLive = (d: any): number | undefined => {
    if (!d) return undefined;
    const name = defaultChannelsStore.latName() || "Lat_dd";
    const v = d[name] ?? d.lat_dd ?? d.Lat_dd ?? d.Lat ?? d.lat;
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const getLngLive = (d: any): number | undefined => {
    if (!d) return undefined;
    const name = defaultChannelsStore.lngName() || "Lng_dd";
    const v = d[name] ?? d.lng_dd ?? d.Lng_dd ?? d.Lng ?? d.lng;
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const getHdgLive = (d: any): number | undefined => {
    if (!d) return undefined;
    const name = defaultChannelsStore.hdgName() || "Hdg_deg";
    const v = d[name] ?? d.hdg_deg ?? d.Hdg_deg ?? d.Hdg ?? d.hdg;
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // Calculate boat size based on zoom level
  const calculateBoatSize = (map: any): number => {
    if (!map) return 1;
    const zoom = map.getZoom();
    const center = map.getCenter();
    const latitude = center ? center.lat : 0;
    const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, zoom);
    const targetMeters = 22;
    const targetPixels = targetMeters / metersPerPixel;
    const baseSize = 24;
    const realAspectRatioScale = targetPixels / baseSize;
    const defaultScale = 0.75;
    let finalScale = Math.max(defaultScale, realAspectRatioScale);
    const absoluteMaxScale = 12.0;
    finalScale = Math.min(absoluteMaxScale, finalScale);
    
    // Apply 25% size reduction for multihull boats (multiply by 0.75)
    const { selectedClassIcon } = persistantStore;
    const iconType = selectedClassIcon()?.toLowerCase() || 'monohull';
    if (iconType === 'multihull') {
      finalScale = finalScale * 0.75;
    }
    
    return finalScale;
  };

  // Create boat icon for a source
  const createBoatIcon = (sourceId: number, color: string, sourceName?: string): d3.Selection<SVGGElement, unknown, null, undefined> | null => {
    if (!props.mapContainer) return null;

    // Check if boat already exists
    const existingBoat = d3.select(props.mapContainer).select(`#live-boat-${sourceId}`);
    if (!existingBoat.empty()) {
      return existingBoat.node() as SVGGElement ? d3.select(existingBoat.node() as SVGGElement) : null;
    }

    // Create SVG overlay if it doesn't exist
    let svgOverlay = d3.select(props.mapContainer).select('.boat-overlay-svg');
    if (svgOverlay.empty()) {
      svgOverlay = d3.select(props.mapContainer)
        .append('svg')
        .attr('class', 'boat-overlay-svg')
        .style('position', 'absolute')
        .style('top', '0')
        .style('left', '0')
        .style('width', '100%')
        .style('height', '100%')
        .style('pointer-events', 'none')
        .style('z-index', '1000');
    }

    // Create boat group
    const boatGroup = svgOverlay
      .append('g')
      .attr('id', `live-boat-${sourceId}`)
      .attr('class', 'live-boat-icon');

    // Get boat path based on class icon type
    const { selectedClassIcon } = persistantStore;
    const iconType = selectedClassIcon()?.toLowerCase() || 'monohull';
    let boatPath: string;
    if (iconType === 'multihull') {
      // Multihull coordinates scaled to be 2x wider than monohull, centered at (0,0)
      boatPath = 'M0 12 L5.332 0 L5.332 6 L6.665 12 L8 6 L8 -12 L-8 -12 L-8 6 L-6.665 12 L-5.332 6 L-5.332 0 Z';
    } else {
      // Default monohull path
      boatPath = 'M0 -12 L-4 -12 L-4 0 L-2 8 L0 12 L2 8 L4 0 L4 -12 Z';
    }

    // Boat path
    boatGroup
      .append('path')
      .attr('d', boatPath)
      .attr('fill', color)
      .attr('stroke', '#000')
      .attr('stroke-width', '1')
      .style('opacity', 1);

    // Add source name label (11px white text, positioned to the right of boat)
    // Label rotates with boat, but flips 180° when upside down for readability
    boatGroup.append("text")
      .attr("class", "boat-source-name")
      .attr("x", 12) // Position to the right of boat
      .attr("y", 0) // Center
      .attr("font-size", "11px")
      .attr("fill", "white")
      .attr("stroke", "black")
      .attr("stroke-width", "0.5px")
      .attr("stroke-opacity", "0.8")
      .attr("paint-order", "stroke")
      .attr("transform", "rotate(0)") // Will be updated to flip when upside down
      .style("pointer-events", "none")
      .text(sourceName || "");

    // Add click handler if provided
    if (props.onBoatClick) {
      boatGroup
        .style('pointer-events', 'all')
        .style('cursor', 'pointer')
        .on('click', (event) => {
          const state = sourceStates.get(sourceId);
          // Use current point (lastPoint is the most recent position)
          if (state && state.lastPoint) {
            props.onBoatClick?.(state.lastPoint);
          }
        });
    }

    debug(`[LiveMultiBoatLayer] Created boat icon for source ${sourceId}`);
    return boatGroup;
  };

  // Helper function to calculate label flip rotation (180° when upside down for readability)
  const calculateLabelFlip = (boatRotation: number): number => {
    // Normalize rotation to 0-360 range
    const normalizedRotation = ((boatRotation % 360) + 360) % 360;
    // Flip 180° when text would be upside down (between 90° and 270°)
    if (normalizedRotation > 90 && normalizedRotation < 270) {
      return 180;
    }
    return 0;
  };

  // Update boat position immediately (no transition)
  const updateBoatPosition = (sourceId: number, point: any) => {
    const state = sourceStates.get(sourceId);
    if (!state || !state.boatIcon || !props.map) return;

    // Use default channel names (Lat_dd, Lng_dd) - processor now outputs these directly
    const latFieldName = defaultChannelsStore.latName() || 'Lat_dd';
    const lngFieldName = defaultChannelsStore.lngName() || 'Lng_dd';
    const lng = point[lngFieldName] ?? point.lng_dd ?? point.Lng_dd;
    const lat = point[latFieldName] ?? point.lat_dd ?? point.Lat_dd;
    
    // Check if coordinates are valid (not null, not undefined, and finite)
    // Null values are expected when GPS data is temporarily unavailable
    if (lng === null || lat === null || lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      // Only log warning if coordinates are undefined (missing field) or invalid number
      // Don't warn for null values - these are expected when GPS is temporarily unavailable
      if (lng !== null && lat !== null) {
        // Only warn if the field exists but has an invalid value (not null)
        const hasLatField = latFieldName in point || 'Lat_dd' in point || 'lat_dd' in point;
        const hasLngField = lngFieldName in point || 'Lng_dd' in point || 'lng_dd' in point;
        
        if (hasLatField && hasLngField) {
          // Field exists but value is invalid - this is unexpected, log once per source
          if (!state.hasLoggedInvalidCoords) {
            warn(`[LiveMultiBoatLayer] Invalid coordinate values for source ${sourceId} (will not warn again):`, { 
              lng, 
              lat,
              latFieldName,
              lngFieldName
            });
            state.hasLoggedInvalidCoords = true;
          }
        }
      }
      // Silently skip points with null/undefined/invalid coordinates
      return;
    }

    const mapPoint = props.map.project([lng, lat]);
    if (!mapPoint || isNaN(mapPoint.x) || isNaN(mapPoint.y)) {
      warn(`[LiveMultiBoatLayer] Invalid projected point for source ${sourceId}`);
      return;
    }

    const mapBearing = props.map.getBearing ? props.map.getBearing() : 0;
    // Use default channel name for heading (Hdg_deg)
    const hdgFieldName = defaultChannelsStore.hdgName() || 'Hdg_deg';
    const hdg = point[hdgFieldName] ?? point.hdg_deg ?? point.Hdg_deg ?? point.Hdg ?? point.hdg;
    const boatScale = calculateBoatSize(props.map);
    
    // Interrupt any existing transition
    state.boatIcon.interrupt();
    
    // Calculate target rotation
    let targetRotation = 0;
    if (hdg !== undefined && hdg !== null && !isNaN(hdg) && Number.isFinite(hdg)) {
      targetRotation = hdg + 180 - mapBearing;
    }
    
    // Update source name label flip rotation for readability
    const sourceNameText = state.boatIcon.select(".boat-source-name");
    if (!sourceNameText.empty()) {
      const flipRotation = calculateLabelFlip(targetRotation);
      sourceNameText.attr("transform", `rotate(${flipRotation})`);
    }
    
    // Short transition (50ms) so boats glide between updates
    state.boatIcon
      .transition()
      .duration(50)
      .ease(d3.easeLinear)
      .attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`);
  };

  // Watch for WebSocket data updates and selectedTime changes
  // When playing: update boats from websocket data
  // When paused: position boats at selectedTime
  createEffect(() => {
    const newDataMap = streamingStore.getNewData()();
    const currentTime = selectedTime();
    const currentlyPlaying = isPlaying();

    const selected = props.selectedSourceIds || new Set<number>();
    const sources = sourcesStore.sources();

    // When paused, position boats at selectedTime instead of latest websocket data
    if (!currentlyPlaying && currentTime instanceof Date) {
      const currentTimeMs = currentTime.getTime();
      
      // Get all filtered data from streamingStore
      const filteredDataMap = streamingStore.getFilteredData(selected);
      
      for (const sourceId of selected) {
        const sourceData = filteredDataMap.get(sourceId) || [];
        if (sourceData.length === 0) continue;
        
        // Find the closest point to selectedTime
        let closestPoint: any = null;
        let closestDelta = Infinity;
        
        for (const point of sourceData) {
          const ts = getTimestamp(point);
          if (ts === 0) continue;
          
          const delta = Math.abs(ts - currentTimeMs);
          if (delta < closestDelta) {
            closestDelta = delta;
            closestPoint = point;
          }
        }
        
        // Only update if we found a point within reasonable tolerance (5 seconds)
        if (closestPoint && closestDelta <= 5000) {
          // Get or create state for this source
          let state = sourceStates.get(sourceId);
          if (!state) {
            state = {
              lastPoint: null,
              lastTimestamp: 0,
              boatIcon: null,
              boatCreated: false
            };
            sourceStates.set(sourceId, state);
          }
          
          // Create boat icon if needed
          if (!state.boatCreated && props.map && props.mapContainer) {
            // Prioritize matching by source_name from data (since boat labels use this and it's more reliable)
            let sourceInfo: any = null;
            const pointSourceName = closestPoint?.source_name;
            
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
            
            // Only log if there's an issue with color resolution
            if (!sourceInfo || !sourceInfo.color) {
              debug('[LiveMultiBoatLayer] 🎨 Boat icon color resolved (paused mode)', {
                sourceId,
                sourceName,
                color,
                pointSourceName,
                foundBySourceName: pointSourceName ? !!sources.find((s: any) => 
                  s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
                ) : false,
                foundBySourceId: !sourceInfo ? !!sources.find((s: any) => Number(s.source_id) === Number(sourceId)) : false,
                usedFallback: !sourceInfo || !sourceInfo.color
              });
            }
            
            state.boatIcon = createBoatIcon(sourceId, color, sourceName);
            state.boatCreated = true;
          }
          
          // Update boat position to the point at selectedTime
          if (state.boatIcon && props.map) {
            state.lastPoint = closestPoint;
            state.lastTimestamp = getTimestamp(closestPoint);
            updateBoatPosition(sourceId, closestPoint);
          }
        }
      }
      return; // Don't process websocket updates when paused
    }

    // When playing with time window, boat positions are driven by smoothPlaybackTime effect below
    if (currentlyPlaying && timeWindow() > 0) {
      return;
    }

    // When playing (no time window), update boats from websocket data
    // Force effect to track the signal by accessing it
    if (!newDataMap) return;

    // Process each source's new data - SIMPLE: Just update to the latest point
    for (const [sourceId, newPoints] of newDataMap.entries()) {
      if (!selected.has(sourceId)) {
        continue;
      }

      if (!newPoints || newPoints.length === 0) {
        continue;
      }

      // Get the latest point (should be only 1 point from server, but be safe)
      // MUST be defined before boat icon creation to use in color lookup fallback
      const latestPoint = getLatestPoint(newPoints);
      
      if (!latestPoint) {
        continue;
      }

      // Get or create state for this source
      let state = sourceStates.get(sourceId);
      if (!state) {
        state = {
          lastPoint: null,
          lastTimestamp: 0,
          boatIcon: null,
          boatCreated: false
        };
        sourceStates.set(sourceId, state);
      }

      // Create boat icon if needed
      if (!state.boatCreated && props.map && props.mapContainer) {
        // Prioritize matching by source_name from data (since boat labels use this and it's more reliable)
        let sourceInfo: any = null;
        const pointSourceName = latestPoint?.source_name;
        
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
        
        // Only log if there's an issue with color resolution
        if (!sourceInfo || !sourceInfo.color) {
          debug('[LiveMultiBoatLayer] 🎨 Boat icon color resolved (playing mode)', {
            sourceId,
            sourceName,
            color,
            pointSourceName,
            foundBySourceName: pointSourceName ? !!sources.find((s: any) => 
              s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
            ) : false,
            foundBySourceId: !sourceInfo ? !!sources.find((s: any) => Number(s.source_id) === Number(sourceId)) : false,
            usedFallback: !sourceInfo || !sourceInfo.color
          });
        }
        
        state.boatIcon = createBoatIcon(sourceId, color, sourceName);
        state.boatCreated = true;
      }

      const latestTimestamp = getTimestamp(latestPoint);
      if (latestTimestamp === 0) {
        continue;
      }

      // ALWAYS UPDATE if timestamp is newer (or equal - allow same timestamp to force update)
      // This ensures boats update at least once per second
      if (latestTimestamp >= state.lastTimestamp) {
        // Update state
        state.lastPoint = latestPoint;
        state.lastTimestamp = latestTimestamp;

        // Update boat position immediately (no transition, no conditions)
        if (state.boatIcon && props.map) {
          updateBoatPosition(sourceId, latestPoint);
        }
      }
    }

    // Clear processed data AFTER processing (don't clear before components see it)
    // Use setTimeout to ensure all components have processed the data first
    setTimeout(() => {
      const currentData = streamingStore.getNewData()();
      if (currentData && currentData.size > 0) {
        const sourcesToClear = new Set<number>();
        for (const sourceId of selected) {
          if (currentData.has(sourceId)) {
            sourcesToClear.add(sourceId);
          }
        }
        if (sourcesToClear.size > 0) {
          streamingStore.clearProcessedData(sourcesToClear);
        }
      }
    }, 100); // Small delay to ensure all components processed
  });

  // When playing with time window: drive boats from throttled smooth time (~10fps) to avoid heavy getFilteredData every frame
  createEffect(() => {
    if (!isPlaying() || timeWindow() <= 0 || !props.map || !props.mapContainer) return;
    const smoothTime = smoothPlaybackTimeForTrack();
    const selected = props.selectedSourceIds || new Set<number>();
    const filteredDataMap = streamingStore.getFilteredData(selected, { effectivePlaybackTime: smoothTime });
    const sources = sourcesStore.sources();
    const interpolateOptions = {
      getTimestamp: (d: any) => new Date(getTimestamp(d)),
      getLat: getLatLive,
      getLng: getLngLive,
      getHdg: getHdgLive,
    };
    for (const sourceId of selected) {
      const sourceData = filteredDataMap.get(sourceId) || [];
      if (sourceData.length === 0) continue;
      const point = getInterpolatedPointAtTime(sourceData, smoothTime, interpolateOptions);
      if (!point) continue;
      let state = sourceStates.get(sourceId);
      if (!state) {
        state = { lastPoint: null, lastTimestamp: 0, boatIcon: null, boatCreated: false };
        sourceStates.set(sourceId, state);
      }
      if (!state.boatCreated && props.map && props.mapContainer) {
        let sourceInfo: any = sources.find((s: any) => Number(s.source_id) === Number(sourceId));
        const pointSourceName = point?.source_name;
        if (pointSourceName) {
          sourceInfo = sources.find((s: any) =>
            s.source_name && String(s.source_name).toLowerCase() === String(pointSourceName).toLowerCase()
          ) || sourceInfo;
        }
        const sourceName = sourceInfo?.source_name || pointSourceName || `Source ${sourceId}`;
        const color = sourceInfo?.color || sourcesStore.getSourceColor(sourceName) || "#1f77b4";
        state.boatIcon = createBoatIcon(sourceId, color, sourceName);
        state.boatCreated = true;
      }
      if (state.boatIcon && props.map) {
        state.lastPoint = point;
        state.lastTimestamp = getTimestamp(point);
        updateBoatPosition(sourceId, point);
      }
    }
  });

  // Handle map movements to update boat positions
  createEffect(() => {
    if (!props.map) return;

    const updateBoatPositions = () => {
      for (const [sourceId, state] of sourceStates.entries()) {
        if (state.lastPoint && state.boatIcon) {
          // Re-project position on map movement
          updateBoatPosition(sourceId, state.lastPoint);
        }
      }
    };

    props.map.on('render', updateBoatPositions);
    props.map.on('moveend', updateBoatPositions);
    props.map.on('zoomend', updateBoatPositions);
    props.map.on('rotateend', updateBoatPositions);

    return () => {
      props.map.off('render', updateBoatPositions);
      props.map.off('moveend', updateBoatPositions);
      props.map.off('zoomend', updateBoatPositions);
      props.map.off('rotateend', updateBoatPositions);
    };
  });

  // Cleanup on unmount
  onCleanup(() => {
    // Remove all boat icons
    for (const [sourceId, state] of sourceStates.entries()) {
      if (state.boatIcon) {
        state.boatIcon.remove();
      }
    }
    sourceStates.clear();
    debug('[LiveMultiBoatLayer] Cleaned up all boat icons');
  });

  return null; // This component doesn't render JSX, it manages D3 overlays
}
