import { createSignal, onMount, onCleanup, Show, createEffect, untrack, on, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import LoadingOverlay from "../../../../components/utilities/Loading";
import TimeSeries from "../../../../components/charts/TimeSeries";
import PlaybackTimeSeries from "../../../../components/charts/PlaybackTimeSeries";
import TimeSeriesSettings from "../../../../components/menus/TimeSeriesSettings";

import { user } from "../../../../store/userStore"; 
import { persistantStore } from "../../../../store/persistantStore";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedPage, setSelectedPage, selectedDate } = persistantStore;
import { sourcesStore } from "../../../../store/sourcesStore";

import { getData, getTimezoneForDate, setupMediaContainerScaling } from "../../../../utils/global";
import { sortRaceValues } from "../../../../utils/raceValueUtils";
import { apiEndpoints } from "@config/env";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { warn, error as logError, debug, data as logData } from "../../../../utils/console";
import { logPageLoad } from "../../../../utils/logging";
import { registerSelectionStoreCleanup, cutEvents, isCut, selectedRange } from "../../../../store/selectionStore";
import { selectedStatesTimeseries, selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries, setSelectedRacesTimeseries, setSelectedLegsTimeseries, setSelectedGradesTimeseries, setHasChartsWithOwnFilters, selectedSources as filterStoreSelectedSources, setSelectedSources as filterStoreSetSelectedSources } from "../../../../store/filterStore";
import { selectedTime, timeWindow, getDisplayWindowReferenceTime, isPlaying } from "../../../../store/playbackStore";
import { applyDataFilter } from "../../../../utils/dataFiltering";
import { bucketAggregateForLineType } from "../../../../utils/timeseriesSeriesTransforms";
import type { ChannelBucketAggregate } from "../../../../store/unifiedDataAPI";
import UnifiedFilterService from "../../../../services/unifiedFilterService";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import { persistentSettingsService } from "../../../../services/persistentSettingsService";
import { sidebarMenuRefreshTrigger } from "../../../../store/globalStore";
import { huniDBStore } from "../../../../store/huniDBStore";
import { TableNames, escapeTableName } from "../../../../store/huniDBTypes";

interface FleetTimeSeriesPageProps {
  objectName?: string;
  /** When true, we are in split view (from Dashboard). */
  isInSplitView?: boolean;
  /** When in split view as right panel: menu name of the left panel (e.g. "MAP"). */
  mainPanelMenu?: string | null;
  /** When in split view as left panel: menu name of the right panel. */
  rightPanelMenu?: string | null;
  [key: string]: any;
}

/** Event time range - source_id is used in fleet mode to match data points to their source */
type EventTimeRange = { start: number; end: number; source_id?: number };

/** Min/max x from chart config points; used for x-axis when race/leg filters are on but IndexedDB event ranges are empty. */
function extentFromFleetChartConfig(config: unknown[] | null | undefined): { start: Date; end: Date } | undefined {
  if (!Array.isArray(config) || config.length === 0) return undefined;
  let min = Infinity;
  let max = -Infinity;
  for (const chart of config) {
    const series = (chart as { series?: unknown[] })?.series;
    if (!Array.isArray(series)) continue;
    for (const s of series) {
      const data = (s as { data?: unknown[] })?.data;
      if (!Array.isArray(data)) continue;
      for (const pt of data) {
        const p = pt as { x?: Date | number | string };
        const x = p?.x;
        const t =
          x instanceof Date
            ? x.getTime()
            : x != null && x !== ""
              ? new Date(x as string | number).getTime()
              : NaN;
        if (!Number.isFinite(t)) continue;
        if (t < min) min = t;
        if (t > max) max = t;
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (min === max) {
    const pad = 60_000;
    return { start: new Date(min - pad), end: new Date(max + pad) };
  }
  return { start: new Date(min), end: new Date(max) };
}

export default function FleetTimeSeriesPage(props: FleetTimeSeriesPageProps) {
  debug('🕐 TimeSeriesPage: Component initialized');
  debug('🕐 TimeSeriesPage: Props received:', props);

  const objectName = (): string => props?.objectName || selectedPage() || 'default';
  debug('🕐 TimeSeriesPage: Object name resolved to:', objectName());

  /** True when Fleet Map is visible (split view with Map in the other panel). When false, use full time window. */
  const isMapVisible = createMemo(() => {
    if (!props.isInSplitView) return false;
    const main = String(props.mainPanelMenu ?? "").trim().toUpperCase();
    const right = String(props.rightPanelMenu ?? "").trim().toUpperCase();
    return main === "MAP" || main === "OVERLAY" || right === "MAP" || right === "OVERLAY";
  });
  /** Time window in minutes; 0 when map is not visible so the chart uses full range. */
  const effectiveTimeWindow = createMemo(() => (isMapVisible() ? timeWindow() : 0));

  // Initialize navigation
  let navigate: ((path: string) => void) | null;
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // If useNavigate fails (e.g., in split view), set navigate to null
    navigate = null;
  }

  // Source selection from filterStore (shared with FleetMap and FleetVideo)
  const selectedSources = createMemo(() => {
    const names = filterStoreSelectedSources();
    if (!sourcesStore.isReady() || !Array.isArray(names)) return new Set<number>();
    const sources = sourcesStore.sources();
    const ids = new Set<number>();
    for (const name of names) {
      const n = String(name).trim().toLowerCase();
      const s = sources.find((x) => String(x.source_name).trim().toLowerCase() === n);
      if (s && Number.isFinite(Number(s.source_id))) ids.add(Number(s.source_id));
    }
    return ids;
  });

  // Store sources with their dataset_ids for event querying
  const [currentSources, setCurrentSources] = createSignal<Array<{ source_id: number; source_name: string; dataset_id: number }>>([]);

  // Race and leg filter state
  const [raceOptions, setRaceOptions] = createSignal<(number | string)[]>([]);
  const [legOptions, setLegOptions] = createSignal<number[]>([]);
  const [gradeOptions, setGradeOptions] = createSignal<number[]>([]);

  // Signal to store event time ranges for race/leg filtering
  const [eventTimeRanges, setEventTimeRanges] = createSignal<EventTimeRange[]>([]);
  const [raceTimeRanges, setRaceTimeRanges] = createSignal<EventTimeRange[]>([]);
  const [legTimeRanges, setLegTimeRanges] = createSignal<EventTimeRange[]>([]);

  // Toggle handlers for filters
  const toggleRaceFilter = (race: number | string) => {
    const current = selectedRacesTimeseries();
    const raceStr = String(race);
    if (current.includes(raceStr)) {
      setSelectedRacesTimeseries(current.filter(r => r !== raceStr));
    } else {
      setSelectedRacesTimeseries([...current, raceStr]);
    }
  };

  const toggleLegFilter = (leg: number) => {
    const current = selectedLegsTimeseries();
    const legStr = String(leg);
    if (current.includes(legStr)) {
      setSelectedLegsTimeseries(current.filter(l => l !== legStr));
    } else {
      setSelectedLegsTimeseries([...current, legStr]);
    }
  };

  const toggleGradeFilter = (grade: number) => {
    const current = selectedGradesTimeseries();
    const gradeStr = String(grade);
    if (current.includes(gradeStr)) {
      setSelectedGradesTimeseries(current.filter(g => g !== gradeStr));
    } else {
      setSelectedGradesTimeseries([...current, gradeStr]);
    }
  };

  // Build dataSourcesOptions from sourcesStore for TimeSeriesSettings (reads/writes filterStore for persistence across FleetMap/FleetVideo)
  const dataSourcesOptions = createMemo(() => {
    if (!sourcesStore.isReady()) {
      return [];
    }
    const projectSources = sourcesStore.sources();
    if (!projectSources || projectSources.length === 0) {
      return [];
    }
    return projectSources
      .map((s) => {
        const id = Number(s.source_id);
        if (!Number.isFinite(id)) return null;
        const name = s.source_name || "";
        const getter = () => {
          const names = filterStoreSelectedSources();
          return Array.isArray(names) && names.some((n) => String(n).trim().toLowerCase() === name.trim().toLowerCase());
        };
        const setter = (value: boolean) => {
          const current = filterStoreSelectedSources();
          const arr = Array.isArray(current) ? [...current] : [];
          const norm = name.trim().toLowerCase();
          const idx = arr.findIndex((n) => String(n).trim().toLowerCase() === norm);
          if (value) {
            if (idx === -1) arr.push(name);
          } else {
            if (idx !== -1) arr.splice(idx, 1);
          }
          filterStoreSetSelectedSources(arr);
        };
        return {
          key: `source-${id}`,
          label: name || `Source ${id}`,
          type: "toggle" as const,
          signal: [getter, setter] as [() => boolean, (value: boolean) => void]
        };
      })
      .filter((opt): opt is NonNullable<typeof opt> => opt !== null);
  });

  // Preload events for the day into agg.events so TimeSeriesSettings sees races/legs (non-blocking)
  createEffect(() => {
    const date = selectedDate();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!date || !className || !projectId || String(date).trim() === "") return;
    const dateStrNorm =
      String(date).length === 8 && !String(date).includes("-")
        ? `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}`
        : String(date);
    unifiedDataStore.preloadEventsForDate(className, Number(projectId), dateStrNorm).catch(() => {});
  });

  // Load saved source preferences on mount
  createEffect(async () => {
    const currentUser = user();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (!currentUser?.user_id || !className || !projectId) return;
    
    try {
      const savedSettings = await persistentSettingsService.loadSettings(
        currentUser.user_id,
        className,
        projectId
      );
      
      if (savedSettings?.fleetPerformanceSources && Array.isArray(savedSettings.fleetPerformanceSources) && savedSettings.fleetPerformanceSources.length > 0) {
        filterStoreSetSelectedSources(savedSettings.fleetPerformanceSources);
        debug('🕐 FleetTimeSeries: Loaded saved source selections into filterStore', { count: savedSettings.fleetPerformanceSources.length, sources: savedSettings.fleetPerformanceSources });
      }
    } catch (error) {
      debug('🕐 FleetTimeSeries: Error loading saved source preferences', error);
    }
  });

  // Chart configuration and data state
  const [chartConfig, setChartConfig] = createSignal<any[] | null>(null);
  const [originalChartConfig, setOriginalChartConfig] = createSignal<any[] | null>(null); // Store unfiltered data
  const [isLoading, setIsLoading] = createSignal<boolean>(true);

  // Dataset event time range for x-scale limiting (min start, max end from all selected sources)
  const [datasetEventTimeRange, setDatasetEventTimeRange] = createSignal<{ start: Date; end: Date } | null>(null);

  let lastEffectiveXRangeDebug = 0;
  // Effective x-range for TimeSeries: full data range during playback so internal time-window effect
  // can drive domain via xZoom.domain() + redraw() (same as wheel pan). When not playing, use
  // brush/windowed/event range so x-scale matches visible window.
  const effectiveXRange = createMemo(() => {
    const ranges = eventTimeRanges();
    const fullRange = datasetEventTimeRange();
    const brushRange = selectedRange();
    const winMin = effectiveTimeWindow();
    const playing = isPlaying();
    const cfg = chartConfig();
    const raceOrLegFilter =
      selectedRacesTimeseries().length > 0 || selectedLegsTimeseries().length > 0;

    if (brushRange.length === 1 && brushRange[0]?.start_time && brushRange[0]?.end_time) {
      const out = { start: new Date(brushRange[0].start_time), end: new Date(brushRange[0].end_time) };
      if (Date.now() - lastEffectiveXRangeDebug >= 500) {
        lastEffectiveXRangeDebug = Date.now();
        debug('⏰ FleetTimeSeries effectiveXRange', { source: 'brush', playing, winMin, range: out });
      }
      return out;
    }

    // Race/leg filters: drive x-axis from event spans or filtered points. Must run before the
    // map time-window slice (winMin > 0 && !playing) or the chart stays on the wrong domain.
    if (raceOrLegFilter) {
      if (ranges.length > 0) {
        const minStart = Math.min(...ranges.map((r) => r.start));
        const maxEnd = Math.max(...ranges.map((r) => r.end));
        const out = { start: new Date(minStart), end: new Date(maxEnd) };
        if (Date.now() - lastEffectiveXRangeDebug >= 500) {
          lastEffectiveXRangeDebug = Date.now();
          debug('⏰ FleetTimeSeries effectiveXRange', {
            source: "eventTimeRanges",
            playing,
            winMin,
            range: { start: out.start.toISOString(), end: out.end.toISOString() },
          });
        }
        return out;
      }
      const dataExt = extentFromFleetChartConfig(cfg);
      if (dataExt) {
        if (Date.now() - lastEffectiveXRangeDebug >= 500) {
          lastEffectiveXRangeDebug = Date.now();
          debug('⏰ FleetTimeSeries effectiveXRange', {
            source: "filteredDataExtent",
            playing,
            winMin,
            range: { start: dataExt.start.toISOString(), end: dataExt.end.toISOString() },
          });
        }
        return dataExt;
      }
    }

    // During playback, return full range so TimeSeries internal effect can drive the window
    if (winMin > 0 && playing && fullRange) {
      const out = { start: fullRange.start, end: fullRange.end };
      if (Date.now() - lastEffectiveXRangeDebug >= 500) {
        lastEffectiveXRangeDebug = Date.now();
        debug('⏰ FleetTimeSeries effectiveXRange', { source: 'playingFullRange', playing, winMin, range: { start: out.start.toISOString(), end: out.end.toISOString() } });
      }
      return out;
    }

    // Only call getDisplayWindowReferenceTime when NOT playing (avoids ~10fps memo re-runs)
    if (winMin > 0 && !playing) {
      const center = getDisplayWindowReferenceTime();
      if (center) {
        const windowMs = winMin * 60 * 1000;
        const out = {
          start: new Date(center.getTime() - windowMs / 2),
          end: new Date(center.getTime() + windowMs / 2)
        };
        if (Date.now() - lastEffectiveXRangeDebug >= 500) {
          lastEffectiveXRangeDebug = Date.now();
          debug('⏰ FleetTimeSeries effectiveXRange', { source: 'timeWindowCenter', playing, winMin, range: { start: out.start.toISOString(), end: out.end.toISOString() } });
        }
        return out;
      }
    }

    if (ranges.length > 0) {
      const minStart = Math.min(...ranges.map(r => r.start));
      const maxEnd = Math.max(...ranges.map(r => r.end));
      return { start: new Date(minStart), end: new Date(maxEnd) };
    }
    return fullRange ? { start: fullRange.start, end: fullRange.end } : undefined;
  });

  // Progress tracking for loading overlay (like explore/timeseries)
  const [loadingProgress, setLoadingProgress] = createSignal<number>(0);
  const [loadingMessage, setLoadingMessage] = createSignal<string>("Loading time series configuration...");
  /** Current source being fetched (for progress polling); null when not in source-fetch phase */
  const [currentFleetLoadSourceId, setCurrentFleetLoadSourceId] = createSignal<number | null>(null);
  const [currentFleetLoadSourceIndex, setCurrentFleetLoadSourceIndex] = createSignal<number>(0);
  const [totalFleetLoadSources, setTotalFleetLoadSources] = createSignal<number>(0);

  debug('🕐 TimeSeriesPage: Initial state - isLoading:', isLoading(), 'chartConfig:', chartConfig());

  // Register cleanup for selection store
  registerSelectionStoreCleanup();

  // Monitor chart configuration changes
  createEffect(() => {
    const currentChartConfig = chartConfig();
    debug('🕐 TimeSeriesPage: chartConfig changed:', {
      isNull: currentChartConfig === null,
      isArray: Array.isArray(currentChartConfig),
      length: currentChartConfig?.length || 0,
      hasData: currentChartConfig?.some((chart: any) => chart.series?.some((series: any) => series.data?.length > 0)) || false
    });
  });

  // Monitor loading state changes
  createEffect(() => {
    const currentLoading = isLoading();
    debug('🕐 TimeSeriesPage: isLoading changed to:', currentLoading);
  });

  // Note: The TimeSeries.jsx component itself handles selectedRange() and cutEvents()
  // internally using D3 zoom. We don't need a parent effect here as it would be
  // redundant and could cause unnecessary re-renders or loops.
  
  // Set timezone when date changes (for fleet mode)
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const date = selectedDate();
    
    if (!className || !projectId || !date) {
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
        debug('🕐 FleetTimeSeries: Set timezone from date endpoint', {
          datasetId: datasetId,
          timezone: tz
        });
      } else {
        // No timezone found for this date, clear timezone
        await setCurrentDataset(className, projectId, null);
      }
    } catch (error: unknown) {
      debug('🕐 FleetTimeSeries: Error setting timezone', error as any);
      await setCurrentDataset(className, projectId, null);
    }
  });
  
  // Filter reactivity effect - apply filters locally to preserve full dataset
  let lastFilterState = '';
  createEffect(() => {
    // Watch filter signals
    const states = selectedStatesTimeseries();
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const grades = selectedGradesTimeseries();
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    
    // Skip on initial mount when originalChartConfig is null (use untrack to avoid creating dependency)
    const origConfig = untrack(() => originalChartConfig());
    if (!origConfig) return;
    
    // Create a signature to detect actual filter changes (include cut events)
    const cutSignature = currentIsCut && currentCutEvents ? currentCutEvents.map(r => 
      typeof r === 'number' ? r : `${r.start_time}-${r.end_time}`
    ).join('|') : '';
    const filterSignature = `${states.join(',')}-${races.join(',')}-${legs.join(',')}-${grades.join(',')}-${cutSignature}`;
    if (filterSignature === lastFilterState) {
      debug('🕐 TimeSeriesPage: Filter state unchanged, skipping re-filter');
      return;
    }
    lastFilterState = filterSignature;
    
    debug('🕐 TimeSeriesPage: Filter signals changed, applying filters locally:', { 
      states, races, legs, grades, 
      isCut: currentIsCut, 
      cutRangesCount: currentCutEvents?.length || 0 
    });
    
    // Capture signature for staleness check - avoid applying stale results when filter changes rapidly
    const appliedFilterSignature = filterSignature;
    
    // Apply filters locally to the original data (includes cut filtering if cut data exists)
    applyFiltersToCharts(origConfig, states, races, legs, grades).then(({ filteredChartConfig, ranges }) => {
      const currentCutSig = isCut() && cutEvents() ? cutEvents().map((r: any) => 
        typeof r === 'number' ? r : `${r.start_time}-${r.end_time}`
      ).join('|') : '';
      const currentSig = `${selectedStatesTimeseries().join(',')}-${selectedRacesTimeseries().join(',')}-${selectedLegsTimeseries().join(',')}-${selectedGradesTimeseries().join(',')}-${currentCutSig}`;
      if (currentSig !== appliedFilterSignature) {
        debug('🕐 FleetTimeSeries: Filter changed during apply, discarding stale result');
        return;
      }
      setEventTimeRanges(ranges);
      setChartConfig(filteredChartConfig);
    });
  });

  // Helper: detect if any chart has its own filters
  const hasChartFilters = (charts: any[]): boolean =>
    Array.isArray(charts) && charts.some((c: any) => Array.isArray(c?.filters) && c.filters.length > 0);

  // Query events for race/leg filters and get time ranges (for all sources in fleet mode).
  // Returns ranges directly - caller sets eventTimeRanges only when applying (keeps x-scale in sync with chart)
  const fetchEventTimeRanges = async (races: (number | string)[], legs: number[]): Promise<EventTimeRange[]> => {
    if (races.length === 0 && legs.length === 0) {
      setRaceTimeRanges([]);
      setLegTimeRanges([]);
      return [];
    }

    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const sources = currentSources();

      if (!className || !projectId || sources.length === 0) {
        setRaceTimeRanges([]);
        setLegTimeRanges([]);
        return [];
      }

      const db = await huniDBStore.getDatabase(className.toLowerCase());
      const tableName = TableNames.events;
      const escapedTableName = escapeTableName(tableName);

      const allRaceRanges: EventTimeRange[] = [];
      const allLegRanges: EventTimeRange[] = [];

      // Query events for each source - include source_id so we only match data points to their own source's ranges
      for (const source of sources) {
        const { source_id, dataset_id } = source;

        // Query race events
        if (races.length > 0) {
          const raceConditions: string[] = [];
          const raceParams: any[] = [dataset_id, projectId, source_id];

          for (const race of races) {
            if (race === 'TRAINING' || race === 'training' || race === -1 || race === '-1') {
              raceConditions.push(`(
                CAST(json_extract(tags, '$.Race_number') AS REAL) = -1
                OR UPPER(TRIM(CAST(json_extract(tags, '$.Race_number') AS TEXT))) = 'TRAINING'
              )`);
            } else {
              const num = Number(race);
              if (!isNaN(num)) {
                raceConditions.push(`(
                  CAST(json_extract(tags, '$.Race_number') AS REAL) = ?
                  OR CAST(json_extract(tags, '$.Race_number') AS TEXT) = ?
                )`);
                raceParams.push(num, String(race));
              }
            }
          }

          if (raceConditions.length > 0) {
            // Try 'race' first, then try without event_type filter if no results
            let raceSql = `
              SELECT start_time, end_time
              FROM ${escapedTableName}
              WHERE dataset_id = ? AND project_id = ? AND source_id = ?
                AND event_type = 'race'
                AND (${raceConditions.join(' OR ')})
            `;
            let raceEvents = await db.query<any>(raceSql, raceParams);

            // If no results with 'race', try without event_type filter
            if (raceEvents.length === 0) {
              raceSql = `
                SELECT start_time, end_time
                FROM ${escapedTableName}
                WHERE dataset_id = ? AND project_id = ? AND source_id = ?
                  AND (${raceConditions.join(' OR ')})
              `;
              raceEvents = await db.query<any>(raceSql, raceParams);
            }
            
            for (const event of raceEvents) {
              const start = typeof event.start_time === 'number' ? event.start_time : new Date(event.start_time).getTime();
              const end = typeof event.end_time === 'number' ? event.end_time : new Date(event.end_time).getTime();
              
              if (!isNaN(start) && !isNaN(end) && isFinite(start) && isFinite(end)) {
                allRaceRanges.push({ start, end, source_id });
              }
            }
          }
        }

        // Query leg events
        if (legs.length > 0) {
          const legPlaceholders = legs.map(() => '?').join(',');
          let legSql = `
            SELECT start_time, end_time
            FROM ${escapedTableName}
            WHERE dataset_id = ? AND project_id = ? AND source_id = ?
              AND event_type = 'leg'
              AND CAST(json_extract(tags, '$.Leg_number') AS INTEGER) IN (${legPlaceholders})
          `;
          let legEvents = await db.query<any>(legSql, [dataset_id, projectId, source_id, ...legs]);

          // If no results with 'leg', try without event_type filter
          if (legEvents.length === 0) {
            legSql = `
              SELECT start_time, end_time
              FROM ${escapedTableName}
              WHERE dataset_id = ? AND project_id = ? AND source_id = ?
                AND CAST(json_extract(tags, '$.Leg_number') AS INTEGER) IN (${legPlaceholders})
            `;
            legEvents = await db.query<any>(legSql, [dataset_id, projectId, source_id, ...legs]);
          }
          
          for (const event of legEvents) {
            const start = typeof event.start_time === 'number' ? event.start_time : new Date(event.start_time).getTime();
            const end = typeof event.end_time === 'number' ? event.end_time : new Date(event.end_time).getTime();
            
            if (!isNaN(start) && !isNaN(end) && isFinite(start) && isFinite(end)) {
              allLegRanges.push({ start, end, source_id });
            }
          }
        }
      }

      // Store race and leg ranges separately
      setRaceTimeRanges(allRaceRanges);
      setLegTimeRanges(allLegRanges);

      // If both races and legs are selected, find intersection (overlapping ranges) - only overlap ranges from same source
      let finalRanges: EventTimeRange[] = [];
      if (races.length > 0 && legs.length > 0) {
        for (const raceRange of allRaceRanges) {
          for (const legRange of allLegRanges) {
            if (raceRange.source_id !== legRange.source_id) continue;
            const overlapStart = Math.max(raceRange.start, legRange.start);
            const overlapEnd = Math.min(raceRange.end, legRange.end);
            if (overlapStart <= overlapEnd) {
              finalRanges.push({ start: overlapStart, end: overlapEnd, source_id: raceRange.source_id });
            }
          }
        }
      } else if (races.length > 0) {
        finalRanges = allRaceRanges;
      } else if (legs.length > 0) {
        finalRanges = allLegRanges;
      }

      return finalRanges;
    } catch (error) {
      logError('🕐 FleetTimeSeries: Error fetching event time ranges:', error);
      return [];
    }
  };

  // Helper function to apply filters to chart configuration
  // Returns { filteredChartConfig, ranges } so we can update eventTimeRanges only when we apply (keeps x-scale in sync)
  const applyFiltersToCharts = async (charts: any[], globalFilters: string[] = selectedStatesTimeseries(), globalRaces: number[] = selectedRacesTimeseries() as any, globalLegs: number[] = selectedLegsTimeseries() as any, globalGrades: number[] = selectedGradesTimeseries() as any): Promise<{ filteredChartConfig: any[]; ranges: EventTimeRange[] }> => {
    // Check if charts have their own filters - if so, don't apply global filters
    if (hasChartFilters(charts)) {
      return { filteredChartConfig: charts, ranges: eventTimeRanges() };
    }
    
    // Fetch event time ranges if race/leg filters are selected
    const races = globalRaces.map(r => {
      const num = Number(r);
      return isNaN(num) ? r : num;
    });
    const legs = globalLegs.map(l => Number(l)).filter(l => !isNaN(l));
    
    // Use returned ranges directly to avoid async race when filter changes rapidly
    const ranges = await fetchEventTimeRanges(races, legs);
    
    // Check if we need to filter by cut ranges
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    const shouldFilterByCut = currentIsCut && currentCutEvents && currentCutEvents.length > 0;
    
    // Get the original unfiltered config to ensure we always filter from unfiltered data
    const origConfig = originalChartConfig();
    if (!origConfig) {
      return { filteredChartConfig: charts, ranges };
    }
    
    // Create a map to find original series data by chart and series index
    const originalDataMap = new Map<string, any[]>();
    origConfig.forEach((origChart: any, chartIndex: number) => {
      if (origChart.series) {
        origChart.series.forEach((origSeries: any, seriesIndex: number) => {
          const key = `${chartIndex}_${seriesIndex}`;
          originalDataMap.set(key, origSeries.data || []);
        });
      }
    });
    
    const filteredChartConfig = charts.map((chart: any, chartIndex: number) => ({
      ...chart,
      series: chart.series.map((series: any, seriesIndex: number) => {
        // Always use original unfiltered data from originalChartConfig
        const key = `${chartIndex}_${seriesIndex}`;
        const originalData = originalDataMap.get(key) || series.data || [];
        
        // Apply unified filtering with explicit filter values to prevent circular dependencies.
        // Explore Fleet Timeseries never applies selection/range/cut (forceSelection: false) so the full
        // dataset is always shown unless the user explicitly selects race/leg filters.
        let filteredData = applyDataFilter(originalData, globalFilters, globalRaces, globalLegs, globalGrades, undefined, { forceSelection: false });
        
        // Filter by event time ranges if race/leg filters are selected
        if (ranges.length > 0) {
          filteredData = filteredData.filter((item: any) => {
            if (!item.Datetime) return false;
            const itemTime = new Date(item.Datetime).getTime();
            
            if (isNaN(itemTime) || !isFinite(itemTime)) {
              return false;
            }
            
            // Check if item falls within any event time range
            return ranges.some(range => {
              return itemTime >= range.start && itemTime <= range.end;
            });
          });
        }
        
        // If cut data exists, filter to only include cut ranges
        if (shouldFilterByCut) {
          filteredData = filteredData.filter((item: any) => {
            if (!item.Datetime) return false;
            const itemTime = new Date(item.Datetime).getTime();
            
            // Check if item falls within any cut range
            return currentCutEvents.some((range: any) => {
              if (typeof range === 'number') return false; // Skip event IDs
              
              if (range.start_time && range.end_time) {
                const startTime = new Date(range.start_time).getTime();
                const endTime = new Date(range.end_time).getTime();
                return itemTime >= startTime && itemTime <= endTime;
              }
              return false;
            });
          });
        }
        
        return { ...series, data: filteredData };
      })
    }));
    return { filteredChartConfig, ranges };
  };

  // Watch for dependency changes and refetch when needed
  // This prevents infinite loops by only refetching when actual dependencies change
  let lastFetchKey = '';
  let hasInitialFetch = false; // Track if we've done the initial fetch
  let isFetching = false; // Guard to prevent concurrent fetches
  let progressCheckInterval: ReturnType<typeof setInterval> | null = null;
  let effectRunCount = 0; // Track effect runs for debugging
  let lastEffectTime = 0; // Track when effect last ran to prevent rapid-fire calls
  
  // Create a stable memo for selectedSources to prevent infinite loops
  const selectedSourcesKey = createMemo(() => {
    return Array.from(selectedSources()).sort().join(',');
  });
  
  // Use on() to only track specific dependencies, not all reactive values
  createEffect(on(
    [
      () => user()?.user_id,
      () => selectedClassName(),
      () => selectedProjectId(),
      () => selectedDatasetId(),
      () => selectedDate(),
      () => selectedPage(),
      selectedSourcesKey, // Watch source selections via stable memo
      () => sidebarMenuRefreshTrigger() // Refetch after timeseries builder save (same chart name)
      // Note: objectName() is excluded from tracked dependencies to prevent loops
      // We'll get it inside the effect using untrack
    ],
    () => {
      effectRunCount++;
      const now = Date.now();
      
      // Prevent rapid-fire effect runs (debounce)
      if (now - lastEffectTime < 100) {
        debug('🕐 TimeSeriesPage: Effect triggered too quickly, debouncing');
        return;
      }
      lastEffectTime = now;
      
      debug('🕐 TimeSeriesPage: Effect triggered, run count:', effectRunCount);
      
      // Prevent infinite loops - if effect runs too many times, stop
      if (effectRunCount > 10) {
        logError('🕐 TimeSeriesPage: Effect run count exceeded limit, stopping to prevent infinite loop', {
          count: effectRunCount,
          lastFetchKey
        });
        return;
      }
      
      // Prevent concurrent fetches
      if (isFetching) {
        debug('🕐 TimeSeriesPage: Fetch already in progress, skipping');
        return;
      }
      
      // Create a key from all dependencies that should trigger a refetch
      // Use untrack for objectName to prevent it from triggering the effect
      const currentUser = user();
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const datasetId = selectedDatasetId();
      const date = selectedDate();
      const page = selectedPage();
      const objName = untrack(() => objectName()); // Use untrack to prevent reactive dependency
      
      debug('🕐 TimeSeriesPage: Dependency values:', {
        hasUser: !!currentUser?.user_id,
        className,
        projectId,
        datasetId,
        date,
        page,
        objectName: objName
      });
      
      // Only refetch if user is available and we have required dependencies
      if (!currentUser?.user_id || !className || !projectId || !date) {
        debug('🕐 TimeSeriesPage: Missing required dependencies, skipping fetch');
        return;
      }
      
      const selectedSourcesKeyVal = Array.from(selectedSources()).sort().join(',');
      const menuRefresh = sidebarMenuRefreshTrigger();
      const fetchKey = `${currentUser.user_id}_${className}_${projectId}_${datasetId}_${date}_${page}_${objName}_${selectedSourcesKeyVal}_${menuRefresh}`;
      
      // Only refetch if the key actually changed (prevents infinite loops)
      // Check this BEFORE checking isFetching to avoid unnecessary work
      if (fetchKey === lastFetchKey) {
        debug('🕐 TimeSeriesPage: Fetch key unchanged, skipping:', fetchKey);
        return;
      }
      
      // Key has changed and we're not already fetching - proceed with fetch
      lastFetchKey = fetchKey;
      
      // For initial fetch, allow it even if isLoading is true (it's just the initial state)
      // For subsequent fetches, check if already loading to prevent duplicates
      const currentlyLoading = untrack(() => isLoading());
      const isInitialFetch = !hasInitialFetch;
      
      if (!isInitialFetch && currentlyLoading) {
        debug('🕐 TimeSeriesPage: Already loading, skipping duplicate request');
        return;
      }
      
      hasInitialFetch = true; // Mark that we've done at least one fetch
      
      debug('🕐 TimeSeriesPage: Dependencies changed, refetching chart config:', {
        className,
        projectId,
        datasetId,
        date,
        page,
        objectName: objName,
        isInitialFetch,
        effectRunCount
      });
      
      // Set fetching flag and fetch chart config
      isFetching = true;
      fetchChartConfigAndData()
        .catch((error: any) => {
          logError('🕐 TimeSeriesPage: Error in dependency watch effect:', error);
        })
        .finally(() => {
          isFetching = false;
          // Reset effect run count after successful fetch
          if (effectRunCount > 0) {
            effectRunCount = 0;
          }
        });
    }
  ));

  // Fetch chart configuration and ensure data is available
  const fetchChartConfigAndData = async () => {
    debug('🕐 TimeSeriesPage: fetchChartConfigAndData started');
    
    // Note: Duplicate fetch prevention is handled by the createEffect that calls this function
    // We don't check isLoading here because it starts as true and would block the initial fetch
    
    try {
      setIsLoading(true);
      setLoadingProgress(0);
      setLoadingMessage("Loading time series configuration...");
      debug('🕐 TimeSeriesPage: Set loading to true');
      
      // 1. Resolve chart object name: use explicit/selected name, or first available from list (never hardcode "default")
      const currentUser = user();
      if (!currentUser?.user_id) {
        setChartConfig(null);
        return;
      }
      let nameToUse: string | null = props?.objectName || selectedPage() || null;
      if (!nameToUse) {
        const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=fleet_timeseries`;
        const namesResponse = await getData(namesUrl);
        const namesList = namesResponse?.success && Array.isArray(namesResponse?.data) ? namesResponse.data as { object_name: string }[] : [];
        if (namesList.length > 0) {
          nameToUse = namesList[0].object_name;
          setSelectedPage(nameToUse);
          debug('🕐 TimeSeriesPage: No explicit object name; using first chart object:', nameToUse);
        }
      }
      if (!nameToUse) {
        debug('🕐 TimeSeriesPage: No chart objects found for fleet_timeseries; skipping chart config fetch');
        setChartConfig(null);
        return;
      }

      const apiUrl = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=fleet_timeseries&object_name=${encodeURIComponent(nameToUse)}`;
      debug('🕐 TimeSeriesPage: Fetching chart config from:', apiUrl);

      const response = await getData(apiUrl);
      debug('🕐 TimeSeriesPage: Chart config response received:', {
        success: response.success,
        hasData: !!response.data,
        hasChartInfo: !!(response.data && response.data.chart_info),
        chartInfoLength: response.data?.chart_info?.length || 0
      });

      let chartObjects = response.data?.chart_info || [];

      // Use only what the user has defined in the chart_object
      if (chartObjects.length === 0) {
        logError('🕐 TimeSeriesPage: Failed to fetch chart configuration', {
          objectName: nameToUse,
          datasetId: selectedDatasetId(),
          projectId: selectedProjectId(),
          className: selectedClassName()
        });
        setChartConfig(null);
        return;
      }

      setLoadingProgress(5);
      setLoadingMessage("Preparing channels...");
      debug('🕐 TimeSeriesPage: Processing chart objects:', chartObjects.length, 'charts');
      // Update global flag for SelectionBanner based on chart-level filters
      try {
        const chartsHaveOwnFilters = Array.isArray(chartObjects) && chartObjects.some((c: any) => Array.isArray(c?.filters) && c.filters.length > 0);
        setHasChartsWithOwnFilters(!!chartsHaveOwnFilters);
      } catch (_) {}
      
      // 2. Extract required channels from all chart configurations
      const requiredChannels: string[] = [];
      chartObjects.forEach((chart: any, chartIndex: number) => {
        debug('🕐 TimeSeriesPage: Processing chart', chartIndex, 'with', chart.series?.length || 0, 'series');
        if (chart.series && chart.series.length > 0) {
          chart.series.forEach((series: any, seriesIndex: number) => {
            debug('🕐 TimeSeriesPage: Processing series', seriesIndex, ':', {
              xaxis: series.xaxis?.name,
              yaxis: series.yaxis?.name,
              colorChannel: series.colorChannel?.name
            });
            if (series.xaxis && series.xaxis.name) {
              requiredChannels.push(series.xaxis.name);
            }
            if (series.yaxis && series.yaxis.name) {
              requiredChannels.push(series.yaxis.name);
            }
            if (series.colorChannel && series.colorChannel.name) {
              requiredChannels.push(series.colorChannel.name);
            }
          });
        }
      });
      
      debug('🕐 TimeSeriesPage: Extracted required channels:', requiredChannels);
      
      // Add Datetime if not already included
      if (!requiredChannels.includes('Datetime')) {
        requiredChannels.unshift('Datetime');
        debug('🕐 TimeSeriesPage: Added Datetime to required channels');
      }

      // For explore/fleettimeseries we need Race_number and Leg_number for filtering; do not include Grade or default Twa
      const FILTER_METADATA_FALLBACK = ['Race_number', 'Leg_number'];
      let filterMetadataChannels: string[];
      try {
        filterMetadataChannels = await UnifiedFilterService.getRequiredFilterChannels(selectedClassName(), 'day');
        if (!filterMetadataChannels?.length) filterMetadataChannels = [...FILTER_METADATA_FALLBACK];
      } catch {
        filterMetadataChannels = [...FILTER_METADATA_FALLBACK];
      }
      // Exclude Grade and Twa_deg for fleettimeseries fetch - not needed for explore fleettimeseries
      filterMetadataChannels = filterMetadataChannels.filter(
        (ch: string) => ch.toLowerCase() !== 'grade' && ch.toLowerCase() !== 'twa_deg' && ch.toLowerCase() !== 'state'
      );
      filterMetadataChannels.forEach(channel => {
        if (!requiredChannels.some(ch => ch.toLowerCase() === channel.toLowerCase())) {
          requiredChannels.push(channel);
          debug('🕐 TimeSeriesPage: Added filter metadata channel:', channel);
        }
      });

      // Filter out known non-existent channels to prevent 404 errors
      const validChannels: string[] = [
        ...new Set(
          requiredChannels.filter((channel: string) => {
            const invalidChannels: string[] = []; // Only filter out channels that definitely don't exist
            return !invalidChannels.includes(channel);
          })
        ),
      ];

      debug('🕐 TimeSeriesPage: Valid channels after filtering:', validChannels);

      if (validChannels.length !== requiredChannels.length) {
        warn('🕐 TimeSeriesPage: Filtered out non-existent channels:', requiredChannels.filter(ch => !validChannels.includes(ch)));
      }

      /** Per y-axis channel: DuckDB SUM / SUM(ABS) per resample bucket when lineType is cumulative / abs_cumulative. */
      const channelBucketAggregateByName: Record<string, ChannelBucketAggregate> = {};
      const bucketAggConflict = new Set<string>();
      chartObjects.forEach((chart: any) => {
        (chart?.series || []).forEach((series: any) => {
          const yName = series?.yaxis?.name;
          if (!yName || typeof yName !== 'string') return;
          if (yName.toLowerCase() === 'datetime') return;
          const agg = bucketAggregateForLineType(series?.lineType);
          if (!agg) return;
          if (bucketAggConflict.has(yName)) return;
          const prev = channelBucketAggregateByName[yName];
          if (prev !== undefined && prev !== agg) {
            bucketAggConflict.add(yName);
            delete channelBucketAggregateByName[yName];
            warn('🕐 TimeSeriesPage: conflicting line types for same y channel — omitting DuckDB bucket sum hint', {
              channel: yName,
              prev,
              next: agg,
            });
          } else {
            channelBucketAggregateByName[yName] = agg;
          }
        });
      });
      const channelBucketAggregateForApi: Record<string, ChannelBucketAggregate> | undefined =
        Object.keys(channelBucketAggregateByName).length > 0 ? channelBucketAggregateByName : undefined;

      // 3. Get selectedDate for proper API calls
      let dateStr = selectedDate();
      if (!dateStr) {
        throw new Error("No selectedDate available. Please select a date.");
      }
      
      // Format date properly (handle both YYYY-MM-DD and YYYYMMDD formats)
      let formattedDate = dateStr;
      if (dateStr.includes('-')) {
        formattedDate = dateStr.replace(/-/g, "");
      } else if (dateStr.length === 8) {
        // Already in YYYYMMDD format
        formattedDate = dateStr;
      } else {
        throw new Error(`Invalid date format: ${dateStr}`);
      }
      
      debug('🕐 TimeSeriesPage: Using selectedDate:', dateStr, 'formatted:', formattedDate);

      // 4. Fetch available sources and their dataset_ids for selectedDate (use timezone for local day)
      debug('🕐 TimeSeriesPage: Fetching sources for date:', dateStr);
      const timezone = await getTimezoneForDate(selectedClassName(), Number(selectedProjectId()), dateStr);
      let sourcesUrl = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(dateStr)}`;
      if (timezone) sourcesUrl += `&timezone=${encodeURIComponent(timezone)}`;
      const sourcesResponse = await getData(sourcesUrl);
      
      if (!sourcesResponse.success || !sourcesResponse.data) {
        throw new Error("Failed to fetch sources for selected date.");
      }
      
      const sourcesList: any[] = sourcesResponse.data || [];
      const availableSources: Array<{ source_id: number; source_name: string; dataset_id: number }> = [];
      const seen = new Set<number>();
      sourcesList.forEach((row: any) => {
        const sid = Number(row.source_id ?? row.sourceId);
        const sname = row.source_name ?? row.sourceName;
        const dsid = Number(row.dataset_id ?? row.datasetId);
        if (!Number.isNaN(sid) && sname && !seen.has(sid)) {
          seen.add(sid);
          availableSources.push({ source_id: sid, source_name: sname, dataset_id: dsid });
        }
      });
      
      debug('🕐 TimeSeriesPage: Available sources:', availableSources.length, availableSources.map(s => s.source_name));
      
      // 5. Filter available sources to only selected ones (from local state)
      const selectedSourceIds = selectedSources();
      const sourcesToUse = selectedSourceIds.size > 0
        ? availableSources.filter(s => selectedSourceIds.has(s.source_id))
        : availableSources; // If no sources selected, use all (default behavior)
      debug('🕐 TimeSeriesPage: Sources to use:', sourcesToUse.length, sourcesToUse.map(s => s.source_name));
      
      // Store sources for event querying
      setCurrentSources(sourcesToUse);
      
      if (sourcesToUse.length === 0) {
        throw new Error("No sources selected for the selected date.");
      }
      
      // Fetch DATASET events for all selected sources to get min start and max end time
      // Use backend endpoint for efficient single query instead of multiple IndexedDB queries
      try {
        const className = selectedClassName();
        const projectId = selectedProjectId();
        
        if (className && projectId && sourcesToUse.length > 0) {
          // Collect all dataset_ids from selected sources
          const datasetIds = sourcesToUse.map(s => s.dataset_id);
          
          // Call backend endpoint to get min start_time and max end_time in a single query
          const timeRangeResponse = await getData(
            `${apiEndpoints.app.events}/dataset-time-range?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_ids=${encodeURIComponent(JSON.stringify(datasetIds))}&timezone=UTC`
          );
          
          if (timeRangeResponse?.success && timeRangeResponse.data) {
            const { start_time, end_time } = timeRangeResponse.data;
            
            if (start_time && end_time) {
              const start = new Date(start_time);
              const end = new Date(end_time);
              
              if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start.getTime() < end.getTime()) {
                setDatasetEventTimeRange({ start, end });
                debug('🕐 FleetTimeSeries: Fetched DATASET event time range from backend', {
                  sourceCount: sourcesToUse.length,
                  datasetCount: datasetIds.length,
                  startTime: start.toISOString(),
                  endTime: end.toISOString()
                });
              } else {
                debug('🕐 FleetTimeSeries: Invalid time range from backend, x-scale will use data extent');
                setDatasetEventTimeRange(null);
              }
            } else {
              debug('🕐 FleetTimeSeries: No DATASET events found, x-scale will use data extent');
              setDatasetEventTimeRange(null);
            }
          } else {
            debug('🕐 FleetTimeSeries: Backend returned no data, x-scale will use data extent');
            setDatasetEventTimeRange(null);
          }
        }
      } catch (error) {
        warn('🕐 FleetTimeSeries: Error fetching DATASET event time range from backend, x-scale will use data extent', error);
        setDatasetEventTimeRange(null);
      }
      
      // 6. Determine which sources are needed for each series based on colorBySource
      const seriesSourceMap = new Map<string, Array<{ source_id: number; source_name: string; dataset_id: number }>>(); // Map series index to array of sources needed
      debug('🕐 TimeSeriesPage: Building seriesSourceMap from', chartObjects.length, 'charts');
      chartObjects.forEach((chart: any, chartIndex: number) => {
        if (chart.series && chart.series.length > 0) {
          debug(`🕐 TimeSeriesPage: Chart ${chartIndex} has ${chart.series.length} series`);
          chart.series.forEach((series: any, seriesIndex: number) => {
            const key = `${chartIndex}_${seriesIndex}`;
            const colorBySource = series.colorBySource;
            debug(`🕐 TimeSeriesPage: Series ${key} - colorBySource:`, colorBySource, 'yaxis:', series.yaxis?.name);
            
            if (colorBySource === "ALL" || colorBySource === "all") {
              // Need data for all selected sources
              seriesSourceMap.set(key, sourcesToUse);
              debug(`🕐 TimeSeriesPage: Series ${key} mapped to ALL sources (${sourcesToUse.length} sources)`);
            } else if (colorBySource) {
              // Need data for specific source
              const specificSource = sourcesToUse.find((s: { source_id: number; source_name: string; dataset_id: number }) => 
                s.source_name.toLowerCase() === colorBySource.toLowerCase()
              );
              if (specificSource) {
                seriesSourceMap.set(key, [specificSource]);
                debug(`🕐 TimeSeriesPage: Series ${key} mapped to specific source: ${specificSource.source_name}`);
              } else {
                warn(`🕐 TimeSeriesPage: Source "${colorBySource}" not found, skipping series`);
                seriesSourceMap.set(key, []);
              }
            } else {
              // No colorBySource specified, use first selected source as default
              if (sourcesToUse.length > 0) {
                seriesSourceMap.set(key, [sourcesToUse[0]]);
                debug(`🕐 TimeSeriesPage: Series ${key} has no colorBySource, defaulting to first source: ${sourcesToUse[0].source_name}`);
              } else {
                warn(`🕐 TimeSeriesPage: Series ${key} has no colorBySource and no sources available`);
                seriesSourceMap.set(key, []);
              }
            }
          });
        } else {
          debug(`🕐 TimeSeriesPage: Chart ${chartIndex} has no series`);
        }
      });
      
      // 7. Fetch data for each required source
      setLoadingProgress(10);
      setLoadingMessage("Loading fleet data...");
      setTotalFleetLoadSources(sourcesToUse.length);
      // Start progress polling (unifiedDataStore progress per current source)
      if (progressCheckInterval) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
      }
      progressCheckInterval = setInterval(() => {
        const total = totalFleetLoadSources();
        const currentId = currentFleetLoadSourceId();
        const idx = currentFleetLoadSourceIndex();
        if (total <= 0) return;
        const segment = 70; // 70% of bar for "fetching sources" (10% done before loop, 20% after for processing)
        const base = 10;
        if (currentId !== null) {
          const progressMessage = unifiedDataStore.getProgressMessage('ts', selectedClassName(), currentId);
          const perSource = unifiedDataStore.getProgress('ts', selectedClassName(), currentId);
          if (progressMessage) {
            setLoadingMessage(progressMessage);
          } else {
            setLoadingMessage(`Loading boat ${idx + 1} of ${total}...`);
          }
          const pct = perSource !== null ? (idx / total) * segment + (perSource / 100) * (segment / total) : (idx / total) * segment;
          setLoadingProgress(base + pct);
        } else {
          setLoadingProgress(base + (idx / total) * segment);
        }
      }, 200);
      debug('🕐 TimeSeriesPage: Fetching data for charts...');
      debug('🕐 TimeSeriesPage: seriesSourceMap size:', seriesSourceMap.size);
      debug('🕐 TimeSeriesPage: sourcesToUse count:', sourcesToUse.length);
      // Always fetch full dataset, apply filters locally for better control
      
      // Collect all unique sources needed
      const sourcesNeeded = new Set<number>();
      seriesSourceMap.forEach((sources: Array<{ source_id: number; source_name: string; dataset_id: number }>, key: string) => {
        debug(`🕐 TimeSeriesPage: seriesSourceMap[${key}] has ${sources.length} sources`);
        sources.forEach((s: { source_id: number; source_name: string; dataset_id: number }) => sourcesNeeded.add(s.source_id));
      });
      
      debug('🕐 TimeSeriesPage: sourcesNeeded count:', sourcesNeeded.size, 'sources:', Array.from(sourcesNeeded));
      
      // If no sources are needed (empty seriesSourceMap), fetch data for all available sources
      // This can happen when a new chart is created without series configured yet
      const shouldFetchAllSources = sourcesNeeded.size === 0;
      if (shouldFetchAllSources) {
        warn('🕐 TimeSeriesPage: No sources needed from seriesSourceMap, will fetch data for all available sources');
        sourcesToUse.forEach(s => sourcesNeeded.add(s.source_id));
      }
      
      // Fetch data for each source
      const sourceDataMap = new Map<number, any[]>(); // Map source_id to data array
      let sourceIndex = 0;
      for (const source of sourcesToUse) {
        if (!sourcesNeeded.has(source.source_id)) {
          debug(`🕐 TimeSeriesPage: Skipping source ${source.source_name} (not in sourcesNeeded)`);
          continue; // Skip sources not needed for any series
        }
        setCurrentFleetLoadSourceId(source.source_id);
        setCurrentFleetLoadSourceIndex(sourceIndex);
        sourceIndex++;
        debug(`🕐 TimeSeriesPage: Fetching data for source ${source.source_name} (ID: ${source.source_id}, Dataset: ${source.dataset_id})`);
        
        try {
          // Get dataset timezone for this source's dataset
          let datasetTimezone: string | null = null;
          try {
            const datasetInfoResponse = await getData(
              `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(source.dataset_id)}`
            );
            if (datasetInfoResponse?.success && datasetInfoResponse.data?.timezone) {
              datasetTimezone = datasetInfoResponse.data.timezone;
              debug(`🕐 TimeSeriesPage: Using timezone ${datasetTimezone} for dataset ${source.dataset_id}`);
            }
          } catch (tzError) {
            debug(`🕐 TimeSeriesPage: Could not fetch timezone for dataset ${source.dataset_id}, will use UTC`);
          }
          
          // IMPORTANT: FleetTimeSeries is an explore component using raw file data
          // Always fetch full channel list in one call per source. Splitting standard vs cumulative into
          // two parallel fetches breaks unifiedDataStore: each response omits some requested metadata
          // channels, so the store refuses to return rows and every boat gets [].
          const data = await unifiedDataStore.fetchDataWithChannelChecking(
            "ts",
            selectedClassName(),
            source.source_id.toString(),
            validChannels,
            {
              projectId: selectedProjectId().toString(),
              className: selectedClassName(),
              datasetId: source.dataset_id.toString(),
              sourceName: source.source_name,
              sourceId: source.source_id,
              date: formattedDate,
              timezone: datasetTimezone,
              use_v2: true,
              applyGlobalFilters: false,
              channelBucketAggregateByName: channelBucketAggregateForApi,
            },
            "timeseries"
          );
          
          if (data && data.length > 0) {
            // Add source identification to each data point
            const dataWithSource = data.map((item: any) => ({
              ...item,
              source_id: source.source_id,
              source_name: source.source_name
            }));
            sourceDataMap.set(source.source_id, dataWithSource);
            debug(`🕐 TimeSeriesPage: Fetched ${dataWithSource.length} data points for source ${source.source_name}`);
          } else {
            debug(`🕐 TimeSeriesPage: No data returned for source ${source.source_name}`);
            sourceDataMap.set(source.source_id, []);
          }
        } catch (error: unknown) {
          logError(`🕐 TimeSeriesPage: Error fetching data for source ${source.source_name}:`, error as any);
          sourceDataMap.set(source.source_id, []);
        }
      }
      setCurrentFleetLoadSourceId(null);
      setLoadingProgress(85);
      setLoadingMessage("Processing data...");
      
      // Load full filter options from unified datastore
      try {
        const opts = await unifiedDataStore.getFilterOptions();
        if (opts) {
          const allRaces = (opts.races || []).slice().sort(sortRaceValues);
          const allGrades = (opts.grades || []).slice().sort((a: number, b: number) => a - b);
          const allLegs = (opts.legs || opts.legOptions || []).slice().sort((a: number, b: number) => a - b);
          try {
            const { setRaceOptions, setGradeOptions, setLegOptions } = await import('../../../../store/filterStore');
            setRaceOptions(allRaces.map(String));
            setGradeOptions(allGrades.map(String));
            setLegOptions(allLegs.map(String));
          } catch (_) {}
        }
      } catch (_) {}

      // 8. Get source colors from sourcesStore (single source of truth)
      const sourceColorMap = new Map<string, string>();
      sourcesToUse.forEach((source: { source_id: number; source_name: string; dataset_id: number }) => {
        const color = sourcesStore.getSourceColor(source.source_name) || '#1f77b4';
        sourceColorMap.set(source.source_name.toLowerCase(), color);
      });
      
      debug('🕐 TimeSeriesPage: Source color map:', Array.from(sourceColorMap.entries()));

      // 9. Process data and create chart configuration with expanded series
      const newChartConfig = chartObjects.map((chart: any, chartIndex: number) => {
        const expandedSeries: any[] = [];
        const seenSeriesKey = new Set<string>();
        
        chart.series.forEach((series: any, seriesIndex: number) => {
          const key = `${chartIndex}_${seriesIndex}`;
          const sourcesForSeries = seriesSourceMap.get(key) || [];
          const xName = series.xaxis?.name;
          const yName = series.yaxis?.name;
          const colorBySource = series.colorBySource;
          
          if (!xName || !yName) {
            warn(`🕐 TimeSeriesPage: Series ${seriesIndex} missing xaxis or yaxis, skipping`);
            return;
          }
          
          if (colorBySource === "ALL" || colorBySource === "all") {
            // Create one series per source (dedupe by channel+source so we never push the same row twice)
            sourcesForSeries.forEach((source: { source_id: number; source_name: string; dataset_id: number }) => {
              const seriesKey = `${yName}|${source.source_id}`;
              if (seenSeriesKey.has(seriesKey)) return;
              seenSeriesKey.add(seriesKey);
              const sourceData = sourceDataMap.get(source.source_id) || [];
              
              // Process data for this source
              const processedData = sourceData.map((item: any) => {
                const dataPoint: any = {
                  Datetime: item.Datetime,
                  source_id: item.source_id,
                  source_name: item.source_name
                };
                
                // Add all channel data
                validChannels.forEach((channelName: string) => {
                  if (item[channelName] !== undefined) {
                    dataPoint[channelName] = item[channelName];
                  }
                });
                
                // Preserve filter metadata fields (needed for filtering to work)
                if (item.Race_number !== undefined) dataPoint.Race_number = item.Race_number;
                if (item.Leg_number !== undefined) dataPoint.Leg_number = item.Leg_number;
                if (item.Grade !== undefined) dataPoint.Grade = item.Grade;
                
                // Set x value from xaxis
                // API returns Datetime in local timezone when timezone is provided
                // Use Datetime if xaxis is Datetime, otherwise use the xaxis channel
                if (xName === 'Datetime' && item.Datetime) {
                  // Use Datetime directly (already converted to local time by API)
                  dataPoint.x = new Date(item.Datetime);
                } else if (item[xName] !== undefined) {
                  const timestamp = item[xName];
                  // For other channels (like 'ts'), convert to Date
                  if (typeof timestamp === 'number') {
                    // Number timestamp - assume milliseconds (if it's seconds, it would be very small)
                    // Timestamps after 2000-01-01 in seconds would be > 946684800
                    // If timestamp is less than this threshold, assume it's in seconds and convert
                    dataPoint.x = timestamp < 946684800 ? new Date(timestamp * 1000) : new Date(timestamp);
                  } else {
                    dataPoint.x = new Date(timestamp);
                  }
                }
                
                return dataPoint;
              });
              
              // Filter and map to series data format
              const seriesData = processedData
                .filter((item: any) => item.x !== undefined && item[yName] !== undefined)
                .map((item: any) => {
                  const seriesPoint: any = {
                    x: item.x,
                    y: item[yName],
                    Datetime: item.Datetime,
                    source_id: item.source_id,
                    source_name: item.source_name,
                    [xName]: item[xName],
                    [yName]: item[yName]
                  };
                  
                  // Preserve filter metadata fields for filtering to work
                  if (item.Race_number !== undefined) seriesPoint.Race_number = item.Race_number;
                  if (item.Leg_number !== undefined) seriesPoint.Leg_number = item.Leg_number;
                  if (item.Grade !== undefined) seriesPoint.Grade = item.Grade;
                  
                  return seriesPoint;
                })
                .sort((a: any, b: any) => {
                  if (!a.x || !b.x) return 0;
                  return a.x.getTime() - b.x.getTime();
                });
              
              // Get source color
              const sourceColor = sourceColorMap.get(source.source_name.toLowerCase()) || series.color || '#1f77b4';
              
              // Create series with source-specific label and color
              expandedSeries.push({
                ...series,
                yaxis: {
                  ...series.yaxis,
                  name: `${series.yaxis.name} - ${source.source_name}`
                },
                color: sourceColor,
                data: seriesData
              });
            });
          } else {
            // Single source series
            const source = sourcesForSeries[0];
            if (!source) {
              warn(`🕐 TimeSeriesPage: No source found for series ${seriesIndex}, skipping`);
              return;
            }
            
            const sourceData = sourceDataMap.get(source.source_id) || [];
            
            // Process data for this source
            const processedData = sourceData.map((item: any) => {
              const dataPoint: any = {
                Datetime: item.Datetime,
                source_id: item.source_id,
                source_name: item.source_name
              };
              
              // Add all channel data
              validChannels.forEach((channelName: string) => {
                if (item[channelName] !== undefined) {
                  dataPoint[channelName] = item[channelName];
                }
              });
              
              // Preserve filter metadata fields (needed for filtering to work)
              if (item.Race_number !== undefined) dataPoint.Race_number = item.Race_number;
              if (item.Leg_number !== undefined) dataPoint.Leg_number = item.Leg_number;
              if (item.Grade !== undefined) dataPoint.Grade = item.Grade;
              
              // Set x value from xaxis
              // API returns Datetime in local timezone when timezone is provided
              // Use Datetime if xaxis is Datetime, otherwise use the xaxis channel
              if (xName === 'Datetime' && item.Datetime) {
                // Use Datetime directly (already converted to local time by API)
                dataPoint.x = new Date(item.Datetime);
              } else if (item[xName] !== undefined) {
                const timestamp = item[xName];
                // For other channels (like 'ts'), convert to Date
                if (typeof timestamp === 'number') {
                  // Number timestamp - assume milliseconds (if it's seconds, it would be very small)
                  // Timestamps after 2000-01-01 in seconds would be > 946684800
                  // If timestamp is less than this threshold, assume it's in seconds and convert
                  dataPoint.x = timestamp < 946684800 ? new Date(timestamp * 1000) : new Date(timestamp);
                } else {
                  dataPoint.x = new Date(timestamp);
                }
              }
              
              return dataPoint;
            });
            
            // Filter and map to series data format
            const seriesData = processedData
              .filter((item: any) => item.x !== undefined && item[yName] !== undefined)
              .map((item: any) => {
                const seriesPoint: any = {
                  x: item.x,
                  y: item[yName],
                  Datetime: item.Datetime,
                  source_id: item.source_id,
                  source_name: item.source_name,
                  [xName]: item[xName],
                  [yName]: item[yName]
                };
                
                // Preserve filter metadata fields for filtering to work
                if (item.Race_number !== undefined) seriesPoint.Race_number = item.Race_number;
                if (item.Leg_number !== undefined) seriesPoint.Leg_number = item.Leg_number;
                if (item.Grade !== undefined) seriesPoint.Grade = item.Grade;
                
                return seriesPoint;
              })
              .sort((a: any, b: any) => {
                if (!a.x || !b.x) return 0;
                return a.x.getTime() - b.x.getTime();
              });
            
            // For non-ALL colorBySource, use the color specified in the chart_object series
            // This ensures the user's chosen color is respected
            const seriesColor = series.color || '#1f77b4';
            
            debug(`🕐 TimeSeriesPage: Single source series for ${source.source_name}, using color: ${seriesColor}`);
            
            expandedSeries.push({
              ...series,
              color: seriesColor, // Use the color from chart_object, not source color
              data: seriesData
            });
          }
        });
        
        return {
          ...chart,
          chart: `chart_${chartIndex + 1}`,
          series: expandedSeries
        };
      });
      
      debug('🕐 TimeSeriesPage: Created chart config with', newChartConfig.length, 'charts');

      // Filter series by selected sources (if any sources are selected)
      let filteredBySources = newChartConfig;
      if (selectedSourceIds.size > 0) {
        filteredBySources = newChartConfig.map(chart => ({
          ...chart,
          series: chart.series.filter((series: any) => {
            // Check if series has source_id in its data points
            if (series.data && series.data.length > 0) {
              const firstDataPoint = series.data[0];
              const seriesSourceId = firstDataPoint?.source_id;
              return seriesSourceId && selectedSourceIds.has(seriesSourceId);
            }
            return true; // Keep series without data for now
          })
        }));
        debug('🕐 TimeSeriesPage: Filtered chart config by selected sources', { 
          originalSeries: newChartConfig.reduce((sum, c) => sum + (c.series?.length || 0), 0),
          filteredSeries: filteredBySources.reduce((sum, c) => sum + (c.series?.length || 0), 0)
        });
      }

      // Store original unfiltered config
      setOriginalChartConfig(filteredBySources);
      
      // Apply filters locally to create the filtered version
      // Note: Cut filtering is handled reactively in applyFiltersToCharts
      // This ensures data is re-filtered when cut events change
      const { filteredChartConfig, ranges } = await applyFiltersToCharts(filteredBySources);
      setEventTimeRanges(ranges);
      setChartConfig(filteredChartConfig);
      debug('🕐 TimeSeriesPage: Chart config set successfully');
      
    } catch (error: unknown) {
      logError('🕐 TimeSeriesPage: Error fetching chart configuration and data:', error as any);
      setChartConfig(null);
    } finally {
      if (progressCheckInterval) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
      }
      setCurrentFleetLoadSourceId(null);
      setLoadingProgress(100);
      setLoadingMessage("Complete");
      setIsLoading(false);
      debug('🕐 TimeSeriesPage: Set loading to false');
    }
  };

  onMount(async () => {
    debug('🕐 TimeSeriesPage: onMount called');
    await logPageLoad('TimeSeries.jsx', 'Time Series Report');
    debug('🕐 TimeSeriesPage: Page load logged, starting fetchChartConfigAndData');
    
    // Set up dynamic scaling for media-container using the global utility
    // Use width-based scaling to fill available width when zoomed (matches explore TimeSeries)
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'FleetTimeSeries',
      scaleToWidth: true
    });
    
    // Debug: Check initial selectedTime state
    debug('🕐 TimeSeriesPage: Initial selectedTime state:', {
      selectedTime: selectedTime()?.toISOString() || 'null',
      isDefault: selectedTime()?.getTime() === new Date('1970-01-01T12:00:00Z').getTime()
    });
    
    // Note: fetchChartConfigAndData is now handled by the createEffect that watches dependencies
    // This prevents double-fetching and infinite loops
    debug('🕐 TimeSeriesPage: onMount completed - createEffect will handle initial fetch');
    
    // Cleanup on unmount
    return () => {
      cleanupScaling(); // Call the cleanup function returned by the utility
    };
    
    debug('🕐 TimeSeriesPage: onMount completed');
  });

  onCleanup(() => {
    debug('🕐 TimeSeriesPage: onCleanup called');
    if (progressCheckInterval) {
      clearInterval(progressCheckInterval);
      progressCheckInterval = null;
    }
  });

  return (
    <div id="media-container" class="timeseries-page" style={{ "overflow-x": "hidden", "display": "flex", "flex-direction": "column", "min-height": "0" }}>
      <div class="container relative flex-1 min-h-0" style={{ "overflow-x": "hidden", "max-width": "100%" }}>
        {/* Settings button in upper left corner - always visible */}
        <div style="position: absolute; top: -5px; left: 0; z-index: 10;">
          <TimeSeriesSettings
            isFleet={true}
            objectName={objectName()}
            useIconTrigger={true}
            dataSourcesOptions={dataSourcesOptions()}
            raceOptions={raceOptions()}
            legOptions={legOptions()}
            gradeOptions={gradeOptions()}
            selectedRaces={() => selectedRacesTimeseries().map(r => {
              const num = Number(r);
              return isNaN(num) ? r : num;
            })}
            selectedLegs={() => selectedLegsTimeseries().map(l => Number(l)).filter(l => !isNaN(l))}
            selectedGrades={() => selectedGradesTimeseries().map(g => Number(g)).filter(g => !isNaN(g))}
            setRaceOptions={setRaceOptions}
            setLegOptions={setLegOptions}
            setGradeOptions={setGradeOptions}
            toggleRaceFilter={toggleRaceFilter}
            toggleLegFilter={toggleLegFilter}
            toggleGradeFilter={toggleGradeFilter}
            filterConfig={{
              showRaces: true,
              showLegs: true,
              showGrades: false
            }}
            useUnfilteredOptions={true}
          />
        </div>
        <div class="timeseries-hover-zone">
        <div class="performance-charts-scroll-container">
          <div id="timeseries-area" style={{
            "width": "100%",
            "height": "100%",
            "min-height": "100%",
            "padding-top": "20px",
            "overflow-x": "hidden"
          }}>
          <Show when={isLoading()} fallback={
            <Show when={chartConfig() !== null && chartConfig()!.length > 0} fallback={
              <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
                <div class="mb-6">
                  <div class="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg class="w-8 h-8 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-200 mb-2">No Time Series Chart Configured</h3>
                  <p class="text-gray-500 dark:text-gray-400 mb-6 max-w-md">
                    Get started by creating your first time series chart. 
                  </p>
                </div>
                <button 
                  onClick={() => {
                    if (navigate) {
                      const dateStr = selectedDate();
                      if (dateStr) {
                        navigate(`/timeseries-builder?object_name=${objectName()}&fleet=true`);
                      } else {
                        navigate(`/timeseries-builder?object_name=${objectName()}`);
                      }
                    } else {
                      debug('TimeSeries: Cannot navigate to timeseries-builder in split view');
                    }
                  }}
                  class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors duration-200 shadow-md hover:shadow-lg"
                >
                  Create Time Series Chart
                </button>
              </div>
            }>
              <Show when={effectiveTimeWindow() > 0} fallback={
                <TimeSeries
                  chart={chartConfig()}
                  datasetEventTimeRange={effectiveXRange()}
                  showLegendTable={true}
                />
              }>
                <PlaybackTimeSeries
                  charts={chartConfig()!}
                  timeWindowMinutes={effectiveTimeWindow()}
                  selectedTime={selectedTime()}
                />
              </Show>
            </Show>
          }>
            {(() => {
              debug('🕐 TimeSeriesPage: Rendering LoadingOverlay');
              return (
                <LoadingOverlay
                  message={loadingMessage()}
                  showProgress={true}
                  progress={loadingProgress()}
                  progressMessage={loadingMessage()}
                />
              );
            })()}
          </Show>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
