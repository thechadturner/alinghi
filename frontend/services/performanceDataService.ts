/**
 * Performance Data Service
 * 
 * Handles fetching and managing performance data (aggregates, cloud, targets)
 * for the GP50 Performance report
 * 
 * FILTER SEPARATION:
 * - API Filters (sent to backend): YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE (for HistoricalPerformance)
 * - Client Filters (applied after data retrieval): STATE, RACE, LEG, GRADE (default)
 * 
 * This separation improves cache efficiency (client filter changes don't invalidate cache)
 * and reduces API payload size (large datasets filtered server-side).
 */

import { formatDate, formatTime, getData } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { warn as logWarn, error as logError, debug as logDebug } from '../utils/console';
import { persistantStore } from '../store/persistantStore';
import { user } from '../store/userStore';
import {
  PerformanceAggregatePoint,
  PerformanceCloudPoint,
  PerformanceTargetData
} from '../store/dataTypes';
// OLD INDEXEDDB - REPLACED WITH HUNIDB
import { huniDBStore, type FilterSet } from '../store/huniDBStore';
import type { CloudDataEntry } from '@store/huniDBTypes';
import { isMobileDevice } from '../utils/deviceDetection';
import { defaultChannelsStore } from '../store/defaultChannelsStore';
import { resolveDataField } from '../utils/colorScale';
import { extractAndNormalizeMetadata } from '../utils/dataNormalization';

const { selectedClassName, selectedProjectId, selectedSourceId, selectedDatasetId, selectedDate, selectedPage, selectedSourceName } = persistantStore;

export interface PerformanceDataService {
  // Chart configuration
  fetchCharts: () => Promise<any[]>;

  // Dataset date fetching
  fetchDatasetDate: () => Promise<string>;

  // Performance data methods
  fetchAggregates: (channels: string[], aggregateType: string, filters?: Record<string, any[]>) => Promise<PerformanceAggregatePoint[]>;
  fetchCloud: (channels: string[], cloudType?: string, filters?: Record<string, any[]>) => Promise<PerformanceCloudPoint[]>;
  fetchTargets: () => Promise<PerformanceTargetData>;

  // Data processing helpers
  getRequiredChannels: (chartObjects: any[]) => string[];
  enrichWithLocalTimeStrings: (items: any[]) => void;
  getChannelMapping: (chartObjects: any[]) => Record<string, string>; // Maps display names to data field names
  getAggregateTypeMapping: (chartObjects: any[]) => { aggregateType: string; channels: string[]; series: any[] }[];
  fetchAggregatesByType: (groupedChannels: { aggregateType: string; channels: string[] }[], filters?: Record<string, any[]>) => Promise<PerformanceAggregatePoint[]>;
  processPerformanceData: (
    aggregates: PerformanceAggregatePoint[], 
    cloud: PerformanceCloudPoint[], 
    targets: PerformanceTargetData,
    channelMapping?: Record<string, string>
  ) => {
    aggregates: PerformanceAggregatePoint[];
    cloud: PerformanceCloudPoint[];
    targets: PerformanceTargetData;
  };
}

// Chart configuration fetching
const fetchCharts = async (): Promise<any[]> => {
  const controller = new AbortController();

  try {
    // Check if user is available
    const currentUser = user();
    if (!currentUser || !currentUser.user_id) {
      logWarn("User not available, skipping chart fetch");
      return [];
    }

    // Get object name from selectedPage, fallback to performance_default
    const objectName = selectedPage() || 'performance_default';

    logDebug(`[PerformanceDataService] Fetching charts with object_name: ${objectName}`, {
      selectedPage: selectedPage(),
      fallback: 'performance_default',
      finalObjectName: objectName
    });

    const response = await getData(
      `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=performance&object_name=${encodeURIComponent(objectName)}`,
      controller.signal
    );

    if (!response.success) {
      logError(`Failed to fetch user object with object_name: ${objectName}`);
      throw new Error("Failed to fetch user object.");
    }

    // Handle case where API returns success but data is null (object not found)
    if (!response.data) {
      logWarn(`No user object found with object_name: ${objectName}, returning empty charts`);
      return [];
    }

    // Log chart configuration to debug unit issues
    if (response.data?.chart_info) {
      const charts = response.data.chart_info;
      logDebug('[PerformanceDataService] Loaded source charts', {
        chartCount: charts.length,
        firstChartSeries: charts[0]?.charts?.[0]?.series?.map((s: any) => ({
          yaxis: s.yaxis?.name || s.yaxis?.dataField,
          xaxis: s.xaxis?.name || s.xaxis?.dataField
        }))
      });
    }

    return response.data.chart_info || [];
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return [];
    }
    logError("Error fetching charts:", err as any);
    return [];
  }
};

// Fetch dataset date
const fetchDatasetDate = async (): Promise<string> => {
  const controller = new AbortController();

  try {
    const response = await getData(
      `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`,
      controller.signal
    );

    if (!response.success) {
      logError("Dataset date fetch failed:", response);
      throw new Error("Failed to fetch dataset date.");
    }

    // Format date as YYYY-MM-DD (API accepts YYYY-MM-DD or YYYYMMDD)
    const dateStr = response.data.date || '';
    // If date is in YYYYMMDD format, convert to YYYY-MM-DD
    if (dateStr.length === 8 && !dateStr.includes('-')) {
      return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    }
    return dateStr;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return '';
    }
    logError("Error fetching dataset date:", err as any);
    throw err;
  }
};

const fetchDates = async (): Promise<{ startDate: string; endDate: string }> => {
  const controller = new AbortController();

  try {
    const result = await getData(`${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(selectedSourceId())}`, controller.signal);
    if (result.success && result.data) {
      let date_str = result.data;

      let end_date = new Date(date_str);
      let start_date = new Date(end_date.getTime());
      start_date.setDate(start_date.getDate() - 30);

      const startDateFormatted = formatDate(start_date) || '';
      const endDateFormatted = formatDate(end_date) || '';
      return { startDate: startDateFormatted, endDate: endDateFormatted };
    }
    return { startDate: '', endDate: '' };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { startDate: '', endDate: '' };
    }
    logError("Error fetching dataset date:", err as any);
    throw err;
  }
};

// Match FleetPerformanceDataService.resolveDateRange: dataset date, then selectedDate, then last_date + 1 year (no filterStore)
const resolveDateRange = async (): Promise<{ startDate: string; endDate: string }> => {
  try {
    // 1. Dataset-level: use dataset date (single day)
    const hasDatasetId = typeof selectedDatasetId === 'function' && Number(selectedDatasetId()) > 0;
    if (hasDatasetId) {
      try {
        const date = await fetchDatasetDate();
        if (date) {
          logDebug(`[PerformanceDataService] Using dataset date for dataset-level query: ${date}`);
          return { startDate: date, endDate: date };
        }
      } catch (err) {
        logError('PerformanceDataService.resolveDateRange dataset branch error:', err as any);
      }
    }

    // 2. Single day when selectedDate is set (same as Fleet)
    const dateSel = typeof selectedDate === 'function' ? selectedDate() : '';
    if (dateSel) {
      const cleanDate = String(dateSel).replace(/^["']|["']$/g, '');
      if (cleanDate) {
        return { startDate: cleanDate, endDate: cleanDate };
      }
    }

    // 3. Source-level history: last_date for this source, then 1 year back (same shape as Fleet which uses source_id=0)
    const hasSourceId = typeof selectedSourceId === 'function' && Number(selectedSourceId()) > 0;
    if (hasSourceId) {
      const controller = new AbortController();
      const result = await getData(
        `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(selectedSourceId())}`,
        controller.signal
      );
      if (result.success && result.data) {
        const end = new Date(result.data);
        const start = new Date(end.getTime());
        start.setDate(start.getDate() - 365);
        const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        logDebug(`[PerformanceDataService] Using last_date + 1 year for source: ${toYmd(start)} to ${toYmd(end)}`);
        return { startDate: toYmd(start), endDate: toYmd(end) };
      }
    }
  } catch (err: unknown) {
    logError('PerformanceDataService.resolveDateRange unexpected error:', err as any);
  }
  return { startDate: '', endDate: '' };
};

// Fetch aggregated performance data
const fetchAggregates = async (channels: string[], aggregateType: string = 'AVG', filters?: Record<string, any[]>): Promise<PerformanceAggregatePoint[]> => {
  const controller = new AbortController();

  try {
    const className = selectedClassName().toLowerCase();
    const projectId = selectedProjectId().toString();
    const sourceId = selectedSourceId().toString();
    const { startDate, endDate } = await resolveDateRange();

    // Get dataset-id for cache query - ensure we get the actual value
    let datasetId = '0';
    if (typeof selectedDatasetId === 'function') {
      const dsId = selectedDatasetId();
      datasetId = dsId ? dsId.toString() : '0';
    }

    // Normalize aggregate type to uppercase for HuniDB (agrType is uppercase: 'AVG', 'STD', 'AAV')
    // CRITICAL: agrType must ALWAYS be derived from the aggregateType parameter, never from API response
    const normalizedAggregateType = aggregateType.toUpperCase();
    const rawAgrType = normalizedAggregateType;
    
    // Validate and normalize agrType to ensure it's one of the expected values
    const validAgrTypes = ['AVG', 'STD', 'AAV', 'MIN', 'MAX', 'NONE'];
    let finalAgrType: string;
    if (validAgrTypes.includes(rawAgrType)) {
      finalAgrType = rawAgrType;
    } else {
      logError(`[PerformanceDataService] Invalid aggregateType: ${aggregateType}, defaulting to 'AVG'`);
      finalAgrType = 'AVG';
    }
    
    // Make agrType immutable - it must NEVER be changed after this point
    const agrType: string = finalAgrType;
    
    // Log the aggregate type flow for debugging
    logDebug(`[PerformanceDataService] fetchAggregates called with aggregateType: ${aggregateType}, derived agrType: ${agrType} for ${className}_${projectId}_${sourceId}, dataset-id: ${datasetId}`);

    // Split filters into API and client categories
    // API filters: YEAR, EVENT, CONFIG, SOURCE_NAME (and optionally GRADE for HistoricalPerformance)
    // Client filters: STATE, RACE, LEG, GRADE (default)
    const { splitFilters } = await import('../utils/filterSeparation');
    const splitFilterResult = filters ? splitFilters(filters, false) : { apiFilters: {}, clientFilters: {} };
    const apiFilters = splitFilterResult.apiFilters;
    const clientFilters = splitFilterResult.clientFilters;

    logDebug(`[PerformanceDataService] Split filters:`, {
      allFilters: filters ? JSON.stringify(filters) : 'none',
      apiFilters: JSON.stringify(apiFilters),
      clientFilters: JSON.stringify(clientFilters),
      apiFilterKeys: Object.keys(apiFilters),
      clientFilterKeys: Object.keys(clientFilters)
    });

    // Convert client filters to format expected by passesBasicFilters
    // Client filters: STATE, RACE, LEG, GRADE
    let clientFilterConfig = undefined;
    if (Object.keys(clientFilters).length > 0) {
      const { createFilterConfig } = await import('../utils/filterCore');
      const baseFilterConfig = createFilterConfig(
        [], // twaStates - not used here
        clientFilters.RACE || [],
        clientFilters.LEG || [],
        clientFilters.GRADE || []
      );
      
      clientFilterConfig = {
        ...baseFilterConfig,
        twaStates: [], // TWA states are separate from State field
        states: clientFilters.STATE || [], // State field filter (e.g., H0, H1, H2) - always client-side
      };
      logDebug(`[PerformanceDataService] Client filter config:`, {
        config: JSON.stringify(clientFilterConfig),
        hasGrades: !!(clientFilterConfig.grades && clientFilterConfig.grades.length > 0),
        hasRaces: !!(clientFilterConfig.raceNumbers && clientFilterConfig.raceNumbers.length > 0),
        hasLegs: !!(clientFilterConfig.legNumbers && clientFilterConfig.legNumbers.length > 0),
        hasStates: !!(clientFilterConfig.states && clientFilterConfig.states.length > 0)
      });
    } else {
      logDebug(`[PerformanceDataService] No client filters to apply`);
    }

    // Build requested filters for cache validation (API filters only)
    // Client filters don't invalidate cache - they're applied post-query
    const requestedFilters: FilterSet | undefined = Object.keys(apiFilters).length > 0 ? {
      events: apiFilters.EVENT || [],
      configs: apiFilters.CONFIG || [],
      grades: apiFilters.GRADE || [],
      // Note: STATE, RACE, LEG are client-side and don't affect cache validation
      // Note: performanceDataService uses resolveDateRange which doesn't return date strings
      // so we don't include dateRange here
    } : undefined;
    
    // Build HuniDB query filters - DO NOT include STATE/EVENT/CONFIG in SQL
    // These are API filters and are handled by the API, not HuniDB SQL queries
    // HuniDB only filters by dataset/project/source/agrType for cache lookup
    const huniDBFilters: {
      datasetId?: string;
      projectId?: string;
      sourceId?: string;
      agrType?: string;
    } = {
      datasetId: datasetId || undefined,
      projectId,
      sourceId,
      agrType: agrType, // Filter by agrType (uppercase)
    };
    
    logDebug(`[PerformanceDataService] Querying HuniDB with filters:`, huniDBFilters);
    
    // Aggregates no longer cached in HuniDB - always fetch from API
    const cachedAggregates: any[] = [];

    // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
    let filteredAggregates = cachedAggregates;
    if (clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
      const hasActiveClientFilters = (
        (clientFilterConfig.grades && clientFilterConfig.grades.length > 0) ||
        (clientFilterConfig.raceNumbers && clientFilterConfig.raceNumbers.length > 0) ||
        (clientFilterConfig.legNumbers && clientFilterConfig.legNumbers.length > 0) ||
        (clientFilterConfig.states && clientFilterConfig.states.length > 0) ||
        (clientFilterConfig.twaStates && clientFilterConfig.twaStates.length > 0)
      );
      
      if (hasActiveClientFilters) {
        logDebug(`[PerformanceDataService] Applying client-side filters:`, JSON.stringify(clientFilterConfig));
        
        // Import passesBasicFilters for proper filtering
        const { passesBasicFilters } = await import('../utils/filterCore');
        
        let sampleMetadata: any = null;
        filteredAggregates = cachedAggregates.filter((entry, index) => {
          const metadata = entry.metadata || {}; // Already normalized to lowercase (grade, race_number, leg_number, state)
          const data = entry.data || {};
          
          // Capture sample metadata for debugging
          if (index === 0) {
            sampleMetadata = {
              grade: metadata.grade,
              race_number: metadata.race_number,
              leg_number: metadata.leg_number,
              state: metadata.state,
              metadataKeys: Object.keys(metadata)
            };
          }
          
          // Build a data point object for passesBasicFilters
          // passesBasicFilters prefers normalized lowercase fields (grade, race_number, leg_number, state)
          // HuniDB metadata is already normalized to lowercase, so use those directly
          const dataPointForFilter: any = {
            ...data,
            // Use normalized lowercase fields from metadata (HuniDB stores them lowercase)
            grade: metadata.grade,
            race_number: metadata.race_number,
            leg_number: metadata.leg_number,
            state: metadata.state,
            // Also provide uppercase variations for backward compatibility
            GRADE: metadata.grade,
            Grade: metadata.grade,
            Race_number: metadata.race_number,
            Leg_number: metadata.leg_number,
            State: metadata.state,
            STATE: metadata.state,
            // TWA from data object
            twa: data.Twa ?? data.twa ?? data.Twa_deg ?? data.twa_deg,
            Twa: data.Twa ?? data.twa ?? data.Twa_deg ?? data.twa_deg,
          };

          // Use passesBasicFilters for client-side filtering (STATE, RACE, LEG, GRADE)
          // passesBasicFilters will use the normalized lowercase fields (grade, race_number, leg_number, state)
          const passes = passesBasicFilters(dataPointForFilter, clientFilterConfig);
          return passes;
        });
        
        logDebug(`[PerformanceDataService] Client-side filtering: ${cachedAggregates.length} -> ${filteredAggregates.length} points`, {
          sampleMetadata,
          clientFilterConfig: {
            grades: clientFilterConfig.grades,
            raceNumbers: clientFilterConfig.raceNumbers,
            legNumbers: clientFilterConfig.legNumbers,
            states: clientFilterConfig.states
          }
        });
      }
    }

    // Convert AggregateEntry[] to PerformanceAggregatePoint[] format
    const cachedAggregatesFormatted = filteredAggregates.map(entry => {
      // Calculate tack from Twa if not already in metadata
      let tack = entry.metadata?.tack;
      if (!tack && entry.data) {
        const twa = entry.data.Twa ?? entry.data.twa;
        if (twa !== null && twa !== undefined && typeof twa === 'number') {
          tack = twa < 0 ? 'PORT' : 'STBD';
        }
      }

      // Format race_number: convert 'TRAINING' or -1, handle null/undefined
      let raceValue: number | string | undefined = entry.metadata?.race_number;
      if (raceValue === -1 || (typeof raceValue === 'string' && (raceValue === '-1' || raceValue === 'TRAINING'))) {
        raceValue = 'TRAINING';
      } else if (raceValue !== null && raceValue !== undefined) {
        raceValue = String(raceValue);
      } else {
        raceValue = 'NONE';
      }

      return {
        ...entry.data,
        Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(),
        event_id: entry.eventId?.toString() || '',
        dataset_id: entry.datasetId || '0',
        project_id: entry.projectId || '0',
        source_id: entry.sourceId || '0',
        Source_name: entry.metadata?.source_name || 'Unknown',
        source_name: entry.metadata?.source_name || 'Unknown',
        TACK: entry.metadata?.tack || (entry.data?.Twa < 0 ? 'PORT' : 'STBD'),
        RACE: raceValue,
        LEG: entry.metadata?.leg_number?.toString() || 'NONE',
        GRADE: entry.metadata?.grade ?? null,
        CONFIG: entry.metadata?.config || 'NONE',
        YEAR: entry.metadata?.year || 'NONE',
        EVENT: entry.metadata?.event || 'NONE',
        State: entry.metadata?.state || null,
        STATE: entry.metadata?.state || null,
        // Spread metadata last to ensure lowercase fields are also available
        ...entry.metadata,
      };
    });

    // Log what we got back from the query
    if (cachedAggregatesFormatted && cachedAggregatesFormatted.length > 0) {
      const sampleDate = cachedAggregatesFormatted[0]?.Datetime ? new Date(cachedAggregatesFormatted[0].Datetime).toISOString().split('T')[0] : 'N/A';
      // Verify the cached records actually have the correct agrType
      const sampleEntry = filteredAggregates[0];
      const actualAgrType = (sampleEntry?.agrType || 'unknown').toUpperCase();
      logDebug(`[PerformanceDataService] Query returned ${cachedAggregatesFormatted.length} cached aggregates for dataset-id ${datasetId}, agrType: ${agrType}, actual cached agrType: ${actualAgrType}, sample date: ${sampleDate}`);
      
      if (actualAgrType !== agrType) {
        logError(`[PerformanceDataService] ⚠️ MISMATCH: Requested agrType '${agrType}' but cached records have agrType '${actualAgrType}'`);
      }
    } else {
      logDebug(`[PerformanceDataService] Query returned 0 cached aggregates for dataset-id ${datasetId}, agrType: ${agrType}`);
    }

    // If we have cached aggregates, only use them if they fully cover the requested date range
    // IMPORTANT: If we're querying for a specific dataset (datasetId > 0), we must NOT return
    // data that was stored with dataset-id 0 (source-level data), even if dates match
    if (cachedAggregatesFormatted && cachedAggregatesFormatted.length > 0) {
      const requestedDatasetId = Number(datasetId);
      const isDatasetSpecificQuery = requestedDatasetId > 0;

      logDebug(`[PerformanceDataService] Found ${cachedAggregatesFormatted.length} cached aggregates, requested dataset-id: ${datasetId}, isDatasetSpecific: ${isDatasetSpecificQuery}`);

      // CRITICAL: If querying for a specific dataset (datasetId > 0), we must NOT return any cached data
      // unless we're absolutely certain it was stored with the same dataset-id.
      // The query should already filter correctly, but if we're querying for a specific dataset
      // and somehow got results, we need to be extra cautious.
      if (isDatasetSpecificQuery) {
        // Double-check: If we're querying for a specific dataset, the query should have returned
        // only entries with that dataset-id. But if we got results when we shouldn't have,
        // or if the date range doesn't match, we should fetch from API instead.
        // For dataset-specific queries, we should only use cached data if:
        // 1. We have a valid date range AND
        // 2. The cached data fully covers that date range
        // Otherwise, fetch from API to ensure we get the correct dataset-specific data
        if (!startDate || !endDate) {
          logDebug(`[PerformanceDataService] Dataset-specific query (datasetId: ${datasetId}) but no date range - fetching from API to ensure correct data`);
          // Fall through to API fetch
        } else {
          // We have a date range, check coverage
          const filtered = filterCacheByDateRange(cachedAggregatesFormatted as any[], startDate, endDate);

          // Build inclusive list of required dates (YYYY-MM-DD)
          const requiredDates: string[] = (() => {
            const dates: string[] = [];
            const start = new Date(startDate);
            const end = new Date(endDate);
            start.setHours(0, 0, 0, 0);
            end.setHours(0, 0, 0, 0);
            for (let d = new Date(start.getTime()); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
              const formatted = formatDate(d);
              if (formatted) {
                dates.push(formatted);
              }
            }
            return dates;
          })();

          // Collect distinct dates present in filtered cache
          const presentDates = new Set<string>();
          for (const p of filtered) {
            const point = p as any;
            if (point && point.Datetime) {
              const dt = new Date(point.Datetime);
              const formatted = formatDate(dt);
              if (formatted) {
                presentDates.add(formatted);
              }
            }
          }

          const hasFullCoverage = requiredDates.every(d => presentDates.has(d));

          if (hasFullCoverage) {
            logDebug(`[PerformanceDataService] Using cached aggregates for dataset-id ${datasetId}: full coverage for ${startDate} to ${endDate} (${filtered.length} points)`);
            return filtered as PerformanceAggregatePoint[];
          }

          logDebug(`[PerformanceDataService] Cached aggregates incomplete for dataset-id ${datasetId}, date range ${startDate} to ${endDate} (have ${presentDates.size}/${requiredDates.length} dates). Will fetch from API.`);
          // Fall through to API fetch
        }
      } else {
        // Source-level query (datasetId = 0), use existing logic
        // If we have a valid date range, ensure full coverage; otherwise return cached as-is
        if (startDate && endDate) {
          const filtered = filterCacheByDateRange(cachedAggregatesFormatted as any[], startDate, endDate);

          // Build inclusive list of required dates (YYYY-MM-DD)
          const requiredDates: string[] = (() => {
            const dates: string[] = [];
            const start = new Date(startDate);
            const end = new Date(endDate);
            start.setHours(0, 0, 0, 0);
            end.setHours(0, 0, 0, 0);
            for (let d = new Date(start.getTime()); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
              const formatted = formatDate(d);
              if (formatted) {
                dates.push(formatted);
              }
            }
            return dates;
          })();

          // Collect distinct dates present in filtered cache
          const presentDates = new Set<string>();
          for (const p of filtered) {
            const point = p as any;
            if (point && point.Datetime) {
              const dt = new Date(point.Datetime);
              const formatted = formatDate(dt);
              if (formatted) {
                presentDates.add(formatted);
              }
            }
          }

          const hasFullCoverage = requiredDates.every(d => presentDates.has(d));

          if (hasFullCoverage) {
            logDebug(`[PerformanceDataService] Using cached aggregates: full coverage for ${startDate} to ${endDate} (${filtered.length} points)`);
            return filtered as any;
          }

          logDebug(`[PerformanceDataService] Cached aggregates incomplete for ${startDate} to ${endDate} (have ${presentDates.size}/${requiredDates.length} dates). Will fetch from API.`);
          // Fall through to API fetch
        } else {
          logDebug(`[PerformanceDataService] No valid date range resolved; returning cached aggregates (${cachedAggregatesFormatted.length} points)`);
          return cachedAggregatesFormatted as unknown as PerformanceAggregatePoint[];
        }
      }
    }

    // Not in IndexedDB, fetch from API
    logDebug(`[PerformanceDataService] No cached data, fetching aggregates from API`);
    const normalizedChannels = normalizeChannels(channels);

    // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
    // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
    const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;

    const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0
      ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}`
      : '';

    // API expects lowercase agr_type (the route does .toLowerCase() but let's be explicit)
    const apiAggregateType = agrType.toLowerCase(); // Convert to lowercase for API
    
    const url = `${apiEndpoints.app.data}/performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(selectedSourceId())}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=BIN%2010&agr_type=${apiAggregateType}&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;

    logDebug(`[PerformanceDataService] API call details:`, {
      className: selectedClassName(),
      projectId: selectedProjectId(),
      sourceId: selectedSourceId(),
      startDate,
      endDate,
      aggregateType: aggregateType,
      normalizedAggregateType: normalizedAggregateType,
      agrType: agrType,
      apiAggregateType: apiAggregateType,
      channels: normalizedChannels,
      hasFilters: !!filters,
      filtersObject: filters ? JSON.stringify(filters) : 'none',
      filtersKeys: filters ? Object.keys(filters) : [],
      gradeFilter: filters?.GRADE ? JSON.stringify(filters.GRADE) : 'none',
      filtersParam: filtersParam ? filtersParam.substring(0, 150) : 'missing',
      urlLength: url.length
    });

    const response = await getData(url, controller.signal);

    logDebug(`[PerformanceDataService] API response:`, {
      success: response.success,
      dataLength: response.data ? (Array.isArray(response.data) ? response.data.length : 'not array') : 'no data',
      error: response.success ? undefined : response
    });

    if (!response.success) {
      logError("Aggregates data fetch failed:", response as any);
      throw new Error("Failed to fetch aggregates data.");
    }

    let aggregatesData = response.data || [];

    logDebug(`[PerformanceDataService] API returned ${aggregatesData.length} aggregate points for agrType: ${agrType}, aggregateType: ${aggregateType}`);

    // Apply client-side filtering (STATE, RACE, LEG, GRADE if client-side)
    // API has already filtered by YEAR, EVENT, CONFIG, SOURCE_NAME
    if (aggregatesData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
      const hasActiveClientFilters = (
        (clientFilterConfig.grades && clientFilterConfig.grades.length > 0) ||
        (clientFilterConfig.raceNumbers && clientFilterConfig.raceNumbers.length > 0) ||
        (clientFilterConfig.legNumbers && clientFilterConfig.legNumbers.length > 0) ||
        (clientFilterConfig.states && clientFilterConfig.states.length > 0) ||
        (clientFilterConfig.twaStates && clientFilterConfig.twaStates.length > 0)
      );
      
      if (hasActiveClientFilters) {
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        const { passesBasicFilters } = await import('../utils/filterCore');
        
        let sampleItem: any = null;
        const beforeCount = aggregatesData.length;
        aggregatesData = aggregatesData.filter((item: any, index: number) => {
          const normalized = extractAndNormalizeMetadata(item);
          
          // Capture sample item for debugging
          if (index === 0) {
            sampleItem = {
              original: {
                GRADE: item.GRADE,
                Race_number: item.Race_number,
                Leg_number: item.Leg_number,
                State: item.State,
                STATE: item.STATE
              },
              normalized: {
                grade: normalized.Grade,
                race_number: normalized.Race_number,
                leg_number: normalized.Leg_number,
                state: normalized.State
              }
            };
          }
          
          // Build data point with normalized lowercase fields (passesBasicFilters prefers these)
          const dataPointForFilter: any = {
            ...item,
            // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
            grade: normalized.Grade,
            race_number: normalized.Race_number,
            leg_number: normalized.Leg_number,
            state: normalized.State,
            // Also provide uppercase variations for backward compatibility
            GRADE: normalized.Grade,
            Grade: normalized.Grade,
            Race_number: normalized.Race_number,
            Leg_number: normalized.Leg_number,
            State: normalized.State,
            STATE: normalized.State,
            // TWA from item
            twa: item.Twa ?? item.twa ?? item.Twa_deg ?? item.twa_deg,
            Twa: item.Twa ?? item.twa ?? item.Twa_deg ?? item.twa_deg,
          };
          
          // passesBasicFilters will use the normalized lowercase fields (grade, race_number, leg_number, state)
          return passesBasicFilters(dataPointForFilter, clientFilterConfig);
        });
        
        logDebug(`[PerformanceDataService] Applied client-side filters to API data: ${beforeCount} -> ${aggregatesData.length} points`, {
          sampleItem,
          clientFilterConfig: {
            grades: clientFilterConfig.grades,
            raceNumbers: clientFilterConfig.raceNumbers,
            legNumbers: clientFilterConfig.legNumbers,
            states: clientFilterConfig.states
          }
        });
      } else {
        logDebug(`[PerformanceDataService] Client filter config exists but no active filters`);
      }
    } else {
      if (aggregatesData.length > 0) {
        logDebug(`[PerformanceDataService] No client filter config, skipping client-side filtering (${aggregatesData.length} points)`);
      }
    }

    // Normalize API response data to lowercase field names (same as unifiedDataStore does)
    if (aggregatesData.length > 0) {
      // Import normalization utility
      const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
      
      // Normalize API response data to lowercase field names
      aggregatesData = aggregatesData.map((item: any) => {
        const normalizedMetadata = extractAndNormalizeMetadata(item);
        // Remove all case variations of metadata fields
        const metadataFieldsToRemove = [
          'GRADE', 'Grade', 'grade',
          'RACE', 'Race_number', 'race_number', 'RaceNumber', 'raceNumber',
          'LEG', 'Leg_number', 'leg_number', 'LegNumber', 'legNumber',
          'STATE', 'State', 'state',
          'CONFIG', 'Config', 'config',
          'EVENT', 'Event', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
          'SOURCE_NAME', 'Source_name', 'source_name', 'Source', 'SOURCE', 'source',
          'TACK', 'Tack', 'tack',
        ];
        
        metadataFieldsToRemove.forEach(field => {
          if (field in item) {
            delete item[field];
          }
        });
        
        // Add normalized metadata fields
        return {
          ...item,
          ...normalizedMetadata
        };
      });
    }

    // Store in HuniDB
    if (aggregatesData.length > 0) {
      logDebug(`[PerformanceDataService] Storing ${aggregatesData.length} aggregates with dataset-id: ${datasetId}, agrType: ${agrType}`);

      // Convert PerformanceAggregatePoint[] to AggregateEntry[] format
      const aggregateEntries: any[] = [];
      for (const point of aggregatesData) {
        // Extract all channel values from the point (Twa, Tws, Bsp, etc.)
        // These will be stored as dynamic columns
        const channelData: Record<string, any> = {};
        for (const key in point) {
          // Include all numeric values and strings that are channel data
          // Exclude metadata fields that go into the metadata object
          // NOTE: Twa_deg_avg is intentionally stored in channelData (not excluded) because
          // it's metadata that needs to be preserved for all aggregate types (AVG, STD, AAV)
          // for consistent upwind/downwind filtering
          if (
            key !== 'event_id' &&
            key !== 'Datetime' &&
            key !== 'TACK' &&
            key !== 'RACE' &&
            key !== 'Race_number' &&
            key !== 'Leg_number' &&
            key !== 'GRADE' &&
            key !== 'Grade' &&
            key !== 'grade' &&
            key !== 'race_number' &&
            key !== 'leg_number' &&
            key !== 'dataset_id' &&
            key !== 'source_id' &&
            key !== 'project_id' &&
            key !== 'Config' &&
            key !== 'Year' &&
            key !== 'Event' &&
            key !== 'Source_name'
          ) {
            channelData[key] = point[key];
          }
        }

        // Extract IDs from API response (use API values, fallback to store values if missing)
        const pointDatasetId = point.dataset_id ? String(point.dataset_id) : (datasetId || '0');
        const pointProjectId = point.project_id ? String(point.project_id) : projectId;
        const pointSourceId = point.source_id ? String(point.source_id) : sourceId;

        // CRITICAL: agrType must come from the function parameter, NEVER from API response data
        // The API response does not include aggregate type information, so we must use the parameter
        // The agrType variable is immutable and was set from aggregateType parameter at function start
        const entryAgrType = agrType; // Use the immutable agrType from function parameter (already uppercase)
        const entryEventType = 'BIN10'; // Event type is always 'BIN10' for performance aggregates
        
        const aggregateEntry: any = {
          id: `bin10-${entryAgrType.toLowerCase()}-${pointDatasetId}-${pointProjectId}-${pointSourceId}-${point.event_id || 0}`,
          eventType: entryEventType,
          agrType: entryAgrType, // CRITICAL: Always use agrType from function parameter (uppercase), never from API data
          datasetId: pointDatasetId,
          projectId: pointProjectId,
          sourceId: pointSourceId,
          eventId: point.event_id || 0,
          metadata: (() => {
            // Normalize metadata from API response using extractAndNormalizeMetadata
            // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
            // Store in lowercase for consistency with database schema
            const normalized = extractAndNormalizeMetadata(point);
            return {
              race_number: normalized.Race_number,
              leg_number: normalized.Leg_number,
              grade: normalized.Grade,
              state: normalized.State,
              config: normalized.Config || 'NONE',
              year: normalized.Year,
              event: normalized.Event,
              source_name: normalized.source_name,
              datetime: normalized.Datetime || (point.Datetime ? (typeof point.Datetime === 'string' ? point.Datetime : point.Datetime.toISOString()) : undefined),
              // Note: tack is NOT stored - it will be calculated from Twa when querying
            };
          })(),
          data: channelData, // Store only channel data (Twa, Tws, Bsp, etc.)
        };

        aggregateEntries.push(aggregateEntry);
      }

      // Batch store all aggregates in a single transaction (skip on mobile)
      if (!isMobileDevice()) {
        // CRITICAL VALIDATION: Verify all entries have correct agrType before storing
        if (aggregateEntries.length > 0) {
          const agrTypesInBatch = new Set(aggregateEntries.map(e => e.agrType));
          const expectedAgrType = agrType; // Use the immutable agrType from parameter (uppercase)
          
          logDebug(`[PerformanceDataService] Preparing to store ${aggregateEntries.length} aggregates:`, {
            aggregateType: aggregateType,
            expectedAgrType: expectedAgrType,
            agrTypesInBatch: Array.from(agrTypesInBatch),
            sampleEntry: {
              id: aggregateEntries[0].id,
              agrType: aggregateEntries[0].agrType,
              eventType: aggregateEntries[0].eventType,
              eventId: aggregateEntries[0].eventId,
              datasetId: aggregateEntries[0].datasetId
            }
          });
          
          // RUNTIME VALIDATION: Verify all entries have the correct agrType
          const incorrectAgrTypes = aggregateEntries.filter(e => e.agrType !== expectedAgrType);
          if (incorrectAgrTypes.length > 0) {
            const errorMsg = `[PerformanceDataService] ⚠️ CRITICAL ERROR: Found ${incorrectAgrTypes.length} entries with incorrect agrType! Expected: ${expectedAgrType} (from aggregateType: ${aggregateType}), Found: ${Array.from(agrTypesInBatch).join(', ')}`;
            logError(errorMsg, incorrectAgrTypes.map(e => ({ id: e.id, agrType: e.agrType })).slice(0, 5));
            throw new Error(errorMsg);
          }
          
          // Additional validation: ensure agrType is not empty
          const emptyAgrTypes = aggregateEntries.filter(e => !e.agrType || e.agrType.trim() === '');
          if (emptyAgrTypes.length > 0) {
            const errorMsg = `[PerformanceDataService] ⚠️ CRITICAL ERROR: Found ${emptyAgrTypes.length} entries with empty agrType!`;
            logError(errorMsg);
            throw new Error(errorMsg);
          }
        }
        
        // Build applied filters for cache metadata - only API filters affect cache
        // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
        const appliedFilters: FilterSet = {
          events: apiFilters.EVENT || [],
          configs: apiFilters.CONFIG || [],
          grades: apiFilters.GRADE || [],
          // STATE, RACE, LEG are client-side and don't affect cache metadata
        };
        
        // Aggregates storage removed - agg.aggregates table no longer used
        logDebug(`[PerformanceDataService] Skipping aggregates storage (deprecated) - ${aggregateEntries.length} aggregates with agrType: ${agrType}`);
      } else {
        logDebug(`[PerformanceDataService] Skipping HuniDB storage on mobile device`);
      }
    }

    return aggregatesData;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return [];
    }
    logError("Error fetching aggregates:", err as any);
    throw err;
  }
};

/**
 * Fetch aggregates grouped by aggregate type and merge by event_id
 * This function handles fetching multiple aggregate types (AVG, STD, AAV) separately
 * and merges them into a unified array where each point contains all aggregate types
 * 
 * @param groupedChannels - Array of { aggregateType, channels } objects
 * @param filters - Optional filters to apply
 * @returns Merged PerformanceAggregatePoint[] with all aggregate types combined
 */
const fetchAggregatesByType = async (
  groupedChannels: { aggregateType: string; channels: string[] }[],
  filters?: Record<string, any[]>
): Promise<PerformanceAggregatePoint[]> => {
  try {
    if (!groupedChannels || groupedChannels.length === 0) {
      logWarn('[PerformanceDataService] No grouped channels provided to fetchAggregatesByType');
      return [];
    }

    logDebug(`[PerformanceDataService] Fetching aggregates by type for ${groupedChannels.length} aggregate types:`, 
      groupedChannels.map(g => ({ aggregateType: g.aggregateType, channelCount: g.channels.length, channels: g.channels.slice(0, 3) }))
    );

    // Fetch all aggregate types in parallel
    const fetchPromises = groupedChannels.map((group) => {
      logDebug(`[PerformanceDataService] Fetching ${group.aggregateType} aggregates for channels:`, group.channels);
      return fetchAggregates(group.channels, group.aggregateType, filters);
    });

    const results = await Promise.all(fetchPromises);
    
    // Log results for each aggregate type
    results.forEach((result, resultIndex) => {
      const group = groupedChannels[resultIndex];
      logDebug(`[PerformanceDataService] Fetched ${result.length} points for aggregateType: ${group.aggregateType}`);
      if (result.length > 0) {
        const sample = result[0];
        logDebug(`[PerformanceDataService] Sample ${group.aggregateType} point:`, {
          event_id: sample.event_id,
          dataKeys: Object.keys(sample).filter(k => !['event_id', 'Datetime', 'TACK', 'RACE', 'LEG', 'GRADE'].includes(k)).slice(0, 5)
        });
      }
    });

    // Merge results by event_id
    // Start with AVG data as the base (it has the most complete data including x-axis)
    const avgIndex = groupedChannels.findIndex(g => g.aggregateType.toUpperCase() === 'AVG');
    const baseData = avgIndex >= 0 ? results[avgIndex] : results[0];
    
    if (!baseData || baseData.length === 0) {
      logWarn('[PerformanceDataService] No base data found for merging aggregates');
      return [];
    }

    // Create a map of event_id -> data point for merging
    const mergedMap = new Map<string, any>();
    
    // Initialize with base data (AVG)
    baseData.forEach(point => {
      const eventId = String(point.event_id || '');
      if (eventId) {
        mergedMap.set(eventId, { ...point });
      }
    });

    // Build a set of channels that should use non-AVG values (y-axis channels with non-AVG aggregate)
    // X-axis channels (TWS, BSP) always use AVG, so we exclude them
    const { twsName, bspName } = defaultChannelsStore;
    const twsField = twsName();
    const bspField = bspName();
    const xAxisChannels = new Set([twsField, bspField, twsField.toLowerCase(), bspField.toLowerCase(), twsField.toUpperCase(), bspField.toUpperCase()]);
    const nonAvgChannels = new Map<string, string>(); // channel -> aggregateType
    
    groupedChannels.forEach((group) => {
      if (group.aggregateType.toUpperCase() === 'AVG') {
        return; // Skip AVG group
      }
      group.channels.forEach(channel => {
        // Only mark channels that are NOT x-axis channels (x-axis always uses AVG)
        const channelLower = channel.toLowerCase();
        if (!xAxisChannels.has(channel) && !xAxisChannels.has(channelLower)) {
          nonAvgChannels.set(channel, group.aggregateType.toUpperCase());
          // Also add lowercase version
          nonAvgChannels.set(channelLower, group.aggregateType.toUpperCase());
        }
      });
    });

    // Merge other aggregate types into the base data
    groupedChannels.forEach((group, index) => {
      if (index === avgIndex) {
        // Skip AVG, already added
        return;
      }

      const aggregateType = group.aggregateType.toUpperCase();
      const dataForType = results[index] || [];

      logDebug(`[PerformanceDataService] fetchAggregatesByType: Merging ${aggregateType} data (agrType: ${aggregateType}): ${dataForType.length} points`);

      dataForType.forEach(point => {
        const eventId = String(point.event_id || '');
        if (!eventId) {
          return;
        }

        const existing = mergedMap.get(eventId);
        if (existing) {
          // Merge channel data from this aggregate type
          Object.keys(point).forEach(key => {
            // Skip metadata fields that are already in the base point
            // Twa_deg_avg is metadata (always from AVG) - preserve it as-is, don't suffix it
            if (['event_id', 'Datetime', 'dataset_id', 'project_id', 'source_id', 
                 'TACK', 'RACE', 'LEG', 'GRADE', 'CONFIG', 
                 'YEAR', 'EVENT', 'State', 'STATE',
                 'Twa_deg_avg', 'twa_deg_avg'].includes(key)) {
              return;
            }
            
            // For numeric channel data
            if (typeof point[key] === 'number' && !isNaN(point[key])) {
              const keyLower = key.toLowerCase();
              const suffix = aggregateType.toLowerCase();
              const suffixedKey = `${key}_${suffix}`;
              const suffixedKeyLower = `${keyLower}_${suffix}`;
              
              // Always store non-AVG values with a suffix (e.g., Bsp_kts_std, Twa_n_deg_std)
              // Keep AVG values in the base field (e.g., Bsp_kts, Twa_n_deg)
              // This allows each series to choose which aggregate type to use based on the aggregate prop
              existing[suffixedKey] = point[key];
              existing[suffixedKeyLower] = point[key];
              
              // DO NOT replace the base field - keep AVG values there
              // The chart component will use the suffixed field when aggregate type is not AVG
            } else {
              // For non-numeric data, just merge it
              if (existing[key] === undefined) {
                existing[key] = point[key];
              }
            }
          });
        } else {
          // Event not in base data, add it anyway (shouldn't happen often)
          logDebug(`[PerformanceDataService] Found ${aggregateType} point for event_id ${eventId} not in base data`);
          mergedMap.set(eventId, { ...point });
        }
      });
    });

    let mergedArray = Array.from(mergedMap.values());
    const aggregateTypesUsed = groupedChannels.map(g => `${g.aggregateType}(${g.aggregateType.toLowerCase()})`).join(', ');
    logDebug(`[PerformanceDataService] fetchAggregatesByType: Merged ${mergedArray.length} aggregate points from ${groupedChannels.length} aggregate types: ${aggregateTypesUsed}`);
    
    // Final safeguard: Apply client-side filters one more time after merging
    // This ensures no unwanted client-filtered data slips through when merging different aggregate types
    // Note: API filters (EVENT, CONFIG) are already applied by fetchAggregates, so we only need client filters here
    if (filters && Object.keys(filters).length > 0) {
      // Split filters to get only client filters
      const { splitFilters } = await import('../utils/filterSeparation');
      const splitFilterResult = splitFilters(filters, false);
      const clientFilters = splitFilterResult.clientFilters;
      
      if (Object.keys(clientFilters).length > 0) {
        const { createFilterConfig, passesBasicFilters } = await import('../utils/filterCore');
        const clientFilterConfig = createFilterConfig(
          [], // twaStates - not used here
          clientFilters.RACE || [],
          clientFilters.LEG || [],
          clientFilters.GRADE || []
        );
        
        const finalClientFilterConfig = {
          ...clientFilterConfig,
          twaStates: [],
          states: clientFilters.STATE || [], // State field filter (e.g., H0, H1, H2) - always client-side
        };
        
        const hasActiveClientFilters = (
          (finalClientFilterConfig.grades && finalClientFilterConfig.grades.length > 0) ||
          (finalClientFilterConfig.raceNumbers && finalClientFilterConfig.raceNumbers.length > 0) ||
          (finalClientFilterConfig.legNumbers && finalClientFilterConfig.legNumbers.length > 0) ||
          (finalClientFilterConfig.states && finalClientFilterConfig.states.length > 0) ||
          (finalClientFilterConfig.twaStates && finalClientFilterConfig.twaStates.length > 0)
        );
        
        if (hasActiveClientFilters) {
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          const beforeCount = mergedArray.length;
          
          mergedArray = mergedArray.filter((point: any) => {
            const normalized = extractAndNormalizeMetadata(point);
            const dataPointForFilter: any = {
              ...point,
              // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
              grade: normalized.Grade,
              race_number: normalized.Race_number,
              leg_number: normalized.Leg_number,
              state: normalized.State,
              // Also provide uppercase variations for backward compatibility
              GRADE: normalized.Grade,
              Grade: normalized.Grade,
              Race_number: normalized.Race_number,
              Leg_number: normalized.Leg_number,
              State: normalized.State,
              STATE: normalized.State,
              twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
              Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            };
            
            return passesBasicFilters(dataPointForFilter, finalClientFilterConfig);
          });
          
          if (mergedArray.length !== beforeCount) {
            logDebug(`[PerformanceDataService] fetchAggregatesByType: Final client filter pass removed ${beforeCount - mergedArray.length} points (${beforeCount} -> ${mergedArray.length})`);
            
            // Log sample of states in filtered data for debugging
            if (clientFilters.STATE && clientFilters.STATE.length > 0) {
              const statesInData = new Set<string>();
              mergedArray.forEach((p: any) => {
                const state = p.State || p.state || p.STATE;
                if (state) statesInData.add(String(state));
              });
              logDebug(`[PerformanceDataService] fetchAggregatesByType: States in filtered data:`, Array.from(statesInData));
            }
          }
        }
      }
    }
    
    return mergedArray as PerformanceAggregatePoint[];
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return [];
    }
    logError("Error fetching aggregates by type:", err as any);
    throw err;
  }
};

// Helper to calculate date N days back from a given date string
const getDateDaysBack = (dateStr: string, days: number): string => {
  const date = new Date(dateStr);
  date.setDate(date.getDate() - days);
  return formatDate(date) || dateStr;
};

// Helper to get Recent History window: 30 days prior to 1 day prior to date
const getRecentHistoryWindow = (dateStr: string): { startDate: string; endDate: string } => {
  return {
    startDate: getDateDaysBack(dateStr, 30),
    endDate: getDateDaysBack(dateStr, 1)
  };
};

// Helper to get 1Hz date (same start and end date)
const getOneHzDate = (dateStr: string): { startDate: string; endDate: string } => {
  return {
    startDate: dateStr,
    endDate: dateStr
  };
};

// Helper to filter cached data by date range (inclusive, full-day boundaries)
const filterCacheByDateRange = (cachedData: any[], startDate: string, endDate: string): any[] => {
  if (!startDate || !endDate || !cachedData || cachedData.length === 0) {
    return cachedData || [];
  }

  const startObj = new Date(startDate);
  startObj.setHours(0, 0, 0, 0);
  const endObj = new Date(endDate);
  endObj.setHours(23, 59, 59, 999);
  const start = startObj.getTime();
  const end = endObj.getTime();

  return cachedData.filter(point => {
    if (!point.Datetime) return false;
    const pointDate = new Date(point.Datetime).getTime();
    return pointDate >= start && pointDate <= end;
  });
};

// Helper to filter cached data by exact date (for 1Hz data)
const filterCacheByExactDate = (cachedData: any[], dateStr: string): any[] => {
  if (!dateStr || !cachedData || cachedData.length === 0) {
    return cachedData || [];
  }

  const targetDate = new Date(dateStr);
  const targetDateStr = formatDate(targetDate);

  return cachedData.filter(point => {
    if (!point.Datetime) return false;
    const pointDate = new Date(point.Datetime);
    const pointDateStr = formatDate(pointDate);
    return pointDateStr === targetDateStr;
  });
};

// Helper to normalize channels array
const normalizeChannels = (channels: string[]): string[] => {
  return (channels || [])
    .map(c => String(c))
    .filter(c => c !== "PAGE DEFAULT" && c !== "DEFAULT");
};

// Fetch cloud (1Hz) performance data
const fetchCloud = async (channels: string[], cloudType: string = 'Latest', filters?: Record<string, any[]>): Promise<PerformanceCloudPoint[]> => {
  const controller = new AbortController();

  try {
    const className = selectedClassName().toLowerCase();
    const projectId = selectedProjectId().toString();

    // Get dataset-id for cache queries
    const datasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId().toString() : '0';

    // Split filters into API and client categories
    // API filters: YEAR, EVENT, CONFIG, SOURCE_NAME (and optionally GRADE for HistoricalPerformance)
    // Client filters: STATE, RACE, LEG, GRADE (default)
    const { splitFilters } = await import('../utils/filterSeparation');
    const splitFilterResult = filters ? splitFilters(filters, false) : { apiFilters: {}, clientFilters: {} };
    const apiFilters = splitFilterResult.apiFilters;
    const clientFilters = splitFilterResult.clientFilters;

    // Convert client filters to format expected by passesBasicFilters
    let clientFilterConfig = undefined;
    if (Object.keys(clientFilters).length > 0) {
      const { createFilterConfig } = await import('../utils/filterCore');
      const baseFilterConfig = createFilterConfig(
        [], // twaStates - not used here
        clientFilters.RACE || [],
        clientFilters.LEG || [],
        clientFilters.GRADE || []
      );
      
      clientFilterConfig = {
        ...baseFilterConfig,
        twaStates: [], // TWA states are separate from State field
        states: clientFilters.STATE || [], // State field filter (e.g., H0, H1, H2) - always client-side
      };
    }

    // Handle different cloud types
    if (cloudType === 'Fleet Data') {
      // Fleet Data - use shared-cloud-data endpoint (no source_id)
      // Fleet data should be from the same day as aggregates (dataset date)
      const sourceId = selectedSourceId().toString();

      // For dataset-level reports, use dataset date (same day as aggregates)
      // For other reports, use resolveDateRange endDate
      let startDate: string;
      let endDate: string;

      const hasDatasetId = typeof selectedDatasetId === 'function' && Number(selectedDatasetId()) > 0;
      if (hasDatasetId) {
        try {
          // Get dataset date (same day as aggregates)
          endDate = await fetchDatasetDate();
          if (endDate) {
            startDate = endDate; // Same day as aggregates
            logDebug(`[PerformanceDataService] Dataset mode: Using same day as aggregates for Fleet Data: ${startDate} to ${endDate}`);
          } else {
            // Fallback to resolveDateRange if dataset date fetch fails
            const resolved = await resolveDateRange();
            startDate = resolved.endDate || resolved.startDate;
            endDate = resolved.endDate || resolved.startDate;
          }
        } catch (err) {
          logError('PerformanceDataService: Error fetching dataset date for Fleet Data, falling back to resolveDateRange:', err as any);
          const resolved = await resolveDateRange();
          startDate = resolved.endDate || resolved.startDate;
          endDate = resolved.endDate || resolved.startDate;
        }
      } else {
        // Non-dataset mode: use endDate from resolveDateRange (same day)
        const resolved = await resolveDateRange();
        startDate = resolved.endDate || resolved.startDate;
        endDate = resolved.endDate || resolved.startDate;
      }

      // Ensure we have valid dates before proceeding
      if (!startDate || !endDate) {
        logWarn(`[PerformanceDataService] Invalid date range for Fleet Data: startDate=${startDate}, endDate=${endDate}`);
        throw new Error("Invalid date range for Fleet Data: start and end dates are required");
      }

      // Check IndexedDB first for fleet data
      // Fleet cloud data not yet implemented in HuniDB - always fetch from API
      logDebug(`[PerformanceDataService] Fleet Data: Fetching from API (HuniDB not yet implemented), date range: ${startDate} to ${endDate}`);
      const normalizedChannels = normalizeChannels(channels);
      const cachedFleetCloudData: any[] = [];

      // Filter cached data by date range
      const filteredCachedData = filterCacheByDateRange(cachedFleetCloudData, startDate, endDate);

      if (filteredCachedData && filteredCachedData.length > 0) {
        logDebug(`[PerformanceDataService] Found ${filteredCachedData.length} cached fleet cloud points (filtered from ${cachedFleetCloudData.length}) in IndexedDB`);
        return filteredCachedData;
      }

      // Not in IndexedDB, fetch from API
      logDebug(`[PerformanceDataService] No cached fleet data, fetching from shared-cloud-data API (agr_type=AVG, excluding source_id=${sourceId}, ${startDate} to ${endDate})`);

      // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
      // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
      const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}`
        : '';

      const url = `${apiEndpoints.app.data}/shared-cloud-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(sourceId)}&table_name=events_aggregate&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=bin%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;

      const response = await getData(url, controller.signal);

      if (!response.success) {
        logError("Fleet cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch fleet cloud data.");
      }

      let cloudData = response.data || [];
      logDebug(`[PerformanceDataService] Fleet Data: Received ${cloudData.length} points from API`);

      // Normalize API response data to lowercase field names (same as aggregates)
      if (cloudData.length > 0) {
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        
        cloudData = cloudData.map((item: any) => {
          const normalizedMetadata = extractAndNormalizeMetadata(item);
          // Remove all case variations of metadata fields
          const metadataFieldsToRemove = [
            'GRADE', 'Grade', 'grade',
            'RACE', 'Race_number', 'race_number', 'RaceNumber', 'raceNumber',
            'LEG', 'Leg_number', 'leg_number', 'LegNumber', 'legNumber',
            'STATE', 'State', 'state',
            'CONFIG', 'Config', 'config',
            'EVENT', 'Event', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
            'SOURCE_NAME', 'Source_name', 'source_name', 'Source', 'SOURCE', 'source',
            'TACK', 'Tack', 'tack',
          ];
          
          metadataFieldsToRemove.forEach(field => {
            if (field in item) {
              delete item[field];
            }
          });
          
          // Add normalized metadata fields
          return {
            ...item,
            ...normalizedMetadata
          };
        });
      }

      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const { passesBasicFilters } = await import('../utils/filterCore');
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        const beforeCount = cloudData.length;
        cloudData = cloudData.filter((point: any) => {
          const normalized = extractAndNormalizeMetadata(point);
          const dataPointForFilter: any = {
            ...point,
            // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
            grade: normalized.Grade,
            race_number: normalized.Race_number,
            leg_number: normalized.Leg_number,
            state: normalized.State,
            // Also provide uppercase variations for backward compatibility
            GRADE: normalized.Grade,
            Grade: normalized.Grade,
            Race_number: normalized.Race_number,
            Leg_number: normalized.Leg_number,
            State: normalized.State,
            STATE: normalized.State,
            twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
          };
          return passesBasicFilters(dataPointForFilter, clientFilterConfig);
        });
        if (beforeCount !== cloudData.length) {
          logDebug(`[PerformanceDataService] Applied client-side filters to Fleet Data: ${beforeCount} -> ${cloudData.length} points`);
        }
      }

      logDebug(`[PerformanceDataService] Fleet Data: Returning ${cloudData.length} points after processing`);

      // Store in HuniDB (fleet cloud data not yet implemented - skip storage)
      if (cloudData.length > 0) {
        logDebug(`[PerformanceDataService] Fleet cloud data storage skipped (not yet implemented in HuniDB)`);
        // Stub to prevent errors:
        await Promise.resolve();
      }

      return cloudData;
    } else if (cloudType === 'Source History' || cloudType === 'Recent History') {
      // Recent History - 30 days prior to 1 day prior to selectedDate/latest_date
      // Use performance-data with agr_type=AVG (events_aggregate)
      const sourceId = selectedSourceId().toString();
      
      // Get the base date (dataset date or endDate from resolveDateRange)
      let baseDate: string = '';
      const hasDatasetId = typeof selectedDatasetId === 'function' && Number(selectedDatasetId()) > 0;
      if (hasDatasetId) {
        try {
          baseDate = await fetchDatasetDate();
          if (!baseDate) {
            // Fallback to resolveDateRange if dataset date fetch fails
            const resolved = await resolveDateRange();
            baseDate = resolved.endDate || resolved.startDate;
          }
        } catch (err) {
          logError('PerformanceDataService: Error fetching dataset date for Recent History, falling back:', err);
          const resolved = await resolveDateRange();
          baseDate = resolved.endDate || resolved.startDate;
        }
      } else {
        // Non-dataset mode: use endDate from resolveDateRange
        const resolved = await resolveDateRange();
        baseDate = resolved.endDate || resolved.startDate;
      }
      
      // If still no base date, try fetchDates
      if (!baseDate) {
        try {
          const dates = await fetchDates();
          baseDate = dates?.endDate || dates?.startDate || '';
        } catch (err) {
          logError('PerformanceDataService: Error fetching dates for Recent History:', err);
        }
      }
      
      // Calculate Recent History window: 30 days prior to 1 day prior to baseDate
      let finalStartDate: string;
      let finalEndDate: string;
      if (baseDate) {
        const window = getRecentHistoryWindow(baseDate);
        finalStartDate = window.startDate;
        finalEndDate = window.endDate;
        logDebug(`[PerformanceDataService] Recent History: Using base date ${baseDate}, calculated window: ${finalStartDate} to ${finalEndDate}`);
      } else {
        logWarn(`[PerformanceDataService] No valid base date for Recent History cloud data`);
        return [];
      }
      
      // Ensure we have valid dates
      if (!finalStartDate || !finalEndDate) {
        logWarn(`[PerformanceDataService] No valid date range for Recent History cloud data`);
        return [];
      }

      logDebug(`[PerformanceDataService] Recent History: Fetching from HuniDB for ${className}_${projectId}_${sourceId}, dataset-id: ${datasetId}, date range: ${finalStartDate} to ${finalEndDate}`);
      const normalizedChannels = normalizeChannels(channels);

      // Build requested filters for cache validation - only API filters affect cache
      // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
      const requestedFilters: FilterSet | undefined = Object.keys(apiFilters).length > 0 ? {
        events: apiFilters.EVENT || [],
        configs: apiFilters.CONFIG || [],
        grades: apiFilters.GRADE || [],
        dateRange: finalStartDate && finalEndDate ? { start: finalStartDate, end: finalEndDate } : undefined
        // STATE, RACE, LEG are client-side and don't affect cache validation
      } : (finalStartDate && finalEndDate ? {
        dateRange: { start: finalStartDate, end: finalEndDate }
      } : undefined);

      // Query cloud data from HuniDB cache (skip on mobile)
      // Cloud data no longer cached in HuniDB - always fetch from API
      let cachedCloudEntries: CloudDataEntry[] = [];
      if (false) {
        const timeRange = finalStartDate && finalEndDate ? {
          start: new Date(finalStartDate).getTime(),
          end: new Date(finalEndDate).getTime()
        } : undefined;
        
        cachedCloudEntries = await huniDBStore.queryCloudData(className, {
          datasetId: datasetId || undefined,
          projectId,
          sourceId,
          timeRange,
          cloudType: 'Recent History'
        }, requestedFilters);
        
        if (cachedCloudEntries.length > 0) {
          // Convert CloudDataEntry[] to array format
          let cachedFormatted = cachedCloudEntries.map(entry => ({
            ...entry.data,
            Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(entry.timestamp),
            event_id: entry.eventId?.toString() || '',
            dataset_id: entry.datasetId || '0',
            project_id: entry.projectId || '0',
            source_id: entry.sourceId || '0',
            RACE: entry.metadata?.race_number?.toString() || 'NONE',
            LEG: entry.metadata?.leg_number?.toString() || 'NONE',
            GRADE: entry.metadata?.grade?.toString() || null,
            CONFIG: entry.metadata?.config || 'NONE',
            Event: entry.metadata?.event || 'NONE',
            State: (entry.metadata as any)?.state || 'NONE',
            ...entry.metadata,
          }));
          
          // Filter cached data by date range (same as aggregates)
          const filteredCachedData = filterCacheByDateRange(cachedFormatted as any[], finalStartDate, finalEndDate);
          
          // Apply client-side filters to cached data
          let finalCachedData = filteredCachedData;
          if (clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
            const { passesBasicFilters } = await import('../utils/filterCore');
            const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
            const beforeCount = finalCachedData.length;
            finalCachedData = finalCachedData.filter((point: any) => {
              const normalized = extractAndNormalizeMetadata(point);
              const dataPointForFilter: any = {
                ...point,
              // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
              grade: normalized.Grade,
              race_number: normalized.Race_number,
              leg_number: normalized.Leg_number,
              state: normalized.State,
              // Also provide uppercase variations for backward compatibility
              GRADE: normalized.Grade,
              Grade: normalized.Grade,
              Race_number: normalized.Race_number,
              Leg_number: normalized.Leg_number,
              State: normalized.State,
              STATE: normalized.State,
              twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
              Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            };
            return passesBasicFilters(dataPointForFilter, clientFilterConfig);
            });
            if (beforeCount !== finalCachedData.length) {
              logDebug(`[PerformanceDataService] Applied client-side filters to cached data: ${beforeCount} -> ${finalCachedData.length} points`);
            }
          }
          
          if (finalCachedData && finalCachedData.length > 0) {
            logDebug(`[PerformanceDataService] Found ${finalCachedData.length} cached recent history cloud points in HuniDB`);
            return finalCachedData;
          }
        }
      }

      // Not in IndexedDB, fetch from API with agr_type=AVG (events_aggregate)
      logDebug(`[PerformanceDataService] No cached recent history data, fetching from performance-data API (agr_type=AVG, ${finalStartDate} to ${finalEndDate})`);

      // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
      // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
      const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}`
        : '';

      const url = `${apiEndpoints.app.data}/performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(selectedSourceId())}&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;

      const response = await getData(url, controller.signal);

      if (!response.success) {
        logError("Recent history cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch recent history cloud data.");
      }

      let cloudData = response.data || [];
      
      // Normalize API response data to lowercase field names (same as aggregates)
      if (cloudData.length > 0) {
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        
        cloudData = cloudData.map((item: any) => {
          const normalizedMetadata = extractAndNormalizeMetadata(item);
          // Remove all case variations of metadata fields
          const metadataFieldsToRemove = [
            'GRADE', 'Grade', 'grade',
            'RACE', 'Race_number', 'race_number', 'RaceNumber', 'raceNumber',
            'LEG', 'Leg_number', 'leg_number', 'LegNumber', 'legNumber',
            'STATE', 'State', 'state',
            'CONFIG', 'Config', 'config',
            'EVENT', 'Event', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
            'SOURCE_NAME', 'Source_name', 'source_name', 'Source', 'SOURCE', 'source',
            'TACK', 'Tack', 'tack',
          ];
          
          metadataFieldsToRemove.forEach(field => {
            if (field in item) {
              delete item[field];
            }
          });
          
          // Add normalized metadata fields
          return {
            ...item,
            ...normalizedMetadata
          };
        });
      }
      
      // Filter by date range (same as aggregates) - API already filters, but ensure consistency
      if (finalStartDate && finalEndDate) {
        cloudData = filterCacheByDateRange(cloudData as any[], finalStartDate, finalEndDate);
      }

      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const { passesBasicFilters } = await import('../utils/filterCore');
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        const beforeCount = cloudData.length;
        cloudData = cloudData.filter((point: any) => {
          const normalized = extractAndNormalizeMetadata(point);
          const dataPointForFilter: any = {
            ...point,
            // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
            grade: normalized.Grade,
            race_number: normalized.Race_number,
            leg_number: normalized.Leg_number,
            state: normalized.State,
            // Also provide uppercase variations for backward compatibility
            GRADE: normalized.Grade,
            Grade: normalized.Grade,
            Race_number: normalized.Race_number,
            Leg_number: normalized.Leg_number,
            State: normalized.State,
            STATE: normalized.State,
            twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
          };
          return passesBasicFilters(dataPointForFilter, clientFilterConfig);
        });
        if (beforeCount !== cloudData.length) {
          logDebug(`[PerformanceDataService] Applied client-side filters to API data: ${beforeCount} -> ${cloudData.length} points`);
        }
      }

      // Store in HuniDB
      if (cloudData.length > 0) {
        logDebug(`[PerformanceDataService] Storing ${cloudData.length} recent history cloud points with dataset-id: ${datasetId}`);
        try {
          // Import normalization utility
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          
          const cloudEntries = cloudData.map((point: any) => {
            // Extract IDs from API response (use API values, fallback to defaults if missing)
            const pointDatasetId = point.dataset_id ? String(point.dataset_id) : (datasetId || '0');
            const pointProjectId = point.project_id ? String(point.project_id) : projectId;
            const pointSourceId = point.source_id ? String(point.source_id) : sourceId;
            
            // Calculate tack from Twa if not already present
            let tack = point.tack ?? point.TACK;
            if (!tack || tack === 'NONE') {
              const twa = point.Twa ?? point.twa;
              if (twa !== null && twa !== undefined && typeof twa === 'number') {
                tack = twa < 0 ? 'PORT' : 'STBD';
              }
            }

            // CRITICAL: Extract metadata BEFORE destructuring to ensure state is preserved
            // Use normalization utility to extract and normalize metadata from the original point
            const normalizedMetadata = extractAndNormalizeMetadata(point);

            // Exclude metadata fields from data object (after extracting metadata)
            const { event_id, dataset_id, source_id, project_id, Datetime, tack: _tack, race_number, leg_number, grade, config, year, event, source_name, state, ...channelData } = point;

            return {
              id: `cloud-${pointDatasetId}-${pointProjectId}-${pointSourceId}-${point.event_id || '0'}-${point.Datetime || Date.now()}`,
              timestamp: point.Datetime ? new Date(point.Datetime).getTime() : Date.now(),
              datasetId: pointDatasetId,
              projectId: pointProjectId,
              sourceId: pointSourceId,
              eventId: point.event_id || 0,
              metadata: {
                ...normalizedMetadata,
                tack: normalizedMetadata.Tack ?? tack ?? 'NONE',
                datetime: point.Datetime ?? normalizedMetadata.Datetime,
                year: normalizedMetadata.Year ?? point.year ?? undefined,
              },
              data: channelData, // Channel values only (excludes metadata fields)
            };
          });
          if (!isMobileDevice()) {
            // Build applied filters for cache metadata - only API filters affect cache
            // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
            const appliedFilters: FilterSet = {
              events: apiFilters.EVENT || [],
              configs: apiFilters.CONFIG || [],
              grades: apiFilters.GRADE || [],
              dateRange: finalStartDate && finalEndDate ? { start: finalStartDate, end: finalEndDate } : undefined
              // STATE, RACE, LEG are client-side and don't affect cache metadata
            };
            
            // Cloud data storage removed - cloud.data table no longer used
            logDebug(`[PerformanceDataService] Skipping cloud data storage (deprecated) - ${cloudData.length} recent history points`);
          } else {
            logDebug(`[PerformanceDataService] Skipping HuniDB storage on mobile device`);
          }
        } catch (error) {
          logError(`[PerformanceDataService] Error storing cloud data:`, error);
        }
      }

      return cloudData;
    } else if (cloudType === 'Season 5') {
      // Season 5 - Query aggregate data for year 2025 with grades 2 and 3
      // If in Performance/PerformanceHistory context, filter by selectedSourceName
      const sourceId = selectedSourceId().toString();
      const sourceName = typeof selectedSourceName === 'function' ? selectedSourceName() : '';
      
      // Use full year 2025 date range
      const finalStartDate = '2025-01-01';
      const finalEndDate = '2025-12-31';
      
      logDebug(`[PerformanceDataService] Season 5: Fetching aggregate data for year 2025, grades 2 and 3${sourceName ? `, source: ${sourceName}` : ''}, date range: ${finalStartDate} to ${finalEndDate}`);
      const normalizedChannels = normalizeChannels(channels);
      
      // Build filters for Season 5: YEAR=2025, GRADE=[2,3]
      // Note: SOURCE_NAME is NOT included because performance-data endpoint doesn't accept it
      // (source filtering is handled by source_id parameter in URL)
      const season5Filters: Record<string, any[]> = {
        YEAR: [2025],
        GRADE: [2, 3]
      };
      
      // Merge with any additional API filters from props (excluding SOURCE_NAME)
      // Remove SOURCE_NAME from apiFilters if present, as it's not allowed for performance-data endpoint
      // (source filtering is handled by source_id parameter in URL)
      const apiFiltersWithoutSourceName = { ...apiFilters };
      if ('SOURCE_NAME' in apiFiltersWithoutSourceName) {
        delete apiFiltersWithoutSourceName.SOURCE_NAME;
      }
      const mergedApiFilters = {
        ...season5Filters,
        ...apiFiltersWithoutSourceName
      };
      
      // Build requested filters for cache validation
      const requestedFilters: FilterSet | undefined = {
        events: mergedApiFilters.EVENT || [],
        configs: mergedApiFilters.CONFIG || [],
        grades: mergedApiFilters.GRADE || [],
        dateRange: { start: finalStartDate, end: finalEndDate }
      };
      
      // Query cloud data from HuniDB cache (skip on mobile)
      let cachedCloudEntries: CloudDataEntry[] = [];
      if (!isMobileDevice()) {
        const timeRange = {
          start: new Date(finalStartDate).getTime(),
          end: new Date(finalEndDate).getTime()
        };
        
        // Cloud data no longer cached in HuniDB
        cachedCloudEntries = [];
        
        if (cachedCloudEntries.length > 0) {
          // Convert CloudDataEntry[] to array format
          let cachedFormatted = cachedCloudEntries.map(entry => ({
            ...entry.data,
            Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(entry.timestamp),
            event_id: entry.eventId?.toString() || '',
            dataset_id: entry.datasetId || '0',
            project_id: entry.projectId || '0',
            source_id: entry.sourceId || '0',
            RACE: entry.metadata?.race_number?.toString() || 'NONE',
            LEG: entry.metadata?.leg_number?.toString() || 'NONE',
            GRADE: entry.metadata?.grade?.toString() || null,
            CONFIG: entry.metadata?.config || 'NONE',
            Event: entry.metadata?.event || 'NONE',
            State: (entry.metadata as any)?.state || 'NONE',
            ...entry.metadata,
          }));
          
          // Filter cached data by date range
          const filteredCachedData = filterCacheByDateRange(cachedFormatted as any[], finalStartDate, finalEndDate);
          
          // Apply client-side filters to cached data
          let finalCachedData = filteredCachedData;
          if (clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
            const { passesBasicFilters } = await import('../utils/filterCore');
            const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
            const beforeCount = finalCachedData.length;
            finalCachedData = finalCachedData.filter((point: any) => {
              const normalized = extractAndNormalizeMetadata(point);
              const dataPointForFilter: any = {
                ...point,
              // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
              grade: normalized.Grade,
              race_number: normalized.Race_number,
              leg_number: normalized.Leg_number,
              state: normalized.State,
              // Also provide uppercase variations for backward compatibility
              GRADE: normalized.Grade,
              Grade: normalized.Grade,
              Race_number: normalized.Race_number,
              Leg_number: normalized.Leg_number,
              State: normalized.State,
              STATE: normalized.State,
              twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
              Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            };
            return passesBasicFilters(dataPointForFilter, clientFilterConfig);
            });
            if (beforeCount !== finalCachedData.length) {
              logDebug(`[PerformanceDataService] Applied client-side filters to cached Season 5 data: ${beforeCount} -> ${finalCachedData.length} points`);
            }
          }
          
          if (finalCachedData && finalCachedData.length > 0) {
            logDebug(`[PerformanceDataService] Found ${finalCachedData.length} cached Season 5 cloud points in HuniDB`);
            return finalCachedData;
          }
        }
      }
      
      // Not in IndexedDB, fetch from API with agr_type=AVG (events_aggregate)
      logDebug(`[PerformanceDataService] No cached Season 5 data, fetching from performance-data API (agr_type=AVG, year=2025, grades=[2,3]${sourceName ? `, source=${sourceName}` : ''}, ${finalStartDate} to ${finalEndDate})`);
      
      // Build filters object for API - use merged filters
      const apiFiltersForRequest = Object.keys(mergedApiFilters).length > 0 ? mergedApiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}`
        : '';
      
      const url = `${apiEndpoints.app.data}/performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(sourceId)}&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
      
      const response = await getData(url, controller.signal);
      
      if (!response.success) {
        logError("Season 5 cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch Season 5 cloud data.");
      }
      
      let cloudData = response.data || [];
      
      // Normalize API response data to lowercase field names (same as aggregates)
      if (cloudData.length > 0) {
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        
        cloudData = cloudData.map((item: any) => {
          const normalizedMetadata = extractAndNormalizeMetadata(item);
          // Remove all case variations of metadata fields
          const metadataFieldsToRemove = [
            'GRADE', 'Grade', 'grade',
            'RACE', 'Race_number', 'race_number', 'RaceNumber', 'raceNumber',
            'LEG', 'Leg_number', 'leg_number', 'LegNumber', 'legNumber',
            'STATE', 'State', 'state',
            'CONFIG', 'Config', 'config',
            'EVENT', 'Event', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
            'SOURCE_NAME', 'Source_name', 'source_name', 'Source', 'SOURCE', 'source',
            'TACK', 'Tack', 'tack',
          ];
          
          metadataFieldsToRemove.forEach(field => {
            if (field in item) {
              delete item[field];
            }
          });
          
          // Add normalized metadata fields
          return {
            ...item,
            ...normalizedMetadata
          };
        });
      }
      
      // Filter by date range (same as aggregates) - API already filters, but ensure consistency
      if (finalStartDate && finalEndDate) {
        cloudData = filterCacheByDateRange(cloudData as any[], finalStartDate, finalEndDate);
      }
      
      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const { passesBasicFilters } = await import('../utils/filterCore');
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        const beforeCount = cloudData.length;
        cloudData = cloudData.filter((point: any) => {
          const normalized = extractAndNormalizeMetadata(point);
          const dataPointForFilter: any = {
            ...point,
            // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
            grade: normalized.Grade,
            race_number: normalized.Race_number,
            leg_number: normalized.Leg_number,
            state: normalized.State,
            // Also provide uppercase variations for backward compatibility
            GRADE: normalized.Grade,
            Grade: normalized.Grade,
            Race_number: normalized.Race_number,
            Leg_number: normalized.Leg_number,
            State: normalized.State,
            STATE: normalized.State,
            twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
          };
          return passesBasicFilters(dataPointForFilter, clientFilterConfig);
        });
        if (beforeCount !== cloudData.length) {
          logDebug(`[PerformanceDataService] Applied client-side filters to Season 5 API data: ${beforeCount} -> ${cloudData.length} points`);
        }
      }
      
      // Store in HuniDB
      if (cloudData.length > 0) {
        logDebug(`[PerformanceDataService] Storing ${cloudData.length} Season 5 cloud points with dataset-id: ${datasetId}`);
        try {
          // Import normalization utility
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          
          const cloudEntries = cloudData.map((point: any) => {
            // Extract IDs from API response (use API values, fallback to defaults if missing)
            const pointDatasetId = point.dataset_id ? String(point.dataset_id) : (datasetId || '0');
            const pointProjectId = point.project_id ? String(point.project_id) : projectId;
            const pointSourceId = point.source_id ? String(point.source_id) : sourceId;
            
            // Calculate tack from Twa if not already present
            let tack = point.tack ?? point.TACK;
            if (!tack || tack === 'NONE') {
              const twa = point.Twa ?? point.twa;
              if (twa !== null && twa !== undefined && typeof twa === 'number') {
                tack = twa < 0 ? 'PORT' : 'STBD';
              }
            }
            
            // CRITICAL: Extract metadata BEFORE destructuring to ensure state is preserved
            // Use normalization utility to extract and normalize metadata from the original point
            const normalizedMetadata = extractAndNormalizeMetadata(point);
            
            // Exclude metadata fields from data object (after extracting metadata)
            const { event_id, dataset_id, source_id, project_id, Datetime, tack: _tack, race_number, leg_number, grade, config, year, event, source_name, state, ...channelData } = point;
            
            return {
              id: `cloud-${pointDatasetId}-${pointProjectId}-${pointSourceId}-${point.event_id || '0'}-${point.Datetime || Date.now()}`,
              timestamp: point.Datetime ? new Date(point.Datetime).getTime() : Date.now(),
              datasetId: pointDatasetId,
              projectId: pointProjectId,
              sourceId: pointSourceId,
              eventId: point.event_id || 0,
              metadata: {
                ...normalizedMetadata,
                tack: normalizedMetadata.Tack ?? tack ?? 'NONE',
                datetime: point.Datetime ?? normalizedMetadata.Datetime,
                year: normalizedMetadata.Year ?? point.year ?? undefined,
              },
              data: channelData, // Channel values only (excludes metadata fields)
            };
          });
          if (!isMobileDevice()) {
            // Build applied filters for cache metadata
            const appliedFilters: FilterSet = {
              events: mergedApiFilters.EVENT || [],
              configs: mergedApiFilters.CONFIG || [],
              grades: mergedApiFilters.GRADE || [],
              dateRange: { start: finalStartDate, end: finalEndDate }
            };
            
            // Cloud data storage removed - cloud.data table no longer used
            logDebug(`[PerformanceDataService] Skipping cloud data storage (deprecated) - ${cloudData.length} Season 5 points`);
          } else {
            logDebug(`[PerformanceDataService] Skipping HuniDB storage on mobile device`);
          }
        } catch (error) {
          logError(`[PerformanceDataService] Error storing Season 5 cloud data:`, error);
        }
      }
      
      return cloudData;
    } else {
      // Default: Latest / 1Hz Scatter - use performance-data endpoint with agr_type=NONE (events_cloud)
      // start_date == end_date (same date)
      const sourceId = selectedSourceId().toString();
      let finalStartDate: string;
      let finalEndDate: string;

      // For 1Hz data, use dataset date if available, otherwise use resolved date range endDate
      const hasDatasetId = typeof selectedDatasetId === 'function' && Number(selectedDatasetId()) > 0;
      if (hasDatasetId) {
        try {
          const date = await fetchDatasetDate();
          if (date) {
            // Use dataset date for 1Hz (same start and end)
            const oneHzDates = getOneHzDate(date);
            finalStartDate = oneHzDates.startDate;
            finalEndDate = oneHzDates.endDate;
          } else {
            // Fall back to resolved date range
            const resolved = await resolveDateRange();
            if (resolved.endDate) {
              const oneHzDates = getOneHzDate(resolved.endDate);
              finalStartDate = oneHzDates.startDate;
              finalEndDate = oneHzDates.endDate;
            } else {
              finalStartDate = resolved.startDate;
              finalEndDate = resolved.endDate;
            }
          }
        } catch (err) {
          logError('PerformanceDataService: Error fetching dataset date for 1Hz, falling back:', err);
          const resolved = await resolveDateRange();
          if (resolved.endDate) {
            const oneHzDates = getOneHzDate(resolved.endDate);
            finalStartDate = oneHzDates.startDate;
            finalEndDate = oneHzDates.endDate;
          } else {
            finalStartDate = resolved.startDate;
            finalEndDate = resolved.endDate;
          }
        }
      } else {
        // Use resolved date range endDate for 1Hz
        const resolved = await resolveDateRange();
        if (resolved.endDate) {
          const oneHzDates = getOneHzDate(resolved.endDate);
          finalStartDate = oneHzDates.startDate;
          finalEndDate = oneHzDates.endDate;
        } else {
          finalStartDate = resolved.startDate;
          finalEndDate = resolved.endDate;
        }
      }

      logDebug(`[PerformanceDataService] Latest/1Hz: Fetching from HuniDB for ${className}_${projectId}_${sourceId}, dataset-id: ${datasetId}, exact date: ${finalStartDate}`);
      const normalizedChannels = normalizeChannels(channels);

      // Check HuniDB first
      const targetDate = new Date(finalStartDate);
      const targetDateStart = new Date(targetDate);
      targetDateStart.setHours(0, 0, 0, 0);
      const targetDateEnd = new Date(targetDate);
      targetDateEnd.setHours(23, 59, 59, 999);

      // Build requested filters for cache validation - only API filters affect cache
      // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
      const requestedFilters: FilterSet | undefined = Object.keys(apiFilters).length > 0 ? {
        events: apiFilters.EVENT || [],
        configs: apiFilters.CONFIG || [],
        grades: apiFilters.GRADE || [],
        dateRange: finalStartDate && finalEndDate ? { start: finalStartDate, end: finalEndDate } : undefined
        // STATE, RACE, LEG are client-side and don't affect cache validation
      } : (finalStartDate && finalEndDate ? {
        dateRange: { start: finalStartDate, end: finalEndDate }
      } : undefined);
      
      // Query cloud data from HuniDB (skip on mobile) - pass requestedFilters for cache validation
      // Cloud data no longer cached in HuniDB - always fetch from API
      const cachedCloudEntries: CloudDataEntry[] = [];
      if (false) await huniDBStore.queryCloudData(className, {
        datasetId: datasetId || undefined,
        projectId,
        sourceId,
        timeRange: {
          start: targetDateStart.getTime(),
          end: targetDateEnd.getTime()
        },
        cloudType: 'Latest/1Hz'
      }, requestedFilters);

      // Format cached cloud data to match API response format (same as aggregates)
      if (cachedCloudEntries && cachedCloudEntries.length > 0) {
        logDebug(`[PerformanceDataService] Found ${cachedCloudEntries.length} cached 1Hz cloud entries in HuniDB`);

        // Log sample metadata to debug state values
        if (cachedCloudEntries.length > 0) {
          const sampleMetadata = cachedCloudEntries.slice(0, 3).map(e => ({
            state: e.metadata?.state,
            State: (e.metadata as any)?.State,
            metadataKeys: Object.keys(e.metadata || {}),
            fullMetadata: e.metadata
          }));
          logDebug(`[PerformanceDataService] Sample cached cloud metadata:`, sampleMetadata);
        }
        
        const cachedCloudDataFormatted = cachedCloudEntries.map(entry => {
          // Calculate tack from Twa if not already in metadata
          let tack = entry.metadata?.tack;
          if (!tack && entry.data) {
            const twa = entry.data.Twa ?? entry.data.twa;
            if (twa !== null && twa !== undefined && typeof twa === 'number') {
              tack = twa < 0 ? 'PORT' : 'STBD';
            }
          }

          // Extract state from metadata - don't default to 'NONE' if it's actually null/undefined
          // This allows filtering to work correctly (null state should be excluded when filtering, not set to 'NONE')
          const stateValue = (entry.metadata as any)?.state ?? (entry.metadata as any)?.State ?? null;

          return {
            ...entry.data,
            Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(entry.timestamp),
            event_id: entry.eventId?.toString() || '',
            dataset_id: entry.datasetId || datasetId || '0',
            project_id: entry.projectId || projectId || '0',
            source_id: entry.sourceId || sourceId || '0',
            TACK: tack || 'NONE',
            RACE: entry.metadata?.race_number?.toString() || 'NONE',
            LEG: entry.metadata?.leg_number?.toString() || 'NONE',
            GRADE: entry.metadata?.grade?.toString() || 'NONE',
            State: stateValue,
            STATE: stateValue,
            state: stateValue,
            Config: entry.metadata?.config || (entry.metadata as any)?.Config || 'NONE',
            CONFIG: entry.metadata?.config || (entry.metadata as any)?.Config || 'NONE',
            config: entry.metadata?.config || (entry.metadata as any)?.Config || 'NONE',
            Event: entry.metadata?.event || (entry.metadata as any)?.Event || 'NONE',
            EVENT: entry.metadata?.event || (entry.metadata as any)?.Event || 'NONE',
            event: entry.metadata?.event || (entry.metadata as any)?.Event || 'NONE',
            Year: entry.metadata?.year || (entry.metadata as any)?.Year || 'NONE',
            YEAR: entry.metadata?.year || (entry.metadata as any)?.Year || 'NONE',
            year: entry.metadata?.year || (entry.metadata as any)?.Year || 'NONE',
            ...entry.metadata,
          };
        });

        // Filter by exact date to ensure we only return data for the requested date
        let filteredCachedData = filterCacheByExactDate(cachedCloudDataFormatted, finalStartDate);

        // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
        if (clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
          const { passesBasicFilters } = await import('../utils/filterCore');
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          const beforeCount = filteredCachedData.length;
          filteredCachedData = filteredCachedData.filter(point => {
            const normalized = extractAndNormalizeMetadata(point);
            const dataPointForFilter: any = {
              ...point,
              // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
              grade: normalized.Grade,
              race_number: normalized.Race_number,
              leg_number: normalized.Leg_number,
              state: normalized.State,
              // Also provide uppercase variations for backward compatibility
              GRADE: normalized.Grade,
              Grade: normalized.Grade,
              Race_number: normalized.Race_number,
              Leg_number: normalized.Leg_number,
              State: normalized.State,
              STATE: normalized.State,
              twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
              Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            };
            return passesBasicFilters(dataPointForFilter, clientFilterConfig);
          });
          if (beforeCount !== filteredCachedData.length) {
            logDebug(`[PerformanceDataService] Applied client-side filters to cached 1Hz data: ${beforeCount} -> ${filteredCachedData.length} points`);
          }
        }

        if (filteredCachedData && filteredCachedData.length > 0) {
          logDebug(`[PerformanceDataService] Found ${filteredCachedData.length} cached 1Hz cloud points (filtered from ${cachedCloudEntries.length}) in HuniDB`);
          return filteredCachedData;
        }
      }

      // Not in IndexedDB, fetch from API with agr_type=NONE (events_cloud)
      logDebug(`[PerformanceDataService] No cached data, fetching 1Hz cloud data from performance-data API (agr_type=NONE, date: ${finalStartDate})`);

      // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
      // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
      const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}`
        : '';

      const url = `${apiEndpoints.app.data}/performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(selectedSourceId())}&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=BIN%2010&agr_type=NONE&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;

      const response = await getData(url, controller.signal);

      if (!response.success) {
        logError("Cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch cloud data.");
      }

      let cloudData = response.data || [];

      // Debug: Log cloud data count to verify it's 1Hz data (should be many more points than aggregates)
      logDebug(`[PerformanceDataService] Cloud data fetched from API (agr_type=NONE, events_cloud): ${cloudData.length} points`, {
        samplePoint: cloudData.length > 0 ? {
          event_id: cloudData[0].event_id,
          Datetime: cloudData[0].Datetime,
          hasTwa: cloudData[0].Twa_deg !== undefined || cloudData[0].twa_deg !== undefined,
          hasTws: cloudData[0].Tws_kph !== undefined || cloudData[0].tws_kph !== undefined,
          allKeys: Object.keys(cloudData[0]).slice(0, 10)
        } : null,
        uniqueEventIds: cloudData.length > 0 ? new Set(cloudData.map((p: any) => p.event_id)).size : 0,
        pointsPerEvent: cloudData.length > 0 && new Set(cloudData.map((p: any) => p.event_id)).size > 0 
          ? (cloudData.length / new Set(cloudData.map((p: any) => p.event_id)).size).toFixed(2) 
          : 'N/A'
      });

      // Log sample API response to check if state is included (before normalization)
      if (cloudData.length > 0) {
        const sampleApiResponse = cloudData.slice(0, 3).map((item: any) => ({
          hasState: item.State != null,
          hasSTATE: item.STATE != null,
          hasstate: item.state != null,
          State: item.State,
          STATE: item.STATE,
          state: item.state,
          event_id: item.event_id,
          allKeys: Object.keys(item).filter(k => k.toLowerCase().includes('state'))
        }));
        logDebug(`[PerformanceDataService] Sample 1Hz API cloud response (before normalization):`, sampleApiResponse);
      }

      // Normalize API response data to lowercase field names (same as aggregates)
      if (cloudData.length > 0) {
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        
        cloudData = cloudData.map((item: any) => {
          const normalizedMetadata = extractAndNormalizeMetadata(item);
          
          // Log if state is missing from normalized metadata
          if (normalizedMetadata.State == null && (item.State != null || item.STATE != null || item.state != null)) {
            logDebug(`[PerformanceDataService] ⚠️ State value lost during normalization:`, {
              original: { State: item.State, STATE: item.STATE, state: item.state },
              normalized: normalizedMetadata.State,
              event_id: item.event_id
            });
          }
          // Remove all case variations of metadata fields
          const metadataFieldsToRemove = [
            'GRADE', 'Grade', 'grade',
            'RACE', 'Race_number', 'race_number', 'RaceNumber', 'raceNumber',
            'LEG', 'Leg_number', 'leg_number', 'LegNumber', 'legNumber',
            'STATE', 'State', 'state',
            'CONFIG', 'Config', 'config',
            'EVENT', 'Event', 'event', 'event_name', 'Event_name', 'EVENT_NAME',
            'SOURCE_NAME', 'Source_name', 'source_name', 'Source', 'SOURCE', 'source',
            'TACK', 'Tack', 'tack',
          ];
          
          metadataFieldsToRemove.forEach(field => {
            if (field in item) {
              delete item[field];
            }
          });
          
          // Add normalized metadata fields
          return {
            ...item,
            ...normalizedMetadata
          };
        });
      }

      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const { passesBasicFilters } = await import('../utils/filterCore');
        const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
        const beforeCount = cloudData.length;
        cloudData = cloudData.filter((point: any) => {
          const normalized = extractAndNormalizeMetadata(point);
          const dataPointForFilter: any = {
            ...point,
            // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
            grade: normalized.Grade,
            race_number: normalized.Race_number,
            leg_number: normalized.Leg_number,
            state: normalized.State,
            // Also provide uppercase variations for backward compatibility
            GRADE: normalized.Grade,
            Grade: normalized.Grade,
            Race_number: normalized.Race_number,
            Leg_number: normalized.Leg_number,
            State: normalized.State,
            STATE: normalized.State,
            twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
            Twa: point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg,
          };
          return passesBasicFilters(dataPointForFilter, clientFilterConfig);
        });
        if (beforeCount !== cloudData.length) {
          logDebug(`[PerformanceDataService] Applied client-side filters to 1Hz API data: ${beforeCount} -> ${cloudData.length} points`);
        }
      }

      // Store in HuniDB (batch insert for performance)
      if (cloudData.length > 0) {
        logDebug(`[PerformanceDataService] Storing ${cloudData.length} 1Hz cloud points with dataset-id: ${datasetId}`);
        try {
          // Import normalization utility
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          
          const cloudEntries = cloudData.map((point: any, index: number) => {
            // Extract IDs from API response (use API values, fallback to store values if missing)
            const pointDatasetId = point.dataset_id ? String(point.dataset_id) : (datasetId || '0');
            const pointProjectId = point.project_id ? String(point.project_id) : projectId;
            const pointSourceId = point.source_id ? String(point.source_id) : sourceId;

            // Calculate tack from Twa if not already present
            let tack = point.tack ?? point.TACK;
            if (!tack || tack === 'NONE') {
              const twa = point.Twa ?? point.twa;
              if (twa !== null && twa !== undefined && typeof twa === 'number') {
                tack = twa < 0 ? 'PORT' : 'STBD';
              }
            }

            // CRITICAL: Extract metadata BEFORE destructuring to ensure state is preserved
            // Use normalization utility to extract and normalize metadata from the original point
            const normalizedMetadata = extractAndNormalizeMetadata(point);
            
            // Log first entry to check if state is being stored
            if (index === 0) {
              logDebug(`[PerformanceDataService] Storing 1Hz cloud entry - metadata extraction:`, {
                pointState: point.state ?? point.State ?? point.STATE,
                normalizedState: normalizedMetadata.State,
                event_id: point.event_id,
                normalizedMetadataKeys: Object.keys(normalizedMetadata),
                hasState: normalizedMetadata.State != null
              });
            }

            // Exclude metadata fields from data object (after extracting metadata)
            const { event_id, dataset_id, source_id, project_id, Datetime, tack: _tack, race_number, leg_number, grade, config, year, event, source_name, state, ...channelData } = point;

            return {
              id: `cloud-${pointDatasetId}-${pointProjectId}-${pointSourceId}-${point.event_id || '0'}-${point.Datetime || Date.now()}`,
              timestamp: point.Datetime ? new Date(point.Datetime).getTime() : Date.now(),
              datasetId: pointDatasetId,
              projectId: pointProjectId,
              sourceId: pointSourceId,
              eventId: point.event_id || 0,
              metadata: {
                ...normalizedMetadata,
                tack: normalizedMetadata.Tack ?? tack ?? 'NONE',
                datetime: point.Datetime ?? normalizedMetadata.Datetime,
                year: normalizedMetadata.Year ?? point.year ?? undefined,
              },
              data: channelData, // Channel values only (excludes metadata fields)
            };
          });
          if (!isMobileDevice()) {
            // Build applied filters for cache metadata - only API filters affect cache
            // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
            const appliedFilters: FilterSet = {
              events: apiFilters.EVENT || [],
              configs: apiFilters.CONFIG || [],
              grades: apiFilters.GRADE || [],
              dateRange: finalStartDate && finalEndDate ? { start: finalStartDate, end: finalEndDate } : undefined
              // STATE, RACE, LEG are client-side and don't affect cache metadata
            };
            
            // Cloud data storage removed - cloud.data table no longer used
            logDebug(`[PerformanceDataService] Skipping cloud data storage (deprecated) - ${cloudData.length} 1Hz points`);
          } else {
            logDebug(`[PerformanceDataService] Skipping HuniDB storage on mobile device`);
          }
        } catch (error) {
          logError(`[PerformanceDataService] Error storing cloud data:`, error);
        }
      }

      return cloudData;
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return [];
    }
    logError("Error fetching cloud data:", err as any);
    throw err;
  }
};

// Fetch target data
const fetchTargets = async (): Promise<PerformanceTargetData> => {
  const controller = new AbortController();

  try {
    const className = selectedClassName();

    // Check HuniDB first
    const projectId = selectedProjectId().toString();
    logDebug(`[PerformanceDataService] Fetching targets from HuniDB`);
    // Query all targets for the project, then find the latest one
      // Query targets from HuniDB (skip on mobile)
      const cachedTargets = isMobileDevice() ? [] : await huniDBStore.queryTargets(className, projectId);

    if (cachedTargets && cachedTargets.length > 0) {
      // Filter to only include non-polar targets (isPolar = 0 or undefined)
      const nonPolarTargets = cachedTargets.filter(t => (t.isPolar ?? 0) === 0);
      
      if (nonPolarTargets.length > 0) {
        // Sort by dateModified descending and get the latest
        const sortedTargets = nonPolarTargets.sort((a, b) => {
          const dateA = a.dateModified || 0;
          const dateB = b.dateModified || 0;
          return dateB - dateA;
        });
        const target = sortedTargets[0];
        logDebug(`[PerformanceDataService] Found ${nonPolarTargets.length} cached non-polar targets in HuniDB, using latest`);
        return {
          name: target.name,
          data: target.data
        };
      }
    }

    // Not in HuniDB, fetch from API
    logDebug(`[PerformanceDataService] No cached targets, fetching from API`);
    const response = await getData(
      `${apiEndpoints.app.targets}/latest?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&isPolar=0`,
      controller.signal
    );

    if (!response.success) {
      logError("Targets fetch failed:", response);
      throw new Error("Failed to fetch targets.");
    }

    const targetData = {
      name: response.data[0]?.name || '',
      data: response.data[0]?.json || {}
    };

    // Store in HuniDB
    if (targetData.name || Object.keys(targetData.data).length > 0) {
      logDebug(`[PerformanceDataService] Storing targets in HuniDB`);
      logDebug(`[PerformanceDataService] Target data:`, { name: targetData.name, dataKeys: Object.keys(targetData.data) });
      try {
        if (!isMobileDevice()) {
          await huniDBStore.storeTarget(className, {
            id: `target-${projectId}-${targetData.name || 'default'}`,
            projectId,
            name: targetData.name || 'targets',
            isPolar: 0,
            data: targetData.data,
          });
          logDebug(`[PerformanceDataService] Successfully stored targets in HuniDB`);
        } else {
          logDebug(`[PerformanceDataService] Skipping HuniDB storage on mobile device`);
        }
      } catch (error) {
        logError(`[PerformanceDataService] Error storing targets:`, error);
      }
    }

    return targetData;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { name: '', data: {} };
    }
    logError("Error fetching targets:", err as any);
    return { name: '', data: {} };
  }
};

// Extract required channels from chart objects
const getRequiredChannels = (chartObjects: any[]): string[] => {
  const { twaName, twsName, bspName } = defaultChannelsStore;
  let channels = ["Datetime", twaName(), twsName(), bspName()];


  if (chartObjects && chartObjects.length > 0) {
    chartObjects.forEach(chartObject => {
      if (chartObject.charts && chartObject.charts[0] && chartObject.charts[0].series) {
        chartObject.charts[0].series.forEach((chart: any) => {
          if (chart.yaxis && chart.yaxis.name) {
            channels.push(chart.yaxis.name);
          }
          // Also include x-axis and t-axis channels (but exclude PAGE DEFAULT and DEFAULT)
          if (chart.xaxis && chart.xaxis.name) {
            const xaxisName = chart.xaxis.name;
            if (xaxisName !== "PAGE DEFAULT" && xaxisName !== "DEFAULT") {
              channels.push(xaxisName);
            }
          }
          if (chart.taxis && chart.taxis.name) {
            channels.push(chart.taxis.name);
          }
        });
      }
    });
  }

  const uniqueChannels = [...new Set(channels)];

  // Ensure we have at least the basic channels
  if (uniqueChannels.length === 0) {
    logWarn("No channels found, using fallback channels");
    const { twaName, twsName, bspName } = defaultChannelsStore;
    return ["Datetime", twaName(), twsName(), bspName()];
  }

  return uniqueChannels;
};

/** Add dateStringLocal and timeStringLocal to each item (mutates in place). Call after fetch, before process. */
const enrichWithLocalTimeStrings = (items: any[]): void => {
  if (!items || !Array.isArray(items)) return;
  items.forEach((item: any) => {
    const rawDt = item.Datetime ?? item.datetime ?? '';
    const tz = (item.timezone ?? item.Timezone ?? '').trim() || undefined;
    if (!rawDt || !tz) return;
    try {
      const date = typeof rawDt === 'string' ? new Date(rawDt.replace(/ /g, 'T')) : new Date(rawDt);
      if (!isNaN(date.getTime())) {
        item.dateStringLocal = formatDate(date, tz) ?? undefined;
        item.timeStringLocal = formatTime(date, tz) ?? undefined;
      }
    } catch {
      // skip invalid rows
    }
  });
};

/**
 * Extract channel mapping from chart configuration
 * Maps display names (from builder) to actual data field names (from API/database)
 * 
 * @param chartObjects - Chart configuration objects from builder
 * @returns Mapping object: { displayName: dataFieldName }
 * 
 * Example:
 *   { "Twa": "twa_deg", "Tws": "tws_kts", "Bsp": "bsp_kts" }
 */
const getChannelMapping = (chartObjects: any[]): Record<string, string> => {
  const mapping: Record<string, string> = {};
  
  // Default mappings for common channels (fallback) - use default channel names
  // CRITICAL: Preserve original casing - channel names are case-sensitive in the API
  const { twaName: twaNameMap, twsName: twsNameMap, bspName: bspNameMap, vmgName: vmgNameMap } = defaultChannelsStore;
  const twaFieldMap = twaNameMap(); // Already has correct casing like 'Twa_deg'
  const twsFieldMap = twsNameMap(); // Already has correct casing like 'Tws_kph'
  const bspFieldMap = bspNameMap(); // Already has correct casing like 'Bsp_kph'
  const vmgFieldMap = vmgNameMap(); // Already has correct casing like 'Vmg_kph'
  const defaultMappings: Record<string, string> = {
    'Twa': twaFieldMap,
    [twaNameMap()]: twaFieldMap,
    'Tws': twsFieldMap,
    [twsNameMap()]: twsFieldMap,
    'Bsp': bspFieldMap,
    [bspNameMap()]: bspFieldMap,
    'Vmg': vmgFieldMap,
    [vmgNameMap()]: vmgFieldMap,
    'Cwa_n': 'Cwa_n_deg', // Preserve casing
    'Cwa_n_deg': 'Cwa_n_deg',
    'Datetime': 'Datetime' // Preserve casing (though API may normalize this)
  };

  if (chartObjects && chartObjects.length > 0) {
    chartObjects.forEach(chartObject => {
      if (chartObject.charts && chartObject.charts[0] && chartObject.charts[0].series) {
        chartObject.charts[0].series.forEach((series: any) => {
          // Extract x-axis mapping
          if (series.xaxis && series.xaxis.name) {
            const displayName = series.xaxis.name;
            // Use dataField if available, otherwise use displayName (preserve original casing like 'Tws_kts')
            // Channel names are case-sensitive in the API, so we must preserve the original casing
            const dataField = series.xaxis.dataField || displayName;
            mapping[displayName] = dataField;
          }
          
          // Extract y-axis mapping
          if (series.yaxis && series.yaxis.name) {
            const displayName = series.yaxis.name;
            // Use dataField if available, otherwise use displayName (preserve original casing like 'Tws_kts')
            // Channel names are case-sensitive in the API, so we must preserve the original casing
            const dataField = series.yaxis.dataField || displayName;
            mapping[displayName] = dataField;
          }
          
          // Extract t-axis mapping (if exists)
          if (series.taxis && series.taxis.name) {
            const displayName = series.taxis.name;
            // Use dataField if available, otherwise use displayName (preserve original casing like 'Tws_kts')
            // Channel names are case-sensitive in the API, so we must preserve the original casing
            const dataField = series.taxis.dataField || displayName;
            mapping[displayName] = dataField;
          }
        });
      }
    });
  }

  // Merge with defaults, but user-configured mappings take precedence
  return { ...defaultMappings, ...mapping };
};

/**
 * Extract aggregate type mapping from chart configuration
 * Groups channels by their aggregate type (AVG, STD, AAV)
 * X-axis channels (Tws_kts, Bsp_kts) always use AVG aggregate
 * 
 * @param chartObjects - Chart configuration objects from builder
 * @returns Array of { aggregateType, channels, series } grouped by aggregate type
 * 
 * Example:
 *   [
 *     { aggregateType: 'AVG', channels: ['Tws_kts', 'Bsp_kts'], series: [...] },
 *     { aggregateType: 'STD', channels: ['Bsp_kts'], series: [...] }
 *   ]
 */
const getAggregateTypeMapping = (chartObjects: any[]): { aggregateType: string; channels: string[]; series: any[] }[] => {
  const aggregateMap = new Map<string, { channels: Set<string>; series: any[] }>();
  
  // Always include basic channels with AVG
  const { twaName, twsName, bspName } = defaultChannelsStore;
  const basicChannels = new Set<string>(['Datetime', twaName(), twsName(), bspName()]);
  
  if (chartObjects && chartObjects.length > 0) {
    chartObjects.forEach(chartObject => {
      if (chartObject.charts && chartObject.charts[0] && chartObject.charts[0].series) {
        chartObject.charts[0].series.forEach((series: any) => {
          // Get aggregate types from series (xType and yType), default to 'AVG' for backward compatibility
          const xType = (series.xType || 'AVG').toUpperCase();
          const yType = (series.yType || 'AVG').toUpperCase();
          
          // Collect all unique aggregate types needed
          const aggregateTypes = new Set<string>([xType, yType, 'AVG']); // Always include AVG for targets
          
          aggregateTypes.forEach(aggregateType => {
            // Ensure aggregate type exists in map
            if (!aggregateMap.has(aggregateType)) {
              aggregateMap.set(aggregateType, { channels: new Set<string>(), series: [] });
            }
            
            const group = aggregateMap.get(aggregateType)!;
            
            // X-axis channels use xType aggregate type
            // But exclude PAGE DEFAULT and DEFAULT as they're not real channels
            if (series.xaxis && series.xaxis.name) {
              const xAxisName = series.xaxis.name;
              if (xAxisName !== "PAGE DEFAULT" && xAxisName !== "DEFAULT") {
                if (aggregateType === xType) {
                  group.channels.add(xAxisName);
                }
              }
            }
            
            // Y-axis channels use yType aggregate type
            if (series.yaxis && series.yaxis.name && aggregateType === yType) {
              group.channels.add(series.yaxis.name);
            }
            
            // T-axis (target) channels always use AVG
            if (series.taxis && series.taxis.name && aggregateType === 'AVG') {
              group.channels.add(series.taxis.name);
            }
          });
          
          // Add series to the yType group (for series tracking)
          if (!aggregateMap.has(yType)) {
            aggregateMap.set(yType, { channels: new Set<string>(), series: [] });
          }
          aggregateMap.get(yType)!.series.push(series);
        });
      }
    });
  }
  
  // Ensure AVG group exists and includes basic channels
  if (!aggregateMap.has('AVG')) {
    aggregateMap.set('AVG', { channels: new Set<string>(), series: [] });
  }
  const avgGroup = aggregateMap.get('AVG')!;
  basicChannels.forEach(ch => avgGroup.channels.add(ch));
  
  // Convert map to array format
  return Array.from(aggregateMap.entries()).map(([aggregateType, group]) => ({
    aggregateType,
    channels: Array.from(group.channels),
    series: group.series
  }));
};

// Process and validate performance data
const processPerformanceData = (
  aggregates: PerformanceAggregatePoint[],
  cloud: PerformanceCloudPoint[],
  targets: PerformanceTargetData,
  channelMapping: Record<string, string> = {}
) => {
  // Use default mapping if none provided - use default channel names
  const { twaName: twaNameMapping, twsName: twsNameMapping, bspName: bspNameMapping, vmgName: vmgNameMapping } = defaultChannelsStore;
  const twaFieldMapping = twaNameMapping().toLowerCase();
  const twsFieldMapping = twsNameMapping().toLowerCase();
  const bspFieldMapping = bspNameMapping().toLowerCase();
  const vmgFieldMapping = vmgNameMapping().toLowerCase();
  const mapping = Object.keys(channelMapping).length > 0 
    ? channelMapping 
    : {
        'Twa': twaFieldMapping,
        [twaNameMapping()]: twaFieldMapping,
        'Tws': twsFieldMapping,
        [twsNameMapping()]: twsFieldMapping,
        'Bsp': bspFieldMapping,
        [bspNameMapping()]: bspFieldMapping,
        'Vmg': vmgFieldMapping,
        [vmgNameMapping()]: vmgFieldMapping,
        'Cwa_n': 'cwa_n_deg',
        'Cwa_n_deg': 'cwa_n_deg',
        'Datetime': 'datetime'
      };

  // Get channel names from defaultChannelsStore for better field resolution
  const { twaName, twsName, bspName, vmgName } = defaultChannelsStore;
  const twaField = twaName();
  const twsField = twsName();
  const bspField = bspName();
  const vmgField = vmgName();

  // Helper function to get channel value with simplified resolution
  // unifiedDataStore already normalizes metadata and preserves channel names, so we can simplify
  const getChannelValueSimplified = (item: any, fieldName: string): any => {
    // Try default channel name first (most reliable)
    if (item[fieldName] !== undefined) return item[fieldName];
    // Try resolveDataField for case variations (handles Twa/TWA/twa, etc.)
    const resolved = resolveDataField(item, fieldName);
    if (resolved !== undefined) return resolved;
    return undefined;
  };

  // Validate data structure and add any missing required fields
  const processedAggregates = aggregates.map(item => {
    // Support both: (1) lowercase from dataset/HuniDB, (2) fleet shape from extractAndNormalizeMetadata (Grade, Race_number, Source_name, etc.)
    const twaValue = getChannelValueSimplified(item, twaField) ?? 0;
    const tack = item.tack ?? item.Tack ?? item.TACK ?? (twaValue && twaValue < 0 ? 'PORT' : 'STBD');

    let race = item.race_number ?? item.Race_number ?? item.metadata?.race_number ?? item.metadata?.Race_number ?? 'NONE';
    if (race === -1 || race === '-1' || race === 'TRAINING') {
      race = 'TRAINING';
    }
    const leg = item.leg_number ?? item.Leg_number ?? item.metadata?.leg_number ?? item.metadata?.Leg_number ?? 'NONE';
    const grade = item.grade ?? item.Grade ?? item.metadata?.grade ?? item.metadata?.Grade ?? null;
    const config = item.config ?? item.Config ?? item.metadata?.config ?? item.metadata?.Config ?? 'NONE';
    const year = item.year ?? item.Year ?? item.metadata?.year ?? item.metadata?.Year ?? 'NONE';
    const event = item.event ?? item.Event ?? item.metadata?.event ?? item.metadata?.Event ?? 'NONE';
    const state = item.state ?? item.State ?? item.metadata?.state ?? item.metadata?.State ?? null;

    // Get channel values - unifiedDataStore preserves channel names, so use simplified resolution
    const twa = getChannelValueSimplified(item, twaField) ?? 0;
    const tws = getChannelValueSimplified(item, twsField) ?? 0;
    const bsp = getChannelValueSimplified(item, bspField) ?? 0;
    const vmg = getChannelValueSimplified(item, vmgField);
    const cwa_n = getChannelValueSimplified(item, 'Cwa_n') ?? getChannelValueSimplified(item, 'Cwa_n_deg');

    // Build base object with core identifiers and standard fields
    // CRITICAL: Preserve Datetime from multiple sources - it's needed for timeline charts
    // Check all possible locations for datetime (Datetime, datetime, DATETIME, metadata.datetime)
    let datetimeValue: Date | string = '';
    const dtObj: unknown = item.Datetime;
    if (dtObj instanceof Date) {
      datetimeValue = dtObj;
    } else if (item.Datetime) {
      datetimeValue = typeof item.Datetime === 'string' ? new Date(item.Datetime.replace(/ /, 'T')) : new Date(item.Datetime);
    } else if (typeof item.datetime === 'object' && item.datetime !== null && item.datetime instanceof Date) {
      datetimeValue = item.datetime;
    } else if (item.datetime) {
      datetimeValue = typeof item.datetime === 'string' ? new Date(item.datetime.replace(/ /, 'T')) : new Date(item.datetime);
    } else if (item.metadata?.datetime) {
      const metaDatetime = item.metadata.datetime;
      if (metaDatetime instanceof Date) {
        datetimeValue = metaDatetime;
      } else if (typeof metaDatetime === 'string') {
        datetimeValue = new Date(metaDatetime.replace(/ /, 'T'));
      } else {
        datetimeValue = new Date(metaDatetime);
      }
    } else if (item.DATETIME) {
      datetimeValue = typeof item.DATETIME === 'string' ? new Date(item.DATETIME.replace(/ /, 'T')) : new Date(item.DATETIME);
    }
    // If still no datetime found, use empty string (will be filtered out by ScatterTimeseries)

    // Use pre-set local time strings when present (from enrichWithLocalTimeStrings); else compute
    const tz = (item.timezone ?? item.Timezone ?? '').trim() || undefined;
    let dateStringLocal: string | undefined = item.dateStringLocal;
    let timeStringLocal: string | undefined = item.timeStringLocal;
    if ((dateStringLocal == null || timeStringLocal == null) && datetimeValue && tz) {
      try {
        const dateForFormat = datetimeValue instanceof Date ? datetimeValue : new Date(typeof datetimeValue === 'string' ? datetimeValue.replace(/ /g, 'T') : datetimeValue);
        if (!isNaN(dateForFormat.getTime())) {
          dateStringLocal = dateStringLocal ?? formatDate(dateForFormat, tz) ?? undefined;
          timeStringLocal = timeStringLocal ?? formatTime(dateForFormat, tz) ?? undefined;
        }
      } catch {
        // leave undefined, chart will fall back to formatting Datetime
      }
    }

    // source_name: support lowercase and fleet API shape (Source_name, SOURCE_NAME)
    const sourceName = item.source_name ?? item.Source_name ?? item.SOURCE_NAME ?? item.metadata?.source_name ?? 'Unknown';

    const baseObject: any = {
      // Core identifiers (preserve original lowercase names from API)
      event_id: item.event_id || '',
      dataset_id: item.dataset_id,
      project_id: item.project_id,
      source_id: item.source_id,
      source_name: sourceName,
      datetime: datetimeValue,

      // Performance metrics - unifiedDataStore preserves Datetime field
      Datetime: datetimeValue,
      dateStringLocal,
      timeStringLocal,
      Twa: twa,
      Tws: tws,
      Bsp: bsp,
      Vmg: vmg,
      Cwa_n: cwa_n,
      // CRITICAL: Also add fields using default channel names for compatibility
      // These are needed for FleetScatter and other components that expect these field names
      // Use default channel names from defaultChannelsStore (class-specific, e.g., Tws_kts/Tws_kph, Bsp_kts/Bsp_kph)
      [twsField]: tws,  // Add default TWS field (class-specific, e.g., Tws_kph for GP50)
      [bspField]: bsp,  // Add default BSP field (class-specific, e.g., Bsp_kph for GP50)
      [twaField]: twa,  // Add default TWA field (e.g., Twa_deg - same for all classes)
      [defaultChannelsStore.vmgName()]: vmg,  // Add default VMG field (class-specific, e.g., Vmg_kph for GP50)
      Cwa_n_deg: cwa_n,  
      tack: tack,
      race_number: race,
      leg_number: leg,
      grade: grade,
      config: config,
      year: year,
      event: event,
      state: state,
      State: state,
      STATE: state
    };

    // Add all configured channels dynamically
    // unifiedDataStore preserves channel names, so we can use simplified resolution
    Object.keys(mapping).forEach(displayName => {
      const dataField = mapping[displayName];
      const value = getChannelValueSimplified(item, dataField) ?? getChannelValueSimplified(item, displayName);
      if (value !== undefined && !baseObject.hasOwnProperty(displayName)) {
        baseObject[displayName] = value;
      }
    });

    // CRITICAL: Preserve Twa_deg_avg as metadata (always from AVG aggregate type)
    // This is used for consistent upwind/downwind filtering and TACK calculation
    // Twa_deg remains the actual data field for the aggregate type being queried
    // Check all possible case variations and ensure it's preserved
    const twaDegAvg = item.Twa_deg_avg ?? item.twa_deg_avg ?? item.TWA_DEG_AVG ?? item['Twa_deg_avg'] ?? item['twa_deg_avg'];
    if (twaDegAvg !== undefined && twaDegAvg !== null) {
      baseObject.Twa_deg_avg = twaDegAvg;
      baseObject.twa_deg_avg = twaDegAvg; // Also preserve lowercase version
    }

    // CRITICAL: Preserve ALL numeric fields from the original item, including suffixed fields
    // (e.g., Bsp_kts_std, Bsp_kts_aav) that were created during merge in fetchAggregatesByType
    // These suffixed fields are NOT in the mapping but are needed for STD/AAV charts
    Object.keys(item).forEach(key => {
        // Skip metadata fields that are already handled above
        const skipFields = [
          'event_id', 'Datetime', 'dataset_id', 'project_id', 'source_id', 'source_name', 'datetime',
          'TACK', 'RACE', 'LEG', 'GRADE', 'CONFIG', 'YEAR', 'EVENT', 'State', 'STATE',
          'tack', 'race_number', 'leg_number', 'grade', 'config', 'year', 'event',
          'Race_number', 'Leg_number', 'Grade', 'Config', 'Year', 'Event',
          'metadata', 'Twa', 'Tws', 'Bsp', 'Vmg', 'Cwa_n', // These are handled above with proper mapping
          'Twa_deg_avg', 'twa_deg_avg' // Metadata field - already handled above
        ];
      
      // Only copy numeric fields and fields with aggregate suffixes (_std, _aav, etc.)
      const isNumeric = typeof item[key] === 'number' && !isNaN(item[key]);
      const hasAggregateSuffix = /_(std|aav|avg|min|max)$/i.test(key);
      
      if (!skipFields.includes(key) && (isNumeric || hasAggregateSuffix)) {
        // Preserve the field as-is (including suffixed fields like Bsp_kts_std)
        if (!baseObject.hasOwnProperty(key)) {
          baseObject[key] = item[key];
        }
      }
    });

    return baseObject;
  });

  const processedCloud = cloud.map(item => {
    // unifiedDataStore normalizes metadata fields to lowercase, so use simplified access
    const twaValue = getChannelValueSimplified(item, twaField) ?? 0;
    const tack = item.tack ?? item.TACK ?? (twaValue && twaValue < 0 ? 'PORT' : 'STBD');
    
    // Metadata fields are normalized to lowercase by fetchCloud (same as aggregates)
    // unifiedDataStore normalizes API responses to lowercase before storing
    // HuniDB stores and returns metadata in lowercase (race_number, leg_number, grade, state, etc.)
    // When formatting cached data, entry.metadata (lowercase) is spread into the item
    // So we ONLY need to check lowercase fields
    let race = item.race_number ?? item.metadata?.race_number ?? 'NONE';
    if (race === -1 || race === '-1' || race === 'TRAINING') {
      race = 'TRAINING';
    }
    const leg = item.leg_number ?? item.metadata?.leg_number ?? 'NONE';
    const grade = item.grade ?? item.metadata?.grade ?? null;
    const config = item.config ?? item.metadata?.config ?? 'NONE';
    const year = item.year ?? item.metadata?.year ?? 'NONE';
    const event = item.event ?? item.metadata?.event ?? 'NONE';
    const state = item.state ?? item.metadata?.state ?? null;

    // Get channel values - unifiedDataStore preserves channel names
    const twa = getChannelValueSimplified(item, twaField) ?? 0;
    const tws = getChannelValueSimplified(item, twsField) ?? 0;
    const bsp = getChannelValueSimplified(item, bspField) ?? 0;
    const vmg = getChannelValueSimplified(item, vmgField);
    const cwa_n = getChannelValueSimplified(item, 'Cwa_n') ?? getChannelValueSimplified(item, 'Cwa_n_deg');

    // Use pre-set local time strings when present (from enrichWithLocalTimeStrings); else compute
    const rawDtCloud = item.Datetime ?? item.datetime ?? '';
    const tzCloud = (item.timezone ?? item.Timezone ?? '').trim() || undefined;
    let dateStringLocalCloud: string | undefined = item.dateStringLocal;
    let timeStringLocalCloud: string | undefined = item.timeStringLocal;
    if ((dateStringLocalCloud == null || timeStringLocalCloud == null) && rawDtCloud && tzCloud) {
      try {
        const dateCloud = typeof rawDtCloud === 'string' ? new Date(rawDtCloud.replace(/ /g, 'T')) : new Date(rawDtCloud);
        if (!isNaN(dateCloud.getTime())) {
          dateStringLocalCloud = dateStringLocalCloud ?? formatDate(dateCloud, tzCloud) ?? undefined;
          timeStringLocalCloud = timeStringLocalCloud ?? formatTime(dateCloud, tzCloud) ?? undefined;
        }
      } catch {
        // leave undefined
      }
    }

    // Build base object with core identifiers and standard fields
    const baseObject: any = {
      // Core identifiers (preserve original lowercase names from API)
      event_id: item.event_id || '',
      dataset_id: item.dataset_id,
      project_id: item.project_id,
      source_id: item.source_id,
      source_name: item.source_name,
      datetime: item.datetime,

      // Performance metrics - unifiedDataStore preserves Datetime field
      Datetime: item.Datetime ?? item.datetime ?? '',
      dateStringLocal: dateStringLocalCloud,
      timeStringLocal: timeStringLocalCloud,
      Twa: twa,
      Tws: tws,
      Bsp: bsp,
      Vmg: vmg,
      Cwa_n: cwa_n,
      // CRITICAL: Also add fields using default channel names for compatibility
      // These are needed for FleetScatter and other components that expect these field names
      // Use default channel names from defaultChannelsStore (class-specific, e.g., Tws_kts/Tws_kph, Bsp_kts/Bsp_kph)
      [twsField]: tws,  // Add default TWS field (class-specific, e.g., Tws_kph for GP50)
      [bspField]: bsp,  // Add default BSP field (class-specific, e.g., Bsp_kph for GP50)
      [twaField]: twa,  // Add default TWA field (e.g., Twa_deg - same for all classes)
      [defaultChannelsStore.vmgName()]: vmg,  // Add default VMG field (class-specific, e.g., Vmg_kph for GP50)
      Cwa_n_deg: cwa_n,  // Add Cwa_n_deg field (same value as Cwa_n)

      // Lowercase metadata only (single nomenclature; resolveDataField maps UI keys)
      tack: tack,
      race_number: race,
      leg_number: leg,
      grade: grade,
      config: config,
      year: year,
      event: event,
      state: state,
      State: state,
      STATE: state
    };

    // Add all configured channels dynamically
    // unifiedDataStore preserves channel names, so we can use simplified resolution
    Object.keys(mapping).forEach(displayName => {
      const dataField = mapping[displayName];
      const value = getChannelValueSimplified(item, dataField) ?? getChannelValueSimplified(item, displayName);
      if (value !== undefined && !baseObject.hasOwnProperty(displayName)) {
        baseObject[displayName] = value;
      }
    });

    return baseObject;
  });

  return {
    aggregates: processedAggregates,
    cloud: processedCloud,
    targets
  };
};

// Create the service object
export const performanceDataService: PerformanceDataService = {
  fetchCharts,
  fetchDatasetDate,
  fetchAggregates,
  fetchAggregatesByType,
  fetchCloud,
  fetchTargets,
  getRequiredChannels,
  enrichWithLocalTimeStrings,
  getChannelMapping,
  getAggregateTypeMapping,
  processPerformanceData
};

export default performanceDataService;
