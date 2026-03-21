import { createSignal, createEffect, onCleanup, onMount, untrack, on } from "solid-js";
import { Portal } from "solid-js/web";
import * as d3 from "d3";

import Loading from "../../utilities/Loading";

import { persistantStore } from "../../../store/persistantStore";

import { selectedGroupKeys, setSelectedGroupKeys, selectedEvents, triggerUpdate, setTriggerUpdate, triggerSelection, setTriggerSelection, isEventHidden } from "../../../store/selectionStore";
import { tooltip, setTooltip, eventType, filtered, color, phase, tabledata, groupDisplayMode } from "../../../store/globalStore";
import { selectedGradesManeuvers, setSelectedGradesManeuvers } from "../../../store/filterStore";

import { groupBy, myTickFormat, putData, round } from "../../../utils/global";
import { error as logError, debug } from "../../../utils/console";
import { fetchTimeSeriesData } from "../../../services/maneuversDataService";
import { buildColorGrouping, getGroupKeyFromItem, groupKeyEquals } from "../../../utils/colorGrouping";
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

      // Fetch timeseries data
      const timeseriesResponse = await fetchTimeSeriesData(context, {
        eventType: eventType(),
        description: descriptionStr,
        // Use the extracted event IDs as the explicit list for time series data
        eventList: eventIds
      });

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
      //defaultScale.domain([4, 8, 14, 18, 22])
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
        return "solid_line"
    } else {
        return "dash_line"
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
      if (d.tack === 'PORT' || d.tack === 'S - P') {
        return '#d62728';
      } else if (d.tack === 'STBD' || d.tack === 'P - S') {
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

  function groupByKeyName() {
    if (color() === 'TWS') return 'tws_bin';
    if (color() === 'TACK') return 'tack';
    if (color() === 'RACE') return 'race';
    if (color() === 'SOURCE') return 'source_name';
    if (color() === 'STATE') return 'State';
    if (color() === 'CONFIG') return 'Config';
    return 'tws_bin';
  }

  function groupAndAverageTS(collection: TimeSeriesDataPoint[][], groupKey: string, excludeKeys: string[] = []): TimeSeriesDataPoint[][] {
    /** IQR-based mean: treat 0 as missing when any non-zero present; fallback to simple mean if no inliers. */
    function averageExcludingOutliers(arr: number[]): number {
      if (arr.length === 0) return NaN;
      const nonZero = arr.filter(v => v !== 0 && v === v);
      const toAverage = nonZero.length > 0 ? nonZero : arr;
      if (toAverage.length <= 2) return toAverage.reduce((a, b) => a + b, 0) / toAverage.length;
      const sorted = [...toAverage].sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      const inliers = sorted.filter(v => v >= lower && v <= upper);
      if (inliers.length === 0) return toAverage.reduce((a, b) => a + b, 0) / toAverage.length;
      return inliers.reduce((a, b) => a + b, 0) / inliers.length;
    }

    type Bucket = {
      groupByValue: any;
      time: number;
      valuesByChannel: Record<string, number[]>;
      values: Record<string, any>;
      seriesIndices: Set<number>;
    };
    const grouped: Record<string, Bucket> = {};
    const isNumeric = (v: any): boolean => !isNaN(parseFloat(v)) && isFinite(v);
    const coll = collection || [];
    // How many series (events) have each groupValue — we only average a timestep when all are present.
    const expectedCountPerGroup = new Map<any, number>();
    coll.forEach((points) => {
      const gval = points[0]?.[groupKey as keyof TimeSeriesDataPoint];
      if (gval !== undefined) expectedCountPerGroup.set(gval, (expectedCountPerGroup.get(gval) ?? 0) + 1);
    });
    // Tag each point with its series index so we can count distinct series per bucket.
    const flat = coll.flatMap((points, seriesIndex) => points.map(p => ({ ...p, __seriesIndex: seriesIndex })));
    flat.forEach(pt => {
      const tNorm = parseFloat(Number(pt.time).toFixed(10));
      const gval = (pt as any)[groupKey];
      const key = `${gval}_${tNorm}`;

      if (!grouped[key]) {
        grouped[key] = { groupByValue: gval, time: tNorm, valuesByChannel: {}, values: {}, seriesIndices: new Set() };
      }
      const bucket = grouped[key];
      bucket.seriesIndices.add((pt as any).__seriesIndex);
      Object.keys(pt).forEach(k => {
        if (k === 'time' || k === groupKey || k === '__eventIndex' || k === '__seriesIndex') return;
        if (excludeKeys.includes(k)) {
          bucket.values[k] = (pt as any)[k];
          return;
        }
        const value = (pt as any)[k];
        if (isNumeric(value)) {
          const num = parseFloat(value);
          if (!bucket.valuesByChannel[k]) bucket.valuesByChannel[k] = [];
          bucket.valuesByChannel[k].push(num);
        } else {
          bucket.values[k] = value;
        }
      });
    });
    // Only include a timestep if every series in that group has a point (all points present).
    const expectedFor = (gv: any) => expectedCountPerGroup.get(gv) ?? 0;
    const averaged = Object.values(grouped)
      .filter(g => g.seriesIndices.size === expectedFor(g.groupByValue))
      .map(g => {
        const out: any = { [groupKey]: g.groupByValue, time: g.time };
        Object.keys(g.valuesByChannel).forEach(k => {
          if (excludeKeys.includes(k)) return;
          const arr = g.valuesByChannel[k];
          out[k] = round(arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN, 2);
        });
        Object.keys(g.values).forEach(k => { if (!excludeKeys.includes(k)) out[k] = g.values[k]; });
        return out as TimeSeriesDataPoint;
      });

    // Group by group value into arrays, sorted by time
    const byGroup = new Map<any, TimeSeriesDataPoint[]>();
    averaged.forEach(p => {
      const gv = (p as any)[groupKey];
      if (!byGroup.has(gv)) byGroup.set(gv, []);
      byGroup.get(gv)!.push(p);
    });
    byGroup.forEach(arr => arr.sort((a,b) => a.time - b.time));
    return Array.from(byGroup.values());
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
      // Always use grouped averaged collections (this component is only mounted when grouped is ON)
      const key = groupByKeyName();
      const mixMode = groupDisplayMode() === 'MIX';
      const individualCollections = mixMode ? data : null; // Keep raw data for MIX mode background
      const groupedCollections = groupAndAverageTS(data, key, ['event_id','tws_bin','vmg_bin','race','tack','source_name','State','Config']);

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
                
                // Update visibility state (functional update so we don't overwrite other charts' visibility)
                setChartVisibility(prev => {
                  const next = new Map(prev);
                  next.set(chartId, isVisible);
                  return next;
                });

                // Manual viewport check to verify actual visibility
                const rect = chartElement.getBoundingClientRect();
                const isActuallyVisible = rect && rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0;

                // Key fix: Render if EITHER IntersectionObserver says visible OR manual check says visible
                // This handles cases where observer hasn't fired yet or missed the chart
                if (isVisible || isActuallyVisible) {
                  const plot = d3.select(`#ts${c}`);
                  const hasBody = !plot.select("#body"+c).empty();
                  
                  if (!hasBody) {
                    // Chart needs to be rendered; pass true so hover circles added even if signal hasn't flushed
                    plot.append("g")
                      .attr("id", "body"+c)
                      .attr("transform", "translate(20, 5)");
                    const body = plot.select("#body"+c);
                    // Pass both collections to drawTimeSeries
                    drawTimeSeries(c - 1, body, groupedCollections, channel, true, individualCollections);
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
                // Use functional update so multiple charts don't overwrite each other's visibility
                setChartVisibility(prev => {
                  const next = new Map(prev);
                  next.set(chartId, true);
                  return next;
                });
                plot.append("g")
                  .attr("id", "body"+c)
                  .attr("transform", "translate(20, 5)");
                const body = plot.select("#body"+c);
                // Pass forceVisible so hover circles are added even if signal hasn't flushed yet
                // Pass both collections to drawTimeSeries
                drawTimeSeries(c - 1, body, groupedCollections, channel, true, individualCollections);
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

      // Translate tooltip 75px to the left of computed position (match standard)
      x -= 75;

      return { x, y };
    } catch (error) {
      logError('Error calculating tooltip position:', error);
      return { x: 0, y: 0 };
    }
  }

  function drawTimeSeries(index, chartbody, collection, channel, forceVisible?: boolean, individualCollection: any = null) {
    const chartId = `timeseries-chart-${channel}`;
    const mixMode = groupDisplayMode() === 'MIX';
    const hasIndividualCollection = mixMode && individualCollection !== null;
    
    let minXValue = 999999
    let maxXValue = -999999
    
    let minYValue = 999999
    let maxYValue = -999999

    // MIX mode: build outlier-filtered tracks (same as standard TimeSeries) for Y scale and drawing
    type IndividualPathItem = { pathKey: string; points: TimeSeriesDataPoint[]; firstPoint: TimeSeriesDataPoint };
    let individualPathsOutlierFiltered: IndividualPathItem[] | null = null;

    if (hasIndividualCollection && individualCollection != undefined) {
      // Replicate standard TimeSeries outlier removal: step deltas across all tracks, 2*std threshold
      const deltas: number[] = [];
      individualCollection.forEach((points: TimeSeriesDataPoint[]) => {
        const sorted = [...points].sort((a, b) => a.time - b.time);
        for (let j = 1; j < sorted.length; j++) {
          const prevY = Number((sorted[j - 1] as any)[channel]);
          const currY = Number((sorted[j] as any)[channel]);
          if (Number.isFinite(prevY) && Number.isFinite(currY)) {
            deltas.push(Math.abs(currY - prevY));
          }
        }
      });
      const stepStd = deltas.length > 1 ? (d3.deviation(deltas) ?? 0) : 0;
      const stepThreshold = stepStd > 0 ? 2 * stepStd : Infinity;
      const groupKey = groupByKeyName();
      const filtered: IndividualPathItem[] = [];
      individualCollection.forEach((vals: TimeSeriesDataPoint[], i: number) => {
        const points = [...vals].sort((a, b) => a.time - b.time);
        const filteredPoints: TimeSeriesDataPoint[] = [];
        let prevPoint: TimeSeriesDataPoint | null = null;
        points.forEach(d => {
          const yVal = Number((d as any)[channel]);
          if (prevPoint === null) {
            filteredPoints.push(d);
            prevPoint = d;
          } else {
            const seconds = Math.abs(prevPoint.time - d.time);
            const prevY = Number((prevPoint as any)[channel]);
            const step = Number.isFinite(prevY) && Number.isFinite(yVal) ? Math.abs(yVal - prevY) : 0;
            if (seconds >= 5) return;
            if (step > stepThreshold) {
              prevPoint = d;
              return;
            }
            filteredPoints.push(d);
            prevPoint = d;
          }
        });
        if (filteredPoints.length > 1) {
          const gv = (filteredPoints[0] as any)[groupKey];
          filtered.push({
            pathKey: `individual_${String(gv)}_${i}`,
            points: filteredPoints,
            firstPoint: filteredPoints[0]
          });
        }
      });
      individualPathsOutlierFiltered = filtered;
      // Y scale from outlier-filtered tracks
      if (individualPathsOutlierFiltered.length > 0) {
        minYValue = 999999;
        maxYValue = -999999;
        individualPathsOutlierFiltered.forEach((m) => {
          m.points.forEach((d) => {
            const yValNum = Number((d as any)[channel]);
            if (Number.isFinite(yValNum) && Math.abs(yValNum) > 0) {
              if (yValNum > maxYValue) maxYValue = yValNum;
              if (yValNum < minYValue) minYValue = yValNum;
            }
          });
        });
      }
    }

    // ON mode: Y-axis from grouped data
    if (!hasIndividualCollection && collection != undefined) {
      for (let i = 0; i < collection.length; i++) {
        const vals = collection[i];
        for (let j = 0; j < vals.length; j++) {
          const d = vals[j];
          const yVal = (d as any)[channel];
          const yValNum = typeof yVal === 'number' ? yVal : parseFloat(String(yVal || 0));
          if (Math.abs(yValNum) > 0) {
            if (yValNum > maxYValue) maxYValue = yValNum;
            if (yValNum < minYValue) minYValue = yValNum;
          }
        }
      }
    }
    // Fallback if no valid Y yet (e.g. empty filtered paths)
    if (minYValue === 999999 && collection != undefined) {
      for (let i = 0; i < collection.length; i++) {
        const vals = collection[i];
        for (let j = 0; j < vals.length; j++) {
          const d = vals[j];
          const yVal = (d as any)[channel];
          const yValNum = typeof yVal === 'number' ? yVal : parseFloat(String(yVal || 0));
          if (Math.abs(yValNum) > 0) {
            if (yValNum > maxYValue) maxYValue = yValNum;
            if (yValNum < minYValue) minYValue = yValNum;
          }
        }
      }
    }
  
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
      
      // Process collection for timeArr/valArr and X range (Y range already set above)
      for (let i = 0; i < collection.length; i++) {
        const vals = collection[i];
        for (let j = 0; j < vals.length; j++) {
          const d = vals[j];
          
          // Calculate X value
          const bspVal = (d as any).bsp || 0;
          const xVal = useTimeForX ? parseFloat(String(d.time)) : parseFloat(String(bspVal));
          if (xVal > maxXValue) maxXValue = xVal;
          if (xVal < minXValue) minXValue = xVal;

          // Get Y value (channel value)
          const yVal = (d as any)[channel];
          const yValNum = typeof yVal === 'number' ? yVal : parseFloat(String(yVal || 0));

          // Push to arrays
          timeArr.push(useTimeForX ? d.time : bspVal);
          valArr.push(yValNum);

          // Fill event ID array only once
          if (fill_eid) {
            eidArray.push(d.event_id);
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
  
    // Declare before brush so updateChart (called on brush "end") can use them without TDZ
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;
    function idled() { idleTimeout = null; }

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
    
    const click = function(event: MouseEvent, d: unknown) {
      event.stopPropagation();
      const maneuver = d as { firstPoint?: TimeSeriesDataPoint };
      const firstPoint = maneuver?.firstPoint;
      if (!firstPoint) return;
      const pathGroupKey = getGroupKeyFromItem(firstPoint, color());
      setSelectedGroupKeys((prev) =>
        prev.includes(pathGroupKey) ? prev.filter((k) => k !== pathGroupKey) : [...prev, pathGroupKey]
      );
      setTriggerSelection(true);
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
      chartbody.selectAll(".linePath-individual").remove();
      chartbody.selectAll(".linePath-outline").remove();
      chartbody.selectAll(".hover-circle").remove();
  
      interface ManeuverPath {
        eventId?: number;
        pathKey: string;
        points: TimeSeriesDataPoint[];
        firstPoint: TimeSeriesDataPoint;
      }
      let maneuverPaths: ManeuverPath[] = [];

      // MIX MODE: Draw individual tracks (outlier-filtered) if provided. ON mode: only grouped (individual already removed above).
      if (hasIndividualCollection && individualPathsOutlierFiltered != null && individualPathsOutlierFiltered.length > 0) {
        const individualPaths = individualPathsOutlierFiltered as ManeuverPath[];

        const hasGroupSelection = selectedGroupKeys().length > 0;
        const individualSelection = chartbody.selectAll(".linePath-individual")
          .data(individualPaths, (d: ManeuverPath) => d.pathKey);

        individualSelection
          .enter()
          .append("path")
          .attr("class", "linePath-individual")
          .merge(individualSelection)
          .each(function(d: ManeuverPath) {
            const node = this as SVGPathElement;
            const pathGroupKey = getGroupKeyFromItem(d.firstPoint, color());
            const isInSelectedGroup = hasGroupSelection && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
            const strokeColor = isInSelectedGroup ? getColor(d.firstPoint) : "lightgrey";
            node.style.setProperty("transition", "none", "important");
            node.style.setProperty("stroke", strokeColor, "important");
            node.style.setProperty("stroke-width", "0.5", "important");
            node.style.setProperty("stroke-opacity", "0.3", "important");
          })
          .style("fill", "none")
          .style("pointer-events", "none")
          .attr("transform", "translate(20, 0)")
          .attr("d", (d: ManeuverPath) => toLinePath(d.points));

        individualSelection.exit().remove();
      } else {
        // ON mode: ensure no individual tracks remain (e.g. after switching from MIX)
        chartbody.selectAll(".linePath-individual").remove();
      }

      // Now draw grouped tracks (always drawn)
      const groupKey = groupByKeyName();
      collection.forEach((vals: TimeSeriesDataPoint[], i: number) => {
        const points = [...vals].sort((a, b) => a.time - b.time);
        const filteredPoints: TimeSeriesDataPoint[] = [];
        let prevPoint: TimeSeriesDataPoint | null = null;
        points.forEach(d => {
          if (prevPoint === null) {
            filteredPoints.push(d);
            prevPoint = d;
          } else {
            const seconds = Math.abs(prevPoint.time - d.time);
            if (seconds < 5) {
              filteredPoints.push(d);
              prevPoint = d;
            }
          }
        });
        if (filteredPoints.length > 1) {
          const gv = (filteredPoints[0] as any)[groupKey];
          maneuverPaths.push({
            pathKey: `group_${String(gv)}_${i}`,
            points: filteredPoints,
            firstPoint: filteredPoints[0]
          });
        }
      });

      const orderedPaths = [...maneuverPaths];
      const linePathsSelection = chartbody.selectAll(".linePath")
        .data(orderedPaths, (d: ManeuverPath) => d.pathKey);

      const hasGroupSelection = selectedGroupKeys().length > 0;
      const mixModeDraw = groupDisplayMode() === 'MIX';
      
      linePathsSelection
        .enter()
        .append("path")
        .attr("class", "linePath solid_line")
        .merge(linePathsSelection)
        .each(function(d: ManeuverPath) {
          const node = this as SVGPathElement;
          const pathGroupKey = getGroupKeyFromItem(d.firstPoint, color());
          const isSelected = hasGroupSelection && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
          const strokeColor = isSelected ? getColor(d.firstPoint) : (hasGroupSelection ? (mixModeDraw ? getColor(d.firstPoint) : "lightgrey") : getColor(d.firstPoint));
          const strokeWidth = isSelected ? 3 : (hasGroupSelection ? 0.5 : 1);
          const strokeOpacity = isSelected ? 1 : (hasGroupSelection ? 0.2 : 1);
          node.style.setProperty("transition", "none", "important");
          node.style.setProperty("stroke", strokeColor, "important");
          node.style.setProperty("stroke-width", String(strokeWidth), "important");
          node.style.setProperty("stroke-opacity", String(strokeOpacity), "important");
        })
        .style("fill", "none")
        .style("pointer-events", "none")
        .attr("transform", "translate(20, 0)")
        .attr("d", (d: ManeuverPath) => toLinePath(d.points));
      
      // Remove any existing outlines (we don't want outlines for selected paths)
      chartbody.selectAll(".linePath-outline").remove();

      // Add invisible circles for hover detection and tooltips (only for grouped tracks)
      chartbody.selectAll(".hover-circle").remove();
      orderedPaths.forEach((maneuver: ManeuverPath) => {
        const pathGroupKey = getGroupKeyFromItem(maneuver.firstPoint, color());
        const isSelected = hasGroupSelection && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
        const noPointerEvents = mixModeDraw && !isSelected;
        // Use pathKey for CSS class/selectors (sanitized to avoid invalid selectors)
        const eventKey = String(maneuver.pathKey).replace(/[^a-zA-Z0-9_-]/g, "_");

        const circles = chartbody.selectAll(`.hover-circle-${eventKey}`)
          .data(maneuver.points);
        
        const circlesMerge = circles.enter()
          .append("circle")
          .attr("class", `hover-circle hover-circle-${eventKey}`)
          .merge(circles)
          .attr("cx", (d: TimeSeriesDataPoint) => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)) + 20) // Add 20 for transform offset
          .attr("cy", (d: TimeSeriesDataPoint) => yScale((d as any)[channel] || 0))
          .attr("r", 10) // Larger hit area for grouped (fewer lines); radius 10 = 20px diameter
          .style("fill", "transparent")
          .style("stroke", "none")
          .style("pointer-events", noPointerEvents ? "none" : "all")
          .style("cursor", noPointerEvents ? "default" : "pointer");
        if (!noPointerEvents) {
          circlesMerge
            .on("mouseover", (event: MouseEvent, d: TimeSeriesDataPoint) => mouseover(event, [d]))
            .on("mouseout", mouseout)
            .on("mousemove", (event: MouseEvent, d: TimeSeriesDataPoint) => mousemove(event, [d]))
            .on("click", (event: MouseEvent) => click(event, maneuver));
        } else {
          circlesMerge.on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
        }
        
        circles.exit().remove();
      });
      
      // Store mouse handlers for this chart so they can be reattached when chart becomes visible again
      storedMouseHandlers.set(chartId, {
        mouseover: mouseover,
        mouseout: mouseout,
        mousemove: mousemove,
        click: click
      });
  
      linePathsSelection.exit().remove();
    }

    function updateChart(event: d3.D3BrushEvent<unknown>) {
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
        // Extract brush extent and convert to domain ranges (extent is [[x0,y0],[x1,y1]] in pixels)
        const sel = extent as [[number, number], [number, number]];
        const [[x0, y0], [x1, y1]] = sel;
        const minx = xScale.invert(x0);
        const maxx = xScale.invert(x1);
        const maxy = yScale.invert(y0); // Note: y-invert is reversed because the origin is top-left
        const miny = yScale.invert(y1);

        // Update scales based on brush extent
        xScale.domain([minx, maxx]);
        yScale.domain([miny, maxy]);

        interface ManeuverPathBrush {
          eventId?: number;
          pathKey: string;
          points: TimeSeriesDataPoint[];
          firstPoint: TimeSeriesDataPoint;
        }
        let maneuverPaths: ManeuverPathBrush[] = [];

        // Grouped: filter each series by extent, one path per series
        const groupKey = groupByKeyName();
        collection.forEach((vals: TimeSeriesDataPoint[], i: number) => {
          const inExtent = (d: TimeSeriesDataPoint) => {
            if (mode_x()) {
              return d.time > minx && d.time < maxx && (d as any)[channel] > miny && (d as any)[channel] < maxy;
            }
            return (d as any).bsp > minx && (d as any).bsp < maxx && (d as any)[channel] > miny && (d as any)[channel] < maxy;
          };
          const points = vals.filter(inExtent).sort((a, b) => a.time - b.time);
          if (points.length > 1) {
            const gv = (points[0] as any)[groupKey];
            maneuverPaths.push({
              pathKey: `group_${String(gv)}_${i}`,
              points,
              firstPoint: points[0]
            });
          }
        });

        if (maneuverPaths.length > 0) {
          // Clear the brush selection
          chartbody.select(".brush").call(brush.move, null);
          chartbody.selectAll(".linePath").remove();
          chartbody.selectAll(".linePath-individual").remove();
          chartbody.selectAll(".linePath-outline").remove();
          chartbody.selectAll(".hover-circle").remove();

          // Recalculate x and y domains based on filtered data
          const allXValues = maneuverPaths.flatMap(m => m.points.map(d => mode_x() ? d.time : ((d as any).bsp || 0)));
          const newMinX = d3.min(allXValues);
          const newMaxX = d3.max(allXValues);
          // MIX mode: Y domain from outlier-filtered individual tracks in extent; ON mode: from grouped
          let newMinY: number;
          let newMaxY: number;
          if (hasIndividualCollection && individualPathsOutlierFiltered != null && individualPathsOutlierFiltered.length > 0) {
            const individualYInExtent: number[] = individualPathsOutlierFiltered.flatMap((m) =>
              m.points.filter((d: TimeSeriesDataPoint) => {
                const x = mode_x() ? d.time : ((d as any).bsp ?? 0);
                return x >= (newMinX ?? 0) && x <= (newMaxX ?? 0);
              }).map((d: TimeSeriesDataPoint) => {
                const v = (d as any)[channel];
                return typeof v === 'number' && !isNaN(v) ? v : parseFloat(String(v || 0)) || 0;
              })
            );
            newMinY = individualYInExtent.length > 0 ? (d3.min(individualYInExtent) ?? 0) : 0;
            newMaxY = individualYInExtent.length > 0 ? (d3.max(individualYInExtent) ?? 0) : 0;
          } else if (!hasIndividualCollection) {
            const allYValues = maneuverPaths.flatMap(m => m.points.map(d => (d as any)[channel] || 0));
            newMinY = d3.min(allYValues) ?? 0;
            newMaxY = d3.max(allYValues) ?? 0;
          } else {
            newMinY = minYValue;
            newMaxY = maxYValue;
          }
  
          xScale.domain([newMinX, newMaxX]);
          yScale.domain([newMinY, newMaxY]);
  
          // Update axes with smooth transitions
          xAxis.transition().duration(1000).call(d3.axisBottom(xScale).ticks(10));
          yAxis.transition().duration(1000).call(d3.axisLeft(yScale).ticks(4));
  
          // MIX MODE: Redraw individual tracks (outlier-filtered, then by extent)
          if (hasIndividualCollection && individualPathsOutlierFiltered != null && individualPathsOutlierFiltered.length > 0) {
            const inExtent = (d: TimeSeriesDataPoint) => {
              const x = mode_x() ? d.time : ((d as any).bsp ?? 0);
              return x >= (newMinX ?? 0) && x <= (newMaxX ?? 0);
            };
            const individualPathsBrush = individualPathsOutlierFiltered
              .map((m) => {
                const points = m.points.filter(inExtent).sort((a, b) => a.time - b.time);
                return points.length > 1 ? { pathKey: m.pathKey, points, firstPoint: points[0] } : null;
              })
              .filter((x): x is NonNullable<typeof x> => x != null);

            const hasGroupSelectionBrush = selectedGroupKeys().length > 0;
            const individualBrushSelection = chartbody.selectAll(".linePath-individual")
              .data(individualPathsBrush, (d: any) => d.pathKey);

            individualBrushSelection
              .enter()
              .append("path")
              .attr("class", "linePath-individual")
              .merge(individualBrushSelection)
              .each(function(d: any) {
                const node = this as SVGPathElement;
                const pathGroupKey = getGroupKeyFromItem(d.firstPoint, color());
                const isInSelectedGroup = hasGroupSelectionBrush && selectedGroupKeys().some((k: string | number) => groupKeyEquals(k, pathGroupKey));
                const strokeColor = isInSelectedGroup ? getColor(d.firstPoint) : "lightgrey";
                node.style.setProperty("transition", "none", "important");
                node.style.setProperty("stroke", strokeColor, "important");
                node.style.setProperty("stroke-width", "0.5", "important");
                node.style.setProperty("stroke-opacity", "0.3", "important");
              })
              .style("fill", "none")
              .style("pointer-events", "none")
              .attr("transform", "translate(20, 0)")
              .attr("d", (d: any) => toLinePath(d.points));

            individualBrushSelection.exit().remove();
          }

          // Now draw grouped tracks
          const orderedPaths = [...maneuverPaths];
          const linePathsSelection = chartbody.selectAll(".linePath")
              .data(orderedPaths, (d: ManeuverPathBrush) => d.pathKey);
  
          const hasGroupSelectionBrush = selectedGroupKeys().length > 0;
          const mixModeBrushStroke = groupDisplayMode() === 'MIX';
          
          linePathsSelection
              .enter()
              .append("path")
              .attr("class", (d: ManeuverPathBrush) => `linePath solid_line`)
              .merge(linePathsSelection)
              .each(function(d: ManeuverPathBrush) {
                const node = this as SVGPathElement;
                const pathGroupKey = getGroupKeyFromItem(d.firstPoint, color());
                const isSelected = hasGroupSelectionBrush && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
                const strokeColor = isSelected ? getColor(d.firstPoint) : (hasGroupSelectionBrush ? (mixModeBrushStroke ? getColor(d.firstPoint) : "lightgrey") : getColor(d.firstPoint));
                const strokeWidth = isSelected ? 3 : (hasGroupSelectionBrush ? 0.5 : 1);
                const strokeOpacity = isSelected ? 1 : (hasGroupSelectionBrush ? 0.2 : 1);
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
          const mixModeBrush = groupDisplayMode() === 'MIX';
          orderedPaths.forEach((maneuver: ManeuverPathBrush) => {
            const pathGroupKey = getGroupKeyFromItem(maneuver.firstPoint, color());
            const isSelected = hasGroupSelectionBrush && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
            const noPointerEvents = mixModeBrush && !isSelected;
            const eventKey = String(maneuver.pathKey).replace(/[^a-zA-Z0-9_-]/g, "_");
            const circles = chartbody.selectAll(`.hover-circle-${eventKey}`)
              .data(maneuver.points);
            
            const circlesMerge = circles.enter()
              .append("circle")
              .attr("class", `hover-circle hover-circle-${eventKey}`)
              .merge(circles)
              .attr("cx", (d: TimeSeriesDataPoint) => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)) + 20)
              .attr("cy", (d: TimeSeriesDataPoint) => yScale((d as any)[channel] || 0))
              .attr("r", 10) // Larger hit area for grouped (fewer lines)
              .style("fill", "transparent")
              .style("stroke", "none")
              .style("pointer-events", noPointerEvents ? "none" : "all")
              .style("cursor", noPointerEvents ? "default" : "pointer");
            if (!noPointerEvents) {
              circlesMerge
                .on("mouseover", (event: MouseEvent, d: TimeSeriesDataPoint) => mouseover(event, [d]))
                .on("mouseout", mouseout)
                .on("mousemove", (event: MouseEvent, d: TimeSeriesDataPoint) => mousemove(event, [d]))
                .on("click", (event: MouseEvent) => click(event, maneuver));
            } else {
              circlesMerge.on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
            }
            
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
        chartbody.select(".brush").call(brush.move, null); // Clear brush selection
        chartbody.selectAll(".linePath").remove();
        chartbody.selectAll(".linePath-individual").remove();
        chartbody.selectAll(".linePath-outline").remove();
        chartbody.selectAll(".hover-circle").remove();

        interface ManeuverPathRefresh {
          eventId?: number;
          pathKey: string;
          points: TimeSeriesDataPoint[];
          firstPoint: TimeSeriesDataPoint;
        }
        
        // MIX MODE: Draw individual tracks (outlier-filtered) first if needed
        if (hasIndividualCollection && individualPathsOutlierFiltered != null && individualPathsOutlierFiltered.length > 0) {
          const individualPathsRefresh = individualPathsOutlierFiltered as ManeuverPathRefresh[];

          const hasGroupSelectionRefresh = selectedGroupKeys().length > 0;
          const individualRefreshSelection = chartbody.selectAll(".linePath-individual")
            .data(individualPathsRefresh, (d: ManeuverPathRefresh) => d.pathKey);

          individualRefreshSelection
            .enter()
            .append("path")
            .attr("class", "linePath-individual")
            .merge(individualRefreshSelection)
            .each(function(d: ManeuverPathRefresh) {
              const node = this as SVGPathElement;
              const pathGroupKey = getGroupKeyFromItem(d.firstPoint, color());
              const isInSelectedGroup = hasGroupSelectionRefresh && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
              const strokeColor = isInSelectedGroup ? getColor(d.firstPoint) : "lightgrey";
              node.style.setProperty("transition", "none", "important");
              node.style.setProperty("stroke", strokeColor, "important");
              node.style.setProperty("stroke-width", "0.5", "important");
              node.style.setProperty("stroke-opacity", "0.3", "important");
            })
            .style("fill", "none")
            .style("pointer-events", "none")
            .attr("transform", "translate(20, 0)")
            .attr("d", (d: ManeuverPathRefresh) => toLinePath(d.points));

          individualRefreshSelection.exit().remove();
        }

        // Now draw grouped tracks
        let maneuverPaths: ManeuverPathRefresh[] = [];
        const groupKey = groupByKeyName();
        collection.forEach((vals: TimeSeriesDataPoint[], i: number) => {
          const points = [...vals].sort((a, b) => a.time - b.time);
          const filteredPoints: TimeSeriesDataPoint[] = [];
          let prevPoint: TimeSeriesDataPoint | null = null;
          points.forEach(d => {
            if (prevPoint === null) {
              filteredPoints.push(d);
              prevPoint = d;
            } else {
              const seconds = Math.abs(prevPoint.time - d.time);
              if (seconds < 5) {
                filteredPoints.push(d);
                prevPoint = d;
              }
            }
          });
          if (filteredPoints.length > 1) {
            const gv = (filteredPoints[0] as any)[groupKey];
            maneuverPaths.push({
              pathKey: `group_${String(gv)}_${i}`,
              points: filteredPoints,
              firstPoint: filteredPoints[0]
            });
          }
        });

        const orderedPaths = [...maneuverPaths];
        const linePathsSelection = chartbody.selectAll(".linePath")
          .data(orderedPaths, (d: ManeuverPathRefresh) => d.pathKey);

        const hasGroupSelectionRefresh = selectedGroupKeys().length > 0;
        const mixModeRefreshStroke = groupDisplayMode() === 'MIX';
        
        linePathsSelection
          .enter()
          .append("path")
          .attr("class", (d: ManeuverPathRefresh) => `linePath solid_line`)
          .merge(linePathsSelection)
          .each(function(d: ManeuverPathRefresh) {
            const node = this as SVGPathElement;
            const pathGroupKey = getGroupKeyFromItem(d.firstPoint, color());
            const isSelected = hasGroupSelectionRefresh && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
            const strokeColor = isSelected ? getColor(d.firstPoint) : (hasGroupSelectionRefresh ? (mixModeRefreshStroke ? getColor(d.firstPoint) : "lightgrey") : getColor(d.firstPoint));
            const strokeWidth = isSelected ? 3 : (hasGroupSelectionRefresh ? 0.5 : 1);
            const strokeOpacity = isSelected ? 1 : (hasGroupSelectionRefresh ? 0.2 : 1);
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
        const mixModeRefresh = groupDisplayMode() === 'MIX';
        orderedPaths.forEach((maneuver: ManeuverPathRefresh) => {
          const pathGroupKey = getGroupKeyFromItem(maneuver.firstPoint, color());
          const isSelected = hasGroupSelectionRefresh && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
          const noPointerEvents = mixModeRefresh && !isSelected;
          const eventKey = String(maneuver.pathKey).replace(/[^a-zA-Z0-9_-]/g, "_");
          const circles = chartbody.selectAll(`.hover-circle-${eventKey}`)
            .data(maneuver.points);
          
          const circlesMerge = circles.enter()
            .append("circle")
            .attr("class", `hover-circle hover-circle-${eventKey}`)
            .merge(circles)
            .attr("cx", (d: TimeSeriesDataPoint) => (mode_x() ? xScale(d.time) : xScale((d as any).bsp || 0)) + 20)
            .attr("cy", (d: TimeSeriesDataPoint) => yScale((d as any)[channel] || 0))
            .attr("r", 10) // Larger hit area for grouped (fewer lines)
            .style("fill", "transparent")
            .style("stroke", "none")
            .style("pointer-events", noPointerEvents ? "none" : "all")
            .style("cursor", noPointerEvents ? "default" : "pointer");
          if (!noPointerEvents) {
            circlesMerge
              .on("mouseover", (event: MouseEvent, d: TimeSeriesDataPoint) => mouseover(event, [d]))
              .on("mouseout", mouseout)
              .on("mousemove", (event: MouseEvent, d: TimeSeriesDataPoint) => mousemove(event, [d]))
              .on("click", (event: MouseEvent) => click(event, maneuver));
          } else {
            circlesMerge.on("mouseover", null).on("mouseout", null).on("mousemove", null).on("click", null);
          }
          
          circles.exit().remove();
        });
    
        linePathsSelection.exit().remove();
        drawPaths();
      }
    }

    drawPaths()
  }

  function updateSelection() {
    updateMinMaxRanges();
    const hasGroupSelection = selectedGroupKeys().length > 0;
    const mixModeUpdateSel = groupDisplayMode() === 'MIX';

    requestAnimationFrame(() => {
      const charts = document.getElementsByClassName("ts");
      for (let i = 1; i < charts.length + 1; i++) {
        const chartBody = d3.select("#plots").select("#ts" + i).select("#body" + i);
        if (chartBody.empty()) continue;
        chartBody.selectAll(".linePath").each(function (d: any) {
          const node = this as SVGPathElement;
          const maneuver = d as { firstPoint?: TimeSeriesDataPoint; points?: TimeSeriesDataPoint[] };
          const firstPoint = maneuver?.firstPoint ?? (maneuver?.points && maneuver.points?.[0]) ?? null;
          if (!node || !firstPoint) return;
          const pathGroupKey = getGroupKeyFromItem(firstPoint, color());
          const isSelected = hasGroupSelection && selectedGroupKeys().some(k => groupKeyEquals(k, pathGroupKey));
          const strokeColor = isSelected ? getColor(firstPoint) : (hasGroupSelection ? (mixModeUpdateSel ? getColor(firstPoint) : "lightgrey") : getColor(firstPoint));
          const strokeWidth = isSelected ? 3 : (hasGroupSelection ? 0.5 : 1);
          const strokeOpacity = isSelected ? 1 : (hasGroupSelection ? 0.2 : 1);
          node.style.setProperty("transition", "none", "important");
          node.style.setProperty("stroke", strokeColor, "important");
          node.style.setProperty("stroke-width", String(strokeWidth), "important");
          node.style.setProperty("stroke-opacity", String(strokeOpacity), "important");
        });
      }
      setTriggerSelection(false);
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
        if (selectedGroupKeys().length > 0 && tsdata().length > 0) {
          updateSelection();
        }
      }, 500);
    });
  };

  createEffect(() => {
    if (triggerUpdate()) {
      updateTimeSeries();
      setTriggerUpdate(false);
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

  // Watch for selectedGroupKeys changes (from cross-window sync or table/map) and update selection
  let selectionUpdateTimeout: NodeJS.Timeout | null = null;
  createEffect(() => {
    selectedGroupKeys();
    
    // Update selection when selectedGroupKeys changes
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
    // Update selection when color changes and component is ready (data loaded)
    if (tsdata().length > 0) {
      // Use untrack to prevent updateSelection from creating reactive dependencies
      untrack(() => {
        updateSelection();
      });
    }
  });

  // Watch for groupDisplayMode changes (OFF/ON/MIX) — redraw so layers and hover match mode
  // Also trigger on initial run when mode is MIX so first build uses MIX (fix 4)
  let prevGroupDisplayMode: string | undefined;
  createEffect(() => {
    const mode = groupDisplayMode();
    const isModeChange = prevGroupDisplayMode !== undefined && prevGroupDisplayMode !== mode;
    const isInitialMIX = prevGroupDisplayMode === undefined && mode === 'MIX';
    if (isModeChange || isInitialMIX) {
      untrack(() => {
        if (tsdata().length > 0) setTriggerUpdate(true);
      });
    }
    prevGroupDisplayMode = mode;
  });

  // Get groups and color scale for legend - extract from tsdata; highlight groups that are selected
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

    let groups: Array<{ name: string; color: string; isHighlight?: boolean }> = [];
    let colorScale: any = null;
    
    if (currentColor === 'TWS') {
      const uniques = groupBy(flatData, 'tws_bin');
      uniques.sort((a, b) => Number(a) - Number(b));
      colorScale = d3.scaleThreshold().domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]).range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"]);
      groups = uniques.map(tws => ({
        name: String(tws),
        color: String(colorScale ? colorScale(Number(tws)) : 'grey'),
        isHighlight: false
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
            color: String(colorScale(String(intervalMin))),
            isHighlight: false
          };
          });
        }
      }
    } else if (currentColor === 'TACK') {
      const uniques = groupBy(flatData, 'tack');
      groups = uniques.map(tack => ({
        name: String(tack),
        color: (tack === 'PORT' || tack === 'S - P') ? '#d62728' : '#2ca02c',
        isHighlight: false
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
          color: String(itemColor),
          isHighlight: false
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
