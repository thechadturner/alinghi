# Streaming Service Configuration

## Environment Variables

The streaming service reads configuration from environment variables, with support for `.env` files and Docker environment overrides.

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `STREAM_PORT` | `8099` | Port for the streaming server |
| `NODE_ENV` | `development` | Environment mode (`development` or `production`) |
| `DOCKER_CONTAINER` | `false` | Set to `true` when running in Docker |

### CORS Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ORIGINS` | - | Comma-separated list of allowed origins (required) |

**Example:**
```bash
CORS_ORIGINS=http://localhost:5173,http://localhost:3000,https://app.example.com
```

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | - | JWT secret for token verification (required) |

**Example:**
```bash
JWT_SECRET=your-secret-key-here
```

### Redis Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `localhost` | Redis server hostname |
| `REDIS_PORT` | `6379` | Redis server port |
| `REDIS_PASSWORD` | - | Redis password (optional) |
| `REDIS_DB` | `0` | Redis database number |

**Example:**
```bash
REDIS_HOST=redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_DB=0
```

### API Host Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_HOST` | - | API host URL (used for determining bind address) |

**Example:**
```bash
VITE_API_HOST=http://localhost:8099
```

## Configuration File Location

The service looks for `.env` file in the project root (two levels up from `server_stream/middleware/`).

Configuration loading priority:
1. Environment variables from process (Docker, system)
2. `.env` file values
3. Default values

## Docker Configuration

When running in Docker, the service automatically:
- Binds to `0.0.0.0` (instead of `127.0.0.1`) to accept external connections
- Uses environment variables from Docker Compose or container environment

### Docker Compose Example

```yaml
services:
  node_stream:
    environment:
      - STREAM_PORT=8099
      - NODE_ENV=production
      - DOCKER_CONTAINER=true
      - CORS_ORIGINS=https://app.example.com
      - JWT_SECRET=${JWT_SECRET}
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD}
```

## Connection Limits

- **Maximum concurrent sources**: 20
- **Maximum reconnection attempts**: 10 per source
- **Reconnection delay**: Exponential backoff (1s to 60s)

## Redis Storage Configuration

### Data Retention

- **Default retention**: 24 hours
- **Cleanup interval**: Every 1 hour
- **Batch write size**: 100 data points
- **Batch write interval**: 5 seconds

These can be modified in `server_stream/controllers/redis.js`:

```javascript
this.batchSize = 100; // Write batch when buffer reaches this size
this.batchInterval = 5000; // Write batch every 5 seconds
this.retentionHours = 24; // Keep last 24 hours of data
```

### Redis Key Patterns

- **Time-series data**: `stream:source_id:channel_name`
- **Metadata**: `stream:source_id:meta`

## WebSocket Configuration

### Client Connection Settings

- **Ping interval**: 30 seconds (keepalive)
- **Handshake timeout**: 10 seconds (configurable per source)
- **Per-message deflate**: Enabled by default (configurable per source)

### Server Settings

- **Path**: `/api/stream/ws`
- **Max connections**: No hard limit (limited by system resources)

## Security Configuration

### Helmet (Production)

In production mode, Helmet applies strict Content Security Policy:

- `default-src`: 'self'
- `script-src`: 'self'
- `style-src`: 'self' 'unsafe-inline'
- `img-src`: 'self' data: blob:
- `connect-src`: 'self' + allowed CORS origins
- `object-src`: 'none'
- `worker-src`: 'self' blob:

### CSRF Protection

CSRF protection is enabled for all REST endpoints. WebSocket connections use token-based authentication instead.

## Logging Configuration

The service uses the shared console logging system. Log levels are controlled by the main application configuration.

## Example .env File

```bash
# Server
STREAM_PORT=8099
NODE_ENV=development

# CORS
CORS_ORIGINS=http://localhost:5173,http://localhost:3000

# Authentication
JWT_SECRET=your-jwt-secret-key-change-in-production

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# API Host (optional)
VITE_API_HOST=http://localhost:8099
```

## Validation

The service validates:
- Required environment variables on startup
- Source configuration when adding sources
- JWT tokens on WebSocket connections
- Redis connectivity (warns if unavailable, buffers writes)

## Troubleshooting

### Connection Issues

1. **Redis connection fails**: Check `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD`
2. **WebSocket connections fail**: Verify `CORS_ORIGINS` includes your frontend URL
3. **Authentication fails**: Ensure `JWT_SECRET` matches the main application secret

### Performance Tuning

1. **Increase batch size**: Modify `batchSize` in `redis.js` for higher throughput
2. **Adjust retention**: Modify `retentionHours` based on storage capacity
3. **Connection limits**: Modify `MAX_CONNECTIONS` in `connections.js` if needed

