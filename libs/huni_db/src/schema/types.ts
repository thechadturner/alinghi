/**
 * SQL data types supported by SQLite
 */
export type SQLDataType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'NULL' | 'JSON';

/**
 * Column constraint types
 */
export type ColumnConstraint = 
  | { type: 'PRIMARY_KEY'; autoIncrement?: boolean }
  | { type: 'NOT_NULL' }
  | { type: 'UNIQUE' }
  | { type: 'DEFAULT'; value: unknown }
  | { type: 'CHECK'; expression: string }
  | { type: 'FOREIGN_KEY'; references: string; onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT'; onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' };

/**
 * Column definition
 */
export interface ColumnDefinition {
  type: SQLDataType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: unknown;
  check?: string;
  references?: string;
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
}

/**
 * Table columns definition
 */
export type TableColumns = Record<string, ColumnDefinition>;

/**
 * Index definition
 */
export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
  where?: string;
}

/**
 * Table options
 */
export interface TableOptions {
  indexes?: IndexDefinition[];
  withoutRowId?: boolean;
  strict?: boolean;
}

/**
 * Complete table schema
 */
export interface TableSchema {
  name: string;
  columns: TableColumns;
  options?: TableOptions;
}

/**
 * Migration definition
 */
export interface Migration {
  version: number;
  up: (sql: MigrationExecutor) => Promise<void>;
  down: (sql: MigrationExecutor) => Promise<void>;
  description?: string;
}

/**
 * Migration executor interface
 */
export interface MigrationExecutor {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Migration record stored in database
 */
export interface MigrationRecord {
  version: number;
  description: string | null;
  applied_at: number;
}

/**
 * Transaction interface
 */
export interface Transaction {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
}

/**
 * Database connection options
 */
export interface ConnectOptions {
  name: string;
  storage?: 'indexeddb' | 'memory';
  cache?: {
    kvSize?: number;
    statementLimit?: number;
  };
  verbose?: boolean;
  performance?: {
    batch?: import('../performance/types.js').BatchOptions;
    cache?: import('../performance/types.js').CacheOptions;
    enableFTS?: boolean;
    enableTrigram?: boolean;
  };
}

/**
 * Storage information
 */
export interface StorageInfo {
  type: 'indexeddb' | 'memory';
  available: boolean;
  size?: number;
  quota?: number;
  usage?: number;
}

/**
 * Query result with metadata
 */
export interface QueryResult<T = unknown> {
  rows: T[];
  rowsAffected: number;
  lastInsertRowId?: number;
}

/**
 * Type helper for inferring row type from table schema
 */
export type InferRowType<T extends TableColumns> = {
  [K in keyof T]: T[K]['type'] extends 'TEXT' ? string :
    T[K]['type'] extends 'INTEGER' ? number :
    T[K]['type'] extends 'REAL' ? number :
    T[K]['type'] extends 'BLOB' ? Uint8Array :
    T[K]['type'] extends 'JSON' ? unknown :
    unknown;
};

/**
 * Type helper for making columns optional based on constraints
 */
export type InferInsertType<T extends TableColumns> = {
  [K in keyof T as T[K]['primaryKey'] extends true 
    ? T[K]['autoIncrement'] extends true 
      ? never 
      : K
    : T[K]['default'] extends undefined
      ? T[K]['notNull'] extends true
        ? K
        : never
      : never
  ]: InferRowType<T>[K];
} & {
  [K in keyof T as T[K]['primaryKey'] extends true 
    ? T[K]['autoIncrement'] extends true 
      ? never 
      : never
    : T[K]['default'] extends undefined
      ? T[K]['notNull'] extends true
        ? never
        : K
      : K
  ]?: InferRowType<T>[K];
};

