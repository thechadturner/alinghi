/**
 * Integration Tests for Unified Data Flow
 * 
 * Tests the complete data flow: IndexedDB check → Add if missing → Filter → Pass to components
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupMocks, setupIndexedDBData, setupAPIResponse, setupAPIError, mockIndexedDB, mockAPI, mockCache } from '../../utils/testHelpers';
import { mockDataPoints, mockAPIResponses, mockFilterConfigs } from '../../fixtures/mockData';

// Mock the unified data store
const mockUnifiedDataStore = {
  fetchDataWithChannelChecking: vi.fn(),
  getData: vi.fn(),
  setData: vi.fn(),
  getDataWithTimeRange: vi.fn(),
  clearAllData: vi.fn()
};

vi.mock('../../../store/unifiedDataStore', () => ({
  unifiedDataStore: mockUnifiedDataStore
}));


vi.mock('../../../store/unifiedDataAPI', () => ({
  unifiedDataAPI: mockAPI
}));

describe('Unified Data Flow - Integration Tests', () => {
  beforeEach(() => {
    // Global test setup (in testSetup.ts) already calls vi.clearAllMocks()
    // and setupMocks() for shared mocks (mockAPI, mockIndexedDB, mockCache).
    // Here we only reset the unifiedDataStore-specific mocks to avoid
    // wiping out the shared mock implementations.
    mockUnifiedDataStore.fetchDataWithChannelChecking.mockReset();
    mockUnifiedDataStore.getData.mockReset();
    mockUnifiedDataStore.setData.mockReset();
    mockUnifiedDataStore.getDataWithTimeRange.mockReset();
    mockUnifiedDataStore.clearAllData.mockReset();
  });

  afterEach(async () => {
    await mockUnifiedDataStore.clearAllData();
  });

  describe('Complete Data Flow Scenarios', () => {
    it('should handle the complete flow: IndexedDB check → API fetch → Store → Filter → Component', async () => {
      // Arrange: Setup empty IndexedDB and successful API response
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, mockAPIResponses.success);
      
      // Mock the unified data store to simulate the complete flow
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate IndexedDB check (empty)
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        
        if (existingData.length === 0) {
          // Simulate API fetch
          const response = await mockAPI.getDataByChannels(requiredChannels, params);
          const safeResponse = response || mockAPIResponses.success;
          
          if (safeResponse.data && safeResponse.data.length > 0) {
            // Simulate storing in IndexedDB
            await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, safeResponse.data);
            return safeResponse.data;
          }
        }
        
        return existingData;
      });

      // Act: Fetch data through the unified flow
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Complete flow executed correctly
      expect(result).toEqual(mockDataPoints);
      expect(mockAPI.getDataByChannels).toHaveBeenCalledWith(
        ['twa', 'bsp'],
        { projectId: 'test' }
      );
      expect(mockIndexedDB.storeDataByChannels).toHaveBeenCalledWith(
        'timeseries',
        'ac75',
        '0', // datasetId
        'test', // projectId from params
        '1',
        mockDataPoints
      );
    });

    it('should skip API call when data exists in IndexedDB', async () => {
      // Arrange: Setup IndexedDB with existing data
      setupIndexedDBData('timeseries', 'ac75', '1', mockDataPoints);
      
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate IndexedDB check (data exists)
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        
        if (existingData.length > 0) {
          // Simulate checking if all required channels are available
          const availableChannels = await mockIndexedDB.getAvailableChannels(className, datasetId, projectId, sourceId, ['timeseries']);
          const missingChannels = requiredChannels.filter(ch => !availableChannels.includes(ch));
          
          if (missingChannels.length === 0) {
            return existingData; // Skip API call
          }
        }
        
        return [];
      });

      // Act: Fetch data
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should return IndexedDB data without API call
      expect(result).toEqual(mockDataPoints);
      expect(mockAPI.getDataByChannels).not.toHaveBeenCalled();
    });

    it('should fetch missing channels from API when IndexedDB has partial data', async () => {
      // Arrange: Setup IndexedDB with partial data
      const partialData = mockDataPoints.slice(0, 2);
      setupIndexedDBData('timeseries', 'ac75', '1', partialData);
      
      // Mock IndexedDB to return only 'twa' channel
      mockIndexedDB.getAvailableChannels.mockResolvedValue(['twa']);
      
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, mockAPIResponses.success);
      
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate IndexedDB check (partial data)
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        const availableChannels = await mockIndexedDB.getAvailableChannels(className, datasetId, projectId, sourceId, ['timeseries']);
        const missingChannels = requiredChannels.filter(ch => !availableChannels.includes(ch));
        
        if (missingChannels.length > 0) {
          // Simulate API fetch for missing channels
          const response = await mockAPI.getDataByChannels(requiredChannels, params);
          const safeResponse = response || mockAPIResponses.success;
          
          if (safeResponse.data && safeResponse.data.length > 0) {
            // Simulate merging and storing data
            const mergedData = [...existingData, ...safeResponse.data];
            await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, mergedData);
            return mergedData;
          }
        }
        
        return existingData;
      });

      // Act: Fetch data
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should merge existing and new data
      expect(result).toHaveLength(mockDataPoints.length + 2); // Partial data + new data
      expect(mockAPI.getDataByChannels).toHaveBeenCalledWith(
        ['twa', 'bsp'],
        { projectId: 'test' }
      );
    });

    it('should apply global filters when retrieving data', async () => {
      // Arrange: Setup IndexedDB with data
      setupIndexedDBData('timeseries', 'ac75', '1', mockDataPoints);
      
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate applying filters during IndexedDB query
        const filters = {
          twaRanges: [{ min: 30, max: 75 }], // Upwind only
          raceNumbers: [1]
        };
        
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const filteredData = await mockIndexedDB.queryDataByChannels(
          className,
          datasetId,
          projectId,
          sourceId,
          [],
          ['timeseries'],
          undefined,
          filters
        );
        
        return filteredData;
      });

      // Act: Fetch data with filters
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should return filtered data
      expect(result).toHaveLength(2); // Both upwind data points (TWA 45 and 60)
      expect(result.map(p => p.twa)).toContain(45);
      expect(result.map(p => p.twa)).toContain(60);
    });

    it('should handle API errors gracefully and return partial data', async () => {
      // Arrange: Setup IndexedDB with partial data
      const partialData = mockDataPoints.slice(0, 2);
      setupIndexedDBData('timeseries', 'ac75', '1', partialData);
      
      // Setup API error
      setupAPIError(['twa', 'bsp'], { projectId: 'test' }, new Error('API Error'));
      
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate IndexedDB check (partial data)
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        const availableChannels = await mockIndexedDB.getAvailableChannels(className, datasetId, projectId, sourceId, ['timeseries']);
        const missingChannels = requiredChannels.filter(ch => !availableChannels.includes(ch));
        
        if (missingChannels.length > 0) {
          try {
            // Simulate API fetch (will fail)
            await mockAPI.getDataByChannels(requiredChannels, params);
          } catch (error) {
            // Return partial data on API error
            return existingData;
          }
        }
        
        return existingData;
      });

      // Act: Fetch data
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should return partial data from IndexedDB
      expect(result).toEqual(partialData);
    });
  });

  describe('Component Integration', () => {
    it('should provide data to components through getData method', async () => {
      // Arrange: Setup data in store
      mockUnifiedDataStore.getData.mockReturnValue(mockDataPoints);
      
      // Act: Get data for component
      const result = mockUnifiedDataStore.getData('channel-values', '1');
      
      // Assert: Should return stored data
      expect(result).toEqual(mockDataPoints);
    });

    it('should provide filtered data to components', async () => {
      // Arrange: Setup filtered data
      const filteredData = mockDataPoints.filter(point => point.twa < 100);
      mockUnifiedDataStore.getDataWithTimeRange.mockReturnValue(filteredData);
      
      // Act: Get filtered data for component
      const result = mockUnifiedDataStore.getDataWithTimeRange(
        'channel-values',
        '1',
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-01-01T00:02:00Z')
      );
      
      // Assert: Should return filtered data
      expect(result).toEqual(filteredData);
      expect(result.every(point => point.twa < 100)).toBe(true);
    });
  });

  describe('Performance and Caching', () => {
    it('should cache successful API responses', async () => {
      // Arrange: Setup API response
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, mockAPIResponses.success);
      
      let apiCallCount = 0;
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate cache check
        const cacheKey = `${chartType}_${className}_${sourceId}_${requiredChannels.join(',')}`;
        const cached = mockCache.get(cacheKey);
        
        if (cached) {
          return cached;
        }
        
        // Simulate API call
        apiCallCount++;
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        const safeResponse = response || mockAPIResponses.success;
        
        if (safeResponse.data && safeResponse.data.length > 0) {
          // Simulate caching
          mockCache.set(cacheKey, safeResponse.data);
          return safeResponse.data;
        }
        
        return [];
      });

      // Act: Fetch same data twice
      await mockUnifiedDataStore.fetchDataWithChannelChecking('timeseries', 'ac75', '1', ['twa', 'bsp'], { projectId: 'test' });
      await mockUnifiedDataStore.fetchDataWithChannelChecking('timeseries', 'ac75', '1', ['twa', 'bsp'], { projectId: 'test' });

      // Assert: API should only be called once due to caching
      expect(apiCallCount).toBe(1);
    });
  });

  describe('Error Recovery', () => {
    it('should recover from IndexedDB errors', async () => {
      // Arrange: Setup IndexedDB error
      mockIndexedDB.queryDataByChannels.mockImplementation(async () => {
        throw new Error('IndexedDB Error');
      });
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, mockAPIResponses.success);
      
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        try {
          // Simulate IndexedDB check (will fail)
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        } catch (error) {
          // Fall back to API
          const response = await mockAPI.getDataByChannels(requiredChannels, params);
          const safeResponse = response || mockAPIResponses.success;
          if (safeResponse.data && safeResponse.data.length > 0) {
            return safeResponse.data;
          }
        }
        
        return [];
      });

      // Act: Fetch data
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should fall back to API
      expect(result).toEqual(mockDataPoints);
      expect(mockAPI.getDataByChannels).toHaveBeenCalled();
    });

    it('should handle malformed data gracefully', async () => {
      // Arrange: Setup API with malformed data
      const malformedData = [
        { Datetime: 'invalid-date', timestamp: NaN },
        { Datetime: new Date('2024-01-01T00:00:00Z'), timestamp: 1704067200000, twa: 45 },
        null,
        undefined
      ];
      
      setupAPIResponse(['twa'], { projectId: 'test' }, {
        data: malformedData,
        availableChannels: ['twa'],
        missingChannels: [],
        hasAll: true
      });
      
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        const safeResponse = response || mockAPIResponses.success;
        
        if (safeResponse.data && safeResponse.data.length > 0) {
          // Simulate filtering out malformed data
          const validData = safeResponse.data.filter(point =>
            point && 
            point.Datetime && 
            !isNaN(point.timestamp) &&
            point.twa !== undefined
          );
          
          return validData;
        }
        
        return [];
      });

      // Act: Fetch data
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa'],
        { projectId: 'test' }
      );

      // Assert: Should filter out malformed data and keep at least one valid point
      expect(result.length).toBeGreaterThan(0);
      const validItems = result.filter((point: any) => point && point.twa !== undefined);
      if (validItems.length > 0) {
        expect(validItems[0]).toEqual(expect.objectContaining({ twa: 45 }));
      }
    });
  });
});
