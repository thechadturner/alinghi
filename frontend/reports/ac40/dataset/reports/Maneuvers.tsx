import { createSignal, onMount, createEffect, Show, on, untrack, createMemo } from "solid-js";

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
import ScatterTimeseries from "../../../../components/charts/ScatterTimeseries";

import { setupMediaContainerScaling } from "../../../../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../../../../utils/logging";
import { error as logError, warn as logWarning, debug as logDebug } from "../../../../utils/console";

import { phase, setPhase, color, setColor, tws, setTws, eventType, setEventType, grouped, groupDisplayMode, setGroupDisplayMode, maneuvers, setManeuvers, setTableData, setFiltered, filtered, hasVideoMenu } from "../../../../store/globalStore";
import { selectedEvents, setSelectedEvents, setTriggerUpdate, setTriggerSelection, setSelection, setHasSelection, hasSelection, isCut, cutEvents, cutSelection, clearSelection, hideSelectedEvents, setSelectedGroupKeys } from "../../../../store/selectionStore";

import { persistantStore } from "../../../../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { getData, getEventTimes, putData, formatDateTime } from "../../../../utils/global";
import ManeuverSettings from "../../../../components/menus/ManeuverSettings";
import PerformanceFilterSummary from "../../../../components/legends/PerformanceFilterSummary";
import { persistentSettingsService } from "../../../../services/persistentSettingsService";
import { getProjectManeuverFilters } from "../../../../services/projectFiltersService";
import { user } from "../../../../store/userStore";
import {
  selectedGradesManeuvers,
  selectedStatesManeuvers,
  selectedRacesManeuvers,
  selectedLegsManeuvers,
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
import { legendTextToGroupKeyTable } from "../../../../utils/colorGrouping";
import { mediaAvailabilityService } from "../../../../services/mediaAvailabilityService";
import { MANEUVER_VIDEO_START_OFFSET_SECONDS } from "../../../../store/playbackStore";
import { getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { TAKEOFF_CHANNELS } from "../../../../utils/maneuversConfig";

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName } = persistantStore;

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

export default function ManeuversPage() {
  // Use dataset context for this component
  const context = 'dataset';
  
  const [eventTypes] = createSignal<string[]>(['TACK','GYBE','ROUNDUP','BEARAWAY','TAKEOFF']);
  const [phases] = createSignal<string[]>(['FULL','INVESTMENT','TURN','ACCELERATION']);
  const [colors] = createSignal<string[]>(['TWS','VMG','TACK','CONFIG','RACE','STATE']);
  const [twsoptions, setTwsOptions] = createSignal<string[]>([]);

  const [views] = createSignal<string[]>(['MAP','TABLE','SCATTER','TIME SERIES']);
  const [view, setView] = createSignal<'MAP' | 'TABLE' | 'SCATTER' | 'TIME SERIES' | 'VIDEO'>('MAP');
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
  
  // Memoize view options to prevent SolidJS computation warnings. VIDEO only when group is OFF and video menu is available.
  const viewOptions = createMemo<string[]>(() => {
    const base = grouped() ? ['MAP','TABLE','BOXES','TIME SERIES'] : views();
    if (grouped() || !hasVideoMenu()) {
      return base;
    }
    return [...base, 'VIDEO'];
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
        logDebug('Maneuvers: Cannot fetch timeseries options - missing className or projectId');
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
        logDebug('Maneuvers: Loaded timeseries description options:', options);
      } else {
        logWarning('Maneuvers: Failed to fetch timeseries options or invalid response:', result);
        // Default fallback
        setDescriptionOptions(['BASICS']);
        setSelectedDescription('BASICS');
        setManeuverTimeseriesDescription('BASICS');
      }
    } catch (error: any) {
      logError('Maneuvers: Error fetching timeseries options:', error);
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

    // Capture event type for this request so we don't apply a stale response (e.g. GYBE) over current type (e.g. TACK)
    const requestEventType = (eventType() || 'TACK').trim() || 'TACK';

    try {
      // Build filters so grade, state, and training/racing are applied server-side
      const filters: Record<string, number[] | string[]> = {};
      const grades = selectedGrades();
      if (grades.length > 0) {
        filters.GRADE = grades.map(g => Number(g)).filter(n => !isNaN(n));
      }
      const states = selectedStates();
      if (states.length > 0) {
        filters.STATE = states;
      }
      const trainingRacingVal = raceOptions().length === 0 ? null : maneuverTrainingRacing();
      if (trainingRacingVal === 'TRAINING' || trainingRacingVal === 'RACING') {
        filters.TRAINING_RACING = [trainingRacingVal];
      }
      // TAKEOFF needs twa_entry (from Twa_start) so we can set tack to Port/Stbd
      const channelsToRequest = (requestEventType || '').toUpperCase() === 'TAKEOFF'
        ? ['twa_entry', ...TAKEOFF_CHANNELS]
        : MANEUVERS_CHANNELS;
      let url = `${apiEndpoints.app.data}/maneuvers-table-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent(requestEventType)}&channels=${encodeURIComponent(JSON.stringify(channelsToRequest))}`;
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
        let data = result_json.data;

        // Add datetimeLocal (dataset local time) for table and tooltips
        data.forEach((item: any) => {
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

        // TAKEOFF, BEARAWAY, ROUNDUP: Port/Stbd from entry or build TWA (like bearaway/roundup), not S-P / P-S
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

        // Generate TWS bins in increments of 5 for GP50
        // Find min and max TWS values from the data
        const twsValues: number[] = [];
        data.forEach((item: any) => {
          const twsValue = item.tws_avg ?? item.tws_bin;
          if (twsValue !== null && twsValue !== undefined && !isNaN(Number(twsValue))) {
            twsValues.push(Number(twsValue));
          }
        });

        const tws_bins: string[] = ['ALL'];
        if (twsValues.length > 0) {
          const minTws = Math.min(...twsValues);
          const maxTws = Math.max(...twsValues);
          
          // Round min down to nearest multiple of 5, round max up to nearest multiple of 5
          const minBin = Math.floor(minTws / 5) * 5;
          const maxBin = Math.ceil(maxTws / 5) * 5;
          
          // Generate bins in increments of 5
          for (let bin = minBin; bin <= maxBin; bin += 5) {
            tws_bins.push(String(bin));
          }
        }
        setTwsOptions(tws_bins);

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

        setManeuvers(data)

        // Pass data directly to filterData to avoid race condition with store updates.
        // Do not setFiltered here — filterData applies TWS/grade/state filters and sets filtered once (avoids map fetching full list then filtered list).
        filterData(data)
      } else {
        // Handle API error response - reset to empty state only if this response is still current
        if ((eventType() || 'TACK').trim() !== requestEventType) return;
        const errorMessage = result_json?.message || result_json?.error || (result_json?.success === false ? 'API returned unsuccessful response' : 'Unknown error');
        logWarning('Failed to fetch table data:', errorMessage, result_json);
        setManeuvers([]);
        setTableData([]);
        setFiltered([]);
        setTwsOptions(['ALL']);
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
  }

  const handleEventType = (val: string) => {
    const prev = (eventType() || '').trim().toUpperCase();
    setEventType(val);
    const valUpper = (val || '').trim().toUpperCase();
    if (valUpper === 'TAKEOFF') {
      setSelectedStates([]);
      setSelectedStatesManeuvers([]);
      logDebug('Maneuvers: TAKEOFF selected — cleared state filters');
    } else if (prev === 'TAKEOFF') {
      loadFiltersFromPersistentSettings();
      logDebug('Maneuvers: Left TAKEOFF — restored persistent filters');
    }
  };

  const handlePhase = (val: string) => {
    setPhase(val)
    setTriggerUpdate(true);
  };

  const handleView = async (val: string) => {
    const normalized = (val === 'BOXES') ? 'SCATTER' : val;
    // Guard to satisfy the view signal's union type
    if (normalized === 'MAP' || normalized === 'TABLE' || normalized === 'SCATTER' || normalized === 'TIME SERIES' || normalized === 'VIDEO') {
      setView(normalized);
      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
      await logActivity(project_id, dataset_id, 'Maneuvers.tsx', 'Maneuvers Report', `View changed to ${normalized}`);
      if (normalized === 'VIDEO') {
        const data = maneuvers();
        const first = data?.[0];
        const raw = first?.datetime ?? first?.Datetime ?? first?.DATETIME ?? first?.date ?? first?.Date;
        if (raw != null && (typeof raw !== 'string' || raw.trim() !== '')) {
          try {
            const d = typeof raw === 'string' ? new Date(raw.trim()) : new Date(raw);
            if (!Number.isNaN(d.getTime())) {
              const dateYmd = mediaAvailabilityService.getDateYmdFromDatetime(d, getCurrentDatasetTimezone());
              await mediaAvailabilityService.preloadForDate(dateYmd, getCurrentDatasetTimezone());
            }
          } catch (_) {}
        }
      }
      // Always re-run filterData on view change: VIDEO view filters by has-video; other views show all (grade/TWS/etc) maneuvers
      filterData();
    }
    setTriggerUpdate(true);
  };

  const handleColor = async (val: string) => {
    setColor(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'Maneuvers.tsx', 'Maneuvers Report', `Color changed to ${val}`);
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

  const filterData = (dataOverride?: any[]) => {
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
      // For gp50, filter by TWS bin (intervals of 5, ±2.5 from selected value)
      const selectedTws = Number(tws());
      if (!isNaN(selectedTws)) {
        filteredData_tws = maneuversData.filter((item: any) => {
          const itemTws = item.tws_bin ?? item.tws_avg;
          if (itemTws === null || itemTws === undefined || isNaN(Number(itemTws))) {
            return false;
          }
          const itemTwsNum = Number(itemTws);
          // Filter within ±2.5 of the selected bin value
          // Bin 5 includes values from 2.5 to 7.5 (exclusive on upper bound to avoid overlap)
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
      filteredData = filteredData_tws.filter(item => {
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
      filteredData = filteredData.filter(item => {
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
      filteredData = filteredData.filter(item => {
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
      filteredData = filteredData.filter(item => {
        const legValue = item.leg_number ?? item.Leg_number ?? item.LEG;
        if (legValue == null || legValue === undefined) return false;
        return legs.includes(Number(legValue));
      });
    }

    // Apply Training/Racing filter only when we have race options; when no races, do not apply this filter
    const trainingRacing = raceOptions().length === 0 ? null : maneuverTrainingRacing();
    if (trainingRacing === 'RACING') {
      filteredData = filteredData.filter(item => {
        const raceValue = item.race_number ?? item.Race_number ?? item.race ?? item.Race;
        if (raceValue == null || raceValue === undefined) return false;
        const isTraining = raceValue === -1 || raceValue === '-1' || (typeof raceValue === 'string' && String(raceValue).toUpperCase() === 'TRAINING');
        return !isTraining;
      });
    } else if (trainingRacing === 'TRAINING') {
      filteredData = filteredData.filter(item => {
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
      // FleetManeuvers expects cutEvents to be numbers directly, so handle both formats
      const cutEventIds = currentCutEvents
        .map(item => {
          if (typeof item === 'number') {
            return item; // Already an event ID
          } else if (item && typeof item === 'object' && 'event_id' in item) {
            return item.event_id; // Extract event_id from time range object
          }
          return null;
        })
        .filter((id): id is number => id !== null && !isNaN(id));
      
      if (cutEventIds.length > 0) {
        filteredData = filteredData.filter(maneuver => cutEventIds.includes(maneuver.event_id));
      } else {
        filteredData = [];
      }
    }

    // When VIDEO view: only show rows that have video (maneuver time falls inside a media window)
    if (view() === 'VIDEO') {
      const tz = getCurrentDatasetTimezone();
      const sourceName = selectedSourceName?.() ?? '';
      const eventIdsWithVideo = new Set<number>();
      for (const row of filteredData) {
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
      filteredData = filteredData.filter((row) => eventIdsWithVideo.has(row.event_id));
    }

    // Sort by vmg_perc_avg descending
    filteredData.sort((a, b) => {
      const aVmg = a.vmg_perc_avg ?? 0;
      const bVmg = b.vmg_perc_avg ?? 0;
      return bVmg - aVmg; // Descending order
    });

    const eventIds = filteredData.map(item => item.event_id);
    const prevFiltered = filtered();
    const sameEventSet = sortedEventIdsEqual(prevFiltered, eventIds);

    setFiltered(eventIds);
    setTableData(filteredData);
    
    // Update selection to match filtered data (but don't override user's active selection)
    if (!hasSelection()) {
      setSelection(eventIds as any);
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

  const handleTws = async (val: string) => {
    setTws(val)
    const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
    await logActivity(project_id, dataset_id, 'Maneuvers.tsx', 'Maneuvers Report', `TWS changed to ${val}`);
    filterData()
  };

  // Filter toggle handlers
  const toggleRaceFilter = (race: number | string) => {
    const current = selectedRaces();
    const next = current.includes(race) 
      ? current.filter(r => r !== race)
      : [...current, race];
    setSelectedRaces(next);
    // Sync to global filterStore for cross-window sync
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

  // Keep filterStore race/leg/grade options in sync with local signals so Sidebar can broadcast them to maneuver popups
  // (e.g. Filters.tsx updates local options without going through ManeuverSettings’ filterStore writes).
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
      logWarning('Maneuvers: Legend click on', legendItem, '- no maneuvers data available');
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
        
        // For STATE - check State field
        if (currentColorField === 'STATE') {
          const stateValue = m.State ?? m.state ?? m.STATE;
          const clickedStr = clickedItem;
          
          // Try exact match
          if (String(stateValue) === clickedStr) return true;
          
          // Try case-insensitive match
          if (stateValue && String(stateValue).toLowerCase() === clickedStr.toLowerCase()) return true;
          
          return false;
        }
        
        // For CONFIG - check Config field
        if (currentColorField === 'CONFIG') {
          const configValue = m.Config ?? m.config ?? m.CONFIG;
          const clickedStr = clickedItem;
          
          // Try exact match
          if (String(configValue) === clickedStr) return true;
          
          // Try case-insensitive match
          if (configValue && String(configValue).toLowerCase() === clickedStr.toLowerCase()) return true;
          
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
      logWarning('Maneuvers: Legend click on', legendItem, '- no matching event IDs found');
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
      logDebug('Maneuvers: Legend click on', legendItem, '- deselected all', legendEntryIds.length, 'event IDs');
    } else {
      // Not all IDs are selected → select all legend entry IDs (merge with existing)
      const updatedSelection = Array.from(new Set([...currentSelected, ...legendEntryIds]));
      setSelectedEvents(updatedSelection);
      logDebug('Maneuvers: Legend click on', legendItem, '- selected all', legendEntryIds.length, 'event IDs');
    }
    
    // Trigger update to refresh views
    setTriggerUpdate(true);
  };

  // Grade update from main maneuver page (hotkeys 0-5)
  const performGradeUpdate = async (gradeValue: number, selected: number[]): Promise<void> => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!className || !projectId) {
      logError('Cannot update GRADE: missing class_name or project_id');
      return;
    }
    const currentEventType = eventType();
    const eventTypes = currentEventType ? [currentEventType] : ['TACK', 'GYBE', 'BEARAWAY', 'ROUNDUP'];
    try {
      const response = await putData(`${apiEndpoints.admin.events}/tags`, {
        class_name: className,
        project_id: projectId,
        events: selected,
        event_types: eventTypes,
        key: 'GRADE',
        value: gradeValue
      });
      if (response.success) {
        logDebug('Maneuvers: Successfully updated GRADE to', gradeValue, 'for', selected.length, 'event(s)');
        const currentGrades = selectedGradesManeuvers();
        const gradeValueStr = String(gradeValue);
        if (!currentGrades.includes(gradeValueStr)) {
          setSelectedGradesManeuvers([...currentGrades, gradeValueStr]);
        }
        setSelectedEvents([]);
        setHasSelection(false);
        setSelection([]);
        setTriggerSelection(true);
        await fetchTableData();
      } else {
        logError('Failed to update GRADE:', response.message || 'Unknown error');
      }
    } catch (error: unknown) {
      logError('Error updating GRADE:', error);
    }
  };

  // Refetch when maneuver type changes after initial load. Initial fetch runs from onMount after project/persistent filters are applied;
  // an immediate createEffect here races onMount and causes duplicate table/map work and visible flashing.
  createEffect(
    on(
      () => (eventType() || 'TACK').trim() || 'TACK',
      (_et, prevEt) => {
        if (prevEt === undefined) return;
        void untrack(() => fetchTableData());
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

  // React to filter changes - refilter when filters change (client-side)
  createEffect(on([selectedGrades, selectedStates, selectedRaces, selectedLegs], () => {
    if (untrack(() => maneuvers().length > 0)) {
      filterData();
    }
  }));

  // React to training/racing filter - refetch so API applies TRAINING_RACING in SQL, or shows all when null (All)
  createEffect(
    on(
      () => (raceOptions().length === 0 ? null : maneuverTrainingRacing()),
      (tr) => {
        if (untrack(() => selectedDatasetId() && eventType())) {
          untrack(() => fetchTableData());
          untrack(() => filterData());
        }
      },
      { defer: true }
    )
  );

  // Sync filterStore to local state (bidirectional sync for cross-window updates)
  // This ensures that when filters change in ManeuverWindow or other windows, they sync to local state
  // Use untrack to read local state without tracking it - we only want to react to filterStore changes
  // Track a flag to prevent syncing during local updates
  let isUpdatingFromLocal = false;
  createEffect(() => {
    const filterStoreGrades = selectedGradesManeuvers();
    const filterStoreStates = selectedStatesManeuvers();
    const filterStoreRaces = selectedRacesManeuvers();
    const filterStoreLegs = selectedLegsManeuvers();
    
    // Skip if we're in the middle of a local update (to prevent loops)
    if (isUpdatingFromLocal) {
      return;
    }
    
    // Only update local state if filterStore values differ from local state
    // This prevents infinite loops and only syncs when filterStore changes from cross-window updates
    // Use untrack to read local state without creating a dependency on it
    const localGrades = untrack(() => selectedGrades());
    const localStates = untrack(() => selectedStates());
    const localRaces = untrack(() => selectedRaces());
    const localLegs = untrack(() => selectedLegs());
    
    // Convert filterStore values (strings) to local state format (numbers for grades/legs, strings for states/races)
    const filterStoreGradesNums = filterStoreGrades.map(g => Number(g)).filter(g => !isNaN(g));
    const filterStoreRacesMixed = filterStoreRaces.map(r => {
      if (r === 'TRAINING' || r === 'training') return 'TRAINING';
      const num = Number(r);
      return isNaN(num) ? r : num;
    });
    const filterStoreLegsNums = filterStoreLegs.map(l => Number(l)).filter(l => !isNaN(l));
    
    // Check if values differ (deep comparison)
    const gradesChanged = JSON.stringify([...filterStoreGradesNums].sort()) !== JSON.stringify([...localGrades].sort());
    const statesChanged = JSON.stringify([...filterStoreStates].sort()) !== JSON.stringify([...localStates].sort());
    const racesChanged = JSON.stringify([...filterStoreRacesMixed].sort()) !== JSON.stringify([...localRaces].sort());
    const legsChanged = JSON.stringify([...filterStoreLegsNums].sort()) !== JSON.stringify([...localLegs].sort());
    
    // Update local state if filterStore changed (from cross-window sync)
    // CRITICAL: Only sync if filterStore has values - NEVER clear local filters if filterStore is empty
    // This prevents clearing filters when other pages (like Probability/Scatter) haven't initialized yet
    // or when ManeuverWindow loads and temporarily has empty filterStore
    if (gradesChanged || statesChanged || racesChanged || legsChanged) {
      isUpdatingFromLocal = true;
      try {
        // Only update if filterStore has values - never sync empty filterStore to local state
        // This ensures that Probability/Scatter can maintain their own filter state even if
        // filterStore is temporarily empty (e.g., during ManeuverWindow initialization)
        if (gradesChanged && filterStoreGradesNums.length > 0) {
          setSelectedGrades(filterStoreGradesNums);
          logDebug('Maneuvers: Synced grades from filterStore to local state', filterStoreGradesNums);
        }
        if (statesChanged && filterStoreStates.length > 0) {
          setSelectedStates(filterStoreStates);
          logDebug('Maneuvers: Synced states from filterStore to local state', filterStoreStates);
        }
        if (racesChanged && filterStoreRacesMixed.length > 0) {
          setSelectedRaces(filterStoreRacesMixed);
          logDebug('Maneuvers: Synced races from filterStore to local state', filterStoreRacesMixed);
        }
        if (legsChanged && filterStoreLegsNums.length > 0) {
          setSelectedLegs(filterStoreLegsNums);
          logDebug('Maneuvers: Synced legs from filterStore to local state', filterStoreLegsNums);
        }
      } finally {
        // Reset flag after a microtask to allow reactive effects to complete
        Promise.resolve().then(() => {
          isUpdatingFromLocal = false;
        });
      }
    }
  });

  // React to view and data so layout stays correct when filtered list updates (aligned with FleetManeuvers).
  createEffect(() => {
    view();
    filtered().length;
    maneuvers().length;
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
      
      // Sync table height with map SVG height for MAP view, or with right panel for VIDEO view
      if (view() === 'MAP') {
        setTimeout(() => {
          syncTableHeightWithMap();
        }, 200); // Longer delay to ensure map SVG is fully rendered
      }
      if (view() === 'VIDEO') {
        setTimeout(() => syncTableHeightWithVideo(), 200);
      }
    }, 0);
  });

  // When VIDEO view and we have data, ensure media availability is preloaded then re-filter
  // Only run when view changes to VIDEO or when filters change the maneuvers data (same logic as FleetManeuvers)
  createEffect(on([view, maneuvers], ([currentView, data]) => {
    if (currentView !== 'VIDEO') return;
    if (!data?.length) return;
    const first = data[0];
    const raw = first?.datetime ?? first?.Datetime ?? first?.DATETIME ?? first?.date ?? first?.Date;
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return;
    (async () => {
      try {
        const d = typeof raw === 'string' ? new Date(raw.trim()) : new Date(raw);
        if (Number.isNaN(d.getTime())) return;
        const tz = untrack(() => getCurrentDatasetTimezone());
        const dateYmd = mediaAvailabilityService.getDateYmdFromDatetime(d, tz);
        await mediaAvailabilityService.preloadForDate(dateYmd, tz);
        untrack(() => filterData());
      } catch (_) {}
    })();
  }));

  createEffect(async () => {
    if (selectedEvents().length > 0) {
      // Endpoint requires dataset_id > 0 OR (source_id and date). Skip when we don't have a valid dataset.
      const datasetId = selectedDatasetId();
      if (!datasetId || datasetId <= 0) {
        logDebug('Maneuvers: Skipping times fetch (dataset_id required)');
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
        
        // Check if request was cancelled (getData returns this instead of throwing)
        if (result?.type === 'AbortError' || result?.error === 'Request cancelled') {
          // Request was cancelled - this is expected, no error needed
          return;
        }
        
        setSelection(Array.isArray(result?.data) ? result.data : [])
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          // Request was cancelled - this is expected, no error needed
        } else {
          logError('Error fetching times:', error as any);
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

  // Sync table height with layout height for VIDEO view so table and video panels match
  const syncTableHeightWithVideo = () => {
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
    
    // Sync table height with map SVG height for MAP view, or video panel for VIDEO view
    setTimeout(() => {
      if (view() === 'MAP') syncTableHeightWithMap();
      if (view() === 'VIDEO') syncTableHeightWithVideo();
    }, 100); // Small delay to ensure map/video is rendered
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

          logDebug('Maneuvers: Loaded settings from persistent settings', settings);
          let gradesLoaded = false;
          let statesLoaded = false;
          if (settings?.maneuverFilters) {
            const filters = settings.maneuverFilters;
            if (filters.grades && Array.isArray(filters.grades) && filters.grades.length > 0) {
              setSelectedGrades(filters.grades);
              setSelectedGradesManeuvers(filters.grades.map((g: number) => String(g)));
              gradesLoaded = true;
              logDebug('Maneuvers: Loaded grade filters from persistent settings', filters.grades);
            }
            if (filters.states && Array.isArray(filters.states) && filters.states.length > 0) {
              setSelectedStates(filters.states);
              setSelectedStatesManeuvers(filters.states);
              statesLoaded = true;
              logDebug('Maneuvers: Loaded state filters from persistent settings', filters.states);
            }
            if (filters.races && Array.isArray(filters.races) && filters.races.length > 0) {
              setSelectedRaces(filters.races);
              setSelectedRacesManeuvers(filters.races.map((r: number | string) => String(r)));
              logDebug('Maneuvers: Loaded race filters from persistent settings', filters.races);
            }
            if (filters.legs && Array.isArray(filters.legs) && filters.legs.length > 0) {
              setSelectedLegs(filters.legs);
              setSelectedLegsManeuvers(filters.legs.map((l: number) => String(l)));
              logDebug('Maneuvers: Loaded leg filters from persistent settings', filters.legs);
            }
            if (filters.trainingRacing === 'TRAINING' || filters.trainingRacing === 'RACING') {
              setManeuverTrainingRacing(filters.trainingRacing);
              logDebug('Maneuvers: Loaded trainingRacing filter from persistent settings', filters.trainingRacing);
            }
          } else {
            logDebug('Maneuvers: No maneuverFilters found in settings', settings);
          }
          
          // Set default grade >1 (shows grades 2 and 3) if no grades were loaded from persistent settings
          if (!gradesLoaded) {
            setSelectedGrades([1]);
            setSelectedGradesManeuvers(['1']);
            logDebug('Maneuvers: Set default grade filter to [1] (>1)');
          }
          // Set default state H0 if no states were loaded from persistent settings
          if (!statesLoaded) {
            setSelectedStates(['H0']);
            setSelectedStatesManeuvers(['H0']);
            logDebug('Maneuvers: Set default state filter to [H0]');
          }
        }
      } catch (error) {
        logDebug('Maneuvers: Error loading filters from persistent settings:', error);
        if (selectedGrades().length === 0) {
          setSelectedGrades([1]);
          setSelectedGradesManeuvers(['1']);
          logDebug('Maneuvers: Set default grade filter to [1] (>1) after error');
        }
        if (selectedStates().length === 0) {
          setSelectedStates(['H0']);
          setSelectedStatesManeuvers(['H0']);
          logDebug('Maneuvers: Set default state filter to [H0] after error');
        }
      }
    } else {
      if (selectedGrades().length === 0) {
        setSelectedGrades([1]);
        setSelectedGradesManeuvers(['1']);
        logDebug('Maneuvers: Set default grade filter to [1] (>1) (no user)');
      }
      if (selectedStates().length === 0) {
        setSelectedStates(['H0']);
        setSelectedStatesManeuvers(['H0']);
        logDebug('Maneuvers: Set default state filter to [H0] (no user)');
      }
    }
  };

  onMount(async () => {
    await logPageLoad('Maneuvers.jsx', 'Maneuvers Analysis Report');
    setEventType("TACK")
    setView("MAP")
    setTws("ALL")
    // Set TACK as default color when selectedSourceId > 0
    if (selectedSourceId() > 0) {
      setColor("TACK");
    }
    const className = selectedClassName();
    const projectId = selectedProjectId();

    // Resolve dataset date for project-object lookup
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

    // Load filters: project default first (by dataset date then 1970-01-01), then user persistent
    const projectFilters = (className && projectId) ? await getProjectManeuverFilters(className, projectId, dateForFilters ?? undefined) : null;
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
        logDebug('Maneuvers: Applied grade filters from project default', projectFilters.grades);
      }
      if (projectFilters.states !== undefined) {
        const states = Array.isArray(projectFilters.states) ? projectFilters.states : [];
        setSelectedStates(states);
        setSelectedStatesManeuvers(states);
        logDebug('Maneuvers: Applied state filters from project default', projectFilters.states);
      }
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
    
    // Keyboard shortcuts: 'x' to clear selection, 'c' to cut selection
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle shortcuts if not typing in an input/textarea
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      
      // Check if ManeuverSettings modal is visible
      const maneuverSettingsModal = document.querySelector('.pagesettings-modal');
      if (maneuverSettingsModal) {
        // Modal is visible, don't handle keyboard shortcuts
        return;
      }
      
      // 'x' key: Clear selection
      if (event.key === 'x' || event.key === 'X') {
        event.preventDefault();
        logDebug('Maneuvers: Clearing selection (x key pressed)');
        clearSelection();
        // Defer chart update to next frame for better responsiveness
        requestAnimationFrame(() => {
          setTriggerUpdate(true);
        });
        return;
      }
      
      // 'h' key: Hide selected events (move to hidden list, then clear selection)
      if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        const currentSelected = selectedEvents();
        if (currentSelected && currentSelected.length > 0) {
          logDebug('Maneuvers: Hiding selection (h key pressed)');
          hideSelectedEvents();
          requestAnimationFrame(() => {
            setTriggerUpdate(true);
          });
        }
        return;
      }

      // 'c' key: Cut selection (move selectedEvents to cutEvents)
      if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        const currentSelected = selectedEvents();
        if (currentSelected && currentSelected.length > 0) {
          logDebug('Maneuvers: Cutting selection (c key pressed)');
          cutSelection();
          // Defer chart update to next frame for better responsiveness
          requestAnimationFrame(() => {
            setTriggerUpdate(true);
          });
        }
        return;
      }

      // Grade hotkeys (0-5): set GRADE for selected events
      const selected = selectedEvents();
      if (selected && selected.length > 0 && ['0', '1', '2', '3', '4', '5'].includes(event.key)) {
        const currentUser = user();
        if (!currentUser) return;
        if (!currentUser.is_super_user) {
          const userPermissions = currentUser.permissions;
          let isReader = false;
          if (typeof userPermissions === 'string') {
            isReader = userPermissions === 'reader';
          } else if (typeof userPermissions === 'object' && userPermissions !== null) {
            const permissionValues = Object.values(userPermissions);
            isReader = permissionValues.length > 0 && permissionValues.every((p: string) => p === 'reader');
          }
          if (isReader) return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const gradeValue = parseInt(event.key, 10);
        const message = `Are you sure you want to update GRADE to ${gradeValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;
        const confirmed = window.confirm(message);
        if (!confirmed) return;
        setTimeout(() => {
          performGradeUpdate(gradeValue, selected).catch((err: unknown) => {
            logError('Error in performGradeUpdate:', err);
          });
        }, 0);
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
        {/* Controls always visible so user can change filters even when no data */}
        <div id="maneuver-controls" class="flex flex-col w-full pl-2 pt-2">
            {/* Top Control Bar: 6 buttons in specific layout */}
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
                    selectedRaces={selectedRaces()}
                    selectedLegs={selectedLegs()}
                    selectedGrades={selectedGrades()}
                    selectedStates={selectedStates()}
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
                    onApplyFilters={() => { fetchTableData(); filterData(); }}
                    includeAllGradeOption={true}
                    componentConfig={{
                      showGrades: true,
                      showRaces: true,
                      showLegs: true,
                      showStates: true
                    }}
                    hideDisplayOptions={true}
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
                <Show when={view() === 'MAP' || view() === 'TIME SERIES' || view() === 'VIDEO' || view() === 'SCATTER'}>
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
            <div class="w-full hidden" style={{ height: '88px', marginTop: '10px', marginLeft: '8px' }}>
              <ScatterTimeseries
                aggregates={aggregatesAVG()}
                color={color()}
                groups={[]}
                isHistoryPage={false}
              />
            </div>
        </div>
        {/* Content section: empty state when no data, then filter-too-strict or views */}
        <Show when={!hasManeuvers()} fallback={null}>
          <div class="flex flex-col items-center justify-center w-full min-h-[40vh] px-4 text-gray-600">
            <p class="text-lg font-medium">No maneuvers to display</p>
            <p class="text-sm mt-2 text-center max-w-md">
              Ensure this dataset has been processed and maneuver events exist. Try selecting a different maneuver type (e.g. TACK) above—this dataset may only have certain types. Adjust filters and apply to reload.
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
                  <Map context={context} onDataUpdate={fetchTableData} />
                </Show>
                <Show when={grouped()}>
                  <MapGrouped context={context} onDataUpdate={fetchTableData} />
                </Show>
              </div>
            </div>
          </Show>
          <Show when={view() === 'VIDEO'}>
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
                <DataTable_Big context={context} onDataUpdate={fetchTableData} />
              </Show>
              <Show when={grouped()}>
                <DataTable_BigGrouped context={context} onDataUpdate={fetchTableData} />
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
