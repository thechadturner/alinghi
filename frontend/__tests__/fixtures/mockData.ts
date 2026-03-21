/**
 * Mock Data for Testing
 * 
 * Provides consistent test data across all test suites
 */

export const mockDataPoints = [
  {
    Datetime: new Date('2024-01-01T00:00:00Z'),
    timestamp: 1704067200000,
    twa: 45,
    bsp: 12.5,
    Race_number: 1,
    Leg_number: 1,
    Grade: 1
  },
  {
    Datetime: new Date('2024-01-01T00:01:00Z'),
    timestamp: 1704067260000,
    twa: 90,
    bsp: 15.2,
    Race_number: 1,
    Leg_number: 1,
    Grade: 1
  },
  {
    Datetime: new Date('2024-01-01T00:02:00Z'),
    timestamp: 1704067320000,
    twa: 135,
    bsp: 18.1,
    Race_number: 2,
    Leg_number: 2,
    Grade: 2
  },
  {
    Datetime: new Date('2024-01-01T00:03:00Z'),
    timestamp: 1704067380000,
    twa: 60,
    bsp: 14.3,
    Race_number: 1,
    Leg_number: 1,
    Grade: 1
  },
  {
    Datetime: new Date('2024-01-01T00:04:00Z'),
    timestamp: 1704067440000,
    twa: 120,
    bsp: 16.7,
    Race_number: 2,
    Leg_number: 2,
    Grade: 2
  }
];

export const mockChannelData = {
  timeseries: mockDataPoints,
  mapdata: mockDataPoints.map(point => ({
    ...point,
    lat: 40.7128 + Math.random() * 0.01,
    lng: -74.0060 + Math.random() * 0.01
  })),
  aggregates: mockDataPoints.map(point => ({
    ...point,
    avg_speed: point.bsp * 0.9,
    max_speed: point.bsp * 1.1
  }))
};

export const mockFilterConfigs = {
  upwindOnly: {
    twaStates: ['upwind'],
    raceNumbers: [1],
    legNumbers: [1],
    grades: [1],
    timeRange: {
      start: 1704067200000,
      end: 1704067300000
    }
  },
  downwindOnly: {
    twaStates: ['downwind'],
    raceNumbers: [2],
    legNumbers: [2],
    grades: [2],
    timeRange: {
      start: 1704067300000,
      end: 1704067500000
    }
  },
  allRaces: {
    twaStates: ['upwind', 'downwind', 'reaching'],
    raceNumbers: [1, 2],
    legNumbers: [1, 2],
    grades: [1, 2]
  }
};

export const mockAPIResponses = {
  success: {
    data: mockDataPoints,
    availableChannels: ['twa', 'bsp'],
    missingChannels: [],
    hasAll: true
  },
  partialData: {
    data: mockDataPoints.slice(0, 2),
    availableChannels: ['twa'],
    missingChannels: ['bsp'],
    hasAll: false
  },
  empty: {
    data: [],
    availableChannels: [],
    missingChannels: ['twa', 'bsp'],
    hasAll: false
  },
  error: {
    error: 'API Error',
    message: 'Failed to fetch data'
  }
};

export const mockIndexedDBData = {
  existing: mockDataPoints.slice(0, 3),
  partial: mockDataPoints.slice(0, 1),
  empty: []
};

export const edgeCaseData = {
  malformed: [
    { Datetime: 'invalid-date', timestamp: NaN },
    { Datetime: new Date('2024-01-01T00:00:00Z'), timestamp: 1704067200000, twa: 45 },
    null,
    undefined,
    { Datetime: new Date('2024-01-01T00:01:00Z'), timestamp: 1704067260000 } // Missing channels
  ],
  largeDataset: Array.from({ length: 10000 }, (_, i) => ({
    Datetime: new Date(1704067200000 + i * 1000),
    timestamp: 1704067200000 + i * 1000,
    twa: Math.random() * 360,
    bsp: Math.random() * 30,
    Race_number: Math.floor(i / 1000) + 1,
    Leg_number: Math.floor(i / 500) + 1,
    Grade: Math.floor(i / 2000) + 1
  })),
  caseSensitive: mockDataPoints.map(point => ({
    ...point,
    TWA: point.twa, // Uppercase
    BSP: point.bsp  // Uppercase
  }))
};

export const testConfigs = {
  chartTypes: ['timeseries', 'map', 'scatter', 'polarrose', 'parallel'] as const,
  dataSources: ['timeseries', 'mapdata', 'aggregates', 'objects'] as const,
  channels: ['twa', 'bsp', 'tws', 'twd', 'lat', 'lng'],
  timeRanges: {
    short: { start: 1704067200000, end: 1704067300000 },
    medium: { start: 1704067200000, end: 1704067500000 },
    long: { start: 1704067200000, end: 1704067800000 }
  }
};
