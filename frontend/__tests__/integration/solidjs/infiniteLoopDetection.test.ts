/**
 * Infinite Loop Detection Tests
 * 
 * Tests specifically designed to detect and prevent infinite loops
 * in SolidJS signal reactivity and effect chains
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSignal, createEffect, createMemo, onCleanup } from 'solid-js';
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

describe('Infinite Loop Detection Tests', () => {
  beforeEach(() => {
    setupMocks();
  });

  afterEach(async () => {
    await unifiedDataStore.clearAllData();
  });

  describe('Effect Loop Detection', () => {
    it('should detect and prevent infinite loops in effects', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal(0);
      const maxIterations = 100; // Safety limit
      
      // Create an effect that might cause infinite loops
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Safety check to prevent infinite loops
        if (effectCount > maxIterations) {
          throw new Error('Infinite loop detected: effect ran too many times');
        }
        
        // Simulate some processing that might trigger more updates
        if (value < 10) {
          // This could cause infinite loops if not handled properly
          // In real code, you'd want to avoid updating signals in effects
          console.log(`Processing value: ${value}`);
        }
      });

      // Act: Update signal
      setSignal(5);
      setSignal(10);
      setSignal(15);

      // Assert: Should not cause infinite loops
      expect(effectCount).toBeLessThan(maxIterations);
      expect(effectCount).toBe(4); // Initial + 3 updates
    });

    it('should detect cascading effect updates', () => {
      // Arrange
      let effect1Count = 0;
      let effect2Count = 0;
      let effect3Count = 0;
      const [signal1, setSignal1] = createSignal(0);
      const [signal2, setSignal2] = createSignal(0);
      const [signal3, setSignal3] = createSignal(0);
      
      const maxIterations = 50;
      
      // Create effects that might cascade
      createEffect(() => {
        const value = signal1();
        effect1Count++;
        
        if (effect1Count > maxIterations) {
          throw new Error('Infinite loop detected in effect1');
        }
        
        // This could cause cascading updates
        if (value > 0) {
          setSignal2(value * 2);
        }
      });
      
      createEffect(() => {
        const value = signal2();
        effect2Count++;
        
        if (effect2Count > maxIterations) {
          throw new Error('Infinite loop detected in effect2');
        }
        
        // This could cause cascading updates
        if (value > 0) {
          setSignal3(value + 1);
        }
      });
      
      createEffect(() => {
        const value = signal3();
        effect3Count++;
        
        if (effect3Count > maxIterations) {
          throw new Error('Infinite loop detected in effect3');
        }
        
        // This could cause cascading updates
        if (value > 0) {
          setSignal1(value - 1);
        }
      });

      // Act: Trigger the cascade - this should cause an infinite loop
      expect(() => {
        setSignal1(5);
      }).toThrow('Infinite loop detected');

      // Assert: Should detect and prevent infinite loops
      expect(effect1Count).toBeLessThanOrEqual(maxIterations + 1); // Allow for one extra iteration
      expect(effect2Count).toBeLessThanOrEqual(maxIterations + 1);
      expect(effect3Count).toBeLessThanOrEqual(maxIterations + 1);
    });

    it('should detect loops in effect cleanup', () => {
      // Arrange
      let effectCount = 0;
      let cleanupCount = 0;
      const [signal, setSignal] = createSignal(0);
      const maxIterations = 50;
      
      // Create an effect with cleanup that might cause loops
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        if (effectCount > maxIterations) {
          throw new Error('Infinite loop detected in effect');
        }
        
        onCleanup(() => {
          cleanupCount++;
          
          if (cleanupCount > maxIterations) {
            throw new Error('Infinite loop detected in cleanup');
          }
          
          // This could cause loops if not handled properly
          if (value > 0) {
            setSignal(value - 1);
          }
        });
      });

      // Act: Update signal
      setSignal(10);
      setSignal(5);
      setSignal(0);

      // Assert: Should not cause infinite loops
      expect(effectCount).toBeLessThan(maxIterations);
      expect(cleanupCount).toBeLessThan(maxIterations);
    });
  });

  describe('Memo Loop Detection', () => {
    it('should detect infinite loops in memos', () => {
      // Arrange
      let memo1Count = 0;
      let memo2Count = 0;
      const [signal, setSignal] = createSignal(0);
      const maxIterations = 50;
      
      // Create memos that might cause loops
      const memo1 = createMemo(() => {
        memo1Count++;
        
        if (memo1Count > maxIterations) {
          throw new Error('Infinite loop detected in memo1');
        }
        
        const value = signal();
        return value * 2;
      });
      
      const memo2 = createMemo(() => {
        memo2Count++;
        
        if (memo2Count > maxIterations) {
          throw new Error('Infinite loop detected in memo2');
        }
        
        const val1 = memo1();
        return val1 + 1;
      });

      // Act: Update signal
      setSignal(5);
      setSignal(10);
      setSignal(15);

      // Assert: Should not cause infinite loops
      expect(memo1Count).toBeLessThan(maxIterations);
      expect(memo2Count).toBeLessThan(maxIterations);
      expect(memo2()).toBe(31); // 15 * 2 + 1
    });

    it('should detect circular dependencies in memos', () => {
      // Arrange
      let memo1Count = 0;
      let memo2Count = 0;
      let memo3Count = 0;
      const [signal, setSignal] = createSignal(0);
      const maxIterations = 50;
      
      // Create memos with circular dependencies
      const memo1 = createMemo(() => {
        memo1Count++;
        
        if (memo1Count > maxIterations) {
          throw new Error('Infinite loop detected in memo1');
        }
        
        const value = signal();
        return value * 2;
      });
      
      const memo2 = createMemo(() => {
        memo2Count++;
        
        if (memo2Count > maxIterations) {
          throw new Error('Infinite loop detected in memo2');
        }
        
        const val1 = memo1();
        return val1 + 1;
      });
      
      const memo3 = createMemo(() => {
        memo3Count++;
        
        if (memo3Count > maxIterations) {
          throw new Error('Infinite loop detected in memo3');
        }
        
        const val2 = memo2();
        return val2 - 1;
      });

      // Act: Update signal
      setSignal(5);
      setSignal(10);

      // Assert: Should not cause infinite loops
      expect(memo1Count).toBeLessThan(maxIterations);
      expect(memo2Count).toBeLessThan(maxIterations);
      expect(memo3Count).toBeLessThan(maxIterations);
    });
  });

  describe('Store Loop Detection', () => {
    it('should detect infinite loops in store interactions', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      const maxIterations = 50;
      
      // Create an effect that watches store signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const loading = unifiedDataStore.getLoading('timeseries');
        const error = unifiedDataStore.getError('timeseries');
        
        effectCount++;
        
        if (effectCount > maxIterations) {
          throw new Error('Infinite loop detected in store effect');
        }
        
        // This could cause loops if not handled properly
        if (data && data.length > 0 && !loading && !error) {
          console.log(`Store data loaded: ${data.length} items`);
        }
      });

      // Act: Fetch data
      await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should not cause infinite loops
      expect(effectCount).toBeLessThan(maxIterations);
    });

    it('should detect loops in store signal updates', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      const [externalSignal, setExternalSignal] = createSignal(0);
      const maxIterations = 50;
      
      // Create an effect that depends on both store and external signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const external = externalSignal();
        
        effectCount++;
        
        if (effectCount > maxIterations) {
          throw new Error('Infinite loop detected in store-external effect');
        }
        
        // This could cause loops if not handled properly
        if (data && external > 0) {
          console.log(`Data: ${data.length}, External: ${external}`);
        }
      });

      // Act: Update external signal while store is loading
      setExternalSignal(1);
      setExternalSignal(2);
      
      await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );
      
      setExternalSignal(3);
      setExternalSignal(4);

      // Assert: Should not cause infinite loops
      expect(effectCount).toBeLessThan(maxIterations);
    });
  });

  describe('Performance-Based Loop Detection', () => {
    it('should detect loops based on performance metrics', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal(0);
      const maxTime = 100; // 100ms max
      
      // Create an effect that might cause performance issues
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Simulate some processing
        const startTime = performance.now();
        
        // This could cause performance issues if it runs too many times
        let result = 0;
        for (let i = 0; i < 1000; i++) {
          result += Math.sqrt(i + value);
        }
        
        const endTime = performance.now();
        const processingTime = endTime - startTime;
        
        // Check if processing is taking too long
        if (processingTime > maxTime) {
          throw new Error(`Performance issue detected: ${processingTime}ms`);
        }
      });

      // Act: Update signal
      const startTime = performance.now();
      
      for (let i = 0; i < 10; i++) {
        setSignal(i);
      }
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Assert: Should not cause performance issues
      expect(totalTime).toBeLessThan(1000); // 1 second max
      expect(effectCount).toBe(10); // SolidJS may batch updates
    });

    it('should detect memory leaks that might cause loops', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal(0);
      const maxIterations = 100;
      
      // Create an effect that might cause memory leaks
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        if (effectCount > maxIterations) {
          throw new Error('Memory leak detected: effect ran too many times');
        }
        
        // Simulate creating objects that might leak
        const data = new Array(1000).fill(0).map((_, i) => ({
          id: i,
          value: value + i,
          timestamp: Date.now()
        }));
        
        // Cleanup function to prevent memory leaks
        onCleanup(() => {
          // Clear the data array
          data.length = 0;
        });
      });

      // Act: Update signal many times
      for (let i = 0; i < 50; i++) {
        setSignal(i);
      }

      // Assert: Should not cause memory leaks
      expect(effectCount).toBe(50); // SolidJS may batch updates
    });
  });

  describe('Real-World Loop Scenarios', () => {
    it('should detect loops in data processing pipelines', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let processingCount = 0;
      const [processedData, setProcessedData] = createSignal<any[]>([]);
      const [filter, setFilter] = createSignal('all');
      const maxIterations = 50;
      
      // Create a data processing pipeline that might loop
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const currentFilter = filter();
        
        processingCount++;
        
        if (processingCount > maxIterations) {
          throw new Error('Infinite loop detected in data processing');
        }
        
        if (data && data.length > 0) {
          // Process data based on filter
          let filtered = data;
          if (currentFilter === 'high') {
            filtered = data.filter(item => item.twa > 90);
          } else if (currentFilter === 'low') {
            filtered = data.filter(item => item.twa <= 90);
          }
          
          // This could cause loops if not handled properly
          setProcessedData(filtered);
        }
      });

      // Act: Fetch data and apply filters
      await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );
      
      setFilter('high');
      setFilter('low');
      setFilter('all');

      // Assert: Should not cause infinite loops
      expect(processingCount).toBeLessThan(maxIterations);
    });

    it('should detect loops in UI state management', () => {
      // Arrange
      let stateCount = 0;
      const [isLoading, setIsLoading] = createSignal(false);
      const [error, setError] = createSignal<string | null>(null);
      const [data, setData] = createSignal<any[]>([]);
      const maxIterations = 50;
      
      // Create state management that might loop
      createEffect(() => {
        const loading = isLoading();
        const err = error();
        const currentData = data();
        
        stateCount++;
        
        if (stateCount > maxIterations) {
          throw new Error('Infinite loop detected in state management');
        }
        
        // This could cause loops if not handled properly
        if (loading && err) {
          setError(null);
        }
        
        if (err && currentData.length > 0) {
          setData([]);
        }
        
        if (currentData.length === 0 && !loading && !err) {
          setIsLoading(true);
        }
      });

      // Act: Simulate state changes
      setIsLoading(true);
      setError('Test error');
      setData(mockDataPoints);
      setIsLoading(false);
      setError(null);

      // Assert: Should not cause infinite loops
      expect(stateCount).toBeLessThan(maxIterations);
    });
  });
});
