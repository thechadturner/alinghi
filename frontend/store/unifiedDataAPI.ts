// Unified Data API Service
// Handles API calls and integrates with the new channel-based IndexedDB system

// OLD INDEXEDDB CODE - COMMENTED OUT - USING HUNIDB NOW
import { huniDBStore } from './huniDBStore';
import { sourcesStore } from './sourcesStore';
import { extractAndNormalizeMetadata } from '../utils/dataNormalization';
import { debug, info, warn, error as logError } from '../utils/console';

// Define the parameter interfaces
export interface ChannelValuesParams {
  projectId: number;
  className: string;
  datasetId: number;
  sourceName: string;
  sourceId?: number; // Add sourceId to ensure correct source_id is used
  channels: string[];
  date?: string;
  timezone?: string | null; // Timezone for UTC to local conversion
  use_v2?: boolean; // Obsolete - kept for backward compatibility, now ignored (DuckDB is the only implementation)
  data_source?: 'auto' | 'file' | 'influx'; // Data source to use: 'auto' (default), 'file', or 'influx'
  resolution?: string; // Optional resolution for channel-values API (e.g. '1s')
}

export interface MapDataParams {
  projectId: number;
  className: string;
  datasetId: number;
  sourceName: string;
  sourceId?: number; // Add sourceId to ensure correct source_id is used
  date?: string;
  description?: string; // Description for mapdata ('dataset' or 'day'), defaults to 'dataset'
}

export interface AggregateDataParams {
  projectId: string;
  className: string;
  datasetId: string;
  sourceName: string;
  date?: string;
}

export interface ObjectDataParams {
  projectId: string;
  className: string;
  datasetId: string;
  sourceName: string;
  objectName: string;
  date?: string;
}

export interface DataPoint {
  timestamp: number;
  Datetime: string;
  [key: string]: any;
}

// Import real API functions
import { getData, postBinary, formatDateTime } from '../utils/global';
import { apiEndpoints } from '@config/env';
import UnifiedFilterService from '../services/unifiedFilterService';

// API Endpoints (reserved for future use)
const _API_ENDPOINTS = {
  channelValues: '/api/channel-values',
  mapData: '/api/map-data',
  aggregateData: '/api/aggregate-data',
  objectData: '/api/object-data'
};

/** Fallback when class object (filters_dataset) is missing; primary source is UnifiedFilterService.getRequiredFilterChannels(className, 'dataset'). */
const TIMESERIES_METADATA_CHANNELS_FALLBACK = ['Grade', 'State', 'Twa_deg', 'Race_number', 'Leg_number'];

/** Parquet column names differ from internal filter channel names; use these when sending channel_list to the file API. */
const INTERNAL_TO_PARQUET_CHANNEL_NAMES: Record<string, string> = { State: 'Foiling_state' };
/** When building keyMapping from API response, map these parquet keys to internal names so we keep calling it State inside. */
const PARQUET_TO_INTERNAL_CHANNEL_NAMES: Record<string, string> = { Foiling_state: 'State' };

// Convert API data to DataPoint format
// timezone: Optional timezone string for converting ts to Datetime (e.g., 'Europe/Madrid', 'UTC')
// requestedChannels: Channels that were requested (to know if Datetime should be created from ts)
// CRITICAL: requestedChannels should be in original case (normalized from API response)
const convertToDataPoints = (data: any[], timezone?: string | null, requestedChannels?: string[]): DataPoint[] => {
  if (!Array.isArray(data)) return [];
  
  // Check if Datetime was requested (case-insensitive)
  const wasDatetimeRequested = requestedChannels?.some(ch => 
    ch.toLowerCase() === 'datetime'
  ) || false;
  
  // Build mapping from API response keys (original case) to requested channels (also original case after normalization)
  // This ensures we preserve the original case from the API response and map parquet names (e.g. Foiling_state) to internal names (State)
  const keyMapping = new Map<string, string>();
  if (data.length > 0 && requestedChannels && requestedChannels.length > 0) {
    const dataKeys = Object.keys(data[0]);
    const requestedLower = new Set(requestedChannels.map(r => r.toLowerCase()));
    requestedChannels.forEach(reqCh => {
      // Find matching key in data (case-insensitive)
      const matchingKey = dataKeys.find(dk => dk.toLowerCase() === reqCh.toLowerCase());
      if (matchingKey && matchingKey !== reqCh) {
        keyMapping.set(matchingKey, reqCh);
      }
    });
    // Map parquet column names to internal names (e.g. Foiling_state -> State) when that internal name was requested
    dataKeys.forEach(dk => {
      const internalName = PARQUET_TO_INTERNAL_CHANNEL_NAMES[dk];
      if (internalName && requestedLower.has(internalName.toLowerCase())) {
        keyMapping.set(dk, internalName);
      }
    });
  }
  
  return data.map((item, index) => {
    // CRITICAL: Do NOT filter out null values - they indicate the channel exists but has no data
    // Filtering them out causes channels to disappear from availableChannels check
    // Only filter out undefined values (which indicate the channel doesn't exist in the response)
    const cleanItem = Object.fromEntries(
      Object.entries(item).filter(([_key, value]) => 
        value !== undefined  // Keep null values - they indicate channel exists but is empty
      )
    );
    
    // Extract and convert timestamp properly
    // Priority: ts (from server, in seconds) > timestamp > Datetime > datetime
    // Note: 'ts' is converted to 'timestamp' (milliseconds) and then removed from result
    let timestamp: number;
    if (cleanItem.ts !== undefined && cleanItem.ts !== null) {
      // ts is in seconds (from DuckDB), convert to milliseconds
      const tsValue = typeof cleanItem.ts === 'number' ? cleanItem.ts : Number(cleanItem.ts);
      timestamp = isNaN(tsValue) ? Date.now() + index : Math.round(tsValue * 1000);
    } else if (cleanItem.timestamp !== undefined && cleanItem.timestamp !== null) {
      // If timestamp is already a number, use it
      if (typeof cleanItem.timestamp === 'number') {
        timestamp = cleanItem.timestamp;
      } else {
        // Try to parse as number or date
        const parsed = typeof cleanItem.timestamp === 'string' 
          ? new Date(cleanItem.timestamp).getTime()
          : Number(cleanItem.timestamp);
        timestamp = isNaN(parsed) ? Date.now() + index : parsed;
      }
    } else if (cleanItem.Datetime !== undefined && cleanItem.Datetime !== null) {
      // If we have Datetime but no timestamp, convert Datetime to timestamp
      const dt = new Date(cleanItem.Datetime as string | number | Date);
      timestamp = isNaN(dt.getTime()) ? Date.now() + index : dt.getTime();
    } else if (cleanItem.datetime !== undefined && cleanItem.datetime !== null) {
      // Try lowercase datetime as fallback
      const dt = new Date(cleanItem.datetime as string | number | Date);
      timestamp = isNaN(dt.getTime()) ? Date.now() + index : dt.getTime();
    } else {
      // Fallback to current time with index offset
      timestamp = Date.now() + index;
    }
    
    // Ensure Datetime is present (convert from timestamp if needed)
    // CRITICAL: If Datetime was requested, always create it from ts/timestamp using timezone
    // This ensures proper timezone conversion even if server returns Datetime in UTC
    let Datetime: string;
    if (wasDatetimeRequested && timestamp && timezone) {
      // Datetime was requested - create it from timestamp using timezone conversion
      const formatted = formatDateTime(timestamp, timezone);
      Datetime = formatted || new Date(timestamp).toISOString();
    } else if (cleanItem.Datetime !== undefined && cleanItem.Datetime !== null) {
      // Use server-provided Datetime if available and Datetime wasn't explicitly requested
      Datetime = String(cleanItem.Datetime);
    } else if (cleanItem.datetime !== undefined && cleanItem.datetime !== null) {
      // Try lowercase datetime as fallback
      Datetime = String(cleanItem.datetime);
    } else {
      // Fallback: Create ISO string from timestamp (UTC)
      Datetime = new Date(timestamp).toISOString();
    }
    
    // Build result object, preserving original case from API response
    // Map keys if needed to match normalized requested channels
    const result: any = {
      timestamp,
      Datetime
    };
    
    Object.keys(cleanItem).forEach(key => {
      // Use mapped key if available (normalized original case), otherwise use key as-is (original case from API)
      const mappedKey = keyMapping.get(key) || key;
      result[mappedKey] = cleanItem[key];
    });
    
    // CRITICAL: Populate source_name from sourcesStore if source_id is available but source_name is missing
    if ((!result.source_name || result.source_name === undefined || result.source_name === 'undefined' || result.source_name === null) && result.source_id) {
      try {
        // Handle both string and number source_id values
        let sourceId: number;
        if (typeof result.source_id === 'string') {
          sourceId = Number(result.source_id);
        } else {
          sourceId = result.source_id;
        }
        
        // Only proceed if sourceId is valid and sourcesStore is ready
        if (sourceId && !isNaN(sourceId) && sourceId !== 0 && sourcesStore.isReady()) {
          const resolvedSourceName = sourcesStore.getSourceName(sourceId);
          if (resolvedSourceName) {
            result.source_name = resolvedSourceName;
          }
        }
      } catch (e) {
        // Silently fail - source_name might not be critical for all use cases
        debug(`[convertToDataPoints] Could not populate source_name from source_id ${result.source_id}:`, e);
      }
    }
    
    // CRITICAL: Remove 'ts' field (seconds) - only keep 'timestamp' (milliseconds)
    // 'ts' was used for conversion but should not be included in the result
    if ('ts' in result) {
      delete result.ts;
    }
    
    return result;
  });
};

// Fetch and store timeseries data
export const fetchAndStoreTimeSeriesData = async (params: ChannelValuesParams): Promise<DataPoint[]> => {
  try {
    // Validate sourceName is provided
    if (!params.sourceName) {
      warn('[UnifiedDataAPI] sourceName is required for timeseries API call', {
        projectId: params.projectId,
        className: params.className,
        datasetId: params.datasetId,
        date: params.date,
        channelCount: params.channels.length
      });
      return [];
    }
    
    // Use the main channel-values endpoint with automatic fallback
    // This will check file system first, then fallback to InfluxDB for missing channels
    const url = apiEndpoints.file.channelValues;
    
    debug(`[UnifiedDataAPI] Using channel-values endpoint with automatic fallback:`, url);
    
    // Date is dataset local date (YYYYMMDD). Folder paths use this; server converts to UTC only for Influx queries.
    let dateStr = params.date || new Date().toISOString().split('T')[0].replace(/-/g, '');
    if (dateStr.includes('-')) {
      dateStr = dateStr.replace(/-/g, '');
    }
    
      // CRITICAL: DuckDB queries MUST include 'ts' in the channel list
      // CRITICAL: 'Datetime' should NOT be requested from server - it's derived from 'ts' using timezone
      // Filter out 'Datetime' from channels sent to server, but ensure 'ts' is included
      const channelsForServer = params.channels.filter(ch => 
        ch.toLowerCase() !== 'datetime'
      );
      
      // Track if Datetime was requested (for post-processing)
      const wasDatetimeRequested = params.channels.some(ch => 
        ch.toLowerCase() === 'datetime'
      );
      
      if (wasDatetimeRequested) {
        debug(`[UnifiedDataAPI] 'Datetime' was requested - will be created from 'ts' using timezone ${params.timezone || 'UTC'}`);
      }
      
      // Timeseries: use requested channels as-is (no HuniDB; API + in-memory only).
      const normalizedChannelsForRequest = [...channelsForServer];
      
      // Build channel list for server (exclude Datetime, use normalized original case)
      const channelList = normalizedChannelsForRequest.map(channel => {
        const channelLower = channel.toLowerCase();
        // Check type using lowercase comparison for case-insensitive matching, but use original case in name
        const isIntType = channelLower === 'race_number' || channelLower === 'leg_number' || channelLower === 'grade';
        return { 
          name: channel, // Use normalized original case channel name
          type: isIntType ? 'int' : 'float' 
        };
      });

      // Include filter/metadata channels from class object (filters_dataset) so API returns them
      let metadataChannels: string[];
      try {
        metadataChannels = await UnifiedFilterService.getRequiredFilterChannels(params.className, 'dataset');
        if (!metadataChannels?.length) metadataChannels = [...TIMESERIES_METADATA_CHANNELS_FALLBACK];
      } catch {
        metadataChannels = [...TIMESERIES_METADATA_CHANNELS_FALLBACK];
      }
      const channelNamesLower = new Set(channelList.map(ch => ch.name.toLowerCase()));
      for (const name of metadataChannels) {
        if (!channelNamesLower.has(name.toLowerCase())) {
          const isIntType = name.toLowerCase() === 'race_number' || name.toLowerCase() === 'leg_number' || name.toLowerCase() === 'grade';
          channelList.push({ name, type: isIntType ? 'int' : 'float' });
          channelNamesLower.add(name.toLowerCase());
        }
      }
      
      // Add 'ts' if not already present (required for DuckDB queries and for Datetime conversion)
      const hasTs = channelList.some(ch => ch.name === 'ts' || ch.name.toLowerCase() === 'ts');
      if (!hasTs) {
        channelList.unshift({ name: 'ts', type: 'float' });
        debug(`[UnifiedDataAPI] Added missing 'ts' channel to channel_list for DuckDB query`);
      }
      
      // Parquet uses Foiling_state, not State; map internal channel names to parquet column names for the API request
      const channelListForRequest = channelList.map(ch => ({
        ...ch,
        name: INTERNAL_TO_PARQUET_CHANNEL_NAMES[ch.name] ?? ch.name
      }));
      // Deduplicate by name (e.g. State and Foiling_state both map to Foiling_state)
      const seen = new Set<string>();
      const channelListDeduped = channelListForRequest.filter(ch => {
        const key = ch.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      
      // Send 'auto' when unspecified or 'auto' so the server runs unified path (split in-file vs not, backfill from Influx, serve all from DuckDB).
      // Send 'file' or 'influx' only when explicitly requested (e.g. parallel file+influx fetch).
      const serverDataSource = params.data_source || 'auto';

      // When querying Influx (influx-only or unified backfill), use dataset/day time bounds to limit the query window.
      // Request time range in UTC so we get unambiguous ISO strings (…Z) and correct start_ts/end_ts for Influx.
      let startTs: number | null = null;
      let endTs: number | null = null;
      if ((serverDataSource === 'influx' || serverDataSource === 'auto') && params.datasetId) {
        try {
          const timeRangeUrl = `${apiEndpoints.app.events}/dataset-time-range?class_name=${encodeURIComponent(params.className)}&project_id=${encodeURIComponent(params.projectId)}&dataset_ids=${encodeURIComponent(JSON.stringify([params.datasetId]))}&timezone=UTC`;
          const timeRangeResponse = await getData(timeRangeUrl);
          const rangeData = timeRangeResponse?.data ?? timeRangeResponse;
          if (rangeData?.start_time != null && rangeData?.end_time != null) {
            startTs = Math.floor(new Date(rangeData.start_time).getTime() / 1000);
            endTs = Math.floor(new Date(rangeData.end_time).getTime() / 1000);
            debug('[UnifiedDataAPI] Using dataset event time range for Influx query', { start_ts: startTs, end_ts: endTs, start_time: rangeData.start_time, end_time: rangeData.end_time });
          }
        } catch (err) {
          debug('[UnifiedDataAPI] Could not fetch dataset time range, using full day for Influx', err);
        }
      }

      const payload = {
      project_id: params.projectId,
      class_name: params.className,
      date: dateStr,
      source_name: params.sourceName,
      channel_list: channelListDeduped,
      start_ts: startTs,
      end_ts: endTs,
      timezone: params.timezone || 'UTC', // Default to UTC if not provided (API requires string, not null)
      resolution: params.resolution || '1s', // Default resolution
      data_source: serverDataSource // 'auto' = server unified (split, backfill Influx, serve from file); 'file' or 'influx' = explicit
    };

    // CRITICAL: Validate required parameters before making API call
    if (!params.sourceName) {
      warn('[UnifiedDataAPI] ⚠️ sourceName is missing in params - API call will likely fail!', {
        projectId: params.projectId,
        className: params.className,
        datasetId: params.datasetId,
        date: dateStr,
        sourceId: params.sourceId,
        channelCount: params.channels.length
      });
    }
    
    info(`[UnifiedDataAPI] Making API call for channels (preserving original case):`, {
      channels: params.channels.slice(0, 20),
      totalChannels: params.channels.length,
      sampleChannels: params.channels.slice(0, 5)
    });
    info(`[UnifiedDataAPI] API payload:`, {
      project_id: payload.project_id,
      class_name: payload.class_name,
      date: payload.date,
      source_name: payload.source_name,
      data_source: payload.data_source,
      resolution: payload.resolution,
      timezone: payload.timezone,
      channel_count: payload.channel_list.length,
      channel_names: payload.channel_list.map((ch: any) => ch.name).slice(0, 10)
    });
    debug(`[UnifiedDataAPI] Full channel list details:`, payload.channel_list);
    
    const response = await postBinary(url, payload);
    
    // Enhanced logging for API response
    info(`[UnifiedDataAPI] API response received:`, {
      success: response?.success,
      status: response?.status,
      hasData: !!(response?.data),
      dataLength: response?.data?.length || 0,
      dataType: response?.data ? (Array.isArray(response.data) ? 'array' : typeof response.data) : 'null',
      message: response?.message || 'no message'
    });
    
    // Additional debug logging for empty responses
    if (!response || !response.data || response.data.length === 0) {
      warn(`[UnifiedDataAPI] ⚠️ API returned empty response`, {
        success: response?.success,
        status: response?.status,
        message: response?.message,
        requestPayload: {
          project_id: payload.project_id,
          class_name: payload.class_name,
          date: payload.date,
          source_name: payload.source_name,
          data_source: payload.data_source,
          channel_count: payload.channel_list.length,
          channel_names: payload.channel_list.map((ch: any) => ch.name)
        }
      });
    }
    
    // Additional debugging for empty responses - use warn level for visibility
    // Empty responses are often expected (e.g., when channels don't exist in the dataset)
    if (!response || !response.data || response.data.length === 0) {
      warn('[UnifiedDataAPI] ⚠️ API returned success but no data. This could mean:');
      warn('[UnifiedDataAPI] 1. The requested channels don\'t exist in the dataset');
      warn('[UnifiedDataAPI] 2. The API request format is incorrect');
      warn('[UnifiedDataAPI] 3. The channels exist but with different names');
      warn('[UnifiedDataAPI] 4. The source_name is incorrect or the source doesn\'t exist');
      warn('[UnifiedDataAPI] 5. The date format is incorrect or the date doesn\'t exist');
      warn('[UnifiedDataAPI] 📋 Requested channels:', params.channels);
      warn('[UnifiedDataAPI] 📤 API payload:', {
        project_id: payload.project_id,
        class_name: payload.class_name,
        date: payload.date,
        source_name: payload.source_name,
        data_source: payload.data_source,
        channel_list: payload.channel_list,
        channel_count: payload.channel_list.length,
        channel_names: payload.channel_list.map((ch: any) => ch.name)
      });
      warn('[UnifiedDataAPI] 📥 Response:', {
        success: response?.success,
        status: response?.status,
        message: response?.message,
        hasData: !!(response?.data),
        dataLength: response?.data?.length || 0,
        error: response?.error
      });
    }
    
    if (response && response.success && response.data) {
      // Log what channels are actually in the response before conversion
      if (response.data.length > 0) {
        const responseChannels = Object.keys(response.data[0]);
        
        // CRITICAL: Log raw API response to check channel name case
        const sampleDataPoint = response.data[0];
        const channelCaseComparison: Record<string, { requested?: string; apiResponse: string }> = {};
        params.channels.slice(0, 20).forEach(reqCh => {
          const matchingKey = responseChannels.find(rc => rc.toLowerCase() === reqCh.toLowerCase());
          if (matchingKey) {
            channelCaseComparison[reqCh.toLowerCase()] = {
              requested: reqCh,
              apiResponse: matchingKey
            };
          }
        });
        
        debug(`[UnifiedDataAPI] 🔍 API RESPONSE CHANNEL CASE CHECK:`, {
          requestedChannels: params.channels.slice(0, 20),
          apiResponseChannels: responseChannels.slice(0, 20),
          channelCaseComparison: Object.entries(channelCaseComparison).slice(0, 20).map(([lower, cases]) => ({
            channel: lower,
            requested: cases.requested,
            apiResponse: cases.apiResponse,
            caseMatch: cases.requested === cases.apiResponse
          })),
          sampleDataPointKeys: Object.keys(sampleDataPoint).slice(0, 20),
          sampleDataPoint: Object.fromEntries(
            Object.entries(sampleDataPoint).slice(0, 10).map(([key, value]) => [key, typeof value === 'number' ? value : String(value).substring(0, 50)])
          ),
          note: 'Check if API response channel names match requested case. If not, API needs to be fixed.'
        });
        
        info(`[UnifiedDataAPI] Response contains ${responseChannels.length} channels:`, responseChannels);
        info(`[UnifiedDataAPI] Requested channels (original case):`, params.channels.slice(0, 10));
        const _requestedChannelNames = new Set(params.channels.map(ch => ch.toLowerCase()));
        // Metadata channels that are expected to come from metadata/tags, not as separate channels
        // Datetime is always derived from timestamp, so it's never in the API response as a separate channel
        const metadataChannels = new Set(['race_number', 'leg_number', 'grade', 'config', 'state', 'datetime', 'timestamp']);
        const missingInResponse = params.channels.filter(ch => 
          !responseChannels.some(rc => rc.toLowerCase() === ch.toLowerCase())
        );
        // Filter out metadata channels from missing warnings - they're extracted from metadata
        const missingNonMetadata = missingInResponse.filter(ch => 
          !metadataChannels.has(ch.toLowerCase())
        );
        if (missingNonMetadata.length > 0) {
          debug(`[UnifiedDataAPI] ⚠️ ${missingNonMetadata.length} requested channels missing from API response:`, {
            missingChannels: missingNonMetadata,
            requestedChannels: params.channels.slice(0, 10),
            responseChannels: responseChannels.slice(0, 10),
            note: 'Channels are compared case-insensitively. If channels exist with different case, they should match.'
          });
        }
        // Log metadata channels separately (they're expected to come from metadata)
        const missingMetadata = missingInResponse.filter(ch => 
          metadataChannels.has(ch.toLowerCase())
        );
        if (missingMetadata.length > 0) {
          debug(`[UnifiedDataAPI] ${missingMetadata.length} metadata channels requested (will be extracted from metadata if available):`, missingMetadata);
        }
      }
      
      // CRITICAL: Normalize requested channels to match API response case (original case from parquet files)
      // The API returns channel names in original case (e.g., Twa_deg, Tws_avg_kph, Bsp_kph)
      // We should use those original case names for storage and future requests
      let normalizedChannels = [...params.channels];
      if (response.data && response.data.length > 0) {
        const responseChannels = Object.keys(response.data[0]);
        // Build mapping from lowercase to original case from API response
        const responseCaseMap = new Map<string, string>();
        responseChannels.forEach(respCh => {
          responseCaseMap.set(respCh.toLowerCase(), respCh);
        });
        
        // Normalize requested channels to use original case from API response
        normalizedChannels = params.channels.map(reqCh => {
          const originalCase = responseCaseMap.get(reqCh.toLowerCase());
          return originalCase || reqCh; // Use original case if found, otherwise keep requested
        });
        
        // Log normalization if any channels were changed
        const caseChanges = params.channels.filter((reqCh, _idx) => reqCh !== normalizedChannels[_idx]);
        if (caseChanges.length > 0) {
          info(`[UnifiedDataAPI] 🔄 Normalized ${caseChanges.length} channel names to original case from API:`, 
            caseChanges.map((reqCh, _i) => {
              const origIdx = params.channels.indexOf(reqCh);
              return `${reqCh} -> ${normalizedChannels[origIdx]}`;
            }).slice(0, 10)
          );
        }
      }
      
      // Convert data points, passing timezone and normalized channels (original case) for Datetime conversion
      const dataPoints = convertToDataPoints(response.data, params.timezone, normalizedChannels);

      // CRITICAL: Normalize metadata on each point so HuniDB tags get consistent keys (Grade, Race_number, Leg_number, State)
      // Same pattern as mapdata - ensures client-side filtering works from cache regardless of API casing
      for (const point of dataPoints) {
        const meta = extractAndNormalizeMetadata(point);
        if (meta.Grade !== undefined && meta.Grade !== null) point.Grade = meta.Grade;
        if (meta.Race_number !== undefined && meta.Race_number !== null) point.Race_number = meta.Race_number;
        if (meta.Leg_number !== undefined && meta.Leg_number !== null) point.Leg_number = meta.Leg_number;
        if (meta.State !== undefined && meta.State !== null) point.State = meta.State;
      }

      // Log what channels are in the converted data
      if (dataPoints.length > 0) {
        const convertedChannels = Object.keys(dataPoints[0]);
        const hasGrade = convertedChannels.some(ch => ch.toLowerCase() === 'grade');
        const sampleDataPoint = dataPoints[0];
        const gradeValue = sampleDataPoint.Grade ?? sampleDataPoint.GRADE ?? sampleDataPoint.grade;
        info(`[UnifiedDataAPI] Converted data contains ${convertedChannels.length} channels:`, {
          channels: convertedChannels,
          hasGradeField: hasGrade,
          gradeValue: gradeValue,
          requestedChannels: normalizedChannels.slice(0, 10),
          note: hasGrade ? 'Grade found in data' : 'Grade NOT found in data - may be missing from API response'
        });
      }
      // Reduced verbosity: only log conversion for large datasets
      if (dataPoints.length > 10000) {
        debug(`[UnifiedDataAPI] Converted to ${dataPoints.length} data points`);
      }
      
      // Store in HuniDB as timeseries data (will go to ts.* tables)
      // CRITICAL: sourceId should ALWAYS be resolvable - API requires source, and we have sourcesStore
      // Resolution order: 1) params.sourceId, 2) sourcesStore.getSourceId(sourceName), 3) extract from data, 4) error
      let sourceId: number = 0;
      if (params.sourceId && params.sourceId !== 0) {
        sourceId = Number(params.sourceId);
        debug(`[UnifiedDataAPI] Using sourceId from params: ${sourceId}`);
      } else if (params.sourceName) {
        // CRITICAL: Use sourcesStore to resolve sourceId from sourceName
        // This should ALWAYS work if sourcesStore is properly populated
        // First, ensure sourcesStore is ready (wait if needed)
        if (!sourcesStore.isReady()) {
          warn(`[UnifiedDataAPI] ⚠️ sourcesStore is not ready yet - waiting for initialization...`);
          // Wait for sourcesStore to be ready (with timeout)
          let attempts = 0;
          const maxAttempts = 50; // 5 seconds max wait
          while (!sourcesStore.isReady() && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
          }
          if (!sourcesStore.isReady()) {
            warn(`[UnifiedDataAPI] ⚠️ sourcesStore still not ready after ${maxAttempts * 100}ms - will try anyway`);
          }
        }
        
        const resolvedSourceId = sourcesStore.getSourceId(params.sourceName);
        if (resolvedSourceId && resolvedSourceId !== 0) {
          sourceId = Number(resolvedSourceId);
          info(`[UnifiedDataAPI] ✅ Resolved sourceId from sourceName "${params.sourceName}": ${sourceId}`);
        } else {
          // sourcesStore doesn't have this source - this is a bug we need to fix!
          // Try to trigger refresh if sourcesStore is ready but missing this source
          if (sourcesStore.isReady()) {
            warn(`[UnifiedDataAPI] ⚠️ CRITICAL: sourcesStore is ready but does not have sourceName "${params.sourceName}"! Attempting to refresh sourcesStore...`);
            try {
              await sourcesStore.refresh();
              // Try again after refresh
              const retrySourceId = sourcesStore.getSourceId(params.sourceName);
              if (retrySourceId && retrySourceId !== 0) {
                sourceId = Number(retrySourceId);
                info(`[UnifiedDataAPI] ✅ Resolved sourceId from sourceName "${params.sourceName}" after refresh: ${sourceId}`);
              } else {
                warn(`[UnifiedDataAPI] ⚠️ sourcesStore still does not have sourceName "${params.sourceName}" after refresh. This indicates the source does not exist in the project. Attempting to extract from data...`);
                // Fall through to data extraction
              }
            } catch (refreshError) {
              warn(`[UnifiedDataAPI] ⚠️ Failed to refresh sourcesStore:`, refreshError);
              // Fall through to data extraction
            }
          }
          
          // If we still don't have sourceId, try to extract from data as fallback
          if (!sourceId) {
            const firstPoint = dataPoints[0];
            const extractedSourceId = firstPoint?.source_id || firstPoint?.sourceId;
            if (extractedSourceId && Number(extractedSourceId) !== 0) {
              sourceId = Number(extractedSourceId);
              warn(`[UnifiedDataAPI] ⚠️ Extracted sourceId ${sourceId} from data, but sourcesStore should have been populated with sourceName "${params.sourceName}". This may indicate sourcesStore is missing this source.`);
            } else {
              // This should never happen - API requires source, so we should always have sourceId
              logError(`[UnifiedDataAPI] ❌ CRITICAL ERROR: Cannot determine sourceId!`, {
                sourceName: params.sourceName,
                providedSourceId: params.sourceId,
                dataHasSourceId: firstPoint?.source_id || firstPoint?.sourceId,
                sourcesStoreReady: sourcesStore.isReady(),
                sourcesStoreHasSource: sourcesStore.getSourceId(params.sourceName),
                note: 'API requires source, so sourceId should always be available. This indicates a bug in sourcesStore population or API response.'
              });
              // Still attempt storage with 0 - storage layer may extract per-point
              sourceId = 0;
            }
          }
        }
      } else {
        // No sourceName provided - try to extract from data
        const firstPoint = dataPoints[0];
        const extractedSourceId = firstPoint?.source_id || firstPoint?.sourceId;
        if (extractedSourceId && Number(extractedSourceId) !== 0) {
          sourceId = Number(extractedSourceId);
          warn(`[UnifiedDataAPI] ⚠️ No sourceName provided, extracted sourceId ${sourceId} from data. sourceName should have been provided in params.`);
        } else {
          // This should never happen - API requires source
          logError(`[UnifiedDataAPI] ❌ CRITICAL ERROR: Cannot determine sourceId and no sourceName provided!`, {
            providedSourceId: params.sourceId,
            dataHasSourceId: firstPoint?.source_id || firstPoint?.sourceId,
            note: 'API requires source, so either sourceName or sourceId should be provided, or data should contain source_id.'
          });
          // Still attempt storage with 0 - storage layer may extract per-point
          sourceId = 0;
        }
      }
      
      // Timeseries no longer cached in HuniDB - data returned for immediate use only
      if (dataPoints.length > 0) {
        // Log success (channel list available from response if needed for diagnostics)
        const systemKeys = new Set(['ts', 'datetime', 'timestamp', 'source_id', 'source_name', 'sourcename', 'event_id']);
        const firstPoint = dataPoints[0];
        const channelsFromResponse = Object.keys(firstPoint).filter(key => {
          const keyLower = key.toLowerCase();
          return !systemKeys.has(keyLower);
        });
        info(`[UnifiedDataAPI] 📦 Received ${dataPoints.length} data points from API`, {
          className: params.className.toLowerCase(),
          datasetId: params.datasetId || 0,
          projectId: params.projectId || 0,
          sourceId: sourceId,
          channels: channelsFromResponse.length,
          channelsSample: channelsFromResponse.slice(0, 10)
        });
      } else {
        warn(`[UnifiedDataAPI] ⚠️ API returned success but no data points after conversion - nothing to store`, {
          responseDataLength: response?.data?.length || 0,
          dataPointsLength: dataPoints.length
        });
      }
      
      return dataPoints;
    } else if (response && response.status === 204) {
      warn('[UnifiedDataAPI] API returned 204 (No Content) - no data available for requested parameters');
      warn('[UnifiedDataAPI] Parameters used:', {
        project_id: payload.project_id,
        class_name: payload.class_name,
        date: payload.date,
        source_name: payload.source_name,
        channels: payload.channel_list
      });
    } else if (response && response.status === 404) {
      // Handle 404 errors more gracefully - they're often expected when data doesn't exist
      info('[UnifiedDataAPI] Data not found on server (404) - this may be expected for some datasets');
    } else {
      debug('[UnifiedDataAPI] No timeseries data received. Response:', response);
    }
    
    return [];
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errWithStatus = error as { status?: number };
    if (errWithStatus.status === 404 || err.message.includes('404')) {
      info('[UnifiedDataAPI] Data not found on server (404) - this may be expected for some datasets');
      return [];
    }
    logError('[UnifiedDataAPI] Error fetching timeseries data:', err);
    return [];
  }
};

// Epoch date YYYYMMDD – invalid for dataset/map requests; avoid calling API with it
const _EPOCH_DATE_YMD = '19700101';

// Fetch and store map data from events API
export const fetchAndStoreMapData = async (params: MapDataParams): Promise<DataPoint[]> => {
  try {
    const datasetIdStr = params.datasetId != null ? String(params.datasetId).trim() : '';
    if (!datasetIdStr || datasetIdStr === '0') {
      debug('[UnifiedDataAPI] Skipping map data fetch: no datasetId');
      return [];
    }

    // Use description from params, default to 'dataset' for backward compatibility
    const description = params.description || 'dataset';

    // Use the original events API endpoint for map data
    // Use relative URL - getData will handle nginx mode correctly
    const url = `/api/events/object`;
    const queryParams = new URLSearchParams({
      class_name: params.className,
      project_id: String(params.projectId),
      datasetId: String(params.datasetId), // Use camelCase as expected by the API
      table: 'events_mapdata',
      desc: description
    });
    
    const response = await getData(`${url}?${queryParams}`);
    
    // Log response for debugging
    debug(`[UnifiedDataAPI] Map data API response:`, {
      success: response?.success,
      hasData: !!response?.data,
      dataType: Array.isArray(response?.data) ? 'array' : typeof response?.data,
      dataLength: Array.isArray(response?.data) ? response.data.length : 'N/A',
      responseKeys: response ? Object.keys(response) : [],
      params: {
        className: params.className,
        projectId: params.projectId,
        datasetId: params.datasetId,
        sourceName: params.sourceName,
        sourceId: params.sourceId
      }
    });
    
    // Handle 204 No Content responses (expected when map data doesn't exist yet)
    if (response && response.success && response.data === null && response.message === 'No content') {
      debug('[UnifiedDataAPI] No map data found (204) - this is expected if map data hasn\'t been generated yet', {
        params: {
          className: params.className,
          projectId: params.projectId,
          datasetId: params.datasetId,
          sourceName: params.sourceName,
          sourceId: params.sourceId
        },
        url: `${url}?${queryParams}`
      });
      return [];
    }
    
    if (response && response.success && response.data) {
      // Parse response.data: API may return the events_mapdata json column as a string (JSON array)
      let rawData: any[];
      if (typeof response.data === 'string') {
        try {
          const parsed = JSON.parse(response.data);
          rawData = Array.isArray(parsed) ? parsed : (parsed != null ? [parsed] : []);
        } catch (parseErr) {
          debug('[UnifiedDataAPI] Map data API response.data is string but JSON.parse failed', parseErr);
          rawData = [];
        }
      } else {
        rawData = Array.isArray(response.data) ? response.data : (response.data ? [response.data] : []);
      }
      
      if (rawData.length === 0) {
        debug('[UnifiedDataAPI] API returned success but empty data array', {
          response: {
            success: response.success,
            dataType: typeof response.data,
            isArray: Array.isArray(response.data),
            message: response.message
          },
          params: {
            className: params.className,
            projectId: params.projectId,
            datasetId: params.datasetId,
            sourceName: params.sourceName,
            sourceId: params.sourceId
          },
          url: `${url}?${queryParams}`
        });
        return [];
      }
      
      const dataPoints = convertToDataPoints(rawData);
      
      // CRITICAL: Normalize metadata (Grade, Race_number, Leg_number) so they make it into HuniDB and unifiedDataStore
      // API/backend may use different key casing; ensure standard names are present on every point
      for (const point of dataPoints) {
        const meta = extractAndNormalizeMetadata(point);
        if (meta.Grade !== undefined && meta.Grade !== null) point.Grade = meta.Grade;
        if (meta.Race_number !== undefined && meta.Race_number !== null) point.Race_number = meta.Race_number;
        if (meta.Leg_number !== undefined && meta.Leg_number !== null) point.Leg_number = meta.Leg_number;
        if (meta.State !== undefined && meta.State !== null) point.State = meta.State;
      }
      
      info(`[UnifiedDataAPI] Fetched ${dataPoints.length} mapdata points from events API`);
      
      // Get sourceId from params if provided, otherwise try to get from sourceName
      let sourceId: number | undefined;
      if (params.sourceId && params.sourceId !== 0) {
        sourceId = Number(params.sourceId);
      } else if (params.sourceName) {
        // Try to get sourceId from sourceName using sourcesStore
        const resolvedSourceId = sourcesStore.getSourceId(params.sourceName);
        if (resolvedSourceId) {
          sourceId = Number(resolvedSourceId);
        }
      }
      
      // If we still don't have sourceId, try to extract from first data point
      if (!sourceId && dataPoints.length > 0) {
        const firstPoint = dataPoints[0];
        const extractedSourceId = firstPoint?.source_id || firstPoint?.sourceId;
        if (extractedSourceId && Number(extractedSourceId) !== 0) {
          sourceId = Number(extractedSourceId);
        }
      }
      
      // If we still don't have a valid sourceId, log error and skip storage
      if (!sourceId || sourceId === 0) {
        logError(`[UnifiedDataAPI] Cannot store mapdata - invalid sourceId. Data has source_id: ${dataPoints[0]?.source_id}, provided sourceId: ${params.sourceId}, sourceName: ${params.sourceName}`);
        warn(`[UnifiedDataAPI] Skipping storage due to invalid sourceId. Data will still be returned for immediate use.`);
        return dataPoints; // Return data but don't store it
      }
      
      // Add source_id and description to each data point if they're missing
      // This ensures the data has source_id and description even if the API response doesn't include them
      for (const point of dataPoints) {
        if (sourceId && !point.source_id && !point.sourceId) {
          point.source_id = sourceId;
        }
        // Set description field so it's stored correctly in hunidb
        if (!point.description && !point.Description) {
          point.description = description;
        }
      }
      
      // Mapdata no longer cached in HuniDB - return data for immediate use only
      return dataPoints;
    }
    
    // Only warn if it's an actual error, not an expected "not found" response
    // Note: 204 responses are already handled above, this is for other "not found" cases
    const isExpectedNotFound = response && 
      (response.message === 'No content' || 
       response.message === 'Event object not found');
    
    if (isExpectedNotFound) {
      debug('[UnifiedDataAPI] No map data found - this is expected if map data hasn\'t been generated yet', {
        response: {
          success: response.success,
          message: response.message || 'No message',
          status: response.status
        },
        params: {
          className: params.className,
          projectId: params.projectId,
          datasetId: params.datasetId,
          sourceName: params.sourceName,
          sourceId: params.sourceId
        },
        url: `${url}?${queryParams}`
      });
    } else {
      warn('[UnifiedDataAPI] No map data received (unexpected response)', {
        response: response ? {
          success: response.success,
          hasData: !!response.data,
          dataType: Array.isArray(response.data) ? 'array' : typeof response.data,
          dataLength: Array.isArray(response.data) ? response.data.length : 'N/A',
          message: response.message || 'No message',
          status: response.status
        } : 'null',
        params: {
          className: params.className,
          projectId: params.projectId,
          datasetId: params.datasetId,
          sourceName: params.sourceName,
          sourceId: params.sourceId
        },
        url: `${url}?${queryParams}`
      });
    }
    return [];
  } catch (error) {
    logError('[UnifiedDataAPI] Error fetching map data:', error);
    return [];
  }
};

// Get data by channels - simplified version that works with the new system
export const getDataByChannels = async (
  channels: string[],
  options: {
    projectId: number;
    className: string;
    datasetId: number;
    sourceName?: string; // Make optional since we can get it from sourceId
    sourceId?: number; // Add sourceId parameter
    date?: string;
    timezone?: string | null; // Timezone for UTC to local conversion
    use_v2?: boolean; // Obsolete - kept for backward compatibility, now ignored (DuckDB is the only implementation)
    dataTypes?: string[];
    data_source?: 'auto' | 'file' | 'influx'; // Data source to use: 'auto' (default), 'file', or 'influx'
  }
): Promise<{
  data: DataPoint[];
  availableChannels: string[];
  missingChannels: string[];
  hasAll: boolean;
}> => {
  try {
    let dataPoints: DataPoint[] = [];
    
    // Get sourceName if not provided - try to get from sourcesStore using sourceId if available
    let sourceName = options.sourceName;
    if (!sourceName && options.datasetId) {
      // For dataset-based queries, we might not have sourceName
      // The API might work without it, or we can try to get it from the dataset
      debug('[UnifiedDataAPI] sourceName not provided, will try API without it or extract from response');
    }
    
    // Choose the appropriate API endpoint based on dataTypes
    debug('[UnifiedDataAPI] Endpoint selection:', {
      dataTypes: options.dataTypes,
      includesMapData: options.dataTypes?.includes('map_data'),
      includesTimeseriesData: options.dataTypes?.includes('timeseries_data'),
      sourceName: options.sourceName
    });
    
    if (options.dataTypes && options.dataTypes.includes('map_data')) {
      // Use map data endpoint for map data
      debug('[UnifiedDataAPI] Using map data endpoint');
      if (!sourceName) {
        warn('[UnifiedDataAPI] sourceName required for map_data endpoint');
        return {
          data: [],
          availableChannels: [],
          missingChannels: channels,
          hasAll: false
        };
      }
      
      // Get sourceId from sourceName if not provided
      let sourceId: number | undefined = options.sourceId;
      if (!sourceId && sourceName) {
        const resolvedSourceId = sourcesStore.getSourceId(sourceName);
        if (resolvedSourceId) {
          sourceId = Number(resolvedSourceId);
        } else {
          warn(`[UnifiedDataAPI] Could not resolve sourceId from sourceName "${sourceName}"`);
        }
      }
      
      dataPoints = await fetchAndStoreMapData({
        projectId: options.projectId,
        className: options.className,
        datasetId: options.datasetId,
        sourceName: sourceName,
        sourceId: sourceId, // Pass resolved sourceId
        date: options.date
      });
    } else {
      // Use timeseries endpoint for other data types
      debug('[UnifiedDataAPI] Using timeseries data endpoint');
      
      // CRITICAL: Resolve sourceName and sourceId - API requires source, so we should always have one
      let sourceName = options.sourceName;
      let sourceId = options.sourceId;
      
      // If we have sourceId but not sourceName, try to get sourceName from sourcesStore
      if (!sourceName && sourceId && sourceId !== 0) {
        sourceName = sourcesStore.getSourceName(sourceId) ?? undefined;
        if (sourceName) {
          info(`[UnifiedDataAPI] Resolved sourceName "${sourceName}" from sourceId ${sourceId}`);
        } else {
          warn(`[UnifiedDataAPI] ⚠️ sourcesStore does not have sourceId ${sourceId}! This indicates sourcesStore is not properly populated.`);
        }
      }
      
      // If we have sourceName but not sourceId, try to get sourceId from sourcesStore
      if (!sourceId && sourceName) {
        const resolvedSourceId = sourcesStore.getSourceId(sourceName);
        if (resolvedSourceId && resolvedSourceId !== 0) {
          sourceId = Number(resolvedSourceId);
          info(`[UnifiedDataAPI] Resolved sourceId ${sourceId} from sourceName "${sourceName}"`);
        } else {
          warn(`[UnifiedDataAPI] ⚠️ sourcesStore does not have sourceName "${sourceName}"! This indicates sourcesStore is not properly populated.`);
        }
      }
      
      // Validate required parameters
      if (!sourceName) {
        warn('[UnifiedDataAPI] sourceName is required for timeseries data fetch', {
          projectId: options.projectId,
          className: options.className,
          datasetId: options.datasetId,
          providedSourceName: options.sourceName,
          providedSourceId: options.sourceId,
          channels: channels.slice(0, 5)
        });
        return {
          data: [],
          availableChannels: [],
          missingChannels: channels,
          hasAll: false
        };
      }
      
      // Ensure date is provided - use today if not specified
      const date = options.date || new Date().toISOString().split('T')[0];
      
      info('[UnifiedDataAPI] Fetching timeseries data', {
        projectId: options.projectId,
        className: options.className,
        datasetId: options.datasetId,
        sourceName: sourceName,
        sourceId: sourceId,
        date,
        channelCount: channels.length
      });
      
      // CRITICAL: Log channels before API call to verify they're in original case
      debug(`[UnifiedDataAPI] 🔍 CHANNELS BEFORE API CALL:`, {
        channels: channels,
        channelsCount: channels.length,
        sampleChannels: channels.slice(0, 10),
        caseCheck: channels.slice(0, 10).map(ch => ({
          channel: ch,
          hasUpperCase: /[A-Z]/.test(ch),
          isLowercase: ch === ch.toLowerCase()
        })),
        note: 'These channels should be in original case from chart objects. If lowercase here, they were lowercase when passed to getDataByChannels.'
      });
      
      dataPoints = await fetchAndStoreTimeSeriesData({
        projectId: options.projectId,
        className: options.className,
        datasetId: options.datasetId,
        sourceName: sourceName, // Use resolved sourceName
        sourceId: sourceId, // Use resolved sourceId
        channels: channels,
        date: date,
        timezone: (options as any).timezone || 'UTC', // Default to UTC if not provided (API requires string, not null)
        use_v2: (options as any).use_v2 !== false, // Obsolete - kept for backward compatibility, now ignored
        data_source: options.data_source || 'auto' // Obsolete - kept for backward compatibility, now ignored (DuckDB is the only implementation)
      });
    }
    
    // Extract actual channels from the data to determine what's really available
    // CRITICAL: Include ALL keys from the first data point, even if values are null
    // Null values indicate the channel exists but has no data - this is different from missing
    const dataKeys = dataPoints.length > 0 ? 
      Object.keys(dataPoints[0] || {}).filter(key => 
        key !== 'timestamp' && 
        key !== 'source_id' && 
        key !== 'source_name' &&
        key !== 'sourceId' &&
        key !== 'sourceName'
      ) : [];
    
    // CRITICAL: Map data keys (which may be lowercase) back to original case from requested channels
    // This ensures availableChannels preserves original case for table creation
    const requestedChannelsLower = new Set(channels.map(ch => ch.toLowerCase()));
    const _dataKeysLower = new Set(dataKeys.map(ch => ch.toLowerCase()));
    
    // Build mapping: lowercase data key -> original case requested channel
    const channelCaseMap = new Map<string, string>();
    channels.forEach(reqCh => {
      const reqChLower = reqCh.toLowerCase();
      channelCaseMap.set(reqChLower, reqCh);
    });
    
    // Map data keys to original case from requested channels
    const actualChannels = dataKeys.map(dataKey => {
      const dataKeyLower = dataKey.toLowerCase();
      // If this data key matches a requested channel, use original case
      if (requestedChannelsLower.has(dataKeyLower)) {
        return channelCaseMap.get(dataKeyLower) || dataKey;
      }
      // Channel in data but not requested - preserve its case from data
      return dataKey;
    });
    
    // Log channel availability for debugging
    if (dataPoints.length > 0) {
      const availableChannelNames = new Set(actualChannels.map(ch => ch.toLowerCase()));
      // Metadata channels that are expected to come from metadata/tags, not as separate channels
      // Datetime is always derived from timestamp, so it's never in the API response as a separate channel
      const metadataChannels = new Set(['race_number', 'leg_number', 'grade', 'config', 'state', 'datetime', 'timestamp']);
      const missingChannels = channels.filter(ch => 
        !availableChannelNames.has(ch.toLowerCase())
      );
      
      // Separate metadata channels from actual missing channels
      const missingMetadata = missingChannels.filter(ch => 
        metadataChannels.has(ch.toLowerCase())
      );
      const missingNonMetadata = missingChannels.filter(ch => 
        !metadataChannels.has(ch.toLowerCase())
      );
      
      if (missingNonMetadata.length > 0) {
        debug(`[UnifiedDataAPI] ⚠️ ${missingNonMetadata.length} requested channels not found in data:`, {
          missingChannels: missingNonMetadata.slice(0, 10),
          availableChannels: actualChannels.slice(0, 10),
          dataKeys: dataKeys.slice(0, 10), // Show original data keys for comparison
          requestedCount: channels.length,
          availableCount: actualChannels.length,
          dataLength: dataPoints.length
        });
      }
      // Log metadata channels separately (they're expected to come from metadata)
      if (missingMetadata.length > 0) {
        debug(`[UnifiedDataAPI] ${missingMetadata.length} metadata channels requested (will be extracted from metadata if available):`, missingMetadata);
      }
      if (missingChannels.length === 0 || (missingChannels.length === missingMetadata.length && missingNonMetadata.length === 0)) {
        info(`[UnifiedDataAPI] ✅ All ${channels.length} requested channels found in data`);
      }
    }
    
    // Use case-insensitive matching for missing channels (consistent with lines 792-798)
    const actualChannelsLower = new Set(actualChannels.map(ch => ch.toLowerCase()));
    const missingChannels = channels.filter(ch => !actualChannelsLower.has(ch.toLowerCase()));
    
    return {
      data: dataPoints,
      availableChannels: actualChannels, // Now in original case from requested channels
      missingChannels: missingChannels,
      hasAll: actualChannels.length === channels.length && dataPoints.length > 0
    };
  } catch (error) {
    logError('[UnifiedDataAPI] Error getting data by channels:', error);
    return {
      data: [],
      availableChannels: [],
      missingChannels: channels,
      hasAll: false
    };
  }
};

// Clear all data - NOW USING HUNIDB
export const clearAllData = async (): Promise<void> => {
  try {
    await huniDBStore.clearAllData();
    info('[UnifiedDataAPI] Cleared all data (HuniDB)');
  } catch (error) {
    logError('[UnifiedDataAPI] Error clearing data:', error);
  }
};

// Get storage info - NOW USING HUNIDB
export const getStorageInfo = async () => {
  try {
    return await huniDBStore.getStorageInfo();
  } catch (error) {
    logError('[UnifiedDataAPI] Error getting storage info:', error);
    return { channelCount: 0, objectCount: 0, totalSize: 0 };
  }
};

// Export the main API object
export const unifiedDataAPI = {
  getDataByChannels,
  clearAllData,
  getStorageInfo,
  fetchAndStoreTimeSeriesData,
  fetchAndStoreMapData
};
