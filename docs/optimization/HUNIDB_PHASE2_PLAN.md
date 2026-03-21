# HuniDB Development Plan - Phase 2 (Performance & Reliability)

**Note:** In Hunico, timeseries, map data, and aggregates are **no longer cached in HuniDB**; the app uses API + in-memory cache for that data. HuniDB is used only for events, metadata, and settings. See `HUNIDB_CACHING_AND_INDEXING.md` for current usage.

## Overview

Phase 2 focuses on performance optimizations, caching strategies, advanced indexing, and observability features to make HuniDB production-ready for high-performance applications.

**Duration**: 3-6 weeks  
**Status**: Starting  
**Version Target**: 0.3.0

## Goals

1. **Write Optimization**: Batch operations and debounced index maintenance
2. **Cache Layers**: Hot KV cache and persistent IndexedDB shadow
3. **Advanced Indexing**: FTS5 full-text search and trigram support
4. **Observability**: Comprehensive metrics and performance monitoring

## Implementation Tasks

### 1. Write Batching System

**Location**: `src/performance/batch.ts`

**Features**:
- Automatic batching of writes within time windows
- Configurable batch size and timeout
- Transaction wrapping for batched operations
- Queue management with backpressure handling

**API**:
```typescript
interface BatchOptions {
  maxSize?: number;      // Max operations per batch (default: 100)
  timeout?: number;      // Max wait time in ms (default: 100)
  autoFlush?: boolean;   // Auto-flush on batch full (default: true)
}

class BatchWriter {
  async add(operation: WriteOperation): Promise<void>;
  async flush(): Promise<void>;
  getQueueSize(): number;
}
```

### 2. Debounced Index Maintenance

**Location**: `src/json/indexer.ts` (enhancement)

**Features**:
- Debounce index updates (wait for batch of changes)
- Queue index operations
- Flush indexes on timeout or batch size
- Reduce write overhead for rapid updates

### 3. Hot KV Cache Layer

**Location**: `src/performance/cache.ts`

**Features**:
- In-memory LRU cache for frequent reads
- Configurable cache size
- Cache invalidation on writes
- Hit/miss statistics
- Optional persistent shadow in IndexedDB

**API**:
```typescript
interface CacheOptions {
  maxSize?: number;           // Max entries (default: 1000)
  ttl?: number;              // Time to live in ms (optional)
  persistent?: boolean;       // Use IndexedDB shadow (default: false)
}

class HotCache {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  invalidate(key: string): void;
  clear(): void;
  getStats(): CacheStats;
}
```

### 4. IndexedDB Shadow Cache

**Location**: `src/performance/shadow.ts`

**Features**:
- Persistent cache in IndexedDB
- Automatic sync with SQLite
- Background sync for hot data
- Fallback for offline scenarios

### 5. FTS5 Full-Text Search

**Location**: `src/json/fts.ts`

**Features**:
- Enable FTS5 extension
- Create FTS5 virtual tables for JSON documents
- Full-text search queries
- Ranking and snippet support

**API**:
```typescript
interface FTSOptions {
  columns?: string[];    // Columns to index (default: all text fields)
  tokenizer?: string;    // FTS5 tokenizer (default: 'unicode61')
}

class FTSIndexer {
  async createFTSIndex(tableName: string, options?: FTSOptions): Promise<void>;
  async search(query: string, options?: SearchOptions): Promise<FTSResult[]>;
  async rebuild(): Promise<void>;
}
```

### 6. Trigram Index Support

**Location**: `src/json/trigram.ts`

**Features**:
- Trigram extraction for partial matching
- Trigram index table
- Fast partial string matching
- Support for LIKE queries with wildcards

### 7. Performance Metrics & Observability

**Location**: `src/performance/metrics.ts` (enhancement)

**Features**:
- Query latency percentiles (p50, p95, p99)
- Write throughput tracking
- Index cardinality monitoring
- Cache hit/miss rates
- Batch operation statistics
- Memory usage tracking

**API**:
```typescript
interface PerformanceMetrics {
  queries: {
    count: number;
    avgLatency: number;
    p50: number;
    p95: number;
    p99: number;
  };
  writes: {
    count: number;
    throughput: number;  // ops/sec
    avgBatchSize: number;
  };
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
  };
  indexes: {
    cardinality: Record<string, number>;
    rebuildCount: number;
  };
}
```

### 8. Database Integration

**Location**: `src/index.ts`

**Add to Database class**:
```typescript
class Database {
  // Performance features
  batch: BatchWriter;
  cache: HotCache;
  fts: FTSIndexer;
  
  // Metrics
  getPerformanceMetrics(): PerformanceMetrics;
  resetMetrics(): void;
}
```

### 9. Configuration Options

**Location**: `src/index.ts` (ConnectOptions)

**Enhance**:
```typescript
interface ConnectOptions {
  // ... existing options
  
  performance?: {
    batch?: BatchOptions;
    cache?: CacheOptions;
    enableFTS?: boolean;
    enableTrigram?: boolean;
  };
}
```

### 10. Examples & Documentation

**Location**: `examples/performance.html`

**Examples**:
- Batch write operations
- Cache usage and statistics
- FTS5 search queries
- Performance metrics dashboard

### 11. Testing

**Location**: `__tests__/performance/`

**Test Coverage**:
- Batch operations
- Cache behavior
- FTS5 search
- Performance metrics
- Load testing

## File Structure

```
libs/huni_db/
├── src/
│   ├── performance/
│   │   ├── index.ts          # Main exports
│   │   ├── batch.ts          # Write batching
│   │   ├── cache.ts          # Hot KV cache
│   │   ├── shadow.ts         # IndexedDB shadow
│   │   ├── metrics.ts        # Performance metrics
│   │   └── observer.ts       # Performance observer
│   ├── json/
│   │   ├── fts.ts            # FTS5 integration
│   │   └── trigram.ts        # Trigram indexing
│   └── index.ts              # Add performance APIs
├── examples/
│   └── performance.html      # Performance test page
└── __tests__/
    └── performance/
        ├── batch.test.ts
        ├── cache.test.ts
        ├── fts.test.ts
        └── metrics.test.ts
```

## Success Criteria

Phase 2 is complete when:

- ✅ Write batching reduces write overhead by >50%
- ✅ Hot cache improves read performance by >80% for hot data
- ✅ FTS5 search works for full-text queries
- ✅ Trigram indexes enable fast partial matching
- ✅ Performance metrics are comprehensive and accurate
- ✅ Examples demonstrate all performance features
- ✅ Test coverage >80% for performance module
- ✅ Documentation is complete

## Implementation Order

1. **Week 1**: Write batching + debounced indexing
2. **Week 2**: Hot KV cache + IndexedDB shadow
3. **Week 3**: FTS5 + trigram indexing
4. **Week 4**: Performance metrics + observability
5. **Week 5**: Testing, examples, documentation
6. **Week 6**: Optimization and polish

## Technical Decisions

1. **Batching Strategy**: Time-based with size limits, auto-flush on full
2. **Cache Strategy**: LRU with optional TTL, IndexedDB for persistence
3. **FTS5**: Use SQLite's built-in FTS5 extension
4. **Trigram**: Client-side extraction, store in index table
5. **Metrics**: Lightweight, minimal overhead, optional detailed tracking

## Dependencies

No new external dependencies required. Uses existing:
- SQLite FTS5 extension (built-in)
- IndexedDB API (browser built-in)
- Performance API (browser built-in)

---

**Status**: Phase 2 - Starting  
**Last Updated**: 2025-11-28  
**Version**: 0.3.0-alpha  
**Author**: Chad Turner

