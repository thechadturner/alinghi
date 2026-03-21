import { defaultLogger } from '../utils/logger.js';

/**
 * Prepared statement interface
 */
export interface PreparedStatement {
  sql: string;
  bind(values: unknown[]): void;
  step(): boolean;
  get(index?: number): unknown;
  getColumnNames(): string[];
  finalize(): void;
  reset(): void;
}

/**
 * Cache entry for prepared statements
 */
interface CacheEntry {
  statement: PreparedStatement;
  lastUsed: number;
  useCount: number;
}

/**
 * LRU Cache for prepared statements
 */
export class PreparedStatementCache {
  private cache: Map<string, CacheEntry>;
  private maxSize: number;

  constructor(maxSize = 200) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Get a prepared statement from cache or prepare a new one
   */
  get(sql: string, prepare: (sql: string) => PreparedStatement): PreparedStatement {
    const entry = this.cache.get(sql);

    if (entry) {
      // Cache hit
      entry.lastUsed = Date.now();
      entry.useCount++;
      defaultLogger.logCacheHit();
      defaultLogger.debug(`Prepared statement cache hit for SQL: ${sql.substring(0, 50)}...`);
      
      // Reset the statement for reuse
      try {
        entry.statement.reset();
      } catch (error) {
        // If reset fails, remove from cache and prepare new one
        this.cache.delete(sql);
        defaultLogger.debug('Statement reset failed, preparing new one');
        return this.prepareAndCache(sql, prepare);
      }
      
      return entry.statement;
    }

    // Cache miss
    defaultLogger.logCacheMiss();
    return this.prepareAndCache(sql, prepare);
  }

  /**
   * Prepare a statement and add it to cache
   */
  private prepareAndCache(sql: string, prepare: (sql: string) => PreparedStatement): PreparedStatement {
    // Evict least recently used if cache is full
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    const statement = prepare(sql);
    
    this.cache.set(sql, {
      statement,
      lastUsed: Date.now(),
      useCount: 1,
    });

    defaultLogger.debug(`Prepared and cached statement: ${sql.substring(0, 50)}...`);

    return statement;
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      if (entry) {
        try {
          entry.statement.finalize();
        } catch (error) {
          defaultLogger.debug('Error finalizing evicted statement', error);
        }
      }
      this.cache.delete(oldestKey);
      defaultLogger.debug(`Evicted LRU statement: ${oldestKey.substring(0, 50)}...`);
    }
  }

  /**
   * Remove a specific statement from cache
   */
  remove(sql: string): void {
    const entry = this.cache.get(sql);
    if (entry) {
      try {
        entry.statement.finalize();
      } catch (error) {
        defaultLogger.debug('Error finalizing removed statement', error);
      }
      this.cache.delete(sql);
    }
  }

  /**
   * Clear all cached statements
   */
  clear(): void {
    for (const entry of this.cache.values()) {
      try {
        entry.statement.finalize();
      } catch (error) {
        defaultLogger.debug('Error finalizing statement during clear', error);
      }
    }
    this.cache.clear();
    defaultLogger.info('Prepared statement cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
    statements: Array<{ sql: string; useCount: number; lastUsed: number }>;
  } {
    const statements = Array.from(this.cache.entries()).map(([sql, entry]) => ({
      sql: sql.length > 100 ? sql.substring(0, 100) + '...' : sql,
      useCount: entry.useCount,
      lastUsed: entry.lastUsed,
    }));

    const metrics = defaultLogger.getMetrics();

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: metrics.cacheHitRate,
      statements,
    };
  }

  /**
   * Get current cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Check if cache contains a statement
   */
  has(sql: string): boolean {
    return this.cache.has(sql);
  }

  /**
   * Set maximum cache size
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    
    // Evict entries if necessary
    while (this.cache.size > this.maxSize) {
      this.evictLRU();
    }
  }

  /**
   * Get maximum cache size
   */
  getMaxSize(): number {
    return this.maxSize;
  }
}

/**
 * Create a new prepared statement cache
 */
export function createPreparedStatementCache(maxSize?: number): PreparedStatementCache {
  return new PreparedStatementCache(maxSize);
}

