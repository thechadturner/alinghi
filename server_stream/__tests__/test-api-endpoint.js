/**
 * Test the API endpoint directly to see if it's returning data
 */

const http = require('http');
const { URL } = require('url');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';
const TEST_SOURCE_ID = 1;

// Note: This would need authentication in production
// For testing, we'll use the debug endpoint or check if we can query directly

async function testAPIEndpoint(sourceId, channel, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${sourceId}/data`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('startTime', startTime.toString());
    url.searchParams.set('endTime', endTime.toString());
    
    console.log(`\n📋 Testing API endpoint:`);
    console.log(`   URL: ${url.toString().replace(/token=[^&]+/, 'token=***')}`);
    console.log(`   Channel: ${channel}`);
    console.log(`   Start: ${new Date(startTime).toISOString()} (${startTime})`);
    console.log(`   End: ${new Date(endTime).toISOString()} (${endTime})`);
    
    http.get(url.toString(), (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log(`   Status: ${res.statusCode}`);
          if (result.success && result.data) {
            const pointCount = result.data.data?.length || 0;
            console.log(`   ✅ Success: ${pointCount} points`);
            if (pointCount > 0) {
              const first = result.data.data[0];
              const last = result.data.data[result.data.data.length - 1];
              console.log(`   First point: ${new Date(first.timestamp).toISOString()}`);
              console.log(`   Last point: ${new Date(last.timestamp).toISOString()}`);
            }
            resolve({ status: res.statusCode, success: true, pointCount, result });
          } else {
            console.log(`   ❌ Failed: ${result.message || 'Unknown error'}`);
            resolve({ status: res.statusCode, success: false, result });
          }
        } catch (err) {
          console.log(`   ❌ Parse error: ${err.message}`);
          console.log(`   Response: ${data.substring(0, 200)}`);
          resolve({ status: res.statusCode, success: false, error: err.message, raw: data });
        }
      });
    }).on('error', (err) => {
      console.log(`   ❌ Request error: ${err.message}`);
      resolve({ status: 0, success: false, error: err.message });
    });
  });
}

async function testChannels() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/sources/${TEST_SOURCE_ID}/channels`);
    
    console.log(`\n📋 Testing channels endpoint:`);
    console.log(`   URL: ${url.toString()}`);
    
    http.get(url.toString(), (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success && result.data) {
            const channels = result.data.channels || [];
            console.log(`   ✅ Success: ${channels.length} channels`);
            console.log(`   Channels: ${channels.slice(0, 10).join(', ')}${channels.length > 10 ? '...' : ''}`);
            resolve({ success: true, channels });
          } else {
            console.log(`   ❌ Failed: ${result.message || 'Unknown error'}`);
            resolve({ success: false, result });
          }
        } catch (err) {
          console.log(`   ❌ Parse error: ${err.message}`);
          resolve({ success: false, error: err.message });
        }
      });
    }).on('error', reject);
  });
}

async function runTest() {
  console.log('🧪 Testing API Endpoints for Streaming Data\n');
  console.log('='.repeat(60));
  
  // Test 1: Get available channels
  const channelsResult = await testChannels();
  
  if (!channelsResult.success || !channelsResult.channels) {
    console.log('\n❌ Could not get channels, cannot test data endpoints');
    process.exit(1);
  }
  
  const channels = channelsResult.channels;
  const navChannels = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
  const availableNavChannels = navChannels.filter(ch => channels.includes(ch));
  
  if (availableNavChannels.length === 0) {
    console.log('\n❌ No navigation channels found in Redis');
    process.exit(1);
  }
  
  console.log(`\n✅ Found navigation channels: ${availableNavChannels.join(', ')}`);
  
  // Test 2: Query data for each navigation channel
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  console.log('\n' + '='.repeat(60));
  console.log('Testing data queries (last 1 hour):');
  console.log('='.repeat(60));
  
  let totalPoints = 0;
  for (const channel of availableNavChannels) {
    const result = await testAPIEndpoint(TEST_SOURCE_ID, channel, oneHourAgo, now);
    if (result.success && result.pointCount) {
      totalPoints += result.pointCount;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`📊 Summary: ${totalPoints} total points across ${availableNavChannels.length} channels`);
  
  if (totalPoints === 0) {
    console.log('\n❌ No data returned from API endpoints!');
    console.log('   This means either:');
    console.log('   1. Data is not in Redis');
    console.log('   2. Time range is wrong');
    console.log('   3. API endpoint has an issue');
    process.exit(1);
  } else {
    console.log('\n✅ API endpoints are returning data!');
    process.exit(0);
  }
}

runTest().catch(console.error);

