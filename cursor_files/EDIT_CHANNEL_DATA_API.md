# Edit Channel Data API Endpoint

## Overview

The `edit-channel-data` endpoint allows you to modify channel values in parquet files for a specific time range. This is useful for correcting erroneous data, applying calibrations, or making manual adjustments to sensor readings.

## Endpoint Details

- **URL**: `/api/edit-channel-data`
- **Method**: `POST`
- **Authentication**: Required (JWT token)
- **Permission**: Write access to the project

## Request Parameters

All parameters are required and sent in the request body as JSON.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `project_id` | string | Project identifier | `"1"` |
| `class_name` | string | Class name (boat class) | `"ac75"` |
| `date` | string | Date in YYYYMMDD format | `"20260213"` |
| `source_name` | string | Source name (e.g., boat identifier) | `"GER"` |
| `channel_name` | string | Name of the channel to edit | `"tws"` |
| `start_ts` | number | Start timestamp (Unix seconds) | `1739404800` |
| `end_ts` | number | End timestamp (Unix seconds) | `1739408400` |
| `channel_value` | any | New value to set (type depends on channel) | `15.5` |

## Request Example

```json
POST /api/edit-channel-data
Content-Type: application/json
Authorization: Bearer YOUR_JWT_TOKEN

{
  "project_id": "1",
  "class_name": "ac75",
  "date": "20260213",
  "source_name": "GER",
  "channel_name": "tws",
  "start_ts": 1739404800,
  "end_ts": 1739408400,
  "channel_value": 15.5
}
```

## Response Format

### Success Response (200 OK)

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

### Error Responses

#### 400 Bad Request - Validation Error
```json
{
  "success": false,
  "message": "[{\"msg\":\"channel_name is required\",\"param\":\"channel_name\"}]"
}
```

#### 403 Forbidden - Insufficient Permissions
```json
{
  "success": false,
  "message": "Unauthorized - write permission required"
}
```

#### 404 Not Found - Source Path Not Found
```json
{
  "success": false,
  "message": "Source path not found"
}
```

#### 404 Not Found - No Parquet Files
```json
{
  "success": false,
  "message": "No parquet files found in source"
}
```

#### 500 Internal Server Error
```json
{
  "success": false,
  "message": "Failed to edit channel data: [error details]"
}
```

## Behavior Details

### File Processing

1. The endpoint locates all parquet files in the specified source directory
2. For each file:
   - Reads all rows
   - Checks if the channel exists in the file
   - Modifies rows where the timestamp (`ts`) falls within `[start_ts, end_ts]`
   - Writes the modified data back to the file
3. Creates a backup before writing (automatically removed on success)
4. Continues processing other files even if one fails

### Time Range Filtering

- Only rows with timestamps (`ts` field) between `start_ts` and `end_ts` (inclusive) are modified
- Timestamps are normalized to handle different formats (number, string, bigint)
- Rows outside the time range are left unchanged

### Channel Value Types

The `channel_value` can be any type depending on the channel:
- **Numeric channels**: Use numbers (e.g., `15.5`, `42`)
- **String channels**: Use strings (e.g., `"ACTIVE"`, `"OK"`)
- **Boolean channels**: Use booleans (e.g., `true`, `false`)

### Safety Features

1. **Backup Creation**: Original files are backed up before modification
2. **Atomic Writes**: If writing fails, the backup is restored
3. **Validation**: All parameters are validated before processing
4. **Permission Checks**: Requires write permission to the project
5. **Selective Processing**: Only files containing the channel are modified

## Usage Examples

### Example 1: Correct Wind Speed Data

Correct wind speed readings that were off by 2 knots:

```javascript
const response = await fetch('http://localhost:8079/api/edit-channel-data', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    project_id: '1',
    class_name: 'ac75',
    date: '20260213',
    source_name: 'GER',
    channel_name: 'tws',
    start_ts: 1739404800,
    end_ts: 1739408400,
    channel_value: 15.5
  })
});
```

### Example 2: Set State Flag

Set a state flag to a specific value for a time period:

```javascript
const response = await fetch('http://localhost:8079/api/edit-channel-data', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    project_id: '1',
    class_name: 'ac75',
    date: '20260213',
    source_name: 'GER',
    channel_name: 'foiling_state',
    start_ts: 1739404800,
    end_ts: 1739408400,
    channel_value: 'FOILING'
  })
});
```

### Example 3: Zero Out Bad Sensor Data

Set bad sensor readings to zero:

```javascript
const response = await fetch('http://localhost:8079/api/edit-channel-data', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    project_id: '1',
    class_name: 'ac75',
    date: '20260213',
    source_name: 'GER',
    channel_name: 'pressure_sensor_1',
    start_ts: 1739404800,
    end_ts: 1739408400,
    channel_value: 0
  })
});
```

## Important Notes

1. **Backup Files**: The endpoint creates `.backup` files during processing. These are automatically cleaned up on success but may remain if the process is interrupted.

2. **Performance**: Processing large parquet files can take time. The endpoint processes files sequentially to avoid memory issues.

3. **Data Types**: The schema is inferred from existing data. Make sure the `channel_value` type matches the existing channel type to avoid schema conflicts.

4. **Time Zone**: Timestamps are in Unix seconds (UTC). Make sure to convert local times to UTC before calling the endpoint.

5. **Concurrent Edits**: Avoid editing the same files concurrently from multiple requests to prevent data corruption.

6. **File Discovery**: The endpoint processes ALL parquet files in the source directory. If a channel doesn't exist in a file, that file is skipped.

## Troubleshooting

### "Source path not found"
- Verify the `project_id`, `class_name`, `date`, and `source_name` are correct
- Check that the directory structure matches: `DATA_DIRECTORY/System/{project_id}/{class_name}/{date}/{source_name}/`

### "No parquet files found in source"
- Verify that parquet files exist in the source directory
- Check file permissions

### "Channel not found in any files"
- Verify the `channel_name` is correct (case-sensitive)
- Use the `/api/channels` endpoint to list available channels first

### "Unauthorized - write permission required"
- Verify your JWT token is valid
- Check that you have write permissions for the project

## Related Endpoints

- `GET /api/channels` - List available channels for a source
- `POST /api/channel-values` - Retrieve channel values
- `GET /api/sources` - List available sources for a date
