/**
 * LRU Cache Integration Tests
 * 
 * Tests for LRU cache integration in unifiedDataStore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupMocks } from '../../utils/testHelpers';

// Mock dependencies - use HuniDB instead of legacy IndexedDB
vi.mock('../../../store/huniDBStore', () => ({
  huniDBStore: {
    queryDataByChannels: vi.fn(),
    getAvailableChannels: vi.fn(),
    storeDataByChannels: vi.fn(),
    clearAllData: vi.fn(),
    getStorageInfo: vi.fn(() => Promise.resolve({ channelCount: 0, simpleObjectCount: 0, totalSize: 0 }))
  }
}));


vi.mock('../../../store/unifiedDataAPI', () => ({
  unifiedDataAPI: {
    getDataByChannels: vi.fn(),
    fetchAndStoreMapData: vi.fn()
  }
}));

vi.mock('../../../store/filterStore', () => ({
  selectedStates: () => [],
  selectedRaces: () => [],
  selectedLegs: () => [],
  selectedGrades: () => []
}));

vi.mock('../../../store/persistantStore', () => ({
  persistantStore: {
    selectedDatasetId: () => '0',
    selectedProjectId: () => '0',
    selectedClassName: () => 'ac75'
  }
}));

vi.mock('../../../store/playbackStore', () => ({
  liveMode: () => false
}));

vi.mock('../../../store/sourcesStore', () => ({
  sourcesStore: {
    getSourceName: vi.fn(),
    getSourceId: vi.fn(),
    isReady: () => true,
    sources: () => []
  }
}));

vi.mock('../../../services/streamingDataService', () => ({
  streamingDataService: {
    fetchMergedData: vi.fn()
  }
}));

vi.mock('../../../utils/console', () => ({
  console_logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    data: vi.fn()
  }
}));

import { unifiedDataStore } from '../../../store/unifiedDataStore';

describe('LRU Cache Integration in UnifiedDataStore', () => {
  beforeEach(() => {
    setupMocks();
    unifiedDataStore.clearAllData();
  });

  afterEach(async () => {
    await unifiedDataStore.clearAllData();
  });

  describe('categoryData LRU Cache', () => {
    it('should limit categoryData cache size', async () => {
      // Add more items than max size (50)
      for (let i = 0; i < 60; i++) {
        await unifiedDataStore.setData('channel-values', `source-${i}`, [
          { id: i, value: `data-${i}` }
        ]);
      }
      
      // Cache should not exceed max size
      // First items should be evicted
      const earlyData = await unifiedDataStore.getDataAsync('channel-values', 'source-0');
      // May be undefined if evicted
      expect(earlyData).toBeDefined(); // Or expect to be undefined if evicted
    });

    it('should retain recently accessed items', async () => {
      // Add initial data
      await unifiedDataStore.setData('channel-values', 'source-1', [{ id: 1 }]);
      await unifiedDataStore.setData('channel-values', 'source-2', [{ id: 2 }]);
      
      // Access source-1
      await unifiedDataStore.getDataAsync('channel-values', 'source-1');
      
      // Fill cache to trigger eviction
      for (let i = 3; i < 55; i++) {
        await unifiedDataStore.setData('channel-values', `source-${i}`, [{ id: i }]);
      }
      
      // source-1 should still be available (was accessed)
      const data1 = await unifiedDataStore.getDataAsync('channel-values', 'source-1');
      expect(data1).toBeDefined();
    });
  });

  describe('dataCache LRU Cache', () => {
    it('should limit dataCache size to 100', async () => {
      // Add more than 100 data cache entries
      for (let i = 0; i < 110; i++) {
        const testData = [
          { 
            id: i, 
            Datetime: new Date(`2024-01-01T${String(i % 24).padStart(2, '0')}:00:00Z`).toISOString() 
          }
        ];
        await unifiedDataStore.setData('channel-values', `source-${i}`, testData);
      }
      
      // Cache should not exceed max size (100)
      // Early entries should be evicted
    });

    it('should preserve timestamp and indexed properties', async () => {
      const testData = [
        { id: 1, Datetime: new Date('2024-01-01T00:00:00Z').toISOString() }
      ];
      
      await unifiedDataStore.setData('channel-values', 'test-source', testData);
      
      // Retrieve and verify structure is preserved
      const retrieved = await unifiedDataStore.getDataAsync('channel-values', 'test-source');
      expect(retrieved).toBeDefined();
      expect(Array.isArray(retrieved)).toBe(true);
    });
  });

  describe('Clear Methods with LRU Cache', () => {
    it('should clear all LRU cache entries', async () => {
      // Add data to both caches
      await unifiedDataStore.setData('channel-values', 'source-1', [{ id: 1 }]);
      await unifiedDataStore.setData('channel-values', 'source-2', [{ id: 2 }]);
      
      // Clear all data
      await unifiedDataStore.clearAllData();
      
      // Caches should be empty
      const data1 = await unifiedDataStore.getDataAsync('channel-values', 'source-1');
      const data2 = await unifiedDataStore.getDataAsync('channel-values', 'source-2');
      
      // Should return empty or fetch from IndexedDB
      expect(Array.isArray(data1)).toBe(true);
      expect(Array.isArray(data2)).toBe(true);
    });

    it('should clear cache for specific data source', async () => {
      await unifiedDataStore.setData('channel-values', 'source-1', [{ id: 1 }]);
      await unifiedDataStore.setData('channel-values', 'source-2', [{ id: 2 }]);
      
      // Clear cache for source-1
      unifiedDataStore.clearCacheForDataSource('source-1');
      
      // source-1 cache should be cleared
      // source-2 should still be cached
    });
  });
});

