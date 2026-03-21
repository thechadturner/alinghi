# SSE Memory Leak Prevention

This document describes the memory leak prevention mechanisms implemented for Server-Sent Events (SSE) connections in both the Python and Node.js services.

## Overview

Long-running SSE connections can accumulate state and cause memory leaks if not properly managed. This implementation adds comprehensive tracking, cleanup, and monitoring to prevent memory leaks.

## Features

### 1. Connection Tracking
- **Connection Timestamps**: Track when each connection was established
- **Last Activity Tracking**: Monitor last activity (heartbeat or message) for each connection
- **Automatic Cleanup**: Remove stale connections automatically

### 2. Timeout Mechanisms
- **Heartbeat Timeout**: 5 minutes without activity = dead connection
- **Connection Timeout**: 1 hour maximum connection age
- **Periodic Cleanup**: Runs every 60 seconds to remove stale connections

### 3. Heartbeat Mechanism
- **Keepalive Messages**: SSE connections send keepalive every 30 seconds
- **Activity Updates**: Activity timestamp updated on:
  - Connection establishment
  - Message received
  - Keepalive sent
  - Message published

### 4. Monitoring and Statistics
- **Stats Endpoint**: `/api/sse/stats` provides connection statistics
- **Memory Monitoring**: Utilities for tracking memory usage
- **Leak Detection**: Tests to verify no memory accumulation

## Python Service (`server_python`)

### SseEventManager Class

The `SseEventManager` class has been enhanced with:

```python
class SseEventManager:
    def __init__(self):
        self.user_queues: Dict[str, asyncio.Queue] = {}
        self.connection_timestamps: Dict[str, float] = {}
        self.last_activity: Dict[str, float] = {}
        self.connection_timeout: int = 3600  # 1 hour
        self.heartbeat_timeout: int = 300  # 5 minutes
        self._cleanup_interval: int = 60  # 60 seconds
```

### Key Methods

- `subscribe(user_id)`: Subscribe user and track connection
- `unsubscribe(user_id)`: Clean up all tracking data
- `update_activity(user_id)`: Update last activity timestamp
- `cleanup_stale_connections()`: Remove stale connections
- `start_cleanup_task()`: Start periodic cleanup
- `stop_cleanup_task()`: Stop cleanup on shutdown
- `get_stats()`: Get connection statistics

### Startup/Shutdown

- **Startup**: Cleanup task starts automatically
- **Shutdown**: All connections cleaned up gracefully

### Statistics Endpoint

`GET /api/sse/stats` (requires authentication)

Returns:
```json
{
  "success": true,
  "message": "SSE statistics",
  "data": {
    "active_connections": 5,
    "oldest_connection_age": 3600.5,
    "newest_connection_age": 10.2,
    "average_connection_age": 1800.3,
    "total_queues": 5,
    "total_tracked_users": 5
  }
}
```

## Node.js Admin Service (`server_admin`)

### Connection Tracking

The admin server now tracks SSE connections with:

```javascript
const sseClients = new Set();
const sseConnectionTimestamps = new Map();
const sseLastActivity = new Map();
const SSE_CONNECTION_TIMEOUT = 3600000; // 1 hour
const SSE_HEARTBEAT_TIMEOUT = 300000; // 5 minutes
const SSE_CLEANUP_INTERVAL = 60000; // 1 minute
```

### Periodic Cleanup

A cleanup interval runs every 60 seconds to:
1. Check all connections for stale state
2. Remove connections exceeding timeout thresholds
3. Log cleanup actions

### Heartbeat Mechanism

Each connection has a heartbeat interval that:
- Updates activity every 30 seconds
- Cleans up interval on disconnect

### Statistics Endpoint

`GET /api/sse/stats` (requires authentication)

Returns similar statistics to Python service.

### Graceful Shutdown

On `SIGINT` or `SIGTERM`:
1. Clear cleanup interval
2. Close all SSE connections
3. Clear all tracking data

## Memory Monitoring

### Memory Monitor Utility

Located at `server_python/app/utils/memory_monitor.py`:

- **MemoryMonitor Class**: Tracks memory usage over time
- **Baseline Setting**: Establish baseline for leak detection
- **Leak Detection**: Check for memory increases above threshold
- **Trend Analysis**: Analyze memory trends over time

### Usage

```python
from app.utils.memory_monitor import get_memory_monitor

monitor = get_memory_monitor()
monitor.set_baseline()

# Later...
leak_check = monitor.check_for_leak(threshold_mb=100.0)
if leak_check["leak_detected"]:
    logger.warning(f"Memory leak detected: {leak_check['increase_mb']} MB")
```

## Testing

### Memory Leak Tests

Located at `server_python/tests/test_sse_memory_leaks.py`:

Tests verify:
1. ✅ Subscribe/unsubscribe properly cleans up resources
2. ✅ Multiple connections are tracked and cleaned up
3. ✅ Stale connections are automatically removed
4. ✅ Active connections are not cleaned up prematurely
5. ✅ Publishing messages updates activity
6. ✅ Cleanup task runs periodically
7. ✅ Cleanup task stops correctly
8. ✅ Statistics are correctly reported
9. ✅ Memory doesn't accumulate with many connect/disconnect cycles
10. ✅ Connection timeouts work correctly

### Running Tests

```bash
cd server_python
pytest tests/test_sse_memory_leaks.py -v
```

## Configuration

### Timeout Values

**Python Service:**
- `connection_timeout`: 3600 seconds (1 hour)
- `heartbeat_timeout`: 300 seconds (5 minutes)
- `_cleanup_interval`: 60 seconds

**Node.js Service:**
- `SSE_CONNECTION_TIMEOUT`: 3600000 ms (1 hour)
- `SSE_HEARTBEAT_TIMEOUT`: 300000 ms (5 minutes)
- `SSE_CLEANUP_INTERVAL`: 60000 ms (1 minute)

### Adjusting Timeouts

For production environments with different requirements, these values can be adjusted:

**Python:**
```python
sse_manager.connection_timeout = 7200  # 2 hours
sse_manager.heartbeat_timeout = 600  # 10 minutes
```

**Node.js:**
```javascript
const SSE_CONNECTION_TIMEOUT = 7200000; // 2 hours
const SSE_HEARTBEAT_TIMEOUT = 600000; // 10 minutes
```

## Monitoring in Production

### Recommended Monitoring

1. **Connection Count**: Monitor active connections via stats endpoint
2. **Connection Age**: Alert on connections older than expected
3. **Memory Usage**: Use memory monitor to track process memory
4. **Cleanup Logs**: Monitor cleanup logs for unusual patterns

### Example Monitoring Script

```python
import requests
import time

def monitor_sse_health(base_url, token):
    """Monitor SSE health"""
    stats_url = f"{base_url}/api/sse/stats"
    headers = {"Authorization": f"Bearer {token}"}
    
    while True:
        try:
            response = requests.get(stats_url, headers=headers)
            stats = response.json()["data"]
            
            print(f"Active connections: {stats['active_connections']}")
            print(f"Oldest connection: {stats['oldest_connection_age']:.1f}s")
            
            # Alert if too many old connections
            if stats['oldest_connection_age'] > 3600:
                print("⚠️ Warning: Very old connection detected")
            
            time.sleep(60)
        except Exception as e:
            print(f"Error monitoring: {e}")
            time.sleep(60)
```

## Best Practices

1. **Always Clean Up**: Ensure connections are properly closed on client disconnect
2. **Monitor Stats**: Regularly check `/api/sse/stats` in production
3. **Set Baselines**: Use memory monitor to establish baseline memory usage
4. **Test Cleanup**: Verify cleanup works in your test environment
5. **Log Cleanup**: Monitor cleanup logs for patterns

## Troubleshooting

### Connections Not Cleaning Up

1. Check cleanup task is running (should see logs every 60 seconds)
2. Verify timeout values are appropriate
3. Check if connections are receiving keepalive messages
4. Review connection statistics endpoint

### Memory Still Increasing

1. Check for other memory leaks (not just SSE)
2. Verify cleanup is actually removing connections
3. Use memory monitor to identify source of leak
4. Check for circular references in connection tracking

### High Connection Count

1. Verify clients are properly closing connections
2. Check for clients reconnecting without closing old connections
3. Review connection timeout values
4. Monitor connection age statistics

## Future Improvements

Potential enhancements:
- Connection rate limiting
- Per-user connection limits
- More detailed memory profiling
- Automatic alerting on leak detection
- Connection pooling for better resource management

