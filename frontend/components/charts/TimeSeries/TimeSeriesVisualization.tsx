import { createSignal, createEffect, onMount, onCleanup, untrack } from "solid-js";
import { createStore } from "solid-js/store";

import * as d3 from "d3";
import { warn, error as logError, debug } from "../../../utils/console";

import { 
  selectedEvents, 
  hasSelection, 
  cutEvents,
  selectedRange,
  setSelectedRange,
  setHasSelection,
  setIsCut
} from "../../../store/selectionStore";
import { selectedStatesTimeseries, selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries } from "../../../store/filterStore";
import { 
  selectedTime, 
  setSelectedTime, 
  isPlaying, 
  playbackSpeed,
  requestTimeControl
} from "../../../store/playbackStore";
import { applyDataFilter } from "../../../utils/dataFiltering";
import { processD3CalculationsWithWorker } from "../../../utils/workerManager";
import { formatTime } from "../../../utils/global";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

interface TimeSeriesVisualizationProps {
  chart?: any;
  [key: string]: any;
}

interface XRange {
  min: number;
  max: number;
}

export default function TimeSeriesVisualization(props: TimeSeriesVisualizationProps) {
  let chartContainer: HTMLElement | null = null;
  
  const [xRange, setRange] = createStore<XRange>({ min: 0, max: 100 });

  // Use defaultChannelsStore for channel names
  const { twsName, bspName, vmgPercName } = defaultChannelsStore;

  // Use centralized filtering function; TimeSeries always shares selection (forceSelection)
  const applyFilters = (data: any[]): any[] => {
    const filtered = applyDataFilter(data, undefined, undefined, undefined, undefined, undefined, { forceSelection: true });
    return filtered;
  };

  // Helper function to get timestamp from data point with robust handling
  const getTimestamp = (d: any): Date => {
    if (!d) return new Date(0);
    
    // Handle different timestamp field names and formats
    const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
    
    if (!timestamp) return new Date(0);
    
    // If it's already a Date object, return it
    if (timestamp instanceof Date) return timestamp;
    
    // If it's a number (Unix timestamp), convert to Date
    if (typeof timestamp === 'number') return new Date(timestamp);
    
    // If it's a string, try to parse it
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      // Check if parsing was successful
      if (!isNaN(parsed.getTime())) return parsed;
    }
    
    // Fallback to epoch if all else fails
    warn('Invalid timestamp format:', timestamp, 'in data point:', d);
    return new Date(0);
  };

  const S20colorScale = d3.scaleOrdinal(d3.schemeCategory10)
  let myLinearColor = d3.scaleLinear();
  let myLinearThickness = d3.scaleLinear();
  let myOrdinalColor = d3.scaleOrdinal();

  // Helper function to compute 1-sigma range (mean ± 1 std) for map coloring
  const getOneSigmaRange = (data: any[], accessor: (p: any) => number): [number, number] => {
    const values = data.map(accessor).filter(v => !isNaN(v) && isFinite(v));
    if (values.length === 0) return [0, 1];
    
    const mean = d3.mean(values) || 0;
    const std = d3.deviation(values) || 0;
    const min = mean - std;
    const max = mean + std;
    
    return [min, max];
  };

  const initScales = (data) => {
    // Check if there are any selected events
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      myOrdinalColor = d3.scaleOrdinal();

      // Get unique event_ids from the selected events
      const eventIds = selectedEvents ? selectedEvents() : [];
      const uniqueEventIds = Array.from(new Set(eventIds)).sort((a, b) => a - b);
      
      let unique_colors = [];
      uniqueEventIds.forEach((eventId, i) => {
        unique_colors.push(S20colorScale(i));
      });

      myOrdinalColor.domain(uniqueEventIds);
      myOrdinalColor.range(unique_colors);
    } else {
      if (props.chartType === "SPEED") {
        myOrdinalColor.domain([0, 1, 2, 3, 4]);
        myOrdinalColor.range(["lightgrey", "red", "lightgreen", "green", "yellow"]);
      } else if (props.chartType === "WIND") {
        const [minTWS, maxTWS] = getOneSigmaRange(data, (p) => +p.Tws);
        const [minTWD, maxTWD] = getOneSigmaRange(data, (p) => +p.Twd);

        myLinearColor.domain([minTWD, (minTWD + maxTWD) / 2, maxTWD]);
        myLinearColor.range(["red", "lightgrey", "green"]);

        myLinearThickness.domain([minTWS, maxTWS]);
        myLinearThickness.range(["0.1", "3"]);
      } else if (props.chartType === "VMG") {
        const [minBSP, maxBSP] = getOneSigmaRange(data, (p) => +p.Bsp);

        myLinearColor.domain([0, 80, 100, 120]);
        myLinearColor.range(["blue", "lightblue", "yellow", "red"]);

        myLinearThickness.domain([minBSP, maxBSP]);
        myLinearThickness.range(["0.1", "3"]);
      }
    }
  };

  // Updated getColor and getThickness to accept prev and d
  const getColor = (d, prev) => {
    // Use sampling frequency to determine gap threshold (3x the expected interval)
    const expectedInterval = 1000 / props.samplingFrequency;
    const gapThreshold = expectedInterval * 3;
    
    if (prev && d && (getTimestamp(d) instanceof Date) && (getTimestamp(prev) instanceof Date) && (Math.abs(getTimestamp(d).getTime() - getTimestamp(prev).getTime()) > gapThreshold)) {
      return "transparent";
    }
    
    // Check if there are any selected events
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections && d.event_id > 0) {
      // This is a selected data point
      return myOrdinalColor(d.event_id);
    } else if (hasSelections && d.event_id === 0) {
      // This is an unselected data point when there are selections
      return "grey";
    } else {
      // No selections, use normal chart coloring based on chartType
      if (props.chartType === "SPEED") {
        return myOrdinalColor(d.Grade) || "lightgrey";
      } else if (props.chartType === "WIND") {
        return myLinearColor(d.Twd) || "lightgrey";
      } else if (props.chartType === "VMG") {
        return myLinearColor(d.Vmg_perc) || "lightgrey";
      } else {
        return "grey";
      }
    }
  };

  const getThickness = (d, prev) => {
    // Use sampling frequency to determine gap threshold (3x the expected interval)
    const expectedInterval = 1000 / props.samplingFrequency;
    const gapThreshold = expectedInterval * 3;
    
    if (prev && d && (getTimestamp(d) instanceof Date) && (getTimestamp(prev) instanceof Date) && (Math.abs(getTimestamp(d).getTime() - getTimestamp(prev).getTime()) > gapThreshold)) {
      return 0;
    }
    
    // Check if there are any selected events
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections && d.event_id > 0) {
      return 3;
    } else if (hasSelections && d.event_id === 0) {
      return 1;
    } else {
      if (props.chartType === "SPEED") {
        return 2;
      } else if (props.chartType === "WIND") {
        return myLinearThickness(d.Tws) || 2;
      } else if (props.chartType === "VMG") {
        return myLinearThickness(d.Bsp) || 2;
      } else {
        return 1;
      }
    }
  };

  const drawChart = async (data) => {
    if (!data || data.length === 0) return;

    // Use dynamic channel names from store
    const channel = props.chartType === "WIND" 
      ? twsName() 
      : props.chartType === "VMG" 
        ? vmgPercName() 
        : bspName();

    // Remove existing chart before redrawing
    d3.select("#timeseries-chart").select("svg").remove();
    
    // Add visual feedback for cut data
    const isCutData = cutEvents().length > 0 && !hasSelection();

    const width = chartContainer.clientWidth || 600;
    const height = 400;
    const margin = { top: 20, right: 20, bottom: 40, left: 40 };

    const svg = d3
      .select("#timeseries-chart")
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .on("contextmenu", (event) => event.preventDefault()) // Disable right-click context menu
      .append("g")
      .attr("transform", `translate(${margin.left}, ${margin.top})`);

    // Use centralized filtering
    const filteredData = applyFilters(data);
    
    if (!filteredData || filteredData.length === 0) return;

    // Use worker for scale calculations on large datasets
    let xExtent, xScale, yScale;
    
    if (filteredData.length > 1000) {
      try {
        const scaleResult = await processD3CalculationsWithWorker(filteredData, {
          operation: 'SCALE_CALCULATIONS',
          data: filteredData,
          options: {
            scaleType: 'time',
            channel: channel
          }
        });
        
        xExtent = scaleResult.scales.extent;
        xScale = d3.scaleTime().domain(xExtent).range([0, width - margin.left - margin.right]);
        
        // Calculate y-scale extent
        const yValues = filteredData.map(d => d[channel]).filter(val => !isNaN(val) && val !== null);
        const yMin = Math.min(...yValues);
        const yMax = Math.max(...yValues);
        
        yScale = d3.scaleLinear()
          .domain([yMin, yMax * 1.15])
          .range([height - margin.top - margin.bottom, 0]);
      } catch (error: any) {
        logError('Worker-based scale calculation failed, using fallback:', error);
        // Fall back to synchronous calculation
        xExtent = d3.extent(filteredData, (d) => getTimestamp(d));
        xScale = d3.scaleTime().domain(xExtent).range([0, width - margin.left - margin.right]);
        
        yScale = d3.scaleLinear()
          .domain([d3.min(filteredData, (d) => d[channel]), d3.max(filteredData, (d) => d[channel]) * 1.15])
          .range([height - margin.top - margin.bottom, 0]);
      }
    } else {
      // Synchronous calculation for small datasets
      xExtent = d3.extent(filteredData, (d) => getTimestamp(d));
      xScale = d3.scaleTime().domain(xExtent).range([0, width - margin.left - margin.right]);
      
      yScale = d3.scaleLinear()
        .domain([d3.min(filteredData, (d) => d[channel]), d3.max(filteredData, (d) => d[channel]) * 1.15])
        .range([height - margin.top - margin.bottom, 0]);
    }

    setRange({ min: xExtent[0], max: xExtent[1] });

    // Define lineGenerator before any usage
    const lineGenerator = d3
      .line()
      .x((d) => xScale(getTimestamp(d)))
      .y((d) => yScale(d[channel]));

    // Draw segmented lines, ensuring gaps for discontinuities
    let currentSegment = [];
    filteredData.forEach((point, index) => {
      if (index === 0) {
        currentSegment.push(point);
      } else {
        const prevPoint = filteredData[index - 1];
        // Create a new segment when EITHER grade changes OR event_id changes
        const segmentBreak = (point.Grade !== prevPoint.Grade) || 
                            (point.event_id !== prevPoint.event_id);
        if (!segmentBreak) {
          currentSegment.push(point);
        } else {
          // Draw the completed segment
          if (currentSegment.length > 1) {
            const nextPoint = filteredData[index];
            svg.append("path")
              .datum(currentSegment)
              .attr("fill", "none")
              .attr("stroke", getColor(currentSegment[0], nextPoint))
              .attr("stroke-width", getThickness(currentSegment[0], nextPoint))
              .attr("d", lineGenerator);
          }
          currentSegment = [point]; // Start new segment
        }
      }
    });
    // Draw the last segment
    if (currentSegment.length > 1) {
      const lastIndex = filteredData.length - 1;
      const nextPoint = filteredData[lastIndex + 1]; // will be undefined
      svg.append("path")
        .datum(currentSegment)
        .attr("fill", "none")
        .attr("stroke", getColor(currentSegment[0], nextPoint))
        .attr("stroke-width", getThickness(currentSegment[0], nextPoint))
        .attr("d", lineGenerator);
    }

    // Draw lines with time gap logic
    for (let i = 1; i < filteredData.length; i++) {
      const prev = filteredData[i - 1];
      const curr = filteredData[i];
      svg.append("line")
        .attr("x1", xScale(getTimestamp(prev)))
        .attr("y1", yScale(prev[channel]))
        .attr("x2", xScale(getTimestamp(curr)))
        .attr("y2", yScale(curr[channel]))
        .attr("stroke", getColor(curr, prev))
        .attr("stroke-width", getThickness(curr, prev))
        .attr("fill", "none");
    }

    // Add X and Y axes
    svg.append("g")
      .attr("class", "axes")
      .attr("transform", `translate(0,${height - margin.top - margin.bottom})`)
      .call(d3.axisBottom(xScale));

    svg.append("g")
      .attr("class", "axes")
      .call(d3.axisLeft(yScale).ticks(5));

    // Add Axis Labels
    svg.append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "middle")
      .attr("transform", `translate(${(width - margin.left - margin.right) / 2},${height - margin.top + 20})`)
      .attr("font-size", "14px")
      .text("Time");

    svg.append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "middle")
      .attr("transform", "rotate(-90)")
      .attr("y", -margin.left + 10)
      .attr("x", -(height - margin.top - margin.bottom) / 2)
      .attr("font-size", "14px")
      .text(channel);
    
    // Add cut data indicator
    if (isCutData) {
      svg.append("text")
        .attr("class", "cut-data-indicator")
        .attr("text-anchor", "right")
        .attr("transform", `translate(${width - margin.left - margin.right - 10},20)`)
        .attr("font-size", "12px")
        .attr("fill", "#ff6b6b")
        .text("CUT DATA");
    }

    // Add vertical line for selectedTime
    const verticalLine = svg.append("line")
      .attr("class", "mouse-line")
      .attr("stroke", "black")
      .attr("stroke-width", 1)
      .attr("y1", 0)
      .attr("y2", height - margin.top - margin.bottom)
      .style("pointer-events", "none") // Ensure the vertical line does not block brush events
      .style("opacity", 1);

    // Initialize vertical line position
    const selectedTimeValue = selectedTime();
    if (selectedTimeValue) {
      const xPos = xScale(selectedTimeValue);
      verticalLine
        .attr("x1", xPos)
        .attr("x2", xPos)
        .style("opacity", 1);
    }

    // Add brushing functionality
    const brush = d3
      .brushX()
      .extent([
        [0, 0],
        [width - margin.left - margin.right, height - margin.top - margin.bottom],
      ])
      .on("start brush end", brushed);

    // Create the brush group
    const brushGroup = svg.append("g")
      .attr("class", "brush")
      .call(brush)
      .on("contextmenu", (event) => event.preventDefault()); // Disable right-click context menu

    // Function to clear the brush selection
    const clearBrush = () => {
      brushGroup.call(brush.move, null);
    };

    // Store the clearBrush function globally so it can be called from cutSelection
    window.clearTimeSeriesBrush = clearBrush;

    // Restore brush selection if there's an active selectedRange
    const currentSelectedRange = selectedRange();
    if (currentSelectedRange && currentSelectedRange.length > 0) {
      const rangeItem = currentSelectedRange[0];
      const startTime = new Date(rangeItem.start_time);
      const endTime = new Date(rangeItem.end_time);
      
      // Convert time range to brush coordinates
      const x0 = xScale(startTime);
      const x1 = xScale(endTime);
      
      // Restore the brush selection
      brushGroup.call(brush.move, [x0, x1]);
    }

    // Add click handler to the brush background (overlay)
    brushGroup.select(".overlay")
      .on("click", (event) => {
        const [mouseX] = d3.pointer(event);
        const time = xScale.invert(mouseX);

        // Request control for time series visualization
        if (requestTimeControl('timeseries')) {
          setSelectedTime(new Date(time), 'timeseries');
        }
      });

    function brushed(event) {
      if (!event.selection) {
        setSelectedRange([]);
        setHasSelection(false);
        return;
      }

      const [x0, x1] = event.selection.map(xScale.invert);

      // Calculate the minimum meaningful selection
      const minSelectionMs = 1000;
      const selectionDuration = Math.abs(x1 - x0);

      if (selectionDuration > minSelectionMs) {
        const range = {"type": "range", "start_time": new Date(x0).toISOString(), "end_time": new Date(x1).toISOString()};

        // Request control for time series visualization
        if (requestTimeControl('timeseries')) {
          setSelectedTime(new Date(x0), 'timeseries');
        }
        setPrevSelectedTime(new Date(x0));
        setSelectedRange([range]);
        setHasSelection(true);
        setIsCut(false);
      } else {
        // Request control for time series visualization
        if (requestTimeControl('timeseries')) {
          setSelectedTime(new Date(x0), 'timeseries');
        }
        setPrevSelectedTime(new Date(x0));
        setSelectedRange([]);
        setHasSelection(false);

        if (cutEvents().length > 0) {
          setIsCut(true);
        }
      }
    }

    // Store references needed for global effects
    window.timeseriesTimeScale = xScale;
    window.timeseriesVerticalLine = verticalLine;
    window.timeseriesLastWidth = width - margin.left - margin.right;
  };

  // Watch for changes in values() and redraw the chart
  createEffect(() => {
    const currentValues = props.values;
    if (currentValues.length === 0) return;
    
    drawChart(currentValues);
  });

  // Watch for changes in selectedTime and update the vertical line
  createEffect(() => {
    const selectedTimeValue = selectedTime();
    if (!selectedTimeValue || props.values.length === 0) return;

    // Update the vertical line with the same transition logic
    if (window.timeseriesTimeScale && window.timeseriesVerticalLine) {
      const xScale = window.timeseriesTimeScale;
      const verticalLine = window.timeseriesVerticalLine;
      const xPos = xScale(selectedTimeValue);
      
      // This effect is redundant - the main vertical line animation is handled in the other effect
      // Remove this to prevent conflicts
    }
  });

  // Add a signal to track the previous time for detecting large jumps
  const [prevSelectedTime, setPrevSelectedTime] = createSignal(null);

  // Modified vertical line animation effect to handle data changes properly
  createEffect(() => {
    const selectedTimeValue = selectedTime();
    const currentlyPlaying = isPlaying();
    const currentValues = props.values;
    
    if (!selectedTimeValue || currentValues.length === 0) return;

    // Check if the data has changed (different length or different content)
    const prev = untrack(() => prevSelectedTime());
    
    // Reset prevSelectedTime if we detect a data change or if it's not set
    let shouldResetPrevTime = false;
    if (!prev) {
      shouldResetPrevTime = true;
    } else {
      // Check if the selected time is outside the current data range
      const dataTimeRange = [
        Math.min(...currentValues.map(d => getTimestamp(d).getTime())),

        Math.max(...currentValues.map(d => getTimestamp(d).getTime()))
      ];
      
      if (selectedTimeValue.getTime() < dataTimeRange[0] || selectedTimeValue.getTime() > dataTimeRange[1]) {
        shouldResetPrevTime = true;
      }
    }
    
    if (shouldResetPrevTime) {
      // Reset to current time to avoid bad interpolation
      untrack(() => setPrevSelectedTime(selectedTimeValue));
    }

    const timeDifference = prev && !shouldResetPrevTime ? Math.abs(selectedTimeValue - prev) : 0;
    const isLargeJump = timeDifference > 2000;
    
    // Update the previous time for next comparison
    if (!shouldResetPrevTime) {
      untrack(() => setPrevSelectedTime(selectedTimeValue));
    }

    // Handle the vertical line in the chart
    if (window.timeseriesTimeScale && window.timeseriesVerticalLine) {
      const xScale = window.timeseriesTimeScale;
      const verticalLine = window.timeseriesVerticalLine;
      const xPos = xScale(selectedTimeValue);
      
      // Always interrupt any ongoing transitions
      verticalLine.interrupt();
      
      // Use transition only when playing smoothly and no data changes
      if (currentlyPlaying && (!playbackSpeed || playbackSpeed() <= 1) && !isLargeJump && !shouldResetPrevTime) {
        verticalLine
          .transition()
          .duration(1000)
          .ease(d3.easeLinear)
          .attr("x1", xPos)
          .attr("x2", xPos);
      } else {
        verticalLine
          .attr("x1", xPos)
          .attr("x2", xPos);
      }
    }
  });

  // Unified effect to handle all filter and selection changes with debouncing
  let lastFilterSignature = '';
  let filterDebounceTimer = null;
  let filterEffectCount = 0;
  
  createEffect(() => {
    filterEffectCount++;
    
    // Detect infinite loops
    if (filterEffectCount > 50) {
      logError('🚨 INFINITE LOOP DETECTED in TimeSeriesVisualization filter effect!', filterEffectCount);
      return;
    }
    
    // Track all filter and selection signals
    const filterState = {
      states: selectedStatesTimeseries(),
      races: selectedRacesTimeseries(),
      legs: selectedLegsTimeseries(),
      grades: selectedGradesTimeseries(),
      ranges: selectedRange(),
      cuts: cutEvents(),
      hasSelection: hasSelection()
    };
    
    const currentValues = props.values;
    
    // Create signature to detect actual changes
    const signature = `${filterState.states.length}-${filterState.races.length}-${filterState.legs.length}-${filterState.grades.length}-${filterState.ranges.length}-${filterState.cuts.length}-${filterState.hasSelection}`;
    
    // Only proceed if the filter state actually changed and we have data
    if (signature === lastFilterSignature || currentValues.length === 0 || !chartContainer) {
      return;
    }
    
    lastFilterSignature = signature;
    
    // Debounce filter updates to prevent rapid successive calls
    if (filterDebounceTimer) {
      clearTimeout(filterDebounceTimer);
    }
    
    filterDebounceTimer = setTimeout(() => {
      debug('🔍 TimeSeriesVisualization: Filter state changed, redrawing chart...', {
        states: filterState.states.length,
        races: filterState.races.length,
        legs: filterState.legs.length,
        grades: filterState.grades.length,
        effectCount: filterEffectCount
      });
      
      // Use untrack to prevent infinite loops
      untrack(() => {
        drawChart(currentValues);
      });
      
      filterDebounceTimer = null;
      // Reset count after successful redraw
      filterEffectCount = 0;
    }, 200); // Standardized 200ms debounce
  });

  onMount(() => {
    // Initialize chart if data is available
    if (props.values && props.values.length > 0) {
      drawChart(props.values);
    }
  });

  onCleanup(() => {
    // Clean up any D3 selections
    if (chartContainer) {
      d3.select(chartContainer).selectAll("*").remove();
    }
    
    // Clean up global references
    if (window.clearTimeSeriesBrush) {
      delete window.clearTimeSeriesBrush;
    }
    if (window.timeseriesTimeScale) {
      delete window.timeseriesTimeScale;
    }
    if (window.timeseriesVerticalLine) {
      delete window.timeseriesVerticalLine;
    }
    if (window.timeseriesLastWidth) {
      delete window.timeseriesLastWidth;
    }
  });

  return (
    <div 
      id="timeseries-chart" 
      class="timeseries-chart" 
      ref={(el) => (chartContainer = el)}
      onContextMenu={(e) => e.preventDefault()}
    ></div>
  );
}
