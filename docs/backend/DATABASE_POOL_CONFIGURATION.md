# Database Pool Configuration

## Overview

All database connection pools across the application have been standardized to use consistent configuration settings. This ensures predictable performance and prevents connection exhaustion under load.

## Standardized Configuration

All database pools use the following settings:

```javascript
{
  max: 20,                        // Maximum number of clients in the pool
  min: 2,                         // Minimum number of clients in the pool
  connectionTimeoutMillis: 10000, // 10 second timeout for new connections
  idleTimeoutMillis: 300000,      // 5 minute idle timeout (clients idle longer are closed)
  acquireTimeoutMillis: 30000     // 30 second timeout when acquiring a connection from pool
}
```

## SSL Configuration

All pools support SSL configuration for secure connections to hosted PostgreSQL services (AWS RDS, Azure, etc.):

- **Default**: SSL enabled
- **Disable**: Set `DB_SSL=false` in `.env` for local development
- **Self-signed certs**: Set `DB_SSL_REJECT_UNAUTHORIZED=false`
- **CA-signed certs**: Set `DB_SSL_REJECT_UNAUTHORIZED=true` (or omit)

## Files Using Standardized Configuration

1. **`shared/database/connection.js`** - Shared database connection used by multiple services
2. **`server_app/middleware/db.js`** - Application server database pool
3. **`server_admin/middleware/db.js`** - Admin server database pool

## Configuration Details

### Maximum Pool Size (max: 20)
- Limits the total number of database connections
- Prevents overwhelming the database server
- Should be adjusted based on:
  - Database server capacity
  - Expected concurrent requests
  - Available memory

### Minimum Pool Size (min: 2)
- Maintains a minimum number of ready connections
- Reduces connection establishment overhead
- Ensures quick response for initial requests

### Connection Timeout (connectionTimeoutMillis: 10000)
- Maximum time to wait when establishing a new connection
- Prevents hanging on network issues
- 10 seconds is typically sufficient

### Idle Timeout (idleTimeoutMillis: 300000)
- Closes connections that have been idle for 5 minutes
- Prevents connection leaks
- Frees up resources when traffic is low

### Acquire Timeout (acquireTimeoutMillis: 30000)
- Maximum time to wait when requesting a connection from the pool
- Prevents indefinite waiting when pool is exhausted
- Returns error after 30 seconds if no connection available

## Monitoring

The admin server includes pool monitoring events (optional, can be removed in production):

```javascript
pool.on('connect', (client) => {
  log('Database client connected. Total clients:', pool.totalCount, 'Idle:', pool.idleCount, 'Waiting:', pool.waitingCount);
});

pool.on('remove', (client) => {
  log('Database client removed. Total clients:', pool.totalCount, 'Idle:', pool.idleCount, 'Waiting:', pool.waitingCount);
});
```

## Performance Considerations

### When to Increase Pool Size
- High concurrent request volume
- Long-running queries
- Multiple services sharing the same database

### When to Decrease Pool Size
- Limited database server resources
- Memory constraints
- Low concurrent request volume

### Monitoring Pool Usage
Monitor these metrics:
- `pool.totalCount` - Total connections in pool
- `pool.idleCount` - Available connections
- `pool.waitingCount` - Requests waiting for a connection

If `waitingCount` is consistently > 0, consider:
1. Increasing `max` pool size
2. Optimizing slow queries
3. Adding database read replicas
4. Implementing connection pooling at a higher level (PgBouncer)

## Best Practices

1. **Always release connections**: Use try/finally blocks to ensure `client.release()` is called
2. **Handle pool exhaustion**: Implement retry logic or return appropriate errors when pool is exhausted
3. **Monitor connection usage**: Track pool metrics in production
4. **Adjust based on load**: Tune pool size based on actual usage patterns
5. **Use connection pooling**: Never create direct connections outside the pool

## Example Usage

```javascript
const client = await pool.connect();
try {
  const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows;
} catch (error) {
  // Handle error
  throw error;
} finally {
  client.release(); // Always release the connection
}
```

## Troubleshooting

### "Connection pool exhausted" errors
- Check if connections are being released properly
- Monitor pool usage metrics
- Consider increasing `max` pool size
- Look for connection leaks (connections not being released)

### Slow query performance
- Check if queries are holding connections too long
- Optimize slow queries
- Consider read replicas for read-heavy workloads

### High connection count
- Verify all services are using the standardized configuration
- Check for connection leaks
- Monitor idle connections and adjust `idleTimeoutMillis` if needed

