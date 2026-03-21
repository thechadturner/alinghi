# Integration Tests for Streaming Data Flow

This directory contains comprehensive integration tests for the streaming data pipeline.

## Test Suite Overview

### 1. Full Data Flow Test (`test-full-data-flow.js`)
**Purpose**: End-to-end test of the complete data pipeline

**Tests**:
- ✅ Query format fix (initial vs subsequent queries)
- ✅ Processor channel normalization
- ✅ Redis storage with normalized names
- ✅ API endpoint data retrieval (if server running)
- ✅ Channel name mapping throughout pipeline

**Run**: `npm run test:streaming:integration:full`

### 2. Query Format Scenarios (`test-query-format-scenarios.js`)
**Purpose**: Verify query format fix works for various time ranges

**Tests**:
- Initial query (no previous data)
- 10 seconds ago
- 30 seconds ago
- 1 minute ago
- 5 minutes ago
- 15 minutes ago
- 1 hour ago
- 2 hours ago

**Run**: `npm run test:streaming:integration:queries`

### 3. Channel Normalization Pipeline (`test-channel-normalization-pipeline.js`)
**Purpose**: Verify channel names are normalized correctly at each stage

**Tests**:
- Stage 1: Processor normalization (lowercase → normalized)
- Stage 2: Redis storage (normalized names stored)
- Stage 3: Data retrieval (normalized names retrieved)

**Run**: `npm run test:streaming:integration:channels`

### 4. Processor → Redis Integration (`test-processor-redis.js`)
**Purpose**: Verify processor output is correctly stored in Redis

**Tests**:
- Simulated InfluxDB data → Processor → Redis
- Channel name normalization
- Data integrity
- Value preservation

**Run**: `npm run test:streaming:integration` (includes this test)

### 5. InfluxDB Stream → Redis (`test-influx-stream-to-redis.js`)
**Purpose**: Monitor actual InfluxDB stream and verify data reaches Redis

**Tests**:
- Real InfluxDB queries
- Data flow monitoring
- Redis storage verification

**Run**: `npm run test:streaming:integration` (includes this test)

## Running All Tests

To run all integration tests in sequence:

```bash
npm run test:streaming:integration:all
```

This will:
1. Run all tests in sequence
2. Report results for each test
3. Provide a summary at the end
4. Exit with code 0 if all pass, 1 if any fail

## Individual Test Execution

You can also run tests individually:

```bash
# Full data flow test
npm run test:streaming:integration:full

# Query format scenarios
npm run test:streaming:integration:queries

# Channel normalization pipeline
npm run test:streaming:integration:channels

# Original integration tests
npm run test:streaming:integration
```

## Prerequisites

1. **Redis**: Must be running and accessible
   - Default: `localhost:6379`
   - Can be configured via `REDIS_HOST` and `REDIS_PORT` environment variables

2. **InfluxDB Simulator**: Must be running and accessible
   - Default: `192.168.0.18:8086`
   - Can be configured via `INFLUX_HOST` and `INFLUX_PORT` environment variables

3. **Streaming Server** (optional): For API endpoint tests
   - Default: `http://localhost:8099`
   - Can be configured via `STREAM_SERVER_URL` environment variable
   - API tests will be skipped if server is not running

## Test Data

Tests use source ID `999` and `888` to avoid conflicts with production data. These test sources are cleaned up after tests complete.

## Expected Results

All tests should pass when:
- ✅ Query format fix is working (uses `now() - X` instead of nanoseconds)
- ✅ Processor normalizes channel names correctly
- ✅ Redis stores data with normalized names
- ✅ No lowercase duplicates in Redis
- ✅ Data can be retrieved via API endpoints

## Troubleshooting

### Tests Fail with "Redis not connected"
- Ensure Redis is running: `docker ps` (if using Docker)
- Check Redis connection: `redis-cli ping`
- Verify environment variables: `REDIS_HOST`, `REDIS_PORT`

### Tests Fail with "Query failed: 400"
- Check InfluxDB simulator is running
- Verify `INFLUX_HOST` and `INFLUX_PORT` are correct
- Test query manually: `http://INFLUX_HOST:INFLUX_PORT/query?db=sailgp&q=SELECT * FROM sailgp WHERE time > now() - 1m LIMIT 1`

### Tests Show "No channels in Redis"
- Data may not be flowing from InfluxDB
- Check streaming server logs
- Verify InfluxDB source is querying successfully
- Ensure processor is processing data correctly

### Channel Normalization Tests Fail
- Verify processor is using normalized channel names
- Check Redis keys: `redis-cli KEYS "stream:*"`
- Ensure no lowercase duplicates are being stored

## Continuous Integration

These tests are designed to be run in CI/CD pipelines. They:
- Exit with appropriate codes (0 = success, 1 = failure)
- Provide clear error messages
- Can be run in parallel (use different test source IDs)
- Don't require authentication (use debug endpoints or direct Redis access)

