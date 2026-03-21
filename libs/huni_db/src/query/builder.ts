/**
 * Query builder helpers for common SQL operations
 */

/**
 * Build a SELECT query
 */
export function buildSelect(options: {
  table: string;
  columns?: string[];
  where?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
  offset?: number;
}): { sql: string; params: unknown[] } {
  const { table, columns, where, orderBy, limit, offset } = options;

  let sql = `SELECT ${columns ? columns.join(', ') : '*'} FROM "${table}"`;
  const params: unknown[] = [];

  if (where && Object.keys(where).length > 0) {
    const conditions = Object.keys(where).map(key => `"${key}" = ?`);
    sql += ` WHERE ${conditions.join(' AND ')}`;
    params.push(...Object.values(where));
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  if (offset !== undefined) {
    sql += ` OFFSET ?`;
    params.push(offset);
  }

  return { sql, params };
}

/**
 * Build an INSERT query
 */
export function buildInsert(
  table: string,
  data: Record<string, unknown>
): { sql: string; params: unknown[] } {
  const columns = Object.keys(data);
  const placeholders = columns.map(() => '?').join(', ');
  const columnNames = columns.map(c => `"${c}"`).join(', ');

  const sql = `INSERT INTO "${table}" (${columnNames}) VALUES (${placeholders})`;
  const params = Object.values(data);

  return { sql, params };
}

/**
 * Build an UPDATE query
 */
export function buildUpdate(
  table: string,
  data: Record<string, unknown>,
  where: Record<string, unknown>
): { sql: string; params: unknown[] } {
  const setColumns = Object.keys(data).map(key => `"${key}" = ?`);
  const whereConditions = Object.keys(where).map(key => `"${key}" = ?`);

  const sql = `UPDATE "${table}" SET ${setColumns.join(', ')} WHERE ${whereConditions.join(' AND ')}`;
  const params = [...Object.values(data), ...Object.values(where)];

  return { sql, params };
}

/**
 * Build a DELETE query
 */
export function buildDelete(
  table: string,
  where: Record<string, unknown>
): { sql: string; params: unknown[] } {
  const conditions = Object.keys(where).map(key => `"${key}" = ?`);
  const sql = `DELETE FROM "${table}" WHERE ${conditions.join(' AND ')}`;
  const params = Object.values(where);

  return { sql, params };
}

/**
 * Build a COUNT query
 */
export function buildCount(
  table: string,
  where?: Record<string, unknown>
): { sql: string; params: unknown[] } {
  let sql = `SELECT COUNT(*) as count FROM "${table}"`;
  const params: unknown[] = [];

  if (where && Object.keys(where).length > 0) {
    const conditions = Object.keys(where).map(key => `"${key}" = ?`);
    sql += ` WHERE ${conditions.join(' AND ')}`;
    params.push(...Object.values(where));
  }

  return { sql, params };
}

/**
 * Escape SQL identifier (table or column name)
 */
export function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Format value for SQL (with proper escaping)
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Date) {
    return String(value.getTime());
  }

  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }

  return String(value);
}

/**
 * Build a parameterized IN clause
 */
export function buildInClause(
  column: string,
  values: unknown[]
): { sql: string; params: unknown[] } {
  const placeholders = values.map(() => '?').join(', ');
  const sql = `"${column}" IN (${placeholders})`;
  return { sql, params: values };
}

/**
 * Build a BETWEEN clause
 */
export function buildBetweenClause(
  column: string,
  min: unknown,
  max: unknown
): { sql: string; params: unknown[] } {
  const sql = `"${column}" BETWEEN ? AND ?`;
  return { sql, params: [min, max] };
}

/**
 * Combine multiple WHERE conditions with AND
 */
export function combineConditions(conditions: string[]): string {
  return conditions.filter(c => c.trim()).join(' AND ');
}

/**
 * Build a pagination query
 */
export function buildPagination(options: {
  page: number;
  pageSize: number;
}): { limit: number; offset: number } {
  const { page, pageSize } = options;
  return {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
}

