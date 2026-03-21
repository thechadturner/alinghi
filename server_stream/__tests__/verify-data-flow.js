/**
 * Comprehensive diagnostic to verify data flow from InfluxDB → Redis → Frontend
 */

const http = require('http');
const { URL } = require('url');
const redisStorage = require('../controllers/redis');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';

async function checkStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${STREAM_SERVER_URL}/api/stream/debug/status`);
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function getChannelsFromRedis(sourceId) {
  await redisStorage.connect();
  let attempts = 0;
  while (!redisStorage.isConnected && attempts < 50) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
  if (!redisStorage.isConnected) {
    throw new Error('Redis not connected');
  }
  return await redisStorage.getChannels(sourceId);
}

async function getChannelData(sourceId, channel, startTime, endTime) {
  return await redisStorage.query(sourceId, channel, startTime, endTime);
}

async function runDiagnostic() {
  console.log('🔍 Comprehensive Data Flow Diagnostic\n');
  console.log('='.repeat(60));
  
  try {
    // Step 1: Check server status
    console.log('\n1. Checking streaming server status...');
    const status = await checkStatus();
    console.log(`   ✅ Server running: ${status.server === 'running'}`);
    console.log(`   ✅ Redis connected: ${status.redis === 'connected'}`);
    console.log(`   ✅ Active connections: ${status.connections?.length || 0}`);
    
    if (status.connections && status.connections.length > 0) {
      const source1 = status.connections.find(c => c.source_id === 1);
      if (source1) {
        console.log(`   ✅ Source 1 state: ${source1.state}`);
        console.log(`   ✅ Source 1 last query: ${source1.lastQueryTime ? new Date(source1.lastQueryTime).toISOString() : 'never'}`);
      }
    }
    
    // Step 2: Check Redis channels
    console.log('\n2. Checking Redis channels for source 1...');
    const channels = await getChannelsFromRedis(1);
    console.log(`   ✅ Found ${channels.length} channels in Redis`);
    
    if (channels.length > 0) {
      console.log(`   ✅ Sample channels: ${channels.slice(0, 10).join(', ')}`);
      
      // Check for normalized channels
      const normalized = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
      const foundNormalized = channels.filter(ch => normalized.includes(ch));
      const lowercase = ['lat', 'lng', 'hdg', 'cog', 'sog'];
      const foundLowercase = channels.filter(ch => lowercase.includes(ch));
      
      console.log(`   ✅ Normalized channels found: ${foundNormalized.length} (${foundNormalized.join(', ')})`);
      console.log(`   ${foundLowercase.length > 0 ? '❌' : '✅'} Lowercase duplicates: ${foundLowercase.length}`);
      
      // Step 3: Check data points for key channels
      console.log('\n3. Checking data points in Redis...');
      const now = Date.now();
      const oneHourAgo = now - 3600000;
      
      for (const channel of ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog']) {
        if (channels.includes(channel)) {
          const data = await getChannelData(1, channel, oneHourAgo, now);
          console.log(`   ✅ ${channel}: ${data.length} points in last hour`);
          if (data.length > 0) {
            const latest = data[data.length - 1];
            console.log(`      Latest: ${new Date(latest.timestamp).toISOString()}, value: ${latest.value}`);
          }
        } else {
          console.log(`   ❌ ${channel}: Not found in Redis`);
        }
      }
      
      // Step 4: Check recent data (last 5 minutes)
      console.log('\n4. Checking recent data (last 5 minutes)...');
      const fiveMinutesAgo = now - 300000;
      let recentDataCount = 0;
      for (const channel of ['Lat', 'Lng']) {
        if (channels.includes(channel)) {
          const data = await getChannelData(1, channel, fiveMinutesAgo, now);
          recentDataCount += data.length;
        }
      }
      console.log(`   ${recentDataCount > 0 ? '✅' : '❌'} Recent data points: ${recentDataCount}`);
      
      if (recentDataCount === 0) {
        console.log('   ⚠️  WARNING: No recent data found! Data may not be flowing.');
        console.log('   💡 Check if:');
        console.log('      1. InfluxDB source is querying successfully');
        console.log('      2. Processor is processing data');
        console.log('      3. Redis storage is working');
        console.log('      4. Server has been restarted with the query format fix');
      }
    } else {
      console.log('   ❌ NO CHANNELS FOUND IN REDIS!');
      console.log('   💡 This means data is not being stored.');
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Diagnostic complete');
    
  } catch (err) {
    console.error('❌ Diagnostic failed:', err.message);
    console.error(err.stack);
  }
}

runDiagnostic().catch(console.error);

