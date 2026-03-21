/**
 * Verification script to check that HuniDB indexes are automatically applied
 *
 * HuniDB is used for metadata/settings only (no timeseries, map, or aggregate data cache).
 * This script documents expected schema and indexes.
 */

console.log(`
HuniDB Index Verification Guide
================================

HuniDB is used for metadata and settings only (events, meta.*, json.*).
Timeseries, map data, and aggregates are NOT cached in HuniDB.

Indexes ARE automatically applied for remaining tables:

1. SCHEMA TABLES (created in huniDBSchema.ts):
   - All indexes use "CREATE INDEX IF NOT EXISTS"
   - Created when createSchemaForClass() is called
   - Tables: agg.events, meta.datasets, meta.sources, meta.channel_names, json.* (objects, targets, datasets)

2. JSON TABLES (via JSONIndexer):
   - Indexes created automatically in initializeTable()
   - Creates json_keys and json_values tables with indexes

To verify indexes programmatically (if huniDBStore exposes verifyIndexes):
  await huniDBStore.verifyIndexes(className)

Expected indexes per class:
  - Events, meta (datasets, sources, channel_names), json (objects, targets, datasets)
  - No ts.*, map.data, cloud.data, or density.* tables (agg.aggregates is deprecated and not created)
`);
