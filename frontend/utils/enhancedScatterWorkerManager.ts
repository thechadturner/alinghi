/**
 * Enhanced Scatter Worker Manager
 * 
 * Manages web workers for enhanced scatter plot processing with density optimization per group
 */

import { warn, error as logError, info, debug } from './console';
import { createModuleWorker } from './workerFactory';
import { huniDBStore } from '../store/huniDBStore';
import { createDensityOptimizationCacheKey, hashData } from './densityOptimizationCache';
import type { DensityChartEntry, DensityGroupEntry } from '../store/huniDBTypes';
import { processEnhancedScatterData as processEnhancedScatterDataWorker } from '../workers/enhanced-scatter-processor';
import { defaultChannelsStore } from '../store/defaultChannelsStore';

// Static import for worker - Vite will bundle this correctly in production
import EnhancedScatterWorker from '../workers/enhanced-scatter-processor.ts?worker';

interface EnhancedScatterConfig {
  xField: string;
  yField: string;
  colorField?: string;
  colorType?: 'DEFAULT' | 'TACK' | 'GRADE' | 'UW/DW';
  maxPoints?: number;
  regressionMethod?: 'None' | 'Linear' | 'Poly 2' | 'Poly 3' | 'Loess 0.3' | 'Loess 0.5';
  tableRange?: { min: number; max: number; step: number };
  skipOptimization?: boolean;
}

interface DensityOptimizedGroup {
  groupName: string;
  color: string;
  data: any[];
  density: number;
  regression?: any;
  tableValues?: { x: number; y: number }[];
}

interface EnhancedScatterResult {
  groups: DensityOptimizedGroup[];
  totalProcessedCount: number;
  totalValidDataCount: number;
  optimizationStats: {
    originalCount: number;
    optimizedCount: number;
    groupsProcessed: number;
  };
}

/** Params for density cache read/write (used by storeInCache; no cache read path currently). */
export interface DensityCacheParams {
  className: string;
  sourceId: string;
  datasetId: string;
  projectId: string;
  chartFilters: string[];
  globalFilters: { states: string[]; races: string[]; legs: string[]; grades: string[] };
  selectionState: {
    selectedRange: Array<{ start_time: string; end_time: string; [key: string]: unknown }>;
    selectedEvents: Array<{ event_id: number; event_type: string; start_time: string; end_time: string; [key: string]: unknown }>;
    cutEvents: Array<{ start_time: string; end_time: string; [key: string]: unknown }>;
  };
  uniqueId?: string;
  colorType?: string;
}

class EnhancedScatterWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: EnhancedScatterResult) => void;
    reject: (error: Error) => void;
  }>();
  private processingQueue: Array<() => Promise<void>> = [];
  private isProcessing = false;

  constructor() {
    // Don't initialize worker immediately - wait for first use
    // This prevents errors on page load if worker file isn't ready
  }

  private initializeWorker() {
    if (this.worker) {
      return; // Already initialized
    }
    
    if (typeof Worker === 'undefined') {
      logError('Web Workers not supported in this browser');
      return;
    }
    
    try {
      // Use ?worker import - Vite bundles this correctly in production
      debug('Enhanced scatter worker: Creating worker instance');
      
      this.worker = new EnhancedScatterWorker();
      
      if (!this.worker) {
        logError('Failed to create enhanced scatter worker');
        return;
      }

      // Set up error handler BEFORE message handler to catch initialization errors
      this.worker.onerror = (evt: ErrorEvent) => {
        // ErrorEvent may have undefined fields if worker fails to load/parse
        const errorDetails = {
          message: evt.message || 'Worker failed to load or parse',
          filename: evt.filename || 'unknown',
          lineno: evt.lineno || 0,
          colno: evt.colno || 0,
          error: evt.error,
          // Additional context
          workerType: typeof Worker !== 'undefined' ? 'supported' : 'not supported',
          hasWorker: !!this.worker
        };
        logError('Enhanced scatter worker error:', errorDetails);
        
        // If all fields are undefined, it's likely a load/parse failure
        if (!evt.message && !evt.filename && !evt.lineno && !evt.colno && !evt.error) {
          logError('Worker file may have failed to load - check Network tab for 404 or CORS errors');
          logError('Worker URL should be accessible and have Cross-Origin-Embedder-Policy header');
        }
        
        // Mark worker as failed
        this.worker = null;
        
        // Reject all pending requests
        this.pendingRequests.forEach(({ reject }) => {
          reject(new Error(`Worker error: ${errorDetails.message}`));
        });
        this.pendingRequests.clear();
      };

        this.worker.onmessage = (e: MessageEvent) => {
          const { id, type, success, result, error } = e.data;
          
          if (type === 'ENHANCED_SCATTER_PROCESSED' && id && this.pendingRequests.has(id)) {
            const { resolve, reject } = this.pendingRequests.get(id)!;
            this.pendingRequests.delete(id);
            
            if (success) {
              resolve(result);
            } else {
              reject(new Error(error));
            }
          }
        };

        // Verify worker is actually working by checking if it's still available after a short delay
        // This helps catch cases where the worker fails to load but doesn't immediately error
        setTimeout(() => {
          if (this.worker) {
            info('Enhanced scatter worker initialized successfully');
            debug('Enhanced scatter worker: Worker is active and ready');
          } else {
            warn('Enhanced scatter worker: Worker was created but is no longer available');
          }
        }, 100);
    } catch (err: any) {
      const errorDetails = {
        message: err?.message || String(err),
        stack: err?.stack,
        name: err?.name,
        cause: err?.cause
      };
      logError('Failed to initialize enhanced scatter worker:', errorDetails);
      debug('Enhanced scatter worker initialization error details:', errorDetails);
      this.worker = null;
    }
  }

  private generateId(): string {
    return `enhanced_scatter_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Process enhanced scatter data with density optimization per group
   */
  async processEnhancedScatterData(
    data: any, 
    config: EnhancedScatterConfig,
    cacheParams?: DensityCacheParams
  ): Promise<EnhancedScatterResult> {
    // Initialize worker lazily on first use
    if (!this.worker) {
      this.initializeWorker();
    }
    
    // Validate input
    if (!Array.isArray(data) || data.length === 0) {
      return {
        groups: [],
        totalProcessedCount: 0,
        totalValidDataCount: 0,
        optimizationStats: {
          originalCount: 0,
          optimizedCount: 0,
          groupsProcessed: 0
        }
      };
    }

    // Density is always computed in the worker; no cache read (storeInCache still writes for persistence).

    // If worker is not available, fall back to main thread processing
    if (!this.worker) {
      // Only warn once per session to avoid console spam
      if (!(this as any)._fallbackWarned) {
        warn('Enhanced scatter worker not available, falling back to main thread processing. This may impact performance for large datasets.');
        (this as any)._fallbackWarned = true;
        debug('Enhanced scatter worker: Worker status check', {
          workerSupported: typeof Worker !== 'undefined',
          workerInstance: this.worker,
          pendingRequests: this.pendingRequests.size
        });
      }
      const result = await this.processInMainThread(data, config);
      await this.storeInCache(result, data, config, cacheParams);
      return result;
    }

    const id = this.generateId();
    
    return new Promise(async (resolve, reject) => {
      // Queue the processing to ensure only one chart processes at a time
      this.processingQueue.push(async () => {
        try {
          // Create a promise that will be resolved when the worker responds
          const workerPromise = new Promise<EnhancedScatterResult>((workerResolve, workerReject) => {
            const wrappedResolve = async (result: EnhancedScatterResult) => {
              await this.storeInCache(result, data, config, cacheParams);
              workerResolve(result);
            };
            
            this.pendingRequests.set(id, { resolve: wrappedResolve, reject: workerReject });
            
            // Timeout after 30 seconds
            setTimeout(async () => {
              if (this.pendingRequests.has(id)) {
                this.pendingRequests.delete(id);
                warn(`Enhanced scatter data processing timeout for ${data.length} data points, falling back to main thread`);
                try {
                  const result = this.processInMainThread(data, config);
                  await this.storeInCache(result, data, config, cacheParams);
                  workerResolve(result);
                } catch (error) {
                  workerReject(new Error(`Enhanced scatter data processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
                }
              }
            }, 30000);
          });
          
          
          this.worker!.postMessage({
            id,
            type: 'PROCESS_ENHANCED_SCATTER',
            data,
            config
          });
          
          // Wait for worker to complete
          const result = await workerPromise;
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      
      // Process queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Store result in cache
   */
  private async storeInCache(
    result: EnhancedScatterResult,
    originalData: any[],
    config: EnhancedScatterConfig,
    cacheParams?: DensityCacheParams
  ): Promise<void> {
    if (!cacheParams) {
      // Only warn if optimization was performed (should have been cached)
      if (!config.skipOptimization) {
        warn('[DensityOptimization] Cache parameters missing - optimized data will not be cached (performance may be impacted on subsequent loads)');
      }
      return;
    }
    
    // Only cache if optimization was performed (skipOptimization is false)
    // This ensures we only cache when we actually optimized the data
    if (config.skipOptimization) {
      return;
    }
    
    try {
      const cacheKey = createDensityOptimizationCacheKey(
        cacheParams.className,
        cacheParams.sourceId,
        config.colorType || cacheParams.colorType,
        config.regressionMethod || 'None',
        cacheParams.chartFilters,
        cacheParams.globalFilters,
        cacheParams.selectionState,
        cacheParams.uniqueId
      );
      
      const dataHash = hashData(originalData);
      
      // Extract info from key for summary (format: densityOpt_className_sourceId_uniqueId_...)
      const keyParts = cacheKey.split('_');
      const className = keyParts.length > 1 ? keyParts[1] : cacheParams.className;
      const sourceId = keyParts.length > 2 ? keyParts[2] : cacheParams.sourceId;
      const uniqueId = cacheParams.uniqueId || (keyParts.length > 3 ? keyParts[3] : undefined);
      
      const lastAccessed = Date.now();
      const chartObjectId = cacheParams.uniqueId || cacheKey;
      const datasetId = cacheParams.datasetId || '0';
      const projectId = cacheParams.projectId || '0';
      
      // Create chart entry
      const chart: DensityChartEntry = {
        id: cacheKey,
        chartObjectId,
        datasetId,
        projectId,
        sourceId: cacheParams.sourceId,
        colorType: config.colorType || cacheParams.colorType || 'DEFAULT',
        chartFilters: cacheParams.chartFilters,
        globalFilters: cacheParams.globalFilters,
        totalPoints: result.optimizationStats.originalCount,
        optimizedPoints: result.optimizationStats.optimizedCount,
        dataHash: dataHash,
        lastAccessed,
      };
      
      // Create group entries
      const groups: DensityGroupEntry[] = result.groups.map((group, index) => ({
        id: `${cacheKey}-group-${index}`,
        chartId: cacheKey,
        groupName: group.groupName,
        color: group.color,
        data: group.data,
        regression: group.regression,
        tableValues: group.tableValues,
      }));
      
      await huniDBStore.storeDensityOptimized(cacheParams.className, chart, groups);
    } catch (error) {
      warn('[DensityOptimization] Failed to store optimized data in cache (performance may be impacted):', error);
    }
  }

  /**
   * Fallback processing in main thread
   */
  private processInMainThread(data: any[], config: EnhancedScatterConfig): EnhancedScatterResult {
    const {
      xField = 'x',
      yField = 'y',
      colorType = 'DEFAULT',
      maxPoints = 3000,
      regressionMethod = 'None',
      tableRange = { min: 6, max: 20, step: 1 }
    } = config;

    // Filter valid data points
    const validData = data.filter(item => {
      const x = Number(item[xField]);
      const y = Number(item[yField]);
      return !isNaN(x) && !isNaN(y) && x !== null && y !== null;
    });

    if (validData.length === 0) {
      return {
        groups: [],
        totalProcessedCount: 0,
        totalValidDataCount: 0,
        optimizationStats: {
          originalCount: data.length,
          optimizedCount: 0,
          groupsProcessed: 0
        }
      };
    }

    // Group data by color type
    const groupedData = this.groupDataByColorType(validData, colorType);
    
    // Process each group with simple sampling
    const groups: DensityOptimizedGroup[] = [];
    let totalOptimizedCount = 0;
    
    for (const [groupName, groupData] of Object.entries(groupedData)) {
      if (groupData.length === 0) continue;
      if (groupName === 'SKIP') continue; // Exclude GRADE_0 from regression/display

      // Simple sampling for main thread fallback
      let optimizedData = groupData;
      if (groupData.length > maxPoints) {
        const step = Math.ceil(groupData.length / maxPoints);
        optimizedData = groupData.filter((_, index) => index % step === 0);
      }
      
      // Determine group color
      let color = '#1f77b4';
      switch (groupName) {
        case 'PORT': color = '#d62728'; break;
        case 'STBD': color = '#2ca02c'; break;
        case 'UPWIND': color = 'blue'; break;
        case 'REACHING': color = 'orange'; break;
        case 'DOWNWIND': color = 'red'; break;
        case 'GRADE_0': color = 'lightgray'; break;
        case 'GRADE_1': color = 'red'; break;
        case 'GRADE_2': color = 'lightgreen'; break;
        case 'GRADE_3': color = 'darkgreen'; break;
      }
      
      // Calculate regression if specified
      let regression = null;
      let tableValues = [];
      
      if (regressionMethod !== 'None') {
        // Use the worker's regression calculation function
        try {
          const tempResult = processEnhancedScatterDataWorker(optimizedData, {
            xField,
            yField,
            colorType: 'DEFAULT', // Use DEFAULT to get single group
            maxPoints: optimizedData.length,
            regressionMethod,
            tableRange
          });
          
          // Extract regression from the first (and only) group
          if (tempResult.groups && tempResult.groups.length > 0) {
            regression = tempResult.groups[0].regression;
            tableValues = tempResult.groups[0].tableValues || [];
          }
        } catch (error) {
          logError('Failed to calculate regression in main thread fallback:', error);
        }
      }
      
      groups.push({
        groupName,
        color,
        data: optimizedData,
        density: groupData.length,
        regression,
        tableValues
      });
      
      totalOptimizedCount += optimizedData.length;
    }

    return {
      groups,
      totalProcessedCount: totalOptimizedCount,
      totalValidDataCount: validData.length,
      optimizationStats: {
        originalCount: data.length,
        optimizedCount: totalOptimizedCount,
        groupsProcessed: groups.length
      }
    };
  }

  /**
   * Group data by color type
   */
  private groupDataByColorType(data: any[], colorType: string): { [key: string]: any[] } {
    const groups: { [key: string]: any[] } = {};
    
    // Get default TWA channel name for consistent TWA field access
    const defaultTwaName = defaultChannelsStore.twaName();
    
    data.forEach(point => {
      let groupKey = 'ALL';
      
      // Get TWA value using default channel name, with fallback to common variations
      const twaValue = point[defaultTwaName] ?? point.Twa ?? point.twa ?? point.TWA ?? 0;
      
      switch (colorType) {
        case 'TACK':
          groupKey = twaValue > 0 ? 'STBD' : 'PORT';
          break;
        case 'GRADE':
          // Use normalized field name (unifiedDataStore normalizes metadata); skip grade 0 like worker
          const grade = point.grade ?? point.Grade ?? point.GRADE ?? 0;
          if (grade === 0) {
            groupKey = 'SKIP';
          } else {
            groupKey = `GRADE_${grade}`;
          }
          break;
        case 'UW/DW':
          const absTwa = Math.abs(twaValue);
          if (absTwa < 75) groupKey = 'UPWIND';
          else if (absTwa >= 75 && absTwa <= 120) groupKey = 'REACHING';
          else groupKey = 'DOWNWIND';
          break;
        default:
          groupKey = 'ALL';
      }
      
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(point);
    });
    
    return groups;
  }

  /**
   * Process the queue of pending chart processing requests
   */
  private async processQueue() {
    if (this.isProcessing) {
      return; // Already processing
    }
    
    while (this.processingQueue.length > 0) {
      this.isProcessing = true;
      const processFn = this.processingQueue.shift();
      if (processFn) {
        try {
          await processFn();
        } catch (error) {
          debug('🔍 EnhancedScatterWorkerManager: Error processing queue item', error);
        }
      }
      this.isProcessing = false;
    }
  }

  /**
   * Check if worker is available and healthy
   */
  isWorkerAvailable(): boolean {
    return this.worker !== null;
  }

  /**
   * Retry worker initialization if it failed
   */
  retryInitialization(): boolean {
    if (this.worker) {
      debug('Enhanced scatter worker: Worker already initialized, no retry needed');
      return true;
    }
    
    debug('Enhanced scatter worker: Retrying initialization');
    this.initializeWorker();
    return this.worker !== null;
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
    (this as any)._fallbackWarned = false;
  }
}

// Singleton instance
export const enhancedScatterWorkerManager = new EnhancedScatterWorkerManager();

// Export types
export type { EnhancedScatterConfig, EnhancedScatterResult, DensityOptimizedGroup };
