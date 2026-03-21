/**
 * IndexedDB Mock for Testing
 * 
 * Provides a mock implementation of IndexedDB operations
 * that can be used in unit and integration tests
 */

import { vi } from 'vitest';
import { mockDataPoints, mockChannelData } from '../fixtures/mockData';

export class MockIndexedDB {
  private data: Map<string, any> = new Map();
  private channels: Map<string, string[]> = new Map();

  // Mock function declarations - initialized in constructor and reset in clear()
  open: any;
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
        if (key !== 'timestamp') {
          channelSet.add(key);
        }
      });
    });
    
    return Array.from(channelSet).sort();
  }

  private passesFilters(dataPoint: any, filters: any): boolean {
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
   * Initialize mock functions with fresh implementations
   * This ensures clean state after clearing
   */
  private initializeMocks(): void {
    this.open = vi.fn().mockResolvedValue({});
    
    this.storeDataByChannels = vi.fn().mockImplementation(async (
      dataType: 'mapdata' | 'timeseries' | 'aggregates',
      className: string,
      datasetId: string,
      projectId: string,
      sourceId: string,
      data: any[],
      channels?: Array<{name: string, type: string}> | string[]
    ): Promise<void> => {
      const key = `${dataType}_${className}_${sourceId}`;
      this.data.set(key, data);
      
      // Handle both channel metadata objects and string arrays
      let channelsToStore: string[];
      if (channels && Array.isArray(channels) && channels.length > 0) {
        // Convert channel objects to channel names if needed
        channelsToStore = channels.map(channel => {
          if (typeof channel === 'string') {
            return channel;
          } else if (channel && typeof channel === 'object' && 'name' in channel) {
            return channel.name;
          } else {
            console.warn(`[Mock] Invalid channel format:`, channel);
            return null;
          }
        }).filter(Boolean) as string[];
      } else {
        // Extract from data if no channels provided
        channelsToStore = this.extractChannelsFromData(data);
      }
      this.channels.set(key, channelsToStore);
    });

    this.queryDataByChannels = vi.fn().mockImplementation(async (
      className: string,
      datasetId: string,
      projectId: string,
      sourceId: string,
      requestedChannels: string[],
      dataTypes: ('mapdata' | 'timeseries' | 'aggregates')[] = ['timeseries'],
      timeRange?: { start: number; end: number },
      filters?: any
    ): Promise<any[]> => {
      console.log(`[Mock] queryDataByChannels called with:`, { className, datasetId, projectId, sourceId, requestedChannels, dataTypes });
      const results: any[] = [];
      
      for (const dataType of dataTypes) {
        const key = `${dataType}_${className}_${sourceId}`;
        console.log(`[Mock] Looking for key: ${key}`);
        const data = this.data.get(key) || [];
        console.log(`[Mock] Found data:`, data.length, 'items');
        
        if (data.length === 0) continue;
        
        // Apply time range filter
        let filteredData = data;
        if (timeRange) {
          filteredData = data.filter((point: any) => {
            const pointTime = point.timestamp || new Date(point.Datetime).getTime();
            return pointTime >= timeRange.start && pointTime <= timeRange.end;
          });
        }
        
        // Apply other filters
        if (filters) {
          filteredData = filteredData.filter((point: any) => {
            return this.passesFilters(point, filters);
          });
        }
        
        // Filter by requested channels if specified
        if (requestedChannels && requestedChannels.length > 0) {
          filteredData = filteredData.map((point: any) => {
            const filteredPoint: any = {};
            // Always include timestamp and Datetime
            if (point.timestamp !== undefined) filteredPoint.timestamp = point.timestamp;
            if (point.Datetime !== undefined) filteredPoint.Datetime = point.Datetime;
            
            // Include only requested channels
            requestedChannels.forEach(channel => {
              if (point[channel] !== undefined) {
                filteredPoint[channel] = point[channel];
              }
            });
            
            return filteredPoint;
          });
        }
        
        results.push(...filteredData);
      }
      
      return results.sort((a, b) => a.timestamp - b.timestamp);
    });

    this.getAvailableChannels = vi.fn().mockImplementation(async (
      className: string,
      datasetId: string,
      projectId: string,
      sourceId: string,
      dataTypes: ('mapdata' | 'timeseries' | 'aggregates')[] = ['timeseries']
    ): Promise<string[]> => {
      const allChannels = new Set<string>();
      
      for (const dataType of dataTypes) {
        const key = `${dataType}_${className}_${sourceId}`;
        const channels = this.channels.get(key) || [];
        channels.forEach(channel => allChannels.add(channel));
      }
      
      return Array.from(allChannels).sort();
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

export const mockIndexedDB = new MockIndexedDB();
