# Streaming Service Documentation

This directory contains comprehensive documentation for the Hunico Streaming Service (`server_stream`).

## Documentation Index

### [Overview](./streaming-service-overview.md)
High-level architecture, components, and data flow of the streaming service.

### [API Reference](./streaming-api-reference.md)
Complete REST API and WebSocket API documentation with request/response examples.

### [Configuration](./streaming-configuration.md)
Environment variables, connection limits, Redis settings, and security configuration.

### [Data Processing](./streaming-data-processing.md)
Detailed explanation of the state machine processor, computed channels (TACK, POINTOFSAIL, MANEUVER_TYPE), and data transformation pipeline.

### [Deployment](./streaming-deployment.md)
Deployment guides for local development, Docker, nginx configuration, scaling, and troubleshooting.

## Quick Start

### 1. Start Redis

```bash
docker run -d -p 6379:6379 redis:alpine
```

### 2. Configure Environment

Create `.env` in project root:

```bash
STREAM_PORT=8099
CORS_ORIGINS=http://localhost:5173
JWT_SECRET=your-secret
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 3. Start Service

```bash
cd server_stream
npm install
node server.js
```

### 4. Add a Source

```bash
curl -X POST http://localhost:8099/api/stream/sources \
  -H "Content-Type: application/json" \
  -H "Cookie: auth_token=<your-token>" \
  -d '{
    "source_id": 1,
    "type": "websocket",
    "config": {
      "url": "ws://example.com/data"
    }
  }'
```

### 5. Connect WebSocket Client

```javascript
const ws = new WebSocket('ws://localhost:8099/api/stream/ws?token=<jwt-token>');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'data') {
    console.log('Received data:', data);
  }
};

// Subscribe to source
ws.send(JSON.stringify({
  type: 'subscribe',
  payload: { source_id: 1 }
}));
```

## Architecture Summary

```
External Sources → Source Connectors → State Machine Processor
                                              ↓
                                    ┌─────────┴─────────┐
                                    ↓                   ↓
                              Redis Storage      WebSocket Clients
```

## Key Features

- **Multi-Source Support**: Connect to up to 20 concurrent WebSocket or InfluxDB sources
- **Real-Time Processing**: Compute derived channels (TACK, POINTOFSAIL, MANEUVER_TYPE) on-the-fly
- **Time-Series Storage**: Redis-based storage with 24-hour retention and efficient queries
- **WebSocket Broadcasting**: Real-time data distribution to subscribed clients
- **Automatic Reconnection**: Exponential backoff reconnection for source connections
- **JWT Authentication**: Secure WebSocket and REST API access

## Components

1. **Connection Manager**: Manages source connections and state
2. **Source Connectors**: WebSocket and InfluxDB adapters
3. **State Machine Processor**: Computes derived sailing channels
4. **Redis Storage**: Time-series data storage and queries
5. **WebSocket Server**: Client connection and subscription management
6. **REST API**: Source management and data queries

## Related Documentation

- [Backend API Documentation](../backend/)
- [Frontend Architecture](../frontend/)
- [Deployment Documentation](../distribution/)

## Support

For issues or questions:
1. Check the [Troubleshooting](./streaming-deployment.md#troubleshooting) section
2. Review service logs
3. Verify configuration matches [Configuration Guide](./streaming-configuration.md)

