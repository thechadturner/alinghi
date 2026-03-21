/**
 * Integration test using ACTUAL InfluxDB streaming data
 * Monitors real data flow and verifies normalized channel names are stored in Redis
 * 
 * Run with: node server_stream/__tests__/integration/test-influx-stream-to-redis.js
 */

const redisStorage = require('../../controllers/redis');
const http = require('http');
const { URL } = require('url');
const { log, error } = require('../../../shared');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';
const TEST_DURATION_MS = 30000; // Monitor for 30 seconds
const CHECK_INTERVAL_MS = 2000; // Check every 2 seconds

/**
 * Get source names from Redis
 */
async function getSourceNames() {
  try {
    if (!redisStorage.isConnected || !redisStorage.client) {
      return [];
    }
    
    // Get all source names from Redis keys
    const keys = await redisStorage.client.keys('stream:*');
    const dataKeys = keys.filter(k => !k.endsWith(':meta'));
    
    const sourceNames = [];
    for (const key of dataKeys) {
      const sourceName = key.replace('stream:', '');
      // Check if this source has recent data
      const latest = await redisStorage.getLatestTimestamp(sourceName);
      if (latest) {
        sourceNames.push(sourceName);
      }
    }
    
    return [...new Set(sourceNames)].sort(); // Remove duplicates and sort alphabetically
  } catch (err) {
    error(`[Test] Could not get source names:`, err.message);
    return [];
  }
}

async function checkStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/debug/status`);
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function checkChannels(sourceName) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${sourceName}/channels`);
    http.get(url, { headers: { Cookie: 'auth_token=test' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function checkData(sourceName, channel, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${sourceName}/data`);
    url.searchParams.set('channel', channel);
    if (startTime) url.searchParams.set('startTime', startTime);
    if (endTime) url.searchParams.set('endTime', endTime);
    
    http.get(url, { headers: { Cookie: 'auth_token=test' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function runTest() {
  console.log('🧪 Testing ACTUAL InfluxDB Stream → Processor → Redis\n');
  console.log(`⏱️  Monitoring for ${TEST_DURATION_MS / 1000} seconds...\n`);
  
  try {
    // Connect to Redis for direct queries
    console.log('1. Connecting to Redis...');
    const redisConnected = await redisStorage.connect();
    if (!redisConnected) {
      throw new Error('Failed to connect to Redis');
    }
    
    // Wait for connection
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!redisStorage.isConnected) {
      throw new Error('Redis connection not ready');
    }
    console.log('   ✅ Connected to Redis\n');
    
    // Check initial status
    console.log('2. Checking streaming server status...');
    const initialStatus = await checkStatus();
    
    if (!initialStatus.success) {
      throw new Error('Failed to get server status');
    }
    
    console.log(`   ✅ Server is running`);
    console.log(`   ✅ Redis: ${initialStatus.data.redis.connected ? 'Connected' : 'Not Connected'}`);
    console.log(`   ✅ Active Connections: ${initialStatus.data.connections.count}`);
    
    // Get source names from Redis (not from connections)
    const sourceNames = await getSourceNames();
    if (sourceNames.length === 0) {
      throw new Error('No source names found in Redis! InfluxDB sources may not be connected or no data has been stored.');
    }
    
    const sourceName = sourceNames[0];
    console.log(`   ✅ Testing source "${sourceName}"\n`);
    
    // Get initial channel count
    const initialChannels = initialStatus.data.channels || [];
    console.log(`3. Initial state:`);
    console.log(`   Channels in Redis: ${initialChannels.length}`);
    
    if (initialChannels.length > 0) {
      console.log(`   Initial channels: ${initialChannels.slice(0, 10).join(', ')}${initialChannels.length > 10 ? '...' : ''}`);
    }
    console.log('');
    
    // Monitor for data flow
    console.log('4. Monitoring data flow...');
    const startTime = Date.now();
    const endTime = startTime + TEST_DURATION_MS;
    let lastChannelCount = initialChannels.length;
    let checks = 0;
    let maxChannels = initialChannels.length;
    const channelSnapshots = [];
    
    while (Date.now() < endTime) {
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
      checks++;
      
      try {
        const status = await checkStatus();
        const channels = status.data.channels || [];
        const currentCount = channels.length;
        
        if (currentCount > maxChannels) {
          maxChannels = currentCount;
          channelSnapshots.push({
            time: Date.now(),
            count: currentCount,
            channels: [...channels]
          });
          console.log(`   [${new Date().toLocaleTimeString()}] Channels: ${currentCount} (+${currentCount - lastChannelCount})`);
        }
        
        lastChannelCount = currentCount;
      } catch (err) {
        console.log(`   ⚠️  Error checking status: ${err.message}`);
      }
    }
    
    console.log(`\n   ✅ Monitoring complete (${checks} checks)\n`);
    
    // Final analysis
    console.log('5. Final Analysis:');
    const finalStatus = await checkStatus();
    const finalChannels = finalStatus.data.channels || [];
    
    console.log(`   Total channels in Redis: ${finalChannels.length}`);
    console.log(`   New channels added: ${finalChannels.length - initialChannels.length}`);
    
    if (finalChannels.length === 0) {
      console.log('\n   ❌ NO CHANNELS FOUND IN REDIS!');
      console.log('   This means data is not being stored.');
      console.log('   Check server logs for errors.');
      return;
    }
    
    // Analyze channel names
    console.log('\n6. Channel Name Analysis:');
    const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Cwa', 'Twa', 'Bsp', 'Tws', 'Twd', 'Accel_rate_mps2', 'Yaw_rate_dps'];
    const lowercaseChannels = ['lat', 'lng', 'hdg', 'cog', 'sog', 'cwa', 'twa', 'bsp', 'tws', 'twd'];
    
    const foundNormalized = finalChannels.filter(ch => normalizedChannels.includes(ch));
    const foundLowercase = finalChannels.filter(ch => lowercaseChannels.includes(ch));
    
    console.log(`   Normalized channels found: ${foundNormalized.length}/${normalizedChannels.length}`);
    if (foundNormalized.length > 0) {
      foundNormalized.forEach(ch => console.log(`     ✅ ${ch}`));
    }
    
    console.log(`\n   Lowercase channels found: ${foundLowercase.length}/${lowercaseChannels.length}`);
    if (foundLowercase.length > 0) {
      foundLowercase.forEach(ch => console.log(`     ❌ ${ch} (SHOULD NOT EXIST!)`));
    } else {
      console.log(`     ✅ No lowercase duplicates (correct!)`);
    }
    
    // Check computed channels
    const computedChannels = ['TACK', 'POINTOFSAIL', 'MANEUVER_TYPE'];
    const foundComputed = finalChannels.filter(ch => computedChannels.includes(ch));
    console.log(`\n   Computed channels found: ${foundComputed.length}/${computedChannels.length}`);
    foundComputed.forEach(ch => console.log(`     ✅ ${ch}`));
    
    // Check recent data
    console.log('\n7. Checking recent data (last minute)...');
    const now = Date.now();
    const oneMinuteAgo = now - (60 * 1000);
    
    const testChannels = foundNormalized.length > 0 ? foundNormalized.slice(0, 5) : finalChannels.slice(0, 5);
    
    for (const channel of testChannels) {
      try {
        const dataResult = await checkData(sourceName, channel, oneMinuteAgo, now);
        if (dataResult.success && dataResult.data) {
          const count = dataResult.data.count || 0;
          console.log(`   ${channel}: ${count} data points in last minute`);
          if (count > 0 && dataResult.data.data && dataResult.data.data.length > 0) {
            const latest = dataResult.data.data[dataResult.data.data.length - 1];
            console.log(`      Latest: ${new Date(latest.timestamp).toISOString()}, Value: ${latest.value}`);
          }
        }
      } catch (err) {
        console.log(`   ${channel}: Error - ${err.message}`);
      }
    }
    
    // Summary
    console.log('\n8. Test Summary:');
    const hasNormalized = foundNormalized.length > 0;
    const hasLowercase = foundLowercase.length > 0;
    const allNormalized = foundNormalized.length >= 5; // At least core navigation channels
    
    if (hasLowercase) {
      console.log('   ❌ FAILED: Lowercase channel names found in Redis!');
      console.log('   The processor is not normalizing correctly, or old data exists.');
      console.log('   Solution: Clear Redis and wait for new data.');
    } else if (hasNormalized && allNormalized) {
      console.log('   ✅ SUCCESS: All channels are properly normalized!');
      console.log('   ✅ No lowercase duplicates found');
      console.log('   ✅ Core navigation channels present');
      console.log('\n🎉 Processor normalization is working correctly with real InfluxDB data!');
    } else if (hasNormalized) {
      console.log('   ⚠️  PARTIAL: Some normalized channels found, but missing core navigation channels');
      console.log('   This may indicate incomplete data or missing fields in InfluxDB.');
    } else {
      console.log('   ❌ FAILED: No normalized channels found!');
      console.log('   The processor may not be working, or data is not flowing.');
    }
    
    // Show all channels
    console.log(`\n9. All channels in Redis (${finalChannels.length} total):`);
    finalChannels.sort().forEach((ch, idx) => {
      const isNormalized = normalizedChannels.includes(ch);
      const isLowercase = lowercaseChannels.includes(ch);
      const marker = isNormalized ? '✅' : isLowercase ? '❌' : '  ';
      console.log(`   ${marker} ${idx + 1}. ${ch}`);
    });
    
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

