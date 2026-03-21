/**
 * Hot KV Cache
 * 
 * In-memory LRU cache for frequent reads
 */

import type { CacheOptions, CacheStats } from './types.js';
import { metricsCollector } from './metrics.js';
import { defaultLogger } from '../utils/logger.js';
import { IndexedDBShadow } from './shadow.js';

/**
 * Cache entry
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

/**
 * Default cache options
 */
const DEFAULT_CACHE_OPTIONS: Required<Omit<CacheOptions, 'ttl'>> & { ttl?: number } = {
  maxSize: 1000,
  persistent: false,
};

/**
 * Hot KV Cache with LRU eviction
 */
export class HotCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private options: Required<Omit<CacheOptions, 'ttl'>> & { ttl?: number };
  private shadow: IndexedDBShadow | null = null;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(options?: CacheOptions) {
    this.options = { ...DEFAULT_CACHE_OPTIONS, ...options };
    
    // Initialize IndexedDB shadow if persistent option is enabled
    if (this.options.persistent) {
      this.shadow = new IndexedDBShadow();
      this.shadow.initialize().catch(err => {
        defaultLogger.warn('Failed to initialize IndexedDB shadow cache', err);
        this.shadow = null;
      });
    }
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    // Check in-memory cache first
    const entry = this.cache.get(key);

    if (entry) {
      // Check TTL
      if (this.options.ttl && Date.now() - entry.timestamp > this.options.ttl) {
        this.cache.delete(key);
        // Also remove from shadow
        if (this.shadow) {
          this.shadow.delete(key).catch(() => {});
        }
        this.stats.misses++;
        metricsCollector.recordCacheMiss();
        defaultLogger.debug(`Cache MISS (expired): ${key}`);
        return null;
      }

      // Update access info (LRU)
      entry.lastAccess = Date.now();
      entry.accessCount++;

      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);

      this.stats.hits++;
      metricsCollector.recordCacheHit();
      defaultLogger.debug(`Cache HIT: ${key} (cache size: ${this.cache.size}, hits: ${this.stats.hits}, misses: ${this.stats.misses})`);
      return entry.value as T;
    }

    // If not in memory and shadow cache is enabled, try IndexedDB
    if (this.shadow) {
      try {
        const shadowEntry = await this.shadow.get<CacheEntry<T>>(key);
        if (shadowEntry) {
          // Check TTL for shadow entry
          if (this.options.ttl && Date.now() - shadowEntry.timestamp > this.options.ttl) {
            await this.shadow.delete(key).catch(() => {});
            this.stats.misses++;
            metricsCollector.recordCacheMiss();
            defaultLogger.debug(`Cache MISS (shadow expired): ${key}`);
            return null;
          }

          // Restore to memory cache
          this.cache.set(key, shadowEntry);
          this.stats.hits++;
          metricsCollector.recordCacheHit();
          defaultLogger.debug(`Cache HIT (from shadow): ${key}`);
          return shadowEntry.value;
        }
      } catch (err) {
        defaultLogger.debug('Failed to get from shadow cache', err);
      }
    }

    this.stats.misses++;
    metricsCollector.recordCacheMiss();
    defaultLogger.debug(`Cache MISS: ${key} (cache size: ${this.cache.size})`);
    return null;
  }

  /**
   * Set value in cache
   */
  set<T>(key: string, value: T): void {
    // Remove if exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict if at capacity
    if (this.cache.size >= this.options.maxSize) {
      this.evictLRU();
    }

    // Add new entry
    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccess: Date.now(),
    };

    this.cache.set(key, entry);
    defaultLogger.debug(`Cache SET: ${key} (cache size: ${this.cache.size}/${this.options.maxSize})`);
    
    // Also store in shadow cache if enabled
    if (this.shadow) {
      this.shadow.set(key, entry).catch(err => {
        defaultLogger.debug('Failed to set in shadow cache', err);
      });
    }
  }

  /**
   * Invalidate a cache entry
   */
  invalidate(key: string): void {
    this.cache.delete(key);
    
    // Also remove from shadow cache
    if (this.shadow) {
      this.shadow.delete(key).catch(err => {
        defaultLogger.debug('Failed to delete from shadow cache', err);
      });
    }
  }

  /**
   * Invalidate entries matching a pattern
   */
  invalidatePattern(pattern: string | RegExp): void {
    const regex = typeof pattern === 'string' 
      ? new RegExp(pattern.replace(/\*/g, '.*'))
      : pattern;

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    this.cache.clear();
    
    // Also clear shadow cache
    if (this.shadow) {
      await this.shadow.clear().catch(err => {
        defaultLogger.debug('Failed to clear shadow cache', err);
      });
    }
    
    // Don't reset stats on clear - stats should persist
    defaultLogger.debug(`Cache cleared (size was: ${this.cache.size}, stats preserved)`);
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    if (this.cache.size === 0) {
      return;
    }

    // Find least recently used
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccess < lruTime) {
        lruTime = entry.lastAccess;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
      this.stats.evictions++;
      metricsCollector.recordCacheEviction();
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;

    return {
      size: this.cache.size,
      maxSize: this.options.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate,
      evictions: this.stats.evictions,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
    };
  }

  /**
   * Get cache size
   */
  getSize(): number {
    return this.cache.size;
  }

  /**
   * Check if key exists
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }
}

