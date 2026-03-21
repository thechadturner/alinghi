/**
 * Migration Helpers for JSON Tables
 * 
 * Helper functions to create JSON tables in migrations
 */

import type { MigrationExecutor } from '../schema/types.js';
import type { JSONTableOptions } from './types.js';

/**
 * Create a JSON table in a migration
 */
export async function createJSONTable(
  executor: MigrationExecutor,
  tableName: string,
  _options?: JSONTableOptions
): Promise<void> {
  // Create main document table
  await executor.exec(`
    CREATE TABLE IF NOT EXISTS ${escapeIdentifier(tableName)} (
      id TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `);

  // Create index on timestamp
  await executor.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_ts 
    ON ${escapeIdentifier(tableName)}(ts)
  `);

  // Create json_keys table
  await executor.exec(`
    CREATE TABLE IF NOT EXISTS ${escapeIdentifier(`json_keys_${tableName}`)} (
      table_name TEXT NOT NULL,
      key_path TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      PRIMARY KEY (table_name, key_path, doc_id)
    )
  `);

  await executor.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_keys_path 
    ON ${escapeIdentifier(`json_keys_${tableName}`)}(key_path, doc_id)
  `);

  // Create json_values table
  await executor.exec(`
    CREATE TABLE IF NOT EXISTS ${escapeIdentifier(`json_values_${tableName}`)} (
      table_name TEXT NOT NULL,
      key_path TEXT NOT NULL,
      value_hash TEXT,
      doc_id TEXT NOT NULL,
      value_text TEXT,
      value_type TEXT,
      PRIMARY KEY (table_name, key_path, doc_id, value_hash)
    )
  `);

  await executor.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_values_key 
    ON ${escapeIdentifier(`json_values_${tableName}`)}(key_path, value_hash)
  `);

  await executor.exec(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_values_text 
    ON ${escapeIdentifier(`json_values_${tableName}`)}(key_path, value_text)
  `);
}

/**
 * Drop a JSON table in a migration
 */
export async function dropJSONTable(
  executor: MigrationExecutor,
  tableName: string
): Promise<void> {
  // Drop index tables first
  await executor.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(`json_keys_${tableName}`)}`);
  await executor.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(`json_values_${tableName}`)}`);
  
  // Drop main table
  await executor.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)}`);
}

/**
 * Escape SQL identifier
 */
function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

