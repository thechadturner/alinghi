/**
 * Scatter Data Processor Worker
 * 
 * Handles scatter plot data processing including:
 * - X/Y coordinate processing
 * - Color and size mapping
 * - Data clustering and grouping
 * - Outlier detection and filtering
 */

import { log } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  DataItem
} from './types';
import { error as logError } from '../utils/console';

interface ScatterConfig {
  xField?: string;
  yField?: string;
  colorField?: string;
  sizeField?: string;
  groupField?: string;
  normalize?: boolean;
  removeOutliers?: boolean;
  outlierThreshold?: number;
  clustering?: boolean;
  clusterCount?: number;
}

interface ScatterResult {
  data: any[];
  xRange: { min: number; max: number };
  yRange: { min: number; max: number };
  colorRange?: { min: number; max: number };
  sizeRange?: { min: number; max: number };
  groups?: string[];
  clusters?: any[];
  processedCount: number;
  validDataCount: number;
  outliersRemoved: number;
}

interface ScatterMessage extends WorkerMessage {
  type: 'PROCESS_SCATTER_DATA';
  data: DataItem[];
  config: ScatterConfig;
}

interface ScatterResponse extends WorkerResponse {
  id: string;
  type: 'SCATTER_DATA_PROCESSED';
  result: ScatterResult;
}

interface DensityMessage extends WorkerMessage {
  type: 'PROCESS_DENSITY_RENDERING';
  data: DataItem[];
  maxPoints: number;
  scaleInfo: {
    xDomain: [number, number];
    yDomain: [number, number];
    xRange: [number, number];
    yRange: [number, number];
  };
}

interface DensityResponse extends WorkerResponse {
  id: string;
  type: 'DENSITY_RENDERING_PROCESSED';
  result: {
    data: any[];
    originalCount: number;
  };
}

// Worker message handler
self.onmessage = (event: MessageEvent<ScatterMessage | DensityMessage>) => {
  const { id, type } = event.data;
  
  if (type === 'PROCESS_SCATTER_DATA') {
    const { data, config } = event.data as ScatterMessage;
    log(`Scatter worker received data processing request with ID: ${id}, data points: ${data.length}`);
    const startTime = performance.now();
    
    try {
      const result = processScatterData(data, config);
      const processingTime = performance.now() - startTime;
      
      log(`Scatter worker completed data processing in ${processingTime.toFixed(2)}ms for ID: ${id}`);
      
      const response: ScatterResponse = {
        id,
        type: 'SCATTER_DATA_PROCESSED',
        success: true,
        result
      };
      
      self.postMessage(response);
    } catch (error) {
      const processingTime = performance.now() - startTime;
      logError(`Scatter worker error in data processing after ${processingTime.toFixed(2)}ms for ID: ${id}:`, error);
      
      const response: ScatterResponse = {
        id,
        type: 'SCATTER_DATA_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        result: {
          data: [],
          xRange: { min: 0, max: 0 },
          yRange: { min: 0, max: 0 },
          processedCount: 0,
          validDataCount: 0,
          outliersRemoved: 0
        }
      };
      
      self.postMessage(response);
    }
  } else if (type === 'PROCESS_DENSITY_RENDERING') {
    const { data, maxPoints, scaleInfo } = event.data as DensityMessage;
    log(`Scatter worker received density rendering request with ID: ${id}, data points: ${data.length}, maxPoints: ${maxPoints}`);
    const startTime = performance.now();
    
    try {
      const result = processDensityRendering(data, maxPoints, scaleInfo);
      const processingTime = performance.now() - startTime;
      
      log(`Scatter worker completed density rendering in ${processingTime.toFixed(2)}ms for ID: ${id}`);
      
      const response: DensityResponse = {
        id,
        type: 'DENSITY_RENDERING_PROCESSED',
        success: true,
        result
      };
      
      self.postMessage(response);
    } catch (error) {
      const processingTime = performance.now() - startTime;
      logError(`Scatter worker error in density rendering after ${processingTime.toFixed(2)}ms for ID: ${id}:`, error);
      
      const response: DensityResponse = {
        id,
        type: 'DENSITY_RENDERING_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        result: {
          data: [],
          originalCount: data.length
        }
      };
      
      self.postMessage(response);
    }
  }
};

/**
 * Process scatter plot data
 */
function processScatterData(data: DataItem[], config: ScatterConfig): ScatterResult {
  const {
    xField = 'x',
    yField = 'y',
    colorField,
    sizeField,
    groupField,
    normalize = false,
    removeOutliers = false,
    outlierThreshold = 2.5,
    clustering = false,
    clusterCount = 5
  } = config;

  if (!Array.isArray(data)) {
    throw new Error('Scatter data must be an array');
  }

  // Filter valid data points
  const validData = data.filter(item => {
    const x = Number(item[xField]);
    const y = Number(item[yField]);
    return !isNaN(x) && !isNaN(y) && x !== null && y !== null;
  });

  let processedData = [...validData];
  let outliersRemoved = 0;

  // Remove outliers if requested
  if (removeOutliers && validData.length > 10) {
    const outlierResult = removeOutliersFromData(validData, xField, yField, outlierThreshold);
    processedData = outlierResult.data;
    outliersRemoved = outlierResult.removedCount;
  }

  // Normalize data if requested
  if (normalize) {
    processedData = normalizeData(processedData, xField, yField);
  }

  // Apply clustering if requested
  let clusters: any[] = [];
  if (clustering && processedData.length > clusterCount) {
    clusters = performClustering(processedData, xField, yField, clusterCount);
  }

  // Calculate ranges
  const xValues = processedData.map(item => Number(item[xField]));
  const yValues = processedData.map(item => Number(item[yField]));
  
  const xRange = {
    min: Math.min(...xValues),
    max: Math.max(...xValues)
  };
  
  const yRange = {
    min: Math.min(...yValues),
    max: Math.max(...yValues)
  };

  // Calculate color range if color field specified
  let colorRange: { min: number; max: number } | undefined;
  if (colorField) {
    const colorValues = processedData.map(item => Number(item[colorField]))
      .filter(val => !isNaN(val));
    
    if (colorValues.length > 0) {
      colorRange = {
        min: Math.min(...colorValues),
        max: Math.max(...colorValues)
      };
    }
  }

  // Calculate size range if size field specified
  let sizeRange: { min: number; max: number } | undefined;
  if (sizeField) {
    const sizeValues = processedData.map(item => Number(item[sizeField]))
      .filter(val => !isNaN(val));
    
    if (sizeValues.length > 0) {
      sizeRange = {
        min: Math.min(...sizeValues),
        max: Math.max(...sizeValues)
      };
    }
  }

  // Get unique groups if group field specified
  let groups: string[] | undefined;
  if (groupField) {
    groups = [...new Set(processedData.map(item => String(item[groupField] || 'unknown')))];
  }

  return {
    data: processedData,
    xRange,
    yRange,
    colorRange,
    sizeRange,
    groups,
    clusters,
    processedCount: processedData.length,
    validDataCount: validData.length,
    outliersRemoved
  };
}

/**
 * Remove outliers using IQR method
 */
function removeOutliersFromData(
  data: DataItem[], 
  xField: string, 
  yField: string, 
  threshold: number
): { data: DataItem[]; removedCount: number } {
  const xValues = data.map(item => Number(item[xField]));
  const yValues = data.map(item => Number(item[yField]));

  // Calculate IQR for both dimensions
  const xIQR = calculateIQR(xValues);
  const yIQR = calculateIQR(yValues);

  const xLower = xIQR.q1 - threshold * xIQR.iqr;
  const xUpper = xIQR.q3 + threshold * xIQR.iqr;
  const yLower = yIQR.q1 - threshold * yIQR.iqr;
  const yUpper = yIQR.q3 + threshold * yIQR.iqr;

  const filteredData = data.filter(item => {
    const x = Number(item[xField]);
    const y = Number(item[yField]);
    return x >= xLower && x <= xUpper && y >= yLower && y <= yUpper;
  });

  return {
    data: filteredData,
    removedCount: data.length - filteredData.length
  };
}

/**
 * Calculate IQR (Interquartile Range)
 */
function calculateIQR(values: number[]): { q1: number; q3: number; iqr: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  
  const q1Index = Math.floor(n * 0.25);
  const q3Index = Math.floor(n * 0.75);
  
  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  const iqr = q3 - q1;
  
  return { q1, q3, iqr };
}

/**
 * Normalize data to 0-1 range
 */
function normalizeData(data: DataItem[], xField: string, yField: string): DataItem[] {
  const xValues = data.map(item => Number(item[xField]));
  const yValues = data.map(item => Number(item[yField]));

  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);

  const xRange = xMax - xMin;
  const yRange = yMax - yMin;

  return data.map(item => ({
    ...item,
    [xField]: xRange > 0 ? (Number(item[xField]) - xMin) / xRange : 0,
    [yField]: yRange > 0 ? (Number(item[yField]) - yMin) / yRange : 0
  }));
}

/**
 * Simple k-means clustering
 */
function performClustering(
  data: DataItem[], 
  xField: string, 
  yField: string, 
  k: number
): any[] {
  if (data.length <= k) return [];

  // Initialize centroids randomly
  const centroids = [];
  for (let i = 0; i < k; i++) {
    const randomIndex = Math.floor(Math.random() * data.length);
    centroids.push({
      x: Number(data[randomIndex][xField]),
      y: Number(data[randomIndex][yField]),
      id: i
    });
  }

  // Assign points to clusters
  const clusters = data.map(item => {
    const x = Number(item[xField]);
    const y = Number(item[yField]);
    
    let minDistance = Infinity;
    let closestCentroid = 0;
    
    centroids.forEach((centroid, index) => {
      const distance = Math.sqrt(
        Math.pow(x - centroid.x, 2) + Math.pow(y - centroid.y, 2)
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        closestCentroid = index;
      }
    });
    
    return {
      ...item,
      cluster: closestCentroid,
      distance: minDistance
    };
  });

  return clusters;
}

/**
 * Process density-based rendering
 */
function processDensityRendering(
  data: DataItem[], 
  maxPoints: number,
  scaleInfo: {
    xDomain: [number, number];
    yDomain: [number, number];
    xRange: [number, number];
    yRange: [number, number];
  }
): { data: any[]; originalCount: number } {
  if (!data || data.length === 0) {
    return { data: [], originalCount: 0 };
  }

  // Create scale functions from scale info
  const xScale = (value: number) => {
    const [domainMin, domainMax] = scaleInfo.xDomain;
    const [rangeMin, rangeMax] = scaleInfo.xRange;
    return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
  };

  const yScale = (value: number) => {
    const [domainMin, domainMax] = scaleInfo.yDomain;
    const [rangeMin, rangeMax] = scaleInfo.yRange;
    return rangeMin + ((value - domainMin) / (domainMax - domainMin)) * (rangeMax - rangeMin);
  };

  // Convert data to screen coordinates for spatial analysis
  const screenPoints = data.map((point, idx) => ({
    ...point,
    screenX: xScale(Number(point.x || 0)),
    screenY: yScale(Number(point.y || 0)),
    originalIndex: idx
  }));

  // Define clustering parameters
  const clusterRadius = 3; // Pixels - points within this radius are considered overlapping
  const minClusterSize = 2; // Minimum points to form a cluster

  // Create spatial grid for efficient clustering
  const gridSize = clusterRadius * 2;
  const grid = new Map();

  // Place points in grid cells
  screenPoints.forEach(point => {
    const gridX = Math.floor(point.screenX / gridSize);
    const gridY = Math.floor(point.screenY / gridSize);
    const key = `${gridX},${gridY}`;

    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push(point);
  });

  // Process clusters and create density-based representation
  const processedPoints = [];
  const processedIndices = new Set();

  // Process each grid cell
  for (const [key, cellPoints] of grid) {
    if (cellPoints.length >= minClusterSize) {
      // This is a cluster - create density representation
      const clusterCenter = {
        x: cellPoints.reduce((sum, p) => sum + Number(p.x || 0), 0) / cellPoints.length,
        y: cellPoints.reduce((sum, p) => sum + Number(p.y || 0), 0) / cellPoints.length,
        screenX: cellPoints.reduce((sum, p) => sum + p.screenX, 0) / cellPoints.length,
        screenY: cellPoints.reduce((sum, p) => sum + p.screenY, 0) / cellPoints.length,
        density: cellPoints.length,
        clusterSize: cellPoints.length,
        // Preserve first point's color data
        ...cellPoints[0]
      };

      // Add cluster center with density information
      processedPoints.push({
        ...clusterCenter,
        isCluster: true,
        opacity: Math.min(0.9, 0.15 + (cellPoints.length * 0.03)) // Higher opacity for denser clusters
      });

      // Mark all points in this cluster as processed
      cellPoints.forEach(point => processedIndices.add(point.originalIndex));
    } else {
      // Single point or small group - add individual points
      cellPoints.forEach(point => {
        if (!processedIndices.has(point.originalIndex)) {
          processedPoints.push({
            ...point,
            isCluster: false,
            opacity: 0.1 // Lower opacity for individual points
          });
          processedIndices.add(point.originalIndex);
        }
      });
    }
  }

  // If we still have too many points, apply intelligent sampling
  if (processedPoints.length > maxPoints) {
    // Sort by density (clusters first, then individual points)
    processedPoints.sort((a, b) => {
      if (a.isCluster && !b.isCluster) return -1;
      if (!a.isCluster && b.isCluster) return 1;
      return (b.density || 1) - (a.density || 1);
    });

    // Keep all clusters and sample individual points
    const clusters = processedPoints.filter(p => p.isCluster);
    const individuals = processedPoints.filter(p => !p.isCluster);

    const remainingSlots = maxPoints - clusters.length;
    const sampleStep = Math.ceil(individuals.length / remainingSlots);

    const sampledIndividuals = individuals.filter((_, index) => index % sampleStep === 0);

    return { data: [...clusters, ...sampledIndividuals], originalCount: data.length };
  }

  return { data: processedPoints, originalCount: data.length };
}

// Export types for use in main thread
export type { DataItem, ScatterConfig, ScatterResult };
