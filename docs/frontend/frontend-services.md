Frontend Services and Data Flow

Unified Data API (src/store/unifiedDataAPI.ts)
- getDataByChannels(channels, { projectId, className, datasetId, sourceName, date?, dataTypes? })
  - Chooses between timeseries (file server /api/channel-values) and map data (app server /api/events/object) endpoints.
  - Converts to DataPoint { timestamp, Datetime, ... } and returns availability summary.
- fetchAndStoreTimeSeriesData(params): Posts to file server channel-values; prepares channel_list types; stores via unifiedIndexedDBChannelBased.
- fetchAndStoreMapData(params): GET /api/events/object with table=events_mapdata; stores as DataPoint list.
- clearAllData(), getStorageInfo(): Proxy to IndexedDB channel-based layer.

IndexedDB Channel-Based Layer (src/store/indexedDB.ts)
- Provides methods used by unifiedDataStore/API: storeDataByChannels, queryDataByChannels, getAvailableChannels, storeObject/getObject/deleteObject/listObjects, clearAllData, getStorageInfo.
- Data partitioned by (dataSource, className lowercase, sourceId, channel list) for efficient reads.

Data Flow Summary (timeseries/map/aggregates)
1) Chart needs channels → unifiedDataStore.fetchDataWithChannelChecking(chartType, className, sourceId, requiredChannels, params)
2) Check in-memory cache (validate has ALL requested channels) → if valid, return immediately
3) Fetch from API via unifiedDataAPI.getDataByChannels (or fetchAndStoreMapData for mapdata)
4) Update in-memory cache and return complete dataset to chart

Timeseries, map data, and aggregates are not cached in HuniDB; only in-memory and API are used.

**Important:** See `docs/frontend/unifiedDataStore-guide.md` for detailed architecture, cache validation rules, and common pitfalls.

Error Handling & Logging
- All services log via src/utils/console with API-level verbosity toggles.
- 404 responses are treated as expected cases in some flows.

