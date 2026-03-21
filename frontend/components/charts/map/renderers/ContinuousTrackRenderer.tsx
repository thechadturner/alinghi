import * as d3 from "d3";
import { TrackRendererProps, RendererResult } from "./types";
import { TrackPoint } from "../hooks/useTrackRendering";
import { warn, debug } from "../../../../utils/console";
import { selectedEvents, selectedRanges, selectedRange, hasSelection, cutEvents, isCut, setSelectedEvents } from "../../../../store/selectionStore";
import { getColorByIndex } from "../../../../utils/colorScale";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { persistantStore } from "../../../../store/persistantStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";

export function renderContinuousTracks(props: TrackRendererProps): RendererResult {
  try {
    debug(`[ContinuousTrackRenderer] ENTRY: renderContinuousTracks called`);
    
    if (!props) {
      const error = 'props is null or undefined';
      debug(`[ContinuousTrackRenderer] ERROR: ${error}`);
      return { success: false, error };
    }
    
    debug(`[ContinuousTrackRenderer] Props exists, type: ${typeof props}, keys:`, Object.keys(props || {}));
    
    // Safely extract props with fallbacks
    let data, map, trackOverlay, config, samplingFrequency, onPointClick, tilesAvailable, getColor, getThickness, maneuversEnabled;
    
    try {
      data = props.data;
      debug(`[ContinuousTrackRenderer] Got data: ${data?.length || 0} points`);
    } catch (e) {
      debug(`[ContinuousTrackRenderer] Error getting data:`, e);
      throw e;
    }
    
    try {
      map = props.map;
      debug(`[ContinuousTrackRenderer] Got map:`, !!map);
    } catch (e) {
      debug(`[ContinuousTrackRenderer] Error getting map:`, e);
      throw e;
    }
    
    try {
      trackOverlay = props.trackOverlay;
      debug(`[ContinuousTrackRenderer] Got trackOverlay:`, !!trackOverlay);
    } catch (e) {
      debug(`[ContinuousTrackRenderer] Error getting trackOverlay:`, e);
      throw e;
    }
    
    try {
      config = props.config;
      debug(`[ContinuousTrackRenderer] Got config:`, !!config);
    } catch (e) {
      debug(`[ContinuousTrackRenderer] Error getting config:`, e);
      throw e;
    }
    
    try {
      samplingFrequency = props.samplingFrequency;
      onPointClick = props.onPointClick;
      tilesAvailable = props.tilesAvailable;
      getColor = props.getColor;
      getThickness = props.getThickness;
      maneuversEnabled = props.maneuversEnabled;
      debug(`[ContinuousTrackRenderer] Got remaining props`);
    } catch (e) {
      debug(`[ContinuousTrackRenderer] Error getting remaining props:`, e);
      throw e;
    }
    
    const cfg: any = config || { maptype: 'DEFAULT' };
    
    debug(`[ContinuousTrackRenderer] Props extracted`, {
      dataLength: data?.length || 0,
      hasMap: !!map,
      hasTrackOverlay: !!trackOverlay,
      trackOverlayNode: trackOverlay?.node(),
      zoomLevel: cfg.zoomLevel,
      maptype: cfg.maptype,
      hasGetColor: !!getColor,
      hasGetThickness: !!getThickness
    });
    
    // Get dynamic channel names from store
    const { latName, lngName } = defaultChannelsStore;
    
    debug(`[ContinuousTrackRenderer] Got channel names: lat=${latName()}, lng=${lngName()}`);
  
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
    if (!trackOverlay) {
      const error = 'trackOverlay is null or undefined';
      debug(`[ContinuousTrackRenderer] ERROR: ${error}`);
      return { success: false, error };
    }
    
    if (!map) {
      const error = 'map is null or undefined';
      debug(`[ContinuousTrackRenderer] ERROR: ${error}`);
      return { success: false, error };
    }

    // Clear existing tracks, selections, and maneuvers
    trackOverlay.selectAll(".interactive-line").remove();
    trackOverlay.selectAll(".selection-overlay").remove();
    trackOverlay.selectAll(".maneuver-group").remove();

    if (!data || data.length === 0) {
      debug(`[ContinuousTrackRenderer] No data to render`);
      return { success: true };
    }

    // Create continuous line segments with gap detection
    const segments = createContinuousSegments(data, samplingFrequency, cfg);
    
    // Debug: Check segment validity
    const validSegments = segments.filter(s => s.length >= 2);
    const segmentsWithValidCoords = segments.filter(s => {
      if (s.length < 2) return false;
      const first = s[0];
      const lat = getLat(first);
      const lng = getLng(first);
      return lat !== undefined && lng !== undefined && !isNaN(lat) && !isNaN(lng);
    });
    
    debug(`[ContinuousTrackRenderer] Created ${segments.length} segments from ${data.length} points`, {
      validSegments: validSegments.length,
      segmentsWithValidCoords: segmentsWithValidCoords.length,
      zoomLevel: cfg.zoomLevel,
      firstSegmentLength: segments[0]?.length || 0,
      firstSegmentFirstPoint: segments[0]?.[0] ? {
        lat: getLat(segments[0][0]),
        lng: getLng(segments[0][0]),
        datetime: segments[0][0].Datetime
      } : null
    });
    
    // Create line generator for efficient path rendering
    const lineGenerator = d3.line<TrackPoint>()
      .x(d => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) return 0;
        return map.project([dLng, dLat]).x;
      })
      .y(d => {
        const dLat = getLat(d);
        const dLng = getLng(d);
        if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) return 0;
        return map.project([dLng, dLat]).y;
      });

    // Check for both selectedRanges (event selections) and selectedRange (brush selection)
    const currentSelectedRanges = selectedRanges();
    const currentSelectedRange = selectedRange(); // Brush selection (singular)
    const hasEventSelections = currentSelectedRanges && currentSelectedRanges.length > 0;
    const hasBrushSelection = hasSelection() && currentSelectedRange && currentSelectedRange.length > 0;
    // Only event selections should trigger colored overlays - brush selections keep normal colors
    const hasSelections = hasEventSelections;
    
    // Only include event selections in allRanges - brush selections don't get colored overlays
    const allRanges: Array<{ start_time: string; end_time: string }> = [];
    if (hasEventSelections) {
      allRanges.push(...currentSelectedRanges);
    }
    // Note: Brush selections are NOT added to allRanges - they should keep normal map colors
    
    debug('ContinuousTrackRenderer: Initialization', {
      maptype: cfg.maptype,
      dataLength: data?.length || 0,
      selectedRangesCount: currentSelectedRanges?.length || 0,
      selectedRangeCount: currentSelectedRange?.length || 0,
      hasEventSelections,
      hasBrushSelection,
      hasSelections,
      totalRangesCount: allRanges.length,
      sampleRange: allRanges[0]
    });

    // Render each continuous segment as a single path (base layer)
    let pathsCreated = 0;
    let pathsSkipped = 0;
    let pathsWithEmptyD = 0;
    segments.forEach((segment, index) => {
      if (segment.length < 2) {
        pathsSkipped++;
        return;
      }

      // Determine base track color - only grey out for event selections, not brush selections
      // Brush selections should keep normal colors
      const baseTrackColor = hasEventSelections ? "grey" : getColor(segment[0], null, cfg);

      // Generate path data
      const pathData = lineGenerator(segment);
      
      // Check if path data is valid
      if (!pathData || pathData === null || pathData === '' || pathData === 'MNaN,NaNMNaN,NaN') {
        pathsWithEmptyD++;
        debug(`[ContinuousTrackRenderer] Skipping segment ${index}: empty/invalid path data`, {
          segmentLength: segment.length,
          pathData: pathData,
          firstPoint: segment[0] ? { 
            lat: getLat(segment[0]), 
            lng: getLng(segment[0]),
            projected: segment[0] ? map.project([getLng(segment[0]) || 0, getLat(segment[0]) || 0]) : null
          } : null,
          lastPoint: segment[segment.length - 1] ? {
            lat: getLat(segment[segment.length - 1]),
            lng: getLng(segment[segment.length - 1])
          } : null
        });
        return;
      }

      // Always render the base track
      const path = trackOverlay.append("path")
        .attr("class", "interactive-line")
        .attr("d", pathData)
        .attr("stroke", baseTrackColor)
        .attr("stroke-width", getThickness(segment[0], null, cfg))
        .attr("stroke-linecap", "round")
        .attr("fill", "none")
        .style("pointer-events", "all")
        .style("cursor", "pointer");

      // Helper function to find closest point to mouse position
      const findClosestPoint = (event: MouseEvent): TrackPoint => {
        const [mouseX, mouseY] = d3.pointer(event, trackOverlay.node());
        let closestPoint = segment[0];
        let minDistance = Infinity;

        segment.forEach(point => {
          const pointLat = getLat(point);
          const pointLng = getLng(point);
          if (!pointLat || !pointLng || isNaN(pointLat) || isNaN(pointLng)) return;
          const mapPoint = map.project([pointLng, pointLat]);
          const distance = Math.sqrt(
            Math.pow(mouseX - mapPoint.x, 2) + Math.pow(mouseY - mapPoint.y, 2)
          );
          if (distance < minDistance) {
            minDistance = distance;
            closestPoint = point;
          }
        });

        return closestPoint;
      };

      // Add click handler for the entire path
      path.on("click", (event) => {
        event.stopPropagation();
        if (onPointClick) {
          onPointClick(findClosestPoint(event));
        }
      });

      // Add tooltip handlers
      if (props.onMouseOver && props.onMouseOut) {
        path.on("mouseover", (event) => {
          props.onMouseOver(event, findClosestPoint(event));
        })
        .on("mouseout", (event) => {
          props.onMouseOut(event);
        });
      }
      
      pathsCreated++;
    });
    
    debug(`[ContinuousTrackRenderer] Created ${pathsCreated} paths from ${segments.length} segments (skipped: ${pathsSkipped}, empty paths: ${pathsWithEmptyD})`);

    // In DEFAULT mode, overlay selected ranges with colored lines
    if (cfg.maptype === "DEFAULT" && hasSelections && allRanges.length > 0) {
      debug('ContinuousTrackRenderer: Rendering', allRanges.length, 'selected ranges (events + brush)');
      
      // Loop through each selected range and render it on top
      allRanges.forEach((range, rangeIndex) => {
        const startTime = new Date(range.start_time).getTime();
        const endTime = new Date(range.end_time).getTime();
        
        debug('ContinuousTrackRenderer: Processing range', rangeIndex, 'from', range.start_time, 'to', range.end_time);
        
        // Filter data to only include points within this time range
        const rangeData = data.filter(point => {
          const timestamp = new Date(point.Datetime).getTime();
          return timestamp >= startTime && timestamp <= endTime;
        });
        
        debug('ContinuousTrackRenderer: Range', rangeIndex, 'has', rangeData.length, 'points');

        if (rangeData.length > 0) {
          // Create continuous segments for this range
          const rangeSegments = createContinuousSegments(rangeData, samplingFrequency, config);
          
          // Get color for this range based on selection order
          // Use default blue color when there are more than 8 selections (same as colorScale.ts)
          const rangeColor = allRanges.length > 8 ? '#1f77b4' : getColorByIndex(rangeIndex);
          
          rangeSegments.forEach((segment, segmentIndex) => {
            if (segment.length < 2) return;

            const selectionPath = trackOverlay.append("path")
              .datum(segment) // Bind the data to the path using D3's datum
              .attr("class", "interactive-line selection-overlay")
              .attr("d", lineGenerator)
              .attr("stroke", rangeColor)
              .attr("stroke-width", 2) // Thicker line for selections
              .attr("stroke-linecap", "round")
              .attr("fill", "none")
              .style("pointer-events", "all")
              .style("cursor", "pointer")
              .style("z-index", "10"); // Ensure selections appear on top

            // Helper function to find closest point for selection path
            const findClosestPointForSelection = (event: MouseEvent): TrackPoint => {
              const [mouseX, mouseY] = d3.pointer(event, trackOverlay.node());
              let closestPoint = segment[0];
              let minDistance = Infinity;

              segment.forEach(point => {
                const pointLat = getLat(point);
                const pointLng = getLng(point);
                if (!pointLat || !pointLng || isNaN(pointLat) || isNaN(pointLng)) return;
                const mapPoint = map.project([pointLng, pointLat]);
                const distance = Math.sqrt(
                  Math.pow(mouseX - mapPoint.x, 2) + Math.pow(mouseY - mapPoint.y, 2)
                );
                if (distance < minDistance) {
                  minDistance = distance;
                  closestPoint = point;
                }
              });

              return closestPoint;
            };

            // Add click handler for the selection path
            selectionPath.on("click", (event) => {
              event.stopPropagation();
              if (onPointClick) {
                onPointClick(findClosestPointForSelection(event));
              }
            });

            // Add tooltip handlers for selection paths
            if (props.onMouseOver && props.onMouseOut) {
              selectionPath.on("mouseover", (event) => {
                props.onMouseOver(event, findClosestPointForSelection(event));
              })
              .on("mouseout", (event) => {
                props.onMouseOut(event);
              });
            }
          });
        }
      });
    }

    // Add maneuver circles and labels (only if enabled)
    if (maneuversEnabled !== false) {
      const maneuverData = data.filter((d) => d.Maneuver_type && d.Maneuver_type.length === 1 && /[A-Za-z]/.test(d.Maneuver_type));
      
      const isTilesAvailable = tilesAvailable !== false; // default true

      // Helper function to handle maneuver click - adds event_id to selectedEvents
      const handleManeuverClick = async (event: MouseEvent, d: TrackPoint) => {
        event.stopPropagation();
        event.preventDefault();
        warn('ContinuousTrackRenderer: Maneuver clicked!', { 
          Maneuver_type: d.Maneuver_type,
          Datetime: d.Datetime
        });
        
        try {
          // Get all events from IndexedDB to find the one containing this maneuver's time
          const className = persistantStore.selectedClassName();
          if (!className) {
            warn('ContinuousTrackRenderer: No className available');
            return;
          }
          
          const allEvents = await unifiedDataStore.fetchEvents(
            className,
            persistantStore.selectedProjectId(),
            persistantStore.selectedDatasetId()
          );
          
          if (!allEvents || allEvents.length === 0) {
            warn('ContinuousTrackRenderer: No events found in IndexedDB');
            return;
          }
          
          // Find the event whose time range contains the maneuver's time
          // Only consider events of type TACK, GYBE, ROUNDUP, or BEARAWAY
          const validEventTypes = ['TACK', 'GYBE', 'ROUNDUP', 'BEARAWAY'];
          const maneuverTime = new Date(d.Datetime).getTime();
          let matchingEvent = null;
          let closestEvent = null;
          let closestDistance = Infinity;
          
          for (const evt of allEvents) {
            // Only consider valid maneuver event types
            if (!validEventTypes.includes(evt.event_type?.toUpperCase())) {
              continue;
            }
            
            const eventStart = new Date(evt.start_time).getTime();
            const eventEnd = new Date(evt.end_time).getTime();
            
            // Check if maneuver time is within this event's range
            if (maneuverTime >= eventStart && maneuverTime <= eventEnd) {
              matchingEvent = evt;
              break; // Found exact match
            }
            
            // Track closest event (smallest distance to either start or end)
            const distToStart = Math.abs(maneuverTime - eventStart);
            const distToEnd = Math.abs(maneuverTime - eventEnd);
            const minDist = Math.min(distToStart, distToEnd);
            
            if (minDist < closestDistance) {
              closestDistance = minDist;
              closestEvent = evt;
            }
          }
          
          // Use matching event if found, otherwise use closest
          const eventToAdd = matchingEvent || closestEvent;
          
          if (eventToAdd && eventToAdd.event_id) {
            const currentEvents = selectedEvents();
            const eventId = eventToAdd.event_id;
            
            warn('ContinuousTrackRenderer: Found event for maneuver', { 
              event_id: eventId,
              event_type: eventToAdd.event_type,
              wasExactMatch: !!matchingEvent,
              closestDistance: closestDistance
            });
            
            // Only add if not already in the list
            if (!currentEvents.includes(eventId)) {
              setSelectedEvents([...currentEvents, eventId]);
              warn('ContinuousTrackRenderer: Event added successfully', { 
                newEvents: [...currentEvents, eventId]
              });
            } else {
              warn('ContinuousTrackRenderer: Event already in list, skipping');
            }
          } else {
            warn('ContinuousTrackRenderer: No matching event found for maneuver time', {
              maneuverTime: new Date(d.Datetime).toISOString(),
              totalEvents: allEvents.length
            });
          }
        } catch (error) {
          warn('ContinuousTrackRenderer: Error looking up event for maneuver', error);
        }
      };

      // Create a group for each maneuver to handle hover on both circle and label
      // Render maneuvers AFTER track lines so they're on top and clickable
      const maneuverGroups = trackOverlay.selectAll(".maneuver-group")
        .data(maneuverData)
        .enter()
        .append("g")
        .attr("class", "maneuver-group")
        .style("cursor", "pointer")
        .style("pointer-events", "all")
        .style("z-index", "1000")
        .on("click", (event, d) => {
          warn('ContinuousTrackRenderer: Click event received on group');
          handleManeuverClick(event, d);
        });

      // Add circles to groups
      maneuverGroups.append("circle")
        .attr("class", "maneuver-circle")
        .attr("cx", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) {
            warn('ContinuousTrackRenderer: Skipping maneuver - missing coordinates:', { Lng: dLng, Lat: dLat });
            return 0;
          }
          return map.project([dLng, dLat]).x;
        })
        .attr("cy", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) {
            return 0;
          }
          return map.project([dLng, dLat]).y;
        })
        .attr("r", 3)
        .style("fill", isTilesAvailable ? "white" : "black")
        .style("opacity", 0.8)
        .style("pointer-events", "all")
        .style("transition", "r 0.2s ease")
        .on("click", (event, d) => {
          warn('ContinuousTrackRenderer: Click event received on circle');
          handleManeuverClick(event, d);
        });

      // Add labels to groups
      maneuverGroups.append("text")
        .attr("class", "maneuver-label non-selectable")
        .attr("x", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) return 0;
          return map.project([dLng, dLat]).x + 5;
        })
        .attr("y", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          if (!dLng || !dLat || isNaN(dLng) || isNaN(dLat)) return 0;
          return map.project([dLng, dLat]).y + 5;
        })
        .text((d) => d.Maneuver_type)
        .style("font-size", "14px")
        .style("font-weight", "bold")
        .attr("user-select", "none")
        .style("fill", isTilesAvailable ? "white" : "black")
        .style("opacity", 0.8)
        .style("pointer-events", "all")
        .style("transition", "font-size 0.2s ease")
        .on("click", (event, d) => {
          warn('ContinuousTrackRenderer: Click event received on label');
          handleManeuverClick(event, d);
        });

      // Add hover effects to groups
      maneuverGroups
        .on("mouseover", function(event, d) {
          // Make circle bigger
          d3.select(this).select(".maneuver-circle")
            .attr("r", 6)
            .style("opacity", 1);
          // Make label bigger
          d3.select(this).select(".maneuver-label")
            .style("font-size", "20px")
            .style("opacity", 1);
        })
        .on("mouseout", function(event, d) {
          // Make circle smaller
          d3.select(this).select(".maneuver-circle")
            .attr("r", 3)
            .style("opacity", 0.8);
          // Make label smaller
          d3.select(this).select(".maneuver-label")
            .style("font-size", "14px")
            .style("opacity", 0.8);
        });
    }

    debug(`[ContinuousTrackRenderer] SUCCESS: Returning success`);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    debug(`[ContinuousTrackRenderer] ERROR: ${errorMessage}`, { stack: errorStack });
    warn(`[ContinuousTrackRenderer] Render failed:`, error);
    return { success: false, error: errorMessage };
  }
}

// Helper function to check which cut range a point belongs to (if any)
function getCutRangeIndex(point: TrackPoint, cutRanges: any[]): number {
  if (!cutRanges || cutRanges.length === 0) return -1;
  
  const pointTime = new Date(point.Datetime).getTime();
  
  for (let i = 0; i < cutRanges.length; i++) {
    const range = cutRanges[i];
    if (typeof range === 'number') continue; // Skip event IDs
    
    if (range.start_time && range.end_time) {
      const startTime = new Date(range.start_time).getTime();
      const endTime = new Date(range.end_time).getTime();
      if (pointTime >= startTime && pointTime <= endTime) {
        return i;
      }
    }
  }
  
  return -1; // Point doesn't belong to any cut range
}

// Max gap (ms) we still bridge at a consecutive leg boundary (e.g. leg 0 -> leg 1) to avoid a visible 1–2s gap from source data
const LEG_BOUNDARY_BRIDGE_MS = 2500;

function getLegNumber(p: TrackPoint): number | undefined {
  const v = p?.leg_number ?? p?.Leg_number ?? p?.LEG;
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Create continuous segments with gap detection
function createContinuousSegments(data: TrackPoint[], samplingFrequency: number, config: any): TrackPoint[][] {
  const segments: TrackPoint[][] = [];
  let currentSegment: TrackPoint[] = [];
  
  // LOD: Disable gap detection when zoom < 16 to prevent breaking sampled tracks
  const zoomLevel = config.zoomLevel ?? 16;
  const disableGapDetection = zoomLevel < 16;
  
  const expectedInterval = 1000 / samplingFrequency;
  const gapThreshold = disableGapDetection ? Infinity : (config.gapThreshold || (expectedInterval * 3));
  
  // Check if we're in cut mode and get cut ranges
  const currentIsCut = isCut();
  const currentCutEvents = cutEvents();
  const hasMultipleCutRanges = currentIsCut && currentCutEvents && currentCutEvents.length > 1;

  data.forEach((point, index) => {
    if (index === 0) {
      currentSegment.push(point);
    } else {
      const prevPoint = data[index - 1];
      const timeDiff = Math.abs(new Date(point.Datetime).getTime() - new Date(prevPoint.Datetime).getTime());
      
      // Check if we're transitioning between different cut ranges
      let shouldBreak = false;
      if (hasMultipleCutRanges) {
        const prevRangeIndex = getCutRangeIndex(prevPoint, currentCutEvents);
        const currRangeIndex = getCutRangeIndex(point, currentCutEvents);
        
        // Break if points belong to different cut ranges (or one is outside all ranges)
        if (prevRangeIndex !== currRangeIndex) {
          shouldBreak = true;
          debug('ContinuousTrackRenderer: Breaking segment at cut range boundary', {
            prevRangeIndex,
            currRangeIndex,
            prevTime: prevPoint.Datetime,
            currTime: point.Datetime
          });
        }
      }

      // Don't break for a small gap at a consecutive leg boundary (e.g. leg 0 -> leg 1); source data can have a 1–2s gap there
      const prevLeg = getLegNumber(prevPoint);
      const currLeg = getLegNumber(point);
      const isConsecutiveLegBoundary =
        prevLeg !== undefined &&
        currLeg !== undefined &&
        timeDiff > gapThreshold &&
        timeDiff <= LEG_BOUNDARY_BRIDGE_MS &&
        Math.abs((currLeg ?? 0) - (prevLeg ?? 0)) === 1;
      const bridgeLegBoundary = isConsecutiveLegBoundary && !shouldBreak;
      
      // Break segment on time gaps OR cut range boundaries (unless bridging leg boundary)
      // When zoom < 12, gap detection is disabled (gapThreshold = Infinity), so only cut range boundaries break segments
      if ((timeDiff > gapThreshold || shouldBreak) && !bridgeLegBoundary) {
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
}

