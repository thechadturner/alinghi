/**
 * Performance Module
 * 
 * Main exports for performance features
 */

export { BatchWriter } from './batch.js';
export { HotCache } from './cache.js';
export { IndexedDBShadow } from './shadow.js';
export { MetricsCollector, metricsCollector } from './metrics.js';
export type {
  WriteOperation,
  WriteOperationType,
  BatchOptions,
  CacheOptions,
  CacheStats,
  FTSOptions,
  FTSResult,
  PerformanceMetrics,
} from './types.js';

