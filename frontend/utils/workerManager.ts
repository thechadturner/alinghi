/**
 * Worker Manager
 * 
 * Centralized management for all Web Worker operations to prevent main thread blocking
 */

import { log } from './console';

import type { 
  WindDataItem, 
  WindProcessingConfig, 
  WindProcessingResult,
  FilterableDataItem,
  DataFilteringConfig,
  DataFilteringResult,
  D3CalculationsConfig,
  D3CalculationsResult,
  DatetimeSortingResult
} from '../workers/types';

// Import overlay types
import type { 
  OverlayProcessingConfig, 
  OverlayProcessingResult 
} from '../workers/overlay-types';

import { error as logError } from './console';
import { createModuleWorker } from './workerFactory';

// Workers are imported dynamically to avoid circular dependency issues
// Some workers import stores which can create circular dependencies during bundling

// Worker instances cache
const workerCache = new Map<string, Worker>();

/**
 * Clear all cached workers and force recreation
 */
export function clearWorkerCache(): void {
  workerCache.forEach(worker => worker.terminate());
  workerCache.clear();
  log('Worker cache cleared');
}

/**
 * Get or create a worker instance
 * Uses dynamic imports to avoid circular dependency issues
 */
async function getWorker(type: string): Promise<Worker> {
  if (workerCache.has(type)) {
    return workerCache.get(type)!;
  }

  let WorkerClass: new () => Worker;
  
  switch (type) {
    case 'rose-processor': {
      const module = await import('../workers/rose-data-processor.ts?worker');
      WorkerClass = module.default;
      break;
    }
    case 'data-filtering': {
      const module = await import('../workers/data-filtering-processor.ts?worker');
      WorkerClass = module.default;
      break;
    }
    case 'd3-calculations': {
      const module = await import('../workers/d3-calculations-processor.ts?worker');
      WorkerClass = module.default;
      break;
    }
    case 'datetime-sorting': {
      const module = await import('../workers/datetime-sorting-processor.ts?worker');
      WorkerClass = module.default;
      break;
    }
    case 'webgl-data-processor': {
      const module = await import('../workers/webgl-data-processor.ts?worker');
      WorkerClass = module.default;
      break;
    }
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }

  const worker = new WorkerClass();
  workerCache.set(type, worker);
  return worker;
}

/**
 * Process rose data using Web Worker (renamed from wind data)
 */
export async function processRoseDataWithWorker(
  data: WindDataItem[], 
  config: WindProcessingConfig
): Promise<WindProcessingResult> {
  // Use dynamic import to avoid circular dependency
  const { default: RoseWorker } = await import('../workers/rose-data-processor.ts?worker');
  const worker = new RoseWorker();
  
  return new Promise((resolve, reject) => {
    
    if (!worker) {
      reject(new Error('Failed to create rose data processor worker'));
      return;
    }
    
    const messageId = `rose-${Date.now()}-${Math.random()}`;
    const startTime = Date.now();
    
    log(`Starting rose data processing for ${data.length} data points with message ID: ${messageId}`);
    
    const handleMessage = (event: MessageEvent) => {
      // Only process messages with matching ID to prevent cross-contamination
      if (event.data.id === messageId && event.data.type === 'ROSE_DATA_PROCESSED') {
        const processingTime = Date.now() - startTime;
        log(`Rose data processing completed in ${processingTime}ms for message ID: ${messageId}`);
        
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          // Create a deep copy of the result to prevent mutation
          const result = JSON.parse(JSON.stringify(event.data.result));
          worker.terminate(); // Clean up the worker
          resolve(result);
        } else {
          worker.terminate(); // Clean up the worker
          reject(new Error(event.data.error || 'Rose data processing failed'));
        }
      }
    };
    
    worker.addEventListener('message', handleMessage);
    
    // Add error handling for worker
    worker.addEventListener('error', (error) => {
      logError('Worker error:', error);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    });
    
    worker.postMessage({
      id: messageId,
      type: 'PROCESS_ROSE_DATA',
      data: JSON.parse(JSON.stringify(data)), // Deep copy input data
      config: JSON.parse(JSON.stringify(config)), // Deep copy config
      timestamp: Date.now()
    });
    
    // Dynamic timeout based on data size
    const dataSize = JSON.stringify(data).length;
    const baseTimeout = 20000; // 20 seconds base
    const sizeMultiplier = Math.max(1, Math.ceil(dataSize / (1024 * 1024))); // 1 second per MB
    const dynamicTimeout = Math.min(baseTimeout + (sizeMultiplier * 8000), 90000); // Add 8 seconds per MB, max 90 seconds
    
    setTimeout(() => {
      const processingTime = Date.now() - startTime;
      logError(`Rose data processing timeout after ${processingTime}ms for message ID: ${messageId} (data size: ${(dataSize / 1024 / 1024).toFixed(2)}MB, timeout: ${dynamicTimeout}ms)`);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error('Rose data processing timeout'));
    }, dynamicTimeout);
  });
}

/**
 * Process time series data using Web Worker
 */
export async function processTimeSeriesDataWithWorker(
  data: any[], 
  config: any
): Promise<any> {
  // Use dynamic import to avoid circular dependency
  const { default: TimeseriesWorker } = await import('../workers/timeseries-data-processor.ts?worker');
  const worker = new TimeseriesWorker();
  
  return new Promise((resolve, reject) => {
    
    if (!worker) {
      reject(new Error('Failed to create time series data processor worker'));
      return;
    }
    
    const messageId = `timeseries-${Date.now()}-${Math.random()}`;
    const startTime = Date.now();
    
    log(`Starting time series data processing for ${data.length} data points with message ID: ${messageId}`);
    
    const handleMessage = (event: MessageEvent) => {
      if (event.data.id === messageId && event.data.type === 'TIMESERIES_DATA_PROCESSED') {
        const processingTime = Date.now() - startTime;
        log(`Time series data processing completed in ${processingTime}ms for message ID: ${messageId}`);
        
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          const result = JSON.parse(JSON.stringify(event.data.result));
          worker.terminate();
          resolve(result);
        } else {
          worker.terminate();
          reject(new Error(event.data.error || 'Time series data processing failed'));
        }
      }
    };
    
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', (error) => {
      logError('Time series worker error:', error);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    });
    
    worker.postMessage({
      id: messageId,
      type: 'PROCESS_TIMESERIES_DATA',
      data: JSON.parse(JSON.stringify(data)),
      config: JSON.parse(JSON.stringify(config)),
      timestamp: Date.now()
    });
    
    // Dynamic timeout based on data size
    const dataSize = JSON.stringify(data).length;
    const baseTimeout = 25000; // 25 seconds base
    const sizeMultiplier = Math.max(1, Math.ceil(dataSize / (1024 * 1024))); // 1 second per MB
    const dynamicTimeout = Math.min(baseTimeout + (sizeMultiplier * 10000), 120000); // Add 10 seconds per MB, max 2 minutes
    
    setTimeout(() => {
      const processingTime = Date.now() - startTime;
      logError(`Time series data processing timeout after ${processingTime}ms for message ID: ${messageId} (data size: ${(dataSize / 1024 / 1024).toFixed(2)}MB, timeout: ${dynamicTimeout}ms)`);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error('Time series data processing timeout'));
    }, dynamicTimeout);
  });
}

/**
 * Process scatter data using Web Worker
 */
export async function processScatterDataWithWorker(
  data: any[], 
  config: any
): Promise<any> {
  // Use dynamic import to avoid circular dependency
  const { default: ScatterWorker } = await import('../workers/scatter-data-processor.ts?worker');
  const worker = new ScatterWorker();
  
  return new Promise((resolve, reject) => {
    
    if (!worker) {
      reject(new Error('Failed to create scatter data processor worker'));
      return;
    }
    
    const messageId = `scatter-${Date.now()}-${Math.random()}`;
    const startTime = Date.now();
    
    log(`Starting scatter data processing for ${data.length} data points with message ID: ${messageId}`);
    
    const handleMessage = (event: MessageEvent) => {
      if (event.data.id === messageId && event.data.type === 'SCATTER_DATA_PROCESSED') {
        const processingTime = Date.now() - startTime;
        log(`Scatter data processing completed in ${processingTime}ms for message ID: ${messageId}`);
        
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          const result = JSON.parse(JSON.stringify(event.data.result));
          worker.terminate();
          resolve(result);
        } else {
          worker.terminate();
          reject(new Error(event.data.error || 'Scatter data processing failed'));
        }
      }
    };
    
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', (error) => {
      logError('Scatter worker error:', error);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error(`Worker error: ${error.message}`));
    });
    
    worker.postMessage({
      id: messageId,
      type: 'PROCESS_SCATTER_DATA',
      data: JSON.parse(JSON.stringify(data)),
      config: JSON.parse(JSON.stringify(config)),
      timestamp: Date.now()
    });
    
    // Dynamic timeout based on data size
    const dataSize = JSON.stringify(data).length;
    const baseTimeout = 20000; // 20 seconds base
    const sizeMultiplier = Math.max(1, Math.ceil(dataSize / (1024 * 1024))); // 1 second per MB
    const dynamicTimeout = Math.min(baseTimeout + (sizeMultiplier * 8000), 90000); // Add 8 seconds per MB, max 90 seconds
    
    setTimeout(() => {
      const processingTime = Date.now() - startTime;
      logError(`Scatter data processing timeout after ${processingTime}ms for message ID: ${messageId} (data size: ${(dataSize / 1024 / 1024).toFixed(2)}MB, timeout: ${dynamicTimeout}ms)`);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error('Scatter data processing timeout'));
    }, dynamicTimeout);
  });
}

// Legacy function for backward compatibility
export async function processWindDataWithWorker(
  data: WindDataItem[], 
  config: WindProcessingConfig
): Promise<WindProcessingResult> {
  return processRoseDataWithWorker(data, config);
}


/**
 * Process data filtering using Web Worker
 */
export async function processDataFilteringWithWorker(
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
): Promise<DataFilteringResult> {
  // Use dynamic import to avoid circular dependency
  const { default: DataFilteringWorker } = await import('../workers/data-filtering-processor.ts?worker');
  const worker = new DataFilteringWorker();
  
  return new Promise((resolve, reject) => {
    
    if (!worker) {
      reject(new Error('Failed to create data filtering processor worker'));
      return;
    }
    
    const messageId = `filter-${Date.now()}-${Math.random()}`;
    
    const handleMessage = (event: MessageEvent) => {
      // Only process messages with matching ID to prevent cross-contamination
      if (event.data.id === messageId && event.data.type === 'DATA_FILTERING_PROCESSED') {
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          // Create a deep copy of the result to prevent mutation
          const result = JSON.parse(JSON.stringify(event.data.result));
          worker.terminate(); // Clean up the worker
          resolve(result);
        } else {
          worker.terminate(); // Clean up the worker
          reject(new Error(event.data.error || 'Data filtering processing failed'));
        }
      }
    };
    
    worker.addEventListener('message', handleMessage);
    
    worker.postMessage({
      id: messageId,
      type: 'PROCESS_DATA_FILTERING',
      data: JSON.parse(JSON.stringify(data)), // Deep copy input data
      config: JSON.parse(JSON.stringify(config)), // Deep copy config
      selectedEvents: selectedEvents ? JSON.parse(JSON.stringify(selectedEvents)) : undefined,
      eventTimeRanges: eventTimeRanges,
      timestamp: Date.now()
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error('Data filtering processing timeout'));
    }, 30000);
  });
}

/**
 * Terminate all workers
 */
export function terminateAllWorkers(): void {
  workerCache.forEach((worker) => {
    worker.terminate();
  });
  workerCache.clear();
}

/**
 * Terminate a specific worker type
 */
export function terminateWorker(type: string): void {
  const worker = workerCache.get(type);
  if (worker) {
    worker.terminate();
    workerCache.delete(type);
    }
  }

  /**
 * Get worker statistics
 */
export function getWorkerStats(): { activeWorkers: number; workerTypes: string[] } {
  return {
    activeWorkers: workerCache.size,
    workerTypes: Array.from(workerCache.keys())
  };
}

/**
 * Generic data processing function (fallback for compatibility)
 */
export async function processData(data: any[], config?: any): Promise<any[]> {
  // For now, just return the data as-is
  // This can be enhanced later with actual worker processing
  return data;
}

/**
 * Generic data compression function (fallback for compatibility)
 */
export async function compressData(data: any[], config?: any): Promise<{ data: any[]; compressionRatio: number }> {
  // For now, just return the data as-is with no compression
  // This can be enhanced later with actual compression logic
  return {
    data: data,
    compressionRatio: 1.0
  };
}

/**
 * Generic data filtering function (fallback for compatibility)
 */
export async function filterData(data: any[], filters: any[]): Promise<any[]> {
  // For now, just return the data as-is
  // This can be enhanced later with actual filtering logic
  return data;
}

/**
 * Generic chart data processing function (fallback for compatibility)
 */
export async function processChartData(data: any[], chartType: string, config?: any): Promise<any[]> {
  // For now, just return the data as-is
  // This can be enhanced later with actual chart processing logic
  return data;
}

/**
 * Generic data validation function (fallback for compatibility)
 */
export async function validateData(data: any[], config?: any): Promise<{ valid: boolean; errors: string[] }> {
  // For now, just return valid with no errors
  // This can be enhanced later with actual validation logic
  return {
    valid: true,
    errors: []
  };
}

/**
 * Map data processing function (fallback for compatibility)
 */
export async function processMapDataWithWorker(data: any[], config?: any): Promise<any[]> {
  // For now, just return the data as-is
  // This can be enhanced later with actual map data processing logic
  return data;
}

/**
 * Process D3 calculations using Web Worker
 */
export async function processD3CalculationsWithWorker(
  data: any[], 
  config: D3CalculationsConfig
): Promise<D3CalculationsResult> {
  // Use dynamic import to avoid circular dependency
  const { default: D3CalculationsWorker } = await import('../workers/d3-calculations-processor.ts?worker');
  const worker = new D3CalculationsWorker();
  
  return new Promise((resolve, reject) => {
    
    if (!worker) {
      logError(`[D3 Calculations Worker] Failed to create worker`);
      reject(new Error(`Failed to create D3 calculations worker. This may be due to HTTPS/SharedArrayBuffer requirements, browser compatibility, or worker file not found in production build.`));
      return;
    }
    
    const messageId = `d3-${Date.now()}-${Math.random()}`;
    
    // Dynamic timeout based on data size - HTTPS may add overhead
    const dataSize = JSON.stringify(data).length;
    const sizeMultiplier = dataSize / (1024 * 1024); // Size in MB
    const baseTimeout = 60000; // 60 seconds base (increased from 30s for HTTPS)
    const dynamicTimeout = Math.min(baseTimeout + (sizeMultiplier * 20000), 300000); // Add 20 seconds per MB, max 5 minutes
    
    let timeoutId: ReturnType<typeof setTimeout>;
    
    const handleMessage = (event: MessageEvent) => {
      // Only process messages with matching ID to prevent cross-contamination
      if (event.data.id === messageId && event.data.type === 'D3_CALCULATIONS_PROCESSED') {
        clearTimeout(timeoutId);
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          // Create a deep copy of the result to prevent mutation
          const result = JSON.parse(JSON.stringify(event.data.result));
          worker.terminate(); // Clean up the worker
          resolve(result);
        } else {
          worker.terminate(); // Clean up the worker
          reject(new Error(event.data.error || 'D3 calculations processing failed'));
        }
      }
    };
    
    worker.addEventListener('message', handleMessage);
    
    // Handle worker errors (initialization failures, etc.)
    worker.onerror = (error: ErrorEvent) => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      
      // Log detailed error information for debugging
      const errorInfo = {
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno,
        error: error.error ? String(error.error) : undefined,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        location: typeof window !== 'undefined' ? window.location.href : 'unknown'
      };
      
      logError(`[D3 Calculations Worker] Worker error occurred:`, errorInfo);
      
      // Provide more helpful error message
      let errorMsg = `D3 calculations worker error: ${error.message || 'Unknown worker error'}`;
      if (!errorInfo.hasSharedArrayBuffer) {
        errorMsg += '. SharedArrayBuffer is not available - check COOP/COEP headers.';
      } else if (!error.filename && !error.message) {
        errorMsg += '. Worker file may not be accessible in production build.';
      } else {
        errorMsg += '. This may be due to HTTPS/SharedArrayBuffer requirements or worker file loading issues.';
      }
      
      reject(new Error(errorMsg));
    };
    
    // Set timeout
    timeoutId = setTimeout(() => {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error(`D3 calculations processing timeout after ${dynamicTimeout}ms (data size: ${(dataSize / 1024 / 1024).toFixed(2)}MB). This may be due to HTTPS overhead or large dataset size.`));
    }, dynamicTimeout);
    
    try {
      worker.postMessage({
      id: messageId,
      type: 'PROCESS_D3_CALCULATIONS',
      data: JSON.parse(JSON.stringify(data)), // Deep copy input data
      config: JSON.parse(JSON.stringify(config)), // Deep copy config
      timestamp: Date.now()
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error(`Failed to send data to D3 calculations worker: ${error?.message || String(error)}`));
    }
  });
}

/**
 * Process overlay data using Web Worker
 */
export async function processOverlayDataWithWorker(
  data: { channelDataMap: Record<string, any[]>; channels: any[]; formattedDate: string },
  config: OverlayProcessingConfig
): Promise<OverlayProcessingResult> {
  // Use ?url for workers with store dependencies to avoid circular bundling issues
  const overlayWorkerUrl = (await import('../workers/overlay-data-processor.ts?url')).default;
  const worker = createModuleWorker(overlayWorkerUrl);
  
  if (!worker) {
    throw new Error('Failed to create overlay data processor worker');
  }
  
  return new Promise((resolve, reject) => {
    
    const messageId = `overlay-${Date.now()}-${Math.random()}`;
    const startTime = Date.now();
    
    
    const handleMessage = (event: MessageEvent) => {
      // Only process messages with matching ID to prevent cross-contamination
      if (event.data.id === messageId && event.data.type === 'OVERLAY_DATA_PROCESSED') {
        const processingTime = Date.now() - startTime;
        
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          // Create a deep copy of the result to prevent mutation
          const result = JSON.parse(JSON.stringify(event.data.result));
          worker.terminate(); // Clean up the worker
          resolve(result);
        } else {
          worker.terminate(); // Clean up the worker
          reject(new Error(event.data.error || 'Overlay data processing failed'));
        }
      }
    };
    
    worker.addEventListener('message', handleMessage);
    
    // Add error handling for worker
    worker.addEventListener('error', (error) => {
      logError('Overlay worker error:', error);
      logError('Worker error details:', {
        type: error.type,
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno
      });
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error(`Worker error: ${error.message || error.type || 'Unknown worker error'}`));
    });
    
    worker.postMessage({
      id: messageId,
      type: 'PROCESS_OVERLAY_DATA',
      data: JSON.parse(JSON.stringify(data)), // Deep copy input data
      config: JSON.parse(JSON.stringify(config)), // Deep copy config
      timestamp: Date.now()
    });
    
    // Dynamic timeout based on data size - allow more time for larger datasets
    const dataSize = JSON.stringify(data).length;
    const baseTimeout = 60000; // 60 seconds base (increased from 30s)
    const sizeMultiplier = Math.max(1, Math.ceil(dataSize / (1024 * 1024))); // 1 second per MB
    const dynamicTimeout = Math.min(baseTimeout + (sizeMultiplier * 15000), 300000); // Add 15 seconds per MB, max 5 minutes
    
    setTimeout(() => {
      const processingTime = Date.now() - startTime;
      logError(`Overlay data processing timeout after ${processingTime}ms for message ID: ${messageId} (data size: ${(dataSize / 1024 / 1024).toFixed(2)}MB, timeout: ${dynamicTimeout}ms)`);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error('Overlay data processing timeout'));
    }, dynamicTimeout);
  });
}

/**
 * Async data sorting with chunked processing
 */
async function sortDataAsync(data: any[], chunkSize: number = 1000): Promise<DatetimeSortingResult> {
  const startTime = performance.now();
  
  // For very small datasets, sort synchronously
  if (data.length < 100) {
    const sortedData = data.sort((a, b) => {
      const timeA = a.timestamp || new Date(a.Datetime).getTime();
      const timeB = b.timestamp || new Date(b.Datetime).getTime();
      return timeA - timeB;
    });
    
    return {
      sortedData,
      processingTime: performance.now() - startTime
    };
  }
  
  // For larger datasets, sort in chunks
  return new Promise((resolve) => {
    const sortedChunks: any[][] = [];
    let index = 0;
    
    const processChunk = () => {
      const chunk = data.slice(index, index + chunkSize);
      const sortedChunk = chunk.sort((a, b) => {
        const timeA = a.timestamp || new Date(a.Datetime).getTime();
        const timeB = b.timestamp || new Date(b.Datetime).getTime();
        return timeA - timeB;
      });
      sortedChunks.push(sortedChunk);
      
      index += chunkSize;
      
      if (index < data.length) {
        // Yield control and continue processing
        setTimeout(processChunk, 0);
      } else {
        // Merge sorted chunks
        const merged = mergeSortedChunks(sortedChunks);
        resolve({
          sortedData: merged,
          processingTime: performance.now() - startTime
        });
      }
    };
    
    processChunk();
  });
}

/**
 * Merge sorted chunks efficiently
 */
function mergeSortedChunks(chunks: any[][]): any[] {
  if (chunks.length === 1) return chunks[0];
  
  const result: any[] = [];
  const indices = new Array(chunks.length).fill(0);
  
  while (true) {
    let minIndex = -1;
    let minValue = Infinity;
    
    for (let i = 0; i < chunks.length; i++) {
      if (indices[i] < chunks[i].length) {
        const value = chunks[i][indices[i]].timestamp || new Date(chunks[i][indices[i]].Datetime).getTime();
        if (value < minValue) {
          minValue = value;
          minIndex = i;
        }
      }
    }
    
    if (minIndex === -1) break;
    
    result.push(chunks[minIndex][indices[minIndex]]);
    indices[minIndex]++;
  }
  
  return result;
}

/**
 * Process datetime sorting with worker
 */
export async function processDatetimeSortingWithWorker(
  data: any[]
): Promise<DatetimeSortingResult> {
  if (!data || data.length === 0) {
    return {
      sortedData: [],
      processingTime: 0
    };
  }

  // For small datasets, use async chunked processing instead of sync
  if (data.length < 1000) {
    return await sortDataAsync(data);
  }

  // For medium datasets, use async chunked processing
  if (data.length < 10000) {
    return await sortDataAsync(data);
  }

  // For very large datasets, use async chunked processing with smaller chunks
  if (data.length > 50000) {
    return await sortDataAsync(data, 500); // Smaller chunks for very large datasets
  }

  // For medium-large datasets, use worker
  const worker = await getWorker('datetime-sorting');
  const messageId = `datetime-sorting-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent) => {
      log('[DatetimeSortingManager] Received message:', event.data);
      
      if (event.data.id === messageId) {
        log(`[DatetimeSortingManager] Processing response for message ${messageId}`);
        worker.removeEventListener('message', handleMessage);
        
        if (event.data.success) {
          log(`[DatetimeSortingManager] Successfully sorted ${event.data.result?.sortedData?.length || 0} items`);
          resolve(event.data.result);
        } else {
          logError(`[DatetimeSortingManager] Worker error:`, event.data.error);
          reject(new Error(event.data.error || 'Datetime sorting failed'));
        }
      }
    };

    worker.addEventListener('message', handleMessage);
    
    const message = {
      id: messageId,
      type: 'SORT_BY_DATETIME',
      data: data,
      timestamp: Date.now()
    };
    
    log(`[DatetimeSortingManager] Sending message to worker:`, {
      id: messageId,
      type: 'SORT_BY_DATETIME',
      dataLength: data.length,
      timestamp: Date.now()
    });
    
    worker.postMessage(message);

    // Set timeout for datetime sorting - more generous for large datasets
    const timeout = Math.min(120000, 5000 + (data.length * 5)); // 5 second base + 5ms per item, max 2 minutes
    
    setTimeout(() => {
      const processingTime = Date.now() - startTime;
      logError(`Datetime sorting timeout after ${processingTime}ms for message ID: ${messageId} (data size: ${data.length} items, timeout: ${timeout}ms)`);
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      reject(new Error('Datetime sorting timeout'));
    }, timeout);
  });
}

/**
 * Persist timeseries data to HuniDB using a background worker
 * This allows non-blocking writes while the UI renders immediately
 */
export async function persistToHuniDBWithWorker(
  className: string,
  datasetId: string,
  projectId: string,
  sourceId: string,
  channels: string[],
  data: Array<Record<string, any>>
): Promise<void> {
  // Use ?url for workers with store dependencies to avoid circular bundling issues
  const hunidbWorkerUrl = (await import('../workers/hunidb-persistence-worker.ts?url')).default;
  const worker = createModuleWorker(hunidbWorkerUrl);
  
  if (!worker) {
    throw new Error(`Failed to create HuniDB persistence worker`);
  }
  
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    
    if (!worker) {
      reject(new Error(`Failed to create HuniDB persistence worker`));
      return;
    }
    
    const jobId = `${Date.now()}-${Math.random()}`;
    
    // Set a timeout to prevent hanging forever
    // Increased timeout for HTTPS and large datasets
    const dataSize = JSON.stringify(data).length;
    const sizeMultiplier = dataSize / (1024 * 1024); // Size in MB
    const baseTimeout = 120000; // 120 seconds base (increased from 60s for HTTPS)
    const dynamicTimeout = Math.min(baseTimeout + (sizeMultiplier * 30000), 600000); // Add 30 seconds per MB, max 10 minutes
    
    timeoutId = setTimeout(() => {
      worker.terminate();
      reject(new Error(`HuniDB persistence worker timeout - operation took too long (timeout: ${dynamicTimeout}ms, data size: ${(dataSize / 1024 / 1024).toFixed(2)}MB). This may be due to HTTPS overhead or large dataset size.`));
    }, dynamicTimeout);
    
    // Handle worker errors (initialization failures, etc.)
    worker.onerror = (error: ErrorEvent) => {
      clearTimeout(timeoutId);
      worker.terminate();
      const errorMessage = error.message || error.filename 
        ? `Worker error at ${error.filename}:${error.lineno}: ${error.message || 'Unknown error'}`
        : 'Worker initialization or execution failed. This may be due to missing SharedArrayBuffer support (required for SQLite/OPFS in workers) or HTTPS configuration issues.';
      reject(new Error(errorMessage));
    };
    
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.id === jobId) {
        clearTimeout(timeoutId);
        if (event.data.type === 'PERSIST_SUCCESS') {
          worker.terminate();
          resolve();
        } else if (event.data.type === 'PERSIST_ERROR') {
          worker.terminate();
          const errorMsg = event.data.error || 'Unknown worker error';
          reject(new Error(`HuniDB persistence failed: ${errorMsg}`));
        }
      }
    };
    
    // Send the job to the worker
    try {
      worker.postMessage({
        type: 'PERSIST_DATA',
        payload: { className, datasetId, projectId, sourceId, channels, data, id: jobId }
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      worker.terminate();
      reject(new Error(`Failed to send job to worker: ${error?.message || String(error)}`));
    }
  });
}