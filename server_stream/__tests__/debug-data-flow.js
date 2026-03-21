/**
 * Debug script to check if data is flowing and being stored
 * Run with: node server_stream/__tests__/debug-data-flow.js
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

async function debug() {
  console.log('🔍 Debugging Data Flow...\n');
  
  try {
    const status = await checkStatus();
    
    if (!status.success) {
      console.error('❌ Server status check failed');
      return;
    }
    
    console.log('✅ Server Status:');
    console.log(`   Redis: ${status.data.redis.connected ? '✅ Connected' : '❌ Not Connected'}`);
    console.log(`   Active Connections: ${status.data.connections.count}`);
    
    if (status.data.connections.count === 0) {
      console.log('\n❌ No active connections!');
      console.log('   The InfluxDB simulator may not be running or sources not discovered.');
      return;
    }
    
    console.log('\n📊 Connections:');
    status.data.connections.sources.forEach(conn => {
      console.log(`   - Source ${conn.source_id} (${conn.type}): ${conn.state}`);
    });
    
    // Check channels
    const sourceId = status.data.connections.sources[0].source_id;
    console.log(`\n📦 Checking channels for source ${sourceId}...`);
    
    const channels = status.data.channels || [];
    console.log(`   Channels in Redis: ${channels.length}`);
    
    if (channels.length === 0) {
      console.log('\n❌ NO CHANNELS IN REDIS!');
      console.log('\n🔍 Possible causes:');
      console.log('   1. Data is not being received from InfluxDB');
      console.log('   2. Processor is returning null');
      console.log('   3. Data validation is failing');
      console.log('   4. Redis storage is failing silently');
      console.log('\n📋 Check server logs for:');
      console.log('   - "[StreamController] Source X received data point"');
      console.log('   - "[StreamController] Source X processed data point, storing N channels"');
      console.log('   - "[StreamController] Source X data point processing returned null"');
      console.log('   - "[StreamController] Source X processed data missing required fields"');
      console.log('   - "[RedisStorage] Error storing"');
      return;
    }
    
    console.log(`\n✅ Found ${channels.length} channels:`);
    channels.slice(0, 20).forEach((ch, idx) => {
      console.log(`   ${idx + 1}. ${ch}`);
    });
    if (channels.length > 20) {
      console.log(`   ... and ${channels.length - 20} more`);
    }
    
    // Check for normalized vs lowercase
    const normalized = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
    const lowercase = ['lat', 'lng', 'hdg', 'cog', 'sog'];
    
    const foundNormalized = channels.filter(ch => normalized.includes(ch));
    const foundLowercase = channels.filter(ch => lowercase.includes(ch));
    
    console.log(`\n🔤 Channel Name Analysis:`);
    console.log(`   Normalized channels: ${foundNormalized.length}/${normalized.length}`);
    if (foundNormalized.length > 0) {
      foundNormalized.forEach(ch => console.log(`     ✅ ${ch}`));
    }
    console.log(`   Lowercase channels: ${foundLowercase.length}/${lowercase.length}`);
    if (foundLowercase.length > 0) {
      foundLowercase.forEach(ch => console.log(`     ❌ ${ch}`));
    }
    
    // Check recent data
    const now = Date.now();
    const oneMinuteAgo = now - (60 * 1000);
    
    console.log(`\n⏰ Checking recent data (last minute)...`);
    const testChannels = foundNormalized.length > 0 ? foundNormalized : foundLowercase;
    
    if (testChannels.length > 0) {
      for (const channel of testChannels.slice(0, 3)) {
        try {
          const dataResult = await checkData(sourceId, channel, oneMinuteAgo, now);
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
    } else {
      console.log('   No navigation channels found to test');
    }
    
  } catch (err) {
    console.error('❌ Debug failed:', err.message);
  }
}

debug().catch(console.error);

