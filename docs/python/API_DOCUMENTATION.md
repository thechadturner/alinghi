# Python Service API Documentation

## Overview

The Python Service API is a FastAPI-based service for executing Python scripts with real-time progress monitoring via Server-Sent Events (SSE). It provides comprehensive script execution capabilities with authentication, CORS support, and process management.

## Base URL

- **Development**: `http://localhost:8049`
- **Production**: `https://api.example.com`

## Authentication

All endpoints (except health check) require authentication via one of these methods:

### JWT Token
```http
Authorization: Bearer <jwt_token>
```

### Personal Access Token (PAT)
```http
Authorization: Bearer <pat_token>
```

## CORS Configuration

The API supports configurable CORS origins via the `CORS_ORIGINS` environment variable:

```bash
# Single origin
CORS_ORIGINS=http://localhost:3000

# Multiple origins
CORS_ORIGINS=http://localhost:3000,https://app.example.com

# Allow all origins (development only)
CORS_ORIGINS=*
```

## Endpoints

### System Endpoints

#### Health Check
```http
GET /api/health
```

**Description**: Check if the service is running and healthy.

**Authentication**: None required.

**Response**:
```json
{
  "success": true,
  "message": "Service is healthy",
  "data": {
    "status": "ok"
  }
}
```

### Real-time Endpoints

#### Server-Sent Events Stream
```http
GET /api/sse?token=<jwt_or_pat_token>
```

**Description**: Real-time event stream for script execution progress.

**Authentication**: Required (JWT or PAT).

**Parameters**:
- `token` (string, required): JWT or PAT token for authentication

**Headers**:
- `Accept: text/event-stream`
- `Cache-Control: no-cache`

**Alternative Authentication**: Also supports `Authorization: Bearer <token>` header as fallback.

**Event Format**:
```json
{
  "success": true,
  "event": {
    "process_id": "uuid",
    "type": "script_execution",
    "event": "progress_event|process_complete|process_timeout",
    "text": "Human readable message",
    "now": 1730000000000
  },
  "data": {}
}
```

**Event Types**:
- `progress_event`: Real-time output/progress updates
- `process_complete`: Script finished successfully
- `process_timeout`: Script timed out

**JavaScript Usage**:

Query Parameter (Recommended for SSE):
```javascript
const eventSource = new EventSource('/api/sse?token=your-jwt-or-pat-token');

eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  console.log('Event:', data.event.event, data.event.text);
};
```

Authorization Header (Fallback):
```javascript
const eventSource = new EventSource('/api/sse', {
  headers: { 'Authorization': 'Bearer your-token' }
});

eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  console.log('Event:', data.event.event, data.event.text);
};
```

### Script Endpoints

#### Execute Python Script
```http
POST /api/execute_script/
```

**Description**: Execute a Python script with real-time progress monitoring.

**Authentication**: Required (JWT or PAT).

**Request Body**:
```json
{
  "class_name": "ac75",
  "script_name": "0_map.py",
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  }
}
```

**Parameters**:
- `class_name` (string): Script category/class (e.g., "ac75")
- `script_name` (string): Script filename (e.g., "0_map.py" or "0_map")
- `parameters` (object): Parameters to pass to the script

**Success Response (200 OK)**:
```json
{
  "success": true,
  "message": "Script executed successfully",
  "data": {
    "process_id": "uuid",
    "results": {...},
    "return_code": 0,
    "output_lines": [...],
    "warning_lines": [...],
    "error_lines": [...],
    "user_id": "user-123"
  }
}
```

**Failure Response (500 Internal Server Error)**:
```json
{
  "success": false,
  "message": "Script execution failed",
  "data": {
    "process_id": "uuid",
    "return_code": 1,
    "error_lines": ["Error message"],
    "warning_lines": [...],
    "output_lines": [...],
    "user_id": "user-123"
  }
}
```

**Timeout Response (408 Request Timeout)**:
```json
{
  "success": false,
  "message": "Script execution timed out",
  "data": {
    "process_id": "uuid",
    "return_code": -1,
    "timeout": true,
    "output_lines": [...],
    "error_lines": [...],
    "warning_lines": [...],
    "user_id": "user-123"
  }
}
```

#### Execute Script in Background
```http
POST /api/execute_script_background/
```

**Description**: Execute a Python script in the background without blocking.

**Authentication**: Required (JWT or PAT).

**Request Body**: Same as `/api/execute_script/`

**Response**:
```json
{
  "success": true,
  "message": "Script started in background",
  "data": {
    "user_id": "user-123",
    "script": "ac75/long_running_script.py"
  }
}
```

**Use Cases**:
- Long-running data processing scripts
- Scripts that don't need real-time output
- Batch operations
- Scripts that run for hours or days

#### Get Script Progress
```http
GET /api/scripts/progress?since=0
```

**Description**: Polling endpoint for script progress updates.

**Authentication**: Required (JWT or PAT).

**Parameters**:
- `since` (int, optional): Unix timestamp in milliseconds. Default: 0

**Response**:
```json
{
  "success": true,
  "message": "Progress endpoint active",
  "data": {
    "user_id": "user-123",
    "current_time": 1730000000000,
    "since": 0,
    "status": "running",
    "events": []
  }
}
```

### Data Endpoints

#### Fetch Data from Script
```http
POST /api/fetch_data/
```

**Description**: Execute a Python script and return its JSON output.

**Authentication**: Required (JWT or PAT).

**Request Body**: Same as `/api/execute_script/`

**Success Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "result": "processed_data",
    "count": 100,
    "status": "complete"
  }
}
```

**No Valid JSON Response (200 OK)**:
```json
{
  "success": false,
  "data": []
}
```

**Script Requirements**: The script must output valid JSON to stdout as its last line.

## Error Handling

### Common HTTP Status Codes

- **200 OK**: Request successful
- **401 Unauthorized**: Invalid or missing authentication token
- **404 Not Found**: Script file not found
- **408 Request Timeout**: Script execution timed out
- **500 Internal Server Error**: Script execution failed or server error

### Error Response Format

```json
{
  "success": false,
  "message": "Error description",
  "data": {
    "error_details": "...",
    "user_id": "user-123"
  }
}
```

## Rate Limiting

Currently no rate limiting is implemented. Consider implementing rate limiting for production use.

## Timeouts

- **Script Execution**: 1 hour (3600 seconds)
- **Background Scripts**: No timeout limit
- **Data Fetching**: 1 hour (3600 seconds)

## Process Management

Each script execution receives a unique `process_id` that can be used to:
- Track events via SSE
- Correlate logs and outputs
- Monitor execution status
- Debug issues

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `JWT_SECRET` | Secret key for JWT validation | - | Yes |
| `SYSTEM_KEY` | System key for PAT authentication | - | Yes |
| `CORS_ORIGINS` | Comma-separated list of allowed origins | `*` | No |
| `VITE_VERBOSE` | Enable verbose logging | `false` | No |

## OpenAPI/Swagger Documentation

The API includes comprehensive OpenAPI documentation available at:
- **Swagger UI**: `http://localhost:8049/docs`
- **ReDoc**: `http://localhost:8049/redoc`
- **OpenAPI JSON**: `http://localhost:8049/openapi.json`

## Examples

### Complete Script Execution with SSE

```javascript
// 1. Connect to SSE stream
const eventSource = new EventSource('/api/sse', {
  headers: { 'Authorization': 'Bearer your-token' }
});

// 2. Listen for events
eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  
  switch(data.event.event) {
    case 'progress_event':
      console.log('Progress:', data.event.text);
      break;
    case 'process_complete':
      console.log('Script completed:', data.event.text);
      eventSource.close();
      break;
    case 'process_timeout':
      console.log('Script timed out:', data.event.text);
      eventSource.close();
      break;
  }
};

// 3. Execute script
fetch('/api/execute_script/', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token'
  },
  body: JSON.stringify({
    class_name: 'ac75',
    script_name: '0_map.py',
    parameters: {
      input_file: 'data.csv',
      output_format: 'json'
    }
  })
})
.then(response => response.json())
.then(data => {
  console.log('Execution result:', data);
});
```

### Simple Data Fetching

```javascript
fetch('/api/fetch_data/', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token'
  },
  body: JSON.stringify({
    class_name: 'ac75',
    script_name: 'data_processor.py',
    parameters: {
      input_file: 'data.csv'
    }
  })
})
.then(response => response.json())
.then(data => {
  if (data.success) {
    console.log('Data:', data.data);
  } else {
    console.error('Error:', data.message);
  }
});
```

## Support

For support and questions, please contact the development team or refer to the server logs for detailed error information.
