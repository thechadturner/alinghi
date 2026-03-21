import { createSignal, createEffect, onMount, onCleanup, Show } from 'solid-js';
import * as d3 from 'd3';
import { useSearchParams, useNavigate } from '@solidjs/router';
import PageSettings from "../../../../components/menus/PageSettings";

import { getData, postData, postBinary, groupBy } from "../../../../utils/global";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { warn, error as logError, info, debug } from "../../../../utils/console";
import { persistantStore } from "../../../../store/persistantStore";
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
  setGradeOptions
} from "../../../../store/filterStore";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName, setSelectedPage } = persistantStore;
import { user } from "../../../../store/userStore";
import LoadingOverlay from "../../../../components/utilities/Loading";
import DataNotFoundMessage from "../../../../components/utilities/DataNotFoundMessage";
import { apiEndpoints } from "@config/env";
import { applyDataFilter } from "../../../../utils/dataFiltering";
import { applyCommonFilters } from "../../../../utils/commonFiltering";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { useChartProgress } from "../../../../utils/useChartProgress";
import { 
  triggerUpdate as selectionTriggerUpdate,
  selectedRange,
  selectedRanges,
  cutEvents,
  hasSelection,
  isCut
} from "../../../../store/selectionStore";

export default function Parallel(props) {
  const twaFilterOptions = ["Upwind", "Downwind", "Reaching", "Port", "Stbd"]; 
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  // Get object name from URL params, props, or use default
  const [objectName, setObjectName] = createSignal(searchParams.object_name || props?.objectName || 'default');
  
  
  // Set the selected page when component loads
  if (objectName() && objectName() !== 'default') {
    setSelectedPage(objectName());
  }
  
  // Register cleanup for data store
  
  // State management with Solid.js signals
  const [channels, setChannels] = createSignal([]);
  const [display, setDisplay] = createSignal([]);
  const [data, setData] = createSignal([]);
  const [filteredData, setFilteredData] = createSignal([]);
  const [selectedData, setSelectedData] = createSignal([]);
  // Initialize with default BSP channel name (will be updated when channels load)
  const [savedCAxis, setSavedCAxis] = createSignal(defaultChannelsStore.bspName() || 'bsp'); // Default coloring axis
  const [isInitializing, setIsInitializing] = createSignal(false);
  const [isProcessingData, setIsProcessingData] = createSignal(false);
  const [isBuildingChart, setIsBuildingChart] = createSignal(false);
  const [chartConfig, setChartConfig] = createSignal(null);
  const [dataFetchError, setDataFetchError] = createSignal<string | null>(null);
  const [missingChannelsError, setMissingChannelsError] = createSignal<string[] | null>(null);
  
  // Progress tracking
  const progress = useChartProgress({
    chartType: 'parallel',
    className: selectedClassName,
    sourceId: selectedSourceId
  });
  
  // AbortController for managing fetch requests
  let abortController: AbortController | null = new AbortController();
  
  // Settings and constants
  let cScale;
  let chartRef;
  let containerRef;
  
  // Chart-specific filter logic
  const hasChartSpecificFilters = (chartConfig) => {
    return chartConfig?.filters && chartConfig.filters.length > 0;
  };

  const applyAppropriateFilters = (data, chartConfig) => {
    if (hasChartSpecificFilters(chartConfig)) {
      // Use chart-specific filters only (ignore global filters)
      return applyCommonFilters(data, {
        selectedStates: chartConfig.filters,
        selectedRaces: [],
        selectedLegs: [],
        selectedGrades: []
      });
    } else {
      // Use global filtering system
      return applyDataFilter(data);
    }
  };

  
  // Margins are now calculated responsively in buildParallel function

  // Add resize listener for responsive chart sizing with debounce
  let resizeTimeout;
  const handleResize = () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (selectedData() && selectedData().length > 0 && channels().length > 1) {
        const dims = channels()
          .filter(channel => channel.name !== 'Datetime')
          .map(channel => channel.name);
        
        if (dims.length > 0) {
          buildParallel(selectedData(), dims);
        }
      }
    }, 250); // Debounce resize events by 250ms
  };

  // Load user settings
  onMount(async () => {
    await fetchChannels();
    window.addEventListener('resize', handleResize);
  });

  // Cleanup resize listener
  onCleanup(() => {
    window.removeEventListener('resize', handleResize);
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
  });

  // Solid.js effects to replace React useEffect
  createEffect(() => {
    if (channels().length > 0) {
      fetchAndFormatData();
    }
  }, [channels()]);

  createEffect(() => {
    // Track filter signals for reactivity
    const states = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    
    if (data().length > 0) {
      try { info('Parallel filtering - raw', { length: data().length }); } catch {}
      try { debug('Parallel filtering - chart config', chartConfig()); } catch {}
      try { debug('Parallel filtering - available fields', Object.keys(data()[0] || {})); } catch {}
      try { debug('Parallel filtering - required channels', channels().map(ch => ch.name)); } catch {}
      try { debug('Parallel filtering - filter signals', { states, races, legs, grades }); } catch {}
      const filtered = applyAppropriateFilters(data(), chartConfig());
      try { info('Parallel filtering - filtered length', { length: filtered.length }); } catch {}
      
      // Only keep chart channels for visualization (exclude Datetime and filtering metadata)
      const chartChannels = channels().map(ch => ch.name);
      const missingCounts = new Map();
      const visualizationData = filtered.map(item => {
        const chartItem = {};
        chartChannels.forEach(channelName => {
          if (item[channelName] !== undefined) {
            chartItem[channelName] = item[channelName];
          } else {
            // Count missing per channel; avoid per-point spam
            missingCounts.set(channelName, (missingCounts.get(channelName) || 0) + 1);
            // Do not synthesize zeros; omit missing keys
          }
        });
        return chartItem;
      });
      // If some channels have no data at all, drop them from the chart config
      // But ensure we keep at least 2 channels for a valid parallel chart
      if (missingCounts.size > 0) {
        const allMissing = Array.from(missingCounts.entries())
          .filter(([_, count]) => count === filtered.length)
          .map(([name]) => name);
        
        if (allMissing.length > 0) {
          const currentChannelCount = channels().length;
          const remainingAfterRemoval = currentChannelCount - allMissing.length;
          
          // Only remove channels if we'll have at least 2 left (minimum for parallel chart)
          if (remainingAfterRemoval >= 2) {
            const removedChannels = allMissing;
            setChannels(channels().filter(ch => !allMissing.includes(ch.name)));
            setDisplay(display().filter(ch => !allMissing.includes(ch.name)));
            
            const errorContext = {
              className: selectedClassName(),
              projectId: selectedProjectId(),
              datasetId: selectedDatasetId(),
              sourceId: selectedSourceId(),
              removedChannels: removedChannels.slice(0, 10),
              totalRemoved: removedChannels.length,
              remainingChannels: channels().filter(ch => !allMissing.includes(ch.name)).map(ch => ch.name).slice(0, 10),
              remainingCount: remainingAfterRemoval
            };
            warn('⚠️ Parallel: Removed channels with no data from chart configuration', errorContext);
          } else {
            // Not enough channels to remove - warn but keep them
            const errorContext = {
              className: selectedClassName(),
              projectId: selectedProjectId(),
              datasetId: selectedDatasetId(),
              sourceId: selectedSourceId(),
              missingChannels: allMissing.slice(0, 10),
              totalMissing: allMissing.length,
              currentChannelCount,
              reason: 'Would leave fewer than 2 channels - keeping all channels'
            };
            warn('⚠️ Parallel: Cannot remove missing channels - would leave insufficient channels for chart', errorContext);
          }
        }
        
        // Log partial missing channels (channels missing in some but not all data points)
        const partialMissing = Array.from(missingCounts.entries())
          .filter(([name, count]) => count > 0 && count < filtered.length)
          .map(([name, count]) => ({ name, missingCount: count, totalCount: filtered.length }));
        
        if (partialMissing.length > 0) {
          debug('⚠️ Parallel: Channels missing in some data points (partial data):', {
            partialMissing: partialMissing.slice(0, 10),
            totalPartial: partialMissing.length
          });
        }
      }
      
      setFilteredData(visualizationData);
      // Don't set selectedData here - let the selection effect handle it
    }
  }, [data(), chartConfig(), channels()]);

  // Re-apply filtering when chart configuration changes
  createEffect(() => {
    // Track filter signals for reactivity
    const states = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    
    if (data().length > 0 && chartConfig()) {
      try { debug('Parallel: Filter signals changed, re-filtering', { states, races, legs, grades }); } catch {}
      const filtered = applyAppropriateFilters(data(), chartConfig());
      
      // Only keep chart channels for visualization (exclude Datetime and filtering metadata)
      const chartChannels = channels().map(ch => ch.name);
      const missingCounts = new Map();
      const visualizationData = filtered.map(item => {
        const chartItem = {};
        chartChannels.forEach(channelName => {
          if (item[channelName] !== undefined) {
            chartItem[channelName] = item[channelName];
          } else {
            missingCounts.set(channelName, (missingCounts.get(channelName) || 0) + 1);
          }
        });
        return chartItem;
      });
      if (missingCounts.size > 0) {
        const allMissing = Array.from(missingCounts.entries())
          .filter(([_, count]) => count === filtered.length)
          .map(([name]) => name);
        
        if (allMissing.length > 0) {
          const currentChannelCount = channels().length;
          const remainingAfterRemoval = currentChannelCount - allMissing.length;
          
          // Only remove channels if we'll have at least 2 left (minimum for parallel chart)
          if (remainingAfterRemoval >= 2) {
            const removedChannels = allMissing;
            setChannels(channels().filter(ch => !allMissing.includes(ch.name)));
            setDisplay(display().filter(ch => !allMissing.includes(ch.name)));
            
            debug('⚠️ Parallel: Removed channels with no data from chart configuration:', {
              removedChannels: removedChannels.slice(0, 10),
              totalRemoved: removedChannels.length,
              remainingCount: remainingAfterRemoval
            });
          } else {
            debug('⚠️ Parallel: Cannot remove missing channels - would leave insufficient channels for chart:', {
              missingChannels: allMissing.slice(0, 10),
              currentChannelCount,
              wouldLeave: remainingAfterRemoval
            });
          }
        }
        
        // Log partial missing channels
        const partialMissing = Array.from(missingCounts.entries())
          .filter(([name, count]) => count > 0 && count < filtered.length);
        
        if (partialMissing.length > 0) {
          debug('⚠️ Parallel: Channels missing in some data points:', Object.fromEntries(partialMissing.slice(0, 10)));
        }
      }
      
      setFilteredData(visualizationData);
      // Don't set selectedData here - let the selection effect handle it
    }
  });

  // Initialize selectedData with filteredData if no selection is active
  createEffect(() => {
    if (filteredData() && filteredData().length > 0 && (!selectedData() || selectedData().length === 0)) {
      try { info('Parallel: initializing selectedData with filteredData'); } catch {}
      setSelectedData(filteredData());
    }
  }, [filteredData(), selectedData()]);

  createEffect(() => {
    if (selectedData() && selectedData().length > 0 && channels().length > 1) {
      try { info('Parallel: Building chart', { selectedLen: selectedData().length }); } catch {}
      try { debug('Parallel: Channels available', channels().map(c => c.name)); } catch {}
      
      // Extract dimension names (excluding datetime)
      const dims = channels()
        .filter(channel => channel.name !== 'Datetime')
        .map(channel => channel.name);
      
      try { debug('Parallel: Dimensions for chart', dims); } catch {}
      
      // Set the first channel as the default color axis if not already set or if current axis not in dimensions
      // Preserve original case from defaultChannelsStore for API compatibility
      // Use case-insensitive comparison for matching
      const defaultBspName = defaultChannelsStore.bspName();
      const currentAxis = savedCAxis();
      const currentAxisLower = currentAxis.toLowerCase();
      const defaultBspNameLower = defaultBspName.toLowerCase();
      if ((currentAxisLower === 'bsp' || currentAxisLower === defaultBspNameLower || !dims.includes(savedCAxis())) && dims.length > 0) {
        setSavedCAxis(dims[0]);
        try { info('Parallel: Set color axis', { axis: dims[0] }); } catch {}
      }
      
      buildParallel(selectedData(), dims);
    } else {
      const errorContext = {
        className: selectedClassName(),
        projectId: selectedProjectId(),
        datasetId: selectedDatasetId(),
        sourceId: selectedSourceId(),
        selectedDataLength: selectedData()?.length || 0,
        channelsLength: channels().length,
        hasSelectedData: !!(selectedData() && selectedData().length > 0),
        hasChannels: channels().length > 0,
        channelNames: channels().map(c => c.name).slice(0, 10)
      };
      warn('⚠️ Parallel: Cannot build chart - missing data or channels', errorContext);
      
      // Provide helpful message about what's missing
      if (channels().length < 2) {
        warn('⚠️ Parallel: Need at least 2 channels to build parallel chart', {
          currentChannels: channels().length,
          channelNames: channels().map(c => c.name)
        });
      }
    }
  }, [selectedData(), channels()]);

  // Effect to handle selection changes using reactive signals (like working charts)
  createEffect(() => {
    try { debug('Parallel selection effect', { hasSelection: hasSelection(), rangeLen: selectedRange().length, rangesLen: selectedRanges().length, isCut: isCut(), cutLen: cutEvents().length, dataLen: data().length }); } catch {}
    
    if (data() && data().length > 0) {
      try { info('Parallel: selection change'); debug('Parallel: original length', data().length); debug('Parallel: sample', data()[0]); } catch {}
      
      // Use applyDataFilter which handles both unified filters AND selectedRange/selectedRanges
      const filteredData = applyDataFilter(data());
      try { info('Parallel: filtered length after applyDataFilter', { length: filteredData.length }); debug('Parallel: sample filtered', filteredData[0]); } catch {}
      
      // Create visualization data that includes Datetime for proper filtering
      const chartChannels = channels().map(ch => ch.name);
      const missingCounts = new Map();
      const visualizationData = filteredData.map(item => {
        const chartItem = {};
        chartChannels.forEach(channelName => {
          if (item[channelName] !== undefined) {
            chartItem[channelName] = item[channelName];
          } else {
            missingCounts.set(channelName, (missingCounts.get(channelName) || 0) + 1);
          }
        });
        if (item.Datetime !== undefined) {
          chartItem.Datetime = item.Datetime;
        }
        return chartItem;
      });
      if (missingCounts.size > 0) {
        const allMissing = Array.from(missingCounts.entries())
          .filter(([_, count]) => count === filteredData.length)
          .map(([name]) => name);
        
        if (allMissing.length > 0) {
          const currentChannelCount = channels().length;
          const remainingAfterRemoval = currentChannelCount - allMissing.length;
          
          // Only remove channels if we'll have at least 2 left (minimum for parallel chart)
          if (remainingAfterRemoval >= 2) {
            const removedChannels = allMissing;
            setChannels(channels().filter(ch => !allMissing.includes(ch.name)));
            setDisplay(display().filter(ch => !allMissing.includes(ch.name)));
            
            const errorContext = {
              className: selectedClassName(),
              projectId: selectedProjectId(),
              datasetId: selectedDatasetId(),
              sourceId: selectedSourceId(),
              removedChannels: removedChannels.slice(0, 10),
              totalRemoved: removedChannels.length,
              remainingCount: remainingAfterRemoval
            };
            warn('⚠️ Parallel: Removed channels with no data from chart configuration', errorContext);
          } else {
            const errorContext = {
              className: selectedClassName(),
              projectId: selectedProjectId(),
              datasetId: selectedDatasetId(),
              sourceId: selectedSourceId(),
              missingChannels: allMissing.slice(0, 10),
              currentChannelCount,
              reason: 'Would leave fewer than 2 channels'
            };
            warn('⚠️ Parallel: Cannot remove missing channels - would leave insufficient channels for chart', errorContext);
          }
        }
        
        // Log partial missing channels
        const partialMissing = Array.from(missingCounts.entries())
          .filter(([name, count]) => count > 0 && count < filteredData.length);
        
        if (partialMissing.length > 0) {
          debug('⚠️ Parallel: Channels missing in some data points:', Object.fromEntries(partialMissing.slice(0, 10)));
        }
      }
      
      // Update the selected data and rebuild chart
      setSelectedData(visualizationData);
      
      if (channels().length > 1) {
        const dims = channels()
          .filter(channel => channel.name !== 'Datetime')
          .map(channel => channel.name);
        
        if (dims.length > 0) {
          buildParallel(visualizationData, dims);
        }
      }
    }
  }, [hasSelection(), selectedRange(), selectedRanges(), cutEvents(), data(), channels()]);

  const fetchCharts = async (signal) => {
    try {
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=parallel&object_name=${encodeURIComponent(objectName())}`, signal);
      
      
      if (response.success && response.data && response.data.chart_info && response.data.chart_info.length > 0) {
        return response.data.chart_info;
      } else {
        return [];
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
      }
      return [];
    }
  };

  /**
   * Fetch dataset metadata with retry logic and fallback date resolution
   * @param maxRetries Maximum number of retry attempts (default: 2)
   * @returns Object with success flag and formatted date (YYYYMMDD) or null
   */
  const fetchDatasetMetadataWithRetry = async (maxRetries: number = 2): Promise<{ success: boolean; date: string | null; error?: string }> => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const datasetId = selectedDatasetId();
    
    const logContext = {
      className,
      projectId,
      datasetId,
      sourceId: selectedSourceId()
    };
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          debug(`🔍 Parallel: Retrying dataset metadata fetch (attempt ${attempt + 1}/${maxRetries + 1})`, logContext);
          // Wait before retry (exponential backoff: 500ms, 1000ms)
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
        
        const url = `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`;
        debug(`🔍 Parallel: Fetching dataset metadata (attempt ${attempt + 1}/${maxRetries + 1})`, { ...logContext, url });
        
        const response = await getData(url, abortController?.signal || new AbortController().signal);
        
        if (response && response.success && response.data) {
          // Validate that date exists and is a valid format
          const rawDate = response.data.date;
          if (rawDate && typeof rawDate === 'string') {
            const formattedDate = rawDate.replace(/[-/]/g, '');
            // Validate date format (should be YYYYMMDD after normalization)
            if (formattedDate.length === 8 && /^\d{8}$/.test(formattedDate)) {
              debug('✅ Parallel: Successfully fetched dataset metadata', { ...logContext, date: formattedDate });
              return { success: true, date: formattedDate };
            } else {
              warn('⚠️ Parallel: Dataset metadata date format invalid', { ...logContext, rawDate, formattedDate });
            }
          } else {
            warn('⚠️ Parallel: Dataset metadata missing or invalid date field', { ...logContext, hasData: !!response.data, dateType: typeof rawDate });
          }
        } else {
          const errorMsg = response?.message || response?.error || 'Unknown error';
          warn(`⚠️ Parallel: Dataset metadata fetch failed (attempt ${attempt + 1}/${maxRetries + 1})`, { ...logContext, error: errorMsg, responseSuccess: response?.success });
        }
      } catch (error: any) {
        if (error.name === 'AbortError') {
          debug('🔍 Parallel: Dataset metadata fetch aborted', logContext);
          return { success: false, date: null, error: 'Aborted' };
        }
        
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        if (attempt < maxRetries) {
          warn(`⚠️ Parallel: Dataset metadata fetch error (will retry): ${errorMessage}`, { ...logContext, attempt: attempt + 1, maxRetries });
        } else {
          logError(`❌ Parallel: Dataset metadata fetch failed after ${maxRetries + 1} attempts: ${errorMessage}`, error, logContext);
        }
      }
    }
    
    // All retries failed - try fallback date resolution
    debug('🔄 Parallel: Attempting fallback date resolution', logContext);
    
    // Fallback 1: Try to get date from URL parameters or search params
    const searchParams = new URLSearchParams(window.location.search);
    const urlDate = searchParams.get('date');
    if (urlDate) {
      const formattedUrlDate = urlDate.replace(/[-/]/g, '');
      if (formattedUrlDate.length === 8 && /^\d{8}$/.test(formattedUrlDate)) {
        info('✅ Parallel: Using date from URL parameters', { ...logContext, date: formattedUrlDate });
        return { success: true, date: formattedUrlDate };
      }
    }
    
    // Fallback 2: Use current date as last resort (formatted as YYYYMMDD)
    const today = new Date();
    const fallbackDate = today.toISOString().split('T')[0].replace(/-/g, '');
    warn('⚠️ Parallel: Using current date as fallback (dataset metadata unavailable)', { ...logContext, fallbackDate });
    return { success: true, date: fallbackDate };
  };

  const fetchChannels = async () => {
    try {
      setIsInitializing(true);
      unifiedDataStore.setLoading('parallel', true);
      
      debug('🔍 Parallel: Fetching chart configuration...');
      debug('🔍 Parallel: Object name:', objectName());
      debug('🔍 Parallel: Selected class:', selectedClassName());
      debug('🔍 Parallel: Selected project:', selectedProjectId());
      debug('🔍 Parallel: User ID:', user()?.user_id);
      
      const chartsData = await fetchCharts(abortController?.signal || new AbortController().signal);
      
      debug('🔍 Parallel: Chart data received:', chartsData);
      
      if (chartsData.length === 0) {
        debug('❌ Parallel: No chart configuration found');
        setChannels([]);
        setDisplay([]);
        setChartConfig(null);
        return;
      }

      // Store chart configuration for filtering logic
      setChartConfig(chartsData[0]);
      
      // Only include chart channels for display (exclude Datetime and filtering metadata)
      let channel_items = [];
      let display_items = [];

      let series_list = chartsData[0].series;

      series_list.forEach(item => {
        let channel_item = item.channel;
        channel_items.push(channel_item);

        try {
          channel_item.color = item.color;
        } catch {
          channel_item.color = 'var(--color-chart-axis)'; // Default color
        }

        display_items.push(channel_item);
      });

      debug('🔍 Parallel: Channels configured:', channel_items.map(c => c.name));
      debug('🔍 Parallel: Display items:', display_items.map(c => c.name));
      
      setChannels(channel_items);
      setDisplay(display_items);
    } catch (error) {
      if (error.name !== 'AbortError') {
        logError("❌ Parallel: Error loading charts:", error.message);
      }
      setChannels([]);
      setDisplay([]);
    } finally {
      setIsInitializing(false);
      unifiedDataStore.setLoading('parallel', false);
    }
  };

  const fetchAndFormatData = async () => {
    try {
      if (channels().length > 0) {
        debug('🔍 Parallel: Starting data fetch with channels:', channels().map(c => c.name));
        setIsProcessingData(true);
        progress.setProgress(20, 'Preparing to fetch data...');
        
        // 1. Use unifiedDataStore with explicit timeseries dataSource
        const channelNames = channels().map(ch => ch.name);
        const requiredChannelsSet = new Set(['Datetime', ...channelNames]);
        
        // Get filter channels from UnifiedFilterService (includes Race_number, Leg_number, Grade, State)
        const filterChannels = await UnifiedFilterService.getRequiredFilterChannels(selectedClassName(), 'dataset');
        filterChannels.forEach(channel => requiredChannelsSet.add(channel));
        
        // Always include Twa for filtering (PORT/STBD/UW/DW/RCH)
        // Use exact default channel name (API requires exact match)
        const twaChannelName = defaultChannelsStore.twaName();
        requiredChannelsSet.add(twaChannelName);
        
        const requiredChannels = Array.from(requiredChannelsSet);
        
        debug('🔍 Parallel: Required channels:', requiredChannels);
        debug('🔍 Parallel: Source ID:', selectedSourceId());
        debug('🔍 Parallel: Class name:', selectedClassName());
        
        // CRITICAL: Parallel component handles filtering on the client side
        // Do NOT apply global filters at the data layer - fetch all data and filter in component
        // This prevents 0-row queries when filters don't match data structure
        // The component has its own filtering logic in applyAppropriateFilters() and effects
        
        progress.setProgress(30, 'Fetching data...');
        
        // Get dataset date for proper API calls with retry logic and fallback
        const metadataResult = await fetchDatasetMetadataWithRetry(2);
        
        if (!metadataResult.success || !metadataResult.date) {
          const errorContext = {
            className: selectedClassName(),
            projectId: selectedProjectId(),
            datasetId: selectedDatasetId(),
            sourceId: selectedSourceId(),
            error: metadataResult.error || 'Unknown error'
          };
          logError("❌ Parallel: Failed to fetch dataset metadata and all fallbacks failed", null, errorContext);
          setDataFetchError('Unable to fetch dataset information. Please check your connection and try again.');
          setData([]);
          setIsProcessingData(false);
          return;
        }
        
        // Clear any previous errors
        setDataFetchError(null);
        
        const formattedDate = metadataResult.date;
        debug('🔍 Parallel: Dataset date:', formattedDate);
        
        const data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
          'parallel',
          selectedClassName(),
          selectedSourceId().toString(),
          requiredChannels,
          {
            projectId: selectedProjectId(),
            className: selectedClassName(),
            datasetId: selectedDatasetId(),
            sourceName: selectedSourceName(),
            date: formattedDate, // Use actual dataset date, not today's date
            use_v2: true, // Obsolete - kept for backward compatibility (DuckDB is now the only implementation)
            applyGlobalFilters: false // Always false - Parallel handles filtering client-side
          },
          'timeseries' // Explicitly define data source
        );

        debug('🔍 Parallel: Unified data store result:', data?.length || 0, 'records');

        if (data && data.length > 0) {
          // Check if all required channels are present in the data
          const availableFields = Object.keys(data[0] || {});
          // Check for missing channels - data fields are in original case
          const missingChannels = requiredChannels.filter(channel => 
            !availableFields.includes(channel)
          );
          
          debug('🔍 Parallel: Data sample fields:', availableFields);
          debug('🔍 Parallel: Required channels:', requiredChannels);
          debug('🔍 Parallel: Missing channels:', missingChannels);
          
          if (missingChannels.length > 0) {
            const errorContext = {
              className: selectedClassName(),
              projectId: selectedProjectId(),
              datasetId: selectedDatasetId(),
              sourceId: selectedSourceId(),
              sourceName: selectedSourceName(),
              missingChannels: missingChannels.slice(0, 10),
              totalMissing: missingChannels.length,
              availableFields: availableFields.slice(0, 10),
              totalAvailable: availableFields.length,
              requiredChannels: requiredChannels.slice(0, 10),
              totalRequired: requiredChannels.length
            };
            warn('⚠️ Parallel: Missing channels in data', errorContext);
            debug('🔍 Parallel: Full channel analysis:', errorContext);
            
            // Set missing channels error for UI display
            setMissingChannelsError(missingChannels);
            
            // Try to re-fetch with all required channels - fetchDataWithChannelCheckingFromFile
            // already handles missing channels internally by fetching from API
            debug('🔄 Parallel: Attempting to re-fetch data with all required channels...', {
              className: selectedClassName(),
              projectId: selectedProjectId(),
              datasetId: selectedDatasetId(),
              sourceId: selectedSourceId(),
              missingCount: missingChannels.length,
              missingChannels: missingChannels.slice(0, 5)
            });
            
            try {
              // Get dataset date for re-fetch (use cached result if available, otherwise fetch again)
              const refetchMetadataResult = await fetchDatasetMetadataWithRetry(1); // Use fewer retries for refetch
              const refetchFormattedDate = refetchMetadataResult.success && refetchMetadataResult.date 
                ? refetchMetadataResult.date
                : formattedDate; // Fallback to previously fetched date
              
              // Re-fetch with all required channels - the unified data store will handle missing channels
              const completeData = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
                'parallel',
                selectedClassName(),
                selectedSourceId().toString(),
                requiredChannels,
                {
                  projectId: selectedProjectId(),
                  className: selectedClassName(),
                  datasetId: selectedDatasetId(),
                  sourceName: selectedSourceName(),
                  date: refetchFormattedDate,
                  use_v2: true, // Obsolete - kept for backward compatibility
                  applyGlobalFilters: false // Always false - Parallel handles filtering client-side
                },
                'timeseries'
              );
              
              if (completeData && completeData.length > 0) {
                // Check if we now have the missing channels
                const availableFieldsAfterRefetch = Object.keys(completeData[0] || {});
                const stillMissing = missingChannels.filter(ch => 
                  !availableFieldsAfterRefetch.includes(ch)
                );
                
                if (stillMissing.length === 0) {
                  debug('✅ Parallel: Successfully fetched all missing channels:', completeData.length, 'records');
                  setData(completeData);
                  setMissingChannelsError(null); // Clear error since all channels are now available
                  return;
                } else {
                  debug('⚠️ Parallel: Some channels still missing after refetch:', stillMissing.slice(0, 5));
                  // Continue with the data we have - component will handle missing channels gracefully
                }
              } else {
                debug('⚠️ Parallel: Re-fetch returned no data - continuing with available data');
              }
            } catch (refetchError) {
              const errorContext = {
                className: selectedClassName(),
                projectId: selectedProjectId(),
                datasetId: selectedDatasetId(),
                sourceId: selectedSourceId(),
                sourceName: selectedSourceName(),
                missingChannels: missingChannels.slice(0, 10),
                error: refetchError?.message || String(refetchError)
              };
              warn('⚠️ Parallel: Failed to re-fetch missing channels - continuing with available data', errorContext);
              // Continue with the data we have - component will handle missing channels gracefully
            }
          }
          
          debug('✅ Parallel: Using unifiedDataStore for Parallel plot');
          progress.setProgress(100, 'Complete');
          setData(data);
          // Clear errors on successful data fetch
          setDataFetchError(null);
          // Only clear missing channels error if we have at least 2 channels
          if (channels().length >= 2) {
            setMissingChannelsError(null);
          }
          setIsProcessingData(false);
          return;
        }

        // 2. If no integrated data, fetch from API
        debug('🔍 Parallel: No integrated data found, fetching from API');
        // Note: formattedDate was already fetched earlier (line 453), so we reuse it here

        // 3. Create comprehensive channel list for filtering (filterChannels already fetched above)
        const allChannels = [
          { name: 'Datetime', type: 'datetime' },
          ...filterChannels.map(name => ({
            name,
            type: name === 'Datetime' ? 'datetime' : 'float'
          })),
          ...channels() // Add chart-specific channels
        ];

        debug('🔍 Parallel: All channels for API:', allChannels.map(c => c.name));

        const payload = {
            project_id: selectedProjectId(),
            class_name: selectedClassName(),
            date: formattedDate,
            source_name: selectedSourceName(),
            channel_list: allChannels
        };

        debug('🔍 Parallel: API payload:', payload);

        const response = await postBinary(apiEndpoints.file.channelValues, payload, abortController?.signal || new AbortController().signal);

        if (!response.success) {
          const errorMsg = response?.message || response?.error || 'Unknown API error';
          const errorContext = {
            className: selectedClassName(),
            projectId: selectedProjectId(),
            datasetId: selectedDatasetId(),
            sourceId: selectedSourceId(),
            sourceName: selectedSourceName(),
            date: formattedDate,
            channelCount: allChannels.length,
            channels: allChannels.slice(0, 10).map(c => c.name),
            error: errorMsg
          };
          logError('❌ Parallel: API request failed', null, errorContext);
          setDataFetchError(`Failed to fetch data: ${errorMsg}`);
          setData([]);
          return;
        }

        // 4. Process and map data for filtering
        const channelValuesData = response.data;
        debug('🔍 Parallel: API data received:', channelValuesData?.length || 0, 'records');
        
        if (channelValuesData.length > 0) {
            const processedData = channelValuesData.map(value => {
                // Create a new object to avoid proxy modification issues
                return {
                    ...value,
                    Datetime: new Date(value.Datetime)
                };
            });
            
            // Debug: Log data structure
            debug('✅ Parallel: Data sample:', processedData[0]);
            debug('✅ Parallel: Available fields:', Object.keys(processedData[0]));
            
            setData(processedData);
            // Clear errors on successful data fetch
            setDataFetchError(null);
            if (channels().length >= 2) {
              setMissingChannelsError(null);
            }
        } else {
            debug('❌ Parallel: No data received from API');
            setDataFetchError('No data available for the selected dataset and channels.');
            setData([]);
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        const errorContext = {
          className: selectedClassName(),
          projectId: selectedProjectId(),
          datasetId: selectedDatasetId(),
          sourceId: selectedSourceId(),
          sourceName: selectedSourceName(),
          channelCount: channels().length,
          channels: channels().slice(0, 10).map(c => c.name),
          error: errorMessage,
          stack: error?.stack
        };
        logError("❌ Parallel: Error fetching and formatting data", error, errorContext);
      }
      setData([]);
      return;
    } finally {
      setIsProcessingData(false);
      // Ensure progress is complete if we got here
      if (progress.isLoading()) {
        progress.setProgress(100, 'Complete');
      }
    }
  };

  function updateColorScale(channel, data) {
    // Check if channel exists in the data
    const channelExists = data.some(d => channel in d);
    
    if (!channelExists) {
      // Use a default scale if channel doesn't exist
      warn(`Channel "${channel}" not found in data, using default color scale`);
      cScale = d3.scaleOrdinal(d3.schemeCategory10);
      return;
    }
    
    // Filter out records where the channel doesn't exist or has invalid values
    const validData = data.filter(d => 
      channel in d && 
      d[channel] !== undefined && 
      d[channel] !== null && 
      !isNaN(+d[channel])
    );
    
    if (validData.length === 0) {
      warn(`No valid data for channel "${channel}", using default color scale`);
      cScale = d3.scaleOrdinal(d3.schemeCategory10);
      return;
    }
    
    const min = d3.min(validData, p => +p[channel]);
    const max = d3.max(validData, p => +p[channel]);
    const int = (max - min) / 6;

    let checkChannels = ["LOCATION","HEADSAIL","MAINSAIL","PLATFORM","FOIL_LWD","ARM_LWD","RUDDER","WEIGHT","TACK","CREW"];

    let found = false;
    let groupcount = 0;
    checkChannels.forEach(check => {
      if (channel == check) {
        let unique_vals = groupBy(data, channel);

        let vals = [];
        unique_vals.forEach(val => {
          if (val.toString() != "0") {
            vals.push(val);
          }
        });
        unique_vals = vals;

        groupcount = unique_vals.length;

        if (unique_vals.length < 6) {
          cScale = d3.scaleOrdinal(d3.schemeSet1);
          found = true;
        }
      }
    });

    if (found == false) {
      if (channel === 'Twa') {
        cScale = d3.scaleLinear()
          .domain([min + (int * 5), min + (int * 4), min + (int * 3), min + (int * 2), min + int, min])
          .range(["#388E3C", "#4CAF50", "#81C784", "#E57373", "#F44336", "#D32F2F"]);
      } else {
        cScale = d3.scaleLinear()
          .domain([min + (int * 5), min + (int * 4), min + (int * 3), min + (int * 2), min + int, min])
          .range(["#B91717", "#FF3C33", "#ECFF33", "#33FF3F", "#3336FF", "#1F147C"]);
      }
    }
  }

  let activeBrushes = new Map();

  function reColorLines(data) {
    updateColorScale(savedCAxis(), data);

    let chartbody = d3.select("#parallel").select("#plot");

    // Only update the foreground (colored) lines, not the background
    chartbody.selectAll("g.foreground").selectAll("path")
      .style("stroke", d => cScale(d[savedCAxis()]));
  }

  function buildParallel(chartData, dims) {
    debug('🔍 Parallel: buildParallel called with:', chartData?.length || 0, 'data points and', dims?.length || 0, 'dimensions');
    debug('🔍 Parallel: Dimensions:', dims);
    debug('🔍 Parallel: Sample data point:', chartData?.[0]);
    
    setIsBuildingChart(true);
    
    // Get accurate container dimensions with better fallbacks
    if (!containerRef) {
      containerRef = document.querySelector(".parallel");
    }
    
    // Use window dimensions as better fallbacks, with minimum sizes
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const containerWidth = containerRef ? containerRef.clientWidth : Math.max(windowWidth * 0.8, 800);
    const containerHeight = containerRef ? containerRef.clientHeight : Math.max(windowHeight * 0.6, 600);
    
    // Calculate responsive margins based on container size
    const responsiveMargin = {
      top: Math.max(30, containerHeight * 0.05),
      right: Math.max(20, containerWidth * 0.02),
      bottom: Math.max(20, containerHeight * 0.04),
      left: Math.max(20, containerWidth * 0.02)
    };
    
    // Use responsive margins for better space utilization
    const pwidth = containerWidth - responsiveMargin.left - responsiveMargin.right;
    const pheight = containerHeight - responsiveMargin.top - responsiveMargin.bottom;
    
    // Clear active brushes when rebuilding
    activeBrushes = new Map();

    if (chartData != undefined) {
      // Validate data before building chart
      const validDataPoints = chartData.filter(d => {
        if (!d || typeof d !== 'object') return false;
        return dims.every(dim => 
          dim in d && 
          d[dim] !== undefined && 
          d[dim] !== null && 
          !isNaN(+d[dim])
        );
      });
      
      debug('🔍 Parallel: Valid data points for visualization:', validDataPoints.length, 'out of', chartData.length);
      
      if (validDataPoints.length === 0) {
        debug('❌ Parallel: No valid data points for visualization');
        debug('❌ Parallel: Sample invalid data point:', chartData[0]);
        debug('❌ Parallel: Required dimensions:', dims);
        setIsBuildingChart(false);
        return;
      }
      
      const svg = d3.select("#parallel")
        .attr("viewBox", `0 0 ${containerWidth} ${containerHeight}`)
        .attr("preserveAspectRatio", "xMidYMid meet");
      
      svg.select("#plot").selectAll("*").remove();
    
      // Use less padding to take more horizontal space
      let xScale = d3.scalePoint().range([0, pwidth]).padding(0.2).domain(dims),
        yScales = {};
    
      let line = d3.line()
          .x(d => d[0])
          .y(d => d[1]), 
        axis = d3.axisLeft(),
        background, 
        foreground;
    
      let chartbody = svg.select("#plot")
        .attr("transform", `translate(${responsiveMargin.left},${responsiveMargin.top})`)
        .attr("width", pwidth)
        .attr("height", pheight);
    
      xScale.domain(dims);
    
      // Store original scales that won't change during brushing
      const originalYScales = {};
      
      dims.forEach(function (d) {
        const yExtent = d3.extent(chartData, p => +p[d]);
    
        if (yExtent[0] == yExtent[1]) {
          yExtent[0] = yExtent[0] - (yExtent[0] * 0.5);
          yExtent[1] = yExtent[1] + (yExtent[1] * 0.5);
        }
    
        // Create both original and working scales
        originalYScales[d] = d3.scaleLinear()
          .domain(yExtent)
          .range([pheight, 0]);
          
        yScales[d] = d3.scaleLinear()
          .domain(yExtent)
          .range([pheight, 0]);
      });
    
      function transition(g) {
        return g.transition().duration(500);
      }
    
      function path(d) {
        // Skip if data point is entirely undefined
        if (!d) return null;
        
        // Check if all dimensions exist in the data point
        const allKeysExist = dims.every(p => 
          p in d && d[p] !== undefined && d[p] !== null && !isNaN(+d[p])
        );
        
        // If any key is missing, skip this record
        if (!allKeysExist) return null;
        
        const pathData = dims.map(p => [xScale(p), originalYScales[p](+d[p])]);
        return line(pathData);
      }

      function drawLines() {
        updateColorScale(savedCAxis(), chartData);
    
        chartbody.selectAll("g.foreground").remove();
        chartbody.selectAll("g.background").remove();
    
        // Add light grey background lines for ALL original data - provides context
        background = chartbody.append("g")
          .attr("class", "background parallel-background");
        
        const backgroundPaths = background.selectAll("path")
          .data(chartData); // Use original chartData for full context
        
        backgroundPaths.enter()
          .append("path")
          .merge(backgroundPaths)
          .attr("d", path)
          .style("stroke", "lightgrey")
          .style("stroke-width", "1")
          .style("opacity", "0.3");
        
        backgroundPaths.exit().remove();
    
        // Add colored foreground lines for FILTERED data only
        foreground = chartbody.append("g")
          .attr("class", "foreground parallel-foreground");
        
        const foregroundPaths = foreground.selectAll("path")
          .data(selectedData()); // Use selectedData (filtered) for colored lines
        
        foregroundPaths.enter()
          .append("path")
          .merge(foregroundPaths)
          .style("stroke", d => {
            // Add null check for better robustness
            const axis = savedCAxis();
            return d && axis in d ? cScale(d[axis]) : "var(--color-chart-line)";
          })
          .style("stroke-width", "2")
          .style("opacity", "0.8")
          .attr("d", path);
        
        foregroundPaths.exit().remove();
        
        drawElements();
      }
    
      function drawElements() {
        chartbody.selectAll("g.dimension").remove();
    
        // Using D3 v6 join pattern for dimensions (no dragging)
        let g = chartbody.selectAll(".dimension")
          .data(dims)
          .join("g")
          .attr("class", "dimension")
          .attr("transform", d => `translate(${xScale(d)})`);  

        drawLabels();
  
        g.append("g")
          .attr("class", "parallel-brush")
          .call(d3.brushY()
          .extent([[-10, 0], [10, pheight]])
          .on("brush", brushed)
          .on("end", brushEnd)
        );
        
        debug('🔍 Brush extent set to:', [[-10, 0], [10, pheight]], 'pheight:', pheight);
      }
    
      function drawLabels() {
        let g = chartbody.selectAll(".dimension");
    
        // Add an axis and title using D3 v6 patterns - use original scales for consistent axis display
        g.append("g")
          .attr("class", "axis parallel-axis")
          .each(function(d) { 
            d3.select(this).call(axis.scale(originalYScales[d])); 
          })
          .append("text")
          .attr("class", d => d === savedCAxis() ? "selected" : "")
          .style("text-anchor", "middle")
          .attr("y", -12)
          .attr("transform", function(d, i) {
            return i % 2 !== 0 ? "translate(0,-20)" : "translate(0,0)";
          })
          .text(d => d)
          .style("cursor", "pointer")
          .style("pointer-events", "all")
          .style("user-select", "none")
          .on("click", function(event, d) {
            event.stopPropagation();
            // Only handle click if there's no active brush
            if (!activeBrushes.has(d)) {
              click(d);
            }
          });
      }
    
      drawLines();
    
      function click(d) {
        try {
          // Set savedCAxis with the setter function
          setSavedCAxis(d);
              
          
          // Apply color changes immediately
          updateColorScale(d, filteredData());
          
          // Update the stroke color of each path
          d3.select("#parallel").select("#plot")
            .selectAll("g.foreground").selectAll("path")
            .style("stroke", function(data) {
              // Make sure the data has the selected dimension
              if (data && d in data) {
                return cScale(data[d]);
              }
              return "var(--color-chart-line)"; // Default color for data points missing this dimension
            });
          
          // Redraw labels to show the new selection
          drawLabels();
        }
        catch(err) {
        }
      }
    
      function brushed(event, dim) {
        if (!event.selection) return;
        
        debug('🔍 Brush event:', event.selection, 'for dimension:', dim);
        activeBrushes.set(dim, event.selection);
        
        // Helper function to check if a data point is within all active brush selections
        const isDataPointVisible = (d) => {
          if (!d || typeof d !== 'object') return false;
          
          return dims.every(dimName => {
            const brushSelection = activeBrushes.get(dimName);
            if (!brushSelection) return true; // No brush on this dimension
            
            const y0 = brushSelection[0];
            const y1 = brushSelection[1];
            // Use original scales for consistent coordinate conversion
            const v0 = originalYScales[dimName].invert(y0);
            const v1 = originalYScales[dimName].invert(y1);
            
            // Ensure we have valid data for this dimension
            if (d[dimName] === undefined || d[dimName] === null || isNaN(+d[dimName])) {
              return false;
            }
            
            const value = +d[dimName];
            return value >= Math.min(v0, v1) && value <= Math.max(v0, v1);
          });
        };
      
        // Update only the foreground (colored) lines based on brush selection
        // Background lines (grey) remain unchanged to show full context
        foreground.selectAll("path")
          .style("display", d => isDataPointVisible(d) ? null : "none")
          .style("stroke-width", d => isDataPointVisible(d) ? "2" : "1");
      }

      function brushEnd(event, dim) {
        // Only clear brush if selection is null (brush was cleared)
        if (event.selection !== null) {
          return;
        }
        activeBrushes.delete(dim);
        
        // Helper function to check if a data point is within all active brush selections
        const isDataPointVisible = (d) => {
          if (!d || typeof d !== 'object') return false;
          
          return dims.every(dimName => {
            const brushSelection = activeBrushes.get(dimName);
            if (!brushSelection) return true; // No brush on this dimension
            
            const y0 = brushSelection[0];
            const y1 = brushSelection[1];
            // Use original scales for consistent coordinate conversion
            const v0 = originalYScales[dimName].invert(y0);
            const v1 = originalYScales[dimName].invert(y1);
            
            // Ensure we have valid data for this dimension
            if (d[dimName] === undefined || d[dimName] === null || isNaN(+d[dimName])) {
              return false;
            }
            
            const value = +d[dimName];
            return value >= Math.min(v0, v1) && value <= Math.max(v0, v1);
          });
        };
        
        // Update only the foreground (colored) lines based on remaining brushes
        // Background lines (grey) remain unchanged to show full context
        foreground.selectAll("path")
          .style("display", d => isDataPointVisible(d) ? null : "none")
          .style("stroke-width", d => isDataPointVisible(d) ? "2" : "1");
      }
    
      function brushFilter() {
        try {
          // Don't update selectedData during brushing to prevent chart rebuild
          // The visual filtering is handled in the brushed/brushEnd functions
          debug('🔍 Brush filter applied - not updating selectedData to prevent rebuild');
        } catch (err) {
          logError('Error in brushFilter:', err);
        }
      }
    }
    
    setIsBuildingChart(false);
  }

  // Cleanup on unmount
  onCleanup(() => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  });

  return (
    <div class="w-full h-full relative">
      <Show when={chartConfig() && channels().length > 0}>
        <PageSettings
          useIconTrigger={true}
          options={twaFilterOptions}
          hideColorOptions={true}
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
          toggleFilter={(groupIndex, chartIndex, filter) => {
            const currentFilters = selectedStatesTimeseries();
            let newFilters;
            if (currentFilters.includes(filter)) {
              newFilters = currentFilters.filter(f => f !== filter);
            } else {
              newFilters = [...currentFilters, filter];
            }
            setSelectedStatesTimeseries(newFilters);
          }}
          toggleRaceFilter={(race) => {
            const currentRaces = selectedRacesTimeseries();
            let newRaces;
            if (currentRaces.includes(race)) {
              newRaces = currentRaces.filter(r => r !== race);
            } else {
              newRaces = [...currentRaces, race];
            }
            setSelectedRacesTimeseries(newRaces);
          }}
          toggleLegFilter={(leg) => {
            const currentLegs = selectedLegsTimeseries();
            let newLegs;
            if (currentLegs.includes(leg)) {
              newLegs = currentLegs.filter(l => l !== leg);
            } else {
              newLegs = [...currentLegs, leg];
            }
            setSelectedLegsTimeseries(newLegs);
          }}
          toggleGradeFilter={(grade) => {
            const currentGrades = selectedGradesTimeseries();
            let newGrades;
            if (currentGrades.includes(grade)) {
              newGrades = currentGrades.filter(g => g !== grade);
            } else {
              newGrades = [...currentGrades, grade];
            }
            setSelectedGradesTimeseries(newGrades);
          }}
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
          builderRoute={'/parallel-builder'}
        />
      </Show>
      <Show when={isInitializing() || isProcessingData() || isBuildingChart() || progress.isLoading()}>
        <LoadingOverlay 
          message={
            isInitializing() ? "Loading parallel plot configuration..." :
            isProcessingData() || progress.isLoading() ? progress.message() :
            isBuildingChart() ? "Building chart..." :
            "Loading..."
          }
          showProgress={isProcessingData() || isBuildingChart() || progress.isLoading()}
          progress={isProcessingData() || progress.isLoading() ? progress.progress() : null}
          progressMessage={isProcessingData() || progress.isLoading() ? progress.message() : undefined}
          type={isInitializing() ? "spinner" : "dots"}
          containerStyle="padding-top: 25vh !important;"
        />
      </Show>
      
      <Show 
        when={chartConfig() && channels().length > 0}
        fallback={
          <Show when={!isInitializing() && !unifiedDataStore.getLoading('parallel')}>
            <Show
              when={chartConfig() && channels().length === 0}
              fallback={
                <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
                  <div class="mb-6">
                    <svg class="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                    </svg>
                    <h3 class="text-xl font-semibold text-gray-700 mb-2">No Charts Available</h3>
                    <p class="text-gray-500 mb-6">Would you like to add one?</p>
                  </div>
                  <button 
                    onClick={() => {
                      if (navigate) {
                        navigate('/parallel-builder');
                      } else {
                        logError('Parallel: Cannot navigate to parallel-builder in split view');
                      }
                    }}
                    class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors duration-200 shadow-md hover:shadow-lg"
                  >
                    Add Chart
                  </button>
                </div>
              }
            >
              <DataNotFoundMessage
                builderRoute="/parallel-builder"
                onNavigateToBuilder={() => {
                  if (navigate) navigate('/parallel-builder');
                  else logError('Parallel: Cannot navigate to parallel-builder in split view');
                }}
              />
            </Show>
          </Show>
        }
      >
        {/* Show data fetch error if present */}
        <Show when={dataFetchError()}>
          <div class="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-red-50 border border-red-200 rounded-lg p-4 shadow-lg max-w-2xl">
            <div class="flex items-start">
              <svg class="w-5 h-5 text-red-600 mt-0.5 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <div class="flex-1">
                <h4 class="text-sm font-semibold text-red-800 mb-1">Data Fetch Error</h4>
                <p class="text-sm text-red-700">{dataFetchError()}</p>
              </div>
              <button 
                onClick={() => setDataFetchError(null)}
                class="ml-4 text-red-600 hover:text-red-800"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>
          </div>
        </Show>
        
        {/* Show missing channels warning if present and we have some channels */}
        <Show when={missingChannelsError() && missingChannelsError()!.length > 0 && channels().length >= 2}>
          <div class="absolute top-4 right-4 z-50 bg-yellow-50 border border-yellow-200 rounded-lg p-4 shadow-lg max-w-md">
            <div class="flex items-start">
              <svg class="w-5 h-5 text-yellow-600 mt-0.5 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
              </svg>
              <div class="flex-1">
                <h4 class="text-sm font-semibold text-yellow-800 mb-1">Missing Channels</h4>
                <p class="text-sm text-yellow-700 mb-2">
                  {missingChannelsError()!.length} channel{missingChannelsError()!.length !== 1 ? 's' : ''} not found in data:
                </p>
                <p class="text-xs text-yellow-600 font-mono">
                  {missingChannelsError()!.slice(0, 5).join(', ')}
                  {missingChannelsError()!.length > 5 ? ` (+${missingChannelsError()!.length - 5} more)` : ''}
                </p>
              </div>
              <button 
                onClick={() => setMissingChannelsError(null)}
                class="ml-4 text-yellow-600 hover:text-yellow-800"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>
          </div>
        </Show>
        
        {/* Show insufficient channels error if we have less than 2 channels */}
        <Show when={channels().length > 0 && channels().length < 2 && !isInitializing() && !isProcessingData()}>
          <div class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-50 bg-red-50 border border-red-200 rounded-lg p-6 shadow-lg max-w-md text-center">
            <svg class="w-12 h-12 mx-auto text-red-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <h3 class="text-lg font-semibold text-red-800 mb-2">Insufficient Channels</h3>
            <p class="text-sm text-red-700 mb-4">
              A parallel chart requires at least 2 channels, but only {channels().length} {channels().length === 1 ? 'channel is' : 'channels are'} available.
            </p>
            <p class="text-xs text-red-600 mb-4">
              Available channels: {channels().map(c => c.name).join(', ') || 'None'}
            </p>
            <button 
              onClick={() => {
                if (navigate) {
                  navigate('/parallel-builder');
                }
              }}
              class="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition-colors duration-200"
            >
              Configure Chart
            </button>
          </div>
        </Show>
        <div 
          class="parallel" 
          style={{ 
            width: '100%', 
            height: '100%', 
            position: 'relative', 
            display: 'flex', 
            'justify-content': 'center', 
            'align-items': 'center',
            opacity: (isInitializing() || isProcessingData() || isBuildingChart()) ? 0.3 : 1,
            transition: 'opacity 0.3s ease'
          }}
        >
        <svg id="parallel" width="100%" height="100%" style={{ 'max-width': '100%', 'max-height': '100%', transform: 'translateY(-50px)' }}>
          <g id="plot"></g>
        </svg>
        </div>
      </Show>
    </div>
  );
}
