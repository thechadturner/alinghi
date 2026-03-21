/**
 * Simple test script to check InfluxDB health from the streaming server
 * Tests both HTTP /health endpoint and query-based health check
 */

const { InfluxDB } = require('@influxdata/influxdb-client');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env files (same pattern as server_stream/middleware/config.js)
const isProduction = process.env.NODE_ENV === 'production';
const projectRoot = path.join(__dirname, '../../');

// Load base .env file first (defaults)
const baseEnvFile = isProduction ? '.env.production' : '.env';
const localEnvFile = isProduction ? '.env.production.local' : '.env.local';

const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// Load environment files (quiet mode - don't error if files don't exist)
const env = dotenv.config({ path: baseEnvPath, quiet: true }).parsed || {};
const envLocal = dotenv.config({ path: localEnvPath, quiet: true }).parsed || {};

// Merge: base env -> local env -> process.env (highest priority)
const config = Object.assign({}, env, envLocal, process.env);

// Get InfluxDB configuration from environment variables
const influxHost = config.INFLUX_HOST;
const influxToken = config.INFLUX_TOKEN;
const influxDatabase = config.INFLUX_DATABASE; // This is the org name
const influxBucket = config.INFLUX_BUCKET;

/**
 * Safely close InfluxDB client (handles cases where close() might not be available)
 */
function safeCloseClient(client) {
  try {
    if (client && typeof client.close === 'function') {
      client.close();
    }
  } catch (err) {
    // Ignore errors when closing - client might already be closed or in invalid state
  }
}

/**
 * Test InfluxDB health using HTTP /health endpoint (fastest method)
 */
async function testHealthEndpoint(baseUrl) {
  return new Promise((resolve) => {
    const url = new URL(`${baseUrl}/health`);
    const httpModule = url.protocol === 'https:' ? https : http;
    
    const req = httpModule.get(url.toString(), { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ 
            success: true, 
            method: 'http_health',
            message: 'Health endpoint OK',
            statusCode: res.statusCode,
            response: data
          });
        } else {
          resolve({ 
            success: false, 
            method: 'http_health',
            message: `Health endpoint returned status ${res.statusCode}`,
            statusCode: res.statusCode,
            response: data
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ 
        success: false, 
        method: 'http_health',
        message: `HTTP request failed: ${err.message}`,
        error: err.message
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ 
        success: false, 
        method: 'http_health',
        message: 'HTTP request timed out after 2 seconds'
      });
    });
  });
}

/**
 * Test InfluxDB health using minimal query (fallback method)
 */
async function testHealthWithQuery(baseUrl) {
  return new Promise((resolve) => {
    try {
      const influxClient = new InfluxDB({
        url: baseUrl,
        token: influxToken,
        timeout: 2000 // Fast timeout
      });
      const queryApi = influxClient.getQueryApi(influxDatabase);

      // Minimal query: smallest time range (-10s), limit to 1 row
      // This is the fastest possible query that still validates the connection works
      const testQuery = `from(bucket: "${influxBucket}")
  |> range(start: -10s)
  |> limit(n: 1)`;

      let hasData = false;
      let hasError = false;

      const timeout = setTimeout(() => {
        if (!hasData && !hasError) {
          hasError = true;
          safeCloseClient(influxClient);
          resolve({ 
            success: false, 
            method: 'query',
            message: 'Health check timeout after 2 seconds'
          });
        }
      }, 2000);

      queryApi.queryRows(testQuery, {
        next() {
          // Got data immediately - resolve fast
          hasData = true;
          clearTimeout(timeout);
          safeCloseClient(influxClient);
          resolve({ 
            success: true, 
            method: 'query',
            message: 'Connection successful (data found)'
          });
        },
        error(err) {
          if (!hasError) {
            hasError = true;
            clearTimeout(timeout);
            safeCloseClient(influxClient);
            resolve({ 
              success: false, 
              method: 'query',
              message: `Health check error: ${err.message}`,
              error: err.message
            });
          }
        },
        complete() {
          // Query completed (with or without data) - connection is OK
          if (!hasError) {
            clearTimeout(timeout);
            safeCloseClient(influxClient);
            resolve({ 
              success: true, 
              method: 'query',
              message: 'Connection successful (query completed)'
            });
          }
        }
      });
    } catch (err) {
      resolve({ 
        success: false, 
        method: 'query',
        message: `Failed to create InfluxDB client: ${err.message}`,
        error: err.message
      });
    }
  });
}

/**
 * Main test function
 */
async function main() {
  console.log('='.repeat(80));
  console.log('InfluxDB Health Check Test');
  console.log('='.repeat(80));
  console.log('');

  // Validate environment variables
  if (!influxHost || !influxToken || !influxDatabase || !influxBucket) {
    console.log('❌ Missing required environment variables:');
    console.log(`   INFLUX_HOST: ${influxHost ? '✓' : '✗'}`);
    console.log(`   INFLUX_TOKEN: ${influxToken ? '✓' : '✗'}`);
    console.log(`   INFLUX_DATABASE: ${influxDatabase ? '✓' : '✗'}`);
    console.log(`   INFLUX_BUCKET: ${influxBucket ? '✓' : '✗'}`);
    console.log('');
    console.log('Please set the required environment variables and try again.');
    process.exit(1);
  }

  // Handle INFLUX_HOST that might already contain protocol
  let baseUrl = influxHost;
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `http://${baseUrl}`;
  }

  console.log('Configuration:');
  console.log(`   Host: ${baseUrl}`);
  console.log(`   Database (Org): ${influxDatabase}`);
  console.log(`   Bucket: ${influxBucket}`);
  console.log(`   Token: ${influxToken ? '***' + influxToken.slice(-4) : 'NOT SET'}`);
  console.log('');
  console.log('Environment files checked:');
  console.log(`   Base: ${baseEnvPath} ${env && Object.keys(env).length > 0 ? '✓' : '✗ (not found or empty)'}`);
  console.log(`   Local: ${localEnvPath} ${envLocal && Object.keys(envLocal).length > 0 ? '✓' : '✗ (not found or empty)'}`);
  console.log('');

  // Test 1: HTTP /health endpoint (fastest)
  console.log('Test 1: HTTP /health endpoint');
  console.log('-'.repeat(80));
  const healthEndpointResult = await testHealthEndpoint(baseUrl);
  
  if (healthEndpointResult.success) {
    console.log(`✓ Health check passed (method: ${healthEndpointResult.method})`);
    console.log(`  Message: ${healthEndpointResult.message}`);
    if (healthEndpointResult.response) {
      console.log(`  Response: ${healthEndpointResult.response.substring(0, 100)}`);
    }
  } else {
    console.log(`✗ Health check failed (method: ${healthEndpointResult.method})`);
    console.log(`  Message: ${healthEndpointResult.message}`);
    if (healthEndpointResult.error) {
      console.log(`  Error: ${healthEndpointResult.error}`);
    }
    console.log('  → Falling back to query-based health check...');
  }
  console.log('');

  // Test 2: Query-based health check (fallback or additional test)
  console.log('Test 2: Query-based health check');
  console.log('-'.repeat(80));
  const queryResult = await testHealthWithQuery(baseUrl);
  
  if (queryResult.success) {
    console.log(`✓ Health check passed (method: ${queryResult.method})`);
    console.log(`  Message: ${queryResult.message}`);
  } else {
    console.log(`✗ Health check failed (method: ${queryResult.method})`);
    console.log(`  Message: ${queryResult.message}`);
    if (queryResult.error) {
      console.log(`  Error: ${queryResult.error}`);
    }
  }
  console.log('');

  // Summary
  console.log('='.repeat(80));
  console.log('Summary:');
  console.log('='.repeat(80));
  
  const httpSuccess = healthEndpointResult.success;
  const querySuccess = queryResult.success;
  
  if (httpSuccess) {
    console.log('✓ HTTP /health endpoint: PASSED');
  } else {
    console.log('✗ HTTP /health endpoint: FAILED');
  }
  
  if (querySuccess) {
    console.log('✓ Query-based health check: PASSED');
  } else {
    console.log('✗ Query-based health check: FAILED');
  }
  
  console.log('');
  
  if (httpSuccess || querySuccess) {
    console.log('Overall: ✓ InfluxDB is accessible');
    process.exit(0);
  } else {
    console.log('Overall: ✗ InfluxDB is NOT accessible');
    console.log('');
    console.log('Troubleshooting:');
    console.log('1. Verify INFLUX_HOST is correct and reachable');
    console.log('2. Verify INFLUX_TOKEN is valid and has proper permissions');
    console.log('3. Verify INFLUX_DATABASE (org name) is correct');
    console.log('4. Verify INFLUX_BUCKET exists and is accessible');
    console.log('5. Check network connectivity to InfluxDB server');
    process.exit(1);
  }
}

// Run the test
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
