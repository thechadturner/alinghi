# UnifiedDataStore Guide

## Overview

The `unifiedDataStore` is the central data management system for fetching and querying timeseries, map, and aggregate data. **Primary path:** in-memory caches (`dataCache`, `queryCache`, channel availability, etc.) plus the **channel-values / events APIs**—documented in [Data Caching Policy](./data-caching-policy.md) (including the explore timeseries flow). **HuniDB** supports events, metadata, settings, and related features—not persistence of raw explore timeseries rows.

## Architecture

### Data flow for timeseries / map / aggregates

Two-layer flow (API + in-memory; see [Data Caching Policy](./data-caching-policy.md)):

1. **In-Memory Cache** (`dataCache`): Fastest, but volatile and chart-specific
2. **API**: Remote data source when cache misses occur

```
Component Request
    ↓
1. Check In-Memory Cache (chart-specific)
    ├─ Has ALL requested channels? → Return immediately ✅
    └─ Missing channels? → Continue to step 2
    ↓
2. Fetch from API
    └─ Update in-memory cache and return
```

Event time ranges, channel names, and settings continue to use HuniDB (agg.events, meta.channel_names, json.objects, etc.).

## Critical Rules and Best Practices

### ⚠️ CRITICAL: Always Validate Cache Contents

**The Problem We Fixed:**
The in-memory cache was being used without validating it contained ALL requested channels. This caused charts to display incomplete data when switching between chart configurations.

**The Solution:**
**ALWAYS validate cache contents before using them.** Never assume cache has the data you need just because it exists.

```typescript
// ❌ BAD: Using cache without validation
const cachedEntry = dataCache.get(cacheKey);
if (cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
  return cachedEntry.data; // DANGEROUS - might be missing channels!
}

// ✅ GOOD: Validate cache has ALL requested channels
const cachedEntry = dataCache.get(cacheKey);
if (cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
  const hasAllChannels = requiredChannels.every(ch => {
    // Skip metadata channels (always available)
    if (['Datetime', 'datetime', 'timestamp'].includes(ch)) return true;
    // Check if channel exists in cached data
    const chLower = ch.toLowerCase();
    return cachedChannels.some(cached => cached.toLowerCase() === chLower) ||
           (cachedEntry.data[0] && Object.keys(cachedEntry.data[0]).some(k => k.toLowerCase() === chLower));
  });
  
  if (hasAllChannels) {
    return cachedEntry.data; // Safe to use
  } else {
    // Cache exists but missing channels - fetch missing from API and merge into cache
  }
}
```

**Key Points:**
- Cache keys are chart-specific: `${chartType}_${className}_${sourceId}_${datasetId}_${projectId}`
- Different chart configs request different channels
- Cache from Chart A might not have channels needed by Chart B
- **Always validate channel completeness before using cache**

### ⚠️ CRITICAL: Apply Validation at ALL Cache Check Points

There are **TWO places** where in-memory cache is checked:

1. **Early check**: Before fetching from API
2. **Late check**: After API fetch (in case the fetch updated the cache)

**Both must validate channels!** The late check was missing validation, causing the bug.

```typescript
// ✅ CORRECT: Both checks validate channels
// Early check (before API fetch)
if (cachedEntry && hasAllChannels) {
  return cachedEntry.data;
}

// ... API fetch happens here; result is merged into in-memory cache ...

// Late check (after API fetch) - MUST ALSO VALIDATE!
if (updatedCacheEntry && hasAllChannels) {  // ← Don't forget this validation!
  return updatedCacheEntry.data;
}
```

### ⚠️ CRITICAL: Fetch Only Missing Channels

**The Problem:**
When some channels are cached and some are missing, we should only fetch the missing ones, not all channels.

**The Solution:**
```typescript
// ✅ CORRECT: Only fetch missing channels
const missingChannels = validRequestedChannels.filter(ch => 
  !availableChannelsLower.has(ch.toLowerCase())
);

// Fetch ONLY missing channels from API
const channelsToFetch = newMissingChannels.length > 0 
  ? (newMissingChannels.includes('Datetime') 
      ? newMissingChannels 
      : ['Datetime', ...newMissingChannels])  // API requires Datetime
  : channelsToEnsure;

// Fetch from API and merge into in-memory cache
const data = await fetchFromAPIAndMergeIntoCache(..., channelsToFetch, ...);
```

**Benefits:**
- 90% reduction in API data transfer for partial cache hits
- Faster response times
- In-memory cache holds merged data by timestamp

### ⚠️ CRITICAL: Always Include Datetime in API Requests

The `/api/channel-values` endpoint requires `Datetime` in the channel list, even if it's a metadata channel.

```typescript
// ✅ CORRECT: Ensure Datetime is included
const channelsToFetch = newMissingChannels.length > 0 
  ? (newMissingChannels.includes('Datetime') || newMissingChannels.includes('datetime')
      ? newMissingChannels 
      : ['Datetime', ...newMissingChannels])  // Add if missing
  : channelsToEnsure;
```

### ⚠️ CRITICAL: Await Fetch and Merge Before Returning

When fetching missing channels from API, you MUST await the fetch and merge the result into the in-memory cache before returning, so subsequent reads see the complete data.

```typescript
// ✅ CORRECT: Fetch from API and merge into in-memory cache
const fetched = await fetchFromAPI(..., channelsToFetch, ...);
mergeIntoDataCache(cacheKey, fetched, channelsToFetch);
return getMergedDataFromCache(cacheKey, validRequestedChannels);
```

**Why:**
- Chart payloads are served from in-memory cache + API; incomplete merge yields missing channels.

### Merging channels in cache

When only some channels are missing, the store fetches those from the API and merges them into the existing cache entry by timestamp so that all requested channels are available from the in-memory cache.

## Channel Filtering Rules

### Metadata Channels

These channels are treated as metadata (derived or always included):

- `Datetime`, `datetime`, `timestamp`
- `source_id`, `source_name`
- `Race_number`, `race_number`, `Leg_number`, `leg_number`
- `Grade`, `grade`
- `Mainsail_code`, `mainsail_code`, `Headsail_code`, `headsail_code`
- `TACK`, `tack`, `event_id`
- Any channel ending in `_code` or `_number`

**Important:**
- Metadata channels are handled in validation and API requests
- They're included in API requests (API needs them)
- They're always available in returned data

## Overlay and gauge components

Chart overlays (TextBox, Donut, Sparkline, etc.) and **FleetDataTable** **do not use a shared cache or HuniDB**. The **Overlay** and **FleetDataTable** components **must retrieve data from the API (timeseries) only**—not from map cache. Map data has a reduced channel set (e.g. `Twa_deg`); overlays and the fleet table need the full timeseries channel set from the API (e.g. `Twa_n_deg`). Overlay fetches all required channels once from the API, stores the result in its own in-memory state (`overlayData`), and passes the current row (and optionally full timeseries) to gauge children via props (`dataRow`, `timeseriesData`). FleetDataTable always fetches its configured channels from the API (timeseries) per source and does not use `cachedMapData` for loading. When `selectedTime` changes, Overlay finds the closest row in its local data and passes it down. This keeps timestamps consistent and avoids any overlay-specific cache layer.

### Case-Insensitive Channel Matching

Channel names are matched case-insensitively:

```typescript
const availableChannelsLower = new Set(availableChannels.map(ch => ch.toLowerCase()));
missingChannels = validRequestedChannels.filter(ch => 
  !availableChannelsLower.has(ch.toLowerCase())
);
```

**Why:**
- API might return `Twd` but cache has `TWD`
- Configuration might use `Tws` but data has `TWS`
- Case-insensitive matching prevents false "missing" channels

## Live Mode Considerations

### isLiveMode() Logic

`isLiveMode()` returns `true` ONLY if:
1. `liveMode()` signal is enabled, AND
2. Redis has data less than 1 hour old

```typescript
const isLiveMode = (): boolean => {
  if (!liveMode()) return false;
  
  // Check cached Redis timestamp
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  if (cachedLatestRedisTimestamp && cachedLatestRedisTimestamp > oneHourAgo) {
    return true;  // Redis has recent data
  }
  
  return false;  // Redis data is stale or missing
};
```

**Important:**
- Even if `liveMode()` signal is `true`, `isLiveMode()` can return `false` if Redis data is stale
- When `hasNoDataAtAll` is `true`, always fetch from API (even in live mode) to populate cache
- Live mode only prevents fetching when we already have cached data

## Common Pitfalls and How to Avoid Them

### Pitfall 1: Using Cache Without Validation

**Symptom:** Chart displays incomplete data, missing channels that should be available.

**Cause:** Using in-memory cache without checking if it has all requested channels.

**Fix:** Always validate cache contents before using:
```typescript
const hasAllChannels = requiredChannels.every(ch => {
  // Validation logic here
});
```

### Pitfall 2: Fetching All Channels When Some Are Cached

**Symptom:** Unnecessary API calls, slow performance, wasted bandwidth.

**Cause:** Not checking which channels are missing before fetching.

**Fix:** Only fetch missing channels:
```typescript
const missingChannels = validRequestedChannels.filter(ch => 
  !availableChannelsLower.has(ch.toLowerCase())
);
```

### Pitfall 3: Not Awaiting Fetch and Merge Before Returning

**Symptom:** Missing data even though API fetch succeeded.

**Cause:** Returning or reading from cache before the API result is merged into the in-memory cache.

**Fix:** Always await the fetch and merge into cache before returning data to callers.

### Pitfall 4: Forgetting Datetime in API Requests

**Symptom:** API returns no data even though channels exist.

**Cause:** API requires `Datetime` in channel list.

**Fix:** Always include Datetime:
```typescript
const channelsToFetch = newMissingChannels.includes('Datetime')
  ? newMissingChannels
  : ['Datetime', ...newMissingChannels];
```

### Pitfall 5: Merging channels incorrectly

**Symptom:** Complex merging logic, edge cases, missing channels.

**Cause:** Not merging API results into the in-memory cache by timestamp so that all requested channels are present.

**Fix:** Use the store's fetch-and-merge path so the in-memory cache has all requested channels before returning.

## Debugging Tips

### Enable Verbose Logging

Set `VITE_VERBOSE=true` to see detailed logs:
- Channel availability checks
- Cache validation results
- API fetch decisions
- Cache merge results

### Key Log Messages to Watch

1. **`🔍 Channel availability check`**: Shows available vs requested channels
2. **`🚀 Fetching X MISSING channels from API`**: Indicates which channels are being fetched
3. **`✅ Retrieved X rows from cache with merged channels`**: Shows which channels are in returned data
4. **`Using in-memory cache (has all X requested channels)`**: Cache validation passed
5. **`In-memory cache exists but missing some requested channels`**: Cache validation failed, will fetch missing channels from API

### Common Issues and Solutions

**Issue:** Chart shows no data but logs show channels are cached
- **Check:** Are the channels in the returned data? Look for `✅ Retrieved` log with `actualChannels` vs `requestedChannels`
- **Fix:** If channels are missing from data, verify the in-memory cache merge includes all requested channels

**Issue:** API fetch happens even though channels are cached
- **Check:** `newMissingChannelsCount` in fetch decision log
- **Fix:** Verify channel name matching is case-insensitive and metadata channels are filtered correctly

**Issue:** Data appears but some channels are missing
- **Check:** `missingInData` in the `✅ Retrieved` log
- **Fix:** Verify the API response and cache merge include all requested channels (no HuniDB; data is in-memory + API only)

## Testing Checklist

When modifying `fetchDataWithChannelChecking`, verify:

- [ ] In-memory cache validation works (early check)
- [ ] In-memory cache validation works (late check)
- [ ] Only missing channels are fetched from API
- [ ] Datetime is included in API requests
- [ ] Fetch and cache merge complete before returning
- [ ] Merged cache returns all requested channels
- [ ] Case-insensitive channel matching works
- [ ] Metadata channels are filtered correctly
- [ ] Live mode logic respects Redis data age
- [ ] Cache miss triggers API fetch (even in live mode when needed)

## Code Review Checklist

When reviewing changes to `unifiedDataStore.ts`:

1. **Cache Validation:**
   - [ ] Are ALL cache checks validating channel completeness?
   - [ ] Is validation logic consistent across all check points?
   - [ ] Are metadata channels handled correctly in validation?

2. **API Fetching:**
   - [ ] Are only missing channels being fetched?
   - [ ] Is Datetime included in API requests?
   - [ ] Is storage awaited before querying?

3. **Data Merging:**
   - [ ] Is cache merge correct for all requested channels?
   - [ ] Are all requested channels included in the query?

4. **Error Handling:**
   - [ ] Are API errors handled gracefully?
   - [ ] Are missing channels logged clearly?
   - [ ] Does the system continue working with partial data?

## Summary

The unifiedDataStore is a complex system with multiple caching layers. The key to avoiding bugs is:

1. **Always validate cache contents** - never assume cache has what you need
2. **Apply validation at ALL check points** - early and late cache checks
3. **Fetch only missing channels** - be efficient with API calls
4. **Merge API results into cache correctly** - by timestamp so all channels are available
5. **Await fetch and merge before returning** - ensure cache has complete data for callers

Remember: **Cache validation is not optional - it's critical for data correctness.**

