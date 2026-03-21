/**
 * Maneuvers Data Service
 * 
 * Unified data fetching service for maneuvers components that abstracts
 * the differences between dataset, fleet, and historical data sources.
 */

import { getData } from '../utils/global';
import { getManeuversConfig, ManeuversContext } from '../utils/maneuversConfig';
import { persistantStore } from '../store/persistantStore';
import { sourcesStore } from '../store/sourcesStore';
import { debug, error as logError, warn as logWarning, log } from '../utils/console';
import { apiEndpoints } from '@config/env';

const { selectedClassName, selectedProjectId } = persistantStore;

export interface ManeuversDataParams {
  eventType: string;
  /**
   * Description/phase identifier (e.g., '0_normalized', '1_standard', '2_normalized')
   * Required for mapdata and timeseries endpoints
   */
  description?: string;
  /**
   * Explicit list of event_ids to fetch data for.
   * Required for map and time series endpoints when eventList.length <= 100.
   * When eventList.length > 100, timeRange and filters are used instead.
   */
  eventList?: number[];
  /**
   * Time range parameters (used when eventList.length > 100)
   */
  timeRange?: {
    startDate: string;
    endDate: string;
  };
  /**
   * Filter parameters (used when eventList.length > 100)
   */
  filters?: {
    GRADE?: number[];
    YEAR?: number[];
    EVENT?: string[];
    CONFIG?: string[];
    STATE?: string[];
    SOURCE_NAME?: string[];
    /** TRAINING = only training (race_number -1); RACING = exclude training */
    TRAINING_RACING?: string[];
  };
  /**
   * Source names array (required, for fleet/multi-source queries)
   */
  sourceNames?: string[];
  /**
   * Count for history queries (default 5)
   */
  count?: number;
  /**
   * Date for single date queries
   */
  date?: string;
  /**
   * Channels array for table data queries
   */
  channels?: string[];
  signal?: AbortSignal;
}

/**
 * Fetch table data for maneuvers
 */
export async function fetchTableData(
  context: ManeuversContext,
  params: ManeuversDataParams
): Promise<any[]> {
  try {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (!className || !projectId) {
      logWarning('fetchTableData: className and projectId are required');
      return [];
    }

    // Check if this is a history query (has timeRange) or single date query (has date)
    if (params.timeRange && params.timeRange.startDate && params.timeRange.endDate) {
      // History query: use new /maneuvers-history endpoint
      const sourceNames = params.sourceNames;
      
      if (!sourceNames || sourceNames.length === 0) {
        logWarning('fetchTableData: sourceNames is required for history queries');
        return [];
      }

      const endpoint = `${apiEndpoints.app.data}/maneuvers-history`;
      let url = new URL(endpoint, window.location.origin);
      
      url.searchParams.append('class_name', className);
      url.searchParams.append('project_id', String(projectId));
      url.searchParams.append('source_names', JSON.stringify(sourceNames));
      
      url.searchParams.append('start_date', params.timeRange.startDate);
      url.searchParams.append('end_date', params.timeRange.endDate);
      url.searchParams.append('event_type', params.eventType.toLowerCase());
      
      // Channels are required for table data
      if (params.channels && params.channels.length > 0) {
        url.searchParams.append('channels', JSON.stringify(params.channels));
      } else {
        logWarning('fetchTableData: channels are required for history queries');
        return [];
      }
      
      if (params.count) {
        url.searchParams.append('count', String(params.count));
      }
      
      if (params.filters && Object.keys(params.filters).length > 0) {
        url.searchParams.append('filters', JSON.stringify(params.filters));
      }

      const result = await getData(url.pathname + url.search, params.signal);
      if (result.success && result.data && Array.isArray(result.data)) {
        return result.data;
      } else {
        logWarning('Failed to fetch history table data:', result.message || 'Unknown error');
        return [];
      }
    } else if (params.date) {
      // Single date query: use new /maneuvers endpoint
      const sourceNames = params.sourceNames;
      
      if (!sourceNames || sourceNames.length === 0) {
        logWarning('fetchTableData: sourceNames is required for single date queries');
        return [];
      }

      const endpoint = `${apiEndpoints.app.data}/maneuvers`;
      let url = new URL(endpoint, window.location.origin);
      
      url.searchParams.append('class_name', className);
      url.searchParams.append('project_id', String(projectId));
      url.searchParams.append('source_names', JSON.stringify(sourceNames));
      
      url.searchParams.append('date', params.date);
      url.searchParams.append('event_type', params.eventType.toLowerCase());
      
      // Channels are required for table data
      if (params.channels && params.channels.length > 0) {
        url.searchParams.append('channels', JSON.stringify(params.channels));
      } else {
        logWarning('fetchTableData: channels are required for single date queries');
        return [];
      }
      
      // For single date, only allow GRADE, STATE, SOURCE_NAME filters
      if (params.filters) {
        const simpleFilters: any = {};
        if (params.filters.GRADE) simpleFilters.GRADE = params.filters.GRADE;
        if (params.filters.STATE) simpleFilters.STATE = params.filters.STATE;
        if (params.filters.SOURCE_NAME) simpleFilters.SOURCE_NAME = params.filters.SOURCE_NAME;
        
        if (Object.keys(simpleFilters).length > 0) {
          url.searchParams.append('filters', JSON.stringify(simpleFilters));
        }
      }

      const result = await getData(url.pathname + url.search, params.signal);
      if (result.success && result.data && Array.isArray(result.data)) {
        return result.data;
      } else {
        logWarning('Failed to fetch single date table data:', result.message || 'Unknown error');
        return [];
      }
    } else {
      // Fallback to old config-based approach for backward compatibility
      const config = getManeuversConfig(context);
      const queryParams = config.buildQueryParams({
        className,
        projectId,
        eventType: params.eventType
      });

      let url: URL;
      if (config.apiEndpoints.table.startsWith('/') || config.apiEndpoints.table.startsWith('./')) {
        url = new URL(config.apiEndpoints.table, window.location.origin);
      } else {
        url = new URL(config.apiEndpoints.table);
      }
      Object.keys(queryParams).forEach(key => {
        url.searchParams.append(key, String(queryParams[key]));
      });

      const result = await getData(url.pathname + url.search, params.signal);
      if (result.success && result.data && Array.isArray(result.data)) {
        return result.data;
      } else {
        logWarning('Failed to fetch table data:', result.message || 'Unknown error');
        return [];
      }
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return [];
    }
    logError('Error fetching table data:', error);
    return [];
  }
}

/**
 * Fetch map data for maneuvers
 */
export async function fetchMapData(
  context: ManeuversContext,
  params: ManeuversDataParams
): Promise<any[]> {
  try {
    debug('fetchMapData called - context:', context, 'eventList length:', params.eventList?.length || 0, 'has timeRange:', !!params.timeRange);
    
    // Use time-range endpoint only when caller explicitly provides timeRange (e.g. for initial load without event list).
    // When we have an event list (any size), always use event_list path so map data matches table filtering.
    // For >100 events we chunk and call event_list endpoint per batch to avoid URL length limits.
    const eventListLength = params.eventList?.length || 0;
    const useTimeRange = !!params.timeRange && eventListLength === 0;
    
    debug('fetchMapData - eventListLength:', eventListLength, 'useTimeRange:', useTimeRange, 'has timeRange param:', !!params.timeRange);
    
    if (useTimeRange) {
      // Use new history endpoint
      if (!params.timeRange || !params.timeRange.startDate || !params.timeRange.endDate) {
        logError('fetchMapData: timeRange is required when eventList.length > 100 but was not provided. eventList.length:', params.eventList?.length);
        // Fallback: use wide date range if not provided
        params.timeRange = {
          startDate: '2020-01-01',
          endDate: '2099-12-31'
        };
        logWarning('fetchMapData: Using fallback date range:', params.timeRange);
      }

      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        logWarning('fetchMapData: className and projectId are required');
        return [];
      }

      // Description is required for mapdata endpoint
      if (!params.description || params.description.trim() === '') {
        logWarning('fetchMapData: description is required for history mapdata queries');
        return [];
      }

      // Source names are required for history mapdata endpoint
      // Auto-populate if missing for fleet/historical contexts
      if (!params.sourceNames || params.sourceNames.length === 0) {
        if (context === 'fleet') {
          // Try to get sources from sourcesStore
          if (sourcesStore.isReady()) {
            const allSources = sourcesStore.sources();
            if (allSources && allSources.length > 0) {
              params.sourceNames = allSources.map((s: any) => s.source_name).filter((name: string) => name);
              log(`[maneuversDataService] fetchMapData - Auto-populated sourceNames for fleet context: ${JSON.stringify(params.sourceNames)}`);
            }
          }
        } else if (context === 'historical') {
          // Try to get source from selectedSourceId
          const { selectedSourceId } = persistantStore;
          const sourceId = selectedSourceId();
          if (sourceId && sourceId > 0) {
            const sources = sourcesStore.sources();
            const source = sources.find((s: any) => s.source_id === sourceId);
            if (source && source.source_name) {
              params.sourceNames = [source.source_name];
              log(`[maneuversDataService] fetchMapData - Auto-populated sourceNames for historical context: ${JSON.stringify(params.sourceNames)}`);
            }
          }
        }
        
        // Final check - still missing?
        if (!params.sourceNames || params.sourceNames.length === 0) {
          logWarning('fetchMapData: sourceNames is required for history mapdata queries');
          return [];
        }
      }

      const endpoint = `${apiEndpoints.app.data}/maneuvers-history-mapdata`;
      let url = new URL(endpoint, window.location.origin);
      
      url.searchParams.append('class_name', className);
      url.searchParams.append('project_id', String(projectId));
      url.searchParams.append('desc', params.description);
      url.searchParams.append('source_names', JSON.stringify(params.sourceNames));
      url.searchParams.append('start_date', params.timeRange.startDate);
      url.searchParams.append('end_date', params.timeRange.endDate);
      url.searchParams.append('event_type', params.eventType.toLowerCase());
      
      if (params.count) {
        url.searchParams.append('count', String(params.count));
      }
      
      if (params.filters && Object.keys(params.filters).length > 0) {
        url.searchParams.append('filters', JSON.stringify(params.filters));
      }

      const fullUrl = url.pathname + url.search;
      debug('fetchMapData - using history endpoint:', fullUrl);
      
      // Always log the full request URL and filters for debugging
      log(`[maneuversDataService] fetchMapData - Full request URL: ${fullUrl}`);
      if (params.filters) {
        log(`[maneuversDataService] fetchMapData - Filters: ${JSON.stringify(params.filters)}`);
      }
      if (params.timeRange) {
        log(`[maneuversDataService] fetchMapData - Time range: ${JSON.stringify(params.timeRange)}`);
      }
      
      const result = await getData(fullUrl, params.signal);
      debug('fetchMapData - API response success:', result.success, 'data length:', result.data?.length || 0);
      
      // Log full request details if no data returned (for debugging)
      if (result.success && (!result.data || result.data.length === 0)) {
        log(`[maneuversDataService] fetchMapData returned 0 results. Request: ${fullUrl}`);
        if (params.filters) {
          log(`[maneuversDataService] Filters applied: ${JSON.stringify(params.filters)}`);
        }
      }

      if (result.success && result.data && Array.isArray(result.data)) {
        return result.data;
      } else {
        logError('Failed to fetch map data by range:', result.message || 'Unknown error');
        return [];
      }
    } else {
      // Use event_list endpoint (same criteria as table so selection matches map)
      if (!params.eventList || !Array.isArray(params.eventList) || params.eventList.length === 0) {
        logWarning('fetchMapData: eventList is required and must be non-empty. Skipping API call.');
        debug('fetchMapData - returning early: no eventList');
        return [];
      }

      const config = getManeuversConfig(context);
      const BATCH_SIZE = 100;
      const batches: number[][] = [];
      for (let i = 0; i < params.eventList.length; i += BATCH_SIZE) {
        batches.push(params.eventList.slice(i, i + BATCH_SIZE));
      }

      const allData: any[] = [];
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const queryParams = config.buildQueryParams({
          className: selectedClassName(),
          projectId: selectedProjectId(),
          eventType: params.eventType,
          description: params.description,
          eventList: batch
        });

        debug('fetchMapData - batch', b + 1, 'of', batches.length, 'eventList length:', batch.length);
        debug('fetchMapData - endpoint:', config.apiEndpoints.map);

        let url: URL;
        if (config.apiEndpoints.map.startsWith('/') || config.apiEndpoints.map.startsWith('./')) {
          url = new URL(config.apiEndpoints.map, window.location.origin);
        } else {
          url = new URL(config.apiEndpoints.map);
        }
        Object.keys(queryParams).forEach(key => {
          url.searchParams.append(key, String(queryParams[key]));
        });

        const result = await getData(url.pathname + url.search, params.signal);
        if (result.success && result.data && Array.isArray(result.data)) {
          allData.push(...result.data);
        } else if (!result.success) {
          logError('Failed to fetch map data (batch ' + (b + 1) + '):', result.message || 'Unknown error');
        }
      }

      debug('fetchMapData - total data length after chunks:', allData.length);
      return allData;
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return [];
    }
    logError('Error fetching map data:', error);
    return [];
  }
}

/**
 * Fetch time series data for maneuvers
 */
export async function fetchTimeSeriesData(
  context: ManeuversContext,
  params: ManeuversDataParams
): Promise<any[]> {
  try {
    // Use time-range endpoint only when caller explicitly provides timeRange and no event list.
    // When we have an event list (any size), always use event_list path so timeseries matches table filtering.
    // For >100 events we chunk and call event_list endpoint per batch.
    const eventListLength = params.eventList?.length || 0;
    const useTimeRange = !!params.timeRange && eventListLength === 0;
    
    debug('fetchTimeSeriesData - eventListLength:', eventListLength, 'useTimeRange:', useTimeRange, 'has timeRange param:', !!params.timeRange);
    
    if (useTimeRange) {
      // Use new history endpoint
      if (!params.timeRange || !params.timeRange.startDate || !params.timeRange.endDate) {
        logWarning('fetchTimeSeriesData: timeRange is required for range-based query. Skipping API call.');
        return [];
      }

      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        logWarning('fetchTimeSeriesData: className and projectId are required');
        return [];
      }

      // Description is required for timeseries endpoint
      if (!params.description || params.description.trim() === '') {
        logWarning('fetchTimeSeriesData: description is required for history timeseries queries');
        return [];
      }

      // Source names are required for history timeseries endpoint
      // Auto-populate if missing for fleet/historical contexts
      if (!params.sourceNames || params.sourceNames.length === 0) {
        if (context === 'fleet') {
          // Try to get sources from sourcesStore
          if (sourcesStore.isReady()) {
            const allSources = sourcesStore.sources();
            if (allSources && allSources.length > 0) {
              params.sourceNames = allSources.map((s: any) => s.source_name).filter((name: string) => name);
              log(`[maneuversDataService] fetchTimeSeriesData - Auto-populated sourceNames for fleet context: ${JSON.stringify(params.sourceNames)}`);
            }
          }
        } else if (context === 'historical') {
          // Try to get source from selectedSourceId
          const { selectedSourceId } = persistantStore;
          const sourceId = selectedSourceId();
          if (sourceId && sourceId > 0) {
            const sources = sourcesStore.sources();
            const source = sources.find((s: any) => s.source_id === sourceId);
            if (source && source.source_name) {
              params.sourceNames = [source.source_name];
              log(`[maneuversDataService] fetchTimeSeriesData - Auto-populated sourceNames for historical context: ${JSON.stringify(params.sourceNames)}`);
            }
          }
        }
        
        // Final check - still missing?
        if (!params.sourceNames || params.sourceNames.length === 0) {
          logWarning('fetchTimeSeriesData: sourceNames is required for history timeseries queries');
          return [];
        }
      }

      const endpoint = `${apiEndpoints.app.data}/maneuvers-history-timeseries`;
      let url = new URL(endpoint, window.location.origin);
      
      url.searchParams.append('class_name', className);
      url.searchParams.append('project_id', String(projectId));
      url.searchParams.append('desc', params.description);
      url.searchParams.append('source_names', JSON.stringify(params.sourceNames));
      url.searchParams.append('start_date', params.timeRange.startDate);
      url.searchParams.append('end_date', params.timeRange.endDate);
      url.searchParams.append('event_type', params.eventType.toLowerCase());
      
      if (params.count) {
        url.searchParams.append('count', String(params.count));
      }
      
      if (params.filters && Object.keys(params.filters).length > 0) {
        url.searchParams.append('filters', JSON.stringify(params.filters));
      }

      debug('fetchTimeSeriesData - using history endpoint:', url.pathname + url.search);
      const result = await getData(url.pathname + url.search, params.signal);

      if (result.success && result.data && Array.isArray(result.data)) {
        // Return object with data and charts if charts are available
        if (result.charts && Array.isArray(result.charts)) {
          return { data: result.data, charts: result.charts };
        }
        return result.data;
      } else {
        logError('Failed to fetch time series data by range:', result.message || 'Unknown error');
        return [];
      }
    } else {
      // Use event_list endpoint (same criteria as table so selection matches timeseries)
      if (!params.eventList || !Array.isArray(params.eventList) || params.eventList.length === 0) {
        logWarning('fetchTimeSeriesData: eventList is required and must be non-empty. Skipping API call.');
        return [];
      }

      const config = getManeuversConfig(context);
      const BATCH_SIZE = 100;
      const batches: number[][] = [];
      for (let i = 0; i < params.eventList.length; i += BATCH_SIZE) {
        batches.push(params.eventList.slice(i, i + BATCH_SIZE));
      }

      const allData: any[] = [];
      let charts: string[] | undefined;
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const queryParams = config.buildQueryParams({
          className: selectedClassName(),
          projectId: selectedProjectId(),
          eventType: params.eventType,
          description: params.description,
          eventList: batch
        });

        debug('fetchTimeSeriesData - batch', b + 1, 'of', batches.length, 'eventList length:', batch.length);

        let url: URL;
        if (config.apiEndpoints.timeSeries.startsWith('/') || config.apiEndpoints.timeSeries.startsWith('./')) {
          url = new URL(config.apiEndpoints.timeSeries, window.location.origin);
        } else {
          url = new URL(config.apiEndpoints.timeSeries);
        }
        Object.keys(queryParams).forEach(key => {
          url.searchParams.append(key, String(queryParams[key]));
        });

        const result = await getData(url.pathname + url.search, params.signal);
        if (result.success && result.data && Array.isArray(result.data)) {
          allData.push(...result.data);
          if (result.charts && Array.isArray(result.charts) && !charts) {
            charts = result.charts;
          }
        } else if (!result.success) {
          logError('Failed to fetch time series data (batch ' + (b + 1) + '):', result.message || 'Unknown error');
        }
      }

      debug('fetchTimeSeriesData - total data length after chunks:', allData.length);
      if (allData.length > 0) {
        if (charts && charts.length > 0) {
          return { data: allData, charts };
        }
        return allData;
      }
      return [];
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return [];
    }
    logError('Error fetching time series data:', error);
    return [];
  }
}

