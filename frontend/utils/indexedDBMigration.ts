// IndexedDB Migration Utility
// Handles migration from old single-database structure to new per-class database structure

import { info as logInfo, warn as logWarn, error as logError } from './console';

export const INDEXEDDB_VERSION = '2.0.0'; // New version for dataset_id-based architecture
const VERSION_KEY = 'indexeddb_version';

/**
 * Check if migration is needed by comparing stored version with current version
 */
export function needsMigration(): boolean {
  const storedVersion = localStorage.getItem(VERSION_KEY);
  const needsMig = storedVersion !== INDEXEDDB_VERSION;
  
  if (needsMig) {
    logInfo(`[IndexedDB Migration] Version mismatch. Stored: ${storedVersion}, Current: ${INDEXEDDB_VERSION}`);
  }
  
  return needsMig;
}

/**
 * Clear all IndexedDB data (old and new databases)
 * This is a clean-break migration strategy
 */
export async function clearAllIndexedDBData(): Promise<void> {
  try {
    logInfo('[IndexedDB Migration] Starting clean migration - clearing all IndexedDB data');
    
    // Get list of all databases
    const databases = await indexedDB.databases();
    logInfo(`[IndexedDB Migration] Found ${databases.length} databases`);
    
    // Delete old HunicoDataStore database
    const legacyDbNames = ['HunicoDataStore', 'TeamShareRegressionCache'];
    
    for (const legacyName of legacyDbNames) {
      const legacyDb = databases.find(db => db.name === legacyName);
      if (legacyDb) {
        logInfo(`[IndexedDB Migration] Deleting legacy database: ${legacyName}`);
        await deleteDatabase(legacyName);
      }
    }
    
    // Delete any class-specific databases (Hunico_*)
    const hunicoDbsToDelete = databases.filter(db => db.name?.startsWith('Hunico_'));
    
    for (const db of hunicoDbsToDelete) {
      if (db.name) {
        logInfo(`[IndexedDB Migration] Deleting class database: ${db.name}`);
        await deleteDatabase(db.name);
      }
    }
    
    // Update version in localStorage
    localStorage.setItem(VERSION_KEY, INDEXEDDB_VERSION);
    
    logInfo('[IndexedDB Migration] Migration complete - all IndexedDB data cleared');
    logInfo('[IndexedDB Migration] Fresh data will be fetched from API on next request');
    
  } catch (error) {
    logError('[IndexedDB Migration] Error during migration:', error);
    throw error;
  }
}

/**
 * Helper function to delete a database with proper error handling
 */
async function deleteDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(dbName);
    
    deleteRequest.onsuccess = () => {
      logInfo(`[IndexedDB Migration] Successfully deleted: ${dbName}`);
      resolve();
    };
    
    deleteRequest.onerror = () => {
      logWarn(`[IndexedDB Migration] Could not delete ${dbName}:`, deleteRequest.error);
      // Don't reject - just log the warning and continue
      resolve();
    };
    
    deleteRequest.onblocked = () => {
      logWarn(`[IndexedDB Migration] Delete request for ${dbName} was blocked`);
      // Don't reject - just log the warning and continue
      resolve();
    };
  });
}

/**
 * Get current IndexedDB version from localStorage
 */
export function getCurrentVersion(): string | null {
  return localStorage.getItem(VERSION_KEY);
}

/**
 * Force a migration (useful for debugging or manual reset)
 */
export async function forceMigration(): Promise<void> {
  logInfo('[IndexedDB Migration] Forcing migration...');
  await clearAllIndexedDBData();
}

/**
 * Check and perform migration if needed
 * This should be called on app initialization
 */
export async function checkAndMigrate(): Promise<boolean> {
  if (needsMigration()) {
    logInfo('[IndexedDB Migration] Migration needed, starting...');
    await clearAllIndexedDBData();
    return true;
  }
  return false;
}

