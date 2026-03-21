/**
 * Performance Module Types
 */

/**
 * Batch operation types
 */
export type WriteOperationType = 'insert' | 'update' | 'delete' | 'exec';

/**
 * Write operation
 */
export interface WriteOperation {
  type: WriteOperationType;
  table?: string;
  sql: string;
  params?: unknown[];
  id?: string;  // For cache invalidation
}

/**
 * Batch options
 */
export interface BatchOptions {
  maxSize?: number;      // Max operations per batch (default: 100)
  timeout?: number;      // Max wait time in ms (default: 100)
  autoFlush?: boolean;  // Auto-flush on batch full (default: true)
}

/**
 * Cache options
 */
export interface CacheOptions {
  maxSize?: number;      // Max entries (default: 1000)
  ttl?: number;         // Time to live in ms (optional)
  persistent?: boolean;  // Use IndexedDB shadow (default: false)
}

/**
 * Cache statistics
 */
export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
}

/**
 * FTS5 search options
 */
export interface FTSOptions {
  columns?: string[];    // Columns to index (default: all text fields)
  tokenizer?: string;   // FTS5 tokenizer (default: 'unicode61')
}

/**
 * FTS5 search result
 */
export interface FTSResult {
  doc: unknown;
  rank: number;
  snippet?: string;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  queries: {
    count: number;
    avgLatency: number;
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
  };
  writes: {
    count: number;
    throughput: number;  // ops/sec
    avgBatchSize: number;
    totalBatches: number;
  };
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    maxSize: number;
    evictions: number;
  };
  indexes: {
    rebuildCount: number;
    avgRebuildTime: number;
  };
  memory?: {
    used: number;
    available: number;
  };
}

