/**
 * Time-Series Table Manager
 * 
 * Optimized for bulk storage, retrieval, and removal of time-series data
 */

import type { Connection } from '../core/connection.js';
import type {
  TimeSeriesPoint,
  TimeSeriesOptions,
  TimeRangeQuery,
  TimeSeriesStats,
  BulkInsertResult,
} from './types.js';
import { QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';
import { metricsCollector } from '../performance/metrics.js';

/**
 * Time-Series Table Manager
 */
export class TimeSeriesTable {
  private connection: Connection;
  private options: Required<Omit<TimeSeriesOptions, 'tableName' | 'partitionBy' | 'retentionDays' | 'compress'>> & {
    partitionBy?: TimeSeriesOptions['partitionBy'];
    retentionDays?: number;
    compress?: boolean;
  };

  constructor(connection: Connection, options: TimeSeriesOptions) {
    this.connection = connection;
    this.options = {
      chunkSize: options.chunkSize || 1000,
      valueType: options.valueType || 'REAL',
      partitionBy: options.partitionBy,
      retentionDays: options.retentionDays,
      compress: options.compress || false,
    };
  }

  /**
   * Create a time-series table with optimized structure
   */
  async createTable(tableName: string): Promise<void> {
    try {
      // Create main table with optimized structure
      // Using INTEGER for timestamp (milliseconds since epoch)
      // Separate value column for flexibility
      // Note: PRIMARY KEY on (timestamp, value) allows duplicates at same timestamp
      // For unique timestamps only, use timestamp as single PRIMARY KEY
      await this.connection.exec(`
        CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier(tableName)} (
          timestamp INTEGER NOT NULL,
          value ${this.options.valueType} NOT NULL,
          tags TEXT,  -- JSON string for tags
          PRIMARY KEY (timestamp, value)
        ) WITHOUT ROWID
      `);

      // Create index on timestamp (most important for time-series)
      // Replace dots in table name for index name to avoid SQLite interpreting them as database.table
      const safeTableName = tableName.replace(/\./g, '_');
      const indexTimestampName = `idx_${safeTableName}_timestamp`;
      await this.connection.exec(`
        CREATE INDEX IF NOT EXISTS ${this.escapeIdentifier(indexTimestampName)} 
        ON ${this.escapeIdentifier(tableName)}(timestamp DESC)
      `);

      // Create index on tags if needed (for filtering)
      if (this.options.partitionBy) {
        const indexTagsName = `idx_${safeTableName}_tags`;
        await this.connection.exec(`
          CREATE INDEX IF NOT EXISTS ${this.escapeIdentifier(indexTagsName)} 
          ON ${this.escapeIdentifier(tableName)}(tags)
        `);
      }

      defaultLogger.info(`Created time-series table: ${tableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to create time-series table: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Bulk insert time-series points (optimized)
   */
  async bulkInsert<T>(
    tableName: string,
    points: TimeSeriesPoint<T>[]
  ): Promise<BulkInsertResult> {
    const startTime = performance.now();

    try {
      if (points.length === 0) {
        return { inserted: 0, duration: 0, throughput: 0 };
      }

      // Sort points by timestamp for optimal insertion
      const sortedPoints = [...points].sort((a, b) => a.timestamp - b.timestamp);

      // Insert in chunks for better performance
      const chunks = this.chunkArray(sortedPoints, this.options.chunkSize);
      let totalInserted = 0;

      // Use engine.exec() directly to avoid writeLock deadlock inside transaction
      const engine = this.connection.getEngine();
      await this.connection.transaction(async () => {
        for (const chunk of chunks) {
          // Filter and validate points before building SQL
          const validPoints: typeof chunk = [];
          for (const point of chunk) {
            // Ensure value is a valid number (not null, undefined, or NaN)
            let value: number;
            if (typeof point.value === 'number' && !isNaN(point.value) && isFinite(point.value)) {
              value = point.value;
            } else if (typeof point.value === 'object') {
              // For objects, stringify (though this shouldn't happen for time-series)
              value = parseFloat(JSON.stringify(point.value)) || 0;
            } else {
              value = parseFloat(String(point.value)) || 0;
            }
            
            // Final validation - ensure we never insert null/NaN
            if (value === null || value === undefined || isNaN(value) || !isFinite(value)) {
              defaultLogger.warn(`Skipping invalid time-series point: ${JSON.stringify(point)}`);
              continue;
            }
            
            validPoints.push({
              ...point,
              value: value as T,
            });
          }
          
          // Skip empty chunks after filtering
          if (validPoints.length === 0) continue;
          
          // Build bulk INSERT statement
          // Use INSERT OR REPLACE for time-series (allows updates at same timestamp)
          // For append-only, use INSERT OR IGNORE
          const values = validPoints.map(() => '(?, ?, ?)').join(', ');
          const sql = `
            INSERT OR REPLACE INTO ${this.escapeIdentifier(tableName)} 
            (timestamp, value, tags) 
            VALUES ${values}
          `;

          const params: unknown[] = [];
          for (const point of validPoints) {
            params.push(
              point.timestamp,
              point.value,
              point.tags ? JSON.stringify(point.tags) : null
            );
          }

          // Use engine.exec() directly to avoid writeLock deadlock (transaction already holds the lock)
          await engine.exec(sql, params);
          totalInserted += validPoints.length;
        }
      });

      const duration = performance.now() - startTime;
      const throughput = (totalInserted / duration) * 1000;

      metricsCollector.recordBatch(totalInserted);

      defaultLogger.debug(
        `Bulk inserted ${totalInserted} points in ${duration.toFixed(2)}ms (${throughput.toFixed(0)} pts/sec)`
      );

      return {
        inserted: totalInserted,
        duration,
        throughput,
      };
    } catch (error) {
      throw new QueryError(
        `Failed to bulk insert: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, pointCount: points.length, error }
      );
    }
  }

  /**
   * Query time-series data by time range
   */
  async queryRange<T = unknown>(tableName: string, query: TimeRangeQuery): Promise<TimeSeriesPoint<T>[]> {
    const startTime = performance.now();

    try {
      let sql = `
        SELECT timestamp, value, tags 
        FROM ${this.escapeIdentifier(tableName)}
        WHERE timestamp >= ? AND timestamp <= ?
      `;
      const params: unknown[] = [query.startTime, query.endTime];

      // Add tag filters
      if (query.tags && Object.keys(query.tags).length > 0) {
        for (const [key, value] of Object.entries(query.tags)) {
          sql += ` AND json_extract(tags, '$.${key}') = ?`;
          params.push(value);
        }
      }

      // Add ordering
      sql += ` ORDER BY timestamp ${query.orderBy || 'ASC'}`;

      // Add limit/offset
      if (query.limit) {
        sql += ` LIMIT ?`;
        params.push(query.limit);
      }
      if (query.offset) {
        sql += ` OFFSET ?`;
        params.push(query.offset);
      }

      const results = await this.connection.query<{
        timestamp: number;
        value: string | number;
        tags: string | null;
      }>(sql, params);

      const points: TimeSeriesPoint<T>[] = results.map(row => {
        let value: T;
        try {
          // Try to parse as JSON first
          value = JSON.parse(row.value as string) as T;
        } catch {
          // Not JSON, use as-is
          value = row.value as T;
        }

        return {
          timestamp: row.timestamp,
          value,
          tags: row.tags ? JSON.parse(row.tags) : undefined,
        };
      });

      const duration = performance.now() - startTime;
      defaultLogger.debug(`Query returned ${points.length} points in ${duration.toFixed(2)}ms`);

      return points;
    } catch (error) {
      throw new QueryError(
        `Failed to query time-series: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, query, error }
      );
    }
  }

  /**
   * Get aggregated data (downsampling)
   */
  async aggregate(
    tableName: string,
    query: TimeRangeQuery
  ): Promise<Array<{ timestamp: number; value: number }>> {
    if (!query.aggregation) {
      throw new QueryError('Aggregation function and interval required');
    }

    try {
      const { function: aggFunc, interval } = query.aggregation;

      // Validate aggregation function to avoid SQL injection and invalid functions
      const allowedAggFunctions = ['AVG', 'SUM', 'MIN', 'MAX', 'COUNT'];
      const upperAggFunc = String(aggFunc).toUpperCase();
      if (!allowedAggFunctions.includes(upperAggFunc)) {
        throw new QueryError(
          `Invalid aggregation function: ${aggFunc}. Allowed: ${allowedAggFunctions.join(', ')}`
        );
      }

      // Ensure interval is a positive number
      const safeInterval = Number(interval);
      if (!Number.isFinite(safeInterval) || safeInterval <= 0) {
        throw new QueryError(`Invalid aggregation interval: ${interval}`);
      }

      // Build WHERE clause first so tag filters are always applied correctly
      let sql = `
        SELECT 
          (timestamp / ${safeInterval}) * ${safeInterval} as bucket,
          ${upperAggFunc}(CAST(value AS REAL)) as value
        FROM ${this.escapeIdentifier(tableName)}
        WHERE timestamp >= ? AND timestamp <= ?
      `;

      const params: unknown[] = [query.startTime, query.endTime];

      // Add tag filters (same pattern as queryRange)
      if (query.tags && Object.keys(query.tags).length > 0) {
        for (const [key, value] of Object.entries(query.tags)) {
          sql += ` AND json_extract(tags, '$.${key}') = ?`;
          params.push(value);
        }
      }

      // Group and order after all filters
      sql += `
        GROUP BY bucket
        ORDER BY bucket ASC
      `;

      const results = await this.connection.query<{ bucket: number; value: number }>(sql, params);

      return results.map(row => ({
        timestamp: row.bucket,
        value: row.value,
      }));
    } catch (error) {
      throw new QueryError(
        `Failed to aggregate: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, query, error }
      );
    }
  }

  /**
   * Delete old data (retention policy)
   */
  async deleteOld(
    tableName: string,
    beforeTimestamp: number
  ): Promise<number> {
    try {
      const result = await this.connection.queryValue<number>(
        `SELECT COUNT(*) FROM ${this.escapeIdentifier(tableName)} WHERE timestamp < ?`,
        [beforeTimestamp]
      );

      const count = result ?? 0;

      if (count > 0) {
        await this.connection.exec(
          `DELETE FROM ${this.escapeIdentifier(tableName)} WHERE timestamp < ?`,
          [beforeTimestamp]
        );
        defaultLogger.info(`Deleted ${count} old time-series points`);
      }

      return count;
    } catch (error) {
      throw new QueryError(
        `Failed to delete old data: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, beforeTimestamp, error }
      );
    }
  }

  /**
   * Get time-series statistics
   */
  async getStats(tableName: string): Promise<TimeSeriesStats> {
    try {
      const stats = await this.connection.queryOne<{
        count: number;
        min_ts: number;
        max_ts: number;
      }>(
        `SELECT 
          COUNT(*) as count,
          MIN(timestamp) as min_ts,
          MAX(timestamp) as max_ts
        FROM ${this.escapeIdentifier(tableName)}`
      );

      if (!stats) {
        return {
          tableName,
          pointCount: 0,
          oldestTimestamp: null,
          newestTimestamp: null,
          timeSpan: null,
          partitions: [],
        };
      }

      const timeSpan = stats.max_ts && stats.min_ts
        ? stats.max_ts - stats.min_ts
        : null;

      return {
        tableName,
        pointCount: stats.count,
        oldestTimestamp: stats.min_ts || null,
        newestTimestamp: stats.max_ts || null,
        timeSpan,
        partitions: [], // TODO: Implement partitioning
      };
    } catch (error) {
      throw new QueryError(
        `Failed to get stats: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Drop time-series table
   */
  async dropTable(tableName: string): Promise<void> {
    try {
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)}`);
      defaultLogger.info(`Dropped time-series table: ${tableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to drop table: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Chunk array into smaller arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
}

