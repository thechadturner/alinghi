# Database Index Implementation Summary

## Overview

This document provides a quick reference for implementing the recommended database indexes. The full analysis and detailed recommendations are in `database-index-recommendations.md`.

**Current Status**: 87 database indexes are already implemented in the schema files (`ac75_empty.sql`, `sailgp_empty.sql`). The migration scripts are for adding any indexes that might be missing in existing databases.

## Quick Start - Complete Workflow

### Step 1: Audit Existing Indexes (REQUIRED FIRST STEP)
**Always run the audit script first to see what indexes already exist.**

**Note**: The schema files (`ac75_empty.sql`, `sailgp_empty.sql`) contain 87 CREATE INDEX statements. Databases created from these schema files will have these indexes. The audit script helps verify indexes are present in your production database.

```bash
# Run audit script
psql -U postgres -d <database_name> -f database/migrations/audit_existing_indexes.sql > audit_results.txt
```

This will:
- List all existing indexes by schema
- Show index usage statistics
- Identify missing critical indexes
- Generate a report for review

**Review the audit results** to understand current state before proceeding.

### Step 2: Review Recommendations
Read `docs/database/database-index-recommendations.md` for complete analysis of recommended indexes.

### Step 3: Apply Missing Indexes Only

**Option A: Automated Script (Recommended)**
```bash
# Linux/Mac
chmod +x database/migrations/apply_indexes_to_all_classes.sh
./database/migrations/apply_indexes_to_all_classes.sh <database_name> postgres

# Windows
database\migrations\apply_indexes_to_all_classes.bat <database_name> postgres
```

The script will:
1. Run audit automatically
2. Detect all class schemas
3. Apply only missing indexes (skips existing ones)
4. Generate summary report

**Option B: Manual Application (For Production Control)**
```bash
# For each class schema (ac75, imoca, etc.):
# 1. Review audit results to see what's missing
# 2. Edit database/migrations/add_missing_indexes.sql
# 3. Replace {class_name} with your schema name
# 4. Run the SQL file:
psql -U postgres -d <database_name> -f database/migrations/add_missing_indexes.sql
```

### Step 4: Verify Indexes
```bash
# Run verification script
psql -U postgres -d <database_name> -f database/migrations/verify_indexes.sql > verification_results.txt
```

Or manually:
```sql
-- Check created indexes
SELECT schemaname, tablename, indexname 
FROM pg_indexes 
WHERE schemaname IN ('ac75', 'imoca', 'admin')
ORDER BY tablename, indexname;

-- Check index usage (after some time)
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes 
WHERE schemaname IN ('ac75', 'imoca', 'admin')
ORDER BY idx_scan DESC;
```

### Step 5: Monitor Index Usage
After indexes are created, monitor their usage over time to ensure they're being utilized effectively.

## Critical Indexes (Apply First)

These indexes address the most frequent query patterns:

1. **`idx_datasets_source_date`** - Dataset queries by source and date
2. **`idx_dataset_events_dataset_id`** - Event queries by dataset
3. **`idx_dataset_events_dataset_type`** - Event type filtering
4. **`idx_user_projects_user_id`** - Permission checks (very frequent)
5. **`idx_events_aggregate_event_agr`** - Performance data queries
6. **`idx_events_cloud_event_id`** - Cloud data queries

## Expected Performance Improvements

### Before Indexes
- Dataset queries: 100-500ms (depending on table size)
- Event queries: 50-200ms
- Permission checks: 10-50ms (but very frequent)
- Performance data queries: 200-1000ms

### After Indexes (Estimated)
- Dataset queries: 5-20ms (10-25x improvement)
- Event queries: 2-10ms (10-20x improvement)
- Permission checks: 1-3ms (5-10x improvement)
- Performance data queries: 10-50ms (10-20x improvement)

**Note:** Actual improvements depend on:
- Table sizes
- Data distribution
- Query patterns
- Hardware resources

## Index Maintenance

### Monitor Index Usage
```sql
-- Find unused indexes (consider dropping)
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes 
WHERE schemaname IN ('ac75', 'imoca', 'admin')
  AND idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

### Rebuild Indexes (if needed)
```sql
-- Rebuild a specific index (non-blocking)
REINDEX INDEX CONCURRENTLY idx_datasets_source_date;

-- Rebuild all indexes in a schema
REINDEX SCHEMA CONCURRENTLY ac75;
```

### Update Statistics
```sql
-- Update statistics after index creation
ANALYZE;

-- Or for specific tables
ANALYZE ac75.datasets;
ANALYZE ac75.dataset_events;
```

## Storage Considerations

Indexes consume additional disk space. Estimate:

- **Small tables** (< 1M rows): ~10-20% of table size
- **Medium tables** (1M-10M rows): ~20-30% of table size
- **Large tables** (> 10M rows): ~30-50% of table size

Check index sizes:
```sql
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS indexes_size
FROM pg_tables 
WHERE schemaname IN ('ac75', 'imoca', 'admin')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Rollback Plan

If indexes cause issues, you can drop them:

```sql
-- Drop specific index
DROP INDEX IF EXISTS {class_name}.idx_datasets_source_date;

-- Drop all indexes from migration (use with caution)
-- See database/migrations/rollback_indexes.sql (create if needed)
```

## Testing Recommendations

1. **Test Environment First**: Apply indexes in test/staging before production
2. **Monitor Query Performance**: Use `EXPLAIN ANALYZE` to verify index usage
3. **Check Application Logs**: Ensure no query timeouts or errors
4. **Monitor Database Load**: Index creation can be CPU/IO intensive
5. **Gradual Rollout**: Consider applying Phase 1 indexes first, then Phase 2

## Troubleshooting

### Index Creation Fails
- Check for existing indexes with same name
- Verify table names and schema names are correct
- Check disk space availability
- Review PostgreSQL logs for errors

### Queries Still Slow After Indexes
- Verify indexes are being used: `EXPLAIN ANALYZE`
- Check if statistics are up to date: `ANALYZE`
- Consider additional indexes for specific slow queries
- Review query plans for sequential scans

### High Index Maintenance Overhead
- Monitor `pg_stat_user_indexes` for bloat
- Rebuild indexes periodically if needed
- Consider partial indexes for filtered queries
- Review and drop unused indexes

## Implementation Status

### Current Workflow
1. ✅ **Indexes in Schema Files** - 87 CREATE INDEX statements in `ac75_empty.sql` and `sailgp_empty.sql`
2. ✅ **Audit Script Created** - `database/migrations/audit_existing_indexes.sql`
3. ✅ **Migration Script Created** - `database/migrations/add_missing_indexes.sql` (for adding missing indexes)
4. ✅ **Verification Script Created** - `database/migrations/verify_indexes.sql`
5. ✅ **Helper Scripts Created** - Windows and Linux/Mac automation scripts
6. ⏳ **Run Audit** - Execute audit script to verify indexes are present in production
7. ⏳ **Review Results** - Check which indexes exist vs which might be missing
8. ⏳ **Apply Missing Indexes** - Run migration script only if any indexes are missing
9. ⏳ **Verify** - Confirm all critical indexes are present and being used
10. ⏳ **Monitor** - Track index usage and performance improvements

### Index Status
- **Schema Files**: 87 indexes defined in `ac75_empty.sql` and `sailgp_empty.sql`
- **Production**: Run `audit_existing_indexes.sql` to verify indexes are present
- **Documentation**: See `docs/database/database-schema.md` for current index listings (updated after audit)

## Next Steps

1. ✅ Review recommendations document
2. ✅ **NEW**: Run audit script to see what indexes already exist
3. ⏳ Apply Phase 1 (Critical) indexes that are missing
4. ⏳ Monitor performance improvements
5. ⏳ Apply Phase 2 (High) indexes that are missing
6. ⏳ Apply Phase 3 (Medium) indexes as needed
7. ⏳ Monitor and optimize based on actual usage

## Support

For questions or issues:
1. Review `database-index-recommendations.md` for detailed explanations
2. Check PostgreSQL documentation for index types
3. Use `EXPLAIN ANALYZE` to diagnose query performance
4. Monitor `pg_stat_user_indexes` for index usage patterns

