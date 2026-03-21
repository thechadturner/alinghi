# Streaming Server Tests

This directory contains tests for the streaming server components.

## Test Structure

### Integration Tests (`integration/`)

End-to-end tests that verify the full data flow:

- **`test-processor-redis.js`** - Tests Processor → Redis flow
  - Simulates InfluxDB data with lowercase channel names
  - Verifies processor normalizes channel names
  - Verifies normalized channels are stored in Redis
  - Verifies data values match what was stored
  - **Run:** `node server_stream/__tests__/integration/test-processor-redis.js`

- **`test-influx-stream-to-redis.js`** - Tests ACTUAL InfluxDB → Processor → Redis flow
  - Monitors real InfluxDB streaming data
  - Verifies normalized channel names are stored in Redis
  - Checks for lowercase duplicates
  - **Run:** `node server_stream/__tests__/integration/test-influx-stream-to-redis.js`

- **`test-redis-to-indexeddb.js`** - Tests Redis → IndexedDB Storage flow
  - Verifies data can be fetched from Redis via API
  - Verifies storage logic uses `dataset_id = 0` in live mode
  - Verifies data structure is correct for IndexedDB storage
  - **Run:** `node server_stream/__tests__/integration/test-redis-to-indexeddb.js`

### Unit Tests

- **`test-processor.js`** - Tests processor logic in isolation
  - Channel name normalization
  - CWA-based maneuver detection (tack, gybe, bear away, round up)
  - TACK and POINTOFSAIL computation
  - **Run:** `node server_stream/__tests__/test-processor.js`

### Diagnostic Scripts

Tools for debugging and diagnosing issues:

- **`diagnose-streaming.js`** - General streaming server diagnostics
- **`diagnose-influx-query.js`** - InfluxDB query diagnostics
- **`debug-data-flow.js`** - Data flow debugging
- **`test-redis-channels.js`** - Check what channels are in Redis
- **`test-redis-new-data.js`** - Check if new data is being stored

## Running Tests

### Prerequisites

1. Redis must be running
2. For integration tests with actual InfluxDB data:
   - InfluxDB simulator must be running
   - Streaming server must be running
   - Active connections must exist
3. For Redis to IndexedDB test:
   - Redis must be running
   - Streaming server should be running (for API endpoints)

### Run All Integration Tests

```bash
# From project root
node server_stream/__tests__/integration/test-processor-redis.js
node server_stream/__tests__/integration/test-influx-stream-to-redis.js
node server_stream/__tests__/integration/test-redis-to-indexeddb.js
```

### Run Unit Tests

```bash
node server_stream/__tests__/test-processor.js
```

## Test Requirements

- **Redis**: Must be running and accessible
- **Processor**: Tests processor normalization logic
- **Redis Storage**: Tests that normalized channel names are stored correctly

## Expected Results

### Processor → Redis Test

Should verify:
- ✅ All lowercase channels normalized (`lat` → `Lat`, etc.)
- ✅ No lowercase duplicates in processed data
- ✅ Normalized channels stored in Redis
- ✅ No lowercase channels in Redis
- ✅ Data values match what was stored

### InfluxDB Stream → Redis Test

Should verify:
- ✅ Real data flows from InfluxDB
- ✅ Channels are normalized before storage
- ✅ Only normalized channel names in Redis
- ✅ Recent data is being stored

### Redis → IndexedDB Test

Should verify:
- ✅ Data can be fetched from Redis via API
- ✅ Storage logic uses `dataset_id = 0` in live mode
- ✅ Data structure is correct for IndexedDB storage
- ✅ Required fields (timestamp, Datetime, source_name) are present
- ✅ Map channels (Lat, Lng, Hdg, Bsp, Maneuver_type) are present
- ✅ Data is sorted by timestamp

## Notes

- Tests use source ID `999` to avoid conflicts with real data
- Tests clean up after themselves (or rely on Redis retention)
- Some tests require active InfluxDB connections

