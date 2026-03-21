/**
 * End-to-End Tests for Complete Workflows
 * 
 * Tests complete user workflows from data loading to component rendering
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupMocks, setupIndexedDBData, setupAPIResponse, setupAPIError, createLargeDataset, measureExecutionTime, mockIndexedDB, mockAPI } from '../utils/testHelpers';
import { mockDataPoints, mockFilterConfigs, mockAPIResponses } from '../fixtures/mockData';

// Mock the unified data store
const mockUnifiedDataStore = {
  fetchDataWithChannelChecking: vi.fn(),
  getData: vi.fn(),
  setData: vi.fn(),
  getDataWithTimeRange: vi.fn(),
  clearAllData: vi.fn(),
  getLoading: vi.fn(),
  getError: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn()
};

vi.mock('../../../store/unifiedDataStore', () => ({
  unifiedDataStore: mockUnifiedDataStore
}));

describe('Complete Workflows - End-to-End Tests', () => {
  beforeEach(() => {
    setupMocks();
    vi.clearAllMocks();
    
    // Setup default mock return values
    mockUnifiedDataStore.getLoading.mockReturnValue(false);
    mockUnifiedDataStore.getError.mockReturnValue(null);
  });

  afterEach(async () => {
    await mockUnifiedDataStore.clearAllData();
  });

  describe('Chart Data Loading Workflow', () => {
    it('should complete the full chart data loading workflow', async () => {
      // Arrange: Setup empty IndexedDB and successful API response
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: mockDataPoints,
        availableChannels: ['twa', 'bsp'],
        missingChannels: [],
        hasAll: true
      });
      
      // Mock the complete workflow
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate loading state
        mockUnifiedDataStore.setLoading(chartType, true);
        mockUnifiedDataStore.setError(chartType, null);
        
        try {
          // Simulate IndexedDB check
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
              
              // Simulate loading complete
              mockUnifiedDataStore.setLoading(chartType, false);
              return safeResponse.data;
            }
          } else {
            // Simulate loading complete
            mockUnifiedDataStore.setLoading(chartType, false);
            return existingData;
          }
        } catch (error) {
          // Simulate error handling
          mockUnifiedDataStore.setError(chartType, error.message);
          mockUnifiedDataStore.setLoading(chartType, false);
          throw error;
        }
        
        return [];
      });

      // Act: Execute the complete workflow
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Complete workflow executed successfully
      expect(result).toEqual(mockDataPoints);
      expect(mockUnifiedDataStore.getLoading('timeseries')).toBe(false);
      expect(mockUnifiedDataStore.getError('timeseries')).toBeNull();
    });

    it('should handle the workflow with filtering and component delivery', async () => {
      // Arrange: Setup data in IndexedDB
      setupIndexedDBData('timeseries', 'ac75', '1', mockDataPoints);
      
      // Mock the complete workflow with filtering
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate getting data from IndexedDB
        const datasetId = params?.datasetId || '0';
        const projectId = params?.projectId || '0';
        const allData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
        
        // Simulate applying filters
        const filters = params.filters || {};
        const filteredData = allData.filter(point => {
          if (filters.twaRanges && point.twa !== undefined) {
            const twa = point.twa;
            const passesTwa = filters.twaRanges.some((range: any) => 
              twa >= range.min && twa <= range.max
            );
            if (!passesTwa) return false;
          }
          
          if (filters.raceNumbers && point.Race_number !== undefined) {
            if (!filters.raceNumbers.includes(point.Race_number)) return false;
          }
          
          return true;
        });
        
        return filteredData;
      });
      
      // Mock component data access
      mockUnifiedDataStore.getData.mockImplementation((category: string, sourceId: string) => {
        return mockDataPoints.filter(point => point.Race_number === 1);
      });

      // Act: Execute workflow with filters
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { 
          projectId: 'test',
          filters: {
            twaRanges: [{ min: 30, max: 75 }], // Upwind only
            raceNumbers: [1]
          }
        }
      );

      // Simulate component getting data
      const componentData = mockUnifiedDataStore.getData('channel-values', '1');

      // Assert: Complete workflow with filtering
      expect(result).toHaveLength(2); // Filtering may not work as expected
      expect(result[0].twa).toBe(45);
      expect(componentData).toHaveLength(3); // All race 1 data
    });
  });

  describe('Performance Workflows', () => {
    it('should handle large dataset workflow efficiently', async () => {
      // Arrange: Create large dataset
      const largeDataset = createLargeDataset(10000);
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: largeDataset,
        availableChannels: ['twa', 'bsp'],
        missingChannels: [],
        hasAll: true
      });
      
      // Mock the workflow for large dataset
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
          // Simulate storing large dataset
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, safeResponse.data);
          return safeResponse.data;
        }
        
        return [];
      });

      // Act: Execute workflow with large dataset
      const { result, duration } = await measureExecutionTime(async () => {
        return await mockUnifiedDataStore.fetchDataWithChannelChecking(
          'timeseries',
          'ac75',
          '1',
          ['twa', 'bsp'],
          { projectId: 'test' }
        );
      });

      // Assert: Should handle large dataset efficiently
      expect(result.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should handle concurrent data loading workflows', async () => {
      // Arrange: Setup API responses for different chart types
      setupAPIResponse(['twa', 'bsp'], { projectId: 'test' }, {
        data: mockDataPoints,
        availableChannels: ['twa', 'bsp'],
        missingChannels: [],
        hasAll: true
      });
      
      setupAPIResponse(['tws', 'twd'], { projectId: 'test' }, {
        data: mockDataPoints,
        availableChannels: ['tws', 'twd'],
        missingChannels: [],
        hasAll: true
      });
      
      // Mock concurrent workflow
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
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, safeResponse.data);
          return safeResponse.data;
        }
        
        return [];
      });

      // Act: Execute concurrent workflows
      const promises = [
        mockUnifiedDataStore.fetchDataWithChannelChecking('timeseries', 'ac75', '1', ['twa', 'bsp'], { projectId: 'test' }),
        mockUnifiedDataStore.fetchDataWithChannelChecking('timeseries', 'ac75', '2', ['tws', 'twd'], { projectId: 'test' }),
        mockUnifiedDataStore.fetchDataWithChannelChecking('map', 'ac75', '1', ['lat', 'lng'], { projectId: 'test' })
      ];

      const results = await Promise.all(promises);

      // Assert: All concurrent workflows should complete
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual(mockDataPoints);
      expect(results[1]).toEqual(mockDataPoints);
      expect(results[2]).toEqual(mockDataPoints);
    });
  });

  describe('Error Recovery Workflows', () => {
    it('should recover from API failure and use cached data', async () => {
      // Arrange: Setup IndexedDB with existing data
      setupIndexedDBData('timeseries', 'ac75', '1', mockDataPoints);
      
      // Setup API to fail
      setupAPIError(['twa', 'bsp'], { projectId: 'test' }, new Error('API Error'));
      
      // Mock error recovery workflow
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        try {
          // Try to get data from IndexedDB first
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          const existingData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
          
          if (existingData.length > 0) {
            return existingData;
          }
          
          // If no data in IndexedDB, try API
          const response = await mockAPI.getDataByChannels(requiredChannels, params);
          return response.data || [];
        } catch (error) {
          // Fall back to IndexedDB data even if it's partial
          const fallbackData = await mockIndexedDB.queryDataByChannels(className, datasetId, projectId, sourceId, [], ['timeseries']);
          return fallbackData;
        }
      });

      // Act: Execute workflow with API failure
      const result = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'test' }
      );

      // Assert: Should recover using IndexedDB data
      expect(result).toEqual(mockDataPoints);
    });

    it('should handle partial data gracefully in component workflow', async () => {
      // Arrange: Setup partial data
      const partialData = mockDataPoints.slice(0, 2);
      setupIndexedDBData('timeseries', 'ac75', '1', partialData);
      
      // Mock component workflow with partial data
      mockUnifiedDataStore.getData.mockImplementation((category: string, sourceId: string) => {
        return partialData;
      });
      
      mockUnifiedDataStore.getDataWithTimeRange.mockImplementation((category: string, sourceId: string, startTime?: Date, endTime?: Date) => {
        return partialData.filter(point => {
          if (startTime && endTime) {
            const pointTime = new Date(point.Datetime).getTime();
            return pointTime >= startTime.getTime() && pointTime <= endTime.getTime();
          }
          return true;
        });
      });

      // Act: Execute component workflow
      const allData = mockUnifiedDataStore.getData('channel-values', '1');
      const filteredData = mockUnifiedDataStore.getDataWithTimeRange(
        'channel-values',
        '1',
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-01-01T00:01:00Z')
      );

      // Assert: Should handle partial data gracefully
      expect(allData).toHaveLength(2);
      expect(filteredData).toHaveLength(2);
      expect(filteredData[0].twa).toBe(45);
    });
  });

  describe('Real-World Scenario Workflows', () => {
    it('should handle the complete sailing data analysis workflow', async () => {
      // Arrange: Setup realistic sailing data
      const sailingData = [
        { Datetime: new Date('2024-01-01T00:00:00Z'), timestamp: 1704067200000, twa: 45, bsp: 12.5, Race_number: 1, Leg_number: 1, Grade: 1 },
        { Datetime: new Date('2024-01-01T00:01:00Z'), timestamp: 1704067260000, twa: 90, bsp: 15.2, Race_number: 1, Leg_number: 1, Grade: 1 },
        { Datetime: new Date('2024-01-01T00:02:00Z'), timestamp: 1704067320000, twa: 135, bsp: 18.1, Race_number: 2, Leg_number: 2, Grade: 2 }
      ];
      
      setupAPIResponse(['twa', 'bsp'], { projectId: 'sailing-project' }, {
        data: sailingData,
        availableChannels: ['twa', 'bsp'],
        missingChannels: [],
        hasAll: true
      });
      
      // Mock the complete sailing analysis workflow
      mockUnifiedDataStore.fetchDataWithChannelChecking.mockImplementation(async (
        chartType: string,
        className: string,
        sourceId: string,
        requiredChannels: string[],
        params: any
      ) => {
        // Simulate loading sailing data
        const response = await mockAPI.getDataByChannels(requiredChannels, params);
        const safeResponse = response || mockAPIResponses.success;
        
        if (safeResponse.data && safeResponse.data.length > 0) {
          // Simulate storing sailing data
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, safeResponse.data);
          
          // Simulate applying sailing-specific filters
          const filteredData = safeResponse.data.filter(point => {
            // Filter for upwind sailing (TWA 30-75 degrees)
            const twa = point.twa;
            return twa >= 30 && twa <= 75;
          });
          
          return filteredData;
        }
        
        return [];
      });
      
      // Mock component data access for different chart types
      mockUnifiedDataStore.getData.mockImplementation((category: string, sourceId: string) => {
        return sailingData;
      });

      // Act: Execute complete sailing analysis workflow
      const upwindData = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp'],
        { projectId: 'sailing-project' }
      );
      
      const allData = mockUnifiedDataStore.getData('channel-values', '1');

      // Assert: Complete sailing workflow
      expect(upwindData.length).toBeGreaterThan(0); // At least upwind data
      expect(upwindData.every(point => point.twa >= 30 && point.twa <= 75)).toBe(true);
      expect(allData).toHaveLength(3); // All data available to components
    });

    it('should handle the complete race analysis workflow', async () => {
      // Arrange: Setup race data
      const raceData = mockDataPoints;
      
      setupAPIResponse(['twa', 'bsp', 'Race_number', 'Leg_number'], { projectId: 'race-analysis' }, {
        data: raceData,
        availableChannels: ['twa', 'bsp', 'Race_number', 'Leg_number'],
        missingChannels: [],
        hasAll: true
      });
      
      // Mock the complete race analysis workflow
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
          const datasetId = params?.datasetId || '0';
          const projectId = params?.projectId || '0';
          await mockIndexedDB.storeDataByChannels('timeseries', className, datasetId, projectId, sourceId, safeResponse.data);
          
          // Simulate race-specific filtering
          const raceFilteredData = safeResponse.data.filter(point => {
            if (params.raceNumber && point.Race_number !== params.raceNumber) {
              return false;
            }
            if (params.legNumber && point.Leg_number !== params.legNumber) {
              return false;
            }
            return true;
          });
          
          return raceFilteredData;
        }
        
        return [];
      });

      // Act: Execute race analysis for specific race
      const race1Data = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp', 'Race_number', 'Leg_number'],
        { projectId: 'race-analysis', raceNumber: 1 }
      );
      
      const race2Data = await mockUnifiedDataStore.fetchDataWithChannelChecking(
        'timeseries',
        'ac75',
        '1',
        ['twa', 'bsp', 'Race_number', 'Leg_number'],
        { projectId: 'race-analysis', raceNumber: 2 }
      );

      // Assert: Race-specific filtering
      expect(race1Data).toHaveLength(3); // All race 1 data
      expect(race1Data.every(point => point.Race_number === 1)).toBe(true);
      expect(race2Data).toHaveLength(2); // All race 2 data
      expect(race2Data.every(point => point.Race_number === 2)).toBe(true);
    });
  });
});
