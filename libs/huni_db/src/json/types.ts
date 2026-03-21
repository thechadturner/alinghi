/**
 * JSON Table Types
 * 
 * Type definitions for JSON document storage and querying
 */

/**
 * JSON document stored in database
 */
export interface JSONDocument<T = unknown> {
  id: string;
  doc: T;
  ts: number;
}

/**
 * JSON table options
 */
export interface JSONTableOptions {
  /**
   * Keys to automatically index
   * If not specified, all top-level keys are indexed
   */
  indexedKeys?: string[];
  
  /**
   * Enable full-text search (FTS5)
   */
  enableFTS?: boolean;
  
  /**
   * Enable trigram index for partial matches
   */
  enableTrigram?: boolean;
}

/**
 * JSON filter for querying documents
 */
export interface JSONFilter {
  /**
   * Document must have these keys
   */
  hasKey?: string | string[];
  
  /**
   * Key equals value
   */
  eq?: Record<string, unknown>;
  
  /**
   * Key not equals value
   */
  ne?: Record<string, unknown>;
  
  /**
   * Key greater than value
   */
  gt?: Record<string, unknown>;
  
  /**
   * Key greater than or equal to value
   */
  gte?: Record<string, unknown>;
  
  /**
   * Key less than value
   */
  lt?: Record<string, unknown>;
  
  /**
   * Key less than or equal to value
   */
  lte?: Record<string, unknown>;
  
  /**
   * Key in array of values
   */
  in?: Record<string, unknown[]>;
  
  /**
   * Array contains value
   */
  contains?: Record<string, unknown>;
  
  /**
   * Key matches LIKE pattern
   */
  like?: Record<string, string>;
  
  /**
   * Full-text search match (requires FTS5)
   */
  match?: Record<string, string>;
  
  /**
   * Logical AND - all conditions must match
   */
  and?: JSONFilter[];
  
  /**
   * Logical OR - any condition must match
   */
  or?: JSONFilter[];
  
  /**
   * Logical NOT - condition must not match
   */
  not?: JSONFilter;
  
  /**
   * Limit number of results
   */
  limit?: number;
  
  /**
   * Offset for pagination
   */
  offset?: number;
  
  /**
   * Sort by key (ascending)
   */
  sortAsc?: string | string[];
  
  /**
   * Sort by key (descending)
   */
  sortDesc?: string | string[];
}

/**
 * JSON table metadata
 */
export interface JSONTableMetadata {
  tableName: string;
  indexedKeys: string[];
  hasFTS: boolean;
  hasTrigram: boolean;
  documentCount: number;
}

