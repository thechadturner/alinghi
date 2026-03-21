import { createSignal, createEffect, onMount, onCleanup, untrack, createMemo, Show } from "solid-js";
import { createStore } from "solid-js/store";

import * as d3 from "d3";

import { 
  selectedEvents, 
  hasSelection,
  isCut,
  cutEvents,
  setCutEvents,
  selectedRange,
  selectedRanges,
  setSelectedRange,
  setSelectedRanges,
  setSelectedEvents,
  setHasSelection,
  setIsCut,
  triggerUpdate,
  setTriggerUpdate,
  clearSelection
} from "../../../store/selectionStore";
import {
  selectedRacesTimeseries,
  selectedLegsTimeseries
} from "../../../store/filterStore";

import { 
  selectedTime, 
  setSelectedTime, 
  isPlaying, 
  timeWindow,
  setIsManualTimeChange,
  isManualTimeChange,
  requestTimeControl,
  releaseTimeControl
} from "../../../store/playbackStore";

import { applyDataFilter, applyTimelineFilter, filterByTwa } from "../../../utils/dataFiltering";
import { processD3CalculationsWithWorker } from "../../../utils/workerManager";
import { unifiedDataStore } from "../../../store/unifiedDataStore";
import { persistantStore } from "../../../store/persistantStore";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";
import { sourcesStore } from "../../../store/sourcesStore";
import { selectedDate as selectionSelectedDate } from "../../../store/selectionStore";
import { themeStore } from "../../../store/themeStore";
import { getData, formatTime } from "../../../utils/global";
import { warn, error as logError, debug, info } from "../../../utils/console";
import { createD3EventColorScale, debugColorScale } from "../../../utils/colorScale";
import { hasVideoMenu } from "../../../store/globalStore";
import { renderSegmentedTimeSeries } from "./renderers/SegmentedTimeSeriesRenderer";
import { renderContinuousTimeSeries } from "./renderers/ContinuousTimeSeriesRenderer";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../store/datasetTimezoneStore";
import Loading from "../../utilities/Loading";

interface MapTimeSeriesProps {
  samplingFrequency?: number;
  onMapUpdate?: () => void;
  onStableSelectedTimeChange?: (time: Date) => void;
  liveMode?: boolean;
  maptype?: string;
  liveData?: any;
  mapFilterScope?: 'full' | 'raceLegOnly';
  /** When true, only show data within video (media) windows and disable brushing (e.g. for explore/video page). */
  videoOnly?: boolean;
  /** When false, brushing is disabled and only click-to-seek is allowed. Default true. */
  brushEnabled?: boolean;
  /** Called when timeline loading state changes (e.g. for parent to show a waiting overlay). */
  onLoadingChange?: (loading: boolean) => void;
  [key: string]: any;
}

export default function MapTimeSeries(props: MapTimeSeriesProps) {
  let chartContainer: HTMLElement | null = null;
  
  // Mounted flag to prevent effects from running after unmount
  let isMounted = true;
  
  // Destructure props (keep maptype reactive). Avoid destructuring cachedData to preserve reactivity
  const { samplingFrequency, onMapUpdate, onStableSelectedTimeChange, liveMode } = props;
  // Read maptype directly from store to ensure reactivity when color option changes
  const { colorType: maptype } = persistantStore;
  // Make liveData reactive - it's either a function (memo/signal) or undefined
  const liveData = () => {
    const data = props.liveData;
    return typeof data === 'function' ? data() : data;
  };
  
  // Local state for data
  const [values, setValues] = createSignal<any[]>([]);
  const [originalValues, setOriginalValues] = createSignal<any[]>([]); // Store unfiltered data
  
  // Source color state
  const [sourceColor, setSourceColor] = createSignal<string | null>(null);
  const [sourceColorLoaded, setSourceColorLoaded] = createSignal(false);
  
  // Media state
  const [mediaWindows, setMediaWindows] = createSignal<any[]>([]);
  const [datasetTimezone, setDatasetTimezone] = createSignal<string | null>(null);
  
  // Timeline loading state (e.g. when used standalone on explore/video)
  const [isTimelineLoading, setIsTimelineLoading] = createSignal(false);

  // Notify parent when timeline loading state changes (e.g. for full-height waiting overlay)
  createEffect(() => {
    const loading = isTimelineLoading();
    props.onLoadingChange?.(loading);
  });

  // Use defaultChannelsStore for channel names (automatically updates when class/project changes)
  const { bspName, twsName, twdName, twaName, latName, lngName, hdgName, vmgName, vmgPercName, isReady: defaultChannelsReady } = defaultChannelsStore;
  
  // Set up timezone from dataset
  const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    let datasetId: number | null = null;
    
    if (typeof selectedDatasetId === 'function') {
      const dsId = selectedDatasetId();
      datasetId = dsId ? Number(dsId) : null;
    } else if (selectedDatasetId) {
      datasetId = Number(selectedDatasetId);
    }

    if (className && projectId && datasetId && datasetId > 0) {
      await setCurrentDataset(className, projectId, datasetId);
      const tz = getCurrentDatasetTimezone();
      setDatasetTimezone(tz);
    } else {
      setDatasetTimezone(null);
    }
  });
  
  // Log when default channels become ready
  createEffect(() => {
    const ready = defaultChannelsReady();
    const channels = defaultChannelsStore.defaultChannels();
    if (ready && channels) {
      debug('MapTimeSeries: Default channels ready', {
        bsp: bspName(),
        tws: twsName(),
        twd: twdName(),
        twa: twaName(),
        lat: latName(),
        lng: lngName(),
        hdg: hdgName(),
        allChannels: channels
      });
    }
  });
  
  // Debug initial state
  debug('MapTimeSeries: Initial hasVideoMenu state:', hasVideoMenu());
  
  // Note: When selectedEvents changes, selectionStore automatically populates selectedRanges
  // with the event time ranges from HuniDB cache. The ContinuousTrackRenderer uses
  // selectedRanges to draw selection overlays on top of the existing map data.
  // Event_id is no longer assigned to data points - instead, getColor/getThickness functions
  // use timestamp comparisons against selectedRanges to determine if a point is selected.
  // This avoids expensive operations and improves selection performance.
  
  // Function to get source color from sourcesStore
  const fetchSourceColor = () => {
    try {
      const { selectedSourceId } = persistantStore;
      const sourceId = selectedSourceId();
      
      if (!sourceId) {
        return "darkblue"; // Default color
      }
      
      // Wait for sourcesStore to be ready
      if (!sourcesStore.isReady()) {
        return null; // Return null if not ready yet (will retry)
      }
      
      const sourceName = sourcesStore.getSourceName(sourceId);
      if (!sourceName) {
        return "darkblue"; // Default color if source not found
      }
      
      const color = sourcesStore.getSourceColor(sourceName);
      return color || "darkblue"; // Default color if no color set
    } catch (error: any) {
      debug('Error getting source color from sourcesStore:', error);
      return "darkblue"; // Default color
    }
  };

  // Load source color when component initializes or when source changes - wait for sourcesStore to be ready
  createEffect(() => {
    if (!isMounted) return;
    
    // Check if sourcesStore is ready
    const storeReady = sourcesStore.isReady();
    const { selectedSourceId } = persistantStore;
    const sourceId = selectedSourceId();
    
    // Wait for sourcesStore to be ready before setting source color
    if (!storeReady) {
      // Store not ready yet - keep loaded state as false
      setSourceColorLoaded(false);
      return;
    }
    
    // Store is ready - fetch color (will return default "darkblue" if no sourceId)
    const color = fetchSourceColor();
    if (color) {
      if (!isMounted) return;
      setSourceColor(color);
      setSourceColorLoaded(true);
      debug('MapTimeSeries: Source color loaded:', color, 'for sourceId:', sourceId || 'none (using default)');
    } else {
      // If fetchSourceColor returns null (shouldn't happen when store is ready), use default
      if (!isMounted) return;
      setSourceColor("darkblue");
      setSourceColorLoaded(true);
      debug('MapTimeSeries: Using default source color (darkblue)');
    }
  });
  
  // Clear selectedTime when dataset or date changes
  let lastDatasetId = null;
  let lastSelectedDate = null;
  let isFirstRun = true;
  createEffect(() => {
    if (!isMounted) return;
    const { selectedDatasetId, selectedDate } = persistantStore;
    const currentDatasetId = selectedDatasetId();
    const currentSelectedDate = selectedDate();
    
    // On initial mount, just store the values but don't clear selectedTime
    // This allows the onMount logic to set selectedTime from data
    if (isFirstRun) {
      lastDatasetId = currentDatasetId;
      lastSelectedDate = currentSelectedDate;
      isFirstRun = false;
      
      // If we have a valid dataset on initial mount, ensure selectedTime will be set
      // The onMount logic will handle setting it from the first data point
      if (currentDatasetId > 0 || (currentSelectedDate && currentSelectedDate !== '')) {
        debug('⏰ MapTimeSeries: Initial mount with valid dataset/date, selectedTime will be set from data', {
          datasetId: currentDatasetId,
          date: currentSelectedDate
        });
      }
      return;
    }
    
    // Check if dataset or date changed (after initial mount)
    const datasetChanged = lastDatasetId !== null && lastDatasetId !== currentDatasetId;
    const dateChanged = lastSelectedDate !== null && lastSelectedDate !== currentSelectedDate;
    
    // If dataset or date changed, clear selectedTime
    if (datasetChanged || dateChanged) {
      debug('⏰ MapTimeSeries: Dataset or date changed, clearing selectedTime', {
        datasetChanged,
        dateChanged,
        oldDatasetId: lastDatasetId,
        newDatasetId: currentDatasetId,
        oldDate: lastSelectedDate,
        newDate: currentSelectedDate
      });
      
      if (requestTimeControl('maptimeseries')) {
        const defaultTime = new Date('1970-01-01T12:00:00Z');
        setSelectedTime(defaultTime, 'maptimeseries');
        debug('⏰ MapTimeSeries: selectedTime cleared to default');
      }
    }
    
    lastDatasetId = currentDatasetId;
    lastSelectedDate = currentSelectedDate;
  });
  
  // Media fetching functions
  const toYyyyMmDd = (d) => {
    try {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    } catch (e) {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    }
  };

  const fetchMediaSources = async (dateYmd) => {
    try {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const url = `/api/media/sources?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(dateYmd)}`;
      debug('MapTimeSeries: Fetching media sources from:', url);
      const response = await getData(url);
      if (!response.success || response.data == null) return [];
      const list = Array.isArray(response.data) ? response.data : [];
      const sources = list.map((r, i) => ({
        id: r.id || r.media_source || r.name || `src_${i}`,
        name: r.name || r.media_source || r.id || `Source ${i + 1}`,
      }));
      debug('MapTimeSeries: Raw media sources response:', response.data);
      debug('MapTimeSeries: Processed media sources:', sources);
      return sources;
    } catch (error: any) {
      logError('MapTimeSeries: Error fetching media sources:', error);
      return [];
    }
  };

  const fetchMediaForSource = async (sourceId, dateYmd) => {
    try {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const url = `/api/media?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(dateYmd)}&media_source=${encodeURIComponent(sourceId)}`;
      debug(`MapTimeSeries: Fetching media for source ${sourceId} from:`, url);
      const response = await getData(url);
      if (!response.success || response.data == null) return [];
      const list = Array.isArray(response.data) ? response.data : [];
      debug(`MapTimeSeries: Raw media API response for source ${sourceId}:`, { 
        responseLength: list.length,
        sampleRecord: list[0],
        allRecords: list
      });
      
      // Records expected to contain start_time/end_time or start/end
      const processedMedia = list.map((r) => {
        const start = r.start_time || r.start || r.begin || r.ts_start;
        const end = r.end_time || r.end || r.finish || r.ts_end;
        const startDate = start ? new Date(start) : null;
        const endDate = end ? new Date(end) : null;
        if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) return null;
        const fileName = r.file_name || r.file || r.filename || '';
        const id = r.media_id || r.id || undefined;
        return { start: startDate, end: endDate, fileName, id, ...r };
      }).filter(Boolean);
      
      debug(`MapTimeSeries: Processed media for source ${sourceId}:`, processedMedia);
      return processedMedia;
    } catch (error: any) {
      logError('MapTimeSeries: Error fetching media for source:', error);
      return [];
    }
  };

  const fetchMediaData = async (dateYmd) => {
    try {
      const { selectedClassName, selectedProjectId } = persistantStore;
      debug('MapTimeSeries: Fetching media data with:', { className: selectedClassName(), projectId: selectedProjectId(), dateYmd });
      
      const sources = await fetchMediaSources(dateYmd);
      debug('MapTimeSeries: Fetched media sources:', sources.length, sources);
      
      if (sources.length === 0) {
        debug('MapTimeSeries: No media sources found, will use test data');
        setMediaWindows([]);
        return;
      }
      
      const allWindows = [];
      for (const source of sources) {
        debug(`MapTimeSeries: Fetching media for source:`, source);
        const media = await fetchMediaForSource(source.id, dateYmd);
        debug(`MapTimeSeries: Fetched ${media.length} media items for source ${source.id}:`, media);
        
        // Add sourceId to each media item and push to allWindows
        media.forEach((item) => {
          allWindows.push({
            sourceId: source.id,
            ...item
          });
        });
      }
      
      debug('MapTimeSeries: Fetched media windows', { count: allWindows.length, windows: allWindows });
      setMediaWindows(allWindows);
    } catch (error: any) {
      logError('MapTimeSeries: Error fetching media data:', error);
    }
  };

  
  // Theme-aware color functions
  const getThemeColor = (lightColor, darkColor) => {
    return themeStore.isDark() ? darkColor : lightColor;
  };
  
  const getThemeColors = () => {
    return {
      // Chart background and text - match header/sidebar in dark mode
      background: getThemeColor('#ffffff', '#0f172a'),
      text: getThemeColor('#111827', '#f8fafc'),
      textSecondary: getThemeColor('#6b7280', '#cbd5e1'),
      
      // Grid and axes
      grid: getThemeColor('#e5e7eb', '#475569'),
      axis: getThemeColor('#374151', '#cbd5e1'),
      
      // Chart elements
      cutDataIndicator: getThemeColor('#ff6b6b', '#f87171'),
      verticalLine: getThemeColor('#000000', '#ffffff'),
      
      // Data colors (keeping existing color scheme but making them theme-aware)
      lightGrey: getThemeColor('#d3d4d6', '#64748b'),
      red: getThemeColor('#ef4444', '#f87171'),
      lightGreen: getThemeColor('#86efac', '#34d399'),
      green: getThemeColor('#22c55e', '#10b981'),
      yellow: getThemeColor('#eab308', '#fbbf24'),
      blue: getThemeColor('#3b82f6', '#60a5fa'),
      lightBlue: getThemeColor('#93c5fd', '#93c5fd')
    };
  };
  
  debug('MapTimeSeries: Props received:', {
    maptype: maptype(),
    samplingFrequency: samplingFrequency
  });
  
  const [xRange, setRange] = createStore({ min: 0, max: 100 });
  
  // Add flags to prevent infinite loops
  let isDrawing = false;
  let isBrushActive = false;
  let isBrushSelectionActive = false; // Flag to prevent main effect from overriding brush-filtered data
  let brushTimeout = null;
  let isClearingBrush = false;
  let isFetching = false;
  let isUpdatingMap = false;
  let isInitialized = false; // Flag to prevent premature renders during initialization
  let isProgrammaticallyUpdatingBrush = false; // Flag to prevent infinite loops when updating brush programmatically
  let isMapSettingSelectedRange = false; // Flag to track when map components are setting selectedRange
  let lastMapUpdateSignature = null; // Dedupe consecutive onMapUpdate payloads
  let lastFilterSignature = ''; // Track filter state to detect changes
  let drawChartCallCount = 0; // Track drawChart calls to detect infinite loops
  let lastDrawChartDataSignature = ''; // Track data signature to prevent redrawing with same data
  
  // Resize detection variables
  let resizeObserver = null;
  let mutationObserver = null;

  // Data fetching function - use cached data from MapContainer or fetch fresh data
  const fetchData = async () => {
    try {
      // In live mode, use streaming data directly instead of fetching from IndexedDB
      if (liveMode) {
        const streamingData = liveData() ? (Array.isArray(liveData()) ? liveData() : []) : [];
        debug('MapTimeSeries: Using streaming data in live mode:', streamingData.length, 'points');
        
        // In live mode, always return (even if empty) to prevent IndexedDB fetch
        if (streamingData.length > 0) {
          // Process streaming data similar to cached data
          // Store original unfiltered data (event_id assignment no longer needed - using selectedRanges)
          setOriginalValues(streamingData);
          
          // Map does not use global grade or TWA filters (scatter/probability only); only race/leg/cut
          const states: string[] = [];
          const grades: number[] = [];
          const races = selectedRacesTimeseries();
          const legs = selectedLegsTimeseries();
          const shouldFilter = isCut() || races.length > 0 || legs.length > 0;
          
          let filteredData;
          if (shouldFilter) {
            filteredData = filterByTwa(streamingData, states, races, legs, grades);
            debug('MapTimeSeries: Filtered streaming data from', streamingData.length, 'to', filteredData.length, 'points');
          } else {
            filteredData = streamingData;
            debug('MapTimeSeries: Passing full streaming dataset with', streamingData.length, 'points to renderer');
          }
          
          // Store filtered data for map display
          setValues(filteredData);
          
          return filteredData;
        }
        
        // No streaming data available yet - return empty array (don't fall through to IndexedDB)
        debug('MapTimeSeries: No streaming data available yet');
        return [];
      }
      
      // Not in live mode - proceed with normal static data fetching
      const cachedDataArray = Array.isArray(props.cachedData) ? props.cachedData : [];
      
      if (cachedDataArray.length > 0) {
        debug('MapTimeSeries: Using cached data from MapContainer:', cachedDataArray.length, 'points');
        
        // Extract media data from cached data if available
        const mediaData = cachedDataArray.filter(d => d.media_source || d.start_time || d.end_time);
        if (mediaData.length > 0) {
          const processedMedia = mediaData.map(item => ({
            sourceId: item.media_source || 'unknown',
            start: new Date(item.start_time),
            end: new Date(item.end_time),
            fileName: item.file_name || 'unknown',
            id: item.media_id || item.id
          }));
          setMediaWindows(processedMedia);
        }
        
        // Store original unfiltered data (event_id assignment no longer needed - using selectedRanges)
        setOriginalValues(cachedDataArray);
        
        // Map does not use global grade or TWA filters; only race/leg/cut
        const statesCached: string[] = [];
        const gradesCached: number[] = [];
        const racesCached = selectedRacesTimeseries();
        const legsCached = selectedLegsTimeseries();
        const shouldFilterCached = isCut() || racesCached.length > 0 || legsCached.length > 0;
        
        let filteredData;
        if (shouldFilterCached) {
          filteredData = filterByTwa(cachedDataArray, statesCached, racesCached, legsCached, gradesCached);
          debug('MapTimeSeries: Filtered data from', cachedDataArray.length, 'to', filteredData.length, 'points');
        } else {
          // No filters and not cut - pass all data to renderer
          filteredData = cachedDataArray;
          debug('MapTimeSeries: Passing full dataset with', cachedDataArray.length, 'points to renderer');
        }
        
        // Store filtered data for map display
        setValues(filteredData);
        
        // Extract dataset date from cached data for media fetching
        const firstDataPoint = cachedDataArray[0];
        if (firstDataPoint?.Datetime) {
          const rawDate = new Date(firstDataPoint.Datetime).toISOString().split('T')[0];
          const formattedDate = rawDate.replace(/-/g, "");
          window.datasetDate = formattedDate;
        }
        
        // Send initial data immediately to map (before debounced effect)
        if (onMapUpdate && filteredData.length > 0 && !window.hasInitialDataSent) {
          debug('MapTimeSeries: Sending initial data immediately to map:', filteredData.length, 'points');
          window.hasInitialDataSent = true;
          onMapUpdate(filteredData);
        }
        
        return filteredData; // Return filtered data for map
      }

      // No cached data from parent - try unifiedDataStore cache first (explore/video, FleetVideo when map was already loaded)
      const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceName, selectedSourceId } = persistantStore;
      const sourceIdValue = selectedSourceId();
      const datasetId = selectedDatasetId();
      if (sourceIdValue && sourceIdValue > 0 && datasetId && datasetId > 0) {
        const storeCached = unifiedDataStore.getMapDataForDatasetFromCache(
          selectedClassName(),
          selectedProjectId(),
          datasetId,
          Number(sourceIdValue)
        );
        if (storeCached && storeCached.length > 0) {
          debug('MapTimeSeries: Using data from unifiedDataStore cache (explore/video or FleetVideo):', storeCached.length, 'points');
          const mediaData = storeCached.filter((d: any) => d.media_source || d.start_time || d.end_time);
          if (mediaData.length > 0) {
            const processedMedia = mediaData.map((item: any) => ({
              sourceId: item.media_source || 'unknown',
              start: new Date(item.start_time),
              end: new Date(item.end_time),
              fileName: item.file_name || 'unknown',
              id: item.media_id || item.id
            }));
            setMediaWindows(processedMedia);
          }
          setOriginalValues(storeCached);
          const races = selectedRacesTimeseries();
          const legs = selectedLegsTimeseries();
          const shouldFilter = isCut() || races.length > 0 || legs.length > 0;
          const filteredData = shouldFilter ? filterByTwa(storeCached, [], [], races, []) : storeCached;
          setValues(filteredData);
          const first = storeCached[0];
          if (first?.Datetime) {
            const rawDate = new Date(first.Datetime).toISOString().split('T')[0];
            window.datasetDate = rawDate.replace(/-/g, '');
          }
          setIsTimelineLoading(false);
          return filteredData;
        }
      }

      // No cache - fetch fresh data
      debug('MapTimeSeries: No cached data available, fetching fresh data...');
      setIsTimelineLoading(true);
      try {
      // Validate that we have a valid sourceId
      if (!sourceIdValue || sourceIdValue <= 0) {
        warn('MapTimeSeries: No valid sourceId available, skipping data fetch');
        return [];
      }
      
      const sourceId = sourceIdValue.toString();
      const hasDatasetContext = !!(datasetId && datasetId > 0);
      let rawData: any[] = [];

      if (hasDatasetContext) {
        // Dataset context (explore/map, explore/video, FleetVideo): fetch map data immediately.
        // No need to await dataset info API first – we get date from the first data point.
        debug('MapTimeSeries: Using fetchMapDataForDataset for dataset context', { datasetId, sourceId });
        rawData = await unifiedDataStore.fetchMapDataForDataset(
          selectedClassName(),
          selectedProjectId(),
          datasetId,
          Number(sourceId)
        );
        if (rawData.length > 0 && rawData[0]?.Datetime) {
          const rawDate = new Date(rawData[0].Datetime).toISOString().split('T')[0];
          window.datasetDate = rawDate.replace(/-/g, '');
        }
      } else {
        // Day context: need formattedDate before fetch (fetchDataWithChannelCheckingFromFile uses it).
        const lat = latName() || 'Lat';
        const lng = lngName() || 'Lng';
        const twd = twdName() || 'Twd';
        const twa = twaName() || 'Twa';
        const tws = twsName() || 'Tws_kts';
        const bsp = bspName() || 'Bsp_kts';
        const hdg = hdgName() || 'Hdg';
        const requiredChannels = [
          'Datetime', lat, lng, twd, twa, tws, bsp, hdg, 'Grade', 'Vmg_perc',
          'Maneuver_type', 'Race_number', 'Leg_number', 'State'
        ];
        let formattedDate: string | null = null;
        try {
          const dsId = selectedDatasetId();
          if (dsId && dsId > 0) {
            const datasetInfoResponse = await getData(`/api/datasets/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(dsId)}`);
            const raw = datasetInfoResponse?.data?.date;
            if (raw) formattedDate = String(raw).replace(/-/g, '');
          }
        } catch (_) {}
        if (!formattedDate && selectionSelectedDate) {
          const day = selectionSelectedDate();
          if (day && typeof day === 'string') formattedDate = day.replace(/[-/]/g, '');
        }
        if (!formattedDate) {
          const { selectedDate: persistentDate } = persistantStore;
          const day = persistentDate && persistentDate();
          if (day && typeof day === 'string') formattedDate = day.replace(/[-/]/g, '');
        }
        if (!formattedDate) {
          warn('MapTimeSeries: No dataset date available, skipping data fetch for now');
          return [];
        }
        window.datasetDate = formattedDate;
        debug('MapTimeSeries: Fetching data with channels:', requiredChannels);
        rawData = await unifiedDataStore.fetchDataWithChannelCheckingFromFile(
          'map',
          selectedClassName(),
          sourceId,
          requiredChannels,
          {
            projectId: selectedProjectId(),
            className: selectedClassName(),
            datasetId: selectedDatasetId(),
            sourceName: selectedSourceName(),
            date: formattedDate,
            applyGlobalFilters: false
          },
          'mapdata'
        );
      }
      debug('MapTimeSeries: Raw data sample:', rawData.slice(0, 3).map(d => ({ 
        Datetime: d.Datetime, 
        event_id: d.event_id,
        Grade: d.Grade 
      })));
      
      if (rawData && rawData.length > 0) {
        debug('MapTimeSeries: Fetched raw data from store:', rawData.length, 'points');
        
        // Events are now loaded automatically in unifiedDataStore when mapdata is fetched
        
        // Extract media data from the raw data if available
        const mediaData = rawData.filter(d => d.media_source || d.start_time || d.end_time);
        if (mediaData.length > 0) {
          const processedMedia = mediaData.map(item => ({
            sourceId: item.media_source || 'unknown',
            start: new Date(item.start_time),
            end: new Date(item.end_time),
            fileName: item.file_name || 'unknown',
            id: item.media_id || item.id
          }));
          setMediaWindows(processedMedia);
        }
        
        // Store original unfiltered data (event_id assignment no longer needed - using selectedRanges)
        setOriginalValues(rawData);
        
        // Map does not use global grade or TWA filters; only race/leg/cut
        const statesFresh: string[] = [];
        const gradesFresh: number[] = [];
        const racesFresh = selectedRacesTimeseries();
        const legsFresh = selectedLegsTimeseries();
        const shouldFilterFresh = isCut() || racesFresh.length > 0 || legsFresh.length > 0;
        
        let filteredData;
        if (shouldFilterFresh) {
          filteredData = filterByTwa(rawData, statesFresh, racesFresh, legsFresh, gradesFresh);
          debug('MapTimeSeries: Filtered data from', rawData.length, 'to', filteredData.length, 'points');
        } else {
          // No filters and not cut - pass all data to renderer
          filteredData = rawData;
          debug('MapTimeSeries: Passing full dataset with', rawData.length, 'points to renderer');
        }
        
        // Store filtered data for map display
        setValues(filteredData);
        
        // Send initial data immediately to map (before debounced effect) - live mode
        if (onMapUpdate && filteredData.length > 0 && !window.hasInitialDataSent) {
          debug('MapTimeSeries: Sending initial streaming data immediately to map:', filteredData.length, 'points');
          window.hasInitialDataSent = true;
          onMapUpdate(filteredData);
        }
        
        return filteredData; // Return filtered data
      }

      // No data available - return empty array (e.g. source not in store, invalid sourceId, or API empty)
      if (hasDatasetContext) {
        debug('MapTimeSeries: No data available from channel-based IndexedDB (dataset context)');
      } else {
        debug('MapTimeSeries: No data from channel-based IndexedDB (no dataset selected or day view)');
      }
      return [];
      } finally {
        setIsTimelineLoading(false);
      }
    } catch (error: any) {
      logError('❌ MapTimeSeries: Error fetching data:', error);
      setIsTimelineLoading(false);
      return [];
    }
  };

  // Watch for changes in live streaming data (reactive)
  createEffect(() => {
    if (!isMounted) return;
    if (liveMode && liveData()) {
      const currentLiveData = Array.isArray(liveData()) ? liveData() : [];
      if (currentLiveData.length > 0) {
        debug('MapTimeSeries: Live data changed, updating values:', currentLiveData.length, 'points');
        // Process streaming data similar to fetchData
        if (!isMounted) return;
        setOriginalValues(currentLiveData);
        
        // Map does not use global grade or TWA filters; only race/leg/cut
        const statesLive: string[] = [];
        const gradesLive: number[] = [];
        const racesLive = selectedRacesTimeseries();
        const legsLive = selectedLegsTimeseries();
        const shouldFilterLive = isCut() || racesLive.length > 0 || legsLive.length > 0;
        
        let filteredData;
        if (shouldFilterLive) {
          filteredData = filterByTwa(currentLiveData, statesLive, racesLive, legsLive, gradesLive);
        } else {
          filteredData = currentLiveData;
        }
        
        setValues(filteredData);
      }
    }
  });
  
  // Watch for changes in cached data from MapContainer (reactive access via props)
  createEffect(() => {
    if (!isMounted) return;
    // Skip if in live mode (live data is handled above)
    if (liveMode) return;
    
    const currentCachedData = props.cachedData;
    if (currentCachedData && currentCachedData.length > 0) {
      // Only skip during the very first initialization - allow updates after that
      if (!isInitialized && !window.hasInitialDataLoad) {
        debug('MapTimeSeries: Skipping cached data effect - initial load in progress');
        return;
      }
      
      // Debounce cached data updates to prevent rapid successive calls
      if (window.cachedDataTimeout) {
        clearTimeout(window.cachedDataTimeout);
      }
      
      window.cachedDataTimeout = setTimeout(() => {
        debug('MapTimeSeries: Cached data changed, updating values:', currentCachedData.length, 'points');
        setValues(currentCachedData);
      }, 100);
    }
  });

  // Create a memo to track the data to show (MapTimeSeries always shows complete timeline for navigation)
  // Map must NOT use global Grade, State, or Twa_deg – only time, source_name, Race_number, Leg_number
  const dataToShow = createMemo(() => {
    const fullData = values();
    
    if (!fullData || fullData.length === 0) {
      return [];
    }
    
    // Apply timeline filters: race/leg only (no grade, no TWA/state) – explicit empty for states/grades
    const filteredData = applyTimelineFilter(
      fullData,
      [], // states – map never filters by TWA/State
      selectedRacesTimeseries(),
      selectedLegsTimeseries(),
      []  // grades – map never filters by Grade
    );
    
    // MapTimeSeries always shows complete timeline for navigation purposes
    // Never filter by selectedRange - only show cut events if they exist
    const currentCutEvents = cutEvents();
    if (currentCutEvents.length > 0) {
      debug('MapTimeSeries: Showing cut range data for navigation', {
        cutRangesCount: currentCutEvents.length,
        filteredDataLength: filteredData.length
      });
      const cutData = filteredData.filter(d => {
        const timestamp = getTimestamp(d);
        return currentCutEvents.some(range => {
          // Handle both time range objects and event IDs (for backward compatibility)
          if (typeof range === 'number') {
            return false; // Skip if it's an event ID instead of a time range
          }
          if (range.start_time && range.end_time) {
            const startTime = new Date(range.start_time).getTime();
            const endTime = new Date(range.end_time).getTime();
            return timestamp >= startTime && timestamp <= endTime;
          }
          return false;
        });
      });
      debug('MapTimeSeries: Cut data filtered result:', {
        cutDataLength: cutData.length,
        firstPoint: cutData[0]?.Datetime,
        lastPoint: cutData[cutData.length - 1]?.Datetime
      });
      return cutData;
    }
    
    // Default: return filtered data for complete timeline navigation
    let result = filteredData;

    // Video-only mode: restrict to time ranges where we have video (hide timeline until we know video windows)
    if (props.videoOnly) {
      const windows = mediaWindows();
      if (windows.length === 0) {
        return [];
      }
      result = result.filter((d) => {
        const t = getTimestamp(d);
        const tMs = t instanceof Date ? t.getTime() : new Date(t).getTime();
        return windows.some(
          (w) =>
            w.start &&
            w.end &&
            tMs >= (w.start instanceof Date ? w.start : new Date(w.start)).getTime() &&
            tMs <= (w.end instanceof Date ? w.end : new Date(w.end)).getTime()
        );
      });
      debug('MapTimeSeries: videoOnly filter', { windowsCount: windows.length, resultLength: result.length });
    }

    return result;
  });




  // Map does not use global grade or TWA; only race/leg and selection
  const applyFilters = (data) => {
    const filtered = applyDataFilter(data, [], undefined, undefined, [], undefined, { forceSelection: true });
    return filtered;
  };

  // Helper function to get timestamp from data point with robust handling
  const getTimestamp = (d) => {
    if (!d) return new Date(0);
    
    // Handle different timestamp field names and formats
    const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
    
    if (!timestamp) return new Date(0);
    
    // If it's already a Date object, return it
    if (timestamp instanceof Date) return timestamp;
    
    // If it's a number (Unix timestamp), convert to Date
    if (typeof timestamp === 'number') return new Date(timestamp);
    
    // If it's a string, try to parse it
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      // Check if parsing was successful
      if (!isNaN(parsed.getTime())) return parsed;
    }
    
    // Fallback to epoch if all else fails
    warn('Invalid timestamp format:', timestamp, 'in data point:', d);
    return new Date(0);
  };

  const S20colorScale = d3.scaleOrdinal(d3.schemeCategory10)
  let myLinearColor = d3.scaleLinear();
  let myLinearThickness = d3.scaleLinear();
  let myOrdinalColor = d3.scaleOrdinal();

  // Helper function to compute 1-sigma range (mean ± 1 std) for map coloring
  const getOneSigmaRange = (data: any[], accessor: (p: any) => number): [number, number] => {
    const values = data.map(accessor).filter(v => !isNaN(v) && isFinite(v));
    if (values.length === 0) return [0, 1];
    
    const mean = d3.mean(values) || 0;
    const std = d3.deviation(values) || 0;
    const min = mean - std;
    const max = mean + std;
    
    return [min, max];
  };

  const initScales = (data) => {
    // Check if there are any selected events
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      myOrdinalColor = d3.scaleOrdinal();

      // Get unique event_ids from the actual data points, not from selectedEvents
      // This ensures the color scale matches the event_id values that are actually in the data
      const dataEventIds = data
        .map(point => point.event_id)
        .filter(id => id !== undefined && id !== null && id > 0)
        .sort((a, b) => a - b);
      
      const uniqueEventIds = Array.from(new Set(dataEventIds));
      
      debug('MapTimeSeries: initScales - data event IDs:', uniqueEventIds);
      debug('MapTimeSeries: initScales - selectedEvents:', selectedEvents());
      debug('MapTimeSeries: initScales - hasSelections:', hasSelections);
      
      if (uniqueEventIds.length === 0) {
        // No event_id values > 0 in data, but we have selections
        // This means the event assignment didn't work properly
        debug('MapTimeSeries: initScales - No event_id values > 0 found in data, but hasSelections is true');
        debug('MapTimeSeries: initScales - This suggests event assignment failed');
        
        // Fall back to normal coloring
        const colors = getThemeColors();
        if (maptype() === "GRADE") {
          myOrdinalColor.domain([0, 1, 2, 3, 4]);
          myOrdinalColor.range(["lightgrey", colors.red, colors.lightGreen, colors.green, colors.yellow]);
        } else if (maptype() === "WIND") {
          const twsField = twsName();
          const twdField = twdName();
          
          const [minTWS, maxTWS] = getOneSigmaRange(data, (p) => +(p[twsField] ?? p[twsField.toLowerCase()] ?? p[twsField.toUpperCase()] ?? p.Tws ?? p.tws ?? 0));
          const [minTWD, maxTWD] = getOneSigmaRange(data, (p) => +(p[twdField] ?? p[twdField.toLowerCase()] ?? p[twdField.toUpperCase()] ?? p.Twd ?? p.twd ?? 0));

          myLinearColor.domain([minTWD, (minTWD + maxTWD) / 2, maxTWD]);
          myLinearColor.range([colors.red, colors.lightGrey, colors.green]);

          myLinearThickness.domain([minTWS, maxTWS]);
          myLinearThickness.range(["0.1", "3"]);
        } else if (maptype() === "VMG%") {
          // Fixed scale for VMG%: 25% (min) to 150% (max)
          const minVMG = 25;
          const maxVMG = 125;
          myLinearColor.domain([minVMG,
            minVMG + (maxVMG - minVMG) * 0.50,
            minVMG + (maxVMG - minVMG) * 0.95,
            maxVMG]);
          myLinearColor.range([colors.blue, colors.lightBlue, colors.yellow, colors.red]);

          const bspField = bspName();
          const [minBSP, maxBSP] = getOneSigmaRange(data, (p) => +(p[bspField] ?? p[bspField.toLowerCase()] ?? p[bspField.toUpperCase()] ?? p.Bsp ?? p.bsp ?? 0));
          myLinearThickness.domain([minBSP, maxBSP]);
          myLinearThickness.range(["0.1", "3"]);
        } else if (maptype() === "VMG") {
          const vmgField = vmgName();
          let [minVMG, maxVMG] = getOneSigmaRange(data, (p) => {
            const val = p[vmgField] ?? p[vmgField.toLowerCase()] ?? p[vmgField.toUpperCase()] ?? p.Vmg ?? p.vmg;
            return val !== undefined && val !== null ? Number(val) : 0;
          });

          myLinearColor.domain([minVMG,
            minVMG + (maxVMG - minVMG) * 0.50,
            minVMG + (maxVMG - minVMG) * 0.95,
            maxVMG]);
          myLinearColor.range([colors.blue, colors.lightBlue, colors.yellow, colors.red]);
          // Clamp values to domain to prevent extrapolation beyond red
          myLinearColor.clamp(true);

          const bspField = bspName();
          const [minBSP, maxBSP] = getOneSigmaRange(data, (p) => +(p[bspField] ?? p[bspField.toLowerCase()] ?? p[bspField.toUpperCase()] ?? p.Bsp ?? p.bsp ?? 0));
          myLinearThickness.domain([minBSP, maxBSP]);
          myLinearThickness.range(["0.1", "3"]);
        }
      } else {
        // We have event_id values > 0, create color scale for them using global color scale
        // Use the order from selectedEvents, not the sorted order of event_id values
        const selectedEventsOrder = selectedEvents().filter(id => uniqueEventIds.includes(id));
        
        const globalColorScale = createD3EventColorScale(selectedEventsOrder);
        
        myOrdinalColor.domain(globalColorScale.domain);
        myOrdinalColor.range(globalColorScale.range);
        
        debugColorScale('MapTimeSeries', selectedEventsOrder, globalColorScale);
      }
    } else {
      const colors = getThemeColors();
      
      if (maptype() === "GRADE") {
        myOrdinalColor.domain([0, 1, 2, 3, 4]);
        myOrdinalColor.range(["lightgrey", colors.red, colors.lightGreen, colors.green, colors.yellow]);
      } else if (maptype() === "WIND") {
        const twsField = twsName();
        const twdField = twdName();
        
        const [minTWS, maxTWS] = getOneSigmaRange(data, (p) => +(p[twsField] ?? p[twsField.toLowerCase()] ?? p[twsField.toUpperCase()] ?? p.Tws ?? 0));
        const [minTWD, maxTWD] = getOneSigmaRange(data, (p) => +(p[twdField] ?? p[twdField.toLowerCase()] ?? p[twdField.toUpperCase()] ?? p.Twd ?? 0));

        myLinearColor.domain([minTWD, (minTWD + maxTWD) / 2, maxTWD]);
        myLinearColor.range([colors.red, colors.lightGrey, colors.green]);

        myLinearThickness.domain([minTWS, maxTWS]);
        myLinearThickness.range(["0.1", "3"]);
      } else if (maptype() === "VMG%") {
        // Fixed scale for VMG%: 25% (min) to 125% (max)
        const minVMG = 25;
        const maxVMG = 125;
        myLinearColor.domain([minVMG,
          minVMG + (maxVMG - minVMG) * 0.50,
          minVMG + (maxVMG - minVMG) * 0.95,
          maxVMG]);
        myLinearColor.range(["blue", "lightblue", "yellow", "red"]);
        myLinearColor.clamp(true);

        const bspField = bspName();
        const [minBSP, maxBSP] = getOneSigmaRange(data, (p) => +(p[bspField] ?? p[bspField.toLowerCase()] ?? p[bspField.toUpperCase()] ?? p.Bsp ?? p.bsp ?? 0));
        myLinearThickness.domain([minBSP, maxBSP]);
        myLinearThickness.range(["0.1", "3"]);
      } else if (maptype() === "VMG") {
        const vmgField = vmgName();
        let [minVMG, maxVMG] = getOneSigmaRange(data, (p) => {
          const val = p[vmgField] ?? p[vmgField.toLowerCase()] ?? p[vmgField.toUpperCase()] ?? p.Vmg ?? p.vmg;
          return val !== undefined && val !== null ? Number(val) : 0;
        });

        myLinearColor.domain([minVMG,
          minVMG + (maxVMG - minVMG) * 0.50,
          minVMG + (maxVMG - minVMG) * 0.95,
          maxVMG]);
        myLinearColor.range(["blue", "lightblue", "yellow", "red"]);
        myLinearColor.clamp(true);

        const bspField = bspName();
        const [minBSP, maxBSP] = getOneSigmaRange(data, (p) => +(p[bspField] ?? p[bspField.toLowerCase()] ?? p[bspField.toUpperCase()] ?? p.Bsp ?? p.bsp ?? 0));
        myLinearThickness.domain([minBSP, maxBSP]);
        myLinearThickness.range(["0.1", "3"]);
      }
    }
  };

  // Updated getColor and getThickness to accept prev and d
  const getColor = (d, prev) => {
    const colors = getThemeColors();
    
    // Use sampling frequency to determine gap threshold (3x the expected interval)
    const expectedInterval = 1000 / props.samplingFrequency;
    const gapThreshold = expectedInterval * 3;
    
    if (prev && d && (getTimestamp(d) instanceof Date) && (getTimestamp(prev) instanceof Date) && (Math.abs(getTimestamp(d).getTime() - getTimestamp(prev).getTime()) > gapThreshold)) {
      return "transparent";
    }
    
    // Check if there are any selected events
    // When selections exist, base track should be rendered in light grey
    // Selection overlays will be drawn on top by the renderer
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      // When selections exist, render base track in light grey
      // Selection overlays will be drawn on top by SegmentedTrackRenderer/ContinuousTrackRenderer
      return colors.lightGrey;
    }
    
    // No selections, use normal map coloring based on maptype
    if (maptype() === "DEFAULT") {
      return sourceColor(); // Use source color for DEFAULT mode
    } else if (maptype() === "GRADE") {
      // Use normalized field name first (unifiedDataStore normalizes metadata to lowercase)
      const gradeVal = d.grade ?? d.Grade;
      return myOrdinalColor(gradeVal) || colors.lightGrey;
    } else if (maptype() === "WIND") {
      const twdField = twdName();
      const twdVal = d[twdField] ?? d[twdField.toLowerCase()] ?? d[twdField.toUpperCase()] ?? d.Twd ?? d.twd;
      return myLinearColor(twdVal) || colors.lightGrey;
    } else if (maptype() === "VMG%") {
      // Use vmg_perc_name channel (same as old VMG behavior)
      const vmgPercField = vmgPercName();
      const vmgPercVal = d[vmgPercField] ?? d[vmgPercField.toLowerCase()] ?? d[vmgPercField.toUpperCase()] ?? d.Vmg_perc ?? d.vmg_perc;
      return myLinearColor(vmgPercVal) || colors.lightGrey;
    } else if (maptype() === "VMG") {
      // Use vmg_name channel (new option)
      const vmgField = vmgName();
      const vmgVal = d[vmgField] ?? d[vmgField.toLowerCase()] ?? d[vmgField.toUpperCase()] ?? d.Vmg ?? d.vmg;
      return myLinearColor(vmgVal) || colors.lightGrey;
    } else if (maptype() === "STATE") {
      // State coloring: 0=red, 1=orange, 2=blue
      // Try multiple field names and case variations (data is normalized to lowercase)
      const stateVal = d.state ?? d.State ?? d.STATE;
      // Convert to number if it's a string, handle null/undefined
      if (stateVal === undefined || stateVal === null) {
        return colors.lightGrey;
      }
      const stateNum = Number(stateVal);
      if (isNaN(stateNum)) {
        return colors.lightGrey;
      }
      if (stateNum === 0) return "red";
      if (stateNum === 1) return "orange";
      if (stateNum === 2) return "blue";
      return colors.lightGrey;
    } else if (maptype() === "PHASE") {
      // Color by phase: phases in orange, non-phases in light grey
      const phaseVal = d.phase_id ?? d.Phase_id ?? d.phase ?? d.Phase;
      const isPhase = phaseVal !== undefined && phaseVal !== null && phaseVal !== '' && Number(phaseVal) > 0;
      return isPhase ? "orange" : colors.lightGrey;
    } else {
      return colors.lightGrey;
    }
  };

  const getThickness = (type, d, prev) => {
    // Use sampling frequency to determine gap threshold (3x the expected interval)
    const expectedInterval = 1000 / props.samplingFrequency;
    const gapThreshold = expectedInterval * 3;
    
    if (prev && d && (getTimestamp(d) instanceof Date) && (getTimestamp(prev) instanceof Date) && (Math.abs(getTimestamp(d).getTime() - getTimestamp(prev).getTime()) > gapThreshold)) {
      return 0;
    }
    
    // Check if there are any selected events
    // When selections exist, base track should be thin (overlays will be thicker)
    const hasSelections = selectedEvents && selectedEvents().length > 0;
    
    if (hasSelections) {
      // When selections exist, render base track thin
      // Selection overlays will be drawn thicker on top by SegmentedTrackRenderer/ContinuousTrackRenderer
      return 1;
    }
    
    // No selections, use normal thickness based on maptype
    if (type =='chart') {
      return 1;
    } else {
      if (maptype() === "DEFAULT") {
        return 1; // Default thickness for source color
      } else if (maptype() === "GRADE") {
        return 2;
      } else if (maptype() === "WIND") {
        const twsField = twsName();
        const twsVal = d[twsField] ?? d[twsField.toLowerCase()] ?? d[twsField.toUpperCase()] ?? d.Tws ?? d.tws;
        return myLinearThickness(twsVal) || 2;
      } else if (maptype() === "VMG%" || maptype() === "VMG") {
        const bspField = bspName();
        const bspVal = d[bspField] ?? d[bspField.toLowerCase()] ?? d[bspField.toUpperCase()] ?? d.Bsp ?? d.bsp;
        return myLinearThickness(bspVal) || 2;
      } else if (maptype() === "PHASE") {
        return 2;
      } else {
        return 1;
      }
    }
  };

  const drawChart = async (data) => {
    if (!data || data.length === 0) return;
    
    // Create data signature to detect if we're redrawing with the same data
    // Normalize Datetime to avoid format differences (timezone, precision) causing false positives
    const normalizeDatetime = (dt: any): string => {
      if (!dt) return '';
      if (typeof dt === 'string') {
        // Extract just the date and time part (ignore timezone differences in signature)
        const match = dt.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        return match ? match[1] : dt.substring(0, 19); // First 19 chars (YYYY-MM-DD HH:MM:SS)
      }
      return String(dt).substring(0, 19);
    };
    
    const firstDt = normalizeDatetime(data[0]?.Datetime || data[0]?.timestamp || '');
    const lastDt = normalizeDatetime(data[data.length - 1]?.Datetime || data[data.length - 1]?.timestamp || '');
    const dataSignature = `${data.length}-${firstDt}-${lastDt}`;
    
    // Reset call count if signature changed (new data)
    if (dataSignature !== lastDrawChartDataSignature) {
      drawChartCallCount = 0;
      debug(`MapTimeSeries: New data signature detected: ${dataSignature}`);
    }
    
    // Check if we're being called with the same data while already drawing
    if (dataSignature === lastDrawChartDataSignature && isDrawing) {
      debug('MapTimeSeries: drawChart called with same data signature while drawing, skipping');
      return;
    }
    
    // Track drawChart calls to detect infinite loops (only if same signature and not drawing)
    // Allow first few redraws with same signature (might be legitimate)
    if (dataSignature === lastDrawChartDataSignature && !isDrawing) {
      drawChartCallCount++;
      debug(`MapTimeSeries: Redraw with same signature (count: ${drawChartCallCount})`);
      // Only block after 10 consecutive calls with same signature (definite loop)
      if (drawChartCallCount > 10) {
        logError('🚨 MapTimeSeries: drawChart called too many times, possible infinite loop!', {
          callCount: drawChartCallCount,
          dataSignature,
          lastSignature: lastDrawChartDataSignature,
          isDrawing
        });
        drawChartCallCount = 0; // Reset to prevent permanent blocking
        lastDrawChartDataSignature = dataSignature; // Update to break the loop
        return;
      }
      // Allow first few redraws (might be legitimate updates)
    }
    
    debug(`MapTimeSeries: Proceeding with drawChart, signature: ${dataSignature}, isDrawing: ${isDrawing}`);
    
    // Debug: Check event_id distribution in chart data
    const eventIdCounts = {};
    data.forEach(point => {
      const eventId = point.event_id || 0;
      eventIdCounts[eventId] = (eventIdCounts[eventId] || 0) + 1;
    });
    debug('MapTimeSeries: drawChart called with data event_id distribution:', eventIdCounts);
    
    // Ensure chart container exists and has dimensions
    if (!chartContainer) {
      debug('MapTimeSeries: Chart container not ready, skipping draw');
      return;
    }
    
    const containerWidth = chartContainer.clientWidth || chartContainer.offsetWidth;
    if (containerWidth === 0) {
      debug('MapTimeSeries: Chart container has no width, skipping draw');
      return;
    }
    
    // Prevent multiple simultaneous draws
    if (isDrawing) {
      debug('MapTimeSeries: Already drawing, skipping duplicate drawChart call');
      return;
    }
    isDrawing = true;
    lastDrawChartDataSignature = dataSignature; // Update signature when starting to draw

    try {
      // If there are selections but no event_id assigned yet, assign before rendering
      // Event ID assignment no longer needed - using selectedRanges for timestamp comparison

      // Get theme colors once for the entire function
      const colors = getThemeColors();
      
      // Initialize color scales based on data and maptype
      initScales(data);

      // Use dynamic channel names from store
      const tws = twsName() || 'Tws_kts';
      const bsp = bspName() || 'Bsp_kts';
      const vmgPerc = vmgPercName() || 'Vmg_perc';
      const vmg = vmgName() || 'Vmg';
      let channel = bsp; // default
      if (maptype() === "WIND") {
        channel = tws;
      } else if (maptype() === "VMG%") {
        channel = vmgPerc;
      } else if (maptype() === "VMG") {
        channel = vmg;
      } else if (maptype() === "DEFAULT") {
        channel = bsp;
      }
      
      // Helper function to get channel value from data point (case-insensitive)
      const getChannelValue = (d: any): number => {
        const val = d[channel] ?? d[channel.toLowerCase()] ?? d[channel.toUpperCase()];
        if (val === undefined || val === null || isNaN(Number(val))) {
          return 0; // Return 0 instead of NaN to prevent rendering errors
        }
        return Number(val);
      };
      
      debug(`[MapTimeSeries] Using channel for chart: ${channel} (maptype: ${maptype()})`);

      // Remove existing chart before redrawing
      d3.select("#chart").select("svg").remove();
      
      // Add visual feedback for cut data
      const isCutData = cutEvents().length > 0 && !hasSelection();

      const width = chartContainer.clientWidth || 600;
      const height = 120; // Increased from 120 to 140 to make room for Video label
      const margin = { top: 10, right: 10, bottom: 20, left: 25 };

      const svg = d3
        .select("#chart")
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("transform", "translate(0, 20)") // Transpose SVG down by 25px
        .on("contextmenu", (event) => event.preventDefault()) // Disable right-click context menu
        .append("g")
        .attr("transform", `translate(${margin.left}, ${margin.top})`);

      // Data is already filtered at the source, use it directly
      if (!data || data.length === 0) return;

      // Use worker for scale calculations on large datasets
      let xExtent, xScale, yScale;
      
      if (data.length > 1000) {
        try {
          const scaleResult = await processD3CalculationsWithWorker(data, {
            operation: 'SCALE_CALCULATIONS',
            data: data,
            options: {
              scaleType: 'time',
              channel: channel
            }
          });
          
          xExtent = scaleResult.scales.extent;
          xScale = d3.scaleTime().domain(xExtent).range([0, width - margin.left - margin.right]);
          
          // Calculate y-scale extent - handle case-insensitive channel access
          // Use d3.min/max instead of Math.min/max with spread to avoid stack overflow on large arrays
          const yMin = d3.min(data, (d) => {
            const val = getChannelValue(d);
            return (!isNaN(val) && val !== null && val !== undefined && val !== 0) ? val : undefined;
          });
          const yMax = d3.max(data, (d) => {
            const val = getChannelValue(d);
            return (!isNaN(val) && val !== null && val !== undefined && val !== 0) ? val : undefined;
          });
          
          // Handle case where all values are filtered out
          if (yMin === undefined || yMax === undefined) {
            yScale = d3.scaleLinear()
              .domain([0, 100])
              .range([height - margin.top - margin.bottom, 0]);
          } else {
            yScale = d3.scaleLinear()
              .domain([yMin, yMax * 1.15])
              .range([height - margin.top - margin.bottom, 0]);
          }
        } catch (error: any) {
          logError('Worker-based scale calculation failed, using fallback:', error);
          // Fall back to synchronous calculation
          xExtent = d3.extent(data, (d) => getTimestamp(d));
          xScale = d3.scaleTime().domain(xExtent).range([0, width - margin.left - margin.right]);
          
          yScale = d3.scaleLinear()
            .domain([
              d3.min(data, (d) => getChannelValue(d)),
              d3.max(data, (d) => getChannelValue(d)) * 1.15
            ])
            .range([height - margin.top - margin.bottom, 0]);
        }
      } else {
        // Synchronous calculation for small datasets
        xExtent = d3.extent(data, (d) => getTimestamp(d));
        xScale = d3.scaleTime().domain(xExtent).range([0, width - margin.left - margin.right]);
        
        yScale = d3.scaleLinear()
          .domain([d3.min(data, (d) => getChannelValue(d)), d3.max(data, (d) => getChannelValue(d)) * 1.15])
          .range([height - margin.top - margin.bottom, 0]);
      }

      setRange({ min: xExtent[0], max: xExtent[1] });

      // Define lineGenerator before any usage
      const lineGenerator = d3
        .line()
        .x((d) => xScale(getTimestamp(d)))
        .y((d) => yScale(getChannelValue(d)));

      // Choose renderer based on maptype
      const rendererProps = {
        data: data,
        svg: svg,
        xScale: xScale,
        yScale: yScale,
        lineGenerator: lineGenerator,
        config: { 
          maptype: maptype(), 
          samplingFrequency: props.samplingFrequency,
          sourceColor: sourceColor() // Pass the actual source color
        },
        samplingFrequency: props.samplingFrequency,
        channel: channel,
        colors: colors,
        // Pass the actual D3 color scales
        myOrdinalColor: myOrdinalColor,
        myLinearColor: myLinearColor,
        myLinearThickness: myLinearThickness,
        getColor: getColor,
        getThickness: getThickness
      };


      let result;
      if (maptype() === "DEFAULT") {
        // Use continuous renderer for DEFAULT mode
        result = renderContinuousTimeSeries(rendererProps);
      } else {
        // Use segmented renderer for other modes
        result = renderSegmentedTimeSeries(rendererProps);
      }

      if (!result.success) {
        logError('MapTimeSeries: renderer failed:', result.error);
      }

      // Add media rectangles above the chart (drawn last to ensure they're on top)
      // Only show media rectangles if there are actual media windows for this date
      const currentMediaWindows = mediaWindows();
      const shouldShowVideoElements = currentMediaWindows.length > 0;
      
      debug('MapTimeSeries: Media rectangles check:', {
        shouldShowVideoElements,
        hasVideoMenu: hasVideoMenu(),
        currentMediaWindowsLength: currentMediaWindows.length,
        dataLength: data.length
      });
      
      // Process real media windows - only show if actual video exists for this date
      const processedWindows = shouldShowVideoElements ? (
        currentMediaWindows.map(w => {
          // Media data is already processed with start/end dates
          return {
            start: w.start,
            end: w.end,
            sourceId: w.sourceId,
            fileName: w.fileName || 'unknown'
          };
        }).filter(w => w.start && w.end)
      ) : [];
      
      debug('MapTimeSeries: Processed windows result:', {
        processedWindowsLength: processedWindows.length,
        processedWindows: processedWindows
      });
      
      // Always create media group (even if empty) to ensure proper cleanup
      // Remove any existing media rectangles group first
      svg.selectAll("g.media-rectangles").remove();
      
      if (processedWindows.length > 0) {
        const mediaGroup = svg.append("g")
          .attr("class", "media-rectangles");
        
        const mediaColor = themeStore.isDark() ? "#60a5fa" : "#1d4ed8"; // Light blue in dark mode, dark blue in light mode
        
        // Use D3 update pattern: enter, update, exit
        const rects = mediaGroup.selectAll("rect.media")
          .data(processedWindows, (d) => `${d.sourceId}-${d.start?.getTime()}-${d.end?.getTime()}`);
        
        // Remove old rectangles
        rects.exit().remove();
        
        // Add new rectangles
        const rectsEnter = rects.enter()
          .append("rect")
          .attr("class", "media");
        
        // Update all rectangles (both new and existing)
        rectsEnter.merge(rects)
          .attr("x", (d) => {
            const xPos = xScale(d.start);
            return isNaN(xPos) ? 0 : xPos;
          })
          .attr("y", -10) // Moved up 10px from 5px to -5px (relative to chart area)
          .attr("width", (d) => {
            const width = Math.max(0, xScale(d.end) - xScale(d.start));
            return isNaN(width) ? 0 : width;
          })
          .attr("height", 3) // 3px tall
          .attr("rx", 1.5) // Rounded edges
          .attr("ry", 1.5)
          .attr("fill", mediaColor)
          .attr("stroke", "none") // No border
          .attr("opacity", 0.8);
      }

      // Add X and Y axes with timezone-aware formatting
      const timezone = datasetTimezone();
      const xAxis = d3.axisBottom(xScale)
        .tickFormat((d) => {
          if (d instanceof Date) {
            const formatted = formatTime(d, timezone);
            return formatted || d.toLocaleTimeString();
          }
          return String(d);
        });
      
      svg.append("g")
        .attr("class", "axes")
        .attr("transform", `translate(0,${height - margin.top - margin.bottom})`)
        .call(xAxis)
        .style("color", colors.axis);

      svg.append("g")
        .attr("class", "axes")
        .call(d3.axisLeft(yScale).ticks(3))
        .style("color", colors.axis);

      // Add Axis Label
      svg.append("text")
        .attr("class", "axis-label")
        .attr("text-anchor", "left")
        .attr("transform", "translate(20,15)")
        .attr("font-size", "14px")
        .attr("fill", colors.text)
        .text(channel);
      
      // Add cut data indicator
      if (isCutData) {
        svg.append("text")
          .attr("class", "cut-data-indicator")
          .attr("text-anchor", "right")
          .attr("transform", `translate(${width - margin.left - margin.right - 10},10)`)
          .attr("font-size", "12px")
          .attr("fill", colors.cutDataIndicator)
          .text("CUT DATA");
      }

      // Chart dimensions (used by brush extent and playhead)
      const chartWidth = width - margin.left - margin.right;
      const chartHeight = height - margin.top - margin.bottom;

      // Add brushing functionality - place brush first so playhead can be drawn on top
      // When brushEnabled is false (e.g. videoOnly mode), only click-to-seek overlay is shown
      const brushEnabled = props.brushEnabled !== false;

      if (brushEnabled) {
      const brush = d3
        .brushX()
        .extent([
          [0, 0],
          [chartWidth, chartHeight],
        ]);

      // Create the brush group (using D3 defaults like MultiMapTimeSeries)
      const brushGroup = svg.append("g")
        .attr("class", "brush")
        .call(brush)
        .on("contextmenu", (event) => event.preventDefault()); // Disable right-click context menu

      // Store brush group and brush for later use
      window.brushGroup = brushGroup;
      (window as { chartBrush?: typeof brush }).chartBrush = brush;

      // Function to restore brush selection based on current selectedRange
      const restoreBrushSelection = () => {
        if (!brushGroup || !xScale) return;
        
        const currentSelectedRange = selectedRange();
        const currentCutEvents = cutEvents();
        
        if (currentSelectedRange && currentSelectedRange.length > 0) {
          const rangeItem = currentSelectedRange[0];
          const startTime = new Date(rangeItem.start_time);
          const endTime = new Date(rangeItem.end_time);
          
          // Convert time range to brush coordinates
          const x0 = xScale(startTime);
          const x1 = xScale(endTime);
          
          // Restore the brush selection
          brushGroup.call(brush.move, [x0, x1]);
        } else if (currentCutEvents && currentCutEvents.length > 0) {
          // Clear brush selection for cut events - cut data is static and not interactive
          brushGroup.call(brush.move, null);
          debug('MapTimeSeries: Cleared brush selection - cut events present');
        } else {
          // Clear brush selection
          brushGroup.call(brush.move, null);
        }
      };

      // Restore brush selection on initialization
      restoreBrushSelection();
      
      // Delayed selectedTime initialization to ensure chart is fully rendered
      setTimeout(() => {
        if (!selectedTime() || selectedTime() < new Date('1971-01-01T12:00:00Z')) {
          // Use the stored xScale reference if available (stored globally later in drawChart)
          const scaleRef = window.chartTimeScale || xScale;
          if (scaleRef) {
            const domain = scaleRef.domain();
            
            // Check if domain is valid before proceeding
            if (domain && domain.length === 2 && !isNaN(domain[0]) && !isNaN(domain[1]) && domain[0] !== domain[1]) {
              const initialTime = domain[0];
              
              debug('⏰ MapTimeSeries: Delayed selectedTime initialization', {
                domain: domain.map(d => new Date(d).toISOString()),
                initialTime: new Date(initialTime).toISOString(),
                currentSelectedTime: selectedTime()?.toISOString()
              });
              
              if (requestTimeControl('maptimeseries')) {
                debug('⏰ MapTimeSeries: Delayed time control granted, setting selectedTime');
                const initialTimeDate = new Date(initialTime);
                setSelectedTime(initialTimeDate, 'maptimeseries');
                window.lastSelectedTime = initialTimeDate;
                const xPos = scaleRef(initialTime);
                if (window.chartPlayheadGroup) {
                  window.chartPlayheadGroup.attr("transform", `translate(${xPos}, 0)`);
                }
              } else {
                debug('⏰ MapTimeSeries: Delayed time control denied, cannot set selectedTime');
              }
            } else {
              debug('⏰ MapTimeSeries: Delayed initialization skipped - invalid domain', domain);
            }
          }
        }
      }, 100); // Small delay to ensure chart is fully rendered

      // Track click vs drag to prevent brush events on simple clicks
      let clickStartTime = null;
      let clickStartPosition = null;
      
      // Add mousedown handler to detect clicks vs drags
      brushGroup.select(".overlay")
        .on("mousedown", (event) => {
          clickStartTime = Date.now();
          const [x] = d3.pointer(event);
          clickStartPosition = x;
        })
        .on("click", (event) => {
          // Only handle click if it was a quick click (not a drag)
          const clickDuration = clickStartTime ? Date.now() - clickStartTime : 0;
          const [x] = d3.pointer(event);
          const moved = clickStartPosition !== null && Math.abs(x - clickStartPosition) > 3;
          
          // If it was a drag (took too long or moved too much), let brush handle it
          if (clickDuration > 200 || moved) {
            clickStartTime = null;
            clickStartPosition = null;
            return;
          }
          
          // This is a simple click - handle it and prevent brush from processing
          event.stopPropagation();
          event.preventDefault();
          
          const [mouseX] = d3.pointer(event);
          // Domain is from backend Datetime (UTC), so invert yields UTC instant for selectedTime
          const time = new Date(xScale.invert(mouseX));

          // Request control of selectedTime
          debug('MapTimeSeries: Timeline click - requesting time control');
          if (requestTimeControl('maptimeseries')) {
            setIsManualTimeChange(true); // Set manual change flag for boat animation
            
            const xPos = xScale(time);
            if (window.chartPlayheadGroup) {
              window.chartPlayheadGroup.attr("transform", `translate(${xPos}, 0)`);
            }
            
            // Update window.lastSelectedTime to prevent reactive effect from running
            // This ensures the effect sees "only selectedTime changed" and skips processing
            window.lastSelectedTime = time;
            
            // Set selectedTime - the reactive effect will detect only time changed and skip chart redraw
            setSelectedTime(time, 'maptimeseries');
            
            if (onStableSelectedTimeChange) {
              onStableSelectedTimeChange(time);
            }
            
            // Release time control after setting the time
            setTimeout(() => {
              debug('MapTimeSeries: Releasing time control after timeline click');
              releaseTimeControl('maptimeseries');
            }, 100);
          } else {
            debug('MapTimeSeries: Time control denied - another component has higher priority');
          }

          // If there is no active brush selection after click, ensure map shows full timeline data
          const hasRange = Array.isArray(selectedRange()) && selectedRange().length > 0;
          if (!hasRange) {
            // Always send full timeline data for timeline clicks
            const fullData = values();
            debug('MapTimeSeries: Timeline click - sending full timeline data to map');
            if (onMapUpdate) {
              onMapUpdate(fullData);
            }
          }
          
          // Reset click tracking
          clickStartTime = null;
          clickStartPosition = null;
        })
        // Add double-click handler to clear selection
        .on("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          debug('MapTimeSeries: Double-click detected - clearing selection');
          handleBrushClear();
        });

      // Helper function to update time selection (brush interactions - NO halo)
      const updateTimeSelection = (time) => {
        // Request control for brush interactions
        if (requestTimeControl('maptimeseries')) {
          // Treat brush interactions as manual movement but suppress halo
          try { (window).skipBoatHaloOnce = true; } catch {}
          if (!isManualTimeChange()) setIsManualTimeChange(true);
          const newTime = new Date(time);
          const current = selectedTime();
          if (!(current instanceof Date) || Math.abs(current.getTime() - newTime.getTime()) > 0) {
            setSelectedTime(newTime, 'maptimeseries');
            // Update window.lastSelectedTime to prevent reactive effect from running
            window.lastSelectedTime = newTime;
          }
          if (onStableSelectedTimeChange) {
            onStableSelectedTimeChange(newTime);
          }
          setPrevSelectedTime(newTime);
          
          // Release time control after setting the time
          setTimeout(() => {
            debug('MapTimeSeries: Releasing time control after brush interaction');
            releaseTimeControl('maptimeseries');
          }, 100);
        }
      };

      // Helper function to update map with filtered data
      const updateMapWithRange = (start, end) => {
        const key = `range_${start || 'none'}_${end || 'none'}`;
        if (key === lastMapUpdateSignature) {
          debug('MapTimeSeries: Skipping onMapUpdate - identical range');
          return;
        }
        lastMapUpdateSignature = key;
        if (onMapUpdate) {
          onMapUpdate({ type: 'range', start, end });
        }
      };

      // Helper function to handle brush clearing WITHOUT triggering chart redraws
      // This is used when user clicks to clear brush - we just need to update state and map
      // Based on previous working version - uses values() directly and calls onMapUpdate immediately
      const handleBrushClear = () => {
        // Set flags to prevent reactive effect from running during clear
        // This ensures the chart doesn't redraw when just clearing a brush selection
        isBrushActive = true;
        isBrushSelectionActive = false;
        
        // Clear selection state directly WITHOUT triggering triggerUpdate
        // This prevents unnecessary chart redraws
        setSelectedRange([]);
        setSelectedRanges([]);
        setSelectedEvents([]);
        setHasSelection(false);
        setIsCut(cutEvents().length > 0);
        
        // Update tracking variables to prevent reactive effect from thinking range changed
        window.lastSelectedRange = [];
        window.lastMapDataLength = values().length;
        
        // Always send the full timeline data to the map when brush is cleared
        // Use values() like the previous working version did - this is the raw unfiltered data
        const fullData = values();

        if (fullData && fullData.length > 0) {
          // Force map update by clearing signature and adding a timestamp to make it unique
          lastMapUpdateSignature = null;
          const timestampedData = fullData.map((d, index) => ({
            ...d,
            _clearTimestamp: Date.now() + index // Add unique timestamp to force update
          }));
          
          if (onMapUpdate) {
            onMapUpdate(timestampedData);
          } else {
            logError('❌ MapTimeSeries: onMapUpdate function is not available!');
          }
        } else {
          warn('⚠️ MapTimeSeries: No data available for brush clear');
        }
        
        // Reset brush active flag after a delay to allow reactive effect to skip
        setTimeout(() => {
          isBrushActive = false;
        }, 200);
      };

      // Function to clear the brush selection
      const clearBrush = () => {
        if (isClearingBrush) {
          return;
        }

        isClearingBrush = true;

        try {
          if (window.brushGroup) {
            // Avoid re-entrant end events
            isProgrammaticallyUpdatingBrush = true;
            window.brushGroup.call(brush.move, null);
          }
          handleBrushClear();
        } finally {
          // Reset flag after a short delay to prevent rapid successive calls
          setTimeout(() => {
            isClearingBrush = false;
            isProgrammaticallyUpdatingBrush = false;
          }, 100);
        }
      };

      // Store the clearBrush function globally so it can be called from cutSelection and clearSelection
      window.clearMapBrush = clearBrush;
      window.clearTimeSeriesBrush = clearBrush; // Also set for selectionStore compatibility

      // Helper function to handle brush selection
      const handleBrushSelection = async (x0, x1) => {
        const minSelectionMs = 1000;
        const selectionDuration = Math.abs(x1 - x0);

        if (selectionDuration > minSelectionMs) {
          // Large selection - filter data by selected range and send filtered data to map
          const startTime = new Date(x0);
          const endTime = new Date(x1);
          
          // Filter data by the selected range before sending to map
          const fullData = values();
          const startTimeMs = startTime.getTime();
          const endTimeMs = endTime.getTime();
          
          const filteredData = fullData.filter(d => {
            const timestamp = getTimestamp(d).getTime();
            return timestamp >= startTimeMs && timestamp <= endTimeMs;
          });
          
          debug('MapTimeSeries: Brush selection - filtering data from', fullData.length, 'to', filteredData.length, 'points');
          debug('MapTimeSeries: Selection range:', startTime.toISOString(), 'to', endTime.toISOString());
          
          // Set flag to prevent main effect from overriding brush-filtered data
          isBrushSelectionActive = true;
          
          // Force map update by clearing signature and adding timestamp
          lastMapUpdateSignature = null;
          const timestampedData = filteredData.map((d, index) => ({
            ...d,
            _brushTimestamp: Date.now() + index // Add unique timestamp to force update
          }));
          
          if (onMapUpdate) {
            onMapUpdate(timestampedData);
          }
          
          const range = {"type": "range", "start_time": startTime.toISOString(), "end_time": endTime.toISOString()};
          updateTimeSelection(x0);
          
          // Set selectedRange - selectionStore will automatically set selectedRanges to match
          // This ensures the SelectionBanner displays correctly when brush selections are made
          setSelectedRange([range]);
          setHasSelection(true);
          setIsCut(false);
        } else {
          // Small selection - just time click, send full data
          updateTimeSelection(x0);
          
          setSelectedRange([]);
          setHasSelection(false);
          
          // Clear brush selection flag
          isBrushSelectionActive = false;

          // Send full timeline data for small selections
          const fullData = values();
          debug('MapTimeSeries: Small selection - sending full timeline data to map');
          
          // Force map update by clearing signature and adding timestamp
          lastMapUpdateSignature = null;
          const timestampedData = fullData.map((d, index) => ({
            ...d,
            _brushTimestamp: Date.now() + index // Add unique timestamp to force update
          }));
          
          if (onMapUpdate) {
            onMapUpdate(timestampedData);
          }
        }
      };

      // Track if user actually dragged (vs just clicked)
      let brushStartPosition = null;
      let brushWasDragged = false;

      function brushStarted(event) {
        // Record the starting position to detect if user actually dragged
        if (event && event.sourceEvent) {
          const [x] = d3.pointer(event.sourceEvent, event.target);
          brushStartPosition = x;
          brushWasDragged = false;
        }
        
        // Set brush active flag immediately when brush starts
        // This ensures the reactive effect skips before any selectedTime updates
        isBrushActive = true;
      }

      function brushed(event) {
        // Detect if user actually dragged (moved mouse during brush)
        if (event && event.sourceEvent && brushStartPosition !== null) {
          const [x] = d3.pointer(event.sourceEvent, event.target);
          if (Math.abs(x - brushStartPosition) > 3) { // 3px threshold to distinguish click from drag
            brushWasDragged = true;
          }
        }
        
        // During brushing, update vertical line directly without triggering reactive effects
        // This prevents chart redraws during brush interactions
        if (event && event.selection) {
          const [x0, x1] = event.selection.map(xScale.invert);
          const time = new Date(x0);
          
          const xPos = xScale(time);
          if (window.chartPlayheadGroup) {
            window.chartPlayheadGroup.attr("transform", `translate(${xPos}, 0)`);
          }
          
          // Update window.lastSelectedTime to prevent reactive effect from running
          // This ensures the effect sees "only selectedTime changed" and skips processing
          window.lastSelectedTime = time;
          
          // Update selectedTime signal - reactive effect will see isBrushActive=true and skip
          const current = selectedTime();
          if (!(current instanceof Date) || Math.abs(current.getTime() - time.getTime()) > 0) {
            setSelectedTime(time, 'maptimeseries');
          }
        }
      }

      function brushEnded(event) {
        // Ignore end caused by programmatic move (both move([x0, x1]) and move(null))
        if (isProgrammaticallyUpdatingBrush) {
          // Don't reset the flag here - let the setTimeout in the caller handle it
          // This ensures the flag stays true long enough for any async events
          return;
        }
        
        // Reset brush active flag after brush ends (with delay to ensure effect has skipped)
        setTimeout(() => {
          isBrushActive = false;
        }, 150);
        
        // Handle clear or final selection immediately on end
        if (!event || !event.selection) {
          // Only clear selection if:
          // 1. User actually dragged (brushWasDragged is true), OR
          // 2. There was a previous selection that needs to be cleared
          const hadSelection = Array.isArray(selectedRange()) && selectedRange().length > 0;
          
          if (brushWasDragged || hadSelection) {
            // Clear selection state and update map with full timeline data
            handleBrushClear();
            // Now clear the brush graphic without re-triggering logic
            if (window.brushGroup) {
              try {
                isProgrammaticallyUpdatingBrush = true;
                window.brushGroup.call(brush.move, null);
                setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 100);
              } catch(e) { /* noop */ }
            }
          } else {
            // Reset flags for next interaction
            brushStartPosition = null;
            brushWasDragged = false;
          }
        } else {
          const [x0, x1] = event.selection.map(xScale.invert);
          
          // Update selectedTime one final time when brush ends
          // This ensures the time is properly set even if brushed() didn't complete
          const time = new Date(x0);
          window.lastSelectedTime = time;
          const current = selectedTime();
          if (!(current instanceof Date) || Math.abs(current.getTime() - time.getTime()) > 0) {
            setSelectedTime(time, 'maptimeseries');
          }
          
          handleBrushSelection(x0, x1);
        }
        
        // Reset flags for next interaction
        brushStartPosition = null;
        brushWasDragged = false;
      }

      // Attach handlers separately to ensure clear is handled on end
      brush.on("start", brushStarted).on("brush", brushed).on("end", brushEnded);

      } else {
        // Brush disabled (e.g. VideoTimeSeries): click-to-seek overlay only
        window.brushGroup = null;
        const seekOverlay = svg.append("g").attr("class", "seek-overlay");
        seekOverlay.append("rect")
          .attr("width", chartWidth)
          .attr("height", chartHeight)
          .attr("fill", "transparent")
          .style("cursor", "pointer")
          .on("click", (event) => {
            const [x] = d3.pointer(event);
            const time = xScale.invert(x);
            if (requestTimeControl('maptimeseries')) {
              try { (window as any).skipBoatHaloOnce = true; } catch {}
              if (!isManualTimeChange()) setIsManualTimeChange(true);
              const newTime = new Date(time);
              setSelectedTime(newTime, 'maptimeseries');
              window.lastSelectedTime = newTime;
              if (onStableSelectedTimeChange) onStableSelectedTimeChange(newTime);
              if (window.chartPlayheadGroup) {
                const xPos = xScale(time);
                window.chartPlayheadGroup.attr("transform", `translate(${xPos}, 0)`);
              }
              setTimeout(() => releaseTimeControl('maptimeseries'), 100);
            }
          });
      }

      // Playhead: drawn on top of brush/seek so hovering over the line captures events (brush disabled there)
      const triangleSize = 8;
      const playheadY1 = 0; // Line starts at top (below triangle base)
      const playheadY2 = chartHeight; // Full height to bottom of plot
      const playheadGroup = svg.append("g")
        .attr("class", "playhead-group")
        .style("opacity", 1);

      const verticalLine = playheadGroup.append("line")
        .attr("class", "mouse-line")
        .attr("stroke", "red")
        .attr("stroke-width", 2)
        .attr("x1", 0)
        .attr("x2", 0)
        .attr("y1", playheadY1)
        .attr("y2", playheadY2)
        .style("pointer-events", "none");

      // Downward-facing triangle on top (draggable handle)
      playheadGroup.append("path")
        .attr("class", "playhead-triangle")
        .attr("d", `M ${-triangleSize / 2},0 L ${triangleSize / 2},0 L 0,${triangleSize} Z`)
        .attr("fill", "red")
        .attr("stroke", "red")
        .attr("stroke-width", 1)
        .style("pointer-events", "all");

      // Invisible wider hit area for triangle (easier to grab)
      playheadGroup.append("rect")
        .attr("class", "playhead-drag-handle")
        .attr("x", -10)
        .attr("y", 0)
        .attr("width", 20)
        .attr("height", triangleSize + 4)
        .attr("fill", "transparent")
        .style("pointer-events", "all");

      // Invisible hit area for full line height: hovering over line disables brush and allows drag
      playheadGroup.append("rect")
        .attr("class", "playhead-line-hit")
        .attr("x", -4)
        .attr("y", playheadY1)
        .attr("width", 8)
        .attr("height", playheadY2 - playheadY1)
        .attr("fill", "transparent")
        .style("pointer-events", "all");

      // Drag to scrub selected time
      const playheadDrag = d3.drag<SVGGElement, unknown>()
        .on("start", () => {
          playheadGroup.classed("dragging", true);
        })
        .on("drag", (event) => {
          const [mx] = d3.pointer(event, svg.node());
          const x = Math.max(0, Math.min(chartWidth, mx));
          const time = new Date(xScale.invert(x));
          if (requestTimeControl('maptimeseries')) {
            setIsManualTimeChange(true);
            window.lastSelectedTime = time;
            setSelectedTime(time, 'maptimeseries');
            if (onStableSelectedTimeChange) onStableSelectedTimeChange(time);
            playheadGroup.attr("transform", `translate(${x}, 0)`);
          }
        })
        .on("end", () => {
          playheadGroup.classed("dragging", false);
          setTimeout(() => releaseTimeControl('maptimeseries'), 100);
        });

      playheadGroup.call(playheadDrag);

      // Initialize playhead position
      const selectedTimeValue = selectedTime();
      if (selectedTimeValue) {
        const xPos = xScale(selectedTimeValue);
        playheadGroup.attr("transform", `translate(${xPos}, 0)`);
      }

      // Initialize selectedTime if it's not set or is at default
      if (!selectedTime() || selectedTime() < new Date('1971-01-01T12:00:00Z')) {
        const domain = xScale.domain();
        if (domain && domain.length === 2 && !isNaN(domain[0]) && !isNaN(domain[1]) && domain[0] !== domain[1]) {
          const initialTime = domain[0];
          debug('⏰ MapTimeSeries: Initializing selectedTime', {
            domain: domain.map(d => new Date(d).toISOString()),
            initialTime: new Date(initialTime).toISOString(),
            currentSelectedTime: selectedTime()?.toISOString()
          });
          if (requestTimeControl('maptimeseries')) {
            debug('⏰ MapTimeSeries: Time control granted, setting selectedTime');
            const initialTimeDate = new Date(initialTime);
            setSelectedTime(initialTimeDate, 'maptimeseries');
            window.lastSelectedTime = initialTimeDate;
            const xPos = xScale(initialTime);
            playheadGroup.attr("transform", `translate(${xPos}, 0)`);
          } else {
            debug('⏰ MapTimeSeries: Time control denied, cannot set selectedTime');
          }
        } else {
          debug('⏰ MapTimeSeries: Invalid domain for selectedTime initialization, skipping', domain);
        }
      }

      // Store references needed for global effects (both brush and brush-disabled modes)
      window.chartTimeScale = xScale;
      window.chartPlayheadGroup = playheadGroup;
      window.chartVerticalLine = verticalLine;
      window.chartLastWidth = chartWidth;

      const containerRef = document.querySelector('.map-chart-container');
      if (containerRef) {
        const chartBrush = (window as { chartBrush?: d3.BrushBehavior<unknown> }).chartBrush;
        d3.select(containerRef).property("__mapRefs", {
          brush: chartBrush,
          brushGroup: window.brushGroup,
          xScale: window.chartTimeScale,
          verticalLine: window.chartVerticalLine
        });
      }
      } finally {
        isDrawing = false;
        drawChartCallCount = 0; // Reset call count on successful completion
        window.chartDrawn = true; // Mark that chart has been successfully drawn
        
        // Restore brush selection immediately after chart is drawn if selectedRange exists
        // This ensures brush is visible when navigating from explore/timeseries to map
        if (window.brushGroup && window.chartTimeScale) {
          const currentSelectedRange = selectedRange();
          const currentCutEvents = cutEvents();
          
          if (currentSelectedRange && currentSelectedRange.length > 0) {
            const rangeItem = currentSelectedRange[0];
            const startTime = new Date(rangeItem.start_time);
            const endTime = new Date(rangeItem.end_time);
            
            // Convert time range to brush coordinates
            const x0 = window.chartTimeScale(startTime);
            const x1 = window.chartTimeScale(endTime);
            
            // Update the brush selection to highlight the selected range
            isProgrammaticallyUpdatingBrush = true;
            window.brushGroup.call(d3.brushX().move, [x0, x1]);
            setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
            debug('MapTimeSeries: Restored brush selection after chart draw');
          } else if (currentCutEvents && currentCutEvents.length > 0) {
            // Clear brush selection for cut events - cut data is static and not interactive
            isProgrammaticallyUpdatingBrush = true;
            window.brushGroup.call(d3.brushX().move, null);
            setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
            debug('MapTimeSeries: Cleared brush selection - cut events present');
          }
        }
      }
    };

    // Function to restore brush selection that can be called externally
    // This function will retry if chart isn't ready yet
    const restoreBrushSelection = () => {
      if (!window.brushGroup || !window.chartTimeScale) {
        // Chart not ready yet, retry after a short delay
        if (window.chartDrawn) {
          // Chart should be drawn, but brushGroup/chartTimeScale not set yet
          debug('MapTimeSeries: Chart drawn but brush not ready, retrying...');
          setTimeout(() => restoreBrushSelection(), 100);
        } else {
          // Chart not drawn yet, wait longer
          debug('MapTimeSeries: Chart not drawn yet, waiting...');
          setTimeout(() => restoreBrushSelection(), 200);
        }
        return;
      }
      
      const currentSelectedRange = selectedRange();
      const currentCutEvents = cutEvents();
      
      if (currentSelectedRange && currentSelectedRange.length > 0) {
        const rangeItem = currentSelectedRange[0];
        const startTime = new Date(rangeItem.start_time);
        const endTime = new Date(rangeItem.end_time);
        
        // Convert time range to brush coordinates
        const x0 = window.chartTimeScale(startTime);
        const x1 = window.chartTimeScale(endTime);
        
        // Update the brush selection to highlight the selected range
        isProgrammaticallyUpdatingBrush = true;
        window.brushGroup.call(d3.brushX().move, [x0, x1]);
        setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
        debug('MapTimeSeries: Restored brush selection for selectedRange');
      } else if (currentCutEvents && currentCutEvents.length > 0) {
        // Clear brush selection for cut events - cut data is static and not interactive
        isProgrammaticallyUpdatingBrush = true;
        window.brushGroup.call(d3.brushX().move, null);
        setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
        debug('MapTimeSeries: Cleared brush selection - cut events present');
      } else {
        // Clear brush selection
        isProgrammaticallyUpdatingBrush = true;
        window.brushGroup.call(d3.brushX().move, null);
        setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
        debug('MapTimeSeries: Cleared brush selection');
      }
    };

    // Store the restore function globally for external access
    window.restoreMapBrushSelection = restoreBrushSelection;

    // Removed reactive effect - chart will be drawn manually

    // Removed redundant vertical line effect

    // Add a signal to track the previous time for detecting large jumps
    const [prevSelectedTime, setPrevSelectedTime] = createSignal(null);

    // Removed vertical line effect - will be handled manually

    // Removed filter effect - brush is the primary data controller

    // Removed race/leg filter effects - brush is the primary data controller

    // Wait for chart container to get size (e.g. split view, dashboard tab) via ResizeObserver, then draw; give up after timeout
    const SCHEDULE_DRAW_TIMEOUT_MS = 10000;
    const scheduleDrawWhenReady = (
      data: any[],
      draw: (d: any[]) => void | Promise<void>,
      onFail: () => void
    ) => {
      const tryDraw = () => {
        if (chartContainer && chartContainer.clientWidth > 0 && chartContainer.clientHeight > 0) {
          draw(data);
          return true;
        }
        return false;
      };
      if (tryDraw()) return;
      if (!chartContainer) {
        onFail();
        return;
      }
      let observer: ResizeObserver | null = null;
      const timeoutId = setTimeout(() => {
        observer?.disconnect();
        onFail();
      }, SCHEDULE_DRAW_TIMEOUT_MS);
      observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            observer?.disconnect();
            clearTimeout(timeoutId);
            draw(data);
            return;
          }
        }
      });
      observer.observe(chartContainer);
    };

    onMount(async () => {
      // Default channels are automatically loaded by defaultChannelsStore when class/project changes
      // No need to fetch here - the store handles it reactively
      
      debug('MapTimeSeries: onMount called, fetching data...');
      
      // Set initialization flag early to prevent effects from running during mount
      isInitialized = false;
      
      // In live mode, skip fetching from IndexedDB - data comes from streaming store
      if (!liveMode) {
        setIsTimelineLoading(true);
        await fetchData();
      } else {
        debug('MapTimeSeries: Live mode - skipping IndexedDB fetch, using streaming data');
      }
      
      // Only fetch media data separately if not found in unified store
      const currentMediaWindows = mediaWindows();
      if (currentMediaWindows.length === 0) {
        const datasetDate = window.datasetDate;
        if (datasetDate) {
          debug('MapTimeSeries: No media found in unified store, fetching separately...');
          await fetchMediaData(datasetDate);
        } else {
          debug('MapTimeSeries: No dataset date available for media fetching (no map data loaded yet)');
        }
      } else {
        debug('MapTimeSeries: Media data already available from unified store:', currentMediaWindows.length, 'items');
      }
      
      // Video menu availability is now managed by the global store
      debug('MapTimeSeries: Video menu available:', hasVideoMenu());
      
      // Wait for chart container to be sized (ResizeObserver for splitscreen/production where layout may be delayed)
      let containerReady = false;
      for (let i = 0; i < 20 && !chartContainer; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (chartContainer && chartContainer.clientWidth > 0 && chartContainer.clientHeight > 0) {
        containerReady = true;
      }
      if (!containerReady && chartContainer) {
        containerReady = await new Promise<boolean>((resolve) => {
          const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                observer.disconnect();
                resolve(true);
                return;
              }
            }
          });
          observer.observe(chartContainer!);
          setTimeout(() => {
            observer.disconnect();
            resolve(false);
          }, 5000);
        });
      }
      if (!containerReady) {
        debug('MapTimeSeries: Chart container not ready after waiting, proceeding anyway (ResizeObserver will draw when sized)');
      }

      // When container was not ready (e.g. splitscreen), one-shot ResizeObserver to draw once it gets size
      if (!containerReady && chartContainer && (dataToShow().length > 0 || values().length > 0)) {
        const dataToDraw = dataToShow().length > 0 ? dataToShow() : values();
        const oneShotObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
              oneShotObserver.disconnect();
              debug('MapTimeSeries: Container got size (ResizeObserver), drawing chart');
              drawChart(dataToDraw);
              if (props.onMapUpdate) props.onMapUpdate(dataToDraw);
              return;
            }
          }
        });
        oneShotObserver.observe(chartContainer);
        setTimeout(() => oneShotObserver.disconnect(), 5000);
      }
      
      // Initialize chart if data is available (single render on mount)
      const currentData = dataToShow();
      const currentValues = values();
      debug('MapTimeSeries: Mount data check:', { 
        dataToShowLength: currentData.length, 
        valuesLength: currentValues.length,
        hasData: currentValues.length > 0,
        containerReady,
        containerWidth: chartContainer?.clientWidth || 0
      });
      
      // Single initial render - choose the best data source
      if (currentData.length > 0) {
        debug('MapTimeSeries: Selected events', selectedEvents());
        debug('MapTimeSeries: Initial chart render on mount with', currentData.length, 'points');
        
        // Draw chart with current data (event_id assignment no longer needed - using selectedRanges)
        debug('MapTimeSeries: Initial data:', currentData.length, 'points');
        
        // Ensure chart container is ready before drawing (split view may have zero size initially)
        if (chartContainer && chartContainer.clientWidth > 0) {
          drawChart(currentData);
        } else {
          warn('MapTimeSeries: Chart container not ready, scheduling delayed draw');
          scheduleDrawWhenReady(currentData, drawChart, () => warn('MapTimeSeries: Chart container still not ready after waiting (chart will draw when container gets size)'));
        }
        
        // Also send data to map on initial load
        // Apply range filtering if selectedRange exists (e.g., when navigating from explore/timeseries)
        if (props.onMapUpdate) {
          let dataToSend = currentData;
          const currentSelectedRange = selectedRange();
          
          if (currentSelectedRange && currentSelectedRange.length > 0) {
            const rangeItem = currentSelectedRange[0];
            const startTime = new Date(rangeItem.start_time).getTime();
            const endTime = new Date(rangeItem.end_time).getTime();
            
            dataToSend = currentData.filter(d => {
              const timestamp = getTimestamp(d).getTime();
              return timestamp >= startTime && timestamp <= endTime;
            });
            debug('MapTimeSeries: Filtered initial data by selectedRange:', dataToSend.length, 'points');
          }
          
          debug('MapTimeSeries: Sending initial data to map:', dataToSend.length, 'points');
          props.onMapUpdate(dataToSend);
        }
      } else if (currentValues.length > 0) {
        debug('MapTimeSeries: Values available but dataToShow empty, forcing chart draw');
        
        // Draw chart with current values (event_id assignment no longer needed - using selectedRanges)
        debug('MapTimeSeries: Initial values:', currentValues.length, 'points');
        
        // Ensure chart container is ready before drawing (split view may have zero size initially)
        if (chartContainer && chartContainer.clientWidth > 0) {
          drawChart(currentValues);
        } else {
          warn('MapTimeSeries: Chart container not ready for values draw, scheduling delayed draw');
          scheduleDrawWhenReady(currentValues, drawChart, () => warn('MapTimeSeries: Chart container still not ready for values after waiting (chart will draw when container gets size)'));
        }
        
        // Also send data to map on initial load
        // Apply range filtering if selectedRange exists (e.g., when navigating from explore/timeseries)
        if (props.onMapUpdate) {
          let dataToSend = currentValues;
          const currentSelectedRange = selectedRange();
          
          if (currentSelectedRange && currentSelectedRange.length > 0) {
            const rangeItem = currentSelectedRange[0];
            const startTime = new Date(rangeItem.start_time).getTime();
            const endTime = new Date(rangeItem.end_time).getTime();
            
            dataToSend = currentValues.filter(d => {
              const timestamp = getTimestamp(d).getTime();
              return timestamp >= startTime && timestamp <= endTime;
            });
            debug('MapTimeSeries: Filtered initial values by selectedRange:', dataToSend.length, 'points');
          }
          
          debug('MapTimeSeries: Sending initial values to map:', dataToSend.length, 'points');
          props.onMapUpdate(dataToSend);
        }
      } else {
        debug('MapTimeSeries: No data available on mount');
        // Still notify MapContainer that fetch completed (even if empty) so it can clear loading state
        if (props.onMapUpdate) {
          debug('MapTimeSeries: Notifying MapContainer that fetch completed with no data');
          props.onMapUpdate([]);
        }
      }
      
      // Final fallback: ensure selectedTime is set after everything is loaded (only when not playing)
      // Skip when playback is active so we don't steal control and pause the user's playback
      setTimeout(() => {
        if (isPlaying()) return;
        if (!selectedTime() || selectedTime() < new Date('1971-01-01T12:00:00Z')) {
          debug('⏰ MapTimeSeries: Final fallback selectedTime initialization');
          
          const currentData = dataToShow();
          const currentValues = values();
          const dataSource = currentData.length > 0 ? currentData : currentValues;
          
          if (dataSource && dataSource.length > 0) {
            const firstDataPoint = dataSource[0];
            const timestamp = firstDataPoint.Datetime || firstDataPoint.timestamp || firstDataPoint.time || firstDataPoint.datetime;
            if (timestamp) {
              const firstTime = new Date(timestamp);
              if (!isNaN(firstTime.getTime())) {
                debug('⏰ MapTimeSeries: Setting selectedTime from first data point', firstTime.toISOString());
                
                if (requestTimeControl('maptimeseries')) {
                  setSelectedTime(firstTime, 'maptimeseries');
                  window.lastSelectedTime = new Date(firstTime);
                }
              }
            }
          }
        }
      }, 200);
      
      // Set initialization flag AFTER chart is drawn to prevent effects from interfering
      isInitialized = true;
      window.hasInitialDataLoad = true; // Allow cached data effect to work after initialization
      
      // Initialize lastSelectedEvents to ensure effect triggers on first run if selectedEvents exist
      // This ensures map updates when navigating to Map.jsx with existing selections
      const currentSelectedEvents = selectedEvents();
      const currentSelectedRange = selectedRange();
      const currentCutEvents = cutEvents();
      
      window.lastSelectedEvents = currentSelectedEvents ? JSON.parse(JSON.stringify(currentSelectedEvents)) : [];
      window.lastSelectedRange = currentSelectedRange.length > 0 ? JSON.parse(JSON.stringify(currentSelectedRange)) : [];
      window.lastCutEvents = currentCutEvents.length > 0 ? JSON.parse(JSON.stringify(currentCutEvents)) : [];
      
      // Check if selectedRange exists on mount (e.g., when navigating from explore/timeseries)
      if (currentSelectedRange && currentSelectedRange.length > 0) {
        debug('MapTimeSeries: onMount detected selectedRange', {
          startTime: currentSelectedRange[0].start_time,
          endTime: currentSelectedRange[0].end_time
        });
      }
      
      // One-time restoration of brush selection if there's an external selectedRange
      // The brush will also be restored in drawChart's finally block and by the reactive effect,
      // but this ensures it's restored even if chart was already drawn before this code runs
      if ((currentSelectedRange.length > 0 || currentCutEvents.length > 0) && window.restoreMapBrushSelection) {
        // Use a longer timeout to ensure chart is fully drawn
        setTimeout(() => {
          if (window.restoreMapBrushSelection) {
            window.restoreMapBrushSelection();
            debug('MapTimeSeries: onMount restored brush selection');
          }
        }, 600);
      }

      // Improved resize handler for consistent width updates
      let resizeTimeout;
      const handleResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          const currentData = dataToShow();
          if (currentData.length > 0 && chartContainer) {
            const newWidth = chartContainer.clientWidth || 600;
            
            // Only redraw if width actually changed
            if (Math.abs(newWidth - (window.chartLastWidth || 0)) > 5) {
              debug('MapTimeSeries: Width changed, redrawing chart', { 
                oldWidth: window.chartLastWidth, 
                newWidth 
              });
              drawChart(currentData);
            }
          }
        }, 100); // Debounce resize events
      };

      window.addEventListener('resize', handleResize);
      
      // Add ResizeObserver for more consistent container size detection
      if (window.ResizeObserver && chartContainer) {
        const resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const newWidth = entry.contentRect.width;
            if (Math.abs(newWidth - (window.chartLastWidth || 0)) > 5) {
              debug('MapTimeSeries: ResizeObserver detected width change', { 
                oldWidth: window.chartLastWidth, 
                newWidth 
              });
              handleResize();
            }
          }
        });
        resizeObserver.observe(chartContainer);
        
        // Store observer for cleanup
        window.timeSeriesResizeObserver = resizeObserver;
      }
      
      // Store the handler for cleanup
      window.timeSeriesResizeHandler = handleResize;
      
      // Add cross-window communication listener for selection updates
      const handleCrossWindowSelectionUpdate = (event) => {
        debug('🔄 MapTimeSeries: Received cross-window selection update', event.detail);

        const { type, selectedRange: incomingRange, hasSelection: incomingHasSelection } = event.detail;

        if (type === 'SELECTION_CHANGE') {
          debug('🔄 MapTimeSeries: Processing cross-window selection change', {
            range: incomingRange?.length || 0,
            hasSelection: incomingHasSelection
          });

          // Force a map update by clearing the signature and triggering the selectedRange effect
          lastMapUpdateSignature = null;
          
          // The selectedRange effect will handle the actual update
          // We just need to ensure it's not blocked by isUpdatingMap
          setTimeout(() => {
            if (isUpdatingMap) {
              debug('🔄 MapTimeSeries: Clearing isUpdatingMap flag for cross-window update');
              isUpdatingMap = false;
            }
          }, 50);
        } else {
          debug('🔄 MapTimeSeries: Received non-selection update', { type });
        }
      };

      // Listen for cross-window selection updates
      window.addEventListener('selectionStoreUpdate', handleCrossWindowSelectionUpdate);
      
      // Store the handler for cleanup
      window.timeSeriesCrossWindowHandler = handleCrossWindowSelectionUpdate;
    });

    // IMMEDIATE EFFECT FOR VERTICAL LINE - No debounce for instant feedback
    createEffect(() => {
      if (!isMounted) return;
      const currentSelectedTime = selectedTime();
      
      // Update playhead position immediately without debounce for fast UI feedback
      if (currentSelectedTime && window.chartPlayheadGroup && window.chartTimeScale) {
        const xPos = window.chartTimeScale(currentSelectedTime);
        window.chartPlayheadGroup.attr("transform", `translate(${xPos}, 0)`);
        
        // Update lastSelectedTime to track changes for the reactive effect
        window.lastSelectedTime = new Date(currentSelectedTime);
      }
    });

    // REACTIVE EFFECT FOR BRUSH RESTORATION - Watch selectedRange and restore brush when it changes
    // This ensures brush is visible when navigating from explore/timeseries to map
    createEffect(() => {
      if (!isMounted || !isInitialized) return;
      
      const currentSelectedRange = selectedRange();
      const currentCutEvents = cutEvents();
      
      // Only restore brush if chart is ready
      if (!window.brushGroup || !window.chartTimeScale) {
        // Chart not ready yet, retry after a short delay
        if (window.chartDrawn) {
          setTimeout(() => {
            if (window.restoreMapBrushSelection) {
              window.restoreMapBrushSelection();
            }
          }, 100);
        }
        return;
      }
      
      // Restore brush based on selectedRange or cutEvents
      if (currentSelectedRange && currentSelectedRange.length > 0) {
        const rangeItem = currentSelectedRange[0];
        const startTime = new Date(rangeItem.start_time);
        const endTime = new Date(rangeItem.end_time);
        
        // Convert time range to brush coordinates (must be valid or brush.move would clear selection)
        const x0 = window.chartTimeScale(startTime);
        const x1 = window.chartTimeScale(endTime);
        const scaleReady = Number.isFinite(x0) && Number.isFinite(x1);
        if (scaleReady) {
          // Update the brush selection to highlight the selected range
          isProgrammaticallyUpdatingBrush = true;
          window.brushGroup.call(d3.brushX().move, [x0, x1]);
          setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
          debug('MapTimeSeries: Reactive effect restored brush selection from selectedRange');
        }
        // If scale not ready (e.g. split view panel still sizing), do not clear brush - avoid move(null) that would trigger brushEnded and handleBrushClear
      } else if (currentCutEvents && currentCutEvents.length > 0) {
        // Clear brush selection for cut events - cut data is static and not interactive
        isProgrammaticallyUpdatingBrush = true;
        window.brushGroup.call(d3.brushX().move, null);
        setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
        debug('MapTimeSeries: Reactive effect cleared brush - cut events present');
      } else {
        // Clear brush selection only when store really has no range (avoids race where effect runs with stale empty range after brush, which would call move(null) and trigger brushEnded -> handleBrushClear)
        const rangeStillSet = selectedRange() && selectedRange().length > 0;
        if (!rangeStillSet) {
          isProgrammaticallyUpdatingBrush = true;
          window.brushGroup.call(d3.brushX().move, null);
          setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
          debug('MapTimeSeries: Reactive effect cleared brush - no selection');
        }
      }
    });

    // SINGLE CONSOLIDATED EFFECT - All updates flow through this one effect
    // This is the core of our optimized reactive architecture
    createEffect(() => {
      // Stop processing if component is unmounted
      if (!isMounted) {
        return;
      }
      
      // Track all reactive dependencies in one place
      const currentData = dataToShow();
      const currentMaptype = maptype();
      const currentSelectedTime = selectedTime();
      const currentSelectedEvents = selectedEvents();
      const currentSelectedRange = selectedRange();
      const currentCutEvents = cutEvents();
      const currentValues = values();
      const currentTimeWindow = timeWindow();
      const currentTheme = themeStore.theme();
      const currentPlaying = isPlaying && typeof isPlaying === 'function' ? isPlaying() : false;
      
      // Only log debug messages when we have data or are in live mode
      const isLiveMode = props?.liveMode || false;
      
      // Double-check mounted state after async operations
      if (!isMounted) {
        return;
      }
      
      // Early returns for invalid states
      if (!isInitialized) {
        if (isLiveMode || currentData.length > 0 || currentValues.length > 0) {
          debug('MapTimeSeries: Skipping - not initialized');
        }
        return;
      }
      
      if (currentData.length === 0) {
        // Only log if in live mode or if we had values (to avoid spam when component is inactive)
        if (isLiveMode || currentValues.length > 0) {
          debug('MapTimeSeries: Skipping - no data');
        }
        return;
      }
      
      // Check if selection was cleared (selectedEvents went from having values to empty)
      // This is important to detect even if other flags are set
      const wasSelectionCleared = (window.lastSelectedEvents && window.lastSelectedEvents.length > 0) && 
                                   (!currentSelectedEvents || currentSelectedEvents.length === 0);
      const maptypeChanged = currentMaptype !== (window.lastMaptype || '');
      
      // Skip if we're already processing to prevent infinite loops
      // BUT: Allow through if selection was cleared OR maptype/color changed (so first color change updates chart)
      if ((isUpdatingMap || isFetching || isDrawing) && !wasSelectionCleared && !maptypeChanged) {
        return;
      }
      
      // Skip brush interactions - brush handles its own updates without triggering chart redraw
      // Only allow through if selection was cleared
      if (isBrushActive && !wasSelectionCleared) {
        return;
      }
      
      // EARLY EXIT: Check if ONLY selectedTime changed - skip immediately without debounce
      // This prevents the effect from running at all when only time changes
      const lastSelectedTime = window.lastSelectedTime;
      const selectedTimeChanged = !lastSelectedTime || 
        !currentSelectedTime || 
        Math.abs(currentSelectedTime.getTime() - lastSelectedTime.getTime()) > 0;
      
      // Use currentData.length for lastMapDataLength comparison so videoOnly mode (where currentData is a subset) still early-exits when only selectedTime changes
      const onlySelectedTimeChanged = selectedTimeChanged &&
        currentMaptype === (window.lastMaptype || '') &&
        JSON.stringify(currentSelectedEvents || []) === JSON.stringify(window.lastSelectedEvents || []) &&
        JSON.stringify(currentSelectedRange || []) === JSON.stringify(window.lastSelectedRange || []) &&
        JSON.stringify(currentCutEvents || []) === JSON.stringify(window.lastCutEvents || []) &&
        currentTheme === (window.lastTheme || '') &&
        currentValues.length === (window.lastValuesLength || 0) &&
        currentData.length === (window.lastMapDataLength ?? currentData.length);
      
      if (onlySelectedTimeChanged && !wasSelectionCleared) {
        // Update lastSelectedTime to track the change (silently, no debug log to reduce noise)
        window.lastSelectedTime = currentSelectedTime ? new Date(currentSelectedTime) : null;
        return;
      }
      
      // Check if this is initial load (chart hasn't been drawn yet)
      const isInitialDraw = window.lastValuesLength === undefined && currentValues.length > 0;
      const hasDataButNoChart = (currentData.length > 0 || currentValues.length > 0) && !window.chartDrawn;
      const isInitialLoad = isInitialDraw || hasDataButNoChart;
      
      // For initial load, execute immediately without debounce
      if (isInitialLoad && isInitialized) {
        debug('MapTimeSeries: Initial load detected - executing immediately without debounce');
        
        // 1. HANDLE CHART REDRAW (maptype, selectedEvents, theme changes, cut events, data size changes)
        const needsChartRedraw = isInitialDraw ||
                                hasDataButNoChart ||
                                currentMaptype !== (window.lastMaptype || '') ||
                                JSON.stringify(currentSelectedEvents) !== JSON.stringify(window.lastSelectedEvents || []) ||
                                JSON.stringify(currentCutEvents) !== JSON.stringify(window.lastCutEvents || []) ||
                                currentTheme !== (window.lastTheme || '') ||
                                currentValues.length !== (window.lastValuesLength || 0);
        
        if (needsChartRedraw) {
          debug('MapTimeSeries: Chart needs redraw (initial load) - updating scales and redrawing');
          debug('MapTimeSeries: Redraw reasons:', {
            maptypeChanged: currentMaptype !== (window.lastMaptype || ''),
            selectedEventsChanged: JSON.stringify(currentSelectedEvents) !== JSON.stringify(window.lastSelectedEvents || []),
            cutEventsChanged: JSON.stringify(currentCutEvents) !== JSON.stringify(window.lastCutEvents || []),
            themeChanged: currentTheme !== (window.lastTheme || ''),
            dataSizeChanged: currentValues.length !== (window.lastValuesLength || 0),
            currentCutEvents: currentCutEvents?.length || 0,
            dataToDraw: currentData.length,
            currentValuesLength: currentValues.length,
            lastValuesLength: window.lastValuesLength || 0
          });
          
          debug('MapTimeSeries: Drawing chart with data (initial load):', {
            dataLength: currentData.length,
            hasCutEvents: currentCutEvents?.length > 0,
            cutTimeRange: currentCutEvents?.length > 0 ? {
              start: currentCutEvents[0]?.start_time,
              end: currentCutEvents[0]?.end_time
            } : null
          });
          
          // Draw chart with current data (event_id assignment no longer needed - using selectedRanges)
          initScales(currentData);
          drawChart(currentData);
          
          // Store current state to detect future changes (lastMapDataLength = displayed data length for early-exit when only selectedTime changes, e.g. videoOnly)
          window.lastMaptype = currentMaptype;
          window.lastSelectedEvents = currentSelectedEvents;
          window.lastCutEvents = currentCutEvents;
          window.lastTheme = currentTheme;
          window.lastValuesLength = currentValues.length;
          window.lastMapDataLength = currentData.length;
        }
        
        // Handle map data updates for initial load (skip debounce)
        const selectedEventsChanged = JSON.stringify(currentSelectedEvents || []) !== JSON.stringify(window.lastSelectedEvents || []);
        const selectedRangeChanged = JSON.stringify(currentSelectedRange || []) !== JSON.stringify(window.lastSelectedRange || []);
        const cutEventsChanged = JSON.stringify(currentCutEvents || []) !== JSON.stringify(window.lastCutEvents || []);
        const isInitialMapUpdate = window.lastMapDataLength === undefined;
        const hasSelectedEventsOnInit = isInitialMapUpdate && currentSelectedEvents && currentSelectedEvents.length > 0;
        const hasSelectedRangeOnInit = isInitialMapUpdate && currentSelectedRange && currentSelectedRange.length > 0;
        const shouldUpdateMapData = needsChartRedraw || 
                                     selectedRangeChanged ||
                                     selectedEventsChanged ||
                                     hasSelectedEventsOnInit ||
                                     hasSelectedRangeOnInit ||
                                     currentValues.length !== (window.lastMapDataLength || 0);
        
        if (props.onMapUpdate && shouldUpdateMapData && !isUpdatingMap) {
          // Skip if brush selection is active (brush handler already sent filtered data)
          if (!(isBrushSelectionActive && currentSelectedRange && currentSelectedRange.length > 0)) {
            isUpdatingMap = true;
            window.lastMapDataLength = currentData.length;
            
            let dataToSend = currentData;
            
            // Apply range filtering if needed
            if (currentSelectedRange && currentSelectedRange.length > 0) {
              debug('MapTimeSeries: Applying range filtering for map (initial load)');
              const rangeItem = currentSelectedRange[0];
              const startTime = new Date(rangeItem.start_time).getTime();
              const endTime = new Date(rangeItem.end_time).getTime();
              
              dataToSend = currentData.filter(d => {
                const timestamp = getTimestamp(d).getTime();
                return timestamp >= startTime && timestamp <= endTime;
              });
            } else if (currentCutEvents && currentCutEvents.length > 0) {
              debug('MapTimeSeries: Applying cut events filtering for map (initial load)', { cutRangesCount: currentCutEvents.length });
              
              dataToSend = currentData.filter(d => {
                const timestamp = getTimestamp(d);
                return currentCutEvents.some(range => {
                  if (typeof range === 'number') return false;
                  if (range.start_time && range.end_time) {
                    const startTime = new Date(range.start_time).getTime();
                    const endTime = new Date(range.end_time).getTime();
                    return timestamp >= startTime && timestamp <= endTime;
                  }
                  return false;
                });
              });
            }
            
            if (dataToSend.length > 0) {
              props.onMapUpdate(dataToSend);
            }
            
            isUpdatingMap = false;
          }
        }
        
        // Return early - don't process through debounced effect for initial load
        return;
      }
      
      // Clear any existing timeouts
      if (window.mapTimeSeriesUpdateTimeout) {
        clearTimeout(window.mapTimeSeriesUpdateTimeout);
      }
      
      // Debounce all updates to prevent rapid successive calls (only for subsequent updates)
      window.mapTimeSeriesUpdateTimeout = setTimeout(() => {
        // Update lastSelectedTime for future comparisons (already checked above, but update here too)
        window.lastSelectedTime = currentSelectedTime ? new Date(currentSelectedTime) : null;
        
        // 1. HANDLE CHART REDRAW (maptype, selectedEvents, theme changes, cut events, data size changes)
        // Force redraw on initial load if we have data but haven't drawn yet
        const isInitialDraw = window.lastValuesLength === undefined && currentValues.length > 0;
        // Also check if we have data but chart hasn't been drawn yet (chartDrawn flag)
        const hasDataButNoChart = (currentData.length > 0 || currentValues.length > 0) && !window.chartDrawn;
        const needsChartRedraw = isInitialDraw ||
                                hasDataButNoChart ||
                                currentMaptype !== (window.lastMaptype || '') ||
                                JSON.stringify(currentSelectedEvents) !== JSON.stringify(window.lastSelectedEvents || []) ||
                                JSON.stringify(currentCutEvents) !== JSON.stringify(window.lastCutEvents || []) ||
                                currentTheme !== (window.lastTheme || '') ||
                                currentValues.length !== (window.lastValuesLength || 0);
        
        if (needsChartRedraw) {
          debug('MapTimeSeries: Chart needs redraw - updating scales and redrawing');
          debug('MapTimeSeries: Redraw reasons:', {
            maptypeChanged: currentMaptype !== (window.lastMaptype || ''),
            selectedEventsChanged: JSON.stringify(currentSelectedEvents) !== JSON.stringify(window.lastSelectedEvents || []),
            cutEventsChanged: JSON.stringify(currentCutEvents) !== JSON.stringify(window.lastCutEvents || []),
            themeChanged: currentTheme !== (window.lastTheme || ''),
            dataSizeChanged: currentValues.length !== (window.lastValuesLength || 0),
            currentCutEvents: currentCutEvents?.length || 0,
            dataToDraw: currentData.length,
            currentValuesLength: currentValues.length,
            lastValuesLength: window.lastValuesLength || 0
          });
          
          debug('MapTimeSeries: Drawing chart with data:', {
            dataLength: currentData.length,
            hasCutEvents: currentCutEvents?.length > 0,
            cutTimeRange: currentCutEvents?.length > 0 ? {
              start: currentCutEvents[0]?.start_time,
              end: currentCutEvents[0]?.end_time
            } : null
          });
          
          // Draw chart with current data (event_id assignment no longer needed - using selectedRanges)
          initScales(currentData);
          drawChart(currentData);
          
          // Store current state to detect future changes
          window.lastMaptype = currentMaptype;
          window.lastSelectedEvents = currentSelectedEvents;
          window.lastCutEvents = currentCutEvents;
          window.lastTheme = currentTheme;
          window.lastValuesLength = currentValues.length;
        }
        
        // 2. SELECTED TIME UPDATES (vertical line) are now handled by immediate effect above
        // This improves responsiveness by avoiding the 100ms debounce for the line update
        
        // Always update lastSelectedEvents and lastCutEvents to track changes, even if chart redraw isn't needed
        // This ensures map updates when navigating to Map.jsx with existing selections
        // IMPORTANT: Check for changes BEFORE updating window.lastSelectedEvents to ensure we detect the change
        const selectedEventsChanged = JSON.stringify(currentSelectedEvents || []) !== JSON.stringify(window.lastSelectedEvents || []);
        const selectedRangeChanged = JSON.stringify(currentSelectedRange || []) !== JSON.stringify(window.lastSelectedRange || []);
        const cutEventsChanged = JSON.stringify(currentCutEvents || []) !== JSON.stringify(window.lastCutEvents || []);
        
        // Check if selection was cleared (selectedEvents went from having values to empty)
        // This is important to detect even if window.lastSelectedEvents was already []
        const hadSelectionBefore = window.lastSelectedEvents && window.lastSelectedEvents.length > 0;
        const hasSelectionNow = currentSelectedEvents && currentSelectedEvents.length > 0;
        const selectionWasCleared = hadSelectionBefore && !hasSelectionNow;
        
        // If selectedEvents changed (including going from having values to empty), force chart redraw
        // This ensures the chart updates when selection is cleared
        const needsRedrawForSelectionClear = selectedEventsChanged && selectionWasCleared;
        
        if (selectedEventsChanged) {
          window.lastSelectedEvents = currentSelectedEvents ? JSON.parse(JSON.stringify(currentSelectedEvents)) : [];
        }
        if (cutEventsChanged) {
          window.lastCutEvents = currentCutEvents ? JSON.parse(JSON.stringify(currentCutEvents)) : [];
        }
        
        // Force chart redraw if selection was cleared (went from having values to empty)
        // OR if selectedEvents changed and we need to update the chart
        if ((needsRedrawForSelectionClear || (selectedEventsChanged && !hasSelectionNow && hadSelectionBefore)) && !needsChartRedraw) {
          debug('MapTimeSeries: Selection cleared - forcing chart redraw', {
            needsRedrawForSelectionClear,
            selectedEventsChanged,
            hadSelectionBefore,
            hasSelectionNow,
            currentSelectedEventsLength: currentSelectedEvents?.length || 0,
            lastSelectedEventsLength: window.lastSelectedEvents?.length || 0
          });
          const dataToRedraw = currentData.length > 0 ? currentData : currentValues;
          // Draw chart with data (event_id assignment no longer needed - using selectedRanges)
          initScales(dataToRedraw);
          drawChart(dataToRedraw);
          // Update lastSelectedEvents after redraw to prevent duplicate redraws
          window.lastSelectedEvents = currentSelectedEvents ? JSON.parse(JSON.stringify(currentSelectedEvents)) : [];
        }
        
        // 3. HANDLE MAP DATA UPDATES (range filtering, event assignments)
        // Only update map data when something other than selectedTime changes
        // This avoids expensive operations during time scrubbing
        // Force update on initial load if selectedEvents exist (to ensure event coloring works)
        // Also force update on initial load if selectedRange exists (to ensure brush and map track are filtered)
        const isInitialMapUpdate = window.lastMapDataLength === undefined;
        const hasSelectedEventsOnInit = isInitialMapUpdate && currentSelectedEvents && currentSelectedEvents.length > 0;
        const hasSelectedRangeOnInit = isInitialMapUpdate && currentSelectedRange && currentSelectedRange.length > 0;
        const shouldUpdateMapData = needsChartRedraw || 
                                     needsRedrawForSelectionClear ||
                                     selectedRangeChanged ||
                                     selectedEventsChanged ||
                                     hasSelectedEventsOnInit ||
                                     hasSelectedRangeOnInit ||
                                     currentValues.length !== (window.lastMapDataLength || 0);
        
        if (props.onMapUpdate && !isUpdatingMap) {
          if (!shouldUpdateMapData) {
            // Only selectedTime changed - no map data update needed
          } else {
            // Skip map update if brush selection is active (brush handler already sent filtered data)
            if (isBrushSelectionActive && currentSelectedRange && currentSelectedRange.length > 0) {
              debug('MapTimeSeries: Skipping map update - brush selection active, already sent filtered data');
              return;
            }
            
            isUpdatingMap = true;
            
            // Store state to detect future changes
            if (selectedRangeChanged) {
              window.lastSelectedRange = currentSelectedRange ? JSON.parse(JSON.stringify(currentSelectedRange)) : [];
            }
            window.lastMapDataLength = currentData.length;
            
            debug('MapTimeSeries: Updating map data', {
              needsChartRedraw,
              rangeChanged: JSON.stringify(currentSelectedRange) !== JSON.stringify(window.lastSelectedRange || []),
              eventsChanged: JSON.stringify(currentSelectedEvents) !== JSON.stringify(window.lastSelectedEvents || []),
              dataSizeChanged: currentValues.length !== (window.lastMapDataLength || 0),
              isInitialMapUpdate,
              hasSelectedEventsOnInit,
              selectedEventsCount: currentSelectedEvents?.length || 0,
              isBrushSelectionActive
            });
            
            try {
              let dataToSend = currentData;
            
            // Apply range filtering if needed
            // Always apply range filtering when selectedRange exists (even if playing)
            // This ensures map track shows only selected data when navigating from explore
            if (currentSelectedRange && currentSelectedRange.length > 0) {
              debug('MapTimeSeries: Applying range filtering for map');
              const rangeItem = currentSelectedRange[0];
              const startTime = new Date(rangeItem.start_time).getTime();
              const endTime = new Date(rangeItem.end_time).getTime();
              
              dataToSend = currentData.filter(d => {
                const timestamp = getTimestamp(d).getTime();
                return timestamp >= startTime && timestamp <= endTime;
              });
              
              // Sync brush position with selectedRange (only if not playing to avoid conflicts)
              if (window.brushGroup && window.chartTimeScale && !currentPlaying) {
                // Use Date objects for scale conversion
                const startTimeDate = new Date(rangeItem.start_time);
                const endTimeDate = new Date(rangeItem.end_time);
                const x0 = window.chartTimeScale(startTimeDate);
                const x1 = window.chartTimeScale(endTimeDate);
                isProgrammaticallyUpdatingBrush = true;
                window.brushGroup.call(d3.brushX().move, [x0, x1]);
                // Increase delay to ensure brush "end" event fires before flag is reset
                // This prevents the brushEnded handler from clearing the selection
                setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 100);
                debug('MapTimeSeries: Synced brush with selectedRange');
              }
            } else if (currentCutEvents && currentCutEvents.length > 0) {
              // Handle cut events - support multiple cut ranges
              debug('MapTimeSeries: Applying cut events filtering for map', { cutRangesCount: currentCutEvents.length });
              
              dataToSend = currentData.filter(d => {
                const timestamp = getTimestamp(d);
                return currentCutEvents.some(range => {
                  // Handle both time range objects and event IDs (for backward compatibility)
                  if (typeof range === 'number') {
                    return false; // Skip if it's an event ID instead of a time range
                  }
                  if (range.start_time && range.end_time) {
                    const startTime = new Date(range.start_time).getTime();
                    const endTime = new Date(range.end_time).getTime();
                    return timestamp >= startTime && timestamp <= endTime;
                  }
                  return false;
                });
              });
              
              // Clear brush for cut events - cut data is static and not interactive
              if (window.brushGroup) {
                isProgrammaticallyUpdatingBrush = true;
                window.brushGroup.call(d3.brushX().move, null);
                setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
                debug('MapTimeSeries: Cleared brush for cut events');
              }
            } else {
              // No selection and no cut events - clear brush and send full data
              debug('MapTimeSeries: No selection or cut events - clearing brush and sending full data');
              
              // Clear brush selection flag
              isBrushSelectionActive = false;
              
              // Clear brush when selection is cleared
              if (window.brushGroup) {
                isProgrammaticallyUpdatingBrush = true;
                window.brushGroup.call(d3.brushX().move, null);
                setTimeout(() => { isProgrammaticallyUpdatingBrush = false; }, 0);
                debug('MapTimeSeries: Cleared brush - selection cleared');
              }
              
              // Send full data (no filtering)
              dataToSend = currentData;
            }
            
            // Send data to map (event_id assignment no longer needed - using selectedRanges)
            debug('MapTimeSeries: Sending data to map:', dataToSend.length, 'points');
            props.onMapUpdate(dataToSend);
            
            } finally {
              setTimeout(() => {
                isUpdatingMap = false;
              }, 0);
            }
          }
        }
        
        window.mapTimeSeriesUpdateTimeout = null;
      }, 100); // Shorter debounce for better responsiveness
    });

    // REMOVED: Data ready effect - now handled by single consolidated effect

    // Effect to watch triggerUpdate and force chart redraw when selection is cleared
    // This ensures the chart updates when clearSelection() is called from SelectionBanner
    createEffect(() => {
      if (!isMounted) return;
      const currentTriggerUpdate = triggerUpdate();
      const currentSelectedEvents = selectedEvents();
      const currentData = dataToShow();
      
      // Only react to triggerUpdate if it's true and we have data
      if (currentTriggerUpdate && currentData.length > 0 && isInitialized) {
        debug('MapTimeSeries: triggerUpdate detected - forcing chart redraw', {
          selectedEventsLength: currentSelectedEvents?.length || 0,
          dataLength: currentData.length
        });
        
        // Force chart redraw (event_id assignment no longer needed - using selectedRanges)
        initScales(currentData);
        drawChart(currentData);
        // Reset triggerUpdate after handling
        setTriggerUpdate(false);
        // Update lastSelectedEvents to match current state
        window.lastSelectedEvents = currentSelectedEvents ? JSON.parse(JSON.stringify(currentSelectedEvents)) : [];
      }
    });

    // Effect to handle filter changes – map uses only race/leg/cut, not global grade or TWA
    createEffect(() => {
      if (!isMounted) return;
      const statesEffect: string[] = [];
      const gradesEffect: number[] = [];
      const racesEffect = selectedRacesTimeseries();
      const legsEffect = selectedLegsTimeseries();
      
      const origData = untrack(() => originalValues());
      if (origData.length === 0) return;
      if (!isInitialized) return;
      
      const filterSignature = `${racesEffect.join(',')}-${legsEffect.join(',')}`;
      if (filterSignature === lastFilterSignature) {
        debug('MapTimeSeries: Filter state unchanged, skipping');
        return;
      }
      lastFilterSignature = filterSignature;
      
      debug('MapTimeSeries: Filters changed, applying locally (race/leg/cut only):', { races: racesEffect, legs: legsEffect });
      
      const shouldFilterEffect = isCut() || racesEffect.length > 0 || legsEffect.length > 0;
      
      let filteredData;
      if (shouldFilterEffect) {
        filteredData = applyDataFilter(origData, statesEffect, racesEffect, legsEffect, gradesEffect, undefined, { forceSelection: true });
        debug('MapTimeSeries: Filtered data from', origData.length, 'to', filteredData.length, 'points');
      } else {
        filteredData = origData;
        debug('MapTimeSeries: Passing full dataset with', origData.length, 'points to renderer');
      }
      
      setValues(filteredData);
    });

    // REMOVED: Individual effects - now handled by single consolidated effect

    // Effect to send time-window data during playback using brush duration as the window size
    createEffect(() => {
      if (!isMounted) return;
      const currentRange = selectedRange();
      const currentTime = selectedTime();
      const playing = isPlaying && typeof isPlaying === 'function' ? isPlaying() : false;

      if (!playing || !currentRange || currentRange.length === 0 || !currentTime) return;

      try {
        const rangeItem = currentRange[0];
        const brushStartTime = new Date(rangeItem.start_time);
        const brushEndTime = new Date(rangeItem.end_time);
        const windowSizeMs = Math.max(0, brushEndTime.getTime() - brushStartTime.getTime());
        const windowEnd = new Date(currentTime);
        const windowStart = new Date(windowEnd.getTime() - windowSizeMs);

        debug('⏱️ MapTimeSeries: Time-window playback update', {
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          windowSizeMs
        });

        const fullData = values();
        const filteredData = fullData.filter(d => {
          const ts = getTimestamp(d);
          return ts >= windowStart && ts <= windowEnd;
        });

        // Force map update during playback to avoid dedup
        lastMapUpdateSignature = null;
        const timestamped = filteredData.map((d, idx) => ({ ...d, _timeWindowTs: Date.now() + idx }));

        if (onMapUpdate) {
          isUpdatingMap = true;
          try {
            onMapUpdate(timestamped);
          } finally {
            setTimeout(() => {
              isUpdatingMap = false;
            }, 0);
          }
        }
      } catch (e) {
        debug('MapTimeSeries: Error in time-window playback effect', e);
      }
    });

    // REMOVED: selectedTime effect - now handled by single consolidated effect

    // Remove reactive effect entirely to prevent infinite loops
    // Brush restoration will only happen during chart initialization

    // Note: No IndexedDB persistence needed - ContinuousTrackRenderer filters by time ranges on-the-fly

    onCleanup(() => {
      // Mark component as unmounted to stop all effects
      isMounted = false;
      
      // Release time control when component unmounts
      debug('🗺️ MapTimeSeries: Releasing time control on cleanup');
      releaseTimeControl('maptimeseries');
      
      // Clean up any D3 selections
      if (chartContainer) {
        d3.select(chartContainer).selectAll("*").remove();
      }
      // Clean up brush timeout
      if (brushTimeout) {
        clearTimeout(brushTimeout);
      }
      // Clean up resize handler
      if (window.timeSeriesResizeHandler) {
        window.removeEventListener('resize', window.timeSeriesResizeHandler);
        delete window.timeSeriesResizeHandler;
      }
      // Clean up resize observer
      if (window.timeSeriesResizeObserver) {
        window.timeSeriesResizeObserver.disconnect();
        delete window.timeSeriesResizeObserver;
      }
      // Clean up observers
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (mutationObserver) {
        mutationObserver.disconnect();
      }
      // Clean up map update timeout
      if (window.mapUpdateTimeout) {
        clearTimeout(window.mapUpdateTimeout);
        window.mapUpdateTimeout = null;
      }
      // Clean up chart redraw timeout
      if (window.chartRedrawTimeout) {
        clearTimeout(window.chartRedrawTimeout);
        window.chartRedrawTimeout = null;
      }
      // Clean up consolidated update timeout
      if (window.mapTimeSeriesUpdateTimeout) {
        clearTimeout(window.mapTimeSeriesUpdateTimeout);
        window.mapTimeSeriesUpdateTimeout = null;
      }
      // Clean up additional timeouts
      if (window.selectedEventsRedrawTimeout) {
        clearTimeout(window.selectedEventsRedrawTimeout);
        window.selectedEventsRedrawTimeout = null;
      }
      if (window.maptypeRedrawTimeout) {
        clearTimeout(window.maptypeRedrawTimeout);
        window.maptypeRedrawTimeout = null;
      }
      if (window.cachedDataTimeout) {
        clearTimeout(window.cachedDataTimeout);
        window.cachedDataTimeout = null;
      }
      
      // Clean up cross-window communication listener
      if (window.timeSeriesCrossWindowHandler) {
        window.removeEventListener('selectionStoreUpdate', window.timeSeriesCrossWindowHandler);
        delete window.timeSeriesCrossWindowHandler;
      }
      
      // Clean up initialization flag
      delete window.hasInitialDataLoad;
    });

    return (
      <div 
        id="chart" 
        class="chart maptimeseries-chart" 
        ref={(el) => (chartContainer = el)}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          background: 'var(--color-bg-card)',
          transition: 'background-color 0.3s ease',
          position: 'relative',
          minHeight: isTimelineLoading() ? '120px' : undefined
        }}
      >
        <Show when={isTimelineLoading()}>
          <Loading message="Loading timeline..." containerStyle="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--color-bg-card); z-index: 10; min-height: 120px;" />
        </Show>
        {/* Video label positioned absolutely - only show if actual video exists for this date */}
        {debug('MapTimeSeries: Video label render check:', { 
          hasVideoMenu: hasVideoMenu(), 
          mediaWindowsLength: mediaWindows().length,
          shouldShow: mediaWindows().length > 0,
          componentMounted: true
        })}
        <Show when={mediaWindows().length > 0}>
          <div 
            class="video-label"
            style={{
              position: 'absolute',
              left: '45px', // 20px margin + 25px left margin
              top: '0px',   // Position above the chart
              zIndex: 5000,
              pointerEvents: 'none' // Don't interfere with chart interactions
            }}
          >
            Video
          </div>
        </Show>
      </div>
    );
  }