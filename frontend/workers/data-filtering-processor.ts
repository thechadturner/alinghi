/**
 * Data Filtering Processor Worker
 * 
 * Handles data filtering operations including:
 * - Array filtering by time ranges
 * - TWA filtering
 * - Data mapping and transformation
 * - Large dataset processing
 * - Event ID assignment based on selectedEvents time ranges
 */

import type { 
  WorkerMessage, 
  WorkerResponse, 
  FilterableDataItem,
  DataFilteringResult,
  DataFilteringConfig
} from './types';
import { passesBasicFilters, createFilterConfig, getTimestamp as getTimestampCore } from '../utils/filterCore';

interface DataFilteringMessage extends WorkerMessage {
  type: 'PROCESS_DATA_FILTERING';
  data: FilterableDataItem[];
  config: DataFilteringConfig;
  selectedEvents?: Array<{
    event_id: number;
    event_type: string;
    start_time: string;
    end_time: string;
    tags: any;
  }>;
  eventTimeRanges?: Record<number, { starttime: string; endtime: string }>;
}

interface DataFilteringResponse extends WorkerResponse<DataFilteringResult> {
  id: string;
  type: 'success' | 'error';
  result?: DataFilteringResult;
  error?: string;
  duration: number;
}

// Worker message handler
self.onmessage = (event: MessageEvent<DataFilteringMessage>) => {
  const { id, type, data, config, selectedEvents, eventTimeRanges } = event.data;
  
  if (type === 'PROCESS_DATA_FILTERING') {
    try {
      const startTime = performance.now();
      const result = processDataFiltering(data, config, selectedEvents, eventTimeRanges);
      const endTime = performance.now();
      
      const response: DataFilteringResponse = {
        id,
        type: 'success',
        result,
        duration: endTime - startTime
      };
      
      self.postMessage(response);
    } catch (error) {
      const endTime = performance.now();
      
      const response: DataFilteringResponse = {
        id,
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        result: {
          data: [],
          originalCount: 0,
          filteredCount: 0,
          processingTime: 0
        },
        duration: endTime - performance.now()
      };
      
      self.postMessage(response);
    }
  }
};

/**
 * Get timestamp from data point (use unified core)
 */
function getTimestamp(d: FilterableDataItem): number {
  return getTimestampCore(d);
}

/**
 * Apply TWA filtering (simplified using filter core)
 */
function filterByTwa(
  data: FilterableDataItem[], 
  states: string[], 
  races: any[], 
  legs: any[], 
  grades: any[]
): FilterableDataItem[] {
  if (!data || data.length === 0) return data;
  
  // Use unified filter core for consistency
  const filterConfig = createFilterConfig(states, races, legs, grades);
  
  return data.filter(item => {
    return passesBasicFilters(item, filterConfig);
  });
}

// assignEventIdsToData function removed - event_id assignment no longer needed
// Using selectedRanges for timestamp comparison instead

/**
 * Process data filtering operations
 */
function processDataFiltering(
  data: FilterableDataItem[], 
  config: DataFilteringConfig,
  selectedEvents?: Array<{
    event_id: number;
    event_type: string;
    start_time: string;
    end_time: string;
    tags: any;
  }>,
  eventTimeRanges?: Record<number, { starttime: string; endtime: string }>
): DataFilteringResult {
  const startTime = performance.now();
  
  const {
    timeRange,
    twaFilters,
    mapOperation = false,
    eventIdField = 'event_id'
  } = config;

  if (!Array.isArray(data)) {
    throw new Error('Data filtering input must be an array');
  }

  let filteredData = [...data];
  const originalCount = data.length;

  // Apply TWA filtering
  if (twaFilters && (twaFilters.states.length > 0 || twaFilters.races.length > 0 || twaFilters.legs.length > 0 || twaFilters.grades.length > 0)) {
    filteredData = filterByTwa(
      filteredData,
      twaFilters.states,
      twaFilters.races,
      twaFilters.legs,
      twaFilters.grades
    );
  }

  // Apply time range filtering
  if (timeRange && timeRange.startTime && timeRange.endTime) {
    const startTime = new Date(timeRange.startTime).getTime();
    const endTime = new Date(timeRange.endTime).getTime();
    
    filteredData = filteredData.filter(d => {
      const timestamp = getTimestamp(d);
      return timestamp >= startTime && timestamp <= endTime;
    });
  }

  // Apply event ID assignment if specified
  if (mapOperation) {
    // Event ID assignment removed - using selectedRanges for timestamp comparison instead
    // No need to assign event_id to data points
  }

  const endTime = performance.now();
  const processingTime = endTime - startTime;

  return {
    data: filteredData,
    originalCount,
    filteredCount: filteredData.length,
    processingTime
  };
}

// Export types for use in main thread
export type { FilterableDataItem, DataFilteringResult, DataFilteringConfig };
