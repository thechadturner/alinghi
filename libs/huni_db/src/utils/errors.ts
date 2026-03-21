/**
 * Base error class for all HuniDB errors
 */
export class HuniDBError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HuniDBError';
    
    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
    };
  }
}

/**
 * Error thrown when connection operations fail
 */
export class ConnectionError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONNECTION_ERROR', context);
    this.name = 'ConnectionError';
  }
}

/**
 * Error thrown when migration operations fail
 */
export class MigrationError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'MIGRATION_ERROR', context);
    this.name = 'MigrationError';
  }
}

/**
 * Error thrown when query execution fails
 */
export class QueryError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'QUERY_ERROR', context);
    this.name = 'QueryError';
  }
}

/**
 * Error thrown when schema validation fails
 */
export class SchemaError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SCHEMA_ERROR', context);
    this.name = 'SchemaError';
  }
}

/**
 * Error thrown when transaction operations fail
 */
export class TransactionError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'TRANSACTION_ERROR', context);
    this.name = 'TransactionError';
  }
}

/**
 * Error thrown when storage operations fail
 */
export class StorageError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'STORAGE_ERROR', context);
    this.name = 'StorageError';
  }
}

/**
 * Error thrown when initialization fails
 */
export class InitializationError extends HuniDBError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'INITIALIZATION_ERROR', context);
    this.name = 'InitializationError';
  }
}

/**
 * Wrap an unknown error into a HuniDBError
 */
export function wrapError(error: unknown, defaultMessage: string): HuniDBError {
  if (error instanceof HuniDBError) {
    return error;
  }

  if (error instanceof Error) {
    return new HuniDBError(error.message, 'UNKNOWN_ERROR', {
      originalError: error.name,
      stack: error.stack,
    });
  }

  return new HuniDBError(defaultMessage, 'UNKNOWN_ERROR', {
    originalError: String(error),
  });
}

