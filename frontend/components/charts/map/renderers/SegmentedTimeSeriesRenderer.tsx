import { TimeSeriesRendererProps, RendererResult } from "./types";
import { TrackPoint } from "../hooks/useTrackRendering";
import { selectedEvents, selectedRanges } from "../../../../store/selectionStore";
import { getColorByIndex } from "../../../../utils/colorScale";

export function renderSegmentedTimeSeries(props: TimeSeriesRendererProps): RendererResult {
  const { data, svg, xScale, yScale, lineGenerator, samplingFrequency, channel, getColor, getThickness } = props;
  
  // Helper function to get channel value from data point (case-insensitive)
  const getChannelValue = (d: any): number => {
    const val = d[channel] ?? d[channel.toLowerCase()] ?? d[channel.toUpperCase()];
    if (val === undefined || val === null || isNaN(Number(val))) {
      return 0; // Return 0 instead of NaN to prevent rendering errors
    }
    return Number(val);
  };
  
  try {
    // Get current selections
    const currentSelectedEvents = selectedEvents();
    const hasSelections = currentSelectedEvents && currentSelectedEvents.length > 0;
    
    // Draw segmented lines, ensuring gaps for discontinuities
    let currentSegment = [];
    const expectedInterval = 1000 / samplingFrequency;
    const gapThreshold = expectedInterval * 3;
    
    data.forEach((point, index) => {
      if (index === 0) {
        currentSegment.push(point);
      } else {
        const prevPoint = data[index - 1];
        const timeDiff = Math.abs(new Date(point.Datetime).getTime() - new Date(prevPoint.Datetime).getTime());
        
        // Create a new segment when EITHER grade changes OR event_id changes OR time gap is too large
        const segmentBreak = (point.Grade !== prevPoint.Grade) || 
                            (point.event_id !== prevPoint.event_id) ||
                            (timeDiff > gapThreshold);
        if (!segmentBreak) {
          currentSegment.push(point);
        } else {
          // Draw the completed segment
          if (currentSegment.length > 1) {
            const nextPoint = data[index];
            // Determine base track color
            const baseTrackColor = hasSelections ? "grey" : getColor(currentSegment[0], nextPoint);
            
            svg.append("path")
              .datum(currentSegment)
              .attr("fill", "none")
              .attr("stroke", baseTrackColor)
              .attr("stroke-width", getThickness("chart", currentSegment[0], nextPoint))
              .attr("d", lineGenerator);
          }
          currentSegment = [point]; // Start new segment
        }
      }
    });
    
    // Draw the last segment
    if (currentSegment.length > 1) {
      const lastIndex = data.length - 1;
      const nextPoint = data[lastIndex + 1]; // will be undefined
      // Determine base track color
      const baseTrackColor = hasSelections ? "grey" : getColor(currentSegment[0], nextPoint);
      
      svg.append("path")
        .datum(currentSegment)
        .attr("fill", "none")
        .attr("stroke", baseTrackColor)
        .attr("stroke-width", getThickness("chart", currentSegment[0], nextPoint))
        .attr("d", lineGenerator);
    }

    // Draw individual line segments for detailed rendering
    for (let i = 1; i < data.length; i++) {
      const prev = data[i - 1];
      const curr = data[i];
      
      // Check for time gap - use sampling frequency to determine gap threshold
      const expectedInterval = 1000 / samplingFrequency;
      const gapThreshold = expectedInterval * 3;
      const timeDiff = Math.abs(new Date(curr.Datetime).getTime() - new Date(prev.Datetime).getTime());
      
      // Only draw line if there's no significant time gap
      if (timeDiff <= gapThreshold) {
        // Determine base track color
        const baseTrackColor = hasSelections ? "grey" : getColor(curr, prev);
        
        svg.append("line")
          .attr("x1", xScale(new Date(prev.Datetime)))
              .attr("y1", yScale(getChannelValue(prev)))
              .attr("x2", xScale(new Date(curr.Datetime)))
              .attr("y2", yScale(getChannelValue(curr)))
          .attr("stroke", baseTrackColor)
          .attr("stroke-width", getThickness("chart", curr, prev))
          .attr("fill", "none");
      }
    }

    // Overlay selected ranges with thicker lines
    // Use selectedRanges (time ranges) instead of event_id on points
    const currentSelectedRanges = selectedRanges();
    const hasEventSelections = currentSelectedRanges && currentSelectedRanges.length > 0;
    
    if (hasEventSelections && currentSelectedRanges.length > 0) {
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
          // Get color for this range based on selection order
          // Use default blue color when there are more than 8 selections (same as colorScale.ts)
          const rangeColor = currentSelectedRanges.length > 8 ? '#1f77b4' : getColorByIndex(rangeIndex);

          // Draw segmented lines for this range
          let currentSegment = [];
          
          rangeData.forEach((point, index) => {
            if (index === 0) {
              currentSegment.push(point);
            } else {
              const prevPoint = rangeData[index - 1];
              const timeDiff = Math.abs(new Date(point.Datetime).getTime() - new Date(prevPoint.Datetime).getTime());
              
              // Create a new segment when grade changes or time gap is too large
              const segmentBreak = (point.Grade !== prevPoint.Grade) || (timeDiff > gapThreshold);
              if (!segmentBreak) {
                currentSegment.push(point);
              } else {
                // Draw the completed segment
                if (currentSegment.length > 1) {
                  const nextPoint = rangeData[index];
                  svg.append("path")
                    .datum(currentSegment)
                    .attr("fill", "none")
                    .attr("stroke", rangeColor)
                    .attr("stroke-width", 2) // Thicker line for selections
                    .attr("d", lineGenerator)
                    .style("z-index", "10"); // Ensure selections appear on top
                }
                currentSegment = [point]; // Start new segment
              }
            }
          });
          
          // Draw the last segment
          if (currentSegment.length > 1) {
            const lastIndex = rangeData.length - 1;
            const nextPoint = rangeData[lastIndex + 1]; // will be undefined
            svg.append("path")
              .datum(currentSegment)
              .attr("fill", "none")
              .attr("stroke", rangeColor)
              .attr("stroke-width", 2) // Thicker line for selections
              .attr("d", lineGenerator)
              .style("z-index", "10"); // Ensure selections appear on top
          }

          // Draw individual line segments for detailed rendering
          for (let i = 1; i < rangeData.length; i++) {
            const prev = rangeData[i - 1];
            const curr = rangeData[i];
            
            const timeDiff = Math.abs(new Date(curr.Datetime).getTime() - new Date(prev.Datetime).getTime());
            
            // Only draw line if there's no significant time gap
            if (timeDiff <= gapThreshold) {
              svg.append("line")
                .attr("x1", xScale(new Date(prev.Datetime)))
                .attr("y1", yScale(getChannelValue(prev)))
                .attr("x2", xScale(new Date(curr.Datetime)))
                .attr("y2", yScale(getChannelValue(curr)))
                .attr("stroke", rangeColor)
                .attr("stroke-width", 2) // Thicker line for selections
                .attr("fill", "none")
                .style("z-index", "10"); // Ensure selections appear on top
            }
          }
        }
      });
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

