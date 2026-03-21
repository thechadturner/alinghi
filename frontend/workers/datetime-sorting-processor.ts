/**
 * Datetime Sorting Processor Worker
 * 
 * Handles sorting of large datasets by datetime to prevent main thread blocking
 */

import type { 
  WorkerMessage, 
  WorkerResponse 
} from './types';
import { warn, error as logError, log } from '../utils/console';

interface DatetimeSortingMessage extends WorkerMessage {
  type: 'SORT_BY_DATETIME';
  data: any[];
}

interface DatetimeSortingResponse extends WorkerResponse {
  result: {
    sortedData: any[];
    processingTime: number;
  };
}

// Worker message handler
self.onmessage = (event: MessageEvent<DatetimeSortingMessage>) => {
  log('[DatetimeSortingWorker] Received message:', event.data);
  
  const { type, data, id } = event.data;
  
  if (type === 'SORT_BY_DATETIME') {
    log(`[DatetimeSortingWorker] Processing ${data?.length || 0} items for message ${id}`);
    
    try {
      const result = sortDataByDatetime(data);
      log(`[DatetimeSortingWorker] Completed sorting in ${result.processingTime.toFixed(2)}ms`);
      
      self.postMessage({
        id: id,
        type: 'DATETIME_SORTING_PROCESSED',
        success: true,
        result,
        timestamp: Date.now()
      });
    } catch (error) {
      logError('[DatetimeSortingWorker] Error:', error);
      self.postMessage({
        id: id,
        type: 'DATETIME_SORTING_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  } else {
    warn('[DatetimeSortingWorker] Unknown message type:', type);
  }
};

/**
 * Sort data by datetime
 */
function sortDataByDatetime(data: any[]): { sortedData: any[]; processingTime: number } {
  const startTime = performance.now();
  
  if (!data || data.length === 0) {
    log('[DatetimeSortingWorker] Empty data array');
    return {
      sortedData: [],
      processingTime: 0
    };
  }
  
  log(`[DatetimeSortingWorker] Starting sort of ${data.length} items`);
  
  // Validate data before sorting
  let validItems = 0;
  let invalidItems = 0;
  
  for (let i = 0; i < Math.min(10, data.length); i++) {
    const item = data[i];
    const timeA = item.timestamp || new Date(item.Datetime).getTime();
    if (isNaN(timeA)) {
      invalidItems++;
      warn(`[DatetimeSortingWorker] Invalid datetime at index ${i}:`, item);
    } else {
      validItems++;
    }
  }
  
  log(`[DatetimeSortingWorker] Sample validation: ${validItems} valid, ${invalidItems} invalid out of ${Math.min(10, data.length)} checked`);
  
  // Pre-compute timestamps for better performance
  log(`[DatetimeSortingWorker] Pre-computing timestamps for ${data.length} items`);
  const dataWithTimestamps = data.map((item, index) => {
    const timestamp = item.timestamp || new Date(item.Datetime).getTime();
    return {
      ...item,
      _sortTimestamp: isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp,
      _originalIndex: index
    };
  });
  
  // Sort data by pre-computed timestamps
  log(`[DatetimeSortingWorker] Sorting ${dataWithTimestamps.length} items by pre-computed timestamps`);
  const sortedData = dataWithTimestamps.sort((a, b) => {
    // Handle invalid dates (moved to end)
    if (a._sortTimestamp === Number.MAX_SAFE_INTEGER && b._sortTimestamp === Number.MAX_SAFE_INTEGER) return 0;
    if (a._sortTimestamp === Number.MAX_SAFE_INTEGER) return 1;
    if (b._sortTimestamp === Number.MAX_SAFE_INTEGER) return -1;
    
    return a._sortTimestamp - b._sortTimestamp;
  });
  
  // Remove the temporary sorting fields
  const finalSortedData = sortedData.map(({ _sortTimestamp, _originalIndex, ...item }) => item);
  
  const processingTime = performance.now() - startTime;
  log(`[DatetimeSortingWorker] Sort completed in ${processingTime.toFixed(2)}ms`);
  
  return {
    sortedData: finalSortedData,
    processingTime
  };
}
