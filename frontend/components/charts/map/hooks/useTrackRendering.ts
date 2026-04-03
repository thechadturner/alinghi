// @ts-nocheck
import { createSignal, createEffect } from "solid-js";
import * as d3 from "d3";
import { selectedEvents, hasSelection, selectedRange, selectedRanges, cutEvents, isCut } from "../../../../store/selectionStore";
import { applyDataFilter } from "../../../../utils/dataFiltering";
import { createD3EventColorScale, debugColorScale } from "../../../../utils/colorScale";
import { persistantStore } from "../../../../store/persistantStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { apiEndpoints } from "../../../../config/env";
import { getData } from "../../../../utils/global";
import { debug } from "../../../../utils/console";
import { bspValueFromRow, twsValueFromRow, vmgPercValueFromRow, vmgValueFromRow } from "../../../../utils/speedUnits";

// Helper function to filter data for map - only applies selectedRange (brush) and cutEvents, not selectedRanges (events)
const applyMapDataFilter = (data: any[]): any[] => {
  if (!data || data.length === 0) {
    return [];
  }
  
  const getTimestamp = (d: any) => {
    if (d.timestamp) return d.timestamp;
    if (d.Datetime) return new Date(d.Datetime).getTime();
    return 0;
  };
  
  // Check for brush selection (selectedRange)
  // Only check selectedRange().length - hasSelection() may not be set correctly in all cases
  const currentSelectedRange = selectedRange();
  if (currentSelectedRange && currentSelectedRange.length > 0) {
    const rangeItem = currentSelectedRange[0];
    const startTime = new Date(rangeItem.start_time).getTime();
    const endTime = new Date(rangeItem.end_time).getTime();
    return data.filter((d) => {
      const timestamp = getTimestamp(d);
      return timestamp >= startTime && timestamp <= endTime;
    });
  }
  
  // Check for cut events - handle multiple cut ranges
  const currentCutEvents = cutEvents();
  if (currentCutEvents.length > 0) {
    return data.filter((d) => {
      const timestamp = getTimestamp(d);
      return currentCutEvents.some(range => {
        // Handle both time range objects and event IDs (for backward compatibility)
        if (typeof range === 'number') {
          return false; // Skip if it's an event ID instead of a time range
        }
        if (range.start_time && range.end_time) {
          const startTime = new Date(range.start_time).getTime();
          const endTime = new Date(range.end_time).getTime();
          return timestamp >= startTime && timestamp <= endTime;
        }
        return false;
      });
    });
  }
  
  // No brush or cut - return all data
  return data;
};

export interface TrackPoint {
  Datetime: Date;
  Lat: number;
  Lng: number;
  Twd: number;
  Twa: number;
  Tws: number;
  Bsp: number;
  Hdg: number;
  Grade: number;
  Vmg_perc: number;
  event_id: number;
  [key: string]: any;
}

export interface TrackConfig {
  maptype: 'DEFAULT' | 'GRADE' | 'WIND' | 'VMG' | 'MANEUVERS' | 'PHASE';
  samplingFrequency: number;
  showGaps: boolean;
  gapThreshold?: number;
}

export interface TrackSegment {
  id: string;
  points: TrackPoint[];
  color: string;
  thickness: number;
  metadata: {
    grade: number;
    eventId: number;
    timeRange: { start: Date; end: Date };
    averageSpeed: number;
  };
}

export function useTrackRendering(config: TrackConfig) {
  // Read maptype directly from store to ensure reactivity when color option changes
  const { colorType: maptype } = persistantStore;
  
  // Get dynamic channel names from store
  const { twsName, twdName, bspName, vmgName, vmgPercName, isReady: defaultChannelsReady } = defaultChannelsStore;
  
  // Log when default channels become ready
  createEffect(() => {
    const ready = defaultChannelsReady();
    const channels = defaultChannelsStore.defaultChannels();
    if (ready && channels) {
      debug('useTrackRendering: Default channels ready', {
        tws: twsName(),
        twd: twdName(),
        bsp: bspName(),
        allChannels: channels
      });
    }
  });
  const S20colorScale = d3.scaleOrdinal(d3.schemeCategory10);
  let myLinearColor = d3.scaleLinear();
  let myLinearThickness = d3.scaleLinear();
  let myOrdinalColor = d3.scaleOrdinal();
  
  // Source color state
  const [sourceColor, setSourceColor] = createSignal<string>("darkblue");
  const [sourceColorLoaded, setSourceColorLoaded] = createSignal<boolean>(false);

  // Function to get source color from sourcesStore (synchronous)
  const fetchSourceColor = (): string => {
    try {
      const { selectedSourceId } = persistantStore;
      const sourceId = selectedSourceId();
      
      if (!sourceId) {
        return "darkblue"; // Default color
      }
      
      // Wait for sourcesStore to be ready
      if (!sourcesStore.isReady()) {
        return "darkblue"; // Default color if not ready
      }
      
      const sourceName = sourcesStore.getSourceName(sourceId);
      if (!sourceName) {
        return "darkblue"; // Default color if source not found
      }
      
      const color = sourcesStore.getSourceColor(sourceName);
      return color || "darkblue"; // Default color if no color set
    } catch (error) {
      debug('Error getting source color from sourcesStore:', error);
      return "darkblue"; // Default color
    }
  };

  // Load source color when component initializes or when source changes - wait for sourcesStore to be ready
  createEffect(() => {
    // Check if sourcesStore is ready
    const storeReady = sourcesStore.isReady();
    const { selectedSourceId } = persistantStore;
    const sourceId = selectedSourceId();
    
    // Wait for sourcesStore to be ready before setting source color
    if (!storeReady) {
      // Store not ready yet - keep loaded state as false
      setSourceColorLoaded(false);
      return;
    }
    
    // Store is ready - fetch color (will return default "darkblue" if no sourceId)
    const color = fetchSourceColor();
    if (color) {
      setSourceColor(color);
      setSourceColorLoaded(true);
      debug('useTrackRendering: Source color loaded:', color, 'for sourceId:', sourceId || 'none (using default)');
    } else {
      // If fetchSourceColor returns null (shouldn't happen when store is ready), use default
      setSourceColor("darkblue");
      setSourceColorLoaded(true);
      debug('useTrackRendering: Using default source color (darkblue)');
    }
  });

  // Helper function to get timestamp from data point
  const getTimestamp = (d: TrackPoint): Date => {
    if (!d) return new Date(0);
    
    const timestamp = d.Datetime;
    
    if (!timestamp) return new Date(0);
    
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    
    return new Date(0);
  };

  // Helper function to compute 1-sigma range (mean ± 1 std) for map coloring
  const getOneSigmaRange = (data: TrackPoint[], accessor: (p: TrackPoint) => number): [number, number] => {
    const values = data.map(accessor).filter(v => !isNaN(v) && isFinite(v));
    if (values.length === 0) return [0, 1];
    
    const mean = d3.mean(values) || 0;
    const std = d3.deviation(values) || 0;
    const min = mean - std;
    const max = mean + std;
    
    return [min, max];
  };

  // Initialize color scales based on data and maptype
  const initScales = (data: TrackPoint[], config: TrackConfig) => {
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      myOrdinalColor = d3.scaleOrdinal();

      // Get unique event_ids from the actual data points, not from selectedEvents
      // This ensures the color scale matches the event_id values that are actually in the data
      const dataEventIds = data
        .map(point => point.event_id)
        .filter(id => id !== undefined && id !== null && id > 0)
        .sort((a, b) => a - b);
      
      const uniqueEventIds = Array.from(new Set(dataEventIds));
      
      debug('useTrackRendering: Event ID analysis', {
        dataEventIds,
        uniqueEventIds,
        hasEventIds: uniqueEventIds.length > 0
      });
      
      if (uniqueEventIds.length === 0) {
        // No event_id values > 0 in data, but we have selections
        // This means the event assignment didn't work properly
        debug('useTrackRendering: No event_id > 0 found in data, falling back to normal coloring');
        // Fall back to normal coloring
        if (maptype() === "GRADE") {
          myOrdinalColor.domain([0, 1, 2, 3, 4]);
          myOrdinalColor.range(["lightgrey", "red", "lightgreen", "green", "yellow"]);
        } else if (maptype() === "WIND") {
          const twsField = twsName();
          const twdField = twdName();
          
          const [minTWS, maxTWS] = getOneSigmaRange(data, (p) =>
            twsValueFromRow(p as Record<string, unknown>, twsField, 0)
          );
          const [minTWD, maxTWD] = getOneSigmaRange(data, (p) => +(p[twdField]));

          myLinearColor.domain([minTWD, (minTWD + maxTWD) / 2, maxTWD]);
          myLinearColor.range(["red", "lightgrey", "green"]);

          myLinearThickness.domain([minTWS, maxTWS]);
          myLinearThickness.range(["0.1", "3"]);
        } else if (maptype() === "VMG%") {
          // Fixed scale for VMG%: 25% (min) to 125% (max)
          const minVMG = 25;
          const maxVMG = 125;
          myLinearColor.domain([minVMG,
            minVMG + (maxVMG - minVMG) * 0.50,
            minVMG + (maxVMG - minVMG) * 0.95,
            maxVMG]);
          myLinearColor.range(["blue", "lightblue", "yellow", "red"]);
          myLinearColor.clamp(true);

          const bspField = bspName();
          const [minBSP, maxBSP] = getOneSigmaRange(data, (p) =>
            bspValueFromRow(p as Record<string, unknown>, bspField, 0)
          );
          myLinearThickness.domain([minBSP, maxBSP]);
          myLinearThickness.range(["0.1", "3"]);
        } else if (maptype() === "VMG") {
          const vmgField = vmgName();
          let [minVMG, maxVMG] = getOneSigmaRange(data, (p) =>
            vmgValueFromRow(p as Record<string, unknown>, vmgField, 0)
          );

          myLinearColor.domain([minVMG,
            minVMG + (maxVMG - minVMG) * 0.50,
            minVMG + (maxVMG - minVMG) * 0.95,
            maxVMG]);
          myLinearColor.range(["blue", "lightblue", "yellow", "red"]);
          myLinearColor.clamp(true);

          const bspField = bspName();
          const [minBSP, maxBSP] = getOneSigmaRange(data, (p) =>
            bspValueFromRow(p as Record<string, unknown>, bspField, 0)
          );
          myLinearThickness.domain([minBSP, maxBSP]);
          myLinearThickness.range(["0.1", "3"]);
        }
      } else {
        // We have event_id values > 0, create color scale for them using global color scale
        // Use the order from selectedEvents, not the sorted order of event_id values
        const selectedEventsOrder = selectedEvents().filter(id => uniqueEventIds.includes(id));
        
        const globalColorScale = createD3EventColorScale(selectedEventsOrder);
        
        myOrdinalColor.domain(globalColorScale.domain);
        myOrdinalColor.range(globalColorScale.range);
        
        debugColorScale('useTrackRendering', selectedEventsOrder, globalColorScale);
      }
    } else {
      if (maptype() === "GRADE") {
        myOrdinalColor.domain([0, 1, 2, 3, 4]);
        myOrdinalColor.range(["lightgrey", "red", "lightgreen", "green", "yellow"]);
      } else if (maptype() === "WIND") {
        const twsField = twsName();
        const twdField = twdName();
        
        const [minTWS, maxTWS] = getOneSigmaRange(data, (p) =>
          twsValueFromRow(p as Record<string, unknown>, twsField, 0)
        );
        const [minTWD, maxTWD] = getOneSigmaRange(data, (p) => {
          const val = p[twdField];
          return val !== undefined && val !== null ? Number(val) : 0;
        });

        // Ensure valid domain (handle case where all values are 0 or invalid)
        const validMinTWD = isNaN(minTWD) || !isFinite(minTWD) ? 0 : minTWD;
        const validMaxTWD = isNaN(maxTWD) || !isFinite(maxTWD) || maxTWD === validMinTWD ? validMinTWD + 1 : maxTWD;
        const midTWD = (validMinTWD + validMaxTWD) / 2;

        myLinearColor.domain([validMinTWD, midTWD, validMaxTWD]);
        myLinearColor.range(["red", "lightgrey", "green"]);

        const validMinTWS = isNaN(minTWS) || !isFinite(minTWS) ? 0 : minTWS;
        const validMaxTWS = isNaN(maxTWS) || !isFinite(maxTWS) || maxTWS === validMinTWS ? validMinTWS + 1 : maxTWS;
        myLinearThickness.domain([validMinTWS, validMaxTWS]);
        myLinearThickness.range(["0.1", "3"]);
      } else if (maptype() === "VMG%") {
        // Fixed scale for VMG%: 25% (min) to 150% (max)
        const minVMG = 25;
        const maxVMG = 125;
        myLinearColor.domain([minVMG,
          minVMG + (maxVMG - minVMG) * 0.50,
          minVMG + (maxVMG - minVMG) * 0.95,
          maxVMG]);
        myLinearColor.range(["blue", "lightblue", "yellow", "red"]);
        myLinearColor.clamp(true);

        const bspField = bspName();
        const [minBSP, maxBSP] = getOneSigmaRange(data, (p) =>
          bspValueFromRow(p as Record<string, unknown>, bspField, 0)
        );
        myLinearThickness.domain([minBSP, maxBSP]);
        myLinearThickness.range(["0.1", "3"]);
      } else if (maptype() === "VMG") {
        const vmgField = vmgName();
        let [minVMG, maxVMG] = getOneSigmaRange(data, (p) =>
          vmgValueFromRow(p as Record<string, unknown>, vmgField, 0)
        );

        // Ensure valid domain
        const validMinVMG = isNaN(minVMG) || !isFinite(minVMG) ? 0 : minVMG;
        const validMaxVMG = isNaN(maxVMG) || !isFinite(maxVMG) || maxVMG === validMinVMG ? validMinVMG + 1 : maxVMG;

        myLinearColor.domain([validMinVMG,
          validMinVMG + (validMaxVMG - validMinVMG) * 0.50,
          validMinVMG + (validMaxVMG - validMinVMG) * 0.95,
          validMaxVMG]);
        myLinearColor.range(["blue", "lightblue", "yellow", "red"]);
        myLinearColor.clamp(true);

        const bspField = bspName();
        const [minBSP, maxBSP] = getOneSigmaRange(data, (p) =>
          bspValueFromRow(p as Record<string, unknown>, bspField, 0)
        );
        const validMinBSP = isNaN(minBSP) || !isFinite(minBSP) ? 0 : minBSP;
        const validMaxBSP = isNaN(maxBSP) || !isFinite(maxBSP) || maxBSP === validMinBSP ? validMinBSP + 1 : maxBSP;
        myLinearThickness.domain([validMinBSP, validMaxBSP]);
        myLinearThickness.range(["0.1", "3"]);
      }
    }
  };

  // Get color for a track point
  const getColor = (d: TrackPoint, prev: TrackPoint | null, config: TrackConfig): string => {
    if (!d) return "lightgrey"; // Safety check
    
    // Ensure we have a valid config
    if (!config) {
      debug('useTrackRendering: getColor called with invalid config, using default color');
      return "lightgrey";
    }
    
    // Check for time gap
    if (config.showGaps && prev && d) {
      const expectedInterval = 1000 / config.samplingFrequency;
      const gapThreshold = config.gapThreshold || (expectedInterval * 3);
      const timeDiff = Math.abs(getTimestamp(d).getTime() - getTimestamp(prev).getTime());
      
      if (timeDiff > gapThreshold) {
        return "transparent";
      }
    }
    
    // Check if there are any selected events
    // When selections exist, base track should be rendered in light grey
    // Selection overlays will be drawn on top by the renderer
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      // When selections exist, render base track in light grey
      // Selection overlays will be drawn on top by SegmentedTrackRenderer/ContinuousTrackRenderer
      return "lightgrey";
    }
    
    // No selections, use normal map coloring based on maptype (read from store for reactivity)
    if (maptype() === "DEFAULT") {
      return sourceColor();
    } else if (maptype() === "GRADE") {
      // Use normalized field name first (unifiedDataStore normalizes metadata)
      const gradeVal = d.grade || d.Grade;
      if (gradeVal === undefined || gradeVal === null) return "lightgrey";
      const color = myOrdinalColor(gradeVal);
      return color !== undefined ? color : "lightgrey";
    } else if (maptype() === "WIND") {
      const twdField = twdName();
      const twdVal = d[twdField];
      if (twdVal === undefined || twdVal === null || isNaN(Number(twdVal))) return "lightgrey";
      const color = myLinearColor(Number(twdVal));
      return color !== undefined ? color : "lightgrey";
    } else if (maptype() === "VMG%") {
      const vmgPercField = vmgPercName();
      const vmgPercVal = vmgPercValueFromRow(d as Record<string, unknown>, vmgPercField, Number.NaN);
      if (!Number.isFinite(vmgPercVal)) return "lightgrey";
      const color = myLinearColor(vmgPercVal);
      return color !== undefined ? color : "lightgrey";
    } else if (maptype() === "VMG") {
      const vmgField = vmgName();
      const vmgVal = vmgValueFromRow(d as Record<string, unknown>, vmgField, Number.NaN);
      if (!Number.isFinite(vmgVal)) return "lightgrey";
      const color = myLinearColor(vmgVal);
      return color !== undefined ? color : "lightgrey";
    } else if (maptype() === "STATE") {
      // State coloring: 0=red, 1=orange, 2=blue
      // Try multiple field names and case variations (data is normalized to lowercase)
      const stateVal = d.state ?? d.State ?? d.STATE;
      // Convert to number if it's a string, handle null/undefined
      if (stateVal === undefined || stateVal === null) {
        return "lightgrey";
      }
      const stateNum = Number(stateVal);
      if (isNaN(stateNum)) {
        return "lightgrey";
      }
      if (stateNum === 0) return "red";
      if (stateNum === 1) return "orange";
      if (stateNum === 2) return "blue";
      return "lightgrey";
    } else if (maptype() === "PHASE") {
      // Color by phase: phases in orange, non-phases in light grey
      const phaseVal = d.phase_id ?? d.Phase_id ?? d.phase ?? d.Phase;
      const isPhase = phaseVal !== undefined && phaseVal !== null && phaseVal !== '' && Number(phaseVal) > 0;
      return isPhase ? "orange" : "lightgrey";
    } else {
      return "grey";
    }
  };

  // Get thickness for a track point
  const getThickness = (d: TrackPoint, prev: TrackPoint | null, config: TrackConfig, type: 'map' | 'chart' = 'map'): number => {
    // Check for time gap
    if (config.showGaps && prev && d) {
      const expectedInterval = 1000 / config.samplingFrequency;
      const gapThreshold = config.gapThreshold || (expectedInterval * 3);
      const timeDiff = Math.abs(getTimestamp(d).getTime() - getTimestamp(prev).getTime());
      
      if (timeDiff > gapThreshold) {
        return 0;
      }
    }
    
    // Check if there are any selected events
    // When selections exist, base track should be thin (overlays will be thicker)
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      // When selections exist, render base track thin
      // Selection overlays will be drawn thicker on top by SegmentedTrackRenderer/ContinuousTrackRenderer
      return 1;
    }
    
    // No selections, use normal thickness based on maptype (read from store for reactivity)
    if (type === 'chart') {
      return 1;
    } else {
      if (maptype() === "GRADE") {
        return 2;
      } else if (maptype() === "WIND") {
        const twsField = twsName();
        const twsVal = twsValueFromRow(d as Record<string, unknown>, twsField, Number.NaN);
        return myLinearThickness(Number.isFinite(twsVal) ? twsVal : 0) || 2;
      } else if (maptype() === "VMG%" || maptype() === "VMG") {
        const bspField = bspName();
        const bspVal = bspValueFromRow(d as Record<string, unknown>, bspField, Number.NaN);
        return myLinearThickness(Number.isFinite(bspVal) ? bspVal : 0) || 2;
      } else if (maptype() === "PHASE") {
        return 2;
      } else {
        return 1;
      }
    }
  };

  // Create track segments with gap detection
  const createTrackSegments = (data: TrackPoint[], config: TrackConfig): TrackSegment[] => {
    if (!data || data.length === 0) return [];

    const segments: TrackSegment[] = [];
    let currentSegment: TrackPoint[] = [];
    const expectedInterval = 1000 / config.samplingFrequency;
    // Reduce gap threshold to show breaks more easily (1 second instead of 3x interval)
    const gapThreshold = config.gapThreshold || Math.min(expectedInterval * 3, 1000);
    
    // Import cut detection (already imported at top of file)
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    const hasMultipleCutRanges = currentIsCut && currentCutEvents && currentCutEvents.length > 1;
    
    // Helper to check which cut range a point belongs to
    const getCutRangeIndex = (point: TrackPoint): number => {
      if (!hasMultipleCutRanges) return -1;
      const pointTime = getTimestamp(point).getTime();
      
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

    data.forEach((point, index) => {
      if (index === 0) {
        currentSegment.push(point);
      } else {
        const prevPoint = data[index - 1];
        const timeDiff = Math.abs(getTimestamp(point).getTime() - getTimestamp(prevPoint).getTime());
        
        // Check for cut range boundary
        let cutRangeBreak = false;
        if (hasMultipleCutRanges) {
          const prevRangeIndex = getCutRangeIndex(prevPoint);
          const currRangeIndex = getCutRangeIndex(point);
          if (prevRangeIndex !== currRangeIndex && (prevRangeIndex >= 0 || currRangeIndex >= 0)) {
            cutRangeBreak = true;
          }
        }
        
        // Create a new segment when grade changes, event_id changes, time gap is too large, or cut range boundary
        // Use normalized field name first
        const segmentBreak = ((point.grade || point.Grade) !== (prevPoint.grade || prevPoint.Grade)) || 
                            (point.event_id !== prevPoint.event_id) ||
                            (config.showGaps && timeDiff > gapThreshold) ||
                            cutRangeBreak;
        
        if (!segmentBreak) {
          currentSegment.push(point);
        } else {
          // Complete the current segment
          if (currentSegment.length > 1) {
            segments.push(createSegmentFromPoints(currentSegment, config));
          }
          currentSegment = [point]; // Start new segment
        }
      }
    });

    // Add the last segment
    if (currentSegment.length > 1) {
      segments.push(createSegmentFromPoints(currentSegment, config));
    }

    return segments;
  };

  // Create a segment from an array of points
  const createSegmentFromPoints = (points: TrackPoint[], config: TrackConfig): TrackSegment => {
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    
    return {
      id: `segment_${getTimestamp(firstPoint).getTime()}_${getTimestamp(lastPoint).getTime()}`,
      points: points,
      color: getColor(firstPoint, null, config),
      thickness: getThickness(firstPoint, null, config),
      metadata: {
        // Use normalized field name first
        grade: firstPoint.grade || firstPoint.Grade,
        eventId: firstPoint.event_id,
        timeRange: {
          start: getTimestamp(firstPoint),
          end: getTimestamp(lastPoint)
        },
        averageSpeed: (() => {
          const bspField = bspName();
          return d3.mean(points, d => d[bspField]) || 0;
        })()
      }
    };
  };

  // Apply filters to data - for map, only apply brush selection (selectedRange), not event selections (selectedRanges)
  // This allows the map to show full dataset with overlay for event selections
  const applyFilters = (data: TrackPoint[]): TrackPoint[] => {
    // Import at top of file instead - using dynamic import here would be async
    // For now, use the imported functions from the module scope
    return applyMapDataFilter(data);
  };

  return {
    initScales,
    getColor,
    getThickness,
    createTrackSegments,
    applyFilters,
    getTimestamp,
    sourceColor,
    sourceColorLoaded,
    fetchSourceColor
  };
}
