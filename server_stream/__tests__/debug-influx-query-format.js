/**
 * Debug script to test InfluxDB query formats
 * Compares what works vs what the code uses
 */

const http = require('http');
const { URL } = require('url');

const INFLUX_HOST = process.env.INFLUX_HOST || '192.168.0.18';
const INFLUX_PORT = process.env.INFLUX_PORT || 8086;
const INFLUX_DATABASE = process.env.INFLUX_DATABASE || 'sailgp';

async function testQuery(query, description) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const urlString = `http://${INFLUX_HOST}:${INFLUX_PORT}/query?db=${encodeURIComponent(INFLUX_DATABASE)}&q=${encodedQuery}`;
    
    console.log(`\n📋 Testing: ${description}`);
    console.log(`   Query: ${query}`);
    
    const startTime = Date.now();
    http.get(urlString, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const duration = Date.now() - startTime;
        if (res.statusCode !== 200) {
          console.log(`   ❌ Failed: ${res.statusCode} - ${data.substring(0, 200)}`);
          resolve({ success: false, statusCode: res.statusCode, error: data });
          return;
        }
        try {
          const result = JSON.parse(data);
          const series = result.results?.[0]?.series?.[0];
          if (series) {
            const rowCount = series.values?.length || 0;
            const columnCount = series.columns?.length || 0;
            console.log(`   ✅ Success: ${rowCount} rows, ${columnCount} columns (${duration}ms)`);
            if (rowCount > 0) {
              console.log(`   ✅ Sample columns: ${series.columns.slice(0, 10).join(', ')}`);
            }
            resolve({ success: true, rowCount, columnCount, series });
          } else {
            console.log(`   ⚠️  No data: ${JSON.stringify(result.results?.[0])}`);
            resolve({ success: true, rowCount: 0, result });
          }
        } catch (err) {
          console.log(`   ❌ Parse error: ${err.message}`);
          resolve({ success: false, error: err.message });
        }
      });
    }).on('error', (err) => {
      console.log(`   ❌ Request error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

async function runTests() {
  console.log('🧪 Testing InfluxDB Query Formats\n');
  console.log('='.repeat(60));
  
  // Test 1: User's working query
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - 1h`,
    "User's working query (1h)"
  );
  
  // Test 2: Code's default query (1m)
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - 1m`,
    "Code's default query (1m)"
  );
  
  // Test 3: Code's query with nanoseconds (what happens after first data)
  const oneHourAgoNs = (Date.now() - 3600000) * 1000000;
  await testQuery(
    `SELECT * FROM sailgp WHERE time > ${oneHourAgoNs}`,
    "Code's nanoseconds query (after first data)"
  );
  
  // Test 4: Code's query with nanoseconds (recent)
  const oneMinuteAgoNs = (Date.now() - 60000) * 1000000;
  await testQuery(
    `SELECT * FROM sailgp WHERE time > ${oneMinuteAgoNs}`,
    "Code's nanoseconds query (1 minute ago)"
  );
  
  // Test 5: Check what time format the data actually uses
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - 5m LIMIT 1`,
    "Sample data point to check timestamp format"
  );
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ Query format tests complete');
}

runTests().catch(console.error);

