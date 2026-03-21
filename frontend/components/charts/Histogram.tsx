import { createEffect, onCleanup, createSignal, Show } from "solid-js";
import * as d3 from "d3";
import { myTickFormat, formatTime } from "../../utils/global";

import { setTooltip, tooltip } from "../../store/globalStore";
import { selectedRange, hasSelection, cutEvents, isCut } from "../../store/selectionStore";
import { filterByTwa, getCurrentFilterState } from "../../utils/commonFiltering";
import { processD3CalculationsWithWorker } from "../../utils/workerManager";
import { getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";

interface TooltipState {
  visible: boolean;
  content: string;
  x: number;
  y: number;
}

function drawCarpetScatter(carpetGroup: any, xScale: any, data: any[], seriesIndex: number, item: any, xTranslation: number, chart: any, setLocalTooltip: (state: TooltipState) => void, timezone: string | null = null) {
  if (!data || data.length === 0) return;
  
  // Mouse event handlers
  const getTooltipContent = (point: any): string => {
    if (!point) return "";

    // Check if Datetime exists and is valid
    let timeString = "N/A";
    if (point.Datetime) {
      try {
        const date = point.Datetime instanceof Date ? point.Datetime : new Date(point.Datetime);
        if (!isNaN(date.getTime())) {
          const formatted = formatTime(date, timezone);
          timeString = formatted || "N/A";
        }
      } catch (error: any) {
        // Ignore date parsing errors
      }
    }

    return `<table class='table-striped'>
      <tr><td>TIME</td><td>${timeString}</td></tr>
      <tr><td>${chart.series[0].xaxis.name.toUpperCase()}</td><td>${parseFloat(point.x || 0).toFixed(1)}</td></tr>
      </table>`; 
  };

  const mouseover = (event: MouseEvent, d: any) => {
    const tooltipContent = getTooltipContent(d);
    // Use local tooltip state to avoid conflicts with other components
    setLocalTooltip({
        visible: true,
        content: tooltipContent,
        x: event.clientX,
        y: event.clientY
    });
    // Also set global tooltip for MapContainer in splitter view
    setTooltip({
        visible: true,
        content: tooltipContent,
        x: event.clientX,
        y: event.clientY
    });
  };

  const mousemove = (event: MouseEvent, d: any) => {
    const tooltipContent = getTooltipContent(d);
    // Use local tooltip state to avoid conflicts with other components
    setLocalTooltip({
        visible: true,
        content: tooltipContent,
        x: event.clientX,
        y: event.clientY
    });
    // Also set global tooltip for MapContainer in splitter view
    setTooltip({
        visible: true,
        content: tooltipContent,
        x: event.clientX,
        y: event.clientY
    });
  };

  const mouseout = (event: MouseEvent, d: any) => {
    setLocalTooltip({ visible: false, content: "", x: 0, y: 0 });
    // Also clear global tooltip for MapContainer in splitter view
    setTooltip({ visible: false, content: "", x: 0, y: 0 });
  };

  const yOffset = seriesIndex * 15; // Vertical offset for multiple series (carpet only)
  
  // Get color for this series
  let seriesColor = chart.series[0].color;
  
  // Draw points as small vertical lines (carpet-style)
  carpetGroup.append('g')
    .attr("class", "chart-element")
    .selectAll("carpet-line")
    .data(data)
    .enter()
    .append("line")
    .attr("x1", d => xScale(d.x))
    .attr("x2", d => xScale(d.x))
    .attr("y1", yOffset)
    .attr("y2", yOffset + 8)
    .style("stroke", seriesColor)
    .style("opacity", 0.6)
    .style("stroke-width", 1)
    .style("cursor", "pointer")
    .attr("transform", "translate(" + xTranslation + ",0)")
    .on("mouseover", function(event, d) {
      // Highlight carpet line on hover
      d3.select(this)
        .style("stroke-width", 3)
        .style("opacity", 1.0);
      mouseover(event, d);
    })
    .on("mouseout", function(event, d) {
      // Restore original appearance
      d3.select(this)
        .style("stroke-width", 1)
        .style("opacity", 0.6);
      mouseout();
    })
    .on("mousemove", mousemove);
}

interface HistogramProps {
  chart?: any;
}

export default function Histogram(props: HistogramProps) {
  let containerRef: HTMLElement | null = document.getElementById('main-content')
  let chartRef: SVGSVGElement | null = null; // This will be unique per component instance

  // Generate unique ID for this chart instance
  const chartInstanceId = Math.random().toString(36).substr(2, 9);
  const chartChannelName = props.chart?.series?.[0]?.xaxis?.name || 'unknown';
  const uniqueChartId = `${chartChannelName}-${chartInstanceId}`;

  // Scale variables scoped to this component instance
  let minXValue = Number.MAX_VALUE
  let maxXValue = Number.MIN_VALUE
  let minYValue = Number.MAX_VALUE
  let maxYValue = Number.MIN_VALUE

  // Local tooltip state for this component
  const [localTooltip, setLocalTooltip] = createSignal<TooltipState>({
    visible: false,
    content: "",
    x: 0,
    y: 0
  });

  // Centralized filtering function for histogram data
  const applyFilters = (data: any[]): any[] => {
    if (!data || !Array.isArray(data)) return data;
    
    const filterState = getCurrentFilterState();
    return filterByTwa(data, filterState.selectedStates, filterState.selectedRaces, filterState.selectedLegs, filterState.selectedGrades);
  };
  
  // Debounce mechanism for range/cut events only
  const [debouncedSelectedRange, setDebouncedSelectedRange] = createSignal(selectedRange());
  const [debouncedCutEvents, setDebouncedCutEvents] = createSignal(cutEvents());
  const [debouncedHasSelection, setDebouncedHasSelection] = createSignal(hasSelection());
  const [debouncedIsCut, setDebouncedIsCut] = createSignal(isCut());
  let updateTimer = null;
  
  // State to prevent multiple simultaneous renders
  let isRendering = false;
  let effectQueue = [];
  let processingQueue = false;
  
  // Debounce updates with 250ms delay
  const debounceUpdate = () => {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    
    updateTimer = setTimeout(() => {
      setDebouncedSelectedRange(selectedRange());
      setDebouncedCutEvents(cutEvents());
      setDebouncedHasSelection(hasSelection());
      setDebouncedIsCut(isCut());
      updateTimer = null;
    }, 250);
  };
  
  // Process effect queue to ensure only one effect runs at a time
  const processEffectQueue = async () => {
    if (processingQueue || effectQueue.length === 0) return;
    
    processingQueue = true;
    // Processing effect queue
    
    while (effectQueue.length > 0) {
      const effectData = effectQueue.shift();
      // Processing effect from queue
      
      // Wait for any current render to complete before processing next effect
      while (isRendering) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      await processSingleEffect(effectData);
    }
    
    processingQueue = false;
  };

  // Process a single effect
  const processSingleEffect = async (effectData) => {
    const { chart, data, currentSelectedRange, currentCutEvents, currentHasSelection, currentIsCut } = effectData;
    
    // Start with data from parent (already filtered by TWA/race/leg/grade)
    let filteredData = data;

    // Apply range filtering if there's a selection
    if (currentHasSelection && currentSelectedRange.length > 0) {
      const rangeItem = currentSelectedRange[0];
      if (rangeItem.start_time && rangeItem.end_time) {
        const startTime = new Date(rangeItem.start_time);
        const endTime = new Date(rangeItem.end_time);
        
        filteredData = data.filter(d => {
          const datetime = new Date(d.Datetime);
          return datetime >= startTime && datetime <= endTime;
        });
      }
    }
    // Also filter by cut events if available
    else if (currentIsCut && currentCutEvents.length > 0) {
      const cutItem = currentCutEvents[0];
      if (cutItem.start_time && cutItem.end_time) {
        const startTime = new Date(cutItem.start_time);
        const endTime = new Date(cutItem.end_time);
        
        filteredData = data.filter(d => {
          const datetime = new Date(d.Datetime);
          return datetime >= startTime && datetime <= endTime;
        });
      }
    }

    // Process histogram data asynchronously
    try {
      const histogramData = await computeHistogram(filteredData);
      await renderChartAsync(chart, histogramData, filteredData);
    } catch (error: any) {
      
    }
  };

  // Async version of renderChart that returns a promise
  const renderChartAsync = (chart, histogramData, originalData) => {
    return new Promise((resolve) => {
      // Call the original renderChart with resolve callback
      renderChart(chart, histogramData, originalData, resolve);
    });
  };
  
  // Watch for range/cut selection changes and debounce them
  createEffect(() => {
    // Track only range/cut selection signals
    selectedRange();
    cutEvents();
    hasSelection();
    isCut();
    
    // Debounce the update
    debounceUpdate();
  });

  // Worker-based histogram calculation
  async function computeHistogram(data) {
    if (!data || data.length === 0) return [];
    
    // Use worker for large datasets (>1000 points)
    if (data.length > 1000) {
      try {
        const result = await processD3CalculationsWithWorker(data, {
          operation: 'HISTOGRAM',
          data: data,
          options: {
            binCount: Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))))
          }
        });
        
        return result.processedData;
      } catch (error: any) {
        
        // Fall back to synchronous calculation
      }
    }
    
    // Synchronous fallback for small datasets
    return computeHistogramSync(data);
  }

  // Synchronous histogram calculation (fallback)
  function computeHistogramSync(data) {
    // Square root binning rule: min=1, max=40
    let bincount = Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))))
    let xExtent = d3.extent(data.map((d) => d.x))
    let recCount = data.length

    let xMin = xExtent[0] || 0
    let xMax = xExtent[1] || 0
    let xInt = (xMax - xMin) / bincount

    let output = []
    for (let i = 0; i < bincount; i++) {
      let fMin = xMin + (xInt * i)
      let fMax = xMin + (xInt * (i + 1))
      let fX = (fMin + fMax) / 2

        let fData = data.filter(d => d.x > fMin && d.x < fMax);
      let fCount = fData.length

      // For histogram, just use the count - no probability calculations
      output.push({
        'X': fX, 
        'COUNT': fCount, 
        'PERCENT': fCount / recCount * 100
      })
    }

    return output
  }

  // Helper function to render the chart after async data processing
  const renderChart = (chart, histogramData, originalData, resolveCallback) => {
    // If already rendering, this shouldn't happen with the queue system
    if (isRendering) {
      
      if (resolveCallback) {
        resolveCallback(); // Resolve to prevent hanging
      }
      return;
    }
    
    isRendering = true;
    
    // Define chart dimensions and margins
    const xTranslation = 45;
    const xymargin = { top: 60, right: 30, bottom: 50, left: 60 };
    let xywidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right;
    let xyheight = 400 - xymargin.top - xymargin.bottom;

    if (props.class_name == 'col1') {
      xywidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right
      xyheight = (chartRef?.clientHeight ?? 0) - xymargin.top - xymargin.bottom;
    } else if (props.class_name == 'col2') {
      xywidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right
      xyheight = 600 - xymargin.top - xymargin.bottom;
    } else if (props.class_name == 'col3') {
      xywidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right
      xyheight = (chartRef?.clientHeight ?? 0) - xymargin.top - xymargin.bottom;
    }

    // Height for the carpet scatter plot (above main plot)
    const carpetHeight = 40;

    // Check if this is the first render or an update
    const existingSvg = d3.select(chartRef).select("svg");
    const isFirstRender = existingSvg.empty() || !existingSvg.node();
    
    // If this is a first render but there's already content, it means the component was recreated
    // In this case, we should treat it as an update to maintain smooth transitions
    const hasExistingContent = chartRef && chartRef.children.length > 0;
    const isCleaningUp = chartRef?.getAttribute('data-cleaning-up') === 'true';
    const shouldTreatAsUpdate = isFirstRender && (hasExistingContent || isCleaningUp);
    
    // Clean up any existing content from previous component
    if (isCleaningUp) {
      chartRef.removeAttribute('data-cleaning-up');
    }

    let svg, chartbody, carpetGroup;
    
    if (isFirstRender && !shouldTreatAsUpdate) {
      // First render - create SVG and chart group
      svg = d3
        .select(chartRef)
        .append("svg")
        .attr("width", xywidth + xymargin.left + xymargin.right)
        .attr("height", xyheight + xymargin.top + xymargin.bottom + carpetHeight);
      
      carpetGroup = svg
        .append("g")
        .attr("class", "carpet-group")
        .attr("transform", `translate(${xymargin.left}, ${xymargin.top - carpetHeight})`);
      
      chartbody = svg
        .append("g")
        .attr("class", "chart-body")
        .attr("transform", `translate(${xymargin.left}, ${xymargin.top})`);
      } else {
      // Update - use existing SVG and chart group, or create new one if component was recreated
      if (existingSvg.node()) {
        svg = existingSvg;
        chartbody = svg.select("g.chart-body");
        carpetGroup = svg.select("g.carpet-group");
      } else {
        // Component was recreated, create new SVG but treat as update for transitions
        svg = d3
          .select(chartRef)
          .append("svg")
          .attr("width", xywidth + xymargin.left + xymargin.right)
          .attr("height", xyheight + xymargin.top + xymargin.bottom + carpetHeight);
        
        carpetGroup = svg
          .append("g")
          .attr("class", "carpet-group")
          .attr("transform", `translate(${xymargin.left}, ${xymargin.top - carpetHeight})`);
        
        chartbody = svg
          .append("g")
          .attr("class", "chart-body")
          .attr("transform", `translate(${xymargin.left}, ${xymargin.top})`);
      }
    }

    // Calculate extents from the data for this specific render
    let currentMinX = Number.MAX_VALUE;
    let currentMaxX = Number.MIN_VALUE;
    let currentMinY = Number.MAX_VALUE;
    let currentMaxY = Number.MIN_VALUE;

    // Calculate Y-axis extents from histogram data
    if (histogramData && histogramData.length > 0) {
      const yValues = histogramData.map(d => d.COUNT).filter(val => !isNaN(val) && val !== null);
      
      if (yValues.length > 0) {
        currentMinY = Math.min(...yValues);
        currentMaxY = Math.max(...yValues);
      }
    }

    // Calculate X-axis extents from histogram data
    if (histogramData && histogramData.length > 0) {
      const xValues = histogramData.map(d => d.X).filter(val => !isNaN(val) && val !== null);
      
      if (xValues.length > 0) {
        currentMinX = Math.min(...xValues);
        currentMaxX = Math.max(...xValues);
      }
    }

    // Ensure we have valid min/max values
    if (currentMinX === Number.MAX_VALUE) currentMinX = 0;
    if (currentMaxX === Number.MIN_VALUE) currentMaxX = 100;
    if (currentMinY === Number.MAX_VALUE) currentMinY = 0;
    if (currentMaxY === Number.MIN_VALUE) currentMaxY = 100;

    // Chart scaling values
    var xInt = (currentMaxX - currentMinX) / 10
    var xMin = currentMinX - xInt
    var xMax = currentMaxX + xInt

    // Scales
    const yScale = d3.scaleLinear()
      .range([xyheight, 0])
      .domain([0, currentMaxY * 1.1])
    const xScale = d3.scaleLinear()
      .range([0, xywidth - xTranslation])
      .domain([xMin, xMax])

    // Handle transitions for updates
    if (!isFirstRender || shouldTreatAsUpdate) {
      // Remove existing chart elements but keep the SVG structure
      chartbody.selectAll(".chart-element").remove();
      carpetGroup.selectAll(".chart-element").remove();
    }

    // Add Y-axis
    chartbody.append("g")
      .attr("class", "axes chart-element")
      .attr("transform", `translate(${xTranslation},0)`)
      .call(d3.axisLeft(yScale).ticks(5).tickFormat(myTickFormat))
      .style("font-size", "12px");

    // Add X-axis
    chartbody.append("g")
      .attr("class", "axes chart-element")
      .attr("transform", `translate(${xTranslation},${xyheight})`)
      .call(d3.axisBottom(xScale).ticks(5).tickFormat(myTickFormat))
      .style("font-size", "12px");

    // Add axis labels
    chartbody.append("text")
      .attr("class", "y-label chart-element")
      .attr("transform", "rotate(-90)")
      .attr("y", 0 - xymargin.left)
      .attr("x", 0 - (xyheight / 2))
      .attr("dy", "1em")
      .style("text-anchor", "middle")
      .style("font-size", "12px")
      .text("Record Count");

    chartbody.append("text")
      .attr("class", "x-label chart-element")
      .attr("transform", `translate(${xywidth / 2}, ${xyheight + xymargin.bottom - 10})`)
      .style("text-anchor", "middle")
      .style("font-size", "12px")
      .text(chart.series[0].xaxis.name);

    // Draw histogram bars
    if (histogramData && histogramData.length > 0) {
      const barWidth = xScale(histogramData[1]?.X || 0) - xScale(histogramData[0]?.X || 0);
    
    // Mouse event handlers
    const mouseover = (event, d) => {
      const tooltipContent = `<table class='table-striped'>
        <tr><td>${chart.series[0].xaxis.name.toUpperCase()}</td><td>${parseFloat(d.X || 0).toFixed(1)}</td></tr>
        <tr><td>COUNT</td><td>${parseFloat(d.COUNT || 0).toFixed(0)}</td></tr>
        <tr><td>PERCENT</td><td>${parseFloat(d.PERCENT || 0).toFixed(1)}%</td></tr>
      </table>`;

      // Use local tooltip state to avoid conflicts with other components
      setLocalTooltip({
          visible: true,
          content: tooltipContent,
          x: event.clientX,
          y: event.clientY
      });
      // Also set global tooltip for MapContainer in splitter view
      setTooltip({
          visible: true,
          content: tooltipContent,
          x: event.clientX,
          y: event.clientY
      });
    };

    const mousemove = (event, d) => {
      const tooltipContent = `<table class='table-striped'>
        <tr><td>${chart.series[0].xaxis.name.toUpperCase()}</td><td>${parseFloat(d.X || 0).toFixed(1)}</td></tr>
        <tr><td>COUNT</td><td>${parseFloat(d.COUNT || 0).toFixed(0)}</td></tr>
        <tr><td>PERCENT</td><td>${parseFloat(d.PERCENT || 0).toFixed(1)}%</td></tr>
      </table>`;

      // Use local tooltip state to avoid conflicts with other components
      setLocalTooltip({
          visible: true,
          content: tooltipContent,
          x: event.clientX,
          y: event.clientY
      });
      // Also set global tooltip for MapContainer in splitter view
      setTooltip({
          visible: true,
          content: tooltipContent,
          x: event.clientX,
          y: event.clientY
      });
    };

    const mouseout = () => {
      setLocalTooltip({ visible: false, content: "", x: 0, y: 0 });
      // Also clear global tooltip for MapContainer in splitter view
      setTooltip({ visible: false, content: "", x: 0, y: 0 });
    };
    
      const barsGroup = chartbody.append('g')
        .attr("class", "bars chart-element");
      
      const bars = barsGroup.selectAll("rect")
        .data(histogramData, d => d.X); // Use X value as key for proper data binding
      
      // Remove old bars with transition
      bars.exit()
        .transition()
        .duration(300)
        .style("opacity", 0)
        .attr("height", 0)
        .attr("y", yScale(0))
        .remove();
      
      // Add new bars
      const barsEnter = bars.enter()
        .append("rect")
        .attr("x", d => xScale(d.X) - barWidth/2)
        .attr("y", yScale(0)) // Start from bottom
        .attr("width", barWidth)
        .attr("height", 0) // Start with zero height
        .style("fill", chart.series[0].color)
        .style("fill-opacity", 0.2)
        .style("stroke", chart.series[0].color)
        .style("stroke-width", 1)
        .style("cursor", "pointer")
        .attr("transform", "translate(" + xTranslation + ",0)")
        .on("mouseover", function(event, d) {
          d3.select(this).style("fill-opacity", 1);
          mouseover(event, d);
        })
        .on("mouseout", function(event, d) {
          d3.select(this).style("fill-opacity", 0.2);
          mouseout();
        })
        .on("mousemove", mousemove);
      
      // Update existing bars with transition
      bars.merge(barsEnter)
        .transition()
        .duration(500)
        .ease(d3.easeCubicInOut)
        .attr("x", d => xScale(d.X) - barWidth/2)
        .attr("y", d => yScale(d.COUNT))
        .attr("width", barWidth)
        .attr("height", d => yScale(0) - yScale(d.COUNT));
  }

    // Draw carpet scatter plot
    if (originalData && originalData.length > 0) {
      const timezone = getCurrentDatasetTimezone();
      drawCarpetScatter(carpetGroup, xScale, originalData, 0, chart.series[0], xTranslation, chart, setLocalTooltip, timezone);
    }

    // Mark rendering as complete
    isRendering = false;
    // Call resolve callback if provided
    if (resolveCallback) {
      resolveCallback();
    }
    
    // Continue processing queue after render completes
    processEffectQueue();
  };

  // Main chart rendering effect - responds to data changes from parent and range/cut events
  createEffect(() => {
    // Access the data update trigger to force reactivity
    const dataUpdateTrigger = props.dataUpdateTrigger || 0;
    const chart = props.chart;
    const series = chart.series[0];
    const currentData = series.data || [];
    
    // Histogram effect triggered - processing queue

    // Use debounced values for range/cut events only
    // Parent handles TWA/race/leg/grade filtering
    const currentSelectedRange = debouncedSelectedRange();
    const currentCutEvents = debouncedCutEvents();
    const currentHasSelection = debouncedHasSelection();
    const currentIsCut = debouncedIsCut();
    
    // Only add to queue if we have data and aren't already processing
    if (currentData.length > 0 && !processingQueue) {
      effectQueue.push({
        chart,
        data: currentData,
        currentSelectedRange,
        currentCutEvents,
        currentHasSelection,
        currentIsCut
      });
      
      // Added to effect queue
      
      // Process queue asynchronously
      processEffectQueue();
    }
  });

  onCleanup(() => {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    // Don't clear the chart content immediately to prevent flashing
    // The new component will handle the transition
    if (chartRef) {
      // Mark the chart as being cleaned up but don't remove content yet
      chartRef.setAttribute('data-cleaning-up', 'true');
    }
  });

  return (
    <div style={{'min-height': '400px'}}>
      <div ref={(el) => (chartRef = el)}></div>
      <Show when={props.chart?.missingChannels?.length > 0}>
        <div class="text-center text-sm text-gray-500 dark:text-gray-400 mt-1">
          Data channels could not be loaded for this chart.
        </div>
      </Show>
      
      {/* Local tooltip for when not in splitter view */}
      <Show when={localTooltip().visible}>
        <div
          id="histogram-tooltip"
          class="tooltip"
          style={{
            position: 'fixed',
            opacity: 1,
            left: `${localTooltip().x - 150}px`,
            top: `${localTooltip().y}px`,
            pointerEvents: 'none',
            zIndex: 99999
          }}
          innerHTML={localTooltip().content}
        />
      </Show>
    </div>
  );
}
