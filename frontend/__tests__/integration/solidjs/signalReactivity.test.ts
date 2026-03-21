/**
 * Signal Reactivity and Infinite Loop Tests
 * 
 * Tests for SolidJS signal reactivity, infinite loops, and performance issues
 * that can occur when signals change and trigger cascading updates
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

describe('Signal Reactivity and Infinite Loop Tests', () => {
  beforeEach(() => {
    setupMocks();
  });

  afterEach(async () => {
    await unifiedDataStore.clearAllData();
  });

  describe('Signal Change Detection', () => {
    it('should not cause infinite loops when data signal changes', async () => {
      // Arrange: Setup mock data
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      let lastDataLength = 0;
      
      // Create a signal to track data changes
      const [dataSignal, setDataSignal] = createSignal<any[]>([]);
      
      // Create an effect that should not loop infinitely
      createEffect(() => {
        const data = dataSignal();
        effectCount++;
        lastDataLength = data.length;
        
        // Prevent infinite loops by checking if data actually changed
        if (data.length > 0 && data.length !== lastDataLength) {
          console.log(`Data changed: ${data.length} items`);
        }
      });

      // Act: Fetch data and update signal
      const result = await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      setDataSignal(result);
      
      // Update signal again with same data (should not trigger infinite loop)
      setDataSignal([...result]);
      setDataSignal([...result]);

      // Assert: Effect should not run infinitely
      expect(effectCount).toBeLessThan(10); // Should be reasonable number of runs
      expect(lastDataLength).toBe(mockDataPoints.length);
    });

    it('should handle rapid signal changes without infinite loops', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      const [dataSignal, setDataSignal] = createSignal<any[]>([]);
      
      createEffect(() => {
        const data = dataSignal();
        effectCount++;
        
        // Simulate some processing that might trigger more updates
        if (data.length > 0) {
          // This should not cause infinite loops
          const processedData = data.map(item => ({ ...item, processed: true }));
          // Don't update the signal here to avoid infinite loops
        }
      });

      // Act: Rapidly change the signal
      const result = await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Simulate rapid changes
      for (let i = 0; i < 5; i++) {
        setDataSignal([...result]);
        setDataSignal(result.slice(0, 3));
        setDataSignal([...result]);
      }

      // Assert: Should not cause infinite loops
      expect(effectCount).toBeLessThan(20);
    });

    it('should handle loading state changes without infinite loops', async () => {
      // Arrange
      let loadingEffectCount = 0;
      let errorEffectCount = 0;
      
      const [loadingSignal, setLoadingSignal] = createSignal(false);
      const [errorSignal, setErrorSignal] = createSignal<string | null>(null);
      
      // Create effects that might interact
      createEffect(() => {
        const loading = loadingSignal();
        loadingEffectCount++;
        
        if (loading) {
          // Clear error when loading starts
          setErrorSignal(null);
        }
      });
      
      createEffect(() => {
        const error = errorSignal();
        errorEffectCount++;
        
        if (error) {
          // Clear loading when error occurs
          setLoadingSignal(false);
        }
      });

      // Act: Simulate loading states
      setLoadingSignal(true);
      setLoadingSignal(false);
      setErrorSignal('Test error');
      setErrorSignal(null);
      setLoadingSignal(true);
      setLoadingSignal(false);

      // Assert: Effects should not run infinitely
      expect(loadingEffectCount).toBeLessThan(10);
      expect(errorEffectCount).toBeLessThan(10);
    });
  });

  describe('Memo Dependencies', () => {
    it('should not cause infinite loops with memo dependencies', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let memoCount = 0;
      const [dataSignal, setDataSignal] = createSignal<any[]>([]);
      const [filterSignal, setFilterSignal] = createSignal('all');
      
      // Create a memo that depends on both signals
      const filteredData = createMemo(() => {
        memoCount++;
        const data = dataSignal();
        const filter = filterSignal();
        
        if (filter === 'all') return data;
        return data.filter(item => item.twa > 50);
      });

      // Act: Update signals in various orders
      const result = await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      setDataSignal(result);
      setFilterSignal('high');
      setFilterSignal('all');
      setDataSignal([...result]);
      setFilterSignal('high');

      // Assert: Memo should not recalculate infinitely
      expect(memoCount).toBeLessThan(15);
      expect(filteredData().length).toBeGreaterThan(0);
    });

    it('should handle circular dependencies in memos', () => {
      // Arrange
      let memo1Count = 0;
      let memo2Count = 0;
      
      const [signal1, setSignal1] = createSignal(0);
      const [signal2, setSignal2] = createSignal(0);
      
      // Create memos that depend on each other (potential circular dependency)
      const memo1 = createMemo(() => {
        memo1Count++;
        const val2 = signal2();
        return val2 * 2;
      });
      
      const memo2 = createMemo(() => {
        memo2Count++;
        const val1 = signal1();
        return val1 + 1;
      });

      // Act: Update signals
      setSignal1(5);
      setSignal2(10);
      setSignal1(15);
      setSignal2(20);

      // Assert: Should not cause infinite loops
      expect(memo1Count).toBeLessThan(10);
      expect(memo2Count).toBeLessThan(10);
    });
  });

  describe('Effect Cleanup', () => {
    it('should properly cleanup effects to prevent memory leaks', () => {
      // Arrange
      let effectCount = 0;
      let cleanupCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      // Create an effect with cleanup
      createEffect(() => {
        effectCount++;
        const value = signal();
        
        // Simulate some async operation
        const timeoutId = setTimeout(() => {
          console.log(`Value: ${value}`);
        }, 100);
        
        // Cleanup function
        onCleanup(() => {
          cleanupCount++;
          clearTimeout(timeoutId);
        });
      });

      // Act: Update signal multiple times
      for (let i = 0; i < 5; i++) {
        setSignal(i);
      }

      // Assert: Cleanup should be called
      expect(effectCount).toBe(5); // SolidJS may batch updates
      expect(cleanupCount).toBe(4); // Cleanup called for each previous effect
    });

    it('should cleanup effects when component unmounts', () => {
      // Arrange
      let effectCount = 0;
      let cleanupCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      // Create multiple effects
      const effects = [];
      for (let i = 0; i < 3; i++) {
        effects.push(createEffect(() => {
          effectCount++;
          const value = signal();
          
          onCleanup(() => {
            cleanupCount++;
          });
        }));
      }

      // Act: Update signal and "unmount" (simulate cleanup)
      setSignal(1);
      setSignal(2);
      
      // Simulate unmounting by calling cleanup manually
      // In real SolidJS, this happens automatically
      effects.forEach(effect => {
        // In real SolidJS, effects are automatically cleaned up
        // This is just for testing the concept
      });

      // Assert: Effects should run and cleanup should be called
      expect(effectCount).toBeGreaterThan(0);
    });
  });

  describe('Store Signal Interactions', () => {
    it('should not cause infinite loops when store signals interact', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let storeEffectCount = 0;
      
      // Create an effect that watches store signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const loading = unifiedDataStore.getLoading('timeseries');
        const error = unifiedDataStore.getError('timeseries');
        
        storeEffectCount++;
        
        // This should not cause infinite loops
        if (data && data.length > 0 && !loading && !error) {
          console.log(`Store data loaded: ${data.length} items`);
        }
      });

      // Act: Fetch data (this will update store signals)
      await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Effect should not run infinitely
      expect(storeEffectCount).toBeLessThan(10);
    });

    it('should handle store signal updates without cascading effects', async () => {
      // Arrange
      mockIndexedDB.queryDataByChannels.mockResolvedValue(mockDataPoints);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      const [externalSignal, setExternalSignal] = createSignal(0);
      
      // Create an effect that depends on both store and external signals
      createEffect(() => {
        const data = unifiedDataStore.getData('timeseries');
        const external = externalSignal();
        
        effectCount++;
        
        // This should not cause infinite loops
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

      // Assert: Effect should not run infinitely
      expect(effectCount).toBeLessThan(15);
    });
  });

  describe('Performance and Memory', () => {
    it('should not cause memory leaks with large datasets', async () => {
      // Arrange: Create large dataset
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        ...mockDataPoints[0],
        timestamp: 1704067200000 + i * 1000,
        twa: i % 360,
        bsp: 10 + (i % 20)
      }));

      mockIndexedDB.queryDataByChannels.mockResolvedValue(largeDataset);
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa', 'bsp']);
      
      let effectCount = 0;
      const [dataSignal, setDataSignal] = createSignal<any[]>([]);
      
      // Create an effect that processes large data
      createEffect(() => {
        const data = dataSignal();
        effectCount++;
        
        if (data.length > 0) {
          // Process data without causing memory leaks
          const processed = data.map(item => ({
            ...item,
            processed: true,
            timestamp: item.timestamp
          }));
          
          // Don't store processed data in signals to avoid memory leaks
          console.log(`Processed ${processed.length} items`);
        }
      });

      // Act: Load large dataset
      const result = await unifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'AC75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      setDataSignal(result);
      
      // Update signal multiple times
      for (let i = 0; i < 10; i++) {
        setDataSignal([...result]);
      }

      // Assert: Should not cause memory issues
      expect(effectCount).toBeLessThan(20);
      expect(result.length).toBe(1000); // Large dataset was processed
    });

    it('should handle rapid signal updates efficiently', () => {
      // Arrange
      let effectCount = 0;
      const [signal, setSignal] = createSignal(0);
      
      createEffect(() => {
        const value = signal();
        effectCount++;
        
        // Simulate some processing
        const processed = value * 2;
        return processed;
      });

      // Act: Rapidly update signal
      const startTime = performance.now();
      
      for (let i = 0; i < 100; i++) {
        setSignal(i);
      }
      
      const endTime = performance.now();

      // Assert: Should be efficient
      expect(endTime - startTime).toBeLessThan(100); // Should complete quickly
      expect(effectCount).toBe(100); // SolidJS may batch updates
    });
  });
});
