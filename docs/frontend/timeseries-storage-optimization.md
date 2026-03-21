# Timeseries Channel Storage Optimization

**Note:** Timeseries are **no longer cached in HuniDB**. This doc is kept for historical context. Current flow: in-memory cache + API only. See `docs/optimization/HUNIDB_CACHING_AND_INDEXING.md` for current HuniDB usage.

## Current Structure Analysis (Historical)

### Previous Implementation (no longer used for timeseries cache)
- **HuniDB**: Had separate table per channel (`ts.Bsp`, `ts.Tws`, etc.); now unused for timeseries.
- **IndexedDB**: Separate entry per channel
- **Storage Pattern**: Each channel stored its own copy of timestamp and metadata

### Storage Overhead
For a dataset with:
- 10 channels (Bsp, Tws, Twa, Twd, Hdg, Lat, Lng, Vmg_perc, etc.)
- 1,000 timestamps
- 6 metadata fields per row (timestamp, dataset_id, source_id, project_id, date, tags)

**Current Storage:**
- 10 tables × 1,000 rows = **10,000 rows**
- Duplicated metadata: 6 fields × 10 channels = **60 duplicated fields per timestamp**
- Total metadata storage: 1,000 timestamps × 60 fields = **60,000 metadata field instances**

## Proposed Optimizations

### Option 1: Single Wide Table (RECOMMENDED)

**Structure:**
```sql
CREATE TABLE "ts.data" (
  timestamp INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT,
  tags TEXT,
  -- Dynamic channel columns (added via ALTER TABLE as needed)
  Bsp REAL,
  Tws REAL,
  Twa REAL,
  Twd REAL,
  Hdg REAL,
  Lat REAL,
  Lng REAL,
  Vmg_perc REAL,
  -- ... more channels as needed
  PRIMARY KEY (timestamp, dataset_id, source_id)
) WITHOUT ROWID;
```

**Benefits:**
- ✅ **10x storage reduction**: 1,000 rows instead of 10,000
- ✅ **10x faster inserts**: 1 INSERT per timestamp instead of 10
- ✅ **No metadata duplication**: Timestamp/metadata stored once per timestamp
- ✅ **Faster multi-channel queries**: Single table scan, no JOINs
- ✅ **SQLite optimized**: NULL values are efficiently stored (1 byte per NULL)
- ✅ **Better index utilization**: Single index on timestamp covers all channels

**Storage Calculation:**
- Current: 10,000 rows × 7 columns = 70,000 cells
- Optimized: 1,000 rows × 17 columns = 17,000 cells
- **Storage reduction: ~76%**

**Insert Performance:**
- Current: 10 separate INSERT statements per timestamp
- Optimized: 1 INSERT statement per timestamp
- **Insert speedup: ~10x** (plus reduced transaction overhead)

**Query Performance:**
- Current: Requires JOIN across 10 tables
- Optimized: Single table scan
- **Query speedup: ~5-10x** for multi-channel queries

**Implementation Notes:**
- Use `ALTER TABLE ADD COLUMN` to add new channels dynamically
- SQLite supports up to 2,000 columns per table (plenty for timeseries channels)
- NULL values are stored efficiently (1 byte per NULL in SQLite)

### Option 2: JSON Column Format

**Structure:**
```sql
CREATE TABLE "ts.data" (
  timestamp INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT,
  tags TEXT,
  channels_json TEXT,  -- {"Bsp": 12.5, "Tws": 15.3, ...}
  PRIMARY KEY (timestamp, dataset_id, source_id)
) WITHOUT ROWID;

-- Index for JSON queries
CREATE INDEX "idx_ts_data_channels_json" 
ON "ts.data"(json_extract(channels_json, '$.Bsp'));
```

**Benefits:**
- ✅ **No schema changes**: New channels added automatically
- ✅ **Similar storage reduction**: 1,000 rows instead of 10,000
- ✅ **Flexible**: Easy to add/remove channels
- ✅ **Can index**: SQLite JSON functions support indexing

**Trade-offs:**
- ⚠️ **JSON parsing overhead**: Slightly slower queries
- ⚠️ **Less efficient**: JSON strings larger than individual columns
- ⚠️ **Index complexity**: Need separate indexes per channel if needed

**Storage Calculation:**
- JSON overhead: ~2-3 bytes per channel value (JSON syntax)
- For 10 channels: ~20-30 bytes extra per row vs wide table
- Still much better than current structure

### Option 3: Hybrid Normalized Structure

**Structure:**
```sql
-- Timestamp table (one row per timestamp)
CREATE TABLE "ts.timestamps" (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT,
  tags TEXT,
  UNIQUE(timestamp, dataset_id, source_id)
);

-- Values table (one row per channel value)
CREATE TABLE "ts.values" (
  timestamp_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (timestamp_id, channel),
  FOREIGN KEY (timestamp_id) REFERENCES "ts.timestamps"(id)
);
```

**Benefits:**
- ✅ **Fully normalized**: No duplication at all
- ✅ **Flexible**: Easy to add new channels
- ✅ **Efficient for sparse data**: Only stores channels that have values

**Trade-offs:**
- ⚠️ **JOIN overhead**: Requires JOIN for queries
- ⚠️ **More complex queries**: Need to JOIN tables
- ⚠️ **Slower inserts**: Two INSERT statements per timestamp

## Recommendation

**Use Option 1 (Single Wide Table)** for the following reasons:

1. **Fastest storage**: 10x fewer rows, 1 INSERT per timestamp
2. **Fastest queries**: Single table scan, no JOINs
3. **SQLite optimized**: NULL values stored efficiently
4. **Proven pattern**: Similar to your `map.data` table structure
5. **Easy migration**: Can migrate existing data channel by channel

## Migration Strategy

### Phase 1: Create New Wide Table
```sql
CREATE TABLE "ts.data" (
  timestamp INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT,
  tags TEXT,
  PRIMARY KEY (timestamp, dataset_id, source_id)
) WITHOUT ROWID;
```

### Phase 2: Add Channel Columns
```sql
-- Add columns for existing channels
ALTER TABLE "ts.data" ADD COLUMN Bsp REAL;
ALTER TABLE "ts.data" ADD COLUMN Tws REAL;
ALTER TABLE "ts.data" ADD COLUMN Twa REAL;
-- ... etc
```

### Phase 3: Migrate Data
```sql
-- For each timestamp, insert all channel values in one row
INSERT INTO "ts.data" (timestamp, dataset_id, source_id, project_id, date, tags, Bsp, Tws, Twa, ...)
SELECT 
  t.timestamp,
  t.dataset_id,
  t.source_id,
  t.project_id,
  t.date,
  t.tags,
  MAX(CASE WHEN t.channel = 'Bsp' THEN t.value END) as Bsp,
  MAX(CASE WHEN t.channel = 'Tws' THEN t.value END) as Tws,
  MAX(CASE WHEN t.channel = 'Twa' THEN t.value END) as Twa,
  -- ... etc
FROM (
  SELECT timestamp, dataset_id, source_id, project_id, date, tags, 'Bsp' as channel, value FROM "ts.Bsp"
  UNION ALL
  SELECT timestamp, dataset_id, source_id, project_id, date, tags, 'Tws' as channel, value FROM "ts.Tws"
  -- ... etc
) t
GROUP BY timestamp, dataset_id, source_id, project_id, date, tags;
```

### Phase 4: Update Code
- Modify `storeTimeSeriesData()` to insert into single table
- Modify `queryDataByChannels()` to query single table
- Add dynamic column creation for new channels

## Performance Estimates

### Storage
- **Current**: ~10,000 rows for 1,000 timestamps × 10 channels
- **Optimized**: ~1,000 rows for 1,000 timestamps
- **Reduction**: ~90% fewer rows

### Insert Speed
- **Current**: ~100ms for 1,000 timestamps (10 INSERTs per timestamp)
- **Optimized**: ~10ms for 1,000 timestamps (1 INSERT per timestamp)
- **Speedup**: ~10x faster

### Query Speed
- **Current**: ~50ms for multi-channel query (JOIN across 10 tables)
- **Optimized**: ~5ms for multi-channel query (single table scan)
- **Speedup**: ~10x faster

## Implementation Considerations

1. **Dynamic Column Creation**: Add columns on-demand when new channels are encountered
2. **Backward Compatibility**: Keep old tables during migration, remove after validation
3. **Index Strategy**: Single index on `(dataset_id, source_id, timestamp)` covers all queries
4. **NULL Handling**: SQLite stores NULLs efficiently (1 byte), sparse channels are fine
5. **Column Limit**: SQLite supports 2,000 columns, plenty for timeseries channels

## Next Steps

1. Create proof-of-concept implementation
2. Benchmark storage and query performance
3. Test with real datasets
4. Plan migration strategy
5. Update `huniDBStore.ts` to use new structure

