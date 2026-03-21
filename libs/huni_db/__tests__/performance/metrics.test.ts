/**
 * Performance Tests - Metrics Collector
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../../src/performance/metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it('should record query times', () => {
    collector.recordQuery(10);
    collector.recordQuery(20);
    collector.recordQuery(30);

    const metrics = collector.getMetrics();
    expect(metrics.queries.count).toBe(3);
    expect(metrics.queries.avgLatency).toBe(20);
  });

  it('should calculate percentiles', () => {
    // Record 100 queries with times 1-100
    for (let i = 1; i <= 100; i++) {
      collector.recordQuery(i);
    }

    const metrics = collector.getMetrics();
    expect(metrics.queries.p50).toBeCloseTo(50, 0);
    expect(metrics.queries.p95).toBeCloseTo(95, 0);
    expect(metrics.queries.p99).toBeCloseTo(99, 0);
  });

  it('should track cache statistics', () => {
    collector.recordCacheHit();
    collector.recordCacheHit();
    collector.recordCacheMiss();

    const metrics = collector.getMetrics();
    expect(metrics.cache.hits).toBe(2);
    expect(metrics.cache.misses).toBe(1);
    expect(metrics.cache.hitRate).toBeCloseTo(66.67, 1);
  });

  it('should track batch operations', () => {
    collector.recordBatch(10);
    collector.recordBatch(20);
    collector.recordBatch(30);

    const metrics = collector.getMetrics();
    expect(metrics.writes.totalBatches).toBe(3);
    expect(metrics.writes.avgBatchSize).toBe(20);
  });

  it('should reset metrics', () => {
    collector.recordQuery(10);
    collector.recordCacheHit();
    collector.recordBatch(5);

    collector.reset();

    const metrics = collector.getMetrics();
    expect(metrics.queries.count).toBe(0);
    expect(metrics.cache.hits).toBe(0);
    expect(metrics.writes.totalBatches).toBe(0);
  });
});

