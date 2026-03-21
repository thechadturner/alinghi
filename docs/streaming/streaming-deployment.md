# Streaming Service Deployment Guide

## Overview

This guide covers deploying the streaming service in both development and production environments, including Docker setup and nginx configuration.

## Prerequisites

- Node.js 18+ (or Docker)
- Redis server (local or remote)
- JWT secret configured
- nginx (for production reverse proxy)

## Local Development

### 1. Install Dependencies

```bash
cd server_stream
npm install
```

### 2. Configure Environment

Create or update `.env` in the project root:

```bash
STREAM_PORT=8099
NODE_ENV=development
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
JWT_SECRET=your-jwt-secret
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 3. Start Redis

Ensure Redis is running:

```bash
# Using Docker
docker run -d -p 6379:6379 redis:alpine

# Or using local Redis
redis-server
```

### 4. Start the Service

```bash
cd server_stream
node server.js
```

The service will start on `http://localhost:8099`.

## Docker Deployment

### Dockerfile

The service uses the shared Node.js Dockerfile at `docker/dockerfiles/Dockerfile.nodejs`.

### Docker Compose

Add to `docker/compose/node.yml`:

```yaml
services:
  node_stream:
    build:
      context: ..
      dockerfile: docker/dockerfiles/Dockerfile.nodejs
    container_name: node_stream
    ports:
      - "${STREAM_PORT:-8099}:8099"
    environment:
      - NODE_ENV=${NODE_ENV:-production}
      - DOCKER_CONTAINER=true
      - STREAM_PORT=${STREAM_PORT:-8099}
      - CORS_ORIGINS=${CORS_ORIGINS}
      - JWT_SECRET=${JWT_SECRET}
      - REDIS_HOST=${REDIS_HOST:-redis}
      - REDIS_PORT=${REDIS_PORT:-6379}
      - REDIS_PASSWORD=${REDIS_PASSWORD:-}
      - REDIS_DB=${REDIS_DB:-0}
    volumes:
      - ../server_stream:/app/server_stream
    networks:
      - hunico-network
    depends_on:
      - redis
    restart: unless-stopped
```

### Start with Docker Compose

```bash
cd docker/compose
docker-compose -f node.yml up -d node_stream
```

## Nginx Configuration

### Development (`nginx-dev.conf`)

```nginx
upstream node_stream {
    server localhost:8099;
}

server {
    # ... other configuration ...

    # Health check
    location /api/stream/health {
        proxy_pass http://node_stream/api/health;
    }

    # Stream server (WebSocket support for realtime data)
    location /api/stream/ {
        proxy_pass http://node_stream/api/stream/;
        proxy_http_version 1.1;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts for WebSocket
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        
        # Don't buffer responses
        proxy_buffering off;
    }
}
```

### Production (`nginx-prod.conf`)

Similar configuration with additional security headers and rate limiting.

## Health Checks

### Service Health

```bash
curl http://localhost:8099/api/health
```

**Response:**
```json
{
  "status": "ok",
  "service": "stream",
  "uptime": 3600.5,
  "timestamp": 1705320000000
}
```

### Readiness Check

```bash
curl http://localhost:8099/api/ready
```

**Response:**
```json
{
  "status": "ready",
  "service": "stream",
  "timestamp": 1705320000000
}
```

## Monitoring

### Connection Status

Monitor active connections:

```bash
# Via API
curl -H "Cookie: auth_token=<token>" http://localhost:8099/api/stream/sources
```

### Redis Status

Check Redis connectivity:

```bash
redis-cli ping
```

If Redis is unavailable, the service will:
- Log warnings
- Buffer writes in memory
- Attempt to flush buffer when Redis reconnects

### WebSocket Connections

Monitor WebSocket client count via logs or implement metrics endpoint.

## Scaling Considerations

### Horizontal Scaling

The streaming service can be scaled horizontally, but consider:

1. **Redis Sharing**: All instances must share the same Redis instance
2. **Source Connections**: Each instance maintains its own source connections
3. **WebSocket Sticky Sessions**: Use nginx `ip_hash` or session affinity for WebSocket connections

**Nginx Configuration for Sticky Sessions:**

```nginx
upstream node_stream {
    ip_hash;  # Sticky sessions based on client IP
    server stream1:8099;
    server stream2:8099;
    server stream3:8099;
}
```

### Vertical Scaling

- **Connection Limits**: Increase `MAX_CONNECTIONS` in `connections.js` if needed
- **Redis Batch Size**: Adjust `batchSize` and `batchInterval` for higher throughput
- **Memory**: Monitor memory usage with many concurrent sources and clients

## Security

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong `JWT_SECRET` (not default)
- [ ] Configure `CORS_ORIGINS` to specific domains
- [ ] Enable Redis password authentication
- [ ] Use HTTPS/WSS in production
- [ ] Configure firewall rules
- [ ] Enable rate limiting in nginx
- [ ] Monitor logs for suspicious activity

### Network Security

- **Internal Network**: Keep Redis on private network
- **Firewall**: Only expose necessary ports (8099 or via nginx)
- **TLS**: Use nginx SSL termination for HTTPS/WSS

## Troubleshooting

### Service Won't Start

1. **Port Already in Use**:
   ```bash
   # Check what's using the port
   lsof -i :8099
   # Or on Windows
   netstat -ano | findstr :8099
   ```

2. **Missing Environment Variables**:
   - Check `.env` file exists
   - Verify required variables are set

3. **Redis Connection Failed**:
   - Verify Redis is running
   - Check `REDIS_HOST` and `REDIS_PORT`
   - Test connection: `redis-cli -h <host> -p <port> ping`

### WebSocket Connections Fail

1. **CORS Issues**:
   - Verify `CORS_ORIGINS` includes frontend URL
   - Check nginx CORS headers

2. **Authentication Failures**:
   - Verify JWT token is valid
   - Check `JWT_SECRET` matches main application

3. **Nginx Configuration**:
   - Ensure `Upgrade` and `Connection` headers are set
   - Check WebSocket timeouts are sufficient

### Data Not Appearing

1. **Source Not Connected**:
   - Check source status: `GET /api/stream/sources/:source_id/status`
   - Review connection logs

2. **Redis Not Storing**:
   - Check Redis connectivity
   - Review Redis logs for errors
   - Verify batch writes are flushing

3. **Processor Errors**:
   - Check logs for processing errors
   - Verify input data format matches expected structure

## Backup and Recovery

### Redis Data

Redis data is ephemeral by default (24-hour retention). For persistence:

1. **Enable Redis Persistence**:
   ```bash
   # In redis.conf
   save 900 1
   save 300 10
   save 60 10000
   ```

2. **Backup Strategy**:
   - Regular Redis snapshots
   - Replication to secondary Redis instance

### Configuration Backup

- Version control for `.env` files (without secrets)
- Document all environment variables
- Use secrets management (e.g., Docker secrets, Kubernetes secrets)

## Performance Tuning

### Redis Optimization

1. **Memory Limits**:
   ```bash
   # In redis.conf
   maxmemory 2gb
   maxmemory-policy allkeys-lru
   ```

2. **Persistence Trade-offs**:
   - AOF for durability (slower writes)
   - RDB for performance (periodic snapshots)

### Node.js Optimization

1. **Increase Event Loop Limits**:
   ```bash
   NODE_OPTIONS="--max-old-space-size=4096"
   ```

2. **Connection Pooling**:
   - Redis client uses connection pooling automatically
   - Adjust `maxRetriesPerRequest` if needed

## Logging

### Log Levels

The service uses the shared console logging system. Logs include:
- Connection events
- Data processing events
- Errors and warnings
- WebSocket connection/disconnection

### Log Rotation

Configure log rotation via:
- Docker logging drivers
- System log rotation (logrotate)
- Application-level rotation

## Updates and Maintenance

### Zero-Downtime Updates

1. **Blue-Green Deployment**:
   - Deploy new version alongside old
   - Switch nginx upstream
   - Drain old connections

2. **Rolling Updates**:
   - Update instances one at a time
   - Use health checks to verify readiness

### Maintenance Windows

1. **Source Management**:
   - Remove sources before maintenance
   - Clients will handle disconnections gracefully

2. **Redis Maintenance**:
   - Service continues with buffered writes
   - Flushes buffer when Redis returns

