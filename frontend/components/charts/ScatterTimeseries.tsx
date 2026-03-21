import { onMount, onCleanup, createSignal, createEffect, untrack } from "solid-js";
import * as d3 from "d3";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import { resolveDataField } from "../../utils/colorScale";
import { setSelectedEvents, setHasSelection, setTriggerSelection } from "../../store/selectionStore";
import { isDark } from "../../store/themeStore";
import { debug as logDebug } from "../../utils/console";
import { getCurrentDatasetTimezone, setCurrentDataset } from "../../store/datasetTimezoneStore";
import { persistantStore } from "../../store/persistantStore";
import { selectedSources } from "../../store/filterStore";

interface ScatterTimeseriesProps {
  key?: string;  // Solid.js key for control flow (re-mount when key changes)
  aggregates: any[];  // Array of aggregate data points
  color: string;      // Field name for coloring (e.g., 'TACK', 'GRADE', 'SOURCE_NAME')
  groups: Array<{ name: string; color: string }>;  // Color groups from parent
  colorScale?: (value: string) => string;  // Optional color scale for fleet components
  isHistoryPage?: boolean;  // Whether this is a history page (affects x-axis formatting)
  uwDw?: string;  // Upwind/Downwind filter: 'UPWIND' or 'DOWNWIND'
  showUwDw?: boolean;  // Whether to apply upwind/downwind filtering
}

export default function ScatterTimeseries(props: ScatterTimeseriesProps) {
  let containerRef: HTMLElement | null = null;
  const [width, setWidth] = createSignal(0);
  const [height] = createSignal(75);
  
  const margin = { top: 5, right: 10, bottom: 20, left: 40 };
  let svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  let xScale: d3.ScaleTime<number, number, never> | null = null;
  let yScale: d3.ScaleLinear<number, number, never> | null = null;
  let brush: d3.BrushBehavior<unknown> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mainContentRef: HTMLElement | null = null; // main-content element when used for width (same as perf legend scaling)
  
  // Track signatures for change detection (like AdvancedScatter)
  let lastDataSignature = '';
  let lastColorGroupsSignature = '';
  let dataRedrawTimer: ReturnType<typeof setTimeout> | null = null;

  const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;

  // Get channel names (non-reactive)
  const getBspName = () => defaultChannelsStore.bspName() || 'Bsp_kts';
  const getTwaName = () => defaultChannelsStore.twaName() || 'Twa_deg';

  // Helper function to get timezone (non-reactive, called when needed)
  const getTimezone = (): string | null => {
    return getCurrentDatasetTimezone();
  };

  // Helper function to create a time formatter with timezone support (for labels only)
  const createTimeFormatter = (timezone: string | null, isHistory: boolean) => {
    return (date: Date | d3.NumberValue) => {
      // D3 passes dates as d3.NumberValue, convert to Date if needed
      const dateObj = date instanceof Date ? date : new Date(date as number);
      
      if (!dateObj || isNaN(dateObj.getTime())) {
        return '';
      }

      if (!timezone) {
        // Fallback to browser local timezone using D3 formatter
        if (isHistory) {
          return d3.timeFormat("%Y-%m-%d")(dateObj);
        } else {
          return d3.timeFormat("%I:%M%p")(dateObj);
        }
      }

      try {
        if (isHistory) {
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          });
          const parts = formatter.formatToParts(dateObj);
          const year = parts.find(p => p.type === 'year')?.value || '';
          const month = parts.find(p => p.type === 'month')?.value || '';
          const day = parts.find(p => p.type === 'day')?.value || '';
          return `${year}-${month}-${day}`;
        } else {
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });
          return formatter.format(dateObj);
        }
      } catch (error) {
        logDebug('ScatterTimeseries: Error formatting time with timezone', { timezone, error, date: dateObj });
        // Fallback to D3 formatter
        if (isHistory) {
          return d3.timeFormat("%Y-%m-%d")(dateObj);
        } else {
          return d3.timeFormat("%I:%M%p")(dateObj);
        }
      }
    };
  };

  // Color function matching PerfScatter/FleetScatter pattern
  const getColor = (d: any, color?: string, groups?: Array<{ name: string; color: string }>, colorScale?: (value: string) => string): string => {
    const currentColor = color ?? props.color;
    const currentGroups = groups ?? props.groups;
    const currentColorScale = colorScale ?? props.colorScale;

    // If colorScale is provided AND color is SOURCE_NAME, use colorScale
    if (currentColor === 'SOURCE_NAME' && currentColorScale && typeof currentColorScale === 'function') {
      // Get source name from data (check multiple field name variations)
      const sourceName = d.source_name || d.sourceName || d.source || d.SOURCE || d.SOURCE_NAME;
      if (sourceName) {
        const normalizedSource = String(sourceName).toLowerCase();
        return currentColorScale(normalizedSource);
      }
    }

    // If color prop is provided and groups are available, use them
    if (currentColor && currentGroups && Array.isArray(currentGroups)) {
      // Use resolveDataField to get the value
      let value = resolveDataField(d, currentColor);

      // Special handling for RACE: convert -1 to 'TRAINING'
      if (currentColor === 'RACE' && (value === -1 || value === '-1')) {
        value = 'TRAINING';
      }

      // When colored by LEG, training / -1 always use light grey (match legend and AdvancedScatter)
      if (currentColor === 'LEG') {
        const note = value !== undefined && value !== null ? String(value) : '';
        if (note === 'TRAINING' || note === 'training' || note === '-1' || value === -1) {
          return 'lightgrey';
        }
      }

      // Convert value to string for consistent comparison
      const valueStr = value !== undefined && value !== null ? String(value) : null;

      // Find matching group - handle both string and number comparisons
      let group = null;
      if (valueStr !== null) {
        group = currentGroups.find(group => {
          // Try exact string match first
          if (String(group.name) === valueStr) return true;
          // Try number comparison if both are numeric
          const groupNum = Number(group.name);
          const valueNum = Number(valueStr);
          if (!isNaN(groupNum) && !isNaN(valueNum) && groupNum === valueNum) return true;
          // Try case-insensitive string match
          if (String(group.name).toLowerCase() === valueStr.toLowerCase()) return true;
          return false;
        });
      }

      return group ? group.color : "lightgrey";
    }

    // Fallback: return lightgrey if no color/groups provided
    return "lightgrey";
  };

  // Process data: filter and prepare for rendering
  const processData = (data: any[]) => {
    if (!data || data.length === 0) return [];

    const bspFieldName = getBspName();
    const bspFieldNameLower = bspFieldName.toLowerCase();
    const twaFieldName = getTwaName();
    
    // Get selected sources and normalize to lowercase for comparison
    const selected = selectedSources();
    const selectedSourcesLower = selected.length > 0 
      ? selected.map(s => String(s).toLowerCase().trim())
      : [];
    
    return data
      .filter(d => {
        // Filter by selected sources if any are selected
        if (selectedSourcesLower.length > 0) {
          // Extract source name from various possible field names
          const sourceName = d.source_name || d.sourceName || d.source || d.SOURCE || d.SOURCE_NAME || d.Source_name || '';
          const normalizedSourceName = String(sourceName).toLowerCase().trim();
          
          // Only include if source is in selected sources list
          if (!normalizedSourceName || !selectedSourcesLower.includes(normalizedSourceName)) {
            return false;
          }
        }

        // Ensure Datetime and BSP fields exist
        const hasDatetime = d.Datetime || d.datetime || d.DATETIME || d.metadata?.datetime;
        const hasBsp = d[bspFieldName] !== undefined && d[bspFieldName] !== null ||
                       d[bspFieldNameLower] !== undefined && d[bspFieldNameLower] !== null;
        if (!hasDatetime || !hasBsp) return false;

        // Apply upwind/downwind filtering if enabled
        if (props.showUwDw && props.uwDw) {
          // Use Twa_deg_avg (metadata from AVG) for consistent upwind/downwind filtering
          const twaAvg = d.Twa_deg_avg ?? d.twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            if (props.uwDw === 'UPWIND') {
              if (Math.abs(Number(twaAvg)) >= 90) return false;
            } else {
              if (Math.abs(Number(twaAvg)) < 90) return false;
            }
          } else {
            // Fallback to regular Twa field if Twa_deg_avg is missing
            const twaValue = d[twaFieldName] ?? d.Twa ?? d.twa ?? d.Twa_deg ?? d.twa_deg;
            if (twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue))) {
              if (props.uwDw === 'UPWIND') {
                if (Math.abs(Number(twaValue)) >= 90) return false;
              } else {
                if (Math.abs(Number(twaValue)) < 90) return false;
              }
            }
          }
        }

        return true;
      })
      .map(d => {
        // Parse Datetime - check multiple locations
        let datetime: Date;
        if (d.Datetime instanceof Date) {
          datetime = d.Datetime;
        } else if (typeof d.Datetime === 'string') {
          datetime = new Date(d.Datetime.replace(/ /, 'T'));
        } else if (d.datetime) {
          datetime = typeof d.datetime === 'string' ? new Date(d.datetime.replace(/ /, 'T')) : new Date(d.datetime);
        } else if (d.DATETIME) {
          datetime = typeof d.DATETIME === 'string' ? new Date(d.DATETIME.replace(/ /, 'T')) : new Date(d.DATETIME);
        } else if (d.metadata?.datetime) {
          // Fallback to metadata.datetime if Datetime is missing
          const metaDatetime = d.metadata.datetime;
          if (metaDatetime instanceof Date) {
            datetime = metaDatetime;
          } else if (typeof metaDatetime === 'string') {
            datetime = new Date(metaDatetime.replace(/ /, 'T'));
          } else {
            datetime = new Date(metaDatetime);
          }
        } else {
          logDebug('ScatterTimeseries: No datetime found for data point', { 
            hasDatetime: !!d.Datetime, 
            hasDatetimeLower: !!d.datetime, 
            hasDatetimeUpper: !!d.DATETIME,
            hasMetadataDatetime: !!d.metadata?.datetime,
            event_id: d.event_id 
          });
          datetime = new Date();
        }

        // Get BSP value using default channel name (handle case variations)
        const bspValue = d[bspFieldName] ?? 
                         d[bspFieldNameLower] ?? 
                         0;

        return {
          datetime: datetime,  // Use lowercase to match data field naming
          Datetime: datetime,  // Keep both for backward compatibility
          BSP: Number(bspValue) || 0,
          event_id: d.event_id,
          ...d  // Preserve all other fields for coloring
        };
      });
  };

  // Draw the chart
  const drawChart = () => {
    if (!containerRef) return;

    const currentWidth = width();
    const currentHeight = height();
    const chartWidth = currentWidth - margin.left - margin.right;
    const chartHeight = currentHeight - margin.top - margin.bottom;

    if (chartWidth <= 0 || chartHeight <= 0) return;

    logDebug('ScatterTimeseries: drawChart called', {
      currentWidth,
      currentHeight,
      chartWidth,
      chartHeight,
      timestamp: new Date().toISOString()
    });

    // Clear existing SVG
    d3.select(containerRef).selectAll("*").remove();

    // Process data
    const processedData = processData(props.aggregates);
    if (processedData.length === 0) return;

    // Create SVG
    svg = d3.select(containerRef)
      .append("svg")
      .attr("width", currentWidth)
      .attr("height", currentHeight);

    const chartBody = svg.append("g")
      .attr("transform", `translate(${margin.left}, ${margin.top})`);

    // logDebug('ScatterTimeseries: processedData', processedData);

    // Set up scales
    const timeExtent = d3.extent(processedData, d => d.datetime) as [Date | undefined, Date | undefined];
    const bspExtent = d3.extent(processedData, d => d.BSP) as [number | undefined, number | undefined];

    // Validate time extent
    if (!timeExtent[0] || !timeExtent[1] || !(timeExtent[0] instanceof Date) || !(timeExtent[1] instanceof Date)) {
      logDebug('ScatterTimeseries: Invalid time extent', {
        timeExtent,
        processedDataLength: processedData.length,
        sampleData: processedData.slice(0, 3).map(d => ({ Datetime: d.datetime, type: typeof d.datetime }))
      });
      return; // Don't draw if we don't have valid dates
    }

    // Validate BSP extent
    if (bspExtent[0] === undefined || bspExtent[1] === undefined) {
      logDebug('ScatterTimeseries: Invalid BSP extent', { bspExtent, processedDataLength: processedData.length });
      return; // Don't draw if we don't have valid BSP values
    }

    logDebug('ScatterTimeseries: Setting up scales', {
      timeExtent: [timeExtent[0].toISOString(), timeExtent[1].toISOString()],
      bspExtent,
      chartWidth,
      chartHeight
    });

    xScale = d3.scaleTime()
      .domain([timeExtent[0], timeExtent[1]])
      .range([0, chartWidth]);

    yScale = d3.scaleLinear()
      .domain([bspExtent[0], bspExtent[1]])
      .range([chartHeight, 0]);

    // Draw axes
    // Format x-axis based on history page: dates for history, time for dataset
    // Use timezone-aware formatter (like TimeSeries does)
    const isHistory = props.isHistoryPage || false;
    const tz = getTimezone();
    const timeFormatter = createTimeFormatter(tz, isHistory);
    
    const xAxis = d3.axisBottom(xScale)
      .ticks(5) // Add explicit tick count
      .tickFormat((d) => {
        try {
          const result = timeFormatter(d);
          return result || '';
        } catch (error) {
          logDebug('ScatterTimeseries: Error in tickFormat', { error, date: d, timezone: tz });
          // Fallback to simple D3 formatter
          if (isHistory) {
            return d3.timeFormat("%Y-%m-%d")(d as Date);
          } else {
            return d3.timeFormat("%I:%M%p")(d as Date);
          }
        }
      });

    const yAxis = d3.axisLeft(yScale)
      .ticks(3);

    // Draw x-axis (time axis)
    const xAxisGroup = chartBody.append("g")
      .attr("transform", `translate(0, ${chartHeight})`)
      .call(xAxis);
    
    // Style x-axis to be visible
    xAxisGroup.selectAll("path")
      .style("stroke", isDark() ? "white" : "black");
    xAxisGroup.selectAll("line")
      .style("stroke", isDark() ? "white" : "black");
    xAxisGroup.selectAll("text")
      .style("fill", isDark() ? "white" : "black")
      .style("font-size", "10px");

    // Draw y-axis
    const yAxisGroup = chartBody.append("g")
      .call(yAxis);
    
    // Style y-axis to be visible
    yAxisGroup.selectAll("path")
      .style("stroke", isDark() ? "white" : "black");
    yAxisGroup.selectAll("line")
      .style("stroke", isDark() ? "white" : "black");
    yAxisGroup.selectAll("text")
      .style("fill", isDark() ? "white" : "black")
      .style("font-size", "10px");

    // Y-axis label - use BSP channel name, horizontal at (15, 15)
    const bspLabel = getBspName();
    chartBody.append("text")
      .attr("x", 15)
      .attr("y", 15)
      .attr("text-anchor", "start")
      .attr("font-size", "12px")
      .style("fill", isDark() ? "white" : "black")
      .text(bspLabel);

    // Draw scatter points
    chartBody.selectAll("circle")
      .data(processedData)
      .enter()
      .append("circle")
      .attr("class", "scatter-point")
      .attr("cx", d => xScale!(d.datetime || d.Datetime))
      .attr("cy", d => yScale!(d.BSP))
      .attr("r", 2)
      .style("fill", d => getColor(d, props.color, props.groups, props.colorScale))
      .style("stroke", d => getColor(d, props.color, props.groups, props.colorScale));

    // Create brush
    brush = d3.brushX()
      .extent([[0, 0], [chartWidth, chartHeight]])
      .on("end", brushed);

    chartBody.append("g")
      .attr("class", "brush")
      .call(brush);
  };

  // Brush handler
  function brushed(event: any) {
    if (!event || !event.selection || !xScale || !props.aggregates || props.aggregates.length === 0) {
      // Clear selection
      setSelectedEvents([]);
      setHasSelection(false);
      setTriggerSelection(true);
      return;
    }

    const [x0, x1] = event.selection.map((x: number) => xScale!.invert(x));
    const selectionDuration = Math.abs(x1.getTime() - x0.getTime());

    // Only update if selection duration is significant (avoid accidental clicks)
    if (selectionDuration < 1000) {
      return;
    }

    const startTime = x0 < x1 ? x0 : x1;
    const endTime = x0 < x1 ? x1 : x0;

    // Filter data by time range - use same datetime parsing logic as processData
    const filteredData = props.aggregates.filter(d => {
      let datetime: Date;
      if (d.Datetime instanceof Date) {
        datetime = d.Datetime;
      } else if (typeof d.Datetime === 'string') {
        datetime = new Date(d.Datetime.replace(/ /, 'T'));
      } else if (d.datetime) {
        datetime = typeof d.datetime === 'string' ? new Date(d.datetime.replace(/ /, 'T')) : new Date(d.datetime);
      } else if (d.DATETIME) {
        datetime = typeof d.DATETIME === 'string' ? new Date(d.DATETIME.replace(/ /, 'T')) : new Date(d.DATETIME);
      } else if (d.metadata?.datetime) {
        // Fallback to metadata.datetime if Datetime is missing
        const metaDatetime = d.metadata.datetime;
        if (metaDatetime instanceof Date) {
          datetime = metaDatetime;
        } else if (typeof metaDatetime === 'string') {
          datetime = new Date(metaDatetime.replace(/ /, 'T'));
        } else {
          datetime = new Date(metaDatetime);
        }
      } else {
        return false;
      }

      return datetime >= startTime && datetime <= endTime;
    });

    // Extract unique event_ids
    const eventIds = new Set<number>();
    filteredData.forEach(d => {
      if (d.event_id !== undefined && d.event_id !== null && d.event_id !== '') {
        const parsed = typeof d.event_id === 'string' ? parseInt(d.event_id, 10) : Number(d.event_id);
        if (!isNaN(parsed)) {
          eventIds.add(parsed);
        }
      }
    });

    const eventIdsArray = Array.from(eventIds);

    if (eventIdsArray.length > 0) {
      setSelectedEvents(eventIdsArray);
      setHasSelection(true);
      setTriggerSelection(true);
      logDebug('ScatterTimeseries: Brush selection updated selectedEvents', {
        eventCount: eventIdsArray.length,
        timeRange: { start: startTime.toISOString(), end: endTime.toISOString() }
      });
    } else {
      setSelectedEvents([]);
      setHasSelection(false);
      setTriggerSelection(true);
    }
  }

  // Update colors only (preserves scales and chart structure)
  const updateColors = () => {
    if (!containerRef || !svg) return;
    const chartBody = svg.select("g");
    if (chartBody.empty()) return;

    // Use untrack to get current props without creating reactive dependencies
    const currentColor = untrack(() => props.color);
    const currentGroups = untrack(() => props.groups);
    const currentColorScale = untrack(() => props.colorScale);

    chartBody.selectAll("circle.scatter-point")
      .transition()
      .duration(200)
      .style("fill", (d: any) => getColor(d, currentColor, currentGroups, currentColorScale))
      .style("stroke", (d: any) => getColor(d, currentColor, currentGroups, currentColorScale));
  };

  // Same as performance scatter (AdvancedScatter): use our container's width so we scale with media-container
  // Legend uses fixed 1500px + parent transform; AdvancedScatter uses chartRef.clientWidth. We use containerRef.clientWidth.
  const updateWidth = () => {
    if (containerRef) {
      const w = containerRef.clientWidth || 0;
      if (w > 0 && w !== width()) setWidth(w);
      return;
    }
    const mainContent = document.getElementById('main-content');
    if (mainContent && mainContent.clientWidth > 0) {
      if (mainContent.clientWidth !== width()) setWidth(mainContent.clientWidth);
    }
  };

  // Initialize width on mount - observe our container (same as AdvancedScatter: we size to our container)
  onMount(() => {
    mainContentRef = document.getElementById('main-content');
    resizeObserver = new ResizeObserver(() => updateWidth());
    if (containerRef) {
      resizeObserver.observe(containerRef);
      updateWidth();
    }
    if (mainContentRef) resizeObserver.observe(mainContentRef);
    window.addEventListener("resize", updateWidth);

    // Deferred measure after layout (handles mount inside Show; media-container may not be sized yet)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateWidth();
      });
    });

    // Initialize dataset timezone (non-reactive, fire and forget - don't await)
    // This ensures timezone is available for future renders without triggering a redraw
    const className = selectedClassName();
    const projectId = selectedProjectId();
    let datasetId: number | null = null;
    
    if (typeof selectedDatasetId === 'function') {
      const dsId = selectedDatasetId();
      datasetId = dsId ? Number(dsId) : null;
    } else if (selectedDatasetId) {
      datasetId = Number(selectedDatasetId);
    }

    if (className && projectId && datasetId && datasetId > 0) {
      // Fire and forget - don't await to avoid timing issues
      setCurrentDataset(className, projectId, datasetId).catch(() => {
        // Silently ignore errors - timezone is optional
      });
    }
  });

  // Effect 1: Initial draw and data changes (filters, uwDw, aggregates) - debounced like AdvancedScatter
  createEffect(() => {
    const currentWidth = width();
    if (currentWidth <= 0) return;

    // Track uwDw and showUwDw to make effect reactive to filter changes
    const uwDw = props.uwDw || '';
    const showUwDw = props.showUwDw || false;
    
    // Track selected sources to make effect reactive to source filter changes
    const selected = selectedSources();
    const selectedSourcesHash = selected.length > 0 ? selected.sort().join(',') : '';

    // Track aggregates so effect re-runs when perf filters (year/event/config/state/grade/race/leg) change
    const aggregates = props.aggregates;
    const isHistoryPage = untrack(() => props.isHistoryPage);
    
    // Build simple data signature (avoid expensive processData call)
    const aggregatesLength = Array.isArray(aggregates) ? aggregates.length : 0;
    
    // Simple time hash: just check first and last datetime if available
    let timeHash = '';
    if (aggregates && aggregatesLength > 0) {
      const first = aggregates[0];
      const last = aggregates[aggregatesLength - 1];
      
      // Quick datetime extraction (no full processing)
      const getDatetime = (d: any): Date | null => {
        if (d.Datetime instanceof Date) return d.Datetime;
        if (typeof d.Datetime === 'string') {
          const dt = new Date(d.Datetime.replace(/ /, 'T'));
          return isNaN(dt.getTime()) ? null : dt;
        }
        if (d.datetime) {
          const dt = typeof d.datetime === 'string' ? new Date(d.datetime.replace(/ /, 'T')) : new Date(d.datetime);
          return isNaN(dt.getTime()) ? null : dt;
        }
        return null;
      };
      
      const firstDt = getDatetime(first);
      const lastDt = getDatetime(last);
      if (firstDt && lastDt) {
        timeHash = `${firstDt.getTime()}-${lastDt.getTime()}`;
      }
    }
    
    // Include uwDw and selectedSources in signature so filtering changes trigger redraw
    const currentDataSignature = `${aggregatesLength}|${isHistoryPage ? '1' : '0'}|${timeHash}|${showUwDw ? uwDw : ''}|${selectedSourcesHash}`;

    // Check if chart exists
    const chartExists = svg && svg.node();

    // If signature changed OR chart doesn't exist yet (initial draw), redraw
    if (currentDataSignature !== lastDataSignature || !chartExists) {
      lastDataSignature = currentDataSignature;

      // Debounce data redraws (like AdvancedScatter)
      if (dataRedrawTimer) {
        clearTimeout(dataRedrawTimer);
      }

      dataRedrawTimer = setTimeout(() => {
        if (!containerRef) {
          dataRedrawTimer = null;
          return;
        }

        const aggregatesValue = untrack(() => props.aggregates);
        
        requestAnimationFrame(() => {
          // Draw if we have data (chart may or may not exist yet)
          if (aggregatesValue && Array.isArray(aggregatesValue) && aggregatesValue.length > 0) {
            drawChart();
          }
          dataRedrawTimer = null;
        });
      }, chartExists ? 200 : 0); // No debounce for initial draw
    }
  });

  // Effect 2: Color/groups changes - only update colors, don't redraw
  createEffect(() => {
    // Track color, groups, and colorScale to make effect reactive
    void props.color;
    void props.groups;
    void props.colorScale;
    
    if (!containerRef) return;

    // Use untrack to get current values without creating additional reactive dependencies
    const currentColor = untrack(() => props.color);
    const currentGroups = untrack(() => props.groups);
    const currentColorScale = untrack(() => props.colorScale);
    const aggregatesLength = untrack(() => Array.isArray(props.aggregates) ? props.aggregates.length : 0);

    const groupsSignature = currentGroups ? currentGroups.map((g: any) => `${g.name}:${g.color}`).join('|') : '';
    const colorScaleExists = currentColorScale && typeof currentColorScale === 'function' ? '1' : '0';
    const currentColorGroupsSignature = `${currentColor || ''}|${groupsSignature}|${aggregatesLength}|${colorScaleExists}`;

    if (currentColorGroupsSignature === lastColorGroupsSignature) {
      return; // No color change, skip update
    }

    lastColorGroupsSignature = currentColorGroupsSignature;
    
    // Check if chart exists using untrack to avoid reactive dependency
    const chartExists = untrack(() => svg?.node());
    if (chartExists) {
      updateColors();
    } else if (width() > 0) {
      // Chart doesn't exist yet, draw it
      drawChart();
    }
  });

  // Effect 3: Width changes (resize) - redraw when width changes
  let lastWidthForResize = 0;
  createEffect(() => {
    const currentWidth = width();
    
    // Only redraw if width actually changed
    if (currentWidth !== lastWidthForResize && currentWidth > 0) {
      lastWidthForResize = currentWidth;
      // If chart exists, redraw immediately (no debounce for resize)
      if (svg && svg.node()) {
        drawChart();
      }
    }
  });

  // Cleanup
  onCleanup(() => {
    if (dataRedrawTimer) {
      clearTimeout(dataRedrawTimer);
      dataRedrawTimer = null;
    }

    window.removeEventListener("resize", updateWidth);

    if (resizeObserver) {
      if (mainContentRef) resizeObserver.unobserve(mainContentRef);
      if (containerRef) resizeObserver.unobserve(containerRef);
      resizeObserver.disconnect();
    }
    mainContentRef = null;

    if (containerRef) {
      d3.select(containerRef).selectAll("*").remove();
    }

    svg = null;
    xScale = null;
    yScale = null;
    brush = null;
  });

  return (
    <div 
      ref={el => (containerRef = el)} 
      style={{ width: "100%", minWidth: 0, height: "75px", overflow: "hidden" }}
    />
  );
}
