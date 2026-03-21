/**
 * TimeSeries Data Processor Worker
 * 
 * Handles time series chart data processing including:
 * - Time-based data binning and aggregation
 * - Data smoothing and interpolation
 * - Time range filtering
 * - Statistical calculations for time series
 */

import { log } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  DataItem
} from './types';
import { error as logError } from '../utils/console';

interface TimeSeriesConfig {
  timeField?: string;
  valueField?: string;
  timeInterval?: string; // '1m', '5m', '1h', '1d', etc.
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
  smooth?: boolean;
  interpolate?: boolean;
  timeRange?: {
    startTime: string | Date;
    endTime: string | Date;
  };
}

interface TimeSeriesResult {
  data: any[];
  timeRange: { min: number; max: number };
  valueRange: { min: number; max: number };
  processedCount: number;
  validDataCount: number;
  aggregation: string;
  timeInterval: string;
}

interface TimeSeriesMessage extends WorkerMessage {
  type: 'PROCESS_TIMESERIES_DATA';
  data: DataItem[];
  config: TimeSeriesConfig;
}

interface TimeSeriesResponse extends WorkerResponse {
  id: string;
  type: 'TIMESERIES_DATA_PROCESSED';
  result: TimeSeriesResult;
}

// Worker message handler
self.onmessage = (event: MessageEvent<TimeSeriesMessage>) => {
  const { id, type, data, config } = event.data;
  
  if (type === 'PROCESS_TIMESERIES_DATA') {
    log(`TimeSeries worker received data processing request with ID: ${id}, data points: ${data.length}`);
    const startTime = performance.now();
    
    try {
      const result = processTimeSeriesData(data, config);
      const processingTime = performance.now() - startTime;
      
      log(`TimeSeries worker completed data processing in ${processingTime.toFixed(2)}ms for ID: ${id}`);
      
      const response: TimeSeriesResponse = {
        id,
        type: 'TIMESERIES_DATA_PROCESSED',
        success: true,
        result
      };
      
      self.postMessage(response);
    } catch (error) {
      const processingTime = performance.now() - startTime;
      logError(`TimeSeries worker error in data processing after ${processingTime.toFixed(2)}ms for ID: ${id}:`, error);
      
      const response: TimeSeriesResponse = {
        id,
        type: 'TIMESERIES_DATA_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        result: {
          data: [],
          timeRange: { min: 0, max: 0 },
          valueRange: { min: 0, max: 0 },
          processedCount: 0,
          validDataCount: 0,
          aggregation: 'none',
          timeInterval: 'none'
        }
      };
      
      self.postMessage(response);
    }
  }
};

/**
 * Process time series data
 */
function processTimeSeriesData(data: DataItem[], config: TimeSeriesConfig): TimeSeriesResult {
  const {
    timeField = 'Datetime',
    valueField = 'value',
    timeInterval = '1m',
    aggregation = 'avg',
    smooth = false,
    interpolate = false,
    timeRange
  } = config;

  if (!Array.isArray(data)) {
    throw new Error('TimeSeries data must be an array');
  }

  // Filter by time range if specified
  let filteredData = data;
  if (timeRange) {
    const startTime = new Date(timeRange.startTime);
    const endTime = new Date(timeRange.endTime);
    
    filteredData = data.filter(item => {
      const timestamp = getTimestamp(item, timeField);
      if (!timestamp) return false;
      return timestamp >= startTime && timestamp <= endTime;
    });
  }

  // Sort by time
  filteredData.sort((a, b) => {
    const timeA = getTimestamp(a, timeField);
    const timeB = getTimestamp(b, timeField);
    if (!timeA || !timeB) return 0;
    return timeA.getTime() - timeB.getTime();
  });

  let processedData = filteredData;
  let validDataCount = 0;

  // Count valid data points
  filteredData.forEach(item => {
    const timestamp = getTimestamp(item, timeField);
    const value = item[valueField];
    if (timestamp && value !== undefined && value !== null && !isNaN(Number(value))) {
      validDataCount++;
    }
  });

  // Apply time-based aggregation if specified
  if (timeInterval !== 'none' && aggregation !== 'none') {
    processedData = aggregateByTimeInterval(filteredData, timeField, valueField, timeInterval, aggregation);
  }

  // Apply smoothing if requested
  if (smooth && processedData.length > 2) {
    processedData = smoothData(processedData, valueField);
  }

  // Apply interpolation if requested
  if (interpolate && processedData.length > 2) {
    processedData = interpolateData(processedData, timeField, valueField);
  }

  // Calculate ranges
  const timeValues = processedData.map(item => {
    const timestamp = getTimestamp(item, timeField);
    return timestamp ? timestamp.getTime() : 0;
  }).filter(val => val > 0);

  const valueValues = processedData.map(item => Number(item[valueField]))
    .filter(val => !isNaN(val));

  const timeRange_result = timeValues.length > 0 
    ? { min: Math.min(...timeValues), max: Math.max(...timeValues) }
    : { min: 0, max: 0 };

  const valueRange_result = valueValues.length > 0
    ? { min: Math.min(...valueValues), max: Math.max(...valueValues) }
    : { min: 0, max: 0 };

  return {
    data: processedData,
    timeRange: timeRange_result,
    valueRange: valueRange_result,
    processedCount: processedData.length,
    validDataCount,
    aggregation,
    timeInterval
  };
}

/**
 * Get timestamp from data point
 */
function getTimestamp(item: DataItem, timeField: string): Date | null {
  const timestamp = item[timeField] || item.timestamp || item.datetime || item.time;
  if (!timestamp) return null;
  
  if (timestamp instanceof Date) return timestamp;
  return new Date(timestamp);
}

/**
 * Aggregate data by time interval
 */
function aggregateByTimeInterval(
  data: DataItem[], 
  timeField: string, 
  valueField: string, 
  interval: string, 
  aggregation: string
): DataItem[] {
  const intervalMs = parseTimeInterval(interval);
  if (intervalMs === 0) return data;

  const bins = new Map<number, DataItem[]>();
  
  // Group data into time bins
  data.forEach(item => {
    const timestamp = getTimestamp(item, timeField);
    if (!timestamp) return;
    
    const binTime = Math.floor(timestamp.getTime() / intervalMs) * intervalMs;
    
    if (!bins.has(binTime)) {
      bins.set(binTime, []);
    }
    bins.get(binTime)!.push(item);
  });

  // Aggregate each bin
  const result: DataItem[] = [];
  bins.forEach((items, binTime) => {
    const values = items.map(item => Number(item[valueField]))
      .filter(val => !isNaN(val));
    
    if (values.length === 0) return;

    let aggregatedValue: number;
    switch (aggregation) {
      case 'sum':
        aggregatedValue = values.reduce((sum, val) => sum + val, 0);
        break;
      case 'avg':
        aggregatedValue = values.reduce((sum, val) => sum + val, 0) / values.length;
        break;
      case 'min':
        aggregatedValue = Math.min(...values);
        break;
      case 'max':
        aggregatedValue = Math.max(...values);
        break;
      case 'count':
        aggregatedValue = values.length;
        break;
      default:
        aggregatedValue = values[0];
    }

    result.push({
      [timeField]: new Date(binTime),
      [valueField]: aggregatedValue,
      count: values.length
    });
  });

  return result.sort((a, b) => {
    const timeA = getTimestamp(a, timeField);
    const timeB = getTimestamp(b, timeField);
    if (!timeA || !timeB) return 0;
    return timeA.getTime() - timeB.getTime();
  });
}

/**
 * Parse time interval string to milliseconds
 */
function parseTimeInterval(interval: string): number {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return 0;
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

/**
 * Apply simple moving average smoothing
 */
function smoothData(data: DataItem[], valueField: string, windowSize: number = 3): DataItem[] {
  if (data.length < windowSize) return data;
  
  const smoothed: DataItem[] = [];
  
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(data.length, i + Math.ceil(windowSize / 2));
    
    const window = data.slice(start, end);
    const values = window.map(item => Number(item[valueField])).filter(val => !isNaN(val));
    
    const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
    
    smoothed.push({
      ...data[i],
      [valueField]: avg
    });
  }
  
  return smoothed;
}

/**
 * Interpolate missing values
 */
function interpolateData(data: DataItem[], timeField: string, valueField: string): DataItem[] {
  // Simple linear interpolation for missing values
  const result: DataItem[] = [];
  
  for (let i = 0; i < data.length; i++) {
    const current = data[i];
    const currentValue = Number(current[valueField]);
    
    if (isNaN(currentValue)) {
      // Find previous and next valid values
      let prevValue: number | null = null;
      let nextValue: number | null = null;
      
      for (let j = i - 1; j >= 0 && prevValue === null; j--) {
        const val = Number(data[j][valueField]);
        if (!isNaN(val)) prevValue = val;
      }
      
      for (let j = i + 1; j < data.length && nextValue === null; j++) {
        const val = Number(data[j][valueField]);
        if (!isNaN(val)) nextValue = val;
      }
      
      // Interpolate if we have both values
      if (prevValue !== null && nextValue !== null) {
        const interpolated = (prevValue + nextValue) / 2;
        result.push({
          ...current,
          [valueField]: interpolated
        });
      } else {
        result.push(current);
      }
    } else {
      result.push(current);
    }
  }
  
  return result;
}

// Export types for use in main thread
export type { DataItem, TimeSeriesConfig, TimeSeriesResult };
