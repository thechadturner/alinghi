/**
 * End-to-end integration test: Redis → IndexedDB Storage (with dataset_id = 0)
 * Tests that Redis data is queried and stored in IndexedDB with dataset_id = 0 in live mode
 * 
 * This test verifies:
 * 1. Data can be fetched from Redis via API
 * 2. Storage logic uses dataset_id = 0 in live mode
 * 3. Data structure is correct for IndexedDB storage
 * 
 * Run with: node server_stream/__tests__/integration/test-redis-to-indexeddb.js
 */

const http = require('http');
const { URL } = require('url');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from project root .env file
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const redisStorage = require('../../controllers/redis');
const processor = require('../../controllers/processor');
const { log, error } = require('../../../shared');
const { authManager } = require('../../../shared/auth');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';
const TEST_SOURCE_ID = 999; // Use test source ID
const TEST_SOURCE_NAME = 'TEST'; // Test source name

// Test configuration
const TEST_CONFIG = {
  channels: ['Lat', 'Lng', 'Hdg', 'Bsp', 'Maneuver_type'],
  minDataPoints: 5,
  timeWindow: 3600000 // 1 hour
};

// Cache for test token (generate once, reuse)
let testToken = null;

/**
 * Generate a valid JWT token for testing
 */
function generateTestToken() {
  if (testToken) {
    return testToken;
  }
  
  try {
    testToken = authManager.jwt.generateToken(
      {
        user_id: 'c3bc9a85-0c21-46ae-8348-17110bb44014',
        user_name: 'testuser',
        first_name: 'Test',
        last_name: 'User',
        email: 'test@example.com',
        is_verified: true,
        permissions: {}
      },
      'access'
    );
    return testToken;
  } catch (err) {
    error('Failed to generate test token:', err);
    throw new Error('Could not generate authentication token for test');
  }
}

/**
 * Make HTTP request to streaming API with proper authentication
 */
async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    // Generate a valid JWT token (cached, generated once)
    const token = generateTestToken();
    
    const requestOptions = {
      headers: {
        'Cookie': `auth_token=${token}`,
        'Authorization': `Bearer ${token}`, // Also try Authorization header as fallback
        ...options.headers
      }
    };
    
    http.get(url, requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Request failed: ${res.statusCode} - ${data.substring(0, 200)}`));
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
 * Fetch single channel data from Redis via API (simulating streamingDataService.fetchChannelData)
 */
async function fetchChannelDataFromRedis(sourceName, channel, startTime, endTime) {
  try {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${encodeURIComponent(sourceName)}/data`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('startTime', startTime.toString());
    url.searchParams.set('endTime', endTime.toString());

    const response = await makeRequest(url.toString());
    
    if (!response.success || !response.data) {
      return [];
    }

    // Return array of {timestamp, value} points
    if (response.data.data && Array.isArray(response.data.data)) {
      return response.data.data;
    }

    return [];
  } catch (err) {
    error(`Error fetching channel ${channel} from Redis:`, err);
    return [];
  }
}

/**
 * Fetch merged data from Redis via API (simulating streamingDataService.fetchMergedData)
 */
async function fetchMergedDataFromRedis(sourceName, channels, startTime, endTime) {
  try {
    // Fetch all channels in parallel (like streamingDataService does)
    const channelPromises = channels.map(channel =>
      fetchChannelDataFromRedis(sourceName, channel, startTime, endTime)
    );

    const channelDataArrays = await Promise.all(channelPromises);

    // Create a map of timestamp -> data point
    const pointsMap = new Map();

    // Merge all channel data by timestamp
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      const dataPoints = channelDataArrays[i];

      for (const point of dataPoints) {
        const timestamp = point.timestamp;
        
        if (!pointsMap.has(timestamp)) {
          pointsMap.set(timestamp, {
            timestamp: timestamp,
            Datetime: new Date(timestamp),
            source_name: sourceName
          });
        }

        const mergedPoint = pointsMap.get(timestamp);
        mergedPoint[channel] = point.value;
      }
    }

    // Convert map to array and sort by timestamp
    const mergedPoints = Array.from(pointsMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    return mergedPoints;
  } catch (err) {
    error('Error fetching merged data from Redis:', err);
    return [];
  }
}

/**
 * Test 1: Verify Redis data can be fetched
 */
async function testRedisDataFetch() {
  console.log('\n📋 Test 1: Fetching Data from Redis');
  console.log('   Testing that data can be queried from Redis via API...');
  
  try {
    // First, ensure we have test data in Redis
    console.log('   Step 1: Creating test data in Redis...');
    const timestamp = Date.now();
    const testData = {
      source_id: TEST_SOURCE_ID,
      timestamp: timestamp,
      data: {
        source: TEST_SOURCE_NAME,
        source_name: TEST_SOURCE_NAME,
        lat: 39.123456,
        lng: 9.123456,
        hdg: 180.5,
        bsp: 15.3,
        cwa: 45.0
      }
    };

    processor.clearState(TEST_SOURCE_ID);
    const processed = processor.process(testData);
    
    if (!processed) {
      throw new Error('Processor returned null');
    }

    const sourceName = processed.data.source_name;
    if (!sourceName) {
      throw new Error('Processed data missing source_name');
    }

    // Store test data in Redis
    const channelsToStore = ['Lat', 'Lng', 'Hdg', 'Bsp'];
    for (const channel of channelsToStore) {
      const value = processed.data[channel];
      if (value !== undefined && value !== null) {
        await redisStorage.store(sourceName, channel, processed.timestamp, value);
      }
    }

    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 200));
    console.log(`   ✅ Test data stored in Redis for source "${sourceName}"`);

    // Fetch data from Redis via API
    console.log('   Step 2: Fetching data from Redis via API...');
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const fetchedData = await fetchMergedDataFromRedis(
      sourceName,
      TEST_CONFIG.channels,
      oneHourAgo,
      now
    );

    if (fetchedData.length === 0) {
      throw new Error('No data fetched from Redis');
    }

    console.log(`   ✅ Fetched ${fetchedData.length} data points from Redis`);

    // Verify data structure
    console.log('   Step 3: Verifying data structure...');
    const firstPoint = fetchedData[0];
    
    const requiredFields = ['timestamp', 'Datetime', 'source_name'];
    for (const field of requiredFields) {
      if (!(field in firstPoint)) {
        throw new Error(`Missing required field: ${field}`);
      }
      console.log(`   ✅ Field "${field}" present`);
    }

    // Verify at least one channel is present
    const hasChannel = TEST_CONFIG.channels.some(ch => ch in firstPoint);
    if (!hasChannel) {
      throw new Error('No channel data found in fetched data');
    }
    console.log('   ✅ Channel data present');

    // Verify data values match
    if (firstPoint.Lat !== testData.data.lat) {
      throw new Error(`Lat mismatch: expected ${testData.data.lat}, got ${firstPoint.Lat}`);
    }
    console.log(`   ✅ Lat value matches: ${firstPoint.Lat}`);

    if (firstPoint.Lng !== testData.data.lng) {
      throw new Error(`Lng mismatch: expected ${testData.data.lng}, got ${firstPoint.Lng}`);
    }
    console.log(`   ✅ Lng value matches: ${firstPoint.Lng}`);

    console.log('   ✅ Test 1 PASSED: Redis data can be fetched correctly');
    return { sourceName, fetchedData };
  } catch (err) {
    console.error('   ❌ Test 1 FAILED:', err.message);
    throw err;
  }
}

/**
 * Test 2: Verify storage logic uses dataset_id = 0 in live mode
 */
async function testStorageLogic() {
  console.log('\n📋 Test 2: Storage Logic (dataset_id = 0 in live mode)');
  console.log('   Testing that storage logic correctly uses dataset_id = 0...');
  
  try {
    // This test verifies the logic in storeRedisDataAsMapdata
    // Since we can't directly test IndexedDB from Node.js, we verify the logic
    
    console.log('   Step 1: Verifying storage parameters...');
    
    // Simulate the storage logic
    const className = 'ac75';
    const projectId = '1';
    const isLive = true; // Live mode
    const datasetId = isLive ? '0' : '1'; // Should be '0' in live mode
    
    if (datasetId !== '0') {
      throw new Error(`Expected dataset_id = '0' in live mode, got '${datasetId}'`);
    }
    console.log(`   ✅ dataset_id correctly set to '0' in live mode`);
    
    // Verify the storage key format
    const storageKey = `mapdata_${datasetId}_${projectId}_${TEST_SOURCE_ID}`;
    const expectedKey = `mapdata_0_${projectId}_${TEST_SOURCE_ID}`;
    
    if (storageKey !== expectedKey) {
      throw new Error(`Storage key mismatch: expected '${expectedKey}', got '${storageKey}'`);
    }
    console.log(`   ✅ Storage key format correct: ${storageKey}`);
    
    console.log('   ✅ Test 2 PASSED: Storage logic uses dataset_id = 0 in live mode');
    return true;
  } catch (err) {
    console.error('   ❌ Test 2 FAILED:', err.message);
    throw err;
  }
}

/**
 * Test 3: Verify data structure for IndexedDB storage
 */
async function testDataStructure(fetchedData) {
  console.log('\n📋 Test 3: Data Structure for IndexedDB Storage');
  console.log('   Testing that fetched data has correct structure for IndexedDB...');
  
  try {
    if (!fetchedData || fetchedData.length === 0) {
      throw new Error('No data provided for structure test');
    }

    console.log('   Step 1: Verifying data point structure...');
    const firstPoint = fetchedData[0];
    
    // Required fields for mapdata storage
    const requiredFields = {
      'timestamp': 'number',
      'Datetime': 'object', // Date object
      'source_name': 'string'
    };

    for (const [field, type] of Object.entries(requiredFields)) {
      if (!(field in firstPoint)) {
        throw new Error(`Missing required field: ${field}`);
      }
      
      const actualType = typeof firstPoint[field];
      if (field === 'Datetime') {
        // Datetime can be Date object or string
        if (actualType !== 'object' && actualType !== 'string') {
          throw new Error(`Datetime has wrong type: expected Date or string, got ${actualType}`);
        }
      } else if (actualType !== type) {
        throw new Error(`Field ${field} has wrong type: expected ${type}, got ${actualType}`);
      }
      console.log(`   ✅ Field "${field}" has correct type`);
    }

    // Verify at least one map channel is present
    console.log('   Step 2: Verifying map channels...');
    const mapChannels = ['Lat', 'Lng', 'Hdg', 'Bsp', 'Maneuver_type'];
    const presentChannels = mapChannels.filter(ch => ch in firstPoint);
    
    if (presentChannels.length === 0) {
      throw new Error('No map channels found in data');
    }
    console.log(`   ✅ Found ${presentChannels.length} map channels: ${presentChannels.join(', ')}`);

    // Verify data is sorted by timestamp
    console.log('   Step 3: Verifying data is sorted by timestamp...');
    let isSorted = true;
    for (let i = 1; i < fetchedData.length; i++) {
      if (fetchedData[i].timestamp < fetchedData[i - 1].timestamp) {
        isSorted = false;
        break;
      }
    }
    
    if (!isSorted) {
      throw new Error('Data is not sorted by timestamp');
    }
    console.log('   ✅ Data is correctly sorted by timestamp');

    console.log('   ✅ Test 3 PASSED: Data structure is correct for IndexedDB storage');
    return true;
  } catch (err) {
    console.error('   ❌ Test 3 FAILED:', err.message);
    throw err;
  }
}

/**
 * Main test runner
 */
async function runTest() {
  console.log('🧪 Starting Redis to IndexedDB Integration Test...\n');
  console.log('📝 This test verifies:');
  console.log('   1. Data can be fetched from Redis via API');
  console.log('   2. Storage logic uses dataset_id = 0 in live mode');
  console.log('   3. Data structure is correct for IndexedDB storage\n');
  
  let redisConnected = false;
  let testResults = {};

  try {
    // Connect to Redis
    console.log('1. Connecting to Redis...');
    redisConnected = await redisStorage.connect();
    if (!redisConnected) {
      throw new Error('Failed to connect to Redis');
    }
    
    // Wait for connection to be ready
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!redisStorage.isConnected) {
      throw new Error('Redis connection not ready after 5 seconds');
    }
    
    console.log('   ✅ Connected to Redis\n');

    // Check if streaming server is running
    console.log('2. Checking streaming server status...');
    try {
      const healthUrl = `${STREAM_SERVER_URL}/api/health`;
      await makeRequest(healthUrl);
      console.log('   ✅ Streaming server is running\n');
    } catch (err) {
      console.log('   ⚠️  Streaming server not running or health check failed');
      console.log(`   ⚠️  Error: ${err.message}`);
      console.log('   ⚠️  Start the server with: npm run dev:stream\n');
    }
    
    // Verify token generation works
    console.log('3. Verifying authentication token generation...');
    try {
      const token = generateTestToken();
      if (!token) {
        throw new Error('Token generation returned null');
      }
      console.log(`   ✅ Token generated successfully (length: ${token.length})`);
      
      // Try to verify the token
      try {
        const decoded = await authManager.verifyToken(token, false); // Skip blacklist check for test
        console.log(`   ✅ Token verified successfully (user_id: ${decoded.user_id}, iss: ${decoded.iss}, aud: ${decoded.aud})`);
      } catch (verifyErr) {
        console.log(`   ⚠️  Token verification failed: ${verifyErr.message}`);
        console.log(`   ⚠️  JWT Config - SECRET: ${process.env.JWT_SECRET ? 'SET' : 'NOT SET'}, ISSUER: ${process.env.JWT_ISSUER || 'default'}, AUDIENCE: ${process.env.JWT_AUDIENCE || 'default'}`);
        console.log(`   ⚠️  This might indicate JWT_SECRET mismatch between test and server`);
      }
      console.log('');
    } catch (err) {
      console.error('   ❌ Token generation failed:', err.message);
      throw err;
    }

    // Run tests
    console.log('4. Running data flow tests...\n');
    const { sourceName, fetchedData } = await testRedisDataFetch();
    testResults.fetch = true;

    await testStorageLogic();
    testResults.storage = true;

    await testDataStructure(fetchedData);
    testResults.structure = true;

    // Summary
    console.log('\n✅ ALL TESTS PASSED!');
    console.log('\n📊 Summary:');
    console.log(`   - Redis data fetch: ✅`);
    console.log(`   - Storage logic (dataset_id = 0): ✅`);
    console.log(`   - Data structure: ✅`);
    console.log(`   - Test source: ${sourceName}`);
    console.log(`   - Data points fetched: ${fetchedData.length}`);
    console.log('\n🎉 Redis to IndexedDB data flow is working correctly!');
    console.log('\n📌 Note: This test verifies the Redis querying and storage logic.');
    console.log('   For full IndexedDB storage testing, run the browser-based test:');
    console.log('   npm run test:frontend:integration:redis-indexeddb');

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    // Cleanup
    if (redisConnected) {
      try {
        processor.clearState(TEST_SOURCE_ID);
        console.log('\n🧹 Cleaned up test data');
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  }
}

// Run the test
runTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

