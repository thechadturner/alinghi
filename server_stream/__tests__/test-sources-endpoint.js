/**
 * Test script to check what the /sources endpoint returns
 */

const http = require('http');
const { URL } = require('url');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';

async function testSourcesEndpoint() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources`);
    
    console.log('\n📋 Testing /api/stream/sources endpoint');
    console.log(`   URL: ${url.toString()}`);
    console.log('   (Note: This requires authentication - may need auth_token cookie)\n');
    
    const options = {
      headers: {
        'Cookie': 'auth_token=test' // This may need to be a valid token
      }
    };
    
    http.get(url.toString(), options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log('✅ Response received:');
          console.log('   Status:', res.statusCode);
          console.log('   Success:', result.success);
          console.log('   Message:', result.message);
          console.log('\n   Data:', JSON.stringify(result.data, null, 2));
          
          if (result.data && Array.isArray(result.data)) {
            console.log(`\n   Found ${result.data.length} sources:`);
            result.data.forEach((source, index) => {
              console.log(`   ${index + 1}.`, JSON.stringify(source));
            });
            
            // Check structure
            if (result.data.length > 0) {
              const firstSource = result.data[0];
              console.log('\n   First source structure:');
              console.log('   - Keys:', Object.keys(firstSource));
              console.log('   - Has source_name?', 'source_name' in firstSource);
              if ('source_name' in firstSource) {
                console.log('   - source_name value:', firstSource.source_name);
              }
            }
          }
          
          resolve({ status: res.statusCode, data: result });
        } catch (err) {
          console.error('❌ Error parsing response:', err.message);
          console.error('   Raw response:', data);
          reject(err);
        }
      });
    }).on('error', (err) => {
      console.error('❌ Request failed:', err.message);
      reject(err);
    });
  });
}

async function testGetSourceNames() {
  // Also test the internal getSourceNames function directly
  console.log('\n📋 Testing internal getSourceNames() function');
  console.log('   (This requires Redis connection)\n');
  
  try {
    const redisStorage = require('../controllers/redis');
    const streamController = require('../controllers/stream');
    
    // Access the internal getSourceNames function
    // Note: This is a private function, so we may need to export it or test differently
    console.log('   Note: getSourceNames is a private function');
    console.log('   Testing via Redis directly...\n');
    
    if (!redisStorage.redisStorage || !redisStorage.redisStorage.isConnected) {
      console.log('   ⚠️  Redis not connected');
      return;
    }
    
    // Get keys directly from Redis
    const keys = await redisStorage.redisStorage.client.keys('stream:*');
    const dataKeys = keys.filter(k => !k.endsWith(':meta'));
    
    console.log(`   Found ${dataKeys.length} data keys in Redis:`);
    dataKeys.forEach((key, index) => {
      const sourceName = key.replace('stream:', '');
      console.log(`   ${index + 1}. Key: ${key} -> Source: ${sourceName}`);
    });
    
    // Test getLatestTimestamp for each
    console.log('\n   Checking latest timestamps:');
    for (const key of dataKeys) {
      const sourceName = key.replace('stream:', '');
      const latest = await redisStorage.redisStorage.getLatestTimestamp(sourceName);
      if (latest) {
        console.log(`   ✅ ${sourceName}: Latest timestamp = ${new Date(latest).toISOString()}`);
      } else {
        console.log(`   ⚠️  ${sourceName}: No timestamp found`);
      }
    }
    
  } catch (err) {
    console.error('   ❌ Error:', err.message);
  }
}

async function runTest() {
  console.log('🧪 Testing /sources Endpoint\n');
  console.log('='.repeat(60));
  
  try {
    // Test 1: API endpoint
    await testSourcesEndpoint();
    
    // Test 2: Internal function (if possible)
    await testGetSourceNames();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Test complete');
    
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  }
}

runTest().catch(console.error);

