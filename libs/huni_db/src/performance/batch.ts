/**
 * Write Batching System
 * 
 * Batches write operations to reduce overhead and improve performance
 */

import type { Connection } from '../core/connection.js';
import type { WriteOperation, BatchOptions } from './types.js';
import { defaultLogger } from '../utils/logger.js';
import { metricsCollector } from './metrics.js';

// Forward declaration to avoid circular dependency
type JSONTable = import('../json/table.js').JSONTable;

/**
 * Default batch options
 */
const DEFAULT_BATCH_OPTIONS: Required<BatchOptions> = {
  maxSize: 100,
  timeout: 100,
  autoFlush: true,
};

/**
 * Batch Writer
 */
export class BatchWriter {
  private connection: Connection;
  private options: Required<BatchOptions>;
  private queue: WriteOperation[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;
  private stats = {
    totalBatches: 0,
    totalOperations: 0,
    avgBatchSize: 0,
  };
  private jsonTable: JSONTable | null = null;

  constructor(connection: Connection, options?: BatchOptions) {
    this.connection = connection;
    this.options = { ...DEFAULT_BATCH_OPTIONS, ...options };
  }

  /**
   * Set JSON table reference for FTS sync after batch writes
   */
  setJSONTable(jsonTable: JSONTable): void {
    this.jsonTable = jsonTable;
  }

  /**
   * Add a write operation to the batch queue
   */
  async add(operation: WriteOperation): Promise<void> {
    this.queue.push(operation);
    this.stats.totalOperations++;

    // Auto-flush if batch is full
    if (this.options.autoFlush && this.queue.length >= this.options.maxSize) {
      await this.flush();
      return;
    }

    // Schedule flush if not already scheduled
    if (!this.flushTimer && this.queue.length > 0) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(error => {
          defaultLogger.error('Batch flush error', error);
        });
      }, this.options.timeout);
    }
  }

  /**
   * Flush all queued operations
   */
  async flush(): Promise<void> {
    if (this.isFlushing) {
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    this.isFlushing = true;

    // Clear timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const operations = this.queue.splice(0);
    const startTime = performance.now();

    defaultLogger.debug(`Batch: Starting flush with ${operations.length} operations`);
    
    if (operations.length === 0) {
      defaultLogger.warn('Batch: Flush called but queue is empty!');
      return;
    }

    try {
      // Execute all operations in a single transaction
      // NOTE: Use engine.exec() directly to avoid writeLock deadlock inside transaction
      await this.connection.transaction(async () => {
        defaultLogger.debug(`Batch: Transaction started, executing ${operations.length} operations`);
        const engine = this.connection.getEngine();
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          if (!op) {
            defaultLogger.error(`Batch: Operation ${i + 1} is undefined!`);
            continue;
          }
          try {
            defaultLogger.debug(`Batch: Executing operation ${i + 1}/${operations.length}: ${op.type} on ${op.table || 'unknown'} (id: ${op.id || 'N/A'})`);
            defaultLogger.debug(`Batch: SQL: ${op.sql.substring(0, 100)}${op.sql.length > 100 ? '...' : ''}, params: ${JSON.stringify(op.params)}`);
            const execStart = performance.now();
            // Use engine.exec() directly to avoid writeLock deadlock (transaction already holds the lock)
            await engine.exec(op.sql, op.params);
            const execDuration = performance.now() - execStart;
            defaultLogger.debug(`Batch: Successfully executed operation ${i + 1}/${operations.length} in ${execDuration.toFixed(2)}ms`);
          } catch (execError) {
            defaultLogger.error(`Batch: Failed to execute operation ${i + 1}/${operations.length} (${op.type} on ${op.table || 'unknown'}): ${execError instanceof Error ? execError.message : String(execError)}`, execError);
            throw execError; // Re-throw to trigger rollback
          }
        }
        defaultLogger.debug(`Batch: All ${operations.length} operations executed, committing transaction`);
      });

      defaultLogger.debug(`Batch: Successfully flushed ${operations.length} operations`);
      const duration = performance.now() - startTime;
      this.stats.totalBatches++;
      this.stats.avgBatchSize = 
        (this.stats.avgBatchSize * (this.stats.totalBatches - 1) + operations.length) / 
        this.stats.totalBatches;

      // Record batch metrics
      metricsCollector.recordBatch(operations.length);

      // Sync FTS for JSON table inserts if JSON table is available
      // We'll let the JSON table handle FTS sync via a public method
      if (this.jsonTable) {
        for (const op of operations) {
          // Check if this is an INSERT/REPLACE into a JSON table
          if ((op.type === 'insert' || op.type === 'update') && op.table && op.id) {
            try {
              // Extract doc from params (assuming format: [id, docJson, timestamp])
              if (op.params && op.params.length >= 2) {
                const docJson = op.params[1];
                if (typeof docJson === 'string') {
                  const doc = JSON.parse(docJson);
                  // Use the JSON table's syncFTSDocument method if available
                  // This will sync FTS without re-inserting the document
                  if (typeof (this.jsonTable as any).syncFTSDocument === 'function') {
                    await (this.jsonTable as any).syncFTSDocument(op.table, op.id, doc).catch(() => {
                      // Ignore FTS sync errors for batch operations
                    });
                  }
                }
              }
            } catch (err) {
              // Ignore FTS sync errors for batch operations
              defaultLogger.debug('Skipping FTS sync for batch operation', err);
            }
          }
        }
      }

      defaultLogger.debug(
        `Flushed batch: ${operations.length} operations in ${duration.toFixed(2)}ms`
      );
    } catch (error) {
      defaultLogger.error(`Batch flush failed: ${error instanceof Error ? error.message : String(error)}`, error);
      defaultLogger.error(`Failed operations: ${operations.length} operations were not executed`);
      throw error;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get batch statistics
   */
  getStats() {
    return {
      ...this.stats,
      queueSize: this.queue.length,
      isFlushing: this.isFlushing,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalBatches: 0,
      totalOperations: 0,
      avgBatchSize: 0,
    };
  }

  /**
   * Update batch options
   */
  updateOptions(options: Partial<BatchOptions>): void {
    this.options = { ...this.options, ...options };
  }
}

