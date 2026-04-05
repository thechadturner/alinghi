# Data Normalization Pattern

## Overview

This document describes the field name normalization pattern used throughout the RaceSight application for metadata fields in the UnifiedDataStore, **channel-values API responses** (explore timeseries, overlays, etc.), and **HuniDB** where it is still used (events, meta, json, density).

**Note:** Raw explore timeseries rows are **not** stored in HuniDB `ts.*` tables; they are loaded from the file/channel-values API and normalized in memory. HuniDB continues to use events, `meta.datasets`, `meta.sources`, `meta.channel_names`, and `json.*`. The **agg.aggregates** table is deprecated and not created; race/leg metadata is sourced from **agg.events** (JSON `tags` column). The conventions below apply to those tables, API responses, and `normalizeDataFields` in `unifiedDataStore`.

## Core Principle

**All metadata fields are normalized to lowercase with underscores** when stored in UnifiedDataStore and HuniDB. This ensures consistency across the codebase and prevents case-sensitivity issues.

## Field Name Normalization

### Metadata Fields

The following metadata fields are normalized to lowercase:

- **Race Number**: `RACE`, `Race_number`, `race_number`, `RaceNumber` → `race_number`
- **Leg Number**: `LEG`, `Leg_number`, `leg_number`, `LegNumber` → `leg_number`
- **Grade**: `GRADE`, `Grade`, `grade` → `grade`
- **State**: `STATE`, `State`, `state` → `state`
- **Config**: `CONFIG`, `Config`, `config` → `config`
- **Event**: `EVENT`, `Event`, `event`, `event_name` → `event`
- **Source Name**: `SOURCE_NAME`, `Source_name`, `source_name`, `SOURCE`, `Source`, `source` → `source_name`

### Channel Names

**Historical / HuniDB library:** Per-channel tables `ts.<Channel>` preserved original case for Influx compatibility. The **application** does not persist explore timeseries in those tables today; channel-values responses still use original case column names from parquet/API.

**When HuniDB still stores channel-scoped data (legacy paths / library docs):** original case is preserved:
- API/InfluxDB may return: `Tws_kts`, `Twa_deg`, `Bsp_kph` (mixed case)
- HuniDB stores as: `ts.Tws_kts`, `ts.Twa_deg`, `ts.Bsp_kph` (preserves original case)
- Original case is preserved in both table names and `meta.channel_names` table

**Why preserve original case?**
- **Critical**: InfluxDB measurement names are case-sensitive and can differ only by case
- SQLite table names are case-insensitive, so we use case-insensitive lookups when querying
- Components use case-insensitive matching to access channel values
- Avoids normalization/denormalization bugs that occur when converting between cases

## Data Flow

```
API Response (mixed case)
  ↓
UnifiedDataStore (normalizes metadata to lowercase)
  ↓
HuniDB Storage (lowercase column names: race_number, leg_number, etc.)
  ↓
Query Results (lowercase field names)
  ↓
Components (use lowercase field names)
```

## HuniDB Schema Convention

### Column Names

All metadata columns in HuniDB use lowercase with underscores. **Historical note:** The `agg.aggregates` table is deprecated and no longer created; race/leg and other metadata now live in `agg.events` (see `tags` JSON column).

```sql
-- Deprecated: agg.aggregates is no longer used. Shown for historical reference.
CREATE TABLE "agg.aggregates" (
  race_number TEXT,
  leg_number INTEGER,
  ...
)
```

### Query Pattern

When querying HuniDB directly:
- Use lowercase for metadata columns: `race_number`, `leg_number`
- Use original case for channel names: `Bsp_kts`, `Tws_kts` (but queries are case-insensitive)

```sql
-- Metadata from agg.events (tags JSON); agg.aggregates is deprecated
SELECT DISTINCT json_extract(tags, '$.race_number'), json_extract(tags, '$.leg_number')
FROM "agg.events"
WHERE json_extract(tags, '$.race_number') IS NOT NULL
  AND json_extract(tags, '$.leg_number') > 0

-- Historical: per-channel ts.* tables (HuniDB library / legacy; not the explore timeseries path today)
SELECT value FROM "ts.Bsp_kts" WHERE dataset_id = ? AND project_id = ? AND source_id = ?
-- SQLite treats ts.Bsp_kts and ts.bsp_kts as the same table
```

### Result Processing

Results from HuniDB queries:
- Metadata fields: lowercase (`race_number`, `leg_number`)
- Channel names: original case from storage (`Bsp_kts`, `Tws_kts`)

```typescript
const results = await db.query(sql, params);
// results[0].race_number (lowercase metadata)
// results[0].Bsp_kts (original case channel)
// Components use case-insensitive matching to access: row['Bsp_kts'] || row['bsp_kts']
```

## When to Use Uppercase

Uppercase field names are used **only** in specific contexts:

### 1. Display/UI Purposes
- Color options: `'RACE'`, `'LEG'`, `'GRADE'` in dropdowns
- Field labels in UI components

### 2. Processed Data for Coloring/Grouping
- Fields added by `processFleetPerformanceData()` and `processPerformanceData()`
- These add uppercase fields like `RACE`, `LEG`, `GRADE` for chart coloring/grouping
- Example: `{ ...item, RACE: race, LEG: leg, GRADE: grade }`

### 3. Filter Configuration
- Filter configs may reference uppercase names for display
- But internally they map to lowercase field names

## Implementation Guidelines

### Querying HuniDB

Always use lowercase column names in SQL queries:

```typescript
// ✅ CORRECT (use agg.events and tags; agg.aggregates is deprecated)
const sql = `
  SELECT DISTINCT json_extract(tags, '$.race_number'), json_extract(tags, '$.leg_number')
  FROM "agg.events"
  WHERE json_extract(tags, '$.race_number') IS NOT NULL
`;

// ❌ WRONG
const sql = `
  SELECT DISTINCT RACE_NUMBER, LEG_NUMBER
  FROM "agg.aggregates"
`;
```

### Processing Query Results

Results from HuniDB queries already have lowercase field names:

```typescript
// ✅ CORRECT
const raceValue = row.race_number;
const legValue = row.leg_number;

// ❌ WRONG
const raceValue = row.RACE_NUMBER; // May not exist
```

### Storing Data in HuniDB

When storing data, use lowercase field names:

```typescript
// ✅ CORRECT (agg.events stores metadata in tags JSON; agg.aggregates is deprecated)
// Events are inserted via storeEvents() with tags containing race_number, leg_number, grade, etc.

// ❌ WRONG (agg.aggregates no longer used)
await db.exec(`
  INSERT INTO "agg.aggregates" (RACE_NUMBER, LEG_NUMBER, GRADE)
  VALUES (?, ?, ?)
`, ['TRAINING', 1, 2]);
```

### Explore timeseries / API rows and client-side filtering

Chart data from the **channel-values API** arrives as one row per timestamp with requested columns. For **Probability, Scatter, Rose, Parallel, Grid, Table, TimeSeries**, filters use `applyDataFilter` / `filterByTwa`: each point should carry filter-related fields when those channels were requested—typically **Grade**, **Race_number**, **Leg_number**, **State** (foiling / H0–H2 style), and **Twa_deg** where applicable. Missing keys mean that filter dimension cannot be applied to that dataset load.

### Foiling_state vs State (parquet and charts)

Parquet processing uses **`Foiling_state`**. `extractAndNormalizeMetadata` maps variants to internal **`State`**. `normalizeDataFields` standardizes to **`State`** on each point; if the requested channel list includes **`Foiling_state`**, it also sets **`Foiling_state`** as an alias of **`State`** so chart series saved with the parquet name still resolve Y values.

### Historical: timeseries rows and tags in HuniDB

If any code path still serves rows from HuniDB `ts.*` tables with a `tags` JSON column, filter metadata in **tags** should mirror the same fields above for client-side filtering. This is **not** the primary path for dataset explore timeseries today.

### Using UnifiedDataStore

UnifiedDataStore automatically normalizes metadata to lowercase:

```typescript
// Input can be mixed case
const data = {
  Race_number: 1,
  Leg_number: 2,
  Grade: 3
};

// UnifiedDataStore normalizes to lowercase
// Stored as: { race_number: 1, leg_number: 2, grade: 3 }
```

### FilterStore Integration

FilterStore functions expect string arrays:

```typescript
// ✅ CORRECT
import { setRaceOptions, setLegOptions } from '../../store/filterStore';

// Convert to strings for filterStore
const raceOptionsAsStrings = races.map(r => String(r));
setRaceOptions(raceOptionsAsStrings);

const legOptionsAsStrings = legs.map(l => String(l));
setLegOptions(legOptionsAsStrings);
```

## Examples

**Note:** The following examples that reference `agg.aggregates` are kept for historical context. In the current schema, race/leg metadata is sourced from `agg.events` via `json_extract(tags, '$.race_number')` and `json_extract(tags, '$.leg_number')`.

### Example 1: Querying Races (historical: agg.aggregates; current: use agg.events and tags)

```typescript
// Current approach: use agg.events
const racesSql = `
  SELECT DISTINCT json_extract(tags, '$.race_number') AS race_number
  FROM "agg.events"
  WHERE project_id = ? AND json_extract(tags, '$.race_number') IS NOT NULL
`;

const raceRows = await db.query(racesSql, [projectId]);
// raceRows[0].race_number (lowercase)
```

### Example 2: Processing Race Data

```typescript
const racesFromHuniDB = raceRows
  .map((r: any) => {
    const raceNum = r.race_number; // lowercase from query
    if (raceNum === 'TRAINING' || raceNum === '-1' || raceNum === -1) {
      return 'TRAINING';
    }
    const num = Number(raceNum);
    return isNaN(num) ? raceNum : num;
  })
  .filter((v: any) => v !== null && v !== undefined);

// Convert to strings for filterStore
const raceOptionsAsStrings = racesFromHuniDB.map(r => String(r));
setRaceOptions(raceOptionsAsStrings);
```

### Example 3: Using Normalized Data in Components

```typescript
// Data from UnifiedDataStore is already normalized
const point = {
  race_number: 'TRAINING', // lowercase
  leg_number: 1,            // lowercase
  grade: 2                  // lowercase
};

// Access using lowercase
const race = point.race_number;
const leg = point.leg_number;
```

## Related Files

- **Normalization Logic**: [`frontend/utils/dataNormalization.ts`](../frontend/utils/dataNormalization.ts)
- **HuniDB Schema**: [`frontend/store/huniDBSchema.ts`](../frontend/store/huniDBSchema.ts)
- **HuniDB Store**: [`frontend/store/huniDBStore.ts`](../frontend/store/huniDBStore.ts)
- **UnifiedDataStore**: [`frontend/store/unifiedDataStore.ts`](../frontend/store/unifiedDataStore.ts)
- **FilterStore**: [`frontend/store/filterStore.ts`](../frontend/store/filterStore.ts)

## Summary

1. **Schema**: 
   - Metadata columns: lowercase (`race_number`, `leg_number`, etc.)
   - Channel names from API/parquet: original case; **`Foiling_state`** may be aliased to **`State`** plus **`Foiling_state`** when requested
   - Historical HuniDB channel tables: original case (`ts.Bsp_kts`, …) — not used for explore timeseries persistence
2. **Queries**: 
   - Metadata: Use lowercase column names in SQL
   - Channels: Use original case, but SQLite handles case-insensitive matching
3. **Results**: 
   - Metadata: lowercase field names
   - Channels: original case from storage
4. **Storage**: 
   - Metadata: Store in lowercase
   - Channels: Store in original case from API/InfluxDB
5. **UnifiedDataStore**: Normalizes metadata to lowercase, preserves channel case
6. **FilterStore**: Expects string arrays (convert numbers to strings)
7. **Components**: Use case-insensitive matching to access channel values
8. **Uppercase**: Only for display/UI and processed data for coloring

This pattern preserves InfluxDB case sensitivity while using case-insensitive lookups for compatibility.

