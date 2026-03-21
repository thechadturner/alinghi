/**
 * HuniDB - High-performance SQL-powered client-side database
 * 
 * @packageDocumentation
 */

import { getConnectionManager, type ConnectionOptions, type Connection } from './core/connection.js';
import { createMigrationRunner } from './schema/migration.js';
import type { Migration, Transaction, StorageInfo } from './schema/types.js';
import { getStorageInfo } from './core/adapter.js';
import { ConnectionError, TransactionError } from './utils/errors.js';
import { defaultLogger, createLogger, LogLevel } from './utils/logger.js';
import { JSONTable, HybridQueryBuilder } from './json/index.js';
import { BatchWriter, HotCache, metricsCollector } from './performance/index.js';
import type { PerformanceMetrics } from './performance/index.js';
import { TimeSeriesTable } from './timeseries/index.js';
import type { TimeSeriesOptions } from './timeseries/index.js';

/**
 * Database class - main entry point for HuniDB
 */
export class Database {
  private connection: Connection;
  private dbName: string;
  private _json: JSONTable | null = null;
  private _batch: BatchWriter | null = null;
  private _cache: HotCache | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
    this.dbName = connection.getDatabaseName();
  }

  /**
   * JSON table operations
   */
  get json() {
    if (!this._json) {
      this._json = new JSONTable(this.connection);
    }
    // Always ensure cache is initialized and connected
    // IMPORTANT: Use the same cache instance that cache getter uses
    if (!this._cache) {
      this._cache = new HotCache();
      defaultLogger.debug('Database: Created new HotCache instance in json getter');
    }
    // Always set cache to ensure it's connected (even if already set)
    this._json.setCache(this._cache);
    
    // Ensure batch writer is connected (in case batch was created after json)
    if (this._batch && !this._batch['jsonTable']) {
      this._batch.setJSONTable(this._json);
    }
    return this._json;
  }

  /**
   * Hybrid query builder (JSON + SQL JOINs)
   */
  get hybrid() {
    return new HybridQueryBuilder(this.connection);
  }

  /**
   * Trigram indexer for partial string matching
   */
  get trigram() {
    return this.json.trigram;
  }

  /**
   * Create a time-series table manager
   */
  timeseries(options: TimeSeriesOptions): TimeSeriesTable {
    return new TimeSeriesTable(this.connection, options);
  }

  /**
   * Batch writer for optimized writes
   */
  get batch() {
    if (!this._batch) {
      this._batch = new BatchWriter(this.connection);
      // Connect JSON table to batch writer for FTS sync
      if (this._json) {
        this._batch.setJSONTable(this._json);
      }
    }
    // Ensure JSON table is connected (in case json was created after batch)
    if (this._json && !this._batch['jsonTable']) {
      this._batch.setJSONTable(this._json);
    }
    return this._batch;
  }

  /**
   * Hot KV cache for frequent reads
   */
  get cache() {
    if (!this._cache) {
      this._cache = new HotCache();
      defaultLogger.debug('Database: Created new HotCache instance in cache getter');
      // Connect cache to JSON table if it exists
      if (this._json) {
        this._json.setCache(this._cache);
        defaultLogger.debug('Database: Connected cache to existing JSON table');
      }
    }
    // Always ensure cache is connected (in case json was created after cache)
    if (this._json) {
      if (this._json['cache'] !== this._cache) {
        defaultLogger.debug('Database: Reconnecting cache to JSON table (instances differed)');
        this._json.setCache(this._cache);
      }
    }
    return this._cache;
  }

  /**
   * Execute a SQL statement (INSERT, UPDATE, DELETE, CREATE, etc.)
   */
  async exec(sql: string, params?: unknown[]): Promise<void> {
    return await this.connection.exec(sql, params);
  }

  /**
   * Execute a SELECT query and return all rows
   * 
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @param timeout - Optional query timeout in milliseconds (overrides connection default)
   * @returns Promise resolving to array of result rows
   * @throws QueryError if query fails or times out
   */
  async query<T = unknown>(sql: string, params?: unknown[], timeout?: number): Promise<T[]> {
    return await this.connection.query<T>(sql, params, timeout);
  }

  /**
   * Execute a SELECT query and return the first row
   * 
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @param timeout - Optional query timeout in milliseconds (overrides connection default)
   * @returns Promise resolving to first row or null
   * @throws QueryError if query fails or times out
   */
  async queryOne<T = unknown>(sql: string, params?: unknown[], timeout?: number): Promise<T | null> {
    return await this.connection.queryOne<T>(sql, params, timeout);
  }

  /**
   * Execute a SELECT query and return a single value
   * 
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @param timeout - Optional query timeout in milliseconds (overrides connection default)
   * @returns Promise resolving to single value or null
   * @throws QueryError if query fails or times out
   */
  async queryValue<T = unknown>(sql: string, params?: unknown[], timeout?: number): Promise<T | null> {
    return await this.connection.queryValue<T>(sql, params, timeout);
  }

  /**
   * Execute a function within a transaction
   */
  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      // Use engine directly to avoid writeLock deadlock inside transaction
      const engine = this.connection.getEngine();
      return await this.connection.transaction(async () => {
        const tx: Transaction = {
          exec: async (sql: string, params?: unknown[]) => {
            // Use engine.exec() directly to avoid writeLock deadlock (transaction already holds the lock)
            await engine.exec(sql, params);
          },
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            return await this.connection.query<T>(sql, params);
          },
          queryOne: async <T = unknown>(sql: string, params?: unknown[]) => {
            return await this.connection.queryOne<T>(sql, params);
          },
        };

        return await callback(tx);
      });
    } catch (error) {
      throw new TransactionError(
        `Transaction failed: ${error instanceof Error ? error.message : String(error)}`,
        { error }
      );
    }
  }

  /**
   * Run database migrations
   */
  async migrate(migrations: Migration[]): Promise<void> {
    const runner = createMigrationRunner(this.connection);
    await runner.migrate(migrations);
  }

  /**
   * Get current migration version
   */
  async getMigrationVersion(): Promise<number> {
    const runner = createMigrationRunner(this.connection);
    return await runner.getCurrentVersion();
  }

  /**
   * Get migration status
   */
  async getMigrationStatus(migrations: Migration[]): Promise<{
    currentVersion: number;
    availableVersion: number;
    pendingMigrations: number[];
  }> {
    const runner = createMigrationRunner(this.connection);
    return await runner.getStatus(migrations);
  }

  /**
   * Get storage information
   */
  async getStorageInfo(): Promise<StorageInfo> {
    const storageType = this.connection.getStorageType();
    return await getStorageInfo(storageType);
  }

  /**
   * Get prepared statement cache statistics
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
  } {
    const cache = this.connection.getStatementCache();
    const stats = cache.getStats();
    return {
      size: stats.size,
      maxSize: stats.maxSize,
      hitRate: stats.hitRate,
    };
  }

  /**
   * Get performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const performanceMetrics = metricsCollector.getMetrics();
    const cacheStats = this._cache?.getStats() || {
      size: 0,
      maxSize: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      evictions: 0,
    };

    return {
      queries: performanceMetrics.queries,
      writes: performanceMetrics.writes,
      cache: {
        ...cacheStats,
        hits: performanceMetrics.cache.hits || cacheStats.hits,
        misses: performanceMetrics.cache.misses || cacheStats.misses,
        evictions: performanceMetrics.cache.evictions || cacheStats.evictions,
      },
      indexes: performanceMetrics.indexes,
    };
  }

  /**
   * Reset performance metrics
   */
  resetMetrics(): void {
    defaultLogger.resetMetrics();
    metricsCollector.reset();
    this._cache?.resetStats();
    this._batch?.resetStats();
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    const manager = getConnectionManager();
    await manager.closeConnection(this.dbName, this.connection.getStorageType());
  }

  /**
   * Force immediate save to IndexedDB (flush pending changes)
   * Useful when you want to ensure data is persisted before navigating away
   */
  async flush(immediate: boolean = false): Promise<void> {
    await this.connection.flush(immediate);
  }

  /**
   * Get database name
   */
  getName(): string {
    return this.dbName;
  }

  /**
   * Get storage type
   */
  getStorageType(): string {
    return this.connection.getStorageType();
  }

  /**
   * Check if database is connected
   */
  isConnected(): boolean {
    return this.connection.isConnected();
  }
}

/**
 * Connect to a database
 */
export async function connect(options: ConnectionOptions): Promise<Database> {
  // Configure logger if verbose mode is enabled
  if (options.verbose) {
    defaultLogger.setLevel(LogLevel.DEBUG);
  }

  try {
    const manager = getConnectionManager();
    const connection = await manager.getConnection(options);
    return new Database(connection);
  } catch (error) {
    throw new ConnectionError(
      `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`,
      { options, error }
    );
  }
}

/**
 * Close all database connections
 */
export async function closeAll(): Promise<void> {
  const manager = getConnectionManager();
  await manager.closeAll();
}

// Export types
export type { 
  ConnectOptions,
  Migration, 
  MigrationExecutor,
  MigrationRecord,
  Transaction, 
  StorageInfo,
  TableSchema,
  TableColumns,
  ColumnDefinition,
  IndexDefinition,
  TableOptions,
  QueryResult,
  InferRowType,
  InferInsertType,
} from './schema/types.js';

export type { 
  ConnectionOptions 
} from './core/connection.js';

export type { 
  StorageType, 
  StorageCapabilities 
} from './core/adapter.js';

export type { 
  LoggerConfig
} from './utils/logger.js';

export type { Logger } from './utils/logger.js';

// Export JSON table types and helpers
export type {
  JSONDocument,
  JSONFilter,
  JSONTableOptions,
  JSONTableMetadata,
} from './json/index.js';

export {
  createJSONTable,
  dropJSONTable,
} from './json/index.js';

// Export performance types
export type {
  WriteOperation,
  BatchOptions,
  CacheOptions,
  CacheStats,
  FTSOptions,
  FTSResult,
  PerformanceMetrics,
} from './performance/index.js';

export {
  BatchWriter,
  HotCache,
  IndexedDBShadow,
  MetricsCollector,
  metricsCollector,
} from './performance/index.js';

// Export time-series types
export type {
  TimeSeriesPoint,
  TimeSeriesOptions,
  TimeRangeQuery,
  TimeSeriesStats,
  BulkInsertResult,
} from './timeseries/index.js';

export {
  TimeSeriesTable,
} from './timeseries/index.js';

// Export utilities
export { 
  LogLevel,
  createLogger,
  defaultLogger 
} from './utils/logger.js';

export {
  defineTable,
  column,
  index,
  generateCreateTableSQL,
  generateCreateIndexSQL,
  generateDropTableSQL,
  generateDropIndexSQL,
} from './schema/dsl.js';

export {
  buildSelect,
  buildInsert,
  buildUpdate,
  buildDelete,
  buildCount,
  buildInClause,
  buildBetweenClause,
  combineConditions,
  buildPagination,
  escapeIdentifier,
  formatValue,
} from './query/builder.js';

export {
  detectStorageCapabilities,
  selectStorageType,
  isStorageAvailable,
  getBrowserInfo,
  validateStorageCompatibility,
  clearStorage,
} from './core/adapter.js';

// Export errors
export {
  HuniDBError,
  ConnectionError,
  MigrationError,
  QueryError,
  SchemaError,
  TransactionError,
  StorageError,
  InitializationError,
  wrapError,
} from './utils/errors.js';

// Default export
export default {
  connect,
  closeAll,
  createLogger,
  LogLevel,
};

