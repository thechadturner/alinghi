const { sendResponse } = require('../middleware/helpers');
const { log, error, warn, debug } = require('../../shared');
const { logMessage } = require('../../shared/utils/logging');
const connectionManager = require('./connections');
const { createWebSocketSource } = require('./sources/websocket');
const { createInfluxDBSource } = require('./sources/influxdb_v2');
const processor = require('./processor');
const redisStorage = require('./redis');
const config = require('../middleware/config'); // Load config once at module level

// Helper to get WebSocket server instance from app locals
// This allows us to access it in request handlers and source handlers
function getClientWSS(req) {
  if (req && req.app && req.app.locals && req.app.locals.clientWSS) {
    return req.app.locals.clientWSS;
  }
  // Fallback: try to get from global if available (for source handlers)
  if (typeof global !== 'undefined' && global.streamClientWSS) {
    return global.streamClientWSS;
  }
  return null;
}

// Store reference for source handlers (set in server.js)
if (typeof global !== 'undefined') {
  // Will be set when server starts
  global.streamClientWSS = null;
}

// Track Redis flush events (actual writes to Redis, not just buffering)
redisStorage.on('flushSuccess', (data) => {
  debug(`[StreamController] Redis flush successful: source=${data.source_name}, timestamp=${new Date(data.timestamp).toISOString()}, channels=${data.channels.length}`);
});

redisStorage.on('flushError', (data) => {
  error(`[StreamController] Redis flush failed: source=${data.source_name}, timestamp=${new Date(data.timestamp).toISOString()}, error=${data.error}`);
  // Update Redis stats to reflect actual write failures
  redisStats.errorCount++;
  redisStats.lastError = data.error;
  redisStats.lastErrorTime = Date.now();
  // Adjust success count since we counted it as success when buffering
  if (redisStats.successCount > 0) {
    redisStats.successCount--;
  }
});

// Store active source instances
const sourceInstances = new Map(); // source_id -> source instance

// Track last data received time for each source (for inactivity detection)
// Key: source_name (normalized, uppercase), Value: timestamp
const lastDataReceived = new Map(); // source_name -> timestamp

// Track if auto-discovery has been attempted (to avoid repeated checks)
let autoDiscoveryAttempted = false;

// Track InfluxDB streaming enabled/disabled state
let influxDBStreamingEnabled = true; // Default to enabled

// Make influxDBStreamingEnabled globally accessible for InfluxDB sources
if (typeof global !== 'undefined') {
  global.influxDBStreamingEnabled = influxDBStreamingEnabled;
}

// Track if streaming has been explicitly started (separate from enabled state)
// Streaming will only start when explicitly commanded from admin page
let streamingStarted = false;

// Track streaming state
let isStreaming = false;
let streamingStatusInterval = null;

// Track data processing statistics
const processingStats = {
  successCount: 0,
  errorCount: 0,
  processedNewDataCount: 0, // Track when data actually gets processed (not skipped as duplicate)
  skippedDuplicateCount: 0, // Track when data is skipped as duplicate
  lastError: null,
  lastErrorTime: null,
  lastSuccessTime: null,
  lastNewDataProcessedTime: null // Track when we last processed NEW data (not duplicate)
};

// Track Redis insert statistics
const redisStats = {
  attemptCount: 0,
  successCount: 0,
  errorCount: 0,
  insertedNewDataCount: 0, // Track when NEW data actually gets inserted (not just successful writes)
  lastError: null,
  lastErrorTime: null,
  lastSuccessTime: null,
  lastNewDataInsertedTime: null // Track when we last inserted NEW data
};

// Track WebSocket connection attempts
const websocketStats = {
  attemptCount: 0,
  successCount: 0,
  errorCount: 0,
  lastError: null,
  lastErrorTime: null,
  lastAttemptTime: null,
  activeConnections: 0
};

// Track InfluxDB query statistics
const influxDBQueryStats = {
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  queriesWithNewData: 0, // Track queries that actually returned NEW data (not empty or duplicate)
  lastQueryTime: null,
  lastQueryError: null,
  lastQueryErrorTime: null,
  lastSuccessfulQueryTime: null,
  lastQueryWithNewDataTime: null, // Track when we last got NEW data from a query
  queryIntervalMs: 1000, // 1 second default
  sources: new Map() // source_id -> { lastQueryTime, lastError, errorCount, successCount, queriesWithNewData }
};

// Make influxDBQueryStats globally accessible for InfluxDB sources
if (typeof global !== 'undefined') {
  global.influxDBQueryStats = influxDBQueryStats;
}

// Track processing performance
const processingPerformance = {
  totalProcessed: 0,
  tripTimes: [], // Array of recent trip times (receive -> redis write)
  maxTripTimeHistory: 100, // Keep last 100 trip times for averaging
  lastProcessedTimestamp: null
};

// Track last attempted insert timestamp per source (to prevent duplicate inserts)
// Key: source_name (normalized, uppercase), Value: last attempted insert timestamp
// Updated BEFORE insert attempt to prevent duplicate processing even if insert fails
const lastInsertedTimestamp = new Map(); // source_name -> timestamp

// Inactivity timeout: 5 minutes
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes


/**
 * Get formatted source names from Redis
 * Returns array of source names like ['GBR', 'ITA', 'NZL']
 */
async function getSourceNames() {
  try {
    if (!redisStorage.isConnected || !redisStorage.client) {
      return [];
    }
    
    // Use SCAN instead of KEYS to avoid blocking and memory issues
    // SCAN is non-blocking and memory-efficient for large datasets
    const dataKeys = [];
    let cursor = '0';
    const maxIterations = 100; // Limit iterations to prevent infinite loops
    let iterations = 0;

    do {
      const [nextCursor, keys] = await redisStorage.client.scan(cursor, 'MATCH', 'stream:*', 'COUNT', 100);
      cursor = nextCursor;
      
      // Filter out metadata keys and invalid keys (keys with colons indicate old format like "1:MANEUVER_TYPE")
      for (const key of keys) {
        // Exclude metadata keys
        if (key.endsWith(':meta')) {
          continue;
        }
        // Exclude keys that contain colons after "stream:" (these are malformed/old format)
        // Valid keys should be like "stream:GBR", "stream:NZL" (no colons in source name)
        const sourcePart = key.replace('stream:', '');
        if (!sourcePart.includes(':')) {
          dataKeys.push(key);
        }
      }
      
      iterations++;
      // Safety check to prevent infinite loops
      if (iterations >= maxIterations) {
        warn('[StreamController] getSourceNames: Reached max iterations, stopping scan');
        break;
      }
    } while (cursor !== '0');
    
    // Extract source names directly from keys (skip timestamp check to prevent hangs)
    // The timestamp check was causing hangs when there are many sources or Redis is slow
    const sourceNames = dataKeys.map(key => key.replace('stream:', ''));
    
    return [...new Set(sourceNames)].sort(); // Remove duplicates and sort alphabetically
  } catch (err) {
    error(`[StreamController] Could not get source names:`, err.message);
    return [];
  }
}

/**
 * Log streaming status with source names
 */
async function logStreamingStatus(message) {
  try {
    const sourceNames = await getSourceNames();
    const sourceList = sourceNames.length > 0 ? ` [${sourceNames.join(', ')}]` : '';
    const fullMessage = `${message}${sourceList}`;
    
    await logMessage(
      '127.0.0.1', // client_ip
      '3dbcc8d0-6666-4359-8f60-211277d27326', // default user_id
      'server_stream/stream.js',
      'info',
      fullMessage,
      JSON.stringify({ sourceCount: sourceNames.length, sources: sourceNames })
    );
  } catch (err) {
    error('[StreamController] Error logging streaming status:', err.message);
  }
}

/**
 * Check streaming state and update accordingly
 * Logs when streaming starts (0 -> 1) or stops (1 -> 0)
 */
async function updateStreamingState() {
  const connections = connectionManager.getAllConnections().filter(conn => conn.state === 'connected');
  const wasStreaming = isStreaming;
  isStreaming = connections.length > 0;
  
  // Streaming started (was not streaming, now is)
  if (!wasStreaming && isStreaming) {
    await logStreamingStatus('Streaming started');
    
    // Start periodic status logging (every 60 seconds)
    if (streamingStatusInterval) {
      clearInterval(streamingStatusInterval);
    }
    streamingStatusInterval = setInterval(async () => {
      // Re-check streaming state to ensure it's still active
      const connections = connectionManager.getAllConnections().filter(conn => conn.state === 'connected');
      const currentlyStreaming = connections.length > 0;
      
      if (currentlyStreaming) {
        isStreaming = true;
        await logStreamingStatus('Streaming active with sources:');
      } else {
        // Stop interval if streaming stopped
        isStreaming = false;
        if (streamingStatusInterval) {
          clearInterval(streamingStatusInterval);
          streamingStatusInterval = null;
        }
      }
    }, 60000); // Every 60 seconds
  }
  
  // Streaming stopped (was streaming, now is not)
  if (wasStreaming && !isStreaming) {
    await logStreamingStatus('Streaming stopped');
    
    // Stop periodic status logging
    if (streamingStatusInterval) {
      clearInterval(streamingStatusInterval);
      streamingStatusInterval = null;
    }
    
    // CRITICAL: Disconnect all WebSocket clients when streaming stops
    // This ensures WebSockets are closed even if streaming stops due to inactivity or other reasons
    // Note: We need to get clientWSS from a request object, but this function doesn't have one
    // So we'll use the global reference if available, or skip if not
    if (typeof global !== 'undefined' && global.streamClientWSS) {
      try {
        global.streamClientWSS.disconnectAllClients('Streaming stopped - no active sources');
        log('[StreamController] Disconnected all WebSocket clients (streaming stopped - no active sources)');
      } catch (err) {
        error('[StreamController] Error disconnecting WebSocket clients in updateStreamingState:', err.message);
      }
    }
  }
}

// Start inactivity monitoring
const inactivityCheckInterval = setInterval(() => {
  const now = Date.now();
  for (const [source_id, lastTime] of lastDataReceived.entries()) {
    const inactiveTime = now - lastTime;
    if (inactiveTime > INACTIVITY_TIMEOUT_MS) {
      const sourceInstance = sourceInstances.get(source_id);
      const connection = connectionManager.getConnection(source_id);
      
      if (sourceInstance && connection && connection.state === 'connected') {
        log(`[StreamController] Source ${source_id} inactive for ${Math.floor(inactiveTime / 1000)}s, disconnecting...`);
        
        // Disconnect the source
        sourceInstance.disconnect();
        sourceInstances.delete(source_id);
        
        // Clean up lastDataReceived and processor state by source_name if connection has source_name
        const conn = connectionManager.getConnection(source_id);
        if (conn && conn.source_name) {
          const normalizedSourceName = String(conn.source_name).toUpperCase().trim();
          lastDataReceived.delete(normalizedSourceName);
          processor.clearState(normalizedSourceName);
        } else {
          // Fallback: clear by source_id for backward compatibility
          processor.clearState(source_id);
        }
        
        // Remove from connection manager
        connectionManager.removeConnection(source_id);
        
        // Reset auto-discovery flag so it can be re-triggered
        autoDiscoveryAttempted = false;
        
        log(`[StreamController] Source ${source_id} disconnected due to inactivity`);
        
        // Check if this was the last active source - if so, stop streaming and disconnect WebSockets
        const remainingConnections = connectionManager.getAllConnections().filter(conn => conn.state === 'connected');
        if (remainingConnections.length === 0) {
          // Last source disconnected - stop streaming
          streamingStarted = false;
          stopProactiveDiscovery();
          
          // Disconnect all WebSocket clients
          if (typeof global !== 'undefined' && global.streamClientWSS) {
            try {
              global.streamClientWSS.disconnectAllClients('Streaming stopped - all sources inactive');
              log('[StreamController] Disconnected all WebSocket clients (all sources inactive)');
            } catch (err) {
              error('[StreamController] Error disconnecting WebSocket clients after inactivity:', err.message);
            }
          }
        }
        
        // Update streaming state after disconnection
        updateStreamingState().catch(err => {
          error('[StreamController] Error updating streaming state after inactivity:', err.message);
        });
      }
    }
  }
}, 60000); // Check every minute

// Proactive discovery service - only runs when streaming is explicitly started
// Streaming will NOT start automatically - must be commanded from admin page
const PROACTIVE_DISCOVERY_INTERVAL_MS = 30000; // Check every 30 seconds

let proactiveDiscoveryInterval = null;

// Function to start proactive discovery (only when streaming is explicitly started)
function startProactiveDiscovery() {
  if (proactiveDiscoveryInterval) {
    return; // Already running
  }
  
  log('[StreamController] Starting proactive discovery service');
  proactiveDiscoveryInterval = setInterval(async () => {
    try {
      // Only run if streaming has been explicitly started
      if (!streamingStarted) {
        debug('[StreamController] Proactive discovery: Streaming not started, hibernating...');
        return;
      }
      
      const connections = connectionManager.getAllConnections();
      const activeConnections = connections.filter(c => c.state === 'connected');
      
      // Only check if we have no active connections
      if (activeConnections.length === 0) {
        log('[StreamController] Proactive discovery: No active connections, checking for data...');
        // Log state information separately to ensure it's captured
        const stateInfo = `streamingStarted=${streamingStarted}, influxDBStreamingEnabled=${influxDBStreamingEnabled}, autoDiscoveryAttempted=${autoDiscoveryAttempted}`;
        log(`[StreamController] Proactive discovery state: ${stateInfo}`);
        
        // Reset flag to allow discovery (must be done before calling autoConnectInfluxDBSources)
        autoDiscoveryAttempted = false;
        log('[StreamController] Proactive discovery: Reset autoDiscoveryAttempted to false, calling autoConnectInfluxDBSources()...');
        
        // Attempt to discover and connect
        // Note: autoConnectInfluxDBSources will set autoDiscoveryAttempted = true internally
        await autoConnectInfluxDBSources();
        
        // Update streaming state
        await updateStreamingState();
      } else {
        debug(`[StreamController] Proactive discovery: ${activeConnections.length} active connections, skipping check`);
      }
    } catch (err) {
      error('[StreamController] Error in proactive discovery:', err);
    }
  }, PROACTIVE_DISCOVERY_INTERVAL_MS);
}

// Function to stop proactive discovery
function stopProactiveDiscovery() {
  if (proactiveDiscoveryInterval) {
    clearInterval(proactiveDiscoveryInterval);
    proactiveDiscoveryInterval = null;
    log('[StreamController] Stopped proactive discovery service');
  }
}

// Cleanup on server shutdown
process.on('SIGTERM', () => {
  stopProactiveDiscovery();
  if (inactivityCheckInterval) {
    clearInterval(inactivityCheckInterval);
  }
});

process.on('SIGINT', () => {
  stopProactiveDiscovery();
  if (inactivityCheckInterval) {
    clearInterval(inactivityCheckInterval);
  }
});

/**
 * Helper function to check InfluxDB 2.x health
 * Uses HTTP /health endpoint first (fastest), falls back to minimal query if needed
 */
async function checkInfluxDBHealth(baseUrl) {
  const http = require('http');
  const https = require('https');
  
  // Ensure influx_host has protocol
  let influxUrl = baseUrl;
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }

  // First try: Use InfluxDB's built-in /health endpoint (fastest, no auth needed)
  return new Promise((resolve, reject) => {
    const url = new URL(`${influxUrl}/health`);
    const httpModule = url.protocol === 'https:' ? https : http;
    
    const req = httpModule.get(url.toString(), { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Health endpoint returns 200 with status info if healthy
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          // Health endpoint failed, try query-based check as fallback
          checkInfluxDBHealthWithQuery(baseUrl).then(resolve).catch(reject);
        }
      });
    });

    req.on('error', () => {
      // HTTP health check failed, try query-based check as fallback
      checkInfluxDBHealthWithQuery(baseUrl).then(resolve).catch(reject);
    });

    req.on('timeout', () => {
      req.destroy();
      // HTTP health check timed out, try query-based check as fallback
      checkInfluxDBHealthWithQuery(baseUrl).then(resolve).catch(reject);
    });
  });
}

/**
 * Fallback health check using minimal query (if /health endpoint unavailable)
 */
async function checkInfluxDBHealthWithQuery(baseUrl) {
  const { InfluxDB } = require('@influxdata/influxdb-client');
  
  // Get InfluxDB configuration from config module (ensures .env files are loaded)
  const influxToken = config.INFLUX_TOKEN;
  const influxDatabase = config.INFLUX_DATABASE; // This is the org name
  const influxBucket = config.INFLUX_BUCKET;

  if (!influxToken || !influxDatabase || !influxBucket) {
    throw new Error('InfluxDB environment variables not set (INFLUX_TOKEN, INFLUX_DATABASE, INFLUX_BUCKET)');
  }

  // Ensure influx_host has protocol
  let influxUrl = baseUrl;
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }

  return new Promise((resolve, reject) => {
    try {
      const influxClient = new InfluxDB({
        url: influxUrl,
        token: influxToken,
        timeout: 2000 // Fast timeout
      });
      const queryApi = influxClient.getQueryApi(influxDatabase);

      // Minimal query: smallest time range, limit to 1, no filters
      const testQuery = `from(bucket: "${influxBucket}")
  |> range(start: -10s)
  |> limit(n: 1)`;

      let hasError = false;

      const timeout = setTimeout(() => {
        if (!hasError) {
          hasError = true;
          try {
            if (influxClient && typeof influxClient.close === 'function') {
              influxClient.close();
            }
          } catch (closeErr) {
            // Ignore close errors
          }
          reject(new Error('Health check timeout'));
        }
      }, 2000); // 2 seconds - fast timeout

      queryApi.queryRows(testQuery, {
        next() {
          // Got data - resolve immediately
          clearTimeout(timeout);
          try {
            if (influxClient && typeof influxClient.close === 'function') {
              influxClient.close();
            }
          } catch (closeErr) {
            // Ignore close errors
          }
          resolve(true);
        },
        error(err) {
          if (!hasError) {
            hasError = true;
            clearTimeout(timeout);
            try {
              if (influxClient && typeof influxClient.close === 'function') {
                influxClient.close();
              }
            } catch (closeErr) {
              // Ignore close errors
            }
            reject(new Error(`Health check error: ${err.message}`));
          }
        },
        complete() {
          // Query completed successfully (with or without data)
          if (!hasError) {
            clearTimeout(timeout);
            try {
              if (influxClient && typeof influxClient.close === 'function') {
                influxClient.close();
              }
            } catch (closeErr) {
              // Ignore close errors
            }
            resolve(true);
          }
        }
      });
    } catch (err) {
      reject(new Error(`Health check error: ${err.message}`));
    }
  });
}

/**
 * Helper function to discover available sources (boats) from InfluxDB 2.x
 * Queries for data and extracts unique boat tags from the response
 * Uses a longer time window to find sources even if data isn't recent
 */
async function discoverInfluxDBSources(baseUrl, org) {
  const { InfluxDB } = require('@influxdata/influxdb-client');
  
  // Get InfluxDB configuration from config module (ensures .env files are loaded)
  const influxToken = config.INFLUX_TOKEN;
  const influxDatabase = config.INFLUX_DATABASE || org; // This is the org name
  const influxBucket = config.INFLUX_BUCKET;

  if (!influxToken || !influxDatabase || !influxBucket) {
    throw new Error('InfluxDB environment variables not set (INFLUX_TOKEN, INFLUX_DATABASE, INFLUX_BUCKET)');
  }

  // Ensure influx_host has protocol
  let influxUrl = baseUrl;
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }

  return new Promise((resolve, reject) => {
    try {
      const influxClient = new InfluxDB({
        url: influxUrl,
        token: influxToken,
        timeout: 5000 // Reduced from 10s for faster discovery
      });
      const queryApi = influxClient.getQueryApi(influxDatabase);

      // Query for data from the last 2 minutes to discover available boats (reduced from 5m for speed)
      // Use distinct early to minimize data processing
      const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: -2m)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")
  |> limit(n: 1)
  |> distinct(column: "boat")
  |> limit(n: 50)`;

      log(`[StreamController] Discovering sources with Flux query`);

      const sourceSet = new Set();
      let hasError = false;

          const timeout = setTimeout(() => {
            if (!hasError) {
              hasError = true;
              try {
                if (influxClient && typeof influxClient.close === 'function') {
                  influxClient.close();
                }
              } catch (closeErr) {
                // Ignore close errors
              }
              reject(new Error('Discovery query timeout'));
            }
          }, 5000); // Reduced from 10s for faster failure

      queryApi.queryRows(fluxQuery, {
        next(row, tableMeta) {
          try {
            const record = tableMeta.toObject(row);
            if (record.boat) {
              log(`[StreamController] Found boat tag: ${record.boat}`);
              sourceSet.add(record.boat);
            }
          } catch (err) {
            warn(`[StreamController] Error processing discovery row: ${err.message}`);
          }
        },
        error(err) {
          if (!hasError) {
            hasError = true;
            clearTimeout(timeout);
            try {
              if (influxClient && typeof influxClient.close === 'function') {
                influxClient.close();
              }
            } catch (closeErr) {
              // Ignore close errors
            }
            error(`[StreamController] Discovery query error: ${err.message}`);
            reject(new Error(`Discovery query error: ${err.message}`));
          }
        },
        complete() {
          if (!hasError) {
            clearTimeout(timeout);
            try {
              if (influxClient && typeof influxClient.close === 'function') {
                influxClient.close();
              }
            } catch (closeErr) {
              // Ignore close errors
            }
            const sources = Array.from(sourceSet);
            log(`[StreamController] Discovered ${sources.length} unique sources:`, sources);
            resolve(sources);
          }
        }
      });
    } catch (err) {
      reject(new Error(`Discovery error: ${err.message}`));
    }
  });
}

/**
 * Helper function to check if InfluxDB 2.x has recent data
 */
async function checkInfluxDBHasRecentData(baseUrl, org) {
  const { InfluxDB } = require('@influxdata/influxdb-client');
  
  // Get InfluxDB configuration from config module (ensures .env files are loaded)
  const influxToken = config.INFLUX_TOKEN;
  const influxDatabase = config.INFLUX_DATABASE || org; // This is the org name
  const influxBucket = config.INFLUX_BUCKET;

  if (!influxToken || !influxDatabase || !influxBucket) {
    return false;
  }

  // Ensure influx_host has protocol
  let influxUrl = baseUrl;
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }

  try {
    return new Promise((resolve, reject) => {
      try {
        const influxClient = new InfluxDB({
          url: influxUrl,
          token: influxToken,
          timeout: 5000 // 5 seconds timeout
        });
        const queryApi = influxClient.getQueryApi(influxDatabase);

        // Minimal query: check for any data in last 30 seconds, limit to 1 row
        const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: -30s)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")
  |> limit(n: 1)`;

        let hasData = false;
        let isComplete = false;

        const timeout = setTimeout(() => {
          if (!isComplete) {
            isComplete = true;
            try {
              influxClient.close();
            } catch (closeErr) {
              // Ignore close errors
            }
            log(`[StreamController] Recent data check timeout after 5 seconds, assuming no recent data`);
            resolve(false);
          }
        }, 5000); // 5 second timeout

        queryApi.queryRows(fluxQuery, {
          next() {
            hasData = true;
            if (!isComplete) {
              isComplete = true;
              clearTimeout(timeout);
              try {
                influxClient.close();
              } catch (closeErr) {
                // Ignore close errors
              }
              resolve(true);
            }
          },
          error(err) {
            if (!isComplete) {
              isComplete = true;
              clearTimeout(timeout);
              try {
                influxClient.close();
              } catch (closeErr) {
                // Ignore close errors
              }
              log(`[StreamController] Recent data check error: ${err.message}`);
              resolve(false); // Resolve with false instead of rejecting
            }
          },
          complete() {
            if (!isComplete) {
              isComplete = true;
              clearTimeout(timeout);
              try {
                influxClient.close();
              } catch (closeErr) {
                // Ignore close errors
              }
              resolve(hasData);
            }
          }
        });
      } catch (err) {
        log(`[StreamController] Recent data check exception: ${err.message}`);
        resolve(false);
      }
    });
  } catch (err) {
    log(`[StreamController] Recent data check outer exception: ${err.message}`);
    return false;
  }
}

/**
 * Check if Redis should be flushed due to long gap (>1 hour)
 * Returns true if Redis was flushed, false otherwise
 */
async function checkAndFlushRedisIfNeeded() {
  try {
    const GAP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
    const latestTimestamp = await redisStorage.getLatestTimestampAcrossAllSources();

    if (latestTimestamp === null) {
      // No data in Redis, nothing to flush
      return false;
    }

    const now = Date.now();
    const gapMs = now - latestTimestamp;

    if (gapMs > GAP_THRESHOLD_MS) {
      const gapHours = (gapMs / (60 * 60 * 1000)).toFixed(2);
      log(`[StreamController] Detected long gap in Redis data: ${gapHours} hours since last data point`);
      log(`[StreamController] Last data point: ${new Date(latestTimestamp).toISOString()}`);
      log(`[StreamController] Current time: ${new Date(now).toISOString()}`);
      log(`[StreamController] Flushing Redis database to start fresh...`);

      const flushed = await redisStorage.flushDatabase();
      if (flushed) {
        log('[StreamController] Redis database flushed successfully - ready for new data');
        // CRITICAL: Clear lastInsertedTimestamp when Redis is flushed
        // This ensures new data can be inserted after a flush
        lastInsertedTimestamp.clear();
        log('[StreamController] Cleared lastInsertedTimestamp tracking after Redis flush');
        return true;
      } else {
        warn('[StreamController] Failed to flush Redis database, continuing anyway');
        return false;
      }
    }

    return false;
  } catch (err) {
    error('[StreamController] Error checking Redis gap:', err.message);
    return false;
  }
}

/**
 * Helper function to auto-connect to InfluxDB sources
 */
async function autoConnectInfluxDBSources() {
  // Check if streaming has been explicitly started
  if (!streamingStarted) {
    log('[StreamController] Auto-discovery skipped: streaming not started (streamingStarted=false)');
    return;
  }
  
  // Check if InfluxDB streaming is disabled
  if (!influxDBStreamingEnabled) {
    log('[StreamController] Auto-discovery skipped: InfluxDB streaming is disabled - enable it via the admin page toggle');
    return;
  }
  
  // Only attempt once per server restart (unless reset)
  if (autoDiscoveryAttempted) {
    log('[StreamController] Auto-discovery skipped: already attempted (will retry on next proactive check)');
    return;
  }
  autoDiscoveryAttempted = true;
  log('[StreamController] Starting auto-discovery (autoDiscoveryAttempted set to true)');

  try {
    // Check if Redis should be flushed due to long gap (>1 hour)
    log('[StreamController] Checking Redis flush status...');
    await checkAndFlushRedisIfNeeded();
    log('[StreamController] Redis flush check completed');

    // Get InfluxDB config from environment (matching 1_normalization_influx.py)
    // Use config module to ensure .env files are loaded (same as test scripts)
    log('[StreamController] Reading InfluxDB config from config module...');
    const influxHost = config.INFLUX_HOST;
    const influxDatabase = config.INFLUX_DATABASE; // This is the org name
    const influxBucket = config.INFLUX_BUCKET;
    log(`[StreamController] Config values: INFLUX_HOST=${influxHost ? 'SET' : 'NOT SET'}, INFLUX_DATABASE=${influxDatabase ? 'SET' : 'NOT SET'}, INFLUX_BUCKET=${influxBucket ? 'SET' : 'NOT SET'}`);

    if (!influxHost || !influxDatabase || !influxBucket) {
      log('[StreamController] InfluxDB environment variables not set (INFLUX_HOST, INFLUX_DATABASE, INFLUX_BUCKET), skipping auto-discovery');
      autoDiscoveryAttempted = false;
      return;
    }
    
    // Handle INFLUX_HOST that might already contain protocol
    let baseUrl = influxHost;
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      baseUrl = `http://${baseUrl}`;
    }

    log('[StreamController] Attempting auto-discovery of InfluxDB 2.x sources...');
    log(`[StreamController] InfluxDB config: ${baseUrl}, org: ${influxDatabase}, bucket: ${influxBucket}`);

    // Check if InfluxDB is available
    try {
      log('[StreamController] Starting InfluxDB health check...');
      await checkInfluxDBHealth(baseUrl);
      log('[StreamController] InfluxDB 2.x is available');
    } catch (err) {
      error(`[StreamController] InfluxDB 2.x health check failed: ${err.message}`);
      error(`[StreamController] Health check error stack:`, err.stack);
      autoDiscoveryAttempted = false;
      return;
    }

    // Skip recent data check for now - it's causing hangs and we'll connect anyway
    // The inactivity timeout will handle disconnection if no data arrives
    // For initial connection, we'll be more lenient - connect if InfluxDB is available
    log('[StreamController] Skipping recent data check - proceeding directly to source discovery');

    // Discover available sources (boats)
    log('[StreamController] Starting source discovery...');
    let availableSources = [];
    try {
      availableSources = await discoverInfluxDBSources(baseUrl, influxDatabase);
      log(`[StreamController] Discovered ${availableSources.length} sources:`, availableSources);

      if (availableSources.length === 0) {
        log('[StreamController] No sources found in InfluxDB simulator');
        // Reset flag so we can check again later
        autoDiscoveryAttempted = false;
        return;
      }
    } catch (err) {
      error(`[StreamController] Source discovery failed: ${err.message}`);
      error(`[StreamController] Source discovery error stack:`, err.stack);
      autoDiscoveryAttempted = false;
      return;
    }

    // Connect to each discovered source
    for (let i = 0; i < availableSources.length; i++) {
      const sourceTag = availableSources[i];
      const source_id = i + 1; // Use sequential IDs starting from 1

      // Skip if source already exists
      if (connectionManager.getConnection(source_id)) {
        debug(`[StreamController] Source ${source_id} already exists, skipping`);
        continue;
      }

      try {
        const pollIntervalMs = parseInt(config.STREAM_LIVE_POLL_INTERVAL_MS || process.env.STREAM_LIVE_POLL_INTERVAL_MS || '5000', 10);
        const connectionConfig = {
          source: sourceTag, // Boat name (maps to 'boat' tag in InfluxDB)
          pollInterval: pollIntervalMs, // From STREAM_LIVE_POLL_INTERVAL_MS env
          timeRange: '1s', // Query last 1 second of data
          initialTimeRange: '30s' // Use 30 seconds for initial query (not used with Flux)
        };

        // Add to connection manager
        const added = connectionManager.addConnection({
          source_id,
          type: 'influxdb',
          config: connectionConfig
        });

        if (!added) {
          warn(`[StreamController] Failed to add connection for source ${source_id}`);
          continue;
        }

        // Create source instance
        const sourceInstance = createInfluxDBSource(source_id, connectionConfig);

        // Store instance
        sourceInstances.set(source_id, sourceInstance);

        // Setup data flow: source -> processor -> websocket (immediate) -> redis (async, non-blocking)
        // Use setImmediate to prevent blocking the event loop
        sourceInstance.on('data', (dataPoint) => {
          // Track when we received the data point
          const receiveTime = Date.now();
          
          // Process asynchronously to avoid blocking event loop
          setImmediate(async () => {
            // Update last data received time
            lastDataReceived.set(source_id, receiveTime);
            
            // OPTIMIZED: Reduce logging overhead - only log first data point
            const isFirstDataPoint = !lastDataReceived.has(source_id);
            if (isFirstDataPoint) {
              log(`[StreamController] Source ${source_id} received first data point at ${dataPoint.timestamp ? new Date(dataPoint.timestamp).toISOString() : 'unknown time'}`);
            }
            
            const processed = processor.process(dataPoint);
          debug(`[StreamController] Source ${source_id} processor result:`, {
            processed: !!processed,
            hasProcessedData: processed ? !!processed.data : false,
            processedKeys: processed ? Object.keys(processed) : []
          });
          if (processed) {
            // Track successful processing
            processingStats.successCount++;
            processingStats.lastSuccessTime = Date.now();
            
            // Processor returns clean data with normalized channel names
            const timestamp = processed.timestamp;
            const data = processed.data;
            
            // Extract source_name from processed data (this is the unique identifier)
            const source_name = data.source_name || null;
            
            // Validate source_name exists (required - this is our unique identifier)
            if (!source_name) {
              processingStats.errorCount++;
              processingStats.lastError = 'Missing source_name';
              processingStats.lastErrorTime = Date.now();
              warn(`[StreamController] Processed data missing source_name, skipping`);
              return;
            }
            
            // OPTIMIZED: Normalize source_name once and reuse
            const normalizedSourceName = String(source_name).toUpperCase().trim();
            
            // OPTIMIZED: Fast validation - check required fields
            if (!timestamp || !data) {
              processingStats.errorCount++;
              processingStats.lastError = 'Missing required fields';
              processingStats.lastErrorTime = Date.now();
              warn(`[StreamController] Source "${normalizedSourceName}" processed data missing required fields`);
              return;
            }
            
            // Track last data received time by source_name (not source_id)
            const isFirstDataPoint = !lastDataReceived.has(normalizedSourceName);
            if (isFirstDataPoint) {
              log(`[StreamController] Source "${normalizedSourceName}" received first data point at ${timestamp ? new Date(timestamp).toISOString() : 'unknown time'}`);
            }
            lastDataReceived.set(normalizedSourceName, receiveTime);
            
            // OPTIMIZED: Fast duplicate check - check before any other processing
            const lastTimestamp = lastInsertedTimestamp.get(normalizedSourceName);
            if (lastTimestamp !== undefined && timestamp <= lastTimestamp) {
              // Skip duplicate - already processed
              processingStats.skippedDuplicateCount++;
              return;
            }
            
            // CRITICAL: Update lastInsertedTimestamp BEFORE attempting insert
            // This tracks "last attempted insert" to prevent duplicates even if insert fails
            // This ensures we don't keep trying to insert the same data repeatedly
            lastInsertedTimestamp.set(normalizedSourceName, timestamp);
            
            // Track that we're processing NEW data (not a duplicate)
            processingStats.processedNewDataCount++;
            processingStats.lastNewDataProcessedTime = Date.now();
            
            // OPTIMIZED: Buffer data for WebSocket broadcast (sent at 0.5-second intervals)
            // This provides smooth, regular updates instead of bursts every 5 seconds
            const wsServer = typeof global !== 'undefined' ? global.streamClientWSS : null;
            if (wsServer) {
              try {
                wsServer.bufferForBroadcast(processed);
              } catch (wsErr) {
                // Don't block on WebSocket errors - log and continue
                debug(`[StreamController] WebSocket buffer error: ${wsErr.message}`);
              }
            }
            
            // OPTIMIZED: Build channels object efficiently (skip timestamp/Datetime)
            const channelsObject = {};
            const dataKeys = Object.keys(data);
            for (let i = 0; i < dataKeys.length; i++) {
              const key = dataKeys[i];
              if (key !== 'timestamp' && key !== 'Datetime') {
                const value = data[key];
                if (value !== undefined && value !== null) {
                  channelsObject[key] = value;
                }
              }
            }
            
            const channelsToStore = Object.keys(channelsObject);
            
            // OPTIMIZED: Log only first data point or periodically (reduced frequency)
            if (isFirstDataPoint || (processingPerformance.totalProcessed % 100 === 0)) {
              log(`[StreamController] Source "${normalizedSourceName}" processed data point, storing ${channelsToStore.length} channels`);
            }
            
            // OPTIMIZED: Redis write is now NON-BLOCKING - fire and forget
            // This ensures WebSocket clients get data immediately even if Redis is slow
            redisStats.attemptCount++;
            
            // Use setImmediate to make Redis write truly non-blocking
            setImmediate(async () => {
              try {
                const redisStartTime = Date.now();
                await redisStorage.storeDataPoint(source_name, timestamp, channelsObject);
                const redisEndTime = Date.now();
                const redisWriteTime = redisEndTime - redisStartTime;
                
                redisStats.successCount++;
                redisStats.lastSuccessTime = Date.now();
                
                // Track that NEW data was actually inserted
                redisStats.insertedNewDataCount++;
                redisStats.lastNewDataInsertedTime = Date.now();
                
                // Track trip time: from receiving data to Redis write completion
                const tripTime = Date.now() - receiveTime;
                processingPerformance.totalProcessed++;
                processingPerformance.lastProcessedTimestamp = Date.now();
                
                // OPTIMIZED: Only add to trip time history if significant (reduce array operations)
                if (processingPerformance.tripTimes.length < processingPerformance.maxTripTimeHistory) {
                  processingPerformance.tripTimes.push(tripTime);
                } else {
                  // Replace oldest with new value (circular buffer)
                  processingPerformance.tripTimes[processingPerformance.totalProcessed % processingPerformance.maxTripTimeHistory] = tripTime;
                }
                
                // OPTIMIZED: Only calculate stats periodically or when slow
                if (processingPerformance.totalProcessed % 50 === 0 || tripTime > 1000 || redisWriteTime > 1000) {
                  const avgTripTime = processingPerformance.tripTimes.reduce((a, b) => a + b, 0) / processingPerformance.tripTimes.length;
                  log(`[StreamController] Trip time: total=${tripTime}ms, redis=${redisWriteTime}ms, avg=${avgTripTime.toFixed(1)}ms`);
                }
                
              } catch (err) {
                redisStats.errorCount++;
                redisStats.lastError = err.message;
                redisStats.lastErrorTime = Date.now();
                error(`[StreamController] Error storing data point to Redis for source "${normalizedSourceName}":`, {
                  error: err.message,
                  errorStack: err.stack,
                  source_name: normalizedSourceName,
                  timestamp,
                  channelCount: channelsToStore.length,
                  note: 'WebSocket broadcast should still work even if Redis fails'
                });
              }
            });
          } else {
            processingStats.errorCount++;
            processingStats.lastError = 'Processor returned null';
            processingStats.lastErrorTime = Date.now();
            warn(`[StreamController] Source ${source_id} data point processing returned null`, {
              dataPointKeys: Object.keys(dataPoint || {}),
              hasTimestamp: !!(dataPoint?.timestamp),
              hasData: !!(dataPoint?.data),
              hasSourceId: !!(dataPoint?.source_id),
              dataKeys: dataPoint?.data ? Object.keys(dataPoint.data) : []
            });
            debug(`[StreamController] Source ${source_id} processing failed (null), stats: success=${processingStats.successCount}, errors=${processingStats.errorCount}`);
          }
          });
        });

        // Connect the source
        await sourceInstance.connect();
        
        // CRITICAL: Initialize lastInsertedTimestamp from Redis for this source
        // This ensures we don't block new inserts if Redis has old data
        // Note: lastDataReceived is now tracked by source_name (from incoming data), not source_id
        try {
          const source_name = connectionConfig.source_name || sourceTag;
          const normalizedSourceName = String(source_name).toUpperCase().trim();
          const latestInRedis = await redisStorage.getLatestTimestamp(normalizedSourceName);
          if (latestInRedis) {
            lastInsertedTimestamp.set(normalizedSourceName, latestInRedis);
            log(`[StreamController] Initialized lastInsertedTimestamp for ${normalizedSourceName} from Redis: ${latestInRedis} (${new Date(latestInRedis).toISOString()})`);
          } else {
            // No data in Redis, clear any stale entry
            lastInsertedTimestamp.delete(normalizedSourceName);
            log(`[StreamController] No data in Redis for ${normalizedSourceName}, cleared lastInsertedTimestamp`);
          }
        } catch (initErr) {
          warn(`[StreamController] Error initializing lastInsertedTimestamp for source ${source_id}:`, initErr.message);
        }
        
        // Verify connection state
        const connection = connectionManager.getConnection(source_id);
        log(`[StreamController] Auto-connected to InfluxDB source ${source_id} (${sourceTag}), state: ${connection?.state}`);
        
        // Update streaming state after connection
        await updateStreamingState();
      } catch (err) {
        error(`[StreamController] Failed to auto-connect source ${source_id} (${sourceTag}):`, err.message);
        error(`[StreamController] Error stack:`, err.stack);
        connectionManager.removeConnection(source_id);
      }
    }
  } catch (err) {
    error(`[StreamController] Auto-discovery failed: ${err.message}`);
    error(`[StreamController] Auto-discovery error stack:`, err.stack);
    // Reset flag so we can try again on next request
    autoDiscoveryAttempted = false;
  }
}

/**
 * List all active sources
 * Source names come from Redis (via getSourceNames())
 */
exports.getSources = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getSources' };

  try {
    let connections = connectionManager.getAllConnections();
    log(`[StreamController] getSources called, current connections: ${connections.length}`);
    
    // If no sources exist, reset auto-discovery flag and attempt auto-discovery
    if (connections.length === 0) {
      log('[StreamController] No sources found, resetting auto-discovery and attempting...');
      autoDiscoveryAttempted = false; // Reset so we can check for new data
      await autoConnectInfluxDBSources();
      connections = connectionManager.getAllConnections();
      log(`[StreamController] After auto-discovery, connections: ${connections.length}`);
    }
    
    // Get all source names from Redis
    const sourceNames = await getSourceNames();
    
    // Return sources with source_name only (no source_id mapping)
    const sources = sourceNames.map(source_name => ({
      source_name: source_name,
      // Note: source_id is not available - client must map source_name to source_id
    }));

    return sendResponse(res, info, 200, true, "Sources retrieved", sources);
  } catch (err) {
    error('[StreamController] Error getting sources:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get source status
 */
exports.getSourceStatus = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getSourceStatus' };
  const source_name = req.params.source_name;

  try {
    if (!source_name) {
      return sendResponse(res, info, 400, false, "source_name parameter is required", null);
    }

    // Check if Redis is connected before querying
    if (!redisStorage.isConnected) {
      warn(`[StreamController] Redis not connected, cannot get source status. Streaming may not be active.`);
      return sendResponse(res, info, 503, false, "Redis not connected. Streaming may not be active.", {
        source_name,
        channels: [],
        latest_timestamp: null
      });
    }

    // Get channels from Redis using source_name
    const channels = await redisStorage.getChannels(source_name);
    const latestTimestamp = await redisStorage.getLatestTimestamp(source_name);

    const status = {
      source_name: source_name,
      channels: channels,
      latest_timestamp: latestTimestamp
    };

    return sendResponse(res, info, 200, true, "Source status retrieved", status);
  } catch (err) {
    error('[StreamController] Error getting source status:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Add/configure new source connection
 */
exports.addSource = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'addSource' };

  try {
    const { source_id, type, config: connectionConfig } = req.body;

    if (!source_id || !type) {
      return sendResponse(res, info, 400, false, "source_id and type are required", null);
    }

    // Add to connection manager
    const added = connectionManager.addConnection({
      source_id: parseInt(source_id),
      type,
      config: connectionConfig
    });

    if (!added) {
      return sendResponse(res, info, 400, false, "Failed to add connection (may already exist or max connections reached)", null);
    }

      // Create source instance based on type
      let sourceInstance;
      try {
        if (type === 'websocket') {
          websocketStats.attemptCount++;
          websocketStats.lastAttemptTime = Date.now();
          sourceInstance = createWebSocketSource(parseInt(source_id), connectionConfig);
          websocketStats.successCount++;
        } else if (type === 'influxdb') {
          sourceInstance = createInfluxDBSource(parseInt(source_id), connectionConfig);
        } else {
          connectionManager.removeConnection(parseInt(source_id));
          return sendResponse(res, info, 400, false, `Unknown connection type: ${type}`, null);
        }

      // Store instance
      sourceInstances.set(parseInt(source_id), sourceInstance);

      // Setup data flow: source -> processor -> websocket (immediate) -> redis (async, non-blocking)
      sourceInstance.on('data', (dataPoint) => {
        // Track when we received the data point
        const receiveTime = Date.now();
        
        // Process asynchronously to avoid blocking event loop
        setImmediate(async () => {
          // Update last data received time
          lastDataReceived.set(parseInt(source_id), receiveTime);
          
          // OPTIMIZED: Reduce logging overhead - only log first data point
          const isFirstDataPoint = !lastDataReceived.has(parseInt(source_id));
          if (isFirstDataPoint) {
            log(`[StreamController] Source ${source_id} received first data point at ${dataPoint.timestamp ? new Date(dataPoint.timestamp).toISOString() : 'unknown time'}`);
          }
          
          const processed = processor.process(dataPoint);
        if (processed) {
          // Track successful processing
          processingStats.successCount++;
          processingStats.lastSuccessTime = Date.now();
          
          // Processor returns clean data with normalized channel names
          const processedSourceId = processed.source_id;
          const timestamp = processed.timestamp;
          const data = processed.data;
          
          // OPTIMIZED: Fast validation - check required fields first
          if (!processedSourceId || !timestamp || !data) {
            processingStats.errorCount++;
            processingStats.lastError = 'Missing required fields';
            processingStats.lastErrorTime = Date.now();
            if (isFirstDataPoint) {
              warn(`[StreamController] Source ${source_id} processed data missing required fields`);
            }
            return;
          }
          
          // Extract source_name from processed data
          const source_name = data.source_name || null;
          
          // Validate source_name exists
          if (!source_name) {
            processingStats.errorCount++;
            processingStats.lastError = 'Missing source_name';
            processingStats.lastErrorTime = Date.now();
            if (isFirstDataPoint) {
              warn(`[StreamController] Source ${source_id} processed data missing source_name`);
            }
            return;
          }
          
          // OPTIMIZED: Normalize source_name once and reuse
          const normalizedSourceName = String(source_name).toUpperCase().trim();
          
          // OPTIMIZED: Fast duplicate check - check before any other processing
          const lastTimestamp = lastInsertedTimestamp.get(normalizedSourceName);
          if (lastTimestamp !== undefined && timestamp <= lastTimestamp) {
            // Skip duplicate - already processed
            processingStats.skippedDuplicateCount++;
            return;
          }
          
          // CRITICAL: Update lastInsertedTimestamp BEFORE attempting insert
          // This tracks "last attempted insert" to prevent duplicates even if insert fails
          // This ensures we don't keep trying to insert the same data repeatedly
          lastInsertedTimestamp.set(normalizedSourceName, timestamp);
          
          // Track that we're processing NEW data (not a duplicate)
          processingStats.processedNewDataCount++;
          processingStats.lastNewDataProcessedTime = Date.now();
          
          // OPTIMIZED: Buffer data for WebSocket broadcast (sent at 0.5-second intervals)
          // This provides smooth, regular updates instead of sending every message
          // The buffered broadcast ensures clients get updates at a consistent 2 Hz rate
          const wsServer = typeof global !== 'undefined' ? global.streamClientWSS : null;
          if (wsServer) {
            try {
              wsServer.bufferForBroadcast(processed);
            } catch (wsErr) {
              // Don't block on WebSocket errors - log and continue
              debug(`[StreamController] WebSocket buffer error: ${wsErr.message}`);
            }
          }
          
          // OPTIMIZED: Build channels object efficiently (skip timestamp/Datetime)
          const channelsObject = {};
          const dataKeys = Object.keys(data);
          for (let i = 0; i < dataKeys.length; i++) {
            const key = dataKeys[i];
            if (key !== 'timestamp' && key !== 'Datetime') {
              const value = data[key];
              if (value !== undefined && value !== null) {
                channelsObject[key] = value;
              }
            }
          }
          
          const channelsToStore = Object.keys(channelsObject);
          
            // OPTIMIZED: Log only first data point or periodically (reduced frequency)
            if (isFirstDataPoint || (processingPerformance.totalProcessed % 100 === 0)) {
              log(`[StreamController] Source "${normalizedSourceName}" processed data point, storing ${channelsToStore.length} channels`);
            }
          
          // OPTIMIZED: Redis write is now NON-BLOCKING - fire and forget
          // This ensures WebSocket clients get data immediately even if Redis is slow
          redisStats.attemptCount++;
          
          // Use setImmediate to make Redis write truly non-blocking
          setImmediate(async () => {
            try {
              const redisStartTime = Date.now();
              await redisStorage.storeDataPoint(source_name, timestamp, channelsObject);
              const redisEndTime = Date.now();
              const redisWriteTime = redisEndTime - redisStartTime;
              
              redisStats.successCount++;
              redisStats.lastSuccessTime = Date.now();
              
              // Track that NEW data was actually inserted
              redisStats.insertedNewDataCount++;
              redisStats.lastNewDataInsertedTime = Date.now();
              
              // Track trip time: from receiving data to Redis write completion
              const tripTime = Date.now() - receiveTime;
              processingPerformance.totalProcessed++;
              processingPerformance.lastProcessedTimestamp = Date.now();
              
              // OPTIMIZED: Add to trip time history (circular buffer for efficiency)
              if (processingPerformance.tripTimes.length < processingPerformance.maxTripTimeHistory) {
                processingPerformance.tripTimes.push(tripTime);
              } else {
                // Circular buffer: replace oldest entry
                const index = processingPerformance.totalProcessed % processingPerformance.maxTripTimeHistory;
                processingPerformance.tripTimes[index] = tripTime;
              }
              
              // OPTIMIZED: Only calculate stats periodically or when slow
              if (processingPerformance.totalProcessed % 50 === 0 || tripTime > 1000 || redisWriteTime > 1000) {
                const avgTripTime = processingPerformance.tripTimes.reduce((a, b) => a + b, 0) / processingPerformance.tripTimes.length;
                log(`[StreamController] Trip time: total=${tripTime}ms, redis=${redisWriteTime}ms, avg=${avgTripTime.toFixed(1)}ms`);
              }
              
              } catch (err) {
                redisStats.errorCount++;
                redisStats.lastError = err.message;
                redisStats.lastErrorTime = Date.now();
                error(`[StreamController] Error storing data point to Redis for source "${normalizedSourceName}":`, {
                  error: err.message,
                  errorStack: err.stack,
                  source_name: normalizedSourceName,
                  timestamp,
                  channelCount: channelsToStore.length,
                  note: 'WebSocket broadcast should still work even if Redis fails'
                });
              }
          });
        } else {
          if (isFirstDataPoint) {
            warn(`[StreamController] Source ${source_id} data point processing returned null`);
          }
        }
        });
      });

      // Connect the source
      try {
        await sourceInstance.connect();
        if (type === 'websocket') {
          websocketStats.activeConnections++;
        }
      } catch (connectErr) {
        if (type === 'websocket') {
          websocketStats.errorCount++;
          websocketStats.lastError = connectErr.message;
          websocketStats.lastErrorTime = Date.now();
        }
        throw connectErr;
      }
      
      // Note: lastDataReceived is now tracked by source_name (from incoming data), not source_id
      // It will be set when the first data point arrives with a source_name
      
      // Update streaming state after connection
      await updateStreamingState();

      return sendResponse(res, info, 201, true, "Source added and connected", { source_id: parseInt(source_id) });
    } catch (err) {
      error('[StreamController] Error creating source instance:', err.message);
      if (type === 'websocket') {
        websocketStats.errorCount++;
        websocketStats.lastError = err.message;
        websocketStats.lastErrorTime = Date.now();
      }
      connectionManager.removeConnection(parseInt(source_id));
      return sendResponse(res, info, 500, false, err.message, null, true);
    }
  } catch (err) {
    error('[StreamController] Error adding source:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Remove source connection
 */
exports.removeSource = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'removeSource' };
  const source_id = parseInt(req.params.source_id);

  try {
    // Disconnect source instance
    const sourceInstance = sourceInstances.get(source_id);
    if (sourceInstance) {
      sourceInstance.disconnect();
      sourceInstances.delete(source_id);
      
      // Clean up lastDataReceived by source_name if connection has source_name
      const conn = connectionManager.getConnection(source_id);
      if (conn && conn.source_name) {
        const normalizedSourceName = String(conn.source_name).toUpperCase().trim();
        lastDataReceived.delete(normalizedSourceName);
      }
    }

    // Remove from connection manager
    const removed = connectionManager.removeConnection(source_id);
    if (!removed) {
      return sendResponse(res, info, 404, false, "Source not found", null);
    }

    // Clear processor state by source_name if connection has source_name
    const conn = connectionManager.getConnection(source_id);
    if (conn && conn.source_name) {
      const normalizedSourceName = String(conn.source_name).toUpperCase().trim();
      processor.clearState(normalizedSourceName);
    } else {
      // Fallback: clear by source_id for backward compatibility
      processor.clearState(source_id);
    }
    
    // Update streaming state after removal
    await updateStreamingState();

    return sendResponse(res, info, 200, true, "Source removed", null);
  } catch (err) {
    error('[StreamController] Error removing source:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Query historical data from Redis
 */
exports.getSourceData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getSourceData' };
  const source_name = req.params.source_name;
  const { channel, startTime, endTime } = req.query;

  try {
    if (!source_name) {
      return sendResponse(res, info, 400, false, "source_name parameter is required", null);
    }

    if (!channel) {
      return sendResponse(res, info, 400, false, "channel parameter is required", null);
    }

    const start = startTime ? parseInt(startTime) : Date.now() - 3600000; // Default: last hour
    const end = endTime ? parseInt(endTime) : Date.now();

    // Log the query parameters
    debug(`[StreamController] getSourceData called`, {
      source_name,
      channel,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      startMs: start,
      endMs: end,
      rangeHours: (end - start) / (60 * 60 * 1000)
    });

    // Check if Redis is connected before querying
    if (!redisStorage.isConnected) {
      warn(`[StreamController] Redis not connected, cannot query data. Streaming may not be active.`);
      return sendResponse(res, info, 503, false, "Redis not connected. Streaming may not be active.", {
        source_name,
        channel,
        startTime: start,
        endTime: end,
        count: 0,
        dataPoints: []
      });
    }

    const dataPoints = await redisStorage.query(source_name, channel, start, end);

    // Log the results
    if (dataPoints.length === 0) {
      warn(`[StreamController] getSourceData returned 0 points`, {
        source_name,
        channel,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        startMs: start,
        endMs: end
      });
    } else {
      debug(`[StreamController] getSourceData returned ${dataPoints.length} points`, {
        source_name,
        channel,
        firstTimestamp: dataPoints[0] ? new Date(dataPoints[0].timestamp).toISOString() : 'none',
        lastTimestamp: dataPoints[dataPoints.length - 1] ? new Date(dataPoints[dataPoints.length - 1].timestamp).toISOString() : 'none'
      });
    }

    return sendResponse(res, info, 200, true, "Data retrieved", {
      source_name,
      channel,
      startTime: start,
      endTime: end,
      count: dataPoints.length,
      data: dataPoints
    });
  } catch (err) {
    error('[StreamController] Error getting source data:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get available channels for a source
 */
exports.getSourceChannels = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getSourceChannels' };
  const source_name = req.params.source_name;

  try {
    if (!source_name) {
      return sendResponse(res, info, 400, false, "source_name parameter is required", null);
    }

    // Check if Redis is connected before querying
    if (!redisStorage.isConnected) {
      warn(`[StreamController] Redis not connected, cannot get channels. Streaming may not be active.`);
      return sendResponse(res, info, 503, false, "Redis not connected. Streaming may not be active.", {
        source_name,
        channels: []
      });
    }

    const channels = await redisStorage.getChannels(source_name);

    return sendResponse(res, info, 200, true, "Channels retrieved", {
      source_name,
      channels
    });
  } catch (err) {
    error('[StreamController] Error getting source channels:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get live streaming config (poll interval, buffer) for frontend
 * Used for InfluxDB poll, WebSocket broadcast, and client buffer/timer
 */
exports.getStreamConfig = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getStreamConfig' };

  try {
    const pollIntervalMs = parseInt(config.STREAM_LIVE_POLL_INTERVAL_MS || process.env.STREAM_LIVE_POLL_INTERVAL_MS || '5000', 10);
    const bufferMs = pollIntervalMs; // Same as poll for consistency
    return sendResponse(res, info, 200, true, "Stream config retrieved", {
      pollIntervalMs,
      bufferMs
    });
  } catch (err) {
    error('[StreamController] Error getting stream config:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get lightweight streaming status (fast check without querying Redis)
 * Returns whether streaming is available based on active connections
 */
exports.getStreamingStatus = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getStreamingStatus' };

  try {
    // CRITICAL: Check if there are active polling timers running
    // This is the PRIMARY signal - if no timers are running, we're NOT streaming
    let activePollingTimers = 0;
    for (const [sourceId, sourceInstance] of sourceInstances.entries()) {
      // Check if this source has an active polling timer
      if (sourceInstance && sourceInstance.pollInterval) {
        activePollingTimers++;
      }
    }
    
    // Primary signal: Check if there are active source instances (InfluxDB polling/querying)
    // If sourceInstances exist, the server is actively querying data sources
    const activeSourceInstances = sourceInstances.size;
    
    // Secondary check: Active connections
    const connections = connectionManager.getAllConnections();
    const activeConnections = connections.filter(conn => conn.state === 'connected');
    const influxConnections = connections.filter(conn => conn.type === 'influxdb' && conn.state === 'connected');
    
    // Check if InfluxDB streaming is enabled and we have connections
    // Even if no data has been received yet, if sources are connected and polling, streaming is active
    const hasActiveInfluxSources = influxDBStreamingEnabled && influxConnections.length > 0;
    
    // CRITICAL: Only consider streaming active if:
    // 1. streamingStarted flag is true AND
    // 2. There are active polling timers running (this is the real indicator)
    // If no timers are running, we're NOT streaming regardless of other flags
    const isActuallyStreaming = streamingStarted && activePollingTimers > 0;
    
    if (isActuallyStreaming && (activeSourceInstances > 0 || activeConnections.length > 0 || hasActiveInfluxSources)) {
      const totalSources = Math.max(activeSourceInstances, activeConnections.length, influxConnections.length);
      debug(`[StreamController] Streaming status: ${activeSourceInstances} active source instances, ${activeConnections.length} active connections, ${influxConnections.length} InfluxDB connections`);
      
      return sendResponse(res, info, 200, true, "Streaming status retrieved", {
        hasStreaming: true,
        sourceCount: totalSources,
        activeConnections: activeConnections.length,
        activeSourceInstances: activeSourceInstances,
        activePollingTimers: activePollingTimers,
        influxConnections: influxConnections.length,
        influxStreamingEnabled: influxDBStreamingEnabled,
        streamingStarted: streamingStarted
      });
    }
    
    // Fallback: Check Redis for sources with recent data
    // BUT: Only return hasStreaming=true if streaming is actually started
    // If streaming is disabled, don't show LIVE dataset even if old data exists in Redis
    let hasRedisData = false;
    let sourceCount = 0;
    if (redisStorage.isConnected && redisStorage.client) {
      try {
        // Get source names that have recent data (this checks timestamps, not just key existence)
        const sourceNames = await getSourceNames();
        sourceCount = sourceNames.length;
        hasRedisData = sourceCount > 0;
        
        if (hasRedisData) {
          debug(`[StreamController] Streaming status: Found ${sourceCount} sources with data in Redis:`, sourceNames);
        }
      } catch (err) {
        debug(`[StreamController] Error checking Redis for streaming status: ${err.message}`);
        // If Redis check fails, assume no data
        hasRedisData = false;
        sourceCount = 0;
      }
    }
    
    // CRITICAL: Only return hasStreaming=true if:
    // 1. streamingStarted flag is true AND
    // 2. There are active polling timers running
    // This prevents showing LIVE dataset when streaming is disabled (even if old data exists in Redis)
    // If no timers are running, we're NOT streaming - period.
    const hasStreaming = streamingStarted && activePollingTimers > 0;
    
    return sendResponse(res, info, 200, true, "Streaming status retrieved", {
      hasStreaming: hasStreaming,
      sourceCount: hasStreaming ? sourceCount : 0,
      activeConnections: 0,
      activeSourceInstances: 0,
      activePollingTimers: activePollingTimers,
      streamingStarted: streamingStarted
    });
  } catch (err) {
    error('[StreamController] Error getting streaming status:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get Redis database status with hours of data per source
 * Shows which sources are active (data inserts and websocket connections)
 */
exports.getRedisStatus = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getRedisStatus' };

  // Add timeout protection to prevent hangs
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      error('[StreamController] getRedisStatus timeout after 10 seconds');
      return sendResponse(res, info, 500, false, "Request timeout - Redis status check took too long", {
        connected: false,
        sources: [],
        error: 'Timeout'
      });
    }
  }, 10000); // 10 second timeout

  try {
    if (!redisStorage.isConnected || !redisStorage.client) {
      clearTimeout(timeout);
      return sendResponse(res, info, 200, true, "Redis status retrieved", {
        connected: false,
        sources: []
      });
    }

    // Get all source names from Redis (with error handling)
    let sourceNames = [];
    try {
      sourceNames = await getSourceNames();
    } catch (err) {
      clearTimeout(timeout);
      error('[StreamController] Error getting source names for Redis status:', err.message);
      // Return empty sources list instead of crashing
      return sendResponse(res, info, 200, true, "Redis status retrieved (error getting sources)", {
        connected: true,
        sources: [],
        error: 'Failed to get source names from Redis'
      });
    }
    
    const sources = [];

    // Get websocket server instance from app locals (with defensive checks)
    let clientWSS = null;
    let wsSubscriptions = new Map();
    try {
      if (req && req.app && req.app.locals && req.app.locals.clientWSS) {
        clientWSS = req.app.locals.clientWSS;
        if (clientWSS && clientWSS.subscriptions) {
          wsSubscriptions = clientWSS.subscriptions;
        }
      }
    } catch (wsErr) {
      warn('[StreamController] Error accessing websocket server instance:', wsErr.message);
      // Continue with empty Map
      wsSubscriptions = new Map();
    }

    // Get active source instances (for data insert tracking)
    let activeSourceIds = [];
    const activeSourceNames = new Set();
    
    try {
      if (sourceInstances && typeof sourceInstances.keys === 'function') {
        activeSourceIds = Array.from(sourceInstances.keys());
      }
      
      // Map source_ids to source_names by checking connections
      if (connectionManager && typeof connectionManager.getConnection === 'function') {
        for (const sourceId of activeSourceIds) {
          try {
            const connection = connectionManager.getConnection(sourceId);
            if (connection && connection.source_name) {
              activeSourceNames.add(connection.source_name.toUpperCase().trim());
            }
          } catch (connErr) {
            warn(`[StreamController] Error getting connection for source_id ${sourceId}:`, connErr.message);
            // Continue with next connection
          }
        }
      }
    } catch (sourceErr) {
      error('[StreamController] Error processing source instances:', sourceErr.message);
      // Continue with empty activeSourceNames
    }

    // Check last data received times
    const now = Date.now();
    const RECENT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    // Limit processing to prevent hangs and memory issues - process max 30 sources
    // Reduced from 50 to 30 to prevent memory exhaustion
    const maxSources = 30;
    const sourcesToProcess = sourceNames.slice(0, maxSources);
    if (sourceNames.length > maxSources) {
      warn(`[StreamController] Limiting Redis status to ${maxSources} sources (${sourceNames.length} total) to prevent memory issues`);
    }

    for (const sourceName of sourcesToProcess) {
      const normalizedSourceName = sourceName.toUpperCase().trim();
      
      // Get earliest and latest timestamps (with error handling to prevent crashes)
      // Always query Redis directly to ensure we get the absolute latest timestamp
      // (Background monitoring is for other purposes, but admin page needs real-time data)
      let latestTimestamp = null;
      try {
        latestTimestamp = await redisStorage.getLatestTimestamp(normalizedSourceName);
      } catch (err) {
        error(`[StreamController] Error getting latest timestamp for ${normalizedSourceName}:`, err.message);
        continue; // Skip this source if we can't get its timestamp
      }
      
      if (!latestTimestamp) {
        continue;
      }

      // Get earliest timestamp using the helper method (consistent with getLatestTimestamp)
      let earliestTimestamp = null;
      try {
        earliestTimestamp = await redisStorage.getEarliestTimestamp(normalizedSourceName);
      } catch (err) {
        warn(`[StreamController] Error getting earliest timestamp for ${normalizedSourceName}:`, err.message);
        // Continue with null earliestTimestamp - we'll handle it below
      }
      
      // Verify we have data and check if there's actually more than one data point
      const key = redisStorage.getKey(normalizedSourceName);
      let dataPointCount = 0;
      try {
        dataPointCount = await redisStorage.client.zcard(key);
      } catch (err) {
        debug(`[StreamController] Could not get data point count for ${normalizedSourceName}:`, err.message);
      }
      
      // If earliestTimestamp is null but we have data, try direct query as fallback
      if (!earliestTimestamp && latestTimestamp && dataPointCount > 0) {
        try {
          const directResults = await redisStorage.client.zrange(key, 0, 0, 'WITHSCORES');
          if (directResults.length >= 2) {
            earliestTimestamp = parseFloat(directResults[1]);
            warn(`[StreamController] Recovered earliest timestamp for ${normalizedSourceName} via direct query (getEarliestTimestamp returned null but ${dataPointCount} points exist)`);
          }
        } catch (directErr) {
          error(`[StreamController] Failed to recover earliest timestamp for ${normalizedSourceName}:`, directErr.message);
        }
      }
      
      // Determine final earliest timestamp
      let finalEarliestTimestamp = earliestTimestamp;
      
      // If we still don't have earliest but have latest, use latest as fallback
      // This is correct if there's only one data point
      if (!finalEarliestTimestamp && latestTimestamp) {
        if (dataPointCount === 1) {
          // Only one data point - they should be the same
          finalEarliestTimestamp = latestTimestamp;
        } else if (dataPointCount > 1) {
          // Multiple data points but we couldn't get earliest - this is an error
          error(`[StreamController] ERROR: ${dataPointCount} data points exist for ${normalizedSourceName} but could not retrieve earliest timestamp!`);
          // Use latest as last resort, but this is wrong
          finalEarliestTimestamp = latestTimestamp;
        } else {
          // No data points but we have latest? This shouldn't happen
          warn(`[StreamController] WARNING: No data points found but latestTimestamp exists for ${normalizedSourceName}`);
          finalEarliestTimestamp = latestTimestamp;
        }
      }
      
      // Debug: Log if timestamps are the same when we have multiple data points (data quality issue)
      if (finalEarliestTimestamp && latestTimestamp && dataPointCount > 1 && finalEarliestTimestamp === latestTimestamp) {
        warn(`[StreamController] WARNING: ${normalizedSourceName} has ${dataPointCount} data points but earliest and latest timestamps are identical (${finalEarliestTimestamp}) - possible data quality issue`);
      }

      // Calculate hours of data (with validation to prevent NaN)
      let hoursOfData = 0;
      if (latestTimestamp && finalEarliestTimestamp && 
          typeof latestTimestamp === 'number' && typeof finalEarliestTimestamp === 'number') {
        hoursOfData = (latestTimestamp - finalEarliestTimestamp) / (1000 * 60 * 60);
        // Ensure we have a valid number
        if (isNaN(hoursOfData) || !isFinite(hoursOfData)) {
          hoursOfData = 0;
        }
      }

      // Check if source is active for data inserts
      // Method 1: Check if latest timestamp is recent (within threshold)
      const timeSinceLatestData = latestTimestamp ? (now - latestTimestamp) : Infinity;
      const hasRecentDataInRedis = timeSinceLatestData < RECENT_THRESHOLD_MS;
      
      debug(`[StreamController] Checking activity for ${normalizedSourceName}:`, {
        latestTimestamp: latestTimestamp ? new Date(latestTimestamp).toISOString() : null,
        timeSinceLatestDataMs: timeSinceLatestData,
        timeSinceLatestDataMinutes: isFinite(timeSinceLatestData) ? (timeSinceLatestData / 60000).toFixed(2) : 'N/A',
        hasRecentDataInRedis,
        thresholdMinutes: RECENT_THRESHOLD_MS / 60000
      });

      // Method 2: Check if any connection with this source_name has recent data
      let hasActiveConnection = false;
      try {
        const connections = connectionManager.getAllConnections();
        for (const conn of connections) {
          // Try to match by source_name if available
          // lastDataReceived is now keyed by source_name, so check directly
          if (conn && conn.source_name && conn.source_name.toUpperCase().trim() === normalizedSourceName) {
            const lastDataTime = lastDataReceived.get(normalizedSourceName);
            if (lastDataTime && (now - lastDataTime) < RECENT_THRESHOLD_MS) {
              hasActiveConnection = true;
              break;
            }
          }
        }
      } catch (connErr) {
        error(`[StreamController] Error checking connections for ${normalizedSourceName}:`, connErr.message);
        // Continue without connection check
      }

      // Method 3: Check lastDataReceived directly by source_name (no mapping needed)
      // lastDataReceived is now keyed by source_name, so we can check directly
      let hasActiveSourceInstance = false;
      try {
        const lastDataTime = lastDataReceived.get(normalizedSourceName);
        if (lastDataTime && (now - lastDataTime) < RECENT_THRESHOLD_MS) {
          hasActiveSourceInstance = true;
        }
      } catch (dataErr) {
        error(`[StreamController] Error checking lastDataReceived for ${normalizedSourceName}:`, dataErr.message);
        // Continue without lastDataReceived check
      }

      // Source is active if any method indicates activity
      const hasActiveDataInserts = hasRecentDataInRedis || hasActiveConnection || hasActiveSourceInstance;

      // Check if source has websocket connections
      let wsSubs = null;
      let hasWebSocketConnections = false;
      let websocketClientCount = 0;
      try {
        wsSubs = wsSubscriptions.get(normalizedSourceName);
        hasWebSocketConnections = wsSubs && wsSubs.size > 0;
        websocketClientCount = wsSubs ? wsSubs.size : 0;
      } catch (wsErr) {
        error(`[StreamController] Error checking websocket subscriptions for ${normalizedSourceName}:`, wsErr.message);
        // Continue without websocket check
      }

      // Ensure hours_of_data is a valid number (not NaN or Infinity)
      let hoursOfDataValue = 0;
      if (typeof hoursOfData === 'number' && isFinite(hoursOfData) && !isNaN(hoursOfData)) {
        hoursOfDataValue = parseFloat(hoursOfData.toFixed(2));
        // Double-check after parseFloat
        if (isNaN(hoursOfDataValue) || !isFinite(hoursOfDataValue)) {
          hoursOfDataValue = 0;
        }
      }

      sources.push({
        source_name: normalizedSourceName,
        hours_of_data: hoursOfDataValue,
        has_active_data_inserts: hasActiveDataInserts,
        has_websocket_connections: hasWebSocketConnections,
        latest_timestamp: latestTimestamp,
        earliest_timestamp: finalEarliestTimestamp,
        websocket_client_count: websocketClientCount
      });
    }

    clearTimeout(timeout);
    return sendResponse(res, info, 200, true, "Redis status retrieved", {
      connected: true,
      sources: sources.sort((a, b) => a.source_name.localeCompare(b.source_name))
    });
  } catch (err) {
    clearTimeout(timeout);
    error('[StreamController] Error getting Redis status:', err.message);
    error('[StreamController] Error stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Flush Redis database (clear all data)
 */
exports.flushRedis = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'flushRedis' };

  try {
    if (!redisStorage.isConnected || !redisStorage.client) {
      return sendResponse(res, info, 400, false, "Redis not connected", null);
    }

    const flushed = await redisStorage.flushDatabase();
    if (flushed) {
      log('[StreamController] Redis database flushed via admin endpoint');
      // CRITICAL: Clear lastInsertedTimestamp when Redis is flushed
      // This ensures new data can be inserted after a flush
      lastInsertedTimestamp.clear();
      log('[StreamController] Cleared lastInsertedTimestamp tracking after Redis flush');
      return sendResponse(res, info, 200, true, "Redis database flushed successfully", null);
    } else {
      return sendResponse(res, info, 500, false, "Failed to flush Redis database", null);
    }
  } catch (err) {
    error('[StreamController] Error flushing Redis:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get detailed streaming status with monitoring information
 */
exports.getStreamingMonitoringStatus = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'getStreamingMonitoringStatus' };

  // Add timeout protection to prevent hangs
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      error('[StreamController] getStreamingMonitoringStatus timeout after 10 seconds');
      return sendResponse(res, info, 500, false, "Request timeout - Monitoring status check took too long", {
        streamingStarted: streamingStarted,
        influxdb: { enabled: influxDBStreamingEnabled, streaming: false },
        error: 'Timeout'
      });
    }
  }, 10000); // 10 second timeout

  try {
    // Get WebSocket server instance
    const clientWSS = req.app?.locals?.clientWSS;
    const wsClientCount = clientWSS ? clientWSS.getClientCount() : 0;
    const broadcastIntervalMs = clientWSS ? (clientWSS.broadcastIntervalMs || 1000) : 1000; // Default to 1000ms if not available
    
    // Update WebSocket active connections count
    if (clientWSS) {
      websocketStats.activeConnections = wsClientCount;
    }

    // OPTIMIZED: Calculate InfluxDB status only when requested (not continuously)
    // Check if we've received data recently OR if queries are actively running
    const now = Date.now();
    const RECENT_DATA_THRESHOLD_MS = 10 * 1000; // 10 seconds for recent data
    const RECENT_QUERY_THRESHOLD_MS = 5 * 1000; // 5 seconds for recent queries (queries happen every 1s)
    
    let hasRecentInfluxData = false;
    let activeInfluxSourceInstances = 0;
    let hasRecentQueries = false;
    
    // Check for recent data
    for (const [sourceId, lastDataTime] of lastDataReceived.entries()) {
      if (lastDataTime && (now - lastDataTime) < RECENT_DATA_THRESHOLD_MS) {
        const conn = connectionManager.getConnection(sourceId);
        if (conn && conn.type === 'influxdb') {
          hasRecentInfluxData = true;
          activeInfluxSourceInstances++;
        }
      }
    }
    
    // Check for recent successful queries (indicates active streaming even if no data returned)
    // Also check if we have active source instances (they're polling even if no data yet)
    const connections = connectionManager.getAllConnections();
    const influxConnections = connections.filter(c => c.type === 'influxdb' && c.state === 'connected');
    
    if (influxDBQueryStats.lastSuccessfulQueryTime && 
        (now - influxDBQueryStats.lastSuccessfulQueryTime) < RECENT_QUERY_THRESHOLD_MS) {
      hasRecentQueries = true;
      // Count active source instances based on connections if we have recent queries
      activeInfluxSourceInstances = Math.max(activeInfluxSourceInstances, influxConnections.length);
    }
    
    // Also check if we have connected InfluxDB sources (they're actively polling)
    // This is important because queries might succeed but return no data, or queries might be slow
    if (influxConnections.length > 0) {
      // If we have connected InfluxDB sources, consider streaming as potentially active
      // even if we haven't received data recently (they might be querying)
      activeInfluxSourceInstances = Math.max(activeInfluxSourceInstances, influxConnections.length);
      // If queries are running (even if no data yet), consider it active
      if (influxDBQueryStats.totalQueries > 0 && influxDBQueryStats.lastQueryTime &&
          (now - influxDBQueryStats.lastQueryTime) < RECENT_QUERY_THRESHOLD_MS * 2) {
        hasRecentQueries = true;
      }
    }
    
    // Streaming is active if we have recent data OR recent successful queries OR active connections
    const isStreamingFromInflux = hasRecentInfluxData || hasRecentQueries || (influxConnections.length > 0 && influxDBStreamingEnabled);

    // OPTIMIZED: Calculate stats only when requested (not continuously)
    // Calculate processing health (success rate)
    const totalProcessingAttempts = processingStats.successCount + processingStats.errorCount;
    const processingSuccessRate = totalProcessingAttempts > 0 
      ? (processingStats.successCount / totalProcessingAttempts * 100).toFixed(2)
      : 100;
    const dataProcessingActive = totalProcessingAttempts > 0;
    // Processing is healthy only if NEW data is being processed (not just successful processing of duplicates)
    const timeSinceNewDataProcessed = processingStats.lastNewDataProcessedTime
      ? now - processingStats.lastNewDataProcessedTime
      : null;
    const dataProcessingHealthy = !dataProcessingActive ? null : 
      (processingStats.errorCount === 0 && timeSinceNewDataProcessed !== null && timeSinceNewDataProcessed < 10000); // Healthy if processing new data within 10 seconds

    // Calculate Redis health (success rate)
    const redisSuccessRate = redisStats.attemptCount > 0
      ? (redisStats.successCount / redisStats.attemptCount * 100).toFixed(2)
      : 100;
    const redisActive = redisStats.attemptCount > 0;
    // Redis is healthy only if NEW data is being inserted (not just successful writes of old data)
    const timeSinceNewDataInserted = redisStats.lastNewDataInsertedTime
      ? now - redisStats.lastNewDataInsertedTime
      : null;
    const redisHealthy = !redisActive ? null : 
      (redisStats.errorCount === 0 && timeSinceNewDataInserted !== null && timeSinceNewDataInserted < 10000); // Healthy if inserting new data within 10 seconds

    // Calculate InfluxDB query statistics
    const influxQuerySuccessRate = influxDBQueryStats.totalQueries > 0
      ? (influxDBQueryStats.successfulQueries / influxDBQueryStats.totalQueries * 100).toFixed(2)
      : 100;
    // Query is healthy only if it's returning NEW data (not just successful HTTP responses)
    const timeSinceNewData = influxDBQueryStats.lastQueryWithNewDataTime
      ? now - influxDBQueryStats.lastQueryWithNewDataTime
      : null;
    const influxQueryHealthy = influxDBQueryStats.totalQueries === 0 ? null : 
      (influxDBQueryStats.failedQueries === 0 && timeSinceNewData !== null && timeSinceNewData < 10000); // Healthy if getting new data within 10 seconds
    
    // Calculate real-time sync metrics
    // CRITICAL: Use actual Redis data age, not just when we received data
    // Query Redis for the actual latest timestamp across all sources (with timeout protection)
    let actualLatestTimestamp = null;
    try {
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('getLatestTimestampAcrossAllSources timeout')), 5000)
      );
      actualLatestTimestamp = await Promise.race([
        redisStorage.getLatestTimestampAcrossAllSources(),
        timeoutPromise
      ]);
    } catch (err) {
      debug('[StreamController] Error getting latest timestamp from Redis for sync status:', err.message);
      // Continue without actualLatestTimestamp - use fallback values
    }
    
    // Calculate time since last actual data in Redis (most accurate)
    const timeSinceLastData = actualLatestTimestamp ? now - actualLatestTimestamp : null;
    
    // Also track when we last received data (for comparison)
    const timeSinceLastReceived = lastDataReceived.size > 0
      ? Math.min(...Array.from(lastDataReceived.values()).map(t => now - t))
      : null;
    
    const timeSinceLastQuery = influxDBQueryStats.lastQueryTime
      ? now - influxDBQueryStats.lastQueryTime
      : null;
    const timeSinceLastSuccess = influxDBQueryStats.lastSuccessfulQueryTime
      ? now - influxDBQueryStats.lastSuccessfulQueryTime
      : null;
    
    // Calculate average trip time for real-time sync (only if we have data)
    const avgTripTime = processingPerformance.tripTimes.length > 0
      ? (processingPerformance.tripTimes.reduce((a, b) => a + b, 0) / processingPerformance.tripTimes.length)
      : null;

    clearTimeout(timeout);
    return sendResponse(res, info, 200, true, "Streaming monitoring status retrieved", {
      streamingStarted: streamingStarted,
      influxdb: {
        enabled: influxDBStreamingEnabled,
        streaming: isStreamingFromInflux,
        active_connections: activeInfluxSourceInstances,
        // Query statistics
        query_stats: {
          total_queries: influxDBQueryStats.totalQueries,
          successful_queries: influxDBQueryStats.successfulQueries,
          failed_queries: influxDBQueryStats.failedQueries,
          queries_with_new_data: influxDBQueryStats.queriesWithNewData,
          success_rate: `${influxQuerySuccessRate}%`,
          healthy: influxQueryHealthy,
          last_query_error: influxDBQueryStats.lastQueryError,
          time_since_new_data_seconds: timeSinceNewData ? (timeSinceNewData / 1000).toFixed(2) : null
        }
      },
      realtime_sync: {
        time_since_last_data_seconds: timeSinceLastData ? (timeSinceLastData / 1000).toFixed(2) : null,
        time_since_last_query_seconds: timeSinceLastQuery ? (timeSinceLastQuery / 1000).toFixed(2) : null,
        avg_trip_time_ms: avgTripTime ? avgTripTime.toFixed(2) : null,
        in_sync: timeSinceLastData !== null && timeSinceLastData < 10000,
        sync_status: timeSinceLastData === null && timeSinceLastQuery === null ? 'no_data' :
                     (timeSinceLastData !== null && timeSinceLastData < 10000) ? 'in_sync' :
                     (timeSinceLastData !== null && timeSinceLastData < 30000) ? 'slightly_delayed' : 'delayed'
      },
      data_processing: {
        active: dataProcessingActive,
        healthy: dataProcessingHealthy,
        success_count: processingStats.successCount,
        error_count: processingStats.errorCount,
        processed_new_data_count: processingStats.processedNewDataCount,
        skipped_duplicate_count: processingStats.skippedDuplicateCount,
        success_rate: `${processingSuccessRate}%`,
        last_error: processingStats.lastError,
        time_since_new_data_seconds: timeSinceNewDataProcessed ? (timeSinceNewDataProcessed / 1000).toFixed(2) : null,
        avg_trip_time_ms: processingPerformance.tripTimes.length > 0 
          ? (processingPerformance.tripTimes.reduce((a, b) => a + b, 0) / processingPerformance.tripTimes.length).toFixed(2)
          : null
      },
      redis: {
        active: redisActive,
        healthy: redisHealthy,
        success_count: redisStats.successCount,
        error_count: redisStats.errorCount,
        inserted_new_data_count: redisStats.insertedNewDataCount,
        success_rate: `${redisSuccessRate}%`,
        last_error: redisStats.lastError,
        time_since_new_data_seconds: timeSinceNewDataInserted ? (timeSinceNewDataInserted / 1000).toFixed(2) : null
      },
      websocket: {
        active_connections: websocketStats.activeConnections,
        error_count: websocketStats.errorCount,
        broadcast_interval_ms: broadcastIntervalMs
      }
    });
  } catch (err) {
    clearTimeout(timeout);
    error('[StreamController] Error getting streaming monitoring status:', err.message);
    error('[StreamController] Error stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Enable or disable InfluxDB streaming
 */
exports.setInfluxDBStreaming = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'setInfluxDBStreaming' };

  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return sendResponse(res, info, 400, false, "enabled must be a boolean", null);
    }

    influxDBStreamingEnabled = enabled;
    
    // Update global flag so InfluxDB sources can check it
    if (typeof global !== 'undefined') {
      global.influxDBStreamingEnabled = influxDBStreamingEnabled;
    }
    
    // If disabling, disconnect all InfluxDB sources and stop streaming
    if (!enabled) {
      const connections = connectionManager.getAllConnections();
      let timersStopped = 0;
      
      for (const conn of connections) {
        if (conn.type === 'influxdb') {
          const sourceInstance = sourceInstances.get(conn.source_id);
          if (sourceInstance) {
            // CRITICAL: Stop the polling timer first - this is what actually stops streaming
            sourceInstance.disconnect(); // This stops the pollInterval timer
            timersStopped++;
            sourceInstances.delete(conn.source_id);
            
            // Clean up lastDataReceived by source_name if connection has source_name
            if (conn.source_name) {
              const normalizedSourceName = String(conn.source_name).toUpperCase().trim();
              lastDataReceived.delete(normalizedSourceName);
            }
          }
          connectionManager.removeConnection(conn.source_id);
        }
      }
      
      // CRITICAL: Stop streaming flag - no timers running means not streaming
      streamingStarted = false;
      stopProactiveDiscovery();
      
      // Disconnect all WebSocket clients when streaming is disabled
      const clientWSS = req.app?.locals?.clientWSS;
      if (clientWSS) {
        clientWSS.disconnectAllClients('InfluxDB streaming disabled');
      }
      
      log(`[StreamController] InfluxDB streaming disabled, ${timersStopped} polling timers stopped, all InfluxDB connections and WebSocket clients disconnected`);
    } else {
      // If enabling, just reset auto-discovery flag (but don't start streaming automatically)
      autoDiscoveryAttempted = false;
      log('[StreamController] InfluxDB streaming enabled, but streaming not started (use /api/stream/start to begin)');
    }

    return sendResponse(res, info, 200, true, `InfluxDB streaming ${enabled ? 'enabled' : 'disabled'}`, {
      enabled: influxDBStreamingEnabled,
      streamingStarted: streamingStarted
    });
  } catch (err) {
    error('[StreamController] Error setting InfluxDB streaming:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Start streaming (explicitly commanded from admin page)
 */
exports.startStreaming = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'startStreaming' };

  try {
    if (!influxDBStreamingEnabled) {
      return sendResponse(res, info, 400, false, "InfluxDB streaming must be enabled before starting streaming", null);
    }

    if (streamingStarted) {
      return sendResponse(res, info, 200, true, "Streaming already started", {
        streamingStarted: true
      });
    }

    streamingStarted = true;
    autoDiscoveryAttempted = false; // Reset to allow discovery
    
    // Connect to Redis when streaming starts (if not already connected)
    if (!redisStorage.isConnected) {
      log('[StreamController] Connecting to Redis for streaming...');
      try {
        await redisStorage.connect();
        log('[StreamController] Redis connected successfully');
      } catch (err) {
        error('[StreamController] Failed to connect to Redis:', err.message);
        // Continue anyway - Redis will retry automatically
      }
    }
    
    // Start proactive discovery
    startProactiveDiscovery();
    
    log('[StreamController] Streaming explicitly started from admin page');
    
    // Return response immediately - let discovery happen in background
    // This prevents 502 errors if discovery takes too long
    sendResponse(res, info, 200, true, "Streaming started", {
      streamingStarted: true
    });
    
    // Attempt to discover and connect in background (non-blocking)
    // Use setImmediate to ensure response is sent first
    setImmediate(async () => {
      try {
        await autoConnectInfluxDBSources();
        await updateStreamingState();
      } catch (err) {
        error('[StreamController] Error in background discovery after starting streaming:', err.message);
        error('[StreamController] Error stack:', err.stack);
      }
    });
  } catch (err) {
    error('[StreamController] Error starting streaming:', err.message);
    error('[StreamController] Error stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Stop streaming (explicitly commanded from admin page)
 */
exports.stopStreaming = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/stream', "function": 'stopStreaming' };

  try {
    if (!streamingStarted) {
      return sendResponse(res, info, 200, true, "Streaming already stopped", {
        streamingStarted: false
      });
    }

    // CRITICAL: Stop all polling timers first - this is what actually stops streaming
    let timersStopped = 0;
    const connections = connectionManager.getAllConnections();
    for (const conn of connections) {
      if (conn.type === 'influxdb') {
        const sourceInstance = sourceInstances.get(conn.source_id);
        if (sourceInstance) {
          // Stop the polling timer - this is what actually stops streaming
          sourceInstance.disconnect(); // This stops the pollInterval timer
          timersStopped++;
          sourceInstances.delete(conn.source_id);
          lastDataReceived.delete(conn.source_id);
        }
        connectionManager.removeConnection(conn.source_id);
      }
    }
    
    // CRITICAL: Set streamingStarted to false - no timers running means not streaming
    streamingStarted = false;
    
    // Stop proactive discovery
    stopProactiveDiscovery();
    
    log(`[StreamController] Streaming stopped, ${timersStopped} polling timers stopped`);
    
    // Disconnect all WebSocket clients when streaming is stopped
    const clientWSS = req.app?.locals?.clientWSS;
    if (clientWSS) {
      clientWSS.disconnectAllClients('Streaming stopped');
    }
    
    await updateStreamingState();
    
    log('[StreamController] Streaming explicitly stopped from admin page, all WebSocket clients disconnected');
    
    return sendResponse(res, info, 200, true, "Streaming stopped", {
      streamingStarted: false
    });
  } catch (err) {
    error('[StreamController] Error stopping streaming:', err.message);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};


