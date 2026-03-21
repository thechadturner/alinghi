/**
 * Shared TypeScript types for Web Workers
 */

// Base worker message interfaces
export interface WorkerMessage<TData = any, TConfig = any> {
  id: string;
  type: string;
  data: TData;
  config?: TConfig;
  timestamp: number;
}

/** Base worker response; processors may extend with custom type and optional success flag. */
export interface WorkerResponse<TResult = any> {
  id: string;
  /** success | error for generic responses; processors use custom strings (e.g. TIMESERIES_DATA_PROCESSED). */
  type: string;
  result?: TResult;
  error?: string;
  duration?: number;
  /** Optional flag used by some processor responses (e.g. TIMESERIES_DATA_PROCESSED). */
  success?: boolean;
}

// Datetime sorting types
export interface DatetimeSortingConfig {
  // No specific config needed for basic sorting
}

export interface DatetimeSortingResult {
  sortedData: any[];
  processingTime: number;
}

// Data item interfaces
export interface DataItem {
  [key: string]: any;
}

export interface MapDataItem {
  // Original field names (new consistent format)
  Lat?: number;
  Lng?: number;
  Datetime?: string | Date;
  Maneuver_type?: string;
  Twa?: number;
  Tws?: number;
  Twd?: number;
  Bsp?: number;
  Hdg?: number;
  Heading?: number;
  Race_number?: number;
  Leg_number?: number;
  Grade?: number;
  Vmg_perc?: number;
  Vmg?: number;
  Vmc_ratio?: number;
  Period_id?: number;
  Phase_id?: number;
  
  // Legacy field names (for backward compatibility)
  lat?: number;
  lng?: number;
  latitude?: number;
  longitude?: number;
  timestamp?: string;
  datetime?: string;
  time?: string;
  bearing?: number;
  speed?: number;
  cumulativeDistance?: number;
  elevation?: number;
  [key: string]: any;
}

export interface ChartDataItem {
  [key: string]: any;
}

export interface CompressibleDataItem {
  x?: number;
  y?: number;
  Datetime?: string;
  timestamp?: string;
  time?: string;
  [key: string]: any;
}

export interface FilterableDataItem {
  [key: string]: any;
}

export interface ValidatableDataItem {
  [key: string]: any;
}

export interface ParquetDataItem {
  Datetime?: string;
  [key: string]: any;
}

// Filter types
export type FilterOperator = 
  | 'eq' | 'equals' | 'ne' | 'not_equals'
  | 'gt' | 'greater_than' | 'gte' | 'greater_than_or_equal'
  | 'lt' | 'less_than' | 'lte' | 'less_than_or_equal'
  | 'in' | 'in_list' | 'not_in' | 'not_in_list'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'regex' | 'is_null' | 'is_empty' | 'is_not_null' | 'is_not_empty'
  | 'between' | 'not_between' | 'date_between' | 'date_after' | 'date_before'
  | 'custom';

export interface FilterRule {
  field: string;
  operator: FilterOperator;
  value?: any;
  caseSensitive?: boolean;
  customFunction?: (item: any, value: any) => boolean;
}

// Data type definitions
export type DataType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
export type FormatType = 'email' | 'url' | 'uuid' | 'date';
export type ChartType = 
  | 'polar-rose' 
  | 'time-series' 
  | 'scatter' 
  | 'overlay' 
  | 'parallel' 
  | 'probability';

// Compression types
export type CompressionAlgorithm = 
  | 'smart-sampling' 
  | 'uniform-sampling' 
  | 'statistical-sampling' 
  | 'time-based-sampling' 
  | 'metadata-only';

// Aggregation types
export interface AggregationOperation {
  type: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'first' | 'last';
  field: string;
  as?: string;
}

export interface AggregationConfig {
  groupBy: string[];
  operations: AggregationOperation[];
}

// Validation types
export interface FieldSchema {
  type?: DataType;
  required?: boolean;
  nullable?: boolean;
  format?: FormatType;
  min?: number;
  max?: number;
  pattern?: string;
  enum?: any[];
}

export interface ValidationRule {
  name: string;
  field: string;
  validator: (item: ValidatableDataItem, rule: ValidationRule) => boolean | 'warning';
  message: string;
}

export interface ValidationError {
  index: number;
  field: string;
  message: string;
  value: any;
  rule: string;
}

export interface ValidationWarning {
  index: number;
  field: string;
  message: string;
  value: any;
  rule: string;
}

export interface ValidationStatistics {
  totalItems: number;
  validItems: number;
  invalidItems: number;
  fieldErrors: Record<string, number>;
  validationTime: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  statistics: ValidationStatistics;
}

// Map processing types
export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface MapStatistics {
  totalDistance: number;
  averageSpeed: number;
  maxSpeed: number;
  duration: number;
  pointCount: number;
}

export interface MapMetadata {
  originalSize: number;
  processedSize: number;
  frequency: string;
  lastUpdate: number;
  bounds: MapBounds;
  statistics: MapStatistics;
}

export interface MapProcessingResult {
  data: MapDataItem[];
  metadata: MapMetadata;
}

// Chart processing types
export interface PolarRoseData {
  angle: number;
  speed: number;
  count: number;
  maxSpeed: number;
  minSpeed: number;
  speeds: number[];
}

export interface TimeSeriesData {
  x: number;
  y: number;
  timestamp: string;
  value: any;
  count?: number;
}

export interface ScatterData {
  x: number;
  y: number;
  color?: any;
  size?: number;
  group?: any;
}

export interface OverlayData {
  [seriesName: string]: TimeSeriesData[];
}

export interface ParallelData {
  [field: string]: number;
  group?: any;
}

export interface ProbabilityData {
  x: number;
  y: number;
  binStart: number;
  binEnd: number;
  count: number;
  probability: number;
}

// Compression types
export interface CompressionResult {
  data: CompressibleDataItem[];
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  algorithm: CompressionAlgorithm;
  metadata: CompressionMetadata;
}

export interface CompressionMetadata {
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  algorithm: CompressionAlgorithm;
  timestamp: number;
}

export interface FieldStatistics {
  count: number;
  numeric?: boolean;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  unique?: number;
  uniqueCount?: number;
  sample?: any;
  nullCount?: number;
  std?: number;
  type?: string;
}

export interface DataStatistics {
  [field: string]: FieldStatistics;
}

export interface MetadataOnlyItem {
  count: number;
  fields: string[];
  sample: CompressibleDataItem;
  statistics: DataStatistics;
  timestamp: number;
}

// Parquet processing types
export interface ParquetFilter {
  field: string;
  operator: FilterOperator;
  value: any;
}

export interface ParquetMetadata {
  originalCount: number;
  processedCount: number;
  channels: string[];
  timeRange: TimeRange;
  filters: number;
  aggregation: boolean;
  limit: number | null;
}

export interface TimeRange {
  startTime: string | null;
  endTime: string | null;
}

export interface ParquetProcessingResult {
  data: ParquetDataItem[];
  metadata: ParquetMetadata;
}

export interface ColumnInfo {
  name: string;
  type: ColumnType;
  count: number;
  nullCount: number;
  uniqueCount: number;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  std?: number;
}

export type ColumnType = 'number' | 'date' | 'boolean' | 'string' | 'unknown';

export interface TimeBin {
  time: Date;
  count: number;
  items: ParquetDataItem[];
}

export interface ColumnStats {
  count: number;
  nullCount: number;
  uniqueCount: number;
  type: ColumnType;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  std?: number;
}

// Wind data processing types
export interface WindDataItem {
  [key: string]: any;
}

export interface WindProcessingConfig {
  xAxisName?: string;
  yAxisName?: string;
  yAxisInterval?: number;
  binSize?: number;
  validate?: boolean;
}

export interface WindProcessingResult {
  directionBins: Record<string, number[]>;
  speedBinsData: Record<string, Record<number, number>>;
  totalCounts: Record<string, number>;
  maxValue: number;
  speedRange: { min: number; max: number };
  processedCount: number;
  validDataCount: number;
}


// Data filtering processing types
export interface DataFilteringConfig {
  timeRange?: {
    startTime: string | Date;
    endTime: string | Date;
  };
  twaFilters?: {
    states: string[];
    races: any[];
    legs: any[];
    grades: any[];
  };
  raceFilters?: any[];
  legFilters?: any[];
  gradeFilters?: any[];
  mapOperation?: boolean;
  eventIdField?: string;
}

export interface DataFilteringResult {
  data: FilterableDataItem[];
  originalCount: number;
  filteredCount: number;
  processingTime: number;
}

// D3 calculations processing types
export interface D3CalculationsConfig {
  operation: 'PROBABILITY' | 'HISTOGRAM' | 'CATEGORICAL_PROBABILITY' | 'SCALE_CALCULATIONS';
  data: any[];
  options: {
    binCount?: number;
    chartType?: string;
    cumulative?: boolean;
    totalCount?: number;
    scaleType?: 'time' | 'linear';
    domain?: [number, number];
    range?: [number, number];
    channel?: string;
  };
}

export interface D3CalculationsResult {
  processedData: any[];
  statistics: {
    mean: number;
    stdDev: number;
    median: number;
    min: number;
    max: number;
    range: number;
    skewness?: number;
  };
  scales: {
    xScale?: any;
    yScale?: any;
    extent?: [number, number];
  };
  processingTime: number;
}
