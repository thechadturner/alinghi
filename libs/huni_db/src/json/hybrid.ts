/**
 * Hybrid Query Support
 * 
 * Enables JOINs between JSON tables and SQL tables
 */

import type { Connection } from '../core/connection.js';
import type { JSONFilter } from './types.js';
import { JSONQueryBuilder } from './query-builder.js';
import { QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * Hybrid Query Builder
 * 
 * Creates temporary views from JSON queries to enable JOINs with SQL tables
 */
export class HybridQueryBuilder {
  private connection: Connection;
  private queryBuilder: JSONQueryBuilder;

  constructor(connection: Connection) {
    this.connection = connection;
    this.queryBuilder = new JSONQueryBuilder();
  }

  /**
   * Create a temporary view from a JSON table query
   * 
   * @param viewName Name for the temporary view
   * @param jsonTable JSON table name
   * @param filter Optional filter for JSON documents
   * @param columns Columns to extract from JSON (default: all)
   * @returns View name that can be used in JOINs
   */
  async createViewFromJSON(
    viewName: string,
    jsonTable: string,
    filter?: JSONFilter,
    columns?: string[]
  ): Promise<string> {
    try {
      // Build base query
      const query = this.queryBuilder.buildFindQuery(jsonTable, filter || {});

      // Extract columns from JSON
      const selectColumns = columns && columns.length > 0
        ? columns.map(col => {
            const jsonPath = this.normalizeKeyPath(col);
            return `json_extract(doc, '$.${jsonPath}') AS ${this.escapeIdentifier(col)}`;
          }).join(', ')
        : `doc AS doc, id AS id, ts AS ts`;

      // Create temporary view
      const viewSQL = `
        CREATE TEMPORARY VIEW ${this.escapeIdentifier(viewName)} AS
        SELECT ${selectColumns}, id AS json_id, ts AS json_ts
        FROM (${query.sql})
      `;

      await this.connection.exec(viewSQL, query.params);

      defaultLogger.debug(`Created temporary view: ${viewName} from JSON table: ${jsonTable}`);
      return viewName;
    } catch (error) {
      throw new QueryError(
        `Failed to create view from JSON: ${error instanceof Error ? error.message : String(error)}`,
        { viewName, jsonTable, filter, columns, error }
      );
    }
  }

  /**
   * Execute a hybrid query (JOIN JSON table with SQL table)
   * 
   * @param sqlTable SQL table name
   * @param jsonTable JSON table name
   * @param joinCondition JOIN condition (e.g., "sql_table.id = json_table.userId")
   * @param jsonFilter Optional filter for JSON documents
   * @param selectColumns Columns to select from both tables
   * @param whereClause Optional WHERE clause for SQL table
   * @returns Query result
   */
  async joinJSONWithSQL<T = unknown>(options: {
    sqlTable: string;
    jsonTable: string;
    joinCondition: string;
    jsonFilter?: JSONFilter;
    selectColumns?: string[];
    whereClause?: string;
    orderBy?: string;
    limit?: number;
  }): Promise<T[]> {
    const {
      sqlTable,
      jsonTable,
      joinCondition,
      jsonFilter,
      selectColumns,
      whereClause,
      orderBy,
      limit,
    } = options;

    try {
      // Create temporary view from JSON
      const viewName = `json_view_${Date.now()}`;
      await this.createViewFromJSON(viewName, jsonTable, jsonFilter, selectColumns);

      // Build SELECT columns
      const columns = selectColumns && selectColumns.length > 0
        ? selectColumns.map(col => `${this.escapeIdentifier(sqlTable)}.${this.escapeIdentifier(col)}, ${this.escapeIdentifier(viewName)}.${this.escapeIdentifier(col)} AS json_${col}`).join(', ')
        : `${this.escapeIdentifier(sqlTable)}.*, ${this.escapeIdentifier(viewName)}.doc AS json_doc, ${this.escapeIdentifier(viewName)}.json_id, ${this.escapeIdentifier(viewName)}.json_ts`;

      // Build JOIN query
      let sql = `
        SELECT ${columns}
        FROM ${this.escapeIdentifier(sqlTable)}
        INNER JOIN ${this.escapeIdentifier(viewName)} ON ${joinCondition}
      `;

      if (whereClause) {
        sql += ` WHERE ${whereClause}`;
      }

      if (orderBy) {
        sql += ` ORDER BY ${orderBy}`;
      }

      if (limit) {
        sql += ` LIMIT ${limit}`;
      }

      const results = await this.connection.query<T>(sql);

      // Clean up temporary view
      await this.connection.exec(`DROP VIEW IF EXISTS ${this.escapeIdentifier(viewName)}`);

      return results;
    } catch (error) {
      throw new QueryError(
        `Failed to execute hybrid query: ${error instanceof Error ? error.message : String(error)}`,
        { options, error }
      );
    }
  }

  /**
   * Execute a hybrid query with JSON documents filtered by SQL table
   * 
   * This is the reverse: start with SQL table, filter JSON documents
   */
  async joinSQLWithJSON<T = unknown>(options: {
    sqlTable: string;
    jsonTable: string;
    joinCondition: string;
    sqlWhere?: string;
    jsonFilter?: JSONFilter;
    selectColumns?: string[];
    orderBy?: string;
    limit?: number;
  }): Promise<T[]> {
    // Similar to joinJSONWithSQL but optimized for SQL-first queries
    return this.joinJSONWithSQL<T>({
      sqlTable: options.sqlTable,
      jsonTable: options.jsonTable,
      joinCondition: options.joinCondition,
      jsonFilter: options.jsonFilter,
      selectColumns: options.selectColumns,
      whereClause: options.sqlWhere,
      orderBy: options.orderBy,
      limit: options.limit,
    });
  }

  /**
   * Normalize key path for JSON extraction
   */
  private normalizeKeyPath(key: string): string {
    return key.replace(/\./g, '.');
  }

  /**
   * Escape SQL identifier
   */
  private escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
}

