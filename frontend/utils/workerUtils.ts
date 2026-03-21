/**
 * Worker Utilities for TeamShare
 * 
 * Provides convenient global functions for using Web Workers
 * throughout the application without directly importing the worker manager.
 */

import { error as logError } from './console';
import {
  processData as processDataFn,
  compressData as compressDataFn,
  filterData as filterDataFn,
  processChartData as processChartDataFn,
  validateData as validateDataFn,
  processMapDataWithWorker,
  getWorkerStats,
  terminateAllWorkers
} from './workerManager';

// Global worker functions for easy access
export const globalWorkerUtils = {
  /**
   * Process data using workers
   */
  async processData(data: any[], config?: any): Promise<any[]> {
    try {
      return await processDataFn(data, config);
    } catch (error) {
      logError('Data processing failed:', error);
      throw error;
    }
  },

  /**
   * Compress data using workers
   */
  async compressData(data: any[], config?: any): Promise<any[]> {
    try {
      const result = await compressDataFn(data, config);
      return Array.isArray(result) ? result : (result && typeof result === 'object' && 'data' in result ? (result as any).data : []);
    } catch (error) {
      logError('Data compression failed:', error);
      throw error;
    }
  },

  /**
   * Filter data using workers
   */
  async filterData(data: any[], filters: any[]): Promise<any[]> {
    try {
      return await filterDataFn(data, filters);
    } catch (error) {
      logError('Data filtering failed:', error);
      throw error;
    }
  },

  /**
   * Process chart data using workers
   */
  async processChartData(data: any[], chartType: string, config?: any): Promise<any[]> {
    try {
      return await processChartDataFn(data, chartType, config);
    } catch (error) {
      logError('Chart data processing failed:', error);
      throw error;
    }
  },

  /**
   * Validate data using workers
   */
  async validateData(data: any[], schema?: any): Promise<{ valid: boolean; errors: string[] }> {
    try {
      const result = await validateDataFn(data, { schema });
      return {
        valid: result.valid,
        errors: result.errors.map((err: any) => err.message || String(err))
      };
    } catch (error) {
      logError('Data validation failed:', error instanceof Error ? error.message : String(error));
      throw error;
    }
  },

  /**
   * Process map data using workers
   */
  async processMapData(data: any[], config?: any): Promise<any[]> {
    try {
      const result = await processMapDataWithWorker(data, config);
      return Array.isArray(result) ? result : (result && typeof result === 'object' && 'data' in result ? (result as any).data : []);
    } catch (error) {
      logError('Map data processing failed:', error);
      throw error;
    }
  },

  /**
   * Get worker statistics
   */
  getStats() {
    return getWorkerStats();
  },

  /**
   * Check if workers are supported
   */
  isSupported(): boolean {
    return typeof Worker !== 'undefined';
  },

  /**
   * Terminate all workers
   */
  terminateAll() {
    terminateAllWorkers();
  }
};

// Export individual functions for convenience
export const processDataWithWorker = globalWorkerUtils.processData;
export const compressDataWithWorker = globalWorkerUtils.compressData;
export const filterDataWithWorker = globalWorkerUtils.filterData;
export const processChartDataWithWorker = globalWorkerUtils.processChartData;
export const validateDataWithWorker = globalWorkerUtils.validateData;
export const processMapDataWithWorker = globalWorkerUtils.processMapData;
export const getWorkerStats = globalWorkerUtils.getStats;
export const isWorkerSupported = globalWorkerUtils.isSupported;
export const terminateAllWorkers = globalWorkerUtils.terminateAll;

// Compatibility object for code that expects a workerManager instance
export const workerManager = {
  processMapData: processMapDataWithWorker,
  getStats: getWorkerStats,
  terminateAll: terminateAllWorkers
};

// Make functions available globally
if (typeof window !== 'undefined') {
  (window as any).workerUtils = globalWorkerUtils;
  (window as any).processDataWithWorker = processDataWithWorker;
  (window as any).compressDataWithWorker = compressDataWithWorker;
  (window as any).filterDataWithWorker = filterDataWithWorker;
  (window as any).processChartDataWithWorker = processChartDataWithWorker;
  (window as any).validateDataWithWorker = validateDataWithWorker;
  (window as any).processMapDataWithWorker = processMapDataWithWorker;
}

export default globalWorkerUtils;
