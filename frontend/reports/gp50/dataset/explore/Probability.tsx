import { onMount, createEffect, createSignal, batch, For, Show, onCleanup, untrack } from "solid-js";
import { useNavigate } from "@solidjs/router";

import PageSettings from "../../../../components/menus/PageSettings";
import Histogram from "../../../../components/charts/Histogram";
import Probability from "../../../../components/charts/Probability";
import Loading from "../../../../components/utilities/Loading";
import DataNotFoundMessage from "../../../../components/utilities/DataNotFoundMessage";

import { getData, removeLastChar, setupMediaContainerScaling } from "../../../../utils/global";
import { logPageLoad } from "../../../../utils/logging";
import { warn, error as logError, info, debug, log } from "../../../../utils/console";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { applyDataFilter } from "../../../../utils/dataFiltering";

import { user } from "../../../../store/userStore"; 
import { persistantStore } from "../../../../store/persistantStore";
import { 
  triggerUpdate as selectionTriggerUpdate, 
  selection, 
  selectedRange, 
  selectedRanges,
  cutEvents, 
  hasSelection,
  isCut,
  isSelectionLoading,
  registerSelectionStoreCleanup
} from "../../../../store/selectionStore";

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

import { apiEndpoints } from "@config/env";

// Import new data management system
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { getChartLayoutClass } from "../../../../utils/chartLayoutUtils";
import { useChartProgress } from "../../../../utils/useChartProgress";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName, colorType, setColorType } = persistantStore;

export default function HistogramPage(props) {
  // Make navigate optional for split view compatibility
  let navigate;
  try {
    navigate = useNavigate();
  } catch (error) {
    // Router not available (e.g., in split view), use fallback
    navigate = () => {
      warn('Router not available - navigation disabled');
    };
  }
  const [charts, setCharts] = createSignal([]);
  const [originalCharts, setOriginalCharts] = createSignal([]); // Store unfiltered charts for leg options
  const [originalRawData, setOriginalRawData] = createSignal<any[]>([]); // Store unfiltered raw data for re-processing
  const [events, setEvents] = createSignal([]);
  const [isFiltering, setIsFiltering] = createSignal(false);
  const [dataUpdateTrigger, setDataUpdateTrigger] = createSignal(0);
  
  // Get object name from props or use default
  // The object_name is the chart name (e.g., "default", "my_chart")
  // It's combined with parent_name="probability" to uniquely identify the chart object
  const objectName = props?.objectName || 'default';
  const [filtertype, setFiltertype] = createSignal("NONE");
  const [triggerUpdate, setTriggerUpdate] = createSignal(false);
  const [updateCharts, setUpdateCharts] = createSignal(false);
  const [isInitializing, setIsInitializing] = createSignal(false);
  const [columns, setColumns] = createSignal(0);
  /** True when we have chart config from API but data/channels could not be found (API or HuniDB). */
  const [hasChartConfigButNoData, setHasChartConfigButNoData] = createSignal(false);

  // Layout class memo
  const layoutClass = () => getChartLayoutClass(charts().length, 'default', columns());

  // Progress tracking
  const progress = useChartProgress({
    chartType: 'probability',
    className: selectedClassName,
    sourceId: selectedSourceId
  });

  // TWA filter options for the Filters component
  const twaFilterOptions = [
    "Upwind",
    "Downwind", 
    "Reaching",
    "Port",
    "Stbd"
  ];


  // Helper function to check if any chart has its own filters
  const hasChartFilters = (chartsToCheck) => {
    return chartsToCheck.some(chart => chart.filters && chart.filters.length > 0);
  };

  // Helper function to identify chart type fields (not actual data channels)
  const isChartTypeField = (fieldName) => {
    const chartTypeFields = [
      'Histogram',
      'Standard Probability',
      'Probability',
      'Cumulative Probability',
      'Distribution'
    ];
    return chartTypeFields.includes(fieldName);
  };

  // Helper function to determine which component to use based on chart type
  const getChartComponent = (chart) => {
    const chartType = chart?.series?.[0]?.yaxis?.name || 'Standard Probability';
    
    // Use Histogram component for histogram charts
    if (chartType === 'Histogram') {
      return Histogram;
    }
    
    // Use Probability component for all probability charts
    return Probability;
  };

  // Memoized chart key generation to prevent unnecessary re-renders
  const generateChartKey = (chart, index) => {
    const baseKey = chart.chartKey || `${chart.series?.[0]?.xaxis?.name || 'chart'}-${chart.series?.[0]?.yaxis?.name || 'default'}-${chart.series?.[0]?.color || 'default'}`;
    const dataLength = chart.series?.[0]?.data?.length || 0;
    const filterState = JSON.stringify({
      filters: selectedStatesTimeseries().slice().sort(),
      races: selectedRacesTimeseries().slice().sort(),
      legs: selectedLegsTimeseries().slice().sort(),
      grades: selectedGradesTimeseries().slice().sort()
    });
    
    return `${baseKey}-${dataLength}-${filterState.slice(0, 20)}-${index}`;
  };

  // Filter function based on TWA, races, legs, and grades (consistent with Scatter)
  function filterByTwa(data, filters, races = [], legs = [], grades = []) {
    if (!data || data.length === 0) return data;
    
    // Debug: Check if grade field exists in data
    if (grades.length > 0 && data.length > 0) {
      const sampleRow = data[0];
      const hasGrade = 'GRADE' in sampleRow || 'Grade' in sampleRow || 'grade' in sampleRow;
      const gradeValue = sampleRow.GRADE ?? sampleRow.Grade ?? sampleRow.grade;
      debug('📊 Probability: Grade filter check', {
        gradesToFilter: grades,
        hasGradeField: hasGrade,
        sampleGradeValue: gradeValue,
        sampleRowKeys: Object.keys(sampleRow).slice(0, 20)
      });
    }
    
    const result = data.filter((d) => {
      // Race filtering (use original case field names)
      if (races.length > 0 && !races.includes(d.Race_number)) {
        return false;
      }
      
      // Leg filtering (use original case field names)
      if (legs.length > 0 && !legs.includes(d.Leg_number)) {
        return false;
      }
      
      // Grade filtering - handle GRADE, Grade, or grade (case-insensitive)
      // Also handle numeric vs string comparison (grades might be numbers or strings)
      if (grades.length > 0) {
        const grade = d.GRADE ?? d.Grade ?? d.grade;
        if (grade === undefined || grade === null) {
          // If grade is missing, exclude this row when filtering by grade
          return false;
        }
        // Convert both to numbers for comparison (grades are typically 1, 2, 3)
        const gradeNum = typeof grade === 'string' ? parseInt(grade, 10) : grade;
        const gradesNum = grades.map(g => typeof g === 'string' ? parseInt(g, 10) : g);
        if (!gradesNum.includes(gradeNum)) {
          return false;
        }
      }
      
      // TWA filtering (use default TWA channel name)
      if (!filters || filters.length === 0) return true;
      
      // Get default TWA channel name
      const twaChannelName = defaultChannelsStore.twaName();
      
      // Get TWA value using default channel name, with fallback to common variations
      const twaValue = d[twaChannelName] ?? d.Twa ?? d.twa ?? d.TWA;
      
      if (typeof twaValue !== "number") return false;
      
      const lowerFilters = filters.map(f => typeof f === 'string' ? f.toLowerCase() : f);
      
      const hasDirectionFilter = lowerFilters.includes("upwind") || lowerFilters.includes("downwind") || lowerFilters.includes("reaching");
      const hasUpwind = lowerFilters.includes("upwind");
      const hasDownwind = lowerFilters.includes("downwind");
      const hasReaching = lowerFilters.includes("reaching");
      const hasPort = lowerFilters.includes("port");
      const hasStbd = lowerFilters.includes("stbd");
      
      let passesDirectionFilter = true;
      let passesPortStbdFilter = true;
      
      if (hasDirectionFilter) {
        passesDirectionFilter = false;
        const absTwa = Math.abs(twaValue);
        
        // Upwind: 30-75 (exclusive boundaries: > 30 and < 75)
        if (hasUpwind && absTwa > 30 && absTwa < 75) passesDirectionFilter = true;
        // Downwind: 105-150 (exclusive boundaries: > 105 and < 150)
        if (hasDownwind && absTwa > 105 && absTwa < 150) passesDirectionFilter = true;
        // Reaching: 75-115 (exclusive boundaries: > 75 and < 115)
        if (hasReaching && absTwa > 75 && absTwa < 115) passesDirectionFilter = true;
      }
      
      if (hasPort || hasStbd) {
        if (hasPort && hasStbd) {
          passesPortStbdFilter = true;
        } else if (hasPort && !hasStbd) {
          passesPortStbdFilter = twaValue < 0;
        } else if (!hasPort && hasStbd) {
          passesPortStbdFilter = twaValue > 0;
        }
      }
      
      return passesDirectionFilter && passesPortStbdFilter;
    });
    
    return result;
  }

  // Filter data function that applies current filter states to charts
  const filterData = () => {
    const currentCharts = charts();
    if (!currentCharts || currentCharts.length === 0) return;
    
    // Apply filters to all charts
    const filteredCharts = applyFiltersToCharts(currentCharts);
    updateChartsWithStateCheck(filteredCharts, 'filterData');
    
    // Trigger chart updates
    setUpdateCharts(true);
  };

  // Reusable function to apply filters to charts (consistent with Scatter)
  const applyFiltersToCharts = (currentCharts, globalFilters = selectedStatesTimeseries(), globalRaces = selectedRacesTimeseries(), globalLegs = selectedLegsTimeseries(), globalGrades = selectedGradesTimeseries()) => {
    debug('📊 Probability: applyFiltersToCharts called', {
      chartCount: currentCharts.length,
      filters: globalFilters,
      races: globalRaces,
      legs: globalLegs,
      grades: globalGrades
    });
    return currentCharts.map(chart => {
      // Preserve chart identity to prevent component remounting
      const updatedChart = {
        ...chart,
        // Always preserve the existing chartKey or create a stable one based on chart structure
        chartKey: chart.chartKey || `${chart.series?.[0]?.xaxis?.name || 'chart'}-${chart.series?.[0]?.yaxis?.name || 'default'}-${chart.series?.[0]?.color || 'default'}`,
        // Preserve the original chart reference to maintain component identity
        _originalChart: chart._originalChart || chart,
        series: chart.series.map(series => {
          const originalData = series.originalData || series.data;
          if (!series.originalData) {
            series.originalData = [...series.data];
          }
          
          // Apply TWA filters first
          let filteredData;
          if (chart.filters && chart.filters.length > 0) {
            filteredData = filterByTwa(originalData, chart.filters, [], [], []);
          } else {
            filteredData = filterByTwa(originalData, globalFilters, globalRaces, globalLegs, globalGrades);
          }
          
          // Then apply time-based selection filtering (selectedRanges, selectedRange, cutEvents)
          filteredData = applyDataFilter(filteredData);
          
          return { ...series, data: filteredData, originalData };
        })
      };
      return updatedChart;
    });
  };

  const filtertypes = ["NONE", "PHASES", "PERIODS", "BIN 10", "TACKS", "GYBES", "BEARAWAYS", "ROUNDUPS"];
  const colortypes = ["DEFAULT", "TACK", "UW/DW"];

  // Register cleanup for both data and selection stores
  registerSelectionStoreCleanup();

  // AbortController for managing fetch requests
  let abortController = new AbortController();
  let isApplyingFilters = false;
  let filteringTimer = null;
  let lastFilterState = null; // Track last filter state to prevent unnecessary updates
  let isFetchingData = false; // Track data fetching to prevent duplicate calls

  const resetAbortController = () => {
    abortController.abort();
    abortController = new AbortController();
  };

  const fetchCharts = async (signal) => {
    if (signal.aborted) {
      return [];
    }
    try {
      // Debug: Log the object name being used to help diagnose lookup issues
      debug('📊 Probability: Fetching charts', {
        objectName,
        propsObjectName: props?.objectName,
        parentName: 'probability',
        className: selectedClassName(),
        projectId: selectedProjectId(),
        userId: user()?.user_id
      });
      
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=probability&object_name=${encodeURIComponent(objectName)}`, signal);
      if (!response.success) throw new Error("Failed to fetch dataset object.");

      // Debug: Log what was returned to verify it's the correct object
      if (response.data) {
        debug('📊 Probability: Chart object fetched', {
          objectName,
          hasChartInfo: !!response.data.chart_info,
          chartCount: response.data.chart_info?.length || 0,
          columns: response.data.columns || 0
        });
      }

      return {
        chart_info: response.data.chart_info || [],
        columns: response.data.columns || 0
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { chart_info: [], columns: 0 };
      }
      logError('📊 Probability: Error fetching charts', error);
      return { chart_info: [], columns: 0 };
    }
  };

  const fetchAndFormatData = async (chartsData, signal) => {
    const startTime = performance.now();
    
    try { info('📊 Probability: Starting data fetch', { chartCount: chartsData.length }); } catch {}
    isFetchingData = true;
    
    try {
      // Gather all required channels
      const requiredChannelsSet = new Set();
      
      // Add filter channels from service (dataset context)
      const filterChannels = await UnifiedFilterService.getRequiredFilterChannels(selectedClassName(), 'dataset');
      filterChannels.forEach(channel => requiredChannelsSet.add(channel));
      requiredChannelsSet.add('Datetime'); // Always include Datetime
      // Always include Twa for probability category filtering (PORT/STBD/UW/DW/RCH)
      // Preserve original case from defaultChannelsStore for API compatibility
      // Case-insensitive matching will handle any case variations
      const twaChannelName = defaultChannelsStore.twaName();
      requiredChannelsSet.add(twaChannelName);
      
      // Add optional filter channels (sail codes)
      const optionalFilterChannels = UnifiedFilterService.getOptionalFilterChannels();
      optionalFilterChannels.forEach(channel => requiredChannelsSet.add(channel));
      
      // Add chart-specific channels (filter out non-data fields)
      // Preserve original case - unifiedDataStore and data processing handle case-insensitive matching
      chartsData.forEach(chart => {
        chart.series.forEach(series => {
          // Only add xaxis name if it's a real data channel (not chart type)
          // Preserve original case - case-insensitive matching will handle variations
          if (series.xaxis?.name && !isChartTypeField(series.xaxis.name)) {
            requiredChannelsSet.add(series.xaxis.name);
          }
          // Only add yaxis name if it's a real data channel (not chart type)
          // Preserve original case - case-insensitive matching will handle variations
          if (series.yaxis?.name && !isChartTypeField(series.yaxis.name)) {
            requiredChannelsSet.add(series.yaxis.name);
          }
          // Include colorChannel if colorType is 'By Channel'
          // Preserve original case - case-insensitive matching will handle variations
          if (series.colorType === 'By Channel' && series.colorChannel?.name) {
            requiredChannelsSet.add(series.colorChannel.name);
          }
        });
      });
      const requiredChannels = Array.from(requiredChannelsSet);

      try { info('📊 Probability: Requesting channels', { channels: requiredChannels, chartCount: chartsData.length }); } catch {}
      
      // Get dataset date for proper API calls (same as Scatter component)
      const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`, abortController.signal);
      
      if (!datasetInfoResponse.success) {
        warn("📊 Probability: Failed to fetch dataset metadata");
        return [];
      }
      
      const { date: rawDate } = datasetInfoResponse.data;
      const formattedDate = rawDate.replace(/-/g, "");
      
      try { debug('📊 Probability: Dataset date info:', { rawDate, formattedDate }); } catch {}
      
      // Use unifiedDataStore with explicit timeseries dataSource
      // Decide whether to apply global filters at the data layer.
      // If any chart object declares its own filters, disable global filtering here
      // so component-level filters can take precedence for those charts.
      const applyGlobal = !hasChartFilters(chartsData);
      try { setHasChartsWithOwnFilters(!applyGlobal); } catch (_) {}
      const data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
        'probability',
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
          applyGlobalFilters: false, // Always fetch full dataset, apply filters locally
          skipTimeRangeFilter: true // CRITICAL: Probability should NEVER filter by timeRange - needs full dataset
        },
        'timeseries' // Explicitly define data source
      );

      if (!data || data.length === 0) {
        progress.setProgress(100, 'No data available');
        const missingChannels = unifiedDataStore.getLastMissingChannels('probability');
        if (missingChannels.length > 0 && chartsData?.length > 0) {
          const missingLower = new Set(missingChannels.map((c: string) => c.toLowerCase()));
          return chartsData.map((chart: any) => {
            const required: string[] = [];
            chart.series?.forEach((s: any) => {
              if (s.xaxis?.name && !isChartTypeField(s.xaxis.name)) required.push(s.xaxis.name);
              if (s.yaxis?.name && !isChartTypeField(s.yaxis.name)) required.push(s.yaxis.name);
              if (s.colorType === 'By Channel' && s.colorChannel?.name) required.push(s.colorChannel.name);
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
      
      // CRITICAL: Apply normalization to clean up duplicate channel names (Grade/grade/GRADE, Twa/Twa_deg, etc.)
      // This ensures consistent field names throughout the component
      let normalizedData = data;
      try {
        const { extractAndNormalizeMetadata } = await import('../../../../utils/dataNormalization');
        
        normalizedData = data.map(point => {
          const normalized = { ...point };
          const normalizedMetadata = extractAndNormalizeMetadata(point);
          
          // CRITICAL: Remove ALL case variations including standard names - we'll add them back from normalizedMetadata
          // This ensures we never have duplicates (e.g., both 'GRADE' and 'Grade' and 'grade')
          const standardMetadataFields = ['Grade', 'State', 'Race_number', 'Leg_number'];
          standardMetadataFields.forEach(field => {
            // Remove all case variations of standard fields (including the standard name itself)
            const fieldLower = field.toLowerCase();
            Object.keys(normalized).forEach(key => {
              if (key.toLowerCase() === fieldLower) {
                delete normalized[key];
              }
            });
          });
          
          // Remove all other case variations
          const fieldsToRemove = [
            'GRADE', 'grade',
            'STATE', 'state', 'FOILING_STATE', 'Foiling_state', 'foiling_state', 'FoilingState', 'foilingState',
            'RACE', 'race_number', 'RACE_NUMBER', 'RaceNumber', 'raceNumber',
            'LEG', 'leg_number', 'LEG_NUMBER', 'LegNumber', 'legNumber',
            'CONFIG', 'config',
            'EVENT', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
            'SOURCE_NAME', 'Source_name', 'Source', 'SOURCE', 'source'
          ];
          fieldsToRemove.forEach(field => {
            if (field in normalized) {
              delete normalized[field];
            }
          });
          
          // Add normalized metadata using standard names (only if values exist)
          if (normalizedMetadata.Grade !== undefined && normalizedMetadata.Grade !== null) {
            normalized.Grade = normalizedMetadata.Grade;
          }
          if (normalizedMetadata.State !== undefined && normalizedMetadata.State !== null) {
            normalized.State = normalizedMetadata.State;
          }
          if (normalizedMetadata.Race_number !== undefined && normalizedMetadata.Race_number !== null) {
            normalized.Race_number = normalizedMetadata.Race_number;
          }
          if (normalizedMetadata.Leg_number !== undefined && normalizedMetadata.Leg_number !== null) {
            normalized.Leg_number = normalizedMetadata.Leg_number;
          }
          
          // Handle Twa/Twa_deg duplicates - keep only Twa_deg (default TWA channel name)
          if ('Twa' in normalized && twaChannelName in normalized) {
            normalized[twaChannelName] = normalized[twaChannelName] ?? normalized.Twa;
            delete normalized.Twa;
          } else if ('Twa' in normalized && !(twaChannelName in normalized)) {
            normalized[twaChannelName] = normalized.Twa;
            delete normalized.Twa;
          }
          
          // Remove ts field if timestamp exists
          if ('ts' in normalized && 'timestamp' in normalized) {
            delete normalized.ts;
          }
          
          return normalized;
        });
      } catch (normalizeError) {
        warn('📊 Probability: Error normalizing data, using original data', normalizeError);
        normalizedData = data;
      }
      
      try { 
        info('📊 Probability: Data loaded', { rows: normalizedData.length }); 
        if (normalizedData.length > 0) {
          debug('📊 Probability: Sample data point:', {
            sample: normalizedData[0],
            fields: Object.keys(normalizedData[0]),
            hasTwa: twaChannelName in normalizedData[0] || 'Twa' in normalizedData[0],
            twaValue: normalizedData[0][twaChannelName] || normalizedData[0].Twa,
            hasXAxis: chartsData[0]?.series?.[0]?.xaxis?.name,
            xAxisValue: normalizedData[0][chartsData[0]?.series?.[0]?.xaxis?.name || '']
          });
        }
      } catch {}
      
      // CRITICAL: Apply filters to raw data BEFORE processing for probability computation
      // This ensures probability is computed only on filtered data (grade, race, leg, TWA filters)
      const currentFilters = selectedStatesTimeseries();
      const currentRaces = selectedRacesTimeseries();
      const currentLegs = selectedLegsTimeseries();
      const currentGrades = selectedGradesTimeseries();
      
      debug('📊 Probability: Applying filters to raw data before probability computation', {
        filters: currentFilters,
        races: currentRaces,
        legs: currentLegs,
        grades: currentGrades,
        dataRowsBefore: data.length
      });
      
      // Apply filters to raw data using the same filterByTwa function
      const filteredData = filterByTwa(normalizedData, currentFilters, currentRaces, currentLegs, currentGrades);
      
      debug('📊 Probability: Filtered raw data', {
        dataRowsAfter: filteredData.length,
        filteredOut: normalizedData.length - filteredData.length
      });
      
      // Use filtered data for all subsequent processing
      const dataToProcess = filteredData;
      
      // Store original unfiltered raw data for re-processing when filters change
      setOriginalRawData([...normalizedData]);
      
      // Load full filter options from unified datastore
      try {
        const opts = await unifiedDataStore.getFilterOptions();
        if (opts) {
          const allRaces = (opts.races || []).slice().sort((a,b)=>a-b);
          let allGrades = (opts.grades || []).slice().sort((a,b)=>a-b);
          const allLegs = (opts.legs || opts.legOptions || []).slice().sort((a,b)=>a-b);
          
          // If no grades found and Grade field is missing from data, provide default grades
          if (allGrades.length === 0 && dataToProcess.length > 0 && !('Grade' in dataToProcess[0]) && !('grade' in dataToProcess[0])) {
            debug('🔍 Probability: No Grade field in data, providing default grade options');
            allGrades = [1, 2, 3]; // Default grade options
          }
          
          setRaceOptions(allRaces);
          setGradeOptions(allGrades);
          setLegOptions(allLegs);
        }
      } catch (_) {}

      // Process charts with the filtered data
      try { info('📊 Probability: Processing charts', { chartCount: chartsData.length }); } catch {}
      const processedCharts = processDataIntoCharts(chartsData, dataToProcess);
      
      const endTime = performance.now();
      try { info('📊 Probability: Data processing time (ms)', { elapsedMs: Number((endTime - startTime).toFixed(2)) }); } catch {}
      
      // Data processing complete
      progress.setProgress(100, 'Complete');
      return processedCharts;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      logError("Error in fetchAndFormatData:", error);
      return [];
    } finally {
      isFetchingData = false;
    }
  };

  // Helper function to process filtered data into charts
  // This is extracted so it can be reused when filters change
  const processDataIntoCharts = (chartsData: any[], dataToProcess: any[]) => {
    return chartsData.map(chart => {
        const processedChart = { ...chart };
        processedChart.series = chart.series.map(series => {
          const processedSeries = { ...series };
          
          // Process data for this series
          // Get default Twa channel name once per series (not per row for efficiency)
          const twaChannelName = defaultChannelsStore.twaName();
          const twaChannelNameLower = twaChannelName.toLowerCase();
          
          // Track if we've warned about missing x-axis channel (to avoid duplicate warnings)
          let hasWarnedAboutXAxis = false;
          // Track if we've warned about missing data points (to avoid duplicate warnings per series)
          let hasWarnedAboutMissingData = false;
          
          // Helper to check if a key exists in a row (handles both missing keys and undefined values)
          const hasKey = (row: any, key: string): boolean => {
            return Object.prototype.hasOwnProperty.call(row, key);
          };
          
          // Helper to check if a value is valid numeric
          const isValidNumeric = (val: any): boolean => {
            return val !== undefined && val !== null && !isNaN(Number(val)) && isFinite(Number(val));
          };
          
          const seriesData = dataToProcess.map(row => {
            // Get TWA value - prefer default channel name (Twa_deg), fallback to Twa for backward compatibility
            const twaValue = row[twaChannelName] !== undefined ? row[twaChannelName] :
                           row[twaChannelNameLower] !== undefined ? row[twaChannelNameLower] :
                           row.Twa !== undefined ? row.Twa :
                           row.twa !== undefined ? row.twa : 
                           row.TWA !== undefined ? row.TWA : undefined;
            
            // Get x value - try case-insensitive matching if exact match fails
            // CRITICAL: Only set xValue if we find a valid numeric value (not undefined, null, or NaN)
            let xValue: number | undefined = undefined;
            let xValueFound = false;
            let xKeyFound = false;
            let xKeyName: string | undefined = undefined;
            let xRawValue: any = undefined;
            
            if (series.xaxis?.name && !isChartTypeField(series.xaxis.name)) {
              const xAxisName = series.xaxis.name;
              
              // Try exact match first (check if key exists, not just if value is defined)
              if (hasKey(row, xAxisName)) {
                xKeyFound = true;
                xKeyName = xAxisName;
                xRawValue = row[xAxisName];
                if (isValidNumeric(row[xAxisName])) {
                  xValue = Number(row[xAxisName]);
                  xValueFound = true;
                }
              } else if (hasKey(row, xAxisName.toLowerCase())) {
                xKeyFound = true;
                xKeyName = xAxisName.toLowerCase();
                xRawValue = row[xAxisName.toLowerCase()];
                if (isValidNumeric(row[xAxisName.toLowerCase()])) {
                  xValue = Number(row[xAxisName.toLowerCase()]);
                  xValueFound = true;
                }
              } else if (hasKey(row, xAxisName.toUpperCase())) {
                xKeyFound = true;
                xKeyName = xAxisName.toUpperCase();
                xRawValue = row[xAxisName.toUpperCase()];
                if (isValidNumeric(row[xAxisName.toUpperCase()])) {
                  xValue = Number(row[xAxisName.toUpperCase()]);
                  xValueFound = true;
                }
              } else {
                // Try case-insensitive search through all keys
                const matchingKey = Object.keys(row).find(key => key.toLowerCase() === xAxisName.toLowerCase());
                if (matchingKey !== undefined) {
                  xKeyFound = true;
                  xKeyName = matchingKey;
                  xRawValue = row[matchingKey];
                  if (isValidNumeric(row[matchingKey])) {
                    xValue = Number(row[matchingKey]);
                    xValueFound = true;
                  }
                }
              }
            }
            
            // Debug log if x-axis channel not found or has invalid value (only log once per series)
            if (!xValueFound && series.xaxis?.name && !isChartTypeField(series.xaxis.name) && !hasWarnedAboutXAxis) {
              if (xKeyFound && xKeyName) {
                debug(`[Probability] X-axis channel "${series.xaxis.name}" found as "${xKeyName}" but value is invalid (${xRawValue}). Available keys:`, Object.keys(row).slice(0, 10));
              } else {
                debug(`[Probability] X-axis channel "${series.xaxis.name}" not found in data row. Available keys:`, Object.keys(row).slice(0, 10));
              }
              hasWarnedAboutXAxis = true;
            }
            
            // Get y value - try case-insensitive matching if exact match fails
            let yValue = 0;
            if (series.yaxis?.name && !isChartTypeField(series.yaxis.name)) {
              const yAxisName = series.yaxis.name;
              
              if (hasKey(row, yAxisName)) {
                yValue = row[yAxisName] || 0;
              } else if (hasKey(row, yAxisName.toLowerCase())) {
                yValue = row[yAxisName.toLowerCase()] || 0;
              } else if (hasKey(row, yAxisName.toUpperCase())) {
                yValue = row[yAxisName.toUpperCase()] || 0;
              } else {
                // Try case-insensitive search through all keys
                const matchingKey = Object.keys(row).find(key => key.toLowerCase() === yAxisName.toLowerCase());
                if (matchingKey !== undefined) {
                  yValue = row[matchingKey] || 0;
                }
              }
            }
            
            // Destructure to remove Twa/twa variations and duplicate metadata fields from row
            // Remove all case variations of metadata fields to avoid duplicates
            const metadataFieldsToRemove = ['Twa', 'twa', 'TWA', twaChannelName, twaChannelNameLower,
                                            'GRADE', 'grade', 'STATE', 'state', 'FOILING_STATE', 'Foiling_state', 'foiling_state',
                                            'RACE', 'race_number', 'RACE_NUMBER', 'RaceNumber', 'raceNumber',
                                            'LEG', 'leg_number', 'LEG_NUMBER', 'LegNumber', 'legNumber'];
            const cleanedRow: any = {};
            Object.keys(row).forEach(key => {
              // Skip Twa variations
              if (key === 'Twa' || key === 'twa' || key === 'TWA' || key === twaChannelName || key === twaChannelNameLower) {
                return;
              }
              // Skip duplicate metadata field variations (keep only standard names: Grade, State, Race_number, Leg_number)
              const keyLower = key.toLowerCase();
              if (keyLower === 'grade' && key !== 'Grade') return;
              if (keyLower === 'state' && key !== 'State') return;
              if (keyLower === 'race_number' && key !== 'Race_number') return;
              if (keyLower === 'leg_number' && key !== 'Leg_number') return;
              cleanedRow[key] = row[key];
            });
            
            // Get grade value (should be normalized to 'Grade' by now)
            const gradeValue = row.Grade ?? row.grade ?? row.GRADE;
            
            // Use timestamp in milliseconds (ts field removed - only timestamp is used)
            const timestamp = row.timestamp ?? 0;
            // Get color value - try case-insensitive matching if exact match fails
            let colorValue = series.color || '#1f77b4';
            if (series.colorType === 'By Channel' && series.colorChannel?.name) {
              const colorChannelName = series.colorChannel.name;
              
              if (hasKey(row, colorChannelName)) {
                colorValue = row[colorChannelName] || series.color || '#1f77b4';
              } else if (hasKey(row, colorChannelName.toLowerCase())) {
                colorValue = row[colorChannelName.toLowerCase()] || series.color || '#1f77b4';
              } else if (hasKey(row, colorChannelName.toUpperCase())) {
                colorValue = row[colorChannelName.toUpperCase()] || series.color || '#1f77b4';
              } else {
                // Try case-insensitive search through all keys
                const matchingKey = Object.keys(row).find(key => key.toLowerCase() === colorChannelName.toLowerCase());
                if (matchingKey !== undefined) {
                  colorValue = row[matchingKey] || series.color || '#1f77b4';
                }
              }
            }
            
            // Get final TWA value - use twaValue if found, otherwise try fallbacks
            const finalTwaValue = twaValue !== undefined && twaValue !== null ? twaValue : 
                                 (row[twaChannelName] ?? row.Twa ?? row.twa);
            
            return {
              Datetime: row.Datetime || row.datetime || new Date(timestamp).toISOString(),
              x: xValueFound ? xValue : undefined, // Only set x if we found a valid value
              y: yValue,
              color: colorValue,
              // Include cleaned metadata (without duplicates)
              ...cleanedRow,
              // Use default TWA channel name as primary (Twa_deg)
              [twaChannelName]: finalTwaValue,
              // Also include Twa for backward compatibility with Probability chart component and validation (which expects d.Twa)
              Twa: finalTwaValue,
              // Only include Grade (standard name), not grade or GRADE - but only if it exists
              ...(gradeValue !== undefined && gradeValue !== null ? { Grade: gradeValue } : {})
            };
          });
          
          // Filter out invalid points (missing required fields) before passing to chart
          // This prevents the chart from trying to render points with undefined/null/NaN values
          const validSeriesData = seriesData.filter(d => {
            const hasX = d.x !== undefined && d.x !== null && !isNaN(d.x);
            const hasDatetime = d.Datetime !== undefined;
            // Check both default TWA channel name and Twa for backward compatibility
            const twaValue = d[twaChannelName] ?? d.Twa;
            const hasTwa = twaValue !== undefined && twaValue !== null && !isNaN(twaValue);
            return hasX && hasDatetime && hasTwa;
          });
          
          processedSeries.data = validSeriesData;
          
          // Log if we filtered out invalid points
          if (validSeriesData.length < seriesData.length) {
            debug(`[Probability] Filtered out ${seriesData.length - validSeriesData.length} invalid points (missing required fields) from series "${series.name || 'unnamed'}"`);
          }
          
          // Debug: Check if processed data has required fields
          if (seriesData.length > 0) {
            const sample = seriesData[0];
            const validPoints = seriesData.filter(d => {
              const hasX = d.x !== undefined && d.x !== null && !isNaN(d.x);
              const hasDatetime = d.Datetime !== undefined;
              const twaValue = d[twaChannelName] ?? d.Twa;
              const hasTwa = twaValue !== undefined && twaValue !== null && !isNaN(twaValue);
              return hasX && hasDatetime && hasTwa;
            });
            
            try {
              // Analyze what's missing
              const missingX = seriesData.filter(d => {
                const hasX = d.x !== undefined && d.x !== null && !isNaN(d.x);
                return !hasX;
              }).length;
              const missingDatetime = seriesData.filter(d => !d.Datetime).length;
              const missingTwa = seriesData.filter(d => {
                const twaValue = d[twaChannelName] ?? d.Twa;
                const hasTwa = twaValue !== undefined && twaValue !== null && !isNaN(twaValue);
                return !hasTwa;
              }).length;
              
              debug('📊 Probability: Processed series data sample:', {
                hasX: 'x' in sample,
                xValue: sample.x,
                hasDatetime: 'Datetime' in sample,
                hasTwa: (twaChannelName in sample) || ('Twa' in sample),
                twaValue: sample[twaChannelName] ?? sample.Twa,
                xAxisName: series.xaxis?.name,
                yAxisName: series.yaxis?.name,
                dataLength: seriesData.length,
                validPoints: validPoints.length,
                invalidPoints: seriesData.length - validPoints.length,
                missingX,
                missingDatetime,
                missingTwa,
                sampleRowKeys: Object.keys(sample).slice(0, 15)
              });
              
              if (validPoints.length === 0) {
                const missingFields = [];
                if (missingX === seriesData.length) missingFields.push('x-axis');
                if (missingDatetime === seriesData.length) missingFields.push('Datetime');
                if (missingTwa === seriesData.length) missingFields.push('Twa');
                
                warn(`[Probability] ❌ No valid data points after processing! All ${seriesData.length} points are missing required fields:`, {
                  missingFields: missingFields.join(', '),
                  missingXCount: missingX,
                  missingDatetimeCount: missingDatetime,
                  missingTwaCount: missingTwa,
                  xAxisName: series.xaxis?.name,
                  expectedXAxis: series.xaxis?.name || 'not specified',
                  sampleDataKeys: Object.keys(sample).slice(0, 20),
                  sampleData: {
                    x: sample.x,
                    Datetime: sample.Datetime,
                    Twa: sample.Twa,
                    timestamp: sample.timestamp,
                    ...Object.fromEntries(Object.entries(sample).slice(0, 5))
                  },
                  note: 'Check if x-axis channel name matches data keys (case-sensitive)'
                });
                
                // Log sample of invalid points to help diagnose
                const invalidSamples = seriesData.slice(0, 3).map(d => ({
                  hasX: d.x !== undefined && d.x !== null && !isNaN(d.x),
                  xValue: d.x,
                  hasDatetime: d.Datetime !== undefined,
                  hasTwa: d.Twa !== undefined && d.Twa !== null && !isNaN(d.Twa),
                  twaValue: d.Twa,
                  availableKeys: Object.keys(d).slice(0, 10)
                }));
                debug('📊 Probability: Sample invalid points:', invalidSamples);
              } else if (validPoints.length < seriesData.length && !hasWarnedAboutMissingData) {
                // Some points are invalid, but not all - only warn if significant percentage (>20%)
                // and only warn once per series to avoid noise
                const invalidPercentage = ((seriesData.length - validPoints.length) / seriesData.length) * 100;
                if (invalidPercentage > 20) {
                  warn(`[Probability] ⚠️ ${seriesData.length - validPoints.length} of ${seriesData.length} points (${invalidPercentage.toFixed(1)}%) are missing required fields in series "${series.name || 'unnamed'}":`, {
                    xAxisChannel: series.xaxis?.name || 'not specified',
                    missingXCount: missingX,
                    missingDatetimeCount: missingDatetime,
                    missingTwaCount: missingTwa,
                    validPoints: validPoints.length,
                    invalidPoints: seriesData.length - validPoints.length,
                    note: 'Invalid points have been filtered out. This may be expected if some data points lack values for certain channels.'
                  });
                  hasWarnedAboutMissingData = true;
                } else {
                  debug(`[Probability] ${seriesData.length - validPoints.length} of ${seriesData.length} points (${invalidPercentage.toFixed(1)}%) are missing required fields (filtered out) in series "${series.name || 'unnamed'}":`, {
                    xAxisChannel: series.xaxis?.name || 'not specified',
                    missingXCount: missingX,
                    missingDatetimeCount: missingDatetime,
                    missingTwaCount: missingTwa,
                    validPoints: validPoints.length
                  });
                }
              }
            } catch {}
          }
          
          return processedSeries;
        });
        
        return processedChart;
      });
  };

  const initializeCharts = async () => {
    // Prevent duplicate initialization during refresh/navigation
    if (isInitializing() || isFetchingData) {
      return;
    }
    resetAbortController();
    setIsInitializing(true);
    unifiedDataStore.setLoading('probability', true);
    setHasChartConfigButNoData(false);
    
    try {
      const { chart_info: chartsData, columns: loadedColumns } = await fetchCharts(abortController.signal);
      
      // Set columns from loaded config
      setColumns(loadedColumns);
      
      let updatedCharts;
      
      // Charts now handle their own data fetching
      updatedCharts = await fetchAndFormatData(chartsData, abortController.signal);
      
      try { info('📊 Probability: initializeCharts received charts', { chartCount: updatedCharts.length }); } catch {}
      
      // If no charts returned, show appropriate empty state (no config vs data not found)
      if (!updatedCharts || updatedCharts.length === 0) {
        setHasChartConfigButNoData(!!(chartsData?.length && chartsData.length > 0));
        warn('📊 Probability: No charts returned from data fetching');
        setCharts([]); // Explicitly set empty charts array
        return;
      }
      
      // Store original unfiltered charts for leg options derivation
      setOriginalCharts(updatedCharts);
      
      // Set originalData to unfiltered data before applying filters
      updatedCharts.forEach(chart => {
        chart.series.forEach(series => {
          if (!series.originalData) {
            series.originalData = [...series.data];
          }
        });
      });
      
      // Apply initial filters before setting charts
      try { info('📊 Probability: Applying initial filters', { filters: selectedStatesTimeseries(), races: selectedRacesTimeseries(), legs: selectedLegsTimeseries(), grades: selectedGradesTimeseries() }); } catch {}
      const filteredCharts = applyFiltersToCharts(updatedCharts);
      updateChartsWithStateCheck(filteredCharts, 'initializeCharts');
      
      // Option extraction now handled by Filters via unifiedDataStore.getFilterOptions()

      // Update class name based on chart count using centralized utility
      // class_name calculation is now handled by layoutClass memo
    } finally {
      setIsInitializing(false);
      unifiedDataStore.setLoading('probability', false);
    }
  };

  // Debounce timers
  let selectionDebounceTimer = null;
  let filterDebounceTimer = null;
  let chartUpdateTimer = null;
  
  // Centralized chart update function with state comparison
  const updateChartsWithStateCheck = (newCharts, reason = 'unknown') => {
    const currentCharts = charts();
    
    // Deep comparison to check if charts actually changed
    const chartsChanged = JSON.stringify(currentCharts) !== JSON.stringify(newCharts);
    
    if (chartsChanged) {
      try { info('📊 Probability: Updating charts', { reason, chartCount: newCharts.length }); } catch {}
      setCharts(newCharts);
    } else {
      try { debug('📊 Probability: Skipping chart update - no changes detected', { reason }); } catch {}
    }
  };
  
  const debouncedSelectionUpdate = (selection) => {
    if (selectionDebounceTimer) {
      clearTimeout(selectionDebounceTimer);
    }
    
    selectionDebounceTimer = setTimeout(() => {
      setEvents(selection);
      filterData();
      selectionDebounceTimer = null;
    }, 1000);
  };
  
  const debouncedFilterData = () => {
    if (filterDebounceTimer) {
      clearTimeout(filterDebounceTimer);
    }
    
    filterDebounceTimer = setTimeout(() => {
      filterData();
      filterDebounceTimer = null;
    }, 1000);
  };

  const handleFilterBy = (val) => {
    const value = removeLastChar(val, "S");
    
    if (filterDebounceTimer) {
      clearTimeout(filterDebounceTimer);
    }
    
    filterDebounceTimer = setTimeout(() => {
      batch(() => {
        setFiltertype(value);
        setTriggerUpdate(true);
      });
      filterDebounceTimer = null;
    }, 500);
  };

  const handleColorBy = (val) => {
    if (filterDebounceTimer) {
      clearTimeout(filterDebounceTimer);
    }
    
    filterDebounceTimer = setTimeout(() => {
      batch(() => {
        setColorType(val);
      });
      filterDebounceTimer = null;
    }, 500);
  };

  createEffect(async () => {
    if (triggerUpdate()) {
      try {
        resetAbortController();

        let event_info = [];
        if (filtertype() !== "NONE") {
          const event_info_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent(filtertype())}`, abortController.signal);
          event_info = event_info_json.success ? event_info_json.data : [];
          setEvents(event_info);
        } else {
          setEvents([]);
        }

        if (!abortController.signal.aborted) {
          filterData();
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          // Handle abort gracefully
        } else {
        }
      } finally {
        if (!abortController.signal.aborted) {
          setTriggerUpdate(false);
        }
      }
    }
  });

  createEffect(() => {
    if (updateCharts()) {
      setUpdateCharts(false);
    }
  });

  // Consolidated selection update effect
  createEffect(() => {
    const shouldTrigger = selectionTriggerUpdate();
    
    if (shouldTrigger) {
      if (selectionDebounceTimer) {
        clearTimeout(selectionDebounceTimer);
      }
      
      selectionDebounceTimer = setTimeout(() => {
        let event_info = [];
        
        if (selection() != [{}]) {
          if (selectedRange().length > 0) {
            const rangeItem = selectedRange()[0];
            event_info = [{
              start_time: rangeItem.start_time,
              end_time: rangeItem.end_time,
              event_type: 'RANGE'
            }];
          } else if (cutEvents().length > 0) {
            const cutItem = cutEvents()[0];
            event_info = [{
              start_time: cutItem.start_time,
              end_time: cutItem.end_time,
              event_type: 'CUT'
            }];
          }
        }
        
        setEvents(event_info);
        filterData();
        selectionDebounceTimer = null;
      }, 1000);
    }
  });

  // Initialize leg options when originalCharts is first populated
  createEffect(() => {
    const origCharts = originalCharts();
    
    if (origCharts.length > 0 && !isInitializing()) {
      debug('📊 Probability: Initializing leg options from originalCharts:', origCharts.length, 'charts');
      
      // Derive leg options from ORIGINAL unfiltered data
      const allData = origCharts.flatMap(chart => 
        chart.series.flatMap(series => series.data || [])
      );
      const legs = [...new Set(allData.map(d => d.Leg_number).filter(l => l != null && l !== undefined))].sort((a, b) => a - b);
      debug('📊 Probability: Leg options from original data:', legs, 'from', allData.length, 'data points');
      
      if (legs.length > 0) {
        setLegOptions(legs);
      }
    }
  });

  // Manual function to apply filters (called when Apply button is clicked)
  const applyFiltersManually = () => {
    const filters = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    
    debug('📊 Probability: Applying filters manually (Apply button clicked)', { filters, races, legs, grades });
    
    // Skip if no data available
    const origCharts = originalCharts();
    const origRawData = originalRawData();
    if (origCharts.length === 0 || origRawData.length === 0) {
      warn('📊 Probability: Cannot apply filters - no data available');
      return;
    }
    
    // Skip during initialization
    if (isInitializing()) return;
    
    // Get the chart config from original charts (needed for processing)
    const chartsData = origCharts.map(chart => ({
      ...chart,
      series: chart.series.map(series => ({
        ...series,
        // Reset data to allow re-processing
        data: []
      }))
    }));
    
    // Re-filter and re-process the raw data with new filters
    // This ensures probability is computed on the correctly filtered data
    const filteredData = filterByTwa(origRawData, filters, races, legs, grades);
    
    // Re-process the filtered data into charts
    const processedCharts = processDataIntoCharts(chartsData, filteredData);
    
    // CRITICAL: Use applyFiltersToCharts to apply any additional filtering logic and preserve chart identity
    // Since we've already filtered the raw data, this will mainly preserve chart structure and handle chart-specific filters
    const finalCharts = applyFiltersToCharts(processedCharts, filters, races, legs, grades);
    
    setCharts(finalCharts);
  };

  // DISABLED: Consolidated filtering effect - filters now only apply when Apply button is clicked
  // This allows users to change multiple filters before applying them all at once
  /*
  createEffect(() => {
    const filters = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    try { info('📊 Probability: Filter effect input', { filters, races, legs, grades }); } catch {}
    
    // Skip on initial mount when charts are empty (use untrack to avoid creating dependency)
    const origCharts = untrack(() => originalCharts());
    const origRawData = untrack(() => originalRawData());
    if (origCharts.length === 0 || origRawData.length === 0) return;
    
    // Skip during initialization
    if (isInitializing()) return;
    
    debug('📊 Probability: Filter signals changed, re-processing raw data with filters:', { filters, races, legs, grades });
    
    // Get the chart config from original charts (needed for processing)
    const chartsData = origCharts.map(chart => ({
      ...chart,
      series: chart.series.map(series => ({
        ...series,
        // Reset data to allow re-processing
        data: []
      }))
    }));
    
    // Re-filter and re-process the raw data with new filters
    // This ensures probability is computed on the correctly filtered data
    const filteredData = filterByTwa(origRawData, filters, races, legs, grades);
    
    // Re-process the filtered data into charts
    const processedCharts = processDataIntoCharts(chartsData, filteredData);
    
    // CRITICAL: Use applyFiltersToCharts to apply any additional filtering logic and preserve chart identity
    // Since we've already filtered the raw data, this will mainly preserve chart structure and handle chart-specific filters
    const finalCharts = applyFiltersToCharts(processedCharts, filters, races, legs, grades);
    
    setCharts(finalCharts);
  });
  */

  // React to selection changes (selectedRanges, cutEvents, etc.) and re-filter
  createEffect(() => {
    // Track selection signals for reactivity
    selectedRange();
    selectedRanges();
    cutEvents();
    hasSelection();
    isCut();
    
    // Skip on initial mount when charts are empty (use untrack to avoid creating dependency)
    const origCharts = untrack(() => originalCharts());
    if (origCharts.length === 0) return;
    
    // Skip during initialization
    if (isInitializing()) return;
    
    try { info('📊 Probability: Selection changed, re-filtering data', { 
      rangeLen: selectedRange().length, 
      rangesLen: selectedRanges().length, 
      cutLen: cutEvents().length,
      hasSelection: hasSelection(),
      isCut: isCut()
    }); } catch {}
    
    // Re-apply all filters (TWA + time-based)
    const filteredCharts = applyFiltersToCharts(origCharts);
    setCharts(filteredCharts);
  });

  // Toggle functions for race and leg filters (consistent with Scatter)
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

  // Set up scaling cleanup variable
  let cleanupScaling = null; // Store cleanup function for scaling

  onMount(async () => {
    await logPageLoad('Histogram.jsx', 'Histogram Analysis Report');
    initializeCharts();
    
    // Set up dynamic scaling for media-container using the global utility
    cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'Probability',
      scaleToWidth: true
    });
  });

  onCleanup(() => {
    abortController.abort();
    if (selectionDebounceTimer) {
      clearTimeout(selectionDebounceTimer);
    }
    if (filterDebounceTimer) {
      clearTimeout(filterDebounceTimer);
    }
    if (filteringTimer) {
      clearTimeout(filteringTimer);
    }
    if (chartUpdateTimer) {
      clearTimeout(chartUpdateTimer);
    }
    
    // Cleanup scaling observers
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
          onApply={applyFiltersManually}
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
          toggleRaceFilter={(race) => {
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
          }}
          toggleLegFilter={(leg) => {
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
          }}
          toggleGradeFilter={(grade) => {
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
          builderRoute={'/probability-builder'}
        />
      </Show>
      <div class="container relative" style={{
        "opacity": (unifiedDataStore.getLoading('probability') || isSelectionLoading()) ? 0.5 : 1, 
        "pointer-events": (unifiedDataStore.getLoading('probability') || isSelectionLoading()) ? "none" : "auto", 
        "transition": "opacity 0.5s ease", 
        }}>
        {/* Scrollable charts container - inner is scroll viewport per performance-page-scroll-fix.md */}
        <div class="performance-charts-scroll-container">
          <div class="performance-charts-scroll-inner" style={{ position: 'relative' }}>
          <Show when={!(unifiedDataStore.getLoading('probability') || isSelectionLoading() || isInitializing())}>
              <Show 
              when={charts().length > 0}
              fallback={
                <Show when={!isInitializing() && !unifiedDataStore.getLoading('probability')}>
                  <Show
                    when={hasChartConfigButNoData()}
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
                              navigate('/histogram-builder');
                            } else {
                              log('Probability: Cannot navigate to histogram-builder in split view');
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
                      builderRoute="/probability-builder"
                      onNavigateToBuilder={() => {
                        if (navigate) navigate('/histogram-builder');
                        else log('Probability: Cannot navigate to histogram-builder in split view');
                      }}
                    />
                  </Show>
                </Show>
              }
            >
              <div 
                class={layoutClass()}
                style={{
                  "padding-top": charts().length < 4 ? "15vh" : "50px"
                }}
              >
                 <For each={charts()}>{(chart, index) => {
                   const ChartComponent = getChartComponent(chart);
                   const chartKey = generateChartKey(chart, index());
                  return <ChartComponent key={chartKey} chart={chart} colortype={colorType()} class_name={layoutClass()} dataUpdateTrigger={dataUpdateTrigger()} />;
                 }}</For>
              </div>
            </Show>
          </Show>
          </div>
        </div>
      </div>
    </div>

    {/* Overlay loader positioned relative to main-content */}
    <Show when={isInitializing() || unifiedDataStore.getLoading('probability') || progress.isLoading()}>
      <div class="app-loading-overlay" style="padding-top: 25vh !important;">
        <Loading 
          message={progress.message()} 
          showProgress={true}
          progress={progress.progress()}
          progressMessage={progress.message()}
        />
      </div>
    </Show>
    </>
  );
}
