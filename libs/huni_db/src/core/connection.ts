import { SQLiteEngine } from './engine.js';
import { selectStorageType, type StorageType } from './adapter.js';
import { ConnectionError, QueryError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';
import { PreparedStatementCache } from '../query/prepared.js';
import { withRetry, isTransientError } from '../utils/retry.js';

/**
 * Connection options
 */
export interface ConnectionOptions {
  name: string;
  storage?: 'auto' | StorageType;
  cache?: {
    statementLimit?: number;
  };
  verbose?: boolean;
  /** Default query timeout in milliseconds (0 = no timeout) */
  queryTimeout?: number;
  /** Enable retry for transient errors */
  retryEnabled?: boolean;
  /** Maximum retries for transient errors */
  maxRetries?: number;
}

/**
 * Connection instance
 */
export class Connection {
  private engine: SQLiteEngine;
  private statementCache: PreparedStatementCache;
  private writeLock: Promise<void> = Promise.resolve();
  private isOpen = false;
  private queryTimeout: number;
  private retryEnabled: boolean;
  private maxRetries: number;

  constructor(
    private dbName: string,
    private storageType: StorageType,
    cacheLimit = 200,
    queryTimeout = 0,
    retryEnabled = true,
    maxRetries = 3
  ) {
    this.engine = new SQLiteEngine(dbName, storageType);
    this.statementCache = new PreparedStatementCache(cacheLimit);
    this.queryTimeout = queryTimeout;
    this.retryEnabled = retryEnabled;
    this.maxRetries = maxRetries;
  }

  /**
   * Open the connection
   */
  async open(): Promise<void> {
    if (this.isOpen) {
      return;
    }

    try {
      await this.engine.initialize();
      this.isOpen = true;
      defaultLogger.info(`Connection opened for database: ${this.dbName}`);
    } catch (error) {
      throw new ConnectionError(
        `Failed to open connection: ${error instanceof Error ? error.message : String(error)}`,
        { dbName: this.dbName, storageType: this.storageType, error }
      );
    }
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (!this.isOpen) {
      return;
    }

    // Wait for any pending writes
    await this.writeLock;

    // Clear statement cache
    this.statementCache.clear();

    // Close engine
    await this.engine.close();

    this.isOpen = false;
    defaultLogger.info(`Connection closed for database: ${this.dbName}`);
  }

  /**
   * Execute a SQL statement with write serialization
   */
  async exec(sql: string, params?: unknown[]): Promise<void> {
    this.ensureOpen();

    // Serialize writes
    this.writeLock = this.writeLock.then(async () => {
      await this.engine.exec(sql, params);
    });

    await this.writeLock;
  }

  /**
   * Execute a SELECT query (concurrent reads allowed)
   * 
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @param timeout - Optional query timeout in milliseconds (overrides default)
   * @returns Promise resolving to array of result rows
   * @throws QueryError if query fails or times out
   */
  async query<T = unknown>(sql: string, params?: unknown[], timeout?: number): Promise<T[]> {
    this.ensureOpen();
    
    const timeoutMs = timeout ?? this.queryTimeout;
    const queryFn = () => this.engine.query<T>(sql, params);
    
    // Apply timeout if specified
    if (timeoutMs > 0) {
      return Promise.race([
        queryFn(),
        new Promise<T[]>((_, reject) => {
          setTimeout(() => {
            reject(new QueryError(`Query timeout after ${timeoutMs}ms`, { sql, timeout: timeoutMs }));
          }, timeoutMs);
        }),
      ]);
    }
    
    // Apply retry if enabled
    if (this.retryEnabled) {
      return withRetry(queryFn, {
        maxRetries: this.maxRetries,
        shouldRetry: isTransientError,
      });
    }
    
    return queryFn();
  }

  /**
   * Execute a SELECT query and return first row
   * 
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @param timeout - Optional query timeout in milliseconds
   * @returns Promise resolving to first row or null
   */
  async queryOne<T = unknown>(sql: string, params?: unknown[], timeout?: number): Promise<T | null> {
    this.ensureOpen();
    const results = await this.query<T>(sql, params, timeout);
    return results.length > 0 ? (results[0] ?? null) : null;
  }

  /**
   * Execute a SELECT query and return single value
   * 
   * @param sql - SQL query string
   * @param params - Optional query parameters
   * @param timeout - Optional query timeout in milliseconds
   * @returns Promise resolving to single value or null
   */
  async queryValue<T = unknown>(sql: string, params?: unknown[], timeout?: number): Promise<T | null> {
    this.ensureOpen();
    
    const timeoutMs = timeout ?? this.queryTimeout;
    const queryFn = () => this.engine.queryValue<T>(sql, params);
    
    // Apply timeout if specified
    if (timeoutMs > 0) {
      return Promise.race([
        queryFn(),
        new Promise<T | null>((_, reject) => {
          setTimeout(() => {
            reject(new QueryError(`Query timeout after ${timeoutMs}ms`, { sql, timeout: timeoutMs }));
          }, timeoutMs);
        }),
      ]);
    }
    
    // Apply retry if enabled
    if (this.retryEnabled) {
      return withRetry(queryFn, {
        maxRetries: this.maxRetries,
        shouldRetry: isTransientError,
      });
    }
    
    return queryFn();
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.ensureOpen();

    // Serialize transaction
    return new Promise((resolve, reject) => {
      this.writeLock = this.writeLock.then(async () => {
        try {
          const result = await this.engine.transaction(callback);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Get the underlying engine (for advanced use)
   */
  getEngine(): SQLiteEngine {
    return this.engine;
  }

  /**
   * Get the statement cache
   */
  getStatementCache(): PreparedStatementCache {
    return this.statementCache;
  }

  /**
   * Get database name
   */
  getDatabaseName(): string {
    return this.dbName;
  }

  /**
   * Get storage type
   */
  getStorageType(): StorageType {
    return this.storageType;
  }

  /**
   * Force immediate save to IndexedDB (flush pending changes)
   */
  async flush(immediate: boolean = false): Promise<void> {
    await this.engine.flush(immediate);
  }

  /**
   * Check if connection is open
   */
  isConnected(): boolean {
    return this.isOpen && this.engine.isReady();
  }

  /**
   * Ensure connection is open
   */
  private ensureOpen(): void {
    if (!this.isOpen) {
      throw new ConnectionError('Connection is not open. Call open() first.');
    }
  }
}

/**
 * Connection manager with singleton pattern
 */
export class ConnectionManager {
  private static instance: ConnectionManager | null = null;
  private connections: Map<string, Connection> = new Map();
  private static readonly MAX_CONNECTIONS = 10;
  private static readonly DEFAULT_QUERY_TIMEOUT = 30000; // 30 seconds

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  /**
   * Get or create a connection
   * 
   * @throws ConnectionError if maximum connections reached
   */
  async getConnection(options: ConnectionOptions): Promise<Connection> {
    const key = this.getConnectionKey(options.name, options.storage);

    // Return existing connection if available
    if (this.connections.has(key)) {
      const connection = this.connections.get(key)!;
      if (connection.isConnected()) {
        defaultLogger.debug(`Reusing existing connection for: ${options.name}`);
        return connection;
      } else {
        // Connection exists but is not open, remove it
        this.connections.delete(key);
      }
    }

    // Check connection limit
    if (this.connections.size >= ConnectionManager.MAX_CONNECTIONS) {
      throw new ConnectionError(
        `Maximum connections (${ConnectionManager.MAX_CONNECTIONS}) reached. Close existing connections first.`,
        {
          currentConnections: this.connections.size,
          maxConnections: ConnectionManager.MAX_CONNECTIONS,
          connectionNames: Array.from(this.connections.keys()),
        }
      );
    }

    // Determine storage type
    const storageType = options.storage === 'auto' || !options.storage
      ? await selectStorageType()
      : await selectStorageType(options.storage as StorageType);

    // Create new connection
    const connection = new Connection(
      options.name,
      storageType,
      options.cache?.statementLimit,
      options.queryTimeout ?? ConnectionManager.DEFAULT_QUERY_TIMEOUT,
      options.retryEnabled ?? true,
      options.maxRetries ?? 3
    );

    // Open connection
    await connection.open();

    // Store in manager
    this.connections.set(key, connection);

    defaultLogger.info(`Created new connection for: ${options.name} using ${storageType}`);

    return connection;
  }

  /**
   * Close a specific connection
   */
  async closeConnection(dbName: string, storage?: StorageType): Promise<void> {
    const key = this.getConnectionKey(dbName, storage ? storage : 'auto');
    const connection = this.connections.get(key);

    if (connection) {
      await connection.close();
      this.connections.delete(key);
      defaultLogger.info(`Connection closed and removed for: ${dbName}`);
    }
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.connections.values()).map(conn => 
      conn.close().catch(error => {
        defaultLogger.error('Error closing connection', error);
      })
    );

    await Promise.all(closePromises);
    this.connections.clear();

    defaultLogger.info('All connections closed');
  }

  /**
   * Get number of active connections
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get maximum allowed connections
   */
  getMaxConnections(): number {
    return ConnectionManager.MAX_CONNECTIONS;
  }

  /**
   * Check if connection limit is reached
   */
  isConnectionLimitReached(): boolean {
    return this.connections.size >= ConnectionManager.MAX_CONNECTIONS;
  }

  /**
   * Get all connection names
   */
  getConnectionNames(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if a connection exists
   */
  hasConnection(dbName: string, storage?: StorageType): boolean {
    const key = this.getConnectionKey(dbName, storage ? storage : 'auto');
    return this.connections.has(key);
  }

  /**
   * Generate connection key
   */
  private getConnectionKey(dbName: string, storage?: string): string {
    return `${dbName}:${storage || 'auto'}`;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static reset(): void {
    if (ConnectionManager.instance) {
      ConnectionManager.instance.closeAll().catch(() => {
        // Ignore errors during reset
      });
      ConnectionManager.instance = null;
    }
  }
}

/**
 * Get the singleton connection manager instance
 */
export function getConnectionManager(): ConnectionManager {
  return ConnectionManager.getInstance();
}

