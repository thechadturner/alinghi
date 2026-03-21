/**
 * Debug script to check streaming server status and diagnose why sources aren't connecting
 */

const http = require('http');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';

async function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = `${STREAM_SERVER_URL}${path}`;
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (err) {
          resolve({ status: res.statusCode, data: data, error: err.message });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  console.log('='.repeat(80));
  console.log('Streaming Server Debug');
  console.log('='.repeat(80));
  console.log(`Server URL: ${STREAM_SERVER_URL}\n`);

  try {
    // 1. Check monitoring status
    console.log('1. Checking Monitoring Status:');
    console.log('-'.repeat(80));
    try {
      const monitoring = await makeRequest('/api/stream/monitoring/status');
      console.log(`   Status Code: ${monitoring.status}`);
      if (monitoring.status === 200 && monitoring.data && monitoring.data.success) {
        const data = monitoring.data.data;
        console.log(`   ✓ Streaming Started: ${data.streamingStarted}`);
        console.log(`   ✓ InfluxDB Enabled: ${data.influxdb?.enabled}`);
        console.log(`   ✓ InfluxDB Streaming: ${data.influxdb?.streaming}`);
        console.log(`   ✓ Active Connections: ${data.influxdb?.active_connections || 0}`);
        console.log(`   ✓ Total Queries: ${data.influxdb?.query_stats?.total_queries || 0}`);
        console.log(`   ✓ Successful Queries: ${data.influxdb?.query_stats?.successful_queries || 0}`);
        console.log(`   ✓ Failed Queries: ${data.influxdb?.query_stats?.failed_queries || 0}`);
        if (data.influxdb?.query_stats?.last_query_error) {
          console.log(`   ✗ Last Query Error: ${data.influxdb.query_stats.last_query_error}`);
        }
      } else if (monitoring.status === 401) {
        console.log('   ⚠️  Requires authentication');
      } else {
        console.log(`   ✗ Error: ${JSON.stringify(monitoring.data, null, 2)}`);
      }
    } catch (err) {
      console.log(`   ✗ Error: ${err.message}`);
    }
    console.log('');

    // 2. Check InfluxDB test endpoint (no auth required)
    console.log('2. Testing InfluxDB Connection:');
    console.log('-'.repeat(80));
    try {
      const influxTest = await makeRequest('/api/stream/debug/test-influx');
      console.log(`   Status Code: ${influxTest.status}`);
      if (influxTest.status === 200 && influxTest.data) {
        if (influxTest.data.success) {
          console.log(`   ✓ InfluxDB connection: OK`);
          console.log(`   ✓ Health: ${JSON.stringify(influxTest.data.health, null, 2)}`);
          if (influxTest.data.discovery && influxTest.data.discovery.sources) {
            console.log(`   ✓ Discovered sources: ${influxTest.data.discovery.sources.join(', ')}`);
            console.log(`   ✓ Source count: ${influxTest.data.discovery.sources.length}`);
          } else {
            console.log(`   ⚠️  No sources discovered`);
          }
        } else {
          console.log(`   ✗ InfluxDB connection failed`);
          console.log(`   Error: ${JSON.stringify(influxTest.data, null, 2)}`);
        }
      } else {
        console.log(`   ✗ Unexpected response: ${JSON.stringify(influxTest.data, null, 2)}`);
      }
    } catch (err) {
      console.log(`   ✗ Error: ${err.message}`);
    }
    console.log('');

    // 3. Check sources endpoint
    console.log('3. Checking Sources:');
    console.log('-'.repeat(80));
    try {
      const sources = await makeRequest('/api/stream/sources');
      console.log(`   Status Code: ${sources.status}`);
      if (sources.status === 200 && sources.data && sources.data.success) {
        console.log(`   ✓ Sources found: ${sources.data.data?.length || 0}`);
        if (sources.data.data && sources.data.data.length > 0) {
          sources.data.data.forEach((source, idx) => {
            console.log(`     ${idx + 1}. ${source.source_name}`);
          });
        } else {
          console.log(`   ⚠️  No sources in Redis`);
        }
      } else if (sources.status === 401) {
        console.log('   ⚠️  Requires authentication');
      } else {
        console.log(`   ✗ Error: ${JSON.stringify(sources.data, null, 2)}`);
      }
    } catch (err) {
      console.log(`   ✗ Error: ${err.message}`);
    }
    console.log('');

    // 4. Summary and recommendations
    console.log('='.repeat(80));
    console.log('Diagnosis:');
    console.log('='.repeat(80));
    console.log('If streaming shows inactive with 0 connections and 0 queries:');
    console.log('');
    console.log('1. Verify InfluxDB streaming is ENABLED (toggle should be ON/green)');
    console.log('2. Verify "Start Streaming" button was clicked (should show "Stop Streaming" after)');
    console.log('3. Check server logs for:');
    console.log('   - "[StreamController] Streaming explicitly started from admin page"');
    console.log('   - "[StreamController] Attempting auto-discovery of InfluxDB 2.x sources..."');
    console.log('   - "[StreamController] Discovered X sources: ..."');
    console.log('   - "[StreamController] Auto-connected to InfluxDB source..."');
    console.log('4. Verify environment variables are set in the server process:');
    console.log('   - INFLUX_HOST');
    console.log('   - INFLUX_TOKEN');
    console.log('   - INFLUX_DATABASE');
    console.log('   - INFLUX_BUCKET');
    console.log('5. Check if InfluxDB has data in the last 2 minutes (required for discovery)');
    console.log('6. Verify data has the correct tags: level="strm", _field="value", boat tag');
    console.log('');

  } catch (err) {
    console.error('Fatal error:', err);
  }
}

main().catch(console.error);
