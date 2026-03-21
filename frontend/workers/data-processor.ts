/**
 * Data Processor Worker
 * 
 * Handles general data processing operations including:
 * - Data transformation
 * - Data cleaning
 * - Data formatting
 * - Data aggregation
 */

import { warn } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  DataItem, 
  FilterOperator, 
  AggregationOperation, 
  AggregationConfig 
} from './types';

interface ProcessingConfig {
  transformations?: Transformation[];
  clean?: boolean;
  format?: Record<string, FormatSpec>;
  aggregate?: AggregationConfig;
  filters?: FilterConfig[];
  sort?: SortConfig[];
  limit?: number;
}

interface Transformation {
  type: 'rename' | 'calculate' | 'convert' | 'format';
  from?: string;
  to?: string;
  field?: string;
  expression?: string;
  toType?: 'number' | 'string' | 'boolean' | 'date';
  format?: FormatSpec;
}

interface FormatSpec {
  type: 'number' | 'date' | 'currency';
  decimals?: number;
  locale?: string;
  currency?: string;
}

interface FilterConfig {
  field: string;
  operator: FilterOperator;
  value: any;
}

interface SortConfig {
  field: string;
  direction: 'asc' | 'desc';
}

// Worker message handler
self.onmessage = function(e: MessageEvent<WorkerMessage<DataItem[], ProcessingConfig>>) {
  const { id, type, data, config } = e.data;
  
  try {
    let result: any;
    
    switch (type) {
      case 'data-processor':
        result = processData(data, config);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send result back to main thread
    const response: WorkerResponse<DataItem[]> = {
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
 * Process data with various transformations
 */
function processData(data: DataItem[], config: ProcessingConfig = {}): DataItem[] {
  if (!Array.isArray(data)) {
    throw new Error('Data must be an array');
  }

  let processedData = [...data];

  // Apply transformations based on config
  if (config.transformations) {
    processedData = applyTransformations(processedData, config.transformations);
  }

  // Apply data cleaning
  if (config.clean) {
    processedData = cleanData(processedData);
  }

  // Apply data formatting
  if (config.format) {
    processedData = formatData(processedData, config.format);
  }

  // Apply aggregation
  if (config.aggregate) {
    processedData = aggregateData(processedData, config.aggregate);
  }

  // Apply filtering
  if (config.filters) {
    processedData = applyFilters(processedData, config.filters);
  }

  // Apply sorting
  if (config.sort) {
    processedData = sortData(processedData, config.sort);
  }

  // Apply limiting
  if (config.limit) {
    processedData = processedData.slice(0, config.limit);
  }

  return processedData;
}

/**
 * Apply data transformations
 */
function applyTransformations(data: DataItem[], transformations: Transformation[]): DataItem[] {
  return data.map(item => {
    let transformed = { ...item };
    
    transformations.forEach(transform => {
      switch (transform.type) {
        case 'rename':
          if (transform.from && transform.to && transformed[transform.from] !== undefined) {
            transformed[transform.to] = transformed[transform.from];
            delete transformed[transform.from];
          }
          break;
          
        case 'calculate':
          if (transform.expression && transform.field) {
            try {
              transformed[transform.field] = evaluateExpression(transform.expression, transformed);
            } catch (error) {
              warn('Expression evaluation failed:', error);
            }
          }
          break;
          
        case 'convert':
          if (transform.field && transform.toType && transformed[transform.field] !== undefined) {
            transformed[transform.field] = convertValue(transformed[transform.field], transform.toType);
          }
          break;
          
        case 'format':
          if (transform.field && transform.format && transformed[transform.field] !== undefined) {
            transformed[transform.field] = formatValue(transformed[transform.field], transform.format);
          }
          break;
      }
    });
    
    return transformed;
  });
}

/**
 * Clean data by removing invalid entries
 */
function cleanData(data: DataItem[]): DataItem[] {
  return data.filter(item => {
    // Remove items with all undefined/null values
    const values = Object.values(item);
    return values.some(value => value !== undefined && value !== null && value !== '');
  }).map(item => {
    // Clean individual fields
    const cleaned: DataItem = {};
    Object.entries(item).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        cleaned[key] = value;
      }
    });
    return cleaned;
  });
}

/**
 * Format data according to specifications
 */
function formatData(data: DataItem[], format: Record<string, FormatSpec>): DataItem[] {
  return data.map(item => {
    const formatted = { ...item };
    
    Object.entries(format).forEach(([field, formatSpec]) => {
      if (formatted[field] !== undefined) {
        formatted[field] = formatValue(formatted[field], formatSpec);
      }
    });
    
    return formatted;
  });
}

/**
 * Aggregate data based on specifications
 */
function aggregateData(data: DataItem[], aggregate: AggregationConfig): DataItem[] {
  if (!aggregate.groupBy || aggregate.groupBy.length === 0) {
    return data;
  }

  const groups: Record<string, DataItem[]> = {};
  
  data.forEach(item => {
    const groupKey = aggregate.groupBy.map(field => item[field]).join('|');
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(item);
  });

  return Object.values(groups).map(group => {
    const aggregated: DataItem = {};
    
    // Copy group by fields
    aggregate.groupBy.forEach(field => {
      aggregated[field] = group[0][field];
    });
    
    // Apply aggregations
    aggregate.operations.forEach(op => {
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
      }
    });
    
    return aggregated;
  });
}

/**
 * Apply filters to data
 */
function applyFilters(data: DataItem[], filters: FilterConfig[]): DataItem[] {
  return data.filter(item => {
    return filters.every(filter => {
      const value = item[filter.field];
      
      switch (filter.operator) {
        case 'eq':
          return value === filter.value;
        case 'ne':
          return value !== filter.value;
        case 'gt':
          return Number(value) > Number(filter.value);
        case 'lt':
          return Number(value) < Number(filter.value);
        case 'gte':
          return Number(value) >= Number(filter.value);
        case 'lte':
          return Number(value) <= Number(filter.value);
        case 'in':
          return Array.isArray(filter.value) && filter.value.includes(value);
        case 'not_in':
          return Array.isArray(filter.value) && !filter.value.includes(value);
        case 'contains':
          return String(value).toLowerCase().includes(String(filter.value).toLowerCase());
        case 'starts_with':
          return String(value).toLowerCase().startsWith(String(filter.value).toLowerCase());
        case 'ends_with':
          return String(value).toLowerCase().endsWith(String(filter.value).toLowerCase());
        case 'between':
          if (Array.isArray(filter.value) && filter.value.length === 2) {
            const numValue = Number(value);
            return numValue >= Number(filter.value[0]) && numValue <= Number(filter.value[1]);
          }
          return false;
        case 'not_between':
          if (Array.isArray(filter.value) && filter.value.length === 2) {
            const numValue = Number(value);
            return numValue < Number(filter.value[0]) || numValue > Number(filter.value[1]);
          }
          return false;
        case 'is_null':
          return value === null || value === undefined;
        case 'is_not_null':
          return value !== null && value !== undefined;
        default:
          return true;
      }
    });
  });
}

/**
 * Sort data based on specifications
 */
function sortData(data: DataItem[], sort: SortConfig[]): DataItem[] {
  return data.sort((a, b) => {
    for (const sortSpec of sort) {
      const aVal = a[sortSpec.field];
      const bVal = b[sortSpec.field];
      
      let comparison = 0;
      
      if (aVal < bVal) comparison = -1;
      else if (aVal > bVal) comparison = 1;
      
      if (sortSpec.direction === 'desc') {
        comparison = -comparison;
      }
      
      if (comparison !== 0) {
        return comparison;
      }
    }
    return 0;
  });
}

/**
 * Evaluate mathematical expressions
 */
function evaluateExpression(expression: string, context: DataItem): number {
  // Simple expression evaluator - in production, use a proper expression parser
  const safeExpression = expression
    .replace(/[^0-9+\-*/.() ]/g, '') // Remove potentially dangerous characters
    .replace(/\b\w+\b/g, (match) => {
      return String(context[match] || 0);
    });
  
  try {
    return Function(`"use strict"; return (${safeExpression})`)();
  } catch (error) {
    return 0;
  }
}

/**
 * Convert value to specified type
 */
function convertValue(value: any, toType: 'number' | 'string' | 'boolean' | 'date'): any {
  switch (toType) {
    case 'number':
      return Number(value) || 0;
    case 'string':
      return String(value);
    case 'boolean':
      return Boolean(value);
    case 'date':
      return new Date(value);
    default:
      return value;
  }
}

/**
 * Format value according to format specification
 */
function formatValue(value: any, format: FormatSpec): any {
  if (format.type === 'number') {
    return Number(value).toFixed(format.decimals || 2);
  } else if (format.type === 'date') {
    return new Date(value).toLocaleDateString(format.locale || 'en-US');
  } else if (format.type === 'currency') {
    return new Intl.NumberFormat(format.locale || 'en-US', {
      style: 'currency',
      currency: format.currency || 'USD'
    }).format(value);
  }
  return value;
}
