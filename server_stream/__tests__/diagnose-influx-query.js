/**
 * Diagnostic script to check what InfluxDB source is querying and receiving
 * Run with: node server_stream/__tests__/diagnose-influx-query.js
 */

const http = require('http');
const { URL } = require('url');

const INFLUX_HOST = process.env.INFLUX_HOST || '192.168.0.18';
const INFLUX_PORT = process.env.INFLUX_PORT || 8086;
const INFLUX_DATABASE = process.env.INFLUX_DATABASE || 'sailgp';
const baseUrl = `http://${INFLUX_HOST}:${INFLUX_PORT}`;

async function queryInfluxDB(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const urlString = `${baseUrl}/query?db=${encodeURIComponent(INFLUX_DATABASE)}&q=${encodedQuery}`;
    
    http.get(urlString, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Query failed: ${res.statusCode} - ${data}`));
          return;
        }
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
  console.log('🔍 Diagnosing InfluxDB Query Issues...\n');
  console.log(`InfluxDB: ${baseUrl}`);
  console.log(`Database: ${INFLUX_DATABASE}\n`);
  
  try {
    // Test 1: Query recent data (last hour) - what the source should be querying
    console.log('1. Testing query for recent data (last hour)...');
    const recentQuery = `SELECT * FROM sailgp WHERE time > now() - 1h LIMIT 10`;
    
    try {
      const recentResult = await queryInfluxDB(recentQuery);
      if (recentResult.results && recentResult.results[0] && recentResult.results[0].series) {
        const series = recentResult.results[0].series;
        console.log(`   ✅ Query successful`);
        console.log(`   ✅ Found ${series.length} series`);
        
        if (series.length > 0) {
          const firstSeries = series[0];
          console.log(`   ✅ Series: ${firstSeries.name}`);
          console.log(`   ✅ Tags: ${JSON.stringify(firstSeries.tags)}`);
          console.log(`   ✅ Columns: ${firstSeries.columns.length} columns`);
          console.log(`   ✅ Values: ${firstSeries.values.length} rows`);
          
          if (firstSeries.values.length > 0) {
            console.log(`\n   Sample row (first):`);
            const row = firstSeries.values[0];
            firstSeries.columns.forEach((col, idx) => {
              if (col !== 'time') {
                console.log(`     ${col}: ${row[idx]}`);
              }
            });
          }
        }
      } else {
        console.log(`   ⚠️  Query returned no data`);
      }
    } catch (err) {
      console.log(`   ❌ Query failed: ${err.message}`);
    }
    
    // Test 2: Query with time range (what source uses when no previous data)
    console.log('\n2. Testing query with time range (last 1 minute)...');
    const timeRangeQuery = `SELECT * FROM sailgp WHERE time > now() - 1m LIMIT 10`;
    
    try {
      const timeRangeResult = await queryInfluxDB(timeRangeQuery);
      if (timeRangeResult.results && timeRangeResult.results[0] && timeRangeResult.results[0].series) {
        const series = timeRangeResult.results[0].series;
        console.log(`   ✅ Query successful`);
        console.log(`   ✅ Found ${series.length} series`);
        console.log(`   ✅ Total rows: ${series.reduce((sum, s) => sum + (s.values?.length || 0), 0)}`);
      } else {
        console.log(`   ⚠️  Query returned no data (this is OK if no data in last minute)`);
      }
    } catch (err) {
      console.log(`   ❌ Query failed: ${err.message}`);
    }
    
    // Test 3: Check what sources are available
    console.log('\n3. Checking available sources...');
    const sourcesQuery = `SHOW TAG VALUES FROM sailgp WITH KEY = "source"`;
    
    try {
      const sourcesResult = await queryInfluxDB(sourcesQuery);
      if (sourcesResult.results && sourcesResult.results[0] && sourcesResult.results[0].series) {
        const series = sourcesResult.results[0].series;
        if (series.length > 0 && series[0].values) {
          const sources = series[0].values.map(v => v[1]);
          console.log(`   ✅ Found ${sources.length} sources: ${sources.join(', ')}`);
        } else {
          console.log(`   ⚠️  No sources found`);
        }
      }
    } catch (err) {
      console.log(`   ❌ Query failed: ${err.message}`);
    }
    
    // Test 4: Check channel names in data
    console.log('\n4. Checking channel names in data...');
    const channelQuery = `SELECT * FROM sailgp WHERE time > now() - 1h LIMIT 1`;
    
    try {
      const channelResult = await queryInfluxDB(channelQuery);
      if (channelResult.results && channelResult.results[0] && channelResult.results[0].series) {
        const series = channelResult.results[0].series;
        if (series.length > 0) {
          const columns = series[0].columns.filter(c => c !== 'time');
          console.log(`   ✅ Found ${columns.length} channels:`);
          columns.forEach((col, idx) => {
            const isLowercase = col === col.toLowerCase() && col !== col.toUpperCase();
            const marker = isLowercase ? '❌' : '✅';
            console.log(`     ${marker} ${col}`);
          });
          
          const lowercaseChannels = columns.filter(c => c === c.toLowerCase() && c !== c.toUpperCase());
          if (lowercaseChannels.length > 0) {
            console.log(`\n   ⚠️  Found ${lowercaseChannels.length} lowercase channels (will be normalized by processor)`);
          }
        }
      }
    } catch (err) {
      console.log(`   ❌ Query failed: ${err.message}`);
    }
    
    console.log('\n✅ Diagnosis complete!');
    console.log('\n📋 Next steps:');
    console.log('   - If queries return data, check server logs for processing errors');
    console.log('   - If queries return no data, check InfluxDB time range');
    console.log('   - Check server logs for "[InfluxDBSource] Source X received N data points"');
    
  } catch (err) {
    console.error('❌ Diagnosis failed:', err.message);
  }
}

diagnose().catch(console.error);

