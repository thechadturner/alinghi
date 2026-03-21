/**
 * Fleet Performance Data Service
 * 
 * Handles fetching and managing fleet performance data (aggregates, cloud, targets)
 * from the fleet-performance-data API endpoint which returns event_id, source_name, and channels
 * 
 * FILTER SEPARATION:
 * - API Filters (sent to backend): YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE (for HistoricalPerformance)
 * - Client Filters (applied after data retrieval): STATE, RACE, LEG, GRADE (default)
 * 
 * This separation improves cache efficiency (client filter changes don't invalidate cache)
 * and reduces API payload size (large datasets filtered server-side).
 */

import { getData, formatDate, formatTime } from '../utils/global';
import { apiEndpoints } from '@config/env';
import { warn as logWarn, error as logError, debug as logDebug } from '../utils/console';
import { persistantStore } from '../store/persistantStore';
import { huniDBStore, type FilterSet } from '../store/huniDBStore';
import type { AggregateEntry, CloudDataEntry } from '@store/huniDBTypes';
import { defaultChannelsStore } from '../store/defaultChannelsStore';
import { resolveDataField } from '../utils/colorScale';
import { isMobileDevice } from '../utils/deviceDetection';

const { selectedClassName, selectedProjectId, selectedSourceId, selectedDate } = persistantStore;

export interface FleetPerformanceDataService {
  // Chart configuration
  fetchCharts: () => Promise<any[]>;
  
  // Fleet performance data methods
  fetchAggregates: (channels: string[], aggregateType?: string, startDate?: string, endDate?: string, filters?: Record<string, any[]>) => Promise<any[]>;
  getAggregateTypeMapping: (chartObjects: any[]) => Promise<{ aggregateType: string; channels: string[]; series: any[] }[]>;
  fetchAggregatesByType: (groupedChannels: { aggregateType: string; channels: string[] }[], filters?: Record<string, any[]>) => Promise<any[]>;
  fetchCloud: (channels: string[], cloudType?: string, startDate?: string, endDate?: string, filters?: Record<string, any[]>) => Promise<any[]>;
  fetchTargets: () => Promise<any>;
  
  // Data processing helpers
  getRequiredChannels: (chartObjects: any[]) => string[];
  enrichWithLocalTimeStrings: (items: any[]) => void;
  processFleetPerformanceData: (aggregates: any[], cloud: any[], targets: any) => {
    aggregates: any[];
    cloud: any[];
    targets: any;
  };
}

// Chart configuration fetching
const fetchCharts = async (): Promise<any[]> => {
  const controller = new AbortController();
  
  try {
    // Check if user is available
    const { user } = await import('../store/userStore');
    const currentUser = user();
    if (!currentUser || !currentUser.user_id) {
      logWarn("User not available, skipping chart fetch");
      return [];
    }

    const response = await getData(
      `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=fleet_performance&object_name=fleet_performance_default`, 
      controller.signal
    );
    
    // Log chart configuration to debug unit issues
    if (response.success && response.data?.chart_info) {
      const charts = response.data.chart_info;
      logDebug('[FleetPerformanceDataService] Loaded fleet charts', {
        chartCount: charts.length,
        firstChartSeries: charts[0]?.charts?.[0]?.series?.map((s: any) => ({
          yaxis: s.yaxis?.name || s.yaxis?.dataField,
          xaxis: s.xaxis?.name || s.xaxis?.dataField
        }))
      });
    }

    if (!response.success) {
      // Try fallback to performance charts if fleet_performance doesn't exist
      const fallbackResponse = await getData(
        `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=performance&object_name=performance_default`, 
        controller.signal
      );
      if (fallbackResponse.success) {
        return fallbackResponse.data?.chart_info || [];
      }
      throw new Error("Failed to fetch user object.");
    }

    return response.data?.chart_info || [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return [];
    }
    logError("Error fetching charts:", error as any);
    return [];
  }
};

// Fetch aggregated fleet performance data
// Resolve date range if not provided: prefer selectedDate(), otherwise fetch last_date by source
const resolveDateRange = async (): Promise<{ startDate: string; endDate: string }> => {
  try {
    const dateSel = typeof selectedDate === 'function' ? selectedDate() : '';
    if (dateSel) {
      // Strip quotes from date if they exist (some sources may return JSON stringified dates)
      const cleanDate = String(dateSel).replace(/^["']|["']$/g, '');
      return { startDate: cleanDate, endDate: cleanDate };
    }
    // Fleet requests use source_id=0
    const controller = new AbortController();
    const resp = await getData(
      `${apiEndpoints.app.datasets}/last_date?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=0`,
      controller.signal
    );
    if (resp.success && resp.data) {
      const end = new Date(resp.data);
      const start = new Date(end.getTime());
      // Set start date to 1 year (365 days) before end date to match Performance History
      start.setDate(start.getDate() - 365);
      // Return YYYY-MM-DD strings (API accepts this format)
      return { startDate: toYmd(start), endDate: toYmd(end) };
    }
  } catch (err) {
    logError('FleetPerformanceDataService.resolveDateRange error:', err as any);
  }
  return { startDate: '', endDate: '' };
};

// Helper to format date as YYYY-MM-DD
const toYmd = (d: Date): string => {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

// Helper to calculate date N days back from a given date string
const getDateDaysBack = (dateStr: string, days: number): string => {
  const date = new Date(dateStr);
  date.setDate(date.getDate() - days);
  return toYmd(date);
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
  const targetDateStr = toYmd(targetDate);
  
  return cachedData.filter(point => {
    if (!point.Datetime) return false;
    const pointDate = new Date(point.Datetime);
    const pointDateStr = toYmd(pointDate);
    return pointDateStr === targetDateStr;
  });
};

// Helper to normalize channels array
const normalizeChannels = (channels: string[]): string[] => {
  return (channels || []).map(c => String(c));
};

const fetchAggregates = async (channels: string[], aggregateType: string = 'AVG', startDate?: string, endDate?: string, filters?: Record<string, any[]>): Promise<any[]> => {
  const controller = new AbortController();
  
  try {
    const className = selectedClassName().toLowerCase();
    const projectId = selectedProjectId().toString();
    
    // Normalize aggregate type to lowercase for API
    const apiAggregateType = aggregateType.toLowerCase();
    
    logDebug(`[FleetPerformanceDataService] fetchAggregates called with:`, {
      startDate,
      endDate,
      hasFilters: !!filters,
      filters: filters ? JSON.stringify(filters) : 'none',
      filtersKeys: filters ? Object.keys(filters) : []
    });
    
    // Resolve dates if not provided by caller
    if (!startDate || !endDate) {
      const r = await resolveDateRange();
      startDate = r.startDate;
      endDate = r.endDate;
      logDebug(`[FleetPerformanceDataService] Resolved dates:`, { startDate, endDate });
    }
    
    // Strip quotes from dates if they exist (some sources may return JSON stringified dates)
    if (startDate) {
      startDate = String(startDate).replace(/^["']|["']$/g, '');
    }
    if (endDate) {
      endDate = String(endDate).replace(/^["']|["']$/g, '');
    }
    
    // Check IndexedDB first for fleet aggregates (no sourceId for fleet data)
    logDebug(`[FleetPerformanceDataService] Fetching fleet aggregates from IndexedDB for ${className}`);
    
    // Normalize aggregate type to uppercase for HuniDB (agrType is uppercase: 'AVG', 'STD', 'AAV')
    const agrType = aggregateType.toUpperCase();
    
    // Split filters into API and client categories
    // API filters: YEAR, EVENT, CONFIG, SOURCE_NAME (and optionally GRADE for HistoricalPerformance)
    // Client filters: STATE, RACE, LEG, GRADE (default)
    const { splitFilters } = await import('../utils/filterSeparation');
    const splitFilterResult = filters ? splitFilters(filters, false) : { apiFilters: {}, clientFilters: {} };
    const apiFilters = splitFilterResult.apiFilters;
    const clientFilters = splitFilterResult.clientFilters;

    logDebug(`[FleetPerformanceDataService] Split filters:`, {
      apiFilters: JSON.stringify(apiFilters),
      clientFilters: JSON.stringify(clientFilters)
    });
    
    // Build HuniDB query filters - DO NOT include STATE/EVENT/CONFIG in SQL
    // These are API filters and are handled by the API, not HuniDB SQL queries
    // HuniDB only filters by project/agrType for cache lookup
    // Note: Do NOT filter by sourceId - fleet aggregates include all sources
    // Each aggregate is stored with its actual source_id from the API
    const huniDBFilters: {
      projectId?: string;
      sourceId?: string;
      agrType?: string;
    } = {
      projectId,
      agrType, // Filter by agrType (uppercase)
      // Do NOT set sourceId - we want aggregates from ALL sources for fleet performance
    };
    
    logDebug(`[FleetPerformanceDataService] Querying HuniDB for fleet aggregates:`, huniDBFilters);
    
    // Build requested filters for cache validation - only API filters affect cache
    // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
    const requestedFilters: FilterSet | undefined = Object.keys(apiFilters).length > 0 ? {
      events: apiFilters.EVENT || [],
      configs: apiFilters.CONFIG || [],
      grades: apiFilters.GRADE || [],
      dateRange: startDate && endDate ? { start: startDate, end: endDate } : undefined
      // STATE, RACE, LEG are client-side and don't affect cache validation
    } : (startDate && endDate ? {
      dateRange: { start: startDate, end: endDate }
    } : undefined);
    
    // Aggregates no longer cached in HuniDB - always fetch from API
    const cachedAggregates: any[] = [];
    if (!isMobileDevice() && cachedAggregates.length === 0 && requestedFilters) {
      logDebug(`[FleetPerformanceDataService] Cache empty - may be due to filter validation mismatch, will fetch from API if needed`);
    }
    
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
      logDebug(`[FleetPerformanceDataService] Client filter config:`, JSON.stringify(clientFilterConfig));
    }
    
    if (cachedAggregates && cachedAggregates.length > 0) {
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
          logDebug(`[FleetPerformanceDataService] Applying client-side filters:`, JSON.stringify(clientFilterConfig));
          // Import passesBasicFilters for proper filtering
          const { passesBasicFilters } = await import('../utils/filterCore');
          
          filteredAggregates = cachedAggregates.filter(entry => {
            const metadata = entry.metadata || {}; // Already normalized
            const data = entry.data || {};
            
            // Build a data point object for passesBasicFilters
            // Since metadata is normalized, just use normalized fields - passesBasicFilters now prefers normalized
            const dataPointForFilter: any = {
              ...data,
              grade: metadata.grade,
              race_number: metadata.race_number,
              leg_number: metadata.leg_number,
              state: metadata.state,
              source_name: metadata.source_name,
              // TWA - from data object
              twa: data.Twa ?? data.twa ?? data.Twa_deg ?? data.twa_deg,
              Twa: data.Twa ?? data.twa ?? data.Twa_deg ?? data.twa_deg,
            };

            // Use passesBasicFilters for client-side filtering (STATE, RACE, LEG, GRADE)
            return passesBasicFilters(dataPointForFilter, clientFilterConfig);
          });
          
          logDebug(`[FleetPerformanceDataService] Client-side filtering: ${cachedAggregates.length} -> ${filteredAggregates.length} points`);
        }
      }
      
      // Convert AggregateEntry[] to array format for date filtering
      const cachedAggregatesFormatted = filteredAggregates.map(entry => {
        // Format race_number: convert 'TRAINING' or -1, handle null/undefined
        // Note: race_number can be number or string (e.g., 'TRAINING') despite interface typing
        let raceValue: number | string | undefined = entry.metadata?.race_number as number | string | undefined;
        if (raceValue === -1 || (typeof raceValue === 'string' && (raceValue === '-1' || raceValue === 'TRAINING'))) {
          raceValue = 'TRAINING';
        } else if (raceValue !== null && raceValue !== undefined) {
          raceValue = raceValue.toString();
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
      
      if (startDate && endDate) {
        let filtered = filterCacheByDateRange(cachedAggregatesFormatted as any[], startDate, endDate);

        // Build inclusive list of required dates (YYYY-MM-DD)
        const requiredDates: string[] = (() => {
          const dates: string[] = [];
          const start = new Date(startDate as string);
          const end = new Date(endDate as string);
          start.setHours(0,0,0,0);
          end.setHours(0,0,0,0);
          for (let d = new Date(start.getTime()); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
            dates.push(toYmd(d));
          }
          return dates;
        })();

        // Collect distinct dates present in filtered cache
        const presentDates = new Set<string>();
        for (const p of filtered) {
          if (p && (p as any).Datetime) {
            const dt = new Date((p as any).Datetime);
            presentDates.add(toYmd(dt));
          }
        }

        // Check if all required dates are present
        const hasFullDateCoverage = requiredDates.every(d => presentDates.has(d));

        // Check source coverage if SOURCE_NAME filter is provided
        let hasFullSourceCoverage = true;
        if (filters && filters.SOURCE_NAME && Array.isArray(filters.SOURCE_NAME) && filters.SOURCE_NAME.length > 0) {
          const selectedSourceNames = filters.SOURCE_NAME.map((name: string) => String(name).toLowerCase().trim());
          
          // Collect sources present in filtered cache
          const presentSources = new Set<string>();
          for (const p of filtered) {
            const sourceName = p.Source_name || p.source_name || p.SOURCE_NAME || p.sourceName || '';
            const normalizedSourceName = String(sourceName).toLowerCase().trim();
            if (normalizedSourceName) {
              presentSources.add(normalizedSourceName);
            }
          }
          
          // Check if all requested sources are present
          hasFullSourceCoverage = selectedSourceNames.every(sourceName => presentSources.has(sourceName));
          
          if (!hasFullSourceCoverage) {
            const missingSources = selectedSourceNames.filter(sourceName => !presentSources.has(sourceName));
            logDebug(`[FleetPerformanceDataService] Cached fleet aggregates missing sources: ${missingSources.join(', ')}. Will fetch from API.`, {
              requestedSources: selectedSourceNames,
              presentSources: Array.from(presentSources),
              missingSources: missingSources
            });
          }
          
          // Filter by selected sources after checking coverage
          filtered = filtered.filter((item: any) => {
            // Extract source name from various possible field names
            const sourceName = item.Source_name || item.source_name || item.SOURCE_NAME || item.sourceName || '';
            const normalizedSourceName = String(sourceName).toLowerCase().trim();
            return selectedSourceNames.includes(normalizedSourceName);
          });
        }

        // Only return cached data if we have full date AND source coverage
        if (hasFullDateCoverage && hasFullSourceCoverage) {
          logDebug(`[FleetPerformanceDataService] Using cached fleet aggregates: full coverage for ${startDate} to ${endDate} (${filtered.length} points)`);
          return filtered as any[];
        }

        if (!hasFullDateCoverage) {
          logDebug(`[FleetPerformanceDataService] Cached fleet aggregates incomplete for ${startDate} to ${endDate} (have ${presentDates.size}/${requiredDates.length} dates). Will fetch from API.`);
        }
        // Fall through to API fetch
      } else {
        // Filter by selected sources even if no date range (for cases where date range is not provided)
        let filtered = cachedAggregatesFormatted;
        if (filters && filters.SOURCE_NAME && Array.isArray(filters.SOURCE_NAME) && filters.SOURCE_NAME.length > 0) {
          const selectedSourceNames = filters.SOURCE_NAME.map((name: string) => String(name).toLowerCase().trim());
          
          // Collect sources present in cache
          const presentSources = new Set<string>();
          for (const p of cachedAggregatesFormatted) {
            const sourceName = p.source_name || '';
            const normalizedSourceName = String(sourceName).toLowerCase().trim();
            if (normalizedSourceName) {
              presentSources.add(normalizedSourceName);
            }
          }
          
          // Check if all requested sources are present
          const hasFullSourceCoverage = selectedSourceNames.every(sourceName => presentSources.has(sourceName));
          
          if (!hasFullSourceCoverage) {
            const missingSources = selectedSourceNames.filter(sourceName => !presentSources.has(sourceName));
            logDebug(`[FleetPerformanceDataService] Cached fleet aggregates missing sources (no date range): ${missingSources.join(', ')}. Will fetch from API.`, {
              requestedSources: selectedSourceNames,
              presentSources: Array.from(presentSources),
              missingSources: missingSources
            });
            // Fall through to API fetch to get missing sources
          } else {
            // All sources present, filter and return cached data
            filtered = cachedAggregatesFormatted.filter((item: any) => {
              // Extract source name from various possible field names
              const sourceName = item.Source_name || item.source_name || item.SOURCE_NAME || item.sourceName || '';
              const normalizedSourceName = String(sourceName).toLowerCase().trim();
              return selectedSourceNames.includes(normalizedSourceName);
            });
            logDebug(`[FleetPerformanceDataService] Filtered cached aggregates by sources (no date range): ${filters.SOURCE_NAME.length} sources selected, ${filtered.length} points after filtering`);
            return filtered as any[];
          }
        } else {
          // No source filter, return all cached data
          logDebug(`[FleetPerformanceDataService] No valid date range resolved; returning cached fleet aggregates (${filtered.length} points)`);
          return filtered as any[];
        }
      }
    }
    
    const normalizedChannels = normalizeChannels(channels);
    
    // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
    // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
    // CRITICAL: GRADE should NOT be in apiFilters for fleet performance (it's client-side by default)
    // If GRADE is in apiFilters, it means there's a bug - log a warning
    if (apiFilters.GRADE) {
      logWarn(`[FleetPerformanceDataService] WARNING: GRADE filter found in API filters! This should be client-side only.`, {
        apiFilters,
        clientFilters
      });
    }
    
    const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
    const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0 
      ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}` 
      : '';
    
    // Log filter details for debugging
    logDebug(`[FleetPerformanceDataService] Filter breakdown:`, {
      apiFilters: apiFiltersForRequest,
      clientFilters: clientFilters,
      hasGradeInAPI: !!apiFilters.GRADE,
      hasGradeInClient: !!clientFilters.GRADE,
      gradeValues: clientFilters.GRADE || []
    });
    
    const url = `${apiEndpoints.app.data}/fleet-performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=0&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&event_type=BIN%2010&agr_type=${apiAggregateType}&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
    
    // Log the request details for debugging production issues
    logDebug(`[FleetPerformanceDataService] Fetching from API:`, {
      url: url.substring(0, 200) + '...', // Truncate for readability
      filters: apiFiltersForRequest,
      sourceNames: apiFiltersForRequest?.SOURCE_NAME || 'ALL',
      sourceCount: apiFiltersForRequest?.SOURCE_NAME?.length || 0
    });
    
    const response = await getData(url, controller.signal);
  
    if (!response.success) {
      logError("Aggregates data fetch failed:", response as any);
      throw new Error("Failed to fetch aggregates data.");
    }
    
    let aggregatesData = response.data || [];
    
    // Log response details for debugging
    logDebug(`[FleetPerformanceDataService] API response received:`, {
      dataLength: aggregatesData.length,
      hasData: aggregatesData.length > 0,
      sampleSourceNames: aggregatesData.length > 0 
        ? [...new Set(aggregatesData.slice(0, 20).map((item: any) => 
            item.Source_name || item.source_name || item.SOURCE_NAME || 'unknown'
          ))]
        : []
    });
    
    // Convert API response to AggregateEntry format and store in HuniDB
    if (aggregatesData.length > 0) {
      
      // Import normalization utility
      const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
      
      // Normalize API response data to lowercase field names (same as unifiedDataStore does)
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
      
      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
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
          const { passesBasicFilters } = await import('../utils/filterCore');
          const beforeCount = aggregatesData.length;
          aggregatesData = aggregatesData.filter((item: any) => {
            const normalized = extractAndNormalizeMetadata(item);
            const dataPointForFilter: any = {
              ...item,
              // extractAndNormalizeMetadata returns capitalized field names (Grade, Race_number, etc.)
              grade: normalized.Grade,
              race_number: normalized.Race_number,
              leg_number: normalized.Leg_number,
              state: normalized.State,
              source_name: normalized.source_name, // This one is already lowercase
              // Also provide uppercase variations for backward compatibility
              GRADE: normalized.Grade,
              Grade: normalized.Grade,
              Race_number: normalized.Race_number,
              Leg_number: normalized.Leg_number,
              State: normalized.State,
              STATE: normalized.State,
              twa: item.Twa ?? item.twa ?? item.Twa_deg ?? item.twa_deg,
              Twa: item.Twa ?? item.twa ?? item.Twa_deg ?? item.twa_deg,
            };
            return passesBasicFilters(dataPointForFilter, clientFilterConfig);
          });
          if (beforeCount !== aggregatesData.length) {
            logDebug(`[FleetPerformanceDataService] Applied client-side filters to API data: ${beforeCount} -> ${aggregatesData.length} points`);
          }
        }
      }
      
      const aggregateEntries: AggregateEntry[] = aggregatesData.map((item: any) => {
        // Extract channel data (all numeric fields except known metadata fields)
        const data: Record<string, any> = {};
        const metadataFields = ['event_id', 'source_name', 'source_id', 'project_id', 'dataset_id', 'Datetime', 'GRADE', 'Grade', 'grade', 'RACE', 'Race_number', 'race_number', 'LEG', 'Leg_number', 'leg_number', 'Tack', 'Config', 'Year', 'Event', 'State', 'state', 'STATE'];
        
        for (const key in item) {
          if (!metadataFields.includes(key) && typeof item[key] === 'number' && !isNaN(item[key]) && isFinite(item[key])) {
            data[key] = item[key];
          }
        }
        
        // Extract IDs from API response (use API values, fallback to defaults if missing)
        const datasetId = item.dataset_id || '0';
        const projectIdFromApi = item.project_id ? String(item.project_id) : projectId; // Use API value or fallback to store value
        const sourceId = item.source_id ? String(item.source_id) : '0'; // Use actual source_id from API
        const eventId = item.event_id || 0;
        
        // Build ID: bin10-{agrType}-datasetId-projectId-sourceId-eventId
        const id = `bin10-${agrType.toLowerCase()}-${datasetId}-${projectIdFromApi}-${sourceId}-${eventId}`;
        
        // Use normalization utility to extract and normalize metadata
        const normalizedMetadata = extractAndNormalizeMetadata(item);
        // storeAggregates (HuniDB) expects lowercase metadata keys: race_number, leg_number, grade, state, config, event, source_name, datetime, year, tack
        const metadata = {
          race_number: normalizedMetadata.Race_number,
          leg_number: normalizedMetadata.Leg_number,
          grade: normalizedMetadata.Grade,
          state: normalizedMetadata.State,
          config: normalizedMetadata.Config,
          event: normalizedMetadata.Event,
          source_name: normalizedMetadata.source_name ?? item.Source_name ?? item.source_name ?? item.SOURCE_NAME,
          datetime: item.Datetime ?? normalizedMetadata.Datetime ?? undefined,
          year: item.Year ?? item.year ?? item.YEAR ?? normalizedMetadata.Year ?? undefined,
          tack: normalizedMetadata.Tack ?? item.Tack ?? item.TACK ?? item.tack ?? undefined,
        };
        return {
          id,
          eventType: 'BIN10',
          agrType: agrType, // Use actual agrType instead of hardcoded 'AVG'
          datasetId,
          projectId: projectIdFromApi,
          sourceId, // Use actual source_id from API to preserve source information
          eventId,
          metadata,
          data,
        };
      });
      
      if (!isMobileDevice()) {
        // Build applied filters for cache metadata - only API filters affect cache
        // Client filters (STATE, RACE, LEG, GRADE if client-side) don't invalidate cache
        const appliedFilters: FilterSet = {
          events: apiFilters.EVENT || [],
          configs: apiFilters.CONFIG || [],
          grades: apiFilters.GRADE || [],
          dateRange: startDate && endDate ? { start: startDate, end: endDate } : undefined
          // STATE, RACE, LEG are client-side and don't affect cache metadata
        };
        
        // Aggregates storage removed - agg.aggregates table no longer used
        logDebug(`[FleetPerformanceDataService] Skipping aggregates storage (deprecated) - ${aggregateEntries.length} fleet aggregates`);
      }
    }
    
    return aggregatesData;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return [];
    }
    logError("Error fetching aggregates:", error as any);
    throw error;
  }
};

// Get aggregate type mapping from chart objects (reuse from performanceDataService)
const getAggregateTypeMapping = async (chartObjects: any[]): Promise<{ aggregateType: string; channels: string[]; series: any[] }[]> => {
  // Import and use the same function from performanceDataService
  const { performanceDataService } = await import('./performanceDataService');
  return performanceDataService.getAggregateTypeMapping(chartObjects);
};

// Fetch aggregates by type (handles AVG, STD, AAV separately and merges)
const fetchAggregatesByType = async (
  groupedChannels: { aggregateType: string; channels: string[] }[],
  filters?: Record<string, any[]>
): Promise<any[]> => {
  try {
    if (!groupedChannels || groupedChannels.length === 0) {
      logWarn('[FleetPerformanceDataService] No grouped channels provided to fetchAggregatesByType');
      return [];
    }

    logDebug(`[FleetPerformanceDataService] Fetching aggregates by type for ${groupedChannels.length} aggregate types:`, 
      groupedChannels.map(g => ({ aggregateType: g.aggregateType, channelCount: g.channels.length, channels: g.channels.slice(0, 3) }))
    );

    // Fetch each aggregate type in parallel
    const fetchPromises = groupedChannels.map((group) => {
      logDebug(`[FleetPerformanceDataService] Fetching ${group.aggregateType} aggregates for channels:`, group.channels);
      return fetchAggregates(group.channels, group.aggregateType, undefined, undefined, filters);
    });
    
    const results = await Promise.all(fetchPromises);
    
    // Log results for each aggregate type
    results.forEach((result, resultIndex) => {
      const group = groupedChannels[resultIndex];
      logDebug(`[FleetPerformanceDataService] Fetched ${result.length} points for aggregateType: ${group.aggregateType}`);
      if (result.length > 0) {
        const sample = result[0];
        // Analyze source distribution in the result
        const sourceDistribution = result.reduce((acc: Record<string, number>, item: any) => {
          const sourceName = item.source_name || item.Source_name || item.SOURCE_NAME || 'unknown';
          const normalizedSource = String(sourceName).toLowerCase().trim();
          acc[normalizedSource] = (acc[normalizedSource] || 0) + 1;
          return acc;
        }, {});
        
        logDebug(`[FleetPerformanceDataService] Sample ${group.aggregateType} point:`, {
          event_id: sample.event_id,
          source_name: sample.source_name || sample.Source_name || sample.SOURCE_NAME || 'unknown',
          dataKeys: Object.keys(sample).filter(k => !['event_id', 'Datetime', 'TACK', 'RACE', 'LEG', 'GRADE'].includes(k)).slice(0, 5),
          sourceDistribution: sourceDistribution,
          uniqueSources: Object.keys(sourceDistribution).length,
          totalPoints: result.length
        });
      }
    });
    
    // Merge results by event_id
    // Start with AVG data as the base (it has the most complete data including x-axis)
    const avgIndex = groupedChannels.findIndex(g => g.aggregateType.toUpperCase() === 'AVG');
    const baseData = avgIndex >= 0 ? results[avgIndex] : results[0];
    
    if (!baseData || baseData.length === 0) {
      logWarn('[FleetPerformanceDataService] No base data found for merging aggregates');
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

    // Merge other aggregate types into the base data
    groupedChannels.forEach((group, index) => {
      if (index === avgIndex) {
        // Skip AVG, already added
        return;
      }

      const aggregateType = group.aggregateType.toUpperCase();
      const dataForType = results[index] || [];

      logDebug(`[FleetPerformanceDataService] fetchAggregatesByType: Merging ${aggregateType} data (agrType: ${aggregateType}): ${dataForType.length} points`);

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
            if (['event_id', 'Datetime', 'dataset_id', 'project_id', 'source_id', 
                 'TACK', 'RACE', 'LEG', 'GRADE', 'CONFIG', 
                 'YEAR', 'EVENT', 'State', 'STATE', 'Source_name', 'source_name', 'SOURCE_NAME'].includes(key)) {
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
          logDebug(`[FleetPerformanceDataService] Found ${aggregateType} point for event_id ${eventId} not in base data`);
          mergedMap.set(eventId, { ...point });
        }
      });
    });

    const mergedArray = Array.from(mergedMap.values());
    const aggregateTypesUsed = groupedChannels.map(g => `${g.aggregateType}(${g.aggregateType.toLowerCase()})`).join(', ');
    logDebug(`[FleetPerformanceDataService] fetchAggregatesByType: Merged ${mergedArray.length} aggregate points from ${groupedChannels.length} aggregate types: ${aggregateTypesUsed}`);
    
    return mergedArray;
  } catch (err) {
    logError("Error fetching aggregates by type:", err as any);
    throw err;
  }
};

// Fetch cloud (1Hz) fleet performance data
const fetchCloud = async (channels: string[], cloudType?: string, startDate?: string, endDate?: string, filters?: Record<string, any[]>): Promise<any[]> => {
  const controller = new AbortController();
  
  try {
    const className = selectedClassName().toLowerCase();
    const projectId = selectedProjectId().toString();
    const sourceId = selectedSourceId().toString();
    
    // Default cloudType to 'Latest' if not provided
    const finalCloudType = cloudType || 'Latest';

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
    if (finalCloudType === 'Fleet Data') {
      // Fleet Data - use shared-cloud-data endpoint with agr_type=AVG, table_name=events_aggregate
      // Include all sources from project_id plus shared=1 datasets, excluding selectedSourceId
      const { startDate: resolvedStartDate, endDate: resolvedEndDate } = await resolveDateRange();
      let finalStartDate = startDate || resolvedStartDate;
      let finalEndDate = endDate || resolvedEndDate;
      
      // Strip quotes from dates if they exist (some sources may return JSON stringified dates)
      if (finalStartDate) {
        finalStartDate = String(finalStartDate).replace(/^["']|["']$/g, '');
      }
      if (finalEndDate) {
        finalEndDate = String(finalEndDate).replace(/^["']|["']$/g, '');
      }
      
      logDebug(`[FleetPerformanceDataService] Fleet Data: Fetching from IndexedDB for ${className}, date range: ${finalStartDate} to ${finalEndDate}`);
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
      let cachedFleetCloudData: CloudDataEntry[] = [];
      // Cloud data no longer cached in HuniDB - always fetch from API
      if (!isMobileDevice()) {
        cachedFleetCloudData = [];
        
        if (cachedFleetCloudData.length > 0) {
          // Convert CloudDataEntry[] to array format
          // Map normalized metadata to all case variations for compatibility
          const cachedFormatted = cachedFleetCloudData.map(entry => ({
            ...entry.data,
            Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(entry.timestamp),
            event_id: entry.eventId?.toString() || '',
            dataset_id: entry.datasetId || '0',
            project_id: entry.projectId || '0',
            source_id: entry.sourceId || '0',
            Source_name: entry.metadata?.source_name || 'Unknown',
            source_name: entry.metadata?.source_name || 'Unknown',
            SOURCE_NAME: entry.metadata?.source_name || 'Unknown',
            // Race - provide all case variations
            RACE: entry.metadata?.race_number?.toString() || 'NONE',
            Race_number: entry.metadata?.race_number,
            race_number: entry.metadata?.race_number,
            // Leg - provide all case variations
            LEG: entry.metadata?.leg_number?.toString() || 'NONE',
            Leg_number: entry.metadata?.leg_number,
            leg_number: entry.metadata?.leg_number,
            // Grade - provide all case variations
            GRADE: entry.metadata?.grade?.toString() || null,
            Grade: entry.metadata?.grade,
            grade: entry.metadata?.grade,
            // State - provide all case variations
            State: entry.metadata?.state || null,
            state: entry.metadata?.state || null,
            STATE: entry.metadata?.state || null,
            // Config - provide all case variations
            CONFIG: entry.metadata?.config || 'NONE',
            Config: entry.metadata?.config || 'NONE',
            config: entry.metadata?.config || 'NONE',
            // Event - provide all case variations
            Event: entry.metadata?.event || 'NONE',
            event: entry.metadata?.event || 'NONE',
            EVENT: entry.metadata?.event || 'NONE',
            event_name: entry.metadata?.event || 'NONE',
            Event_name: entry.metadata?.event || 'NONE',
            EVENT_NAME: entry.metadata?.event || 'NONE',
            // Include normalized metadata for backward compatibility
            ...entry.metadata,
          }));
          
          const filteredCachedData = filterCacheByDateRange(cachedFormatted as any[], finalStartDate, finalEndDate);
          
          if (filteredCachedData && filteredCachedData.length > 0) {
            logDebug(`[FleetPerformanceDataService] Found ${filteredCachedData.length} cached fleet cloud points in HuniDB`);
            return filteredCachedData;
          }
        }
      }
      
      // Not in IndexedDB, fetch from API
      // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
      // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
      const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0 
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}` 
        : '';
      
      let url = '';
      if (Number(sourceId) > 0) {
        logDebug(`[FleetPerformanceDataService] No cached fleet data, fetching from shared-cloud-data API (agr_type=AVG, excluding source_id=${sourceId})`);
        url = `${apiEndpoints.app.data}/shared-cloud-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&table_name=events_aggregate&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=bin%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
      } else {
        logDebug(`[FleetPerformanceDataService] No cached fleet data, fetching from fleet-performance-data API (agr_type=AVG, source_id omitted)`);
        url = `${apiEndpoints.app.data}/fleet-performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
      }
      
      logDebug(`[FleetPerformanceDataService] Fetching fleet cloud data from API`, {
        url,
        className,
        projectId,
        sourceId,
        finalStartDate,
        finalEndDate,
        normalizedChannels,
        filtersParam
      });
      
      const response = await getData(url, controller.signal);
    
      if (!response.success) {
        logError("Fleet cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch fleet cloud data.");
      }
      
      let cloudData = response.data || [];
      
      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      // API has already filtered by YEAR, EVENT, CONFIG, SOURCE_NAME
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const hasActiveClientFilters = (
          (clientFilterConfig.grades && clientFilterConfig.grades.length > 0) ||
          (clientFilterConfig.raceNumbers && clientFilterConfig.raceNumbers.length > 0) ||
          (clientFilterConfig.legNumbers && clientFilterConfig.legNumbers.length > 0) ||
          (clientFilterConfig.states && clientFilterConfig.states.length > 0) ||
          (clientFilterConfig.twaStates && clientFilterConfig.twaStates.length > 0)
        );
        
        if (hasActiveClientFilters) {
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
            source_name: normalized.source_name, // This one is already lowercase
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
            logDebug(`[FleetPerformanceDataService] Applied client-side filters to Fleet Data: ${beforeCount} -> ${cloudData.length} points`);
          }
        }
      }
      
      // Store in HuniDB
      if (cloudData.length > 0) {
        logDebug(`[FleetPerformanceDataService] Converting and storing ${cloudData.length} fleet cloud points in HuniDB`, {
          className,
          projectId,
          sourceId: '0',
          cloudType: 'Fleet Data'
        });
        let cloudEntries: CloudDataEntry[] = [];
        try {
          // Import normalization utility
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          
          cloudEntries = cloudData.map((point: any) => {
            // Extract IDs from API response (use API values, fallback to defaults if missing)
            const pointDatasetId = point.dataset_id ? String(point.dataset_id) : '0';
            const pointProjectId = point.project_id ? String(point.project_id) : projectId;
            const pointSourceId = point.source_id ? String(point.source_id) : '0'; // Fleet data can have multiple sources
            
            // Single nomenclature: read tack from point (lowercase first)
            let tack = point.tack ?? point.TACK;
            if (!tack || tack === 'NONE') {
              const twa = point.Twa ?? point.twa;
              if (twa !== null && twa !== undefined && typeof twa === 'number') {
                tack = twa < 0 ? 'PORT' : 'STBD';
              }
            }
            
            // Exclude metadata fields from data object (lowercase keys only)
            const { event_id, dataset_id, source_id, project_id, Datetime, tack: _tack, race_number, leg_number, grade, config, year, event, source_name, state, ...channelData } = point;
            
            // Use normalization utility to extract and normalize metadata
            const normalizedMetadata = extractAndNormalizeMetadata(point);
            
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
                year: normalizedMetadata.Year ?? point.year ?? point.Year ?? undefined,
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
            
            logDebug(`[FleetPerformanceDataService] Storing ${cloudEntries.length} cloud entries in HuniDB`, {
              className,
              projectId,
              sourceId: '0',
              datasetId: cloudEntries[0]?.datasetId || '0',
              cloudType: 'Fleet Data',
              firstEntrySample: cloudEntries.length > 0 ? {
                id: cloudEntries[0].id,
                timestamp: cloudEntries[0].timestamp,
                eventId: cloudEntries[0].eventId,
                metadataKeys: Object.keys(cloudEntries[0].metadata || {}),
                dataKeys: Object.keys(cloudEntries[0].data || {})
              } : null
            });
            
            // Cloud data storage removed - cloud.data table no longer used
            logDebug(`[FleetPerformanceDataService] Skipping cloud data storage (deprecated) - ${cloudData.length} fleet points`);
          } else {
            logDebug(`[FleetPerformanceDataService] Skipping HuniDB storage on mobile device`);
          }
        } catch (error) {
          logError(`[FleetPerformanceDataService] Error storing fleet cloud data:`, error);
          logError(`[FleetPerformanceDataService] Storage error details:`, {
            className,
            projectId,
            cloudEntriesCount: cloudEntries?.length || 0,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
          });
        }
      } else {
        logDebug(`[FleetPerformanceDataService] Skipping HuniDB storage - no cloud data to store (cloudData.length = ${cloudData.length})`);
      }
      
      return cloudData;
    } else if (finalCloudType === 'Recent History') {
      // Recent History - 30 days prior to 1 day prior to selectedDate/latest_date
      // Use shared-cloud-data with agr_type=AVG, table_name=events_aggregate
      const dateSel = typeof selectedDate === 'function' ? selectedDate() : '';
      let finalStartDate: string;
      let finalEndDate: string;
      
      if (dateSel) {
        // Use selectedDate to calculate window
        const window = getRecentHistoryWindow(dateSel);
        finalStartDate = window.startDate;
        finalEndDate = window.endDate;
      } else {
        // Fall back to latest_date from source_id=0
        const resolved = await resolveDateRange();
        if (resolved.endDate) {
          const window = getRecentHistoryWindow(resolved.endDate);
          finalStartDate = window.startDate;
          finalEndDate = window.endDate;
        } else {
          finalStartDate = startDate || '';
          finalEndDate = endDate || '';
        }
      }
      
      logDebug(`[FleetPerformanceDataService] Recent History: Fetching from IndexedDB for ${className}, date range: ${finalStartDate} to ${finalEndDate}`);
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
      let cachedFleetCloudData: CloudDataEntry[] = [];
      if (!isMobileDevice()) {
        cachedFleetCloudData = []; // Cloud data no longer cached in HuniDB
        
        if (cachedFleetCloudData.length > 0) {
          // Convert CloudDataEntry[] to array format
          // Map normalized metadata to all case variations for compatibility
          const cachedFormatted = cachedFleetCloudData.map(entry => ({
            ...entry.data,
            Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(entry.timestamp),
            event_id: entry.eventId?.toString() || '',
            dataset_id: entry.datasetId || '0',
            project_id: entry.projectId || '0',
            source_id: entry.sourceId || '0',
            Source_name: entry.metadata?.source_name || 'Unknown',
            source_name: entry.metadata?.source_name || 'Unknown',
            SOURCE_NAME: entry.metadata?.source_name || 'Unknown',
            // Race - provide all case variations
            RACE: entry.metadata?.race_number?.toString() || 'NONE',
            Race_number: entry.metadata?.race_number,
            race_number: entry.metadata?.race_number,
            // Leg - provide all case variations
            LEG: entry.metadata?.leg_number?.toString() || 'NONE',
            Leg_number: entry.metadata?.leg_number,
            leg_number: entry.metadata?.leg_number,
            // Grade - provide all case variations
            GRADE: entry.metadata?.grade?.toString() || null,
            Grade: entry.metadata?.grade,
            grade: entry.metadata?.grade,
            // State - provide all case variations
            State: entry.metadata?.state || null,
            state: entry.metadata?.state || null,
            STATE: entry.metadata?.state || null,
            // Config - provide all case variations
            CONFIG: entry.metadata?.config || 'NONE',
            Config: entry.metadata?.config || 'NONE',
            config: entry.metadata?.config || 'NONE',
            // Event - provide all case variations
            Event: entry.metadata?.event || 'NONE',
            event: entry.metadata?.event || 'NONE',
            EVENT: entry.metadata?.event || 'NONE',
            event_name: entry.metadata?.event || 'NONE',
            Event_name: entry.metadata?.event || 'NONE',
            EVENT_NAME: entry.metadata?.event || 'NONE',
            // Include normalized metadata for backward compatibility
            ...entry.metadata,
          }));
          
          // Filter cached data by date range (30 days prior to 1 day prior)
          let filteredCachedData = filterCacheByDateRange(cachedFormatted as any[], finalStartDate, finalEndDate);
          // Extra safeguard: explicitly exclude any points from the selectedDate if present
          if (dateSel) {
            const selStart = new Date(dateSel);
            selStart.setHours(0, 0, 0, 0);
            const selEnd = new Date(dateSel);
            selEnd.setHours(23, 59, 59, 999);
            const selStartMs = selStart.getTime();
            const selEndMs = selEnd.getTime();
            filteredCachedData = filteredCachedData.filter(p => {
              if (!p.Datetime) return true;
              const t = new Date(p.Datetime).getTime();
              return !(t >= selStartMs && t <= selEndMs);
            });
          }
          
          if (filteredCachedData && filteredCachedData.length > 0) {
            logDebug(`[FleetPerformanceDataService] Found ${filteredCachedData.length} cached recent history fleet cloud points in HuniDB`);
            return filteredCachedData;
          }
        }
      }
      
      // Not in IndexedDB, fetch from API
      // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
      // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
      const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0 
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}` 
        : '';
      
      let url = '';
      if (Number(sourceId) > 0) {
        logDebug(`[FleetPerformanceDataService] No cached recent history data, fetching from shared-cloud-data API (agr_type=AVG, excluding source_id=${sourceId}, ${finalStartDate} to ${finalEndDate})`);
        url = `${apiEndpoints.app.data}/shared-cloud-data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&source_id=${encodeURIComponent(sourceId)}&table_name=events_aggregate&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=bin%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
      } else {
        logDebug(`[FleetPerformanceDataService] No cached recent history data, fetching from fleet-performance-data API (agr_type=AVG, ${finalStartDate} to ${finalEndDate})`);
        url = `${apiEndpoints.app.data}/fleet-performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=BIN%2010&agr_type=AVG&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
      }
      
      const response = await getData(url, controller.signal);
    
      if (!response.success) {
        logError("Recent history fleet cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch recent history fleet cloud data.");
      }
      
      let cloudData = response.data || [];
      // Extra safeguard: explicitly exclude any points from the selectedDate if present
      if (dateSel) {
        const selStart = new Date(dateSel);
        selStart.setHours(0, 0, 0, 0);
        const selEnd = new Date(dateSel);
        selEnd.setHours(23, 59, 59, 999);
        const selStartMs = selStart.getTime();
        const selEndMs = selEnd.getTime();
        cloudData = cloudData.filter((p: any) => {
          if (!p.Datetime) return true;
          const t = new Date(p.Datetime).getTime();
          return !(t >= selStartMs && t <= selEndMs);
        });
      }
      
      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      // API has already filtered by YEAR, EVENT, CONFIG, SOURCE_NAME
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const hasActiveClientFilters = (
          (clientFilterConfig.grades && clientFilterConfig.grades.length > 0) ||
          (clientFilterConfig.raceNumbers && clientFilterConfig.raceNumbers.length > 0) ||
          (clientFilterConfig.legNumbers && clientFilterConfig.legNumbers.length > 0) ||
          (clientFilterConfig.states && clientFilterConfig.states.length > 0) ||
          (clientFilterConfig.twaStates && clientFilterConfig.twaStates.length > 0)
        );
        
        if (hasActiveClientFilters) {
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
            source_name: normalized.source_name, // This one is already lowercase
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
            logDebug(`[FleetPerformanceDataService] Applied client-side filters to Recent History: ${beforeCount} -> ${cloudData.length} points`);
          }
        }
      }
      
      logDebug(`[FleetPerformanceDataService] Fetched ${cloudData.length} recent history fleet cloud records`);
      
      // Store in HuniDB
      if (cloudData.length > 0) {
        logDebug(`[FleetPerformanceDataService] Converting and storing ${cloudData.length} recent history fleet cloud points in HuniDB`);
        try {
          // Import normalization utility
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          
          const cloudEntries: CloudDataEntry[] = cloudData.map((point: any) => {
            // Extract IDs from API response (use API values, fallback to defaults if missing)
            const pointDatasetId = point.dataset_id ? String(point.dataset_id) : '0';
            const pointProjectId = point.project_id ? String(point.project_id) : projectId;
            const pointSourceId = point.source_id ? String(point.source_id) : '0'; // Fleet data can have multiple sources
            
            // Single nomenclature: read tack from point (lowercase first)
            let tack = point.tack ?? point.TACK;
            if (!tack || tack === 'NONE') {
              const twa = point.Twa ?? point.twa;
              if (twa !== null && twa !== undefined && typeof twa === 'number') {
                tack = twa < 0 ? 'PORT' : 'STBD';
              }
            }
            
            // Exclude metadata fields from data object (lowercase keys only)
            const { event_id, dataset_id, source_id, project_id, Datetime, tack: _tack, race_number, leg_number, grade, config, year, event, source_name, state, ...channelData } = point;
            
            // Use normalization utility to extract and normalize metadata
            const normalizedMetadata = extractAndNormalizeMetadata(point);
            
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
                year: normalizedMetadata.Year ?? point.year ?? point.Year ?? undefined,
              },
              data: channelData, // Channel values only (excludes metadata fields)
            };
          });
          
          // Build applied filters for cache metadata
          const appliedFilters: FilterSet = {
            states: filters?.STATE || [],
            events: filters?.EVENT || [],
            configs: filters?.CONFIG || [],
            grades: filters?.GRADE || [],
            raceNumbers: filters?.RACE || [],
            legNumbers: filters?.LEG || [],
            dateRange: finalStartDate && finalEndDate ? { start: finalStartDate, end: finalEndDate } : undefined
          };
          
          // Cloud data storage removed - cloud.data table no longer used
          logDebug(`[FleetPerformanceDataService] Skipping cloud data storage (deprecated) - ${cloudData.length} recent history fleet points`);
        } catch (error) {
          logError(`[FleetPerformanceDataService] Error storing recent history fleet cloud data:`, error);
        }
      }
      
      return cloudData;
    } else {
      // Default: Latest / 1Hz Scatter - use fleet-performance-data endpoint with agr_type=NONE (events_cloud)
      // start_date == end_date (same date)
      const dateSel = typeof selectedDate === 'function' ? selectedDate() : '';
      let finalStartDate: string;
      let finalEndDate: string;
      
      if (dateSel) {
        // Use selectedDate for 1Hz (same start and end)
        // Strip quotes from dateSel if it exists
        const cleanDateSel = String(dateSel).replace(/^["']|["']$/g, '');
        const oneHzDates = getOneHzDate(cleanDateSel);
        finalStartDate = oneHzDates.startDate;
        finalEndDate = oneHzDates.endDate;
      } else if (startDate && endDate) {
        // Use provided dates, but ensure they're the same for 1Hz
        // Strip quotes from dates if they exist
        finalStartDate = String(startDate).replace(/^["']|["']$/g, '');
        finalEndDate = String(endDate).replace(/^["']|["']$/g, '');
        if (finalStartDate !== finalEndDate) {
          // If different, use endDate as the single date
          const oneHzDates = getOneHzDate(finalEndDate);
          finalStartDate = oneHzDates.startDate;
          finalEndDate = oneHzDates.endDate;
        }
      } else {
        // Resolve from latest_date
        const r = await resolveDateRange();
        if (r.startDate && r.endDate) {
          // Use endDate as the single date for 1Hz
          // Strip quotes from dates if they exist
          const cleanEndDate = String(r.endDate).replace(/^["']|["']$/g, '');
          const oneHzDates = getOneHzDate(cleanEndDate);
          finalStartDate = oneHzDates.startDate;
          finalEndDate = oneHzDates.endDate;
        } else {
          finalStartDate = r.startDate;
          finalEndDate = r.endDate;
        }
      }
      
      logDebug(`[FleetPerformanceDataService] Latest/1Hz: Fetching from IndexedDB for ${className}, exact date: ${finalStartDate}`);
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
      let cachedFleetCloudData: CloudDataEntry[] = [];
      if (!isMobileDevice()) {
        cachedFleetCloudData = []; // Cloud data no longer cached in HuniDB
        
        if (cachedFleetCloudData.length > 0) {
          // Convert CloudDataEntry[] to array format
          // Map normalized metadata to all case variations for compatibility
          const cachedFormatted = cachedFleetCloudData.map(entry => ({
            ...entry.data,
            Datetime: entry.metadata?.datetime ? new Date(entry.metadata.datetime) : new Date(entry.timestamp),
            event_id: entry.eventId?.toString() || '',
            dataset_id: entry.datasetId || '0',
            project_id: entry.projectId || '0',
            source_id: entry.sourceId || '0',
            Source_name: entry.metadata?.source_name || 'Unknown',
            source_name: entry.metadata?.source_name || 'Unknown',
            SOURCE_NAME: entry.metadata?.source_name || 'Unknown',
            // Race - provide all case variations
            RACE: entry.metadata?.race_number?.toString() || 'NONE',
            Race_number: entry.metadata?.race_number,
            race_number: entry.metadata?.race_number,
            // Leg - provide all case variations
            LEG: entry.metadata?.leg_number?.toString() || 'NONE',
            Leg_number: entry.metadata?.leg_number,
            leg_number: entry.metadata?.leg_number,
            // Grade - provide all case variations
            GRADE: entry.metadata?.grade?.toString() || null,
            Grade: entry.metadata?.grade,
            grade: entry.metadata?.grade,
            // State - provide all case variations
            State: entry.metadata?.state || null,
            state: entry.metadata?.state || null,
            STATE: entry.metadata?.state || null,
            // Config - provide all case variations
            CONFIG: entry.metadata?.config || 'NONE',
            Config: entry.metadata?.config || 'NONE',
            config: entry.metadata?.config || 'NONE',
            // Event - provide all case variations
            Event: entry.metadata?.event || 'NONE',
            event: entry.metadata?.event || 'NONE',
            EVENT: entry.metadata?.event || 'NONE',
            event_name: entry.metadata?.event || 'NONE',
            Event_name: entry.metadata?.event || 'NONE',
            EVENT_NAME: entry.metadata?.event || 'NONE',
            // Include normalized metadata for backward compatibility
            ...entry.metadata,
          }));
          
          // Filter cached data by exact date (1Hz data should match exact date)
          const filteredCachedData = filterCacheByExactDate(cachedFormatted as any[], finalStartDate);
          
          if (filteredCachedData && filteredCachedData.length > 0) {
            logDebug(`[FleetPerformanceDataService] Found ${filteredCachedData.length} cached 1Hz fleet cloud points in HuniDB`);
            return filteredCachedData;
          }
        }
      }
      
      // Not in IndexedDB, fetch from fleet-performance-data API with agr_type=NONE
      logDebug(`[FleetPerformanceDataService] No cached data, fetching 1Hz cloud data from fleet-performance-data API (agr_type=NONE, date: ${finalStartDate})`);
      
      // Build filters object for API - only pass API filters (YEAR, EVENT, CONFIG, SOURCE_NAME, optionally GRADE)
      // Client filters (STATE, RACE, LEG, GRADE if client-side) are applied after data retrieval
      const apiFiltersForRequest = Object.keys(apiFilters).length > 0 ? apiFilters : undefined;
      const filtersParam = apiFiltersForRequest && Object.keys(apiFiltersForRequest).length > 0 
        ? `&filters=${encodeURIComponent(JSON.stringify(apiFiltersForRequest))}` 
        : '';
      
      const url = `${apiEndpoints.app.data}/fleet-performance-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=0&start_date=${encodeURIComponent(finalStartDate)}&end_date=${encodeURIComponent(finalEndDate)}&event_type=BIN%2010&agr_type=NONE&channels=${encodeURIComponent(JSON.stringify(normalizedChannels))}${filtersParam}`;
      
      const response = await getData(url, controller.signal);
    
      if (!response.success) {
        logError("Cloud data fetch failed:", response as any);
        throw new Error("Failed to fetch cloud data.");
      }
      
      let cloudData = response.data || [];
      logDebug(`[FleetPerformanceDataService] Fetched ${cloudData.length} 1Hz cloud records`);
      
      // Apply client-side filters (STATE, RACE, LEG, GRADE if client-side)
      // API has already filtered by YEAR, EVENT, CONFIG, SOURCE_NAME
      if (cloudData.length > 0 && clientFilterConfig && Object.keys(clientFilterConfig).length > 0) {
        const hasActiveClientFilters = (
          (clientFilterConfig.grades && clientFilterConfig.grades.length > 0) ||
          (clientFilterConfig.raceNumbers && clientFilterConfig.raceNumbers.length > 0) ||
          (clientFilterConfig.legNumbers && clientFilterConfig.legNumbers.length > 0) ||
          (clientFilterConfig.states && clientFilterConfig.states.length > 0) ||
          (clientFilterConfig.twaStates && clientFilterConfig.twaStates.length > 0)
        );
        
        if (hasActiveClientFilters) {
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
            source_name: normalized.source_name, // This one is already lowercase
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
            logDebug(`[FleetPerformanceDataService] Applied client-side filters to 1Hz data: ${beforeCount} -> ${cloudData.length} points`);
          }
        }
      }
      
      // Store in HuniDB
      if (cloudData.length > 0) {
        logDebug(`[FleetPerformanceDataService] Converting and storing ${cloudData.length} 1Hz fleet cloud points in HuniDB`);
        try {
          // Import normalization utility
          const { extractAndNormalizeMetadata } = await import('../utils/dataNormalization');
          
          const cloudEntries: CloudDataEntry[] = cloudData.map((point: any) => {
            // Extract IDs from API response (use API values, fallback to defaults if missing)
            const pointDatasetId = point.dataset_id ? String(point.dataset_id) : '0';
            const pointProjectId = point.project_id ? String(point.project_id) : projectId;
            const pointSourceId = point.source_id ? String(point.source_id) : '0'; // Fleet data can have multiple sources
            
            // Single nomenclature: read tack from point (lowercase first)
            let tack = point.tack ?? point.TACK;
            if (!tack || tack === 'NONE') {
              const twa = point.Twa ?? point.twa;
              if (twa !== null && twa !== undefined && typeof twa === 'number') {
                tack = twa < 0 ? 'PORT' : 'STBD';
              }
            }
            
            // Exclude metadata fields from data object (lowercase keys only)
            const { event_id, dataset_id, source_id, project_id, Datetime, tack: _tack, race_number, leg_number, grade, config, year, event, source_name, state, ...channelData } = point;
            
            // Use normalization utility to extract and normalize metadata
            const normalizedMetadata = extractAndNormalizeMetadata(point);
            
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
                year: normalizedMetadata.Year ?? point.year ?? point.Year ?? undefined,
              },
              data: channelData, // Channel values only (excludes metadata fields)
            };
          });
          
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
          logDebug(`[FleetPerformanceDataService] Skipping cloud data storage (deprecated) - ${cloudData.length} 1Hz fleet points`);
        } catch (error) {
          logError(`[FleetPerformanceDataService] Error storing 1Hz fleet cloud data:`, error);
        }
      }
      
      return cloudData;
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return [];
    }
    logError("Error fetching cloud data:", error as any);
    throw error;
  }
};

// Fetch target data (same as performance service)
const fetchTargets = async (): Promise<any> => {
  const controller = new AbortController();
  
  try {
    logDebug(`[FleetPerformanceDataService] Fetching targets from API`);
    const response = await getData(
      `${apiEndpoints.app.targets}/latest?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&isPolar=0`, 
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
    
    return targetData;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { name: '', data: {} };
    }
    logError("Error fetching targets:", error as any);
    return { name: '', data: {} };
  }
};

// Extract required channels from chart objects
const getRequiredChannels = (chartObjects: any[]): string[] => {
  // Use defaultChannelsStore for channel names
  const { twaName, twsName, bspName } = defaultChannelsStore;
  
  let channels = ["Datetime", twaName(), twsName(), bspName()];
  
  
  if (chartObjects && chartObjects.length > 0) {
    chartObjects.forEach(chartObject => {
      if (chartObject.charts && chartObject.charts[0] && chartObject.charts[0].series) {
        chartObject.charts[0].series.forEach((chart: any) => {
          if (chart.yaxis && chart.yaxis.name) {
            channels.push(chart.yaxis.name);
          }
        });
      }
    });
  }

  const uniqueChannels = [...new Set(channels)];
  
  // Ensure we have at least the basic channels
  if (uniqueChannels.length === 0) {
    logWarn("No channels found, using fallback channels");
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

// Process and validate fleet performance data
const processFleetPerformanceData = (
  aggregates: any[], 
  cloud: any[], 
  targets: any
) => {
  // Get channel names from defaultChannelsStore
  const { twaName, twsName, bspName } = defaultChannelsStore;
  const twaField = twaName();
  const twsField = twsName();
  const bspField = bspName();

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
    // Support both: (1) lowercase from HuniDB/cache, (2) fleet API shape from extractAndNormalizeMetadata (Grade, Race_number, Source_name, etc.)
    const sourceName = item.source_name ?? item.Source_name ?? item.SOURCE_NAME ?? item.metadata?.source_name ?? 'Unknown';

    const twaValue = getChannelValueSimplified(item, twaField) ?? 0;
    const twsValue = getChannelValueSimplified(item, twsField) ?? 0;
    const bspValue = getChannelValueSimplified(item, bspField) ?? 0;

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

    const tackValue = item.tack ?? item.Tack ?? item.TACK ?? (twaValue < 0 ? 'PORT' : 'STBD');
    const rawDatetime = item.Datetime ?? item.datetime ?? '';
    const tz = (item.timezone ?? item.Timezone ?? '').trim() || undefined;
    let dateStringLocal: string | undefined = item.dateStringLocal;
    let timeStringLocal: string | undefined = item.timeStringLocal;
    if ((dateStringLocal == null || timeStringLocal == null) && rawDatetime && tz) {
      try {
        const date = typeof rawDatetime === 'string' ? new Date(rawDatetime.replace(' ', 'T')) : new Date(rawDatetime);
        if (!isNaN(date.getTime())) {
          dateStringLocal = dateStringLocal ?? formatDate(date, tz) ?? undefined;
          timeStringLocal = timeStringLocal ?? formatTime(date, tz) ?? undefined;
        }
      } catch {
        // leave undefined, chart will fall back to formatting Datetime
      }
    }
    const baseObject: any = {
      // Ensure all required fields exist with defaults
      event_id: item.event_id || '',
      source_name: sourceName,
      Datetime: rawDatetime,
      dateStringLocal,
      timeStringLocal,
      Twa: twaValue,
      Tws: twsValue,
      Bsp: bspValue,
      // CRITICAL: Also add fields using default channel names for compatibility
      [twaField]: twaValue,
      [twsField]: twsValue,
      [bspField]: bspValue,
      // Lowercase fields for filtering (matches unifiedDataStore normalization)
      tack: tackValue,
      race_number: race,
      leg_number: leg,
      grade: grade,
      config: config,
      year: year,
      event: event,
      state: state
    };

    // CRITICAL: Preserve ALL numeric fields from the original item, including suffixed fields
    // (e.g., Bsp_kts_std, Bsp_kts_aav, and ALL channel variations like Bsp_kts, Tws_kts, etc.)
    // These suffixed fields are NOT in the default mapping but are needed for STD/AAV charts
    // and all channel variations are needed for proper unit display
    Object.keys(item).forEach(key => {
      // Skip metadata fields that are already handled above
      const skipFields = [
        'event_id', 'Datetime', 'dataset_id', 'project_id', 'source_id', 'source_name', 'datetime',
        'TACK', 'RACE', 'LEG', 'GRADE', 'CONFIG', 'YEAR', 'EVENT', 'State', 'STATE',
        'tack', 'race_number', 'leg_number', 'grade', 'config', 'year', 'event',
        'Race_number', 'Leg_number', 'Grade', 'Config', 'Year', 'Event',
        'metadata', 'Twa', 'Tws', 'Bsp' // These are handled above with proper mapping
      ];
      
      // Only copy numeric fields and fields with aggregate suffixes (_std, _aav, etc.)
      const isNumeric = typeof item[key] === 'number' && !isNaN(item[key]);
      const hasAggregateSuffix = /_(std|aav|avg|min|max)$/i.test(key);
      
      if (!skipFields.includes(key) && (isNumeric || hasAggregateSuffix)) {
        // Preserve the field as-is (including suffixed fields like Bsp_kts_std and channel variations like Bsp_kts, Tws_kts)
        if (!baseObject.hasOwnProperty(key)) {
          baseObject[key] = item[key];
        }
      }
    });

    return baseObject;
  });

  const processedCloud = (cloud && Array.isArray(cloud) && cloud.length > 0)
    ? cloud.map(item => {
        const sourceName = item.source_name ?? item.Source_name ?? item.SOURCE_NAME ?? item.metadata?.source_name ?? 'Unknown';

        const twaValue = getChannelValueSimplified(item, twaField) ?? 0;
        const twsValue = getChannelValueSimplified(item, twsField) ?? 0;
        const bspValue = getChannelValueSimplified(item, bspField) ?? 0;

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

        const tackValue = item.tack ?? item.Tack ?? item.TACK ?? (twaValue < 0 ? 'PORT' : 'STBD');
        const rawDatetimeCloud = item.Datetime ?? item.datetime ?? '';
        const tzCloud = (item.timezone ?? item.Timezone ?? '').trim() || undefined;
        let dateStringLocalCloud: string | undefined = item.dateStringLocal;
        let timeStringLocalCloud: string | undefined = item.timeStringLocal;
        if ((dateStringLocalCloud == null || timeStringLocalCloud == null) && rawDatetimeCloud && tzCloud) {
          try {
            const dateCloud = typeof rawDatetimeCloud === 'string' ? new Date(rawDatetimeCloud.replace(' ', 'T')) : new Date(rawDatetimeCloud);
            if (!isNaN(dateCloud.getTime())) {
              dateStringLocalCloud = dateStringLocalCloud ?? formatDate(dateCloud, tzCloud) ?? undefined;
              timeStringLocalCloud = timeStringLocalCloud ?? formatTime(dateCloud, tzCloud) ?? undefined;
            }
          } catch {
            // leave undefined
          }
        }
        const baseObject: any = {
          // Ensure all required fields exist with defaults
          event_id: item.event_id || '',
          source_name: sourceName,
          Datetime: rawDatetimeCloud,
          dateStringLocal: dateStringLocalCloud,
          timeStringLocal: timeStringLocalCloud,
          Twa: twaValue,
          Tws: twsValue,
          Bsp: bspValue,
          // CRITICAL: Also add fields using default channel names for compatibility
          // These are needed for FleetScatter and other components that expect these field names
          [twaField]: twaValue,
          [twsField]: twsValue,
          [bspField]: bspValue,
          tack: tackValue,
          race_number: race,
          leg_number: leg,
          grade: grade,
          config: config,
          year: year,
          event: event,
          state: state
        };

        // CRITICAL: Preserve ALL numeric fields from the original item
        // This includes all channel variations (e.g., Bsp_kts, Tws_kts, etc.) needed for proper unit display
        Object.keys(item).forEach(key => {
          // Skip metadata fields that are already handled above
          const skipFields = [
            'event_id', 'Datetime', 'dataset_id', 'project_id', 'source_id', 'source_name', 'datetime',
            'TACK', 'RACE', 'LEG', 'GRADE', 'CONFIG', 'YEAR', 'EVENT', 'State', 'STATE',
            'tack', 'race_number', 'leg_number', 'grade', 'config', 'year', 'event',
            'Race_number', 'Leg_number', 'Grade', 'Config', 'Year', 'Event',
            'metadata', 'Twa', 'Tws', 'Bsp' // These are handled above with proper mapping
          ];
          
          // Only copy numeric fields
          const isNumeric = typeof item[key] === 'number' && !isNaN(item[key]);
          
          if (!skipFields.includes(key) && isNumeric) {
            // Preserve the field as-is (including all channel variations like Bsp_kts, Tws_kts)
            if (!baseObject.hasOwnProperty(key)) {
              baseObject[key] = item[key];
            }
          }
        });

        return baseObject;
      })
    : [];


  return {
    aggregates: processedAggregates,
    cloud: processedCloud,
    targets
  };
};

// Create the service object
export const fleetPerformanceDataService: FleetPerformanceDataService = {
  fetchCharts,
  fetchAggregates,
  getAggregateTypeMapping: (chartObjects: any[]) => getAggregateTypeMapping(chartObjects),
  fetchAggregatesByType,
  fetchCloud,
  fetchTargets,
  getRequiredChannels,
  enrichWithLocalTimeStrings,
  processFleetPerformanceData
};

export default fleetPerformanceDataService;

