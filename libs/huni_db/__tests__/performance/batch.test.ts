/**
 * Performance Tests - Batch Writer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BatchWriter } from '../../src/performance/batch.js';
import type { Connection } from '../../src/core/connection.js';
import type { WriteOperation } from '../../src/performance/types.js';

// Mock connection for testing
class MockConnection {
  private execCalls: Array<{ sql: string; params?: unknown[] }> = [];
  private transactionCalls: number = 0;

  async exec(sql: string, params?: unknown[]): Promise<void> {
    this.execCalls.push({ sql, params });
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.transactionCalls++;
    return await callback();
  }

  getEngine() {
    return {
      exec: async (sql: string, params?: unknown[]) => {
        this.execCalls.push({ sql, params });
      },
    };
  }

  getExecCalls() {
    return this.execCalls;
  }

  getTransactionCount() {
    return this.transactionCalls;
  }

  reset() {
    this.execCalls = [];
    this.transactionCalls = 0;
  }
}

describe('BatchWriter', () => {
  let batch: BatchWriter;
  let mockConnection: MockConnection;

  beforeEach(() => {
    mockConnection = new MockConnection() as unknown as Connection;
    batch = new BatchWriter(mockConnection as unknown as Connection, {
      maxSize: 10,
      timeout: 100,
      autoFlush: true,
    });
  });

  afterEach(() => {
    mockConnection.reset();
  });

  it('should queue operations', async () => {
    const op: WriteOperation = {
      type: 'insert',
      sql: 'INSERT INTO test (id, name) VALUES (?, ?)',
      params: ['1', 'Test'],
    };

    await batch.add(op);
    const stats = batch.getStats();
    expect(stats.queueSize).toBe(1);
  });

  it('should auto-flush when batch is full', async () => {
    for (let i = 0; i < 10; i++) {
      await batch.add({
        type: 'insert',
        sql: 'INSERT INTO test (id) VALUES (?)',
        params: [i],
      });
    }

    // Should have flushed
    const stats = batch.getStats();
    expect(stats.queueSize).toBe(0);
    expect(mockConnection.getTransactionCount()).toBeGreaterThan(0);
  });

  it('should flush manually', async () => {
    await batch.add({
      type: 'insert',
      sql: 'INSERT INTO test (id) VALUES (?)',
      params: ['1'],
    });

    await batch.flush();

    const stats = batch.getStats();
    expect(stats.queueSize).toBe(0);
    expect(mockConnection.getTransactionCount()).toBe(1);
  });

  it('should track statistics', async () => {
    for (let i = 0; i < 5; i++) {
      await batch.add({
        type: 'insert',
        sql: 'INSERT INTO test (id) VALUES (?)',
        params: [i],
      });
    }

    await batch.flush();

    const stats = batch.getStats();
    expect(stats.totalOperations).toBe(5);
    expect(stats.totalBatches).toBe(1);
    expect(stats.avgBatchSize).toBe(5);
  });
});

