/**
 * Test Query Format Scenarios
 * Specifically tests the query format fix for various time ranges
 */

const http = require('http');

const INFLUX_HOST = process.env.INFLUX_HOST || '192.168.0.18';
const INFLUX_PORT = process.env.INFLUX_PORT || 8086;
const INFLUX_DATABASE = process.env.INFLUX_DATABASE || 'sailgp';

function calculateTimeRange(sinceTime) {
  const timeDiffMs = Date.now() - sinceTime;
  
  if (timeDiffMs < 60000) {
    return `${Math.ceil(timeDiffMs / 1000)}s`;
  } else if (timeDiffMs < 3600000) {
    return `${Math.ceil(timeDiffMs / 60000)}m`;
  } else {
    return `${Math.ceil(timeDiffMs / 3600000)}h`;
  }
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
          reject(new Error(`Query failed: ${res.statusCode} - ${data.substring(0, 200)}`));
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

async function testScenario(description, sinceTime) {
  try {
    const timeRange = calculateTimeRange(sinceTime);
    // Remove LIMIT as simulator doesn't support it
    const query = `SELECT * FROM sailgp WHERE time > now() - ${timeRange}`;
    
    const result = await queryInfluxDB(query);
    const rows = result.results?.[0]?.series?.[0]?.values?.length || 0;
    
    if (rows > 0) {
      console.log(`   ✅ ${description}: ${rows} rows (time range: ${timeRange})`);
      return true;
    } else {
      console.log(`   ❌ ${description}: No data returned (time range: ${timeRange})`);
      return false;
    }
  } catch (err) {
    console.log(`   ❌ ${description}: ${err.message}`);
    return false;
  }
}

async function runTests() {
  console.log('🧪 Query Format Scenario Tests\n');
  console.log('='.repeat(60));
  
  const scenarios = [
    { desc: 'Initial query (no previous data)', time: null },
    { desc: '10 seconds ago', time: Date.now() - 10000 },
    { desc: '30 seconds ago', time: Date.now() - 30000 },
    { desc: '1 minute ago', time: Date.now() - 60000 },
    { desc: '5 minutes ago', time: Date.now() - 300000 },
    { desc: '15 minutes ago', time: Date.now() - 900000 },
    { desc: '1 hour ago', time: Date.now() - 3600000 },
    { desc: '2 hours ago', time: Date.now() - 7200000 }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const scenario of scenarios) {
    if (scenario.time === null) {
      // Test initial query - remove LIMIT as simulator doesn't support it
      try {
        const query = `SELECT * FROM sailgp WHERE time > now() - 1m`;
        const result = await queryInfluxDB(query);
        const rows = result.results?.[0]?.series?.[0]?.values?.length || 0;
        if (rows > 0) {
          console.log(`   ✅ ${scenario.desc}: ${rows} rows`);
          passed++;
        } else {
          console.log(`   ❌ ${scenario.desc}: No data returned`);
          failed++;
        }
      } catch (err) {
        console.log(`   ❌ ${scenario.desc}: ${err.message}`);
        failed++;
      }
    } else {
      const result = await testScenario(scenario.desc, scenario.time);
      if (result) {
        passed++;
      } else {
        failed++;
      }
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('✅ All query format scenarios passed!');
    process.exit(0);
  } else {
    console.log('❌ Some scenarios failed. Review the errors above.');
    process.exit(1);
  }
}

runTests().catch(console.error);

