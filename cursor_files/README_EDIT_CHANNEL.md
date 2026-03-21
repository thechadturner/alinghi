# Edit Channel Data Feature

## Overview

This feature allows you to edit channel information in parquet files for a given date and time range. You can specify a date, source name, channel name, start time, end time, and a new channel value to overwrite existing values within that time range.

## Quick Links

- **Quick Start Guide**: [QUICK_START_EDIT_CHANNEL.md](QUICK_START_EDIT_CHANNEL.md)
- **Full API Documentation**: [EDIT_CHANNEL_DATA_API.md](EDIT_CHANNEL_DATA_API.md)
- **Implementation Details**: [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)
- **Flow Diagrams**: [EDIT_CHANNEL_FLOW.md](EDIT_CHANNEL_FLOW.md)
- **Test Script**: [test_edit_channel_endpoint.js](test_edit_channel_endpoint.js)

## What's New

### Endpoint: `/api/edit-channel-data`

A new POST endpoint in the file server that allows editing of channel data in parquet files.

**Key Features**:
- Edit any channel for a specific time range
- Automatic backup and recovery
- Batch processing across multiple parquet files
- Type-safe value updates
- Comprehensive error handling

## Getting Started

### 1. Basic Usage

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

### 2. Using the Test Script

```bash
# 1. Edit the configuration in the test script
nano cursor_files/test_edit_channel_endpoint.js

# 2. Update with your values:
#    - authToken
#    - project_id, class_name, date, source_name
#    - channel_name, start_ts, end_ts, channel_value

# 3. Run the test
node cursor_files/test_edit_channel_endpoint.js
```

### 3. JavaScript/TypeScript Example

```javascript
import axios from 'axios';

async function editChannelData(
  projectId: string,
  className: string,
  date: string,
  sourceName: string,
  channelName: string,
  startTs: number,
  endTs: number,
  value: any
) {
  const response = await axios.post(
    'http://localhost:8079/api/edit-channel-data',
    {
      project_id: projectId,
      class_name: className,
      date: date,
      source_name: sourceName,
      channel_name: channelName,
      start_ts: startTs,
      end_ts: endTs,
      channel_value: value
    },
    {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data;
}

// Usage
const result = await editChannelData(
  '1',           // project_id
  'ac75',        // class_name
  '20260213',    // date (YYYYMMDD)
  'GER',         // source_name
  'tws',         // channel_name
  1739404800,    // start_ts (Unix seconds)
  1739408400,    // end_ts (Unix seconds)
  15.5           // channel_value
);

console.log(`Modified ${result.data.rowsModified} rows in ${result.data.filesModified} files`);
```

## Common Use Cases

### 1. Fix Sensor Calibration Error

A sensor was reading 2 knots too high for a specific time period:

```javascript
await editChannelData(
  '1', 'ac75', '20260213', 'GER',
  'tws',           // True wind speed
  1739404800,      // Start of bad data
  1739408400,      // End of bad data
  15.5             // Corrected value
);
```

### 2. Update State Flag

Mark a time period as "foiling":

```javascript
await editChannelData(
  '1', 'ac75', '20260213', 'GER',
  'foiling_state',
  1739404800,
  1739408400,
  'FOILING'
);
```

### 3. Zero Out Bad Sensor Data

A sensor was malfunctioning and needs to be zeroed:

```javascript
await editChannelData(
  '1', 'ac75', '20260213', 'GER',
  'pressure_sensor_1',
  1739404800,
  1739408400,
  0
);
```

### 4. Apply Manual Correction

Apply a known correction to historical data:

```javascript
await editChannelData(
  '1', 'ac75', '20260213', 'GER',
  'heel_angle',
  1739404800,
  1739408400,
  5.2
);
```

## How It Works

1. **Authentication**: Verifies your JWT token
2. **Validation**: Checks all required parameters
3. **Permission Check**: Ensures you have write access to the project
4. **File Discovery**: Finds all parquet files in the source directory
5. **Processing**: For each file:
   - Reads all rows
   - Checks if the channel exists
   - Modifies rows within the time range
   - Writes back with automatic backup
6. **Response**: Returns counts of files and rows modified

## Safety Features

### Automatic Backups
Before modifying any file, a backup is created with `.backup` extension. If the write fails, the backup is automatically restored.

### Atomic Operations
Each file is processed atomically - either the entire file is updated successfully, or it's left unchanged.

### Permission Checks
Only users with write permission to the project can edit data.

### Validation
All inputs are validated before processing begins.

### Error Isolation
If one file fails to process, other files continue to be processed.

## Response Format

```json
{
  "success": true,
  "message": "Channel data updated successfully",
  "data": {
    "filesModified": 3,      // Number of files that were changed
    "rowsModified": 1250,    // Total number of rows updated
    "filesProcessed": 5      // Total number of files examined
  }
}
```

## Error Handling

| Status | Error | Cause | Solution |
|--------|-------|-------|----------|
| 400 | Bad Request | Missing or invalid parameters | Check all required parameters are provided |
| 403 | Forbidden | No write permission | Verify your token has write access to the project |
| 404 | Not Found | Source path doesn't exist | Check project_id, class_name, date, source_name |
| 404 | Not Found | No parquet files | Verify data exists for that date/source |
| 500 | Internal Error | Processing failed | Check server logs for details |

## Important Notes

### Timestamps
- All timestamps are in **Unix seconds** (not milliseconds)
- Timestamps are in **UTC**
- Convert local times to UTC before calling the endpoint

### Data Types
- The `channel_value` type should match the existing channel type
- Numeric channels: use numbers
- String channels: use strings
- Boolean channels: use booleans

### Performance
- Processing large files may take time
- The endpoint processes files sequentially
- Response is sent only after all files are processed

### Concurrency
- Avoid editing the same files concurrently
- Multiple requests to different sources can run in parallel

## Files Modified

The implementation consists of:

1. **Route Definition** (`server_file/routes/files.js`)
   - Endpoint definition with validation rules

2. **Controller** (`server_file/controllers/files.js`)
   - Request handling and orchestration

3. **Parquet Editor** (`server_file/middleware/parquet_editor.js`)
   - Core editing logic
   - Backup/restore functionality
   - Schema inference

## Documentation Files

All documentation is in the `cursor_files/` directory:

- `README_EDIT_CHANNEL.md` - This file
- `QUICK_START_EDIT_CHANNEL.md` - Quick reference
- `EDIT_CHANNEL_DATA_API.md` - Complete API documentation
- `IMPLEMENTATION_SUMMARY.md` - Technical implementation details
- `EDIT_CHANNEL_FLOW.md` - Flow diagrams
- `test_edit_channel_endpoint.js` - Test script

## Testing

### Manual Testing

1. Start the file server:
   ```bash
   cd server_file
   npm start
   ```

2. Verify server is running:
   ```bash
   curl http://localhost:8079/api/health
   ```

3. Run the test script:
   ```bash
   node cursor_files/test_edit_channel_endpoint.js
   ```

### Integration Testing

Use with existing endpoints:

1. List available channels:
   ```bash
   GET /api/channels?project_id=1&class_name=ac75&date=20260213&source_name=GER
   ```

2. Get current values:
   ```bash
   POST /api/channel-values
   {
     "project_id": "1",
     "class_name": "ac75",
     "date": "20260213",
     "source_name": "GER",
     "channel_list": [{"name": "tws", "type": "float"}],
     "start_ts": 1739404800,
     "end_ts": 1739408400
   }
   ```

3. Edit values:
   ```bash
   POST /api/edit-channel-data
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

4. Verify changes:
   ```bash
   POST /api/channel-values
   # (same as step 2)
   ```

## Troubleshooting

### "Source path not found"
- Check that data exists for the specified date/source
- Verify the directory structure: `DATA_DIRECTORY/System/{project_id}/{class_name}/{date}/{source_name}/`

### "No parquet files found"
- Ensure parquet files exist in the source directory
- Check file permissions

### "Channel not found"
- Verify the channel name is correct (case-sensitive)
- Use `/api/channels` to list available channels

### "Unauthorized"
- Verify your JWT token is valid
- Check that you have write permissions for the project

### Backup files remain
- If `.backup` files remain after processing, it may indicate an interrupted operation
- These can be safely deleted if the main files are intact

## Support

For issues or questions:

1. Check the full API documentation: `EDIT_CHANNEL_DATA_API.md`
2. Review the implementation details: `IMPLEMENTATION_SUMMARY.md`
3. Check server logs for detailed error messages
4. Use the health endpoint to verify server status: `GET /api/health`

## Future Enhancements

Potential improvements for future versions:

- Batch editing of multiple channels
- Mathematical operations (multiply, add, etc.)
- Undo/redo functionality
- Edit history tracking
- Preview mode (dry run)
- Progress reporting for long operations
- Support for complex transformations
- Web UI for editing

## License

Part of the RaceSight project.
