/**
 * WASM Memory Management Utilities
 * 
 * Provides utilities for allocating and freeing memory in the WASM heap.
 * Handles various API variations for memory management.
 */

import type { SQLiteAPI } from './sqlite-wasm-types.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * Allocate memory in WASM heap
 * 
 * Tries multiple allocation methods:
 * 1. wasm.alloc
 * 2. wasm._malloc
 * 3. wasm.malloc
 * 
 * @param sqlite - SQLite WASM API object
 * @param size - Size in bytes to allocate
 * @returns Pointer to allocated memory, or null if allocation failed
 */
export function allocateWasmMemory(sqlite: SQLiteAPI | null, size: number): number | null {
  if (!sqlite || size <= 0) {
    return null;
  }

  const wasm = sqlite.wasm;
  if (!wasm) {
    defaultLogger.warn('WASM module not available for memory allocation');
    return null;
  }

  // Try alloc (preferred method)
  if (typeof wasm.alloc === 'function') {
    try {
      const ptr = wasm.alloc(size);
      if (ptr && ptr !== 0) {
        return ptr;
      }
    } catch (error) {
      defaultLogger.warn('wasm.alloc failed', error);
    }
  }

  // Try _malloc (alternative)
  if (typeof wasm._malloc === 'function') {
    try {
      const ptr = wasm._malloc(size);
      if (ptr && ptr !== 0) {
        return ptr;
      }
    } catch (error) {
      defaultLogger.warn('wasm._malloc failed', error);
    }
  }

  // Try malloc (another alternative)
  if (typeof wasm.malloc === 'function') {
    try {
      const ptr = wasm.malloc(size);
      if (ptr && ptr !== 0) {
        return ptr;
      }
    } catch (error) {
      defaultLogger.warn('wasm.malloc failed', error);
    }
  }

  defaultLogger.error('All memory allocation methods failed', {
    size,
    hasAlloc: typeof wasm.alloc === 'function',
    hasMalloc: typeof wasm._malloc === 'function',
    hasMallocAlt: typeof wasm.malloc === 'function',
  });

  return null;
}

/**
 * Free memory in WASM heap
 * 
 * Tries multiple deallocation methods:
 * 1. wasm.dealloc (preferred)
 * 2. wasm._free
 * 3. wasm.free
 * 4. capi.sqlite3_free
 * 
 * @param sqlite - SQLite WASM API object
 * @param ptr - Pointer to memory to free
 * @returns true if memory was freed successfully, false otherwise
 */
export function freeWasmMemory(sqlite: SQLiteAPI | null, ptr: number | null): boolean {
  if (!sqlite || !ptr || ptr === 0) {
    return false;
  }

  const wasm = sqlite.wasm;
  const capi = sqlite.capi;

  // Try dealloc (preferred method)
  if (wasm && typeof wasm.dealloc === 'function') {
    try {
      wasm.dealloc(ptr);
      return true;
    } catch (error) {
      defaultLogger.debug('wasm.dealloc failed, trying alternatives', error);
    }
  }

  // Try _free (alternative)
  if (wasm && typeof wasm._free === 'function') {
    try {
      wasm._free(ptr);
      return true;
    } catch (error) {
      defaultLogger.debug('wasm._free failed, trying alternatives', error);
    }
  }

  // Try free (another alternative)
  if (wasm && typeof wasm.free === 'function') {
    try {
      wasm.free(ptr);
      return true;
    } catch (error) {
      defaultLogger.debug('wasm.free failed, trying alternatives', error);
    }
  }

  // Try sqlite3_free (SQLite's own free function)
  if (capi && typeof capi.sqlite3_free === 'function') {
    try {
      capi.sqlite3_free(ptr);
      return true;
    } catch (error) {
      defaultLogger.debug('capi.sqlite3_free failed', error);
    }
  }

  defaultLogger.warn('All memory deallocation methods failed', {
    ptr,
    hasDealloc: wasm && typeof wasm.dealloc === 'function',
    hasFree: wasm && typeof wasm._free === 'function',
    hasFreeAlt: wasm && typeof wasm.free === 'function',
    hasSqliteFree: capi && typeof capi.sqlite3_free === 'function',
  });

  return false;
}

/**
 * Safely free memory with error handling
 * 
 * Wraps freeWasmMemory with try-catch for use in cleanup blocks.
 * 
 * @param sqlite - SQLite WASM API object
 * @param ptr - Pointer to memory to free
 */
export function safeFreeWasmMemory(sqlite: SQLiteAPI | null, ptr: number | null): void {
  try {
    freeWasmMemory(sqlite, ptr);
  } catch (error) {
    defaultLogger.warn('Error freeing WASM memory', {
      ptr,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

