import { createSignal, createMemo, createEffect, onMount, onCleanup, untrack } from "solid-js";
import * as d3 from "d3";
import { sourcesStore } from "../../../store/sourcesStore";
import { selectedTime, isPlaying, setSelectedTime, setIsPlaying, setIsManualTimeChange, isManualTimeChange, requestTimeControl, releaseTimeControl, timeWindow, getDisplayWindowReferenceTime } from "../../../store/playbackStore";
import { selectedRange, selectedRanges, setSelectedRange, setHasSelection, setIsCut, cutEvents, setSelectedRanges, setSelectedEvents } from "../../../store/selectionStore";
import { selectedRacesTimeseries as globalSelectedRaces, selectedLegsTimeseries as globalSelectedLegs } from "../../../store/filterStore";
import { streamingStore } from "../../../store/streamingStore";
import { liveConfigStore } from "../../../store/liveConfigStore";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";
import { debug as logDebug, warn as logWarn } from "../../../utils/console";
import { themeStore } from "../../../store/themeStore";
import { formatTime } from "../../../utils/global";
import { getCurrentDatasetTimezone } from "../../../store/datasetTimezoneStore";

interface LiveMapTimeSeriesProps {
  samplingFrequency?: number;
  onStableSelectedTimeChange?: (time: Date) => void;
  onMapUpdate?: (data: any[]) => void;
  selectedSourceIds?: Set<number>;
  [key: string]: any;
}

interface Dimensions {
  width: number;
  height: number;
}

export default function LiveMapTimeSeries(props: LiveMapTimeSeriesProps) {
  // Don't destructure props to maintain reactivity!
  const { samplingFrequency, onStableSelectedTimeChange, onMapUpdate } = props;
  
  // Constants
  const GAP_THRESHOLD_MS = 10000; // 10 seconds
  
  let chartContainer: HTMLElement | null = null;
  let svg: any = null;
  let xScale: any = null;
  let yScale: any = null;
  let brush: any = null;
  let brushGroup: any = null;
  
  // Abort controller and mount tracking for cleanup
  let abortController: AbortController | null = null;
  let isMounted = true;
  
  // Brush state management
  let isBrushActive = false;
  let isClearingBrush = false;
  let isProgrammaticallyUpdatingBrush = false;
  let brushTimeout: ReturnType<typeof setTimeout> | null = null;
  let isBrushing = false; // Track if we're currently in a brush operation
  let hasInitializedSelectedTime = false; // Track if we've done initial selectedTime setup
  let lastMapUpdateSignature: string | null = null;
  let prevSelectedTime: Date | null = null;
  let lastFilterSignature = '';
  
  const [dimensions, setDimensions] = createSignal<Dimensions>({ width: 0, height: 0 });
  const margin = { top: 10, right: 10, bottom: 30, left: 50 };
  
  // Get timezone for axis formatting
  const getTimezone = () => getCurrentDatasetTimezone();

  const sourceKey = (d: any): number | undefined => d?.source_id;
  
  // Create reactive accessor for selectedSourceIds
  const selectedSourceIds = (): Set<number> | undefined => props.selectedSourceIds;

  // Helper to get timestamp from data point
  const getTimestamp = (d: any): Date => {
    if (!d) return new Date(0);
    const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
    if (!timestamp) return new Date(0);
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date(0);
  };

  // Load initial data from Redis into streamingStore
  const loadInitialData = async () => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      logDebug('[LiveMapTimeSeries] ⚠️ Component unmounted or aborted, skipping loadInitialData');
      return;
    }
    
    const selected = selectedSourceIds();
    if (selected.size === 0) {
      return;
    }

    try {
      // Get current timeWindow setting - respect it for initial load
      // If timeWindow is 0, load all available (24 hours)
      // If timeWindow is set (e.g., 30 minutes), load data for that window
      const currentTimeWindow = Number(timeWindow());
      const currentTime = selectedTime();
      const defaultTime = new Date('1970-01-01T12:00:00Z');
      const isValidTime = currentTime && currentTime.getTime() !== defaultTime.getTime() && !isNaN(currentTime.getTime());
      
      // Use selectedTime if valid, otherwise fallback to Date.now()
      const endTime = isValidTime ? currentTime.getTime() : Date.now();
      
      // Calculate minutes for the API call
      // If timeWindow is 0, fetch all available data (24 hours)
      // If timeWindow > 0, fetch data for that specific window
      const minutes = currentTimeWindow > 0 ? currentTimeWindow : 0;
      
      logDebug('[LiveMapTimeSeries] 🔄 Loading initial data from Redis', {
        timeWindow: currentTimeWindow,
        minutes,
        endTime: new Date(endTime).toISOString(),
        selectedTime: isValidTime ? currentTime.toISOString() : 'invalid (using Date.now())',
        sourceCount: selected.size
      });
      
      // Load data from Redis respecting the timeWindow setting
      // This ensures timeline and tracks fill up to the timeWindow specified, then stream live data
      await streamingStore.loadInitialDataFromRedis(selected, minutes, endTime);
      
      // Check again after async operation
      if (!isMounted || abortController?.signal.aborted) {
        logDebug('[LiveMapTimeSeries] ⚠️ Component unmounted or aborted after loadInitialDataFromRedis');
        return;
      }

      // Get ALL raw data for initial load - show complete history from Redis
      // Time window filtering will be applied later when user interacts with playback
      const filteredDataMap = streamingStore.getRawData(selected);
      const allData = [];
      if (filteredDataMap && filteredDataMap instanceof Map) {
        for (const [sourceId, data] of filteredDataMap.entries()) {
          allData.push(...data);
        }
      }

      // Check again before processing
      if (!isMounted || abortController?.signal.aborted) {
        return;
      }

      // Sort by timestamp
      allData.sort((a, b) => getTimestamp(a).getTime() - getTimestamp(b).getTime());

      // Initialize selectedTime to (latest - bufferMs) so playback runs buffer behind real time
      // After that, user can move it manually when paused without it being reset
      if (allData.length > 0 && !hasInitializedSelectedTime && isMounted && !abortController?.signal.aborted) {
        const latestTime = Math.max(...allData.map(d => getTimestamp(d).getTime()));
        const earliestTime = Math.min(...allData.map(d => getTimestamp(d).getTime()));
        if (latestTime > 0) {
          const currentTime = selectedTime();
          const defaultTime = new Date('1970-01-01T12:00:00Z');
          const isDefault = currentTime.getTime() === defaultTime.getTime();
          const bufferMsVal = liveConfigStore.bufferMs();
          const initialTime = Math.max(earliestTime, latestTime - bufferMsVal);

          // Only set if it's the default time or very far from latest (initialization case)
          if (isDefault || Math.abs(currentTime.getTime() - latestTime) > 60000) {
            if (requestTimeControl('livemaptimeseries')) {
              setIsManualTimeChange(false);
              setSelectedTime(new Date(initialTime), 'livemaptimeseries');
              setTimeout(() => {
                if (isMounted && !abortController?.signal.aborted) {
                  releaseTimeControl('livemaptimeseries');
                }
              }, 100);
              hasInitializedSelectedTime = true; // Mark as initialized
            }
          } else {
            // Even if we don't set it, mark as initialized if selectedTime is already set
            hasInitializedSelectedTime = true;
          }
        }
      }

      // Send initial data to map
      if (onMapUpdate && allData.length > 0 && isMounted && !abortController?.signal.aborted) {
        onMapUpdate(allData);
      }

    } catch (err: any) {
      // Ignore abort errors
      if (err?.name === 'AbortError' || abortController?.signal.aborted) {
        logDebug('[LiveMapTimeSeries] ⚠️ loadInitialData aborted');
        return;
      }
      logWarn('[LiveMapTimeSeries] Error loading initial data:', err);
    }
  };

  // Group data by source for rendering
  // Watch getNewData() to ensure memo re-evaluates when websocket data arrives
  const groupedData = createMemo(() => {
    const selected = selectedSourceIds();
    const currentTime = selectedTime();
    const currentlyPlaying = isPlaying();
    
    if (selected.size === 0) return [];

    // Watch for new websocket data updates (reactive signal)
    // This ensures the memo re-evaluates when websocket data arrives
    const newDataMap = streamingStore.getNewData()();
    
    // Track the size and latest timestamp to ensure reactivity
    // Access the map to track changes
    let totalNewDataPoints = 0;
    let latestNewTimestamp = 0;
    for (const [sourceId, points] of newDataMap.entries()) {
      if (selected.has(sourceId) && points && points.length > 0) {
        totalNewDataPoints += points.length;
        for (const point of points) {
          const ts = getTimestamp(point).getTime();
          if (ts > latestNewTimestamp) latestNewTimestamp = ts;
        }
      }
    }
    // Track these values to ensure memo re-evaluates
    const _newDataCount = totalNewDataPoints;
    const _latestNewTs = latestNewTimestamp;

    // Get RAW unfiltered data from streamingStore for chart display
    // NOTE: Chart always shows ALL data - no brush filtering, no time window filtering
    // selectedRange is only used for map filtering - the chart shows all data
    // This reads from historicalData which accumulates all websocket points
    const filteredDataMap = streamingStore.getRawData(selected);

    // Track total data count to ensure reactivity
    let totalDataCount = 0;
    let latestTimestamp = 0;
    for (const [sourceId, data] of filteredDataMap.entries()) {
      totalDataCount += data.length;
      if (data.length > 0) {
        const lastPoint = data[data.length - 1];
        const ts = getTimestamp(lastPoint).getTime();
        if (ts > latestTimestamp) latestTimestamp = ts;
      }
    }
    // Track these to ensure memo detects data changes
    const _totalCount = totalDataCount;
    const _latestTs = latestTimestamp;

    // Depend on historical data version so timeline re-renders when Redis data loads on reload
    const _historicalVersion = streamingStore.getHistoricalDataVersion()();
    // Depend on live append version so chart re-renders when WebSocket appends (getNewData() is cleared after 100ms)
    const _liveAppendVersion = streamingStore.getLiveDataAppendVersion()();

    const sources = sourcesStore.sources();
    const groups = [];

    for (const [sourceId, data] of filteredDataMap.entries()) {
      if (data.length === 0) continue;

      const sourceInfo = sources.find(s => Number(s.source_id) === Number(sourceId));
      const color = sourceInfo?.color || '#1f77b4';
      const name = sourceInfo?.source_name || String(sourceId);

      // Sort by timestamp
      let sorted = [...data].sort((a, b) => getTimestamp(a).getTime() - getTimestamp(b).getTime());

      // When playing, filter data to only show up to selectedTime (current playback position)
      // When paused, show ALL data so user can see the full timeline
      if (currentlyPlaying && currentTime instanceof Date) {
        const currentTimeMs = currentTime.getTime();
        sorted = sorted.filter(d => getTimestamp(d).getTime() <= currentTimeMs);
      }

      groups.push({
        sourceId: sourceId,
        sourceName: name,
        color: color,
        data: sorted
      });
    }

    return groups;
  });

  // Calculate time extent for x-scale based on timeWindow
  // IMPORTANT: Use getDisplayWindowReferenceTime() so chart and map use the same reference time
  // (smooth when playing, selectedTime when paused) and stay in sync - avoids 1min/2min flicker.
  // Brush selection does NOT affect this - the chart always shows full time range.
  const timeExtent = createMemo(() => {
    const currentTimeWindow = Number(timeWindow()); // Minutes; coerce in case sync returned string
    const groups = groupedData();
    // Single source of truth for reference time (same as map uses for track trim)
    const referenceTime = getDisplayWindowReferenceTime();

    // If timeWindow is set (> 0), use it to define the x-axis scale (window in minutes)
    // BUT: If we're currently brushing, don't update based on reference time (prevents zooming)
    if (currentTimeWindow > 0 && referenceTime instanceof Date && !isNaN(referenceTime.getTime()) && !isBrushing) {
      const windowMs = currentTimeWindow * 60 * 1000;
      const windowStart = new Date(referenceTime.getTime() - windowMs);
      const windowEnd = new Date(referenceTime.getTime());
      return [windowStart, windowEnd];
    }
    
    // If timeWindow is 0, show all available data
    // NOTE: This is NOT affected by brush selection - brush only filters map, not chart
    if (groups.length === 0) {
      const now = new Date();
      return [new Date(now.getTime() - 30 * 60 * 1000), now]; // Default to last 30 minutes
    }

    let minTime = Infinity;
    let maxTime = -Infinity;

    // Calculate extent from ALL data (not filtered by brush)
    // Brush selection is only used for map filtering, not chart display
    for (const group of groups) {
      for (const point of group.data) {
        const ts = getTimestamp(point).getTime();
        if (ts > 0) {
          minTime = Math.min(minTime, ts);
          maxTime = Math.max(maxTime, ts);
        }
      }
    }

    if (minTime === Infinity || maxTime === -Infinity) {
      const now = new Date();
      return [new Date(now.getTime() - 30 * 60 * 1000), now];
    }

    return [new Date(minTime), new Date(maxTime)];
  });

  // Get value extent (e.g., Bsp) across all sources
  const valueExtent = createMemo(() => {
    const groups = groupedData();
    if (groups.length === 0) return [0, 100];
    
    // Use default channel name for Bsp (Bsp_kph for GP50, Bsp_kts for AC75)
    const bspFieldName = defaultChannelsStore.bspName() || 'Bsp_kph';
    
    let minVal = Infinity;
    let maxVal = -Infinity;
    
    for (const group of groups) {
      for (const d of group.data) {
        // Try default channel name first, then fallback to old normalized names for compatibility
        const val = d[bspFieldName] ?? d.Bsp_kph ?? d.Bsp_kts ?? d.Bsp ?? d.bsp ?? 0;
        if (Number.isFinite(val)) {
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
    }
    
    // Ensure we have valid values
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || minVal === Infinity) {
      return [0, 100];
    }
    
    return [minVal * 0.95, maxVal * 1.05]; // Add 5% padding
  });

  // Initialize SVG
  const initSVG = () => {
    if (!chartContainer) return;
    
    const bbox = chartContainer.getBoundingClientRect();
    // Add extra height for x-axis labels that extend below the axis
    const labelPadding = 20;
    const svgHeight = bbox.height + labelPadding;
    setDimensions({ width: bbox.width, height: bbox.height });
    
    // Remove existing SVG
    d3.select(chartContainer).selectAll("svg").remove();
    
    svg = d3.select(chartContainer)
      .append("svg")
      .attr("width", bbox.width)
      .attr("height", svgHeight)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("z-index", "10")
      .style("pointer-events", "auto");
    
    // Create scales
    // NOTE: Scale range should match MapTimeSeries pattern for consistency
    // MapTimeSeries uses range [0, width - margin.left - margin.right] for xScale
    // and positions axes using transforms, not range offsets
    const [minTime, maxTime] = timeExtent();
    const [minVal, maxVal] = valueExtent();
    
    // Calculate effective width/height (excluding margins); clamp to avoid negative brush/rect dimensions (e.g. on resize)
    const effectiveWidth = Math.max(0, bbox.width - margin.left - margin.right);
    const effectiveHeight = Math.max(0, bbox.height - margin.top - margin.bottom);
    
    // Validate time extent
    if (!minTime || !maxTime || isNaN(minTime.getTime()) || isNaN(maxTime.getTime()) || minTime.getTime() === maxTime.getTime()) {
      logWarn('LiveMapTimeSeries: Invalid time extent, using default', {
        minTime: minTime?.toISOString(),
        maxTime: maxTime?.toISOString()
      });
      const now = new Date();
      const past = new Date(now.getTime() - 30 * 60 * 1000);
      xScale = d3.scaleTime()
        .domain([past, now])
        .range([0, effectiveWidth]);
    } else {
      xScale = d3.scaleTime()
        .domain([minTime, maxTime])
        .range([0, effectiveWidth]);
    }
    
    yScale = d3.scaleLinear()
      .domain([minVal, maxVal])
      .range([effectiveHeight, 0]);

    const getThemeColor = (lightColor, darkColor) => {
      return themeStore.isDark() ? darkColor : lightColor;
    };
    
    // Add axes
    const axiscolor = getThemeColor('#374151', '#cbd5e1');
    
    // Create axes with explicit styling
    const timezone = getTimezone();
    const xAxis = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat((d) => {
        if (d instanceof Date) {
          const formatted = formatTime(d, timezone);
          return formatted || d.toLocaleTimeString();
        }
        return String(d);
      });
    const yAxis = d3.axisLeft(yScale).ticks(5);
    
    // X-axis
    // NOTE: Transform includes margin.left offset since xScale range starts at 0
    const xAxisGroup = svg.append("g")
      .attr("class", "axes")
      .attr("data-axis", "x")
      .attr("transform", `translate(${margin.left}, ${bbox.height - margin.bottom})`)
      .call(xAxis);
    
    // Force style on all text elements
    xAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    xAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Y-axis
    // NOTE: Transform includes margin.left offset since xScale range starts at 0
    const yAxisGroup = svg.append("g")
      .attr("class", "axes")
      .attr("data-axis", "y")
      .attr("transform", `translate(${margin.left}, ${margin.top})`)
      .call(yAxis);
    
    // Force style on all text elements
    yAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    yAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Add brush functionality
    // NOTE: Brush extent should match MapTimeSeries pattern for consistency
    // MapTimeSeries uses [0, 0] to [effectiveWidth, effectiveHeight] since scale range starts at 0
    // The brush coordinates are relative to the scale range, not absolute SVG coordinates
    // effectiveWidth and effectiveHeight are already declared above
    brush = d3.brushX()
      .extent([
        [0, 0],
        [effectiveWidth, effectiveHeight],
      ]);
    
    // Create the brush group
    // NOTE: Transform includes margin offsets since brush extent is relative to scale range (starts at 0)
    brushGroup = svg.append("g")
      .attr("class", "brush")
      .attr("transform", `translate(${margin.left}, ${margin.top})`)
      .call(brush)
      .on("contextmenu", (event) => event.preventDefault());
    
    // Hide brush handles and selection - only allow click on overlay
    brushGroup.selectAll(".handle, .selection")
      .style("display", "none")
      .style("pointer-events", "none");
    
    // Add click handler to the brush overlay
    // NOTE: Clicking on timeline pauses playback and sets selectedTime
    // IMPORTANT: When timeWindow > 0, updating selectedTime causes zooming
    // So we only update selectedTime when timeWindow === 0
    brushGroup.select(".overlay")
      .on("click", (event) => {
        // Get mouse position relative to brush group (which has transform translate)
        const [mouseX] = d3.pointer(event, brushGroup.node());
        // Invert to get time - xScale range starts at 0, so no margin offset needed
        const time = xScale.invert(mouseX);
        const currentTimeWindow = timeWindow();
        const currentlyPlaying = isPlaying();
        
        // Pause playback when clicking on timeline
        if (currentlyPlaying) {
          setIsPlaying(false);
        }
        
        // Only update selectedTime if timeWindow is 0 (no zooming mode)
        // When timeWindow > 0, updating selectedTime causes timeExtent to recalculate and zoom
        if (currentTimeWindow === 0) {
          if (requestTimeControl('livemaptimeseries')) {
            setIsManualTimeChange(true);
            setSelectedTime(new Date(time), 'livemaptimeseries');
            if (onStableSelectedTimeChange) {
              onStableSelectedTimeChange(new Date(time));
            }
            
            setTimeout(() => {
              releaseTimeControl('livemaptimeseries');
            }, 100);
          }
        }
        
        // When paused, LiveTrackLayer will handle updates based on selectedTime
        // No need to send data updates when paused
      })
      // Add double-click handler to clear selection
      .on("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleBrushClear();
      });
    
    // Brush handlers disabled - only allow click to change selected time
    // brush.on("brush", brushed).on("end", brushEnded).on("start", null);
    
    // Brush selection restoration disabled - brush events are disabled
    // restoreBrushSelection();
    
    // Expose clearBrush globally so it can be called from playbackStore
    if (typeof window !== 'undefined') {
      window.clearMapBrush = clearBrush;
      window.clearTimeSeriesBrush = clearBrush;
    }
  };

  // Helper function to restore brush selection
  // NOTE: This only restores the brush visual selection, it does NOT zoom the chart
  // The chart scale domain remains unchanged - brush only sets selectedRange for map filtering
  const restoreBrushSelection = () => {
    if (!brushGroup || !xScale) return;
    
    const currentSelectedRange = selectedRange();
    const currentCutEvents = cutEvents();
    
    if (currentSelectedRange && currentSelectedRange.length > 0) {
      const rangeItem = currentSelectedRange[0];
      const startTime = new Date(rangeItem.start_time);
      const endTime = new Date(rangeItem.end_time);
      
      // Convert time to brush coordinates (xScale range starts at 0, no margin offset needed)
      // Brush group has transform translate(margin.left, margin.top), so coordinates are relative
      const x0 = xScale(startTime);
      const x1 = xScale(endTime);
      
      // Restore brush selection - this only updates the brush visual, NOT the chart scale domain
      brushGroup.call(brush.move, [x0, x1]);
    } else if (currentCutEvents && currentCutEvents.length > 0) {
      brushGroup.call(brush.move, null);
    } else {
      brushGroup.call(brush.move, null);
    }
  };

  // Helper function to update time selection
  const updateTimeSelection = (time) => {
    if (requestTimeControl('livemaptimeseries')) {
      try { (window).skipBoatHaloOnce = true; } catch {}
      if (!isManualTimeChange()) setIsManualTimeChange(true);
      const newTime = new Date(time);
      const current = selectedTime();
      if (!(current instanceof Date) || Math.abs(current.getTime() - newTime.getTime()) > 0) {
        setSelectedTime(newTime, 'livemaptimeseries');
      }
      if (onStableSelectedTimeChange) {
        onStableSelectedTimeChange(newTime);
      }
      prevSelectedTime = newTime;
      
      setTimeout(() => {
        releaseTimeControl('livemaptimeseries');
      }, 100);
    }
  };

  // Helper function to handle brush clearing
  const handleBrushClear = () => {
    setSelectedRange([]);
    setSelectedRanges([]);
    setSelectedEvents([]);
    setHasSelection(false);
    setIsCut(cutEvents().length > 0);
    
    const filteredDataMap = streamingStore.getFilteredData(selectedSourceIds());
    const allData = [];
    if (filteredDataMap && filteredDataMap instanceof Map) {
      for (const [sourceId, data] of filteredDataMap.entries()) {
        allData.push(...data);
      }
    }
    
    if (allData && allData.length > 0) {
      lastMapUpdateSignature = null;
      const timestampedData = allData.map((d, index) => ({
        ...d,
        _clearTimestamp: Date.now() + index
      }));
      
      if (onMapUpdate) {
        onMapUpdate(timestampedData);
      }
    }
  };

  // Helper function to clear brush
  const clearBrush = () => {
    if (isClearingBrush) {
      return;
    }
    
    isClearingBrush = true;
    
    try {
      if (brushGroup) {
        isProgrammaticallyUpdatingBrush = true;
        brushGroup.call(brush.move, null);
      }
      handleBrushClear();
    } finally {
      setTimeout(() => {
        isClearingBrush = false;
        isProgrammaticallyUpdatingBrush = false;
      }, 100);
    }
  };

  // Helper function to handle brush selection
  // IMPORTANT: Do NOT update selectedTime when timeWindow > 0 - that causes zooming
  // Only set selectedRange - LiveTrackLayer will filter tracks based on selectedRange
  // When brushing, pause playback if it's playing
  const handleBrushSelection = async (x0, x1) => {
    const minSelectionMs = 1000;
    const selectionDuration = Math.abs(x1 - x0);
    const currentTimeWindow = timeWindow();
    const currentlyPlaying = isPlaying();

    // Pause playback when brushing
    if (currentlyPlaying) {
      setIsPlaying(false);
    }

    if (selectionDuration > minSelectionMs) {
      // Ensure startTime is the minimum (earlier) time
      const startTime = x0 < x1 ? new Date(x0) : new Date(x1);
      const endTime = x0 < x1 ? new Date(x1) : new Date(x0);
      
      // Set selectedRange (should already be set during brushing, but ensure it's set)
      const range = {"type": "range", "start_time": startTime.toISOString(), "end_time": endTime.toISOString()};
      setSelectedRange([range]);
      setHasSelection(true);
      setIsCut(false);
      
      // IMPORTANT: Only update selectedTime if timeWindow is 0 (no zooming mode)
      // When timeWindow > 0, updating selectedTime causes timeExtent to recalculate and zoom
      // LiveTrackLayer will filter tracks based on selectedRange, so we don't need to update selectedTime
      if (currentTimeWindow === 0) {
        // Safe to update selectedTime when timeWindow is 0 (no zooming)
        if (requestTimeControl('livemaptimeseries')) {
          setIsManualTimeChange(true);
          setSelectedTime(startTime, 'livemaptimeseries');
          if (onStableSelectedTimeChange) {
            onStableSelectedTimeChange(startTime);
          }
          setTimeout(() => {
            releaseTimeControl('livemaptimeseries');
          }, 100);
        }
      }
      
      // LiveTrackLayer reads from streamingStore and filters by selectedRange
      // No need to send data via onMapUpdate - LiveTrackLayer handles it
    } else {
      // Small selection - only update time if timeWindow is 0
      if (currentTimeWindow === 0) {
        const clickTime = new Date(x0);
        updateTimeSelection(x0);
      }
      
      setSelectedRange([]);
      setHasSelection(false);
    }
  };

  // Brush handler
  // NOTE: Brush selection does NOT zoom the chart - it only sets selectedRange for map filtering
  // The chart scale domain remains unchanged
  // IMPORTANT: Do NOT update selectedTime during brushing - that causes zooming when timeWindow > 0
  // Only set selectedRange - LiveTrackLayer will filter tracks based on selectedRange
  function brushed(event) {
    if (brushTimeout) clearTimeout(brushTimeout);
    
    brushTimeout = setTimeout(() => {
      if (isBrushActive) return;
      isBrushActive = true;
      isBrushing = true; // Mark that we're brushing to prevent timeExtent from updating
      
      try {
        if (event && event.selection) {
          // event.selection is in brush coordinates (relative to brush group transform)
          // xScale range starts at 0, so we can directly invert
          const [x0, x1] = event.selection.map(xScale.invert);
          const selectionDuration = Math.abs(x1 - x0);
          
          // IMPORTANT: Do NOT call updateTimeSelection() here - that updates selectedTime
          // which causes timeExtent to recalculate and zoom the chart when timeWindow > 0
          // Only set selectedRange - LiveTrackLayer will filter tracks based on this
          if (selectionDuration > 1000) {
            const startTime = x0 < x1 ? new Date(x0) : new Date(x1);
            const endTime = x0 < x1 ? new Date(x1) : new Date(x0);
            
            // Set selectedRange for LiveTrackLayer to filter tracks
            // LiveTrackLayer reads from streamingStore and filters by selectedRange
            const range = {"type": "range", "start_time": startTime, "end_time": endTime};
            setSelectedRange([range]);
            setHasSelection(true);
            setIsCut(false);
          } else {
            // Small selection - clear range
            setSelectedRange([]);
            setHasSelection(false);
          }
        }
      } finally {
        isBrushActive = false;
        // Keep isBrushing true until brush ends
      }
    }, 100);
  }

  // Brush ended handler
  function brushEnded(event) {
    // Mark that brushing has ended - timeExtent can now update based on selectedTime
    isBrushing = false;
    
    if (isProgrammaticallyUpdatingBrush) {
      isProgrammaticallyUpdatingBrush = false;
      return;
    }
    
    if (!event || !event.selection) {
      handleBrushClear();
      if (brushGroup) {
        try {
          isProgrammaticallyUpdatingBrush = true;
          brushGroup.call(brush.move, null);
        } catch(e) { /* noop */ }
      }
    } else {
      const [x0, x1] = event.selection.map(xScale.invert);
      handleBrushSelection(x0, x1);
    }
  }

  // Update axes when scales change
  const updateAxes = () => {
    if (!svg || !xScale || !yScale) return;
    
    const getThemeColor = (lightColor, darkColor) => {
      return themeStore.isDark() ? darkColor : lightColor;
    };
    const axiscolor = getThemeColor('#374151', '#cbd5e1');
    
    // Update x-axis
    const timezone = getTimezone();
    const xAxis = d3.axisBottom(xScale)
      .ticks(5)
      .tickFormat((d) => {
        if (d instanceof Date) {
          const formatted = formatTime(d, timezone);
          return formatted || d.toLocaleTimeString();
        }
        return String(d);
      });
    const xAxisGroup = svg.select("g.axes[data-axis='x']");
    
    xAxisGroup.call(xAxis);
    
    // Force style on all text elements
    xAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    xAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
    
    // Update y-axis
    const yAxis = d3.axisLeft(yScale).ticks(5);
    const yAxisGroup = svg.select("g.axes[data-axis='y']");
    
    yAxisGroup.call(yAxis);
    
    // Force style on all text elements
    yAxisGroup.selectAll("text")
      .each(function() {
        d3.select(this)
          .attr("fill", axiscolor)
          .style("fill", axiscolor)
          .style("color", axiscolor)
          .style("opacity", 1);
      });
    yAxisGroup.selectAll("path, line")
      .style("stroke", axiscolor);
  };

  // Render all series
  const render = () => {
    if (!svg || !xScale || !yScale) return;
    
    const groups = groupedData();
    
    // Update axes to reflect current scale domains
    updateAxes();
    
    // Gap threshold: 10 seconds
    const gapThresholdMs = GAP_THRESHOLD_MS;
    
    // Helper to check if there's a gap between two points
    const hasGap = (d, i, data) => {
      if (i === 0) return true; // Always define first point
      const prevTime = getTimestamp(data[i - 1]).getTime();
      const currTime = getTimestamp(d).getTime();
      const gap = currTime - prevTime;
      return gap > gapThresholdMs;
    };
    
    // Use default channel name for Bsp (Bsp_kph for GP50, Bsp_kts for AC75)
    const bspFieldName = defaultChannelsStore.bspName() || 'Bsp_kph';
    
    // Line generator with gap detection
    // Get x-axis domain to filter out points outside the scale bounds
    const xDomain = xScale.domain();
    const xMin = xDomain[0]?.getTime() ?? -Infinity;
    const xMax = xDomain[1]?.getTime() ?? Infinity;
    
    const lineGenerator = d3.line()
      .x((d) => margin.left + xScale(getTimestamp(d))) // Add margin.left since xScale range starts at 0
      .y((d) => {
        // Try default channel name first, then fallback to old normalized names for compatibility
        const val = d[bspFieldName] ?? d.Bsp_kph ?? d.Bsp_kts ?? d.Bsp ?? d.bsp ?? 0;
        return margin.top + yScale(val);
      })
      .defined((d, i, data) => {
        // Try default channel name first, then fallback to old normalized names for compatibility
        const val = d[bspFieldName] ?? d.Bsp_kph ?? d.Bsp_kts ?? d.Bsp ?? d.bsp;
        if (!Number.isFinite(val)) return false;
        
        // Check if timestamp is within x-axis domain bounds
        const timestamp = getTimestamp(d).getTime();
        if (timestamp < xMin || timestamp > xMax) return false;
        
        // Create gap if time difference > threshold
        return !hasGap(d, i, data);
      });
    
    // Render using SVG
    const paths = svg.selectAll("path.series-line")
      .data(groups, (d) => d.sourceId);
    
    // Exit: remove paths for deselected sources
    paths.exit().remove();
    
    // Enter: create new paths for new sources
    const pathsEnter = paths.enter()
      .append("path")
      .attr("class", "series-line")
      .attr("data-source-id", (d) => d.sourceId)
      .style("fill", "none")
      .style("stroke-width", "1px");
    
    // Update: merge enter and update selections
    pathsEnter.merge(paths)
      .attr("data-source-id", (d) => d.sourceId)
      .style("stroke", (d) => d.color)
      .attr("d", (d) => {
        if (!d.data || d.data.length === 0) return '';
        return lineGenerator(d.data);
      });
    
    // Render cursor line
    renderCursor();
  };

  // Render cursor line for selectedTime
  const renderCursor = () => {
    if (!svg || !xScale) return;
    
    const currentTime = selectedTime();
    if (!currentTime || !(currentTime instanceof Date)) {
      // Remove cursor if time is invalid
      svg.selectAll(".time-cursor").remove();
      return;
    }
    
    // Check if xScale domain is valid
    const domain = xScale.domain();
    if (!domain || domain.length < 2) {
      // Scale not initialized yet, remove cursor
      svg.selectAll(".time-cursor").remove();
      return;
    }
    
    const dims = dimensions();
    if (!dims || dims.width === 0 || dims.height === 0) {
      // Dimensions not ready, remove cursor
      svg.selectAll(".time-cursor").remove();
      return;
    }
    
    // Calculate x position - xScale should handle domain mapping
    let x: number;
    try {
      x = xScale(currentTime);
      if (isNaN(x) || !Number.isFinite(x)) {
        // Invalid x position, remove cursor
        svg.selectAll(".time-cursor").remove();
        return;
      }
    } catch (err) {
      // Error calculating x position, remove cursor
      svg.selectAll(".time-cursor").remove();
      return;
    }
    
    // Add margin.left since xScale range starts at 0
    const xWithMargin = margin.left + x;
    
    // Validate x position is within reasonable range (allow some overflow for edge cases)
    // The cursor should be visible if it's anywhere near the chart area
    if (xWithMargin < -100 || xWithMargin > dims.width + 100) {
      // Cursor would be far outside visible area, remove it
      svg.selectAll(".time-cursor").remove();
      return;
    }
    
    // Remove existing cursor
    svg.selectAll(".time-cursor").remove();
    
    // Add new cursor (line extends 15px higher above chart, ends 15px above bottom so it's raised)
    const cursorExtraHeight = 15;
    const cursorY1 = margin.top - cursorExtraHeight;
    const cursorY2 = dims.height - margin.bottom - cursorExtraHeight;
    svg.append("line")
      .attr("class", "time-cursor")
      .attr("x1", xWithMargin)
      .attr("x2", xWithMargin)
      .attr("y1", cursorY1)
      .attr("y2", cursorY2)
      .style("stroke", "red")
      .style("stroke-width", "2px")
      .style("pointer-events", "none");
  };

  // Handle resize
  const handleResize = () => {
    initSVG();
    render();
  };

  // Track last source IDs we loaded for - avoids duplicate loads, enables load when sources become available on reload
  let lastLoadedSourceIds = new Set<number>();

  // Effect: Load Redis data when selectedSourceIds becomes available (e.g. after async restoration on page reload)
  // This ensures the timeline is filled on reload when selectedSourceIds is restored from user settings/localStorage
  createEffect(() => {
    if (!isMounted || abortController?.signal.aborted) return;

    const selected = selectedSourceIds();
    if (!selected || selected.size === 0) return;

    // Skip if we already loaded for these exact sources
    const selectedArray = Array.from(selected).sort();
    const lastArray = Array.from(lastLoadedSourceIds).sort();
    if (selectedArray.length === lastArray.length && selectedArray.every((id, i) => id === lastArray[i])) {
      return;
    }

    lastLoadedSourceIds = new Set(selected);
    logDebug('[LiveMapTimeSeries] 🔄 selectedSourceIds available, loading Redis data', { sourceIds: selectedArray });
    loadInitialData().catch(e => {
      if (e?.name === 'AbortError' || abortController?.signal.aborted) {
        logDebug('[LiveMapTimeSeries] ⚠️ loadInitialData aborted');
        return;
      }
      logWarn('[LiveMapTimeSeries] Error loading initial data (sources changed):', e);
    });
  });

  // Mount
  onMount(() => {
    // Create abort controller for this component instance
    abortController = new AbortController();
    isMounted = true;
    
    // Listen for resize
    window.addEventListener('resize', handleResize);
    
    // Initial load attempt (may run before selectedSourceIds is restored - effect above handles that case)
    loadInitialData().catch(e => {
      // Ignore abort errors
      if (e?.name === 'AbortError' || abortController?.signal.aborted) {
        logDebug('[LiveMapTimeSeries] ⚠️ Initial load aborted');
        return;
      }
      logWarn('LiveMapTimeSeries: Initial load failed', e);
    });
  });

  // Effect: Watch for timeWindow changes and fetch data from Redis
  // When timeWindow changes, pause animation, fetch data for the selected time window, then resume
  let lastTimeWindow = timeWindow();
  let isFetchingData = false;
  createEffect(async () => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      return;
    }
    
    const currentTimeWindow = Number(timeWindow());
    const selected = selectedSourceIds();

    // Skip if no sources selected or if timeWindow hasn't actually changed
    if (selected.size === 0 || currentTimeWindow === lastTimeWindow || isFetchingData) {
      lastTimeWindow = currentTimeWindow;
      return;
    }
    
    // Track that we're fetching to prevent re-triggering during fetch
    isFetchingData = true;
    lastTimeWindow = currentTimeWindow;
    
    // Store current playing state to restore after fetch
    const wasPlaying = isPlaying();
    
    try {
      // Check again before pausing
      if (!isMounted || abortController?.signal.aborted) {
        return;
      }
      
      // Pause playback
      if (wasPlaying) {
        setIsPlaying(false);
        logDebug('[LiveMapTimeSeries] ⏸️ Paused playback for timeWindow change');
      }
      
      // Calculate time range based on selectedTime and timeWindow
      const currentTime = selectedTime();
      const defaultTime = new Date('1970-01-01T12:00:00Z');
      const isValidTime = currentTime && currentTime.getTime() !== defaultTime.getTime() && !isNaN(currentTime.getTime());
      
      // Use selectedTime if valid, otherwise fallback to Date.now()
      const endTime = isValidTime ? currentTime.getTime() : Date.now();
      
      // Calculate minutes for the API call
      // If timeWindow is 0, fetch all available data (24 hours)
      const minutes = currentTimeWindow > 0 ? currentTimeWindow : 0;
      
      logDebug('[LiveMapTimeSeries] 🔄 TimeWindow changed, fetching data from Redis', {
        timeWindow: currentTimeWindow,
        minutes,
        endTime: new Date(endTime).toISOString(),
        selectedTime: isValidTime ? currentTime.toISOString() : 'invalid (using Date.now())',
        sourceCount: selected.size
      });
      
      // Fetch data for the selected time window
      await streamingStore.loadInitialDataFromRedis(selected, minutes, endTime);
      
      // Check again after async operation
      if (!isMounted || abortController?.signal.aborted) {
        logDebug('[LiveMapTimeSeries] ⚠️ Component unmounted or aborted after loadInitialDataFromRedis');
        return;
      }
      
      logDebug('[LiveMapTimeSeries] ✅ Data fetched for timeWindow, chart will update automatically');
      
      // Chart will automatically re-render via groupedData() memo reactivity
      // No manual update needed - SolidJS will handle it
      
    } catch (err: any) {
      // Ignore abort errors
      if (err?.name === 'AbortError' || abortController?.signal.aborted) {
        logDebug('[LiveMapTimeSeries] ⚠️ timeWindow fetch aborted');
        return;
      }
      logWarn('[LiveMapTimeSeries] ❌ Error fetching data for timeWindow change:', err);
      // Continue even if fetch fails - don't block the UI
    } finally {
      // Only resume if still mounted and not aborted
      if (isMounted && !abortController?.signal.aborted) {
        // Resume playback if it was playing before
        if (wasPlaying) {
          // Small delay to ensure chart has updated
          setTimeout(() => {
            if (isMounted && !abortController?.signal.aborted) {
              setIsPlaying(true);
              logDebug('[LiveMapTimeSeries] ▶️ Resumed playback after timeWindow data fetch');
            }
          }, 100);
        }
      }
      
      // Reset fetching flag
      isFetchingData = false;
    }
  });

  // Update scales when time/value extents change
  // NOTE: Brush selection should NOT affect the timeseries chart zoom/extent
  // The chart always shows the full time range, brush only filters the map
  // IMPORTANT: We never modify xScale.domain() based on brush selection - that would cause zooming
  createEffect(() => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      return;
    }
    
    const [minTime, maxTime] = timeExtent();
    const [minVal, maxVal] = valueExtent();
    
    if (xScale && yScale && svg && isMounted && !abortController?.signal.aborted) {
      // Update scale domains - brush selection does NOT affect this
      // The chart always shows the full available time range
      // We only update domains based on data extent or timeWindow, NEVER based on brush selection
      if (minTime && maxTime && !isNaN(minTime.getTime()) && !isNaN(maxTime.getTime()) && minTime.getTime() !== maxTime.getTime()) {
        xScale.domain([minTime, maxTime]);
      }
      
      if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal !== maxVal) {
        yScale.domain([minVal * 0.95, maxVal * 1.05]);
      }
      
      // Update axes smoothly
      updateAxes();
      
      // Always re-render when scales update (data needs to be re-positioned)
      render();
    }
  });

  // Effect: Initialize/re-render when data changes or selectedTime changes (for pause/play)
  createEffect(() => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      return;
    }
    
    const groups = groupedData();
    const currentTime = selectedTime();
    const currentlyPlaying = isPlaying();
    
    if (groups.length > 0 && chartContainer && isMounted && !abortController?.signal.aborted) {
      // Data is available, initialize SVG (first time) or re-render (updates)
      // Also re-render when selectedTime changes (for pause/play scenarios)
      setTimeout(() => {
        if (isMounted && !abortController?.signal.aborted) {
          if (!svg) {
            initSVG();
          }
          render();
        }
      }, 50);
    }
  });

  // Watch for new websocket data and update map
  // This effect watches getNewData() which is reactive and triggers when websocket data arrives
  // It then calls getRawData() to get all accumulated historical data (including new websocket points)
  // NOTE: This effect is ONLY for map updates, NOT for chart display
  // The chart uses groupedData() which is completely independent
  createEffect(() => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      return;
    }
    
    const selected = selectedSourceIds();
    const currentlyPlaying = isPlaying();
    
    if (selected.size === 0) {
      if (onMapUpdate && isMounted && !abortController?.signal.aborted) {
        onMapUpdate([]);
      }
      return;
    }

    // When paused (isPlaying = false), do not update charts from websocket data
    // Only update when user manually changes selectedTime
    if (!currentlyPlaying) {
      // Still allow manual selectedTime updates to work
      // The render will be triggered by selectedTime changes instead
      return;
    }

    // Watch for new data updates - this is reactive and will trigger when websocket data arrives
    const newDataMap = streamingStore.getNewData()();
    // Also depend on live append version so we push to map when WebSocket appends (getNewData() is cleared after 100ms)
    const _liveAppendVersion = streamingStore.getLiveDataAppendVersion()();

    // Track new data to ensure reactivity
    let newDataCount = 0;
    let latestNewTimestamp = 0;
    for (const [sourceId, points] of newDataMap.entries()) {
      if (selected.has(sourceId) && points && points.length > 0) {
        newDataCount += points.length;
        for (const point of points) {
          const ts = getTimestamp(point).getTime();
          if (ts > latestNewTimestamp) latestNewTimestamp = ts;
        }
      }
    }
    // Track these to ensure effect re-runs when new data arrives
    const _newCount = newDataCount;
    const _newTs = latestNewTimestamp;
    
    // Get RAW data for map updates - LiveTrackLayer will filter by selectedRange when rendering
    // Do NOT filter here - we send full data and let LiveTrackLayer handle brush filtering
    // NOTE: This effect is ONLY for map updates via onMapUpdate, NOT for chart rendering
    // The chart renders based on groupedData() changes, which is completely independent
    const filteredDataMap = streamingStore.getRawData(selected);

    // Combine all source data
    const allData = [];
    let totalDataCount = 0;
    if (filteredDataMap && filteredDataMap instanceof Map) {
      for (const [sourceId, data] of filteredDataMap.entries()) {
        allData.push(...data);
        totalDataCount += data.length;
      }
    }
    
    // Track total count and latest timestamp to ensure reactivity
    const latestTimestamp = allData.length > 0
      ? Math.max(...allData.map(d => getTimestamp(d).getTime()))
      : 0;
    const _totalCount = totalDataCount;
    const _latestTs = latestTimestamp;

    // Sort by timestamp
    allData.sort((a, b) => getTimestamp(a).getTime() - getTimestamp(b).getTime());

    logDebug('[LiveMapTimeSeries] WebSocket data effect triggered (map update only)', {
      newDataCount: _newCount,
      latestNewTimestamp: _newTs,
      totalDataCount: _totalCount,
      latestTimestamp: _latestTs,
      allDataLength: allData.length,
      isPlaying: currentlyPlaying
    });

    // Send to map (includes all accumulated data, not just latest)
    // LiveTrackLayer will filter by selectedRange when rendering tracks
    if (onMapUpdate && isMounted && !abortController?.signal.aborted) {
      onMapUpdate(allData);
    }

    // NOTE: Do NOT call render() here - the chart renders based on groupedData() changes
    // groupedData() uses getRawData() and is completely independent of this effect
    // Calling render() here would cause unnecessary re-renders and might use filtered data
  });

  // Re-render cursor when selectedTime changes
  // Note: render() also calls renderCursor(), but this ensures it updates immediately when selectedTime changes
  createEffect(() => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      return;
    }
    
    // Watch selectedTime to ensure cursor updates when it changes
    const _time = selectedTime();
    const _timeExtent = timeExtent(); // Access timeExtent to ensure reactivity when scale domain changes
    
    // Only render if we have valid time, svg, and xScale
    if (_time && svg && xScale && isMounted && !abortController?.signal.aborted) {
      renderCursor();
    }
  });

  // Watch for when selectedTime reaches end of data during animation
  // When paused and animation reaches end, auto-resume and fetch missing data
  createEffect(() => {
    // Check if component is still mounted or aborted
    if (!isMounted || abortController?.signal.aborted) {
      return;
    }
    
    const currentTime = selectedTime();
    const currentlyPlaying = isPlaying();
    const selected = selectedSourceIds();
    
    // Only check when playing (animation is active)
    if (!currentlyPlaying || selected.size === 0) {
      return;
    }
    
    // Get latest timestamp from available data
    const latestTimestamp = streamingStore.getLatestTimestamp(selected);
    if (!latestTimestamp) {
      return; // No data yet
    }
    
    const currentTimeMs = currentTime instanceof Date ? currentTime.getTime() : 0;
    if (currentTimeMs === 0) {
      return;
    }
    
    // Check if we've reached the end of available data (within 1 second threshold)
    const timeDiff = latestTimestamp - currentTimeMs;
    const END_THRESHOLD_MS = 1000; // 1 second
    
    if (timeDiff <= END_THRESHOLD_MS && timeDiff >= -END_THRESHOLD_MS) {
      // We've reached the end of available data
      logDebug('[LiveMapTimeSeries] Reached end of available data, fetching missing data and resuming', {
        currentTime: currentTimeMs,
        latestTimestamp: latestTimestamp,
        timeDiff: timeDiff
      });
      
      // Fetch missing data from Redis using the current time window so we don't replace
      // a 2-min buffer with 1 min (gapMinutes would be 1 when gap is small, causing track to shrink).
      const fetchMissingData = async () => {
        // Check if component is still mounted or aborted
        if (!isMounted || abortController?.signal.aborted) {
          return;
        }
        
        try {
          const now = Date.now();
          // Use the selected time window so the refetch keeps the same visible length (e.g. 2 min).
          // Never use gapMinutes here: it can be 1 when the gap is small, which replaces the store
          // with 1 minute and causes the track to flash from 2 min to 1 min.
          const windowMin = Number(timeWindow());
          const minutes = windowMin > 0 ? windowMin : 0;
          await streamingStore.loadInitialDataFromRedis(selected, minutes, now);
          
          // Check again after async operation
          if (!isMounted || abortController?.signal.aborted) {
            return;
          }
          
          // After fetching, check if there's newer data
          const newLatestTimestamp = streamingStore.getLatestTimestamp(selected);
          if (newLatestTimestamp && newLatestTimestamp > latestTimestamp) {
            logDebug('[LiveMapTimeSeries] Fetched new data, latest timestamp now:', newLatestTimestamp);
            // Data was fetched, websocket should resume automatically
            // The playback interval will continue updating selectedTime
          } else {
            logDebug('[LiveMapTimeSeries] No new data available from Redis');
          }
        } catch (err: any) {
          // Ignore abort errors
          if (err?.name === 'AbortError' || abortController?.signal.aborted) {
            logDebug('[LiveMapTimeSeries] ⚠️ fetchMissingData aborted');
            return;
          }
          logWarn('[LiveMapTimeSeries] Error fetching missing data:', err);
        }
      };
      
      // Fetch in background (don't block)
      fetchMissingData();
      
      // Note: We don't need to manually resume websocket - it's already connected
      // The playback interval will continue and selectedTime will advance as new data arrives
    }
  });

  // Cleanup
  onCleanup(() => {
    logDebug('[LiveMapTimeSeries] 🧹 onCleanup called - aborting all operations');
    
    // Mark as unmounted immediately to stop all operations
    isMounted = false;
    
    // Abort all pending async operations
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    
    // Clear brush timeout
    if (brushTimeout) {
      clearTimeout(brushTimeout);
      brushTimeout = null;
    }
    
    // Remove resize listener
    window.removeEventListener('resize', handleResize);
    
    logDebug('[LiveMapTimeSeries] ✅ Cleanup complete');
  });

  return (
    <div 
      ref={(el) => (chartContainer = el)}
      class="chart-container"
      style="width: 100%; height: 100%; background: var(--color-bg-card);"
    />
  );
}

