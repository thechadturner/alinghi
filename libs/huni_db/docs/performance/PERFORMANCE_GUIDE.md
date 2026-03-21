# Performance Guide

## Overview

This guide covers performance optimization strategies, best practices, and tuning options for HuniDB.

## Performance Features

### 1. Prepared Statement Caching

**Default**: 200 statements

**Benefits**:
- Reduces SQL parsing overhead
- Faster query execution
- Automatic LRU eviction

**Configuration**:
```typescript
const db = await connect({
  name: 'mydb',
  cache: {
    statementLimit: 500  // Increase for more caching
  }
});
```

### 2. Batch Writing

**Default**: 100 operations, 100ms timeout

**Benefits**:
- Reduces IndexedDB write overhead
- Faster bulk operations
- Automatic batching

**Usage**:
```typescript
const batch = db.batch;
for (const doc of documents) {
  await batch.add({
    type: 'put',
    table: 'users',
    id: doc.id,
    doc: doc
  });
}
await batch.flush(); // Force immediate write
```

### 3. Hot Cache

**Default**: LRU cache with TTL

**Benefits**:
- Faster repeated reads
- Reduced database queries
- Configurable TTL

**Usage**:
```typescript
const cache = db.cache;
await cache.set('user:123', userData, { ttl: 60000 }); // 60s TTL
const user = await cache.get('user:123');
```

### 4. Connection Pooling

**Default**: Maximum 10 connections

**Benefits**:
- Reuses existing connections
- Reduces initialization overhead
- Automatic cleanup

**Configuration**:
```typescript
// Connection limit is fixed at 10
// Connections are automatically reused
const db1 = await connect({ name: 'mydb' });
const db2 = await connect({ name: 'mydb' }); // Reuses db1's connection
```

### 5. Query Timeouts

**Default**: 30 seconds

**Benefits**:
- Prevents hanging queries
- Better error handling
- Configurable per-query

**Usage**:
```typescript
// Global timeout
const db = await connect({
  name: 'mydb',
  queryTimeout: 5000  // 5 seconds
});

// Per-query timeout
const results = await db.query('SELECT * FROM users', [], 10000); // 10 seconds
```

### 6. Retry Logic

**Default**: 3 retries with exponential backoff

**Benefits**:
- Handles transient errors
- Automatic recovery
- Configurable retries

**Usage**:
```typescript
const db = await connect({
  name: 'mydb',
  retryEnabled: true,
  maxRetries: 5
});
```

## Best Practices

### 1. Use Transactions for Multiple Writes

```typescript
// Good: Single transaction
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO users ...');
  await tx.exec('INSERT INTO profiles ...');
  await tx.exec('INSERT INTO settings ...');
});

// Bad: Multiple separate writes
await db.exec('INSERT INTO users ...');
await db.exec('INSERT INTO profiles ...');
await db.exec('INSERT INTO settings ...');
```

### 2. Use Batch Writer for Bulk Operations

```typescript
// Good: Batch writer
const batch = db.batch;
for (const item of items) {
  await batch.add({ type: 'put', ... });
}
await batch.flush();

// Bad: Individual writes
for (const item of items) {
  await db.json.putDoc('table', item.id, item);
}
```

### 3. Use Prepared Statements for Repeated Queries

```typescript
// Good: Prepared statement (automatic caching)
for (const id of ids) {
  await db.query('SELECT * FROM users WHERE id = ?', [id]);
}

// Bad: String concatenation (no caching)
for (const id of ids) {
  await db.query(`SELECT * FROM users WHERE id = '${id}'`);
}
```

### 4. Use Cache for Frequently Accessed Data

```typescript
// Good: Cache hot data
const cache = db.cache;
let user = await cache.get('user:123');
if (!user) {
  user = await db.queryOne('SELECT * FROM users WHERE id = ?', [123]);
  await cache.set('user:123', user, { ttl: 60000 });
}

// Bad: Always query database
const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [123]);
```

### 5. Use Appropriate Indexes

```typescript
// Good: Indexed queries
await db.exec('CREATE INDEX idx_email ON users(email)');
await db.query('SELECT * FROM users WHERE email = ?', [email]);

// Bad: Full table scan
await db.query('SELECT * FROM users WHERE email = ?', [email]); // No index
```

## Performance Tuning

### 1. Increase Statement Cache

For applications with many unique queries:

```typescript
const db = await connect({
  name: 'mydb',
  cache: {
    statementLimit: 500  // Default: 200
  }
});
```

### 2. Adjust Batch Size

For bulk operations:

```typescript
const batch = db.batch;
// Batch size is fixed at 100, but you can control flush timing
await batch.flush(); // Force flush when needed
```

### 3. Tune Cache TTL

For frequently changing data:

```typescript
const cache = db.cache;
await cache.set('key', value, { ttl: 30000 }); // 30 seconds
```

### 4. Disable Retry for Non-Transient Errors

For better error visibility:

```typescript
const db = await connect({
  name: 'mydb',
  retryEnabled: false  // Disable retry
});
```

## Performance Metrics

### Available Metrics

```typescript
import { metricsCollector } from '@hunico/hunidb';

const metrics = metricsCollector.getMetrics();
// {
//   queryCount: 100,
//   totalQueryTime: 500,
//   averageQueryTime: 5,
//   cacheHits: 50,
//   cacheMisses: 50,
//   cacheHitRate: 0.5
// }
```

### Monitoring Performance

```typescript
// Enable verbose logging
const db = await connect({
  name: 'mydb',
  verbose: true  // Logs all queries with timing
});

// Check metrics periodically
setInterval(() => {
  const metrics = metricsCollector.getMetrics();
  console.log('Query performance:', metrics);
}, 60000); // Every minute
```

## Common Performance Issues

### 1. Too Many Small Writes

**Problem**: Many individual writes cause excessive IndexedDB operations

**Solution**: Use batch writer or transactions

### 2. Missing Indexes

**Problem**: Full table scans are slow

**Solution**: Create indexes on frequently queried columns

### 3. Large Result Sets

**Problem**: Loading too much data at once

**Solution**: Use pagination or limit queries

### 4. Cache Misses

**Problem**: Low cache hit rate

**Solution**: Increase cache size or TTL

### 5. Connection Exhaustion

**Problem**: Too many concurrent connections

**Solution**: Reuse connections, close unused ones

## Benchmarking

### Example Benchmark

```typescript
async function benchmark() {
  const db = await connect({ name: 'benchmark' });
  
  // Create table
  await db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT)');
  
  // Benchmark inserts
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    await db.exec('INSERT INTO test (data) VALUES (?)', [`data${i}`]);
  }
  const insertTime = performance.now() - start;
  
  // Benchmark queries
  const queryStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    await db.query('SELECT * FROM test WHERE id = ?', [i]);
  }
  const queryTime = performance.now() - queryStart;
  
  console.log(`Inserts: ${insertTime}ms (${1000/insertTime*1000} ops/s)`);
  console.log(`Queries: ${queryTime}ms (${1000/queryTime*1000} ops/s)`);
}
```

## Related Documentation

- [Architecture Overview](../architecture/OVERVIEW.md)
- [API Reference](../api/API_REFERENCE.md)
- [Error Handling Guide](../guides/ERROR_HANDLING.md)

