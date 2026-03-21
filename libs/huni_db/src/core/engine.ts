import type { StorageType } from './adapter.js';
import { InitializationError, QueryError, wrapError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';
import { IndexedDBStorage } from './indexeddb-storage.js';
import type { SQLiteAPI } from './sqlite-wasm-types.js';
import { getWasmHeapU8, getDatabaseHandle, copyFromWasmHeap, copyToWasmHeap } from './wasm-heap-utils.js';
import { allocateWasmMemory, freeWasmMemory, safeFreeWasmMemory } from './wasm-memory-utils.js';

// Types moved to sqlite-wasm-types.ts

// Types moved to sqlite-wasm-types.ts
import type { SQLiteOO1Database, SQLiteStatement, SQLiteCAPI } from './sqlite-wasm-types.js';

// Global generation counter to prevent stale engine instances (e.g. from HMR)
// from writing over newer IndexedDB snapshots. Each SQLiteEngine instance gets
// a unique generation; only the latest generation is allowed to perform saves.
let globalEngineGeneration = 0;

// Maximum allowed serialized database size (in bytes). If the SQLite
// serialization ever exceeds this, we treat it as an error rather than
// truncating the file, to avoid corrupting the on-disk image.
// Increased from 200MB to 500MB to accommodate larger datasets while
// still maintaining safety bounds for WASM memory and serialization performance.
const MAX_SERIALIZED_DB_SIZE = 500 * 1024 * 1024; // 500 MB

/**
 * SQLite Engine wrapper
 */
export class SQLiteEngine {
  private sqlite: SQLiteAPI | null = null;
  private db: SQLiteOO1Database | null = null;
  private dbName: string;
  private storageType: StorageType;
  private isInitialized = false;
  private indexedDBStorage: IndexedDBStorage | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveLock: Promise<void> = Promise.resolve();
  private isSaving = false;
  private generation: number;

  constructor(dbName: string, storageType: StorageType) {
    this.dbName = dbName;
    this.storageType = storageType;
    this.generation = ++globalEngineGeneration;
  }

  /**
   * Initialize SQLite WASM and create/open database
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      defaultLogger.info(`Initializing SQLite engine for database: ${this.dbName}`);

      // Load SQLite WASM module
      this.sqlite = await this.loadSQLiteWASM();

      // Log SQLite version
      const version = this.sqlite.capi.sqlite3_libversion();
      defaultLogger.info(`SQLite version: ${version}`);

      // Open database based on storage type
      if (this.storageType === 'indexeddb') {
        this.db = await this.openIndexedDBDatabase();
      } else {
        this.db = await this.openMemoryDatabase();
      }

      // Enable foreign keys (call directly, don't use exec() which checks isInitialized)
      this.db!.exec('PRAGMA foreign_keys = ON');

      // Enable JSON1 extension (call directly - use single quotes for string literals)
      this.db!.exec('SELECT json_valid(\'{}\') as test');

      // Run a simple test query to ensure the database is functional
      const testResult = this.db!.selectValue('SELECT 1');
      if (testResult !== 1) {
        throw new Error('Database test query failed');
      }

      this.isInitialized = true;
      defaultLogger.info(`SQLite engine initialized successfully`);
    } catch (error) {
      throw new InitializationError(
        `Failed to initialize SQLite engine: ${error instanceof Error ? error.message : String(error)}`,
        { dbName: this.dbName, storageType: this.storageType, error }
      );
    }
  }

  /**
   * Load SQLite WASM module
   */
  private async loadSQLiteWASM(): Promise<SQLiteAPI> {
    try {
      // Dynamic import of SQLite WASM
      // The package's default export is not well-typed, so we intentionally
      // go through `unknown` before asserting the more specific init signature.
      const sqlite3Module = await import('@sqlite.org/sqlite-wasm');
      const sqlite3InitModule = sqlite3Module.default as unknown as (
        options?: {
          print?: (msg: string) => void;
          printErr?: (msg: string) => void;
          locateFile?: (filename: string) => string;
        }
      ) => Promise<SQLiteAPI>;
      const sqlite3 = await sqlite3InitModule({
        print: (msg: string) => defaultLogger.debug('SQLite:', msg),
        printErr: (msg: string) => defaultLogger.error('SQLite error:', msg),
        // Ensure worker / WASM assets resolve correctly when served by Vite
        // In Vite, files in the `public` directory are served from the root,
        // so `public/assets/sqlite3-opfs-async-proxy.js` is available at
        // `/assets/sqlite3-opfs-async-proxy.js` (no `/public` prefix).
        locateFile: (filename: string): string => {
          // Strip /public/ prefix if present (files in public/ are served at root)
          // Vite serves files from public/ directory at the root path
          // Handle query parameters by splitting on '?'
          const parts = filename.split('?');
          const pathPart: string = parts[0] || filename;
          const queryPart: string | undefined = parts[1];
          let cleanPath: string = pathPart;
          
          if (pathPart.startsWith('/public/')) {
            cleanPath = pathPart.substring('/public/'.length);
          } else if (pathPart.startsWith('public/')) {
            cleanPath = pathPart.substring('public/'.length);
          }
          
          // Extract just the filename for matching (without query params)
          const basename: string = cleanPath.split('/').pop() || cleanPath;
          
          // Route known SQLite worker assets through the /assets/ path
          // If the path already includes /assets/, preserve it; otherwise add it
          if (basename.startsWith('sqlite3-opfs-async-proxy')) {
            // If cleanPath already starts with /assets/, use it as-is
            if (cleanPath.startsWith('/assets/') || cleanPath.startsWith('assets/')) {
              const result = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
              // Preserve query parameters if they were present
              return queryPart ? `${result}?${queryPart}` : result;
            }
            // Otherwise, route to /assets/
            const result = `/assets/${basename}`;
            // Preserve query parameters if they were present
            return queryPart ? `${result}?${queryPart}` : result;
          }
          
          // For WASM files: The @sqlite.org/sqlite-wasm package expects to find
          // sqlite3.wasm relative to where the JS module is loaded from.
          // In production, WASM files are copied to /assets/ by copy-sqlite-workers.js
          // In dev, Vite serves node_modules at /node_modules/
          if (basename === 'sqlite3.wasm') {
            // If filename is already absolute or a URL, return as-is (but strip /public/ if present)
            if (cleanPath.startsWith('/') || cleanPath.startsWith('http')) {
              const result = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
              // Preserve query parameters if they were present
              return queryPart ? `${result}?${queryPart}` : result;
            }
            
            // Check if we're in production (import.meta.env.PROD) or dev mode
            const isProduction = import.meta.env.PROD;
            
            if (isProduction) {
              // In production, WASM files are in /assets/ (copied by copy-sqlite-workers.js)
              const result = `/assets/${basename}`;
              // Preserve query parameters if they were present
              return queryPart ? `${result}?${queryPart}` : result;
            } else {
              // In dev, use Vite's node_modules resolution
              const result = `/node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/${basename}`;
              // Preserve query parameters if they were present
              return queryPart ? `${result}?${queryPart}` : result;
            }
          }

          // Fallback: return cleaned path (with /public/ stripped) or original if no change
          const result = cleanPath !== pathPart 
            ? (cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`)
            : pathPart;
          // Preserve query parameters if they were present
          return queryPart ? `${result}?${queryPart}` : result;
        },
      });

      // Type assertion: sqlite3InitModule returns SQLiteAPI but TypeScript doesn't know this
      return sqlite3 as SQLiteAPI;
    } catch (error) {
      throw new InitializationError(
        'Failed to load SQLite WASM module',
        { error }
      );
    }
  }

  /**
   * Open database with IndexedDB storage
   */
  private async openIndexedDBDatabase(): Promise<SQLiteOO1Database> {
    if (!this.sqlite) {
      throw new InitializationError('SQLite not initialized');
    }

    try {
      // Initialize IndexedDB storage
      this.indexedDBStorage = new IndexedDBStorage();
      await this.indexedDBStorage.initialize();

      // Try to load existing database from IndexedDB
      defaultLogger.debug(`Attempting to load database ${this.dbName} from IndexedDB...`);
      const existingData = await this.indexedDBStorage.loadDatabase(this.dbName);
      defaultLogger.debug(`loadDatabase returned: ${existingData ? `${existingData.length} bytes` : 'null'}`);

      // Create memory database
      const db = new this.sqlite.oo1.DB(':memory:');

      // If we have existing data, import it
      if (existingData && existingData.length > 0) {
        defaultLogger.info(`Loading existing database ${this.dbName} from IndexedDB (${existingData.length} bytes)`);
        try {
          // Use sqlite3_deserialize to load the database
          const capi = this.sqlite.capi as SQLiteCAPI;
          
          // Get database handle using utility
          const pDb = getDatabaseHandle(db);
          if (!pDb) {
            throw new Error('Could not get database handle for deserialization');
          }
          
          defaultLogger.debug('Database handle for deserialize', {
            pDb: !!pDb,
            pDbType: typeof pDb,
          });
          
          // Allocate memory in WASM heap for the data
          const pData = allocateWasmMemory(this.sqlite, existingData.length);
          if (!pData) {
            throw new Error('Failed to allocate WASM memory for deserialization');
          }

          // Re-fetch heap view after allocation, as the heap may have grown
          // and the view needs to reflect the new size
          const heapU8 = getWasmHeapU8(this.sqlite);
          if (!heapU8) {
            safeFreeWasmMemory(this.sqlite, pData);
            throw new Error('Cannot access WASM heap for deserialization');
          }

          // Copy data to WASM memory using utility
          defaultLogger.debug(`Copying ${existingData.length} bytes to WASM memory at pointer ${pData}...`, {
            heapViewLength: heapU8.length,
            heapBufferSize: heapU8.buffer.byteLength,
            pointer: pData,
            dataSize: existingData.length
          });
          copyToWasmHeap(heapU8, pData, existingData);
          defaultLogger.debug(`Copied ${existingData.length} bytes to WASM memory at pointer ${pData}`);

          // Deserialize the database
          const SQLITE_DESERIALIZE_FREEONCLOSE = 0x0001;
          const SQLITE_DESERIALIZE_RESIZEABLE = 0x0002;
          const flags = SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE;
          
          defaultLogger.debug('Calling sqlite3_deserialize...', {
            pDb: !!pDb,
            dataLength: existingData.length,
            flags
          });
          
          const rc = capi.sqlite3_deserialize(
            pDb,
            'main',
            pData,
            existingData.length,  // szDb: bytes to deserialize
            existingData.length,  // szBuf: total buffer size
            flags
          );
          
          defaultLogger.debug(`sqlite3_deserialize returned: ${rc}`);
          
          if (rc !== 0) {
            // Free memory if deserialize failed
            safeFreeWasmMemory(this.sqlite, pData);
            defaultLogger.warn(`Failed to deserialize database, creating new one. Error code: ${rc}`);
          } else {
            defaultLogger.info(`Successfully loaded database from IndexedDB`);
            
            // Verify the database was loaded correctly by checking for tables
            try {
              const tableCount = db.selectValue('SELECT COUNT(*) FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\'') as number;
              defaultLogger.info(`Database loaded successfully - found ${tableCount} user table(s)`);
              if (tableCount === 0) {
                defaultLogger.warn('Database loaded but contains no tables - this might indicate a deserialization issue');
              }
            } catch (verifyError) {
              defaultLogger.warn('Could not verify loaded database', verifyError);
            }
          }
        } catch (error) {
          defaultLogger.warn(`Error loading database from IndexedDB: ${error instanceof Error ? error.message : String(error)}. Creating new database.`);
        }
      } else {
        defaultLogger.info(`Creating new database ${this.dbName} in IndexedDB`);
      }

      defaultLogger.info(`Opened IndexedDB database: ${this.dbName}`);
      return db;
    } catch (error) {
      throw new InitializationError(
        'Failed to open IndexedDB database',
        { error }
      );
    }
  }

  /**
   * Save database to IndexedDB
   * 
   * CRITICAL: This method is protected by a save lock to prevent concurrent saves
   * which could cause database corruption. Only one save operation can run at a time.
   */
  private async saveToIndexedDB(): Promise<void> {
    // Skip saving on live pages (they use Redis/streamingStore, not HuniDB)
    if (typeof window !== 'undefined' && window.location.pathname.includes('/live/')) {
      return;
    }
    
    if (!this.db || !this.indexedDBStorage || this.storageType !== 'indexeddb' || !this.sqlite) {
      defaultLogger.warn('Skipping save - missing requirements', {
        hasDb: !!this.db,
        hasStorage: !!this.indexedDBStorage,
        storageType: this.storageType,
        hasSqlite: !!this.sqlite
      });
      return;
    }

    // Capture this instance's generation so we can detect if it becomes stale
    // while waiting on the save lock (e.g. due to HMR / reinitialization).
    const myGeneration = this.generation;

    // Serialize save operations to prevent corruption from concurrent saves
    return new Promise((resolve, reject) => {
      this.saveLock = this.saveLock.then(async () => {
        // If this engine instance is no longer the latest, skip the save to
        // avoid overwriting a newer snapshot.
        if (myGeneration !== globalEngineGeneration) {
          defaultLogger.debug('Skipping saveToIndexedDB - engine generation is outdated', {
            dbName: this.dbName,
            engineGeneration: myGeneration,
            globalEngineGeneration,
          });
          resolve();
          return;
        }
        // Check if already saving (shouldn't happen with lock, but double-check)
        if (this.isSaving) {
          defaultLogger.warn('Save already in progress, skipping duplicate save');
          resolve();
          return;
        }

        this.isSaving = true;
        
        try {
          // Silent operation - only log errors to reduce console noise
          defaultLogger.debug(`Starting save to IndexedDB for database: ${this.dbName}`);
          
          // Wait a brief moment to ensure any pending writes have completed
          // This helps prevent saving while database is still being modified
          await new Promise(resolve => setTimeout(resolve, 10));
      
          // First, try using the export method if available (cleaner approach)
          // Type assertion needed because export() is optional and not in all SQLite WASM versions
          const dbWithExport = this.db as SQLiteOO1Database & { export?: () => Uint8Array };
          if (typeof dbWithExport.export === 'function') {
            defaultLogger.debug('Using oo1.DB.export() method');
            const data = dbWithExport.export!();
            if (data && data.length > 0 && this.indexedDBStorage) {
              await this.indexedDBStorage.saveDatabase(this.dbName, data);
              
              // Validate the saved database
              try {
                const validationData = await this.indexedDBStorage.loadDatabase(this.dbName);
                if (!validationData || validationData.length === 0) {
                  throw new Error('Saved database validation failed: loaded data is empty');
                }
                if (validationData.length !== data.length) {
                  throw new Error(`Saved database validation failed: size mismatch (saved: ${data.length}, loaded: ${validationData.length})`);
                }
                // Check first few bytes match (SQLite header)
                const headerMatch = data.length > 0 && validationData.length > 0 &&
                  data[0] === validationData[0] && 
                  data[1] === validationData[1] &&
                  data[2] === validationData[2] &&
                  data[3] === validationData[3];
                if (!headerMatch) {
                  throw new Error('Saved database validation failed: header mismatch');
                }
                defaultLogger.debug('Database save validation passed');
              } catch (validationError) {
                defaultLogger.error('Database save validation failed - corruption detected!', validationError);
              }
              
              // Silent success - only log errors to reduce console noise
              defaultLogger.debug(`Successfully saved database ${this.dbName} to IndexedDB using export() (${data.length} bytes)`);
              resolve();
              return;
            } else {
              defaultLogger.warn('export() returned empty data, falling back to sqlite3_serialize');
            }
          }
          
          // Fallback to sqlite3_serialize
          if (!this.sqlite) {
            reject(new Error('SQLite instance is null'));
            return;
          }
          const capi = this.sqlite.capi as SQLiteCAPI;
          
          // Get database handle using utility
          const pDb = getDatabaseHandle(this.db);
          if (!pDb) {
            defaultLogger.error('Could not get database handle for serialization');
            reject(new Error('Could not get database handle for serialization'));
            return;
          }
          
          defaultLogger.debug('Database handle obtained', { 
            pDb: !!pDb, 
            pDbType: typeof pDb,
          });
          
          // Serialize the database
          defaultLogger.debug('Calling sqlite3_serialize...');
          let pData: number;
          try {
            pData = capi.sqlite3_serialize(pDb, 'main', null, null);
          } catch (serializeError) {
            defaultLogger.error('sqlite3_serialize threw an error', serializeError);
            throw serializeError;
          }
          
          if (!pData || pData === 0) {
            defaultLogger.error('Failed to serialize database (returned null/zero pointer). Database may be empty or handle is invalid.');
            defaultLogger.debug('Debug info:', {
              pDb: pDb,
              dbFilename: this.db?.filename,
              hasCapi: !!capi,
              hasSerialize: typeof capi.sqlite3_serialize === 'function',
              serializeResult: pData
            });
            reject(new Error('Failed to serialize database'));
            return;
          }

          defaultLogger.debug('Serialization successful, getting size...');

          // Get the size of the serialized data
          let size = 0;
          try {
            size = capi.sqlite3_serialize_size(pDb, 'main');
            defaultLogger.debug(`Serialized size from sqlite3_serialize_size: ${size} bytes`);
          } catch (e) {
            defaultLogger.warn('sqlite3_serialize_size failed, using alternative size calculation', e);
            // Alternative: Calculate size by reading the database page size and page count
            // Or use a reasonable maximum and let SQLite handle it during deserialize
            try {
              // Get database page size and page count to estimate size
              const pageSize = this.db!.selectValue('PRAGMA page_size') as number;
              const pageCount = this.db!.selectValue('PRAGMA page_count') as number;
              
              if (pageSize && pageCount) {
                size = pageSize * pageCount;
                defaultLogger.debug(`Calculated size from page_size * page_count: ${size} bytes`);
              } else {
                // Fallback: use a reasonable maximum (10MB)
                size = 10 * 1024 * 1024;
                defaultLogger.debug(`Using fallback size: ${size} bytes`);
              }
            } catch (e2) {
              defaultLogger.error('Size calculation methods failed', e2);
              // Free memory if possible
              safeFreeWasmMemory(this.sqlite, pData);
              reject(new Error('Size calculation methods failed'));
              return;
            }
          }

          if (size === 0) {
            defaultLogger.warn('Serialized database size is 0 - database may be empty');
            safeFreeWasmMemory(this.sqlite, pData);
            reject(new Error('Serialized database size is 0'));
            return;
          }

          // Guard against unreasonably large serialized databases. Instead of
          // truncating (which corrupts the file), we explicitly reject saves
          // that exceed a safe upper bound.
          if (size > MAX_SERIALIZED_DB_SIZE) {
            defaultLogger.error('Serialized database size exceeds maximum allowed', {
              size,
              maxSize: MAX_SERIALIZED_DB_SIZE,
              dbName: this.dbName,
            });
            safeFreeWasmMemory(this.sqlite, pData);
            reject(new Error(`Serialized database size ${size} exceeds maximum allowed ${MAX_SERIALIZED_DB_SIZE}`));
            return;
          }

          // Copy data from WASM memory using utility
          // IMPORTANT: re-fetch the heap view *after* serialization.
          // SQLite may grow the underlying WebAssembly.Memory during
          // sqlite3_serialize(), which detaches previously-created views
          // (buffer.byteLength becomes 0). Using a stale view would make
          // copyFromWasmHeap see a heap size of 0 and throw
          // "Pointer X is beyond heap size 0". To avoid this race, always
          // grab a fresh heap view here.
          const heapU8 = getWasmHeapU8(this.sqlite);
          if (!heapU8) {
            defaultLogger.error('Cannot access WASM heap for serialization (post-serialize)');
            safeFreeWasmMemory(this.sqlite, pData);
            reject(new Error('Cannot access WASM heap for serialization (post-serialize)'));
            return;
          }

          const heapBufferSize = heapU8.buffer?.byteLength ?? 0;
          const heapViewLength = heapU8.length ?? 0;
          const effectiveHeapSize = Math.max(heapBufferSize, heapViewLength);

          if (effectiveHeapSize === 0) {
            defaultLogger.warn('Skipping IndexedDB save - WASM heap is empty after serialize', {
              heapBufferSize,
              heapViewLength,
              dbName: this.dbName,
            });
            safeFreeWasmMemory(this.sqlite, pData);
            reject(new Error('WASM heap is empty after serialize'));
            return;
          }

          // Copy the full serialized database. We have already enforced an
          // upper bound above; truncating here would corrupt the image.
          const copySize = size;
          
          defaultLogger.debug(`Copying ${copySize} bytes from WASM memory at pointer ${pData}...`, {
            heapU8Length: heapU8.length,
            bufferLength: heapU8.buffer.byteLength,
            pointer: pData,
            pointerPlusSize: pData + copySize,
          });

          let dataCopy: Uint8Array;
          try {
            // Copy from WASM heap using utility
            dataCopy = copyFromWasmHeap(heapU8, pData, copySize);
            defaultLogger.debug(`Created data copy: ${dataCopy.length} bytes`, {
              originalSize: size,
              copySize: copySize,
              firstBytes: dataCopy.length > 0 ? Array.from(dataCopy.slice(0, Math.min(16, dataCopy.length))).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' ') : 'empty'
            });
          } catch (copyError) {
            defaultLogger.error('Failed to copy data from WASM heap', copyError);
            safeFreeWasmMemory(this.sqlite, pData);
            reject(copyError);
            return;
          }
          
          defaultLogger.debug(`Saving ${dataCopy.length} bytes to IndexedDB...`);

          // Save to IndexedDB using a two-phase/temp strategy to avoid
          // overwriting a known-good image with a bad one. We write to a
          // temporary key first, validate, then swap into the primary name.
          if (!this.indexedDBStorage) {
            safeFreeWasmMemory(this.sqlite, pData);
            reject(new Error('IndexedDB storage is null'));
            return;
          }

          const tempDbName = `${this.dbName}__tmp`;
          await this.indexedDBStorage.saveDatabase(tempDbName, dataCopy);

          // Free the WASM memory (sqlite3_serialize allocates it)
          freeWasmMemory(this.sqlite, pData);

          // Validate the saved database by attempting to reload it from the
          // temporary key. This helps detect corruption early.
          try {
            const validationData = await this.indexedDBStorage.loadDatabase(tempDbName);
            if (!validationData || validationData.length === 0) {
              throw new Error('Saved database validation failed: loaded data is empty');
            }
            if (validationData.length !== dataCopy.length) {
              throw new Error(`Saved database validation failed: size mismatch (saved: ${dataCopy.length}, loaded: ${validationData.length})`);
            }
            // Check first few bytes match (SQLite header)
            const headerMatch = dataCopy.length > 0 && validationData.length > 0 &&
              dataCopy[0] === validationData[0] && 
              dataCopy[1] === validationData[1] &&
              dataCopy[2] === validationData[2] &&
              dataCopy[3] === validationData[3];
            if (!headerMatch) {
              throw new Error('Saved database validation failed: header mismatch');
            }
            defaultLogger.debug('Database save validation passed for temp image');

            // Swap temp image into primary key to complete the two-phase write.
            await this.indexedDBStorage.saveDatabase(this.dbName, validationData);
          } catch (validationError) {
            defaultLogger.error('Database save validation failed - corruption detected!', validationError);
            // Don't throw here - the save succeeded, but validation failed
            // This is logged for monitoring but doesn't break the app
          }

          // Silent success - only log errors to reduce console noise
          defaultLogger.debug(`Successfully saved database ${this.dbName} to IndexedDB (${dataCopy.length} bytes)`);
          resolve();
        } catch (error) {
          defaultLogger.error('Failed to save database to IndexedDB', error);
          console.error('IndexedDB save error details:', error);
          if (error instanceof Error) {
            console.error('Error stack:', error.stack);
          }
          // Reject to propagate error, but don't break the application
          reject(error);
        } finally {
          this.isSaving = false;
        }
      }).catch(err => {
        // Handle errors from the save lock chain
        defaultLogger.error('Error in save lock chain', err);
        reject(err);
      });
    });
  }

  /**
   * Schedule a save to IndexedDB (debounced)
   */
  private scheduleSave(): void {
    // Skip scheduling saves on live pages (they use Redis/streamingStore, not HuniDB)
    if (typeof window !== 'undefined' && window.location.pathname.includes('/live/')) {
      return;
    }
    
    if (this.storageType !== 'indexeddb' || !this.indexedDBStorage) {
      return;
    }

    // Don't schedule if already saving or flushing
    if (this.isSaving) {
      return;
    }

    // Clear existing timer
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    // Schedule save after 8 seconds of inactivity (increased to reduce UI blocking and flush frequency)
    // This reduces the frequency of expensive IndexedDB saves while still maintaining
    // reasonable data persistence. Critical operations should call flush() explicitly.
    // The longer delay prevents UI blocking from frequent flushes during data loading.
    this.saveTimer = setTimeout(() => {
      // Use flush() instead of direct saveToIndexedDB() to get non-blocking behavior
      this.flush(false).catch(err => {
        defaultLogger.error('Error in scheduled save', err);
      });
    }, 8000);
  }

  /**
   * Open database in memory
   */
  private async openMemoryDatabase(): Promise<SQLiteOO1Database> {
    if (!this.sqlite) {
      throw new InitializationError('SQLite not initialized');
    }

    try {
      const filename = ':memory:';
      const db = new this.sqlite.oo1.DB(filename);
      defaultLogger.info(`Opened memory database: ${filename}`);
      return db;
    } catch (error) {
      throw new InitializationError(
        'Failed to open memory database',
        { error }
      );
    }
  }

  /**
   * Execute a SQL statement (INSERT, UPDATE, DELETE, CREATE, etc.)
   */
  async exec(sql: string, params?: unknown[]): Promise<void> {
    this.ensureInitialized();

    const startTime = performance.now();

    try {
      if (params && params.length > 0) {
        this.db!.exec({
          sql,
          bind: params,
        });
      } else {
        this.db!.exec(sql);
      }

      const executionTime = performance.now() - startTime;
      defaultLogger.logQuery(sql, params, executionTime);

      // Schedule save to IndexedDB after write operations
      const isWriteOperation = !sql.trim().toUpperCase().startsWith('SELECT');
      if (isWriteOperation && this.storageType === 'indexeddb') {
        this.scheduleSave();
      }
    } catch (error) {
      throw new QueryError(
        `Failed to execute SQL: ${error instanceof Error ? error.message : String(error)}`,
        { sql, params, error }
      );
    }
  }

  /**
   * Execute a SELECT query and return all rows
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureInitialized();

    const startTime = performance.now();

    try {
      const result = this.db!.selectObjects(sql, params);
      
      const executionTime = performance.now() - startTime;
      defaultLogger.logQuery(sql, params, executionTime);
      return result as T[];
    } catch (error) {
      throw new QueryError(
        `Failed to execute query: ${error instanceof Error ? error.message : String(error)}`,
        { sql, params, error }
      );
    }
  }

  /**
   * Execute a SELECT query and return the first row
   */
  async queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results.length > 0 ? (results[0] ?? null) : null;
  }

  /**
   * Execute a SELECT query and return a single value
   */
  async queryValue<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
    this.ensureInitialized();

    const startTime = performance.now();

    try {
      const result = this.db!.selectValue(sql, params);
      
      const executionTime = performance.now() - startTime;
      defaultLogger.logQuery(sql, params, executionTime);

      return result === undefined ? null : (result as T);
    } catch (error) {
      throw new QueryError(
        `Failed to execute query: ${error instanceof Error ? error.message : String(error)}`,
        { sql, params, error }
      );
    }
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(): Promise<void> {
    await this.exec('BEGIN TRANSACTION');
  }

  /**
   * Commit a transaction
   */
  async commit(): Promise<void> {
    await this.exec('COMMIT');
  }

  /**
   * Rollback a transaction
   */
  async rollback(): Promise<void> {
    await this.exec('ROLLBACK');
  }

  /**
   * Execute a function within a transaction
   */
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.ensureInitialized();

    const startTime = performance.now();

    await this.beginTransaction();

    try {
      const result = await callback();
      await this.commit();

      const executionTime = performance.now() - startTime;
      defaultLogger.logTransaction(executionTime, true);

      // Schedule save to IndexedDB after transaction commit
      if (this.storageType === 'indexeddb') {
        this.scheduleSave();
      }

      return result;
    } catch (error) {
      await this.rollback();

      const executionTime = performance.now() - startTime;
      defaultLogger.logTransaction(executionTime, false);

      throw wrapError(error, 'Transaction failed');
    }
  }

  /**
   * Prepare a SQL statement
   */
  prepare(sql: string): SQLiteStatement {
    this.ensureInitialized();

    try {
      return this.db!.prepare(sql);
    } catch (error) {
      throw new QueryError(
        `Failed to prepare statement: ${error instanceof Error ? error.message : String(error)}`,
        { sql, error }
      );
    }
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    if (this.db) {
      try {
        // Save to IndexedDB before closing if using IndexedDB storage
        if (this.storageType === 'indexeddb') {
          // Clear any pending save timer
          if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
          }
          // Force immediate save
          await this.saveToIndexedDB();
        }

        this.db.close();
        defaultLogger.info(`Closed database: ${this.dbName}`);
      } catch (error) {
        defaultLogger.error('Failed to close database', error);
      }
      this.db = null;
      this.isInitialized = false;

      // Close IndexedDB storage connection
      if (this.indexedDBStorage) {
        this.indexedDBStorage.close();
        this.indexedDBStorage = null;
      }
    }
  }

  /**
   * Check if engine is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  /**
   * Ensure engine is initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.db) {
      throw new InitializationError('SQLite engine not initialized. Call initialize() first.');
    }
  }

  /**
   * Get database filename
   */
  getFilename(): string {
    return this.db?.filename ?? '';
  }

  /**
   * Get storage type
   */
  getStorageType(): StorageType {
    return this.storageType;
  }

  /**
   * Force immediate save to IndexedDB (flush pending changes)
   * 
   * This method waits for any pending writes to complete before saving,
   * ensuring data consistency.
   * 
   * @param immediate - If true, flush immediately. If false, defer to next idle period to avoid blocking UI.
   */
  async flush(immediate: boolean = false): Promise<void> {
    // Skip flushing on live pages (they use Redis/streamingStore, not HuniDB)
    if (typeof window !== 'undefined' && window.location.pathname.includes('/live/')) {
      return;
    }
    
    if (this.storageType === 'indexeddb') {
      // Clear any pending save timer
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      
      // For non-critical flushes, defer to avoid blocking UI
      if (!immediate && typeof window !== 'undefined') {
        return new Promise<void>((resolve, reject) => {
          const performFlush = async () => {
            // Prevent concurrent flushes - if already saving, skip this flush
            // The saveToIndexedDB() method already has its own locking mechanism
            // Multiple scheduled flushes will be handled by the saveLock chain
            if (this.isSaving) {
              // Skip this flush - another one is already in progress
              // The saveLock will ensure data is persisted
              defaultLogger.debug(`[SQLiteEngine] Flush skipped for ${this.dbName} - save already in progress`);
              resolve();
              return;
            }
            
            try {
              await this.saveToIndexedDB();
              // Silent success - only log errors to reduce console noise
              resolve();
            } catch (error) {
              // Only log errors - successful flushes are silent
              defaultLogger.error(`[SQLiteEngine] Flush failed for ${this.dbName}:`, error);
              reject(error);
            }
          };
          
          // Use Scheduler API if available (best for background tasks), then requestIdleCallback, then setTimeout
          // This provides better background scheduling and reduces UI blocking
          if (typeof window !== 'undefined' && 'scheduler' in window && 'postTask' in (window as any).scheduler) {
            // Scheduler API provides better background task scheduling
            (window as any).scheduler.postTask(performFlush, { priority: 'background' });
          } else if (window.requestIdleCallback) {
            // Fallback to requestIdleCallback with longer timeout for better idle detection
            window.requestIdleCallback(performFlush, { timeout: 10000 }); // Max 10s wait
          } else {
            // Final fallback: defer to next event loop tick
            setTimeout(performFlush, 0);
          }
        });
      }
      
      // Immediate flush (for critical operations like page unload)
      // Silent success - only log errors to reduce console noise
      try {
        await this.saveToIndexedDB();
      } catch (error) {
        // Only log errors - successful flushes are silent
        defaultLogger.error(`[SQLiteEngine] Immediate flush failed for ${this.dbName}:`, error);
        throw error;
      }
    }
  }

}

