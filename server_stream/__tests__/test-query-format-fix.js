/**
 * Test to verify the query format fix works
 * Simulates what happens after first data point is stored
 */

const http = require('http');
const { URL } = require('url');

const INFLUX_HOST = process.env.INFLUX_HOST || '192.168.0.18';
const INFLUX_PORT = process.env.INFLUX_PORT || 8086;
const INFLUX_DATABASE = process.env.INFLUX_DATABASE || 'sailgp';

function calculateTimeRange(sinceTime) {
  const timeDiffMs = Date.now() - sinceTime;
  
  // Convert to relative time string (simulator prefers 'now() - X' format)
  // Use seconds if less than 60s, minutes if less than 60m, hours otherwise
  let timeRange;
  if (timeDiffMs < 60000) {
    timeRange = `${Math.ceil(timeDiffMs / 1000)}s`;
  } else if (timeDiffMs < 3600000) {
    timeRange = `${Math.ceil(timeDiffMs / 60000)}m`;
  } else {
    timeRange = `${Math.ceil(timeDiffMs / 3600000)}h`;
  }
  
  return timeRange;
}

async function testQuery(query, description) {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const urlString = `http://${INFLUX_HOST}:${INFLUX_PORT}/query?db=${encodeURIComponent(INFLUX_DATABASE)}&q=${encodedQuery}`;
    
    console.log(`\n📋 ${description}`);
    console.log(`   Query: ${query}`);
    
    http.get(urlString, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.log(`   ❌ Failed: ${res.statusCode}`);
          resolve(false);
          return;
        }
        try {
          const result = JSON.parse(data);
          const series = result.results?.[0]?.series?.[0];
          if (series && series.values && series.values.length > 0) {
            console.log(`   ✅ Success: ${series.values.length} rows`);
            resolve(true);
          } else {
            console.log(`   ❌ No data returned`);
            resolve(false);
          }
        } catch (err) {
          console.log(`   ❌ Parse error: ${err.message}`);
          resolve(false);
        }
      });
    }).on('error', (err) => {
      console.log(`   ❌ Request error: ${err.message}`);
      resolve(false);
    });
  });
}

async function runTest() {
  console.log('🧪 Testing Query Format Fix\n');
  console.log('='.repeat(60));
  
  // Simulate: First query works (no lastDataTimestamp)
  console.log('\n1. First query (no previous data):');
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - 1m`,
    "Base query format"
  );
  
  // Simulate: After first data point, we have a timestamp
  // Let's test with various timestamps
  console.log('\n2. Subsequent queries (with lastDataTimestamp):');
  
  // Test with 1 minute ago
  const oneMinuteAgo = Date.now() - 60000;
  const timeRange1m = calculateTimeRange(oneMinuteAgo);
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - ${timeRange1m}`,
    `Using calculated time range: ${timeRange1m} (from 1 minute ago)`
  );
  
  // Test with 5 minutes ago
  const fiveMinutesAgo = Date.now() - 300000;
  const timeRange5m = calculateTimeRange(fiveMinutesAgo);
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - ${timeRange5m}`,
    `Using calculated time range: ${timeRange5m} (from 5 minutes ago)`
  );
  
  // Test with 1 hour ago
  const oneHourAgo = Date.now() - 3600000;
  const timeRange1h = calculateTimeRange(oneHourAgo);
  await testQuery(
    `SELECT * FROM sailgp WHERE time > now() - ${timeRange1h}`,
    `Using calculated time range: ${timeRange1h} (from 1 hour ago)`
  );
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ Query format fix test complete');
  console.log('\n💡 The fix converts timestamps to relative time strings');
  console.log('   instead of using nanoseconds, which the simulator');
  console.log('   does not support in WHERE clauses.');
}

runTest().catch(console.error);

