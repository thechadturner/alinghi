# Storage Layer Documentation

## Overview

The storage layer provides abstraction over different storage backends, with IndexedDB as the primary persistent storage mechanism.

## Components

### 1. Storage Adapter (`src/core/adapter.ts`)

Detects storage capabilities and selects the appropriate storage type.

#### Functions

**`detectStorageCapabilities()`**: Detects available storage
```typescript
const capabilities = await detectStorageCapabilities();
// { indexedDB: true }
```

**`selectStorageType(preferred?)`**: Selects storage type
```typescript
const type = await selectStorageType('indexeddb');
// Returns 'indexeddb' or 'memory' (fallback)
```

**`getStorageInfo(dbName, type)`**: Gets storage information
```typescript
const info = await getStorageInfo('mydb', 'indexeddb');
// { type: 'indexeddb', size: 1024, available: true }
```

**`clearStorage(dbName, type)`**: Clears storage
```typescript
await clearStorage('mydb', 'indexeddb');
```

#### Storage Types

- **`indexeddb`**: Persistent storage in IndexedDB (default)
- **`memory`**: In-memory only (no persistence)

### 2. IndexedDB Storage (`src/core/indexeddb-storage.ts`)

Handles persistent storage in IndexedDB.

#### Database Structure

**Database Name**: `hunidb_storage`

**Object Store**: `databases`

**Record Format**:
```typescript
interface StoredDatabase {
  name: string;           // Database name (key)
  data: ArrayBuffer;      // Serialized SQLite database
  timestamp: number;      // Last modified timestamp
  size: number;           // Size in bytes
}
```

#### Methods

**`initialize()`**: Opens IndexedDB connection
```typescript
await storage.initialize();
```

**`saveDatabase(name, data)`**: Saves database
```typescript
await storage.saveDatabase('mydb', uint8Array);
```

**`loadDatabase(name)`**: Loads database
```typescript
const data = await storage.loadDatabase('mydb');
// Returns Uint8Array or null
```

**`listDatabases()`**: Lists all databases
```typescript
const names = await storage.listDatabases();
// Returns string[]
```

**`deleteDatabase(name)`**: Deletes database
```typescript
await storage.deleteDatabase('mydb');
```

**`close()`**: Closes IndexedDB connection
```typescript
await storage.close();
```

## Storage Flow

### Save Flow

```
1. SQLite database in WASM memory
   ↓
2. Serialize using sqlite3_serialize()
   ↓
3. Copy from WASM heap to Uint8Array
   ↓
4. Convert to ArrayBuffer
   ↓
5. Store in IndexedDB
   ↓
6. Free WASM memory
```

### Load Flow

```
1. Read from IndexedDB
   ↓
2. Convert ArrayBuffer to Uint8Array
   ↓
3. Allocate WASM memory
   ↓
4. Copy to WASM heap
   ↓
5. Deserialize using sqlite3_deserialize()
   ↓
6. Free WASM memory (if not auto-freed)
```

## Serialization

### SQLite Serialization

Uses SQLite's built-in serialization API:

```typescript
// Serialize
const pData = capi.sqlite3_serialize(pDb, 'main', null, null);
const size = capi.sqlite3_serialize_size(pDb, 'main');

// Deserialize
const rc = capi.sqlite3_deserialize(
  pDb,
  'main',
  pData,
  size,
  size,
  flags
);
```

### Flags

- **`SQLITE_DESERIALIZE_FREEONCLOSE`**: Free memory on close
- **`SQLITE_DESERIALIZE_RESIZEABLE`**: Allow resizing

## Auto-Save

### Debounced Saves

- **Debounce Time**: 500ms
- **Trigger**: After write operations
- **Manual Save**: `db.flush()` for immediate save

### Save Scheduling

```typescript
// In engine.ts
private scheduleSave(): void {
  if (this.saveTimer) {
    clearTimeout(this.saveTimer);
  }
  this.saveTimer = setTimeout(() => {
    this.saveToIndexedDB();
  }, 500);
}
```

## Database Discovery

### Listing Databases

```typescript
const names = await storage.listDatabases();
// ['db1', 'db2', 'db3']
```

### Discovery Process

1. Open IndexedDB
2. Get all keys from `databases` store
3. Return array of database names

## Error Handling

### Storage Errors

- **Quota Exceeded**: Browser storage limit reached
- **Transaction Errors**: IndexedDB transaction failures
- **Serialization Errors**: Database serialization failures

### Error Recovery

- **Retry Logic**: Automatic retry for transient errors
- **Fallback**: Graceful degradation
- **Logging**: Comprehensive error logging

## Performance Considerations

### Write Performance

- **Debouncing**: Reduces write frequency
- **Batch Writes**: Multiple operations in one transaction
- **Size Limits**: Prevents excessive memory usage

### Read Performance

- **Lazy Loading**: Load on demand
- **Caching**: Cache loaded databases
- **Size Tracking**: Track database sizes

## Storage Limits

### Browser Limits

- **Chrome**: ~60% of disk space
- **Firefox**: ~50% of disk space
- **Safari**: ~1GB per origin

### HuniDB Limits

- **Max Database Size**: 50MB (configurable)
- **Copy Size Limit**: 50MB per operation
- **Connection Limit**: 10 concurrent connections

## Migration

### Database Format Changes

When the storage format changes:

1. **Version Detection**: Check database version
2. **Migration**: Convert old format to new
3. **Backup**: Keep old format as backup
4. **Cleanup**: Remove old format after migration

## Security

### Isolation

- **Origin Scoped**: IndexedDB is origin-scoped
- **No Cross-Origin**: Cannot access other origins
- **Browser Enforced**: Browser handles isolation

### Data Protection

- **No Encryption**: Data stored in plain text
- **Future**: Optional encryption planned
- **Access Control**: Browser-level access control

## Troubleshooting

### Common Issues

1. **Quota Exceeded**
   - Clear old databases
   - Reduce database size
   - Request more storage

2. **Serialization Failures**
   - Check database integrity
   - Verify WASM heap access
   - Check memory availability

3. **Load Failures**
   - Verify database exists
   - Check IndexedDB access
   - Verify data format

## Related Documentation

- [Architecture Overview](./OVERVIEW.md)
- [WASM Utilities](./WASM_UTILITIES.md)
- [Performance Guide](../performance/PERFORMANCE_GUIDE.md)

