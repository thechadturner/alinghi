import { describe, it, expect } from 'vitest';
import {
  buildSelect,
  buildInsert,
  buildUpdate,
  buildDelete,
  buildCount,
  buildInClause,
  buildBetweenClause,
  buildPagination,
  escapeIdentifier,
  formatValue,
} from '../../src/query/builder';

describe('Query Builder', () => {
  describe('buildSelect', () => {
    it('should build simple SELECT', () => {
      const { sql, params } = buildSelect({ table: 'users' });
      expect(sql).toBe('SELECT * FROM "users"');
      expect(params).toEqual([]);
    });

    it('should build SELECT with columns', () => {
      const { sql } = buildSelect({ table: 'users', columns: ['id', 'name'] });
      expect(sql).toBe('SELECT id, name FROM "users"');
    });

    it('should build SELECT with WHERE', () => {
      const { sql, params } = buildSelect({
        table: 'users',
        where: { id: 'u1', active: 1 },
      });
      expect(sql).toContain('WHERE');
      expect(params).toEqual(['u1', 1]);
    });

    it('should build SELECT with ORDER BY', () => {
      const { sql } = buildSelect({ table: 'users', orderBy: 'created_at DESC' });
      expect(sql).toContain('ORDER BY created_at DESC');
    });

    it('should build SELECT with LIMIT', () => {
      const { sql, params } = buildSelect({ table: 'users', limit: 10 });
      expect(sql).toContain('LIMIT ?');
      expect(params).toEqual([10]);
    });

    it('should build SELECT with OFFSET', () => {
      const { sql, params } = buildSelect({
        table: 'users',
        limit: 10,
        offset: 20,
      });
      expect(sql).toContain('LIMIT ?');
      expect(sql).toContain('OFFSET ?');
      expect(params).toEqual([10, 20]);
    });
  });

  describe('buildInsert', () => {
    it('should build INSERT', () => {
      const { sql, params } = buildInsert('users', {
        id: 'u1',
        name: 'John',
        age: 30,
      });
      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).toContain('VALUES (?, ?, ?)');
      expect(params).toEqual(['u1', 'John', 30]);
    });
  });

  describe('buildUpdate', () => {
    it('should build UPDATE', () => {
      const { sql, params } = buildUpdate(
        'users',
        { name: 'Jane', age: 25 },
        { id: 'u1' }
      );
      expect(sql).toContain('UPDATE "users"');
      expect(sql).toContain('SET');
      expect(sql).toContain('WHERE');
      expect(params).toEqual(['Jane', 25, 'u1']);
    });
  });

  describe('buildDelete', () => {
    it('should build DELETE', () => {
      const { sql, params } = buildDelete('users', { id: 'u1' });
      expect(sql).toContain('DELETE FROM "users"');
      expect(sql).toContain('WHERE');
      expect(params).toEqual(['u1']);
    });
  });

  describe('buildCount', () => {
    it('should build COUNT', () => {
      const { sql, params } = buildCount('users');
      expect(sql).toBe('SELECT COUNT(*) as count FROM "users"');
      expect(params).toEqual([]);
    });

    it('should build COUNT with WHERE', () => {
      const { sql, params } = buildCount('users', { active: 1 });
      expect(sql).toContain('WHERE');
      expect(params).toEqual([1]);
    });
  });

  describe('buildInClause', () => {
    it('should build IN clause', () => {
      const { sql, params } = buildInClause('id', ['u1', 'u2', 'u3']);
      expect(sql).toBe('"id" IN (?, ?, ?)');
      expect(params).toEqual(['u1', 'u2', 'u3']);
    });
  });

  describe('buildBetweenClause', () => {
    it('should build BETWEEN clause', () => {
      const { sql, params } = buildBetweenClause('age', 18, 65);
      expect(sql).toBe('"age" BETWEEN ? AND ?');
      expect(params).toEqual([18, 65]);
    });
  });

  describe('buildPagination', () => {
    it('should build pagination', () => {
      const { limit, offset } = buildPagination({ page: 2, pageSize: 10 });
      expect(limit).toBe(10);
      expect(offset).toBe(10);
    });

    it('should build first page', () => {
      const { limit, offset } = buildPagination({ page: 1, pageSize: 20 });
      expect(limit).toBe(20);
      expect(offset).toBe(0);
    });
  });

  describe('escapeIdentifier', () => {
    it('should escape identifier', () => {
      expect(escapeIdentifier('users')).toBe('"users"');
    });

    it('should escape quotes in identifier', () => {
      expect(escapeIdentifier('user"name')).toBe('"user""name"');
    });
  });

  describe('formatValue', () => {
    it('should format null', () => {
      expect(formatValue(null)).toBe('NULL');
      expect(formatValue(undefined)).toBe('NULL');
    });

    it('should format string', () => {
      expect(formatValue('hello')).toBe("'hello'");
    });

    it('should escape quotes in string', () => {
      expect(formatValue("it's")).toBe("'it''s'");
    });

    it('should format number', () => {
      expect(formatValue(42)).toBe('42');
      expect(formatValue(3.14)).toBe('3.14');
    });

    it('should format boolean', () => {
      expect(formatValue(true)).toBe('true');
      expect(formatValue(false)).toBe('false');
    });

    it('should format object as JSON', () => {
      const result = formatValue({ foo: 'bar' });
      expect(result).toContain('foo');
      expect(result).toContain('bar');
    });
  });
});

