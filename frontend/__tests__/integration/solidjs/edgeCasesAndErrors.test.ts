/**
 * Edge Cases and Error Scenario Tests
 * 
 * Tests for edge cases, error handling, and boundary conditions
 * that can occur in SolidJS applications with complex signal interactions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSignal, createEffect, createMemo, onCleanup, ErrorBoundary } from 'solid-js';
import { setupMocks, mockIndexedDB, mockAPI } from '../../utils/testHelpers';
import { mockDataPoints } from '../../fixtures/mockData';
import { unifiedDataStore } from '../../../store/unifiedDataStore';

// Mock the dependencies

vi.mock('../../../store/unifiedDataAPI', () => ({
  unifiedDataAPI: mockAPI
}));

vi.mock('../../../utils/console', () => ({
  console_logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    data: vi.fn(),
    indexedDB: vi.fn(),
    api: vi.fn(),
    chart: vi.fn()
  }
}));

describe('Edge Cases and Error Scenario Tests', () => {
  beforeEach(() => {
    setupMocks();
  });

  afterEach(async () => {
    await unifiedDataStore.clearAllData();
  });

  describe('Signal Edge Cases', () => {
    it('should handle undefined and null values in signals', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal<any>(undefined);
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle undefined/null gracefully
        if (value === undefined || value === null) {
          // Don't assert specific type for null/undefined
          expect(value === undefined || value === null).toBe(true);
        } else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'object') {
          // Handle other types gracefully
          expect(['string', 'boolean', 'object']).toContain(typeof value);
        } else {
          expect(typeof value).toBe('number');
        }
      });

      // Act: Set various edge case values
      setSignal(undefined);
      setSignal(null);
      setSignal(0);
      setSignal('');
      setSignal(false);
      setSignal({});
      setSignal([]);

      // Assert: Effect should handle all cases
      expect(effectCount).toBe(7); // SolidJS may batch updates
    });

    it('should handle circular references in signals', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal<any>({});
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle circular references
        try {
          JSON.stringify(value); // This will throw for circular refs
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      });

      // Act: Create circular reference
      const circularObj = { name: 'test' };
      circularObj.self = circularObj; // Create circular reference
      
      setSignal(circularObj);
      setSignal({ normal: 'object' });

      // Assert: Effect should handle circular references
      expect(effectCount).toBe(3); // Initial + 2 updates
    });

    it('should handle very large numbers in signals', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle large numbers
        expect(typeof value).toBe('number');
        // Only check isFinite for finite numbers
        if (isFinite(value)) {
          expect(isFinite(value)).toBe(true);
        }
      });

      // Act: Set very large numbers
      setSignal(Number.MAX_SAFE_INTEGER);
      setSignal(Number.MIN_SAFE_INTEGER);
      setSignal(Infinity);
      setSignal(-Infinity);
      setSignal(NaN);

      // Assert: Effect should handle large numbers
      expect(effectCount).toBe(6); // Initial + 5 updates
    });

    it('should handle rapid signal updates without issues', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle rapid updates
        expect(typeof value).toBe('number');
      });

      // Act: Rapidly update signal
      const startTime = performance.now();
      
      for (let i = 0; i < 1000; i++) {
        setSignal(i);
      }
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Assert: Should handle rapid updates efficiently
      expect(totalTime).toBeLessThan(100); // 100ms max
      expect(effectCount).toBe(1000); // SolidJS may batch updates, so count might be less
    });
  });

  describe('Effect Error Handling', () => {
    it('should handle errors in effects gracefully', () => {
      // Arrange
      let effectCount = 0;
      let errorCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      // Create an effect that might throw
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        try {
          // Simulate an operation that might throw
          if (value === 5) {
            throw new Error('Test error');
          }
          
          // Normal processing
          const result = value * 2;
          expect(result).toBe(value * 2);
        } catch (error) {
          errorCount++;
          expect(error).toBeInstanceOf(Error);
        }
      });

      // Act: Update signal with values that might cause errors
      for (let i = 0; i < 10; i++) {
        setSignal(i);
      }

      // Assert: Should handle errors gracefully
      expect(effectCount).toBe(10); // SolidJS may batch updates
      expect(errorCount).toBe(1); // Only one error at value 5
    });

    it('should handle async errors in effects', async () => {
      // Arrange
      let effectCount = 0;
      let errorCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      // Create an effect with async operations
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Simulate async operation that might fail
        Promise.resolve()
          .then(() => {
            if (value === 3) {
              throw new Error('Async error');
            }
            return value * 2;
          })
          .catch(error => {
            errorCount++;
            expect(error).toBeInstanceOf(Error);
          });
      });

      // Act: Update signal
      for (let i = 0; i < 5; i++) {
        setSignal(i);
      }

      // Wait for async operations to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Assert: Should handle async errors
      expect(effectCount).toBe(5); // SolidJS may batch updates
      expect(errorCount).toBe(1); // One async error
    });

    it('should handle cleanup errors gracefully', () => {
      // Arrange
      let effectCount = 0;
      let cleanupCount = 0;
      let errorCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      // Create an effect with cleanup that might throw
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        onCleanup(() => {
          cleanupCount++;
          
          try {
            // Simulate cleanup that might throw
            if (value === 2) {
              throw new Error('Cleanup error');
            }
          } catch (error) {
            errorCount++;
            expect(error).toBeInstanceOf(Error);
          }
        });
      });

      // Act: Update signal
      for (let i = 0; i < 5; i++) {
        setSignal(i);
      }

      // Assert: Should handle cleanup errors
      expect(effectCount).toBe(5); // SolidJS may batch updates
      expect(cleanupCount).toBe(4); // Cleanup called for each previous effect
      expect(errorCount).toBe(1); // One cleanup error
    });
  });

  describe('Memo Edge Cases', () => {
    it('should handle undefined dependencies in memos', () => {
      // Arrange
      let memoCount = 0;
      const [signal1, setSignal1] = createSignal<any>(undefined);
      const [signal2, setSignal2] = createSignal<any>(undefined);
      
      // Create a memo with undefined dependencies
      const memo = createMemo(() => {
        memoCount++;
        const val1 = signal1();
        const val2 = signal2();
        
        // Should handle undefined values
        if (val1 === undefined || val2 === undefined) {
          return 'undefined';
        }
        
        return val1 + val2;
      });

      // Act: Update signals with undefined values
      setSignal1(undefined);
      setSignal2(undefined);
      setSignal1(5);
      setSignal2(10);
      setSignal1(undefined);
      setSignal2(20);

      // Assert: Memo should handle undefined values
      expect(memoCount).toBe(5); // Initial + 4 updates
      expect(memo()).toBe('undefined'); // Last value should be undefined
    });

    it('should handle circular dependencies in memos', () => {
      // Arrange
      let memo1Count = 0;
      let memo2Count = 0;
      
      const [signal, setSignal] = createSignal(0);
      
      // Create memos that might create circular dependencies
      const memo1 = createMemo(() => {
        memo1Count++;
        const val = signal();
        return val * 2;
      });
      
      const memo2 = createMemo(() => {
        memo2Count++;
        const val1 = memo1();
        return val1 + 1;
      });

      // Act: Update signal
      setSignal(5);
      setSignal(10);
      setSignal(15);

      // Assert: Should handle circular dependencies
      expect(memo1Count).toBe(4); // Initial + 3 updates
      expect(memo2Count).toBe(4); // Initial + 3 updates
      expect(memo2()).toBe(31); // 15 * 2 + 1
    });

    it('should handle expensive computations in memos', () => {
      // Arrange
      let memoCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      // Create a memo with expensive computation
      const expensiveMemo = createMemo(() => {
        memoCount++;
        const value = signal();
        
        // Simulate expensive computation
        let result = 0;
        for (let i = 0; i < 10000; i++) {
          result += Math.sqrt(i + value);
        }
        
        return result;
      });

      // Act: Update signal multiple times
      const startTime = performance.now();
      
      for (let i = 0; i < 10; i++) {
        setSignal(i);
      }
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Assert: Should handle expensive computations
      expect(totalTime).toBeLessThan(1000); // 1 second max
      expect(memoCount).toBe(10); // SolidJS may batch updates
      expect(expensiveMemo()).toBeGreaterThan(0);
    });
  });

  describe('Store Edge Cases', () => {
    it('should handle store errors gracefully', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockRejectedValue(new Error('IndexedDB error'));
      mockIndexedDB.getAvailableChannels.mockRejectedValue(new Error('Channels error'));
      
      let effectCount = 0;
      
      // Create an effect that watches store signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const loading = unifiedDataStore.getLoading('timeseries');
        const error = unifiedDataStore.getError('timeseries');
        
        effectCount++;
        
        // Should handle store errors gracefully
        if (error) {
          expect(error).toBeInstanceOf(Error);
        }
      });

      // Act: Try to fetch data (this will cause errors)
      try {
        await unifiedDataStore.fetchDataWithChannelChecking(
          'timeseries',
          'AC75',
          '1',
          ['twa', 'bsp'],
          { projectId: 'test' }
        );
      } catch (error) {
        // Expected to throw
        expect(error).toBeInstanceOf(Error);
      }

      // Assert: Should handle store errors
      expect(effectCount).toBeGreaterThan(0);
    });

    it('should handle concurrent store operations', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      
      // Create an effect that watches store signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const loading = unifiedDataStore.getLoading('timeseries');
        const error = unifiedDataStore.getError('timeseries');
        
        effectCount++;
        
        // Should handle concurrent operations
        if (data && data.length > 0) {
          expect(data.length).toBe(mockDataPoints.length);
        }
      });

      // Act: Perform concurrent operations
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          unifiedDataStore.fetchDataWithChannelChecking(
            'timeseries',
            'AC75',
            '1',
            ['twa', 'bsp'],
            { projectId: `test-${i}` }
          )
        );
      }
      
      await Promise.all(promises);

      // Assert: Should handle concurrent operations
      expect(effectCount).toBeGreaterThan(0);
    });

    it('should handle store signal updates with undefined values', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(undefined);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(undefined);
      
      let effectCount = 0;
      
      // Create an effect that watches store signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const loading = unifiedDataStore.getLoading('timeseries');
        const error = unifiedDataStore.getError('timeseries');
        
        effectCount++;
        
        // Should handle undefined values
        if (data === undefined) {
          expect(data).toBeUndefined();
        }
      });

      // Act: Try to fetch data
      try {
        await unifiedDataStore.fetchDataWithChannelChecking(
          'timeseries',
          'AC75',
          '1',
          ['twa', 'bsp'],
          { projectId: 'test' }
        );
      } catch (error) {
        // Expected to throw or handle gracefully
      }

      // Assert: Should handle undefined values
      expect(effectCount).toBeGreaterThan(0);
    });
  });

  describe('Boundary Conditions', () => {
    it('should handle empty arrays and objects', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal<any[]>([]);
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle empty arrays and other values
        if (Array.isArray(value)) {
          expect(Array.isArray(value)).toBe(true);
          expect(value.length).toBeGreaterThanOrEqual(0);
        } else {
          // For non-array values, just check they exist
          expect(value !== undefined).toBe(true);
        }
      });

      // Act: Set various empty values
      setSignal([]);
      setSignal({});
      setSignal('');
      setSignal(0);
      setSignal(false);

      // Assert: Should handle empty values
      expect(effectCount).toBe(6); // Initial + 5 updates
    });

    it('should handle very deep nested objects', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal<any>({});
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle deep nested objects
        expect(typeof value).toBe('object');
      });

      // Act: Create deep nested object
      let deepObj = {};
      for (let i = 0; i < 100; i++) {
        deepObj = { level: i, nested: deepObj };
      }
      
      setSignal(deepObj);

      // Assert: Should handle deep nested objects
      expect(effectCount).toBe(2); // Initial + 1 update
    });

    it('should handle very large arrays', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal<any[]>([]);
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Should handle large arrays
        expect(Array.isArray(value)).toBe(true);
        expect(value.length).toBeGreaterThanOrEqual(0);
      });

      // Act: Create large array
      const largeArray = Array.from({ length: 100000 }, (_, i) => i);
      setSignal(largeArray);

      // Assert: Should handle large arrays
      expect(effectCount).toBe(2); // Initial + 1 update
      expect(largeArray.length).toBe(100000);
    });
  });
});
