/**
 * Data Compressor Worker
 * 
 * Handles data compression operations including:
 * - Smart data sampling
 * - Data compression algorithms
 * - Memory optimization
 * - Data size management
 */

import type { 
  WorkerMessage, 
  WorkerResponse, 
  CompressibleDataItem, 
  CompressionResult,
  CompressionMetadata,
  CompressionAlgorithm,
  DataStatistics,
  FieldStatistics,
  MetadataOnlyItem
} from './types';

interface CompressionConfig {
  targetSize?: number;
  algorithm?: CompressionAlgorithm;
  preserveStructure?: boolean;
  compressionThreshold?: number;
  ultraCompressionThreshold?: number;
  metadataOnlyThreshold?: number;
}

// Worker message handler
self.onmessage = function(e: MessageEvent<WorkerMessage<CompressibleDataItem[], CompressionConfig>>) {
  const { id, type, data, config } = e.data;
  
  try {
    let result: CompressionResult;
    
    switch (type) {
      case 'data-compressor':
        result = compressData(data, config);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send result back to main thread
    const response: WorkerResponse<CompressionResult> = {
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
 * Compress data using various algorithms
 */
function compressData(data: CompressibleDataItem[], config: CompressionConfig = {}): CompressionResult {
  if (!Array.isArray(data)) {
    throw new Error('Data must be an array');
  }

  const {
    targetSize = 8000,
    algorithm = 'smart-sampling',
    preserveStructure = true,
    compressionThreshold = 1000,
    ultraCompressionThreshold = 5000,
    metadataOnlyThreshold = 15000
  } = config;

  // If data is small enough, return as-is
  if (data.length <= compressionThreshold) {
    return {
      data,
      originalSize: data.length,
      compressedSize: data.length,
      compressionRatio: 1,
      algorithm,
      metadata: {
        originalSize: data.length,
        compressedSize: data.length,
        compressionRatio: 1,
        algorithm,
        timestamp: Date.now()
      }
    };
  }

  let compressedData: CompressibleDataItem[];

  switch (algorithm) {
    case 'smart-sampling':
      compressedData = smartSampleData(data, targetSize);
      break;
    case 'uniform-sampling':
      compressedData = uniformSampleData(data, targetSize);
      break;
    case 'statistical-sampling':
      compressedData = statisticalSampleData(data, targetSize);
      break;
    case 'time-based-sampling':
      compressedData = timeBasedSampleData(data, targetSize);
      break;
    case 'metadata-only':
      compressedData = createMetadataOnly(data);
      break;
    default:
      compressedData = smartSampleData(data, targetSize);
  }

  return {
    data: compressedData,
    originalSize: data.length,
    compressedSize: compressedData.length,
    compressionRatio: compressedData.length / data.length,
    algorithm,
    metadata: {
      originalSize: data.length,
      compressedSize: compressedData.length,
      compressionRatio: compressedData.length / data.length,
      algorithm,
      timestamp: Date.now()
    }
  };
}

/**
 * Smart sampling that preserves important data points
 */
function smartSampleData(data: CompressibleDataItem[], targetSize: number): CompressibleDataItem[] {
  if (data.length <= targetSize) {
    return data;
  }

  const step = Math.ceil(data.length / targetSize);
  const compressed: CompressibleDataItem[] = [];

  // Always include first and last points
  compressed.push(data[0]);

  // Sample middle points with smart selection
  for (let i = step; i < data.length - step; i += step) {
    // Find the most representative point in this range
    const rangeStart = Math.max(0, i - Math.floor(step / 2));
    const rangeEnd = Math.min(data.length - 1, i + Math.floor(step / 2));

    // Select the point with the most significant change (if applicable)
    let bestPoint = data[i];
    if (data[i].y !== undefined && data[i].x !== undefined) {
      let maxChange = 0;
      for (let j = rangeStart; j <= rangeEnd; j++) {
        if (j > 0 && data[j].y !== undefined && data[j - 1].y !== undefined) {
          const change = Math.abs(data[j].y! - data[j - 1].y!);
          if (change > maxChange) {
            maxChange = change;
            bestPoint = data[j];
          }
        }
      }
    }

    compressed.push(bestPoint);
  }

  // Always include the last point
  compressed.push(data[data.length - 1]);

  return compressed;
}

/**
 * Uniform sampling with equal intervals
 */
function uniformSampleData(data: CompressibleDataItem[], targetSize: number): CompressibleDataItem[] {
  if (data.length <= targetSize) {
    return data;
  }

  const step = data.length / targetSize;
  const compressed: CompressibleDataItem[] = [];

  for (let i = 0; i < targetSize; i++) {
    const index = Math.floor(i * step);
    compressed.push(data[index]);
  }

  return compressed;
}

/**
 * Statistical sampling based on data distribution
 */
function statisticalSampleData(data: CompressibleDataItem[], targetSize: number): CompressibleDataItem[] {
  if (data.length <= targetSize) {
    return data;
  }

  // Calculate data statistics
  const stats = calculateDataStatistics(data);
  const compressed: CompressibleDataItem[] = [];

  // Sample based on statistical significance
  const step = data.length / targetSize;
  let lastSignificantIndex = 0;

  for (let i = 0; i < targetSize; i++) {
    const targetIndex = Math.floor(i * step);
    let bestIndex = targetIndex;

    // Look for statistically significant points near the target
    const searchRange = Math.min(step / 2, 10);
    for (let j = Math.max(0, targetIndex - searchRange); 
         j < Math.min(data.length, targetIndex + searchRange); j++) {
      
      if (isStatisticallySignificant(data[j], stats)) {
        bestIndex = j;
        break;
      }
    }

    // Ensure we don't go backwards
    if (bestIndex > lastSignificantIndex) {
      compressed.push(data[bestIndex]);
      lastSignificantIndex = bestIndex;
    }
  }

  return compressed;
}

/**
 * Time-based sampling for time series data
 */
function timeBasedSampleData(data: CompressibleDataItem[], targetSize: number): CompressibleDataItem[] {
  if (data.length <= targetSize) {
    return data;
  }

  // Check if data has time-based structure
  const hasTimeField = data.some(item => item.Datetime || item.timestamp || item.time);
  
  if (!hasTimeField) {
    return smartSampleData(data, targetSize);
  }

  const compressed: CompressibleDataItem[] = [];
  const timeField = data[0].Datetime ? 'Datetime' : 
                   data[0].timestamp ? 'timestamp' : 'time';

  // Sort by time
  const sortedData = [...data].sort((a, b) => {
    const timeA = new Date(a[timeField]!).getTime();
    const timeB = new Date(b[timeField]!).getTime();
    return timeA - timeB;
  });

  // Sample at regular time intervals
  const startTime = new Date(sortedData[0][timeField]!).getTime();
  const endTime = new Date(sortedData[sortedData.length - 1][timeField]!).getTime();
  const timeStep = (endTime - startTime) / targetSize;

  compressed.push(sortedData[0]);

  for (let i = 1; i < targetSize - 1; i++) {
    const targetTime = startTime + (i * timeStep);
    const closestIndex = findClosestTimeIndex(sortedData, targetTime, timeField);
    compressed.push(sortedData[closestIndex]);
  }

  compressed.push(sortedData[sortedData.length - 1]);

  return compressed;
}

/**
 * Create metadata-only representation
 */
function createMetadataOnly(data: CompressibleDataItem[]): CompressibleDataItem[] {
  if (data.length === 0) {
    return [];
  }

  const sample = data[0];
  const metadata: MetadataOnlyItem = {
    count: data.length,
    fields: Object.keys(sample),
    sample: sample,
    statistics: calculateDataStatistics(data),
    timestamp: Date.now()
  };

  return [metadata as unknown as CompressibleDataItem];
}

/**
 * Calculate data statistics
 */
function calculateDataStatistics(data: CompressibleDataItem[]): DataStatistics {
  if (data.length === 0) {
    return {};
  }

  const stats: DataStatistics = {};
  const fields = Object.keys(data[0]);

  fields.forEach(field => {
    const values = data.map(item => item[field]).filter(v => v !== undefined && v !== null);
    
    if (values.length === 0) {
      stats[field] = { count: 0 };
      return;
    }

    const numericValues = values.filter(v => !isNaN(Number(v))).map(v => Number(v));
    
    if (numericValues.length > 0) {
      stats[field] = {
        count: values.length,
        numeric: true,
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
        avg: numericValues.reduce((sum, val) => sum + val, 0) / numericValues.length,
        sum: numericValues.reduce((sum, val) => sum + val, 0)
      };
    } else {
      stats[field] = {
        count: values.length,
        numeric: false,
        unique: [...new Set(values)].length,
        sample: values[0]
      };
    }
  });

  return stats;
}

/**
 * Check if a data point is statistically significant
 */
function isStatisticallySignificant(point: CompressibleDataItem, stats: DataStatistics): boolean {
  // Simple significance check - can be enhanced
  const numericFields = Object.keys(stats).filter(field => stats[field].numeric);
  
  for (const field of numericFields) {
    const value = Number(point[field]);
    const fieldStats = stats[field];
    
    if (!isNaN(value) && fieldStats.numeric && fieldStats.min !== undefined && fieldStats.max !== undefined && fieldStats.avg !== undefined) {
      const zScore = Math.abs((value - fieldStats.avg) / (fieldStats.max - fieldStats.min));
      if (zScore > 0.5) { // Threshold for significance
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Find closest time index
 */
function findClosestTimeIndex(data: CompressibleDataItem[], targetTime: number, timeField: string): number {
  let closestIndex = 0;
  let closestDiff = Math.abs(new Date(data[0][timeField]!).getTime() - targetTime);

  for (let i = 1; i < data.length; i++) {
    const diff = Math.abs(new Date(data[i][timeField]!).getTime() - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }

  return closestIndex;
}

/**
 * Calculate compression ratio
 */
function calculateCompressionRatio(originalSize: number, compressedSize: number): number {
  return compressedSize / originalSize;
}

/**
 * Estimate memory usage
 */
function estimateMemoryUsage(data: CompressibleDataItem[]): number {
  try {
    return new Blob([JSON.stringify(data)]).size;
  } catch (error) {
    return 0;
  }
}
