# Redis Data Structure and API Reference

## Redis Data Structure

### Key Patterns

The streaming service uses Redis sorted sets (ZSET) to store time-series data with the following key pattern:

```
stream:{source_name}
```

**Examples:**
- `stream:GBR` - All data for source "GBR"
- `stream:ITA` - All data for source "ITA"
- `stream:NZL` - All data for source "NZL"

**Note:** `source_name` is normalized to uppercase and trimmed. The source name comes from the data itself (extracted from the `source_name` channel).

### Metadata Keys

Metadata for each source is stored in a hash with the pattern:

```
stream:{source_name}:meta
```

This hash contains:
- `last_timestamp` - Latest timestamp for the source
- `last_update` - Timestamp of last metadata update

### Data Storage Format

All channels for a source at a given timestamp are stored together in a single JSON object:

- **Key**: `stream:{source_name}` (one key per source, like a table)
- **Score**: Timestamp in milliseconds (Unix epoch) - acts as primary key
- **Member**: JSON object containing all channel values at that timestamp

**Example:**
```redis
ZADD stream:GBR 1699123456789 '{"Lat":45.1234,"Lng":-122.5678,"Hdg":180.5,"Cog":180.2,"Sog":25.3,"Twa":45.2,"Bsp":12.5,"timestamp":1699123456789}'
ZADD stream:GBR 1699123456790 '{"Lat":45.1235,"Lng":-122.5679,"Hdg":181.0,"Cog":181.0,"Sog":25.4,"Twa":45.3,"Bsp":12.6,"timestamp":1699123456790}'
```

**Important:** 
- Only one entry per timestamp per source_name is allowed (no duplicates)
- When channels arrive at the same timestamp, they are automatically merged into a single JSON object
- The `timestamp` field is included in the JSON object for convenience

### Query Operations

The service uses Redis commands:
- `ZADD` - Store data points (JSON objects)
- `ZRANGEBYSCORE` - Query data by time range
- `ZRANGE ... -1 -1` - Get latest data point
- `ZREM` - Remove entries at specific timestamp (for duplicate prevention)
- `ZREMRANGEBYSCORE` - Cleanup old data (retention)

**Query Process:**
1. Query `stream:{source_name}` by time range using `ZRANGEBYSCORE`
2. Parse each JSON object from the results
3. Extract the requested channel value from each object
4. Return array of `{timestamp, value}` pairs

### Data Retention

- Default retention: **24 hours**
- Cleanup runs every hour
- Old data is automatically removed using `ZREMRANGEBYSCORE`

## REST API Endpoints

All endpoints require JWT authentication via `auth_token` cookie.

### Base URL
```
http://localhost:8099/api/stream
```

### 1. Get All Sources

**GET** `/sources`

Returns list of all active source connections.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "source_name": "GBR"
    },
    {
      "source_name": "ITA"
    },
    {
      "source_name": "NZL"
    }
  ]
}
```

**Note:** This endpoint returns only `source_name` values from Redis. No `source_id` mapping is provided. The client must maintain its own mapping between `source_name` and `source_id` if needed.

### 2. Get Source Status

**GET** `/sources/:source_name/status`

Get status for a specific source.

**Parameters:**
- `source_name` (path) - Source name (e.g., "GBR", "ITA", "NZL")

**Response:**
```json
{
  "success": true,
  "data": {
    "source_name": "GBR",
    "channels": ["Lat", "Lng", "Hdg", "Cog", "Sog"],
    "latest_timestamp": 1699123456789
  }
}
```

**Note:** This endpoint only returns Redis data status. Connection management (add/remove sources) still uses `source_id` internally, but data queries use `source_name` only.

### 3. Add Source

**POST** `/sources`

Add or configure a new source connection.

**Request Body:**
```json
{
  "source_id": 1,
  "type": "websocket",
  "config": {
    "url": "ws://example.com/data"
  }
}
```

**For InfluxDB:**
```json
{
  "source_id": 2,
  "type": "influxdb",
  "config": {
    "host": "localhost",
    "port": 8086,
    "database": "sailgp",
    "source_tag": "GBR"
  }
}
```

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

### 4. Remove Source

**DELETE** `/sources/:source_id`

Remove a source connection.

**Parameters:**
- `source_id` (path) - Integer source ID

**Response:**
```json
{
  "success": true,
  "message": "Source removed"
}
```

### 5. Query Historical Data

**GET** `/sources/:source_name/data`

Query historical data from Redis for a specific channel.

**Parameters:**
- `source_name` (path) - Source name (e.g., "GBR", "ITA", "NZL")
- `channel` (query, required) - Channel name (e.g., "Lat", "Lng", "Hdg")
- `startTime` (query, optional) - Start timestamp in milliseconds
- `endTime` (query, optional) - End timestamp in milliseconds

**Example:**
```
GET /api/stream/sources/GBR/data?channel=Lat&startTime=1699123456789&endTime=1699123556789
```

**Response:**
```json
{
  "success": true,
  "data": {
    "source_name": "GBR",
    "channel": "Lat",
    "startTime": 1699123456789,
    "endTime": 1699123556789,
    "count": 2,
    "data": [
      {
        "timestamp": 1699123456789,
        "value": 45.1234
      },
      {
        "timestamp": 1699123457890,
        "value": 45.1235
      }
    ]
  }
}
```

**Notes:**
- If `startTime` and `endTime` are omitted, defaults to last hour
- Data is sorted by timestamp (ascending)
- Channel names are case-sensitive (use normalized names: "Lat", "Lng", "Hdg", "Cog", "Sog")
- The API uses `source_name` directly - no `source_id` mapping is performed
- Returns `null` for channel value if the channel doesn't exist in a data point
- Client-side must map `source_name` to `source_id` if needed

### 6. Get Available Channels

**GET** `/sources/:source_name/channels`

List all available channels for a source.

**Parameters:**
- `source_name` (path) - Source name (e.g., "GBR", "ITA", "NZL")

**Response:**
```json
{
  "success": true,
  "data": {
    "source_name": "GBR",
    "channels": ["Lat_dd", "Lng_dd", "Hdg_deg", "Cog_deg", "Sog_kts", "Twa_deg", "Bsp_kts", "source_name"]
  }
}
```

**Notes:**
- Channels are extracted from the latest data point's JSON object
- The `timestamp` field is excluded from the channel list

## WebSocket API

### Connection

**URL:** `ws://localhost:8099/api/stream/ws?token={jwt_token}`

### Message Types

#### 1. Subscribe to Source

**Client → Server:**
```json
{
  "type": "subscribe",
  "payload": {
    "source_id": 1,
    "channels": ["Lat", "Lng", "Hdg"]  // Optional: filter specific channels
  }
}
```

#### 2. Unsubscribe from Source

**Client → Server:**
```json
{
  "type": "unsubscribe",
  "payload": {
    "source_id": 1
  }
}
```

#### 3. Data Update

**Server → Client:**
```json
{
  "type": "data",
  "source_name": "GBR",
  "timestamp": 1699123456789,
  "data": {
    "Lat": 45.1234,
    "Lng": -122.5678,
    "Hdg": 180.5,
    "Cog": 180.2,
    "Sog": 25.3,
    "source_name": "GBR"
  }
}
```

**Note:** Data updates use `source_name` (not `source_id`). Subscriptions still use `source_id` for connection management, but the broadcast data uses `source_name` from Redis.

#### 4. Connection Status

**Server → Client:**
```json
{
  "type": "connection",
  "payload": {
    "connected": true,
    "message": "Connected to streaming service"
  }
}
```

#### 5. Error

**Server → Client:**
```json
{
  "type": "error",
  "payload": {
    "message": "Error description"
  }
}
```

### Keepalive

The server sends ping messages every 30 seconds. Clients should respond with pong.

## Data Flow

### Historical Data Query Flow

```
Client → GET /api/stream/sources/:source_name/data
         ↓
    Stream Controller
         ↓
    Redis Storage
         ↓
    ZRANGEBYSCORE stream:{source_name}
         ↓
    Parse JSON objects, extract channel
         ↓
    Return data points
```

**Note:** The client must provide `source_name` directly. No `source_id` to `source_name` mapping is performed on the server.

### Real-Time Data Flow

```
External Source → Source Connector → Processor
                                        ↓
                                  Extract source_name
                                        ↓
                                  Accumulate channels per timestamp
                                        ↓
                                  Redis Storage (ZADD as JSON object)
                                        ↓
                                  WebSocket Server
                                        ↓
                                  Subscribed Clients
```

**Data Accumulation:**
- Channels arriving at the same timestamp are accumulated in memory
- After a short delay (100ms) or when all expected channels arrive, the complete data point is flushed to Redis
- This ensures all channels for a timestamp are stored together in a single JSON object
- Duplicate timestamps are prevented by removing existing entries before adding merged data

## Channel Naming

After processing, channels are normalized to:
- `Lat` (latitude)
- `Lng` (longitude)
- `Hdg` (heading)
- `Cog` (course over ground)
- `Sog` (speed over ground)
- `Twa` (true wind angle)
- `Bsp` (boat speed)
- `Tws` (true wind speed)
- `Twd` (true wind direction)
- `source_name` (source identifier)

**Note:** Data in Redis uses these normalized names. When querying, use the normalized channel names.

## Best Practices

1. **Query Efficiency**: Always specify `startTime` and `endTime` to limit query size
2. **Channel Names**: Use normalized channel names (uppercase first letter)
3. **Error Handling**: Check `success` field in API responses
4. **WebSocket**: Implement reconnection logic with exponential backoff
5. **Data Merging**: When fetching multiple channels, they are already merged by timestamp in Redis - each query extracts the requested channel from the stored JSON objects
6. **Source Name**: Ensure `source_name` is present in incoming data - data without `source_name` will be rejected
7. **Unique Timestamps**: The system automatically ensures only one entry per timestamp per source_name

## Example: Fetching Map Data

To fetch all navigation data for a source:

```javascript
// 1. Get available channels (using source_name, not source_id)
const sourceName = 'GBR'; // Client must map source_id to source_name
const channelsResponse = await fetch(`/api/stream/sources/${sourceName}/channels`);
const { channels } = await channelsResponse.json();

// 2. Fetch navigation channels
const navChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
const now = Date.now();
const startTime = now - (60 * 60 * 1000); // Last hour

const promises = navChannels.map(channel =>
  fetch(`/api/stream/sources/${sourceName}/data?channel=${channel}&startTime=${startTime}&endTime=${now}`)
    .then(r => r.json())
    .then(r => r.data.data)
);

const channelData = await Promise.all(promises);

// 3. Merge by timestamp
const merged = mergeByTimestamp(channelData, navChannels);
```

## Debug Endpoints

### GET `/api/stream/debug/status`

Returns system status including Redis connection, active sources, and sample data.

### GET `/api/stream/debug/test-influx`

Tests InfluxDB connection and source discovery (no auth required).


