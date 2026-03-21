/**
 * Tests for Redis Storage Operations
 * Tests read/write operations, channel management, and data retention
 * 
 * Note: These tests require a running Redis instance
 * Set REDIS_HOST and REDIS_PORT environment variables if needed
 * 
 * TODO: Convert server_stream to ES modules or use a different test approach
 * Currently skipped due to CommonJS/ESM compatibility issues
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Skip these tests for now - server_stream uses CommonJS
describe.skip('Redis Storage - Read/Write Operations', () => {
  let testRedis;
  const TEST_SOURCE_ID = 999;
  const TEST_CHANNEL = 'Lat';

  beforeEach(async () => {
    // Connect to Redis (use test database if available)
    await redisStorage.connect();
    
    // Create a test Redis client for verification
    testRedis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      db: process.env.REDIS_DB || 0
    });
    
    // Clean up test data
    const keys = await testRedis.keys(`stream:${TEST_SOURCE_ID}:*`);
    if (keys.length > 0) {
      await testRedis.del(...keys);
    }
  });

  afterEach(async () => {
    // Clean up test data
    if (testRedis) {
      const keys = await testRedis.keys(`stream:${TEST_SOURCE_ID}:*`);
      if (keys.length > 0) {
        await testRedis.del(...keys);
      }
      await testRedis.quit();
    }
  });

  describe('store() - Write Operations', () => {
    it('should store a data point correctly', async () => {
      const timestamp = Date.now();
      const value = 45.123;

      await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamp, value);

      // Verify data was stored
      const key = `stream:${TEST_SOURCE_ID}:${TEST_CHANNEL}`;
      const results = await testRedis.zrangebyscore(key, timestamp, timestamp, 'WITHSCORES');
      
      expect(results.length).toBeGreaterThan(0);
      const storedValue = JSON.parse(results[0]);
      expect(storedValue).toBe(value);
    });

    it('should store multiple data points for the same channel', async () => {
      const timestamps = [Date.now(), Date.now() + 1000, Date.now() + 2000];
      const values = [45.1, 45.2, 45.3];

      for (let i = 0; i < timestamps.length; i++) {
        await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamps[i], values[i]);
      }

      // Verify all points were stored
      const key = `stream:${TEST_SOURCE_ID}:${TEST_CHANNEL}`;
      const results = await testRedis.zrange(key, 0, -1, 'WITHSCORES');
      
      expect(results.length).toBe(timestamps.length * 2); // Each point has value and score
    });

    it('should handle different data types', async () => {
      const timestamp = Date.now();
      
      // Test number
      await redisStorage.store(TEST_SOURCE_ID, 'number', timestamp, 123);
      
      // Test string
      await redisStorage.store(TEST_SOURCE_ID, 'string', timestamp + 1, 'test');
      
      // Test object
      await redisStorage.store(TEST_SOURCE_ID, 'object', timestamp + 2, { lat: 45, lng: -73 });
      
      // Verify all types stored
      const numberKey = `stream:${TEST_SOURCE_ID}:number`;
      const stringKey = `stream:${TEST_SOURCE_ID}:string`;
      const objectKey = `stream:${TEST_SOURCE_ID}:object`;
      
      const numberResult = await testRedis.zrange(numberKey, -1, -1);
      const stringResult = await testRedis.zrange(stringKey, -1, -1);
      const objectResult = await testRedis.zrange(objectKey, -1, -1);
      
      expect(JSON.parse(numberResult[0])).toBe(123);
      expect(JSON.parse(stringResult[0])).toBe('test');
      expect(JSON.parse(objectResult[0])).toEqual({ lat: 45, lng: -73 });
    });

    it('should skip duplicate data points (same timestamp and value)', async () => {
      const timestamp = Date.now();
      const value = 45.123;

      // Store first time
      await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamp, value);
      
      // Try to store duplicate
      await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamp, value);

      // Verify only one entry exists
      const key = `stream:${TEST_SOURCE_ID}:${TEST_CHANNEL}`;
      const results = await testRedis.zrangebyscore(key, timestamp, timestamp);
      
      expect(results.length).toBe(1);
    });
  });

  describe('query() - Read Operations', () => {
    it('should query data points within time range', async () => {
      const baseTime = Date.now();
      const timestamps = [
        baseTime,
        baseTime + 1000,
        baseTime + 2000,
        baseTime + 3000,
        baseTime + 4000
      ];
      const values = [45.1, 45.2, 45.3, 45.4, 45.5];

      // Store all points
      for (let i = 0; i < timestamps.length; i++) {
        await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamps[i], values[i]);
      }

      // Query subset
      const results = await redisStorage.query(
        TEST_SOURCE_ID,
        TEST_CHANNEL,
        baseTime + 1000,
        baseTime + 3000
      );

      expect(results.length).toBe(3);
      expect(results[0].value).toBe(45.2);
      expect(results[1].value).toBe(45.3);
      expect(results[2].value).toBe(45.4);
    });

    it('should return empty array for non-existent channel', async () => {
      const results = await redisStorage.query(
        TEST_SOURCE_ID,
        'NonExistentChannel',
        Date.now() - 10000,
        Date.now()
      );

      expect(results).toEqual([]);
    });

    it('should return data points sorted by timestamp', async () => {
      const baseTime = Date.now();
      const timestamps = [
        baseTime + 3000,
        baseTime,
        baseTime + 2000,
        baseTime + 1000
      ];
      const values = [45.4, 45.1, 45.3, 45.2];

      // Store in random order
      for (let i = 0; i < timestamps.length; i++) {
        await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamps[i], values[i]);
      }

      // Query should return sorted
      const results = await redisStorage.query(
        TEST_SOURCE_ID,
        TEST_CHANNEL,
        baseTime,
        baseTime + 5000
      );

      expect(results.length).toBe(4);
      expect(results[0].timestamp).toBe(baseTime);
      expect(results[1].timestamp).toBe(baseTime + 1000);
      expect(results[2].timestamp).toBe(baseTime + 2000);
      expect(results[3].timestamp).toBe(baseTime + 3000);
    });
  });

  describe('getLatest() - Latest Data Point', () => {
    it('should return the latest data point for a channel', async () => {
      const baseTime = Date.now();
      const timestamps = [baseTime, baseTime + 1000, baseTime + 2000];
      const values = [45.1, 45.2, 45.3];

      for (let i = 0; i < timestamps.length; i++) {
        await redisStorage.store(TEST_SOURCE_ID, TEST_CHANNEL, timestamps[i], values[i]);
      }

      const latest = await redisStorage.getLatest(TEST_SOURCE_ID, TEST_CHANNEL);

      expect(latest).not.toBeNull();
      expect(latest.value).toBe(45.3);
      expect(latest.timestamp).toBe(baseTime + 2000);
    });

    it('should return null for non-existent channel', async () => {
      const latest = await redisStorage.getLatest(TEST_SOURCE_ID, 'NonExistentChannel');
      expect(latest).toBeNull();
    });
  });

  describe('getChannels() - Channel Management', () => {
    it('should return list of available channels for a source', async () => {
      const timestamp = Date.now();
      const channels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];

      // Store data for each channel
      for (const channel of channels) {
        await redisStorage.store(TEST_SOURCE_ID, channel, timestamp, 0);
      }

      const availableChannels = await redisStorage.getChannels(TEST_SOURCE_ID);

      expect(availableChannels.length).toBe(channels.length);
      for (const channel of channels) {
        expect(availableChannels).toContain(channel);
      }
    });

    it('should return empty array for source with no data', async () => {
      const channels = await redisStorage.getChannels(99999);
      expect(channels).toEqual([]);
    });
  });

  describe('getLatestTimestamp() - Latest Timestamp', () => {
    it('should return the latest timestamp across all channels', async () => {
      const baseTime = Date.now();
      
      // Store data with different timestamps
      await redisStorage.store(TEST_SOURCE_ID, 'Lat', baseTime, 45.1);
      await redisStorage.store(TEST_SOURCE_ID, 'Lng', baseTime + 2000, -73.1);
      await redisStorage.store(TEST_SOURCE_ID, 'Hdg', baseTime + 1000, 180);

      const latestTimestamp = await redisStorage.getLatestTimestamp(TEST_SOURCE_ID);

      expect(latestTimestamp).toBe(baseTime + 2000);
    });

    it('should return null for source with no data', async () => {
      const latestTimestamp = await redisStorage.getLatestTimestamp(99999);
      expect(latestTimestamp).toBeNull();
    });
  });

  describe('Normalized Channel Names', () => {
    it('should store normalized channel names correctly', async () => {
      const timestamp = Date.now();
      const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];

      for (const channel of normalizedChannels) {
        await redisStorage.store(TEST_SOURCE_ID, channel, timestamp, 0);
      }

      const availableChannels = await redisStorage.getChannels(TEST_SOURCE_ID);

      // Verify normalized names are stored
      for (const channel of normalizedChannels) {
        expect(availableChannels).toContain(channel);
      }
    });
  });
});

