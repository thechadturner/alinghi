import { createSignal, createEffect, onCleanup, onMount, untrack, on } from "solid-js";
import { Portal } from "solid-js/web";
import * as d3 from "d3";

import Loading from "../../utilities/Loading";

import { persistantStore } from "../../../store/persistantStore";

import { selectedEvents, setSelectedEvents, triggerUpdate, setTriggerUpdate, triggerSelection, setTriggerSelection, setHasSelection, setSelection, isEventHidden, selectedRange } from "../../../store/selectionStore";
import { tooltip, setTooltip, eventType, filtered, color, phase, tabledata } from "../../../store/globalStore";
import { selectedGradesManeuvers } from "../../../store/filterStore";

import { groupBy, myTickFormat, getIndexColor, putData, round } from "../../../utils/global";
import { error as logError, debug } from "../../../utils/console";
import { fetchTimeSeriesData } from "../../../services/maneuversDataService";
import { buildColorGrouping } from "../../../utils/colorGrouping";
import { isDark } from "../../../store/themeStore";
import { apiEndpoints } from "../../../config/env";
import { user } from "../../../store/userStore";
import { sourcesStore } from "../../../store/sourcesStore";
import ManeuverLegend from "../../legends/Maneuver";
import { createMemo } from "solid-js";

interface TimeSeriesProps {
  context?: 'dataset' | 'fleet' | 'historical';
  description?: string;
  onDataUpdate?: () => void;
  onLegendClick?: (legendItem: string) => void;
}

interface TimeSeriesDataPoint {
  event_id: number;
  tws_bin: number;
  tack: string;
  vmg_perc_avg: number;
  race: number | string;
  source_name: string;
  State?: string;
  Config?: string;
  time: number;
  [key: string]: any; // For dynamic channels
}

export default function TimeSeries(props: TimeSeriesProps) {
  // Get context from props, default to 'dataset' for backward compatibility
  const context = props?.context || 'dataset';
  const [tsdata, setTsData] = createSignal<TimeSeriesDataPoint[][]>([]);
  const [mode_x] = createSignal(true);
  const [loading, setLoading] = createSignal(true);
  const [firstload, setFirstLoad] = createSignal(true);
  const [channelOrder, setChannelOrder] = createSignal<string[]>([]);
  const [chartsFromData, setChartsFromData] = createSignal<string[]>([]);

  // Viewport tracking for performance optimization
  const [chartVisibility, setChartVisibility] = createSignal<Map<string, boolean>>(new Map());
  // Buffer: 3 charts worth of space (chart height + margin-bottom) for preloading
  const getViewportBuffer = () => {
    const chartHeightWithMargin = chartHeight + 20; // chartHeight (200px) + margin-bottom (20px)
    return chartHeightWithMargin * 3; // 3 charts above and below viewport
  };
  let intersectionObservers = new Map<string, IntersectionObserver>();
  let storedMouseHandlers = new Map<string, {
    mouseover: ((event: MouseEvent, d: TimeSeriesDataPoint[]) => void) | null;
    mouseout: (() => void) | null;
    mousemove: ((event: MouseEvent, d: TimeSeriesDataPoint[]) => void) | null;
    click: ((event: MouseEvent, d: any) => void) | null;
  }>();

  let timeArray: any[][] = []
  let valArray: any[][] = []
  let eidArray: number[] = []

  let chartHeight = 200
  let chartWidth = 1280
  let containerRef: HTMLDivElement | null = null

  // Using global color scale for consistency
  let myColorScale: d3.ScaleLinear<number, string> | d3.ScaleThreshold<number, string> | d3.ScaleOrdinal<string | number, string> = d3.scaleLinear<number, string>()
  let getItemColor: ((d: any) => string) | null = null; // Store getItemColor function for SOURCE coloring
  let minVal = 999999
  let maxVal = -999999

  const isEventSelected = (id: number) => selectedEvents().includes(id);

  // Build description from phase and selected description
  const buildDescription = (): string => {
    const currentPhase = phase();
    const selectedDesc = props?.description || 'BASICS';
    
    let phaseNumber = '0';
    if (currentPhase === 'INVESTMENT') {
      phaseNumber = '1';
    } else if (currentPhase === 'TURN') {
      phaseNumber = '2';
    } else if (currentPhase === 'ACCELERATION') {
      phaseNumber = '3';
    }
    
    // Format: "1_Foils" (phase number + description with first letter capitalized)
    const formattedDesc = selectedDesc.charAt(0).toUpperCase() + selectedDesc.slice(1).toLowerCase();
    return `${phaseNumber}_${formattedDesc}`;
  }


  const updateChartWidth = (): void => {
    if (containerRef) {
      const containerWidth = containerRef.offsetWidth || 1280;
      chartWidth = Math.max(containerWidth - 20, 400); // Use container width with 20px margin, min 400px
    } else {
      chartWidth = 1280; // Fallback width
    }
  }

  const updateChartHeight = (): void => {
    chartHeight = 200; // Fixed 200px height
  }

  // Async function to fetch data
  const fetchData = async (): Promise<TimeSeriesDataPoint[][]> => {
    try {
      // Get the current filtered event list - time series endpoint requires non-empty event_list
      const currentFiltered = filtered();
      // Extract event IDs from filtered data (handles both number[] and ManeuverData[])
      let eventIds: number[] = [];
      if (Array.isArray(currentFiltered) && currentFiltered.length > 0) {
        if (typeof currentFiltered[0] === 'number') {
          eventIds = currentFiltered as unknown as number[];
        } else {
          eventIds = (currentFiltered as any[]).map((item: any) => item.event_id).filter((id: any): id is number => typeof id === 'number');
        }
      }
      
      const hasEvents = eventIds.length > 0;
      
      // Time series endpoint requires event_list to be non-empty, so we must have events
      if (!hasEvents) {
        // No events yet (e.g. table still loading or no events selected) – skip fetch for now
        debug('TimeSeries: Skipping fetch - no events in filtered list');
        return [];
      }
      
      // Build description from phase and selected description
      const descriptionStr = buildDescription();

      if (eventIds.length === 0) {
        debug('TimeSeries: No valid event IDs found in filtered list');
        return [];
      }

      // Always use event_list so timeseries data matches table filtering (same event set).
      // Service chunks when >100 events to avoid URL length limits.
      const fetchParams: any = {
        eventType: eventType(),
        description: descriptionStr,
        eventList: eventIds,
      };

      debug('TimeSeries: fetchParams before calling fetchTimeSeriesData:', {
        hasEventList: !!fetchParams.eventList,
        eventListLength: fetchParams.eventList?.length || 0,
        hasTimeRange: !!fetchParams.timeRange,
        hasFilters: !!fetchParams.filters
      });

      // Fetch timeseries data
      const timeseriesResponse = await fetchTimeSeriesData(context, fetchParams);

      // Handle both old format (array) and new format (object with data and charts)
      let json_data: any[];
      let charts: string[] = [];
      if (Array.isArray(timeseriesResponse)) {
        json_data = timeseriesResponse;
        // Extract charts from first item's json field if available
        if (json_data.length > 0 && json_data[0].json) {
          try {
            const firstJson = typeof json_data[0].json === 'string' 
              ? JSON.parse(json_data[0].json) 
              : json_data[0].json;
            if (firstJson.charts && Array.isArray(firstJson.charts)) {
              charts = firstJson.charts;
              setChartsFromData(charts);
              debug('TimeSeries: Extracted charts from first item:', charts);
            }
          } catch (parseError) {
            debug('TimeSeries: Error parsing json from first item:', parseError);
          }
        }
      } else if (timeseriesResponse && typeof timeseriesResponse === 'object' && 'data' in timeseriesResponse) {
        const responseObj = timeseriesResponse as { data: any[]; charts?: string[] };
        json_data = responseObj.data || [];
        // Check top-level charts first
        if (responseObj.charts && Array.isArray(responseObj.charts)) {
          charts = responseObj.charts;
          setChartsFromData(charts);
          debug('TimeSeries: Using charts from top-level response:', charts);
        } else if (json_data.length > 0 && json_data[0].json) {
          // Fallback: extract from first item's json field
          try {
            const firstJson = typeof json_data[0].json === 'string' 
              ? JSON.parse(json_data[0].json) 
              : json_data[0].json;
            if (firstJson.charts && Array.isArray(firstJson.charts)) {
              charts = firstJson.charts;
              setChartsFromData(charts);
              debug('TimeSeries: Extracted charts from first item (fallback):', charts);
            }
          } catch (parseError) {
            debug('TimeSeries: Error parsing json from first item:', parseError);
          }
        }
      } else {
        json_data = [];
      }

      if (!json_data || json_data.length === 0) {
        return [];
      }

      // Get table data for joining metadata
      const tableData = tabledata();
      const tableDataMap = new Map<number, any>();
      tableData.forEach((row: any) => {
        if (row.event_id) {
          tableDataMap.set(row.event_id, row);
        }
      });

      // Cache phase value to avoid repeated function calls
      const currentPhase = phase();
      
      // Pre-compute tack value logic
      const getTackValue = (twa_entry: number): string => {
        if (currentPhase === 'FULL' || currentPhase === 'TURN') {
          return twa_entry > 0 ? 'S - P' : 'P - S';
        } else if (currentPhase === 'INVESTMENT') {
          return twa_entry > 0 ? 'STBD' : 'PORT';
        } else {
          return twa_entry > 0 ? 'PORT' : 'STBD';
        }
      };
      
      const dataArray: TimeSeriesDataPoint[][] = [];
      
        // Filter and process in a single pass for better performance (exclude hidden events)
        const eventIdSet = new Set(eventIds);
        const filtered_data = json_data.filter((d: any) => eventIdSet.has(d.event_id) && !isEventHidden(d.event_id));

      // Get channel order from first data point (if available)
      let channelOrder: string[] = [];
      if (filtered_data.length > 0 && filtered_data[0].json?.values?.length > 0) {
        const firstValue = filtered_data[0].json.values[0];
        // Get all keys except 'time' and 'event_id'
        channelOrder = Object.keys(firstValue).filter(key => 
          key !== 'time' && key !== 'event_id'
        );
        // Store channel order to preserve JSON key order
        setChannelOrder(channelOrder);
      }

      // Process data more efficiently
      for (let i = 0; i < filtered_data.length; i++) {
        const item = filtered_data[i];
        const tableRow = tableDataMap.get(item.event_id);
        
        // Get metadata from table data (preferred) or fallback to timeseries data
        const eventId = item.event_id;
        const twsBin = tableRow?.tws_bin ?? item.tws_bin;
        const vmgPercAvg = tableRow?.vmg_perc_avg ?? item.vmg_perc_avg;
        const twaEntry = tableRow?.twa_entry ?? item.twa_entry;
        const raceValue = tableRow?.Race_number ?? tableRow?.race_number ?? tableRow?.race ?? item.Race_number;
        const race = (raceValue === -1 || raceValue === '-1') ? 'TRAINING' : raceValue;
        const sourceName = tableRow?.source_name ?? item.source_name ?? '';
        const state = tableRow?.state ?? tableRow?.State ?? item.state ?? item.State;
        const config = tableRow?.config ?? tableRow?.Config ?? item.config ?? item.Config;
        
        const tackValue = getTackValue(twaEntry);
        const values = item.json.values;
        const processedData: TimeSeriesDataPoint[] = new Array(values.length);
        
        // Process values array dynamically
        for (let j = 0; j < values.length; j++) {
          const d = values[j];
          const dataPoint: TimeSeriesDataPoint = {
            event_id: eventId,
            tws_bin: twsBin,
            tack: tackValue, 
            vmg_perc_avg: vmgPercAvg,
            race: race,
            source_name: sourceName,
            time: parseFloat(d.time),
          };
          
          // Add State and Config if available
          if (state !== undefined && state !== null) {
            dataPoint.State = state;
          }
          if (config !== undefined && config !== null) {
            dataPoint.Config = config;
          }
          
          // Dynamically process all channels from JSON (in order they appear)
          for (const channel of channelOrder) {
            if (d[channel] !== undefined && channel !== 'time' && channel !== 'event_id') {
              // Round values to 2 decimal places
              dataPoint[channel] = round(d[channel], 2);
            }
          }
          
          processedData[j] = dataPoint;
        }
        
        dataArray.push(processedData); 
      }

      setTsData(dataArray);
      updateMinMaxRanges();
      return dataArray;
    } catch (error: any) {
      logError("Error fetching data:", error);
      return [];
    }
  };

  function updateMinMaxRanges() {
    let channel = 'tws_bin'
    if (color() == 'VMG') {
      channel = 'vmg_perc_avg'
    }

    minVal = 9999999
    maxVal = -9999999
    tsdata().forEach(function(item) {
      try {
        let d = item[0]
        let val = parseFloat(d[channel])
        if (val > maxVal) {maxVal = val}
        if (val < minVal) {minVal = val} 
      } catch {
      }
    })

    InitScales()  
  }

  function InitScales(): void {
    const currentColor = String(color() || '').toUpperCase();
    
    if (currentColor === 'TWS') {
      // Fixed TWS bins: 10, 15, 20, 25, 30, 35, 40, 45, 50
      // Use scaleThreshold with 8 thresholds to create 9 color ranges (one for each bin)
      const twsScale = d3.scaleThreshold<number, string>()
      twsScale.domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]);
      twsScale.range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"] as any)
      myColorScale = twsScale as any;
    }
    else if (currentColor === 'VMG') {
      const vmgScale = d3.scaleLinear<number, string>()
      vmgScale.domain([minVal, (minVal + maxVal) / 2, maxVal])
      vmgScale.range(["blue","lightgrey","red"] as any)
      myColorScale = vmgScale as any;
    }
    else if (currentColor === 'TACK') {
      const tackScale = d3.scaleThreshold<number, string>()
      tackScale.domain([-180,-1,1,180])
      tackScale.range(["red","red","#64ed64","#64ed64"] as any)
      myColorScale = tackScale as any;
    }
    else if (currentColor === 'RACE' || currentColor === 'SOURCE' || 
             currentColor === 'STATE' || currentColor === 'CONFIG') {
      // Use buildColorGrouping for consistency with ManeuverScatter
      const data: TimeSeriesDataPoint[] = []
      tsdata().forEach(item => {
        data.push(item[0])
      })
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(data, currentColor);
      myColorScale = scale as any;
      getItemColor = getItemColorFn as ((d: any) => string) | null; // Store the function for use in getOriginalColor
    }
    else {
      const defaultScale = d3.scaleLinear<number, string>()
      // defaultScale.domain([4, 8, 14, 18, 22])
      defaultScale.domain([8, 16, 28, 36, 44]);
      defaultScale.range(["yellow","orange","red"] as any)
      myColorScale = defaultScale as any;
    }
  }

  function getClass(d: TimeSeriesDataPoint): string {
    if (d.tack  == 'PORT') {
        return "dash_line"
    } else if (d.tack == 'STBD') {
      return "solid_line"
    } else if (d.tack == 'P - S') {
        return "dash_line"
    } else {
        return "solid_line"
    }
  }

  // Get the original color based on current color-by setting (without selection-based coloring)
  function getOriginalColor(d: TimeSeriesDataPoint): string {
    if (!d) return 'grey';
    
    const currentColor = String(color() || '').toUpperCase();
    
    if (currentColor === 'TWS') {
      const val = d.tws_bin;
      return String((myColorScale as any)(val) || 'grey');
    }
    else if (currentColor === 'VMG') {
      const val = d.vmg_perc_avg;
      return String((myColorScale as any)(val) || 'grey');
    }
    else if (currentColor === 'TACK') {
      if (d.tack === 'PORT' || d.tack === 'P - S') {
        return '#d62728';
      } else if (d.tack === 'STBD' || d.tack === 'S - P') {
        return '#2ca02c';
      }
    }
    else if (currentColor === 'RACE' || currentColor === 'SOURCE' || 
             currentColor === 'STATE' || currentColor === 'CONFIG') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    return 'grey';
  }

  function getColor(d: TimeSeriesDataPoint): string {
    const selected = selectedEvents();
    const hasMoreThan8Selections = selected.length > 8;
    const isColoredBySource = color() === 'SOURCE';
    
    // When colored by SOURCE, always use original color (source name color)
    if (isColoredBySource) {
      return getOriginalColor(d);
    }
    
    // When > 8 selections, maintain original color for all points
    if (hasMoreThan8Selections) {
      return getOriginalColor(d);
    }
    
    // When <= 8 selections, use selection-based coloring for selected points
    if (selected.length > 0) {
      const selectionColor = getIndexColor(selected, d.event_id);
      // Fallback to original color if getIndexColor returns undefined
      return selectionColor || getOriginalColor(d);
    }
    
    // No selections, use original color
    return getOriginalColor(d);
  }
  
  function make_x_gridlines(xScale: d3.ScaleLinear<number, number>) {
    return d3.axisBottom(xScale)
      .ticks(10).tickFormat(myTickFormat)
  }
  
  function make_y_gridlines(yScale: d3.ScaleLinear<number, number>) {
    return d3.axisLeft(yScale)
      .ticks(5).tickFormat(myTickFormat)
  }

  function buildTimeSeries(data: TimeSeriesDataPoint[][]) {
    d3.select("#plots").selectAll("*").remove()

    // Clean up existing observers
    intersectionObservers.forEach((observer) => {
      observer.disconnect();
    });
    intersectionObservers.clear();
    setChartVisibility(new Map());

    // Update chart dimensions based on container size
    updateChartWidth()
    updateChartHeight()

    if (data.length > 0 && data[0].length > 0) {  
      const firstPoint = data[0][0];
      
      // Dynamically extract channels from first data point
      // Exclude metadata fields that are not visualization channels
      const excludedFields = new Set([
        'event_id', 'tack', 'race', 'source_name', 
        'tws_bin', 'time', 'vmg_perc_avg', 'sink_min', 
        'State', 'state', 'STATE', 'Config', 'config', 'CONFIG'
      ]);
      
      // Use charts from timeseries data if available, otherwise use stored channel order from JSON
      // Filter to only include channels that exist in the data and are not excluded
      const chartsOrder = chartsFromData();
      const storedOrder = channelOrder();
      const ts_columns: string[] = [];
      
      if (chartsOrder.length > 0) {
        // Use ONLY charts order from timeseries data - don't mix with stored order
        // This ensures the exact order from the timeseries data is preserved
        chartsOrder.forEach(k => {
          if (!excludedFields.has(k) && firstPoint[k] !== undefined) {
            ts_columns.push(k);
          }
        });
      } else if (storedOrder.length > 0) {
        // Fallback: Use stored order from JSON
        storedOrder.forEach(k => {
          if (!excludedFields.has(k) && firstPoint[k] !== undefined) {
            ts_columns.push(k);
          }
        });
      } else {
        // Final fallback: extract from first point if channel order not available
        Object.keys(firstPoint).forEach(k => {
          if (!excludedFields.has(k)) {
            ts_columns.push(k);
          }
        });
      }

      timeArray = []
      valArray = []
      eidArray = []

      for (let c = 1; c < ts_columns.length + 1; c++) {
        const channel = ts_columns[c - 1]
        const chartId = `timeseries-chart-${channel}`;

        // Create a wrapper div for each chart with fixed width and unique ID
        const chartWrapper = d3.select("#plots")
          .append("div")
          .attr("class", "timeseries-chart-wrapper")
          .attr("id", chartId)
          .attr("data-channel", channel)
          .style("width", `${chartWidth}px`) // Fixed width for each chart
          .style("flex-shrink", "0") // Prevent shrinking
          .style("margin-bottom", "20px"); // Add spacing between charts

        // Create SVG container (will be populated when visible)
        chartWrapper.append("svg")
          .attr("id", "ts"+c) 
          .attr("class", "ts")
          .attr("width", chartWidth)
          .attr("height", chartHeight);

        // Set up IntersectionObserver for this chart
        const chartElement = document.getElementById(chartId);
        if (chartElement) {
          const observer = new IntersectionObserver(
            (entries) => {
              entries.forEach(entry => {
                const currentVisibility = chartVisibility();
                const wasVisible = currentVisibility.get(chartId) || false;
                const isVisible = entry.isIntersecting;
                
                // Update visibility state
                const newVisibility = new Map(currentVisibility);
                newVisibility.set(chartId, isVisible);
                setChartVisibility(newVisibility);

                // Manual viewport check to verify actual visibility
                const rect = chartElement.getBoundingClientRect();
                const isActuallyVisible = rect && rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0;

                // Key fix: Render if EITHER IntersectionObserver says visible OR manual check says visible
                // This handles cases where observer hasn't fired yet or missed the chart
                if (isVisible || isActuallyVisible) {
                  const plot = d3.select(`#ts${c}`);
                  const hasBody = !plot.select("#body"+c).empty();
                  
                  if (!hasBody) {
                    // Chart needs to be rendered
                    plot.append("g")
                      .attr("id", "body"+c)
                      .attr("transform", "translate(20, 5)");
                    const body = plot.select("#body"+c);
                    drawTimeSeries(c - 1, body, data, channel);
                  }
                } else if (!isVisible && wasVisible && !isActuallyVisible) {
                  // Chart left viewport - only remove if actually not visible (double-check)
                  const plot = d3.select(`#ts${c}`);
                  plot.selectAll("*").remove();
                  // Remove stored handlers for this chart
                  storedMouseHandlers.delete(chartId);
                }
              });
            },
            {
              // Buffer: 3 charts worth of space (preload before visible and keep loaded after leaving viewport)
              rootMargin: `${getViewportBuffer()}px 0px ${getViewportBuffer()}px 0px`,
              threshold: 0.01
            }
          );
          
          observer.observe(chartElement);
          intersectionObservers.set(chartId, observer);

          // Check initial visibility and render if already visible
          // Use requestAnimationFrame for better timing with DOM updates
          requestAnimationFrame(() => {
            const rect = chartElement.getBoundingClientRect();
            const isInitiallyVisible = rect && rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0;
            if (isInitiallyVisible) {
              const plot = d3.select(`#ts${c}`);
              const hasBody = !plot.select("#body"+c).empty();
              if (!hasBody) {
                // Set visibility BEFORE drawTimeSeries so tooltip hover circles are added on first paint
                const newVisibility = new Map(chartVisibility());
                newVisibility.set(chartId, true);
                setChartVisibility(newVisibility);
                plot.append("g")
                  .attr("id", "body"+c)
                  .attr("transform", "translate(20, 5)");
                const body = plot.select("#body"+c);
                drawTimeSeries(c - 1, body, data, channel);
              }
            }
          });
        }
      }

      // Add a fake chart at the end to ensure last chart is fully visible when scrolling
      // This matches the structure of real charts to improve scroll behavior
      const fakeChartWrapper = d3.select("#plots")
        .append("div")
        .attr("class", "timeseries-chart-wrapper")
        .style("width", `${chartWidth}px`)
        .style("flex-shrink", "0")
        .style("margin-bottom", "20px")
        .style("opacity", "0"); // Make it invisible but still take up space

      fakeChartWrapper.append("svg")
        .attr("id", "ts-spacer")
        .attr("class", "ts")
        .attr("width", chartWidth)
        .attr("height", chartHeight * 0.5); // Reduced - container height now properly calculated
      
      // Ensure selection colors are applied after all charts are drawn
      // This is important when switching from Scatter to TimeSeries with existing selections
      // Also ensures synchronization when opening ManeuverWindow - always call updateSelection
      // to sync with current selection state from selectionStore (even if empty)
      // Use setTimeout to ensure DOM is ready
      setTimeout(() => {
        updateSelection();
      }, 0);
    }
  }

  function getToolTipPosition(event) {
    try {
      if (!containerRef) return { x: 0, y: 0 };
      
      // Use fixed positioning relative to viewport
      const mouseX = event.clientX;
      const mouseY = event.clientY;
      
      const pad = 12;
      const estWidth = 220;
      const estHeight = 140;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Find the scroll container (could be body, html, or main-content)
      let scrollContainer: HTMLElement | null = null;
      const mainContent = document.getElementById('main-content');
      if (mainContent && mainContent.scrollHeight > mainContent.clientHeight) {
        scrollContainer = mainContent;
      } else if (document.body.scrollHeight > document.body.clientHeight) {
        scrollContainer = document.body;
      } else if (document.documentElement.scrollHeight > document.documentElement.clientHeight) {
        scrollContainer = document.documentElement;
      }
      
      // Get scroll position to understand where we are on the page
      const scrollY = scrollContainer ? scrollContainer.scrollTop : window.scrollY || 0;
      const scrollX = scrollContainer ? scrollContainer.scrollLeft : window.scrollX || 0;
      
      // Calculate tooltip position relative to viewport
      // Position to the right of cursor by default
      let x = mouseX + pad;
      // If tooltip would go off right edge, position to the left of cursor
      if (x + estWidth > viewportWidth) {
        x = Math.max(pad, mouseX - estWidth - pad);
      }
      
      // Position above cursor by default (with small offset)
      let y = mouseY - estHeight - pad;
      
      // If tooltip would go off top of viewport, position below cursor
      if (y < pad) {
        y = mouseY + pad;
        // If still off bottom, position above cursor but within viewport
        if (y + estHeight > viewportHeight) {
          y = Math.max(pad, viewportHeight - estHeight - pad);
        }
      } else if (y + estHeight > viewportHeight) {
        // If tooltip would go off bottom, position above cursor
        y = Math.max(pad, mouseY - estHeight - pad);
      }

      // Translate tooltip 75px to the left of computed position
      x -= 75;

      return { x, y };
    } catch (error) {
      logError('Error calculating tooltip position:', error);
      return { x: 0, y: 0 };
    }
  }

  interface ManeuverPathType {
    eventId: number;
    points: TimeSeriesDataPoint[];
    firstPoint: TimeSeriesDataPoint;
  }

  function drawTimeSeries(index, chartbody, collection, channel) {
    // Check if chart is visible before rendering
    const chartId = `timeseries-chart-${channel}`;
    const currentVisibility = chartVisibility();
    const isChartVisible = currentVisibility.get(chartId) || false;
    
    // Skip rendering if chart is not visible (unless it's the initial render)
    if (!isChartVisible && chartbody.selectAll("*").size() > 0) {
      return;
    }
    
    let minXValue = 999999
    let maxXValue = -999999
    
    let minYValue = 999999
    let maxYValue = -999999

    let maneuverPathsFiltered: ManeuverPathType[] = [];
  
    if (collection != undefined) {
      // Ensure arrays exist for this index
      if (!timeArray[index]) {
        timeArray[index] = [];
      }
      if (!valArray[index]) {
        valArray[index] = [];
      }
      
      // Cache mode_x() value to avoid repeated function calls
      const useTimeForX = mode_x();
      const fill_eid = eidArray.length === 0;
      
      // Pre-allocate arrays for better performance
      const timeArr = timeArray[index];
      const valArr = valArray[index];
      
      // Safety check: ensure arrays are defined
      if (!timeArr || !valArr) {
        logError(`Arrays not initialized for index ${index}`);
        return;
      }

      // Build paths from all points (filtering disabled except for VMG_PERC)
      const useOutlierFilter = channel === 'VMG_PERC';
      const maneuversByEvent = new Map<number, TimeSeriesDataPoint[]>();
      collection.forEach((vals: TimeSeriesDataPoint[]) => {
        vals.forEach((d: TimeSeriesDataPoint) => {
          if (!d.event_id) return;
          const eventId = d.event_id;
          if (!maneuversByEvent.has(eventId)) {
            maneuversByEvent.set(eventId, []);
          }
          maneuversByEvent.get(eventId)!.push(d);
        });
      });
      maneuversByEvent.forEach((points) => points.sort((a, b) => a.time - b.time));
      maneuverPathsFiltered = [];
      if (useOutlierFilter) {
        // VMG_PERC: apply outlier filter to remove spikes
        const deltas: number[] = [];
        maneuversByEvent.forEach((points) => {
          for (let j = 1; j < points.length; j++) {
            const prevY = Number((points[j - 1] as any)[channel]);
            const currY = Number((points[j] as any)[channel]);
            if (Number.isFinite(prevY) && Number.isFinite(currY)) {
              deltas.push(Math.abs(currY - prevY));
            }
          }
        });
        const stepStd = deltas.length > 1 ? (d3.deviation(deltas) ?? 0) : 0;
        const stepThreshold = stepStd > 0 ? 2 * stepStd : Infinity;
        maneuversByEvent.forEach((points, eventId) => {
          const filteredPoints: TimeSeriesDataPoint[] = [];
          let prevPoint: TimeSeriesDataPoint | null = null;
          points.forEach(d => {
            const yVal = Number((d as any)[channel]);
            // Skip values > 140 for VMG_PERC
            if (yVal > 150) {
              return;
            }
            if (prevPoint === null) {
              filteredPoints.push(d);
              prevPoint = d;
            } else {
              const prevY = Number((prevPoint as any)[channel]);
              const step = Number.isFinite(prevY) && Number.isFinite(yVal) ? Math.abs(yVal - prevY) : 0;
              if (step > stepThreshold) {
                prevPoint = d;
                return;
              }
              filteredPoints.push(d);
              prevPoint = d;
            }
          });
          if (filteredPoints.length > 1 && eventId !== null && eventId !== undefined) {
            maneuverPathsFiltered.push({
              eventId,
              points: filteredPoints,
              firstPoint: filteredPoints[0]
            });
          }
        });
      } else {
        // All other channels: use all points
        maneuversByEvent.forEach((points, eventId) => {
          if (points.length > 1 && eventId !== null && eventId !== undefined) {
            maneuverPathsFiltered.push({
              eventId,
              points: [...points],
              firstPoint: points[0]
            });
          }
        });
      }

      // Process data: X range and arrays from full collection; Y range from outlier-adjusted paths
      for (let i = 0; i < collection.length; i++) {
        const vals = collection[i];
        for (let j = 0; j < vals.length; j++) {
          const d = vals[j];
          
          const bspVal = (d as any).bsp || 0;
          const xVal = useTimeForX ? parseFloat(String(d.time)) : parseFloat(String(bspVal));
          if (xVal > maxXValue) maxXValue = xVal;
          if (xVal < minXValue) minXValue = xVal;

          const yVal = (d as any)[channel];
          const yValNum = typeof yVal === 'number' ? yVal : parseFloat(String(yVal || 0));

          timeArr.push(useTimeForX ? d.time : bspVal);
          valArr.push(yValNum);

          if (fill_eid) {
            eidArray.push(d.event_id);
          }
        }
      }

      // Y scale from outlier-adjusted data when available; otherwise fall back to full collection
      // Include zero so channels that cross zero (e.g. TWA_N_DEG) are fully visible
      if (maneuverPathsFiltered.length > 0) {
        minYValue = 999999;
        maxYValue = -999999;
        maneuverPathsFiltered.forEach((m) => {
          m.points.forEach((d) => {
            const yValNum = Number((d as any)[channel]);
            if (Number.isFinite(yValNum)) {
              if (yValNum > maxYValue) maxYValue = yValNum;
              if (yValNum < minYValue) minYValue = yValNum;
            }
          });
        });
      } else {
        // No filtered paths: use Y range from collection (same as timeArr/valArr loop above)
        for (let i = 0; i < collection.length; i++) {
          const vals = collection[i];
          for (let j = 0; j < vals.length; j++) {
            const yValNum = Number((vals[j] as any)[channel]);
            if (Number.isFinite(yValNum)) {
              if (yValNum > maxYValue) maxYValue = yValNum;
              if (yValNum < minYValue) minYValue = yValNum;
            }
          }
        }
      }
    }
  
    maxYValue = maxYValue + ((maxYValue - minYValue) / 5)
    minYValue = minYValue - ((maxYValue - minYValue) / 15)
  
    if (maxYValue - minYValue < 1.5) {
      if (minYValue < 0.25 && minYValue > 0) {
        minYValue = -0.1
      }
    }
  
    //SETUP SCALES
    let yScale = d3.scaleLinear()
      .domain([minYValue, maxYValue])
      .range([chartHeight, 0]);
      
    const darkMode = isDark();

    let yAxis = chartbody.append("g")
      .attr("class", "axes")
      .attr("transform", "translate(20, 0)")
      .call(d3.axisLeft(yScale).ticks(4).tickFormat((d: d3.NumberValue) => myTickFormat(Number(d))));

    // Style y-axis tick labels based on theme
    yAxis.selectAll("text")
      .style("fill", darkMode ? "#ffffff" : "#000000");
    
    let xScale = d3.scaleLinear()
      .domain([minXValue, maxXValue])
      .range([0, chartWidth]);
    
    let xAxis = chartbody.append("g")
      .attr("class", "axes")
      .attr("transform", "translate(20, " + chartHeight + ")")
      .call(d3.axisBottom(xScale).ticks(10).tickFormat((d: d3.NumberValue) => String(Number(d))))
    
    chartbody.append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "top")  
      .attr("transform", "translate(30,15)")  
      .attr("font-size", "14px")
      .attr("user-select", "none")
      .attr("pointer-events", "none")
      .attr("fill", darkMode ? "#ffffff" : "#000000")
      .text(channel.toUpperCase()) 
  
    chartbody.append("g")
      .attr("class","grid")
      .attr("transform", "translate(20," + chartHeight + ")")
      .style("stroke-dasharray",("3,3"))
      .call(make_x_gridlines(xScale)
        .tickSize(-chartHeight)
        .tickFormat("")
      )
  
    chartbody.append("g")
      .attr("class","grid")
      .attr("transform", "translate(20, 0)")
      .style("stroke-dasharray",("3,3"))
      .call(make_y_gridlines(yScale)
        .tickSize(-chartWidth)
        .tickFormat("")
      )
  
    var brush = d3.brush()                  
      .extent( [ [0,0], [chartWidth,chartHeight] ] ) 
      .on("end", updateChart) 
  
    chartbody.append("g")
      .attr("class", "brush")
      .call(brush)
      .on("dblclick", refreshChart);

    // Mouse event handlers
    const mouseover = (event: MouseEvent, d: TimeSeriesDataPoint[]) => {
      const tooltipContent = getTooltipContent(d[0]); 
      const position = getToolTipPosition(event);

      setTooltip({
          visible: true,
          content: tooltipContent,
          x: position.x - 150,
          y: position.y
      });
    };

    const mousemove = (event: MouseEvent, d: TimeSeriesDataPoint[]) => {
      const tooltipContent = getTooltipContent(d[0]); 
      const position = getToolTipPosition(event);

      setTooltip({
          visible: true,
          content: tooltipContent,
          x: position.x - 150,
          y: position.y
      });
    };

    const mouseout = () => {
      setTooltip({
        visible: false,
        content: "",
        x: 0,
        y: 0
      });
    };

    const getTooltipContent = (point: TimeSeriesDataPoint): string => {
      if (!point) return "";

      // Join with table data by event_id; datetime comes pre-formatted in local time (datetimeLocal)
      const tableData = tabledata();
      const tableRow = tableData.find((row: any) => row.event_id === point.event_id);
      let dateString = "N/A";
      let timeString = "N/A";
      if (tableRow?.datetimeLocal) {
        const parts = tableRow.datetimeLocal.split(" ");
        dateString = parts[0] ?? "N/A";
        timeString = parts[1] ?? "N/A";
      }

      const isFleet = point.source_name != null && String(point.source_name).trim() !== "";
      const useTimeForX = mode_x();
      const xVal = useTimeForX ? point.time : ((point as any).bsp ?? 0);
      // X is always displayed as seconds (float), not formatted as date/time
      const xDisplay = typeof xVal === "number" && !isNaN(xVal)
        ? String(parseFloat(xVal.toFixed(2)))
        : String(xVal);
      const yVal = (point as any)[channel];
      const yNum = typeof yVal === "number" ? yVal : parseFloat(String(yVal || 0));
      const yDisplay = !isNaN(yNum) ? (Math.round(yNum * 10) / 10).toFixed(1) : String(yVal ?? "");

      let tooltipRows = `
              <tr><td>DATE</td><td>${dateString}</td></tr>
              <tr><td>TIME</td><td>${timeString}</td></tr>`;
      if (isFleet) {
        tooltipRows += `
              <tr><td>SOURCE</td><td>${String(point.source_name)}</td></tr>`;
      }
      tooltipRows += `
              <tr><td>TIME (SEC)</td><td>${xDisplay}</td></tr>
              <tr><td>${String(channel || "").toUpperCase()}</td><td>${yDisplay}</td></tr>`;

      return `<table class='table-striped'>${tooltipRows}</table>`;
    };
    
    const click = function(event: MouseEvent, d: { eventId: number; firstPoint: TimeSeriesDataPoint; points: TimeSeriesDataPoint[] } | TimeSeriesDataPoint[] | TimeSeriesDataPoint) {
      event.stopPropagation();
      
      let id: number | undefined;
      if (d && typeof d === 'object' && 'eventId' in d) {
        id = (d as { eventId?: number }).eventId;
      } else if (d && typeof d === 'object' && 'firstPoint' in d && d.firstPoint && d.firstPoint.event_id !== undefined) {
        id = d.firstPoint.event_id;
      } else if (Array.isArray(d) && d[0] && d[0].event_id !== undefined) {
        id = d[0].event_id;
      } else if (d && typeof d === 'object' && 'event_id' in d) {
        id = (d as TimeSeriesDataPoint).event_id;
      }
      
      if (id === undefined || id === null) {
        return;
      }
      
      let newSelectedEvents: number[] = [];
      setSelectedEvents((prev) => {
        if (prev.includes(id)) {
          newSelectedEvents = prev.filter((e) => e !== id);
        } else {
          newSelectedEvents = [...prev, id];
        }
        return newSelectedEvents;
      });

      setTriggerSelection(true)

      // Use the new state to determine hasSelection
      if (newSelectedEvents.length > 0) {
        setHasSelection(true);
      } else {
        // Don't clear hasSelection when the other panel has a brush selection (e.g. map timeseries brushed in split view)
        const hasBrushRange = selectedRange() && selectedRange().length > 0;
        if (!hasBrushRange) {
          setHasSelection(false);
          setSelection([]);
        }
      }
    };

    // DRAW CONTENT
    // Use curveCatmullRom for smoother interpolation - provides very smooth curves
    // Alpha of 0.5 gives a good balance between smoothness and following the data points
    const toLinePath = d3.line<TimeSeriesDataPoint>()
      .x(d => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)))
      .y(d => yScale((d as any)[channel] || 0))
      .curve(d3.curveCatmullRom.alpha(0.5)); // Smooth Catmull-Rom spline with moderate alpha
    
    function drawPaths() {
      chartbody.selectAll(".linePath").attr("d", d => {
        // Handle new format: d is a maneuver object with points array
        if (d && d.points && Array.isArray(d.points)) {
          return toLinePath(d.points);
        }
        // Fallback for old format (shouldn't happen but just in case)
        return toLinePath(d);
      });
    }

    if (collection !== undefined) {
      chartbody.select(".brush").call(brush.move, null);
      chartbody.selectAll(".linePath").remove();
      chartbody.selectAll(".linePath-outline").remove();
      chartbody.selectAll(".hover-circle").remove();
  
      const selectedPaths: ManeuverPathType[] = [];
      const nonSelectedPaths: ManeuverPathType[] = [];
      maneuverPathsFiltered.forEach((maneuver: ManeuverPathType) => {
        if (isEventSelected(maneuver.eventId)) {
          selectedPaths.push(maneuver);
        } else {
          nonSelectedPaths.push(maneuver);
        }
      });
      const orderedPaths = [...nonSelectedPaths, ...selectedPaths];
      
      const linePathsSelection = chartbody.selectAll(".linePath")
        .data(orderedPaths, (d: ManeuverPathType) => `${d.eventId}-${d.firstPoint.time}`);
  
      const selected = selectedEvents();
      const hasSelection = selected.length > 0;
      const hasMoreThan8Selections = selected.length > 8;
      
      linePathsSelection
        .enter()
        .append("path")
        .attr("class", (d: ManeuverPathType) => `linePath ${getClass(d.firstPoint)}`)
        .merge(linePathsSelection)
        .each(function(d: ManeuverPathType) {
          const node = this as SVGPathElement;
          const isSelected = hasSelection ? isEventSelected(d.eventId) : false;
          const isColoredBySource = color() === 'SOURCE';
          
          // Set stroke color
          let strokeColor: string;
          if (!hasSelection) {
            strokeColor = getColor(d.firstPoint);
          } else if (isColoredBySource) {
            strokeColor = isSelected ? getOriginalColor(d.firstPoint) : "lightgrey";
          } else if (hasMoreThan8Selections) {
            strokeColor = getOriginalColor(d.firstPoint);
          } else {
            strokeColor = isSelected ? getColor(d.firstPoint) : "lightgrey";
          }
          
          // Set stroke width
          const strokeWidth = !hasSelection ? 1 : (isSelected ? 3 : 0.5);
          
          // Set stroke opacity with !important and no transition for instant updates
          const strokeOpacity = !hasSelection ? 1 : (isSelected ? 1 : 0.5);
          
          node.style.setProperty("transition", "none", "important");
          node.style.setProperty("stroke", strokeColor, "important");
          node.style.setProperty("stroke-width", String(strokeWidth), "important");
          node.style.setProperty("stroke-opacity", String(strokeOpacity), "important");
        })
        .style("fill", "none")
        .style("pointer-events", "none") // Disable pointer events on path, circles will handle it
        .attr("transform", "translate(20, 0)")
        .attr("d", (d: ManeuverPathType) => toLinePath(d.points));
      
      // Remove any existing outlines (we don't want outlines for selected paths)
      chartbody.selectAll(".linePath-outline").remove();

      // Add invisible circles for hover detection and tooltips
      // Only attach mouse events if chart is visible
      chartbody.selectAll(".hover-circle").remove();
      if (isChartVisible) {
        orderedPaths.forEach((maneuver: ManeuverPathType) => {
          const eventKey = String(maneuver.eventId).replace(/[^a-zA-Z0-9_-]/g, "_");

          const circles = chartbody.selectAll(`.hover-circle-${eventKey}`)
            .data(maneuver.points);
          
          circles.enter()
            .append("circle")
            .attr("class", `hover-circle hover-circle-${eventKey}`)
            .merge(circles)
            .attr("cx", (d: TimeSeriesDataPoint) => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)) + 20) // Add 20 for transform offset
            .attr("cy", (d: TimeSeriesDataPoint) => yScale((d as any)[channel] || 0))
            .attr("r", 5) // Hover detection radius
            .style("fill", "transparent")
            .style("stroke", "none")
            .style("pointer-events", "all")
            .style("cursor", "pointer")
            .on("mouseover", (event: MouseEvent, d: TimeSeriesDataPoint) => mouseover(event, [d]))
            .on("mouseout", mouseout)
            .on("mousemove", (event: MouseEvent, d: TimeSeriesDataPoint) => mousemove(event, [d]))
            .on("click", (event: MouseEvent) => click(event, maneuver));
          
          circles.exit().remove();
        });
        
        // Store mouse handlers for this chart so they can be reattached when chart becomes visible again
        storedMouseHandlers.set(chartId, {
          mouseover: mouseover,
          mouseout: mouseout,
          mousemove: mousemove,
          click: click
        });
      } else {
        // Chart not visible - disable pointer events on paths
        chartbody.selectAll(".linePath")
          .style("pointer-events", "none");
      }
  
      linePathsSelection.exit().remove();
    }
  
    var idleTimeout
    function idled() { idleTimeout = null; }

    function updateChart(event) {
      const extent = event.selection; // Brush selection
  
      if (!extent) {
        if (!idleTimeout) {
            idleTimeout = setTimeout(idled, 150); // Idle timeout logic
        }

        // Reset scales to the full domain
        xScale.domain([minXValue, maxXValue]);
        yScale.domain([minYValue, maxYValue]);

        // Update axes
        xAxis.transition().duration(1000).call(d3.axisBottom(xScale).ticks(10));
        yAxis.transition().duration(1000).call(d3.axisLeft(yScale).ticks(4));

        setTooltip({
          visible: false,
          content: "",
          x: 0,
          y: 0
        });
      } else {
        const [[x0, y0], [x1, y1]] = extent;
        const minx = xScale.invert(x0);
        const maxx = xScale.invert(x1);
        const maxy = yScale.invert(y0);
        const miny = yScale.invert(y1);

        xScale.domain([minx, maxx]);
        yScale.domain([miny, maxy]);

        interface ManeuverPathBrush {
          eventId: number;
          points: TimeSeriesDataPoint[];
          firstPoint: TimeSeriesDataPoint;
        }
        const maneuversByEvent = new Map<number, TimeSeriesDataPoint[]>();
        collection.forEach(vals => {
          vals.forEach(d => {
            let inExtent = false;
            if (mode_x()) {
              inExtent = d.time > minx && d.time < maxx && (d as any)[channel] > miny && (d as any)[channel] < maxy;
            } else {
              inExtent = (d as any).bsp > minx && (d as any).bsp < maxx && (d as any)[channel] > miny && (d as any)[channel] < maxy;
            }
            if (inExtent) {
              const eventId = d.event_id;
              if (!maneuversByEvent.has(eventId)) {
                maneuversByEvent.set(eventId, []);
              }
              maneuversByEvent.get(eventId)!.push(d);
            }
          });
        });
        const maneuverPaths: ManeuverPathBrush[] = [];
        const useOutlierFilterBrush = channel === 'VMG_PERC';
        if (useOutlierFilterBrush) {
          const deltas: number[] = [];
          maneuversByEvent.forEach((points) => {
            for (let j = 1; j < points.length; j++) {
              const prevY = Number((points[j - 1] as any)[channel]);
              const currY = Number((points[j] as any)[channel]);
              if (Number.isFinite(prevY) && Number.isFinite(currY)) {
                deltas.push(Math.abs(currY - prevY));
              }
            }
          });
          const stepStd = deltas.length > 1 ? (d3.deviation(deltas) ?? 0) : 0;
          const stepThreshold = stepStd > 0 ? 2 * stepStd : Infinity;
          maneuversByEvent.forEach((points, eventId) => {
            points.sort((a: TimeSeriesDataPoint, b: TimeSeriesDataPoint) => a.time - b.time);
            const filteredPoints: TimeSeriesDataPoint[] = [];
            let prevPoint: TimeSeriesDataPoint | null = null;
            points.forEach(d => {
              const yVal = Number((d as any)[channel]);
              // Skip values > 140 for VMG_PERC
              if (yVal > 150) {
                return;
              }
              if (prevPoint === null) {
                filteredPoints.push(d);
                prevPoint = d;
              } else {
                const prevY = Number((prevPoint as any)[channel]);
                const step = Number.isFinite(prevY) && Number.isFinite(yVal) ? Math.abs(yVal - prevY) : 0;
                if (step > stepThreshold) {
                  prevPoint = d;
                  return;
                }
                filteredPoints.push(d);
                prevPoint = d;
              }
            });
            if (filteredPoints.length > 1 && eventId !== null && eventId !== undefined) {
              maneuverPaths.push({ eventId, points: filteredPoints, firstPoint: filteredPoints[0] });
            }
          });
        } else {
          maneuversByEvent.forEach((points, eventId) => {
            points.sort((a: TimeSeriesDataPoint, b: TimeSeriesDataPoint) => a.time - b.time);
            if (points.length > 1 && eventId !== null && eventId !== undefined) {
              maneuverPaths.push({ eventId, points: [...points], firstPoint: points[0] });
            }
          });
        }

        if (maneuverPaths.length > 0) {
          chartbody.select(".brush").call(brush.move, null);
          chartbody.selectAll(".linePath").remove();
          chartbody.selectAll(".linePath-outline").remove();
          chartbody.selectAll(".hover-circle").remove();

          const allXValues = maneuverPaths.flatMap(m => m.points.map(d => mode_x() ? d.time : ((d as any).bsp || 0)));
          const allYValues = maneuverPaths.flatMap(m => m.points.map(d => (d as any)[channel] || 0));
          const newMinX = d3.min(allXValues);
          const newMaxX = d3.max(allXValues);
          const newMinY = d3.min(allYValues);
          const newMaxY = d3.max(allYValues);
          xScale.domain([newMinX, newMaxX]);
          yScale.domain([newMinY, newMaxY]);
          xAxis.transition().duration(1000).call(d3.axisBottom(xScale).ticks(10));
          yAxis.transition().duration(1000).call(d3.axisLeft(yScale).ticks(4));

          const selectedPaths: ManeuverPathBrush[] = [];
          const nonSelectedPaths: ManeuverPathBrush[] = [];
          maneuverPaths.forEach(maneuver => {
            if (isEventSelected(maneuver.eventId)) {
              selectedPaths.push(maneuver);
            } else {
              nonSelectedPaths.push(maneuver);
            }
          });
          const orderedPaths = [...nonSelectedPaths, ...selectedPaths];
          const linePathsSelection = chartbody.selectAll(".linePath")
              .data(orderedPaths, (d: ManeuverPathBrush) => `${d.eventId}-${d.firstPoint.time}`);
          const hasSelection = selectedEvents().length > 0;
          
          linePathsSelection
              .enter()
              .append("path")
              .attr("class", (d: ManeuverPathBrush) => `linePath ${getClass(d.firstPoint)}`)
              .merge(linePathsSelection)
              .each(function(d: ManeuverPathBrush) {
                const node = this as SVGPathElement;
                const isSelected = hasSelection ? isEventSelected(d.eventId) : false;
                const isColoredBySource = color() === 'SOURCE';
                let strokeColor: string;
                if (!hasSelection) {
                  strokeColor = getColor(d.firstPoint);
                } else if (isColoredBySource) {
                  strokeColor = isSelected ? getOriginalColor(d.firstPoint) : "lightgrey";
                } else {
                  strokeColor = isSelected ? getColor(d.firstPoint) : "lightgrey";
                }
                const strokeWidth = !hasSelection ? 1 : (isSelected ? 3 : 0.5);
                const strokeOpacity = !hasSelection ? 1 : (isSelected ? 1 : 0.5);
                node.style.setProperty("transition", "none", "important");
                node.style.setProperty("stroke", strokeColor, "important");
                node.style.setProperty("stroke-width", String(strokeWidth), "important");
                node.style.setProperty("stroke-opacity", String(strokeOpacity), "important");
              })
              .style("fill", "none")
              .style("pointer-events", "none")
              .attr("transform", "translate(20, 0)")
              .attr("d", (d: ManeuverPathBrush) => toLinePath(d.points));
          chartbody.selectAll(".linePath-outline").remove();
          chartbody.selectAll(".hover-circle").remove();
          orderedPaths.forEach((maneuver: ManeuverPathBrush) => {
            const eventKey = String(maneuver.eventId).replace(/[^a-zA-Z0-9_-]/g, "_");
            const circles = chartbody.selectAll(`.hover-circle-${eventKey}`)
              .data(maneuver.points);
            circles.enter()
              .append("circle")
              .attr("class", `hover-circle hover-circle-${eventKey}`)
              .merge(circles)
              .attr("cx", (d: TimeSeriesDataPoint) => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)) + 20)
              .attr("cy", (d: TimeSeriesDataPoint) => yScale((d as any)[channel] || 0))
              .attr("r", 5)
              .style("fill", "transparent")
              .style("stroke", "none")
              .style("pointer-events", "all")
              .style("cursor", "pointer")
              .on("mouseover", (event: MouseEvent, d: TimeSeriesDataPoint) => mouseover(event, [d]))
              .on("mouseout", mouseout)
              .on("mousemove", (event: MouseEvent, d: TimeSeriesDataPoint) => mousemove(event, [d]))
              .on("click", (event: MouseEvent) => click(event, maneuver));
            circles.exit().remove();
          });
          linePathsSelection.exit().remove();
        }          
      }
    }
  
    function refreshChart(): void {
      if (!idleTimeout) {
        idleTimeout = setTimeout(idled, 150);
        return;
      }

      // Update the scales and redraw the axes
      yScale.domain([minYValue, maxYValue]);
      yAxis.transition().duration(1000).call(d3.axisLeft(yScale).ticks(4));

      xScale.domain([minXValue, maxXValue]);
      xAxis.transition().duration(1000).call(d3.axisBottom(xScale).ticks(10));

      if (collection !== undefined) {
        chartbody.select(".brush").call(brush.move, null);
        chartbody.selectAll(".linePath").remove();
        chartbody.selectAll(".linePath-outline").remove();
        chartbody.selectAll(".hover-circle").remove();

        interface ManeuverPathRefresh {
          eventId: number;
          points: TimeSeriesDataPoint[];
          firstPoint: TimeSeriesDataPoint;
        }
        const maneuversByEvent = new Map<number, TimeSeriesDataPoint[]>();
        collection.forEach(vals => {
          vals.forEach(d => {
            if (!d.event_id) return;
            const eventId = d.event_id;
            if (!maneuversByEvent.has(eventId)) {
              maneuversByEvent.set(eventId, []);
            }
            maneuversByEvent.get(eventId)!.push(d);
          });
        });
        const maneuverPaths: ManeuverPathRefresh[] = [];
        const useOutlierFilterRefresh = channel === 'VMG_PERC';
        if (useOutlierFilterRefresh) {
          const deltas: number[] = [];
          maneuversByEvent.forEach((points) => {
            for (let j = 1; j < points.length; j++) {
              const prevY = Number((points[j - 1] as any)[channel]);
              const currY = Number((points[j] as any)[channel]);
              if (Number.isFinite(prevY) && Number.isFinite(currY)) {
                deltas.push(Math.abs(currY - prevY));
              }
            }
          });
          const stepStd = deltas.length > 1 ? (d3.deviation(deltas) ?? 0) : 0;
          const stepThreshold = stepStd > 0 ? 2 * stepStd : Infinity;
          maneuversByEvent.forEach((points, eventId) => {
            points.sort((a: TimeSeriesDataPoint, b: TimeSeriesDataPoint) => a.time - b.time);
            const filteredPoints: TimeSeriesDataPoint[] = [];
            let prevPoint: TimeSeriesDataPoint | null = null;
            points.forEach(d => {
              const yVal = Number((d as any)[channel]);
              // Skip values > 140 for VMG_PERC
              if (yVal > 140) {
                return;
              }
              if (prevPoint === null) {
                filteredPoints.push(d);
                prevPoint = d;
              } else {
                const prevY = Number((prevPoint as any)[channel]);
                const step = Number.isFinite(prevY) && Number.isFinite(yVal) ? Math.abs(yVal - prevY) : 0;
                if (step > stepThreshold) {
                  prevPoint = d;
                  return;
                }
                filteredPoints.push(d);
                prevPoint = d;
              }
            });
            if (filteredPoints.length > 1 && eventId !== null && eventId !== undefined) {
              maneuverPaths.push({ eventId, points: filteredPoints, firstPoint: filteredPoints[0] });
            }
          });
        } else {
          maneuversByEvent.forEach((points, eventId) => {
            points.sort((a: TimeSeriesDataPoint, b: TimeSeriesDataPoint) => a.time - b.time);
            if (points.length > 1 && eventId !== null && eventId !== undefined) {
              maneuverPaths.push({ eventId, points: [...points], firstPoint: points[0] });
            }
          });
        }
    
        const selectedPaths: ManeuverPathRefresh[] = [];
        const nonSelectedPaths: ManeuverPathRefresh[] = [];
        maneuverPaths.forEach(maneuver => {
          if (isEventSelected(maneuver.eventId)) {
            selectedPaths.push(maneuver);
          } else {
            nonSelectedPaths.push(maneuver);
          }
        });
        const orderedPaths = [...nonSelectedPaths, ...selectedPaths];
        const linePathsSelection = chartbody.selectAll(".linePath")
          .data(orderedPaths, (d: ManeuverPathRefresh) => `${d.eventId}-${d.firstPoint.time}`);
        const hasSelection = selectedEvents().length > 0;
        
        linePathsSelection
          .enter()
          .append("path")
          .attr("class", (d: ManeuverPathRefresh) => `linePath ${getClass(d.firstPoint)}`)
          .merge(linePathsSelection)
          .each(function(d: ManeuverPathRefresh) {
            const node = this as SVGPathElement;
            const isSelected = hasSelection ? isEventSelected(d.eventId) : false;
            const isColoredBySource = color() === 'SOURCE';
            let strokeColor: string;
            if (!hasSelection) {
              strokeColor = getColor(d.firstPoint);
            } else if (isColoredBySource) {
              strokeColor = isSelected ? getOriginalColor(d.firstPoint) : "lightgrey";
            } else {
              strokeColor = isSelected ? getColor(d.firstPoint) : "lightgrey";
            }
            const strokeWidth = !hasSelection ? 1 : (isSelected ? 3 : 0.5);
            const strokeOpacity = !hasSelection ? 1 : (isSelected ? 1 : 0.5);
            node.style.setProperty("transition", "none", "important");
            node.style.setProperty("stroke", strokeColor, "important");
            node.style.setProperty("stroke-width", String(strokeWidth), "important");
            node.style.setProperty("stroke-opacity", String(strokeOpacity), "important");
          })
          .style("fill", "none")
          .style("pointer-events", "none")
          .attr("transform", "translate(20, 0)")
          .attr("d", (d: ManeuverPathRefresh) => toLinePath(d.points));
        chartbody.selectAll(".linePath-outline").remove();
        chartbody.selectAll(".hover-circle").remove();
        orderedPaths.forEach((maneuver: ManeuverPathRefresh) => {
          const eventKey = String(maneuver.eventId).replace(/[^a-zA-Z0-9_-]/g, "_");
          const circles = chartbody.selectAll(`.hover-circle-${eventKey}`)
            .data(maneuver.points);
          circles.enter()
            .append("circle")
            .attr("class", `hover-circle hover-circle-${eventKey}`)
            .merge(circles)
            .attr("cx", (d: TimeSeriesDataPoint) => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)) + 20)
            .attr("cy", (d: TimeSeriesDataPoint) => yScale((d as any)[channel] || 0))
            .attr("r", 5)
            .style("fill", "transparent")
            .style("stroke", "none")
            .style("pointer-events", "all")
            .style("cursor", "pointer")
            .on("mouseover", (event: MouseEvent, d: TimeSeriesDataPoint) => mouseover(event, [d]))
            .on("mouseout", mouseout)
            .on("mousemove", (event: MouseEvent, d: TimeSeriesDataPoint) => mousemove(event, [d]))
            .on("click", (event: MouseEvent) => click(event, maneuver));
          circles.exit().remove();
        });
        linePathsSelection.exit().remove();
        drawPaths();
      }
    }

    drawPaths()
  }

  function updateSelection() {
    updateMinMaxRanges()

    // Cache expensive computations
    const selected = selectedEvents();
    const selectedSet = new Set(selected);
    const hasSelection = selected.length > 0;
    const hasMoreThan8Selections = selected.length > 8;
    const isColoredBySource = color() === 'SOURCE';
    const darkMode = isDark();

    // Batch DOM updates using requestAnimationFrame for better performance
    requestAnimationFrame(() => {
      let charts = document.getElementsByClassName("ts");

      if (hasSelection) {
        for (let i = 1; i < charts.length + 1; i++) {
          const chartBody = d3.select("#plots").select("#ts"+i).select("#body"+i);
          if (chartBody.empty()) continue;
          
          // Get all lines at once instead of filtering twice
          const allLines = chartBody.selectAll(".linePath");
          
          // Batch style updates using D3's selection methods
          allLines.each(function (d: any) {
            const node = this as SVGPathElement;
            const maneuver = d as { eventId?: number; firstPoint?: TimeSeriesDataPoint; points?: TimeSeriesDataPoint[] };
            const eventId = maneuver?.eventId ?? (maneuver?.firstPoint?.event_id ?? null);
            
            if (!node || eventId === null) return;
            
            const isSelected = selectedSet.has(eventId);
            const firstPoint = maneuver.firstPoint || (maneuver.points && maneuver.points[0]) || null;
            
            if (!firstPoint) return;
            
            if (isSelected) {
              // Selected line styling
              let strokeColor: string;
              
              if (isColoredBySource) {
                strokeColor = getOriginalColor(firstPoint);
              } else if (hasMoreThan8Selections) {
                strokeColor = getOriginalColor(firstPoint);
              } else {
                strokeColor = getIndexColor(selected, firstPoint.event_id) || getOriginalColor(firstPoint);
              }
              
              // Batch style updates - no transition for instant opacity changes
              node.style.setProperty("transition", "none", "important");
              node.style.setProperty("stroke", strokeColor, "important");
              node.style.setProperty("stroke-width", "3", "important");
              node.style.setProperty("stroke-opacity", "1", "important");
            } else {
              // Unselected line styling
              if (hasMoreThan8Selections) {
                node.style.setProperty("stroke", getOriginalColor(firstPoint), "important");
              } else {
                node.style.setProperty("stroke", "lightgrey", "important");
              }
              node.style.setProperty("transition", "none", "important");
              node.style.setProperty("stroke-width", "0.5", "important");
              node.style.setProperty("stroke-opacity", "0.2", "important");
            }
            
            // Remove outline if it exists (only check once)
            const outline = (node.parentNode as Element | null)?.querySelector(`.linePath-outline[data-event-id="${eventId}"]`);
            if (outline) {
              outline.remove();
            }
          });
        }
      } else {
        // No selection - restore original colors
        for (let i = 1; i < charts.length + 1; i++) {
          const chartBody = d3.select("#plots").select("#ts"+i).select("#body"+i);
          if (chartBody.empty()) continue;
          
          const allLines = chartBody.selectAll(".linePath");
          
          allLines.each(function (d: any) {
            const node = this as SVGPathElement;
            const maneuver = d as { eventId?: number; firstPoint?: TimeSeriesDataPoint; points?: TimeSeriesDataPoint[] };
            const eventId = maneuver?.eventId ?? (maneuver?.firstPoint?.event_id ?? null);
            const firstPoint = maneuver?.firstPoint ?? (maneuver?.points && maneuver.points[0]) ?? null;
            
            if (!node) return;
            
            if (firstPoint) {
              node.style.setProperty("transition", "none", "important");
              node.style.setProperty("stroke", getColor(firstPoint), "important");
              node.style.setProperty("stroke-width", "1", "important");
              node.style.setProperty("stroke-opacity", "1", "important");
            }
            
            if (eventId != null) {
              const outline = (node.parentNode as Element | null)?.querySelector(`.linePath-outline[data-event-id="${eventId}"]`);
              if (outline) outline.remove();
            }
          });
        }
      }

      setTriggerSelection(false);
      
      if (hasSelection) {
        setHasSelection(true);
      } else {
        // Don't clear hasSelection when the other panel has a brush selection (e.g. map timeseries brushed in split view)
        const hasBrushRange = selectedRange() && selectedRange().length > 0;
        if (!hasBrushRange) {
          setHasSelection(false);
          setSelection([]);
        }
      }
    });
  }

  // Function to perform the GRADE update
  const performGradeUpdate = async (gradeValue: number, selected: number[]): Promise<void> => {
    // Get required values from persistent store
    const { selectedClassName, selectedProjectId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (!className || !projectId) {
      logError('Cannot update GRADE: missing class_name or project_id');
      return;
    }
    
    // Get current event type for maneuvers (TACK, GYBE, etc.)
    const currentEventType = eventType();
    const eventTypes = currentEventType ? [currentEventType] : ['TACK', 'GYBE', 'BEARAWAY', 'ROUNDUP']; // Fallback to common maneuver types
    
    try {
      // Call admin API to update GRADE for selected events
      const response = await putData(`${apiEndpoints.admin.events}/tags`, {
        class_name: className,
        project_id: projectId,
        events: selected,
        event_types: eventTypes,
        key: 'GRADE',
        value: gradeValue
      });
      
      if (response.success) {
        debug(`Successfully updated GRADE to ${gradeValue} for ${selected.length} event(s)`);
        
        // Grade update in HuniDB will be implemented when available
        // Currently grade updates are handled on next data fetch
        
        // Update grade filter to include the newly graded value
        const currentGrades = selectedGradesManeuvers();
        const gradeValueStr = String(gradeValue);
        if (!currentGrades.includes(gradeValueStr)) {
          setSelectedGradesManeuvers([...currentGrades, gradeValueStr]);
          debug(`Added grade ${gradeValue} to selectedGrades filter`);
        }
        
        // Trigger parent component to refetch data
        if (props.onDataUpdate && typeof props.onDataUpdate === 'function') {
          props.onDataUpdate();
        } else {
          // Fallback: trigger update
          setTriggerUpdate(true);
        }
      } else {
        logError('Failed to update GRADE:', response.message || 'Unknown error');
      }
    } catch (error: any) {
      logError('Error updating GRADE:', error);
    }
  };

  // Function to calculate and set container height
  const updateContainerHeight = () => {
    if (!containerRef) return;
    
    // Find the media-container parent that has the scale transform
    let parent = containerRef.parentElement;
    let mediaContainer: HTMLElement | null = null;
    while (parent) {
      if (parent.id === 'media-container') {
        mediaContainer = parent;
        break;
      }
      parent = parent.parentElement;
    }
    
    // Get the scale factor from CSS custom property or calculate from transform
    let scaleFactor = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')) || 1;
    
    // If we found the media-container, try to get scale from its computed transform
    if (mediaContainer) {
      const transform = getComputedStyle(mediaContainer).transform;
      if (transform && transform !== 'none') {
        // Parse matrix scale: matrix(scaleX, skewY, skewX, scaleY, translateX, translateY)
        const matrix = transform.match(/matrix\(([^)]+)\)/);
        if (matrix) {
          const values = matrix[1].split(',').map(v => parseFloat(v.trim()));
          if (values.length >= 4) {
            // scaleX is the first value in the matrix
            scaleFactor = values[0];
          }
        }
      }
    }
    
    // Get the legend element to account for its height
    const legendElement = document.getElementById('maneuver-legend-timeseries');
    const legendHeight = legendElement ? legendElement.getBoundingClientRect().height : 50; // Default to 50px if not found
    
    // In split view use the same height logic as fullscreen: fill the available space (match setupMediaContainerScaling formula)
    const splitPanel = mediaContainer?.closest('.split-panel') as HTMLElement | null;
    const headerHeight = 60; // Account for header (only in fullscreen); matches maneuvers-page reserve in global.ts
    const padding = 20; // Some padding for spacing
    let availableViewportHeight: number;
    if (splitPanel) {
      // Use panel height minus 60px reserve (same as setupMediaContainerScaling for maneuvers-page) so we fill the panel regardless of timing
      availableViewportHeight = Math.max(200, splitPanel.clientHeight - 60);
    } else {
      availableViewportHeight = window.innerHeight;
    }
    const effectiveHeaderHeight = splitPanel ? 0 : headerHeight;
    const desiredVisibleHeight = availableViewportHeight - effectiveHeaderHeight - legendHeight - padding;
    
    // When content is scaled down, we need MORE layout height to achieve the desired visible height
    // Formula: layoutHeight = desiredVisibleHeight / scaleFactor
    const layoutHeight = desiredVisibleHeight / scaleFactor;
    
    // Debug logging
    debug('Height calculation:', {
      windowInnerHeight: window.innerHeight,
      scaleFactorFromCSS: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')) || 1,
      scaleFactorFromTransform: scaleFactor,
      headerHeight,
      legendHeight,
      padding,
      desiredVisibleHeight,
      layoutHeight,
      finalHeight: Math.max(400, layoutHeight),
      containerStyleHeight: containerRef.style.height,
      containerComputedHeight: getComputedStyle(containerRef).height
    });
    
    // Set height to fill available space (use !important to override CSS)
    const heightValue = `${Math.max(400, layoutHeight)}px`;
    containerRef.style.setProperty('height', heightValue, 'important');
    containerRef.style.setProperty('max-height', heightValue, 'important');
    
    // Also ensure the parent #timeseries-area can accommodate this height
    const timeseriesArea = document.getElementById('timeseries-area');
    if (timeseriesArea) {
      // Set min-height to ensure it can accommodate the child
      timeseriesArea.style.setProperty('min-height', heightValue, 'important');
      timeseriesArea.style.setProperty('height', 'auto', 'important');
    }
    
    // Verify what was actually rendered (this will be the scaled height)
    setTimeout(() => {
      const actualHeight = containerRef?.getBoundingClientRect().height;
      const computedHeight = containerRef ? getComputedStyle(containerRef).height : 'N/A';
      const timeseriesAreaHeight = timeseriesArea ? timeseriesArea.getBoundingClientRect().height : 'N/A';
      debug('Actual rendered height (scaled):', actualHeight);
      debug('Computed style height:', computedHeight);
      debug('Timeseries area height (scaled):', timeseriesAreaHeight);
    }, 100);
  };

  onMount(() => {
    const cleanupFns: (() => void)[] = [];
    updateTimeSeries();

    // Calculate and set container height
    setTimeout(() => {
      updateContainerHeight();
    }, 100);

    // Set up resize observer for responsive charts
    const resizeObserver = new ResizeObserver(() => {
      if (tsdata().length > 0) {
        buildTimeSeries(tsdata());
      }
      // Update container height on resize
      updateContainerHeight();
    });

    // Window resize handler as fallback
    const handleWindowResize = () => {
      if (tsdata().length > 0) {
        buildTimeSeries(tsdata());
      }
      // Update container height on window resize
      updateContainerHeight();
    };

    // Use setTimeout to ensure containerRef is available
    setTimeout(() => {
      if (containerRef) {
        resizeObserver.observe(containerRef);
      }
      // In split view the panel may not have final size yet; observe the split panel so height updates when panel is sized or resized
      const panel = containerRef?.closest('.split-panel') as HTMLElement | null;
      if (panel) {
        resizeObserver.observe(panel);
        // Delayed recalc so we run after layout and setupMediaContainerScaling; 1000ms catches late layout in split view
        const t1 = setTimeout(updateContainerHeight, 300);
        const t2 = setTimeout(updateContainerHeight, 600);
        const t3 = setTimeout(updateContainerHeight, 1000);
        cleanupFns.push(() => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); });
        cleanupFns.push(() => { if (panel) resizeObserver.unobserve(panel); });
      }
    }, 100);

    // Add window resize listener
    window.addEventListener('resize', handleWindowResize);
    
    // Add keyboard listener for GRADE updates (0-5 keys)
    const handleKeyPress = (event: KeyboardEvent) => {
      try {
        // Don't trigger if user is typing in an input field or textarea
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        
        // Only handle if there are selected events
        const selected = selectedEvents();
        if (!selected || selected.length === 0) {
          return;
        }
        
        // Check if key is 0, 1, 2, 3, 4, or 5
        const key = event.key;
        if (!['0', '1', '2', '3', '4', '5'].includes(key)) {
          return;
        }
        
        // Check if user is NOT a reader (readers cannot grade)
        const currentUser = user();
        if (!currentUser) {
          return;
        }
        
        // Superusers can always grade
        if (currentUser.is_super_user) {
          // Allow grading
        } else {
          // Check if user is a reader - readers cannot grade
          const userPermissions = currentUser.permissions;
          let isReader = false;
          
          if (typeof userPermissions === 'string') {
            isReader = userPermissions === 'reader';
          } else if (typeof userPermissions === 'object' && userPermissions !== null) {
            const permissionValues = Object.values(userPermissions);
            // User is a reader if ALL their permissions are 'reader'
            isReader = permissionValues.length > 0 && permissionValues.every(p => p === 'reader');
          }
          
          if (isReader) {
            return; // Readers cannot grade
          }
        }
        
        // Prevent default behavior and stop propagation
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        
        // Get the grade value from the key
        const gradeValue = parseInt(key, 10);
        
        // Show confirmation dialog before proceeding
        const message = `Are you sure you want to update GRADE to ${gradeValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;
        
        // Use window.confirm - it automatically closes when user clicks OK or Cancel
        const confirmed = window.confirm(message);
        if (!confirmed) {
          // User cancelled - dialog is already closed
          return;
        }
        
        // User confirmed - proceed with the update
        // Call asynchronously to avoid blocking the keydown handler
        setTimeout(() => {
          performGradeUpdate(gradeValue, selected).catch(error => {
            logError('Error in performGradeUpdate:', error);
          });
        }, 0);
      } catch (error: any) {
        logError('Error in handleKeyPress:', error);
        event.preventDefault();
        event.stopPropagation();
      }
    };
    
    window.addEventListener('keydown', handleKeyPress);
    
    onCleanup(() => {
      // Clean up D3 selections and SVG elements
      try {
        d3.select("#plots").selectAll("*").remove();
      } catch (error) {
        logError('TimeSeries: Error cleaning up D3 selections:', error);
      }
      
      // Clear arrays to free memory
      timeArray = [];
      valArray = [];
      eidArray = [];

      cleanupFns.forEach((fn) => fn());
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('keydown', handleKeyPress);

      // Clear any pending selection updates
      if (selectionUpdateTimeout) {
        clearTimeout(selectionUpdateTimeout);
        selectionUpdateTimeout = null;
      }
      
      // Clean up IntersectionObservers
      intersectionObservers.forEach((observer) => {
        observer.disconnect();
      });
      intersectionObservers.clear();
      storedMouseHandlers.clear();
      
      // Clear data to free memory
      setTsData([]);
      setChartVisibility(new Map());
      
      debug('TimeSeries: Cleanup complete - all resources cleared');
    });
  });

  const updateTimeSeries = () => {
    setLoading(true);
    fetchData().then((data) => {
      // buildTimeSeries will use charts from timeseries data if available
      buildTimeSeries(data);
      setFirstLoad(false)
      setTimeout(() => {
        setLoading(false);
        // Ensure selection colors are applied after initial render
        // This is important when switching from Scatter to TimeSeries
        if (selectedEvents().length > 0 && tsdata().length > 0) {
          updateSelection();
        }
      }, 500);
    });
  };

  createEffect(() => {
    if (triggerUpdate()) {
      setTriggerUpdate(false);
      // Defer so filtered() is committed before we read it (avoids race with setFiltered in applyFilters)
      queueMicrotask(() => {
        updateTimeSeries();
      });
    }
  });

  // Watch for filtered data changes - update timeseries when data becomes available
  // This serves as a backup in case triggerUpdate doesn't fire or gets cleared
  // Use debouncing to handle rapid re-renders during initial load
  let lastFilteredCount = 0;
  let lastFilteredHash = '';
  let filteredUpdateTimeout: NodeJS.Timeout | null = null;
  createEffect(() => {
    const currentFiltered = filtered();
    const currentFilteredCount = currentFiltered?.length || 0;
    const hasTriggerUpdate = untrack(() => triggerUpdate());
    
    // Build a stable hash: support both number[] (event IDs) and object[] (ManeuverData with event_id)
    const getHash = (arr: unknown[]) => {
      if (!Array.isArray(arr) || arr.length === 0) return '';
      const ids = typeof arr[0] === 'number'
        ? (arr as number[]).slice(0, 10)
        : (arr as { event_id?: number }[]).slice(0, 10).map((o) => o?.event_id);
      return ids.join(',') + `_${arr.length}`;
    };
    const filteredHash = getHash(Array.isArray(currentFiltered) ? currentFiltered : []);
    
    // Clear any pending timeout
    if (filteredUpdateTimeout) {
      clearTimeout(filteredUpdateTimeout);
      filteredUpdateTimeout = null;
    }
    
    // Reset when filtered data is cleared
    if (currentFilteredCount === 0) {
      lastFilteredCount = 0;
      lastFilteredHash = '';
      return;
    }
    
    // Transition from empty to non-empty: always schedule load (handles cross-window sync / initial load race)
    const justGotData = lastFilteredCount === 0 && currentFilteredCount > 0;
    const dataChanged = filteredHash !== lastFilteredHash || justGotData;
    
    if (currentFilteredCount > 0 && dataChanged && !hasTriggerUpdate) {
      const delay = justGotData ? 50 : 100; // Shorter delay when we first get data so timeseries loads promptly
      filteredUpdateTimeout = setTimeout(() => {
        const stillHasTrigger = untrack(() => triggerUpdate());
        const currentHash = getHash(Array.isArray(filtered()) ? filtered() : []);
        const shouldUpdate =
          !stillHasTrigger &&
          (currentHash !== lastFilteredHash || justGotData) &&
          currentHash.length > 0;
        if (shouldUpdate) {
          updateTimeSeries();
          lastFilteredHash = currentHash;
        }
        filteredUpdateTimeout = null;
      }, delay);
    }
    
    lastFilteredCount = currentFilteredCount;
    if (filteredHash && !filteredUpdateTimeout) {
      lastFilteredHash = filteredHash;
    }
  });
  
  // Cleanup timeout on unmount
  onCleanup(() => {
    if (filteredUpdateTimeout) {
      clearTimeout(filteredUpdateTimeout);
      filteredUpdateTimeout = null;
    }
  });

  // Watch for description or phase changes to refetch data
  // Charts will be included in the timeseries data response
  createEffect(on([() => props?.description, phase], () => {
    // Only refetch if we have data loaded (not on initial mount)
    // The triggerUpdate mechanism from handleDescription should handle most cases,
    // but this provides a backup to ensure data refreshes when props change
    // Use untrack to prevent tsdata() from making this effect reactive to data changes
    if (untrack(() => !firstload() && tsdata().length > 0)) {
      updateTimeSeries();
    }
  }));

  createEffect(() => {
    if (triggerSelection()) {
      updateSelection()
    }
  });

  // Watch for selectedEvents changes (from cross-window sync) and update selection
  // Use debouncing to prevent rapid updates during legend selection
  let selectionUpdateTimeout: NodeJS.Timeout | null = null;
  createEffect(() => {
    // Access selectedEvents to trigger effect when it changes
    selectedEvents();
    
    // Update selection when selectedEvents changes (handles cross-window sync and local clicks)
    // Only update if component is ready (data loaded)
    if (tsdata().length > 0) {
      // Clear any pending update
      if (selectionUpdateTimeout) {
        clearTimeout(selectionUpdateTimeout);
      }
      
      // Debounce updates to batch rapid changes (e.g., when clicking multiple legend items)
      selectionUpdateTimeout = setTimeout(() => {
        updateSelection();
        selectionUpdateTimeout = null;
      }, 50); // 50ms debounce - fast enough to feel responsive, slow enough to batch updates
    }
  });

  // Watch for color changes - update selection when color changes
  // This ensures the maneuver window updates when color changes in the main window
  createEffect(() => {
    const currentColor = color();
    
    // Update selection when color changes and component is ready (data loaded)
    if (tsdata().length > 0) {
      // Use untrack to prevent updateSelection from creating reactive dependencies
      untrack(() => {
        updateSelection();
      });
    }
  });

  // Get groups and color scale for legend - extract from tsdata
  const getLegendGroups = createMemo(() => {
    const data = tsdata();
    if (!data || data.length === 0) return { groups: [], colorScale: null };
    
    // Flatten tsdata (array of arrays) to get data points
    const flatData = data.map(item => item[0]).filter(d => d);
    if (flatData.length === 0) return { groups: [], colorScale: null };
    
    const currentColor = String(color() || 'TWS').toUpperCase();
    
    // Access sourcesStore to make memo reactive to source changes (for SOURCE coloring)
    if (currentColor === 'SOURCE') {
      sourcesStore.sources();
      sourcesStore.isReady();
    }
    
    let groups: Array<{ name: string; color: string }> = [];
    let colorScale: any = null;
    
    if (currentColor === 'TWS') {
      const uniques = groupBy(flatData, 'tws_bin');
      uniques.sort((a, b) => Number(a) - Number(b));
      colorScale = d3.scaleThreshold().domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]).range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"]);
      groups = uniques.map(tws => ({
        name: String(tws),
        color: String(colorScale ? colorScale(Number(tws)) : 'grey')
      }));
    } else if (currentColor === 'VMG') {
      const vmgValues = flatData.map(d => parseFloat(d.vmg_perc_avg)).filter(v => !isNaN(v) && v !== null && v !== undefined);
      if (vmgValues.length > 0) {
        const min = Math.min(...vmgValues);
        const max = Math.max(...vmgValues);
        if (min !== max) {
          const intervalSize = (max - min) / 5;
          const intervalGroups: string[] = [];
          for (let i = 0; i < 5; i++) {
            const intervalMin = min + (i * intervalSize);
            const intervalMax = i === 4 ? max : min + ((i + 1) * intervalSize);
            intervalGroups.push(`${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`);
          }
          // @ts-ignore - D3 scaleLinear accepts string ranges for color scales
          colorScale = d3.scaleLinear().domain([min, (min + max) / 2, max]).range(["blue","lightgrey","red"]);
          groups = intervalGroups.map(interval => {
          const intervalMin = parseFloat(interval.split('-')[0]);
          return {
            name: interval,
            color: String(colorScale(String(intervalMin)))
          };
          });
        }
      }
    } else if (currentColor === 'TACK') {
      const uniques = groupBy(flatData, 'tack');
      groups = uniques.map(tack => ({
        name: String(tack),
        color: (tack === 'PORT' || tack === 'P - S') ? '#d62728' : '#2ca02c'
      }));
    } else if (currentColor === 'RACE' || currentColor === 'SOURCE' || 
               currentColor === 'STATE' || currentColor === 'CONFIG') {
      const { groups: colorGroups, scale, getItemColor } = buildColorGrouping(flatData, currentColor);
      colorScale = scale;
      groups = colorGroups.map(group => {
        let itemColor = 'grey';
        if (getItemColor) {
          const dummyItem: any = {};
          if (currentColor === 'RACE') {
            dummyItem.race = group.key;
            dummyItem.Race_number = group.key;
          } else if (currentColor === 'SOURCE') {
            dummyItem.source_name = group.key;
          } else if (currentColor === 'STATE') {
            dummyItem.state = group.key;
            dummyItem.State = group.key;
          } else if (currentColor === 'CONFIG') {
            dummyItem.config = group.key;
            dummyItem.Config = group.key;
          }
          itemColor = getItemColor(dummyItem);
        }
        return {
          name: String(group.key),
          color: String(itemColor)
        };
      });
    }
    
    return { groups, colorScale };
  });

  return (
    <>
      {firstload() && <Loading />}
        <div class="time-series" ref={(el) => { containerRef = el; }} style={{
          "opacity": loading() ? 0.2 : 1, 
          "pointer-events": loading() ? "none" : "auto"
        }}>
        <ManeuverLegend
          elementId="maneuver-legend-timeseries"
          target_info={{}}
          groups={getLegendGroups().groups}
          colorScale={getLegendGroups().colorScale}
          color={color() || 'TWS'}
          click={props.onLegendClick}
        />
        <div id="plots" class="maneuver-time-series"></div>
      </div>
      <Portal mount={typeof document !== "undefined" ? document.body : undefined}>
        <div id="maneuver-timeseries-tooltip" class="tooltip" style={{
            opacity: tooltip().visible ? 1 : 0,
            left: `${tooltip().x}px`,
            top: `${tooltip().y}px`,
            position: "fixed",
            "pointer-events": "none",
            "z-index": 9999
          }} innerHTML={tooltip().content}>
        </div>
      </Portal>
    </>
  );
}
