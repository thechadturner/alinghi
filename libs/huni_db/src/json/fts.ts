/**
 * FTS5 Full-Text Search Integration
 * 
 * Provides full-text search capabilities using SQLite FTS5 extension
 */

import type { Connection } from '../core/connection.js';
import type { FTSOptions, FTSResult } from '../performance/types.js';
import { QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * FTS5 Indexer
 */
export class FTSIndexer {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Create FTS5 virtual table for a JSON table
   */
  async createFTSIndex(tableName: string, options?: FTSOptions): Promise<void> {
    try {
      const ftsTableName = `${tableName}_fts`;
      const tokenizer = options?.tokenizer || 'unicode61';

      defaultLogger.info(`Creating FTS5 index: ${ftsTableName} for table: ${tableName}`);

      // Drop existing table if it exists (to allow recreation)
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.escapeIdentifier(ftsTableName)}`);
      defaultLogger.debug(`Dropped existing FTS table if it existed: ${ftsTableName}`);

      // Create FTS5 virtual table
      // Note: content_rowid is not needed for simple FTS5 tables
      try {
        await this.connection.exec(`
          CREATE VIRTUAL TABLE ${this.escapeIdentifier(ftsTableName)}
          USING fts5(
            doc_id UNINDEXED,
            content,
            tokenize='${tokenizer}'
          )
        `);
        defaultLogger.debug(`Created FTS5 virtual table: ${ftsTableName}`);
      } catch (createError) {
        defaultLogger.error(`Failed to create FTS5 table: ${createError}`);
        throw new QueryError(
          `Failed to create FTS5 virtual table: ${createError instanceof Error ? createError.message : String(createError)}. FTS5 may not be enabled in SQLite.`,
          { tableName, ftsTableName, error: createError }
        );
      }

      // Verify table was created
      const tableCreated = await this.connection.queryValue<number>(
        `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`,
        [ftsTableName]
      );

      if (!tableCreated || tableCreated === 0) {
        defaultLogger.error(`FTS5 table verification failed: ${ftsTableName} does not exist after creation`);
        throw new QueryError(
          `Failed to create FTS5 table: ${ftsTableName}. FTS5 may not be enabled in SQLite.`,
          { tableName, ftsTableName }
        );
      }

      defaultLogger.debug(`Verified FTS5 table creation: ${ftsTableName}`);

      // Create trigger to keep FTS index in sync with main table
      await this.createSyncTriggers(tableName, ftsTableName);
      defaultLogger.debug(`Created sync triggers for: ${ftsTableName}`);

      // Populate FTS index with existing documents
      try {
        await this.populateFTSIndex(tableName, ftsTableName);
        defaultLogger.debug(`Populated FTS index with existing documents`);
      } catch (populateError) {
        defaultLogger.error(`Failed to populate FTS index: ${populateError instanceof Error ? populateError.message : String(populateError)}`);
        throw populateError;
      }

      // Final verification
      try {
        const finalCheck = await this.connection.queryValue<number>(
          `SELECT COUNT(*) FROM ${this.escapeIdentifier(ftsTableName)}`
        );
        defaultLogger.info(`Created FTS5 index: ${ftsTableName} for table: ${tableName} with ${finalCheck || 0} indexed documents`);
      } catch (verifyError) {
        defaultLogger.error(`Failed to verify FTS index: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
        // Don't throw here - table might exist but query failed
      }
    } catch (error) {
      throw new QueryError(
        `Failed to create FTS5 index: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, options, error }
      );
    }
  }

  /**
   * Check if FTS index exists
   */
  async exists(tableName: string): Promise<boolean> {
    try {
      const ftsTableName = `${tableName}_fts`;
      const count = await this.connection.queryValue<number>(
        `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`,
        [ftsTableName]
      );
      return (count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Search using FTS5
   */
  async search(
    tableName: string,
    query: string,
    options?: {
      limit?: number;
      offset?: number;
      highlight?: boolean;
    }
  ): Promise<FTSResult[]> {
    try {
      const ftsTableName = `${tableName}_fts`;
      const limit = options?.limit || 100;
      const offset = options?.offset || 0;

      // Verify FTS table exists
      const tableExists = await this.exists(tableName);

      if (!tableExists) {
        // Check if main table exists
        const mainTableExists = await this.connection.queryValue<number>(
          `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`,
          [tableName]
        );
        
        if (!mainTableExists || mainTableExists === 0) {
          throw new QueryError(
            `Table '${tableName}' does not exist. Please create it first.`,
            { tableName }
          );
        }
        
        throw new QueryError(
          `FTS5 index does not exist for table '${tableName}'. Please create it first using: db.json.fts.createFTSIndex('${tableName}')`,
          { tableName, ftsTableName }
        );
      }

      // Build search query
      // Note: FTS5 uses bm25() for ranking, rank is implicit but we calculate it explicitly
      let sql = `
        SELECT 
          d.id,
          d.doc,
          bm25(${this.escapeIdentifier(ftsTableName)}) as rank
          ${options?.highlight ? `, snippet(${this.escapeIdentifier(ftsTableName)}, 2, '<mark>', '</mark>', '...', 32) as snippet` : ''}
        FROM ${this.escapeIdentifier(ftsTableName)} fts
        JOIN ${this.escapeIdentifier(tableName)} d ON d.id = fts.doc_id
        WHERE ${this.escapeIdentifier(ftsTableName)} MATCH ?
        ORDER BY bm25(${this.escapeIdentifier(ftsTableName)})
        LIMIT ? OFFSET ?
      `;

      const results = await this.connection.query<{
        id: string;
        doc: string;
        rank: number;
        snippet?: string;
      }>(sql, [query, limit, offset]);

      return results.map(row => ({
        doc: JSON.parse(row.doc),
        rank: row.rank,
        snippet: row.snippet,
      }));
    } catch (error) {
      throw new QueryError(
        `FTS5 search failed: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, query, options, error }
      );
    }
  }

  /**
   * Rebuild FTS index
   */
  async rebuild(tableName: string): Promise<void> {
    try {
      const ftsTableName = `${tableName}_fts`;
      
      // Clear existing index
      await this.connection.exec(`DELETE FROM ${this.escapeIdentifier(ftsTableName)}`);
      
      // Repopulate
      await this.populateFTSIndex(tableName, ftsTableName);
      
      defaultLogger.info(`Rebuilt FTS5 index: ${ftsTableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to rebuild FTS5 index: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Drop FTS index
   */
  async drop(tableName: string): Promise<void> {
    try {
      const ftsTableName = `${tableName}_fts`;
      
      // Drop triggers
      await this.connection.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_fts_insert`);
      await this.connection.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_fts_update`);
      await this.connection.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_fts_delete`);
      
      // Drop FTS table
      await this.connection.exec(`DROP TABLE IF EXISTS ${this.escapeIdentifier(ftsTableName)}`);
      
      defaultLogger.info(`Dropped FTS5 index: ${ftsTableName}`);
    } catch (error) {
      throw new QueryError(
        `Failed to drop FTS5 index: ${error instanceof Error ? error.message : String(error)}`,
        { tableName, error }
      );
    }
  }

  /**
   * Create triggers to keep FTS index in sync
   */
  private async createSyncTriggers(tableName: string, _ftsTableName: string): Promise<void> {
    // Drop existing triggers
    await this.connection.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_fts_insert`);
    await this.connection.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_fts_update`);
    await this.connection.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_fts_delete`);

    // Note: SQLite triggers can't easily parse JSON, so we'll use client-side sync
    // This is handled in the JSON table putDoc/deleteDoc methods
  }

  /**
   * Populate FTS index with existing documents
   */
  private async populateFTSIndex(tableName: string, ftsTableName: string): Promise<void> {
    try {
      const documents = await this.connection.query<{ id: string; doc: string }>(
        `SELECT id, doc FROM ${this.escapeIdentifier(tableName)}`
      );

      if (documents.length === 0) {
        defaultLogger.debug('No documents to index in FTS5');
        return;
      }

      // Insert in batch for better performance
      const batchSize = 100;
      defaultLogger.debug(`Populating FTS5 index with ${documents.length} documents in batches of ${batchSize}`);
      
      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        const values = batch.map(() => '(?, ?)').join(', ');
        const sql = `INSERT INTO ${this.escapeIdentifier(ftsTableName)} (doc_id, content) VALUES ${values}`;
        
        const params: unknown[] = [];
        for (const { id, doc } of batch) {
          // Extract text content from JSON for indexing
          const textContent = this.extractTextFromJSON(JSON.parse(doc));
          params.push(id, textContent);
        }
        
        try {
          await this.connection.exec(sql, params);
          defaultLogger.debug(`Inserted batch ${Math.floor(i / batchSize) + 1} (${batch.length} documents) into FTS index`);
        } catch (insertError) {
          defaultLogger.error(`Failed to insert batch into FTS index: ${insertError instanceof Error ? insertError.message : String(insertError)}`);
          throw insertError;
        }
      }

      defaultLogger.debug(`Populated FTS5 index with ${documents.length} documents`);
    } catch (error) {
      defaultLogger.warn('Failed to populate FTS5 index', error);
      throw error;
    }
  }

  /**
   * Extract text content from JSON for indexing
   */
  private extractTextFromJSON(obj: unknown): string {
    if (typeof obj === 'string') {
      return obj;
    }
    
    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return String(obj);
    }
    
    if (obj === null || obj === undefined) {
      return '';
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.extractTextFromJSON(item)).join(' ');
    }
    
    if (typeof obj === 'object') {
      return Object.values(obj)
        .map(value => this.extractTextFromJSON(value))
        .join(' ');
    }
    
    return '';
  }

  /**
   * Sync a document to FTS index
   */
  async syncDocument(tableName: string, docId: string, doc: unknown): Promise<void> {
    // Check if FTS index exists before trying to sync
    const ftsExists = await this.exists(tableName);
    if (!ftsExists) {
      defaultLogger.debug(`FTS index does not exist for ${tableName}, skipping sync`);
      return;
    }

    try {
      const ftsTableName = `${tableName}_fts`;
      const textContent = this.extractTextFromJSON(doc);
      
      // Delete existing entry
      await this.connection.exec(
        `DELETE FROM ${this.escapeIdentifier(ftsTableName)} WHERE doc_id = ?`,
        [docId]
      );
      
      // Insert new entry
      await this.connection.exec(
        `INSERT INTO ${this.escapeIdentifier(ftsTableName)} (doc_id, content) VALUES (?, ?)`,
        [docId, textContent]
      );
    } catch (error) {
      defaultLogger.warn('Failed to sync document to FTS index', error);
    }
  }

  /**
   * Remove document from FTS index
   */
  async removeDocument(tableName: string, docId: string): Promise<void> {
    try {
      const ftsTableName = `${tableName}_fts`;
      await this.connection.exec(
        `DELETE FROM ${this.escapeIdentifier(ftsTableName)} WHERE doc_id = ?`,
        [docId]
      );
    } catch (error) {
      defaultLogger.warn('Failed to remove document from FTS index', error);
    }
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
}

