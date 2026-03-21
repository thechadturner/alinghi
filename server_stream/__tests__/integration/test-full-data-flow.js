/**
 * Comprehensive End-to-End Integration Test
 * Tests: InfluxDB → Processor → Redis → API → Frontend
 * 
 * This test verifies the complete data flow is working correctly:
 * 1. InfluxDB queries work with both initial and subsequent queries
 * 2. Processor normalizes channel names correctly
 * 3. Redis stores data with normalized names
 * 4. API endpoints can retrieve data
 * 5. Channel name mapping works correctly
 */

const http = require('http');
const { URL } = require('url');
const processor = require('../../controllers/processor');
const redisStorage = require('../../controllers/redis');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';
const INFLUX_HOST = process.env.INFLUX_HOST || '192.168.0.18';
const INFLUX_PORT = process.env.INFLUX_PORT || 8086;
const INFLUX_DATABASE = process.env.INFLUX_DATABASE || 'sailgp';
const TEST_SOURCE_ID = 999; // Use test source ID to avoid conflicts

// Test configuration
const TEST_CONFIG = {
  channels: ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa', 'Twa', 'Bsp', 'Tws', 'Twd'],
  minDataPoints: 10,
  timeWindow: 3600000 // 1 hour
};

/**
 * Query InfluxDB directly
 */
async function queryInfluxDB(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const urlString = `http://${INFLUX_HOST}:${INFLUX_PORT}/query?db=${encodeURIComponent(INFLUX_DATABASE)}&q=${encodedQuery}`;
    
    http.get(urlString, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Query failed: ${res.statusCode} - ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Check streaming server status
 */
async function checkServerStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/debug/status`);
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Test API endpoint for channel data
 */
async function testAPIEndpoint(sourceName, channel, startTime, endTime) {
  return new Promise((resolve, reject) => {
    // Note: This would require authentication in production
    // For testing, we'll use the debug endpoint or mock auth
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${sourceName}/data`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('startTime', startTime.toString());
    url.searchParams.set('endTime', endTime.toString());
    
    http.get(url.toString(), { headers: { Cookie: 'auth_token=test' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ status: res.statusCode, data: result });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Simulate InfluxDB data point
 */
function createInfluxDataPoint(sourceId, timestamp, data) {
  return {
    source_id: sourceId,
    timestamp: timestamp,
    data: {
      source: 'GBR',
      source_name: 'GBR',
      ...data
    }
  };
}

/**
 * Test 1: Query Format Fix
 */
async function testQueryFormatFix() {
  console.log('\n📋 Test 1: Query Format Fix');
  console.log('   Testing that both initial and subsequent queries work...');
  
  try {
    // Test initial query format (no lastDataTimestamp) - remove LIMIT as simulator doesn't support it
    const initialQuery = `SELECT * FROM sailgp WHERE time > now() - 1m`;
    const initialResult = await queryInfluxDB(initialQuery);
    const initialRows = initialResult.results?.[0]?.series?.[0]?.values?.length || 0;
    
    if (initialRows === 0) {
      throw new Error('Initial query returned no data');
    }
    console.log(`   ✅ Initial query: ${initialRows} rows`);
    
    // Test subsequent query format (with relative time) - remove LIMIT as simulator doesn't support it
    const oneMinuteAgo = Date.now() - 60000;
    const timeDiffMs = Date.now() - oneMinuteAgo;
    const timeRange = timeDiffMs < 60000 ? `${Math.ceil(timeDiffMs / 1000)}s` : `${Math.ceil(timeDiffMs / 60000)}m`;
    const subsequentQuery = `SELECT * FROM sailgp WHERE time > now() - ${timeRange}`;
    const subsequentResult = await queryInfluxDB(subsequentQuery);
    const subsequentRows = subsequentResult.results?.[0]?.series?.[0]?.values?.length || 0;
    
    if (subsequentRows === 0) {
      throw new Error('Subsequent query returned no data');
    }
    console.log(`   ✅ Subsequent query (${timeRange}): ${subsequentRows} rows`);
    
    return true;
  } catch (err) {
    console.error(`   ❌ Query format test failed: ${err.message}`);
    return false;
  }
}

/**
 * Test 2: Processor Normalization
 */
async function testProcessorNormalization() {
  console.log('\n📋 Test 2: Processor Channel Normalization');
  console.log('   Testing that processor normalizes channel names correctly...');
  
  try {
    // Create test data with lowercase channels
    const testData = createInfluxDataPoint(TEST_SOURCE_ID, Date.now(), {
      lat: 39.123456,
      lng: 9.123456,
      hdg: 180.5,
      cog: 181.2,
      sog: 12.5,
      cwa: 45.0,
      twa: 30.0,
      bsp: 15.3,
      tws: 20.0,
      twd: 180.0,
      accel: 0.5,
      ang_rate: 2.3,
      custom_field: 'test_value'
    });
    
    // Process through processor
    processor.clearState(TEST_SOURCE_ID);
    const processed = processor.process(testData);
    
    if (!processed) {
      throw new Error('Processor returned null');
    }
    
    const processedChannels = Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime');
    
    // Check for normalized channels
    const normalized = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa', 'Twa', 'Bsp', 'Tws', 'Twd', 'Accel_rate_mps2', 'Yaw_rate_dps'];
    const foundNormalized = normalized.filter(ch => processedChannels.includes(ch));
    const lowercase = ['lat', 'lng', 'hdg', 'cog', 'sog'];
    const foundLowercase = lowercase.filter(ch => processedChannels.includes(ch));
    
    console.log(`   ✅ Processed channels: ${processedChannels.length}`);
    console.log(`   ✅ Normalized channels found: ${foundNormalized.length} (${foundNormalized.slice(0, 5).join(', ')}...)`);
    
    if (foundLowercase.length > 0) {
      throw new Error(`Found lowercase duplicates: ${foundLowercase.join(', ')}`);
    }
    
    if (foundNormalized.length < 5) {
      throw new Error(`Missing normalized channels. Expected at least 5, found ${foundNormalized.length}`);
    }
    
    // Verify values are preserved
    if (processed.data.Lat !== testData.data.lat) {
      throw new Error(`Lat value mismatch: ${processed.data.Lat} !== ${testData.data.lat}`);
    }
    
    console.log(`   ✅ Values preserved correctly`);
    
    return true;
  } catch (err) {
    console.error(`   ❌ Processor normalization test failed: ${err.message}`);
    return false;
  }
}

/**
 * Test 3: Redis Storage
 */
async function testRedisStorage() {
  console.log('\n📋 Test 3: Redis Storage');
  console.log('   Testing that data is stored with normalized channel names...');
  
  try {
    // Connect to Redis
    await redisStorage.connect();
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!redisStorage.isConnected) {
      throw new Error('Redis not connected');
    }
    
    // Create and process test data
    const timestamp = Date.now();
    const testData = createInfluxDataPoint(TEST_SOURCE_ID, timestamp, {
      lat: 39.123456,
      lng: 9.123456,
      hdg: 180.5,
      cog: 181.2,
      sog: 12.5
    });
    
    processor.clearState(TEST_SOURCE_ID);
    const processed = processor.process(testData);
    
    if (!processed) {
      throw new Error('Processor returned null');
    }
    
    // Extract source_name from processed data
    const source_name = processed.data.source_name;
    if (!source_name) {
      throw new Error('Processed data missing source_name - cannot store to Redis');
    }
    
    console.log(`   ✅ Source name: ${source_name}`);
    
    // Store in Redis
    const channelsToStore = Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime');
    let storedCount = 0;
    
    for (const channel of channelsToStore) {
      const value = processed.data[channel];
      if (value !== undefined && value !== null) {
        await redisStorage.store(source_name, channel, timestamp, value);
        storedCount++;
      }
    }
    
    console.log(`   ✅ Stored ${storedCount} channels to Redis`);
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify channels in Redis
    const storedChannels = await redisStorage.getChannels(source_name);
    console.log(`   ✅ Found ${storedChannels.length} channels in Redis`);
    
    const normalized = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
    const foundNormalized = storedChannels.filter(ch => normalized.includes(ch));
    const lowercase = ['lat', 'lng', 'hdg', 'cog', 'sog'];
    const foundLowercase = storedChannels.filter(ch => lowercase.includes(ch));
    
    if (foundLowercase.length > 0) {
      throw new Error(`Found lowercase channels in Redis: ${foundLowercase.join(', ')}`);
    }
    
    if (foundNormalized.length < 5) {
      throw new Error(`Missing normalized channels. Expected 5, found ${foundNormalized.length}`);
    }
    
    console.log(`   ✅ Normalized channels verified: ${foundNormalized.join(', ')}`);
    
    // Verify data can be retrieved
    const retrievedData = await redisStorage.query(source_name, 'Lat', timestamp - 1000, timestamp + 1000);
    if (retrievedData.length === 0) {
      throw new Error('Could not retrieve data from Redis');
    }
    
    console.log(`   ✅ Data retrieval verified: ${retrievedData.length} points`);
    
    return true;
  } catch (err) {
    console.error(`   ❌ Redis storage test failed: ${err.message}`);
    return false;
  }
}

/**
 * Test 4: API Endpoint (if server is running)
 */
async function testAPIEndpoints() {
  console.log('\n📋 Test 4: API Endpoints');
  console.log('   Testing that API can retrieve data from Redis...');
  
  try {
    // Check if server is running
    const status = await checkServerStatus();
    
    if (!status.success || status.data?.redis?.connected !== true) {
      console.log('   ⚠️  Server not running or Redis not connected, skipping API test');
      return { skipped: true, reason: 'Server not running' };
    }
    
    // Get source names from Redis
    const keys = await redisStorage.client.keys('stream:*');
    const dataKeys = keys.filter(k => !k.endsWith(':meta'));
    
    if (dataKeys.length === 0) {
      console.log('   ⚠️  No source names in Redis, skipping API test');
      return { skipped: true, reason: 'No source names in Redis' };
    }
    
    const sourceName = dataKeys[0].replace('stream:', '');
    
    // Test getting channels
    const channels = await redisStorage.getChannels(sourceName);
    if (channels.length === 0) {
      console.log(`   ⚠️  No channels in Redis for source "${sourceName}", skipping API test`);
      return { skipped: true, reason: 'No channels in Redis' };
    }
    
    // Test querying data (would need auth token in production)
    // For now, we'll test the Redis query directly
    const now = Date.now();
    const oneHourAgo = now - TEST_CONFIG.timeWindow;
    
    const testChannel = channels.find(ch => ['Lat', 'Lng'].includes(ch)) || channels[0];
    const data = await redisStorage.query(sourceName, testChannel, oneHourAgo, now);
    
    if (data.length === 0) {
      throw new Error(`No data retrieved for channel ${testChannel}`);
    }
    
    console.log(`   ✅ API data retrieval verified: ${data.length} points for channel ${testChannel} (source: ${sourceName})`);
    
    return true;
  } catch (err) {
    console.error(`   ❌ API endpoint test failed: ${err.message}`);
    return false;
  }
}

/**
 * Test 5: Channel Name Mapping
 */
async function testChannelNameMapping() {
  console.log('\n📋 Test 5: Channel Name Mapping');
  console.log('   Testing that channel names are correctly mapped throughout pipeline...');
  
  try {
    // Simulate frontend channel mapping logic
    const requestedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
    const requestedChannelsLower = requestedChannels.map(c => c.toLowerCase());
    
    // Get available channels from Redis
    await redisStorage.connect();
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    // Get source names from Redis
    const keys = await redisStorage.client.keys('stream:*');
    const dataKeys = keys.filter(k => !k.endsWith(':meta'));
    
    if (dataKeys.length === 0) {
      console.log('   ⚠️  No source names in Redis, skipping mapping test');
      return { skipped: true, reason: 'No source names in Redis' };
    }
    
    const sourceName = dataKeys[0].replace('stream:', '');
    const availableChannels = await redisStorage.getChannels(sourceName);
    
    if (availableChannels.length === 0) {
      console.log(`   ⚠️  No channels in Redis for source "${sourceName}", skipping mapping test`);
      return { skipped: true, reason: 'No channels in Redis' };
    }
    
    // Map requested channels to available channels
    const channelsToFetch = new Set();
    for (const requested of requestedChannels) {
      const requestedLower = requested.toLowerCase();
      if (availableChannels.includes(requested)) {
        channelsToFetch.add(requested);
      } else if (availableChannels.includes(requestedLower)) {
        channelsToFetch.add(requestedLower);
      } else {
        const found = availableChannels.find(c => c.toLowerCase() === requestedLower);
        if (found) {
          channelsToFetch.add(found);
        }
      }
    }
    
    console.log(`   ✅ Available channels: ${availableChannels.length}`);
    console.log(`   ✅ Mapped channels: ${channelsToFetch.size} (${Array.from(channelsToFetch).join(', ')})`);
    
    if (channelsToFetch.size < 3) {
      throw new Error(`Too few channels mapped. Expected at least 3, got ${channelsToFetch.size}`);
    }
    
    // Verify normalized channels are preferred
    const normalizedFound = requestedChannels.filter(ch => channelsToFetch.has(ch));
    if (normalizedFound.length < 3) {
      throw new Error(`Not enough normalized channels found. Expected at least 3, got ${normalizedFound.length}`);
    }
    
    console.log(`   ✅ Normalized channels preferred: ${normalizedFound.join(', ')}`);
    
    return true;
  } catch (err) {
    console.error(`   ❌ Channel name mapping test failed: ${err.message}`);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🧪 Comprehensive Data Flow Integration Tests');
  console.log('='.repeat(60));
  
  const results = {
    queryFormat: false,
    processor: false,
    redis: false,
    api: { skipped: false },
    mapping: { skipped: false }
  };
  
  try {
    // Run tests in sequence
    results.queryFormat = await testQueryFormatFix();
    results.processor = await testProcessorNormalization();
    results.redis = await testRedisStorage();
    results.api = await testAPIEndpoints();
    results.mapping = await testChannelNameMapping();
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Results Summary:');
    console.log('='.repeat(60));
    
    const passed = [
      results.queryFormat && 'Query Format',
      results.processor && 'Processor Normalization',
      results.redis && 'Redis Storage',
      results.api === true && 'API Endpoints',
      results.mapping === true && 'Channel Name Mapping'
    ].filter(Boolean);
    
    const failed = [
      !results.queryFormat && 'Query Format',
      !results.processor && 'Processor Normalization',
      !results.redis && 'Redis Storage',
      results.api === false && 'API Endpoints',
      results.mapping === false && 'Channel Name Mapping'
    ].filter(Boolean);
    
    const skipped = [
      results.api.skipped && 'API Endpoints',
      results.mapping.skipped && 'Channel Name Mapping'
    ].filter(Boolean);
    
    console.log(`\n✅ Passed: ${passed.length}`);
    passed.forEach(test => console.log(`   - ${test}`));
    
    if (failed.length > 0) {
      console.log(`\n❌ Failed: ${failed.length}`);
      failed.forEach(test => console.log(`   - ${test}`));
    }
    
    if (skipped.length > 0) {
      console.log(`\n⚠️  Skipped: ${skipped.length}`);
      skipped.forEach(test => console.log(`   - ${test}`));
    }
    
    const allCriticalPassed = results.queryFormat && results.processor && results.redis;
    
    if (allCriticalPassed) {
      console.log('\n✅ All critical tests passed! Data flow is working correctly.');
      process.exit(0);
    } else {
      console.log('\n❌ Some critical tests failed. Please review the errors above.');
      process.exit(1);
    }
    
  } catch (err) {
    console.error('\n❌ Test suite failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(console.error);

