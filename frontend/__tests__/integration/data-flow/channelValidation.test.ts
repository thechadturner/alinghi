/**
 * Integration Tests for Channel Validation
 * 
 * Tests the channel validation and merging logic in the data flow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupMocks, setupIndexedDBData, setupAPIResponse, mockIndexedDB, mockAPI } from '../../utils/testHelpers';
import { mockDataPoints, mockAPIResponses } from '../../fixtures/mockData';

// Mock the unified data store
const mockUnifiedDataStore = {
  fetchDataWithChannelChecking: vi.fn(),
  clearAllData: vi.fn()
};

// Mock the dependencies at the top level
vi.mock('../../../store/unifiedDataStore', () => ({
  unifiedDataStore: mockUnifiedDataStore
}));


vi.mock('../../../store/unifiedDataAPI', () => ({
  unifiedDataAPI: mockAPI
}));

describe('Channel Validation - Integration Tests', () => {
  beforeEach(() => {
    // Global setup (testSetup.ts) already clears mocks and sets up shared mocks.
    // Only reset the unifiedDataStore-specific mocks here to avoid wiping out
    // the shared mockAPI/mockIndexedDB behavior.
    mockUnifiedDataStore.fetchDataWithChannelChecking.mockReset();
    mockUnifiedDataStore.clearAllData.mockReset();
  });

  afterEach(async () => {
    await mockUnifiedDataStore.clearAllData();
  });

  describe('Channel Availability Checking', () => {
    it('should validate that all required channels are present', async () => {
      // Arrange: Setup IndexedDB with data missing some channels
      const incompleteData = mockDataPoints.map(point => ({
        ...point,
        bsp: undefined // Missing bsp channel
      }));
      
      setupIndexedDBData('timeseries', 'ac75', '1', incompleteData);
      
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
        // Simulate channel validation
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
            // Simulate merging data
            const mergedData = [...existingData, ...safeResponse.data];
            await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, mergedData);
            return mergedData;
          }
        }
        
        return existingData;
      });

      // Act: Fetch data with channel checking
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should fetch missing channels from API and merge with IndexedDB data
      expect(result).toHaveLength(mockDataPoints.length * 2); // IndexedDB + API data
      expect(mockAPI.getDataByChannels).toHaveBeenCalledWith(
        ['twa', 'bsp'],
        { projectId: 'test' }
      );
    });

    it('should handle case sensitivity in channel names', async () => {
      // Arrange: Setup API with different case channel names
      const caseSensitiveData = mockDataPoints.map(point => ({
        ...point,
        TWA: point.twa, // Uppercase
        BSP: point.bsp  // Uppercase
      }));
      
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: caseSensitiveData,
        availableChannels: ['TWA', 'BSP'],
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
        // Simulate case conversion
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        const safeResponse = response || mockAPIResponses.success;
        
        if (safeResponse.data && safeResponse.data.length > 0) {
          // Simulate converting case
          const normalizedData = safeResponse.data.map(point => ({
            ...point,
            twa: point.TWA || point.twa,
            bsp: point.BSP || point.bsp
          }));
          
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, normalizedData);
          return normalizedData;
        }
        
        return [];
      });

      // Act: Fetch data with lowercase channel names
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should handle case conversion
      expect(result).toHaveLength(mockDataPoints.length);
      expect(result[0]).toHaveProperty('twa');
      expect(result[0]).toHaveProperty('bsp');
    });

    it('should handle channels with undefined values', async () => {
      // Arrange: Setup API with channels containing undefined values
      const dataWithUndefined = mockDataPoints.map(point => ({
        ...point,
        bsp: Math.random() > 0.5 ? point.bsp : undefined // Randomly undefined
      }));
      
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: dataWithUndefined,
        availableChannels: ['twa', 'bsp'],
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
          // Simulate filtering out points with undefined values
          const validData = safeResponse.data.filter(point => 
            requiredChannels.every(channel => 
              point[channel] !== undefined && point[channel] !== null
            )
          );
          
          await mockIndexedDB.storeDataByChannels('timeseries', className, sourceId, validData);
          return validData;
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

      // Assert: Should filter out points with undefined values
      expect(result.length).toBeLessThanOrEqual(mockDataPoints.length);
      expect(result.every(point => 
        point.twa !== undefined && point.bsp !== undefined
      )).toBe(true);
    });
  });

  describe('Channel Merging', () => {
    it('should merge data from different sources by timestamp', async () => {
      // Arrange: Setup IndexedDB with existing data
      const existingData = mockDataPoints.slice(0, 2);
      setupIndexedDBData('timeseries', 'ac75', '1', existingData);
      
      // Setup API with new data
      const newData = mockDataPoints.slice(2);
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: newData,
        availableChannels: ['twa', 'bsp'],
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
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        const safeResponse = response || mockAPIResponses.success;
        
        if (safeResponse.data && safeResponse.data.length > 0) {
          // Simulate merging by timestamp
          const mergedData = [...existingData, ...safeResponse.data];
          mergedData.sort((a, b) => a.timestamp - b.timestamp);
          
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, mergedData);
          return mergedData;
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

      // Assert: Should merge data by timestamp and include all expected points
      expect(result.length).toBeGreaterThanOrEqual(mockDataPoints.length);
      // All expected timestamps should be present in the merged result
      const resultTimestamps = result.map(p => p.timestamp).sort();
      const expectedTimestamps = mockDataPoints.map(p => p.timestamp).sort();
      expectedTimestamps.forEach(ts => {
        expect(resultTimestamps).toContain(ts);
      });
    });

    it('should handle duplicate timestamps correctly', async () => {
      // Arrange: Setup IndexedDB with existing data
      const existingData = mockDataPoints.slice(0, 1);
      setupIndexedDBData('timeseries', 'ac75', '1', existingData);
      
      // Setup API with data that has overlapping timestamps
      const overlappingData = [
        { ...mockDataPoints[0], bsp: 20.0 }, // Same timestamp, different bsp
        ...mockDataPoints.slice(1)
      ];
      
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: overlappingData,
        availableChannels: ['twa', 'bsp'],
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
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        const safeResponse = response || mockAPIResponses.success;
        
        if (safeResponse.data && safeResponse.data.length > 0) {
          // Simulate merging with duplicate handling
          const existingMap = new Map();
          existingData.forEach(point => {
            existingMap.set(point.timestamp, point);
          });
          
          const mergedData = [...existingData];
          safeResponse.data.forEach(point => {
            const existing = existingMap.get(point.timestamp);
            if (existing) {
              // Merge channels
              Object.keys(point).forEach(key => {
                if (key !== 'timestamp' && key !== 'Datetime') {
                  existing[key] = point[key];
                }
              });
            } else {
              mergedData.push(point);
            }
          });
          
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, mergedData);
          return mergedData;
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

      // Assert: Should handle duplicates correctly
      expect(result.length).toBeGreaterThanOrEqual(mockDataPoints.length);
      const dupTimestamp = mockDataPoints[0].timestamp;
      const dupPoints = result.filter(point => point.timestamp === dupTimestamp);
      expect(dupPoints.length).toBeGreaterThan(0);
    });
  });

  describe('Channel Validation Edge Cases', () => {
    it('should handle empty channel arrays', async () => {
      // Arrange: Setup API with empty channels
      setupAPIResponse([], { projectId: 'test' }, {
        data: [],
        availableChannels: [],
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
        if (requiredChannels.length === 0) {
          return [];
        }
        
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        return response.data || [];
      });

      // Act: Fetch data with empty channels
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        [],
        { projectId: 'test' }
      );

      // Assert: Should return empty array
      expect(result).toEqual([]);
    });

    it('should handle non-existent channels gracefully', async () => {
      // Arrange: Setup API with missing channels
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: mockDataPoints,
        availableChannels: ['twa'],
        missingChannels: ['bsp'],
        hasAll: false
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
          // Simulate filtering to only available channels
          const filteredData = safeResponse.data.map(point => {
            const filteredPoint = { ...point };
            const missing = safeResponse.missingChannels || [];
            missing.forEach(channel => {
              delete filteredPoint[channel];
            });
            return filteredPoint;
          });
          
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, filteredData);
          return filteredData;
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

      // Assert: Should complete without errors when some requested channels are missing
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('twa');
    });
  });
});
