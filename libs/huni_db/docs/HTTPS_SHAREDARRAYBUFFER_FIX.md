# HTTPS + SharedArrayBuffer WASM Heap Fix

## Problem

After introducing HTTPS with COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`), SQLite WASM began using **SharedArrayBuffer** instead of regular **ArrayBuffer** for its memory heap. This caused persistent "Pointer X is beyond heap size 0" errors during database flush operations, preventing data from being saved to IndexedDB.

### Root Cause

1. **HTTPS + COOP/COEP enables SharedArrayBuffer**: When these security headers are present, SQLite WASM uses SharedArrayBuffer for better performance and multi-threading support.

2. **SharedArrayBuffer views become detached after memory growth**: When WebAssembly memory grows (via `WebAssembly.Memory.grow()`), existing TypedArray views (like `Uint8Array`) over the old buffer become **detached** - their `buffer.byteLength` becomes 0 and `length` becomes 0.

3. **Stale heap views in serialization**: The `saveToIndexedDB()` method was caching a heap view before calling `sqlite3_serialize()`, which could trigger memory growth. When it later tried to copy from that stale view, it saw heap size 0, causing the error.

4. **Data was not being saved**: Because the flush failed, density-optimized data, time-series data, map data, and other cached data was never persisted to IndexedDB.

## Solution

### 1. Always Create Fresh Heap Views from `WebAssembly.Memory.buffer`

Modified `getWasmHeapU8()` to **always prefer** creating a new `Uint8Array` from `sqlite.wasm.memory.buffer` instead of using potentially stale heap properties like `heap8u` or `HEAPU8`:

```typescript
// ALWAYS prefer creating a fresh view from the underlying WebAssembly.Memory buffer.
if (wasm?.memory instanceof WebAssembly.Memory) {
  try {
    const buffer = wasm.memory.buffer;
    if (buffer && isValidWasmBuffer(buffer)) {
      const byteLength = buffer.byteLength;
      if (byteLength > 0) {
        return new Uint8Array(buffer);
      }
    }
  } catch (error) {
    defaultLogger.warn('Error accessing WASM memory buffer', error);
  }
}
```

### 2. Re-fetch Heap View After Serialization

Modified `saveToIndexedDB()` in `engine.ts` to re-fetch the heap view **after** `sqlite3_serialize()` completes, since that's when memory growth is most likely to occur:

```typescript
// Copy data from WASM memory using utility
// IMPORTANT: re-fetch the heap view *after* serialization.
// SQLite may grow the underlying WebAssembly.Memory during
// sqlite3_serialize(), which detaches previously-created views...
const heapU8 = getWasmHeapU8(this.sqlite);
if (!heapU8) {
  // ... handle error
}
```

### 3. Detect and Reject Detached Buffers

Enhanced `copyFromWasmHeap()` to explicitly check for detached buffers (SharedArrayBuffer or ArrayBuffer with byteLength === 0):

```typescript
const heapBufferSize = heapU8.buffer.byteLength;
const heapViewLength = heapU8.length;

// Detect detached buffer (happens with SharedArrayBuffer after memory growth)
if (heapBufferSize === 0 || heapViewLength === 0) {
  throw new Error(`Heap buffer is detached (byteLength: ${heapBufferSize}, length: ${heapViewLength}). This usually means WASM memory grew and the view became stale. Caller should re-fetch the heap view.`);
}
```

### 4. Support SharedArrayBuffer in Type Checks

Added `isValidWasmBuffer()` helper to handle both ArrayBuffer and SharedArrayBuffer:

```typescript
function isValidWasmBuffer(buffer: any): buffer is ArrayBuffer {
  return buffer instanceof ArrayBuffer || 
         (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof (SharedArrayBuffer as any));
}
```

### 5. Guard Against Zero-Length Heap Views

Updated `tryGetHeapU8()` to reject any heap view whose buffer has zero length:

```typescript
if (result instanceof Uint8Array && typeof result.set === 'function') {
  if (result.buffer?.byteLength > 0 && result.length > 0) {
    return result;
  }
  defaultLogger.warn(`Ignoring ${name} view because buffer is detached or zero-length`, {
    length: result.length,
    bufferSize: result.buffer?.byteLength ?? 0,
    bufferType: result.buffer?.constructor?.name ?? 'unknown',
  });
  return null;
}
```

## Files Changed

- `libs/huni_db/src/core/wasm-heap-utils.ts` - Enhanced heap access to handle SharedArrayBuffer and detect detached buffers
- `libs/huni_db/src/core/engine.ts` - Re-fetch heap view after serialization, add null checks
- `libs/huni_db/src/timeseries/table.ts` - Fix TypeScript generic type assertion

## Testing

After this fix:

1. **Flush operations succeed**: `safeFlush()` calls for `storeDensityOptimizedData`, `storeTimeSeriesData`, `storeMapTrackData`, `updateMapdataWithEventIds`, etc. should no longer throw "Pointer X is beyond heap size 0" errors.

2. **Data is persisted**: Density-optimized chart data, time-series data, map data, and other cached data is now correctly saved to IndexedDB.

3. **Works with and without HTTPS**: The fix handles both regular ArrayBuffer (HTTP) and SharedArrayBuffer (HTTPS + COOP/COEP) scenarios.

## Key Takeaways

- **HTTPS + COOP/COEP changes WASM memory behavior**: SharedArrayBuffer has different detachment semantics than ArrayBuffer.
- **Always use fresh heap views**: Never cache heap views across operations that might grow memory.
- **Re-fetch after serialization**: `sqlite3_serialize()` is a prime candidate for triggering memory growth.
- **Check for detached buffers**: `buffer.byteLength === 0` is the telltale sign of a detached SharedArrayBuffer or ArrayBuffer.

## Related Configuration

The COOP/COEP headers are set in:
- `docker/nginx/nginx-dev.conf` (lines 92-93, 871-872)
- `docker/nginx/nginx-prod.conf` (lines 82-83)
- `vite.config.mjs` (lines 128-129)
- `libs/huni_db/vite.config.ts` (lines 21-22, 94-95)

These headers enable SharedArrayBuffer support, which is required for:
- SQLite WASM OPFS (Origin Private File System) storage
- Multi-threaded WASM operations
- Better performance in modern browsers

## References

- [MDN: SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [MDN: Cross-Origin-Opener-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Opener-Policy)
- [MDN: Cross-Origin-Embedder-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Embedder-Policy)
- [SQLite WASM Documentation](https://sqlite.org/wasm/doc/trunk/index.md)

