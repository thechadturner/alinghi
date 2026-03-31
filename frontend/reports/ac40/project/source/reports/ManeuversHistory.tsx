import { createSignal, onMount, createEffect, Show, on, untrack, createMemo, onCleanup } from "solid-js";

import DropDownButton from "../../../../../components/buttons/DropDownButton";

import DataTable_Big from "../../../../../components/maneuvers/standard/DataTable_Big";
import DataTable_Small from "../../../../../components/maneuvers/standard/DataTable_Small";
import Map from "../../../../../components/maneuvers/standard/Map";
import Scatter from "../../../../../components/maneuvers/standard/Scatter";
import TimeSeries from "../../../../../components/maneuvers/standard/TimeSeries";
import DataTable_BigGrouped from "../../../../../components/maneuvers/grouped/DataTable_Big";
import DataTable_SmallGrouped from "../../../../../components/maneuvers/grouped/DataTable_Small";
import MapGrouped from "../../../../../components/maneuvers/grouped/Map";
import ScatterGrouped from "../../../../../components/maneuvers/grouped/Scatter";
import TimeSeriesGrouped from "../../../../../components/maneuvers/grouped/TimeSeries";
import ScatterTimeseries from "../../../../../components/charts/ScatterTimeseries";

import { setupMediaContainerScaling } from "../../../../../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../../utils/logging";
import { error as logError, warn as logWarning, debug as logDebug } from "../../../../../utils/console";

import { phase, setPhase, color, setColor, tws, setTws, eventType, setEventType, grouped, groupDisplayMode, setGroupDisplayMode, maneuvers, setManeuvers, setTableData, setFiltered, filtered } from "../../../../../store/globalStore";
import { selectedEvents, setSelectedEvents, setTriggerUpdate, setTriggerSelection, setSelection, hasSelection, isCut, cutEvents, hideSelectedEvents, setSelectedGroupKeys } from "../../../../../store/selectionStore";

import { persistantStore } from "../../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { getData, getEventTimes, formatDateTime } from "../../../../../utils/global";
import ManeuverSettings from "../../../../../components/menus/ManeuverSettings";
import PerformanceFilterSummary from "../../../../../components/legends/PerformanceFilterSummary";
import { persistentSettingsService } from "../../../../../services/persistentSettingsService";
import { user } from "../../../../../store/userStore";
import {
  startDate,
  endDate,
  setStartDate,
  setEndDate,
  setSelectedGradesManeuvers,
  setSelectedStatesManeuvers,
  setSelectedRacesManeuvers,
  setSelectedLegsManeuvers,
  maneuverTrainingRacing,
  setManeuverTrainingRacing,
  setManeuverTimeseriesDescription,
  raceOptions as storeRaceOptions,
  legOptions as storeLegOptions,
  gradeOptions as storeGradeOptions,
  setRaceOptions as pushRaceOptionsToFilterStore,
  setLegOptions as pushLegOptionsToFilterStore,
  setGradeOptions as pushGradeOptionsToFilterStore,
} from "../../../../../store/filterStore";
import { sourcesStore } from "../../../../../store/sourcesStore";
import { legendTextToGroupKeyTable } from "../../../../../utils/colorGrouping";
import { TAKEOFF_CHANNELS } from "../../../../../utils/maneuversConfig";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedYear, selectedEvent } = persistantStore;

// Channels list for maneuvers endpoints - matches server_app/controllers/data.js lines 457-484
const MANEUVERS_CHANNELS = [
  'Tws_bin',
  'Tws_avg',
  'Twa_entry',
  'Twa_entry_n',
  'Vmg_perc_avg',
  'Loss_inv_tgt',
  'Loss_turn_tgt',
  'Loss_build_tgt',
  'Loss_total_tgt',
  'Mmg',
  'Bsp_drop',
  'Bsp_min',
  'Bsp_min_delta',
  'Drop_time',
  'Pop_time',
  'Time_two_boards',
  'Raise_time',
  'Accel_slope',
  'Decel_slope',
  'Lwy_max',
  'Turn_radius',
  'Accel_max',
  'Accel_min',
  'Twa_exit_n',
  'Twa_build_n',
  'Twa_drop_n',
  'Turn_rate_max',
  'Turn_angle_max',
  'Overshoot_angle',
  'Overshoot_perc',
  'Time_raising',
  'Time_dropping',
  'Rud_ang_max',
  'Twd_delta',
  'Rake_drop',
  'Aoa_drop',
  'Heel_drop',
  'Rake_raise',
  'Aoa_raise',
  'Pitch_raise',
  'Heel_lock',
  'Rake_min_old_turn',
  'Rake_max_new_turn',
  'Cant_drop_tgt'
];

export default function ManeuversHistoryPage() {
  // Use historical context for this component so map/timeseries work from event lists, not dataset_id
  const context = 'historical';
  
  const [eventTypes] = createSignal(['TACK','GYBE','ROUNDUP','BEARAWAY','TAKEOFF']);
  const [phases] = createSignal(['FULL','INVESTMENT','TURN','ACCELERATION']);
  const [colors] = createSignal(['TACK','TWS','VMG','YEAR','EVENT','CONFIG','STATE']);
  const [twsoptions, setTwsOptions] = createSignal<string[]>([]);

  const [views] = createSignal(['MAP','TABLE','SCATTER','TIME SERIES']);
  const [view, setView] = createSignal('MAP');
  const [groupedOptions] = createSignal<string[]>(['OFF','ON','MIX']);

  // Timeseries description options
  const [descriptionOptions, setDescriptionOptions] = createSignal<string[]>([]);
  const [selectedDescription, setSelectedDescription] = createSignal<string>('BASICS');

  // Filter state for ManeuverSettings
  const [raceOptions, setRaceOptions] = createSignal<(number | string)[]>([]);
  const [legOptions, setLegOptions] = createSignal<number[]>([]);
  const [gradeOptions, setGradeOptions] = createSignal<number[]>([]);
  const [stateOptions, setStateOptions] = createSignal<string[]>([]);
  const [selectedRaces, setSelectedRaces] = createSignal<(number | string)[]>([]);
  const [selectedLegs, setSelectedLegs] = createSignal<number[]>([]);
  const [selectedGrades, setSelectedGrades] = createSignal<number[]>([]);
  const [selectedStates, setSelectedStates] = createSignal<string[]>([]);

  // Timeline visibility state
  const [showTimeline, setShowTimeline] = createSignal<boolean>(true);

  // Handler for timeline changes
  const handleTimelineChange = (value: boolean) => {
    setShowTimeline(value);
  };

  // Aggregate data for timeline (maneuvers pages may need to fetch this separately)
  const [aggregatesAVG, setAggregatesAVG] = createSignal<any[]>([]);
  
  // Project-specific filter state (Year, Event, Config, State) - same as PerformanceHistory
  const [filterYear, setFilterYear] = createSignal('');
  const [filterEvent, setFilterEvent] = createSignal('');
  const [filterConfigValue, setFilterConfigValue] = createSignal('');
  const [filterState, setFilterState] = createSignal('');
  
  // Memoize view options to prevent SolidJS computation warnings
  const viewOptions = createMemo(() => {
    return grouped() ? ['MAP','TABLE','BOXES','TIME SERIES'] : views();
  });

  // Abort controllers for canceling requests
  let tableDataController: AbortController | null = null;
  let timesController: AbortController | null = null;

  // Fetch timeseries description options from API
  const fetchTimeseriesOptions = async () => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        logDebug('ManeuversHistory: Cannot fetch timeseries options - missing className or projectId');
        return;
      }

      const result = await getData(
        `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&object_name=maneuver_timeseries_options`
      );

      if (result?.success && result?.data?.data && Array.isArray(result.data.data)) {
        const options = result.data.data.map((opt: string) => String(opt).toUpperCase());
        setDescriptionOptions(options);
        let nextDesc = selectedDescription();
        if (options.length > 0 && !options.includes(nextDesc)) {
          nextDesc = options[0];
          setSelectedDescription(nextDesc);
        }
        setManeuverTimeseriesDescription(nextDesc);
        logDebug('ManeuversHistory: Loaded timeseries description options:', options);
      } else {
        logWarning('ManeuversHistory: Failed to fetch timeseries options or invalid response:', result);
        // Default fallback
        setDescriptionOptions(['BASICS']);
        setSelectedDescription('BASICS');
        setManeuverTimeseriesDescription('BASICS');
      }
    } catch (error: any) {
      logError('ManeuversHistory: Error fetching timeseries options:', error);
      // Default fallback
      setDescriptionOptions(['BASICS']);
      setSelectedDescription('BASICS');
      setManeuverTimeseriesDescription('BASICS');
    }
  };

  const handleDescription = (val: string) => {
    setSelectedDescription(val);
    setManeuverTimeseriesDescription(val);
    setTriggerUpdate(true);
  };

  // Track if initial data load has completed
  const [dataLoaded, setDataLoaded] = createSignal(false);
  
  // Track calculated date range (start date = 1 year before latest date, end date = latest date)
  const [calculatedStartDate, setCalculatedStartDate] = createSignal<string | null>(null);
  const [calculatedEndDate, setCalculatedEndDate] = createSignal<string | null>(null);
  const [isInitialDateCalculation, setIsInitialDateCalculation] = createSignal(true);

  // Helper function to find latest date from data and calculate date range
  const calculateDateRangeFromData = (data: any[]): { startDate: string; endDate: string } | null => {
    if (!data || data.length === 0) {
      return null;
    }

    // Find the latest date from the Datetime field (check multiple possible field names)
    let latestDate: Date | null = null;
    data.forEach((item: any) => {
      // Check multiple possible field names (case-insensitive)
      const datetime = item.datetime || item.Datetime || item.DATETIME || item.date || item.Date;
      if (datetime) {
        const date = new Date(datetime);
        if (!isNaN(date.getTime())) {
          if (!latestDate || date > latestDate) {
            latestDate = date;
          }
        }
      }
    });

    if (!latestDate) {
      logWarning('ManeuversHistory: Could not find datetime field in data, using wide date range');
      return null;
    }

    // Calculate start date as 1 year before latest date
    const endDate = latestDate;
    const startDate = new Date(endDate);
    startDate.setFullYear(startDate.getFullYear() - 1);

    // Format dates as YYYY-MM-DD
    const formatDate = (d: Date): string => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    };
  };

  const fetchTableData = async () => {
    // Cancel previous request if still pending
    if (tableDataController) {
      tableDataController.abort();
    }

    // Create new abort controller
    tableDataController = new AbortController();

    // Capture event type for this request so we don't apply a stale response over current type
    const requestEventType = (eventType() || 'TACK').trim() || 'TACK';

    // Reset dataLoaded at the start of each fetch
    setDataLoaded(false);

    try {
      // Build filters object - use uppercase keys and array values
      const filters: Record<string, any[]> = {};
      
      // Parse grades (comma-separated, convert to integers)
      const grades = selectedGrades();
      if (grades.length > 0) {
        filters.GRADE = grades;
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
      if (filterConfigValue().trim()) {
        const configs = filterConfigValue().split(',').map(c => c.trim()).filter(c => c.length > 0);
        if (configs.length > 0) {
          filters.CONFIG = configs;
        }
      }

      // Parse state (comma-separated strings) - note: STATE is handled client-side for maneuvers
      // But we can still pass it to API if the API supports it
      if (filterState().trim()) {
        const states = filterState().split(',').map(s => s.trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
        if (states.length > 0) {
          filters.STATE = states;
        }
      }

      // Training/Racing filter: pass to API so SQL can filter (racing = exclude training, training = only training)
      const trainingRacingVal = maneuverTrainingRacing();
      if (trainingRacingVal === 'TRAINING' || trainingRacingVal === 'RACING') {
        filters.TRAINING_RACING = [trainingRacingVal];
      }

      // Get date range from filterStore (for project mode) or use calculated range
      let startDateValue: string;
      let endDateValue: string;
      
      // Use filterStore dates if available (project mode), otherwise use calculated range
      const filterStoreStart = startDate();
      const filterStoreEnd = endDate();
      
      if (filterStoreStart && filterStoreEnd) {
        startDateValue = filterStoreStart;
        endDateValue = filterStoreEnd;
      } else if (isInitialDateCalculation() || !calculatedStartDate() || !calculatedEndDate()) {
        // Initial query: use wide range to get all data
        startDateValue = '2020-01-01';
        endDateValue = '2099-12-31';
      } else {
        // Use calculated date range (1 year before latest date to latest date)
        startDateValue = calculatedStartDate()!;
        endDateValue = calculatedEndDate()!;
        // Update filterStore so Map and TimeSeries components can access the date range
        setStartDate(startDateValue);
        setEndDate(endDateValue);
        logDebug('ManeuversHistory: Updated filterStore with calculated date range', { startDate: startDateValue, endDate: endDateValue });
      }

      // Get source name from source_id for the new endpoint (requires source_names instead of source_id)
      const sourceId = selectedSourceId();
      let sourceNames: string[] = [];
      if (sourceId && sourceId > 0) {
        // Wait for sourcesStore to be ready
        if (sourcesStore.isReady()) {
          const sourceName = sourcesStore.getSourceName(sourceId);
          if (sourceName) {
            sourceNames = [sourceName];
          } else {
            logWarning('ManeuversHistory: Source not found for source_id', sourceId);
            return;
          }
        } else {
          logWarning('ManeuversHistory: sourcesStore not ready, cannot get source name');
          return;
        }
      } else {
        logWarning('ManeuversHistory: No source_id for historical maneuvers');
        return;
      }

      // For TAKEOFF, request only takeoff-relevant channels (not tack/gybe columns)
      const channelsToRequest = (requestEventType || '').toUpperCase() === 'TAKEOFF'
        ? ['twa_entry', ...TAKEOFF_CHANNELS]
        : MANEUVERS_CHANNELS;
      // Build URL with channels and optional filters - use new simplified endpoint
      let url = `${apiEndpoints.app.data}/maneuvers-history?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_names=${encodeURIComponent(JSON.stringify(sourceNames))}&start_date=${encodeURIComponent(startDateValue)}&end_date=${encodeURIComponent(endDateValue)}&event_type=${encodeURIComponent(requestEventType)}&channels=${encodeURIComponent(JSON.stringify(channelsToRequest))}`;
      if (Object.keys(filters).length > 0) {
        url += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
      }

      let result_json = await getData(url, tableDataController.signal);

      // Check if request was cancelled (getData returns this instead of throwing)
      if (result_json?.type === 'AbortError' || result_json?.error === 'Request cancelled') {
        // Request was cancelled - this is expected, no error needed
        return;
      }

      // Ignore response if user changed maneuver type before this request completed (avoid stale overwrite)
      if ((eventType() || 'TACK').trim() !== requestEventType) {
        return;
      }

      if (result_json.success && result_json.data && Array.isArray(result_json.data)) {
        let data = result_json.data

        // Add datetimeLocal (dataset local time) for table and tooltips
        data.forEach((item: any) => {
          const tz = (item.timezone ?? item.Timezone ?? "").trim() || undefined;
          const rawDt = item.Datetime ?? item.datetime;
          if (tz && rawDt != null && rawDt !== "") {
            try {
              const formatted = formatDateTime(rawDt, tz);
              if (formatted) item.datetimeLocal = formatted;
            } catch {
              // leave datetimeLocal undefined
            }
          }
        });

        // On initial load, calculate date range from data and refetch if needed
        if (isInitialDateCalculation() && data.length > 0) {
          const dateRange = calculateDateRangeFromData(data);
          if (dateRange) {
            setCalculatedStartDate(dateRange.startDate);
            setCalculatedEndDate(dateRange.endDate);
            setIsInitialDateCalculation(false);
            logDebug('ManeuversHistory: Calculated date range from data', dateRange);
            
            // Update filterStore so Map and TimeSeries components can access the date range
            setStartDate(dateRange.startDate);
            setEndDate(dateRange.endDate);
            logDebug('ManeuversHistory: Updated filterStore with calculated date range', dateRange);
            
            // Refetch with calculated date range
            // Don't reset dataLoaded here as we'll set it after the refetch
            await fetchTableData();
            return;
          }
        }

        // TAKEOFF, BEARAWAY, ROUNDUP: Port/Stbd from entry or build TWA; otherwise by phase
        const evt = (requestEventType || '').toUpperCase();
        const usePortStbd = evt === 'TAKEOFF' || evt === 'BEARAWAY' || evt === 'ROUNDUP';
        if (usePortStbd) {
          data.forEach((item: any) => {
            const twa = item.twa_entry ?? item.twa_build ?? item.Twa_start ?? 0;
            item.tack = Number(twa) > 0 ? 'STBD' : 'PORT';
          });
        } else if (phase() == 'FULL' || phase() == 'TURN') {
          data.forEach((item) => {
            item.tack = item.twa_entry > 0 ? 'S - P' : 'P - S';
          });
        } else if (phase() == 'INVESTMENT') {
          data.forEach((item) => {
            item.tack = item.twa_entry > 0 ? 'STBD' : 'PORT';
          });
        } else {
          data.forEach((item) => {
            item.tack = item.twa_entry > 0 ? 'PORT' : 'STBD';
          });
        }

        // Generate TWS bins in intervals of 5 starting from the closest increment to the minimum
        // Extract all TWS values from data
        const twsValues: number[] = [];
        data.forEach((item: any) => {
          const twsBin = item.tws_bin ?? item.tws_avg;
          if (twsBin !== null && twsBin !== undefined && !isNaN(Number(twsBin))) {
            twsValues.push(Number(twsBin));
          }
        });
        
        // Generate bins in increments of 5 starting from the minimum
        let tws_bins: string[] = ['ALL'];
        if (twsValues.length > 0) {
          const minTws = Math.min(...twsValues);
          const maxTws = Math.max(...twsValues);
          
          // Round down to nearest multiple of 5 for start
          const startBin = Math.floor(minTws / 5) * 5;
          // Round up to nearest multiple of 5 for end, then add one more increment
          const endBin = Math.ceil(maxTws / 5) * 5 + 5;
          
          // Generate bins in increments of 5
          for (let bin = startBin; bin <= endBin; bin += 5) {
            tws_bins.push(String(bin));
          }
        }
        
        setTwsOptions(tws_bins)
        
        // Extract State options from data
        const stateValues = new Set<string>();
        data.forEach((item: any) => {
          const state = item.State ?? item.state ?? item.STATE;
          if (state != null && state !== undefined && String(state).trim() !== '') {
            stateValues.add(String(state).trim());
          }
        });
        const sortedStates = Array.from(stateValues).sort();
        setStateOptions(sortedStates);
        
        // Select middle TWS option on load (skip 'ALL' when calculating middle)
        if (tws_bins.length > 1) {
          const numericBins = tws_bins.slice(1); // Skip 'ALL'
          const middleIndex = Math.floor(numericBins.length / 2);
          const middleTws = numericBins[middleIndex];
          if (tws() === 'ALL' || !tws_bins.includes(tws())) {
            handleTws(middleTws);
          }
        }

        setManeuvers(data)

        const eventIds = data.map(item => item.event_id);
        setFiltered(eventIds)
        setSelection(eventIds)

        // Pass data directly to filterData to avoid race condition with store updates
        filterData(data)
      } else {
        // Handle API error response - reset to empty state only if this response is still current
        if ((eventType() || 'TACK').trim() === requestEventType) {
          logWarning('Failed to fetch table data:', result_json.message || 'Unknown error');
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          setTwsOptions(['ALL']);
          if (tws() !== 'ALL') {
            setTws('ALL');
          }
        }
      }
      setDataLoaded(true);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Request was cancelled - this is expected, no error needed
      } else {
        if ((eventType() || 'TACK').trim() === requestEventType) {
          logError('Error fetching table data:', error);
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          setTwsOptions(['ALL']);
          if (tws() !== 'ALL') {
            setTws('ALL');
          }
        }
      }
      setDataLoaded(true);
    } finally {
      tableDataController = null;
    }
  }

  const handleEventType = (val: string) => {
    const prev = (eventType() || '').trim().toUpperCase();
    setEventType(val);
    const valUpper = (val || '').trim().toUpperCase();
    if (valUpper === 'TAKEOFF') {
      setSelectedStates([]);
      setSelectedStatesManeuvers([]);
      logDebug('ManeuversHistory: TAKEOFF selected — cleared state filters');
    } else if (prev === 'TAKEOFF') {
      loadFiltersFromPersistentSettings();
      logDebug('ManeuversHistory: Left TAKEOFF — restored persistent filters');
    }
  };

  const handlePhase = (val: string) => {
    setPhase(val)
    setTriggerUpdate(true);
  };

  const handleView = async (val: string) => {
    const normalized = (val === 'BOXES') ? 'SCATTER' : val;
    setView(normalized)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'ManeuversHistory.tsx', 'Maneuvers History Report', `View changed to ${normalized}`);
    setTriggerUpdate(true);
  };

  const handleColor = async (val: string) => {
    setColor(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'ManeuversHistory.tsx', 'Maneuvers History Report', `Color changed to ${val}`);
    setTriggerUpdate(true)
  };

  const filterData = (dataOverride?: any[]) => {
    // Use provided data or read from store - this avoids race conditions
    const maneuversData = dataOverride ?? maneuvers();
    if (!maneuversData || !Array.isArray(maneuversData) || maneuversData.length === 0) {
      setFiltered([]);
      setTableData([]);
      return;
    }

    let filteredData_tws = []

    if (tws() == 'ALL') {
      filteredData_tws = maneuversData;
    } else {
      // For ac40, filter by TWS bin (intervals of 5, ±2.5 from selected value)
      const selectedTws = Number(tws());
      if (!isNaN(selectedTws)) {
        filteredData_tws = maneuversData.filter((item: any) => {
          const itemTws = item.tws_bin ?? item.tws_avg;
          if (itemTws === null || itemTws === undefined || isNaN(Number(itemTws))) {
            return false;
          }
          const itemTwsNum = Number(itemTws);
          // Filter within ±2.5 of the selected bin value
          // Bin 10 includes values from 7.5 to 12.5 (exclusive on upper bound to avoid overlap)
          const minTws = selectedTws - 2.5;
          const maxTws = selectedTws + 2.5;
          return itemTwsNum >= minTws && itemTwsNum < maxTws;
        });
      } else {
        filteredData_tws = [];
      }
    }

    // Start with TWS-filtered data, then apply additional filters
    let filteredData: typeof maneuversData = filteredData_tws;

    // Apply grade filter using selectedGrades array - use "greater than" logic
    // Use lowercase field names as primary with fallbacks for backward compatibility
    const grades = selectedGrades();
    if (grades.length > 0) {
      // For radio button behavior, only the first selected grade is used
      // Filter for grades greater than the selected grade
      const minGrade = Math.min(...grades.map(g => Number(g)).filter(g => !isNaN(g)));
      filteredData = filteredData_tws.filter((item: any) => {
        const itemGrade = item.grade ?? item.Grade ?? item.GRADE;
        if (itemGrade == null || itemGrade === undefined) return false;
        const numGrade = Number(itemGrade);
        if (isNaN(numGrade)) return false;
        return numGrade > minGrade;
      });
    }

    // Apply state filter using selectedStates array
    // Use lowercase field names as primary with fallbacks for backward compatibility
    const states = selectedStates();
    if (states.length > 0) {
      filteredData = filteredData.filter((item: any) => {
        const itemState = item.state ?? item.State ?? item.STATE;
        if (itemState == null || itemState === undefined) return false;
        const stateStr = String(itemState).trim();
        return states.some(selectedState => String(selectedState).trim().toLowerCase() === stateStr.toLowerCase());
      });
    }

    // Apply race filter using selectedRaces array
    // Use lowercase field names as primary with fallbacks for backward compatibility
    const races = selectedRaces();
    if (races.length > 0) {
      filteredData = filteredData.filter((item: any) => {
        const raceValue = item.race_number ?? item.Race_number ?? item.race ?? item.Race;
        if (raceValue == null || raceValue === undefined) return false;
        // Handle TRAINING case
        if (raceValue === -1 || raceValue === '-1') {
          return races.includes('TRAINING') || races.includes('training');
        }
        return races.some(selectedRace => {
          if (selectedRace === 'TRAINING' || selectedRace === 'training') return false;
          return Number(raceValue) === Number(selectedRace);
        });
      });
    }

    // Apply leg filter using selectedLegs array
    // Use lowercase field names as primary with fallbacks for backward compatibility
    const legs = selectedLegs();
    if (legs.length > 0) {
      filteredData = filteredData.filter((item: any) => {
        const legValue = item.leg_number ?? item.Leg_number ?? item.LEG;
        if (legValue == null || legValue === undefined) return false;
        return legs.includes(Number(legValue));
      });
    }

    // Apply Training/Racing filter: when "RACING" (race maneuvers only), exclude TRAINING (Race_number <= 0)
    const trainingRacing = maneuverTrainingRacing();
    if (trainingRacing === 'RACING') {
      filteredData = filteredData.filter((item: any) => {
        const raceValue = item.race_number ?? item.Race_number ?? item.race ?? item.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return !isTraining;
      });
    } else if (trainingRacing === 'TRAINING') {
      filteredData = filteredData.filter((item: any) => {
        const raceValue = item.race_number ?? item.Race_number ?? item.race ?? item.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return isTraining;
      });
    }

    // If we have cut events, only show the cut maneuvers
    if (isCut() && cutEvents().length > 0) {
      const currentCutEvents = cutEvents();
      // Extract event IDs from cutEvents (handles both time range objects and event IDs)
      const cutEventIds = currentCutEvents.map(item => {
        if (typeof item === 'number') {
          return item; // Already an event ID
        } else if (item && typeof item === 'object' && 'event_id' in item) {
          return item.event_id; // Extract event_id from time range object
        }
        return null;
      }).filter(id => id !== null);
      
      if (cutEventIds.length > 0) {
        filteredData = filteredData.filter(maneuver => 
          cutEventIds.includes(maneuver.event_id)
        );
      } else {
        // If no valid event IDs found, show nothing (cut mode but no matching events)
        filteredData = [];
      }
    }

    // Sort by vmg_perc_avg descending
    filteredData.sort((a, b) => {
      const aVmg = a.vmg_perc_avg ?? 0;
      const bVmg = b.vmg_perc_avg ?? 0;
      return bVmg - aVmg; // Descending order
    });

    const eventIds = filteredData.map(item => item.event_id);

    setFiltered(eventIds)
    setTableData(filteredData)
    
    // Update selection to match filtered data (but don't override user's active selection)
    if (!hasSelection()) {
      setSelection(eventIds)
    }

    setTriggerUpdate(true)
  }

  const handleTws = async (val: string) => {
    setTws(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'ManeuversHistory.tsx', 'Maneuvers History Report', `TWS changed to ${val}`);
    filterData()
  };

  // Filter toggle handlers
  const toggleRaceFilter = (race: number | string) => {
    const current = selectedRaces();
    const next = current.includes(race) 
      ? current.filter(r => r !== race)
      : [...current, race];
    setSelectedRaces(next);
    setSelectedRacesManeuvers(next.map(r => String(r)));
  };

  const toggleLegFilter = (leg: number) => {
    const current = selectedLegs();
    const next = current.includes(leg)
      ? current.filter(l => l !== leg)
      : [...current, leg];
    setSelectedLegs(next);
    setSelectedLegsManeuvers(next.map(l => String(l)));
  };

  const toggleGradeFilter = (grade: number) => {
    const current = selectedGrades();
    const next = current.includes(grade)
      ? []
      : [grade];
    setSelectedGrades(next);
    setSelectedGradesManeuvers(next.map(g => String(g)));
  };

  const toggleStateFilter = (state: string) => {
    const current = selectedStates();
    const next = current.includes(state)
      ? current.filter(s => s !== state)
      : [...current, state];
    setSelectedStates(next);
    setSelectedStatesManeuvers(next);
  };

  createEffect(() => {
    const rLocal = raceOptions().map((x) => String(x));
    const lLocal = legOptions().map((x) => String(x));
    const gLocal = gradeOptions().map((x) => String(x));
    const rs = storeRaceOptions().map((x) => String(x));
    const ls = storeLegOptions().map((x) => String(x));
    const gs = storeGradeOptions().map((x) => String(x));
    if (JSON.stringify([...rLocal].sort()) !== JSON.stringify([...rs].sort())) {
      pushRaceOptionsToFilterStore(rLocal);
    }
    if (JSON.stringify([...lLocal].sort()) !== JSON.stringify([...ls].sort())) {
      pushLegOptionsToFilterStore(lLocal);
    }
    if (JSON.stringify([...gLocal].sort()) !== JSON.stringify([...gs].sort())) {
      pushGradeOptionsToFilterStore(gLocal);
    }
  });

  // Calculate VMG intervals (same logic as Scatter component)
  const calculateVmgIntervals = (rows: any[]) => {
    const vmgValues = rows
      .map(r => parseFloat(r.vmg_perc_avg))
      .filter(v => !isNaN(v) && v !== null && v !== undefined);
    
    if (vmgValues.length === 0) return null;
    
    const min = Math.min(...vmgValues);
    const max = Math.max(...vmgValues);
    
    if (min === max) {
      return {
        min,
        max,
        intervalSize: 0,
        getInterval: () => `${min.toFixed(1)}-${max.toFixed(1)}`
      };
    }
    
    const intervalSize = (max - min) / 5;
    
    return {
      min,
      max,
      intervalSize,
      getInterval: (vmg: number) => {
        if (vmg < min || vmg > max) return null;
        const intervalIndex = Math.min(4, Math.floor((vmg - min) / intervalSize));
        const intervalMin = min + (intervalIndex * intervalSize);
        const intervalMax = intervalIndex === 4 ? max : min + ((intervalIndex + 1) * intervalSize);
        return `${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`;
      }
    };
  };

  const handleLegendClick = (legendItem: string) => {
    // In grouped mode, legend toggles group selection (same key format and toggle as grouped DataTable)
    if (grouped()) {
      const key = legendTextToGroupKeyTable(legendItem, color() || 'TWS');
      setSelectedGroupKeys((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      );
      setTriggerSelection(true);
      return;
    }

    // Use full maneuvers data for selection - don't filter by cuts when selecting
    const dataSource = maneuvers();
    if (!dataSource || !Array.isArray(dataSource) || dataSource.length === 0) {
      logWarning('ManeuversHistory: Legend click on', legendItem, '- no maneuvers data available');
      return;
    }

    const currentColorField = color();
    const clickedItem = String(legendItem);
    
    // For VMG intervals, calculate from the same filtered data that the legend uses
    // This ensures intervals match what's shown in the legend
    const filteredData = dataSource.filter((m: any) => filtered().includes(m.event_id));
    const intervalCalculationData = currentColorField === 'VMG' ? filteredData : dataSource;
    
    // Filter maneuvers by current color field matching the clicked legend item
    const legendEntryIds = dataSource
      .filter((m: any) => {
        // Special handling for VMG intervals - use same calculation logic as getInterval
        if (currentColorField === 'VMG') {
          const vmgIntervals = calculateVmgIntervals(intervalCalculationData);
          if (!vmgIntervals) return false;
          
          const vmgValue = parseFloat(m.vmg_perc_avg);
          if (isNaN(vmgValue)) return false;
          
          // Calculate which interval this value belongs to using the same logic as getInterval
          const calculatedInterval = vmgIntervals.getInterval(vmgValue);
          if (!calculatedInterval) return false;
          
          // Compare the calculated interval string with the clicked item
          // Handle potential floating point precision differences by comparing the parsed values
          const calculatedMatch = calculatedInterval.match(/^([\d.]+)-([\d.]+)$/);
          const clickedMatch = clickedItem.match(/^([\d.]+)-([\d.]+)$/);
          
          if (!calculatedMatch || !clickedMatch) return false;
          
          const calcMin = parseFloat(calculatedMatch[1]);
          const calcMax = parseFloat(calculatedMatch[2]);
          const clickMin = parseFloat(clickedMatch[1]);
          const clickMax = parseFloat(clickedMatch[2]);
          
          // Compare with small tolerance for floating point precision
          const tolerance = 0.01;
          return Math.abs(calcMin - clickMin) < tolerance && Math.abs(calcMax - clickMax) < tolerance;
        }
        
        // Special handling for TWS bins - compare numeric values
        if (currentColorField === 'TWS') {
          const twsBin = m.tws_bin;
          const clickedBin = clickedItem;
          
          // Try numeric comparison first
          const twsNum = Number(twsBin);
          const clickedNum = Number(clickedBin);
          if (!isNaN(twsNum) && !isNaN(clickedNum) && twsNum === clickedNum) {
            return true;
          }
          
          // Fallback to string comparison
          return String(twsBin) === clickedBin;
        }
        
        // Special handling for TACK - normalize values
        if (currentColorField === 'TACK') {
          const tackValue = String(m.tack || '').toUpperCase();
          const clickedTack = clickedItem.toUpperCase();
          // Handle both 'PORT'/'STBD' and 'S - P'/'P - S' formats
          if ((tackValue === 'PORT' || tackValue === 'S - P') && (clickedTack === 'PORT' || clickedTack === 'S - P')) {
            return true;
          }
          if ((tackValue === 'STBD' || tackValue === 'P - S') && (clickedTack === 'STBD' || clickedTack === 'P - S')) {
            return true;
          }
          return false;
        }
        
        if (currentColorField === 'RACE') {
          const raceValue = m.race ?? m.Race_number ?? m.race_number;
          const clickedStr = clickedItem;
          
          // Try exact match
          if (String(raceValue) === clickedStr) return true;
          
          // Try numeric comparison if both are numeric
          const raceNum = Number(raceValue);
          const clickedNum = Number(clickedStr);
          if (!isNaN(raceNum) && !isNaN(clickedNum) && raceNum === clickedNum) return true;
          
          // Try case-insensitive match
          if (raceValue && String(raceValue).toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // For SOURCE - check source_name field
        if (currentColorField === 'SOURCE') {
          const sourceValue = m.source_name ?? m.sourceName ?? m.source;
          const clickedStr = clickedItem;
          
          // Try exact match
          if (String(sourceValue) === clickedStr) return true;
          
          // Try case-insensitive match
          if (sourceValue && String(sourceValue).toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // Default: try to match any field with the clicked value
        const fieldValueStr = m[currentColorField.toLowerCase()] ?? m[currentColorField];
        if (fieldValueStr === undefined || fieldValueStr === null) return false;
        
        // Try exact match
        if (String(fieldValueStr) === clickedItem) return true;
        
        // Try numeric comparison if both are numeric
        const fieldNum = Number(fieldValueStr);
        const clickedNum = Number(clickedItem);
        if (!isNaN(fieldNum) && !isNaN(clickedNum) && fieldNum === clickedNum) return true;
        
        // Try case-insensitive string match
        if (String(fieldValueStr).toLowerCase() === clickedItem.toLowerCase()) return true;
        
        return false;
      })
      .map((m: any) => m.event_id)
      .filter((id): id is number => id !== undefined && id !== null && !isNaN(Number(id)));

    if (legendEntryIds.length === 0) {
      logWarning('ManeuversHistory: Legend click on', legendItem, '- no matching event IDs found');
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
      logDebug('ManeuversHistory: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'event IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      logDebug('ManeuversHistory: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'event IDs');
    }
    
    // Trigger update to refresh views
    setTriggerUpdate(true);
  };

  // React to source changes - reset date calculation when source changes
  createEffect(() => {
    const sourceId = selectedSourceId();
    if (sourceId) {
      // Reset date calculation when source changes
      setCalculatedStartDate(null);
      setCalculatedEndDate(null);
      setIsInitialDateCalculation(true);
      logDebug('ManeuversHistory: Source changed, resetting date calculation');
    }
  });

  // React to eventType changes - use normalized value so we still fetch when eventType is empty (treat as TACK)
  createEffect(
    on(
      [eventType],
      async () => {
        const et = (eventType() || 'TACK').trim() || 'TACK';
        if (et) await untrack(() => fetchTableData());
      },
      { defer: true }
    )
  );

  // React to date range changes - refetch when startDate/endDate change (e.g. from filter UI)
  createEffect(
    on(
      [startDate, endDate],
      async ([start, end]) => {
        const et = (eventType() || 'TACK').trim() || 'TACK';
        if (start && end && selectedSourceId() && et) await untrack(() => fetchTableData());
      },
      { defer: true }
    )
  );

  // React to cut events - refilter when cut state changes
  createEffect(on([isCut], () => {
    if (untrack(() => maneuvers().length > 0)) {
      filterData();
    }
  }));

  // React to filter changes - refetch when grades or training/racing change (API-based filtering).
  // Use on() so we only track these deps; fetchTableData inside untrack to avoid tracking its internal reads.
  let lastFilterSnapshot = '';
  createEffect(
    on(
      [selectedGrades, maneuverTrainingRacing],
      async ([grades, trainingRacing]) => {
        const snapshot = JSON.stringify([...(grades || [])].sort()) + '|' + (trainingRacing ?? '');
        if (snapshot === lastFilterSnapshot) return;
        lastFilterSnapshot = snapshot;
        if (untrack(() => dataLoaded())) {
          await untrack(() => fetchTableData());
        }
      },
      { defer: true }
    )
  );

  // React to view changes - update container heights when view changes
  createEffect(() => {
    // Access view() to trigger effect
    view();
    // Use setTimeout to ensure DOM has updated
    setTimeout(() => {
      const headerHeight = 58;
      
      // For MAP view: need extra spacing for padding, button area, and margins
      const additionalSpacingForMap = 100;
      const mapHeight = window.innerHeight - headerHeight - additionalSpacingForMap;
      
      // For TABLE view: account for header, padding, and button area
      const additionalSpacingForTable = 80; // Account for padding-top and button area
      const tableHeight = window.innerHeight - headerHeight - additionalSpacingForTable;
      
      const mapLayout = document.querySelector('.maneuver-map-layout') as HTMLElement | null;
      const tableWrapper = document.getElementById('datatable-big-wrapper') as HTMLElement | null;
      
      if (mapLayout) {
        mapLayout.style.height = `${mapHeight}px`;
        mapLayout.style.minHeight = `${mapHeight}px`;
      }
      
      if (tableWrapper) {
        tableWrapper.style.height = `${tableHeight}px`;
      }
      
      // Sync table height with map SVG height for MAP view
      if (view() === 'MAP') {
        setTimeout(() => {
          syncTableHeightWithMap();
        }, 200); // Longer delay to ensure map SVG is fully rendered
      }
    }, 0);
  });

  createEffect(async () => {
    if (selectedEvents().length > 0) {
      // Endpoint requires dataset_id > 0 OR (source_id and date). Skip when we don't have a valid dataset.
      const datasetId = selectedDatasetId();
      if (!datasetId || datasetId <= 0) {
        logDebug('ManeuversHistory: Skipping times fetch (dataset_id required)');
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
        setSelection(result.data)
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {

        } else {
          logError('Error fetching times:', error);
        }
      } finally {
        timesController = null;
      }
    }
  });

  // Function to sync table height with map SVG height
  const syncTableHeightWithMap = () => {
    if (view() !== 'MAP') return;
    
    const mapElement = document.querySelector('#maneuver-map') as HTMLElement | null;
    const tableArea = document.getElementById('table-area') as HTMLElement | null;
    
    if (mapElement && tableArea) {
      // Get the actual height of the map element (including SVG)
      const mapHeight = mapElement.offsetHeight || mapElement.clientHeight;
      
      // Set table area to match map height
      if (mapHeight > 0) {
        tableArea.style.height = `${mapHeight}px`;
        tableArea.style.minHeight = `${mapHeight}px`;
      }
    }
  };

  // Function to update container heights based on actual viewport (full screen)
  const updateContainerHeights = () => {
    // Get the actual available height from the viewport (full screen)
    // Header height is 58px (50px + 8px padding)
    const headerHeight = 58;
    
    // For MAP view: need extra spacing for padding, button area, and margins
    const additionalSpacingForMap = 100; // Account for padding, button area, and margins
    const mapHeight = window.innerHeight - headerHeight - additionalSpacingForMap;
    
    // For TABLE view: account for header, padding, and button area
    const additionalSpacingForTable = 80; // Account for padding-top and button area
    const tableHeight = window.innerHeight - headerHeight - additionalSpacingForTable;
    
    // Update heights dynamically for all views
    const mapLayout = document.querySelector('.maneuver-map-layout') as HTMLElement | null;
    const tableWrapper = document.getElementById('datatable-big-wrapper') as HTMLElement | null;
    
    if (mapLayout) {
      mapLayout.style.height = `${mapHeight}px`;
      mapLayout.style.minHeight = `${mapHeight}px`;
    }
    
    if (tableWrapper) {
      tableWrapper.style.height = `${tableHeight}px`;
    }
    
    // Sync table height with map SVG height for MAP view
    setTimeout(() => {
      syncTableHeightWithMap();
    }, 100); // Small delay to ensure map is rendered
  };
  
  // Function to observe sidebar for collapse/expand changes
  const observeSidebar = () => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return null;
    
    const observer = new MutationObserver(() => {
      // When sidebar class changes (collapsed/expanded), update heights
      updateContainerHeights();
    });
    
    observer.observe(sidebar, {
      attributes: true,
      attributeFilter: ['class']
    });
    
    return observer;
  };

  // Load filters from persistent settings
  const loadFiltersFromPersistentSettings = async () => {
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

          logDebug('ManeuversHistory: Loaded settings from persistent settings', settings);
          let gradesLoaded = false;
          let statesLoaded = false;
          if (settings?.maneuverFilters) {
            const filters = settings.maneuverFilters;
            if (filters.grades && Array.isArray(filters.grades) && filters.grades.length > 0) {
              setSelectedGrades(filters.grades);
              setSelectedGradesManeuvers(filters.grades.map((g: number) => String(g)));
              gradesLoaded = true;
              logDebug('ManeuversHistory: Loaded grade filters from persistent settings', filters.grades);
            }
            if (filters.states && Array.isArray(filters.states) && filters.states.length > 0) {
              setSelectedStates(filters.states);
              setSelectedStatesManeuvers(filters.states);
              statesLoaded = true;
              logDebug('ManeuversHistory: Loaded state filters from persistent settings', filters.states);
            }
            if (filters.races && Array.isArray(filters.races) && filters.races.length > 0) {
              setSelectedRaces(filters.races);
              setSelectedRacesManeuvers(filters.races.map((r: number | string) => String(r)));
              logDebug('ManeuversHistory: Loaded race filters from persistent settings', filters.races);
            }
            if (filters.legs && Array.isArray(filters.legs) && filters.legs.length > 0) {
              setSelectedLegs(filters.legs);
              setSelectedLegsManeuvers(filters.legs.map((l: number) => String(l)));
              logDebug('ManeuversHistory: Loaded leg filters from persistent settings', filters.legs);
            }
            if (filters.trainingRacing === 'TRAINING' || filters.trainingRacing === 'RACING') {
              setManeuverTrainingRacing(filters.trainingRacing);
              logDebug('ManeuversHistory: Loaded trainingRacing filter from persistent settings', filters.trainingRacing);
            }
          } else {
            logDebug('ManeuversHistory: No maneuverFilters found in settings', settings);
          }
          
          // Set default grade >1 (shows grades 2 and 3) if no grades were loaded from persistent settings
          if (!gradesLoaded) {
            setSelectedGrades([1]);
            setSelectedGradesManeuvers(['1']);
            logDebug('ManeuversHistory: Set default grade filter to [1] (>1)');
          }
          // Set default state H0 if no states were loaded from persistent settings
          if (!statesLoaded) {
            setSelectedStates(['H0']);
            setSelectedStatesManeuvers(['H0']);
            logDebug('ManeuversHistory: Set default state filter to [H0]');
          }
        }
      } catch (error) {
        logDebug('ManeuversHistory: Error loading filters from persistent settings:', error);
        if (selectedGrades().length === 0) {
          setSelectedGrades([1]);
          setSelectedGradesManeuvers(['1']);
          logDebug('ManeuversHistory: Set default grade filter to [1] (>1) after error');
        }
        if (selectedStates().length === 0) {
          setSelectedStates(['H0']);
          setSelectedStatesManeuvers(['H0']);
          logDebug('ManeuversHistory: Set default state filter to [H0] after error');
        }
      }
    } else {
      if (selectedGrades().length === 0) {
        setSelectedGrades([1]);
        setSelectedGradesManeuvers(['1']);
        logDebug('ManeuversHistory: Set default grade filter to [1] (>1) (no user)');
      }
      if (selectedStates().length === 0) {
        setSelectedStates(['H0']);
        setSelectedStatesManeuvers(['H0']);
        logDebug('ManeuversHistory: Set default state filter to [H0] (no user)');
      }
    }
  };

  onMount(async () => {
    await logPageLoad('Maneuvers.jsx', 'Maneuvers Analysis Report');
    setEventType("TACK")
    setView("MAP")

    // Set TACK as default color when selectedSourceId > 0
    if (selectedSourceId() > 0) {
      setColor("TACK");
    }
    
    // Restrict grade options to [1, 2] only (exclude 0) for history pages
    // Grade 1 means >1 (shows grades 2 and 3), Grade 2 means >2 (shows only grade 3)
    setGradeOptions([1, 2]);
    
    await loadFiltersFromPersistentSettings();

    // Default year/event from dataset selection when not ALL (leave empty if ALL)
    const dsYear = selectedYear();
    const dsEvent = selectedEvent();
    if ((!filterYear() || filterYear().trim() === '') && dsYear != null && String(dsYear).trim() !== '' && String(dsYear).trim().toUpperCase() !== 'ALL') {
      setFilterYear(String(dsYear).trim());
    }
    if ((!filterEvent() || filterEvent().trim() === '') && dsEvent != null && String(dsEvent).trim() !== '' && String(dsEvent).trim().toUpperCase() !== 'ALL') {
      setFilterEvent(String(dsEvent).trim());
    }

    // Fetch timeseries description options
    await fetchTimeseriesOptions();
    await fetchTableData();
    
    // Set up dynamic scaling for media-container using the global utility
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'Maneuvers'
    });
    
    // Set initial heights
    updateContainerHeights();
    
    // Update heights on container resize (scaling is handled by setupMediaContainerScaling)
    const resizeObserver = new ResizeObserver(() => {
      updateContainerHeights();
    });
    
    // Observe map element to sync table height when map resizes
    const mapObserver = new ResizeObserver(() => {
      if (view() === 'MAP') {
        syncTableHeightWithMap();
      }
    });
    
    const mediaContainer = document.getElementById('media-container');
    if (mediaContainer) {
      // Observe the appropriate reference container (split panel or parent)
      const splitPanel = mediaContainer.closest('.split-panel');
      const mainContent = mediaContainer.closest('#main-content');
      const reference = splitPanel || mainContent || mediaContainer.parentElement;
      if (reference) {
        resizeObserver.observe(reference);
      }
    }
    
    // Observe map element for height changes
    const mapElement = document.querySelector('#maneuver-map');
    if (mapElement) {
      mapObserver.observe(mapElement);
    }
    
    // Also observe map area container
    const mapArea = document.getElementById('map-area');
    if (mapArea) {
      mapObserver.observe(mapArea);
    }
    
    // Observe sidebar for collapse/expand changes
    const sidebarObserver = observeSidebar();
    
    // Poll for sidebar changes (since same-tab localStorage changes don't trigger storage event)
    const sidebarCheckInterval = setInterval(() => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        const isCollapsed = sidebar.classList.contains('collapsed');
        const wasCollapsed = localStorage.getItem('_sidebarWasCollapsed') === 'true';
        if (isCollapsed !== wasCollapsed) {
          localStorage.setItem('_sidebarWasCollapsed', isCollapsed.toString());
          updateContainerHeights();
        }
      }
    }, 100);
    
    // Also listen to window resize for when the main window changes size
    const handleResize = () => {
      updateContainerHeights();
    };
    window.addEventListener('resize', handleResize);

    // 'h' key: Hide selected events
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (document.querySelector('.pagesettings-modal')) return;
      if (event.key === 'h' || event.key === 'H') {
        const currentSelected = selectedEvents();
        if (currentSelected && currentSelected.length > 0) {
          event.preventDefault();
          hideSelectedEvents();
          requestAnimationFrame(() => setTriggerUpdate(true));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    
    // Cleanup on unmount
    return () => {
      cleanupScaling(); // Call the cleanup function returned by the utility
      resizeObserver.disconnect();
      mapObserver.disconnect();
      if (sidebarObserver) sidebarObserver.disconnect();
      clearInterval(sidebarCheckInterval);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  // Cleanup abort controllers and other resources on component unmount
  onCleanup(() => {
    // Abort any pending table data requests
    if (tableDataController) {
      tableDataController.abort();
      tableDataController = null;
    }
    
    // Abort any pending times requests
    if (timesController) {
      timesController.abort();
      timesController = null;
    }
    
    // Reset data loaded state
    setDataLoaded(false);
    
    // Clear any stored data to free memory
    setManeuvers([]);
    setTableData([]);
    setFiltered([]);
    
    logDebug('ManeuversHistory: Cleanup complete - abort controllers cleared and data reset');
  });

  // Check if maneuvers exist
  const hasManeuvers = createMemo(() => {
    const maneuversData = maneuvers();
    return maneuversData && Array.isArray(maneuversData) && maneuversData.length > 0;
  });

  // Check if filtered maneuvers exist (after grade/TWS filtering)
  const hasFilteredManeuvers = createMemo(() => {
    const filteredIds = filtered();
    return filteredIds && Array.isArray(filteredIds) && filteredIds.length > 0;
  });

  return (
    <div id="media-container" class="maneuvers-page">
      <div class="container">
        {/* Header section */}
        <div id="maneuver-controls" class="flex flex-col w-full pl-2 pt-2">
          {/* Top Control Bar: single row */}
          <div class="flex w-full h-[50px] items-center gap-x-2">
            {/* Left group: 4 buttons */}
            <div class="flex gap-x-2 items-center">
              <div class="self-center">
                <ManeuverSettings
                  useIconTrigger={true}
                  raceOptions={raceOptions()}
                  legOptions={legOptions()}
                  gradeOptions={gradeOptions()}
                  stateOptions={stateOptions()}
                  selectedRaces={selectedRaces()}
                  selectedLegs={selectedLegs()}
                  selectedGrades={selectedGrades()}
                  selectedStates={selectedStates()}
                  selectedTrainingRacing={maneuverTrainingRacing()}
                  onTrainingRacingFilterChange={setManeuverTrainingRacing}
                  setRaceOptions={setRaceOptions}
                  setLegOptions={setLegOptions}
                  setGradeOptions={setGradeOptions}
                  setStateOptions={setStateOptions}
                  toggleRaceFilter={toggleRaceFilter}
                  toggleLegFilter={toggleLegFilter}
                  toggleGradeFilter={toggleGradeFilter}
                  toggleStateFilter={toggleStateFilter}
                  filterYear={filterYear}
                  filterEvent={filterEvent}
                  filterConfig={filterConfigValue}
                  filterState={filterState}
                  onFilterYearChange={setFilterYear}
                  onFilterEventChange={setFilterEvent}
                  onFilterConfigChange={setFilterConfigValue}
                  onFilterStateChange={setFilterState}
                  onApplyFilters={() => fetchTableData()}
                  hideDisplayOptions={true}
                  componentConfig={{
                    showGrades: true,
                    showRaces: true,
                    showLegs: true,
                    showStates: true
                  }}
                  showTimeline={() => showTimeline()}
                  onTimelineChange={handleTimelineChange}
                />
              </div>
              <DropDownButton 
                options={eventTypes()}
                defaultText={eventType()}
                smallLabel="Maneuver"
                size="big"
                handleSelection={handleEventType}
              />
              <DropDownButton
                options={viewOptions()}
                defaultText={grouped() && view() === 'SCATTER' ? 'BOXES' : view()}
                smallLabel="View"
                size="big"
                handleSelection={handleView}
              />
              <Show when={view() === 'TIME SERIES' || view() === 'MAP'}>
                <DropDownButton
                  options={phases()}
                  defaultText={phase()}
                  smallLabel="Phase"
                  size="big"
                  handleSelection={handlePhase}
                />
              </Show>
                {/* Active Filters: right side of left button area */}
                <div class="maneuver-panel-filter-summary">
                  <PerformanceFilterSummary
                    filterGrades={selectedGrades().join(",")}
                    filterState={selectedStates().join(",")}
                    trainingRacing={maneuverTrainingRacing()}
                    gradeAsGreaterThan
                  />
                </div>
            </div>
            
            {/* Right side container: TWS, Grouped, Data, and Color By */}
            <div class="flex gap-x-2 items-center ml-auto">
              <DropDownButton
                options={twsoptions()}
                defaultText={tws()}
                smallLabel="Tws"
                size="small"
                handleSelection={handleTws}
              />
              <DropDownButton
                options={groupedOptions()}
                defaultText={groupDisplayMode()}
                smallLabel="Group"
                size="small"
                handleSelection={(val) => { setGroupDisplayMode(val); setTriggerUpdate(true); }}
              />
              <Show when={view() === 'TIME SERIES' && descriptionOptions().length > 0}>
                <DropDownButton
                  options={descriptionOptions()}
                  defaultText={selectedDescription()}
                  smallLabel="Data"
                  size="small"
                  handleSelection={handleDescription}
                />
              </Show>
              <Show when={view() === 'MAP' || view() === 'TIME SERIES' || view() === 'SCATTER'}>
                <DropDownButton
                  options={colors()}
                  defaultText={color()}
                  smallLabel="Color By"
                  size="big"
                  handleSelection={handleColor}
                />
              </Show>
            </div>
          </div>
          
          {/* Timeseries Display Area: Collapsed until ready */}
          <div class="w-full hidden" style={{ height: '88px', 'margin-top': '10px', 'margin-left': '8px' }}>
            <ScatterTimeseries
              aggregates={aggregatesAVG()}
              color={color()}
              groups={[]}
              isHistoryPage={true}
            />
          </div>
        </div>
        {/* Content section */}
        <Show when={dataLoaded() && hasManeuvers() && !hasFilteredManeuvers()}>
          <div class="flex items-center justify-center h-[calc(100vh-200px)]">
            <div class="text-center">
              <p class="text-xl text-gray-600">No maneuvers found</p>
              <p class="text-sm text-gray-500 mt-1">Filtering criteria may be too strict, check your settings...</p>
            </div>
          </div>
        </Show>
        <Show when={hasFilteredManeuvers()}>
          <Show when={view() === 'MAP'}>
            <div id="maneuver-map-layout" class="maneuver-map-layout flex w-full">
              <div id="table-area">
                <Show when={!grouped()}>
                  <DataTable_Small context={context} />
                </Show>
                <Show when={grouped()}>
                  <DataTable_SmallGrouped context={context} />
                </Show>
              </div>
              <div id="map-area">
                <Show when={!grouped()}>
                  <Map context={context} />
                </Show>
                <Show when={grouped()}>
                  <MapGrouped context={context} />
                </Show>
              </div>
            </div>
          </Show>
          <Show when={view() === 'SCATTER'}>
            <div id="scatter-area">
              <Show when={!grouped()}>
                <Scatter context={context} onLegendClick={handleLegendClick} />
              </Show>
              <Show when={grouped()}>
                <ScatterGrouped context={context} onLegendClick={handleLegendClick} />
              </Show>
            </div>
          </Show>
          <Show when={view() === 'TIME SERIES'}>
            <div id="timeseries-area">
              <Show when={!grouped()}>
                <TimeSeries context={context} description={selectedDescription()} onLegendClick={handleLegendClick} />
              </Show>
              <Show when={grouped()}>
                <TimeSeriesGrouped context={context} description={selectedDescription()} onLegendClick={handleLegendClick} />
              </Show>
            </div>
          </Show>
          <Show when={view() === 'TABLE'}>
            <div id="datatable-big-wrapper">
              <Show when={!grouped()}>
                <DataTable_Big context={context} />
              </Show>
              <Show when={grouped()}>
                <DataTable_BigGrouped context={context} />
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
