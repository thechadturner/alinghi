# Multi-Source Mapping Strategy Documentation

## Overview

This document describes the architecture and implementation strategy for multi-source mapping in the Hunico application. It covers the data flow, component responsibilities, and the solution to the time window filtering issue.

## Problem Statement

When cycling through time window options (30, 15, 5, 2, 1 minutes) and returning to `timeWindow === 0` (full timeline), only the last filtered time window's data (e.g., 1 minute) was being displayed instead of the full dataset. This occurred despite the `groupedData` memo correctly calculating the full data.

## Root Cause

The issue was caused by **WebGL renderer caching** in `MultiTrackLayer.tsx`. The renderer was using a hash-based caching system to optimize updates, but when `timeWindow` changed from a filtered value (e.g., 1 minute) back to 0 (full timeline), the renderer didn't detect that a full update was needed. The cached filtered data (60 points) was being rendered instead of the full dataset (1626 + 1700 points).

## Solution

The solution involved three key changes:

### 1. Force Full Update When `timeWindow === 0`

Added logic to always force a full update when `timeWindow === 0`, regardless of whether it "changed" or not:

```typescript
// CRITICAL: When timeWindow === 0, we MUST always force a full update to show all data
// This is necessary even if timeWindow didn't "change" (e.g., user cycles through and comes back to 0)
const needsFullUpdate = brushSelectionChanged || timeWindowChanged || currentTimeWindow === 0;
```

### 2. Clear WebGL Renderer Cache

When `timeWindow === 0`, explicitly clear the WebGL renderer to remove any cached filtered data:

```typescript
if (currentTimeWindow === 0) {
  // Clear the renderer to ensure no cached filtered data remains
  webglRenderer.clear();
}
// Update all groups with fresh data
webglRenderer.updateGroups(groups);
```

### 3. Track Time Window Changes

Added state tracking to detect `timeWindow` changes and force updates:

```typescript
let lastRenderState: { timeWindow?: number } | null = null;
const currentTimeWindow = timeWindow();
const previousTimeWindow = lastRenderState?.timeWindow ?? -1;
const timeWindowChanged = currentTimeWindow !== previousTimeWindow;
```

## Architecture Overview

### Component Hierarchy

```
MapContainer.tsx
├── MultiMapTimeSeries.tsx (Post-processed data)
│   └── Sends full timeline data to MapContainer
├── LiveMapTimeSeries.jsx (Live streaming data)
│   └── Sends filtered data from streamingStore
└── MultiTrackLayer.tsx
    └── Renders tracks on map with time window filtering
```

### Data Flow

#### Post-Processed Data Flow (MultiMapTimeSeries)

1. **Data Source**: `unifiedDataStore` → IndexedDB
2. **Component**: `MultiMapTimeSeries.tsx`
   - Fetches data from `unifiedDataStore.fetchMapDataForDay()`
   - Filters by source, race, and leg (NOT by time window)
   - Always sends **full timeline data** to `MapContainer`
3. **MapContainer**: Receives full data and stores in `values()` signal
4. **MultiTrackLayer**: 
   - Receives full data via `props.data`
   - Applies time window filtering in `groupedData()` memo
   - Renders filtered tracks on map

#### Live Streaming Data Flow (LiveMapTimeSeries)

1. **Data Source**: Redis → `streamingStore` → WebSocket
2. **Component**: `LiveMapTimeSeries.tsx`
   - Loads initial data from Redis via `streamingStore.loadInitialDataFromRedis()`
   - Receives live updates via WebSocket
   - Uses `streamingStore.getFilteredData()` with time window filtering
   - Sends filtered data to `MapContainer`
3. **MapContainer**: Receives filtered data and stores in `values()` signal
4. **LiveTrackLayer**: Renders tracks directly from `streamingStore.getFilteredData()`

### Key Principles

#### 1. Separation of Concerns

- **MultiMapTimeSeries**: Handles post-processed data, always sends full timeline
- **LiveMapTimeSeries**: Handles live streaming data, applies time window filtering
- **MultiTrackLayer**: Applies time window filtering for post-processed data
- **LiveTrackLayer**: Consumes pre-filtered data from `streamingStore`

#### 2. Data Filtering Strategy

**Post-Processed Data (MultiMapTimeSeries → MultiTrackLayer)**:
- `MultiMapTimeSeries` sends **full timeline** (filtered only by source/race/leg)
- `MultiTrackLayer` applies time window filtering in `groupedData()` memo
- This allows the timeline chart to always show the full range for navigation

**Live Streaming Data (LiveMapTimeSeries → LiveTrackLayer)**:
- `LiveMapTimeSeries` applies time window filtering before sending to map
- `LiveTrackLayer` receives pre-filtered data
- This reduces data transfer for live updates

#### 3. Time Window Filtering Logic

```typescript
// In MultiTrackLayer.groupedData() memo:
if (_timeWindow > 0 && _selectedTime) {
  // Apply time window filter: show data from (selectedTime - timeWindow) to selectedTime
  sourceData = filterDataByTimeWindow(sourceData, _selectedTime, _timeWindow);
} else if (_timeWindow === 0) {
  // Show ALL data (after brush filtering if needed)
  // No time window filtering applied
}
```

#### 4. Brush Selection Filtering

Brush selection is applied **before** time window filtering:

```typescript
// Step 1: Apply brush selection filtering (if any)
sourceData = filterDataBySelectedRanges(sourceData);

// Step 2: Apply time window filtering if timeWindow > 0
if (_timeWindow > 0 && _selectedTime) {
  sourceData = filterDataByTimeWindow(sourceData, _selectedTime, _timeWindow);
}
```

This ensures:
- Brush selection filters the full dataset
- Time window is then applied to the brush-filtered data
- When brush is cleared, time window applies to the full dataset

### Component Responsibilities

#### MultiMapTimeSeries.tsx

**Responsibilities**:
- Fetch post-processed data from `unifiedDataStore`
- Filter by source, race, and leg
- Display full timeline chart for navigation
- Handle brush selection on timeline
- Send full timeline data to `MapContainer` (NOT filtered by time window)

**Key Functions**:
- `fetchCombinedData()`: Fetches data from IndexedDB
- `getFilteredData()`: Filters by source/race/leg only
- `handleBrushClear()`: Clears brush and sends full data
- `handleBrushSelection()`: Sets brush range and sends full data

#### MultiTrackLayer.tsx

**Responsibilities**:
- Receive full timeline data from `MapContainer`
- Apply time window filtering in `groupedData()` memo
- Apply brush selection filtering
- Render tracks on map using WebGL or SVG
- Handle WebGL renderer caching and updates

**Key Functions**:
- `groupedData()`: Memo that filters data by brush and time window
- `filterDataByTimeWindow()`: Filters data to time window before selectedTime
- `filterDataBySelectedRanges()`: Filters data by brush selection
- `render()`: Renders tracks, handles WebGL caching

**Critical Logic**:
```typescript
// Always force update when timeWindow === 0
const needsFullUpdate = brushSelectionChanged || timeWindowChanged || currentTimeWindow === 0;

if (currentTimeWindow === 0) {
  webglRenderer.clear(); // Clear cached filtered data
}
webglRenderer.updateGroups(groups); // Update with full data
```

#### MapContainer.tsx

**Responsibilities**:
- Act as central data coordinator
- Receive data from time series components
- Store data in `values()` signal
- Pass data to track layers
- Handle deduplication via signature checking

**Key Functions**:
- `handleDataUpdate()`: Receives data from time series, updates `values()`
- `trackData()`: Memo that provides data to track layers
- Signature deduplication: Prevents unnecessary updates when data hasn't changed

#### LiveMapTimeSeries.tsx

**Responsibilities**:
- Load initial data from Redis via `streamingStore`
- Receive live WebSocket updates
- Apply time window filtering using `streamingStore.getFilteredData()`
- Send filtered data to `MapContainer`

**Key Functions**:
- `loadInitialData()`: Loads historical data from Redis
- `createEffect()`: Watches WebSocket updates and applies filtering

### Data Filtering Order

For post-processed data in `MultiTrackLayer`:

1. **Source Filtering**: Filter by selected source IDs
2. **Brush Selection Filtering**: Filter by selected time ranges (if any)
3. **Time Window Filtering**: Filter to time window before selectedTime (if `timeWindow > 0`)
4. **Validation**: Filter out invalid coordinates
5. **Sorting**: Sort by timestamp
6. **Playback Speed Optimization**: Skip last N points based on playback speed

### WebGL Renderer Caching Strategy

The WebGL renderer uses hash-based caching to optimize performance:

```typescript
// Hash each group's data to detect changes
const currentHash = hashData(group.data);
const lastHash = lastDataHash.get(group.sourceId);

if (currentHash !== lastHash || needsFullUpdate) {
  groupsToUpdate.push(group);
  lastDataHash.set(group.sourceId, currentHash);
}
```

**Cache Invalidation Triggers**:
- Brush selection changes
- Time window changes
- **Always when `timeWindow === 0`** (critical fix)
- Source changes (add/remove)

**Cache Clearing**:
- When `timeWindow === 0`: Explicitly call `webglRenderer.clear()`
- When brush changes: Clear all hashes
- When sources change: Update all groups

### Signature Deduplication in MapContainer

`MapContainer` uses signature-based deduplication to prevent unnecessary updates:

```typescript
const sig = `${dataLength}_${firstTime}_${lastTime}_${eventIds}_${brushState}_tw${timeWindow}_st${selectedTime}_src${sourceIds}_cnt${sourceCounts}`;

if (!forceNextUpdate && sig === lastHandledSignature) {
  return; // Skip update
}
```

**Signature Components**:
- Data length and time range
- Event ID distribution
- Brush state (`brush`/`nobrush`)
- Time window (`tw{value}`)
- Selected time (`st{timestamp}`)
- Source distribution (`src{ids}_cnt{counts}`)
- Force update flags (`_clear`/`_brush`)

This ensures updates occur when:
- Data content changes
- Time window changes
- Selected time changes
- Brush selection changes
- Source distribution changes

## Best Practices

### 1. Always Send Full Timeline from MultiMapTimeSeries

**DO**:
```typescript
// Always send full timeline data
const fullData = getFilteredData(); // Filtered only by source/race/leg
onMapUpdate(fullData);
```

**DON'T**:
```typescript
// Don't filter by time window in MultiMapTimeSeries
const filteredData = fullData.filter(/* time window filter */);
onMapUpdate(filteredData); // ❌ Wrong!
```

### 2. Apply Time Window Filtering in MultiTrackLayer

**DO**:
```typescript
// In MultiTrackLayer.groupedData() memo
if (_timeWindow > 0 && _selectedTime) {
  sourceData = filterDataByTimeWindow(sourceData, _selectedTime, _timeWindow);
} else if (_timeWindow === 0) {
  // Use full data
}
```

### 3. Force Update When timeWindow === 0

**DO**:
```typescript
// Always force update when timeWindow === 0
const needsFullUpdate = timeWindowChanged || currentTimeWindow === 0;

if (currentTimeWindow === 0) {
  webglRenderer.clear(); // Clear cached filtered data
}
```

### 4. Track Time Window Changes

**DO**:
```typescript
let lastRenderState: { timeWindow?: number } | null = null;
const currentTimeWindow = timeWindow();
const previousTimeWindow = lastRenderState?.timeWindow ?? -1;
const timeWindowChanged = currentTimeWindow !== previousTimeWindow;
```

### 5. Clear WebGL Cache When Needed

**DO**:
```typescript
if (currentTimeWindow === 0 || brushSelectionChanged) {
  webglRenderer.clear(); // Clear cache
  lastDataHash.clear(); // Clear hash cache
}
```

## Common Issues and Solutions

### Issue: Only filtered data shown when timeWindow === 0

**Symptoms**: After cycling through time windows, returning to `timeWindow === 0` shows only the last filtered time window's data.

**Solution**: 
1. Force update when `timeWindow === 0`: `const needsFullUpdate = ... || currentTimeWindow === 0`
2. Clear WebGL renderer: `webglRenderer.clear()` when `timeWindow === 0`
3. Clear hash cache: `lastDataHash.clear()` when forcing update

### Issue: Data not updating when timeWindow changes

**Symptoms**: Changing time window doesn't update the displayed tracks.

**Solution**:
1. Track `timeWindow` changes in render function
2. Include `timeWindow` in signature deduplication
3. Force update when `timeWindow` changes

### Issue: Brush selection not working correctly

**Symptoms**: Brush selection doesn't filter tracks or doesn't clear properly.

**Solution**:
1. Ensure brush filtering is applied before time window filtering
2. Send full data from `MultiMapTimeSeries` when brush is cleared
3. Clear brush state signals: `setSelectedRange([])`, `setSelectedRanges([])`

## Testing Checklist

When testing multi-source mapping:

- [ ] Time window cycling: Cycle through 30, 15, 5, 2, 1, 0 minutes and verify full tracks show at 0
- [ ] Brush selection: Select a time range, verify tracks filter correctly
- [ ] Brush clear: Clear brush, verify full tracks return
- [ ] Time window with brush: Apply time window after brush selection, verify correct filtering
- [ ] Source selection: Change selected sources, verify tracks update
- [ ] Race/leg filtering: Change race/leg filters, verify tracks update
- [ ] Live mode: Verify live streaming data works correctly
- [ ] Performance: Verify no excessive re-renders or memory leaks

## Related Files

- `frontend/components/charts/map/MultiMapTimeSeries.tsx`: Post-processed data time series
- `frontend/components/charts/map/LiveMapTimeSeries.tsx`: Live streaming data time series
- `frontend/components/charts/map/components/MultiTrackLayer.tsx`: Track rendering layer
- `frontend/components/charts/map/components/LiveTrackLayer.tsx`: Live track rendering layer
- `frontend/components/charts/map/MapContainer.tsx`: Central data coordinator
- `frontend/store/streamingStore.ts`: Live data streaming store
- `frontend/store/unifiedDataStore.ts`: Post-processed data store

## Future Improvements

1. **Unified Filtering Logic**: Consider creating a shared filtering utility for both post-processed and live data
2. **Performance Optimization**: Further optimize WebGL rendering for large datasets
3. **Caching Strategy**: Refine hash-based caching to be more intelligent about when to clear
4. **Error Handling**: Add better error handling and recovery for WebGL renderer failures
5. **Testing**: Add unit tests for filtering logic and WebGL renderer updates

