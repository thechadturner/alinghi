/**
 * Unit Tests for Filter Core
 * 
 * Tests the core filtering logic used throughout the application
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  convertTwaStatesToRanges,
  passesTwaRanges,
  passesBasicFilters,
  createFilterConfig,
  getTimestamp
} from '../../../utils/filterCore';
import { mockDataPoints } from '../../fixtures/mockData';

describe('Filter Core - Unit Tests', () => {
  describe('convertTwaStatesToRanges', () => {
    it('should convert upwind state to correct range', () => {
      const ranges = convertTwaStatesToRanges(['upwind']);
      expect(ranges).toEqual([{ min: 30, max: 75 }]);
    });

    it('should convert downwind state to correct range', () => {
      const ranges = convertTwaStatesToRanges(['downwind']);
      expect(ranges).toEqual([{ min: 105, max: 150 }]);
    });

    it('should convert reaching state to correct range', () => {
      const ranges = convertTwaStatesToRanges(['reaching']);
      expect(ranges).toEqual([{ min: 75, max: 115 }]);
    });

    it('should handle multiple direction states', () => {
      const ranges = convertTwaStatesToRanges(['upwind', 'downwind']);
      expect(ranges).toEqual([
        { min: 30, max: 75 },
        { min: 105, max: 150 }
      ]);
    });

    it('should handle port/stbd states', () => {
      const ranges = convertTwaStatesToRanges(['port']);
      expect(ranges).toEqual([{ min: -180, max: 0 }]);
      
      const ranges2 = convertTwaStatesToRanges(['stbd']);
      expect(ranges2).toEqual([{ min: 0, max: 180 }]);
    });

    it('should handle both port and stbd', () => {
      const ranges = convertTwaStatesToRanges(['port', 'stbd']);
      expect(ranges).toEqual([]); // No additional range needed
    });

    it('should handle case insensitive input', () => {
      const ranges = convertTwaStatesToRanges(['UPWIND', 'Downwind']);
      expect(ranges).toEqual([
        { min: 30, max: 75 },
        { min: 105, max: 150 }
      ]);
    });
  });

  describe('passesTwaRanges', () => {
    it('should pass TWA values within upwind range', () => {
      expect(passesTwaRanges(45, ['upwind'])).toBe(true);
      expect(passesTwaRanges(60, ['upwind'])).toBe(true);
      expect(passesTwaRanges(30, ['upwind'])).toBe(false); // Boundary
      expect(passesTwaRanges(75, ['upwind'])).toBe(false); // Boundary
    });

    it('should pass TWA values within downwind range', () => {
      expect(passesTwaRanges(120, ['downwind'])).toBe(true);
      expect(passesTwaRanges(135, ['downwind'])).toBe(true);
      expect(passesTwaRanges(105, ['downwind'])).toBe(false); // Boundary
      expect(passesTwaRanges(150, ['downwind'])).toBe(false); // Boundary
    });

    it('should pass TWA values within reaching range', () => {
      expect(passesTwaRanges(90, ['reaching'])).toBe(true);
      expect(passesTwaRanges(100, ['reaching'])).toBe(true);
      expect(passesTwaRanges(75, ['reaching'])).toBe(false); // Boundary
      expect(passesTwaRanges(115, ['reaching'])).toBe(false); // Boundary
    });

    it('should handle port/stbd filtering', () => {
      expect(passesTwaRanges(-45, ['port'])).toBe(true);
      expect(passesTwaRanges(45, ['port'])).toBe(false);
      expect(passesTwaRanges(45, ['stbd'])).toBe(true);
      expect(passesTwaRanges(-45, ['stbd'])).toBe(false);
    });

    it('should handle both port and stbd', () => {
      expect(passesTwaRanges(45, ['port', 'stbd'])).toBe(true);
      expect(passesTwaRanges(-45, ['port', 'stbd'])).toBe(true);
    });

    it('should handle empty states array', () => {
      expect(passesTwaRanges(45, [])).toBe(true);
    });

    it('should handle invalid TWA values', () => {
      expect(passesTwaRanges(NaN, ['upwind'])).toBe(false);
      expect(passesTwaRanges(undefined as any, ['upwind'])).toBe(false);
      expect(passesTwaRanges(null as any, ['upwind'])).toBe(false);
    });

    it('should handle case insensitive states', () => {
      expect(passesTwaRanges(45, ['UPWIND'])).toBe(true);
      expect(passesTwaRanges(45, ['Upwind'])).toBe(true);
    });
  });

  describe('passesBasicFilters', () => {
    const testPoint = {
      twa: 45,
      Race_number: 1,
      Leg_number: 1,
      Grade: 1,
      timestamp: 1704067200000
    };

    it('should pass when no filters are applied', () => {
      expect(passesBasicFilters(testPoint, {})).toBe(true);
    });

    it('should filter by TWA states', () => {
      const config = { twaStates: ['upwind'] };
      expect(passesBasicFilters(testPoint, config)).toBe(true);
      
      const config2 = { twaStates: ['downwind'] };
      expect(passesBasicFilters(testPoint, config2)).toBe(false);
    });

    it('should filter by race numbers', () => {
      const config = { raceNumbers: [1] };
      expect(passesBasicFilters(testPoint, config)).toBe(true);
      
      const config2 = { raceNumbers: [2] };
      expect(passesBasicFilters(testPoint, config2)).toBe(false);
    });

    it('should filter by leg numbers', () => {
      const config = { legNumbers: [1] };
      expect(passesBasicFilters(testPoint, config)).toBe(true);
      
      const config2 = { legNumbers: [2] };
      expect(passesBasicFilters(testPoint, config2)).toBe(false);
    });

    it('should filter by grades', () => {
      const config = { grades: [1] };
      expect(passesBasicFilters(testPoint, config)).toBe(true);
      
      const config2 = { grades: [2] };
      expect(passesBasicFilters(testPoint, config2)).toBe(false);
    });

    it('should filter by time range', () => {
      const config = {
        timeRange: {
          start: 1704067200000,
          end: 1704067300000
        }
      };
      expect(passesBasicFilters(testPoint, config)).toBe(true);
      
      const config2 = {
        timeRange: {
          start: 1704067300000,
          end: 1704067400000
        }
      };
      expect(passesBasicFilters(testPoint, config2)).toBe(false);
    });

    it('should handle missing fields gracefully', () => {
      const incompletePoint = { twa: 45 };
      const config = { raceNumbers: [1] };
      expect(passesBasicFilters(incompletePoint, config)).toBe(true);
    });

    it('should handle case sensitivity in TWA field names', () => {
      const pointWithTwa = { Twa: 45, Race_number: 1 };
      const config = { twaStates: ['upwind'] };
      expect(passesBasicFilters(pointWithTwa, config)).toBe(true);
    });
  });

  describe('createFilterConfig', () => {
    it('should create config with all parameters', () => {
      const config = createFilterConfig(
        ['upwind'],
        [1],
        [1],
        [1],
        { start: 1704067200000, end: 1704067300000 }
      );
      
      expect(config).toEqual({
        twaStates: ['upwind'],
        raceNumbers: [1],
        legNumbers: [1],
        grades: [1],
        timeRange: { start: 1704067200000, end: 1704067300000 }
      });
    });

    it('should create config with default values', () => {
      const config = createFilterConfig();
      
      expect(config).toEqual({
        twaStates: [],
        raceNumbers: [],
        legNumbers: [],
        grades: [],
        timeRange: undefined
      });
    });
  });

  describe('getTimestamp', () => {
    it('should extract timestamp from timestamp field', () => {
      const point = { timestamp: 1704067200000 };
      expect(getTimestamp(point)).toBe(1704067200000);
    });

    it('should extract timestamp from datetime field', () => {
      const point = { datetime: '2024-01-01T00:00:00Z' };
      expect(getTimestamp(point)).toBe(1704067200000);
    });

    it('should extract timestamp from Datetime field', () => {
      const point = { Datetime: '2024-01-01T00:00:00Z' };
      expect(getTimestamp(point)).toBe(1704067200000);
    });

    it('should handle Date objects', () => {
      const point = { Datetime: new Date('2024-01-01T00:00:00Z') };
      expect(getTimestamp(point)).toBe(1704067200000);
    });

    it('should prioritize timestamp over other fields', () => {
      const point = {
        timestamp: 1704067200000,
        datetime: '2024-01-02T00:00:00Z',
        Datetime: '2024-01-03T00:00:00Z'
      };
      expect(getTimestamp(point)).toBe(1704067200000);
    });
  });

  describe('Integration with real data', () => {
    it('should filter mock data correctly', () => {
      const config = {
        twaStates: ['upwind'],
        raceNumbers: [1],
        legNumbers: [1],
        grades: [1]
      };

      const filteredData = mockDataPoints.filter(point => 
        passesBasicFilters(point, config)
      );

      // Should include both upwind points (TWA 45 and 60)
      expect(filteredData).toHaveLength(2);
      expect(filteredData.map(p => p.twa)).toContain(45);
      expect(filteredData.map(p => p.twa)).toContain(60);
    });

    it('should filter by time range', () => {
      const config = {
        timeRange: {
          start: 1704067200000,
          end: 1704067300000
        }
      };

      const filteredData = mockDataPoints.filter(point => 
        passesBasicFilters(point, config)
      );

      // Should include first two points
      expect(filteredData).toHaveLength(2);
    });
  });
});
