/**
 * Integration Test: Redis → IndexedDB Storage Flow
 * 
 * Tests that Redis data flows correctly into IndexedDB with dataset_id = 0
 * 
 * This test verifies:
 * 1. fetchRedisHistoricalData fetches data from Redis
 * 2. storeRedisDataAsMapdata stores data in IndexedDB with dataset_id = 0
 * 3. Data can be queried from IndexedDB with dataset_id = 0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unifiedDataStore } from '../../../store/unifiedDataStore';
import { huniDBStore } from '../../../store/huniDBStore';
import { sourcesStore } from '../../../store/sourcesStore';
import { persistantStore } from '../../../store/persistantStore';
import { streamingDataService } from '../../../services/streamingDataService';
import { liveMode } from '../../../store/playbackStore';

// Mock dependencies - use HuniDB instead of legacy IndexedDB
import { mockHuniDBStore } from '../../mocks/huniDB.mock';

vi.mock('../../../store/huniDBStore', () => ({
  huniDBStore: mockHuniDBStore
}));


vi.mock('../../../services/streamingDataService', () => ({
  streamingDataService: {
    fetchMergedData: vi.fn()
  }
}));

vi.mock('../../../store/sourcesStore', () => ({
  sourcesStore: {
    isReady: vi.fn(() => true),
    sources: vi.fn(() => [
      { source_id: 1, source_name: 'ITA', color: '#ff0000' },
      { source_id: 2, source_name: 'FRA', color: '#00ff00' },
      { source_id: 3, source_name: 'NZL', color: '#0000ff' }
    ]),
    getSourceId: vi.fn((name: string) => {
      const map: Record<string, number> = { 'ITA': 1, 'FRA': 2, 'NZL': 3 };
      return map[name] || null;
    }),
    getSourceName: vi.fn((id: number) => {
      const map: Record<number, string> = { 1: 'ITA', 2: 'FRA', 3: 'NZL' };
      return map[id] || null;
    })
  }
}));

vi.mock('../../../store/persistantStore', () => ({
  persistantStore: {
    selectedClassName: vi.fn(() => 'ac75'),
    selectedProjectId: vi.fn(() => 1),
    selectedDatasetId: vi.fn(() => 0)
  }
}));

vi.mock('../../../store/playbackStore', () => ({
  liveMode: vi.fn(() => true)
}));

describe('Redis → IndexedDB Storage Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch Redis data and store in IndexedDB with dataset_id = 0', async () => {
    // Arrange: Mock Redis data
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    const sourceName = 'ITA';
    const sourceId = 1;

    const mockRedisData = [
      {
        timestamp: thirtyMinutesAgo + 1000,
        Datetime: new Date(thirtyMinutesAgo + 1000),
        Lat: 41.372564,
        Lng: 2.221525,
        Hdg: 180.5,
        Bsp: 15.3,
        Maneuver_type: 'sailing'
      },
      {
        timestamp: thirtyMinutesAgo + 2000,
        Datetime: new Date(thirtyMinutesAgo + 2000),
        Lat: 41.372600,
        Lng: 2.221600,
        Hdg: 181.0,
        Bsp: 15.5,
        Maneuver_type: 'sailing'
      }
    ];

    // Mock streamingDataService to return Redis data
    vi.mocked(streamingDataService.fetchMergedData).mockResolvedValue(mockRedisData);

    // Mock HuniDB storage to track calls
    const storeCalls: any[] = [];
    vi.mocked(huniDBStore.storeDataByChannels).mockImplementation(
      async (dataSource, className, datasetId, projectId, sourceId, data, channels) => {
        storeCalls.push({
          dataSource,
          className,
          datasetId,
          projectId,
          sourceId,
          dataLength: data.length,
          channels: channels.map((c: any) => c.name || c)
        });
        return Promise.resolve();
      }
    );

    // Act: Fetch Redis historical data
    await unifiedDataStore.fetchRedisHistoricalData(
      [sourceName],
      thirtyMinutesAgo,
      now
    );

    // Wait a bit for async storage to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Assert: Verify storeDataByChannels was called with correct parameters
    expect(storeCalls.length).toBeGreaterThan(0);
    
    const storeCall = storeCalls[0];
    expect(storeCall.dataSource).toBe('mapdata');
    expect(storeCall.className).toBe('ac75'); // Should be normalized to lowercase
    expect(storeCall.datasetId).toBe(0); // CRITICAL: Must be 0 (number) for Redis data
    expect(storeCall.projectId).toBe(1); // Number, not string
    expect(storeCall.sourceId).toBe(sourceId); // Number, not string
    expect(storeCall.dataLength).toBe(mockRedisData.length);
    expect(storeCall.channels).toContain('Lat');
    expect(storeCall.channels).toContain('Lng');
    expect(storeCall.channels).toContain('Hdg');
    expect(storeCall.channels).toContain('Bsp');
  });

  it('should query IndexedDB with dataset_id = 0 after storing Redis data', async () => {
    // Arrange: First store data, then query it
    const sourceName = 'ITA';
    const sourceId = 1;
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);

    const mockRedisData = [
      {
        timestamp: now - 1000,
        Datetime: new Date(now - 1000),
        Lat: 41.372564,
        Lng: 2.221525,
        Hdg: 180.5,
        Bsp: 15.3
      }
    ];

    // Track storage calls
    const storageCalls: any[] = [];
    vi.mocked(huniDBStore.storeDataByChannels).mockImplementation(
      async (dataSource, className, datasetId, projectId, sourceId, data, channels) => {
        storageCalls.push({ dataSource, className, datasetId, projectId, sourceId, dataLength: data.length });
        return Promise.resolve();
      }
    );

    // Mock streamingDataService to return Redis data
    vi.mocked(streamingDataService.fetchMergedData).mockResolvedValue(mockRedisData);

    // Step 1: Store data
    await unifiedDataStore.fetchRedisHistoricalData([sourceName], thirtyMinutesAgo, now);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify storage was called with dataset_id = 0
    expect(storageCalls.length).toBeGreaterThan(0);
    expect(storageCalls[0].datasetId).toBe(0); // Number, not string
    expect(storageCalls[0].className).toBe('ac75');

    // Step 2: Mock getAvailableChannels to return channels (data exists)
    vi.mocked(huniDBStore.getAvailableChannels).mockResolvedValue(
      ['Lat', 'Lng', 'Hdg', 'Bsp', 'timestamp', 'Datetime']
    );

    // Step 3: Mock queryDataByChannels to return stored data
    vi.mocked(huniDBStore.queryDataByChannels).mockResolvedValue(
      mockRedisData
    );

    // Act: Query data using fetchDataWithChannelChecking
    const result = await unifiedDataStore.fetchDataWithChannelChecking(
      'map',
      'ac75',
      String(sourceId),
      ['Lat', 'Lng', 'Hdg', 'Bsp'],
      {
        projectId: '1',
        className: 'ac75',
        datasetId: 0, // Query with dataset_id = 0 (number)
        sourceName: sourceName,
        applyGlobalFilters: false
      },
      'mapdata'
    );

    // Assert: Verify query was made with dataset_id = 0
    expect(huniDBStore.queryDataByChannels).toHaveBeenCalledWith(
      'ac75', // normalized className
      0, // CRITICAL: dataset_id must be 0 (number)
      1, // projectId (number)
      sourceId, // sourceId (number)
      expect.arrayContaining(['Lat', 'Lng', 'Hdg', 'Bsp']),
      ['mapdata'],
      undefined, // timeRange
      undefined // filters
    );

    expect(result).toEqual(mockRedisData);
  });

  it('should handle multiple sources correctly', async () => {
    // Arrange: Mock Redis data for multiple sources
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    const sourceNames = ['ITA', 'FRA', 'NZL'];

    const mockRedisDataMap: Record<string, any[]> = {
      'ITA': [
        { timestamp: now - 1000, Datetime: new Date(now - 1000), Lat: 41.1, Lng: 2.1, Hdg: 180, Bsp: 15 }
      ],
      'FRA': [
        { timestamp: now - 2000, Datetime: new Date(now - 2000), Lat: 41.2, Lng: 2.2, Hdg: 181, Bsp: 16 }
      ],
      'NZL': [
        { timestamp: now - 3000, Datetime: new Date(now - 3000), Lat: 41.3, Lng: 2.3, Hdg: 182, Bsp: 17 }
      ]
    };

    vi.mocked(streamingDataService.fetchMergedData).mockImplementation(
      async (sourceName: string) => mockRedisDataMap[sourceName] || []
    );

    const storeCalls: any[] = [];
    vi.mocked(huniDBStore.storeDataByChannels).mockImplementation(
      async (dataSource, className, datasetId, projectId, sourceId, data, channels) => {
        storeCalls.push({ sourceId, datasetId, dataLength: data.length });
        return Promise.resolve();
      }
    );

    // Act: Fetch data for all sources
    await unifiedDataStore.fetchRedisHistoricalData(
      sourceNames,
      thirtyMinutesAgo,
      now
    );

    await new Promise(resolve => setTimeout(resolve, 200));

    // Assert: Verify all sources were stored with dataset_id = 0
    expect(storeCalls.length).toBe(3);
    storeCalls.forEach(call => {
      expect(call.datasetId).toBe(0); // All should use dataset_id = 0 (number)
      expect(call.dataLength).toBeGreaterThan(0);
    });
  });

  it('should filter out data points without valid Datetime/timestamp', async () => {
    // Arrange: Mock Redis data with invalid points
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    const sourceName = 'ITA';

    const mockRedisDataWithInvalid = [
      {
        timestamp: thirtyMinutesAgo + 1000,
        Datetime: new Date(thirtyMinutesAgo + 1000),
        Lat: 41.372564,
        Lng: 2.221525
      },
      {
        // Invalid: no timestamp or Datetime
        Lat: 41.372600,
        Lng: 2.221600
      },
      {
        timestamp: null, // Invalid timestamp
        Datetime: null, // Invalid Datetime
        Lat: 41.372700,
        Lng: 2.221700
      },
      {
        timestamp: thirtyMinutesAgo + 2000,
        Datetime: new Date(thirtyMinutesAgo + 2000),
        Lat: 41.372800,
        Lng: 2.221800
      }
    ];

    vi.mocked(streamingDataService.fetchMergedData).mockResolvedValue(mockRedisDataWithInvalid);

    const storeCalls: any[] = [];
    vi.mocked(huniDBStore.storeDataByChannels).mockImplementation(
      async (dataSource, className, datasetId, projectId, sourceId, data, channels) => {
        storeCalls.push({ dataLength: data.length, data });
        return Promise.resolve();
      }
    );

    // Act: Fetch and store data
    await unifiedDataStore.fetchRedisHistoricalData(
      [sourceName],
      thirtyMinutesAgo,
      now
    );

    await new Promise(resolve => setTimeout(resolve, 100));

    // Assert: Only valid data points should be stored
    expect(storeCalls.length).toBeGreaterThan(0);
    const storedData = storeCalls[0].data;
    expect(storedData.length).toBe(2); // Only 2 valid points
    storedData.forEach((point: any) => {
      expect(point.timestamp || point.Datetime).toBeDefined();
      const hasValidTime = 
        (point.timestamp != null && !isNaN(Number(point.timestamp))) ||
        (point.Datetime != null && !isNaN(new Date(point.Datetime).getTime()));
      expect(hasValidTime).toBe(true);
    });
  });

  it('should ensure all stored points have Datetime field', async () => {
    // Arrange: Mock Redis data with timestamp but no Datetime
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    const sourceName = 'ITA';

    const mockRedisData = [
      {
        timestamp: thirtyMinutesAgo + 1000,
        // No Datetime field
        Lat: 41.372564,
        Lng: 2.221525
      }
    ];

    vi.mocked(streamingDataService.fetchMergedData).mockResolvedValue(mockRedisData);

    const storeCalls: any[] = [];
    vi.mocked(huniDBStore.storeDataByChannels).mockImplementation(
      async (dataSource, className, datasetId, projectId, sourceId, data, channels) => {
        storeCalls.push({ data });
        return Promise.resolve();
      }
    );

    // Act: Fetch and store data
    await unifiedDataStore.fetchRedisHistoricalData(
      [sourceName],
      thirtyMinutesAgo,
      now
    );

    await new Promise(resolve => setTimeout(resolve, 100));

    // Assert: All stored points should have Datetime field
    expect(storeCalls.length).toBeGreaterThan(0);
    const storedData = storeCalls[0].data;
    storedData.forEach((point: any) => {
      expect(point.Datetime).toBeDefined();
      // Datetime should be a valid ISO string or Date
      const datetime = point.Datetime;
      expect(
        typeof datetime === 'string' || 
        datetime instanceof Date ||
        (typeof datetime === 'object' && datetime !== null)
      ).toBe(true);
    });
  });
});

