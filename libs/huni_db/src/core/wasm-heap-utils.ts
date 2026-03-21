/**
 * WASM Heap Access Utilities
 * 
 * Provides robust, type-safe access to the SQLite WASM module's memory heap.
 * Handles various API variations (getter functions vs direct properties, 
 * lowercase vs uppercase, etc.)
 */

import type { SQLiteAPI, WasmHeapU8 } from './sqlite-wasm-types.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * Check if a buffer is a valid ArrayBuffer or SharedArrayBuffer
 * Helper to avoid TypeScript issues with SharedArrayBuffer type checking
 */
function isValidWasmBuffer(buffer: any): buffer is ArrayBuffer {
  return buffer instanceof ArrayBuffer || 
         (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof (SharedArrayBuffer as any));
}

/**
 * Get Uint8Array view of WASM heap
 * 
 * CRITICAL: With HTTPS + COOP/COEP headers, SQLite WASM uses SharedArrayBuffer,
 * which can become detached after memory growth. Always create fresh views from
 * WebAssembly.Memory.buffer to avoid stale/detached views.
 * 
 * Tries multiple methods to access the heap:
 * 1. wasm.memory.buffer (PREFERRED - always fresh, works with SharedArrayBuffer)
 * 2. wasm.heap8u (lowercase, function or direct)
 * 3. wasm.heap8 (lowercase, function or direct)
 * 4. sqlite.HEAPU8 (uppercase, function or direct)
 * 5. wasm.HEAPU8 (uppercase in wasm, function or direct)
 * 
 * @param sqlite - SQLite WASM API object
 * @returns Uint8Array view of heap, or null if not found
 */
export function getWasmHeapU8(sqlite: SQLiteAPI | null): Uint8Array | null {
  if (!sqlite) {
    return null;
  }

  const wasm = sqlite.wasm;

  // ALWAYS prefer creating a fresh view from the underlying WebAssembly.Memory buffer.
  // This is CRITICAL when HTTPS + COOP/COEP headers are enabled, because:
  // 1. SQLite WASM uses SharedArrayBuffer instead of regular ArrayBuffer
  // 2. When WASM memory grows, existing TypedArray views become detached (byteLength === 0)
  // 3. Creating a new view from memory.buffer gives us the current, valid buffer
  if (wasm?.memory instanceof WebAssembly.Memory) {
    try {
      const buffer = wasm.memory.buffer;
      // Check if buffer is valid (ArrayBuffer or SharedArrayBuffer with size > 0)
      if (buffer && isValidWasmBuffer(buffer)) {
        const byteLength = buffer.byteLength;
        if (byteLength > 0) {
          defaultLogger.debug('Created fresh heap view from WebAssembly.Memory', {
            byteLength,
            isSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && buffer instanceof (SharedArrayBuffer as any),
          });
          return new Uint8Array(buffer);
        } else {
          defaultLogger.warn('WebAssembly.Memory.buffer has zero byteLength (detached)', {
            bufferType: buffer.constructor.name,
          });
        }
      }
    } catch (error) {
      defaultLogger.warn('Error accessing WASM memory buffer', error);
    }
  } else if (wasm) {
    defaultLogger.debug('WebAssembly.Memory not available, falling back to heap properties', {
      hasMemory: !!wasm.memory,
      memoryType: wasm.memory ? typeof wasm.memory : 'undefined',
    });
  }

  // Fallback to heap properties (may be stale/detached with SharedArrayBuffer)
  // Try heap8u (lowercase) - most common in modern API
  if (wasm?.heap8u) {
    const heap = tryGetHeapU8(wasm.heap8u, 'heap8u');
    if (heap) return heap;
  }

  // Try heap8 (lowercase) - alternative
  if (wasm?.heap8) {
    const heap = tryGetHeapU8(wasm.heap8, 'heap8');
    if (heap) return heap;
  }

  // Try HEAPU8 on sqlite object directly (uppercase, older API)
  if ((sqlite as any).HEAPU8) {
    const heap = tryGetHeapU8((sqlite as any).HEAPU8, 'HEAPU8 (sqlite)');
    if (heap) return heap;
  }

  // Try HEAPU8 in wasm object (uppercase in wasm)
  if (wasm?.HEAPU8) {
    const heap = tryGetHeapU8(wasm.HEAPU8, 'HEAPU8 (wasm)');
    if (heap) return heap;
  }

  // Try HEAP8 in wasm object (signed, but we can use it)
  if (wasm?.HEAP8) {
    const heap = tryGetHeapU8(wasm.HEAP8, 'HEAP8 (wasm)');
    if (heap) return heap;
  }

  defaultLogger.warn('Could not find WASM heap Uint8Array', {
    hasWasm: !!wasm,
    hasMemory: !!wasm?.memory,
    wasmKeys: wasm ? Object.keys(wasm).slice(0, 15) : [],
    sqliteKeys: Object.keys(sqlite).slice(0, 15),
  });

  return null;
}

/**
 * Try to get Uint8Array from a heap property (function or direct)
 * 
 * @param heap - Heap property (function or TypedArray)
 * @param name - Name for logging
 * @returns Uint8Array or null
 */
function tryGetHeapU8(heap: WasmHeapU8 | Int8Array | (() => Int8Array), name: string): Uint8Array | null {
  try {
    // If it's a function, call it
    if (typeof heap === 'function') {
      const result = heap();
      if (result instanceof Uint8Array && typeof result.set === 'function') {
        // Guard against detached/zero-length views which can happen after
        // WASM memory growth.
        if (result.buffer?.byteLength > 0 && result.length > 0) {
          return result;
        }
        defaultLogger.warn(`Ignoring ${name} view from function because buffer is detached or zero-length`, {
          length: result.length,
          bufferSize: result.buffer?.byteLength ?? 0,
        });
        return null;
      }
      if (result?.buffer && isValidWasmBuffer(result.buffer)) {
        const view = new Uint8Array(result.buffer);
        if (view.buffer.byteLength > 0 && view.length > 0) {
          return view;
        }
        defaultLogger.warn(`Ignoring ${name} view (from function buffer) because buffer is detached or zero-length`, {
          length: view.length,
          bufferSize: view.buffer.byteLength,
          bufferType: view.buffer.constructor.name,
        });
        return null;
      }
      defaultLogger.debug(`Found ${name} as function, but result is not a valid Uint8Array`, {
        type: result && typeof result,
        constructor: (result as any)?.constructor?.name,
      });
      return null;
    }

    // If it's already a Uint8Array
    if (heap instanceof Uint8Array && typeof heap.set === 'function') {
      if (heap.buffer?.byteLength > 0 && heap.length > 0) {
        return heap;
      }
      defaultLogger.warn(`Ignoring ${name} Uint8Array because buffer is detached or zero-length`, {
        length: heap.length,
        bufferSize: heap.buffer?.byteLength ?? 0,
      });
      return null;
    }

    // If it's an Int8Array, create Uint8Array view
    if (heap instanceof Int8Array) {
      const buffer = heap.buffer;
      if (buffer && isValidWasmBuffer(buffer) && buffer.byteLength > 0) {
        const view = new Uint8Array(buffer);
        if (view.length > 0) {
          return view;
        }
      }
      defaultLogger.warn(`Ignoring ${name} Int8Array-based view because buffer is detached or zero-length`, {
        length: heap.length,
        bufferSize: buffer?.byteLength ?? 0,
        bufferType: buffer?.constructor?.name ?? 'unknown',
      });
      return null;
    }

    // If it has a buffer, try to create Uint8Array from it
    if (heap && typeof heap === 'object' && 'buffer' in heap) {
      const buffer = (heap as any).buffer;
      if (buffer && isValidWasmBuffer(buffer) && buffer.byteLength > 0) {
        const view = new Uint8Array(buffer);
        if (view.length > 0) {
          return view;
        }
      }
      defaultLogger.warn(`Ignoring ${name} buffer-based view because buffer is detached or zero-length`, {
        bufferSize: buffer?.byteLength ?? 0,
        bufferType: buffer?.constructor?.name ?? 'unknown',
      });
      return null;
    }

    defaultLogger.debug(`Found ${name} but it's not a valid TypedArray`, {
      type: typeof heap,
      constructor: (heap as any)?.constructor?.name,
      hasBuffer: !!(heap as any)?.buffer,
    });
  } catch (error) {
    defaultLogger.warn(`Error accessing ${name}`, error);
  }

  return null;
}

/**
 * Get database handle (pointer) from database object
 * 
 * Tries multiple methods to get the internal database pointer:
 * 1. db.pointer
 * 2. db.$$
 * 3. db.db
 * 4. db._db
 * 5. db itself (if it's a number)
 * 
 * @param db - Database object
 * @returns Database handle (pointer) or null
 */
export function getDatabaseHandle(db: any): number | null {
  if (typeof db === 'number') {
    return db;
  }

  if (!db || typeof db !== 'object') {
    return null;
  }

  // Try common property names
  const candidates = ['pointer', '$$', 'db', '_db'];
  
  for (const prop of candidates) {
    const value = db[prop];
    if (typeof value === 'number' && value !== 0) {
      return value;
    }
    // If it's a database object, recurse
    if (value && typeof value === 'object' && value.filename) {
      const nested = getDatabaseHandle(value);
      if (nested) return nested;
    }
  }

  // Last resort: try using db directly (might work for some APIs)
  return null;
}

/**
 * Copy data from WASM heap to a new Uint8Array
 * 
 * @param heapU8 - Uint8Array view of WASM heap
 * @param pointer - Pointer to start of data in WASM memory
 * @param size - Size of data to copy in bytes
 * @returns New Uint8Array with copied data
 * @throws Error if heap or pointer is invalid
 */
export function copyFromWasmHeap(heapU8: Uint8Array, pointer: number, size: number): Uint8Array {
  // Check if heap is valid and not detached
  // With HTTPS + COOP/COEP headers, SQLite WASM uses SharedArrayBuffer,
  // which can become detached (byteLength === 0) after memory growth
  const isValidBuffer = heapU8 && isValidWasmBuffer(heapU8.buffer);
  if (!isValidBuffer) {
    throw new Error('Invalid heap Uint8Array - buffer is not ArrayBuffer or SharedArrayBuffer');
  }

  const heapBufferSize = heapU8.buffer.byteLength;
  const heapViewLength = heapU8.length;

  // Detect detached buffer (happens with SharedArrayBuffer after memory growth)
  if (heapBufferSize === 0 || heapViewLength === 0) {
    throw new Error(`Heap buffer is detached (byteLength: ${heapBufferSize}, length: ${heapViewLength}). This usually means WASM memory grew and the view became stale. Caller should re-fetch the heap view.`);
  }

  if (pointer < 0 || size < 0) {
    throw new Error(`Invalid pointer or size: pointer=${pointer}, size=${size}`);
  }

  const endPointer = pointer + size;

  // Determine the actual available heap size (use the larger of view length or buffer size)
  const availableHeapSize = Math.max(heapViewLength, heapBufferSize);
  
  if (endPointer > availableHeapSize) {
    defaultLogger.warn('Copy size exceeds heap size, truncating', {
      pointer,
      size,
      heapViewLength,
      heapBufferSize,
      availableHeapSize,
      endPointer,
      isSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && heapU8.buffer instanceof (SharedArrayBuffer as any),
    });
    // Truncate to available size
    const availableSize = Math.max(0, availableHeapSize - pointer);
    if (availableSize === 0) {
      throw new Error(`Pointer ${pointer} is beyond heap size ${availableHeapSize}`);
    }
    size = availableSize;
  }

  // If the view doesn't cover the full buffer, create a new view that does
  let heapView = heapU8;
  if (heapViewLength < heapBufferSize && endPointer > heapViewLength) {
    heapView = new Uint8Array(heapU8.buffer);
  }

  // Use subarray for efficiency (creates a view)
  const view = heapView.subarray(pointer, pointer + size);
  
  // Create a copy to ensure data persists after WASM memory is freed
  // This is critical because the source buffer may be SharedArrayBuffer
  return new Uint8Array(view);
}

/**
 * Copy data to WASM heap
 * 
 * @param heapU8 - Uint8Array view of WASM heap
 * @param pointer - Pointer to destination in WASM memory
 * @param data - Data to copy
 * @throws Error if heap or pointer is invalid
 */
export function copyToWasmHeap(heapU8: Uint8Array, pointer: number, data: Uint8Array): void {
  if (!heapU8 || !(heapU8.buffer instanceof ArrayBuffer)) {
    throw new Error('Invalid heap Uint8Array');
  }

  if (pointer < 0 || data.length < 0) {
    throw new Error(`Invalid pointer or data length: pointer=${pointer}, length=${data.length}`);
  }

  // Use buffer.byteLength instead of heapU8.length because the buffer may have grown
  // after memory allocation, but the TypedArray view might not reflect the new size
  const heapBufferSize = heapU8.buffer.byteLength;
  const endPointer = pointer + data.length;

  if (endPointer > heapBufferSize) {
    // If the view length is smaller than buffer size, try to create a new view
    // that covers the full buffer
    if (heapU8.length < heapBufferSize) {
      const fullHeapView = new Uint8Array(heapU8.buffer);
      if (endPointer <= fullHeapView.length) {
        // Use the full view
        fullHeapView.set(data, pointer);
        return;
      }
    }
    throw new Error(`Data size ${data.length} exceeds available heap space at pointer ${pointer} (buffer size: ${heapBufferSize}, view length: ${heapU8.length})`);
  }

  // Copy data into heap
  heapU8.set(data, pointer);
}

