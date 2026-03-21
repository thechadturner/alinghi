/**
 * Rose Data Processor Worker
 * 
 * Handles polar rose chart data processing including:
 * - Direction binning (16 compass directions)
 * - Speed binning with configurable intervals
 * - Data validation and filtering
 * - Statistical calculations
 * - Chart-specific transformations
 */

import { log } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  WindDataItem,
  WindProcessingResult,
  WindProcessingConfig
} from './types';
import { error as logError } from '../utils/console';

interface RoseProcessingMessage extends WorkerMessage {
  type: 'PROCESS_ROSE_DATA';
  data: WindDataItem[];
  config: WindProcessingConfig;
}

interface RoseProcessingResponse extends WorkerResponse {
  id: string;
  type: 'ROSE_DATA_PROCESSED';
  result: WindProcessingResult;
}

// Worker message handler
self.onmessage = (event: MessageEvent<RoseProcessingMessage>) => {
  const { id, type, data, config } = event.data;
  
  if (type === 'PROCESS_ROSE_DATA') {
    log(`Rose worker received data processing request with ID: ${id}, data points: ${data.length}`);
    const startTime = performance.now();
    
    try {
      const result = processRoseData(data, config);
      const processingTime = performance.now() - startTime;
      
      log(`Rose worker completed data processing in ${processingTime.toFixed(2)}ms for ID: ${id}`);
      
      const response: RoseProcessingResponse = {
        id,
        type: 'ROSE_DATA_PROCESSED',
        success: true,
        result
      };
      
      self.postMessage(response);
    } catch (error) {
      const processingTime = performance.now() - startTime;
      logError(`Rose worker error in data processing after ${processingTime.toFixed(2)}ms for ID: ${id}:`, error);
      
      const response: RoseProcessingResponse = {
        id,
        type: 'ROSE_DATA_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        result: {
          directionBins: {},
          speedBinsData: {},
          totalCounts: {},
          maxValue: 0,
          speedRange: { min: 0, max: 0 },
          processedCount: 0,
          validDataCount: 0
        }
      };
      
      self.postMessage(response);
    }
  }
};

/**
 * Process rose data for polar rose visualization
 */
function processRoseData(data: WindDataItem[], config: WindProcessingConfig): WindProcessingResult {
  const {
    xAxisName = 'Twd',
    yAxisName = 'Tws',
    yAxisInterval = 1,
    binSize = 22.5, // 16 compass directions
    validate = true
  } = config;

  if (!Array.isArray(data)) {
    throw new Error('Rose data must be an array');
  }

  // Initialize direction bins (16 compass directions)
  const directions = [
    "0", "22.5", "45", "67.5", "90", "112.5", "135", "157.5",
    "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5"
  ];

  const directionBins: Record<string, number[]> = {};
  directions.forEach(dir => {
    directionBins[dir] = [];
  });

  let processedCount = 0;
  let validDataCount = 0;

  // Process each data point
  data.forEach((point) => {
    if (point[xAxisName] !== undefined && point[yAxisName] !== undefined) {
      validDataCount++;
      
      // Normalize angle to 0-360 range
      const angle = ((point[xAxisName] % 360) + 360) % 360;

      // Determine which bin this direction falls into
      const binIndex = Math.round(angle / binSize) % 16;
      const directionLabel = directions[binIndex];
      
      if (directionBins[directionLabel]) {
        directionBins[directionLabel].push(point[yAxisName]);
        processedCount++;
      }
    }
  });

  // Process data into speed bins with configurable interval
  const speedBinsData: Record<string, Record<number, number>> = {};
  const allSpeeds = Object.values(directionBins).flat().filter(speed => speed !== undefined);
  
  if (allSpeeds.length === 0) {
    return {
      directionBins: {},
      speedBinsData: {},
      totalCounts: {},
      maxValue: 0,
      speedRange: { min: 0, max: 0 },
      processedCount: 0,
      validDataCount: 0
    };
  }

  // Avoid Math.min/max with spread on large arrays (causes "Maximum call stack size exceeded")
  let minSpeed = allSpeeds[0];
  let maxSpeed = allSpeeds[0];
  for (let i = 1; i < allSpeeds.length; i++) {
    const s = allSpeeds[i];
    if (s < minSpeed) minSpeed = s;
    if (s > maxSpeed) maxSpeed = s;
  }
  
  // Create bins from min to max with the specified interval
  const minKnots = Math.floor(minSpeed / yAxisInterval) * yAxisInterval;
  const maxKnots = Math.ceil(maxSpeed / yAxisInterval) * yAxisInterval;

  // Create speed bins for each direction
  Object.keys(directionBins).forEach((direction) => {
    speedBinsData[direction] = {};
    for (let knot = minKnots; knot <= maxKnots; knot += yAxisInterval) {
      speedBinsData[direction][knot] = 0;
    }
  });

  // Count occurrences in each speed bin for each direction
  Object.keys(directionBins).forEach((direction) => {
    const speeds = directionBins[direction];
    speeds.forEach(speed => {
      const knotBin = Math.floor(speed / yAxisInterval) * yAxisInterval;
      if (speedBinsData[direction][knotBin] !== undefined) {
        speedBinsData[direction][knotBin]++;
      }
    });
  });

  // Calculate total counts for each direction
  const totalCounts: Record<string, number> = {};
  Object.keys(speedBinsData).forEach((direction) => {
    totalCounts[direction] = Object.values(speedBinsData[direction]).reduce((sum, count) => sum + count, 0);
  });

  // Find the maximum count across all directions for scaling
  const maxCount = Math.max(...Object.values(totalCounts));

  return {
    directionBins,
    speedBinsData,
    totalCounts,
    maxValue: maxCount,
    speedRange: { min: minSpeed, max: maxSpeed },
    processedCount,
    validDataCount
  };
}

// Export types for use in main thread
export type { WindDataItem, WindProcessingResult, WindProcessingConfig };
