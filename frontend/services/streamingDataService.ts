import { apiEndpoints } from '@config/env';
import { getData } from '../utils/global';
import { debug, warn, error } from '../utils/console';
import { sourcesStore } from '../store/sourcesStore';

export interface RedisDataPoint {
  timestamp: number;
  value: any;
}

export interface MergedDataPoint {
  timestamp: number;
  Datetime: Date | string; // Date object (preferred) or ISO string (for compatibility)
  source_id: number;
  source_name?: string;
  lat?: number;
  lng?: number;
  hdg?: number;
  cog?: number;
  sog?: number;
  [key: string]: any; // Other channel values
}

/**
 * Service for fetching historical data from Redis
 */
class StreamingDataService {
  /**
   * Fetch data for a specific source and channel
   * Accepts either source_id (number) or source_name (string)
   */
  async fetchChannelData(
    sourceIdOrName: number | string,
    channel: string,
    startTime?: number,
    endTime?: number
  ): Promise<RedisDataPoint[]> {
    try {
      // Convert source_id to source_name if needed
      let sourceName: string;
      if (typeof sourceIdOrName === 'number') {
        const mappedName = sourcesStore.getSourceName(sourceIdOrName);
        if (!mappedName) {
          warn(`[StreamingDataService] Could not map source_id ${sourceIdOrName} to source_name, using as string`);
          sourceName = String(sourceIdOrName);
        } else {
          sourceName = mappedName;
        }
      } else {
        sourceName = sourceIdOrName;
      }

      const url = apiEndpoints.stream.sourceData(sourceName);
      const params = new URLSearchParams();
      params.set('channel', channel);
      if (startTime) {
        params.set('startTime', startTime.toString());
      }
      if (endTime) {
        params.set('endTime', endTime.toString());
      }

      const fullUrl = `${url}?${params.toString()}`;
      const response = await getData(fullUrl);
      
      // For streaming endpoints, network failures and empty data are expected
      // Use debug level since this is normal behavior (not an error)
      if (!response.success) {
        debug(`[StreamingDataService] No data available for channel ${channel} on source ${sourceName} (expected when Redis has no data)`);
      }
      
      if (response.success && response.data && Array.isArray(response.data.data)) {
        return response.data.data;
      }

      // Empty data is normal - return empty array silently
      return [];
    } catch (err) {
      // Network errors for streaming endpoints are expected - log as warning, not error
      warn(`[StreamingDataService] Network error fetching channel ${channel} for source ${sourceIdOrName} (expected when Redis unavailable)`);
      return [];
    }
  }

  /**
   * Fetch multiple channels for a source and merge into unified data points
   * Accepts either source_id (number) or source_name (string)
   */
  async fetchMergedData(
    sourceIdOrName: number | string,
    channels: string[],
    startTime?: number,
    endTime?: number
  ): Promise<MergedDataPoint[]> {
    try {
      // Convert source_id to source_name if needed, and get source_id for the result
      let sourceName: string;
      let sourceId: number;
      
      if (typeof sourceIdOrName === 'number') {
        sourceId = sourceIdOrName;
        const mappedName = sourcesStore.getSourceName(sourceId);
        if (!mappedName) {
          warn(`[StreamingDataService] Could not map source_id ${sourceId} to source_name, using as string`);
          sourceName = String(sourceId);
        } else {
          sourceName = mappedName;
        }
      } else {
        sourceName = sourceIdOrName;
        const mappedId = sourcesStore.getSourceId(sourceName);
        if (!mappedId) {
          warn(`[StreamingDataService] Could not map source_name ${sourceName} to source_id, using 0`);
          sourceId = 0;
        } else {
          sourceId = mappedId;
        }
      }

      // Fetch all channels in parallel
      const channelPromises = channels.map(channel =>
        this.fetchChannelData(sourceName, channel, startTime, endTime)
      );

      const channelDataArrays = await Promise.all(channelPromises);

      // Don't log warnings for empty data - it's normal when there's no data in Redis
      const totalChannelPoints = channelDataArrays.reduce((sum, arr) => sum + arr.length, 0);
      // Removed warning - empty data is expected when Redis has no data

      // Create a map of timestamp -> data point
      const pointsMap = new Map<number, MergedDataPoint>();

      // Merge all channel data by timestamp
      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];
        const dataPoints = channelDataArrays[i];

        for (const point of dataPoints) {
          const timestamp = point.timestamp;
          
          if (!pointsMap.has(timestamp)) {
            pointsMap.set(timestamp, {
              timestamp,
              Datetime: new Date(timestamp), // Store as Date object, not ISO string (for compatibility with fleetmap)
              source_id: sourceId,
              source_name: sourceName
            });
          }

          const mergedPoint = pointsMap.get(timestamp)!;
          mergedPoint[channel] = point.value;
        }
      }

      // Convert map to array and sort by timestamp (CRITICAL: sort before returning)
      const mergedPoints = Array.from(pointsMap.values()).sort((a, b) => a.timestamp - b.timestamp);

      // Only log if merge resulted in unexpected results
      if (mergedPoints.length === 0 && totalChannelPoints > 0) {
        warn(`[StreamingDataService] Merged ${channels.length} channels but got 0 data points for source ${sourceName}`, {
          totalChannelPoints,
          channels
        });
      }
      
      return mergedPoints;
    } catch (err) {
      // Network errors for streaming endpoints are expected - log as warning, not error
      warn(`[StreamingDataService] Network error fetching merged data for source ${sourceIdOrName} (expected when Redis unavailable)`);
      return [];
    }
  }

  /**
   * Fetch map navigation data (lat, lng, hdg, cog, sog, source_name) for a source
   */
  async fetchMapData(
    source_id: number,
    startTime?: number,
    endTime?: number
  ): Promise<MergedDataPoint[]> {
    const channels = ['lat', 'lng', 'hdg', 'cog', 'sog', 'source_name'];
    return this.fetchMergedData(source_id, channels, startTime, endTime);
  }

  /**
   * Fetch available channels for a source
   * Accepts either source_id (number) or source_name (string)
   */
  async getAvailableChannels(sourceIdOrName: number | string): Promise<string[]> {
    try {
      // Convert source_id to source_name if needed
      let sourceName: string;
      if (typeof sourceIdOrName === 'number') {
        const mappedName = sourcesStore.getSourceName(sourceIdOrName);
        if (!mappedName) {
          warn(`[StreamingDataService] Could not map source_id ${sourceIdOrName} to source_name, using as string`);
          sourceName = String(sourceIdOrName);
        } else {
          sourceName = mappedName;
        }
      } else {
        sourceName = sourceIdOrName;
      }

      const url = apiEndpoints.stream.sourceChannels(sourceName);
      const response = await getData(url);
      
      if (response.success && response.data && Array.isArray(response.data.channels)) {
        return response.data.channels;
      }

      return [];
    } catch (err) {
      // Network errors for streaming endpoints are expected - log as warning, not error
      warn(`[StreamingDataService] Network error fetching channels for source ${sourceIdOrName} (expected when Redis unavailable)`);
      return [];
    }
  }

  /**
   * Fetch data for multiple sources in parallel
   * Accepts either source_ids (number[]) or source_names (string[])
   */
  async fetchMultipleSources(
    sourceIdsOrNames: number[] | string[],
    channels: string[],
    startTime?: number,
    endTime?: number
  ): Promise<Map<number, MergedDataPoint[]>> {
    const results = new Map<number, MergedDataPoint[]>();

    // Fetch all sources in parallel
    const promises = sourceIdsOrNames.map(async (sourceIdOrName) => {
      const data = await this.fetchMergedData(sourceIdOrName, channels, startTime, endTime);
      // Extract source_id from the first data point (if available) or map from source_name
      let sourceId: number;
      if (typeof sourceIdOrName === 'number') {
        sourceId = sourceIdOrName;
      } else {
        const mappedId = sourcesStore.getSourceId(sourceIdOrName);
        sourceId = mappedId || 0; // Fallback to 0 if mapping fails
      }
      return { sourceId, data };
    });

    const resultsArray = await Promise.all(promises);

    for (const { sourceId, data } of resultsArray) {
      results.set(sourceId, data);
    }

    return results;
  }
}

// Singleton instance
export const streamingDataService = new StreamingDataService();

