import { createSignal, createEffect, onMount, onCleanup, Show, createMemo } from "solid-js";
import Map from "../../../../components/charts/Map";
import LoadingOverlay from "../../../../components/utilities/Loading";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { selectedTime, setSelectedTime, requestTimeControl, releaseTimeControl, timeWindow, setTimeWindow } from "../../../../store/playbackStore";
import { persistantStore } from "../../../../store/persistantStore";
const { selectedClassName, selectedProjectId, selectedDate } = persistantStore;
import { debug } from "../../../../utils/console";
import { waitForPaint } from "../../../../utils/waitForRender";
import * as d3 from "d3";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { getData, getTimezoneForDate } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";
import { setRaceOptions, setIsTrainingHourMode, selectedSources as filterStoreSelectedSources, setSelectedSources as filterStoreSetSelectedSources, raceOptions, selectedRacesTimeseries, isTrainingHourMode } from "../../../../store/filterStore";
import { sourcesStore } from "../../../../store/sourcesStore";

interface FleetMapProps {
  objectName?: string;
  [key: string]: any;
}

/** Selected boat source IDs derived from filterStore so selection is shared with FleetTimeSeries and FleetVideo. */
function selectedBoatIdsFromFilterStore(): Set<number> {
  const names = filterStoreSelectedSources();
  if (!sourcesStore.isReady() || !Array.isArray(names) || names.length === 0) return new Set();
  const sources = sourcesStore.sources();
  const ids = new Set<number>();
  for (const name of names) {
    const n = String(name).trim().toLowerCase();
    const s = sources.find((x) => String(x.source_name).trim().toLowerCase() === n);
    if (s && Number.isFinite(Number(s.source_id))) ids.add(Number(s.source_id));
  }
  return ids;
}

export default function MapComponent(props: FleetMapProps) {
  const [isLoading, setIsLoading] = createSignal<boolean>(true);
  /** Selected boat source IDs from filterStore (shared with FleetTimeSeries and FleetVideo) — which sources are *enabled* in timeseries settings. */
  const selectedBoatIds = createMemo(selectedBoatIdsFromFilterStore);
  /** Boat(s) selected on the map for highlight (thick 3px track). Distinct from "enabled" — only these get thick line. */
  const [highlightedBoatIds, setHighlightedBoatIds] = createSignal<Set<number>>(new Set());
  /** Track if we've checked for data availability (declared early so createEffect below can use it) */
  const [hasCheckedData, setHasCheckedData] = createSignal(false);
  const [hasNoData, setHasNoData] = createSignal(false);
  /** Map click: toggle highlight (3px). Click to add/remove boat from highlight; multiple boats can be highlighted. Do NOT change enable/disable — that is done in TimeSeries settings. */
  const onToggleBoatSelection = (sourceId: number) => {
    const current = highlightedBoatIds();
    if (current.has(sourceId)) {
      const next = new Set(current);
      next.delete(sourceId);
      setHighlightedBoatIds(next);
    } else {
      setHighlightedBoatIds(new Set([...current, sourceId]));
    }
  };
  let hasInitializedTime = false;
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  let lastDate: string | null = null;
  const SESSION_STORAGE_KEY = 'fleetmap_timeWindow';
  const DEFAULT_TIME_WINDOW = 2; // 2 minutes

  // Check if timeline is drawn (has SVG with x-axis)
  const isTimelineDrawn = () => {
    try {
      const chartContainer = document.querySelector('.map-container .chart-container');
      if (!chartContainer) return false;
      
      const svg = d3.select(chartContainer).select('svg');
      if (svg.empty()) return false;
      
      const xAxisGroup = svg.select('.x-axis');
      if (xAxisGroup.empty()) return false;
      
      // Check if axis has ticks (indicating it's fully drawn)
      const ticks = xAxisGroup.selectAll('.tick');
      return !ticks.empty();
    } catch (error: unknown) {
      return false;
    }
  };

  // Get minimum time from data
  const getMinTimeFromData = async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    
    if (!className || !projectId || !date) {
      return null;
    }

      try {
        const ymd = String(date).replace(/[-/]/g, '');
        const selectedSourceIds = selectedBoatIdsFromFilterStore();
        if (selectedSourceIds.size > 0) {
          debug('FleetMap: Using selected sources for min time calculation', { count: selectedSourceIds.size, ids: Array.from(selectedSourceIds) });
        }
        const mapData = await unifiedDataStore.fetchMapDataForDay(className, Number(projectId), ymd, selectedSourceIds.size > 0 ? selectedSourceIds : undefined);
      
      if (!mapData || mapData.length === 0) {
        return null;
      }

      let minTime = Infinity;
      for (const point of mapData) {
        const timestamp = point.Datetime || point.timestamp || point.time || point.datetime;
        if (timestamp) {
          const time = new Date(timestamp).getTime();
          if (!isNaN(time) && time < minTime) {
            minTime = time;
          }
        }
      }

      if (Number.isFinite(minTime)) {
        return minTime;
      }
    } catch (error: unknown) {
      debug('FleetMap: Error fetching min time from data', error as any);
    }
    
    return null;
  };

  // Function to initialize selectedTime after timeline is drawn
  const initializeTimeFromTimeline = async () => {
    if (hasInitializedTime) return;

    // First check if timeline is drawn
    if (!isTimelineDrawn()) {
      return; // Timeline not ready yet
    }

    // Get minimum time from data
    const minTime = await getMinTimeFromData();
    if (minTime === null) {
      return; // Data not ready yet
    }

    // Initialize timeWindow from session storage or default. When no races (training-only), default to 1 min and never use 0 (Full).
    const noRaces = isTrainingHourMode();
    const defaultWindow = noRaces ? 1 : DEFAULT_TIME_WINDOW;
    const savedTimeWindow = sessionStorage.getItem(SESSION_STORAGE_KEY);
    let initialTimeWindow = savedTimeWindow ? parseFloat(savedTimeWindow) : defaultWindow;
    if (noRaces && (initialTimeWindow === 0 || !Number.isFinite(initialTimeWindow))) {
      initialTimeWindow = 1;
    }
    setTimeWindow(initialTimeWindow);
    debug('FleetMap: Initialized timeWindow', { value: initialTimeWindow, fromStorage: !!savedTimeWindow, noRaces });

    // Timeline is drawn and data is available - wait for simple paint before hiding loading
    // Use simple paint detection to avoid blocking UI
    waitForPaint(2).then(() => {
      debug('FleetMap: Paint complete, hiding loading overlay');
      setIsLoading(false);
    }).catch((error) => {
      debug('FleetMap: Error waiting for paint, hiding loading anyway:', error);
      setIsLoading(false);
    });

    // Check if selectedTime is at default or very close to minimum
    const currentTime = selectedTime();
    const defaultTime = new Date('1970-01-01T12:00:00Z');
    const isDefault = currentTime.getTime() === defaultTime.getTime();
    
    // Check if current time is at or very close to minimum (within 10 seconds)
    const timeDiff = Math.abs(currentTime.getTime() - minTime);
    const isAtMinTime = timeDiff < 10000;

    // Only set if it's default or at minimum time
    if (isDefault || isAtMinTime) {
      const windowMs = initialTimeWindow * 60 * 1000;
      const targetTime = new Date(minTime + windowMs);

      if (requestTimeControl('fleetmap')) {
        debug('FleetMap: Setting selectedTime from timeline domain to minimum + time window', {
          minTime: new Date(minTime).toISOString(),
          currentTime: currentTime.toISOString(),
          targetTime: targetTime.toISOString(),
          isDefault,
          isAtMinTime
        });
        setSelectedTime(targetTime, 'fleetmap');
        hasInitializedTime = true;
        setTimeout(() => {
          releaseTimeControl('fleetmap');
        }, 100);
      }
    } else {
      // Check if it's already at our target
      const windowMs = initialTimeWindow * 60 * 1000;
      const targetDiff = Math.abs(currentTime.getTime() - (minTime + windowMs));
      if (targetDiff < 10000) {
        hasInitializedTime = true;
      }
    }
  };

  // Set timezone when date changes (similar to MapTimeSeries)
  // For fleet mode, we use the timezone from the first dataset for that date
  // In practice, all datasets for the same date/project should have the same timezone
  createEffect(async () => {
    debug('🕐 FleetMap: Timezone effect triggered');
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    
    debug('🕐 FleetMap: Timezone effect values', {
      className,
      projectId,
      date,
      hasValues: !!(className && projectId && date)
    });
    
    if (!className || !projectId || !date) {
      debug('🕐 FleetMap: Missing values, clearing timezone');
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
        debug('🕐 FleetMap: Timezone set from date endpoint', {
          datasetId: datasetId,
          timezone: tz,
          date: date
        });
        debug('FleetMap: Set timezone from date endpoint (representative for fleet)', {
          datasetId: datasetId,
          timezone: tz
        });
      } else {
        // No timezone found for this date, clear timezone
        debug('🕐 FleetMap: No timezone found for date', { date });
        await setCurrentDataset(className, projectId, null);
      }
    } catch (error: unknown) {
      debug('FleetMap: Error setting timezone', error as any);
      await setCurrentDataset(className, projectId, null);
    }
  });

  // Don't load races here - MapContainer will load them when it mounts
  // We just check if they exist. This avoids conflicts and render cycles.

  // Watch for date changes to reset initialization
  createEffect(() => {
    const currentDate = selectedDate();
    if (currentDate !== lastDate) {
      lastDate = currentDate;
      hasInitializedTime = false; // Reset when date changes
      setIsLoading(true); // Show loading when date changes
      setHasCheckedData(false); // Reset data check when date changes
      setHasNoData(false); // Reset no data state when date changes
      debug('FleetMap: Date changed, resetting time initialization');
    }
  });

  // Poll for timeline to be ready and initialize time
  onMount(() => {
    let attempts = 0;
    const maxAttempts = 50; // Try for up to 5 seconds (50 * 100ms)
    
    checkInterval = setInterval(() => {
      attempts++;
      
      if (hasInitializedTime) {
        if (checkInterval) {
          clearInterval(checkInterval);
        }
        return;
      }
      
      if (attempts > maxAttempts) {
        debug('FleetMap: Max attempts reached waiting for timeline');
        setIsLoading(false); // Hide loading even if timeline didn't initialize
        if (checkInterval) {
          clearInterval(checkInterval);
        }
        return;
      }

      // Try to initialize from timeline (async, but we don't await it)
      initializeTimeFromTimeline().catch((error: unknown) => {
        debug('FleetMap: Error in initializeTimeFromTimeline', error as any);
        setIsLoading(false); // Hide loading on error
      });
    }, 100); // Check every 100ms
  });

  onCleanup(() => {
    if (checkInterval) {
      clearInterval(checkInterval);
    }
  });

  // Track whether we've fetched races for the current date and if any exist
  // (We fetch directly instead of relying on filterStore.raceOptions, which MapContainer
  // clears on mount before its async fetch completes, causing a false "Multi-Map Not Available".)
  const [hasCheckedRacesForDate, setHasCheckedRacesForDate] = createSignal(false);
  const [hasRacesForDate, setHasRacesForDate] = createSignal(false);

  createEffect(() => {
    const date = selectedDate();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!date || !className || !projectId) {
      setHasCheckedRacesForDate(false);
      setHasRacesForDate(false);
      setIsTrainingHourMode(false);
      return;
    }

    setHasCheckedRacesForDate(false);
    setHasRacesForDate(false);
    setIsTrainingHourMode(false);

    // Preload events for the day into agg.events so MapSettings sees races/legs (non-blocking)
    const dateStrNorm = String(date).length === 8 && !String(date).includes('-')
      ? `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}`
      : String(date);
    unifiedDataStore.preloadEventsForDate(className, Number(projectId), dateStrNorm).catch(() => {});

    let cancelled = false;
    const dateStr = dateStrNorm;
    getTimezoneForDate(className, Number(projectId), dateStr).then((timezone) => {
      let racesUrl = `${apiEndpoints.app.datasets}/date/races?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}`;
      if (timezone) racesUrl += `&timezone=${encodeURIComponent(timezone)}`;
      return getData(racesUrl);
    })
      .then((racesResp: { data?: unknown[]; [key: string]: unknown }) => {
        if (cancelled) return;
        const racesList = (racesResp && (racesResp.data || racesResp)) || [];
        const hasHour = Array.isArray(racesList) && racesList.some((r: { HOUR?: number | null; [key: string]: unknown }) => r?.HOUR !== undefined && r?.HOUR !== null);
        if (hasHour) {
          // Training bins by hour: use HOUR as the option key (same as Training Summary)
          const hourKeys = (racesList as { HOUR?: number; Race_number?: number; [key: string]: unknown }[])
            .map((r) => (r?.HOUR != null ? String(r.HOUR) : r?.Race_number != null ? String(r.Race_number) : null))
            .filter((k): k is string => k != null && k !== "");
          const uniqueHours = [...new Set(hourKeys)].sort((a, b) => Number(a) - Number(b));
          setHasRacesForDate(uniqueHours.length > 0);
          setHasCheckedRacesForDate(true);
          setIsTrainingHourMode(true);
          if (uniqueHours.length > 0) {
            setRaceOptions(uniqueHours);
          }
        } else {
          const extracted = racesList.map((r: { race_number?: number; Race_number?: number; racenumber?: number; RaceNumber?: number; [key: string]: unknown }) => {
            const raceNum = r.race_number ?? r.Race_number ?? r.racenumber ?? r.RaceNumber ?? r['Race_number'] ?? r.raceNumber;
            if (raceNum === -1 || raceNum === '-1') return 'TRAINING';
            return Number(raceNum);
          }).filter((n: unknown) => n === 'TRAINING' || (typeof n === 'number' && Number.isFinite(n) && n >= -1));
          const uniqueRaces = [...new Set(extracted)].sort((a: unknown, b: unknown) => {
            if (a === 'TRAINING') return -1;
            if (b === 'TRAINING') return 1;
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
          }) as (number | string)[];
          setHasRacesForDate(uniqueRaces.length > 0);
          setHasCheckedRacesForDate(true);
          setIsTrainingHourMode(false);
          if (uniqueRaces.length > 0) {
            setRaceOptions(uniqueRaces.map((r) => (typeof r === 'number' ? String(r) : r)));
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        debug('FleetMap: Error fetching races for date', error as any);
        setHasCheckedRacesForDate(true);
        setHasRacesForDate(false);
        setIsTrainingHourMode(false);
      });

    return () => {
      cancelled = true;
    };
  });

  // Show "no races" only after we've checked and confirmed no races for this date
  const shouldShowNoRaces = createMemo(() => {
    return hasCheckedRacesForDate() && !hasRacesForDate();
  });

  const hasRaces = createMemo(() => hasRacesForDate());

  // Check for data availability after map has finished loading (re-run when selection, race options, or selected hour change)
  createEffect(async () => {
    const loading = isLoading();
    const date = selectedDate();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    selectedBoatIds(); // track filterStore selection so we re-check when user changes sources
    // Re-run when race options are set (e.g. date/races loaded for training hours) so we don't show "no data" before data is ready
    const options = raceOptions && raceOptions();
    // Re-run when selected hour/race changes so we re-check and clear stale no-data state
    selectedRacesTimeseries && selectedRacesTimeseries();

    // Only check when loading is complete and we have the necessary info
    if (loading || !date || !className || !projectId) {
      setHasCheckedData(false);
      setHasNoData(false);
      return;
    }

    // Reset no-data state when selection/options change so we don't show stale overlay while re-checking
    setHasNoData(false);

    // Wait a bit for the map to fully render and for date/races to set options before checking
    const timeout = setTimeout(async () => {
      try {
        const ymd = String(date).replace(/[-/]/g, '');
        const selectedSourceIds = selectedBoatIdsFromFilterStore();
        const mapData = await unifiedDataStore.fetchMapDataForDay(className, Number(projectId), ymd, selectedSourceIds.size > 0 ? selectedSourceIds : undefined);
        
        // Check if there's no data
        if (!mapData || mapData.length === 0) {
          setHasNoData(true);
        } else {
          setHasNoData(false);
        }
        setHasCheckedData(true);
      } catch (error: unknown) {
        debug('FleetMap: Error checking data availability', error as any);
        setHasCheckedData(true);
        setHasNoData(false); // Don't show "no data" on error
      }
    }, 1000); // Wait 1 second after loading completes

    return () => clearTimeout(timeout);
  });

  // Show "no data" only when options are ready, we've checked, and there's no data.
  // Never show in training-hour mode: we removed hour filtering so full-day data is shown; the "no data" path was for race filtering and can wrongly hide when data exists.
  const shouldShowNoData = createMemo(() => {
    if (isTrainingHourMode()) return false;
    const optionsReady = raceOptions && raceOptions().length > 0;
    return optionsReady && hasRaces() && !isLoading() && hasCheckedData() && hasNoData();
  });

  // Watch for timeWindow changes and save to session storage
  createEffect(() => {
    const currentTimeWindow = timeWindow();
    // Only save if we've initialized (to avoid saving during initialization)
    if (hasInitializedTime) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, currentTimeWindow.toString());
      debug('FleetMap: Saved timeWindow to session storage', { value: currentTimeWindow });
    }
  });

  return (
    <div style="position: relative; width: 100%; height: 100%;">
      <Show when={shouldShowNoRaces()}>
        <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; background: var(--color-bg-card);">
          <div style="text-align: center; padding: 2rem;">
            <h2 style="font-size: 1.5rem; margin-bottom: 1rem; color: var(--color-text-primary);">
              Multi-Map Not Available
            </h2>
            <p style="font-size: 1rem; color: var(--color-text-secondary);">
              Multi-Map requires race data to function. No races are available for the selected date.
            </p>
          </div>
        </div>
      </Show>
      <Show when={!shouldShowNoRaces()}>
        <Show when={isLoading()}>
          <LoadingOverlay message="Loading map data..." />
        </Show>
        <Show when={shouldShowNoData()}>
          <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.3); z-index: 1000; pointer-events: none;">
            <div style="text-align: center; padding: 2rem; background: var(--color-bg-card); border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); pointer-events: auto;">
              <h2 style="font-size: 1.5rem; margin-bottom: 1rem; color: var(--color-text-primary);">
                No Data Available
              </h2>
              <p style="font-size: 1rem; color: var(--color-text-secondary);">
                No data is available for the selected date and sources.
              </p>
            </div>
          </div>
        </Show>
        <Map objectName={props?.objectName} sourceMode={'multi'} selectedBoatIds={highlightedBoatIds()} onToggleBoatSelection={onToggleBoatSelection} />
      </Show>
    </div>
  );
}
