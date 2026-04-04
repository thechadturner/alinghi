import { onMount, createEffect, createSignal, batch, For, Show, onCleanup, untrack } from "solid-js";
import { useNavigate } from "@solidjs/router";

import PageSettings from "../../../../components/menus/PageSettings";
import SimpleScatter from "../../../../components/charts/SimpleScatter";
import LoadingOverlay from "../../../../components/utilities/Loading";
import DataNotFoundMessage from "../../../../components/utilities/DataNotFoundMessage";

import { user } from "../../../../store/userStore"; 
// Tooltip removed - now handled by MapContainer
import { registerSelectionStoreCleanup, selectedRange, selectedRanges, cutEvents, hasSelection, isCut } from "../../../../store/selectionStore";
import {
  selectedStatesTimeseries,
  setSelectedStatesTimeseries,
  selectedRacesTimeseries,
  setSelectedRacesTimeseries,
  selectedLegsTimeseries,
  setSelectedLegsTimeseries,
  selectedGradesTimeseries,
  setSelectedGradesTimeseries,
  raceOptions,
  setRaceOptions,
  legOptions,
  setLegOptions,
  gradeOptions,
  setGradeOptions,
  setHasChartsWithOwnFilters
} from "../../../../store/filterStore";

import { persistantStore } from "../../../../store/persistantStore";
import { error as logError, log, warn, debug } from "../../../../utils/console";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName, selectedPage, colorType, setColorType, filterChartsBySelection } = persistantStore;

import { getData, setupMediaContainerScaling } from "../../../../utils/global";
import { logPageLoad } from "../../../../utils/logging";
import { applyDataFilter, extractFilterOptions } from "../../../../utils/dataFiltering";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { getChartLayoutClass } from "../../../../utils/chartLayoutUtils";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { useChartProgress } from "../../../../utils/useChartProgress";

interface ScatterPageProps {
  [key: string]: any;
}

export default function ScatterPage(props: ScatterPageProps) {
  // Make navigate optional for split view compatibility
  let navigate: ((path: string) => void) | (() => void);
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // Router not available (e.g., in split view), use fallback
    navigate = () => {
      warn('Router not available - navigation disabled');
    };
  }
  
  // Derived object name (same pattern as TimeSeries) – from props or selectedPage so page switch refetches correctly
  const objectName = (): string => props?.objectName || selectedPage() || 'default';

  // Register cleanup for selection store
  registerSelectionStoreCleanup();
  
  const [charts, setCharts] = createSignal([]);
  const [originalCharts, setOriginalCharts] = createSignal([]); // Store unfiltered charts for leg options
  const [columns, setColumns] = createSignal(0);
  const className = () => getChartLayoutClass(charts().length, 'default', columns());
  const [isFiltering, setIsFiltering] = createSignal(false);
  const [isColorChanging, setIsColorChanging] = createSignal(false);
  const [isInitializing, setIsInitializing] = createSignal(false);
  const [zoom, setZoom] = createSignal(false);
  const [selectedChart, setSelectedChart] = createSignal(null);
  const [chartsReadyCount, setChartsReadyCount] = createSignal(0);
  /** True when we have chart config from API but data/channels could not be found (API or HuniDB). */
  const [hasChartConfigButNoData, setHasChartConfigButNoData] = createSignal(false);

  // Progress tracking
  const progress = useChartProgress({
    chartType: 'scatter',
    className: selectedClassName,
    sourceId: selectedSourceId
  });

  const colortypes = ["DEFAULT", "GRADE", "TACK", "UW/DW"];
  const twaFilterOptions = ["Upwind", "Downwind", "Reaching", "Port", "Stbd"];

  // AbortController for managing fetch requests
  let abortController: AbortController | null = new AbortController();
  let isApplyingFilters = false;
  let filteringTimer = null;
  let lastFilterState = null; // Track last filter state to prevent unnecessary updates
  let lastFilteredCharts = null; // Cache last filtered result
  let cleanupScaling = null; // Store cleanup function for scaling

  const fetchCharts = async (signal: AbortSignal) => {
    try {
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=scatter&object_name=${encodeURIComponent(objectName())}`, signal);
      if (!response.success) {
        // Don't warn for cancelled requests - they're expected when component re-initializes
        if (response.type === 'AbortError' || response.error === 'Request cancelled') {
          debug('Chart configuration fetch was cancelled (expected during re-initialization)');
          return { chart_info: [], columns: 0 };
        }
        const errorMsg = response.error || response.message || "Unknown error";
        warn(`Failed to fetch chart configuration: ${errorMsg}. Using default configuration.`);
        return { chart_info: [], columns: 0 };
      }

      // If no saved configuration exists, return default configuration
      if (!response.data || !response.data.chart_info || response.data.chart_info.length === 0) {
        log("No saved chart configuration found, using default configuration");
        return { chart_info: [], columns: 0 };
      }

      // CRITICAL: Log chart objects from API to verify channel name case
      const chartInfo = response.data.chart_info;
      debug(`[Scatter] 🔍 CHART OBJECTS FROM API:`, {
        chartInfoCount: chartInfo.length,
        sampleChart: chartInfo[0] ? {
          seriesCount: chartInfo[0].series?.length || 0,
          series: chartInfo[0].series?.map((s: any) => ({
            xaxisName: s.xaxis?.name,
            yaxisName: s.yaxis?.name,
            colorChannelName: s.colorChannel?.name,
            xaxisCase: s.xaxis?.name ? { hasUpperCase: /[A-Z]/.test(s.xaxis.name), isLowercase: s.xaxis.name === s.xaxis.name.toLowerCase() } : null,
            yaxisCase: s.yaxis?.name ? { hasUpperCase: /[A-Z]/.test(s.yaxis.name), isLowercase: s.yaxis.name === s.yaxis.name.toLowerCase() } : null
          })) || []
        } : null,
        note: 'These channel names come directly from the database/API. If lowercase here, they are stored lowercase in the database.'
      });

      return {
        chart_info: chartInfo,
        columns: response.data.columns || 0
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { chart_info: [], columns: 0 };
      }
      warn("Error fetching charts:", err.message || err);
      // Return default configuration on error
      return { chart_info: [], columns: 0 };
    }
  };

  // Fetch all required data once at the parent level (uses objectName() for cache key, like TimeSeries)
  const fetchAndFormatDataWithUnifiedStore = async (chartsData: any[], signal?: AbortSignal) => {
    if (!chartsData || chartsData.length === 0) {
      return [];
    }

    try {
      // Gather all required channels from all charts
      const requiredChannelsSet = new Set();
      
      // Add filter channels from service
      const filterChannels = await UnifiedFilterService.getRequiredFilterChannels(selectedClassName(), 'dataset');
      filterChannels.forEach(channel => requiredChannelsSet.add(channel));
      requiredChannelsSet.add('Datetime'); // Always include Datetime
      
      // Always include Twa for filtering (PORT/STBD/UW/DW/RCH)
      // Preserve original case from defaultChannelsStore for API compatibility
      // Case-insensitive matching will handle any case variations
      const twaChannelName = defaultChannelsStore.twaName();
      requiredChannelsSet.add(twaChannelName);
      
      // Add optional filter channels (sail codes)
      const optionalFilterChannels = UnifiedFilterService.getOptionalFilterChannels();
      optionalFilterChannels.forEach(channel => requiredChannelsSet.add(channel));
      
      // CRITICAL: Use channel names directly from chart objects - they already have the correct case
      // Chart objects preserve original case for API channel names (mixed case, underscores).
      // No normalization needed - use them as-is
      // Add chart-specific channels (preserve original case from chart objects)
      chartsData.forEach(chart => {
        chart.series.forEach(series => {
          if (series.xaxis?.name) {
            // Remove " - SourceName" suffix if present (fleet mode)
            const xChannelName = series.xaxis.name.split(' - ')[0];
            requiredChannelsSet.add(xChannelName);
          }
          if (series.yaxis?.name) {
            // Remove " - SourceName" suffix if present (fleet mode)
            const yChannelName = series.yaxis.name.split(' - ')[0];
            requiredChannelsSet.add(yChannelName);
          }
          if (series.colorChannel?.name) {
            // Remove " - SourceName" suffix if present (fleet mode)
            const colorChannelName = series.colorChannel.name.split(' - ')[0];
            requiredChannelsSet.add(colorChannelName);
          }
        });
      });
      
      // Use channels directly from chart objects - they already have correct case
      const requiredChannels = Array.from(requiredChannelsSet);
      
      // CRITICAL: Log channels to verify they're in original case from chart objects
      debug(`[Scatter] 🔍 REQUIRED CHANNELS BEFORE STORE:`, {
        requiredChannels: requiredChannels,
        channelsCount: requiredChannels.length,
        sampleChannels: requiredChannels.slice(0, 10),
        caseCheck: requiredChannels.slice(0, 10).map(ch => ({
          channel: ch,
          hasUpperCase: /[A-Z]/.test(ch),
          isLowercase: ch === ch.toLowerCase()
        })),
        note: 'These channels should be in original case from chart objects. If lowercase here, chart objects from database have lowercase names.'
      });
      
      debug('🔍 Scatter: Required channels:', requiredChannels);
      debug('🔍 Scatter: Filter channels from service:', filterChannels);
      debug('🔍 Scatter: Optional filter channels:', optionalFilterChannels);
      debug('🔍 Scatter: Grade channel included?', requiredChannels.includes('Grade'));
      
      // Get dataset date for proper API calls
      const datasetInfoUrl = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`;
      debug('🔍 Scatter: Fetching dataset metadata from:', datasetInfoUrl);
      
      const datasetInfoResponse = await getData(datasetInfoUrl, signal);
      
      if (!datasetInfoResponse.success) {
        logError('🔍 Scatter: Failed to fetch dataset metadata', {
          url: datasetInfoUrl,
          response: datasetInfoResponse,
          className: selectedClassName(),
          projectId: selectedProjectId(),
          datasetId: selectedDatasetId(),
          error: datasetInfoResponse.error || datasetInfoResponse.message || 'Unknown error'
        });
        throw new Error(`Failed to fetch dataset metadata: ${datasetInfoResponse.error || datasetInfoResponse.message || 'Unknown error'}`);
      }
      
      if (!datasetInfoResponse.data || !datasetInfoResponse.data.date) {
        logError('🔍 Scatter: Dataset metadata missing date field', {
          response: datasetInfoResponse,
          data: datasetInfoResponse.data
        });
        throw new Error("Dataset metadata missing date field.");
      }
      
      const { date: rawDate } = datasetInfoResponse.data;
      const formattedDate = rawDate.replace(/-/g, "");
      
      debug('🔍 Scatter: Dataset date info:', { rawDate, formattedDate });
      debug('🔍 Scatter: Probability page uses:', new Date().toISOString().split('T')[0]);

      // Set initial progress
      progress.setProgress(20, 'Preparing to fetch data...');

      // Fetch all data once using unified data store (validates against file channels)
      // Per-page cache key from objectName() (same pattern as TimeSeries)
      const data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
        'scatter',
        selectedClassName(),
        selectedSourceId().toString(),
        requiredChannels,
        {
          projectId: selectedProjectId().toString(),
          className: selectedClassName(),
          datasetId: selectedDatasetId().toString(),
          sourceName: selectedSourceName(),
          date: formattedDate,
          objectName: objectName(), // Per-page cache: takeoffs vs tws bsp etc.
          use_v2: true, // Obsolete - kept for backward compatibility (DuckDB is now the only implementation)
          applyGlobalFilters: false, // Always fetch full dataset, apply filters locally
          skipTimeRangeFilter: true // CRITICAL: Scatter should NEVER filter by timeRange - needs full dataset
        },
        'timeseries'
      );

      if (!data || data.length === 0) {
        if (signal?.aborted) {
          progress.setProgress(100, 'Cancelled');
          return [];
        }
        progress.setProgress(100, 'No data available');
        const missingChannels = unifiedDataStore.getLastMissingChannels('scatter');
        if (missingChannels.length > 0 && chartsData?.length > 0) {
          const missingLower = new Set(missingChannels.map((c: string) => c.toLowerCase()));
          return chartsData.map((chart: any) => {
            const required: string[] = [];
            chart.series?.forEach((s: any) => {
              if (s.xaxis?.name) required.push(s.xaxis.name.split(' - ')[0]);
              if (s.yaxis?.name) required.push(s.yaxis.name.split(' - ')[0]);
              if (s.colorChannel?.name) required.push(s.colorChannel.name.split(' - ')[0]);
            });
            const chartMissing = [...new Set(required.filter((r: string) => missingLower.has(r.toLowerCase())))];
            return {
              ...chart,
              missingChannels: chartMissing,
              series: (chart.series || []).map((s: any) => ({ ...s, data: [], originalData: [] }))
            };
          });
        }
        return [];
      }
      
      // Data fetch complete
      progress.setProgress(95, 'Formatting data...');
      
      debug('🔍 Scatter: Data fetched successfully:', { 
        dataLength: data.length, 
        samplePoint: data[0],
        availableFields: data[0] ? Object.keys(data[0]) : []
      });
      
      // Check specifically for Grade field
      if (data.length > 0) {
        const samplePoint = data[0];
        debug('🔍 Scatter: Grade field analysis:', {
          hasGrade: 'Grade' in samplePoint,
          gradeValue: samplePoint.Grade,
          hasGradeLowercase: 'grade' in samplePoint,
          gradeLowercaseValue: samplePoint.grade
        });
      }

      // Load filter options: query HuniDB map.data first; if empty (e.g. dataset not in map.data), extract from fetched data
      try {
        await extractFilterOptions(data, 'dataset');
        const opts = await unifiedDataStore.getFilterOptions();
        debug('🔍 Scatter: Retrieved filter options from datastore (full dataset):', opts);
        if (opts) {
          const allRaces = (opts.races || []).slice().sort((a,b)=>a-b);
          let allGrades = (opts.grades || []).slice().sort((a,b)=>a-b);
          const allLegs = (opts.legs || opts.legOptions || []).slice().sort((a,b)=>a-b);
          
          // If no grades found and Grade field is missing from data, provide default grades
          if (allGrades.length === 0 && data.length > 0 && !('Grade' in data[0])) {
            debug('🔍 Scatter: No Grade field in data, providing default grade options');
            allGrades = [1, 2, 3]; // Default grade options
          }
          
          debug('🔍 Scatter: Setting filter options:', { allRaces, allGrades, allLegs });
          setRaceOptions(allRaces);
          setGradeOptions(allGrades);
          setLegOptions(allLegs);
          // Persist race->legs mapping for dynamic leg filtering
          window.__raceToLegs = opts.raceToLegs || {};
        } else {
          debug('🔍 Scatter: No filter options found in datastore');
        }
      } catch (error) {
        debug('🔍 Scatter: Error loading filter options:', error);
      }

      // Process charts with the unified data
      const processedCharts = chartsData.map(chart => {
        const processedChart = { ...chart };
        processedChart.series = chart.series.map(series => {
          const processedSeries = { ...series };
          
          // Get default Twa channel name once per series (not per row for efficiency)
          const twaChannelName = defaultChannelsStore.twaName();
          const twaChannelNameLower = twaChannelName.toLowerCase();
          
          // Process data for this series
          const seriesData = data.map(row => {
            // Ensure Twa is available with correct case (filterByTwa expects d.Twa)
            // Use default channel name and try multiple case variations to handle different data formats
            const twaValue = row.Twa !== undefined ? row.Twa : 
                           row[twaChannelName] !== undefined ? row[twaChannelName] :
                           row[twaChannelNameLower] !== undefined ? row[twaChannelNameLower] :
                           row.twa !== undefined ? row.twa : 
                           row.TWA !== undefined ? row.TWA : undefined;
            
            // Get x and y values with case-insensitive matching (HuniDB stores channels in lowercase)
            let xValue: number | undefined = undefined;
            if (series.xaxis?.name) {
              const xAxisName = series.xaxis.name;
              xValue = row[xAxisName] !== undefined ? row[xAxisName] :
                      row[xAxisName.toLowerCase()] !== undefined ? row[xAxisName.toLowerCase()] :
                      row[xAxisName.toUpperCase()] !== undefined ? row[xAxisName.toUpperCase()] : undefined;
            }
            
            let yValue: number | undefined = undefined;
            if (series.yaxis?.name) {
              const yAxisName = series.yaxis.name;
              yValue = row[yAxisName] !== undefined ? row[yAxisName] :
                      row[yAxisName.toLowerCase()] !== undefined ? row[yAxisName.toLowerCase()] :
                      row[yAxisName.toUpperCase()] !== undefined ? row[yAxisName.toUpperCase()] : undefined;
            }
            
            // Get color channel value with case-insensitive matching
            let colorValue: any = series.color || '#1f77b4';
            if (series.colorChannel?.name) {
              const colorChannelName = series.colorChannel.name;
              colorValue = row[colorChannelName] !== undefined ? row[colorChannelName] :
                          row[colorChannelName.toLowerCase()] !== undefined ? row[colorChannelName.toLowerCase()] :
                          row[colorChannelName.toUpperCase()] !== undefined ? row[colorChannelName.toUpperCase()] :
                          series.color || '#1f77b4';
            }

            // Grade for filtering – always set Grade/grade so filterByTwa sees hasAnyGradeField and filter runs
            const gradeValue = row.Grade !== undefined ? row.Grade :
                              row.grade !== undefined ? row.grade :
                              row.GRADE !== undefined ? row.GRADE : undefined;
            
            return {
              Datetime: row.Datetime,
              x: xValue !== undefined ? xValue : 0,
              y: yValue !== undefined ? yValue : 0,
              color: colorValue,
              // Use default TWA channel name (filterByTwa now uses defaultChannelsStore.twaName())
              [twaChannelName]: twaValue !== undefined ? twaValue : 
                   row[twaChannelName] || 
                   row[twaChannelNameLower] ||
                   row.Twa || 
                   row.twa,
              ...row, // Include all metadata for filtering
              // Always set Grade/grade so filterByTwa sample has grade field and grade filter runs (use null when missing)
              Grade: gradeValue ?? null,
              grade: gradeValue ?? null
            };
          });
          
          processedSeries.data = seriesData;
          processedSeries.originalData = [...seriesData]; // Store original data for filtering
          return processedSeries;
        });
        
        return processedChart;
      });

      // Data processing complete - but charts still need to render
      // Set to 95% to indicate data is ready but rendering is in progress
      progress.setProgress(95, 'Rendering charts...');
      return processedCharts;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      logError("Error in fetchAndFormatDataWithUnifiedStore:", error);
      return [];
    }
  };

  // Helper function to check if any chart has its own filters
  const hasChartFilters = (chartsToCheck) => {
    if (!chartsToCheck || chartsToCheck.length === 0) {
      return false;
    }
    
    // Only check charts that have been properly loaded (have series data)
    const loadedCharts = chartsToCheck.filter(chart => 
      chart && chart.series && chart.series.length > 0
    );
    
    if (loadedCharts.length === 0) {
      return false;
    }
    
    const hasFilters = loadedCharts.some(chart => {
      return chart.filters && Array.isArray(chart.filters) && chart.filters.length > 0;
    });
    
    return hasFilters;
  };


  // Optimized function to apply filters to charts
  const applyFiltersToCharts = (currentCharts, globalFilters = selectedStatesTimeseries(), globalRaces = selectedRacesTimeseries(), globalLegs = selectedLegsTimeseries(), globalGrades = selectedGradesTimeseries()) => {
    // Check if charts have their own filters - if so, don't apply unified filters
    if (hasChartFilters(currentCharts)) {
      return currentCharts;
    }
    
    return currentCharts.map(chart => ({
      ...chart,
      series: chart.series.map(series => {
        // Use originalData if available, otherwise reference the data directly
        const originalData = series.originalData || series.data;
        
        // Only create originalData reference if it doesn't exist (avoid copying)
        if (!series.originalData) {
          series.originalData = series.data;
        }
        
        const beforeLength = originalData?.length ?? 0;
        debug('🔍 Scatter: applyFiltersToCharts - before filtering', {
          originalDataLength: beforeLength,
          filters: globalFilters,
          races: globalRaces,
          legs: globalLegs,
          grades: globalGrades
        });
        
        // Apply unified filtering with explicit filter values to prevent circular dependencies
        const filteredData = applyDataFilter(originalData, globalFilters, globalRaces, globalLegs, globalGrades);
        
        const afterLength = filteredData?.length ?? 0;
        debug('🔍 Scatter: applyFiltersToCharts - after filtering', {
          filteredDataLength: afterLength,
          filtered: beforeLength !== afterLength
        });
        
        return { ...series, data: filteredData };
      })
    }));
  };

  // Single fetch (like TimeSeries fetchChartConfigAndData) – uses objectName() for config and cache
  const initializeCharts = async () => {
    const expectedPage = objectName();

    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    setIsInitializing(true);
    unifiedDataStore.setLoading('scatter', true);
    setChartsReadyCount(0);
    setHasChartConfigButNoData(false);
    setCharts([]);
    setOriginalCharts([]);

    try {
      const { chart_info: chartsData, columns: loadedColumns } = await fetchCharts(signal);
      setColumns(loadedColumns);

      const updatedCharts = await fetchAndFormatDataWithUnifiedStore(chartsData, signal);

      // Only apply if still on the same page (like TimeSeries – no stale overwrite)
      if (objectName() !== expectedPage) {
        debug('[Scatter] Skipping setCharts - page changed:', expectedPage, '->', objectName());
        return;
      }

      // Track when we have chart config but data/channels could not be found (show TimeSeries-like message, not "No charts available")
      const hasConfig = (chartsData?.length ?? 0) > 0;
      const noChartsReturned = !updatedCharts || updatedCharts.length === 0;
      const allChartsHaveNoData = Array.isArray(updatedCharts) && updatedCharts.length > 0 &&
        updatedCharts.every((ch: any) => (ch.series || []).every((s: any) => !(s.data?.length) && !(s.originalData?.length)));
      setHasChartConfigButNoData(hasConfig && (noChartsReturned || allChartsHaveNoData));
      
      // Reset chart filters state - check the actual loaded chart objects
      log('🔍 initializeCharts: Loaded', updatedCharts.length, 'charts with filters:', updatedCharts.map(chart => chart.filters?.length || 0));

      // Store original unfiltered charts for leg options derivation
      setOriginalCharts(updatedCharts);

      // Apply initial filters before setting charts
      const filteredCharts = applyFiltersToCharts(updatedCharts);
      lastFilteredCharts = filteredCharts; // Cache the result
      setCharts(filteredCharts);
      
      // If there are no charts, set progress to 100% immediately
      if (filteredCharts.length === 0) {
        progress.setProgress(100, 'Complete');
      }
      
      // Filter options are now loaded in fetchAndFormatDataWithUnifiedStore (same as Probability page)
      
      // Update class name based on chart count - now handled by reactive memo
    } catch (err) {
      if (err.name !== 'AbortError') {
        logError("Error initializing charts:", err);
      }
    } finally {
      setIsInitializing(false);
      unifiedDataStore.setLoading('scatter', false);
    }
  };
  const onChildChartReady = () => {
    const newCount = chartsReadyCount() + 1;
    const totalCharts = charts().length;
    debug('🔍 Chart ready callback:', { 
      currentCount: chartsReadyCount(), 
      newCount, 
      totalCharts
    });
    setChartsReadyCount(newCount);
    
    // When all charts are ready, set progress to 100%
    if (newCount >= totalCharts && totalCharts > 0) {
      progress.setProgress(100, 'Complete');
    }
  };


  const handleColorBy = (val) => {
    setIsColorChanging(true);
    
    setTimeout(() => {
      setColorType(val);
      
      setTimeout(() => {
        setIsColorChanging(false);
      }, 50);
    }, 10);
  };

  // Zoom handler similar to Performance page
  const handleZoom = (info) => {
    if (info) {
      // Enter zoom with the provided chart configuration
      setSelectedChart(info);
      setZoom(true);
    } else {
      // Exit zoom
      setSelectedChart(null);
      setZoom(false);
    }
  };

  // Filter options are now extracted at the data loading level in SimpleScatter component

  // Reset chart filters state when charts are properly loaded
  createEffect(() => {
    const currentCharts = untrack(() => charts());
    
    if (!isInitializing() && currentCharts.length > 0) {
      // Check if charts have been properly loaded (have series data)
      const loadedCharts = currentCharts.filter(chart => 
        chart && chart.series && chart.series.length > 0
      );
      
      if (loadedCharts.length > 0) {
        const hasFilters = hasChartFilters(currentCharts);
        log('🔍 Chart filters state:', hasFilters ? 'HAS chart-level filters' : 'NO chart-level filters - global filters will be used');
        
        // Update global state for SelectionBanner
        setHasChartsWithOwnFilters(hasFilters);
      }
    }
  });

  // Initialize leg options when originalCharts is first populated
  createEffect(() => {
    const origCharts = originalCharts();
    
    if (origCharts.length > 0 && !isInitializing()) {
      debug('🔍 Scatter: Initializing leg options from originalCharts:', origCharts.length, 'charts');
      
      // Always show all available legs from full dataset
      const raceToLegs = (window.__raceToLegs) || {};
      
      if (Object.keys(raceToLegs).length > 0) {
        // Get all unique legs from all races
        const allLegs = Array.from(new Set(Object.values(raceToLegs).flat())).sort((a,b)=>a-b);
        debug('🔍 Scatter: Leg options from raceToLegs mapping:', allLegs);
        setLegOptions(allLegs);
      } else {
        // Fallback to deriving from ORIGINAL unfiltered data
        const allData = origCharts.flatMap(chart => 
          chart.series.flatMap(series => series.data || [])
        );
        const legs = [...new Set(allData.map(d => d.Leg_number).filter(l => l != null && l !== undefined))].sort((a, b) => a - b);
        debug('🔍 Scatter: Leg options from original data:', legs, 'from', allData.length, 'data points');
        setLegOptions(legs);
      }
    }
  });

  // React to selection/range changes only when "Filter by selection" is on; otherwise skip to avoid unnecessary refresh/flash.
  createEffect(() => {
    if (!filterChartsBySelection()) return;
    selectedRange();
    selectedRanges();
    cutEvents();
    hasSelection();
    isCut();
    const origCharts = untrack(() => originalCharts());
    if (origCharts.length === 0 || isInitializing()) return;
    lastFilteredCharts = null;
    const filteredCharts = applyFiltersToCharts(origCharts);
    setCharts(filteredCharts);
  });

  // Manual function to apply filters (called when Apply button is clicked)
  const applyFiltersManually = () => {
    const filters = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    
    debug('🔍 Scatter: Applying filters manually (Apply button clicked)', { filters, races, legs, grades });
    
    // Skip if no data available
    const origCharts = originalCharts();
    if (origCharts.length === 0) {
      warn('🔍 Scatter: Cannot apply filters - no data available');
      return;
    }
    
    // Skip during initialization
    if (isInitializing()) return;
    
    // Apply filters locally to the ORIGINAL unfiltered data
    const filteredCharts = applyFiltersToCharts(origCharts, filters, races, legs, grades);
    debug('🔍 Scatter: Filtered charts result', {
      chartsCount: filteredCharts.length,
      firstChartSeriesDataLength: filteredCharts[0]?.series[0]?.data?.length ?? 0,
      firstChartOriginalDataLength: filteredCharts[0]?.series[0]?.originalData?.length ?? 0,
      dataIsDifferent: filteredCharts[0]?.series[0]?.data !== filteredCharts[0]?.series[0]?.originalData
    });
    setCharts(filteredCharts);
  };

  // Apply filters when grade/race/leg/states change so chart updates immediately; Apply button only closes modal
  createEffect(() => {
    selectedStatesTimeseries();
    selectedRacesTimeseries();
    selectedLegsTimeseries();
    selectedGradesTimeseries();
    const origCharts = untrack(() => originalCharts());
    if (origCharts.length === 0 || isInitializing()) return;
    const filteredCharts = applyFiltersToCharts(origCharts);
    setCharts(filteredCharts);
  });

  // Toggle functions for race and leg filters
  const toggleRaceFilter = (race) => {
    const currentRaces = selectedRacesTimeseries();
    let newRaces;
    
    if (currentRaces.includes(race)) {
      newRaces = currentRaces.filter(r => r !== race);
    } else {
      newRaces = [...currentRaces, race];
    }
    
    batch(() => {
      setSelectedRacesTimeseries(newRaces);
    });
  };

  const toggleLegFilter = (leg) => {
    const currentLegs = selectedLegsTimeseries();
    let newLegs;
    
    if (currentLegs.includes(leg)) {
      newLegs = currentLegs.filter(l => l !== leg);
    } else {
      newLegs = [...currentLegs, leg];
    }
    
    batch(() => {
      setSelectedLegsTimeseries(newLegs);
    });
  };

  const toggleGradeFilter = (grade) => {
    const currentGrades = selectedGradesTimeseries();
    let newGrades;
    
    if (currentGrades.includes(grade)) {
      newGrades = currentGrades.filter(g => g !== grade);
    } else {
      newGrades = [...currentGrades, grade];
    }
    
    batch(() => {
      setSelectedGradesTimeseries(newGrades);
    });
  };

  onMount(async () => {
    await logPageLoad('Scatter.jsx', 'Scatter Plot Report');
    setIsInitializing(true);
    initializeCharts();
    
    // Set up dynamic scaling for media-container using the global utility
    cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'Scatter',
      scaleToWidth: true
    });
  });

  // When objectName changes (menu / selectedPage), clear and refetch – same idea as TimeSeries, one fetch uses objectName()
  let prevObjectName: string | undefined;
  createEffect(() => {
    const name = objectName();
    if (prevObjectName !== undefined && prevObjectName !== name) {
      setCharts([]);
      setOriginalCharts([]);
      setChartsReadyCount(0);
      setIsInitializing(true);
      try {
        const cn = selectedClassName();
        const pid = selectedProjectId();
        const did = selectedDatasetId();
        const sid = selectedSourceId();
        if (cn && pid != null && did != null && sid != null) {
          unifiedDataStore.clearCacheForDataSource(`${cn}_${sid}_${did}_${pid}`);
          debug('[Scatter] Cleared data cache on page switch:', prevObjectName, '->', name);
        }
      } catch (e) {
        debug('[Scatter] clearCacheForDataSource on page switch:', e);
      }
      initializeCharts();
    }
    prevObjectName = name;
  });


  onCleanup(() => {
    setIsInitializing(false);
    if (filteringTimer) {
      clearTimeout(filteringTimer);
      filteringTimer = null;
    }
    isApplyingFilters = false;
    lastFilterState = null;
    // Only abort if controller still exists (component is actually unmounting)
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    
    // Cleanup scaling
    if (cleanupScaling) {
      cleanupScaling();
      cleanupScaling = null;
    }
  });

  return (
    <>
    <div id='media-container' class="scatter-page">
      <Show when={charts().length > 0}>
        <PageSettings
          useIconTrigger={true}
          options={twaFilterOptions}
          colorOptions={colortypes}
          selectedStates={selectedStatesTimeseries()}
          setSelectedStates={setSelectedStatesTimeseries}
          raceOptions={raceOptions()}
          setRaceOptions={setRaceOptions}
          legOptions={legOptions()}
          setLegOptions={setLegOptions}
          gradeOptions={gradeOptions()}
          setGradeOptions={setGradeOptions}
          selectedRaces={selectedRacesTimeseries()}
          selectedLegs={selectedLegsTimeseries()}
          selectedGrades={selectedGradesTimeseries()}
          onApply={() => { /* Chart already updates when grade/race/leg/states change; Apply only closes modal */ }}
          toggleFilter={(groupIndex, chartIndex, filter) => {
            const currentFilters = selectedStatesTimeseries();
            let newFilters;
            
            if (currentFilters.includes(filter)) {
              newFilters = currentFilters.filter(f => f !== filter);
            } else {
              newFilters = [...currentFilters, filter];
            }
            
            batch(() => {
              setSelectedStatesTimeseries(newFilters);
            });
          }}
          toggleRaceFilter={toggleRaceFilter}
          toggleLegFilter={toggleLegFilter}
          toggleGradeFilter={toggleGradeFilter}
          filterConfig={{
            showGrades: true,
            showTWA: true,
            showRaces: true,
            showLegs: true,
            showPhases: false,
            showPeriods: false,
            showBins: false,
            showHeadsail: false,
            showMainsail: false,
            showConfiguration: false
          }}
          builderRoute={'/scatter-builder'}
        />
      </Show>

      <div class="container relative">
        {/* Scrollable charts container - inner is scroll viewport per performance-page-scroll-fix.md */}
        <div class="performance-charts-scroll-container">
          <div class="performance-charts-scroll-inner" style={{ position: 'relative' }}>
            <Show 
            when={charts().length > 0 && !hasChartConfigButNoData()}
            fallback={
                <Show when={!isInitializing() && !unifiedDataStore.getLoading('scatter')}>
                  <Show
                    when={hasChartConfigButNoData()}
                    fallback={
                      <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
                        <div class="mb-6">
                          <svg class="w-16 h-16 mx-auto text-gray-400 dark:text-gray-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                          </svg>
                          <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-200 mb-2">No Charts Available</h3>
                          <p class="text-gray-500 dark:text-gray-400 mb-6">Would you like to add one?</p>
                        </div>
                        <button 
                          onClick={() => {
                            if (navigate) {
                              navigate('/scatter-builder');
                            } else {
                              log('Scatter: Cannot navigate to scatter-builder in split view');
                            }
                          }}
                          class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg shadow-md hover:shadow-lg"
                        >
                          Add Chart
                        </button>
                      </div>
                    }
                  >
                    <DataNotFoundMessage
                      builderRoute="/scatter-builder"
                      onNavigateToBuilder={() => {
                        if (navigate) navigate('/scatter-builder');
                        else log('Scatter: Cannot navigate to scatter-builder in split view');
                      }}
                    />
                  </Show>
                </Show>
              }
          >
            <Show when={!zoom()}>
              <div 
                class={`${className()} ${charts().length === 1 ? 'single-chart' : ''}`}
                style={{
                  "padding-top": charts().length === 1 ? "100px" : (charts().length < 4 ? "15vh" : "50px"),
                  "height": charts().length === 1 ? "auto" : "auto",
                  "max-height": charts().length === 1 ? "none" : "none",
                  "overflow": charts().length === 1 ? "visible" : "visible",
                  "box-sizing": "border-box",
                  "width": charts().length === 1 ? "calc(100% - 200px)" : "100%",
                  "margin-left": charts().length === 1 ? "auto" : "0",
                  "margin-right": charts().length === 1 ? "auto" : "0",
                  "padding-bottom": charts().length === 1 ? "80px" : "0"
                }}
              >
                <For each={charts()}>{(chart, index) => 
                  <SimpleScatter 
                    chart={chart} 
                    colortype={colorType()} 
                    class_name={className()} 
                    showFilterStatus={hasChartFilters(charts())}
                    handleZoom={handleZoom}
                    zoom={zoom()}
                    onReady={onChildChartReady}
                    totalCharts={charts().length}
                  />}
                </For>
                {/* Tooltip removed - now handled by MapContainer for proper positioning */}
              </div>
            </Show>
            <Show when={zoom()}>
                <div class="zoom-container" style={{ "min-height": "800px", "margin-top": "50px" }}>
                  <div class="flex w-full h-full" style={{ height: "800px", width: "calc(100% - 25px)" }}>
                    <SimpleScatter
                      chart={selectedChart()}
                      colortype={colorType()}
                      class_name={className()}
                      showFilterStatus={hasChartFilters(charts())}
                      handleZoom={handleZoom}
                      zoom={zoom()}
                      showFitTable={true}
                    />
                  </div>
                </div>
            </Show>
          </Show>
          </div>
        </div>
      </div>
    </div>

     {/* Overlay loader positioned relative to main-content */}
     <Show when={(() => {
       const init = isInitializing();
       const loading = unifiedDataStore.getLoading('scatter') || progress.isLoading();
       const chartsReady = chartsReadyCount();
       const chartsLength = charts().length;
       const zoomed = zoom();
       const noDataUi = hasChartConfigButNoData();
       const shouldShow =
         init ||
         loading ||
         (!zoomed && chartsLength > 0 && chartsReady < chartsLength && !noDataUi);
       
       debug('🔍 Loading overlay debug:', {
         isInitializing: init,
         unifiedDataStoreLoading: unifiedDataStore.getLoading('scatter'),
         progressLoading: progress.isLoading(),
         chartsReadyCount: chartsReady,
         chartsLength: chartsLength,
         isZoomed: zoomed,
         shouldShow: shouldShow
       });
       
       return shouldShow;
     })()}>
       <LoadingOverlay 
         message={progress.message()} 
         fullScreen={true}
         showProgress={true}
         progress={progress.progress()}
         progressMessage={progress.message()}
       />
     </Show>
    </>
  );
}
