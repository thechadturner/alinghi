/**
 * End-to-end integration test: InfluxDB data → Processor → Redis → Verification
 * Tests that data flows correctly and normalized channel names are stored
 * 
 * Run with: node server_stream/__tests__/integration/test-processor-redis.js
 */

const processor = require('../../controllers/processor');
const redisStorage = require('../../controllers/redis');
const { log, error } = require('../../../shared');

const testSourceId = 999; // Use a test source ID

async function runTest() {
  console.log('🧪 Starting Processor to Redis Integration Test...\n');
  
  let redisConnected = false;
  
  try {
    // Connect to Redis
    console.log('1. Connecting to Redis...');
    redisConnected = await redisStorage.connect();
    if (!redisConnected) {
      throw new Error('Failed to connect to Redis');
    }
    
    // Wait for connection to be ready (Redis connection is asynchronous)
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!redisStorage.isConnected) {
      throw new Error('Redis connection not ready after 5 seconds');
    }
    
    console.log('   ✅ Connected to Redis\n');
    
    // Clear processor state
    processor.clearState(testSourceId);
    
    // Test 1: Normalize channel names and store in Redis
    console.log('2. Test: Normalize channel names and store in Redis');
    console.log('   Simulating InfluxDB data point (lowercase channels)...');
    
    const influxDataPoint = {
      source_id: testSourceId,
      timestamp: Date.now(),
      data: {
        source: 'TEST',
        source_name: 'TEST',
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
        custom_field: 'test_value',
        another_custom: 123
      }
    };
    
    // Step 1: Process data through processor
    console.log('   Step 1: Processing through processor...');
    const processed = processor.process(influxDataPoint);
    
    if (!processed) {
      throw new Error('Processor returned null');
    }
    
    console.log('   ✅ Processor returned data');
    console.log(`   ✅ Source ID: ${processed.source_id}`);
    console.log(`   ✅ Timestamp: ${processed.timestamp}`);
    
    // Step 2: Verify processor normalized channel names
    console.log('   Step 2: Verifying normalized channel names...');
    const processedData = processed.data;
    
    // Check normalized names exist
    const checks = [
      { name: 'Lat', expected: influxDataPoint.data.lat },
      { name: 'Lng', expected: influxDataPoint.data.lng },
      { name: 'Hdg', expected: influxDataPoint.data.hdg },
      { name: 'Cog', expected: influxDataPoint.data.cog },
      { name: 'Sog', expected: influxDataPoint.data.sog },
      { name: 'Cwa', expected: influxDataPoint.data.cwa },
      { name: 'Twa', expected: influxDataPoint.data.twa },
      { name: 'Bsp', expected: influxDataPoint.data.bsp },
      { name: 'Tws', expected: influxDataPoint.data.tws },
      { name: 'Twd', expected: influxDataPoint.data.twd },
      { name: 'Accel_rate_mps2', expected: influxDataPoint.data.accel },
      { name: 'Yaw_rate_dps', expected: influxDataPoint.data.ang_rate }
    ];
    
    let allChecksPassed = true;
    for (const check of checks) {
      if (processedData[check.name] !== check.expected) {
        console.log(`   ❌ ${check.name}: expected ${check.expected}, got ${processedData[check.name]}`);
        allChecksPassed = false;
      } else {
        console.log(`   ✅ ${check.name}: ${check.expected}`);
      }
    }
    
    // Check lowercase duplicates do NOT exist
    const lowercaseChannels = ['lat', 'lng', 'hdg', 'cog', 'sog', 'cwa', 'twa', 'bsp', 'tws', 'twd'];
    for (const channel of lowercaseChannels) {
      if (processedData.hasOwnProperty(channel)) {
        console.log(`   ❌ Lowercase duplicate found: ${channel}`);
        allChecksPassed = false;
      }
    }
    if (allChecksPassed) {
      console.log('   ✅ No lowercase duplicates found');
    }
    
    // Check custom fields preserved
    if (processedData.custom_field !== 'test_value') {
      console.log(`   ❌ custom_field: expected 'test_value', got ${processedData.custom_field}`);
      allChecksPassed = false;
    } else {
      console.log('   ✅ custom_field preserved');
    }
    
    if (processedData.another_custom !== 123) {
      console.log(`   ❌ another_custom: expected 123, got ${processedData.another_custom}`);
      allChecksPassed = false;
    } else {
      console.log('   ✅ another_custom preserved');
    }
    
    // Check computed channels
    if (!processedData.TACK) {
      console.log('   ❌ TACK not computed');
      allChecksPassed = false;
    } else {
      console.log(`   ✅ TACK: ${processedData.TACK}`);
    }
    
    if (!processedData.POINTOFSAIL) {
      console.log('   ❌ POINTOFSAIL not computed');
      allChecksPassed = false;
    } else {
      console.log(`   ✅ POINTOFSAIL: ${processedData.POINTOFSAIL}`);
    }
    
    if (!allChecksPassed) {
      throw new Error('Processor normalization checks failed');
    }
    
    // Step 3: Extract source_name from processed data
    const source_name = processedData.source_name;
    if (!source_name) {
      throw new Error('Processed data missing source_name - cannot store to Redis');
    }
    
    console.log(`   ✅ Source name: ${source_name}`);
    
    // Step 4: Store processed data in Redis
    console.log('\n   Step 4: Storing processed data in Redis...');
    const channelsToStore = Object.keys(processedData).filter(k => k !== 'timestamp' && k !== 'Datetime');
    
    let storedCount = 0;
    let errorCount = 0;
    
    for (const channel of channelsToStore) {
      const value = processedData[channel];
      
      if (value !== undefined && value !== null) {
        try {
          await redisStorage.store(source_name, channel, processed.timestamp, value);
          storedCount++;
        } catch (err) {
          errorCount++;
          error(`   ❌ Error storing channel ${channel}:`, err.message);
        }
      }
    }
    
    if (errorCount > 0) {
      throw new Error(`Failed to store ${errorCount} channels`);
    }
    
    console.log(`   ✅ Stored ${storedCount} channels to Redis`);
    
    // Wait a bit for data to be flushed
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Step 5: Retrieve channels from Redis
    console.log('\n   Step 5: Retrieving channels from Redis...');
    const storedChannels = await redisStorage.getChannels(source_name);
    
    if (storedChannels.length === 0) {
      throw new Error('No channels found in Redis');
    }
    
    console.log(`   ✅ Found ${storedChannels.length} channels in Redis`);
    
    // Step 6: Verify normalized channel names are in Redis
    console.log('\n   Step 6: Verifying normalized channel names in Redis...');
    const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa', 'Twa', 'Bsp', 'Tws', 'Twd', 'Accel_rate_mps2', 'Yaw_rate_dps'];
    const lowercaseChannelsToCheck = ['lat', 'lng', 'hdg', 'cog', 'sog', 'cwa', 'twa', 'bsp', 'tws', 'twd'];
    
    let redisChecksPassed = true;
    
    // Check normalized channels exist
    for (const channel of normalizedChannels) {
      if (storedChannels.includes(channel)) {
        console.log(`   ✅ ${channel} found in Redis`);
      } else {
        console.log(`   ❌ ${channel} NOT found in Redis`);
        redisChecksPassed = false;
      }
    }
    
    // Check lowercase channels do NOT exist
    for (const channel of lowercaseChannelsToCheck) {
      if (storedChannels.includes(channel)) {
        console.log(`   ❌ ${channel} found in Redis (should NOT exist!)`);
        redisChecksPassed = false;
      } else {
        console.log(`   ✅ ${channel} NOT in Redis (correct)`);
      }
    }
    
    // Check computed channels
    if (storedChannels.includes('TACK')) {
      console.log('   ✅ TACK found in Redis');
    } else {
      console.log('   ❌ TACK NOT found in Redis');
      redisChecksPassed = false;
    }
    
    if (storedChannels.includes('POINTOFSAIL')) {
      console.log('   ✅ POINTOFSAIL found in Redis');
    } else {
      console.log('   ❌ POINTOFSAIL NOT found in Redis');
      redisChecksPassed = false;
    }
    
    if (storedChannels.includes('MANEUVER_TYPE')) {
      console.log('   ✅ MANEUVER_TYPE found in Redis');
    } else {
      console.log('   ⚠️  MANEUVER_TYPE not found (may be null for first point)');
    }
    
    // Check custom fields
    if (storedChannels.includes('custom_field')) {
      console.log('   ✅ custom_field found in Redis');
    } else {
      console.log('   ❌ custom_field NOT found in Redis');
      redisChecksPassed = false;
    }
    
    if (!redisChecksPassed) {
      throw new Error('Redis channel verification failed');
    }
    
    // Step 7: Retrieve actual data from Redis and verify values
    console.log('\n   Step 7: Retrieving data from Redis and verifying values...');
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const testChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa'];
    let dataChecksPassed = true;
    
    for (const channel of testChannels) {
      const dataPoints = await redisStorage.query(source_name, channel, oneHourAgo, now);
      
      if (dataPoints.length === 0) {
        console.log(`   ❌ ${channel}: No data points found`);
        dataChecksPassed = false;
        continue;
      }
      
      // Find our test data point
      const testPoint = dataPoints.find(p => p.timestamp === processed.timestamp);
      if (!testPoint) {
        console.log(`   ❌ ${channel}: Test data point not found`);
        dataChecksPassed = false;
        continue;
      }
      
      // Verify value matches
      const expectedValue = processedData[channel];
      if (testPoint.value !== expectedValue) {
        console.log(`   ❌ ${channel}: expected ${expectedValue}, got ${testPoint.value}`);
        dataChecksPassed = false;
      } else {
        console.log(`   ✅ ${channel}: value ${testPoint.value} matches`);
      }
    }
    
    if (!dataChecksPassed) {
      throw new Error('Data value verification failed');
    }
    
    console.log('\n✅ ALL TESTS PASSED!');
    console.log('\n📊 Summary:');
    console.log(`   - Processed ${channelsToStore.length} channels`);
    console.log(`   - Stored ${storedCount} channels to Redis`);
    console.log(`   - Retrieved ${storedChannels.length} channels from Redis`);
    console.log(`   - All normalized channel names verified`);
    console.log(`   - All data values verified`);
    console.log('\n🎉 Processor normalization and Redis storage are working correctly!');
    
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run the test
runTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

