# HuniDB

> High-performance SQL-powered client-side database using SQLite/WASM with IndexedDB storage

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)

## 🚀 Features

- **🗄️ SQLite/WASM**: Full-featured SQL database running in the browser
- **💾 IndexedDB Storage**: Persistent, reliable storage that works in the main thread
- **📘 TypeScript**: Comprehensive type definitions and type-safe queries
- **🔄 Migrations**: Versioned schema migrations with up/down support
- **🔐 Transactions**: ACID-compliant transactions with automatic rollback
- **⚡ Performance**: Prepared statement caching and query optimization
- **🔍 JSON Support**: Built-in JSON1 extension for JSON operations
- **📦 Lightweight**: Tree-shakable, optimized bundle size
- **🌐 Universal**: Works in all modern browsers with automatic fallback

## 📦 Installation

```bash
npm install @hunico/hunidb
```

## 🎯 Quick Start

```typescript
import { connect } from '@hunico/hunidb';

// Connect to database
const db = await connect({
  name: 'my-app-db',
  storage: 'indexeddb', // Use IndexedDB for reliable, persistent storage
  verbose: true,   // enable logging
});

// Run migrations
await db.migrate([
  {
    version: 1,
    description: 'Create users table',
    up: async (sql) => {
      await sql.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          created_at INTEGER
        );
        CREATE INDEX idx_users_created ON users(created_at);
      `);
    },
    down: async (sql) => {
      await sql.exec(`DROP TABLE users;`);
    }
  }
]);

// Insert data
await db.exec(
  `INSERT INTO users(id, name, email, created_at) VALUES (?, ?, ?, ?)`,
  ['u1', 'John Doe', 'john@example.com', Date.now()]
);

// Query data
const users = await db.query<{ id: string; name: string }>(
  `SELECT id, name FROM users WHERE created_at > ?`,
  [Date.now() - 86400000]
);

console.log(users);
```

## 📚 API Reference

### Connection

#### `connect(options: ConnectOptions): Promise<Database>`

Connect to a database.

**Options:**
```typescript
{
  name: string;              // Database name
  storage?: 'indexeddb' | 'memory'; // Default: 'indexeddb' (recommended)
  cache?: {
    statementLimit?: number; // Max cached prepared statements (default: 200)
  };
  verbose?: boolean;         // Enable debug logging (default: false)
}
```

**Example:**
```typescript
const db = await connect({
  name: 'mydb',
  storage: 'indexeddb',
  cache: { statementLimit: 500 },
  verbose: true,
});
```

### Database Class

#### `query<T>(sql: string, params?: any[]): Promise<T[]>`

Execute a SELECT query and return all rows.

```typescript
const users = await db.query<User>('SELECT * FROM users WHERE age > ?', [18]);
```

#### `queryOne<T>(sql: string, params?: any[]): Promise<T | null>`

Execute a SELECT query and return the first row or null.

```typescript
const user = await db.queryOne<User>('SELECT * FROM users WHERE id = ?', ['u1']);
```

#### `queryValue<T>(sql: string, params?: any[]): Promise<T | null>`

Execute a SELECT query and return a single value.

```typescript
const count = await db.queryValue<number>('SELECT COUNT(*) FROM users');
```

#### `exec(sql: string, params?: any[]): Promise<void>`

Execute a command (INSERT, UPDATE, DELETE, CREATE, etc.).

```typescript
await db.exec('INSERT INTO users(id, name) VALUES (?, ?)', ['u1', 'John']);
await db.exec('UPDATE users SET name = ? WHERE id = ?', ['Jane', 'u1']);
await db.exec('DELETE FROM users WHERE id = ?', ['u1']);
```

#### `transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>`

Execute a function within a transaction. Automatically rolls back on error.

```typescript
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO users(id, name) VALUES (?, ?)', ['u1', 'John']);
  await tx.exec('INSERT INTO posts(user_id, title) VALUES (?, ?)', ['u1', 'Hello']);
  // Automatically committed if no error, rolled back on error
});
```

#### `migrate(migrations: Migration[]): Promise<void>`

Run database migrations.

```typescript
await db.migrate([
  {
    version: 1,
    description: 'Initial schema',
    up: async (sql) => {
      await sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    },
    down: async (sql) => {
      await sql.exec('DROP TABLE users');
    }
  },
  {
    version: 2,
    description: 'Add email column',
    up: async (sql) => {
      await sql.exec('ALTER TABLE users ADD COLUMN email TEXT');
    },
    down: async (sql) => {
      await sql.exec('ALTER TABLE users DROP COLUMN email');
    }
  }
]);
```

#### `getMigrationVersion(): Promise<number>`

Get the current migration version.

```typescript
const version = await db.getMigrationVersion(); // 2
```

#### `getStorageInfo(): Promise<StorageInfo>`

Get storage information.

```typescript
const info = await db.getStorageInfo();
console.log(info.type);     // 'indexeddb'
console.log(info.usage);    // Bytes used
console.log(info.quota);    // Total quota
```

#### `getCacheStats(): CacheStats`

Get prepared statement cache statistics.

```typescript
const stats = db.getCacheStats();
console.log(stats.size);       // Current cache size
console.log(stats.hitRate);    // Cache hit rate (0-1)
```

#### `getMetrics(): PerformanceMetrics`

Get performance metrics.

```typescript
const metrics = db.getMetrics();
console.log(metrics.queryCount);           // Total queries
console.log(metrics.averageQueryTime);     // Avg query time (ms)
console.log(metrics.transactionCount);     // Total transactions
console.log(metrics.cacheHitRate);         // Cache hit rate
```

#### `close(): Promise<void>`

Close the database connection.

```typescript
await db.close();
```

### Schema Definition

HuniDB provides a type-safe schema DSL for defining tables:

```typescript
import { defineTable, index } from '@hunico/hunidb';

const usersTable = defineTable('users', {
  id: {
    type: 'TEXT',
    primaryKey: true,
  },
  name: {
    type: 'TEXT',
    notNull: true,
  },
  email: {
    type: 'TEXT',
    unique: true,
  },
  age: {
    type: 'INTEGER',
  },
  created_at: {
    type: 'INTEGER',
    notNull: true,
    default: Date.now(),
  },
}, {
  indexes: [
    index('idx_users_email', ['email']),
    index('idx_users_created', ['created_at']),
  ],
});

// Generate SQL
import { generateCreateTableSQL, generateCreateIndexSQL } from '@hunico/hunidb';

const createTableSQL = generateCreateTableSQL(usersTable);
const indexSQL = usersTable.options?.indexes?.map(idx => 
  generateCreateIndexSQL('users', idx)
);
```

### Query Builder

Helper functions for building common queries:

```typescript
import { buildSelect, buildInsert, buildUpdate, buildDelete } from '@hunico/hunidb';

// SELECT
const { sql, params } = buildSelect({
  table: 'users',
  columns: ['id', 'name'],
  where: { active: 1 },
  orderBy: 'created_at DESC',
  limit: 10,
});

// INSERT
const { sql, params } = buildInsert('users', {
  id: 'u1',
  name: 'John',
  email: 'john@example.com',
});

// UPDATE
const { sql, params } = buildUpdate(
  'users',
  { name: 'Jane' },      // data
  { id: 'u1' }           // where
);

// DELETE
const { sql, params } = buildDelete('users', { id: 'u1' });
```

## 🏗️ Advanced Usage

### Custom Logging

```typescript
import { connect, createLogger, LogLevel } from '@hunico/hunidb';

const logger = createLogger({
  level: LogLevel.DEBUG,
  prefix: '[MyApp]',
  timestamps: true,
});

const db = await connect({
  name: 'mydb',
  verbose: true,
});

// Access performance metrics
const metrics = db.getMetrics();
console.log(`Executed ${metrics.queryCount} queries`);
console.log(`Average query time: ${metrics.averageQueryTime.toFixed(2)}ms`);
```

### Storage Detection

```typescript
import { detectStorageCapabilities, getBrowserInfo } from '@hunico/hunidb';

const capabilities = await detectStorageCapabilities();
console.log('IndexedDB available:', capabilities.indexedDB);

const browser = getBrowserInfo();
console.log(`${browser.name} ${browser.version}`);
```

### Error Handling

```typescript
import { connect, QueryError, TransactionError } from '@hunico/hunidb';

try {
  await db.exec('INVALID SQL');
} catch (error) {
  if (error instanceof QueryError) {
    console.error('Query failed:', error.message);
    console.error('Context:', error.context);
  }
}
```

## 🌐 Browser Support

| Browser | Version | Storage | Notes |
|---------|---------|---------|-------|
| Chrome  | Latest  | IndexedDB | Full support |
| Edge    | Latest  | IndexedDB | Full support |
| Safari  | Latest  | IndexedDB | Full support |
| Firefox | Latest  | IndexedDB | Full support |

## 🎨 Examples

Check out the `examples/` directory for complete examples:

- **basic.html**: Interactive demo of all features
- **schema.ts**: Schema definition examples

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm run test:unit
npm run test:integration

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## 🏗️ Building

```bash
# Build library
npm run build

# Build with type checking
npm run typecheck

# Build types only
npm run build:types
```

## 📝 Development Roadmap

### Phase 0 (Current) - Foundations ✅
- ✅ SQLite/WASM integration
- ✅ IndexedDB storage support
- ✅ Core API (query, exec, transaction)
- ✅ Migration system
- ✅ Prepared statement caching
- ✅ TypeScript support
- ✅ Comprehensive tests

### Phase 1 - MVP (Next)
- 🔄 JSON table API with indexing
- 🔄 Hybrid queries (JOIN SQL + JSON)
- 🔄 Enhanced query builder
- 🔄 Performance optimizations

### Phase 2 - Performance
- ⏳ Write batching
- ⏳ Hot KV cache layer
- ⏳ Full-text search (FTS5)
- ⏳ Advanced indexing strategies

### Phase 3 - Sync Service
- ⏳ Delta synchronization
- ⏳ Conflict resolution
- ⏳ Multi-device sync
- ⏳ Offline-first architecture

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## 📄 License

MIT © Chad Turner

## 🙏 Acknowledgments

- Built on [SQLite](https://www.sqlite.org/)
- Uses [@sqlite.org/sqlite-wasm](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)
- Inspired by modern local-first architectures

## 📞 Support

- 📧 Email: thechadturner@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/hunico/hunidb/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/hunico/hunidb/discussions)

---

Made with ❤️ for the local-first web

