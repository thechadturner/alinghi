/**
 * Scatter Worker Manager
 * 
 * Manages web workers for scatter plot data processing to prevent UI blocking
 */

import { warn, error as logError, info, debug } from './console';
import { createModuleWorker } from './workerFactory';

// Static import for worker - Vite will bundle this correctly in production
import ScatterWorker from '../workers/scatter-data-processor.ts?worker';

interface ScatterWorkerConfig {
  xField: string;
  yField: string;
  colorField?: string;
  sizeField?: string;
  groupField?: string;
  normalize?: boolean;
  removeOutliers?: boolean;
  outlierThreshold?: number;
  clustering?: boolean;
  clusterCount?: number;
  maxPoints?: number; // For data sampling
}

interface ScatterWorkerResult {
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
  sampledCount?: number;
}

class ScatterWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: ScatterWorkerResult) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    this.initializeWorker();
  }

  private initializeWorker() {
    if (typeof Worker !== 'undefined') {
      try {
        // Use ?worker import - Vite bundles this correctly in production
        this.worker = new ScatterWorker();
        
        if (!this.worker) {
          logError('Failed to create scatter worker');
          return;
        }

        this.worker.onmessage = (e: MessageEvent) => {
          const { id, type, success, result, error } = e.data;
          debug('🔍 ScatterWorkerManager: Received worker message', { id, type, success });
          
          if ((type === 'SCATTER_DATA_PROCESSED' || type === 'DENSITY_RENDERING_PROCESSED') && id && this.pendingRequests.has(id)) {
            const { resolve, reject } = this.pendingRequests.get(id)!;
            this.pendingRequests.delete(id);
            
            if (success) {
              if (type === 'SCATTER_DATA_PROCESSED') {
                debug('🔍 ScatterWorkerManager: Worker processing successful', {
                  processedCount: result.processedCount,
                  validDataCount: result.validDataCount
                });
              } else if (type === 'DENSITY_RENDERING_PROCESSED') {
                debug('🔍 ScatterWorkerManager: Density rendering successful', {
                  originalCount: result.originalCount,
                  renderedCount: result.data.length
                });
              }
              resolve(result);
            } else {
              debug('🔍 ScatterWorkerManager: Worker processing failed', error);
              reject(new Error(error));
            }
          }
        };

        this.worker.onerror = (evt: ErrorEvent) => {
          logError('Scatter worker error:', evt.message);
          // Reject all pending requests
          this.pendingRequests.forEach(({ reject }) => {
            reject(new Error('Worker error'));
          });
          this.pendingRequests.clear();
        };

        debug('🔍 ScatterWorkerManager: Worker initialized successfully');
        info('Scatter worker initialized successfully');
      } catch (err: any) {
        logError('Failed to initialize scatter worker:', err?.message || String(err));
        this.worker = null;
      }
    } else {
      warn('Web Workers not supported in this environment');
    }
  }

  private generateId(): string {
    return `scatter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Process density-based rendering using web worker
   */
  async processDensityBasedRendering(
    data: any[], 
    maxPoints: number,
    xScale: any,
    yScale: any
  ): Promise<{ data: any[] }> {
    // If worker is not available, fall back to main thread processing
    if (!this.worker) {
      debug('🔍 ScatterWorkerManager: Worker not available for density rendering, falling back to main thread');
      warn('Scatter worker not available, falling back to main thread density processing');
      return this.processDensityInMainThread(data, maxPoints, xScale, yScale);
    }

    const id = this.generateId();

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Density rendering timeout'));
        }
      }, 30000); // 30 second timeout

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      // Convert scales to serializable format
      const scaleInfo = {
        xDomain: xScale.domain(),
        yDomain: yScale.domain(),
        xRange: xScale.range(),
        yRange: yScale.range()
      };

      debug('🔍 ScatterWorkerManager: Sending density rendering data to worker', {
        id,
        dataLength: data.length,
        maxPoints,
        scaleInfo
      });
      
      this.worker!.postMessage({
        id,
        type: 'PROCESS_DENSITY_RENDERING',
        data,
        maxPoints,
        scaleInfo
      });
    });
  }

  /**
   * Process scatter data using web worker
   */
  async processScatterData(
    data: any[], 
    config: ScatterWorkerConfig
  ): Promise<ScatterWorkerResult> {
    // Validate input
    if (!Array.isArray(data) || data.length === 0) {
      return {
        data: [],
        xRange: { min: 0, max: 0 },
        yRange: { min: 0, max: 0 },
        processedCount: 0,
        validDataCount: 0,
        outliersRemoved: 0
      };
    }

    // If worker is not available, fall back to main thread processing
    if (!this.worker) {
      debug('🔍 ScatterWorkerManager: Worker not available, falling back to main thread');
      warn('Scatter worker not available, falling back to main thread processing');
      return this.processInMainThread(data, config);
    }

    const id = this.generateId();
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      // Add data sampling configuration
      const workerConfig = {
        ...config,
        // Implement data sampling for large datasets
        maxPoints: config.maxPoints || (data.length > 5000 ? 5000 : undefined)
      };

      debug('🔍 ScatterWorkerManager: Sending data to worker', {
        id,
        dataLength: data.length,
        config: workerConfig
      });
      
      this.worker!.postMessage({
        id,
        type: 'PROCESS_SCATTER_DATA',
        data,
        config: workerConfig
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          warn(`Scatter data processing timeout for ${data.length} data points, falling back to main thread`);
          try {
            const result = this.processInMainThread(data, config);
            resolve(result);
          } catch (error) {
            reject(new Error(`Scatter data processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
          }
        }
      }, 10000);
    });
  }

  /**
   * Fallback density processing in main thread
   */
  private processDensityInMainThread(data: any[], maxPoints: number, xScale: any, yScale: any): { data: any[] } {
    if (!data || data.length === 0) return { data: [] };
    
    // Convert data to screen coordinates for spatial analysis
    const screenPoints = data.map((point, idx) => ({
      ...point,
      screenX: xScale(point.x),
      screenY: yScale(point.y),
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
          x: cellPoints.reduce((sum, p) => sum + p.x, 0) / cellPoints.length,
          y: cellPoints.reduce((sum, p) => sum + p.y, 0) / cellPoints.length,
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
      
      return { data: [...clusters, ...sampledIndividuals] };
    }
    
    return { data: processedPoints };
  }

  /**
   * Fallback processing in main thread
   */
  private processInMainThread(data: any[], config: ScatterWorkerConfig): ScatterWorkerResult {
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
      clusterCount = 5,
      maxPoints
    } = config;

    // Filter valid data points
    const validData = data.filter(item => {
      const x = Number(item[xField]);
      const y = Number(item[yField]);
      return !isNaN(x) && !isNaN(y) && x !== null && y !== null;
    });

    let processedData = [...validData];

    // Apply data sampling for large datasets
    if (maxPoints && processedData.length > maxPoints) {
      const step = Math.ceil(processedData.length / maxPoints);
      processedData = processedData.filter((_, index) => index % step === 0);
    }

    // Remove outliers if requested
    let outliersRemoved = 0;
    if (removeOutliers && processedData.length > 10) {
      const outlierResult = this.removeOutliersFromData(processedData, xField, yField, outlierThreshold);
      processedData = outlierResult.data;
      outliersRemoved = outlierResult.removedCount;
    }

    // Normalize data if requested
    if (normalize) {
      processedData = this.normalizeData(processedData, xField, yField);
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
      clusters: [], // Simplified - no clustering in main thread fallback
      processedCount: processedData.length,
      validDataCount: validData.length,
      outliersRemoved,
      sampledCount: maxPoints && data.length > maxPoints ? processedData.length : undefined
    };
  }

  /**
   * Remove outliers using IQR method
   */
  private removeOutliersFromData(
    data: any[], 
    xField: string, 
    yField: string, 
    threshold: number
  ): { data: any[]; removedCount: number } {
    const xValues = data.map(item => Number(item[xField]));
    const yValues = data.map(item => Number(item[yField]));

    // Calculate IQR for both dimensions
    const xIQR = this.calculateIQR(xValues);
    const yIQR = this.calculateIQR(yValues);

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
  private calculateIQR(values: number[]): { q1: number; q3: number; iqr: number } {
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
  private normalizeData(data: any[], xField: string, yField: string): any[] {
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
   * Destroy the worker
   */
  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
  }
}

// Singleton instance
export const scatterWorkerManager = new ScatterWorkerManager();

// Export types
export type { ScatterWorkerConfig, ScatterWorkerResult };
