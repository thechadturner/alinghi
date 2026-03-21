/**
 * HuniDB Store Type Definitions
 * 
 * Types for the HuniDB-based unified data store
 */

/**
 * Database name mapping function
 * Strips any existing "hunico_" prefix to prevent duplicate prefixes
 */
export function getDatabaseName(className: string): string {
  // Remove any existing "hunico_" prefix (case-insensitive) to prevent duplicates
  const normalized = className.toLowerCase().replace(/^hunico_/i, '');
  return `hunico_${normalized}`;
}

/**
 * Table name helpers for dot notation
 */
export const TableNames = {
  events: 'agg.events',
  targets: 'json.targets',
  objects: 'json.objects',
  densityCharts: 'density.charts' as const,
  densityGroups: 'density.groups' as const,
  /** Deprecated: cloud.data table (may not exist) */
  cloudData: 'cloud.data' as const,
  /** Timeseries base table name; pass default name e.g. 'timeseries_default' */
  timeSeries: (defaultName?: string) => `ts.${defaultName ?? 'timeseries_default'}`,
} as const;

/**
 * Escape table name for SQL (quotes for dot notation)
 */
export function escapeTableName(tableName: string): string {
  return `"${tableName}"`;
}

/**
 * Time-series data point with indexed columns (new schema)
 */
export interface TimeSeriesDataPoint {
  timestamp: number;
  value: number;
  dataset_id: string;
  source_id: string;
  project_id: string;
  date?: string | null;
  metadata?: string; // JSON string for additional fields
}

/**
 * Metadata tables for better data organization
 */
export interface DatasetMetadata {
  dataset_id: string;
  project_id: string;
  date: string;
  source_id: string;
  class_name: string;
  created_at: number;
  row_count?: number;
  first_timestamp?: number;
  last_timestamp?: number;
  date_modified?: number;
  dateModified?: number; // camelCase alias for compatibility
  last_viewed_date?: number;
}

export interface SourceMetadata {
  source_id: string;
  project_id: string;
  source_name?: string;
  color?: string;
  fleet?: number;
  visible?: number;
}

export interface ChannelMetadata {
  channel_name: string;
  data_type?: string; // 'REAL', 'INTEGER', 'TEXT'
  unit?: string;
  description?: string;
  sampling_frequency?: string; // e.g., '20Hz', '10Hz', '1Hz'
}

/**
 * Event entry structure
 */
export interface EventEntry {
  event_id: number;
  event_type: string;
  start_time: string;
  end_time: string;
  tags: any;
}

/**
 * Query filters for time-series data
 */
export interface TimeSeriesFilters {
  twaStates?: string[];
  raceNumbers?: number[];
  legNumbers?: number[];
  grades?: number[];
  timeRange?: {
    start: number;
    end: number;
  };
}

/**
 * Multi-channel query result
 */
export interface MultiChannelResult {
  timestamp: number;
  Datetime?: string;
  [channel: string]: any;
}

/**
 * Density chart entry (chart-specific optimization)
 */
export interface DensityChartEntry {
  id: string; // Hash of (chart_object_id + filters + colorType)
  chartObjectId: string; // Reference to user_objects chart definition
  datasetId: string;
  projectId: string;
  sourceId: string;
  colorType: string; // "DEFAULT", "TACK", "GRADE", "UW/DW"
  chartFilters?: string[]; // ["UPWIND", "DOWNWIND"]
  globalFilters?: {
    states?: string[];
    races?: string[];
    legs?: string[];
    grades?: string[];
  };
  totalPoints?: number;
  optimizedPoints?: number;
  dataHash?: string; // Hash of source data to detect changes
  lastAccessed?: number;
}

/**
 * Density group entry (child of density chart)
 */
export interface DensityGroupEntry {
  id: string;
  chartId: string; // FK to density.charts
  groupName: string; // "Port", "Starboard", "Grade 1", etc.
  color?: string;
  data: any[]; // Optimized data points
  regression?: {
    slope: number;
    intercept: number;
    r2: number;
  };
  tableValues?: Array<{
    x: number;
    y: number;
  }>;
}

/**
 * Target entry
 */
export interface TargetEntry {
  id: string; // Auto-incrementing integer (converted to string for backward compatibility)
  description?: string; // Description field (typically same as name)
  projectId: string;
  name: string;
  isPolar?: number; // 0 or 1
  data: {
    UPWIND?: any;
    DOWNWIND?: any;
    [key: string]: any;
  };
  dateModified?: number;
}

/**
 * Cached sidebar pages entry (per class/project/sidebarState)
 */
export interface SidebarPagesCacheEntry {
  className: string;
  projectId: string;
  sidebarState: string;
  explorePages: any[];
  reportPages: any[];
  timestamp: number;
}

/**
 * Aggregate entry (agg.aggregates table; table no longer used, type for API compatibility)
 */
export interface AggregateEntry {
  [key: string]: any;
}

/**
 * Cloud data entry (cloud.data table; deprecated, type for API compatibility)
 */
export interface CloudDataEntry {
  [key: string]: any;
}

/**
 * Map data entry (map.data table; deprecated, type for API compatibility)
 */
export interface MapDataEntry {
  [key: string]: any;
}

