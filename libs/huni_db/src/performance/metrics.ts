/**
 * Performance Metrics
 * 
 * Comprehensive performance tracking and observability
 */

import type { PerformanceMetrics } from './types.js';

/**
 * Performance Metrics Collector
 */
export class MetricsCollector {
  private queryTimes: number[] = [];
  private writeBatches: number[] = [];
  private indexRebuildTimes: number[] = [];
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;
  private writeCount = 0;
  private writeStartTime = Date.now();
  private indexRebuildCount = 0;

  /**
   * Record a query execution time
   */
  recordQuery(latency: number): void {
    this.queryTimes.push(latency);
    
    // Keep only last 1000 query times for percentile calculation
    if (this.queryTimes.length > 1000) {
      this.queryTimes.shift();
    }
  }

  /**
   * Record a batch write
   */
  recordBatch(size: number): void {
    this.writeBatches.push(size);
    this.writeCount += size;
    
    // Keep only last 100 batches
    if (this.writeBatches.length > 100) {
      this.writeBatches.shift();
    }
  }

  /**
   * Record cache hit
   */
  recordCacheHit(): void {
    this.cacheHits++;
  }

  /**
   * Record cache miss
   */
  recordCacheMiss(): void {
    this.cacheMisses++;
  }

  /**
   * Record cache eviction
   */
  recordCacheEviction(): void {
    this.cacheEvictions++;
  }

  /**
   * Record index rebuild
   */
  recordIndexRebuild(duration: number): void {
    this.indexRebuildCount++;
    this.indexRebuildTimes.push(duration);
    
    // Keep only last 50 rebuild times
    if (this.indexRebuildTimes.length > 50) {
      this.indexRebuildTimes.shift();
    }
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    const safeIndex = Math.max(0, Math.min(index, sorted.length - 1));
    return sorted[safeIndex] ?? 0;
  }

  /**
   * Get comprehensive performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const sortedQueryTimes = [...this.queryTimes].sort((a, b) => a - b);
    const totalQueries = this.queryTimes.length;
    const avgQueryTime = totalQueries > 0
      ? this.queryTimes.reduce((a, b) => a + b, 0) / totalQueries
      : 0;

    const totalCacheOps = this.cacheHits + this.cacheMisses;
    const cacheHitRate = totalCacheOps > 0
      ? (this.cacheHits / totalCacheOps) * 100
      : 0;

    const elapsedSeconds = (Date.now() - this.writeStartTime) / 1000;
    const writeThroughput = elapsedSeconds > 0
      ? this.writeCount / elapsedSeconds
      : 0;

    const avgBatchSize = this.writeBatches.length > 0
      ? this.writeBatches.reduce((a, b) => a + b, 0) / this.writeBatches.length
      : 0;

    const avgRebuildTime = this.indexRebuildTimes.length > 0
      ? this.indexRebuildTimes.reduce((a, b) => a + b, 0) / this.indexRebuildTimes.length
      : 0;

    return {
      queries: {
        count: totalQueries,
        avgLatency: avgQueryTime,
        p50: this.percentile(sortedQueryTimes, 50),
        p95: this.percentile(sortedQueryTimes, 95),
        p99: this.percentile(sortedQueryTimes, 99),
        min: sortedQueryTimes.length > 0 ? (sortedQueryTimes[0] ?? 0) : 0,
        max: sortedQueryTimes.length > 0 ? (sortedQueryTimes[sortedQueryTimes.length - 1] ?? 0) : 0,
      },
      writes: {
        count: this.writeCount,
        throughput: writeThroughput,
        avgBatchSize,
        totalBatches: this.writeBatches.length,
      },
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: cacheHitRate,
        size: 0, // Will be set by cache
        maxSize: 0, // Will be set by cache
        evictions: this.cacheEvictions,
      },
      indexes: {
        rebuildCount: this.indexRebuildCount,
        avgRebuildTime,
      },
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.queryTimes = [];
    this.writeBatches = [];
    this.indexRebuildTimes = [];
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheEvictions = 0;
    this.writeCount = 0;
    this.writeStartTime = Date.now();
    this.indexRebuildCount = 0;
  }
}

/**
 * Global metrics collector instance
 */
export const metricsCollector = new MetricsCollector();

