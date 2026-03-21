/**
 * JSON Query Builder
 * 
 * Converts JSON filters to SQL queries using index tables
 */

import type { JSONFilter } from './types.js';

export interface QueryResult {
  sql: string;
  params: unknown[];
}

/**
 * JSON Query Builder
 */
export class JSONQueryBuilder {
  /**
   * Build a FIND query from a filter
   */
  buildFindQuery(tableName: string, filter: JSONFilter): QueryResult {
    const params: unknown[] = [];
    let sql = `SELECT doc FROM ${this.escapeIdentifier(tableName)}`;

    // Build WHERE clause
    const whereClause = this.buildWhereClause(tableName, filter, params);
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }

    // Add ORDER BY
    if (filter.sortAsc || filter.sortDesc) {
      sql += this.buildOrderBy(filter);
    }

    // Add LIMIT and OFFSET
    if (filter.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }

    if (filter.offset !== undefined) {
      sql += ` OFFSET ?`;
      params.push(filter.offset);
    }

    return { sql, params };
  }

  /**
   * Build a COUNT query from a filter
   */
  buildCountQuery(tableName: string, filter: JSONFilter): QueryResult {
    const params: unknown[] = [];
    let sql = `SELECT COUNT(*) FROM ${this.escapeIdentifier(tableName)}`;

    // Build WHERE clause
    const whereClause = this.buildWhereClause(tableName, filter, params);
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }

    return { sql, params };
  }

  /**
   * Build WHERE clause from filter
   */
  private buildWhereClause(tableName: string, filter: JSONFilter, params: unknown[]): string {
    const conditions: string[] = [];

    // Handle logical operators first
    if (filter.and && filter.and.length > 0) {
      const andConditions = filter.and
        .map(f => this.buildWhereClause(tableName, f, params))
        .filter(c => c);
      if (andConditions.length > 0) {
        conditions.push(`(${andConditions.join(' AND ')})`);
      }
    }

    if (filter.or && filter.or.length > 0) {
      const orConditions = filter.or
        .map(f => this.buildWhereClause(tableName, f, params))
        .filter(c => c);
      if (orConditions.length > 0) {
        conditions.push(`(${orConditions.join(' OR ')})`);
      }
    }

    if (filter.not) {
      const notCondition = this.buildWhereClause(tableName, filter.not, params);
      if (notCondition) {
        conditions.push(`NOT (${notCondition})`);
      }
    }

    // Handle key existence
    if (filter.hasKey) {
      const keys = Array.isArray(filter.hasKey) ? filter.hasKey : [filter.hasKey];
      const keyConditions = keys.map(() => {
        return `EXISTS (
          SELECT 1 FROM ${this.getKeysTableName(tableName)} 
          WHERE table_name = ? AND key_path = ? AND doc_id = ${this.escapeIdentifier(tableName)}.id
        )`;
      });
      params.push(...keys.map(() => tableName), ...keys.map(k => this.normalizeKeyPath(k)));
      conditions.push(`(${keyConditions.join(' OR ')})`);
    }

    // Handle equality
    if (filter.eq) {
      for (const [key, value] of Object.entries(filter.eq)) {
        conditions.push(this.buildValueCondition(tableName, key, '=', value, params));
      }
    }

    // Handle inequality
    if (filter.ne) {
      for (const [key, value] of Object.entries(filter.ne)) {
        conditions.push(this.buildValueCondition(tableName, key, '!=', value, params));
      }
    }

    // Handle comparison operators
    if (filter.gt) {
      for (const [key, value] of Object.entries(filter.gt)) {
        conditions.push(this.buildValueCondition(tableName, key, '>', value, params));
      }
    }

    if (filter.gte) {
      for (const [key, value] of Object.entries(filter.gte)) {
        conditions.push(this.buildValueCondition(tableName, key, '>=', value, params));
      }
    }

    if (filter.lt) {
      for (const [key, value] of Object.entries(filter.lt)) {
        conditions.push(this.buildValueCondition(tableName, key, '<', value, params));
      }
    }

    if (filter.lte) {
      for (const [key, value] of Object.entries(filter.lte)) {
        conditions.push(this.buildValueCondition(tableName, key, '<=', value, params));
      }
    }

    // Handle IN
    if (filter.in) {
      for (const [key, values] of Object.entries(filter.in)) {
        if (values.length > 0) {
          const keyPath = this.normalizeKeyPath(key);
          const valueHashes = values.map(v => this.hashValue(v));
          const placeholders = valueHashes.map(() => '?').join(', ');
          params.push(tableName, keyPath, ...valueHashes);
          conditions.push(`EXISTS (
            SELECT 1 FROM ${this.getValuesTableName(tableName)}
            WHERE table_name = ? AND key_path = ? AND value_hash IN (${placeholders}) AND doc_id = ${this.escapeIdentifier(tableName)}.id
          )`);
        }
      }
    }

    // Handle LIKE
    if (filter.like) {
      for (const [key, pattern] of Object.entries(filter.like)) {
        const keyPath = this.normalizeKeyPath(key);
        params.push(tableName, keyPath, pattern);
        conditions.push(`EXISTS (
          SELECT 1 FROM ${this.getValuesTableName(tableName)}
          WHERE table_name = ? AND key_path = ? AND value_text LIKE ? AND doc_id = ${this.escapeIdentifier(tableName)}.id
        )`);
      }
    }

    // Handle MATCH (full-text search)
    if (filter.match) {
      for (const [, query] of Object.entries(filter.match)) {
        // Use JSON1 function for full-text search
        params.push(query);
        conditions.push(`json_extract(${this.escapeIdentifier(tableName)}.doc, ?) MATCH ?`);
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
  }

  /**
   * Build a value condition using index tables
   */
  private buildValueCondition(
    tableName: string,
    key: string,
    operator: string,
    value: unknown,
    params: unknown[]
  ): string {
    const keyPath = this.normalizeKeyPath(key);
    const valueHash = this.hashValue(value);

    // For exact matches, use hash lookup
    if (operator === '=' || operator === '!=') {
      const not = operator === '!=' ? 'NOT ' : '';
      params.push(tableName, keyPath, valueHash);
      return `${not}EXISTS (
        SELECT 1 FROM ${this.getValuesTableName(tableName)}
        WHERE table_name = ? AND key_path = ? AND value_hash = ? AND doc_id = ${this.escapeIdentifier(tableName)}.id
      )`;
    }

    // For comparisons, use JSON1 functions
    const jsonPath = `$.${keyPath}`;
    params.push(jsonPath, value);
    return `json_extract(${this.escapeIdentifier(tableName)}.doc, ?) ${operator} ?`;
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderBy(filter: JSONFilter): string {
    const orders: string[] = [];

    if (filter.sortAsc) {
      const keys = Array.isArray(filter.sortAsc) ? filter.sortAsc : [filter.sortAsc];
      for (const key of keys) {
        const keyPath = this.normalizeKeyPath(key);
        orders.push(`json_extract(doc, '$.${keyPath}') ASC`);
      }
    }

    if (filter.sortDesc) {
      const keys = Array.isArray(filter.sortDesc) ? filter.sortDesc : [filter.sortDesc];
      for (const key of keys) {
        const keyPath = this.normalizeKeyPath(key);
        orders.push(`json_extract(doc, '$.${keyPath}') DESC`);
      }
    }

    return orders.length > 0 ? ` ORDER BY ${orders.join(', ')}` : '';
  }

  /**
   * Normalize key path (convert dot notation to JSON path)
   */
  private normalizeKeyPath(key: string): string {
    // Convert dot notation to JSON path format
    return key.replace(/\./g, '.');
  }

  /**
   * Hash a value (simple implementation)
   */
  private hashValue(value: unknown): string {
    const str = JSON.stringify(value);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
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

