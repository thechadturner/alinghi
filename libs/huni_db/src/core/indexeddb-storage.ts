/**
 * IndexedDB Storage Adapter for SQLite
 * 
 * Stores the entire SQLite database file as a blob in IndexedDB
 */

import { defaultLogger } from '../utils/logger.js';
import { StorageError } from '../utils/errors.js';

const DB_NAME = 'hunidb_storage';
const STORE_NAME = 'databases';
const DB_VERSION = 1;

/**
 * IndexedDB Storage for SQLite databases
 */
export class IndexedDBStorage {
  private db: IDBDatabase | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize IndexedDB connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.db) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        defaultLogger.warn('IndexedDB not available');
        reject(new StorageError('IndexedDB is not available'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        defaultLogger.error('Failed to open IndexedDB for storage', request.error);
        this.initPromise = null;
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.isInitialized = true;
        defaultLogger.debug('IndexedDB storage initialized');
        this.initPromise = null;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'name' });
          defaultLogger.debug('Created IndexedDB object store for database storage');
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Load database from IndexedDB
   */
  async loadDatabase(dbName: string): Promise<Uint8Array | null> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(dbName);

      request.onerror = () => {
        defaultLogger.error('Failed to load database from IndexedDB', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        const result = request.result;
        defaultLogger.debug(`IndexedDB get request succeeded for ${dbName}`, {
          hasResult: !!result,
          resultKeys: result ? Object.keys(result) : [],
          hasData: !!(result && result.data),
          dataType: result?.data ? typeof result.data : 'none',
          dataConstructor: result?.data ? result.data.constructor?.name : 'none'
        });
        
        if (result && result.data) {
          // Convert ArrayBuffer to Uint8Array if needed
          let data: Uint8Array;
          if (result.data instanceof ArrayBuffer) {
            data = new Uint8Array(result.data);
            defaultLogger.debug(`Converted ArrayBuffer to Uint8Array (${data.length} bytes)`);
          } else if (result.data instanceof Uint8Array) {
            data = result.data;
            defaultLogger.debug(`Data is already Uint8Array (${data.length} bytes)`);
          } else {
            // Try to convert Blob to ArrayBuffer
            defaultLogger.warn('Unexpected data type in IndexedDB', {
              dataType: typeof result.data,
              constructor: result.data.constructor?.name,
              keys: Object.keys(result.data || {})
            });
            resolve(null);
            return;
          }
          defaultLogger.info(`Loaded database ${dbName} from IndexedDB (${data.length} bytes)`);
          resolve(data);
        } else {
          defaultLogger.debug(`No existing database found for ${dbName}`, {
            hasResult: !!result,
            resultValue: result
          });
          resolve(null);
        }
      };
    });
  }

  /**
   * Save database to IndexedDB
   */
  async saveDatabase(dbName: string, data: Uint8Array): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new StorageError('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      defaultLogger.debug(`Saving database ${dbName} to IndexedDB`, {
        dataLength: data.length,
        byteOffset: data.byteOffset,
        byteLength: data.byteLength,
        bufferLength: data.buffer.byteLength,
        firstBytes: Array.from(data.slice(0, 16)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' ')
      });
      
      // Store as ArrayBuffer for efficiency
      // Make sure we're copying the actual data, not just a view
      let arrayBuffer: ArrayBuffer;
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
        // Data uses the entire buffer, can use it directly
        arrayBuffer = data.buffer;
      } else {
        // Data is a view into a larger buffer, need to copy it
        arrayBuffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        );
      }
      
      defaultLogger.debug(`Prepared ArrayBuffer for storage`, {
        arrayBufferLength: arrayBuffer.byteLength,
        originalDataLength: data.length
      });
      
      const request = store.put({
        name: dbName,
        data: arrayBuffer,
        timestamp: Date.now(),
        size: data.length
      });

      request.onerror = () => {
        const err = request.error;
        // Treat connection-closing errors as non-fatal: data is already in memory,
        // and the browser is tearing down IndexedDB. Just log and resolve.
        if (err && (err.name === 'InvalidStateError' ||
          (typeof err.message === 'string' &&
            err.message.toLowerCase().includes('database connection is closing')))) {
          defaultLogger.warn('IndexedDB save aborted: database connection is closing', {
            name: err.name,
            message: err.message
          });
          resolve();
          return;
        }

        defaultLogger.error('Failed to save database to IndexedDB', err);
        reject(err);
      };

      request.onsuccess = () => {
        defaultLogger.info(`Saved database ${dbName} to IndexedDB (${data.length} bytes)`);
        resolve();
      };
    });
  }

  /**
   * Delete database from IndexedDB
   */
  async deleteDatabase(dbName: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(dbName);

      request.onerror = () => {
        defaultLogger.error('Failed to delete database from IndexedDB', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        defaultLogger.info(`Deleted database ${dbName} from IndexedDB`);
        resolve();
      };
    });
  }

  /**
   * List all databases in IndexedDB
   */
  async listDatabases(): Promise<string[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      request.onerror = () => {
        defaultLogger.error('Failed to list databases from IndexedDB', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        const keys = request.result as string[];
        defaultLogger.debug(`Found ${keys.length} database(s) in IndexedDB storage: ${keys.join(', ')}`);
        resolve(keys);
      };
    });
  }

  /**
   * Close IndexedDB connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
      this.initPromise = null;
    }
  }
}

