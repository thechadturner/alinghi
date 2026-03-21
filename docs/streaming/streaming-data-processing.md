# Streaming Service Data Processing

## Overview

The streaming service processes incoming data points through a state machine that computes derived channels based on sailing-specific logic. This document describes the processing pipeline and computed channels.

## Data Flow

```
Raw Data Point
    ↓
State Machine Processor
    ↓
Processed Data Point (with computed channels)
    ↓
    ├─→ Redis Storage (per-channel time-series)
    └─→ WebSocket Broadcast (to subscribed clients)
```

## Input Data Format

Data points from sources should follow this structure:

```json
{
  "source_id": 1,
  "timestamp": 1705320001000,
  "data": {
    "twa": 45.2,
    "cwa": 50.1,
    "bsp": 8.5,
    "tws": 12.3,
    "twd": 180.0
  }
}
```

**Note**: The `source_id` in the message is validated against the configured source. If not provided, the configured `source_id` is used.

## Computed Channels

### TACK

**Computation**: Based on CWA (Course Wind Angle)

```javascript
TACK = cwa > 0 ? 'stbd' : 'port'
```

**Logic**:
- Positive CWA → Starboard tack (`stbd`)
- Negative or zero CWA → Port tack (`port`)

**Output**: Both uppercase (`TACK`) and lowercase (`tack`) versions are stored.

### POINTOFSAIL

**Computation**: Based on CWA ranges

```javascript
if (cwa < 70) {
  POINTOFSAIL = 'upwind'
} else if (cwa >= 70 && cwa <= 120) {
  POINTOFSAIL = 'reach'
} else {
  POINTOFSAIL = 'downwind'
}
```

**Logic**:
- CWA < 70° → Upwind
- 70° ≤ CWA ≤ 120° → Reach
- CWA > 120° → Downwind

**Output**: Both uppercase (`POINTOFSAIL`) and lowercase (`pointofsail`) versions are stored.

### MANEUVER_TYPE

**Computation**: Based on TWA (True Wind Angle) sign changes

```javascript
if (prevTwa < 0 && twa > 0) {
  MANEUVER_TYPE = 'T'  // Tack
} else if (prevTwa > 0 && twa < 0) {
  MANEUVER_TYPE = 'G'  // Gybe
} else {
  MANEUVER_TYPE = null  // No maneuver
}
```

**Logic**:
- **Tack (T)**: Previous TWA was negative (port) and current TWA is positive (starboard)
- **Gybe (G)**: Previous TWA was positive (starboard) and current TWA is negative (port)
- **No maneuver**: No sign change detected

**State Management**: The processor maintains per-source state:
- `prevTwa`: Previous TWA value
- `prevCwa`: Previous CWA value
- `lastManeuverType`: Last detected maneuver type
- `history`: Historical data (currently unused, reserved for future use)

**Output**: Both uppercase (`MANEUVER_TYPE`) and lowercase (`maneuver_type`) versions are stored. Value is `null` when no maneuver is detected.

## Channel Name Resolution

The processor uses case-insensitive lookup for channel values:

```javascript
getChannelValue(data, ['cwa', 'Cwa', 'CWA'])
```

This ensures compatibility with different data source naming conventions.

## Processed Data Format

After processing, data points include:

```json
{
  "source_id": 1,
  "timestamp": 1705320001000,
  "data": {
    // Original channels
    "twa": 45.2,
    "cwa": 50.1,
    "bsp": 8.5,
    "tws": 12.3,
    "twd": 180.0,
    
    // Computed channels
    "TACK": "stbd",
    "tack": "stbd",
    "POINTOFSAIL": "upwind",
    "pointofsail": "upwind",
    "MANEUVER_TYPE": null,
    "maneuver_type": null,
    
    // Timestamp fields
    "timestamp": 1705320001000,
    "Datetime": "2024-01-15T10:30:01.000Z"
  }
}
```

## State Management

### Per-Source State

Each source maintains independent state:

```javascript
{
  prevTwa: null,           // Previous TWA value
  prevCwa: null,           // Previous CWA value
  lastManeuverType: null,  // Last detected maneuver
  history: []              // Reserved for future use
}
```

### State Lifecycle

1. **Source Added**: State initialized with null values
2. **First Data Point**: TACK and POINTOFSAIL computed, MANEUVER_TYPE is null (no previous TWA)
3. **Subsequent Points**: All channels computed, state updated
4. **Source Removed**: State cleared via `processor.clearState(source_id)`

### State Reset

State can be reset without removing the source:

```javascript
processor.resetState(source_id);
```

This clears previous values but maintains the state structure.

## Error Handling

### Invalid Data Points

- Missing `source_id` or `data`: Warning logged, returns `null`
- Missing channel values: Computed channels set to `null` or not computed
- Processing errors: Error logged, error event emitted, returns `null`

### Channel Value Extraction

If a channel value is not found (e.g., `cwa` missing), the computed channel that depends on it will not be set or will be set to `null`.

## Storage

### Redis Storage

Each channel is stored separately in Redis:

- Key: `stream:source_id:channel_name`
- Score: Timestamp (milliseconds)
- Value: JSON stringified channel value

**Example**:
```
Key: stream:1:twa
Score: 1705320001000
Value: "45.2"
```

### Metadata

Channel metadata is stored in:

- Key: `stream:source_id:meta`
- Hash fields: `channel_name` → `last_timestamp`

This enables efficient channel listing and latest value queries.

## Performance Considerations

### Batch Writes

Redis writes are batched for performance:
- Buffer accumulates writes
- Flushed when buffer reaches 100 points
- Flushed every 5 seconds (time-based)

### State Lookup

State lookup is O(1) using Map data structure.

### Channel Processing

- Original channels: Passed through unchanged
- Computed channels: Only computed if required input channels exist
- Timestamp fields: Always added

## Future Enhancements

Potential additions to the state machine:

1. **Maneuver History**: Track sequence of maneuvers
2. **Velocity-based Detection**: Detect maneuvers based on rate of change
3. **Additional Derived Channels**: VMG, TWA optimization, etc.
4. **Data Validation**: Range checks, outlier detection
5. **Aggregation**: Rolling averages, min/max tracking

## Testing

To test the processor:

1. Send data points with varying TWA/CWA values
2. Verify TACK and POINTOFSAIL computation
3. Send TWA sign changes to trigger maneuver detection
4. Verify state persistence across multiple data points
5. Test state cleanup on source removal

