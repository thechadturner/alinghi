// Unified data store with HuniDB storage
import { createSignal } from "solid-js";
import { unifiedDataAPI, type DataPoint } from './unifiedDataAPI';
import { huniDBStore } from './huniDBStore';
import { debug, info, warn, error as logError } from '../utils/console';
import { LRUCache } from '../utils/lruCache';

import {
  selectedStatesManeuvers,
  selectedRacesManeuvers,
  selectedLegsManeuvers,
  selectedGradesManeuvers,
  selectedStatesAggregates,
  selectedRacesAggregates,
  selectedLegsAggregates,
  selectedGradesAggregates,
  selectedStatesTimeseries,
  selectedRacesTimeseries,
  selectedLegsTimeseries,
  selectedGradesTimeseries,
  isTrainingHourMode,
  raceOptions
} from './filterStore';
import { extractFilterOptions, applyDataFilter } from '../utils/dataFiltering';

type FilterContextDataSource = 'maneuvers' | 'aggregates' | 'timeseries';

function getFilterContextFromDataSource(dataSource: IndexedDBDataSource): FilterContextDataSource {
  if (dataSource === 'objects') return 'maneuvers';
  if (dataSource === 'aggregates') return 'aggregates';
  return 'timeseries'; // timeseries | mapdata
}

// Import missing types ('timeseries' alias for 'ts')
type ChartType = 'map' | 'overlay' | 'ts' | 'timeseries' | 'scatter' | 'probability' | 'polarrose' | 'parallel' | 'performance' | 'maneuvers';
type ChartDataMap = Record<string, any>;
type DataCategory = 'channel-values' | 'map-data' | 'statistics' | 'events';
type IndexedDBDataSource = 'mapdata' | 'timeseries' | 'aggregates' | 'objects';

/** Common params passed to fetchChartData / fetchDataWithChannelChecking (aligns with unifiedDataAPI param shapes). */
export interface FetchChartDataParams {
  className?: string;
  sourceId?: string | number;
  datasetId?: string | number;
  projectId?: string | number;
  sourceName?: string;
  channels?: string[];
  date?: string;
  timezone?: string | null;
  data_source?: 'auto' | 'file' | 'influx';
  resolution?: string;
  objectName?: string;
  [key: string]: unknown;
}

/** Options for chart data fetch (e.g. skip cache, force refresh). */
export interface FetchChartDataOptions {
  skipCache?: boolean;
  dataSource?: IndexedDBDataSource;
  [key: string]: unknown;
}

/** Value type for dataCache LRU entries. */
export interface DataCacheEntry {
  data: DataPoint[];
  timestamp: number;
  indexed: boolean;
  channels?: string[];
}

/** Value type for overlay in-memory storage. */
export interface OverlayStorageEntry {
  className: string;
  sourceId: string;
  channels: string[];
  data: DataPoint[];
  metadata: { timestamp: number; dataSize: number; lastUpdated: number; sorted: boolean };
}

/** Fallback when class object (filters_dataset) is missing; primary source is UnifiedFilterService.getRequiredFilterChannels(className, 'dataset'). */
const TIMESERIES_METADATA_CHANNELS_FALLBACK = ['Grade', 'State', 'Twa_deg', 'Race_number', 'Leg_number'] as const;

/** Channel names to never query from Influx (metadata / derived). Influx only queries data channels not in file system. */
const INFLUX_EXCLUDE_CHANNELS_LOWER = new Set([
  'datetime', 'timestamp', 'ts', 'grade', 'state', 'source_id', 'source_name', 'sourcename',
  'mainsail_code', 'tack', 'event_id', 'config', 'foiling_state', 'twa_deg', 'race_number', 'leg_number'
]);

function isMetadataChannelForInflux(ch: string): boolean {
  if (!ch || typeof ch !== 'string') return true;
  const l = ch.toLowerCase().trim();
  if (l.length === 0) return true;
  return INFLUX_EXCLUDE_CHANNELS_LOWER.has(l) || l.endsWith('_code') || l === 'config' || l === 'foiling_state';
}

import { persistantStore } from './persistantStore';
import UnifiedFilterService, { type FilterContext } from '../services/unifiedFilterService';
import { apiEndpoints } from '@config/env';
import { getData as fetchData, formatDate, getTimezoneForDate, getDayBoundsInTimezone } from '../utils/global';
import { liveMode } from './playbackStore';
import { user } from './userStore';
import { streamingDataService } from '../services/streamingDataService';
import { sourcesStore } from './sourcesStore';
import { fetchSources } from '../utils/colorScale';
import { defaultChannelsStore } from './defaultChannelsStore';
import { fetchDatasetTimezone } from './datasetTimezoneStore';
import { isMobileDevice } from '../utils/deviceDetection';
import { discoverChannels } from './channelDiscoveryStore';

/**
 * Determine the current filter context based on selected state
 * @returns The filter context: 'dataset', 'day', 'fleet', or 'source'
 */
const determineFilterContext = (): FilterContext => {
  const datasetId = persistantStore.selectedDatasetId?.();
  const sourceId = persistantStore.selectedSourceId?.();
  const date = persistantStore.selectedDate?.();
  
  // Dataset context: when dataset_id > 0
  if (datasetId && datasetId > 0) {
    return 'dataset';
  }
  
  // Day context: when date is valid and no dataset_id
  if (date && date !== '' && date !== '0' && (!datasetId || datasetId <= 0)) {
    return 'day';
  }
  
  // Source context: when source_id > 0 and no dataset_id (historical/source-specific views)
  if (sourceId && sourceId > 0 && (!datasetId || datasetId <= 0)) {
    return 'source';
  }
  
  // Fleet context: default for all other cases (project/all, multiple sources)
  return 'fleet';
};

// Event interface
export interface Event {
  event_id: number;
  event_type: string;
  start_time: string;
  end_time: string;
  tags: string | null;
}

// Chart type to data source mapping
export const CHART_SOURCE_MAPPING: Record<string, IndexedDBDataSource> = {
  'map': 'mapdata',
  'overlay': 'timeseries',
  'ts': 'timeseries',
  'timeseries': 'timeseries',
  'scatter': 'timeseries',
  'probability': 'timeseries',
  'polarrose': 'timeseries',
  'parallel': 'timeseries',
  'performance': 'aggregates',
  'maneuvers': 'objects'
};

// Simplified ChartData interface
export interface ChartData extends ChartDataMap {
  source?: IndexedDBDataSource;
  className?: string;
  sourceId?: string;
  channels?: string[];
}

// Unified data store interface
import type { DatasetMetadata } from './huniDBTypes';
import { escapeTableName } from './huniDBTypes';

export interface UnifiedDataStore {
  // Chart data
  chartData: () => ChartDataMap;
  setChartData: (value: ChartDataMap | ((prev: ChartDataMap) => ChartDataMap)) => Promise<void>;
  
  // Loading states
  loadingStates: () => Record<string, boolean>;
  setLoadingStates: (value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  
  // Error states
  errorStates: () => Record<string, string | null>;
  setErrorStates: (value: Record<string, string | null> | ((prev: Record<string, string | null>) => Record<string, string | null>)) => void;
  
  // Map data filtering signal
  mapDataFiltered: () => number;
  setMapDataFiltered: (value: number | ((prev: number) => number)) => void;
  
  // Data management methods
  fetchChartData: (chartType: ChartType, params?: FetchChartDataParams, options?: FetchChartDataOptions) => Promise<DataPoint[]>;
  updateChartData: (chartType: ChartType, data: DataPoint[]) => Promise<void>;
  getChartData: (chartType: ChartType) => Promise<DataPoint[]>;
  setLoading: (chartType: ChartType, loading: boolean) => void;
  setError: (chartType: ChartType, error: string | null) => void;
  getLoading: (chartType: ChartType) => boolean;
  getError: (chartType: ChartType) => string | null;
  // Progress tracking methods
  setProgress: (chartType: ChartType, className: string, sourceId: string | number, progress: number, message?: string) => void;
  getProgress: (chartType: ChartType, className: string, sourceId: string | number) => number | null;
  getProgressMessage: (chartType: ChartType, className: string, sourceId: string | number) => string | null;
  getDataSourceLoading: (chartType: ChartType, className: string, sourceId: string | number, dataSource: 'file' | 'influx') => boolean;
  getDataLoadingMessage: (chartType: ChartType, className: string, sourceId: string | number) => string;
  
  // Component access methods
  getData: (category: DataCategory, sourceId: string) => DataPoint[];
  getDataAsync: (category: DataCategory, sourceId: string) => Promise<DataPoint[]>;
  setData: (category: DataCategory, sourceId: string, data: DataPoint[]) => Promise<void>;
  getDataWithTimeRange: (category: DataCategory, sourceId: string, startTime?: Date, endTime?: Date) => DataPoint[];
  isDataCached: (key: string, maxAge?: number) => boolean;
  indexDataByTimestamp: (key: string, data: DataPoint[]) => void;
  
  // Storage management
  getStorageInfo: () => Promise<any>;
  clearAllData: () => Promise<void>;
  
  // Data fetching methods
  fetchDataWithChannelChecking: (chartType: ChartType, className: string, sourceId: string, requiredChannels: string[], params?: FetchChartDataParams, dataSource?: IndexedDBDataSource) => Promise<DataPoint[]>;
  fetchDataWithChannelCheckingFromFile: (chartType: ChartType, className: string, sourceId: string, requiredChannels: string[], params?: FetchChartDataParams, dataSource?: IndexedDBDataSource) => Promise<DataPoint[]>;
  /** Channels that were requested but not available (HuniDB or API). Used to show "Missing channel(s): X, Y" below chart instead of partial data. */
  getLastMissingChannels: (chartType: ChartType) => string[];
  queryDataByChannels: (className: string, sourceId: string, requestedChannels: string[], dataTypes?: string[], timeRange?: { start: number; end: number }, filters?: any) => Promise<any[]>;
  // Query-only method (no API fetch) - for child components that rely on parent pre-fetching
  queryCachedDataByChannels: (className: string, sourceId: string, requestedChannels: string[], dataTypes?: string[], timeRange?: { start: number; end: number }, filters?: any) => Promise<any[]>;
  
  // Overlay-specific methods
  storeOverlayData: (className: string, sourceId: string, channels: string[], data: DataPoint[]) => Promise<void>;
  getOverlayData: (className: string, sourceId: string) => DataPoint[];
  findClosestOverlayData: (className: string, sourceId: string, targetTime: Date) => DataPoint | null;
  clearOverlayData: (className?: string, sourceId?: string) => void;
  
  // Simple object storage methods
  storeObject: (objectName: string, data: any) => Promise<void>;
  getObject: (objectName: string) => Promise<any | null>;
  deleteObject: (objectName: string) => Promise<void>;
  listObjects: () => Promise<string[]>;
  // Filter options accessor
  getFilterOptions: (context?: FilterContext) => Promise<{ races: number[]; legOptions?: number[]; legs?: number[]; grades: number[]; raceToLegs?: Record<number, number[]> } | null>;
  
  // Legacy compatibility
  resetDataStore: () => Promise<void>;
  
  // Cache management
  clearCache: () => void;
  clearCacheForDataSource: (dataKey: string) => void;
  clearDatasetCache: (className: string, datasetId: string) => Promise<void>;
  
  // Events methods
  fetchEvents: (className: string, projectId: number, datasetId: number) => Promise<Event[]>;
  preloadEventsForDate: (className: string, projectId: number, date: string) => Promise<void>;
  getEvents: () => Event[];
  getEventsByType: (eventType: string) => Event[];
  getEventsByTimeRange: (startTime?: Date, endTime?: Date) => Event[];
  getEventById: (eventId: number) => Promise<Event | null>;
  getEventsByTypeFromIndexedDB: (eventType: string) => Promise<Event[]>;
  getEventsInTimeRangeFromIndexedDB: (startTime: string, endTime: string) => Promise<Event[]>;
  getEventsFromIndexedDB: () => Promise<Event[]>;
  clearEvents: () => Promise<void>;
  
  // Optimized methods for starttime/endtime queries by event_id
  getEventTimeRange: (eventId: number) => Promise<{ starttime: string; endtime: string } | null>;
  getEventTimeRanges: (eventIds: number[]) => Promise<Map<number, { starttime: string; endtime: string }>>;

  // Cached dataset metadata
  getCachedDatasetsForClass: (className?: string) => Promise<DatasetMetadata[]>;
  
  // Cache validation
  validateDatasetCache: (className: string, projectId: number) => Promise<{ invalidated: number[]; checked: number; discovered: number }>;
  
  // Map data loading for dataset initialization
  loadMapDataForDataset: (className: string, projectId: number, datasetId: number) => Promise<void>;
  
  // Update mapdata with event_id assignments using worker
  // Accepts either event IDs (number[]) or event objects
  updateMapdataWithEventIds: (className: string, sourceId: string, selectedEvents: number[] | Array<{ event_id: number; event_type: string; start_time: string; end_time: string; tags: any }>) => Promise<void>;
  
  // Cleanup
  dispose: () => void;

  // Day-level mapdata helpers
  fetchMapDataForDay: (className: string, projectId: number, dateYmd: string, selectedSourceIds?: Set<number>) => Promise<any[]>;
  getMapDataForDayFromCache: (className: string, projectId: number, dateYmd: string, selectedSourceIds?: Set<number>) => any[] | null;
  fetchMapDataForDataset: (className: string, projectId: number, datasetId: number, sourceId: number) => Promise<any[]>;
  getMapDataForDatasetFromCache: (className: string, projectId: number, datasetId: number, sourceId: number) => any[] | null;
  getCombinedMapData: (className: string, projectId: number, dateYmd: string) => Promise<any[]>;
  
  // Live mode / Redis data methods
  isLiveMode: () => boolean;
  fetchRedisHistoricalData: (sourceNames: string[], startTime: number, endTime: number) => Promise<void>;
  storeRedisDataAsMapdata: (sourceName: string, dataPoints: any[]) => Promise<void>;
  detectGapsAndRefetch: (sourceId: string, maxGapMs?: number) => Promise<void>;
}

// Query data by channels - wrapper for IndexedDB method
const queryDataByChannels = async (
  className: string,
  sourceId: string | number,
  requestedChannels: string[],
  dataTypes: string[] = ['timeseries'],
  timeRange?: { start: number; end: number },
  filters?: any
): Promise<any[]> => {
  // Timeseries: API + in-memory only; not stored in HuniDB. Skip DB call.
  if (dataTypes.length === 1 && dataTypes[0] === 'timeseries') {
    return [];
  }
  try {
    // Get datasetId and projectId from persistantStore
    const datasetId = Number(persistantStore.selectedDatasetId() || 0);
    const projectId = Number(persistantStore.selectedProjectId?.() || 0);
    const normalizedSourceId = Number(sourceId || 0);
    
    return await huniDBStore.queryDataByChannels(
      className,
      datasetId,
      projectId,
      normalizedSourceId,
      requestedChannels,
      dataTypes as any,
      timeRange,
      filters
    );
  } catch (error) {
    logError(`[UnifiedDataStore] Error querying data by channels:`, error);
    return [];
  }
};

// Query-only method (no API fetch) - for child components that rely on parent pre-fetching
// This method ONLY queries from HuniDB and never triggers API calls
const queryCachedDataByChannels = async (
  className: string,
  sourceId: string,
  requestedChannels: string[],
  dataTypes: string[] = ['timeseries'],
  timeRange?: { start: number; end: number },
  filters?: any
): Promise<any[]> => {
  // Timeseries: API + in-memory only; not stored in HuniDB. Skip DB call.
  if (dataTypes.length === 1 && dataTypes[0] === 'timeseries') {
    return [];
  }
  try {
    // Get datasetId and projectId from persistantStore
    const datasetId = String(persistantStore.selectedDatasetId() || '0');
    const projectId = String(persistantStore.selectedProjectId?.() || '0');
    
    // Only query from HuniDB - never trigger API fetches
    // This is for child components that rely on parent components pre-fetching all channels
    return await huniDBStore.queryDataByChannels(
      className,
      Number(datasetId),
      Number(projectId),
      Number(sourceId),
      requestedChannels,
      dataTypes as any,
      timeRange,
      filters
    );
  } catch (error) {
    debug(`[UnifiedDataStore] Error querying cached data (no API fetch):`, error);
    return []; // Return empty array if data not available - parent should have pre-fetched
  }
};

// Create the unified data store
export const unifiedDataStore: UnifiedDataStore = (() => {
  // HuniDB storage instance
  const storage = huniDBStore;
  
  // Channel availability tracking
  const channelAvailability = new Map<string, { className: string; sourceId: string; availableChannels: string[]; missingChannels: string[]; lastChecked: number }>();

  // Query cache to prevent duplicate API calls
  const queryCache = new Map<string, { data: any; timestamp: number }>();
  const CACHE_TTL = 30000; // 30 seconds cache TTL

  // Track ongoing storage operations to prevent duplicates
  const ongoingStorageOps = new Set<string>();
  
  // Track sources that consistently have no data to avoid repeated queries
  const sourcesWithNoData = new Set<string>();
  const NO_DATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes - don't retry sources with no data for 5 minutes
  const noDataTimestamps = new Map<string, number>();
  
  // Cache for latest Redis timestamp check (to avoid blocking on every isLiveMode call)
  let cachedLatestRedisTimestamp: number | null = null;
  let cachedLatestRedisTimestampTime: number = 0;
  const REDIS_TIMESTAMP_CACHE_TTL = 30 * 1000; // Cache for 30 seconds
  
  // Cache cleanup configuration
  let cacheCleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // Run cleanup every 5 minutes
  const DATA_CACHE_TTL = 60 * 60 * 1000; // 1 hour for dataCache entries
  
  // Loading states
  const [loadingStates, setLoadingStates] = createSignal<Record<string, boolean>>({});
  
  // Progress states - tracks progress percentage (0-100) per chart/source
  const [progressStates, setProgressStates] = createSignal<Record<string, number>>({});
  
  // Progress messages - tracks progress message per chart/source
  const [progressMessages, setProgressMessages] = createSignal<Record<string, string>>({});
  
  // Error states
  const [errorStates, setErrorStates] = createSignal<Record<string, string | null>>({});
  
  // Map data filtering signal
  const [mapDataFiltered, setMapDataFiltered] = createSignal(0);
  
  // Events state management
  const [events, setEvents] = createSignal<Event[]>([]);
  const [_eventsLoading, setEventsLoading] = createSignal<boolean>(false);
  const [_eventsError, setEventsError] = createSignal<string | null>(null);
  
  // Component access methods with IndexedDB integration
  // Use LRU cache to prevent unbounded memory growth
  const categoryData = new LRUCache<string, DataPoint[]>(50);
  const categoryLoading = new Map<string, boolean>();
  const categoryErrors = new Map<string, string | null>();
  
  // Timestamp-based indexes for fast lookups
  const timestampIndexes = new Map<string, Map<number, DataPoint[]>>();
  // Use LRU cache to prevent unbounded memory growth
  const dataCache = new LRUCache<string, DataCacheEntry>(100);
  /** Per chartType: channels requested but not found (HuniDB or API). Cleared on fetch start; set when returning empty/partial so UI shows "Missing channel(s): X" instead of partial data. */
  let lastMissingChannelsByChartType: Record<string, string[]> = {};

  // Helper function to create data key
  const createDataKey = (datasetId: string, projectId: string, sourceId: string, dataSource?: IndexedDBDataSource): string => {
    if (dataSource) {
      return `${dataSource}_${datasetId}_${projectId}_${sourceId}`;
    }
    return `${datasetId}_${projectId}_${sourceId}`;
  };

  /** Short stable hash of channel list for cache key - different scatter charts (different channels) must not share cache. */
  const hashChannelsForCache = (channels: string[]): string => {
    const s = [...channels].sort().join(',');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return Math.abs(h).toString(36).substring(0, 8);
  };

  /** Normalize objectName/page for cache key so different scatter pages (e.g. 'takeoffs' vs 'tws bsp') never share cache. */
  const normalizeObjectNameForCache = (name: string | undefined | null): string => {
    if (name == null || String(name).trim() === '') return '';
    return String(name).replace(/\s+/g, '_').trim();
  };

  // Helper function to create cache keys
  const _createCacheKey = (dataSource: IndexedDBDataSource, className: string, sourceId: string, channels: string[]): string => {
    return `${dataSource}_${className}_${sourceId}_${channels.sort().join(',')}`;
  };
  
  // Helper function to get cached data
  const getCachedData = (cacheKey: string): any | null => {
    const cached = queryCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }
    if (cached) {
      queryCache.delete(cacheKey); // Remove expired cache
    }
    return null;
  };
  
  // Helper function to set cached data
  const setCachedData = (cacheKey: string, data: any): void => {
    queryCache.set(cacheKey, { data, timestamp: Date.now() });
  };

  // Combined mapdata per day storage helpers
  const buildCombinedDayKey = (className: string, projectId: number, dateYmd: string, selectedSourceIds?: Set<number>) => {
    if (selectedSourceIds && selectedSourceIds.size > 0) {
      const sourceIdsStr = Array.from(selectedSourceIds).sort().join(',');
      return `combined_map_day_${className}_${projectId}_${dateYmd}_sources_${sourceIdsStr}`;
    }
    return `combined_map_day_${className}_${projectId}_${dateYmd}`;
  };

  /** Read-only: return combined day map data from in-memory cache only (no fetch, no IndexedDB). Returns null on cache miss. */
  const getMapDataForDayFromCache = (className: string, projectId: number, dateYmd: string, selectedSourceIds?: Set<number>): any[] | null => {
    const normalizedClassName = className.toLowerCase();
    const key = buildCombinedDayKey(normalizedClassName, projectId, dateYmd, selectedSourceIds);
    const cached = getCachedData(key);
    if (cached != null && Array.isArray(cached)) {
      return cached;
    }
    return null;
  };

  /**
   * When isTrainingHourMode: filter map data to points within TRAINING event time ranges for the selected hour(s).
   * Uses HuniDB agg.events (TRAINING events with tag HOUR) to get start/end times per hour.
   */
  const filterMapDataByTrainingHourRanges = async (
    className: string,
    projectId: number,
    dateYmd: string,
    data: any[]
  ): Promise<any[]> => {
    if (!data || data.length === 0) return data;
    const selectedHours = selectedRacesTimeseries();
    if (!selectedHours || selectedHours.length === 0) return data;
    const dateStr = dateYmd.length === 8 ? `${dateYmd.slice(0, 4)}-${dateYmd.slice(4, 6)}-${dateYmd.slice(6, 8)}` : dateYmd;
    try {
      const timezone = await getTimezoneForDate(className, projectId, dateStr);
      const { startMs, endMs } = getDayBoundsInTimezone(dateStr, timezone);
      const events = await huniDBStore.queryEvents(className.toLowerCase(), {
        eventType: 'TRAINING',
        projectId: String(projectId),
        timeRange: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }
      });
      const selectedHourSet = new Set(selectedHours.map((h) => String(h)));
      const eventsForHours = events.filter((e) => {
        const tags = e.tags || {};
        const h = tags.HOUR ?? tags.hour;
        return h !== undefined && h !== null && selectedHourSet.has(String(h));
      });
      if (eventsForHours.length === 0) {
        debug('[UnifiedDataStore.filterMapDataByTrainingHourRanges] No TRAINING events for selected hours', { selectedHours });
        return data;
      }
      const ranges = eventsForHours.map((e) => ({
        start: new Date(e.start_time).getTime(),
        end: new Date(e.end_time).getTime()
      }));
      debug('[UnifiedDataStore.filterMapDataByTrainingHourRanges] Applying hour filter', { selectedHours, rangesCount: ranges.length, eventsCount: eventsForHours.length });
      const filtered = data.filter((point) => {
        const t = point.Datetime ?? point.timestamp ?? point.time ?? point.datetime;
        if (t == null) return false;
        const ms = typeof t === 'number' ? t : new Date(t).getTime();
        if (Number.isNaN(ms)) return false;
        return ranges.some((r) => ms >= r.start && ms <= r.end);
      });
      debug('[UnifiedDataStore.fetchMapDataForDay] Training hour filter', { before: data.length, after: filtered.length, ranges: ranges.length });
      // If filter removed all points but we had data, return unfiltered so user still sees data (e.g. timezone/tag mismatch)
      if (filtered.length === 0 && data.length > 0) {
        warn('[UnifiedDataStore.filterMapDataByTrainingHourRanges] Hour filter removed all points; returning full day data', { selectedHours, rangesCount: ranges.length });
        return data;
      }
      return filtered;
    } catch (err) {
      debug('[UnifiedDataStore.filterMapDataByTrainingHourRanges] Error', err);
      return data;
    }
  };

  // Track active fetchMapDataForDay calls so concurrent callers share the same in-flight request
  const activeFetchMapDataForDayCalls = new Map<string, Promise<any[]>>();

  const fetchMapDataForDay = async (className: string, projectId: number, dateYmd: string, selectedSourceIds?: Set<number>): Promise<any[]> => {
    // Normalize className to lowercase for consistent key building
    const normalizedClassName = className.toLowerCase();
    const key = buildCombinedDayKey(normalizedClassName, projectId, dateYmd, selectedSourceIds);

    try {
      // If a fetch for this key is already in progress, await it so all callers get the same result
      const existingPromise = activeFetchMapDataForDayCalls.get(key);
      if (existingPromise) {
        debug('[UnifiedDataStore.fetchMapDataForDay] Reusing in-flight request', { key });
        return await existingPromise;
      }
      
      const cached = getCachedData(key);
      if (cached) {
        debug('[UnifiedDataStore.fetchMapDataForDay] Returning cached data', { key, count: Array.isArray(cached) ? cached.length : 0 });
        // Training-hour mode or hour-like options: return full day data (no race filter)
        if (isTrainingHourMode()) {
          return cached as any[];
        }
        const options = (typeof raceOptions === 'function' && raceOptions()) || [];
        const optionsLookLikeHours = options.length > 0 && options.every((o) => {
          const n = parseInt(String(o), 10);
          return Number.isFinite(n) && n >= 0 && n <= 23;
        });
        if (optionsLookLikeHours) {
          return cached as any[];
        }
        const filtered = applyDataFilter(cached as any[], undefined, undefined, undefined, undefined, 'timeseries');
        return filtered;
      }
      
      // Create the fetch promise and store it so concurrent calls can await it
      const fetchPromise = (async () => {
        try {
          // Get dataset rows for the day
          const dateDisplay = `${dateYmd.slice(0,4)}-${dateYmd.slice(4,6)}-${dateYmd.slice(6,8)}`;
      const url = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateDisplay)}`;
      debug('fetchMapDataForDay url', url);
      debug('[UnifiedDataStore.fetchMapDataForDay] Requesting dataset list', { className, projectId, dateDisplay });
      const resp = await fetchData(url);
      let list = (resp && (resp.data || resp)) || [];
      debug('[UnifiedDataStore.fetchMapDataForDay] Dataset response', list);
      debug('[UnifiedDataStore.fetchMapDataForDay] Dataset rows', { count: Array.isArray(list) ? list.length : 0 });
      
      // Filter by selected sources if provided
      if (selectedSourceIds && selectedSourceIds.size > 0) {
        const beforeCount = list.length;
        list = list.filter((row: any) => {
          const sid = Number(row.source_id ?? row.sourceId);
          return Number.isFinite(sid) && selectedSourceIds.has(sid);
        });
        debug('[UnifiedDataStore.fetchMapDataForDay] Filtered dataset list by selected sources', {
          beforeCount,
          afterCount: list.length,
          selectedSourceIds: Array.from(selectedSourceIds)
        });
      }
      
      if (!Array.isArray(list) || list.length === 0) {
        warn('[UnifiedDataStore.fetchMapDataForDay] No datasets found for date (after filtering)', { className, projectId, dateDisplay, dateYmd, selectedSourceIds: selectedSourceIds ? Array.from(selectedSourceIds) : undefined });
        setCachedData(key, []);
        return [];
      }

      // Resolve timezone for this class/project/date so date filtering uses local calendar date
      let resolvedTimezone: string | null = null;
      try {
        const tzResponse = await fetchData(`${apiEndpoints.app.datasets}/date/timezone?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateDisplay)}`);
        const tzData = tzResponse?.data ?? tzResponse;
        if (tzData?.timezone) resolvedTimezone = String(tzData.timezone).trim();
        if (resolvedTimezone) debug('[UnifiedDataStore.fetchMapDataForDay] Using timezone for date filter', { dateDisplay, timezone: resolvedTimezone });
      } catch (e) {
        debug('[UnifiedDataStore.fetchMapDataForDay] Could not fetch timezone for date, using fallback', e);
      }

      // Use defaultChannelsStore for channel names
      // For 'day' data (FleetMap): request position, heading, race/leg, and wind (for bad air overlay).
      // Twd_deg and Tws_kph are included so the bad air overlay can show in FleetMap when enabled.
      const channels = [
        'Datetime',
        defaultChannelsStore.latName(),
        defaultChannelsStore.lngName(),
        defaultChannelsStore.bspName(),
        defaultChannelsStore.hdgName(),
        defaultChannelsStore.twdName(),
        defaultChannelsStore.twsName(),
        'Race_number',
        'Leg_number'
      ];
      const combined: any[] = [];
      
      // Check if we have race filters to apply (for performance optimization) - mapdata uses timeseries filter context
      const selectedRaceNumbers = selectedRacesTimeseries()
        .map((r: string) => {
          // Handle 'TRAINING' string and convert to number
          if (r === 'TRAINING' || r === 'training' || r === '-1') return -1;
          const num = parseInt(String(r), 10);
          return isNaN(num) ? null : num;
        })
        .filter((n): n is number => n !== null);
      
      const hasRaceFilters = selectedRaceNumbers.length > 0;
      if (hasRaceFilters) {
        debug('[UnifiedDataStore.fetchMapDataForDay] Applying race filters for performance', { 
          raceNumbers: selectedRaceNumbers,
          count: selectedRaceNumbers.length 
        });
      }
      
      // Parallelize data fetching for all datasets to speed up loading
      const fetchPromises = list.map(async (row: any) => {
        const sid = String(row.source_id ?? row.sourceId);
        const datasetId = String(row.dataset_id ?? row.datasetId ?? '0');
        const sourceName = row.source_name ?? row.sourceName ?? sid;
        debug('[UnifiedDataStore.fetchMapDataForDay] Fetching mapdata', { sid, datasetId, sourceName });
        
        // Build filters if we have race selections (for performance)
        const _raceFilters = hasRaceFilters ? {
          raceNumbers: selectedRaceNumbers,
          legNumbers: [] as number[],
          grades: [] as number[],
          twaStates: [] as string[]
        } : undefined;
        
        // Timeseries/mapdata no longer cached in HuniDB - always fetch from API
        let data: any[] = [];
        if (!Array.isArray(data) || data.length === 0) {
          try {
            debug('[UnifiedDataStore.fetchMapDataForDay] No data via channel-check, forcing API fetch with day description', { sid, datasetId });
            const fetched = await unifiedDataAPI.fetchAndStoreMapData({
              className: String(className), // Use original className for API
              projectId: Number(projectId || 0),
              datasetId: Number(datasetId || 0),
              sourceName: String(sourceName),
              sourceId: Number(sid || 0), // Pass sourceId to ensure correct storage
              date: String(dateYmd),
              description: 'day' // Use 'day' description for FleetMap (more compressed)
            });
            if (Array.isArray(fetched) && fetched.length > 0) {
              data = fetched;
            } else {
              // No day data — fallback to full dataset (same as individual map) and filter to requested day
              debug('[UnifiedDataStore.fetchMapDataForDay] No day data found, trying dataset description fallback', { sid, datasetId });
              try {
                const fetchedDataset = await unifiedDataAPI.fetchAndStoreMapData({
                  className: String(className),
                  projectId: Number(projectId || 0),
                  datasetId: Number(datasetId || 0),
                  sourceName: String(sourceName),
                  sourceId: Number(sid || 0),
                  date: String(dateYmd),
                  description: 'dataset'
                });
                if (Array.isArray(fetchedDataset) && fetchedDataset.length > 0) {
                  const dateStr = (datetimeVal: any, tz: string | null): string | null => {
                    if (datetimeVal == null) return null;
                    if (tz) {
                      const formatted = formatDate(datetimeVal, tz);
                      return formatted && formatted.length >= 10 ? formatted.slice(0, 10) : null;
                    }
                    if (typeof datetimeVal === 'string' && datetimeVal.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(datetimeVal))
                      return datetimeVal.slice(0, 10);
                    const d = new Date(datetimeVal);
                    return !isNaN(d.getTime()) ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : null;
                  };
                  const filteredToDay = fetchedDataset.filter((d: any) => {
                    const dataDateStr = dateStr(d.Datetime ?? d.timestamp ?? d.time ?? d.datetime, resolvedTimezone);
                    return dataDateStr === dateDisplay;
                  });
                  if (filteredToDay.length > 0) {
                    data = filteredToDay;
                    debug('[UnifiedDataStore.fetchMapDataForDay] Using dataset description fallback, filtered to day', { sid, datasetId, before: fetchedDataset.length, after: filteredToDay.length });
                  }
                }
              } catch (datasetFallbackErr) {
                debug('[UnifiedDataStore.fetchMapDataForDay] Dataset fallback failed', datasetFallbackErr);
              }
            }
          } catch (forceErr) {
            debug('[UnifiedDataStore.fetchMapDataForDay] Force fetch failed', forceErr);
          }
        }
        debug('[UnifiedDataStore.fetchMapDataForDay] Received mapdata', { sid, count: Array.isArray(data) ? data.length : 0 });
        if (Array.isArray(data) && data.length > 0) {
          // NOTE: With the new dataset_id-based architecture, date filtering should not be needed
          // since each dataset is stored separately. However, keeping this as a safety check during transition.
          // Compare by calendar date in the dataset timezone (resolvedTimezone) so local date matches requested day.
          const requestedDate = new Date(dateDisplay);
          if (isNaN(requestedDate.getTime())) {
            warn('[UnifiedDataStore.fetchMapDataForDay] Invalid requested date', { dateDisplay, sid });
            data.forEach(d => { d.source_id = Number(sid); d.source_name = sourceName; });
            combined.push(...data);
          } else {
            const getDataPointDateStr = (datetimeVal: any, timezone: string | null): string | null => {
              if (datetimeVal == null) return null;
              if (timezone) {
                const formatted = formatDate(datetimeVal, timezone);
                return formatted ?? null;
              }
              if (typeof datetimeVal === 'string' && datetimeVal.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(datetimeVal))
                return datetimeVal.slice(0, 10);
              const d = new Date(datetimeVal);
              if (isNaN(d.getTime())) return null;
              const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
              return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            };

            if (data.length > 0) {
              const sample = data[0];
              debug('[UnifiedDataStore.fetchMapDataForDay] Sample data point', {
                sid,
                sampleDatetime: sample.Datetime,
                sampleDatetimeType: typeof sample.Datetime,
                requestedDate: dateDisplay,
                requestedDateParsed: requestedDate.toISOString()
              });
            }

            const filteredData = data.filter(d => {
              if (!d.Datetime) {
                debug('[UnifiedDataStore.fetchMapDataForDay] Missing Datetime field', { sid, sampleKeys: Object.keys(d) });
                return false;
              }
              const dataDateStr = getDataPointDateStr(d.Datetime, resolvedTimezone);
              if (dataDateStr == null) {
                debug('[UnifiedDataStore.fetchMapDataForDay] Invalid Datetime value', { sid, datetime: d.Datetime });
                return false;
              }
              return dataDateStr === dateDisplay;
            });

            if (filteredData.length !== data.length) {
              warn('[UnifiedDataStore.fetchMapDataForDay] Date filter removed data points', {
                sid,
                requestedDate: dateDisplay,
                beforeCount: data.length,
                afterCount: filteredData.length,
                removedCount: data.length - filteredData.length,
                sampleRemovedDate: data.find(d => getDataPointDateStr(d.Datetime, resolvedTimezone) !== dateDisplay)?.Datetime,
                sampleKeptDate: filteredData[0]?.Datetime
              });
            }

            if (filteredData.length === 0 && data.length > 0) {
              warn('[UnifiedDataStore.fetchMapDataForDay] ALL data filtered out by date - forcing API fetch', {
                sid,
                requestedDate: dateDisplay,
                requestedDateParsed: requestedDate.toISOString(),
                totalDataPoints: data.length,
                sampleDataDates: data.slice(0, 5).map(d => ({
                  raw: d.Datetime,
                  parsed: d.Datetime ? new Date(d.Datetime).toISOString() : 'null'
                }))
              });

              try {
                debug('[UnifiedDataStore.fetchMapDataForDay] Forcing API fetch for correct date', { sid, datasetId, dateYmd });
                const fetched = await unifiedDataAPI.fetchAndStoreMapData({
                  className: String(className),
                  projectId: Number(projectId || 0),
                  datasetId: Number(datasetId || 0),
                  sourceName: String(sourceName),
                  sourceId: Number(sid || 0),
                  date: String(dateYmd)
                });
                if (Array.isArray(fetched) && fetched.length > 0) {
                  await storeDataInIndexedDB('mapdata', normalizedClassName, Number(datasetId || 0), Number(projectId || 0), Number(sid || 0), channels, fetched);
                  const freshData = await huniDBStore.queryDataByChannels(
                    normalizedClassName,
                    Number(datasetId || 0),
                    Number(projectId || 0),
                    Number(sid || 0),
                    channels,
                    ['mapdata'] as any
                  );
                  const freshFiltered = freshData.filter(d => {
                    const dataDateStr = getDataPointDateStr(d.Datetime, resolvedTimezone);
                    return dataDateStr != null && dataDateStr === dateDisplay;
                  });
                  debug('[UnifiedDataStore.fetchMapDataForDay] Fresh API data after date filter', {
                    sid,
                    fetchedCount: fetched.length,
                    filteredCount: freshFiltered.length
                  });
                  freshFiltered.forEach(d => { d.source_id = Number(sid); d.source_name = sourceName; });
                  return freshFiltered;
                }
              } catch (forceErr) {
                warn('[UnifiedDataStore.fetchMapDataForDay] Force API fetch failed', forceErr);
              }
            }

            filteredData.forEach(d => { d.source_id = Number(sid); d.source_name = sourceName; });
            return filteredData;
          }
        }
        return []; // Return empty array if no data
      });
      
      // Wait for all parallel fetches to complete
      // Use Promise.allSettled to ensure all fetches complete even if some fail
      const results = await Promise.allSettled(fetchPromises);
      
      // Combine all results - use simple loop to avoid stack overflow with large arrays
      // Yield to event loop periodically for very large datasets to keep UI responsive
      const BATCH_SIZE = 10000; // Process in batches to avoid blocking
      let processedCount = 0;
      
      for (const settledResult of results) {
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          if (Array.isArray(result) && result.length > 0) {
            // Use simple loop instead of spread operator to avoid stack overflow
            for (let i = 0; i < result.length; i++) {
              const point = result[i];
              // CRITICAL: Ensure every data point has source_id field for proper track grouping
              // Some data points might not have source_id set (e.g., from fallback dataset data)
              // Extract source_id from the point or use the dataset row's source_id
              if (!point.source_id && point.sourceId === undefined && point.Source_id === undefined) {
                // Try to find source_id from the original dataset row
                // We need to track which dataset row this came from
                // For now, log a warning and skip points without source_id
                warn('[UnifiedDataStore.fetchMapDataForDay] Data point missing source_id', {
                  pointKeys: Object.keys(point).slice(0, 10),
                  samplePoint: { ...point, Datetime: point.Datetime }
                });
                continue; // Skip points without source_id
              }
              
              // Normalize source_id field name to ensure consistency
              if (point.sourceId !== undefined && !point.source_id) {
                point.source_id = Number(point.sourceId);
              } else if (point.Source_id !== undefined && !point.source_id) {
                point.source_id = Number(point.Source_id);
              } else if (point.sourceID !== undefined && !point.source_id) {
                point.source_id = Number(point.sourceID);
              }
              
              // Ensure source_id is a number
              if (point.source_id !== undefined) {
                point.source_id = Number(point.source_id);
              }
              
              combined.push(point);
              processedCount++;
              
              // Yield to event loop every BATCH_SIZE items to keep UI responsive
              if (processedCount % BATCH_SIZE === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
              }
            }
          }
        } else {
          // Log failed fetches but continue processing others
          warn('[UnifiedDataStore.fetchMapDataForDay] One of the parallel fetches failed', settledResult.reason);
        }
      }
      
          // Validate that all combined data points have source_id
          const pointsWithoutSourceId = combined.filter(p => !p.source_id && p.sourceId === undefined && p.Source_id === undefined);
          if (pointsWithoutSourceId.length > 0) {
            warn('[UnifiedDataStore.fetchMapDataForDay] Some data points are missing source_id after combination', {
              totalPoints: combined.length,
              pointsWithoutSourceId: pointsWithoutSourceId.length,
              sampleMissing: pointsWithoutSourceId[0] ? Object.keys(pointsWithoutSourceId[0]).slice(0, 10) : []
            });
          }
          
          debug('[UnifiedDataStore.fetchMapDataForDay] Combined total', { 
            count: combined.length,
            uniqueSources: [...new Set(combined.map(p => p.source_id).filter(id => id !== undefined))].length,
            sampleSourceIds: [...new Set(combined.map(p => p.source_id).filter(id => id !== undefined))].slice(0, 5)
          });
          setCachedData(key, combined);
          let filtered: any[];
          // Training-hour mode: no hour filter — use full day data for all sources (user requested)
          if (isTrainingHourMode()) {
            filtered = combined;
            debug('[UnifiedDataStore.fetchMapDataForDay] Training hour mode — returning full day data (no hour filter)', { count: combined.length });
          } else {
            // When no race selection yet, or when options are hour indices (training bins), don't apply race filter so we don't hide data
            const selectedRaces = selectedRacesTimeseries();
            const options = (typeof raceOptions === 'function' && raceOptions()) || [];
            const optionsLookLikeHours = options.length > 0 && options.every((o) => {
              const n = parseInt(String(o), 10);
              return Number.isFinite(n) && n >= 0 && n <= 23;
            });
            if (selectedRaces.length === 0 || optionsLookLikeHours) {
              filtered = combined;
              debug('[UnifiedDataStore.fetchMapDataForDay] Skipping race filter (no selection or hour options)', { count: combined.length, optionsLookLikeHours });
            } else {
              filtered = applyDataFilter(combined, undefined, undefined, undefined, undefined, 'timeseries');
              debug('[UnifiedDataStore.fetchMapDataForDay] After race/leg filter', { before: combined.length, after: filtered.length });
            }
          }
          // Note: Map data is already stored in map.data table via fetchAndStoreMapData/storeDataInIndexedDB
          // No need to store in JSON object - that was incorrect
          
          // Trigger background sync of channels from PostgreSQL (non-blocking)
          if (className && projectId && dateYmd) {
            import('../services/channelsService').then(({ syncChannelsFromPostgreSQL }) => {
              syncChannelsFromPostgreSQL(className, projectId, dateYmd)
                .catch(err => {
                  // Silently fail - background sync shouldn't block UI
                  debug('[UnifiedDataStore.fetchMapDataForDay] Background channel sync failed:', err);
                });
            }).catch(err => {
              debug('[UnifiedDataStore.fetchMapDataForDay] Failed to import channelsService:', err);
            });
          }
          
          return filtered;
        } catch (e) {
          warn('[UnifiedDataStore] fetchMapDataForDay failed', e);
          return [];
        } finally {
          // Always remove from active calls when done (success or error)
          const normalizedClassName = className.toLowerCase();
          const key = buildCombinedDayKey(normalizedClassName, projectId, dateYmd, selectedSourceIds);
          activeFetchMapDataForDayCalls.delete(key);
        }
      })();
      
      // Store the promise so concurrent calls can await it
      activeFetchMapDataForDayCalls.set(key, fetchPromise);
      
      // Await and return the result
      return await fetchPromise;
    } catch (e) {
      // Outer catch for any errors before creating the promise
      warn('[UnifiedDataStore] fetchMapDataForDay outer error', e);
      return [];
    }
  };

  /** Read-only: return map dataset data from in-memory cache only (no fetch). Returns null on cache miss. */
  const getMapDataForDatasetFromCache = (className: string, projectId: number, datasetId: number, sourceId: number): any[] | null => {
    const normalizedClassName = className.toLowerCase();
    const key = `map_dataset_${normalizedClassName}_${projectId}_${datasetId}_${sourceId}`;
    const cached = getCachedData(key);
    if (cached != null && Array.isArray(cached)) {
      return cached;
    }
    return null;
  };

  const fetchMapDataForDataset = async (className: string, projectId: number, datasetId: number, sourceId: number): Promise<any[]> => {
    const normalizedSourceId = Number(sourceId);
    if (!Number.isFinite(normalizedSourceId) || normalizedSourceId <= 0) {
      warn('[UnifiedDataStore.fetchMapDataForDataset] Invalid source_id (expected positive number):', normalizedSourceId, 'raw:', sourceId);
      return [];
    }
    // Normalize className to lowercase for consistent key building
    const normalizedClassName = className.toLowerCase();
    const key = `map_dataset_${normalizedClassName}_${projectId}_${datasetId}_${normalizedSourceId}`;
    
    try {
      // Check cache first
      const cached = getCachedData(key);
      if (cached) {
        debug('[UnifiedDataStore.fetchMapDataForDataset] Returning cached data', { key, count: Array.isArray(cached) ? cached.length : 0 });
        return cached as any[];
      }

      // Get source name for API calls. Resolution order: store → refresh store → dataset info API (authoritative for this dataset) → project sources API.
      let sourceName = sourcesStore.getSourceName(normalizedSourceId);
      if (!sourceName) {
        await sourcesStore.refresh();
        sourceName = sourcesStore.getSourceName(normalizedSourceId);
      }
      if (!sourceName && datasetId) {
        try {
          const datasetInfoRes = await fetchData(
            `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`
          );
          const fromDataset = (datasetInfoRes as { success?: boolean; data?: { source_name?: string } })?.data?.source_name;
          if (fromDataset && typeof fromDataset === 'string') sourceName = fromDataset;
        } catch (_) {
          // ignore; fall through to fetchSources
        }
      }
      if (!sourceName) {
        const projectSources = await fetchSources(className, projectId);
        const match = projectSources.find((s) => Number(s.source_id) === normalizedSourceId);
        sourceName = match?.source_name ?? null;
      }
      if (!sourceName) {
        warn(`[UnifiedDataStore.fetchMapDataForDataset] Could not get source_name for source_id ${normalizedSourceId} (sources may not be loaded for this project)`);
        return [];
      }

      // Use defaultChannelsStore for channel names
      // CRITICAL: For 'dataset' data (explore/map), request all channels available in dataset data:
      // Datetime, Lat_dd, Lng_dd, Bsp_kph, Hdg_deg, Tws_kph, Twd_deg, Twa_deg, Vmg_kph, Vmg_perc, State, Race_number, Leg_number, Grade, Phase_id, Maneuver_type
      const channels = [
        'Datetime',
        defaultChannelsStore.latName(),
        defaultChannelsStore.lngName(),
        defaultChannelsStore.bspName(),
        defaultChannelsStore.hdgName(),
        defaultChannelsStore.twsName(),
        defaultChannelsStore.twdName(),
        defaultChannelsStore.twaName(),
        defaultChannelsStore.vmgName(),
        'Vmg_perc',
        'State',
        'Race_number',
        'Leg_number',
        'Grade',
        'Phase_id',
        'Maneuver_type'
      ];

      debug('[UnifiedDataStore.fetchMapDataForDataset] Fetching mapdata', { datasetId, sourceId: normalizedSourceId, sourceName, channels });

      // Timeseries/mapdata no longer cached in HuniDB - always fetch from API
      let data: any[] = [];

      if (!Array.isArray(data) || data.length === 0) {
        try {
          debug('[UnifiedDataStore.fetchMapDataForDataset] No data via channel-check, forcing API fetch with dataset description', { datasetId, sourceId: normalizedSourceId });
          const fetched = await unifiedDataAPI.fetchAndStoreMapData({
            className: String(className), // Use original className for API
            projectId: Number(projectId || 0),
            datasetId: Number(datasetId || 0),
            sourceName: String(sourceName),
            sourceId: normalizedSourceId, // Pass sourceId to ensure correct storage
            description: 'dataset' // Use 'dataset' description for explore/map (full detail)
          });
          if (Array.isArray(fetched) && fetched.length > 0) {
            data = fetched;
          }
        } catch (forceErr) {
          debug('[UnifiedDataStore.fetchMapDataForDataset] Force fetch failed', forceErr);
        }
      }

      debug('[UnifiedDataStore.fetchMapDataForDataset] Received mapdata', { datasetId, sourceId: normalizedSourceId, count: Array.isArray(data) ? data.length : 0 });

      if (Array.isArray(data) && data.length > 0) {
        // Ensure source_id and source_name are set on each point
        data.forEach(d => { 
          d.source_id = normalizedSourceId; 
          d.source_name = sourceName; 
        });

        // Sort by timestamp for proper rendering
        data.sort((a, b) => {
          const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
          const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
          return tsA - tsB;
        });

        // Cache the result
        setCachedData(key, data);
        return data;
      }

      return [];
    } catch (e) {
      warn('[UnifiedDataStore] fetchMapDataForDataset failed', e);
      return [];
    }
  };

  const getCombinedMapData = async (className: string, projectId: number, dateYmd: string): Promise<any[]> => {
    const key = buildCombinedDayKey(className, projectId, dateYmd);
    const cached = getCachedData(key);
    if (cached) return cached as any[];
    // Map data should be queried from map.data table, not from JSON object
    // If not in cache, fetch it using fetchMapDataForDay which queries from map.data
    try {
      return await fetchMapDataForDay(className, projectId, dateYmd);
    } catch {
      return [];
    }
  };

  // Helper function to extract channels from data
  const extractChannelsFromData = (data: any[]): string[] => {
    if (!data || data.length === 0) return [];
    
    // Use a map to deduplicate by case-insensitive comparison
    // lowercase -> original case (prefer the first occurrence, or the one with more capitals)
    const channelMap = new Map<string, string>();
    
    data.forEach(point => {
      Object.keys(point).forEach(key => {
        // Include all channels except only the numeric timestamp field
        // Keep Datetime as it's needed for time-based operations
        if (key !== 'timestamp') {
          const keyLower = key.toLowerCase();
          // If we already have this channel (case-insensitive), prefer the one with more capital letters
          if (channelMap.has(keyLower)) {
            const existing = channelMap.get(keyLower)!;
            const existingCaps = (existing.match(/[A-Z]/g) || []).length;
            const currentCaps = (key.match(/[A-Z]/g) || []).length;
            // Prefer the one with more capital letters (likely original case)
            if (currentCaps > existingCaps) {
              channelMap.set(keyLower, key);
            }
            // Otherwise keep existing
          } else {
            channelMap.set(keyLower, key);
          }
        }
      });
    });
    
    return Array.from(channelMap.values()).sort();
  };

  // Helper function to extract only channels that have valid data (not undefined)
  const extractValidChannelsFromData = (data: any[]): string[] => {
    if (!data || data.length === 0) return [];
    
    // Use a map to deduplicate by case-insensitive comparison
    // lowercase -> original case (prefer the one with more capitals)
    const channelMap = new Map<string, string>();
    
    data.forEach(point => {
      Object.keys(point).forEach(key => {
        // Only include channels that have valid (non-undefined) values
        if (key !== 'timestamp' && point[key] !== undefined) {
          const keyLower = key.toLowerCase();
          // If we already have this channel (case-insensitive), prefer the one with more capital letters
          if (channelMap.has(keyLower)) {
            const existing = channelMap.get(keyLower)!;
            const existingCaps = (existing.match(/[A-Z]/g) || []).length;
            const currentCaps = (key.match(/[A-Z]/g) || []).length;
            // Prefer the one with more capital letters (likely original case)
            if (currentCaps > existingCaps) {
              channelMap.set(keyLower, key);
            }
            // Otherwise keep existing
          } else {
            channelMap.set(keyLower, key);
          }
        }
      });
    });
    
    return Array.from(channelMap.values()).sort();
  };

  // Async version of data filtering for large datasets
  const filterDataAsync = async (data: any[]): Promise<any[]> => {
    if (!data || data.length === 0) return [];
    
    // For small datasets, process synchronously
    if (data.length < 1000) {
      return data.filter(point => {
        const allValues = Object.values(point);
        const validValues = allValues.filter(value => 
          value !== undefined && value !== null
        );
        return validValues.length > 0;
      });
    }
    
    // For large datasets, process in chunks
    return new Promise((resolve) => {
      const result: any[] = [];
      const chunkSize = 1000;
      let index = 0;
      
      const processChunk = () => {
        const endIndex = Math.min(index + chunkSize, data.length);
        
        for (let i = index; i < endIndex; i++) {
          const point = data[i];
          const allValues = Object.values(point);
          const validValues = allValues.filter(value => 
            value !== undefined && value !== null
          );
          if (validValues.length > 0) {
            result.push(point);
          }
        }
        
        index = endIndex;
        
        if (index < data.length) {
          // Yield control and continue processing
          setTimeout(processChunk, 0);
        } else {
          resolve(result);
        }
      };
      
      processChunk();
    });
  };

  // Async version of channel extraction
  const extractChannelsFromDataAsync = async (data: any[]): Promise<string[]> => {
    if (!data || data.length === 0) return [];
    
    // For small datasets, process synchronously
    if (data.length < 1000) {
      return extractChannelsFromData(data);
    }
    
    // For large datasets, process in chunks
    return new Promise((resolve) => {
      const channelSet = new Set<string>();
      const chunkSize = 1000;
      let index = 0;
      
      const processChunk = () => {
        const endIndex = Math.min(index + chunkSize, data.length);
        
        for (let i = index; i < endIndex; i++) {
          const point = data[i];
          Object.keys(point).forEach(key => {
            if (key !== 'timestamp') {
              channelSet.add(key);
            }
          });
        }
        
        index = endIndex;
        
        if (index < data.length) {
          setTimeout(processChunk, 0);
        } else {
          resolve(Array.from(channelSet).sort());
        }
      };
      
      processChunk();
    });
  };

  // Async version of valid channel extraction
  const extractValidChannelsFromDataAsync = async (data: any[]): Promise<string[]> => {
    if (!data || data.length === 0) return [];
    
    // For small datasets, process synchronously
    if (data.length < 1000) {
      return extractValidChannelsFromData(data);
    }
    
    // For large datasets, process in chunks
    return new Promise((resolve) => {
      const channelSet = new Set<string>();
      const chunkSize = 1000;
      let index = 0;
      
      const processChunk = () => {
        const endIndex = Math.min(index + chunkSize, data.length);
        
        for (let i = index; i < endIndex; i++) {
          const point = data[i];
          Object.keys(point).forEach(key => {
            if (key !== 'timestamp' && point[key] !== undefined) {
              channelSet.add(key);
            }
          });
        }
        
        index = endIndex;
        
        if (index < data.length) {
          setTimeout(processChunk, 0);
        } else {
          resolve(Array.from(channelSet).sort());
        }
      };
      
      processChunk();
    });
  };

  // Async version of data sorting by timestamp
  const sortDataByTimestampAsync = async (data: any[]): Promise<any[]> => {
    if (!data || data.length === 0) return [];
    
    // For small datasets, sort synchronously
    if (data.length < 5000) {
      return data.sort((a, b) => {
        const timeA = new Date(a.Datetime).getTime();
        const timeB = new Date(b.Datetime).getTime();
        return timeA - timeB;
      });
    }
    
    // For large datasets, sort in chunks and merge
    return new Promise((resolve) => {
      const chunkSize = 1000;
      const sortedChunks: any[][] = [];
      let index = 0;
      
      const processChunk = () => {
        const chunk = data.slice(index, index + chunkSize);
        const sortedChunk = chunk.sort((a, b) => {
          const timeA = new Date(a.Datetime).getTime();
          const timeB = new Date(b.Datetime).getTime();
          return timeA - timeB;
        });
        sortedChunks.push(sortedChunk);
        
        index += chunkSize;
        
        if (index < data.length) {
          setTimeout(processChunk, 0);
        } else {
          // Merge sorted chunks
          const merged = mergeSortedChunksByTimestamp(sortedChunks);
          resolve(merged);
        }
      };
      
      processChunk();
    });
  };

  // Merge sorted chunks by timestamp
  const mergeSortedChunksByTimestamp = (chunks: any[][]): any[] => {
    if (chunks.length === 1) return chunks[0];
    
    const result: any[] = [];
    const indices = new Array(chunks.length).fill(0);
    
    while (true) {
      let minIndex = -1;
      let minValue = Infinity;
      
      for (let i = 0; i < chunks.length; i++) {
        if (indices[i] < chunks[i].length) {
          const value = new Date(chunks[i][indices[i]].Datetime).getTime();
          if (value < minValue) {
            minValue = value;
            minIndex = i;
          }
        }
      }
      
      if (minIndex === -1) break;
      
      result.push(chunks[minIndex][indices[minIndex]]);
      indices[minIndex]++;
    }
    
    return result;
  };



  // Helper function to get data source for chart type
  const getDataSourceForChart = (chartType: ChartType): IndexedDBDataSource => {
    return CHART_SOURCE_MAPPING[chartType] || 'timeseries';
  };


  /**
   * Normalize data fields to use standard names and remove duplicate case variations
   * Standard names: Grade, State, Race_number, Leg_number
   */
  const normalizeDataFields = async (data: any[], requestedChannels?: string[]): Promise<any[]> => {
    if (!data || data.length === 0) return data;
    
    const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
    
    // Check if Grade, State, Race_number, Leg_number are requested
    const requestedChannelsLower = requestedChannels ? new Set(requestedChannels.map(ch => ch.toLowerCase())) : new Set();
    const _isGradeRequested = requestedChannelsLower.has('grade');
    const _isStateRequested = requestedChannelsLower.has('state');
    const _isRaceNumberRequested = requestedChannelsLower.has('race_number');
    const _isLegNumberRequested = requestedChannelsLower.has('leg_number');
    
    // Wait for sourcesStore to be ready if needed (before processing all points)
    if (!sourcesStore.isReady()) {
      let attempts = 0;
      const maxAttempts = 50; // 5 seconds max wait
      while (!sourcesStore.isReady() && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
    }
    
    return data.map(point => {
      const normalized = { ...point };
      const normalizedMetadata = extractAndNormalizeMetadata(point);
      
      // Remove ALL case variations of metadata fields (but keep standard names if they exist)
      const fieldsToRemove = [
        // Grade variations (remove all, will add back as 'Grade' if it exists)
        'GRADE', 'grade',
        // State variations (remove all, will add back as 'State' if it exists)
        'STATE', 'state', 'FOILING_STATE', 'Foiling_state', 'foiling_state', 'FoilingState', 'foilingState',
        // Race_number variations (remove all, will add back as 'Race_number' if it exists)
        'RACE', 'race_number', 'RACE_NUMBER', 'RaceNumber', 'raceNumber',
        // Leg_number variations (remove all, will add back as 'Leg_number' if it exists)
        'LEG', 'leg_number', 'LEG_NUMBER', 'LegNumber', 'legNumber',
        // Other metadata
        'CONFIG', 'config',
        'EVENT', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
        'SOURCE_NAME', 'Source_name', 'Source', 'SOURCE', 'source'
      ];
      
      // CRITICAL: Remove ALL case variations including standard names - we'll add them back from normalizedMetadata
      // This ensures we never have duplicates (e.g., both 'race_number' and 'Race_number')
      const standardMetadataFields = ['Grade', 'State', 'Race_number', 'Leg_number'];
      standardMetadataFields.forEach(field => {
        // Remove all case variations of standard fields
        const fieldLower = field.toLowerCase();
        Object.keys(normalized).forEach(key => {
          if (key.toLowerCase() === fieldLower) {
            delete normalized[key];
          }
        });
      });
      
      // Remove all other variations
      fieldsToRemove.forEach(field => {
        if (field in normalized) {
          delete normalized[field];
        }
      });
      
      // Add normalized metadata using standard names (only if values exist)
      // CRITICAL: Always add these if they exist in normalizedMetadata, even if not explicitly requested
      // This ensures Grade, State, Race_number, Leg_number are always present when available
      if (normalizedMetadata.Grade !== undefined && normalizedMetadata.Grade !== null) {
        normalized.Grade = normalizedMetadata.Grade;
      }
      if (normalizedMetadata.State !== undefined && normalizedMetadata.State !== null) {
        normalized.State = normalizedMetadata.State;
      }
      if (normalizedMetadata.Race_number !== undefined && normalizedMetadata.Race_number !== null) {
        normalized.Race_number = normalizedMetadata.Race_number;
      }
      if (normalizedMetadata.Leg_number !== undefined && normalizedMetadata.Leg_number !== null) {
        normalized.Leg_number = normalizedMetadata.Leg_number;
      }
      
      // Handle Twa/Twa_deg duplicates - keep only Twa_deg if both exist
      if ('Twa' in normalized && 'Twa_deg' in normalized) {
        // Prefer Twa_deg (the actual channel name)
        normalized.Twa_deg = normalized.Twa_deg ?? normalized.Twa;
        delete normalized.Twa;
      } else if ('Twa' in normalized && !('Twa_deg' in normalized)) {
        // If only 'Twa' exists, rename it to 'Twa_deg' for consistency
        normalized.Twa_deg = normalized.Twa;
        delete normalized.Twa;
      }
      
      // CRITICAL: Remove 'ts' field (seconds) if 'timestamp' (milliseconds) exists
      // Only keep 'timestamp' in milliseconds - 'ts' is redundant
      if ('ts' in normalized && 'timestamp' in normalized) {
        delete normalized.ts;
      } else if ('ts' in normalized && !('timestamp' in normalized)) {
        // If only 'ts' exists, convert it to 'timestamp' in milliseconds
        const tsValue = normalized.ts;
        if (typeof tsValue === 'number' && tsValue < 1e12) {
          // ts is in seconds (less than 1e12), convert to milliseconds
          normalized.timestamp = Math.round(tsValue * 1000);
        } else {
          // ts is already in milliseconds or invalid, use as-is
          normalized.timestamp = tsValue;
        }
        delete normalized.ts;
      }
      
      // CRITICAL: Populate source_name from sourcesStore if source_id is available but source_name is missing
      if ((!normalized.source_name || normalized.source_name === undefined || normalized.source_name === 'undefined' || normalized.source_name === null) && normalized.source_id) {
        try {
          // Handle both string and number source_id values
          let sourceId: number;
          if (typeof normalized.source_id === 'string') {
            sourceId = Number(normalized.source_id);
          } else {
            sourceId = normalized.source_id;
          }
          
          // Only proceed if sourceId is valid and sourcesStore is ready
          // Note: sourcesStore readiness is checked before the map loop, so it should be ready here
          if (sourceId && !isNaN(sourceId) && sourceId !== 0 && sourcesStore.isReady()) {
            const resolvedSourceName = sourcesStore.getSourceName(sourceId);
            if (resolvedSourceName) {
              normalized.source_name = resolvedSourceName;
            }
          }
        } catch (e) {
          // Silently fail - source_name might not be critical for all use cases
          debug(`[normalizeDataFields] Could not populate source_name from source_id ${normalized.source_id}:`, e);
        }
      }
      
      return normalized;
    });
  };

  // Store data in IndexedDB with proper organization using channel-based storage
  // CRITICAL: This function should ALWAYS store data when called - optimization checks are best-effort only
  const storeDataInIndexedDB = async (
    dataSource: IndexedDBDataSource,
    className: string,
    datasetId: number,
    projectId: number,
    sourceId: number,
    channels: string[],
    data: any[],
    params?: any
  ): Promise<void> => {
    // No-op: timeseries/mapdata/aggregates no longer cached in HuniDB
    return;
    // CRITICAL: If params indicates this data came from API (fresh fetch), 
    // skip optimization check and always store - API data should always be cached
    const isFromAPI = params?.fromAPI !== false; // Default to true if not specified
    const shouldSkipOptimization = isFromAPI || params?.forceStore === true;
    // Convert className to lowercase for consistent storage
    const normalizedClassName = className.toLowerCase();
    
    // Import normalization utility
    const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
    
    try {
      // Filter out data points that are completely invalid (all values undefined/null)
      // Use async filtering for large datasets
      const filteredData = await filterDataAsync(data);
      
      if (filteredData.length === 0) {
        warn(`[storeDataInIndexedDB] No valid data points to store after filtering undefined values`);
        return;
      }
      
      // OPTIMIZATION: Check if data already exists before storing
      // CRITICAL: Skip this check if data is from API (fresh fetch) - API data should always be cached
      // Only perform optimization check for non-API sources or when explicitly requested
      if (filteredData.length > 0 && dataSource !== 'objects' && !shouldSkipOptimization) {
        try {
          const timestamps = filteredData
            .map((d: any) => d.timestamp || (d.Datetime ? new Date(d.Datetime).getTime() : null))
            .filter((ts: any) => ts != null && !isNaN(ts))
            .sort((a: number, b: number) => a - b);
          
          if (timestamps.length > 0) {
            const minTimestamp = timestamps[0];
            const maxTimestamp = timestamps[timestamps.length - 1];
            
            // Quick check: query for a few sample timestamps to see if data exists
            const _sampleTimestamps = [
              minTimestamp,
              maxTimestamp,
              ...(timestamps.length > 2 ? [timestamps[Math.floor(timestamps.length / 2)]] : [])
            ];
            
            // Check if any of these timestamps already exist in the database
            // CRITICAL: This is an optimization to avoid duplicate storage, but should NOT prevent storage
            // when data is fresh from API - only skip if we're certain the exact same data exists
            try {
              const existingData = await huniDBStore.queryDataByChannels(
                normalizedClassName,
                Number(datasetId),
                Number(projectId),
                Number(sourceId),
                channels.slice(0, 1), // Just check one channel for speed
                [dataSource] as ('mapdata' | 'timeseries' | 'aggregates')[],
                { start: minTimestamp, end: maxTimestamp }
              );
              
              // If we have data for this time range, check if it's complete
              if (existingData && existingData.length > 0) {
                // Check if we have all requested channels
                const existingChannels = await huniDBStore.getAvailableChannels(
                  normalizedClassName,
                  Number(datasetId),
                  Number(projectId),
                  Number(sourceId),
                  [dataSource] as ('mapdata' | 'timeseries' | 'aggregates')[]
                );
                
                const existingChannelsLower = new Set(existingChannels.map((ch: string) => ch.toLowerCase()));
                const allChannelsExist = channels.every((ch: string) => 
                  existingChannelsLower.has(ch.toLowerCase()) ||
                  ['Datetime', 'datetime', 'timestamp', 'source_id', 'source_name'].includes(ch.toLowerCase())
                );
                
                // CRITICAL: Only skip if we have ALL channels AND similar row count (90% threshold)
                // This prevents skipping when data is incomplete or when new channels are added
                if (allChannelsExist && existingData.length >= filteredData.length * 0.9) {
                  // Data already exists with all channels - skip storage
                  info(`[storeDataInIndexedDB] ⚡ Data already exists in HuniDB (${existingData.length} rows, all ${channels.length} channels) - skipping storage for performance`, {
                    className: normalizedClassName,
                    datasetId,
                    projectId,
                    sourceId,
                    existingRows: existingData.length,
                    newRows: filteredData.length,
                    existingChannels: existingChannels.length,
                    requestedChannels: channels.length,
                    allChannelsExist,
                    dataSource
                  });
                  return;
                } else {
                  debug(`[storeDataInIndexedDB] Data exists but incomplete - will store new data`, {
                    className: normalizedClassName,
                    datasetId,
                    projectId,
                    sourceId,
                    existingRows: existingData.length,
                    newRows: filteredData.length,
                    existingChannels: existingChannels.length,
                    requestedChannels: channels.length,
                    allChannelsExist,
                    dataSource
                  });
                }
              } else {
                debug(`[storeDataInIndexedDB] No existing data found - will store new data`, {
                  className: normalizedClassName,
                  datasetId,
                  projectId,
                  sourceId,
                  newRows: filteredData.length,
                  requestedChannels: channels.length,
                  dataSource,
                  timeRange: { start: minTimestamp, end: maxTimestamp }
                });
              }
            } catch (checkError) {
              // CRITICAL: If the check fails (e.g., HuniDB is empty or query fails), 
              // we should still proceed with storage - don't let optimization prevent caching
              warn(`[storeDataInIndexedDB] Optimization check failed - proceeding with storage anyway:`, {
                error: checkError,
                className: normalizedClassName,
                datasetId,
                projectId,
                sourceId,
                note: 'This is expected when HuniDB is empty or during first load. Storage will proceed.'
              });
            }
          }
            } catch (checkError) {
          // If check fails, proceed with storage (better safe than sorry)
          debug(`[storeDataInIndexedDB] Could not verify existing data, proceeding with storage:`, checkError);
        }
      } else if (shouldSkipOptimization) {
        // Data is from API - always store regardless of optimization checks
        debug(`[storeDataInIndexedDB] Data from API - skipping optimization check, will always store`, {
          className: normalizedClassName,
          datasetId,
          projectId,
          sourceId,
          dataPoints: filteredData.length,
          channels: channels.length,
          dataSource
        });
      }
      
      // Normalize metadata fields before storing (for all data sources)
      // This ensures consistent field names internally while preserving channel names
      // CRITICAL: For timeseries data, Race_number, Leg_number, and Grade can be actual data channels
      // Only remove them if they're NOT explicitly requested channels
      const channelsLower = new Set(channels.map((ch: string) => ch.toLowerCase()));
      const isRaceNumberRequested = channelsLower.has('race_number');
      const isLegNumberRequested = channelsLower.has('leg_number');
      const isGradeRequested = channelsLower.has('grade');
      
      filteredData.forEach((point: any) => {
        const normalizedMetadata = extractAndNormalizeMetadata(point);
        
        // Preserve Race_number, Leg_number, and Grade if they're explicitly requested channels
        const preservedRaceNumber = isRaceNumberRequested ? (point.Race_number ?? point.race_number) : undefined;
        const preservedLegNumber = isLegNumberRequested ? (point.Leg_number ?? point.leg_number) : undefined;
        const preservedGrade = isGradeRequested ? (point.Grade ?? point.grade ?? point.GRADE) : undefined;
        
        // Preserve description field - critical for mapdata filtering (day vs dataset)
        const preservedDescription = point.description ?? point.Description ?? undefined;
        
        // Remove all case variations of metadata fields (but keep standard names: Grade, State, Race_number, Leg_number)
        const metadataFieldsToRemove = [
          'STATE', 'state', 'FOILING_STATE', 'Foiling_state', 'foiling_state', 'FoilingState', 'foilingState',  // Keep 'State'
          'CONFIG', 'config',  // Keep 'Config'
          'EVENT', 'event', 'event_name', 'Event_name', 'EVENT_NAME',  // Keep 'Event'
          'SOURCE_NAME', 'Source_name', 'Source', 'SOURCE', 'source'  // Keep 'source_name'
        ];
        // Only remove Grade variations if NOT explicitly requested
        if (!isGradeRequested) {
          metadataFieldsToRemove.push('GRADE', 'grade');  // Keep 'Grade' when not requested as channel
        }
        // Only remove Race_number/Leg_number variations if they're NOT explicitly requested
        if (!isRaceNumberRequested) {
          metadataFieldsToRemove.push('RACE', 'race_number', 'RACE_NUMBER', 'RaceNumber', 'raceNumber');
        }
        if (!isLegNumberRequested) {
          metadataFieldsToRemove.push('LEG', 'leg_number', 'LEG_NUMBER', 'LegNumber', 'legNumber');
        }
        
        metadataFieldsToRemove.forEach(field => {
          if (field in point) {
            delete point[field];
          }
        });
        
        // Add normalized metadata fields (using standard names: Grade, State, Race_number, Leg_number)
        // Filter out undefined/null values before assigning to avoid adding empty fields
        const definedMetadata = Object.fromEntries(
          Object.entries(normalizedMetadata).filter(([_, value]) => value !== undefined && value !== null)
        );
        Object.assign(point, definedMetadata);
        
        // Restore Race_number, Leg_number, and Grade if they were explicitly requested (use standard names)
        if (isRaceNumberRequested && preservedRaceNumber !== undefined) {
          point.Race_number = preservedRaceNumber;
        }
        if (isLegNumberRequested && preservedLegNumber !== undefined) {
          point.Leg_number = preservedLegNumber;
        }
        if (isGradeRequested && preservedGrade !== undefined) {
          point.Grade = preservedGrade;
        }
        
        // Restore description field - critical for mapdata queries
        if (preservedDescription !== undefined) {
          point.description = preservedDescription;
        }
      });
      
      // Extract actual channels from the data (not just the requested ones)
      const actualChannels = await extractChannelsFromDataAsync(filteredData);
      const validChannels = await extractValidChannelsFromDataAsync(filteredData);
      
      // CRITICAL: Map extracted channels back to original case from requested channels
      // Data keys may have different case than requested channels, so we need to map them
      let mappedValidChannels = validChannels;
      if (channels && channels.length > 0) {
        // Build mapping: lowercase data key -> original case requested channel
        const channelCaseMap = new Map<string, string>();
        channels.forEach(reqCh => {
          channelCaseMap.set(reqCh.toLowerCase(), reqCh);
        });
        
        // Map valid channels to original case from requested channels
        mappedValidChannels = validChannels.map(dataCh => {
          const dataChLower = dataCh.toLowerCase();
          // If this data channel matches a requested channel, use original case
          if (channelCaseMap.has(dataChLower)) {
            return channelCaseMap.get(dataChLower)!;
          }
          // Channel in data but not requested - preserve its case from data
          return dataCh;
        });
      }
      
      // CRITICAL: Use explicitly requested channels if provided, otherwise use mapped valid channels from data
      // This ensures that channels like Tws_kph that might be undefined in current data
      // but are explicitly requested will still be stored (so they can be populated later)
      // If channels are explicitly provided, use ONLY those channels (they're what the user requested in original case)
      // Otherwise, use mapped valid channels extracted from the data (preserving original case)
      // CRITICAL: When channels are explicitly provided, we should NOT add extra channels from data
      // because those channels might have different case than what was requested
      let channelsToStore: string[];
      if (channels && channels.length > 0) {
        // Use ONLY explicitly requested channels - these are in original case from chart objects
        // Don't add channels from data that weren't requested, as they might have wrong case
        channelsToStore = channels;
        debug(`[storeDataInIndexedDB] Using ${channels.length} explicitly requested channels (original case):`, channels.slice(0, 10));
      } else {
        // No channels explicitly provided - use mapped valid channels from data
        channelsToStore = mappedValidChannels;
        debug(`[storeDataInIndexedDB] No explicit channels provided, using ${mappedValidChannels.length} channels extracted from data:`, mappedValidChannels.slice(0, 10));
      }
      
      // CRITICAL: Deduplicate channels by case-insensitive comparison
      // ALWAYS prefer original case from requested channels - never use lowercase from data
      // Build a map: lowercase -> original case (ALWAYS prefer requested channels' case)
      const channelDedupMap = new Map<string, string>();
      channelsToStore.forEach(ch => {
        if (!ch || typeof ch !== 'string') return;
        const chLower = ch.toLowerCase();
        // If we already have this channel (case-insensitive), ALWAYS prefer the requested channel's case
        if (channelDedupMap.has(chLower)) {
          const existing = channelDedupMap.get(chLower)!;
          // CRITICAL: If channels parameter was provided, those are the requested channels in original case
          // ALWAYS prefer channels from the channels parameter over any extracted from data
          const existingMatchesRequested = channels && channels.length > 0 && channels.includes(existing);
          const currentMatchesRequested = channels && channels.length > 0 && channels.includes(ch);
          
          if (currentMatchesRequested && !existingMatchesRequested) {
            // Current matches requested, existing doesn't - prefer current
            channelDedupMap.set(chLower, ch);
          } else if (!currentMatchesRequested && existingMatchesRequested) {
            // Existing matches requested, current doesn't - keep existing
            // Don't change channelDedupMap
          } else if (currentMatchesRequested && existingMatchesRequested) {
            // Both match requested - prefer the one that exactly matches a requested channel (original case)
            const requestedExactMatch = channels!.find(reqCh => reqCh === ch || reqCh === existing);
            if (requestedExactMatch) {
              channelDedupMap.set(chLower, requestedExactMatch);
            } else {
              // Both match but neither is exact - prefer the one with more capital letters (likely original case)
              const existingCaps = (existing.match(/[A-Z]/g) || []).length;
              const currentCaps = (ch.match(/[A-Z]/g) || []).length;
              if (currentCaps > existingCaps) {
                channelDedupMap.set(chLower, ch);
              }
            }
          } else {
            // Neither matches requested - prefer the one with more capital letters (likely original case)
            const existingCaps = (existing.match(/[A-Z]/g) || []).length;
            const currentCaps = (ch.match(/[A-Z]/g) || []).length;
            if (currentCaps > existingCaps) {
              channelDedupMap.set(chLower, ch);
            }
            // Otherwise keep existing
          }
        } else {
          channelDedupMap.set(chLower, ch);
        }
      });
      
      // Convert back to array, deduplicated by case-insensitive comparison
      channelsToStore = Array.from(channelDedupMap.values());

      // For timeseries, exclude metadata channels so we do not create ts.Grade, ts.State, etc.; metadata lives only in tags
      if (dataSource === 'timeseries') {
        const metadataLower = new Set(TIMESERIES_METADATA_CHANNELS_FALLBACK.map(ch => ch.toLowerCase()));
        channelsToStore = channelsToStore.filter(ch => !metadataLower.has(ch.toLowerCase()));
      }
      
      // CRITICAL: Log the final channels to verify original case is preserved
      if (channels && channels.length > 0) {
        const _channelsLower = new Set(channels.map(ch => ch.toLowerCase()));
        const storedLower = new Set(channelsToStore.map(ch => ch.toLowerCase()));
        const caseMismatches = channels.filter(reqCh => {
          const reqChLower = reqCh.toLowerCase();
          if (!storedLower.has(reqChLower)) return false; // Not stored at all
          const storedCh = channelsToStore.find(sCh => sCh.toLowerCase() === reqChLower);
          return storedCh && storedCh !== reqCh; // Stored but with different case
        });
        
        if (caseMismatches.length > 0) {
          warn(`[storeDataInIndexedDB] ⚠️ CASE MISMATCH: Some requested channels are being stored with different case:`, {
            caseMismatches: caseMismatches.map(reqCh => {
              const storedCh = channelsToStore.find(sCh => sCh.toLowerCase() === reqCh.toLowerCase());
              return `${reqCh} (requested) vs ${storedCh} (stored)`;
            }),
            requestedChannels: channels.slice(0, 10),
            storedChannels: channelsToStore.slice(0, 10),
            note: 'Channels should be stored in original case for InfluxDB/DuckDB compatibility'
          });
        } else {
          debug(`[storeDataInIndexedDB] ✅ All ${channels.length} requested channels preserved in original case`);
        }
      }
      
      // Log if we found duplicates (case-insensitive dedupe)
      if (channels && channels.length > 0 && channelsToStore.length < channels.length) {
        const originalLower = new Set(channels.map(ch => ch.toLowerCase()));
        const storedLower = new Set(channelsToStore.map(ch => ch.toLowerCase()));
        const removed = channels.filter(ch => !storedLower.has(ch.toLowerCase()));
        const metadataLowerForDedup = new Set(TIMESERIES_METADATA_CHANNELS_FALLBACK.map(ch => ch.toLowerCase()));
        metadataLowerForDedup.add('foiling_state');
        const removedAreOnlyMetadata = removed.length > 0 && removed.every((ch: string) => metadataLowerForDedup.has(ch.toLowerCase()));
        if (removed.length > 0) {
          if (dataSource === 'timeseries' && removedAreOnlyMetadata) {
            debug(`[storeDataInIndexedDB] Deduped ${removed.length} metadata channel(s) (case-insensitive); storing one per channel:`, removed);
          } else {
            warn(`[storeDataInIndexedDB] ⚠️ Removed ${removed.length} duplicate channels (case-insensitive):`, {
              removedChannels: removed,
              keptChannels: channelsToStore.filter(ch => originalLower.has(ch.toLowerCase())),
              note: 'Only storing one version per channel (preferring original case from requested channels)'
            });
          }
        }
      }
      
      // Debug: Log channel extraction for diagnosis
      if (channels && channels.length > 0) {
        const _requestedChannelsLower = new Set(channels.map((ch: string) => ch.toLowerCase()));
        const channelsToStoreLower = new Set(channelsToStore.map(ch => ch.toLowerCase()));
        const missingChannels = channels.filter((ch: string) => !channelsToStoreLower.has(ch.toLowerCase()));
        const metadataLower = new Set(TIMESERIES_METADATA_CHANNELS_FALLBACK.map(ch => ch.toLowerCase()));
        const missingAreOnlyMetadata = missingChannels.length > 0 && missingChannels.every((ch: string) => metadataLower.has(ch.toLowerCase()) || ch.toLowerCase() === 'foiling_state');

        if (missingChannels.length > 0) {
          if (dataSource === 'timeseries' && missingAreOnlyMetadata) {
            debug(`[storeDataInIndexedDB] Requested metadata channels (Grade, State, Twa_deg, Race_number, Leg_number, Foiling_state) are stored in tags, not as channel columns:`, missingChannels);
          } else {
            warn(`[storeDataInIndexedDB] ⚠️ Some requested channels will not be stored (not in data and not explicitly requested):`, {
              missingChannels: missingChannels,
              requestedChannels: channels,
              channelsToStore: channelsToStore.slice(0, 20),
              validChannels: validChannels.slice(0, 20),
              actualChannels: actualChannels.slice(0, 20),
              dataSource,
              dataPoints: filteredData.length
            });
          }
        }
      }
      
      // Convert channel names to channel metadata objects
      const channelMetadata = channelsToStore.map(channelName => ({
        name: channelName,
        type: channelName === 'Datetime' ? 'datetime' : 'float'
      }));
      
  
      if (channelsToStore.length === 0) {
        warn(`[UnifiedDataStore] No channels to store for ${dataSource}_${datasetId}_${projectId}_${sourceId}`, {
          requestedChannels: channels,
          validChannels: validChannels,
          actualChannels: actualChannels
        });
        return;
      }
      
      // Log missing channels if any
      // Filter out metadata channels and use case-insensitive comparison for metadata fields
      // Metadata channels are stored in tags, not as separate channels, so they shouldn't be reported as missing
      // CRITICAL: For timeseries data, Race_number and Leg_number can be actual data channels
      // Only treat them as metadata if they're NOT explicitly requested
      const requestedChannelsLower = new Set(channels.map((ch: string) => ch.toLowerCase()));
      
      const METADATA_CHANNELS = new Set([
        'Datetime', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename',
        'RACE', 'LEG',
        'Grade', 'grade', 'GRADE', 'Mainsail_code', 'mainsail_code',
        'TACK', 'tack', 'event_id',
        'Config', 'config', 'State', 'state', 'Event', 'event'
      ]);
      
      const isMetadataChannel = (ch: string): boolean => {
        if (!ch || typeof ch !== 'string') return true;
        const chLower = ch.toLowerCase().trim();
        if (chLower.length === 0) return true;
        
        // If Race_number, Leg_number, Grade, or State are explicitly requested, they are data channels, not metadata
        if (chLower === 'race_number' || chLower === 'leg_number' || chLower === 'grade' || chLower === 'state') {
          return !requestedChannelsLower.has(chLower);
        }
        
        return METADATA_CHANNELS.has(ch) || 
               METADATA_CHANNELS.has(chLower) ||
               chLower.endsWith('_code') ||
               (chLower.endsWith('_number') && !requestedChannelsLower.has(chLower)) ||
               chLower === 'grade' ||
               chLower === 'config' ||
               chLower === 'state' ||
               chLower === 'foiling_state' ||
               chLower === 'state';
      };
      
      // Create normalized channel sets for case-insensitive comparison
      const validChannelsLower = new Set(validChannels.map(ch => ch.toLowerCase()));
      const missingChannels = channels.filter(ch => {
        // Skip metadata channels - they're stored in tags, not as channels
        if (isMetadataChannel(ch)) return false;
        // Use case-insensitive comparison for channel matching
        return !validChannels.includes(ch) && !validChannelsLower.has(ch.toLowerCase());
      });
      
      if (missingChannels.length > 0) {
        debug(`[UnifiedDataStore] Missing channels for ${dataSource}_${datasetId}_${projectId}_${sourceId}:`, missingChannels);
      }
      
      // Map IndexedDBDataSource to HuniDB storage
      // Only store data with valid channels to prevent undefined values
      // Determine context from parent_name and object_name (user_objects), or fall back to chartType
      // Also get page_name and object_name from persistantStore for proper table naming
      let context: string | undefined = undefined;
      let pageName: string | undefined;
      let objectName: string | undefined;
      
      // Get page_name and object_name from persistantStore (these will be used for table naming)
      try {
        pageName = persistantStore.selectedMenu() || undefined;
        objectName = persistantStore.selectedPage() || undefined;
      } catch (e) {
        debug(`[UnifiedDataStore] Could not get page/object name from persistantStore:`, e);
      }
      
      if (dataSource === 'timeseries') {
        // Try to get parent_name and object_name from params
        const parentName = params?.parent_name || params?.parentName;
        const paramObjectName = params?.object_name || params?.objectName;
        
        // Use object_name from params if available, otherwise use selectedPage
        if (paramObjectName) {
          objectName = paramObjectName;
        }
        
        if (parentName && objectName) {
          // Construct context as parent_name_object_name
          context = `${parentName}_${objectName}`;
          debug(`[UnifiedDataStore] Using context from params: ${context}`, { parentName, objectName, pageName });
        } else if (params?.chartObjectId) {
          // If chartObjectId is provided, try to fetch parent_name and object_name from API
          try {
            const currentUser = user();
            if (currentUser?.user_id) {
              // chartObjectId format might be "parent_name/object_name" or just an ID
              // For now, if it contains '/', split it; otherwise try to fetch from API
              if (params.chartObjectId.includes('/')) {
                const [pn, on] = params.chartObjectId.split('/');
                context = `${pn}_${on}`;
                objectName = on;
                debug(`[UnifiedDataStore] Parsed context from chartObjectId: ${context}`);
              } else {
                // Try to fetch from user_objects API
                // Note: This requires knowing parent_name, which might not be available
                // For now, log a warning and fall back to default
                warn(`[UnifiedDataStore] chartObjectId provided but cannot determine parent_name/object_name, falling back to default context`);
                context = params?.chartType || params?.context || 'timeseries';
              }
            } else {
              debug(`[UnifiedDataStore] User not available, cannot fetch user_objects, using default context`);
              context = params?.chartType || params?.context || 'timeseries';
            }
          } catch (error) {
            warn(`[UnifiedDataStore] Error fetching user_objects for chartObjectId, using default context:`, error);
            context = params?.chartType || params?.context || 'timeseries';
          }
        } else {
          // Fall back to chartType or default
          context = params?.chartType || params?.context || 'timeseries_default';
        }
      }
      
      if (dataSource === 'mapdata') {
        // Store in background (non-blocking) - defer to avoid blocking UI thread
        // Similar to timeseries pattern, but mapdata uses storeDataByChannels
        info(`[UnifiedDataStore] Storing mapdata: ${filteredData.length} points, ${channelsToStore.length} channels for ${normalizedClassName}/${datasetId}/${projectId}/${sourceId}`);
        setTimeout(() => {
          huniDBStore.storeDataByChannels('mapdata', normalizedClassName, datasetId, projectId, sourceId, filteredData, channelMetadata)
            .then(() => {
              info(`[UnifiedDataStore] Successfully stored mapdata: ${filteredData.length} points`);
            })
            .catch(err => {
              warn('[UnifiedDataStore] Error storing mapdata in HuniDB (non-blocking):', err);
            });
        }, 0);
      } else if (dataSource === 'timeseries') {
        // Timeseries: API + in-memory cache only; no HuniDB persistence.
      } else if (dataSource === 'aggregates') {
        // CRITICAL: When storing aggregates through unifiedDataStore, ensure agrType is preserved
        // Aggregates storage removed - agg.aggregates table no longer used
        debug(`[UnifiedDataStore] Skipping aggregates storage (deprecated) - ${filteredData.length} aggregates`);
      } else if (dataSource === 'objects') {
        // For objects, store as simple object
        await huniDBStore.storeObject(normalizedClassName, `${datasetId}_${projectId}_${sourceId}`, filteredData);
      }

      // Update global filter options (races/legs/grades) from newly stored data
      // Defer to background to avoid blocking data processing pipeline
      if (dataSource === 'timeseries' || dataSource === 'mapdata') {
        // Determine the current filter context based on selected state
        const filterContext = determineFilterContext();
        debug('🔍 UnifiedDataStore: Scheduling extractFilterOptions with', filteredData.length, 'points for', dataSource, className, sourceId, 'context:', filterContext);
        // Run in background - don't block data processing
        setTimeout(() => {
          extractFilterOptions(filteredData, filterContext)
            .then(() => {
              debug('🔍 UnifiedDataStore: extractFilterOptions completed successfully');
            })
            .catch((e) => {
              debug('🔍 UnifiedDataStore: extractFilterOptions failed:', (e as Error)?.message);
            });
        }, 0);
      } else {
        debug('🔍 UnifiedDataStore: Skipping extractFilterOptions for dataSource:', dataSource);
      }
      
      // Update channel availability with valid channels found in data
      const key = createDataKey(String(datasetId), String(projectId), String(sourceId), dataSource);
      const existing = channelAvailability.get(key);
      channelAvailability.set(key, {
        className,
        sourceId: String(sourceId),
        availableChannels: validChannels, // Only track channels with valid data
        missingChannels: existing?.missingChannels || [],
        lastChecked: Date.now()
      });
      
      debug(`[UnifiedDataStore] Stored ${data.length} points with ${validChannels.length} valid channels for ${dataSource}_${datasetId}_${projectId}_${sourceId}`);
      
      // Clear density optimized cache when data is updated
      await clearDensityOptimizedCache(className, String(datasetId), String(projectId), String(sourceId));
      
    } catch (error) {
      logError(`[UnifiedDataStore] Error storing data in IndexedDB:`, error);
      throw error;
    }
  };

  // Helper: structured data source logging for component-level visibility
  const logDataSource = (
    scope: string,
    source: 'memory' | 'indexeddb' | 'api' | 'redis' | 'hunidb',
    details: Record<string, any> = {}
  ) => {
    info(`[UnifiedDataSource] ${scope} -> ${source.toUpperCase()}`, details);
  };

  // Get data from HuniDB cache
  const getDataFromIndexedDB = async (
    dataSource: IndexedDBDataSource,
    className: string,
    sourceId: string
  ): Promise<any[]> => {
    try {
      // Timeseries/mapdata/aggregates no longer cached in HuniDB - return empty unless objects
      if (dataSource !== 'objects') {
        return [];
      }
      // Convert className to lowercase for consistent retrieval
      const normalizedClassName = className.toLowerCase();
      
      // Map data source type to HuniDB queries
      if (dataSource === 'objects') {
        // Get object data
        const objectData = await huniDBStore.getObject(normalizedClassName, `${normalizedClassName}_${sourceId}`);
        if (objectData) {
          logDataSource('getDataFromIndexedDB', 'hunidb', {
            dataSource,
            className: normalizedClassName,
            sourceId,
            kind: 'object'
          });
          return [objectData];
        }
        return [];
      } else {
        // Get data using HuniDB query system
        const dataTypes = dataSource === 'mapdata' ? ['mapdata'] : 
                         dataSource === 'timeseries' ? ['timeseries'] : 
                         dataSource === 'aggregates' ? ['aggregates'] : [];
        
        // Get datasetId and projectId from persistantStore (getDataFromIndexEDB has no params)
        // In live mode, always use dataset_id = 0 for queries
        const isLive = liveMode();
        const datasetId = isLive ? 0 : Number(persistantStore.selectedDatasetId() || 0);
        const projectId = Number(persistantStore.selectedProjectId?.() || 0);
        const normalizedSourceId = Number(sourceId || 0);
        
        // Get all available channels for this source
        const availableChannels = await huniDBStore.getAvailableChannels(
          normalizedClassName, 
          datasetId,
          projectId,
          normalizedSourceId, 
          dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[]
        );
        
        // If no channels available, don't return early - let fetchDataWithChannelChecking handle API fetch
        // This allows the system to automatically fetch data when it's missing
        if (availableChannels.length === 0) {
        debug(`[UnifiedDataStore] No available channels found for ${dataSource}_${className}_${normalizedSourceId} - will trigger API fetch`);
          // Return empty array to let fetchDataWithChannelChecking handle fetching
          return [];
        }
        
        debug(`[UnifiedDataStore] Found ${availableChannels.length} channels for ${dataSource}_${className}_${normalizedSourceId}:`, availableChannels);
        
        // Query for all available channels (pass empty array to get all channels)
        const dataPoints = await huniDBStore.queryDataByChannels(
          normalizedClassName, 
          datasetId,
          projectId,
          normalizedSourceId, 
          [], // Empty array means get all channels
          dataTypes as any
        );

        if (dataPoints && dataPoints.length > 0) {
          logDataSource('getDataFromIndexedDB', 'hunidb', {
            dataSource,
            className: normalizedClassName,
            sourceId,
            rowCount: dataPoints.length,
            channelCount: availableChannels.length
          });
        }
        
        return dataPoints;
      }
    } catch (error) {
      warn(`[UnifiedDataStore] Error getting data from HuniDB for ${dataSource}_${className}_${sourceId}:`, error);
      return [];
    }
  };


  // Helper function to check if a channel is a metadata channel (case-insensitive).
  // These are often tag-derived and may be missing from API response; don't block returning cache.
  const isMetadataChannelForCache = (ch: string): boolean => {
    if (!ch || typeof ch !== 'string') return true;
    const chLower = ch.toLowerCase().trim();
    const metadataChannels = ['datetime', 'timestamp', 'source_id', 'source_name', 'sourcename', 'config', 'state', 'foiling_state'];
    return metadataChannels.includes(chLower) || 
           chLower.endsWith('_code') || 
           chLower.endsWith('_number') ||
           chLower === 'grade' ||
           chLower === 'race_number' ||
           chLower === 'leg_number';
  };

  /**
   * Channels not critical for chart rendering - do not fail merge validation if missing.
   * Grade, State, Race_number, Leg_number, Twa_deg and Foiling_state are stored in HuniDB tags for each ts table record;
   * they are not required as row keys for validation - tags supply them when data is from HuniDB.
   */
  const NON_CRITICAL_CHANNELS_LOWER = new Set<string>([
    'state', 'config', 'race_number', 'leg_number', 'grade',
    'twa_deg', 'foiling_state'
  ]);

  /**
   * Returns list of critical-for-rendering channels that are missing from the data.
   * Critical: Datetime/timestamp (at least one) and chart data channels (x/y/color etc.).
   * Grade, State, Race_number, Leg_number, Twa_deg, Foiling_state are non-critical (in HuniDB tags).
   */
  const getMissingCriticalChannelsForRendering = (
    requiredChannels: string[],
    availableChannelsLower: Set<string>
  ): string[] => {
    const criticalNames: string[] = [];
    requiredChannels.forEach(ch => {
      if (!NON_CRITICAL_CHANNELS_LOWER.has(ch.toLowerCase())) {
        criticalNames.push(ch);
      }
    });
    const seenLower = new Set<string>();
    const deduped = criticalNames.filter(ch => {
      const l = ch.toLowerCase();
      if (seenLower.has(l)) return false;
      seenLower.add(l);
      return true;
    });
    const hasTime = availableChannelsLower.has('datetime') || availableChannelsLower.has('timestamp');
    let timeChecked = false;
    const missing: string[] = [];
    for (const ch of deduped) {
      const chLower = ch.toLowerCase();
      if (chLower === 'datetime' || chLower === 'timestamp') {
        if (!timeChecked && !hasTime) {
          missing.push('Datetime');
          timeChecked = true;
        }
        continue;
      }
      if (!availableChannelsLower.has(chLower)) {
        missing.push(ch);
      }
    }
    return missing;
  };

  /**
   * Fetch data with channel validation against DATABASE/AGGREGATE CHANNELS
   * 
   * USE THIS FOR:
   * - Performance components that work with AGGREGATE DATABASE TABLES
   * - Components querying events_aggregate or similar pre-aggregated data
   * - Validates channels against /api/data/channels (database schema)
   * 
   * USE fetchDataWithChannelCheckingFromFile() FOR:
   * - Explore components that work with RAW FILE DATA
   * - See fetchDataWithChannelCheckingFromFile documentation for details
   */
  const fetchDataWithChannelChecking = async (
    chartType: ChartType,
    className: string,
    sourceId: string,
    requiredChannels: string[],
    params?: any,
    dataSource?: IndexedDBDataSource
  ): Promise<any[]> => {
    // CRITICAL: Log channels at entry point to verify they're in original case
    debug(`[fetchDataWithChannelChecking] 🔍 ENTRY POINT - requiredChannels:`, {
      requiredChannels: requiredChannels,
      channelsCount: requiredChannels.length,
      sampleChannels: requiredChannels.slice(0, 10),
      caseCheck: requiredChannels.slice(0, 10).map(ch => ({
        channel: ch,
        hasUpperCase: /[A-Z]/.test(ch),
        isLowercase: ch === ch.toLowerCase()
      })),
      note: 'These channels should be in original case. If lowercase here, they were lowercase when passed from fetchDataWithChannelCheckingFromFile.'
    });
    
    // Extract datasetId and projectId from params or persistantStore
    // These are required for the new per-class, per-dataset architecture
    const datasetId = Number(params?.datasetId || params?.dataset_id || persistantStore.selectedDatasetId() || 0);
    const projectId = Number(params?.projectId || params?.project_id || persistantStore.selectedProjectId?.() || 0);
    const normalizedSourceId = Number(sourceId || 0);
    
    // Declare sourceName and date at function scope so they're accessible throughout
    let sourceName = params?.sourceName || params?.source_name;
    let date = params?.date;
    
    const resolvedDataSource = dataSource || getDataSourceForChart(chartType);
    
    // Debug: Log resolved data source to help diagnose endpoint selection
    debug(`[fetchDataWithChannelChecking] Resolved data source:`, {
      chartType,
      providedDataSource: dataSource,
      resolvedDataSource,
      expectedForChartType: getDataSourceForChart(chartType)
    });
    
    // Check if cached data is stale by comparing date_modified
    let _shouldInvalidateCache = false;
    if (datasetId != null && String(datasetId) !== '0') {
      try {
        const datasetInfoResponse = await fetchData(`/api/datasets/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`);
        if (datasetInfoResponse?.success && datasetInfoResponse?.data?.date_modified) {
          const serverDateModified = new Date(datasetInfoResponse.data.date_modified).getTime();
          
          // Check if we have cached date_modified in meta.datasets
          const cachedMetadata = await huniDBStore.getCachedDatasets(className);
          const datasetMetadata = cachedMetadata.find(d => String(d.dataset_id) === String(datasetId));
          
          if (datasetMetadata?.dateModified || datasetMetadata?.date_modified) {
            const cachedDateModified = datasetMetadata.dateModified || datasetMetadata.date_modified || 0;
            if (serverDateModified > cachedDateModified) {
              info(`[UnifiedDataStore] Dataset ${datasetId} was modified on server (${new Date(serverDateModified).toISOString()}) after cache (${new Date(cachedDateModified).toISOString()}) - invalidating cache`);
              _shouldInvalidateCache = true;
              await clearDatasetCache(className, String(datasetId));
            } else {
              // Update cached date_modified to match server (in case it was missing before)
              try {
                const db = await storage.getDatabase(className);
                await db.exec(
                  `UPDATE "meta.datasets" SET date_modified = ? WHERE dataset_id = ?`,
                  [serverDateModified, datasetId]
                );
              } catch (e: any) {
                // Handle mobile device error gracefully
                if (e?.message?.includes('mobile devices')) {
                  debug(`[UnifiedDataStore] Skipping date_modified update on mobile device`);
                } else {
                  debug(`[UnifiedDataStore] Could not update cached date_modified:`, e);
                }
              }
            }
          } else {
            // No cached date_modified - store it for future checks
            try {
              const db = await storage.getDatabase(className);
              await db.exec(
                `UPDATE "meta.datasets" SET date_modified = ? WHERE dataset_id = ?`,
                [serverDateModified, datasetId]
              );
              debug(`[UnifiedDataStore] Stored date_modified for dataset ${datasetId} for future cache checks`);
            } catch (e: any) {
              // Handle mobile device error gracefully
              if (e?.message?.includes('mobile devices')) {
                debug(`[UnifiedDataStore] Skipping date_modified storage on mobile device`);
              } else {
                debug(`[UnifiedDataStore] Could not store date_modified:`, e);
              }
            }
          }
        } else if (datasetInfoResponse?.success === false || !datasetInfoResponse?.data) {
          // Dataset doesn't exist on server - clear cache
          info(`[UnifiedDataStore] Dataset ${datasetId} not found on server - clearing cache`);
          _shouldInvalidateCache = true;
          await clearDatasetCache(className, String(datasetId));
        }
      } catch (e) {
        warn(`[UnifiedDataStore] Could not check date_modified for dataset ${datasetId}:`, e);
      }
    }
    
    // Step 1: Check unifiedDataStore first (in-memory, instant)
    // Include objectName/page so different scatter pages ('takeoffs' vs 'tws bsp') never share cache
    const channelsHash = hashChannelsForCache(requiredChannels);
    const objectNamePart = normalizeObjectNameForCache(params?.objectName ?? params?.object_name ?? params?.page);
    const cacheKey = `${chartType}_${className}_${sourceId}_${datasetId}_${projectId}${objectNamePart ? `_${objectNamePart}` : ''}_${channelsHash}`;
    const cachedEntry = dataCache.get(cacheKey);
    if (cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
      // Verify cache has all requested channels using actual data keys (source of truth)
      const dataKeys = cachedEntry.data[0] ? Object.keys(cachedEntry.data[0]).map(k => k.toLowerCase()) : [];
      const hasAllChannels = requiredChannels.every(ch => {
        if (isMetadataChannelForCache(ch)) return true;
        return dataKeys.includes(ch.toLowerCase());
      });
      
      if (hasAllChannels) {
        logDataSource('fetchDataWithChannelChecking', 'memory', {
          chartType,
          className,
          sourceId,
          datasetId,
          projectId,
          resolvedDataSource,
          rowCount: cachedEntry.data.length,
          dataKeysCount: dataKeys.length
        });
        debug(`[fetchDataWithChannelChecking] Using in-memory cache (has all ${requiredChannels.length} requested channels)`);
        return cachedEntry.data;
      } else {
        debug(`[fetchDataWithChannelChecking] In-memory cache exists but missing some requested channels - will fetch missing ones`);
      }
    }
    
    // Ensure sources are initialized before fetching data (critical for correct source information)
    if (sourceId && sourceId !== '0') {
      if (!sourcesStore.isReady()) {
        info(`[fetchDataWithChannelChecking] Waiting for sources to initialize before fetching data...`);
        // Wait for sources to be ready (with timeout)
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds max wait
        while (!sourcesStore.isReady() && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
        if (sourcesStore.isReady()) {
          info(`[fetchDataWithChannelChecking] Sources initialized, proceeding with data fetch`);
        } else {
          warn(`[fetchDataWithChannelChecking] Sources not ready after waiting, proceeding anyway`);
        }
      }
    }
    
    try {
      // If global filters are applied, ensure we also request the channels required by the filter config
      // Overlay (e.g. FleetDataTable) only needs the exact channels requested — no filter/metadata merge
      const applyGlobalFilters: boolean = params?.applyGlobalFilters !== false && chartType !== 'overlay';
      let channelsToEnsure: string[] = [...requiredChannels];
      if (applyGlobalFilters) {
        try {
          // Determine context for filter channels (dataset, day, fleet, source)
          const filterContext = determineFilterContext();
          const filterChannels = await UnifiedFilterService.getRequiredFilterChannels(className, filterContext);
          // Merge unique
          const filterSet = new Set<string>(channelsToEnsure);
          for (const ch of filterChannels) filterSet.add(ch);
          // In fleet/multisource mode include source_name so API returns it for filtering by source
          if (filterContext === 'fleet' || filterContext === 'day') {
            filterSet.add('source_name');
          }
          channelsToEnsure = Array.from(filterSet);
        } catch (e) {
          debug('[fetchDataWithChannelChecking] Skipping filter channel merge:', (e as Error)?.message);
        }
      }

      // For timeseries, include filter/metadata channels from class object (filters_dataset) so API returns them
      // Skip for overlay — FleetDataTable only needs Datetime + configured channels (e.g. 2), not Config/State/etc.
      if (resolvedDataSource === 'timeseries' && chartType !== 'overlay') {
        let metadataChannels: string[];
        try {
          metadataChannels = await UnifiedFilterService.getRequiredFilterChannels(className, 'dataset');
          if (!metadataChannels?.length) metadataChannels = [...TIMESERIES_METADATA_CHANNELS_FALLBACK];
        } catch {
          metadataChannels = [...TIMESERIES_METADATA_CHANNELS_FALLBACK];
        }
        const lowerToOriginal = new Map<string, string>();
        for (const ch of channelsToEnsure) lowerToOriginal.set(ch.toLowerCase(), ch);
        for (const ch of metadataChannels) {
          if (!lowerToOriginal.has(ch.toLowerCase())) lowerToOriginal.set(ch.toLowerCase(), ch);
        }
        channelsToEnsure = Array.from(lowerToOriginal.values());
      }
      
      const dataTypes = resolvedDataSource === 'objects' ? ['timeseries'] : [resolvedDataSource];
      // Step 2 (shared): Filter out metadata channels from requested channels
      const requestedChannelsLower = new Set(channelsToEnsure.map((ch: string) => ch.toLowerCase()));
      const METADATA_CHANNELS = new Set([
        'Datetime', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename',
        'Grade', 'grade', 'Mainsail_code', 'mainsail_code',
        'TACK', 'tack', 'event_id',
        'Config', 'config', 'State', 'state'
      ]);
      const isMetadataChannel = (ch: string): boolean => {
        if (!ch || typeof ch !== 'string') return true;
        const chLower = ch.toLowerCase().trim();
        if (chLower.length === 0) return true;
        if (chLower === 'race_number' || chLower === 'leg_number' || chLower === 'grade' || chLower === 'state') {
          return !requestedChannelsLower.has(chLower);
        }
        return METADATA_CHANNELS.has(ch) || METADATA_CHANNELS.has(chLower) ||
          chLower.endsWith('_code') || (chLower.endsWith('_number') && !requestedChannelsLower.has(chLower)) ||
          chLower === 'config' || chLower === 'state' || chLower === 'foiling_state';
      };
      const validRequestedChannels = Array.from(new Set(channelsToEnsure.filter(ch => !isMetadataChannel(ch))));

      let normalizedRequestedChannels: string[];
      let validRequestedChannelsLower: string[];
      let missingChannels: string[];
      let hasNoDataAtAll: boolean;
      let hasDataRows: boolean;
      let hasCompleteData: boolean;
      let availableChannels: string[];

      if (resolvedDataSource === 'timeseries') {
        // Timeseries: API + in-memory only. Skip all HuniDB channel checks; use requested channels as-is.
        availableChannels = [];
        normalizedRequestedChannels = validRequestedChannels;
        validRequestedChannelsLower = Array.from(new Set(validRequestedChannels.map(ch => ch.toLowerCase())));
        missingChannels = [...validRequestedChannels];
        hasNoDataAtAll = true;
        hasDataRows = false;
        hasCompleteData = false;
      } else {
      // Step 1: Check what channels are available in HuniDB (mapdata/aggregates only)
      info(`[fetchDataWithChannelChecking] Checking available channels for ${chartType}`, {
        className,
        datasetId,
        projectId,
        sourceId,
        resolvedDataSource,
        dataTypes: dataTypes.join(','),
        requestedChannels: channelsToEnsure.slice(0, 5)
      });
      debug(`[fetchDataWithChannelChecking] 🔍 Querying HuniDB with IDs:`, {
        className: className.toLowerCase(),
        datasetId,
        projectId,
        sourceId: normalizedSourceId,
        sourceIdType: typeof normalizedSourceId,
        dataTypes: dataTypes.join(','),
        note: 'If channels exist in HuniDB but aren\'t found, check if they were stored with different IDs (datasetId/projectId/sourceId mismatch)'
      });
      availableChannels = [];
      info(`[fetchDataWithChannelChecking] Available channels found: ${availableChannels.length}`, {
        queryParams: { className: className.toLowerCase(), datasetId, projectId, sourceId: normalizedSourceId, sourceIdType: typeof normalizedSourceId, dataTypes: dataTypes.join(',') },
        availableChannels: availableChannels.slice(0, 10),
        requestedChannels: channelsToEnsure.slice(0, 10)
      });
      if (availableChannels.length === 0 && channelsToEnsure.length > 0) {
        debug(`[fetchDataWithChannelChecking] No channels in HuniDB for dataset ${datasetId}/project ${projectId}/source ${normalizedSourceId} - will fetch from API`, {
          queryParams: { className: className.toLowerCase(), datasetId, projectId, sourceId: normalizedSourceId },
          requestedChannels: channelsToEnsure.slice(0, 10),
          note: 'This will trigger API fetch.'
        });
      }
      const availableChannelsMap = new Map<string, string>();
      availableChannels.forEach(ch => availableChannelsMap.set(ch.toLowerCase(), ch));
      normalizedRequestedChannels = validRequestedChannels.map(ch => availableChannelsMap.get(ch.toLowerCase()) || ch);
      const normalizedChannelsLog = validRequestedChannels.filter((ch, i) => ch !== normalizedRequestedChannels[i]);
      if (normalizedChannelsLog.length > 0) {
        debug(`[fetchDataWithChannelChecking] Normalized ${normalizedChannelsLog.length} channel names to original case from HuniDB:`,
          normalizedChannelsLog.map((ch) => { const origIdx = validRequestedChannels.indexOf(ch); return `${ch} → ${normalizedRequestedChannels[origIdx]}`; })
        );
      }
      validRequestedChannelsLower = Array.from(new Set(normalizedRequestedChannels.map(ch => ch.toLowerCase())));
      hasNoDataAtAll = availableChannels.length === 0;
      
      // CRITICAL: Log why we're fetching from API if channels should be in HuniDB
      if (hasNoDataAtAll && channelsToEnsure.length > 0) {
        debug(`[fetchDataWithChannelChecking] Fetching from API: no channels in HuniDB for dataset ${datasetId}/project ${projectId}/source ${normalizedSourceId}`, {
          queriedIds: {
            className: className.toLowerCase(),
            datasetId,
            projectId,
            sourceId: normalizedSourceId
          },
          requestedChannels: channelsToEnsure.slice(0, 10),
          availableChannelsCount: availableChannels.length,
          possibleReasons: [
            '1. Data was stored with different IDs (datasetId/projectId/sourceId mismatch)',
            '2. meta.channels table is not populated (check diagnostic logs above)',
            '3. Data was never stored in HuniDB (first time loading)',
            '4. Data was stored in a different class database'
          ],
          note: 'Check diagnostic logs from HuniDBStore.getAvailableChannels to see if data exists with different IDs'
        });
      }
      
      // CRITICAL: Check if actual data rows exist with ALL requested channels
      // This handles the case where channels are registered but no data has been loaded yet
      // OPTIMIZATION: Query with all requested channels to verify complete data exists
      hasDataRows = true; // Assume true by default
      hasCompleteData = false; // Track if we have all requested channels with data
      if (!hasNoDataAtAll && availableChannels.length > 0 && validRequestedChannels.length > 0) {
        try {
          // Check if we have ALL requested channels available (case-insensitive comparison)
          const availableChannelsLower = new Set(availableChannels.map(ch => ch.toLowerCase()));
          const _validRequestedChannelsLowerSet = new Set(validRequestedChannels.map(ch => ch.toLowerCase()));
          const allChannelsAvailable = validRequestedChannels.every(ch => availableChannelsLower.has(ch.toLowerCase()));
          
          if (allChannelsAvailable) {
            // All channels are available - check if data actually exists
            // Use a small sample of requested channels to verify data exists (faster than checking all)
            // Use normalized original case channels - queryDataByChannels handles case-insensitive lookup
            const channelsToCheck = normalizedRequestedChannels.slice(0, Math.min(3, normalizedRequestedChannels.length));
            try {
              const testQuery = await huniDBStore.queryDataByChannels(
                className.toLowerCase(),
                Number(datasetId),
                Number(projectId),
                Number(normalizedSourceId),
                channelsToCheck,
                dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
                undefined,
                undefined
              );
              hasDataRows = testQuery && testQuery.length > 0;
              
              // CRITICAL: Check if any channels have all null values - if so, treat as missing
              const channelsWithAllNulls: string[] = [];
              if (hasDataRows && testQuery.length > 0) {
                for (const channel of channelsToCheck) {
                  const channelLower = channel.toLowerCase();
                  // Find the actual channel name in the data (case-insensitive)
                  const actualChannelName = testQuery[0] ? Object.keys(testQuery[0]).find(k => 
                    k.toLowerCase() === channelLower && 
                    !['timestamp', 'Datetime', 'datetime', 'source_id', 'source_name'].includes(k)
                  ) : null;
                  
                  if (actualChannelName) {
                    // Check if all values for this channel are null/undefined
                    const allNull = testQuery.every(row => {
                      const value = row[actualChannelName];
                      return value === null || value === undefined || (typeof value === 'number' && isNaN(value));
                    });
                    if (allNull) {
                      channelsWithAllNulls.push(channel);
                    }
                  }
                }
              }
              
              // If any channels have all null values, data is incomplete
              if (channelsWithAllNulls.length > 0) {
                debug(`[fetchDataWithChannelChecking] ${channelsWithAllNulls.length} channels with all null values in test query - treating as missing`, {
                  channelsWithAllNulls: channelsWithAllNulls.slice(0, 10),
                  testQueryRowCount: testQuery?.length || 0,
                  note: 'These channels exist in HuniDB tables but have no valid data. Will fetch from API.'
                });
                hasDataRows = false; // Treat as if no data exists
                hasCompleteData = false;
                // Mark these channels as missing so they get fetched
                // We'll add them to missingChannels below
              } else {
                hasCompleteData = hasDataRows && allChannelsAvailable;
              }
              
              debug(`[fetchDataWithChannelChecking] Data completeness check: ${hasCompleteData ? 'complete data exists' : hasDataRows ? 'partial data exists' : 'no data found'}`, {
                allChannelsAvailable,
                hasDataRows,
                hasCompleteData,
                channelsChecked: channelsToCheck.length,
                rowsFound: testQuery?.length || 0,
                channelsWithAllNulls: channelsWithAllNulls.length > 0 ? channelsWithAllNulls.slice(0, 5) : 'none'
              });
            } catch (queryError: unknown) {
              // Handle mobile device error or other query errors
              if ((queryError as Error)?.message?.includes('mobile devices')) {
                debug(`[fetchDataWithChannelChecking] HuniDB not available on mobile - will use API fallback`);
                hasDataRows = false;
                hasCompleteData = false;
              } else {
                throw queryError; // Re-throw other errors
              }
            }
          } else {
            // Not all channels available - data is incomplete
            hasDataRows = false;
            hasCompleteData = false;
            debug(`[fetchDataWithChannelChecking] Incomplete data: ${validRequestedChannels.length - availableChannels.length} channels missing`);
          }
        } catch (e) {
          debug(`[fetchDataWithChannelChecking] Could not check for data rows:`, e);
          hasDataRows = true; // Assume data exists if we can't check
          hasCompleteData = false; // But don't assume it's complete
        }
      } else if (hasNoDataAtAll) {
        hasDataRows = false;
        hasCompleteData = false;
      }
      }
      
      // DEBUG: Log channel availability state (use debug level to reduce console noise)
      debug(`[fetchDataWithChannelChecking] 🔍 Channel availability check:`, {
        availableChannelsCount: availableChannels.length,
        hasNoDataAtAll,
        hasDataRows,
        validRequestedChannelsCount: validRequestedChannels.length,
        channelsToEnsureCount: channelsToEnsure.length,
        availableChannels: availableChannels.slice(0, 5),
        validRequestedChannels: validRequestedChannels.slice(0, 5),
        channelsToEnsure: channelsToEnsure.slice(0, 5)
      });
      
      // OPTIMIZATION: If we have complete data, skip API fetch entirely
      if (hasCompleteData) {
        // All requested channels exist with data - no need to fetch from API
        missingChannels = [];
        info(`[fetchDataWithChannelChecking] ✅ Complete data exists in HuniDB (all ${validRequestedChannels.length} channels) - skipping API fetch, querying from cache only`);
      } else if (hasNoDataAtAll || !hasDataRows) {
        // No data exists yet - all requested channels are missing
        // CRITICAL: When no channels exist at all OR channels exist but no data rows, always fetch from API (ignore cache)
        // Use normalizedRequestedChannels (will be same as validRequestedChannels if no data exists, but original case if data exists)
        missingChannels = [...normalizedRequestedChannels];
        const reason = hasNoDataAtAll ? 'no channels available' : 'channels exist but no data rows';
        info(`[fetchDataWithChannelChecking] ${reason} - treating all ${normalizedRequestedChannels.length} requested channels as missing (will fetch from API)`);
      } else {
        // Partial data exists - check which specific channels are missing
        // Use case-insensitive comparison since channel names might have different cases
        // CRITICAL: Filter from normalizedRequestedChannels (original case from HuniDB) to preserve original case for API calls
        const availableChannelsLower = new Set(availableChannels.map(ch => ch.toLowerCase()));
        missingChannels = normalizedRequestedChannels.filter(ch => !availableChannelsLower.has(ch.toLowerCase()));
        
        info(`[fetchDataWithChannelChecking] Partial data exists: ${availableChannels.length} channels available, ${missingChannels.length} missing - will fetch missing channels from API`);
      }
      
      // Log if we filtered out metadata channels
      const filteredMetadataChannels = channelsToEnsure.filter(ch => isMetadataChannel(ch));
      if (filteredMetadataChannels.length > 0) {
        debug(`[fetchDataWithChannelChecking] Filtered out ${filteredMetadataChannels.length} metadata channels from requested channels:`, 
          Array.from(new Set(filteredMetadataChannels)).slice(0, 5)
        );
      }
      
      // Check if any of the missing channels were previously identified as missing
      const dataKey = createDataKey(String(datasetId), String(projectId), String(sourceId), resolvedDataSource);
      const channelInfo = channelAvailability.get(dataKey);
      const previouslyMissingChannels = channelInfo?.missingChannels || [];
      const lastChecked = channelInfo?.lastChecked || 0;
      
      // If cache is older than 5 minutes, clear it and retry (API might have new data)
      const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
      const cacheAge = Date.now() - lastChecked;
      const shouldRetry = cacheAge > CACHE_TTL;
      
      // CRITICAL: For components using channel-values API, if ANY required channel is missing,
      // we must fetch ALL required channels to ensure complete data. Partial availability is not useful.
      // This ensures data consistency and prevents components from receiving incomplete datasets.
      const hasPartialAvailability = !hasNoDataAtAll && missingChannels.length > 0 && availableChannels.length > 0;
      
      // Determine which channels to fetch:
      // 1. If no data exists at all, fetch all channels (ignore cache)
      // 2. If we have partial availability (some channels cached, some missing), fetch ALL channels to ensure completeness
      // 3. If cache expired, retry all missing channels
      // 4. Otherwise, only fetch newly missing channels (not previously marked as missing)
      let newMissingChannels: string[];
      let shouldFetchAllChannels = false;
      
      if (hasNoDataAtAll) {
        // No data exists - always fetch all channels
        // CRITICAL: When database is empty, use channelsToEnsure (includes all requested channels with original casing)
        // Don't use validRequestedChannels because it filters out metadata channels,
        // but the API needs all channels including metadata (Datetime, etc.)
        newMissingChannels = [...channelsToEnsure];
        shouldFetchAllChannels = true;
        info(`[fetchDataWithChannelChecking] No channels available - fetching all ${newMissingChannels.length} requested channels from API (hasNoDataAtAll=true)`, {
          validRequestedChannelsCount: validRequestedChannels.length,
          channelsToEnsureCount: channelsToEnsure.length,
          newMissingChannelsCount: newMissingChannels.length,
          sampleChannels: channelsToEnsure.slice(0, 10)
        });
      } else if (hasPartialAvailability) {
        // Partial availability detected - fetch ONLY missing channels
        // SQL JOIN will merge them with cached channels
        // missingChannels already has original casing from the fix above
        newMissingChannels = missingChannels;
        shouldFetchAllChannels = false;
        info(`[fetchDataWithChannelChecking] Partial channel availability detected (${availableChannels.length} available, ${missingChannels.length} missing) - fetching ONLY ${missingChannels.length} missing channels from API`, {
          availableChannels: availableChannels.slice(0, 5),
          missingChannels: missingChannels.slice(0, 5),
          reason: 'SQL JOIN will merge missing channels with cached channels by timestamp'
        });
      } else if (shouldRetry) {
        // Cache expired - retry all missing channels
        // missingChannels already has original casing from the fix above
        newMissingChannels = missingChannels;
        shouldFetchAllChannels = true;
        info(`[fetchDataWithChannelChecking] Cache expired (${Math.round(cacheAge / 1000)}s old), retrying ${missingChannels.length} previously missing channels`);
        // Clear the missing channels cache to allow retry
        channelAvailability.set(dataKey, {
          ...(channelInfo || { className, sourceId, availableChannels: [], missingChannels: [], lastChecked: 0 }),
          missingChannels: [],
          lastChecked: 0
        });
      } else {
        // Only fetch newly missing channels (not previously marked as missing)
        // Use case-insensitive comparison for previouslyMissingChannels (they might be lowercase)
        const previouslyMissingLower = new Set(previouslyMissingChannels.map(ch => ch.toLowerCase()));
        newMissingChannels = missingChannels.filter(ch => !previouslyMissingLower.has(ch.toLowerCase()));
        if (newMissingChannels.length > 0) {
          shouldFetchAllChannels = true; // Still fetch all channels to ensure completeness
        }
      }
      
      // Step 3: CRITICAL - Before marking channels as "previously missing", check if they exist in the API
      // This prevents blocking channels that actually exist but just aren't in cache yet
      // Update Redis timestamp cache if needed (non-blocking, fire and forget)
      if (liveMode()) {
        updateLatestRedisTimestamp().catch(err => {
          debug(`[fetchDataWithChannelChecking] Error updating Redis timestamp cache:`, err);
        });
      }
      const isLive = isLiveMode();
      
      // DEBUG: Log fetch decision state (informational, not a warning)
      debug(`[fetchDataWithChannelChecking] 🔍 Fetch decision state:`, {
        hasNoDataAtAll,
        newMissingChannelsCount: newMissingChannels.length,
        shouldFetchAllChannels,
        isLive,
        willAttemptFetch: (newMissingChannels.length > 0 || hasNoDataAtAll) && !isLive,
        newMissingChannels: newMissingChannels.slice(0, 5)
      });
      
      // If we have missing channels that were previously marked as missing, verify they still don't exist in API
      if (newMissingChannels.length === 0 && missingChannels.length > 0 && !hasPartialAvailability && !isLive && resolvedDataSource === 'timeseries') {
        try {
          // Get source_name and date for channels API call (if not already set)
          if (!sourceName && sourceId) {
            try {
              sourceName = sourcesStore.getSourceName(Number(sourceId));
            } catch (e) {
              debug(`[fetchDataWithChannelChecking] Could not get sourceName for channels check:`, e);
            }
          }
          
          // Normalize date format if not already set
          if (!date) {
            date = params?.date;
          }
          // Always normalize date format to YYYYMMDD (remove dashes/slashes)
          if (date) {
            date = String(date).replace(/[-/]/g, '');
          }
          if (!date && datasetId != null && String(datasetId) !== '0') {
            try {
              const datasetInfoResponse = await fetchData(`/api/datasets/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`);
              if (datasetInfoResponse?.success && datasetInfoResponse?.data?.date) {
                const rawDate = String(datasetInfoResponse.data.date);
                date = rawDate.replace(/[-/]/g, '');
              }
            } catch (e) {
              debug(`[fetchDataWithChannelChecking] Could not get date for channels check:`, e);
            }
          }
          
          // If we have sourceName and date, check the channels API
          if (sourceName && date) {
            info(`[fetchDataWithChannelChecking] Checking API for ${missingChannels.length} previously missing channels before blocking retry`, {
              missingChannels: missingChannels.slice(0, 5),
              sourceName,
              date
            });
            
            try {
              const channelsResponse = await fetchData(
                `${apiEndpoints.file.channels}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}&source_name=${encodeURIComponent(sourceName)}`
              );
              
              if (channelsResponse?.success && Array.isArray(channelsResponse.data)) {
                // Preserve original case from API, but use case-insensitive comparison
                const apiChannels = channelsResponse.data; // Keep original case
                const apiChannelsSet = new Set(apiChannels.map(ch => ch.toLowerCase()));
                
                // Check which missing channels actually exist in the API (case-insensitive)
                const channelsThatExistInAPI = missingChannels.filter(ch => 
                  apiChannelsSet.has(ch.toLowerCase())
                );
                
                if (channelsThatExistInAPI.length > 0) {
                  info(`[fetchDataWithChannelChecking] Found ${channelsThatExistInAPI.length} previously missing channels in API - they exist! Fetching immediately`, {
                    channelsFound: channelsThatExistInAPI.slice(0, 5),
                    reason: 'Channels exist in API but were marked as missing - clearing cache and fetching'
                  });
                  
                  // Clear the "previously missing" flag for these channels
                  const dataKey = createDataKey(String(datasetId), String(projectId), String(sourceId), resolvedDataSource);
                  const currentInfo = channelAvailability.get(dataKey) || { className, sourceId, availableChannels: [], missingChannels: [], lastChecked: 0 };
                  const updatedMissingChannels = currentInfo.missingChannels.filter(ch => !channelsThatExistInAPI.includes(ch));
                  channelAvailability.set(dataKey, {
                    ...currentInfo,
                    missingChannels: updatedMissingChannels,
                    lastChecked: 0 // Reset timestamp to force immediate retry
                  });
                  
                  // Treat these as newly missing channels (will trigger fetch)
                  newMissingChannels = channelsThatExistInAPI;
                  shouldFetchAllChannels = true;
                } else {
                  info(`[fetchDataWithChannelChecking] Verified ${missingChannels.length} channels are truly missing from API - will retry after ${Math.round((CACHE_TTL - cacheAge) / 1000)}s`);
                }
              }
            } catch (channelsApiError) {
              debug(`[fetchDataWithChannelChecking] Error checking channels API (will proceed with normal logic):`, channelsApiError);
              // Continue with normal logic if channels API check fails
            }
          }
        } catch (error) {
          debug(`[fetchDataWithChannelChecking] Error during channels API check (will proceed with normal logic):`, error);
          // Continue with normal logic if check fails
        }
      }
      
      // Log when we're skipping fetch due to previously missing channels (only if we have all channels)
      if (newMissingChannels.length === 0 && missingChannels.length > 0 && !hasPartialAvailability && !isLive) {
        info(`[fetchDataWithChannelChecking] All ${missingChannels.length} missing channels were previously marked as missing (cache age: ${Math.round(cacheAge / 1000)}s). Will retry after ${Math.round((CACHE_TTL - cacheAge) / 1000)}s`);
      }
      if (isLive && newMissingChannels.length > 0 && resolvedDataSource === 'mapdata') {
        try {
          // Get source_name from source_id
          const sourceName = sourcesStore.getSourceName(Number(sourceId));
          if (!sourceName) {
            // Can't fetch from Redis without source name, but continue to query HuniDB
            debug(`[fetchDataWithChannelChecking] No source_name for source_id ${sourceId}, skipping Redis fetch but will query IndexedDB`);
          } else {
            // Check if this source is known to have no data (and cache hasn't expired)
            const noDataTimestamp = noDataTimestamps.get(sourceName);
            if (sourcesWithNoData.has(sourceName) && noDataTimestamp) {
              const age = Date.now() - noDataTimestamp;
              if (age < NO_DATA_CACHE_TTL) {
                debug(`[fetchDataWithChannelChecking] Skipping Redis fetch for source "${sourceName}" - known to have no data (cache age: ${Math.round(age / 1000)}s)`);
                // Continue to query IndexedDB even if we skip Redis fetch
              } else {
                // Cache expired, remove from no-data set and try again
                sourcesWithNoData.delete(sourceName);
                noDataTimestamps.delete(sourceName);
                debug(`[fetchDataWithChannelChecking] No-data cache expired for source "${sourceName}", will retry`);
              }
            }
            
            // Only fetch from Redis if we have a source name and it's not in the no-data cache
            if (sourceName && (!sourcesWithNoData.has(sourceName) || (noDataTimestamp && Date.now() - noDataTimestamp >= NO_DATA_CACHE_TTL))) {
              debug(`[fetchDataWithChannelChecking] Live mode: Fetching missing channels from Redis for source "${sourceName}"`);
              
              // Determine time range - use params if provided, otherwise last 1 hour
              const now = Date.now();
              const oneHourAgo = now - (60 * 60 * 1000);
              const startTime = params?.timeRange?.start || oneHourAgo;
              const endTime = params?.timeRange?.end || now;
              
              // Fetch from Redis using source_name
              const redisData = await streamingDataService.fetchMergedData(
                sourceName,
                channelsToEnsure,
                startTime,
                endTime
              );
              
              if (redisData.length > 0) {
                // Ensure sorted by timestamp (CRITICAL)
                redisData.sort((a, b) => a.timestamp - b.timestamp);
                
                // Update cached latest Redis timestamp (use the latest timestamp from fetched data)
                const latestTs = redisData[redisData.length - 1]?.timestamp;
                if (latestTs && (!cachedLatestRedisTimestamp || latestTs > cachedLatestRedisTimestamp)) {
                  cachedLatestRedisTimestamp = latestTs;
                  cachedLatestRedisTimestampTime = Date.now();
                }
                
                // Store in IndexedDB
                await storeRedisDataAsMapdata(sourceName, redisData);
                debug(`[fetchDataWithChannelChecking] Live mode: Stored ${redisData.length} points from Redis`);
              } else {
                // Mark source as having no data
                sourcesWithNoData.add(sourceName);
                noDataTimestamps.set(sourceName, Date.now());
                debug(`[fetchDataWithChannelChecking] No Redis data found for source "${sourceName}", marking as no-data for ${NO_DATA_CACHE_TTL / 1000}s`);
              }
            }
          }
          
        } catch (redisError) {
          warn(`[fetchDataWithChannelChecking] Error fetching from Redis in live mode:`, redisError);
        }
      }
      
      // Log if we're skipping fetch due to previously missing channels
      // BUT: Never skip if hasNoDataAtAll is true (database is empty - must fetch)
      if (newMissingChannels.length === 0 && missingChannels.length > 0 && !isLive && !hasNoDataAtAll) {
        info(`[fetchDataWithChannelChecking] All ${missingChannels.length} missing channels were previously marked as missing (cache age: ${Math.round(cacheAge / 1000)}s). Will retry after ${Math.round((CACHE_TTL - cacheAge) / 1000)}s`);
      }
      
      // CRITICAL: If database is completely empty (hasNoDataAtAll), ALWAYS attempt fetch
      // even in live mode - we need to populate the cache with historical data
      // Live mode only prevents fetching when we already have cached data
      const willAttemptFetch = hasNoDataAtAll 
        ? true  // Always fetch when database is empty, even in live mode
        : (newMissingChannels.length > 0 && !isLive);  // Otherwise, only fetch if not in live mode
      
      if (willAttemptFetch) {
        if (hasNoDataAtAll) {
          debug(`[fetchDataWithChannelChecking] 🚀 Database is empty (hasNoDataAtAll=true) - fetching all ${channelsToEnsure.length} channels from API`);
        } else {
          info(`[fetchDataWithChannelChecking] New missing channels (${newMissingChannels.length}):`, newMissingChannels.slice(0, 10));
        }
        
        // Step 4: Query API for all required channels (to ensure complete data) - only if not in live mode
        try {
          // Get sourceName from sourcesStore if not provided in params
          if (!sourceName) {
            sourceName = params?.sourceName || params?.source_name;
          }
          if (!sourceName && sourceId) {
            try {
              const resolvedSourceName = sourcesStore.getSourceName(Number(sourceId));
              if (resolvedSourceName) {
                sourceName = resolvedSourceName;
                info(`[fetchDataWithChannelChecking] Resolved sourceName from sourceId ${sourceId}: ${sourceName}`);
              } else {
                warn(`[fetchDataWithChannelChecking] Could not resolve sourceName from sourceId ${sourceId} - sourcesStore returned null/undefined`);
              }
            } catch (e) {
              warn(`[fetchDataWithChannelChecking] Error resolving sourceName from sourceId ${sourceId}:`, e);
            }
          }
          
          // CRITICAL: If sourceName is missing, we cannot make API calls - return early
          if (!sourceName && willAttemptFetch) {
            warn(`[fetchDataWithChannelChecking] ⚠️ CRITICAL: sourceName is missing! Cannot make API call. Returning empty data.`, {
              sourceId,
              params: {
                hasSourceName: !!(params?.sourceName || params?.source_name),
                className,
                datasetId,
                projectId
              },
              suggestion: 'Ensure sourcesStore is initialized and contains sourceId mapping before calling this function'
            });
            // Don't attempt API fetch without sourceName - it will fail
            // Continue to query cache only (might have cached data from previous successful calls)
          }
          
          // Get dataset date if not provided - try to fetch from dataset info.
          // Dataset date is in local time (dataset timezone). Used for folder path; server converts to UTC only for Influx.
          // Always normalize date format to YYYYMMDD (remove dashes/slashes)
          if (date) {
            date = String(date).replace(/[-/]/g, '');
          }
          if (!date && datasetId != null && String(datasetId) !== '0') {
            try {
              const datasetInfoResponse = await fetchData(`/api/datasets/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`);
              if (datasetInfoResponse?.success && datasetInfoResponse?.data?.date) {
                const rawDate = String(datasetInfoResponse.data.date);
                // Convert to YYYYMMDD format (remove dashes)
                date = rawDate.replace(/[-/]/g, '');
                info(`[fetchDataWithChannelChecking] Got dataset date from API: ${rawDate} -> ${date}`);
              }
            } catch (e) {
              warn(`[fetchDataWithChannelChecking] Could not get dataset date:`, e);
            }
          }
          
          // Date is already normalized to YYYYMMDD format above
          if (date && date.includes('-')) {
            date = date.replace(/-/g, '');
          }
          
          // If still no date, use today's date as fallback (YYYYMMDD format)
          if (!date) {
            date = new Date().toISOString().split('T')[0].replace(/-/g, '');
            debug(`[fetchDataWithChannelChecking] Using today's date as fallback: ${date}`);
          }
          
          // CRITICAL: Only fetch MISSING channels from API
          // We'll store them in cache, then use SQL JOIN to merge with existing cached channels
          // This is much more efficient than fetching all channels when some are already cached
          // BUT: Always include Datetime in the fetch (API requires it)
          const channelsToFetch = newMissingChannels.length > 0 
            ? (newMissingChannels.includes('Datetime') || newMissingChannels.includes('datetime') 
                ? newMissingChannels 
                : ['Datetime', ...newMissingChannels])
            : channelsToEnsure;
          
          // CRITICAL: Log channels before API call to verify they're in original case
          debug(`[fetchDataWithChannelChecking] 🔍 CHANNELS TO FETCH BEFORE API:`, {
            channelsToFetch: channelsToFetch,
            channelsCount: channelsToFetch.length,
            sampleChannels: channelsToFetch.slice(0, 10),
            caseCheck: channelsToFetch.slice(0, 10).map(ch => ({
              channel: ch,
              hasUpperCase: /[A-Z]/.test(ch),
              isLowercase: ch === ch.toLowerCase()
            })),
            newMissingChannels: newMissingChannels.slice(0, 10),
            channelsToEnsure: channelsToEnsure.slice(0, 10),
            note: 'These channels should be in original case. If lowercase here, they were lowercased during processing in fetchDataWithChannelChecking.'
          });
          
          info(`[fetchDataWithChannelChecking] 🚀 About to fetch ${channelsToFetch.length} MISSING channels from API (${availableChannels.length} already in cache)`, {
            className,
            datasetId,
            projectId,
            sourceId,
            sourceName: sourceName || 'NOT PROVIDED',
            date: date || 'NOT PROVIDED',
            missingChannels: newMissingChannels.slice(0, 10),
            availableChannels: availableChannels.slice(0, 10),
            channelsToFetch: channelsToFetch.slice(0, 10),
            validRequestedChannels: validRequestedChannels.slice(0, 10),
            fetchReason: hasNoDataAtAll ? 'No data in cache - fetching all channels' :
                        shouldRetry ? 'Cache expired - retrying missing channels' :
                        'Fetching only missing channels (will merge with cache via SQL JOIN)',
            dataTypes: resolvedDataSource === 'timeseries' ? ['timeseries_data'] : 
                      resolvedDataSource === 'mapdata' ? ['map_data'] :
                      resolvedDataSource === 'aggregates' ? ['aggregate_data'] : undefined,
            hasSourceName: !!sourceName,
            channelsToFetchLength: channelsToFetch.length
          });
          
          // CRITICAL: Don't attempt API fetch if sourceName is missing
          let response: any = null;
          if (!sourceName && channelsToFetch.length > 0) {
            warn(`[fetchDataWithChannelChecking] ⚠️ SKIPPING API FETCH - sourceName is required but missing! Storage will NOT happen.`, {
              sourceId,
              channelsToFetch: channelsToFetch.slice(0, 10),
              className,
              datasetId,
              projectId,
              date,
              note: 'This prevents storage from happening. sourceName must be provided for API fetch and storage.'
            });
            // Continue to query cache only
          } else if (sourceName && channelsToFetch.length > 0) {
            // Set progress message for API fetch (when some channels are missing from cache)
            setProgress(chartType, className, normalizedSourceId, 30, 'Downloading data...');
            
            // Resolve timezone when not in params: from dataset (datasetId > 0) or from date/timezone endpoint (fleet/day mode)
            let resolvedTimezone: string | null = params?.timezone ?? null;
            if (resolvedTimezone == null || resolvedTimezone === '') {
              if (datasetId != null && Number(datasetId) > 0) {
                resolvedTimezone = await fetchDatasetTimezone(className, projectId, datasetId);
              }
              if ((resolvedTimezone == null || resolvedTimezone === '') && date) {
                try {
                  const dateDisplay = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
                  const tzResponse = await fetchData(`${apiEndpoints.app.datasets}/date/timezone?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateDisplay)}`);
                  const tzData = tzResponse?.data ?? tzResponse;
                  if (tzData?.timezone) {
                    resolvedTimezone = String(tzData.timezone).trim();
                    debug(`[fetchDataWithChannelChecking] Resolved timezone for date ${dateDisplay}: ${resolvedTimezone}`);
                  }
                } catch (e) {
                  debug(`[fetchDataWithChannelChecking] Could not fetch timezone for date:`, e);
                }
              }
            }
            const timezoneForApi = resolvedTimezone || 'UTC';
            
            // Log the exact parameters being passed to the API
            info(`[fetchDataWithChannelChecking] Calling unifiedDataAPI.getDataByChannels with:`, {
              channelsCount: channelsToFetch.length,
              channels: channelsToFetch.slice(0, 10),
              projectId,
              className,
              datasetId,
              sourceName: sourceName,
              sourceId,
              date: date,
              data_source: params?.data_source ?? 'auto',
              timezone: timezoneForApi
            });
            
            // Note: We include metadata channels in the API request even though they're filtered from missing channels
            // because the API might need them, but we don't treat them as "missing" since they're derived from timestamp
            // Default data_source: 'auto' so server runs unified path (DuckDB check, Influx backfill, write parquet, return from DuckDB).
            response = await unifiedDataAPI.getDataByChannels(channelsToFetch, {
              projectId: projectId,
              className: className,
              datasetId: datasetId,
              sourceName: sourceName,
              sourceId: typeof sourceId === 'number' ? sourceId : Number(sourceId) || 0,
              date: date,
              timezone: timezoneForApi,
              use_v2: params?.use_v2 !== false,
              dataTypes: resolvedDataSource === 'timeseries' ? ['timeseries_data'] : 
                        resolvedDataSource === 'mapdata' ? ['map_data'] :
                        resolvedDataSource === 'aggregates' ? ['aggregate_data'] : undefined,
              data_source: params?.data_source ?? 'auto'
            });
            
            info(`[fetchDataWithChannelChecking] API response:`, {
              hasData: !!(response && response.data),
              dataLength: response?.data?.length || 0,
              availableChannels: response?.availableChannels?.length || 0,
              missingChannels: response?.missingChannels?.length || 0,
              hasAll: response?.hasAll || false,
              className,
              datasetId,
              projectId,
              sourceId,
              sourceName: sourceName,
              date,
              channelsRequested: channelsToFetch.slice(0, 10)
            });
          } else {
            // No API fetch attempted - either no missing channels or sourceName missing
            warn(`[fetchDataWithChannelChecking] ⚠️ SKIPPING API FETCH - Storage will NOT happen!`, {
              hasSourceName: !!sourceName,
              sourceName: sourceName || 'MISSING',
              channelsToFetch: channelsToFetch.length,
              channelsToFetchList: channelsToFetch.slice(0, 10),
              reason: !sourceName ? 'sourceName missing' : 'no channels to fetch',
              note: 'If channelsToFetch is empty, storage will not happen. Check why channels are not being marked as missing.'
            });
          }
          
          if (response && response.data && response.data.length > 0) {
            if (resolvedDataSource === 'timeseries') {
              info(`[fetchDataWithChannelChecking] ✅ API response received - ${response.data.length} data points (timeseries: in-memory cache only)`);
            } else {
              info(`[fetchDataWithChannelChecking] ✅ API response received - will store ${response.data.length} data points in HuniDB`);
            }
            info(`[fetchDataWithChannelChecking] Successfully fetched ${response.data.length} data points with ${response.availableChannels?.length || 0} channels from API`);
            
            // CRITICAL: Update in-memory cache FIRST so charts can update immediately
            // Use same key as read path (with channelsHash) so different scatter charts don't overwrite each other
            dataCache.set(cacheKey, {
              data: response.data,
              timestamp: Date.now(),
              indexed: false,
              channels: response.availableChannels || []
            });
            if (resolvedDataSource === 'timeseries') {
              info(`[fetchDataWithChannelChecking] ✅ Updated in-memory cache with ${response.data.length} data points (timeseries: no persistence).`);
            } else {
              info(`[fetchDataWithChannelChecking] ✅ Updated in-memory cache with ${response.data.length} data points (charts can now update). Storage to HuniDB will happen next.`);
            }
            
            // Update channel availability cache - remove successfully fetched channels from missing list
            const dataKey = createDataKey(String(datasetId), String(projectId), String(sourceId), resolvedDataSource);
            const currentInfo = channelAvailability.get(dataKey) || { className, sourceId, availableChannels: [], missingChannels: [], lastChecked: 0 };
            const fetchedChannels = response.availableChannels || [];
            const updatedMissingChannels = currentInfo.missingChannels.filter(ch => !fetchedChannels.includes(ch));
            channelAvailability.set(dataKey, {
              ...currentInfo,
              availableChannels: [...new Set([...currentInfo.availableChannels, ...fetchedChannels])],
              missingChannels: updatedMissingChannels,
              lastChecked: Date.now()
            });
            
            // Trigger background sync of channels from PostgreSQL (non-blocking)
            // Skip for overlay (e.g. FleetDataTable) to avoid N syncs per source when user asked for 2 channels only
            if (className && projectId && date && chartType !== 'overlay') {
              const normalizedDate = date.replace(/[-/]/g, '');
              import('../services/channelsService').then(({ syncChannelsFromPostgreSQL }) => {
                syncChannelsFromPostgreSQL(className, projectId, normalizedDate, sourceName)
                  .catch(err => {
                    // Silently fail - background sync shouldn't block UI
                    debug('[UnifiedDataStore.fetchDataWithChannelChecking] Background channel sync failed:', err);
                  });
              }).catch(err => {
                debug('[UnifiedDataStore.fetchDataWithChannelChecking] Failed to import channelsService:', err);
              });
            }
            
            // Step 5: Store in HuniDB (await to ensure data is available for SQL JOIN query)
            // We need to wait for storage so the SQL JOIN query below can find the newly stored channels
            // CRITICAL: Use original case from requested channels, NOT from data keys
            // The API response data may have lowercase keys, but we want to preserve original case
            // from the chart objects/requested channels for table names
            const channelsFromData = extractChannelsFromData(response.data);
            
            // CRITICAL: Map data keys (which may be lowercase) back to requested channel names (original case)
            // This ensures tables are created with original case even if API returns lowercase keys
            const requestedChannelsLower = new Set(requiredChannels.map(ch => ch.toLowerCase()));
            const channelsInData = channelsFromData.map(ch => ch.toLowerCase());
            const missingInData = requiredChannels.filter(ch => !channelsInData.includes(ch.toLowerCase()));
            
            // Build channel mapping: lowercase data key -> original case requested channel
            const channelCaseMap = new Map<string, string>();
            requiredChannels.forEach(reqCh => {
              const reqChLower = reqCh.toLowerCase();
              channelCaseMap.set(reqChLower, reqCh); // Map to original case
            });
            
            // Start with requested channels in original case (these are what we want to store)
            const allChannelsToStore = new Set<string>();
            
            // Add channels that exist in data, using original case from requested channels
            channelsFromData.forEach(dataCh => {
              const dataChLower = dataCh.toLowerCase();
              // If this data channel matches a requested channel, use the original case
              if (requestedChannelsLower.has(dataChLower)) {
                const originalCase = channelCaseMap.get(dataChLower);
                if (originalCase) {
                  allChannelsToStore.add(originalCase); // Use original case from requested channels
                } else {
                  allChannelsToStore.add(dataCh); // Fallback to data key if no match
                }
              } else {
                // Channel in data but not explicitly requested - preserve its case from data
                allChannelsToStore.add(dataCh);
              }
            });
            
            // Also add requested channels that might not be in data yet (for future storage)
            // Use original case from requested channels
            requiredChannels.forEach(reqCh => {
              const reqChLower = reqCh.toLowerCase();
              // Check if it exists in data (case-insensitive)
              if (channelsInData.includes(reqChLower)) {
                // Already added above
              } else {
                // Not in data, but was requested - add with original case
                allChannelsToStore.add(reqCh);
              }
            });
            
            // If response.availableChannels is provided and has original case, prefer those
            if (response.availableChannels && response.availableChannels.length > 0) {
              response.availableChannels.forEach((apiCh: string) => {
                const apiChLower = apiCh.toLowerCase();
                if (requestedChannelsLower.has(apiChLower)) {
                  // Use the case from availableChannels if it's different (API knows the real case)
                  allChannelsToStore.delete(channelCaseMap.get(apiChLower) || apiChLower);
                  allChannelsToStore.add(apiCh); // Use original case from API
                }
              });
            }
            
            const finalChannelsToStore = Array.from(allChannelsToStore);
            
            // CRITICAL: Transform data keys to match original case channel names
            // The API may return lowercase keys, but we want to store with original case
            // Build a mapping from lowercase data keys to original case channel names
            const dataKeyToChannelMap = new Map<string, string>();
            finalChannelsToStore.forEach(ch => {
              const chLower = ch.toLowerCase();
              dataKeyToChannelMap.set(chLower, ch);
            });
            
            // Transform data: rename keys from lowercase to original case
            info(`[fetchDataWithChannelChecking] 🔄 Transforming data keys from API response to original case...`, {
              originalDataKeys: response.data.length > 0 ? Object.keys(response.data[0]).slice(0, 10) : [],
              channelsToStore: finalChannelsToStore.slice(0, 10),
              dataKeyToChannelMapSize: dataKeyToChannelMap.size
            });
            
            const transformedData = response.data.map((point: any) => {
              const transformed: any = {};
              const keysProcessed = new Set<string>(); // Track lowercase keys we've already processed
              
              Object.keys(point).forEach(key => {
                const keyLower = key.toLowerCase();
                
                // Skip if we've already processed this key (case-insensitive)
                // This prevents storing both lowercase and original case versions
                if (keysProcessed.has(keyLower)) {
                  return; // Skip duplicate (case-insensitive)
                }
                keysProcessed.add(keyLower);
                
                // If this key matches a channel we're storing, use original case
                if (dataKeyToChannelMap.has(keyLower)) {
                  transformed[dataKeyToChannelMap.get(keyLower)!] = point[key];
                } else {
                  // Keep other keys as-is (metadata, timestamp, etc.)
                  transformed[key] = point[key];
                }
              });
              return transformed;
            });
            
            info(`[fetchDataWithChannelChecking] ✅ Data transformation complete`, {
              transformedDataKeys: transformedData.length > 0 ? Object.keys(transformedData[0]).slice(0, 10) : [],
              transformedDataLength: transformedData.length
            });
            
            // CRITICAL: Validate that transformed data keys match original case channels
            if (transformedData.length > 0) {
              const transformedKeys = Object.keys(transformedData[0]);
              const transformedKeysLower = new Set(transformedKeys.map(k => k.toLowerCase()));
              const _channelsToStoreLower = new Set(finalChannelsToStore.map((ch: string) => ch.toLowerCase()));
              
              // Check for case mismatches
              const caseMismatches: string[] = [];
              finalChannelsToStore.forEach(expectedCh => {
                const expectedLower = expectedCh.toLowerCase();
                if (transformedKeysLower.has(expectedLower)) {
                  // Find the actual key in transformed data
                  const actualKey = transformedKeys.find(k => k.toLowerCase() === expectedLower);
                  if (actualKey && actualKey !== expectedCh) {
                    caseMismatches.push(`${expectedCh} (expected) vs ${actualKey} (actual)`);
                  }
                }
              });
              
              if (caseMismatches.length > 0) {
                warn(`[fetchDataWithChannelChecking] ⚠️ CASE MISMATCH DETECTED in transformed data:`, {
                  caseMismatches: caseMismatches.slice(0, 10),
                  expectedChannels: finalChannelsToStore.slice(0, 10),
                  actualKeys: transformedKeys.slice(0, 10),
                  note: 'Channel names should match original case exactly for InfluxDB and DuckDB compatibility'
                });
              } else {
                debug(`[fetchDataWithChannelChecking] ✅ Case validation passed: all ${finalChannelsToStore.length} channels match original case`);
              }
            }
            
            const storeParams = { ...params, chartType, context: chartType, fromAPI: true, forceStore: true };
            
            if (resolvedDataSource !== 'timeseries') {
              info(`[fetchDataWithChannelChecking] 💾 Storing ${response.data.length} data points in HuniDB cache for future use`, {
                dataSource: resolvedDataSource,
                className,
                datasetId,
                projectId,
                sourceId,
                channelsCount: finalChannelsToStore.length,
                channels: finalChannelsToStore.slice(0, 20),
                channelsFromData: channelsFromData.slice(0, 20),
                responseAvailableChannels: response.availableChannels?.slice(0, 20),
                requestedChannels: requiredChannels,
                missingInData: missingInData.length > 0 ? missingInData : 'none',
                dataPoints: response.data.length,
                sampleDataKeys: response.data.length > 0 ? Object.keys(response.data[0]).slice(0, 20) : [],
                transformedSampleKeys: transformedData.length > 0 ? Object.keys(transformedData[0]).slice(0, 20) : []
              });
            }
            
            if (missingInData.length > 0) {
              debug(`[fetchDataWithChannelChecking] ⚠️ Requested channels not found in API response data:`, {
                missingChannels: missingInData,
                availableChannels: channelsFromData.slice(0, 20),
                requestedChannels: requiredChannels,
                note: 'These channels will still be stored if they appear in future data'
              });
            }
            
            try {
              // CRITICAL: Use normalizedSourceId (number) consistently for storage and query
              // This ensures data is stored and queried with the same ID
              if (resolvedDataSource !== 'timeseries') {
                info(`[fetchDataWithChannelChecking] 📦 Attempting to store ${transformedData.length} data points in HuniDB...`, {
                  dataSource: resolvedDataSource,
                  className: className.toLowerCase(),
                  datasetId: typeof datasetId === 'number' ? datasetId : Number(datasetId),
                  projectId: typeof projectId === 'number' ? projectId : Number(projectId),
                  sourceId: normalizedSourceId,
                  channelsToStore: finalChannelsToStore.length,
                  dataPoints: transformedData.length,
                  sampleDataKeys: transformedData.length > 0 ? Object.keys(transformedData[0]).slice(0, 10) : []
                });
              }
              
              info(`[fetchDataWithChannelChecking] 🔄 Calling storeDataInIndexedDB...`, {
                dataSource: resolvedDataSource,
                className: className.toLowerCase(),
                datasetId,
                projectId,
                sourceId: normalizedSourceId,
                channels: finalChannelsToStore.slice(0, 10),
                dataPoints: transformedData.length,
                transformedDataSampleKeys: transformedData.length > 0 ? Object.keys(transformedData[0]).slice(0, 10) : []
              });
              
              await storeDataInIndexedDB(resolvedDataSource, className, datasetId, projectId, normalizedSourceId, finalChannelsToStore, transformedData, storeParams);
              
              if (resolvedDataSource === 'timeseries') {
                info(`[fetchDataWithChannelChecking] ✅ Timeseries: in-memory cache updated (${transformedData.length} data points, ${finalChannelsToStore.length} channels).`);
              } else {
                info(`[fetchDataWithChannelChecking] ✅ Successfully stored ${transformedData.length} data points in HuniDB with ${finalChannelsToStore.length} channels - data will be available on next page load`, {
                  storedChannels: finalChannelsToStore.length,
                  dataPoints: response.data.length,
                  cacheKey: `${chartType}_${className}_${normalizedSourceId}_${datasetId}_${projectId}`,
                  storageIds: { 
                    datasetId: typeof datasetId === 'number' ? datasetId : Number(datasetId), 
                    projectId: typeof projectId === 'number' ? projectId : Number(projectId), 
                    sourceId: normalizedSourceId 
                  },
                  note: 'Storage completed - verify with getAvailableChannels on next load'
                });
              }
            } catch (storeError) {
              if (resolvedDataSource !== 'timeseries') {
              logError(`[fetchDataWithChannelChecking] ❌ Error storing fetched data in HuniDB - cache will not be available on next load:`, {
                error: storeError,
                message: (storeError as Error)?.message,
                stack: (storeError as Error)?.stack,
                storageParams: {
                  dataSource: resolvedDataSource,
                  className: className.toLowerCase(),
                  datasetId: typeof datasetId === 'number' ? datasetId : Number(datasetId),
                  projectId: typeof projectId === 'number' ? projectId : Number(projectId),
                  sourceId: normalizedSourceId,
                  channelsToStore: finalChannelsToStore.length,
                  dataPoints: response.data.length
                }
              });
              }
              // Continue anyway - we'll try to query what we have
            }
            
            // Graceful handling: log channels still missing post-fetch, but continue
            // Filter out metadata channels - they're derived from tags, not fetched as data channels
            const METADATA_CHANNELS = new Set([
              'Datetime', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename',
              'Grade', 'grade', 'GRADE', 'Mainsail_code', 'mainsail_code',
              'TACK', 'tack', 'event_id',
              'Config', 'config', 'State', 'state', 'STATE', 'Foiling_state', 'foiling_state', 'FOILING_STATE'
            ]);
            const isMetadataChannel = (ch: string): boolean => {
              if (!ch || typeof ch !== 'string') return true;
              const chLower = ch.toLowerCase().trim();
              // If Grade or State are explicitly requested, they are data channels, not metadata
              if (chLower === 'grade' || chLower === 'state') {
                return false; // Not metadata if explicitly requested
              }
              return METADATA_CHANNELS.has(ch) || 
                     METADATA_CHANNELS.has(chLower) || 
                     chLower.endsWith('_code') ||
                     chLower === 'config' ||
                     chLower === 'state' ||
                     chLower === 'foiling_state';
            };
            
            // Case-insensitive comparison for missing channels check
            // API might return 'Twa_deg' but we requested 'twa_deg' - they're the same channel
            const availableChannelsLower = new Set((response.availableChannels || []).map((ch: string) => ch.toLowerCase()));
            const stillMissing = (response.missingChannels || [])
              .filter((ch: string) => {
                // Check if channel is available (case-insensitive)
                const chLower = ch.toLowerCase();
                return !availableChannelsLower.has(chLower);
              })
              .filter((ch: string) => !isMetadataChannel(ch)); // Exclude metadata channels from missing warnings
            
            if (stillMissing.length > 0) {
              debug(`[fetchDataWithChannelChecking] Channels still missing after API fetch (skipping):`, {
                missingChannels: stillMissing,
                requestedChannels: newMissingChannels,
                apiReturnedChannels: response.availableChannels?.slice(0, 10) || [],
                totalApiChannels: response.availableChannels?.length || 0,
                className,
                datasetId,
                projectId,
                sourceId,
                sourceName: sourceName || 'not provided',
                date
              });
            } else if ((response.missingChannels || []).length > 0) {
              // If all missing channels were metadata, log at debug level
              const metadataMissing = (response.missingChannels || []).filter((ch: string) => isMetadataChannel(ch));
              if (metadataMissing.length > 0) {
                debug(`[fetchDataWithChannelChecking] Metadata channels not in API response (expected, derived from tags):`, metadataMissing);
              }
            }
          } else {
            // This is expected when channels don't exist in the data file
            warn(`[fetchDataWithChannelChecking] ⚠️ API returned no data for missing channels:`, {
              missingChannels: newMissingChannels.slice(0, 10),
              response: response ? {
                hasData: !!response.data,
                dataLength: response.data?.length || 0,
                availableChannels: response.availableChannels?.length || 0,
                availableChannelsList: response.availableChannels?.slice(0, 10) || []
              } : 'null',
              sourceName: sourceName || 'not provided',
              date,
              className,
              datasetId,
              projectId,
              sourceId,
              channelsRequested: channelsToFetch.slice(0, 10)
            });
            
            // Only mark channels as definitively missing if API call succeeded but returned no data
            // If API call failed (caught in catch block), don't mark as missing - allow retry
            if (response) {
              // API call succeeded but returned no data - mark as missing with TTL
              const dataKey = createDataKey(String(datasetId), String(projectId), String(sourceId), resolvedDataSource);
              const currentInfo = channelAvailability.get(dataKey) || { className, sourceId, availableChannels: [], missingChannels: [], lastChecked: 0 };
              const updatedMissingChannels = [...new Set([...currentInfo.missingChannels, ...newMissingChannels])];
              channelAvailability.set(dataKey, {
                ...currentInfo,
                missingChannels: updatedMissingChannels,
                lastChecked: Date.now() // Set timestamp so we can retry after TTL
              });
              info(`[fetchDataWithChannelChecking] Marked ${updatedMissingChannels.length} channels as missing (will retry after 5min):`, updatedMissingChannels.slice(0, 5));
            }
          }
        } catch (apiError) {
          logError(`[fetchDataWithChannelChecking] Error fetching missing channels from API:`, {
            error: apiError instanceof Error ? apiError.message : String(apiError),
            stack: apiError instanceof Error ? apiError.stack : undefined,
            className,
            datasetId,
            projectId,
            sourceId,
            sourceName: sourceName || 'not provided',
            date: date || 'not provided',
            missingChannels: newMissingChannels.slice(0, 5)
          });
          // Don't mark channels as missing on API error - allow retry on next call
          // The cache TTL mechanism will handle retries
        }
      }
      
      // Step 5: Query IndexedDB for all required data
      // Determine if we should apply global filters at the data layer
      // Optional time range from params
      // CRITICAL: TimeSeries component should NEVER filter by timeRange - it needs full dataset
      // TimeSeries uses selectedRange only for zooming, not for data filtering
      const skipTimeRangeFilter = params?.skipTimeRangeFilter === true;
      const timeRange = skipTimeRangeFilter 
        ? undefined 
        : (params?.timeRange && params?.timeRange.start != null && params?.timeRange.end != null
          ? { start: params.timeRange.start, end: params.timeRange.end }
          : undefined);
      // Build filters: use explicit filters from params if provided, otherwise from context-specific store (maneuvers/aggregates/timeseries)
      const filterContext = getFilterContextFromDataSource(resolvedDataSource);
      const filters = params?.filters 
        ? { ...params.filters, timeRange }
        : (applyGlobalFilters
          ? (() => {
              const states = filterContext === 'maneuvers' ? selectedStatesManeuvers() : filterContext === 'aggregates' ? selectedStatesAggregates() : selectedStatesTimeseries();
              const races = filterContext === 'maneuvers' ? selectedRacesManeuvers() : filterContext === 'aggregates' ? selectedRacesAggregates() : selectedRacesTimeseries();
              const legs = filterContext === 'maneuvers' ? selectedLegsManeuvers() : filterContext === 'aggregates' ? selectedLegsAggregates() : selectedLegsTimeseries();
              const grades = filterContext === 'maneuvers' ? selectedGradesManeuvers() : filterContext === 'aggregates' ? selectedGradesAggregates() : selectedGradesTimeseries();
              return {
                twaStates: states,
                raceNumbers: races.map((r: string) => parseInt(r, 10)).filter((n: number) => !isNaN(n)),
                legNumbers: legs.map((l: string) => parseInt(l, 10)).filter((n: number) => !isNaN(n)),
                grades: grades.map((g: string) => parseInt(g, 10)).filter((n: number) => !isNaN(n)),
                timeRange
              };
            })()
          : undefined);
      
      // Diagnostic logging for filter state - only log when filters are actually applied
      if (applyGlobalFilters && filters && (
        (filters.raceNumbers && filters.raceNumbers.length > 0) ||
        (filters.legNumbers && filters.legNumbers.length > 0) ||
        (filters.grades && filters.grades.length > 0) ||
        (filters.twaStates && filters.twaStates.length > 0)
      )) {
        debug('[UnifiedDataStore] Filters applied:', {
          races: filters.raceNumbers?.length || 0,
          legs: filters.legNumbers?.length || 0,
          grades: filters.grades?.length || 0,
          states: filters.twaStates?.length || 0
        });
      }
      const queryDataTypes = resolvedDataSource === 'objects' ? ['timeseries'] : [resolvedDataSource];
      
      // Step 5: After fetching missing channels from API (if needed), query ALL requested channels
      // Timeseries are NOT stored in HuniDB (store methods are no-ops). Skip HuniDB query for timeseries
      // so we don't run a pointless query and log "0 rows"; data will come from in-memory cache (API fetch above).
      let data: any[] = [];
      const skipHuniDBQueryForTimeseries = resolvedDataSource === 'timeseries';
      if (skipHuniDBQueryForTimeseries) {
        debug(`[fetchDataWithChannelChecking] Skipping HuniDB query for timeseries (not stored in HuniDB); using in-memory cache / API data`);
      }

      if (!skipHuniDBQueryForTimeseries) {
      try {
        info(`[fetchDataWithChannelChecking] Querying cache for ALL ${validRequestedChannelsLower.length} requested channels (SQL JOIN will merge by timestamp)`, {
          queryIds: { datasetId, projectId, sourceId: normalizedSourceId },
          channels: validRequestedChannelsLower.slice(0, 5)
        });
        // CRITICAL: Use numbers consistently (not String()) - queryDataByChannels expects numbers and converts internally
        // Use normalizedSourceId to match what was used in storage
        // CRITICAL: Use normalizedRequestedChannels (original case) instead of lowercase
        // queryDataByChannels handles case-insensitive matching, but using original case ensures
        // proper table name matching and better performance
        data = await huniDBStore.queryDataByChannels(
          className.toLowerCase(),
          datasetId, // Use number, not String()
          projectId, // Use number, not String()
          normalizedSourceId, // Use normalized sourceId consistently (matches storage)
          normalizedRequestedChannels, // Query ALL requested channels (original case from HuniDB) - SQL handles the merge
          queryDataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
          timeRange,
          filters
        );
        
        // Normalize data from HuniDB to remove duplicate case variations
        if (data && data.length > 0) {
          data = await normalizeDataFields(data, normalizedRequestedChannels);
        }
        
        if (data.length > 0) {
          // Check which channels are actually present in the returned data
          const actualChannels = data.length > 0 ? Object.keys(data[0]).filter(k => 
            !['timestamp', 'Datetime', 'datetime', 'source_id', 'source_name'].includes(k)
          ) : [];
          const missingInData = validRequestedChannelsLower.filter(ch => 
            !actualChannels.some(ac => ac.toLowerCase() === ch)
          );
          
          // CRITICAL: Check if any channels have all null values - if so, treat them as missing and fetch from API
          const channelsWithAllNulls: string[] = [];
          if (data.length > 0) {
            // Check each requested channel to see if all values are null
            for (const requestedChannel of normalizedRequestedChannels) {
              const requestedChannelLower = requestedChannel.toLowerCase();
              // Find the actual channel name in data (case-insensitive)
              const actualChannelName = actualChannels.find(ac => ac.toLowerCase() === requestedChannelLower);
              if (actualChannelName) {
                // Check if all values for this channel are null/undefined
                const allNull = data.every(row => {
                  const value = row[actualChannelName];
                  return value === null || value === undefined || (typeof value === 'number' && isNaN(value));
                });
                if (allNull) {
                  channelsWithAllNulls.push(requestedChannel);
                }
              }
            }
          }
          
          if (channelsWithAllNulls.length > 0) {
            debug(`[fetchDataWithChannelChecking] ${channelsWithAllNulls.length} channels with all null values in HuniDB - will fetch from API`, {
              channelsWithAllNulls: channelsWithAllNulls.slice(0, 10),
              dataRowCount: data.length,
              note: 'These channels exist in HuniDB tables but have no valid data. Will fetch from API to populate them.'
            });
            
            // Mark these channels as missing so they get fetched from API
            // Add them to the missing channels list if not already there
              const _channelsWithAllNullsLower = new Set(channelsWithAllNulls.map(ch => ch.toLowerCase()));
            const currentMissingLower = new Set(missingChannels.map(ch => ch.toLowerCase()));
            channelsWithAllNulls.forEach(ch => {
              if (!currentMissingLower.has(ch.toLowerCase())) {
                missingChannels.push(ch);
              }
            });
            
            // If we have missing channels due to null values, we need to trigger an API fetch
            // This will be handled by the existing API fetch logic below
            info(`[fetchDataWithChannelChecking] Will fetch ${channelsWithAllNulls.length} channels from API due to null values in HuniDB`);
          }
          
          info(`[fetchDataWithChannelChecking] ✅ Retrieved ${data.length} rows from cache with merged channels (SQL JOIN)`, {
            requestedChannels: validRequestedChannelsLower,
            actualChannels: actualChannels,
            missingInData: missingInData.length > 0 ? missingInData : 'none (all channels present)',
            channelsWithAllNulls: channelsWithAllNulls.length > 0 ? channelsWithAllNulls.slice(0, 5) : 'none'
          });
        } else {
          // Check if data exists in HuniDB but with different parameters
          // This helps diagnose why the query returned 0 rows
          try {
            // CRITICAL: Use normalizedSourceId to match what was used in the actual query
            const availableChannelsCheck = await huniDBStore.getAvailableChannels(
              className.toLowerCase(),
              datasetId,
              projectId,
              normalizedSourceId, // Use normalizedSourceId to match the query above
              queryDataTypes as ('mapdata' | 'timeseries' | 'aggregates')[]
            );
            
            // Check if requested channels actually exist in available channels
            const availableChannelsLower = new Set(availableChannelsCheck.map(ch => ch.toLowerCase()));
            const missingRequestedChannels = validRequestedChannelsLower.filter(ch => 
              !availableChannelsLower.has(ch.toLowerCase())
            );
            
            debug(`[fetchDataWithChannelChecking] ⚠️ Cache query returned 0 rows for ${validRequestedChannelsLower.length} requested channels`, {
              className,
              datasetId,
              projectId,
              sourceId: normalizedSourceId, // Use normalizedSourceId for consistency
              requestedChannels: validRequestedChannelsLower.slice(0, 10),
              availableChannelsInHuniDB: availableChannelsCheck.length,
              availableChannelsSample: availableChannelsCheck.slice(0, 10),
              missingRequestedChannels: missingRequestedChannels.length > 0 ? missingRequestedChannels : 'none (all requested channels exist)',
              hasNoDataAtAll,
              attemptedApiFetch: willAttemptFetch,
              note: availableChannelsCheck.length > 0 
                ? (missingRequestedChannels.length > 0
                  ? `Requested channels not found in available channels: ${missingRequestedChannels.join(', ')}`
                  : 'Data exists in HuniDB but query returned 0 rows - possible ID mismatch or no data rows for these channels')
                : 'No data found in HuniDB for these IDs'
            });
          } catch (checkError) {
            debug(`[fetchDataWithChannelChecking] ⚠️ Cache query returned 0 rows for ${validRequestedChannelsLower.length} requested channels`, {
              className,
              datasetId,
              projectId,
              sourceId: normalizedSourceId, // Use normalizedSourceId for consistency
              requestedChannels: validRequestedChannelsLower.slice(0, 10),
              hasNoDataAtAll,
              attemptedApiFetch: willAttemptFetch,
              checkError: (checkError as Error)?.message
            });
          }
        }
      } catch (queryError: unknown) {
        warn(`[fetchDataWithChannelChecking] Cache query failed:`, {
          error: (queryError as Error)?.message || String(queryError),
          className,
          datasetId,
          projectId,
          sourceId: String(sourceId)
        });
        data = [];
      }
      }
      
      // CRITICAL: Check in-memory cache (may have been updated by API fetch above)
      // This ensures we return the most recent data immediately after API fetch
      const updatedCacheEntry = dataCache.get(cacheKey);
      if (updatedCacheEntry && updatedCacheEntry.data && updatedCacheEntry.data.length > 0) {
        // Verify cache has all requested channels (same validation as at the start)
        const dataKeys = updatedCacheEntry.data[0] ? Object.keys(updatedCacheEntry.data[0]).map(k => k.toLowerCase()) : [];
        const _cachedChannels = updatedCacheEntry.channels || [];
        const hasAllChannels = requiredChannels.every(ch => {
          if (isMetadataChannelForCache(ch)) return true;
          return dataKeys.includes(ch.toLowerCase());
        });
        if (hasAllChannels) {
          return updatedCacheEntry.data;
        }
        // Overlay (e.g. FleetDataTable): return partial data so table can show what we have
        const hasTimeKey = dataKeys.some((k: string) => ['datetime', 'timestamp', 'ts'].includes(k));
        const requestedDataChannels = requiredChannels.filter(ch => !isMetadataChannelForCache(ch));
        const hasAtLeastOneDataChannel = requestedDataChannels.some(ch => dataKeys.includes(ch.toLowerCase()));
        if (chartType === 'overlay' && hasTimeKey && (hasAtLeastOneDataChannel || requestedDataChannels.length === 0)) {
          debug(`[fetchDataWithChannelChecking] Returning in-memory cache (overlay partial data, ${updatedCacheEntry.data.length} rows)`);
          return updatedCacheEntry.data;
        }
        const missingFromCache = requiredChannels.filter(ch => {
          if (isMetadataChannelForCache(ch)) return false;
          return !dataKeys.includes(ch.toLowerCase());
        });
        debug(`[fetchDataWithChannelChecking] In-memory cache exists but missing ${missingFromCache.length} requested channels`, { missingChannels: missingFromCache.slice(0, 5) });
      }
      
      // When HuniDB query returned 0 rows but we have API data in cache (e.g. just stored), return cache when possible
      if (data.length === 0) {
        const cacheFromApi = dataCache.get(cacheKey);
        if (cacheFromApi != null && cacheFromApi.data != null && cacheFromApi.data.length > 0) {
          const cacheDataKeys = cacheFromApi.data[0] ? Object.keys(cacheFromApi.data[0]).map((k: string) => k.toLowerCase()) : [];
          const cacheHasAllChannels = requiredChannels.every(ch => {
            if (isMetadataChannelForCache(ch)) return true;
            return cacheDataKeys.includes(ch.toLowerCase());
          });
          if (cacheHasAllChannels) {
            debug(`[fetchDataWithChannelChecking] Query returned 0 rows; returning ${cacheFromApi.data.length} rows from in-memory cache (API data)`);
            return cacheFromApi.data;
          }
          // Overlay (e.g. FleetDataTable) or timeseries: return partial data so table/charts can show what we have (missing channels show as — or empty series)
          const hasTimeKey = cacheDataKeys.some((k: string) => ['datetime', 'timestamp', 'ts'].includes(k));
          const requestedDataChannels = requiredChannels.filter(ch => !isMetadataChannelForCache(ch));
          const hasAtLeastOneDataChannel = requestedDataChannels.some(ch => cacheDataKeys.includes(ch.toLowerCase()));
          const allowPartialData = (chartType === 'overlay' || chartType === 'ts') && hasTimeKey && (hasAtLeastOneDataChannel || requestedDataChannels.length === 0);
          if (allowPartialData) {
            debug(`[fetchDataWithChannelChecking] Query returned 0 rows; returning ${cacheFromApi.data.length} rows from in-memory cache (${chartType} partial data)`);
            return cacheFromApi.data;
          }
          debug(`[fetchDataWithChannelChecking] Query returned 0 rows; cache has data but missing requested channels - not returning cache, will use API/merge path`);
        }
      }
      
      // Re-check available channels after potential API fetch (timeseries: skip HuniDB, use [])
      const finalAvailableChannels = resolvedDataSource === 'timeseries'
        ? []
        : await huniDBStore.getAvailableChannels(
            className.toLowerCase(),
            Number(datasetId),
            Number(projectId),
            Number(sourceId),
            queryDataTypes as ('mapdata' | 'timeseries' | 'aggregates')[]
          );
      
      // CRITICAL: Only return empty if we've exhausted all options
      // If hasNoDataAtAll is true, we should have attempted an API fetch above
      // Don't return empty here if we attempted fetch - the API might have returned no data (which is valid)
      if (finalAvailableChannels.length === 0 && data.length === 0) {
        // Check if we attempted an API fetch (hasNoDataAtAll would have triggered it)
        if (hasNoDataAtAll) {
          // Database was empty, we attempted fetch, but got no data - this is valid (data might not exist)
          info(`[fetchDataWithChannelChecking] Database was empty, attempted API fetch, but no data was returned for ${className}/${datasetId}/${projectId}/${sourceId}`);
        } else {
          // No fetch was attempted - channels may be marked as missing or other issue
          warn(`[fetchDataWithChannelChecking] No channels available and no data retrieved for ${className}/${datasetId}/${projectId}/${sourceId} (and no fetch was attempted - channels may be marked as missing)`);
        }
        return [];
      }
      
      // If query returned 0 rows but channels are available, log warning
      if (data.length === 0 && finalAvailableChannels.length > 0) {
        // Check if requested channels match available channels (case-insensitive)
        const _requestedChannelsLower = new Set(validRequestedChannels.map(ch => ch.toLowerCase()));
        const availableChannelsLower = new Set(finalAvailableChannels.map(ch => ch.toLowerCase()));
        const matchingChannels = validRequestedChannels.filter(ch => 
          availableChannelsLower.has(ch.toLowerCase())
        );
        const nonMatchingChannels = validRequestedChannels.filter(ch => 
          !availableChannelsLower.has(ch.toLowerCase())
        );
        
        debug(`[fetchDataWithChannelChecking] Query returned 0 rows despite ${finalAvailableChannels.length} available channels`, {
          className,
          datasetId,
          projectId,
          sourceId,
          requestedChannels: validRequestedChannels.slice(0, 10),
          availableChannels: finalAvailableChannels.slice(0, 10),
          matchingChannels: matchingChannels.slice(0, 10),
          nonMatchingChannels: nonMatchingChannels.slice(0, 10),
          hasTimeRange: !!timeRange,
          timeRange: timeRange ? {
            start: new Date(timeRange.start).toISOString(),
            end: new Date(timeRange.end).toISOString()
          } : undefined,
          hasFilters: !!filters,
          filters: filters ? {
            raceNumbers: filters.raceNumbers?.slice(0, 5),
            legNumbers: filters.legNumbers?.slice(0, 5),
            grades: filters.grades?.slice(0, 5),
            twaStates: filters.twaStates?.slice(0, 5),
            hasTimeRange: !!filters.timeRange
          } : undefined,
          dataSource: resolvedDataSource,
          queryDataTypes: queryDataTypes
        });
      }
      
      // CRITICAL: Sort data by timestamp before returning (required for map rendering)
      if (data && data.length > 0) {
        data = [...data].sort((a, b) => {
          const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
          const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
          return tsA - tsB;
        });
      }
      
        // Step 6: Load events for dataset into HuniDB (agg.events) whenever we have dataset data.
        // Previously this only ran for mapdata, so Scatter/TimeSeries etc. never populated agg.events,
        // breaking event start/end lookups and race options from dataset_events.
        if (data && data.length > 0) {
          try {
            const paramProjectId = typeof params?.projectId === 'number' ? params.projectId : persistantStore.selectedProjectId();
            const paramClassName = typeof params?.className === 'string' ? params.className : persistantStore.selectedClassName();
            const paramDatasetIdRaw = params?.datasetId;
            const chosenDatasetId = Number(paramDatasetIdRaw ?? persistantStore.selectedDatasetId());
            if (Number.isFinite(chosenDatasetId) && chosenDatasetId > 0) {
              debug('[UnifiedDataStore] Loading events for dataset...', { className: paramClassName, projectId: paramProjectId, datasetId: chosenDatasetId, dataSource: resolvedDataSource });
              await fetchEvents(paramClassName, paramProjectId, chosenDatasetId);
              debug('[UnifiedDataStore] Events loaded successfully');
            } else {
              debug('[UnifiedDataStore] Skipping events load: no valid datasetId');
            }
          } catch (eventsError) {
            debug('[UnifiedDataStore] Error loading events (non-critical):', eventsError);
            // Don't throw - events loading failure shouldn't break data loading
          }
        }
      
      // Step 7: Store in unifiedDataStore cache for next time (if we have data)
      if (data && data.length > 0) {
        dataCache.set(cacheKey, {
          data,
          timestamp: Date.now(),
          indexed: false
        });
      }
      
      // Step 8: Normalize data to remove duplicate case variations before returning
      const normalizedData = await normalizeDataFields(data, validRequestedChannels);
      
      // Step 9: Return normalized data to chart (already sorted by timestamp)
      return normalizedData;
      
    } catch (error) {
      logError(`[fetchDataWithChannelChecking] Error fetching data for ${chartType}:`, error);
      setError(chartType, (error as Error).message);
      throw error;
    }
  };

  /**
   * Fetch data with channel validation against FILE SERVER API
   * 
   * USE THIS FOR:
   * - Explore components that work with RAW FILE DATA (not aggregated database tables):
   *   * Scatter, Probability, TimeSeries, Parallel, PolarRose, Grid
   *   * Map, MapTimeSeries, MapContainer
   *   * Overlay
   * 
   * USE fetchDataWithChannelChecking() FOR:
   * - Performance components that work with AGGREGATE DATABASE TABLES
   * - Components querying events_aggregate or similar aggregate tables
   * 
   * This function:
   * 1. Validates requested channels against /api/file/channels (file server)
   * 2. Filters out channels not available in the file
   * 3. Proceeds with fetchDataWithChannelChecking using only valid file channels
   */
  
  /**
   * Verify a single channel exists in HuniDB and has data for the given IDs
   * Returns detailed information about the channel's status
   * Uses case-insensitive table lookup while preserving original channel case
   */
  const verifyChannelInHuniDB = async (
    className: string,
    datasetId: number,
    projectId: number,
    sourceId: number,
    channel: string,
    dataTypes: ('mapdata' | 'timeseries' | 'aggregates')[]
  ): Promise<{ exists: boolean; hasData: boolean; rowCount: number; tableName?: string }> => {
    try {
      const db = await huniDBStore.getDatabase(className.toLowerCase());
      
      // For timeseries, check ts.{channel} table (case-insensitive lookup)
      if (dataTypes.includes('timeseries')) {
        const tableNameRequested = `ts.${channel}`;
        
        // Find actual table name using case-insensitive lookup
        const tables = await db.query<{ name: string }>(
          `SELECT name FROM sqlite_master 
           WHERE type='table' AND LOWER(name) = LOWER(?)
           LIMIT 1`,
          [tableNameRequested]
        );
        
        if (!tables || tables.length === 0) {
          return { exists: false, hasData: false, rowCount: 0 };
        }
        
        const actualTableName = tables[0].name;
        
        // Check if table has data for these IDs
        const rowCount = await db.queryValue<number>(
          `SELECT COUNT(*) FROM ${escapeTableName(actualTableName)} WHERE dataset_id = ? AND project_id = ? AND source_id = ?`,
          [String(datasetId), String(projectId), String(sourceId)]
        ) || 0;
        
        return {
          exists: true,
          hasData: rowCount > 0,
          rowCount,
          tableName: actualTableName
        };
      }
      
      // map.data no longer cached in HuniDB; mapdata channels are not stored
      if (dataTypes.includes('mapdata')) {
        return { exists: false, hasData: false, rowCount: 0 };
      }

      return { exists: false, hasData: false, rowCount: 0 };
    } catch (error) {
      debug(`[verifyChannelInHuniDB] Error verifying channel ${channel}:`, error);
      return { exists: false, hasData: false, rowCount: 0 };
    }
  };
  
  const fetchDataWithChannelCheckingFromFile = async (
    chartType: ChartType,
    className: string,
    sourceId: string | number,
    requiredChannels: string[],
    params?: any,
    dataSource?: IndexedDBDataSource
  ): Promise<any[]> => {
    // CRITICAL: Log channels at entry point to verify they're in original case
    debug(`[fetchDataWithChannelCheckingFromFile] 🔍 ENTRY POINT - requiredChannels:`, {
      requiredChannels: requiredChannels,
      channelsCount: requiredChannels.length,
      sampleChannels: requiredChannels.slice(0, 10),
      caseCheck: requiredChannels.slice(0, 10).map(ch => ({
        channel: ch,
        hasUpperCase: /[A-Z]/.test(ch),
        isLowercase: ch === ch.toLowerCase()
      })),
      note: 'These channels should be in original case from chart objects. If lowercase here, they were lowercase when passed from TimeSeries component.'
    });
    setLastMissingChannels(chartType, []);

    // Extract datasetId and projectId from params or persistantStore
    const datasetId = Number(params?.datasetId || params?.dataset_id || persistantStore.selectedDatasetId() || 0);
    const projectId = Number(params?.projectId || params?.project_id || persistantStore.selectedProjectId?.() || 0);
    const normalizedSourceId = Number(sourceId || 0);
    const sourceName = params?.sourceName || params?.source_name;
    const date = params?.date;
    
    const resolvedDataSource = dataSource || getDataSourceForChart(chartType);
    
    // Variables to track channel verification results (used when test query fails)
    // Declare at function scope so they're accessible throughout the entire function
    let channelsFoundInHuniDB: string[] = [];
    let channelsMissingFromHuniDB: string[] = [];
    let huniDBData: any[] = []; // Store partial data from HuniDB when some channels are missing
    const dataTypes = resolvedDataSource === 'objects' ? ['timeseries'] : [resolvedDataSource]; // Declare at function scope
    let skipVerification = false; // Flag to skip verification when HuniDB is empty
    
    // FAST PATH FOR MAPDATA: Skip all channel discovery, go directly to HuniDB or API
    // Mapdata uses different tables and never comes from InfluxDB
    if (resolvedDataSource === 'mapdata') {
      info(`[fetchDataWithChannelCheckingFromFile] 🗺️ MAPDATA FAST PATH: Skipping channel discovery, checking HuniDB mapdata tables directly`);
      
      // Map must never use grade/TWA-filtered cache: use separate cache key when applyGlobalFilters is false
      const mapdataNoFilters = params?.applyGlobalFilters === false;
      const cacheKey = `${chartType}_${className}_${sourceId}_${datasetId}_${projectId}${mapdataNoFilters ? '_nofilters' : ''}`;
      const cachedEntry = dataCache.get(cacheKey);
      if (cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
        debug(`[fetchDataWithChannelCheckingFromFile] ✅ Using in-memory cache for mapdata`);
        return cachedEntry.data;
      }
      
      // Timeseries/mapdata no longer cached in HuniDB - fetch directly from file API
      debug(`[fetchDataWithChannelCheckingFromFile] Fetching mapdata from file API`);
      // Not in HuniDB, fetch directly from file API (skip all channel discovery)
      setProgress(chartType, className, normalizedSourceId, 50, 'Fetching mapdata from file server...');
      return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), requiredChannels, params, 'mapdata');
    }
    
    // Set initial progress
    setProgress(chartType, className, normalizedSourceId, 10, 'Initializing data fetch...');
    
    // Step 1: Check in-memory cache first, but verify channels actually exist in data
    // Include objectName/page so different scatter pages ('takeoffs' vs 'tws bsp') never share cache
    const channelsHash = hashChannelsForCache(requiredChannels);
    const objectNamePart = normalizeObjectNameForCache(params?.objectName ?? params?.object_name ?? params?.page);
    const cacheKey = `${chartType}_${className}_${sourceId}_${datasetId}_${projectId}${objectNamePart ? `_${objectNamePart}` : ''}_${channelsHash}`;
    const cachedEntry = dataCache.get(cacheKey);
    if (cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
      const cachedChannels = cachedEntry.channels || [];
      // CRITICAL: Check if channels actually exist in the data, not just in the channels list
      // The channels list might be incomplete if data was cached before all channels were fetched
      const dataKeys = cachedEntry.data[0] ? Object.keys(cachedEntry.data[0]).map(k => k.toLowerCase()) : [];
      const hasAllChannels = requiredChannels.every(ch => {
        if (isMetadataChannelForCache(ch)) return true;
        const chLower = ch.toLowerCase();
        // Must exist in actual data keys, not just in cachedChannels list
        return dataKeys.includes(chLower);
      });
      
      if (hasAllChannels) {
        debug(`[fetchDataWithChannelCheckingFromFile] Using in-memory cache (has all ${requiredChannels.length} requested channels)`, {
          requestedChannels: requiredChannels,
          dataKeys: dataKeys.slice(0, 10),
          cachedChannels: cachedChannels.slice(0, 10)
        });
        return cachedEntry.data;
      } else {
        // Cache exists but missing channels - check which ones are missing
        const missingFromCache = requiredChannels.filter(ch => {
          if (isMetadataChannelForCache(ch)) return false;
          const chLower = ch.toLowerCase();
          return !dataKeys.includes(chLower);
        });
        debug(`[fetchDataWithChannelCheckingFromFile] In-memory cache missing ${missingFromCache.length} channels - will fetch from HuniDB/API`);
      }
    }
    
    // Step 2: No HuniDB data cache - always fetch from API
    debug(`[fetchDataWithChannelCheckingFromFile] Will fetch from API (no HuniDB data cache)`, {
      chartType,
      className,
      sourceId: normalizedSourceId,
      datasetId,
      projectId,
      dataSource: resolvedDataSource
    });

    channelsFoundInHuniDB = [];
    channelsMissingFromHuniDB = requiredChannels;
    // Timeseries: API + in-memory only. Skip all HuniDB channel checks; proceed to API fetch below.
    if (resolvedDataSource !== 'timeseries') {
    try {
      // Check what channels are available in HuniDB (mapdata/aggregates only)
      // Note: dataTypes is already declared at function scope
      debug(`[fetchDataWithChannelCheckingFromFile] Querying HuniDB for available channels...`, {
        className: className.toLowerCase(),
        datasetId,
        projectId,
        sourceId: normalizedSourceId,
        dataTypes: dataTypes.join(', ')
      });
      const availableChannels = await huniDBStore.getAvailableChannels(
        className.toLowerCase(), 
        datasetId,
        projectId,
        normalizedSourceId, 
        dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[]
      );
      
      debug(`[fetchDataWithChannelCheckingFromFile] HuniDB has ${availableChannels.length} available channels`, {
        availableChannels: availableChannels.slice(0, 10),
        totalAvailable: availableChannels.length,
        datasetId,
        projectId,
        sourceId: normalizedSourceId
      });
      
      // CRITICAL: When getAvailableChannels returns empty, try to actually query data from HuniDB
      // before giving up - getAvailableChannels might miss data due to ID mismatches or meta.channels issues
      // But the actual data tables might still have the data
      if (availableChannels.length === 0) {
        debug(`[fetchDataWithChannelCheckingFromFile] getAvailableChannels returned 0 channels for dataset ${datasetId}/project ${projectId}/source ${normalizedSourceId}. Verifying with direct data query...`);
        
        // Try to query data directly from HuniDB - this is more reliable than getAvailableChannels
        // because it actually queries the data tables, not just meta.channels
        try {
          // Filter out metadata channels for the test query
          const testChannels = requiredChannels.filter(ch => {
            const chLower = ch.toLowerCase();
            return chLower !== 'datetime' && chLower !== 'timestamp' && 
                   chLower !== 'source_id' && chLower !== 'source_name' &&
                   chLower !== 'config' && chLower !== 'state';
          }).slice(0, 3); // Only test with first 3 non-metadata channels
          
          if (testChannels.length > 0) {
            const testData = await huniDBStore.queryDataByChannels(
              className.toLowerCase(),
              datasetId,
              projectId,
              normalizedSourceId,
              testChannels,
              dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
              undefined, // No time range
              undefined // No filters
            );
            
            if (testData && testData.length > 0) {
              info(`[fetchDataWithChannelCheckingFromFile] ✅ Found ${testData.length} rows in HuniDB but meta.channels is out of sync. Auto-rebuilding meta.channels...`, {
                testChannels: testChannels,
                dataRows: testData.length,
                queriedIds: { datasetId, projectId, sourceId: normalizedSourceId }
              });
              
              // Automatically rebuild meta.channels to fix the sync issue
              // This ensures future queries use the fast path
              try {
                await huniDBStore.rebuildMetaChannels(
                  className.toLowerCase(),
                  datasetId,
                  projectId,
                  normalizedSourceId
                );
                info(`[fetchDataWithChannelCheckingFromFile] ✅ Auto-rebuilt meta.channels - future queries will use fast path`);
              } catch (rebuildError) {
                warn(`[fetchDataWithChannelCheckingFromFile] Failed to auto-rebuild meta.channels (non-fatal, will continue):`, rebuildError);
                // Continue with normal logic - don't fail the query
              }
              
              // Data exists! Don't skip verification - proceed with normal logic
              // This will use two-phase check which might find the channels
            } else {
              debug(`[fetchDataWithChannelCheckingFromFile] Direct data query returned 0 rows; HuniDB empty for these IDs - will fetch from API`, {
                testChannels: testChannels,
                queriedIds: { datasetId, projectId, sourceId: normalizedSourceId },
                note: 'This could mean: 1) Data hasn\'t been stored yet, 2) Data was stored with different IDs, 3) Data was stored in different class database'
              });
              // No data found - proceed to API fetch
              channelsFoundInHuniDB = [];
              channelsMissingFromHuniDB = requiredChannels;
              skipVerification = true;
            }
          } else {
            // No test channels available - proceed to API fetch
            channelsFoundInHuniDB = [];
            channelsMissingFromHuniDB = requiredChannels;
            skipVerification = true;
          }
        } catch (queryError: unknown) {
          // Query failed - might be mobile device or other error
          if ((queryError as Error)?.message?.includes('mobile devices')) {
            debug(`[fetchDataWithChannelCheckingFromFile] HuniDB not available on mobile - will use API fallback`);
          } else {
            warn(`[fetchDataWithChannelCheckingFromFile] Error querying HuniDB directly:`, queryError);
          }
          // On error, assume empty and proceed to API fetch
          channelsFoundInHuniDB = [];
          channelsMissingFromHuniDB = requiredChannels;
          skipVerification = true;
        }
        
        if (skipVerification) {
          debug(`[fetchDataWithChannelCheckingFromFile] HuniDB empty - fetching all ${requiredChannels.length} channels from API`);
        }
      }
      
      // Skip verification logic if HuniDB is empty - go directly to API fetch
      if (!skipVerification) {
        // Filter out metadata channels from requested channels for comparison
      const METADATA_CHANNELS = new Set([
        'Datetime', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename',
        'Grade', 'grade', 'GRADE', 'Mainsail_code', 'mainsail_code',
        'TACK', 'tack', 'event_id',
        'Config', 'config', 'State', 'state', 'STATE', 'Foiling_state', 'foiling_state', 'FOILING_STATE'
      ]);
      
      // Case-insensitive comparison helper
      const _channelsMatchCaseInsensitive = (ch1: string, ch2: string): boolean => {
        return ch1.toLowerCase() === ch2.toLowerCase();
      };
      
      // Create case-insensitive set for metadata channel checking
      const metadataChannelsLower = new Set(Array.from(METADATA_CHANNELS).map(ch => ch.toLowerCase()));
      const _requestedChannelsLower = new Set(requiredChannels.map(ch => ch.toLowerCase()));
      
      const isMetadataChannel = (ch: string): boolean => {
        if (!ch || typeof ch !== 'string') return true;
        const chLower = ch.toLowerCase().trim();
        if (chLower.length === 0) return true;
        // If Race_number, Leg_number, Grade, or State are explicitly requested, they are data channels, not metadata
        if (chLower === 'race_number' || chLower === 'leg_number' || chLower === 'grade' || chLower === 'state') {
          return !_requestedChannelsLower.has(chLower);
        }
        return metadataChannelsLower.has(chLower) ||
               chLower === 'foiling_state' ||
               chLower.endsWith('_code') ||
               (chLower.endsWith('_number') && !_requestedChannelsLower.has(chLower)) ||
               chLower === 'grade' ||
               chLower === 'config' ||
               chLower === 'state';
      };
      const validRequestedChannels = Array.from(new Set(
        requiredChannels.filter(ch => !isMetadataChannel(ch))
      ));
      
      // CRITICAL: Normalize channel names to original case from HuniDB
      // Chart objects may have lowercase channel names (e.g., "Cur_dir_est_deg", "Cur_rate_est_kts")
      // but HuniDB stores them in original case (e.g., "Cur_dir_est_deg", "Cur_rate_est_kts")
      // Normalize to original case before checking meta.channels to ensure proper matching
      const availableChannelsMap = new Map<string, string>();
      availableChannels.forEach(ch => {
        availableChannelsMap.set(ch.toLowerCase(), ch); // Map lowercase -> original case
      });
      
      // Normalize requested channels to original case from HuniDB
      const normalizedRequestedChannels = validRequestedChannels.map(ch => {
        const originalCase = availableChannelsMap.get(ch.toLowerCase());
        return originalCase || ch; // Use original case if found, otherwise keep as-is
      });
      
      // Log normalization if any channels were normalized (case changed)
      const normalizedChannels = validRequestedChannels.filter((ch, idx) => 
        ch !== normalizedRequestedChannels[idx]
      );
      if (normalizedChannels.length > 0) {
        debug(`[fetchDataWithChannelCheckingFromFile] Normalized ${normalizedChannels.length} channel names to original case from HuniDB:`, 
          normalizedChannels.map((ch) => {
            const origIdx = validRequestedChannels.indexOf(ch);
            return `${ch} → ${normalizedRequestedChannels[origIdx]}`;
          })
        );
      }
      
      // Keep channels in original case - use case-insensitive comparisons for matching
      // Create a case-insensitive array for quick lookups (needed for .slice() and other array methods)
      const validRequestedChannelsLower = Array.from(new Set(
        normalizedRequestedChannels.map(ch => ch.toLowerCase())
      ));
      
      debug(`[fetchDataWithChannelCheckingFromFile] Filtered to ${normalizedRequestedChannels.length} valid requested channels (excluding metadata)`, {
        requestedChannels: requiredChannels,
        validRequestedChannels: validRequestedChannels,
        normalizedRequestedChannels: normalizedRequestedChannels,
        validRequestedChannelsLower: validRequestedChannelsLower,
        metadataChannels: requiredChannels.filter(ch => isMetadataChannel(ch))
      });
      
      // CRITICAL: Use meta.channels as the source of truth - check which channels actually exist
      // This is much faster and more reliable than comparing with getAvailableChannels results
      // Use normalizedRequestedChannels (original case) for checking meta.channels
      debug(`[fetchDataWithChannelCheckingFromFile] 🔍 Checking meta.channels for ${normalizedRequestedChannels.length} channels with IDs:`, {
        className: className.toLowerCase(),
        datasetId,
        projectId,
        sourceId: normalizedSourceId,
        requestedChannels: validRequestedChannels.slice(0, 10),
        availableChannelsFromGetAvailable: availableChannels.slice(0, 10),
        note: 'If channels exist in HuniDB but aren\'t found, check: 1) ID mismatch, 2) Case mismatch (should be case-insensitive), 3) meta.channels not populated'
      });
      
      // Two-phase check: Phase 1 checks meta.channels, Phase 2 verifies ts. table has non-null data
      const channelCheck = await huniDBStore.checkChannelsWithDataValidation(
        className.toLowerCase(),
        datasetId,
        projectId,
        normalizedSourceId,
        normalizedRequestedChannels, // Use normalized (original case) channels
        resolvedDataSource === 'timeseries' ? 'timeseries' : (resolvedDataSource as string) === 'mapdata' || resolvedDataSource === 'objects' ? 'mapdata' : 'aggregates'
      );
      
      // Only channels with actual data are considered "found"
      // Channels found in meta but without data are treated as missing (will fetch from API)
      channelsFoundInHuniDB = channelCheck.foundWithData;
      channelsMissingFromHuniDB = [...channelCheck.foundWithoutData, ...channelCheck.missing];
      
      // CRITICAL: Log detailed comparison to diagnose why channels aren't found
      if (channelsMissingFromHuniDB.length > 0) {
        info(`[fetchDataWithChannelCheckingFromFile] ⚠️ Two-phase check results:`, {
          foundWithData: channelCheck.foundWithData.length,
          foundWithoutData: channelCheck.foundWithoutData.length,
          missing: channelCheck.missing.length,
          missingChannels: channelsMissingFromHuniDB.slice(0, 10),
          foundChannels: channelsFoundInHuniDB.slice(0, 10),
          foundWithoutDataChannels: channelCheck.foundWithoutData.slice(0, 10),
          requestedChannels: validRequestedChannels.slice(0, 10),
          availableChannelsFromGetAvailable: availableChannels.slice(0, 10),
          queriedIds: {
            className: className.toLowerCase(),
            datasetId,
            projectId,
            sourceId: normalizedSourceId
          },
          note: 'Channels in foundWithoutData exist in meta.channels but have no non-null data in ts. table - will be fetched from API'
        });
      }
      
      // CRITICAL: If HuniDB is empty (no channels found), ensure all requested channels are marked as missing
      // This ensures API fetch happens when starting fresh
      if (channelsFoundInHuniDB.length === 0 && channelsMissingFromHuniDB.length === 0 && normalizedRequestedChannels.length > 0) {
        debug(`[fetchDataWithChannelCheckingFromFile] HuniDB empty (two-phase check) - treating all ${normalizedRequestedChannels.length} channels as missing, will fetch from API`, {
          validRequestedChannels: validRequestedChannels.slice(0, 10),
          normalizedRequestedChannels: normalizedRequestedChannels.slice(0, 10),
          datasetId,
          projectId,
          sourceId: normalizedSourceId,
          note: 'This should trigger API fetch and storage when HuniDB is empty'
        });
        channelsMissingFromHuniDB = [...normalizedRequestedChannels]; // Mark all as missing (use normalized)
      }
      
      // CRITICAL: Also check if availableChannels is empty - this is another indicator that HuniDB is empty
      // Double-check to ensure we don't miss the empty state
      if (availableChannels.length === 0 && channelsFoundInHuniDB.length === 0 && channelsMissingFromHuniDB.length === 0 && normalizedRequestedChannels.length > 0) {
        debug(`[fetchDataWithChannelCheckingFromFile] HuniDB empty (double check) - forcing all ${normalizedRequestedChannels.length} channels as missing`, {
          validRequestedChannels: validRequestedChannels.slice(0, 10),
          normalizedRequestedChannels: normalizedRequestedChannels.slice(0, 10),
          datasetId,
          projectId,
          sourceId: normalizedSourceId
        });
        channelsMissingFromHuniDB = [...normalizedRequestedChannels]; // Mark all as missing (use normalized)
      }
      
      const allChannelsAvailable = channelsMissingFromHuniDB.length === 0;
      
      info(`[fetchDataWithChannelCheckingFromFile] Two-phase check complete: ${channelsFoundInHuniDB.length} found with data, ${channelsMissingFromHuniDB.length} missing (${channelCheck.foundWithoutData.length} exist in meta but have no data)`, {
        found: channelsFoundInHuniDB.slice(0, 5),
        missing: channelsMissingFromHuniDB.slice(0, 5),
        foundWithoutData: channelCheck.foundWithoutData.slice(0, 5),
        totalRequested: validRequestedChannels.length
      });
      
      if (allChannelsAvailable && channelsFoundInHuniDB.length > 0) {
        info(`[fetchDataWithChannelCheckingFromFile] ✅ All ${validRequestedChannels.length} requested channels found in HuniDB cache (via meta.channels)`, {
          foundChannels: channelsFoundInHuniDB.length,
          requestedChannels: validRequestedChannels.length,
          missingChannels: []
        });
        
          // Verify data actually exists by doing a quick test query
          try {
            // Prioritize actual data channels over filter channels for test query
            // Filter channels (race_number, leg_number, twa_deg for filtering) should not be used for test query
            // as they may exist but the actual chart data channels might not
            // Also exclude channels that queryDataByChannels filters out for timeseries queries:
            // ['Datetime', 'timestamp', 'Race_number', 'Leg_number', 'Grade']
            const filterChannelPatterns = [
              'race_number', 'leg_number', 'twa_deg', 'grade', 'state', 'config',
              'datetime', 'timestamp' // These get filtered out in timeseries queries
            ];
            // Use original case channels, filter case-insensitively
            const dataChannelsForTest = validRequestedChannels.filter(ch => {
              const chLower = ch.toLowerCase();
              return !filterChannelPatterns.some(pattern => chLower === pattern.toLowerCase());
            });
            
            // Use actual data channels if available, otherwise fall back to first 3
            const testChannels = dataChannelsForTest.length > 0 
              ? dataChannelsForTest.slice(0, Math.min(3, dataChannelsForTest.length))
              : validRequestedChannels.filter(ch => {
                  // If no data channels found, still exclude the ones that definitely get filtered
                  const chLower = ch.toLowerCase();
                  return !['datetime', 'timestamp', 'race_number', 'leg_number', 'grade'].includes(chLower);
                }).slice(0, Math.min(3, validRequestedChannels.length));
            
            if (testChannels.length === 0) {
              warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ No valid test channels after filtering - all channels are metadata or filter channels. Using first available channel anyway.`, {
                validRequestedChannels,
                dataChannelsForTest,
                note: 'This may cause the test query to fail if all channels are metadata'
              });
              // Last resort: use first channel even if it might be filtered
              if (validRequestedChannels.length > 0) {
                testChannels.push(validRequestedChannels[0]);
              }
            }
            
            info(`[fetchDataWithChannelCheckingFromFile] Running test query with ${testChannels.length} channels to verify data exists...`, {
              testChannels,
              allValidChannels: validRequestedChannels,
              dataChannelsForTest: dataChannelsForTest.length > 0 ? dataChannelsForTest : 'none (using all channels)',
              className: className.toLowerCase(),
              datasetId,
              projectId,
              sourceId: normalizedSourceId,
              dataTypes: dataTypes.join(', '),
              datasetIdType: typeof datasetId,
              projectIdType: typeof projectId,
              sourceIdType: typeof normalizedSourceId,
              note: 'Test query prioritizes actual data channels over filter channels. IDs will be converted to strings in WHERE clause - verify they match stored data'
            });
            
            // Add diagnostic: check what tables exist for these channels and what IDs are stored
            // Check both test channels and all requested channels to see the full picture
            try {
              const db = await huniDBStore.getDatabase(className.toLowerCase());
              const channelsToCheck = [...new Set([...testChannels, ...validRequestedChannels.slice(0, 10)])]; // Check test channels + first 10 requested
              const tableChecks = await Promise.all(channelsToCheck.map(async (ch) => {
                const tableNameRequested = `ts.${ch}`;
                // Use case-insensitive lookup
                const tables = await db.query<{ name: string }>(
                  `SELECT name FROM sqlite_master 
                   WHERE type='table' AND LOWER(name) = LOWER(?)
                   LIMIT 1`,
                  [tableNameRequested]
                );
                
                if (tables && tables.length > 0) {
                  const actualTableName = tables[0].name;
                  // Check if table has data for these IDs
                  const rowCount = await db.queryValue<number>(
                    `SELECT COUNT(*) FROM ${escapeTableName(actualTableName)} WHERE dataset_id = ? AND project_id = ? AND source_id = ?`,
                    [String(datasetId), String(projectId), String(normalizedSourceId)]
                  );
                  // Also check what IDs actually exist in the table (sample)
                  const sampleIds = await db.query<{ dataset_id: string; project_id: string; source_id: string }>(
                    `SELECT DISTINCT dataset_id, project_id, source_id FROM ${escapeTableName(actualTableName)} LIMIT 5`
                  );
                  // Get total row count for this table
                  const totalRows = await db.queryValue<number>(
                    `SELECT COUNT(*) FROM ${escapeTableName(actualTableName)}`
                  );
                  return {
                    channel: ch,
                    tableName: actualTableName,
                    exists: true,
                    rowCountForQueryIds: rowCount || 0,
                    totalRowsInTable: totalRows || 0,
                    sampleIds: sampleIds || [],
                    queryIds: { datasetId: String(datasetId), projectId: String(projectId), sourceId: String(normalizedSourceId) }
                  };
                }
                return { channel: ch, tableName: tableNameRequested, exists: false };
              }));
              
              const missingTables = tableChecks.filter(tc => !tc.exists);
              const tablesWithNoData = tableChecks.filter(tc => tc.exists && (tc.rowCountForQueryIds ?? 0) === 0);
              const tablesWithData = tableChecks.filter(tc => tc.exists && (tc.rowCountForQueryIds ?? 0) > 0);
              
              // Log detailed diagnostic information
              const conclusion = missingTables.length > 0
                ? `❌ ${missingTables.length} channel table(s) do not exist: ${missingTables.map(tc => tc.channel).join(', ')}`
                : tablesWithNoData.length > 0
                ? `⚠️ ${tablesWithNoData.length} table(s) exist but no data matches query IDs - likely ID mismatch: ${tablesWithNoData.map(tc => tc.channel).join(', ')}`
                : `✅ All checked tables exist and have matching data (${tablesWithData.length} tables)`;
              
              warn(`[fetchDataWithChannelCheckingFromFile] 🔍 DIAGNOSTIC: ${conclusion}`);
              info(`[fetchDataWithChannelCheckingFromFile] Diagnostic details:`, {
                testChannels,
                totalChecked: tableChecks.length,
                tablesExist: tablesWithData.length + tablesWithNoData.length,
                tablesWithData: tablesWithData.length,
                tablesWithNoData: tablesWithNoData.length,
                missingTables: missingTables.length,
                queryIds: { datasetId: String(datasetId), projectId: String(projectId), sourceId: String(normalizedSourceId) }
              });
              
              // Log detailed info for each channel
              tableChecks.forEach(tc => {
                if (!tc.exists) {
                  warn(`[fetchDataWithChannelCheckingFromFile] ❌ Table ${tc.tableName} does NOT exist for channel ${tc.channel}`);
                } else if (tc.rowCountForQueryIds === 0) {
                  warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ Table ${tc.tableName} exists with ${tc.totalRowsInTable} total rows, but 0 rows match query IDs`, {
                    channel: tc.channel,
                    queryIds: tc.queryIds,
                    sampleIdsInTable: tc.sampleIds?.slice(0, 3) || []
                  });
                } else {
                  info(`[fetchDataWithChannelCheckingFromFile] ✅ Table ${tc.tableName} exists with ${tc.rowCountForQueryIds} rows matching query IDs`);
                }
              });
            } catch (diagError) {
              debug(`[fetchDataWithChannelCheckingFromFile] Error in diagnostic check:`, diagError);
            }
            
            // Log what we're about to query
            info(`[fetchDataWithChannelCheckingFromFile] About to run test query with channels:`, {
              testChannels,
              testChannelsCount: testChannels.length,
              note: 'queryDataByChannels will filter out metadata channels - some test channels may be excluded'
            });
            
            const testQuery = await huniDBStore.queryDataByChannels(
              className.toLowerCase(),
              datasetId,
              projectId,
              normalizedSourceId,
              testChannels,
              dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
              undefined // No filters (use undefined, not {})
            );
          
          // Check what channels were actually returned in the query results
          const returnedChannels = testQuery && testQuery.length > 0 
            ? Object.keys(testQuery[0]).filter(k => {
                const kLower = k.toLowerCase();
                return !['timestamp', 'datetime', 'source_id', 'source_name', 'sourcename', 
                        'dataset_id', 'project_id', 'event_id'].includes(kLower);
              })
            : [];
          
          info(`[fetchDataWithChannelCheckingFromFile] Test query completed: ${testQuery?.length || 0} rows returned`, {
            testChannelsRequested: testChannels,
            channelsReturned: returnedChannels,
            rowCount: testQuery?.length || 0,
            sampleRow: testQuery && testQuery.length > 0 ? Object.keys(testQuery[0]) : [],
            queryParams: {
              className: className.toLowerCase(),
              datasetId,
              projectId,
              sourceId: normalizedSourceId,
              dataTypes: dataTypes.join(', ')
            },
            availableChannelsFromScan: availableChannels.slice(0, 10),
            note: testQuery?.length === 0 
              ? `Test query returned 0 rows. Requested ${testChannels.length} channels: ${testChannels.join(', ')}. This may be because: 1) Channels were filtered as metadata, 2) ID mismatch, or 3) Channel name mismatch.`
              : `Query successful - returned ${returnedChannels.length} data channels: ${returnedChannels.join(', ')}`
          });
          
          if (testQuery && testQuery.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] ✅ Test query successful - found ${testQuery.length} rows. Using direct data check (full query) to determine which channels are present...`);
            
            // CRITICAL: Use actual data keys from a full query, not getAvailableChannels (meta.channels).
            // meta.channels is for channel picker only; fetch path must use direct data presence.
            setProgress(chartType, className, normalizedSourceId, 20, 'Verifying channels in HuniDB...');
            let fullQueryData: any[] = [];
            try {
              fullQueryData = await huniDBStore.queryDataByChannels(
                className.toLowerCase(),
                datasetId,
                projectId,
                normalizedSourceId,
                validRequestedChannels,
                dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
                params?.timeRange,
                params?.filters
              );
            } catch (fullQueryErr) {
              warn(`[fetchDataWithChannelCheckingFromFile] Full query for direct data check failed:`, fullQueryErr);
            }
            const actualChannelsFromData = fullQueryData?.length > 0 && fullQueryData[0]
              ? Object.keys(fullQueryData[0]).filter(k => {
                  const kLower = k.toLowerCase();
                  return !['timestamp', 'datetime', 'source_id', 'source_name', 'sourcename', 'dataset_id', 'project_id', 'event_id'].includes(kLower);
                })
              : [];
            const actualChannelsLower = new Set(actualChannelsFromData.map(ch => ch.toLowerCase()));
            const missingChannelsFromTest = normalizedRequestedChannels.filter(ch => !actualChannelsLower.has(ch.toLowerCase()));
            channelsFoundInHuniDB = normalizedRequestedChannels.filter(ch => actualChannelsLower.has(ch.toLowerCase()));
            channelsMissingFromHuniDB = missingChannelsFromTest;
            
            if (missingChannelsFromTest.length > 0) {
              info(`[fetchDataWithChannelCheckingFromFile] ⚠️ Direct data check: ${missingChannelsFromTest.length} channels missing from HuniDB. Will query found channels from HuniDB and fetch missing from API.`, {
                testQueryRows: testQuery.length,
                actualChannelsFromData: actualChannelsFromData.length,
                missingChannels: missingChannelsFromTest.slice(0, 10),
                totalMissing: missingChannelsFromTest.length,
                totalRequested: normalizedRequestedChannels.length
              });
              // Continue to API fallback section to fetch missing channels
            } else if (fullQueryData && fullQueryData.length > 0) {
              // All channels present in data - use the full query result from direct data check (no second query)
              info(`[fetchDataWithChannelCheckingFromFile] ✅ All ${validRequestedChannels.length} requested channels found in HuniDB (via direct data check).`);
              let data = await normalizeDataFields(fullQueryData, validRequestedChannels);
              if (data && data.length > 0) {
                const cacheChannels = data[0] ? Object.keys(data[0]) : [];
                dataCache.set(cacheKey, {
                  data,
                  timestamp: Date.now(),
                  indexed: false,
                  channels: cacheChannels
                });
                info(`[fetchDataWithChannelCheckingFromFile] ✅ CACHE HIT: Retrieved ${data.length} rows from HuniDB cache - NO API CALL NEEDED`, {
                  dataRows: data.length,
                  channels: validRequestedChannels.length,
                  cacheKey
                });
                return data;
              }
              warn(`[fetchDataWithChannelCheckingFromFile] Direct data check returned data but normalize produced empty - will check file server/InfluxDB`, {
                fullQueryRows: fullQueryData.length
              });
            }
          } else {
            // Test query returned 0 rows - verify each channel individually
            warn(`[fetchDataWithChannelCheckingFromFile] ❌ Test query returned 0 rows - verifying each channel individually...`, {
              testChannels,
              testQueryRows: testQuery?.length || 0,
              availableChannelsCount: availableChannels.length,
              queryParams: {
                className: className.toLowerCase(),
                datasetId: String(datasetId),
                projectId: String(projectId),
                sourceId: String(normalizedSourceId),
                dataTypes: dataTypes.join(', ')
              }
            });
            
            // Verify each requested channel individually to determine which ones actually exist
            info(`[fetchDataWithChannelCheckingFromFile] 🔍 Verifying ${validRequestedChannels.length} channels individually in HuniDB...`);
            const channelVerifications = await Promise.all(
              validRequestedChannels.map(async (ch) => {
                const verification = await verifyChannelInHuniDB(
                  className.toLowerCase(),
                  datasetId,
                  projectId,
                  normalizedSourceId,
                  ch,
                  dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[]
                );
                return {
                  channel: ch,
                  ...verification
                };
              })
            );
            
            // Separate channels into found vs missing (update outer scope variables)
            channelsFoundInHuniDB = channelVerifications
              .filter(v => v.exists && v.hasData)
              .map(v => v.channel);
            
            channelsMissingFromHuniDB = channelVerifications
              .filter(v => !v.exists || !v.hasData)
              .map(v => v.channel);
            
            info(`[fetchDataWithChannelCheckingFromFile] Channel verification complete:`, {
              totalChecked: channelVerifications.length,
              foundInHuniDB: channelsFoundInHuniDB.length,
              missingFromHuniDB: channelsMissingFromHuniDB.length,
              foundChannels: channelsFoundInHuniDB.slice(0, 10),
              missingChannels: channelsMissingFromHuniDB.slice(0, 10)
            });
            
            // Log detailed results for each channel
            channelVerifications.forEach(v => {
              if (!v.exists) {
                debug(`[fetchDataWithChannelCheckingFromFile] ❌ Channel ${v.channel}: Table does not exist`);
              } else if (!v.hasData) {
                warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ Channel ${v.channel}: Table exists (${v.tableName}) but has 0 rows for query IDs`);
              } else {
                info(`[fetchDataWithChannelCheckingFromFile] ✅ Channel ${v.channel}: Exists with ${v.rowCount} rows`);
              }
            });
            
            // If we found some channels in HuniDB, query them and fetch missing ones from API
            if (channelsFoundInHuniDB.length > 0) {
              info(`[fetchDataWithChannelCheckingFromFile] Found ${channelsFoundInHuniDB.length} channels in HuniDB, ${channelsMissingFromHuniDB.length} missing - will query HuniDB for found channels and fetch missing from API`);
              // Store these lists for use in API fallback section
              // We'll handle this in the API fallback section below
            } else {
              warn(`[fetchDataWithChannelCheckingFromFile] ❌ No channels found in HuniDB - all ${channelsMissingFromHuniDB.length} channels will be fetched from API`);
            }
            
            // Continue to API fallback - we'll use the channel lists there
          }
        } catch (queryError: any) {
          // Handle mobile device error or other query errors
          if (queryError?.message?.includes('mobile devices')) {
            info(`[fetchDataWithChannelCheckingFromFile] HuniDB not available on mobile - will check file server/InfluxDB`);
          } else {
            warn(`[fetchDataWithChannelCheckingFromFile] ❌ Error querying HuniDB cache - will fall back to file server/InfluxDB:`, {
              error: (queryError as Error)?.message || String(queryError),
              stack: (queryError as Error)?.stack,
              className,
              datasetId,
              projectId,
              sourceId: normalizedSourceId,
              requiredChannels: requiredChannels?.slice(0, 5)
            });
          }
          // Continue to file server/InfluxDB check
        }
      } else {
        // Some channels are missing from HuniDB
        // CRITICAL: Two-phase check categorizes channels as:
        // - foundWithData: Exist in meta.channels AND have non-null data in ts. table (use from cache)
        // - foundWithoutData: Exist in meta.channels BUT have no non-null data (fetch from API)
        // - missing: Don't exist in meta.channels (fetch from API)
        if (channelsMissingFromHuniDB.length > 0) {
          info(`[fetchDataWithChannelCheckingFromFile] ⚠️ ${channelsMissingFromHuniDB.length} channels are missing from HuniDB (via two-phase check).`, {
            missingChannels: channelsMissingFromHuniDB.slice(0, 10),
            foundChannels: channelsFoundInHuniDB.slice(0, 10),
            totalMissing: channelsMissingFromHuniDB.length,
            totalFound: channelsFoundInHuniDB.length
          });
          
          // If we have some channels found, query HuniDB for those first, then fetch missing from API
          if (channelsFoundInHuniDB.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] Will query ${channelsFoundInHuniDB.length} found channels from HuniDB, then fetch ${channelsMissingFromHuniDB.length} missing channels from API.`);
            // Continue to query HuniDB for found channels, then API for missing
          } else {
            // All channels are missing - skip HuniDB query, go directly to API
            info(`[fetchDataWithChannelCheckingFromFile] ⚠️ All ${validRequestedChannels.length} requested channels are missing from HuniDB. Skipping HuniDB query and going directly to API fetch.`);
            // Continue to API fallback section - channelsMissingFromHuniDB is already set correctly
            // Skip the HuniDB query attempt below
          }
        }
        
        // Even if not all channels are found in availability check (or no channels found at all),
        // try querying HuniDB directly. The availability check might be incomplete:
        // - meta.channels might be empty (slow table scan might have missed data)
        // - Case mismatches in channel names
        // - Data might exist but channel discovery failed
        // CRITICAL: Only query HuniDB if we have some channels found, otherwise skip to API
        if (channelsFoundInHuniDB.length === 0 && channelsMissingFromHuniDB.length > 0) {
          // All channels are missing - skip HuniDB query, go directly to API
          info(`[fetchDataWithChannelCheckingFromFile] ⚠️ Skipping HuniDB query - all channels are missing. Proceeding directly to API fetch.`);
          // Continue to API fallback section - don't query HuniDB
        } else if (channelsMissingFromHuniDB.length > 0 && channelsFoundInHuniDB.length > 0) {
          // Some channels found, some missing - query HuniDB for found channels, then fetch missing from API
          info(`[fetchDataWithChannelCheckingFromFile] Querying HuniDB for ${channelsFoundInHuniDB.length} found channels, will fetch ${channelsMissingFromHuniDB.length} missing from API.`);
          
          try {
            setProgress(chartType, className, normalizedSourceId, 20, 'Querying HuniDB for found channels...');
            
            // Query HuniDB only for channels that were found
            const data = await huniDBStore.queryDataByChannels(
              className.toLowerCase(),
              typeof datasetId === 'number' ? datasetId : Number(datasetId),
              typeof projectId === 'number' ? projectId : Number(projectId),
              normalizedSourceId,
              channelsFoundInHuniDB, // Only query found channels
              dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
              params?.timeRange,
              params?.filters
            );
            
            if (data && data.length > 0) {
              // Store the partial data we got from HuniDB
              huniDBData = data;
              info(`[fetchDataWithChannelCheckingFromFile] ✅ Retrieved ${data.length} rows from HuniDB for ${channelsFoundInHuniDB.length} found channels. Will fetch ${channelsMissingFromHuniDB.length} missing channels from API.`);
              // Continue to API fallback section to fetch missing channels
            } else {
              debug(`[fetchDataWithChannelCheckingFromFile] HuniDB query returned no data for found channels - fetching all from API`);
              // Mark all as missing to fetch everything from API
              channelsMissingFromHuniDB = [...channelsFoundInHuniDB, ...channelsMissingFromHuniDB];
              channelsFoundInHuniDB = [];
            }
          } catch (error) {
            warn(`[fetchDataWithChannelCheckingFromFile] Error querying HuniDB for found channels:`, error);
            // Mark all as missing to fetch everything from API
            channelsMissingFromHuniDB = [...channelsFoundInHuniDB, ...channelsMissingFromHuniDB];
            channelsFoundInHuniDB = [];
          }
        } else {
          // No missing channels reported or unclear state - try querying HuniDB directly
          // This handles cases where the two-phase check might have missed something
          if (availableChannels.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] ⚠️ Not all channels found in availability check, but ${availableChannels.length} channels exist. Trying direct query from HuniDB...`, {
              availableChannels: availableChannels.length,
              requestedChannels: validRequestedChannels.length,
              missingChannels: channelsMissingFromHuniDB.slice(0, 10),
              totalMissing: channelsMissingFromHuniDB.length
            });
          } else {
            info(`[fetchDataWithChannelCheckingFromFile] ⚠️ No channels found in availability check, but attempting direct HuniDB query anyway (availability check may be incomplete)...`, {
              requestedChannels: validRequestedChannels.length,
              className: className.toLowerCase(),
              datasetId,
              projectId,
              sourceId: normalizedSourceId,
              note: 'Availability check might have failed due to empty meta.channels or slow table scan issues'
            });
          }
          
          try {
            setProgress(chartType, className, normalizedSourceId, 20, 'Querying HuniDB...');
            
            // Try querying with all requested channels (original case)
            // queryDataByChannels handles case-insensitive table lookup
            // HuniDB will return what it has, even if some channels don't exist
            
            debug(`[fetchDataWithChannelCheckingFromFile] Attempting direct HuniDB query with parameters:`, {
              className: className.toLowerCase(),
              datasetId: typeof datasetId === 'number' ? datasetId : Number(datasetId),
              projectId: typeof projectId === 'number' ? projectId : Number(projectId),
              sourceId: normalizedSourceId,
              channels: normalizedRequestedChannels.slice(0, 5),
              totalChannels: normalizedRequestedChannels.length,
              dataTypes: dataTypes.join(', ')
            });
            
            // CRITICAL: Use numbers (not strings) and normalizedSourceId consistently
            // Use normalized (original case) channels - queryDataByChannels handles case-insensitive lookup
            let data = await huniDBStore.queryDataByChannels(
              className.toLowerCase(),
              typeof datasetId === 'number' ? datasetId : Number(datasetId), // Ensure number type
              typeof projectId === 'number' ? projectId : Number(projectId), // Ensure number type
              normalizedSourceId, // Use normalizedSourceId, not sourceId
              normalizedRequestedChannels, // Use normalized (original case from HuniDB)
              dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
              params?.timeRange,
              params?.filters
            );
            
            // Normalize data from HuniDB to remove duplicate case variations
            if (data && data.length > 0) {
              data = await normalizeDataFields(data, normalizedRequestedChannels);
            }
            
            if (data && data.length > 0) {
            // Check if we got the essential channels (at least some data channels, not just metadata)
            const dataChannels = data[0] ? Object.keys(data[0]).filter(k => {
              const kLower = k.toLowerCase();
              return !['timestamp', 'datetime', 'source_id', 'source_name', 'sourcename', 
                       'dataset_id', 'project_id', 'event_id'].includes(kLower);
            }) : [];
            
            if (dataChannels.length > 0) {
              // CRITICAL: Check if we actually got ALL requested channels
              // queryDataByChannels may return data even if some channels are missing
              const returnedChannelsLower = new Set(dataChannels.map(ch => ch.toLowerCase()));
              const missingChannelsInData = validRequestedChannels.filter(ch => {
                const chLower = ch.toLowerCase();
                return !returnedChannelsLower.has(chLower) && 
                       !['datetime', 'timestamp', 'race_number', 'leg_number', 'grade'].includes(chLower);
              });
              
              if (missingChannelsInData.length > 0) {
                // Some channels are missing from the returned data - need to fetch from API
                info(`[fetchDataWithChannelCheckingFromFile] ⚠️ HuniDB query returned data but ${missingChannelsInData.length} channels are missing. Will fetch missing channels from API.`, {
                  dataRows: data.length,
                  returnedChannels: dataChannels.length,
                  missingChannels: missingChannelsInData.slice(0, 10),
                  totalMissing: missingChannelsInData.length,
                  totalRequested: validRequestedChannels.length
                });
                
                // Set channelsFoundInHuniDB and channelsMissingFromHuniDB for API fallback
                channelsFoundInHuniDB = validRequestedChannels.filter(ch => {
                  const chLower = ch.toLowerCase();
                  return returnedChannelsLower.has(chLower) || 
                         ['datetime', 'timestamp', 'race_number', 'leg_number', 'grade'].includes(chLower);
                });
                channelsMissingFromHuniDB = missingChannelsInData;
                
                // Store the partial data we got from HuniDB
                huniDBData = data;
                
                // Continue to API fallback section to fetch missing channels
              } else {
                // All channels are present in the returned data
                // Update in-memory cache for future use; store only channels actually present in data
                const actualChannelsFromData = data[0] ? Object.keys(data[0]) : [];
                dataCache.set(cacheKey, {
                  data,
                  timestamp: Date.now(),
                  indexed: false,
                  channels: actualChannelsFromData
                });
                
                info(`[fetchDataWithChannelCheckingFromFile] ✅ HUNIDB QUERY SUCCESS: Retrieved ${data.length} rows with ${dataChannels.length} data channels - NO API CALL NEEDED`, {
                  dataRows: data.length,
                  dataChannels: dataChannels.slice(0, 5),
                  requestedChannels: validRequestedChannels.length,
                  missingFromAvailability: channelsMissingFromHuniDB.length,
                  note: availableChannels.length === 0 
                    ? 'Direct query succeeded despite availability check finding no channels - availability check was incomplete'
                    : 'Some channels were missing from availability check but data was found via direct query'
                });
                setProgress(chartType, className, normalizedSourceId, 100, 'Complete');
                return data;
              }
            } else {
              warn(`[fetchDataWithChannelCheckingFromFile] HuniDB query returned only metadata, no data channels - will check API`);
              // Mark all requested channels as missing to trigger API fetch
              channelsFoundInHuniDB = [];
              channelsMissingFromHuniDB = validRequestedChannels;
            }
          } else {
            warn(`[fetchDataWithChannelCheckingFromFile] HuniDB direct query returned no data - verifying channels individually...`, {
              queryParams: {
                className: className.toLowerCase(),
                datasetId: typeof datasetId === 'number' ? datasetId : Number(datasetId),
                projectId: typeof projectId === 'number' ? projectId : Number(projectId),
                sourceId: normalizedSourceId,
                channels: requiredChannels.slice(0, 5),
                dataTypes: dataTypes.join(', ')
              },
              availableChannelsFromCheck: availableChannels.length,
              note: 'Verifying each channel individually to determine which ones exist'
            });
            
            // Verify each requested channel individually
            info(`[fetchDataWithChannelCheckingFromFile] 🔍 Verifying ${validRequestedChannelsLower.length} channels individually in HuniDB...`);
            const channelVerifications = await Promise.all(
              validRequestedChannelsLower.map(async (ch) => {
                const verification = await verifyChannelInHuniDB(
                  className.toLowerCase(),
                  datasetId,
                  projectId,
                  normalizedSourceId,
                  ch,
                  dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[]
                );
                return {
                  channel: ch,
                  ...verification
                };
              })
            );
            
            // Separate channels into found vs missing
            channelsFoundInHuniDB = channelVerifications
              .filter(v => v.exists && v.hasData)
              .map(v => v.channel);
            
            channelsMissingFromHuniDB = channelVerifications
              .filter(v => !v.exists || !v.hasData)
              .map(v => v.channel);
            
            info(`[fetchDataWithChannelCheckingFromFile] Channel verification complete:`, {
              totalChecked: channelVerifications.length,
              foundInHuniDB: channelsFoundInHuniDB.length,
              missingFromHuniDB: channelsMissingFromHuniDB.length,
              foundChannels: channelsFoundInHuniDB.slice(0, 10),
              missingChannels: channelsMissingFromHuniDB.slice(0, 10)
            });
            
            // Log detailed results
            channelVerifications.forEach(v => {
              if (!v.exists) {
                debug(`[fetchDataWithChannelCheckingFromFile] ❌ Channel ${v.channel}: Table does not exist`);
              } else if (!v.hasData) {
                warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ Channel ${v.channel}: Table exists (${v.tableName}) but has 0 rows for query IDs`);
              } else {
                info(`[fetchDataWithChannelCheckingFromFile] ✅ Channel ${v.channel}: Exists with ${v.rowCount} rows`);
              }
            });
          }
        } catch (queryError: any) {
          // Handle mobile device error or other query errors
          if (queryError?.message?.includes('mobile devices')) {
            info(`[fetchDataWithChannelCheckingFromFile] HuniDB not available on mobile - will check file server/InfluxDB`);
          } else {
            warn(`[fetchDataWithChannelCheckingFromFile] Error querying HuniDB directly - will fall back to file server/InfluxDB:`, {
              error: queryError?.message || String(queryError),
              stack: queryError?.stack,
              queryParams: {
                className: className.toLowerCase(),
                datasetId: typeof datasetId === 'number' ? datasetId : Number(datasetId),
                projectId: typeof projectId === 'number' ? projectId : Number(projectId),
                sourceId: normalizedSourceId
              }
            });
          }
          // Continue to file server/InfluxDB check
        }
        
        info(`[fetchDataWithChannelCheckingFromFile] Proceeding to query from API (file server/InfluxDB)...`);
        } // End of else block (unclear state - tried direct query)
      } // End of else block (when allChannelsAvailable is false)
      } // End of if (!skipVerification) block
      
      // If skipVerification was true, we should have channelsMissingFromHuniDB set to requiredChannels
      if (skipVerification) {
        info(`[fetchDataWithChannelCheckingFromFile] ✅ Skipped verification - proceeding directly to API fetch with ${channelsMissingFromHuniDB.length} channels`, {
          channelsMissingFromHuniDB: channelsMissingFromHuniDB.slice(0, 10),
          channelsFoundInHuniDB: channelsFoundInHuniDB.length
        });
        
        // CRITICAL: When HuniDB is empty, skip all file server discovery and go directly to API
        // This ensures we fetch data immediately without waiting for channel discovery
        setProgress(chartType, className, normalizedSourceId, 50, 'Fetching data from API...');
        
        // Get date and sourceName if not provided
        let resolvedDate = date;
        let resolvedSourceName = sourceName;
        
        // Always normalize date format to YYYYMMDD (remove dashes/slashes)
        if (resolvedDate) {
          resolvedDate = String(resolvedDate).replace(/[-/]/g, '');
        }
        
        if (!resolvedDate || !resolvedSourceName) {
          try {
            if (!resolvedSourceName && sourceId != null && Number(sourceId) !== 0) {
              resolvedSourceName = await sourcesStore.getSourceName(Number(sourceId));
            }
            
            if (!resolvedDate) {
              const datasetInfoResponse = await fetchData(
                `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`
              );
              if (datasetInfoResponse?.success && datasetInfoResponse.data?.date) {
                resolvedDate = datasetInfoResponse.data.date.replace(/[-/]/g, '');
              }
            }
          } catch (e) {
            debug(`[fetchDataWithChannelCheckingFromFile] Could not get date/sourceName:`, e);
          }
        }
        
        if (!resolvedDate || !resolvedSourceName) {
          warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ Missing date or sourceName - cannot fetch from API. Date: ${resolvedDate}, sourceName: ${resolvedSourceName}`);
          // Still try to call API with what we have - it might work
        }
        
        // Directly call fetchDataWithChannelChecking with all required channels
        const finalParams = {
          ...params,
          sourceName: resolvedSourceName || params?.sourceName || params?.source_name,
          date: resolvedDate || params?.date,
          data_source: 'file'
        };
        
        debug(`[fetchDataWithChannelCheckingFromFile] HuniDB empty - fetching ${channelsMissingFromHuniDB.length} channels from API`);
        
        const apiData = await fetchDataWithChannelChecking(
          chartType,
          className,
          String(normalizedSourceId),
          channelsMissingFromHuniDB, // Use all required channels since HuniDB is empty
          finalParams,
          dataSource
        );
        
        if (apiData && apiData.length > 0) {
          // Cache the result; store only channels actually present in data (not requested list)
          const actualChannelsFromData = apiData[0] ? Object.keys(apiData[0]) : [];
          dataCache.set(cacheKey, {
            data: apiData,
            timestamp: Date.now(),
            indexed: false,
            channels: actualChannelsFromData
          });
          
          setProgress(chartType, className, normalizedSourceId, 100, 'Complete');
          return apiData;
        } else {
          setLastMissingChannels(chartType, requiredChannels);
          return [];
        }
      }
    } catch (hunidbError: any) {
      debug(`[fetchDataWithChannelCheckingFromFile] HuniDB check failed, falling back to API:`, hunidbError?.message || String(hunidbError));
    }
    }
    
    try {
      // Check if we have partial data from HuniDB (some channels found, some missing)
      // Note: huniDBData is already declared at function scope
      if (channelsFoundInHuniDB.length > 0 && channelsMissingFromHuniDB.length > 0) {
        info(`[fetchDataWithChannelCheckingFromFile] 🔄 Partial data in HuniDB: ${channelsFoundInHuniDB.length} channels found, ${channelsMissingFromHuniDB.length} missing. Querying HuniDB for found channels, then fetching missing from API...`);
        
          try {
          setProgress(chartType, className, normalizedSourceId, 25, 'Retrieving partial data from HuniDB...');
          // Query HuniDB for channels that we know exist (use original case)
          huniDBData = await huniDBStore.queryDataByChannels(
            className.toLowerCase(),
            datasetId,
            projectId,
            normalizedSourceId,
            channelsFoundInHuniDB, // Use original case - queryDataByChannels handles case-insensitive lookup
            dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
            params?.timeRange,
            params?.filters
          );
          
          // Normalize data from HuniDB to remove duplicate case variations
          if (huniDBData && huniDBData.length > 0) {
            huniDBData = await normalizeDataFields(huniDBData, channelsFoundInHuniDB);
          }
          
          if (huniDBData && huniDBData.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] ✅ Retrieved ${huniDBData.length} rows from HuniDB for ${channelsFoundInHuniDB.length} channels`);
          } else {
            warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ HuniDB query returned 0 rows for channels that were verified - will fetch all from API`);
            huniDBData = [];
            // If HuniDB query failed, treat all channels as missing
            channelsMissingFromHuniDB = [...channelsFoundInHuniDB, ...channelsMissingFromHuniDB];
            channelsFoundInHuniDB = [];
          }
        } catch (huniDBError) {
          warn(`[fetchDataWithChannelCheckingFromFile] Error querying HuniDB for found channels:`, huniDBError);
          // If HuniDB query failed, treat all channels as missing
          channelsMissingFromHuniDB = [...channelsFoundInHuniDB, ...channelsMissingFromHuniDB];
          channelsFoundInHuniDB = [];
          huniDBData = [];
        }
        // If we got data from HuniDB (partial), return it immediately - no API call. Tags supply Grade, State, Twa_deg, etc.
        if (huniDBData.length > 0) {
          const sampleRecord = huniDBData[0];
          const rowKeys = Object.keys(sampleRecord);
          const tagKeysPartial = (() => {
            const t = sampleRecord.tags;
            if (!t) return [] as string[];
            if (typeof t === 'string') {
              try {
                return Object.keys(JSON.parse(t) as Record<string, unknown>);
              } catch {
                return [] as string[];
              }
            }
            return Object.keys(t as Record<string, unknown>);
          })();
          const availableLower = new Set([...rowKeys, ...tagKeysPartial].map((ch: string) => ch.toLowerCase()));
          const missingCritical = getMissingCriticalChannelsForRendering(requiredChannels, availableLower);
          if (missingCritical.length === 0) {
            setProgress(chartType, className, normalizedSourceId, 100, 'Complete');
            info(`[fetchDataWithChannelCheckingFromFile] ✅ Returning ${huniDBData.length} rows from HuniDB - NO API CALL (tags supply metadata)`);
            return await normalizeDataFields(huniDBData, requiredChannels);
          }
        }
      } else if (channelsFoundInHuniDB.length > 0 && channelsMissingFromHuniDB.length === 0) {
        // All channels found in HuniDB - this shouldn't happen here, but handle it
        info(`[fetchDataWithChannelCheckingFromFile] ✅ All channels found in HuniDB - querying...`);
        try {
          // Use original case channels
          huniDBData = await huniDBStore.queryDataByChannels(
            className.toLowerCase(),
            datasetId,
            projectId,
            normalizedSourceId,
            channelsFoundInHuniDB, // Use original case
            dataTypes as ('mapdata' | 'timeseries' | 'aggregates')[],
            params?.timeRange,
            params?.filters
          );
          
          // Normalize data from HuniDB to remove duplicate case variations
          if (huniDBData && huniDBData.length > 0) {
            huniDBData = await normalizeDataFields(huniDBData, channelsFoundInHuniDB);
          }
          
          if (huniDBData && huniDBData.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] ✅ Retrieved ${huniDBData.length} rows from HuniDB - NO API CALL NEEDED`);
            return huniDBData;
          }
        } catch (error) {
          warn(`[fetchDataWithChannelCheckingFromFile] Error querying HuniDB:`, error);
        }
      }
      
      // If we have channels missing from HuniDB, fetch them from API
      // Initialize channelsToFetchFromAPI - will be used in API fallback section
      let channelsToFetchFromAPI: string[] = [];
      if (channelsMissingFromHuniDB.length > 0) {
        channelsToFetchFromAPI = channelsMissingFromHuniDB;
        debug(`[fetchDataWithChannelCheckingFromFile] 🔍 CHANNELS MISSING FROM HUNIDB (will fetch from API):`, {
          channelsMissingFromHuniDB: channelsMissingFromHuniDB,
          channelsToFetchFromAPI: channelsToFetchFromAPI,
          caseCheck: channelsToFetchFromAPI.slice(0, 10).map(ch => ({
            channel: ch,
            hasUpperCase: /[A-Z]/.test(ch),
            isLowercase: ch === ch.toLowerCase()
          })),
          note: 'These should be in original case from two-phase check. If lowercase here, the check is returning lowercase.'
        });
        info(`[fetchDataWithChannelCheckingFromFile] 📋 Will fetch ${channelsToFetchFromAPI.length} missing channels from API:`, {
          missingChannels: channelsToFetchFromAPI.slice(0, 10),
          totalMissing: channelsToFetchFromAPI.length,
          foundInHuniDB: channelsFoundInHuniDB.length,
          requestedChannels: requiredChannels.slice(0, 10)
        });
      } else if (channelsFoundInHuniDB.length === 0) {
        // No verification was done or all channels are missing - fetch all required channels
        // CRITICAL: This handles the case when HuniDB is empty (fresh start)
        channelsToFetchFromAPI = requiredChannels;
        warn(`[fetchDataWithChannelCheckingFromFile] 🔍 ALL CHANNELS MISSING (HuniDB empty) - will fetch all:`, {
          channelsToFetchFromAPI: channelsToFetchFromAPI,
          caseCheck: channelsToFetchFromAPI.slice(0, 10).map(ch => ({
            channel: ch,
            hasUpperCase: /[A-Z]/.test(ch),
            isLowercase: ch === ch.toLowerCase()
          })),
          note: 'These should be in original case from requiredChannels. If lowercase here, requiredChannels were lowercase.'
        });
        info(`[fetchDataWithChannelCheckingFromFile] 📋 No channel verification done or all missing - will fetch all ${channelsToFetchFromAPI.length} required channels from API`, {
          requiredChannels: requiredChannels.slice(0, 10),
          channelsFoundInHuniDB: channelsFoundInHuniDB.length,
          channelsMissingFromHuniDB: channelsMissingFromHuniDB.length,
          note: 'This should trigger API fetch and storage when HuniDB is empty'
        });
      } else {
        // All channels found in HuniDB - shouldn't reach here, but handle it
        info(`[fetchDataWithChannelCheckingFromFile] ✅ All channels found in HuniDB - no API fetch needed`);
        channelsToFetchFromAPI = [];
      }
      
      // CRITICAL: Log if we're about to skip API fetch when we should fetch
      if (channelsToFetchFromAPI.length === 0 && channelsFoundInHuniDB.length === 0 && requiredChannels.length > 0) {
        warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ CRITICAL: No channels to fetch but HuniDB is empty! This will prevent storage.`, {
          requiredChannels: requiredChannels.slice(0, 10),
          channelsFoundInHuniDB: channelsFoundInHuniDB.length,
          channelsMissingFromHuniDB: channelsMissingFromHuniDB.length,
          channelsToFetchFromAPI: channelsToFetchFromAPI.length,
          note: 'Forcing fetch of all required channels to ensure storage happens'
        });
        // Force fetch all required channels if HuniDB is empty
        channelsToFetchFromAPI = requiredChannels;
      }
      
      info(`[fetchDataWithChannelCheckingFromFile] 🔄 Querying from API - checking file server channels...`, {
        channelsToFetchFromAPI: channelsToFetchFromAPI.length,
        channelsFromHuniDB: channelsFoundInHuniDB.length,
        huniDBDataRows: huniDBData.length
      });
      
      // Get date and sourceName if not provided
      let resolvedDate = date;
      let resolvedSourceName = sourceName;
      
      // Always normalize date format to YYYYMMDD (remove dashes/slashes)
      if (resolvedDate) {
        resolvedDate = String(resolvedDate).replace(/[-/]/g, '');
      }
      
      if (!resolvedDate || !resolvedSourceName) {
        try {
          if (!resolvedSourceName && sourceId != null && Number(sourceId) !== 0) {
            resolvedSourceName = await sourcesStore.getSourceName(Number(sourceId));
          }
          
          if (!resolvedDate) {
            const datasetInfoResponse = await fetchData(
              `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`
            );
            if (datasetInfoResponse?.success && datasetInfoResponse.data?.date) {
              resolvedDate = datasetInfoResponse.data.date.replace(/[-/]/g, '');
            }
          }
        } catch (e) {
          debug(`[fetchDataWithChannelCheckingFromFile] Could not get date/sourceName:`, e);
        }
      }
      
      if (!resolvedDate || !resolvedSourceName) {
        warn(`[fetchDataWithChannelCheckingFromFile] Missing date or sourceName, cannot check file channels`);
        // If we have HuniDB data, return it; otherwise fall back to regular fetch
        if (huniDBData.length > 0) {
          warn(`[fetchDataWithChannelCheckingFromFile] Returning partial data from HuniDB (${huniDBData.length} rows) - missing date/sourceName prevents API fetch`);
          return huniDBData;
        }
        return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), channelsToFetchFromAPI.length > 0 ? channelsToFetchFromAPI : requiredChannels, { ...params, data_source: 'auto' }, dataSource);
      }
      
      // Step 2: Check available channels from FILE (parquet) only - use file server directly
      // CRITICAL: Use file server's get-available-channels with data_source=file so we get ONLY
      // channels that exist in parquet files. If we used discoverChannels('FILE') we'd get the
      // app's /datasets/channels which can return a different/merged list and then we never call Influx.
      setProgress(chartType, className, normalizedSourceId, 30, 'Checking channel availability...');
      info(`[fetchDataWithChannelCheckingFromFile] Checking FILE (parquet) channels from file server`, {
        className,
        projectId,
        date: resolvedDate,
        sourceName: resolvedSourceName
      });
      
      let availableChannels: string[] = [];
      try {
        const fileChannelsUrl = `${apiEndpoints.file.channels}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(resolvedDate)}&source_name=${encodeURIComponent(resolvedSourceName)}&data_source=file`;
        const fileChannelsResponse = await fetchData(fileChannelsUrl);
        if (fileChannelsResponse?.success && Array.isArray(fileChannelsResponse.data)) {
          availableChannels = fileChannelsResponse.data;
          info(`[fetchDataWithChannelCheckingFromFile] Found ${availableChannels.length} channels from file server (parquet only, data_source=file)`);
        } else {
          debug(`[fetchDataWithChannelCheckingFromFile] File server returned no FILE channels (404 or empty), will try Influx for missing`);
        }
      } catch (error) {
        warn(`[fetchDataWithChannelCheckingFromFile] Could not get FILE channels from file server, falling back:`, error);
        // If we have HuniDB data, return it; otherwise try Influx then fall back
        if (huniDBData.length > 0) {
          warn(`[fetchDataWithChannelCheckingFromFile] Returning partial data from HuniDB (${huniDBData.length} rows) - channel discovery failed`);
          return huniDBData;
        }
        // When FILE discovery fails (e.g. no parquet folder), try Influx so backend can download and save to parquet
        const fallbackChannels = resolvedDataSource === 'timeseries' ? requiredChannels : (channelsToFetchFromAPI.length > 0 ? channelsToFetchFromAPI : requiredChannels);
        try {
          const influxChannels = await discoverChannels(resolvedDate, resolvedSourceName, 'INFLUX', false);
          const requestedLower = new Set(fallbackChannels.map((ch: string) => ch.toLowerCase()));
          const overlap = influxChannels.filter((ch: string) => requestedLower.has(ch.toLowerCase()));
          // Influx only: channels that exist in Influx and are NOT metadata
          const influxOnlyChannels = overlap.filter((ch: string) => !isMetadataChannelForInflux(ch));
          if (influxOnlyChannels.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] FILE discovery failed but found ${influxOnlyChannels.length} data channels in Influx - fetching from INFLUX (will save to parquet):`, influxOnlyChannels.slice(0, 5));
            return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), influxOnlyChannels, { ...params, data_source: 'influx' }, dataSource);
          }
        } catch (influxErr) {
          debug(`[fetchDataWithChannelCheckingFromFile] Influx discovery fallback failed:`, influxErr);
        }
        return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), fallbackChannels, params, dataSource);
      }
      
      if (availableChannels.length === 0) {
        warn(`[fetchDataWithChannelCheckingFromFile] No channels discovered from FILE, trying Influx...`);
        // If we have HuniDB data, return it; otherwise try Influx so backend can download and save to parquet
        if (huniDBData.length > 0) {
          warn(`[fetchDataWithChannelCheckingFromFile] Returning partial data from HuniDB (${huniDBData.length} rows) - no channels discovered`);
          return huniDBData;
        }
        const fallbackChannels = resolvedDataSource === 'timeseries' ? requiredChannels : (channelsToFetchFromAPI.length > 0 ? channelsToFetchFromAPI : requiredChannels);
        try {
          const influxChannels = await discoverChannels(resolvedDate, resolvedSourceName, 'INFLUX', false);
          const requestedLower = new Set(fallbackChannels.map((ch: string) => ch.toLowerCase()));
          const overlap = influxChannels.filter((ch: string) => requestedLower.has(ch.toLowerCase()));
          // Influx only: channels that exist in Influx and are NOT metadata
          const influxOnlyChannels = overlap.filter((ch: string) => !isMetadataChannelForInflux(ch));
          if (influxOnlyChannels.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] No FILE channels but found ${influxOnlyChannels.length} data channels in Influx - fetching from INFLUX (will save to parquet):`, influxOnlyChannels.slice(0, 5));
            return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), influxOnlyChannels, { ...params, data_source: 'influx' }, dataSource);
          }
        } catch (influxErr) {
          debug(`[fetchDataWithChannelCheckingFromFile] Influx discovery fallback failed:`, influxErr);
        }
        return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), fallbackChannels, params, dataSource);
      }
      
      // Step 3: Filter metadata channels and find missing channels (same logic as regular function)
      // CRITICAL: For timeseries data, Race_number and Leg_number can be actual data channels
      // Only treat them as metadata if they're NOT explicitly requested
      // IMPORTANT: If we have channelsToFetchFromAPI (from HuniDB verification), use those instead of all requiredChannels
      const channelsForFileCheck = channelsToFetchFromAPI.length > 0 && channelsToFetchFromAPI.length < requiredChannels.length
        ? channelsToFetchFromAPI // Only check/fetch channels that are missing from HuniDB
        : requiredChannels; // Fallback: check all required channels
      
      const METADATA_CHANNELS = new Set([
        'Datetime', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename',
        'Grade', 'grade', 'GRADE', 'Mainsail_code', 'mainsail_code',
        'TACK', 'tack', 'event_id',
        'Config', 'config', 'State', 'state', 'STATE', 'Foiling_state', 'foiling_state', 'FOILING_STATE'
      ]);
      
      // Create a set of requested channels (case-insensitive) for quick lookup
      const requestedChannelsLower = new Set(channelsForFileCheck.map(ch => ch.toLowerCase()));
      
      const isMetadataChannel = (ch: string): boolean => {
        if (!ch || typeof ch !== 'string') return true;
        const chLower = ch.toLowerCase().trim();
        if (chLower.length === 0) return true;
        
        // State and Grade are always metadata (derived fields, not in FILE discovery)
        // They should never be checked against FILE discovery or INFLUX
        if (chLower === 'state' || chLower === 'grade') {
          return true;
        }
        
        // If Race_number or Leg_number are explicitly requested, they might be data channels
        // (they can exist in files, but are often metadata)
        if (chLower === 'race_number' || chLower === 'leg_number') {
          return !requestedChannelsLower.has(chLower);
        }
        
        return METADATA_CHANNELS.has(ch) || 
               METADATA_CHANNELS.has(chLower) ||
               chLower.endsWith('_code') ||
               (chLower.endsWith('_number') && !requestedChannelsLower.has(chLower)) ||
               chLower === 'config' ||
               chLower === 'foiling_state';
      };
      
      // Helper: channels that exist in the request but have no valid data in the response (missing key or all null/empty)
      const getChannelsWithNoData = (data: any[], channels: string[], isMetadata: (ch: string) => boolean): string[] => {
        if (!data?.length) return channels.filter(ch => !isMetadata(ch));
        const result: string[] = [];
        for (const ch of channels) {
          if (isMetadata(ch)) continue;
          const chLower = ch.toLowerCase();
          const hasData = data.some((record: any) => {
            const key = Object.keys(record).find((k: string) => k.toLowerCase() === chLower);
            if (!key) return false;
            const v = record[key];
            return v != null && v !== '';
          });
          if (!hasData) result.push(ch);
        }
        return result;
      };
      
      const validRequestedChannels = Array.from(new Set(
        requiredChannels.filter(ch => !isMetadataChannel(ch))
      ));
      
      // CRITICAL: Build mapping from lowercase to original case from discovery
      // This ensures we can map requested channels to their original case from discovery
      const availableChannelsCaseMap = new Map<string, string>();
      availableChannels.forEach(ch => {
        availableChannelsCaseMap.set(ch.toLowerCase(), ch);
      });
      
      // Use case-insensitive comparison for checking availability
      const availableChannelsLower = new Set(availableChannels.map(ch => ch.toLowerCase()));
      const missingChannels = validRequestedChannels.filter(ch => !availableChannelsLower.has(ch.toLowerCase()));
      
      // CRITICAL: Log to verify availableChannels from discovery have correct case
      debug(`[fetchDataWithChannelCheckingFromFile] 🔍 AVAILABLE CHANNELS FROM DISCOVERY:`, {
        availableChannels: availableChannels.slice(0, 10),
        availableChannelsCount: availableChannels.length,
        caseCheck: availableChannels.slice(0, 10).map(ch => ({
          channel: ch,
          hasUpperCase: /[A-Z]/.test(ch),
          isLowercase: ch === ch.toLowerCase()
        })),
        note: 'These channels come from discoverChannels API. If lowercase here, the discovery API returns lowercase.'
      });
      
      info(`[fetchDataWithChannelCheckingFromFile] Channel check results:`, {
        available: availableChannels.length,
        requested: validRequestedChannels.length,
        missing: missingChannels.length,
        missingChannels: missingChannels.slice(0, 5)
      });

      debug('availableChannels', availableChannels);
      
      // Step 4: Determine which channels to fetch from FILE
      // In fleet/day context include source_name so API returns it for filtering by source.
      const filterContextForChannels = determineFilterContext();
      const requiredWithFleet = (filterContextForChannels === 'fleet' || filterContextForChannels === 'day') && !requiredChannels.some(ch => ch.toLowerCase() === 'source_name')
        ? [...requiredChannels, 'source_name']
        : requiredChannels;
      // CRITICAL (timeseries): The channel-values API returns one row per timestamp with ONLY the requested columns.
      // If we request only "missing" channels (e.g. metadata: Twa_deg, Grade, Race_number, Leg_number), we get
      // no Bsp_kph/RH_lwd_mm in the response, so storeTimeSeriesData filters everything as metadata and stores nothing.
      // For timeseries we must always request ALL required channels so the API returns full rows (data + metadata).
      const isTimeseries = resolvedDataSource === 'timeseries';
      const channelsForFileFetch = isTimeseries
        ? requiredWithFleet // Always fetch all required so API returns full rows with Bsp_kph, RH_lwd_mm, etc.
        : (channelsToFetchFromAPI.length > 0 && channelsToFetchFromAPI.length < requiredWithFleet.length
            ? channelsToFetchFromAPI
            : requiredWithFleet);
      
      info(`[fetchDataWithChannelCheckingFromFile] Channels to fetch from API: ${channelsForFileFetch.length} (${isTimeseries ? 'timeseries: all required' : channelsToFetchFromAPI.length > 0 ? 'only missing from HuniDB' : 'all required'})`, {
        channelsForFileFetch: channelsForFileFetch.slice(0, 10),
        channelsToFetchFromAPI: channelsToFetchFromAPI.slice(0, 10),
        requiredChannels: requiredChannels.slice(0, 10),
        note: isTimeseries
          ? `Timeseries: always request all ${requiredChannels.length} required channels so API returns full rows`
          : channelsToFetchFromAPI.length > 0
            ? `Fetching only ${channelsToFetchFromAPI.length} missing channels from HuniDB check`
            : `Fetching all ${requiredChannels.length} required channels (no HuniDB check or all missing)`
      });
      
      // CRITICAL FIX: Always include all channels we need to fetch, even if not in discovered list
      // Channel discovery is a hint/optimization, not a hard requirement. The API will return
      // what's available, and if a channel doesn't exist, it simply won't be in the response.
      // Filtering out channels here causes critical chart channels (x-axis, Twa, etc.) to be
      // excluded, resulting in invalid data points.
      
      // Identify channels confirmed in FILE discovery
      const fileServerChannels = channelsForFileFetch.filter(ch => {
        const chLower = ch.toLowerCase();
        return availableChannelsLower.has(chLower);
      });
      
      // Identify channels NOT found in FILE discovery (but still required)
      const missingFromFile = channelsForFileFetch.filter(ch => {
        if (isMetadataChannel(ch)) return false; // Metadata is always included
        const chLower = ch.toLowerCase();
        return !availableChannelsLower.has(chLower);
      });
      
      // CRITICAL: Always include all channels we need to fetch in validFileChannels
      // This ensures we attempt to fetch them even if discovery didn't find them.
      // Discovery might be incomplete, have case mismatches, or the channel might exist
      // but not be in the discovery cache. Let the API handle missing channels.
      // CRITICAL: Map channels to original case from discovery if available, otherwise preserve requested case
      const validFileChannels = channelsForFileFetch
        .filter(ch => {
          // Always include metadata channels (they're derived, not stored)
          if (isMetadataChannel(ch)) return true;
          
          // For explicitly requested channels, always include them
          // The API will return what's available - if a channel doesn't exist,
          // it simply won't be in the response, but we should still try.
          return true;
        })
        .map(ch => {
          // Map to original case from discovery if available, otherwise preserve requested case
          const chLower = ch.toLowerCase();
          return availableChannelsCaseMap.get(chLower) || ch;
        });
      
      // Enhanced logging for channel analysis
      info(`[fetchDataWithChannelCheckingFromFile] Channel analysis:`, {
        totalRequested: requiredChannels.length,
        confirmedInFileDiscovery: fileServerChannels.length,
        notInFileDiscovery: missingFromFile.length,
        missingChannels: missingFromFile.slice(0, 10),
        metadataChannels: requiredChannels.filter(ch => isMetadataChannel(ch)).length,
        note: 'All required channels will be included in fetch (discovery is a hint, not a requirement)'
      });
      
      if (missingFromFile.length > 0) {
        debug(`[fetchDataWithChannelCheckingFromFile] ⚠️ ${missingFromFile.length} required channels not found in FILE discovery, but will still attempt fetch:`, {
          missingChannels: missingFromFile.slice(0, 10),
          reason: 'Channel discovery may be incomplete or have case mismatches. API will return available channels.',
          availableChannelsSample: availableChannels.slice(0, 10)
        });
      }
      
      // Step 5: Check InfluxDB for channels not found in file server discovery
      // Influx only queries: (1) channel names that do NOT exist in file system, (2) DO NOT include metadata channels
      // CRITICAL: Never give up on Influx when we have channels missing from FILE - always try Influx for those.
      const missingChannelsFromFile = requiredChannels.filter(ch => {
        if (isMetadataChannel(ch)) return false; // Skip metadata - Influx never queries metadata
        const chLower = ch.toLowerCase();
        return !availableChannelsLower.has(chLower); // Only channels not in FILE discovery
      });
      
      // Set validInfluxChannels from missingChannelsFromFile first (exclude metadata again). Never clear this when we have missing channels - do not give up on Influx when we find file data.
      const nonMetadataMissing = missingChannelsFromFile.filter(ch => !isMetadataChannel(ch));
      let validInfluxChannels: string[] = nonMetadataMissing.length > 0 ? [...nonMetadataMissing] : [];
      
      if (missingChannelsFromFile.length > 0) {
        info(`[fetchDataWithChannelCheckingFromFile] ${missingChannelsFromFile.length} channels not in FILE discovery - will fetch from INFLUX (validInfluxChannels: ${validInfluxChannels.length}):`, missingChannelsFromFile.slice(0, 5));
        
        try {
          // Optional: check meta.channel_names and Influx discovery for logging / narrowing; do NOT overwrite validInfluxChannels with [] so we never give up on Influx
          const influxChannelsFromMeta = await huniDBStore.getChannelsByDataSource(
            className,
            missingChannelsFromFile,
            'INFLUX'
          );
          const influxChannelsFromMetaLower = new Set(
            influxChannelsFromMeta.map(ch => ch.toLowerCase())
          );
          const influxChannelsInFile = missingChannelsFromFile.filter(ch => {
            const chLower = ch.toLowerCase();
            return influxChannelsFromMetaLower.has(chLower) && availableChannelsLower.has(chLower);
          });
          if (influxChannelsInFile.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] ${influxChannelsInFile.length} INFLUX channels already in FILE (previously downloaded):`, influxChannelsInFile.slice(0, 5));
          }
          
          const channelsToCheckInInflux = missingChannelsFromFile.filter(ch => {
            const chLower = ch.toLowerCase();
            const hasInfluxDataSource = influxChannelsFromMetaLower.has(chLower);
            if (hasInfluxDataSource) return !availableChannelsLower.has(chLower);
            return true;
          });
          
          if (channelsToCheckInInflux.length > 0) {
            const influxChannels = await discoverChannels(resolvedDate, resolvedSourceName, 'INFLUX', false);
            const influxChannelsLower = new Set(influxChannels.map(ch => ch.toLowerCase()));
            const influxCaseMap = new Map<string, string>();
            influxChannels.forEach(ch => { influxCaseMap.set(ch.toLowerCase(), ch); });
            
            const fromDiscovery = channelsToCheckInInflux
              .filter(ch => influxChannelsLower.has(ch.toLowerCase()))
              .map(ch => influxCaseMap.get(ch.toLowerCase()) || ch);
            // Only narrow validInfluxChannels if discovery returned a non-empty list; otherwise keep trying all missing (do not give up)
            if (fromDiscovery.length > 0) {
              validInfluxChannels = fromDiscovery;
              info(`[fetchDataWithChannelCheckingFromFile] InfluxDB discovery: will fetch ${validInfluxChannels.length} channels from INFLUX:`, validInfluxChannels.slice(0, 5));
            } else {
              info(`[fetchDataWithChannelCheckingFromFile] InfluxDB discovery returned no match; will still try INFLUX for ${validInfluxChannels.length} missing channels:`, validInfluxChannels.slice(0, 5));
            }
          }
        } catch (error) {
          warn(`[fetchDataWithChannelCheckingFromFile] Error checking InfluxDB channels:`, error);
          // validInfluxChannels already set from nonMetadataMissing above - keep it so we still try Influx
          if (validInfluxChannels.length > 0) {
            info(`[fetchDataWithChannelCheckingFromFile] After InfluxDB check error, will still try INFLUX for ${validInfluxChannels.length} channels:`, validInfluxChannels.slice(0, 5));
          }
        }
      } else {
        info(`[fetchDataWithChannelCheckingFromFile] ✅ All requested channels confirmed in FILE discovery - skipping InfluxDB check`);
      }
      
      // Step 6: Prepare channels for fetching from FILE and INFLUX
      // Since we now include all required channels in validFileChannels, we need to
      // ensure channels confirmed in INFLUX are fetched from INFLUX, not FILE
      const allValidChannels = Array.from(new Set([...validFileChannels, ...validInfluxChannels]));
      
      // CRITICAL: Log channels before passing to fetchDataWithChannelChecking to verify case
      debug(`[fetchDataWithChannelCheckingFromFile] 🔍 ALL VALID CHANNELS BEFORE fetchDataWithChannelChecking:`, {
        allValidChannels: allValidChannels,
        channelsCount: allValidChannels.length,
        sampleChannels: allValidChannels.slice(0, 10),
        caseCheck: allValidChannels.slice(0, 10).map(ch => ({
          channel: ch,
          hasUpperCase: /[A-Z]/.test(ch),
          isLowercase: ch === ch.toLowerCase()
        })),
        validFileChannels: validFileChannels.slice(0, 10),
        validInfluxChannels: validInfluxChannels.slice(0, 10),
        note: 'These channels should be in original case. If lowercase here, they were lowercased during processing.'
      });
      
      // Validate that we have channels to fetch
      if (allValidChannels.length === 0) {
        setLastMissingChannels(chartType, requiredChannels);
        return [];
      }
      
      // Log channel summary
      info(`[fetchDataWithChannelCheckingFromFile] Channel summary:`, {
        totalRequired: requiredChannels.length,
        totalToFetch: allValidChannels.length,
        fromFile: validFileChannels.length,
        fromInflux: validInfluxChannels.length,
        note: allValidChannels.length === requiredChannels.length 
          ? '✅ All required channels will be fetched' 
          : `⚠️ ${requiredChannels.length - allValidChannels.length} channels filtered (should not happen with new logic)`
      });
      
      // Single request with all channels and data_source: 'auto' (server decides parquet vs Influx). No client-side file/influx split.
      if (false) {
        // Dead branch: previously fetched FILE and INFLUX separately and merged; now we use one request with data_source: 'auto'
        info(`[fetchDataWithChannelCheckingFromFile] Fetching from both sources separately: ${validFileChannels.length} from FILE, ${validInfluxChannels.length} from INFLUX`);
        debug(`[fetchDataWithChannelCheckingFromFile] Valid FILE channels:`, validFileChannels);
        debug(`[fetchDataWithChannelCheckingFromFile] Valid INFLUX channels:`, validInfluxChannels);
        
        // For FILE: Fetch all required channels EXCEPT those confirmed in INFLUX
        // (to avoid duplication - INFLUX channels will be merged in)
        const influxChannelsLower = new Set(validInfluxChannels.map(ch => ch.toLowerCase()));
        const fileChannelsToFetch = validFileChannels.filter(ch => {
          // Always include metadata channels (they're derived from timestamp)
          if (isMetadataChannel(ch)) return true;
          // Exclude channels that are confirmed in INFLUX (fetch from INFLUX instead)
          return !influxChannelsLower.has(ch.toLowerCase());
        });
        
        // For INFLUX: only channels not in file system and NOT metadata (validInfluxChannels already from missingChannelsFromFile; exclude metadata again)
        const influxChannelsToFetch = validInfluxChannels.filter(ch => !isMetadataChannel(ch));
        
        // Include filter/metadata channels from class object (filters_dataset) in FILE request
        let requiredFilterChannels: string[];
        try {
          requiredFilterChannels = await UnifiedFilterService.getRequiredFilterChannels(className, 'dataset');
          if (!requiredFilterChannels?.length) requiredFilterChannels = [...TIMESERIES_METADATA_CHANNELS_FALLBACK];
        } catch {
          requiredFilterChannels = [...TIMESERIES_METADATA_CHANNELS_FALLBACK];
        }
        const fileChannelsWithMetadata = Array.from(new Set([...fileChannelsToFetch, ...requiredFilterChannels]));
        
        info(`[fetchDataWithChannelCheckingFromFile] After deduplication - FILE: ${fileChannelsToFetch.length} data channels, ${fileChannelsWithMetadata.length} total (with metadata), INFLUX: ${influxChannelsToFetch.length} channels`);
        
        // Ensure we have at least some channels to fetch from FILE (even if just metadata)
        if (fileChannelsWithMetadata.length === 0) {
          warn(`[fetchDataWithChannelCheckingFromFile] No FILE channels to fetch! validFileChannels:`, validFileChannels);
        }
        
        // Fetch data from both sources in parallel (when channels are missing from cache)
        setProgress(chartType, className, normalizedSourceId, 50, 'Downloading data...');
        info(`[fetchDataWithChannelCheckingFromFile] Fetching FILE data with ${fileChannelsWithMetadata.length} channels:`, fileChannelsWithMetadata.slice(0, 5));
        info(`[fetchDataWithChannelCheckingFromFile] Fetching INFLUX data with ${influxChannelsToFetch.length} channels:`, influxChannelsToFetch.slice(0, 5));
        info(`[fetchDataWithChannelCheckingFromFile] Calling channel-values API with data_source=influx for ${influxChannelsToFetch.length} channels (will download and save to parquet)`);
        
        // Set loading states for progress tracking
        // Use the same key format as getDataSourceLoading expects
        const loadingKeyFile = `${chartType}_${className}_${normalizedSourceId}_file`;
        const loadingKeyInflux = `${chartType}_${className}_${normalizedSourceId}_influx`;
        setLoadingStates(prev => ({ 
          ...prev, 
          [loadingKeyFile]: fileChannelsWithMetadata.length > 0, 
          [loadingKeyInflux]: influxChannelsToFetch.length > 0 
        }));
        
        const [fileData, influxData] = await Promise.all([
          fileChannelsWithMetadata.length > 0 
            ? fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), fileChannelsWithMetadata, { ...params, data_source: 'file' }, dataSource).then(data => {
                info(`[fetchDataWithChannelCheckingFromFile] FILE data fetch completed: ${data.length} records`);
                if (!data || data.length === 0) {
                  debug(`[fetchDataWithChannelCheckingFromFile] FILE data fetch returned empty array`, {
                    channels: fileChannelsWithMetadata.slice(0, 10)
                  });
                }
                setLoadingStates(prev => ({ ...prev, [loadingKeyFile]: false }));
                if (influxChannelsToFetch.length > 0) {
                  setProgress(chartType, className, normalizedSourceId, 60, 'Downloading data...');
                }
                return data;
              }).catch(err => {
                warn(`[fetchDataWithChannelCheckingFromFile] Error fetching FILE data:`, err);
                setLoadingStates(prev => ({ ...prev, [loadingKeyFile]: false }));
                return [];
              })
            : Promise.resolve([]),
          influxChannelsToFetch.length > 0
            ? fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), influxChannelsToFetch, { ...params, data_source: 'influx' }, dataSource).then(data => {
                info(`[fetchDataWithChannelCheckingFromFile] INFLUX data fetch completed: ${data.length} records`);
                info(`[fetchDataWithChannelCheckingFromFile] ✅ InfluxDB data will be stored in HuniDB cache by fetchDataWithChannelChecking`);
                setLoadingStates(prev => ({ ...prev, [loadingKeyInflux]: false }));
                return data;
              }).catch(err => {
                warn(`[fetchDataWithChannelCheckingFromFile] Error fetching INFLUX data:`, err);
                setLoadingStates(prev => ({ ...prev, [loadingKeyInflux]: false }));
                return [];
              })
            : Promise.resolve([])
        ]);
        
        // Clear loading states
        setLoadingStates(prev => {
          const updated = { ...prev };
          delete updated[loadingKeyFile];
          delete updated[loadingKeyInflux];
          return updated;
        });
        
        // Helper function to normalize timestamp to milliseconds
        // FILE data uses seconds (with decimals), InfluxDB uses milliseconds
        const normalizeTimestamp = (ts: number): number => {
          if (!ts || ts <= 0) return 0;
          // If timestamp is less than 1e12 (year ~2001), it's likely in seconds, convert to milliseconds
          if (ts < 1e12) {
            return Math.round(ts * 1000);
          }
          // Already in milliseconds
          return Math.round(ts);
        };
        
        // Helper function to merge data from two sources by timestamp
        const mergeDataByTimestamp = (fileData: any[], influxData: any[]): any[] => {
          if (fileData.length === 0) return influxData;
          if (influxData.length === 0) return fileData;
          
          const TOLERANCE_MS = 1000;
          const fileDataMap = new Map<number, any>();
          // Defensive timestamp extraction: same key order as single-source merge (timestamp, Timestamp, Datetime/datetime, date, ts)
          const getTs = (item: any): number | undefined => {
            let ts = item.timestamp;
            if (ts != null) return normalizeTimestamp(ts);
            ts = item.Timestamp;
            if (ts != null) return normalizeTimestamp(ts);
            const dt = item.Datetime ?? item.datetime;
            if (dt != null) return normalizeTimestamp(new Date(dt).getTime());
            const d = item.date;
            if (d != null) return normalizeTimestamp(typeof d === 'number' ? d : new Date(d).getTime());
            const t = item.ts;
            if (t != null) return normalizeTimestamp(t);
            return undefined;
          };
          
          fileData.forEach(item => {
            const ts = getTs(item);
            if (ts && ts > 0) {
              const roundedTs = Math.round(ts / 1000) * 1000;
              fileDataMap.set(roundedTs, { ...item, timestamp: ts });
            }
          });
          
          influxData.forEach(item => {
            const ts = getTs(item);
            if (!ts || ts <= 0) return;
            const roundedTs = Math.round(ts / 1000) * 1000;
            let existing = fileDataMap.get(roundedTs);
            if (!existing) {
              for (const [key, value] of fileDataMap.entries()) {
                if (Math.abs(key - roundedTs) <= TOLERANCE_MS) {
                  existing = value;
                  break;
                }
              }
            }
            if (existing) {
              Object.keys(item).forEach(key => {
                if (key !== 'timestamp' && key !== 'Datetime' && key !== 'datetime') {
                  existing[key] = item[key];
                }
              });
              if (ts > existing.timestamp) {
                existing.timestamp = ts;
              }
            } else {
              fileDataMap.set(roundedTs, { ...item, timestamp: ts });
            }
          });
          
          // Convert map back to array and sort by timestamp
          const merged = Array.from(fileDataMap.values());
          merged.sort((a, b) => {
            const tsA = a.timestamp || 0;
            const tsB = b.timestamp || 0;
            return tsA - tsB;
          });
          
          return merged;
        };
        
        // Merge data by Datetime/timestamp
        setProgress(chartType, className, normalizedSourceId, 80, 'Merging data from multiple sources...');
        info(`[fetchDataWithChannelCheckingFromFile] Before merge - FILE: ${fileData.length} records, INFLUX: ${influxData.length} records`);
        if (fileData.length > 0) {
          debug(`[fetchDataWithChannelCheckingFromFile] Sample FILE record:`, {
            timestamp: fileData[0].timestamp,
            Datetime: fileData[0].Datetime,
            channels: Object.keys(fileData[0]).filter(k => k !== 'timestamp' && k !== 'Datetime')
          });
        }
        if (influxData.length > 0) {
          debug(`[fetchDataWithChannelCheckingFromFile] Sample INFLUX record:`, {
            timestamp: influxData[0].timestamp,
            Datetime: influxData[0].Datetime,
            channels: Object.keys(influxData[0]).filter(k => k !== 'timestamp' && k !== 'Datetime')
          });
        }
        
        let dataToMerge = mergeDataByTimestamp(fileData, influxData);
        
        // File-first, then Influx: channels that were in FILE discovery but returned no data → fetch from Influx and merge
        const channelsWithNoDataInFile = getChannelsWithNoData(fileData, fileChannelsToFetch, isMetadataChannel);
        if (channelsWithNoDataInFile.length > 0) {
          info(`[fetchDataWithChannelCheckingFromFile] ${channelsWithNoDataInFile.length} channels had no data in FILE - fetching from INFLUX (file-first fallback):`, channelsWithNoDataInFile.slice(0, 5));
          try {
            const influxFallbackData = await fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), channelsWithNoDataInFile, { ...params, data_source: 'influx' }, dataSource);
            if (influxFallbackData?.length > 0) {
              dataToMerge = mergeDataByTimestamp(dataToMerge, influxFallbackData);
              info(`[fetchDataWithChannelCheckingFromFile] Merged INFLUX fallback: ${influxFallbackData.length} records for channels with no file data`);
            }
          } catch (fallbackErr) {
            warn(`[fetchDataWithChannelCheckingFromFile] Influx fallback for empty-file channels failed:`, fallbackErr);
          }
        }
        
        // Merge HuniDB data with API data if we have both
        
        if (huniDBData.length > 0 && dataToMerge.length > 0) {
          info(`[fetchDataWithChannelCheckingFromFile] Merging ${huniDBData.length} HuniDB records with ${dataToMerge.length} API records...`);
          dataToMerge = mergeDataByTimestamp(huniDBData, dataToMerge);
          info(`[fetchDataWithChannelCheckingFromFile] ✅ Merged HuniDB + API data: ${dataToMerge.length} total records (${huniDBData.length} from HuniDB, ${fileData.length} from FILE, ${influxData.length} from INFLUX)`);
        } else if (huniDBData.length > 0) {
          // Only HuniDB data, no API data
          info(`[fetchDataWithChannelCheckingFromFile] Using ${huniDBData.length} records from HuniDB (no API data needed)`);
          dataToMerge = huniDBData;
        } else {
          // Only API data
          info(`[fetchDataWithChannelCheckingFromFile] Using ${dataToMerge.length} records from API (no HuniDB data)`);
        }
        
        const mergedData = dataToMerge;
        setProgress(chartType, className, normalizedSourceId, 90, 'Processing data...');
        info(`[fetchDataWithChannelCheckingFromFile] Final merged data: ${mergedData.length} records (${huniDBData.length} from HuniDB, ${fileData.length} from FILE, ${influxData.length} from INFLUX)`);
        
        // Validate only critical-for-rendering channels: Twa_deg, Grade, chart-requested (x/y/color), Datetime/timestamp. Others (State, Config, Race_number, Leg_number) are non-critical.
        // CRITICAL: Include tag keys in "available" - HuniDB stores Twa_deg, Grade, State, Race_number, Leg_number in tags; if populated, they count as available and we must not fail validation.
        if (mergedData.length > 0) {
          const sampleRecord = mergedData[0];
          const rowKeys = Object.keys(sampleRecord);
          const tagKeys = (() => {
            const t = sampleRecord.tags;
            if (!t) return [] as string[];
            if (typeof t === 'string') {
              try {
                return Object.keys(JSON.parse(t) as Record<string, unknown>);
              } catch {
                return [] as string[];
              }
            }
            return Object.keys(t as Record<string, unknown>);
          })();
          const availableChannelsLower = new Set([...rowKeys, ...tagKeys].map((ch: string) => ch.toLowerCase()));
          const missingCritical = getMissingCriticalChannelsForRendering(requiredChannels, availableChannelsLower);

          if (missingCritical.length > 0) {
            setLastMissingChannels(chartType, missingCritical);
            debug(`[fetchDataWithChannelCheckingFromFile] Returning all available data (${mergedData.length} rows) - missing critical channels: ${missingCritical.join(', ')}. UI will show "Missing channel(s)" and render with all available data.`);
          } else {
            debug(`[fetchDataWithChannelCheckingFromFile] ✅ All critical channels present in returned data`);
          }
          // Always return all available data (full merged set, no row or channel filtering)
          
          debug(`[fetchDataWithChannelCheckingFromFile] Sample merged record:`, {
            timestamp: mergedData[0].timestamp,
            Datetime: mergedData[0].Datetime,
            channels: Object.keys(mergedData[0]).filter(k => k !== 'timestamp' && k !== 'Datetime')
          });
          
          // Note: Individual FILE and INFLUX data are already stored in HuniDB by fetchDataWithChannelChecking
          // The merged data doesn't need separate storage - both sources are in cache and can be queried together
          info(`[fetchDataWithChannelCheckingFromFile] ✅ Both FILE and INFLUX data have been stored in HuniDB cache - merged result will be available on next page load`);
        }
        
        // Return all available data: normalize field names only (no row or channel filtering)
        const normalizedMergedData = await normalizeDataFields(mergedData, requiredChannels);
        setProgress(chartType, className, normalizedSourceId, 100, 'Complete');
        return normalizedMergedData;
      } else {
        // Single request with all channels and data_source: 'auto' (server decides parquet vs Influx)
        setProgress(chartType, className, normalizedSourceId, 50, 'Downloading data...');
        info(`[fetchDataWithChannelCheckingFromFile] Fetching all ${allValidChannels.length} channels from API (data_source: auto - server will check parquet and backfill from Influx)`, {
          channelsFromHuniDB: channelsFoundInHuniDB.length,
          channelsToFetchFromAPI: channelsToFetchFromAPI.length,
          huniDBDataRows: huniDBData.length
        });
        info(`[fetchDataWithChannelCheckingFromFile] Calling fetchDataWithChannelChecking with channels:`, allValidChannels.slice(0, 10));
        
        // CRITICAL: Ensure sourceName and data_source are set correctly
        // Resolve sourceName if not already in params
        // CRITICAL: sourceName is required for API fetch and storage - ensure it's always resolved
        let finalSourceName = params?.sourceName || params?.source_name;
        if (!finalSourceName && normalizedSourceId && normalizedSourceId !== 0) {
          try {
            // Try to get from sourcesStore (synchronous)
            finalSourceName = sourcesStore.getSourceName(normalizedSourceId);
            if (finalSourceName) {
              info(`[fetchDataWithChannelCheckingFromFile] Resolved sourceName from sourceId ${normalizedSourceId}: ${finalSourceName}`);
            } else {
              // If sourcesStore doesn't have it, try persistantStore
              const sourceNameFromStore = persistantStore.selectedSourceName?.();
              if (sourceNameFromStore) {
                finalSourceName = sourceNameFromStore;
                info(`[fetchDataWithChannelCheckingFromFile] Resolved sourceName from persistantStore: ${finalSourceName}`);
              }
            }
          } catch (e) {
            warn(`[fetchDataWithChannelCheckingFromFile] Could not resolve sourceName from sourceId ${normalizedSourceId}:`, e);
            // Fallback to persistantStore
            const sourceNameFromStore = persistantStore.selectedSourceName?.();
            if (sourceNameFromStore) {
              finalSourceName = sourceNameFromStore;
              info(`[fetchDataWithChannelCheckingFromFile] Using sourceName from persistantStore (fallback): ${finalSourceName}`);
            }
          }
        }
        
        // CRITICAL: Warn if sourceName is still missing - this will prevent storage
        if (!finalSourceName && channelsToFetchFromAPI.length > 0) {
          warn(`[fetchDataWithChannelCheckingFromFile] ⚠️ CRITICAL: sourceName is missing but channels need to be fetched! This will prevent storage.`, {
            sourceId: normalizedSourceId,
            channelsToFetch: channelsToFetchFromAPI.length,
            paramsSourceName: params?.sourceName || params?.source_name,
            note: 'Attempting to use sourceName from params or persistantStore as fallback'
          });
        }
        
        // Use data_source: 'auto' so server runs unified path (DuckDB check, Influx backfill, write parquet, return combined)
        const finalParams = {
          ...params,
          sourceName: finalSourceName || params?.sourceName || params?.source_name,
          date: resolvedDate ?? params?.date,
          data_source: 'auto' as const
        };
        
        info(`[fetchDataWithChannelCheckingFromFile] Final params for fetchDataWithChannelChecking:`, {
          sourceName: finalParams.sourceName,
          data_source: finalParams.data_source,
          date: finalParams.date,
          className: finalParams.className || className,
          projectId: finalParams.projectId || projectId,
          datasetId: finalParams.datasetId || datasetId
        });
        
        info(`[fetchDataWithChannelCheckingFromFile] 🚀 About to call fetchDataWithChannelChecking with:`, {
          chartType,
          className,
          sourceId: normalizedSourceId,
          channelCount: allValidChannels.length,
          channels: allValidChannels.slice(0, 10),
          hasSourceName: !!finalParams.sourceName,
          sourceName: finalParams.sourceName,
          date: finalParams.date,
          data_source: finalParams.data_source
        });
        
        info(`[fetchDataWithChannelCheckingFromFile] 🚀 Calling fetchDataWithChannelChecking to fetch and store data:`, {
          chartType,
          className,
          sourceId: normalizedSourceId,
          channels: allValidChannels.slice(0, 10),
          totalChannels: allValidChannels.length,
          params: {
            projectId: finalParams.projectId,
            datasetId: finalParams.datasetId,
            sourceName: finalParams.sourceName,
            date: finalParams.date,
            data_source: finalParams.data_source
          },
          dataSource,
          note: 'This should trigger API fetch and storage in HuniDB'
        });
        
        const apiData = await fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), allValidChannels, finalParams, dataSource);
        
        info(`[fetchDataWithChannelCheckingFromFile] ✅ fetchDataWithChannelChecking returned ${apiData?.length || 0} records`, {
          recordCount: apiData?.length || 0,
          hasData: !!(apiData && apiData.length > 0),
          sampleKeys: apiData && apiData.length > 0 ? Object.keys(apiData[0]).slice(0, 10) : [],
          note: apiData?.length === 0 ? 'No data returned - check API logs above for details' : 'Data returned successfully'
        });
        
        // With data_source: 'auto' the server returns combined data from DuckDB (parquet + Influx backfill); no client-side Influx fallback needed.
        const normalizedApiData = await normalizeDataFields(apiData || [], allValidChannels);
        
        // Merge with HuniDB data if we have both
        let data = normalizedApiData;
        if (huniDBData.length > 0 && normalizedApiData && normalizedApiData.length > 0) {
          info(`[fetchDataWithChannelCheckingFromFile] Merging ${huniDBData.length} HuniDB records with ${normalizedApiData.length} API records...`);
          // Use the same merge function
          const normalizeTimestamp = (ts: number): number => {
            if (!ts || ts <= 0) return 0;
            if (ts < 1e12) return Math.round(ts * 1000);
            return Math.round(ts);
          };
          
          const mergeDataByTimestamp = (data1: any[], data2: any[]): any[] => {
            if (data1.length === 0) return data2;
            if (data2.length === 0) return data1;
            
            const TOLERANCE_MS = 1000;
            const data1Map = new Map<number, any>();
            // Defensive timestamp extraction: try timestamp, Timestamp, Datetime/datetime, date, ts (HuniDB/API key variants)
            const getTs = (item: any): number | undefined => {
              let ts = item.timestamp;
              if (ts != null) return normalizeTimestamp(ts);
              ts = item.Timestamp;
              if (ts != null) return normalizeTimestamp(ts);
              const dt = item.Datetime ?? item.datetime;
              if (dt != null) return normalizeTimestamp(new Date(dt).getTime());
              const d = item.date;
              if (d != null) return normalizeTimestamp(typeof d === 'number' ? d : new Date(d).getTime());
              const t = item.ts;
              if (t != null) return normalizeTimestamp(t);
              return undefined;
            };
            
            const addToMap = (map: Map<number, any>, item: any) => {
              const ts = getTs(item);
              if (ts && ts > 0) {
                const roundedTs = Math.round(ts / 1000) * 1000;
                map.set(roundedTs, { ...item, timestamp: ts });
              }
            };
            
            const mergeIntoMap = (map: Map<number, any>, item: any) => {
              const ts = getTs(item);
              if (!ts || ts <= 0) return;
              const roundedTs = Math.round(ts / 1000) * 1000;
              let existing = map.get(roundedTs);
              if (!existing) {
                for (const [key, value] of map.entries()) {
                  if (Math.abs(key - roundedTs) <= TOLERANCE_MS) {
                    existing = value;
                    break;
                  }
                }
              }
              if (existing) {
                Object.keys(item).forEach(key => {
                  if (key !== 'timestamp' && key !== 'Datetime' && key !== 'datetime' && key !== 'Timestamp' && key !== 'date' && key !== 'ts') {
                    existing[key] = item[key];
                  }
                });
                if (ts > existing.timestamp) {
                  existing.timestamp = ts;
                }
              } else {
                map.set(roundedTs, { ...item, timestamp: ts });
              }
            };
            
            data1.forEach(item => addToMap(data1Map, item));
            
            // If HuniDB had rows but none had a usable timestamp, build from data2 and merge data1 into it (Option A)
            if (data1.length > 0 && data1Map.size === 0) {
              warn(`[fetchDataWithChannelCheckingFromFile] HuniDB rows have no usable timestamp/datetime key; merge may be incomplete`);
              data2.forEach(item => addToMap(data1Map, item));
              data1.forEach(item => mergeIntoMap(data1Map, item));
            } else {
              data2.forEach(item => mergeIntoMap(data1Map, item));
            }
            
            const merged = Array.from(data1Map.values());
            merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            return merged;
          };
          
          data = mergeDataByTimestamp(huniDBData, apiData);
          info(`[fetchDataWithChannelCheckingFromFile] ✅ Merged HuniDB + API data: ${data.length} total records (${huniDBData.length} from HuniDB, ${apiData.length} from API)`);
        } else if (huniDBData.length > 0) {
          // Only HuniDB data
          data = huniDBData;
          info(`[fetchDataWithChannelCheckingFromFile] Using ${huniDBData.length} records from HuniDB (API returned no data)`);
        }
        
        if (!data || data.length === 0) {
          setLastMissingChannels(chartType, requiredChannels);
          setProgress(chartType, className, normalizedSourceId, 100, 'Complete');
          return [];
        }
        // Validate only critical-for-rendering channels: Twa_deg, Grade, chart-requested (x/y/color), Datetime/timestamp. Others (State, Config, Race_number, Leg_number) are non-critical.
        // CRITICAL: Include tag keys in "available" - HuniDB stores Twa_deg, Grade, State, Race_number, Leg_number in tags; if populated, they count as available and we must not fail validation.
        const sampleRecord = data[0];
        const rowKeys = Object.keys(sampleRecord);
        const tagKeysSingle = (() => {
          const t = sampleRecord.tags;
          if (!t) return [] as string[];
          if (typeof t === 'string') {
            try {
              return Object.keys(JSON.parse(t) as Record<string, unknown>);
            } catch {
              return [] as string[];
            }
          }
          return Object.keys(t as Record<string, unknown>);
        })();
        const availableChannelsLower = new Set([...rowKeys, ...tagKeysSingle].map((ch: string) => ch.toLowerCase()));
        const missingCriticalSingle = getMissingCriticalChannelsForRendering(requiredChannels, availableChannelsLower);

        if (missingCriticalSingle.length > 0) {
          setLastMissingChannels(chartType, missingCriticalSingle);
          debug(`[fetchDataWithChannelCheckingFromFile] Returning all available data (${data.length} rows) - missing critical channels: ${missingCriticalSingle.join(', ')}. UI will show "Missing channel(s)" and render with all available data.`);
        }
        // Return all available data: normalize field names only (no row or channel filtering)
        const normalizedData = await normalizeDataFields(data, requiredChannels);
        setProgress(chartType, className, normalizedSourceId, 100, 'Complete');
        return normalizedData;
      }
      
    } catch (error) {
      logError(`[fetchDataWithChannelCheckingFromFile] Error:`, error);
      setProgress(chartType, className, normalizedSourceId, 100, 'Error occurred');
      // Fall back to regular method on error
      return fetchDataWithChannelChecking(chartType, className, String(normalizedSourceId), requiredChannels, params, dataSource);
    }
  };

  // Chart data accessor
  const chartData = (): ChartDataMap => {
    return {};
  };

  // Set chart data
  const setChartData = async (_value: ChartDataMap | ((prev: ChartDataMap) => ChartDataMap)) => {
    // This method is for setting global chart data - implementation depends on requirements
    debug('[UnifiedDataStore] setChartData called');
  };

  // Get chart data for a specific type
  const getChartData = async (chartType: ChartType): Promise<any[]> => {
    try {
      const dataSource = getDataSourceForChart(chartType);
      const className = persistantStore.selectedClassName?.() || 'gp50';
      const sourceId = persistantStore.selectedSourceId?.()?.toString() || '1';
      
      const data = await getDataFromIndexedDB(dataSource, className, sourceId);
      return data || [];
    } catch (error) {
      logError(`[UnifiedDataStore] Error getting chart data for ${chartType}:`, error);
      return [];
    }
  };

  // Update chart data for a specific type
  const updateChartData = async (chartType: ChartType, data: any[]): Promise<void> => {
    try {
      const dataSource = getDataSourceForChart(chartType);
      const className = persistantStore.selectedClassName?.() || 'gp50';
      const sourceId = persistantStore.selectedSourceId?.()?.toString() || '1';
      const datasetId = String(persistantStore.selectedDatasetId() || '0');
      const projectId = String(persistantStore.selectedProjectId?.() || '0');
      
      // Extract channels from the data
      const channels = extractChannelsFromData(data);
      
      // Store in IndexedDB with context
      await storeDataInIndexedDB(dataSource, className, Number(datasetId), Number(projectId), Number(sourceId), channels, data, { chartType, context: chartType });
      
    } catch (error) {
      logError(`[UnifiedDataStore] Error updating chart data for ${chartType}:`, error);
      throw error;
    }
  };

  // Fetch chart data with loading and error states
  const fetchChartData = async (chartType: ChartType, _params?: any, _options?: any): Promise<any[]> => {
    setLoading(chartType, true);
    setError(chartType, null);
    
    try {
      const data = await getChartData(chartType);
      await updateChartData(chartType, data);
      setLoading(chartType, false);
      return data;
    } catch (error) {
      setError(chartType, (error as Error).message);
      setLoading(chartType, false);
      throw error;
    }
  };

  // Loading state management
  const setLoading = (chartType: ChartType, loading: boolean) => {
    setLoadingStates(prev => ({ ...prev, [chartType]: loading }));
  };

  const getLoading = (chartType: ChartType): boolean => {
    return loadingStates()[chartType] || false;
  };
  
  // Get loading state for specific data source (file or influx)
  const getDataSourceLoading = (chartType: ChartType, className: string, sourceId: string | number, dataSource: 'file' | 'influx'): boolean => {
    const loadingKey = `${chartType}_${className}_${sourceId}_${dataSource}`;
    return loadingStates()[loadingKey] || false;
  };
  
  // Get loading message for data sources
  const getDataLoadingMessage = (chartType: ChartType, className: string, sourceId: string | number): string => {
    const fileLoading = getDataSourceLoading(chartType, className, sourceId, 'file');
    const influxLoading = getDataSourceLoading(chartType, className, sourceId, 'influx');
    
    if (fileLoading && influxLoading) {
      return 'Loading data from FILE and InfluxDB...';
    } else if (fileLoading) {
      return 'Loading data from FILE...';
    } else if (influxLoading) {
      return 'Loading data from InfluxDB...';
    }
    return 'Loading data...';
  };

  // Progress state management
  const createProgressKey = (chartType: ChartType, className: string, sourceId: string | number): string => {
    return `${chartType}_${className}_${sourceId}`;
  };

  const setProgress = (chartType: ChartType, className: string, sourceId: string | number, progress: number, message?: string): void => {
    const key = createProgressKey(chartType, className, sourceId);
    const clampedProgress = Math.max(0, Math.min(100, progress));
    setProgressStates(prev => ({ ...prev, [key]: clampedProgress }));
    if (message) {
      setProgressMessages(prev => ({ ...prev, [key]: message }));
    }
  };

  const getProgress = (chartType: ChartType, className: string, sourceId: string | number): number | null => {
    const key = createProgressKey(chartType, className, sourceId);
    const progress = progressStates()[key];
    return progress !== undefined ? progress : null;
  };

  const getProgressMessage = (chartType: ChartType, className: string, sourceId: string | number): string | null => {
    const key = createProgressKey(chartType, className, sourceId);
    const message = progressMessages()[key];
    return message !== undefined ? message : null;
  };

  const clearProgress = (chartType: ChartType, className: string, sourceId: string | number): void => {
    const key = createProgressKey(chartType, className, sourceId);
    setProgressStates(prev => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });
    setProgressMessages(prev => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });
  };

  // Error state management
  const setError = (chartType: ChartType, error: string | null) => {
    setErrorStates(prev => ({ ...prev, [chartType]: error }));
  };

  const getError = (chartType: ChartType): string | null => {
    return errorStates()[chartType] || null;
  };

  // Component access methods
  const getData = (category: DataCategory, sourceId: string): any[] => {
    const dataSource = getDataSourceForChart(category as ChartType);
    const datasetId = String(persistantStore.selectedDatasetId() || '0');
    const projectId = String(persistantStore.selectedProjectId?.() || '0');
    const key = createDataKey(datasetId, projectId, sourceId, dataSource);
    return categoryData.get(key) || [];
  };

  const getDataAsync = async (category: DataCategory, sourceId: string): Promise<any[]> => {
    const dataSource = getDataSourceForChart(category as ChartType);
    const className = persistantStore.selectedClassName?.() || 'gp50';
    const datasetId = String(persistantStore.selectedDatasetId() || '0');
    const projectId = String(persistantStore.selectedProjectId?.() || '0');
    const key = createDataKey(datasetId, projectId, sourceId, dataSource);
    
    // First check local Map for fast access
    const localData = categoryData.get(key);
    if (localData && localData.length > 0) {
      return localData;
    }
    
    // If not in local Map, try to get from HuniDB cache
    try {
      const data = await getDataFromIndexedDB(dataSource, className, sourceId);
      
      if (data && data.length > 0) {
        // Store in local Map for future fast access
        categoryData.set(key, data);
        return data;
      } else {
        debug(`[HuniDB] No data found in HuniDB cache for key: ${key}`);
      }
    } catch (error) {
      warn('Error getting data from HuniDB cache:', error);
    }
    
    debug(`[IndexedDB] No data found for key: ${key}`);
    return [];
  };

  const getDataWithTimeRange = (category: DataCategory, sourceId: string, startTime?: Date, endTime?: Date): any[] => {
    const dataSource = getDataSourceForChart(category as ChartType);
    const datasetId = String(persistantStore.selectedDatasetId() || '0');
    const projectId = String(persistantStore.selectedProjectId?.() || '0');
    const key = createDataKey(datasetId, projectId, sourceId, dataSource);
    return getDataWithTimestamp(key, startTime, endTime);
  };

  const setData = async (category: DataCategory, sourceId: string, data: any[]): Promise<void> => {
    const dataSource = getDataSourceForChart(category as ChartType);
    const className = persistantStore.selectedClassName?.() || 'gp50';
    const datasetId = Number(persistantStore.selectedDatasetId() || 0);
    const projectId = Number(persistantStore.selectedProjectId?.() || 0);
    const key = createDataKey(String(datasetId), String(projectId), sourceId, dataSource);
    
    // Extract channels from the data
    const channels = extractChannelsFromData(data);
    
    // Store in IndexedDB with context
    await storeDataInIndexedDB(dataSource, className, datasetId, projectId, Number(sourceId), channels, data, { chartType: category as ChartType, context: category });
    
    // Also store in local Map for fast access
    categoryData.set(key, data);
    
    // Index data by timestamp for fast lookups
    indexDataByTimestamp(key, data);
  };

  // Index data by timestamp for fast lookups
  const indexDataByTimestamp = (key: string, data: any[]): void => {
    if (!data || data.length === 0) return;
    
    const timestampMap = new Map<number, any[]>();
    
    data.forEach(item => {
      if (item.Datetime) {
        const timestamp = new Date(item.Datetime).getTime();
        if (!isNaN(timestamp)) {
          if (!timestampMap.has(timestamp)) {
            timestampMap.set(timestamp, []);
          }
          timestampMap.get(timestamp)!.push(item);
        }
      }
    });
    
    timestampIndexes.set(key, timestampMap);
    dataCache.set(key, { 
      data, 
      timestamp: Date.now(), 
      indexed: true 
    });
  };

  // Get data with timestamp-based lookup
  const getDataWithTimestamp = (key: string, startTime?: Date, endTime?: Date): any[] => {
    const cached = dataCache.get(key);
    if (!cached || !cached.indexed) {
      return cached?.data || [];
    }

    const timestampMap = timestampIndexes.get(key);
    if (!timestampMap) {
      return cached.data;
    }

    // If no time range specified, return all data
    if (!startTime && !endTime) {
      return cached.data;
    }

    // Filter by timestamp range
    const filteredData: any[] = [];
    const start = startTime ? startTime.getTime() : 0;
    const end = endTime ? endTime.getTime() : Number.MAX_SAFE_INTEGER;

    for (const [timestamp, items] of timestampMap.entries()) {
      if (timestamp >= start && timestamp <= end) {
        filteredData.push(...items);
      }
    }

    return filteredData;
  };

  // Check if data is cached and fresh
  const isDataCached = (key: string, maxAge: number = 5 * 60 * 1000): boolean => {
    const cached = dataCache.get(key);
    if (!cached) return false;
    
    const age = Date.now() - cached.timestamp;
    return age < maxAge;
  };

  // Storage management with HuniDB integration
  const getStorageInfo = async () => {
    try {
      const huniDBInfo = await huniDBStore.getStorageInfo();
      const localCacheInfo = {
        entries: categoryData.size,
        size: Array.from(categoryData.values())
          .reduce((sum, data) => sum + JSON.stringify(data).length, 0)
      };
      
      return {
        huniDB: {
          channelCount: huniDBInfo.channelCount,
          simpleObjectCount: huniDBInfo.simpleObjectCount,
          totalSize: huniDBInfo.totalSize
        },
        localCache: localCacheInfo,
        total: {
          entries: huniDBInfo.channelCount + huniDBInfo.simpleObjectCount + localCacheInfo.entries,
          size: huniDBInfo.totalSize + localCacheInfo.size
        }
      };
    } catch (error) {
      logError('Error getting storage info:', error);
      return { size: 0, entries: 0 };
    }
  };

  const clearAllData = async () => {
    try {
      // Clear HuniDB stores
      await huniDBStore.clearAllData();
      
      // Clear local caches
      categoryData.clear();
      categoryLoading.clear();
      categoryErrors.clear();
      channelAvailability.clear();
      dataCache.clear();
      timestampIndexes.clear();
      
      setLoadingStates({});
      setErrorStates({});
    } catch (error) {
      logError('Error clearing all data:', error);
    }
  };

  // Overlay-specific in-memory storage
  const overlayMemoryStorage = new Map<string, OverlayStorageEntry>();

  const createOverlayKey = (className: string, sourceId: string): string => {
    return `overlay_${className.toLowerCase()}_${sourceId}`;
  };

  const storeOverlayData = async (className: string, sourceId: string, channels: string[], data: any[]): Promise<void> => {
    try {
      const key = createOverlayKey(className, sourceId);
      const now = Date.now();
      
      // OPTIMIZATION: Check if data is already sorted before sorting
      let sortedData: any[];
      const existingEntry = overlayMemoryStorage.get(key);
      const isAlreadySorted = existingEntry?.metadata?.sorted && 
        data.length > 0 && 
        data.length === existingEntry.data.length &&
        data[0]?.Datetime === existingEntry.data[0]?.Datetime;
      
      if (isAlreadySorted) {
        // Data appears to be already sorted, verify quickly
        let needsSorting = false;
        for (let i = 1; i < Math.min(data.length, 100); i++) {
          const prevTime = new Date(data[i - 1].Datetime).getTime();
          const currTime = new Date(data[i].Datetime).getTime();
          if (currTime < prevTime) {
            needsSorting = true;
            break;
          }
        }
        sortedData = needsSorting ? await sortDataByTimestampAsync([...data]) : data;
      } else {
        // Sort data by timestamp for efficient binary search (async for large datasets)
        sortedData = await sortDataByTimestampAsync([...data]);
      }
      
      const entry = {
        className: className.toLowerCase(),
        sourceId,
        channels: [...channels],
        data: sortedData,
        metadata: {
          timestamp: now,
          dataSize: JSON.stringify(sortedData).length,
          lastUpdated: now,
          sorted: true
        }
      };
      
      overlayMemoryStorage.set(key, entry);
    } catch (error) {
      logError('Error storing overlay data in memory:', error);
      throw error;
    }
  };
  
  const getOverlayData = (className: string, sourceId: string): any[] => {
    const key = createOverlayKey(className, sourceId);
    const entry = overlayMemoryStorage.get(key);
    return entry ? entry.data : [];
  };
  
  const findClosestOverlayData = (className: string, sourceId: string, targetTime: Date): any | null => {
    const key = createOverlayKey(className, sourceId);
    const entry = overlayMemoryStorage.get(key);
    
    if (!entry || !entry.data || entry.data.length === 0) {
      return null;
    }
    
    const targetTimestamp = targetTime.getTime();
    if (isNaN(targetTimestamp)) {
      return null;
    }
    
    // Binary search for closest time (data is already sorted)
    let left = 0;
    let right = entry.data.length - 1;
    let closest = null;
    let minDiff = Infinity;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midTime = new Date(entry.data[mid].Datetime).getTime();
      
      if (isNaN(midTime)) {
        break;
      }
      
      const diff = Math.abs(midTime - targetTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = entry.data[mid];
      }
      
      if (midTime < targetTimestamp) {
        left = mid + 1;
      } else if (midTime > targetTimestamp) {
        right = mid - 1;
      } else {
        return entry.data[mid]; // Exact match
      }
    }
    
    return closest;
  };
  
  const clearOverlayData = (className?: string, sourceId?: string): void => {
    if (className && sourceId) {
      // Clear specific entry
      const key = createOverlayKey(className, sourceId);
      overlayMemoryStorage.delete(key);
    } else if (className) {
      // Clear all entries for a specific class
      const keysToDelete = Array.from(overlayMemoryStorage.keys()).filter(key => 
        key.startsWith(`overlay_${className.toLowerCase()}_`)
      );
      keysToDelete.forEach(key => overlayMemoryStorage.delete(key));
    } else {
      // Clear all overlay data
      overlayMemoryStorage.clear();
    }
  };

  // Simple object storage methods
  const storeObject = async (objectName: string, data: any): Promise<void> => {
    const className = persistantStore.selectedClassName?.() || 'gp50';
    await huniDBStore.storeObject(className, objectName, data);
  };

  const getObject = async (objectName: string): Promise<any | null> => {
    const className = persistantStore.selectedClassName?.() || 'gp50';
    return await huniDBStore.getObject(className, objectName);
  };

  const deleteObject = async (objectName: string): Promise<void> => {
    const className = persistantStore.selectedClassName?.() || 'gp50';
    await huniDBStore.deleteObject(className, objectName);
  };

  const listObjects = async (): Promise<string[]> => {
    const className = persistantStore.selectedClassName?.() || 'gp50';
    return await huniDBStore.listObjects(className);
  };

  // Filter options accessor (full list maintained by datastore)
  // Note: This retrieves filter VALUES (races, legs, grades), not filter CONFIGURATION
  // Filter configuration is retrieved via UnifiedFilterService.getFilterConfig()
  const getFilterOptions = async (context?: FilterContext): Promise<{ races: number[]; legOptions?: number[]; legs?: number[]; grades: number[]; raceToLegs?: Record<number, number[]> } | null> => {
    try {
      const className = persistantStore.selectedClassName?.() || 'gp50';
      
      // Determine context if not provided
      const filterContext = context || determineFilterContext();
      
      // Build object name based on context
      // Note: Filter VALUES are still stored as 'filters' for now
      // Context-specific filter VALUES could be stored as 'filters_dataset_{id}', etc. in the future
      // For now, we use the same 'filters' object for all contexts
      // The filter CONFIGURATION (which filters are available) is context-specific via UnifiedFilterService
      const objectName = 'filters';
      
      const opts = await huniDBStore.getObject(className, objectName);
      
      if (opts) {
        debug(`[UnifiedDataStore] Retrieved filter options for context: ${filterContext}`, {
          races: opts.races?.length || 0,
          legs: opts.legs?.length || 0,
          grades: opts.grades?.length || 0
        });
      }
      
      return opts || null;
    } catch (e) {
      debug('[UnifiedDataStore] getFilterOptions error:', (e as Error)?.message);
      return null;
    }
  };

  // Legacy compatibility
  const resetDataStore = async (): Promise<void> => {
    try {
      // Clear HuniDB first
      await huniDBStore.clearAllData();
      info('UnifiedDataStore: HuniDB cleared');
    } catch (error) {
      logError('Error clearing IndexedDB during reset:', error);
    }
    
    // Clear cache initialization flag to ensure re-initialization
    try {
      const { persistantStore } = await import('./persistantStore');
      persistantStore.setIsCacheInitialized(false);
      debug('UnifiedDataStore: Cleared cache initialization flag after reset');
    } catch (err) {
      warn('UnifiedDataStore: Failed to clear cache initialization flag:', err);
    }
    
    dispose();
    // Reset all signals to initial state
    setChartData({});
    setLoadingStates({});
    setErrorStates({});
    setMapDataFiltered(0);
    // Clear all maps
    dataCache.clear();
    overlayMemoryStorage.clear();
    categoryData.clear();
    categoryLoading.clear();
    categoryErrors.clear();
    timestampIndexes.clear();
    queryCache.clear();
    channelAvailability.clear();
    info('UnifiedDataStore: Store completely reset');
  };

  // Cache management
  const clearCache = (): void => {
    queryCache.clear();
    info('UnifiedDataStore: Cache cleared');
  };

  /** Set last missing channels for a chart type (used when returning empty/partial so UI shows "Missing channel(s): X" below chart). */
  const setLastMissingChannels = (chartType: ChartType, channels: string[]): void => {
    lastMissingChannelsByChartType[chartType] = channels || [];
  };

  /** Channels requested but not found (HuniDB or API) for the last fetch of this chart type. Used to show "Missing channel(s): X" below x-axis instead of partial data. */
  const getLastMissingChannels = (chartType: ChartType): string[] => {
    return lastMissingChannelsByChartType[chartType] || [];
  };

  // Clear cache entries for a specific data source
  const clearCacheForDataSource = (dataKey: string): void => {
    // Clear from queryCache (Map)
    const keysToDelete = [];
    for (const [key] of queryCache.entries()) {
      if (key.includes(dataKey)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => queryCache.delete(key));
    
    // Clear from categoryData (LRU Cache)
    const categoryKeysToDelete = categoryData.keys().filter(key => key.includes(dataKey));
    categoryKeysToDelete.forEach(key => categoryData.delete(key));
    
    // Clear from dataCache (LRU Cache)
    const dataKeysToDelete = dataCache.keys().filter(key => key.includes(dataKey));
    dataKeysToDelete.forEach(key => dataCache.delete(key));
    
    // CRITICAL: Also clear channelAvailability cache to force fresh API fetches
    // This prevents "previously missing" channels from being blocked for 5 minutes
    const channelKeysToDelete: string[] = [];
    for (const [key] of channelAvailability.entries()) {
      if (key.includes(dataKey) || dataKey.includes(key.split('_')[0])) {
        channelKeysToDelete.push(key);
      }
    }
    channelKeysToDelete.forEach(key => channelAvailability.delete(key));
    
    debug(`[clearCacheForDataSource] Cleared ${keysToDelete.length} query cache entries, ${categoryKeysToDelete.length} category cache entries, ${dataKeysToDelete.length} data cache entries, and ${channelKeysToDelete.length} channel availability entries for ${dataKey}`);
  };

  // Events implementation with proper caching
  const fetchEvents = async (className: string, projectId: number, datasetId: number): Promise<Event[]> => {
    // Always resolve events for the REQUESTED dataset; local events() is not keyed by dataset,
    // so we must not return early from it or HuniDB never gets populated for the current dataset
    // and getEventTimeRanges() cannot look up start/end times for map/time-series highlighting.

    // Check if events are cached in IndexedDB for this specific dataset
    try {
      const cachedEvents = await huniDBStore.queryEvents(className, {
        datasetId: String(datasetId),
        projectId: String(projectId)
      });
      if (cachedEvents && cachedEvents.length > 0) {
        debug(`[UnifiedDataStore] Events loaded from HuniDB cache for dataset ${datasetId}: ${cachedEvents.length} events`);
        setEvents(cachedEvents);
        return cachedEvents;
      }
    } catch (err) {
      debug(`[UnifiedDataStore] No cached events found in IndexedDB for dataset ${datasetId}:`, err);
    }
    
    // Check query cache to prevent duplicate API calls
    const cacheKey = `events_${className}_${projectId}_${datasetId}`;
    const cached = queryCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      debug(`[UnifiedDataStore] Events loaded from query cache: ${cached.data.length} events`);
      setEvents(cached.data);
      return cached.data;
    }
    
    // Only fetch from API if not cached
    setEventsLoading(true);
    setEventsError(null);
    
    try {
      const controller = new AbortController();
      
      // Build query parameters (timezone=UTC so start_time/end_time are unambiguous for storage and parsing)
      const params = new URLSearchParams({
        class_name: className,
        project_id: projectId.toString(),
        dataset_id: datasetId.toString(),
        timezone: 'UTC'
      });

      const url = `${apiEndpoints.app.events}?${params.toString()}`;
      
      info(`[UnifiedDataStore] Fetching events from API: ${url}`);
      
      const response = await fetchData(url, controller.signal);
      
      if (response.success && response.data) {
        const eventsData = response.data;
        info(`[UnifiedDataStore] Successfully fetched ${eventsData.length} events from API`);
        
        // Get sourceId from persistent store if available (from selected source_id)
        const sourceId = persistantStore.selectedSourceId();
        
        // Store in HuniDB with metadata from API request context
        await huniDBStore.storeEvents(className, eventsData, {
          datasetId: datasetId,
          projectId: projectId,
          sourceId: sourceId && sourceId > 0 ? sourceId : undefined
        });
        
        // Update local state
        setEvents(eventsData);
        
        // Cache the result
        queryCache.set(cacheKey, {
          data: eventsData,
          timestamp: Date.now()
        });
        
        return eventsData;
      } else {
        const errorMsg = response.message || 'Failed to fetch events';
        warn(`[UnifiedDataStore] Events API error: ${errorMsg}`);
        setEventsError(errorMsg);
        return [];
      }
    } catch (err) {
      const errorMsg = err instanceof Error 
        ? err.message 
        : (typeof err === 'string' 
          ? err 
          : (err && typeof err === 'object' && 'message' in err 
            ? String((err as any).message) 
            : 'Error fetching events'));
      logError(`[UnifiedDataStore] Error fetching events:`, err instanceof Error ? err : new Error(errorMsg));
      setEventsError(errorMsg);
      return [];
    } finally {
      setEventsLoading(false);
    }
  };

  /** Throttle key for preloadEventsForDate: class_project_dateNorm -> lastRun timestamp */
  const preloadEventsForDateLastRun = new Map<string, number>();
  const PRELOAD_EVENTS_THROTTLE_MS = 60000;
  const PRELOAD_EVENTS_CONCURRENCY = 3;

  /**
   * Preload events for all datasets for a given date into agg.events so MapSettings and filter
   * options see races/legs for the day when in day context (e.g. fleet map with date, no single dataset).
   * Uses GET /api/datasets/date/dataset_id then fetchEvents for each dataset. Non-blocking; throttled.
   */
  const preloadEventsForDate = async (className: string, projectId: number, date: string): Promise<void> => {
    const dateNorm = String(date).replace(/[-/]/g, '');
    const dateStr = dateNorm.length === 8
      ? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`
      : String(date);
    const throttleKey = `${className}_${projectId}_${dateNorm}`;
    const now = Date.now();
    const lastRun = preloadEventsForDateLastRun.get(throttleKey);
    if (lastRun != null && now - lastRun < PRELOAD_EVENTS_THROTTLE_MS) {
      debug('[UnifiedDataStore] preloadEventsForDate: skipped (throttled)', { className, projectId, dateStr });
      return;
    }
    preloadEventsForDateLastRun.set(throttleKey, now);

    try {
      const timezone = await getTimezoneForDate(className, projectId, dateStr);
      let url = `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}`;
      if (timezone) url += `&timezone=${encodeURIComponent(timezone)}`;
      const resp = await fetchData(url);
      const list = (resp && (resp as any).data) ?? (Array.isArray(resp) ? resp : []);
      if (!Array.isArray(list) || list.length === 0) {
        debug('[UnifiedDataStore] preloadEventsForDate: no datasets for date', { className, projectId, dateStr });
        return;
      }
      const datasetIds = list
        .map((row: any) => Number(row?.dataset_id ?? row?.datasetId ?? 0))
        .filter((id: number) => Number.isFinite(id) && id > 0);
      if (datasetIds.length === 0) {
        debug('[UnifiedDataStore] preloadEventsForDate: no valid dataset_ids', { className, projectId, dateStr });
        return;
      }
      debug('[UnifiedDataStore] preloadEventsForDate: loading events for', datasetIds.length, 'datasets', { className, projectId, dateStr });
      for (let i = 0; i < datasetIds.length; i += PRELOAD_EVENTS_CONCURRENCY) {
        const batch = datasetIds.slice(i, i + PRELOAD_EVENTS_CONCURRENCY);
        await Promise.all(batch.map((datasetId: number) => fetchEvents(className, projectId, datasetId)));
      }
      info('[UnifiedDataStore] preloadEventsForDate: completed', { className, projectId, dateStr, datasetCount: datasetIds.length });
    } catch (err) {
      debug('[UnifiedDataStore] preloadEventsForDate: error (non-blocking)', (err as Error)?.message);
    }
  };

  const getEvents = (): Event[] => {
    return events();
  };

  const getEventsByType = (eventType: string): Event[] => {
    return events().filter(event => event.event_type === eventType);
  };

  const getEventsByTimeRange = (startTime?: Date, endTime?: Date): Event[] => {
    if (!startTime && !endTime) {
      return events();
    }
    
    return events().filter(event => {
      const eventStart = new Date(event.start_time);
      const eventEnd = new Date(event.end_time);
      
      if (startTime && eventEnd < startTime) return false;
      if (endTime && eventStart > endTime) return false;
      
      return true;
    });
  };

  const getEventById = async (eventId: number): Promise<Event | null> => {
    try {
      const className = persistantStore.selectedClassName();
      if (!className) return null;
      // Pass datasetId and projectId to ensure correct event lookup
      const datasetId = persistantStore.selectedDatasetId();
      const projectId = persistantStore.selectedProjectId();
      return await huniDBStore.getEvent(className, eventId, datasetId, projectId);
    } catch (err) {
      logError(`[UnifiedDataStore] Error getting event by ID ${eventId}:`, err);
      return null;
    }
  };

  const getEventsByTypeFromIndexedDB = async (eventType: string): Promise<Event[]> => {
    try {
      const className = persistantStore.selectedClassName();
      if (!className) return [];
      return await huniDBStore.getEventsByType(className, eventType);
    } catch (err) {
      logError(`[UnifiedDataStore] Error getting events by type '${eventType}':`, err);
      return [];
    }
  };

  const getEventsInTimeRangeFromIndexedDB = async (startTime: string, endTime: string): Promise<Event[]> => {
    try {
      const className = persistantStore.selectedClassName();
      if (!className) return [];
      return await huniDBStore.getEventsInTimeRange(className, startTime, endTime);
    } catch (err) {
      logError(`[UnifiedDataStore] Error getting events in time range:`, err);
      return [];
    }
  };

  const getEventsFromIndexedDB = async (): Promise<Event[]> => {
    try {
      const className = persistantStore.selectedClassName();
      if (!className) {
        debug(`[UnifiedDataStore] No className available for getEventsFromHuniDB`);
        return [];
      }
      
      const events = await huniDBStore.getAllEvents(className);
      
      if (events && events.length > 0) {
        info(`[UnifiedDataStore] Retrieved ${events.length} events from HuniDB`);
        return events;
      }
      
      debug(`[UnifiedDataStore] No events found in IndexedDB`);
      return [];
    } catch (err) {
      logError(`[UnifiedDataStore] Error getting events from HuniDB:`, err);
      return [];
    }
  };

  const clearEvents = async (): Promise<void> => {
    try {
      const className = persistantStore.selectedClassName();
      if (className) {
        await huniDBStore.clearEvents(className);
      }
      setEvents([]);
      setEventsError(null);
      info(`[UnifiedDataStore] Cleared all events from HuniDB and local state`);
    } catch (err) {
      logError(`[UnifiedDataStore] Error clearing events:`, err);
    }
  };

  // Optimized methods for starttime/endtime queries by event_id
  const getEventTimeRange = async (eventId: number): Promise<{ starttime: string; endtime: string } | null> => {
    try {
      const className = persistantStore.selectedClassName();
      if (!className) return null;
      // Pass datasetId and projectId to ensure correct event lookup
      const datasetId = persistantStore.selectedDatasetId();
      const projectId = persistantStore.selectedProjectId();
      return await huniDBStore.getEventTimeRange(className, eventId, datasetId, projectId);
    } catch (err) {
      logError(`[UnifiedDataStore] Error getting event time range for ID ${eventId}:`, err);
      return null;
    }
  };

  const getEventTimeRanges = async (eventIds: number[]): Promise<Map<number, { starttime: string; endtime: string }>> => {
    try {
      const className = persistantStore.selectedClassName?.() || 'gp50';
      // Pass datasetId and projectId to ensure correct event lookup
      const datasetId = persistantStore.selectedDatasetId();
      const projectId = persistantStore.selectedProjectId();
      return await huniDBStore.getEventTimeRanges(className, eventIds, datasetId, projectId);
    } catch (err) {
      logError(`[UnifiedDataStore] Error getting event time ranges for IDs:`, err);
      return new Map();
    }
  };

  // Get cached dataset metadata for a class from HuniDB (meta.datasets)
  const getCachedDatasetsForClass = async (className?: string): Promise<DatasetMetadata[]> => {
    try {
      const effectiveClass = className || persistantStore.selectedClassName?.() || 'gp50';
      if (!effectiveClass) {
        debug('[UnifiedDataStore] getCachedDatasetsForClass: no className available');
        return [];
      }
      const datasets = await huniDBStore.getCachedDatasets(effectiveClass);
      info(`[UnifiedDataStore] getCachedDatasetsForClass(${effectiveClass}) returned ${datasets.length} entries`);
      return datasets;
    } catch (err) {
      logError('[UnifiedDataStore] Error getting cached datasets for class:', err);
      return [];
    }
  };

  // Update mapdata with event_id assignments using worker
  // updateMapdataWithEventIds removed - map.data table no longer used
  const updateMapdataWithEventIds = async (_className: string, _sourceId: string, _selectedEvents: number[] | Array<{ event_id: number; event_type: string; start_time: string; end_time: string; tags: any }>): Promise<void> => {
    debug(`[UnifiedDataStore] updateMapdataWithEventIds: map.data table no longer used, skipping update`);
    return;
  };

  // Density optimized cache cleanup
  const clearDensityOptimizedCache = async (className?: string, datasetId?: string, projectId?: string, sourceId?: string) => {
    try {
      if (className) {
        // Clear density optimized data by key prefix
        const keyPrefix = datasetId && projectId && sourceId 
          ? `densityOpt_${datasetId}_${projectId}_${sourceId}_`
          : undefined;
        await huniDBStore.clearDensityOptimizedData(className, keyPrefix);
        debug(`[UnifiedDataStore] Cleared density optimized cache for ${className}${datasetId ? `_${datasetId}_${projectId}_${sourceId}` : ''}`);
      } else {
        // Clear all entries (requires className)
        // If no className provided, we can't clear - log warning
        warn(`[UnifiedDataStore] Cannot clear density optimized cache without className`);
      }
    } catch (error) {
      logError('[UnifiedDataStore] Error clearing density optimized cache:', error);
    }
  };

  // Clear all cache for a specific dataset
  const clearDatasetCache = async (className: string, datasetId: string): Promise<void> => {
    try {
      // Clear HuniDB cache
      await huniDBStore.clearDatasetCache(className, datasetId);
      
      // Clear in-memory caches
      const dataKey = `${className}_${datasetId}`;
      clearCacheForDataSource(dataKey);
      
      // Also clear by dataset_id pattern
      const keysToDelete: string[] = [];
      for (const [key] of dataCache.entries()) {
        if (key.includes(`_${datasetId}_`) || key.endsWith(`_${datasetId}`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => {
        dataCache.delete(key);
        timestampIndexes.delete(key);
      });
      
      info(`[UnifiedDataStore] Cleared all cache for dataset ${datasetId} in ${className}`);
    } catch (error) {
      logError(`[UnifiedDataStore] Error clearing cache for dataset ${datasetId}:`, error);
    }
  };

  // Validate dataset cache by checking date_modified against server
  // Also discovers new datasets from the API that aren't in hunidb yet
  const validateDatasetCache = async (
    className: string,
    projectId: number
  ): Promise<{ invalidated: number[]; checked: number; discovered: number }> => {
    // Skip on mobile devices
    if (isMobileDevice()) {
      debug('[UnifiedDataStore] Skipping dataset cache validation on mobile device');
      return { invalidated: [], checked: 0, discovered: 0 };
    }

    const invalidated: number[] = [];
    let checked = 0;
    let discovered = 0;

    try {
      // STEP 1: Discover new datasets from API that aren't in hunidb yet
      // Fetch all sources for the project to get all datasets
      try {
        const sourcesResponse = await fetchData(
          `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`
        );

        if (sourcesResponse?.success && Array.isArray(sourcesResponse.data)) {
          const sources = sourcesResponse.data;
          info(`[UnifiedDataStore] Discovering new datasets from ${sources.length} sources for class ${className}, project ${projectId}`);

          // Get all cached datasets for comparison
          const cachedDatasets = await huniDBStore.getCachedDatasets(className);
          const cachedDatasetIds = new Set(
            cachedDatasets
              .filter(d => String(d.project_id) === String(projectId))
              .map(d => String(d.dataset_id))
          );

          // Fetch datasets for each source (with minimal filters to get all datasets)
          const CONCURRENCY_LIMIT = 3; // Lower concurrency for discovery to avoid overwhelming the server
          for (let i = 0; i < sources.length; i += CONCURRENCY_LIMIT) {
            const batch = sources.slice(i, i + CONCURRENCY_LIMIT);
            
            await Promise.all(
              batch.map(async (source: any) => {
                try {
                  const sourceId = source.source_id;
                  // Fetch all datasets for this source (no year/event filters to get everything)
                  const datasetsResponse = await fetchData(
                    `${apiEndpoints.app.datasets}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&year_name=ALL&event_name=ALL`
                  );

                  if (datasetsResponse?.success && Array.isArray(datasetsResponse.data)) {
                    const apiDatasets = datasetsResponse.data;
                    
                    // Check each dataset from API
                    for (const apiDataset of apiDatasets) {
                      const datasetId = String(apiDataset.dataset_id);
                      
                      // If this dataset is not in hunidb, add it to meta.datasets
                      if (!cachedDatasetIds.has(datasetId)) {
                        try {
                          // Use date_modified from the dataset list response if available, otherwise use current time
                          const dateModified = apiDataset.date_modified 
                            ? new Date(apiDataset.date_modified).getTime() 
                            : Date.now();
                          
                          // Add to meta.datasets with minimal metadata (no data yet, so row_count=0, timestamps=0)
                          try {
                            const db = await storage.getDatabase(className);
                            await db.exec(
                            `INSERT INTO "meta.datasets" 
                             (dataset_id, project_id, date, source_id, class_name, created_at, row_count, first_timestamp, last_timestamp, date_modified, last_viewed_date) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT(dataset_id) DO NOTHING`,
                            [
                              datasetId,
                              String(projectId),
                              apiDataset.date || '',
                              String(sourceId),
                              className,
                              Date.now(),
                              0, // row_count - will be updated when data is stored
                              0, // first_timestamp - will be updated when data is stored
                              0, // last_timestamp - will be updated when data is stored
                              dateModified,
                              Date.now()
                            ]
                          );
                          } catch (dbError: any) {
                            // Handle mobile device error gracefully
                            if (dbError?.message?.includes('mobile devices')) {
                              debug(`[UnifiedDataStore] Skipping meta.datasets insert on mobile device`);
                            } else {
                              debug(`[UnifiedDataStore] Could not insert dataset metadata:`, dbError);
                            }
                          }
                          
                          discovered++;
                          info(`[UnifiedDataStore] Discovered new dataset ${datasetId} (source ${sourceId}, date ${apiDataset.date}) - added to meta.datasets`);
                        } catch (discoverError) {
                          warn(`[UnifiedDataStore] Error discovering dataset ${datasetId}:`, discoverError);
                        }
                      }
                    }
                  }
                } catch (sourceError) {
                  warn(`[UnifiedDataStore] Error fetching datasets for source ${source.source_id}:`, sourceError);
                }
              })
            );
          }

          if (discovered > 0) {
            info(`[UnifiedDataStore] Discovered ${discovered} new datasets from API`);
          }
        }
      } catch (discoverError) {
        warn(`[UnifiedDataStore] Error during dataset discovery:`, discoverError);
        // Continue with validation even if discovery fails
      }

      // STEP 2: Validate existing cached datasets
      // Get all cached datasets for the class (refresh after discovery)
      const cachedDatasets = await huniDBStore.getCachedDatasets(className);
      
      // Filter to current project if projectId is provided
      const projectDatasets = projectId > 0
        ? cachedDatasets.filter(d => String(d.project_id) === String(projectId))
        : cachedDatasets;

      if (projectDatasets.length === 0) {
        debug(`[UnifiedDataStore] No cached datasets found for class ${className}${projectId > 0 ? `, project ${projectId}` : ''}`);
        return { invalidated: [], checked: 0, discovered };
      }

      info(`[UnifiedDataStore] Validating ${projectDatasets.length} cached datasets for class ${className}${projectId > 0 ? `, project ${projectId}` : ''}`);

      // Check each dataset's date_modified against server
      // Use Promise.all with reasonable concurrency (limit to 5 concurrent requests)
      const CONCURRENCY_LIMIT = 5;
      for (let i = 0; i < projectDatasets.length; i += CONCURRENCY_LIMIT) {
        const batch = projectDatasets.slice(i, i + CONCURRENCY_LIMIT);
        
        await Promise.all(
          batch.map(async (dataset) => {
            const datasetId = dataset.dataset_id;
            checked++;

            try {
              // Fetch server date_modified
              const datasetInfoResponse = await fetchData(
                `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(dataset.project_id)}&dataset_id=${encodeURIComponent(datasetId)}`
              );

              if (datasetInfoResponse?.success && datasetInfoResponse?.data?.date_modified) {
                const serverDateModified = new Date(datasetInfoResponse.data.date_modified).getTime();
                const cachedDateModified = dataset.dateModified || dataset.date_modified || 0;

                if (serverDateModified > cachedDateModified) {
                  // Server is newer - invalidate cache
                  info(
                    `[UnifiedDataStore] Dataset ${datasetId} was modified on server (${new Date(serverDateModified).toISOString()}) after cache (${new Date(cachedDateModified).toISOString()}) - invalidating cache`
                  );
                  await clearDatasetCache(className, String(datasetId));
                  invalidated.push(Number(datasetId));
                } else {
                  // Update cached date_modified to match server (in case it was missing or slightly off)
                  try {
                    const db = await storage.getDatabase(className);
                    await db.exec(
                      `UPDATE "meta.datasets" SET date_modified = ? WHERE dataset_id = ?`,
                      [serverDateModified, datasetId]
                    );
                  } catch (e: unknown) {
                    // Handle mobile device error gracefully
                    if ((e as Error)?.message?.includes('mobile devices')) {
                      debug(`[UnifiedDataStore] Skipping date_modified update on mobile device`);
                    } else {
                      debug(`[UnifiedDataStore] Could not update cached date_modified for dataset ${datasetId}:`, e);
                    }
                  }
                }
              } else if (datasetInfoResponse?.success === false || !datasetInfoResponse?.data) {
                // Check if it's a network/server error - these are expected and shouldn't block validation
                const status = datasetInfoResponse?.status || 0;
                const isServerError = status === 502 || status === 503 || status === 504; // Bad Gateway, Service Unavailable, Gateway Timeout
                const isNetworkError = datasetInfoResponse?.type === 'NetworkError' || 
                                     datasetInfoResponse?.error?.includes('Network error') ||
                                     datasetInfoResponse?.error?.includes('Failed to fetch') ||
                                     datasetInfoResponse?.message?.includes('502') ||
                                     datasetInfoResponse?.message?.includes('503') ||
                                     datasetInfoResponse?.message?.includes('504');
                
                if (isServerError || isNetworkError) {
                  // Server/network errors are expected (server down, connectivity issues) - log at debug level
                  debug(`[UnifiedDataStore] Server/network error validating dataset ${datasetId} (server may be unavailable, status: ${status}):`, datasetInfoResponse?.message || datasetInfoResponse?.error);
                } else {
                  // Dataset doesn't exist on server - clear cache
                  info(`[UnifiedDataStore] Dataset ${datasetId} not found on server - clearing cache`);
                  await clearDatasetCache(className, String(datasetId));
                  invalidated.push(Number(datasetId));
                }
              } else {
                // API call succeeded but date_modified missing - log warning
                warn(`[UnifiedDataStore] Dataset ${datasetId} exists but missing date_modified on server`);
              }
            } catch (error) {
              // Check if it's a network/server error
              const errorMessage = (error as Error)?.message || String(error);
              const isServerError = errorMessage.includes('502') || errorMessage.includes('503') || errorMessage.includes('504') || 
                                   errorMessage.includes('Bad Gateway') || errorMessage.includes('Service Unavailable') || 
                                   errorMessage.includes('Gateway Timeout');
              const isNetworkError = errorMessage.includes('Network error') || 
                                   errorMessage.includes('Failed to fetch') ||
                                   errorMessage.includes('ERR_FAILED') ||
                                   (error as any)?.name === 'NetworkError' ||
                                   (error as any)?.type === 'NetworkError';
              
              if (isServerError || isNetworkError) {
                // Server/network errors are expected - log at debug level, don't block validation
                debug(`[UnifiedDataStore] Server/network error validating dataset ${datasetId} (server may be unavailable):`, errorMessage);
              } else {
                // Other errors should be logged as warnings
                warn(`[UnifiedDataStore] Error validating dataset ${datasetId}:`, error);
              }
            }
          })
        );
      }

      info(
        `[UnifiedDataStore] Cache validation complete: checked ${checked} datasets, invalidated ${invalidated.length}, discovered ${discovered} new datasets`
      );
    } catch (error) {
      logError(`[UnifiedDataStore] Error during cache validation:`, error);
    }

    return { invalidated, checked, discovered };
  };

  // Live mode / Redis data methods
  
  /**
   * Check if currently in live mode
   * Live mode is only true if:
   * 1. The liveMode signal is enabled, AND
   * 2. Redis has data that is less than 1 hour old
   */
  const isLiveMode = (): boolean => {
    // First check if live mode signal is enabled
    if (!liveMode()) {
      return false;
    }
    
    // Check cached timestamp (avoid blocking on every call)
    const now = Date.now();
    const cacheAge = now - cachedLatestRedisTimestampTime;
    
    // If cache is fresh, use it
    if (cacheAge < REDIS_TIMESTAMP_CACHE_TTL && cachedLatestRedisTimestamp !== null) {
      const oneHourAgo = now - (60 * 60 * 1000);
      return cachedLatestRedisTimestamp > oneHourAgo;
    }
    
    // Cache is stale or missing - return false for now (will be updated asynchronously)
    // This prevents blocking the main thread, but means we might miss live mode for a brief moment
    // The cache will be updated when we actually fetch Redis data
    return false;
  };
  
  /**
   * Update the cached latest Redis timestamp
   * This should be called when we fetch Redis data or check source status
   */
  const updateLatestRedisTimestamp = async (): Promise<void> => {
    try {
      // Get streaming sources from API
      const streamResponse = await fetchData(apiEndpoints.stream.sources);
      if (!streamResponse.success || !Array.isArray(streamResponse.data)) {
        cachedLatestRedisTimestamp = null;
        cachedLatestRedisTimestampTime = Date.now();
        return;
      }
      
      const sourceNames = streamResponse.data
        .map((s: any) => s.source_name)
        .filter((name: string) => name);
      
      if (sourceNames.length === 0) {
        cachedLatestRedisTimestamp = null;
        cachedLatestRedisTimestampTime = Date.now();
        return;
      }
      
      // Get latest timestamp from each source's status endpoint
      let latestTimestamp: number | null = null;
      for (const sourceName of sourceNames) {
        try {
          const statusResponse = await fetchData(apiEndpoints.stream.sourceStatus(sourceName));
          if (statusResponse.success && statusResponse.data?.latest_timestamp) {
            const ts = statusResponse.data.latest_timestamp;
            if (ts && (!latestTimestamp || ts > latestTimestamp)) {
              latestTimestamp = ts;
            }
          }
        } catch (err) {
          // Skip this source if status check fails
          debug(`[UnifiedDataStore] Error checking status for source ${sourceName}:`, err);
        }
      }
      
      // Update cache
      cachedLatestRedisTimestamp = latestTimestamp;
      cachedLatestRedisTimestampTime = Date.now();
      
      if (latestTimestamp !== null) {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const isRecent = latestTimestamp > oneHourAgo;
        debug(`[UnifiedDataStore] Updated latest Redis timestamp cache: ${latestTimestamp} (${isRecent ? 'recent' : 'stale'})`);
      }
    } catch (error) {
      debug(`[UnifiedDataStore] Error updating latest Redis timestamp:`, error);
      cachedLatestRedisTimestamp = null;
      cachedLatestRedisTimestampTime = Date.now();
    }
  };

  /**
   * Fetch historical data from Redis for given source names
   * Fetches last 1 hour (configurable) and stores in IndexedDB as mapdata
   */
  const fetchRedisHistoricalData = async (
    sourceNames: string[],
    startTime: number,
    endTime: number
  ): Promise<void> => {
    try {
      debug('[UnifiedDataStore] 🔵 fetchRedisHistoricalData CALLED', {
        sourceCount: sourceNames.length,
        sourceNames,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationHours: (endTime - startTime) / (60 * 60 * 1000)
      });

      const className = persistantStore.selectedClassName();

      if (!className) {
        warn('[UnifiedDataStore] Cannot fetch Redis data without className');
        return;
      }

      // Map channels needed for map rendering
      // Note: timestamp and Datetime are automatically included in MergedDataPoint from streamingDataService
      // Use defaultChannelsStore for channel names
      const channels = [
        defaultChannelsStore.latName(),
        defaultChannelsStore.lngName(),
        defaultChannelsStore.hdgName(),
        defaultChannelsStore.bspName(),
        'Maneuver_type'
      ];
      
      // Fetch data for each source_name
      for (const sourceName of sourceNames) {
        try {
          debug(`[UnifiedDataStore] Processing source "${sourceName}"`, {
            fleetSourcesReady: sourcesStore.isReady(),
            allSources: sourcesStore.sources()?.map(s => ({ id: s.source_id, name: s.source_name }))
          });

          // Get source_id from source_name for HuniDB storage
          const sourceId = sourcesStore.getSourceId(sourceName);
          if (!sourceId) {
            warn(`[UnifiedDataStore] Could not map source_name "${sourceName}" to source_id, skipping`, {
              availableSources: sourcesStore.sources()?.map(s => s.source_name)
            });
            continue;
          }

          debug(`[UnifiedDataStore] Fetching Redis data for source "${sourceName}" (source_id: ${sourceId})`, {
            channels,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString()
          });

          // Fetch merged data from Redis using source_name
          const mergedData = await streamingDataService.fetchMergedData(
            sourceName,
            channels,
            startTime,
            endTime
          );

          debug(`[UnifiedDataStore] Redis fetch result for source "${sourceName}"`, {
            dataLength: mergedData.length,
            samplePoint: mergedData.length > 0 ? Object.keys(mergedData[0]) : []
          });

          if (mergedData.length === 0) {
            debug(`[UnifiedDataStore] No Redis data found for source "${sourceName}"`);
            continue;
          }

          // Ensure data is sorted by timestamp (CRITICAL for map rendering)
          mergedData.sort((a, b) => a.timestamp - b.timestamp);

          // Update cached latest Redis timestamp (use the latest timestamp from fetched data)
          const latestTs = mergedData.length > 0 ? mergedData[mergedData.length - 1]?.timestamp : null;
          if (latestTs && (!cachedLatestRedisTimestamp || latestTs > cachedLatestRedisTimestamp)) {
            cachedLatestRedisTimestamp = latestTs;
            cachedLatestRedisTimestampTime = Date.now();
          }

          debug(`[UnifiedDataStore] About to store ${mergedData.length} points for source "${sourceName}"`, {
            samplePoint: mergedData.length > 0 ? Object.keys(mergedData[0]) : [],
            firstTimestamp: mergedData.length > 0 ? mergedData[0].timestamp : null,
            lastTimestamp: mergedData.length > 0 ? mergedData[mergedData.length - 1].timestamp : null
          });

          // Store in IndexedDB as mapdata
          try {
            await storeRedisDataAsMapdata(sourceName, mergedData);
            debug(`[UnifiedDataStore] Successfully called storeRedisDataAsMapdata for source "${sourceName}"`);
          } catch (storeErr) {
            logError(`[UnifiedDataStore] Error in storeRedisDataAsMapdata for source "${sourceName}":`, storeErr);
            throw storeErr;
          }

          debug(`[UnifiedDataStore] Fetched and stored ${mergedData.length} points for source "${sourceName}"`);
        } catch (err) {
          logError(`[UnifiedDataStore] Error fetching Redis data for source "${sourceName}":`, err);
        }
      }
    } catch (err) {
      logError('[UnifiedDataStore] Error in fetchRedisHistoricalData:', err);
      throw err;
    }
  };

  /**
   * Store Redis data in IndexedDB as mapdata
   * Maps source_name to source_id for storage
   */
  const storeRedisDataAsMapdata = async (
    sourceName: string,
    dataPoints: any[]
  ): Promise<void> => {
    // Create a unique key for this storage operation
    const storageKey = `storeRedis_${sourceName}`;
    
    // Check if storage is already in progress for this source
    if (ongoingStorageOps.has(storageKey)) {
      debug(`[UnifiedDataStore] Storage already in progress for source "${sourceName}", skipping duplicate call`);
      return;
    }
    
    // Mark storage as in progress
    ongoingStorageOps.add(storageKey);
    
    try {
      debug(`[UnifiedDataStore] 🟢 storeRedisDataAsMapdata CALLED`, {
        sourceName,
        dataPointsLength: dataPoints?.length || 0,
        hasData: !!dataPoints && dataPoints.length > 0
      });

      if (!dataPoints || dataPoints.length === 0) {
        debug(`[UnifiedDataStore] No data points to store for source "${sourceName}"`);
        return;
      }

      const className = persistantStore.selectedClassName();
      const projectId = String(persistantStore.selectedProjectId() || '0');
      // storeRedisDataAsMapdata is ONLY called for Redis data, which is always live mode
      // Therefore, always use dataset_id = 0 for storage (Redis data is always stored with dataset_id 0)
      const datasetId = '0';

      debug(`[UnifiedDataStore] Store parameters`, {
        className,
        projectId,
        datasetId,
        sourceName,
        note: 'Redis data always stored with dataset_id = 0'
      });

      if (!className) {
        warn('[UnifiedDataStore] Cannot store Redis data without className');
        return;
      }

      // Get source_id from source_name
      const sourceId = sourcesStore.getSourceId(sourceName);
      debug(`[UnifiedDataStore] Source ID mapping`, {
        sourceName,
        sourceId,
        fleetSourcesReady: sourcesStore.isReady()
      });

      if (!sourceId) {
        warn(`[UnifiedDataStore] Could not map source_name "${sourceName}" to source_id, cannot store`);
        return;
      }

      // Filter out data points without valid Datetime field (CRITICAL for time-series data)
      const dataWithDatetime = dataPoints.filter(point => {
        const hasTimestamp = point.timestamp != null && !isNaN(Number(point.timestamp));
        const hasDatetime = point.Datetime != null && !isNaN(new Date(point.Datetime).getTime());
        return hasTimestamp || hasDatetime;
      });
      
      if (dataWithDatetime.length === 0) {
        warn(`[UnifiedDataStore] No data points with valid Datetime/timestamp for source "${sourceName}"`);
        return;
      }
      
      // Ensure all points have Datetime field (derive from timestamp if missing)
      const normalizedData = dataWithDatetime.map(point => {
        if (!point.Datetime && point.timestamp) {
          return {
            ...point,
            Datetime: new Date(point.timestamp).toISOString()
          };
        }
        return point;
      });

      // Ensure data is sorted by timestamp (CRITICAL)
      const sortedData = [...normalizedData].sort((a, b) => {
        const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
        const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
        return tsA - tsB;
      });

      // Extract channels from data
      const channels = new Set<string>();
      for (const point of sortedData) {
        for (const key in point) {
          if (key !== 'timestamp' && key !== 'Datetime' && key !== 'source_id' && key !== 'source_name') {
            channels.add(key);
          }
        }
      }

      const channelArray = Array.from(channels);
      if (channelArray.length === 0) {
        warn(`[UnifiedDataStore] No channels found in data for source "${sourceName}"`);
        return;
      }

      debug(`[UnifiedDataStore] 🟡 About to store data in IndexedDB`, {
        sourceName,
        sourceId,
        dataLength: sortedData.length,
        channels: channelArray,
        className,
        projectId,
        datasetId
      });

      // Store using existing storeDataInIndexedDB method
      // Note: storeDataInIndexedDB will normalize className to lowercase internally
      const normalizedClassName = className.toLowerCase();
      debug(`[UnifiedDataStore] 🟠 Calling storeDataInIndexedDB`, {
        dataSource: 'mapdata',
        className: normalizedClassName, // Show normalized version in log
        originalClassName: className,
        datasetId,
        projectId,
        sourceId: String(sourceId),
        channelCount: channelArray.length,
        channels: channelArray,
        dataPointCount: sortedData.length
      });
      
      try {
        await storeDataInIndexedDB(
          'mapdata',
          className, // storeDataInIndexedDB will normalize this internally
          Number(datasetId),
          Number(projectId),
          Number(sourceId),
          channelArray,
          sortedData
        );
        debug(`[UnifiedDataStore] Successfully stored ${sortedData.length} Redis data points as mapdata for source "${sourceName}" (source_id: ${sourceId}, dataset_id: ${datasetId})`);
      } catch (storeErr) {
        logError(`[UnifiedDataStore] Error in storeDataInIndexedDB for source "${sourceName}":`, storeErr);
        throw storeErr;
      }
      
      // Clear the "no data" flag if we successfully stored data
      if (sourcesWithNoData.has(sourceName)) {
        sourcesWithNoData.delete(sourceName);
        noDataTimestamps.delete(sourceName);
        debug(`[UnifiedDataStore] Cleared "no data" flag for source "${sourceName}" after successful storage`);
      }
    } catch (err) {
      logError(`[UnifiedDataStore] Error storing Redis data as mapdata for source "${sourceName}":`, err);
      throw err;
    } finally {
      // Always remove the lock when done
      ongoingStorageOps.delete(storageKey);
    }
  };

  /**
   * Detect gaps in data and automatically refetch missing data from Redis
   * Gap threshold: 10 seconds (configurable)
   */
  const detectGapsAndRefetch = async (
    sourceId: string,
    maxGapMs: number = 10000
  ): Promise<void> => {
    try {
      const className = persistantStore.selectedClassName();
      const _projectId = String(persistantStore.selectedProjectId() || '0');
      // In live mode, always use dataset_id = 0 for gap detection queries
      const isLive = liveMode();
      const _datasetId = isLive ? '0' : String(persistantStore.selectedDatasetId() || '0');

      if (!className) {
        return;
      }

      // Get source_name from source_id
      const sourceName = sourcesStore.getSourceName(Number(sourceId));
      if (!sourceName) {
        debug(`[UnifiedDataStore] Could not map source_id ${sourceId} to source_name for gap detection`);
        return;
      }

      // Get existing data from HuniDB cache
      const existingData = await getDataFromIndexedDB('mapdata', className, sourceId);
      
      if (existingData.length < 2) {
        // Need at least 2 points to detect gaps
        return;
      }

      // Sort by timestamp (CRITICAL)
      const sortedData = [...existingData].sort((a, b) => {
        const tsA = a.timestamp || (a.Datetime instanceof Date ? a.Datetime.getTime() : new Date(a.Datetime).getTime());
        const tsB = b.timestamp || (b.Datetime instanceof Date ? b.Datetime.getTime() : new Date(b.Datetime).getTime());
        return tsA - tsB;
      });

      // Detect gaps
      const gaps: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < sortedData.length - 1; i++) {
        const current = sortedData[i];
        const next = sortedData[i + 1];
        
        const currentTs = current.timestamp || (current.Datetime instanceof Date ? current.Datetime.getTime() : new Date(current.Datetime).getTime());
        const nextTs = next.timestamp || (next.Datetime instanceof Date ? next.Datetime.getTime() : new Date(next.Datetime).getTime());
        
        const gap = nextTs - currentTs;
        if (gap > maxGapMs) {
          gaps.push({
            start: currentTs + 1, // Start 1ms after current point
            end: nextTs - 1       // End 1ms before next point
          });
        }
      }

      if (gaps.length === 0) {
        return; // No gaps found
      }

      debug(`[UnifiedDataStore] Detected ${gaps.length} gaps for source "${sourceName}"`, gaps);

      // Fetch missing data for each gap
      // Use defaultChannelsStore for channel names
      const channels = [
        defaultChannelsStore.latName(),
        defaultChannelsStore.lngName(),
        defaultChannelsStore.hdgName(),
        defaultChannelsStore.cogName(),
        defaultChannelsStore.sogName(),
        defaultChannelsStore.bspName(),
        defaultChannelsStore.twaName(),
        defaultChannelsStore.twsName(),
        defaultChannelsStore.twdName(),
        'source_name'
      ];
      
      for (const gap of gaps) {
        try {
          const gapData = await streamingDataService.fetchMergedData(
            sourceName,
            channels,
            gap.start,
            gap.end
          );

          if (gapData.length > 0) {
            // Store the gap data
            await storeRedisDataAsMapdata(sourceName, gapData);
            debug(`[UnifiedDataStore] Filled gap for source "${sourceName}": ${gapData.length} points between ${new Date(gap.start).toISOString()} and ${new Date(gap.end).toISOString()}`);
          }
        } catch (err) {
          warn(`[UnifiedDataStore] Error fetching gap data for source "${sourceName}":`, err);
        }
      }
    } catch (err) {
      logError(`[UnifiedDataStore] Error in detectGapsAndRefetch for source ${sourceId}:`, err);
    }
  };

  // Cache cleanup function
  const performCacheCleanup = (): void => {
    const now = Date.now();
    let cleanedCount = 0;
    
    // Clean up queryCache - remove expired entries
    for (const [key, value] of queryCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        queryCache.delete(key);
        cleanedCount++;
      }
    }
    
    // Clean up noDataTimestamps - remove expired entries
    for (const [sourceName, timestamp] of noDataTimestamps.entries()) {
      if (now - timestamp > NO_DATA_CACHE_TTL) {
        sourcesWithNoData.delete(sourceName);
        noDataTimestamps.delete(sourceName);
        cleanedCount++;
      }
    }
    
    // Clean up dataCache - remove entries older than 1 hour
    // Also clean up corresponding timestampIndexes entries
    const dataKeysToDelete: string[] = [];
    for (const key of dataCache.keys()) {
      const cached = dataCache.get(key);
      if (cached && (now - cached.timestamp > DATA_CACHE_TTL)) {
        dataKeysToDelete.push(key);
      }
    }
    dataKeysToDelete.forEach(key => {
      dataCache.delete(key);
      timestampIndexes.delete(key);
      cleanedCount++;
    });
    
    if (cleanedCount > 0) {
      debug(`[UnifiedDataStore] Cache cleanup: Removed ${cleanedCount} expired entries`);
    }
  };
  
  // Start cache cleanup task
  const startCacheCleanup = (): void => {
    if (cacheCleanupIntervalId !== null) {
      // Already running
      return;
    }
    cacheCleanupIntervalId = setInterval(performCacheCleanup, CACHE_CLEANUP_INTERVAL);
    debug('[UnifiedDataStore] Cache cleanup task started');
  };
  
  // Stop cache cleanup task
  const stopCacheCleanup = (): void => {
    if (cacheCleanupIntervalId !== null) {
      clearInterval(cacheCleanupIntervalId);
      cacheCleanupIntervalId = null;
      debug('[UnifiedDataStore] Cache cleanup task stopped');
    }
  };
  
  // Start cleanup on store creation
  startCacheCleanup();

  /**
   * Load map data for a dataset to hunidb
   * This ensures map data is available for filtering even when map components aren't rendered
   * @param className - Class name (e.g., 'gp50')
   * @param projectId - Project ID
   * @param datasetId - Dataset ID
   */
  const loadMapDataForDataset = async (
    className: string,
    projectId: number,
    datasetId: number
  ): Promise<void> => {
    try {
      // Normalize className to lowercase
      const normalizedClassName = className.toLowerCase();

      // Fetch dataset info to get source_name
      const datasetInfoResponse = await fetchData(
        `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`
      );

      if (!datasetInfoResponse?.success || !datasetInfoResponse?.data) {
        debug('[UnifiedDataStore] Failed to fetch dataset info for map data loading:', {
          className,
          projectId,
          datasetId,
          response: datasetInfoResponse
        });
        return;
      }

      const datasetInfo = datasetInfoResponse.data;
      const sourceName = datasetInfo.source_name;

      if (!sourceName) {
        warn('[UnifiedDataStore] Dataset info missing source_name, cannot load map data:', {
          className,
          projectId,
          datasetId
        });
        return;
      }

      // Resolve source_id from source_name (sourcesStore may be empty when e.g. opening Events directly)
      let sourceId: number | undefined;
      const resolvedSourceId = sourcesStore.getSourceId(sourceName);
      if (resolvedSourceId) {
        sourceId = Number(resolvedSourceId);
      }
      if ((!sourceId || sourceId === 0) && datasetInfo.date) {
        const dateForApi = String(datasetInfo.date).replace(/[-/]/g, '');
        try {
          const dayListRes = await fetchData(
            `${apiEndpoints.app.datasets}/date/dataset_id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateForApi)}`
          );
          if (dayListRes?.success && Array.isArray(dayListRes.data)) {
            const row = (dayListRes.data as { dataset_id: number; source_id: number; source_name: string }[]).find(
              (r) => r.dataset_id === datasetId
            );
            if (row?.source_id) {
              sourceId = Number(row.source_id);
              debug('[UnifiedDataStore] Resolved source_id from date/dataset_id:', { sourceName, sourceId });
            }
          }
        } catch (e) {
          debug('[UnifiedDataStore] Fallback date/dataset_id for source_id failed:', e);
        }
      }

      if (!sourceId || sourceId === 0) {
        warn('[UnifiedDataStore] Could not resolve source_id for source_name, cannot load map data:', {
          className,
          projectId,
          datasetId,
          sourceName
        });
        return;
      }

      // Check if map data already exists in hunidb
      try {
        const availableChannels = await huniDBStore.getAvailableChannels(
          normalizedClassName,
          datasetId,
          projectId,
          sourceId,
          ['mapdata']
        );

        // If we have channels (or any data), map data already exists
        if (availableChannels.length > 0) {
          debug('[UnifiedDataStore] Map data already exists in hunidb, skipping load:', {
            className,
            projectId,
            datasetId,
            sourceId,
            channelCount: availableChannels.length
          });
          return;
        }
      } catch (checkError) {
        // If check fails, proceed with loading (might be first time)
        debug('[UnifiedDataStore] Error checking for existing map data, proceeding with load:', checkError);
      }

      // Map data doesn't exist, fetch and store it
      debug('[UnifiedDataStore] Loading map data for dataset:', {
        className,
        projectId,
        datasetId,
        sourceName,
        sourceId
      });

      await unifiedDataAPI.fetchAndStoreMapData({
        className: className, // Use original className for API
        projectId: projectId,
        datasetId: datasetId,
        sourceName: sourceName,
        sourceId: sourceId
      });

      info('[UnifiedDataStore] Successfully loaded map data for dataset:', {
        className,
        projectId,
        datasetId,
        sourceId
      });
    } catch (error) {
      // Log error but don't throw - this is a background operation
      logError('[UnifiedDataStore] Error loading map data for dataset:', {
        className,
        projectId,
        datasetId,
        error
      });
    }
  };

  // Cleanup
  const dispose = () => {
    // Stop cache cleanup task
    stopCacheCleanup();
    
    categoryData.clear();
    categoryLoading.clear();
    categoryErrors.clear();
    timestampIndexes.clear();
    dataCache.clear();
    overlayMemoryStorage.clear();
    ongoingStorageOps.clear();
    sourcesWithNoData.clear();
    noDataTimestamps.clear();
  };

  return {
    chartData,
    setChartData,
    loadingStates,
    setLoadingStates,
    errorStates,
    setErrorStates,
    mapDataFiltered,
    setMapDataFiltered,
    fetchChartData,
    updateChartData,
    getChartData,
    setLoading,
    setError,
    getLoading,
    getError,
    getDataSourceLoading,
    getDataLoadingMessage,
    setProgress,
    getProgress,
    getProgressMessage,
    clearProgress,
    getData,
    getDataAsync,
    setData,
    getDataWithTimeRange,
    isDataCached,
    indexDataByTimestamp,
    getStorageInfo,
    clearAllData,
    fetchDataWithChannelChecking,
    fetchDataWithChannelCheckingFromFile,
    getLastMissingChannels,
    storeOverlayData,
    getOverlayData,
    findClosestOverlayData,
    clearOverlayData,
    storeObject,
    getObject,
    deleteObject,
    listObjects,
    getFilterOptions,
    resetDataStore,
    clearCache,
    clearCacheForDataSource,
    clearDatasetCache,
    queryDataByChannels,
    queryCachedDataByChannels,
    // Events methods
    fetchEvents,
    preloadEventsForDate,
    getEvents,
    getEventsByType,
    getEventsByTimeRange,
    getEventById,
    getEventsByTypeFromIndexedDB,
    getEventsInTimeRangeFromIndexedDB,
    getEventsFromIndexedDB,
    clearEvents,
    getCachedDatasetsForClass,
    validateDatasetCache,
    // Map data loading for dataset initialization
    loadMapDataForDataset,
    // Day-level mapdata helpers
    fetchMapDataForDay,
    getMapDataForDayFromCache,
    fetchMapDataForDataset,
    getMapDataForDatasetFromCache,
    getCombinedMapData,
    // Optimized methods for starttime/endtime queries by event_id
    getEventTimeRange,
    getEventTimeRanges,
    updateMapdataWithEventIds,
    clearDensityOptimizedCache,
    // Live mode / Redis data methods
    isLiveMode,
    fetchRedisHistoricalData,
    storeRedisDataAsMapdata,
    detectGapsAndRefetch,
    dispose
  };
})();

// Export the store
export default unifiedDataStore;

// Export individual methods for direct imports
export const resetDataStore = unifiedDataStore.resetDataStore;
