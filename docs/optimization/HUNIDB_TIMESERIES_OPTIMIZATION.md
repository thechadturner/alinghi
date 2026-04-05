# HuniDB Time-Series Optimization Guide

**Note:** Timeseries are **no longer cached in HuniDB** in RaceSight. This doc describes the HuniDB library’s time-series capabilities; the app uses the channel-values API plus **unifiedDataStore in-memory** caches ([`docs/frontend/data-caching-policy.md`](../frontend/data-caching-policy.md)). See `HUNIDB_CACHING_AND_INDEXING.md` for current HuniDB usage in RaceSight.

## Overview

HuniDB includes specialized optimizations for time-series data, designed for high-volume append operations, efficient range queries, and bulk data management.

## Architecture

### Table Structure

Time-series tables use an optimized schema:

```sql
CREATE TABLE timeseries_data (
  timestamp INTEGER NOT NULL,  -- Unix timestamp in milliseconds
  value REAL NOT NULL,          -- Or TEXT/INTEGER/BLOB
  tags TEXT,                    -- JSON string for metadata/tags
  PRIMARY KEY (timestamp, value)
);

CREATE INDEX idx_timeseries_data_timestamp ON timeseries_data(timestamp DESC);
```

**Key Design Decisions:**
1. **Timestamp as Primary Key Component**: Enables fast range queries
2. **Descending Index**: Optimizes queries for recent data (most common use case)
3. **Separate Value Column**: Flexible storage for numeric, text, or JSON values
4. **Tags as JSON**: Efficient filtering without separate tables

### Bulk Insert Optimization

**Chunked Insertion:**
- Points are sorted by timestamp before insertion
- Inserted in configurable chunks (default: 1000 points)
- All chunks wrapped in a single transaction
- Uses `INSERT OR IGNORE` to handle duplicates gracefully

**Performance:**
- Typical throughput: 10,000-50,000 points/second
- Scales linearly with chunk size (up to ~1000 points/chunk optimal)
- Transaction overhead amortized across chunks

### Query Optimization

**Time-Range Queries:**
- Index on timestamp enables fast range scans
- Supports filtering by tags using JSON extraction
- Efficient LIMIT/OFFSET for pagination
- Optional ordering (ASC/DESC)

**Aggregation (Downsampling):**
- Built-in aggregation functions: `avg`, `sum`, `min`, `max`, `count`
- Configurable time intervals (e.g., 1 minute, 5 minutes, 1 hour)
- Reduces data volume for visualization
- Uses SQL GROUP BY with timestamp bucketing

### Retention Policies

**Automatic Cleanup:**
- Delete data older than specified timestamp
- Efficient bulk deletion using indexed timestamp
- Returns count of deleted points
- Can be scheduled for automatic cleanup

## Best Practices

### 1. Bulk Insert Strategy

**For High-Volume Data:**
```typescript
// Sort points before insertion (already done internally)
const points = generatePoints(100000);
await db.timeseries({ tableName: 'sensor_data' }).bulkInsert('sensor_data', points);
```

**Optimal Chunk Size:**
- 1,000 points: Good balance for most use cases
- 5,000 points: For very high throughput (may hit transaction limits)
- 100 points: For real-time streaming (lower latency)

### 2. Index Strategy

**Timestamp Index:**
- Always created automatically (DESC for recent data)
- Essential for range queries
- No additional indexes needed for basic time-series

**Tag Indexing:**
- Only create if you frequently filter by tags
- JSON extraction is slower but more flexible
- Consider separate tag columns if filtering is critical

### 3. Query Patterns

**Recent Data (Most Common):**
```typescript
// Query last hour (uses DESC index efficiently)
const points = await tsTable.queryRange('sensor_data', {
  startTime: Date.now() - (60 * 60 * 1000),
  endTime: Date.now(),
  limit: 1000,
  orderBy: 'DESC'
});
```

**Historical Data:**
```typescript
// Query specific range
const points = await tsTable.queryRange('sensor_data', {
  startTime: startTimestamp,
  endTime: endTimestamp,
  limit: 10000
});
```

**With Tag Filtering:**
```typescript
// Filter by sensor location
const points = await tsTable.queryRange('sensor_data', {
  startTime: startTimestamp,
  endTime: endTimestamp,
  tags: { location: 'room1', sensor: 'temperature' }
});
```

### 4. Aggregation for Visualization

**Downsampling Large Datasets:**
```typescript
// Aggregate to 1-minute averages
const aggregated = await tsTable.aggregate('sensor_data', {
  startTime: startTimestamp,
  endTime: endTimestamp,
  aggregation: {
    function: 'avg',
    interval: 60 * 1000  // 1 minute
  }
});
```

**Benefits:**
- Reduces data points by 60x for 1-minute aggregation
- Faster rendering in charts
- Preserves overall trends

### 5. Retention Management

**Automatic Cleanup:**
```typescript
// Delete data older than 30 days
const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
const deleted = await tsTable.deleteOld('sensor_data', cutoff);
```

**Scheduled Cleanup:**
```typescript
// Run daily cleanup
setInterval(async () => {
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  await tsTable.deleteOld('sensor_data', cutoff);
}, 24 * 60 * 60 * 1000);
```

## Performance Characteristics

### Insert Performance

| Points | Chunk Size | Duration | Throughput |
|--------|-----------|----------|------------|
| 1,000  | 1,000     | ~50ms    | ~20,000 pts/sec |
| 10,000 | 1,000     | ~400ms   | ~25,000 pts/sec |
| 100,000| 1,000     | ~4s      | ~25,000 pts/sec |

*Note: Performance varies based on data size, browser, and storage type*

### Query Performance

- **Range Query (1 hour, 1,000 points)**: ~5-10ms
- **Range Query (1 day, 10,000 points)**: ~20-50ms
- **Range Query (1 week, 100,000 points)**: ~100-200ms
- **Aggregation (1 week → 1-hour buckets)**: ~50-100ms

### Storage Efficiency

- **Per Point Overhead**: ~50-100 bytes (timestamp + value + tags + index)
- **Compression**: Not yet implemented (future enhancement)
- **Partitioning**: Not yet implemented (future enhancement)

## Advanced Patterns

### 1. Multi-Series Storage

Store multiple time-series in one table with tags:

```typescript
// Store temperature and humidity in same table
await tsTable.bulkInsert('sensor_data', [
  { timestamp: Date.now(), value: 22.5, tags: { type: 'temperature', sensor: 's1' } },
  { timestamp: Date.now(), value: 65.0, tags: { type: 'humidity', sensor: 's1' } },
]);

// Query only temperature
const temp = await tsTable.queryRange('sensor_data', {
  startTime, endTime,
  tags: { type: 'temperature' }
});
```

### 2. Hybrid with JSON Tables

Store metadata in JSON tables, time-series in optimized tables:

```typescript
// Metadata in JSON table
await db.json.putDoc('sensors', 's1', {
  id: 's1',
  name: 'Temperature Sensor 1',
  location: 'room1',
  calibration: { offset: 0.5, scale: 1.0 }
});

// Time-series data in optimized table
await tsTable.bulkInsert('sensor_data', points);

// Join for enriched queries
const enriched = await db.hybrid.joinSQLWithJSON({
  sqlTable: 'sensor_data',
  jsonTable: 'sensors',
  joinCondition: 'sensor_data.tags->>"$.sensor" = sensors.id',
  sqlWhere: 'timestamp > ?',
  // ...
});
```

### 3. Streaming Insert Pattern

For real-time data streams:

```typescript
// Buffer points and insert in batches
const buffer: TimeSeriesPoint[] = [];

function addPoint(point: TimeSeriesPoint) {
  buffer.push(point);
  
  if (buffer.length >= 100) {
    // Flush buffer
    tsTable.bulkInsert('sensor_data', buffer.splice(0));
  }
}

// Periodic flush
setInterval(() => {
  if (buffer.length > 0) {
    tsTable.bulkInsert('sensor_data', buffer.splice(0));
  }
}, 1000); // Flush every second
```

## Comparison with Other Approaches

### vs. JSON Tables

**Time-Series Tables:**
- ✅ Faster bulk inserts (10-50x)
- ✅ Optimized for range queries
- ✅ Better for high-volume data
- ✅ Built-in aggregation
- ❌ Less flexible schema

**JSON Tables:**
- ✅ More flexible (arbitrary structure)
- ✅ Better for sparse data
- ✅ Full-text search
- ❌ Slower for time-series patterns

**Recommendation:** Use time-series tables for high-volume, regular-interval data. Use JSON tables for event logs or sparse time-series.

### vs. IndexedDB

**HuniDB Time-Series:**
- ✅ SQL queries and aggregation
- ✅ Better query performance
- ✅ Transaction support
- ✅ Retention policies

**IndexedDB:**
- ✅ Native browser API
- ✅ Larger storage limits
- ❌ No SQL queries
- ❌ Manual aggregation

## Future Enhancements

1. **Partitioning**: Automatic partitioning by day/week/month
2. **Compression**: Automatic compression of old data
3. **Continuous Aggregation**: Pre-computed aggregates
4. **Gap Filling**: Interpolation for missing data points
5. **Streaming Queries**: Real-time query results

## Example Use Cases

### Sensor Data
- Temperature, humidity, pressure sensors
- High-frequency sampling (1-10 Hz)
- Long-term storage (months/years)
- Real-time dashboards

### Application Metrics
- API response times
- Error rates
- User activity
- System performance

### Financial Data
- Stock prices
- Trading volumes
- Market indicators
- Historical analysis

### IoT Device Data
- Device telemetry
- Status updates
- Event logs
- Maintenance records

---

**Status**: Implemented  
**Last Updated**: 2025-11-28  
**Version**: 0.3.0

