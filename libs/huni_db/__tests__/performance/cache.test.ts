/**
 * Performance Tests - Hot Cache
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HotCache } from '../../src/performance/cache.js';

describe('HotCache', () => {
  let cache: HotCache;

  beforeEach(() => {
    cache = new HotCache({ maxSize: 10 });
  });

  it('should store and retrieve values', async () => {
    await cache.set('key1', 'value1');
    const value = await cache.get<string>('key1');
    expect(value).toBe('value1');
  });

  it('should return null for missing keys', async () => {
    const value = await cache.get('missing');
    expect(value).toBeNull();
  });

  it('should evict LRU entries when full', async () => {
    // Fill cache to capacity
    for (let i = 0; i < 10; i++) {
      await cache.set(`key${i}`, `value${i}`);
    }

    // Add one more - should evict least recently used
    await cache.set('key10', 'value10');

    const stats = cache.getStats();
    expect(stats.size).toBe(10);
    expect(stats.evictions).toBeGreaterThan(0);
  });

  it('should track hit/miss statistics', async () => {
    await cache.set('key1', 'value1');
    
    await cache.get('key1'); // Hit
    await cache.get('missing'); // Miss
    await cache.get('key1'); // Hit

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(66.67, 1);
  });

  it('should invalidate entries', async () => {
    await cache.set('key1', 'value1');
    cache.invalidate('key1');
    
    const value = await cache.get('key1');
    expect(value).toBeNull();
  });

  it('should clear all entries', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');
    
    await cache.clear();
    
    const stats = cache.getStats();
    expect(stats.size).toBe(0);
  });
});

