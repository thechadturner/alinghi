/**
 * Test script to check if NEW data is being stored with normalized names
 * Compares data from last minute vs older data
 * Run with: node server_stream/__tests__/test-redis-new-data.js
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

async function testNewData() {
  console.log('🔍 Testing if NEW data is stored with normalized names...\n');
  
  try {
    const status = await checkStatus();
    
    if (!status.success || status.data.connections.count === 0) {
      console.log('❌ No active connections');
      return;
    }
    
    const sourceId = status.data.connections.sources[0].source_id;
    const channels = status.data.channels || [];
    
    console.log(`Testing source ${sourceId} with ${channels.length} channels\n`);
    
    const now = Date.now();
    const oneMinuteAgo = now - (60 * 1000);
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Test channels that should be normalized
    const testChannels = [
      { lowercase: 'lat', normalized: 'Lat' },
      { lowercase: 'lng', normalized: 'Lng' },
      { lowercase: 'hdg', normalized: 'Hdg' },
      { lowercase: 'cog', normalized: 'Cog' },
      { lowercase: 'sog', normalized: 'Sog' },
      { lowercase: 'cwa', normalized: 'Cwa' },
      { lowercase: 'twa', normalized: 'Twa' }
    ];
    
    console.log('Checking if normalized channel names exist and have recent data:\n');
    
    for (const test of testChannels) {
      // Check if normalized version exists
      const hasNormalized = channels.includes(test.normalized);
      const hasLowercase = channels.includes(test.lowercase);
      
      if (hasNormalized) {
        // Check recent data (last minute)
        try {
          const recentData = await checkData(sourceId, test.normalized, oneMinuteAgo, now);
          const recentCount = recentData.success && recentData.data ? recentData.data.count : 0;
          
          console.log(`✅ ${test.normalized}:`);
          console.log(`   Recent data (last minute): ${recentCount} points`);
          
          if (recentCount > 0) {
            const latest = recentData.data.data[recentData.data.data.length - 1];
            console.log(`   Latest: ${new Date(latest.timestamp).toISOString()}, Value: ${latest.value}`);
          }
        } catch (err) {
          console.log(`⚠️  ${test.normalized}: Error checking data - ${err.message}`);
        }
      } else {
        console.log(`❌ ${test.normalized}: NOT FOUND in Redis`);
      }
      
      if (hasLowercase) {
        console.log(`   ⚠️  Lowercase '${test.lowercase}' also exists (old data?)`);
        
        // Check if lowercase has recent data
        try {
          const recentLowercase = await checkData(sourceId, test.lowercase, oneMinuteAgo, now);
          const recentLowercaseCount = recentLowercase.success && recentLowercase.data ? recentLowercase.data.count : 0;
          
          if (recentLowercaseCount > 0) {
            console.log(`   ❌ PROBLEM: Lowercase '${test.lowercase}' has ${recentLowercaseCount} recent points!`);
            console.log(`   This means NEW data is still being stored with lowercase names!`);
          } else {
            console.log(`   ✅ Lowercase '${test.lowercase}' has no recent data (old data only)`);
          }
        } catch (err) {
          // Ignore errors
        }
      }
      console.log('');
    }
    
    console.log('\n📊 Summary:');
    const normalizedChannels = testChannels.filter(t => channels.includes(t.normalized));
    const lowercaseChannels = testChannels.filter(t => channels.includes(t.lowercase));
    
    console.log(`   Normalized channels found: ${normalizedChannels.length}/${testChannels.length}`);
    console.log(`   Lowercase channels found: ${lowercaseChannels.length}/${testChannels.length}`);
    
    if (normalizedChannels.length === testChannels.length && lowercaseChannels.length === 0) {
      console.log('\n   ✅ PERFECT: All channels normalized, no lowercase duplicates!');
    } else if (normalizedChannels.length > 0) {
      console.log('\n   ⚠️  PARTIAL: Some channels normalized, but lowercase versions may still exist');
      console.log('   This could be old data. New data should use normalized names.');
    } else {
      console.log('\n   ❌ PROBLEM: No normalized channels found!');
      console.log('   The processor may not be working correctly.');
    }
    
  } catch (err) {
    console.error('❌ Test failed:', err.message);
  }
}

testNewData().catch(console.error);

