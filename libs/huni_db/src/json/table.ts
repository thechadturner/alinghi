/**
 * JSON Table Operations
 * 
 * Core CRUD operations for JSON documents
 */

import type { Connection } from '../core/connection.js';
import type { JSONFilter, JSONTableOptions } from './types.js';
import { JSONIndexer } from './indexer.js';
import { JSONQueryBuilder } from './query-builder.js';
import { FTSIndexer } from './fts.js';
import { TrigramIndexer } from './trigram.js';
import { QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';
import { metricsCollector } from '../performance/metrics.js';

/**
 * JSON Table Manager
 */
export class JSONTable {
  private connection: Connection;
  private indexer: JSONIndexer;
  private queryBuilder: JSONQueryBuilder;
  private ftsIndexer: FTSIndexer | null = null;
  private trigramIndexer: TrigramIndexer | null = null;
  private indexQueue: Map<string, { docId: string; doc: unknown }> = new Map();
  private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cache: import('../performance/cache.js').HotCache | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
    this.indexer = new JSONIndexer(connection);
    this.queryBuilder = new JSONQueryBuilder();
    this.ftsIndexer = new FTSIndexer(connection);
    this.trigramIndexer = new TrigramIndexer(connection);
  }

  /**
   * Get trigram indexer
   */
  get trigram() {
    return this.trigramIndexer!;
  }

  /**
   * Set cache instance for JSON operations
   */
  setCache(cache: import('../performance/cache.js').HotCache): void {
    if (this.cache !== cache) {
      defaultLogger.debug(`JSONTable: Setting cache instance (was: ${this.cache ? 'existing' : 'null'}, now: ${cache ? 'new' : 'null'})`);
      this.cache = cache;
    }
  }

  /**
   * Sync a document to FTS index without re-inserting
   * Used by batch writer to sync FTS after batch inserts
   */
  async syncFTSDocument<T>(tableName: string, id: string, doc: T): Promise<void> {
    if (this.ftsIndexer) {
      await this.ftsIndexer.syncDocument(tableName, id, doc).catch(err => {
        defaultLogger.warn('FTS sync failed', err);
      });
    }
  }

  /**
   * Create a JSON table
   */
  async createTable(tableName: string, options?: JSONTableOptions): Promise<void> {
    const startTime = performance.now();

    try {
      // Create main document table
      await this.connection.exec(`
        CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier(tableName)} (
          id TEXT PRIMARY KEY,
          doc TEXT NOT NULL,
          ts INTEGER NOT NULL
        )
      `);

      // Create index on timestamp
      // Sanitize index name by replacing dots with underscores (SQLite interprets dots as database.table)
      const sanitizedIndexName = tableName.replace(/\./g, '_');
      await this.connection.exec(`
        CREATE INDEX IF NOT EXISTS "${sanitizedIndexName}_ts" 
        ON ${this.escapeIdentifier(tableName)}(ts)
      `);

      // Initialize indexer for this table
      await this.indexer.initializeTable(tableName, options);

      const duration = performance.now() - startTime;
      defaultLogger.info(`Created JSON table: ${tableName} in ${duration.toFixed(2)}ms`);
    } catch (error) {
      throw new QueryError(
        `Failed to create JSON table: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, options, error }
      );
    }
  }

  /**
   * Drop a JSON table and its indexes
   */
  async dropTable(tableName: string): Promise<void> {
    try {
      // Drop index tables first
      await this.indexer.dropTable(tableName);

      // Drop main table
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)}`);

      defaultLogger.info(`Dropped JSON table: ${tableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to drop JSON table: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Store or update a JSON document
   */
  async putDoc<T>(tableName: string, id: string, doc: T): Promise<void> {
    const startTime = performance.now();

    try {
      const docJson = JSON.stringify(doc);
      const timestamp = Date.now();

      await this.connection.exec(
        `INSERT OR REPLACE INTO ${this.escapeIdentifier(tableName)} (id, doc, ts) VALUES (?, ?, ?)`,
        [id, docJson, timestamp]
      );

      // Queue index update (debounced)
      this.queueIndexUpdate(tableName, id, doc);

      // Sync to FTS if available
      if (this.ftsIndexer) {
        await this.ftsIndexer.syncDocument(tableName, id, doc).catch(err => {
          defaultLogger.warn('FTS sync failed', err);
        });
      }

      // Invalidate cache
      if (this.cache) {
        this.cache.invalidate(`doc:${tableName}:${id}`);
      }

      const duration = performance.now() - startTime;
      defaultLogger.debug(`Stored document ${id} in ${tableName} in ${duration.toFixed(2)}ms`);
    } catch (error) {
      throw new QueryError(
        `Failed to store document: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, id, error }
      );
    }
  }

  /**
   * Queue index update (debounced)
   */
  private queueIndexUpdate(tableName: string, docId: string, doc: unknown): void {
    const key = `${tableName}:${docId}`;
    this.indexQueue.set(key, { docId, doc });

    // Clear existing timer
    if (this.indexDebounceTimer) {
      clearTimeout(this.indexDebounceTimer);
    }

    // Schedule batch index update
    this.indexDebounceTimer = setTimeout(async () => {
      await this.flushIndexQueue(tableName);
    }, 50); // 50ms debounce
  }

  /**
   * Flush queued index updates
   */
  private async flushIndexQueue(tableName: string): Promise<void> {
    const updates = Array.from(this.indexQueue.entries())
      .filter(([key]) => key.startsWith(`${tableName}:`))
      .map(([, value]) => value);

    if (updates.length === 0) {
      return;
    }

    // Clear queue
    for (const [key] of this.indexQueue.entries()) {
      if (key.startsWith(`${tableName}:`)) {
        this.indexQueue.delete(key);
      }
    }

    // Batch index updates
    const startTime = performance.now();
    for (const { docId, doc } of updates) {
      await this.indexer.indexDocument(tableName, docId, doc);
    }
    const duration = performance.now() - startTime;
    
    metricsCollector.recordIndexRebuild(duration);
    defaultLogger.debug(`Indexed ${updates.length} documents in ${duration.toFixed(2)}ms`);
  }

  /**
   * Retrieve a JSON document by ID
   */
  async getDoc<T>(tableName: string, id: string): Promise<T | null> {
    try {
      // Check cache first
      const cacheKey = `doc:${tableName}:${id}`;
      if (this.cache) {
        const cached = await this.cache.get<T>(cacheKey);
        if (cached !== null) {
          defaultLogger.debug(`Cache HIT for key: ${cacheKey}`);
          return cached;
        }
        defaultLogger.debug(`Cache MISS for key: ${cacheKey} (cache instance exists: ${!!this.cache})`);
      } else {
        defaultLogger.warn(`Cache not available for key: ${cacheKey} - cache instance is null!`);
      }

      // Query database
      defaultLogger.debug(`[JSONTable] Querying DB for key: ${cacheKey}, cache exists: ${!!this.cache}`);
      const result = await this.connection.queryOne<{ doc: string }>(
        `SELECT doc FROM ${this.escapeIdentifier(tableName)} WHERE id = ?`,
        [id]
      );

      if (!result) {
        defaultLogger.debug(`[JSONTable] No result from DB for key: ${cacheKey}`);
        return null;
      }

      const doc = JSON.parse(result.doc) as T;
      defaultLogger.debug(`[JSONTable] Parsed doc for key: ${cacheKey}, cache exists: ${!!this.cache}`);

      // Store in cache - CRITICAL: Ensure cache is set
      if (!this.cache) {
        defaultLogger.error(`CRITICAL: Cache is NULL when trying to SET key: ${cacheKey}! This should never happen.`);
        return doc; // Return doc even if cache fails
      }
      
      try {
        const cacheSizeBefore = this.cache.getStats().size;
        defaultLogger.debug(`[JSONTable] About to SET cache for key: ${cacheKey}, size before: ${cacheSizeBefore}`);
        this.cache.set(cacheKey, doc);
        const cacheSizeAfter = this.cache.getStats().size;
        defaultLogger.debug(`[JSONTable] Cache SET for key: ${cacheKey} (size: ${cacheSizeBefore} -> ${cacheSizeAfter})`);
        
        // Verify it was actually stored (async check)
        const verify = await this.cache.get(cacheKey);
        if (verify === null) {
          defaultLogger.error(`CRITICAL: Cache entry was not stored! Key: ${cacheKey}, size after set: ${cacheSizeAfter}`);
        } else {
          defaultLogger.debug(`[JSONTable] Cache verification PASSED for key: ${cacheKey}`);
        }
      } catch (error) {
        defaultLogger.error(`Error setting cache for key: ${cacheKey}`, error);
      }

      return doc;
    } catch (error) {
      throw new QueryError(
        `Failed to retrieve document: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, id, error }
      );
    }
  }

  /**
   * Find documents matching a filter
   */
  async find<T>(tableName: string, filter: JSONFilter): Promise<T[]> {
    const startTime = performance.now();

    try {
      // Build query from filter
      const query = this.queryBuilder.buildFindQuery(tableName, filter);
      
      // Execute query
      const results = await this.connection.query<{ doc: string }>(query.sql, query.params);

      // Parse JSON documents
      const documents = results.map(row => JSON.parse(row.doc) as T);

      const duration = performance.now() - startTime;
      defaultLogger.debug(`Found ${documents.length} documents in ${tableName} in ${duration.toFixed(2)}ms`);

      return documents;
    } catch (error) {
      throw new QueryError(
        `Failed to find documents: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, filter, error }
      );
    }
  }

  /**
   * Count documents matching a filter
   */
  async count(tableName: string, filter?: JSONFilter): Promise<number> {
    try {
      if (!filter || Object.keys(filter).length === 0) {
        // Simple count
        const result = await this.connection.queryValue<number>(
          `SELECT COUNT(*) FROM ${this.escapeIdentifier(tableName)}`
        );
        return result ?? 0;
      }

      // Build query with filter
      const query = this.queryBuilder.buildCountQuery(tableName, filter);
      const result = await this.connection.queryValue<number>(query.sql, query.params);
      return result ?? 0;
    } catch (error) {
      throw new QueryError(
        `Failed to count documents: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, filter, error }
      );
    }
  }

  /**
   * Delete a document by ID
   */
  async deleteDoc(tableName: string, id: string): Promise<void> {
    try {
      // Delete from main table
      await this.connection.exec(
        `DELETE FROM ${this.escapeIdentifier(tableName)} WHERE id = ?`,
        [id]
      );

      // Remove from indexes
      await this.indexer.removeDocument(tableName, id);

      // Remove from FTS
      if (this.ftsIndexer) {
        await this.ftsIndexer.removeDocument(tableName, id).catch(err => {
          defaultLogger.warn('FTS removal failed', err);
        });
      }

      // Invalidate cache
      if (this.cache) {
        this.cache.invalidate(`doc:${tableName}:${id}`);
      }

      // Remove from queue
      this.indexQueue.delete(`${tableName}:${id}`);

      defaultLogger.debug(`Deleted document ${id} from ${tableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to delete document: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, id, error }
      );
    }
  }

  /**
   * Get FTS indexer
   */
  get fts() {
    return this.ftsIndexer;
  }

  /**
   * Rebuild indexes for a table
   */
  async rebuildIndexes(tableName: string): Promise<void> {
    try {
      await this.indexer.rebuildIndexes(tableName);
      defaultLogger.info(`Rebuilt indexes for ${tableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to rebuild indexes: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Get table metadata
   */
  async getMetadata(tableName: string): Promise<{
    tableName: string;
    documentCount: number;
    indexedKeys: string[];
  }> {
    try {
      const count = await this.count(tableName);
      const indexedKeys = await this.indexer.getIndexedKeys(tableName);

      return {
        tableName,
        documentCount: count,
        indexedKeys,
      };
    } catch (error) {
      throw new QueryError(
        `Failed to get metadata: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
}

