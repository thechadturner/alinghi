/**
 * Overlay Data Processor Worker
 * 
 * Handles overlay data processing operations including:
 * - Channel data aggregation and formatting
 * - Time-based data processing
 * - Binary search for nearest time lookup
 * - Data transformation and cleaning
 */

import { warn, error as logError, log } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  DataItem
} from './types';
import type { 
  OverlayProcessingConfig, 
  OverlayProcessingResult 
} from './overlay-types';


interface OverlayProcessingMessage extends WorkerMessage {
  type: 'PROCESS_OVERLAY_DATA';
  data: {
    channelDataMap: Record<string, any[]>;
    channels: Array<{
      name: string;
      type: string;
      color?: string;
    }>;
    formattedDate: string;
  };
  config: OverlayProcessingConfig;
}

interface OverlayProcessingResponse extends WorkerResponse {
  type: 'OVERLAY_DATA_PROCESSED';
  result: OverlayProcessingResult;
}

interface BinarySearchMessage extends WorkerMessage {
  type: 'BINARY_SEARCH';
  data: {
    sortedData: any[];
    targetDatetime: string;
  };
}

interface BinarySearchResponse extends WorkerResponse {
  type: 'BINARY_SEARCH_COMPLETE';
  result: any | null;
}

// Worker message handler
self.onmessage = (event: MessageEvent<OverlayProcessingMessage | BinarySearchMessage>) => {
  const { id, type } = event.data;
  
  if (type === 'BINARY_SEARCH') {
    const { data } = event.data as BinarySearchMessage;
    try {
      const result = findClosestBinarySearch(data.sortedData, data.targetDatetime);
      
      const response: BinarySearchResponse = {
        id,
        type: 'BINARY_SEARCH_COMPLETE',
        success: true,
        result,
        duration: Date.now() - event.data.timestamp
      };
      
      self.postMessage(response);
    } catch (error) {
      logError('Binary search worker error:', error);
      
      const response: BinarySearchResponse = {
        id,
        type: 'BINARY_SEARCH_COMPLETE',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - event.data.timestamp,
        result: null
      };
      
      self.postMessage(response);
    }
  } else if (type === 'PROCESS_OVERLAY_DATA') {
    const { data, config } = event.data as OverlayProcessingMessage;
    
    // Use async processing for better performance
    processOverlayDataAsync(data, config)
      .then(result => {
        const response: OverlayProcessingResponse = {
          id,
          type: 'OVERLAY_DATA_PROCESSED',
          success: true,
          result,
        duration: Date.now() - event.data.timestamp
      };
      
        self.postMessage(response);
      })
      .catch(error => {
        // Fallback to sync processing for small datasets
        try {
          const result = processOverlayDataSync(data, config);
          
          const response: OverlayProcessingResponse = {
            id,
            type: 'OVERLAY_DATA_PROCESSED',
            success: true,
            result,
            duration: Date.now() - event.data.timestamp
          };
          
          self.postMessage(response);
        } catch (fallbackError) {
          logError('Overlay worker error (both async and sync failed):', fallbackError);
          
          const response: OverlayProcessingResponse = {
            id,
            type: 'OVERLAY_DATA_PROCESSED',
            success: false,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            duration: Date.now() - event.data.timestamp,
            result: {
              data: [],
              channels: [],
              processingTime: 0,
              originalCount: 0,
              processedCount: 0,
              metadata: {
                timeRange: { start: 0, end: 0 },
                channelCount: 0
              }
            }
          };
          
          self.postMessage(response);
        }
      });
  }
};

/**
 * Process overlay data asynchronously with chunked processing
 */
async function processOverlayDataAsync(
  data: { channelDataMap: Record<string, any[]>; channels: any[]; formattedDate: string },
  config: OverlayProcessingConfig
): Promise<OverlayProcessingResult> {
  const startTime = performance.now();
  
  const { channelDataMap, channels, formattedDate } = data;
  const chunkSize = config.chunkSize || 1000;
  
  // Debug logging
  log('Overlay worker processing:', {
    channelKeys: Object.keys(channelDataMap),
    channelCount: channels.length,
    datetimeCount: channelDataMap["Datetime"]?.length || 0,
    totalChannels: Object.keys(channelDataMap).length
  });
  
  // Build the final data array for overlay display
  const datetimeArr = channelDataMap["Datetime"] || [];
  
  // Early exit for extremely large datasets
  if (datetimeArr.length > 500000) { // 500k points
    warn(`Overlay worker: Dataset extremely large (${datetimeArr.length} points), using aggressive sampling`);
    const step = Math.ceil(datetimeArr.length / 50000); // Sample down to 50k points
    const sampledDatetimeArr = await sampleDataAsync(datetimeArr, step);
    return {
      data: sampledDatetimeArr.map(item => ({ Datetime: item.Datetime })),
      channels,
      processingTime: 0,
      originalCount: datetimeArr.length,
      processedCount: sampledDatetimeArr.length,
      metadata: {
        timeRange: { start: 0, end: 0 },
        channelCount: channels.length
      }
    };
  }
  
  // Check if dataset is too large and limit processing with smarter sampling
  const maxDataPoints = 100000; // Increased limit to 100k points
  let limitedDatetimeArr;
  
  if (datetimeArr.length > maxDataPoints) {
    // Use smart sampling instead of just taking the first N points
    const step = Math.ceil(datetimeArr.length / maxDataPoints);
    limitedDatetimeArr = await sampleDataAsync(datetimeArr, step);
    warn(`Overlay worker: Dataset too large (${datetimeArr.length} points), sampling to ${limitedDatetimeArr.length} points (every ${step}th point)`);
  } else {
    limitedDatetimeArr = datetimeArr;
  }
  
  // Sort the datetime array asynchronously
  limitedDatetimeArr = await sortDataAsync(limitedDatetimeArr);
  
  // Process data asynchronously with chunked processing
  const processedData = await processDataChunked(limitedDatetimeArr, channels, channelDataMap, maxDataPoints, chunkSize);
  
  const processingTime = performance.now() - startTime;
  
  return {
    data: processedData,
    channels,
    processingTime,
    originalCount: datetimeArr.length,
    processedCount: processedData.length,
    metadata: {
      timeRange: { start: 0, end: 0 },
      channelCount: channels.length
    }
  };
}

/**
 * Sample data asynchronously to avoid blocking
 */
async function sampleDataAsync(data: any[], step: number): Promise<any[]> {
  return new Promise((resolve) => {
    if (data.length < 10000) {
      // Small dataset - process synchronously
      resolve(data.filter((_, index) => index % step === 0));
      return;
    }
    
    // Large dataset - process in chunks
    const result: any[] = [];
    let index = 0;
    
    const processChunk = () => {
      const endIndex = Math.min(index + 1000, data.length);
      
      for (let i = index; i < endIndex; i++) {
        if (i % step === 0) {
          result.push(data[i]);
        }
      }
      
      index = endIndex;
      
      if (index < data.length) {
        // Yield control and continue processing
        setTimeout(processChunk, 0);
      } else {
        resolve(result);
      }
    };
    
    processChunk();
  });
}

/**
 * Sort data asynchronously to avoid blocking
 */
async function sortDataAsync(data: any[]): Promise<any[]> {
  return new Promise((resolve) => {
    if (data.length < 5000) {
      // Small dataset - sort synchronously
      resolve(data.sort((a, b) => new Date(a.Datetime).getTime() - new Date(b.Datetime).getTime()));
      return;
    }
    
    // Large dataset - sort in chunks
    const chunkSize = 1000;
    const sortedChunks: any[][] = [];
    let index = 0;
    
    const processChunk = () => {
      const chunk = data.slice(index, index + chunkSize);
      const sortedChunk = chunk.sort((a, b) => new Date(a.Datetime).getTime() - new Date(b.Datetime).getTime());
      sortedChunks.push(sortedChunk);
      
      index += chunkSize;
      
      if (index < data.length) {
        setTimeout(processChunk, 0);
      } else {
        // Merge sorted chunks
        const merged = mergeSortedChunks(sortedChunks);
        resolve(merged);
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
        const value = new Date(chunks[i][indices[i]].Datetime).getTime();
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
 * Process data in chunks to avoid blocking
 */
async function processDataChunked(
  datetimeArr: any[],
  channels: any[],
  channelDataMap: Record<string, any[]>,
  maxDataPoints: number,
  chunkSize: number
): Promise<any[]> {
  return new Promise((resolve) => {
    // Create lookup maps for faster access
    const channelLookupMaps: Record<string, Map<string, any>> = {};
    
    // Build lookup maps asynchronously
    const buildLookupMaps = async () => {
      for (const channel of channels) {
        if (channel.name !== 'Datetime' && channelDataMap[channel.name]) {
          const lookupMap = new Map();
          const channelData = channelDataMap[channel.name];
          
          // Apply same sampling logic as datetime array
          if (channelData.length > maxDataPoints) {
            const step = Math.ceil(channelData.length / maxDataPoints);
            const sampledChannelData = await sampleDataAsync(channelData, step);
            sampledChannelData.forEach(item => {
              lookupMap.set(item.Datetime, item.value);
            });
          } else {
            channelData.forEach(item => {
              lookupMap.set(item.Datetime, item.value);
            });
          }
          channelLookupMaps[channel.name] = lookupMap;
        }
      }
    };
    
    buildLookupMaps().then(() => {
      // Process data in chunks
      const processedData: any[] = [];
      let index = 0;
      
      const processChunk = () => {
        const endIndex = Math.min(index + chunkSize, datetimeArr.length);
        
        for (let i = index; i < endIndex; i++) {
          const item = datetimeArr[i];
          
          // Keep the original datetime format to avoid conversion issues
          const dataPoint: any = { Datetime: item.Datetime };
          
          // Add all channel values to the data point using fast lookup
          channels.forEach(channel => {
            if (channel.name !== 'Datetime' && channelLookupMaps[channel.name]) {
              const value = channelLookupMaps[channel.name].get(item.Datetime);
              if (value !== undefined) {
                dataPoint[channel.name] = value;
              }
            }
          });
          
          processedData.push(dataPoint);
        }
        
        index = endIndex;
        
        if (index < datetimeArr.length) {
          // Yield control and continue processing
          setTimeout(processChunk, 0);
        } else {
          resolve(processedData);
        }
      };
      
      processChunk();
    });
  });
}

/**
 * Process overlay data synchronously (fallback for small datasets)
 */
function processOverlayDataSync(
  data: { channelDataMap: Record<string, any[]>; channels: any[]; formattedDate: string },
  config: OverlayProcessingConfig
): OverlayProcessingResult {
  const startTime = performance.now();
  
  const { channelDataMap, channels, formattedDate } = data;
  const chunkSize = config.chunkSize || 1000;
  
  // Debug logging
  log('Overlay worker processing (sync fallback):', {
    channelKeys: Object.keys(channelDataMap),
    channelCount: channels.length,
    datetimeCount: channelDataMap["Datetime"]?.length || 0,
    totalChannels: Object.keys(channelDataMap).length
  });
  
  // Build the final data array for overlay display
  const datetimeArr = channelDataMap["Datetime"] || [];
  
  // For small datasets, process synchronously
  if (datetimeArr.length <= 1000) {
    const processedData = datetimeArr.map(item => {
      const dataPoint: any = { Datetime: item.Datetime };
      
      channels.forEach(channel => {
        if (channel.name !== 'Datetime' && channelDataMap[channel.name]) {
          const channelData = channelDataMap[channel.name];
          const matchingItem = channelData.find(ch => ch.Datetime === item.Datetime);
          if (matchingItem) {
            dataPoint[channel.name] = matchingItem.value;
          }
        }
      });
      
      return dataPoint;
    });
    
    return {
      data: processedData,
      channels,
      processingTime: performance.now() - startTime,
      originalCount: datetimeArr.length,
      processedCount: processedData.length,
      metadata: {
        timeRange: { start: 0, end: 0 },
        channelCount: channels.length
      }
    };
  }
  
  // For larger datasets, use async processing
  throw new Error('Dataset too large for sync processing, use async method');
}

/**
 * Binary search for finding closest time (optimized for overlay)
 */
function findClosestBinarySearch(sortedData: any[], targetDatetime: string | Date): any | null {
  if (!sortedData || sortedData.length === 0) {
    return null;
  }

  const targetTime = new Date(targetDatetime).getTime();
  if (isNaN(targetTime)) {
    return null;
  }

  let left = 0, right = sortedData.length - 1;
  let closestRecord = null;
  let closestDistance = Infinity;

  while (left <= right) {
    let mid = Math.floor((left + right) / 2);
    let midTime = new Date(sortedData[mid].Datetime).getTime();
    
    if (isNaN(midTime)) {
      break;
    }

    const distance = Math.abs(midTime - targetTime);
    if (distance < closestDistance) {
      closestRecord = sortedData[mid];
      closestDistance = distance;
    }

    if (midTime < targetTime) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return closestRecord;
}
