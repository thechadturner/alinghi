import { describe, it, expect } from 'vitest';
import {
  defineTable,
  index,
  generateCreateTableSQL,
  generateCreateIndexSQL,
  generateDropTableSQL,
} from '../../src/schema/dsl';
import { SchemaError } from '../../src/utils/errors';

describe('Schema DSL', () => {
  describe('defineTable', () => {
    it('should define a basic table', () => {
      const table = defineTable('users', {
        id: { type: 'TEXT', primaryKey: true },
        name: { type: 'TEXT', notNull: true },
      });

      expect(table.name).toBe('users');
      expect(table.columns.id.type).toBe('TEXT');
      expect(table.columns.id.primaryKey).toBe(true);
      expect(table.columns.name.notNull).toBe(true);
    });

    it('should throw error for invalid table name', () => {
      expect(() => {
        defineTable('', {
          id: { type: 'TEXT' },
        });
      }).toThrow(SchemaError);

      expect(() => {
        defineTable('123invalid', {
          id: { type: 'TEXT' },
        });
      }).toThrow(SchemaError);
    });

    it('should throw error for SQL reserved word', () => {
      expect(() => {
        defineTable('SELECT', {
          id: { type: 'TEXT' },
        });
      }).toThrow(SchemaError);
    });

    it('should throw error for no columns', () => {
      expect(() => {
        defineTable('users', {});
      }).toThrow(SchemaError);
    });

    it('should throw error for invalid column name', () => {
      expect(() => {
        defineTable('users', {
          '123invalid': { type: 'TEXT' },
        });
      }).toThrow(SchemaError);
    });

    it('should throw error for invalid data type', () => {
      expect(() => {
        defineTable('users', {
          // @ts-expect-error - testing invalid type
          id: { type: 'INVALID' },
        });
      }).toThrow(SchemaError);
    });

    it('should throw error for multiple primary keys', () => {
      expect(() => {
        defineTable('users', {
          id1: { type: 'TEXT', primaryKey: true },
          id2: { type: 'TEXT', primaryKey: true },
        });
      }).toThrow(SchemaError);
    });

    it('should throw error for non-INTEGER autoincrement', () => {
      expect(() => {
        defineTable('users', {
          id: { type: 'TEXT', primaryKey: true, autoIncrement: true },
        });
      }).toThrow(SchemaError);
    });

    it('should accept valid foreign key reference', () => {
      const table = defineTable('posts', {
        id: { type: 'TEXT', primaryKey: true },
        user_id: { type: 'TEXT', references: 'users.id' },
      });

      expect(table.columns.user_id.references).toBe('users.id');
    });

    it('should throw error for invalid foreign key format', () => {
      expect(() => {
        defineTable('posts', {
          id: { type: 'TEXT', primaryKey: true },
          user_id: { type: 'TEXT', references: 'invalid' },
        });
      }).toThrow(SchemaError);
    });
  });

  describe('index', () => {
    it('should define an index', () => {
      const idx = index('idx_users_email', ['email']);
      expect(idx.name).toBe('idx_users_email');
      expect(idx.columns).toEqual(['email']);
    });

    it('should define a unique index', () => {
      const idx = index('idx_users_email', ['email'], { unique: true });
      expect(idx.unique).toBe(true);
    });

    it('should define a partial index', () => {
      const idx = index('idx_users_active', ['active'], { where: 'active = 1' });
      expect(idx.where).toBe('active = 1');
    });

    it('should throw error for invalid index name', () => {
      expect(() => {
        index('', ['email']);
      }).toThrow(SchemaError);
    });

    it('should throw error for empty columns', () => {
      expect(() => {
        index('idx_test', []);
      }).toThrow(SchemaError);
    });
  });

  describe('generateCreateTableSQL', () => {
    it('should generate SQL for basic table', () => {
      const table = defineTable('users', {
        id: { type: 'TEXT', primaryKey: true },
        name: { type: 'TEXT', notNull: true },
      });

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('CREATE TABLE "users"');
      expect(sql).toContain('"id" TEXT PRIMARY KEY');
      expect(sql).toContain('"name" TEXT NOT NULL');
    });

    it('should generate SQL with default value', () => {
      const table = defineTable('users', {
        id: { type: 'TEXT', primaryKey: true },
        active: { type: 'INTEGER', default: 1 },
      });

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('DEFAULT 1');
    });

    it('should generate SQL with foreign key', () => {
      const table = defineTable('posts', {
        id: { type: 'TEXT', primaryKey: true },
        user_id: { type: 'TEXT', references: 'users.id', onDelete: 'CASCADE' },
      });

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('REFERENCES "users"("id")');
      expect(sql).toContain('ON DELETE CASCADE');
    });

    it('should generate SQL with WITHOUT ROWID', () => {
      const table = defineTable('config', {
        key: { type: 'TEXT', primaryKey: true },
        value: { type: 'TEXT' },
      }, { withoutRowId: true });

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('WITHOUT ROWID');
    });

    it('should generate SQL with STRICT', () => {
      const table = defineTable('data', {
        id: { type: 'INTEGER', primaryKey: true },
      }, { strict: true });

      const sql = generateCreateTableSQL(table);
      expect(sql).toContain('STRICT');
    });
  });

  describe('generateCreateIndexSQL', () => {
    it('should generate SQL for basic index', () => {
      const idx = index('idx_users_email', ['email']);
      const sql = generateCreateIndexSQL('users', idx);
      expect(sql).toBe('CREATE INDEX "idx_users_email" ON "users"("email")');
    });

    it('should generate SQL for unique index', () => {
      const idx = index('idx_users_email', ['email'], { unique: true });
      const sql = generateCreateIndexSQL('users', idx);
      expect(sql).toContain('CREATE UNIQUE INDEX');
    });

    it('should generate SQL for partial index', () => {
      const idx = index('idx_users_active', ['active'], { where: 'active = 1' });
      const sql = generateCreateIndexSQL('users', idx);
      expect(sql).toContain('WHERE active = 1');
    });

    it('should generate SQL for composite index', () => {
      const idx = index('idx_users_name_email', ['name', 'email']);
      const sql = generateCreateIndexSQL('users', idx);
      expect(sql).toContain('"name", "email"');
    });
  });

  describe('generateDropTableSQL', () => {
    it('should generate DROP TABLE SQL', () => {
      const sql = generateDropTableSQL('users');
      expect(sql).toBe('DROP TABLE IF EXISTS "users"');
    });
  });
});

