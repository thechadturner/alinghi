/**
 * HuniDB Store
 *
 * Per-class database management and data operations.
 * Timeseries data is not stored or read from HuniDB; use channel-values API and in-memory cache only.
 */

import { connect, type Database } from '@hunico/hunidb';
import { clearStorage } from '@hunico/hunidb';
import { createSchemaForClass } from './huniDBSchema.js';
import { getDatabaseName, TableNames, escapeTableName, type EventEntry, type TimeSeriesFilters, type MultiChannelResult, type DensityChartEntry, type DensityGroupEntry, type TargetEntry, type DatasetMetadata, type SidebarPagesCacheEntry, type AggregateEntry, type CloudDataEntry, type MapDataEntry } from './huniDBTypes.js';
import { debug, info, warn, error as logError } from '../utils/console.js';
import { isMobileDevice } from '../utils/deviceDetection.js';

/**
 * Retention configuration
 */
const RETENTION_CONFIG = {
  RETENTION_HOURS: 48,
  QUOTA_THRESHOLD_PERCENT: 80,
  TARGET_QUOTA_PERCENT: 60,
  MIN_SAFE_AGE_HOURS: 24, // Never delete datasets viewed in last 24 hours
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
};

/**
 * Filter metadata type for cache tracking
 * 
 * NOTE: Only API filters (events, configs, grades) are stored in cache metadata.
 * Client filters (states, raceNumbers, legNumbers) are NOT stored because they don't invalidate cache.
 * Client filters are applied post-query and don't affect cache validity.
 * 
 * API Filters (affect cache):
 * - events: Event name filters (YEAR, EVENT)
 * - configs: Configuration filters (CONFIG)
 * - grades: Grade filters (GRADE, only if included in API filters)
 * 
 * Client Filters (do NOT affect cache):
 * - states: State field filters (STATE) - always client-side
 * - raceNumbers: Race number filters (RACE) - always client-side
 * - legNumbers: Leg number filters (LEG) - always client-side
 */
export interface FilterSet {
  states?: string[]; // Client-side only - not used for cache validation
  events?: string[]; // API filter - affects cache
  configs?: string[]; // API filter - affects cache
  grades?: number[]; // API filter if included in API, otherwise client-side
  raceNumbers?: number[]; // Client-side only - not used for cache validation
  legNumbers?: number[]; // Client-side only - not used for cache validation
  dateRange?: { start: string; end: string };
}

/**
 * HuniDB Store - manages per-class databases
 */
export class HuniDBStore {
  private connections = new Map<string, Database>();
  private initPromises = new Map<string, Promise<Database>>();
  private retentionCleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Safely flush database, handling connection closing errors gracefully
   * The data has already been written, so flush failures are non-critical
   * 
   * @param immediate - If true, flush immediately. If false, defer to avoid blocking UI.
   */
  private async safeFlush(db: Database, context: string = 'operation', immediate: boolean = false): Promise<void> {
    try {
      // For non-critical operations, defer flush to avoid blocking UI
      // Critical operations (like page unload) should pass immediate=true
      await db.flush(immediate);
      // Silent success - only log errors to reduce console noise
      // Use debug level only for development debugging if needed
      debug(`[HuniDBStore] Successfully flushed database for ${context}`);
    } catch (error: any) {
      // Handle connection closing errors gracefully - data is already written
      if (error?.name === 'InvalidStateError' || 
          error?.message?.includes('connection is closing') ||
          error?.message?.includes('database connection is closing')) {
        debug(`[HuniDBStore] Database connection closing during flush for ${context}, data already persisted`);
        return;
      }
      // For other errors, log but don't throw - flush is for persistence, not critical
      warn(`[HuniDBStore] Non-critical flush error for ${context}:`, error);
    }
  }
  
  /**
   * Flush all open databases to IndexedDB
   * Call this before app closes to ensure data is persisted
   * 
   * @param immediate - If true, flush immediately (for page unload). If false, defer to avoid blocking UI.
   */
  async flushAll(immediate: boolean = false): Promise<void> {
    const dbCount = this.connections.size;
    if (dbCount === 0) {
      // No databases to flush - silently return (common on live pages that don't use HuniDB)
      return;
    }
    
    const startTime = performance.now();
    const flushPromises: Promise<void>[] = [];
    for (const [dbName, db] of this.connections) {
      flushPromises.push(this.safeFlush(db, `flushAll(${dbName})`, immediate));
    }
    
    try {
      await Promise.all(flushPromises);
      const elapsed = performance.now() - startTime;
      debug(`[HuniDBStore] ✓ Successfully flushed ${flushPromises.length} database(s) to IndexedDB in ${elapsed.toFixed(2)}ms`);
      info(`[HuniDBStore] Successfully flushed ${flushPromises.length} database(s) to IndexedDB in ${elapsed.toFixed(2)}ms`);
    } catch (error) {
      const elapsed = performance.now() - startTime;
      logError(`[HuniDBStore] Error flushing databases after ${elapsed.toFixed(2)}ms:`, error);
      throw error;
    }
  }

  /**
   * Get or create database for a class
   * HuniDB is now available on all device types, but storage of large data types
   * (aggregates, cloud data, timeseries) is restricted on mobile devices.
   */
  async getDatabase(className: string): Promise<Database> {
    // Prevent HuniDB initialization on live pages (they use Redis/streamingStore instead)
    if (typeof window !== 'undefined' && window.location.pathname.includes('/live/')) {
      throw new Error('HuniDB is not used on live pages - use streamingStore instead');
    }
    
    const dbName = getDatabaseName(className);
    
    // Return existing connection if available
    if (this.connections.has(dbName)) {
      return this.connections.get(dbName)!;
    }

    // Return existing init promise if in progress
    if (this.initPromises.has(dbName)) {
      return this.initPromises.get(dbName)!;
    }

    // Create new connection
    const initPromise = this.initializeDatabase(dbName, className);
    this.initPromises.set(dbName, initPromise);

    try {
      const db = await initPromise;
      this.connections.set(dbName, db);
      this.initPromises.delete(dbName);
      return db;
    } catch (error) {
      this.initPromises.delete(dbName);
      throw error;
    }
  }

  /**
   * List tables in a class database (excluding internal SQLite tables)
   */
  async listTables(className: string): Promise<Array<{ name: string; type: string }>> {
    const db = await this.getDatabase(className);

    try {
      const rows = await db.query<{ name: string; type: string }>(`
        SELECT name, type 
        FROM sqlite_master 
        WHERE type IN ('table', 'view') 
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      info(`[HuniDBStore] Listed ${rows.length} tables for class ${className}`);
      return rows;
    } catch (error) {
      logError(`[HuniDBStore] Failed to list tables for class ${className}:`, error);
      throw error;
    }
  }

  /**
   * Verify that indexes are automatically applied for a class database
   * Returns a report of all indexes found in the database
   */
  async verifyIndexes(className: string): Promise<{
    tables: Array<{
      name: string;
      indexes: Array<{
        name: string;
        unique: boolean;
        columns: Array<{ seqno: number; name: string }>;
      }>;
    }>;
    summary: {
      totalTables: number;
      totalIndexes: number;
      expectedIndexes: string[];
      foundIndexes: string[];
      missingIndexes: string[];
    };
  }> {
    const db = await this.getDatabase(className);

    try {
      // Get all tables
      const tables = await db.query<{ name: string }>(`
        SELECT name 
        FROM sqlite_master 
        WHERE type = 'table' 
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'json_keys_%'
          AND name NOT LIKE 'json_values_%'
        ORDER BY name
      `);

      const tableIndexes: Array<{
        name: string;
        indexes: Array<{
          name: string;
          unique: boolean;
          columns: Array<{ seqno: number; name: string }>;
        }>;
      }> = [];

      const allFoundIndexes: string[] = [];

      // For each table, get its indexes
      for (const table of tables) {
        const indexes = await db.query<{
          name: string;
          unique: number;
        }>(`
          SELECT name, "unique" as unique
          FROM pragma_index_list(${escapeTableName(table.name)})
        `);

        const indexDetails: Array<{
          name: string;
          unique: boolean;
          columns: Array<{ seqno: number; name: string }>;
        }> = [];

        for (const idx of indexes) {
          const columns = await db.query<{
            seqno: number;
            name: string;
          }>(`
            SELECT seqno, name
            FROM pragma_index_info(${escapeTableName(idx.name)})
            ORDER BY seqno
          `);

          indexDetails.push({
            name: idx.name,
            unique: idx.unique === 1,
            columns,
          });

          allFoundIndexes.push(idx.name);
        }

        tableIndexes.push({
          name: table.name,
          indexes: indexDetails,
        });
      }

      // Expected indexes based on schema (agg.aggregates indexes removed; table no longer used)
      const expectedIndexes = [
        // Events table
        'idx_agg_events_dataset',
        'idx_agg_events_time',
        // Cloud data table
        'idx_cloud_data_dataset',
        'idx_cloud_data_event',
        'idx_cloud_data_timestamp',
        // Map data table
        'idx_map_data_dataset',
        'idx_map_data_event',
        'idx_map_data_timestamp',
        // Density charts
        'idx_density_charts_dataset',
        'idx_density_groups_chart',
        // JSON objects
        'idx_json_objects_ts',
        // Meta tables
        'idx_meta_channels_dataset',
        'idx_cache_filters_key',
        'idx_cache_filters_dataset',
      ];

      // Filter expected indexes based on class (GP50 has additional indexes)
      const classNameUpper = className.toUpperCase();
      const filteredExpected = expectedIndexes.filter(idx => {
        if (idx.includes('gp50') && classNameUpper !== 'GP50') {
          return false;
        }
        return true;
      });

      const missingIndexes = filteredExpected.filter(
        expected => !allFoundIndexes.includes(expected)
      );

      const summary = {
        totalTables: tables.length,
        totalIndexes: allFoundIndexes.length,
        expectedIndexes: filteredExpected,
        foundIndexes: allFoundIndexes,
        missingIndexes,
      };

      info(`[HuniDBStore] Verified indexes for class ${className}: ${allFoundIndexes.length} indexes found across ${tables.length} tables`);
      
      if (missingIndexes.length > 0) {
        warn(`[HuniDBStore] Missing indexes for class ${className}:`, missingIndexes);
      }

      return {
        tables: tableIndexes,
        summary,
      };
    } catch (error) {
      logError(`[HuniDBStore] Failed to verify indexes for class ${className}:`, error);
      throw error;
    }
  }

  /**
   * Drop a specific table from a class database
   */
  async dropTable(className: string, tableName: string): Promise<void> {
    const trimmed = (tableName || '').trim();
    if (!trimmed) {
      warn(`[HuniDBStore] dropTable called with empty table name for class ${className}`);
      return;
    }

    const db = await this.getDatabase(className);

    try {
      await db.exec(`DROP TABLE IF EXISTS ${escapeTableName(trimmed)}`);
      info(`[HuniDBStore] Dropped table ${trimmed} for class ${className}`);
      await this.safeFlush(db, `dropTable(${className}.${trimmed})`);
    } catch (error) {
      logError(`[HuniDBStore] Failed to drop table ${trimmed} for class ${className}:`, error);
      throw error;
    }
  }

  /**
   * Clear all HuniDB data for a class from this browser.
   * This closes any open connection and removes the database from storage.
   */
  async clearDatabase(className: string): Promise<void> {
    const dbName = getDatabaseName(className);
    info(`[HuniDBStore] Clearing database for class ${className} (${dbName})`);

    // Close any existing connection first
    const existingConnection = this.connections.get(dbName);
    if (existingConnection) {
      try {
        await existingConnection.close();
      } catch (closeError) {
        debug(`[HuniDBStore] Error closing connection during clearDatabase (expected):`, closeError);
      }
      this.connections.delete(dbName);
    }

    // Remove from init promises so a fresh connection can be created later
    this.initPromises.delete(dbName);

    // Wait a bit to ensure connection is fully closed before clearing storage
    await new Promise(resolve => setTimeout(resolve, 200));

    await this.clearDatabaseStorage(dbName);

    // Small delay to ensure deletion is complete before future opens
    await new Promise(resolve => setTimeout(resolve, 300));

    // Clear cache initialization flag to ensure re-initialization
    try {
      const { persistantStore } = await import('./persistantStore');
      persistantStore.setIsCacheInitialized(false);
      debug(`[HuniDBStore] Cleared cache initialization flag after clearing database ${dbName}`);
    } catch (err) {
      warn(`[HuniDBStore] Failed to clear cache initialization flag:`, err);
    }

    info(`[HuniDBStore] Cleared database for class ${className} (${dbName})`);
  }

  /**
   * Clear a database from the underlying HuniDB storage container.
   * Used for corruption recovery and explicit admin-initiated clears.
   */
  private async clearDatabaseStorage(dbName: string): Promise<void> {
    info(`[HuniDBStore] Starting deletion of database: ${dbName}`);
    
    // Try clearStorage first (it uses IndexedDBStorage internally)
    try {
      await clearStorage(dbName, 'indexeddb');
      info(`[HuniDBStore] clearStorage completed for: ${dbName}`);
    } catch (storageError: any) {
      warn(`[HuniDBStore] clearStorage failed:`, storageError);
      // Continue to manual deletion
    }

    // Always do manual deletion to ensure it's removed
    const deleted = await new Promise<boolean>((resolve) => {
      const request = indexedDB.open('hunidb_storage', 1);

      request.onsuccess = () => {
        const database = request.result;
        if (!database) return;
        try {
          const transaction = database.transaction(['databases'], 'readwrite');
          const store = transaction.objectStore('databases');
          
          // Check if the database exists first
          const checkRequest = store.get(dbName);
          
          checkRequest.onsuccess = () => {
            const exists = !!checkRequest.result;
            info(`[HuniDBStore] Database ${dbName} exists in storage: ${exists}`);
            
            if (!exists) {
              info(`[HuniDBStore] Database ${dbName} already deleted`);
              database.close();
              resolve(true);
              return;
            }
            
            // Delete the database
            const deleteRequest = store.delete(dbName);
            
            deleteRequest.onsuccess = () => {
              info(`[HuniDBStore] Delete request succeeded for: ${dbName}`);
            };

            deleteRequest.onerror = () => {
              logError(`[HuniDBStore] Delete request failed:`, deleteRequest.error);
            };
          };
          
          checkRequest.onerror = () => {
            logError(`[HuniDBStore] Error checking if database exists:`, checkRequest.error);
          };

          // Wait for transaction to complete
          transaction.oncomplete = () => {
            info(`[HuniDBStore] Transaction completed for deletion of: ${dbName}`);
            database.close();
            resolve(true);
          };

          transaction.onerror = () => {
            logError(`[HuniDBStore] Transaction error:`, transaction.error);
            database.close();
            resolve(false);
          };
        } catch (error) {
          logError(`[HuniDBStore] Error in manual deletion:`, error);
          database.close();
          resolve(false);
        }
      };

      request.onerror = () => {
        logError(`[HuniDBStore] Failed to open storage container:`, request.error);
        resolve(false);
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('databases')) {
          db.createObjectStore('databases', { keyPath: 'name' });
        }
      };
    });
    
    if (!deleted) {
      throw new Error(`Failed to delete database ${dbName} from storage`);
    }
    
    // Wait to ensure persistence
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Verify deletion
    const stillExists = await this.verifyDatabaseExists(dbName);
    if (stillExists) {
      logError(`[HuniDBStore] Database ${dbName} still exists after deletion attempt!`);
      throw new Error(`Database ${dbName} still exists after deletion attempt`);
    }
    
    info(`[HuniDBStore] Successfully deleted and verified removal of: ${dbName}`);
  }

  /**
   * Verify if a database exists in storage
   */
  private async verifyDatabaseExists(dbName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = indexedDB.open('hunidb_storage', 1);
      
      request.onsuccess = () => {
        const db = request.result;
        try {
          const transaction = db.transaction(['databases'], 'readonly');
          const store = transaction.objectStore('databases');
          const getRequest = store.get(dbName);
          
          getRequest.onsuccess = () => {
            const exists = !!getRequest.result;
            debug(`[HuniDBStore] Database ${dbName} exists check: ${exists}`);
            db.close();
            resolve(exists);
          };
          
          getRequest.onerror = () => {
            warn(`[HuniDBStore] Error checking database existence:`, getRequest.error);
            db.close();
            resolve(false);
          };
        } catch (error) {
          warn(`[HuniDBStore] Error in verifyDatabaseExists:`, error);
          db.close();
          resolve(false);
        }
      };
      
      request.onerror = () => {
        warn(`[HuniDBStore] Failed to open storage for verification:`, request.error);
        resolve(false);
      };
      
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('databases')) {
          db.createObjectStore('databases', { keyPath: 'name' });
        }
      };
    });
  }

  /**
   * Initialize a database with migrations
   * Automatically handles corruption by clearing and retrying
   */
  private async initializeDatabase(dbName: string, className: string, retryOnCorruption: boolean = true): Promise<Database> {
    try {
      debug(`[HuniDBStore] Initializing database: ${dbName} for class: ${className}`);
      
      const db = await connect({
        name: dbName,
        storage: 'indexeddb',
        queryTimeout: 30000,
        verbose: false,
      });

      // Create schema for this class
      await createSchemaForClass(db, className);
      
      debug(`[HuniDBStore] Database initialized: ${dbName}`);
      return db;
    } catch (error: any) {
      // Check if this is a migration error - if so, clear database and recreate
      const errorMessage = error?.message || String(error);
      const isMigrationError = errorMessage.includes('MigrationError') || 
                              errorMessage.includes('Failed to apply migration') ||
                              error?.name === 'MigrationError';
      
      if (isMigrationError && retryOnCorruption) {
        warn(`[HuniDBStore] Migration failed for ${dbName}, clearing database and recreating...`, error);

        try {
          // Close any existing connection first
          const existingConnection = this.connections.get(dbName);
          if (existingConnection) {
            try {
              await existingConnection.close();
            } catch (closeError) {
              debug(`[HuniDBStore] Error closing connection during migration retry (expected):`, closeError);
            }
            this.connections.delete(dbName);
          }
          
          // Remove from init promises
          this.initPromises.delete(dbName);
          
          // Wait a bit to ensure connection is fully closed
          await new Promise(resolve => setTimeout(resolve, 200));
          
          // Clear the database storage
          await this.clearDatabaseStorage(dbName);
          
          // Wait a bit more to ensure deletion is complete
          await new Promise(resolve => setTimeout(resolve, 300));

          // Clear cache initialization flag to ensure re-initialization
          try {
            const { persistantStore } = await import('./persistantStore');
            persistantStore.setIsCacheInitialized(false);
            debug(`[HuniDBStore] Cleared cache initialization flag after migration error clear`);
          } catch (err) {
            warn(`[HuniDBStore] Failed to clear cache initialization flag:`, err);
          }

          info(`[HuniDBStore] Cleared database ${dbName} due to migration error, retrying initialization...`);
          
          // Retry initialization (only once to prevent infinite loop)
          return await this.initializeDatabase(dbName, className, false);
        } catch (clearError) {
          logError(`[HuniDBStore] Failed to clear database ${dbName} after migration error:`, clearError);
          throw error; // Throw original migration error
        }
      }
      
      // Check if this is a corruption error
      const isCorruption = errorMessage.includes('SQLITE_CORRUPT') || 
                          errorMessage.includes('database disk image is malformed') ||
                          errorMessage.includes('sqlite3 result code 11');
      
      if (isCorruption && retryOnCorruption) {
        warn(`[HuniDBStore] Database ${dbName} is corrupted, clearing and retrying...`, error);

        try {
          // Close any existing connection first
          const existingConnection = this.connections.get(dbName);
          if (existingConnection) {
            try {
              await existingConnection.close();
            } catch (closeError) {
              debug(`[HuniDBStore] Error closing corrupted connection (expected):`, closeError);
            }
            this.connections.delete(dbName);
          }
          
          // Remove from init promises
          this.initPromises.delete(dbName);
          
          // Wait a bit to ensure connection is fully closed
          await new Promise(resolve => setTimeout(resolve, 200));
          
          // Clear the corrupted database storage
          await this.clearDatabaseStorage(dbName);
          
          // Wait a bit more to ensure deletion is complete
          await new Promise(resolve => setTimeout(resolve, 300));

          // Clear cache initialization flag to ensure re-initialization
          try {
            const { persistantStore } = await import('./persistantStore');
            persistantStore.setIsCacheInitialized(false);
            debug(`[HuniDBStore] Cleared cache initialization flag after corruption clear`);
          } catch (err) {
            warn(`[HuniDBStore] Failed to clear cache initialization flag:`, err);
          }

          // At this point the corrupted database image has been deleted and will be
          // replaced with a fresh empty database on the next initialization attempt.
          // Log this as an error so we have a durable record of the corruption event.
          logError(
            `[HuniDBStore] HuniDB database ${dbName} was corrupted and has been cleared and replaced with a new empty database.`,
            {
              dbName,
              errorMessage,
              errorCode: error?.code,
              name: error?.name,
            }
          );

          info(`[HuniDBStore] Cleared corrupted database ${dbName}, retrying initialization...`);
          
          // Retry initialization (only once to prevent infinite loop)
          return await this.initializeDatabase(dbName, className, false);
        } catch (clearError) {
          logError(`[HuniDBStore] Failed to clear corrupted database ${dbName}:`, clearError);
          throw error; // Throw original corruption error
        }
      }
      
      logError(`[HuniDBStore] Failed to initialize database ${dbName}:`, error);
      throw error;
    }
  }

  /**
   * Escape SQL identifier for column/table names
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Build cache key for aggregates based on query filters
   */
  /**
   * Cleanup stale filter metadata (older than 24 hours)
   */
  async cleanupStaleFilterMetadata(className: string): Promise<void> {
    try {
      const db = await this.getDatabase(className);
      const cutoff = Math.floor(Date.now() / 1000) - (24 * 60 * 60); // 24 hours ago in seconds
      
      const result = await db.exec(`
        DELETE FROM ${this.escapeIdentifier('meta.cache_filters')}
        WHERE last_accessed < ?
      `, [cutoff]);
      
      const changeCount = (result as unknown as { changes?: number })?.changes ?? 0;
      debug(`[HuniDBStore] Cleaned up stale filter metadata: ${changeCount} entries`);
    } catch (error) {
      logError(`[HuniDBStore] Error cleaning up stale filter metadata:`, error);
    }
  }

  /**
   * Track source metadata
   */
  async trackSourceMetadata(
    className: string,
    projectId: string | number,
    sourceId: string | number,
    sourceName?: string,
    color?: string,
    fleet?: number,
    visible?: number
  ): Promise<void> {
    try {
      const db = await this.getDatabase(className);
      
      // Convert to numbers for database storage (SQLite will handle string numbers, but we ensure consistency)
      const projectIdNum = typeof projectId === 'string' ? Number(projectId) : projectId;
      const sourceIdNum = typeof sourceId === 'string' ? Number(sourceId) : sourceId;
      
      // Validate that conversion was successful
      if (isNaN(projectIdNum) || isNaN(sourceIdNum)) {
        warn(`[HuniDBStore] Invalid projectId or sourceId:`, { projectId, sourceId });
        return;
      }
      
      await db.exec(
        `INSERT OR REPLACE INTO "meta.sources" 
          (source_id, project_id, source_name, color, fleet, visible) 
          VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sourceIdNum,
          projectIdNum,
          sourceName || null,
          color || null,
          fleet !== undefined ? fleet : null,
          visible !== undefined ? visible : null
        ]
      );
    } catch (error: any) {
      // If error is "HuniDB is disabled on mobile", that's expected - ignore silently
      if (error?.message?.includes('mobile devices')) {
        return;
      }
      warn(`[HuniDBStore] Failed to track source metadata:`, error);
    }
  }

  /**
   * Get sources from meta.sources cache
   */
  async getSourcesFromCache(className: string, projectId: string): Promise<Array<{
    source_id: string;
    project_id: string;
    source_name: string | null;
    color: string | null;
    fleet: number | null;
    visible: number | null;
  }> | null> {
    try {
      const db = await this.getDatabase(className);
      const results = await db.query<{
        source_id: string;
        project_id: string;
        source_name: string | null;
        color: string | null;
        fleet: number | null;
        visible: number | null;
      }>(
        `SELECT source_id, project_id, source_name, color, fleet, visible 
          FROM "meta.sources" 
          WHERE project_id = ?`,
        [projectId]
      );
      return results || null;
    } catch (error) {
      warn(`[HuniDBStore] Failed to get sources from cache:`, error);
      return null;
    }
  }

  /**
   * Update last_viewed_date for a dataset when it is viewed
   */
  async updateDatasetLastViewed(className: string, datasetId: string): Promise<void> {
    // Always allow: lightweight metadata (even when data cache is off)
    try {
      const db = await this.getDatabase(className);
      const now = Date.now();
      
      // Update last_viewed_date if dataset exists
      await db.exec(
        `UPDATE "meta.datasets" 
         SET last_viewed_date = ? 
         WHERE dataset_id = ?`,
        [now, datasetId]
      );
      
      debug(`[HuniDBStore] Updated last_viewed_date for dataset ${datasetId} in ${className}`);
    } catch (error: any) {
      // If error is "HuniDB is disabled on mobile", that's expected - ignore
      if (error?.message?.includes('mobile devices')) {
        return;
      }
      warn(`[HuniDBStore] Failed to update last_viewed_date for dataset ${datasetId}:`, error);
    }
  }

  /**
   * Get cached dataset metadata for a class from meta.datasets
   */
  async getCachedDatasets(className: string): Promise<DatasetMetadata[]> {
    const db = await this.getDatabase(className);

    try {
      const rows = await db.query<DatasetMetadata & { date_modified: number | null; last_viewed_date: number | null }>(`
        SELECT 
          dataset_id,
          project_id,
          date,
          source_id,
          class_name,
          created_at,
          row_count,
          first_timestamp,
          last_timestamp,
          date_modified,
          last_viewed_date
        FROM "meta.datasets"
        ORDER BY date DESC, project_id, source_id
      `);
      
      // Map date_modified to dateModified (camelCase) for compatibility
      const mappedRows = rows.map(row => ({
        ...row,
        dateModified: row.date_modified || undefined
      }));

      info(`[HuniDBStore] Retrieved ${mappedRows.length} cached datasets for class ${className}`);
      return mappedRows;
    } catch (error) {
      warn(`[HuniDBStore] Failed to get cached datasets from meta.datasets:`, error);
      return [];
    }
  }



  /**
   * Metadata channels that should NOT be stored as time-series tables
   * These should be stored in the metadata JSON column instead
   */
  private readonly METADATA_CHANNELS = new Set([
    'Datetime',
    'timestamp',
    'source_id',
    'source_name',
    'Race_number',
    'Leg_number',
    'Grade',
    'TACK',
    'event_id',
    'Config',
    'State',
    'GRADE', // Case variations
    'race_number',
    'leg_number',
    'grade',
    'tack',
    'Event_id',
    'Event_Id',
    'config',
    'state',
    'CONFIG',
    'STATE'
  ]);

  /**
   * Check if a channel is a metadata channel (should not be stored as time-series)
   * @param channel - Channel name to check
   * @param requestedChannels - Optional set of explicitly requested channels (lowercase). If channel is in this set, it's treated as a data channel, not metadata.
   */
  private isMetadataChannel(channel: string, requestedChannels?: Set<string>): boolean {
    if (!channel || typeof channel !== 'string') return true;
    const ch = channel.trim();
    if (ch.length === 0) return true;
    const chLower = ch.toLowerCase();
    
    // If channel is explicitly requested, it's a data channel, not metadata
    if (requestedChannels && requestedChannels.has(chLower)) {
      return false;
    }
    
    return this.METADATA_CHANNELS.has(ch) || 
           this.METADATA_CHANNELS.has(chLower) ||
           chLower.endsWith('_code') ||
           chLower.endsWith('_number') ||
           chLower === 'grade';
  }

  /**
   * Find table name case-insensitively (SQLite table names are case-insensitive)
   * Returns the actual table name as stored in sqlite_master, or null if not found
   */
  private async findTableCaseInsensitive(db: Database, tableName: string): Promise<string | null> {
    try {
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master 
         WHERE type='table' AND LOWER(name) = LOWER(?)
         LIMIT 1`,
        [tableName]
      );
      return tables.length > 0 ? tables[0].name : null;
    } catch (error) {
      debug(`[HuniDBStore] Error finding table case-insensitively:`, error);
      return null;
    }
  }

  /**
   * Store time-series data for multiple channels
   * Uses per-channel tables (ts.Bsp, ts.Tws, etc.) instead of wide tables
   * @param context - Ignored, kept for backward compatibility
   */
  async storeTimeSeriesData(
    _className: string,
    _datasetId: number,
    _projectId: number,
    _sourceId: number,
    _channels: string[],
    _data: Array<Record<string, any>>,
    _context?: string  // Ignored, kept for backward compatibility
  ): Promise<void> {
    // Timeseries no longer cached in HuniDB (API + in-memory only)
    return;
  }

  /**
   * Check which of the requested channels exist in meta.channels for the given IDs
   * This is the fast way to check if data has been loaded into HuniDB
   */
  async checkChannelsInMeta(
    className: string,
    datasetId: number,
    projectId: number,
    sourceId: number,
    requestedChannels: string[],
    dataType: 'timeseries' | 'mapdata' | 'aggregates' = 'timeseries'
  ): Promise<{ found: string[]; missing: string[] }> {
    if (requestedChannels.length === 0) {
      return { found: [], missing: [] };
    }

    const db = await this.getDatabase(className);
    const found: string[] = [];
    const missing: string[] = [];

    try {
      // For timeseries, query meta.channels directly
      if (dataType === 'timeseries') {
        // CRITICAL: Query using channel names in their original/normal case
        // Channel names in meta.channels are stored in original case (e.g., "Tws_kts", "Bsp_kts")
        // We should query with exact case first, then fall back to case-insensitive if needed
        const placeholders = requestedChannels.map(() => '?').join(', ');
        const params = requestedChannels; // Use original case channel names
        
        // First, try exact case matching (most efficient and correct)
        // CRITICAL: Query using channel names in their original/normal case with exact IDs
        info(`[HuniDBStore] Querying meta.channels with exact case channel names:`, {
          datasetId,
          projectId,
          sourceId,
          dataType,
          requestedChannels: requestedChannels.slice(0, 10),
          channelCount: requestedChannels.length,
          note: 'Using exact case matching first, then case-insensitive fallback if needed'
        });
        
        let existingChannels = await db.query<{ channel_name: string }>(`
          SELECT channel_name FROM "meta.channels"
          WHERE dataset_id = ? AND project_id = ? AND source_id = ? AND data_type = ?
          AND row_count > 0
          AND channel_name IN (${placeholders})
        `, [String(datasetId), String(projectId), String(sourceId), dataType, ...params]);
        
        debug(`[HuniDBStore] Exact case query found ${existingChannels.length} channels`, {
          found: existingChannels.slice(0, 5).map(ch => ch.channel_name),
          requested: requestedChannels.length
        });
        
        // If exact match found all channels, use those results
        // Otherwise, try case-insensitive matching for any remaining channels
        const foundChannelsLower = new Set(existingChannels.map(ch => ch.channel_name.toLowerCase()));
        const missingFromExact = requestedChannels.filter(ch => !foundChannelsLower.has(ch.toLowerCase()));
        
        if (missingFromExact.length > 0) {
          // Fall back to case-insensitive matching for channels not found with exact case
          const caseInsensitivePlaceholders = missingFromExact.map(() => 'LOWER(?)').join(', ');
          const caseInsensitiveParams = missingFromExact.map(ch => ch.toLowerCase());
          
          const caseInsensitiveChannels = await db.query<{ channel_name: string }>(`
            SELECT channel_name FROM "meta.channels"
            WHERE dataset_id = ? AND project_id = ? AND source_id = ? AND data_type = ?
            AND row_count > 0
            AND LOWER(channel_name) IN (${caseInsensitivePlaceholders})
          `, [String(datasetId), String(projectId), String(sourceId), dataType, ...caseInsensitiveParams]);
          
          // Merge results, avoiding duplicates
          const existingChannelsLower = new Set(existingChannels.map(ch => ch.channel_name.toLowerCase()));
          caseInsensitiveChannels.forEach(ch => {
            if (!existingChannelsLower.has(ch.channel_name.toLowerCase())) {
              existingChannels.push(ch);
            }
          });
          
          if (caseInsensitiveChannels.length > 0) {
            debug(`[HuniDBStore] Found ${caseInsensitiveChannels.length} channels via case-insensitive matching (exact case found ${existingChannels.length - caseInsensitiveChannels.length})`, {
              exactCaseFound: existingChannels.length - caseInsensitiveChannels.length,
              caseInsensitiveFound: caseInsensitiveChannels.length,
              sampleCaseInsensitive: caseInsensitiveChannels.slice(0, 3).map(ch => ch.channel_name)
            });
          }
        }

        // Build sets for fast lookup (case-insensitive)
        const existingChannelsLower = new Set(
          existingChannels.map(ch => ch.channel_name.toLowerCase())
        );
        
        // Build map of lowercase -> original case from meta.channels
        const channelNameMap = new Map<string, string>();
        existingChannels.forEach(ch => {
          const chLower = ch.channel_name.toLowerCase();
          if (!channelNameMap.has(chLower)) {
            channelNameMap.set(chLower, ch.channel_name); // Store original case from meta.channels
          }
        });

        // Categorize requested channels
        // Use the original case channel names from meta.channels when found
        requestedChannels.forEach(ch => {
          const chLower = ch.toLowerCase();
          if (existingChannelsLower.has(chLower)) {
            // Use the original case from meta.channels (this is the source of truth)
            const originalCaseFromMeta = channelNameMap.get(chLower);
            found.push(originalCaseFromMeta || ch); // Prefer original case from meta.channels
          } else {
            missing.push(ch);
          }
        });

        // DIAGNOSTIC: If channels are missing, check if they exist with different IDs
        if (missing.length > 0) {
          try {
            const diagnosticQuery = requestedChannels
              .filter(ch => missing.includes(ch))
              .map(() => 'LOWER(?)')
              .join(', ');
            const diagnosticParams = missing.map(ch => ch.toLowerCase());
            
            const channelsWithDifferentIds = await db.query<{ channel_name: string; dataset_id: string; project_id: string; source_id: string; row_count: number }>(`
              SELECT DISTINCT channel_name, dataset_id, project_id, source_id, row_count 
              FROM "meta.channels"
              WHERE data_type = ? AND row_count > 0
              AND LOWER(channel_name) IN (${diagnosticQuery})
            `, [dataType, ...diagnosticParams]);
            
            if (channelsWithDifferentIds && channelsWithDifferentIds.length > 0) {
              const uniqueIds = new Set<string>();
              channelsWithDifferentIds.forEach(ch => {
                uniqueIds.add(`${ch.dataset_id}/${ch.project_id}/${ch.source_id}`);
              });
              
              warn(`[HuniDBStore] 🔍 DIAGNOSTIC: ${missing.length} requested channels not found for dataset ${datasetId}/project ${projectId}/source ${sourceId}, but found ${channelsWithDifferentIds.length} matching channels with DIFFERENT IDs:`, {
                queriedIds: `${datasetId}/${projectId}/${sourceId}`,
                foundIds: Array.from(uniqueIds).slice(0, 10),
                missingChannels: missing.slice(0, 10),
                sampleChannelsWithDifferentIds: channelsWithDifferentIds.slice(0, 5).map(ch => ({
                  channel: ch.channel_name,
                  ids: `${ch.dataset_id}/${ch.project_id}/${ch.source_id}`,
                  rowCount: ch.row_count
                })),
                note: 'Channels exist in HuniDB but with different dataset_id/project_id/source_id. This is why they\'re not being found. Check if data was stored with different IDs.'
              });
            }
          } catch (diagError) {
            debug(`[HuniDBStore] Diagnostic query failed (non-critical):`, diagError);
          }
        }

        debug(`[HuniDBStore] checkChannelsInMeta: ${found.length} found, ${missing.length} missing`, {
          datasetId,
          projectId,
          sourceId,
          found: found.slice(0, 5),
          missing: missing.slice(0, 5)
        });
      } else {
        // mapdata/aggregates no longer cached in HuniDB; treat all as missing
        missing.push(...requestedChannels);
      }
    } catch (error) {
      logError(`[HuniDBStore] Error checking channels in meta.channels:`, error);
      // On error, assume all are missing (safer to fetch from API)
      return { found: [], missing: [...requestedChannels] };
    }

    return { found, missing };
  }

  /**
   * Two-phase channel validation: 
   * Phase 1: Check if channel exists in meta.channels
   * Phase 2: If exists, verify ts. table has non-null data for specific IDs
   * 
   * Returns channels categorized as:
   * - foundWithData: Channels that exist in meta.channels AND have non-null data in ts. table
   * - foundWithoutData: Channels that exist in meta.channels BUT have no non-null data in ts. table
   * - missing: Channels that don't exist in meta.channels
   */
  async checkChannelsWithDataValidation(
    className: string,
    datasetId: number,
    projectId: number,
    sourceId: number,
    requestedChannels: string[],
    dataType: 'timeseries' | 'mapdata' | 'aggregates' = 'timeseries'
  ): Promise<{ foundWithData: string[]; foundWithoutData: string[]; missing: string[] }> {
    if (requestedChannels.length === 0) {
      return { foundWithData: [], foundWithoutData: [], missing: [] };
    }

    const db = await this.getDatabase(className);
    const foundWithData: string[] = [];
    const foundWithoutData: string[] = [];
    const missing: string[] = [];

    try {
      // Phase 1: Check meta.channels
      const metaCheck = await this.checkChannelsInMeta(
        className,
        datasetId,
        projectId,
        sourceId,
        requestedChannels,
        dataType
      );

      debug(`[HuniDBStore] Two-phase check - Phase 1 complete: ${metaCheck.found.length} found in meta.channels, ${metaCheck.missing.length} missing`, {
        datasetId,
        projectId,
        sourceId,
        foundInMeta: metaCheck.found.slice(0, 5),
        missingFromMeta: metaCheck.missing.slice(0, 5)
      });

      // Channels not in meta.channels are definitely missing
      missing.push(...metaCheck.missing);

      // Phase 2: For channels found in meta.channels, verify ts. table has non-null data
      // OPTIMIZED: Batch all table lookups and data checks in parallel for performance
      if (dataType === 'timeseries' && metaCheck.found.length > 0) {
        // Step 1: Batch find all tables in parallel
        const tableLookups = await Promise.all(
          metaCheck.found.map(async (channel) => {
            const tableName = `ts.${channel}`;
            const actualTable = await this.findTableCaseInsensitive(db, tableName);
            return { channel, tableName, actualTable };
          })
        );

        // Step 2: Separate channels by whether their table exists
        const channelsWithTables: Array<{ channel: string; actualTable: string }> = [];
        const channelsWithoutTables: string[] = [];

        for (const { channel, tableName, actualTable } of tableLookups) {
          if (actualTable) {
            channelsWithTables.push({ channel, actualTable });
          } else {
            channelsWithoutTables.push(channel);
            debug(`[HuniDBStore] Two-phase check - Phase 2: Channel ${channel} exists in meta.channels but table ${tableName} does not exist`);
          }
        }

        // Step 3: Batch check all tables for non-null data in parallel
        const dataChecks = await Promise.all(
          channelsWithTables.map(async ({ channel, actualTable }) => {
            try {
              // Use EXISTS for better performance - stops at first non-null value found
              const hasData = await db.queryValue<number>(
                `SELECT 1 FROM ${escapeTableName(actualTable)} 
                 WHERE dataset_id = ? AND project_id = ? AND source_id = ? 
                 AND value IS NOT NULL
                 LIMIT 1`,
                [String(datasetId), String(projectId), String(sourceId)]
              );
              return { channel, actualTable, hasData: hasData !== null && hasData !== undefined };
            } catch (error: any) {
              logError(`[HuniDBStore] Two-phase check - Phase 2: Error checking channel ${channel}:`, error);
              return { channel, actualTable, hasData: false };
            }
          })
        );

        // Step 4: Categorize channels based on results
        for (const { channel, hasData } of dataChecks) {
          if (hasData) {
            foundWithData.push(channel);
          } else {
            foundWithoutData.push(channel);
            debug(`[HuniDBStore] Two-phase check - Phase 2: Channel ${channel} exists in meta.channels and table exists, but has no non-null values for these IDs`);
          }
        }

        // Channels without tables go to foundWithoutData
        foundWithoutData.push(...channelsWithoutTables);

        if (channelsWithoutTables.length > 0) {
          warn(`[HuniDBStore] Two-phase check - Phase 2: ${channelsWithoutTables.length} channels exist in meta.channels but tables do not exist`, {
            channelsWithoutTables: channelsWithoutTables.slice(0, 10),
            datasetId,
            projectId,
            sourceId
          });
        }

        if (foundWithoutData.length > 0 && foundWithoutData.length <= 10) {
          info(`[HuniDBStore] Two-phase check - Phase 2: ${foundWithoutData.length} channels will be fetched from API (no data in ts. tables)`, {
            foundWithoutData: foundWithoutData.slice(0, 10),
            datasetId,
            projectId,
            sourceId
          });
        }
      }
      // mapdata/aggregates: not cached in HuniDB; foundWithData stays empty (missing already set in Phase 1)

      debug(`[HuniDBStore] Two-phase check complete:`, {
        datasetId,
        projectId,
        sourceId,
        dataType,
        foundWithData: foundWithData.length,
        foundWithoutData: foundWithoutData.length,
        missing: missing.length,
        foundWithDataChannels: foundWithData.slice(0, 5),
        foundWithoutDataChannels: foundWithoutData.slice(0, 5),
        missingChannels: missing.slice(0, 5)
      });

    } catch (error) {
      logError(`[HuniDBStore] Error in two-phase channel validation:`, error);
      // On error, assume all are missing (safer to fetch from API)
      return { 
        foundWithData: [], 
        foundWithoutData: [], 
        missing: [...requestedChannels] 
      };
    }

    return { foundWithData, foundWithoutData, missing };
  }

  /**
   * Query data by channels with SQL JOINs
   */
  async queryDataByChannels(
    className: string,
    datasetId: number,
    projectId: number,
    sourceId: number,
    requestedChannels: string[],
    dataTypes: ('mapdata' | 'timeseries' | 'aggregates')[] = ['timeseries'],
    timeRange?: { start: number; end: number },
    filters?: TimeSeriesFilters,
    _description?: string // Optional description filter for mapdata ('dataset' or 'day')
  ): Promise<MultiChannelResult[]> {
    // Query methods work on mobile - they'll return empty results if data wasn't stored
    const db = await this.getDatabase(className);

    try {
      // Filter out metadata channels - these should NOT be queried as time-series tables
      // Metadata channels are stored in the metadata JSON column, not as separate tables
      // CRITICAL: For timeseries data, Race_number, Leg_number, Grade, and State can be actual data channels
      // Only filter them out if they're NOT explicitly requested
      const requestedChannelsLower = new Set(requestedChannels.map((ch: string) => ch.toLowerCase()));
      
      let channelsToQuery = requestedChannels.filter(ch => {
        // If channel is explicitly requested, include it (it's a data channel, not metadata)
        // Otherwise, use standard metadata filtering
        return !this.isMetadataChannel(ch, requestedChannelsLower);
      });

      // Only log at trace level to reduce noise - commented out for production
      // debug(`[HuniDBStore] queryDataByChannels called`, {
      //   className,
      //   datasetId,
      //   projectId,
      //   sourceId,
      //   requestedChannels: requestedChannels.slice(0, 10),
      //   channelsToQuery: channelsToQuery.slice(0, 10),
      //   dataTypes: dataTypes.join(',')
      // });

      // If no channels requested, get all available channels for this source
      if (channelsToQuery.length === 0) {
        info(`[HuniDBStore] No channels requested, discovering available channels for dataTypes: ${dataTypes.join(', ')}`);
        channelsToQuery = await this.getAvailableChannels(className, datasetId, projectId, sourceId, dataTypes);
        if (channelsToQuery.length === 0) {
          // This is expected when data hasn't been cached yet - use debug instead of warn
          debug(`[HuniDBStore] No available channels found for ${className}/${datasetId}/${projectId}/${sourceId} with dataTypes: ${dataTypes.join(', ')} (data may not be cached yet)`);
          return [];
        }
        info(`[HuniDBStore] Empty channel list, using all available channels: ${channelsToQuery.join(', ')}`);
      }

      // Map data no longer cached in HuniDB; return [] when querying mapdata only.
      if (dataTypes.includes('mapdata') && !dataTypes.includes('timeseries')) {
        return [];
      }

      // For timeseries, use per-channel tables with JOIN
      // Filter out metadata channels
      const dataChannels = channelsToQuery.filter(ch =>
        !['Datetime', 'timestamp', 'Race_number', 'Leg_number', 'Grade'].includes(ch)
      );

      if (dataChannels.length === 0) {
        debug(`[HuniDBStore] No data channels to query (all filtered as metadata)`);
        return [];
      }

      // When timeseries is not cached in HuniDB, there are no ts.* tables; return [] without logging.
      if (dataTypes.includes('timeseries')) {
        const allTables = await db.query<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ts.%' LIMIT 1`
        );
        if (allTables.length === 0) {
          return [];
        }
      }

      // Build JOIN query across channel tables
      // Use original case channel names, but lookup tables case-insensitively
      const baseChannel = dataChannels[0];
      const baseTableRequested = `ts.${baseChannel}`;
      const baseAlias = 't0';

      // Find actual table name (case-insensitive lookup)
      const baseTable = await this.findTableCaseInsensitive(db, baseTableRequested);

      if (!baseTable) {
        debug(`[HuniDBStore] Base channel table ${baseTableRequested} does not exist (case-insensitive lookup)`);
        return [];
      }
      
      // Handle both 'timestamp' and 'ts' column names (for backward compatibility with old database schemas)
      // Check which column exists in the base table
      // CRITICAL: Always return 'timestamp' in milliseconds, converting from 'ts' (seconds) if needed
      const baseTableInfo = await db.query<{ name: string; type: string }>(
        `PRAGMA table_info(${escapeTableName(baseTable)})`
      );
      const hasTimestamp = baseTableInfo.some(col => col.name.toLowerCase() === 'timestamp');
      const hasTs = baseTableInfo.some(col => col.name.toLowerCase() === 'ts');
      
      // Prefer 'timestamp' column if it exists, otherwise use 'ts' and convert to milliseconds
      // Also determine the actual column name for JOINs (not the SELECT expression)
      let timestampSelect: string;
      let timestampColumn: string; // Column name for JOINs (not the SELECT expression)
      if (hasTimestamp) {
        timestampSelect = `${baseAlias}.timestamp as timestamp`;
        timestampColumn = 'timestamp';
      } else if (hasTs) {
        // Convert ts (seconds) to timestamp (milliseconds) in SELECT
        timestampSelect = `(${baseAlias}.ts * 1000) as timestamp`;
        timestampColumn = 'ts'; // Use 'ts' for JOINs since that's the actual column name
      } else {
        // Default to timestamp (shouldn't happen, but handle gracefully)
        timestampSelect = `${baseAlias}.timestamp as timestamp`;
        timestampColumn = 'timestamp';
      }
      
      let selectClauses = [
        timestampSelect,
        `${baseAlias}.dataset_id`,
        `${baseAlias}.source_id`,
        `${baseAlias}.project_id`,
        `${baseAlias}.date`,
        `${baseAlias}.tags`
      ];
      
      // Track which channels have valid tables (for building SELECT and JOIN clauses)
      // Store original channel name but use actual table name (may differ in case)
      const validChannels: Array<{ channel: string; alias: string; table: string }> = [
        { channel: dataChannels[0], alias: baseAlias, table: baseTable }
      ];
      
      // Check existence of all channel tables first (case-insensitive)
      for (let i = 1; i < dataChannels.length; i++) {
        const channel = dataChannels[i];
        const tableRequested = `ts.${channel}`;
        const alias = `t${i}`;
        
        // Find actual table name (case-insensitive lookup)
        const actualTable = await this.findTableCaseInsensitive(db, tableRequested);
        
        if (actualTable) {
          validChannels.push({ channel, alias, table: actualTable });
        } else {
          debug(`[HuniDBStore] Channel table ${tableRequested} does not exist (case-insensitive lookup), skipping`);
        }
      }
      
      // Add channel value selections ONLY for channels with valid tables
      // Return channels using their requested names (preserve case from request)
      // The table lookup is case-insensitive, but we return the channel name as requested
      for (const { channel, alias } of validChannels) {
        selectClauses.push(`${alias}.value as ${this.escapeIdentifier(channel)}`);
      }
      
      // Build FROM and JOIN clauses
      let fromClause = `${escapeTableName(baseTable)} ${baseAlias}`;
      let joinClauses = '';
      
      // Build JOINs only for valid channels (skip base table, it's already in FROM)
      for (let i = 1; i < validChannels.length; i++) {
        const { alias, table } = validChannels[i];
        joinClauses += `
          LEFT JOIN ${escapeTableName(table)} ${alias}
          ON ${baseAlias}.${timestampColumn} = ${alias}.${timestampColumn}
          AND ${baseAlias}.dataset_id = ${alias}.dataset_id
          AND ${baseAlias}.source_id = ${alias}.source_id
        `;
      }
      
      // Build WHERE clause
      let whereClause = `
        WHERE ${baseAlias}.dataset_id = ? 
        AND ${baseAlias}.project_id = ? 
        AND ${baseAlias}.source_id = ?
      `;
      const params = [String(datasetId), String(projectId), String(sourceId)];
      
      if (timeRange) {
        whereClause += ` AND ${baseAlias}.${timestampColumn} >= ? AND ${baseAlias}.${timestampColumn} <= ?`;
        params.push(String(timeRange.start), String(timeRange.end));
      }
      
      // Add filters from tags JSON
      // Use normalized field names as primary, with old names as fallback for backward compatibility
      if (filters) {
        if (filters.raceNumbers && filters.raceNumbers.length > 0) {
          // Check normalized field name first, then old name for backward compatibility
          whereClause += ` AND (
            json_extract(${baseAlias}.tags, '$.race_number') IN (${filters.raceNumbers.map(() => '?').join(',')})
            OR json_extract(${baseAlias}.tags, '$.Race_number') IN (${filters.raceNumbers.map(() => '?').join(',')})
          )`;
          params.push(...filters.raceNumbers.map(n => String(n)), ...filters.raceNumbers.map(n => String(n)));
        }
        if (filters.legNumbers && filters.legNumbers.length > 0) {
          // Check normalized field name first, then old name for backward compatibility
          whereClause += ` AND (
            json_extract(${baseAlias}.tags, '$.leg_number') IN (${filters.legNumbers.map(() => '?').join(',')})
            OR json_extract(${baseAlias}.tags, '$.Leg_number') IN (${filters.legNumbers.map(() => '?').join(',')})
          )`;
          params.push(...filters.legNumbers.map(n => String(n)), ...filters.legNumbers.map(n => String(n)));
        }
        if (filters.grades && filters.grades.length > 0) {
          // Check normalized field name first, then old name for backward compatibility
          whereClause += ` AND (
            json_extract(${baseAlias}.tags, '$.grade') IN (${filters.grades.map(() => '?').join(',')})
            OR json_extract(${baseAlias}.tags, '$.Grade') IN (${filters.grades.map(() => '?').join(',')})
          )`;
          params.push(...filters.grades.map(n => String(n)), ...filters.grades.map(n => String(n)));
        }
      }
      
      const sql = `
        SELECT ${selectClauses.join(', ')}
        FROM ${fromClause}
        ${joinClauses}
        ${whereClause}
        ORDER BY ${baseAlias}.${timestampColumn} ASC
      `;
      
      const rows = await db.query<Record<string, any>>(sql, params);
      
      // Transform results: parse tags JSON and add metadata fields
      return rows.map(row => {
        const tags = row.tags ? JSON.parse(row.tags) : {};
        // Use timestamp in milliseconds (ts field removed - only timestamp is used)
        // If database has 'ts' column (seconds), it should have been converted to 'timestamp' (milliseconds) in the query
        let timestamp = row.timestamp ?? 0;
        // Fallback: if timestamp is missing but ts exists (old database schema), convert from seconds to milliseconds
        if (!timestamp && row.ts !== undefined && row.ts !== null) {
          timestamp = Math.round(Number(row.ts) * 1000);
        }
        const gradeValue = tags.grade ?? tags.Grade ?? tags.GRADE;
        const raceNumberValue = tags.race_number ?? tags.Race_number;
        const legNumberValue = tags.leg_number ?? tags.Leg_number;
        const stateValue = tags.state ?? tags.State ?? tags.STATE;
        const tackValue = tags.tack ?? tags.Tack ?? tags.TACK;
        const twaDegValue = tags.twa_deg ?? tags.Twa_deg ?? tags.TWA_DEG;

        // Build result object with only defined values
        const result: any = {
          timestamp: timestamp,
          Datetime: new Date(timestamp).toISOString(),
          dataset_id: row.dataset_id,
          source_id: row.source_id,
          project_id: row.project_id,
          date: row.date,
          state: stateValue,
          config: tags.config ?? tags.Config ?? tags.CONFIG,
          event: tags.event ?? tags.Event ?? tags.EVENT ?? tags.event_name,
          source_name: tags.source_name ?? tags.Source_name ?? tags.SOURCE_NAME,
          ...Object.fromEntries(
            dataChannels.map(ch => [ch, row[ch]])
          )
        };

        // Expose State in both casings for filterCore and components
        if (stateValue !== undefined && stateValue !== null) {
          result.State = stateValue;
        }
        if (tackValue !== undefined && tackValue !== null) {
          result.tack = tackValue;
          result.Tack = tackValue;
        }

        // Only add metadata fields if they have values (avoid undefined fields)
        if (raceNumberValue !== undefined && raceNumberValue !== null) {
          result.race_number = raceNumberValue;
          result.Race_number = raceNumberValue;
        }
        if (legNumberValue !== undefined && legNumberValue !== null) {
          result.leg_number = legNumberValue;
          result.Leg_number = legNumberValue;
        }
        if (gradeValue !== undefined && gradeValue !== null) {
          result.grade = gradeValue;
          result.Grade = gradeValue;
          result.GRADE = gradeValue;
        }
        if (twaDegValue !== undefined && twaDegValue !== null) {
          result.twa_deg = twaDegValue;
          result.Twa_deg = twaDegValue;
        }

        return result;
      });
    } catch (error) {
      logError(`[HuniDBStore] Error querying data by channels:`, error);
      throw error;
    }
  }


  /**
   * Ensures all channel columns exist in the table (for aggregates/mapdata/clouddata).
   * Dynamically adds columns for any new channels found in the data.
   * Handles both numeric (REAL) and text (TEXT) columns based on data type.
   */
  /**
   * Query aggregates (using normalized row-column format with fast indexes)
   */
  /**
   * Query aggregates with filters
   * Returns empty array on mobile devices
   */
  async queryAggregates(
    _className: string,
    _filters: {
      datasetId?: string;
      projectId?: string;
      sourceId?: string;
      eventId?: number;
      raceNumber?: number;
      legNumber?: number;
      grade?: number;
      timeRange?: { start: number; end: number };
      agrType?: string; // Filter by aggregate agr type ('AVG', 'STD', 'AAV', etc.)
      state?: string; // Single state filter (e.g., 'H0')
      states?: string[]; // Array of states to filter (e.g., ['H0', 'H1'])
      event?: string; // Single event filter
      events?: string[]; // Array of events to filter
      config?: string; // Single config filter
      configs?: string[]; // Array of configs to filter
    },
    _requestedFilters?: FilterSet // Filters that user wants (for cache validation)
  ): Promise<AggregateEntry[]> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      return [];
    }
    // agg.aggregates table no longer used; data comes from API
    return [];
  }

  /**
   * Store event (normalized row-column format)
   */
  async storeEvent(
    className: string,
    event: EventEntry,
    metadata?: {
      datasetId?: string | number;
      projectId?: string | number;
      sourceId?: string | number;
    }
  ): Promise<void> {
    // Use batch insert by default
    await this.storeEvents(className, [event], metadata);
  }

  /**
   * Store multiple events (normalized row-column format)
   * @param className - Class name for the database
   * @param events - Array of events to store
   * @param metadata - Optional metadata from API request (dataset_id, project_id, source_id)
   */
  async storeEvents(
    className: string,
    events: EventEntry[],
    metadata?: {
      datasetId?: string | number;
      projectId?: string | number;
      sourceId?: string | number;
    }
  ): Promise<void> {
    // Always store events so agg.events is populated for selection and map overlays (see docs/optimization/HUNIDB_CACHING_AND_INDEXING.md).
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.events;
      
      // Batch insert all events in a single transaction
      if (events.length === 0) return;
      
      // Use metadata from API request context if provided, otherwise fall back to tags
      const defaultDatasetId = metadata?.datasetId ? String(metadata.datasetId) : null;
      const defaultProjectId = metadata?.projectId ? String(metadata.projectId) : null;
      const defaultSourceId = metadata?.sourceId ? String(metadata.sourceId) : null;
      
      await db.transaction(async (tx) => {
        const valueRows: string[] = [];
        const allParams: any[] = [];
        
        for (const event of events) {
          // Parse tags (could be JSON string or object)
          let tags: any = {};
          if (event.tags) {
            if (typeof event.tags === 'string') {
              try {
                tags = JSON.parse(event.tags);
              } catch {
                tags = {};
              }
            } else {
              tags = event.tags;
            }
          }
          
          // Prefer metadata from API request context, then tags, then default to '0'
          const datasetId = defaultDatasetId || tags.datasetId || tags.dataset_id || '0';
          const projectId = defaultProjectId || tags.projectId || tags.project_id || '0';
          const sourceId = defaultSourceId || tags.sourceId || tags.source_id || '0';
          
          // Convert ISO timestamps to integers (milliseconds) - ensure UTC
          // The API returns timestamps as TEXT from PostgreSQL, which may not have timezone info
          // We need to ensure they're parsed as UTC to avoid timezone conversion issues
          let startTime: number;
          let endTime: number;
          
          // Parse start_time - ensure UTC handling
          if (typeof event.start_time === 'string') {
            // If string doesn't end with 'Z' or timezone, assume it's UTC and append 'Z'
            const startTimeStr = event.start_time.trim();
            const normalizedStartTime = startTimeStr.endsWith('Z') || startTimeStr.includes('+') || startTimeStr.includes('-', 10)
              ? startTimeStr
              : startTimeStr + 'Z'; // Append 'Z' to indicate UTC
            startTime = Date.parse(normalizedStartTime);
          } else {
            // Already a number (milliseconds) - use directly
            startTime = typeof event.start_time === 'number' ? event.start_time : Date.parse(String(event.start_time));
          }
          
          // Parse end_time - ensure UTC handling
          if (typeof event.end_time === 'string') {
            const endTimeStr = event.end_time.trim();
            const normalizedEndTime = endTimeStr.endsWith('Z') || endTimeStr.includes('+') || endTimeStr.includes('-', 10)
              ? endTimeStr
              : endTimeStr + 'Z'; // Append 'Z' to indicate UTC
            endTime = Date.parse(normalizedEndTime);
          } else {
            endTime = typeof event.end_time === 'number' ? event.end_time : Date.parse(String(event.end_time));
          }
          
          // Validate that we got valid timestamps
          if (isNaN(startTime) || isNaN(endTime)) {
            warn(`[HuniDBStore] Invalid timestamp for event ${event.event_id}: start_time=${event.start_time}, end_time=${event.end_time}`);
            continue; // Skip this event
          }
          
          valueRows.push('(?, ?, ?, ?, ?, ?, ?, ?)');
          allParams.push(
            event.event_id,
            event.event_type,
            startTime,
            endTime,
            datasetId,
            projectId,
            sourceId,
            JSON.stringify(tags)
          );
        }
        
        // Execute batch INSERT
        await tx.exec(`
          INSERT OR REPLACE INTO ${escapeTableName(tableName)} (
            event_id, event_type, start_time, end_time,
            dataset_id, project_id, source_id, tags
          ) VALUES ${valueRows.join(', ')}
        `, allParams);
      });
      
      await this.safeFlush(db, 'storeEvents');
    } catch (error) {
      logError(`[HuniDBStore] Error storing events:`, error);
      throw error;
    }
  }

  /**
   * Get event by ID (using normalized row-column format)
   * Optionally filter by dataset_id and project_id to ensure correct event lookup
   */
  async getEvent(
    className: string,
    eventId: number,
    datasetId?: string | number,
    projectId?: string | number
  ): Promise<EventEntry | null> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.events;
      const conditions: string[] = ['event_id = ?'];
      const params: any[] = [eventId];
      
      // Filter by dataset_id and project_id if provided to ensure correct event lookup
      if (datasetId !== undefined && datasetId !== null) {
        conditions.push('dataset_id = ?');
        params.push(String(datasetId));
      }
      if (projectId !== undefined && projectId !== null) {
        conditions.push('project_id = ?');
        params.push(String(projectId));
      }
      
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const query = `
        SELECT 
          event_id, event_type, start_time, end_time,
          dataset_id, project_id, source_id, tags
        FROM ${escapeTableName(tableName)}
        ${whereClause}
      `;
      
      const results = await db.query<any>(query, params);
      
      if (results.length === 0) {
        // If no results with filters, try without dataset_id/project_id filters as fallback
        // This handles cases where events might be stored with different IDs or before timezone changes
        if (datasetId !== undefined || projectId !== undefined) {
          debug(`[HuniDBStore] Event ${eventId} not found with filters, trying without filters`, {
            eventId,
            datasetId,
            projectId,
            className
          });
          
          const fallbackResults = await db.query<any>(`
            SELECT 
              event_id, event_type, start_time, end_time,
              dataset_id, project_id, source_id, tags
            FROM ${escapeTableName(tableName)}
            WHERE event_id = ?
          `, [eventId]);
          
          if (fallbackResults.length > 0) {
            debug(`[HuniDBStore] Found event ${eventId} without filters`, {
              foundDatasetId: fallbackResults[0].dataset_id,
              foundProjectId: fallbackResults[0].project_id,
              requestedDatasetId: datasetId,
              requestedProjectId: projectId
            });
            const row = fallbackResults[0];
            const startTime = typeof row.start_time === 'number' 
              ? new Date(row.start_time).toISOString()
              : new Date(row.start_time).toISOString();
            const endTime = typeof row.end_time === 'number'
              ? new Date(row.end_time).toISOString()
              : new Date(row.end_time).toISOString();
            
            return {
              event_id: row.event_id,
              event_type: row.event_type,
              start_time: startTime,
              end_time: endTime,
              tags: JSON.parse(row.tags || '{}')
            };
          }
        }
        // Event not found - this is expected when events don't exist for a particular class/dataset/project
        // Log at debug level to avoid console spam while still providing debugging information
        debug(`[HuniDBStore] Event ${eventId} not found in ${className}`, {
          eventId,
          datasetId,
          projectId,
          className
        });
        return null;
      }
      
      const row = results[0];
      // Convert integer timestamps (UTC milliseconds) back to ISO strings (UTC)
      // row.start_time and row.end_time are integers (milliseconds since epoch in UTC)
      const startTime = typeof row.start_time === 'number' 
        ? new Date(row.start_time).toISOString()  // Integer is already UTC milliseconds
        : new Date(row.start_time).toISOString();  // Fallback for string (shouldn't happen)
      const endTime = typeof row.end_time === 'number'
        ? new Date(row.end_time).toISOString()
        : new Date(row.end_time).toISOString();
      
      return {
        event_id: row.event_id,
        event_type: row.event_type,
        start_time: startTime,
        end_time: endTime,
        tags: JSON.parse(row.tags || '{}'),
      } as EventEntry;
    } catch (error) {
      logError(`[HuniDBStore] Error getting event:`, error);
      return null;
    }
  }

  /**
   * Get all events
   */
  async getAllEvents(
    className: string
  ): Promise<EventEntry[]> {
    return await this.queryEvents(className);
  }

  /**
   * Get events by type
   */
  async getEventsByType(
    className: string,
    eventType: string
  ): Promise<EventEntry[]> {
    return await this.queryEvents(className, { eventType });
  }

  /**
   * Get events in time range (using normalized row-column format)
   */
  async getEventsInTimeRange(
    className: string,
    startTime: string,
    endTime: string
  ): Promise<EventEntry[]> {
    return await this.queryEvents(className, { 
      timeRange: { 
        start: startTime, 
        end: endTime 
      } 
    });
  }

  /**
   * Clear all events
   */
  async clearEvents(
    className: string
  ): Promise<void> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.events;
      await db.exec(`DELETE FROM ${escapeTableName(tableName)}`);
      await this.safeFlush(db, 'clearEvents');
    } catch (error) {
      logError(`[HuniDBStore] Error clearing events:`, error);
      throw error;
    }
  }

  /**
   * Get event time range
   * Optionally filter by dataset_id and project_id to ensure correct event lookup
   */
  async getEventTimeRange(
    className: string,
    eventId: number,
    datasetId?: string | number,
    projectId?: string | number
  ): Promise<{ starttime: string; endtime: string } | null> {
    const event = await this.getEvent(className, eventId, datasetId, projectId);
    if (!event) return null;
    return {
      starttime: event.start_time,
      endtime: event.end_time,
    };
  }

  /**
   * Get event time ranges for multiple events
   * Optionally filter by dataset_id and project_id to ensure correct event lookup
   */
  async getEventTimeRanges(
    className: string,
    eventIds: number[],
    datasetId?: string | number,
    projectId?: string | number
  ): Promise<Map<number, { starttime: string; endtime: string }>> {
    const result = new Map<number, { starttime: string; endtime: string }>();
    
    for (const eventId of eventIds) {
      const timeRange = await this.getEventTimeRange(className, eventId, datasetId, projectId);
      if (timeRange) {
        result.set(eventId, timeRange);
      }
    }
    
    return result;
  }

  /**
   * Query events (using normalized row-column format with fast indexes)
   */
  async queryEvents(
    className: string,
    filters?: {
      eventType?: string;
      timeRange?: { start: string; end: string };
      datasetId?: string;
      projectId?: string;
      sourceId?: string;
      tags?: any;
    }
  ): Promise<EventEntry[]> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.events;
      const conditions: string[] = [];
      const params: any[] = [];

      // Use direct column access instead of JSON extraction - much faster!
      if (filters?.eventType) {
        conditions.push(`event_type = ?`);
        params.push(filters.eventType);
      }
      
      if (filters?.datasetId) {
        conditions.push(`dataset_id = ?`);
        params.push(filters.datasetId);
      }
      
      if (filters?.projectId) {
        conditions.push(`project_id = ?`);
        params.push(filters.projectId);
      }
      
      if (filters?.sourceId) {
        conditions.push(`source_id = ?`);
        params.push(filters.sourceId);
      }

      if (filters?.timeRange) {
        // Convert ISO strings to timestamps for comparison
        const startTime = new Date(filters.timeRange.start).getTime();
        const endTime = new Date(filters.timeRange.end).getTime();
        // Use overlap check: event overlaps with range if start_time <= range_end AND end_time >= range_start
        // This returns all events that overlap with the time range, not just events completely contained within it
        conditions.push(`start_time <= ? AND end_time >= ?`);
        params.push(endTime, startTime);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `
        SELECT 
          event_id, event_type, start_time, end_time,
          dataset_id, project_id, source_id, tags
        FROM ${escapeTableName(tableName)} 
        ${whereClause}
        ORDER BY start_time DESC
      `;

      const results = await db.query<any>(sql, params);
      
      // Convert normalized rows back to EventEntry format
      // row.start_time and row.end_time are integers (milliseconds since epoch in UTC)
      return results.map(row => {
        const startTime = typeof row.start_time === 'number'
          ? new Date(row.start_time).toISOString()  // Integer is already UTC milliseconds
          : new Date(row.start_time).toISOString();  // Fallback for string
        const endTime = typeof row.end_time === 'number'
          ? new Date(row.end_time).toISOString()
          : new Date(row.end_time).toISOString();
        
        return {
          event_id: row.event_id,
          event_type: row.event_type,
          start_time: startTime,
          end_time: endTime,
          tags: JSON.parse(row.tags || '{}'),
        } as EventEntry;
      });
    } catch (error) {
      logError(`[HuniDBStore] Error querying events:`, error);
      throw error;
    }
  }

  /**
   * Build cache key for sidebar pages
   */
  private buildSidebarPagesKey(
    className: string,
    projectId: string | number,
    sidebarState: string
  ): string {
    const normalizedClass = className.toLowerCase();
    const normalizedProject = String(projectId);
    const normalizedState = sidebarState.toLowerCase();
    return `pages_${normalizedClass}_${normalizedProject}_${normalizedState}`;
  }

  /**
   * Store object
   * Skips caching if database is near size limit to avoid exceeding 200MB limit
   */
  async storeObject(
    className: string,
    objectName: string,
    data: any
  ): Promise<void> {
    // Always allow: objects, sources, channel names, settings (even when data cache is off)
    const db = await this.getDatabase(className);

    try {
      // Check database size before storing - skip caching if already near limit
      const MAX_DB_SIZE = 500 * 1024 * 1024; // 500MB in bytes (matches HuniDB engine limit)
      const SIZE_THRESHOLD = 475 * 1024 * 1024; // 475MB - skip caching if above this
      
      try {
        const storageInfo = await db.getStorageInfo();
        const currentSize = storageInfo.usage || 0;
        
        if (currentSize > SIZE_THRESHOLD) {
          // Estimate size of object being stored
          const objectSize = JSON.stringify(data).length;
          const estimatedNewSize = currentSize + objectSize;
          
          if (estimatedNewSize > MAX_DB_SIZE) {
            debug(`[HuniDBStore] Skipping cache for ${objectName} - database size ${(currentSize / 1024 / 1024).toFixed(1)}MB would exceed ${(MAX_DB_SIZE / 1024 / 1024).toFixed(0)}MB limit`);
            return; // Skip caching, but don't throw error
          }
        }
      } catch (sizeCheckError) {
        // If size check fails, proceed with store attempt anyway
        debug(`[HuniDBStore] Could not check database size, proceeding with store:`, sizeCheckError);
      }

      const tableName = TableNames.objects;
      
      // Use db.transaction() which automatically handles nested transactions with savepoints
      await db.transaction(async (tx) => {
        // Insert or replace using description as PRIMARY KEY
        await tx.exec(`
          INSERT OR REPLACE INTO ${escapeTableName(tableName)} (
            description, doc, ts
          ) VALUES (?, ?, ?)
        `, [
          objectName, // description (PRIMARY KEY)
          JSON.stringify(data), // doc
          Date.now() // ts
        ]);
      });
      
      // Defer flush to avoid blocking UI - non-critical operation
      this.safeFlush(db, 'storeObject', false).catch(() => {
        // Ignore flush errors for non-critical operations
      });
    } catch (error: any) {
      // If error is about database size limit, log and skip (non-critical)
      if (error?.message?.includes('exceeds maximum allowed') || 
          error?.message?.includes('Serialized database size')) {
        debug(`[HuniDBStore] Skipping cache for ${objectName} - database size limit exceeded (non-critical)`);
        return; // Don't throw - caching is optional
      }
      // Handle nested transaction errors gracefully (non-critical operation)
      const errorMessage = String(error?.message || '');
      if (errorMessage.includes('cannot start a transaction within a transaction') ||
          (errorMessage.includes('SQLITE_ERROR') && errorMessage.includes('result code 1'))) {
        debug(`[HuniDBStore] Skipping cache for ${objectName} - nested transaction detected (non-critical)`);
        return; // Don't throw - caching is optional
      }
      logError(`[HuniDBStore] Error storing object:`, error);
      throw error;
    }
  }

  /**
   * Get object
   */
  async getObject(
    className: string,
    objectName: string
  ): Promise<any | null> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.objects;
      // Query by description (which is the objectName)
      const result = await db.query<{ doc: string }>(`
        SELECT doc FROM ${escapeTableName(tableName)}
        WHERE description = ?
        ORDER BY ts DESC
        LIMIT 1
      `, [objectName]);
      
      if (result.length === 0) {
        return null;
      }
      
      return JSON.parse(result[0].doc);
    } catch (error) {
      logError(`[HuniDBStore] Error getting object:`, error);
      return null;
    }
  }

  /**
   * Delete object
   */
  async deleteObject(
    className: string,
    objectName: string
  ): Promise<void> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.objects;
      // Delete by description (which is the objectName)
      await db.exec(`
        DELETE FROM ${escapeTableName(tableName)}
        WHERE description = ?
      `, [objectName]);
      await this.safeFlush(db, 'deleteObject');
    } catch (error) {
      logError(`[HuniDBStore] Error deleting object:`, error);
      throw error;
    }
  }

  /**
   * List all objects
   */
  async listObjects(
    className: string
  ): Promise<string[]> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.objects;
      const results = await db.query<{ id: string }>(
        `SELECT id FROM ${escapeTableName(tableName)}`
      );
      return results.map(row => row.id);
    } catch (error) {
      logError(`[HuniDBStore] Error listing objects:`, error);
      return [];
    }
  }

  /**
   * Store cached sidebar pages (per class/project/sidebarState)
   */
  async storeSidebarPages(
    className: string,
    projectId: string | number,
    sidebarState: string,
    explorePages: any[],
    reportPages: any[]
  ): Promise<void> {
    // Always allow: UI/sidebar cache (even when data cache is off)
    const cacheEntry: SidebarPagesCacheEntry = {
      className,
      projectId: String(projectId),
      sidebarState,
      explorePages,
      reportPages,
      timestamp: Date.now(),
    };

    const key = this.buildSidebarPagesKey(className, projectId, sidebarState);
    await this.storeObject(className, key, cacheEntry);
  }

  /**
   * Get cached sidebar pages (per class/project/sidebarState)
   */
  async getSidebarPages(
    className: string,
    projectId: string | number,
    sidebarState: string
  ): Promise<SidebarPagesCacheEntry | null> {
    const key = this.buildSidebarPagesKey(className, projectId, sidebarState);
    const cached = await this.getObject(className, key);
    if (!cached) {
      return null;
    }
    return cached as SidebarPagesCacheEntry;
  }

  /**
   * Store multiple cloud data points in a single batch (much faster)
   */
  async storeCloudDataBatch(
    _className: string,
    cloudDataArray: CloudDataEntry[],
    _appliedFilters?: FilterSet,
    _queryFilters?: {
      projectId?: string;
      sourceId?: string;
      datasetId?: string;
      cloudType?: string; // 'Fleet Data', 'Recent History', 'Latest/1Hz'
    }
  ): Promise<void> {
    // cloud.data table no longer used
    if (cloudDataArray.length === 0) return;
    return;
  }

  /**
   * Store map data (mapdata) with dynamic channel columns
   * Similar to storeCloudData but for map track visualization
   * Uses batch insert for better performance
   * Uses map.data table (consolidated from map.tracks)
   */
  async storeMapData(
    _className: string,
    _datasetId: number,
    _projectId: number,
    _sourceId: number,
    data: Array<Record<string, any>>
  ): Promise<void> {
    // Map data no longer cached in HuniDB (API + in-memory only)
    if (data.length === 0) return;
    return;
  }

  /**
   * Query cloud data with filters.
   * Cloud data is no longer cached in HuniDB; always returns [] so callers fetch from API.
   */
  async queryCloudData(
    _className: string,
    _filters: {
      datasetId?: string;
      projectId?: string;
      sourceId?: string;
      eventId?: number;
      timeRange?: { start: number; end: number };
      cloudType?: string;
    },
    _requestedFilters?: FilterSet
  ): Promise<CloudDataEntry[]> {
    return [];
  }

  /**
   * Store a single map data entry (for geometry/event data)
   * Note: For bulk map track data, use the bulk storeMapData function
   */
  async storeMapDataEntry(
    _className: string,
    _mapData: MapDataEntry
  ): Promise<void> {
    // Map data no longer cached in HuniDB (API + in-memory only)
    return;
  }

  /**
   * Query map data with filters
   * Returns empty array on mobile devices
   */
  async queryMapData(
    _className: string,
    _filters: {
      datasetId?: string;
      projectId?: string;
      sourceId?: string;
      eventId?: number;
    }
  ): Promise<MapDataEntry[]> {
    // map.data table no longer used
    return [];
  }

  /**
   * Store density optimized chart data
   */
  async storeDensityOptimized(
    className: string,
    chart: DensityChartEntry,
    groups: DensityGroupEntry[]
  ): Promise<void> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.densityCharts;
      
      await db.exec(`
        INSERT OR REPLACE INTO ${escapeTableName(tableName)} (
          chart_object_id, dataset_id, project_id, source_id,
          color_type, chart_filters, global_filters,
          total_points, optimized_points, data_hash, last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        chart.chartObjectId,
        chart.datasetId,
        chart.projectId,
        chart.sourceId,
        chart.colorType,
        chart.chartFilters ? JSON.stringify(chart.chartFilters) : null,
        chart.globalFilters ? JSON.stringify(chart.globalFilters) : null,
        chart.totalPoints ?? null,
        chart.optimizedPoints ?? null,
        chart.dataHash ?? null,
        chart.lastAccessed ?? Date.now(),
      ]);
      
      // Store groups (batch insert)
      const groupsTableName = TableNames.densityGroups;
      if (groups.length > 0) {
        const valueRows: string[] = [];
        const allParams: any[] = [];
        
        for (const group of groups) {
          // 10 columns total in density.groups insert:
          // chart_object_id, dataset_id, project_id, source_id, color_type,
          // group_name, color, data, regression, table_values
          valueRows.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
          allParams.push(
            chart.chartObjectId,
            chart.datasetId,
            chart.projectId,
            chart.sourceId,
            chart.colorType,
            group.groupName,
            group.color ?? null,
            JSON.stringify(group.data),
            group.regression ? JSON.stringify(group.regression) : null,
            group.tableValues ? JSON.stringify(group.tableValues) : null
          );
        }
        
        // Execute batch INSERT
        await db.exec(`
          INSERT OR REPLACE INTO ${escapeTableName(groupsTableName)} (
            chart_object_id, dataset_id, project_id, source_id, color_type,
            group_name, color, data, regression, table_values
          ) VALUES ${valueRows.join(', ')}
        `, allParams);
      }
      
      await this.safeFlush(db, 'storeDensityOptimizedData');
    } catch (error) {
      logError(`[HuniDBStore] Error storing density optimized data:`, error);
      throw error;
    }
  }

  /**
   * Query density optimized chart data
   */
  async queryDensityOptimized(
    className: string,
    chartObjectId: string,
    datasetId: string,
    projectId: string,
    sourceId: string,
    colorType: string
  ): Promise<{ chart: DensityChartEntry | null; groups: DensityGroupEntry[] }> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.densityCharts;
      
      const chartResult = await db.query<any>(`
        SELECT 
          chart_object_id, dataset_id, project_id, source_id,
          color_type, chart_filters, global_filters,
          total_points, optimized_points, data_hash, last_accessed
        FROM ${escapeTableName(tableName)}
        WHERE chart_object_id = ? 
          AND dataset_id = ? 
          AND project_id = ?
          AND source_id = ?
          AND color_type = ?
        LIMIT 1
      `, [chartObjectId, datasetId, projectId, sourceId, colorType]);
      
      if (chartResult.length === 0) {
        return { chart: null, groups: [] };
      }
      
      const chartRow = chartResult[0];
      const chart: DensityChartEntry = {
        // We no longer persist a separate string id column; use a stable derived key
        id: `${chartRow.chart_object_id}_${chartRow.dataset_id}_${chartRow.project_id}_${chartRow.source_id}_${chartRow.color_type}`,
        chartObjectId: chartRow.chart_object_id,
        datasetId: chartRow.dataset_id,
        projectId: chartRow.project_id,
        sourceId: chartRow.source_id,
        colorType: chartRow.color_type,
        chartFilters: chartRow.chart_filters ? JSON.parse(chartRow.chart_filters) : undefined,
        globalFilters: chartRow.global_filters ? JSON.parse(chartRow.global_filters) : undefined,
        totalPoints: chartRow.total_points ?? undefined,
        optimizedPoints: chartRow.optimized_points ?? undefined,
        dataHash: chartRow.data_hash ?? undefined,
        lastAccessed: chartRow.last_accessed ?? undefined,
      };
      
      // Get groups
      const groupsTableName = TableNames.densityGroups;
      const groupsResult = await db.query<any>(`
        SELECT 
          chart_object_id, dataset_id, project_id, source_id, color_type,
          group_name, color, data, regression, table_values
        FROM ${escapeTableName(groupsTableName)}
        WHERE chart_object_id = ?
          AND dataset_id = ?
          AND project_id = ?
          AND source_id = ?
          AND color_type = ?
      `, [chart.chartObjectId, chart.datasetId, chart.projectId, chart.sourceId, chart.colorType]);
      
      const groups: DensityGroupEntry[] = groupsResult.map(row => ({
        id: `${row.chart_object_id}_${row.dataset_id}_${row.project_id}_${row.source_id}_${row.color_type}_${row.group_name}`,
        chartId: `${row.chart_object_id}_${row.dataset_id}_${row.project_id}_${row.source_id}_${row.color_type}`,
        groupName: row.group_name,
        color: row.color ?? undefined,
        data: JSON.parse(row.data),
        regression: row.regression ? JSON.parse(row.regression) : undefined,
        tableValues: row.table_values ? JSON.parse(row.table_values) : undefined,
      }));
      
      return { chart, groups };
    } catch (error) {
      logError(`[HuniDBStore] Error querying density optimized data:`, error);
      throw error;
    }
  }

  /**
   * Store target data
   */
  async storeTarget(
    className: string,
    target: TargetEntry
  ): Promise<void> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.targets;
      
      // Insert or replace using (description, project_id) as composite PRIMARY KEY
      await db.exec(`
        INSERT OR REPLACE INTO ${escapeTableName(tableName)} (
          description, project_id, name, is_polar, data, date_modified
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        target.name, // description (using name as description)
        target.projectId,
        target.name,
        target.isPolar ?? 0,
        JSON.stringify(target.data),
        target.dateModified ?? Date.now(),
      ]);
      
      await this.safeFlush(db, 'storeTarget');
    } catch (error) {
      logError(`[HuniDBStore] Error storing target:`, error);
      throw error;
    }
  }

  /**
   * Store multiple targets in a batch (single flush)
   * More efficient than calling storeTarget multiple times
   */
  async storeTargetsBatch(
    className: string,
    targets: TargetEntry[]
  ): Promise<void> {
    if (targets.length === 0) {
      return;
    }

    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.targets;
      
      // Build batch INSERT statement
      const valueRows: string[] = [];
      const allParams: any[] = [];
      
      for (const target of targets) {
        valueRows.push('(?, ?, ?, ?, ?, ?)');
        allParams.push(
          target.name, // description (using name as description)
          target.projectId,
          target.name,
          target.isPolar ?? 0,
          JSON.stringify(target.data),
          target.dateModified ?? Date.now(),
        );
      }
      
      // Insert or replace using (description, project_id) as composite PRIMARY KEY
      const sql = `
        INSERT OR REPLACE INTO ${escapeTableName(tableName)} (
          description, project_id, name, is_polar, data, date_modified
        ) VALUES ${valueRows.join(', ')}
      `;
      
      await db.exec(sql, allParams);
      
      // Only flush once after all targets are stored
      await this.safeFlush(db, 'storeTargetsBatch');
    } catch (error) {
      logError(`[HuniDBStore] Error storing targets batch:`, error);
      throw error;
    }
  }

  /**
   * Clear cached targets for a project (so next load gets fresh data from API).
   * Use when list may be stale (e.g. after uploads or to force refresh).
   *
   * @param isPolar - If 0 or 1, clear only that type; if undefined, clear all for project.
   */
  async clearTargetsForProject(
    className: string,
    projectId: string,
    isPolar?: number
  ): Promise<void> {
    const db = await this.getDatabase(className);
    try {
      const tableName = TableNames.targets;
      if (isPolar === undefined) {
        await db.exec(
          `DELETE FROM ${escapeTableName(tableName)} WHERE project_id = ?`,
          [projectId]
        );
        debug(`[HuniDBStore] Cleared all targets for project ${projectId}`);
      } else {
        await db.exec(
          `DELETE FROM ${escapeTableName(tableName)} WHERE project_id = ? AND is_polar = ?`,
          [projectId, isPolar]
        );
        debug(`[HuniDBStore] Cleared targets (isPolar=${isPolar}) for project ${projectId}`);
      }
      await this.safeFlush(db, 'clearTargetsForProject');
    } catch (error) {
      logError(`[HuniDBStore] Error clearing targets for project:`, error);
      throw error;
    }
  }

  /**
   * Query targets
   */
  async queryTargets(
    className: string,
    projectId: string,
    name?: string
  ): Promise<TargetEntry[]> {
    const db = await this.getDatabase(className);

    try {
      const tableName = TableNames.targets;
      const conditions: string[] = [`project_id = ?`];
      const params: any[] = [projectId];
      
      if (name) {
        // Query by description (which is the primary key and typically matches name)
        // Also check name field for backward compatibility
        conditions.push(`(description = ? OR name = ?)`);
        params.push(name, name);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const sql = `
        SELECT 
          description, project_id, name, is_polar, data, date_modified
        FROM ${escapeTableName(tableName)} 
        ${whereClause}
      `;

      const results = await db.query<any>(sql, params);
      
      return results.map(row => {
        let parsedData: any = {};
        try {
          if (row.data && typeof row.data === 'string' && row.data.trim() !== '') {
            parsedData = JSON.parse(row.data);
          } else if (row.data && typeof row.data === 'object') {
            parsedData = row.data;
          }
        } catch (parseError) {
          warn(`[HuniDBStore] Error parsing target data for ${row.name}:`, parseError);
          parsedData = {};
        }
        
        return {
          id: `${row.project_id}_${row.description}`, // Generate synthetic id for backward compatibility
          projectId: row.project_id,
          name: row.name,
          isPolar: row.is_polar ?? undefined,
          data: parsedData,
          dateModified: row.date_modified ?? undefined,
        } as TargetEntry;
      });
    } catch (error) {
      logError(`[HuniDBStore] Error querying targets:`, error);
      throw error;
    }
  }

  /**
   * Update mapdata with event IDs based on event time ranges
   */
  async updateMapdataWithEventIds(
    _className: string,
    _datasetId: string,
    _projectId: string,
    _sourceId: string,
    _selectedEvents: number[] | Array<{ event_id: number; event_type: string; start_time: string; end_time: string; tags: any }>
  ): Promise<void> {
    // map.data table no longer used
    return;
  }

  /**
   * Clear density optimized data
   */
  async clearDensityOptimizedData(
    className: string,
    keyPrefix?: string
  ): Promise<void> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      debug('[HuniDBStore] Skipping clearDensityOptimizedData on mobile device');
      return;
    }
    
    const db = await this.getDatabase(className);

    try {
      // Use new density.charts / density.groups tables instead of old agg.density_optimized
      const chartsTableName = TableNames.densityCharts;
      const groupsTableName = TableNames.densityGroups;

      if (keyPrefix) {
        // Key prefix format (from unifiedDataStore):
        //   densityOpt_${datasetId}_${projectId}_${sourceId}_
        // We don't store this cache key directly in the schema anymore,
        // so derive dataset/project/source and delete by those columns.
        let datasetId: string | undefined;
        let projectId: string | undefined;
        let sourceId: string | undefined;

        try {
          const withoutLabel = keyPrefix.replace(/^densityOpt_/, '');
          const parts = withoutLabel.split('_').filter(Boolean);
          if (parts.length >= 3) {
            [datasetId, projectId, sourceId] = parts;
          }
        } catch (parseError) {
          warn(
            `[HuniDBStore] Failed to parse density keyPrefix "${keyPrefix}" – falling back to full clear:`,
            parseError
          );
        }

        if (datasetId && projectId && sourceId) {
          // Delete all groups and charts for this dataset/project/source
          // Both tables now have dataset_id, project_id, source_id columns directly
          await db.exec(
            `DELETE FROM ${escapeTableName(groupsTableName)} 
             WHERE dataset_id = ? AND project_id = ? AND source_id = ?`,
            [String(datasetId), String(projectId), String(sourceId)]
          );
          await db.exec(
            `DELETE FROM ${escapeTableName(chartsTableName)} 
             WHERE dataset_id = ? AND project_id = ? AND source_id = ?`,
            [String(datasetId), String(projectId), String(sourceId)]
          );
        } else {
          // If we can't parse the prefix reliably, clear everything to avoid stale entries
          warn(
            `[HuniDBStore] Unable to derive dataset/project/source from keyPrefix "${keyPrefix}" – clearing all density data`
          );
          await db.exec(`DELETE FROM ${escapeTableName(groupsTableName)}`);
          await db.exec(`DELETE FROM ${escapeTableName(chartsTableName)}`);
        }
      } else {
        // Clear all density optimized data
        await db.exec(`DELETE FROM ${escapeTableName(groupsTableName)}`);
        await db.exec(`DELETE FROM ${escapeTableName(chartsTableName)}`);
      }
      await this.safeFlush(db, 'clearDensityOptimizedData');
    } catch (error) {
      logError(`[HuniDBStore] Error clearing density optimized data:`, error);
      throw error;
    }
  }

  /**
   * Get available channels for a source
   */
  async getAvailableChannels(
    _className: string,
    _datasetId: number,
    _projectId: number,
    _sourceId: number,
    _dataTypes: ('timeseries' | 'mapdata' | 'aggregates')[] = ['timeseries']
  ): Promise<string[]> {
    // Timeseries, mapdata, and aggregates are no longer cached in HuniDB; callers use API only.
    return [];
  }

  /**
   * Rebuild meta.channels table by scanning all ts.* tables
   * This is useful for repairing meta.channels if it gets out of sync or was not populated
   */
  async rebuildMetaChannels(_className: string, _datasetId: number, _projectId: number, _sourceId: number): Promise<void> {
    // meta.channels table no longer used
    return;
  }

  /**
   * Cache channel names with original case for picker UI
   * Channels are unique to the class, so no need for dataset/project/source IDs
   */
  async cacheChannelNames(
    className: string,
    date: string,
    dataSource: 'FILE' | 'INFLUX' | 'UNIFIED',
    channelNames: string[]
  ): Promise<void> {
    const db = await this.getDatabase(className);
    const now = Math.floor(Date.now() / 1000);
    
    try {
      // Insert all channel names (INSERT OR IGNORE to avoid duplicates)
      // Channels are unique to the class, so we don't need to store dataset/project/source IDs
      for (const channelName of channelNames) {
        await db.exec(`
          INSERT OR IGNORE INTO "meta.channel_names"
          (channel_name, date, data_source, discovered_at)
          VALUES (?, ?, ?, ?)
        `, [channelName, date, dataSource, now]);
      }
      
      debug(`[HuniDBStore] Cached ${channelNames.length} channel names for ${dataSource}`);
    } catch (error) {
      warn(`[HuniDBStore] Error caching channel names (non-critical):`, error);
    }
  }

  /**
   * Get cached channel names with original case for picker UI
   * Channels are unique to the class, so no need to filter by dataset/project/source IDs
   */
  async getCachedChannelNames(
    className: string,
    dataSource?: 'FILE' | 'INFLUX' | 'UNIFIED'
  ): Promise<string[]> {
    const db = await this.getDatabase(className);
    
    try {
      let sql = `
        SELECT DISTINCT channel_name 
        FROM "meta.channel_names"
      `;
      const params: any[] = [];
      
      if (dataSource) {
        sql += ` WHERE data_source = ?`;
        params.push(dataSource);
      }
      
      sql += ` ORDER BY channel_name`;
      
      const rows = await db.query<{ channel_name: string }>(sql, params);
      const channels = rows ? rows.map(r => r.channel_name) : [];
      
      debug(`[HuniDBStore] Retrieved ${channels.length} cached channel names from meta.channel_names`);
      return channels;
    } catch (error) {
      warn(`[HuniDBStore] Error retrieving cached channel names:`, error);
      return [];
    }
  }

  /**
   * Get which of the provided channel names have a specific data_source in meta.channel_names
   * This is useful for determining if channels should be queried from FILE or INFLUX
   * @param className - Class name
   * @param channelNames - Array of channel names to check
   * @param dataSource - Data source to filter by ('FILE', 'INFLUX', or 'UNIFIED')
   * @returns Array of channel names that have the specified data_source
   */
  async getChannelsByDataSource(
    className: string,
    channelNames: string[],
    dataSource: 'FILE' | 'INFLUX' | 'UNIFIED'
  ): Promise<string[]> {
    if (!channelNames || channelNames.length === 0) {
      return [];
    }

    const db = await this.getDatabase(className);
    
    try {
      // Create placeholders for IN clause
      const placeholders = channelNames.map(() => '?').join(',');
      const sql = `
        SELECT DISTINCT channel_name 
        FROM "meta.channel_names"
        WHERE data_source = ? AND channel_name IN (${placeholders})
      `;
      
      const params = [dataSource, ...channelNames];
      
      const rows = await db.query<{ channel_name: string }>(sql, params);
      const channels = rows ? rows.map(r => r.channel_name) : [];
      
      debug(`[HuniDBStore] Found ${channels.length} channels with data_source='${dataSource}' out of ${channelNames.length} checked`);
      return channels;
    } catch (error) {
      warn(`[HuniDBStore] Error retrieving channels by data source:`, error);
      return [];
    }
  }

  /**
   * Get channel names from meta.channel_names table that are fresh (< 48 hours).
   * This is used to skip expensive InfluxDB channel discovery calls when recent data is available in HuniDB.
   * 
   * @param className - Class name
   * @param dataSource - Data source to filter by ('FILE', 'INFLUX', or 'UNIFIED')
   * @param maxAgeSeconds - Maximum age in seconds (default: 48 hours)
   * @returns Array of fresh channel names
   */
  async getFreshChannelNames(
    className: string,
    dataSource: 'FILE' | 'INFLUX' | 'UNIFIED',
    maxAgeSeconds: number = 48 * 3600
  ): Promise<string[]> {
    const db = await this.getDatabase(className);
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - maxAgeSeconds;
    
    try {
      const sql = `
        SELECT DISTINCT channel_name 
        FROM "meta.channel_names"
        WHERE data_source = ? AND discovered_at > ?
        ORDER BY channel_name
      `;
      
      const params = [dataSource, cutoffTime];
      
      const rows = await db.query<{ channel_name: string }>(sql, params);
      const channels = rows ? rows.map(r => r.channel_name) : [];
      
      debug(`[HuniDBStore] Retrieved ${channels.length} fresh channel names for ${dataSource} (newer than ${maxAgeSeconds}s)`);
      return channels;
    } catch (error) {
      warn(`[HuniDBStore] Error retrieving fresh channel names:`, error);
      return [];
    }
  }

  /**
   * Store data by channels (compatibility method)
   * On mobile devices, only mapdata is allowed. Timeseries and aggregates are blocked.
   */
  async storeDataByChannels(
    _dataType: 'timeseries' | 'mapdata',
    _className: string,
    _datasetId: number,
    _projectId: number,
    _sourceId: number,
    _data: any[],
    _channelMetadata?: Array<{ name: string; type: string }>,
    _context?: string
  ): Promise<void> {
    // Data cache (timeseries/map) no longer stored in HuniDB (API + in-memory only)
    return;
  }

  /**
   * Get storage information
   */
  async getStorageInfo(): Promise<{
    channelCount: number;
    simpleObjectCount: number;
    totalSize: number;
  }> {
    let channelCount = 0;
    let simpleObjectCount = 0;
    let totalSize = 0;

    try {
      for (const [_dbName, db] of this.connections.entries()) {
        const info = await db.getStorageInfo();
        totalSize += info.usage || 0;

        // Count channels (count rows in single timeseries table)
        const tableName = TableNames.timeSeries('timeseries_default');
        const count = await db.queryValue<number>(
          `SELECT COUNT(*) FROM ${escapeTableName(tableName)} LIMIT 1`
        );
        if (count && count > 0) {
          channelCount += count;
        }

        // Count objects
        const objCount = await db.queryValue<number>(
          `SELECT COUNT(*) FROM ${escapeTableName(TableNames.objects)} LIMIT 1`
        );
        simpleObjectCount += objCount || 0;
      }
    } catch (error) {
      logError(`[HuniDBStore] Error getting storage info:`, error);
    }

    return {
      channelCount,
      simpleObjectCount,
      totalSize,
    };
  }

  /**
   * Clear all data (for testing/reset)
   */
  async clearAllData(): Promise<void> {
    try {
      // Close all connections
      await this.closeAll();
      
      // Clear cache initialization flag to ensure re-initialization
      try {
        const { persistantStore } = await import('./persistantStore');
        persistantStore.setIsCacheInitialized(false);
        debug(`[HuniDBStore] Cleared cache initialization flag after clearAllData`);
      } catch (err) {
        warn(`[HuniDBStore] Failed to clear cache initialization flag:`, err);
      }
      
      // Note: Actual data clearing would require dropping tables or databases
      // For now, we just close connections. Full clear would need to be done
      // at the database level or by dropping/recreating databases.
      warn(`[HuniDBStore] clearAllData called - connections closed. Full data clear requires database drop.`);
    } catch (error) {
      logError(`[HuniDBStore] Error clearing data:`, error);
      throw error;
    }
  }

  /**
   * Close all database connections
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.connections.values()).map(db => db.close());
    await Promise.all(closePromises);
    this.connections.clear();
    this.initPromises.clear();
  }

  /**
   * Get detailed storage information including quota
   */
  async getDetailedStorageInfo(className: string): Promise<{
    usage: number;
    quota: number;
    percentage: number;
    available: number;
    needsCleanup: boolean;
  }> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      return {
        usage: 0,
        quota: 0,
        percentage: 0,
        available: 0,
        needsCleanup: false
      };
    }
    
    try {
      const db = await this.getDatabase(className);
      const info = await db.getStorageInfo();
      
      const usage = info.usage || 0;
      const quota = info.quota || 0;
      const percentage = quota > 0 ? (usage / quota) * 100 : 0;
      const available = quota > 0 ? quota - usage : 0;
      const needsCleanup = percentage >= RETENTION_CONFIG.QUOTA_THRESHOLD_PERCENT;
      
      return {
        usage,
        quota,
        percentage,
        available,
        needsCleanup
      };
    } catch (error: any) {
      // If error is "HuniDB is disabled on mobile", that's expected
      if (error?.message?.includes('mobile devices')) {
        return {
          usage: 0,
          quota: 0,
          percentage: 0,
          available: 0,
          needsCleanup: false
        };
      }
      logError(`[HuniDBStore] Error getting detailed storage info for ${className}:`, error);
      return {
        usage: 0,
        quota: 0,
        percentage: 0,
        available: 0,
        needsCleanup: false
      };
    }
  }

  /**
   * Update aggregates metadata (state or grade) for specific event IDs
   * This is used when event tags are updated via the API
   */
  async updateAggregatesMetadata(
    _className: string,
    eventIds: number[],
    _updates: { state?: string; grade?: number }
  ): Promise<void> {
    // agg.aggregates table no longer used - this is a no-op for backward compatibility
    debug(`[HuniDBStore] updateAggregatesMetadata: agg.aggregates table no longer used, skipping update for ${eventIds.length} event(s)`);
    return;
  }

  /**
   * Clear all cached data for a specific dataset
   * This should be called when dataset data is updated on the server
   */
  async clearDatasetCache(className: string, datasetId: string): Promise<void> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      return;
    }
    
    try {
      const db = await this.getDatabase(className);
      
      // Delete all data for this dataset
      const deleteResults = await this.deleteDatasetData(db, datasetId, className);
      
      info(`[HuniDBStore] Cleared cache for dataset ${datasetId} in ${className}:`, deleteResults);
    } catch (error) {
      logError(`[HuniDBStore] Error clearing cache for dataset ${datasetId}:`, error);
      throw error;
    }
  }

  /**
   * Helper function to check if a table exists in the database
   */
  private async tableExists(db: Database, tableName: string): Promise<boolean> {
    try {
      const result = await db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name = ?`,
        [tableName]
      );
      return result.length > 0 && result[0].count > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Delete all data for a specific dataset_id from all tables
   */
  private async deleteDatasetData(db: Database, datasetId: string, _className: string): Promise<{
    events: number;
    timeSeries: number;
  }> {
    const results = {
      events: 0,
      timeSeries: 0
    };

    try {
      // Delete from events
      if (await this.tableExists(db, TableNames.events)) {
        try {
          const eventsResult = await db.exec(
            `DELETE FROM ${escapeTableName(TableNames.events)} WHERE dataset_id = ?`,
            [datasetId]
          );
          results.events = (eventsResult as unknown as { changes?: number })?.changes ?? 0;
        } catch (error) {
          debug(`[HuniDBStore] Error deleting events for dataset ${datasetId}:`, error);
        }
      }

      // Delete from all time-series tables
      try {
        const tsTables = await db.query<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ts.%'`
        );
        
        for (const { name: tableName } of tsTables) {
          try {
            const tsResult = await db.exec(
              `DELETE FROM ${escapeTableName(tableName)} WHERE dataset_id = ?`,
              [datasetId]
            );
            results.timeSeries += (tsResult as unknown as { changes?: number })?.changes ?? 0;
          } catch (error) {
            debug(`[HuniDBStore] Error deleting from ${tableName} for dataset ${datasetId}:`, error);
          }
        }
      } catch (error) {
        debug(`[HuniDBStore] No time-series tables to clean for dataset ${datasetId}`);
      }

      // Delete from meta.datasets
      if (await this.tableExists(db, 'meta.datasets')) {
        try {
          await db.exec(
            `DELETE FROM ${escapeTableName('meta.datasets')} WHERE dataset_id = ?`,
            [datasetId]
          );
        } catch (error) {
          debug(`[HuniDBStore] Error deleting meta.datasets entry for ${datasetId}:`, error);
        }
      }

      return results;
    } catch (error) {
      logError(`[HuniDBStore] Error deleting dataset data for ${datasetId}:`, error);
      return results;
    }
  }

  /**
   * Cleanup datasets by last_viewed_date (48-hour policy)
   */
  async cleanupDatasetsByLastViewed(retentionHours: number = RETENTION_CONFIG.RETENTION_HOURS): Promise<{
    cleaned: boolean;
    datasetsDeleted: number;
    totalRowsDeleted: number;
  }> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      return { cleaned: false, datasetsDeleted: 0, totalRowsDeleted: 0 };
    }

    const result = {
      cleaned: false,
      datasetsDeleted: 0,
      totalRowsDeleted: 0
    };

    try {
      const cutoffTimestamp = Date.now() - (retentionHours * 60 * 60 * 1000);
      const classNames = Array.from(this.connections.keys()).map(dbName => {
        return dbName.replace(/^Hunico_/, '');
      });

      for (const className of classNames) {
        try {
          const db = await this.getDatabase(className);
          
          // Find datasets to delete
          const datasetsToDelete = await db.query<{ dataset_id: string }>(
            `SELECT dataset_id FROM "meta.datasets" 
             WHERE last_viewed_date < ? OR last_viewed_date IS NULL`,
            [cutoffTimestamp]
          );

          if (datasetsToDelete.length === 0) {
            continue;
          }

          info(
            `[HuniDBStore] Found ${datasetsToDelete.length} datasets to clean up in ${className} (older than ${retentionHours} hours)`
          );

          // Delete data for each dataset
          for (const { dataset_id } of datasetsToDelete) {
            try {
              const deleteResults = await this.deleteDatasetData(db, dataset_id, className);
              const totalRows = deleteResults.events + deleteResults.timeSeries;
              
              result.totalRowsDeleted += totalRows;
              result.datasetsDeleted++;
              
              if (totalRows > 0) {
                debug(
                  `[HuniDBStore] Deleted dataset ${dataset_id}: ` +
                  `${deleteResults.events} events, ${deleteResults.timeSeries} time-series rows`
                );
              }
            } catch (error) {
              logError(`[HuniDBStore] Error deleting dataset ${dataset_id}:`, error);
            }
          }

          // Flush changes
          await this.safeFlush(db, 'cleanupDatasetsByLastViewed');
        } catch (error: any) {
          if (error?.message?.includes('mobile devices')) {
            continue; // Skip on mobile
          }
          logError(`[HuniDBStore] Error cleaning up ${className}:`, error);
        }
      }

      result.cleaned = result.datasetsDeleted > 0;
      
      if (result.cleaned) {
        info(
          `[HuniDBStore] Cleanup complete: deleted ${result.datasetsDeleted} datasets, ` +
          `${result.totalRowsDeleted} total rows`
        );
      }

      return result;
    } catch (error) {
      logError(`[HuniDBStore] Error in cleanupDatasetsByLastViewed:`, error);
      return result;
    }
  }

  /**
   * Quota-aware cleanup (within 48 hours)
   * Deletes oldest datasets first until quota is acceptable
   */
  async cleanupByQuotaAndLastViewed(): Promise<{
    cleaned: boolean;
    datasetsDeleted: number;
    totalRowsDeleted: number;
    beforePercentage: number;
    afterPercentage: number;
  }> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      return {
        cleaned: false,
        datasetsDeleted: 0,
        totalRowsDeleted: 0,
        beforePercentage: 0,
        afterPercentage: 0
      };
    }

    const result = {
      cleaned: false,
      datasetsDeleted: 0,
      totalRowsDeleted: 0,
      beforePercentage: 0,
      afterPercentage: 0
    };

    try {
      const classNames = Array.from(this.connections.keys()).map(dbName => {
        return dbName.replace(/^Hunico_/, '');
      });

      // Check storage for all classes
      let maxPercentage = 0;

      for (const className of classNames) {
        try {
          const storageInfo = await this.getDetailedStorageInfo(className);
          if (storageInfo.percentage > maxPercentage) {
            maxPercentage = storageInfo.percentage;
          }
        } catch (error: any) {
          if (!error?.message?.includes('mobile devices')) {
            logError(`[HuniDBStore] Error checking storage for ${className}:`, error);
          }
        }
      }

      result.beforePercentage = maxPercentage;

      // Only cleanup if above threshold
      if (maxPercentage < RETENTION_CONFIG.QUOTA_THRESHOLD_PERCENT) {
        debug(`[HuniDBStore] Storage usage ${maxPercentage.toFixed(1)}% below threshold, no quota cleanup needed`);
        return result;
      }

      info(
        `[HuniDBStore] Storage usage ${maxPercentage.toFixed(1)}% exceeds threshold, starting quota-aware cleanup`
      );

      const minSafeTimestamp = Date.now() - (RETENTION_CONFIG.MIN_SAFE_AGE_HOURS * 60 * 60 * 1000);

      // Clean up each class
      for (const className of classNames) {
        try {
          const db = await this.getDatabase(className);
          const storageInfo = await this.getDetailedStorageInfo(className);
          
          if (storageInfo.percentage < RETENTION_CONFIG.QUOTA_THRESHOLD_PERCENT) {
            continue; // This class is fine
          }

          // Get datasets ordered by last_viewed_date (oldest first)
          // But preserve datasets viewed in last 24 hours
          const datasetsToDelete = await db.query<{ dataset_id: string; last_viewed_date: number }>(
            `SELECT dataset_id, last_viewed_date 
             FROM "meta.datasets" 
             WHERE last_viewed_date < ? OR last_viewed_date IS NULL
             ORDER BY COALESCE(last_viewed_date, 0) ASC`,
            [minSafeTimestamp]
          );

          if (datasetsToDelete.length === 0) {
            continue;
          }

          info(
            `[HuniDBStore] Found ${datasetsToDelete.length} datasets eligible for quota cleanup in ${className}`
          );

          // Delete datasets one by one until quota is acceptable
          for (const { dataset_id } of datasetsToDelete) {
            // Check quota again
            const currentInfo = await this.getDetailedStorageInfo(className);
            if (currentInfo.percentage < RETENTION_CONFIG.TARGET_QUOTA_PERCENT) {
              debug(`[HuniDBStore] Quota target reached (${currentInfo.percentage.toFixed(1)}%), stopping cleanup`);
              break;
            }

            try {
              const deleteResults = await this.deleteDatasetData(db, dataset_id, className);
              const totalRows = deleteResults.events + deleteResults.timeSeries;
              
              result.totalRowsDeleted += totalRows;
              result.datasetsDeleted++;
              
              debug(
                `[HuniDBStore] Quota cleanup: deleted dataset ${dataset_id}, ` +
                `${totalRows} rows, quota now at ${currentInfo.percentage.toFixed(1)}%`
              );
            } catch (error) {
              logError(`[HuniDBStore] Error deleting dataset ${dataset_id} during quota cleanup:`, error);
            }
          }

          // Flush changes
          await this.safeFlush(db, 'cleanupByQuotaAndLastViewed');
        } catch (error: any) {
          if (error?.message?.includes('mobile devices')) {
            continue; // Skip on mobile
          }
          logError(`[HuniDBStore] Error in quota cleanup for ${className}:`, error);
        }
      }

      // Get final storage info
      let finalMaxPercentage = 0;
      for (const className of classNames) {
        try {
          const storageInfo = await this.getDetailedStorageInfo(className);
          if (storageInfo.percentage > finalMaxPercentage) {
            finalMaxPercentage = storageInfo.percentage;
          }
        } catch (error: any) {
          if (!error?.message?.includes('mobile devices')) {
            // Ignore mobile errors
          }
        }
      }

      result.afterPercentage = finalMaxPercentage;
      result.cleaned = result.datasetsDeleted > 0;

      if (result.cleaned) {
        info(
          `[HuniDBStore] Quota cleanup complete: deleted ${result.datasetsDeleted} datasets, ` +
          `${result.totalRowsDeleted} rows, ` +
          `quota ${result.beforePercentage.toFixed(1)}% → ${result.afterPercentage.toFixed(1)}%`
        );
      }

      return result;
    } catch (error) {
      logError(`[HuniDBStore] Error in cleanupByQuotaAndLastViewed:`, error);
      return result;
    }
  }

  /**
   * Start automatic dataset retention cleanup
   */
  startDatasetRetentionCleanup(intervalMs: number = RETENTION_CONFIG.CLEANUP_INTERVAL_MS): void {
    // Skip on mobile devices
    if (isMobileDevice()) {
      info('[HuniDBStore] Skipping retention cleanup on mobile device');
      return;
    }

    if (this.retentionCleanupIntervalId !== null) {
      warn('[HuniDBStore] Retention cleanup already running');
      return;
    }

    // Run cleanup immediately
    this.runRetentionCleanup().catch(err => {
      logError('[HuniDBStore] Error in initial retention cleanup:', err);
    });

    // Then schedule periodic cleanup
    this.retentionCleanupIntervalId = setInterval(() => {
      this.runRetentionCleanup().catch(err => {
        logError('[HuniDBStore] Error in scheduled retention cleanup:', err);
      });
    }, intervalMs);

    info(`[HuniDBStore] Started dataset retention cleanup (every ${intervalMs / 1000 / 60} minutes)`);
  }

  /**
   * Stop automatic dataset retention cleanup
   */
  stopDatasetRetentionCleanup(): void {
    if (this.retentionCleanupIntervalId !== null) {
      clearInterval(this.retentionCleanupIntervalId);
      this.retentionCleanupIntervalId = null;
      info('[HuniDBStore] Stopped dataset retention cleanup');
    }
  }

  /**
   * Run retention cleanup (48-hour policy + quota check)
   */
  private async runRetentionCleanup(): Promise<void> {
    // Skip on mobile devices
    if (isMobileDevice()) {
      return;
    }

    try {
      // First: cleanup datasets older than 48 hours
      const retentionResult = await this.cleanupDatasetsByLastViewed(RETENTION_CONFIG.RETENTION_HOURS);
      
      if (retentionResult.cleaned) {
        info(
          `[HuniDBStore] Retention cleanup: deleted ${retentionResult.datasetsDeleted} datasets, ` +
          `${retentionResult.totalRowsDeleted} rows`
        );
      }

      // Then: check quota and cleanup if needed
      const quotaResult = await this.cleanupByQuotaAndLastViewed();
      
      if (quotaResult.cleaned) {
        info(
          `[HuniDBStore] Quota cleanup: deleted ${quotaResult.datasetsDeleted} datasets, ` +
          `quota ${quotaResult.beforePercentage.toFixed(1)}% → ${quotaResult.afterPercentage.toFixed(1)}%`
        );
      }
    } catch (error) {
      logError('[HuniDBStore] Error in retention cleanup:', error);
    }
  }
}

// Export singleton instance
export const huniDBStore = new HuniDBStore();




