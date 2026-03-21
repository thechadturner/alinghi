/**
 * HuniDB Schema Definitions
 *
 * Creates database schema for each class. HuniDB is used only for metadata and
 * settings (events, datasets, sources, channel names, objects, targets). Timeseries,
 * map data, and aggregates are no longer cached in HuniDB.
 */

import type { Database } from '@hunico/hunidb';
import { debug } from '../utils/console';

/**
 * Create empty database schema for a specific class
 * Creates metadata/settings tables only (events, meta.*, json.*)
 */
export async function createSchemaForClass(db: Database, className: string): Promise<void> {
  // CRITICAL: Do NOT drop tables - data should persist across page reloads
  // Tables are created with "IF NOT EXISTS" below
  // Users can manually clear database via Admin > HuniDB panel if needed

  // Drop any existing indexes for tables we keep (safe to recreate)
  await db.exec(`DROP INDEX IF EXISTS "idx_agg_events_dataset";`);
  await db.exec(`DROP INDEX IF EXISTS "idx_agg_events_time";`);
  await db.exec(`DROP INDEX IF EXISTS "idx_json_objects_ts";`);

  // Create normalized events table
  await db.exec(`
        CREATE TABLE IF NOT EXISTS "agg.events" (
          event_id INTEGER PRIMARY KEY,
          event_type TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          dataset_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          tags TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
      `);
      
  await db.exec(`
        CREATE INDEX IF NOT EXISTS "idx_agg_events_dataset" 
        ON "agg.events"(dataset_id, project_id, source_id);
      `);
      
  await db.exec(`
        CREATE INDEX IF NOT EXISTS "idx_agg_events_time" 
        ON "agg.events"(start_time, end_time);
      `);

  // Targets table (JSON storage for target data)
  await db.exec(`
        CREATE TABLE IF NOT EXISTS "json.targets" (
      description TEXT NOT NULL,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
      is_polar INTEGER,
          data TEXT NOT NULL,
          date_modified INTEGER,
      PRIMARY KEY (description, project_id)
    ) WITHOUT ROWID
  `);
  
  // JSON objects table (for simple key-value storage)
  await db.exec(`
          CREATE TABLE IF NOT EXISTS "json.objects" (
              description TEXT PRIMARY KEY,
              doc TEXT NOT NULL,
              ts INTEGER NOT NULL
            )
          `);
          
  await db.exec(`
    CREATE INDEX IF NOT EXISTS "idx_json_objects_ts" 
    ON "json.objects"(ts DESC);
  `);
  
  // Datasets metadata table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "json.datasets" (
          dataset_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
              doc TEXT NOT NULL,
              ts INTEGER NOT NULL,
      PRIMARY KEY (dataset_id, project_id)
    ) WITHOUT ROWID
  `);
  
  // Meta datasets table (tracks dataset metadata for caching)
  await db.exec(`
        CREATE TABLE IF NOT EXISTS "meta.datasets" (
          dataset_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
      date TEXT,
          source_id TEXT NOT NULL,
          class_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      first_timestamp INTEGER NOT NULL,
      last_timestamp INTEGER NOT NULL,
      date_modified INTEGER NOT NULL,
      last_viewed_date INTEGER
    )
  `);
  
  // Meta sources table (tracks source metadata)
  await db.exec(`
        CREATE TABLE IF NOT EXISTS "meta.sources" (
      source_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
          source_name TEXT,
          color TEXT,
      fleet INTEGER,
      visible INTEGER,
      PRIMARY KEY (source_id, project_id)
              ) WITHOUT ROWID
  `);

  // Meta channel_names table (caches original-case channel names for picker UI)
  // Channels are unique to the class, so no need for dataset_id, project_id, or source_id
  await db.exec(`
        CREATE TABLE IF NOT EXISTS "meta.channel_names" (
          channel_name TEXT NOT NULL,
          date TEXT NOT NULL,
          data_source TEXT NOT NULL CHECK(data_source IN ('FILE', 'INFLUX', 'UNIFIED')),
          discovered_at INTEGER NOT NULL,
          PRIMARY KEY (channel_name, data_source)
        ) WITHOUT ROWID
  `);
  
  await db.exec(`
        CREATE INDEX IF NOT EXISTS "idx_meta_channel_names_lookup" 
        ON "meta.channel_names"(data_source);
  `);
  
  await db.exec(`
        CREATE INDEX IF NOT EXISTS "idx_meta_channel_names_date" 
        ON "meta.channel_names"(date, data_source);
  `);

  // Density optimization tables for scatter plot caching
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "density.charts" (
      chart_object_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      color_type TEXT NOT NULL,
      chart_filters TEXT,
      global_filters TEXT,
      total_points INTEGER,
      optimized_points INTEGER,
      data_hash TEXT,
      last_accessed INTEGER,
      PRIMARY KEY (chart_object_id, dataset_id, project_id, source_id, color_type)
    ) WITHOUT ROWID
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS "density.groups" (
      chart_object_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      color_type TEXT NOT NULL,
      group_name TEXT NOT NULL,
      color TEXT,
      data TEXT NOT NULL,
      regression TEXT,
      table_values TEXT,
      PRIMARY KEY (chart_object_id, dataset_id, project_id, source_id, color_type, group_name)
    ) WITHOUT ROWID
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS "idx_density_charts_access" 
    ON "density.charts"(last_accessed DESC);
  `);

  debug(`[Schema] Created database schema for class: ${className}`);
}
