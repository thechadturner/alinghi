import { describe, it, expect } from 'vitest';
import {
  HuniDBError,
  ConnectionError,
  MigrationError,
  QueryError,
  SchemaError,
  TransactionError,
  StorageError,
  InitializationError,
  wrapError,
} from '../../src/utils/errors';

describe('Errors', () => {
  describe('HuniDBError', () => {
    it('should create error with message and code', () => {
      const error = new HuniDBError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('HuniDBError');
    });

    it('should create error with context', () => {
      const error = new HuniDBError('Test error', 'TEST_CODE', { foo: 'bar' });
      expect(error.context).toEqual({ foo: 'bar' });
    });

    it('should serialize to JSON', () => {
      const error = new HuniDBError('Test error', 'TEST_CODE', { foo: 'bar' });
      const json = error.toJSON();
      expect(json.name).toBe('HuniDBError');
      expect(json.message).toBe('Test error');
      expect(json.code).toBe('TEST_CODE');
      expect(json.context).toEqual({ foo: 'bar' });
    });
  });

  describe('ConnectionError', () => {
    it('should create connection error', () => {
      const error = new ConnectionError('Connection failed');
      expect(error.name).toBe('ConnectionError');
      expect(error.code).toBe('CONNECTION_ERROR');
    });
  });

  describe('MigrationError', () => {
    it('should create migration error', () => {
      const error = new MigrationError('Migration failed');
      expect(error.name).toBe('MigrationError');
      expect(error.code).toBe('MIGRATION_ERROR');
    });
  });

  describe('QueryError', () => {
    it('should create query error', () => {
      const error = new QueryError('Query failed');
      expect(error.name).toBe('QueryError');
      expect(error.code).toBe('QUERY_ERROR');
    });
  });

  describe('SchemaError', () => {
    it('should create schema error', () => {
      const error = new SchemaError('Schema invalid');
      expect(error.name).toBe('SchemaError');
      expect(error.code).toBe('SCHEMA_ERROR');
    });
  });

  describe('TransactionError', () => {
    it('should create transaction error', () => {
      const error = new TransactionError('Transaction failed');
      expect(error.name).toBe('TransactionError');
      expect(error.code).toBe('TRANSACTION_ERROR');
    });
  });

  describe('StorageError', () => {
    it('should create storage error', () => {
      const error = new StorageError('Storage failed');
      expect(error.name).toBe('StorageError');
      expect(error.code).toBe('STORAGE_ERROR');
    });
  });

  describe('InitializationError', () => {
    it('should create initialization error', () => {
      const error = new InitializationError('Init failed');
      expect(error.name).toBe('InitializationError');
      expect(error.code).toBe('INITIALIZATION_ERROR');
    });
  });

  describe('wrapError', () => {
    it('should return HuniDBError as-is', () => {
      const original = new HuniDBError('Test', 'TEST');
      const wrapped = wrapError(original, 'Default');
      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error', () => {
      const original = new Error('Test error');
      const wrapped = wrapError(original, 'Default');
      expect(wrapped).toBeInstanceOf(HuniDBError);
      expect(wrapped.message).toBe('Test error');
      expect(wrapped.code).toBe('UNKNOWN_ERROR');
    });

    it('should wrap unknown error', () => {
      const wrapped = wrapError('string error', 'Default message');
      expect(wrapped).toBeInstanceOf(HuniDBError);
      expect(wrapped.message).toBe('Default message');
      expect(wrapped.code).toBe('UNKNOWN_ERROR');
    });
  });
});

