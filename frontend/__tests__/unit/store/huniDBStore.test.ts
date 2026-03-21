/**
 * Unit Tests for HuniDB Store (mock)
 *
 * Timeseries: API + in-memory only; not stored in HuniDB. The mock no-ops
 * data-cache methods (storeDataByChannels, queryDataByChannels, getAvailableChannels
 * for timeseries/mapdata/aggregates) and keeps object storage and metadata behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHuniDBStore } from '../../mocks/huniDB.mock';
import { mockDataPoints } from '../../fixtures/mockData';

const huniDBStore = new MockHuniDBStore();

describe('HuniDB Store - Unit Tests', () => {
  beforeEach(() => {
    huniDBStore.clear();
  });

  afterEach(() => {
    huniDBStore.clear();
  });

  describe('storeDataByChannels (no-op for data cache)', () => {
    it('should resolve without persisting timeseries', async () => {
      await huniDBStore.storeDataByChannels(
        'timeseries',
        'ac75',
        0,
        0,
        1,
        mockDataPoints
      );
      const storedData = huniDBStore.getData('timeseries_ac75_0_0_1');
      expect(storedData).toEqual([]);
    });

    it('should resolve without persisting mapdata or aggregates', async () => {
      await huniDBStore.storeDataByChannels('mapdata', 'ac75', 0, 0, 1, mockDataPoints);
      await huniDBStore.storeDataByChannels('aggregates', 'ac75', 0, 0, 1, mockDataPoints);
      expect(huniDBStore.hasData('mapdata_ac75_0_0_1')).toBe(false);
      expect(huniDBStore.hasData('aggregates_ac75_0_0_1')).toBe(false);
    });
  });

  describe('queryDataByChannels (no data cache)', () => {
    it('should return empty array for timeseries', async () => {
      const result = await huniDBStore.queryDataByChannels(
        'ac75',
        0,
        0,
        1,
        ['twa', 'bsp'],
        ['timeseries']
      );
      expect(result).toEqual([]);
    });

    it('should return empty array with time range or filters', async () => {
      const result = await huniDBStore.queryDataByChannels(
        'ac75',
        0,
        0,
        1,
        [],
        ['timeseries'],
        { start: 1704067200000, end: 1704067300000 },
        { raceNumbers: [1] }
      );
      expect(result).toEqual([]);
    });
  });

  describe('getAvailableChannels (no data cache)', () => {
    it('should return empty array for timeseries/mapdata/aggregates', async () => {
      const channels = await huniDBStore.getAvailableChannels('ac75', 0, 0, 1, ['timeseries']);
      expect(channels).toEqual([]);
    });
  });

  describe('Object Storage', () => {
    it('should store and retrieve objects', async () => {
      const testObject = { name: 'test', value: 123 };
      
      await huniDBStore.storeObject('testObject', testObject);
      const retrieved = await huniDBStore.getObject('testObject');
      
      expect(retrieved).toEqual(testObject);
    });

    it('should return null for non-existent objects', async () => {
      const retrieved = await huniDBStore.getObject('nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should list all objects', async () => {
      await huniDBStore.storeObject('object1', { data: 1 });
      await huniDBStore.storeObject('object2', { data: 2 });
      
      const objects = await huniDBStore.listObjects();
      expect(objects).toContain('object1');
      expect(objects).toContain('object2');
    });

    it('should delete objects', async () => {
      await huniDBStore.storeObject('testObject', { data: 1 });
      await huniDBStore.deleteObject('testObject');
      
      const retrieved = await huniDBStore.getObject('testObject');
      expect(retrieved).toBeNull();
    });
  });

  describe('Storage Info', () => {
    it('should return correct storage info (objects only; no data cache)', async () => {
      await huniDBStore.storeObject('testObject', { data: 1 });
      const info = await huniDBStore.getStorageInfo();
      expect(info.simpleObjectCount).toBeGreaterThan(0);
    });
  });

  describe('Clear Operations', () => {
    it('should clear all data', async () => {
      await huniDBStore.storeObject('testObject', { data: 1 });
      await huniDBStore.clearAllData();
      const info = await huniDBStore.getStorageInfo();
      expect(info.simpleObjectCount).toBe(0);
    });
  });
});

