# Streaming Data Architecture Refactor - Revised Plan

## Goal
Clear separation between:
- **Live streaming data** (websocket) → streamingStore global arrays → NO IndexedDB
- **Post-processed data** (historical) → IndexedDB → MultiMapTimeSeries

## Architecture Changes

### 1. Create LiveMapTimeSeries Component
- New component: `frontend/components/charts/map/LiveMapTimeSeries.tsx`
- Handles ONLY live streaming data from streamingStore
- Uses `streamingStore.loadInitialDataFromRedis()` on mount
- Uses `streamingStore.getFilteredData()` for time window filtering
- Watches `streamingStore.getNewData()` for websocket updates
- Sends filtered data to MapContainer via `onMapUpdate`

### 2. Remove Live Mode from MultiMapTimeSeries
- Remove all `liveMode()` checks and related code
- Remove `queryHistoricalDataFromIndexedDB()` function (live mode specific)
- Remove websocket buffer and live mode tracking
- Keep only IndexedDB query logic for post-processed data
- MultiMapTimeSeries becomes purely for historical/post-processed data

### 3. Update MapContainer
- Conditionally render:
  - `LiveMapTimeSeries` when `liveMode={true}`
  - `MultiMapTimeSeries` when `liveMode={false}` (or undefined)
- Remove live mode data handling from MapContainer (delegate to LiveMapTimeSeries)

### 4. Update LiveTrackLayer
- Use `streamingStore.getFilteredData()` when in live mode
- Get data from streamingStore instead of props.historicalData

### 5. Update MapContainer/MultiTrackLayer for Bad Air
- Use `streamingStore.getAllData()` or `streamingStore.getFilteredData()` for bad air overlay in live mode
- Bad air needs historical data (up to 180 seconds) for wind propagation

## Implementation Steps

1. **Create LiveMapTimeSeries.jsx**
   - Copy structure from MultiMapTimeSeries
   - Remove IndexedDB query code
   - Add streamingStore integration
   - Add time window filtering via streamingStore.getFilteredData()
   - Watch streamingStore.getNewData() for updates

2. **Clean up MultiMapTimeSeries.tsx**
   - Remove liveMode() checks
   - Remove queryHistoricalDataFromIndexedDB()
   - Remove websocket-related code
   - Keep only IndexedDB query logic

3. **Update MapContainer.tsx**
   - Conditional rendering: LiveMapTimeSeries vs MultiMapTimeSeries
   - Remove live mode data handling

4. **Update LiveTrackLayer.tsx**
   - Use streamingStore.getFilteredData() in live mode

5. **Update MapContainer/MultiTrackLayer**
   - Use streamingStore for bad air overlay data in live mode

## Data Flow

### Live Mode (LiveMapTimeSeries)
1. Mount → `streamingStore.loadInitialDataFromRedis()` → populates global arrays
2. WebSocket data → `streamingStore.appendWebSocketData()` → appends to global arrays
3. Time window change → `streamingStore.getFilteredData()` → returns filtered arrays
4. Filtered data → `onMapUpdate()` → MapContainer → LiveTrackLayer

### Post-Processed Mode (MultiMapTimeSeries)
1. Mount → Query IndexedDB → setCombinedData
2. Source/filter change → Re-query IndexedDB → update combinedData
3. Combined data → `onMapUpdate()` → MapContainer → MultiTrackLayer

## Key Methods in streamingStore

- `loadInitialDataFromRedis(sourceIds, timeWindowMinutes)` - Load initial data
- `getFilteredData(sourceIds, options)` - Get filtered data by time window/brush
- `getAllData(sourceIds)` - Get all data (no filtering)
- `getNewData()` - Reactive signal for websocket updates

