import { onMount, onCleanup, createSignal, For, Show, createEffect, createMemo, untrack, batch } from "solid-js";
import { Portal } from "solid-js/web";
import * as d3 from "d3";

import AdvancedScatter from "../../../../../components/charts/AdvancedScatter";
import BoxPlot from "../../../../../components/charts/BoxPlot";
import ScatterTimeseries from "../../../../../components/charts/ScatterTimeseries";
import PerfTable from "../../../../../components/tables/PerfTable";

import FleetLegend from "../../../../../components/legends/Fleet";
import PerformanceFilterSummary from "../../../../../components/legends/PerformanceFilterSummary";
import Loading from "../../../../../components/utilities/Loading";
import DropDownButton from "../../../../../components/buttons/DropDownButton";
import PerfSettings from "../../../../../components/menus/PerfSettings";

import { getData, setupMediaContainerScaling, groupBy, cleanQuotes } from "../../../../../utils/global";
import { resolveDataField } from "../../../../../utils/colorScale";
import { tooltip } from "../../../../../store/globalStore";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../../utils/logging";
import { log, debug as logDebug, warn as logWarn } from "../../../../../utils/console";
import { selectedEvents, cutEvents, setSelectedEvents, setSelection, setSelectedRanges, setIsCut, setTriggerUpdate, clearSelection, hideSelectedEvents, setCutEvents, setHasSelection } from "../../../../../store/selectionStore";

import { fleetPerformanceDataService } from "../../../../../services/fleetPerformanceDataService";
import { performanceDataService } from "../../../../../services/performanceDataService";
import { error as logError } from "../../../../../utils/console";
import { persistantStore } from "../../../../../store/persistantStore";
import { sourcesStore } from "../../../../../store/sourcesStore";
import { startDate, endDate, setStartDate, setEndDate, initializeDateRange, selectedSources as filterStoreSelectedSources, setSelectedSources as filterStoreSetSelectedSources, selectedRacesAggregates, selectedLegsAggregates, selectedGradesAggregates, selectedStatesAggregates } from "../../../../../store/filterStore";
import { apiEndpoints } from "@config/env";
import { user } from "../../../../../store/userStore";
import { persistentSettingsService } from "../../../../../services/persistentSettingsService";
import { getProjectPerformanceFilters } from "../../../../../services/projectFiltersService";
import UnifiedFilterService from "../../../../../services/unifiedFilterService";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../../store/datasetTimezoneStore";
import { defaultChannelsStore } from "../../../../../store/defaultChannelsStore";
import { initializeSourceSelections } from "../../../../../utils/sourceInitialization";
import { passesBasicFilters, createFilterConfig } from "../../../../../utils/filterCore";
const { selectedClassName, selectedProjectId, selectedYear, selectedEvent } = persistantStore;

interface FleetPerformanceHistoryAggregatePoint {
  event_id?: number;
  source_name?: string;
  sourceName?: string;
  SOURCE_NAME?: string;
  Twa_deg?: number;
  /** IANA timezone for the row's dataset (for display; e.g. tooltips). */
  timezone?: string;
  [key: string]: any;
}

interface FleetPerformanceHistoryTargetData {
  name: string;
  data: {
    UPWIND?: any;
    DOWNWIND?: any;
    [key: string]: any;
  };
}

export default function FleetPerformancePage() {
  // Local state for fleet performance data - separate by aggregate type
  const [aggregatesAVG, setAggregatesAVG] = createSignal<FleetPerformanceHistoryAggregatePoint[]>([]);
  const [aggregatesSTD, setAggregatesSTD] = createSignal<FleetPerformanceHistoryAggregatePoint[]>([]);
  const [aggregatesAAV, setAggregatesAAV] = createSignal<FleetPerformanceHistoryAggregatePoint[]>([]);
  // Keep aggregates for backward compatibility (will be set to aggregatesAVG)
  const [aggregates, setAggregates] = createSignal<FleetPerformanceHistoryAggregatePoint[]>([]);
  const [targets, setTargets] = createSignal<FleetPerformanceHistoryTargetData>({ name: '', data: {} });
  const [showTargetModal, setShowTargetModal] = createSignal<boolean>(false);
  const [availableTargets, setAvailableTargets] = createSignal<string[]>([]);
  const [selectedTargetName, setSelectedTargetName] = createSignal<string>('');
  const [charts, setCharts] = createSignal<any[]>([]);
  
  // Local state for UI management only (no selection state)
  // Get color options from filter config (fleet context)
  const [colors, setColors] = createSignal<string[]>(['SOURCE_NAME','GRADE','EVENT','CONFIG','YEAR','STATE']); // Default fallback
  const [groups, setGroups] = createSignal<Array<{ name: string; color: string }>>([]);
  const [selectedSource, setSelectedSource] = createSignal<string | null>(null); // Track selected source from legend
  const [color, setColor] = createSignal<string>("SOURCE_NAME");

  // Map color options for display (SOURCE_NAME -> SOURCE)
  const displayColorOptions = createMemo(() => {
    return colors().map(opt => opt === 'SOURCE_NAME' ? 'SOURCE' : opt);
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
  
  const S20colorScale = d3.scaleOrdinal(d3.schemeCategory10);

  // Create color scale from sources store
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
  
  // Handle point of sail changes
  const handleUwDwChange = (value: string): void => {
    // Only update if value actually changed
    if (UwDw() === value) {
      logDebug('FleetPerformanceHistory: UwDw value unchanged, skipping update', value);
      return;
    }
    logDebug('FleetPerformanceHistory: UwDw changing from', UwDw(), 'to', value);
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
    await logActivity(project_id, dataset_id, 'FleetPerformanceHistory.tsx', 'Fleet Performance History Report', `TWS bin changed to ${value}`);
    // Defer chart update to avoid blocking dropdown response
    requestAnimationFrame(() => {
      setUpdateCharts(true);
    });
  };
  
  const [xAxis, setXAxis] = createSignal<string>(defaultChannelsStore.twsName());
  
  // Filter state - initialize from sessionStorage (session only, not persistent)
  const loadFiltersFromSession = (): void => {
    try {
      const savedFilters = sessionStorage.getItem('performanceFilters');
      if (savedFilters) {
        const filterData = JSON.parse(savedFilters);
        if (filterData.filterGrades) setFilterGrades(filterData.filterGrades);
        if (filterData.filterYear) setFilterYear(filterData.filterYear);
        if (filterData.filterEvent) setFilterEvent(filterData.filterEvent);
        if (filterData.filterConfig) setFilterConfig(filterData.filterConfig);
        if (filterData.filterState) setFilterState(filterData.filterState);
      }
    } catch (error: unknown) {
      logDebug('FleetPerformanceHistory: Error loading filters from sessionStorage:', error as any);
    }
  };
  
  const [filterGrades, setFilterGrades] = createSignal<string>('');
  const [filterYear, setFilterYear] = createSignal<string>('');
  const [filterEvent, setFilterEvent] = createSignal<string>('');
  const [filterConfig, setFilterConfig] = createSignal<string>('');
  const [filterState, setFilterState] = createSignal<string>('');
  
  // Local TRAINING/RACING filter state (not in filterStore - local to this page)
  const [localTrainingRacingFilter, setLocalTrainingRacingFilter] = createSignal<'TRAINING' | 'RACING' | null>(null);
  
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
            signal: [getter, setter] as [() => boolean, (value: boolean) => void]
          };
        })
        .filter(opt => opt !== null);
    });
    
    return options;
  });
  
  // Build filters object from filter values
  type FleetPerformanceHistoryFilters = {
    GRADE?: number[];
    YEAR?: number[];
    EVENT?: string[];
    CONFIG?: string[];
    STATE?: string[];
    SOURCE_NAME?: string[];
    RACE?: (string | number)[];
    LEG?: number[];
  };
  
  const buildFilters = (): FleetPerformanceHistoryFilters | undefined => {
    const filters: FleetPerformanceHistoryFilters = {};
    
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
    
    // Parse state (comma-separated strings)
    if (filterState().trim()) {
      const states = filterState().split(',').map((s: string) => s.trim().toUpperCase()).filter((s: string) => s === 'H0' || s === 'H1' || s === 'H2');
      if (states.length > 0) {
        filters.STATE = states;
      }
    }
    
    // Parse sources from filterStore (array of source names)
    const selectedSources = filterStoreSelectedSources();
    if (Array.isArray(selectedSources) && selectedSources.length > 0) {
      filters.SOURCE_NAME = selectedSources.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0);
    }
    
    // Parse local TRAINING/RACING filter (not from filterStore - local to this page)
    const trFilter = localTrainingRacingFilter();
    if (trFilter === 'TRAINING') {
      filters.RACE = ['TRAINING'];
    } else if (trFilter === 'RACING') {
      // For RACING, we don't set RACE filter - we'll filter out TRAINING in post-processing
      // The data service will fetch all races, then we'll exclude TRAINING (-1) in the data processing
    }
    
    return Object.keys(filters).length > 0 ? filters : undefined;
  };
  
  const [selectedChart, setSelectedChart] = createSignal<any[]>([]);
  const [zoom, setZoom] = createSignal<boolean>(false);

  // Local loading and error states
  const [isLoading, setIsLoading] = createSignal<boolean>(false);
  const [requestError, setRequestError] = createSignal<string | null>(null);

  // Controller for fetching latest dataset date (currently unused)
  // let datesController: AbortController | null = null;

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
      
      // Use filterStore dates (will be empty initially, service will resolve them)
      const currentStartDate = startDate();
      const currentEndDate = endDate();
      
      const filters = buildFilters();
      
      // Fetch aggregates by type (handles AVG, STD, AAV separately and merges)
      // Use fleetPerformanceDataService for fleet data (uses fleet-performance-data endpoint)
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

      // Enrich with local time strings once (before process) so processor does not repeat conversion
      fleetPerformanceDataService.enrichWithLocalTimeStrings(aggregatesAVGData);
      fleetPerformanceDataService.enrichWithLocalTimeStrings(aggregatesSTDData);
      fleetPerformanceDataService.enrichWithLocalTimeStrings(aggregatesAAVData);

      // Process each aggregate type separately
      let processedAVG = aggregatesAVGData.length > 0 
        ? fleetPerformanceDataService.processFleetPerformanceData(aggregatesAVGData, [], targetsData)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      let processedSTD = aggregatesSTDData.length > 0
        ? fleetPerformanceDataService.processFleetPerformanceData(aggregatesSTDData, [], targetsData)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      let processedAAV = aggregatesAAVData.length > 0
        ? fleetPerformanceDataService.processFleetPerformanceData(aggregatesAAVData, [], targetsData)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      
      // Apply local TRAINING/RACING filter (post-processing)
      const trFilter = localTrainingRacingFilter();
      if (trFilter === 'RACING') {
        if (processedAVG.aggregates) {
          processedAVG.aggregates = processedAVG.aggregates.filter((point: any) => {
            const raceNumber = point.race_number ?? point.Race_number;
            if (raceNumber === 'TRAINING' || raceNumber === 'training' || raceNumber === -1 || raceNumber === '-1') {
              return false;
            }
            return true;
          });
        }
        if (processedSTD.aggregates) {
          processedSTD.aggregates = processedSTD.aggregates.filter((point: any) => {
            const raceNumber = point.race_number ?? point.Race_number;
            if (raceNumber === 'TRAINING' || raceNumber === 'training' || raceNumber === -1 || raceNumber === '-1') {
              return false;
            }
            return true;
          });
        }
        if (processedAAV.aggregates) {
          processedAAV.aggregates = processedAAV.aggregates.filter((point: any) => {
            const raceNumber = point.race_number ?? point.Race_number;
            if (raceNumber === 'TRAINING' || raceNumber === 'training' || raceNumber === -1 || raceNumber === '-1') {
              return false;
            }
            return true;
          });
        }
      }
      
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
      logDebug('FleetPerformanceHistory: Data loaded', {
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
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };


  // Note: Groups are updated when initializeCharts() is called (via Apply button)
  // We don't update groups reactively here to avoid triggering updates while modal is open
  // The groups will be filtered by selected sources in initializeCharts() when Apply is clicked

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

  const handleAxisChange = (axis: string): void => {
    // axis is already the correct channel name from defaultChannelsStore (via PerfSettings)
    setXAxis(axis);
    setZoom(false);
    setUpdateCharts(true);
  }

  // Create chart layout based on current x-axis selection (memoized for efficiency)
  const chartGroups = createMemo(() => {
    const chartsData = charts();
    if (!chartsData || chartsData.length === 0) return [];
    
    const { twsName, bspName } = defaultChannelsStore;
    const currentXAxis = xAxis();
    
    // Simply ensure dataField is set for all series (use name if dataField doesn't exist)
    return chartsData.map((group: any) => {
      const series = group.charts[0].series.map((s: any) => {
        // Determine x-axis: use series xaxis if not PAGE DEFAULT, otherwise use global xAxis
        const seriesXAxis = s.xaxis?.name;
        const effectiveXAxis = (seriesXAxis && seriesXAxis !== "PAGE DEFAULT" && seriesXAxis !== "DEFAULT") ? seriesXAxis : currentXAxis;
        
        // Get aggregate types (xType and yType), default to AVG for backward compatibility
        const xType = (s.xType || 'AVG').toUpperCase();
        const yType = (s.yType || 'AVG').toUpperCase();
        
        return {
          ...s,
          xaxisValue: effectiveXAxis, // Store the effective x-axis value for this series
          xType: xType, // Store xType for data selection
          yType: yType, // Store yType for data selection
          yaxis: {
            ...s.yaxis,
            dataField: s.yaxis?.dataField || s.yaxis?.name || ''
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
  });


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
      filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
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
      filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
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
        filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField] ?? (d as any).Twa ?? 0;
          return Math.abs(Number(twaValue)) < 90;
        });
      } else {
        filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField] ?? (d as any).Twa ?? 0;
          return Math.abs(Number(twaValue)) >= 90;
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
      filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
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
      filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
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
        filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField] ?? (d as any).Twa ?? 0;
          return Math.abs(Number(twaValue)) < 90;
        });
      } else {
        filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField] ?? (d as any).Twa ?? 0;
          return Math.abs(Number(twaValue)) >= 90;
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
      filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
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
      filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
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
        filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField] ?? (d as any).Twa ?? 0;
          return Math.abs(Number(twaValue)) < 90;
        });
      } else {
        filteredData = filteredData.filter((d: FleetPerformanceHistoryAggregatePoint) => {
          const twaAvg = (d as any).Twa_deg_avg ?? (d as any).twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa_deg if Twa_deg_avg is missing
          const twaField = defaultChannelsStore.twaName();
          const twaValue = (d as any)[twaField] ?? (d as any).Twa ?? 0;
          return Math.abs(Number(twaValue)) >= 90;
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
      data = data.filter((d: FleetPerformanceHistoryAggregatePoint) => {
        // unifiedDataStore normalizes metadata fields to lowercase, so source_name is already lowercase
        // But also check other case variations in case data hasn't been normalized yet
        const sourceName = d.source_name || d.sourceName || d.SOURCE_NAME || d.Source_name || '';
        const normalizedSource = String(sourceName).toLowerCase().trim();
        const matches = selectedSourcesLower.includes(normalizedSource);
        
        // Debug logging for production issues - log when source doesn't match
        if (!matches && sourceName) {
          logDebug('FleetPerformanceHistory: Source name mismatch in filtering', {
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
        logDebug('FleetPerformanceHistory: Filtered aggregates by selected sources', {
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
        logDebug('FleetPerformanceHistory: No sources selected, showing all aggregates', {
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
      data = data.filter((d: FleetPerformanceHistoryAggregatePoint) => d.event_id && cutEventIds.has(d.event_id));
      
      // Analyze source distribution in filtered result
      const sourceDistribution = data.reduce((acc: Record<string, number>, d: FleetPerformanceHistoryAggregatePoint) => {
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
    
    // Apply client-side filters (STATE, RACE, LEG, GRADE) if any are active
    // Parse STATE filter (comma-separated strings)
    const currentFilterState = filterState();
    const states: string[] = [];
    if (currentFilterState.trim()) {
      const parsedStates = currentFilterState.split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
      states.push(...parsedStates);
    }
    
    // Parse RACE filter from buildFilters (if any)
    const races: (string | number)[] = [];
    const builtFilters = buildFilters();
    if (builtFilters?.RACE && Array.isArray(builtFilters.RACE)) {
      races.push(...builtFilters.RACE);
    }
    
    // Parse LEG filter from buildFilters (if any)
    const legs: (string | number)[] = [];
    if (builtFilters?.LEG && Array.isArray(builtFilters.LEG)) {
      legs.push(...builtFilters.LEG);
    }
    
    // Parse GRADE filter from buildFilters (if any)
    const grades: (string | number)[] = [];
    if (builtFilters?.GRADE && Array.isArray(builtFilters.GRADE)) {
      grades.push(...builtFilters.GRADE);
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
        // Data is normalized to lowercase fields (race_number, leg_number, grade, state) by processFleetPerformanceData
        // passesBasicFilters expects normalized lowercase fields and handles type conversion internally
        return passesBasicFilters(point, fullFilterConfig);
      });
      
      if (beforeCount !== data.length && (states.length > 0 || races.length > 0 || legs.length > 0 || grades.length > 0)) {
        logDebug('FleetPerformanceHistory: Applied client-side filters', {
          beforeCount,
          afterCount: data.length,
          states,
          races,
          legs,
          grades
        });
      }
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
      if (UwDw() === 'UPWIND') {
        data = data.filter((d: FleetPerformanceHistoryAggregatePoint) => Math.abs(d[twaField] ?? d.Twa ?? 0) < 90);
      } else {
        data = data.filter((d: FleetPerformanceHistoryAggregatePoint) => Math.abs(d[twaField] ?? d.Twa ?? 0) >= 90);
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

  const handleColorChange = async (value: string, forceUpdate?: boolean): Promise<void> => {
    if (value === color() && !forceUpdate) return;

    // Compute new groups synchronously so chart has correct groups when it re-renders with new color (avoids white/lightgrey flash)
    const dataForGrouping = aggregates();
    if (!dataForGrouping || dataForGrouping.length === 0) {
      logDebug('FleetPerformanceHistory: handleColorChange - no data available yet, skipping group update');
      return;
    }

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
          logDebug('FleetPerformanceHistory: Sources not ready, triggering refresh');
          sourcesStore.refresh().catch((error) => {
            logWarn('FleetPerformanceHistory: Failed to refresh sources', error);
          });
        }
        
        // Determine which sources to show in legend
        let sourcesToShow: string[] = [];
        
        if (Array.isArray(selectedSources) && selectedSources.length > 0) {
          // If sources are selected, use them directly (even if they don't have data yet)
          sourcesToShow = selectedSources.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0);
        } else {
          // If no sources selected, show all unique sources from data (filter out invalid ones)
          // unifiedDataStore normalizes metadata fields to lowercase, so source_name is already lowercase
          sourcesToShow = [...new Set(
            dataForGrouping
              .map((d: FleetPerformanceHistoryAggregatePoint) => d.source_name)
              .filter((name: any): name is string => name && name !== 'Unknown' && String(name).trim() !== '')
          )].sort();
        }
        
        const scale = colorScale();
        const getColorForSource = (sourceName: any): string => {
          if (scale) {
            const normalizedSource = String(sourceName).toLowerCase();
            return String(scale(normalizedSource));
          }
          return '#1f77b4';
        };
        newGroups = sourcesToShow.length > 0
          ? sourcesToShow.map((sourceName: any) => ({ name: sourceName, color: getColorForSource(sourceName) }))
          : [];
    } else if (value == 'GRADE') {
      newGroups = unique_vals.map((val: any) => {
        const gradeNum = typeof val === 'number' ? val : parseInt(val, 10);
        if (isNaN(gradeNum) || gradeNum === 0 || val == 'NONE') {
          return { name: val, color: 'lightgrey' };
        }
        if (gradeNum === 1) return { name: val, color: 'red' };
        if (gradeNum === 2) return { name: val, color: 'green' };
        if (gradeNum === 3) return { name: val, color: 'yellow' };
        return { name: val, color: String(S20colorScale(String(gradeNum))) };
      });
    } else {
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
      let c = 0;
      newGroups = unique_vals.map((val: any) => {
        if (value === 'RACE' && (val === 'TRAINING' || val === -1 || val === '-1')) {
          return { name: 'TRAINING', color: 'lightgrey' };
        }
        if (val == 'NONE' || val == null || val == undefined || val === '') {
          return { name: val, color: 'lightgrey' };
        }
        const color = String(S20colorScale(String(c)));
        c += 1;
        return { name: val, color };
      });
    }

    batch(() => {
      setGroups(newGroups);
      setColor(value);
    });

    if (!forceUpdate) {
      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
      await logActivity(project_id, dataset_id, 'FleetPerformanceHistory.tsx', 'Fleet Performance History Report', `Color changed to ${value}`);
    }
    requestAnimationFrame(() => {
      setUpdateCharts(true);
    });
  };

  // Track last source selection to detect changes
  let lastSourceSelection: string[] | null = null; // null means initial state, not yet set
  let isRefetching = false;
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
    
    logDebug('FleetPerformanceHistory: Source selection changed, refetching data', {
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
      logError('FleetPerformanceHistory: Error refetching data after source change', error as any);
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
      logDebug('FleetPerformanceHistory: Updated groups due to source selection change', {
        selectedSourcesCount: selectedSources.length,
        selectedSources: selectedSources
      });
    }
  });

  // Update group colors when color scale becomes available
  let lastGroupsSignature = '';
  let groupsEffectCount = 0;
  createEffect(() => {
    groupsEffectCount++;
    
    // Detect infinite loops
    if (groupsEffectCount > 50) {
      logError('🚨 INFINITE LOOP DETECTED in FleetPerformanceHistory groups color effect!', groupsEffectCount);
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
        const correctColor = String(scale(normalizedSource));
        return !g.color || g.color === '#1f77b4' || g.color !== correctColor;
      });
      
      if (needsUpdate) {
        logDebug('FleetPerformanceHistory: Updating group colors from sources', {
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
        const groupsSignature = updatedGroups.map((g: { name: string; color: string }) => `${g.name}:${g.color}`).join('|');
        const currentSignature = groupsSignature;
        
        // Only update if the signature actually changed
        if (currentSignature !== lastGroupsSignature) {
          lastGroupsSignature = currentSignature;
          setGroups(updatedGroups);
          logDebug('FleetPerformanceHistory: Updated groups with source colors', {
            updatedGroups: updatedGroups.map(g => ({ name: g.name, color: g.color }))
          });
        }
      }
    }
    
    // Reset count after processing
    groupsEffectCount = 0;
  });

  // Set timezone when date range changes (for fleet mode)
  // Use startDate to get a representative dataset timezone
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const currentStartDate = startDate();
    
    if (!className || !projectId || !currentStartDate) {
      await setCurrentDataset(className || '', projectId || 0, null);
      return;
    }

    try {
      // Get timezone for startDate using the dedicated endpoint
      const ymd = String(currentStartDate).replace(/[-/]/g, '');
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
        logDebug('FleetPerformanceHistory: Set timezone from date endpoint', {
          datasetId: datasetId,
          timezone: tz,
          startDate: currentStartDate
        });
      } else {
        // No timezone found for this date, clear timezone
        await setCurrentDataset(className, projectId, null);
      }
    } catch (error: unknown) {
      logDebug('FleetPerformanceHistory: Error setting timezone', error as any);
      await setCurrentDataset(className, projectId, null);
    }
  });

  // Handle date range save - refetch data with new dates
  const handleSaveDateRange = async (newStartDate: string, newEndDate: string): Promise<void> => {
    log('Fleet Performance: Date range saved, refetching data', { newStartDate, newEndDate });
    
    // Update filterStore with new dates first
    setStartDate(newStartDate);
    setEndDate(newEndDate);

    // Save to persistent settings
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
              performanceHistoryDateRange: {
                startDate: newStartDate,
                endDate: newEndDate
              }
            }
          );
          logDebug('FleetPerformanceHistory: Saved date range to persistent settings', {
            startDate: newStartDate,
            endDate: newEndDate
          });
        }
      } catch (error: unknown) {
        logDebug('FleetPerformanceHistory: Error saving date range to persistent settings:', error as any);
      }
    }
    
    setLoading(true);
    setIsLoading(true);
    setRequestError(null);
    
    try {
      setUpdateCharts(false);
      
      const currentCharts = charts();
      if (!currentCharts || currentCharts.length === 0) {
        // If no charts, initialize them first
        // Preserve current target when initializing charts
        const currentTargetName = targets()?.name;
        const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
        await initializeCharts(targetToPreserve);
        return;
      }
      
      const channels = fleetPerformanceDataService.getRequiredChannels(currentCharts);
      
      const filters = buildFilters();
      
      // Fetch aggregates with new date range (service will check cache and fetch missing dates)
      const aggregatesData = await fleetPerformanceDataService.fetchAggregates(
        channels, 
        'AVG',
        newStartDate || undefined, 
        newEndDate || undefined,
        filters
      );

      fleetPerformanceDataService.enrichWithLocalTimeStrings(aggregatesData);
      
      // Process and set the data
      const processedData = fleetPerformanceDataService.processFleetPerformanceData(aggregatesData, [], targets());
      setAggregates(processedData.aggregates);
      
      // Initialize groups based on current color selection and loaded data
      handleColorChange(color());
      
      setUpdateCharts(true);
    } catch (err: unknown) {
      logError('Error refetching fleet performance data with new date range:', err as any);
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };



  // Save sources to persistent settings
  const saveSourcesToPersistentSettings = async (sourceNames: string[]): Promise<void> => {
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
            { fleetPerformanceSources: sourceNames }
          );
          logDebug('FleetPerformanceHistory: Saved sources to persistent settings', sourceNames);
        }
      } catch (error: unknown) {
        logDebug('FleetPerformanceHistory: Error saving sources to persistent settings:', error as any);
      }
    }
  };

  // Load date range from persistent settings
  const loadDateRangeFromPersistentSettings = async (): Promise<boolean> => {
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

          if (settings?.performanceHistoryDateRange) {
            const dateRange = settings.performanceHistoryDateRange;
            if (dateRange.startDate && dateRange.endDate) {
              setStartDate(dateRange.startDate);
              setEndDate(dateRange.endDate);
              logDebug('FleetPerformanceHistory: Loaded date range from persistent settings', {
                startDate: dateRange.startDate,
                endDate: dateRange.endDate
              });
              return true;
            }
          }
        }
      } catch (error) {
        logDebug('FleetPerformanceHistory: Error loading date range from persistent settings:', error);
      }
    }
    return false;
  };

  // Initialize default date range (1 year back from latest data, source_id=0 for fleet)
  const initializeDefaultDateRange = async (): Promise<void> => {
    try {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();

      if (!className || !projectId) {
        logDebug('FleetPerformanceHistory: Cannot initialize default date range - missing required values');
        return;
      }

      // For fleet pages, use source_id=0
      const controller = new AbortController();
      const result = await getData(
        `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=0`,
        controller.signal
      );

      if (result.success && result.data) {
        const dateStr = result.data;
        const endDateValue = new Date(dateStr);
        const startDateValue = new Date(endDateValue.getTime());
        // Set start date to 1 year (365 days) before end date
        startDateValue.setDate(startDateValue.getDate() - 365);

        // Format as YYYY-MM-DD
        const formatDate = (date: Date): string => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        };

        const formattedEndDate = formatDate(endDateValue);
        const formattedStartDate = formatDate(startDateValue);

        // Set in filterStore
        setStartDate(formattedStartDate);
        setEndDate(formattedEndDate);

        // Save to persistent settings
        const currentUser = user();
        if (currentUser?.user_id) {
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            {
              performanceHistoryDateRange: {
                startDate: formattedStartDate,
                endDate: formattedEndDate
              }
            }
          );
          logDebug('FleetPerformanceHistory: Initialized and saved default date range (1 year)', {
            startDate: formattedStartDate,
            endDate: formattedEndDate
          });
        }
      } else {
        logDebug('FleetPerformanceHistory: Failed to fetch last_date for default date range');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      logError('FleetPerformanceHistory: Error initializing default date range:', err);
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
          return dateB - dateA;
        });
        
        // Extract target names
        sorted.forEach((target: any) => {
          if (target.name && !targets.includes(target.name)) {
            targets.push(target.name);
          }
        });
      }
      
      return targets;
    } catch (error: unknown) {
      logError('Error fetching available targets:', error as any);
      return ['No Target'];
    }
  };

  // Fetch target data for a specific target name
  const fetchTargetData = async (targetName: string): Promise<FleetPerformanceHistoryTargetData> => {
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
          logDebug('FleetPerformanceHistory: Successfully fetched target data', {
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
      
      logWarn('FleetPerformanceHistory: Failed to fetch target data with any name format', {
        targetName,
        triedNames: namesToTry
      });
      return { name: '', data: {} };
    } catch (error: unknown) {
      logError('Error fetching target data:', error as any);
      return { name: '', data: {} };
    }
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

  // Handle target click - open modal
  const handleTargetClick = async () => {
    logDebug('FleetPerformanceHistory: handleTargetClick called');
    setShowTargetModal(true);
    logDebug('FleetPerformanceHistory: showTargetModal set to true');
    const targetsList = await fetchAvailableTargets();
    setAvailableTargets(targetsList);
    // Default to current target name, or "No Target" if no target is set
    const currentTarget = targets();
    const currentTargetName = currentTarget?.name || 'No Target';
    setSelectedTargetName(currentTargetName);
    logDebug('FleetPerformanceHistory: Modal should be visible now', { showTargetModal: showTargetModal(), availableTargets: targetsList.length });
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
          logDebug('FleetPerformanceHistory: Saved target to persistent settings', targetName);
        }
      } catch (error: unknown) {
        logDebug('FleetPerformanceHistory: Error saving target to persistent settings:', error as any);
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
            logDebug('FleetPerformanceHistory: Loaded target from persistent settings', cleanedTarget);
            return cleanedTarget;
          }
        }
      } catch (error: unknown) {
        logDebug('FleetPerformanceHistory: Error loading target from persistent settings:', error as any);
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
      logDebug('FleetPerformanceHistory: Saved target to sessionStorage', targetName);
    } catch (error: unknown) {
      logDebug('FleetPerformanceHistory: Error saving target to sessionStorage:', error as any);
    }
  };

  // Load target name from sessionStorage (session persistence)
  const loadTargetFromSessionStorage = (): string | null => {
    try {
      const savedTarget = sessionStorage.getItem('performanceTarget');
      if (savedTarget) {
        const targetData = JSON.parse(savedTarget);
        if (targetData.targetName && typeof targetData.targetName === 'string') {
          logDebug('FleetPerformanceHistory: Loaded target from sessionStorage', targetData.targetName);
          return targetData.targetName;
        }
      }
    } catch (error: unknown) {
      logDebug('FleetPerformanceHistory: Error loading target from sessionStorage:', error as any);
    }
    return null;
  };

  // Fetch last known project_object with object_name 'target' (used when no saved target)
  const fetchLastKnownTargetNameFromProject = async (): Promise<string | null> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      if (!className || !projectId) return null;
      const res = await getData(
        `${apiEndpoints.app.projects}/object/latest?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&object_name=target`
      );
      if (!res?.success || !res.data || (res as any).statusCode === 204) return null;
      const data = res.data as { json?: unknown };
      const raw = data?.json;
      if (raw == null) return null;
      const obj = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
      if (!obj || typeof obj !== 'object') return null;
      const arr = Array.isArray(obj) ? obj : [obj];
      const first = arr[0];
      const name = first?.name ?? (first as { name_target?: string })?.name_target;
      if (name && typeof name === 'string' && name.trim()) {
        logDebug('FleetPerformanceHistory: Fetched last known target name from project_objects', name.trim());
        return name.trim();
      }
    } catch (e) {
      logDebug('FleetPerformanceHistory: Error fetching last known target from project:', e);
    }
    return null;
  };

  // Handle target selection from modal
  const handleTargetSelect = async () => {
    const targetName = selectedTargetName();
    
    if (!targetName || targetName === 'No Target') {
      // Clear target
      setTargets({ name: '', data: {} });
      setUpdateCharts(true); // Trigger chart redraw
      logDebug('FleetPerformanceHistory: Cleared target (No Target selected)');
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
      logError('FleetPerformanceHistory: Failed to fetch target data for selected target', {
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
    logDebug(`FleetPerformanceHistory: Selected target "${targetName}"`, {
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

  onMount(() => {
    // 1. Set defaults immediately so UI can render
    // Set default color options
    setColors(['SOURCE_NAME', 'GRADE', 'EVENT', 'CONFIG', 'YEAR', 'STATE']); // Fallback defaults
    
    // Load filters from sessionStorage (synchronous, fast)
    loadFiltersFromSession();

    // Default year/event from dataset selection when not ALL (leave empty if ALL)
    const dsYear = selectedYear();
    const dsEvent = selectedEvent();
    if ((!filterYear() || filterYear().trim() === '') && dsYear != null && String(dsYear).trim() !== '' && String(dsYear).trim().toUpperCase() !== 'ALL') {
      setFilterYear(String(dsYear).trim());
    }
    if ((!filterEvent() || filterEvent().trim() === '') && dsEvent != null && String(dsEvent).trim() !== '' && String(dsEvent).trim().toUpperCase() !== 'ALL') {
      setFilterEvent(String(dsEvent).trim());
    }
    
    // Set default grade filter to "2,3" if not already set
    if (!filterGrades() || filterGrades().trim() === '') {
      setFilterGrades('2,3');
      logDebug('FleetPerformanceHistory: Set default grade filter to 2,3');
    }
    
    // Set default state filter to "H0" if not already set
    if (!filterState() || filterState().trim() === '') {
      setFilterState('H0');
      logDebug('FleetPerformanceHistory: Set default state filter to H0');
    }
    
    // Initialize date range with defaults (will be updated from persistent settings in background)
    if (!startDate() || !endDate()) {
      initializeDateRange().catch(err => logError('FleetPerformanceHistory: Error initializing default date range:', err));
    }
    
    // 2. Load actual values in background (don't await)
    // We'll initialize charts after target is loaded to preserve it
    (async () => {
      try {
        // Load grade/state from project default first (overrides sessionStorage defaults if present)
        let className = selectedClassName();
        let projectId = selectedProjectId();
        for (let i = 0; i < 30 && (!className || !projectId); i++) {
          await new Promise(r => setTimeout(r, 100));
          className = selectedClassName();
          projectId = selectedProjectId();
        }
        const projectFilters = (className && projectId) ? await getProjectPerformanceFilters(className, projectId, '1970-01-01') : null;
        if (projectFilters === null) {
          const currentUser = user();
          if (currentUser?.user_id && className && projectId) {
            try {
              const settings = await persistentSettingsService.loadSettings(
                currentUser.user_id,
                className,
                projectId
              );
              if (settings?.performanceFilters) {
                const filters = settings.performanceFilters;
                if (filters.grades != null && typeof filters.grades === 'string' && filters.grades !== '') {
                  setFilterGrades(cleanQuotes(filters.grades));
                  logDebug('FleetPerformanceHistory: Loaded grade filter from persistent settings', filters.grades);
                }
                if (filters.state != null && typeof filters.state === 'string' && filters.state !== '') {
                  setFilterState(cleanQuotes(filters.state));
                  logDebug('FleetPerformanceHistory: Loaded state filter from persistent settings', filters.state);
                }
              }
            } catch (err) {
              logDebug('FleetPerformanceHistory: Error loading grade/state from persistent settings', err);
            }
          }
        }

        // Set in-report defaults first (when none are set)
        if (!filterGrades() || filterGrades().trim() === '') {
          setFilterGrades('2,3');
          logDebug('FleetPerformanceHistory: Set default grade filter to 2,3');
        }
        if (!filterState() || filterState().trim() === '') {
          setFilterState('H0');
          logDebug('FleetPerformanceHistory: Set default state filter to H0');
        }

        // Apply project filters on top (overrides defaults; empty string means "no filter")
        if (projectFilters !== null) {
          if (projectFilters.grades !== undefined) {
            setFilterGrades(cleanQuotes(projectFilters.grades ?? ''));
            logDebug('FleetPerformanceHistory: Applied grade filter from project default', projectFilters.grades);
          }
          if (projectFilters.state !== undefined) {
            setFilterState(cleanQuotes(projectFilters.state ?? ''));
            logDebug('FleetPerformanceHistory: Applied state filter from project default', projectFilters.state);
          }
        }

        // Load color options from filter config (background)
        const colorOptions = await UnifiedFilterService.getColorOptions(
          selectedClassName(),
          'fleet',
          selectedProjectId()
        );
        if (colorOptions && colorOptions.length > 0) {
          // Add STATE to color options (it's a calculated field, not in filter config)
          const optionsWithState = [...colorOptions];
          if (!optionsWithState.includes('STATE')) {
            optionsWithState.push('STATE');
          }
          setColors(optionsWithState);
        }
      } catch (error: unknown) {
        logError('Error loading color options:', error as any);
        // Keep defaults
      }
      
      // Filters are loaded from sessionStorage only (session persistence, not saved to user settings)
      
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
          const targetData = await fetchTargetData(matchingTargetName);
          setTargets(targetData);
          logDebug(`FleetPerformanceHistory: Loaded saved target "${matchingTargetName}" from persistent settings (matched from "${cleanedTargetName}")`);
        } else {
          logDebug(`FleetPerformanceHistory: Saved target "${cleanedTargetName}" no longer exists, skipping load`);
        }
      }
      // When no saved target, use last known project_object with object_name 'target'
      if (!targetNameToPreserve) {
        const lastKnownName = await fetchLastKnownTargetNameFromProject();
        if (lastKnownName) {
          const targetsList = await fetchAvailableTargets();
          const matchingTargetName = findMatchingTarget(lastKnownName, targetsList);
          if (matchingTargetName) {
            const targetData = await fetchTargetData(matchingTargetName);
            setTargets(targetData);
            targetNameToPreserve = matchingTargetName;
            logDebug('FleetPerformanceHistory: Using last known project target (object_name=target)', matchingTargetName);
          }
        }
      }
      
      // Load sources from persistent settings or default to first 6 (background)
      const currentSelectedSources = filterStoreSelectedSources();
      if (currentSelectedSources.length === 0) {
        const initialSources = await initializeSourceSelections();
        if (initialSources.length > 0) {
          filterStoreSetSelectedSources(initialSources);
          logDebug('FleetPerformanceHistory: Initialized sources', initialSources);
        }
      }
      
      // Load date range from persistent settings (background)
      const hasSavedDateRange = await loadDateRangeFromPersistentSettings();
      
      // If no saved date range, initialize default (1 year back from latest data, source_id=0)
      if (!hasSavedDateRange) {
        await initializeDefaultDateRange();
      }
      
      // If still no dates set, fall back to initializeDateRange (30-day range)
      if (!startDate() || !endDate()) {
        await initializeDateRange();
      }
      
      // Initialize charts after target and date range are loaded
      // Preserve the target that was loaded from persistent settings, or current target if set
      const targetToPreserve = targetNameToPreserve || (targets()?.name && targets()?.name !== '' ? targets()?.name : undefined);
      initializeCharts(targetToPreserve).catch(err => logError('FleetPerformanceHistory: Error initializing charts after target/date range load:', err));
      
      // Log page load (background)
      logPageLoad('FleetPerformance.jsx', 'Fleet Performance Analysis Report').catch(err => logError('FleetPerformanceHistory: Error logging page load:', err));
    })();
    
    // Set up dynamic scaling for media-container using the global utility
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'FleetPerformance-History',
      scaleToWidth: true
    });
    
    // Keyboard shortcuts for selection management
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Only handle shortcuts if not typing in an input/textarea
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      
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
          // Clear selectedEvents and selectedRanges FIRST to prevent cutSelection() from fetching time ranges
          // Then set cutEvents to event IDs (for performance chart filtering only, not map selection)
          setSelectedEvents([]);
          setSelectedRanges([]);
          setSelection([]);
          setHasSelection(false);
          // Set cutEvents to event IDs - these will be used for filtering performance charts only
          setCutEvents(currentSelected);
          setIsCut(true);
          setTriggerUpdate(true);
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
  onCleanup(() => {
    // Cleanup timeout
    if (initializationTimeout) {
      clearTimeout(initializationTimeout);
      initializationTimeout = null;
    }
    // No timesController needed since we don't fetch event times
    // datesController is currently unused but kept for future use
    // if (datesController) {
    //   datesController.abort();
    // }
    
    // Clear data signals to free memory
    setAggregatesAVG([]);
    setAggregatesSTD([]);
    setAggregatesAAV([]);
    setAggregates([]);
    setTargets({ name: '', data: {} });
    setCharts([]);
    setGroups([]);
    
    logDebug('FleetPerformanceHistory: Cleanup complete - data cleared');
  });

  const handleLegendClick = (legendItem: string): void => {
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
    
    // Map color field names to actual data field names
    const getFieldName = (colorField: string): string => {
      const fieldMap: Record<string, string> = {
        'TACK': 'TACK',
        'GRADE': 'GRADE',
        'MAINSAIL': 'MAINSAIL',
        'HEADSAIL': 'HEADSAIL',
        'RACE': 'RACE',
        'LEG': 'LEG',
        'CONFIG': 'CONFIG',
        'YEAR': 'YEAR',
        'EVENT': 'EVENT',
        'SOURCE_NAME': 'source_name', // Processed data has both source_name (lowercase) and SOURCE_NAME (uppercase)
        'STATE': 'State' // Use the actual State field from data (e.g., H0, H1, H2)
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
        dataSource = fullAggregates.filter((d: FleetPerformanceHistoryAggregatePoint) => Math.abs(d[twaField] ?? d.Twa ?? 0) < 90);
      } else {
        dataSource = fullAggregates.filter((d: FleetPerformanceHistoryAggregatePoint) => Math.abs(d[twaField] ?? d.Twa ?? 0) >= 90);
      }
    }
    
    const legendEntryIds = dataSource
      .filter((a: FleetPerformanceHistoryAggregatePoint) => {
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
          // Try multiple field name variations for state
          const stateValue = fieldValue !== undefined && fieldValue !== null 
            ? String(fieldValue) 
            : (a.State !== undefined && a.State !== null ? String(a.State) : (a.state !== undefined && a.state !== null ? String(a.state) : null));
          if (stateValue) {
            return stateValue.toLowerCase() === clickedItemLower;
          }
          return false;
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
      .map((a: FleetPerformanceHistoryAggregatePoint) => a.event_id)
      .filter((id): id is number => id !== undefined && id !== null && !isNaN(Number(id)));

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

  // Fallback: clear mode-switching overlay after 3s if chart never reports rendered
  createEffect(() => {
    if (!modeSwitching()) return;
    const t = setTimeout(() => setModeSwitching(false), 3000);
    return () => clearTimeout(t);
  });

  // Note: We do NOT fetch event times for map selection in performance pages
  // Cutting should only filter the displayed performance data, not create map selections
  // The getFilteredAggregates() function handles filtering by cutEvents

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
              colorOptions={colors()}
              selectedColor={() => color()}
              onColorChange={handleColorChange}
              cloudDataOptions={[]}
              selectedXAxis={() => xAxis()}
              onXAxisChange={(axis) => handleAxisChange(axis)}
              showTimeline={() => showTimeline()}
              onTimelineChange={handleTimelineChange}
              selectedCloudData={() => 'None'}
              onCloudDataChange={() => { /* no cloud options in project/all */ }}
              onSaveDateRange={handleSaveDateRange}
              dataSourcesOptions={dataSourcesOptions()}
              filterGrades={() => filterGrades()}
              onFilterGradesChange={(value) => {
                setFilterGrades(value);
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
                handleColorChange(color(), true);
                setUpdateCharts(true);
              }}
              onApplyFilters={async () => {
                logDebug('FleetPerformanceHistory: onApplyFilters - sources may have changed, refetching data');
                const currentTargetName = targets()?.name;
                const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
                await initializeCharts(targetToPreserve);
                handleColorChange(color(), true);
                setUpdateCharts(true);
              }}
              selectedTrainingRacing={() => localTrainingRacingFilter()}
              onTrainingRacingFilterChange={(type) => {
                setLocalTrainingRacingFilter(type);
              }}
              selectedPlotType={() => plotType()}
              onPlotTypeChange={handlePlotTypeChange}
              showDataTable={true}
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
                    color={color()}
                    filterSummary={<PerformanceFilterSummary filterGrades={filterGrades()} filterState={filterState()} trainingRacing={localTrainingRacingFilter()} />}
                  />
                </div>
              </Show>
            </div>
              {/* Timeline component */}
              <Show when={showTimeline()}>
                <div style="width: 100%; min-width: 0; height: 88px; margin-top: 10px;">
                  <ScatterTimeseries
                    key={`timeline-${updateCharts()}-${localTrainingRacingFilter() || 'all'}-${aggregatesAVG().length}`}
                    aggregates={aggregatesAVG()}
                    color={color()}
                    groups={groups()}
                    colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
                    isHistoryPage={true}
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
                                  color={color()}
                                  groups={groups()}
                                  cloud={(series.xType || 'AVG').toUpperCase() === 'AVG' && (series.yType || 'AVG').toUpperCase() === 'AVG' ? [] : []}
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
                                  colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
                                  onDataUpdate={() => initializeCharts(selectedTargetName())}
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
                                  uppercaseGroupInTooltip={color() === 'SOURCE_NAME'}
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
          <div class="zoom-container" style={{ "min-height": showTimeline() ? "700px" : "800px", "margin-top": "50px" }}>
            <div class="flex w-full h-full" style={{ height: showTimeline() ? "700px" : "800px", width: "calc(100% - 25px)" }}>
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
                  cloud={[]}
                  targets={getFilteredTargets()}
                  uwDw={UwDw()}
                  updateCharts={updateCharts()}
                  color={color()}
                  groups={groups()}
                  mouseID={mouseID()}
                  setMouseID={setMouseID}
                  aggregate={selectedChart()[6] || 'AVG'}
                  handleZoom={handleZoom}
                  zoom={zoom()}
                  selectedEvents={selectedEvents()}
                  hasCutData={cutEvents().length > 0}
                  selectedSource={selectedSource() || undefined}
                  colorScale={colorScale() ? ((source: string) => String(colorScale()!(source))) : undefined}
                  onDataUpdate={() => initializeCharts(selectedTargetName())}
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
