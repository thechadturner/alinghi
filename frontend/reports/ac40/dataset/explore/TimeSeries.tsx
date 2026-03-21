import { createSignal, onMount, onCleanup, Show, createEffect, untrack } from "solid-js";
import { useNavigate } from "@solidjs/router";
import LoadingOverlay from "../../../../components/utilities/Loading";
import DataNotFoundMessage from "../../../../components/utilities/DataNotFoundMessage";
import TimeSeries from "../../../../components/charts/TimeSeries";
import TimeSeriesSettings from "../../../../components/menus/TimeSeriesSettings";

import { user } from "../../../../store/userStore";
import { persistantStore } from "../../../../store/persistantStore";
const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId, selectedSourceName, selectedPage, setSelectedPage } = persistantStore;

import { getData, setupMediaContainerScaling } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { huniDBStore } from "../../../../store/huniDBStore";
import { warn, error as logError, debug, info } from "../../../../utils/console";
import { logPageLoad } from "../../../../utils/logging";
import { registerSelectionStoreCleanup, cutEvents, isCut } from "../../../../store/selectionStore";
import { selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries, setSelectedRacesTimeseries, setSelectedLegsTimeseries, setSelectedGradesTimeseries, setHasChartsWithOwnFilters } from "../../../../store/filterStore";
import { selectedTime } from "../../../../store/playbackStore";
import { applyDataFilter, extractFilterOptions } from "../../../../utils/dataFiltering";

interface TimeSeriesPageProps {
  objectName?: string;
  [key: string]: any;
}

export default function TimeSeriesPage(props: TimeSeriesPageProps) {
  debug('🕐 TimeSeriesPage: Component initialized');
  debug('🕐 TimeSeriesPage: Props received:', props);

  // Never use literal 'default'; let fetch resolve from object/names when empty
  const objectName = (): string => props?.objectName ?? selectedPage() ?? '';
  debug('🕐 TimeSeriesPage: Object name resolved to:', objectName());

  // Initialize navigation
  let navigate: ((path: string) => void) | null;
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // If useNavigate fails (e.g., in split view), set navigate to null
    navigate = null;
  }

  // Race and leg filter state
  const [raceOptions, setRaceOptions] = createSignal<(number | string)[]>([]);
  const [legOptions, setLegOptions] = createSignal<number[]>([]);
  const [gradeOptions, setGradeOptions] = createSignal<number[]>([]);

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

  // Chart configuration and data state
  const [chartConfig, setChartConfig] = createSignal<any[] | null>(null);
  const [originalChartConfig, setOriginalChartConfig] = createSignal<any[] | null>(null); // Store unfiltered data
  const [isLoading, setIsLoading] = createSignal<boolean>(true);

  // Dataset event time range for x-scale limiting
  const [datasetEventTimeRange, setDatasetEventTimeRange] = createSignal<{ start: Date; end: Date } | null>(null);

  // Progress tracking for loading overlay
  const [loadingProgress, setLoadingProgress] = createSignal<number>(0);
  const [loadingMessage, setLoadingMessage] = createSignal<string>("Loading time series configuration...");
  /** True when we have chart config but data/channels could not be found (API or HuniDB). */
  const [dataNotFound, setDataNotFound] = createSignal(false);
  // Progress monitoring interval (declared outside function for cleanup)
  let progressCheckInterval: ReturnType<typeof setInterval> | null = null;

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

  // Filter reactivity effect – explore/timeseries uses only race/leg (and cut), not global grade or TWA
  let lastFilterState = '';
  createEffect(() => {
    const races = selectedRacesTimeseries();
    const legs = selectedLegsTimeseries();
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();

    const origConfig = untrack(() => originalChartConfig());
    if (!origConfig) return;

    const cutSignature = currentIsCut && currentCutEvents ? currentCutEvents.map(r =>
      typeof r === 'number' ? r : `${r.start_time}-${r.end_time}`
    ).join('|') : '';
    const filterSignature = `${races.join(',')}-${legs.join(',')}-${cutSignature}`;
    if (filterSignature === lastFilterState) {
      debug('🕐 TimeSeriesPage: Filter state unchanged, skipping re-filter');
      return;
    }
    lastFilterState = filterSignature;

    debug('🕐 TimeSeriesPage: Filter signals changed, applying filters locally (race/leg/cut only):', {
      races, legs, isCut: currentIsCut, cutRangesCount: currentCutEvents?.length || 0
    });

    // Do not pass global grade or TWA – explore/timeseries uses only race, leg, and cut
    applyFiltersToCharts(origConfig, [], races, legs, []).then(filteredChartConfig => {
      setChartConfig(filteredChartConfig);
    });
  });

  // Helper: detect if any chart has its own filters
  const hasChartFilters = (charts: any[]): boolean =>
    Array.isArray(charts) && charts.some((c: any) => Array.isArray(c?.filters) && c.filters.length > 0);

  // Signal to store event time ranges for race/leg filtering
  const [eventTimeRanges, setEventTimeRanges] = createSignal<Array<{ start: number; end: number }>>([]);
  const [raceTimeRanges, setRaceTimeRanges] = createSignal<Array<{ start: number; end: number }>>([]);
  const [legTimeRanges, setLegTimeRanges] = createSignal<Array<{ start: number; end: number }>>([]);

  // Query events for race/leg filters and get time ranges
  const fetchEventTimeRanges = async (races: (number | string)[], legs: number[]) => {
    if (races.length === 0 && legs.length === 0) {
      setEventTimeRanges([]);
      setRaceTimeRanges([]);
      setLegTimeRanges([]);
      return;
    }

    try {
      const className = selectedClassName();
      const datasetId = selectedDatasetId();
      const projectId = selectedProjectId();
      const sourceId = selectedSourceId();

      if (!className || !datasetId || !projectId || !sourceId) {
        setEventTimeRanges([]);
        setRaceTimeRanges([]);
        setLegTimeRanges([]);
        return;
      }

      const db = await huniDBStore.getDatabase(className.toLowerCase());
      const { TableNames, escapeTableName } = await import('../../../../store/huniDBTypes');
      const tableName = TableNames.events;
      const escapedTableName = escapeTableName(tableName);

      const raceRanges: Array<{ start: number; end: number }> = [];
      const legRanges: Array<{ start: number; end: number }> = [];

      // Query race events
      if (races.length > 0) {
        const raceConditions: string[] = [];
        const raceParams: any[] = [datasetId, projectId, sourceId];

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
              raceRanges.push({ start, end });
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
        let legEvents = await db.query<any>(legSql, [datasetId, projectId, sourceId, ...legs]);

        // If no results with 'leg', try without event_type filter
        if (legEvents.length === 0) {
          legSql = `
            SELECT start_time, end_time
            FROM ${escapedTableName}
            WHERE dataset_id = ? AND project_id = ? AND source_id = ?
              AND CAST(json_extract(tags, '$.Leg_number') AS INTEGER) IN (${legPlaceholders})
          `;
          legEvents = await db.query<any>(legSql, [datasetId, projectId, sourceId, ...legs]);
        }

        for (const event of legEvents) {
          const start = typeof event.start_time === 'number' ? event.start_time : new Date(event.start_time).getTime();
          const end = typeof event.end_time === 'number' ? event.end_time : new Date(event.end_time).getTime();

          if (!isNaN(start) && !isNaN(end) && isFinite(start) && isFinite(end)) {
            legRanges.push({ start, end });
          }
        }
      }

      // Store race and leg ranges separately
      setRaceTimeRanges(raceRanges);
      setLegTimeRanges(legRanges);

      // If both races and legs are selected, find intersection (overlapping ranges)
      // Otherwise, use whichever is selected
      let finalRanges: Array<{ start: number; end: number }> = [];
      if (races.length > 0 && legs.length > 0) {
        // Find intersection: data must be within both a race range AND a leg range
        for (const raceRange of raceRanges) {
          for (const legRange of legRanges) {
            // Find overlap between race and leg ranges
            const overlapStart = Math.max(raceRange.start, legRange.start);
            const overlapEnd = Math.min(raceRange.end, legRange.end);
            if (overlapStart <= overlapEnd) {
              finalRanges.push({ start: overlapStart, end: overlapEnd });
            }
          }
        }
      } else if (races.length > 0) {
        finalRanges = raceRanges;
      } else if (legs.length > 0) {
        finalRanges = legRanges;
      }

      setEventTimeRanges(finalRanges);
    } catch (error) {
      logError('🕐 TimeSeriesPage: Error fetching event time ranges:', error);
      setEventTimeRanges([]);
    }
  };

  // Helper: apply filters to chart config. Explore/timeseries does not use global grade or TWA (only race/leg/cut).
  const applyFiltersToCharts = async (charts: any[], globalFilters: string[] = [], globalRaces: number[] = selectedRacesTimeseries() as any, globalLegs: number[] = selectedLegsTimeseries() as any, globalGrades: number[] = []): Promise<any[]> => {
    // Check if charts have their own filters - if so, don't apply global filters
    if (hasChartFilters(charts)) {
      return charts;
    }

    // Fetch event time ranges if race/leg filters are selected
    const races = globalRaces.map(r => {
      const num = Number(r);
      return isNaN(num) ? r : num;
    });
    const legs = globalLegs.map(l => Number(l)).filter(l => !isNaN(l));

    let ranges: Array<{ start: number; end: number }> = [];
    // Always call fetchEventTimeRanges to ensure signal is cleared when filters are empty
    await fetchEventTimeRanges(races, legs);
    // Read the signal after it's been updated (this now contains the intersection when both are selected)
    ranges = eventTimeRanges();

    // Check if we need to filter by cut ranges
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    const shouldFilterByCut = currentIsCut && currentCutEvents && currentCutEvents.length > 0;

    // Get the original unfiltered config to ensure we always filter from unfiltered data
    const origConfig = originalChartConfig();
    if (!origConfig) {
      // If no original config, return charts as-is
      return charts;
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

    return charts.map((chart: any, chartIndex: number) => ({
      ...chart,
      series: chart.series.map((series: any, seriesIndex: number) => {
        // Always use original unfiltered data from originalChartConfig
        const key = `${chartIndex}_${seriesIndex}`;
        const originalData = originalDataMap.get(key) || series.data || [];

        // Apply unified filtering with explicit filter values to prevent circular dependencies.
        // Explore Timeseries never applies selection/range/cut (forceSelection: false) so the full dataset
        // is always shown unless the user explicitly selects race/leg filters. Zoom/brush on the chart
        // only changes the x-domain; it does not remove data.
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
  };


  // Fetch chart configuration and ensure data is available
  const fetchChartConfigAndData = async () => {
    debug('🕐 TimeSeriesPage: fetchChartConfigAndData started');
    try {
      setIsLoading(true);
      setDataNotFound(false);
      setLoadingProgress(0);
      setLoadingMessage("Initializing...");
      debug('🕐 TimeSeriesPage: Set loading to true');

      // 1. Resolve chart object name: use explicit/selected name, or first available from list (never hardcode "default")
      setLoadingProgress(10);
      setLoadingMessage("Fetching chart configuration...");
      // Resolve chart name from props/selectedPage, or fetch object/names (never assume 'default' exists)
      let nameToUse: string | null = props?.objectName || selectedPage() || null;
      if (nameToUse === 'default' || nameToUse === '') nameToUse = null;
      if (!nameToUse) {
        const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=timeseries`;
        const namesResponse = await getData(namesUrl);
        const namesList = namesResponse?.success && Array.isArray(namesResponse?.data) ? namesResponse.data as { object_name: string }[] : [];
        if (namesList.length > 0) {
          const preferred = selectedPage() || props?.objectName;
          const inList = preferred ? namesList.find((n: { object_name: string }) => (n.object_name || '').toLowerCase() === (preferred || '').toLowerCase()) : null;
          nameToUse = inList ? inList.object_name : namesList[0].object_name;
          debug('🕐 TimeSeriesPage: Resolved chart name from object/names:', nameToUse, preferred ? '(preferred in list)' : '(first)');
        }
      }
      if (!nameToUse) {
        debug('🕐 TimeSeriesPage: No chart objects found for timeseries; skipping chart config fetch');
        setChartConfig(null);
        setDataNotFound(false);
        setIsLoading(false);
        return;
      }

      const apiUrl = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=timeseries&object_name=${encodeURIComponent(nameToUse)}`;
      debug('🕐 TimeSeriesPage: Fetching chart config from:', apiUrl);

      let response = await getData(apiUrl);
      setLoadingProgress(25);

      // If requested name has no chart_info, try first available from object/names (e.g. 'default' or deleted chart)
      if ((!response.success || !response.data?.chart_info || response.data.chart_info.length === 0) && nameToUse) {
        const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=timeseries`;
        const namesResponse = await getData(namesUrl);
        const namesList = namesResponse?.success && Array.isArray(namesResponse?.data) ? namesResponse.data as { object_name: string }[] : [];
        if (namesList.length > 0 && namesList[0].object_name !== nameToUse) {
          nameToUse = namesList[0].object_name;
          debug('🕐 TimeSeriesPage: Requested chart missing config, using first from list:', nameToUse);
          response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=timeseries&object_name=${encodeURIComponent(nameToUse)}`);
        }
      }

      debug('🕐 TimeSeriesPage: Chart config response received:', {
        success: response.success,
        hasData: !!response.data,
        hasChartInfo: !!(response.data && response.data.chart_info),
        chartInfoLength: response.data?.chart_info?.length || 0
      });

      if (!response.success || !response.data || !response.data.chart_info || response.data.chart_info.length === 0) {
        logError('🕐 TimeSeriesPage: Failed to fetch chart configuration', {
          success: response.success,
          hasData: !!response.data,
          hasChartInfo: !!(response.data && response.data.chart_info),
          chartInfoLength: response.data?.chart_info?.length ?? 0,
          objectName: nameToUse,
          datasetId: selectedDatasetId(),
          projectId: selectedProjectId(),
          className: selectedClassName()
        });
        setChartConfig(null);
        setDataNotFound(false);
        setIsLoading(false);
        return;
      }

      const chartObjects = response.data.chart_info;
      debug('🕐 TimeSeriesPage: Processing chart objects:', chartObjects.length, 'charts');

      // CRITICAL: Log channel names from API response to verify case
      debug(`[TimeSeriesPage] 🔍 CHART OBJECTS FROM API:`, {
        chartObjectsCount: chartObjects.length,
        sampleChart: chartObjects[0] ? {
          seriesCount: chartObjects[0].series?.length || 0,
          series: chartObjects[0].series?.map((s: any) => ({
            xaxisName: s.xaxis?.name,
            yaxisName: s.yaxis?.name,
            colorChannelName: s.colorChannel?.name,
            xaxisCase: s.xaxis?.name ? { hasUpperCase: /[A-Z]/.test(s.xaxis.name), isLowercase: s.xaxis.name === s.xaxis.name.toLowerCase() } : null,
            yaxisCase: s.yaxis?.name ? { hasUpperCase: /[A-Z]/.test(s.yaxis.name), isLowercase: s.yaxis.name === s.yaxis.name.toLowerCase() } : null
          })) || []
        } : null,
        note: 'These channel names come directly from the database/API. If lowercase here, they are stored lowercase in the database.'
      });

      // Update global flag for SelectionBanner based on chart-level filters
      try {
        const chartsHaveOwnFilters = Array.isArray(chartObjects) && chartObjects.some(c => Array.isArray(c?.filters) && c.filters.length > 0);
        setHasChartsWithOwnFilters(!!chartsHaveOwnFilters);
      } catch (_) { }

      // Persist loaded chart name to store so user settings (API) has it for next time
      try {
        setSelectedPage(nameToUse);
      } catch (_) { }

      // 2. Extract required channels from all chart configurations (deduplicate case-insensitively)
      const requiredChannels: string[] = [];
      const seenLower = new Set<string>();
      const addChannel = (name: string) => {
        if (!name || typeof name !== 'string') return;
        const key = name.toLowerCase();
        if (seenLower.has(key)) return;
        seenLower.add(key);
        requiredChannels.push(name);
      };
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
              addChannel(series.xaxis.name);
            }
            if (series.yaxis && series.yaxis.name) {
              addChannel(series.yaxis.name);
            }
            if (series.colorChannel && series.colorChannel.name) {
              addChannel(series.colorChannel.name);
            }
          });
        }
      });

      debug(`[TimeSeriesPage] 🔍 EXTRACTED REQUIRED CHANNELS:`, {
        requiredChannels: requiredChannels,
        caseCheck: requiredChannels.map(ch => ({
          channel: ch,
          hasUpperCase: /[A-Z]/.test(ch),
          isLowercase: ch === ch.toLowerCase()
        })),
        note: 'These are extracted directly from chart objects. If lowercase here, chart objects from API have lowercase names.'
      });

      debug('🕐 TimeSeriesPage: Extracted required channels:', requiredChannels);

      // Add Datetime if not already included (case-insensitive)
      if (!requiredChannels.some(ch => ch.toLowerCase() === 'datetime')) {
        requiredChannels.unshift('Datetime');
        debug('🕐 TimeSeriesPage: Added Datetime to required channels');
      }

      // Chart component defines what it needs: timeseries uses only Race_number and Leg_number for explore filters (not Grade, Config, Foiling_state, etc.).
      const TIMESERIES_FILTER_CHANNELS = ['Race_number', 'Leg_number'];
      TIMESERIES_FILTER_CHANNELS.forEach(channel => {
        if (!requiredChannels.some(ch => ch.toLowerCase() === channel.toLowerCase())) {
          requiredChannels.push(channel);
          debug('🕐 TimeSeriesPage: Added timeseries filter channel:', channel);
        }
      });

      // Filter out known non-existent channels to prevent 404 errors
      const validChannels = requiredChannels.filter(channel => {
        const invalidChannels = []; // Only filter out channels that definitely don't exist
        return !invalidChannels.includes(channel);
      });

      debug('🕐 TimeSeriesPage: Valid channels after filtering:', validChannels);

      if (validChannels.length !== requiredChannels.length) {
        warn('🕐 TimeSeriesPage: Filtered out non-existent channels:', requiredChannels.filter(ch => !validChannels.includes(ch)));
      }

      // 3. Get dataset date for proper API calls
      setLoadingProgress(35);
      setLoadingMessage("Fetching dataset information...");
      const datasetInfoResponse = await getData(`${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`);

      if (!datasetInfoResponse.success) {
        throw new Error("Failed to fetch dataset metadata.");
      }

      const { date: rawDate, timezone: datasetTimezone } = datasetInfoResponse.data;
      const formattedDate = rawDate.replace(/-/g, "");
      // Pass timezone so channel-values API and Influx backfill use correct local→UTC date conversion (plan: fix date supplied to Influx)
      const timezoneForApi = (datasetTimezone && String(datasetTimezone).trim()) || undefined;

      // Request only the channels the chart needs. Backend unified path backfills from Influx for any of these not in file (date/timezone fix above ensures correct Influx query).
      const channelsToFetch = validChannels;

      // Fetch DATASET event to get start/end time for x-scale limiting
      try {
        const className = selectedClassName();
        const datasetId = selectedDatasetId();
        const projectId = selectedProjectId();
        const sourceId = selectedSourceId();

        if (className && datasetId && projectId && sourceId) {
          const db = await huniDBStore.getDatabase(className.toLowerCase());
          const { TableNames, escapeTableName } = await import('../../../../store/huniDBTypes');
          const tableName = TableNames.events;
          const escapedTableName = escapeTableName(tableName);

          const datasetEventSql = `
            SELECT start_time, end_time
            FROM ${escapedTableName}
            WHERE dataset_id = ? AND project_id = ? AND source_id = ?
              AND event_type = 'dataset'
            ORDER BY start_time
            LIMIT 1
          `;
          const datasetEvents = await db.query<any>(datasetEventSql, [datasetId, projectId, sourceId]);

          if (datasetEvents && datasetEvents.length > 0) {
            const event = datasetEvents[0];
            const start = typeof event.start_time === 'number' ? event.start_time : new Date(event.start_time).getTime();
            const end = typeof event.end_time === 'number' ? event.end_time : new Date(event.end_time).getTime();

            if (!isNaN(start) && !isNaN(end) && isFinite(start) && isFinite(end)) {
              setDatasetEventTimeRange({ start: new Date(start), end: new Date(end) });
              debug('🕐 TimeSeriesPage: Fetched DATASET event time range', {
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString()
              });
            }
          } else {
            debug('🕐 TimeSeriesPage: No DATASET event found, x-scale will use data extent');
            setDatasetEventTimeRange(null);
          }
        }
      } catch (error) {
        warn('🕐 TimeSeriesPage: Error fetching DATASET event, x-scale will use data extent', error);
        setDatasetEventTimeRange(null);
      }

      // 4. Fetch data for the charts using unified data store (validates against file channels)
      setLoadingProgress(40);
      setLoadingMessage("Preparing to fetch data...");
      debug('🕐 TimeSeriesPage: Fetching data for charts...');

      // Monitor unified data store progress messages
      const startProgressMonitoring = () => {
        if (progressCheckInterval) {
          clearInterval(progressCheckInterval);
        }
        progressCheckInterval = setInterval(() => {
          // Use progress message from unifiedDataStore (shows "Retrieving data..." for HuniDB cache or "Downloading data..." when fetching from API)
          const progressMessage = unifiedDataStore.getProgressMessage('ts', selectedClassName(), selectedSourceId());
          const progress = unifiedDataStore.getProgress('ts', selectedClassName(), selectedSourceId());

          if (progressMessage) {
            setLoadingMessage(progressMessage);
            if (progress !== null) {
              setLoadingProgress(progress);
            }
          } else {
            // Fallback to loading message if progress message not available
            const storeMessage = unifiedDataStore.getDataLoadingMessage('ts', selectedClassName(), selectedSourceId());
            if (storeMessage && storeMessage !== 'Loading data...') {
              setLoadingMessage(storeMessage);
            }
          }
        }, 200);
      };

      startProgressMonitoring();
      // Always fetch full dataset, apply filters locally for better control
      setLoadingProgress(50);
      setLoadingMessage("Loading data...");
      debug('🕐 TimeSeriesPage: Requesting data from unifiedDataStore (will check cache first)');
      const startTime = Date.now();
      const data = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
        'ts',
        selectedClassName(),
        selectedSourceId().toString(),
        channelsToFetch,
        {
          projectId: selectedProjectId().toString(),
          className: selectedClassName(),
          datasetId: selectedDatasetId().toString(),
          sourceName: selectedSourceName(),
          date: formattedDate,
          timezone: timezoneForApi, // So channel-values/Influx get correct UTC date (local date + timezone)
          use_v2: true, // Obsolete - kept for backward compatibility (DuckDB is now the only implementation)
          applyGlobalFilters: false // Always fetch full dataset, apply filters locally
        },
        'timeseries'
      );
      const fetchDuration = Date.now() - startTime;
      const hasDataFromFetch = Array.isArray(data) && data.length > 0;
      if (hasDataFromFetch) {
        info(`🕐 TimeSeriesPage: ✅ Data loaded successfully - ${data.length} records in ${fetchDuration}ms`, {
          recordCount: data.length,
          fetchDuration,
          channels: channelsToFetch.length,
          note: 'Check console logs above to see if data came from cache (HuniDB) or API (InfluxDB/File)'
        });
      } else {
        debug(`🕐 TimeSeriesPage: No data returned from unifiedDataStore`, {
          fetchDuration,
          channels: channelsToFetch.length,
          dataIsArray: Array.isArray(data),
          dataLength: data != null && typeof data === 'object' && 'length' in data ? (data as any).length : 'n/a'
        });
      }

      // Stop monitoring progress from unified store
      if (progressCheckInterval) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
      }

      setLoadingProgress(70);
      setLoadingMessage("Processing data...");

      // Load full filter options: populate from HuniDB or from fetched data, then read
      setLoadingProgress(75);
      setLoadingMessage("Loading filter options...");
      try {
        await extractFilterOptions(Array.isArray(data) ? data : [], 'dataset');
        const opts = await unifiedDataStore.getFilterOptions();
        debug('🕐 TimeSeriesPage: Raw filter options from store:', {
          hasOpts: !!opts,
          racesRaw: opts?.races,
          racesLength: opts?.races?.length || 0,
          legsRaw: opts?.legs || opts?.legOptions,
          legsLength: (opts?.legs || opts?.legOptions)?.length || 0,
          gradesLength: opts?.grades?.length || 0
        });

        if (opts) {
          // Process races - can include both numbers and 'TRAINING' string
          const rawRaces = opts.races || [];
          const allRaces = rawRaces
            .map((r: any) => {
              // Handle 'TRAINING' string or -1 values
              if (r === 'TRAINING' || r === 'training' || r === '-1' || r === -1) {
                return 'TRAINING';
              }
              // Convert to number if possible, otherwise keep as-is
              const num = Number(r);
              return isNaN(num) ? r : num;
            })
            .filter((v: any) => v !== null && v !== undefined && (v === 'TRAINING' || typeof v === 'number'))
            .sort((a: any, b: any) => {
              // Sort with 'TRAINING' first, then numeric races
              if (a === 'TRAINING') return -1;
              if (b === 'TRAINING') return 1;
              if (typeof a === 'number' && typeof b === 'number') return a - b;
              return String(a).localeCompare(String(b));
            });

          const allGrades = (opts.grades || []).slice().sort((a, b) => a - b);
          const allLegs = (opts.legs || opts.legOptions || []).slice().sort((a, b) => a - b);

          // Use local setters to populate race, leg, and grade options
          // Only set if we have data - don't overwrite huniDB-fetched options with empty arrays
          if (allRaces.length > 0) {
            setRaceOptions(allRaces);
          }
          if (allGrades.length > 0) {
            setGradeOptions(allGrades);
          }
          if (allLegs.length > 0) {
            setLegOptions(allLegs);
          }
          debug('🕐 TimeSeriesPage: Loaded filter options:', {
            races: allRaces.length,
            racesList: allRaces,
            legs: allLegs.length,
            grades: allGrades.length,
            note: allRaces.length === 0 ? 'Races empty - TimeSeriesSettings will fetch from huniDB' : 'Races loaded from store'
          });
        }
      } catch (error) {
        logError('🕐 TimeSeriesPage: Error loading filter options:', error);
      }


      // 5. Process data for time series format (even if empty, we still need to create chart config)
      // If data is empty, create chart config with empty data arrays so TimeSeries component can fetch its own data
      // Use same "has data" check as post-fetch: only a non-empty array counts as data (handles undefined, null, non-array, or empty array)
      const hasConfigButNoData = chartObjects.length > 0 && !hasDataFromFetch;
      setDataNotFound(hasConfigButNoData);
      if (!hasDataFromFetch) {
        debug(`🕐 TimeSeriesPage: No data to process - data is empty or undefined`, {
          dataLength: Array.isArray(data) ? data.length : (data?.length ?? 'n/a'),
          isArray: Array.isArray(data),
          validChannelsCount: validChannels.length,
          chartObjectsCount: chartObjects.length
        });
      }

      // Track if we've logged diagnostic info for the first data point
      let hasLoggedFirstPointDiagnostics = false;

      const processedData = !hasDataFromFetch ? [] : data.map((item: any, index: number) => {
        const dataPoint: any = {
          Datetime: item.Datetime
        };

        // Helper: get value from item by channel name (case-insensitive) so parquet keys like BOAT_SPEED_km_h_1 match chart keys like boat_speed_km_h_1
        const getItemChannelValue = (name: string): any => {
          if (item[name] !== undefined) return item[name];
          const key = Object.keys(item).find((k) => k.toLowerCase() === name.toLowerCase());
          return key !== undefined ? item[key] : undefined;
        };

        // Add all channel data to the data point (case-insensitive match so API/parquet keys match chart config)
        validChannels.forEach((channelName: string) => {
          const value = getItemChannelValue(channelName);
          if (value !== undefined) {
            dataPoint[channelName] = value;
          }
        });

        // Preserve filter metadata fields (these are preserved by IndexedDB but may not be in requested channels)
        // These are needed for filtering to work
        if (item.Race_number !== undefined) dataPoint.Race_number = item.Race_number;
        if (item.Leg_number !== undefined) dataPoint.Leg_number = item.Leg_number;
        if (item.Grade !== undefined) dataPoint.Grade = item.Grade;

        // Set x value from the first series xaxis (assuming all series use the same x-axis)
        // Use case-insensitive lookup for backward compatibility (data now preserves original case)
        const oneDayInMs = 24 * 60 * 60 * 1000;
        const parseTimestampToDate = (val: unknown): Date | null => {
          if (val === undefined || val === null) return null;
          if (typeof val === 'number') {
            const ms = val < 1e12 ? val * 1000 : val;
            const d = new Date(ms);
            return isNaN(d.getTime()) ? null : d;
          }
          const s = String(val).trim();
          if (!s) return null;
          let d = new Date(s);
          if (!isNaN(d.getTime())) return d;
          // Racesight format: "2026-01-16 03:32:52.000000+00:00" – normalize for parsing (space→T, trim microseconds to ms)
          const normalized = s.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\d*/, '$1T$2');
          d = new Date(normalized + (s.includes('+') ? s.slice(s.indexOf('+')) : s.includes('Z') ? 'Z' : ''));
          return isNaN(d.getTime()) ? null : d;
        };
        if (chartObjects[0].series.length > 0 && chartObjects[0].series[0].xaxis && chartObjects[0].series[0].xaxis.name) {
          const xChannelName = chartObjects[0].series[0].xaxis.name;
          let timestamp: unknown = item[xChannelName] !== undefined ? item[xChannelName] : item[xChannelName.toLowerCase()];
          if (timestamp === undefined || timestamp === null) {
            const tsVal = item.ts !== undefined ? item.ts : (item as any).Datetime;
            if (tsVal !== undefined && tsVal !== null) timestamp = tsVal;
          }
          if (index === 0 && (timestamp === undefined || timestamp === null) && !hasLoggedFirstPointDiagnostics) {
            debug(`🕐 TimeSeriesPage: X-axis channel "${xChannelName}" not found in data. Available keys:`, {
              xChannelName,
              availableKeys: Object.keys(item).slice(0, 20),
              itemSample: Object.fromEntries(Object.entries(item).slice(0, 10))
            });
            hasLoggedFirstPointDiagnostics = true;
          }
          let dateObj = parseTimestampToDate(timestamp);
          if (!dateObj && (item.ts !== undefined || item.Datetime !== undefined)) {
            dateObj = parseTimestampToDate(item.ts ?? item.Datetime) ?? null;
          }
          if (dateObj) {
            const time = dateObj.getTime();
            if (isFinite(time) && time > oneDayInMs) {
              dataPoint.x = dateObj;
            } else if (index === 0 && !hasLoggedFirstPointDiagnostics) {
              debug(`🕐 TimeSeriesPage: Invalid timestamp for x-axis:`, {
                timestamp,
                time,
                isAfterEpoch: time > oneDayInMs
              });
              hasLoggedFirstPointDiagnostics = true;
            }
          }
        }

        return dataPoint;
      });

      // Sort processed data by x-axis (timestamp) to ensure proper timeline order
      const sortedProcessedData = processedData.length > 0 ? processedData.sort((a, b) => {
        if (!a.x || !b.x) return 0;
        return a.x.getTime() - b.x.getTime();
      }) : [];

      if (processedData.length === 0) {
        debug('🕐 TimeSeriesPage: No data returned from unified store, creating chart config with empty data arrays');
      }

      // 6. Create chart objects with processed data
      // Note: Cut filtering is handled reactively in applyFiltersToCharts
      // This ensures data is re-filtered when cut events change
      const chartConfig = chartObjects.map((chart: any, index: number) => ({
        ...chart,
        chart: `chart_${index + 1}`,
        series: chart.series.map((series: any) => {
          const xName = series.xaxis.name;
          const yName = series.yaxis.name;

          // Helper function to get value with case-insensitive matching
          // Data fields now preserve original case, but fallback to lowercase for backward compatibility
          const getValue = (item: any, fieldName: string): any => {
            if (item[fieldName] !== undefined) return item[fieldName];
            // Try lowercase version as fallback (for backward compatibility with old data)
            const lowerName = fieldName.toLowerCase();
            if (item[lowerName] !== undefined) return item[lowerName];
            return undefined;
          };

          // Data is already processed with proper x values (Date objects)
          const seriesData = sortedProcessedData
            .filter((item: any) => {
              const xVal = getValue(item, xName);
              const yVal = getValue(item, yName);
              return item.x !== undefined && xVal !== undefined && yVal !== undefined;
            })
            .map((item: any) => {
              const xVal = getValue(item, xName);
              const yVal = getValue(item, yName);

              const seriesPoint: any = {
                x: item.x, // Already a Date object from processing
                y: yVal,
                Datetime: item.Datetime,
                [xName]: xVal,
                [yName]: yVal
              };

              // Preserve filter metadata fields for filtering to work (check both cases)
              const raceNumber = getValue(item, 'Race_number') ?? getValue(item, 'race_number');
              if (raceNumber !== undefined) seriesPoint.Race_number = raceNumber;

              const legNumber = getValue(item, 'Leg_number') ?? getValue(item, 'leg_number');
              if (legNumber !== undefined) seriesPoint.Leg_number = legNumber;

              const grade = getValue(item, 'Grade') ?? getValue(item, 'grade');
              if (grade !== undefined) seriesPoint.Grade = grade;

              return seriesPoint;
            });

          return { ...series, data: seriesData };
        })
      }));

      debug('🕐 TimeSeriesPage: Created chart config with', chartConfig.length, 'charts');

      // Store original unfiltered config
      setOriginalChartConfig(chartConfig);

      // Apply filters locally to create the filtered version
      setLoadingProgress(85);
      setLoadingMessage("Applying filters...");
      const filteredChartConfig = await applyFiltersToCharts(chartConfig);
      setChartConfig(filteredChartConfig);
      debug('🕐 TimeSeriesPage: Chart config set successfully');

      setLoadingProgress(95);
      setLoadingMessage("Finalizing...");

    } catch (error: unknown) {
      logError('🕐 TimeSeriesPage: Error fetching chart configuration and data:', error as any);
      setChartConfig(null);
      setLoadingMessage("Error loading data. Please try again.");
    } finally {
      // Clean up progress monitoring interval if still running
      if (progressCheckInterval) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
      }
      setLoadingProgress(100);
      // Small delay to show 100% before hiding
      setTimeout(() => {
        setIsLoading(false);
        debug('🕐 TimeSeriesPage: Set loading to false');
      }, 300);
    }
  };

  onMount(async () => {
    debug('🕐 TimeSeriesPage: onMount called');
    await logPageLoad('TimeSeries.jsx', 'Time Series Report');
    debug('🕐 TimeSeriesPage: Page load logged, starting fetchChartConfigAndData');

    // Set up dynamic scaling for media-container using the global utility
    // Use width-based scaling to fill available width when zoomed (matches Performance page)
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'TimeSeries',
      scaleToWidth: true
    });

    // Debug: Check initial selectedTime state
    debug('🕐 TimeSeriesPage: Initial selectedTime state:', {
      selectedTime: selectedTime()?.toISOString() || 'null',
      isDefault: selectedTime()?.getTime() === new Date('1970-01-01T12:00:00Z').getTime()
    });

    // Only fetch chart configuration, let TimeSeries component handle data fetching
    try {
      await fetchChartConfigAndData();
      debug('🕐 TimeSeriesPage: Chart configuration fetched successfully');

      // Debug: Check selectedTime after chart config is loaded
      debug('🕐 TimeSeriesPage: selectedTime after chart config loaded:', {
        selectedTime: selectedTime()?.toISOString() || 'null',
        isDefault: selectedTime()?.getTime() === new Date('1970-01-01T12:00:00Z').getTime()
      });
    } catch (error: any) {
      logError('🕐 TimeSeriesPage: Error in onMount:', error);
    }

    // Cleanup on unmount
    return () => {
      cleanupScaling(); // Call the cleanup function returned by the utility
    };

    debug('🕐 TimeSeriesPage: onMount completed');
  });

  onCleanup(() => {
    debug('🕐 TimeSeriesPage: onCleanup called');
    // Cleanup progress monitoring interval
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
            isFleet={false}
            useIconTrigger={true}
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
        <div class="performance-charts-scroll-container">
          <div id="timeseries-area" style={{
            "width": "100%",
            "height": "100%",
            "min-height": "100%",
            "padding-top": "20px",
            "overflow-x": "hidden"
          }}>
            <Show when={isLoading()} fallback={
              <>
                <Show when={dataNotFound()}>
                  <DataNotFoundMessage
                    builderRoute="/timeseries-builder"
                    onNavigateToBuilder={() => {
                      if (navigate) navigate(`/timeseries-builder?object_name=${objectName()}`);
                      else debug('TimeSeries: Cannot navigate to timeseries-builder in split view');
                    }}
                  />
                </Show>
                <Show when={!dataNotFound() && chartConfig() && chartConfig()!.length > 0} fallback={
                  <Show when={!dataNotFound()}>
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
                            navigate(`/timeseries-builder?object_name=${objectName()}`);
                          } else {
                            debug('TimeSeries: Cannot navigate to timeseries-builder in split view');
                          }
                        }}
                        class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg shadow-md hover:shadow-lg"
                      >
                        Add Chart
                      </button>
                    </div>
                  </Show>
                }>
                  {/* datasetEventTimeRange is static (full dataset extent). Playback time-window scrolling is handled by shared TimeSeries via playbackStore timeWindow/getDisplayWindowReferenceTime. */}
                  {(() => {
                    debug('🕐 TimeSeriesPage: Rendering TimeSeries component with chart config:', chartConfig());
                    const eventRange = datasetEventTimeRange();
                    return <TimeSeries
                      chart={chartConfig()!}
                      datasetEventTimeRange={eventRange ? { start: eventRange.start, end: eventRange.end } : undefined}
                    />;
                  })()}
                </Show>
              </>
            }>
              <LoadingOverlay
                message={loadingMessage()}
                showProgress={true}
                progress={loadingProgress()}
                progressMessage={loadingMessage()}
                containerStyle="align-items: flex-start !important; padding-top: 40vh !important;"
              />
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
