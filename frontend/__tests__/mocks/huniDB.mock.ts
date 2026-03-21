/**
 * HuniDB Mock for Testing
 * 
 * Provides a mock implementation of HuniDBStore operations
 * that can be used in unit and integration tests
 */

import { vi } from 'vitest';
import type { MultiChannelResult, TimeSeriesFilters } from '@store/huniDBTypes';

export class MockHuniDBStore {
  private data: Map<string, any[]> = new Map();
  private channels: Map<string, string[]> = new Map();

  // Mock function declarations - initialized in constructor and reset in clear()
  storeDataByChannels: any;
  queryDataByChannels: any;
  getAvailableChannels: any;
  getStorageInfo: any;
  clearAllData: any;
  storeObject: any;
  getObject: any;
  deleteObject: any;
  listObjects: any;

  constructor() {
    this.initializeMocks();
  }

  private extractChannelsFromData(data: any[]): string[] {
    if (!data || data.length === 0) return [];
    
    const channelSet = new Set<string>();
    data.forEach(point => {
      Object.keys(point).forEach(key => {
        // Exclude metadata fields
        if (key !== 'timestamp' && key !== 'Datetime' && 
            key !== 'Race_number' && key !== 'Leg_number' && 
            key !== 'Grade' && key !== 'source_id' && key !== 'source_name') {
          channelSet.add(key);
        }
      });
    });
    
    return Array.from(channelSet).sort();
  }

  private passesFilters(dataPoint: any, filters?: TimeSeriesFilters): boolean {
    if (!filters) return true;
    
    // Simple filter implementation for testing
    if (filters.twaRanges && dataPoint.twa !== undefined) {
      const twa = dataPoint.twa;
      const passesTwa = filters.twaRanges.some((range: any) => 
        twa >= range.min && twa <= range.max
      );
      if (!passesTwa) return false;
    }
    
    if (filters.raceNumbers && dataPoint.Race_number !== undefined) {
      if (!filters.raceNumbers.includes(dataPoint.Race_number)) {
        return false;
      }
    }
    
    if (filters.legNumbers && dataPoint.Leg_number !== undefined) {
      if (!filters.legNumbers.includes(dataPoint.Leg_number)) {
        return false;
      }
    }
    
    if (filters.grades && dataPoint.Grade !== undefined) {
      if (!filters.grades.includes(dataPoint.Grade)) {
        return false;
      }
    }
    
    return true;
  }

  // Helper methods for test setup
  setData(key: string, data: any[]): void {
    this.data.set(key, data);
    const channels = this.extractChannelsFromData(data);
    this.channels.set(key, channels);
  }

  getData(key: string): any[] {
    return this.data.get(key) || [];
  }

  hasData(key: string): boolean {
    return this.data.has(key);
  }

  clear(): void {
    this.data.clear();
    this.channels.clear();
    
    // Re-initialize the mock functions to ensure clean state
    this.initializeMocks();
  }

  /**
   * Initialize mock functions with fresh implementations.
   * HuniDB no longer caches timeseries/mapdata/aggregates - only metadata/settings.
   * Data-cache methods are no-ops: store does nothing, query returns [].
   */
  private initializeMocks(): void {
    this.storeDataByChannels = vi.fn().mockImplementation(async (
      _dataType: 'mapdata' | 'timeseries' | 'aggregates',
      _className: string,
      _datasetId: number | string,
      _projectId: number | string,
      _sourceId: number | string,
      _data: any[],
      _channelMetadata?: Array<{name: string, type: string}> | string[],
      _context?: string
    ): Promise<void> => {
      // No-op: HuniDB does not cache timeseries, mapdata, or aggregates
    });

    this.queryDataByChannels = vi.fn().mockImplementation(async (
      _className: string,
      _datasetId: number | string,
      _projectId: number | string,
      _sourceId: number | string,
      _requestedChannels: string[],
      _dataTypes: ('mapdata' | 'timeseries' | 'aggregates')[] = ['timeseries'],
      _timeRange?: { start: number; end: number },
      _filters?: TimeSeriesFilters
    ): Promise<MultiChannelResult[]> => {
      // No-op: HuniDB does not cache timeseries, mapdata, or aggregates; always return empty
      return [];
    });

    this.getAvailableChannels = vi.fn().mockImplementation(async (
      _className: string,
      _datasetId: number | string,
      _projectId: number | string,
      _sourceId: number | string,
      _dataTypes: ('mapdata' | 'timeseries' | 'aggregates')[] = ['timeseries']
    ): Promise<string[]> => {
      // No-op: no data cache in HuniDB for ts/map/agg
      return [];
    });

    this.getStorageInfo = vi.fn().mockImplementation(async (): Promise<{ channelCount: number; simpleObjectCount: number; totalSize: number }> => {
      const channelKeys = Array.from(this.data.keys()).filter(key => !key.startsWith('object_'));
      const objectKeys = Array.from(this.data.keys()).filter(key => key.startsWith('object_'));
      
      return {
        channelCount: channelKeys.length,
        simpleObjectCount: objectKeys.length,
        totalSize: 0
      };
    });

    this.clearAllData = vi.fn().mockImplementation(async (): Promise<void> => {
      this.data.clear();
      this.channels.clear();
    });

    this.storeObject = vi.fn().mockImplementation(async (objectName: string, data: any): Promise<void> => {
      this.data.set(`object_${objectName}`, data);
    });

    this.getObject = vi.fn().mockImplementation(async (objectName: string): Promise<any | null> => {
      return this.data.get(`object_${objectName}`) || null;
    });

    this.deleteObject = vi.fn().mockImplementation(async (objectName: string): Promise<void> => {
      this.data.delete(`object_${objectName}`);
    });

    this.listObjects = vi.fn().mockImplementation(async (): Promise<string[]> => {
      return Array.from(this.data.keys())
        .filter(key => key.startsWith('object_'))
        .map(key => key.replace('object_', ''));
    });
  }
}

export const mockHuniDBStore = new MockHuniDBStore();

