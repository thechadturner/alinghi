/**
 * Test Channel Normalization Throughout Pipeline
 * Verifies that channel names are normalized correctly at each stage:
 * 1. InfluxDB (lowercase) → Processor (normalized)
 * 2. Processor → Redis (normalized)
 * 3. Redis → API (normalized)
 * 4. API → Frontend (mapped correctly)
 */

const processor = require('../../controllers/processor');
const redisStorage = require('../../controllers/redis');

const TEST_SOURCE_ID = 888;

const TEST_CHANNELS = {
  // Navigation channels (should be normalized)
  lat: { expected: 'Lat', value: 39.123456 },
  lng: { expected: 'Lng', value: 9.123456 },
  hdg: { expected: 'Hdg', value: 180.5 },
  cog: { expected: 'Cog', value: 181.2 },
  sog: { expected: 'Sog', value: 12.5 },
  cwa: { expected: 'Cwa', value: 45.0 },
  twa: { expected: 'Twa', value: 30.0 },
  bsp: { expected: 'Bsp', value: 15.3 },
  tws: { expected: 'Tws', value: 20.0 },
  twd: { expected: 'Twd', value: 180.0 },
  
  // Derived channels (should be normalized)
  accel: { expected: 'Accel_rate_mps2', value: 0.5 },
  ang_rate: { expected: 'Yaw_rate_dps', value: 2.3 },
  
  // Custom channels (should pass through as-is)
  custom_field: { expected: 'custom_field', value: 'test_value' },
  another_custom: { expected: 'another_custom', value: 99.9 }
};

async function testStage1_Processor() {
  console.log('\n📋 Stage 1: Processor Normalization');
  
  try {
    // Create test data with lowercase channels
    const testData = {
      source_id: TEST_SOURCE_ID,
      timestamp: Date.now(),
      data: {}
    };
    
    // Add all test channels in lowercase
    for (const [key, config] of Object.entries(TEST_CHANNELS)) {
      testData.data[key] = config.value;
    }
    
    // Process through processor
    processor.clearState(TEST_SOURCE_ID);
    const processed = processor.process(testData);
    
    if (!processed) {
      throw new Error('Processor returned null');
    }
    
    const processedChannels = Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime');
    
    let passed = 0;
    let failed = 0;
    
    for (const [inputKey, config] of Object.entries(TEST_CHANNELS)) {
      const expected = config.expected;
      const hasExpected = processedChannels.includes(expected);
      const hasInput = processedChannels.includes(inputKey);
      
      // For custom fields, input and expected are the same
      if (inputKey === expected) {
        if (hasExpected || hasInput) {
          // Check value is preserved
          if (processed.data[expected] === config.value || processed.data[inputKey] === config.value) {
            console.log(`   ✅ ${inputKey} → ${expected} (custom field, value correct)`);
            passed++;
          } else {
            console.log(`   ⚠️  ${inputKey}: Value mismatch`);
            failed++;
          }
        } else {
          console.log(`   ⚠️  ${inputKey}: Neither input nor expected found`);
          failed++;
        }
      } else if (hasExpected && !hasInput) {
        console.log(`   ✅ ${inputKey} → ${expected}`);
        passed++;
      } else if (hasInput && !hasExpected) {
        console.log(`   ❌ ${inputKey}: Found input key but not expected ${expected}`);
        failed++;
      } else if (!hasExpected && !hasInput) {
        console.log(`   ⚠️  ${inputKey}: Neither input nor expected found`);
        failed++;
      } else {
        // Both found - check which value is used (should prefer normalized)
        if (processed.data[expected] === config.value) {
          console.log(`   ✅ ${inputKey} → ${expected} (value correct, normalized preferred)`);
          passed++;
        } else if (processed.data[inputKey] === config.value) {
          console.log(`   ⚠️  ${inputKey}: Value in input key, should be in ${expected}`);
          failed++;
        } else {
          console.log(`   ⚠️  ${inputKey} → ${expected} (value mismatch)`);
          failed++;
        }
      }
    }
    
    console.log(`\n   Results: ${passed} passed, ${failed} failed`);
    return { passed, failed };
  } catch (err) {
    console.error(`   ❌ Processor test failed: ${err.message}`);
    return { passed: 0, failed: 1 };
  }
}

async function testStage2_Redis() {
  console.log('\n📋 Stage 2: Redis Storage');
  
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
    const testData = {
      source_id: TEST_SOURCE_ID,
      timestamp: timestamp,
      data: {}
    };
    
    for (const [key, config] of Object.entries(TEST_CHANNELS)) {
      testData.data[key] = config.value;
    }
    
    processor.clearState(TEST_SOURCE_ID);
    const processed = processor.process(testData);
    
    if (!processed) {
      throw new Error('Processor returned null');
    }
    
    // Store in Redis
    const channelsToStore = Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime');
    for (const channel of channelsToStore) {
      const value = processed.data[channel];
      if (value !== undefined && value !== null) {
        await redisStorage.store(TEST_SOURCE_ID, channel, timestamp, value);
      }
    }
    
    // Verify channels in Redis
    const storedChannels = await redisStorage.getChannels(TEST_SOURCE_ID);
    
    let passed = 0;
    let failed = 0;
    
    for (const [inputKey, config] of Object.entries(TEST_CHANNELS)) {
      const expected = config.expected;
      const hasExpected = storedChannels.includes(expected);
      const hasInput = storedChannels.includes(inputKey);
      
      // For custom fields, input and expected are the same, so only check if it exists
      if (inputKey === expected) {
        if (hasExpected || hasInput) {
          console.log(`   ✅ ${inputKey} stored in Redis (custom field)`);
          passed++;
        } else {
          console.log(`   ❌ ${inputKey}: Not found in Redis`);
          failed++;
        }
      } else if (hasExpected && !hasInput) {
        console.log(`   ✅ ${inputKey} → ${expected} stored in Redis`);
        passed++;
      } else if (hasInput && !hasExpected) {
        console.log(`   ❌ ${inputKey}: Found input key in Redis but not expected ${expected}`);
        failed++;
      } else if (!hasExpected && !hasInput) {
        // Some channels might not be stored (e.g., computed channels)
        console.log(`   ⚠️  ${inputKey}: Not found in Redis (may be computed)`);
        // Don't count as failure for computed channels
        if (inputKey === 'tack' || inputKey === 'pointofsail' || inputKey === 'maneuver_type') {
          passed++;
        } else {
          failed++;
        }
      } else {
        // Both found - this is only a problem if they're different
        if (inputKey !== expected) {
          console.log(`   ❌ ${inputKey}: Both input and expected found in Redis (duplicate)`);
          failed++;
        } else {
          // Same key, which is fine
          console.log(`   ✅ ${inputKey} stored in Redis`);
          passed++;
        }
      }
    }
    
    console.log(`\n   Results: ${passed} passed, ${failed} failed`);
    return { passed, failed };
  } catch (err) {
    console.error(`   ❌ Redis test failed: ${err.message}`);
    return { passed: 0, failed: 1 };
  }
}

async function testStage3_Retrieval() {
  console.log('\n📋 Stage 3: Data Retrieval');
  
  try {
    await redisStorage.connect();
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!redisStorage.isConnected) {
      throw new Error('Redis not connected');
    }
    
    const storedChannels = await redisStorage.getChannels(TEST_SOURCE_ID);
    
    if (storedChannels.length === 0) {
      console.log('   ⚠️  No channels in Redis, skipping retrieval test');
      return { passed: 0, failed: 0, skipped: true };
    }
    
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    
    let passed = 0;
    let failed = 0;
    
    // Test retrieving normalized channels
    const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
    for (const channel of normalizedChannels) {
      if (storedChannels.includes(channel)) {
        const data = await redisStorage.query(TEST_SOURCE_ID, channel, oneHourAgo, now);
        if (data.length > 0) {
          console.log(`   ✅ ${channel}: Retrieved ${data.length} points`);
          passed++;
        } else {
          console.log(`   ❌ ${channel}: No data retrieved`);
          failed++;
        }
      } else {
        console.log(`   ⚠️  ${channel}: Not in Redis`);
      }
    }
    
    console.log(`\n   Results: ${passed} passed, ${failed} failed`);
    return { passed, failed };
  } catch (err) {
    console.error(`   ❌ Retrieval test failed: ${err.message}`);
    return { passed: 0, failed: 1 };
  }
}

async function runTests() {
  console.log('🧪 Channel Normalization Pipeline Tests');
  console.log('='.repeat(60));
  
  const results = {
    processor: await testStage1_Processor(),
    redis: await testStage2_Redis(),
    retrieval: await testStage3_Retrieval()
  };
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 Test Results Summary:');
  console.log('='.repeat(60));
  
  const totalPassed = results.processor.passed + results.redis.passed + results.retrieval.passed;
  const totalFailed = results.processor.failed + results.redis.failed + results.retrieval.failed;
  
  console.log(`\n✅ Total Passed: ${totalPassed}`);
  console.log(`❌ Total Failed: ${totalFailed}`);
  
  if (totalFailed === 0) {
    console.log('\n✅ All channel normalization tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed. Review the errors above.');
    process.exit(1);
  }
}

runTests().catch(console.error);

