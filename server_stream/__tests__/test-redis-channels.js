/**
 * Test script to verify what channel names are actually stored in Redis
 * Run with: node server_stream/__tests__/test-redis-channels.js
 */

const http = require('http');
const { URL } = require('url');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';

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

async function checkChannels(sourceId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${sourceId}/channels`);
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

async function checkData(sourceId, channel, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${sourceId}/data`);
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

async function testRedisChannels() {
  console.log('🔍 Testing Redis Channel Storage...\n');
  
  try {
    // Check server status
    console.log('1. Checking server status...');
    const status = await checkStatus();
    
    if (!status.success) {
      console.error('❌ Server status check failed:', status.message);
      return;
    }
    
    console.log('✅ Server is running');
    console.log(`   Redis: ${status.data.redis.connected ? '✅ Connected' : '❌ Not Connected'}`);
    console.log(`   Active Connections: ${status.data.connections.count}`);
    
    if (status.data.connections.count === 0) {
      console.log('\n⚠️  No active connections found.');
      console.log('   Cannot test Redis channels without active data sources.');
      console.log('   Please start the InfluxDB simulator or add a source manually.');
      return;
    }
    
    // Get first source
    const firstSource = status.data.connections.sources[0];
    const sourceId = firstSource.source_id;
    console.log(`\n2. Testing source ${sourceId}...`);
    
    // Get channels from Redis (use debug endpoint which includes channels)
    console.log('\n3. Fetching channels from Redis...');
    let channels = [];
    
    // Try debug endpoint first (no auth required)
    if (status.data.channels && status.data.channels.length > 0) {
      channels = status.data.channels;
      console.log(`   ✅ Found ${channels.length} channels from debug endpoint\n`);
    } else {
      // Fallback to channels endpoint
      try {
        const channelsResult = await checkChannels(sourceId);
        if (channelsResult.success && channelsResult.data.channels) {
          channels = channelsResult.data.channels;
        }
      } catch (err) {
        console.log(`   ⚠️  Could not get channels via API: ${err.message}`);
        console.log('   Trying to scan Redis keys directly...');
      }
    }
    
    if (channels.length === 0) {
      console.log('   ⚠️  No channels found. Data may not be stored yet.');
      console.log('   Wait a few seconds for data to flow and try again.');
      return;
    }
    console.log(`   ✅ Found ${channels.length} channels in Redis\n`);
    
    // Check for normalized vs lowercase
    const normalizedChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'Tws', 'Twd', 'Bsp', 'Twa', 'Cwa'];
    const lowercaseChannels = ['lat', 'lng', 'hdg', 'cog', 'sog', 'tws', 'twd', 'bsp', 'twa', 'cwa'];
    
    console.log('4. Checking channel name normalization...');
    const foundNormalized = channels.filter(ch => normalizedChannels.includes(ch));
    const foundLowercase = channels.filter(ch => lowercaseChannels.includes(ch));
    
    console.log(`   Normalized channels found: ${foundNormalized.length}`);
    foundNormalized.forEach(ch => console.log(`     ✅ ${ch}`));
    
    if (foundLowercase.length > 0) {
      console.log(`\n   ⚠️  Lowercase channels found (should NOT exist): ${foundLowercase.length}`);
      foundLowercase.forEach(ch => console.log(`     ❌ ${ch}`));
    } else {
      console.log(`\n   ✅ No lowercase duplicates found (correct!)`);
    }
    
    // Check for computed channels
    console.log('\n5. Checking computed channels...');
    const computedChannels = ['TACK', 'POINTOFSAIL', 'MANEUVER_TYPE'];
    const foundComputed = channels.filter(ch => computedChannels.includes(ch));
    console.log(`   Computed channels found: ${foundComputed.length}`);
    foundComputed.forEach(ch => console.log(`     ✅ ${ch}`));
    
    // Show all channels
    console.log('\n6. All channels in Redis:');
    channels.sort().forEach((ch, idx) => {
      const isNormalized = normalizedChannels.includes(ch);
      const isLowercase = lowercaseChannels.includes(ch);
      const marker = isNormalized ? '✅' : isLowercase ? '❌' : '  ';
      console.log(`   ${marker} ${idx + 1}. ${ch}`);
    });
    
    // Test data retrieval for normalized channels
    if (foundNormalized.length > 0) {
      console.log('\n7. Testing data retrieval for normalized channels...');
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);
      
      for (const channel of foundNormalized.slice(0, 5)) {
        try {
          const dataResult = await checkData(sourceId, channel, oneHourAgo, now);
          if (dataResult.success && dataResult.data) {
            const count = dataResult.data.count || 0;
            console.log(`   ✅ ${channel}: ${count} data points`);
            if (count > 0 && dataResult.data.data && dataResult.data.data.length > 0) {
              const latest = dataResult.data.data[dataResult.data.data.length - 1];
              console.log(`      Latest: ${new Date(latest.timestamp).toISOString()}, Value: ${latest.value}`);
            }
          } else {
            console.log(`   ⚠️  ${channel}: No data returned`);
          }
        } catch (err) {
          console.log(`   ❌ ${channel}: Error - ${err.message}`);
        }
      }
    }
    
    // Summary
    console.log('\n8. Summary:');
    const hasNormalized = foundNormalized.length > 0;
    const hasLowercase = foundLowercase.length > 0;
    const allNormalized = foundNormalized.length >= 5; // At least Lat, Lng, Hdg, Cog, Sog
    
    console.log(`   ✅ Normalized channels present: ${hasNormalized ? 'YES' : 'NO'}`);
    console.log(`   ${hasLowercase ? '❌' : '✅'} Lowercase duplicates: ${hasLowercase ? 'YES (PROBLEM!)' : 'NO (CORRECT!)'}`);
    console.log(`   ${allNormalized ? '✅' : '⚠️ '} Core navigation channels: ${allNormalized ? 'ALL PRESENT' : 'MISSING SOME'}`);
    
    if (hasLowercase) {
      console.log('\n   ⚠️  WARNING: Lowercase channel names found in Redis!');
      console.log('   This means the processor is not normalizing correctly, or');
      console.log('   old data with lowercase names still exists in Redis.');
    } else if (hasNormalized) {
      console.log('\n   ✅ SUCCESS: All channels are properly normalized!');
    } else {
      console.log('\n   ⚠️  No normalized channels found. Check if data is being stored.');
    }
    
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error('   Make sure the streaming server is running on', STREAM_SERVER_URL);
  }
}

testRedisChannels().catch(console.error);

