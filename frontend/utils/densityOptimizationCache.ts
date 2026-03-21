/**
 * Density Optimization Cache Utilities
 * 
 * Provides utilities for generating cache keys, hashing data, and managing
 * density-optimized scatter plot cache entries.
 */

import { log, debug } from './console';

/**
 * Create a cache key for density-optimized data
 * Format: densityOpt_{className}_{sourceId}_{uniqueId}_{colorType}_{regressionMethod}_{filterHash}_{selectionHash}
 */
export function createDensityOptimizationCacheKey(
  className: string,
  sourceId: string,
  colorType: string,
  regressionMethod: string,
  chartFilters: string[],
  globalFilters: { states: string[]; races: string[]; legs: string[]; grades: string[] },
  selectionState: {
    selectedRange: Array<{ start_time: string; end_time: string; [key: string]: any }>;
    selectedEvents: Array<{ event_id: number; event_type: string; start_time: string; end_time: string; [key: string]: any }>;
    cutEvents: Array<{ start_time: string; end_time: string; [key: string]: any }>;
  },
  uniqueId?: string
): string {
  // Create filter hash from chart and global filters
  const filterHash = createFilterHash(chartFilters, globalFilters);
  
  // Create selection hash from selection state
  const selectionHash = createSelectionHash(selectionState);
  
  // Include uniqueId if provided
  const uniqueIdPart = uniqueId ? `${uniqueId}_` : '';
  
  // Combine all components including regression method and uniqueId
  const key = `densityOpt_${className.toLowerCase()}_${sourceId}_${uniqueIdPart}${colorType}_${regressionMethod}_${filterHash}_${selectionHash}`;
  
  return key;
}

/**
 * Create a hash from filter states
 */
function createFilterHash(
  chartFilters: string[],
  globalFilters: { states: string[]; races: string[]; legs: string[]; grades: string[] }
): string {
  const filterString = JSON.stringify({
    chartFilters: chartFilters.sort(),
    globalFilters: {
      states: globalFilters.states.sort(),
      races: globalFilters.races.sort(),
      legs: globalFilters.legs.sort(),
      grades: globalFilters.grades.sort()
    }
  });
  
  // Simple hash function (djb2 algorithm)
  let hash = 5381;
  for (let i = 0; i < filterString.length; i++) {
    hash = ((hash << 5) + hash) + filterString.charCodeAt(i);
  }
  
  return Math.abs(hash).toString(36).substring(0, 8);
}

/**
 * Create a hash from selection state
 */
function createSelectionHash(selectionState: {
  selectedRange: Array<{ start_time: string; end_time: string; [key: string]: any }>;
  selectedEvents: Array<{ event_id: number; event_type: string; start_time: string; end_time: string; [key: string]: any }>;
  cutEvents: Array<{ start_time: string; end_time: string; [key: string]: any }>;
}): string {
  // Normalize the selection state to a consistent format
  const normalized = {
    selectedRange: selectionState.selectedRange.map(r => ({
      start_time: r.start_time,
      end_time: r.end_time
    })),
    selectedEvents: selectionState.selectedEvents.map(e => ({
      event_id: e.event_id,
      start_time: e.start_time,
      end_time: e.end_time
    })),
    cutEvents: selectionState.cutEvents.map(c => ({
      start_time: c.start_time,
      end_time: c.end_time
    }))
  };
  
  const selectionString = JSON.stringify(normalized);
  
  // Simple hash function (djb2 algorithm)
  let hash = 5381;
  for (let i = 0; i < selectionString.length; i++) {
    hash = ((hash << 5) + hash) + selectionString.charCodeAt(i);
  }
  
  return Math.abs(hash).toString(36).substring(0, 8);
}

/**
 * Hash data to detect changes
 * Uses data length + first/last timestamps for quick detection
 */
export function hashData(data: any[]): string {
  if (!data || data.length === 0) {
    return 'empty';
  }
  
  try {
    // Use data characteristics for hashing
    const firstPoint = data[0];
    const lastPoint = data[data.length - 1];
    
    const firstTime = firstPoint?.Datetime ? new Date(firstPoint.Datetime).getTime() : 0;
    const lastTime = lastPoint?.Datetime ? new Date(lastPoint.Datetime).getTime() : 0;
    
    const dataString = `${data.length}_${firstTime}_${lastTime}`;
    
    // Simple hash function (djb2 algorithm)
    let hash = 5381;
    for (let i = 0; i < dataString.length; i++) {
      hash = ((hash << 5) + hash) + dataString.charCodeAt(i);
    }
    
    return Math.abs(hash).toString(36).substring(0, 10);
  } catch (error) {
    log(`Error hashing data:`, error);
    return 'error';
  }
}

/**
 * Parse a cache key to extract components
 */
export function parseCacheKey(key: string): {
  className: string;
  sourceId: string;
  colorType: string;
  regressionMethod: string;
  filterHash: string;
  selectionHash: string;
} | null {
  if (!key || !key.startsWith('densityOpt_')) {
    return null;
  }
  
  const parts = key.split('_');
  if (parts.length < 7) {
    return null;
  }
  
  return {
    className: parts[1],
    sourceId: parts[2],
    colorType: parts[3],
    regressionMethod: parts[4],
    filterHash: parts[5],
    selectionHash: parts[6]
  };
}

