# Streaming Service API Reference

## Base URL

- Development: `http://localhost:8099/api/stream`
- Production: Configured via nginx proxy at `/api/stream`

## Authentication

All endpoints require JWT authentication via:
- Cookie: `auth_token`
- Header: `Authorization: Bearer <token>`
- WebSocket: Query parameter `?token=<jwt_token>` or `Authorization: Bearer <token>` header

## REST API Endpoints

### List Sources

Get all active source connections.

**Endpoint:** `GET /api/stream/sources`

**Response:**
```json
{
  "success": true,
  "message": "Sources retrieved",
  "data": [
    {
      "source_id": 1,
      "type": "websocket",
      "state": "connected",
      "connectedAt": "2024-01-15T10:30:00.000Z",
      "lastError": null
    }
  ]
}
```

### Get Source Status

Get detailed status for a specific source, including available channels.

**Endpoint:** `GET /api/stream/sources/:source_id/status`

**Parameters:**
- `source_id` (path, integer): Source identifier

**Response:**
```json
{
  "success": true,
  "message": "Source status retrieved",
  "data": {
    "source_id": 1,
    "type": "websocket",
    "state": "connected",
    "connectedAt": "2024-01-15T10:30:00.000Z",
    "lastError": null,
    "channels": ["twa", "cwa", "bsp", "TACK", "POINTOFSAIL"]
  }
}
```

### Add Source

Configure and connect a new data source.

**Endpoint:** `POST /api/stream/sources`

**Request Body:**
```json
{
  "source_id": 1,
  "type": "websocket",
  "config": {
    "url": "ws://example.com/data",
    "headers": {},
    "pingInterval": 30000
  }
}
```

**WebSocket Source Config:**
- `url` (string, required): WebSocket URL
- `headers` (object, optional): Custom headers
- `handshakeTimeout` (number, optional): Connection timeout in ms (default: 10000)
- `perMessageDeflate` (boolean, optional): Enable compression (default: true)
- `pingInterval` (number, optional): Keepalive ping interval in ms

**InfluxDB Simulator Source Config:**
```json
{
  "source_id": 2,
  "type": "influxdb",
  "config": {
    "url": "http://localhost:8086",
    "host": "localhost",
    "port": 8086,
    "database": "sailgp",
    "source": "NZL",
    "pollInterval": 1000,
    "timeRange": "1m",
    "fields": "*"
  }
}
```

**InfluxDB Simulator Source Config:**
- `url` (string, optional): Full simulator URL (e.g., "http://localhost:8086"). Alternative to host/port.
- `host` (string, optional): Simulator hostname (default: "localhost")
- `port` (number, optional): Simulator port (default: 8086)
- `database` (string, optional): Database name (default: "sailgp")
- `source` (string, optional): Source filter (e.g., "NZL", "GBR"). Filters data by source tag.
- `pollInterval` (number, optional): Polling interval in ms (default: 1000)
- `timeRange` (string, optional): Time range for queries (default: "1m"). Supports: s, m, h, d.
- `fields` (string, optional): Fields to select (default: "*"). Comma-separated list or "*" for all.

**Note:** The InfluxDB connector works with the InfluxDB simulator that uses HTTP/CSV format, not the official InfluxDB API.

**Response:**
```json
{
  "success": true,
  "message": "Source added and connected",
  "data": {
    "source_id": 1
  }
}
```

**Error Responses:**
- `400`: Invalid request (missing fields, invalid type, max connections reached)
- `500`: Connection failed or server error

### Remove Source

Disconnect and remove a source connection.

**Endpoint:** `DELETE /api/stream/sources/:source_id`

**Parameters:**
- `source_id` (path, integer): Source identifier

**Response:**
```json
{
  "success": true,
  "message": "Source removed",
  "data": null
}
```

**Error Responses:**
- `404`: Source not found

### Get Source Data

Query historical data from Redis for a specific channel.

**Endpoint:** `GET /api/stream/sources/:source_id/data`

**Parameters:**
- `source_id` (path, integer): Source identifier
- `channel` (query, string, required): Channel name
- `startTime` (query, integer, optional): Start timestamp in milliseconds (default: 1 hour ago)
- `endTime` (query, integer, optional): End timestamp in milliseconds (default: now)

**Example:**
```
GET /api/stream/sources/1/data?channel=twa&startTime=1705320000000&endTime=1705323600000
```

**Response:**
```json
{
  "success": true,
  "message": "Data retrieved",
  "data": {
    "source_id": 1,
    "channel": "twa",
    "startTime": 1705320000000,
    "endTime": 1705323600000,
    "count": 3600,
    "data": [
      {
        "timestamp": 1705320001000,
        "value": 45.2
      },
      {
        "timestamp": 1705320002000,
        "value": 45.5
      }
    ]
  }
}
```

### Get Source Channels

List all available channels for a source.

**Endpoint:** `GET /api/stream/sources/:source_id/channels`

**Parameters:**
- `source_id` (path, integer): Source identifier

**Response:**
```json
{
  "success": true,
  "message": "Channels retrieved",
  "data": {
    "source_id": 1,
    "channels": ["twa", "cwa", "bsp", "tws", "TACK", "POINTOFSAIL", "MANEUVER_TYPE"]
  }
}
```

## WebSocket API

### Connection

**Endpoint:** `ws://host:port/api/stream/ws?token=<jwt_token>`

Or with Authorization header:
```
Authorization: Bearer <jwt_token>
```

### Message Format

All messages are JSON objects with a `type` field.

### Client Messages

#### Subscribe

Subscribe to data from a specific source.

```json
{
  "type": "subscribe",
  "payload": {
    "source_id": 1
  }
}
```

**Response:**
```json
{
  "type": "subscribed",
  "source_id": 1
}
```

#### Unsubscribe

Unsubscribe from a source or all sources.

```json
{
  "type": "unsubscribe",
  "payload": {
    "source_id": 1
  }
}
```

Or unsubscribe from all:
```json
{
  "type": "unsubscribe",
  "payload": {}
}
```

**Response:**
```json
{
  "type": "unsubscribed",
  "source_id": 1
}
```

#### Ping

Keepalive ping message.

```json
{
  "type": "ping"
}
```

**Response:**
```json
{
  "type": "pong"
}
```

### Server Messages

#### Connected

Sent immediately after successful connection.

```json
{
  "type": "connected",
  "clientId": 1,
  "message": "WebSocket connection established"
}
```

#### Data

Real-time data broadcast for subscribed sources.

```json
{
  "type": "data",
  "source_id": 1,
  "timestamp": 1705320001000,
  "data": {
    "twa": 45.2,
    "cwa": 50.1,
    "bsp": 8.5,
    "TACK": "stbd",
    "POINTOFSAIL": "upwind",
    "MANEUVER_TYPE": null,
    "timestamp": 1705320001000,
    "Datetime": "2024-01-15T10:30:01.000Z"
  }
}
```

#### Error

Error message.

```json
{
  "type": "error",
  "message": "Source 1 not found"
}
```

## Health Check

**Endpoint:** `GET /api/health`

**Response:**
```json
{
  "status": "ok",
  "service": "stream",
  "uptime": 3600.5,
  "timestamp": 1705320000000
}
```

## Readiness Check

**Endpoint:** `GET /api/ready`

**Response:**
```json
{
  "status": "ready",
  "service": "stream",
  "timestamp": 1705320000000
}
```

