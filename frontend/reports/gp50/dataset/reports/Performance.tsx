import { onMount, onCleanup, createSignal, For, Show, createEffect, createMemo, batch } from "solid-js";
import { Portal } from "solid-js/web";

import AdvancedScatter from "../../../../components/charts/AdvancedScatter";
import BoxPlot from "../../../../components/charts/BoxPlot";
import ScatterTimeseries from "../../../../components/charts/ScatterTimeseries";

import Legend from "../../../../components/legends/Performance";
import PerformanceFilterSummary from "../../../../components/legends/PerformanceFilterSummary";
import Loading from "../../../../components/utilities/Loading";
import DropDownButton from "../../../../components/buttons/DropDownButton";
import PerfSettings from "../../../../components/menus/PerfSettings";

import { groupBy, getData, getEventTimes, setupMediaContainerScaling, cleanQuotes } from "../../../../utils/global";
import { tooltip } from "../../../../store/globalStore";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../utils/logging";
import { log, debug as logDebug, error as logError, warn as logWarn } from "../../../../utils/console";
import { selectedEvents, cutEvents, setSelection, clearSelection, cutSelection, hideSelectedEvents, setSelectedEvents } from "../../../../store/selectionStore";
import { setStartDate, setEndDate, selectedRacesAggregates, selectedLegsAggregates, selectedStatesAggregates, selectedGradesAggregates, setSelectedStatesAggregates, setSelectedGradesAggregates } from "../../../../store/filterStore";
import { createFilterConfig, passesBasicFilters } from "../../../../utils/filterCore";

import { performanceDataService } from "../../../../services/performanceDataService";
import { persistantStore } from "../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { user } from "../../../../store/userStore";
import { persistentSettingsService } from "../../../../services/persistentSettingsService";
import { getProjectPerformanceFilters } from "../../../../services/projectFiltersService";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { getColorByIndex, resolveDataField } from "../../../../utils/colorScale";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import type {
  PerformanceAggregatePoint,
  PerformanceCloudPoint,
  PerformanceTargetData
} from "../../../../store/dataTypes";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedDate } = persistantStore;

export default function PerformancePage() {
  // Local state for performance data - separate by aggregate type
  const [aggregatesAVG, setAggregatesAVG] = createSignal<PerformanceAggregatePoint[]>([]);
  const [aggregatesSTD, setAggregatesSTD] = createSignal<PerformanceAggregatePoint[]>([]);
  const [aggregatesAAV, setAggregatesAAV] = createSignal<PerformanceAggregatePoint[]>([]);
  // Keep aggregates for backward compatibility (will be set to aggregatesAVG)
  const [aggregates, setAggregates] = createSignal<PerformanceAggregatePoint[]>([]);
  const [cloud, setCloud] = createSignal<PerformanceCloudPoint[]>([]);
  const [targets, setTargets] = createSignal<PerformanceTargetData>({ name: '', data: {} });
  const [showTargetModal, setShowTargetModal] = createSignal(false);
  const [availableTargets, setAvailableTargets] = createSignal<string[]>([]);
  const [selectedTargetName, setSelectedTargetName] = createSignal<string>('');
  const [charts, setCharts] = createSignal<any[]>([]);
  
  // Trigger signal to force getFilteredAggregates to recalculate when filters are applied
  const [filterTrigger, setFilterTrigger] = createSignal(0);

  // Local state for UI management only (no selection state)

  // Get color options from filter config (dataset context)
  const [colors, setColors] = createSignal<string[]>([]); // Start empty, will be populated from filter config
  onMount(() => {
    // 1. Set defaults immediately so UI can render
    setColors(['TACK', 'GRADE', 'STATE']); // Fallback defaults
    setPersistentSettingsInitialized(true); // Mark as initialized so charts can render
    
    // 2. Load actual values in background (don't await)
    (async () => {
      try {
        // Explicitly call getFilterConfig to ensure caching happens (background)
        UnifiedFilterService.getFilterConfig(
          selectedClassName(),
          'dataset',
          selectedProjectId()
        ).catch(err => logDebug('Performance: Error loading filter config in background:', err));
        
        const colorOptions = await UnifiedFilterService.getColorOptions(
          selectedClassName(),
          'dataset',
          selectedProjectId()
        );
        
        if (colorOptions && colorOptions.length > 0) {
          // Add STATE to color options (it's a calculated field, not in filter config)
          const optionsWithState = [...colorOptions];
          if (!optionsWithState.includes('STATE')) {
            optionsWithState.push('STATE');
          }
          setColors(optionsWithState);
          
          // Load color preference from persistent settings in background
          const currentUser = user();
          if (currentUser?.user_id) {
            try {
              const { selectedClassName, selectedProjectId } = persistantStore;
              const className = selectedClassName();
              const projectId = selectedProjectId();
              
              if (className && projectId) {
                const settings = await persistentSettingsService.loadSettings(
                  currentUser.user_id,
                  className,
                  projectId
                );
                
                if (settings?.performanceColor) {
                  const savedColor = cleanQuotes(String(settings.performanceColor));
                  // Only set if it's a valid color option
                  if (colorOptions.includes(savedColor)) {
                    setColor(savedColor);
                    setColorLoadedFromPersistent(true); // Mark that we loaded color from persistent settings
                    logDebug('Performance: Loaded color preference from persistent settings', savedColor);
                  } else {
                    logDebug('Performance: Saved color preference not in available options, using default', savedColor);
                    // Set default color to first option if saved color is not available
                    if (color() === 'TACK' && colorOptions.length > 0) {
                      if (colorOptions.includes('TACK')) {
                        setColor('TACK');
                      } else {
                        setColor(colorOptions[0]);
                      }
                    }
                  }
                } else {
                  // No saved preference, set default color to first option if not already set
                  if (color() === 'TACK' && colorOptions.length > 0) {
                    // Only change if still on default TACK
                    if (colorOptions.includes('TACK')) {
                      setColor('TACK');
                    } else {
                      setColor(colorOptions[0]);
                    }
                  }
                }
              }
            } catch (error) {
              logDebug('Performance: Error loading color preference from persistent settings:', error);
              // Keep default color
            }
          }
        } else {
          // No color options found, keep defaults
          logDebug('Performance: No color options found, using defaults');
        }
      } catch (error) {
        logError('Error loading color options:', error);
        // Keep defaults on error
      }
    })();
  });
  const [groups, setGroups] = createSignal<{ name: string; color: string }[]>([
    { name: 'PORT', color: "#d62728" },
    { name: 'STBD', color: "#2ca02c" }
  ]);

  const [showUwDw, setShowUwDw] = createSignal(true);
  const [loading, setLoading] = createSignal(true);
  const [updateCharts, setUpdateCharts] = createSignal(true);
  const [mouseID, setMouseID] = createSignal<string | null>(null);

  const [color, setColor] = createSignal<string>("TACK");
  const [UwDw, setUwDw] = createSignal<string>("UPWIND");
  /** True while charts are re-rendering after upwind/downwind (or plot type) switch; used to show overlay. */
  const [modeSwitching, setModeSwitching] = createSignal<boolean>(false);
  
  // Track when persistent settings (including color) are initialized
  // This prevents charts from rendering before color preference is loaded
  const [persistentSettingsInitialized, setPersistentSettingsInitialized] = createSignal(false);
  
  // Track if color was loaded from persistent settings (so we can recompute groups after data loads)
  const [colorLoadedFromPersistent, setColorLoadedFromPersistent] = createSignal(false);
  
  // Plot type state (Scatter or Box)
  const [plotType, setPlotType] = createSignal<string>("Scatter");
  
  // TWS bin state for box plot mode
  const [twsBin, setTwsBin] = createSignal<string>("ALL");
  const [twsBinOptions, setTwsBinOptions] = createSignal<string[]>(["ALL"]);

  // Timeline visibility state
  const [showTimeline, setShowTimeline] = createSignal<boolean>(true);

  // Handler for timeline changes
  const handleTimelineChange = (value: boolean) => {
    setShowTimeline(value);
  };

  // Training/Racing filter state
  const [selectedTrainingRacing, setSelectedTrainingRacing] = createSignal<'TRAINING' | 'RACING' | null>(null);

  // Handle point of sail changes
  const handleUwDwChange = (value: string) => {
    // Only update if value actually changed
    if (UwDw() === value) {
      logDebug('Performance: UwDw value unchanged, skipping update', value);
      return;
    }
    logDebug('Performance: UwDw changing from', UwDw(), 'to', value);
    setModeSwitching(true);
    setUwDw(value);
    // Clear selection when switching between upwind and downwind (preserve filters)
    clearSelection({ preserveFilters: true });
    setUpdateCharts(true);
  };
  
  // Handle plot type changes
  const handlePlotTypeChange = async (value: string) => {
    setPlotType(value);
    // Reset TWS bin to "ALL" when switching to Scatter mode
    if (value === "Scatter") {
      setTwsBin("ALL");
    }
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'Performance.tsx', 'Performance Report', `Plot type changed to ${value}`);
    setUpdateCharts(true);
  };
  
  // Handle TWS bin changes
  const handleTwsBinChange = async (value: string) => {
    setTwsBin(value);
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'Performance.tsx', 'Performance Report', `TWS bin changed to ${value}`);
    setUpdateCharts(true);
  };
  
  const [xAxis, setXAxis] = createSignal<string>(defaultChannelsStore.twsName());
  const [cloudType, setCloudType] = createSignal<string>("Latest");

  // Filter state - initialize from sessionStorage (grade/state set only from project or persistent in async block)
  const loadFiltersFromSession = (): void => {
    try {
      const savedFilters = sessionStorage.getItem('performanceFilters');
      if (savedFilters) {
        const filterData = JSON.parse(savedFilters);
        if (filterData.filterYear) setFilterYear(cleanQuotes(String(filterData.filterYear)));
        if (filterData.filterEvent) setFilterEvent(cleanQuotes(String(filterData.filterEvent)));
        if (filterData.filterConfig) setFilterConfig(cleanQuotes(String(filterData.filterConfig)));
        if (filterData.filterGrades != null && String(filterData.filterGrades).trim() !== '') setFilterGrades(cleanQuotes(String(filterData.filterGrades)));
        if (filterData.filterState != null) setFilterState(cleanQuotes(String(filterData.filterState)));
        logDebug('Performance: Loaded filters from sessionStorage', filterData);
      }
    } catch (error) {
      logDebug('Performance: Error loading filters from sessionStorage:', error);
    }
  };

  // Load grade and state filters from persistent settings (overrides sessionStorage)
  const loadGradeStateFiltersFromPersistentSettings = async (): Promise<void> => {
    const currentUser = user();
    if (currentUser?.user_id) {
      try {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();

        if (className && projectId) {
          const settings = await persistentSettingsService.loadSettings(
            currentUser.user_id,
            className,
            projectId
          );

          if (settings?.performanceFilters) {
            const filters = settings.performanceFilters;
            // Only load grade and state filters (persistent)
            if (filters.grades && typeof filters.grades === 'string') {
              setFilterGrades(cleanQuotes(filters.grades));
              logDebug('Performance: Loaded grade filter from persistent settings', cleanQuotes(filters.grades));
            }
            if (filters.state && typeof filters.state === 'string') {
              setFilterState(cleanQuotes(filters.state));
              logDebug('Performance: Loaded state filter from persistent settings', cleanQuotes(filters.state));
            }
            if (filters.trainingRacing === 'TRAINING' || filters.trainingRacing === 'RACING') {
              setSelectedTrainingRacing(filters.trainingRacing);
              logDebug('Performance: Loaded trainingRacing filter from persistent settings', filters.trainingRacing);
            }
          }
        }
      } catch (error) {
        logDebug('Performance: Error loading grade/state filters from persistent settings:', error);
      }
    }
  };

  // Save grade, state, and training/racing filters to persistent settings
  const saveGradeStateFiltersToPersistentSettings = async (): Promise<void> => {
    const currentUser = user();
    if (currentUser?.user_id) {
      try {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();

        if (className && projectId) {
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            {
              performanceFilters: {
                grades: filterGrades(),
                state: filterState(),
                trainingRacing: selectedTrainingRacing()
              }
            }
          );
          logDebug('Performance: Saved grade, state, and trainingRacing filters to persistent settings', {
            grades: filterGrades(),
            state: filterState(),
            trainingRacing: selectedTrainingRacing()
          });
        }
      } catch (error) {
        logDebug('Performance: Error saving grade/state/trainingRacing filters to persistent settings:', error);
      }
    }
  };

  const [filterGrades, setFilterGrades] = createSignal<string>('');
  const [filterYear, setFilterYear] = createSignal<string>('');
  const [filterEvent, setFilterEvent] = createSignal<string>('');
  const [filterConfig, setFilterConfig] = createSignal<string>('');
  const [filterState, setFilterState] = createSignal<string>('');

  // Build filters object from filter values
  type PerformanceFilters = {
    GRADE?: number[];
    YEAR?: number[];
    EVENT?: string[];
    CONFIG?: string[];
    STATE?: string[];
    RACE?: (number | string)[];
    LEG?: number[];
  };

  const buildFilters = (): PerformanceFilters | undefined => {
    const filters: PerformanceFilters = {};

    // Parse grades (comma-separated, convert to integers)
    if (filterGrades().trim()) {
      const grades = filterGrades().split(',').map(g => parseInt(g.trim())).filter(g => !isNaN(g) && (g >= 0 && g <= 3));
      if (grades.length > 0) {
        filters.GRADE = grades;
      }
    }

    // Parse year (comma-separated, convert to integers)
    if (filterYear().trim()) {
      const years = filterYear().split(',').map(y => parseInt(y.trim())).filter(y => !isNaN(y));
      if (years.length > 0) {
        filters.YEAR = years;
      }
    }

    // Parse event (comma-separated strings)
    if (filterEvent().trim()) {
      const events = filterEvent().split(',').map(e => e.trim()).filter(e => e.length > 0);
      if (events.length > 0) {
        filters.EVENT = events;
      }
    }

    // Parse config (comma-separated strings)
    if (filterConfig().trim()) {
      const configs = filterConfig().split(',').map(c => c.trim()).filter(c => c.length > 0);
      if (configs.length > 0) {
        filters.CONFIG = configs;
      }
    }

    // Parse state (comma-separated strings). Empty or "ALL" = no state filter (show all states).
    const stateRaw = filterState().trim();
    if (stateRaw && stateRaw.toUpperCase() !== 'ALL') {
      const states = filterState().split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
      if (states.length > 0) {
        filters.STATE = states;
      }
    }

    // Parse race numbers from selectedRaces (client-side filter)
    const races = selectedRacesAggregates();
    if (races && races.length > 0) {
      filters.RACE = races.map(r => {
        // Handle 'TRAINING' string or -1
        if (typeof r === 'number' && r === -1) {
          return 'TRAINING';
        }
        const rStr = String(r).toUpperCase();
        if (rStr === 'TRAINING' || rStr === '-1') {
          return 'TRAINING';
        }
        return typeof r === 'number' ? r : parseInt(String(r));
      }).filter(r => !isNaN(r as number) || r === 'TRAINING');
    }

    // Parse leg numbers from selectedLegs (client-side filter)
    const legs = selectedLegsAggregates();
    if (legs && legs.length > 0) {
      filters.LEG = legs.map(l => typeof l === 'number' ? l : parseInt(String(l))).filter(l => !isNaN(l));
    }

    return Object.keys(filters).length > 0 ? filters : undefined;
  };

  const [selectedChart, setSelectedChart] = createSignal<any[]>([]);
  const [zoom, setZoom] = createSignal(false);


  // Local loading and error states
  const [isLoading, setIsLoading] = createSignal(false);
  const [requestError, setRequestError] = createSignal<string | null>(null);

  // Data filtering is now handled automatically by the unified data store
  // based on global selection state - no manual cut data management needed

  const initializeCharts = async (preserveTargetName?: string) => {
    setLoading(true);
    setIsLoading(true);
    setRequestError(null);

    // Clear any old data to prevent showing stale data from previous dataset/source
    setAggregates([]);
    setCloud([]);
    // Only clear targets if we're not preserving a specific target
    if (!preserveTargetName) {
      setTargets({ name: '', data: {} });
    }

    try {
      setUpdateCharts(false);

      // Get chart objects first to determine required channels
      const chartObjects = await performanceDataService.fetchCharts();
      setCharts(chartObjects);

      const channelMapping = performanceDataService.getChannelMapping(chartObjects);
      
      // Get aggregate type mapping to group channels by aggregate type
      const groupedChannels = performanceDataService.getAggregateTypeMapping(chartObjects);
      
      // Check if ANY series have AVG aggregate type (fetch cloud data if any are AVG)
      // Cloud data will be conditionally passed to each chart based on its aggregate type
      const hasAvgSeries = chartObjects.some(co => 
        co.charts?.[0]?.series?.some((s: any) => {
          const aggType = (s.yType || 'AVG').toUpperCase();
          return aggType === 'AVG';
        })
      );

      // Fetch all performance data using the performance data service
      // Map cloudType to the format expected by fetchCloud
      let cloudTypeForFetch = cloudType();
      if (cloudTypeForFetch === '1Hz Scatter') {
        cloudTypeForFetch = 'Latest';
      }

      const filters = buildFilters();

      // Fetch aggregates separately by type (AVG, STD, AAV)
      // First, collect channels needed for each aggregate type
      const channelsByType: { [key: string]: string[] } = { AVG: [], STD: [], AAV: [] };
      groupedChannels.forEach(group => {
        const type = group.aggregateType.toUpperCase();
        if (channelsByType[type]) {
          channelsByType[type].push(...group.channels);
        }
      });
      
      // Remove duplicates from each type's channel list
      Object.keys(channelsByType).forEach(type => {
        channelsByType[type] = [...new Set(channelsByType[type])];
      });

      // ============================================================================
      // CLOUD DATA FETCH - TEMPORARILY DISABLED (MAIN DATA LOAD)
      // ============================================================================
      // TO RESTORE CLOUD DATA FETCHING:
      // 1. Replace Promise.resolve([]) with the commented fetchCloud call below
      // 2. Also restore cloud fetching in the cloudType change effect (~line 645)
      // 3. Also restore cloud fetching in the filter change effect (~line 729)
      // 4. Ensure cloud rendering is enabled in AdvancedScatter.tsx
      // 5. Ensure cloud buttons are visible in PerfSettings.tsx
      //
      // NOTES:
      // - Cloud data is 1Hz point data (many points per event_id)
      // - Only fetched when cloudType !== 'None' AND hasAvgSeries is true
      // - Uses performanceDataService.fetchCloud() with channels, cloudType, and filters
      // - Cloud data is processed and passed to AdvancedScatter via props.cloud
      // ============================================================================
      // Fetch cloud data if cloudType is not 'None' and we have at least one AVG series
      // If preserveTargetName is provided, fetch that specific target; otherwise fetch latest
      const [aggregatesAVGData, aggregatesSTDData, aggregatesAAVData, maybeCloudData, targetsData] = await Promise.all([
        channelsByType.AVG.length > 0 ? performanceDataService.fetchAggregates(channelsByType.AVG, 'AVG', filters) : Promise.resolve([]),
        channelsByType.STD.length > 0 ? performanceDataService.fetchAggregates(channelsByType.STD, 'STD', filters) : Promise.resolve([]),
        channelsByType.AAV.length > 0 ? performanceDataService.fetchAggregates(channelsByType.AAV, 'AAV', filters) : Promise.resolve([]),
        // RESTORE THIS:
        // (cloudTypeForFetch === 'None' || !hasAvgSeries) 
        //   ? Promise.resolve([]) 
        //   : performanceDataService.fetchCloud(
        //       performanceDataService.getRequiredChannels(chartObjects), 
        //       cloudTypeForFetch, 
        //       filters
        //     ),
        Promise.resolve([]), // TEMPORARILY: Always return empty array for cloud data
        preserveTargetName ? fetchTargetData(preserveTargetName) : performanceDataService.fetchTargets()
      ]);

      // Process each aggregate type separately with channel mapping
      const processedAVG = aggregatesAVGData.length > 0 
        ? performanceDataService.processPerformanceData(aggregatesAVGData, maybeCloudData, { name: '', data: {} }, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      const processedSTD = aggregatesSTDData.length > 0
        ? performanceDataService.processPerformanceData(aggregatesSTDData, [], { name: '', data: {} }, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      const processedAAV = aggregatesAAVData.length > 0
        ? performanceDataService.processPerformanceData(aggregatesAAVData, [], { name: '', data: {} }, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };

      // Set separate aggregate data
      setAggregatesAVG(processedAVG.aggregates);
      setAggregatesSTD(processedSTD.aggregates);
      setAggregatesAAV(processedAAV.aggregates);
      
      // Also set aggregates to AVG for backward compatibility
      setAggregates(processedAVG.aggregates);
      setCloud(processedAVG.cloud);
      
      // Debug: Log cloud vs aggregate data counts to verify cloud is 1Hz data
      logDebug('[Performance] Data counts after processing:', {
        aggregatesAVG: processedAVG.aggregates.length,
        aggregatesSTD: processedSTD.aggregates.length,
        aggregatesAAV: processedAAV.aggregates.length,
        cloud: processedAVG.cloud.length,
        cloudToAggregateRatio: processedAVG.aggregates.length > 0 ? (processedAVG.cloud.length / processedAVG.aggregates.length).toFixed(2) : 'N/A',
        sampleCloudPoint: processedAVG.cloud.length > 0 ? {
          event_id: processedAVG.cloud[0].event_id,
          Datetime: processedAVG.cloud[0].Datetime,
          hasTwa: processedAVG.cloud[0].Twa !== undefined,
          hasTws: processedAVG.cloud[0].Tws !== undefined
        } : null,
        sampleAggregatePoint: processedAVG.aggregates.length > 0 ? {
          event_id: processedAVG.aggregates[0].event_id,
          Datetime: processedAVG.aggregates[0].Datetime,
          hasTwa: processedAVG.aggregates[0].Twa !== undefined,
          hasTws: processedAVG.aggregates[0].Tws !== undefined
        } : null
      });
      // Only set targets if we're not preserving a specific target (it's already set)
      if (!preserveTargetName) {
        setTargets(targetsData);
      }
      
      // Extract TWS bins from aggregatesAVG data for box plot mode (intervals of 5)
      if (processedAVG.aggregates && processedAVG.aggregates.length > 0) {
        const twsField = defaultChannelsStore.twsName();
        const uniqueTwsBins = new Set<number>();
        processedAVG.aggregates.forEach((point: any) => {
          const twsValue = point[twsField];
          if (twsValue !== undefined && twsValue !== null && !isNaN(Number(twsValue))) {
            // Round to nearest 5 knots for binning (e.g., 5, 10, 15, 20, 25)
            const roundedBin = Math.round(Number(twsValue) / 5) * 5;
            uniqueTwsBins.add(roundedBin);
          }
        });
        const sortedBins = Array.from(uniqueTwsBins).sort((a, b) => a - b);
        const twsBinsList = ['ALL', ...sortedBins.map(String)];
        setTwsBinOptions(twsBinsList);
      } else {
        setTwsBinOptions(['ALL']);
      }
      
      // Set targets from processedAVG (targets are always AVG)
      if (!preserveTargetName) {
        setTargets(processedAVG.targets);
      }

      // Check if charts have filters to determine if Upwind/Downwind should be shown
      let result = true;
      chartObjects.forEach(chartObject => {
        if (chartObject.charts[0].filters.length > 0) {
          result = false;
        }
      });
      setShowUwDw(result);

      // Initialize groups based on current color selection and loaded data
      // Force recompute if color was loaded from persistent settings (to ensure groups are computed)
      handleColorChange(color(), colorLoadedFromPersistent());
      // Reset the flag after using it
      if (colorLoadedFromPersistent()) {
        setColorLoadedFromPersistent(false);
      }

      setUpdateCharts(true);
    } catch (err: unknown) {
      logError('Error initializing performance charts:', err as any);
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };

  // Watch for dataset-id changes and set filterStore dates accordingly
  // This handles the case where the component is reused when navigating between pages
  let lastDatasetId: number | null = null;
  let isFirstDatasetIdCheck = true;
  let datasetEffectCount = 0;
  createEffect(async () => {
    datasetEffectCount++;

    // Detect infinite loops
    if (datasetEffectCount > 10) {
      logError('🚨 INFINITE LOOP DETECTED in Performance dataset-id effect!', datasetEffectCount);
      datasetEffectCount = 0;
      return;
    }

    const currentDatasetId: number = typeof selectedDatasetId === 'function' ? Number(selectedDatasetId()) : 0;

    // If we have a dataset-id, fetch the dataset date and set it in filterStore
    if (currentDatasetId > 0) {
      try {
        const response = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(currentDatasetId)}`
        );

        if (response.success && response.data?.date) {
          let dateStr = response.data.date;
          // If date is in YYYYMMDD format, convert to YYYY-MM-DD
          if (dateStr.length === 8 && !dateStr.includes('-')) {
            dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
          }

          logDebug(`[Performance] Setting filterStore dates to dataset date: ${dateStr}`);
          setStartDate(dateStr);
          setEndDate(dateStr);
        }
      } catch (err) {
        logError('[Performance] Error fetching dataset date:', err);
      }
    }

    // On first check, just record the initial dataset-id (onMount will handle initialization)
    if (isFirstDatasetIdCheck) {
      isFirstDatasetIdCheck = false;
      lastDatasetId = currentDatasetId;
      logDebug(`[Performance] Initial dataset-id: ${currentDatasetId}`);
      datasetEffectCount = 0;
      return;
    }

    // If dataset-id changed, immediately clear old data and re-initialize to fetch correct data
    if (lastDatasetId !== null && lastDatasetId !== currentDatasetId) {
      logDebug(`[Performance] Dataset-id changed from ${lastDatasetId} to ${currentDatasetId}, clearing old data and re-initializing...`);
      // Clear data immediately to prevent showing stale data
      setAggregates([]);
      setCloud([]);
      setTargets({ name: '', data: {} });
      setUpdateCharts(false);
      // Re-initialize to fetch correct data for new dataset-id
      initializeCharts();
      datasetEffectCount = 0; // Reset after initialization
    } else {
      datasetEffectCount = 0; // Reset if no change
    }

    lastDatasetId = currentDatasetId;
  });

  // Re-fetch cloud data when cloudType changes (but not on initial mount)
  let isInitialMount = true;
  let cloudEffectCount = 0;
  let lastCloudType = '';
  createEffect(async () => {
    cloudEffectCount++;

    // Detect infinite loops
    if (cloudEffectCount > 10) {
      logError('🚨 INFINITE LOOP DETECTED in Performance cloudType effect!', cloudEffectCount);
      cloudEffectCount = 0;
      return;
    }

    const currentCloudType = cloudType();
    const currentCharts = charts();

    // Skip if cloudType hasn't actually changed
    if (currentCloudType === lastCloudType && !isInitialMount) {
      cloudEffectCount = 0;
      return;
    }
    lastCloudType = currentCloudType;

    // Skip on initial mount (initialization handles first load)
    if (isInitialMount) {
      isInitialMount = false;
      cloudEffectCount = 0;
      return;
    }

    // Only re-fetch if we have charts loaded and cloudType is set
    if (currentCharts.length > 0 && currentCloudType && !loading()) {
      const channelMapping = performanceDataService.getChannelMapping(currentCharts);

      // Check if ANY series have AVG aggregate type (fetch cloud data if any are AVG)
      const hasAvgSeries = currentCharts.some(co => 
        co.charts?.[0]?.series?.some((s: any) => {
          const aggType = (s.yType || 'AVG').toUpperCase();
          return aggType === 'AVG';
        })
      );

      // Map cloudType to the format expected by fetchCloud
      let cloudTypeForFetch = currentCloudType;
      if (cloudTypeForFetch === '1Hz Scatter') {
        cloudTypeForFetch = 'Latest';
      }

      try {
        setIsLoading(true);
        // Clear old cloud data immediately to prevent showing stale data
        setCloud([]);
        const filters = buildFilters();
        // ============================================================================
        // CLOUD DATA FETCH - TEMPORARILY DISABLED (CLOUD TYPE CHANGE EFFECT)
        // ============================================================================
        // TO RESTORE: Uncomment the fetchCloud call below and remove the empty array
        // This effect runs when cloudType changes (e.g., user selects different cloud option)
        // ============================================================================
        // RESTORE THIS:
        // const cloudData = (cloudTypeForFetch === 'None' || !hasAvgSeries) 
        //   ? [] 
        //   : await performanceDataService.fetchCloud(
        //       performanceDataService.getRequiredChannels(currentCharts), 
        //       cloudTypeForFetch, 
        //       filters
        //     );
        const cloudData: any[] = []; // TEMPORARILY: Always use empty array
        const processedData = performanceDataService.processPerformanceData(
          aggregates(),
          cloudData,
          targets(),
          channelMapping
        );
        setCloud(processedData.cloud);
        setUpdateCharts(true);
        cloudEffectCount = 0; // Reset on success
      } catch (err) {
        logError('Error fetching cloud data when cloudType changed:', err);
        cloudEffectCount = 0; // Reset on error
      } finally {
        setIsLoading(false);
      }
    } else {
      cloudEffectCount = 0; // Reset if conditions not met
    }
  });

  // Watch for filter changes and refetch cloud data when API-level filters change
  // Note: STATE, RACE, and LEG filters are client-side only, so they don't trigger cloud refetch
  // Only API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE) trigger refetch
  let filterEffectCount = 0;
  let lastFilters: string = '';
  createEffect(async () => {
    filterEffectCount++;

    // Detect infinite loops
    if (filterEffectCount > 10) {
      logError('🚨 INFINITE LOOP DETECTED in Performance filter effect!', filterEffectCount);
      filterEffectCount = 0;
      return;
    }

    // Track filter changes by serializing current API-level filter values only
    // Exclude STATE, RACE, LEG filters since they're client-side and don't require cloud refetch
    // GRADE is included here but will be split by the service (client-side by default, API-side for HistoricalPerformance)
    const currentFilters = JSON.stringify({
      grades: filterGrades(), // May be API or client-side depending on page type
      year: filterYear(), // API filter
      event: filterEvent(), // API filter
      config: filterConfig() // API filter
      // Note: filterState(), selectedRacesAggregates(), and selectedLegsAggregates() are intentionally excluded
      // as they are client-side filters and don't require cloud data refetch
    });

    // Skip if filters haven't actually changed
    if (currentFilters === lastFilters) {
      filterEffectCount = 0;
      return;
    }
    lastFilters = currentFilters;

    // Only refetch cloud data if we have charts loaded, cloudType is set, and not loading
    const currentCharts = charts();
    const currentCloudType = cloudType();
    if (currentCharts.length > 0 && currentCloudType && currentCloudType !== 'None' && !loading()) {
      const channelMapping = performanceDataService.getChannelMapping(currentCharts);

      // Check if ANY series have AVG aggregate type (fetch cloud data if any are AVG)
      const hasAvgSeries = currentCharts.some(co => 
        co.charts?.[0]?.series?.some((s: any) => {
          const aggType = (s.yType || 'AVG').toUpperCase();
          return aggType === 'AVG';
        })
      );

      // Map cloudType to the format expected by fetchCloud
      let cloudTypeForFetch = currentCloudType;
      if (cloudTypeForFetch === '1Hz Scatter') {
        cloudTypeForFetch = 'Latest';
      }

      try {
        setIsLoading(true);
        const filters = buildFilters();
        // ============================================================================
        // CLOUD DATA FETCH - TEMPORARILY DISABLED (FILTER CHANGE EFFECT)
        // ============================================================================
        // TO RESTORE: Uncomment the fetchCloud call below and remove the empty array
        // This effect runs when API-level filters change (YEAR, EVENT, CONFIG, SOURCE_NAME)
        // Note: Client-side filters (STATE, RACE, LEG) don't trigger cloud refetch
        // ============================================================================
        // RESTORE THIS:
        // const cloudData = !hasAvgSeries 
        //   ? [] 
        //   : await performanceDataService.fetchCloud(
        //       performanceDataService.getRequiredChannels(currentCharts), 
        //       cloudTypeForFetch, 
        //       filters
        //     );
        const cloudData: any[] = []; // TEMPORARILY: Always use empty array
        const processedData = performanceDataService.processPerformanceData(
          aggregates(),
          cloudData,
          targets(),
          channelMapping
        );
        setCloud(processedData.cloud);
        setUpdateCharts(true);
        filterEffectCount = 0; // Reset on success
      } catch (err) {
        logError('Error refetching cloud data when filters changed:', err);
        filterEffectCount = 0; // Reset on error
      } finally {
        setIsLoading(false);
      }
    } else {
      filterEffectCount = 0; // Reset if conditions not met
    }
  });

  // Populate TWS bins from existing aggregates when switching to Box mode
  createEffect(() => {
    const currentPlotType = plotType();
    const currentAggregates = aggregates();
    
    // Only populate TWS bins for Box mode
    if (currentPlotType === "Box" && currentAggregates.length > 0) {
      const twsField = defaultChannelsStore.twsName();
      const uniqueTwsBins = new Set<number>();
      currentAggregates.forEach((point: any) => {
        const twsValue = point[twsField];
        if (twsValue !== undefined && twsValue !== null && !isNaN(Number(twsValue))) {
          // Round to nearest 5 knots for binning (e.g., 5, 10, 15, 20, 25)
          const roundedBin = Math.round(Number(twsValue) / 5) * 5;
          uniqueTwsBins.add(roundedBin);
        }
      });
      const sortedBins = Array.from(uniqueTwsBins).sort((a, b) => a - b);
      const twsBinsList = ['ALL', ...sortedBins.map(String)];
      setTwsBinOptions(twsBinsList);
    }
  });

  const handleZoom = (info: any[]) => {
    if (info.length > 0) {
      setSelectedChart(info);
      setZoom(true);
    } else {
      setSelectedChart([]);
      setZoom(false);
    }
  };

  const handleAxisChange = async (axis: string) => {
    // axis is already the correct channel name from defaultChannelsStore (via PerfSettings)
    setXAxis(axis);
    setZoom(false);
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'Performance.tsx', 'Performance Report', `Axis changed to ${axis}`);
    // Force chart redraw by toggling updateCharts signal
    // This ensures charts react to x-axis changes even if updateCharts was already true
    setUpdateCharts(false);
    // Use setTimeout to ensure the false state is processed before setting to true
    setTimeout(() => setUpdateCharts(true), 0);
  }

  // Create chart layout based on current x-axis selection
  const chartGroups = () => {
    const chartsData = charts() as any[];
    if (!chartsData || chartsData.length === 0) return [];

    const { twsName, bspName } = defaultChannelsStore;
    const currentXAxis = xAxis();
    const twsField = twsName();
    const bspField = bspName();

    // Simply ensure dataField is set for all series (use name if dataField doesn't exist)
    // Extract xType and yType for each series
    return chartsData.map((group: any) => {
      const series = group.charts[0].series.map((s: any) => {
        let yaxisDataField = s.yaxis?.dataField || s.yaxis?.name || '';
        const yaxisName = s.yaxis?.name || '';
        
        // Determine x-axis: use series xaxis if not PAGE DEFAULT, otherwise use global xAxis
        const seriesXAxis = s.xaxis?.name;
        const effectiveXAxis = (seriesXAxis && seriesXAxis !== "PAGE DEFAULT" && seriesXAxis !== "DEFAULT") ? seriesXAxis : currentXAxis;
        
        // Get aggregate types (xType and yType), default to AVG for backward compatibility
        const xType = (s.xType || 'AVG').toUpperCase();
        const yType = (s.yType || 'AVG').toUpperCase();
        
        // If Bsp is the y-axis and x-axis changes to Bsp, put TWS on the y-axis
        const isYAxisBsp = yaxisDataField.toLowerCase() === bspField.toLowerCase() || 
                          yaxisName.toLowerCase() === bspField.toLowerCase();
        const isXAxisBsp = effectiveXAxis.toLowerCase() === bspField.toLowerCase();
        
        if (isYAxisBsp && isXAxisBsp) {
          yaxisDataField = twsField;
        }
        
        return {
          ...s,
          xaxisValue: effectiveXAxis, // Store the effective x-axis value for this series
          xType: xType, // Store xType for data selection
          yType: yType, // Store yType for data selection
          yaxis: {
            ...s.yaxis,
            dataField: yaxisDataField
          },
          yaxisTarget: s.yaxisTarget ? {
            ...s.yaxisTarget,
            dataField: s.yaxisTarget?.dataField || s.yaxisTarget?.name || ''
          } : s.yaxisTarget
        };
      });
      
      return {
        ...group,
        charts: [{
          ...group.charts[0],
          series
        }]
      };
    });
  };

  const handleColorChange = (value: string, force: boolean = false) => {
    if (!force && value === color()) return;

    // Compute new groups synchronously so chart has correct groups when it re-renders with new color (avoids white/lightgrey flash)
    const dataForGrouping = aggregates();
    const getFieldName = (colorField: string): string => {
      const fieldMap: Record<string, string> = {
        'TACK': 'tack', 'GRADE': 'grade', 'RACE': 'race_number', 'LEG': 'leg_number',
        'CONFIG': 'config', 'YEAR': 'year', 'EVENT': 'event', 'SOURCE_NAME': 'source_name', 'STATE': 'state'
      };
      return fieldMap[colorField] || colorField;
    };
    // Build unique values using same resolution as chart (resolveDataField) so group names match getColor lookup exactly
    // For STATE, use same fallback chain as AdvancedScatter so dataset page works like PerformanceHistory
    const getPointValue = (d: any): any => {
      let v: any;
      if (value === 'STATE') {
        v = d.state ?? d.State ?? d.STATE ?? resolveDataField(d, 'STATE');
      } else {
        v = resolveDataField(d, value);
      }
      if (value === 'RACE' && (v === -1 || v === '-1')) return 'TRAINING';
      return v;
    };
    let unique_vals: any[] =
      value === 'TACK'
        ? groupBy(dataForGrouping, getFieldName(value))
        : [...new Set(dataForGrouping.map(getPointValue))].filter((v) => v !== undefined && v !== null);

    if (value === 'STATE') {
      logDebug('Performance: handleColorChange - State field:', {
        colorField: value,
        dataField: getFieldName(value),
        dataLength: dataForGrouping.length,
        uniqueVals: unique_vals,
        uniqueValsLength: unique_vals.length,
        sampleStates: dataForGrouping.slice(0, 5).map(d => d.state)
      });
    }

    let newGroups: { name: string; color: string }[];
    if (value == 'TACK') {
      newGroups = [{ name: 'PORT', color: "#d62728" }, { name: 'STBD', color: "#2ca02c" }];
    } else if (value == 'GRADE') {
      newGroups = unique_vals.map((val: any) => {
        const gradeNum = typeof val === 'number' ? val : parseInt(val, 10);
        if (isNaN(gradeNum) || gradeNum === 0 || val == 'NONE' || val === null || val === undefined) {
          return { name: val === null || val === undefined ? 'null' : val, color: 'lightgrey' };
        }
        if (gradeNum === 1) return { name: val, color: 'red' };
        if (gradeNum === 2) return { name: val, color: 'green' };
        if (gradeNum === 3) return { name: val, color: 'yellow' };
        return { name: val, color: getColorByIndex(gradeNum - 1) };
      });
    } else {
      const numericFields = ['LEG', 'RACE'];
      const isNumericField = numericFields.includes(value);
      if (value === 'RACE') {
        unique_vals = unique_vals.sort((a: any, b: any) => {
          const aIsTraining = a === 'TRAINING' || a === -1 || a === '-1';
          const bIsTraining = b === 'TRAINING' || b === -1 || b === '-1';
          if (aIsTraining && !bIsTraining) return -1;
          if (!aIsTraining && bIsTraining) return 1;
          const aNum = aIsTraining ? -1 : (typeof a === 'number' ? a : Number(a));
          const bNum = bIsTraining ? -1 : (typeof b === 'number' ? b : Number(b));
          return aNum - bNum;
        });
      }
      newGroups = unique_vals.map((val: any, index: number) => {
        if (value === 'RACE' && (val === 'TRAINING' || val === -1 || val === '-1')) {
          return { name: 'TRAINING', color: 'lightgrey' };
        }
        if (val == 'NONE' || val == null || val === '') {
          return { name: val === null || val === undefined ? 'null' : val, color: 'lightgrey' };
        }
        if (!isNumericField && val == 0) return { name: val, color: 'lightgrey' };
        return { name: val, color: getColorByIndex(index) };
      });
    }

    batch(() => {
      setGroups(newGroups);
      setColor(value);
    });

    requestAnimationFrame(() => {
      setUpdateCharts(true);
      saveColorPreference(value);
    });
  }
  
  // Save color preference to persistent settings (debounced)
  let colorSaveTimeout: NodeJS.Timeout | null = null;
  const saveColorPreference = async (colorValue: string) => {
    // Clear existing timeout
    if (colorSaveTimeout) {
      clearTimeout(colorSaveTimeout);
    }
    
    // Debounce saves by 500ms
    colorSaveTimeout = setTimeout(async () => {
      const currentUser = user();
      if (currentUser?.user_id) {
        try {
          const { selectedClassName, selectedProjectId } = persistantStore;
          const className = selectedClassName();
          const projectId = selectedProjectId();
          
          if (className && projectId) {
            await persistentSettingsService.saveSettings(
              currentUser.user_id,
              className,
              projectId,
              { performanceColor: colorValue }
            );
            logDebug('Performance: Saved color preference to persistent settings', colorValue);
          }
        } catch (error) {
          logDebug('Performance: Error saving color preference to persistent settings:', error);
        }
      }
      colorSaveTimeout = null;
    }, 500);
  };

  // Helper to get filtered data (memoized for efficiency to prevent repeated filtering with many charts)
  // Helper function to filter aggregates by type
  // Reactive memos for filtered aggregates by type - these automatically update when cutEvents changes
  const getFilteredAggregatesAVG = createMemo(() => {
    const data = aggregatesAVG();
    if (!Array.isArray(data)) {
      return [];
    }
    
    // Access filterTrigger to ensure recalculation when filters are applied
    filterTrigger();
    let filteredData = [...data];

    // Apply selection filtering if there are cut events - ACCESS cutEvents() to ensure reactivity
    const currentCuts = cutEvents();
    if (currentCuts.length > 0) {
      const cutEventIds = new Set<number>(
        currentCuts
          .map((event: any) => {
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) return event.event_id;
            return null;
          })
          .filter((id: any): id is number => id !== null && id !== undefined)
      );
      filteredData = filteredData.filter((d: PerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }

    // Apply client-side filters (use filterStore like FleetPerformance / FleetPerformanceHistory)
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n) && (n >= 0 && n <= 3)));
    }
    const states: string[] = [];
    const stateValues = selectedStatesAggregates();
    if (Array.isArray(stateValues) && stateValues.length > 0) {
      states.push(...stateValues.map((s: string) => String(s)));
    }
    
    if (races.length > 0 || legs.length > 0 || grades.length > 0 || states.length > 0) {
      const filterConfig = createFilterConfig([], races, legs, grades);
      const fullFilterConfig = {
        ...filterConfig,
        twaStates: [],
        states: states,
      };
      filteredData = filteredData.filter((point: any) => passesBasicFilters(point, fullFilterConfig));
    }

    // Apply Training/Racing filter
    const trainingRacing = selectedTrainingRacing();
    if (trainingRacing === 'RACING') {
      filteredData = filteredData.filter((point: any) => {
        const raceValue = point.race_number ?? point.Race_number ?? point.race ?? point.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return !isTraining;
      });
    } else if (trainingRacing === 'TRAINING') {
      filteredData = filteredData.filter((point: any) => {
        const raceValue = point.race_number ?? point.Race_number ?? point.race ?? point.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return isTraining;
      });
    }

    // Apply TWS bin filtering
    const currentTwsBin = twsBin();
    if (currentTwsBin && currentTwsBin !== 'ALL') {
      const twsField = defaultChannelsStore.twsName();
      const targetBin = Number(currentTwsBin);
      if (!isNaN(targetBin)) {
        filteredData = filteredData.filter((d: any) => {
          const twsValue = d[twsField];
          if (twsValue !== undefined && twsValue !== null && !isNaN(Number(twsValue))) {
            const roundedTws = Math.round(Number(twsValue) / 5) * 5;
            return roundedTws === targetBin;
          }
          return false;
        });
      }
    }

    // Apply point of sail filtering
    // Use Twa_deg_avg (metadata from AVG) for consistent upwind/downwind filtering across all aggregate types
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        filteredData = filteredData.filter((d: PerformanceAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField];
          return twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue)) && Math.abs(Number(twaValue)) < 90;
        });
      } else {
        filteredData = filteredData.filter((d: PerformanceAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField];
          return twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue)) && Math.abs(Number(twaValue)) >= 90;
        });
      }
    }

    return filteredData;
  });

  const getFilteredAggregatesSTD = createMemo(() => {
    const data = aggregatesSTD();
    if (!Array.isArray(data)) {
      return [];
    }
    
    // Access filterTrigger to ensure recalculation when filters are applied
    filterTrigger();
    let filteredData = [...data];

    // Apply selection filtering if there are cut events - ACCESS cutEvents() to ensure reactivity
    const currentCuts = cutEvents();
    if (currentCuts.length > 0) {
      const cutEventIds = new Set<number>(
        currentCuts
          .map((event: any) => {
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) return event.event_id;
            return null;
          })
          .filter((id: any): id is number => id !== null && id !== undefined)
      );
      filteredData = filteredData.filter((d: PerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }

    // Apply client-side filters (use filterStore like FleetPerformance / FleetPerformanceHistory)
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n) && (n >= 0 && n <= 3)));
    }
    const states: string[] = [];
    const stateValues = selectedStatesAggregates();
    if (Array.isArray(stateValues) && stateValues.length > 0) {
      states.push(...stateValues.map((s: string) => String(s)));
    }
    
    if (races.length > 0 || legs.length > 0 || grades.length > 0 || states.length > 0) {
      const filterConfig = createFilterConfig([], races, legs, grades);
      const fullFilterConfig = {
        ...filterConfig,
        twaStates: [],
        states: states,
      };
      filteredData = filteredData.filter((point: any) => passesBasicFilters(point, fullFilterConfig));
    }

    // Apply Training/Racing filter
    const trainingRacing = selectedTrainingRacing();
    if (trainingRacing === 'RACING') {
      filteredData = filteredData.filter((point: any) => {
        const raceValue = point.race_number ?? point.Race_number ?? point.race ?? point.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return !isTraining;
      });
    } else if (trainingRacing === 'TRAINING') {
      filteredData = filteredData.filter((point: any) => {
        const raceValue = point.race_number ?? point.Race_number ?? point.race ?? point.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return isTraining;
      });
    }

    // Apply TWS bin filtering
    const currentTwsBin = twsBin();
    if (currentTwsBin && currentTwsBin !== 'ALL') {
      const twsField = defaultChannelsStore.twsName();
      const targetBin = Number(currentTwsBin);
      if (!isNaN(targetBin)) {
        filteredData = filteredData.filter((d: any) => {
          const twsValue = d[twsField];
          if (twsValue !== undefined && twsValue !== null && !isNaN(Number(twsValue))) {
            const roundedTws = Math.round(Number(twsValue) / 5) * 5;
            return roundedTws === targetBin;
          }
          return false;
        });
      }
    }

    // Apply point of sail filtering
    // Use Twa_deg_avg (metadata from AVG) for consistent upwind/downwind filtering across all aggregate types
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        filteredData = filteredData.filter((d: PerformanceAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField];
          return twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue)) && Math.abs(Number(twaValue)) < 90;
        });
      } else {
        filteredData = filteredData.filter((d: PerformanceAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField];
          return twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue)) && Math.abs(Number(twaValue)) >= 90;
        });
      }
    }

    return filteredData;
  });

  const getFilteredAggregatesAAV = createMemo(() => {
    const data = aggregatesAAV();
    if (!Array.isArray(data)) {
      return [];
    }
    
    // Access filterTrigger to ensure recalculation when filters are applied
    filterTrigger();
    let filteredData = [...data];

    // Apply selection filtering if there are cut events - ACCESS cutEvents() to ensure reactivity
    const currentCuts = cutEvents();
    if (currentCuts.length > 0) {
      const cutEventIds = new Set<number>(
        currentCuts
          .map((event: any) => {
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) return event.event_id;
            return null;
          })
          .filter((id: any): id is number => id !== null && id !== undefined)
      );
      filteredData = filteredData.filter((d: PerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }

    // Apply client-side filters (use filterStore like FleetPerformance / FleetPerformanceHistory)
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n) && (n >= 0 && n <= 3)));
    }
    const states: string[] = [];
    const stateValues = selectedStatesAggregates();
    if (Array.isArray(stateValues) && stateValues.length > 0) {
      states.push(...stateValues.map((s: string) => String(s)));
    }
    
    if (races.length > 0 || legs.length > 0 || grades.length > 0 || states.length > 0) {
      const filterConfig = createFilterConfig([], races, legs, grades);
      const fullFilterConfig = {
        ...filterConfig,
        twaStates: [],
        states: states,
      };
      filteredData = filteredData.filter((point: any) => passesBasicFilters(point, fullFilterConfig));
    }

    // Apply Training/Racing filter
    const trainingRacing = selectedTrainingRacing();
    if (trainingRacing === 'RACING') {
      filteredData = filteredData.filter((point: any) => {
        const raceValue = point.race_number ?? point.Race_number ?? point.race ?? point.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return !isTraining;
      });
    } else if (trainingRacing === 'TRAINING') {
      filteredData = filteredData.filter((point: any) => {
        const raceValue = point.race_number ?? point.Race_number ?? point.race ?? point.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return isTraining;
      });
    }

    // Apply TWS bin filtering
    const currentTwsBin = twsBin();
    if (currentTwsBin && currentTwsBin !== 'ALL') {
      const twsField = defaultChannelsStore.twsName();
      const targetBin = Number(currentTwsBin);
      if (!isNaN(targetBin)) {
        filteredData = filteredData.filter((d: any) => {
          const twsValue = d[twsField];
          if (twsValue !== undefined && twsValue !== null && !isNaN(Number(twsValue))) {
            const roundedTws = Math.round(Number(twsValue) / 5) * 5;
            return roundedTws === targetBin;
          }
          return false;
        });
      }
    }

    // Apply point of sail filtering
    // Use Twa_deg_avg (metadata from AVG) for consistent upwind/downwind filtering across all aggregate types
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        filteredData = filteredData.filter((d: PerformanceAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField];
          return twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue)) && Math.abs(Number(twaValue)) < 90;
        });
      } else {
        filteredData = filteredData.filter((d: PerformanceAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField];
          return twaValue !== undefined && twaValue !== null && !isNaN(Number(twaValue)) && Math.abs(Number(twaValue)) >= 90;
        });
      }
    }

    return filteredData;
  });

  const getFilteredAggregates = createMemo(() => {
    // Access filterTrigger to ensure memo recalculates when filters are applied
    filterTrigger(); // Track dependency
    // Track selectedEvents to ensure memo recalculates when timeseries scatter is brushed
    const currentSelectedEvents = selectedEvents(); // Track selection changes from brushing
    let data = aggregates();

    // Ensure data is always an array
    if (!Array.isArray(data)) {
      logWarn('[Performance] aggregates() is not an array, defaulting to empty array');
      return [];
    }

    // Apply selection filtering - prioritize selectedEvents (active selection from brushing) over cutEvents
    const currentCuts = cutEvents();
    
    if (currentSelectedEvents && currentSelectedEvents.length > 0) {
      // Active selection from brushing takes priority - filter by selectedEvents
      const selectedEventIds = new Set<number>(
        currentSelectedEvents.filter((id): id is number => typeof id === 'number' && !isNaN(id))
      );
      data = data.filter((d: PerformanceAggregatePoint) => d.event_id && selectedEventIds.has(Number(d.event_id)));
    } else if (currentCuts.length > 0) {
      // No active selection, but there are cut events - filter by cutEvents
      const cutEventIds = new Set<number>(
        currentCuts
          .map((event: any) => {
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) return event.event_id;
            return null;
          })
          .filter((id: any): id is number => id !== null && id !== undefined)
      );
      data = data.filter((d: PerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }

    // Apply client-side filters: STATE, RACE, LEG, GRADE (use filterStore like FleetPerformance / FleetPerformanceHistory)
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n) && (n >= 0 && n <= 3)));
    }
    const states: string[] = [];
    const stateValues = selectedStatesAggregates();
    if (Array.isArray(stateValues) && stateValues.length > 0) {
      states.push(...stateValues.map((s: string) => String(s)));
    }
    
    // Apply client-side filters if any are active
    if (races.length > 0 || legs.length > 0 || grades.length > 0 || states.length > 0) {
      const filterConfig = createFilterConfig(
        [], // twaStates
        races,
        legs,
        grades
      );
      
      // Add STATE filter to config (separate from twaStates)
      const fullFilterConfig = {
        ...filterConfig,
        twaStates: [],
        states: states, // State field filter (e.g., H0, H1, H2) - always client-side
      };
      
      data = data.filter((point: any) => {
        // Data is normalized to lowercase fields (race_number, leg_number, grade, state) by processPerformanceData
        // passesBasicFilters expects normalized lowercase fields and handles type conversion internally
        return passesBasicFilters(point, fullFilterConfig);
      });
    }

    // Apply TWS bin filtering if a specific bin is selected (not "ALL")
    const currentTwsBin = twsBin();
    if (currentTwsBin && currentTwsBin !== 'ALL') {
      const twsField = defaultChannelsStore.twsName();
      const targetBin = Number(currentTwsBin);
      if (!isNaN(targetBin)) {
        data = data.filter((d: any) => {
          // Try multiple field name variations (case-insensitive)
          const twsValue = d[twsField];
          if (twsValue !== undefined && twsValue !== null && !isNaN(Number(twsValue))) {
            // Round to nearest 5 knots to match binning (e.g., 5, 10, 15, 20, 25)
            const roundedTws = Math.round(Number(twsValue) / 5) * 5;
            return roundedTws === targetBin;
          }
          return false;
        });
      }
    }

    // Apply point of sail filtering if enabled
    if (showUwDw()) {
      const twaField = defaultChannelsStore.twaName();
      if (UwDw() === 'UPWIND') {
        const filtered = data.filter((d: PerformanceAggregatePoint) => Math.abs(d[twaField]) < 90);
        // Always return a new array reference to ensure reactivity
        return [...filtered];
      } else {
        const filtered = data.filter((d: PerformanceAggregatePoint) => Math.abs(d[twaField]) >= 90);
        // Always return a new array reference to ensure reactivity
        return [...filtered];
      }
    }
    // Always return a new array reference to ensure reactivity (even if no filtering was applied)
    return [...data];
  });

  // Create a memo that tracks selectedEvents and cutEvents for box plot reactivity
  // This ensures box plots update when selection changes
  // NOTE: Must be defined AFTER getFilteredAggregates to avoid temporal dead zone error
  const boxPlotDataKey = createMemo(() => {
    const selEvents = selectedEvents();
    const cuts = cutEvents();
    const filtered = getFilteredAggregates();
    // Create a key that changes when selection or data changes
    return `${selEvents?.length ?? 0}-${cuts?.length ?? 0}-${filtered.length}`;
  });

  // Memoized filtered cloud - properly tracked within reactive context
  const filteredCloud = createMemo((): PerformanceCloudPoint[] => {
    let data = cloud();

    // Apply selection filtering if there are cut events
    const currentCuts = cutEvents();
    if (currentCuts.length > 0) {
      const cutEventIds = new Set<number>(
        currentCuts
          .map((event: any) => {
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) return event.event_id;
            return null;
          })
          .filter((id: any): id is number => id !== null && id !== undefined)
      );
      data = data.filter((d: PerformanceCloudPoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }

    // Apply client-side filters: STATE, RACE, LEG, GRADE (use filterStore like FleetPerformance / FleetPerformanceHistory)
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n) && (n >= 0 && n <= 3)));
    }
    const states: string[] = [];
    const stateValues = selectedStatesAggregates();
    if (Array.isArray(stateValues) && stateValues.length > 0) {
      states.push(...stateValues.map((s: string) => String(s)));
    }
    
    // Apply client-side filters if any are active
    if (races.length > 0 || legs.length > 0 || grades.length > 0 || states.length > 0) {
      const filterConfig = createFilterConfig(
        [], // twaStates
        races,
        legs,
        grades
      );
      
      // Add STATE filter to config (separate from twaStates)
      const fullFilterConfig = {
        ...filterConfig,
        twaStates: [],
        states: states, // State field filter (e.g., H0, H1, H2) - always client-side
      };
      
      const beforeCount = data.length;
      data = data.filter((point: any) => {
        // Data is normalized to lowercase fields (race_number, leg_number, grade, state) by processPerformanceData
        // passesBasicFilters expects normalized lowercase fields and handles type conversion internally
        const passes = passesBasicFilters(point, fullFilterConfig);
        return passes;
      });
      
      // Debug logging for STATE filter on cloud data
      if (states.length > 0) {
        const allStatesInCloud = Array.from(new Set(cloud().map((p: any) => p.state).filter((s: any) => s != null && s !== 'NONE')));
        const allStatesInCloudWithCase = Array.from(new Set(cloud().map((p: any) => {
          const s = p.state ?? p.State ?? p.STATE;
          return (s != null && s !== 'NONE') ? String(s) : null;
        }).filter((s: any) => s != null)));
        
        // Check a few sample points to see their state values
        const samplePoints = cloud().slice(0, 10).map((p: any) => ({
          state: p.state,
          State: p.State,
          STATE: p.STATE,
          hasState: p.state != null && p.state !== 'NONE',
          hasStateUpper: p.State != null && p.State !== 'NONE',
          hasStateAllCaps: p.STATE != null && p.STATE !== 'NONE',
          event_id: p.event_id
        }));
        
        // Count how many points have each state value
        const stateCounts: Record<string, number> = {};
        cloud().forEach((p: any) => {
          const s = p.state ?? p.State ?? p.STATE;
          if (s != null && s !== 'NONE') {
            const stateStr = String(s);
            stateCounts[stateStr] = (stateCounts[stateStr] || 0) + 1;
          }
        });
        
        logDebug(`[Performance] Cloud filtering: ${beforeCount} -> ${data.length} points`, {
          statesFilter: states,
          statesFilterLower: states.map(s => String(s).toLowerCase()),
          samplePointState: data.length > 0 ? data[0]?.state : 'no data after filter',
          samplePointStates: data.slice(0, 5).map((p: any) => p.state),
          allStatesInCloud: allStatesInCloud,
          allStatesInCloudWithCase: allStatesInCloudWithCase,
          stateCounts: stateCounts,
          sampleBeforeFilter: samplePoints,
          cloudDataLength: cloud().length,
          pointsWithNullState: cloud().filter((p: any) => (p.state == null || p.state === 'NONE') && (p.State == null || p.State === 'NONE') && (p.STATE == null || p.STATE === 'NONE')).length
        });
      }
    }

    // Apply point of sail filtering if enabled
    if (showUwDw()) {
      const twaField = defaultChannelsStore.twaName();
      if (UwDw() === 'UPWIND') {
        return data.filter((d: PerformanceCloudPoint) => Math.abs(d[twaField]) < 90);
      } else {
        return data.filter((d: PerformanceCloudPoint) => Math.abs(d[twaField]) >= 90);
      }
    }
    return data;
  });

  // Non-reactive variable to hold the plain filtered cloud value
  // Components expect a plain array, not a memo, to avoid reactivity issues
  let filteredCloudValue: PerformanceCloudPoint[] = [];

  // Update the variable when the memo changes (within reactive context)
  createEffect(() => {
    filteredCloudValue = filteredCloud();
  });

  const getFilteredTargets = () => {
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        return targets().data.UPWIND;
      } else {
        return targets().data.DOWNWIND;
      }
    }

    return targets().data;
  };

  // Keyboard shortcuts: 'x' to clear selection, 'c' to cut selection
  // Keys 1-3: Grade selected events (handled by PerfScatter component)
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable)) {
      return;
    }

    // Check if PerfSettings modal is visible
    const perfSettingsModal = document.querySelector('.pagesettings-modal');
    if (perfSettingsModal) {
      // Modal is visible, don't handle keyboard shortcuts
      return;
    }

    // 'x' key: Clear selection or clear cuts if no selection
    if (event.key === 'x' || event.key === 'X') {
      event.preventDefault();
      log('Performance: Clearing selection (x key pressed)');
      clearSelection();
      // Defer chart update to next frame for better responsiveness
      requestAnimationFrame(() => {
        setUpdateCharts(true);
      });
      return;
    }
    // 'h' key: Hide selected events (move to hidden list, then clear selection)
    if (event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      const currentSelected = selectedEvents();
      if (currentSelected && currentSelected.length > 0) {
        log('Performance: Hiding selection (h key pressed)');
        hideSelectedEvents();
        requestAnimationFrame(() => {
          setUpdateCharts(true);
        });
      }
      return;
    }
    // 'c' key: Cut selection (move selectedEvents to cutEvents)
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      const currentSelected = selectedEvents();
      if (currentSelected && currentSelected.length > 0) {
        log('Performance: Cutting selection (c key pressed)');
        cutSelection();
        // Defer chart update to next frame for better responsiveness
        requestAnimationFrame(() => {
          setUpdateCharts(true);
        });
      }
      return;
    }
  };

  // Fetch available targets (ispolar = 0, sorted by date_modified desc)
  const fetchAvailableTargets = async (): Promise<string[]> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();

      if (!className || !projectId) {
        logError('Cannot fetch targets: missing class_name or project_id');
        return ['No Target'];
      }

      const url = `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&isPolar=0`;
      logDebug(`[Performance] Fetching targets from: ${url}`);
      
      const response = await getData(url, new AbortController().signal);

      logDebug(`[Performance] Targets API response:`, { 
        success: response.success, 
        hasData: !!response.data, 
        dataType: Array.isArray(response.data) ? 'array' : typeof response.data,
        dataLength: Array.isArray(response.data) ? response.data.length : 'N/A'
      });

      const targets: string[] = ['No Target']; // Always include "No Target" as first option

      if (response.success && response.data) {
        // Ensure response.data is an array
        if (!Array.isArray(response.data)) {
          logError('[Performance] Targets API returned non-array data:', response.data);
          return targets;
        }

        if (response.data.length === 0) {
          logDebug('[Performance] No targets found in API response');
          return targets;
        }

        // Sort by date_modified desc (API should already do this, but ensure it)
        const sorted = response.data.sort((a: any, b: any) => {
          const dateA = new Date(a.date_modified || 0).getTime();
          const dateB = new Date(b.date_modified || 0).getTime();
          return dateB - dateA; // Descending
        });
        
        // Filter out any targets without valid names
        const validTargetNames = sorted
          .map((t: any) => t?.name)
          .filter((name: any): name is string => typeof name === 'string' && name.trim().length > 0);
        
        if (validTargetNames.length > 0) {
          targets.push(...validTargetNames);
          logDebug(`[Performance] Found ${validTargetNames.length} valid targets:`, validTargetNames);
        } else {
          logWarn('[Performance] No valid target names found in API response');
        }
      } else {
        logWarn('[Performance] Targets API call failed or returned no data:', { 
          success: response.success, 
          message: (response as any).message 
        });
      }

      return targets;
    } catch (error) {
      logError('Error fetching available targets:', error as any);
      return ['No Target'];
    }
  };

  // Fetch target data by name
  const fetchTargetData = async (targetName: string): Promise<PerformanceTargetData> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();

      if (!className || !projectId || !targetName) {
        logError('Cannot fetch target data: missing class_name, project_id, or targetName');
        return { name: '', data: {} };
      }

      const response = await getData(
        `${apiEndpoints.app.targets}/data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(targetName)}&isPolar=0`,
        new AbortController().signal
      );

      if (response.success && response.data) {
        return {
          name: targetName,
          data: response.data || {}
        };
      }

      return { name: '', data: {} };
    } catch (error) {
      logError('Error fetching target data:', error as any);
      return { name: '', data: {} };
    }
  };

  // Handle target click - open modal
  const handleTargetClick = async () => {
    logDebug('Performance: handleTargetClick called');
    setShowTargetModal(true);
    logDebug('Performance: showTargetModal set to true');
    const targetsList = await fetchAvailableTargets();
    setAvailableTargets(targetsList);
    // Default to current target name, or "No Target" if no target is set
    const currentTarget = targets();
    const currentTargetName = currentTarget?.name || 'No Target';
    setSelectedTargetName(currentTargetName);
    logDebug('Performance: Modal should be visible now', { showTargetModal: showTargetModal(), availableTargets: targetsList.length });
  };

  // Save target name to persistent settings
  const saveTargetToPersistentSettings = async (targetName: string): Promise<void> => {
    const currentUser = user();
    if (currentUser?.user_id) {
      try {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();

        if (className && projectId) {
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            {
              performanceTarget: targetName === 'No Target' ? '' : targetName
            }
          );
          logDebug('Performance: Saved target to persistent settings', targetName);
        }
      } catch (error: unknown) {
        logDebug('Performance: Error saving target to persistent settings:', error as any);
      }
    }
  };

  // Load target name from persistent settings
  const loadTargetFromPersistentSettings = async (): Promise<string | null> => {
    const currentUser = user();
    if (currentUser?.user_id) {
      try {
        const { selectedClassName, selectedProjectId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();

        if (className && projectId) {
          const settings = await persistentSettingsService.loadSettings(
            currentUser.user_id,
            className,
            projectId
          );

          if (settings?.performanceTarget && typeof settings.performanceTarget === 'string') {
            const cleanedTarget = cleanQuotes(settings.performanceTarget);
            logDebug('Performance: Loaded target from persistent settings', cleanedTarget);
            return cleanedTarget;
          }
        }
      } catch (error: unknown) {
        logDebug('Performance: Error loading target from persistent settings:', error as any);
      }
    }
    return null;
  };

  // Save target name to sessionStorage (session persistence)
  const saveTargetToSessionStorage = (targetName: string): void => {
    try {
      const targetData = {
        targetName: targetName === 'No Target' ? '' : targetName
      };
      sessionStorage.setItem('performanceTarget', JSON.stringify(targetData));
      logDebug('Performance: Saved target to sessionStorage', targetName);
    } catch (error) {
      logDebug('Performance: Error saving target to sessionStorage:', error);
    }
  };

  // Load target name from sessionStorage (session persistence)
  const loadTargetFromSessionStorage = (): string | null => {
    try {
      const savedTarget = sessionStorage.getItem('performanceTarget');
      if (savedTarget) {
        const targetData = JSON.parse(savedTarget);
        if (targetData.targetName && typeof targetData.targetName === 'string') {
          logDebug('Performance: Loaded target from sessionStorage', targetData.targetName);
          return targetData.targetName;
        }
      }
    } catch (error) {
      logDebug('Performance: Error loading target from sessionStorage:', error);
    }
    return null;
  };

  // Helper function to find matching target name in available targets list
  // Handles cases where target names may have "_target" suffix
  const findMatchingTarget = (targetName: string, availableTargets: string[]): string | undefined => {
    if (!targetName || availableTargets.length === 0) {
      return undefined;
    }
    
    // First try exact match
    if (availableTargets.includes(targetName)) {
      return targetName;
    }
    
    // Try with "_target" suffix appended
    const withSuffix = `${targetName}_target`;
    if (availableTargets.includes(withSuffix)) {
      return withSuffix;
    }
    
    // Try finding a target that matches when "_target" is stripped from available targets
    const match = availableTargets.find(target => {
      // Remove "_target" suffix if present and compare
      const baseName = target.endsWith('_target') ? target.slice(0, -7) : target;
      return baseName === targetName;
    });
    
    return match;
  };

  // Fetch default target from project object
  const fetchDefaultTargetFromProjectObject = async (): Promise<string | null> => {
    try {
      // Resolve date
      let dateToUse: string;
      const selectedDateValue = selectedDate();
      if (selectedDateValue) {
        dateToUse = selectedDateValue;
      } else {
        const datasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : 0;
        if (datasetId > 0) {
          dateToUse = await performanceDataService.fetchDatasetDate();
        } else {
          return null; // No date available
        }
      }
      
      if (!dateToUse) {
        return null;
      }
      
      // Strip any quotes that might have been added during storage/serialization
      dateToUse = cleanQuotes(dateToUse);
      
      // Try both date formats: YYYY-MM-DD (original) and YYYYMMDD (converted)
      // Database stores dates as date type which uses YYYY-MM-DD format
      const dateFormats = dateToUse.includes('-') 
        ? [dateToUse, dateToUse.replace(/-/g, '')] // Try YYYY-MM-DD first, then YYYYMMDD
        : [dateToUse]; // Already in YYYYMMDD format
      
      let response: any = null;
      let dateUsed: string = '';
      
      // Try each date format until we find a match
      for (const formattedDate of dateFormats) {
        response = await getData(
          `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(formattedDate)}&object_name=target`
        );
        
        logDebug('Performance: Project object fetch response', {
          success: response.success,
          hasData: !!response.data,
          statusCode: (response as any).statusCode,
          dateUsed: formattedDate,
          dateFormat: formattedDate.includes('-') ? 'YYYY-MM-DD' : 'YYYYMMDD'
        });
        
        // If found, break out of loop
        if (response.success && response.data && (response as any).statusCode !== 204) {
          dateUsed = formattedDate;
          break;
        }
      }
      
      // If not found with specific date, try default date '1970-01-01' (try both formats)
      let isNotFound = !response || !response.success || !response.data || (response as any).statusCode === 204;
      if (isNotFound) {
        const defaultDates = ['1970-01-01', '19700101'];
        for (const defaultDate of defaultDates) {
          logDebug('Performance: Trying default date for project object', defaultDate);
          response = await getData(
            `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(defaultDate)}&object_name=target`
          );
          logDebug('Performance: Project object fetch response (default date)', {
            success: response.success,
            hasData: !!response.data,
            statusCode: (response as any).statusCode,
            dateUsed: defaultDate
          });
          
          // If found, break out of loop
          if (response.success && response.data && (response as any).statusCode !== 204) {
            dateUsed = defaultDate;
            isNotFound = false;
            break;
          }
        }
      }

      // If still not found, use last known project_object with object_name 'target'
      if (isNotFound) {
        logDebug('Performance: No target for date, fetching last known project object (object_name=target)');
        const latestResponse = await getData(
          `${apiEndpoints.app.projects}/object/latest?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&object_name=target`
        );
        if (latestResponse?.success && latestResponse.data && (latestResponse as any).statusCode !== 204) {
          const latestData = latestResponse.data as { json?: unknown; date?: string };
          const rawJson = latestData?.json;
          if (rawJson != null) {
            response = { success: true, data: typeof rawJson === 'string' ? rawJson : rawJson };
            dateUsed = latestData.date ? String(latestData.date) : 'latest';
            isNotFound = false;
            logDebug('Performance: Using last known target from project_objects', { dateUsed });
          }
        }
      }
      
      if (response && response.success && response.data) {
        try {
          // Parse JSON - handle both string and object responses
          let targetObj: any;
          if (typeof response.data === 'string') {
            targetObj = JSON.parse(response.data);
          } else {
            targetObj = response.data;
          }
          
          logDebug('Performance: Parsed project object', {
            targetObj,
            type: typeof targetObj,
            isArray: Array.isArray(targetObj),
            keys: typeof targetObj === 'object' && targetObj !== null ? Object.keys(targetObj) : []
          });
          
          // Handle array response - get first element if it's an array
          let obj: any;
          if (Array.isArray(targetObj)) {
            if (targetObj.length > 0) {
              obj = targetObj[0];
            } else {
              logWarn('Performance: Project object is an empty array', { targetObj });
              return null;
            }
          } else {
            obj = targetObj;
          }
          
          // Check for both 'name' and 'name_target' fields
          const targetName = obj?.name || obj?.name_target;
          if (targetName && typeof targetName === 'string') {
            logDebug('Performance: Fetched default target from project object', { targetName, dateUsed });
            return targetName;
          } else {
            logWarn('Performance: Project object exists but has no name field', { 
              targetObj, 
              obj,
              availableKeys: obj ? Object.keys(obj) : []
            });
          }
        } catch (parseError) {
          logError('Performance: Error parsing project object JSON:', parseError, { responseData: response.data });
        }
      } else {
        logWarn('Performance: Project object not found or fetch failed', {
          success: response?.success,
          statusCode: (response as any)?.statusCode,
          message: (response as any)?.message,
          dateUsed: dateUsed || dateToUse
        });
      }
    } catch (error) {
      logError('Performance: Error fetching default target from project object:', error);
    }
    return null;
  };

  // Handle target selection from modal
  const handleTargetSelect = async () => {
    const targetName = selectedTargetName();

    setShowTargetModal(false);

    if (!targetName || targetName === 'No Target') {
      // Clear target
      setTargets({ name: '', data: {} });
      setUpdateCharts(true); // Trigger chart redraw
      logDebug('Performance: Cleared target (No Target selected)');
      // Save empty target to persistent settings
      await saveTargetToPersistentSettings('');
      // Save to sessionStorage for session persistence
      saveTargetToSessionStorage('');
      return;
    }

    const targetData = await fetchTargetData(targetName);
    setTargets(targetData);
    setUpdateCharts(true); // Trigger chart redraw
    logDebug(`Performance: Selected target "${targetName}"`);
    // Save target name to persistent settings
    await saveTargetToPersistentSettings(targetName);
    // Save to sessionStorage for session persistence
    saveTargetToSessionStorage(targetName);
  };

  onMount(async () => {
    await logPageLoad('Performance.jsx', 'Performance Analysis Report');

    // 1. Load filters from sessionStorage first (year, event, config, grades, state) - same as FleetPerformance
    loadFiltersFromSession();

    // 2. Wait for store to have project/class (e.g. after rehydration on reload)
    let className = selectedClassName();
    let projectId = selectedProjectId();
    for (let i = 0; i < 30 && (!className || !projectId); i++) {
      await new Promise(r => setTimeout(r, 100));
      className = selectedClassName();
      projectId = selectedProjectId();
    }

    // Resolve dataset date for project-object lookup (dataset report)
    let dateForFilters: string | null = null;
    const currentDatasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : 0;
    if (currentDatasetId > 0 && className && projectId) {
      try {
        const response = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(currentDatasetId)}`
        );
        if (response.success && response.data?.date) {
          let dateStr = response.data.date;
          if (dateStr.length === 8 && !dateStr.includes('-')) {
            dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
          }
          dateForFilters = dateStr;
        }
      } catch (_) {}
    }

    // 3. Load grade/state: project default first (by date), then user persistent if no project filters - same as FleetPerformance
    const projectFilters = (className && projectId) ? await getProjectPerformanceFilters(className, projectId, dateForFilters ?? undefined) : null;
    if (projectFilters === null) {
      await loadGradeStateFiltersFromPersistentSettings();
    }

    // 4. Set in-report defaults when none are set (grades 2,3; state empty = ALL)
    if (!filterGrades() || filterGrades().trim() === '') {
      setFilterGrades('2,3');
      logDebug('Performance: Set default grade filter to 2,3');
    }
    // Leave state empty when not set = "ALL" (show all states). Do not default to H0 so Performance matches FleetPerformance.
    if (!filterState() || filterState().trim() === '') {
      // Keep empty = ALL states; only set from project/persistent below if they specify a state
      logDebug('Performance: State filter empty = ALL (no state filter)');
    }

    // 5. Apply project filters on top (overrides defaults; empty string means "no filter")
    if (projectFilters !== null) {
      if (projectFilters.grades !== undefined) {
        setFilterGrades(cleanQuotes(projectFilters.grades ?? ''));
        logDebug('Performance: Applied grade filter from project default', projectFilters.grades);
      }
      if (projectFilters.state !== undefined) {
        setFilterState(cleanQuotes(projectFilters.state ?? ''));
        logDebug('Performance: Applied state filter from project default', projectFilters.state);
      }
    }

    // Sync filterStore so filtering memos (which read selectedStatesAggregates/selectedGradesAggregates) match local state - same as FleetPerformance
    const initialGrades = filterGrades().trim();
    const initialStates = filterState().trim();
    const gradesArr = initialGrades ? initialGrades.split(',').map(g => parseInt(g.trim())).filter(g => !isNaN(g) && (g >= 0 && g <= 3)) : [];
    const statesArr = initialStates && initialStates.toUpperCase() !== 'ALL' ? initialStates.split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2') : [];
    setSelectedGradesAggregates(gradesArr.map(String));
    setSelectedStatesAggregates(statesArr);

    // Load highlights and color preference from persistent settings before initializing charts
    // Note: Color preference will only be applied if it's in the available color options

    // Load target name from sessionStorage first (session persistence)
    let savedTargetName = loadTargetFromSessionStorage();
    // Fallback to persistent settings if not in sessionStorage
    if (!savedTargetName) {
      savedTargetName = await loadTargetFromPersistentSettings();
    }
    let targetNameToPreserve: string | undefined = undefined;
    const cleanedTargetName = savedTargetName ? cleanQuotes(savedTargetName) : null;
    if (cleanedTargetName && cleanedTargetName !== 'No Target') {
      // Verify the target still exists before loading it - handle "_target" suffix
      const targetsList = await fetchAvailableTargets();
      const matchingTargetName = findMatchingTarget(cleanedTargetName, targetsList);
      if (matchingTargetName) {
        const targetData = await fetchTargetData(matchingTargetName);
        setTargets(targetData);
        targetNameToPreserve = matchingTargetName;
        logDebug(`Performance: Loaded saved target "${matchingTargetName}" from persistent settings (matched from "${cleanedTargetName}")`);
      } else {
        logDebug(`Performance: Saved target "${cleanedTargetName}" no longer exists, skipping load`);
      }
    } else {
      // No persistent target exists, try to fetch default from project object
      const defaultTargetNameRaw = await fetchDefaultTargetFromProjectObject();
      const defaultTargetName = defaultTargetNameRaw ? cleanQuotes(defaultTargetNameRaw) : null;
      if (defaultTargetName) {
        // Verify the target exists in available targets - handle "_target" suffix
        const targetsList = await fetchAvailableTargets();
        const matchingTargetName = findMatchingTarget(defaultTargetName, targetsList);
        
        if (matchingTargetName) {
          const targetData = await fetchTargetData(matchingTargetName);
          setTargets(targetData);
          targetNameToPreserve = matchingTargetName;
          // Save as first persistent setting
          await saveTargetToPersistentSettings(matchingTargetName);
          logDebug(`Performance: Loaded default target "${matchingTargetName}" from project object (matched from "${defaultTargetName}") and saved to persistent settings`);
        } else {
          logWarn(`Performance: Default target "${defaultTargetName}" from project object not found in available targets. Available targets:`, targetsList);
          // Don't set any target - let it remain empty rather than falling back to latest
          // This ensures we don't accidentally load the wrong target
        }
      }
    }

    // Set filterStore dates from dataset date (reuse dateForFilters if we already fetched it)
    if (dateForFilters) {
      logDebug(`[Performance] onMount: Setting filterStore dates to dataset date: ${dateForFilters}`);
      setStartDate(dateForFilters);
      setEndDate(dateForFilters);
    }

    // Initialize charts immediately - color preference will update in background when loaded
    // Pass the saved target name to preserve it during initialization
    initializeCharts(targetNameToPreserve);
    // Register keyboard shortcuts
    window.addEventListener('keydown', handleKeyDown);

    // Set up dynamic scaling for media-container
    // Use width-based scaling to fill available width when zoomed
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'Performance',
      scaleToWidth: true
    });

    // Cleanup on unmount
    return () => {
      cleanupScaling();
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  // Cleanup abort controller and color save timeout on unmount
  onCleanup(() => {
    if (timesController) {
      timesController.abort();
    }
    if (colorSaveTimeout) {
      clearTimeout(colorSaveTimeout);
      colorSaveTimeout = null;
    }
  });

  const handleLegendClick = (legendItem: string) => {
    logDebug('Performance: handleLegendClick called', { legendItem, colorField: color(), aggregatesCount: aggregates().length });
    // Use full aggregates, not filtered by cuts, so selection can span all events
    const fullAggregates = aggregates();
    const currentColorField = color();
    const clickedItem = String(legendItem);
    const clickedItemLower = clickedItem.toLowerCase();
    
    // Map color field names to actual data field names
    // Note: All metadata fields are normalized to lowercase (matches unifiedDataStore normalization)
    const getFieldName = (colorField: string): string => {
      const fieldMap: Record<string, string> = {
        'TACK': 'tack',
        'GRADE': 'grade',
        'RACE': 'race_number',
        'LEG': 'leg_number',
        'CONFIG': 'config',
        'YEAR': 'year',
        'EVENT': 'event',
        'SOURCE_NAME': 'source_name',
        'STATE': 'state'
      };
      return fieldMap[colorField] || colorField;
    };
    
    const actualFieldName = getFieldName(currentColorField);
    
    // Filter by current color field from the FULL aggregates (not filtered by cuts)
    // Only apply point of sail filter if enabled
    let dataSource = fullAggregates;
    if (showUwDw()) {
      const twaField = defaultChannelsStore.twaName();
      if (UwDw() === 'UPWIND') {
        dataSource = fullAggregates.filter((d: PerformanceAggregatePoint) => Math.abs(d[twaField]) < 90);
      } else {
        dataSource = fullAggregates.filter((d: PerformanceAggregatePoint) => Math.abs(d[twaField]) >= 90);
      }
    }
    
    const legendEntryIds = dataSource
      .filter((a: PerformanceAggregatePoint) => {
        // Get the field value from the data point
        const fieldValue = a[actualFieldName];
        
        // Handle SOURCE_NAME specially (case-insensitive comparison)
        if (currentColorField === 'SOURCE_NAME') {
          // Check all possible field name variations
          const sourceName = String(
            fieldValue || 
            a.source_name || 
            a.sourceName || 
            a.Source_name || 
            a.SOURCE_NAME || 
            'Unknown'
          ).toLowerCase().trim();
          const clickedSourceLower = clickedItemLower.trim();
          return sourceName === clickedSourceLower;
        }
        
        // Handle RACE specially - need to handle TRAINING and numeric races
        if (currentColorField === 'RACE') {
          const raceValue = fieldValue !== undefined && fieldValue !== null ? fieldValue : null;
          const clickedStr = clickedItem;
          
          // Handle TRAINING: clicked item is 'TRAINING' and field value is 'TRAINING', -1, or '-1'
          if (clickedStr === 'TRAINING' || clickedStr === 'training') {
            return raceValue === 'TRAINING' || raceValue === 'training' || raceValue === -1 || raceValue === '-1';
          }
          
          // Handle numeric races: try to match as numbers
          const raceNum = typeof raceValue === 'number' ? raceValue : Number(raceValue);
          const clickedNum = Number(clickedStr);
          if (!isNaN(raceNum) && !isNaN(clickedNum)) {
            return raceNum === clickedNum;
          }
          
          // Try string match
          const raceValueStr = String(raceValue);
          if (raceValueStr === clickedStr) return true;
          if (raceValueStr.toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // Handle STATE specially (case-insensitive comparison)
        if (currentColorField === 'STATE') {
          const stateValue = fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : null;
          if (stateValue) {
            return stateValue.toLowerCase() === clickedItemLower;
          }
          return false;
        }
        
        // For other fields, compare values (handle both string and number)
        const fieldValueStr = fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : null;
        const clickedStr = clickedItem;
        
        // Try exact match first
        if (fieldValueStr === clickedStr) return true;
        
        // Try number comparison if both are numeric
        const fieldNum = Number(fieldValueStr);
        const clickedNum = Number(clickedStr);
        if (!isNaN(fieldNum) && !isNaN(clickedNum) && fieldNum === clickedNum) return true;
        
        // Try case-insensitive string match
        if (fieldValueStr && clickedStr && fieldValueStr.toLowerCase() === clickedStr.toLowerCase()) return true;
        
        return false;
      })
      .map((a: PerformanceAggregatePoint) => Number(a.event_id))
      .filter((id): id is number => !isNaN(id) && id !== null && id !== undefined);

    if (legendEntryIds.length === 0) {
      log('Performance: Legend click on', legendItem, '- no matching IDs found');
      setUpdateCharts(true);
      return;
    }

    // Get current selection
    const currentSelected = selectedEvents();
    const currentSelectedSet = new Set(currentSelected);
    
    // Check if all legend entry IDs are already selected
    const allSelected = legendEntryIds.every(id => currentSelectedSet.has(id));
    
    if (allSelected) {
      // All IDs are selected → remove all legend entry IDs
      const updatedSelection = currentSelected.filter(id => !legendEntryIds.includes(id));
      setSelectedEvents(updatedSelection);
      log('Performance: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'event IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      log('Performance: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'event IDs');
    }

    // Simple chart update
    setUpdateCharts(true);
  };

  // Effect to fetch event time data when events are selected
  let timesController: AbortController | null = null;
  createEffect(async () => {
    if (selectedEvents().length > 0) {
      // Endpoint requires dataset_id > 0 OR (source_id and date). Skip when we don't have a valid dataset.
      const datasetId = selectedDatasetId();
      if (!datasetId || datasetId <= 0) {
        logDebug('Performance: Skipping times fetch (dataset_id required)');
        return;
      }

      // Cancel previous request if still pending
      if (timesController) {
        timesController.abort();
      }

      // Create new abort controller
      timesController = new AbortController();

      try {
        const result = await getEventTimes({
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          dataset_id: datasetId,
          event_list: selectedEvents()
        }, timesController.signal);
        if (result.success && result.data) {
          setSelection(result.data);
        }
      } catch (error: unknown) {
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          logError('Error fetching event times:', error as any);
        }
      } finally {
        timesController = null;
      }
    }
  });

  // Fallback: clear mode-switching overlay after 3s if chart never reports rendered
  createEffect(() => {
    if (!modeSwitching()) return;
    const t = setTimeout(() => setModeSwitching(false), 3000);
    return () => clearTimeout(t);
  });

  return (
    <div id='media-container' class="performance-page">
      <Show when={!loading() && !isLoading()} fallback={<Loading />}>
        <Show when={requestError()}>
          <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
            <div class="mb-6">
              <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg class="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"></path>
                </svg>
              </div>
              <h3 class="text-xl font-semibold text-red-700 mb-2">Error Loading Performance Data</h3>
              <p class="text-red-600 mb-6">{requestError()}</p>
              <button
                onClick={() => initializeCharts()}
                class="inline-flex items-center px-6 py-3 bg-red-600 text-white font-semibold rounded-md hover:bg-red-700 transition-colors duration-200"
              >
                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
                Retry
              </button>
            </div>
          </div>
        </Show>
        <Show when={updateCharts() && !requestError()}>
          <div class="container relative">
            {/* Fixed legend section - stays at top */}
            <div class="performance-legend-section">
              {/* FiSettings button in upper left */}
              <div style="position: absolute; top: -5px; left: 0; z-index: 10;">
                <PerfSettings
                  useIconTrigger={true}
                  colorOptions={colors()}
                  selectedColor={() => color()}
                  onColorChange={handleColorChange}
                  selectedXAxis={() => xAxis()}
                  onXAxisChange={(axis) => handleAxisChange(axis)}
                  selectedPlotType={() => plotType()}
                  onPlotTypeChange={handlePlotTypeChange}
                  cloudDataOptions={['None', '1Hz Scatter', 'Recent History', 'Fleet Data', 'Season 5']}
                  selectedCloudData={() => {
                    const ct = cloudType();
                    if (ct === 'Latest') return '1Hz Scatter';
                    return ct;
                  }}
                  onCloudDataChange={(value) => {
                    const mapping: Record<string, string> = {
                      'None': 'None',
                      '1Hz Scatter': 'Latest',
                      'Recent History': 'Recent History',
                      'Fleet Data': 'Fleet Data',
                      'Season 5': 'Season 5'
                    };
                    const newCloudType = mapping[value] || 'None';
                    setCloudType(newCloudType);
                    getCurrentProjectDatasetIds().then(({ project_id, dataset_id }) => {
                      logActivity(project_id, dataset_id, 'Performance.tsx', 'Performance Report', `Cloud type changed to ${newCloudType}`);
                    });
                    setUpdateCharts(true);
                  }}
                  filterGrades={() => filterGrades()}
                  onFilterGradesChange={(value) => {
                    setFilterGrades(value);
                    saveGradeStateFiltersToPersistentSettings();
                    setFilterTrigger(prev => prev + 1);
                    handleColorChange(color(), true);
                    setUpdateCharts(true);
                  }}
                  filterState={() => filterState()}
                  onFilterStateChange={(value) => {
                    setFilterState(value);
                    saveGradeStateFiltersToPersistentSettings();
                    setFilterTrigger(prev => prev + 1);
                    handleColorChange(color(), true);
                    setUpdateCharts(true);
                  }}
                  setRaceOptions={(_races) => {
                    // PerfSettings will update filterStore internally
                  }}
                  setLegOptions={(_legs) => {
                    // PerfSettings will update filterStore internally
                  }}
                  selectedTrainingRacing={selectedTrainingRacing()}
                  onTrainingRacingFilterChange={(value) => {
                    setSelectedTrainingRacing(value);
                    saveGradeStateFiltersToPersistentSettings();
                    setFilterTrigger(prev => prev + 1);
                    handleColorChange(color(), true);
                    setUpdateCharts(true);
                  }}
                  showTimeline={() => showTimeline()}
                  onTimelineChange={handleTimelineChange}
                  onApplyFilters={() => {
                    log('Performance: onApplyFilters CALLED - triggering filter recalculation');
                    setFilterTrigger(prev => {
                      const next = prev + 1;
                      log('Performance: filterTrigger incremented', { prev, next });
                      return next;
                    });
                    handleColorChange(color(), true);
                    setUpdateCharts(true);
                  }}
                />
              </div>
              {/* Header section with controls and legend - legend beside dropdowns, centered in remaining space */}
              <div class="flex w-full items-center gap-x-2">
                <div class="flex shrink-0 gap-x-2 pt-2 pl-2 items-center" style="margin-left: 55px;">
                  <Show when={showUwDw()}>
                    <DropDownButton
                      options={["UPWIND", "DOWNWIND"]}
                      defaultText={UwDw()}
                      handleSelection={handleUwDwChange}
                      smallLabel="Uw/Dw"
                      size="medium"
                    />
                  </Show>
                  <DropDownButton
                    options={colors()}
                    defaultText={color()}
                    handleSelection={handleColorChange}
                    smallLabel="Color"
                    size="medium"
                  />
                  <Show when={plotType() === "Box"}>
                    <DropDownButton
                      options={twsBinOptions()}
                      defaultText={twsBin()}
                      handleSelection={handleTwsBinChange}
                      smallLabel="TWS Bin"
                      size="medium"
                    />
                  </Show>
                </div>
                <div class="legend-center-wrapper flex-1 flex items-center justify-center min-w-0 pt-2">
                  <Legend
                    elementId="legend-container"
                    target_info={targets()}
                    cloudType={cloudType()}
                    groups={groups()}
                    onTargetClick={handleTargetClick}
                    color={color()}
                    click={handleLegendClick}
                    filterSummary={<PerformanceFilterSummary filterGrades={filterGrades()} filterState={filterState()} trainingRacing={selectedTrainingRacing()} />}
                  />
                </div>
              </div>
              {/* Timeline component - min-width: 0 so it can shrink with window in flex layouts */}
              <Show when={showTimeline()}>
                <div style="width: 100%; min-width: 0; height: 88px; margin-top: 10px;">
                  <ScatterTimeseries
                    key={`timeline-${updateCharts()}-${selectedTrainingRacing() || 'all'}-${getFilteredAggregatesAVG().length}`}
                    aggregates={getFilteredAggregatesAVG()}
                    color={color()}
                    groups={groups()}
                    isHistoryPage={false}
                    uwDw={UwDw()}
                    showUwDw={showUwDw()}
                  />
                </div>
              </Show>
            </div>
            {/* Scrollable charts container - inner div is the scroll viewport so charts scroll correctly */}
            <div class="performance-charts-scroll-container">
              <div class="performance-charts-scroll-inner" style="position: relative;">
                <Show when={modeSwitching()}>
                  <Loading message="Updating charts..." fullScreen={false} />
                </Show>
              <Show when={!zoom()}>
                <Show when={charts().length > 0} fallback={
                    <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
                      <div class="mb-6">
                        <svg class="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                        </svg>
                        <h3 class="text-xl font-semibold text-gray-700 mb-2">No Charts Available</h3>
                        <p class="text-gray-500 mb-6">Would you like to add one?</p>
                      </div>
                      <button
                        onClick={() => window.location.href = '/performance-builder'}
                        class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg shadow-md hover:shadow-lg"
                      >
                        Add Chart
                      </button>
                    </div>
                  }>
                    <div class="target-container">
                      <For each={chartGroups()}>
                        {(group) => (
                          <div class="group-container">
                            <div class="break">
                              <h2>{group.name}</h2>
                            </div>
                            <Show when={group.additionalText}>
                              <div style="font-size: 12px; text-align: center; margin-top: 4px; margin-bottom: 8px;">
                                {group.additionalText}
                              </div>
                            </Show>
                            <div class="target-plots">
                              <For each={group.charts[0].series}>
                                {(series) => {
                                  // Create a memo for this specific series' chart config
                                  // This ensures it updates reactively when dependencies change
                                  const boxPlotChartConfig = createMemo(() => {
                                    // Access reactive values - this ensures memo recalculates when they change
                                    const dataKey = boxPlotDataKey(); // Force reactivity to selection changes
                                    const filteredData = getFilteredAggregates();
                                    const currentColor = color();
                                    const currentGroups = groups();
                                    const currentYType = series.yType || 'AVG';
                                    
                                    // Always create a new object to ensure reference changes
                                    return {
                                      _dataSignature: dataKey, // Use reactive data key
                                      series: [{
                                        xaxis: { name: currentColor },
                                        yaxis: { 
                                          name: series.yaxis.name,
                                          dataField: series.yaxis.dataField || series.yaxis.name
                                        },
                                        aggregate: currentYType,
                                        originalData: [...filteredData], // Create new array reference
                                        groupField: currentColor.toLowerCase(),
                                        groups: currentGroups,
                                        useAbsolute: false,
                                        useReverse: false,
                                        yType: currentYType
                                      }],
                                      filters: group.charts[0].filters
                                    };
                                  });
                                  
                                  return (
                                    <div style={{
                                      width: "100%",
                                      height: "500px",
                                      position: "relative"
                                    }}>
                                      <Show when={plotType() === "Scatter"}>
                                        <AdvancedScatter
                                          key={`scatter-${series.xaxisValue || xAxis()}-${series.yaxis.name}-${series.xType}-${series.yType}`}
                                          xaxis={series.xaxisValue || xAxis()}
                                          yaxis={series.yaxis.dataField || series.yaxis.name}
                                          taxis={series.yaxisTarget?.dataField || series.yaxisTarget?.name || ''}
                                          aggregate={series.yType || 'AVG'}
                                          filters={group.charts[0].filters}
                                          aggregates={getFilteredAggregates()}
                                          aggregatesAVG={getFilteredAggregatesAVG()}
                                          aggregatesSTD={getFilteredAggregatesSTD()}
                                          aggregatesAAV={getFilteredAggregatesAAV()}
                                          xType={series.xType || 'AVG'}
                                          yType={series.yType || 'AVG'}
                                          cloud={(series.xType || 'AVG').toUpperCase() === 'AVG' && (series.yType || 'AVG').toUpperCase() === 'AVG' ? filteredCloudValue : []}
                                          targets={getFilteredTargets()}
                                          uwDw={UwDw()}
                                          updateCharts={updateCharts()}
                                          color={color()}
                                          groups={groups()}
                                          mouseID={mouseID()}
                                          setMouseID={setMouseID}
                                          selectedChart={selectedChart()}
                                          handleZoom={handleZoom}
                                          zoom={zoom()}
                                          selectedEvents={selectedEvents()}
                                          hasCutData={cutEvents().length > 0}
                                          onDataUpdate={() => initializeCharts()}
                                          onChartRendered={() => requestAnimationFrame(() => setModeSwitching(false))}
                                          infoType={series.info_type}
                                          infoMessage={series.info_message ?? ""}
                                        />
                                      </Show>
                                      <Show when={plotType() === "Box"}>
                                        <BoxPlot
                                          chart={boxPlotChartConfig()} // Call memo to get reactive value
                                          data={getFilteredAggregates()} // Pass data directly as prop for better reactivity
                                          handleZoom={handleZoom}
                                          zoom={zoom()}
                                        />
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </div>
                        )}
                      </For>
                      {/* Spacer div to ensure last chart is fully visible when scrolling */}
                      <div 
                        class="performance-scroll-spacer"
                        style={{
                          height: "450px",
                          width: "100%",
                          "flex-shrink": "0"
                        }}
                      />
                    </div>
                  </Show>
              </Show>
              <Show when={zoom()}>
                <div class="zoom-container" style={{ "min-height": showTimeline() ? "750px" : "800px", "margin-top": "50px" }}>
                  <div class="flex w-full h-full" style={{ height: showTimeline() ? "750px" : "800px", width: "calc(100% - 25px)" }}>
                    <AdvancedScatter
                      xaxis={selectedChart()[0]}
                      yaxis={selectedChart()[1]}
                      taxis={selectedChart()[2]}
                      filters={selectedChart()[3]}
                      aggregates={getFilteredAggregates()}
                      aggregatesAVG={getFilteredAggregatesAVG()}
                      aggregatesSTD={getFilteredAggregatesSTD()}
                      aggregatesAAV={getFilteredAggregatesAAV()}
                      xType={selectedChart()[9] ?? selectedChart()[6] ?? 'AVG'}
                      yType={selectedChart()[10] ?? selectedChart()[6] ?? 'AVG'}
                      cloud={(selectedChart()[6] || 'AVG').toUpperCase() === 'AVG' ? filteredCloudValue : []}
                      targets={getFilteredTargets()}
                      aggregate={selectedChart()[6] || 'AVG'}
                      color={color()}
                      groups={groups()}
                      mouseID={mouseID()}
                      highlights={[]}
                      setMouseID={setMouseID}
                      handleZoom={handleZoom}
                      zoom={zoom()}
                      selectedEvents={selectedEvents()}
                      hasCutData={cutEvents().length > 0}
                      onChartRendered={() => requestAnimationFrame(() => setModeSwitching(false))}
                      infoType={selectedChart()[7]}
                      infoMessage={selectedChart()[8] ?? ""}
                    />
                  </div>
                </div>
              </Show>
              </div>
            </div>
            <div
              id="tt"
              class="tooltip"
              style={{
                opacity: tooltip().visible ? 1 : 0,
                left: `${tooltip().x}px`,
                top: `${tooltip().y}px`,
                position: "absolute",
                "pointer-events": "none",
              }}
              innerHTML={tooltip().content}
            ></div>
          </div>
        </Show>
      </Show>

      {/* Target Selection Modal */}
      <Show when={showTargetModal()}>
        <Portal mount={typeof document !== 'undefined' ? (document.getElementById('main-content') || document.body) : undefined}>
              <div
                class="pagesettings-overlay"
                onClick={() => {
                  logDebug('Performance: Modal overlay clicked, closing modal');
                  setShowTargetModal(false);
                }}
                style={{
                  display: 'flex',
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  'background-color': 'rgba(0, 0, 0, 0.5)',
                  'z-index': 10000,
                  'align-items': 'center',
                  'justify-content': 'center'
                }}
              >
                <div
                  class="pagesettings-modal target_modal"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'relative',
                    'z-index': 10001
                  }}
                >
                  <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
                    <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">Select Target</h2>
                    <button
                      onClick={() => setShowTargetModal(false)}
                      class="text-gray-500 hover:text-gray-700 transition-colors"
                      style="color: var(--color-text-secondary);"
                    >
                      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                      </svg>
                    </button>
                  </div>

                  <div class="p-6">
                    <Show when={availableTargets().length > 0} fallback={<p style="color: var(--color-text-primary);">No targets available</p>}>
                      <select
                        value={selectedTargetName()}
                        onChange={(e) => setSelectedTargetName(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          'margin-bottom': '1.5rem',
                          'font-size': '1rem',
                          'background-color': 'var(--color-bg-primary)',
                          color: 'var(--color-text-primary)',
                          border: '1px solid var(--color-border-primary)',
                          'border-radius': '4px'
                        }}
                      >
                        <For each={availableTargets()}>
                          {(target) => (
                            <option value={target}>{target}</option>
                          )}
                        </For>
                      </select>

                      <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '0.5rem' }}>
                        <button
                          onClick={() => setShowTargetModal(false)}
                          class="px-4 py-2 text-sm rounded-md transition-colors"
                          style="background-color: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleTargetSelect}
                          class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                          style={`background-color: ${selectedTargetName() && selectedTargetName() !== 'No Target' ? '#16a34a' : 'var(--color-bg-button)'}; color: var(--color-text-inverse);`}
                        >
                          Select
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
        </Portal>
      </Show>
    </div>
  );
}
