/**
 * Diagnostic script to check streaming server data flow
 * Run with: node server_stream/__tests__/diagnose-streaming.js
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

async function diagnose() {
  console.log('🔍 Diagnosing Streaming Server Data Flow...\n');
  
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
    console.log(`   Redis Host: ${status.data.redis.host}:${status.data.redis.port}`);
    console.log(`   Active Connections: ${status.data.connections.count}`);
    
    if (status.data.connections.count === 0) {
      console.log('\n⚠️  No active connections found. Check if InfluxDB simulator is running and auto-discovery is working.');
      return;
    }
    
    // Show connections
    console.log('\n   Connections:');
    status.data.connections.sources.forEach(conn => {
      console.log(`     - Source ${conn.source_id} (${conn.type}): ${conn.state}`);
    });
    
    // Check sample data
    if (status.data.sampleData) {
      console.log('\n   Sample Data:');
      console.log(`     Source: ${status.data.sampleData.source_id}`);
      console.log(`     Channel: ${status.data.sampleData.channel}`);
      console.log(`     Latest: ${status.data.sampleData.latest ? JSON.stringify(status.data.sampleData.latest) : 'N/A'}`);
    }
    
    // Check channels for first source
    if (status.data.connections.sources.length > 0) {
      const firstSource = status.data.connections.sources[0];
      console.log(`\n2. Checking channels for source ${firstSource.source_id}...`);
      
      try {
        const channelsResult = await checkChannels(firstSource.source_id);
        if (channelsResult.success && channelsResult.data.channels) {
          console.log(`   ✅ Found ${channelsResult.data.channels.length} channels:`);
          channelsResult.data.channels.slice(0, 10).forEach(ch => {
            console.log(`     - ${ch}`);
          });
          if (channelsResult.data.channels.length > 10) {
            console.log(`     ... and ${channelsResult.data.channels.length - 10} more`);
          }
          
          // Check data for navigation channels
          const navChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog', 'lat', 'lng', 'hdg', 'cog', 'sog'];
          const foundNavChannels = channelsResult.data.channels.filter(ch => navChannels.includes(ch));
          
          if (foundNavChannels.length > 0) {
            console.log(`\n3. Checking data for navigation channels...`);
            const now = Date.now();
            const oneHourAgo = now - (60 * 60 * 1000);
            
            for (const channel of foundNavChannels.slice(0, 3)) {
              try {
                const dataResult = await checkData(firstSource.source_id, channel, oneHourAgo, now);
                if (dataResult.success && dataResult.data) {
                  console.log(`   ✅ Channel ${channel}: ${dataResult.data.count} data points`);
                  if (dataResult.data.count > 0 && dataResult.data.data.length > 0) {
                    const first = dataResult.data.data[0];
                    const last = dataResult.data.data[dataResult.data.data.length - 1];
                    console.log(`      First: ${new Date(first.timestamp).toISOString()}, Value: ${first.value}`);
                    console.log(`      Last: ${new Date(last.timestamp).toISOString()}, Value: ${last.value}`);
                  }
                } else {
                  console.log(`   ⚠️  Channel ${channel}: No data returned`);
                }
              } catch (err) {
                console.log(`   ❌ Channel ${channel}: Error - ${err.message}`);
              }
            }
          } else {
            console.log('\n⚠️  No navigation channels (Lat, Lng, Hdg, Cog, Sog) found in Redis');
            console.log('   This suggests data is not being stored properly.');
          }
        } else {
          console.log('   ⚠️  No channels found or error retrieving channels');
        }
      } catch (err) {
        console.log(`   ❌ Error checking channels: ${err.message}`);
      }
    }
    
    console.log('\n✅ Diagnosis complete!');
    console.log('\n📋 What to check in server logs:');
    console.log('   - Look for: "[StreamController] Source X received data point"');
    console.log('   - Look for: "[StreamController] Source X processed data point, storing N channels to Redis"');
    console.log('   - Look for: "[RedisStorage] Error storing" (if there are storage errors)');
    console.log('   - Look for: "[StreamController] Source X data point processing returned null" (if processing fails)');
    
  } catch (err) {
    console.error('❌ Diagnosis failed:', err.message);
    console.error('   Make sure the streaming server is running on', STREAM_SERVER_URL);
  }
}

diagnose().catch(console.error);

