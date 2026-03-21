# Performance Optimization Testing Guide

This guide provides comprehensive testing procedures to verify that all performance optimizations (Steps 1-4) are working correctly.

## Quick Test Summary

### Automated Tests (Frontend)
```bash
# Run all tests
npm test

# Run specific test suites
npm test -- lruCache
npm test -- cacheCleanup
npm test -- timerCleanup
npm test -- unifiedDataStore
```

### Manual Tests (Database)

Use your real PostgreSQL database name everywhere `<database_name>` appears (typically the `DB_NAME` from your `.env`).

```bash
# 1. Audit existing indexes
psql -U postgres -d <database_name> -f database/migrations/audit_existing_indexes.sql

# 2. Apply missing indexes (after review)
./database/migrations/apply_indexes_to_all_classes.sh <database_name> postgres

# 3. Verify indexes
psql -U postgres -d <database_name> -f database/migrations/verify_indexes.sql
```

---

## Step 1: Database Index Testing

### 1.1 Audit Existing Indexes

**Test**: Verify audit script works and identifies existing indexes

```bash
psql -U postgres -d <database_name> -f database/migrations/audit_existing_indexes.sql > audit_results.txt
```

**Expected Results**:
- Script executes without errors
- Output shows all existing indexes by schema
- Missing critical indexes are identified
- Index usage statistics are displayed

**Verification**:
```sql
-- Manually verify a few indexes exist
SELECT indexname, tablename, schemaname 
FROM pg_indexes 
WHERE schemaname = 'ac75' 
  AND tablename = 'datasets'
ORDER BY indexname;
```

### 1.2 Test Migration Script

**Test**: Verify migration script only creates missing indexes

```bash
# Linux/Mac
./database/migrations/apply_indexes_to_all_classes.sh <database_name> postgres

# Windows
database\migrations\apply_indexes_to_all_classes.bat <database_name> postgres
```

**Expected Results**:
- Script runs audit first
- Only missing indexes are created
- Existing indexes are skipped (no errors)
- Summary report shows what was created

**Verification**:
- Check `migration_log.txt` for successful index creation
- Check `verification_results.txt` for confirmation
- Verify no duplicate index errors

### 1.3 Test Query Performance

**Test**: Verify indexes improve query performance

```sql
-- Test query without index (if index missing)
EXPLAIN ANALYZE
SELECT * FROM ac75.datasets 
WHERE source_id = 1 
ORDER BY date DESC 
LIMIT 10;

-- Test query with index (after creation)
-- Should show "Index Scan" instead of "Seq Scan"
EXPLAIN ANALYZE
SELECT * FROM ac75.datasets 
WHERE source_id = 1 
ORDER BY date DESC 
LIMIT 10;
```

**Expected Results**:
- Query plan shows "Index Scan using idx_datasets_source_date"
- Query execution time significantly reduced
- No sequential scans on large tables

---

## Step 2: Cache Cleanup Testing

### 2.1 Test Query Cache Cleanup

**Test**: Verify expired query cache entries are cleaned up

**Browser Console Test**:
```javascript
// 1. Enable verbose logging
localStorage.setItem('VITE_VERBOSE', 'true');
location.reload();

// 2. Wait 5+ minutes (or use browser DevTools to advance time)
// 3. Check console for cleanup logs:
// "[UnifiedDataStore] Cache cleanup: Removed X expired entries"

// 4. Verify cache doesn't grow unbounded
// Monitor memory in DevTools Performance tab
```

**Automated Test**:
```bash
npm test -- cacheCleanup
```

**Expected Results**:
- Cleanup runs every 5 minutes
- Expired entries (older than 30s) are removed
- Fresh entries are retained
- No memory leaks over time

### 2.2 Test No-Data Cache Cleanup

**Test**: Verify no-data cache entries expire correctly

**Browser Console Test**:
```javascript
// 1. Trigger a source with no data
// (Navigate to a source that has no data)

// 2. Wait 5+ minutes

// 3. Try to fetch data again - should retry (cache expired)
```

**Expected Results**:
- Sources marked as "no data" are retried after 5 minutes
- Cache prevents repeated failed queries within 5 minutes
- Memory doesn't accumulate with failed sources

### 2.3 Test Data Cache Cleanup

**Test**: Verify old data cache entries are cleaned up

**Browser Console Test**:
```javascript
// 1. Load data for multiple sources
// 2. Wait 1+ hour (or advance time in DevTools)
// 3. Check console for cleanup logs
// 4. Verify timestamp indexes are also cleaned
```

**Expected Results**:
- Entries older than 1 hour are removed
- Corresponding timestamp indexes are cleaned
- Recent entries (less than 1 hour) are retained

### 2.4 Test Cleanup Lifecycle

**Test**: Verify cleanup starts and stops correctly

**Browser Console Test**:
```javascript
// 1. Check cleanup is running (should see logs every 5 min)
// 2. Navigate away from app (triggers disposal)
// 3. Verify cleanup stops (no more logs)
```

**Expected Results**:
- Cleanup starts automatically on store creation
- Cleanup stops on store disposal
- No errors when cleanup is stopped
- No timers leak after disposal

---

## Step 3: LRU Cache Testing

### 3.1 Test LRU Cache Eviction

**Automated Test**:
```bash
npm test -- lruCache
```

**Manual Browser Test**:
```javascript
// In browser console
const { LRUCache } = await import('./frontend/utils/lruCache.ts');

const cache = new LRUCache(3);
cache.set('a', 1);
cache.set('b', 2);
cache.set('c', 3);
cache.set('d', 4); // Should evict 'a'

console.log(cache.get('a')); // undefined (evicted)
console.log(cache.get('d')); // 4 (exists)
```

**Expected Results**:
- Cache size never exceeds maxSize
- Least recently used items are evicted
- Most recently accessed items are retained

### 3.2 Test categoryData LRU Cache

**Test**: Verify categoryData cache limits size to 50

**Browser Console Test**:
```javascript
// 1. Load data for 60+ different sources
// 2. Check memory usage
// 3. Verify first sources are evicted when accessing new ones
```

**Automated Test**:
```bash
npm test -- lruCacheIntegration
```

**Expected Results**:
- Cache size stays at or below 50 entries
- Recently accessed sources remain in cache
- Old sources are evicted automatically

### 3.3 Test dataCache LRU Cache

**Test**: Verify dataCache limits size to 100

**Browser Console Test**:
```javascript
// 1. Load data for 110+ different datasets
// 2. Verify cache doesn't exceed 100 entries
// 3. Check that timestamp/indexed properties are preserved
```

**Expected Results**:
- Cache size stays at or below 100 entries
- Data structure (timestamp, indexed) is preserved
- Eviction works correctly

### 3.4 Test Clear Methods with LRU Cache

**Test**: Verify clear methods work with LRU cache

**Browser Console Test**:
```javascript
// 1. Load data
// 2. Call unifiedDataStore.clearAllData()
// 3. Verify caches are empty
// 4. Call unifiedDataStore.clearCacheForDataSource('source-1')
// 5. Verify only that source is cleared
```

**Expected Results**:
- `clearAllData()` clears all LRU caches
- `clearCache()` clears query cache
- `clearCacheForDataSource()` clears specific entries from all caches

---

## Step 4: Timer Cleanup Testing

### 4.1 Test useTimerCleanup Hook

**Automated Test**:
```bash
npm test -- useTimerCleanup
```

**Manual Test**:
```javascript
// In a component
import { useTimerCleanup } from '../../utils/useTimerCleanup';

const { createTimeout, createInterval } = useTimerCleanup('TestComponent');

// Create timers
const timeoutId = createTimeout(() => console.log('timeout'), 1000);
const intervalId = createInterval(() => console.log('interval'), 500);

// Unmount component - timers should be cleaned up automatically
```

**Expected Results**:
- Timers are tracked automatically
- Timers are cleaned up on component unmount
- No timers leak between component instances

### 4.2 Test Timer Audit Utility

**Browser Console Test**:
```javascript
// 1. Enable timer audit (auto-enabled in dev mode)
window.timerAudit.enable();

// 2. Navigate through components
// 3. Check active timers
window.timerAudit.getActiveTimers();

// 4. Check stats
window.timerAudit.getStats();
```

**Expected Results**:
- Timer audit tracks all registered timers
- Stats show timer counts by type and component
- No orphaned timers after navigation

### 4.3 Test TimeSeries Component Cleanup

**Test**: Verify all timers in TimeSeries are cleaned up

**Browser Test**:
1. Navigate to TimeSeries page
2. Open browser DevTools → Performance tab
3. Record performance
4. Navigate away from TimeSeries page
5. Check for active timers

**Expected Results**:
- All timers cleared on unmount:
  - `chartEffectTimeout` ✅
  - `mapFilterEffectTimeout` ✅
  - `selectedRangeReloadTimeout` ✅
  - `cutEventsReloadTimeout` ✅
  - `resizeTimeout` ✅
  - `animationFrameId` ✅
- No timers continue running after unmount

### 4.4 Test MapContainer Component Cleanup

**Test**: Verify all timers in MapContainer are cleaned up

**Browser Test**:
1. Navigate to Map page
2. Record performance
3. Navigate away
4. Check for active timers

**Expected Results**:
- All timers cleared:
  - `loadingTimeout` ✅
  - `resizeTimeout` ✅
  - `tilesAvailabilityTimeout` ✅
  - `window.mapPeriodicCheck` ✅

---

## Integration Testing

### Test Complete Workflow

**Scenario**: User navigates through app, loads data, changes filters

1. **Start Application**
   - Verify cache cleanup starts
   - Check no errors in console

2. **Load Data**
   - Load map data for multiple sources
   - Verify data is cached
   - Check cache sizes don't exceed limits

3. **Navigate Between Pages**
   - TimeSeries → Map → Performance
   - Verify timers are cleaned up on each navigation
   - Check no memory leaks

4. **Change Filters**
   - Apply various filter combinations
   - Verify cache is used appropriately
   - Check cleanup runs periodically

5. **Long Session**
   - Keep app open for 10+ minutes
   - Verify cache cleanup runs (check logs)
   - Monitor memory usage (should be stable)

**Expected Results**:
- No memory leaks
- Cache sizes stay within limits
- Cleanup runs as expected
- No timer leaks
- Performance remains good

---

## Performance Benchmarks

### Before Optimizations (Baseline)
- Large dataset load: ~2-3 seconds
- Chart render: ~100-200ms
- Memory usage: Growing over time
- Cache size: Unbounded growth

### After Optimizations (Expected)
- Large dataset load: ~1-2 seconds (with indexes)
- Chart render: ~80-150ms
- Memory usage: Stable with LRU cache
- Cache size: Bounded by maxSize

### Measurement Tools

**Browser DevTools**:
- Performance tab: Monitor memory and CPU
- Memory tab: Take heap snapshots
- Network tab: Check query performance

**Database**:
```sql
-- Check query execution time
EXPLAIN ANALYZE SELECT ...;

-- Check index usage
SELECT * FROM pg_stat_user_indexes 
WHERE schemaname = 'ac75'
ORDER BY idx_scan DESC;
```

---

## Troubleshooting

### Cache Cleanup Not Running

**Symptoms**: Cache grows unbounded, no cleanup logs

**Check**:
1. Verify cleanup task started: Check console for "[UnifiedDataStore] Cache cleanup task started"
2. Check if store was disposed: Look for disposal calls
3. Verify timers are working: Check browser console for errors

**Fix**:
- Ensure `startCacheCleanup()` is called on store creation
- Check for errors preventing cleanup from running

### LRU Cache Not Evicting

**Symptoms**: Cache size exceeds maxSize

**Check**:
1. Verify LRU cache is being used (not Map)
2. Check cache size: `categoryData.size` and `dataCache.size`
3. Verify eviction logic in LRU cache

**Fix**:
- Ensure LRU cache is imported and used
- Check maxSize is set correctly
- Verify set() method evicts when full

### Timers Not Cleaning Up

**Symptoms**: Timers continue after component unmount

**Check**:
1. Use timer audit: `window.timerAudit.getActiveTimers()`
2. Check component cleanup code
3. Verify `onCleanup` is called

**Fix**:
- Add missing cleanup in `onCleanup`
- Use `useTimerCleanup` hook for automatic cleanup
- Store all timer IDs and clear them

### Database Indexes Not Created

**Symptoms**: Queries still slow, no indexes in verification

**Check**:
1. Run audit script to see what exists
2. Check migration log for errors
3. Verify schema names are correct

**Fix**:
- Review audit results
- Fix any SQL errors in migration
- Manually create missing indexes if needed

---

## Test Checklist

### Pre-Deployment Testing

- [ ] All automated tests pass
- [ ] Database audit script runs successfully
- [ ] Migration script creates only missing indexes
- [ ] Cache cleanup runs every 5 minutes
- [ ] LRU cache evicts when full
- [ ] Timers are cleaned up on component unmount
- [ ] No memory leaks in 10+ minute session
- [ ] Query performance improved (with indexes)
- [ ] No console errors or warnings

### Post-Deployment Monitoring

- [ ] Monitor cache sizes in production
- [ ] Check index usage statistics
- [ ] Monitor query performance
- [ ] Track memory usage over time
- [ ] Review cleanup logs
- [ ] Check for timer leaks

---

## Running Tests

### Frontend Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- lruCache.test.ts

# Run in watch mode
npm test -- --watch
```

### Database Tests

```bash
# Test audit script
psql -U postgres -d <database_name> -f database/migrations/audit_existing_indexes.sql

# Test migration (dry run - review output first)
psql -U postgres -d <database_name> -f database/migrations/add_missing_indexes.sql --dry-run

# Test verification
psql -U postgres -d <database_name> -f database/migrations/verify_indexes.sql
```

### Manual Browser Testing

1. Open browser DevTools
2. Enable verbose logging: `localStorage.setItem('VITE_VERBOSE', 'true')`
3. Reload application
4. Monitor console for cleanup logs
5. Check Performance tab for memory usage
6. Use timer audit: `window.timerAudit.getStats()`

---

## Success Criteria

### Cache Cleanup
- ✅ Cleanup runs every 5 minutes
- ✅ Expired entries are removed
- ✅ Memory usage is stable
- ✅ No unbounded growth

### LRU Cache
- ✅ Cache size never exceeds maxSize
- ✅ Least recently used items are evicted
- ✅ Most recently accessed items are retained
- ✅ Clear methods work correctly

### Timer Cleanup
- ✅ All timers are cleaned up on unmount
- ✅ No timer leaks between components
- ✅ useTimerCleanup hook works correctly
- ✅ Timer audit utility tracks timers

### Database Indexes
- ✅ Audit script identifies existing indexes
- ✅ Migration script creates only missing indexes
- ✅ Query performance improved
- ✅ Indexes are being used (check EXPLAIN ANALYZE)

---

## Related Documentation

- [Performance Optimization Implementation](./PERFORMANCE_OPTIMIZATION_IMPLEMENTATION.md)
- [Architecture Performance Review](./ARCHITECTURE_PERFORMANCE_REVIEW.md)
- [Timer Cleanup Guide](../frontend/timer-cleanup-guide.md)
- [Database Index Recommendations](../database/database-index-recommendations.md)
