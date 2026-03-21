# Streaming Service Overview

## Purpose

The Streaming Service (`server_stream`) is a real-time data ingestion and distribution system designed to:

1. **Connect to external data sources** (WebSocket endpoints, InfluxDB databases) and ingest real-time data
2. **Process and enrich data** with computed channels (TACK, POINTOFSAIL, MANEUVER_TYPE)
3. **Store time-series data** in Redis for historical queries
4. **Broadcast processed data** to connected clients via WebSocket subscriptions
5. **Support multiple concurrent sources** (up to 20 simultaneous connections)

## Architecture

```
┌─────────────────┐
│  External       │
│  Data Sources   │
│  (WebSocket/    │
│   InfluxDB)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Source         │
│  Connectors     │
│  (WebSocket/    │
│   InfluxDB)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  State Machine  │
│  Processor      │
│  (Compute       │
│   derived       │
│   channels)     │
└────────┬────────┘
         │
         ├─────────────────┐
         │                 │
         ▼                 ▼
┌─────────────────┐  ┌─────────────────┐
│  Redis Storage  │  │  WebSocket      │
│  (Time-series   │  │  Server         │
│   storage)      │  │  (Client        │
│                 │  │   broadcasts)   │
└─────────────────┘  └─────────────────┘
```

## Key Components

### 1. Connection Manager (`controllers/connections.js`)
- Manages up to 20 concurrent external source connections
- Tracks connection state (connecting, connected, disconnected, error)
- Implements exponential backoff reconnection logic
- Provides connection lifecycle management

### 2. Source Connectors (`controllers/sources/`)
- **WebSocket Source**: Connects to external WebSocket endpoints, parses JSON messages
- **InfluxDB Source**: Connects to InfluxDB instances, queries/subscribes to data streams

### 3. State Machine Processor (`controllers/processor.js`)
- Processes incoming data points and computes derived channels:
  - **TACK**: `cwa > 0 ? 'stbd' : 'port'`
  - **POINTOFSAIL**: `cwa < 70 ? 'upwind' : (cwa >= 70 && cwa <= 120 ? 'reach' : 'downwind')`
  - **MANEUVER_TYPE**: Detects tacks (T) and gybes (G) based on TWA sign changes
- Maintains per-source state for maneuver detection
- Emits processed data events

### 4. Redis Storage (`controllers/redis.js`)
- Stores time-series data using Redis sorted sets (ZADD)
- Key pattern: `stream:source_id:channel_name`
- Implements batch writes for performance
- Automatic data retention cleanup (24 hours default)
- Supports time-range queries for historical data

### 5. Client WebSocket Server (`controllers/websocket.js`)
- Handles client WebSocket connections
- JWT-based authentication
- Subscription management (subscribe/unsubscribe to sources)
- Broadcasts processed data to subscribed clients
- Connection keepalive (ping/pong)

### 6. Stream Controller (`controllers/stream.js`)
- REST API endpoints for source management
- Source CRUD operations
- Historical data queries
- Channel listing

## Data Flow

1. **Source Connection**: Client calls `POST /api/stream/sources` to add a source
2. **Data Ingestion**: Source connector receives data and emits `data` events
3. **Processing**: Processor receives data, computes derived channels, emits `processed` events
4. **Storage**: Each channel value is stored in Redis with timestamp
5. **Broadcasting**: Processed data is broadcast to all subscribed WebSocket clients
6. **Querying**: Clients can query historical data via `GET /api/stream/sources/:source_id/data`

## Technology Stack

- **Runtime**: Node.js with Express
- **WebSocket**: `ws` library for both server and client connections
- **Storage**: Redis (ioredis) for time-series data
- **Database**: InfluxDB client library for InfluxDB sources
- **Authentication**: JWT tokens
- **Security**: Helmet, CORS, CSRF protection

## Port Configuration

- Default port: **8099**
- Configurable via `STREAM_PORT` environment variable
- WebSocket endpoint: `/api/stream/ws`
- REST API: `/api/stream/*`

## Environment Variables

See [Configuration Guide](./streaming-configuration.md) for detailed environment variable documentation.

## Related Documentation

- [API Reference](./streaming-api-reference.md)
- [Configuration Guide](./streaming-configuration.md)
- [Deployment Guide](./streaming-deployment.md)
- [Data Processing Details](./streaming-data-processing.md)

