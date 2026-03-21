/**
 * Parquet Processor Worker
 * 
 * Handles Parquet file processing operations including:
 * - Parquet file parsing
 * - Data extraction and transformation
 * - Column filtering
 * - Time range filtering
 * - Data aggregation
 */

import type { 
  WorkerMessage, 
  WorkerResponse, 
  ParquetDataItem, 
  ParquetProcessingResult,
  ParquetMetadata,
  ParquetFilter,
  FilterOperator,
  AggregationConfig,
  AggregationOperation,
  ColumnInfo,
  ColumnType,
  TimeBin,
  DataStatistics,
  ColumnStats
} from './types';

interface ParquetProcessingConfig {
  channelList?: string[];
  startTime?: string | null;
  endTime?: string | null;
  timeField?: string;
  filters?: ParquetFilter[];
  aggregation?: AggregationConfig;
  limit?: number | null;
}

// Worker message handler
self.onmessage = function(e: MessageEvent<WorkerMessage<ParquetDataItem[], ParquetProcessingConfig>>) {
  const { id, type, data, config } = e.data;
  
  try {
    let result: ParquetProcessingResult;
    
    switch (type) {
      case 'parquet-processor':
        result = processParquetData(data, config);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send result back to main thread
    const response: WorkerResponse<ParquetProcessingResult> = {
      id,
      type: 'success',
      result,
      duration: Date.now() - e.data.timestamp
    };
    self.postMessage(response);
    
  } catch (error) {
    // Send error back to main thread
    const response: WorkerResponse = {
      id,
      type: 'error',
      error: (error as Error).message,
      duration: Date.now() - e.data.timestamp
    };
    self.postMessage(response);
  }
};

/**
 * Process Parquet data
 */
function processParquetData(data: ParquetDataItem[], config: ParquetProcessingConfig = {}): ParquetProcessingResult {
  const {
    channelList = [],
    startTime = null,
    endTime = null,
    timeField = 'Datetime',
    filters = [],
    aggregation = null,
    limit = null
  } = config;

  let processedData = data;

  // Filter by time range if specified
  if (startTime || endTime) {
    processedData = filterByTimeRange(processedData, timeField, startTime, endTime);
  }

  // Filter by channel list if specified
  if (channelList.length > 0) {
    processedData = filterByChannels(processedData, channelList);
  }

  // Apply additional filters
  if (filters.length > 0) {
    processedData = applyFilters(processedData, filters);
  }

  // Apply aggregation if specified
  if (aggregation) {
    processedData = applyAggregation(processedData, aggregation);
  }

  // Apply limit if specified
  if (limit && limit > 0) {
    processedData = processedData.slice(0, limit);
  }

  return {
    data: processedData,
    metadata: {
      originalCount: data.length,
      processedCount: processedData.length,
      channels: channelList,
      timeRange: { startTime, endTime },
      filters: filters.length,
      aggregation: aggregation ? true : false,
      limit: limit
    }
  };
}

/**
 * Filter data by time range
 */
function filterByTimeRange(data: ParquetDataItem[], timeField: string, startTime: string | null, endTime: string | null): ParquetDataItem[] {
  return data.filter(item => {
    const itemTime = new Date(item[timeField]);
    
    if (isNaN(itemTime.getTime())) {
      return false;
    }

    if (startTime && itemTime < new Date(startTime)) {
      return false;
    }

    if (endTime && itemTime > new Date(endTime)) {
      return false;
    }

    return true;
  });
}

/**
 * Filter data by channel list
 */
function filterByChannels(data: ParquetDataItem[], channelList: string[]): ParquetDataItem[] {
  if (channelList.length === 0) {
    return data;
  }

  return data.map(item => {
    const filteredItem: ParquetDataItem = {};
    
    // Always include time field
    if (item.Datetime !== undefined) {
      filteredItem.Datetime = item.Datetime;
    }

    // Include specified channels
    channelList.forEach(channel => {
      if (item[channel] !== undefined) {
        filteredItem[channel] = item[channel];
      }
    });

    return filteredItem;
  });
}

/**
 * Apply filters to data
 */
function applyFilters(data: ParquetDataItem[], filters: ParquetFilter[]): ParquetDataItem[] {
  return data.filter(item => {
    return filters.every(filter => {
      const { field, operator, value } = filter;
      const itemValue = item[field];

      switch (operator) {
        case 'eq':
          return itemValue === value;
        case 'ne':
          return itemValue !== value;
        case 'gt':
          return Number(itemValue) > Number(value);
        case 'lt':
          return Number(itemValue) < Number(value);
        case 'gte':
          return Number(itemValue) >= Number(value);
        case 'lte':
          return Number(itemValue) <= Number(value);
        case 'contains':
          return String(itemValue).toLowerCase().includes(String(value).toLowerCase());
        case 'in':
          return Array.isArray(value) && value.includes(itemValue);
        default:
          return true;
      }
    });
  });
}

/**
 * Apply aggregation to data
 */
function applyAggregation(data: ParquetDataItem[], aggregation: AggregationConfig): ParquetDataItem[] {
  const { groupBy, operations } = aggregation;
  
  if (!groupBy || !operations) {
    return data;
  }

  // Group data by specified fields
  const groups: Record<string, ParquetDataItem[]> = {};
  
  data.forEach(item => {
    const groupKey = groupBy.map(field => item[field]).join('|');
    
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    
    groups[groupKey].push(item);
  });

  // Apply aggregations to each group
  return Object.values(groups).map(group => {
    const aggregated: ParquetDataItem = {};
    
    // Copy group by fields
    groupBy.forEach(field => {
      aggregated[field] = group[0][field];
    });
    
    // Apply aggregation operations
    operations.forEach(op => {
      const values = group.map(item => item[op.field]).filter(v => v !== undefined && v !== null);
      
      switch (op.type) {
        case 'sum':
          aggregated[op.as || `${op.field}_sum`] = values.reduce((sum, val) => sum + (Number(val) || 0), 0);
          break;
        case 'avg':
          aggregated[op.as || `${op.field}_avg`] = values.length > 0 ? 
            values.reduce((sum, val) => sum + (Number(val) || 0), 0) / values.length : 0;
          break;
        case 'count':
          aggregated[op.as || `${op.field}_count`] = values.length;
          break;
        case 'min':
          aggregated[op.as || `${op.field}_min`] = Math.min(...values.map(v => Number(v) || 0));
          break;
        case 'max':
          aggregated[op.as || `${op.field}_max`] = Math.max(...values.map(v => Number(v) || 0));
          break;
        case 'first':
          aggregated[op.as || `${op.field}_first`] = values[0];
          break;
        case 'last':
          aggregated[op.as || `${op.field}_last`] = values[values.length - 1];
          break;
      }
    });
    
    return aggregated;
  });
}

/**
 * Extract column information from data
 */
function extractColumnInfo(data: ParquetDataItem[]): ColumnInfo[] {
  if (data.length === 0) {
    return [];
  }

  const columns = Object.keys(data[0]);
  const columnInfo: ColumnInfo[] = [];

  columns.forEach(column => {
    const values = data.map(item => item[column]).filter(v => v !== undefined && v !== null);
    const numericValues = values.filter(v => !isNaN(Number(v))).map(v => Number(v));
    
    const info: ColumnInfo = {
      name: column,
      type: detectColumnType(values),
      count: values.length,
      nullCount: data.length - values.length,
      uniqueCount: new Set(values).size
    };

    if (numericValues.length > 0) {
      info.min = Math.min(...numericValues);
      info.max = Math.max(...numericValues);
      info.avg = numericValues.reduce((sum, val) => sum + val, 0) / numericValues.length;
      info.sum = numericValues.reduce((sum, val) => sum + val, 0);
    }

    columnInfo.push(info);
  });

  return columnInfo;
}

/**
 * Detect column type based on values
 */
function detectColumnType(values: any[]): ColumnType {
  if (values.length === 0) {
    return 'unknown';
  }

  const sample = values.slice(0, Math.min(100, values.length));
  
  // Check if all values are numbers
  if (sample.every(v => !isNaN(Number(v)))) {
    return 'number';
  }
  
  // Check if all values are dates
  if (sample.every(v => !isNaN(new Date(v).getTime()))) {
    return 'date';
  }
  
  // Check if all values are booleans
  if (sample.every(v => v === true || v === false)) {
    return 'boolean';
  }
  
  // Default to string
  return 'string';
}

/**
 * Create time-based bins for data
 */
function createTimeBins(data: ParquetDataItem[], timeField: string, binSize: number): TimeBin[] {
  const bins: Record<number, ParquetDataItem[]> = {};
  
  data.forEach(item => {
    const time = new Date(item[timeField]);
    const binKey = Math.floor(time.getTime() / binSize) * binSize;
    
    if (!bins[binKey]) {
      bins[binKey] = [];
    }
    
    bins[binKey].push(item);
  });

  return Object.entries(bins).map(([time, items]) => ({
    time: new Date(Number(time)),
    count: items.length,
    items: items
  }));
}

/**
 * Calculate data statistics
 */
function calculateDataStatistics(data: ParquetDataItem[]): DataStatistics {
  if (data.length === 0) {
    return {};
  }

  const columns = Object.keys(data[0]);
  const stats: DataStatistics = {};

  columns.forEach(column => {
    const values = data.map(item => item[column]).filter(v => v !== undefined && v !== null);
    const numericValues = values.filter(v => !isNaN(Number(v))).map(v => Number(v));
    
    stats[column] = {
      count: values.length,
      nullCount: data.length - values.length,
      uniqueCount: new Set(values).size,
      type: detectColumnType(values)
    };

    if (numericValues.length > 0) {
      stats[column].min = Math.min(...numericValues);
      stats[column].max = Math.max(...numericValues);
      stats[column].avg = numericValues.reduce((sum, val) => sum + val, 0) / numericValues.length;
      stats[column].sum = numericValues.reduce((sum, val) => sum + val, 0);
      stats[column].std = calculateStandardDeviation(numericValues, stats[column].avg!);
    }
  });

  return stats;
}

/**
 * Calculate standard deviation
 */
function calculateStandardDeviation(values: number[], mean: number): number {
  const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Convert data to different formats
 */
function convertDataFormat(data: ParquetDataItem[], format: 'json' | 'csv' | 'array'): any {
  switch (format) {
    case 'json':
      return data;
    case 'csv':
      return convertToCSV(data);
    case 'array':
      return data.map(item => Object.values(item));
    default:
      return data;
  }
}

/**
 * Convert data to CSV format
 */
function convertToCSV(data: ParquetDataItem[]): string {
  if (data.length === 0) {
    return '';
  }

  const columns = Object.keys(data[0]);
  const csvRows = [columns.join(',')];
  
  data.forEach(item => {
    const row = columns.map(column => {
      const value = item[column];
      if (value === null || value === undefined) {
        return '';
      }
      if (typeof value === 'string' && value.includes(',')) {
        return `"${value}"`;
      }
      return value;
    });
    csvRows.push(row.join(','));
  });

  return csvRows.join('\n');
}
