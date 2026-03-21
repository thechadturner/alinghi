// @ts-nocheck
import * as d3 from "d3";
import { TrackRendererProps, RendererResult } from "./types";
import { TrackPoint } from "../hooks/useTrackRendering";
import { warn, debug } from "../../../../utils/console";
import { cutEvents, isCut, setSelectedEvents, selectedEvents, selectedRanges } from "../../../../store/selectionStore";
import { getColorByIndex } from "../../../../utils/colorScale";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { persistantStore } from "../../../../store/persistantStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";

export function renderSegmentedTracks(props: TrackRendererProps): RendererResult {
  try {
    debug(`[SegmentedTrackRenderer] ENTRY: renderSegmentedTracks called`);
    
    const { data, map, trackOverlay, config, samplingFrequency, onPointClick, tilesAvailable, getColor, getThickness, maneuversEnabled } = props;
    const cfg: any = config || {};
    
    debug(`[SegmentedTrackRenderer] Props extracted`, {
      dataLength: data?.length || 0,
      hasMap: !!map,
      hasTrackOverlay: !!trackOverlay,
      zoomLevel: cfg.zoomLevel,
      maptype: cfg.maptype
    });
  
    // Get dynamic channel names from store
    const { latName, lngName } = defaultChannelsStore;
    
    // Helper function to get Lat/Lng values with case-insensitive fallback
    const getLat = (d: any): number | undefined => {
      if (!d) return undefined;
      const latField = latName();
      // Try multiple field name variations for robustness
      const val = d[latField];
      if (val === undefined || val === null) return undefined;
      const numVal = Number(val);
      return isNaN(numVal) ? undefined : numVal;
    };
    
    const getLng = (d: any): number | undefined => {
      if (!d) return undefined;
      const lngField = lngName();
      // Try multiple field name variations for robustness
      const val = d[lngField];
      if (val === undefined || val === null) return undefined;
      const numVal = Number(val);
      return isNaN(numVal) ? undefined : numVal;
    };
    
    // Clear existing tracks and maneuvers
    trackOverlay.selectAll(".interactive-line").remove();
    trackOverlay.selectAll(".maneuver-group").remove();

    if (!data || data.length === 0) {
      return { success: true };
    }

    // Check if we're in cut mode and get cut ranges - ALWAYS read fresh values
    // Don't cache these - they need to be reactive to state changes
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    const hasCutRanges = currentIsCut && currentCutEvents && currentCutEvents.length > 0;
    
    // Helper to check which cut range a point belongs to (if any)
    // Returns -1 if point is outside all cut ranges, or the index of the range it belongs to
    const getCutRangeIndex = (point: TrackPoint): number => {
      if (!hasCutRanges) return -1;
      const pointTime = new Date(point.Datetime).getTime();
      
      for (let i = 0; i < currentCutEvents.length; i++) {
        const range = currentCutEvents[i];
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
    };

    // Draw individual line segments (like MapStandard)
    let segmentsDrawn = 0;
    let segmentsSkipped = 0;
    debug(`[SegmentedTrackRenderer] Starting to draw ${data.length - 1} potential segments`);
    
    for (let i = 0; i < data.length - 1; i++) {
      const curr = data[i];
      const next = data[i + 1];
      
      // Get coordinates using dynamic channel names
      const currLat = getLat(curr);
      const currLng = getLng(curr);
      const nextLat = getLat(next);
      const nextLng = getLng(next);
      
      // Safety check for missing or invalid coordinates before calling map.project()
      if (currLng === undefined || currLat === undefined || nextLng === undefined || nextLat === undefined ||
          isNaN(currLng) || isNaN(currLat) || isNaN(nextLng) || isNaN(nextLat)) {
        // Skip this segment if coordinates are invalid
        segmentsSkipped++;
        continue;
      }
      
      const x1 = map.project([currLng, currLat]).x;
      const y1 = map.project([currLng, currLat]).y;
      const x2 = map.project([nextLng, nextLat]).x;
      const y2 = map.project([nextLng, nextLat]).y;
      
      // Debug first few segments to check coordinates
      if (segmentsDrawn <= 3) {
        debug(`[SegmentedTrackRenderer] Segment ${segmentsDrawn}:`, {
          curr: { lat: currLat, lng: currLng },
          next: { lat: nextLat, lng: nextLng },
          projected: { x1, y1, x2, y2 },
          isValid: !isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)
        });
      }

      // Check for time gap
      // LOD: Disable gap detection when zoom < 16 to prevent breaking sampled tracks
      const zoomLevel = cfg.zoomLevel ?? 16;
      const disableGapDetection = zoomLevel < 16;
      
      // Check for cut range boundary - ALWAYS check, even if data is filtered
      // This is critical because filtered data still needs gaps between different cut ranges
      let isCutRangeBoundary = false;
      if (hasCutRanges && currentCutEvents && currentCutEvents.length > 0) {
        const currRangeIndex = getCutRangeIndex(curr);
        const nextRangeIndex = getCutRangeIndex(next);
        
        // Skip segment if points belong to different cut ranges (or one is inside and one is outside)
        // This creates gaps between cut ranges and between cut ranges and non-cut data
        // CRITICAL: Check this even if both points are within cut ranges (they might be in different ranges)
        if (currRangeIndex !== nextRangeIndex) {
          isCutRangeBoundary = true;
        }
      }
      
      // When zoom < 12, completely skip gap detection - only check cut range boundaries
      const expectedInterval = 1000 / samplingFrequency;
      const gapThreshold = (cfg && cfg.gapThreshold) ? cfg.gapThreshold : Math.min(expectedInterval * 3, 1000);
      const timeDiff = Math.abs(new Date(curr.Datetime).getTime() - new Date(next.Datetime).getTime());
      const legBoundaryBridgeMs = 2500;
      const prevLeg = curr.leg_number ?? curr.Leg_number ?? curr.LEG;
      const nextLeg = next.leg_number ?? next.Leg_number ?? next.LEG;
      const prevLegNum = prevLeg !== undefined && prevLeg !== null && !isNaN(Number(prevLeg)) ? Number(prevLeg) : undefined;
      const nextLegNum = nextLeg !== undefined && nextLeg !== null && !isNaN(Number(nextLeg)) ? Number(nextLeg) : undefined;
      const isConsecutiveLegBoundary =
        prevLegNum !== undefined &&
        nextLegNum !== undefined &&
        timeDiff > gapThreshold &&
        timeDiff <= legBoundaryBridgeMs &&
        Math.abs(nextLegNum - prevLegNum) === 1;
      const bridgeLegBoundary = isConsecutiveLegBoundary && !isCutRangeBoundary;

      if (!disableGapDetection) {
        // Only do gap detection when zoom >= 12
        // Debug gap detection for first few segments
        if (segmentsDrawn < 3) {
          debug(`[SegmentedTrackRenderer] Gap detection check:`, {
            zoomLevel,
            disableGapDetection,
            gapThreshold,
            timeDiff,
            expectedInterval,
            samplingFrequency,
            willSkip: timeDiff > gapThreshold && !bridgeLegBoundary
          });
        }
        
        if ((timeDiff > gapThreshold || isCutRangeBoundary) && !bridgeLegBoundary) {
          segmentsSkipped++;
          if (segmentsSkipped <= 3) {
            debug(`[SegmentedTrackRenderer] Skipping segment due to gap or cut boundary:`, {
              timeDiff,
              gapThreshold,
              isCutRangeBoundary,
              reason: timeDiff > gapThreshold ? 'time gap' : 'cut boundary'
            });
          }
          continue; // Skip this segment due to time gap or cut range boundary
        }
      } else {
        // Zoom < 12: Only skip if cut range boundary, ignore time gaps
        if (isCutRangeBoundary) {
          segmentsSkipped++;
          if (segmentsSkipped <= 3) {
            debug(`[SegmentedTrackRenderer] Skipping segment due to cut boundary (gap detection disabled at zoom ${zoomLevel})`);
          }
          continue;
        }
      }

      // Only draw the line if we passed all checks
      segmentsDrawn++;
      const strokeColor = getColor(curr, next, cfg);
      const strokeWidth = getThickness(curr, next, cfg);
      
      const line = trackOverlay.append("line")
        .attr("class", "interactive-line")
        .attr("x1", x1)
        .attr("y1", y1)
        .attr("x2", x2)
        .attr("y2", y2)
        .attr("stroke", strokeColor)
        .attr("stroke-width", strokeWidth)
        .attr("stroke-linecap", "round")
        .style("pointer-events", "all")
        .style("cursor", "pointer")
        .style("opacity", 1) // Explicitly set opacity to ensure visibility
        .on("click", (event) => {
          event.stopPropagation();
          if (onPointClick) {
            // Find the closest point to the click
            const [mouseX, mouseY] = d3.pointer(event, trackOverlay.node());
            let closestPoint = curr;
            let minDistance = Infinity;

            [curr, next].forEach(point => {
              const pointLat = getLat(point);
              const pointLng = getLng(point);
              // Validate coordinates before calling map.project() to avoid NaN errors
              if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) return;
              const mapPoint = map.project([pointLng, pointLat]);
              const distance = Math.sqrt(
                Math.pow(mouseX - mapPoint.x, 2) + Math.pow(mouseY - mapPoint.y, 2)
              );
              if (distance < minDistance) {
                minDistance = distance;
                closestPoint = point;
              }
            });

            onPointClick(closestPoint);
          }
        });

      // Add tooltip handlers
      if (props.onMouseOver && props.onMouseOut) {
        line.on("mouseover", (event) => {
          // Use the current point (first point of the segment) for tooltip
          props.onMouseOver(event, curr);
        })
        .on("mouseout", (event) => {
          props.onMouseOut(event);
        });
      }
    }
    
    debug(`[SegmentedTrackRenderer] Drawn ${segmentsDrawn} segments, skipped ${segmentsSkipped} segments`);

    // Render selection overlays on top of base track
    // Check for selectedRanges (event selections) - only event selections get colored overlays
    const currentSelectedRanges = selectedRanges();
    const hasEventSelections = currentSelectedRanges && currentSelectedRanges.length > 0;
    
    if (hasEventSelections && currentSelectedRanges.length > 0) {
      debug('SegmentedTrackRenderer: Rendering', currentSelectedRanges.length, 'selected ranges (events)');
      
      // Loop through each selected range and render it on top
      currentSelectedRanges.forEach((range, rangeIndex) => {
        const startTime = new Date(range.start_time).getTime();
        const endTime = new Date(range.end_time).getTime();
        
        debug('SegmentedTrackRenderer: Processing range', rangeIndex, 'from', range.start_time, 'to', range.end_time);
        
        // Filter data to only include points within this time range
        const rangeData = data.filter(point => {
          const timestamp = new Date(point.Datetime).getTime();
          return timestamp >= startTime && timestamp <= endTime;
        });
        
        debug('SegmentedTrackRenderer: Range', rangeIndex, 'has', rangeData.length, 'points');

        if (rangeData.length > 0) {
          // Draw segments for this range with thicker lines and different colors
          let overlaySegmentsDrawn = 0;
          
          for (let i = 0; i < rangeData.length - 1; i++) {
            const curr = rangeData[i];
            const next = rangeData[i + 1];
            
            // Get coordinates using dynamic channel names
            const currLat = getLat(curr);
            const currLng = getLng(curr);
            const nextLat = getLat(next);
            const nextLng = getLng(next);
            
            // Safety check for missing or invalid coordinates
            if (currLng === undefined || currLat === undefined || nextLng === undefined || nextLat === undefined ||
                isNaN(currLng) || isNaN(currLat) || isNaN(nextLng) || isNaN(nextLat)) {
              continue;
            }
            
            const x1 = map.project([currLng, currLat]).x;
            const y1 = map.project([currLng, currLat]).y;
            const x2 = map.project([nextLng, nextLat]).x;
            const y2 = map.project([nextLng, nextLat]).y;
            
            // Get color for this range based on selection order
            // Use default blue color when there are more than 8 selections (same as colorScale.ts)
            const rangeColor = currentSelectedRanges.length > 8 ? '#1f77b4' : getColorByIndex(rangeIndex);
            
            // Draw overlay segment with thicker line and range color
            const overlayLine = trackOverlay.append("line")
              .attr("class", "interactive-line selection-overlay")
              .attr("x1", x1)
              .attr("y1", y1)
              .attr("x2", x2)
              .attr("y2", y2)
              .attr("stroke", rangeColor)
              .attr("stroke-width", 3) // Thicker line for selections
              .attr("stroke-linecap", "round")
              .style("pointer-events", "all")
              .style("cursor", "pointer")
              .style("z-index", "10") // Ensure selections appear on top
              .on("click", (event) => {
                event.stopPropagation();
                if (onPointClick) {
                  // Find the closest point to the click
                  const [mouseX, mouseY] = d3.pointer(event, trackOverlay.node());
                  let closestPoint = curr;
                  let minDistance = Infinity;

                  [curr, next].forEach(point => {
                    const pointLat = getLat(point);
                    const pointLng = getLng(point);
                    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) return;
                    const mapPoint = map.project([pointLng, pointLat]);
                    const distance = Math.sqrt(
                      Math.pow(mouseX - mapPoint.x, 2) + Math.pow(mouseY - mapPoint.y, 2)
                    );
                    if (distance < minDistance) {
                      minDistance = distance;
                      closestPoint = point;
                    }
                  });

                  onPointClick(closestPoint);
                }
              });

            // Add tooltip handlers for overlay segments
            if (props.onMouseOver && props.onMouseOut) {
              overlayLine.on("mouseover", (event) => {
                props.onMouseOver(event, curr);
              })
              .on("mouseout", (event) => {
                props.onMouseOut(event);
              });
            }
            
            overlaySegmentsDrawn++;
          }
          
          debug('SegmentedTrackRenderer: Range', rangeIndex, 'drew', overlaySegmentsDrawn, 'overlay segments');
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
        warn('SegmentedTrackRenderer: Maneuver clicked!', { 
          Maneuver_type: d.Maneuver_type,
          Datetime: d.Datetime
        });
        
        try {
          // Get all events from IndexedDB to find the one containing this maneuver's time
          const className = persistantStore.selectedClassName();
          if (!className) {
            warn('SegmentedTrackRenderer: No className available');
            return;
          }
          
          const allEvents = await unifiedDataStore.fetchEvents(
            className,
            persistantStore.selectedProjectId(),
            persistantStore.selectedDatasetId()
          );
          
          if (!allEvents || allEvents.length === 0) {
            warn('SegmentedTrackRenderer: No events found in IndexedDB');
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
            
            warn('SegmentedTrackRenderer: Found event for maneuver', { 
              event_id: eventId,
              event_type: eventToAdd.event_type,
              wasExactMatch: !!matchingEvent,
              closestDistance: closestDistance
            });
            
            // Only add if not already in the list
            if (!currentEvents.includes(eventId)) {
              setSelectedEvents([...currentEvents, eventId]);
              warn('SegmentedTrackRenderer: Event added successfully', { 
                newEvents: [...currentEvents, eventId]
              });
            } else {
              warn('SegmentedTrackRenderer: Event already in list, skipping');
            }
          } else {
            warn('SegmentedTrackRenderer: No matching event found for maneuver time', {
              maneuverTime: new Date(d.Datetime).toISOString(),
              totalEvents: allEvents.length
            });
          }
        } catch (error) {
          warn('SegmentedTrackRenderer: Error looking up event for maneuver', error);
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
          warn('SegmentedTrackRenderer: Click event received on group');
          handleManeuverClick(event, d);
        });

      // Add circles to groups
      maneuverGroups.append("circle")
        .attr("class", "maneuver-circle")
        .attr("cx", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          // Validate coordinates before calling map.project() to avoid NaN errors
          if (dLat === undefined || dLng === undefined || isNaN(dLat) || isNaN(dLng)) {
            warn('SegmentedTrackRenderer: Skipping maneuver - missing coordinates:', { Lng: dLng, Lat: dLat });
            return 0;
          }
          return map.project([dLng, dLat]).x;
        })
        .attr("cy", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          // Validate coordinates before calling map.project() to avoid NaN errors
          if (dLat === undefined || dLng === undefined || isNaN(dLat) || isNaN(dLng)) {
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
          warn('SegmentedTrackRenderer: Click event received on circle');
          handleManeuverClick(event, d);
        });

      // Add labels to groups
      maneuverGroups.append("text")
        .attr("class", "maneuver-label non-selectable")
        .attr("x", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          // Validate coordinates before calling map.project() to avoid NaN errors
          if (dLat === undefined || dLng === undefined || isNaN(dLat) || isNaN(dLng)) return 0;
          return map.project([dLng, dLat]).x + 5;
        })
        .attr("y", (d: TrackPoint) => {
          const dLat = getLat(d);
          const dLng = getLng(d);
          // Validate coordinates before calling map.project() to avoid NaN errors
          if (dLat === undefined || dLng === undefined || isNaN(dLat) || isNaN(dLng)) return 0;
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
          warn('SegmentedTrackRenderer: Click event received on label');
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
        .on("mouseout", function(d) {
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

    debug(`[SegmentedTrackRenderer] SUCCESS: Returning success`);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    debug(`[SegmentedTrackRenderer] ERROR: ${errorMessage}`, { stack: errorStack });
    warn(`[SegmentedTrackRenderer] Render failed:`, error);
    return { success: false, error: errorMessage };
  }
}

