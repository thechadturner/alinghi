## HuniDB in Hunico (Metadata & Settings Only)

HuniDB is **no longer used** to cache timeseries, map data, aggregates, or density-optimized data. Those flows use the API only (with in-memory cache where applicable).

This document describes the **remaining** uses of HuniDB: metadata and settings tables used for events, channel discovery, sources, targets, and persisted UI state.

For HuniDB internals (engine, storage), see `libs/huni_db/docs/architecture/OVERVIEW.md`.

---

### 1. What HuniDB is used for today

- **Event time ranges** – `agg.events` stores event metadata (event_id, start_time, end_time) so selection and map overlays can resolve time ranges without API calls.
- **Dataset/source/channel metadata** – `meta.datasets`, `meta.sources`, `meta.channel_names` cache list and discovery data for sidebar and pickers.
- **Settings and targets** – `json.objects`, `json.targets`, `json.datasets` store persisted configuration (zoom, default channels, polar targets, etc.).

Timeseries, map track data, and aggregates are **not** cached in HuniDB; they are always fetched from the API when needed (and may be held in component-level or in-memory cache). **Overlay gauge data** (TextBox, Donut, Sparkline, etc.) is also not in HuniDB: the Overlay component **must fetch from the API (timeseries) only**—not from map cache—so the full channel set (e.g. `Twa_n_deg`) is available; it then holds data in its own state and passes the current row to gauge children via props. **Targets** and **density** (scatter-plot optimization) are still stored in HuniDB (`json.targets`, `density.charts`, `density.groups`).

---

### 2. Tables in use

| Table | Purpose |
|-------|---------|
| `agg.events` | Event time ranges for selection and map overlays |
| `meta.datasets` | Dataset metadata for sidebar/list |
| `meta.sources` | Source metadata for sidebar |
| `meta.channel_names` | Original-case channel names for picker UI |
| `json.objects` | Persisted settings (zoom, filters, etc.) |
| `json.targets` | Polar/target data per project |
| `json.datasets` | Dataset metadata (doc + ts) |
| `density.charts` | Scatter-plot chart optimization metadata |
| `density.groups` | Scatter-plot optimized group data (per chart) |

There is **no** `VITE_USE_HUNIDB_CACHE` setting. The flag and all gates were removed; see below for what is still written vs no-op.

#### USE_HUNIDB_CACHE removal (what is kept vs no-op)

- **Still written (no gate):** Events (`storeEvents`), **targets** (`storeTarget`, `storeTargetsBatch`), **density** (`storeDensityOptimized`). Used by: Targets/Polars UI, performanceDataService, enhancedScatterWorkerManager; tables `json.targets`, `density.charts`, `density.groups`.
- **No longer written (method kept as no-op for callers):** Timeseries (`storeTimeSeriesData`, `storeDataByChannels`), map track data (`storeMapData`, `storeMapDataEntry`), cloud data (`storeCloudDataBatch`), `rebuildMetaChannels`. Callers may still invoke these; they return without writing.

---

### 3. Where to look in the code

- **HuniDB store**: `frontend/store/huniDBStore.ts` – events, meta, json, targets, density read/write; timeseries/map/cloud store methods are no-ops.
- **Schema**: `frontend/store/huniDBSchema.ts` – creates only the tables listed above.
- **Unified data store**: `frontend/store/unifiedDataStore.ts` – uses API (and in-memory cache) for timeseries/map/aggregates; uses HuniDB for events and metadata only.
- **Admin UI**: `frontend/components/admin/AdminHuniDB.tsx` – inspect/clear HuniDB databases.

---

### 4. Data flow (high level)

- **Timeseries / map / aggregates**: Component → in-memory cache (if any) → API. No HuniDB read or write for this data.
- **Overlay gauges**: Overlay component **must fetch from API (timeseries) only**—not from map cache—then holds data in local state and passes current row to gauge children (TextBox, Donut, Sparkline, etc.). No HuniDB and no shared overlay cache.
- **Events, channel names, sources, settings, targets**: Read/written via HuniDB (agg.events, meta.*, json.*) as before.
