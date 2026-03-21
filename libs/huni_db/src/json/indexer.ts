/**
 * JSON Index Manager
 * 
 * Maintains indexes for JSON document keys and values
 */

import type { Connection } from '../core/connection.js';
import type { JSONTableOptions } from './types.js';
import { QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * JSON Index Manager
 */
export class JSONIndexer {
  private connection: Connection;

  // Safety limits to prevent runaway recursion / huge documents from blowing the stack
  // Depth is measured in nested object/array levels, nodeCount is total visited nodes.
  private static readonly MAX_DEPTH = 16;
  private static readonly MAX_NODES = 50000;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize index tables for a JSON table
   */
  async initializeTable(tableName: string, options?: JSONTableOptions): Promise<void> {
    try {
      // Sanitize index name by replacing dots with underscores (SQLite interprets dots as database.table)
      // Declare once at the beginning to reuse for all indexes
      const sanitizedIndexName = tableName.replace(/\./g, '_');
      
      // Create json_keys table (key → doc_id mapping)
      await this.connection.exec(`
        CREATE TABLE IF NOT EXISTS ${this.getKeysTableName(tableName)} (
          table_name TEXT NOT NULL,
          key_path TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          PRIMARY KEY (table_name, key_path, doc_id)
        )
      `);

      // Create index on key_path for fast lookups
      await this.connection.exec(`
        CREATE INDEX IF NOT EXISTS "${sanitizedIndexName}_keys_path" 
        ON ${this.getKeysTableName(tableName)}(key_path, doc_id)
      `);

      // Create json_values table (value → doc_id mapping)
      await this.connection.exec(`
        CREATE TABLE IF NOT EXISTS ${this.getValuesTableName(tableName)} (
          table_name TEXT NOT NULL,
          key_path TEXT NOT NULL,
          value_hash TEXT,
          doc_id TEXT NOT NULL,
          value_text TEXT,
          value_type TEXT,
          PRIMARY KEY (table_name, key_path, doc_id, value_hash)
        )
      `);

      // Create indexes for value lookups
      await this.connection.exec(`
        CREATE INDEX IF NOT EXISTS "${sanitizedIndexName}_values_key" 
        ON ${this.getValuesTableName(tableName)}(key_path, value_hash)
      `);

      await this.connection.exec(`
        CREATE INDEX IF NOT EXISTS "${sanitizedIndexName}_values_text" 
        ON ${this.getValuesTableName(tableName)}(key_path, value_text)
      `);

      // Create triggers for automatic index maintenance
      await this.createTriggers(tableName);

      defaultLogger.debug(`Initialized indexes for JSON table: ${tableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to initialize indexes: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, options, error }
      );
    }
  }

  /**
   * Create triggers for automatic index maintenance
   */
  private async createTriggers(tableName: string): Promise<void> {
    // Drop existing triggers if any
    // Sanitize trigger names by replacing dots with underscores
    const sanitizedTriggerName = tableName.replace(/\./g, '_');
    await this.connection.exec(`DROP TRIGGER IF EXISTS "trg_${sanitizedTriggerName}_insert"`);
    await this.connection.exec(`DROP TRIGGER IF EXISTS "trg_${sanitizedTriggerName}_update"`);
    await this.connection.exec(`DROP TRIGGER IF EXISTS "trg_${sanitizedTriggerName}_delete"`);

    // Note: SQLite triggers can't easily parse JSON, so we'll use client-side indexing
    // This is more flexible and allows for better error handling
    // Triggers would require SQLite JSON functions which are available but complex
  }

  /**
   * Index a document (extract keys and values)
   */
  async indexDocument(tableName: string, docId: string, doc: unknown): Promise<void> {
    try {
      // Remove old indexes first
      await this.removeDocument(tableName, docId);

      // Extract all keys and values from document
      const keys = this.extractKeys(doc);
      const values = this.extractValues(doc);

      // Insert keys
      for (const keyPath of keys) {
        await this.connection.exec(
          `INSERT OR REPLACE INTO ${this.getKeysTableName(tableName)} (table_name, key_path, doc_id) VALUES (?, ?, ?)`,
          [tableName, keyPath, docId]
        );
      }

      // Insert values
      for (const { keyPath, hash, text, type } of values) {
        await this.connection.exec(
          `INSERT OR REPLACE INTO ${this.getValuesTableName(tableName)} (table_name, key_path, value_hash, doc_id, value_text, value_type) VALUES (?, ?, ?, ?, ?, ?)`,
          [tableName, keyPath, hash, docId, text, type]
        );
      }
    } catch (error) {
      // Best-effort logging of the document that caused the failure
      try {
        let docPreview: string | null = null;
        try {
          const json = JSON.stringify(doc);
          // Avoid logging arbitrarily huge payloads
          const MAX_PREVIEW_LENGTH = 5000;
          docPreview = json.length > MAX_PREVIEW_LENGTH
            ? `${json.slice(0, MAX_PREVIEW_LENGTH)}... [truncated, length=${json.length}]`
            : json;
        } catch (stringifyError) {
          docPreview = `[unstringifiable document: ${stringifyError instanceof Error ? stringifyError.message : String(stringifyError)}]`;
        }

        defaultLogger.error('JSONIndexer: Failed to index document', {
          tableName,
          docId,
          docPreview,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Swallow any logging errors – we still throw the QueryError below
      }

      throw new QueryError(
        `Failed to index document: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, docId, error }
      );
    }
  }

  /**
   * Remove document from indexes
   */
  async removeDocument(tableName: string, docId: string): Promise<void> {
    try {
      await this.connection.exec(
        `DELETE FROM ${this.getKeysTableName(tableName)} WHERE table_name = ? AND doc_id = ?`,
        [tableName, docId]
      );

      await this.connection.exec(
        `DELETE FROM ${this.getValuesTableName(tableName)} WHERE table_name = ? AND doc_id = ?`,
        [tableName, docId]
      );
    } catch (error) {
      throw new QueryError(
        `Failed to remove document from indexes: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, docId, error }
      );
    }
  }

  /**
   * Rebuild all indexes for a table
   */
  async rebuildIndexes(tableName: string): Promise<void> {
    try {
      // Clear existing indexes
      await this.connection.exec(`DELETE FROM ${this.getKeysTableName(tableName)} WHERE table_name = ?`, [tableName]);
      await this.connection.exec(`DELETE FROM ${this.getValuesTableName(tableName)} WHERE table_name = ?`, [tableName]);

      // Get all documents
      const documents = await this.connection.query<{ id: string; doc: string }>(
        `SELECT id, doc FROM ${this.escapeIdentifier(tableName)}`
      );

      // Re-index all documents
      for (const { id, doc } of documents) {
        const docObj = JSON.parse(doc);
        await this.indexDocument(tableName, id, docObj);
      }

      defaultLogger.info(`Rebuilt indexes for ${tableName}: ${documents.length} documents`);
    } catch (error) {
      throw new QueryError(
        `Failed to rebuild indexes: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Get list of indexed keys for a table
   */
  async getIndexedKeys(tableName: string): Promise<string[]> {
    try {
      const results = await this.connection.query<{ key_path: string }>(
        `SELECT DISTINCT key_path FROM ${this.getKeysTableName(tableName)} WHERE table_name = ? ORDER BY key_path`,
        [tableName]
      );

      return results.map(r => r.key_path);
    } catch (error) {
      throw new QueryError(
        `Failed to get indexed keys: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Drop index tables for a table
   */
  async dropTable(tableName: string): Promise<void> {
    try {
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.getKeysTableName(tableName)}`);
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.getValuesTableName(tableName)}`);
    } catch (error) {
      throw new QueryError(
        `Failed to drop index tables: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Extract all key paths from a JSON object
   * 
   * Uses a WeakSet to avoid infinite recursion on cyclic structures.
   */
  private extractKeys(
    obj: unknown,
    prefix = '',
    visited: WeakSet<object> = new WeakSet(),
    depth = 0,
    stats: { count: number } = { count: 0 }
  ): string[] {
    const keys: string[] = [];

    if (obj === null || obj === undefined) {
      return keys;
    }

    // Depth / size guards to prevent stack overflows on pathological documents
    if (depth > JSONIndexer.MAX_DEPTH || stats.count > JSONIndexer.MAX_NODES) {
      return keys;
    }

    if (typeof obj === 'object' && !Array.isArray(obj)) {
      const objRef = obj as object;
      if (visited.has(objRef)) {
        // Avoid infinite recursion on cyclic references
        return keys;
      }
      visited.add(objRef);

      for (const [key, value] of Object.entries(obj)) {
        // Increment node count and bail out early if we exceed limits
        stats.count++;
        if (stats.count > JSONIndexer.MAX_NODES) {
          break;
        }

        const keyPath = prefix ? `${prefix}.${key}` : key;
        keys.push(keyPath);

        // Recursively extract nested keys
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          keys.push(...this.extractKeys(value, keyPath, visited, depth + 1, stats));
        }
      }
    }

    return keys;
  }

  /**
   * Extract all values from a JSON object with their paths
   * 
   * Uses a WeakSet to avoid infinite recursion on cyclic structures.
   */
  private extractValues(
    obj: unknown,
    prefix = '',
    visited: WeakSet<object> = new WeakSet(),
    depth = 0,
    stats: { count: number } = { count: 0 }
  ): Array<{
    keyPath: string;
    value: unknown;
    hash: string;
    text: string | null;
    type: string;
  }> {
    const values: Array<{
      keyPath: string;
      value: unknown;
      hash: string;
      text: string | null;
      type: string;
    }> = [];

    if (obj === null || obj === undefined) {
      return values;
    }

    // Depth / size guards to prevent stack overflows on pathological documents
    if (depth > JSONIndexer.MAX_DEPTH || stats.count > JSONIndexer.MAX_NODES) {
      return values;
    }

    if (Array.isArray(obj)) {
      // For arrays, index each element
      obj.forEach((item, index) => {
        const keyPath = prefix ? `${prefix}[${index}]` : `[${index}]`;
        values.push(...this.extractValues(item, keyPath, visited, depth + 1, stats));
      });
    } else if (typeof obj === 'object') {
      const objRef = obj as object;
      if (visited.has(objRef)) {
        // Avoid infinite recursion on cyclic references
        return values;
      }
      visited.add(objRef);

      for (const [key, value] of Object.entries(obj)) {
        // Increment node count and bail out early if we exceed limits
        stats.count++;
        if (stats.count > JSONIndexer.MAX_NODES) {
          break;
        }

        const keyPath = prefix ? `${prefix}.${key}` : key;

        // Index the value itself
        const valueHash = this.hashValue(value);
        const valueText = typeof value === 'string' ? value : null;
        const valueType = this.getType(value);

        values.push({
          keyPath,
          value,
          hash: valueHash,
          text: valueText,
          type: valueType,
        });

        // Recursively extract nested values
        if (typeof value === 'object' && value !== null) {
          values.push(...this.extractValues(value, keyPath, visited, depth + 1, stats));
        }
      }
    } else {
      // Primitive value
      const keyPath = prefix || 'value';
      const valueHash = this.hashValue(obj);
      const valueText = typeof obj === 'string' ? obj : null;
      const valueType = this.getType(obj);

      values.push({
        keyPath,
        value: obj,
        hash: valueHash,
        text: valueText,
        type: valueType,
      });
    }

    return values;
  }

  /**
   * Hash a value for indexing
   */
  private hashValue(value: unknown): string {
    const str = JSON.stringify(value);
    // Simple hash function (for production, consider using a proper hash)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Get type of a value
   */
  private getType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * Get keys table name
   */
  private getKeysTableName(tableName: string): string {
    return this.escapeIdentifier(`json_keys_${tableName}`);
  }

  /**
   * Get values table name
   */
  private getValuesTableName(tableName: string): string {
    return this.escapeIdentifier(`json_values_${tableName}`);
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
}

