/**
 * Check Streaming Server Health
 * Diagnoses why streaming might be reported as inactive
 */

const http = require('http');

const STREAM_SERVER_URL = process.env.STREAM_SERVER_URL || 'http://localhost:8099';

async function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const url = `${STREAM_SERVER_URL}${path}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (err) {
          resolve({ status: res.statusCode, data: data, error: err.message });
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  console.log('='.repeat(80));
  console.log('Streaming Server Health Check');
  console.log('='.repeat(80));
  console.log(`Server URL: ${STREAM_SERVER_URL}\n`);

  try {
    // 1. Basic health check
    console.log('1. Basic Health Check:');
    try {
      const health = await makeRequest('/api/health');
      console.log(`   Status: ${health.status}`);
      console.log(`   Response:`, JSON.stringify(health.data, null, 2));
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      console.log('   Server may not be running!');
      return;
    }
    console.log('');

    // 2. Test InfluxDB connection
    console.log('2. InfluxDB Connection Test:');
    try {
      const influxTest = await makeRequest('/api/stream/debug/test-influx');
      console.log(`   Status: ${influxTest.status}`);
      if (influxTest.data.success) {
        console.log(`   ✓ InfluxDB connection: OK`);
        console.log(`   Config:`, JSON.stringify(influxTest.data.config, null, 2));
        console.log(`   Health:`, JSON.stringify(influxTest.data.health, null, 2));
        if (influxTest.data.discovery.sources) {
          console.log(`   Discovered sources: ${influxTest.data.discovery.sources.join(', ')}`);
        } else {
          console.log(`   ⚠️  No sources discovered`);
        }
      } else {
        console.log(`   ❌ InfluxDB connection failed`);
        console.log(`   Error:`, JSON.stringify(influxTest.data, null, 2));
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    console.log('');

    // 3. Check monitoring status (requires auth, but let's try)
    console.log('3. Monitoring Status (may require auth):');
    try {
      const monitoring = await makeRequest('/api/stream/monitoring/status');
      console.log(`   Status: ${monitoring.status}`);
      if (monitoring.status === 200 && monitoring.data && monitoring.data.success) {
        const status = monitoring.data.data;
        console.log(`   InfluxDB:`);
        console.log(`     - Enabled: ${status.influxdb?.enabled}`);
        console.log(`     - Streaming: ${status.influxdb?.streaming}`);
        console.log(`     - Active connections: ${status.influxdb?.active_connections}`);
        console.log(`     - Total queries: ${status.influxdb?.query_stats?.total_queries || 0}`);
        console.log(`     - Successful queries: ${status.influxdb?.query_stats?.successful_queries || 0}`);
        console.log(`     - Failed queries: ${status.influxdb?.query_stats?.failed_queries || 0}`);
        console.log(`     - Queries with new data: ${status.influxdb?.query_stats?.queries_with_new_data || 0}`);
        console.log(`     - Last query error: ${status.influxdb?.query_stats?.last_query_error || 'none'}`);
        console.log(`     - Time since new data: ${status.influxdb?.query_stats?.time_since_new_data_seconds || 'N/A'} seconds`);
        console.log(`   Real-time Sync:`);
        console.log(`     - Time since last data: ${status.realtime_sync?.time_since_last_data_seconds || 'N/A'} seconds`);
        console.log(`     - Time since last query: ${status.realtime_sync?.time_since_last_query_seconds || 'N/A'} seconds`);
        console.log(`     - In sync: ${status.realtime_sync?.in_sync}`);
        console.log(`     - Sync status: ${status.realtime_sync?.sync_status}`);
      } else if (monitoring.status === 401) {
        console.log(`   ⚠️  Requires authentication (this is expected)`);
      } else {
        console.log(`   Response:`, JSON.stringify(monitoring.data, null, 2));
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    console.log('');

    // 4. Check Redis status
    console.log('4. Redis Status (may require auth):');
    try {
      const redis = await makeRequest('/api/stream/redis/status');
      console.log(`   Status: ${redis.status}`);
      if (redis.status === 200 && redis.data && redis.data.success) {
        const sources = redis.data.data?.sources || [];
        console.log(`   Sources with data: ${sources.length}`);
        sources.forEach(source => {
          console.log(`     - ${source.source_name}: ${source.hours_of_data?.toFixed(2) || 0} hours`);
        });
      } else if (redis.status === 401) {
        console.log(`   ⚠️  Requires authentication (this is expected)`);
      } else {
        console.log(`   Response:`, JSON.stringify(redis.data, null, 2));
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('Diagnosis:');
    console.log('='.repeat(80));
    console.log('If streaming is reported as inactive:');
    console.log('1. Check if InfluxDB connection is working (section 2)');
    console.log('2. Check if queries are running (monitoring status)');
    console.log('3. Check if data is being received (time_since_new_data)');
    console.log('4. Check if sources are discovered and connected');
    console.log('5. Verify INFLUX_TOKEN, INFLUX_HOST, INFLUX_DATABASE, INFLUX_BUCKET are set');

  } catch (err) {
    console.error('Fatal error:', err);
  }
}

main().catch(console.error);
