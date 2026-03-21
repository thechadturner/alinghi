/**
 * Test Helper Utilities
 * 
 * Common utilities for setting up and running tests
 */

import { vi } from 'vitest';
import { mockHuniDBStore } from '../mocks/huniDB.mock';
import { mockAPI } from '../mocks/api.mock';
import { mockCache } from '../mocks/cache.mock';
import { mockDataPoints, mockFilterConfigs } from '../fixtures/mockData';

/**
 * Setup mocks for a test
 */
export function setupMocks() {
  // Clear mock data and reset mock functions
  mockHuniDBStore.clear();
  mockAPI.clear();
  mockCache.clear();
}

/**
 * Setup test data in HuniDB (replaces old IndexedDB setup)
 */
export function setupIndexedDBData(
  dataType: 'mapdata' | 'timeseries' | 'aggregates',
  className: string,
  sourceId: string,
  data: any[] = mockDataPoints,
  datasetId: number | string = 0,
  projectId: number | string = 0
): void {
  const classNameLower = className.toLowerCase();
  const datasetIdStr = String(datasetId);
  const projectIdStr = String(projectId);
  const sourceIdStr = String(sourceId);
  const key = `${dataType}_${classNameLower}_${datasetIdStr}_${projectIdStr}_${sourceIdStr}`;
  mockHuniDBStore.setData(key, data);
}

/**
 * Setup API response
 */
export function setupAPIResponse(
  channels: string[],
  params: any,
  response: any
): void {
  mockAPI.setResponse(channels, params, response);
}

/**
 * Setup API error
 */
export function setupAPIError(
  channels: string[],
  params: any,
  error: Error
): void {
  mockAPI.setError(channels, params, error);
}

/**
 * Wait for async operations to complete
 */
export async function waitForAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Create a test data point
 */
export function createTestDataPoint(
  overrides: Partial<any> = {}
): any {
  return {
    Datetime: new Date('2024-01-01T00:00:00Z'),
    timestamp: 1704067200000,
    twa: 45,
    bsp: 12.5,
    Race_number: 1,
    Leg_number: 1,
    Grade: 1,
    ...overrides
  };
}

/**
 * Create a test filter config
 */
export function createTestFilterConfig(
  overrides: Partial<any> = {}
): any {
  return {
    twaStates: ['upwind'],
    raceNumbers: [1],
    legNumbers: [1],
    grades: [1],
    timeRange: {
      start: 1704067200000,
      end: 1704067300000
    },
    ...overrides
  };
}

/**
 * Assert that data contains expected channels
 */
export function expectDataToHaveChannels(
  data: any[],
  expectedChannels: string[]
): void {
  if (data.length === 0) {
    throw new Error('Data array is empty');
  }

  const actualChannels = Object.keys(data[0]).filter(key => key !== 'timestamp');
  const missingChannels = expectedChannels.filter(channel => 
    !actualChannels.includes(channel)
  );

  if (missingChannels.length > 0) {
    throw new Error(`Missing channels: ${missingChannels.join(', ')}`);
  }
}

/**
 * Assert that data is sorted by timestamp
 */
export function expectDataToBeSorted(data: any[]): void {
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1].timestamp || new Date(data[i - 1].Datetime).getTime();
    const curr = data[i].timestamp || new Date(data[i].Datetime).getTime();
    
    if (prev > curr) {
      throw new Error(`Data is not sorted by timestamp at index ${i}`);
    }
  }
}

/**
 * Assert that data passes filters
 */
export function expectDataToPassFilters(
  data: any[],
  filters: any,
  filterFunction: (point: any, config: any) => boolean
): void {
  const failingPoints = data.filter(point => !filterFunction(point, filters));
  
  if (failingPoints.length > 0) {
    throw new Error(`${failingPoints.length} data points failed filter validation`);
  }
}

/**
 * Measure execution time
 */
export async function measureExecutionTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  
  return {
    result,
    duration: end - start
  };
}

/**
 * Create a large dataset for performance testing
 */
export function createLargeDataset(size: number): any[] {
  return Array.from({ length: size }, (_, i) => ({
    Datetime: new Date(1704067200000 + i * 1000),
    timestamp: 1704067200000 + i * 1000,
    twa: Math.random() * 360,
    bsp: Math.random() * 30,
    Race_number: Math.floor(i / 1000) + 1,
    Leg_number: Math.floor(i / 500) + 1,
    Grade: Math.floor(i / 2000) + 1
  }));
}

/**
 * Assert that two datasets are equivalent (ignoring order)
 */
export function expectDatasetsToBeEquivalent(
  actual: any[],
  expected: any[]
): void {
  if (actual.length !== expected.length) {
    throw new Error(`Dataset length mismatch: expected ${expected.length}, got ${actual.length}`);
  }

  // Sort both arrays by timestamp for comparison
  const sortedActual = [...actual].sort((a, b) => a.timestamp - b.timestamp);
  const sortedExpected = [...expected].sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < sortedActual.length; i++) {
    const actualPoint = sortedActual[i];
    const expectedPoint = sortedExpected[i];
    
    if (JSON.stringify(actualPoint) !== JSON.stringify(expectedPoint)) {
      throw new Error(`Dataset mismatch at index ${i}`);
    }
  }
}

// Export mocks for use in tests
// Note: mockIndexedDB is deprecated - use mockHuniDBStore instead
export { mockHuniDBStore as mockIndexedDB, mockHuniDBStore, mockAPI, mockCache };
