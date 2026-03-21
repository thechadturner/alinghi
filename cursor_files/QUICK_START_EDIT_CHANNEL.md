# Quick Start: Edit Channel Data

## TL;DR

Edit channel values in parquet files for a specific time range.

## Endpoint

```
POST /api/edit-channel-data
```

## Minimal Example

```bash
curl -X POST http://localhost:8079/api/edit-channel-data \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "1",
    "class_name": "ac75",
    "date": "20260213",
    "source_name": "GER",
    "channel_name": "tws",
    "start_ts": 1739404800,
    "end_ts": 1739408400,
    "channel_value": 15.5
  }'
```

## JavaScript Example

```javascript
const axios = require('axios');

async function editChannelData() {
  const response = await axios.post(
    'http://localhost:8079/api/edit-channel-data',
    {
      project_id: '1',
      class_name: 'ac75',
      date: '20260213',        // YYYYMMDD format
      source_name: 'GER',
      channel_name: 'tws',     // Channel to edit
      start_ts: 1739404800,    // Unix timestamp (start)
      end_ts: 1739408400,      // Unix timestamp (end)
      channel_value: 15.5      // New value
    },
    {
      headers: {
        'Authorization': 'Bearer YOUR_TOKEN',
        'Content-Type': 'application/json'
      }
    }
  );
  
  console.log('Files modified:', response.data.data.filesModified);
  console.log('Rows modified:', response.data.data.rowsModified);
}
```

## Parameters

| Parameter | Required | Type | Example |
|-----------|----------|------|---------|
| `project_id` | Yes | string | `"1"` |
| `class_name` | Yes | string | `"ac75"` |
| `date` | Yes | string | `"20260213"` |
| `source_name` | Yes | string | `"GER"` |
| `channel_name` | Yes | string | `"tws"` |
| `start_ts` | Yes | number | `1739404800` |
| `end_ts` | Yes | number | `1739408400` |
| `channel_value` | Yes | any | `15.5` |

## Common Use Cases

### 1. Fix Bad Sensor Reading
```json
{
  "channel_name": "wind_sensor_1",
  "start_ts": 1739404800,
  "end_ts": 1739404900,
  "channel_value": 0
}
```

### 2. Update State Flag
```json
{
  "channel_name": "foiling_state",
  "start_ts": 1739404800,
  "end_ts": 1739408400,
  "channel_value": "FOILING"
}
```

### 3. Apply Calibration
```json
{
  "channel_name": "pressure_sensor",
  "start_ts": 1739404800,
  "end_ts": 1739408400,
  "channel_value": 1013.25
}
```

## Response

Success:
```json
{
  "success": true,
  "message": "Channel data updated successfully",
  "data": {
    "filesModified": 3,
    "rowsModified": 1250,
    "filesProcessed": 5
  }
}
```

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| 403 Forbidden | No write permission | Check your token has write access |
| 404 Not Found | Source path doesn't exist | Verify project_id, class_name, date, source_name |
| 404 Not Found | No parquet files | Check if data exists for that date/source |
| 400 Bad Request | Missing parameter | Include all required parameters |

## Tips

1. **Get timestamps**: Use `/api/channel-values` to see existing timestamps
2. **List channels**: Use `/api/channels` to see available channels
3. **Check permissions**: Requires write access to the project
4. **Time zone**: Timestamps are Unix seconds in UTC
5. **Backup**: Files are automatically backed up before modification

## Full Documentation

See `EDIT_CHANNEL_DATA_API.md` for complete documentation.

## Test Script

Use the test script to try it out:
```bash
node cursor_files/test_edit_channel_endpoint.js
```
