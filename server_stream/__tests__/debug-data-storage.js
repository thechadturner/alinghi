/**
 * Debug script to trace why data isn't being stored in Redis
 * Checks each step of the data flow
 */

const http = require('http');
const { URL } = require('url');
const processor = require('../controllers/processor');
const redisStorage = require('../controllers/redis');
const { log, error } = require('../../shared');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';
const INFLUX_HOST = process.env.INFLUX_HOST || '192.168.0.18';
const INFLUX_PORT = process.env.INFLUX_PORT || 8086;
const INFLUX_DATABASE = process.env.INFLUX_DATABASE || 'sailgp';

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

async function queryInfluxDB(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const urlString = `http://${INFLUX_HOST}:${INFLUX_PORT}/query?db=${encodeURIComponent(INFLUX_DATABASE)}&q=${encodedQuery}`;
    
    http.get(urlString, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Query failed: ${res.statusCode} - ${data}`));
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

async function testProcessorWithRealData() {
  console.log('🔍 Testing Processor with Real InfluxDB Data...\n');
  
  try {
    // Step 1: Get real data from InfluxDB
    console.log('1. Fetching real data from InfluxDB...');
    const query = `SELECT * FROM sailgp WHERE time > now() - 1h LIMIT 1`;
    const result = await queryInfluxDB(query);
    
    if (!result.results || !result.results[0] || !result.results[0].series || result.results[0].series.length === 0) {
      console.log('   ❌ No data returned from InfluxDB');
      return;
    }
    
    const series = result.results[0].series[0];
    console.log(`   ✅ Got data: ${series.values.length} rows, ${series.columns.length} columns`);
    console.log(`   ✅ Columns: ${series.columns.slice(0, 10).join(', ')}...`);
    
    // Step 2: Parse like InfluxDB source does
    console.log('\n2. Parsing data like InfluxDB source...');
    const timeIndex = series.columns.indexOf('time');
    if (timeIndex === -1) {
      console.log('   ❌ No time column found');
      return;
    }
    
    const row = series.values[0];
    const timeNs = parseInt(row[timeIndex], 10);
    const timestamp = Math.floor(timeNs / 1000000);
    
    // Build data point like InfluxDB source does
    const dataPoint = {
      source_id: 1,
      timestamp: timestamp,
      data: {
        source: series.tags?.source || 'GBR',
        source_name: series.tags?.source || 'GBR'
      }
    };
    
    // Add field values
    for (let i = 0; i < series.columns.length; i++) {
      if (i === timeIndex) continue;
      const columnName = series.columns[i];
      const value = row[i];
      if (value !== undefined && value !== null && value !== '') {
        const numValue = parseFloat(value);
        dataPoint.data[columnName] = isNaN(numValue) ? value : numValue;
      }
    }
    
    console.log(`   ✅ Built data point with ${Object.keys(dataPoint.data).length} channels`);
    console.log(`   ✅ Sample channels: ${Object.keys(dataPoint.data).slice(0, 10).join(', ')}`);
    
    // Step 3: Process through processor
    console.log('\n3. Processing through processor...');
    const processed = processor.process(dataPoint);
    
    if (!processed) {
      console.log('   ❌ Processor returned null!');
      return;
    }
    
    console.log(`   ✅ Processor returned data`);
    console.log(`   ✅ Processed channels: ${Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime').length}`);
    
    // Check normalization
    const normalized = ['Lat', 'Lng', 'Hdg', 'Cog', 'Sog'];
    const lowercase = ['lat', 'lng', 'hdg', 'cog', 'sog'];
    const processedChannels = Object.keys(processed.data);
    
    const hasNormalized = normalized.some(ch => processedChannels.includes(ch));
    const hasLowercase = lowercase.some(ch => processedChannels.includes(ch));
    
    console.log(`   ✅ Has normalized channels: ${hasNormalized}`);
    console.log(`   ${hasLowercase ? '❌' : '✅'} Has lowercase duplicates: ${hasLowercase}`);
    
    // Step 4: Connect to Redis and store
    console.log('\n4. Storing in Redis...');
    await redisStorage.connect();
    
    let attempts = 0;
    while (!redisStorage.isConnected && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!redisStorage.isConnected) {
      console.log('   ❌ Redis not connected');
      return;
    }
    
    console.log('   ✅ Redis connected');
    
    const testSourceId = 888; // Use different ID for test
    const channelsToStore = Object.keys(processed.data).filter(k => k !== 'timestamp' && k !== 'Datetime');
    
    let storedCount = 0;
    let errorCount = 0;
    
    for (const channel of channelsToStore) {
      const value = processed.data[channel];
      if (value !== undefined && value !== null) {
        try {
          await redisStorage.store(testSourceId, channel, processed.timestamp, value);
          storedCount++;
        } catch (err) {
          errorCount++;
          console.log(`   ❌ Error storing ${channel}: ${err.message}`);
        }
      }
    }
    
    console.log(`   ✅ Stored ${storedCount} channels, ${errorCount} errors`);
    
    // Step 5: Verify in Redis
    console.log('\n5. Verifying in Redis...');
    const storedChannels = await redisStorage.getChannels(testSourceId);
    console.log(`   ✅ Found ${storedChannels.length} channels in Redis`);
    
    if (storedChannels.length > 0) {
      console.log(`   ✅ Sample channels: ${storedChannels.slice(0, 10).join(', ')}`);
      
      // Check for normalized
      const foundNormalized = storedChannels.filter(ch => normalized.includes(ch));
      const foundLowercase = storedChannels.filter(ch => lowercase.includes(ch));
      
      console.log(`   ✅ Normalized channels: ${foundNormalized.length}`);
      console.log(`   ${foundLowercase.length > 0 ? '❌' : '✅'} Lowercase channels: ${foundLowercase.length}`);
    }
    
    console.log('\n✅ Test complete!');
    
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
  }
}

testProcessorWithRealData().catch(console.error);

