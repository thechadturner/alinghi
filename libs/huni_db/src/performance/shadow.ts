/**
 * IndexedDB Shadow Cache
 * 
 * Persistent cache layer using IndexedDB for offline support and persistence
 */

import { defaultLogger } from '../utils/logger.js';

/**
 * Cache entry structure (matches HotCache internal structure)
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

const DB_NAME = 'hunidb_cache';
const STORE_NAME = 'cache_entries';
const DB_VERSION = 1;

/**
 * IndexedDB Shadow Cache
 * 
 * Provides persistent storage for cache entries in IndexedDB
 */
export class IndexedDBShadow {
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
      // Check if IndexedDB is available
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        defaultLogger.warn('IndexedDB not available, shadow cache disabled');
        this.isInitialized = true;
        resolve();
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        defaultLogger.error('Failed to open IndexedDB for shadow cache', request.error);
        this.initPromise = null;
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.isInitialized = true;
        defaultLogger.debug('IndexedDB shadow cache initialized');
        this.initPromise = null;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          defaultLogger.debug('Created IndexedDB object store for shadow cache');
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Get value from IndexedDB
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onerror = () => {
        defaultLogger.error('Failed to get from IndexedDB shadow cache', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        const result = request.result;
        if (result && result.entry) {
          resolve(result.entry.value as T);
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * Set value in IndexedDB
   */
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({
        key,
        entry,
        timestamp: Date.now(),
      });

      request.onerror = () => {
        defaultLogger.error('Failed to set in IndexedDB shadow cache', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Delete value from IndexedDB
   */
  async delete(key: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onerror = () => {
        defaultLogger.error('Failed to delete from IndexedDB shadow cache', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Clear all entries from IndexedDB
   */
  async clear(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => {
        defaultLogger.error('Failed to clear IndexedDB shadow cache', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        defaultLogger.debug('Cleared IndexedDB shadow cache');
        resolve();
      };
    });
  }

  /**
   * Get all keys from IndexedDB
   */
  async getAllKeys(): Promise<string[]> {
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
        defaultLogger.error('Failed to get keys from IndexedDB shadow cache', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result as string[]);
      };
    });
  }

  /**
   * Check if IndexedDB is available
   */
  isAvailable(): boolean {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  /**
   * Close IndexedDB connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.isInitialized = false;
      defaultLogger.debug('Closed IndexedDB shadow cache connection');
    }
  }
}

