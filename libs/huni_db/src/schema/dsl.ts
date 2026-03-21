import type { TableColumns, TableOptions, TableSchema, IndexDefinition, ColumnDefinition } from './types.js';
import { SchemaError } from '../utils/errors.js';

/**
 * Define a table schema
 */
export function defineTable(
  name: string,
  columns: TableColumns,
  options?: TableOptions
): TableSchema {
  validateTableName(name);
  validateColumns(columns);
  
  if (options?.indexes) {
    validateIndexes(options.indexes, columns);
  }

  return {
    name,
    columns,
    options,
  };
}

/**
 * Define a column
 */
export function column(definition: ColumnDefinition): ColumnDefinition {
  return definition;
}

/**
 * Define an index
 */
export function index(name: string, columns: string[], options?: { unique?: boolean; where?: string }): IndexDefinition {
  if (!name || typeof name !== 'string') {
    throw new SchemaError('Index name must be a non-empty string');
  }

  if (!Array.isArray(columns) || columns.length === 0) {
    throw new SchemaError('Index must have at least one column');
  }

  return {
    name,
    columns,
    ...options,
  };
}

/**
 * Generate SQL DDL for creating a table
 */
export function generateCreateTableSQL(schema: TableSchema): string {
  const columnDefs: string[] = [];
  const tableName = escapeIdentifier(schema.name);

  // Generate column definitions
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    const parts: string[] = [escapeIdentifier(colName), colDef.type];

    if (colDef.primaryKey) {
      parts.push('PRIMARY KEY');
      if (colDef.autoIncrement) {
        parts.push('AUTOINCREMENT');
      }
    }

    if (colDef.notNull && !colDef.primaryKey) {
      parts.push('NOT NULL');
    }

    if (colDef.unique && !colDef.primaryKey) {
      parts.push('UNIQUE');
    }

    if (colDef.default !== undefined) {
      parts.push(`DEFAULT ${formatValue(colDef.default)}`);
    }

    if (colDef.check) {
      parts.push(`CHECK (${colDef.check})`);
    }

    if (colDef.references) {
      const [refTable, refColumn] = colDef.references.split('.');
      if (refTable && refColumn) {
        parts.push(`REFERENCES ${escapeIdentifier(refTable)}(${escapeIdentifier(refColumn)})`);
      }
      
      if (colDef.onDelete) {
        parts.push(`ON DELETE ${colDef.onDelete}`);
      }
      
      if (colDef.onUpdate) {
        parts.push(`ON UPDATE ${colDef.onUpdate}`);
      }
    }

    columnDefs.push(parts.join(' '));
  }

  let sql = `CREATE TABLE ${tableName} (\n  ${columnDefs.join(',\n  ')}\n)`;

  if (schema.options?.withoutRowId) {
    sql += ' WITHOUT ROWID';
  }

  if (schema.options?.strict) {
    sql += ' STRICT';
  }

  return sql;
}

/**
 * Generate SQL DDL for creating indexes
 */
export function generateCreateIndexSQL(tableName: string, indexDef: IndexDefinition): string {
  const indexName = escapeIdentifier(indexDef.name);
  const table = escapeIdentifier(tableName);
  const columns = indexDef.columns.map(c => escapeIdentifier(c)).join(', ');
  
  let sql = `CREATE ${indexDef.unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${table}(${columns})`;
  
  if (indexDef.where) {
    sql += ` WHERE ${indexDef.where}`;
  }
  
  return sql;
}

/**
 * Generate SQL DDL for dropping a table
 */
export function generateDropTableSQL(tableName: string): string {
  return `DROP TABLE IF EXISTS ${escapeIdentifier(tableName)}`;
}

/**
 * Generate SQL DDL for dropping an index
 */
export function generateDropIndexSQL(indexName: string): string {
  return `DROP INDEX IF EXISTS ${escapeIdentifier(indexName)}`;
}

/**
 * Validate table name
 */
function validateTableName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new SchemaError('Table name must be a non-empty string');
  }

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new SchemaError(`Invalid table name: ${name}. Must start with letter or underscore and contain only alphanumeric characters and underscores`);
  }

  // Check for SQL reserved words
  const reserved = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'TABLE', 'INDEX'];
  if (reserved.includes(name.toUpperCase())) {
    throw new SchemaError(`Table name cannot be a SQL reserved word: ${name}`);
  }
}

/**
 * Validate columns
 */
function validateColumns(columns: TableColumns): void {
  const columnNames = Object.keys(columns);
  
  if (columnNames.length === 0) {
    throw new SchemaError('Table must have at least one column');
  }

  let hasPrimaryKey = false;

  for (const [colName, colDef] of Object.entries(columns)) {
    // Validate column name
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)) {
      throw new SchemaError(`Invalid column name: ${colName}`);
    }

    // Validate data type
    const validTypes = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NULL', 'JSON'];
    if (!validTypes.includes(colDef.type)) {
      throw new SchemaError(`Invalid data type for column ${colName}: ${colDef.type}`);
    }

    // Check primary key
    if (colDef.primaryKey) {
      if (hasPrimaryKey) {
        throw new SchemaError('Table can only have one primary key column (composite keys not yet supported)');
      }
      hasPrimaryKey = true;

      // Auto-increment only for INTEGER primary keys
      if (colDef.autoIncrement && colDef.type !== 'INTEGER') {
        throw new SchemaError(`AUTOINCREMENT can only be used with INTEGER PRIMARY KEY on column ${colName}`);
      }
    }

    // Validate foreign key reference format
    if (colDef.references && !/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(colDef.references)) {
      throw new SchemaError(`Invalid foreign key reference format for column ${colName}: ${colDef.references}. Expected format: table.column`);
    }
  }
}

/**
 * Validate indexes
 */
function validateIndexes(indexes: IndexDefinition[], columns: TableColumns): void {
  const indexNames = new Set<string>();
  const columnNames = Object.keys(columns);

  for (const indexDef of indexes) {
    // Check duplicate index names
    if (indexNames.has(indexDef.name)) {
      throw new SchemaError(`Duplicate index name: ${indexDef.name}`);
    }
    indexNames.add(indexDef.name);

    // Validate index name
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(indexDef.name)) {
      throw new SchemaError(`Invalid index name: ${indexDef.name}`);
    }

    // Validate columns exist
    for (const col of indexDef.columns) {
      if (!columnNames.includes(col)) {
        throw new SchemaError(`Index ${indexDef.name} references non-existent column: ${col}`);
      }
    }
  }
}

/**
 * Escape SQL identifier
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Format value for SQL
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }

  return String(value);
}

