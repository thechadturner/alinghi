/**
 * Test script to verify each step of InfluxDB streaming:
 * 1. Health check
 * 2. Source discovery
 * 3. Connect to a source
 * 4. Polling data
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
 * Safely close InfluxDB client
 */
function safeCloseClient(client) {
  try {
    if (client && typeof client.close === 'function') {
      client.close();
    }
  } catch (err) {
    // Ignore errors when closing
  }
}

/**
 * Step 1: Test InfluxDB health
 */
async function testHealth(baseUrl) {
  console.log('\n' + '='.repeat(80));
  console.log('STEP 1: Testing InfluxDB Health');
  console.log('='.repeat(80));
  
  return new Promise((resolve) => {
    const url = new URL(`${baseUrl}/health`);
    const httpModule = url.protocol === 'https:' ? https : http;
    
    const req = httpModule.get(url.toString(), { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✓ Health check passed');
          console.log(`  Response: ${data.substring(0, 200)}`);
          resolve({ success: true });
        } else {
          console.log(`✗ Health check failed: status ${res.statusCode}`);
          resolve({ success: false, error: `Status ${res.statusCode}` });
        }
      });
    });

    req.on('error', (err) => {
      console.log(`✗ Health check failed: ${err.message}`);
      resolve({ success: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.log('✗ Health check timed out');
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

/**
 * Step 2: Discover sources (boats) from InfluxDB
 */
async function discoverSources(baseUrl) {
  console.log('\n' + '='.repeat(80));
  console.log('STEP 2: Discovering Sources (Boats)');
  console.log('='.repeat(80));
  
  return new Promise((resolve) => {
    try {
      const influxClient = new InfluxDB({
        url: baseUrl,
        token: influxToken,
        timeout: 5000
      });
      const queryApi = influxClient.getQueryApi(influxDatabase);

      // Query to discover distinct boat tags (matching server_stream/controllers/stream.js)
      const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: -2m)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")
  |> distinct(column: "boat")
  |> limit(n: 50)`;

      console.log('Executing discovery query...');
      console.log(`Query: ${fluxQuery.replace(/\n/g, ' ').substring(0, 150)}...`);

      const sources = new Set();
      let hasError = false;
      let queryCompleted = false;

      const timeout = setTimeout(() => {
        if (!queryCompleted) {
          queryCompleted = true;
          hasError = true;
          safeCloseClient(influxClient);
          console.log('✗ Discovery query timed out after 5 seconds');
          resolve({ success: false, error: 'Timeout', sources: [] });
        }
      }, 5000);

      queryApi.queryRows(fluxQuery, {
        next(row, tableMeta) {
          try {
            const record = tableMeta.toObject(row);
            if (record.boat) {
              sources.add(record.boat);
              console.log(`  Found source: ${record.boat}`);
            }
          } catch (err) {
            console.log(`  Warning: Error processing row: ${err.message}`);
          }
        },
        error(err) {
          if (!queryCompleted) {
            queryCompleted = true;
            hasError = true;
            clearTimeout(timeout);
            safeCloseClient(influxClient);
            console.log(`✗ Discovery query failed: ${err.message}`);
            resolve({ success: false, error: err.message, sources: [] });
          }
        },
        complete() {
          if (!queryCompleted) {
            queryCompleted = true;
            clearTimeout(timeout);
            safeCloseClient(influxClient);
            
            const sourceList = Array.from(sources);
            if (sourceList.length > 0) {
              console.log(`✓ Discovery successful: Found ${sourceList.length} source(s)`);
              console.log(`  Sources: ${sourceList.join(', ')}`);
              resolve({ success: true, sources: sourceList });
            } else {
              console.log('⚠ Discovery completed but no sources found');
              console.log('  This could mean:');
              console.log('    - No data in the last 2 minutes');
              console.log('    - No data with level="strm"');
              console.log('    - No data with _field="value"');
              console.log('    - No "boat" tag in the data');
              resolve({ success: true, sources: [], warning: 'No sources found' });
            }
          }
        }
      });
    } catch (err) {
      console.log(`✗ Failed to create InfluxDB client: ${err.message}`);
      resolve({ success: false, error: err.message, sources: [] });
    }
  });
}

/**
 * Step 3: Connect to a specific source and test connection
 */
async function testConnection(baseUrl, sourceName) {
  console.log('\n' + '='.repeat(80));
  console.log(`STEP 3: Testing Connection to Source "${sourceName}"`);
  console.log('='.repeat(80));
  
  return new Promise((resolve) => {
    try {
      const influxClient = new InfluxDB({
        url: baseUrl,
        token: influxToken,
        timeout: 5000
      });
      const queryApi = influxClient.getQueryApi(influxDatabase);

      // Test query with source filter (matching influxdb.js polling query)
      const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: -1s)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")
  |> filter(fn: (r) => r.boat == "${sourceName}")
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])
  |> limit(n: 1)`;

      console.log('Executing connection test query...');
      console.log(`Query: ${fluxQuery.replace(/\n/g, ' ').substring(0, 200)}...`);

      let hasData = false;
      let hasError = false;
      let queryCompleted = false;
      let dataPoint = null;

      const timeout = setTimeout(() => {
        if (!queryCompleted) {
          queryCompleted = true;
          hasError = true;
          safeCloseClient(influxClient);
          console.log('✗ Connection test timed out after 5 seconds');
          resolve({ success: false, error: 'Timeout', connected: false });
        }
      }, 5000);

      queryApi.queryRows(fluxQuery, {
        next(row, tableMeta) {
          try {
            const record = tableMeta.toObject(row);
            hasData = true;
            dataPoint = record;
            console.log('✓ Connection successful - received data');
            console.log(`  Timestamp: ${record._time || 'N/A'}`);
            console.log(`  Boat: ${record.boat || 'N/A'}`);
            const measurementCount = Object.keys(record).filter(k => 
              !['_time', '_start', '_stop', '_field', '_measurement', 'level', 'result', 'table', 'boat'].includes(k)
            ).length;
            console.log(`  Measurements: ${measurementCount}`);
          } catch (err) {
            console.log(`  Warning: Error processing row: ${err.message}`);
          }
        },
        error(err) {
          if (!queryCompleted) {
            queryCompleted = true;
            hasError = true;
            clearTimeout(timeout);
            safeCloseClient(influxClient);
            console.log(`✗ Connection test failed: ${err.message}`);
            resolve({ success: false, error: err.message, connected: false });
          }
        },
        complete() {
          if (!queryCompleted) {
            queryCompleted = true;
            clearTimeout(timeout);
            safeCloseClient(influxClient);
            
            if (hasData) {
              console.log('✓ Connection test completed successfully');
              resolve({ success: true, connected: true, hasData: true, dataPoint });
            } else {
              console.log('⚠ Connection test completed but no data received');
              console.log('  This could mean:');
              console.log('    - No data in the last 1 second for this source');
              console.log('    - Data exists but doesn\'t match the filters');
              resolve({ success: true, connected: true, hasData: false, warning: 'No data in last 1 second' });
            }
          }
        }
      });
    } catch (err) {
      console.log(`✗ Failed to create InfluxDB client: ${err.message}`);
      resolve({ success: false, error: err.message, connected: false });
    }
  });
}

/**
 * Step 4: Test polling data (simulate what the source does)
 */
async function testPolling(baseUrl, sourceName, pollCount = 3) {
  console.log('\n' + '='.repeat(80));
  console.log(`STEP 4: Testing Data Polling for Source "${sourceName}"`);
  console.log(`  (Polling ${pollCount} times with 1 second interval)`);
  console.log('='.repeat(80));
  
  const results = [];
  
  for (let i = 0; i < pollCount; i++) {
    console.log(`\nPoll ${i + 1}/${pollCount}:`);
    
    const result = await new Promise((resolve) => {
      try {
        const influxClient = new InfluxDB({
          url: baseUrl,
          token: influxToken,
          timeout: 5000
        });
        const queryApi = influxClient.getQueryApi(influxDatabase);

        // Query matching influxdb.js polling query (last 1 second)
        const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: -1s)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")
  |> filter(fn: (r) => r.boat == "${sourceName}")
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])`;

        let dataPoints = [];
        let hasError = false;
        let queryCompleted = false;

        const timeout = setTimeout(() => {
          if (!queryCompleted) {
            queryCompleted = true;
            hasError = true;
            safeCloseClient(influxClient);
            console.log('  ✗ Query timed out');
            resolve({ success: false, error: 'Timeout', dataPoints: [] });
          }
        }, 5000);

        queryApi.queryRows(fluxQuery, {
          next(row, tableMeta) {
            try {
              const record = tableMeta.toObject(row);
              dataPoints.push(record);
            } catch (err) {
              // Continue processing
            }
          },
          error(err) {
            if (!queryCompleted) {
              queryCompleted = true;
              hasError = true;
              clearTimeout(timeout);
              safeCloseClient(influxClient);
              console.log(`  ✗ Query failed: ${err.message}`);
              resolve({ success: false, error: err.message, dataPoints: [] });
            }
          },
          complete() {
            if (!queryCompleted) {
              queryCompleted = true;
              clearTimeout(timeout);
              safeCloseClient(influxClient);
              
              if (dataPoints.length > 0) {
                const latest = dataPoints[dataPoints.length - 1];
                const timestamp = latest._time ? new Date(latest._time).toISOString() : 'N/A';
                const measurementCount = Object.keys(latest).filter(k => 
                  !['_time', '_start', '_stop', '_field', '_measurement', 'level', 'result', 'table', 'boat'].includes(k)
                ).length;
                console.log(`  ✓ Received ${dataPoints.length} data point(s)`);
                console.log(`    Latest timestamp: ${timestamp}`);
                console.log(`    Measurements: ${measurementCount}`);
                resolve({ success: true, dataPoints, count: dataPoints.length });
              } else {
                console.log('  ⚠ No data received');
                resolve({ success: true, dataPoints: [], count: 0, warning: 'No data' });
              }
            }
          }
        });
      } catch (err) {
        console.log(`  ✗ Failed: ${err.message}`);
        resolve({ success: false, error: err.message, dataPoints: [] });
      }
    });
    
    results.push(result);
    
    // Wait 1 second before next poll (unless it's the last one)
    if (i < pollCount - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  const successCount = results.filter(r => r.success && r.count > 0).length;
  const totalDataPoints = results.reduce((sum, r) => sum + (r.count || 0), 0);
  
  console.log(`\nPolling Summary:`);
  console.log(`  Successful polls with data: ${successCount}/${pollCount}`);
  console.log(`  Total data points received: ${totalDataPoints}`);
  
  return {
    success: successCount > 0,
    pollCount,
    successCount,
    totalDataPoints,
    results
  };
}

/**
 * Main test function
 */
async function main() {
  console.log('='.repeat(80));
  console.log('InfluxDB Streaming Step-by-Step Test');
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

  // Step 1: Health check
  const healthResult = await testHealth(baseUrl);
  if (!healthResult.success) {
    console.log('\n❌ Health check failed. Cannot proceed with further tests.');
    process.exit(1);
  }

  // Step 2: Discover sources
  const discoveryResult = await discoverSources(baseUrl);
  if (!discoveryResult.success) {
    console.log('\n❌ Source discovery failed. Cannot proceed with connection tests.');
    process.exit(1);
  }

  if (discoveryResult.sources.length === 0) {
    console.log('\n⚠ No sources found. Cannot test connection or polling.');
    console.log('\nTroubleshooting:');
    console.log('1. Check if InfluxDB has data in the last 2 minutes');
    console.log('2. Verify data has level="strm" tag');
    console.log('3. Verify data has _field="value"');
    console.log('4. Verify data has "boat" tag');
    process.exit(0);
  }

  // Step 3: Test connection to first source
  const firstSource = discoveryResult.sources[0];
  const connectionResult = await testConnection(baseUrl, firstSource);
  if (!connectionResult.success) {
    console.log('\n❌ Connection test failed.');
    process.exit(1);
  }

  // Step 4: Test polling
  const pollingResult = await testPolling(baseUrl, firstSource, 3);

  // Final summary
  console.log('\n' + '='.repeat(80));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(80));
  console.log(`✓ Health Check: PASSED`);
  console.log(`✓ Source Discovery: PASSED (${discoveryResult.sources.length} source(s) found)`);
  console.log(`✓ Connection Test: ${connectionResult.connected ? 'PASSED' : 'FAILED'}`);
  console.log(`✓ Data Polling: ${pollingResult.success ? 'PASSED' : 'FAILED'} (${pollingResult.successCount}/${pollingResult.pollCount} polls with data)`);
  console.log('');
  
  if (pollingResult.success && pollingResult.totalDataPoints > 0) {
    console.log('✓ All tests passed! Streaming should work.');
  } else if (connectionResult.connected) {
    console.log('⚠ Connection works but no data is being received.');
    console.log('  This could mean:');
    console.log('    - Data is not being written to InfluxDB in real-time');
    console.log('    - Data exists but doesn\'t match the query filters');
    console.log('    - There\'s a delay in data ingestion');
  } else {
    console.log('✗ Some tests failed. Check the errors above.');
  }
  console.log('');
}

// Run the test
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
