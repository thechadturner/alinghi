import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, Database, closeAll } from '../../src/index';

// Integration tests require a real browser environment for SQLite WASM
// These tests should be skipped in Node.js/jsdom environment (Vitest default)
// To test: Open examples/basic.html in a browser
const isRealBrowser =
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  typeof fetch !== 'undefined' &&
  // Vitest's jsdom userAgent typically contains "jsdom"
  !(navigator.userAgent || '').toLowerCase().includes('jsdom');

describe.skipIf(!isRealBrowser)('Basic Integration Tests', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect({
      name: 'test-basic',
      storage: 'indexeddb',
      verbose: false,
    });

    // Create test table
    await db.migrate([
      {
        version: 1,
        description: 'Create test table',
        up: async (sql) => {
          await sql.exec(`
            CREATE TABLE users (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              email TEXT UNIQUE,
              age INTEGER,
              created_at INTEGER NOT NULL
            )
          `);
          await sql.exec(`CREATE INDEX idx_users_email ON users(email)`);
        },
        down: async (sql) => {
          await sql.exec(`DROP TABLE users`);
        },
      },
    ]);
  });

  afterAll(async () => {
    await closeAll();
  });

  describe('INSERT operations', () => {
    it('should insert a record', async () => {
      await db.exec(
        `INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)`,
        ['u1', 'John Doe', 'john@example.com', 30, Date.now()]
      );

      const user = await db.queryOne<{ name: string }>(
        `SELECT name FROM users WHERE id = ?`,
        ['u1']
      );

      expect(user).not.toBeNull();
      expect(user?.name).toBe('John Doe');
    });

    it('should insert multiple records', async () => {
      await db.exec(
        `INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)`,
        ['u2', 'Jane Smith', 'jane@example.com', 25, Date.now()]
      );

      await db.exec(
        `INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)`,
        ['u3', 'Bob Johnson', 'bob@example.com', 35, Date.now()]
      );

      const count = await db.queryValue<number>(`SELECT COUNT(*) FROM users`);
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });

  describe('SELECT operations', () => {
    it('should query all records', async () => {
      const users = await db.query(`SELECT * FROM users`);
      expect(users.length).toBeGreaterThan(0);
    });

    it('should query with WHERE clause', async () => {
      const users = await db.query(`SELECT * FROM users WHERE age > ?`, [25]);
      expect(users.length).toBeGreaterThan(0);
      users.forEach((user: any) => {
        expect(user.age).toBeGreaterThan(25);
      });
    });

    it('should query single record', async () => {
      const user = await db.queryOne(`SELECT * FROM users WHERE id = ?`, ['u1']);
      expect(user).not.toBeNull();
    });

    it('should return null for non-existent record', async () => {
      const user = await db.queryOne(`SELECT * FROM users WHERE id = ?`, ['nonexistent']);
      expect(user).toBeNull();
    });

    it('should query single value', async () => {
      const count = await db.queryValue<number>(`SELECT COUNT(*) FROM users`);
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('UPDATE operations', () => {
    it('should update a record', async () => {
      await db.exec(`UPDATE users SET age = ? WHERE id = ?`, [31, 'u1']);

      const user = await db.queryOne<{ age: number }>(
        `SELECT age FROM users WHERE id = ?`,
        ['u1']
      );

      expect(user?.age).toBe(31);
    });
  });

  describe('DELETE operations', () => {
    it('should delete a record', async () => {
      await db.exec(`DELETE FROM users WHERE id = ?`, ['u3']);

      const user = await db.queryOne(`SELECT * FROM users WHERE id = ?`, ['u3']);
      expect(user).toBeNull();
    });
  });

  describe('Transactions', () => {
    it('should commit transaction', async () => {
      await db.transaction(async (tx) => {
        await tx.exec(
          `INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)`,
          ['tx1', 'TX User', 'tx@example.com', 40, Date.now()]
        );
      });

      const user = await db.queryOne(`SELECT * FROM users WHERE id = ?`, ['tx1']);
      expect(user).not.toBeNull();
    });

    it('should rollback transaction on error', async () => {
      await expect(async () => {
        await db.transaction(async (tx) => {
          await tx.exec(
            `INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)`,
            ['tx2', 'TX User 2', 'tx2@example.com', 45, Date.now()]
          );
          // This should fail (duplicate email)
          await tx.exec(
            `INSERT INTO users (id, name, email, age, created_at) VALUES (?, ?, ?, ?, ?)`,
            ['tx3', 'TX User 3', 'tx2@example.com', 50, Date.now()]
          );
        });
      }).rejects.toThrow();

      // tx2 should not exist due to rollback
      const user = await db.queryOne(`SELECT * FROM users WHERE id = ?`, ['tx2']);
      expect(user).toBeNull();
    });
  });

  describe('Database info', () => {
    it('should get storage info', async () => {
      const info = await db.getStorageInfo();
      expect(['indexeddb', 'memory']).toContain(info.type);
      expect(info.available).toBe(true);
    });

    it('should get database name', () => {
      expect(db.getName()).toBe('test-basic');
    });

    it('should get storage type', () => {
      expect(['indexeddb', 'memory']).toContain(db.getStorageType());
    });

    it('should check connection status', () => {
      expect(db.isConnected()).toBe(true);
    });
  });
});

