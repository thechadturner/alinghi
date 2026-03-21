/**
 * Log levels for the logger
 */
export enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: LogLevel;
  prefix: string;
  timestamps: boolean;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  queryCount: number;
  totalQueryTime: number;
  averageQueryTime: number;
  transactionCount: number;
  totalTransactionTime: number;
  averageTransactionTime: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
}

/**
 * Logger class for HuniDB
 */
export class Logger {
  private config: LoggerConfig;
  private metrics: PerformanceMetrics;
  private queryTimes: number[];
  private transactionTimes: number[];

  constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      level: LogLevel.SILENT,
      prefix: '[HuniDB]',
      timestamps: true,
      ...config,
    };

    this.metrics = {
      queryCount: 0,
      totalQueryTime: 0,
      averageQueryTime: 0,
      transactionCount: 0,
      totalTransactionTime: 0,
      averageTransactionTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
    };

    this.queryTimes = [];
    this.transactionTimes = [];
  }

  /**
   * Set the log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Check if a log level is enabled
   */
  private isEnabled(level: LogLevel): boolean {
    return this.config.level >= level;
  }

  /**
   * Format a log message
   */
  private format(level: string, message: string, data?: unknown): string {
    const timestamp = this.config.timestamps ? `[${new Date().toISOString()}]` : '';
    const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    return `${timestamp} ${this.config.prefix} [${level}] ${message}${dataStr}`;
  }

  /**
   * Log an error message
   */
  error(message: string, error?: unknown): void {
    if (this.isEnabled(LogLevel.ERROR)) {
      console.error(this.format('ERROR', message, error));
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: unknown): void {
    if (this.isEnabled(LogLevel.WARN)) {
      console.warn(this.format('WARN', message, data));
    }
  }

  /**
   * Log an info message
   */
  info(message: string, data?: unknown): void {
    if (this.isEnabled(LogLevel.INFO)) {
      console.info(this.format('INFO', message, data));
    }
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: unknown): void {
    if (this.isEnabled(LogLevel.DEBUG)) {
      console.debug(this.format('DEBUG', message, data));
    }
  }

  /**
   * Log a query with execution time
   */
  logQuery(sql: string, params: unknown[] | undefined, executionTime: number): void {
    this.metrics.queryCount++;
    this.metrics.totalQueryTime += executionTime;
    this.queryTimes.push(executionTime);
    this.metrics.averageQueryTime = this.metrics.totalQueryTime / this.metrics.queryCount;

    if (this.isEnabled(LogLevel.DEBUG)) {
      this.debug(`Query executed in ${executionTime.toFixed(2)}ms`, {
        sql: sql.trim(),
        params,
        executionTime,
      });
    }
  }

  /**
   * Log a transaction with execution time
   */
  logTransaction(executionTime: number, success: boolean): void {
    this.metrics.transactionCount++;
    this.metrics.totalTransactionTime += executionTime;
    this.transactionTimes.push(executionTime);
    this.metrics.averageTransactionTime = 
      this.metrics.totalTransactionTime / this.metrics.transactionCount;

    if (this.isEnabled(LogLevel.DEBUG)) {
      this.debug(
        `Transaction ${success ? 'committed' : 'rolled back'} in ${executionTime.toFixed(2)}ms`,
        { executionTime, success }
      );
    }
  }

  /**
   * Log a cache hit
   */
  logCacheHit(): void {
    this.metrics.cacheHits++;
    this.updateCacheHitRate();
  }

  /**
   * Log a cache miss
   */
  logCacheMiss(): void {
    this.metrics.cacheMisses++;
    this.updateCacheHitRate();
  }

  /**
   * Update cache hit rate
   */
  private updateCacheHitRate(): void {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    this.metrics.cacheHitRate = total > 0 ? this.metrics.cacheHits / total : 0;
  }

  /**
   * Get performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset performance metrics
   */
  resetMetrics(): void {
    this.metrics = {
      queryCount: 0,
      totalQueryTime: 0,
      averageQueryTime: 0,
      transactionCount: 0,
      totalTransactionTime: 0,
      averageTransactionTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
    };
    this.queryTimes = [];
    this.transactionTimes = [];
  }

  /**
   * Get query time percentiles
   */
  getQueryPercentiles(): { p50: number; p95: number; p99: number } {
    if (this.queryTimes.length === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...this.queryTimes].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

    return { p50, p95, p99 };
  }
}

/**
 * Default logger instance
 */
export const defaultLogger = new Logger();

/**
 * Create a new logger instance
 */
export function createLogger(config?: Partial<LoggerConfig>): Logger {
  return new Logger(config);
}

