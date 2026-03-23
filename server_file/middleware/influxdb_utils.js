const { InfluxDB } = require('@influxdata/influxdb-client');
const { log, error, warn, debug, isVerboseEnabled } = require('../../shared');
const env = require('./config');
const { normalizeChannelType, parseResolution, initializeDuckDB, convertPathForContainer } = require('./duckdb_utils');
const db = require('../../shared/database/connection');

// Global InfluxDB client instance
let influxClient = null;
let queryApi = null;
let clientTimeoutMs = null;

/**
 * Initialize InfluxDB client using environment variables
 * @returns {Object} InfluxDB client and query API
 */
function getInfluxDBClient() {
  if (influxClient && queryApi && clientTimeoutMs !== null) {
    return { client: influxClient, queryApi, timeoutMs: clientTimeoutMs };
  }

  // Get InfluxDB configuration from environment variables
  const influxToken = env.INFLUX_TOKEN;
  const influxHost = env.INFLUX_HOST;
  const influxDatabase = env.INFLUX_DATABASE; // This is the org name
  const influxBucket = env.INFLUX_BUCKET;

  // Diagnostic logging (without exposing token value)
  debug(`[influxdb_utils] Environment check: INFLUX_HOST=${influxHost ? 'SET' : 'NOT SET'}, INFLUX_TOKEN=${influxToken ? 'SET' : 'NOT SET'}, INFLUX_DATABASE=${influxDatabase ? 'SET' : 'NOT SET'}, INFLUX_BUCKET=${influxBucket ? 'SET' : 'NOT SET'}`);
  if (!influxToken || !influxHost || !influxDatabase || !influxBucket) {
    warn(`[influxdb_utils] Missing InfluxDB config: Check .env.production.local file and ensure docker-compose env_file is loading it correctly`);
    warn(`[influxdb_utils] NODE_ENV=${process.env.NODE_ENV}, process.env.INFLUX_TOKEN=${process.env.INFLUX_TOKEN ? 'SET' : 'NOT SET'}`);
  }

  // Validate required environment variables
  if (!influxToken) {
    throw new Error('INFLUX_TOKEN environment variable is not set');
  }
  if (!influxHost) {
    throw new Error('INFLUX_HOST environment variable is not set');
  }
  if (!influxDatabase) {
    throw new Error('INFLUX_DATABASE environment variable is not set');
  }
  if (!influxBucket) {
    throw new Error('INFLUX_BUCKET environment variable is not set');
  }

  // Ensure influx_host has protocol
  let influxUrl = influxHost;
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }

  // Get timeout from environment variable (default: 120 seconds, same as Python)
  clientTimeoutMs = parseInt(env.INFLUX_TIMEOUT_MS || '120000', 10);

  log(`[influxdb_utils] Initializing InfluxDB client: host=${influxUrl}, org=${influxDatabase}, bucket=${influxBucket}, timeout=${clientTimeoutMs}ms`);

  try {
    influxClient = new InfluxDB({
      url: influxUrl,
      token: influxToken,
      timeout: clientTimeoutMs
    });
    queryApi = influxClient.getQueryApi(influxDatabase);
    
    return { client: influxClient, queryApi, timeoutMs: clientTimeoutMs };
  } catch (err) {
    error('[influxdb_utils] Failed to initialize InfluxDB client:', err);
    throw err;
  }
}

/**
 * Check InfluxDB health using HTTP /health endpoint first (fastest), falls back to minimal query if needed
 * @param {string} baseUrl - InfluxDB base URL
 * @returns {Promise<boolean>} True if healthy, throws error if not
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
 * @param {string} baseUrl - InfluxDB base URL
 * @returns {Promise<boolean>} True if healthy, throws error if not
 */
async function checkInfluxDBHealthWithQuery(baseUrl) {
  // Get InfluxDB configuration from environment variables
  const influxToken = env.INFLUX_TOKEN;
  const influxDatabase = env.INFLUX_DATABASE; // This is the org name
  const influxBucket = env.INFLUX_BUCKET;

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
 * Execute a Flux query and return results as an array of objects
 * @param {string} fluxQuery - Flux query string
 * @returns {Promise<Array>} Array of result objects
 */
async function queryInfluxDB(fluxQuery) {
  const { queryApi, timeoutMs } = getInfluxDBClient();
  
  return new Promise((resolve, reject) => {
    let results = [];
    const tableMap = new Map();
    let isComplete = false;
    let isError = false;
    let rowCount = 0; // Counter for debugging
    
    // Set up timeout
    const timeout = setTimeout(() => {
      if (!isComplete && !isError) {
        isError = true;
        error(`[influxdb_utils] InfluxDB query timeout after ${timeoutMs}ms`);
        reject(new Error(`InfluxDB query timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    
    queryApi.queryRows(fluxQuery, {
      next(row, tableMeta) {
        try {
          rowCount++;
          // Debug: Log raw row and converted record only when verbose is enabled (avoids hot-path cost in production)
          if (isVerboseEnabled() && rowCount <= 3) {
            debug(`[influxdb_utils] Raw row type: ${typeof row}, isArray: ${Array.isArray(row)}, constructor: ${row?.constructor?.name}`);
            if (row && typeof row === 'object') {
              debug(`[influxdb_utils] Raw row keys: ${Object.keys(row).join(', ')}`);
              Object.keys(row).forEach(key => {
                const value = row[key];
                if (Buffer.isBuffer(value)) {
                  debug(`[influxdb_utils] Row[${key}] is a Buffer, length: ${value.length}, first 20 bytes: ${value.slice(0, 20).toString('hex')}`);
                } else if (value instanceof Uint8Array) {
                  debug(`[influxdb_utils] Row[${key}] is a Uint8Array, length: ${value.length}`);
                } else {
                  debug(`[influxdb_utils] Row[${key}] type: ${typeof value}, value: ${JSON.stringify(value).substring(0, 100)}`);
                }
              });
            }
          }

          // Convert row to object using tableMeta.toObject
          const record = tableMeta.toObject(row);

          if (isVerboseEnabled() && rowCount <= 3) {
            debug(`[influxdb_utils] Converted record keys: ${Object.keys(record).join(', ')}`);
            Object.keys(record).forEach(key => {
              const value = record[key];
              const valueType = typeof value;
              let valueInfo = `${valueType}`;
              if (Buffer.isBuffer(value)) {
                valueInfo = `Buffer(length=${value.length})`;
                debug(`[influxdb_utils] Record[${key}] is a Buffer, length: ${value.length}, first 20 bytes: ${value.slice(0, 20).toString('hex')}`);
              } else if (value instanceof Uint8Array) {
                valueInfo = `Uint8Array(length=${value.length})`;
                debug(`[influxdb_utils] Record[${key}] is a Uint8Array, length: ${value.length}`);
              } else if (value !== null && value !== undefined) {
                const strValue = String(value);
                valueInfo = `${valueType}(${strValue.length > 50 ? strValue.substring(0, 50) + '...' : strValue})`;
              } else {
                valueInfo = `${valueType}(${value})`;
              }
              debug(`[influxdb_utils] Record[${key}]: ${valueInfo}`);
            });
          }

          // Group by table (each table represents a different series)
          // For pivot queries, all rows should be in the same table
          const tableId = tableMeta.id || 0;
          if (!tableMap.has(tableId)) {
            tableMap.set(tableId, []);
          }
          tableMap.get(tableId).push(record);
        } catch (err) {
          error('[influxdb_utils] Error converting row to object:', err);
          error('[influxdb_utils] Error details:', {
            message: err.message,
            stack: err.stack,
            rowType: typeof row,
            rowKeys: row && typeof row === 'object' ? Object.keys(row) : 'N/A'
          });
          // Continue processing other rows
        }
      },
      error(err) {
        if (!isError) {
          isError = true;
          clearTimeout(timeout);
          error('[influxdb_utils] InfluxDB query error:', err);
          reject(err);
        }
      },
      complete() {
        if (!isComplete && !isError) {
          isComplete = true;
          clearTimeout(timeout);
          
          // Merge all tables into a single array
          for (const tableRecords of tableMap.values()) {
            results = results.concat(tableRecords);
          }
          
          log(`[influxdb_utils] Query completed. Total rows: ${results.length}, Tables: ${tableMap.size}`);
          if (isVerboseEnabled() && results.length > 0) {
            const firstRecord = results[0];
            debug(`[influxdb_utils] First record keys: ${Object.keys(firstRecord).join(', ')}`);
            debug(`[influxdb_utils] First record sample: ${JSON.stringify(firstRecord, (key, value) => {
              if (Buffer.isBuffer(value)) {
                return `Buffer(${value.length} bytes)`;
              }
              if (value instanceof Uint8Array) {
                return `Uint8Array(${value.length} bytes)`;
              }
              return value;
            }, 2).substring(0, 500)}`);
            let binaryCount = 0;
            results.forEach((record, idx) => {
              Object.keys(record).forEach(key => {
                const value = record[key];
                if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
                  binaryCount++;
                  if (binaryCount <= 3) {
                    warn(`[influxdb_utils] Found binary data in result[${idx}][${key}]: ${Buffer.isBuffer(value) ? 'Buffer' : 'Uint8Array'}, length: ${value.length}`);
                  }
                }
              });
            });
            if (binaryCount > 0) {
              warn(`[influxdb_utils] WARNING: Found ${binaryCount} binary/buffer values in query results. These may need conversion.`);
            }
          }

          resolve(results);
        }
      }
    });
  });
}

/**
 * Get list of unique boats (sources) from InfluxDB for a given date
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} level - Data level filter ('strm' or 'log'). Defaults to 'strm'
 * @returns {Promise<Array<string>>} Array of boat names
 */
async function getSourcesFromInfluxDB(date, level = 'strm') {
  const influxBucket = env.INFLUX_BUCKET;
  
  // Convert date from YYYYMMDD to YYYY-MM-DD format
  const dateStr = String(date);
  if (dateStr.length !== 8 || !/^\d+$/.test(dateStr)) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYYMMDD format.`);
  }
  const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  
  const startTime = `${formattedDate}T00:00:00Z`;
  const stopTime = `${formattedDate}T23:59:59Z`;
  
  // Tag filters first (boat, level) after range so InfluxDB can use tag indexes
  const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: time(v: "${startTime}"), stop: time(v: "${stopTime}"))
  |> filter(fn: (r) => r.level == "${level}")
  |> filter(fn: (r) => r._field == "value")
  |> limit(n: 1)
  |> distinct(column: "boat")
  |> keep(columns: ["boat"])`;
  
  try {
    const results = await queryInfluxDB(fluxQuery);
    const boats = [...new Set(results.map(r => r.boat).filter(Boolean))];
    return boats.sort();
  } catch (err) {
    error('[influxdb_utils] Error getting sources from InfluxDB:', err);
    throw err;
  }
}

/**
 * Initialize metadata table for InfluxDB channels cache
 * Creates the table if it doesn't exist
 */
async function ensureInfluxChannelsTable() {
  try {
    await db.executeCommand(`
      CREATE TABLE IF NOT EXISTS admin.meta_influx_channels (
        source_name TEXT NOT NULL,
        date TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'strm',
        channels JSONB NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_name, date, level)
      )
    `);
    
    await db.executeCommand(`
      CREATE INDEX IF NOT EXISTS idx_meta_influx_channels_lookup 
      ON admin.meta_influx_channels(source_name, date, level, updated_at)
    `);
    
    log('[influxdb_utils] InfluxDB channels metadata table ensured');
  } catch (err) {
    error('[influxdb_utils] Error ensuring metadata table:', err);
    // Don't throw - allow fallback to direct query
  }
}

/**
 * Get cached channels from metadata table
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name
 * @param {string} level - Data level filter ('strm' or 'log')
 * @returns {Promise<Array<string>|null>} Cached channels or null if not found/stale
 */
async function getCachedChannels(date, sourceName, level = 'strm') {
  try {
    await ensureInfluxChannelsTable();

    const dateStr = String(date);
    const cacheHoursRaw = parseInt(env.INFLUX_CHANNELS_CACHE_HOURS || '24', 10);
    const cacheHours = (cacheHoursRaw > 0 && !isNaN(cacheHoursRaw)) ? cacheHoursRaw : 24;
    const cacheMaxAge = cacheHours * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - cacheMaxAge);
    
    const sql = `
      SELECT channels, updated_at 
      FROM admin.meta_influx_channels 
      WHERE source_name = $1 AND date = $2 AND level = $3
      AND updated_at > $4
      ORDER BY updated_at DESC 
      LIMIT 1
    `;
    
    const rows = await db.getRows(sql, [sourceName, dateStr, level, cutoffTime]);
    
    if (rows && rows.length > 0) {
      // Parse JSONB array back to JavaScript array
      const channelsJson = rows[0].channels;
      const cachedChannels = Array.isArray(channelsJson) ? channelsJson : JSON.parse(channelsJson);
      debug(`[influxdb_utils] Found ${cachedChannels.length} cached channels for ${sourceName}/${dateStr}/${level}`);
      return cachedChannels;
    }
    
    return null;
  } catch (err) {
    error('[influxdb_utils] Error getting cached channels:', err);
    return null; // Fallback to direct query
  }
}

/**
 * Cache channels in metadata table
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name
 * @param {string} level - Data level filter ('strm' or 'log')
 * @param {Array<string>} channels - Array of channel names
 */
async function cacheChannels(date, sourceName, level, channels) {
  try {
    await ensureInfluxChannelsTable();
    
    const dateStr = String(date);
    const sql = `
      INSERT INTO admin.meta_influx_channels (source_name, date, level, channels, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (source_name, date, level) 
      DO UPDATE SET 
        channels = EXCLUDED.channels,
        updated_at = NOW()
    `;
    
    await db.executeCommand(sql, [sourceName, dateStr, level, JSON.stringify(channels)]);
    log(`[influxdb_utils] Cached ${channels.length} channels for ${sourceName}/${dateStr}/${level}`);
  } catch (err) {
    error('[influxdb_utils] Error caching channels:', err);
    // Don't throw - caching failure shouldn't break the query
  }
}

/**
 * Get list of measurements (channels) from InfluxDB for a boat/date
 * Uses cache first (unless skipCache), then queries InfluxDB if cache miss or stale
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name (maps to 'boat' in InfluxDB)
 * @param {string} level - Data level filter ('strm' or 'log'). Defaults to 'strm'
 * @param {boolean} checkHealth - Optional: perform health check before querying. Defaults to false for performance
 * @param {boolean} skipCache - Optional: if true, bypass cache and always query InfluxDB for a fresh channel list
 * @returns {Promise<Array<string>>} Array of measurement names
 */
async function getChannelsFromInfluxDB(date, sourceName, level = 'strm', checkHealth = false, skipCache = false) {
  // Optional health check before querying
  if (checkHealth) {
    try {
      const influxHost = env.INFLUX_HOST;
      if (influxHost) {
        await checkInfluxDBHealth(influxHost);
        debug('[influxdb_utils] Health check passed before querying channels');
      }
    } catch (err) {
      error('[influxdb_utils] Health check failed before querying channels:', err.message);
      throw new Error(`InfluxDB health check failed: ${err.message}`);
    }
  }

  // Convert date to string format first
  const dateStr = String(date);
  if (dateStr.length !== 8 || !/^\d+$/.test(dateStr)) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYYMMDD format.`);
  }

  if (!skipCache) {
    // Try cache first - check for fresh cached channels (within 24 hours)
    const cachedChannels = await getCachedChannels(date, sourceName, level);
    if (cachedChannels && cachedChannels.length > 0) {
      log(`[influxdb_utils] Using cached channels (${cachedChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
      return cachedChannels;
    }

    // No fresh cache - check for stale cache (channels don't change, so stale is better than nothing)
    // This prevents timeouts when InfluxDB is slow/unavailable, since channels don't change
    let staleChannels = null;
    try {
      await ensureInfluxChannelsTable();
      const sql = `
      SELECT channels, updated_at 
      FROM admin.meta_influx_channels 
      WHERE source_name = $1 AND date = $2 AND level = $3
      ORDER BY updated_at DESC 
      LIMIT 1
    `;
      const rows = await db.getRows(sql, [sourceName, dateStr, level]);
      if (rows && rows.length > 0) {
        const channelsJson = rows[0].channels;
        staleChannels = Array.isArray(channelsJson) ? channelsJson : JSON.parse(channelsJson);
        if (staleChannels && staleChannels.length > 0) {
          log(`[influxdb_utils] Using stale cached channels (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level} - skipping InfluxDB query since channels don't change`);
          return staleChannels;
        }
      }
    } catch (cacheErr) {
      debug('[influxdb_utils] Could not check for stale cache:', cacheErr.message);
    }
  } else {
    log(`[influxdb_utils] skipCache=true: bypassing cache and querying InfluxDB for fresh channel list`);
  }

  // Load stale cache for fallback on error (used in catch block)
  let staleChannels = null;
  try {
    await ensureInfluxChannelsTable();
    const sql = `
      SELECT channels, updated_at 
      FROM admin.meta_influx_channels 
      WHERE source_name = $1 AND date = $2 AND level = $3
      ORDER BY updated_at DESC 
      LIMIT 1
    `;
    const rows = await db.getRows(sql, [sourceName, dateStr, level]);
    if (rows && rows.length > 0) {
      const channelsJson = rows[0].channels;
      staleChannels = Array.isArray(channelsJson) ? channelsJson : JSON.parse(channelsJson);
    }
  } catch (cacheErr) {
    debug('[influxdb_utils] Could not load stale cache for error fallback:', cacheErr.message);
  }

  // No cache (or skipCache) - query InfluxDB to get channels
  // Convert date from YYYYMMDD to YYYY-MM-DD format
  const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  const boat = String(sourceName);
  const influxBucket = env.INFLUX_BUCKET;
  const fullDayStart = `${formattedDate}T00:00:00Z`;
  const fullDayStop = `${formattedDate}T23:59:59Z`;

  try {
    // Query full day for all measurements: ensures we see every channel that has data anytime that day.
    // (A 1-minute window around one sample time could miss channels that only have data at other times.)
    log(`[influxdb_utils] Querying InfluxDB for channels (full day): source=${sourceName}, date=${dateStr}, level=${level}`);
    // Tag filters (boat, level) first after range for tag index use
    const fullDayQuery = `from(bucket: "${influxBucket}")
  |> range(start: time(v: "${fullDayStart}"), stop: time(v: "${fullDayStop}"))
  |> filter(fn: (r) => r.boat == "${boat}")
  |> filter(fn: (r) => r.level == "${level}")
  |> filter(fn: (r) => r._field == "value")
  |> group(columns: ["_measurement"])
  |> first()
  |> group()
  |> keep(columns: ["_measurement"])`;

    const queryStartTime = Date.now();
    debug(`[influxdb_utils] Flux query: ${fullDayQuery}`);
    const results = await queryInfluxDB(fullDayQuery);
    const queryDuration = Date.now() - queryStartTime;
    log(`[influxdb_utils] Query completed in ${queryDuration}ms, returned ${results.length} rows`);

    let measurements = [...new Set(results.map(r => r._measurement).filter(Boolean))];
    if (measurements.length === 0) {
      warn(`[influxdb_utils] No channels found for ${sourceName}/${dateStr}/${level}. Possible reasons: no data in InfluxDB, wrong boat name, or wrong level.`);
    }

    const sortedChannels = measurements.sort();
    
    log(`[influxdb_utils] Extracted ${sortedChannels.length} unique channels: ${sortedChannels.slice(0, 10).join(', ')}${sortedChannels.length > 10 ? '...' : ''}`);
    
    // Cache the results for future use (channels don't change, so cache indefinitely)
    await cacheChannels(date, sourceName, level, sortedChannels);
    log(`[influxdb_utils] Successfully cached ${sortedChannels.length} channels for ${sourceName}/${dateStr}/${level}`);
    
    return sortedChannels;
  } catch (err) {
    // Check if this is a timeout error
    const isTimeout = err.statusCode === 504 || 
                      err.statusMessage === 'Gateway Time-out' ||
                      (err.message && (err.message.includes('504') || err.message.includes('Gateway Time-out')));
    
    // Note: We should have already checked for stale cache before querying InfluxDB
    // This is a fallback in case cache was somehow missed or populated between checks
    // Since we now return stale cache immediately if it exists, this should rarely be needed
    if (!staleChannels || staleChannels.length === 0) {
      try {
        await ensureInfluxChannelsTable();
        const sql = `
          SELECT channels, updated_at 
          FROM admin.meta_influx_channels 
          WHERE source_name = $1 AND date = $2 AND level = $3
          ORDER BY updated_at DESC 
          LIMIT 1
        `;
        const rows = await db.getRows(sql, [sourceName, dateStr, level]);
        if (rows && rows.length > 0) {
          const channelsJson = rows[0].channels;
          const foundStaleChannels = Array.isArray(channelsJson) ? channelsJson : JSON.parse(channelsJson);
          if (foundStaleChannels && foundStaleChannels.length > 0) {
            staleChannels = foundStaleChannels;
            log(`[influxdb_utils] Fallback: Retrieved stale cache from database (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
          }
        }
      } catch (cacheErr) {
        debug('[influxdb_utils] Could not retrieve stale cache on error:', cacheErr.message);
      }
    }
    
    // If we have stale cache, return it (for any error, not just timeout)
    if (staleChannels && staleChannels.length > 0) {
      if (isTimeout) {
        log(`[influxdb_utils] InfluxDB gateway timeout (504) - returning stale cached channels (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
      } else {
        warn(`[influxdb_utils] InfluxDB query failed - returning stale cached channels (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
      }
      return staleChannels;
    }
    
    // No cache available and InfluxDB failed
    if (isTimeout) {
      warn(`[influxdb_utils] InfluxDB gateway timeout (504) and no cache available for ${sourceName}/${dateStr}/${level}`);
      warn(`[influxdb_utils] Cache needs to be populated when InfluxDB is available. This is expected on first query.`);
    }
    
    error('[influxdb_utils] Error getting channels from InfluxDB:', err);
    error('[influxdb_utils] Error details:', {
      message: err.message,
      statusCode: err.statusCode,
      statusMessage: err.statusMessage,
      stack: err.stack,
      source: sourceName,
      date: dateStr,
      level: level,
      hasStaleCache: staleChannels !== null && staleChannels.length > 0
    });
    throw err;
  }
}

/**
 * Get list of measurements (channels) from InfluxDB for both strm and log levels, merged and deduplicated.
 * Use this so the channel list includes all channels from either level.
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name (maps to 'boat' in InfluxDB)
 * @param {boolean} checkHealth - Optional: perform health check before querying. Defaults to false
 * @param {boolean} skipCache - Optional: if true, bypass cache and always query InfluxDB
 * @returns {Promise<Array<string>>} Array of measurement names (strm + log merged, case-insensitive dedupe, first-seen casing)
 */
async function getChannelsFromInfluxDBBothLevels(date, sourceName, checkHealth = false, skipCache = false) {
  const [strmChannels, logChannels] = await Promise.all([
    getChannelsFromInfluxDB(date, sourceName, 'strm', checkHealth, skipCache),
    getChannelsFromInfluxDB(date, sourceName, 'log', checkHealth, skipCache)
  ]);
  const merged = new Map();
  for (const ch of [...(strmChannels || []), ...(logChannels || [])]) {
    if (ch && typeof ch === 'string') {
      const lower = ch.toLowerCase();
      if (!merged.has(lower)) merged.set(lower, ch);
    }
  }
  const sorted = Array.from(merged.values()).sort();
  log(`[influxdb_utils] getChannelsFromInfluxDBBothLevels: strm=${(strmChannels || []).length}, log=${(logChannels || []).length}, merged=${sorted.length}`);
  return sorted;
}

/**
 * Resample a single channel's data
 * @param {Array<Object>} data - Array of {ts, value} objects
 * @param {string} channelName - Channel name
 * @param {string} channelType - Channel type
 * @param {string} resolution - Resolution string (e.g., '1s', '100ms')
 * @returns {Array<Object>} Resampled data
 */
function resampleChannel(data, channelName, channelType, resolution) {
  if (!data || data.length === 0) {
    return [];
  }
  
  if (!resolution || typeof resolution !== 'string' || resolution.trim() === '') {
    return data;
  }
  
  const resolutionSeconds = parseResolution(resolution);
  if (!resolutionSeconds || resolutionSeconds <= 0) {
    return data;
  }
  
  // Sort by timestamp
  const sorted = [...data].sort((a, b) => a.ts - b.ts);
  
  // Create time buckets
  const buckets = new Map();
  const normalizedType = normalizeChannelType(channelType);
  
  for (const record of sorted) {
    const ts = record.ts;
    const bucketTs = Math.floor(ts / resolutionSeconds) * resolutionSeconds;
    
    if (!buckets.has(bucketTs)) {
      buckets.set(bucketTs, []);
    }
    buckets.get(bucketTs).push(record);
  }
  
  // Aggregate each bucket
  const resampled = [];
  for (const [bucketTs, records] of buckets.entries()) {
    if (records.length === 0) continue;
    
    let aggregatedValue;
    
    if (normalizedType === 'string') {
      // For strings, use the last value
      aggregatedValue = records[records.length - 1].value;
    } else if (normalizedType === 'int') {
      // For integers, use the last value (discrete values)
      const values = records.map(r => r.value).filter(v => v !== null && v !== undefined && !isNaN(v));
      if (values.length > 0) {
        aggregatedValue = Math.round(values[values.length - 1]);
      } else {
        aggregatedValue = null;
      }
    } else if (normalizedType === 'angle360') {
      // For 360-degree angles: compute sin/cos, aggregate, convert back
      const values = records.map(r => r.value).filter(v => v !== null && v !== undefined && !isNaN(v));
      if (values.length > 0) {
        const radians = values.map(v => (v * Math.PI) / 180);
        const sinAvg = radians.reduce((sum, r) => sum + Math.sin(r), 0) / radians.length;
        const cosAvg = radians.reduce((sum, r) => sum + Math.cos(r), 0) / radians.length;
        aggregatedValue = ((Math.atan2(sinAvg, cosAvg) * 180 / Math.PI) + 360) % 360;
      } else {
        aggregatedValue = null;
      }
    } else if (normalizedType === 'angle180') {
      // For 180-degree angles: compute sin/cos, aggregate, convert back
      const values = records.map(r => r.value).filter(v => v !== null && v !== undefined && !isNaN(v));
      if (values.length > 0) {
        const radians = values.map(v => (v * Math.PI) / 180);
        const sinAvg = radians.reduce((sum, r) => sum + Math.sin(r), 0) / radians.length;
        const cosAvg = radians.reduce((sum, r) => sum + Math.cos(r), 0) / radians.length;
        aggregatedValue = (((Math.atan2(sinAvg, cosAvg) * 180 / Math.PI) + 180) % 360) - 180;
      } else {
        aggregatedValue = null;
      }
    } else {
      // For floats and other types, use average
      const values = records.map(r => r.value).filter(v => v !== null && v !== undefined && !isNaN(v));
      if (values.length > 0) {
        aggregatedValue = values.reduce((sum, v) => sum + v, 0) / values.length;
      } else {
        aggregatedValue = null;
      }
    }
    
    const record = { ts: bucketTs };
    record[channelName] = aggregatedValue;
    resampled.push(record);
  }
  
  return resampled.sort((a, b) => a.ts - b.ts);
}

/**
 * Get channel values from InfluxDB
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name (maps to 'boat' in InfluxDB)
 * @param {Array} channelList - Array of channel objects with 'name' and 'type' keys
 * @param {string} resolution - Resampling frequency (e.g., '1s', '100ms'). Defaults to '1s'
 * @param {number|null} startTs - Optional start timestamp in seconds
 * @param {number|null} endTs - Optional end timestamp in seconds
 * @param {string|null} timezone - Optional timezone string
 * @param {string} level - Data level filter ('strm' or 'log'). Defaults to 'strm'
 * @param {boolean} skipMissing - If true, skip channels with no data. If false, include missing channels filled with null
 * @param {boolean} checkHealth - Optional: perform health check before querying. Defaults to false for performance
 * @param {boolean} fillMissingWithZero - If true (default), fill null/undefined channel values with 0. If false, leave undefined (for strm-then-log fallback detection).
 * @returns {Promise<Array>} Array of result objects
 */
async function getChannelValuesFromInfluxDB(
  date,
  sourceName,
  channelList,
  resolution = '1s',
  startTs = null,
  endTs = null,
  timezone = null,
  level = 'strm',
  skipMissing = true,
  checkHealth = false,
  fillMissingWithZero = true
) {
  // Optional health check before querying
  if (checkHealth) {
    try {
      const influxHost = env.INFLUX_HOST;
      if (influxHost) {
        await checkInfluxDBHealth(influxHost);
        debug('[influxdb_utils] Health check passed before querying channel values');
      }
    } catch (err) {
      error('[influxdb_utils] Health check failed before querying channel values:', err.message);
      throw new Error(`InfluxDB health check failed: ${err.message}`);
    }
  }

  const influxBucket = env.INFLUX_BUCKET;
  const influxDatabase = env.INFLUX_DATABASE;
  
  // Default to '1s' if resolution is empty or None
  const effectiveResolution = (!resolution || (typeof resolution === 'string' && resolution.trim() === '')) 
    ? '1s' 
    : resolution;
  
  // Convert date from YYYYMMDD to YYYY-MM-DD format
  const dateStr = String(date);
  if (dateStr.length !== 8 || !/^\d+$/.test(dateStr)) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYYMMDD format.`);
  }
  const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  
  // Map source_name to boat parameter
  const boat = String(sourceName);
  
  // Extract measurement names from channel_list (exclude 'ts' and 'Datetime')
  // Handle both string and object formats. Do not add metadata (Grade, State, etc.) here;
  // metadata lives in other parquets and is merged at read time via DuckDB.
  const measurements = channelList
    .map(ch => typeof ch === 'string' ? ch : (ch.name || ch.channel || ch))
    .filter(name => name && name !== 'ts' && name !== 'Datetime');

  if (measurements.length === 0) {
    warn('[influxdb_utils] No data measurements to query (only ts/Datetime in channel_list) - returning empty; influx_data.parquet will NOT be written', {
      channel_list_names: channelList.map(ch => typeof ch === 'string' ? ch : (ch && (ch.name || ch.channel))),
      channel_count: channelList.length
    });
    return [];
  }
  
  // Build regex pattern for measurements (escape special regex characters). Case-sensitive to match Python and InfluxDB stored case.
  const measurementsPattern = measurements.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  // Check if we need to chunk the query
  // Chunk if: time range > 15 minutes OR full day query OR many measurements (>50)
  const CHUNK_THRESHOLD_SECONDS = 900; // 15 minutes
  const CHUNK_SIZE_SECONDS = 3600; // 1 hour
  const MEASUREMENT_CHUNK_THRESHOLD = 50; // Chunk by measurements if more than this
  // Safe row limit per query; responses may be truncated when cap is reached (narrow time range or channels)
  const queryLimitRaw = parseInt(env.INFLUX_QUERY_LIMIT || '500000', 10);
  const queryLimit = Math.max(10000, isNaN(queryLimitRaw) ? 500000 : queryLimitRaw);
  const chunkConcurrencyRaw = parseInt(env.INFLUX_CHUNK_CONCURRENCY || '2', 10);
  const chunkConcurrency = Math.max(1, Math.min(5, isNaN(chunkConcurrencyRaw) ? 2 : chunkConcurrencyRaw));

  let useChunking = false;
  let chunkStartTs = null;
  let chunkEndTs = null;
  let useMeasurementChunking = false;
  
  // Check if we should chunk by measurements
  if (measurements.length > MEASUREMENT_CHUNK_THRESHOLD) {
    useMeasurementChunking = true;
    log(`[influxdb_utils] Large number of measurements (${measurements.length}) exceeds threshold (${MEASUREMENT_CHUNK_THRESHOLD}). Will chunk by measurements.`);
  }
  
  // Determine time range and whether to chunk by time
  if (startTs !== null && startTs !== undefined && endTs !== null && endTs !== undefined) {
    const startTsNum = typeof startTs === 'number' ? startTs : Number(startTs);
    const endTsNum = typeof endTs === 'number' ? endTs : Number(endTs);
    
    if (isNaN(startTsNum) || isNaN(endTsNum)) {
      throw new Error(`Invalid timestamp values: startTs=${startTs}, endTs=${endTs}`);
    }
    
    const timeRange = endTsNum - startTsNum;
    if (timeRange > CHUNK_THRESHOLD_SECONDS) {
      useChunking = true;
      chunkStartTs = startTsNum;
      chunkEndTs = endTsNum;
      log(`[influxdb_utils] Time range ${timeRange}s (${(timeRange/60).toFixed(1)} minutes) exceeds ${CHUNK_THRESHOLD_SECONDS}s threshold. Splitting into 1-hour chunks aligned to hour boundaries.`);
    }
  } else {
    // Full day query - always chunk to avoid timeouts
    useChunking = true;
    // Will set chunkStartTs and chunkEndTs below when we have the date
    log(`[influxdb_utils] Full day query detected. Will chunk into 1-hour segments to avoid timeouts.`);
  }
  
  let rawResults = [];
  
  // If full day query and chunking is enabled, set time range from date
  if (useChunking && chunkStartTs === null) {
    if (timezone && String(timezone).toUpperCase() !== 'UTC') {
      try {
        const [y, m, d] = formattedDate.split('-').map(Number);
        const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
        const utcNextMidnight = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
        const inTZ = new Date(utcMidnight).toLocaleString('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const timePart = (inTZ.replace(/\//g, '-').split(' ')[1]) || '00:00:00';
        const [tzH, tzMin, tzSec] = timePart.split(':').map(Number);
        const offsetSeconds = (tzH * 3600) + (tzMin * 60) + (tzSec || 0);
        chunkStartTs = Math.floor((utcMidnight - offsetSeconds * 1000) / 1000);
        const inTZNext = new Date(utcNextMidnight).toLocaleString('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const timePartNext = (inTZNext.replace(/\//g, '-').split(' ')[1]) || '00:00:00';
        const [tzHn, tzMinn, tzSecn] = timePartNext.split(':').map(Number);
        const offsetNextSeconds = (tzHn * 3600) + (tzMinn * 60) + (tzSecn || 0);
        const nextDayMidnightUtc = (utcNextMidnight - offsetNextSeconds * 1000) / 1000;
        chunkEndTs = Math.floor(nextDayMidnightUtc) - 1;
        log(`[influxdb_utils] Using local date range: ${formattedDate} in ${timezone} -> UTC timestamps ${chunkStartTs} to ${chunkEndTs}`);
      } catch (tzErr) {
        warn(`[influxdb_utils] Could not parse timezone '${timezone}' for local date range, using UTC date:`, tzErr.message);
        const startDate = new Date(`${formattedDate}T00:00:00Z`);
        const endDate = new Date(`${formattedDate}T23:59:59Z`);
        chunkStartTs = Math.floor(startDate.getTime() / 1000);
        chunkEndTs = Math.floor(endDate.getTime() / 1000);
      }
    } else {
      const startDate = new Date(`${formattedDate}T00:00:00Z`);
      const endDate = new Date(`${formattedDate}T23:59:59Z`);
      chunkStartTs = Math.floor(startDate.getTime() / 1000);
      chunkEndTs = Math.floor(endDate.getTime() / 1000);
    }
  }
  
  if (useChunking || useMeasurementChunking) {
    // If chunking by measurements, split measurements into batches
    let measurementBatches = [];
    if (useMeasurementChunking) {
      const BATCH_SIZE = 30; // Process 30 measurements at a time
      for (let i = 0; i < measurements.length; i += BATCH_SIZE) {
        measurementBatches.push(measurements.slice(i, i + BATCH_SIZE));
      }
      log(`[influxdb_utils] Split ${measurements.length} measurements into ${measurementBatches.length} batches of ~${BATCH_SIZE} each`);
    } else {
      // Single batch with all measurements
      measurementBatches = [measurements];
    }
    
    // If not time-chunking, create a single time range
    const timeRanges = [];
    if (useChunking && chunkStartTs !== null && chunkEndTs !== null) {
      let currentStart = chunkStartTs;
      while (currentStart < chunkEndTs) {
        // Calculate the start of the next hour for this chunk
        const currentDate = new Date(currentStart * 1000);
        let currentEnd;
        
        // If we're not already at the start of an hour, align to the next hour
        if (currentDate.getMinutes() !== 0 || currentDate.getSeconds() !== 0 || currentDate.getMilliseconds() !== 0) {
          // Move to the start of the next hour
          const nextHour = new Date(currentDate);
          nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
          currentEnd = Math.min(nextHour.getTime() / 1000, chunkEndTs);
        } else {
          // Already at hour boundary, go to next hour
          const nextHour = new Date(currentDate);
          nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
          currentEnd = Math.min(nextHour.getTime() / 1000, chunkEndTs);
        }
        
        timeRanges.push({ start: currentStart, end: currentEnd });
        currentStart = currentEnd;
      }
    } else {
      // Single time range - use provided timestamps or full day; cap at 1 hour per range to avoid timeouts
      const startTsNum = (startTs !== null && startTs !== undefined && endTs !== null && endTs !== undefined)
        ? (typeof startTs === 'number' ? startTs : Number(startTs))
        : Math.floor(new Date(`${formattedDate}T00:00:00Z`).getTime() / 1000);
      const endTsNum = (startTs !== null && startTs !== undefined && endTs !== null && endTs !== undefined)
        ? (typeof endTs === 'number' ? endTs : Number(endTs))
        : Math.floor(new Date(`${formattedDate}T23:59:59Z`).getTime() / 1000);
      let currentStart = startTsNum;
      while (currentStart < endTsNum) {
        const currentEnd = Math.min(currentStart + CHUNK_SIZE_SECONDS, endTsNum);
        timeRanges.push({ start: currentStart, end: currentEnd });
        currentStart = currentEnd;
      }
    }

    // Build flat list of chunk jobs (timeRange × measurementBatch) to run with bounded concurrency
    const chunkJobs = [];
    for (const timeRange of timeRanges) {
      for (const measurementBatch of measurementBatches) {
        chunkJobs.push({ timeRange, measurementBatch });
      }
    }
    log(`[influxdb_utils] Executing ${chunkJobs.length} chunk queries with concurrency ${chunkConcurrency}`);

    async function runOneChunkJob(job) {
      const { timeRange, measurementBatch } = job;
      const chunkStartDate = new Date(timeRange.start * 1000);
      const chunkEndDate = new Date(timeRange.end * 1000);
      const chunkStartTime = chunkStartDate.toISOString();
      const chunkStopTime = chunkEndDate.toISOString();
      const batchPattern = measurementBatch.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const chunkFluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: time(v: "${chunkStartTime}"), stop: time(v: "${chunkStopTime}"))
  |> filter(fn: (r) => r.boat == "${boat}")
  |> filter(fn: (r) => r.level == "${level}")
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r._measurement =~ /^(${batchPattern})$/)
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])
  |> limit(n: ${queryLimit})`;
      debug(`[influxdb_utils] Chunk Flux query: ${chunkStartTime} to ${chunkStopTime}, measurements=${measurementBatch.length}`);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const rows = await queryInfluxDB(chunkFluxQuery);
          return Array.isArray(rows) ? rows : [];
        } catch (err) {
          const is504 = err.statusCode === 504 ||
              (err.message && (err.message.includes('504') || err.message.includes('Gateway Time-out')));
          if (is504 && attempt === 1) {
            warn(`[influxdb_utils] Gateway timeout (504) for chunk ${chunkStartTime} to ${chunkStopTime}, measurements=${measurementBatch.length}; retrying once in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          if (is504) {
            warn(`[influxdb_utils] Gateway timeout (504) for chunk ${chunkStartTime} to ${chunkStopTime} after retry. Reduce INFLUX_CHUNK_CONCURRENCY or time range if this persists.`);
          }
          error(`[influxdb_utils] Chunk query failed for ${chunkStartTime} to ${chunkStopTime}, measurements=${measurementBatch.length}:`, err);
          return [];
        }
      }
      return [];
    }

    // Run jobs with bounded concurrency; preserve result order
    const chunkResults = new Array(chunkJobs.length);
    let jobIndex = 0;
    async function runNext() {
      if (jobIndex >= chunkJobs.length) return;
      const index = jobIndex++;
      try {
        chunkResults[index] = await runOneChunkJob(chunkJobs[index]);
      } catch (err) {
        chunkResults[index] = [];
      }
      return runNext();
    }
    const workers = [];
    for (let w = 0; w < Math.min(chunkConcurrency, chunkJobs.length); w++) {
      workers.push(runNext());
    }
    await Promise.all(workers);
    
    // Warn if any chunk hit the row limit (result may be truncated)
    const truncatedChunks = chunkResults.filter(r => r && r.length >= queryLimit);
    if (truncatedChunks.length > 0) {
      warn(`[influxdb_utils] ${truncatedChunks.length} chunk(s) hit row limit (${queryLimit}); result may be truncated. Narrow time range or reduce channels.`);
    }
    // Warn when some chunks returned no data (empty series vs errors: failures also log in runOneChunkJob)
    const emptyChunkCount = chunkResults.filter(r => !r || r.length === 0).length;
    if (emptyChunkCount > 0) {
      const allEmpty = emptyChunkCount === chunkResults.length;
      const ctx = {
        boat,
        date: formattedDate,
        level,
        bucket: influxBucket,
        emptyChunks: emptyChunkCount,
        totalChunks: chunkResults.length,
      };
      if (allEmpty) {
        warn(
          `[influxdb_utils] All ${chunkResults.length} Influx chunk(s) returned no rows (boat=${boat}, date=${formattedDate}, level=${level}, bucket=${influxBucket}). ` +
            'Common causes: no data in Influx for this boat/day/level, boat tag mismatch vs normalization (1_normalization_influx), wrong bucket, or retention dropped the range. ' +
            'If chunk queries failed, see earlier [influxdb_utils] error lines (504/timeouts).',
          ctx
        );
      } else {
        warn(
          `[influxdb_utils] ${emptyChunkCount} of ${chunkResults.length} chunk(s) returned no data; merged result may be partial. Check timeouts/Influx errors above or sparse data in some hours.`,
          ctx
        );
      }
    }
    
    // Merge all chunk results
    rawResults = chunkResults.flat();
    
    // Remove duplicates that might occur at chunk boundaries (based on _time or ts)
    const seenTimestamps = new Set();
    rawResults = rawResults.filter(record => {
      const timestamp = record._time || record.ts;
      if (timestamp) {
        const tsKey = typeof timestamp === 'string' ? timestamp : timestamp.toString();
        if (seenTimestamps.has(tsKey)) {
          return false;
        }
        seenTimestamps.add(tsKey);
      }
      return true;
    });
    
    log(`[influxdb_utils] Merged ${chunkResults.length} chunks into ${rawResults.length} total rows`);
  } else {
    // Original single query logic (for small queries)
    // Determine time range
    let startTime, stopTime;
    if (startTs !== null && startTs !== undefined && endTs !== null && endTs !== undefined) {
      // Use specific timestamps (convert from Unix seconds to ISO string)
      // Ensure timestamps are numbers
      const startTsNum = typeof startTs === 'number' ? startTs : Number(startTs);
      const endTsNum = typeof endTs === 'number' ? endTs : Number(endTs);
      
      if (isNaN(startTsNum) || isNaN(endTsNum)) {
        throw new Error(`Invalid timestamp values: startTs=${startTs}, endTs=${endTs}`);
      }
      
      const startDate = new Date(startTsNum * 1000);
      const endDate = new Date(endTsNum * 1000);
      startTime = startDate.toISOString();
      stopTime = endDate.toISOString();
      
      log(`[influxdb_utils] Using timestamp range: ${startTsNum} to ${endTsNum} (${startTime} to ${stopTime})`);
    } else {
      // Use full day based on date
      startTime = `${formattedDate}T00:00:00Z`;
      stopTime = `${formattedDate}T23:59:59Z`;
      log(`[influxdb_utils] Using full day range: ${startTime} to ${stopTime}`);
    }
    
    // Tag filters (boat, level) first after range for tag index use; _measurement regex last. limit() caps rows to avoid timeouts/OOM.
    const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: time(v: "${startTime}"), stop: time(v: "${stopTime}"))
  |> filter(fn: (r) => r.boat == "${boat}")
  |> filter(fn: (r) => r.level == "${level}")
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r._measurement =~ /^(${measurementsPattern})$/)
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])
  |> limit(n: ${queryLimit})`;
    
    log(`[influxdb_utils] Executing query: bucket=${influxBucket}, org=${influxDatabase}, boat=${boat}, date=${formattedDate}, level=${level}, measurements=${measurements.length}, time_range=${startTime} to ${stopTime}`);
    debug(`[influxdb_utils] Flux query: ${fluxQuery}`);
    
    try {
      // Execute query
      rawResults = await queryInfluxDB(fluxQuery);
    } catch (err) {
      // Check if it's a 504 Gateway Timeout
      const isTimeout = err.statusCode === 504 || 
                      (err.message && err.message.includes('504')) ||
                      (err.message && err.message.includes('Gateway Time-out')) ||
                      (err.message && err.message.includes('timeout'));
      
      if (isTimeout) {
        warn(`[influxdb_utils] Gateway timeout (504) detected. Query may be too large. Consider using smaller time ranges or fewer measurements.`);
        warn(`[influxdb_utils] Query parameters: measurements=${measurements.length}, time_range=${startTime} to ${stopTime}`);
      }
      error('[influxdb_utils] InfluxDB query error:', err);
      throw err;
    }
    if (rawResults && rawResults.length >= queryLimit) {
      warn(`[influxdb_utils] Single query hit row limit (${queryLimit}); result may be truncated. Narrow time range or reduce channels.`);
    }
  }
  
  try {
    if (!rawResults || rawResults.length === 0) {
      log(`[influxdb_utils] No data returned from InfluxDB query for boat=${boat}, level=${level}, date=${formattedDate}, measurements=${measurements.join(', ')}`);
      return [];
    }
    
    log(`[influxdb_utils] Retrieved ${rawResults.length} raw rows from InfluxDB`);
    
    // Debug: Check for binary data before processing
    let binaryFieldsFound = new Set();
    rawResults.forEach((record, idx) => {
      Object.keys(record).forEach(key => {
        const value = record[key];
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
          binaryFieldsFound.add(key);
          if (idx < 3) {
            warn(`[influxdb_utils] Raw result[${idx}][${key}] is binary: ${Buffer.isBuffer(value) ? 'Buffer' : 'Uint8Array'}, length: ${value.length}`);
          }
        }
      });
    });
    if (binaryFieldsFound.size > 0) {
      warn(`[influxdb_utils] WARNING: Found binary data in fields: ${Array.from(binaryFieldsFound).join(', ')}. Attempting conversion...`);
    }
    
    // Convert _time to ts (Unix timestamp in seconds)
    const results = rawResults.map((record, idx) => {
      const result = { ...record };
      
      // Debug first few records
      if (idx < 3) {
        debug(`[influxdb_utils] Processing raw result[${idx}]: keys=${Object.keys(result).join(', ')}`);
      }
      
      // Convert any binary/buffer values to strings or numbers if possible
      Object.keys(result).forEach(key => {
        const value = result[key];
        if (Buffer.isBuffer(value)) {
          // Try to convert buffer to string
          try {
            const strValue = value.toString('utf8');
            debug(`[influxdb_utils] Converted Buffer[${key}] to string: "${strValue.substring(0, 50)}"`);
            result[key] = strValue;
          } catch (err) {
            warn(`[influxdb_utils] Failed to convert Buffer[${key}] to string: ${err.message}`);
            // Try to convert to number if it's a numeric buffer
            try {
              const numValue = parseFloat(value.toString('utf8'));
              if (!isNaN(numValue)) {
                result[key] = numValue;
                debug(`[influxdb_utils] Converted Buffer[${key}] to number: ${numValue}`);
              } else {
                result[key] = null;
              }
            } catch {
              result[key] = null;
            }
          }
        } else if (value instanceof Uint8Array) {
          // Convert Uint8Array to Buffer then to string
          try {
            const buffer = Buffer.from(value);
            const strValue = buffer.toString('utf8');
            debug(`[influxdb_utils] Converted Uint8Array[${key}] to string: "${strValue.substring(0, 50)}"`);
            result[key] = strValue;
          } catch (err) {
            warn(`[influxdb_utils] Failed to convert Uint8Array[${key}]: ${err.message}`);
            result[key] = null;
          }
        }
      });
      
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
            debug(`[influxdb_utils] Converting GPS coordinate ${key}: ${value} -> ${convertedValue} (divided by 10^7)`);
          }
          result[key] = convertedValue;
        }
      });
      
      if (result._time) {
        // _time is RFC3339 datetime string, convert to Unix timestamp
        const date = new Date(result._time);
        result.ts = Math.round(date.getTime() / 1000 * 1000) / 1000; // Round to 3 decimals
        delete result._time;
      }
      
      if (idx < 3) {
        debug(`[influxdb_utils] Processed result[${idx}]: keys=${Object.keys(result).join(', ')}, sample values: ${JSON.stringify(Object.fromEntries(Object.entries(result).slice(0, 3)))}`);
      }
      
      return result;
    });
    
    // Dataset size check
    if (results.length > 10000000) {
      error(`[influxdb_utils] Large dataset detected: ${results.length} rows. May cause memory issues.`);
      return [];
    }
    
    // Sort by ts
    results.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    
    // Process each channel individually: remove NaNs, resample, then merge
    const processedChannels = [];
    const baseColumn = 'ts';
    
    // Get string columns (these need special handling - forward/backward fill, not resampled)
    const stringCols = channelList
      .filter(ch => normalizeChannelType(ch.type || '') === 'string' && results.some(r => r[ch.name] !== undefined))
      .map(ch => ch.name);
    
    // Process string columns separately (forward/backward fill, no resampling)
    if (stringCols.length > 0) {
      const stringData = results
        .map(r => {
          const record = { ts: r.ts };
          stringCols.forEach(col => {
            record[col] = r[col] || '';
          });
          return record;
        })
        .filter(r => r.ts !== undefined && r.ts !== null);
      
      // Forward fill then backward fill
      for (const col of stringCols) {
        let lastValue = '';
        for (let i = 0; i < stringData.length; i++) {
          if (stringData[i][col] !== null && stringData[i][col] !== undefined && stringData[i][col] !== '') {
            lastValue = stringData[i][col];
          } else {
            stringData[i][col] = lastValue;
          }
        }
        // Backward fill
        lastValue = '';
        for (let i = stringData.length - 1; i >= 0; i--) {
          if (stringData[i][col] !== null && stringData[i][col] !== undefined && stringData[i][col] !== '') {
            lastValue = stringData[i][col];
          } else if (lastValue) {
            stringData[i][col] = lastValue;
          }
        }
        // Replace 'nan', 'None', 'NaN', '<NA>' strings with empty string
        for (let i = 0; i < stringData.length; i++) {
          const val = stringData[i][col];
          if (val === 'nan' || val === 'None' || val === 'NaN' || val === '<NA>') {
            stringData[i][col] = '';
          }
        }
      }
      
      if (stringData.length > 0) {
        processedChannels.push(stringData);
      }
    }
    
    // Process each numeric channel individually
    for (const ch of channelList) {
      const channelName = ch.name;
      const channelType = normalizeChannelType(ch.type || '');
      
      // Skip if not in results or if it's a string column (already processed) or if it's ts/Datetime
      if (channelName === baseColumn || channelName === 'Datetime' || stringCols.includes(channelName)) {
        continue;
      }
      
      // Check if channel exists in results
      if (!results.some(r => r[channelName] !== undefined)) {
        if (!skipMissing) {
          // Add missing channel filled with null
          const missingData = results.map(r => ({
            ts: r.ts,
            [channelName]: null
          }));
          processedChannels.push(missingData);
        }
        continue;
      }
      
      // Create array with just ts and this channel, remove NaNs
      const channelData = results
        .map(r => ({
          ts: r.ts,
          value: r[channelName]
        }))
        .filter(r => r.ts !== undefined && r.ts !== null && r.value !== null && r.value !== undefined && !isNaN(r.value));
      
      // Skip if no data left after removing NaNs
      if (channelData.length === 0) {
        if (!skipMissing) {
          // Add missing channel filled with null
          const missingData = results.map(r => ({
            ts: r.ts,
            [channelName]: null
          }));
          processedChannels.push(missingData);
        }
        continue;
      }
      
      // Type enforcement
      for (const record of channelData) {
        if (channelType === 'float') {
          record.value = parseFloat(record.value) || 0;
        } else if (channelType === 'int') {
          record.value = Math.round(parseFloat(record.value) || 0);
        }
      }
      
      // Resample this channel
      const resampled = resampleChannel(channelData, channelName, channelType, effectiveResolution);
      
      // Convert to format with channel name as key
      const processed = resampled.map(r => ({
        ts: r.ts,
        [channelName]: r[channelName]
      }));
      
      processedChannels.push(processed);
    }
    
    // Merge all processed channels together using ts as the key
    if (processedChannels.length === 0) {
      return [];
    }
    
    // Start with the first channel
    let merged = processedChannels[0];
    
    // Merge remaining channels
    for (let i = 1; i < processedChannels.length; i++) {
      const channelData = processedChannels[i];
      const mergedMap = new Map();
      
      // Add all existing merged records
      for (const record of merged) {
        mergedMap.set(record.ts, { ...record });
      }
      
      // Merge in new channel data
      for (const record of channelData) {
        const ts = record.ts;
        if (mergedMap.has(ts)) {
          Object.assign(mergedMap.get(ts), record);
        } else {
          // Create new record with all previous channels as null
          const newRecord = {};
          for (const key of Object.keys(merged[0] || {})) {
            newRecord[key] = null;
          }
          newRecord.ts = ts;
          Object.assign(newRecord, record);
          mergedMap.set(ts, newRecord);
        }
      }
      
      merged = Array.from(mergedMap.values());
    }
    
    // Sort by ts
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    
    // Create Datetime column from ts for compatibility
    if (channelList.some(ch => ch.name === 'Datetime')) {
      for (const record of merged) {
        if (record.ts !== undefined && record.ts !== null) {
          const date = new Date(record.ts * 1000);
          if (timezone) {
            // Note: JavaScript Date doesn't support timezone conversion directly
            // This is a simplified version - for full timezone support, consider using a library like date-fns-tz
            record.Datetime = date.toISOString();
          } else {
            record.Datetime = date.toISOString();
          }
        }
      }
    }
    
    // Fill remaining nulls in numeric columns with 0 (unless fillMissingWithZero=false for fallback detection)
    if (fillMissingWithZero) {
      for (const record of merged) {
        for (const ch of channelList) {
          const channelName = ch.name;
          if (channelName === baseColumn || channelName === 'Datetime' || stringCols.includes(channelName)) {
            continue;
          }
          if (record[channelName] === null || record[channelName] === undefined) {
            record[channelName] = 0;
          }
        }
      }
    }
    
    return merged;
  } catch (err) {
    error('[influxdb_utils] Error getting channel values from InfluxDB:', err);
    throw err;
  }
}

/**
 * Get channel values from InfluxDB trying strm first, then log for any channel with no data (strm wins when both have data).
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name (maps to 'boat' in InfluxDB)
 * @param {Array} channelList - Array of channel objects with 'name' and 'type' keys
 * @param {string} resolution - Resampling frequency (e.g., '1s', '100ms'). Defaults to '1s'
 * @param {number|null} startTs - Optional start timestamp in seconds
 * @param {number|null} endTs - Optional end timestamp in seconds
 * @param {string|null} timezone - Optional timezone string
 * @param {boolean} skipMissing - If true, skip channels with no data. If false, include missing channels filled with null
 * @param {boolean} checkHealth - Optional: perform health check before querying. Defaults to false
 * @returns {Promise<Array>} Array of result objects
 */
async function getChannelValuesFromInfluxDBWithFallback(
  date,
  sourceName,
  channelList,
  resolution = '1s',
  startTs = null,
  endTs = null,
  timezone = null,
  skipMissing = true,
  checkHealth = false
) {
  const measurementNames = (channelList || [])
    .map(ch => (typeof ch === 'string' ? ch : (ch && (ch.name || ch.channel))))
    .filter(n => n && n !== 'ts' && n !== 'Datetime');
  if (measurementNames.length === 0) {
    return getChannelValuesFromInfluxDB(date, sourceName, channelList, resolution, startTs, endTs, timezone, 'strm', skipMissing, checkHealth, true);
  }
  const strmResult = await getChannelValuesFromInfluxDB(
    date, sourceName, channelList, resolution, startTs, endTs, timezone, 'strm', skipMissing, checkHealth, false
  );
  const channelsWithNoDataInStrm = measurementNames.filter(m =>
    !strmResult.some(row => {
      const v = row[m];
      return v !== undefined && v !== null && (typeof v !== 'number' || !Number.isNaN(v));
    })
  );
  if (channelsWithNoDataInStrm.length === 0) {
    for (const record of strmResult) {
      for (const ch of channelList) {
        const name = ch.name || ch.channel;
        if (name && name !== 'ts' && name !== 'Datetime' && (record[name] === null || record[name] === undefined)) {
          record[name] = 0;
        }
      }
    }
    log(`[influxdb_utils] getChannelValuesFromInfluxDBWithFallback: all ${measurementNames.length} channels had data in strm`);
    return strmResult;
  }
  log(`[influxdb_utils] getChannelValuesFromInfluxDBWithFallback: ${channelsWithNoDataInStrm.length} channels had no data in strm, querying log: ${channelsWithNoDataInStrm.slice(0, 5).join(', ')}${channelsWithNoDataInStrm.length > 5 ? '...' : ''}`);
  const logChannelList = channelsWithNoDataInStrm.map(name => {
    const ch = channelList.find(c => (c && (c.name || c.channel)) === name);
    return ch ? (typeof ch === 'string' ? { name: ch, type: 'float' } : { name: ch.name || ch.channel, type: ch.type || 'float' }) : { name, type: 'float' };
  });
  const logResult = await getChannelValuesFromInfluxDB(
    date, sourceName, logChannelList, resolution, startTs, endTs, timezone, 'log', true, false, false
  );
  const byTs = new Map();
  for (const row of strmResult) {
    const ts = row.ts;
    if (ts !== undefined && ts !== null) byTs.set(ts, { ...row });
  }
  for (const row of logResult) {
    const ts = row.ts;
    if (ts === undefined && ts === null) continue;
    let merged = byTs.get(ts);
    if (!merged) {
      merged = { ts };
      byTs.set(ts, merged);
    }
    for (const name of channelsWithNoDataInStrm) {
      const v = row[name];
      if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isNaN(v))) {
        merged[name] = v;
      }
    }
  }
  const merged = Array.from(byTs.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const hasDatetime = channelList.some(ch => (ch && (ch.name || ch.channel)) === 'Datetime');
  for (const record of merged) {
    for (const ch of channelList) {
      const name = ch.name || ch.channel;
      if (name && name !== 'ts' && name !== 'Datetime' && (record[name] === null || record[name] === undefined)) {
        record[name] = 0;
      }
    }
    if (hasDatetime && record.ts !== undefined && record.ts !== null) {
      record.Datetime = new Date(record.ts * 1000).toISOString();
    }
  }
  return merged;
}

/**
 * Read existing parquet file and return data as array of objects
 * @param {string} filePath - Path to parquet file
 * @returns {Promise<Array>} Array of data objects
 */
async function readExistingParquetFile(filePath) {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return [];
    }
    
    // Check file size - skip if too large (e.g., > 100MB)
    const stats = fs.statSync(filePath);
    const maxFileSize = 100 * 1024 * 1024; // 100MB
    if (stats.size > maxFileSize) {
      warn(`[readExistingParquetFile] File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB), skipping merge. Will overwrite.`);
      return [];
    }
    
    const conn = await initializeDuckDB();
    const convertedPath = convertPathForContainer(filePath);
    const escapedPath = convertedPath.replace(/\\/g, '/').replace(/'/g, "''");
    const fileSQL = `'${escapedPath}'`;
    
    // Read all data from parquet file
    const query = `SELECT * FROM read_parquet([${fileSQL}])`;
    log(`[readExistingParquetFile] Reading existing data from ${filePath}`);
    
    const reader = await conn.runAndReadAll(query);
    const rows = reader.getRowObjectsJS();
    
    log(`[readExistingParquetFile] Read ${rows.length} rows from existing file`);
    return rows || [];
  } catch (err) {
    warn(`[readExistingParquetFile] Error reading existing parquet file: ${err.message}`);
    // Return empty array on error - will fall back to overwrite mode
    return [];
  }
}

/**
 * Merge and deduplicate data arrays based on timestamp
 * @param {Array} existingData - Existing data from parquet file
 * @param {Array} newData - New data from InfluxDB
 * @returns {Array} Merged and deduplicated data
 */
function mergeAndDeduplicateData(existingData, newData) {
  if (!existingData || existingData.length === 0) {
    return newData || [];
  }
  
  if (!newData || newData.length === 0) {
    return existingData;
  }
  
  // Create a map keyed by timestamp to deduplicate
  // If same ts exists in both, prefer new data (newer data takes precedence)
  const dataMap = new Map();
  
  // First, add existing data
  for (const row of existingData) {
    if (row && row.ts !== null && row.ts !== undefined) {
      const ts = typeof row.ts === 'number' ? row.ts : parseFloat(row.ts);
      if (!isNaN(ts)) {
        dataMap.set(ts, { ...row });
      }
    }
  }
  
  // Then, add/overwrite with new data (new data takes precedence for same timestamp)
  for (const row of newData) {
    if (row && row.ts !== null && row.ts !== undefined) {
      const ts = typeof row.ts === 'number' ? row.ts : parseFloat(row.ts);
      if (!isNaN(ts)) {
        // Merge with existing row if it exists, otherwise use new row
        const existingRow = dataMap.get(ts);
        if (existingRow) {
          // Merge: new data values take precedence, but keep existing values for fields not in new data
          const mergedRow = { ...existingRow, ...row };
          dataMap.set(ts, mergedRow);
        } else {
          dataMap.set(ts, { ...row });
        }
      }
    }
  }
  
  // Convert map back to array and sort by timestamp
  const mergedData = Array.from(dataMap.values());
  mergedData.sort((a, b) => {
    const tsA = typeof a.ts === 'number' ? a.ts : parseFloat(a.ts) || 0;
    const tsB = typeof b.ts === 'number' ? b.ts : parseFloat(b.ts) || 0;
    return tsA - tsB;
  });
  
  log(`[mergeAndDeduplicateData] Merged ${existingData.length} existing rows with ${newData.length} new rows, result: ${mergedData.length} unique rows`);
  return mergedData;
}

/**
 * Infer schema from merged data (handles all columns from both datasets)
 * @param {Array} data - Merged data array
 * @returns {Object} Schema fields object
 */
function inferSchemaFromMergedData(data) {
  const schemaFields = {};
  const fieldTypes = {};
  
  // Analyze all rows to determine types
  for (const row of data) {
    if (!row) continue;
    
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) {
        continue; // Skip null/undefined values for type inference
      }
      
      // If we haven't seen this field yet, or if we need to resolve type conflict
      if (!fieldTypes[key]) {
        // Determine type
        if (key === 'ts') {
          fieldTypes[key] = 'DOUBLE'; // Timestamp as double
        } else if (key === 'Datetime') {
          fieldTypes[key] = 'UTF8'; // Datetime as string
        } else if (typeof value === 'number') {
          fieldTypes[key] = 'DOUBLE';
        } else if (typeof value === 'boolean') {
          fieldTypes[key] = 'BOOLEAN';
        } else {
          fieldTypes[key] = 'UTF8'; // String
        }
      } else {
        // Resolve type conflicts - prefer more specific types
        const currentType = fieldTypes[key];
        if (currentType === 'UTF8') {
          // If current is string, check if new value suggests a different type
          if (typeof value === 'number' && key !== 'ts' && key !== 'Datetime') {
            fieldTypes[key] = 'DOUBLE'; // Upgrade to number
          } else if (typeof value === 'boolean') {
            fieldTypes[key] = 'BOOLEAN'; // Upgrade to boolean
          }
        } else if (currentType === 'DOUBLE' && typeof value === 'boolean') {
          // If current is number but new is boolean, keep as DOUBLE (numbers are more flexible)
          // Actually, boolean should be boolean - but we'll keep DOUBLE for compatibility
        }
      }
    }
  }
  
  // Build schema
  for (const [key, parquetType] of Object.entries(fieldTypes)) {
    schemaFields[key] = { type: parquetType, optional: true };
  }
  
  // Ensure 'ts' is always present (required for DuckDB queries)
  if (!schemaFields.ts) {
    schemaFields.ts = { type: 'DOUBLE', optional: true };
  }
  
  // Ensure 'Datetime' is present if we have ts
  if (schemaFields.ts && !schemaFields.Datetime) {
    schemaFields.Datetime = { type: 'UTF8', optional: true };
  }
  
  return schemaFields;
}

/**
 * Save InfluxDB data to parquet file.
 * influx_data.parquet must contain only Influx time-series: ts, Datetime, and measurement columns.
 * Metadata (Grade, State, Twa_deg, Race_number, Leg_number, Foiling_state) lives in other parquets
 * and is merged at read time via DuckDB.
 * Merges with existing influx_data.parquet file if it exists.
 *
 * @param {Array} data - Array of data objects from InfluxDB query
 * @param {string} projectId - Project ID
 * @param {string} className - Class name (will be lowercased)
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name
 * @returns {Promise<string>} Path to saved parquet file
 */
async function saveInfluxDataToParquet(data, projectId, className, date, sourceName) {
  if (!data || data.length === 0) {
    warn('[saveInfluxDataToParquet] No data to save, skipping (caller will not get parquet file written)');
    return null;
  }

  try {
    const parquet = require('@dsnp/parquetjs');
    const fs = require('fs');
    const path = require('path');

    // Normalize class name to lowercase
    const classLower = String(className || '').toLowerCase();
    
    // Build file path: DATA_DIRECTORY/System/{project_id}/{class_name}/{date}/{source_name}/influx_data.parquet
    const filePath = path.join(
      env.DATA_DIRECTORY,
      'System',
      String(projectId),
      classLower,
      date,
      sourceName,
      'influx_data.parquet'
    );

    // Ensure directory exists
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      log(`[saveInfluxDataToParquet] Created directory: ${dirPath}`);
    }

    // Read existing data if file exists (for merging)
    let existingData = [];
    const fileExists = fs.existsSync(filePath);
    if (fileExists) {
      try {
        existingData = await readExistingParquetFile(filePath);
        if (existingData.length > 0) {
          log(`[saveInfluxDataToParquet] Found existing file with ${existingData.length} rows, will merge with ${data.length} new rows`);
        } else {
          log(`[saveInfluxDataToParquet] Existing file is empty or could not be read, will overwrite`);
        }
      } catch (err) {
        warn(`[saveInfluxDataToParquet] Error reading existing file, will overwrite: ${err.message}`);
        existingData = [];
      }
    }

    // Merge existing data with new data and deduplicate
    const mergedData = mergeAndDeduplicateData(existingData, data);
    
    if (mergedData.length === 0) {
      log('[saveInfluxDataToParquet] No data to save after merge, skipping');
      return null;
    }

    // influx_data.parquet must contain only Influx time-series (ts, Datetime, measurement columns).
    // Strip metadata columns so they are never written; metadata lives in other parquets and is merged at read time via DuckDB.
    // Config is not a timeseries channel and must not appear in influx_data.parquet.
    const METADATA_COLUMNS_EXCLUDE = ['Grade', 'State', 'Twa_deg', 'Race_number', 'Leg_number', 'Foiling_state', 'Config'];
    const excludeSet = new Set(METADATA_COLUMNS_EXCLUDE.map(n => n.toLowerCase()));
    const rowsToWrite = mergedData.map(row => {
      const filtered = {};
      for (const [key, value] of Object.entries(row)) {
        if (!excludeSet.has(key.toLowerCase())) {
          filtered[key] = value;
        }
      }
      return filtered;
    });

    // Infer schema from filtered data (no metadata columns)
    const schemaFields = inferSchemaFromMergedData(rowsToWrite);
    const schema = new parquet.ParquetSchema(schemaFields);

    log(`[saveInfluxDataToParquet] Saving ${rowsToWrite.length} merged rows (${existingData.length} existing + ${data.length} new) to ${filePath}`);
    log(`[saveInfluxDataToParquet] Schema fields: ${Object.keys(schemaFields).join(', ')}`);

    // Remove existing file before writing merged data
    if (fileExists) {
      fs.unlinkSync(filePath);
      log(`[saveInfluxDataToParquet] Removed existing file before writing merged data`);
    }

    // Create writer
    const writer = await parquet.ParquetWriter.openFile(schema, filePath);

    // Format Datetime to match Racesight Python parquet: "2026-01-17 04:15:05.800000+00:00"
    const formatDatetimeRacesight = (ts) => {
      const n = typeof ts === 'number' ? ts : parseFloat(ts);
      if (n === undefined || n === null || isNaN(n)) return null;
      const ms = n < 1e12 ? n * 1000 : n;
      const date = new Date(ms);
      if (isNaN(date.getTime())) return null;
      const pad = (x) => String(x).padStart(2, '0');
      const micro = Math.floor((date.getUTCMilliseconds() / 1000) * 1e6);
      const padMicro = (x) => String(x).padStart(6, '0');
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${padMicro(micro)}+00:00`;
    };

    // Write all merged rows (already stripped of metadata)
    for (const row of rowsToWrite) {
      // Ensure ts and Datetime are present (parquet often has ts but Datetime null - charts need Datetime)
      const record = { ...row };

      // Normalize ts to number (handle string/scientific e.g. "1.768623e+09")
      if (record.ts !== undefined && record.ts !== null) {
        const n = typeof record.ts === 'number' ? record.ts : parseFloat(record.ts);
        record.ts = !isNaN(n) ? n : record.ts;
      }

      // Derive Datetime from ts when missing, in Racesight format for chart/Python compatibility
      if (record.ts !== undefined && record.ts !== null && !isNaN(record.ts)) {
        if (record.Datetime === undefined || record.Datetime === null || record.Datetime === '') {
          record.Datetime = formatDatetimeRacesight(record.ts) || new Date(record.ts * 1000).toISOString();
        }
      }
      if (record.Datetime !== undefined && record.Datetime !== null) {
        record.Datetime = String(record.Datetime);
      }

      await writer.appendRow(record);
    }

    // Close writer
    await writer.close();

    log(`[saveInfluxDataToParquet] Successfully saved ${rowsToWrite.length} merged rows to ${filePath}`);
    return filePath;
  } catch (err) {
    error('[saveInfluxDataToParquet] Error saving InfluxDB data to parquet:', err);
    error('[saveInfluxDataToParquet] Error stack:', err.stack);
    // Don't throw - allow the API response to continue even if save fails
    return null;
  }
}

module.exports = {
  getInfluxDBClient,
  queryInfluxDB,
  checkInfluxDBHealth,
  checkInfluxDBHealthWithQuery,
  getSourcesFromInfluxDB,
  getChannelsFromInfluxDB,
  getChannelsFromInfluxDBBothLevels,
  getChannelValuesFromInfluxDB,
  getChannelValuesFromInfluxDBWithFallback,
  saveInfluxDataToParquet
};
