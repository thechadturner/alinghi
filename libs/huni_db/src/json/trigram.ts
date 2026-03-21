/**
 * Trigram Index Support
 * 
 * Fast partial string matching using trigram indexing
 */

import type { Connection } from '../core/connection.js';
import { QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * Extract trigrams from a string
 * 
 * A trigram is a sequence of 3 consecutive characters.
 * Example: "hello" -> ["hel", "ell", "llo"]
 */
function extractTrigrams(text: string): string[] {
  if (!text || text.length < 3) {
    return [];
  }

  const trigrams: string[] = [];
  const normalized = text.toLowerCase().trim();
  
  for (let i = 0; i <= normalized.length - 3; i++) {
    const trigram = normalized.substring(i, i + 3);
    if (!trigrams.includes(trigram)) {
      trigrams.push(trigram);
    }
  }

  return trigrams;
}

/**
 * Trigram Indexer
 * 
 * Creates and maintains trigram indexes for fast partial string matching
 */
export class TrigramIndexer {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Escape identifier for SQL
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Create trigram index table for a JSON table
   */
  async createIndex(tableName: string, fieldPath: string): Promise<void> {
    const indexTableName = `trigram_${tableName}_${fieldPath.replace(/\./g, '_')}`;
    
    try {
      // Create trigram index table
      await this.connection.exec(`
        CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier(indexTableName)} (
          doc_id TEXT NOT NULL,
          trigram TEXT NOT NULL,
          PRIMARY KEY (doc_id, trigram)
        ) WITHOUT ROWID
      `);

      // Create index on trigram for fast lookups
      await this.connection.exec(`
        CREATE INDEX IF NOT EXISTS idx_${indexTableName}_trigram 
        ON ${this.escapeIdentifier(indexTableName)}(trigram, doc_id)
      `);

      defaultLogger.debug(`Created trigram index: ${indexTableName} for field: ${fieldPath}`);
    } catch (error) {
      throw new QueryError(
        `Failed to create trigram index: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, fieldPath, error }
      );
    }
  }

  /**
   * Index a document's field value
   */
  async indexDocument(tableName: string, fieldPath: string, docId: string, value: unknown): Promise<void> {
    const indexTableName = `trigram_${tableName}_${fieldPath.replace(/\./g, '_')}`;
    
    try {
      // Delete existing trigrams for this document
      await this.connection.exec(
        `DELETE FROM ${this.escapeIdentifier(indexTableName)} WHERE doc_id = ?`,
        [docId]
      );

      // Extract text value
      let textValue = '';
      if (typeof value === 'string') {
        textValue = value;
      } else if (value !== null && value !== undefined) {
        textValue = String(value);
      }

      if (!textValue) {
        return; // Nothing to index
      }

      // Extract trigrams
      const trigrams = extractTrigrams(textValue);

      if (trigrams.length === 0) {
        return; // No trigrams to index
      }

      // Insert trigrams in batch
      const values = trigrams.map(() => '(?, ?)').join(', ');
      const sql = `
        INSERT OR REPLACE INTO ${this.escapeIdentifier(indexTableName)} (doc_id, trigram)
        VALUES ${values}
      `;

      const params: unknown[] = [];
      for (const trigram of trigrams) {
        params.push(docId, trigram);
      }

      await this.connection.exec(sql, params);
    } catch (error) {
      defaultLogger.warn(`Failed to index document trigrams: ${error instanceof Error ? error.message : String(error)}`);
      // Don't throw - indexing failures shouldn't break document operations
    }
  }

  /**
   * Remove document from trigram index
   */
  async removeDocument(tableName: string, fieldPath: string, docId: string): Promise<void> {
    const indexTableName = `trigram_${tableName}_${fieldPath.replace(/\./g, '_')}`;
    
    try {
      await this.connection.exec(
        `DELETE FROM ${this.escapeIdentifier(indexTableName)} WHERE doc_id = ?`,
        [docId]
      );
    } catch (error) {
      defaultLogger.warn(`Failed to remove document from trigram index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Search for documents matching a partial string
   * 
   * Uses trigram similarity to find documents containing the search term
   */
  async search(
    tableName: string,
    fieldPath: string,
    searchTerm: string,
    options?: { limit?: number; minSimilarity?: number }
  ): Promise<Array<{ docId: string; similarity: number }>> {
    const indexTableName = `trigram_${tableName}_${fieldPath.replace(/\./g, '_')}`;
    const limit = options?.limit || 100;
    const minSimilarity = options?.minSimilarity || 0.3;

    try {
      // Extract trigrams from search term
      const searchTrigrams = extractTrigrams(searchTerm);

      if (searchTrigrams.length === 0) {
        return [];
      }

      // Build query to find documents with matching trigrams
      // Use Jaccard similarity: intersection / union
      const placeholders = searchTrigrams.map(() => '?').join(', ');
      const sql = `
        SELECT 
          doc_id,
          COUNT(DISTINCT trigram) as matching_trigrams,
          ${searchTrigrams.length} as total_search_trigrams
        FROM ${this.escapeIdentifier(indexTableName)}
        WHERE trigram IN (${placeholders})
        GROUP BY doc_id
        HAVING (CAST(matching_trigrams AS REAL) / ${searchTrigrams.length}) >= ?
        ORDER BY matching_trigrams DESC
        LIMIT ?
      `;

      const params: unknown[] = [...searchTrigrams, minSimilarity, limit];

      const results = await this.connection.query<{
        doc_id: string;
        matching_trigrams: number;
        total_search_trigrams: number;
      }>(sql, params);

      return results.map(row => ({
        docId: row.doc_id,
        similarity: row.matching_trigrams / row.total_search_trigrams,
      }));
    } catch (error) {
      throw new QueryError(
        `Failed to search trigram index: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, fieldPath, searchTerm, error }
      );
    }
  }

  /**
   * Drop trigram index
   */
  async dropIndex(tableName: string, fieldPath: string): Promise<void> {
    const indexTableName = `trigram_${tableName}_${fieldPath.replace(/\./g, '_')}`;
    
    try {
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.escapeIdentifier(indexTableName)}`);
      defaultLogger.debug(`Dropped trigram index: ${indexTableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to drop trigram index: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, fieldPath, error }
      );
    }
  }

  /**
   * Check if trigram index exists
   */
  async exists(tableName: string, fieldPath: string): Promise<boolean> {
    const indexTableName = `trigram_${tableName}_${fieldPath.replace(/\./g, '_')}`;
    
    try {
      const count = await this.connection.queryValue<number>(
        `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`,
        [indexTableName]
      );
      return (count ?? 0) > 0;
    } catch {
      return false;
    }
  }
}

