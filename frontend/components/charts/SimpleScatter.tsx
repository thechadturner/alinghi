import { createEffect, onCleanup, createSignal, Show } from "solid-js";
import * as d3 from "d3";
import { myTickFormat, formatTime } from "../../utils/global";
import { useChartCleanup } from "../../utils/d3Cleanup";
import { warn, error as logError, log, debug } from "../../utils/console";

import { setTooltip, tooltip } from "../../store/globalStore";
import { isDark } from "../../store/themeStore";
import { cutEvents, selectedRange, selectedRanges, hasSelection, isCut, selectedEvents } from "../../store/selectionStore";
import { selectedStatesTimeseries, selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries } from "../../store/filterStore";
import { setSelectedTime, requestTimeControl, releaseTimeControl } from "../../store/playbackStore";
import { persistantStore } from "../../store/persistantStore";
import { applyDataFilter, filterByTwa } from "../../utils/dataFiltering";
import { enhancedScatterWorkerManager } from "../../utils/enhancedScatterWorkerManager";
import { createDensityOptimizationCacheKey } from "../../utils/densityOptimizationCache";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
// Lasso functionality removed for performance optimization
import Table from "./FitTable";

const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;

interface SimpleScatterProps {
  chart?: any;
  totalCharts?: number;
}

interface ContainerSize {
  width: number;
  height: number;
}

interface TooltipState {
  visible: boolean;
  content: string;
  x: number;
  y: number;
}

interface Scales {
  xScale: any;
  yScale: any;
}

export default function SimpleScatter(props: SimpleScatterProps) {
  let containerRef: HTMLElement | null = document.getElementById('main-content')
  let chartRef: SVGSVGElement | null = null;
  const [containerSize, setContainerSize] = createSignal<ContainerSize>({ width: 0, height: 0 });
  const [viewportHeight, setViewportHeight] = createSignal(window.innerHeight);
  const [isLoading, setIsLoading] = createSignal(false);
  const [chartData, setChartData] = createSignal<any[] | null>(null);
  const [datasetTimezone, setDatasetTimezone] = createSignal<string | null>(null);
  
  // Set up timezone from dataset
  createEffect(async () => {
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
      await setCurrentDataset(className, projectId, datasetId);
      const tz = getCurrentDatasetTimezone();
      setDatasetTimezone(tz);
    } else {
      setDatasetTimezone(null);
    }
  });
  
  // Initialize D3 cleanup
  const { addSelection, addEventListener, addTimer, addObserver, cleanup } = useChartCleanup();
  
  // Regression calculation state
  const [isCalculatingRegression, setIsCalculatingRegression] = createSignal(false);
  const [regressionResults, setRegressionResults] = createSignal<any>({});
  const [fitData, setFitData] = createSignal<any[]>([]);
  const [fitDataVersion, setFitDataVersion] = createSignal(0);
  
  // Store scales for regression drawing
  const [currentScales, setCurrentScales] = createSignal<Scales>({ xScale: null, yScale: null });
  
  // Enhanced data processing state
  const [isProcessingData, setIsProcessingData] = createSignal(false);
  const [enhancedData, setEnhancedData] = createSignal<any>(null);
  const [dataProcessingStats, setDataProcessingStats] = createSignal<any>(null);
  const [actualRenderedCount, setActualRenderedCount] = createSignal(0);
  const [currentRegressionMethod, setCurrentRegressionMethod] = createSignal("None");
  const [lastProcessedCacheKey, setLastProcessedCacheKey] = createSignal<string | null>(null);
  const [scatterRendered, setScatterRendered] = createSignal(false);
  
  // Regression calculation state to prevent infinite loops
  const [regressionCalculationId, setRegressionCalculationId] = createSignal(0);
  
  // Track last processed chart ID to detect chart changes
  let lastProcessedChartId: string | undefined = undefined;
  
  // Local tooltip state for this component
  const [localTooltip, setLocalTooltip] = createSignal<TooltipState>({
    visible: false,
    content: "",
    x: 0,
    y: 0
  });

  // Info icon tooltip state
  const [infoTooltip, setInfoTooltip] = createSignal<TooltipState>({
    visible: false,
    content: "",
    x: 0,
    y: 0
  });

  // Function to draw trend lines (defined at component level for reuse across effects)
  const drawTrendLine = (regression: any, color: string, xScale: any, yScale: any) => {
    if (!regression || !chartRef) return;
    
    const chartbody = d3.select(chartRef).select("g");
    if (chartbody.empty()) return;
    
    const { points } = regression;
    
    // For linear regression, draw a straight line
    if (regression.slope !== undefined) {
      chartbody.append("line")
        .attr("class", "trend-line")
        .attr("x1", xScale(points[0].x))
        .attr("y1", yScale(points[0].y))
        .attr("x2", xScale(points[1].x))
        .attr("y2", yScale(points[1].y))
        .style("stroke", color)
        .style("stroke-width", 3);
        
      // Add R² label for linear regression
      const r2Text = regression.r2.toFixed(2);
      const xPosition = xScale(points[0].x) + (xScale(points[1].x) - xScale(points[0].x)) * (2/3);
      const yPosition = yScale(points[0].y) + (yScale(points[1].y) - yScale(points[0].y)) * (2/3);
      chartbody.append("text")
        .attr("class", "trend-label")
        .attr("x", xPosition + 30) 
        .attr("y", yPosition + 30)
        .attr("text-anchor", "middle")
        .attr("font-size", "16px")
        .attr("font-weight", "bold")
        .attr("user-select", "none")
        .attr("pointer-events", "none")
        .attr("fill", color)
        .text(`R² = ${r2Text}`);
    } 
    // For LOESS and polynomial regression, draw segments within bounds
    else {
      const yDomain = yScale.domain();
      const xDomain = xScale.domain();
      
      // Filter points to only include those within chart bounds
      const validPoints = points.filter(d => 
        d.x >= xDomain[0] && d.x <= xDomain[1] &&
        d.y >= yDomain[0] && d.y <= yDomain[1]
      );
      
      if (validPoints.length < 2) return; // Need at least 2 points to draw
      
      // Draw the curve
      const line = d3.line()
        .x(d => xScale(d.x))
        .y(d => yScale(d.y))
        .curve(d3.curveCardinal);
        
      chartbody.append("path")
        .datum(validPoints)
        .attr("class", "trend-line")
        .attr("d", line)
        .style("fill", "none")
        .style("stroke", color)
        .style("stroke-width", 3);
    }
  };
  
  // Debounce mechanism
  const [debouncedSelectedRange, setDebouncedSelectedRange] = createSignal(selectedRange());
  const [debouncedCutEvents, setDebouncedCutEvents] = createSignal(cutEvents());
  const [debouncedHasSelection, setDebouncedHasSelection] = createSignal(hasSelection());
  const [debouncedIsCut, setDebouncedIsCut] = createSignal(isCut());
  let updateTimer = null;
  let resizeObserver = null;
  const [zoom, setZoom] = createSignal(false);
  const isZoomed = () => (props.handleZoom ? !!props.zoom : !!zoom());
  let hasSignaledReady = false;
  const signalReadyOnce = () => {
    if (!hasSignaledReady && typeof props.onReady === 'function') {
      hasSignaledReady = true;
      try { props.onReady(); } catch (_) {}
    }
  };

  // Enhanced function to process data using enhanced worker manager
  const processDataWithEnhancedWorker = async (data, chart) => {
    if (!data || data.length === 0) {
      setEnhancedData(null);
      setDataProcessingStats(null);
      return;
    }

    setIsProcessingData(true);
    
    try {
      // Apply global filters before density optimization
      let filteredData = data;
      const inputCount = data.length;
      
      // Only apply global filters if chart doesn't have its own filters
      if (!chart.filters || chart.filters.length === 0) {
        const states = selectedStatesTimeseries();
        const races = selectedRacesTimeseries();
        const legs = selectedLegsTimeseries();
        const grades = selectedGradesTimeseries();
        
        log('🔍 SimpleScatter [processDataWithEnhancedWorker]: Applying global filters before density optimization', {
          chartId: chart?.unique_id,
          inputCount,
          filterStates: states,
          filterRaces: races,
          filterLegs: legs,
          filterGrades: grades,
          beforeFilter: inputCount
        });
        
        // ALWAYS apply applyDataFilter (handles both TWA filters AND selectedRanges/time-based selections)
        filteredData = applyDataFilter(data, states, races, legs, grades);
        
        log('🔍 SimpleScatter [processDataWithEnhancedWorker]: Global filters applied before density optimization', {
          chartId: chart?.unique_id,
          beforeFilter: inputCount,
          afterFilter: filteredData.length,
          filteredOut: inputCount - filteredData.length
        });
      } else {
        log('🔍 SimpleScatter [processDataWithEnhancedWorker]: Chart has specific filters, skipping global filters', {
          chartId: chart?.unique_id,
          inputCount,
          chartFilters: chart.filters
        });
      }

      // Check for selections
      const hasSelections = (debouncedSelectedRange() && debouncedSelectedRange().length > 0) ||
                          (selectedEvents() && selectedEvents().length > 0) ||
                          (debouncedCutEvents() && debouncedCutEvents().length > 0);
      
      // Check point count
      const pointCount = filteredData.length;
      const shouldOptimize = pointCount > 5000;
      const hasOptimization = shouldOptimize && !hasSelections; // Only optimize if > 5000 AND no selections
      // Skip optimization if: we have selections (preserve all points) OR we don't need optimization (< 5000 points)
      const skipOptimization = hasSelections || !shouldOptimize;

      const config = {
        xField: 'x',
        yField: 'y',
        colorField: chart.colorType === 'By Channel' && chart.colorChannel ? chart.colorChannel.name : undefined,
        colorType: props.colortype || 'DEFAULT',
        maxPoints: 3000,
        regressionMethod: chart.fitType || 'None',
        tableRange: { min: 6, max: 20, step: 1 },
        skipOptimization
      };


      // Store the regression method for the drawing effect
      setCurrentRegressionMethod(config.regressionMethod);

      // Get chart unique_id
      const chartUniqueId = props.chart?.unique_id || chart.unique_id;

      // Prepare cache parameters
      const cacheParams = {
        className: persistantStore.selectedClassName(),
        sourceId: persistantStore.selectedSourceId(),
        datasetId: String(persistantStore.selectedDatasetId?.() ?? 0),
        projectId: String(persistantStore.selectedProjectId?.() ?? 0),
        chartFilters: chart.filters || [],
        globalFilters: {
          states: selectedStatesTimeseries(),
          races: selectedRacesTimeseries(),
          legs: selectedLegsTimeseries(),
          grades: selectedGradesTimeseries()
        },
        selectionState: {
          selectedRange: debouncedSelectedRange(),
          selectedEvents: selectedEvents(),
          cutEvents: debouncedCutEvents()
        },
        colorType: props.colortype || 'DEFAULT',
        uniqueId: chartUniqueId
      };

      const result = await enhancedScatterWorkerManager.processEnhancedScatterData(filteredData, config, cacheParams);
      
      // Warn if optimization was expected but didn't reduce point count
      if (hasOptimization && result.optimizationStats.optimizedCount >= result.optimizationStats.originalCount) {
        warn(`[DensityOptimization] Expected optimization for ${pointCount} points but got ${result.optimizationStats.optimizedCount} points (same as original). Performance may be impacted.`);
      }
      
      setEnhancedData(result);
      setDataProcessingStats({
        originalCount: result.optimizationStats.originalCount,
        optimizedCount: result.optimizationStats.optimizedCount,
        groupsProcessed: result.optimizationStats.groupsProcessed,
        enhancedProcessing: true
      });
      
      return result;
    } catch (error: any) {
      logError('Error processing data with enhanced worker:', error);
      // Fallback to original data
      setEnhancedData({
        groups: [{
          groupName: 'ALL',
          color: '#1f77b4',
          data: data,
          density: data.length,
          regression: null,
          tableValues: []
        }],
        totalProcessedCount: data.length,
        totalValidDataCount: data.length,
        optimizationStats: {
          originalCount: data.length,
          optimizedCount: data.length,
          groupsProcessed: 1
        }
      });
      setDataProcessingStats(null);
      return {
        groups: [{
          groupName: 'ALL',
          color: '#1f77b4',
          data: data,
          density: data.length,
          regression: null,
          tableValues: []
        }],
        totalProcessedCount: data.length,
        totalValidDataCount: data.length,
        optimizationStats: {
          originalCount: data.length,
          optimizedCount: data.length,
          groupsProcessed: 1
        }
      };
    } finally {
      setIsProcessingData(false);
    }
  };

  // Enhanced data processing function - applies filtering based on chart-specific vs global filters
  const processChartData = () => {
    try {
      if (!props.chart || !props.chart.series || props.chart.series.length === 0) {
        return [];
      }

      const series = props.chart.series[0];
      
      // Priority: Use series.data if it exists (it's been filtered by applyFiltersToCharts)
      // Only fall back to filtering originalData if series.data doesn't exist
      if (series.data && Array.isArray(series.data)) {
        // Data has been pre-filtered at page level (or is initial data)
        // Selection-based filters (selectedRanges, cutEvents) are handled in the main rendering effect
        log('🔍 SimpleScatter [processChartData]: Using pre-filtered series.data', {
          dataLength: series.data.length,
          originalDataLength: series.originalData?.length || 0,
          chartId: props.chart?.unique_id
        });
        return series.data;
      }
      
      // Fallback: Use originalData and apply filters
      if (!series.originalData || series.originalData.length === 0) {
        debug('🔍 SimpleScatter: No data available (no series.data or originalData)');
        return [];
      }

      const originalCount = series.originalData.length;
      
      // Apply filtering logic: chart-specific filters take precedence over global filters
      let filteredData;
      
      if (props.chart.filters && props.chart.filters.length > 0) {
        // Chart has its own filters - apply only those
        log('🔍 SimpleScatter [processChartData]: Applying chart-specific filters', {
          chartId: props.chart?.unique_id,
          filters: props.chart.filters,
          originalCount,
          beforeFilter: originalCount
        });
        filteredData = filterByTwa(series.originalData, props.chart.filters, [], [], []);
        log('🔍 SimpleScatter [processChartData]: Chart-specific filters applied', {
          chartId: props.chart?.unique_id,
          filters: props.chart.filters,
          beforeFilter: originalCount,
          afterFilter: filteredData.length,
          filteredOut: originalCount - filteredData.length
        });
      } else {
        // No chart-specific filters - ALWAYS apply applyDataFilter
        // (handles both TWA filters AND selectedRanges/time-based selections)
        const states = selectedStatesTimeseries();
        const races = selectedRacesTimeseries();
        const legs = selectedLegsTimeseries();
        const grades = selectedGradesTimeseries();
        
        log('🔍 SimpleScatter [processChartData]: Applying global filters via applyDataFilter', {
          chartId: props.chart?.unique_id,
          originalCount,
          filterStates: states,
          filterRaces: races,
          filterLegs: legs,
          filterGrades: grades,
          beforeFilter: originalCount
        });
        
        filteredData = applyDataFilter(series.originalData, states, races, legs, grades);
        
        log('🔍 SimpleScatter [processChartData]: Global filters applied', {
          chartId: props.chart?.unique_id,
          beforeFilter: originalCount,
          afterFilter: filteredData.length,
          filteredOut: originalCount - filteredData.length,
          filterStates: states,
          filterRaces: races,
          filterLegs: legs,
          filterGrades: grades
        });
      }

      debug('🔍 SimpleScatter: Applied filters to originalData (length:', filteredData.length, ')');
      return filteredData;
    } catch (error: any) {
      logError('Error processing chart data:', error);
      return [];
    }
  };
  
  // Debounce updates with 250ms delay; when selection/range is cleared, update immediately so cache reflects no selection
  const debounceUpdate = (immediate = false) => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    const apply = () => {
      setDebouncedSelectedRange(selectedRange());
      setDebouncedCutEvents(cutEvents());
      setDebouncedHasSelection(hasSelection());
      setDebouncedIsCut(isCut());
    };
    if (immediate) {
      apply();
    } else {
      updateTimer = setTimeout(() => {
        apply();
        updateTimer = null;
      }, 250);
    }
  };
  
  // Watch for chart changes and fetch data
  createEffect(() => {
    // Explicitly track the chart prop to ensure reactivity
    const chart = props.chart;
    const series = chart?.series?.[0];
    // Use axis names as primary identity so switching scatter objects (different x/y axes) clears state.
    // unique_id from API can be the same across different scatter charts.
    const chartId = (series?.xaxis?.name && series?.yaxis?.name)
      ? `${series.xaxis.name}_${series.yaxis.name}`
      : (chart?.unique_id || 'unknown');
    
    // CRITICAL: Clear all data state when chart changes to prevent stale data
    // This ensures we don't show data from the previous chart
    if (chartId !== lastProcessedChartId && lastProcessedChartId !== undefined) {
      debug('🔍 SimpleScatter: Chart changed, clearing previous data', {
        oldChartId: lastProcessedChartId,
        newChartId: chartId
      });
      setChartData(null);
      setEnhancedData(null);
      setDataProcessingStats(null);
      setRegressionResults({});
      setFitData([]);
      setFitDataVersion(prev => prev + 1);
      setActualRenderedCount(0);
      setScatterRendered(false);
    }
    
    // Update last processed chart ID
    lastProcessedChartId = chartId;
    
    if (chart && chart.series && chart.series.length > 0) {
      const series = chart.series[0];
      // Explicitly track data and originalData arrays to ensure reactivity
      // Accessing .length ensures we track array changes
      const seriesDataLength = series?.data?.length ?? 0;
      const originalDataLength = series?.originalData?.length ?? 0;
      // Track the data array reference itself to detect when it changes
      const seriesDataRef = series?.data;
      const originalDataRef = series?.originalData;
      
      debug('🔍 SimpleScatter: Chart data effect triggered', {
        chartId: chart.unique_id || chartId,
        seriesDataLength,
        originalDataLength,
        dataIsOriginal: seriesDataRef === originalDataRef,
        hasData: !!seriesDataRef,
        hasOriginalData: !!originalDataRef
      });
      
      // Process chart data (will use series.data if it's been pre-filtered, otherwise filter originalData)
      const data = processChartData();
      debug('🔍 SimpleScatter: Processed chart data length:', data.length);
      setChartData(data);
    } else {
      // No chart data - clear state
      setChartData(null);
    }
  });

  // DISABLED: Watch for filter changes and re-process data
  // Filters now only apply when Apply button is clicked in PageSettings
  // This prevents immediate updates when filters are changed in the UI
  /*
  createEffect(() => {
    if (props.chart && props.chart.series && props.chart.series.length > 0) {
      // Track all filter signals to ensure reactivity
      const states = selectedStatesTimeseries();
      const races = selectedRacesTimeseries();
      const legs = selectedLegsTimeseries();
      const grades = selectedGradesTimeseries();
      
      // Re-process data when filters change (this will trigger regression recalculation)
      const data = processChartData();
      setChartData(data);
    }
  });
  */


  // Watch for selection changes and debounce them
  // Set up resize observer for container size changes and window resize listener
  createEffect(() => {
    // Wait for chartRef to be available
    if (!chartRef) {
      debug('🔍 SimpleScatter: Resize observer effect - chartRef not available yet');
      return;
    }
    
    debug('🔍 SimpleScatter: Setting up ResizeObserver and window resize listener');
    
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
          const newWidth = entry.contentRect.width;
          const newHeight = entry.contentRect.height;
          debug('🔍 SimpleScatter: ResizeObserver detected size change:', { 
            width: newWidth, 
            height: newHeight 
          });
          setContainerSize({
            width: newWidth,
            height: newHeight
          });
        }
      });
      resizeObserver.observe(chartRef);
      debug('🔍 SimpleScatter: ResizeObserver attached to chartRef');
      
      // Set initial size
      const initialWidth = chartRef.clientWidth;
      const initialHeight = chartRef.clientHeight;
      debug('🔍 SimpleScatter: Setting initial container size:', { 
        width: initialWidth, 
        height: initialHeight
      });
      setContainerSize({
        width: initialWidth,
        height: initialHeight
      });
    } else {
      warn('🔍 SimpleScatter: ResizeObserver not supported in this browser');
    }
    
    // Add window resize listener for viewport height changes
    // Only update if chartRef is actually mounted and visible
    const handleWindowResize = () => {
      const newHeight = window.innerHeight;
      
      // Only update if chartRef exists and is visible (has dimensions)
      if (!chartRef) return;
      
      const newWidth = chartRef.clientWidth;
      const newContainerHeight = chartRef.clientHeight;
      
      // Only log and update if dimensions are valid
      if (newWidth > 0 || newContainerHeight > 0) {
        debug('🔍 SimpleScatter: Window resize detected, new viewport height:', newHeight);
        debug('🔍 SimpleScatter: Updating container size on window resize:', { 
          width: newWidth, 
          height: newContainerHeight 
        });
        setViewportHeight(newHeight);
        setContainerSize({
          width: newWidth,
          height: newContainerHeight
        });
      }
      // Silently skip if dimensions are 0 (component not visible/mounted)
    };
    window.addEventListener('resize', handleWindowResize);
    debug('🔍 SimpleScatter: Window resize listener attached');
    
    return () => {
      debug('🔍 SimpleScatter: Cleaning up ResizeObserver and window resize listener');
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      window.removeEventListener('resize', handleWindowResize);
    };
  });

  createEffect(() => {
    // When "Filter by selection" is off, skip so we don't trigger re-render/flash on map selection
    if (!persistantStore.filterChartsBySelection()) return;
    // Track all selection-related signals
    const range = selectedRange();
    const ranges = selectedRanges(); // Track selectedRanges for reactivity
    const cuts = cutEvents();
    const hasSel = hasSelection();
    const isCutVal = isCut();
    
    try {
      log('SimpleScatter: Selection effect triggered', { 
        rangeLen: range?.length || 0, 
        rangesLen: ranges?.length || 0, 
        cutsLen: cuts?.length || 0,
        hasSel,
        isCutVal 
      });
    } catch {}
    
    // Track chart changes
    props.chart;
    
    // When range/ranges are cleared, update debounced values immediately and invalidate cache so we don't show stale filtered data
    const rangeCleared = (!range || range.length === 0) && (!ranges || ranges.length === 0);
    if (rangeCleared) {
      debounceUpdate(true);
      setEnhancedData(null);
      setLastProcessedCacheKey(null);
    } else {
      debounceUpdate(false);
    }
  });

    // Main chart rendering effect - only responds to debounced values
  createEffect(async () => {
    // Make sure we're reactive to chart changes, container size, viewport height, color type, and zoom state
    // NOTE: Scale factor changes are handled by CSS transform only - we don't want to redraw on scale changes
    // NOTE: Filters are now only applied when Apply button is clicked, so we don't watch filterState here
    const currentChart = props.chart;
    const size = containerSize(); // Track container size changes
    const vh = viewportHeight(); // Track viewport height changes
    const fetchedData = chartData(); // Track chart data changes
    const currentRegressionResults = regressionResults(); // Track regression results changes
    const currentColorType = props.colortype; // Track color type changes
    const zoomed = isZoomed(); // Track zoom state changes
    
    // Get current filter state for cache key calculation (but don't react to changes)
    // Filters are applied at the page level before data reaches SimpleScatter
    const filterState = {
      states: selectedStatesTimeseries(),
      races: selectedRacesTimeseries(),
      legs: selectedLegsTimeseries(),
      grades: selectedGradesTimeseries()
    };
    
    // Track chart-specific filters to ensure reactivity
    const chartFilters = currentChart?.filters || [];
    
    if (!currentChart || !currentChart.series || currentChart.series.length === 0) {
      debug('🔍 SimpleScatter: No chart or series data available');
      return;
    }
    
    const chart = currentChart.series[0];
    // Prefer current chart's series data so we never render with stale data when switching charts.
    // fetchedData (chartData()) can lag one tick when props.chart changes, causing wrong scales/labels.
    let data = chart.data ?? fetchedData ?? [];
    
    // Use enhanced data if available, otherwise use original data
    // We'll define renderData after checking for cache and processing data
    
    // If colorType is By Channel and colorChannel data is not in the data, fetch it
    if (chart.colorType === 'By Channel' && chart.colorChannel && chart.colorChannel.name) {
      // Check if colorChannel data is already present
      const hasColorChannelData = data.length > 0 && data[0][chart.colorChannel.name] !== undefined;
      
      if (!hasColorChannelData) {
        // For now, we'll assume the data needs to be fetched
        // In a real implementation, this would trigger a data fetch
      }
    }

    // Get regression method; only show when explicitly specified in chart config
    let regressionMethod = (() => {
      const configured = chart.fitType;
      // Only show regression if explicitly specified in chart configuration
      if (configured && configured !== "None") {
        return configured;
      }
      return "None"; // No regressions unless explicitly configured
    })(); // Options: "None", "Linear", "Poly 2", "Poly 3", "Loess"

    // Use ONLY debounced values for rendering
    const currentSelectedRange = debouncedSelectedRange();
    const currentCutEvents = debouncedCutEvents();
    const currentHasSelection = debouncedHasSelection();
    const currentIsCut = debouncedIsCut();

    const xymargin = { top: 20, right: 30, bottom: 50, left: 60 }; // Margins
    
    // Get actual dimensions - prefer containerSize from ResizeObserver (most reliable)
    // but fall back to direct measurement if needed
    const containerSizeData = size;
    let refWidth = containerSizeData.width > 0 
      ? containerSizeData.width 
      : (chartRef?.clientWidth || chartRef?.offsetWidth || 0);
    let refHeight = containerSizeData.height > 0 
      ? containerSizeData.height 
      : (chartRef?.clientHeight || chartRef?.offsetHeight || 0);
    
    // If dimensions are still 0, defer measurement to avoid forced reflow
    // Use defaults and let the next render cycle handle it properly
    // This avoids the forced reflow warning - dimensions will be correct on next render
    
    // If still 0, try to get dimensions from parent container or use defaults
    if (refWidth <= 0 || refHeight <= 0) {
      if (chartRef?.parentElement) {
        const parent = chartRef.parentElement;
        refWidth = parent.clientWidth || refWidth;
        refHeight = parent.clientHeight || refHeight;
      }
      
      // Last resort: use reasonable defaults if container still has no dimensions
      // This can happen during initial render before layout is complete
      if (refWidth <= 0) {
        refWidth = containerRef?.clientWidth || window.innerWidth * 0.8 || 800;
      }
      if (refHeight <= 0) {
        refHeight = 400; // Default height for probability charts
      }
    }
    
    let xywidth = refWidth - xymargin.left - xymargin.right;
    let xyheight = 400 - xymargin.top - xymargin.bottom;

    if (isZoomed()) {
      // When zoomed, use container's height but cap to a reasonable max to avoid overflows
      xywidth = refWidth - xymargin.left - xymargin.right;
      const fallbackZoomHeight = 700;
      const containerHeight = refHeight || fallbackZoomHeight;
      const cappedHeight = Math.min(containerHeight, 700);
      xyheight = cappedHeight - xymargin.top - xymargin.bottom;
    } else if (props.class_name == 'col1') {
      xywidth = refWidth - xymargin.left - xymargin.right;
      
      // If there's only one chart, use 75% of viewport height
      if (props.totalCharts === 1) {
        let scaledHeight = vh * 0.75;
        xyheight = scaledHeight - xymargin.top - xymargin.bottom;
      } else {
        // Smart scaling: use 75% of viewport height, with min 400px and max 1200px
        let scaledHeight = Math.max(400, Math.min(1200, vh * 0.75));
        xyheight = (refHeight || scaledHeight) - xymargin.top - xymargin.bottom;
      }
    } else if (props.class_name == 'col2') {
      xywidth = refWidth - xymargin.left - xymargin.right
      xyheight = 600 - xymargin.top - xymargin.bottom;
    } else if (props.class_name == 'col3') {
      xywidth = refWidth - xymargin.left - xymargin.right
      xyheight = (refHeight || 400) - xymargin.top - xymargin.bottom;
    }
    
    // Validate dimensions before proceeding - if invalid, skip rendering
    if (!chartRef || xywidth <= 0 || xyheight <= 0) {
      debug('🔍 SimpleScatter: Invalid chart dimensions, skipping render', { 
        chartRef: !!chartRef, 
        xywidth, 
        xyheight,
        refWidth,
        refHeight
      });
      return;
    } 

    let make_x_gridlines = (xScale) => {
        return d3.axisBottom(xScale).ticks(5).tickFormat(myTickFormat)
    }

    let make_y_gridlines = (yScale) => {
        return d3.axisLeft(yScale).ticks(5).tickFormat(myTickFormat)
    }

    // Clear previous content
    d3.select(chartRef).selectAll("*").remove(); 

    const svg = d3
      .select(chartRef)
      .append("svg")
      .attr("width", xywidth + xymargin.left + xymargin.right)
      .attr("height", xyheight + xymargin.top + xymargin.bottom)
      .on("dblclick", () => {
        // If parent provided a zoom handler, delegate like PerfScatter
        if (props.handleZoom) {
          let info = props.chart || null;
          if (props.zoom) { // if already zoomed, dblclick should exit
            info = null;
          }
          props.handleZoom(info);
        } else {
          // Fallback to local zoom behavior
          setZoom(!zoom());
        }
      });
    
    addSelection(svg);

    const chartbody = svg
      .append("g")
      .attr("transform", `translate(${xymargin.left}, ${xymargin.top})`);
    
    addSelection(chartbody);

    // Scales
    const cScale = d3.scaleLinear()
      .domain([40, 90, 160])
      .range(["blue", "orange", "red"]);

    // Check if we already have enhanced data - if so, skip processing
    const currentEnhancedResult = enhancedData();
    
    // Compute current cache key using the same algorithm as the worker manager
    // Use axis names as primary chart identity so different scatter objects (different x/y axes) never share cache.
    // unique_id from API can be the same across different scatter charts, causing wrong data to persist after switching.
    const chartUniqueId = (chart.xaxis?.name && chart.yaxis?.name)
      ? `${chart.xaxis.name}_${chart.yaxis.name}`
      : (currentChart?.unique_id ?? undefined);
    // Only include selection in cache key when "Filter by selection" is on; otherwise selection changes won't trigger re-process
    const filterBySelection = persistantStore.filterChartsBySelection();
    const selectionStateForCache = filterBySelection
      ? { selectedRange: debouncedSelectedRange(), selectedEvents: selectedEvents(), cutEvents: debouncedCutEvents() }
      : { selectedRange: [], selectedEvents: [], cutEvents: [] };
    const currentCacheKey = createDensityOptimizationCacheKey(
      persistantStore.selectedClassName() || '',
      persistantStore.selectedSourceId() || '',
      currentColorType || 'DEFAULT',
      regressionMethod,
      chartFilters,
      filterState,
      selectionStateForCache,
      chartUniqueId
    );
    const cacheKeyChanged = lastProcessedCacheKey() !== null && lastProcessedCacheKey() !== currentCacheKey;
    
    // Only process if we don't have enhanced data yet OR if cache key actually changed (not on first load)
    // ALSO check if we're not already processing to prevent race conditions
    let finalEnhancedResult = null;
    if ((!currentEnhancedResult || cacheKeyChanged) && data.length > 0 && !isProcessingData()) {
      // Reset scatter rendered flag since we're processing new data
      setScatterRendered(false);
      
      // Await the processing to ensure we have the data before rendering
      const result = await processDataWithEnhancedWorker(data, chart);
      setEnhancedData(result);
      setLastProcessedCacheKey(currentCacheKey);
      
      // Use the result directly instead of reading from signal
      finalEnhancedResult = result;
      
      // Signal readiness so parent can hide loading
      signalReadyOnce();
    } else {
      // Use existing enhanced data
      finalEnhancedResult = currentEnhancedResult;
    }
    
    // CRITICAL: Never render without optimized data - wait for it
    if (!finalEnhancedResult && data.length > 0) {
      return;
    }
    
    // No points (e.g. missing file channels) — parent must hide loading overlay; there is no worker/render completion path
    if (!finalEnhancedResult) {
      signalReadyOnce();
      return;
    }
    
    // Determine renderData from enhanced result ONLY
    const renderData = finalEnhancedResult.groups.flatMap(group => group.data);
    

    // Now apply range/cut filtering to renderData only when "Filter by selection" is enabled
    let filteredData = renderData;
    const renderDataCount = renderData.length;
    
    log('🔍 SimpleScatter [render]: Starting range/cut filtering', {
      chartId: currentChart?.unique_id,
      renderDataCount,
      filterBySelection,
      hasSelection: currentHasSelection,
      selectedRangeCount: currentSelectedRange?.length || 0,
      isCut: currentIsCut,
      cutEventsCount: currentCutEvents?.length || 0
    });
    
    if (filterBySelection) {
      // Apply range filtering if there's a selection
      if (currentHasSelection && currentSelectedRange.length > 0) {
        const rangeItem = currentSelectedRange[0];
        if (rangeItem.start_time && rangeItem.end_time) {
          const startTime = new Date(rangeItem.start_time);
          const endTime = new Date(rangeItem.end_time);
          
          log('🔍 SimpleScatter [render]: Applying selectedRange filter', {
            chartId: currentChart?.unique_id,
            beforeFilter: renderDataCount,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString()
          });
          
          filteredData = renderData.filter(d => {
            const datetime = new Date(d.Datetime);
            return datetime >= startTime && datetime <= endTime;
          });
          
          log('🔍 SimpleScatter [render]: SelectedRange filter applied', {
            chartId: currentChart?.unique_id,
            beforeFilter: renderDataCount,
            afterFilter: filteredData.length,
            filteredOut: renderDataCount - filteredData.length
          });
        }
      }
      // If no selected range, check for cut events - handle multiple cut ranges
      else if (currentIsCut && currentCutEvents.length > 0) {
        log('🔍 SimpleScatter [render]: Applying cutEvents filter', {
          chartId: currentChart?.unique_id,
          beforeFilter: renderDataCount,
          cutEventsCount: currentCutEvents.length,
          cutRanges: currentCutEvents.map(c => ({
            start: c.start_time,
            end: c.end_time
          }))
        });
        
        filteredData = renderData.filter(d => {
          const datetime = new Date(d.Datetime);
          return currentCutEvents.some(range => {
            // Handle both time range objects and event IDs (for backward compatibility)
            if (typeof range === 'number') {
              return false; // Skip if it's an event ID instead of a time range
            }
            if (range.start_time && range.end_time) {
              const startTime = new Date(range.start_time);
              const endTime = new Date(range.end_time);
              return datetime >= startTime && datetime <= endTime;
            }
            return false;
          });
        });
        
        log('🔍 SimpleScatter [render]: CutEvents filter applied', {
          chartId: currentChart?.unique_id,
          beforeFilter: renderDataCount,
          afterFilter: filteredData.length,
          filteredOut: renderDataCount - filteredData.length
        });
      } else {
        log('🔍 SimpleScatter [render]: No range/cut filtering applied, using all renderData', {
          chartId: currentChart?.unique_id,
          renderDataCount
        });
      }
    } else {
      log('🔍 SimpleScatter [render]: Filter by selection is off, using all renderData', {
        chartId: currentChart?.unique_id,
        renderDataCount
      });
    }

    // Now calculate extents with 1% buffer
    // IMPORTANT: Use renderData (full dataset) for scale calculation, not filteredData
    // This ensures axes remain consistent when selections change
    const yValues = renderData.map((d) => d.y).filter(val => val !== null && val !== undefined && !isNaN(val));
    const yExtent = yValues.length > 0 ? d3.extent(yValues) : [0, 1];
    const yRange = yExtent[1] - yExtent[0];
    const yBuffer = yRange * 0.01;
    
    const xValues = renderData.map((d) => d.x).filter(val => val !== null && val !== undefined && !isNaN(val));
    const xExtent = xValues.length > 0 ? d3.extent(xValues) : [0, 1];
    const xRange = xExtent[1] - xExtent[0];
    const xBuffer = xRange * 0.01;
    
    // Scale calculations completed
    
    const yScale = d3
      .scaleLinear()
      .domain([yExtent[0] - yBuffer, yExtent[1] + yBuffer])
      .range([xyheight, 0]);

    const xScale = d3
      .scaleLinear()
      .domain([xExtent[0] - xBuffer, xExtent[1] + xBuffer])
      .range([0, xywidth]);

    // Store scales for regression drawing
    setCurrentScales({ xScale, yScale });

    // Color channel scale for By Channel colorType
    let colorChannelScale = null;
    if (chart.colorType === 'By Channel' && chart.colorChannel && chart.colorChannel.name) {
      // Calculate domain from colorChannel data (use filteredData now that it's defined)
      const colorValues = filteredData
        .map(d => d[chart.colorChannel.name])
        .filter(val => val !== undefined && val !== null && !isNaN(val) && isFinite(val));
      
      if (colorValues.length > 0) {
        const colorExtent = d3.extent(colorValues);
        colorChannelScale = d3.scaleSequential()
          .domain(colorExtent)
          .interpolator(d3.interpolateRainbow); // Use d3 rainbow interpolator
      }
    }

    // Add Y-axis
    const yAxis = chartbody.append("g")
        .attr("class", "axes")
        .attr("transform", "translate(0, 0)")
        .call(d3.axisLeft(yScale).ticks(5).tickFormat(myTickFormat));
    addSelection(yAxis);

    // Add X-axis
    const xAxis = chartbody.append("g")
          .attr("class", "axes")
          .attr("transform", "translate(0," + xyheight + ")")
          .call(d3.axisBottom(xScale).ticks(5).tickFormat(myTickFormat));
    addSelection(xAxis);

    // Add Axis labels
    // Y-axis label: move to upper left (10, 10)
    chartbody
      .append("text")
      .attr("class", "y-label chart-element")
      .attr("text-anchor", "start")
      .attr("x", 60)
      .attr("y", 10)
      .attr("font-size", "20px")
      .text(chart.yaxis.name || "Y-Axis");

    // X-axis label: keep as is
    chartbody
      .append("text")
      .attr("class", "x-label chart-element")
      .attr("text-anchor", "middle")
      .attr("transform", `translate(${xywidth / 2}, ${xyheight + xymargin.bottom - 10})`)
      .attr("font-size", "20px")
      .text(chart.xaxis.name || "X-Axis");

    // Add background grid lines
    const xGrid = chartbody.append("g")
      .attr("class", "grid")
      .attr("transform", "translate(0," + xyheight + ")")
      .style("stroke-dasharray", ("3,3"))
      .call(make_x_gridlines(xScale)
        .tickSize(-xyheight)
        .tickFormat(""));
    addSelection(xGrid);

    const yGrid = chartbody.append("g")
      .attr("class", "grid")
      .attr("transform", "translate(0, 0)")
      .style("stroke-dasharray", ("3,3"))
      .call(make_y_gridlines(yScale)
        .tickSize(-xywidth)
        .tickFormat(""));
    addSelection(yGrid);

    // Update color function to handle new colorType properties
    function getColor(series, d) {
      // Get colortype from props, defaulting to 'DEFAULT' if not specified
      const colortype = (props as any).colortype || 'DEFAULT';
      
      // When colortype is DEFAULT (or undefined), use the series colorType from chart configuration
      if (colortype === 'DEFAULT') {
        // Use series colorType directly (don't fall back to props.colortype)
        const seriesColorType = series.colorType || 'Fixed'; // Default to 'Fixed' if not specified
        
        if (seriesColorType === 'Fixed') {
          // Use the fixed color from series configuration
          // Default to a visible color if not specified (use d3 category10 first color)
          return series.color || d3.schemeCategory10[0];
        } else if (seriesColorType === 'By Channel') {
          // Use colorChannel data for coloring
          if (series.colorChannel && series.colorChannel.name && d[series.colorChannel.name] !== undefined) {
            const colorValue = d[series.colorChannel.name];
            if (!isNaN(colorValue) && isFinite(colorValue) && colorChannelScale) {
              return colorChannelScale(colorValue);
            }
          }
          // Fallback to series color if channel value is invalid or scale not available
          return series.color || d3.schemeCategory10[0];
        }
        // Fallback for unknown colorType
        return series.color || d3.schemeCategory10[0];
      } else if (colortype === 'TACK') {
        const twaChannelName = defaultChannelsStore.twaName();
        const twaValue = d[twaChannelName] ?? d.Twa;
        return twaValue > 0 ? "green" : "red";
      } else if (colortype === 'GRADE') {
        // Use normalized field name first (unifiedDataStore normalizes metadata)
        const grade = d.grade ?? d.Grade ?? d.GRADE;
        if (grade === 0) return "lightgray";
        if (grade === 1) return "red";
        if (grade === 2) return "lightgreen";
        if (grade === 3) return "darkgreen";
        return "lightgray"; // fallback for undefined grades
      } else if (colortype === 'UW/DW') {
        const twaChannelName = defaultChannelsStore.twaName();
        const twaValue = d[twaChannelName] ?? d.Twa;
        const absTwa = Math.abs(twaValue || 0);
        if (absTwa < 75) return "blue";
        else if (absTwa >= 75 && absTwa <= 120) return "orange";
        else return "purple";
      } else {
        // Fallback for other colortypes - try to use TWA-based coloring if available
        const twaChannelName = defaultChannelsStore.twaName();
        const twaValue = d[twaChannelName] ?? d.Twa;
        if (twaValue !== undefined && cScale) {
          return cScale(Math.abs(twaValue));
        }
        // Final fallback
        return series.color || d3.schemeCategory10[0];
      }
    }


    const mouseover = (event, d) => {
        const tooltipContent = getTooltipContent(d); 
        
        // Get the scale factor from CSS custom property
        const scaleFactor = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')) || 1;
        
        // Calculate adjusted position accounting for scaling
        const adjustedX = event.clientX + (10 / scaleFactor) - (100 / scaleFactor); // Move left 100px from current position (scaled)
        const adjustedY = event.clientY - (10 / scaleFactor); // Small offset above cursor (scaled)
        
        // Use local tooltip state to avoid conflicts with other components
        setLocalTooltip({
            visible: true,
            content: tooltipContent,
            x: adjustedX,
            y: adjustedY
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
        
        // Get the scale factor from CSS custom property
        const scaleFactor = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')) || 1;
        
        // Calculate adjusted position accounting for scaling
        const adjustedX = event.clientX + (10 / scaleFactor) - (100 / scaleFactor); // Move left 100px from current position (scaled)
        const adjustedY = event.clientY - (10 / scaleFactor); // Small offset above cursor (scaled)
        
        // Use local tooltip state to avoid conflicts with other components
        setLocalTooltip({
            visible: true,
            content: tooltipContent,
            x: adjustedX,
            y: adjustedY
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

    const click = (event, d) => {
        // Set the selected time when a point is clicked
        if (d.Datetime) {
            try {
                const clickedTime = new Date(d.Datetime);
                if (!isNaN(clickedTime.getTime())) {
                    // Request control of selectedTime
                    if (requestTimeControl('scatter')) {
                        setSelectedTime(clickedTime, 'scatter');
                        debug('🔍 SimpleScatter: Selected time set to:', clickedTime.toISOString());
                        
                        // Release time control after setting the time
                        setTimeout(() => {
                            releaseTimeControl('scatter');
                        }, 100);
                    } else {
                        debug('🔍 SimpleScatter: Time control denied - another component has higher priority');
                    }
                }
            } catch (error: any) {
                logError('Error setting selected time:', error);
            }
        }
    };

    const getTooltipContent = (point) => {
      if (!point) return "";
      
      // Check if Datetime exists and is valid
      let timeString = "N/A";
      if (point.Datetime) {
        try {
          const date = point.Datetime instanceof Date ? point.Datetime : new Date(point.Datetime);
          if (!isNaN(date.getTime())) {
            const timezone = point.timezone || datasetTimezone() || undefined;
            timeString = formatTime(date, timezone) || "N/A";
          }
        } catch (error: any) {

        }
      }
      
      let tooltipRows = [
        `<tr><td>TIME</td><td>${timeString}</td></tr>`,
        `<tr><td>${chart.xaxis.name.toUpperCase()}</td><td>${parseFloat(point.x || 0).toFixed(1)}</td></tr>`,
        `<tr><td>${chart.yaxis.name.toUpperCase()}</td><td>${parseFloat(point.y || 0).toFixed(1)}</td></tr>`
      ];
      
      // Add density information for clusters
      if (point.isCluster && point.density) {
        tooltipRows.push(`<tr><td>DENSITY</td><td>${point.density} pts</td></tr>`);
      }
      
      return `<table class='table-striped'>${tooltipRows.join('')}</table>`;  
    };

    // Function to generate info tooltip content
    const getInfoTooltipContent = () => {
      const stats = dataProcessingStats();
      
      let tooltipRows = [];
      
      if (stats && stats.enhancedProcessing) {
        tooltipRows.push(`<tr><td colspan="2"><strong>DENSITY OPTIMIZATION</strong></td></tr>`);
        tooltipRows.push(`<tr><td>ORIGINAL POINTS</td><td>${stats.originalCount}</td></tr>`);
        tooltipRows.push(`<tr><td>OPTIMIZED POINTS</td><td>${stats.optimizedCount}</td></tr>`);
        tooltipRows.push(`<tr><td>GROUPS PROCESSED</td><td>${stats.groupsProcessed}</td></tr>`);
      }
      
      return `<table class='table-striped'>${tooltipRows.join('')}</table>`;
    };

    // Update the circles to reflect selection state with enhanced group rendering
    // Use filteredData so only selected points are visible
    const circles = chartbody
      .selectAll("circle")
      .data(filteredData || []);
    
    // Remove exiting circles
    circles.exit().remove();
    
    // Track the actual rendered count for the label
    setActualRenderedCount(filteredData ? filteredData.length : 0);
    
    const circlesEnter = circles.enter()
      .append("circle")
      .attr("class", "xy-circle")
      .attr("cx", (d) => {
        const x = xScale(d.x);
        return x;
      }) 
      .attr("cy", (d) => {
        const y = yScale(d.y);
        return y;
      }) 
      .style("r", (d) => {
        // Increase circle size based on density, max 4x current size (4px base for better visibility)
        const baseRadius = 4;
        const maxRadius = baseRadius * 4; // 16px max
        
        if (d.density && d.density > 1) {
          // Scale radius based on density, but cap at maxRadius
          const densityScale = Math.min(d.density / 10, 3); // Scale factor based on density
          return Math.min(baseRadius + densityScale, maxRadius);
        }
        
        return baseRadius; // Default size
      })
      .style("fill", (d) => getColor(chart, d)) 
      .style("opacity", d => {
        // Use optimized opacity from enhanced processing
        if (d.opacity !== undefined) {
          return 1;
        }
        return 0.6; // Increased default opacity for better visibility
      })
      .style("stroke", "white")
      .style("stroke-width", 1)
      .style("stroke-opacity", 1)
      .style("pointer-events", "all") // Explicitly enable pointer events
      .style("cursor", "pointer") // Show pointer cursor
      .on("mouseover", mouseover)
      .on("mouseout", mouseout)
      .on("mousemove", mousemove)
      .on("click", click);
    
    addSelection(circlesEnter);
    
    // Update existing circles (merge enter selection with update selection)
    circles.merge(circlesEnter)
      .attr("cx", (d) => {
        const x = xScale(d.x);
        return x;
      }) 
      .attr("cy", (d) => {
        const y = yScale(d.y);
        return y;
      })
      .style("fill", (d) => getColor(chart, d))
      .style("opacity", d => {
        if (d.opacity !== undefined) {
          return 1;
        }
        return 0.6; // Increased default opacity for better visibility
      })
      .style("stroke", "white")
      .style("stroke-width", 1)
      .style("stroke-opacity", 1);

    // Lasso functionality removed for performance optimization

    // Determine color type for regression lines
    const colorType = chart.colorType || props.colortype;
    
    // Update table data from enhanced groups
    if (finalEnhancedResult && finalEnhancedResult.groups.length > 0) {
      const tableFits = [];
      finalEnhancedResult.groups.forEach(group => {
        if (group.tableValues && group.tableValues.length > 0) {
          const fitPoints = group.tableValues.map(tv => ({ x: tv.x, y: tv.y }));
          tableFits.push({ 
            group: group.groupName, 
            color: group.color, 
            fitValues: fitPoints, 
            pointCount: group.density 
          });
        }
      });
      
      if (tableFits.length > 0) {
        setFitData(tableFits);
        setFitDataVersion(v => v + 1);
      }
    }

    // Add info icon to bottom right corner
    const infoIcon = chartbody.append("g")
      .attr("class", "info-icon")
      .attr("transform", `translate(${xywidth - 20}, ${xyheight - 20})`)
      .style("cursor", "pointer");
    
    addSelection(infoIcon);
    
    // Add circle background for info icon
    infoIcon.append("circle")
      .attr("r", 12)
      .style("fill", isDark() ? "rgba(255, 255, 255, 0.9)" : "rgba(0, 0, 0, 0.9)")
      .style("stroke", isDark() ? "rgba(255, 255, 255, 0.7)" : "rgba(0, 0, 0, 0.7)")
      .style("stroke-width", 1);
    
    // Add "i" text
    infoIcon.append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("font-size", "14px")
      .attr("font-weight", "bold")
      .attr("font-family", "Arial, sans-serif")
      .style("fill", isDark() ? "black" : "white")
      .style("user-select", "none")
      .text("i");
    
    // Add mouse events for info icon
    infoIcon
      .on("mouseover", (event) => {
        const tooltipContent = getInfoTooltipContent();
        
        // Get the scale factor from CSS custom property
        const scaleFactor = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale-factor')) || 1;
        
        // Calculate adjusted position accounting for scaling
        const adjustedX = event.clientX - (100 / scaleFactor); // Move left 100px (scaled)
        const adjustedY = event.clientY - (200 / scaleFactor); // Move up 200px (scaled)
        
        setInfoTooltip({
          visible: true,
          content: tooltipContent,
          x: adjustedX,
          y: adjustedY
        });
      })
      .on("mouseout", () => {
        setInfoTooltip({
          visible: false,
          content: "",
          x: 0,
          y: 0
        });
      });

    // Draw regression lines if applicable, right here at the end of render with valid scales
    // IMPORTANT: Only draw if scales were created with the current dimensions (not stale)
    if (regressionMethod !== "None" && finalEnhancedResult && finalEnhancedResult.groups && xScale && yScale) {
      const chartbody = d3.select(chartRef).select("g");
      if (!chartbody.empty()) {
        // Validate that scales have valid ranges
        const yRange = yScale.range();
        const xRange = xScale.range();
        const hasValidYRange = yRange && yRange.length === 2 && Math.abs(yRange[1] - yRange[0]) > 10;
        const hasValidXRange = xRange && xRange.length === 2 && Math.abs(xRange[1] - xRange[0]) > 10;
        
        // CRITICAL: Ensure scale ranges match the current xywidth/xyheight
        // This prevents drawing with scales created from stale/wrong dimensions
        const scaleMatchesDimensions = 
          Math.abs(xRange[1] - xywidth) < 1 && 
          Math.abs(Math.abs(yRange[0] - yRange[1]) - xyheight) < 1;
        
        // Also verify the SVG itself has the correct dimensions
        const svg = d3.select(chartRef).select("svg");
        const svgWidth = svg.attr("width") ? parseFloat(svg.attr("width")) - xymargin.left - xymargin.right : 0;
        const svgHeight = svg.attr("height") ? parseFloat(svg.attr("height")) - xymargin.top - xymargin.bottom : 0;
        const svgMatchesDimensions = 
          Math.abs(svgWidth - xywidth) < 1 && 
          Math.abs(svgHeight - xyheight) < 1;
        
        if (hasValidYRange && hasValidXRange && scaleMatchesDimensions && svgMatchesDimensions) {
          // Clear existing regression lines
          chartbody.selectAll(".trend-line").remove();
          chartbody.selectAll(".trend-label").remove();

          // Draw regression lines for each color group
          const groups = finalEnhancedResult.groups;
          
          // Check if any group has regression data
          const hasRegressionData = groups.some(group => group.regression);
          
          if (hasRegressionData) {
            groups.forEach(group => {
              if (group.regression) {
                // Use chart series color for DEFAULT mode, otherwise use group color
                const regressionColor = (props.colortype === 'DEFAULT' && chart.color) 
                  ? chart.color 
                  : group.color;
                
                drawTrendLine(group.regression, regressionColor, xScale, yScale);
              }
            });
          } else if (regressionMethod !== 'None' && groups.length > 0) {
            // Only warn if we have groups but no regression data - 0 groups means no data at all, which is a different issue
            // This can happen if the worker hasn't finished computing regression yet or if there's insufficient data
            // Don't spam warnings - only log once per render cycle
            if (!groups.some(g => g.regression)) {
              debug(`[DensityOptimization] Regression method ${regressionMethod} specified but no regression data available in ${groups.length} groups - worker may still be computing`);
            }
          }
        } else {
        }
      }
    }

    // Notify parent once when initial chart render completes
    // Also mark scatter as rendered
    setTimeout(() => {
      setScatterRendered(true);
      signalReadyOnce();
    }, 0);
  });

  // No separate effect needed - regression is drawn in the main render effect above

  onCleanup(() => {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    // D3 cleanup is now handled by useChartCleanup hook
    // DON'T destroy the singleton worker manager - it's shared across all scatter charts
    // and should persist for the lifetime of the application
    // enhancedScatterWorkerManager.destroy();
  });

  const isBusy = () => isLoading() || isProcessingData() || isCalculatingRegression();

  return (
    <div class="w-full" style={isBusy() ? { "min-height": "100vh" } : {}}>
      <Show when={!isLoading()}>
        {/* Filter Status Label */}
        <Show when={props.showFilterStatus !== false}>
        <div class="flex justify-center mb-3" style={{ "margin-top": "75px" }}>
          <Show 
            when={props.chart?.filters && props.chart.filters.length > 0}
            fallback={
              <div class="px-3 py-1 text-xs font-medium rounded-full bg-grey-100 text-black-700 border border-grey-200">
                unfiltered
              </div>
            }
          >
            <div class="flex gap-2 flex-wrap justify-center">
              {props.chart.filters.map((filter) => (
                <span class="px-3 py-1 text-xs font-medium rounded-full bg-green-100 text-green-700 border border-green-200">
                  {filter}
                </span>
              ))}
            </div>
          </Show>
        </div>
      </Show>
      
      
        {/* Chart container; when parent handles zoom, allow opting-in to show internal fit table */}
        <Show when={!props.handleZoom || props.showFitTable} fallback={<div ref={(el) => (chartRef = el)} style={{ "padding-top": "0px", "min-height": "400px", "width": "100%" }}></div>}>
          <div style={{ 
            width: "100%", 
            height: isZoomed() ? "100%" : (props.totalCharts === 1 ? "75vh" : "auto"), 
            maxHeight: isZoomed() ? "100%" : (props.totalCharts === 1 ? "75vh" : "none"),
            display: "flex", 
            "padding-top": props.totalCharts === 1 ? "0" : "0px", 
            "min-height": props.totalCharts === 1 ? "75vh" : "400px",
            "box-sizing": "border-box",
            overflow: props.totalCharts === 1 ? "hidden" : "visible"
          }}>
            <div
              class="simple-scatter-chart-container"
              ref={(el) => {
                chartRef = el;
                // Trigger a size update after ref is set to ensure ResizeObserver picks it up
                if (el && resizeObserver) {
                  // Small delay to ensure DOM is laid out
                  requestAnimationFrame(() => {
                    const width = el.clientWidth || el.parentElement?.clientWidth || 0;
                    const height = el.clientHeight || el.parentElement?.clientHeight || 400;
                    if (width > 0 && height > 0) {
                      setContainerSize({ width, height });
                    }
                  });
                }
              }}
              style={{
                width: isZoomed() && fitData().length > 0 ? "66%" : "100%",
                height: isZoomed() ? "95%" : (props.totalCharts === 1 ? "100%" : "auto"),
                maxHeight: isZoomed() ? "95%" : (props.totalCharts === 1 ? "100%" : "none"),
                minHeight: "400px",
                minWidth: "400px", // Ensure minimum width
                float: "left",
                "box-sizing": "border-box",
              }}
            ></div>
            <Show when={props.chart?.missingChannels?.length > 0}>
              <div class="text-center text-sm text-gray-500 dark:text-gray-400 mt-1 w-full" style={{ clear: "both" }}>
                Data channels could not be loaded for this chart.
              </div>
            </Show>
            <Show when={isZoomed() && fitData().length > 0}>
              <div
                style={{
                  width: "33%",
                  height: "95%",
                  float: "left",
                  "margin-top": "100px",
                  "padding-left": "30px",
                }}
              >
                <Table 
                  xaxis={(() => { const chart = (props.chart && props.chart.series && props.chart.series[0]) || {}; return chart.xaxis?.name || 'X'; })()} 
                  fitData={fitData()} 
                  version={fitDataVersion()} 
                />
              </div>
            </Show>
            <div style={{ clear: "both" }}></div>
          </div>
        </Show>
        
        {/* Local tooltip for when not in splitter view */}
        <Show when={!document.querySelector('.mapboxgl-map') && localTooltip().visible}>
          <div
            id="scatter-tooltip"
            class="tooltip"
            style={{
              position: 'fixed',
              opacity: 1,
              left: `${localTooltip().x}px`,
              top: `${localTooltip().y}px`,
              pointerEvents: 'none',
              zIndex: 9999
            }}
            innerHTML={localTooltip().content}
          />
        </Show>
        
        {/* Info tooltip */}
        <Show when={infoTooltip().visible}>
          <div
            id="info-tooltip"
            class="tooltip"
            style={{
              position: 'fixed',
              opacity: 1,
              left: `${infoTooltip().x}px`,
              top: `${infoTooltip().y}px`,
              pointerEvents: 'none',
              zIndex: 9999
            }}
            innerHTML={infoTooltip().content}
          />
        </Show>
      </Show>
    </div>
  );
}