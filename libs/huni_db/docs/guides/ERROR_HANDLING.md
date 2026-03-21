# Error Handling Guide

## Overview

HuniDB provides comprehensive error handling with typed error classes, automatic retry logic, and detailed error context.

## Error Hierarchy

```
HuniDBError (base)
├── ConnectionError
├── QueryError
├── MigrationError
├── SchemaError
├── TransactionError
├── StorageError
└── InitializationError
```

## Error Classes

### HuniDBError

Base class for all HuniDB errors.

**Properties**:
- `message`: Error message
- `code`: Error code (e.g., 'CONNECTION_ERROR')
- `context`: Additional context object

**Example**:
```typescript
try {
  await db.query('SELECT * FROM users');
} catch (error) {
  if (error instanceof HuniDBError) {
    console.error('Error code:', error.code);
    console.error('Context:', error.context);
  }
}
```

### ConnectionError

Thrown when connection operations fail.

**Common Causes**:
- Maximum connections reached
- Storage unavailable
- Initialization failure

**Example**:
```typescript
try {
  const db = await connect({ name: 'mydb' });
} catch (error) {
  if (error instanceof ConnectionError) {
    if (error.code === 'CONNECTION_ERROR') {
      // Handle connection error
    }
  }
}
```

### QueryError

Thrown when query execution fails.

**Common Causes**:
- SQL syntax errors
- Table/column not found
- Constraint violations
- Query timeout

**Example**:
```typescript
try {
  await db.query('SELECT * FROM nonexistent');
} catch (error) {
  if (error instanceof QueryError) {
    console.error('SQL:', error.context?.sql);
    console.error('Params:', error.context?.params);
  }
}
```

### TransactionError

Thrown when transaction operations fail.

**Common Causes**:
- Transaction rollback
- Deadlock
- Constraint violations

**Example**:
```typescript
try {
  await db.transaction(async (tx) => {
    await tx.exec('INSERT INTO users ...');
    throw new Error('Something went wrong');
  });
} catch (error) {
  if (error instanceof TransactionError) {
    // Transaction was rolled back
  }
}
```

## Retry Logic

### Automatic Retry

HuniDB automatically retries transient errors.

**Transient Errors**:
- Locked database
- Busy database
- Timeout errors
- Network errors
- Connection errors

**Configuration**:
```typescript
const db = await connect({
  name: 'mydb',
  retryEnabled: true,  // Default: true
  maxRetries: 3       // Default: 3
});
```

### Retry Behavior

- **Exponential Backoff**: 100ms → 200ms → 400ms (max 5s)
- **Max Retries**: Configurable (default: 3)
- **Transient Only**: Only retries transient errors

### Manual Retry

```typescript
import { withRetry, isTransientError } from '@hunico/hunidb';

try {
  await withRetry(
    () => db.query('SELECT * FROM users'),
    {
      maxRetries: 5,
      initialDelay: 200,
      shouldRetry: isTransientError
    }
  );
} catch (error) {
  // All retries exhausted
}
```

## Error Context

All errors include context for debugging.

**Example**:
```typescript
try {
  await db.query('SELECT * FROM users WHERE id = ?', [123]);
} catch (error) {
  if (error instanceof QueryError) {
    console.error('Error context:', error.context);
    // {
    //   sql: 'SELECT * FROM users WHERE id = ?',
    //   params: [123],
    //   error: <original error>
    // }
  }
}
```

## Query Timeouts

### Global Timeout

```typescript
const db = await connect({
  name: 'mydb',
  queryTimeout: 5000  // 5 seconds
});
```

### Per-Query Timeout

```typescript
// Override global timeout for specific query
const results = await db.query(
  'SELECT * FROM large_table',
  [],
  10000  // 10 seconds
);
```

### Timeout Errors

```typescript
try {
  await db.query('SELECT * FROM large_table');
} catch (error) {
  if (error instanceof QueryError) {
    if (error.message.includes('timeout')) {
      // Handle timeout
    }
  }
}
```

## Error Handling Patterns

### 1. Try-Catch with Type Checking

```typescript
try {
  await db.query('SELECT * FROM users');
} catch (error) {
  if (error instanceof QueryError) {
    // Handle query error
  } else if (error instanceof ConnectionError) {
    // Handle connection error
  } else {
    // Handle unknown error
  }
}
```

### 2. Error Wrapping

```typescript
import { wrapError } from '@hunico/hunidb';

try {
  await someOperation();
} catch (error) {
  const dbError = wrapError(error, 'Operation failed');
  // dbError is now a HuniDBError
}
```

### 3. Error Logging

```typescript
try {
  await db.query('SELECT * FROM users');
} catch (error) {
  if (error instanceof HuniDBError) {
    console.error('HuniDB Error:', {
      code: error.code,
      message: error.message,
      context: error.context
    });
  }
}
```

## Common Error Scenarios

### 1. Connection Limit Reached

```typescript
try {
  const db = await connect({ name: 'mydb' });
} catch (error) {
  if (error instanceof ConnectionError) {
    if (error.message.includes('Maximum connections')) {
      // Close existing connections
      await closeAll();
      // Retry
      const db = await connect({ name: 'mydb' });
    }
  }
}
```

### 2. Query Timeout

```typescript
try {
  await db.query('SELECT * FROM large_table');
} catch (error) {
  if (error instanceof QueryError) {
    if (error.message.includes('timeout')) {
      // Use pagination or optimize query
      await db.query('SELECT * FROM large_table LIMIT 100');
    }
  }
}
```

### 3. Storage Quota Exceeded

```typescript
try {
  await db.exec('INSERT INTO large_table ...');
} catch (error) {
  if (error instanceof StorageError) {
    if (error.message.includes('quota')) {
      // Clear old data or request more storage
    }
  }
}
```

## Error Recovery

### 1. Automatic Recovery

HuniDB automatically handles:
- Transient errors (retry)
- Connection failures (reconnect)
- Transaction rollbacks (automatic)

### 2. Manual Recovery

```typescript
async function recoverableOperation() {
  let retries = 0;
  const maxRetries = 3;
  
  while (retries < maxRetries) {
    try {
      return await db.query('SELECT * FROM users');
    } catch (error) {
      if (isTransientError(error) && retries < maxRetries - 1) {
        retries++;
        await sleep(100 * Math.pow(2, retries)); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
}
```

## Best Practices

### 1. Always Check Error Types

```typescript
// Good
try {
  await db.query('SELECT * FROM users');
} catch (error) {
  if (error instanceof QueryError) {
    // Handle query error
  }
}

// Bad
try {
  await db.query('SELECT * FROM users');
} catch (error) {
  console.error(error); // Loses type information
}
```

### 2. Use Error Context

```typescript
try {
  await db.query('SELECT * FROM users WHERE id = ?', [123]);
} catch (error) {
  if (error instanceof QueryError) {
    console.error('Failed query:', error.context?.sql);
    console.error('With params:', error.context?.params);
  }
}
```

### 3. Handle Specific Error Codes

```typescript
try {
  await db.query('SELECT * FROM users');
} catch (error) {
  if (error instanceof HuniDBError) {
    switch (error.code) {
      case 'QUERY_ERROR':
        // Handle query error
        break;
      case 'CONNECTION_ERROR':
        // Handle connection error
        break;
      default:
        // Handle other errors
    }
  }
}
```

## Related Documentation

- [Architecture Overview](../architecture/OVERVIEW.md)
- [Performance Guide](../performance/PERFORMANCE_GUIDE.md)
- [API Reference](../api/API_REFERENCE.md)

