import { onMount, onCleanup, createSignal, For, Show, createEffect, createMemo, untrack, batch } from "solid-js";
import { Portal } from "solid-js/web";
import * as d3 from "d3";

import AdvancedScatter from "../../../../components/charts/AdvancedScatter";
import BoxPlot from "../../../../components/charts/BoxPlot";
import ScatterTimeseries from "../../../../components/charts/ScatterTimeseries";
import PerfTable from "../../../../components/tables/PerfTable";

import FleetLegend from "../../../../components/legends/Fleet";
import PerformanceFilterSummary from "../../../../components/legends/PerformanceFilterSummary";
import Loading from "../../../../components/utilities/Loading";
import DropDownButton from "../../../../components/buttons/DropDownButton";
import PerfSettings from "../../../../components/menus/PerfSettings";

import { getData, getEventTimes, setupMediaContainerScaling, groupBy, cleanQuotes } from "../../../../utils/global";
import { tooltip } from "../../../../store/globalStore";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../utils/logging";
import { log, debug as logDebug, warn as logWarn, error as logError } from "../../../../utils/console";
import { selectedEvents, cutEvents, setSelection, clearSelection, cutSelection, hideSelectedEvents, setSelectedEvents } from "../../../../store/selectionStore";

import { fleetPerformanceDataService } from "../../../../services/fleetPerformanceDataService";
import { performanceDataService } from "../../../../services/performanceDataService";
import { persistantStore } from "../../../../store/persistantStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { selectedSources as filterStoreSelectedSources, setSelectedSources as filterStoreSetSelectedSources, selectedRacesAggregates, selectedLegsAggregates, selectedGradesAggregates, selectedStatesAggregates, setSelectedStatesAggregates, setSelectedGradesAggregates } from "../../../../store/filterStore";
import { apiEndpoints } from "@config/env";
import { user } from "../../../../store/userStore";
import { persistentSettingsService } from "../../../../services/persistentSettingsService";
import { getProjectPerformanceFilters } from "../../../../services/projectFiltersService";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { getColorByIndex, resolveDataField } from "../../../../utils/colorScale";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { initializeSourceSelections } from "../../../../utils/sourceInitialization";
import { createFilterConfig, passesBasicFilters } from "../../../../utils/filterCore";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedDate, selectedSourceId } = persistantStore;

interface FleetPerformanceAggregatePoint {
  event_id?: number;
  source_name?: string;
  sourceName?: string;
  SOURCE_NAME?: string;
  Twa_deg?: number;
  [key: string]: any;
}

interface FleetPerformanceTargetData {
  name: string;
  data: {
    UPWIND?: any;
    DOWNWIND?: any;
    [key: string]: any;
  };
}

export default function FleetPerformancePage() {
  // Local state for fleet performance data - separate by aggregate type
  const [aggregatesAVG, setAggregatesAVG] = createSignal<FleetPerformanceAggregatePoint[]>([]);
  const [aggregatesSTD, setAggregatesSTD] = createSignal<FleetPerformanceAggregatePoint[]>([]);
  const [aggregatesAAV, setAggregatesAAV] = createSignal<FleetPerformanceAggregatePoint[]>([]);
  // Keep aggregates for backward compatibility (will be set to aggregatesAVG)
  const [aggregates, setAggregates] = createSignal<FleetPerformanceAggregatePoint[]>([]);
  const [targets, setTargets] = createSignal<FleetPerformanceTargetData>({ name: '', data: {} });
  const [showTargetModal, setShowTargetModal] = createSignal<boolean>(false);
  const [availableTargets, setAvailableTargets] = createSignal<string[]>([]);
  const [selectedTargetName, setSelectedTargetName] = createSignal<string>('');
  const [charts, setCharts] = createSignal<any[]>([]);
  
  // Local state for UI management only (no selection state)
  const [groups, setGroups] = createSignal<Array<{ name: string; color: string }>>([]);
  const [selectedSource, setSelectedSource] = createSignal<string | null>(null); // Track selected source from legend
  
  // Color options and selected color
  const [colorOptions, setColorOptions] = createSignal<string[]>([]); // Default fallback
  const [color, setColor] = createSignal<string>("SOURCE_NAME"); // Default to SOURCE_NAME

  // Map color options for display (SOURCE_NAME -> SOURCE)
  const displayColorOptions = createMemo(() => {
    return colorOptions().map(opt => opt === 'SOURCE_NAME' ? 'SOURCE' : opt);
  });

  // Map display text back to internal value (SOURCE -> SOURCE_NAME)
  const getInternalColorValue = (displayValue: string): string => {
    return displayValue === 'SOURCE' ? 'SOURCE_NAME' : displayValue;
  };

  // Get display text for current color
  const displayColor = createMemo(() => {
    const currentColor = color();
    return currentColor === 'SOURCE_NAME' ? 'SOURCE' : currentColor;
  });

  // Create color scale from sources store (use getSourceColor so store is single source of truth)
  const colorScale = createMemo(() => {
    const sources = sourcesStore.sources();
    const isReady = sourcesStore.isReady();
    
    // If store is not ready yet, return null (will trigger refresh in handleColorChange)
    if (!isReady || sources.length === 0) return null;
    
    const sourceNames = sources.map(s => String(s.source_name).toLowerCase());
    const colors = sources.map(s => sourcesStore.getSourceColor(s.source_name) || '#1f77b4');
    
    return d3.scaleOrdinal()
      .domain(sourceNames)
      .range(colors)
      .unknown('#1f77b4');
  });

  const [showUwDw, setShowUwDw] = createSignal<boolean>(true);
  const [loading, setLoading] = createSignal<boolean>(true);
  const [updateCharts, setUpdateCharts] = createSignal<boolean>(true);
  const [mouseID, setMouseID] = createSignal<string | null>(null);

  const [UwDw, setUwDw] = createSignal<string>("UPWIND");
  /** True while charts are re-rendering after upwind/downwind (or plot type) switch; used to show overlay. */
  const [modeSwitching, setModeSwitching] = createSignal<boolean>(false);
  
  const [showTimeline, setShowTimeline] = createSignal<boolean>(true);

  // Handler for timeline changes
  const handleTimelineChange = (value: boolean) => {
    setShowTimeline(value);
  };

  // Training/Racing filter state
  const [selectedTrainingRacing, setSelectedTrainingRacing] = createSignal<'TRAINING' | 'RACING' | null>(null);
  
  // Handle point of sail changes
  const handleUwDwChange = (value: string): void => {
    // Only update if value actually changed
    if (UwDw() === value) {
      logDebug('FleetPerformance: UwDw value unchanged, skipping update', value);
      return;
    }
    logDebug('FleetPerformance: UwDw changing from', UwDw(), 'to', value);
    setModeSwitching(true);
    setUwDw(value);
    // Clear selection when switching between upwind and downwind (preserve selectedSources so table and perf settings stay correct)
    clearSelection({ preserveFilters: true });
    // Defer chart update to avoid blocking dropdown response
    requestAnimationFrame(() => {
      setUpdateCharts(true);
    });
  };
  
  // Plot type state (Scatter, Box, or Data Table)
  const [plotType, setPlotType] = createSignal<string>("Scatter");
  
  // TWS bin state for box plot mode
  const [twsBin, setTwsBin] = createSignal<string>("ALL");
  const [twsBinOptions, setTwsBinOptions] = createSignal<string[]>(["ALL"]);
  
  // Importance sort state for PerfTable
  const [importanceSort, setImportanceSort] = createSignal<string>("None");
  
  // Handle plot type changes
  const handlePlotTypeChange = (value: string) => {
    setPlotType(value);
    // Reset TWS bin to "ALL" when switching to Scatter mode
    if (value === "Scatter") {
      setTwsBin("ALL");
    }
    setUpdateCharts(true);
  };

  // Map UwDw to windDirection prop for PerfTable
  const getWindDirection = (): 'UW' | 'DW' | 'BOTH' | undefined => {
    if (!showUwDw()) {
      return undefined; // No filter when upwind/downwind toggle is hidden
    }
    if (UwDw() === 'UPWIND') {
      return 'UW';
    } else if (UwDw() === 'DOWNWIND') {
      return 'DW';
    }
    return undefined;
  };
  
  // Handle TWS bin changes
  const handleTwsBinChange = async (value: string) => {
    setTwsBin(value);
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'FleetPerformance.tsx', 'Fleet Performance Report', `TWS bin changed to ${value}`);
    // Defer chart update to avoid blocking dropdown response
    requestAnimationFrame(() => {
      setUpdateCharts(true);
    });
  };
  
  const [xAxis, setXAxis] = createSignal<string>(defaultChannelsStore.twsName());
  
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
        logDebug('FleetPerformance: Loaded filters from sessionStorage', filterData);
      }
    } catch (error: unknown) {
      logDebug('FleetPerformance: Error loading filters from sessionStorage:', error as any);
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
              logDebug('FleetPerformance: Loaded grade filter from persistent settings', cleanQuotes(filters.grades));
            }
            if (filters.state && typeof filters.state === 'string') {
              setFilterState(cleanQuotes(filters.state));
              logDebug('FleetPerformance: Loaded state filter from persistent settings', cleanQuotes(filters.state));
            }
            if (filters.trainingRacing === 'TRAINING' || filters.trainingRacing === 'RACING') {
              setSelectedTrainingRacing(filters.trainingRacing);
              logDebug('FleetPerformance: Loaded trainingRacing filter from persistent settings', filters.trainingRacing);
            }
          }
        }
      } catch (error: unknown) {
        logDebug('FleetPerformance: Error loading grade/state filters from persistent settings:', error as any);
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
          logDebug('FleetPerformance: Saved grade, state, and trainingRacing filters to persistent settings', {
            grades: filterGrades(),
            state: filterState(),
            trainingRacing: selectedTrainingRacing()
          });
        }
      } catch (error: unknown) {
        logDebug('FleetPerformance: Error saving grade/state/trainingRacing filters to persistent settings:', error as any);
      }
    }
  };
  
  const [filterGrades, setFilterGrades] = createSignal<string>('');
  const [filterYear, setFilterYear] = createSignal<string>('');
  const [filterEvent, setFilterEvent] = createSignal<string>('');
  const [filterConfig, setFilterConfig] = createSignal<string>('');
  const [filterState, setFilterState] = createSignal<string>('');
  
  // Build dataSourcesOptions from sourcesStore for PerfSettings
  const dataSourcesOptions = createMemo(() => {
    if (!sourcesStore.isReady()) {
      return [];
    }
    
    const projectSources = sourcesStore.sources();
    if (!projectSources || projectSources.length === 0) {
      return [];
    }
    
    // Create signal getters - use untrack to prevent memo from tracking filterStoreSelectedSources
    const options = untrack(() => {
      return projectSources
        .map((s) => {
          const id = Number(s.source_id);
          if (!Number.isFinite(id)) {
            return null;
          }
          
          const getter = () => {
            const selectedSourceNames = filterStoreSelectedSources();
            const sourceName = String(s.source_name).toLowerCase();
            return selectedSourceNames.some((name: string) => String(name).toLowerCase() === sourceName);
          };
          const setter = (value: boolean) => {
            const currentNames = filterStoreSelectedSources();
            const sourceName = s.source_name || '';
            const sourceNameLower = String(sourceName).toLowerCase();
            
            if (value) {
              // Add source if not already selected
              if (!currentNames.some((name: string) => String(name).toLowerCase() === sourceNameLower)) {
                filterStoreSetSelectedSources([...currentNames, sourceName]);
              }
            } else {
              // Remove source if selected
              filterStoreSetSelectedSources(currentNames.filter((name: string) => String(name).toLowerCase() !== sourceNameLower));
            }
          };
          
          return {
            key: `source-${id}`,
            label: s.source_name || `Source ${id}`,
            type: 'toggle',
            signal: [getter, setter]
          };
        })
        .filter(opt => opt !== null);
    });
    
    return options;
  });
  
  // Build filters object from filter values
  type FleetPerformanceFilters = {
    GRADE?: number[];
    YEAR?: number[];
    EVENT?: string[];
    CONFIG?: string[];
    STATE?: string[];
    SOURCE_NAME?: string[];
    RACE?: (number | string)[];
    LEG?: number[];
  };
  
  const buildFilters = (): FleetPerformanceFilters | undefined => {
    const filters: FleetPerformanceFilters = {};
    
    // Parse grades (comma-separated, convert to integers)
    if (filterGrades().trim()) {
      const grades = filterGrades().split(',').map((g: string) => parseInt(g.trim())).filter((g: number) => !isNaN(g) && (g >= 0 && g <= 3));
      if (grades.length > 0) {
        filters.GRADE = grades;
      }
    }
    
    // Parse year (comma-separated, convert to integers)
    if (filterYear().trim()) {
      const years = filterYear().split(',').map((y: string) => parseInt(y.trim())).filter((y: number) => !isNaN(y));
      if (years.length > 0) {
        filters.YEAR = years;
      }
    }
    
    // Parse event (comma-separated strings)
    if (filterEvent().trim()) {
      const events = filterEvent().split(',').map((e: string) => e.trim()).filter((e: string) => e.length > 0);
      if (events.length > 0) {
        filters.EVENT = events;
      }
    }
    
    // Parse config (comma-separated strings)
    if (filterConfig().trim()) {
      const configs = filterConfig().split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 0);
      if (configs.length > 0) {
        filters.CONFIG = configs;
      }
    }
    
    // Parse state (comma-separated strings). Empty or "ALL" = no state filter (show all states).
    const stateRaw = filterState().trim();
    if (stateRaw && stateRaw.toUpperCase() !== 'ALL') {
      const states = filterState().split(',').map((s: string) => s.trim().toUpperCase()).filter((s: string) => s === 'H0' || s === 'H1' || s === 'H2');
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
        const num = Number(r);
        return isNaN(num) ? String(r) : num;
      });
    }
    
    // Parse leg numbers from selectedLegs (client-side filter)
    const legs = selectedLegsAggregates();
    if (legs && legs.length > 0) {
      filters.LEG = legs.map(l => Number(l)).filter(l => !isNaN(l));
    }
    
    // Parse sources from filterStore (array of source names)
    const selectedSources = filterStoreSelectedSources();
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      filters.SOURCE_NAME = selectedSources.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0);
    }
    
    return Object.keys(filters).length > 0 ? filters : undefined;
  };
  
  const [selectedChart, setSelectedChart] = createSignal<any[]>([]);
  const [zoom, setZoom] = createSignal<boolean>(false);

  // Local loading and error states
  const [isLoading, setIsLoading] = createSignal<boolean>(false);
  const [requestError, setRequestError] = createSignal<string | null>(null);

  // Data filtering is now handled automatically by the unified data store
  // based on global selection state - no manual cut data management needed

  const initializeCharts = async (preserveTargetName?: string) => {
    setLoading(true);
    setIsLoading(true);
    setRequestError(null);

    // Clear any old data to prevent showing stale data from previous dataset/source
    setAggregates([]);
    // Only clear targets if we're not preserving a specific target
    if (!preserveTargetName) {
      setTargets({ name: '', data: {} });
    }

    try {
      setUpdateCharts(false);

      // Check if we're in project mode (no date, no dataset)
      // This component is for day/dataset mode only - in project mode, FleetPerformanceHistory should be used
      const datasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : 0;
      const date = selectedDate();
      const hasValidDate = date && date.trim() !== '';
      const hasValidDataset = datasetId > 0;
      
      // If we're in project mode (no date and no dataset), return early without error
      // This prevents the error message when the component is loaded in project mode
      if (!hasValidDate && !hasValidDataset) {
        logDebug('FleetPerformance: Project mode detected (no date, no dataset) - this component is for day/dataset mode only');
        setLoading(false);
        setIsLoading(false);
        setUpdateCharts(false);
        return;
      }

      // Get date from selection state; fallback to dataset date if not set
      let dateToUse = date;
      if (!dateToUse) {
        // Try to fetch date from dataset if dataset ID is available
        if (hasValidDataset) {
          try {
            dateToUse = await performanceDataService.fetchDatasetDate();
            if (!dateToUse) {
              throw new Error("Failed to fetch dataset date from server");
            }
          } catch (fetchError: any) {
            // Handle network errors gracefully
            const errorMessage = fetchError?.message || String(fetchError);
            const isNetworkError = errorMessage.includes('Failed to fetch') || 
                                 errorMessage.includes('Network error') ||
                                 errorMessage.includes('NetworkError');
            
            if (isNetworkError) {
              logError('FleetPerformance: Network error while fetching dataset date:', fetchError);
              setRequestError("Unable to connect to server. Please check your connection and try again.");
              setUpdateCharts(true);
              return;
            } else {
              logError('FleetPerformance: Error fetching dataset date:', fetchError);
              throw new Error(`Failed to get dataset date: ${errorMessage}`);
            }
          }
        } else {
          // No date selected and no dataset ID available - show user-friendly error
          logError('FleetPerformance: No date selected and no dataset ID available');
          setRequestError("Please select a date or dataset to view fleet performance data.");
          setUpdateCharts(true);
          return;
        }
      }

      // Get chart objects first to determine required channels
      let chartObjects = await fleetPerformanceDataService.fetchCharts();
      // Fallback: if no fleet charts, use performance charts
      if (!chartObjects || chartObjects.length === 0) {
        chartObjects = await performanceDataService.fetchCharts();
      }
      setCharts(chartObjects);
      
      const channelMapping = performanceDataService.getChannelMapping(chartObjects);
      
      // Get aggregate type mapping to group channels by aggregate type
      const groupedChannels = await fleetPerformanceDataService.getAggregateTypeMapping(chartObjects);
      
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

      // If preserveTargetName is provided, fetch that specific target; otherwise fetch latest
      const targetsData = preserveTargetName ? await fetchTargetData(preserveTargetName) : await fleetPerformanceDataService.fetchTargets();

      // Fetch each aggregate type separately
      const [aggregatesAVGData, aggregatesSTDData, aggregatesAAVData] = await Promise.all([
        channelsByType.AVG.length > 0 ? fleetPerformanceDataService.fetchAggregates(channelsByType.AVG, 'AVG', undefined, undefined, filters) : Promise.resolve([]),
        channelsByType.STD.length > 0 ? fleetPerformanceDataService.fetchAggregates(channelsByType.STD, 'STD', undefined, undefined, filters) : Promise.resolve([]),
        channelsByType.AAV.length > 0 ? fleetPerformanceDataService.fetchAggregates(channelsByType.AAV, 'AAV', undefined, undefined, filters) : Promise.resolve([])
      ]);

      // Process each aggregate type separately with channel mapping
      const processedAVG = aggregatesAVGData.length > 0 
        ? performanceDataService.processPerformanceData(aggregatesAVGData, [], targetsData, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      const processedSTD = aggregatesSTDData.length > 0
        ? performanceDataService.processPerformanceData(aggregatesSTDData, [], targetsData, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      const processedAAV = aggregatesAAVData.length > 0
        ? performanceDataService.processPerformanceData(aggregatesAAVData, [], targetsData, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };

      // Set separate aggregate data
      setAggregatesAVG(processedAVG.aggregates || []);
      setAggregatesSTD(processedSTD.aggregates || []);
      setAggregatesAAV(processedAAV.aggregates || []);
      
      // Also set aggregates to AVG for backward compatibility
      setAggregates(processedAVG.aggregates || []);
      // Only set targets if we're not preserving a specific target (it's already set)
      if (!preserveTargetName) {
        setTargets(processedAVG.targets || { name: '', data: {} });
      }
      
      // Log data state for debugging
      logDebug('FleetPerformance: Data loaded', {
        aggregatesCount: (processedAVG.aggregates || []).length,
        hasTargets: !!(processedAVG.targets && Object.keys(processedAVG.targets.data || {}).length > 0),
        selectedSources: filterStoreSelectedSources(),
        selectedSourcesCount: filterStoreSelectedSources().length
      });

      // Extract TWS bins from aggregates data for box plot and data table modes (intervals of 5)
      if (processedAVG.aggregates && processedAVG.aggregates.length > 0) {
        const twsField = defaultChannelsStore.twsName();
        const twsFieldLower = twsField.toLowerCase();
        const uniqueTwsBins = new Set<number>();
        processedAVG.aggregates.forEach((point: any) => {
          // Try multiple field name variations (case-insensitive)
          const twsValue = point[twsField] ?? point[twsFieldLower];
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

      // Initialize groups based on current color selection and loaded data
      handleColorChange(color());

      // Check if charts have filters to determine if Upwind/Downwind should be shown
      let result = true;
      chartObjects.forEach((chartObject: any) => {
        if (chartObject.charts[0].filters.length > 0) {
          result = false;
        }
      });
      setShowUwDw(result);

      setUpdateCharts(true);
    } catch (err: unknown) {
      logError('Error initializing fleet performance charts:', err as any);
      setRequestError(err instanceof Error ? err.message : String(err));
      // Set updateCharts to true even on error so error message can be displayed
      setUpdateCharts(true);
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };

  // Set timezone when date changes (for fleet mode)
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    
    if (!className || !projectId || !date) {
      await setCurrentDataset(className || '', projectId || 0, null);
      return;
    }

    try {
      // Get timezone for this date using the dedicated endpoint
      const ymd = String(date).replace(/[-/]/g, '');
      const timezoneResponse = await getData(
        `${apiEndpoints.app.datasets}/date/timezone?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(ymd)}`
      );

      // The API returns { success: true, data: { timezone: "...", dataset_id: ... } } or { timezone: "...", dataset_id: ... }
      const timezoneData = timezoneResponse?.data || timezoneResponse || {};
      const timezone = timezoneData.timezone;
      const datasetId = timezoneData.dataset_id;
      
      if (timezone && datasetId) {
        await setCurrentDataset(className, projectId, datasetId);
        const tz = getCurrentDatasetTimezone();
        logDebug('FleetPerformance: Set timezone from date endpoint', {
          datasetId: datasetId,
          timezone: tz
        });
      } else {
        // No timezone found for this date, clear timezone
        await setCurrentDataset(className, projectId, null);
      }
    } catch (error: unknown) {
      logDebug('FleetPerformance: Error setting timezone', error as any);
      await setCurrentDataset(className, projectId, null);
    }
  });


  // Populate TWS bins from existing aggregates when switching to Box or Data Table mode
  createEffect(() => {
    const currentPlotType = plotType();
    const currentAggregates = aggregates();
    
    // Only populate TWS bins for Box or Data Table modes
    if ((currentPlotType === "Box" || currentPlotType === "Data Table") && currentAggregates.length > 0) {
      const twsField = defaultChannelsStore.twsName();
      const twsFieldLower = twsField.toLowerCase();
      const uniqueTwsBins = new Set<number>();
      currentAggregates.forEach((point: any) => {
        // Try multiple field name variations (case-insensitive)
        const twsValue = point[twsField] ?? point[twsFieldLower] ?? point['Tws'] ?? point['tws'] ?? point['TWS'];
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

  const handleZoom = (info: any[]): void => {
    if (info.length > 0) {
        setSelectedChart(info);
        setZoom(true);
    } else {
        setSelectedChart([]); 
        setZoom(false);
    }
  };

  const handleAxisChange = async (axis: string): Promise<void> => {
    // axis is already the correct channel name from defaultChannelsStore (via PerfSettings)
    setXAxis(axis);
    setZoom(false);
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'FleetPerformance.tsx', 'Fleet Performance Report', `Axis changed to ${axis}`);
    setUpdateCharts(true);
  }

  // Create chart layout - just use the chart configuration as-is
  const chartGroups = createMemo(() => {
    const chartsData = charts();
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
          }
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
  });

  const handleColorChange = async (value: string, forceUpdate?: boolean): Promise<void> => {
    if (value === color() && !forceUpdate) return;

    // Compute new groups synchronously so chart has correct groups when it re-renders with new color (avoids white/lightgrey flash)
    const dataForGrouping = aggregates();
    const getFieldName = (colorField: string): string => {
      const fieldMap: Record<string, string> = {
        'TACK': 'tack', 'GRADE': 'grade', 'RACE': 'race_number', 'LEG': 'leg_number',
        'CONFIG': 'config', 'YEAR': 'year', 'EVENT': 'event', 'SOURCE_NAME': 'source_name', 'STATE': 'state'
      };
      return fieldMap[colorField] || colorField;
    };
    const getPointValue = (d: any): any => {
      const v = resolveDataField(d, value);
      if (value === 'RACE' && (v === -1 || v === '-1')) return 'TRAINING';
      return v;
    };
    let unique_vals: any[] =
      value === 'TACK'
        ? groupBy(dataForGrouping, getFieldName(value))
        : value !== 'SOURCE_NAME'
          ? [...new Set(dataForGrouping.map(getPointValue))].filter((v) => v !== undefined && v !== null)
          : [];

    let newGroups: Array<{ name: string; color: string }>;
    if (value == 'SOURCE_NAME') {
      // Use source color scale for SOURCE_NAME
      // Get selected sources from filterStore - these should be displayed in the legend
      const selectedSources = filterStoreSelectedSources();
      
      // Check if sources are ready - if not, trigger refresh
      const isReady = sourcesStore.isReady();
      const sources = sourcesStore.sources();
      if (!isReady && sources.length === 0) {
        logDebug('FleetPerformance: Sources not ready, triggering refresh');
        sourcesStore.refresh().catch((error) => {
          logWarn('FleetPerformance: Failed to refresh sources', error);
        });
      }
      
      // Determine which sources to show in legend
      let sourcesToShow: string[] = [];
      
      if (Array.isArray(selectedSources) && selectedSources.length > 0) {
        // If sources are selected, use them directly (even if they don't have data yet)
        sourcesToShow = selectedSources.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0);
        logDebug('FleetPerformance: Using selected sources for legend', {
          selectedCount: selectedSources.length,
          sourcesToShow: sourcesToShow
        });
      } else {
        // If no sources selected, show all unique sources from data
        // unifiedDataStore normalizes metadata fields to lowercase, so source_name is already lowercase
        sourcesToShow = [...new Set(dataForGrouping.map((d: FleetPerformanceAggregatePoint) => d.source_name || 'Unknown'))].sort();
        logDebug('FleetPerformance: No sources selected, showing all sources from data', {
          sourcesToShowCount: sourcesToShow.length
        });
      }
      
      const scale = colorScale();
      const getColorForSource = (sourceName: any): string => {
        if (scale) {
          const normalizedSource = String(sourceName).toLowerCase();
          return String(scale(normalizedSource));
        }
        return '#1f77b4';
      };
      
      newGroups = sourcesToShow.map((sourceName: any) => ({
        name: String(sourceName),
        color: String(getColorForSource(sourceName))
      }));
    } else if (value == 'TACK') {
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
          return { name: val, color: 'lightgrey' };
        }
        if (!isNumericField && val == 0) return { name: val, color: 'lightgrey' };
        return { name: val, color: getColorByIndex(index) };
      });
    }

    batch(() => {
      setGroups(newGroups);
      setColor(value);
    });

    if (!forceUpdate) {
      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
      await logActivity(project_id, dataset_id, 'FleetPerformance.tsx', 'Fleet Performance Report', `Color changed to ${value}`);
    }
    requestAnimationFrame(() => {
      setUpdateCharts(true);
    });
  };

  // Helper to get filtered data (memoized for efficiency to prevent repeated filtering)
  // Track last logged source selection to prevent duplicate logs
  let lastLoggedSources: string[] = [];
  // Reactive memos for filtered aggregates by type - these automatically update when cutEvents changes
  const getFilteredAggregatesAVG = createMemo(() => {
    const data = aggregatesAVG();
    if (!Array.isArray(data)) {
      return [];
    }
    
    let filteredData = [...data];
    
    // Apply source filtering
    const selectedSources = filterStoreSelectedSources();
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      const selectedSourcesLower = selectedSources.map((s: any) => String(s).toLowerCase().trim());
      filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
        const sourceName = d.source_name || d.sourceName || d.SOURCE_NAME || '';
        const normalizedSource = String(sourceName).toLowerCase().trim();
        return selectedSourcesLower.includes(normalizedSource);
      });
    }
    
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
      filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }
    
    // Apply client-side filters
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n)));
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
        filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
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
        filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
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
    
    let filteredData = [...data];
    
    // Apply source filtering
    const selectedSources = filterStoreSelectedSources();
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      const selectedSourcesLower = selectedSources.map((s: any) => String(s).toLowerCase().trim());
      filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
        const sourceName = d.source_name || d.sourceName || d.SOURCE_NAME || '';
        const normalizedSource = String(sourceName).toLowerCase().trim();
        return selectedSourcesLower.includes(normalizedSource);
      });
    }
    
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
      filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }
    
    // Apply client-side filters
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n)));
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
        filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
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
        filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
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
    
    let filteredData = [...data];
    
    // Apply source filtering
    const selectedSources = filterStoreSelectedSources();
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      const selectedSourcesLower = selectedSources.map((s: any) => String(s).toLowerCase().trim());
      filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
        const sourceName = d.source_name || d.sourceName || d.SOURCE_NAME || '';
        const normalizedSource = String(sourceName).toLowerCase().trim();
        return selectedSourcesLower.includes(normalizedSource);
      });
    }
    
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
      filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }
    
    // Apply client-side filters
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    const grades: number[] = [];
    const gradeValues = selectedGradesAggregates();
    if (Array.isArray(gradeValues) && gradeValues.length > 0) {
      grades.push(...gradeValues.map((g: string | number) => (typeof g === 'number' ? g : Number(g))).filter((n: number) => !isNaN(n)));
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
        filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
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
        filteredData = filteredData.filter((d: FleetPerformanceAggregatePoint) => {
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
    let data = aggregates();
    
    // Apply source filtering by selected sources from filterStore
    const selectedSources = filterStoreSelectedSources();
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      const originalCount = data.length;
      const selectedSourcesLower = selectedSources.map((s: any) => String(s).toLowerCase().trim());
      data = data.filter((d: FleetPerformanceAggregatePoint) => {
        // unifiedDataStore normalizes metadata fields to lowercase, so source_name is already lowercase
        // But also check other case variations in case data hasn't been normalized yet
        const sourceName = d.source_name || d.sourceName || d.SOURCE_NAME || d.Source_name || '';
        const normalizedSource = String(sourceName).toLowerCase().trim();
        const matches = selectedSourcesLower.includes(normalizedSource);
        
        // Debug logging for production issues - log when source doesn't match
        if (!matches && sourceName) {
          logDebug('FleetPerformance: Source name mismatch in filtering', {
            dataSourceName: sourceName,
            normalizedDataSource: normalizedSource,
            selectedSources: selectedSourcesLower,
            dataPoint: { event_id: d.event_id, source_name: d.source_name, sourceName: d.sourceName, SOURCE_NAME: d.SOURCE_NAME }
          });
        }
        
        return matches;
      });
      
      // Only log if the source selection actually changed (prevents duplicate logs from memo recomputes)
      const sourcesSignature = selectedSources.sort().join(',');
      if (sourcesSignature !== lastLoggedSources.join(',')) {
        lastLoggedSources = [...selectedSources].sort();
        logDebug('FleetPerformance: Filtered aggregates by selected sources', {
          selectedSourcesCount: selectedSources.length,
          selectedSources: selectedSources,
          filteredCount: data.length,
          originalCount: originalCount
        });
      }
    } else {
      // Reset when no sources selected
      if (lastLoggedSources.length > 0) {
        lastLoggedSources = [];
        logDebug('FleetPerformance: No sources selected, showing all aggregates', {
          totalCount: data.length
        });
      }
    }
    
    // Apply selection filtering if there are cut events
    const currentCuts = cutEvents();
    
    if (currentCuts.length > 0) {
      // Extract event_ids from cut events (event_id is unique, so just match by event_id)
      const cutEventIds = new Set(
        currentCuts
          .map(event => {
            // Handle both event objects { event_id: ... } and number event_ids
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) {
              return event.event_id;
            }
            return null;
          })
          .filter(id => id !== null && id !== undefined)
      );
      
      // Filter aggregates by event_id only - sources don't matter
      data = data.filter((d: FleetPerformanceAggregatePoint) => d.event_id && cutEventIds.has(d.event_id));
      
      // Analyze source distribution in filtered result
      const sourceDistribution = data.reduce((acc: Record<string, number>, d: FleetPerformanceAggregatePoint) => {
        const source = String(d.source_name || 'Unknown').toLowerCase();
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {});
      
      log('Fleet Performance: Filtering aggregates by cut events', {
        cutEventCount: currentCuts.length,
        cutEventIdsCount: cutEventIds.size,
        cutEventIdsSample: Array.from(cutEventIds).slice(0, 20),
        fullAggregatesCount: aggregates().length,
        filteredCount: data.length,
        sourcesInResult: [...new Set(data.map(d => String(d.source_name || 'Unknown').toLowerCase()))],
        sourceDistribution: sourceDistribution,
        cutEventStructure: {
          firstCutEvent: currentCuts[0],
          firstCutEventType: typeof currentCuts[0],
          hasEventId: currentCuts[0]?.event_id !== undefined,
          sampleCutEvents: currentCuts.slice(0, 3).map(e => ({
            type: typeof e,
            event_id: typeof e === 'object' && e?.event_id !== undefined ? e.event_id : e,
            hasSource: e?.source_name !== undefined
          }))
        },
        aggregateEventIdSample: aggregates().slice(0, 5).map(d => ({
          event_id: d.event_id,
          source: d.source_name
        }))
      });
    }
    
    // Apply TWS bin filtering if a specific bin is selected (not "ALL")
    const currentTwsBin = twsBin();
    if (currentTwsBin && currentTwsBin !== 'ALL') {
      const twsField = defaultChannelsStore.twsName();
      const twsFieldLower = twsField.toLowerCase();
      const targetBin = Number(currentTwsBin);
      if (!isNaN(targetBin)) {
        data = data.filter((d: any) => {
          // Try multiple field name variations (case-insensitive)
          const twsValue = d[twsField] ?? d[twsFieldLower];
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
      const twaFieldLower = twaField.toLowerCase();
      if (UwDw() === 'UPWIND') {
        return data.filter((d: FleetPerformanceAggregatePoint) => {
          const twaValue = d[twaField] ?? d[twaFieldLower] ?? d.twa ?? 0;
          return Math.abs(twaValue) < 90;
        });
      } else {
        return data.filter((d: FleetPerformanceAggregatePoint) => {
          const twaValue = d[twaField] ?? d[twaFieldLower] ?? d.twa ?? 0;
          return Math.abs(twaValue) >= 90;
        });
      }
    }
    return data;
  });


  // Helper to get filtered targets (memoized for efficiency)
  const getFilteredTargets = createMemo((): any => {
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        return targets().data.UPWIND;
      } else {
        return targets().data.DOWNWIND;
      }
    }

    return targets().data;
  });

  // Track last source selection to detect changes
  let lastSourceSelection: string[] | null = null; // null means initial state, not yet set
  let isRefetching = false;
  // Track date for which project filters were applied so date-change effect only runs when date actually changes (skip when onMount is doing initial load)
  let lastProjectFiltersDate: string = 'INIT';
  let hasInitialized = false; // Track if initial load has completed
  let initializationTimeout: ReturnType<typeof setTimeout> | null = null;

  // Refetch data when selected sources change (if data was fetched with source filters)
  createEffect(async () => {
    const selectedSources = filterStoreSelectedSources();
    const currentSources = Array.isArray(selectedSources) ? selectedSources.map(s => String(s).toLowerCase().trim()).sort() : [];
    
    // On initial mount, just store the initial selection and return
    if (lastSourceSelection === null) {
      lastSourceSelection = [...currentSources];
      // Mark as initialized after a short delay to allow initial load to complete
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
      }
      initializationTimeout = setTimeout(() => {
        hasInitialized = true;
        initializationTimeout = null;
      }, 500); // Wait 500ms for initial load
      return;
    }
    
    // Only proceed if we've initialized and sources actually changed
    if (!hasInitialized || isRefetching) {
      return;
    }
    
    const lastSources = lastSourceSelection.map(s => String(s).toLowerCase().trim()).sort();
    const sourcesChanged = currentSources.length !== lastSources.length || 
      currentSources.some((s, i) => s !== lastSources[i]);
    
    if (!sourcesChanged) {
      return;
    }
    
    logDebug('FleetPerformance: Source selection changed, refetching data', {
      previousSources: lastSources,
      newSources: currentSources,
      previousCount: lastSources.length,
      newCount: currentSources.length,
      hasData: aggregates().length > 0,
      willFetchAllSources: currentSources.length === 0
    });
    
    lastSourceSelection = [...currentSources];
    
    isRefetching = true;
    try {
      // Preserve current target when refetching due to source change
      const currentTargetName = targets()?.name;
      const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
      await initializeCharts(targetToPreserve);
    } catch (error) {
      logError('FleetPerformance: Error refetching data after source change', error as any);
    } finally {
      isRefetching = false;
    }
  });

  // Update legend groups when selected sources change (only if color is SOURCE_NAME)
  createEffect(() => {
    const selectedSources = filterStoreSelectedSources();
    const currentColor = color();
    
    // Only update groups if color is SOURCE_NAME (when legend shows sources)
    if (currentColor === 'SOURCE_NAME' && aggregates().length > 0) {
      handleColorChange(currentColor, true);
      logDebug('FleetPerformance: Updated groups due to source selection change', {
        selectedSourcesCount: selectedSources.length,
        selectedSources: selectedSources
      });
    }
  });

  // Update group colors when color scale becomes available (only for SOURCE_NAME)
  let lastGroupsSignature = '';
  let groupsEffectCount = 0;
  createEffect(() => {
    groupsEffectCount++;
    
    // Detect infinite loops
    if (groupsEffectCount > 50) {
      logError('🚨 INFINITE LOOP DETECTED in FleetPerformance groups color effect!', groupsEffectCount);
      groupsEffectCount = 0;
      return;
    }
    
    // Only update colors for SOURCE_NAME, other colors have their own color schemes
    const currentColor = color();
    if (currentColor !== 'SOURCE_NAME') {
      groupsEffectCount = 0;
      return;
    }
    
    // Watch sourcesStore to trigger when sources load
    const isReady = sourcesStore.isReady();
    const sources = sourcesStore.sources();
    const scale = colorScale();
    const currentGroups = groups();
    
    // Update if scale is ready and we have groups with default colors
    if (scale && currentGroups.length > 0) {
      const needsUpdate = currentGroups.some((g: { name: string; color: string }) => {
        if (g.name === 'ALL') return false;
        const normalizedSource = String(g.name).toLowerCase();
        const correctColor = scale(normalizedSource);
        return !g.color || g.color === '#1f77b4' || g.color !== correctColor;
      });
      
      if (needsUpdate) {
        logDebug('FleetPerformance: Updating group colors from sources', {
          isReady,
          sourcesCount: sources.length,
          groupsCount: currentGroups.length
        });
        
        const updatedGroups = currentGroups.map((group: { name: string; color: string }) => {
          if (group.name === 'ALL') {
            return group;
          }
          const normalizedSource = String(group.name).toLowerCase();
          return { ...group, color: String(scale(normalizedSource)) };
        });
        
        // Create signature to detect actual changes
        const groupsSignature = updatedGroups.map(g => `${g.name}:${g.color}`).join('|');
        const currentSignature = groupsSignature;
        
        // Only update if the signature actually changed
        if (currentSignature !== lastGroupsSignature) {
          lastGroupsSignature = currentSignature;
          setGroups(updatedGroups);
          logDebug('FleetPerformance: Updated groups with source colors', {
            updatedGroups: updatedGroups.map(g => ({ name: g.name, color: g.color }))
          });
        }
      }
    }
    
    // Reset count after processing
    groupsEffectCount = 0;
  });

  // Load highlights from persistent settings - will be called in main onMount
  const loadHighlightsFromPersistentSettings = async () => {
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
          
          logDebug('FleetPerformance: Loaded settings from persistent settings', settings);
        }
      } catch (error: unknown) {
        logDebug('FleetPerformance: Error loading highlights from persistent settings:', error as any);
      }
    }
  };


  onMount(() => {
    // 1. Set defaults immediately so UI can render
    const fallbackOptions = ['SOURCE_NAME', 'GRADE', 'EVENT', 'CONFIG', 'YEAR', 'STATE'];
    setColorOptions(fallbackOptions);
    setColor('SOURCE_NAME');
    
    // 1. Load filters from sessionStorage first (year, event, config, grades, state) - same as Performance page
    loadFiltersFromSession();

    // 2. Load actual values in background (don't await)
    (async () => {
      // Log page load (background)
      logPageLoad('FleetPerformance.jsx', 'Fleet Performance Analysis Report').catch(err => logError('FleetPerformance: Error logging page load:', err));

      // Wait for store to have project/class (e.g. after rehydration on reload) - same as Performance page
      let className = selectedClassName();
      let projectId = selectedProjectId();
      for (let i = 0; i < 30 && (!className || !projectId); i++) {
        await new Promise(r => setTimeout(r, 100));
        className = selectedClassName();
        projectId = selectedProjectId();
      }

      // In day mode, wait briefly for selectedDate so URL-synced date (e.g. ?date=2026-03-01) is used for project_objects performance_filters
      let dateForFilters: string | undefined = (selectedDate() || '').trim() || undefined;
      const datasetIdForWait = typeof selectedDatasetId === 'function' ? selectedDatasetId() : 0;
      if (!datasetIdForWait || datasetIdForWait === 0) {
        for (let j = 0; j < 10; j++) {
          const d = (selectedDate() || '').trim();
          if (d) {
            dateForFilters = d || undefined;
            break;
          }
          await new Promise(r => setTimeout(r, 50));
        }
        if (!dateForFilters) {
          dateForFilters = (selectedDate() || '').trim() || undefined;
        }
      }

      // 3. Load grade/state: project default first (by date), then user persistent if no project filters - same as Performance page
      const projectFilters = (className && projectId) ? await getProjectPerformanceFilters(className, projectId, dateForFilters) : null;
      if (projectFilters === null) {
        await loadGradeStateFiltersFromPersistentSettings();
      }

      // 4. Set in-report defaults when none are set (grades 2,3; state empty = ALL)
      if (!filterGrades() || filterGrades().trim() === '') {
        setFilterGrades('2,3');
        logDebug('FleetPerformance: Set default grade filter to 2,3');
      }
      // Leave state empty when not set = "ALL" (show all states). Do not default to H0 so FleetPerformance matches Performance.
      if (!filterState() || filterState().trim() === '') {
        logDebug('FleetPerformance: State filter empty = ALL (no state filter)');
      }

      // 5. Apply project filters on top (overrides defaults; empty string means "no filter")
      if (projectFilters !== null) {
        if (projectFilters.grades !== undefined) {
          setFilterGrades(cleanQuotes(projectFilters.grades ?? ''));
          logDebug('FleetPerformance: Applied grade filter from project default', projectFilters.grades);
        }
        if (projectFilters.state !== undefined) {
          setFilterState(cleanQuotes(projectFilters.state ?? ''));
          logDebug('FleetPerformance: Applied state filter from project default', projectFilters.state);
        }
      }

      // Sync filterStore so filtering memos see applied grades/state (same as Performance page init)
      const gradesStr = filterGrades().trim();
      const stateStr = filterState().trim();
      const gradesArr = gradesStr ? gradesStr.split(',').map((g: string) => parseInt(g.trim())).filter((g: number) => !isNaN(g) && (g >= 0 && g <= 3)) : [];
      const statesArr = stateStr && stateStr.toUpperCase() !== 'ALL' ? stateStr.split(',').map((s: string) => s.trim().toUpperCase()).filter((s: string) => s === 'H0' || s === 'H1' || s === 'H2') : [];
      setSelectedGradesAggregates(gradesArr.map(String));
      setSelectedStatesAggregates(statesArr);

      // Mark initial project filters applied for this date so date-change effect does not duplicate
      lastProjectFiltersDate = dateForFilters ?? '';

      // Load color options from UnifiedFilterService (day context) - background
      try {
        const colorOptionsFromService = await UnifiedFilterService.getColorOptions(
          selectedClassName(),
          'day',
          selectedProjectId()
        );
        if (colorOptionsFromService && colorOptionsFromService.length > 0) {
          // Add STATE to color options (it's a calculated field, not in filter config)
          const optionsWithState = [...colorOptionsFromService];
          if (!optionsWithState.includes('STATE')) {
            optionsWithState.push('STATE');
          }
          setColorOptions(optionsWithState);
          // If SOURCE_NAME is in options, use it as default, otherwise use first option
          if (optionsWithState.includes('SOURCE_NAME')) {
            setColor('SOURCE_NAME');
          } else if (optionsWithState.length > 0) {
            setColor(optionsWithState[0]);
          }
        } else {
          // Keep defaults if no options found
          logDebug('FleetPerformance: No color options found, using defaults');
        }
      } catch (error: unknown) {
        logError('Error loading color options:', error as any);
        // Keep defaults on error
      }
      
      // Load highlights from persistent settings (background)
      loadHighlightsFromPersistentSettings().catch(err => logError('FleetPerformance: Error loading highlights:', err));
      
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
          targetNameToPreserve = matchingTargetName;
          const targetData = await fetchTargetData(targetNameToPreserve);
          setTargets(targetData);
          logDebug(`FleetPerformance: Loaded saved target "${targetNameToPreserve}" from persistent settings (matched from "${cleanedTargetName}")`);
        } else {
          logDebug(`FleetPerformance: Saved target "${cleanedTargetName}" no longer exists, skipping load`);
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
            logDebug(`FleetPerformance: Found default target "${matchingTargetName}" from project object (matched from "${defaultTargetName}") and saved to persistent settings`);
          } else {
            logWarn(`FleetPerformance: Default target "${defaultTargetName}" from project object not found in available targets. Available targets:`, targetsList);
            // Don't set any target - let it remain empty rather than falling back to latest
            // This ensures we don't accidentally load the wrong target
          }
        }
      }
      
      // Load sources from persistent settings or default to first 6 (background)
      // Always reload sources when project changes to ensure we get the correct sources for the new project
      const initialSources = await initializeSourceSelections();
      if (initialSources.length > 0) {
        filterStoreSetSelectedSources(initialSources);
        logDebug('FleetPerformance: Initialized sources from persistent settings', initialSources);
      } else {
        // If no sources were loaded (empty array saved), clear the filterStore
        filterStoreSetSelectedSources([]);
        logDebug('FleetPerformance: No sources loaded from persistent settings, cleared sources');
      }
      
      // Re-initialize charts with updated sources/targets if they changed
      // Preserve the current target if one is set
      const currentTargetName = targets()?.name;
      const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
      initializeCharts(targetToPreserve).catch(err => logError('FleetPerformance: Error re-initializing charts after sources/targets update:', err));
    })();
  });

  // Re-load project_objects performance_filters when selectedDate changes (e.g. user picks 2026-03-01) so we show filters for that date
  createEffect(async () => {
    if (lastProjectFiltersDate === 'INIT') return; // onMount will do initial load
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = (selectedDate() || '').trim();
    if (!className || !projectId || !date) return;
    const datasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : 0;
    if (datasetId && datasetId !== 0) return; // day mode only
    if (date === lastProjectFiltersDate) return;
    lastProjectFiltersDate = date;
    const projectFilters = await getProjectPerformanceFilters(className, projectId, date);
    if (projectFilters !== null) {
      if (projectFilters.grades !== undefined) {
        setFilterGrades(cleanQuotes(projectFilters.grades ?? ''));
        logDebug('FleetPerformance: Applied grade filter from project default (date change)', projectFilters.grades);
      }
      if (projectFilters.state !== undefined) {
        setFilterState(cleanQuotes(projectFilters.state ?? ''));
        logDebug('FleetPerformance: Applied state filter from project default (date change)', projectFilters.state);
      }
      const gradesStr = filterGrades().trim();
      const stateStr = filterState().trim();
      const gradesArr = gradesStr ? gradesStr.split(',').map((g: string) => parseInt(g.trim())).filter((g: number) => !isNaN(g) && (g >= 0 && g <= 3)) : [];
      const statesArr = stateStr && stateStr.toUpperCase() !== 'ALL' ? stateStr.split(',').map((s: string) => s.trim().toUpperCase()).filter((s: string) => s === 'H0' || s === 'H1' || s === 'H2') : [];
      setSelectedGradesAggregates(gradesArr.map(String));
      setSelectedStatesAggregates(statesArr);
    }
    const currentTargetName = targets()?.name;
    const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
    initializeCharts(targetToPreserve).catch(err => logError('FleetPerformance: Error re-initializing charts after date change:', err));
  });

  // When project has sources but selectedSources is empty (e.g. sources loaded after first init, or DB wasn't ready), default to first 6 so the table works
  createEffect(async () => {
    if (!sourcesStore.isReady()) return;
    const projectSources = sourcesStore.sources();
    const currentSelected = filterStoreSelectedSources();
    if (projectSources.length === 0 || (Array.isArray(currentSelected) && currentSelected.length > 0)) return;
    const initialSources = await initializeSourceSelections();
    if (initialSources.length > 0) {
      filterStoreSetSelectedSources(initialSources);
      logDebug('FleetPerformance: Populated sources when store had sources but selection was empty', { count: initialSources.length });
    }
  });

  // Reload sources when project changes (reactive effect)
  createEffect(async () => {
    const projectId = selectedProjectId();
    const className = selectedClassName();
    
    // Only reload if we have a valid project and class
    if (!projectId || !className) return;
    
    // Wait a bit for sourcesStore to be ready after project change
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Reload sources from persistent settings for the new project
    const initialSources = await initializeSourceSelections();
    if (initialSources.length > 0) {
      filterStoreSetSelectedSources(initialSources);
      logDebug('FleetPerformance: Reloaded sources after project change', { projectId, className, sources: initialSources });
    } else {
      filterStoreSetSelectedSources([]);
      logDebug('FleetPerformance: Cleared sources after project change (no saved sources)', { projectId, className });
    }
    
    // Set up dynamic scaling for media-container using the global utility
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'FleetPerformance-Day',
      scaleToWidth: true
    });
    
    // Keyboard shortcuts for selection management
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Only handle shortcuts if not typing in an input/textarea
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      
      // Check if PerfSettings modal is visible
      const perfSettingsModal = document.querySelector('.pagesettings-modal');
      if (perfSettingsModal) {
        // Modal is visible, don't handle keyboard shortcuts
        return;
      }
      
      // Keys 1-5: Cycle through color options (for non-admin/publisher always, for admin/publisher only when no selection)
      // Note: FleetPerformance doesn't have color options, so skip this
      
      // 'x' key: Clear selection
      if (event.key === 'x' || event.key === 'X') {
        event.preventDefault();
        log('Fleet Performance: Clearing selection (x key pressed)');
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
        if (currentSelected.length > 0) {
          log('Fleet Performance: Hiding selection (h key pressed)');
          hideSelectedEvents();
          requestAnimationFrame(() => {
            setUpdateCharts(true);
          });
        }
        return;
      }
      
      // 'c' key: Cut selection (move to cut events)
      if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        const currentSelected = selectedEvents();
        if (currentSelected.length > 0) {
          log('Fleet Performance: Cutting selection (c key pressed)');
          cutSelection();
          // Defer chart update to next frame for better responsiveness
          requestAnimationFrame(() => {
            setUpdateCharts(true);
          });
        }
        return;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    
    // Cleanup on unmount
    return () => {
      cleanupScaling(); // Call the cleanup function returned by the utility
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  // Cleanup abort controller on unmount
  let timesController: AbortController | null = null;
  onCleanup(() => {
    if (timesController) {
      timesController.abort();
    }
  });

  // Fetch available targets (ispolar = 0, sorted by date_modified desc)
  const fetchAvailableTargets = async (): Promise<string[]> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        logError('Cannot fetch targets: missing class_name or project_id');
        return ['No Target'];
      }
      
      const response = await getData(
        `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&isPolar=0`,
        new AbortController().signal
      );
      
      const targets: string[] = ['No Target']; // Always include "No Target" as first option
      
      if (response.success && response.data) {
        // Sort by date_modified desc (API should already do this, but ensure it)
        const sorted = response.data.sort((a: any, b: any) => {
          const dateA = new Date(a.date_modified || 0).getTime();
          const dateB = new Date(b.date_modified || 0).getTime();
          return dateB - dateA; // Descending
        });
        targets.push(...sorted.map((t: any) => t.name as string));
      }
      
      return targets;
    } catch (error: unknown) {
      logError('Error fetching available targets:', error as any);
      return ['No Target'];
    }
  };

  // Fetch target data by name
  // Note: API expects the base name without "_target" suffix, even if the display name has it
  const fetchTargetData = async (targetName: string): Promise<FleetPerformanceTargetData> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId || !targetName) {
        logError('Cannot fetch target data: missing class_name, project_id, or targetName');
        return { name: '', data: {} };
      }
      
      // Try both with and without "_target" suffix - API might expect either format
      // First try without suffix (database format)
      const baseName = targetName.endsWith('_target') ? targetName.slice(0, -7) : targetName;
      const namesToTry = [baseName];
      // If original name had suffix, also try with suffix (in case API expects it)
      if (targetName.endsWith('_target')) {
        namesToTry.push(targetName);
      } else {
        // If original name didn't have suffix, try with suffix
        namesToTry.push(`${targetName}_target`);
      }
      
      // Try each name format until one works
      for (const nameToTry of namesToTry) {
        const response = await getData(
          `${apiEndpoints.app.targets}/data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(nameToTry)}&isPolar=0`,
          new AbortController().signal
        );
        
        if (response.success && response.data) {
          logDebug('FleetPerformance: Successfully fetched target data', {
            targetName,
            nameUsed: nameToTry,
            triedNames: namesToTry,
            hasData: !!response.data,
            dataKeys: response.data ? Object.keys(response.data) : []
          });
          return {
            name: targetName, // Keep the original name (with or without suffix) for display
            data: response.data || {}
          };
        }
      }
      
      logWarn('FleetPerformance: Failed to fetch target data with any name format', {
        targetName,
        triedNames: namesToTry,
        lastResponse: {
          success: false,
          hasData: false
        }
      });
      return { name: '', data: {} };
    } catch (error: unknown) {
      logError('Error fetching target data:', error as any);
      return { name: '', data: {} };
    }
  };

  // Handle target click - open modal
  const handleTargetClick = async () => {
    logDebug('FleetPerformance: handleTargetClick called');
    setShowTargetModal(true);
    logDebug('FleetPerformance: showTargetModal set to true');
    const targetsList = await fetchAvailableTargets();
    setAvailableTargets(targetsList);
    // Default to current target name, or "No Target" if no target is set
    const currentTarget = targets();
    const currentTargetName = currentTarget?.name || 'No Target';
    setSelectedTargetName(currentTargetName);
    logDebug('FleetPerformance: Modal should be visible now', { showTargetModal: showTargetModal(), availableTargets: targetsList.length });
  };

  // Handle target selection from modal
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
          logDebug('FleetPerformance: Saved target to persistent settings', targetName);
        }
      } catch (error: unknown) {
        logDebug('FleetPerformance: Error saving target to persistent settings:', error as any);
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
            logDebug('FleetPerformance: Loaded target from persistent settings', cleanedTarget);
            return cleanedTarget;
          }
        }
      } catch (error: unknown) {
        logDebug('FleetPerformance: Error loading target from persistent settings:', error as any);
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
      logDebug('FleetPerformance: Saved target to sessionStorage', targetName);
    } catch (error: unknown) {
      logDebug('FleetPerformance: Error saving target to sessionStorage:', error as any);
    }
  };

  // Load target name from sessionStorage (session persistence)
  const loadTargetFromSessionStorage = (): string | null => {
    try {
      const savedTarget = sessionStorage.getItem('performanceTarget');
      if (savedTarget) {
        const targetData = JSON.parse(savedTarget);
        if (targetData.targetName && typeof targetData.targetName === 'string') {
          logDebug('FleetPerformance: Loaded target from sessionStorage', targetData.targetName);
          return targetData.targetName;
        }
      }
    } catch (error: unknown) {
      logDebug('FleetPerformance: Error loading target from sessionStorage:', error as any);
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
      let dateFormats: string[];
      if (dateToUse.includes('-')) {
        // Input is YYYY-MM-DD, try both formats
        dateFormats = [dateToUse, dateToUse.replace(/-/g, '')];
      } else {
        // Input is YYYYMMDD, convert to YYYY-MM-DD and try both
        // Format: YYYYMMDD -> YYYY-MM-DD
        const year = dateToUse.substring(0, 4);
        const month = dateToUse.substring(4, 6);
        const day = dateToUse.substring(6, 8);
        const withDashes = `${year}-${month}-${day}`;
        dateFormats = [dateToUse, withDashes]; // Try YYYYMMDD first, then YYYY-MM-DD
      }
      
      let response: any = null;
      let dateUsed: string = '';
      
      // Try each date format until we find a match
      for (const formattedDate of dateFormats) {
        response = await getData(
          `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(formattedDate)}&object_name=target`
        );
        
        logDebug('FleetPerformance: Project object fetch response', {
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
          logDebug('FleetPerformance: Trying default date for project object', defaultDate);
          response = await getData(
            `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(defaultDate)}&object_name=target`
          );
          logDebug('FleetPerformance: Project object fetch response (default date)', {
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
        logDebug('FleetPerformance: No target for date, fetching last known project object (object_name=target)');
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
            logDebug('FleetPerformance: Using last known target from project_objects', { dateUsed });
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
          
          logDebug('FleetPerformance: Parsed project object', {
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
              logWarn('FleetPerformance: Project object is an empty array', { targetObj });
              return null;
            }
          } else {
            obj = targetObj;
          }
          
          // Check for both 'name' and 'name_target' fields
          const targetName = obj?.name || obj?.name_target;
          if (targetName && typeof targetName === 'string') {
            logDebug('FleetPerformance: Fetched default target from project object', { targetName, dateUsed });
            return targetName;
          } else {
            logWarn('FleetPerformance: Project object exists but has no name field', { 
              targetObj, 
              obj,
              availableKeys: obj ? Object.keys(obj) : []
            });
          }
        } catch (parseError) {
          logError('FleetPerformance: Error parsing project object JSON:', parseError, { responseData: response.data });
        }
      } else {
        logWarn('FleetPerformance: Project object not found or fetch failed', {
          success: response?.success,
          statusCode: (response as any)?.statusCode,
          message: (response as any)?.message,
          dateUsed: dateUsed || dateToUse
        });
      }
    } catch (error) {
      logError('FleetPerformance: Error fetching default target from project object:', error);
    }
    return null;
  };

  const handleTargetSelect = async () => {
    const targetName = selectedTargetName();
    
    if (!targetName || targetName === 'No Target') {
      // Clear target
      setTargets({ name: '', data: {} });
      setUpdateCharts(true); // Trigger chart redraw
      logDebug('FleetPerformance: Cleared target (No Target selected)');
      // Save empty target to persistent settings
      await saveTargetToPersistentSettings('');
      // Save to sessionStorage for session persistence
      saveTargetToSessionStorage('');
      setShowTargetModal(false);
      return;
    }
    
    // Don't close modal yet - wait to verify target was fetched successfully
    const targetData = await fetchTargetData(targetName);
    
    // Check if target data was successfully fetched
    if (!targetData.name || !targetData.data || Object.keys(targetData.data).length === 0) {
      logError('FleetPerformance: Failed to fetch target data for selected target', {
        targetName,
        returnedName: targetData.name,
        hasData: !!targetData.data,
        dataKeys: targetData.data ? Object.keys(targetData.data) : []
      });
      // Don't set empty target - keep current target and keep modal open
      // The user can see the error in console and try again
      return;
    }
    
    // Target was successfully fetched - now close modal and set target
    setTargets(targetData);
    setUpdateCharts(true); // Trigger chart redraw
    logDebug(`FleetPerformance: Selected target "${targetName}"`, {
      targetName: targetData.name,
      hasData: !!targetData.data,
      dataKeys: targetData.data ? Object.keys(targetData.data) : []
    });
    // Save target name to persistent settings
    await saveTargetToPersistentSettings(targetName);
    // Save to sessionStorage for session persistence
    saveTargetToSessionStorage(targetName);
    setShowTargetModal(false);
  };

  const handleLegendClick = (legendItem: string): void => {
    logDebug('FleetPerformance: handleLegendClick called', { legendItem, colorField: color(), aggregatesCount: aggregates().length });
    // Use unfiltered aggregates data for selection - don't filter by cuts when selecting
    // This allows selecting events from all sources even after cutting
    const fullAggregates = aggregates();
    const currentColorField = color();
    const clickedItem = String(legendItem);
    const clickedItemLower = clickedItem.toLowerCase();
    
    // Update selected source for color/fit logic (only for SOURCE_NAME)
    if (currentColorField === 'SOURCE_NAME') {
      setSelectedSource(clickedItemLower);
    }
    
    // Map color field names to actual data field names (must match handleColorChange / aggregate data keys)
    // Aggregate data uses race_number, leg_number, source_name, etc. (from fleetPerformanceDataService)
    const getFieldName = (colorField: string): string => {
      const fieldMap: Record<string, string> = {
        'TACK': 'tack',
        'GRADE': 'grade',
        'MAINSAIL': 'MAINSAIL',
        'HEADSAIL': 'HEADSAIL',
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
      const twaFieldLower = twaField.toLowerCase();
      if (UwDw() === 'UPWIND') {
        dataSource = fullAggregates.filter((d: FleetPerformanceAggregatePoint) => {
          const twaValue = d[twaField] ?? d[twaFieldLower] ?? d.twa ?? 0;
          return Math.abs(twaValue) < 90;
        });
      } else {
        dataSource = fullAggregates.filter((d: FleetPerformanceAggregatePoint) => {
          const twaValue = d[twaField] ?? d[twaFieldLower] ?? d.twa ?? 0;
          return Math.abs(twaValue) >= 90;
        });
      }
    }
    
    const legendEntryIds = dataSource
      .filter((a: FleetPerformanceAggregatePoint) => {
        // Get the field value from the data point - try multiple case variations
        // Data may have both uppercase (EVENT, YEAR, GRADE, CONFIG) and lowercase (event, year, grade, config) fields
        let fieldValue = a[actualFieldName];
        if (fieldValue === undefined || fieldValue === null) {
          // Try lowercase version
          const lowerFieldName = actualFieldName.toLowerCase();
          fieldValue = a[lowerFieldName];
        }
        if (fieldValue === undefined || fieldValue === null) {
          // Try uppercase version
          const upperFieldName = actualFieldName.toUpperCase();
          fieldValue = a[upperFieldName];
        }
        
        // Handle SOURCE_NAME specially (case-insensitive comparison)
        if (currentColorField === 'SOURCE_NAME') {
          // unifiedDataStore normalizes metadata fields to lowercase, so source_name is already lowercase
          // actualFieldName is 'source_name', so fieldValue should already be the lowercase source name
          const sourceName = String(fieldValue || a.source_name || a.sourceName || a.Source_name || a.SOURCE_NAME || 'Unknown').toLowerCase().trim();
          const clickedSourceLower = clickedItemLower.trim();
          return sourceName === clickedSourceLower;
        }
        
        // Handle RACE specially - need to handle TRAINING and numeric races
        if (currentColorField === 'RACE') {
          const raceValue = fieldValue !== undefined && fieldValue !== null ? fieldValue
            : (a.race_number ?? a.Race_number ?? a.RACE ?? null);
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
          // Try multiple field name variations for state
          const stateValue = fieldValue !== undefined && fieldValue !== null 
            ? String(fieldValue) 
            : (a.State !== undefined && a.State !== null ? String(a.State) : (a.state !== undefined && a.state !== null ? String(a.state) : null));
          if (stateValue) {
            return stateValue.toLowerCase() === clickedItemLower;
          }
          return false;
        }
        
        // Handle LEG specially - match numeric or string leg (data may use leg_number, Leg_number, LEG)
        if (currentColorField === 'LEG') {
          const legValue = fieldValue !== undefined && fieldValue !== null ? fieldValue
            : (a.leg_number ?? a.Leg_number ?? a.LEG ?? null);
          const legValueStr = legValue !== undefined && legValue !== null ? String(legValue) : null;
          if (!legValueStr) return false;
          const legNum = Number(legValueStr);
          const clickedNum = Number(clickedItem);
          if (!isNaN(legNum) && !isNaN(clickedNum)) return legNum === clickedNum;
          return legValueStr === clickedItem || legValueStr.toLowerCase() === clickedItem.toLowerCase();
        }
        
        // Handle EVENT, YEAR, GRADE, CONFIG - ensure case-insensitive comparison
        if (currentColorField === 'EVENT' || currentColorField === 'YEAR' || currentColorField === 'GRADE' || currentColorField === 'CONFIG') {
          const fieldValueStr = fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : null;
          const clickedStr = clickedItem;
          
          if (!fieldValueStr) return false;
          
          // Try exact match first
          if (fieldValueStr === clickedStr) return true;
          
          // Try number comparison if both are numeric (especially for YEAR and GRADE)
          const fieldNum = Number(fieldValueStr);
          const clickedNum = Number(clickedStr);
          if (!isNaN(fieldNum) && !isNaN(clickedNum) && fieldNum === clickedNum) return true;
          
          // Try case-insensitive string match
          if (fieldValueStr.toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // For other fields, compare values (handle both string and number)
        const fieldValueStr = fieldValue !== undefined && fieldValue !== null ? String(fieldValue) : null;
        const clickedStr = clickedItem;
        
        if (!fieldValueStr) return false;
        
        // Try exact match first
        if (fieldValueStr === clickedStr) return true;
        
        // Try number comparison if both are numeric
        const fieldNum = Number(fieldValueStr);
        const clickedNum = Number(clickedStr);
        if (!isNaN(fieldNum) && !isNaN(clickedNum) && fieldNum === clickedNum) return true;
        
        // Try case-insensitive string match
        if (fieldValueStr.toLowerCase() === clickedStr.toLowerCase()) return true;
        
        return false;
      })
      .map((a: FleetPerformanceAggregatePoint) => Number(a.event_id))
      .filter((id): id is number => !isNaN(id) && id !== null && id !== undefined);

    if (legendEntryIds.length === 0) {
      log('Fleet Performance: Legend click on', legendItem, '- no matching IDs found');
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
      log('Fleet Performance: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      log('Fleet Performance: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'IDs');
    }
    
    // Simple chart update
    setUpdateCharts(true);
  };

  // Effect to fetch event time data when events are selected
  createEffect(async () => {
    if (selectedEvents().length > 0) {
      // Skip in fleet context - /api/events/times requires dataset_id or (source_id and date)
      const datasetId = selectedDatasetId();
      if (!datasetId || datasetId <= 0) {
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
    <div id='media-container' class="fleet-performance-page">
    <Show when={!loading() && !isLoading()} fallback={<Loading />}>
      <Show when={requestError()}>
        <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
          <div class="mb-6">
            <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg class="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"></path>
              </svg>
            </div>
            <h3 class="text-xl font-semibold text-red-700 mb-2">Error Loading Fleet Performance Data</h3>
            <p class="text-red-600 mb-6">{requestError()}</p>
            <button
              onClick={() => {
                // Preserve current target when manually retrying
                const currentTargetName = targets()?.name;
                const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
                initializeCharts(targetToPreserve);
              }}
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
            <div style="position: absolute; top: 20px; left: 0; z-index: 10;">
              <PerfSettings
                useIconTrigger={true}
                colorOptions={colorOptions()}
                selectedColor={() => color()}
                onColorChange={handleColorChange}
                selectedXAxis={() => xAxis()}
                onXAxisChange={(axis) => handleAxisChange(axis)}
                showTimeline={() => showTimeline()}
                onTimelineChange={handleTimelineChange}
              selectedPlotType={() => plotType()}
              onPlotTypeChange={handlePlotTypeChange}
              showDataTable={true}
              dataSourcesOptions={dataSourcesOptions()}
                filterGrades={() => filterGrades()}
                onFilterGradesChange={(value) => {
                  setFilterGrades(value);
                  saveGradeStateFiltersToPersistentSettings();
                  handleColorChange(color(), true);
                  setUpdateCharts(true);
                }}
                filterYear={() => filterYear()}
                onFilterYearChange={(value) => {
                  setFilterYear(value);
                }}
                filterEvent={() => filterEvent()}
                onFilterEventChange={(value) => {
                  setFilterEvent(value);
                }}
                filterConfig={() => filterConfig()}
                onFilterConfigChange={(value) => {
                  setFilterConfig(value);
                }}
                filterState={() => filterState()}
                onFilterStateChange={(value) => {
                  setFilterState(value);
                  saveGradeStateFiltersToPersistentSettings();
                  handleColorChange(color(), true);
                  setUpdateCharts(true);
                }}
                setRaceOptions={(races) => {
                  // PerfSettings will update filterStore internally
                }}
                setLegOptions={(legs) => {
                  // PerfSettings will update filterStore internally
                }}
                selectedTrainingRacing={selectedTrainingRacing()}
                onTrainingRacingFilterChange={(value) => {
                  setSelectedTrainingRacing(value);
                  saveGradeStateFiltersToPersistentSettings();
                  handleColorChange(color(), true);
                  setUpdateCharts(true);
                }}
                onApplyFilters={async () => {
                  logDebug('FleetPerformance: onApplyFilters - sources may have changed, refetching data');
                  const currentTargetName = targets()?.name;
                  const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
                  await initializeCharts(targetToPreserve);
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
                <Show when={plotType() !== "Data Table"}>
                  <DropDownButton
                    options={displayColorOptions()}
                    defaultText={displayColor()}
                    handleSelection={(value) => handleColorChange(getInternalColorValue(value))}
                    smallLabel="Color"
                    size="medium"
                  />
                </Show>
                <Show when={plotType() === "Box" || plotType() === "Data Table"}>
                  <DropDownButton
                    options={twsBinOptions()}
                    defaultText={twsBin()}
                    handleSelection={handleTwsBinChange}
                    smallLabel="TWS Bin"
                    size="medium"
                  />
                </Show>
                <Show when={plotType() === "Data Table"}>
                  <DropDownButton
                    options={["None", "Max", "Min", "Abs"]}
                    defaultText={importanceSort()}
                    handleSelection={setImportanceSort}
                    smallLabel="Correlation"
                    size="medium"
                  />
                </Show>
              </div>
              <Show when={plotType() !== "Data Table"}>
                <div class="legend-center-wrapper flex-1 flex items-center justify-center min-w-0 pt-2">
                  <FleetLegend
                    elementId="legend-container"
                    target_info={targets()}
                    onTargetClick={handleTargetClick}
                    groups={groups()}
                    click={handleLegendClick}
                    colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
                    filterSummary={<PerformanceFilterSummary filterGrades={filterGrades()} filterState={filterState()} trainingRacing={selectedTrainingRacing()} />}
                  />
                </div>
              </Show>
            </div>
              {/* Timeline component */}
              <Show when={showTimeline()}>
                <div style="width: 100%; min-width: 0; height: 88px; margin-top: 10px;">
                  <ScatterTimeseries
                    key={`timeline-${updateCharts()}-${selectedTrainingRacing() || 'all'}-${getFilteredAggregatesAVG().length}`}
                    aggregates={getFilteredAggregatesAVG()}
                    color={color()}
                    groups={groups()}
                    colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
                    isHistoryPage={false}
                    uwDw={UwDw()}
                    showUwDw={showUwDw()}
                  />
                </div>
              </Show>
          </div>
          {/* Scrollable charts container - inner div is the scroll viewport so charts scroll correctly; table view uses class for scroll */}
          <div
            class={`performance-charts-scroll-container${plotType() === "Data Table" ? " performance-table-view" : ""}`}
          >
            <div class="performance-charts-scroll-inner" style="position: relative;">
              <Show when={modeSwitching()}>
                <Loading message="Updating charts..." fullScreen={false} />
              </Show>
            <Show when={!zoom()}>
              <Show when={plotType() === "Data Table"}>
                {/* Data Table View - Single table component */}
                <div class="target-container" style="padding: 20px;">
                  <PerfTable
                    chartObjects={charts()}
                    twsBin={twsBin()}
                    windDirection={getWindDirection()}
                    filterGrades={filterGrades()}
                    filterStates={filterState()}
                    filterYear={filterYear()}
                    filterEvent={filterEvent()}
                    filterConfig={filterConfig()}
                    importanceSort={importanceSort()}
                    selectedEventIds={selectedEvents()}
                    aggregatesData={getFilteredAggregates()}
                  />
                </div>
              </Show>
              <Show when={plotType() !== "Data Table"}>
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
                          {(series) => (
                            <div style={{ 
                              width: "100%", 
                              height: "500px", 
                              position: "relative"
                            }}>
                              <Show when={plotType() === "Scatter"}>
                                <AdvancedScatter
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
                                  targets={getFilteredTargets()}
                                  uwDw={UwDw()}
                                  updateCharts={updateCharts()}
                                  mouseID={mouseID()}
                                  setMouseID={setMouseID}
                                  selectedChart={selectedChart()}
                                  handleZoom={handleZoom}
                                  zoom={zoom()}
                                  selectedEvents={selectedEvents()}
                                  hasCutData={cutEvents().length > 0}
                                  selectedSource={selectedSource() || undefined}
                                  color={color()}
                                  groups={groups()}
                                  colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
                                  onDataUpdate={() => {
                                    // Preserve current target when updating data
                                    const currentTargetName = targets()?.name;
                                    const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
                                    initializeCharts(targetToPreserve);
                                  }}
                                  onChartRendered={() => requestAnimationFrame(() => setModeSwitching(false))}
                                  infoType={series.info_type}
                                  infoMessage={series.info_message ?? ""}
                                />
                              </Show>
                              <Show when={plotType() === "Box"}>
                                <BoxPlot
                                  chart={{
                                    series: [{
                                      xaxis: { name: color() },
                                      yaxis: { 
                                        name: series.yaxis.name,
                                        dataField: series.yaxis.dataField || series.yaxis.name
                                      },
                                      aggregate: series.yType || 'AVG',
                                      originalData: (() => {
                                        const yType = (series.yType || 'AVG').toUpperCase();
                                        if (yType === 'STD') return getFilteredAggregatesSTD();
                                        if (yType === 'AAV') return getFilteredAggregatesAAV();
                                        return getFilteredAggregates();
                                      })(),
                                      groupField: color().toLowerCase(),
                                      groups: groups(),
                                      useAbsolute: false,
                                      useReverse: false
                                    }],
                                    filters: group.charts[0].filters
                                  }}
                                  handleZoom={handleZoom}
                                  zoom={zoom()}
                                />
                              </Show>
                            </div>
                          )}
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
                  targets={getFilteredTargets()}
                  uwDw={UwDw()}
                  updateCharts={updateCharts()}
                  mouseID={mouseID()}
                  setMouseID={setMouseID}
                  handleZoom={handleZoom}
                  zoom={zoom()}
                  selectedEvents={selectedEvents()}
                  hasCutData={cutEvents().length > 0}
                  selectedSource={selectedSource() || undefined}
                  aggregate={selectedChart()[6] || 'AVG'}
                  color={color()}
                  groups={groups()}
                  colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
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
          onClick={() => setShowTargetModal(false)}
        >
          <div
            class="pagesettings-modal target_modal"
            onClick={(e) => e.stopPropagation()}
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
