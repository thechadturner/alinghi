/**
 * Data Class Types and Definitions
 * 
 * Defines semantic data categories for efficient storage and access
 */

// Data class categories
export type DataClass = 
  | 'sensor-raw'        // High-frequency sensor data (100Hz+)
  | 'sensor-aggregated' // Processed sensor data (1-10Hz)
  | 'statistics'        // Calculated metrics, averages, percentiles
  | 'geographic-raw'    // GPS coordinates, bearings, distances
  | 'geographic-normalized' // Zero-referenced geographic data
  | 'tabular'           // Structured data tables (races, legs, targets)
  | 'metadata'          // Configuration, labels, classifications
  | 'events'            // Discrete events, maneuvers, state changes
  | 'performance-aggregates' // Performance aggregated data (BIN 10 AVG)
  | 'performance-cloud'      // Performance 1Hz cloud data
  | 'performance-targets';   // Performance target data

// Data class configuration
export interface DataClassConfig {
  compression: 'none' | 'lz4' | 'gzip' | 'custom';
  indexing: 'time' | 'spatial' | 'categorical' | 'hybrid';
  chunkSize: number;
  persistence: 'memory' | 'localStorage' | 'indexedDB';
  queryOptimization: string[];
  maxMemoryMB: number;
  evictionPolicy: 'lru' | 'fifo' | 'time-based';
}

// Data class configurations
export const DATA_CLASS_CONFIGS: Record<DataClass, DataClassConfig> = {
  'sensor-raw': {
    compression: 'lz4',
    indexing: 'time',
    chunkSize: 10000,
    persistence: 'indexedDB',
    queryOptimization: ['timestamp', 'channel'],
    maxMemoryMB: 100,
    evictionPolicy: 'lru'
  },
  'sensor-aggregated': {
    compression: 'gzip',
    indexing: 'time',
    chunkSize: 5000,
    persistence: 'localStorage',
    queryOptimization: ['timestamp', 'channel'],
    maxMemoryMB: 50,
    evictionPolicy: 'lru'
  },
  'statistics': {
    compression: 'gzip',
    indexing: 'categorical',
    chunkSize: 1000,
    persistence: 'localStorage',
    queryOptimization: ['metric', 'period', 'source'],
    maxMemoryMB: 25,
    evictionPolicy: 'time-based'
  },
  'performance-aggregates': {
    compression: 'gzip',
    indexing: 'categorical',
    chunkSize: 2000,
    persistence: 'localStorage',
    // Note: Channel names are class-specific (e.g., GP50 uses Bsp_kph)
    // Use defaultChannelsStore to get class-specific channel names dynamically
    queryOptimization: ['event_id', 'Datetime'], // Generic fields only - channel names come from defaultChannelsStore
    maxMemoryMB: 30,
    evictionPolicy: 'lru'
  },
  'performance-cloud': {
    compression: 'lz4',
    indexing: 'time',
    chunkSize: 5000,
    persistence: 'indexedDB',
    // Note: Channel names are class-specific (e.g., GP50 uses Tws_kph)
    // Use defaultChannelsStore to get class-specific channel names dynamically
    queryOptimization: ['event_id', 'Datetime'], // Generic fields only - channel names come from defaultChannelsStore
    maxMemoryMB: 50,
    evictionPolicy: 'lru'
  },
  'performance-targets': {
    compression: 'none',
    indexing: 'categorical',
    chunkSize: 100,
    persistence: 'localStorage',
    queryOptimization: ['name', 'type'],
    maxMemoryMB: 5,
    evictionPolicy: 'fifo'
  },
  'geographic-raw': {
    compression: 'custom',
    indexing: 'spatial',
    chunkSize: 5000,
    persistence: 'indexedDB',
    queryOptimization: ['lat', 'lng', 'timestamp'],
    maxMemoryMB: 75,
    evictionPolicy: 'lru'
  },
  'geographic-normalized': {
    compression: 'custom',
    indexing: 'spatial',
    chunkSize: 3000,
    persistence: 'localStorage',
    queryOptimization: ['x', 'y', 'timestamp'],
    maxMemoryMB: 40,
    evictionPolicy: 'lru'
  },
  'tabular': {
    compression: 'gzip',
    indexing: 'categorical',
    chunkSize: 2000,
    persistence: 'localStorage',
    queryOptimization: ['id', 'type', 'category'],
    maxMemoryMB: 30,
    evictionPolicy: 'fifo'
  },
  'metadata': {
    compression: 'none',
    indexing: 'categorical',
    chunkSize: 100,
    persistence: 'localStorage',
    queryOptimization: ['key', 'type'],
    maxMemoryMB: 10,
    evictionPolicy: 'fifo'
  },
  'events': {
    compression: 'gzip',
    indexing: 'time',
    chunkSize: 500,
    persistence: 'localStorage',
    queryOptimization: ['timestamp', 'type', 'source'],
    maxMemoryMB: 20,
    evictionPolicy: 'time-based'
  }
};

// Base data entry interface
export interface DataEntry<T = any> {
  id: string;
  class: DataClass;
  sourceId: string;
  data: T;
  metadata: DataMetadata;
  timestamp: number;
  size: number;
  compressed: boolean;
}

// Data metadata
export interface DataMetadata {
  projectId?: string;
  className?: string;
  datasetId?: string;
  channels?: string[];
  bounds?: {
    min: number;
    max: number;
    count: number;
  };
  statistics?: {
    mean?: number;
    std?: number;
    min?: number;
    max?: number;
  };
  [key: string]: any;
}

// Sensor data specific types
export interface SensorDataPoint {
  timestamp: number;
  channel: string;
  value: number;
  quality?: number;
  [key: string]: any;
}

export interface GeographicDataPoint {
  timestamp: number;
  lat: number;
  lng: number;
  bearing?: number;
  speed?: number;
  elevation?: number;
  [key: string]: any;
}

export interface StatisticsDataPoint {
  timestamp: number;
  metric: string;
  value: number;
  period: string;
  source: string;
  [key: string]: any;
}

export interface EventDataPoint {
  timestamp: number;
  type: string;
  source: string;
  data: any;
  [key: string]: any;
}

// Performance data specific types
export interface PerformanceAggregatePoint {
  event_id: string;
  Datetime: string;
  /** IANA timezone for the row's dataset (for display; e.g. tooltips). */
  timezone?: string;
  Twa: number;
  Tws: number;
  Bsp: number;
  TACK: string;
  MAINSAIL: string;
  HEADSAIL: string;
  RACE: string;
  [key: string]: any;
}

export interface PerformanceCloudPoint {
  event_id: string;
  Datetime: string;
  Twa: number;
  Tws: number;
  Bsp: number;
  [key: string]: any;
}

export interface PerformanceTargetData {
  name: string;
  data: {
    UPWIND?: any;
    DOWNWIND?: any;
    [key: string]: any;
  };
}

// Query interfaces
export interface DataQuery {
  class: DataClass;
  sourceId?: string;
  timeRange?: {
    start: number;
    end: number;
  };
  spatialBounds?: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
  filters?: Record<string, any>;
  limit?: number;
  offset?: number;
}

export interface DataQueryResult<T = any> {
  data: T[];
  total: number;
  hasMore: boolean;
  metadata: {
    queryTime: number;
    compressed: boolean;
    source: string;
  };
}

// Storage statistics
export interface StorageStats {
  totalEntries: number;
  totalSize: number;
  memoryUsage: number;
  classStats: Record<DataClass, {
    entries: number;
    size: number;
    memoryUsage: number;
    compressionRatio: number;
  }>;
}

// Chart types ('timeseries' accepted as alias for 'ts' at API/test boundaries)
export type ChartType = 'map' | 'overlay' | 'ts' | 'timeseries' | 'scatter' | 'probability' | 'parallel' | 'performance' | 'maneuvers' | 'performance-aggregates' | 'performance-cloud' | 'performance-targets';

// Chart data interface
export interface ChartData {
  chartType: ChartType;
  data: any[];
  metadata?: DataMetadata;
  sourceId: string;
}

// Multi-source data types
export type DataFrequency = 'high-frequency' | 'aggregate' | 'low-frequency';
export type DataSource = 'channel-values' | 'project-aggregate' | 'dataset-aggregate';
export type ReportType = 'explore' | 'dataset' | 'project';

// Data collection interface
export interface DataCollection {
  data: any[];
  frequency: DataFrequency;
  source: DataSource;
  sourceId: string;
  channels: string[];
  lastUpdated: number;
  ttl: number;
  metadata: {
    projectId: number;
    className: string;
    date: string;
    sourceName: string;
    datasetId?: number;
  };
}

// Multi-source data collection
export interface MultiSourceDataCollection {
  sources: Map<string, DataCollection>;
  frequency: DataFrequency;
  channels: string[];
  lastUpdated: number;
  ttl: number;
  comparisonMetadata: {
    timeRange: { start: string; end: string };
    alignedData: boolean;
    sourceCount: number;
  };
}

// Comparison result
export interface ComparisonResult {
  alignedData: any[];
  sourceComparisons: Record<string, any>;
  metadata: {
    timeRange: { start: string; end: string };
    sourceCount: number;
    alignmentMethod: string;
  };
}

// Multi-source request interface
export interface MultiSourceRequest {
  projectId: number;
  className: string;
  date: string;
  sourceName: string;
  channels: string[];
  datasetId?: number;
}

// Multi-source options
export interface MultiSourceOptions {
  ttl?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

// Utility function to create source ID
export const createSourceId = (
  projectId: number,
  className: string,
  date: string,
  sourceName: string,
  datasetId?: number
): string => {
  const baseId = `${projectId}_${className}_${date}_${sourceName}`;
  return datasetId ? `${baseId}_${datasetId}` : baseId;
};

// Utility function to determine report type
export const getReportType = (
  frequency: DataFrequency,
  sourceCount: number
): ReportType => {
  if (frequency === 'high-frequency' && sourceCount === 1) return 'explore';
  if (frequency === 'aggregate' && sourceCount === 1) return 'dataset';
  if (sourceCount >= 2) return 'project';
  return 'explore'; // default
};

// Utility function to align multi-source data
export const alignMultiSourceData = (sources: Map<string, DataCollection>): ComparisonResult => {
  const alignedData: any[] = [];
  const sourceComparisons: Record<string, any> = {};
  
  // Simple alignment - in production, implement proper time-based alignment
  sources.forEach((collection, sourceId) => {
    sourceComparisons[sourceId] = {
      dataCount: collection.data.length,
      timeRange: collection.data.length > 0 ? {
        start: collection.data[0].Datetime || collection.data[0].timestamp,
        end: collection.data[collection.data.length - 1].Datetime || collection.data[collection.data.length - 1].timestamp
      } : null
    };
    
    // For now, just concatenate data - implement proper alignment later
    alignedData.push(...collection.data);
  });
  
  return {
    alignedData,
    sourceComparisons,
    metadata: {
      timeRange: { start: '', end: '' }, // Calculate from all sources
      sourceCount: sources.size,
      alignmentMethod: 'concatenation' // Placeholder
    }
  };
};
