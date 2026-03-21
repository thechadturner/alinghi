/**
 * Comprehensive TypeScript definitions for SQLite WASM API
 * 
 * These types provide full type safety for the SQLite WASM module,
 * eliminating the need for @ts-ignore comments throughout the codebase.
 */

/**
 * SQLite WASM Heap types
 * The heap can be accessed as a direct TypedArray or as a getter function
 */
export type WasmHeapU8 = Uint8Array | (() => Uint8Array);
export type WasmHeap8 = Int8Array | (() => Int8Array);
export type WasmHeap16 = Int16Array | (() => Int16Array);
export type WasmHeap32 = Int32Array | (() => Int32Array);

/**
 * SQLite WASM Module interface
 * Represents the Emscripten-compiled SQLite module
 */
export interface SQLiteWASMModule {
  /** Allocate memory in WASM heap */
  alloc: (size: number) => number;
  /** Reallocate memory in WASM heap */
  realloc: (ptr: number, size: number) => number;
  /** Deallocate memory in WASM heap */
  dealloc: (ptr: number) => void;
  /** Alternative malloc function */
  _malloc?: (size: number) => number;
  /** Alternative free function */
  _free?: (ptr: number) => void;
  /** Another free function variant */
  free?: (ptr: number) => void;
  /** Alternative malloc function */
  malloc?: (size: number) => number;
  
  /** Heap views - can be direct TypedArrays or getter functions */
  heap8u?: WasmHeapU8;
  heap8?: WasmHeap8;
  heap16?: WasmHeap16;
  heap16u?: Uint16Array | (() => Uint16Array);
  heap32?: WasmHeap32;
  heap32u?: Uint32Array | (() => Uint32Array);
  
  /** Uppercase variants (older API) */
  HEAPU8?: WasmHeapU8;
  HEAP8?: WasmHeap8;
  HEAP16?: WasmHeap16;
  HEAPU16?: Uint16Array | (() => Uint16Array);
  HEAP32?: WasmHeap32;
  HEAPU32?: Uint32Array | (() => Uint32Array);
  
  /** Direct buffer access */
  buffer?: ArrayBuffer;
  memory?: WebAssembly.Memory;
  
  /** Other Emscripten properties */
  ptrSizeof?: number;
  ptrIR?: number;
  bigIntEnabled?: boolean;
  exports?: Record<string, unknown>;
  compileOptionUsed?: (option: string) => boolean;
  pstack?: number;
  sizeofIR?: number;
  heapForSize?: (size: number) => TypedArray;
  functionTable?: unknown[];
}

/**
 * TypedArray union type
 */
type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

/**
 * SQLite C API functions
 */
export interface SQLiteCAPI {
  /** Get SQLite version string */
  sqlite3_libversion: () => string;
  /** Get SQLite version number */
  sqlite3_libversion_number: () => number;
  
  /** Serialize database to memory */
  sqlite3_serialize: (
    db: number | SQLiteOO1Database,
    schema: string,
    flags: number | null,
    size: number | null
  ) => number;
  
  /** Get size of serialized database */
  sqlite3_serialize_size: (db: number | SQLiteOO1Database, schema: string) => number;
  
  /** Get error code from database */
  sqlite3_errcode?: (db: number | SQLiteOO1Database) => number;
  /** Get error message from database */
  sqlite3_errmsg?: (db: number | SQLiteOO1Database) => string;
  
  /** Deserialize database from memory */
  sqlite3_deserialize: (
    db: number | SQLiteOO1Database,
    schema: string,
    data: number,
    szDb: number,
    szBuf: number,
    flags: number
  ) => number;
  
  /** Free memory allocated by SQLite */
  sqlite3_free: (ptr: number) => void;
}

/**
 * SQLite OO1 Database interface
 */
export interface SQLiteOO1Database {
  /** Execute SQL statement */
  exec(options: { sql: string; bind?: unknown[]; returnValue?: string; rowMode?: string }): unknown;
  exec(sql: string): unknown;
  
  /** Close database connection */
  close(): void;
  close_v2?(): void;
  
  /** Database filename */
  filename: string;
  
  /** Select as arrays */
  selectArrays(sql: string, bind?: unknown[]): unknown[][];
  /** Select as objects */
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[];
  /** Select single value */
  selectValue(sql: string, bind?: unknown[]): unknown;
  
  /** Prepare statement */
  prepare(sql: string): SQLiteStatement;
  
  /** Execute transaction */
  transaction(callback: () => void): void;
  
  /** Export database to Uint8Array */
  export?(): Uint8Array;
  
  /** Internal database handle (pointer) */
  pointer?: number;
  /** Alternative internal handle */
  $$?: number;
  /** Another internal handle variant */
  db?: number | SQLiteOO1Database;
  /** Another internal handle variant */
  _db?: number | SQLiteOO1Database;
}

/**
 * SQLite Statement interface
 */
export interface SQLiteStatement {
  /** Bind parameters */
  bind(values: unknown[]): void;
  /** Step to next row */
  step(): boolean;
  /** Get column value */
  get(index?: number): unknown;
  /** Get column names */
  getColumnNames(): string[];
  /** Finalize statement */
  finalize(): void;
  /** Reset statement */
  reset(): void;
}

/**
 * SQLite Database interface (legacy API)
 */
export interface SQLiteDatabase {
  exec(sql: string | { sql: string; bind?: unknown[] }): void;
  close(): void;
  filename: string;
}

/**
 * Complete SQLite WASM API interface
 */
export interface SQLiteAPI {
  /** Legacy Database constructor */
  Database: new (filename: string, mode?: string) => SQLiteDatabase;
  
  /** C API functions */
  capi: SQLiteCAPI;
  
  /** WASM module */
  wasm?: SQLiteWASMModule;
  
  /** OO1 API (Object-Oriented API v1) */
  oo1: {
    DB: new (filename: string, mode?: string) => SQLiteOO1Database;
  };
  
  /** Version information */
  version?: string;
  
  /** Configuration */
  config?: Record<string, unknown>;
  
  /** Client info */
  client?: string;
  
  /** Script info */
  scriptInfo?: Record<string, unknown>;
  
  /** Error classes */
  WasmAllocError?: new (message: string) => Error;
  SQLite3Error?: new (message: string) => Error;
  
  /** VFS (Virtual File System) */
  vfs?: Record<string, unknown>;
  
  /** Virtual tables */
  vtab?: Record<string, unknown>;
  
  /** Worker API initialization */
  initWorker1API?: () => void;
  
  /** OPFS VFS installation (deprecated) */
  installOpfsSAHPoolVfs?: () => void;
  
  /** Uppercase heap access (legacy) */
  HEAPU8?: WasmHeapU8;
  HEAP8?: WasmHeap8;
}

/**
 * Database handle type - can be a number (pointer) or database object
 */
export type DatabaseHandle = number | SQLiteOO1Database;

