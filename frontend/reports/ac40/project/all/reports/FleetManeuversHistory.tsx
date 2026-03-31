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

import { setupMediaContainerScaling } from "../../../../../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../../utils/logging";
import { error as logError, debug as logDebug } from "../../../../../utils/console";

import { phase, setPhase, color, setColor, tws, setTws, eventType, setEventType, grouped, groupDisplayMode, setGroupDisplayMode, maneuvers, setManeuvers, setTableData, setFiltered, filtered, tabledata } from "../../../../../store/globalStore";
import { selectedEvents, setSelectedEvents, setTriggerUpdate, setTriggerSelection, setSelection, hasSelection, isCut, cutEvents, hideSelectedEvents, setSelectedGroupKeys, setSelectedRanges } from "../../../../../store/selectionStore";

import { persistantStore } from "../../../../../store/persistantStore";
import { sourcesStore } from "../../../../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { getData, getEventTimes, formatDateTime } from "../../../../../utils/global";
import ManeuverSettings from "../../../../../components/menus/ManeuverSettings";
import PerformanceFilterSummary from "../../../../../components/legends/PerformanceFilterSummary";
import { persistentSettingsService } from "../../../../../services/persistentSettingsService";
import { getProjectManeuverFilters } from "../../../../../services/projectFiltersService";
import { user } from "../../../../../store/userStore";
import {
  startDate,
  endDate,
  setStartDate,
  setEndDate,
  setSelectedSources as setFilterStoreSelectedSources,
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
import { legendTextToGroupKeyTable } from "../../../../../utils/colorGrouping";
import { TAKEOFF_CHANNELS } from "../../../../../utils/maneuversConfig";

const { selectedClassName, selectedProjectId, selectedDate, selectedDatasetId, selectedYear, selectedEvent } = persistantStore;

// Channels list for maneuvers endpoints - matches single-source Maneuvers / ManeuversHistory (incl. drop columns)
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

export default function FleetManeuversHistoryPage() {
  // Use fleet context for this component
  const context = 'fleet';
  
  const [eventTypes] = createSignal<string[]>(['TACK','GYBE','ROUNDUP','BEARAWAY','TAKEOFF']);
  const [phases] = createSignal<string[]>(['FULL','INVESTMENT','TURN','ACCELERATION']);
  // For fleet context, allow coloring by SOURCE, CONFIG, and STATE
  const [colors] = createSignal<string[]>(['SOURCE', 'CONFIG', 'STATE']);
  const [twsoptions, setTwsOptions] = createSignal<string[]>([]);

  const [views] = createSignal<string[]>(['MAP','TABLE','SCATTER','TIME SERIES']);
  const [view, setView] = createSignal<'MAP' | 'TABLE' | 'SCATTER' | 'TIME SERIES'>('MAP');
  const [groupedOptions] = createSignal<string[]>(['OFF','ON','MIX']);
  const [scatterKey, setScatterKey] = createSignal<number>(0);

  // Timeseries description options
  const [descriptionOptions, setDescriptionOptions] = createSignal<string[]>([]);
  const [selectedDescription, setSelectedDescription] = createSignal<string>('BASICS');

  // Store clearFormatting function from DataTable_Big
  const [clearFormattingFn, setClearFormattingFn] = createSignal<(() => void) | null>(null);

  const viewOptions = createMemo<string[]>(() => {
    return grouped() ? ['MAP','TABLE','BOXES','TIME SERIES'] : views();
  });

  // State for ManeuverSettings
  const [raceOptions, setRaceOptions] = createSignal<(number | string)[]>([]);
  const [legOptions, setLegOptions] = createSignal<number[]>([]);
  const [gradeOptions, setGradeOptions] = createSignal<number[]>([]);
  const [stateOptions, setStateOptions] = createSignal<string[]>([]);
  const [selectedRaces, setSelectedRaces] = createSignal<(number | string)[]>([]);
  const [selectedLegs, setSelectedLegs] = createSignal<number[]>([]);
  const [selectedGrades, setSelectedGrades] = createSignal<number[]>([]);
  const [selectedStates, setSelectedStates] = createSignal<string[]>([]);
  
  // Project-specific filter state (Year, Event, Config, State) - same as FleetPerformanceHistory
  const [filterYear, setFilterYear] = createSignal('');
  const [filterEvent, setFilterEvent] = createSignal('');
  const [filterConfigValue, setFilterConfigValue] = createSignal('');
  const [filterState, setFilterState] = createSignal('');
  
  // Source selection state
  const [selectedSources, setSelectedSources] = createSignal<Set<number>>(new Set());

  // Abort controllers for canceling requests
  let tableDataController: AbortController | null = null;
  let timesController: AbortController | null = null;

  // Track if initial data load has completed
  const [dataLoaded, setDataLoaded] = createSignal(false);

  // Fetch timeseries description options from API
  const fetchTimeseriesOptions = async () => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        logDebug('FleetManeuversHistory: Cannot fetch timeseries options - missing className or projectId');
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
        logDebug('FleetManeuversHistory: Loaded timeseries description options:', options);
      } else {
        logDebug('FleetManeuversHistory: Failed to fetch timeseries options or invalid response:', result);
        // Default fallback
        setDescriptionOptions(['BASICS']);
        setSelectedDescription('BASICS');
        setManeuverTimeseriesDescription('BASICS');
      }
    } catch (error: any) {
      logError('FleetManeuversHistory: Error fetching timeseries options:', error);
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

  const fetchTableData = async () => {
    // Cancel previous request if still pending
    if (tableDataController) {
      tableDataController.abort();
    }

    // Create new abort controller
    tableDataController = new AbortController();

    // Capture event type for this request so we don't apply a stale response over current type
    const requestEventType = (eventType() || 'TACK').trim() || 'TACK';

    if (requestEventType.toUpperCase() === 'TAKEOFF') {
      logDebug('FleetManeuversHistory: fetchTableData for TAKEOFF', { startDate: startDate(), endDate: endDate(), sourcesCount: sourcesStore.sources()?.length ?? 0 });
    }

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

      // Get date range from filterStore (for project mode) or use selectedDate
      const filterStoreStart = startDate();
      const filterStoreEnd = endDate();
      const date = selectedDate();
      
      let startDateValue: string;
      let endDateValue: string;
      
      if (filterStoreStart && filterStoreEnd) {
        startDateValue = filterStoreStart;
        endDateValue = filterStoreEnd;
      } else if (date) {
        startDateValue = date;
        endDateValue = date;
      } else {
        startDateValue = '2020-01-01';
        endDateValue = '2099-12-31';
      }

      // Get source names for the selected source IDs
      const selectedSourceIds = selectedSources();
      const sources = sourcesStore.sources();
      const selectedSourceNames: string[] = [];
      sources.forEach((source: any) => {
        if (selectedSourceIds.size === 0 || selectedSourceIds.has(source.source_id)) {
          selectedSourceNames.push(source.source_name);
        }
      });

      // Build URL with start_date, end_date, channels, source_names, and optional filters
      // For TAKEOFF, request only takeoff-relevant channels (not tack/gybe columns)
      const channelsToRequest = (requestEventType || '').toUpperCase() === 'TAKEOFF'
        ? ['twa_entry', ...TAKEOFF_CHANNELS]
        : MANEUVERS_CHANNELS;
      let url = `${apiEndpoints.app.data}/maneuvers-history?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&start_date=${encodeURIComponent(startDateValue)}&end_date=${encodeURIComponent(endDateValue)}&event_type=${encodeURIComponent(requestEventType)}&count=10&channels=${encodeURIComponent(JSON.stringify(channelsToRequest))}`;
      
      // Add source_names parameter
      if (selectedSourceNames.length > 0) {
        url += `&source_names=${encodeURIComponent(JSON.stringify(selectedSourceNames))}`;
      }
      
      // Add optional filters
      if (Object.keys(filters).length > 0) {
        url += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
      }

      const result = await getData(url, tableDataController!.signal);

      // Ignore response if user changed maneuver type before this request completed (avoid stale overwrite)
      if ((eventType() || 'TACK').trim() !== requestEventType) {
        setDataLoaded(true);
        return;
      }

      if (result.success && result.data && Array.isArray(result.data)) {
        let allData: any[] = result.data;

        // Add datetimeLocal (dataset local time) for table and tooltips
        allData.forEach((item: any) => {
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

        // Log table data counts for debugging
        const uniqueEventIds = new Set(allData.map((item: any) => item.event_id));
        logDebug(`[FleetManeuversHistory] fetchTableData - API returned ${allData.length} records, ${uniqueEventIds.size} unique event_ids`);
        if (requestEventType.toUpperCase() === 'TAKEOFF') {
          logDebug('FleetManeuversHistory: TAKEOFF fetchTableData results', { totalRows: allData.length });
        }

        // TAKEOFF, BEARAWAY, ROUNDUP: Port/Stbd from entry or build TWA; otherwise by phase
        const evt = (requestEventType || '').toUpperCase();
        const usePortStbd = evt === 'TAKEOFF' || evt === 'BEARAWAY' || evt === 'ROUNDUP';
        if (usePortStbd) {
          allData.forEach((item: any) => {
            const twa = item.twa_entry ?? item.twa_build ?? item.Twa_start ?? 0;
            item.tack = Number(twa) > 0 ? 'STBD' : 'PORT';
          });
        } else if (phase() == 'FULL' || phase() == 'TURN') {
          allData.forEach((item: any) => {
            item.tack = item.twa_entry > 0 ? 'S - P' : 'P - S';
          });
        } else if (phase() == 'INVESTMENT') {
          allData.forEach((item: any) => {
            item.tack = item.twa_entry > 0 ? 'STBD' : 'PORT';
          });
        } else {
          allData.forEach((item: any) => {
            item.tack = item.twa_entry > 0 ? 'PORT' : 'STBD';
          });
        }

        // Generate TWS bins in intervals of 5 starting from the closest increment to the minimum
        // Extract all TWS values from data
        const twsValues: number[] = [];
        allData.forEach((item: any) => {
          const twsBin = item.tws_bin ?? item.tws_avg;
          if (twsBin !== null && twsBin !== undefined && !isNaN(Number(twsBin))) {
            twsValues.push(Number(twsBin));
          }
        });
        
        // Generate bins in increments of 5 starting from the minimum (no 'ALL' option for FleetManeuversHistory)
        let tws_bins: string[] = [];
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
        allData.forEach((item: any) => {
          const state = item.State ?? item.state ?? item.STATE;
          if (state != null && state !== undefined && String(state).trim() !== '') {
            stateValues.add(String(state).trim());
          }
        });
        const sortedStates = Array.from(stateValues).sort();
        setStateOptions(sortedStates);
        
        // Select middle TWS option on load - FleetManeuversHistory always requires a TWS value
        if (tws_bins.length > 0) {
          const middleIndex = Math.floor(tws_bins.length / 2);
          const middleTws = tws_bins[middleIndex];
          const currentTws = tws();
          // Always set to middle TWS if current value is 'ALL', empty, undefined, or not in available bins
          if (!currentTws || currentTws === 'ALL' || !tws_bins.includes(currentTws)) {
            handleTws(middleTws);
          }
        }

        setManeuvers(allData)

        // Don't set filtered here - let filterData handle it to avoid race conditions
        // filterData will set filtered and triggerUpdate properly
        const eventIds = allData.map((item: any) => item.event_id);
        setSelection(eventIds as any)

        // Pass data directly to filterData to avoid race condition with store updates
        // filterData will set filtered() and triggerUpdate() at the end
        filterData(allData)
      } else {
        // Handle empty data - reset to empty state only if this response is still current
        if ((eventType() || 'TACK').trim() === requestEventType) {
          if (requestEventType.toUpperCase() === 'TAKEOFF') {
            logDebug('FleetManeuversHistory: TAKEOFF table/scatter received no rows from API');
          }
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          setTwsOptions([]);
        }
      }
      setDataLoaded(true);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Request was cancelled - this is expected, no error needed
      } else {
        if ((eventType() || 'TACK').trim() === requestEventType) {
          logError('Error fetching table data:', error as any);
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          setTwsOptions([]);
        }
      }
      setDataLoaded(true);
    } finally {
      tableDataController = null;
    }
  }

  const handleEventType = (val: string): void => {
    const prev = (eventType() || '').trim().toUpperCase();
    setEventType(val);
    const valUpper = (val || '').trim().toUpperCase();
    if (valUpper === 'TAKEOFF') {
      setSelectedStates([]);
      setSelectedStatesManeuvers([]);
      logDebug('FleetManeuversHistory: TAKEOFF selected — cleared state filters');
    } else if (prev === 'TAKEOFF') {
      loadFiltersFromPersistentSettings();
      logDebug('FleetManeuversHistory: Left TAKEOFF — restored persistent filters');
    }
  };

  const handlePhase = (val: string): void => {
    setPhase(val)
    setTriggerUpdate(true);
  };

  const handleView = async (val: string): Promise<void> => {
    const normalized = (val === 'BOXES') ? 'SCATTER' : val;
    // Guard to satisfy the view signal's union type
    if (normalized === 'MAP' || normalized === 'TABLE' || normalized === 'SCATTER' || normalized === 'TIME SERIES') {
      setView(normalized);
      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
      await logActivity(project_id, dataset_id, 'FleetManeuversHistory.tsx', 'Fleet Maneuvers History Report', `View changed to ${normalized}`);
    }
    setTriggerUpdate(true);
  };

  // Force SCATTER/BOXES content to remount and redraw when grouped toggles
  createEffect(() => {
    const g = grouped();
    if (view() === 'SCATTER') {
      setScatterKey((k: number) => k + 1);
    }
  });

  const handleColor = async (val: string): Promise<void> => {
    setColor(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'FleetManeuversHistory.tsx', 'Fleet Maneuvers History Report', `Color changed to ${val}`);
    setTriggerUpdate(true)
  };

  const filterData = (dataOverride?: any[]): void => {
    // Use provided data or read from store - this avoids race conditions
    const maneuversData = dataOverride ?? maneuvers();
    if (!maneuversData || !Array.isArray(maneuversData) || maneuversData.length === 0) {
      setFiltered([]);
      setTableData([]);
      return;
    }

    let filteredData_tws: any[] = []

    // For ac40 FleetManeuversHistory, no 'ALL' option - always filter by TWS
    const selectedTws = Number(tws());
    if (!isNaN(selectedTws)) {
      // Filter data where TWS value is within ±2.5 of the selected bin (intervals of 5)
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
      // Fallback: if TWS is not a valid number, return empty array
      filteredData_tws = [];
    }

    // Apply grade filter using selectedGrades array - use "greater than" logic
    // Use lowercase field names as primary with fallbacks for backward compatibility
    let filteredData: any[] = filteredData_tws;
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
      const cutEventIds = cutEvents();
      filteredData = filteredData.filter((maneuver: any) => 
        cutEventIds.includes(maneuver.event_id)
      );
    }

    // Sort by vmg_perc_avg descending
    filteredData.sort((a: any, b: any) => {
      const aVmg = a.vmg_perc_avg ?? 0;
      const bVmg = b.vmg_perc_avg ?? 0;
      return bVmg - aVmg; // Descending order
    });

    const eventIds = filteredData.map((item: any) => item.event_id);
    const uniqueEventIds = new Set(eventIds);
    
    logDebug(`[FleetManeuversHistory] filterData - Final filtered data: ${filteredData.length} records, ${uniqueEventIds.size} unique event_ids`);
    logDebug(`[FleetManeuversHistory] filterData - Setting filtered() to ${eventIds.length} event_ids`);

    setFiltered(eventIds)
    setTableData(filteredData)
    
    // Update selection to match filtered data (but don't override user's active selection)
    if (!hasSelection()) {
      setSelection(eventIds as any)
    }

    setTriggerUpdate(true)
  }

  const handleTws = async (val: string): Promise<void> => {
    setTws(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'FleetManeuversHistory.tsx', 'Fleet Maneuvers History Report', `TWS changed to ${val}`);
    filterData()
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
      logDebug('FleetManeuversHistory: Legend click on', legendItem, '- no maneuvers data available');
      return;
    }

    const currentColorField = color();
    const clickedItem = String(legendItem);
    
    // Filter maneuvers by current color field matching the clicked legend item
    const legendEntryIds = dataSource
      .filter((m: any) => {
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
        
        // For STATE - check state field (use lowercase first with fallbacks)
        if (currentColorField === 'STATE') {
          const stateValue = m.state ?? m.State ?? m.STATE;
          const clickedStr = clickedItem;
          
          // Try exact match
          if (String(stateValue) === clickedStr) return true;
          
          // Try case-insensitive match
          if (stateValue && String(stateValue).toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // For CONFIG - check config field (use lowercase first with fallbacks)
        if (currentColorField === 'CONFIG') {
          const configValue = m.config ?? m.Config ?? m.CONFIG;
          const clickedStr = clickedItem;
          
          // Try exact match
          if (String(configValue) === clickedStr) return true;
          
          // Try case-insensitive match
          if (configValue && String(configValue).toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // For GRADE - check grade field (use lowercase first with fallbacks)
        if (currentColorField === 'GRADE') {
          const gradeValue = m.grade ?? m.Grade ?? m.GRADE;
          const clickedStr = clickedItem;
          
          // Try numeric comparison
          const gradeNum = Number(gradeValue);
          const clickedNum = Number(clickedStr);
          if (!isNaN(gradeNum) && !isNaN(clickedNum) && gradeNum === clickedNum) return true;
          
          // Try exact match
          if (String(gradeValue) === clickedStr) return true;
          
          return false;
        }
        
        // For RACE - check race_number field (use lowercase first with fallbacks)
        if (currentColorField === 'RACE') {
          const raceValue = m.race_number ?? m.Race_number ?? m.RACE;
          const clickedStr = clickedItem;
          
          // Handle TRAINING case
          if ((raceValue === -1 || raceValue === '-1' || raceValue === 'TRAINING') && 
              (clickedStr === 'TRAINING' || clickedStr === 'training' || clickedStr === '-1')) {
            return true;
          }
          
          // Try numeric comparison
          const raceNum = Number(raceValue);
          const clickedNum = Number(clickedStr);
          if (!isNaN(raceNum) && !isNaN(clickedNum) && raceNum === clickedNum) return true;
          
          // Try exact match
          if (String(raceValue) === clickedStr) return true;
          
          return false;
        }
        
        // For LEG - check leg_number field (use lowercase first with fallbacks)
        if (currentColorField === 'LEG') {
          const legValue = m.leg_number ?? m.Leg_number ?? m.LEG;
          const clickedStr = clickedItem;
          
          // Try numeric comparison
          const legNum = Number(legValue);
          const clickedNum = Number(clickedStr);
          if (!isNaN(legNum) && !isNaN(clickedNum) && legNum === clickedNum) return true;
          
          // Try exact match
          if (String(legValue) === clickedStr) return true;
          
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
      logDebug('FleetManeuversHistory: Legend click on', legendItem, '- no matching event IDs found');
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
      logDebug('FleetManeuversHistory: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'event IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      logDebug('FleetManeuversHistory: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'event IDs');
    }
    
    // Trigger update to refresh views
    setTriggerUpdate(true);
  };

  // React to eventType changes - use normalized value so we still fetch when eventType is empty (treat as TACK)
  let lastEventType: string | null = null;
  createEffect(on([eventType], async ([currentEventType]) => {
    const et = (currentEventType || 'TACK').trim() || 'TACK';
    if (et && et !== lastEventType) {
      lastEventType = et;
      await untrack(() => fetchTableData());
    }
  }));

  // React to sources becoming available (date is now optional) - use untrack to avoid tracking sources array and fetchTableData internals
  let sourcesInitialized = false;
  createEffect(async () => {
    const sourcesReady = sourcesStore.isReady();
    const sources = untrack(() => sourcesStore.sources());
    const currentEventType = untrack(() => (eventType() || 'TACK').trim() || 'TACK');
    
    if (sourcesReady && sources && sources.length > 0 && currentEventType && !sourcesInitialized) {
      sourcesInitialized = true;
      await untrack(() => fetchTableData());
    }
  });

  // When startDate is set but endDate is missing, fetch last_date and set endDate (or fallback to startDate)
  const ensureEndDateFilled = async (): Promise<void> => {
    if (endDate()) return;
    const start = startDate();
    if (!start) return;
    try {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();
      if (!className || !projectId) {
        setEndDate(start);
        return;
      }
      const controller = new AbortController();
      const result = await getData(
        `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=0`,
        controller.signal
      );
      if (result?.success && result?.data) {
        const d = new Date(result.data);
        if (!isNaN(d.getTime())) {
          const formatted = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          setEndDate(formatted);
          logDebug('FleetManeuversHistory: Filled end date from last_date', formatted);
          return;
        }
      }
      setEndDate(start);
      logDebug('FleetManeuversHistory: Filled end date with start date (fallback)');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setEndDate(start);
      logDebug('FleetManeuversHistory: Filled end date with start date (error fallback)');
    }
  };

  // Initialize default date range (1 year back from latest data, source_id=0 for fleet)
  const initializeDefaultDateRange = async (): Promise<void> => {
    try {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();

      if (!className || !projectId) {
        logDebug('FleetManeuversHistory: Cannot initialize default date range - missing required values');
        return;
      }

      // For fleet pages, use source_id=0
      const controller = new AbortController();
      const result = await getData(
        `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=0`,
        controller.signal
      );

      if (result.success && result.data) {
        const dateStr = String(result.data).trim();
        const endDateValue = new Date(dateStr);
        if (isNaN(endDateValue.getTime())) {
          logDebug('FleetManeuversHistory: last_date invalid, skipping default date range');
          return;
        }
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
        // Only set if both look valid (YYYY-MM-DD)
        const validFormat = /^\d{4}-\d{2}-\d{2}$/;
        if (!validFormat.test(formattedEndDate) || !validFormat.test(formattedStartDate)) {
          logDebug('FleetManeuversHistory: Formatted dates invalid, skipping', { formattedStartDate, formattedEndDate });
          return;
        }

        // Set end date first so it is never left empty if something fails after
        setEndDate(formattedEndDate);
        setStartDate(formattedStartDate);

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
          logDebug('FleetManeuversHistory: Initialized and saved default date range (1 year)', {
            startDate: formattedStartDate,
            endDate: formattedEndDate
          });
        }
      } else {
        logDebug('FleetManeuversHistory: Failed to fetch last_date for default date range');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      logError('FleetManeuversHistory: Error initializing default date range:', err);
    }
  };

  // Whenever startDate is set but endDate is missing, fill endDate (so UI never shows empty end date)
  createEffect(() => {
    const start = startDate();
    const end = endDate();
    if (start && !end) {
      ensureEndDateFilled();
    }
  });

  // Initialize date range and selectedSources from persistent settings
  createEffect(async () => {
    const sourcesReady = sourcesStore.isReady();
    const sources = sourcesStore.sources();
    const currentUser = user();
    
    if (!sourcesReady || !sources || sources.length === 0 || !currentUser?.user_id) {
      return;
    }
    
    const { selectedClassName, selectedProjectId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!className || !projectId) {
      return;
    }

    try {
      const settings = await persistentSettingsService.loadSettings(
        currentUser.user_id,
        className,
        projectId
      );

      // Always ensure date range is populated when missing (so End Date is never left empty)
      const needDateRange = !startDate() || !endDate();
      if (needDateRange) {
        let hasDateRange = false;
        if (settings?.performanceHistoryDateRange) {
          const dateRange = settings.performanceHistoryDateRange;
          if (dateRange.startDate && dateRange.endDate) {
            setStartDate(dateRange.startDate);
            setEndDate(dateRange.endDate);
            hasDateRange = true;
            logDebug('FleetManeuversHistory: Loaded date range from persistent settings', {
              startDate: dateRange.startDate,
              endDate: dateRange.endDate
            });
          }
        }
        if (!hasDateRange) {
          await initializeDefaultDateRange();
        }
        // Ensure end date is never left empty (e.g. if start was set but end was not)
        if (!endDate() && startDate()) {
          await ensureEndDateFilled();
        }
      }

      // Only initialize sources when not already set (avoid overwriting user selection)
      if (selectedSources().size === 0) {
        if (settings?.fleetPerformanceSources && Array.isArray(settings.fleetPerformanceSources) && settings.fleetPerformanceSources.length > 0) {
          // Convert source names to source IDs
          const sourceIds = new Set<number>();
          settings.fleetPerformanceSources.forEach((sourceName: string) => {
            const source = sources.find((s: any) => s.source_name === sourceName);
            if (source && source.source_id) {
              sourceIds.add(source.source_id);
            }
          });
          if (sourceIds.size > 0) {
            setSelectedSources(sourceIds);
            logDebug('FleetManeuversHistory: Initialized sources from persistent settings', Array.from(sourceIds));
          } else {
            const allSourceIds = new Set(sources.map((s: any) => s.source_id).filter((id: any) => id !== null && id !== undefined));
            setSelectedSources(allSourceIds);
            logDebug('FleetManeuversHistory: No matching sources found, defaulting to all sources');
          }
        } else {
          const allSourceIds = new Set(sources.map((s: any) => s.source_id).filter((id: any) => id !== null && id !== undefined));
          setSelectedSources(allSourceIds);
          logDebug('FleetManeuversHistory: No saved source settings, defaulting to all sources');
        }
      }
    } catch (error) {
      logDebug('FleetManeuversHistory: Error loading source settings, defaulting to all sources', error);
      if (selectedSources().size === 0) {
        const allSourceIds = new Set(sources.map((s: any) => s.source_id).filter((id: any) => id !== null && id !== undefined));
        setSelectedSources(allSourceIds);
      }
    }
  });

  // Sync selectedSources to filterStore (for Map component to use)
  createEffect(() => {
    const selected = selectedSources();
    const sources = sourcesStore.sources();
    
    if (selected.size > 0 && sources && sources.length > 0) {
      // Convert source IDs to source names for filterStore
      const sourceNames: string[] = [];
      sources.forEach((source: any) => {
        if (selected.has(source.source_id)) {
          sourceNames.push(source.source_name);
        }
      });
      
      // Sync to filterStore so Map component can use SOURCE_NAME filter
      if (sourceNames.length > 0) {
        setFilterStoreSelectedSources(sourceNames);
        logDebug('FleetManeuversHistory: Synced selectedSources to filterStore', sourceNames);
      }
    }
  });

  // React to selectedSources changes - refetch when sources change; untrack(fetchTableData) to avoid loop
  let lastSelectedSourcesSize = 0;
  createEffect(async () => {
    const sourcesReady = untrack(() => sourcesStore.isReady());
    const sources = untrack(() => sourcesStore.sources());
    const selected = selectedSources();
    const currentEventType = untrack(() => eventType());
    
    if (sourcesReady && sources && sources.length > 0 && currentEventType && selected.size > 0 && selected.size !== lastSelectedSourcesSize) {
      lastSelectedSourcesSize = selected.size;
      await untrack(() => fetchTableData());
    }
  });

  // React to cut events - refilter when cut state changes
  createEffect(on([isCut], () => {
    if (untrack(() => maneuvers().length > 0)) {
      filterData();
    }
  }));

  // React to filter changes - refetch when grades or training/racing change (API-based filtering).
  // Use on() so we only track these deps; fetchTableData inside untrack to avoid tracking its internal reads (prevents loop).
  let lastFilterSnapshot = '';
  createEffect(
    on(
      [selectedGrades, maneuverTrainingRacing],
      async ([grades, trainingRacing]) => {
        const gradesKey = JSON.stringify([...(grades || [])].sort());
        const trKey = trainingRacing ?? '';
        const snapshot = gradesKey + '|' + trKey;
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
      const additionalSpacingForMap = -50; // Reduced by 75px to make map taller
      const mapHeight = window.innerHeight - headerHeight - additionalSpacingForMap;
      
      // For TABLE view: account for header, padding, and button area
      // More accurate calculation: header (58px) + controls (50px) + padding (20px) = 128px
      const additionalSpacingForTable = 128; // Account for header, controls, and padding
      const tableHeight = window.innerHeight - headerHeight - additionalSpacingForTable;
      
      const mapLayout = document.querySelector('.maneuver-map-layout') as HTMLElement | null;
      const tableWrapper = document.getElementById('datatable-big-wrapper') as HTMLElement | null;
      
      if (mapLayout) {
        mapLayout.style.height = `${mapHeight}px`;
        mapLayout.style.minHeight = `${mapHeight}px`;
        mapLayout.style.maxHeight = `${mapHeight}px`;
      }
      
      if (tableWrapper) {
        tableWrapper.style.height = `${tableHeight}px`;
        tableWrapper.style.maxHeight = `${tableHeight}px`;
        tableWrapper.style.overflow = 'hidden'; // Ensure wrapper contains scrollable content
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
      // Skip fetching times in fleet context - the /api/events/times endpoint requires dataset_id
      // and doesn't support fleet context (source_id + date). Time ranges are not critical for
      // fleet maneuvers - they're mainly used for highlighting selected events.
      const datasetId = selectedDatasetId();
      if (!datasetId || datasetId <= 0) {
        // Fleet context - skip times fetch
        logDebug('FleetManeuversHistory: Skipping times fetch in fleet context (endpoint requires dataset_id)');
        return;
      }

      // Cancel previous request if still pending
      if (timesController) {
        timesController.abort();
      }

      // Create new abort controller
      timesController = new AbortController();

      try {
        // Dataset context - use dataset_id
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
          logError('Error fetching times:', error as any);
        }
      } finally {
        timesController = null;
      }
    }
  });

  // In fleet context (no dataset_id), selectedRanges is not fetched by selectionStore. Populate it from table data so selection store has correct start times.
  createEffect(() => {
    const datasetId = selectedDatasetId();
    if (datasetId != null && datasetId > 0) return;
    const ids = selectedEvents();
    if (!Array.isArray(ids) || ids.length === 0) return;
    const table = tabledata();
    const tableArr = Array.isArray(table) ? table : [];
    if (tableArr.length === 0) return;
    const getRowStartTime = (row: Record<string, unknown> | undefined): string | undefined => {
      if (!row) return undefined;
      const raw = row.start_time ?? row.Start_time ?? row.datetime ?? row.Datetime ?? row.DATETIME ?? row.date ?? row.Date;
      if (raw == null) return undefined;
      if (typeof raw === "string" && String(raw).trim() !== "") return String(raw).trim();
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString();
      return undefined;
    };
    const ranges: Array<{ event_id: number; start_time: string; end_time: string; type: string }> = [];
    for (const eventId of ids) {
      const row = tableArr.find((r: { event_id?: number }) => r?.event_id == eventId) as Record<string, unknown> | undefined;
      const start_time = getRowStartTime(row);
      if (start_time) {
        ranges.push({ event_id: Number(eventId), start_time, end_time: start_time, type: "event" });
      }
    }
    if (ranges.length > 0) {
      setSelectedRanges(ranges);
    }
  });

  // Function to sync table height with map SVG height
  const syncTableHeightWithMap = (): void => {
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
  const updateContainerHeights = (): void => {
    // Get the actual available height from the viewport (full screen)
    // Header height is 58px (50px + 8px padding)
    const headerHeight = 58;
    
    // For MAP view: need extra spacing for padding, button area, and margins
    const additionalSpacingForMap = -50; // Account for padding, button area, and margins (reduced by 75px to make map taller)
    const mapHeight = window.innerHeight - headerHeight - additionalSpacingForMap;
    
    // For TABLE view: account for header, padding, and button area
    // More accurate calculation: header (58px) + controls (50px) + padding (20px) = 128px
    const additionalSpacingForTable = 128; // Account for header, controls, and padding
    const tableHeight = window.innerHeight - headerHeight - additionalSpacingForTable;
    
    // Update heights dynamically for all views
    const mapLayout = document.querySelector('.maneuver-map-layout') as HTMLElement | null;
    const tableWrapper = document.getElementById('datatable-big-wrapper') as HTMLElement | null;
    
    if (mapLayout) {
      mapLayout.style.height = `${mapHeight}px`;
      mapLayout.style.minHeight = `${mapHeight}px`;
      mapLayout.style.maxHeight = `${mapHeight}px`;
    }
    
    if (tableWrapper) {
      tableWrapper.style.height = `${tableHeight}px`;
      tableWrapper.style.maxHeight = `${tableHeight}px`;
      tableWrapper.style.overflow = 'hidden'; // Ensure wrapper contains scrollable content
    }
    
    // Sync table height with map SVG height for MAP view
    setTimeout(() => {
      syncTableHeightWithMap();
    }, 100); // Small delay to ensure map is rendered
  };
  
  // Function to observe sidebar for collapse/expand changes
  const observeSidebar = (): MutationObserver | null => {
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

          logDebug('FleetManeuversHistory: Loaded settings from persistent settings', settings);
          let gradesLoaded = false;
          let statesLoaded = false;
          if (settings?.maneuverFilters) {
            const filters = settings.maneuverFilters;
            if (filters.grades && Array.isArray(filters.grades) && filters.grades.length > 0) {
              setSelectedGrades(filters.grades);
              setSelectedGradesManeuvers(filters.grades.map((g: number) => String(g)));
              gradesLoaded = true;
              logDebug('FleetManeuversHistory: Loaded grade filters from persistent settings', filters.grades);
            }
            if (filters.states && Array.isArray(filters.states) && filters.states.length > 0) {
              setSelectedStates(filters.states);
              setSelectedStatesManeuvers(filters.states);
              statesLoaded = true;
              logDebug('FleetManeuversHistory: Loaded state filters from persistent settings', filters.states);
            }
            if (filters.races && Array.isArray(filters.races) && filters.races.length > 0) {
              setSelectedRaces(filters.races);
              setSelectedRacesManeuvers(filters.races.map((r: number | string) => String(r)));
              logDebug('FleetManeuversHistory: Loaded race filters from persistent settings', filters.races);
            }
            if (filters.legs && Array.isArray(filters.legs) && filters.legs.length > 0) {
              setSelectedLegs(filters.legs);
              setSelectedLegsManeuvers(filters.legs.map((l: number) => String(l)));
              logDebug('FleetManeuversHistory: Loaded leg filters from persistent settings', filters.legs);
            }
            if (filters.trainingRacing === 'TRAINING' || filters.trainingRacing === 'RACING') {
              setManeuverTrainingRacing(filters.trainingRacing);
              logDebug('FleetManeuversHistory: Loaded trainingRacing filter from persistent settings', filters.trainingRacing);
            }
          } else {
            logDebug('FleetManeuversHistory: No maneuverFilters found in settings', settings);
          }
          
          // Set default grade >1 (shows grades 2 and 3) if no grades were loaded from persistent settings
          if (!gradesLoaded) {
            setSelectedGrades([1]);
            setSelectedGradesManeuvers(['1']);
            logDebug('FleetManeuversHistory: Set default grade filter to [1] (>1)');
          }
          // Set default state H0 if no states were loaded from persistent settings
          if (!statesLoaded) {
            setSelectedStates(['H0']);
            setSelectedStatesManeuvers(['H0']);
            logDebug('FleetManeuversHistory: Set default state filter to [H0]');
          }
        }
      } catch (error) {
        logDebug('FleetManeuversHistory: Error loading filters from persistent settings:', error);
        // Set default grade and state even if there was an error loading settings
        if (selectedGrades().length === 0) {
          setSelectedGrades([1]);
          setSelectedGradesManeuvers(['1']);
          logDebug('FleetManeuversHistory: Set default grade filter to [1] (>1) after error');
        }
        if (selectedStates().length === 0) {
          setSelectedStates(['H0']);
          setSelectedStatesManeuvers(['H0']);
          logDebug('FleetManeuversHistory: Set default state filter to [H0] after error');
        }
      }
    } else {
      if (selectedGrades().length === 0) {
        setSelectedGrades([1]);
        setSelectedGradesManeuvers(['1']);
        logDebug('FleetManeuversHistory: Set default grade filter to [1] (>1) (no user)');
      }
      if (selectedStates().length === 0) {
        setSelectedStates(['H0']);
        setSelectedStatesManeuvers(['H0']);
        logDebug('FleetManeuversHistory: Set default state filter to [H0] (no user)');
      }
    }
  };

  onMount(async () => {
    await logPageLoad('FleetManeuvers.jsx', 'Fleet Maneuvers Analysis Report');
    
    // Wait for sources to be ready (poll until ready)
    while (!sourcesStore.isReady()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Set default color to SOURCE for fleet context
    setColor('SOURCE');
    setEventType("TACK")
    setView("MAP")

    // Restrict grade options to [1, 2] only (exclude 0) for history pages
    // Grade 1 means >1 (shows grades 2 and 3), Grade 2 means >2 (shows only grade 3)
    setGradeOptions([1, 2]);

    const className = selectedClassName();
    const projectId = selectedProjectId();
    const projectFilters = (className && projectId) ? await getProjectManeuverFilters(className, projectId, '1970-01-01') : null;
    if (projectFilters === null) {
      await loadFiltersFromPersistentSettings();
    }

    // Set in-report defaults first (when none are set)
    if (!selectedGrades().length) {
      setSelectedGrades([1]);
      setSelectedGradesManeuvers(['1']);
    }
    if (!selectedStates().length) {
      setSelectedStates(['H0']);
      setSelectedStatesManeuvers(['H0']);
    }

    // Apply project filters on top (overrides defaults; empty array means "no filter")
    if (projectFilters !== null) {
      if (projectFilters.grades !== undefined) {
        const grades = Array.isArray(projectFilters.grades) ? projectFilters.grades : [];
        setSelectedGrades(grades);
        setSelectedGradesManeuvers(grades.map(g => String(g)));
        logDebug('FleetManeuversHistory: Applied grade filters from project default', projectFilters.grades);
      }
      if (projectFilters.states !== undefined) {
        const states = Array.isArray(projectFilters.states) ? projectFilters.states : [];
        setSelectedStates(states);
        setSelectedStatesManeuvers(states);
        logDebug('FleetManeuversHistory: Applied state filters from project default', projectFilters.states);
      }
    }

    // Default year/event from dataset selection when not ALL (leave empty if ALL)
    const dsYear = selectedYear();
    const dsEvent = selectedEvent();
    if ((!filterYear() || filterYear().trim() === '') && dsYear != null && String(dsYear).trim() !== '' && String(dsYear).trim().toUpperCase() !== 'ALL') {
      setFilterYear(String(dsYear).trim());
    }
    if ((!filterEvent() || filterEvent().trim() === '') && dsEvent != null && String(dsEvent).trim() !== '' && String(dsEvent).trim().toUpperCase() !== 'ALL') {
      setFilterEvent(String(dsEvent).trim());
    }
    
    // Ensure date range is set (1 year if not already set from settings)
    if (!startDate() || !endDate()) {
      await initializeDefaultDateRange();
    }
    
    // Fetch timeseries description options
    await fetchTimeseriesOptions();
    await fetchTableData();
    
    // Set up dynamic scaling for media-container using the global utility
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'FleetManeuvers'
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
    const handleResize = (): void => {
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
    
    logDebug('FleetManeuversHistory: Cleanup complete - abort controllers cleared and data reset');
  });

  const toggleRaceFilter = (race: number | string) => {
    const current = selectedRaces();
    const next = current.includes(race) ? current.filter(r => r !== race) : [...current, race];
    setSelectedRaces(next);
    setSelectedRacesManeuvers(next.map(r => String(r)));
  };

  const toggleLegFilter = (leg: number) => {
    const current = selectedLegs();
    const next = current.includes(leg) ? current.filter(l => l !== leg) : [...current, leg];
    setSelectedLegs(next);
    setSelectedLegsManeuvers(next.map(l => String(l)));
  };

  const toggleGradeFilter = (grade: number) => {
    const current = selectedGrades();
    const next = current.includes(grade) ? [] : [grade];
    setSelectedGrades(next);
    setSelectedGradesManeuvers(next.map(g => String(g)));
  };

  const toggleStateFilter = (state: string) => {
    const current = selectedStates();
    const next = current.includes(state) ? current.filter(s => s !== state) : [...current, state];
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

  // Create dataSourcesOptions from sourcesStore
  const dataSourcesOptions = createMemo(() => {
    return sourcesStore.sources().map(source => ({
      key: `source-${source.source_id}`,
      label: source.source_name,
      signal: [
        () => selectedSources().has(source.source_id),
        (value: boolean) => {
          const current = selectedSources();
          const next = new Set(current);
          if (value) {
            next.add(source.source_id);
          } else {
            next.delete(source.source_id);
          }
          setSelectedSources(next);
        }
      ] as [() => boolean, (value: boolean) => void]
    }));
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
    <>
      <div id="media-container" class="maneuvers-page">
        <div class="container">
          {/* Header section */}
          <div id="maneuver-controls" class="flex flex-col w-full pl-2 pt-2">
            {/* Top Control Bar: single row */}
            <div class="maneuver-control-bar-row flex w-full h-[50px] items-center gap-x-2">
              {/* Left group: 4 buttons */}
              <div class="flex gap-x-2 items-center flex-shrink-0">
                <div class="self-center">
                  <ManeuverSettings
                    useIconTrigger={true}
                    raceOptions={raceOptions()}
                    legOptions={legOptions()}
                    gradeOptions={gradeOptions()}
                    stateOptions={stateOptions()}
                    selectedRaces={() => selectedRaces()}
                    selectedLegs={() => selectedLegs()}
                    selectedGrades={() => selectedGrades()}
                    selectedStates={() => selectedStates()}
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
                    useUnfilteredOptions={true}
                    dataSourcesOptions={dataSourcesOptions()}
                    hideDisplayOptions={true}
                    componentConfig={{
                      showGrades: true,
                      showRaces: true,
                      showLegs: true,
                      showStates: true
                    }}
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

              {/* Right button area: TWS, Grouped, Data, Color By (unchanged) */}
              <div class="maneuver-control-bar-right flex gap-x-2 items-center ml-auto flex-shrink-0">
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
              {/* ScatterTimeseries will be added here when ready */}
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
            <div>
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
                    <Map
                      context={context}
                      filterYear={filterYear}
                      filterEvent={filterEvent}
                      filterConfig={filterConfigValue}
                      filterState={filterState}
                    />
                  </Show>
                  <Show when={grouped()}>
                    <MapGrouped
                      context={context}
                      filterYear={filterYear}
                      filterEvent={filterEvent}
                      filterConfig={filterConfigValue}
                      filterState={filterState}
                    />
                  </Show>
                </div>
              </div>
              <div class="text-left mt-4 mb-2 fleet-maneuvers-footer-text">
                <p class="text-xs" style="font-size: 12px;">
                  This chart is restricted to viewing maneuvers by TWS bin due to sheer numbers of maneuvers
                </p>
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
                <TimeSeries context={context} description={selectedDescription()} onDataUpdate={fetchTableData} onLegendClick={handleLegendClick} />
              </Show>
              <Show when={grouped()}>
                <TimeSeriesGrouped context={context} description={selectedDescription()} onDataUpdate={fetchTableData} onLegendClick={handleLegendClick} />
              </Show>
            </div>
          </Show>
          <Show when={view() === 'TABLE'}>
            <div id="datatable-big-wrapper">
              <Show when={!grouped()}>
                <DataTable_Big
                  context={context}
                  hideClearFormatting={true}
                  onClearFormattingReady={(fn: () => void) => setClearFormattingFn(() => fn)}
                />
              </Show>
              <Show when={grouped()}>
                <DataTable_BigGrouped
                  context={context}
                  hideClearFormatting={true}
                  onClearFormattingReady={(fn: () => void) => setClearFormattingFn(() => fn)}
                />
              </Show>
            </div>
            <Show when={clearFormattingFn()}>
              <div class="flex justify-end mt-2 px-4">
                <button class="btn" onClick={() => clearFormattingFn()?.()}>
                  Clear Formatting
                </button>
              </div>
            </Show>
          </Show>
        </Show>
        </div>
      </div>
    </>
  );
}
