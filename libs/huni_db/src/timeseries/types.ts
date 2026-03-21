/**
 * Time-Series Data Types
 * 
 * Types for optimized time-series data storage and retrieval
 */

/**
 * Time-series point
 */
export interface TimeSeriesPoint<T = unknown> {
  timestamp: number;  // Unix timestamp in milliseconds
  value: T;
  tags?: Record<string, string | number>;  // Optional tags for filtering
}

/**
 * Time-series table options
 */
export interface TimeSeriesOptions {
  /**
   * Table name
   */
  tableName: string;
  
  /**
   * Partition strategy
   */
  partitionBy?: 'day' | 'week' | 'month' | 'year' | 'none';
  
  /**
   * Retention policy (delete data older than this)
   */
  retentionDays?: number;
  
  /**
   * Chunk size for bulk operations
   */
  chunkSize?: number;
  
  /**
   * Enable compression
   */
  compress?: boolean;
  
  /**
   * Value column type (default: REAL for numeric, TEXT for JSON)
   */
  valueType?: 'REAL' | 'TEXT' | 'INTEGER' | 'BLOB';
}

/**
 * Time-range query options
 */
export interface TimeRangeQuery {
  startTime: number;
  endTime: number;
  limit?: number;
  offset?: number;
  orderBy?: 'ASC' | 'DESC';
  tags?: Record<string, string | number>;
  aggregation?: {
    function: 'avg' | 'sum' | 'min' | 'max' | 'count';
    interval: number;  // Interval in milliseconds
  };
}

/**
 * Time-series statistics
 */
export interface TimeSeriesStats {
  tableName: string;
  pointCount: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  timeSpan: number | null;  // milliseconds
  partitions: Array<{
    partition: string;
    pointCount: number;
    oldestTimestamp: number;
    newestTimestamp: number;
  }>;
}

/**
 * Bulk insert result
 */
export interface BulkInsertResult {
  inserted: number;
  duration: number;
  throughput: number;  // points per second
}

