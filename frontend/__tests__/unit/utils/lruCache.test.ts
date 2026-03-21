/**
 * LRU Cache Unit Tests
 * 
 * Tests for the LRU (Least Recently Used) cache implementation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LRUCache } from '../../../utils/lruCache';

describe('LRUCache', () => {
  describe('Basic Operations', () => {
    it('should create an empty cache', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.size).toBe(0);
      expect(cache.max).toBe(100);
    });

    it('should create cache with custom max size', () => {
      const cache = new LRUCache<string, number>(50);
      expect(cache.max).toBe(50);
    });

    it('should throw error for invalid max size', () => {
      expect(() => new LRUCache<string, number>(0)).toThrow();
      expect(() => new LRUCache<string, number>(-1)).toThrow();
    });

    it('should set and get values', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key1', 100);
      expect(cache.get('key1')).toBe(100);
      expect(cache.size).toBe(1);
    });

    it('should return undefined for non-existent keys', () => {
      const cache = new LRUCache<string, number>();
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should update existing values', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key1', 100);
      cache.set('key1', 200);
      expect(cache.get('key1')).toBe(200);
      expect(cache.size).toBe(1);
    });

    it('should check if key exists', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key1', 100);
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(false);
    });

    it('should delete keys', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key1', 100);
      expect(cache.delete('key1')).toBe(true);
      expect(cache.has('key1')).toBe(false);
      expect(cache.size).toBe(0);
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should clear all entries', () => {
      const cache = new LRUCache<string, number>();
      cache.set('key1', 100);
      cache.set('key2', 200);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used when max size reached', () => {
      const cache = new LRUCache<string, number>(3);
      
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);
      expect(cache.size).toBe(3);
      
      // Add 4th item - should evict key1 (least recently used)
      cache.set('key4', 4);
      expect(cache.size).toBe(3);
      expect(cache.get('key1')).toBeUndefined(); // Evicted
      expect(cache.get('key4')).toBe(4); // New item
    });

    it('should move accessed items to end (most recently used)', () => {
      const cache = new LRUCache<string, number>(3);
      
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);
      
      // Access key1 - should move to end
      cache.get('key1');
      
      // Add key4 - should evict key2 (not key1, which was just accessed)
      cache.set('key4', 4);
      expect(cache.get('key1')).toBe(1); // Still exists
      expect(cache.get('key2')).toBeUndefined(); // Evicted
      expect(cache.get('key3')).toBe(3);
      expect(cache.get('key4')).toBe(4);
    });

    it('should update existing key and move to end', () => {
      const cache = new LRUCache<string, number>(3);
      
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);
      
      // Update key1 - should move to end
      cache.set('key1', 10);
      
      // Add key4 - should evict key2 (not key1)
      cache.set('key4', 4);
      expect(cache.get('key1')).toBe(10);
      expect(cache.get('key2')).toBeUndefined();
    });
  });

  describe('Iteration Methods', () => {
    it('should return all keys in order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);
      
      const keys = cache.keys();
      expect(keys).toEqual(['key1', 'key2', 'key3']);
    });

    it('should return all values in order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);
      
      const values = cache.values();
      expect(values).toEqual([1, 2, 3]);
    });

    it('should return all entries in order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('key1', 1);
      cache.set('key2', 2);
      
      const entries = cache.entries();
      expect(entries).toEqual([['key1', 1], ['key2', 2]]);
    });

    it('should iterate with forEach', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('key1', 1);
      cache.set('key2', 2);
      
      const results: Array<[string, number]> = [];
      cache.forEach((value, key) => {
        results.push([key, value]);
      });
      
      expect(results).toEqual([['key1', 1], ['key2', 2]]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle max size of 1', () => {
      const cache = new LRUCache<string, number>(1);
      cache.set('key1', 1);
      cache.set('key2', 2);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe(2);
    });

    it('should handle complex objects as values', () => {
      const cache = new LRUCache<string, { data: number[] }>();
      const obj = { data: [1, 2, 3] };
      cache.set('key1', obj);
      const retrieved = cache.get('key1');
      expect(retrieved).toEqual(obj);
      expect(retrieved?.data).toEqual([1, 2, 3]);
    });

    it('should handle undefined values', () => {
      const cache = new LRUCache<string, number | undefined>();
      cache.set('key1', undefined);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.has('key1')).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should handle many operations efficiently', () => {
      const cache = new LRUCache<number, number>(100);
      const start = performance.now();
      
      // Add 1000 items (should evict oldest)
      for (let i = 0; i < 1000; i++) {
        cache.set(i, i * 2);
      }
      
      // Access items
      for (let i = 900; i < 1000; i++) {
        cache.get(i);
      }
      
      const end = performance.now();
      expect(end - start).toBeLessThan(100); // Should be fast
      expect(cache.size).toBe(100);
    });
  });
});

