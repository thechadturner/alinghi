import { createSignal, onMount, createEffect, Show, on, untrack, onCleanup } from "solid-js";
import { createMemo } from "solid-js";

import DropDownButton from "../../../../components/buttons/DropDownButton";

import DataTable_Big from "../../../../components/maneuvers/standard/DataTable_Big";
import DataTable_Small from "../../../../components/maneuvers/standard/DataTable_Small";
import Map from "../../../../components/maneuvers/standard/Map";
import Video from "../../../../components/maneuvers/standard/Video";
import Scatter from "../../../../components/maneuvers/standard/Scatter";
import TimeSeries from "../../../../components/maneuvers/standard/TimeSeries";
import DataTable_BigGrouped from "../../../../components/maneuvers/grouped/DataTable_Big";
import DataTable_SmallGrouped from "../../../../components/maneuvers/grouped/DataTable_Small";
import MapGrouped from "../../../../components/maneuvers/grouped/Map";
import ScatterGrouped from "../../../../components/maneuvers/grouped/Scatter";
import TimeSeriesGrouped from "../../../../components/maneuvers/grouped/TimeSeries";

import { setupMediaContainerScaling } from "../../../../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../utils/logging";
import { error as logError, debug as logDebug } from "../../../../utils/console";

import { phase, setPhase, color, setColor, tws, setTws, eventType, setEventType, grouped, groupDisplayMode, setGroupDisplayMode, maneuvers, setManeuvers, setTableData, setFiltered, filtered, tabledata } from "../../../../store/globalStore";
import { selectedEvents, setSelectedEvents, setTriggerUpdate, setTriggerSelection, setSelection, hasSelection, isCut, cutEvents, hideSelectedEvents, setSelectedGroupKeys, setSelectedRanges } from "../../../../store/selectionStore";

import { persistantStore } from "../../../../store/persistantStore";
import { sourcesStore } from "../../../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { getData, getEventTimes, formatDateTime } from "../../../../utils/global";
import ManeuverSettings from "../../../../components/menus/ManeuverSettings";
import PerformanceFilterSummary from "../../../../components/legends/PerformanceFilterSummary";
import { persistentSettingsService } from "../../../../services/persistentSettingsService";
import { getProjectManeuverFilters } from "../../../../services/projectFiltersService";
import { user } from "../../../../store/userStore";
import { debug } from "../../../../utils/console";
import {
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
} from "../../../../store/filterStore";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { legendTextToGroupKeyTable } from "../../../../utils/colorGrouping";
import { mediaAvailabilityService } from "../../../../services/mediaAvailabilityService";
import { MANEUVER_VIDEO_START_OFFSET_SECONDS } from "../../../../store/playbackStore";
import { TAKEOFF_CHANNELS } from "../../../../utils/maneuversConfig";

const { selectedClassName, selectedProjectId, selectedDate, selectedDatasetId } = persistantStore;

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

export default function FleetManeuversPage() {
  // Use fleet context for this component
  const context = 'fleet';
  
  const [eventTypes] = createSignal<string[]>(['TACK','GYBE','ROUNDUP','BEARAWAY','TAKEOFF']);
  const [phases] = createSignal<string[]>(['FULL','INVESTMENT','TURN','ACCELERATION']);
  // For fleet context, allow coloring by SOURCE, CONFIG, and STATE
  const [colors] = createSignal<string[]>(['SOURCE', 'CONFIG', 'STATE']);
  const [grades] = createSignal<string[]>(['ALL','> 1','1','2','3']);
  const [twsoptions, setTwsOptions] = createSignal<string[]>([]);

  const [views] = createSignal<string[]>(['MAP','TABLE','SCATTER','TIME SERIES']);
  const [view, setView] = createSignal<'MAP' | 'TABLE' | 'SCATTER' | 'TIME SERIES' | 'VIDEO'>('MAP');
  const [groupedOptions] = createSignal<string[]>(['OFF','ON','MIX']);
  const [scatterKey, setScatterKey] = createSignal<number>(0);

  // Timeseries description options
  const [descriptionOptions, setDescriptionOptions] = createSignal<string[]>([]);
  const [selectedDescription, setSelectedDescription] = createSignal<string>('BASICS');

  // State for ManeuverSettings
  const [raceOptions, setRaceOptions] = createSignal<(number | string)[]>([]);
  const [legOptions, setLegOptions] = createSignal<number[]>([]);
  const [gradeOptions, setGradeOptions] = createSignal<number[]>([]);
  const [stateOptions, setStateOptions] = createSignal<string[]>([]);
  const [selectedRaces, setSelectedRaces] = createSignal<(number | string)[]>([]);
  const [selectedLegs, setSelectedLegs] = createSignal<number[]>([]);
  const [selectedGrades, setSelectedGrades] = createSignal<number[]>([]);
  const [selectedStates, setSelectedStates] = createSignal<string[]>([]);
  
  // Source selection state
  const [selectedSources, setSelectedSources] = createSignal<Set<number>>(new Set());

  // Memoize view options. VIDEO only when group is OFF (not ON/MIX).
  const viewOptions = createMemo<string[]>(() => {
    const base = grouped() ? ['MAP','TABLE','BOXES','TIME SERIES'] : views();
    if (grouped()) {
      return base;
    }
    return [...base, 'VIDEO'];
  });

  // Abort controllers for canceling requests
  let tableDataController: AbortController | null = null;
  let timesController: AbortController | null = null;

  /** After onMount applies project/persistent filters — prevents createEffects from racing ahead and double-fetching. */
  const [fleetMountComplete, setFleetMountComplete] = createSignal(false);
  let fleetTableFetchDebounce: ReturnType<typeof setTimeout> | null = null;

  // Fetch timeseries description options from API
  const fetchTimeseriesOptions = async () => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        logDebug('FleetManeuvers: Cannot fetch timeseries options - missing className or projectId');
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
        logDebug('FleetManeuvers: Loaded timeseries description options:', options);
      } else {
        logDebug('FleetManeuvers: Failed to fetch timeseries options or invalid response:', result);
        // Default fallback
        setDescriptionOptions(['BASICS']);
        setSelectedDescription('BASICS');
        setManeuverTimeseriesDescription('BASICS');
      }
    } catch (error: any) {
      logError('FleetManeuvers: Error fetching timeseries options:', error);
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
        logDebug('FleetManeuvers: fetchTableData for TAKEOFF', { date: selectedDate(), sourcesCount: sourcesStore.sources()?.length ?? 0 });
      }

    try {
      // Get date and sources
      const date = selectedDate();
      if (!date || date.trim() === '') {
        // Persistent settings merges can briefly clear selectedDate in localStorage; do not wipe in-memory maneuvers
        // (that unmounts the map and causes duplicate fetchMapData).
        if (untrack(() => maneuvers().length > 0)) {
          logDebug('FleetManeuvers: fetchTableData skipped — empty date while maneuvers loaded (store settling)');
          return;
        }
        setManeuvers([]);
        setTableData([]);
        setFiltered([]);
        setTwsOptions(['ALL']);
        return;
      }

      const sourcesReady = sourcesStore.isReady();
      const sources = sourcesStore.sources();
      if (!sourcesReady || !sources || sources.length === 0) {
        if (untrack(() => maneuvers().length > 0)) {
          logDebug('FleetManeuvers: fetchTableData skipped — sources not ready while maneuvers loaded');
          return;
        }
        setManeuvers([]);
        setTableData([]);
        setFiltered([]);
        setTwsOptions(['ALL']);
        return;
      }

      // Fetch data from selected sources and aggregate
      const allData: any[] = [];

      // Build filters so user's grade choice (e.g. All / >0) is applied server-side; without this, backend defaults to grade > 1
      const filters: Record<string, number[] | string[]> = {};
      const grades = selectedGrades();
      if (grades.length > 0) {
        filters.GRADE = grades.map(g => Number(g)).filter(n => !isNaN(n));
      }
      // Training/Racing filter: pass to API so SQL can filter (racing = exclude training, training = only training)
      const trainingRacingVal = raceOptions().length === 0 ? null : maneuverTrainingRacing();
      if (trainingRacingVal === 'TRAINING' || trainingRacingVal === 'RACING') {
        filters.TRAINING_RACING = [trainingRacingVal];
      }
      // For TAKEOFF, request only takeoff-relevant channels (not tack/gybe columns)
      const channelsToRequest = (requestEventType || '').toUpperCase() === 'TAKEOFF'
        ? ['twa_entry', ...TAKEOFF_CHANNELS]
        : MANEUVERS_CHANNELS;
      let baseUrl = `${apiEndpoints.app.data}/maneuvers?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(date)}&event_type=${encodeURIComponent(requestEventType)}&channels=${encodeURIComponent(JSON.stringify(channelsToRequest))}`;
      if (Object.keys(filters).length > 0) {
        baseUrl += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
      }

      // Filter sources to only fetch from selected ones
      const selectedSourceIds = selectedSources();
      const sourcesToFetch = selectedSourceIds.size > 0 
        ? sources.filter((s: any) => selectedSourceIds.has(s.source_id))
        : sources; // If no sources selected, fetch from all (default behavior)

      // Fetch data from each selected source in parallel
      const fetchPromises = sourcesToFetch.map(async (source: any) => {
        try {
          // Use new simplified single date endpoint - expects source_names (array) not source_id
          const sourceNames = [source.source_name];
          const url = `${baseUrl}&source_names=${encodeURIComponent(JSON.stringify(sourceNames))}`;
          const result = await getData(url, tableDataController!.signal);
          
          if (result.success && result.data && Array.isArray(result.data)) {
            // Add source_name to each item
            return result.data.map((item: any) => ({
              ...item,
              source_name: source.source_name
            }));
          }
          return [];
        } catch (error: unknown) {
          if (error instanceof Error && error.name === 'AbortError') {
            return [];
          }
          logError(`Error fetching data for source ${source.source_name}:`, error as any);
          return [];
        }
      });

      const results = await Promise.all(fetchPromises);
      
      if (requestEventType.toUpperCase() === 'TAKEOFF') {
        logDebug('FleetManeuvers: TAKEOFF fetchTableData results', {
          sourceCounts: results.map((arr, i) => ({ source: sourcesToFetch[i]?.source_name, rows: arr?.length ?? 0 })),
          totalRows: results.reduce((sum, arr) => sum + (arr?.length ?? 0), 0)
        });
      }

      // Ignore response if user changed maneuver type before this request completed (avoid stale overwrite)
      if ((eventType() || 'TACK').trim() !== requestEventType) {
        return;
      }

      // Combine all data from all sources
      results.forEach((sourceData: any[]) => {
        allData.push(...sourceData);
      });

      // Add datetimeLocal (dataset local time) for table and tooltips
      allData.forEach((item: any) => {
        const tz = (item.timezone ?? item.Timezone ?? "").trim() || undefined;
        const rawDt = item.Datetime ?? item.datetime;
        if (rawDt && tz) {
          try {
            const formatted = formatDateTime(rawDt, tz);
            if (formatted) item.datetimeLocal = formatted;
          } catch {
            // leave datetimeLocal undefined
          }
        }
      });

      if (allData.length > 0) {
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

        // Generate TWS bins in intervals of 5
        // Extract all TWS values from data
        const twsValues: number[] = [];
        allData.forEach((item: any) => {
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
        allData.forEach((item: any) => {
          const state = item.State ?? item.state ?? item.STATE;
          if (state != null && state !== undefined && String(state).trim() !== '') {
            stateValues.add(String(state).trim());
          }
        });
        const sortedStates = Array.from(stateValues).sort();
        setStateOptions(sortedStates);

        setManeuvers(allData)

        // Let filterData set filtered/selection once after TWS/grade/state filters (avoids map double-fetch on full list then filtered list).
        filterData(allData)
      } else {
        // Handle empty data - reset to empty state only if this response is still current
        if ((eventType() || 'TACK').trim() === requestEventType) {
          if (requestEventType.toUpperCase() === 'TAKEOFF') {
            logDebug('FleetManeuvers: TAKEOFF table/scatter received no rows from API');
          }
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          setTwsOptions(['ALL']);
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Request was cancelled - this is expected, no error needed
      } else {
        if ((eventType() || 'TACK').trim() === requestEventType) {
          logError('Error fetching table data:', error as any);
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          setTwsOptions(['ALL']);
        }
      }
    } finally {
      tableDataController = null;
    }
  };

  const scheduleFleetTableFetch = () => {
    if (fleetTableFetchDebounce) clearTimeout(fleetTableFetchDebounce);
    fleetTableFetchDebounce = setTimeout(() => {
      fleetTableFetchDebounce = null;
      void fetchTableData();
    }, 100);
  };

  const handleEventType = (val: string): void => {
    const prev = (eventType() || '').trim().toUpperCase();
    setEventType(val);
    const valUpper = (val || '').trim().toUpperCase();
    if (valUpper === 'TAKEOFF') {
      setSelectedStates([]);
      setSelectedStatesManeuvers([]);
      logDebug('FleetManeuvers: TAKEOFF selected — cleared state filters');
    } else if (prev === 'TAKEOFF') {
      loadFiltersFromPersistentSettings();
      logDebug('FleetManeuvers: Left TAKEOFF — restored persistent filters');
    }
  };

  const handlePhase = (val: string): void => {
    setPhase(val)
    setTriggerUpdate(true);
  };

  const handleView = async (val: string): Promise<void> => {
    const normalized = (val === 'BOXES') ? 'SCATTER' : val;
    // Guard to satisfy the view signal's union type
    if (normalized === 'MAP' || normalized === 'TABLE' || normalized === 'SCATTER' || normalized === 'TIME SERIES' || normalized === 'VIDEO') {
      setView(normalized);
      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
      await logActivity(project_id, dataset_id, 'FleetManeuvers.tsx', 'Fleet Maneuvers Report', `View changed to ${normalized}`);
      if (normalized === 'VIDEO') {
        const dateStr = selectedDate() ?? '';
        const dateYmd = dateStr.replace(/\D/g, '').slice(0, 8);
        if (dateYmd.length >= 8) {
          const data = maneuvers();
          const seen = new Set<string>();
          const entries: Array<{ sourceName: string; dateYmd: string }> = [];
          for (const row of data ?? []) {
            const sn = row?.source_name ?? row?.sourceName ?? row?.Source_name ?? row?.source ?? '';
            if (typeof sn === 'string' && sn.trim() && !seen.has(sn.trim().toLowerCase())) {
              seen.add(sn.trim().toLowerCase());
              entries.push({ sourceName: sn.trim(), dateYmd });
            }
          }
          if (entries.length > 0) {
            await mediaAvailabilityService.preloadForSourcesAndDates(entries, getCurrentDatasetTimezone());
          }
        }
      }
      // Always re-run filterData on view change: VIDEO view filters by has-video; other views show all (grade/TWS/etc) maneuvers
      filterData();
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
    await logActivity(project_id, dataset_id, 'FleetManeuvers.tsx', 'Fleet Maneuvers Report', `Color changed to ${val}`);
    setTriggerUpdate(true)
  };

  const sortedEventIdsEqual = (a: unknown[], b: number[]): boolean => {
    if (!Array.isArray(a) || a.length !== b.length) return false;
    const toId = (x: unknown) => (typeof x === 'number' ? x : (x as { event_id?: number })?.event_id);
    const numsA = a.map(toId).filter((id): id is number => typeof id === 'number' && id > 0).sort((x, y) => x - y);
    const numsB = [...b].filter((id): id is number => typeof id === 'number' && id > 0).sort((x, y) => x - y);
    if (numsA.length !== numsB.length) return false;
    return numsA.every((v, i) => v === numsB[i]);
  };

  const filterData = (dataOverride?: any[]): void => {
    // Use provided data or read from store - this avoids race conditions
    const maneuversData = dataOverride ?? maneuvers();
    if (!maneuversData || !Array.isArray(maneuversData) || maneuversData.length === 0) {
      const hadFiltered = filtered().length > 0;
      setFiltered([]);
      setTableData([]);
      if (hadFiltered) {
        setTriggerUpdate(true);
      }
      return;
    }

    let filteredData_tws: any[] = []

    if (tws() == 'ALL') {
      filteredData_tws = maneuversData;
    } else {
      // Filter data where TWS value is within ±2.5 of the selected bin (intervals of 5)
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

    // Apply Training/Racing filter only when we have race options; when no races, do not apply this filter
    const trainingRacing = raceOptions().length === 0 ? null : maneuverTrainingRacing();
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

    // When VIDEO view: only show rows that have video (maneuver time falls inside a media window)
    if (view() === 'VIDEO') {
      const tz = getCurrentDatasetTimezone();
      const eventIdsWithVideo = new Set<number>();
      for (const row of filteredData) {
        const sourceName = row?.source_name ?? row?.sourceName ?? row?.Source_name ?? row?.source ?? '';
        if (typeof sourceName !== 'string' || !sourceName.trim()) continue;
        const raw = row?.datetime ?? row?.Datetime ?? row?.DATETIME ?? row?.date ?? row?.Date;
        if (raw == null || (typeof raw === 'string' && !raw.trim())) continue;
        let maneuverTime: Date;
        try {
          maneuverTime = typeof raw === 'string' ? new Date(raw.trim()) : new Date(raw);
          if (Number.isNaN(maneuverTime.getTime())) continue;
        } catch {
          continue;
        }
        if (mediaAvailabilityService.hasVideo(sourceName, maneuverTime, { timezone: tz, clipOffsetSeconds: MANEUVER_VIDEO_START_OFFSET_SECONDS })) {
          eventIdsWithVideo.add(row.event_id);
        }
      }
      filteredData = filteredData.filter((row: any) => eventIdsWithVideo.has(row.event_id));
    }

    // Sort by vmg_perc_avg descending
    filteredData.sort((a: any, b: any) => {
      const aVmg = a.vmg_perc_avg ?? 0;
      const bVmg = b.vmg_perc_avg ?? 0;
      return bVmg - aVmg; // Descending order
    });

    const eventIds = filteredData.map((item: any) => item.event_id);
    const prevFiltered = filtered();
    const sameEventSet = sortedEventIdsEqual(prevFiltered, eventIds);

    setFiltered(eventIds)
    setTableData(filteredData)
    
    // Update selection to match filtered data (but don't override user's active selection)
    if (!hasSelection()) {
      setSelection(eventIds as any)
    }

    if (!sameEventSet) {
      setTriggerUpdate(true);
    }
  }

  createEffect(() => {
    if (grouped() && view() === 'VIDEO') {
      setView('MAP');
      filterData();
    }
  });

  const handleTws = async (val: string): Promise<void> => {
    setTws(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'FleetManeuvers.tsx', 'Fleet Maneuvers Report', `TWS changed to ${val}`);
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
      logDebug('FleetManeuvers: Legend click on', legendItem, '- no maneuvers data available');
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
      logDebug('FleetManeuvers: Legend click on', legendItem, '- no matching event IDs found');
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
      logDebug('FleetManeuvers: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'event IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      logDebug('FleetManeuvers: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'event IDs');
    }
    
    // Trigger update to refresh views
    setTriggerUpdate(true);
  };

  // Set dataset timezone when date changes so maneuver table datetime is in local time (dataset timezone)
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();

    if (!className || !projectId || !date || String(date).trim() === "") {
      await setCurrentDataset(className || "", projectId || 0, null);
      return;
    }

    try {
      const ymd = String(date).replace(/[-/]/g, "");
      const timezoneResponse = await getData(
        `${apiEndpoints.app.datasets}/date/timezone?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(ymd)}`
      );

      const timezoneData = timezoneResponse?.data || timezoneResponse || {};
      const timezone = timezoneData.timezone;
      const datasetId = timezoneData.dataset_id;

      if (timezone && datasetId) {
        await setCurrentDataset(className, projectId, datasetId);
        logDebug("FleetManeuvers: Set timezone from date endpoint for table datetime", {
          datasetId,
          timezone: getCurrentDatasetTimezone(),
        });
      } else {
        await setCurrentDataset(className, projectId, null);
      }
    } catch (error: unknown) {
      logDebug("FleetManeuvers: Error setting timezone for date", error as any);
      await setCurrentDataset(className, projectId, null);
    }
  });

  // Initialize selectedSources from persistent settings
  createEffect(async () => {
    const sourcesReady = sourcesStore.isReady();
    const sources = sourcesStore.sources();
    const currentUser = user();
    
    if (!sourcesReady || !sources || sources.length === 0 || !currentUser?.user_id) {
      return;
    }
    
    // Only initialize once - check if already initialized
    if (selectedSources().size > 0) {
      return;
    }
    
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
            debug('FleetManeuvers: Initialized sources from persistent settings', Array.from(sourceIds));
          } else {
            // No matching sources found - default to all sources
            const allSourceIds = new Set(sources.map((s: any) => s.source_id).filter((id: any) => id !== null && id !== undefined));
            setSelectedSources(allSourceIds);
            debug('FleetManeuvers: No matching sources found, defaulting to all sources');
          }
        } else {
          // No saved settings - default to all sources
          const allSourceIds = new Set(sources.map((s: any) => s.source_id).filter((id: any) => id !== null && id !== undefined));
          setSelectedSources(allSourceIds);
          debug('FleetManeuvers: No saved source settings, defaulting to all sources');
        }
      }
    } catch (error) {
      debug('FleetManeuvers: Error loading source settings, defaulting to all sources', error);
      // On error, default to all sources
      const allSourceIds = new Set(sources.map((s: any) => s.source_id).filter((id: any) => id !== null && id !== undefined));
      setSelectedSources(allSourceIds);
    }
  });

  // One debounced table refetch for: date, maneuver type, selected sources, training/racing. Waits until onMount
  // applied project filters so we do not race effects against loadFiltersFromPersistentSettings / getProjectManeuverFilters.
  createEffect(
    on(
      () => {
        const sources = sourcesStore.sources() ?? [];
        const allIds = sources
          .map((s: { source_id?: number }) => s.source_id)
          .filter((id: unknown): id is number => typeof id === 'number' && id > 0)
          .sort((a, b) => a - b);
        const sel = selectedSources();
        const isAll =
          sel.size === 0 ||
          (allIds.length > 0 &&
            sel.size === allIds.length &&
            allIds.every((id) => sel.has(id)));
        const selKey = isAll ? '__ALL__' : [...sel].sort((a, b) => a - b).join(',');

        return {
          mount: fleetMountComplete(),
          et: (eventType() || 'TACK').trim() || 'TACK',
          date: (selectedDate() || '').trim(),
          ready: sourcesStore.isReady(),
          nsrc: sources.length,
          selKey,
          tr: raceOptions().length === 0 ? null : maneuverTrainingRacing(),
        };
      },
      (cur, prev) => {
        if (!cur.mount) return;
        if (!cur.ready || cur.nsrc === 0 || !cur.date || !cur.et) return;

        const payload = { et: cur.et, date: cur.date, selKey: cur.selKey, tr: cur.tr };
        const prevPayload =
          prev && prev.mount ? { et: prev.et, date: prev.date, selKey: prev.selKey, tr: prev.tr } : null;
        if (prevPayload && JSON.stringify(payload) === JSON.stringify(prevPayload)) return;

        scheduleFleetTableFetch();
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

  // React to filter changes - refilter when filters change (client-side for grade/state/race/leg)
  createEffect(on([selectedGrades, selectedStates, selectedRaces, selectedLegs], () => {
    if (untrack(() => maneuvers().length > 0)) {
      filterData();
    }
  }));

  // Training/racing is included in the unified fleet table fetch effect (tr in payload).

  // React to view and data: map/table layout is inside Show when filtered maneuvers exist, so we must
  // re-measure after async fetch (dataset Maneuvers runs fetch before first updateContainerHeights in onMount).
  createEffect(() => {
    view();
    filtered().length;
    maneuvers().length;
    setTimeout(() => {
      const headerHeight = 58;
      const additionalSpacingForMap = 100;
      const mapHeight = window.innerHeight - headerHeight - additionalSpacingForMap;
      const additionalSpacingForTable = 80;
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
      if (view() === 'MAP') {
        setTimeout(() => {
          syncTableHeightWithMap();
        }, 200);
      }
      if (view() === 'VIDEO') {
        setTimeout(() => syncTableHeightWithVideo(), 200);
      }
    }, 0);
  });

  // When VIDEO view and we have data + date, ensure media availability is preloaded then re-filter
  // Only run when view changes to VIDEO or when filters change the maneuvers data
  createEffect(on([view, maneuvers], ([currentView, data]) => {
    if (currentView !== 'VIDEO') return;
    const dateStr = untrack(() => selectedDate() ?? '');
    const dateYmd = dateStr.replace(/\D/g, '').slice(0, 8);
    if (dateYmd.length < 8) return;
    if (!data?.length) return;
    const seen = new Set<string>();
    const entries: Array<{ sourceName: string; dateYmd: string }> = [];
    for (const row of data) {
      const sn = row?.source_name ?? row?.sourceName ?? row?.Source_name ?? row?.source ?? '';
      if (typeof sn === 'string' && sn.trim() && !seen.has(sn.trim().toLowerCase())) {
        seen.add(sn.trim().toLowerCase());
        entries.push({ sourceName: sn.trim(), dateYmd });
      }
    }
    if (entries.length === 0) return;
    (async () => {
      try {
        await mediaAvailabilityService.preloadForSourcesAndDates(entries, untrack(() => getCurrentDatasetTimezone()));
        untrack(() => filterData());
      } catch (_) {}
    })();
  }));

  createEffect(async () => {
    if (selectedEvents().length > 0) {
      // Skip fetching times in fleet context - the /api/events/times endpoint requires dataset_id
      // and doesn't support fleet context (source_id + date). Time ranges are not critical for
      // fleet maneuvers - they're mainly used for highlighting selected events.
      const datasetId = selectedDatasetId();
      if (!datasetId || datasetId <= 0) {
        // Fleet context - skip times fetch
        logDebug('FleetManeuvers: Skipping times fetch in fleet context (endpoint requires dataset_id)');
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

  // In fleet context (no dataset_id), selectedRanges is not fetched by selectionStore. Populate it from table data so VIDEO view and play/pause have correct start times.
  createEffect(() => {
    const datasetId = selectedDatasetId();
    if (datasetId != null && datasetId > 0) return;
    const ids = selectedEvents();
    if (!Array.isArray(ids) || ids.length === 0) {
      return;
    }
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

  const syncTableHeightWithVideo = (): void => {
    if (view() !== 'VIDEO') return;
    const layout = document.querySelector('.maneuver-map-layout') as HTMLElement | null;
    const tableArea = document.getElementById('table-area') as HTMLElement | null;
    if (layout && tableArea) {
      const layoutHeight = layout.offsetHeight || layout.clientHeight;
      if (layoutHeight > 0) {
        tableArea.style.height = `${layoutHeight}px`;
        tableArea.style.minHeight = `${layoutHeight}px`;
      }
    }
  };

  // Function to update container heights based on actual viewport (full screen)
  const updateContainerHeights = (): void => {
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
    
    setTimeout(() => {
      if (view() === 'MAP') syncTableHeightWithMap();
      if (view() === 'VIDEO') syncTableHeightWithVideo();
    }, 100);
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

          logDebug('FleetManeuvers: Loaded settings from persistent settings', settings);
          let gradesLoaded = false;
          let statesLoaded = false;
          if (settings?.maneuverFilters) {
            const filters = settings.maneuverFilters;
            if (filters.grades && Array.isArray(filters.grades) && filters.grades.length > 0) {
              setSelectedGrades(filters.grades);
              setSelectedGradesManeuvers(filters.grades.map((g: number) => String(g)));
              gradesLoaded = true;
              logDebug('FleetManeuvers: Loaded grade filters from persistent settings', filters.grades);
            }
            if (filters.states && Array.isArray(filters.states) && filters.states.length > 0) {
              setSelectedStates(filters.states);
              setSelectedStatesManeuvers(filters.states);
              statesLoaded = true;
              logDebug('FleetManeuvers: Loaded state filters from persistent settings', filters.states);
            }
            if (filters.races && Array.isArray(filters.races) && filters.races.length > 0) {
              setSelectedRaces(filters.races);
              setSelectedRacesManeuvers(filters.races.map((r: number | string) => String(r)));
              logDebug('FleetManeuvers: Loaded race filters from persistent settings', filters.races);
            }
            if (filters.legs && Array.isArray(filters.legs) && filters.legs.length > 0) {
              setSelectedLegs(filters.legs);
              setSelectedLegsManeuvers(filters.legs.map((l: number) => String(l)));
              logDebug('FleetManeuvers: Loaded leg filters from persistent settings', filters.legs);
            }
            if (filters.trainingRacing === 'TRAINING' || filters.trainingRacing === 'RACING') {
              setManeuverTrainingRacing(filters.trainingRacing);
              logDebug('FleetManeuvers: Loaded trainingRacing filter from persistent settings', filters.trainingRacing);
            }
          } else {
            logDebug('FleetManeuvers: No maneuverFilters found in settings', settings);
          }
          
          // Set default grade >1 (shows grades 2 and 3) if no grades were loaded from persistent settings
          if (!gradesLoaded) {
            setSelectedGrades([1]);
            setSelectedGradesManeuvers(['1']);
            logDebug('FleetManeuvers: Set default grade filter to [1] (>1)');
          }
          // Set default state H0 if no states were loaded from persistent settings
          if (!statesLoaded) {
            setSelectedStates(['H0']);
            setSelectedStatesManeuvers(['H0']);
            logDebug('FleetManeuvers: Set default state filter to [H0]');
          }
        }
      } catch (error) {
        logDebug('FleetManeuvers: Error loading filters from persistent settings:', error);
        if (selectedGrades().length === 0) {
          setSelectedGrades([1]);
          setSelectedGradesManeuvers(['1']);
          logDebug('FleetManeuvers: Set default grade filter to [1] (>1) after error');
        }
        if (selectedStates().length === 0) {
          setSelectedStates(['H0']);
          setSelectedStatesManeuvers(['H0']);
          logDebug('FleetManeuvers: Set default state filter to [H0] after error');
        }
      }
    } else {
      if (selectedGrades().length === 0) {
        setSelectedGrades([1]);
        setSelectedGradesManeuvers(['1']);
        logDebug('FleetManeuvers: Set default grade filter to [1] (>1) (no user)');
      }
      if (selectedStates().length === 0) {
        setSelectedStates(['H0']);
        setSelectedStatesManeuvers(['H0']);
        logDebug('FleetManeuvers: Set default state filter to [H0] (no user)');
      }
    }
  };

  onMount(async () => {
    await logPageLoad('FleetManeuvers.jsx', 'Fleet Maneuvers Analysis Report');
    
    // Wait for sources to be ready (poll until ready)
    while (!sourcesStore.isReady()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Set default color to SOURCE for fleet context; default TWS to ALL
    setColor('SOURCE');
    setEventType("TACK")
    setView("MAP")
    setTws('ALL')
    
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const dateForFilters = (selectedDate() || '').trim() || undefined;
    const projectFilters = (className && projectId) ? await getProjectManeuverFilters(className, projectId, dateForFilters) : null;
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
        logDebug('FleetManeuvers: Applied grade filters from project default', projectFilters.grades);
      }
      if (projectFilters.states !== undefined) {
        const states = Array.isArray(projectFilters.states) ? projectFilters.states : [];
        setSelectedStates(states);
        setSelectedStatesManeuvers(states);
        logDebug('FleetManeuvers: Applied state filters from project default', projectFilters.states);
      }
    }
    // Fetch timeseries description options
    await fetchTimeseriesOptions();

    // Allow the single unified createEffect to run (debounced); avoids overlapping fetches with effects during this async onMount.
    setFleetMountComplete(true);
    
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
    if (fleetTableFetchDebounce) {
      clearTimeout(fleetTableFetchDebounce);
      fleetTableFetchDebounce = null;
    }
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
    
    // Clear any stored data to free memory
    setManeuvers([]);
    setTableData([]);
    setFiltered([]);
    
    logDebug('FleetManeuvers: Cleanup complete - abort controllers cleared and data reset');
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

  return (
    <div id="media-container" class="maneuvers-page">
      <div class="container">
        {/* Controls always visible so user can change filters even when no data */}
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
                    onRaceLegOptionsLoaded={(count) => {
                      if (count === 0 && maneuverTrainingRacing() === 'RACING') setManeuverTrainingRacing(null);
                    }}
                    setRaceOptions={setRaceOptions}
                    setLegOptions={setLegOptions}
                    setGradeOptions={setGradeOptions}
                    setStateOptions={setStateOptions}
                    toggleRaceFilter={toggleRaceFilter}
                    toggleLegFilter={toggleLegFilter}
                    toggleGradeFilter={toggleGradeFilter}
                    toggleStateFilter={toggleStateFilter}
                    onApplyFilters={async () => { await fetchTableData(); filterData(); }}
                    useUnfilteredOptions={true}
                    includeAllGradeOption={true}
                    dataSourcesOptions={dataSourcesOptions()}
                    filterConfig={{
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
                <Show when={view() === 'TIME SERIES' || view() === 'MAP' || view() === 'VIDEO'}>
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
                <Show when={view() === 'MAP' || view() === 'TIME SERIES' || view() === 'SCATTER' || view() === 'VIDEO'}>
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
        {/* Content section: empty state when no data, then filter-too-strict or views */}
        <Show when={!hasManeuvers()} fallback={null}>
          <div class="flex flex-col items-center justify-center w-full min-h-[40vh] px-4 text-gray-600">
            <p class="text-lg font-medium">No maneuvers to display</p>
            <p class="text-sm mt-2 text-center max-w-md">
              Select a date and ensure sources are available. Adjust filters above and apply to reload.
            </p>
          </div>
        </Show>
        <Show when={hasManeuvers() && !hasFilteredManeuvers()}>
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
            <Show when={view() === 'VIDEO'}>
              <div id="maneuver-map-layout" class="maneuver-map-layout flex w-full">
                <div id="table-area">
                  <Show when={!grouped()}>
                    <DataTable_Small context={context} useSelectionIndexColors={true} />
                  </Show>
                  <Show when={grouped()}>
                    <DataTable_SmallGrouped context={context} />
                  </Show>
                </div>
                <div id="map-area">
                  <Video context={context} onDataUpdate={fetchTableData} />
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
