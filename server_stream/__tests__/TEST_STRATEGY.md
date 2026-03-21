# Test Strategy for Streaming Data Flow

## Overview

This document outlines the comprehensive test strategy to ensure the streaming data pipeline is bulletproof. The tests cover the complete flow from InfluxDB queries through data processing, storage, and retrieval.

## Test Coverage Matrix

| Component | Unit Tests | Integration Tests | E2E Tests |
|-----------|-----------|-------------------|----------|
| InfluxDB Query Format | ✅ | ✅ | ✅ |
| Processor Normalization | ✅ | ✅ | ✅ |
| Redis Storage | ✅ | ✅ | ✅ |
| API Endpoints | ❌ | ✅ | ✅ |
| Frontend Retrieval | ✅ | ❌ | ✅ |
| Channel Mapping | ✅ | ✅ | ✅ |

## Test Categories

### 1. Unit Tests
**Location**: `server_stream/__tests__/test-processor.js`

**Purpose**: Test individual components in isolation

**Coverage**:
- Processor channel normalization logic
- Derived channel computation (TACK, POINTOFSAIL, MANEUVER_TYPE)
- CWA-based maneuver detection
- Value preservation through processing

**Run**: `npm run test:streaming:processor`

### 2. Integration Tests
**Location**: `server_stream/__tests__/integration/`

**Purpose**: Test component interactions

**Coverage**:
- InfluxDB → Processor → Redis flow
- Query format scenarios (initial vs subsequent)
- Channel normalization pipeline
- Data integrity through pipeline
- API endpoint data retrieval

**Run**: `npm run test:streaming:integration:all`

### 3. End-to-End Tests
**Location**: `server_stream/__tests__/integration/test-full-data-flow.js`

**Purpose**: Test complete system behavior

**Coverage**:
- Full pipeline: InfluxDB → Processor → Redis → API → Frontend
- Real-world scenarios
- Error handling and recovery
- Performance under load

**Run**: `npm run test:streaming:integration:full`

## Critical Test Scenarios

### Scenario 1: Query Format Fix
**Problem**: After first data point, queries used nanoseconds which simulator doesn't support

**Test**: `test-query-format-scenarios.js`
- ✅ Initial query (no previous data) works
- ✅ Subsequent queries use relative time strings
- ✅ All time ranges (seconds, minutes, hours) work correctly

### Scenario 2: Channel Normalization
**Problem**: Channels stored with inconsistent names (lowercase vs normalized)

**Test**: `test-channel-normalization-pipeline.js`
- ✅ Processor normalizes channel names
- ✅ Redis stores normalized names only
- ✅ No lowercase duplicates in Redis
- ✅ Frontend can map and retrieve channels

### Scenario 3: Data Integrity
**Problem**: Data values lost or corrupted during processing

**Test**: `test-processor-redis.js`
- ✅ Values preserved through processor
- ✅ Values stored correctly in Redis
- ✅ Values retrieved correctly from Redis

### Scenario 4: Real Data Flow
**Problem**: Simulated data works but real InfluxDB stream doesn't

**Test**: `test-influx-stream-to-redis.js`
- ✅ Real InfluxDB queries return data
- ✅ Data flows through processor
- ✅ Data stored in Redis
- ✅ Normalized channel names in Redis

## Test Execution Strategy

### Development Workflow
1. **Before committing**: Run unit tests
   ```bash
   npm run test:streaming:processor
   ```

2. **Before pushing**: Run integration tests
   ```bash
   npm run test:streaming:integration:all
   ```

3. **Before deploying**: Run full test suite
   ```bash
   npm run test:streaming:integration:all
   npm run test:streaming  # Frontend tests
   ```

### CI/CD Pipeline
1. Run unit tests (fast, no dependencies)
2. Run integration tests (requires Redis, InfluxDB)
3. Run E2E tests (requires full stack)
4. Report results and block on failures

## Test Data Management

### Test Source IDs
- `999`: Full data flow tests
- `888`: Channel normalization tests
- `777`: Query format tests

These IDs are isolated from production data to avoid conflicts.

### Test Data Cleanup
Tests should clean up after themselves:
- Clear processor state
- Optionally flush test data from Redis (if needed)

## Success Criteria

### All Tests Must Pass
- ✅ Query format fix works for all time ranges
- ✅ Processor normalizes all expected channels
- ✅ Redis stores only normalized channel names
- ✅ No lowercase duplicates in Redis
- ✅ Data can be retrieved via API
- ✅ Frontend can map and fetch channels correctly

### Performance Requirements
- Processor: < 10ms per data point
- Redis storage: < 5ms per channel
- API retrieval: < 100ms for 1 hour of data

### Data Integrity
- Values preserved through entire pipeline
- Timestamps accurate
- No data loss or corruption
- Channel names consistent

## Failure Scenarios

### Test Failures and Solutions

#### "Query failed: 400 - Invalid query"
**Cause**: Query format issue
**Solution**: Verify query uses `now() - X` format, not nanoseconds

#### "No channels in Redis"
**Cause**: Data not flowing or not being stored
**Solution**: 
1. Check InfluxDB source is querying
2. Verify processor is processing
3. Check Redis storage is working

#### "Found lowercase channels in Redis"
**Cause**: Processor not normalizing or storage using wrong names
**Solution**: 
1. Verify processor normalization logic
2. Check storage uses processed.data, not original data

#### "Channel mapping failed"
**Cause**: Frontend can't find channels
**Solution**:
1. Verify available channels API returns correct names
2. Check frontend mapping logic
3. Ensure case-insensitive matching works

## Continuous Improvement

### Test Coverage Goals
- [ ] 100% coverage of processor normalization logic
- [ ] 100% coverage of query format scenarios
- [ ] 100% coverage of channel mapping
- [ ] 90%+ coverage of Redis storage operations

### Test Maintenance
- Update tests when adding new channels
- Update tests when changing normalization rules
- Add tests for new error scenarios
- Performance benchmarks for regression detection

## Monitoring

### Production Monitoring
- Track query success rate
- Monitor Redis storage operations
- Alert on channel name mismatches
- Track data flow latency

### Test Metrics
- Test execution time
- Test pass rate
- Coverage percentage
- Flaky test detection

## Conclusion

This comprehensive test strategy ensures the streaming data pipeline is bulletproof by:
1. Testing each component in isolation
2. Testing component interactions
3. Testing end-to-end flows
4. Covering critical scenarios
5. Validating data integrity
6. Ensuring performance requirements

All tests are automated and can be run as part of CI/CD pipelines to catch issues before they reach production.

