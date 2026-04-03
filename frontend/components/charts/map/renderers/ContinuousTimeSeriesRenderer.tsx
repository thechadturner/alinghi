import * as d3 from "d3";
import { TimeSeriesRendererProps, RendererResult } from "./types";
import { TrackPoint } from "../hooks/useTrackRendering";
import { selectedEvents, selectedRanges, cutEvents, isCut } from "../../../../store/selectionStore";
import { getColorByIndex } from "../../../../utils/colorScale";
import { debug } from "../../../../utils/console";

export function renderContinuousTimeSeries(props: TimeSeriesRendererProps): RendererResult {
  const { data, svg, xScale, yScale, lineGenerator, config, samplingFrequency, colors, getColor, getThickness } = props;

  try {
    // Get current selections
    const currentSelectedEvents = selectedEvents();
    const hasSelections = currentSelectedEvents && currentSelectedEvents.length > 0;
    
    // Create continuous segments with gap detection
    const segments = createContinuousTimeSeriesSegments(data, samplingFrequency, config);
    
    // Render base track segments (grey if selections exist, normal color if no selections)
    segments.forEach((segment) => {
      if (segment.length < 2) return;

      // Determine base track color
      const baseTrackColor = hasSelections ? "grey" : getColor(segment[0], null);

      svg.append("path")
        .datum(segment)
        .attr("fill", "none")
        .attr("stroke", baseTrackColor)
        .attr("stroke-width", getThickness("chart", segment[0], null))
        .attr("d", lineGenerator);
    });

    // In DEFAULT mode, overlay selected ranges with thicker lines
    // Use selectedRanges (time ranges) instead of event_id on points
    const currentSelectedRanges = selectedRanges();
    const hasEventSelections = currentSelectedRanges && currentSelectedRanges.length > 0;
    
    if (config.maptype === "DEFAULT" && hasEventSelections && currentSelectedRanges.length > 0) {
      // Loop through each selected range and render it on top
      currentSelectedRanges.forEach((range, rangeIndex) => {
        const startTime = new Date(range.start_time).getTime();
        const endTime = new Date(range.end_time).getTime();
        
        // Filter data to only include points within this time range
        const rangeData = data.filter(point => {
          const timestamp = new Date(point.Datetime).getTime();
          return timestamp >= startTime && timestamp <= endTime;
        });
        
        if (rangeData.length > 0) {
          // Create continuous segments for this range
          const rangeSegments = createContinuousTimeSeriesSegments(rangeData, samplingFrequency, config);
          
          // Get color for this range based on selection order
          // Use default blue color when there are more than 8 selections (same as colorScale.ts)
          const rangeColor = currentSelectedRanges.length > 8 ? '#1f77b4' : getColorByIndex(rangeIndex);
          
          rangeSegments.forEach((segment) => {
            if (segment.length < 2) return;

            const selectionPath = svg.append("path")
              .datum(segment)
              .attr("fill", "none")
              .attr("stroke", rangeColor)
              .attr("stroke-width", 2) // Thicker line for selections
              .attr("d", lineGenerator)
              .style("z-index", "10"); // Ensure selections appear on top
          });
        }
      });
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
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

// Create continuous segments with gap detection for time series
function createContinuousTimeSeriesSegments(data: TrackPoint[], samplingFrequency: number, config: any): TrackPoint[][] {
  const segments: TrackPoint[][] = [];
  let currentSegment: TrackPoint[] = [];
  
  const expectedInterval = 1000 / samplingFrequency;
  const gapThreshold = config.gapThreshold || (expectedInterval * 3);
  
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
          debug('ContinuousTimeSeriesRenderer: Breaking segment at cut range boundary', {
            prevRangeIndex,
            currRangeIndex,
            prevTime: prevPoint.Datetime,
            currTime: point.Datetime
          });
        }
      }
      
      // Break segment on time gaps OR cut range boundaries
      if (timeDiff > gapThreshold || shouldBreak) {
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

