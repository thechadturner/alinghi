import { createEffect, onCleanup, createSignal, Show } from "solid-js";
import * as d3 from "d3";
import { myTickFormat, formatTime } from "../../utils/global";

import { setTooltip, tooltip } from "../../store/globalStore";
import { selectedRange, hasSelection, cutEvents, isCut } from "../../store/selectionStore";
import { filterByTwa, getCurrentFilterState } from "../../utils/commonFiltering";
import { processD3CalculationsWithWorker } from "../../utils/workerManager";
import { debug, info, warn, error as logError } from "../../utils/console";
import { getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";

interface ProbabilityProps {
  chart?: any;
}

interface TooltipState {
  visible: boolean;
  content: string;
  x: number;
  y: number;
}

export default function Probability(props: ProbabilityProps) {
  let containerRef: HTMLElement | null = document.getElementById('main-content')
  let chartRef: SVGSVGElement | null = null; // This will be unique per component instance

  // Generate unique ID for this chart instance
  const chartInstanceId = Math.random().toString(36).substr(2, 9);
  const chartChannelName = props.chart?.series?.[0]?.xaxis?.name || 'unknown';
  const uniqueChartId = `${chartChannelName}-${chartInstanceId}`; // Unique ID combining channel and instance

  // Scale variables scoped to this component instance
  let minXValue = Number.MAX_VALUE
  let maxXValue = Number.MIN_VALUE

  let minYValue = Number.MAX_VALUE
  let maxYValue = Number.MIN_VALUE

  // Centralized filtering function for probability chart data
  const applyFilters = (data: any[]): any[] => {
    if (!data || !Array.isArray(data)) return data;
    
    // For probability charts, we need to filter the underlying data points
    // This assumes the data structure has the same format as map data
    const filterState = getCurrentFilterState();
    return filterByTwa(data, filterState.selectedStates, filterState.selectedRaces, filterState.selectedLegs, filterState.selectedGrades);
  };
  
  // Local tooltip state for this component
  const [localTooltip, setLocalTooltip] = createSignal<TooltipState>({
    visible: false,
    content: "",
    x: 0,
    y: 0
  });
  
  // Debounce mechanism
  const [debouncedSelectedRange, setDebouncedSelectedRange] = createSignal(selectedRange());
  const [debouncedCutEvents, setDebouncedCutEvents] = createSignal(cutEvents());
  const [debouncedHasSelection, setDebouncedHasSelection] = createSignal(hasSelection());
  const [debouncedIsCut, setDebouncedIsCut] = createSignal(isCut());
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  
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
  
  // Watch for selection changes and debounce them
  createEffect(() => {
    // Track all selection-related signals
    selectedRange();
    cutEvents();
    hasSelection();
    isCut();
    
    // Debounce the update
    debounceUpdate();
  });

  // Helper functions for probability calculations
  function prepareProbability(collection: any[], type: string) {
    let probability_data = []
    const twaChannelName = defaultChannelsStore.twaName();
    if (collection != undefined) {
        collection.forEach(function(d) {
          // Get TWA value from default channel name, fallback to 'Twa' for backward compatibility
          const twaValue = d[twaChannelName] ?? d.Twa;
          
          let cont = false
          if (type === 'PORT') {
            if (twaValue < 0) {
              cont = true
            }
          } else if (type === 'STBD') {
            if (twaValue > 0) {
              cont = true
            }
          } else if (type === 'UW') {
            // Upwind: 30-75 (exclusive boundaries: > 30 and < 75)
            if (Math.abs(twaValue) > 30 && Math.abs(twaValue) < 75) {
              cont = true
            }
          } else if (type === 'DW') {
            // Downwind: 105-150 (exclusive boundaries: > 105 and < 150)
            if (Math.abs(twaValue) > 105 && Math.abs(twaValue) < 150) {
              cont = true
            }
          } else if (type === 'RCH') {
            // Reaching: 75-115 (exclusive boundaries: > 75 and < 115)
            if (Math.abs(twaValue) > 75 && Math.abs(twaValue) < 115) {
              cont = true
            }
          } else {
            cont = true
          }

          // Accept x, Datetime, twa format (check both default channel name and Twa for backward compatibility)
          if (cont && d.x !== undefined && d.Datetime !== undefined && (d[twaChannelName] !== undefined || d.Twa !== undefined)) {
            probability_data.push(d)
          }
        })
    }
    return probability_data
  }

  // Calculate min/max values from all data
  function calculateDataExtents(data) {
    if (!data || data.length === 0) return { minX: 0, maxX: 100, minY: 0, maxY: 100 };
    
    const twaChannelName = defaultChannelsStore.twaName();
    const xValues = data.map(d => d.x).filter(val => !isNaN(val) && val !== null);
    const twaValues = data.map(d => d[twaChannelName] ?? d.Twa).filter(val => !isNaN(val) && val !== null);
    
    return {
      minX: xValues.length > 0 ? Math.min(...xValues) : 0,
      maxX: xValues.length > 0 ? Math.max(...xValues) : 100,
      minY: 0, // Y-axis will be calculated from probability data later
      maxY: 100 // Y-axis will be calculated from probability data later
    };
  }

  // Worker-based probability calculation
  async function computeProbability(data, chartType = 'standard_probability', cumulative = false, totalCount = null) {
    if (!data || data.length === 0) return [];
    
    // Use worker for large datasets (>1000 points) or complex calculations
    if (data.length > 1000 || chartType === 'categorical_probability') {
      try {
        const result = await processD3CalculationsWithWorker(data, {
          operation: 'PROBABILITY',
          data: data,
          options: {
            binCount: Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length)))),
            chartType: chartType,
            cumulative: cumulative,
            totalCount: totalCount || data.length
          }
        });
        
        
        
        // Add statistics to the first data point
        if (result.processedData.length > 0) {
          const firstPoint = result.processedData[0];
          firstPoint['MEAN'] = result.statistics.mean;
          firstPoint['STDDEV'] = result.statistics.stdDev;
          firstPoint['COUNT'] = data.length;
          firstPoint['MEDIAN'] = result.statistics.median;
          firstPoint['MIN'] = result.statistics.min;
          firstPoint['MAX'] = result.statistics.max;
          firstPoint['RANGE'] = result.statistics.range;
          if (result.statistics.skewness !== undefined) {
            firstPoint['SKEWNESS'] = result.statistics.skewness;
          }
        }
        
        return result.processedData;
      } catch (error: any) {
        
        // Fall back to synchronous calculation
        return computeProbabilitySync(data, chartType, cumulative, totalCount);
      }
    }
    
    // Synchronous fallback for small datasets
    return computeProbabilitySync(data, chartType, cumulative, totalCount);
  }

  // Synchronous probability calculation (fallback)
  function computeProbabilitySync(data, chartType = 'standard_probability', cumulative = false, totalCount = null) {
    // Square root binning rule: min=1, max=40
    let bincount = Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))))
    let xExtent = d3.extent(data.map((d) => d.x))
      let recCount = Object.keys(data).length
    
    // For standard probability, use total count if provided, otherwise use current data count
    let denominatorCount = totalCount !== null ? totalCount : recCount

    const mean = d3.mean(data, d => d.x);
    const stdDev = d3.deviation(data, d => d.x);

    let xMin = xExtent[0]
    let xMax = xExtent[1]
    let xInt = (xMax - xMin) / bincount

    let output = []
    let cumProb = 0
    for (let i = 0; i < bincount; i++) {
      let fMin = xMin + (xInt * i)
      let fMax = xMin + (xInt * (i + 1))
      let fX = (fMin + fMax) / 2

        let fData = data.filter(d => d.x > fMin && d.x < fMax);
        let fCount = Object.keys(fData).length

      const twaChannelName = defaultChannelsStore.twaName();
      let twaExtent_abs = d3.extent(fData.map((d) => Math.abs(d[twaChannelName] ?? d.Twa)))
      let twaExtent = d3.extent(fData.map((d) => d[twaChannelName] ?? d.Twa))

      let fTwa_abs = (twaExtent_abs[0] + twaExtent_abs[1]) / 2
      let fTwa = (twaExtent[0] + twaExtent[1]) / 2

      let fPos = 'RCH'
      // Upwind: 30-75 (exclusive boundaries: > 30 and < 75)
      if (Math.abs(fTwa_abs) > 30 && Math.abs(fTwa_abs) < 75) {
        fPos = 'UW'
      // Downwind: 105-150 (exclusive boundaries: > 105 and < 150)
      } else if (Math.abs(fTwa_abs) > 105 && Math.abs(fTwa_abs) < 150) {
        fPos = 'DW'
      }

      // Calculate probability based on chart type
      let fProb, fCumProb;
      if (chartType === 'categorical_probability') {
        // For categorical probability, use category count as denominator
        fProb = fCount / recCount;
        fCumProb = cumProb + fProb;
      } else {
        // Standard probability - use total count as denominator
        fProb = fCount / denominatorCount;
        fCumProb = cumProb + fProb;
      }
      
      cumProb = fCumProb;

      // Use appropriate denominator for PERCENT calculation
      let percentDenominator = chartType === 'categorical_probability' ? recCount : denominatorCount;
      
      if (i === 0) {
        output.push({'X': fX, 'COUNT': fCount, 'PROB': fProb * 100, 'CUM': cumProb * 100, 'TWA': fTwa, 'POS': fPos, 'PERCENT': fCount / percentDenominator * 100}) 
      }	else if (i === bincount - 1) {
        output.push({'X': fX, 'COUNT': fCount, 'PROB': fProb * 100, 'CUM': cumProb * 100, 'TWA': fTwa, 'POS': fPos, 'PERCENT': fCount / percentDenominator * 100}) 
        output.push({'X': fX, 'COUNT': 0, 'PROB': 0, 'CUM': 0, 'TWA': fTwa, 'POS': fPos, 'PERCENT': 0}) 
      } else {
        output.push({'X': fX, 'COUNT': fCount, 'PROB': fProb * 100, 'CUM': cumProb * 100, 'TWA': fTwa, 'POS': fPos, 'PERCENT': fCount / percentDenominator * 100}) 
      }
    } 


    // Add statistics to the first data point so we can access them later
    if (output.length > 0) {
      const firstPoint = output[0];
      firstPoint['MEAN'] = mean || 0;
      firstPoint['STDDEV'] = stdDev || 0;
      firstPoint['COUNT'] = recCount;
      try {
        firstPoint['MEDIAN'] = d3.median(data, d => d.x) || 0;
        firstPoint['MIN'] = xMin;
        firstPoint['MAX'] = xMax;
        firstPoint['RANGE'] = xMax - xMin;
        if (recCount > 5 && stdDev && stdDev > 0) {
          const validValues = data
            .map(d => d.x)
            .filter(val => val !== undefined && val !== null && !isNaN(val));
          if (validValues.length > 5) {
            const skewValues = validValues.map(val => {
              const normalizedVal = (val - mean) / stdDev;
              return Math.pow(normalizedVal, 3);
            });
            const skewnessMean = d3.mean(skewValues);
            if (!isNaN(skewnessMean)) {
              firstPoint['SKEWNESS'] = skewnessMean;
            }
          }
        }
      } catch (error: any) {

      }
    }
    return output
  }


  // Worker-based categorical probability calculation
  async function computeCategoricalProbability(data, categoryData, cumulative = false) {
    if (!data || data.length === 0) return [];
    
    // Use worker for large datasets (>1000 points) or complex calculations
    if (data.length > 1000) {
      try {
        const result = await processD3CalculationsWithWorker(data, {
          operation: 'CATEGORICAL_PROBABILITY',
          data: data,
          options: {
            binCount: Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length)))),
            cumulative: cumulative,
            totalCount: data.length
          }
        });
        
        // Add statistics to the first data point
        if (result.processedData.length > 0) {
          const firstPoint = result.processedData[0];
          firstPoint['MEAN'] = result.statistics.mean;
          firstPoint['STDDEV'] = result.statistics.stdDev;
          firstPoint['COUNT'] = data.length;
          firstPoint['MEDIAN'] = result.statistics.median;
          firstPoint['MIN'] = result.statistics.min;
          firstPoint['MAX'] = result.statistics.max;
          firstPoint['RANGE'] = result.statistics.range;
          if (result.statistics.skewness !== undefined) {
            firstPoint['SKEWNESS'] = result.statistics.skewness;
          }
        }
        
        return result.processedData;
      } catch (error: any) {
        
        // Fall back to synchronous calculation
      }
    }
    
    // Synchronous fallback for small datasets
    return computeCategoricalProbabilitySync(data, categoryData, cumulative);
  }

  // Synchronous categorical probability calculation (fallback)
  function computeCategoricalProbabilitySync(data, categoryData, cumulative = false) {
    // Square root binning rule: min=1, max=40
    let bincount = Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))))
    let xExtent = d3.extent(data.map((d) => d.x))
      let recCount = Object.keys(data).length
    // For categorical probability, the denominator should be the count of data points in this category
    let categoryCount = data.length

    const mean = d3.mean(data, d => d.x);
    const stdDev = d3.deviation(data, d => d.x);

    let xMin = xExtent[0]
    let xMax = xExtent[1]
    let xInt = (xMax - xMin) / bincount

    let output = []
    let cumProb = 0
    for (let i = 0; i < bincount; i++) {
      let fMin = xMin + (xInt * i)
      let fMax = xMin + (xInt * (i + 1))
      let fX = (fMin + fMax) / 2

        let fData = data.filter(d => d.x > fMin && d.x < fMax);
        let fCount = Object.keys(fData).length

      const twaChannelName = defaultChannelsStore.twaName();
      let twaExtent_abs = d3.extent(fData.map((d) => Math.abs(d[twaChannelName] ?? d.Twa)))
      let twaExtent = d3.extent(fData.map((d) => d[twaChannelName] ?? d.Twa))

      let fTwa_abs = (twaExtent_abs[0] + twaExtent_abs[1]) / 2
      let fTwa = (twaExtent[0] + twaExtent[1]) / 2

      let fPos = 'RCH'
      // Upwind: 30-75 (exclusive boundaries: > 30 and < 75)
      if (Math.abs(fTwa_abs) > 30 && Math.abs(fTwa_abs) < 75) {
        fPos = 'UW'
      // Downwind: 105-150 (exclusive boundaries: > 105 and < 150)
      } else if (Math.abs(fTwa_abs) > 105 && Math.abs(fTwa_abs) < 150) {
        fPos = 'DW'
      }

      // Categorical probability: count in bin / count in this category
      let fProb = categoryCount > 0 ? fCount / categoryCount : 0
      cumProb += fProb

      if (i === 0) {
        output.push({'X': fX, 'COUNT': fCount, 'PROB': fProb * 100, 'CUM': cumProb * 100, 'TWA': fTwa, 'POS': fPos, 'PERCENT': fCount / categoryCount * 100}) 
      }	else if (i === bincount - 1) {
        output.push({'X': fX, 'COUNT': fCount, 'PROB': fProb * 100, 'CUM': cumProb * 100, 'TWA': fTwa, 'POS': fPos, 'PERCENT': fCount / categoryCount * 100}) 
        output.push({'X': fX, 'COUNT': 0, 'PROB': 0, 'CUM': 0, 'TWA': fTwa, 'POS': fPos, 'PERCENT': 0}) 
      } else {
        output.push({'X': fX, 'COUNT': fCount, 'PROB': fProb * 100, 'CUM': cumProb * 100, 'TWA': fTwa, 'POS': fPos, 'PERCENT': fCount / categoryCount * 100}) 
      }
    } 

    // Add statistics to the first data point so we can access them later
    if (output.length > 0) {
      const firstPoint = output[0];
      firstPoint['MEAN'] = mean || 0;
      firstPoint['STDDEV'] = stdDev || 0;
      firstPoint['COUNT'] = recCount;
      try {
        firstPoint['MEDIAN'] = d3.median(data, d => d.x) || 0;
        firstPoint['MIN'] = xMin;
        firstPoint['MAX'] = xMax;
        firstPoint['RANGE'] = xMax - xMin;
        if (recCount > 5 && stdDev && stdDev > 0) {
          const validValues = data
            .map(d => d.x)
            .filter(val => val !== undefined && val !== null && !isNaN(val));
          if (validValues.length > 5) {
            const skewValues = validValues.map(val => {
              const normalizedVal = (val - mean) / stdDev;
              return Math.pow(normalizedVal, 3);
            });
            const skewnessMean = d3.mean(skewValues);
            if (!isNaN(skewnessMean)) {
              firstPoint['SKEWNESS'] = skewnessMean;
            }
          }
        }
      } catch (error: any) {

      }
    }
    return output
  }

  function getSeriesColor(chart, probabilityData, index) {
    if (props.colortype === 'DEFAULT') {
      return chart.series[0].color;
    } else if (props.colortype === 'TACK') {
      return index === 0 ? "#d62728" : "#2ca02c"; // PORT (index 0) = red, STBD (index 1) = green
    } else {
      const colors = ["blue", "orange", "red"];
      return colors[index % colors.length];
    }
  }

  function getYAxisLabel(internalChartType) {
    switch (internalChartType) {
      case 'standard_probability':
        return 'Probability %';
      case 'categorical_probability':
        return 'Categorical Probability %';
      default:
        return 'Y-Axis';
    }
  }

  function drawCarpetScatter(carpetGroup, xScale, data, seriesIndex, item, xTranslation, chart, internalChartType, timezone: string | null = null) {
    if (!data || data.length === 0) return;
    
    // Mouse event handlers
    const getTooltipContent = (point) => {
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

        }
      }

      return `<table class='table-striped'>
        <tr><td>TIME</td><td>${timeString}</td></tr>
        <tr><td>${chart.series[0].xaxis.name.toUpperCase()}</td><td>${parseFloat(point.x || 0).toFixed(1)}</td></tr>
        </table>`; 
    };

    const mouseover = (event, d) => {
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

    const mousemove = (event, d) => {
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

    const mouseout = (event, d) => {
      setLocalTooltip({ visible: false, content: "", x: 0, y: 0 });
      // Also clear global tooltip for MapContainer in splitter view
      setTooltip({ visible: false, content: "", x: 0, y: 0 });
    };

    const yOffset = seriesIndex * 15; // Vertical offset for multiple series (carpet only)
    
    // Get color for this series - use category-based colors
    let seriesColor = props.colortype === 'DEFAULT' ? chart.series[0].color : 
      props.colortype === 'TACK' ? (item === 'STBD' ? "#2ca02c" : "#d62728") : 
      item === 'UW' ? "blue" : item === 'DW' ? "red" : "orange";
    
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


  function drawProbability(chart, chartbody, xScale, yScale, data, seriesIndex, xTranslation, xyheight) {
    debug(`[Probability] drawProbability called`, {
      hasData: !!data,
      dataLength: data?.length || 0,
      seriesIndex,
      chartType: chart.series[0].yaxis?.name,
      cumulative: chart.series[0].yaxis?.cumulative,
      sampleData: data?.slice(0, 3)
    });
    
    if (!data || data.length === 0) {
      warn(`[Probability] drawProbability: No data to draw`, { data, seriesIndex });
      return;
    }
    
    // Get chart configuration from yaxis
    const chartType = chart.series[0].yaxis?.name || 'Standard Probability';
    const cumulative = chart.series[0].yaxis?.cumulative || false;
    
    const seriesColor = getSeriesColor(chart, data, seriesIndex);
    const yOffset = 0; // No vertical offset for probability charts
    
    // Mouse event handlers
    const mouseover = (event, d) => {
      const tooltipContent = getTooltipContent(d, chartType, cumulative); 
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
      const tooltipContent = getTooltipContent(d, chartType, cumulative); 
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
      setLocalTooltip({
          visible: false,
          content: "",
          x: 0,
          y: 0
      });
      // Also clear global tooltip for MapContainer in splitter view
      setTooltip({
          visible: false,
          content: "",
          x: 0,
          y: 0
      });
    };

    // Helper function to generate tooltip content
    const getTooltipContent = (point, chartType, cumulative) => {
      if (!point) return "";

      if (!cumulative) {
        return `<table class='table-striped'>
          <tr><td>${chart.series[0].xaxis.name.toUpperCase()}</td><td>${parseFloat(point['X'] || 0).toFixed(1)}</td></tr>
          <tr><td>${chart.series[0].yaxis.name.toUpperCase()}</td><td>${parseFloat(point['PROB'] || 0).toFixed(1)}%</td></tr>
          <tr><td>COUNT</td><td>${parseFloat(point['COUNT'] || 0).toFixed(0)}</td></tr>
          <tr><td>TWA</td><td>${parseFloat(point['TWA'] || 0).toFixed(1)}°</td></tr>
          <tr><td>POS</td><td>${point['POS'] || 'N/A'}</td></tr>
          <tr><td>PERCENT</td><td>${parseFloat(point['PERCENT'] || 0).toFixed(1)}%</td></tr>
        </table>`; 
      } else {
        return `<table class='table-striped'>
          <tr><td>${chart.series[0].xaxis.name.toUpperCase()}</td><td>${parseFloat(point['X'] || 0).toFixed(1)}</td></tr>
          <tr><td>${chart.series[0].yaxis.name.toUpperCase()}</td><td>${parseFloat(point['CUM'] || 0).toFixed(1)}%</td></tr>
          <tr><td>COUNT</td><td>${parseFloat(point['COUNT'] || 0).toFixed(0)}</td></tr>
          <tr><td>TWA</td><td>${parseFloat(point['TWA'] || 0).toFixed(1)}°</td></tr>
          <tr><td>POS</td><td>${point['POS'] || 'N/A'}</td></tr>
          <tr><td>PERCENT</td><td>${parseFloat(point['PERCENT'] || 0).toFixed(1)}%</td></tr>
        </table>`; 
      }
    };
    
    // Create line and area generators based on cumulative flag
    let valueline, valuearea;
    if (!cumulative) {
      valueline = d3.line()
        .curve(d3.curveMonotoneX)
        .x(d => xScale(d['X']))
        .y(d => yScale(d['PROB']) + yOffset)
      
      valuearea = d3.area()
        .curve(d3.curveMonotoneX)
        .x(d => xScale(d['X']))
        .y0(xyheight + yOffset) // Always start from bottom of chart
        .y1(d => yScale(d['PROB']) + yOffset)
    } else {
      valueline = d3.line()
        .curve(d3.curveMonotoneX)
        .x(d => xScale(d['X']))
        .y(d => yScale(d['CUM']) + yOffset)
      
      valuearea = d3.area()
        .curve(d3.curveMonotoneX)
        .x(d => xScale(d['X']))
        .y0(xyheight + yOffset) // Always start from bottom of chart
        .y1(d => yScale(d['CUM']) + yOffset)
    }

    // Validate scales before drawing
    const sampleX = data[0]?.['X'];
    const sampleY = cumulative ? data[0]?.['CUM'] : data[0]?.['PROB'];
    
    if (sampleX === undefined || sampleX === null || isNaN(sampleX)) {
      warn(`[Probability] drawProbability: Invalid X value in data`, { 
        sampleX, 
        firstDataPoint: data[0],
        dataLength: data.length 
      });
      return;
    }
    
    if (sampleY === undefined || sampleY === null || isNaN(sampleY)) {
      warn(`[Probability] drawProbability: Invalid Y value in data`, { 
        sampleY, 
        cumulative,
        firstDataPoint: data[0],
        dataLength: data.length 
      });
      return;
    }
    
    // Check if scales are valid
    const testX = xScale(sampleX);
    const testY = yScale(sampleY);
    
    if (isNaN(testX) || isNaN(testY)) {
      warn(`[Probability] drawProbability: Invalid scale values`, { 
        sampleX, 
        sampleY,
        testX, 
        testY,
        xScaleDomain: xScale.domain(),
        yScaleDomain: yScale.domain()
      });
      return;
    }
    
    debug(`[Probability] drawProbability: Drawing probability chart`, {
      dataLength: data.length,
      seriesIndex,
      seriesColor,
      cumulative,
      xRange: [xScale.domain()[0], xScale.domain()[1]],
      yRange: [yScale.domain()[0], yScale.domain()[1]]
    });
    
    // Draw area
    chartbody.append("path")
      .attr("class", "chart-element")
      .datum(data)
      .attr("fill", seriesColor)
      .attr("fill-opacity", 0.3)
      .attr("d", valuearea)
      .attr("transform", "translate(" + xTranslation + ",0)")
      .on("mouseover", function(event, d) {
        // Highlight area on hover
        d3.select(this)
          .attr("fill-opacity", 0.6);
      })
      .on("mouseout", function(event, d) {
        // Restore original opacity
        d3.select(this)
          .attr("fill-opacity", 0.3);
      });

    // Draw line
    chartbody.append("path")
      .attr("class", "chart-element")
      .datum(data)
      .attr("fill", "none")
      .attr("stroke", seriesColor)
      .attr("stroke-width", 2)
      .attr("d", valueline)
      .attr("transform", "translate(" + xTranslation + ",0)")
      .on("mouseover", function(event, d) {
        // Highlight line on hover
        d3.select(this)
          .attr("stroke-width", 4)
          .attr("opacity", 0.8);
      })
      .on("mouseout", function(event, d) {
        // Restore original appearance
        d3.select(this)
          .attr("stroke-width", 2)
          .attr("opacity", 1.0);
      });

    // Add interactive data points
    chartbody.append('g')
      .attr("class", "chart-element")
      .selectAll("points")
      .data(data)
      .enter()
      .append("circle")
      .attr("cx", function (d) { return xScale(d.X); })
      .attr("cy", function (d) { return yScale(cumulative ? d['CUM'] : d['PROB']) + yOffset; })
      .attr("r", 10)
      .style("stroke", "transparent")
      .style("fill", "transparent")
      .attr("transform", "translate(" + xTranslation + ",0)")
      .on("mouseover", mouseover)                  
      .on("mouseout", mouseout)
      .on("mousemove", mousemove);
  }

  function drawStatLines(chartbody, xScale, yScale, probabilityData, seriesColor, seriesIndex, xTranslation, xyheight, maxYValue) {
    if (probabilityData.length === 0) return;
    
    const stats = probabilityData[0]; // First item has the stats
    if (!stats.MEAN || !stats.STDDEV) return;
    
    // Format mean value for display
    const meanValue = stats.MEAN.toFixed(1);
    // Format standard deviation value for display
    const stdDevValue = stats.STDDEV.toFixed(1);
    
    // Adjust vertical positioning for mean labels when multiple series
    const labelYOffset = seriesIndex * 25;
    
    // Draw mean line - only up to the highest data point
    chartbody.append("line")
      .attr("class", "chart-element")
      .attr("x1", xScale(stats.MEAN))
      .attr("x2", xScale(stats.MEAN))
      .attr("y1", yScale(maxYValue)) // Stop at max data value
      .attr("y2", xyheight)
      .style("stroke", seriesColor)
      .style("stroke-width", 2)
      .style("stroke-dasharray", "5,5")
      .attr("transform", "translate(" + xTranslation + ",0)");
    
    // Add mean value label in the extra space at the top
    chartbody.append("text")
      .attr("class", "chart-element")
      .attr("x", xScale(stats.MEAN))
      .attr("y", yScale(maxYValue * 1.08) + labelYOffset) // Position in the extra 20% space
      .attr("text-anchor", "middle")
      .attr("font-size", "20px")
      .attr("font-weight", "bold")
      .attr("user-select", "none")
      .attr("pointer-events", "none")
      .attr("fill", seriesColor)
      .text(`μ = ${meanValue}`)
      .attr("transform", "translate(" + xTranslation + ",0)");
    
    // Draw -1 std dev line - only up to the highest data point
    chartbody.append("line")
      .attr("class", "chart-element")
      .attr("x1", xScale(stats.MEAN - stats.STDDEV))
      .attr("x2", xScale(stats.MEAN - stats.STDDEV))
      .attr("y1", yScale(maxYValue)) // Stop at max data value
      .attr("y2", xyheight)
      .style("stroke", seriesColor)
      .style("stroke-width", 1)
      .style("stroke-dasharray", "3,3")
      .style("opacity", 0.7)
      .attr("transform", "translate(" + xTranslation + ",0)");
    
    // Add standard deviation label at midpoint of the -1 std dev line, offset to the left
    chartbody.append("text")
      .attr("class", "chart-element")
      .attr("x", xScale(stats.MEAN - stats.STDDEV) - 50) // Offset 50px to the left
      .attr("y", xyheight / 2 + labelYOffset) // Middle of the plot with series offset
      .attr("text-anchor", "middle")
      .attr("font-size", "16px")
      .attr("font-weight", "bold")
      .attr("user-select", "none")
      .attr("pointer-events", "none")
      .attr("fill", seriesColor)
      .text(`σ = ${stdDevValue}`) // Already showing the std dev value
      .attr("transform", "translate(" + xTranslation + ",0)");
    
    // Draw +1 std dev line - only up to the highest data point
    chartbody.append("line")
      .attr("class", "chart-element")
      .attr("x1", xScale(stats.MEAN + stats.STDDEV))
      .attr("x2", xScale(stats.MEAN + stats.STDDEV))
      .attr("y1", yScale(maxYValue)) // Stop at max data value
      .attr("y2", xyheight)
      .style("stroke", seriesColor)
      .style("stroke-width", 1)
      .style("stroke-dasharray", "3,3")
      .style("opacity", 0.7)
      .attr("transform", "translate(" + xTranslation + ",0)");
  }

  // Helper function to handle async probability calculations
  const processProbabilityData = async (chart, filteredData) => {
    const chartId = chart.series?.[0]?.xaxis?.name || 'unknown';
    
    const probability_list = [];
    let items = [];
    
    // Get chart configuration from yaxis object
    const chartType = chart.series[0].yaxis?.name || 'Standard Probability';
    const cumulative = chart.series[0].yaxis?.cumulative || false;

    // Map chart type names to internal values
    let internalChartType = 'standard_probability';
    if (chartType === 'Categorical Probability') {
      internalChartType = 'categorical_probability';
    } else if (chartType === 'Standard Probability') {
      internalChartType = 'standard_probability';
    }

    // Use category-based processing
    if (props.colortype === 'DEFAULT') {
      items = ['DEFAULT'];
    } else if (props.colortype === 'TACK') {
      items = ['PORT','STBD'];
    } else {
      items = ['UW','RCH','DW'];
    }

    // Process each category asynchronously
    for (const item of items) {
      const prepared_data = prepareProbability(filteredData, item);
      
      let probability_data;
      
      if (internalChartType === 'categorical_probability') {
        // For categorical probability, we need to pass the category data
        // The prepared_data is already filtered for this specific category
        probability_data = await computeCategoricalProbability(prepared_data, prepared_data, cumulative);
      } else {
        // Standard probability - always use total count for proper calculation
        // This ensures each category is divided by the total of all categories
        probability_data = await computeProbability(prepared_data, 'standard_probability', cumulative, filteredData.length);
      }

      let yExtent = [];
      if (!cumulative) {
        // Standard probability (not cumulative) - filter out the artificial 0 values
        const probValues = probability_data
          .filter(d => d['PROB'] > 0) // Exclude artificial 0 values
          .map(d => d['PROB']);
        yExtent = probValues.length > 0 ? d3.extent(probValues) : [0, 0];
      } else {
        // Cumulative probability - filter out the artificial 0 values
        const cumValues = probability_data
          .filter(d => d['CUM'] > 0) // Exclude artificial 0 values
          .map(d => d['CUM']);
        yExtent = cumValues.length > 0 ? d3.extent(cumValues) : [0, 0];
      }

      // For probability plots, y-axis should start from 0
      const actualMinY = 0;
      const actualMaxY = (yExtent[1] || 0) * 0.85; // Multiply by 0.85 as specified

      // For probability charts, always ensure minYValue is 0
      minYValue = 0;

      if (actualMaxY > maxYValue) {
        maxYValue = actualMaxY;
      }

      probability_list.push(probability_data);
    }

    // Log the actual values in the probability_list before returning
    probability_list.forEach((data, index) => {
      if (data && data.length > 0) {
      }
    });
    
    return { probability_list, items, internalChartType };
  };

  // Main chart rendering effect - only responds to debounced values
  createEffect(() => {
    // Access the data update trigger to force reactivity
    const dataUpdateTrigger = props.dataUpdateTrigger || 0;
    const chart = props.chart;
    const series = chart.series[0];
    const currentData = series.data || [];
    
    // Probability effect triggered
    
    // Only proceed if we have data
    if (currentData.length === 0) {
      // No data available, skipping render
      return;
    }
    
    // Reset scale variables for this chart instance at the start of each render
    minXValue = Number.MAX_VALUE;
    maxXValue = Number.MIN_VALUE;
    minYValue = Number.MAX_VALUE;
    maxYValue = Number.MIN_VALUE;

    // Use ONLY debounced values for filtering
    const currentSelectedRange = debouncedSelectedRange();
    const currentCutEvents = debouncedCutEvents();
    const currentHasSelection = debouncedHasSelection();
    const currentIsCut = debouncedIsCut();
    
    let filteredData = currentData; // Initialize filteredData
    
    // Apply range filtering if there's a selection
    if (currentHasSelection && currentSelectedRange.length > 0) {
      const rangeItem = currentSelectedRange[0];
      if (rangeItem.start_time && rangeItem.end_time) {
        const startTime = new Date(rangeItem.start_time);
        const endTime = new Date(rangeItem.end_time);
        
        filteredData = currentData.filter(d => {
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
        
        filteredData = currentData.filter(d => {
          const datetime = new Date(d.Datetime);
          return datetime >= startTime && datetime <= endTime;
        });
      }
    }

    // Calculate X-axis extents from the filtered data for this chart
    const xValues = filteredData.map(d => d.x).filter(val => !isNaN(val) && val !== null);
    if (xValues.length > 0) {
      minXValue = Math.min(...xValues);
      maxXValue = Math.max(...xValues);
    }

    // Process probability data asynchronously
    const chartId = chart.series?.[0]?.xaxis?.name || 'unknown';
    debug(`[Probability] Starting processProbabilityData`, { chartId, filteredDataLength: filteredData.length });
    
    processProbabilityData(chart, filteredData).then(({ probability_list, items, internalChartType }) => {
      debug(`[Probability] processProbabilityData completed`, {
        probability_listLength: probability_list.length,
        itemsLength: items.length,
        internalChartType,
        probability_listDetails: probability_list.map((data, idx) => ({
          index: idx,
          length: data?.length || 0,
          sample: data?.slice(0, 2)
        }))
      });
      
      // Continue with the rest of the rendering logic
      renderChart(chart, probability_list, items, internalChartType, filteredData);
    }).catch(error => {
      logError(`[Probability] Error in processProbabilityData:`, error);
    });
  });

  // Helper function to render the chart after async data processing
  const renderChart = (chart, probability_list, items, internalChartType, filteredData) => {
    debug(`[Probability] renderChart called`, {
      probability_listLength: probability_list.length,
      itemsLength: items.length,
      internalChartType,
      hasChartRef: !!chartRef
    });
    // Define chart dimensions and margins
    const xTranslation = 45;
    // Update margins to make room for carpet plot
    const xymargin = { top: 60, right: 30, bottom: 50, left: 60 }; // Increased top margin
    let xywidth = (chartRef?.clientWidth ?? 0) - xymargin.left - xymargin.right;
    let xyheight = 400 - xymargin.top - xymargin.bottom;
    // Height for the carpet scatter plot (above main plot)
    const carpetHeight = 40; 

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

    // Check if this is the first render or an update
    const existingSvg = d3.select(chartRef).select("svg");
    const isFirstRender = existingSvg.empty() || !existingSvg.node();
    
    // If this is a first render but there's already content, it means the component was recreated
    const hasExistingContent = chartRef && chartRef.children.length > 0;
    const isCleaningUp = chartRef?.getAttribute('data-cleaning-up') === 'true';
    const shouldTreatAsUpdate = isFirstRender && (hasExistingContent || isCleaningUp);
    
    // Clean up any existing content from previous component
    if (isCleaningUp) {
      chartRef.removeAttribute('data-cleaning-up');
    }

    let svg, chartbody, carpetGroup;
    
    if (isFirstRender && !shouldTreatAsUpdate) {
      // First render - create SVG and chart groups
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
      // Update - use existing SVG and chart groups, or create new one if component was recreated
      if (existingSvg.node()) {
        svg = existingSvg;
        carpetGroup = svg.select("g.carpet-group");
        chartbody = svg.select("g.chart-body");
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

    // Handle transitions for updates
    if (!isFirstRender || shouldTreatAsUpdate) {
      // Remove existing chart elements but keep the SVG structure
      chartbody.selectAll(".chart-element").remove();
      carpetGroup.selectAll(".chart-element").remove();
    }

    // Continue with the rest of the rendering logic
    debug(`[Probability] renderChart: About to call renderChartContent`, {
      probability_listLength: probability_list.length,
      hasSvg: !!svg,
      hasChartbody: !!chartbody
    });
    
    renderChartContent(chart, probability_list, items, internalChartType, filteredData, svg, chartbody, carpetGroup, xTranslation, xymargin, xywidth, xyheight, carpetHeight);
  };

  // Helper function to render the chart content
  const renderChartContent = (chart, probability_list, items, internalChartType, filteredData, svg, chartbody, carpetGroup, xTranslation, xymargin, xywidth, xyheight, carpetHeight) => {

        // Calculate Y-axis extents from probability data for this chart
        probability_list.forEach((data, index) => {
          if (data && data.length > 0) {
            const cumulative = chart.series[0].yaxis?.cumulative || false;
            const yValues = data.map(d => cumulative ? d.CUM : d.PROB).filter(val => !isNaN(val) && val !== null);
            
            if (yValues.length > 0) {
              minYValue = Math.min(minYValue, Math.min(...yValues));
              maxYValue = Math.max(maxYValue, Math.max(...yValues));
            }
          }
        });

    // Ensure we have valid min/max values
    if (minXValue === Number.MAX_VALUE) minXValue = 0;
    if (maxXValue === Number.MIN_VALUE) maxXValue = 100;
    if (minYValue === Number.MAX_VALUE) minYValue = 0;
    if (maxYValue === Number.MIN_VALUE) maxYValue = 100;

    // Chart scaling values calculated independently for this chart instance

    var xInt = (maxXValue - minXValue) / 10
    var xMin = minXValue - xInt
    var xMax = maxXValue + xInt

    // Scales
    const cScale = d3.scaleOrdinal()
      .domain(['UW', 'RCH', 'DW'])
      .range(["blue", "orange", "red"]);
    
    const yScale = d3.scaleLinear()
      .range([xyheight, 0])
      .domain([minYValue, maxYValue * 1.1]) // Increase y-scale by 20% for label space
    const xScale = d3.scaleLinear()
      .range([0, xywidth - xTranslation])
      .domain([xMin,xMax])
    

    // Add Y-axis
    chartbody.append("g")
        .attr("class", "axes chart-element")
        .attr("transform", "translate(" + xTranslation + ", 0)")
        .call(d3.axisLeft(yScale).ticks(5).tickFormat(myTickFormat));

    // Add X-axis
    chartbody.append("g")
          .attr("class", "axes chart-element")
          .attr("transform", "translate(" + xTranslation + "," + xyheight + ")")
          .call(d3.axisBottom(xScale).ticks(5).tickFormat(myTickFormat));

    // Add axis labels
    chartbody
      .append("text")
      .attr("class", "y-label chart-element")
      .attr("transform", "rotate(-90)")
      .attr("y", 0 -xymargin.left + 35)
      .attr("x", 0 - (xyheight / 2)) // Transpose by 15px
      .attr("dy", "1em")
      .style("text-anchor", "middle")
      .attr("font-size", "14px")
      .text(getYAxisLabel(internalChartType));

    chartbody
      .append("text")
      .attr("class", "x-label chart-element")
      .attr("text-anchor", "middle")
      .attr("transform", `translate(${xywidth / 2}, ${xyheight + xymargin.bottom - 10})`)
      .attr("font-size", "14px")
      .text(chart.series[0].xaxis.name || "X-Axis");

    // Add background grid lines
    chartbody.append("g")
      .attr("class", "grid chart-element")
      .attr("transform", "translate(" + xTranslation + "," + xyheight + ")")
      .style("stroke-dasharray", ("3,3"))
      .call(d3.axisBottom(xScale).ticks(5).tickFormat(myTickFormat)
        .tickSize(-xyheight)
        .tickFormat(""));

    chartbody.append("g")
      .attr("class", "grid chart-element")
      .attr("transform", "translate(" + xTranslation + ", 0)")
      .style("stroke-dasharray", ("3,3"))
      .call(d3.axisLeft(yScale).ticks(5).tickFormat(myTickFormat)
        .tickSize(-xywidth)
        .tickFormat(""));

    // Draw carpet plot for each series
    items.forEach((item, index) => {
      // Use category filtering
      const carpetData = prepareProbability(filteredData, item);
      // Draw carpet scatter above main plot
      const timezone = getCurrentDatasetTimezone();
      drawCarpetScatter(carpetGroup, xScale, carpetData, index, item, xTranslation, chart, internalChartType, timezone);
    });
    
    // Map chart type names to internal values for rendering (reuse the variable from above)

    // Draw charts based on chart type
    debug(`[Probability] renderChartContent: About to draw probability charts`, {
      probability_listLength: probability_list.length,
      itemsLength: items.length,
      xScaleDomain: xScale.domain(),
      yScaleDomain: yScale.domain(),
      minYValue,
      maxYValue
    });
    
    probability_list.forEach((probability_data, index) => {
      debug(`[Probability] renderChartContent: Processing probability_data[${index}]`, {
        dataLength: probability_data?.length || 0,
        hasData: !!probability_data && probability_data.length > 0,
        samplePoint: probability_data?.[0],
        xValues: probability_data?.map(d => d['X']).slice(0, 5),
        probValues: probability_data?.map(d => d['PROB']).slice(0, 5)
      });
      
      // Skip drawing if no data available for this series
      if (!probability_data || probability_data.length === 0) {
        debug(`[Probability] renderChartContent: Skipping series ${index} - no data available`);
        return;
      }
      
      // Draw probability plot (standard or categorical)
      drawProbability(chart, chartbody, xScale, yScale, probability_data, index, xTranslation, xyheight);
      
      // Draw statistical lines (mean and standard deviation)
      const seriesColor = getSeriesColor(chart, probability_data, index);
      
      // Pass the index to drawStatLines for vertical positioning
      drawStatLines(chartbody, xScale, yScale, probability_data, seriesColor, index, xTranslation, xyheight, maxYValue);
    });
  };

  onCleanup(() => {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    // Only clear SVG when component is actually being unmounted
    // Don't clear on re-renders as it causes flashing
    if (chartRef && chartRef.parentNode === null) {
      d3.select(chartRef).selectAll("*").remove();
    }
  });

  return (
    <div>
      <div ref={(el) => (chartRef = el)}></div>
      <Show when={props.chart?.missingChannels?.length > 0}>
        <div class="text-center text-sm text-gray-500 dark:text-gray-400 mt-1">
          Data channels could not be loaded for this chart.
        </div>
      </Show>
      
      {/* Local tooltip for when not in splitter view */}
      <Show when={!document.querySelector('.mapboxgl-map') && localTooltip().visible}>
        <div
          id="probability-tooltip"
          class="tooltip"
            style={{
              position: 'fixed',
              opacity: 1,
              left: `${localTooltip().x - 100}px`,
              top: `${localTooltip().y}px`,
              pointerEvents: 'none',
              zIndex: 9999
            }}
            innerHTML={localTooltip().content}
        />
      </Show>
    </div>
  );
}
