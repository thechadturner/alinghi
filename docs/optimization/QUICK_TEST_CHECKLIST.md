# Quick Test Checklist

Use this checklist to quickly verify all optimizations are working.

## Frontend Tests (5 minutes)

```bash
# Run automated tests
npm test

# Expected: All tests pass
✅ lruCache.test.ts
✅ useTimerCleanup.test.ts  
✅ cacheCleanup.test.ts
✅ lruCacheIntegration.test.ts
```

## Browser Manual Tests (10 minutes)

### 1. Cache Cleanup Test
```javascript
// In browser console
localStorage.setItem('VITE_VERBOSE', 'true');
location.reload();

// Wait 5 minutes OR use DevTools to advance time
// Check console for: "[UnifiedDataStore] Cache cleanup: Removed X expired entries"
```
✅ Cleanup logs appear every 5 minutes

### 2. LRU Cache Test
```javascript
// Check cache sizes don't exceed limits
// Navigate and load data for 60+ sources
// Memory should stay stable (check DevTools Performance tab)
```
✅ Memory usage is stable
✅ Cache doesn't grow unbounded

### 3. Timer Cleanup Test
```javascript
// Navigate between TimeSeries and Map pages multiple times
// Check for active timers
window.timerAudit.getActiveTimers();
```
✅ No orphaned timers after navigation
✅ Timer count stays low

## Database Tests (5 minutes)

Replace `<database_name>` with your PostgreSQL database name (same value as `DB_NAME` in your environment).

```bash
# 1. Run audit
psql -U postgres -d <database_name> -f database/migrations/audit_existing_indexes.sql

# 2. Check results - note which indexes exist
# 3. Run migration (if needed)
./database/migrations/apply_indexes_to_all_classes.sh <database_name> postgres

# 4. Verify
psql -U postgres -d <database_name> -f database/migrations/verify_indexes.sql
```
✅ Audit script runs successfully
✅ Migration creates only missing indexes
✅ Verification shows all critical indexes exist

## Performance Verification (5 minutes)

### Query Performance
```sql
-- Run test query
EXPLAIN ANALYZE
SELECT * FROM ac75.datasets 
WHERE source_id = 1 
ORDER BY date DESC 
LIMIT 10;
```
✅ Query plan shows "Index Scan" (not "Seq Scan")
✅ Execution time is low (< 50ms for indexed queries)

### Memory Usage
- Open DevTools → Performance tab
- Record for 5 minutes
- Check memory graph
✅ Memory usage is stable (no upward trend)
✅ No memory leaks visible

## All Tests Pass Checklist

- [ ] All npm tests pass
- [ ] Cache cleanup runs every 5 minutes
- [ ] LRU cache evicts when full
- [ ] Timers are cleaned up on unmount
- [ ] Database indexes are created (if missing)
- [ ] Query performance improved
- [ ] Memory usage is stable
- [ ] No console errors

## If Tests Fail

1. **Cache cleanup not running**: Check console for errors, verify store initialization
2. **LRU cache not working**: Verify import and usage in unifiedDataStore.ts
3. **Timers leaking**: Use `window.timerAudit.getActiveTimers()` to find orphaned timers
4. **Indexes not created**: Check migration log for errors, verify schema names

See [TESTING_GUIDE.md](./TESTING_GUIDE.md) for detailed troubleshooting.
