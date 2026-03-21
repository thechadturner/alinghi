# Data Caching Policy

## Overview

Timeseries and channel-values data are **not** persisted locally (no IndexedDB/HuniDB cache for raw channel data). This avoids stale data and reduces maintenance cost. Data is fetched from the API and held in in-session in-memory caches only.

## What Is Cached

### In-session in-memory caches (unified data store)

In [frontend/store/unifiedDataStore.ts](../frontend/store/unifiedDataStore.ts):

| Cache | Purpose | TTL / cleanup |
|-------|---------|----------------|
| `dataCache` | Chart data by key (LRU, 100 entries) | Cleanup every 5 min; entries evicted by age (1 hour) |
| `queryCache` | Avoid duplicate API calls | 30 seconds |
| `channelAvailability` | Track available/missing channels per source | "Missing" channels not retried for 5 minutes |
| `overlayMemoryStorage` | Overlay gauge data per class/source | Session only |
| `categoryData` | Category data (LRU, 50 entries) | Session only |

Additional in-memory behavior:

- `sourcesWithNoData` / `noDataTimestamps`: sources that consistently return no data are not retried for 5 minutes.

### Other in-memory caches

- **MediaAvailabilityService** ([frontend/services/mediaAvailabilityService.ts](../frontend/services/mediaAvailabilityService.ts)): in-memory `Map` of media windows per source/date; cleared on scope change or explicitly.
- **Component-level**: e.g. Grid `rawDataCache` (flat data for selection reprocessing), Scatter `lastFilteredCharts` (last filtered result). Session-only.

### HuniDB (non-timeseries)

HuniDB is still used for non-timeseries data:

- **Events** – per-class event lists for datasets.
- **Aggregates** – aggregate/performance data.
- **Map data** – map tracks and related data.
- **Objects** – simple key/value object storage.
- **Density optimization** – optimized scatter results are written to HuniDB for persistence; the read path was removed so density is always recomputed in the worker.

## Clearing caches

- **Per data source:** `unifiedDataStore.clearCacheForDataSource(dataKey)` clears `queryCache`, `categoryData`, `dataCache`, and `channelAvailability` for that key. Use when switching datasets or when channel availability must be refreshed.
- **Full reset:** `unifiedDataStore.clearAllData()` clears all in-memory caches and HuniDB data.

## See also

- [Frontend Architecture](./frontend-architecture.md) – overall data flow and store usage.
