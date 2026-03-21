/**
 * Data Filter Worker
 * 
 * Handles data filtering operations including:
 * - Complex filter conditions
 * - Range filtering
 * - Text search
 * - Date filtering
 * - Custom filter functions
 */

import { warn } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  FilterableDataItem, 
  FilterOperator,
  FilterRule
} from './types';

interface FilterConfig {
  filters?: FilterRule[];
  logic?: 'AND' | 'OR';
}

interface FilterStats {
  totalItems: number;
  filteredItems: number;
  filteredPercentage: number;
  filtersApplied: number;
}

// Worker message handler
self.onmessage = function(e: MessageEvent<WorkerMessage<FilterableDataItem[], FilterConfig>>) {
  const { id, type, data, config } = e.data;
  
  try {
    let result: FilterableDataItem[];
    
    switch (type) {
      case 'data-filter':
        result = filterData(data, config);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send result back to main thread
    const response: WorkerResponse<FilterableDataItem[]> = {
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
 * Filter data based on provided filters
 */
function filterData(data: FilterableDataItem[], config: FilterConfig = {}): FilterableDataItem[] {
  if (!Array.isArray(data)) {
    throw new Error('Data must be an array');
  }

  const { filters = [], logic = 'AND' } = config;
  
  if (filters.length === 0) {
    return data;
  }

  return data.filter(item => {
    if (logic === 'OR') {
      return filters.some(filter => applyFilter(item, filter));
    } else {
      return filters.every(filter => applyFilter(item, filter));
    }
  });
}

/**
 * Apply a single filter to an item
 */
function applyFilter(item: FilterableDataItem, filter: FilterRule): boolean {
  const { field, operator, value, caseSensitive = false } = filter;
  
  if (!field || operator === undefined) {
    return true;
  }

  const itemValue = item[field];
  
  // Handle null/undefined values
  if (itemValue === null || itemValue === undefined) {
    switch (operator) {
      case 'is_null':
      case 'is_empty':
        return true;
      case 'is_not_null':
      case 'is_not_empty':
        return false;
      default:
        return false;
    }
  }

  switch (operator) {
    case 'eq':
    case 'equals':
      return itemValue === value;
      
    case 'ne':
    case 'not_equals':
      return itemValue !== value;
      
    case 'gt':
    case 'greater_than':
      return Number(itemValue) > Number(value);
      
    case 'gte':
    case 'greater_than_or_equal':
      return Number(itemValue) >= Number(value);
      
    case 'lt':
    case 'less_than':
      return Number(itemValue) < Number(value);
      
    case 'lte':
    case 'less_than_or_equal':
      return Number(itemValue) <= Number(value);
      
    case 'in':
    case 'in_list':
      return Array.isArray(value) && value.includes(itemValue);
      
    case 'not_in':
    case 'not_in_list':
      return Array.isArray(value) && !value.includes(itemValue);
      
    case 'contains':
      return String(itemValue).toLowerCase().includes(
        caseSensitive ? String(value) : String(value).toLowerCase()
      );
      
    case 'not_contains':
      return !String(itemValue).toLowerCase().includes(
        caseSensitive ? String(value) : String(value).toLowerCase()
      );
      
    case 'starts_with':
      return String(itemValue).toLowerCase().startsWith(
        caseSensitive ? String(value) : String(value).toLowerCase()
      );
      
    case 'ends_with':
      return String(itemValue).toLowerCase().endsWith(
        caseSensitive ? String(value) : String(value).toLowerCase()
      );
      
    case 'regex':
      try {
        const regex = new RegExp(value, caseSensitive ? 'g' : 'gi');
        return regex.test(String(itemValue));
      } catch (error) {
        return false;
      }
      
    case 'is_null':
    case 'is_empty':
      return itemValue === null || itemValue === undefined || itemValue === '';
      
    case 'is_not_null':
    case 'is_not_empty':
      return itemValue !== null && itemValue !== undefined && itemValue !== '';
      
    case 'between':
      if (Array.isArray(value) && value.length === 2) {
        const numValue = Number(itemValue);
        return numValue >= Number(value[0]) && numValue <= Number(value[1]);
      }
      return false;
      
    case 'not_between':
      if (Array.isArray(value) && value.length === 2) {
        const numValue = Number(itemValue);
        return numValue < Number(value[0]) || numValue > Number(value[1]);
      }
      return false;
      
    case 'date_between':
      if (Array.isArray(value) && value.length === 2) {
        const itemDate = new Date(itemValue);
        const startDate = new Date(value[0]);
        const endDate = new Date(value[1]);
        return itemDate >= startDate && itemDate <= endDate;
      }
      return false;
      
    case 'date_after':
      const itemDateAfter = new Date(itemValue);
      const compareDateAfter = new Date(value);
      return itemDateAfter > compareDateAfter;
      
    case 'date_before':
      const itemDateBefore = new Date(itemValue);
      const compareDateBefore = new Date(value);
      return itemDateBefore < compareDateBefore;
      
    case 'custom':
      if (typeof filter.customFunction === 'function') {
        try {
          return filter.customFunction(item, itemValue);
        } catch (error) {
          warn('Custom filter function error:', error);
          return false;
        }
      }
      return false;
      
    default:
      warn(`Unknown filter operator: ${operator}`);
      return true;
  }
}

/**
 * Create a filter from a simple object
 */
function createFilter(field: string, operator: FilterOperator, value: any, options: Partial<FilterRule> = {}): FilterRule {
  return {
    field,
    operator,
    value,
    ...options
  };
}

/**
 * Create a range filter
 */
function createRangeFilter(field: string, min: number, max: number): FilterRule {
  return {
    field,
    operator: 'between',
    value: [min, max]
  };
}

/**
 * Create a text search filter
 */
function createTextFilter(field: string, searchText: string, caseSensitive: boolean = false): FilterRule {
  return {
    field,
    operator: 'contains',
    value: searchText,
    caseSensitive
  };
}

/**
 * Create a date range filter
 */
function createDateRangeFilter(field: string, startDate: string | Date, endDate: string | Date): FilterRule {
  return {
    field,
    operator: 'date_between',
    value: [startDate, endDate]
  };
}

/**
 * Create a numeric range filter
 */
function createNumericRangeFilter(field: string, min: number, max: number): FilterRule {
  return {
    field,
    operator: 'between',
    value: [min, max]
  };
}

/**
 * Create a list filter
 */
function createListFilter(field: string, values: any[], include: boolean = true): FilterRule {
  return {
    field,
    operator: include ? 'in' : 'not_in',
    value: values
  };
}

/**
 * Combine multiple filters with logic
 */
function combineFilters(filters: FilterRule[], logic: 'AND' | 'OR' = 'AND'): FilterConfig {
  return {
    filters,
    logic
  };
}

/**
 * Validate filter configuration
 */
function validateFilter(filter: FilterRule): boolean {
  const required = ['field', 'operator'];
  const validOperators: FilterOperator[] = [
    'eq', 'equals', 'ne', 'not_equals',
    'gt', 'greater_than', 'gte', 'greater_than_or_equal',
    'lt', 'less_than', 'lte', 'less_than_or_equal',
    'in', 'in_list', 'not_in', 'not_in_list',
    'contains', 'not_contains', 'starts_with', 'ends_with',
    'regex', 'is_null', 'is_empty', 'is_not_null', 'is_not_empty',
    'between', 'not_between', 'date_between', 'date_after', 'date_before',
    'custom'
  ];

  // Check required fields
  for (const field of required) {
    if (!filter[field as keyof FilterRule]) {
      throw new Error(`Filter missing required field: ${field}`);
    }
  }

  // Check valid operator
  if (!validOperators.includes(filter.operator)) {
    throw new Error(`Invalid filter operator: ${filter.operator}`);
  }

  // Check value for operators that require it
  const valueRequired: FilterOperator[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex'];
  if (valueRequired.includes(filter.operator) && filter.value === undefined) {
    throw new Error(`Filter operator ${filter.operator} requires a value`);
  }

  return true;
}

/**
 * Get filter statistics
 */
function getFilterStats(data: FilterableDataItem[], filters: FilterRule[]): FilterStats {
  const totalItems = data.length;
  const filteredItems = filterData(data, { filters }).length;
  const filteredPercentage = totalItems > 0 ? (filteredItems / totalItems) * 100 : 0;

  return {
    totalItems,
    filteredItems,
    filteredPercentage: Math.round(filteredPercentage * 100) / 100,
    filtersApplied: filters.length
  };
}

/**
 * Create a quick filter for common use cases
 */
function createQuickFilter(type: 'text' | 'number' | 'date' | 'boolean' | 'list', field: string, value: any): FilterRule {
  switch (type) {
    case 'text':
      return createTextFilter(field, value);
    case 'number':
      return createFilter(field, 'eq', Number(value));
    case 'date':
      return createFilter(field, 'date_after', value);
    case 'boolean':
      return createFilter(field, 'eq', Boolean(value));
    case 'list':
      return createListFilter(field, Array.isArray(value) ? value : [value]);
    default:
      return createFilter(field, 'eq', value);
  }
}
