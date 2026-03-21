import { onMount, onCleanup, createSignal, For, Show, createEffect, createMemo, batch } from "solid-js";
import { Portal } from "solid-js/web";

import AdvancedScatter from "../../../../../components/charts/AdvancedScatter";
import BoxPlot from "../../../../../components/charts/BoxPlot";
import ScatterTimeseries from "../../../../../components/charts/ScatterTimeseries";

import Legend from "../../../../../components/legends/Performance";
import PerformanceFilterSummary from "../../../../../components/legends/PerformanceFilterSummary";
import Loading from "../../../../../components/utilities/Loading";
import DropDownButton from "../../../../../components/buttons/DropDownButton";
import PerfSettings from "../../../../../components/menus/PerfSettings";

import { groupBy, getData, setupMediaContainerScaling, cleanQuotes } from "../../../../../utils/global";
import { tooltip } from "../../../../../store/globalStore";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../../utils/logging";
import { log, debug as logDebug, error as logError } from "../../../../../utils/console";
import { selectedEvents, cutEvents, clearSelection, cutSelection, hideSelectedEvents, setSelectedEvents } from "../../../../../store/selectionStore";
import { startDate, endDate, setStartDate, setEndDate, initializeDateRange, selectedRacesAggregates, selectedLegsAggregates } from "../../../../../store/filterStore";

import { performanceDataService } from "../../../../../services/performanceDataService";
import { fleetPerformanceDataService } from "../../../../../services/fleetPerformanceDataService";
import { persistantStore } from "../../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { user } from "../../../../../store/userStore";
import { persistentSettingsService } from "../../../../../services/persistentSettingsService";
import UnifiedFilterService from "../../../../../services/unifiedFilterService";
import { getColorByIndex, resolveDataField } from "../../../../../utils/colorScale";
import { defaultChannelsStore } from "../../../../../store/defaultChannelsStore";
import type { PerformanceAggregatePoint, PerformanceTargetData } from "../../../../../store/dataTypes";
const { selectedClassName, selectedProjectId, selectedSourceId, selectedYear, selectedEvent } = persistantStore;

export default function PerformancePage() {
  // Local state for performance data - separate by aggregate type
  const [aggregatesAVG, setAggregatesAVG] = createSignal<PerformanceAggregatePoint[]>([]);
  const [aggregatesSTD, setAggregatesSTD] = createSignal<PerformanceAggregatePoint[]>([]);
  const [aggregatesAAV, setAggregatesAAV] = createSignal<PerformanceAggregatePoint[]>([]);
  // Keep aggregates for backward compatibility (will be set to aggregatesAVG)
  const [aggregates, setAggregates] = createSignal<PerformanceAggregatePoint[]>([]);
  const [targets, setTargets] = createSignal<PerformanceTargetData>({ name: '', data: {} });
  const [showTargetModal, setShowTargetModal] = createSignal(false);
  const [availableTargets, setAvailableTargets] = createSignal<string[]>([]);
  const [selectedTargetName, setSelectedTargetName] = createSignal('');
  const [charts, setCharts] = createSignal<any[]>([]);

  // Local state for UI management only (no selection state)

  // Get color options from filter config (source context)
  const [colors, setColors] = createSignal<string[]>([]); // Start empty, will be populated from filter config
  onMount(() => {
    // 1. Set defaults immediately so UI can render
    setColors(['TACK', 'GRADE', 'STATE']); // Fallback defaults
    
    // 2. Load actual values in background (don't await)
    (async () => {
      try {
        // Explicitly call getFilterConfig to ensure caching happens (background)
        UnifiedFilterService.getFilterConfig(
          selectedClassName(),
          'source',
          selectedProjectId()
        ).catch(err => logDebug('PerformanceHistory: Error loading filter config in background:', err));
        
        const colorOptions = await UnifiedFilterService.getColorOptions(
          selectedClassName(),
          'source',
          selectedProjectId()
        );
        
        if (colorOptions && colorOptions.length > 0) {
          // Add STATE to color options (it's a calculated field, not in filter config)
          const optionsWithState = [...colorOptions];
          if (!optionsWithState.includes('STATE')) {
            optionsWithState.push('STATE');
          }
          setColors(optionsWithState);
          // Set default color to first option if not already set
          if (color() === 'TACK' && colorOptions.length > 0) {
            // Only change if still on default TACK
            if (colorOptions.includes('TACK')) {
              setColor('TACK');
            } else {
              setColor(colorOptions[0]);
            }
          }
        } else {
          // No color options found, keep defaults
          logDebug('PerformanceHistory: No color options found, using defaults');
        }
      } catch (error) {
        logError('Error loading color options:', error);
        // Keep defaults on error
      }
    })();
  });
  const [groups, setGroups] = createSignal([{ 'name': 'PORT', 'color': "#d62728" }, { 'name': 'STBD', 'color': "#2ca02c" }]);

  const [showUwDw, setShowUwDw] = createSignal(true);
  const [loading, setLoading] = createSignal(true);
  const [updateCharts, setUpdateCharts] = createSignal(true);
  const [mouseID, setMouseID] = createSignal(null);

  const [color, setColor] = createSignal("TACK");
  const [UwDw, setUwDw] = createSignal("UPWIND");
  /** True while charts are re-rendering after upwind/downwind (or plot type) switch; used to show overlay. */
  const [modeSwitching, setModeSwitching] = createSignal(false);

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
    // Clear selection when switching between upwind and downwind
    clearSelection();
    setUpdateCharts(true);
  };
  
  // Plot type state (Scatter or Box)
  const [plotType, setPlotType] = createSignal<string>("Scatter");
  
  // TWS bin state for box plot mode
  const [twsBin, setTwsBin] = createSignal<string>("ALL");

  // Timeline visibility state
  const [showTimeline, setShowTimeline] = createSignal<boolean>(true);

  // Handler for timeline changes
  const handleTimelineChange = (value: boolean) => {
    setShowTimeline(value);
  };

  // Local TRAINING/RACING filter state (not in filterStore - local to this page)
  const [localTrainingRacingFilter, setLocalTrainingRacingFilter] = createSignal<'TRAINING' | 'RACING' | null>(null);
  const [twsBinOptions, setTwsBinOptions] = createSignal<string[]>(["ALL"]);
  
  // Handle plot type changes
  const handlePlotTypeChange = (value: string) => {
    setPlotType(value);
    // Reset TWS bin to "ALL" when switching to Scatter mode
    if (value === "Scatter") {
      setTwsBin("ALL");
    }
    setUpdateCharts(true);
  };
  
  // Handle TWS bin changes
  const handleTwsBinChange = async (value: string) => {
    setTwsBin(value);
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'PerformanceHistory.tsx', 'Performance History Report', `TWS bin changed to ${value}`);
    setUpdateCharts(true);
  };
  
  const [xAxis, setXAxis] = createSignal(defaultChannelsStore.twsName());

  // Filter state - initialize from sessionStorage (session only, not persistent) - same as FleetPerformanceHistory
  const loadFiltersFromSession = () => {
    try {
      const savedFilters = sessionStorage.getItem('performanceFilters');
      if (savedFilters) {
        const filterData = JSON.parse(savedFilters);
        if (filterData.filterGrades) setFilterGrades(cleanQuotes(String(filterData.filterGrades)));
        if (filterData.filterYear) setFilterYear(cleanQuotes(String(filterData.filterYear)));
        if (filterData.filterEvent) setFilterEvent(cleanQuotes(String(filterData.filterEvent)));
        if (filterData.filterConfig) setFilterConfig(cleanQuotes(String(filterData.filterConfig)));
        if (filterData.filterState) setFilterState(cleanQuotes(String(filterData.filterState)));
      }
    } catch (error) {
      // Ignore errors
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
              setStartDate(cleanQuotes(String(dateRange.startDate)));
              setEndDate(cleanQuotes(String(dateRange.endDate)));
              logDebug('PerformanceHistory: Loaded date range from persistent settings', {
                startDate: cleanQuotes(String(dateRange.startDate)),
                endDate: cleanQuotes(String(dateRange.endDate))
              });
              return true;
            }
          }
        }
      } catch (error) {
        logDebug('PerformanceHistory: Error loading date range from persistent settings:', error);
      }
    }
    return false;
  };

  // Initialize default date range (1 year back from latest data)
  const initializeDefaultDateRange = async (): Promise<void> => {
    try {
      const { selectedClassName, selectedProjectId, selectedSourceId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const sourceId = selectedSourceId();

      if (!className || !projectId || sourceId === undefined) {
        logDebug('PerformanceHistory: Cannot initialize default date range - missing required values');
        return;
      }

      const controller = new AbortController();
      const result = await getData(
        `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}`,
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
          logDebug('PerformanceHistory: Initialized and saved default date range (1 year)', {
            startDate: formattedStartDate,
            endDate: formattedEndDate
          });
        }
      } else {
        logDebug('PerformanceHistory: Failed to fetch last_date for default date range');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      logError('PerformanceHistory: Error initializing default date range:', err);
    }
  };

  const [filterGrades, setFilterGrades] = createSignal('');
  const [filterYear, setFilterYear] = createSignal('');
  const [filterEvent, setFilterEvent] = createSignal('');
  const [filterConfig, setFilterConfig] = createSignal('');
  const [filterState, setFilterState] = createSignal('');

  // Build filters object from filter values
  const buildFilters = (): Record<string, any[]> | undefined => {
    const filters: Record<string, any[]> = {};

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

    // Parse state (comma-separated strings)
    if (filterState().trim()) {
      const states = filterState().split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
      if (states.length > 0) {
        filters.STATE = states;
      }
    }

    // Parse races from filterStore (for day/dataset mode race filters or history mode TRAINING/RACING)
    const races = selectedRacesAggregates();
    if (Array.isArray(races) && races.length > 0) {
      // Convert to array of strings/numbers, handling TRAINING
      filters.RACE = races.map((r: any) => {
        if (r === 'TRAINING' || r === 'training' || r === -1 || r === '-1') {
          return 'TRAINING';
        }
        const num = Number(r);
        return isNaN(num) ? String(r) : num;
      });
    }

    // Parse legs from filterStore (for day/dataset mode)
    const legs = selectedLegsAggregates();
    if (Array.isArray(legs) && legs.length > 0) {
      filters.LEG = legs.map((l: any) => Number(l)).filter((l: number) => !isNaN(l));
    }

    const result = Object.keys(filters).length > 0 ? filters : undefined;
    logDebug('PerformanceHistory: buildFilters result:', {
      hasFilters: !!result,
      filterGrades: filterGrades(),
      filterYear: filterYear(),
      filterEvent: filterEvent(),
      filterConfig: filterConfig(),
      builtFilters: result ? JSON.stringify(result) : 'none'
    });
    return result;
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
    // Only clear targets if we're not preserving a specific target
    if (!preserveTargetName) {
      setTargets({ name: '', data: {} });
    }

    try {
      setUpdateCharts(false);

      // Get chart objects first to determine required channels
      const chartObjects = await performanceDataService.fetchCharts();
      setCharts(chartObjects as any[]);

      const channelMapping = performanceDataService.getChannelMapping(chartObjects);
      
      // Get aggregate type mapping to group channels by aggregate type
      const groupedChannels = performanceDataService.getAggregateTypeMapping(chartObjects);

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
      const targetsData = preserveTargetName ? await fetchTargetData(preserveTargetName) : await performanceDataService.fetchTargets();

      // Fetch each aggregate type separately
      const [aggregatesAVGData, aggregatesSTDData, aggregatesAAVData] = await Promise.all([
        channelsByType.AVG.length > 0 ? performanceDataService.fetchAggregates(channelsByType.AVG, 'AVG', filters) : Promise.resolve([]),
        channelsByType.STD.length > 0 ? performanceDataService.fetchAggregates(channelsByType.STD, 'STD', filters) : Promise.resolve([]),
        channelsByType.AAV.length > 0 ? performanceDataService.fetchAggregates(channelsByType.AAV, 'AAV', filters) : Promise.resolve([])
      ]);

      // Enrich with local time strings once (before process) so processor does not repeat conversion
      performanceDataService.enrichWithLocalTimeStrings(aggregatesAVGData);
      performanceDataService.enrichWithLocalTimeStrings(aggregatesSTDData);
      performanceDataService.enrichWithLocalTimeStrings(aggregatesAAVData);

      // Process each aggregate type separately with channel mapping
      let processedAVG = aggregatesAVGData.length > 0 
        ? performanceDataService.processPerformanceData(aggregatesAVGData, [], targetsData, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      let processedSTD = aggregatesSTDData.length > 0
        ? performanceDataService.processPerformanceData(aggregatesSTDData, [], targetsData, channelMapping)
        : { aggregates: [], cloud: [], targets: { name: '', data: {} } };
      let processedAAV = aggregatesAAVData.length > 0
        ? performanceDataService.processPerformanceData(aggregatesAAVData, [], targetsData, channelMapping)
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
      } else if (trFilter === 'TRAINING') {
        if (processedAVG.aggregates) {
          processedAVG.aggregates = processedAVG.aggregates.filter((point: any) => {
            const raceNumber = point.race_number ?? point.Race_number;
            return raceNumber === 'TRAINING' || raceNumber === 'training' || raceNumber === -1 || raceNumber === '-1';
          });
        }
        if (processedSTD.aggregates) {
          processedSTD.aggregates = processedSTD.aggregates.filter((point: any) => {
            const raceNumber = point.race_number ?? point.Race_number;
            return raceNumber === 'TRAINING' || raceNumber === 'training' || raceNumber === -1 || raceNumber === '-1';
          });
        }
        if (processedAAV.aggregates) {
          processedAAV.aggregates = processedAAV.aggregates.filter((point: any) => {
            const raceNumber = point.race_number ?? point.Race_number;
            return raceNumber === 'TRAINING' || raceNumber === 'training' || raceNumber === -1 || raceNumber === '-1';
          });
        }
      }

      // Set separate aggregate data
      setAggregatesAVG(processedAVG.aggregates);
      setAggregatesSTD(processedSTD.aggregates);
      setAggregatesAAV(processedAAV.aggregates);
      
      // Also set aggregates to AVG for backward compatibility
      setAggregates(processedAVG.aggregates);
      
      // Only set targets if we're not preserving a specific target (it's already set)
      if (!preserveTargetName) {
        setTargets(processedAVG.targets);
      }

      // Extract TWS bins from aggregatesAVG data for box plot mode (intervals of 5)
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
      chartObjects.forEach(chartObject => {
        if (chartObject.charts[0].filters.length > 0) {
          result = false;
        }
      });
      setShowUwDw(result);

      setUpdateCharts(true);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logError('Error initializing performance charts:', err);
      setRequestError(errorMessage);
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };


  // Populate TWS bins from existing aggregates when switching to Box mode
  createEffect(() => {
    const currentPlotType = plotType();
    const currentAggregates = aggregates();
    
    // Only populate TWS bins for Box mode
    if (currentPlotType === "Box" && currentAggregates.length > 0) {
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
    await logActivity(project_id, dataset_id, 'PerformanceHistory.tsx', 'Performance History Report', `Axis changed to ${axis}`);
    setUpdateCharts(true);
  }

  // Create chart layout based on current x-axis selection
  const chartGroups = (): any[] => {
    const chartsData = charts();
    if (!chartsData || chartsData.length === 0) return [];

    const { twsName, bspName } = defaultChannelsStore;
    const currentXAxis = xAxis();

    // Simply ensure dataField is set for all series (use name if dataField doesn't exist)
    // Extract xType and yType for each series
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
  };

  const handleColorChange = async (value: string) => {
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
        : [...new Set(dataForGrouping.map(getPointValue))].filter((v) => v !== undefined && v !== null);

    let newGroups: Array<{ name: string; color: string }>;
    if (value == 'TACK') {
      newGroups = [{ name: 'PORT', color: "#d62728" }, { name: 'STBD', color: "#2ca02c" }];
    } else if (value == 'GRADE') {
      newGroups = unique_vals.map((val: any) => {
        const gradeNum = typeof val === 'number' ? val : parseInt(val, 10);
        if (isNaN(gradeNum) || gradeNum === 0 || val == 'NONE') {
          return { name: val, color: 'lightgrey' };
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

    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'PerformanceHistory.tsx', 'Performance History Report', `Color changed to ${value}`);
    setUpdateCharts(true);
  }

  // Helper to get filtered data (computed on the fly, not stored in signals)
  // Helper function to filter aggregates by type
  const getFilteredAggregatesForType = (data: PerformanceAggregatePoint[]): PerformanceAggregatePoint[] => {
    if (!Array.isArray(data)) {
      return [];
    }
    
    let filteredData = [...data];
    
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
      filteredData = filteredData.filter((d: PerformanceAggregatePoint) => d.event_id && cutEventIds.has(Number(d.event_id)));
    }
    
    // Apply client-side filters
    const races = selectedRacesAggregates();
    const legs = selectedLegsAggregates();
    
    // Note: PerformanceHistory doesn't have grade/state filters in the same way
    // Add them if needed based on the actual filter implementation
    
    return filteredData;
  };

  const getFilteredAggregates = (): PerformanceAggregatePoint[] => {
    let data = aggregates();

    // Apply selection filtering if there are cut events
    const currentCuts = cutEvents();

    if (currentCuts.length > 0) {
      const cutEventIds = new Set(
        currentCuts
          .map((event: any) => {
            if (typeof event === 'number') return event;
            if (event && typeof event === 'object' && 'event_id' in event) return event.event_id;
            return null;
          })
          .filter(id => id !== null && id !== undefined)
      );
      data = data.filter(d => d.event_id && cutEventIds.has(Number(d.event_id)));
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
    // Use Twa_deg_avg (metadata from AVG) for consistent upwind/downwind filtering across all aggregate types
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        return data.filter((d: any) => {
          const twaAvg = d.Twa_deg_avg ?? d.twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) < 90;
          }
          // Fallback to regular Twa if Twa_deg_avg is missing
          return Math.abs(d.Twa ?? 0) < 90;
        });
      } else {
        return data.filter((d: any) => {
          const twaAvg = d.Twa_deg_avg ?? d.twa_deg_avg;
          if (twaAvg !== undefined && twaAvg !== null && !isNaN(Number(twaAvg))) {
            return Math.abs(Number(twaAvg)) >= 90;
          }
          // Fallback to regular Twa if Twa_deg_avg is missing
          return Math.abs(d.Twa ?? 0) >= 90;
        });
      }
    }
    return data;
  };


  const getFilteredTargets = (): any => {
    const targetData = targets();
    if (showUwDw()) {
      if (UwDw() === 'UPWIND') {
        return targetData.data['UPWIND'];
      } else {
        return targetData.data['DOWNWIND'];
      }
    }

    return targetData.data;
  };

  // Keyboard shortcuts: 'x' to clear selection, 'c' to cut selection
  // Keys 1-3: Grade selected events (handled by PerfScatter component)
  const handleKeyDown = (event: KeyboardEvent) => {
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

  // Handle date range save - refetch data with new dates
  const handleSaveDateRange = async (newStartDate: string, newEndDate: string) => {
    log('Performance: Date range saved, refetching data', { newStartDate, newEndDate });

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
          logDebug('PerformanceHistory: Saved date range to persistent settings', {
            startDate: newStartDate,
            endDate: newEndDate
          });
        }
      } catch (error: unknown) {
        logDebug('PerformanceHistory: Error saving date range to persistent settings:', error as any);
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

      const channelMapping = performanceDataService.getChannelMapping(currentCharts);
      
      // Get aggregate type mapping to group channels by aggregate type
      const groupedChannels = performanceDataService.getAggregateTypeMapping(currentCharts);

      // Fetch aggregates - service will use filterStore dates (which we just set)
      const filters = buildFilters();
      const aggregatesData = await performanceDataService.fetchAggregatesByType(groupedChannels, filters);

      performanceDataService.enrichWithLocalTimeStrings(aggregatesData);

      // Process and set the data
      const processedData = performanceDataService.processPerformanceData(aggregatesData, [], targets(), channelMapping);
      setAggregates(processedData.aggregates);

      setUpdateCharts(true);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logError('Error refetching performance data with new date range:', err);
      setRequestError(errorMessage);
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };

  // Fetch available targets (ispolar = 0, sorted by date_modified desc)
  const fetchAvailableTargets = async () => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();

      if (!className || !projectId) {
        logError('Cannot fetch targets: missing class_name or project_id');
        return ['No Target'];
      }

      const url = `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&isPolar=0`;
      logDebug(`[PerformanceHistory] Fetching targets from: ${url}`);
      
      const response = await getData(url, new AbortController().signal);

      logDebug(`[PerformanceHistory] Targets API response:`, { 
        success: response.success, 
        hasData: !!response.data, 
        dataType: Array.isArray(response.data) ? 'array' : typeof response.data,
        dataLength: Array.isArray(response.data) ? response.data.length : 'N/A'
      });

      const targets = ['No Target']; // Always include "No Target" as first option

      if (response.success && response.data) {
        // Ensure response.data is an array
        if (!Array.isArray(response.data)) {
          logError('[PerformanceHistory] Targets API returned non-array data:', response.data);
          return targets;
        }

        if (response.data.length === 0) {
          logDebug('[PerformanceHistory] No targets found in API response');
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
          logDebug(`[PerformanceHistory] Found ${validTargetNames.length} valid targets:`, validTargetNames);
        } else {
          logWarn('[PerformanceHistory] No valid target names found in API response');
        }
      } else {
        logWarn('[PerformanceHistory] Targets API call failed or returned no data:', { 
          success: response.success, 
          message: (response as any).message 
        });
      }

      return targets;
    } catch (error) {
      logError('Error fetching available targets:', error);
      return ['No Target'];
    }
  };

  // Fetch target data by name
  const fetchTargetData = async (targetName: string) => {
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
          logDebug('PerformanceHistory: Successfully fetched target data', {
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
      
      logWarn('PerformanceHistory: Failed to fetch target data with any name format', {
        targetName,
        triedNames: namesToTry
      });
      return { name: '', data: {} };
    } catch (error) {
      logError('Error fetching target data:', error);
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
    setShowTargetModal(true);
    const targetsList = await fetchAvailableTargets();
    setAvailableTargets(targetsList);
    // Default to current target name, or "No Target" if no target is set
    const currentTarget = targets();
    const currentTargetName = currentTarget?.name || 'No Target';
    setSelectedTargetName(currentTargetName);
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
          logDebug('PerformanceHistory: Saved target to persistent settings', targetName);
        }
      } catch (error: unknown) {
        logDebug('PerformanceHistory: Error saving target to persistent settings:', error as any);
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
            logDebug('PerformanceHistory: Loaded target from persistent settings', cleanedTarget);
            return cleanedTarget;
          }
        }
      } catch (error: unknown) {
        logDebug('PerformanceHistory: Error loading target from persistent settings:', error as any);
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
      logDebug('PerformanceHistory: Saved target to sessionStorage', targetName);
    } catch (error) {
      logDebug('PerformanceHistory: Error saving target to sessionStorage:', error);
    }
  };

  // Load target name from sessionStorage (session persistence)
  const loadTargetFromSessionStorage = (): string | null => {
    try {
      const savedTarget = sessionStorage.getItem('performanceTarget');
      if (savedTarget) {
        const targetData = JSON.parse(savedTarget);
        if (targetData.targetName && typeof targetData.targetName === 'string') {
          logDebug('PerformanceHistory: Loaded target from sessionStorage', targetData.targetName);
          return targetData.targetName;
        }
      }
    } catch (error) {
      logDebug('PerformanceHistory: Error loading target from sessionStorage:', error);
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
        logDebug('PerformanceHistory: Fetched last known target name from project_objects', name.trim());
        return name.trim();
      }
    } catch (e) {
      logDebug('PerformanceHistory: Error fetching last known target from project:', e);
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
      logDebug('PerformanceHistory: Cleared target (No Target selected)');
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
      logError('PerformanceHistory: Failed to fetch target data for selected target', {
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
    logDebug(`PerformanceHistory: Selected target "${targetName}"`, {
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

  onMount(async () => {
    // Load filters from sessionStorage only (session persistence, not saved to user settings)
    loadFiltersFromSession();

    // Default year/event from dataset selection when not ALL (leave empty if ALL) - same as FleetPerformanceHistory
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
      logDebug('PerformanceHistory: Set default grade filter to 2,3');
    }
    
    // Set default state filter to "H0" if not already set
    if (!filterState() || filterState().trim() === '') {
      setFilterState('H0');
      logDebug('PerformanceHistory: Set default state filter to H0');
    }

    // Load highlights from persistent settings
    await logPageLoad('Performance.jsx', 'Performance Analysis Report');
    
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
        logDebug(`PerformanceHistory: Loaded saved target "${matchingTargetName}" from persistent settings (matched from "${cleanedTargetName}")`);
      } else {
        logDebug(`PerformanceHistory: Saved target "${cleanedTargetName}" no longer exists, skipping load`);
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
          logDebug('PerformanceHistory: Using last known project target (object_name=target)', matchingTargetName);
        }
      }
    }
    
    // Load date range from persistent settings first
    const hasSavedDateRange = await loadDateRangeFromPersistentSettings();
    
    // If no saved date range, initialize default (1 year back from latest data)
    if (!hasSavedDateRange) {
      await initializeDefaultDateRange();
    }
    
    // If still no dates set, fall back to initializeDateRange (30-day range)
    if (!startDate() || !endDate()) {
      await initializeDateRange();
    }

    // When an event filter is set, ensure date range is wide enough to include that event (saved range may not)
    const hasEventFilter = filterEvent().trim() !== '';
    if (hasEventFilter && startDate() && endDate()) {
      try {
        const { selectedClassName, selectedProjectId, selectedSourceId } = persistantStore;
        const className = selectedClassName();
        const projectId = selectedProjectId();
        const sourceId = selectedSourceId();
        if (className && projectId && sourceId !== undefined) {
          const controller = new AbortController();
          const result = await getData(
            `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}`,
            controller.signal
          );
          if (result.success && result.data) {
            const lastDate = new Date(result.data);
            const rangeEnd = lastDate;
            const rangeStart = new Date(rangeEnd.getTime());
            rangeStart.setFullYear(rangeStart.getFullYear() - 5);
            const formatYmd = (d: Date) => {
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              return `${y}-${m}-${day}`;
            };
            const wideStart = formatYmd(rangeStart);
            const wideEnd = formatYmd(rangeEnd);
            setStartDate(wideStart);
            setEndDate(wideEnd);
            logDebug('PerformanceHistory: Using wide date range for event filter so event is included', { startDate: wideStart, endDate: wideEnd });
          }
        }
      } catch (err) {
        logDebug('PerformanceHistory: Could not widen date range for event filter', err);
      }
    }
    
    // Initialize charts after highlights and filters are loaded
    // Pass the saved target name to preserve it during initialization
    initializeCharts(targetNameToPreserve);
    // Register keyboard shortcuts
    window.addEventListener('keydown', handleKeyDown);

    // Set up dynamic scaling for media-container using the global utility
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'Performance-Source',
      scaleToWidth: true
    });

    // Cleanup on unmount
    return () => {
      cleanupScaling(); // Call the cleanup function returned by the utility
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  // Cleanup on unmount (no timesController needed since we don't fetch event times)
  onCleanup(() => {
    // Clear data signals to free memory
    setAggregatesAVG([]);
    setAggregatesSTD([]);
    setAggregatesAAV([]);
    setAggregates([]);
    setTargets({ name: '', data: {} });
    setCharts([]);
    setGroups([]);
    
    logDebug('PerformanceHistory: Cleanup complete - data cleared');
  });

  const handleLegendClick = (legendItem: string) => {
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
      if (UwDw() === 'UPWIND') {
        const twaField = defaultChannelsStore.twaName();
        dataSource = fullAggregates.filter((d: PerformanceAggregatePoint) => Math.abs(d[twaField] ?? d.Twa ?? 0) < 90);
      } else {
        const twaField = defaultChannelsStore.twaName();
        dataSource = fullAggregates.filter((d: PerformanceAggregatePoint) => Math.abs(d[twaField] ?? d.Twa ?? 0) >= 90);
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
      log('PerformanceHistory: Legend click on', legendItem, '- no matching IDs found');
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
      log('PerformanceHistory: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'event IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      log('PerformanceHistory: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'event IDs');
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
    <div id='media-container' class="performance-page">
      <Show when={loading() || isLoading()}>
        <Loading 
          message="Loading Performance Data..." 
          fullScreen={true}
          className="z-50"
        />
      </Show>
      <Show when={!loading() && !isLoading()}>
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
              <div style="position: absolute; top: -5px; left: 0; z-index: 10;">
                <PerfSettings
                  useIconTrigger={true}
                  colorOptions={colors()}
                  selectedColor={() => color()}
                  onColorChange={handleColorChange}
                  selectedXAxis={() => xAxis()}
                  onXAxisChange={(axis) => handleAxisChange(axis)}
                  cloudDataOptions={[]}
                  onSaveDateRange={handleSaveDateRange}
                  filterGrades={() => filterGrades()}
                  onFilterGradesChange={(value) => {
                    setFilterGrades(value);
                    handleColorChange(color());
                    setUpdateCharts(true);
                  }}
                  filterYear={() => filterYear()}
                  onFilterYearChange={(value) => {
                    setFilterYear(value);
                    // Filters are saved to sessionStorage only (not persistent settings)
                  }}
                  filterEvent={() => filterEvent()}
                  onFilterEventChange={(value) => {
                    setFilterEvent(value);
                    // Filters are saved to sessionStorage only (not persistent settings)
                  }}
                  filterConfig={() => filterConfig()}
                  onFilterConfigChange={(value) => {
                    setFilterConfig(value);
                    // Filters are saved to sessionStorage only (not persistent settings)
                  }}
                  filterState={() => filterState()}
                  onFilterStateChange={(value) => {
                    setFilterState(value);
                    handleColorChange(color());
                    setUpdateCharts(true);
                  }}
                  selectedTrainingRacing={() => localTrainingRacingFilter()}
                  onTrainingRacingFilterChange={(type) => {
                    setLocalTrainingRacingFilter(type);
                  }}
                  onApplyFilters={async () => {
                    const currentTargetName = targets()?.name;
                    const targetToPreserve = currentTargetName && currentTargetName !== '' ? currentTargetName : undefined;
                    await initializeCharts(targetToPreserve);
                    handleColorChange(color());
                    setUpdateCharts(true);
                  }}
                  selectedPlotType={() => plotType()}
                  onPlotTypeChange={handlePlotTypeChange}
                  showTimeline={() => showTimeline()}
                  onTimelineChange={handleTimelineChange}
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
                    onTargetClick={handleTargetClick}
                    groups={groups()}
                    color={color()}
                    click={handleLegendClick}
                    filterSummary={<PerformanceFilterSummary filterGrades={filterGrades()} filterState={filterState()} trainingRacing={localTrainingRacingFilter()} />}
                  />
                </div>
              </div>
              {/* Timeline component */}
              <Show when={showTimeline()}>
                <div style="width: 100%; min-width: 0; height: 88px; margin-top: 10px;">
                  <ScatterTimeseries
                    key={`timeline-${updateCharts()}-${localTrainingRacingFilter() || 'all'}-${aggregatesAVG().length}`}
                    aggregates={aggregatesAVG()}
                    color={color()}
                    groups={groups()}
                    isHistoryPage={true}
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
                                    aggregatesAVG={getFilteredAggregatesForType(aggregatesAVG())}
                                    aggregatesSTD={getFilteredAggregatesForType(aggregatesSTD())}
                                    aggregatesAAV={getFilteredAggregatesForType(aggregatesAAV())}
                                    xType={series.xType || 'AVG'}
                                    yType={series.yType || 'AVG'}
                                    cloud={(series.xType || 'AVG').toUpperCase() === 'AVG' && (series.yType || 'AVG').toUpperCase() === 'AVG' ? [] : []}
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
                                        originalData: getFilteredAggregates(),
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
            <Show when={zoom()}>
            <div class="zoom-container" style={{ "min-height": showTimeline() ? "700px" : "800px", "margin-top": "50px" }}>
              <div class="flex w-full h-full" style={{ height: showTimeline() ? "700px" : "800px", width: "calc(100% - 25px)" }}>
                  <AdvancedScatter
                    xaxis={selectedChart()[0]}
                    yaxis={selectedChart()[1]}
                    taxis={selectedChart()[2]}
                    filters={selectedChart()[3]}
                    aggregates={getFilteredAggregates()}
                    aggregatesAVG={getFilteredAggregatesForType(aggregatesAVG())}
                    aggregatesSTD={getFilteredAggregatesForType(aggregatesSTD())}
                    aggregatesAAV={getFilteredAggregatesForType(aggregatesAAV())}
                    xType={selectedChart()[9] ?? selectedChart()[6] ?? 'AVG'}
                    yType={selectedChart()[10] ?? selectedChart()[6] ?? 'AVG'}
                    cloud={[]}
                    targets={getFilteredTargets()}
                    aggregate={selectedChart()[6] || 'AVG'}
                    uwDw={UwDw()}
                    updateCharts={updateCharts()}
                    color={color()}
                    groups={groups()}
                    mouseID={mouseID()}
                    setMouseID={setMouseID}
                    handleZoom={handleZoom}
                    zoom={zoom()}
                    selectedEvents={selectedEvents()}
                    hasCutData={cutEvents().length > 0}
                    onDataUpdate={() => initializeCharts()}
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
        <Portal>
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
