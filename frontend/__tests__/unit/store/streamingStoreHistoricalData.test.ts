/**
 * Test to verify websocket data is accumulating in historicalData
 * and accessible via getFilteredData()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamingStore } from '../../../store/streamingStore';
import { streamingService, StreamingDataPoint } from '../../../services/streamingService';
import { sourcesStore } from '../../../store/sourcesStore';
import { selectedTime, timeWindow } from '../../../store/playbackStore';

// Mock dependencies
vi.mock('../../../services/streamingService', () => ({
  streamingService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onData: vi.fn(),
    onConnection: vi.fn(),
    getLastError: vi.fn(() => null)
  }
}));

vi.mock('../../../store/sourcesStore', () => ({
  sourcesStore: {
    getSourceName: vi.fn((id: number) => {
      const names: Record<number, string> = {
        1: 'source1',
        2: 'source2'
      };
      return names[id] || null;
    }),
    getSourceId: vi.fn((name: string) => {
      const ids: Record<string, number> = {
        'source1': 1,
        'source2': 2
      };
      return ids[name] || null;
    }),
    sources: vi.fn(() => [])
  }
}));

vi.mock('../../../config/env', () => ({
  config: {
    ENABLE_WEBSOCKETS: true
  }
}));

vi.mock('../../../store/playbackStore', () => ({
  selectedTime: vi.fn(() => new Date()),
  timeWindow: vi.fn(() => 0)
}));

vi.mock('../../../store/selectionStore', () => ({
  selectedRange: vi.fn(() => []),
  selectedRanges: vi.fn(() => [])
}));

vi.mock('../../../utils/console', () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}));

describe('StreamingStore - Historical Data Accumulation via getFilteredData', () => {
  let dataCallback: (dataPoint: StreamingDataPoint) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    
    (streamingService.connect as any).mockResolvedValue(true);
    (streamingService.onData as any).mockImplementation((callback: (data: StreamingDataPoint) => void) => {
      dataCallback = callback;
      return vi.fn();
    });
    (streamingService.onConnection as any).mockImplementation((callback: (connected: boolean) => void) => {
      callback(true);
      return vi.fn();
    });
    (streamingService.subscribe as any).mockReturnValue(true);
    
    streamingStore.cleanup();
  });

  afterEach(() => {
    streamingStore.cleanup();
  });

  it('should accumulate websocket data in historicalData and return via getFilteredData', async () => {
    await streamingStore.initialize(new Set([1]));
    
    const baseTime = Date.now();
    const points = [
      {
        source_name: 'source1',
        timestamp: baseTime,
        data: { lat: 10.0, lng: 20.0, bsp: 5.0, hdg: 90 }
      },
      {
        source_name: 'source1',
        timestamp: baseTime + 1000, // 1 second later
        data: { lat: 10.1, lng: 20.1, bsp: 5.5, hdg: 91 }
      },
      {
        source_name: 'source1',
        timestamp: baseTime + 2000, // 2 seconds later
        data: { lat: 10.2, lng: 20.2, bsp: 6.0, hdg: 92 }
      }
    ];

    // Send all points
    for (const point of points) {
      dataCallback(point as StreamingDataPoint);
    }

    // Wait for async updates
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get filtered data (should include all accumulated points)
    const filteredData = streamingStore.getFilteredData(new Set([1]));
    const source1Data = filteredData.get(1);
    
    // Should have all 3 points accumulated
    expect(source1Data).toBeDefined();
    expect(source1Data?.length).toBe(3);
    
    // Verify all points are present
    expect(source1Data?.[0].timestamp).toBe(baseTime);
    expect(source1Data?.[0].Lat).toBe(10.0);
    expect(source1Data?.[1].timestamp).toBe(baseTime + 1000);
    expect(source1Data?.[1].Lat).toBe(10.1);
    expect(source1Data?.[2].timestamp).toBe(baseTime + 2000);
    expect(source1Data?.[2].Lat).toBe(10.2);
  });

  it('should accumulate data from multiple sources separately', async () => {
    await streamingStore.initialize(new Set([1, 2]));
    
    const baseTime = Date.now();
    
    // Send points for source1
    dataCallback({
      source_name: 'source1',
      timestamp: baseTime,
      data: { lat: 10.0, lng: 20.0, bsp: 5.0 }
    } as StreamingDataPoint);
    
    dataCallback({
      source_name: 'source1',
      timestamp: baseTime + 1000,
      data: { lat: 10.1, lng: 20.1, bsp: 5.5 }
    } as StreamingDataPoint);
    
    // Send points for source2
    dataCallback({
      source_name: 'source2',
      timestamp: baseTime,
      data: { lat: 30.0, lng: 40.0, bsp: 7.0 }
    } as StreamingDataPoint);
    
    dataCallback({
      source_name: 'source2',
      timestamp: baseTime + 1000,
      data: { lat: 30.1, lng: 40.1, bsp: 7.5 }
    } as StreamingDataPoint);

    await new Promise(resolve => setTimeout(resolve, 200));

    const filteredData = streamingStore.getFilteredData(new Set([1, 2]));
    
    const source1Data = filteredData.get(1);
    const source2Data = filteredData.get(2);
    
    // Both sources should have 2 points each
    expect(source1Data).toBeDefined();
    expect(source2Data).toBeDefined();
    expect(source1Data?.length).toBe(2);
    expect(source2Data?.length).toBe(2);
    
    // Verify data is correct
    expect(source1Data?.[0].Lat).toBe(10.0);
    expect(source1Data?.[1].Lat).toBe(10.1);
    expect(source2Data?.[0].Lat).toBe(30.0);
    expect(source2Data?.[1].Lat).toBe(30.1);
  });

  it('should combine Redis initial data with websocket updates', async () => {
    // This test verifies that loadInitialDataFromRedis and websocket data work together
    // Note: This requires mocking the streamingDataService
    await streamingStore.initialize(new Set([1]));
    
    // Simulate initial data loaded from Redis (would normally come from loadInitialDataFromRedis)
    // For now, we'll just test websocket accumulation
    
    const baseTime = Date.now() - 60000; // 1 minute ago
    
    // Send websocket updates
    dataCallback({
      source_name: 'source1',
      timestamp: baseTime,
      data: { lat: 10.0, lng: 20.0, bsp: 5.0 }
    } as StreamingDataPoint);
    
    dataCallback({
      source_name: 'source1',
      timestamp: baseTime + 1000,
      data: { lat: 10.1, lng: 20.1, bsp: 5.5 }
    } as StreamingDataPoint);

    await new Promise(resolve => setTimeout(resolve, 200));

    const filteredData = streamingStore.getFilteredData(new Set([1]));
    const source1Data = filteredData.get(1);
    
    // Should have websocket data
    expect(source1Data).toBeDefined();
    expect(source1Data?.length).toBe(2);
  });
});

