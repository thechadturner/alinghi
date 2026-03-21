/**
 * Direct InfluxDB Connection Test Script
 * 
 * Tests InfluxDB connectivity and data retrieval using Node.js
 * Usage: node test_influxdb_direct.cjs
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env file using the same approach as server_file
const isProduction = process.env.NODE_ENV === 'production';
// Look for .env files in project root (parent of scripts directory)
const projectRoot = path.resolve(__dirname, '..');

// Add server_file/node_modules to module path so we can require @influxdata/influxdb-client
const serverFileNodeModules = path.join(projectRoot, 'server_file', 'node_modules');
if (fs.existsSync(serverFileNodeModules)) {
  require('module')._nodeModulePaths.push(serverFileNodeModules);
}

const baseEnvFile = isProduction ? '.env.production' : '.env';
const localEnvFile = isProduction ? '.env.production.local' : '.env.local';
const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// Load environment files
const env = dotenv.config({ path: baseEnvPath, quiet: true }).parsed || {};
const envLocal = dotenv.config({ path: localEnvPath, quiet: true }).parsed || {};
const config = Object.assign({}, env, envLocal, process.env);

// Test configuration
const TEST_CONFIG = {
  source_name: 'AUS',
  date: '20250315', // 2025-08-16 in YYYYMMDD format
  channel: 'LATITUDE_GPS_unk',
  project_id: '2',
  class_name: 'gp50',
  level: 'strm'
};

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('');
  log('='.repeat(60), 'cyan');
  log(title, 'cyan');
  log('='.repeat(60), 'cyan');
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ ${message}`, 'blue');
}

function logWarning(message) {
  log(`⚠ ${message}`, 'yellow');
}

// Validate environment variables
function validateEnvironment() {
  logSection('Environment Variables Check');
  
  const required = ['INFLUX_TOKEN', 'INFLUX_HOST', 'INFLUX_DATABASE', 'INFLUX_BUCKET'];
  let allPresent = true;
  
  for (const key of required) {
    const value = config[key];
    if (value && value.trim() !== '') {
      // Mask token for display
      const displayValue = key === 'INFLUX_TOKEN' 
        ? `${value.substring(0, 10)}... (${value.length} chars)`
        : value;
      logSuccess(`${key}: ${displayValue}`);
    } else {
      logError(`${key}: NOT SET`);
      allPresent = false;
    }
  }
  
  if (!allPresent) {
    logError('Missing required environment variables!');
    logInfo('Looking for .env files at:');
    logInfo(`  - ${baseEnvPath} ${fs.existsSync(baseEnvPath) ? '(found)' : '(not found)'}`);
    logInfo(`  - ${localEnvPath} ${fs.existsSync(localEnvPath) ? '(found)' : '(not found)'}`);
    process.exit(1);
  }
  
  logSuccess('All required environment variables are set');
  return true;
}

// Direct InfluxDB client initialization (standalone, no server dependencies)
function getInfluxDBClientDirect() {
  const { InfluxDB } = require('@influxdata/influxdb-client');
  
  const influxToken = config.INFLUX_TOKEN;
  const influxHost = config.INFLUX_HOST;
  const influxDatabase = config.INFLUX_DATABASE;
  const influxBucket = config.INFLUX_BUCKET;
  
  if (!influxToken || !influxHost || !influxDatabase || !influxBucket) {
    throw new Error('Missing required InfluxDB environment variables');
  }
  
  let influxUrl = influxHost;
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }
  
  const client = new InfluxDB({
    url: influxUrl,
    token: influxToken
  });
  
  const queryApi = client.getQueryApi(influxDatabase);
  
  return { client, queryApi, bucket: influxBucket, org: influxDatabase };
}

// Direct InfluxDB query function
async function queryInfluxDBDirect(fluxQuery, queryApi) {
  return new Promise((resolve, reject) => {
    const results = [];
    const tableMap = new Map();
    let rowCount = 0;
    let binaryDataFound = false;
    
    queryApi.queryRows(fluxQuery, {
      next(row, tableMeta) {
        try {
          rowCount++;
          
          // Debug: Check raw row for binary data (first 3 rows only)
          if (rowCount <= 3) {
            logInfo(`[DEBUG] Raw row ${rowCount} type: ${typeof row}, isArray: ${Array.isArray(row)}`);
            if (row && typeof row === 'object') {
              Object.keys(row).forEach(key => {
                const value = row[key];
                if (Buffer.isBuffer(value)) {
                  binaryDataFound = true;
                  logWarning(`[DEBUG] Raw row[${rowCount}][${key}] is Buffer, length: ${value.length}, hex: ${value.slice(0, 20).toString('hex')}`);
                } else if (value instanceof Uint8Array) {
                  binaryDataFound = true;
                  logWarning(`[DEBUG] Raw row[${rowCount}][${key}] is Uint8Array, length: ${value.length}`);
                }
              });
            }
          }
          
          const record = tableMeta.toObject(row);
          
          // Debug: Check converted record for binary data (first 3 rows only)
          if (rowCount <= 3) {
            logInfo(`[DEBUG] Converted record ${rowCount} keys: ${Object.keys(record).join(', ')}`);
            Object.keys(record).forEach(key => {
              const value = record[key];
              const valueType = typeof value;
              
              if (Buffer.isBuffer(value)) {
                binaryDataFound = true;
                logWarning(`[DEBUG] Record[${rowCount}][${key}] is Buffer, length: ${value.length}`);
                try {
                  const strValue = value.toString('utf8');
                  const numValue = parseFloat(strValue);
                  logInfo(`[DEBUG] Buffer[${key}] as string: "${strValue}", as number: ${isNaN(numValue) ? 'NaN' : numValue}`);
                } catch (e) {
                  logError(`[DEBUG] Failed to convert Buffer[${key}]: ${e.message}`);
                }
              } else if (value instanceof Uint8Array) {
                binaryDataFound = true;
                logWarning(`[DEBUG] Record[${rowCount}][${key}] is Uint8Array, length: ${value.length}`);
              } else {
                // Check for suspiciously large numbers that might be binary data
                if (typeof value === 'number' && (value > 1e9 || value < -1e9)) {
                  logWarning(`[DEBUG] Record[${rowCount}][${key}] has very large number: ${value} (might be binary data)`);
                }
                if (rowCount === 1) {
                  logInfo(`[DEBUG] Record[${rowCount}][${key}]: ${valueType} = ${JSON.stringify(value).substring(0, 100)}`);
                }
              }
            });
          }
          
          const tableId = tableMeta.id || 0;
          if (!tableMap.has(tableId)) {
            tableMap.set(tableId, []);
          }
          tableMap.get(tableId).push(record);
        } catch (err) {
          logError(`Error converting row to object: ${err.message}`);
          if (err.stack) {
            logInfo(`Stack trace: ${err.stack}`);
          }
        }
      },
      error(err) {
        reject(err);
      },
      complete() {
        for (const tableRecords of tableMap.values()) {
          results.push(...tableRecords);
        }
        
        if (binaryDataFound) {
          logWarning(`[DEBUG] Binary data detected in query results! Total rows: ${results.length}`);
        } else {
          logInfo(`[DEBUG] No binary data detected. Total rows: ${results.length}`);
        }
        
        resolve(results);
      }
    });
  });
}

// Test InfluxDB connection
async function testConnection() {
  logSection('Test 1: InfluxDB Connection');
  
  try {
    logInfo('Initializing InfluxDB client...');
    const { client, queryApi, bucket, org } = getInfluxDBClientDirect();
    
    if (client && queryApi) {
      logSuccess('InfluxDB client initialized successfully');
      logInfo(`Host: ${config.INFLUX_HOST}`);
      logInfo(`Org: ${org}`);
      logInfo(`Bucket: ${bucket}`);
      
      // Test with a simple query
      logInfo('Testing connection with a simple query...');
      const testQuery = `from(bucket: "${bucket}")
        |> range(start: -1h)
        |> limit(n: 1)`;
      
      try {
        const results = await queryInfluxDBDirect(testQuery, queryApi);
        logSuccess(`Connection test successful (returned ${results.length} test rows)`);
        return { client, queryApi, bucket, org };
      } catch (queryErr) {
        logError(`Query test failed: ${queryErr.message}`);
        return false;
      }
    } else {
      logError('Failed to initialize InfluxDB client');
      return false;
    }
  } catch (err) {
    logError(`Connection test failed: ${err.message}`);
    if (err.stack) {
      logInfo(`Stack trace: ${err.stack}`);
    }
    return false;
  }
}

// Test getting sources
async function testGetSources(connectionInfo) {
  logSection('Test 2: Get Sources (Boats)');
  
  try {
    const { queryApi, bucket } = connectionInfo;
    
    // Convert date from YYYYMMDD to YYYY-MM-DD format
    const dateStr = String(TEST_CONFIG.date);
    const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const startTime = `${formattedDate}T00:00:00Z`;
    const stopTime = `${formattedDate}T23:59:59Z`;
    
    logInfo(`Querying sources for date: ${TEST_CONFIG.date}`);
    
    const fluxQuery = `from(bucket: "${bucket}")
  |> range(start: ${startTime}, stop: ${stopTime})
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "${TEST_CONFIG.level}")
  |> distinct(column: "boat")
  |> keep(columns: ["boat"])`;
    
    const results = await queryInfluxDBDirect(fluxQuery, queryApi);
    const sources = [...new Set(results.map(r => r.boat).filter(Boolean))].sort();
    
    if (Array.isArray(sources)) {
      logSuccess(`Found ${sources.length} source(s)`);
      if (sources.length > 0) {
        logInfo('Available sources:');
        sources.slice(0, 10).forEach((source, idx) => {
          logInfo(`  ${idx + 1}. ${source}`);
        });
        if (sources.length > 10) {
          logInfo(`  ... and ${sources.length - 10} more`);
        }
        
        // Check if test source exists
        if (sources.includes(TEST_CONFIG.source_name)) {
          logSuccess(`Test source "${TEST_CONFIG.source_name}" found in results`);
        } else {
          logWarning(`Test source "${TEST_CONFIG.source_name}" NOT found in results`);
          logInfo('Available sources may be different for this date');
        }
      } else {
        logWarning('No sources found for this date');
      }
      return true;
    } else {
      logError('Unexpected result format');
      return false;
    }
  } catch (err) {
    logError(`Get sources test failed: ${err.message}`);
    if (err.stack) {
      logInfo(`Stack trace: ${err.stack}`);
    }
    return false;
  }
}

// Test getting channels
async function testGetChannels(connectionInfo) {
  logSection('Test 3: Get Channels (Measurements)');
  
  try {
    const { queryApi, bucket } = connectionInfo;
    
    // Convert date from YYYYMMDD to YYYY-MM-DD format
    const dateStr = String(TEST_CONFIG.date);
    const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const startTime = `${formattedDate}T00:00:00Z`;
    const stopTime = `${formattedDate}T23:59:59Z`;
    const boat = String(TEST_CONFIG.source_name);
    
    logInfo(`Querying channels for source: ${TEST_CONFIG.source_name}, date: ${TEST_CONFIG.date}`);
    
    const fluxQuery = `from(bucket: "${bucket}")
  |> range(start: ${startTime}, stop: ${stopTime})
  |> filter(fn: (r) => r.boat == "${boat}")
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "${TEST_CONFIG.level}")
  |> distinct(column: "_measurement")
  |> keep(columns: ["_measurement"])`;
    
    const results = await queryInfluxDBDirect(fluxQuery, queryApi);
    const channels = [...new Set(results.map(r => r._measurement).filter(Boolean))].sort();
    
    if (Array.isArray(channels)) {
      logSuccess(`Found ${channels.length} channel(s)`);
      if (channels.length > 0) {
        logInfo('Available channels (first 20):');
        channels.slice(0, 20).forEach((channel, idx) => {
          const isTestChannel = channel === TEST_CONFIG.channel;
          const marker = isTestChannel ? ' ← TEST CHANNEL' : '';
          logInfo(`  ${idx + 1}. ${channel}${marker}`);
        });
        if (channels.length > 20) {
          logInfo(`  ... and ${channels.length - 20} more`);
        }
        
        // Check if test channel exists
        if (channels.includes(TEST_CONFIG.channel)) {
          logSuccess(`Test channel "${TEST_CONFIG.channel}" found in results`);
        } else {
          logWarning(`Test channel "${TEST_CONFIG.channel}" NOT found in results`);
          logInfo('Available channels may be different for this source/date');
        }
      } else {
        logWarning('No channels found for this source/date');
      }
      return true;
    } else {
      logError('Unexpected result format');
      return false;
    }
  } catch (err) {
    logError(`Get channels test failed: ${err.message}`);
    if (err.stack) {
      logInfo(`Stack trace: ${err.stack}`);
    }
    return false;
  }
}

// Test getting channel values
async function testGetChannelValues(connectionInfo) {
  logSection('Test 4: Get Channel Values');
  
  try {
    const { queryApi, bucket } = connectionInfo;
    
    // Convert date from YYYYMMDD to YYYY-MM-DD format
    const dateStr = String(TEST_CONFIG.date);
    const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const startTime = `${formattedDate}T00:00:00Z`;
    const stopTime = `${formattedDate}T23:59:59Z`;
    const boat = String(TEST_CONFIG.source_name);
    const measurement = TEST_CONFIG.channel;
    
    logInfo(`Querying channel values for:`);
    logInfo(`  - Source: ${TEST_CONFIG.source_name}`);
    logInfo(`  - Date: ${TEST_CONFIG.date}`);
    logInfo(`  - Channel: ${TEST_CONFIG.channel}`);
    logInfo(`  - Level: ${TEST_CONFIG.level}`);
    
    // Build Flux query for single channel
    const fluxQuery = `from(bucket: "${bucket}")
  |> range(start: ${startTime}, stop: ${stopTime})
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "${TEST_CONFIG.level}")
  |> filter(fn: (r) => r.boat == "${boat}")
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])
  |> limit(n: 1000)`;
    
    logInfo('Executing Flux query...');
    const rawResults = await queryInfluxDBDirect(fluxQuery, queryApi);
    
    // Convert _time to ts (Unix timestamp in seconds)
    // Apply GPS coordinate conversion (divide by 10^7 for GPS-related channels)
    const results = rawResults.map((record, idx) => {
      const result = { ...record };
      
      // Apply GPS coordinate conversion (divide by 10^7) ONLY for specific channels
      // Only convert LATITUDE_GPS_unk and LONGITUDE_GPS_unk - all other channels should remain unchanged
      Object.keys(result).forEach(key => {
        // Skip metadata fields
        if (key === '_time' || key === 'ts' || key === 'result' || key === 'table' || key === 'boat' || key === 'level') {
          return;
        }
        
        const value = result[key];
        
        // Only convert these specific channel names
        const shouldConvert = key === 'LATITUDE_GPS_unk' || key === 'LONGITUDE_GPS_unk';
        
        if (shouldConvert && typeof value === 'number' && value !== null && !isNaN(value)) {
          const convertedValue = value / 10000000; // Move decimal 7 places to the left
          if (idx < 3) {
            logInfo(`[CONVERSION] GPS coordinate ${key}: ${value} -> ${convertedValue} (divided by 10^7)`);
          }
          result[key] = convertedValue;
        }
      });
      
      if (result._time) {
        const date = new Date(result._time);
        result.ts = Math.round(date.getTime() / 1000 * 1000) / 1000;
        delete result._time;
      }
      return result;
    });
    
    if (Array.isArray(results)) {
      logSuccess(`Retrieved ${results.length} data row(s)`);
      
      if (results.length > 0) {
        // Analyze the data
        const firstRow = results[0];
        const lastRow = results[results.length - 1];
        
        logInfo('Data structure:');
        logInfo(`  Columns: ${Object.keys(firstRow).join(', ')}`);
        
        // Find timestamp column
        const tsCol = firstRow.ts !== undefined ? 'ts' : 
                     firstRow._time !== undefined ? '_time' : 
                     firstRow.timestamp !== undefined ? 'timestamp' : null;
        
        if (tsCol) {
          const firstTs = firstRow[tsCol];
          const lastTs = lastRow[tsCol];
          logInfo(`  First timestamp (${tsCol}): ${firstTs}`);
          logInfo(`  Last timestamp (${tsCol}): ${lastTs}`);
          
          if (typeof firstTs === 'number' && typeof lastTs === 'number') {
            const duration = lastTs - firstTs;
            const durationHours = (duration / 3600).toFixed(2);
            logInfo(`  Time range: ${duration} seconds (${durationHours} hours)`);
          }
        }
        
        // Show channel value
        const channelValue = firstRow[TEST_CONFIG.channel];
        if (channelValue !== undefined) {
          logInfo(`  Channel value (${TEST_CONFIG.channel}): ${channelValue}`);
        }
        
        logInfo('');
        logInfo('Sample data (first 5 rows):');
        results.slice(0, 5).forEach((row, idx) => {
          const rowStr = JSON.stringify(row, null, 2).split('\n').map(l => `    ${l}`).join('\n');
          logInfo(`  Row ${idx + 1}:`);
          console.log(rowStr);
        });
        
        if (results.length > 5) {
          logInfo(`  ... and ${results.length - 5} more rows`);
        }
      } else {
        logWarning('No data rows returned');
        logInfo('This could mean:');
        logInfo('  - The channel has no data for this date');
        logInfo('  - The channel name might be incorrect');
        logInfo('  - The time range might not contain data');
      }
      
      return true;
    } else {
      logError('Unexpected result format');
      return false;
    }
  } catch (err) {
    logError(`Get channel values test failed: ${err.message}`);
    if (err.stack) {
      logInfo(`Stack trace: ${err.stack}`);
    }
    return false;
  }
}

// Test time range filtering
async function testTimeRangeFiltering(connectionInfo) {
  logSection('Test 5: Time Range Filtering');
  
  try {
    const { queryApi, bucket } = connectionInfo;
    
    // First get data without time range to find min/max
    logInfo('Step 1: Getting data without time range to find min/max timestamps...');
    
    const dateStr = String(TEST_CONFIG.date);
    const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const startTime = `${formattedDate}T00:00:00Z`;
    const stopTime = `${formattedDate}T23:59:59Z`;
    const boat = String(TEST_CONFIG.source_name);
    const measurement = TEST_CONFIG.channel;
    
    const fluxQueryAll = `from(bucket: "${bucket}")
  |> range(start: ${startTime}, stop: ${stopTime})
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "${TEST_CONFIG.level}")
  |> filter(fn: (r) => r.boat == "${boat}")
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])
  |> limit(n: 1000)`;
    
    const rawAllResults = await queryInfluxDBDirect(fluxQueryAll, queryApi);
    const allResults = rawAllResults.map(record => {
      const result = { ...record };
      if (result._time) {
        const date = new Date(result._time);
        result.ts = Math.round(date.getTime() / 1000 * 1000) / 1000;
        delete result._time;
      }
      return result;
    });
    
    if (!allResults || allResults.length === 0) {
      logWarning('No data available to test time range filtering');
      return false;
    }
    
    // Find min and max timestamps
    const timestamps = allResults
      .map(row => row.ts || row._time || row.timestamp)
      .filter(ts => ts !== undefined && ts !== null && typeof ts === 'number');
    
    if (timestamps.length === 0) {
      logWarning('No valid timestamps found in data');
      return false;
    }
    
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    
    logSuccess(`Found time range: ${minTs} to ${maxTs}`);
    logInfo(`  Min timestamp: ${new Date(minTs * 1000).toISOString()}`);
    logInfo(`  Max timestamp: ${new Date(maxTs * 1000).toISOString()}`);
    
    // Test with time range (use middle portion)
    const rangeStart = minTs + (maxTs - minTs) * 0.25;
    const rangeEnd = minTs + (maxTs - minTs) * 0.75;
    
    logInfo('');
    logInfo(`Step 2: Querying with time range filter (${rangeStart} to ${rangeEnd})...`);
    
    // Convert timestamps to ISO strings for Flux query
    const rangeStartDate = new Date(rangeStart * 1000);
    const rangeEndDate = new Date(rangeEnd * 1000);
    const rangeStartISO = rangeStartDate.toISOString();
    const rangeEndISO = rangeEndDate.toISOString();
    
    const fluxQueryFiltered = `from(bucket: "${bucket}")
  |> range(start: ${rangeStartISO}, stop: ${rangeEndISO})
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "${TEST_CONFIG.level}")
  |> filter(fn: (r) => r.boat == "${boat}")
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])
  |> limit(n: 1000)`;
    
    const rawFilteredResults = await queryInfluxDBDirect(fluxQueryFiltered, queryApi);
    const filteredResults = rawFilteredResults.map(record => {
      const result = { ...record };
      if (result._time) {
        const date = new Date(result._time);
        result.ts = Math.round(date.getTime() / 1000 * 1000) / 1000;
        delete result._time;
      }
      return result;
    });
    
    logSuccess(`Retrieved ${filteredResults.length} rows with time range filter`);
    logInfo(`  Original data: ${allResults.length} rows`);
    logInfo(`  Filtered data: ${filteredResults.length} rows`);
    
    if (filteredResults.length < allResults.length) {
      logSuccess('Time range filtering is working correctly');
      
      // Verify all filtered results are within range
      const allInRange = filteredResults.every(row => {
        const ts = row.ts || row._time || row.timestamp;
        return ts >= rangeStart && ts <= rangeEnd;
      });
      
      if (allInRange) {
        logSuccess('All filtered results are within the specified time range');
      } else {
        logError('Some filtered results are outside the specified time range');
      }
    } else {
      logWarning('Time range filter did not reduce the number of rows');
    }
    
    return true;
  } catch (err) {
    logError(`Time range filtering test failed: ${err.message}`);
    if (err.stack) {
      logInfo(`Stack trace: ${err.stack}`);
    }
    return false;
  }
}

// Main test runner
async function runTests() {
  console.log('');
  log('InfluxDB Direct Connection Test', 'cyan');
  log('================================', 'cyan');
  console.log('');
  
  // Validate environment
  if (!validateEnvironment()) {
    process.exit(1);
  }
  
  // Run tests
  const results = {
    connection: false,
    sources: false,
    channels: false,
    channelValues: false,
    timeRange: false
  };
  
  let connectionInfo = null;
  
  try {
    connectionInfo = await testConnection();
    results.connection = !!connectionInfo;
    
    if (connectionInfo) {
      results.sources = await testGetSources(connectionInfo);
      results.channels = await testGetChannels(connectionInfo);
      results.channelValues = await testGetChannelValues(connectionInfo);
      results.timeRange = await testTimeRangeFiltering(connectionInfo);
    }
  } catch (err) {
    logError(`Test suite failed: ${err.message}`);
    if (err.stack) {
      logInfo(`Stack trace: ${err.stack}`);
    }
  }
  
  // Summary
  logSection('Test Summary');
  
  const testNames = {
    connection: 'Connection Test',
    sources: 'Get Sources Test',
    channels: 'Get Channels Test',
    channelValues: 'Get Channel Values Test',
    timeRange: 'Time Range Filtering Test'
  };
  
  let passed = 0;
  let failed = 0;
  
  for (const [key, name] of Object.entries(testNames)) {
    if (results[key]) {
      logSuccess(`${name}: PASSED`);
      passed++;
    } else {
      logError(`${name}: FAILED`);
      failed++;
    }
  }
  
  console.log('');
  log(`Total: ${passed} passed, ${failed} failed`, failed > 0 ? 'red' : 'green');
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
}

// Run the tests
runTests().catch(err => {
  logError(`Fatal error: ${err.message}`);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
