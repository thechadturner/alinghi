import { createSignal, onMount, Show, For, onCleanup, createMemo, createEffect, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";

import type mapboxgl from "mapbox-gl";

import WindArrow from "../../components/charts/map/components/WindArrow";

import Loading from "../../components/utilities/Loading";
import BackButton from "../../components/buttons/BackButton";
import BackNextButtons from "../../components/buttons/BackNextButtons";

import { step, setStep, setMaxStep, proceed, setProceed, date, setDate, startTime, setStartTime, endTime, setEndTime } from "../../store/globalStore";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName, setSelectedSourceName, setSelectedDatasetId, setSelectedMenu, selectedDate } = persistantStore;

import { formatDateTime, formatTime, formatDate, formatSeconds, groupBy, getData, postData, putData, postBinary, getTimezoneForDate, getDayBoundsInTimezone, localTimeInTimezoneToUtcDate } from "../../utils/global";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";
import { info, error as logError, debug, warn } from "../../utils/console";
import { logPageLoad } from "../../utils/logging";
import { huniDBStore } from "../../store/huniDBStore";
import { toastStore } from "../../store/toastStore";

interface Task {
    Event: string | { Race_number: number };
    Start: Date;
    End: Date;
    EventType: string;
}

interface ChannelValue {
    Datetime: Date;
    Lat: number;
    Lng: number;
    Bsp: number;
    Twa_n: number;
    Hdg: number;
    Grade: number;
    Maneuver_type?: string;
    Tws?: number;
    Twd?: number;
}

interface XRange {
    min: number;
    max: number;
}

/** When in date-only mode: one entry per dataset for that date. start_time/end_time may be null when the dataset has no DATASET event. */
interface DayDatasetEntry {
    dataset_id: number;
    source_name: string;
    start_time: string | null;
    end_time: string | null;
    duration_ms: number;
}

/** Parse API timestamp (e.g. "2026-02-14 23:05:12.9+01") to UTC Unix seconds. Normalizes space to T for ISO parse. */
function apiTimestampToUtcSeconds(apiTime: string): number {
  const s = String(apiTime).trim();
  const iso = s.includes('T') ? s : s.replace(/^\s*(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  return Math.floor(new Date(iso).getTime() / 1000);
}

import { apiEndpoints } from "@config/env";
import { bspValueFromRow, speedUnitSuffix, SpeedChannelNames } from "../../utils/speedUnits";
import "../../styles/thirdparty/mapbox-gl.css";
import "../../styles/thirdparty/my-bootstrap.css";

// Preserve edited tasks across step navigation / remounts so back from step 4 shows user's changes
const eventsTasksCache: { datasetId: number | null; tasks: Task[] } = { datasetId: null, tasks: [] };

export default function Events() {
  const navigate = useNavigate();

  let mapboxgl: typeof import('mapbox-gl').default | null = null;
  let d3: typeof import('d3') | null = null;
  
  let mapContainer: HTMLDivElement | null = null;
  let chartContainer: HTMLDivElement | null = null;
  const [map, setMap] = createSignal<mapboxgl.Map | null>(null); // Reactive signal for Show conditions
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let mapLoadHandler: (() => void) | null = null; // Track load handler to prevent duplicates
  let mapEventHandlers: { event: string; handler: () => void }[] = []; // Track map event handlers

  // Convert let variables to signals for reactivity
  const [startTimeLocal, setStartTimeLocal] = createSignal<Date | undefined>(undefined);
  const [endTimeLocal, setEndTimeLocal] = createSignal<Date | undefined>(undefined);
  const [isInitialized, setIsInitialized] = createSignal(false);

  const [allValues, setAllValues] = createSignal<ChannelValue[]>([]);
  const [values, setValues] = createSignal<ChannelValue[]>([]);
  const [filteredValues, setFilteredValues] = createSignal<ChannelValue[]>([]);
  const [pvalues, setPValues] = createSignal<ChannelValue[]>([]);
  const [currentStep, setCurrentStep] = createSignal(1);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [selectedTasks, setSelectedTasks] = createSignal<Task[]>([]);

  /** Date-only mode: datasets for the selected date with their timelines (set after resolution). */
  const [dayDatasets, setDayDatasets] = createSignal<DayDatasetEntry[]>([]);
  /** Date mode: events per dataset (loaded for each day dataset so we can save then sync each). */
  const [eventsByDatasetId, setEventsByDatasetId] = createSignal<Record<number, Task[]>>({});
  /** True when we have date set and (no dataset selected or we resolved day datasets from date). */
  const isDateMode = createMemo(() => {
    const d = selectedDate();
    if (!d || typeof d !== 'string' || d.trim() === '') return false;
    const list = dayDatasets();
    return list.length > 0 || (!selectedDatasetId() || selectedDatasetId() === 0);
  });

  // Signal set when d3 is loaded so eventColorScale can recompute (d3 is not reactive)
  const [d3Ready, setD3Ready] = createSignal(false);
  // Memoized color scale that matches the bars - updates when selectedTasks or d3 changes
  const eventColorScale = createMemo(() => {
    if (!d3Ready() || !d3) return null;
    const tasks = selectedTasks();
    if (tasks.length === 0) return null;
    return initColorScale(tasks);
  });

  // Computed: Get tasks for current step
  const tasksForCurrentStep = createMemo(() => {
    const stepNum = currentStep();
    const allTasks = tasks();
    debug(`[Events] tasksForCurrentStep memo: step=${stepNum}, totalTasks=${allTasks.length}`);
    
    let filtered: Task[] = [];
    switch (stepNum) {
      case 1: 
        filtered = allTasks.filter(t => t.EventType === 'Dataset');
        debug(`[Events] tasksForCurrentStep: Filtered ${filtered.length} Dataset tasks`);
        break;
      case 2: 
        filtered = allTasks.filter(t => t.EventType === 'Headsail');
        debug(`[Events] tasksForCurrentStep: Filtered ${filtered.length} Headsail tasks`);
        break;
      case 3: 
        filtered = allTasks.filter(t => t.EventType === 'CrewCount');
        debug(`[Events] tasksForCurrentStep: Filtered ${filtered.length} CrewCount tasks`);
        break;
      case 4:
        if (isDateMode() && dayDatasets().length > 0) {
          filtered = step4AggregatedList();
          debug(`[Events] tasksForCurrentStep: Step 4 day mode ${filtered.length} RaceStart (aggregated)`);
        } else {
          filtered = allTasks.filter(t => t.EventType === 'RaceStart');
          debug(`[Events] tasksForCurrentStep: Filtered ${filtered.length} RaceStart tasks`);
        }
        break;
      default: 
        filtered = [];
    }
    return filtered;
  });

  // Computed: Data to display (filtered or all) - used internally by loadTasksForStep
  // Note: We compute this inline in loadTasksForStep to avoid timing issues

  const speedFallbackBsp = () => `Bsp_${speedUnitSuffix(persistantStore.defaultUnits())}`;
  const speedFallbackTws = () => `Tws_${speedUnitSuffix(persistantStore.defaultUnits())}`;

  // Store default channel names (BSP/TWS fallbacks follow global speed unit preference)
  const [bspName, setBspName] = createSignal<string>(speedFallbackBsp());
  const [twaName, setTwaName] = createSignal<string>('Twa_n_deg'); // Default fallback

  const [changeMade, setChangeMade] = createSignal(false);
  /** True when the only edits are to Race/Prestart start times (step 4). Skip re-running 2_processing; only sync events on finalize. */
  const [onlyEventTimeEdits, setOnlyEventTimeEdits] = createSignal(false);
  /** Day mode: one row per Race_number with avg(race start). Updated when eventsByDatasetId loads; user edits update this. */
  const [step4AggregatedList, setStep4AggregatedList] = createSignal<Task[]>([]);
  const [showLoading, setShowLoading] = createSignal(false);
  /** User-visible reason when map has no data (e.g. load failed, no track data). */
  const [mapDataMessage, setMapDataMessage] = createSignal<string>('');
  /** Context key we last fetched (projectId-datasetId-date); used to refetch when user changes dataset/date/project. */
  const [lastFetchedContextKey, setLastFetchedContextKey] = createSignal<string | null>(null);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [processingStatusMessage, setProcessingStatusMessage] = createSignal('');
  const [showEventsSyncModal, setShowEventsSyncModal] = createSignal(false);
  const [timeElapsed, setTimeElapsed] = createSignal(0);
  const [currentProcessId, setCurrentProcessId] = createSignal<string | null>(null);

  const [xRange, setRange] = createStore<XRange>({ min: 0, max: 100 });

  // Add abort controller for all fetches in this component
  let abortController: AbortController | undefined;

  // Define handleResize function that will be used in cleanup
  // Effects will automatically redraw when values/selectedTasks change
  const handleResize = () => {
    const mapInstance = map();
    if (mapInstance) {
      mapInstance.resize();
    }
    // Redraw chart and bars when chart is visible (step < 5) and container exists. Timeline must show ALL data.
    if (chartContainer && currentStep() < 5) {
      const stepNum = currentStep();
      const fullData = stepNum < 4 ? (allValues().length > 0 ? allValues() : values()) : (pvalues().length > 0 ? pvalues() : values());
      drawChart(fullData, stepNum < 4 ? bspName() : twaName());
      // Only draw bars if the chart SVG was created (drawChart creates it only when data.length > 0)
      if (fullData.length > 0 && d3) {
        const svg = d3.select("#chart").select("svg");
        if (!svg.empty()) {
          drawBars(selectedTasks(), eventColorScale());
        }
      }
    }
  };

  // ===== REACTIVE EFFECTS =====
  // Effect: Sync selectedTasks when step changes
  // This effect runs whenever tasksForCurrentStep() changes, which happens when:
  // 1. currentStep() changes (step navigation)
  // 2. tasks() changes (events loaded/updated)
  createEffect(() => {
    const stepTasks = tasksForCurrentStep();
    const stepNum = currentStep();
    const allTasksCount = tasks().length;
    debug(`[Events] Reactive effect: Syncing selectedTasks for step ${stepNum}, found ${stepTasks.length} tasks out of ${allTasksCount} total`);
    debug(`[Events] Reactive effect: Step tasks:`, stepTasks);
    debug(`[Events] Reactive effect: Previous selectedTasks count: ${selectedTasks().length}`);
    setSelectedTasks(stepTasks);
    debug(`[Events] Reactive effect: After setSelectedTasks, new count: ${selectedTasks().length}`);
  });

  // Day mode: compute step 4 aggregated list (one per Race_number, avg race start)
  createEffect(() => {
    if (!isDateMode() || dayDatasets().length === 0) return;
    const byDs = eventsByDatasetId();
    const allRaceStarts: Task[] = [];
    for (const datasetId of Object.keys(byDs)) {
      const list = byDs[Number(datasetId)] ?? [];
      list.filter((t): t is Task => t.EventType === 'RaceStart').forEach((t) => allRaceStarts.push(t));
    }
    const byRn: Record<number, { starts: number[]; end: Date }> = {};
    for (const t of allRaceStarts) {
      const rn = typeof t.Event === 'object' && t.Event && 'Race_number' in t.Event ? (t.Event as { Race_number: number }).Race_number : 0;
      if (rn <= 0) continue;
      if (!byRn[rn]) byRn[rn] = { starts: [], end: t.End instanceof Date ? t.End : new Date(t.End as string) };
      byRn[rn].starts.push(t.Start instanceof Date ? t.Start.getTime() : new Date(t.Start as string).getTime());
    }
    const aggregated: Task[] = Object.entries(byRn).map(([rn, v]) => ({
      Event: { Race_number: Number(rn) },
      Start: new Date(v.starts.reduce((a, b) => a + b, 0) / v.starts.length),
      End: v.end,
      EventType: 'RaceStart' as const,
    }));
    setStep4AggregatedList(aggregated);
    debug(`[Events] Step 4 day aggregation: ${aggregated.length} Race_numbers`);
  });

  // Keep cache in sync so edited tasks survive step navigation / remounts (e.g. back from step 4)
  createEffect(() => {
    const t = tasks();
    const id = selectedDatasetId();
    if (id != null && t.length > 0) {
      eventsTasksCache.datasetId = id;
      eventsTasksCache.tasks = t.map((task) => ({
        ...task,
        Start: task.Start instanceof Date ? task.Start : new Date(task.Start),
        End: task.End instanceof Date ? task.End : new Date(task.End),
      }));
      setEventsByDatasetId((prev) => ({ ...prev, [id]: t }));
    }
  });

  // Effect: Update bars when selectedTasks or xRange changes
  createEffect(() => {
    const tasks = selectedTasks();
    const scale = eventColorScale(); // Use same scale as table so timeline and table colors match
    const range = xRange; // Track store dependency
    
    // Redraw timeline whenever task list or range changes (including when clearing to 0 tasks)
    // Guard: d3 is loaded asynchronously in onMount, so skip until it's available
    if (chartContainer && d3) {
      // Use untrack for non-reactive D3 calls to prevent infinite loops
      untrack(() => {
        const svg = d3.select("#chart").select("svg");
        // Only draw if SVG exists and xRange has been set (chart has been initialized)
        if (!svg.empty() && range.min > 0) {
          drawBars(tasks, scale);
        }
      });
    }
  });

  // Get track data for current step - WindArrow will extract wind data from this
  // Calculate average wind data from visible track data (same data shown on map)
  // Uses same pattern as MapContainer - uses defaultChannelsStore for field names
  const windData = createMemo(() => {
    const stepNum = currentStep();
    // Use the same data that's visible on the map: values() for steps < 4, pvalues() for step 4
    const visibleData = stepNum < 4 ? values() : pvalues();
    debug(`[Events] windData: Calculating from visible track data, step=${stepNum}, data.length=${visibleData?.length || 0}`);
    
    if (!visibleData || visibleData.length === 0) {
      debug(`[Events] windData: No visible data, returning undefined`);
      return { tws: undefined, twd: undefined };
    }

    // Get default channel names from store (same as MapContainer)
    const twdField = defaultChannelsStore.twdName();
    const twsField = defaultChannelsStore.twsName();

    // Extract Tws and Twd values using default channel names, with fallback to normalized names
    const twsValues: number[] = [];
    const twdValues: number[] = [];

    visibleData.forEach((point: any) => {
      // Try default channel name first, then normalized name, then common variations
      const twd = point[twdField] ?? point.Twd ?? point.Twd_deg ?? point.twd_deg;
      const tws = point[twsField] ?? point.Tws;

      if (twd !== undefined && twd !== null && !isNaN(Number(twd))) {
        twdValues.push(Number(twd));
      }
      if (tws !== undefined && tws !== null && !isNaN(Number(tws))) {
        twsValues.push(Number(tws));
      }
    });

    debug(`[Events] windData: twsValues.length=${twsValues.length}, twdValues.length=${twdValues.length}, using fields: twdField=${twdField}, twsField=${twsField}`);
    
    if (twsValues.length === 0 || twdValues.length === 0) {
      debug(`[Events] windData: Missing wind values, returning undefined`);
      return { tws: undefined, twd: undefined };
    }

    // Calculate mean TWD (circular mean for angles)
    const meanTWD = (() => {
      const sinSum = twdValues.reduce((sum, angle) => sum + Math.sin(angle * (Math.PI / 180)), 0);
      const cosSum = twdValues.reduce((sum, angle) => sum + Math.cos(angle * (Math.PI / 180)), 0);
      const meanAngle = Math.atan2(sinSum, cosSum) * (180 / Math.PI);
      return ((meanAngle % 360) + 360) % 360; // Normalize to 0-360
    })();

    // Calculate mean TWS (linear mean)
    const meanTWS = twsValues.reduce((sum, val) => sum + val, 0) / twsValues.length;

    return { tws: meanTWS, twd: meanTWD };
  });

  // Effect: Update chart when full data or channel changes.
  // Timeline must show the COMPLETE dataset (all rows) regardless of valid lat/lon; never use lat/lon-filtered data here.
  createEffect(() => {
    const stepNum = currentStep();
    const fullData = stepNum < 4 ? (allValues().length > 0 ? allValues() : values()) : (pvalues().length > 0 ? pvalues() : values());
    const channel = stepNum < 4 ? bspName() : twaName();

    if (fullData.length > 0 && chartContainer) {
      untrack(() => {
        drawChart(fullData, channel);
      });
    }
  });

  // Effect: Update map when values change
  createEffect(() => {
    const stepNum = currentStep();
    const valuesData = values();
    const pvaluesData = pvalues();
    
    // For step 4, use pvalues(); for steps 1-3, use values()
    // Track both so the effect re-runs when either changes
    const data = stepNum < 4 ? valuesData : pvaluesData;
    
    const mapInstance = map();
    debug(`[Events] Map effect: stepNum=${stepNum}, valuesData.length=${valuesData.length}, pvaluesData.length=${pvaluesData.length}, data.length=${data.length}, map=${mapInstance !== null}, mapContainer=${mapContainer !== null}`);
    
    if (data.length > 0 && mapContainer && mapInstance) {
      // Use queueMicrotask to ensure map is fully ready
      queueMicrotask(() => {
        const isSmallMap = stepNum < 4;
        if (isSmallMap) {
          drawMap_Small(data);
        } else {
          debug(`[Events] Map effect: Drawing big map with ${data.length} records`);
          // For step 4, always try to draw - drawMap_Big will handle map load state
          drawMap_Big(data);
        }
      });
    } else if (stepNum === 4) {
      if (pvaluesData.length === 0) {
        debug(`[Events] Map effect: Step 4 but pvalues is empty (${pvaluesData.length} records), waiting for data...`);
      } else if (!map()) {
        debug(`[Events] Map effect: Step 4, pvalues has data but map is not initialized yet`);
      } else if (!mapContainer) {
        debug(`[Events] Map effect: Step 4, pvalues has data but mapContainer is not set yet`);
      }
    }
  });

  // Refetch map/channel data when user changes project, dataset, or date (e.g. from URL or picker)
  createEffect(() => {
    const projectId = selectedProjectId();
    const datasetId = selectedDatasetId();
    const selDate = selectedDate();
    const dataDate = date();
    const lastKey = lastFetchedContextKey();
    if (!isInitialized() || lastKey === null) return;
    // Skip refetch when no valid dataset (e.g. after Finalize we set dataset to 0 before redirecting to dashboard)
    if (datasetId == null || datasetId === 0) return;
    const currentKey = `${projectId}-${datasetId}-${selDate || dataDate}`;
    if (currentKey === lastKey) return;
    // Context changed: refetch so map shows data for the new dataset/date
    debug("[Events] Context changed, refetching map data:", { lastKey, currentKey });
    if (abortController) {
      abortController.abort();
      abortController = undefined;
    }
    abortController = new AbortController();
    const controller = abortController;
    setLastFetchedContextKey(currentKey);
    setAllValues([]);
    setValues([]);
    setFilteredValues([]);
    setPValues([]);
    setMapDataMessage('');
    setShowLoading(true);
    (async () => {
      try {
        if (isDateMode() && dayDatasets().length === 0) {
          const ok = await resolveDateModeDatasets(controller.signal);
          if (!ok) {
            setShowLoading(false);
            return;
          }
        }
        const datasetIdNow = selectedDatasetId();
        if (datasetIdNow != null) {
          await setCurrentDataset(selectedClassName(), selectedProjectId(), datasetIdNow);
        }
        const data = await fetchChannelValues(controller.signal);
        setAllValues(data);
        setValues(data);
        setFilteredValues(data);
        if (data.length === 0) {
          setMapDataMessage('Map data could not be loaded. Check the notification for details.');
        } else {
          setMapDataMessage('');
        }
        setLastFetchedContextKey(`${selectedProjectId()}-${selectedDatasetId()}-${selectedDate() || date()}`);
        setShowLoading(false);
        await resolveSingleDatasetActiveRange(controller.signal);
        const runInitAndDraw = () => {
          initMap();
          if (currentStep() < 5) {
            drawMap_Small(data);
            drawChart(data, bspName());
          } else {
            setPValues(data);
            drawChart(data, twaName());
          }
        };
        setTimeout(() => {
          requestAnimationFrame(() => {
            runInitAndDraw();
            if (!map() && mapContainer === null) {
              setTimeout(runInitAndDraw, 50);
            }
          });
        }, 0);
        await retrieveEvents(controller.signal);
        const selection = filterTasksByEventType('Dataset');
        setSelectedTasks(selection);
      } catch (e) {
        if ((e as { name?: string })?.name !== 'AbortError') {
          logError("[Events] Refetch map data failed:", e);
          toastStore.showToast('error', 'Map data failed', (e as Error)?.message ?? 'Failed to load map data.');
        }
        setShowLoading(false);
      }
    })();
  });

  // Cleanup on unmount - must be at component level, not inside onMount
  onCleanup(() => {
    setIsInitialized(false); // Reset flag on cleanup
    if (timerInterval) clearInterval(timerInterval);
    document.removeEventListener("keydown", handleKeyPress);
    window.removeEventListener('resize', handleResize);
    if (abortController) {
      abortController.abort();
      abortController = undefined; // Clear reference
    }
    
    // Clean up any running processes
    const processId = currentProcessId();
    if (processId) {
      processStore.completeProcess(processId, 'timeout');
      setCurrentProcessId(null);
    }
  });

  const filterTasksByEventType = (eventType: string): Task[] => {
    return tasks().filter(task => task.EventType === eventType);
  };

  // Find the dataset with the largest file size
  const findLargestDataset = async (signal: AbortSignal): Promise<number | null> => {
    try {
      const sourceId = selectedSourceId();
      if (!sourceId) {
        warn("No source ID available for finding largest dataset");
        return null;
      }

      // Fetch all datasets for the source
      const response = await getData(
        `${apiEndpoints.app.datasets}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(sourceId)}&year_name=ALL&event_name=ALL`,
        signal
      );

      if (!response.success || !response.data || response.data.length === 0) {
        warn("No datasets found for source");
        return null;
      }

      // For now, we'll use the dataset with the most recent date or first one
      // In a real implementation, we'd need file size from the API
      // For now, return the first dataset_id as fallback
      const datasets = response.data;
      debug("Found datasets:", datasets.length);
      
      // Store all dates for processing
      const dates = [...new Set(datasets.map((d: any) => d.date))].sort();
      setDatesToProcess(dates);
      
      // Use the first dataset as primary (or we could check file sizes if available)
      if (datasets.length > 0) {
        return datasets[0].dataset_id;
      }
      
      return null;
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError("Error finding largest dataset:", error);
      }
      return null;
    }
  };

  // Navigate to dashboard with datasets list visible (after Finalize)
  const navigateToDashboardWithDatasets = () => {
    setSelectedDatasetId(0);
    setSelectedMenu('Datasets');
    navigate('/dashboard', { replace: true });
  };

  /**
   * Date-only mode: resolve datasets for selectedDate using the backend's dataset_events.duration.
   * Calls GET date/datasets_with_duration (returns rows ordered by duration DESC); primary = first row.
   * Returns true if resolution succeeded and we have at least one dataset.
   */
  const resolveDateModeDatasets = async (signal: AbortSignal): Promise<boolean> => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const dateVal = selectedDate();
    if (!className || !projectId || !dateVal || dateVal.trim() === '') {
      warn("[Events] resolveDateModeDatasets: missing class_name, project_id, or date");
      return false;
    }
    const dateForApi = String(dateVal).replace(/[-/]/g, "");
    try {
      const url = `${apiEndpoints.app.datasets}/date/datasets_with_duration?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateForApi)}`;
      const res = await getData(url, signal);
      if (!res.success || !Array.isArray(res.data) || res.data.length === 0) {
        toastStore.showToast('error', 'No datasets', 'No datasets found for this date.');
        return false;
      }
      const rows = res.data as { dataset_id: number; source_name?: string; start_time?: string | null; end_time?: string | null; duration?: number | null }[];
      const entries: DayDatasetEntry[] = rows.map((row) => {
        const st = row.start_time ?? null;
        const et = row.end_time ?? null;
        let duration_ms = 0;
        if (row.duration != null && !Number.isNaN(Number(row.duration))) {
          duration_ms = Number(row.duration) * 1000;
        } else if (st && et) {
          duration_ms = Math.abs(new Date(et).getTime() - new Date(st).getTime());
        }
        return {
          dataset_id: row.dataset_id,
          source_name: row.source_name ?? '',
          start_time: st,
          end_time: et,
          duration_ms,
        };
      });
      const primary = entries[0];
      setDayDatasets(entries);
      setSelectedDatasetId(primary.dataset_id);
      if (primary.start_time && primary.end_time) {
        setStartTime(new Date(primary.start_time).toISOString());
        setEndTime(new Date(primary.end_time).toISOString());
      } else {
        setStartTime('');
        setEndTime('');
      }
      await setCurrentDataset(className, projectId, primary.dataset_id);
      debug("[Events] resolveDateModeDatasets: primary dataset_id=", primary.dataset_id, "duration_ms=", primary.duration_ms, "total datasets=", entries.length);
      return true;
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        logError("[Events] resolveDateModeDatasets error:", e);
        toastStore.showToast('error', 'Load failed', (e as Error).message || 'Failed to resolve datasets for date.');
      }
      return false;
    }
  };

  /**
   * Single-dataset mode: when dayDatasets is empty but we have a dataset_id, load the active range
   * (DATASET event) and set startTime/endTime. When no DATASET event exists, default to full range (empty start/end).
   */
  const resolveSingleDatasetActiveRange = async (signal: AbortSignal): Promise<void> => {
    if (dayDatasets().length > 0) return;
    if (startTime() && endTime()) return;
    const datasetId = selectedDatasetId();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!datasetId || !className || !projectId) return;
    try {
      const res = await getData(
        `${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=DATASET`,
        signal
      );
      if (!res.success || !Array.isArray(res.data) || res.data.length === 0) {
        setStartTime('');
        setEndTime('');
        return;
      }
      const row = res.data[0] as { start_time?: string; end_time?: string };
      if (row?.start_time && row?.end_time) {
        setStartTime(new Date(row.start_time).toISOString());
        setEndTime(new Date(row.end_time).toISOString());
        debug("[Events] resolveSingleDatasetActiveRange: set start/end from DATASET event for dataset_id=", datasetId);
      } else {
        setStartTime('');
        setEndTime('');
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        logError("[Events] resolveSingleDatasetActiveRange error:", e);
      }
    }
  };

  /** Expand RaceStart task to RACE + PRESTART payload. PRESTART start = end - 2 min, end = race start. */
  const expandRaceStartToPayload = (t: Task): { EventType: string; Event: object; Start: string; End: string }[] => {
    const rn = typeof t.Event === 'object' && t.Event && 'Race_number' in t.Event ? (t.Event as { Race_number: number }).Race_number : 0;
    if (rn <= 0) return [];
    const raceStart = t.Start instanceof Date ? t.Start : new Date(t.Start as string);
    const raceEnd = t.End instanceof Date ? t.End : new Date(t.End as string);
    const prestartEnd = raceStart;
    const prestartStart = new Date(prestartEnd.getTime() - 120 * 1000);
    return [
      { EventType: 'Race', Event: { Race_number: rn }, Start: raceStart.toISOString(), End: raceEnd.toISOString() },
      { EventType: 'Prestart', Event: { Race_number: rn }, Start: prestartStart.toISOString(), End: prestartEnd.toISOString() },
    ];
  };

  const handleFinalize = async () => {
    setShowEventsSyncModal(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    try {
      const taskList = tasks();
      let dayList = dayDatasets();
      const className = selectedClassName();
      const projectId = selectedProjectId();

      // When user has a date selected but day list wasn't resolved (e.g. opened with dataset_id in URL or data pre-loaded),
      // resolve now so we sync ALL datasets for the day, not just the current one
      if (dayList.length === 0 && selectedDate() && String(selectedDate()).trim() && className && projectId) {
        const ac = new AbortController();
        const ok = await resolveDateModeDatasets(ac.signal);
        if (ok) {
          dayList = dayDatasets();
          debug(`[Events] handleFinalize: resolved ${dayList.length} datasets for date so we sync each`);
        }
      }

      if (dayList.length > 0) {
        // Date mode: use same user-defined Headsail/CrewCount for ALL datasets so CONFIG tags (M14-AP1-C6) update everywhere
        debug(`[Events] handleFinalize: syncing ${dayList.length} dataset(s) for this day`);
        const url = `${apiEndpoints.admin.events}/sync-dataset-events`;
        const byDataset = eventsByDatasetId();
        const primaryId = selectedDatasetId();
        const step4List = step4AggregatedList();

        const toEventPayload = (t: Task) => ({
          Event: t.Event,
          Start: t.Start instanceof Date ? t.Start.toISOString() : (typeof t.Start === 'string' ? t.Start : String(t.Start)),
          End: t.End instanceof Date ? t.End.toISOString() : (typeof t.End === 'string' ? t.End : String(t.End)),
          EventType: t.EventType,
        });

        const canonicalHeadsailCrew = taskList.filter((t) => t.EventType === 'Headsail' || t.EventType === 'CrewCount');
        const canonicalHeadsailCrewPayload = canonicalHeadsailCrew.map(toEventPayload);
        if (canonicalHeadsailCrewPayload.length > 0) {
          const nHeadsail = canonicalHeadsailCrew.filter((t) => t.EventType === 'Headsail').length;
          const nCrew = canonicalHeadsailCrew.filter((t) => t.EventType === 'CrewCount').length;
          info(`[Events] Using ${nHeadsail} Headsail and ${nCrew} CrewCount segments from primary task list for all datasets`);
        }

        const dateStrForFallback = (selectedDate() && String(selectedDate()).trim())
          ? (String(selectedDate()).length === 8 ? `${String(selectedDate()).slice(0, 4)}-${String(selectedDate()).slice(4, 6)}-${String(selectedDate()).slice(6, 8)}` : String(selectedDate()))
          : '';
        let fallbackStart = 0;
        let fallbackEnd = 0;
        if (dateStrForFallback && className && projectId) {
          try {
            const tz = await getTimezoneForDate(className, Number(projectId), (selectedDate() || '').replace(/[-/]/g, ''));
            const { startMs: dayStartMs, endMs: dayEndMs } = getDayBoundsInTimezone(dateStrForFallback, tz);
            fallbackStart = dayStartMs;
            fallbackEnd = dayEndMs;
          } catch (_) {
            const utcStart = new Date(dateStrForFallback + 'T00:00:00.000Z').getTime();
            fallbackStart = utcStart;
            fallbackEnd = new Date(dateStrForFallback + 'T23:59:59.999Z').getTime();
          }
        }
        let synced = 0;
        for (const day of dayList) {
          const dsStart = (day.start_time && day.end_time)
            ? new Date(day.start_time).getTime()
            : fallbackStart;
          const dsEnd = (day.start_time && day.end_time)
            ? new Date(day.end_time).getTime()
            : fallbackEnd;
          let thisDatasetTasks = day.dataset_id === primaryId ? taskList : (byDataset[day.dataset_id] ?? []);
          if (thisDatasetTasks.length === 0) {
            try {
              thisDatasetTasks = await retrieveEventsForDataset(day.dataset_id, undefined as AbortSignal) ?? [];
            } catch (_) {
              // keep empty so server will skip CONFIG overwrite (hasSegments guard)
            }
          }
          const overlapping = thisDatasetTasks.filter((t) => {
            const segStart = t.Start instanceof Date ? t.Start.getTime() : new Date(t.Start as string).getTime();
            const segEnd = t.End instanceof Date ? t.End.getTime() : new Date(t.End as string).getTime();
            return segStart < dsEnd && segEnd > dsStart;
          });
          const overlappingStructuralOnly = overlapping.filter((t) => t.EventType !== 'Headsail' && t.EventType !== 'CrewCount');
          // Use step4 aggregated list race start (user may have edited) for RaceStart tasks; keep this dataset's race end
          const mergeStep4Start = (list: Task[]) => list.map((t) => {
            if (t.EventType === 'RaceStart' && typeof t.Event === 'object' && t.Event && 'Race_number' in t.Event) {
              const rn = (t.Event as { Race_number: number }).Race_number;
              const fromStep4 = step4List.find((s) => typeof s.Event === 'object' && s.Event && 'Race_number' in s.Event && (s.Event as { Race_number: number }).Race_number === rn);
              if (fromStep4) return { ...t, Start: fromStep4.Start };
            }
            return t;
          });
          const merged = mergeStep4Start(overlappingStructuralOnly);
          const structuralPayload = merged.flatMap((t) => (t.EventType === 'RaceStart' ? expandRaceStartToPayload(t) : [toEventPayload(t)]));
          const mergedOverlapping = mergeStep4Start(overlapping);
          const events =
            canonicalHeadsailCrewPayload.length > 0
              ? [...canonicalHeadsailCrewPayload, ...structuralPayload]
              : mergedOverlapping.flatMap((t) => (t.EventType === 'RaceStart' ? expandRaceStartToPayload(t) : [toEventPayload(t)]));
          const payload = {
            class_name: className,
            project_id: projectId,
            dataset_id: day.dataset_id,
            events,
          };
          info(`[Events] Syncing dataset_id=${day.dataset_id} (${events.length} events)`);
          const response = await putData(url, payload);
          if (!response.success) {
            toastStore.showToast('error', 'Update Failed', response.message || 'Failed to sync dataset events.');
            return;
          }
          synced += 1;
        }
        toastStore.showToast('success', 'Events Updated', `Saved and synced events for ${synced} dataset(s).`);
        eventsTasksCache.datasetId = null;
        eventsTasksCache.tasks = [];
        navigateToDashboardWithDatasets();
      } else {
        // Single-dataset mode: expand RaceStart to RACE + PRESTART (prestart start = end - 2 min)
        const toEventPayload = (t: Task) => ({
          Event: t.Event,
          Start: t.Start instanceof Date ? t.Start.toISOString() : (typeof t.Start === 'string' ? t.Start : String(t.Start)),
          End: t.End instanceof Date ? t.End.toISOString() : (typeof t.End === 'string' ? t.End : String(t.End)),
          EventType: t.EventType,
        });
        const events = taskList.flatMap((t) => (t.EventType === 'RaceStart' ? expandRaceStartToPayload(t) : [toEventPayload(t)]));
        const payload = {
          class_name: className,
          project_id: projectId,
          dataset_id: selectedDatasetId(),
          events,
        };
        const url = `${apiEndpoints.admin.events}/sync-dataset-events`;
        const response = await putData(url, payload);
        if (response.success && response.data) {
          const data = response.data as { updated?: number; inserted?: number; deleted?: number };
          const msg = [data.updated, data.inserted, data.deleted].filter((n) => n != null && n > 0).length
            ? `Updated ${data.updated ?? 0}, inserted ${data.inserted ?? 0}, deleted ${data.deleted ?? 0} events.`
            : 'Events saved.';
          toastStore.showToast('success', 'Events Updated', msg);
          eventsTasksCache.datasetId = null;
          eventsTasksCache.tasks = [];
          navigateToDashboardWithDatasets();
        } else {
          toastStore.showToast('error', 'Update Failed', response.message || 'Failed to sync dataset events.');
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError('[Events] handleFinalize error:', err);
      toastStore.showToast('error', 'Update Failed', message);
    } finally {
      setShowEventsSyncModal(false);
    }
  };

  const retrieveEvents = async (signal: AbortSignal) => {
    try {
      let dataset_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent('DATASET')}`, signal)
      let headsail_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent('HEADSAIL')}`, signal)
      let crew_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent('CREW')}`, signal)
      let race_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent('RACE')}`, signal)
      let prestart_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&event_type=${encodeURIComponent('PRESTART')}`, signal)

      let events: Task[] = []
      if (dataset_json.success && dataset_json.data) {
        let events_data = dataset_json.data

        if (events_data.length > 0) {
          let event = events_data[0]

          let tag: Task = {
            Event: 'Active',
            Start: new Date(event.start_time),
            End: new Date(event.end_time),
            EventType: 'Dataset'
          }
          events.push(tag)

          setStartTime(tag['Start'].toISOString())
          setEndTime(tag['End'].toISOString())
        } else {
          setStartTime('')
          setEndTime('')
        }
      } else {
        setStartTime('')
        setEndTime('')
      }

      if (headsail_json.success) {
        let events_data = headsail_json.data

        events_data.forEach((event: any) => {
          let tag: Task = {
            Event: event.tags['Headsail_code'],
            Start: new Date(event.start_time),
            End: new Date(event.end_time),
            EventType: 'Headsail'
          }
          events.push(tag)
        })
      }

      if (crew_json.success) {
        let events_data = crew_json.data

        events_data.forEach((event: any) => {
          let tag: Task = {
            Event: event.tags['Count'],
            Start: new Date(event.start_time),
            End: new Date(event.end_time),
            EventType: 'CrewCount'
          }
          events.push(tag)
        })
      }

      // Step 4: one row per Race_number (RaceStart), Start = race start, End = race end (for RACE payload on save)
      const raceList: { start_time: string; end_time: string; Race_number: number }[] = race_json?.success && Array.isArray(race_json.data) ? race_json.data.map((ev: any) => ({
        start_time: ev.start_time,
        end_time: ev.end_time,
        Race_number: ev.tags?.Race_number != null ? Number(ev.tags.Race_number) : 0,
      })).filter((r: { Race_number: number }) => r.Race_number > 0) : [];
      for (const r of raceList) {
        events.push({
          Event: { Race_number: r.Race_number },
          Start: new Date(r.start_time),
          End: new Date(r.end_time),
          EventType: 'RaceStart',
        });
      }

      debug(`[Events] retrieveEvents: Retrieved ${events.length} total events from API:`, {
        dataset: events.filter(e => e.EventType === 'Dataset').length,
        headsail: events.filter(e => e.EventType === 'Headsail').length,
        crew: events.filter(e => e.EventType === 'CrewCount').length,
        raceStart: events.filter(e => e.EventType === 'RaceStart').length,
      });
      setTasks(events);
      const id = selectedDatasetId();
      if (id != null) {
        setEventsByDatasetId((prev) => ({ ...prev, [id]: events }));
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        logError('Error retrieving events:', error);
      }
    }
  };

  /** Fetch events for a specific dataset (used in date mode to load all day datasets). Returns Task[]; does not set startTime/endTime. */
  const retrieveEventsForDataset = async (datasetId: number, signal: AbortSignal): Promise<Task[]> => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const events: Task[] = [];
    try {
      const dataset_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=${encodeURIComponent('DATASET')}`, signal);
      const headsail_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=${encodeURIComponent('HEADSAIL')}`, signal);
      const crew_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=${encodeURIComponent('CREW')}`, signal);
      const race_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=${encodeURIComponent('RACE')}`, signal);
      const prestart_json = await getData(`${apiEndpoints.app.events}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}&event_type=${encodeURIComponent('PRESTART')}`, signal);

      if (dataset_json.success && dataset_json.data && (dataset_json.data as any[]).length > 0) {
        const event = (dataset_json.data as any[])[0];
        events.push({
          Event: 'Active',
          Start: new Date(event.start_time),
          End: new Date(event.end_time),
          EventType: 'Dataset',
        });
      }
      if (headsail_json.success && (headsail_json.data as any[])) {
        (headsail_json.data as any[]).forEach((ev: any) => {
          events.push({
            Event: ev.tags?.['Headsail_code'] ?? '',
            Start: new Date(ev.start_time),
            End: new Date(ev.end_time),
            EventType: 'Headsail',
          });
        });
      }
      if (crew_json.success && (crew_json.data as any[])) {
        (crew_json.data as any[]).forEach((ev: any) => {
          events.push({
            Event: ev.tags?.['Count'] ?? '',
            Start: new Date(ev.start_time),
            End: new Date(ev.end_time),
            EventType: 'CrewCount',
          });
        });
      }
      const raceList: { start_time: string; end_time: string; Race_number: number }[] = race_json?.success && Array.isArray(race_json.data) ? (race_json.data as any[]).map((ev: any) => ({
        start_time: ev.start_time,
        end_time: ev.end_time,
        Race_number: ev.tags?.Race_number != null ? Number(ev.tags.Race_number) : 0,
      })).filter((r: { Race_number: number }) => r.Race_number > 0) : [];
      for (const r of raceList) {
        events.push({
          Event: { Race_number: r.Race_number },
          Start: new Date(r.start_time),
          End: new Date(r.end_time),
          EventType: 'RaceStart',
        });
      }
      debug(`[Events] retrieveEventsForDataset: dataset_id=${datasetId} → ${events.length} events`);
      return events;
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        logError(`[Events] retrieveEventsForDataset error for dataset_id=${datasetId}:`, err);
      }
      return [];
    }
  };

  const handleTextChange = (event: Event, index: number) => {
    const updatedTasks = [...selectedTasks()];
    updatedTasks[index].Event = (event.target as HTMLInputElement).value;
    setSelectedTasks(updatedTasks); // Effect automatically redraws
    saveChanges(undefined, updatedTasks);
  };

  const handleTimeChange = (event: Event, index: number, type: 'Start' | 'End') => {
    const updatedTasks = [...selectedTasks()];
    const existing = updatedTasks[index][type];
    const newTime = (event.target as HTMLInputElement).value.trim();
    const tz = getCurrentDatasetTimezone();
    const dateStr = formatDate(existing, tz);
    const utcDate = dateStr && newTime
      ? localTimeInTimezoneToUtcDate(dateStr, newTime, tz)
      : null;
    if (utcDate) {
      updatedTasks[index][type] = utcDate;
      if (currentStep() === 4 && isDateMode()) {
        // Day mode: step 4 list is step4AggregatedList; update it
        const rn = typeof updatedTasks[index].Event === 'object' && updatedTasks[index].Event && 'Race_number' in updatedTasks[index].Event
          ? (updatedTasks[index].Event as { Race_number: number }).Race_number
          : null;
        if (rn != null) {
          setStep4AggregatedList((prev) => prev.map((t) => {
            const trn = typeof t.Event === 'object' && t.Event && 'Race_number' in t.Event ? (t.Event as { Race_number: number }).Race_number : 0;
            return trn === rn ? { ...t, [type]: utcDate } : t;
          }));
        }
        setSelectedTasks(updatedTasks);
        setChangeMade(true);
        setOnlyEventTimeEdits(true);
      } else {
        setSelectedTasks(updatedTasks);
        saveChanges(undefined, updatedTasks);
      }
    }
  };

  const removeEvent = (index: number) => {
    const updatedTasks = selectedTasks().filter((_, i) => i !== index);
    setSelectedTasks(updatedTasks);

    if (updatedTasks.length == 0) {
      setProceed(false);
    }

    if (currentStep() === 4 && isDateMode()) {
      setStep4AggregatedList(updatedTasks);
      setChangeMade(true);
      setOnlyEventTimeEdits(true);
    } else {
      saveChanges(undefined, updatedTasks);
    }

    requestAnimationFrame(() => {
      if (chartContainer && d3) {
        const svg = d3.select("#chart").select("svg");
        if (!svg.empty() && xRange.min > 0) {
          drawBars(selectedTasks(), eventColorScale());
        }
      }
    });
  };

  const saveChanges = (stepNumber?: number, tasksToSave?: Task[]) => {
    // Use provided step number, or fall back to currentStep()
    const stepToUse = stepNumber !== undefined ? stepNumber : currentStep();
    let selectedType = undefined;
    
    switch (stepToUse) {
      case 1:
        selectedType = "Dataset";
        break; 
      case 2:
        selectedType = "Headsail";
        break; 
      case 3:
        selectedType = "CrewCount";
        break;
      case 4:
        selectedType = "RacePrestart";
        break;
    }
  
    if (!selectedType) return;

    // Only step 4 (RaceStart time) edits skip re-running processing; steps 1–3 require processing when entering Review
    if (selectedType === 'RacePrestart') {
      setOnlyEventTimeEdits(true);
    } else {
      setOnlyEventTimeEdits(false);
    }

    // Step 4 uses RaceStart tasks (one per Race_number), not Race+Prestart
    const step4Filter = (task: Task) => task.EventType !== 'RaceStart';
  
    // Use explicit list when provided (avoids reading selectedTasks() before state has flushed)
    const tasksToAdd = tasksToSave !== undefined ? tasksToSave : selectedTasks();
    debug(`[Events] saveChanges: Saving ${tasksToAdd.length} ${selectedType} events to tasks()`, tasksToAdd);
    
    setTasks((prevTasks: Task[]) => {
      const filteredTasks = selectedType === 'RacePrestart'
        ? prevTasks.filter(step4Filter)
        : prevTasks.filter(task => task.EventType !== selectedType);
      const updatedTasks = [...filteredTasks, ...tasksToAdd];
      debug(`[Events] saveChanges: Updated tasks() from ${prevTasks.length} to ${updatedTasks.length} total tasks`);
      return updatedTasks;
    });

    setChangeMade(true);
  };

  const clearBrush = () => {
    setStartTimeLocal(undefined);
    if (d3) {
      d3.select(".brush").call(d3.brush().clear);
    }
  };

  const getStepContent = () => {
    switch (currentStep()) {
      case 1:
        return {
          title: "Step 1: Select Time Range",
          description: "Note: Select the total range of data to be processed on the timeline, then press enter or the spacebar to add the selection."
        };
      case 2:
        return {
          title: "Step 2: Assign Headsails",
          description: "Press 1 for LA1, 2 for AP1, 3 for AP2, 4 for HW1, 5 for HW2. Select time range first, then press number key."
        };
      case 3:
        return {
          title: "Step 3: Assign Crew Count",
          description: "Press 3–6 for crew count 3–6. Select time range first, then press number key."
        };
      case 4:
        return {
          title: "Step 4: Race start",
          description: "Review race and prestart segments. Edit race start time only; prestart end updates to match race start."
        };
      case 5:
        return {
          title: "Step 5: Review",
          description: "Example: Dark green is highest grade steady state data. Light green is moderate, and red is unsteady."
        };
      default:
        return {
          title: "Step 1: Select Time Range",
          description: "Note: Select the total range of data to be processed on the timeline, then press enter or the spacebar to add the selection."
        };
    }
  };

  // Simplified function to load tasks for a step - effects handle the rest
  const loadTasksForStep = (newStep: number) => {
    debug(`[Events] loadTasksForStep: Loading data for step ${newStep}`);
    debug(`[Events] loadTasksForStep: values().length=${values().length}, allValues().length=${allValues().length}, changeMade()=${changeMade()}`);
    
    clearBrush();

    if (newStep < 5) {
      // Update values based on step (steps 1–4: Dataset, Headsail, CrewCount, Race start)
      const filtered = filteredValues();
      const all = allValues();
      let dataToUse: ChannelValue[] = [];
      
      if (newStep === 1) {
        dataToUse = all;
      } else if (filtered.length > 0 && filtered.length < all.length) {
        dataToUse = filtered;
      } else {
        dataToUse = all;
      }
      
      setValues(dataToUse);
      
      // If coming from step 5 (Review), reinitialize map
      if (currentStep() === 5) {
        initMap();
      }
    } else if (newStep === 5) {
      // Step 5 (Review): Run 2_processing only if structural changes (Dataset/Headsail/CrewCount). If only Race/Prestart start times were edited, just sync events on finalize.
      const runProcessing = changeMade() && !onlyEventTimeEdits();
      if (runProcessing) {
        processData().then((data) => {
          debug("Processed data received:", data);
          setPValues(data);

          setTimeout(() => {
            initMap();
            drawMap_Big(data);
            drawChart(data, twaName());
            setProceed(true);
            setShowLoading(false);
          }, 100);
        }).catch((error) => {
          logError("Error in processData promise:", error);
          setShowLoading(false);
          setShowWaiting(false);
        });
      } else if (changeMade() && onlyEventTimeEdits()) {
        // Only event time edits (e.g. race start): do not re-run processing; use existing data and sync events on finalize.
        // Prefer existing pvalues (processed data) so the review map has Grade/coloring; fallback to allValues/values.
        setShowLoading(false);
        const dataToUse = pvalues().length > 0
          ? pvalues()
          : (allValues().length > 0 ? allValues() : values());
        debug(`[Events] Step 5: Only event time edits - skipping processing, using ${dataToUse.length} records`);
        setPValues(dataToUse);
        // Enable Finalize: Next sets proceed(false), so set true after step transition (microtask + again after draw)
        queueMicrotask(() => setProceed(true));
        setProceed(true);
        // Defer init and draw until step 5 DOM is mounted (mapContainer ref will point to step 5 map div).
        // Retry up to 5 times so we catch when ref is set; drawMap_Big waits for map 'load' if needed.
        const dataToDraw = dataToUse;
        const tryInitAndDraw = (attempt: number) => {
          if (currentStep() !== 5) return;
          const data = pvalues().length > 0 ? pvalues() : dataToDraw;
          if (data.length === 0) return;
          drawChart(data, twaName());
          if (!map() && mapContainer) initMap();
          if (map()) {
            drawMap_Big(data);
            return;
          }
          if (attempt < 5) setTimeout(() => tryInitAndDraw(attempt + 1), 100);
        };
        setTimeout(() => tryInitAndDraw(0), 200);
      } else {
        setShowLoading(false);
        // For step 5 (Review), always use allValues() to show the full time range (min to max)
        const dataToUse = allValues().length > 0 ? allValues() : values();
        debug(`[Events] Step 5: Setting pvalues to ${dataToUse.length} records (no changes made) - using full time range`);
        debug(`[Events] Step 5: allValues().length=${allValues().length}, values().length=${values().length}`);
        
        if (dataToUse.length > 0) {
          const sampleGrades = dataToUse.slice(0, 10).map(d => d.Grade);
          debug(`[Events] Step 5: Sample Grade values in raw data:`, sampleGrades);
          const uniqueGrades = [...new Set(dataToUse.map(d => d.Grade))].filter(g => g !== undefined && g !== null);
          debug(`[Events] Step 5: Unique Grade values:`, uniqueGrades);
        } else {
          debug(`[Events] Step 5: No data available yet (values().length=${values().length}, allValues().length=${allValues().length})`);
        }
        
        if (!map()) {
          debug(`[Events] Step 5: Initializing map`);
          initMap();
        }
        
        setPValues(dataToUse);
        debug(`[Events] Step 5: After setPValues, pvalues().length=${pvalues().length}`);
        
        setTimeout(() => {
          const mapInstance = map();
          if (mapInstance && dataToUse.length > 0 && pvalues().length > 0) {
            debug(`[Events] Step 5: Explicitly drawing map and chart with ${dataToUse.length} records`);
            drawMap_Big(dataToUse);
            drawChart(dataToUse, twaName());
          } else {
            debug(`[Events] Step 5: Cannot draw - map=${mapInstance !== null}, dataToUse.length=${dataToUse.length}, pvalues().length=${pvalues().length}`);
          }
        }, 200);
        
        setProceed(true);
      }
    }
  };

  // Keep handleStepChange for backward compatibility but simplify it
  const handleStepChange = async (prev: number, newStep: number) => {
    debug(`[Events] handleStepChange: prev=${prev}, newStep=${newStep}`);
    loadTasksForStep(newStep);
  };

  // Effect: Replace polling with reactive step detection
  // Defined after loadTasksForStep so it can reference it
  createEffect(() => {
    const newStep = step(); // Track dependency
    const prev = currentStep();
    
    if (prev !== newStep) {
      debug(`[Events] Step changed reactively: ${prev} -> ${newStep}`);
      debug(`[Events] Step change: Current tasks count: ${tasks().length}`);
      debug(`[Events] Step change: Tasks breakdown:`, {
        dataset: tasks().filter(t => t.EventType === 'Dataset').length,
        headsail: tasks().filter(t => t.EventType === 'Headsail').length,
        crew: tasks().filter(t => t.EventType === 'CrewCount').length
      });
      
      // Handle special case: going from step 2 to step 1
      if (prev === 2 && newStep === 1) {
        setFilteredValues(values());
      }
      
      setCurrentStep(newStep);
      debug(`[Events] Step change: Set currentStep to ${newStep}, tasksForCurrentStep should recalculate`);
      debug(`[Events] Step change: Immediately after setCurrentStep, tasksForCurrentStep() = ${tasksForCurrentStep().length} tasks`);
      debug(`[Events] Step change: Immediately after setCurrentStep, selectedTasks() = ${selectedTasks().length} tasks`);
      
      // Load appropriate tasks for this step - effects will handle the rest
      // The reactive effect should automatically update selectedTasks when tasksForCurrentStep() changes
      loadTasksForStep(newStep);
      
      // Verify the reactive effect ran after a microtask
      queueMicrotask(() => {
        debug(`[Events] Step change: After microtask, selectedTasks() = ${selectedTasks().length} tasks`);
        debug(`[Events] Step change: After microtask, tasksForCurrentStep() = ${tasksForCurrentStep().length} tasks`);
        if (selectedTasks().length !== tasksForCurrentStep().length) {
          warn(`[Events] MISMATCH: selectedTasks (${selectedTasks().length}) != tasksForCurrentStep (${tasksForCurrentStep().length})`);
        }
      });
    }
  });

  // Effect: Handle window resize - redraw chart and bars
  createEffect(() => {
    // Track window resize by listening to resize events
      const handleResizeEffect = () => {
      const mapInstance = map();
      if (mapInstance) {
        mapInstance.resize();
      }
      // Chart and bars will be redrawn by their respective effects
    };
    
    window.addEventListener('resize', handleResizeEffect);
    
    onCleanup(() => {
      window.removeEventListener('resize', handleResizeEffect);
    });
  });

  const HEADSAIL_KEY_MAP: Record<string, string> = {
    "1": "LA1",
    "2": "AP1",
    "3": "AP2",
    "4": "HW1",
    "5": "HW2",
  };

const hotKey = (key: string) => {
  // If no time range is selected, use the full range from the chart
  const startTimeVal = startTimeLocal();
  const endTimeVal = endTimeLocal();
  if (startTimeVal == undefined || endTimeVal == undefined) {
    const minTime = new Date(xRange.min);
    const maxTime = new Date(xRange.max);
    setStartTime(minTime.toISOString())
    setEndTime(maxTime.toISOString())
    setStartTimeLocal(minTime);
    setEndTimeLocal(maxTime);
  }

  // Ensure we have proper Date objects
  const currentStart = startTimeLocal();
  const currentEnd = endTimeLocal();
  const startDate = currentStart instanceof Date ? currentStart : new Date(currentStart!);
  const endDate = currentEnd instanceof Date ? currentEnd : new Date(currentEnd!);

  const newTask: Task = { Event: "", Start: startDate, End: endDate, EventType: "" };
  switch (currentStep()) {
    case 2:
      // Step 2: Headsails — keys 1–5 only → LA1, AP1, AP2, HW1, HW2
      if (key >= "1" && key <= "5" && HEADSAIL_KEY_MAP[key]) {
        newTask.Event = HEADSAIL_KEY_MAP[key];
        newTask.EventType = "Headsail";
      }
      break;
    case 3:
      // Step 3: Crew Count — keys 3–6 only → crew count 3, 4, 5, 6
      if (key >= "3" && key <= "6") {
        newTask.Event = key;
        newTask.EventType = "CrewCount";
      }
      break;
    default:
      break;
  }
  
  if (newTask.EventType) {
    if (currentStep() === 2 || currentStep() === 3) {
      // Step 2 (Headsails) and Step 3 (Crew Count): Add to selectedTasks for display
      const newList = [...selectedTasks(), newTask];
      setSelectedTasks(newList);
      // Pass newList so saveChanges persists the updated list (state may not have flushed yet)
      saveChanges(undefined, newList);
    }
    setChangeMade(true);
    setProceed(true);
    // Effect automatically redraws bars
  }
};

  const selectRange = () => {
    const startTimeVal = startTimeLocal();
    if (startTimeVal == undefined) {
      const minTime = new Date(xRange.min);
      const maxTime = new Date(xRange.max);
      setStartTime(minTime.toISOString())
      setEndTime(maxTime.toISOString())
      setStartTimeLocal(minTime);
      setEndTimeLocal(maxTime);
    }

    // Ensure we have proper Date objects
    const currentStart = startTimeLocal();
    const currentEnd = endTimeLocal();
    const startDate = currentStart instanceof Date ? currentStart : new Date(currentStart!);
    const endDate = currentEnd instanceof Date ? currentEnd : new Date(currentEnd!);

    const newTask: Task = { Event: "Active", Start: startDate, End: endDate, EventType: "Dataset" };
    
    setTasks([newTask]);
    setSelectedTasks([newTask]); // Effect automatically redraws
    setChangeMade(true);
    setProceed(true);
  };

  const handleKeyPress = (e: KeyboardEvent) => {
    // Ignore key repeat (avoid adding multiple tasks when key is held)
    if (e.repeat) return;

    if (currentStep() == 1) {
      if (!proceed()) {
        selectRange();
      }
    } else if (currentStep() === 2 || currentStep() === 3) {
      // Don't steal or react to keys when user is in the table (input/textarea/select)
      // Use composedPath() so we detect inputs even when target is inside a time input's internal UI (shadow DOM)
      const path = e.composedPath ? e.composedPath() : (e.target ? [e.target] : []);
      const isInsideEditable = path.some((node) => node instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
      const target = e.target as Node | null;
      const isEditable = isInsideEditable || (target && typeof (target as HTMLElement).tagName === 'string' && ['INPUT', 'TEXTAREA', 'SELECT'].includes((target as HTMLElement).tagName));
      const isNumberKey = (currentStep() === 2 && e.key >= "1" && e.key <= "5") || (currentStep() === 3 && e.key >= "3" && e.key <= "6");
      if (isEditable) {
        if (isNumberKey) return;
        // Consume editing/cursor keys so they don't bubble (avoids arrow keys triggering step advance or navigation)
        const editingKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete'];
        if (editingKeys.includes(e.key)) {
          e.stopPropagation();
          return;
        }
        // Don't advance step when Enter/Space is pressed inside an input
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
          return;
        }
      }

      // Step 2: headsail keys 1–5 only; Step 3: crew keys 3–6 only
      // Use preventDefault/stopPropagation so the key doesn't trigger links or navigation (keypress is deprecated and often doesn't fire for digits)
      if (currentStep() === 2 && e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        e.stopPropagation();
        hotKey(e.key);
      } else if (currentStep() === 3 && e.key >= "3" && e.key <= "6") {
        e.preventDefault();
        e.stopPropagation();
        hotKey(e.key);
      } else if (e.key === "x" || e.key === "X") {
        clearInfo();
      }
    }
  };

  function clearInfo() {
  }

  onMount(async () => {
    // Load mapbox-gl and d3 dynamically
    const mapboxglModule = await import('mapbox-gl');
    mapboxgl = mapboxglModule.default;
    d3 = await import('d3');
    setD3Ready(true);
    debug("[Events] onMount called - this should only happen once when component first mounts");
    debug("[Events] onMount: isInitialized=", isInitialized(), "map=", map() !== null, "allValues().length=", allValues().length);
    // Prevent re-initialization if already initialized (check map instance or data)
    if (isInitialized() || (map() !== null) || allValues().length > 0) {
      debug("[Events] Component already initialized, skipping re-initialization");
      debug("[Events] Current tasks count:", tasks().length, "headsail events:", tasks().filter(t => t.EventType === 'Headsail').length);
      
      // Ensure loading is hidden - we're just switching steps, not fetching data
      setShowLoading(false);
      
      // Reinit step order so we always start at the beginning when Events loads
      const prevStep = currentStep();
      setStep(1);
      setCurrentStep(1);
      debug(`[Events] onMount (already initialized): reset step to 1`);
      loadTasksForStep(1);
      if (prevStep !== 1) {
        handleStepChange(prevStep, 1);
      }
      // Just ensure listeners are set up (reactive effects handle step changes)
      document.addEventListener("keydown", handleKeyPress);
      window.addEventListener('resize', handleResize);
      return;
    }

    // Log page load
    await logPageLoad('Events.tsx', 'Events Page');
    
    // Mark as initialized before async operations
    setIsInitialized(true);
    
    // Explicitly resetting all signals only on first mount - always start at step 1 when Events loads
    setStep(1);
    setCurrentStep(1);
    setMaxStep(5);
    setProceed(false);
    setChangeMade(false);
    setOnlyEventTimeEdits(false);
    // Don't reset tasks here - let retrieveEvents() populate them
    setSelectedTasks([]);
    
    // Only clear data if we don't have any
    if (allValues().length === 0) {
      setAllValues([]);
      setValues([]);
      setFilteredValues([]);
    }

    abortController = new AbortController();

    // Only fetch data if we don't have it yet
    if (allValues().length === 0) {
      // Only show loading on initial data fetch, not when navigating between steps
      setShowLoading(true);

      (async () => {
        // Date-only mode: resolve primary dataset and day list before fetching
        if (isDateMode() && dayDatasets().length === 0) {
          const ok = await resolveDateModeDatasets(abortController.signal);
          if (!ok) {
            setShowLoading(false);
            return;
          }
        }

        const defaultChannels = await getDefaultChannels(abortController.signal);
        if (defaultChannels) {
          setBspName(defaultChannels.bsp_name || speedFallbackBsp());
          setTwaName(defaultChannels.twa_name || 'Twa_n_deg');
        }

        // Set dataset timezone FIRST so all displays use correct timezone
        const datasetId = selectedDatasetId();
        if (datasetId != null) {
          await setCurrentDataset(selectedClassName(), selectedProjectId(), datasetId);
        }
        
        const data = await fetchChannelValues(abortController.signal);
        setAllValues(data);
        setValues(data);
        setFilteredValues(data);
        if (data.length === 0) {
          setMapDataMessage('Map data could not be loaded. Check the notification for details.');
        } else {
          setMapDataMessage('');
        }
        setLastFetchedContextKey(`${selectedProjectId()}-${selectedDatasetId()}-${selectedDate() || date()}`);
        debug("[Events] Stored normalized channel_values in allValues/values:", data.length, "rows — chart and map draw from this data");
        setShowLoading(false);

        // Single-dataset mode: ensure startTime/endTime are set from active range (DATASET event) for processing
        await resolveSingleDatasetActiveRange(abortController.signal);

        // Defer init and draw until after map/chart DOM is mounted (they live inside Show when={!showLoading()}).
        // Use rAF so we run after the next paint; retry once if refs still null (e.g. when loading a selected date).
        const runInitAndDraw = () => {
          initMap();
          if (currentStep() < 5) {
            drawMap_Small(data);
            drawChart(data, bspName());
          } else {
            setPValues(data);
            debug(`[Events] onMount (initial fetch): Step 4, setting pvalues to full time range: ${data.length} records`);
            drawChart(data, twaName());
          }
        };
        setTimeout(() => {
          requestAnimationFrame(() => {
            runInitAndDraw();
            if (!map() && mapContainer === null) {
              debug("[Events] Map container not ready after rAF, retrying in 50ms");
              setTimeout(runInitAndDraw, 50);
            }
          });
        }, 0);
        if (datasetId != null && eventsTasksCache.datasetId === datasetId && eventsTasksCache.tasks.length > 0) {
          debug(`[Events] onMount: Restoring ${eventsTasksCache.tasks.length} tasks from cache for dataset ${datasetId}`);
          setTasks(eventsTasksCache.tasks);
          const selection = filterTasksByEventType('Dataset');
          setSelectedTasks(selection);
        } else {
          await retrieveEvents(abortController.signal);
          const selection = filterTasksByEventType('Dataset');
          setSelectedTasks(selection);
        }
        // Date mode: load events for every other dataset in the date so we can save then sync each
        const dayList = dayDatasets();
        if (dayList.length > 1) {
          const primaryId = selectedDatasetId();
          const others = dayList.filter((d) => d.dataset_id !== primaryId);
          const results = await Promise.all(others.map((d) => retrieveEventsForDataset(d.dataset_id, abortController.signal)));
          setEventsByDatasetId((prev) => {
            const next = { ...prev };
            others.forEach((d, i) => {
              next[d.dataset_id] = results[i] ?? [];
            });
            return next;
          });
          debug(`[Events] onMount: Loaded events for ${others.length} non-primary datasets for date mode`);
        }
      })();
    } else {
      // Data already exists, just ensure map and chart are drawn
      setLastFetchedContextKey(`${selectedProjectId()}-${selectedDatasetId()}-${selectedDate() || date()}`);
      setShowLoading(false);
      const dsId = selectedDatasetId();
      if (dsId != null) {
        await setCurrentDataset(selectedClassName(), selectedProjectId(), dsId);
      }

      // Defer so map/chart DOM (inside Show when={!showLoading()}) is mounted before init/draw (same as initial fetch / selected date load).
      const runInitAndDrawExisting = () => {
        initMap();
        if (currentStep() < 5) {
          drawMap_Small(values());
          drawChart(allValues().length > 0 ? allValues() : values(), bspName());
        } else {
          const fullData = allValues().length > 0 ? allValues() : values();
          setPValues(fullData);
          debug(`[Events] onMount (data exists): Step 4, setting pvalues to full time range: ${fullData.length} records`);
        }
      };
      setTimeout(() => {
        requestAnimationFrame(() => {
          runInitAndDrawExisting();
          if (!map() && mapContainer === null) {
            debug("[Events] Map container not ready after rAF (data exists path), retrying in 50ms");
            setTimeout(runInitAndDrawExisting, 50);
          }
        });
      }, 0);
      
      // Ensure events are loaded: restore from cache if we have edits for this dataset (e.g. back from step 4)
      if (tasks().length === 0 && abortController) {
        const datasetId = selectedDatasetId();
        if (datasetId != null && eventsTasksCache.datasetId === datasetId && eventsTasksCache.tasks.length > 0) {
          debug(`[Events] onMount (data exists): Restoring ${eventsTasksCache.tasks.length} tasks from cache for dataset ${datasetId}`);
          setTasks(eventsTasksCache.tasks);
          const currentStepValue = currentStep();
          if (currentStepValue === 1) {
            setSelectedTasks(filterTasksByEventType('Dataset'));
          } else if (currentStepValue === 2) {
            setSelectedTasks(filterTasksByEventType('Headsail'));
          } else if (currentStepValue === 3) {
            setSelectedTasks(filterTasksByEventType('CrewCount'));
          }
        } else {
          retrieveEvents(abortController.signal).then(() => {
            // Set the correct tasks for the current step
            const currentStepValue = currentStep();
            if (currentStepValue === 1) {
              const selection = filterTasksByEventType('Dataset');
              setSelectedTasks(selection);
            } else if (currentStepValue === 2) {
              const selection = filterTasksByEventType('Headsail');
              setSelectedTasks(selection);
            } else if (currentStepValue === 3) {
              const selection = filterTasksByEventType('CrewCount');
              setSelectedTasks(selection);
            }
            // Bars will be drawn by the reactive effect when selectedTasks changes
          });
        }
      } else {
        // Tasks already exist, set them for the current step
        const currentStepValue = currentStep();
        if (currentStepValue === 1) {
          const selection = filterTasksByEventType('Dataset');
          setSelectedTasks(selection);
        } else if (currentStepValue === 2) {
          const selection = filterTasksByEventType('Headsail');
          setSelectedTasks(selection);
        } else if (currentStepValue === 3) {
          const selection = filterTasksByEventType('CrewCount');
          setSelectedTasks(selection);
        }
        // Bars will be drawn by the reactive effect when selectedTasks changes
      }
    }

    // Reactive effects handle step changes - no polling needed
    document.addEventListener("keydown", handleKeyPress);

    // Add resize event listener for chart responsiveness (using component-level handleResize)
    window.addEventListener('resize', handleResize);
  });

  const initMap = () => {
    if (!mapboxgl) return;
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

    if (!mapContainer) {
      logError("mapContainer is not set");
      return;
    }

    // Create simple styles for maps
    const whiteStyle = {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: {
            'background-color': '#ffffff'
          }
        }
      ]
    };

    const darkStyle = {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: {
            'background-color': '#0f172a'
          }
        }
      ]
    };

    const newMap = new mapboxgl.Map({
      container: mapContainer,
      style: themeStore.isDark() ? darkStyle : whiteStyle,
      attributionControl: false,
      center: [0, 0], 
      zoom: 14, 
    });
    setMap(newMap);
    // Resize handling is done by handleResize (registered in onMount, removed in onCleanup)
  }

  // Helper function to fetch default_channels with HuniDB caching
  const getDefaultChannels = async (signal?: AbortSignal): Promise<any> => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (!className || !projectId) {
      logError("Missing className or projectId for default_channels");
      return null;
    }

    try {
      // Try to get from HuniDB first (faster, cached)
      const cached = await huniDBStore.getObject(className, 'default_channels');
      if (cached) {
        debug("Retrieved default_channels from HuniDB cache");
        return cached;
      }

      // Fallback to API call
      debug("default_channels not in cache, fetching from API");
      const response = await getData(
        `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(className)}&project_id=${projectId}&object_name=default_channels`,
        signal
      );

      if (!response.success || !response.data) {
        logError("Failed to fetch default_channels from API");
        return null;
      }

      const defaultChannels = response.data;
      
      // Store in HuniDB for future use
      try {
        await huniDBStore.storeObject(className, 'default_channels', defaultChannels);
        debug("Stored default_channels in HuniDB cache");
      } catch (storeError) {
        warn("Failed to store default_channels in HuniDB:", storeError);
        // Don't fail if storage fails, just log warning
      }

      return defaultChannels;
    } catch (error) {
      logError("Error fetching default_channels:", error);
      return null;
    }
  };

  const fetchChannelValues = async (signal: AbortSignal): Promise<ChannelValue[]> => {
    // Don't set loading here - it should be set by the caller only when needed
    // (e.g., on initial mount, not when component remounts)
    try {
      // Fetch default_channels configuration
      const defaultChannels = await getDefaultChannels(signal);
      const latName = defaultChannels?.lat_name || 'Lat_dd'; // Fallback to 'Lat_dd' if not found
      const lngName = defaultChannels?.lng_name || 'Lng_dd';
      const bspName = defaultChannels?.bsp_name || speedFallbackBsp();
      const twaName = defaultChannels?.twa_name || 'Twa_n_deg';
      const hdgName = defaultChannels?.hdg_name || 'Hdg_deg';

      let response_json = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`, signal);
      if (response_json.success) {
          let data = response_json.data;

          setDate(data.date.replace(/-/g, "").toString());
          setSelectedSourceName(data.source_name.toString());

          // DIRECT API REQUEST - use dynamic channel names from default_channels
          const twsName = defaultChannels?.tws_name || speedFallbackTws();
          const twdName = defaultChannels?.twd_name || 'Twd_deg';
          const channels = [
              { 'name': 'Datetime', 'type': 'datetime' },
              { 'name': latName, 'type': 'float' },
              { 'name': lngName, 'type': 'float' },
              { 'name': bspName, 'type': 'float' },
              { 'name': twaName, 'type': 'angle180' },
              { 'name': hdgName, 'type': 'angle360' },
              { 'name': twsName, 'type': 'float' },
              { 'name': twdName, 'type': 'angle360' },
              { 'name': 'Grade', 'type': 'int' },
              { 'name': 'Maneuver_type', 'type': 'string' }
          ];

          // Request full file (no time filter) so we get the same full range as explore/timeseries (11:00–12:45).
          // Send start_ts/end_ts as null so the backend returns all rows from the parquet; explicit range was returning only part of the data.
          const dateStr = (selectedDate() && String(selectedDate()).trim())
            ? (String(selectedDate()).length === 8 ? `${String(selectedDate()).slice(0, 4)}-${String(selectedDate()).slice(4, 6)}-${String(selectedDate()).slice(6, 8)}` : String(selectedDate()))
            : (date().length === 8 ? `${date().slice(0, 4)}-${date().slice(4, 6)}-${date().slice(6, 8)}` : date());
          const timezone = getCurrentDatasetTimezone() ?? await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), (selectedDate() || date()).replace(/[-/]/g, ''));
          const { startMs: dayStartMs, endMs: dayEndMs } = getDayBoundsInTimezone(dateStr, timezone);
          const dayStartTs = Math.floor(dayStartMs / 1000);
          const dayEndTs = Math.floor(dayEndMs / 1000);
          const primaryEntry = dayDatasets().find((d) => d.dataset_id === selectedDatasetId());
          const logStartTs = (primaryEntry && primaryEntry.start_time != null && primaryEntry.end_time != null)
            ? Math.min(apiTimestampToUtcSeconds(primaryEntry.start_time), dayStartTs)
            : dayStartTs;
          const logEndTs = (primaryEntry && primaryEntry.start_time != null && primaryEntry.end_time != null)
            ? Math.max(apiTimestampToUtcSeconds(primaryEntry.end_time), dayEndTs)
            : dayEndTs;
          debug("[Events] fetchChannelValues: request full file (start_ts/end_ts=null)", {
            dateStr,
            timezone,
            fullDayRangeForLog: { logStartTs, logEndTs, requestFromUTC: new Date(logStartTs * 1000).toISOString(), requestToUTC: new Date(logEndTs * 1000).toISOString() },
          });

          // Use the dataset's date from API (date() was just set from data.date) so the backend resolves the correct folder path.
          const payloadDate = String(date()).replace(/[-/]/g, '');
          const payload = {
              project_id: selectedProjectId().toString(),
              class_name: selectedClassName().toString(),
              date: payloadDate,
              source_name: selectedSourceName(),
              channel_list: channels,
              start_ts: null,
              end_ts: null,
              timezone: timezone ?? 'UTC',
              data_source: 'auto',
              resolution: '1s',
          };

          let response = await postBinary(apiEndpoints.file.channelValues, payload, signal);
          if (!response.success) {
            const status = response.status ?? "no status";
            const msg = response.message ?? response.error ?? "Unknown error";
            throw new Error(`Error fetching channel values: ${msg} (status: ${status})`);
          }

          // postBinary already parses the binary Arrow format, so response.data should be an array
          let channel_values = response.data;

          // Validate that we received parsed data
          if (!Array.isArray(channel_values)) {
              logError("Error: Expected array from postBinary, got:", typeof channel_values, channel_values);
              toastStore.showToast('error', 'Map data failed', 'Server returned invalid data. Check the console for details.');
              return [];
          }

          debug("[Events] channel_values received", channel_values.length, "rows (all kept for timeline)");

          // Log first and last RAW records from API (data retrieved)
          if (channel_values.length > 0) {
            const rawFirst = channel_values[0] as any;
            const rawLast = channel_values[channel_values.length - 1] as any;
            debug("[Events] RAW (API) first record:", {
              Datetime: rawFirst?.Datetime,
              [SpeedChannelNames.bspMetric]: rawFirst?.[SpeedChannelNames.bspMetric],
              [SpeedChannelNames.bspKnots]: rawFirst?.[SpeedChannelNames.bspKnots],
              Lat_dd: rawFirst?.Lat_dd,
              Lng_dd: rawFirst?.Lng_dd,
              ts: rawFirst?.ts,
            });
            debug("[Events] RAW (API) last record:", {
              Datetime: rawLast?.Datetime,
              [SpeedChannelNames.bspMetric]: rawLast?.[SpeedChannelNames.bspMetric],
              [SpeedChannelNames.bspKnots]: rawLast?.[SpeedChannelNames.bspKnots],
              Lat_dd: rawLast?.Lat_dd,
              Lng_dd: rawLast?.Lng_dd,
              ts: rawLast?.ts,
            });
          }

          try {
              debug("Channel values received:", channel_values.length, "records");
              // Debug: Check first row to see what fields are available
              if (channel_values.length > 0) {
                debug("[Events] First channel value row fields:", Object.keys(channel_values[0]));
                debug("[Events] First channel value row sample:", channel_values[0]);
                debug("[Events] Wind fields - twsName:", twsName, "value:", channel_values[0][twsName]);
                debug("[Events] Wind fields - twdName:", twdName, "value:", channel_values[0][twdName]);
              }
              // Normalize only: do not drop rows. Preserve full API response so time range and map data are unchanged.
              const normalized_channel_values: ChannelValue[] = [];
              channel_values.forEach((row: any) => {
                const rawLat = row[latName] ?? row.Lat_dd ?? row.lat_dd;
                const rawLng = row[lngName] ?? row.Lng_dd ?? row.lng_dd;
                const lat = typeof rawLat === 'number' && Number.isFinite(rawLat) ? rawLat : (typeof rawLat === 'string' && !Number.isNaN(Number(rawLat)) ? Number(rawLat) : Number.NaN);
                const lng = typeof rawLng === 'number' && Number.isFinite(rawLng) ? rawLng : (typeof rawLng === 'string' && !Number.isNaN(Number(rawLng)) ? Number(rawLng) : Number.NaN);
                const twsValue = row[twsName] ?? row.TWS;
                const twdValue = row[twdName] ?? row.Twd_deg ?? row.twd_deg ?? row.TWD;
                const normalizedRow: ChannelValue = {
                  Datetime: new Date(row.Datetime),
                  Lat: lat,
                  Lng: lng,
                  Bsp: bspValueFromRow(row as Record<string, unknown>, bspName, Number.NaN),
                  Twa_n: row[twaName] ?? row.Twa_n_deg ?? Number.NaN,
                  Hdg: row[hdgName] ?? row.Hdg_deg ?? Number.NaN,
                  Tws: twsValue,
                  Twd: twdValue,
                  Grade: row.Grade,
                  Maneuver_type: row.Maneuver_type
                };
                if (normalized_channel_values.length < 3) {
                  debug(`[Events] Normalized row ${normalized_channel_values.length}: Tws=${twsValue}, Twd=${twdValue}, Lat=${lat}, Lng=${lng}`);
                }
                normalized_channel_values.push(normalizedRow);
              });
              channel_values = normalized_channel_values;
          } catch (error) {
              logError("Error processing channel values:", error);
              toastStore.showToast('error', 'Map data failed', 'Could not process track data. Check the console for details.');
              return [];
          }

          debug("[Events] normalized_channel_values (all rows kept for timeline)", channel_values.length);

          // Log first and last NORMALIZED records (data that is drawn on timeline/map)
          if (channel_values.length > 0) {
            const normFirst = channel_values[0];
            const normLast = channel_values[channel_values.length - 1];
            debug("[Events] NORMALIZED (drawn) first record:", {
              Datetime: normFirst.Datetime,
              DatetimeISO: normFirst.Datetime instanceof Date ? normFirst.Datetime.toISOString() : String(normFirst.Datetime),
              Bsp: normFirst.Bsp,
              Lat: normFirst.Lat,
              Lng: normFirst.Lng,
            });
            debug("[Events] NORMALIZED (drawn) last record:", {
              Datetime: normLast.Datetime,
              DatetimeISO: normLast.Datetime instanceof Date ? normLast.Datetime.toISOString() : String(normLast.Datetime),
              Bsp: normLast.Bsp,
              Lat: normLast.Lat,
              Lng: normLast.Lng,
            });
          }

          // This return is stored in allValues/values and is what the chart draws (same data).
          if (channel_values.length === 0) {
            warn("[Events] fetchChannelValues: API returned no rows for this dataset");
            toastStore.showToast('info', 'No map data', 'No track data for this dataset. The map will be empty.');
          }
          return channel_values;
      } else {
          warn("[Events] fetchChannelValues: Dataset info failed or missing", response_json);
          toastStore.showToast('error', 'Map data failed', response_json?.message ?? 'Could not load dataset info.');
          return [];
      }
    } catch (error: any) {
        if (error.name === 'AbortError') {
          return [];
        }
        logError("Error fetching channel values:", error);
        const msg = error?.message ?? String(error);
        toastStore.showToast('error', 'Map data failed', msg.length > 120 ? `${msg.slice(0, 120)}…` : msg);
        return [];
    } finally {
      setShowLoading(false);
    }
  };

  const processData = async (signal?: AbortSignal): Promise<ChannelValue[]> => {
    debug("Starting processData...");
    setChangeMade(false);
    setOnlyEventTimeEdits(false);
    setShowWaiting(true);
    setTimeElapsed(0);

    // Use component-level abortController so it can be cleaned up on unmount
    if (!abortController) {
      abortController = new AbortController();
    }
    const controller = abortController;

    // Ensure active range (start/end) is set for single-dataset mode before building parameters
    if (!startTime() || !endTime()) {
      await resolveSingleDatasetActiveRange(controller.signal);
    }

    const st = startTime();
    const et = endTime();
    const useFullRange = !st || !et;
    let parameters: Record<string, unknown> = {
      project_id: selectedProjectId().toString(),
      class_name: selectedClassName().toString(),
      dataset_id: selectedDatasetId().toString(),
      date: date(),
      source_name: selectedSourceName(),
      events: tasks(),
      preserve_events: false,
      day_type: ['TRAINING', 'RACING'],
      race_type: ['INSHORE', 'COASTAL', 'OFFSHORE'],
    };
    if (!useFullRange) {
      parameters.start_time = new Date(st).toISOString();
      parameters.end_time = new Date(et).toISOString();
    }
  
    let payload = {
      project_id: selectedProjectId().toString(),
      class_name: selectedClassName().toString(),
      script_name: "2_processing.py",
      parameters: parameters,
    };

    info("[Events] 2_processing.py request body (for manual testing):", JSON.stringify(payload, null, 2));
    info("[Events] 2_processing.py argv[1] (parameters only, for: python3 -u 2_processing.py '<this>'):", JSON.stringify(parameters));
  
    // Start timer
    let timer = Date.now();
    timerInterval = setInterval(() => {
      setTimeElapsed(Math.floor((Date.now() - timer) / 1000));
    }, 1000);
  
    try {
      debug("Sending request to execute script...");
      
      // Pre-establish SSE connection for script execution
      await sseManager.connectToServer(8049);
      
      const dayList = dayDatasets();
      if (dayList.length > 0) {
        setProcessingStatusMessage(`Processing ${dayList.length} datasets for this day...`);
        await new Promise<void>((r) => setTimeout(r, 0));
        const dateNorm = (selectedDate() && String(selectedDate()).trim()) ? String(selectedDate()).replace(/[-/]/g, '') : date();
        const className = selectedClassName();
        const projectId = selectedProjectId().toString();
        const dateStrNorm = dateNorm.length === 8 ? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}` : dateNorm;
        let fallbackStartIso = dateStrNorm ? new Date(dateStrNorm + 'T00:00:00.000Z').toISOString() : '';
        let fallbackEndIso = dateStrNorm ? new Date(dateStrNorm + 'T23:59:59.999Z').toISOString() : '';
        try {
          const tz = await getTimezoneForDate(className, Number(projectId), dateNorm);
          const { startMs: dayStartMs, endMs: dayEndMs } = getDayBoundsInTimezone(dateStrNorm, tz);
          fallbackStartIso = new Date(dayStartMs).toISOString();
          fallbackEndIso = new Date(dayEndMs).toISOString();
        } catch (_) {
          // keep UTC day fallback
        }
        for (let i = 0; i < dayList.length; i++) {
          const row = dayList[i];
          setProcessingStatusMessage(`Processing dataset ${i + 1} of ${dayList.length}...`);
          // Yield so the modal can paint the progress message before the blocking request
          await new Promise<void>((r) => setTimeout(r, 0));
          const startIso = (row.start_time && row.end_time)
            ? new Date(row.start_time).toISOString()
            : fallbackStartIso;
          const endIso = (row.start_time && row.end_time)
            ? new Date(row.end_time).toISOString()
            : fallbackEndIso;
          const datasetEvent = { EventType: 'Dataset', Event: 'Active', Start: startIso, End: endIso };
          const headsailAndCrew = tasks()
            .filter((t) => t.EventType === 'Headsail' || t.EventType === 'CrewCount')
            .map((t) => ({
              EventType: t.EventType === 'CrewCount' ? 'Crew' : t.EventType,
              Event: t.Event,
              Start: t.Start instanceof Date ? t.Start.toISOString() : (typeof t.Start === 'string' ? t.Start : String(t.Start)),
              End: t.End instanceof Date ? t.End.toISOString() : (typeof t.End === 'string' ? t.End : String(t.End)),
            }));
          const parameters = {
            project_id: projectId,
            class_name: className.toString(),
            dataset_id: row.dataset_id.toString(),
            date: dateNorm,
            source_name: row.source_name,
            start_time: startIso,
            end_time: endIso,
            events: [datasetEvent, ...headsailAndCrew],
            preserve_events: false,
            day_type: ['TRAINING', 'RACING'],
            race_type: ['INSHORE', 'COASTAL', 'OFFSHORE'],
          };
          const dayPayload = { project_id: projectId, class_name: className.toString(), script_name: '2_processing.py', parameters };
          const response_json = await postData(apiEndpoints.python.execute_script, dayPayload, controller.signal);
          if (!response_json.success) {
            if (timerInterval) clearInterval(timerInterval);
            setShowWaiting(false);
            setProcessingStatusMessage('');
            toastStore.showToast('error', 'Processing failed', `Failed for dataset ${row.dataset_id}: ${response_json.message ?? 'Unknown error'}`);
            return [];
          }
          const pid = response_json.process_id ?? response_json?.data?.process_id ?? `script_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          processStore.startProcess(pid, 'script_execution', false); // no toast per dataset; show final toast only
          // If server returned completion (blocking execute_script), mark complete immediately
          // so we don't wait forever for SSE (e.g. after SSE disconnected between requests)
          const data = response_json?.data ?? response_json;
          const returnCode = data?.return_code;
          const scriptSucceeded = data?.script_succeeded ?? (returnCode === 0);
          if (returnCode !== undefined && returnCode !== null) {
            const status: 'complete' | 'error' = scriptSucceeded ? 'complete' : 'error';
            processStore.completeProcess(pid, status, data);
          }
          try {
            await new Promise<void>((resolve, reject) => {
              let cleared = false;
              let iv: ReturnType<typeof setInterval> | undefined;
              let tm: ReturnType<typeof setTimeout> | undefined;
              const cleanup = () => {
                if (cleared) return;
                cleared = true;
                if (iv !== undefined) clearInterval(iv);
                if (tm !== undefined) clearTimeout(tm);
              };
              const check = () => {
                const p = processStore.getProcess(pid);
                if (p?.status === 'complete') { cleanup(); resolve(); return; }
                if (p?.status === 'error' || p?.status === 'timeout') { cleanup(); reject(new Error(p?.status ?? 'unknown')); return; }
              };
              check();
              iv = setInterval(check, 500);
              tm = setTimeout(() => {
                cleanup();
                if (processStore.getProcess(pid)?.status === 'running') reject(new Error('timeout'));
                else resolve();
              }, 300000);
            });
          } catch (waitErr) {
            if (timerInterval) clearInterval(timerInterval);
            setShowWaiting(false);
            setProcessingStatusMessage('');
            const msg = waitErr instanceof Error ? waitErr.message : String(waitErr);
            toastStore.showToast('error', 'Processing failed', `Dataset ${row.dataset_id}: ${msg}`);
            return [];
          }
          setProcessingStatusMessage(`Processed dataset ${i + 1} of ${dayList.length}`);
        }
        setProcessingStatusMessage('');
        if (timerInterval) clearInterval(timerInterval);
        setShowWaiting(false);
        setShowLoading(false);
        try {
          const defaultChannels = await getDefaultChannels(controller.signal);
          const latName = defaultChannels?.lat_name || 'Lat_dd';
          const lngName = defaultChannels?.lng_name || 'Lng_dd';
          const bspName = defaultChannels?.bsp_name || speedFallbackBsp();
          const twaNameCh = defaultChannels?.twa_name || 'Twa_n_deg';
          const hdgName = defaultChannels?.hdg_name || 'Hdg_deg';
          const twsName = defaultChannels?.tws_name || speedFallbackTws();
          const twdName = defaultChannels?.twd_name || 'Twd_deg';
          const channels = [
            { 'name': 'Datetime', 'type': 'datetime' as const },
            { 'name': latName, 'type': 'float' as const },
            { 'name': lngName, 'type': 'float' as const },
            { 'name': bspName, 'type': 'float' as const },
            { 'name': twaNameCh, 'type': 'angle180' as const },
            { 'name': hdgName, 'type': 'angle360' as const },
            { 'name': twsName, 'type': 'float' as const },
            { 'name': twdName, 'type': 'angle360' as const },
            { 'name': 'Grade', 'type': 'int' as const },
            { 'name': 'Maneuver_type', 'type': 'string' as const }
          ];
          const primaryEntryProcess = dayDatasets().find((d) => d.dataset_id === selectedDatasetId());
          let start_ts_process: number;
          let end_ts_process: number;
          if (primaryEntryProcess && primaryEntryProcess.start_time != null && primaryEntryProcess.end_time != null) {
            start_ts_process = apiTimestampToUtcSeconds(primaryEntryProcess.start_time);
            end_ts_process = apiTimestampToUtcSeconds(primaryEntryProcess.end_time);
          } else {
            const dateStrProcess = date().length === 8 ? `${date().slice(0, 4)}-${date().slice(4, 6)}-${date().slice(6, 8)}` : date();
            const timezoneProcess = await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), date().replace(/[-/]/g, ''));
            const { startMs: startMsProcess, endMs: endMsProcess } = getDayBoundsInTimezone(dateStrProcess, timezoneProcess);
            start_ts_process = Math.floor(startMsProcess / 1000);
            end_ts_process = Math.floor(endMsProcess / 1000);
          }
          const payloadDateProcess = (selectedDate() && String(selectedDate()).trim()) ? String(selectedDate()).replace(/[-/]/g, '') : date();
          const timezoneProcess = getCurrentDatasetTimezone() ?? await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), date().replace(/[-/]/g, ''));
          const fetchPayload = {
            project_id: projectId,
            class_name: className.toString(),
            date: payloadDateProcess,
            source_name: selectedSourceName(),
            channel_list: channels,
            start_ts: start_ts_process,
            end_ts: end_ts_process,
            timezone: timezoneProcess ?? 'UTC',
            data_source: 'auto',
            resolution: '1s'
          };
          const response = await postBinary(apiEndpoints.file.channelValues, fetchPayload, controller.signal);
          if (!response.success) throw new Error(`HTTP error! Status: ${response.message}`);
          let channel_values = response.data;
          if (!Array.isArray(channel_values)) {
            logError("Error: Expected array from postBinary, got:", typeof channel_values, channel_values);
            toastStore.showToast('success', 'Processing complete', `Processed ${dayList.length} datasets for this day.`);
            return [];
          }
          const normalized_channel_values_process: ChannelValue[] = [];
          channel_values.forEach((rowVal: any) => {
            const rawLat = rowVal[latName] ?? rowVal.Lat_dd ?? rowVal.lat_dd;
            const rawLng = rowVal[lngName] ?? rowVal.Lng_dd ?? rowVal.lng_dd;
            const lat = typeof rawLat === 'number' && Number.isFinite(rawLat) ? rawLat : (typeof rawLat === 'string' && !Number.isNaN(Number(rawLat)) ? Number(rawLat) : Number.NaN);
            const lng = typeof rawLng === 'number' && Number.isFinite(rawLng) ? rawLng : (typeof rawLng === 'string' && !Number.isNaN(Number(rawLng)) ? Number(rawLng) : Number.NaN);
            const twsValue = rowVal[twsName] ?? rowVal.TWS;
            const twdValue = rowVal[twdName] ?? rowVal.Twd_deg ?? rowVal.twd_deg ?? rowVal.TWD;
            normalized_channel_values_process.push({
              Datetime: new Date(rowVal.Datetime),
              Lat: lat,
              Lng: lng,
              Bsp: bspValueFromRow(rowVal as Record<string, unknown>, bspName, Number.NaN),
              Twa_n: rowVal[twaNameCh] ?? rowVal.Twa_n_deg ?? Number.NaN,
              Hdg: rowVal[hdgName] ?? rowVal.Hdg_deg ?? Number.NaN,
              Tws: twsValue,
              Twd: twdValue,
              Grade: rowVal.Grade,
              Maneuver_type: rowVal.Maneuver_type
            });
          });
          toastStore.showToast('success', 'Processing complete', `Processed ${dayList.length} datasets for this day.`);
          return normalized_channel_values_process;
        } catch (fetchError) {
          logError("Error fetching processed data after day processing:", fetchError);
          toastStore.showToast('success', 'Processing complete', `Processed ${dayList.length} datasets for this day.`);
          return [];
        }
      }
      
      let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
      if (!response_json.success) throw new Error(`HTTP error! Status: ${response_json.message}`);

      // Extract process_id and store
      let pid = null;
      if (response_json.process_id) {
        pid = response_json.process_id;
      } else if (response_json?.data?.process_id) {
        pid = response_json.data.process_id;
      } else {
        warn('[Events] No process_id in server response, using fallback');
        pid = `script_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
      debug('[Events] Using process_id:', pid);
      setCurrentProcessId(pid);
      
      // Start the process in the store with toast enabled to avoid race conditions
      processStore.startProcess(pid, 'script_execution', true);
      // If the server returned completion (blocking execute_script), mark complete immediately
      // so the modal and polling see completion even if SSE never arrived
      const data = response_json?.data ?? response_json;
      const returnCode = data?.return_code;
      const scriptSucceeded = data?.script_succeeded ?? (returnCode === 0);
      if (returnCode !== undefined && returnCode !== null) {
        const status: 'complete' | 'error' = scriptSucceeded ? 'complete' : 'error';
        processStore.completeProcess(pid, status, data);
        debug('[Events] Marked process complete from HTTP response (return_code=', returnCode, ')');
      }
      debug('[Events] Process started with toast enabled:', pid);
      
      // Return a promise that resolves when the process completes
      return new Promise((resolve, reject) => {
        let checkInterval: ReturnType<typeof setInterval> | undefined;
        const checkProcess = async () => {
          const process = processStore.getProcess(pid);
          if (process) {
            if (process.status === 'complete') {
              clearInterval(timerInterval);
              if (checkInterval !== undefined) {
                clearInterval(checkInterval);
                checkInterval = undefined;
              }
              setShowWaiting(false);
              setShowLoading(false);
              
              // Fetch the processed data from channelValues endpoint
              try {
                debug("Script completed, fetching processed data from channelValues...");
                
                // Fetch default_channels configuration
                const defaultChannels = await getDefaultChannels(controller.signal);
                const latName = defaultChannels?.lat_name || 'Lat_dd'; // Fallback to 'Lat_dd' if not found
                const lngName = defaultChannels?.lng_name || 'Lng_dd';
                const bspName = defaultChannels?.bsp_name || speedFallbackBsp();
                const twaName = defaultChannels?.twa_name || 'Twa_n_deg';
                const hdgName = defaultChannels?.hdg_name || 'Hdg_deg';
                const twsName = defaultChannels?.tws_name || speedFallbackTws();
                const twdName = defaultChannels?.twd_name || 'Twd_deg';
                
                // Use dynamic channel names from default_channels
                const channels = [
                  { 'name': 'Datetime', 'type': 'datetime' },
                  { 'name': latName, 'type': 'float' },
                  { 'name': lngName, 'type': 'float' },
                  { 'name': bspName, 'type': 'float' },
                  { 'name': twaName, 'type': 'angle180' },
                  { 'name': hdgName, 'type': 'angle360' },
                  { 'name': twsName, 'type': 'float' },
                  { 'name': twdName, 'type': 'angle360' },
                  { 'name': 'Grade', 'type': 'int' },
                  { 'name': 'Maneuver_type', 'type': 'string' }
                ];

                // Longest-dataset start/end from API (e.g. "2026-02-14 23:05:12.9+01") → UTC seconds for query. Date.getTime() is UTC ms.
                const primaryEntryProcess = dayDatasets().find((d) => d.dataset_id === selectedDatasetId());
                let start_ts_process: number;
                let end_ts_process: number;
                if (primaryEntryProcess && primaryEntryProcess.start_time != null && primaryEntryProcess.end_time != null) {
                  start_ts_process = apiTimestampToUtcSeconds(primaryEntryProcess.start_time);
                  end_ts_process = apiTimestampToUtcSeconds(primaryEntryProcess.end_time);
                } else {
                  const dateStrProcess = date().length === 8 ? `${date().slice(0, 4)}-${date().slice(4, 6)}-${date().slice(6, 8)}` : date();
                  const timezoneProcess = await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), date().replace(/[-/]/g, ''));
                  const { startMs: startMsProcess, endMs: endMsProcess } = getDayBoundsInTimezone(dateStrProcess, timezoneProcess);
                  start_ts_process = Math.floor(startMsProcess / 1000);
                  end_ts_process = Math.floor(endMsProcess / 1000);
                }

                // date: selectedDate (local), no conversion — where data files are. YYYYMMDD.
                const payloadDateProcess = (selectedDate() && String(selectedDate()).trim()) ? String(selectedDate()).replace(/[-/]/g, '') : date();
                const timezoneProcess = getCurrentDatasetTimezone() ?? await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), date().replace(/[-/]/g, ''));
                const payload = {
                  project_id: selectedProjectId().toString(),
                  class_name: selectedClassName().toString(),
                  date: payloadDateProcess,
                  source_name: selectedSourceName(),
                  channel_list: channels,
                  start_ts: start_ts_process,
                  end_ts: end_ts_process,
                  timezone: timezoneProcess ?? 'UTC',
                  data_source: 'auto',
                  resolution: '1s'
                };

                let response = await postBinary(apiEndpoints.file.channelValues, payload, controller.signal);
                if (!response.success) throw new Error(`HTTP error! Status: ${response.message}`);

                // postBinary already parses the binary Arrow format, so response.data should be an array
                let channel_values = response.data;

                // Validate that we received parsed data
                if (!Array.isArray(channel_values)) {
                    logError("Error: Expected array from postBinary, got:", typeof channel_values, channel_values);
                    resolve([]);
                    return;
                }
                
                debug("Received processed data:", channel_values.length, "records");
                // Debug: Check first row to see what fields are available
                if (channel_values.length > 0) {
                  debug("[Events] ProcessData: First row fields:", Object.keys(channel_values[0]));
                  debug("[Events] ProcessData: Wind fields - twsName:", twsName, "value:", channel_values[0][twsName]);
                  debug("[Events] ProcessData: Wind fields - twdName:", twdName, "value:", channel_values[0][twdName]);
                }

                // Normalize only: do not drop rows (same as fetchChannelValues)
                try {
                  const normalized_channel_values_process: ChannelValue[] = [];
                  channel_values.forEach((row: any) => {
                    const rawLat = row[latName] ?? row.Lat_dd ?? row.lat_dd;
                    const rawLng = row[lngName] ?? row.Lng_dd ?? row.lng_dd;
                    const lat = typeof rawLat === 'number' && Number.isFinite(rawLat) ? rawLat : (typeof rawLat === 'string' && !Number.isNaN(Number(rawLat)) ? Number(rawLat) : Number.NaN);
                    const lng = typeof rawLng === 'number' && Number.isFinite(rawLng) ? rawLng : (typeof rawLng === 'string' && !Number.isNaN(Number(rawLng)) ? Number(rawLng) : Number.NaN);
                    const twsValue = row[twsName] ?? row.TWS;
                    const twdValue = row[twdName] ?? row.Twd_deg ?? row.twd_deg ?? row.TWD;
                    normalized_channel_values_process.push({
                      Datetime: new Date(row.Datetime),
                      Lat: lat,
                      Lng: lng,
                      Bsp: bspValueFromRow(row as Record<string, unknown>, bspName, Number.NaN),
                      Twa_n: row[twaName] ?? row.Twa_n_deg ?? Number.NaN,
                      Hdg: row[hdgName] ?? row.Hdg_deg ?? Number.NaN,
                      Tws: twsValue,
                      Twd: twdValue,
                      Grade: row.Grade,
                      Maneuver_type: row.Maneuver_type
                    });
                  });
                  channel_values = normalized_channel_values_process;
                } catch (error) {
                  logError("Error processing channel values:", error);
                  resolve([]);
                  return;
                }
                
                debug("ProcessData returning data successfully");
                resolve(channel_values);
              } catch (fetchError) {
                logError("Error fetching processed data:", fetchError);
                resolve([]); // Return empty array on fetch error
              }
            } else if (process.status === 'error' || process.status === 'timeout') {
              clearInterval(timerInterval);
              if (checkInterval !== undefined) {
                clearInterval(checkInterval);
                checkInterval = undefined;
              }
              setShowWaiting(false);
              setShowLoading(false);
              debug("ProcessData failed:", process.status);
              resolve([]); // Return empty array for errors
            }
          }
        };
        
        // Check immediately and then every 500ms
        checkProcess();
        checkInterval = setInterval(checkProcess, 500);
        
        // Set a timeout to prevent hanging
        setTimeout(() => {
          clearInterval(checkInterval);
          if (processStore.getProcess(pid)?.status === 'running') {
            clearInterval(timerInterval);
            setShowWaiting(false);
            setShowLoading(false);
            debug("ProcessData timeout");
            resolve([]);
          }
        }, 300000); // 5 minute timeout
      });
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        debug("ProcessData aborted");
        return []; // Return empty array for aborted requests
      } else {
        logError("Error processing data:", error);
        return []; // Return empty array for other errors
      }
    } finally {
      if (timerInterval) clearInterval(timerInterval); // Clear the timer interval, not the main interval
      setShowWaiting(false);
      setShowLoading(false);
      setProcessingStatusMessage('');
      debug("ProcessData finished, modal should be closed");
    }
  };

  // Map only: receives full data; we plot only rows with valid lat/lon. Timeline is unchanged.
  const drawMap_Big = (data: ChannelValue[]) => {
    debug(`[Events] drawMap_Big called with ${data?.length || 0} records, currentStep=${currentStep()}`);
    if (!data || data.length === 0) {
      debug("drawMap_Big: No data to draw");
      setMapDataMessage('No map data to display.');
      return;
    }

    const mapInstance = map();
    if (!mapInstance) {
      debug("drawMap_Big: Map is not initialized, cannot draw");
      return;
    }

    if (!mapContainer) {
      debug("drawMap_Big: Map container is not set, cannot draw");
      return;
    }

    const validForMap = data.filter(d => Number.isFinite(d.Lat) && Number.isFinite(d.Lng));
    if (validForMap.length === 0) {
      debug("drawMap_Big: No rows with valid lat/lon; skipping map draw (timeline still has full data)");
      setMapDataMessage('No valid position data (lat/lon) in this dataset. The map cannot be drawn.');
      return;
    }
    setMapDataMessage('');

    // Check if data has Grade values
    const sampleGrades = data.slice(0, 10).map(d => d.Grade);
    debug("drawMap_Big: Sample Grade values:", sampleGrades);
    debug("drawMap_Big: Grade value types:", sampleGrades.map(g => typeof g));
    const uniqueGrades = [...new Set(data.map(d => d.Grade))].filter(g => g !== undefined && g !== null);
    debug("drawMap_Big: Unique Grade values in data:", uniqueGrades);

    const lineData = validForMap.map(value => [value.Lng, value.Lat, value.Datetime, value.Bsp, value.Twa_n, value.Grade, value.Maneuver_type]);

    const gradeColors: { [key: number]: string } = {
        0: "lightgrey",
        1: "red",
        2: "lightgreen",
        3: "green",
        4: "yellow"
    };

    const bounds = new mapboxgl.LngLatBounds();
    lineData.forEach(coord => bounds.extend([coord[0] as number, coord[1] as number]));

    d3.select(".map").style("height", "70%");
    
    // Function to actually draw the lines - called after map is ready
    const drawMapLines = () => {
      const mapInstance = map();
      if (!mapInstance) return;
      d3.select(".map-overlay").remove();
    const container = mapInstance.getContainer();
    const svg = d3.select(container)
        .append("svg")
        .attr("class", "map-overlay")
        .style("position", "absolute")
        .style("top", "0")
        .style("left", "0")
        .style("width", "100%")
        .style("height", "100%");

    const transform = d3.geoTransform({
        point: function (x, y) {
            const point = mapInstance.project(new mapboxgl.LngLat(x, y));
            this.stream.point(point.x, point.y);
        },
    });

    const path = d3.geoPath().projection(transform);
    const g = svg.append("g").attr("class", "line-group");

    let tooltip = d3.select("body").select(".tooltip");

    if (tooltip.empty()) {
      tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("background", "rgba(255,255,255,0.8)")
        .style("border", "1px solid #ccc")
        .style("padding", "5px")
        .style("border-radius", "4px")
        .style("font-size", "12px")
        .style("display", "none");
    }

    // Draw lines and attach event listeners
    g.selectAll(".line")
        .data(lineData.slice(1))
        .enter()
        .append("line")
        .attr("class", "interactive-line")
        .attr("x1", (d, i) => mapInstance.project(new mapboxgl.LngLat(lineData[i][0] as number, lineData[i][1] as number)).x)
        .attr("y1", (d, i) => mapInstance.project(new mapboxgl.LngLat(lineData[i][0] as number, lineData[i][1] as number)).y)
        .attr("x2", (d, i) => mapInstance.project(new mapboxgl.LngLat(d[0] as number, d[1] as number)).x)
        .attr("y2", (d, i) => mapInstance.project(new mapboxgl.LngLat(d[0] as number, d[1] as number)).y)
        .attr("stroke", (d, i) => {
          const grade = d[5]; // Grade is at index 5
          // Ensure grade is a number
          const gradeNum = typeof grade === 'number' ? grade : (typeof grade === 'string' ? parseInt(grade, 10) : 0);
          const color = gradeColors[gradeNum] || "lightgrey";
          if (i < 10) { // Log first 10 to debug
            debug(`drawMap_Big: Line ${i}, Grade=${grade} (type: ${typeof grade}), gradeNum=${gradeNum}, Color=${color}`);
          }
          return color;
        })
        .attr("stroke-width", "2px")
        .attr("stroke-linecap", "round")
        .style("pointer-events", "all")
        .style("opacity", "0.7")
        .on("mousemove", function (event, d) {
            const [Lng, Lat, Datetime, Bsp, Twa_n, Grade] = d;
            tooltip.style("display", "block")
                .html(`
                    <table>
                      <tr><td><b>Datetime:</b></td><td>${formatDateTime(Datetime, getCurrentDatasetTimezone())}</td></tr>
                      <tr><td><b>Bsp:</b></td><td>${Bsp.toFixed(2)}</td></tr>
                      <tr><td><b>Twa_n:</b></td><td>${Twa_n.toFixed(2)}</td></tr>
                      <tr><td><b>Grade:</b></td><td>${Grade}</td></tr>
                    </table>
                `)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 20) + "px");
        })
        .on("mouseout", () => tooltip.style("display", "none"));

    // Add circles and text labels for Maneuver_type values that are single letters
    g.selectAll(".circle")
        .data(data)
        .enter()
        .filter(d => d.Maneuver_type && d.Maneuver_type.length === 1 && /[A-Za-z]/.test(d.Maneuver_type)) // Ensure Maneuver_type exists
        .append("circle")
        .attr("class", "maneuver-circle")
        .attr("cx", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x)
        .attr("cy", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y)
        .attr("r", 3) // Set radius of the circle
        .style("fill", themeStore.isDark() ? "white" : "black")
        .style("opacity", 0.7);

    // Add text labels next to the circles
    g.selectAll(".label")
        .data(data)
        .enter()
        .filter(d => d.Maneuver_type && d.Maneuver_type.length === 1 && /[A-Za-z]/.test(d.Maneuver_type)) // Ensure Maneuver_type exists
        .append("text")
        .attr("class", "maneuver-label")
        .attr("x", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x + 5) // Offset x by 20px
        .attr("y", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y + 5) // Offset y by 20px
        .text(d => d.Maneuver_type) // Use the Maneuver_type as the label text
        .attr("user-select", "none")
        .attr("pointer-events", "none")
        .style("font-size", "14px")
        .style("font-weight", "bold")
        .style("fill", themeStore.isDark() ? "white" : "black");

    const boatIcon = g.append("path")
        .attr("d", "M0 0 L-4 0 L-4 12 L0 28 L4 12 L4 0 Z") // Custom SVG path for the boat icon, flipped and scaled
        .attr("class", "boat-icon")
        .style("fill", themeStore.isDark() ? "white" : "darkblue"); // Set the color of the boat icon based on theme

    function render() {
        const currentMap = map();
        if (!currentMap) return;
        g.selectAll(".interactive-line")
            .attr("x1", (d, i) => currentMap.project(new mapboxgl.LngLat(lineData[i][0] as number, lineData[i][1] as number)).x)
            .attr("y1", (d, i) => currentMap.project(new mapboxgl.LngLat(lineData[i][0] as number, lineData[i][1] as number)).y)
            .attr("x2", (d, i) => currentMap.project(new mapboxgl.LngLat(d[0] as number, d[1] as number)).x)
            .attr("y2", (d, i) => currentMap.project(new mapboxgl.LngLat(d[0] as number, d[1] as number)).y);

        // Reposition circles and labels if the map moves
        g.selectAll(".maneuver-circle")
            .attr("cx", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x)
            .attr("cy", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y);

        g.selectAll(".maneuver-label")
            .attr("x", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x + 5) // Offset x by 20px
            .attr("y", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y + 5); // Offset y by 20px

        // Update boat icon position and rotation (use validForMap so last point has valid coords)
        const lastPoint = validForMap.length > 0 ? validForMap[validForMap.length - 1] : null;
        const point = lastPoint ? currentMap.project(new mapboxgl.LngLat(lastPoint.Lng, lastPoint.Lat)) : null;
        if (lastPoint && point) {
          boatIcon.attr("transform", `translate(${point.x}, ${point.y}) rotate(${lastPoint.Hdg + 180})`); // Rotate based on heading and flip 180 degrees
        }
    }

      // Remove old event handlers before adding new ones
      mapEventHandlers.forEach(({ event, handler }) => {
        mapInstance.off(event, handler);
      });
      mapEventHandlers = [];

      // Add new event handlers and track them
      const renderHandler = () => render();
      const dblClickHandler = () => {
        const currentMap = map();
        if (currentMap) {
          currentMap.fitBounds(bounds, { padding: 30, duration: 0 });
        }
      };
      
      mapInstance.on("viewreset", renderHandler);
      mapInstance.on("move", renderHandler);
      mapInstance.on("moveend", renderHandler);
      mapInstance.on("dblclick", dblClickHandler);
      
      mapEventHandlers.push(
        { event: "viewreset", handler: renderHandler },
        { event: "move", handler: renderHandler },
        { event: "moveend", handler: renderHandler },
        { event: "dblclick", handler: dblClickHandler }
      );

      render();

      // Ensure loading is hidden after rendering
      setShowLoading(false);
    }; // End of drawMapLines function
    
    // Wait for map to be loaded before drawing (mapInstance already declared at function start)
    if (!mapInstance.loaded()) {
      debug("drawMap_Big: Map not loaded yet, waiting for load event");
      
      // Remove any existing load handler to prevent duplicates
      if (mapLoadHandler) {
        mapInstance.off('load', mapLoadHandler);
      }
      
      // Create new load handler
      mapLoadHandler = () => {
        debug("drawMap_Big: Map loaded, drawing lines");
        const currentMap = map();
        if (currentMap) {
          currentMap.resize();
          currentMap.fitBounds(bounds, { padding: 30, duration: 0 });
        }
        drawMapLines();
        mapLoadHandler = null; // Clear after use
      };
      
      mapInstance.once('load', mapLoadHandler);
      return;
    }
    
    mapInstance.resize();
    mapInstance.fitBounds(bounds, { padding: 30, duration: 0 });
    
    // Draw the lines after map is ready
    drawMapLines();
  };

  // Map only: receives full data; we plot only rows with valid lat/lon. Timeline is unchanged.
  const drawMap_Small = (data: ChannelValue[]) => {
    debug(`[Events] drawMap_Small called with ${data?.length || 0} records, currentStep=${currentStep()}`);
    const dataWithCoords = data.filter((d) => Number.isFinite(d.Lat) && Number.isFinite(d.Lng));
    if (!data || data.length === 0) {
      setMapDataMessage('No map data to display.');
      return;
    }

    const mapInstance = map();
    if (!mapInstance) {
      debug(`[Events] drawMap_Small: Map not initialized yet`);
      return;
    }

    if (dataWithCoords.length === 0) {
      debug(`[Events] drawMap_Small: No rows with valid lat/lon; skipping map draw (timeline still has full data)`);
      setMapDataMessage('No valid position data (lat/lon) in this dataset. The map cannot be drawn.');
      return;
    }
    setMapDataMessage('');

    const lineData = dataWithCoords.map((value) => [value.Lng, value.Lat]);

    const bounds = new mapboxgl.LngLatBounds();
    lineData.forEach((coord) => bounds.extend(coord));

    d3.select(".map").style("height", "70%")
    mapInstance.resize()
    mapInstance.fitBounds(bounds, { padding: 30, duration: 0 });

    const filteredData = [];
    let lastTimestamp = null;

    dataWithCoords.forEach((value, index) => {
      const currentTimestamp = new Date(value.Datetime).getTime(); // Convert to timestamp

      if (index === 0 || lastTimestamp === null || currentTimestamp - lastTimestamp >= 30000) {
        filteredData.push(value);
        lastTimestamp = currentTimestamp; // Update last recorded timestamp
      }
    });
    
    // Remove existing overlays to avoid duplication
    d3.select(".map-overlay").remove();

    // Select the map container
    const container = mapInstance.getContainer();
    const svg = d3
      .select(container)
      .append("svg")
      .attr("class", "map-overlay")
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("pointer-events", "none"); // Prevents blocking interaction

    // D3 projection function
    const transform = d3.geoTransform({
      point: function (x, y) {
        const point = mapInstance.project(new mapboxgl.LngLat(x, y));
        this.stream.point(point.x, point.y);
      },
    });

    const path = d3.geoPath().projection(transform);

    const line = {
      type: "LineString",
      coordinates: lineData,
    };

    const g = svg.append("g");

    g.append("path")
      .datum(line)
      .attr("class", "line")
      .style("fill", "none")
      .style("stroke", themeStore.isDark() ? "white" : "darkblue") // Ensures visibility based on theme
      .style("stroke-width", "1px");

    // Add circles every 30 seconds
    g.selectAll(".circle")
      .data(filteredData)
      .enter()
      .append("circle")
      .attr("class", "circle")
      .attr("r", 2)
      .style("fill", themeStore.isDark() ? "white" : "darkblue");

    // Add circles and text labels for Maneuver_type values that are single letters (use dataWithCoords to avoid NaN)
    g.selectAll(".maneuver-circle")
        .data(dataWithCoords)
        .enter()
        .filter(d => d.Maneuver_type && d.Maneuver_type.length === 1 && /[A-Za-z]/.test(d.Maneuver_type)) // Ensure Maneuver_type exists
        .append("circle")
        .attr("class", "maneuver-circle")
        .attr("cx", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x)
        .attr("cy", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y)
        .attr("r", 3) // Set radius of the circle
        .style("fill", themeStore.isDark() ? "white" : "black")
        .style("opacity", 0.7);

    // Add text labels next to the circles
    g.selectAll(".maneuver-label")
        .data(dataWithCoords)
        .enter()
        .filter(d => d.Maneuver_type && d.Maneuver_type.length === 1 && /[A-Za-z]/.test(d.Maneuver_type)) // Ensure Maneuver_type exists
        .append("text")
        .attr("class", "maneuver-label")
        .attr("x", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x + 5) // Offset x by 5px
        .attr("y", d => mapInstance.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y + 5) // Offset y by 5px
        .text(d => d.Maneuver_type) // Use the Maneuver_type as the label text
        .attr("user-select", "none")
        .attr("pointer-events", "none")
        .style("font-size", "14px")
        .style("font-weight", "bold")
        .style("fill", themeStore.isDark() ? "white" : "black");

    // Add custom boat icon
    const boatIcon = g.append("path")
      .attr("d", "M0 0 L-4 0 L-4 12 L0 28 L4 12 L4 0 Z") // Custom SVG path for the boat icon, flipped and scaled
      .attr("class", "boat-icon")
      .style("fill", themeStore.isDark() ? "white" : "darkblue"); // Set the color of the boat icon based on theme

    // Ensure rendering happens only after map moves
    function render() {
      const currentMap = map();
      if (!currentMap) return;
      svg.selectAll("path.line").attr("d", path);

      // Update circles position
      g.selectAll(".circle")
        .attr("cx", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x)
        .attr("cy", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y);

      // Reposition maneuver circles and labels if the map moves
      g.selectAll(".maneuver-circle")
          .attr("cx", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x)
          .attr("cy", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y);

      g.selectAll(".maneuver-label")
          .attr("x", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).x + 5) // Offset x by 5px
          .attr("y", d => currentMap.project(new mapboxgl.LngLat(d.Lng, d.Lat)).y + 5); // Offset y by 5px

      // Update boat icon position and rotation (use dataWithCoords so last point has valid coords)
      const lastPoint = dataWithCoords.length > 0 ? dataWithCoords[dataWithCoords.length - 1] : null;
      const point = lastPoint ? currentMap.project(new mapboxgl.LngLat(lastPoint.Lng, lastPoint.Lat)) : null;
      if (lastPoint && point) {
        boatIcon.attr("transform", `translate(${point.x}, ${point.y}) rotate(${lastPoint.Hdg + 180})`); // Rotate based on heading and flip 180 degrees
      }
    }

    mapInstance.on("viewreset", render);
    mapInstance.on("move", render);
    mapInstance.on("moveend", render);

    // Double-click event to center the map
    mapInstance.on("dblclick", () => {
      const currentMap = map();
      if (currentMap) {
        currentMap.fitBounds(bounds, { padding: 30, duration: 0 });
      }
    });

    // Call render immediately to update the map
    render();
  };

  function eventToKey(ev: Task['Event'], eventType: string): string {
    if (ev && typeof ev === 'object' && 'Race_number' in ev) {
      return `${eventType}-${(ev as { Race_number: number }).Race_number}`;
    }
    return String(ev);
  }

  function initColorScale(tasks: Task[]): d3.ScaleOrdinal<string, string, never> {
    let myOrdinalColor = d3.scaleOrdinal()
    let S20colorScale = d3.scaleOrdinal(d3.schemeSet1)
    const unique_vals = [...new Set(tasks.map(t => eventToKey(t.Event, t.EventType)))]
    let unique_colors = []
  
    let i = 0;
    unique_vals.forEach(function(d) {
        if (d === 'NONE') {
            unique_colors.push("lightgrey") 
        }
        else
        {
            unique_colors.push(S20colorScale(i.toString())) 
        }
  
        i += 1;
    });
  
    myOrdinalColor.domain(unique_vals)
    myOrdinalColor.range(unique_colors) 
  
    return myOrdinalColor
  }

  //GANNT CHART
  const MAX_BAR_RETRIES = 20; // ~2s max wait for chart to appear

  const drawBars = (tasks: Task[], colorScale?: ReturnType<typeof initColorScale> | null, retryCount = 0) => {
    const chartElement = d3.select("#chart");
    const svg = chartElement.select("svg");

    if (svg.empty()) {
      if (tasks.length === 0) return;
      if (retryCount >= MAX_BAR_RETRIES) {
        if (retryCount === MAX_BAR_RETRIES) {
          warn(`[Events] drawBars: SVG not found after ${MAX_BAR_RETRIES} retries, giving up`);
        }
        return;
      }
      if (retryCount === 0) {
        debug(`[Events] drawBars: SVG not found, chart may not be initialized yet. Retrying up to ${MAX_BAR_RETRIES} times...`);
      }
      setTimeout(() => {
        drawBars(tasks, colorScale, retryCount + 1);
      }, 100);
      return;
    }

    // Always clear existing bars so removed events disappear from the timeline
    svg.selectAll('.task-group').remove();
    svg.selectAll('.task').remove();

    if (tasks.length === 0) return;

    if (tasks.length > 0) {
      debug(`[Events] drawBars: Drawing ${tasks.length} task bars`);
      // Use shared scale so timeline and table colors always match
      const cScale = colorScale ?? initColorScale(tasks);

      const width = chartContainer.clientWidth || 600;
      const margin = { top: 10, right: 10, bottom: 20, left: 25 };

      const xExtent = [xRange.min, xRange.max]
      const xScale = d3
        .scaleTime()
        .domain(xExtent)
        .range([0, width - margin.left - margin.right]);

      const taskGroup = svg.selectAll('.task-group')
        .data(tasks)
        .enter().append('g')
        .attr('class', 'task-group')
        .attr("transform", (d) => "translate(25, 0)"); 

      // Append rect to each group
      taskGroup.append('rect')
        .attr('class', 'task')
        .attr('x', d => xScale(d.Start))
        .attr('y', 15)
        .attr('fill', d => cScale(eventToKey(d.Event, d.EventType)))
        .attr('width', d => xScale(d.End) - xScale(d.Start))
        .attr('opacity', "0.5")
        .attr('height', "20px");

      // Append text to each group: use Race_number as label when Event is { Race_number }; otherwise string Event
      taskGroup.append('text')
        .attr('class', 'task-label')
        .attr('x', d => xScale(d.Start) + (xScale(d.End) - xScale(d.Start)) / 2)
        .attr('y', 25) 
        .attr('text-anchor', 'middle') 
        .attr('stroke', themeStore.isDark() ? 'white' : 'darkblue') 
        .attr('dominant-baseline', 'central') 
        .attr('font-size', '12px') 
        .text((d) => (typeof d.Event === 'object' && d.Event && 'Race_number' in d.Event)
          ? String((d.Event as { Race_number: number }).Race_number)
          : String(d.Event)); 

        setProceed(true);
    }
  }

  // Helper function to map channel names to normalized field names
  // Uses default channel names from defaultChannelsStore
  const getNormalizedChannelName = (channelName: string): string => {
    // Get default channel names from store
    const bspDefault = defaultChannelsStore.bspName();
    const twaDefault = defaultChannelsStore.twaName();
    const hdgDefault = defaultChannelsStore.hdgName();
    const twsDefault = defaultChannelsStore.twsName();
    const twdDefault = defaultChannelsStore.twdName();
    
    // Map original channel names (including default names) to normalized field names
    // Normalized names are always: Bsp, Twa_n, Hdg, Tws, Twd
    const channelMap: Record<string, string> = {
      [bspDefault]: 'Bsp',
      [SpeedChannelNames.bspMetric]: 'Bsp',
      [SpeedChannelNames.bspMetric.toLowerCase()]: 'Bsp',
      [SpeedChannelNames.bspKnots]: 'Bsp',
      [SpeedChannelNames.bspKnots.toLowerCase()]: 'Bsp',
      'BSP': 'Bsp',
      // TWA variations
      [twaDefault]: 'Twa_n',
      'Twa_n_deg': 'Twa_n',
      'Twa_deg': 'Twa_n',
      'twa_n_deg': 'Twa_n',
      'twa_deg': 'Twa_n',
      'TWA': 'Twa_n',
      // HDG variations
      [hdgDefault]: 'Hdg',
      'Hdg_deg': 'Hdg',
      'hdg_deg': 'Hdg',
      'HDG': 'Hdg',
      [twsDefault]: 'Tws',
      [SpeedChannelNames.twsMetric]: 'Tws',
      [SpeedChannelNames.twsMetric.toLowerCase()]: 'Tws',
      [SpeedChannelNames.twsKnots]: 'Tws',
      [SpeedChannelNames.twsKnots.toLowerCase()]: 'Tws',
      'TWS': 'Tws',
      // TWD variations
      [twdDefault]: 'Twd',
      'Twd_deg': 'Twd',
      'twd_deg': 'Twd',
      'TWD': 'Twd',
    };
    return channelMap[channelName] || channelName;
  };

  // Minimum container width before drawing; avoid drawing at ~200px when layout isn't ready yet.
  const MIN_CHART_CONTAINER_WIDTH = 400;

  // Timeline/chart: data must be the FULL dataset (all rows). Never pass lat/lon-filtered data here.
  // This data is the same as normalized channel_values (from fetchChannelValues → allValues/values, or processData → pvalues).
  const drawChart = (data: ChannelValue[], channel: string, afterSizeWait?: boolean) => {
    if (!data || data.length === 0) return;

    const containerWidth = chartContainer ? chartContainer.clientWidth : 600;
    if (
      !afterSizeWait &&
      chartContainer &&
      containerWidth < MIN_CHART_CONTAINER_WIDTH
    ) {
      debug(`[Events] drawChart: container width ${containerWidth}px < ${MIN_CHART_CONTAINER_WIDTH}px, deferring until next frame`);
      requestAnimationFrame(() => drawChart(data, channel, true));
      return;
    }

    const normalizedChannel = getNormalizedChannelName(channel);
    const dataSourceName = selectedSourceName();
    debug("[Events] Chart drawing", data.length, "rows from allValues/values/pvalues (same as normalized channel_values)");
    debug("[Events] Timeseries data source (channel-values request):", dataSourceName ?? "(none)");
    // Sample of timeseries data used to draw the chart (first 3 and last 3 rows)
    const sampleSize = 3;
    const getChannelVal = (row: ChannelValue): unknown => {
      const r = row as unknown as Record<string, unknown>;
      return r[normalizedChannel] ?? r[channel];
    };
    const head = data.slice(0, sampleSize).map((row, i) => ({
      source: dataSourceName ?? "(none)",
      index: i,
      Datetime: row.Datetime instanceof Date ? row.Datetime.toISOString() : String(row.Datetime),
      [channel]: getChannelVal(row),
      Lat: row.Lat,
      Lng: row.Lng,
    }));
    const tail = data.slice(-sampleSize).map((row, i) => ({
      source: dataSourceName ?? "(none)",
      index: data.length - sampleSize + i,
      Datetime: row.Datetime instanceof Date ? row.Datetime.toISOString() : String(row.Datetime),
      [channel]: getChannelVal(row),
      Lat: row.Lat,
      Lng: row.Lng,
    }));
    debug("[Events] Timeseries data sample (first 3 rows):", head);
    debug("[Events] Timeseries data sample (last 3 rows):", tail);

    const first = data[0];
    const last = data[data.length - 1];
    debug("[Events] drawChart INPUT first record:", {
      Datetime: first.Datetime,
      DatetimeISO: first.Datetime instanceof Date ? first.Datetime.toISOString() : String(first.Datetime),
      Bsp: first.Bsp,
    });
    debug("[Events] drawChart INPUT last record:", {
      Datetime: last.Datetime,
      DatetimeISO: last.Datetime instanceof Date ? last.Datetime.toISOString() : String(last.Datetime),
      Bsp: last.Bsp,
    });

    // Remove existing chart before redrawing
    d3.select("#chart").select("svg").remove();

    const width = Math.max(containerWidth, 300); // Ensure minimum width (containerWidth from top of function)
    const height = 150;
    const margin = { top: 10, right: 10, bottom: 20, left: 25 };

    // Avoid mutating the original data (SolidJS proxy issue)
    const chartData = data.map(d => ({ ...d, time: new Date(d.Datetime).getTime() }));

    // Segment the data based on the gap threshold
    const gapThreshold = 1000 * 60; // Threshold for gaps (1 minute in milliseconds)
    const segments = [];
    let segment = [];
    chartData.forEach((point, idx) => {
      if (idx === 0 || point.time - chartData[idx - 1].time <= gapThreshold ) {
        segment.push(point);
      } else {
        segments.push(segment); // Add completed segment
        segment = [point]; // Start a new segment
      }
    });

    if (segment.length > 0) {
      segments.push(segment); // Add the last segment
    }
    
    debug(`[Events] drawChart: Created ${segments.length} segments with lengths:`, segments.map(s => s.length));

    const svgContainer = d3
      .select("#chart")
      .append("svg")
      .attr("width", width)
      .attr("height", height);
    
    const svg = svgContainer
      .append("g")
      .attr("transform", `translate(${margin.left}, ${margin.top})`);

    const xExtent = d3.extent(chartData, (d) => d.Datetime)
    debug(`[Events] drawChart: chartData.length=${chartData.length}, xExtent[0]=${xExtent[0]}, xExtent[1]=${xExtent[1]}`);
    if (chartData.length > 0) {
      debug(`[Events] drawChart: First point Datetime=${chartData[0].Datetime}, Last point Datetime=${chartData[chartData.length - 1].Datetime}`);
    }
    const xScale = d3
      .scaleTime()
      .domain(xExtent.map(d => new Date(d)))
      .range([0, width - margin.left - margin.right]);

    setRange({min: xExtent[0] ? new Date(xExtent[0]).getTime() : 0, max: xExtent[1] ? new Date(xExtent[1]).getTime() : 0})

    // Map channel name to normalized field name (already declared earlier in function)
    // Get channel values using normalized field name, with fallback to original channel name
    const getChannelValue = (d: any): number | null => {
      const value = d[normalizedChannel] ?? d[channel];
      if (value === undefined || value === null) return null;
      const numValue = Number(value);
      return isNaN(numValue) ? null : numValue;
    };

    // Filter out null values for domain calculation
    const validValues = chartData
      .map((d) => getChannelValue(d))
      .filter((v): v is number => v !== null && !isNaN(v));

    if (validValues.length === 0) {
      debug(`[Events] drawChart: No valid values for channel ${channel} (normalized: ${normalizedChannel})`);
      return;
    }

    const minValue = d3.min(validValues) || 0;
    const maxValue = d3.max(validValues) || 0;

    const yScale = d3
      .scaleLinear()
      .domain([minValue, maxValue * 1.15])
      .range([height - margin.top - margin.bottom, 0]);

    const line = d3
      .line()
      .x((d) => {
        const date = d['Datetime'];
        if (!date) return NaN;
        const x = xScale(date);
        return isNaN(x) ? NaN : x;
      })
      .y((d) => {
        const value = getChannelValue(d);
        if (value === null || isNaN(value)) return NaN;
        const y = yScale(value);
        return isNaN(y) ? NaN : y;
      })
      .defined((d) => {
        const date = d['Datetime'];
        const value = getChannelValue(d);
        return date !== undefined && date !== null && value !== null && !isNaN(value);
      });

    // Render each segment (draw all segments with 2+ points so timeline shows full range including early data before noon)
    let segment_index = 1;
    segments.forEach((seg) => {
      if (seg.length > 1) {
        debug(`[Events] drawChart: Drawing segment ${segment_index} with ${seg.length} points, first=${seg[0].Datetime}, last=${seg[seg.length-1].Datetime}`);
        svg
          .append("path")
          .datum(seg)
          .attr("class", `line line-${segment_index}`)
          .attr("fill", "none")
          .attr("stroke", themeStore.isDark() ? "white" : "darkblue")
          .attr("stroke-width", 1)
          .attr("d", line);
      } else if (seg.length === 1) {
        const pt = seg[0];
        debug(`[Events] drawChart: Drawing single-point segment ${segment_index} at ${pt.Datetime}`);
        const x = xScale(pt.Datetime);
        const yVal = getChannelValue(pt);
        if (x !== undefined && !isNaN(x) && yVal !== null && !isNaN(yVal)) {
          svg.append("circle")
            .attr("class", `line line-${segment_index}`)
            .attr("cx", x)
            .attr("cy", yScale(yVal))
            .attr("r", 1.5)
            .attr("fill", themeStore.isDark() ? "white" : "darkblue");
        }
      }
      segment_index += 1;
    })

    const tz = getCurrentDatasetTimezone();
    debug(`[Events] drawChart: Using dataset timezone for axis: ${tz}`);
    svg.append("g")
      .attr("class", "axes")
      .attr("transform", `translate(0,${height - margin.top - margin.bottom})`)
      .call(d3.axisBottom(xScale).tickFormat((d) => formatTime(d, tz) ?? String(d)));

    svg.append("g")
      .attr("class", "axes")
      .call(d3.axisLeft(yScale).ticks(3));

    //Add Axis Labels
    svg.append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "left")  
      .attr("transform", "translate(20,20)")  
      .attr("font-size", "14px")
      .text(channel) // Display original channel name for user 

    // Add brushing
    const brush = d3.brushX()
      .extent([[0, 0], [width - margin.left - margin.right, height - margin.top - margin.bottom]])
      .on("brush end", brushed); // Handle both brush and end events

    svg.append("g")
      .attr("class", "brush")
      .call(brush);

    // Redraw bars whenever the chart is recreated (e.g. on Next/Back). The reactive bar effect
    // may run before drawChart, so bars would be drawn on the old SVG then removed. Drawing here
    // ensures bars appear on the new chart after step navigation.
    requestAnimationFrame(() => {
      drawBars(selectedTasks(), eventColorScale());
    });

    function brushed(event: any) {
      if (!event.selection) {
        setStartTimeLocal(undefined);
        setFilteredValues(values());

        if (currentStep() < 5) {
          drawMap_Small(values());
        } else {
          drawMap_Big(pvalues());
        }

        return;
      }

      const [x0, x1] = event.selection.map(xScale.invert);
      const filtered = chartData.filter(d => d.Datetime >= x0 && d.Datetime <= x1);

      setStartTimeLocal(x0);
      setEndTimeLocal(x1);

      if (currentStep() === 1) {
        setStartTime(x0.toISOString())
        setEndTime(x1.toISOString())
      } 

      setFilteredValues(filtered);

      if (currentStep() < 5) {
        drawMap_Small(filtered);
      } else {
        drawMap_Big(filtered);
      }
    }
  };

  const handleTextclick = () => {
  };

  return (
    <>
      <div id='event-container' class="event_container row">
      <Show when={showLoading()}><Loading /></Show>
      <Show when={showWaiting()}>
        <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">Processing Data...</h5>
              </div>
              <div class="modal-body centered">
                <p><b>Please wait:</b> This shouldn't take too long...</p>
                <br />
                <p>Time: {formatSeconds(timeElapsed())}</p>
                <Show when={processingStatusMessage()}>
                  <p class="mt-2 text-sm opacity-90">{processingStatusMessage()}</p>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
      <Show when={showEventsSyncModal()}>
        <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">Updating events...</h5>
              </div>
              <div class="modal-body centered">
                <p><b>Please wait:</b> Saving dataset events.</p>
              </div>
            </div>
          </div>
        </div>
      </Show>
      <Show when={currentStep() == 5 && !showWaiting()}>
        <Show when={!showLoading()}>
          <div class="info w-2/3 pl-5">
              <h1>{getStepContent().title}</h1>
              <p>{getStepContent().description}</p>
          </div>
          <div class="w-1/3 pt-5 pr-5">
            <BackNextButtons onFinalize={handleFinalize} />
          </div>
          <div class="event_map_container w-full p-5"> 
            <Show when={mapDataMessage()}>
              <div class="events-map-message" role="alert">{mapDataMessage()}</div>
            </Show>
            <div id="map" class="map" ref={(el: HTMLDivElement) => mapContainer = el}></div> {/* Map container */}
            <Show when={map() && windData().tws !== undefined && windData().twd !== undefined}>
              {(() => {
                const wind = windData();
                const mapInstance = map();
                const visibleData = pvalues(); // Same data shown on big map
                debug(`[Events] Rendering WindArrow (big map): map=${mapInstance !== null}, visibleData.length=${visibleData.length}, tws=${wind.tws}, twd=${wind.twd}`);
                return (
                  <WindArrow
                    map={mapInstance}
                    maptype="DEFAULT"
                    trackData={visibleData}
                    tws={wind.tws}
                    twd={wind.twd}
                  />
                );
              })()}
            </Show>
            <div id="chart" class="chart" ref={(el: HTMLDivElement) => chartContainer = el}></div> {/* Chart container */}
            <BackButton />
          </div>
        </Show>
      </Show>
      <Show when={currentStep() < 5 && !showLoading()}>
        <div class="w-2/3 pr-5 pl-5">
          <div class="info">
            <h1>{getStepContent().title}</h1>
            <p>{getStepContent().description}</p>
          </div>
          <Show when={mapDataMessage()}>
            <div class="events-map-message" role="alert">{mapDataMessage()}</div>
          </Show>
          <div id="map" class="map" ref={el => mapContainer = el}></div> {/* Map container */}
          <Show when={map() && windData().tws !== undefined && windData().twd !== undefined}>
            {(() => {
              const wind = windData();
              const mapInstance = map();
              const visibleData = values(); // Same data shown on small map
              debug(`[Events] Rendering WindArrow (small map): map=${mapInstance !== null}, visibleData.length=${visibleData.length}, tws=${wind.tws}, twd=${wind.twd}`);
              return (
                <WindArrow
                  map={mapInstance}
                  maptype="DEFAULT"
                  trackData={visibleData}
                  tws={wind.tws}
                  twd={wind.twd}
                />
              );
            })()}
          </Show>
          <div id="chart" class="chart" ref={el => chartContainer = el}></div> {/* Chart container */}
        </div>
        <div class="w-1/3"> 
          <div
            class="table-container"
            role="presentation"
            onKeyDown={(e) => {
              // Stop arrow/Enter/Space from bubbling when from any input (including time input's internal UI)
              const path = e.composedPath ? e.composedPath() : (e.target ? [e.target] : []);
              const fromInput = path.some((node) => node instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
              if (fromInput && (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key))) {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
              }
            }}
          >
            <table id="data_table">
            <Show when={selectedTasks().length > 0}>
              <thead class="thead-dark">
                <tr>
                  {currentStep() === 1 && <th class="head" title="Selection">Selection</th>}
                  {currentStep() === 2 && <th class="head" title="Headsails">Headsails</th>}
                  {currentStep() === 3 && <th class="head" title="Crew Count">Crew Count</th>}
                  {currentStep() === 4 && <th class="head" title="Race_number">Type</th>}

                  <th class="head" title="Event Start Time">Start Time</th>
                  {currentStep() !== 4 && <th class="head" title="Event End Time">End Time</th>}
                  <th class="head" title="Remove">Remove</th>
                </tr>
              </thead>
              <tbody>
                <For each={selectedTasks()}>
                  {(task, index) => {
                    // Get the color for this event from the same scale used for bars
                    const scale = eventColorScale();
                    const eventColor = scale ? scale(eventToKey(task.Event, task.EventType)) : 'transparent';
                    const backgroundColor = eventColor || 'transparent';
                    // Determine text color based on background brightness
                    const getTextColor = (bgColor: string): string => {
                      if (!bgColor || bgColor === 'transparent' || bgColor === 'lightgrey') {
                        return 'var(--color-text-primary)';
                      }
                      // For colored backgrounds, use white text for better contrast
                      return '#ffffff';
                    };
                    const textColor = getTextColor(backgroundColor);
                    const isStep4 = currentStep() === 4;
                    const eventLabel = isStep4 && typeof task.Event === 'object' && task.Event && 'Race_number' in task.Event
                      ? String((task.Event as { Race_number: number }).Race_number)
                      : String(task.Event);
                    return (
                    <tr>
                      <td class="centered">
                        {isStep4 ? (
                          <span class="event-label">{eventLabel}</span>
                        ) : (
                          <input
                            type="text"
                            value={String(task.Event)}
                            style={`text-align: center; width: 70px; background-color: ${backgroundColor}; color: ${textColor};`}
                            onClick={() => handleTextclick()}
                            onChange={(e) => handleTextChange(e, index())}
                            onKeyDown={(e) => e.stopPropagation()}
                          />
                        )}
                      </td>
                      <td class="centered">
                        <input
                          type="time"
                          step="1"
                          value={task.Start ? (formatTime(task.Start, getCurrentDatasetTimezone()) ?? "") : ""}
                          onChange={(e) => handleTimeChange(e, index(), 'Start')}
                          onKeyDown={(e) => e.stopPropagation()}
                          readOnly={false}
                        />
                      </td>
                      {currentStep() !== 4 && (
                      <td class="centered">
                        <input
                          type="time"
                          step="1"
                          value={task.End ? (formatTime(task.End, getCurrentDatasetTimezone()) ?? "") : ""}
                          onChange={(e) => handleTimeChange(e, index(), 'End')}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                      </td>
                      )}
                      <td class="centered">
                        <button
                          type="button"
                          class="btn btn-danger"
                          onClick={() => removeEvent(index())}
                        >
                          X
                        </button>
                      </td>
                    </tr>
                    );
                  }}
                </For>
              </tbody>
              </Show>
            </table>
          </div>
          <div class="button-container">
            <BackNextButtons />
            <BackButton />
          </div>
        </div>
      </Show>
      </div>
    </>
  );
}
