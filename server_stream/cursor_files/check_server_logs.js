/**
 * Check server logs by querying the monitoring endpoint
 * and checking the database for log entries
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const STREAM_PORT = process.env.STREAM_PORT || 8099;
const STREAM_HOST = process.env.STREAM_HOST || 'localhost';

/**
 * Make HTTP request
 */
function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = `http://${STREAM_HOST}:${STREAM_PORT}${path}`;
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Check database for recent log entries
 */
async function checkDatabaseLogs() {
  try {
    const db = require('../../shared/database/connection');
    
    // Get recent log entries related to streaming
    // Note: admin.log_activity uses 'datetime' column, not 'created_at'
    const sql = `
      SELECT 
        log_type,
        log_level,
        message,
        context,
        datetime
      FROM admin.log_activity
      WHERE 
        (message LIKE '%StreamController%' OR message LIKE '%streaming%' OR message LIKE '%InfluxDB%')
        AND datetime > NOW() - INTERVAL '1 hour'
      ORDER BY datetime DESC
      LIMIT 50
    `;
    
    // Use getRows for SELECT queries
    const results = await db.getRows(sql, []);
    return results || [];
  } catch (err) {
    console.error('Error querying database logs:', err.message);
    return [];
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('Server Logs Check');
  console.log('='.repeat(80));
  console.log('');

  // 1. Check server health
  console.log('1. Checking Server Health:');
  console.log('   '.repeat(20));
  try {
    const health = await makeRequest('/api/health');
    console.log(`   Status: ${health.statusCode === 200 ? '✓ Running' : '✗ Error'}`);
    if (health.data) {
      console.log(`   Uptime: ${health.data.uptime ? Math.round(health.data.uptime) + 's' : 'unknown'}`);
    }
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
  }
  console.log('');

  // 2. Check monitoring status
  console.log('2. Checking Monitoring Status:');
  console.log('   '.repeat(20));
  try {
    const monitoring = await makeRequest('/api/stream/monitoring/status');
    if (monitoring.statusCode === 200 && monitoring.data) {
      const status = monitoring.data.data;
      console.log(`   Streaming Started: ${status.streamingStarted ? '✓ Yes' : '✗ No'}`);
      console.log(`   InfluxDB Streaming Enabled: ${status.influxdb?.enabled ? '✓ Yes' : '✗ No'}`);
      console.log(`   InfluxDB Streaming Active: ${status.influxdb?.streaming ? '✓ Yes' : '✗ No'}`);
      console.log(`   InfluxDB Connections: ${status.influxdb?.connections || 0}`);
      console.log(`   InfluxDB Queries: ${status.influxdb?.queries || 0}`);
      console.log(`   Total Connections: ${status.connections?.total || 0}`);
      console.log(`   Active Connections: ${status.connections?.active || 0}`);
    } else {
      console.log(`   ✗ Status Code: ${monitoring.statusCode}`);
      if (monitoring.data) {
        console.log(`   Response: ${JSON.stringify(monitoring.data).substring(0, 200)}`);
      }
    }
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
  }
  console.log('');

  // 3. Check database logs
  console.log('3. Recent Database Log Entries (last hour):');
  console.log('   '.repeat(20));
  try {
    const logs = await checkDatabaseLogs();
    if (logs.length === 0) {
      console.log('   No recent log entries found');
    } else {
      console.log(`   Found ${logs.length} log entries:`);
      logs.slice(0, 20).forEach((log, index) => {
        const time = new Date(log.datetime).toLocaleTimeString();
        const level = log.log_level || 'info';
        const message = log.message || '';
        const truncated = message.length > 80 ? message.substring(0, 80) + '...' : message;
        console.log(`   [${time}] [${level.toUpperCase()}] ${truncated}`);
      });
      if (logs.length > 20) {
        console.log(`   ... and ${logs.length - 20} more entries`);
      }
    }
  } catch (err) {
    console.log(`   ✗ Error: ${err.message}`);
  }
  console.log('');

  console.log('='.repeat(80));
  console.log('Summary:');
  console.log('='.repeat(80));
  console.log('If streaming shows inactive:');
  console.log('1. Check if "Start Streaming" button was clicked');
  console.log('2. Check if InfluxDB streaming toggle is enabled');
  console.log('3. Review database logs above for error messages');
  console.log('4. Verify environment variables are set in server process');
}

main().catch(console.error);
