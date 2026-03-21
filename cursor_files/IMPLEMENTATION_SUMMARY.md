# Edit Channel Data Implementation Summary

## Overview

A new API endpoint has been implemented in the file server to allow editing of channel data in parquet files. This enables users to modify specific channel values within a given time range.

## What Was Built

### 1. New API Endpoint: `/api/edit-channel-data`

**Location**: `server_file/routes/files.js`

- **Method**: POST
- **Authentication**: Required (JWT)
- **Permission**: Write access to project
- **Purpose**: Edit channel values in parquet files for a specified time range

### 2. Controller Function: `editChannelData`

**Location**: `server_file/controllers/files.js`

Handles the endpoint logic:
- Validates request parameters
- Checks user permissions
- Resolves the source path (case-insensitive)
- Calls the parquet editor utility
- Returns results with files/rows modified counts

### 3. Parquet Editor Utility

**Location**: `server_file/middleware/parquet_editor.js`

Core functionality for reading, modifying, and writing parquet files:

**Functions**:
- `editChannelInParquetFiles()` - Main function to edit channel data across multiple files
- `readParquetFile()` - Read all rows from a parquet file
- `writeParquetFile()` - Write rows back to parquet file with backup/restore
- `inferSchemaFromRows()` - Infer parquet schema from existing data
- `normalizeTimestamp()` - Handle different timestamp formats

**Features**:
- Automatic backup creation before modification
- Restore from backup on write failure
- Schema inference from existing data
- Selective file processing (only files with the channel)
- Time range filtering
- Support for multiple data types (numeric, string, boolean)

### 4. Documentation

**Location**: `cursor_files/EDIT_CHANNEL_DATA_API.md`

Comprehensive API documentation including:
- Endpoint details
- Request/response formats
- Usage examples
- Error handling
- Troubleshooting guide

### 5. Test Script

**Location**: `cursor_files/test_edit_channel_endpoint.js`

Example script demonstrating how to call the endpoint.

## How It Works

### Request Flow

1. **Client sends POST request** with:
   - Project ID, class name, date, source name
   - Channel name to edit
   - Start and end timestamps (Unix seconds)
   - New channel value

2. **Server validates** request:
   - Checks all required parameters
   - Verifies user has write permission
   - Validates source path exists

3. **Parquet editor processes files**:
   - Finds all parquet files in source directory
   - For each file:
     - Reads all rows
     - Checks if channel exists
     - Modifies rows within time range
     - Writes back to file (with backup)

4. **Server returns results**:
   - Number of files processed
   - Number of files modified
   - Total rows modified

### Time Range Filtering

- Only rows with `ts` (timestamp) field between `start_ts` and `end_ts` are modified
- Timestamps are normalized to handle different formats (number, string, bigint)
- Rows outside the time range remain unchanged

### Safety Features

1. **Backup Creation**: Original files are backed up before modification
2. **Atomic Writes**: If writing fails, backup is restored automatically
3. **Validation**: All parameters validated before processing
4. **Permission Checks**: Requires write permission to project
5. **Selective Processing**: Only files containing the channel are modified
6. **Error Handling**: Continues processing other files if one fails

## Usage Example

```javascript
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

**Response**:
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

## Use Cases

1. **Data Correction**: Fix erroneous sensor readings
2. **Calibration**: Apply calibration adjustments to historical data
3. **Manual Override**: Set specific values for known conditions
4. **State Management**: Update state flags or metadata
5. **Data Cleanup**: Zero out or remove bad data points

## Integration Points

The endpoint integrates seamlessly with existing file server infrastructure:

- Uses existing authentication middleware (`authenticate`)
- Uses existing permission checking (`check_permissions`)
- Uses existing path resolution (`resolveSourcePath`)
- Uses existing logging (`log`, `error`, `warn` from shared)
- Uses existing validation (`express-validator`)
- Uses existing parquet library (`@dsnp/parquetjs`)

## Files Modified

1. `server_file/routes/files.js` - Added new route definition
2. `server_file/controllers/files.js` - Added controller function
3. `server_file/middleware/parquet_editor.js` - New file with editing logic

## Files Created

1. `cursor_files/EDIT_CHANNEL_DATA_API.md` - API documentation
2. `cursor_files/test_edit_channel_endpoint.js` - Test script
3. `cursor_files/IMPLEMENTATION_SUMMARY.md` - This file

## Testing

To test the endpoint:

1. Ensure the file server is running (`npm start` or equivalent)
2. Update the test script with your configuration:
   - Auth token
   - Project ID, class name, date, source name
   - Channel name and time range
   - New value
3. Run: `node cursor_files/test_edit_channel_endpoint.js`

Or use the health check endpoint to verify server is running:
```bash
curl http://localhost:8079/api/health
```

## Important Notes

1. **Timestamps**: All timestamps are in Unix seconds (UTC)
2. **Data Types**: The channel value type should match the existing channel type
3. **Performance**: Processing large files may take time
4. **Concurrency**: Avoid concurrent edits to the same files
5. **Backups**: `.backup` files are created but automatically cleaned up

## Future Enhancements

Possible improvements for future versions:

1. Batch editing of multiple channels
2. Support for mathematical operations (e.g., multiply by factor)
3. Undo/redo functionality
4. Edit history tracking
5. Preview mode (dry run)
6. Progress reporting for long operations
7. Support for complex value transformations
