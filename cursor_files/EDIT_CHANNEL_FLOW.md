# Edit Channel Data Flow Diagram

## Request Flow

```
┌─────────────────┐
│   Client App    │
│  (Frontend/API) │
└────────┬────────┘
         │
         │ POST /api/edit-channel-data
         │ {project_id, class_name, date, source_name,
         │  channel_name, start_ts, end_ts, channel_value}
         │
         ▼
┌─────────────────────────────────────────────────────┐
│            File Server (Express)                     │
│  ┌───────────────────────────────────────────────┐ │
│  │  1. Authentication Middleware                  │ │
│  │     - Verify JWT token                         │ │
│  └───────────────┬───────────────────────────────┘ │
│                  │                                   │
│  ┌───────────────▼───────────────────────────────┐ │
│  │  2. Validation Middleware                      │ │
│  │     - Check all required parameters            │ │
│  │     - Sanitize inputs                          │ │
│  └───────────────┬───────────────────────────────┘ │
│                  │                                   │
│  ┌───────────────▼───────────────────────────────┐ │
│  │  3. Controller: editChannelData                │ │
│  │     - Check write permissions                  │ │
│  │     - Resolve source path                      │ │
│  │     - Find parquet files                       │ │
│  └───────────────┬───────────────────────────────┘ │
│                  │                                   │
└──────────────────┼───────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│      Parquet Editor (parquet_editor.js)             │
│  ┌───────────────────────────────────────────────┐ │
│  │  editChannelInParquetFiles()                   │ │
│  │                                                 │ │
│  │  For each parquet file:                        │ │
│  │  ┌─────────────────────────────────────────┐  │ │
│  │  │ 1. Read all rows                         │  │ │
│  │  │    - readParquetFile()                   │  │ │
│  │  └─────────────┬───────────────────────────┘  │ │
│  │                │                                │ │
│  │  ┌─────────────▼───────────────────────────┐  │ │
│  │  │ 2. Check if channel exists              │  │ │
│  │  │    - Skip if channel not in file        │  │ │
│  │  └─────────────┬───────────────────────────┘  │ │
│  │                │                                │ │
│  │  ┌─────────────▼───────────────────────────┐  │ │
│  │  │ 3. Filter rows by timestamp             │  │ │
│  │  │    - normalizeTimestamp()               │  │ │
│  │  │    - Check: start_ts <= ts <= end_ts    │  │ │
│  │  └─────────────┬───────────────────────────┘  │ │
│  │                │                                │ │
│  │  ┌─────────────▼───────────────────────────┐  │ │
│  │  │ 4. Modify matching rows                 │  │ │
│  │  │    - Set channel_value for each row     │  │ │
│  │  └─────────────┬───────────────────────────┘  │ │
│  │                │                                │ │
│  │  ┌─────────────▼───────────────────────────┐  │ │
│  │  │ 5. Write back to file                   │  │ │
│  │  │    - Create backup (.backup)            │  │ │
│  │  │    - inferSchemaFromRows()              │  │ │
│  │  │    - writeParquetFile()                 │  │ │
│  │  │    - Remove backup on success           │  │ │
│  │  └─────────────────────────────────────────┘  │ │
│  │                                                 │ │
│  └───────────────┬─────────────────────────────────┘ │
│                  │                                   │
│                  │ Return results                    │
│                  │ {filesModified, rowsModified,     │
│                  │  filesProcessed}                  │
└──────────────────┼───────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│              Response to Client                      │
│  {                                                   │
│    "success": true,                                  │
│    "message": "Channel data updated successfully",  │
│    "data": {                                         │
│      "filesModified": 3,                             │
│      "rowsModified": 1250,                           │
│      "filesProcessed": 5                             │
│    }                                                 │
│  }                                                   │
└─────────────────────────────────────────────────────┘
```

## File System Structure

```
DATA_DIRECTORY/
└── System/
    └── {project_id}/
        └── {class_name}/
            └── {date}/
                └── {source_name}/
                    ├── file1.parquet
                    ├── file2.parquet
                    ├── file3.parquet
                    └── ...
```

## Parquet File Processing

```
┌─────────────────────────────────────────────────────────┐
│                    Parquet File                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Row 1: ts=1739404700, tws=12.5, twa=45, ...       │ │ ← Before time range
│  │ Row 2: ts=1739404800, tws=13.2, twa=46, ...       │ │ ← START: Modified ✓
│  │ Row 3: ts=1739404900, tws=14.1, twa=47, ...       │ │ ← Modified ✓
│  │ Row 4: ts=1739405000, tws=15.3, twa=48, ...       │ │ ← Modified ✓
│  │ Row 5: ts=1739408400, tws=16.2, twa=49, ...       │ │ ← END: Modified ✓
│  │ Row 6: ts=1739408500, tws=17.1, twa=50, ...       │ │ ← After time range
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
                           │ Edit channel "tws" to 15.5
                           │ for ts between 1739404800 and 1739408400
                           ▼
┌─────────────────────────────────────────────────────────┐
│              Modified Parquet File                       │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Row 1: ts=1739404700, tws=12.5, twa=45, ...       │ │ ← Unchanged
│  │ Row 2: ts=1739404800, tws=15.5, twa=46, ...       │ │ ← Changed ✓
│  │ Row 3: ts=1739404900, tws=15.5, twa=47, ...       │ │ ← Changed ✓
│  │ Row 4: ts=1739405000, tws=15.5, twa=48, ...       │ │ ← Changed ✓
│  │ Row 5: ts=1739408400, tws=15.5, twa=49, ...       │ │ ← Changed ✓
│  │ Row 6: ts=1739408500, tws=17.1, twa=50, ...       │ │ ← Unchanged
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Error Handling Flow

```
┌─────────────────┐
│  Request Start  │
└────────┬────────┘
         │
         ▼
    ┌─────────┐
    │Validate │──────────────────┐
    └────┬────┘                  │
         │ Valid                 │ Invalid
         ▼                       ▼
    ┌──────────┐           ┌─────────┐
    │Check Auth│           │400 Error│
    └────┬─────┘           └─────────┘
         │ Authorized
         │ Unauthorized
         ▼                       ▼
    ┌──────────┐           ┌─────────┐
    │Check Perm│           │403 Error│
    └────┬─────┘           └─────────┘
         │ Has Write
         │ No Write
         ▼                       ▼
    ┌──────────┐           ┌─────────┐
    │Find Path │           │404 Error│
    └────┬─────┘           └─────────┘
         │ Exists
         │ Not Found
         ▼                       ▼
    ┌──────────┐           ┌─────────┐
    │Find Files│           │404 Error│
    └────┬─────┘           └─────────┘
         │ Files Found
         │ No Files
         ▼
    ┌──────────┐
    │Edit Files│
    └────┬─────┘
         │ Success
         │ Error
         ▼                       ▼
    ┌──────────┐           ┌─────────┐
    │200 OK    │           │500 Error│
    └──────────┘           └─────────┘
```

## Backup and Recovery

```
Original File                Backup Created              Write New File
┌──────────┐                ┌──────────┐                ┌──────────┐
│file.     │   Copy          │file.     │   Write        │file.     │
│parquet   │───────────────▶ │parquet   │───────────────▶│parquet   │
│          │                 │.backup   │                │(modified)│
└──────────┘                └──────────┘                └──────────┘
                                   │                           │
                                   │ Success                   │ Success
                                   ▼                           ▼
                            ┌──────────┐                ┌──────────┐
                            │Delete    │                │Complete  │
                            │backup    │                │          │
                            └──────────┘                └──────────┘
                                   │
                                   │ Failure
                                   ▼
                            ┌──────────┐
                            │Restore   │
                            │from      │
                            │backup    │
                            └──────────┘
```

## Security Flow

```
┌─────────────────┐
│  Client Request │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ JWT Token Validation│
│  - Verify signature │
│  - Check expiration │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Permission Check    │
│  - Query database   │
│  - Check write perm │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Input Validation    │
│  - Sanitize inputs  │
│  - Check types      │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Process Request     │
└─────────────────────┘
```
