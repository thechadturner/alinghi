# Database Index Recommendations

## Overview
This document provides comprehensive index recommendations based on analysis of API query patterns. Indexes are prioritized by query frequency and performance impact.

**Status**: All recommended critical and high-priority indexes are **implemented** in `database/hunico_database_emptry.sql`. This document serves as reference for understanding index strategy and for adding new indexes as needed.

## Implementation Status

**✅ All Critical and High Priority Indexes Implemented**

All indexes marked as CRITICAL and HIGH in this document are **already implemented** in `database/hunico_database_emptry.sql`. The schema file contains 87 total indexes:

- **admin schema**: 33 indexes
- **ac75 schema**: 27 indexes
- **gp50 schema**: 27 indexes

Databases created from the schema file will have all these indexes pre-created. For existing databases, run the audit script to verify index presence.

## Priority Levels
- **CRITICAL**: Must-have indexes for core functionality (✅ All implemented)
- **HIGH**: Frequently used queries that will significantly benefit (✅ All implemented)
- **MEDIUM**: Important but less frequent queries (✅ Most implemented)
- **LOW**: Nice-to-have for edge cases (Some implemented)

---

## Core Tables (Per-Class Schema)

### 1. `{class_name}.datasets` - CRITICAL

**Current Usage Patterns:**
- Filtered by `source_id` + `date` (most common)
- Filtered by `source_id` + `year_name` + `event_name`
- Filtered by `source_id` + `year_name`
- Filtered by `source_id` + `event_name`
- Filtered by `project_id` (via sources join)
- Ordered by `date DESC`
- Filtered by `visible = 1`

**Recommended Indexes:**

```sql
-- CRITICAL: Most common query pattern (getDatasets, getDatasetIds, getLastDatasetDate)
CREATE INDEX idx_datasets_source_date ON {class_name}.datasets(source_id, date DESC);

-- CRITICAL: Year-based filtering (getDatasetEvents, getDatasets)
CREATE INDEX idx_datasets_source_year_event ON {class_name}.datasets(source_id, year_name, event_name);

-- HIGH: Visibility filtering for read-only users
CREATE INDEX idx_datasets_source_visible_date ON {class_name}.datasets(source_id, visible, date DESC) WHERE visible = 1;

-- HIGH: Project-level queries (via sources join - consider covering index)
CREATE INDEX idx_datasets_source_year ON {class_name}.datasets(source_id, year_name);

-- MEDIUM: Event name filtering
CREATE INDEX idx_datasets_source_event ON {class_name}.datasets(source_id, event_name, date DESC);
```

**Note:** The `source_id` column should already have a foreign key index, but verify it exists.

---

### 2. `{class_name}.dataset_events` - CRITICAL

**Current Usage Patterns:**
- Filtered by `dataset_id` (most common)
- Filtered by `dataset_id` + `event_type`
- Filtered by `event_id` (PK - already indexed)
- Filtered by `event_type` + `start_time` + `end_time` (range queries)
- Ordered by `start_time`
- Ordered by `event_id DESC`
- JSONB tag queries (`tags ->> 'Race_number'`)

**Recommended Indexes:**

```sql
-- CRITICAL: Most common query pattern (getEvents, getEventsInfo)
CREATE INDEX idx_dataset_events_dataset_id ON {class_name}.dataset_events(dataset_id, event_id DESC);

-- CRITICAL: Event type filtering (getEventsInfo, getRaces)
CREATE INDEX idx_dataset_events_dataset_type ON {class_name}.dataset_events(dataset_id, event_type, start_time);

-- HIGH: Time range queries (updateEventTags - finding matching events)
CREATE INDEX idx_dataset_events_type_time_range ON {class_name}.dataset_events(event_type, start_time, end_time, dataset_id);

-- HIGH: Event ID lookups (getEventTimes, getEventObject)
CREATE INDEX idx_dataset_events_event_ids ON {class_name}.dataset_events(event_id) INCLUDE (start_time, end_time, dataset_id);

-- MEDIUM: JSONB tag queries (getRaces - Race_number extraction)
CREATE INDEX idx_dataset_events_tags_race ON {class_name}.dataset_events USING GIN ((tags -> 'Race_number'));
```

---

### 3. `{class_name}.sources` - HIGH

**Current Usage Patterns:**
- Filtered by `project_id` (most common)
- Filtered by `source_id` (PK - already indexed)
- Ordered by `source_name DESC`

**Recommended Indexes:**

```sql
-- HIGH: Project-based source queries (getSources)
CREATE INDEX idx_sources_project_name ON {class_name}.sources(project_id, source_name DESC);
```

---

### 4. `{class_name}.media` - HIGH

**Current Usage Patterns:**
- Filtered by `start_time::date` + `media_source`
- Filtered by `project_id` + `file_name` + `media_source` + `date`
- Filtered by `project_id` + `file_name` + `media_source`
- Ordered by date

**Recommended Indexes:**

```sql
-- HIGH: Date-based media source queries (getMediaSources, getMediaBySource)
CREATE INDEX idx_media_date_source ON {class_name}.media((start_time::date), media_source);

-- HIGH: Unique media lookup (addMedia, removeMedia)
CREATE INDEX idx_media_project_file_source_date ON {class_name}.media(project_id, file_name, media_source, date);

-- MEDIUM: Project-based queries
CREATE INDEX idx_media_project_date ON {class_name}.media(project_id, (start_time::date));
```

---

### 5. `{class_name}.targets` - MEDIUM

**Current Usage Patterns:**
- Filtered by `project_id` + `isPolar`
- Filtered by `project_id` + `name` + `isPolar`
- Ordered by `date_modified`

**Recommended Indexes:**

```sql
-- MEDIUM: Target queries (getTargets, getTargetData)
CREATE INDEX idx_targets_project_polar_name ON {class_name}.targets(project_id, "isPolar", name);

-- MEDIUM: Latest target queries (getLatestTargets)
CREATE INDEX idx_targets_project_polar_modified ON {class_name}.targets(project_id, "isPolar", date_modified DESC);
```

---

### 6. `{class_name}.events_aggregate` - CRITICAL

**Current Usage Patterns:**
- Filtered by `event_id` + `agr_type` (most common)
- Joined with `dataset_events` on `event_id`
- Joined with `datasets` via `dataset_events`

**Recommended Indexes:**

```sql
-- CRITICAL: Primary lookup pattern (getAggregateData, getPerformanceData)
CREATE INDEX idx_events_aggregate_event_agr ON {class_name}.events_aggregate(event_id, agr_type);

-- HIGH: Covering index for common queries
CREATE INDEX idx_events_aggregate_event_agr_covering ON {class_name}.events_aggregate(event_id, agr_type) INCLUDE (/* add frequently selected columns */);
```

---

### 7. `{class_name}.events_cloud` - CRITICAL

**Current Usage Patterns:**
- Filtered by `event_id` (most common)
- Joined with `dataset_events` on `event_id`

**Recommended Indexes:**

```sql
-- CRITICAL: Primary lookup pattern (getPerformanceData)
CREATE INDEX idx_events_cloud_event_id ON {class_name}.events_cloud(event_id);
```

---

### 8. `{class_name}.maneuver_stats` - HIGH

**Current Usage Patterns:**
- Filtered by `event_id` (most common)
- Joined with `dataset_events` on `event_id`
- Ordered by `vmg_perc_avg DESC`

**Recommended Indexes:**

```sql
-- HIGH: Primary lookup pattern (getManeuvers_TableData, getManeuvers_MapData)
CREATE INDEX idx_maneuver_stats_event_id ON {class_name}.maneuver_stats(event_id);

-- MEDIUM: Performance ranking queries
CREATE INDEX idx_maneuver_stats_vmg ON {class_name}.maneuver_stats(vmg_perc_avg DESC) INCLUDE (event_id);
```

---

### 9. `{class_name}.events_mapdata` - MEDIUM

**Current Usage Patterns:**
- Filtered by `event_id` + `description`
- Joined with `dataset_events` on `event_id`

**Recommended Indexes:**

```sql
-- MEDIUM: Event object queries (getManeuvers_MapData, getEventObject)
CREATE INDEX idx_events_mapdata_event_desc ON {class_name}.events_mapdata(event_id, description);
```

---

### 10. `{class_name}.events_timeseries` - MEDIUM

**Current Usage Patterns:**
- Filtered by `event_id` + `description`
- Joined with `dataset_events` on `event_id`

**Recommended Indexes:**

```sql
-- MEDIUM: Event object queries (getManeuvers_TimeSeriesData, getEventObject)
CREATE INDEX idx_events_timeseries_event_desc ON {class_name}.events_timeseries(event_id, description);
```

---

### 11. `{class_name}.dataset_objects` - MEDIUM

**Current Usage Patterns:**
- Filtered by `dataset_id` + `parent_name` + `object_name`
- Ordered by `date_modified DESC`

**Recommended Indexes:**

```sql
-- MEDIUM: Dataset object queries (getDatasetObject, addDatasetObject)
CREATE INDEX idx_dataset_objects_lookup ON {class_name}.dataset_objects(dataset_id, parent_name, object_name, date_modified DESC);
```

---

### 12. `{class_name}.project_objects` - LOW

**Current Usage Patterns:**
- Filtered by `project_id` + `date` + `object_name`
- Ordered by `date_modified DESC`

**Recommended Indexes:**

```sql
-- LOW: Project object queries (getProjectObject)
CREATE INDEX idx_project_objects_lookup ON {class_name}.project_objects(project_id, date, object_name, date_modified DESC);
```

---

### 13. `{class_name}.class_objects` - MEDIUM

**Current Usage Patterns:**
- Filtered by `object_name`
- Ordered by `date_modified DESC`

**Recommended Indexes:**

```sql
-- MEDIUM: Class object queries (getClassObject)
CREATE INDEX idx_class_objects_name_modified ON {class_name}.class_objects(object_name, date_modified DESC);
```

---

## Admin Schema Tables

### 14. `admin.projects` - HIGH

**Current Usage Patterns:**
- Filtered by `project_id` (PK - already indexed)
- Filtered by `user_id`
- Filtered by `project_name` + `class_id` + `user_id`
- Joined with `admin.classes` on `class_id`

**Recommended Indexes:**

```sql
-- HIGH: User project queries (getProjectsByType)
CREATE INDEX idx_projects_user_id ON admin.projects(user_id, project_id);

-- MEDIUM: Project name uniqueness check (addProject)
CREATE INDEX idx_projects_name_class_user ON admin.projects(project_name, class_id, user_id);
```

---

### 15. `admin.user_projects` - CRITICAL

**Current Usage Patterns:**
- Filtered by `user_id` (most common)
- Filtered by `project_id`
- Filtered by `user_id` + `project_id` (join table)

**Recommended Indexes:**

```sql
-- CRITICAL: User permission queries (check_permissions - most frequent)
CREATE INDEX idx_user_projects_user_id ON admin.user_projects(user_id, project_id);

-- HIGH: Project user queries (getProjectUsers)
CREATE INDEX idx_user_projects_project_id ON admin.user_projects(project_id, user_id);
```

---

### 16. `admin.users` - MEDIUM

**Current Usage Patterns:**
- Filtered by `user_id` (PK - already indexed)
- Filtered by `email` (likely unique)

**Recommended Indexes:**

```sql
-- MEDIUM: Email lookups (if not already unique)
CREATE UNIQUE INDEX idx_users_email ON admin.users(email) WHERE email IS NOT NULL;
```

---

### 17. `admin.personal_api_tokens` - MEDIUM

**Current Usage Patterns:**
- Filtered by `token_hash` (authentication)
- Filtered by `user_id`
- Filtered by `revoked_at IS NULL` (active tokens)

**Recommended Indexes:**

```sql
-- MEDIUM: Token authentication (very frequent)
CREATE INDEX idx_personal_api_tokens_hash ON admin.personal_api_tokens(token_hash) WHERE revoked_at IS NULL;

-- LOW: User token queries
CREATE INDEX idx_personal_api_tokens_user ON admin.personal_api_tokens(user_id, revoked_at);
```

---

## Composite Join Optimization

### Cross-Table Query Patterns

Many queries join multiple tables. Consider these composite strategies:

```sql
-- For queries joining datasets -> sources -> projects
-- Ensure foreign key indexes exist:
-- datasets.source_id -> sources.source_id (should exist as FK)
-- sources.project_id -> projects.project_id (should exist as FK)

-- For queries joining dataset_events -> datasets -> sources
-- The dataset_id FK in dataset_events should be indexed (covered above)
```

---

## JSONB Indexes

### GIN Indexes for JSONB Columns

```sql
-- For tags queries in dataset_events (getRaces, getDatasetDesc)
CREATE INDEX idx_dataset_events_tags_gin ON {class_name}.dataset_events USING GIN (tags);

-- For tags queries in datasets (if frequently queried)
CREATE INDEX idx_datasets_tags_gin ON {class_name}.datasets USING GIN (tags);

-- For tags queries in media (if frequently queried)
CREATE INDEX idx_media_tags_gin ON {class_name}.media USING GIN (tags);
```

**Note:** GIN indexes are larger but enable fast JSONB queries. Only create if you frequently query JSONB fields.

---

## Implementation Priority

### Phase 1: CRITICAL (Implement First)
1. `idx_datasets_source_date`
2. `idx_dataset_events_dataset_id`
3. `idx_dataset_events_dataset_type`
4. `idx_user_projects_user_id`
5. `idx_events_aggregate_event_agr`
6. `idx_events_cloud_event_id`

### Phase 2: HIGH (Implement Next)
7. `idx_datasets_source_year_event`
8. `idx_dataset_events_type_time_range`
9. `idx_sources_project_name`
10. `idx_media_date_source`
11. `idx_maneuver_stats_event_id`

### Phase 3: MEDIUM (Implement When Time Permits)
12. All remaining MEDIUM priority indexes
13. JSONB GIN indexes (if JSONB queries are slow)

### Phase 4: LOW (Optional)
14. All LOW priority indexes

---

## Maintenance Notes

1. **Index Maintenance**: Monitor index bloat and rebuild periodically:
   ```sql
   REINDEX INDEX CONCURRENTLY index_name;
   ```

2. **Index Usage Monitoring**: Check which indexes are actually used:
   ```sql
   SELECT * FROM pg_stat_user_indexes WHERE schemaname = 'your_schema';
   ```

3. **Query Performance**: Use `EXPLAIN ANALYZE` to verify index usage:
   ```sql
   EXPLAIN ANALYZE SELECT ...;
   ```

4. **Partial Indexes**: Some indexes use `WHERE` clauses for filtered indexes (e.g., `visible = 1`). These are smaller and faster.

5. **Covering Indexes**: Consider `INCLUDE` columns for frequently selected but not filtered columns.

---

## Schema-Specific Considerations

Since your database uses per-class schemas (AC75, IMOCA, etc.), you'll need to create these indexes for each class schema:

```sql
-- Example for AC75 schema
CREATE INDEX idx_datasets_source_date ON ac75.datasets(source_id, date DESC);
CREATE INDEX idx_dataset_events_dataset_id ON ac75.dataset_events(dataset_id, event_id DESC);
-- ... repeat for all indexes
```

Consider creating a migration script that applies indexes to all class schemas.

---

## Foreign Key Indexes

PostgreSQL automatically creates indexes on primary keys, but **NOT** on foreign keys. Verify these FK indexes exist:

```sql
-- Verify foreign key indexes exist (they should, but check)
-- datasets.source_id -> sources.source_id
-- sources.project_id -> projects.project_id  
-- dataset_events.dataset_id -> datasets.dataset_id
-- user_projects.user_id -> users.user_id
-- user_projects.project_id -> projects.project_id
```

If missing, create them as they're critical for join performance.

---

## Summary Statistics

After creating indexes, update table statistics:

```sql
ANALYZE {class_name}.datasets;
ANALYZE {class_name}.dataset_events;
ANALYZE {class_name}.sources;
-- ... for all tables
```

Or update all at once:
```sql
ANALYZE;
```

