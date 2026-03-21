# HuniDB Architecture Overview

## Introduction

HuniDB is a high-performance, client-side SQL database library built on SQLite/WASM with IndexedDB persistence. This document provides a comprehensive overview of the architecture, design decisions, and key components.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│  (Database, JSONTable, TimeSeriesTable, BatchWriter)     │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│                  Connection Layer                         │
│  (Connection, ConnectionManager, PreparedStatementCache) │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│                    Engine Layer                           │
│  (SQLiteEngine, WASM Heap/Memory Utilities)              │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│                   Storage Layer                           │
│  (IndexedDBStorage, StorageAdapter)                       │
└───────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Database (`src/index.ts`)

The main entry point for applications. Provides a high-level API for:
- Database connections
- JSON document storage
- Time-series data
- Batch operations
- Caching
- Migrations

**Key Features:**
- Lazy initialization of sub-components
- Automatic cache management
- Connection pooling

### 2. Connection Layer (`src/core/connection.ts`)

Manages database connections with:
- **Connection pooling**: Reuses existing connections
- **Connection limits**: Maximum 10 concurrent connections
- **Query timeouts**: Configurable timeout (default: 30 seconds)
- **Retry logic**: Automatic retry for transient errors
- **Write serialization**: Ensures write operations don't conflict

**ConnectionOptions:**
```typescript
interface ConnectionOptions {
  name: string;
  storage?: 'auto' | StorageType;
  cache?: { statementLimit?: number };
  verbose?: boolean;
  queryTimeout?: number;      // Query timeout in milliseconds
  retryEnabled?: boolean;      // Enable retry for transient errors
  maxRetries?: number;        // Maximum retries (default: 3)
}
```

### 3. Engine Layer (`src/core/engine.ts`)

Wraps the SQLite WASM engine and handles:
- Database initialization
- Query execution
- Transaction management
- Serialization/deserialization
- Auto-save to IndexedDB

**Key Design Decisions:**
- Uses SQLite OO1 API for cleaner interface
- Debounced auto-save (500ms) to reduce IndexedDB writes
- Manual `flush()` method for immediate persistence
- Robust error handling with proper cleanup

### 4. WASM Utilities

#### Heap Access (`src/core/wasm-heap-utils.ts`)

Provides type-safe access to WASM memory heap:
- `getWasmHeapU8()`: Gets Uint8Array view of heap
- `getDatabaseHandle()`: Extracts database pointer
- `copyFromWasmHeap()`: Copies data from WASM memory
- `copyToWasmHeap()`: Copies data to WASM memory

**Why it exists:**
- SQLite WASM API varies (getter functions vs direct properties)
- Handles multiple API versions (lowercase/uppercase, function/direct)
- Ensures type safety and reduces code duplication

#### Memory Management (`src/core/wasm-memory-utils.ts`)

Manages WASM memory allocation/deallocation:
- `allocateWasmMemory()`: Allocates memory in WASM heap
- `freeWasmMemory()`: Frees allocated memory
- `safeFreeWasmMemory()`: Safe wrapper with error handling

**Why it exists:**
- Multiple allocation methods across API versions
- Prevents memory leaks
- Centralized error handling

#### Type Definitions (`src/core/sqlite-wasm-types.ts`)

Comprehensive TypeScript definitions for SQLite WASM API:
- Eliminates `@ts-ignore` comments
- Provides full type safety
- Documents API variations

### 5. Storage Layer

#### IndexedDB Storage (`src/core/indexeddb-storage.ts`)

Handles persistent storage:
- Database serialization/deserialization
- Blob storage in IndexedDB
- Database discovery
- Size tracking

**Storage Format:**
```typescript
interface StoredDatabase {
  name: string;
  data: ArrayBuffer;      // Serialized SQLite database
  timestamp: number;
  size: number;
}
```

#### Storage Adapter (`src/core/adapter.ts`)

Detects and selects storage capabilities:
- IndexedDB detection
- Storage type selection
- Storage info retrieval
- Storage cleanup

**Storage Types:**
- `indexeddb`: Persistent storage (default)
- `memory`: In-memory only (no persistence)

## Data Flow

### Database Open Flow

```
1. Application calls connect()
   ↓
2. ConnectionManager.getConnection()
   ↓
3. Connection.open()
   ↓
4. SQLiteEngine.initialize()
   ↓
5. Load SQLite WASM module
   ↓
6. Check IndexedDB for existing database
   ↓
7. If exists: deserialize into memory database
   If not: create new memory database
   ↓
8. Return Database instance
```

### Write Flow

```
1. Application calls db.exec() or db.json.putDoc()
   ↓
2. Connection.exec() (serialized writes)
   ↓
3. SQLiteEngine.exec()
   ↓
4. Execute SQL in WASM
   ↓
5. Schedule auto-save (debounced 500ms)
   ↓
6. On timeout: serialize database
   ↓
7. Copy from WASM heap to Uint8Array
   ↓
8. Save to IndexedDB
   ↓
9. Free WASM memory
```

### Query Flow

```
1. Application calls db.query()
   ↓
2. Connection.query() (with timeout/retry)
   ↓
3. SQLiteEngine.query()
   ↓
4. Execute query in WASM
   ↓
5. Return results
```

## Error Handling

### Error Hierarchy

```
HuniDBError (base)
├── ConnectionError
├── QueryError
├── MigrationError
├── SchemaError
├── TransactionError
├── StorageError
└── InitializationError
```

### Retry Logic

Automatic retry for transient errors:
- **Transient errors**: Locked, busy, timeout, network errors
- **Exponential backoff**: 100ms → 200ms → 400ms (max 5s)
- **Configurable**: `retryEnabled` and `maxRetries` options

### Error Context

All errors include context for debugging:
```typescript
throw new QueryError('Query failed', {
  sql: 'SELECT * FROM users',
  params: [1, 2, 3],
  error: originalError
});
```

## Performance Optimizations

### 1. Prepared Statement Caching

- Caches up to 200 prepared statements
- Reduces SQL parsing overhead
- Automatic eviction (LRU)

### 2. Batch Writing

- Batches up to 100 operations
- 100ms timeout for auto-flush
- Reduces IndexedDB write overhead

### 3. Hot Cache

- In-memory LRU cache
- Configurable TTL
- Shadow cache in IndexedDB

### 4. Debounced Auto-Save

- 500ms debounce reduces writes
- Manual `flush()` for immediate save
- Prevents excessive IndexedDB operations

### 5. Connection Pooling

- Reuses existing connections
- Maximum 10 connections
- Automatic cleanup on close

## Memory Management

### WASM Memory

- Allocated via `allocateWasmMemory()`
- Freed via `freeWasmMemory()`
- Automatic cleanup on errors
- Size limits to prevent OOM

### JavaScript Memory

- Uint8Array copies for persistence
- Automatic garbage collection
- Cache size limits (LRU eviction)

## Security Considerations

### 1. SQL Injection Prevention

- Parameterized queries only
- No string concatenation
- Type-safe query builders

### 2. Storage Isolation

- IndexedDB is origin-scoped
- No cross-origin access
- Browser-enforced sandboxing

### 3. Error Information

- Errors include context but not sensitive data
- Stack traces in development only
- User-friendly error messages

## Testing Strategy

### Unit Tests
- Core utilities (heap access, memory management)
- Error handling
- Type definitions

### Integration Tests
- End-to-end database operations
- IndexedDB persistence
- Connection management

### Performance Tests
- Batch operations
- Cache performance
- Query execution times

## Future Enhancements

1. **Web Workers**: Move SQLite to worker thread
2. **Compression**: Compress database blobs
3. **Encryption**: Optional encryption at rest
4. **Replication**: Multi-device sync
5. **Query Optimization**: Query planner hints

## Related Documentation

- [WASM Utilities](./WASM_UTILITIES.md)
- [Storage Layer](./STORAGE_LAYER.md)
- [Performance Guide](../performance/PERFORMANCE_GUIDE.md)
- [API Reference](../api/API_REFERENCE.md)

