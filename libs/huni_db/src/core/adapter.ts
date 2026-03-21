import type { StorageInfo } from '../schema/types.js';
import { StorageError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';
import { IndexedDBStorage } from './indexeddb-storage.js';

/**
 * Storage adapter type
 */
export type StorageType = 'indexeddb' | 'memory';

/**
 * Storage capabilities
 */
export interface StorageCapabilities {
  indexedDB: boolean;
}

/**
 * Detect storage capabilities in the current environment
 */
export async function detectStorageCapabilities(): Promise<StorageCapabilities> {
  const capabilities: StorageCapabilities = {
    indexedDB: false,
  };

  // Check for IndexedDB
  try {
    capabilities.indexedDB = 'indexedDB' in window && window.indexedDB !== null;
    if (capabilities.indexedDB) {
      defaultLogger.debug('IndexedDB is available');
    }
  } catch (error) {
    defaultLogger.debug('IndexedDB not available', error);
  }

  return capabilities;
}

/**
 * Select the best available storage type
 */
export async function selectStorageType(preferred?: StorageType): Promise<StorageType> {
  const capabilities = await detectStorageCapabilities();

  // If a preferred type is specified and available, use it
  if (preferred) {
    switch (preferred) {
      case 'indexeddb':
        if (capabilities.indexedDB) {
          defaultLogger.info('Using preferred storage: indexeddb');
          return 'indexeddb';
        }
        defaultLogger.warn('Preferred storage indexeddb not available, falling back to memory');
        break;
      
      case 'memory':
        defaultLogger.info('Using preferred storage: memory');
        return 'memory';
    }
  }

  // Auto-select best available storage
  // Prefer IndexedDB for reliability and main-thread compatibility
  if (capabilities.indexedDB) {
    defaultLogger.info('Auto-selected storage: indexeddb');
    return 'indexeddb';
  }

  defaultLogger.warn('No persistent storage available, using memory');
  return 'memory';
}

/**
 * Get storage information
 */
export async function getStorageInfo(type: StorageType): Promise<StorageInfo> {
  const info: StorageInfo = {
    type,
    available: true,
  };

  try {
    if (type === 'indexeddb' && 'storage' in navigator) {
      // Get storage quota for IndexedDB
      if ('estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        info.usage = estimate.usage;
        info.quota = estimate.quota;
        if (info.usage && info.quota) {
          info.size = info.usage;
        }
      }
    }
  } catch (error) {
    defaultLogger.warn('Failed to get storage info', error);
  }

  return info;
}

/**
 * Check if storage is available
 */
export async function isStorageAvailable(type: StorageType): Promise<boolean> {
  const capabilities = await detectStorageCapabilities();

  switch (type) {
    case 'indexeddb':
      return capabilities.indexedDB;
    case 'memory':
      return true;
    default:
      return false;
  }
}

/**
 * Get browser information for debugging
 */
export function getBrowserInfo(): { name: string; version: string; userAgent: string } {
  const ua = navigator.userAgent;
  let name = 'Unknown';
  let version = 'Unknown';

  // Detect browser
  if (ua.includes('Chrome') && !ua.includes('Edg')) {
    name = 'Chrome';
    const match = ua.match(/Chrome\/(\d+)/);
    version = match?.[1] ?? 'Unknown';
  } else if (ua.includes('Edg')) {
    name = 'Edge';
    const match = ua.match(/Edg\/(\d+)/);
    version = match?.[1] ?? 'Unknown';
  } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
    name = 'Safari';
    const match = ua.match(/Version\/(\d+)/);
    version = match?.[1] ?? 'Unknown';
  } else if (ua.includes('Firefox')) {
    name = 'Firefox';
    const match = ua.match(/Firefox\/(\d+)/);
    version = match?.[1] ?? 'Unknown';
  }

  return { name, version, userAgent: ua };
}

/**
 * Validate storage compatibility
 */
export async function validateStorageCompatibility(): Promise<void> {
  const capabilities = await detectStorageCapabilities();
  const browserInfo = getBrowserInfo();

  // Check minimum requirements
  if (!capabilities.indexedDB) {
    throw new StorageError(
      'No compatible storage mechanism available. Browser must support IndexedDB.',
      { browserInfo, capabilities }
    );
  }

  defaultLogger.debug('Storage compatibility validated', { browserInfo, capabilities });
}

/**
 * Clear all storage for a database
 */
export async function clearStorage(dbName: string, type: StorageType): Promise<void> {
  try {
    if (type === 'indexeddb') {
      // Clear from our IndexedDB storage store
      try {
        const storage = new IndexedDBStorage();
        await storage.initialize();
        await storage.deleteDatabase(dbName);
        storage.close();
      } catch (error) {
        defaultLogger.debug('Failed to clear from IndexedDB storage store', error);
      }

      // Also try to delete the IndexedDB database (if it exists as a separate database)
      try {
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(dbName);
          request.onsuccess = () => {
            defaultLogger.info(`Cleared IndexedDB storage for database: ${dbName}`);
            resolve();
          };
          request.onerror = () => {
            // Ignore errors - database might not exist
            resolve();
          };
          request.onblocked = () => {
            defaultLogger.warn('Database deletion blocked, close all connections first');
            resolve(); // Don't reject, just warn
          };
        });
      } catch (error) {
        defaultLogger.debug('Failed to delete IndexedDB database', error);
      }
    }
  } catch (error) {
    throw new StorageError(
      `Failed to clear storage for database: ${dbName}`,
      { error, type }
    );
  }
}

