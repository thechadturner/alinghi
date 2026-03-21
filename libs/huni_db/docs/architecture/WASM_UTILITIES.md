# WASM Utilities Documentation

## Overview

The WASM utilities provide type-safe, robust access to the SQLite WASM module's memory and API. These utilities handle the complexity of different SQLite WASM API versions and ensure proper memory management.

## Components

### 1. Type Definitions (`sqlite-wasm-types.ts`)

Comprehensive TypeScript definitions for the SQLite WASM API.

#### Key Interfaces

**SQLiteAPI**: Main API interface
```typescript
interface SQLiteAPI {
  capi: SQLiteCAPI;        // C API functions
  wasm?: SQLiteWASMModule; // WASM module
  oo1: { DB: ... };       // OO1 API
}
```

**SQLiteCAPI**: C API functions
```typescript
interface SQLiteCAPI {
  sqlite3_serialize: (db, schema, flags, size) => number;
  sqlite3_serialize_size: (db, schema) => number;
  sqlite3_deserialize: (db, schema, data, size, flags) => number;
  sqlite3_free: (ptr) => void;
  // ... more functions
}
```

**SQLiteWASMModule**: WASM module properties
```typescript
interface SQLiteWASMModule {
  alloc: (size) => number;
  dealloc: (ptr) => void;
  heap8u?: WasmHeapU8;  // Can be function or direct
  heap8?: WasmHeap8;    // Can be function or direct
  // ... more properties
}
```

#### Why Type Definitions?

- **Type Safety**: Eliminates `@ts-ignore` comments
- **IntelliSense**: Better IDE support
- **Documentation**: Self-documenting API
- **Refactoring**: Safer code changes

### 2. Heap Access Utilities (`wasm-heap-utils.ts`)

#### `getWasmHeapU8(sqlite: SQLiteAPI): Uint8Array | null`

Gets a Uint8Array view of the WASM heap.

**Tries multiple methods:**
1. `wasm.heap8u` (lowercase, function or direct)
2. `wasm.heap8` (lowercase, function or direct)
3. `sqlite.HEAPU8` (uppercase, function or direct)
4. `wasm.HEAPU8` (uppercase in wasm, function or direct)

**Example:**
```typescript
const heapU8 = getWasmHeapU8(sqlite);
if (!heapU8) {
  throw new Error('Cannot access WASM heap');
}
```

#### `getDatabaseHandle(db: any): number | null`

Extracts the database handle (pointer) from a database object.

**Tries multiple property names:**
- `db.pointer`
- `db.$$`
- `db.db`
- `db._db`

**Example:**
```typescript
const handle = getDatabaseHandle(db);
if (!handle) {
  throw new Error('Could not get database handle');
}
```

#### `copyFromWasmHeap(heapU8: Uint8Array, pointer: number, size: number): Uint8Array`

Copies data from WASM memory to a new Uint8Array.

**Features:**
- Bounds checking
- Creates independent copy (not a view)
- Error handling

**Example:**
```typescript
const data = copyFromWasmHeap(heapU8, pData, size);
// data is a new Uint8Array, independent of WASM memory
```

#### `copyToWasmHeap(heapU8: Uint8Array, pointer: number, data: Uint8Array): void`

Copies data to WASM memory.

**Features:**
- Bounds checking
- Direct memory write
- Error handling

**Example:**
```typescript
copyToWasmHeap(heapU8, pData, existingData);
// existingData is now in WASM memory at pData
```

### 3. Memory Management Utilities (`wasm-memory-utils.ts`)

#### `allocateWasmMemory(sqlite: SQLiteAPI, size: number): number | null`

Allocates memory in the WASM heap.

**Tries multiple methods:**
1. `wasm.alloc` (preferred)
2. `wasm._malloc`
3. `wasm.malloc`

**Example:**
```typescript
const ptr = allocateWasmMemory(sqlite, data.length);
if (!ptr) {
  throw new Error('Failed to allocate memory');
}
```

#### `freeWasmMemory(sqlite: SQLiteAPI, ptr: number | null): boolean`

Frees allocated WASM memory.

**Tries multiple methods:**
1. `wasm.dealloc` (preferred)
2. `wasm._free`
3. `wasm.free`
4. `capi.sqlite3_free`

**Returns:** `true` if freed successfully, `false` otherwise

**Example:**
```typescript
if (!freeWasmMemory(sqlite, ptr)) {
  defaultLogger.warn('Could not free memory');
}
```

#### `safeFreeWasmMemory(sqlite: SQLiteAPI, ptr: number | null): void`

Safe wrapper that catches errors.

**Use when:**
- In cleanup blocks
- Error handling paths
- When errors should not propagate

**Example:**
```typescript
try {
  // ... operation
} finally {
  safeFreeWasmMemory(sqlite, ptr); // Always frees, even on error
}
```

## API Variations Handled

### Heap Access Variations

1. **Getter Functions**: `heap8u()` returns Uint8Array
2. **Direct Properties**: `heap8u` is Uint8Array
3. **Case Variations**: `heap8u` vs `HEAPU8`
4. **Location Variations**: `wasm.heap8u` vs `sqlite.HEAPU8`

### Memory Management Variations

1. **Allocation**: `alloc`, `_malloc`, `malloc`
2. **Deallocation**: `dealloc`, `_free`, `free`, `sqlite3_free`
3. **Function vs Property**: Some are functions, some are properties

## Usage Patterns

### Serialization Pattern

```typescript
// 1. Get database handle
const pDb = getDatabaseHandle(db);
if (!pDb) throw new Error('No handle');

// 2. Serialize
const pData = capi.sqlite3_serialize(pDb, 'main', null, null);
if (!pData) throw new Error('Serialization failed');

// 3. Get size
const size = capi.sqlite3_serialize_size(pDb, 'main');

// 4. Get heap
const heapU8 = getWasmHeapU8(sqlite);
if (!heapU8) throw new Error('No heap');

// 5. Copy data
const data = copyFromWasmHeap(heapU8, pData, size);

// 6. Free memory
freeWasmMemory(sqlite, pData);
```

### Deserialization Pattern

```typescript
// 1. Get database handle
const pDb = getDatabaseHandle(db);
if (!pDb) throw new Error('No handle');

// 2. Get heap
const heapU8 = getWasmHeapU8(sqlite);
if (!heapU8) throw new Error('No heap');

// 3. Allocate memory
const pData = allocateWasmMemory(sqlite, data.length);
if (!pData) throw new Error('Allocation failed');

try {
  // 4. Copy data to WASM
  copyToWasmHeap(heapU8, pData, data);

  // 5. Deserialize
  const rc = capi.sqlite3_deserialize(pDb, 'main', pData, data.length, data.length, flags);
  if (rc !== 0) throw new Error('Deserialization failed');
} finally {
  // 6. Free memory (if not auto-freed)
  safeFreeWasmMemory(sqlite, pData);
}
```

## Error Handling

All utilities include comprehensive error handling:

1. **Null Checks**: Returns `null` instead of throwing
2. **Bounds Checking**: Validates pointer and size
3. **Type Checking**: Verifies TypedArray types
4. **Fallback Methods**: Tries multiple API variations

## Performance Considerations

1. **Heap Access**: Cached when possible
2. **Memory Copies**: Minimized (use views when safe)
3. **Error Handling**: Fast path for common cases
4. **Type Checking**: Minimal runtime overhead

## Testing

Utilities are tested for:
- All API variations
- Error conditions
- Edge cases (null, zero size, out of bounds)
- Memory leaks

## Related Documentation

- [Architecture Overview](./OVERVIEW.md)
- [Storage Layer](./STORAGE_LAYER.md)
- [Performance Guide](../performance/PERFORMANCE_GUIDE.md)

