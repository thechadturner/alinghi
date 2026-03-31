/**
 * Quick test script to query channel-values API
 * Usage: node test_channel_query.cjs
 * 
 * Reads SYSTEM_KEY from .env file for API authentication
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env file using the same approach as server_file
const isProduction = process.env.NODE_ENV === 'production';
// Look for .env files in project root (parent of scripts directory)
const projectRoot = path.resolve(__dirname, '..');
const baseEnvFile = isProduction ? '.env.production' : '.env';
const localEnvFile = isProduction ? '.env.production.local' : '.env.local';
const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// Load environment files
const env = dotenv.config({ path: baseEnvPath, quiet: true }).parsed || {};
const envLocal = dotenv.config({ path: localEnvPath, quiet: true }).parsed || {};
const config = Object.assign({}, env, envLocal, process.env);

// Test parameters
const TEST_CONFIG = {
  source_name: 'AUS',
  date: '20250315', // 2025-08-16 in YYYYMMDD format
  channel: 'LATITUDE_GPS_unk',
  // You may need to adjust these based on your setup
  project_id: '2', // Default project ID - adjust if needed
  class_name: 'ac40', // Default class name - adjust if needed
  host: 'localhost',
  port: config.FILE_PORT || config.PORT || 3002,
  useHttps: false,
  // Test with InfluxDB directly to see debugging output
  // Options: 'auto', 'influx', 'duckdb', 'file'
  // Check if argv[2] is a data_source keyword, otherwise use argv[3]
  data_source: (process.argv[2] && ['auto', 'influx', 'duckdb', 'file'].includes(process.argv[2]))
    ? process.argv[2]
    : (process.argv[3] || 'auto')
};

// Get auth token from SYSTEM_KEY env var or command line argument
// Arguments: [0] = node, [1] = script, [2] = auth_token (optional), [3] = data_source (optional)
const authToken = process.argv[2] && process.argv[2] !== 'auto' && process.argv[2] !== 'influx' && process.argv[2] !== 'duckdb' && process.argv[2] !== 'file'
  ? process.argv[2]
  : (config.SYSTEM_KEY || process.env.SYSTEM_KEY || process.env.AUTH_TOKEN || '');

if (!authToken) {
  console.error('Error: Auth token required');
  console.error('Please set SYSTEM_KEY in .env file or as environment variable');
  console.error('   or: node test_channel_query.cjs <auth_token> [data_source]');
  console.error('');
  console.error('Looking for .env files at:');
  console.error(`  - ${baseEnvPath} ${fs.existsSync(baseEnvPath) ? '(found)' : '(not found)'}`);
  console.error(`  - ${localEnvPath} ${fs.existsSync(localEnvPath) ? '(found)' : '(not found)'}`);
  if (config.INFLUX_TOKEN) {
    console.error('');
    console.error('Note: INFLUX_TOKEN is found (for InfluxDB), but SYSTEM_KEY is required for API authentication');
  }
  process.exit(1);
}

// Prepare request payload
const payload = JSON.stringify({
  project_id: TEST_CONFIG.project_id,
  class_name: TEST_CONFIG.class_name,
  date: TEST_CONFIG.date,
  source_name: TEST_CONFIG.source_name,
  channel_list: [TEST_CONFIG.channel], // Can be array of strings or array of objects
  // Alternative format (array of objects):
  // channel_list: [{ name: TEST_CONFIG.channel, type: 'float' }],
  start_ts: null,
  end_ts: null,
  timezone: 'UTC',
  resolution: '1s',
  data_source: TEST_CONFIG.data_source // Use specified data source
});

const options = {
  hostname: TEST_CONFIG.host,
  port: TEST_CONFIG.port,
  path: '/api/channel-values',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Authorization': `Bearer ${authToken}`,
    'Cookie': `auth_token=${authToken}`
  }
};

console.log('Testing channel-values API...');
console.log('Configuration:', {
  source_name: TEST_CONFIG.source_name,
  date: TEST_CONFIG.date,
  channel: TEST_CONFIG.channel,
  project_id: TEST_CONFIG.project_id,
  class_name: TEST_CONFIG.class_name,
  data_source: TEST_CONFIG.data_source,
  endpoint: `${TEST_CONFIG.useHttps ? 'https' : 'http'}://${TEST_CONFIG.host}:${TEST_CONFIG.port}${options.path}`
});
console.log('');
console.log('Usage: node test_channel_query.cjs [auth_token] [data_source]');
console.log('  data_source options: auto, influx, duckdb, file');
console.log('  Example: node test_channel_query.cjs <token> influx');
console.log('');
console.log(`Using token: ${authToken.substring(0, 10)}... (${authToken.length} chars)`);
console.log('');

const client = TEST_CONFIG.useHttps ? https : http;

const req = client.request(options, (res) => {
  let data = '';
  let binaryData = Buffer.alloc(0);

  // Check if response is binary (Arrow format)
  const contentType = res.headers['content-type'] || '';
  const isBinary = contentType.includes('application/octet-stream') || 
                   contentType.includes('application/x-arrow') ||
                   !contentType.includes('application/json');

  res.on('data', (chunk) => {
    if (isBinary) {
      binaryData = Buffer.concat([binaryData, chunk]);
    } else {
      data += chunk;
    }
  });

  res.on('end', () => {
    console.log(`Status Code: ${res.statusCode}`);
    console.log(`Content-Type: ${contentType}`);
    console.log('');

    if (res.statusCode === 204) {
      console.log('✓ Status 204: No Content (no data found)');
      console.log('');
      console.log('This could mean:');
      console.log('  - The channel does not exist for this source/date');
      console.log('  - The channel exists but has no data for this date');
      console.log('  - The channel name might be different (case-sensitive)');
      console.log('  - The data might be in a different level (strm vs log)');
      console.log('');
      console.log('To debug further, check:');
      console.log('  - Server logs for InfluxDB query details');
      console.log('  - Whether the channel exists in file system');
      console.log('  - Whether the channel exists in InfluxDB');
      process.exit(0);
    }
    
    if (res.statusCode !== 200) {
      try {
        const errorData = JSON.parse(data);
        console.error('Error Response:', JSON.stringify(errorData, null, 2));
        if (errorData.message) {
          console.error('Error Message:', errorData.message);
        }
      } catch (e) {
        console.error('Error Response (raw):', data);
      }
      process.exit(1);
    }

    if (isBinary) {
      console.log(`Received binary data (Arrow format): ${binaryData.length} bytes`);
      console.log('');
      
      // Try to parse Arrow format if apache-arrow is available
      try {
        const arrow = require('apache-arrow');
        const table = arrow.tableFromIPC(binaryData);
        const numRows = table.numRows;
        const numCols = table.numCols;
        
        console.log(`✓ Successfully parsed Arrow data:`);
        console.log(`  - Rows: ${numRows}`);
        console.log(`  - Columns: ${numCols}`);
        console.log('');
        
        if (numRows > 0) {
          console.log('Column names:', table.schema.fields.map(f => f.name).join(', '));
          console.log('');
          console.log('First few rows:');
          const firstRows = Math.min(5, numRows);
          for (let i = 0; i < firstRows; i++) {
            const row = table.get(i);
            const rowData = {};
            table.schema.fields.forEach(field => {
              rowData[field.name] = row.get(field.name);
            });
            console.log(`  Row ${i}:`, JSON.stringify(rowData));
          }
          if (numRows > 5) {
            console.log(`  ... and ${numRows - 5} more rows`);
          }
        } else {
          console.log('⚠ No data rows returned (empty result)');
          console.log('This could mean:');
          console.log('  - The channel does not exist for this source/date');
          console.log('  - The channel exists but has no data for this date');
          console.log('  - The channel name might be different (case-sensitive)');
        }
      } catch (parseError) {
        console.log('Note: Could not parse Arrow format (apache-arrow may not be installed)');
        console.log('Error:', parseError.message);
        console.log('');
        console.log('First 100 bytes (hex):');
        console.log(binaryData.slice(0, 100).toString('hex'));
      }
    } else {
      try {
        const jsonData = JSON.parse(data);
        console.log('Response:', JSON.stringify(jsonData, null, 2));
        
        if (jsonData.data && Array.isArray(jsonData.data)) {
          console.log('');
          console.log(`Data points returned: ${jsonData.data.length}`);
          if (jsonData.data.length > 0) {
            console.log('First data point:', JSON.stringify(jsonData.data[0], null, 2));
            if (jsonData.data.length > 1) {
              console.log('Last data point:', JSON.stringify(jsonData.data[jsonData.data.length - 1], null, 2));
            }
          }
        }
      } catch (e) {
        console.log('Response (raw):', data.substring(0, 500));
      }
    }
  });
});

req.on('error', (error) => {
  console.error('Request Error:', error.message);
  process.exit(1);
});

req.write(payload);
req.end();
