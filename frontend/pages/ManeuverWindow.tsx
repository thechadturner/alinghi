import { createSignal, onMount, createEffect, Show, on, untrack, onCleanup, createMemo } from "solid-js";

import DataTable_Big from "../components/maneuvers/standard/DataTable_Big";
import Map from "../components/maneuvers/standard/Map";
import Scatter from "../components/maneuvers/standard/Scatter";
import TimeSeries from "../components/maneuvers/standard/TimeSeries";
import Video from "../components/maneuvers/standard/Video";
import DataTable_BigGrouped from "../components/maneuvers/grouped/DataTable_Big";
import MapGrouped from "../components/maneuvers/grouped/Map";
import ScatterGrouped from "../components/maneuvers/grouped/Scatter";
import TimeSeriesGrouped from "../components/maneuvers/grouped/TimeSeries";

import { groupBy, getData, getEventTimes, setupMediaContainerScaling, formatDateTime } from "../utils/global";
import { logPageLoad, logActivity, getCurrentProjectDatasetIds } from "../utils/logging";
import { error as logError, log } from "../utils/console";

import { phase, setPhase, color, setColor, tws, setTws, grade, setGrade, eventType, setEventType, grouped, maneuvers, setManeuvers, setTableData, setFiltered } from "../store/globalStore";
import { selectedEvents, setTriggerUpdate, setSelection, hasSelection, isCut, cutEvents, setSelectedGroupKeys, setTriggerSelection } from "../store/selectionStore";
import { legendTextToGroupKeyTable } from "../utils/colorGrouping";
import { TAKEOFF_CHANNELS } from "../utils/maneuversConfig";

import { persistantStore } from "../store/persistantStore";
import { sourcesStore } from "../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { selectedGradesManeuvers, selectedStatesManeuvers, selectedRacesManeuvers, selectedLegsManeuvers, setSelectedGradesManeuvers, setSelectedStatesManeuvers, setSelectedRacesManeuvers, setSelectedLegsManeuvers, raceOptions, legOptions, gradeOptions, setRaceOptions, setLegOptions, setGradeOptions } from "../store/filterStore";
import { persistentSettingsService } from "../services/persistentSettingsService";
import { user } from "../store/userStore";
import { debug as logDebug } from "../utils/console";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedDate, selectedSourceId } = persistantStore;

// Channels list for maneuvers endpoints - matches server_app/controllers/data.js lines 457-484
// Channel names must be mixed case - backend expects this format
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
  'Pitch_raise'
];

interface ManeuverWindowProps {
  view?: string;
  /** Explicit context from URL (e.g. 'fleet' for fleet-history scatter with no date). */
  context?: string;
  /** Date from URL for day/fleet single-date mode. */
  date?: string;
  eventType?: string;
  phase?: string;
  tws?: string;
  grade?: string;
  color?: string;
}

export default function ManeuverWindow(props: ManeuverWindowProps) {
  // Solo window: render a single view full screen, configured via props or query params
  // Props: view (required), eventType, phase, tws, grade, color (optional)
  
  // Determine context from URL/props first (fleet-history scatter: context=fleet, no date), then store
  // Historical: source_id > 0 and no dataset_id (from ManeuversHistory)
  // Dataset: dataset_id > 0
  // Fleet: no dataset, multiple sources (FleetManeuversHistory or day view)
  const context = createMemo(() => {
    const datasetId = selectedDatasetId();
    const sourceId = selectedSourceId();
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const explicitContext = params.get('context') || props.context;

    // URL/props context=fleet (e.g. fleet-history scatter with no date) → use fleet so best-fleet-maneuvers is used
    if (explicitContext === 'fleet' && (!datasetId || datasetId <= 0)) {
      return 'fleet';
    }

    // Dataset context: when dataset_id > 0
    if (datasetId && datasetId > 0) {
      return 'dataset';
    }

    // Historical context: when source_id > 0 and no valid dataset_id (ManeuversHistory page)
    if (sourceId && sourceId > 0 && (!datasetId || datasetId <= 0)) {
      if (explicitContext && explicitContext !== 'historical') {
        return explicitContext;
      }
      return 'historical';
    }
    
    // Fleet context: requires date and sources (date-based, multiple sources)
    // Default to fleet for all other cases
    return 'fleet';
  });

  // setEventType('TACK');
  // setPhase('FULL');
  // setTws('ALL');
  // setGrade('ALL');
  // setColor('TACK');
  const [view, setView] = createSignal(props.view || 'MAP');
  
  // Local state for state options (extracted from data)
  const [stateOptions, setStateOptions] = createSignal<string[]>([]);

  // React to prop changes
  createEffect(() => {
    if (props.view) {
      setView(props.view.toUpperCase());
    }
  });

  // Abort controllers for canceling requests
  let tableDataController: AbortController | null = null;
  let timesController: AbortController | null = null;
  let isInitialMount = true;
  let messageHandler: ((event: MessageEvent) => void) | null = null;

  const fetchTableData = async () => {
    if (tableDataController) {
      tableDataController.abort();
    }

    tableDataController = new AbortController();

    try {
      const currentContext = context();
      let data: any[] = [];

      if (currentContext === 'historical') {
        // Historical context: use best-maneuvers endpoint
        const sourceId = selectedSourceId();
        if (!sourceId || sourceId <= 0) {
          logError('ManeuverWindow: No source_id for historical maneuvers');
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          return;
        }

        // Get source name from sourcesStore
        const sources = sourcesStore.sources();
        const source = sources.find((s: any) => s.source_id === sourceId);
        if (!source || !source.source_name) {
          logError('ManeuverWindow: Source not found for historical maneuvers');
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          return;
        }

        // Build filters object if needed - use uppercase keys and array values
        const filters: Record<string, number[]> = {};
        const grades = selectedGradesManeuvers();
        if (grades.length > 0) {
          // Convert string grades to numbers for API
          filters.GRADE = grades.map(g => Number(g)).filter(n => !isNaN(n));
        }

        // Get date range - use wide range for best-maneuvers
        const startDate = '2020-01-01';
        const endDate = '2099-12-31';

        // Build URL with channels and optional filters - use new simplified endpoint
        const channels = (eventType() || '').toUpperCase() === 'TAKEOFF' ? TAKEOFF_CHANNELS : MANEUVERS_CHANNELS;
        let url = `${apiEndpoints.app.data}/maneuvers-history?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_names=${encodeURIComponent(JSON.stringify([source.source_name]))}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=${encodeURIComponent(eventType())}&channels=${encodeURIComponent(JSON.stringify(channels))}`;
        if (Object.keys(filters).length > 0) {
          url += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
        }

        const result_json = await getData(url, tableDataController.signal);

        if (result_json.success && result_json.data && Array.isArray(result_json.data)) {
          data = result_json.data;
        } else {
          logError('ManeuverWindow: Failed to fetch historical maneuvers:', result_json.message || 'Unknown error');
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          return;
        }
      } else if (currentContext === 'fleet') {
        // Fleet context: fetch from all sources
        // If date is available, use fleet-maneuvers-table-data (date-specific)
        // If no date, use best-fleet-maneuvers (wide date range, like FleetManeuversHistory)
        const date = selectedDate();
        const sources = sourcesStore.sources();
        
        if (!sources || sources.length === 0) {
          logError('ManeuverWindow: No sources available for fleet maneuvers');
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          return;
        }

        if (date) {
          // Build filters so user's grade choice (e.g. > 0) overrides backend default (grade > 1)
          const filters: Record<string, number[]> = {};
          const grades = selectedGradesManeuvers();
          if (grades.length > 0) {
            filters.GRADE = grades.map(g => Number(g)).filter(n => !isNaN(n));
          }
          const channels = (eventType() || '').toUpperCase() === 'TAKEOFF' ? TAKEOFF_CHANNELS : MANEUVERS_CHANNELS;
          let baseUrl = `${apiEndpoints.app.data}/maneuvers?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(date)}&event_type=${encodeURIComponent(eventType())}&channels=${encodeURIComponent(JSON.stringify(channels))}`;
          if (Object.keys(filters).length > 0) {
            baseUrl += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
          }
          // Date-specific: fetch from each source in parallel
          const fetchPromises = sources.map(async (source) => {
            try {
              const url = `${baseUrl}&source_names=${encodeURIComponent(JSON.stringify([source.source_name]))}`;
              const result = await getData(url, tableDataController?.signal);
              
              if (result.success && result.data && Array.isArray(result.data)) {
                // Add source_name to each item
                return result.data.map(item => ({
                  ...item,
                  source_name: source.source_name
                }));
              }
              return [];
            } catch (error: any) {
              if (error.name === 'AbortError') {
                return [];
              }
              logError(`ManeuverWindow: Error fetching data for source ${source.source_name}:`, error);
              return [];
            }
          });

          const results = await Promise.all(fetchPromises);
          results.forEach(sourceData => {
            data.push(...sourceData);
          });
        } else {
          // No date: use maneuvers-history (same as FleetManeuversHistory) with source_names so data is returned
          const startDate = '2020-01-01';
          const endDate = '2099-12-31';
          const sourceNames = sources.map((s: { source_name: string }) => s.source_name);
          if (sourceNames.length === 0) {
            logError('ManeuverWindow: No source names for fleet maneuvers (sources empty)');
            setManeuvers([]);
            setTableData([]);
            setFiltered([]);
            return;
          }

          const filters: Record<string, number[] | string[]> = {};
          const grades = selectedGradesManeuvers();
          if (grades.length > 0) {
            filters.GRADE = grades.map(g => Number(g)).filter(n => !isNaN(n)) as number[];
          }

          const channels = (eventType() || '').toUpperCase() === 'TAKEOFF' ? TAKEOFF_CHANNELS : MANEUVERS_CHANNELS;
          let url = `${apiEndpoints.app.data}/maneuvers-history?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_names=${encodeURIComponent(JSON.stringify(sourceNames))}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=${encodeURIComponent(eventType())}&count=10&channels=${encodeURIComponent(JSON.stringify(channels))}`;
          if (Object.keys(filters).length > 0) {
            url += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
          }

          const result_json = await getData(url, tableDataController.signal);

          if (result_json.success && result_json.data && Array.isArray(result_json.data)) {
            data = result_json.data;
            logDebug('ManeuverWindow: Fleet (no date) maneuvers-history returned', data.length, 'rows');
          } else {
            logError('ManeuverWindow: Failed to fetch fleet maneuvers (maneuvers-history):', result_json.message || 'Unknown error');
            setManeuvers([]);
            setTableData([]);
            setFiltered([]);
            return;
          }
        }
      } else {
        // Dataset context: fetch from single dataset
        const datasetId = selectedDatasetId();
        if (!datasetId || datasetId <= 0) {
          logError('ManeuverWindow: Invalid dataset_id for dataset context');
          setManeuvers([]);
          setTableData([]);
          setFiltered([]);
          return;
        }

        const channels = (eventType() || '').toUpperCase() === 'TAKEOFF' ? TAKEOFF_CHANNELS : MANEUVERS_CHANNELS;
        const url = `${apiEndpoints.app.data}/maneuvers-table-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}&event_type=${encodeURIComponent(eventType())}&channels=${encodeURIComponent(JSON.stringify(channels))}`;
        const result_json = await getData(url, tableDataController.signal);

        if (result_json.success && result_json.data && Array.isArray(result_json.data)) {
          data = result_json.data;
        }
      }

      if (data.length > 0) {
        // Process tack values
        if (phase() == 'FULL' || phase() == 'TURN') {
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

        // Generate TWS bins in intervals of 5
        const twsValues: number[] = [];
        data.forEach((item: any) => {
          const twsBin = item.tws_bin ?? item.tws_avg;
          if (twsBin !== null && twsBin !== undefined && !isNaN(Number(twsBin))) {
            twsValues.push(Number(twsBin));
          }
        });
        
        const _twsBins: string[] = ['ALL'];
        if (twsValues.length > 0) {
          const minTws = Math.min(...twsValues);
          const maxTws = Math.max(...twsValues);
          
          // Round down to nearest multiple of 5 for start
          const startBin = Math.floor(minTws / 5) * 5;
          // Round up to nearest multiple of 5 for end, then add one more increment
          const endBin = Math.ceil(maxTws / 5) * 5 + 5;
          
          // Generate bins in increments of 5
          for (let bin = startBin; bin <= endBin; bin += 5) {
            _twsBins.push(String(bin));
          }
        }

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

        // Add datetimeLocal (local time) for table display so datetimes persist after filter updates
        data.forEach((item: any) => {
          const tz = (item.timezone ?? item.Timezone ?? "").trim() || undefined;
          const rawDt = item.Datetime ?? item.datetime ?? item.DATETIME;
          if (rawDt && tz) {
            try {
              const formatted = formatDateTime(rawDt, tz);
              if (formatted) item.datetimeLocal = formatted;
            } catch {
              // leave datetimeLocal undefined
            }
          } else if (rawDt) {
            try {
              const formatted = formatDateTime(rawDt);
              if (formatted) item.datetimeLocal = formatted;
            } catch {
              // leave datetimeLocal undefined
            }
          }
        });

        setManeuvers(data);
        setTableData(data);

        // Don't set filtered/selection here - let applyFilters() do it
        // This avoids triggering updates before filters are applied
        applyFilters();
      } else {
        // Handle empty data
        setManeuvers([]);
        setTableData([]);
        setFiltered([]);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError('ManeuverWindow: Error fetching table data:', error);
      }
      setManeuvers([]);
      setTableData([]);
      setFiltered([]);
    } finally {
      tableDataController = null;
    }
  };

  const applyFilters = () => {
    let filteredByTws = [];
    if (tws() == 'ALL') {
      filteredByTws = maneuvers();
    } else {
      filteredByTws = maneuvers().filter(item => item.tws_bin == tws());
    }

    // Apply grade filter using selectedGrades array - use "greater than" logic
    // Use lowercase field names as primary with fallbacks for backward compatibility
    let filteredData = filteredByTws;
    const grades = selectedGradesManeuvers();
    if (grades.length > 0) {
      // For radio button behavior, only the first selected grade is used
      // Filter for grades greater than the selected grade
      const gradeNumbers = grades.map(g => Number(g)).filter(n => !isNaN(n));
      const minGrade = Math.min(...gradeNumbers);
      filteredData = filteredByTws.filter((item: any) => {
        const itemGrade = item.grade ?? item.Grade ?? item.GRADE;
        if (itemGrade == null || itemGrade === undefined) return false;
        const numGrade = Number(itemGrade);
        if (isNaN(numGrade)) return false;
        return numGrade > minGrade;
      });
    }
    const dataAfterGrade = filteredData;

    // Apply state filter using selectedStates array
    // Use lowercase field names as primary with fallbacks for backward compatibility
    const states = selectedStatesManeuvers();
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
    const races = selectedRacesManeuvers();
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
    const legs = selectedLegsManeuvers();
    if (legs.length > 0) {
      filteredData = filteredData.filter((item: any) => {
        const legValue = item.leg_number ?? item.Leg_number ?? item.LEG;
        if (legValue == null || legValue === undefined) return false;
        const legStr = String(legValue);
        return legs.includes(legStr);
      });
    }

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
        // If no valid event IDs found, don't filter (show all data)
        // This handles edge cases where cutEvents might be in an unexpected format
        log('🪟 ManeuverWindow: No valid event IDs found in cutEvents, showing all data', currentCutEvents);
      }
    }

    // Fallback: if state/race/leg filters (e.g. from another context) would empty the table but we have data after grade, show data after grade so the table is not empty
    if (filteredData.length === 0 && dataAfterGrade.length > 0 && !(isCut() && cutEvents().length > 0)) {
      log('🪟 ManeuverWindow: Filters would empty table; showing data without state/race/leg filters');
      filteredData = dataAfterGrade;
    }

    const eventIds = filteredData.map(item => item.event_id);
    setFiltered(eventIds);
    setTableData(filteredData);

    if (!hasSelection()) {
      setSelection(eventIds);
    }

    setTriggerUpdate(true);
  };

  const applyQueryParams = () => {
    // Use props first, then fall back to query params
    const params = new URLSearchParams(window.location.search);
    const v = props.view || params.get('view'); // MAP | SCATTER | TIME SERIES | TABLE | VIDEO
    const evt = props.eventType || params.get('eventType');
    const ph = props.phase || params.get('phase');
    const tw = props.tws || params.get('tws');
    const gr = props.grade || params.get('grade');
    const col = props.color || params.get('color');

    if (v) setView(v.toUpperCase());
    if (evt) setEventType(evt.toUpperCase());
    if (ph) setPhase(ph.toUpperCase());
    if (tw) setTws(tw);
    if (gr) setGrade(gr);
    if (col) setColor(col.toUpperCase());
  };

  const handleLegendClick = (legendItem: string) => {
    if (grouped()) {
      const key = legendTextToGroupKeyTable(legendItem, color() || 'TWS');
      setSelectedGroupKeys((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      );
      setTriggerSelection(true);
    }
  };

  // React to eventType changes (but not during initial mount)
  createEffect(async () => {
    if (eventType() && !isInitialMount) {
      await fetchTableData();
    }
  });

  // React to phase changes - refetch data when phase changes (but not during initial mount)
  createEffect(async () => {
    if (phase() && !isInitialMount && untrack(() => maneuvers().length > 0)) {
      await fetchTableData();
    }
  });

  // React to color changes - trigger map update when color changes (but not during initial mount)
  createEffect(async () => {
    const currentColor = color();
    if (currentColor && !isInitialMount) {
      log('🪟 ManeuverWindow: Color changed to:', currentColor);
      const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
      await logActivity(project_id, dataset_id, 'ManeuverWindow.tsx', 'Maneuver Window', `Color changed to ${currentColor}`);
      setTriggerUpdate(true);
    }
  });
  
  // Also watch for color changes from cross-window sync (even during initial mount after sync completes)
  // This ensures color updates from the main window are always processed
  createEffect(() => {
    // Access color() to ensure reactivity
    const currentColor = color();
    // This effect will fire whenever color changes, including from cross-window sync
    // The child components (Map, Scatter, TimeSeries) have their own effects that watch color()
    // so they should update automatically when this signal changes
    if (currentColor) {
      log('🪟 ManeuverWindow: Color signal changed (reactive effect):', currentColor);
    }
  });

  // React to cut events - refilter when cut state or cutEvents change (but not during initial mount)
  // Debounce so rapid cross-window selection syncs (e.g. multiple postMessages) only trigger one applyFilters/updateTimeSeries
  createEffect(() => {
    isCut();
    cutEvents();
    if (!isInitialMount && untrack(() => maneuvers().length > 0)) {
      const t = setTimeout(() => {
        applyFilters();
      }, 80);
      return () => clearTimeout(t);
    }
  });

  // React to filter changes - refetch data when grades change (for API-based filtering in historical/fleet contexts)
  // Grades are sent to the API in historical and fleet (no date) contexts
  createEffect(async () => {
    selectedGradesManeuvers();
    if (!isInitialMount && maneuvers().length > 0) {
      const currentContext = context();
      // Only refetch for historical or fleet (no date) contexts where grades are sent to API
      if (currentContext === 'historical' || (currentContext === 'fleet' && !selectedDate())) {
        await fetchTableData();
      } else {
        // For dataset context or fleet with date, grades are client-side only, just apply filters
        applyFilters();
      }
    }
  });

  // React to TWS changes - apply filters so scatter/table/map in maneuver window show the selected TWS bin
  createEffect(on(tws, () => {
    if (!isInitialMount && untrack(() => maneuvers().length > 0)) {
      applyFilters();
    }
  }));

  // React to state, race, and leg filter changes - apply filters client-side (but not during initial mount)
  createEffect(on([selectedStatesManeuvers, selectedRacesManeuvers, selectedLegsManeuvers], () => {
    if (!isInitialMount && untrack(() => maneuvers().length > 0)) {
      applyFilters();
    }
  }));

  // Filter toggle handlers
  const toggleRaceFilter = (race: number | string) => {
    const current = selectedRacesManeuvers();
    const raceStr = String(race);
    const next = current.includes(raceStr) 
      ? current.filter(r => r !== raceStr)
      : [...current, raceStr];
    setSelectedRacesManeuvers(next);
  };

  const toggleLegFilter = (leg: number) => {
    const current = selectedLegsManeuvers();
    const legStr = String(leg);
    const next = current.includes(legStr)
      ? current.filter(l => l !== legStr)
      : [...current, legStr];
    setSelectedLegsManeuvers(next);
  };

  const toggleGradeFilter = (grade: number) => {
    const current = selectedGradesManeuvers();
    const gradeStr = String(grade);
    const next = current.includes(gradeStr)
      ? current.filter(g => g !== gradeStr)
      : [...current, gradeStr];
    setSelectedGradesManeuvers(next);
  };

  const toggleStateFilter = (state: string) => {
    const current = selectedStatesManeuvers();
    const next = current.includes(state)
      ? current.filter(s => s !== state)
      : [...current, state];
    setSelectedStatesManeuvers(next);
  };

  // Fetch times when selection changes
  createEffect(async () => {
    if (selectedEvents().length > 0) {
      if (timesController) {
        timesController.abort();
      }
      timesController = new AbortController();

      try {
        const currentContext = context();
        let url;

        let result;
        if (currentContext === 'historical') {
          // Historical context: use source_id and dataset_id (from selection)
          const sourceId = selectedSourceId();
          const datasetId = selectedDatasetId();
          
          if (sourceId && sourceId > 0 && datasetId && datasetId > 0) {
            result = await getEventTimes({
              class_name: selectedClassName(),
              project_id: selectedProjectId(),
              dataset_id: datasetId,
              event_list: selectedEvents()
            }, timesController.signal);
          } else {
            return; // Can't fetch times without source_id and dataset_id
          }
        } else if (currentContext === 'fleet') {
          // Fleet context: use source_id and date (only if date is available)
          // Note: times endpoint requires a date, so we can't fetch times without one
          const date = selectedDate();
          const sources = sourcesStore.sources();
          
          if (date && sources && sources.length > 0) {
            // Use the first source's ID (or aggregate across all sources)
            const sourceId = sources[0].source_id;
            result = await getEventTimes({
              class_name: selectedClassName(),
              project_id: selectedProjectId(),
              source_id: sourceId,
              date: date,
              event_list: selectedEvents()
            }, timesController.signal);
          } else {
            return; // Can't fetch times without date/sources
          }
        } else {
          // Dataset context: use dataset_id
          const datasetId = selectedDatasetId();
          if (!datasetId || datasetId <= 0) {
            return; // Can't fetch times without valid dataset_id
          }
          result = await getEventTimes({
            class_name: selectedClassName(),
            project_id: selectedProjectId(),
            dataset_id: datasetId,
            event_list: selectedEvents()
          }, timesController.signal);
        }

        if (result) {
          setSelection(result.data);
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          logError('ManeuverWindow: Error fetching times:', error);
        }
      } finally {
        timesController = null;
      }
    }
  });

  // Load filters from persistent settings (fallback if not synced from parent)
  const loadFiltersFromPersistentSettings = async () => {
    const currentUser = user();
    if (currentUser?.user_id) {
      try {
        const className = selectedClassName();
        const projectId = selectedProjectId();

        if (className && projectId) {
          const settings = await persistentSettingsService.loadSettings(
            currentUser.user_id,
            className,
            projectId
          );

          logDebug('🪟 ManeuverWindow: Loaded settings from persistent settings', settings);
          let gradesLoaded = false;
          let statesLoaded = false;
          if (settings?.maneuverFilters) {
            const filters = settings.maneuverFilters;
            // Only set filters if they're not already set (to avoid overriding synced filters)
            if (filters.grades && Array.isArray(filters.grades) && filters.grades.length > 0 && selectedGradesManeuvers().length === 0) {
              setSelectedGradesManeuvers(filters.grades.map((g: number) => String(g)));
              gradesLoaded = true;
              logDebug('🪟 ManeuverWindow: Loaded grade filters from persistent settings', filters.grades);
            }
            if (filters.states && Array.isArray(filters.states) && filters.states.length > 0 && selectedStatesManeuvers().length === 0) {
              setSelectedStatesManeuvers(filters.states);
              statesLoaded = true;
              logDebug('🪟 ManeuverWindow: Loaded state filters from persistent settings', filters.states);
            }
            if (filters.races && Array.isArray(filters.races) && filters.races.length > 0 && selectedRacesManeuvers().length === 0) {
              setSelectedRacesManeuvers(filters.races.map((r: number | string) => String(r)));
              logDebug('🪟 ManeuverWindow: Loaded race filters from persistent settings', filters.races);
            }
            if (filters.legs && Array.isArray(filters.legs) && filters.legs.length > 0 && selectedLegsManeuvers().length === 0) {
              setSelectedLegsManeuvers(filters.legs.map((l: number) => String(l)));
              logDebug('🪟 ManeuverWindow: Loaded leg filters from persistent settings', filters.legs);
            }
          } else {
            logDebug('🪟 ManeuverWindow: No maneuverFilters found in settings', settings);
          }
          
          // Set default grade >1 (shows grades 2 and 3) if no grades were loaded from persistent settings or synced
          if (!gradesLoaded && selectedGradesManeuvers().length === 0) {
            setSelectedGradesManeuvers(['1']);
            logDebug('🪟 ManeuverWindow: Set default grade filter to [1] (>1)');
          }
          // Set default state H0 if no states were loaded from persistent settings or synced
          if (!statesLoaded && selectedStatesManeuvers().length === 0) {
            setSelectedStatesManeuvers(['H0']);
            logDebug('🪟 ManeuverWindow: Set default state filter to [H0]');
          }
        }
      } catch (error) {
        logDebug('🪟 ManeuverWindow: Error loading filters from persistent settings:', error);
        // Set default grade and state even if there was an error loading settings
        if (selectedGradesManeuvers().length === 0) {
          setSelectedGradesManeuvers(['1']);
          logDebug('🪟 ManeuverWindow: Set default grade filter to [1] (>1) after error');
        }
        if (selectedStatesManeuvers().length === 0) {
          setSelectedStatesManeuvers(['H0']);
          logDebug('🪟 ManeuverWindow: Set default state filter to [H0] after error');
        }
      }
    } else {
      // No user logged in - set default grade and state
      if (selectedGradesManeuvers().length === 0) {
        setSelectedGradesManeuvers(['1']);
        logDebug('🪟 ManeuverWindow: Set default grade filter to [1] (>1) (no user)');
      }
      if (selectedStatesManeuvers().length === 0) {
        setSelectedStatesManeuvers(['H0']);
        logDebug('🪟 ManeuverWindow: Set default state filter to [H0] (no user)');
      }
    }
  };

  onMount(() => {
    // Set window name early, before any message handlers or communication
    if (!window.name) {
      window.name = `maneuver-window-${Date.now()}`;
    }
    
    // Function to register with parent window
    const registerWithParent = (openerWindow: Window) => {
      if (!openerWindow || openerWindow.closed) {
        return false;
      }
      
      // Ensure window name is set
      if (!window.name) {
        window.name = `maneuver-window-${Date.now()}`;
      }
      
      log('🪟 ManeuverWindow: Registering with parent window', window.name);
      try {
        openerWindow.postMessage({
          type: 'WINDOW_READY',
          windowName: window.name
        }, window.location.origin);
        log('🪟 ManeuverWindow: WINDOW_READY message sent successfully');
        return true;
      } catch (error) {
        logError('🪟 ManeuverWindow: Error sending WINDOW_READY message', error);
        return false;
      }
    };
    
    // Function to request state from parent
    const requestStateFromParent = (openerWindow: Window) => {
      if (!openerWindow || openerWindow.closed) return;
      
      log('🪟 ManeuverWindow: Requesting current state from parent');
      try {
        openerWindow.postMessage({
          type: 'REQUEST_GLOBAL_STATE',
          windowName: window.name
        }, window.location.origin);
        
        openerWindow.postMessage({
          type: 'REQUEST_SELECTION_STATE',
          windowName: window.name
        }, window.location.origin);
        
        openerWindow.postMessage({
          type: 'REQUEST_FILTER_STATE',
          windowName: window.name
        }, window.location.origin);
      } catch (error) {
        logError('🪟 ManeuverWindow: Error requesting state from parent', error);
      }
    };
    
    // Check if this is a popup window or same-window
    const isPopupWindow = window.opener && !window.opener.closed;
    let focusHandlerToRemove: (() => void) | null = null;
    log('🪟 ManeuverWindow: onMount', {
      isPopupWindow,
      hasOpener: !!window.opener,
      openerClosed: window.opener ? window.opener.closed : 'N/A',
      windowName: window.name,
      windowLocation: window.location.href
    });
    
    // Register this window with parent if opened as a child window
    // This allows the Sidebar to track it and broadcast updates to it
    if (isPopupWindow) {
      registerWithParent(window.opener!);
    } else {
      log('🪟 ManeuverWindow: Opened in same window (not popup) - will receive updates via CustomEvents');
      
      // When a tab is moved to its own window, window.opener is NOT set automatically
      // So we need to try to find the parent window by attempting to communicate
      // We'll use a BroadcastChannel or try to find windows that can receive our messages
      
      // Try to find parent window by broadcasting a discovery message
      // This works if there are other windows open from the same origin
      const tryFindParentWindow = () => {
        log('🪟 ManeuverWindow: Attempting to find parent window (window may have been moved)');
        
        // Try using BroadcastChannel to communicate with other windows
        try {
          const channel = new BroadcastChannel('maneuver-window-discovery');
          
          // Listen for parent window announcements
          channel.onmessage = (event) => {
            if (event.data.type === 'PARENT_WINDOW_ANNOUNCEMENT') {
              log('🪟 ManeuverWindow: Found parent window via BroadcastChannel', event.data);
              // Note: BroadcastChannel doesn't give us a Window reference, so we can't use postMessage
              // But we can use it to coordinate
            }
          };
          
          // Announce ourselves and ask for parent
          channel.postMessage({
            type: 'CHILD_WINDOW_LOOKING_FOR_PARENT',
            windowName: window.name || `maneuver-window-${Date.now()}`,
            timestamp: Date.now()
          });
          
          // Cleanup after a delay
          setTimeout(() => {
            channel.close();
          }, 5000);
        } catch (error) {
          log('🪟 ManeuverWindow: BroadcastChannel not available, using fallback method');
        }
        
        // Fallback: Check if we can access localStorage to coordinate
        // When window is moved, we lose direct window.opener reference
        // But we can still use postMessage if we can get a reference to other windows
        // Unfortunately, there's no reliable way to get a reference to the "parent" window
        // when a tab is moved to a new window
        
        // For now, we'll rely on the user manually refreshing or the window being opened via window.open()
        log('🪟 ManeuverWindow: Note - If this window was moved from a tab, it may not automatically sync with the main window. Consider opening it via the menu option instead.');
      };
      
      // Try to find parent after a short delay (in case window is being moved)
      setTimeout(tryFindParentWindow, 2000);
      
      // Also try on focus (window might have been moved while unfocused)
      const handleFocus = () => {
        // Check if opener appeared (unlikely for moved tabs, but check anyway)
        if (window.opener && !window.opener.closed) {
          log('🪟 ManeuverWindow: Detected opener on focus, registering');
          registerWithParent(window.opener);
          requestStateFromParent(window.opener);
        }
      };
      focusHandlerToRemove = handleFocus;
      window.addEventListener('focus', handleFocus);
    }
    
    // Setup cross-window communication to receive updates from parent window
    messageHandler = (event: MessageEvent) => {
      // Verify origin for security
      if (event.origin !== window.location.origin) {
        return;
      }
      
      const messageType = event.data?.type;
      
      if (messageType === 'GLOBAL_STORE_UPDATE') {
        // Handle global store updates (eventType, phase, color)
        const payload = event.data.payload || {};
        
        // Preserve cross-window sync markers when dispatching CustomEvent
        // This allows globalStore to distinguish cross-window updates from local events
        window.dispatchEvent(new CustomEvent('globalStoreUpdate', {
          detail: payload
        }));
      } else if (messageType === 'SELECTION_STORE_UPDATE') {
        // Handle selection store updates (selectedEvents, selection, etc.)
        const payload = event.data.payload || {};
        
        // Process even if document is hidden (for background windows)
        // The components will update when the window becomes visible
        window.dispatchEvent(new CustomEvent('selectionStoreUpdate', {
          detail: payload
        }));
      } else if (messageType === 'FILTER_STORE_UPDATE') {
        // Handle filter store updates (selectedStates, selectedRaces, etc.)
        const payload = event.data.payload || {};
        
        // Process even if document is hidden (for background windows)
        window.dispatchEvent(new CustomEvent('filterStoreUpdate', {
          detail: payload
        }));
      }
    };
    
    window.addEventListener('message', messageHandler);
    
    // Also listen for globalStoreUpdate CustomEvents when opened in the same window
    // This handles the case when ManeuverWindow is opened directly in the main window
    // (not as a separate window via openComponentInNewWindow)
    const handleGlobalStoreUpdate = (event: CustomEvent) => {
      const payload = event.detail;
      if (!payload) return;
      
      log('🪟 ManeuverWindow: Received globalStoreUpdate CustomEvent (same window)', {
        color: payload.color,
        phase: payload.phase,
        eventType: payload.eventType,
        payload
      });
      
      // The globalStore should already be listening to this event and updating signals
      // But we log it here for debugging and ensure the event is processed
      // The globalStore's handleCrossWindowUpdate will update the signals
    };
    
    window.addEventListener('globalStoreUpdate', handleGlobalStoreUpdate as EventListener);
    log('🪟 ManeuverWindow: Added globalStoreUpdate CustomEvent listener (same window mode)');
    
    // Also listen via BroadcastChannel for windows that don't have opener (moved tabs)
    // This allows windows that were moved from tabs to still receive updates
    let broadcastChannel: BroadcastChannel | null = null;
    try {
      broadcastChannel = new BroadcastChannel('global-store-updates');
      broadcastChannel.onmessage = (event) => {
        if (event.data.type === 'GLOBAL_STORE_UPDATE' && event.data.sourceWindow !== window.name) {
          // Ignore our own messages
          const payload = event.data.payload || {};
          log('🪟 ManeuverWindow: Received globalStoreUpdate via BroadcastChannel', {
            color: payload.color,
            sourceWindow: event.data.sourceWindow,
            isCrossWindowSync: payload._crossWindowSync,
            timestamp: payload._timestamp
          });
          
          // Dispatch as CustomEvent so globalStore can process it
          // Preserve cross-window sync markers
          window.dispatchEvent(new CustomEvent('globalStoreUpdate', {
            detail: payload
          }));
        }
      };
      log('🪟 ManeuverWindow: Added BroadcastChannel listener for moved windows');
    } catch (err) {
      log('🪟 ManeuverWindow: BroadcastChannel not available', err);
    }
    
    // Register all cleanups synchronously (must run before any await so Solid can associate with component)
    onCleanup(() => {
      window.removeEventListener('message', messageHandler!);
      messageHandler = null;
      window.removeEventListener('globalStoreUpdate', handleGlobalStoreUpdate as EventListener);
      if (broadcastChannel) {
        broadcastChannel.close();
        broadcastChannel = null;
      }
      if (focusHandlerToRemove) {
        window.removeEventListener('focus', focusHandlerToRemove);
      }
    });
    
    // Run async init in a fire-and-forget IIFE so we never call onCleanup after await (Solid requires cleanups to be registered in sync reactive context)
    (async () => {
      await logPageLoad('ManeuverWindow.jsx', 'Maneuvers Solo Window');
    
    // Track which values were synced from parent (to avoid overriding them)
    let colorSyncedFromParent = false;
    let eventTypeSyncedFromParent = false;
    let phaseSyncedFromParent = false;
    let globalStateRequested = false;
    
    // Request current state from parent window if opened from another window
    // This ensures we get the correct color, phase, eventType, selections, and filters from the main window
    if (window.opener && !window.opener.closed) {
      log('🪟 ManeuverWindow: Requesting current state from parent');
      
      // Store current values before sync to detect if they changed
      const colorBeforeSync = color();
      const eventTypeBeforeSync = eventType();
      const phaseBeforeSync = phase();
      globalStateRequested = true;
      
      // Request global store state (color, phase, eventType)
      window.opener.postMessage({
        type: 'REQUEST_GLOBAL_STATE',
        windowName: window.name
      }, window.location.origin);
      
      // Request selection store state (selectedEvents, selection, etc.)
      window.opener.postMessage({
        type: 'REQUEST_SELECTION_STATE',
        windowName: window.name
      }, window.location.origin);
      
      // Request filter store state (selectedStates, selectedRaces, etc.)
      window.opener.postMessage({
        type: 'REQUEST_FILTER_STATE',
        windowName: window.name
      }, window.location.origin);
      
      // Wait longer for filter sync to complete (filters are critical for data fetching)
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check if values were synced from parent (even if they match defaults, if we requested state, they were synced)
      const colorAfterSync = color();
      const eventTypeAfterSync = eventType();
      const phaseAfterSync = phase();
      
      // If we requested state and values exist, consider them synced (even if they match defaults)
      // This handles the case where parent has the same default values
      if (colorAfterSync) {
        if (colorAfterSync !== colorBeforeSync) {
          colorSyncedFromParent = true;
        } else if (globalStateRequested && colorBeforeSync) {
          // Value didn't change but we requested sync - parent likely has same value
          // Still mark as synced to prevent override
          colorSyncedFromParent = true;
        }
      }
      
      if (eventTypeAfterSync) {
        if (eventTypeAfterSync !== eventTypeBeforeSync) {
          eventTypeSyncedFromParent = true;
        } else if (globalStateRequested && eventTypeBeforeSync) {
          eventTypeSyncedFromParent = true;
        }
      }
      
      if (phaseAfterSync) {
        if (phaseAfterSync !== phaseBeforeSync) {
          phaseSyncedFromParent = true;
        } else if (globalStateRequested && phaseBeforeSync) {
          phaseSyncedFromParent = true;
        }
      }
    }
    
    // Apply query params/props, but don't override synced values
    const params = new URLSearchParams(window.location.search);
    const v = props.view || params.get('view');
    const evt = props.eventType || params.get('eventType');
    const ph = props.phase || params.get('phase');
    const tw = props.tws || params.get('tws');
    const gr = props.grade || params.get('grade');
    const col = props.color || params.get('color');
    
    if (v) setView(v.toUpperCase());
    // Only apply eventType from query params if it wasn't synced from parent
    if (evt && !eventTypeSyncedFromParent) {
      setEventType(evt.toUpperCase());
    }
    // Only apply phase from query params if it wasn't synced from parent
    if (ph && !phaseSyncedFromParent) {
      setPhase(ph.toUpperCase());
    }
    if (tw) setTws(tw);
    if (gr) setGrade(gr);
    // Only apply color from query params if it wasn't synced from parent
    if (col && !colorSyncedFromParent) {
      setColor(col.toUpperCase());
    }
    
    // Ensure eventType is set (fallback if not in params/props and not synced)
    if (!eventType() && !eventTypeSyncedFromParent) {
      setEventType("TACK");
    }
    
    // Ensure other defaults are set if not provided and not synced
    if (!phase() && !phaseSyncedFromParent) {
      setPhase("FULL");
    }
    if (!tws()) setTws("ALL");
    if (!grade()) setGrade("ALL");
    
    // Get current context for use below
    const currentContext = context();
    
    // Set color based on context - ONLY if color wasn't synced from parent
    // This ensures fleet context uses SOURCE even if color was set to default 'TACK' before sync
    if (!colorSyncedFromParent) {
      const currentColor = color();
      
      if (!currentColor) {
        // No color set at all - set based on context
        if (currentContext === 'fleet') {
          setColor("SOURCE");
        } else if (currentContext === 'historical') {
          // For historical context, default to TACK (matching ManeuversHistory behavior)
          const sourceId = selectedSourceId();
          if (sourceId && sourceId > 0) {
            setColor("TACK");
          } else {
            setColor("TWS");
          }
        } else {
          setColor("TWS");
        }
      } else if (currentContext === 'fleet' && currentColor !== 'SOURCE') {
        // Fleet context should use SOURCE - override if color is not SOURCE
        // This handles the case where default 'TACK' was set before cross-window sync
        setColor("SOURCE");
      }
    }
    
    // For fleet context, wait for sources to be ready
    if (currentContext === 'fleet') {
      while (!sourcesStore.isReady()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // For historical context, ensure we have source_id
    if (currentContext === 'historical') {
      const sourceId = selectedSourceId();
      if (!sourceId || sourceId <= 0) {
        logError('ManeuverWindow: Historical context requires valid source_id');
        setManeuvers([]);
        setTableData([]);
        setFiltered([]);
        return;
      }
    }
    
    // Load filters from persistent settings as fallback (only if not already set from parent sync)
    // This ensures we have filters even if parent window doesn't respond or filters aren't synced yet
    await loadFiltersFromPersistentSettings();
    
    // Wait a bit more to ensure filter sync from parent has completed
    // (parent sync might override persistent settings, which is fine)
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Initialize data - fetch table data with filters applied
    await fetchTableData();
    
    // Scaling for media-container is set up in a createEffect that depends on view()
    // so we only run it when view is SCATTER/TIME SERIES/TABLE (MAP has no media-container).
    
    // Mark initial mount as complete so createEffect can handle future changes
    isInitialMount = false;
    
    })(); // end async IIFE
  });

  onCleanup(() => {
    try { tableDataController?.abort?.(); } catch {}
    try { timesController?.abort?.(); } catch {}
  });

  // Check if maneuvers exist
  const hasManeuvers = createMemo(() => {
    const maneuversData = maneuvers();
    return maneuversData && Array.isArray(maneuversData) && maneuversData.length > 0;
  });

  // Set up dynamic scaling only when the media-container is actually rendered:
  // - hasManeuvers() (e.g. dataset_id=0 / fleet with no data → no maneuvers → container never mounted).
  // - view is SCATTER, TIME SERIES, or TABLE (MAP view has no media-container).
  createEffect(() => {
    if (!hasManeuvers()) return;
    const currentView = view();
    const hasMediaContainer = currentView === 'SCATTER' || currentView === 'TIME SERIES' || currentView === 'TABLE';
    if (!hasMediaContainer) return;
    const cleanupScaling = setupMediaContainerScaling({ logPrefix: 'ManeuverWindow' });
    onCleanup(cleanupScaling);
  });

  // Full-screen single view
  return (
    <>
      <Show when={!hasManeuvers()}>
        <div class="flex items-center justify-center h-screen">
          <div class="text-center">
            <p class="text-xl text-gray-600">No maneuvers are available</p>
          </div>
        </div>
      </Show>
      <Show when={hasManeuvers()}>
        <Show when={view() === 'MAP'}>
          <div class="maneuver-window-map-container">
            <div id="map-area" class="maneuver-window-view">
              <Show when={!grouped()}>
                <Map context={context() as "dataset" | "historical" | "fleet"} onDataUpdate={fetchTableData} />
              </Show>
              <Show when={grouped()}>
                <MapGrouped context={context() as "dataset" | "historical" | "fleet"} onDataUpdate={fetchTableData} />
              </Show>
            </div> 
          </div>
        </Show>

        <Show when={view() === 'VIDEO'}>
          <div class="maneuver-window-video-container w-full h-full flex flex-col overflow-hidden">
            <div id="video-area" class="maneuver-window-view flex-1 min-h-0">
              <Video context={context() as "dataset" | "historical" | "fleet"} tilesOnly={true} />
            </div>
          </div>
        </Show>

        <Show when={view() === 'SCATTER' || view() === 'TIME SERIES' || view() === 'TABLE'}>
          <div id="media-container" class="maneuvers-page">
            <div class="container">
              <Show when={view() === 'SCATTER'}>
                <div id="scatter-area" class="maneuver-window-view">
                  <Show when={!grouped()}>
                    <Scatter context={context() as "dataset" | "historical" | "fleet"} />
                  </Show>
                  <Show when={grouped()}>
                    <ScatterGrouped context={context() as "dataset" | "historical" | "fleet"} />
                  </Show>
                </div>
              </Show>

              <Show when={view() === 'TIME SERIES'}>
                <div id="timeseries-area" class="maneuver-window-view">
                  <Show when={!grouped()}>
                    <TimeSeries context={context() as "dataset" | "historical" | "fleet"} onDataUpdate={fetchTableData} />
                  </Show>
                  <Show when={grouped()}>
                    <TimeSeriesGrouped context={context() as "dataset" | "historical" | "fleet"} onDataUpdate={fetchTableData} onLegendClick={handleLegendClick} />
                  </Show>
                </div>
              </Show>

<Show when={view() === 'TABLE'}>
                  <div class="maneuver-window-view">
                  <Show when={!grouped()}>
                    <DataTable_Big context={context() as "dataset" | "historical" | "fleet"} onDataUpdate={fetchTableData} />
                  </Show>
                  <Show when={grouped()}>
                    <DataTable_BigGrouped context={context() as "dataset" | "historical" | "fleet"} onDataUpdate={fetchTableData} />
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </>
  );
}


