const { DuckDBInstance, DuckDBConnection } = require('@duckdb/node-api');
const path = require('path');
const fs = require('fs');
const arrow = require('apache-arrow');
const { log, error, debug, warn } = require('../../shared');
const env = require('./config');

// Global DuckDB instance and connection (in-memory)
let dbInstance = null;
let dbConnection = null;

/**
 * Initialize DuckDB instance and connection
 * @returns {Promise<DuckDBConnection>} DuckDB connection
 */
async function initializeDuckDB() {
  if (dbConnection) {
    return dbConnection;
  }

  try {
    // Verify DuckDB module is available
    if (!DuckDBInstance || typeof DuckDBInstance.create !== 'function') {
      const errorMsg = 'DuckDB module not properly loaded. DuckDBInstance.create not found.';
      error('[duckdb_utils]', errorMsg);
      throw new Error(errorMsg);
    }
    
    log('[duckdb_utils] Creating DuckDB in-memory database...');
    
    // Create instance with memory limit configuration
    const memoryLimit = env.DUCKDB_MEMORY_LIMIT || '2GB';
    dbInstance = await DuckDBInstance.create(':memory:', {
      memory_limit: memoryLimit
    });
    
    log(`[duckdb_utils] DuckDB instance created with memory limit: ${memoryLimit}`);
    
    // Create connection from instance
    dbConnection = await dbInstance.connect();
    
    // Test the connection with a simple query
    const testReader = await dbConnection.runAndReadAll('SELECT 1 as test');
    const testResult = testReader.getRowObjectsJS();
    if (!testResult || testResult.length === 0) {
      throw new Error('Connection test query returned no results');
    }
    
    log('[duckdb_utils] DuckDB connection initialized and tested successfully');
    return dbConnection;
  } catch (err) {
    error('[duckdb_utils] Failed to initialize DuckDB:', err);
    error('[duckdb_utils] Error type:', typeof err);
    error('[duckdb_utils] Error message:', err.message);
    error('[duckdb_utils] Error stack:', err.stack);
    throw err;
  }
}

/**
 * Convert Windows path to container path for Docker compatibility
 * @param {string} filePath - File path to convert
 * @returns {string} Converted path
 */
function convertPathForContainer(filePath) {
  if (!filePath) return filePath;
  
  // Check if running in Docker
  const isDocker = process.env.DOCKER_CONTAINER === 'true' || process.env.NODE_ENV === 'production';
  if (!isDocker) {
    return filePath;
  }
  
  // Normalize the path for comparison
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  
  // Check if this looks like a Windows path
  const isWindowsPath = /^[A-Za-z]:[\/\\]/.test(filePath);
  
  if (isWindowsPath) {
    const containerDataDir = '/data';
    
    // Common Windows data directory patterns
    const possibleDataDirs = [
      env.DATA_DIRECTORY,
      'C:/MyApps/Hunico/Uploads/Data',
      'C:\\MyApps\\Hunico\\Uploads\\Data'
    ].filter(Boolean);
    
    // Try each possible data directory
    for (const dataDir of possibleDataDirs) {
      const normalizedDataDir = String(dataDir).replace(/\\/g, '/');
      
      if (normalizedPath.toLowerCase().startsWith(normalizedDataDir.toLowerCase())) {
        let relativePath = normalizedPath.substring(normalizedDataDir.length);
        if (relativePath.startsWith('/')) {
          relativePath = relativePath.substring(1);
        }
        relativePath = relativePath.replace(/\\/g, '/');
        const containerPath = path.join(containerDataDir, relativePath).replace(/\\/g, '/');
        return containerPath;
      }
    }
    
    // Try extracting relative part after /Data/
    const dataMatch = normalizedPath.match(/[\/\\]Data[\/\\](.+)$/i);
    if (dataMatch) {
      let relativePath = dataMatch[1].replace(/\\/g, '/');
      const containerPath = path.join(containerDataDir, relativePath).replace(/\\/g, '/');
      return containerPath;
    }
  }
  
  return filePath;
}

/**
 * Parse resolution string to seconds
 * @param {string} resolution - Resolution string (e.g., '1s', '100ms', '200ms')
 * @returns {number|null} Resolution in seconds, or null if invalid
 */
function parseResolution(resolution) {
  if (!resolution || typeof resolution !== 'string') {
    return null;
  }
  
  const rsLower = resolution.toLowerCase().trim();
  
  // Handle milliseconds
  if (rsLower.endsWith('ms')) {
    try {
      const ms = parseFloat(rsLower.slice(0, -2));
      return ms / 1000; // Convert to seconds
    } catch (e) {
      return null;
    }
  }
  
  // Handle seconds
  if (rsLower.endsWith('s')) {
    try {
      return parseFloat(rsLower.slice(0, -1));
    } catch (e) {
      return null;
    }
  }
  
  // Handle minutes
  if (rsLower.endsWith('min') || rsLower.endsWith('m')) {
    try {
      const value = parseFloat(rsLower.slice(0, rsLower.endsWith('min') ? -3 : -1));
      return value * 60;
    } catch (e) {
      return null;
    }
  }
  
  // Handle hours
  if (rsLower.endsWith('h')) {
    try {
      return parseFloat(rsLower.slice(0, -1)) * 3600;
    } catch (e) {
      return null;
    }
  }
  
  // Default: try to parse as number (assume seconds)
  try {
    return parseFloat(rsLower);
  } catch (e) {
    return null;
  }
}

/**
 * Build time bucket SQL expression
 * @param {number} resolutionSeconds - Resolution in seconds
 * @returns {string} SQL expression for time bucketing
 * IMPORTANT: Always uses 'ts' (numeric timestamp) for bucketing, never 'Datetime'
 */
function buildTimeBucketSQL(resolutionSeconds) {
  return `FLOOR(ts / ${resolutionSeconds}) * ${resolutionSeconds}`;
}

/**
 * Canonical epoch-seconds key for merging rows across parquet files (matches AC40 fusion script ts.round(3)).
 * Prevents near-duplicate floats from splitting processed_data vs fusion_corrections onto different rows,
 * which made _cor series sparse and drew bogus straight segments in time-series charts.
 */
function canonicalTsSeconds(ts) {
  if (ts === undefined || ts === null) return null;
  let n = Number(ts);
  if (!isFinite(n)) return null;
  if (n > 1e12) {
    n = n / 1000;
  }
  return Math.round(n * 1000) / 1000;
}

/**
 * True for fusion/correction outputs that must win when merging multiple parquet rows on the same `ts`.
 * Default merge is "first non-null wins", which breaks when processed/norm rows appear first and carry
 * 0/NULL for offset-like fields, or when file query order hides fusion_corrections updates.
 */
function isFusionOverlayColumn(key) {
  if (!key || typeof key !== 'string') return false;
  const k = key.toLowerCase();
  if (k === 'ts' || k === 'datetime') return false;
  return (
    k.includes('offset')
    || k.includes('_cor_')
    || k.endsWith('_cor_deg')
    || k.endsWith('_cor_kph')
    || k.endsWith('_cor_kts')
  );
}

/**
 * Use circular stats for corrected angle channels even when catalog type is float (avoids bad bucket means).
 */
function resolveAggregationChannelType(channelName, channelType) {
  const lower = (channelName || '').toLowerCase();
  if (lower.endsWith('_cor_deg')) {
    if (lower.includes('twd')) return 'angle360';
    return 'angle180';
  }
  return normalizeChannelType(channelType);
}

/**
 * Normalize channel type to determine aggregation method
 * @param {string} channelType - Channel type string
 * @returns {string} Normalized type
 */
function normalizeChannelType(channelType) {
  if (!channelType || typeof channelType !== 'string') {
    return channelType;
  }
  
  const typeLower = channelType.toLowerCase().trim();
  
  // Check for angle types
  const hasAngle = typeLower.includes('angle');
  const has360 = typeLower.includes('360');
  const has180 = typeLower.includes('180');
  
  if (hasAngle || has360 || has180) {
    if (has360) return 'angle360';
    if (has180) return 'angle180';
    return 'angle';
  }
  
  // Map base types
  const typeMapping = {
    'str': 'string', 'text': 'string', 'varchar': 'string', 'char': 'string', 'string': 'string',
    'int': 'int', 'integer': 'int', 'int32': 'int', 'int64': 'int', 'int16': 'int', 'int8': 'int',
    'float': 'float', 'float32': 'float', 'float64': 'float', 'double': 'float', 'real': 'float', 'numeric': 'float', 'number': 'float',
    'datetime': 'datetime', 'date': 'datetime', 'timestamp': 'datetime', 'time': 'datetime',
    'bool': 'bool', 'boolean': 'bool',
  };
  
  return typeMapping[typeLower] || typeLower;
}

/**
 * Per-bucket SUM for time-series line types cumulative / abs_cumulative (client sends bucket_aggregate).
 * Not applied to angles, strings, or datetime. See channel-values API channel_list[].bucket_aggregate.
 */
function shouldUseBucketSum(normalizedType, bucketAggregate) {
  const a = bucketAggregate != null ? String(bucketAggregate).toLowerCase().trim() : '';
  if (a !== 'sum' && a !== 'sum_abs') return false;
  if (normalizedType === 'angle360' || normalizedType === 'angle180' || normalizedType === 'string' || normalizedType === 'datetime') {
    return false;
  }
  return true;
}

function bucketSumExpr(columnRef, sumAbs) {
  return sumAbs ? `SUM(ABS(${columnRef}))` : `SUM(${columnRef})`;
}

/**
 * Build aggregation SQL for a channel
 * @param {string} channelName - Channel name
 * @param {string} channelType - Channel type
 * @param {string} timeBucketExpr - Time bucket expression
 * @param {string|undefined} bucketAggregate - optional 'sum' | 'sum_abs' for resampled numeric channels
 * @returns {string} SQL aggregation expression
 */
function buildChannelAggregationSQL(channelName, channelType, timeBucketExpr, bucketAggregate) {
  const normalizedType = resolveAggregationChannelType(channelName, channelType);
  
  // Use quoted column name to handle special characters
  const columnRef = `"${channelName}"`;
  const sumAbs = String(bucketAggregate || '').toLowerCase().trim() === 'sum_abs';
  const useSum = shouldUseBucketSum(normalizedType, bucketAggregate);
  
  switch (normalizedType) {
    case 'float':
      if (useSum) {
        const inner = bucketSumExpr(columnRef, sumAbs);
        return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(${inner}, FIRST(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
      }
      // AVG ignores NULLs and computes average of non-NULL values
      // If COUNT > 0, there are non-NULL values, so AVG should return a value
      // Use COALESCE with FIRST as fallback only if AVG somehow returns NULL despite having data
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(AVG(${columnRef}), FIRST(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
    
    case 'int':
      if (useSum) {
        const inner = bucketSumExpr(columnRef, sumAbs);
        return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(${inner}, FIRST(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
      }
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(MAX(${columnRef}), FIRST(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
    
    case 'string':
      // MAX should work for strings, but explicitly CAST to VARCHAR to ensure string type is preserved
      // This guarantees strings are ALWAYS returned as strings, never converted to numbers
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          CAST(COALESCE(MAX(${columnRef}), FIRST(${columnRef})) AS VARCHAR)
        ELSE NULL
      END as ${channelName}`;
    
    case 'datetime':
      // FIRST should work for datetime, but ensure we return a value if any non-NULL data exists
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(FIRST(${columnRef}), MAX(${columnRef}), MIN(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
    
    case 'angle360':
      // For 360-degree angles: compute sin/cos, aggregate, convert back, normalize to 0-360
      // The angle calculation might return NULL if all values are NULL, but if COUNT > 0, we have data
      // Use AVG as fallback if the circular mean calculation fails
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(
            ((ATAN2(AVG(SIN(${columnRef} * PI() / 180)), AVG(COS(${columnRef} * PI() / 180))) * 180 / PI() + 360) % 360),
            AVG(${columnRef}),
            FIRST(${columnRef})
          )
        ELSE NULL
      END as ${channelName}`;
    
    case 'angle180':
      // For 180-degree angles: compute sin/cos, aggregate, convert back, normalize to -180 to 180
      // The angle calculation might return NULL if all values are NULL, but if COUNT > 0, we have data
      // Use AVG as fallback if the circular mean calculation fails
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(
            (((ATAN2(AVG(SIN(${columnRef} * PI() / 180)), AVG(COS(${columnRef} * PI() / 180))) * 180 / PI() + 180) % 360) - 180),
            AVG(${columnRef}),
            FIRST(${columnRef})
          )
        ELSE NULL
      END as ${channelName}`;
    
    default:
      if (useSum) {
        const inner = bucketSumExpr(columnRef, sumAbs);
        return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(${inner}, FIRST(${columnRef}), MAX(${columnRef}), MIN(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
      }
      // Default to AVG for unknown types, with fallback to ensure we return a value when data exists
      return `CASE 
        WHEN COUNT(${columnRef}) > 0 THEN 
          COALESCE(AVG(${columnRef}), FIRST(${columnRef}), MAX(${columnRef}), MIN(${columnRef}))
        ELSE NULL
      END as ${channelName}`;
  }
}

/**
 * Build aggregation SQL for all channels
 * @param {Array} channelList - Array of channel objects with name and type
 * @param {string} timeBucketExpr - Time bucket expression
 * @returns {string} SQL SELECT clause with aggregations
 */
function buildAggregationSQL(channelList, timeBucketExpr) {
  const aggregations = [];
  
  // Always include ts (time bucket)
  aggregations.push(`${timeBucketExpr} as ts`);
  
  // Add Datetime if requested
  const hasDatetime = channelList.some(ch => ch.name === 'Datetime');
  if (hasDatetime) {
    aggregations.push(`FIRST(Datetime) as Datetime`);
  }
  
  // Add aggregations for each channel
  for (const channel of channelList) {
    const name = channel.name || channel.channel;
    const { type, bucket_aggregate: bucketAggregate } = channel;
    
    // Skip ts and Datetime (already handled)
    if (name === 'ts' || name === 'Datetime') {
      continue;
    }
    
    const aggSQL = buildChannelAggregationSQL(name, type, timeBucketExpr, bucketAggregate);
    aggregations.push(aggSQL);
  }
  
  return aggregations.join(', ');
}

/**
 * Query parquet files using DuckDB
 * @param {Array<string>} filePaths - Array of parquet file paths
 * @param {Array} channelList - Array of channel objects with name and type
 * @param {number|null} startTs - Start timestamp (seconds) or null
 * @param {number|null} endTs - End timestamp (seconds) or null
 * @param {string|null} resolution - Resolution string (e.g., '1s', '100ms') or null for full frequency
 * @returns {Promise<Array>} Array of result objects
 * 
 * IMPORTANT: All timestamp operations (WHERE, ORDER BY, GROUP BY, joins) use 'ts' (numeric),
 * never 'Datetime' (string). This ensures reliable sorting, filtering, and merging across files.
 */
async function queryParquetFiles(filePaths, channelList, startTs, endTs, resolution) {
  const conn = await initializeDuckDB();
  
  // Get timeout from environment variable (default: 60 seconds for file queries)
  // This should be less than browser/nginx timeouts to provide better error messages
  const queryTimeoutMs = parseInt(env.DUCKDB_QUERY_TIMEOUT_MS || '60000', 10);
  
  // Validate file paths exist
  const fs = require('fs');
  const validPaths = [];
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      validPaths.push(filePath);
    } else {
      log(`[duckdb_utils] Warning: File does not exist: ${filePath}`);
    }
  }
  
  if (validPaths.length === 0) {
    throw new Error('No valid parquet files found');
  }
  
  // Convert file paths for Docker compatibility
  const convertedPaths = validPaths.map(convertPathForContainer);
  // Non-fusion parquets first, fusion_corrections last so stable sort + merge applies fusion on top.
  const sortedParquetPaths = [...convertedPaths].sort((a, b) => {
    const ba = path.basename(a).toLowerCase();
    const bb = path.basename(b).toLowerCase();
    const fa = ba.includes('fusion_corrections');
    const fb = bb.includes('fusion_corrections');
    if (fa && !fb) return 1;
    if (!fa && fb) return -1;
    return 0;
  });

  // Log paths for debugging
  if (env.VITE_VERBOSE === 'true') {
    log(`[duckdb_utils] Querying ${sortedParquetPaths.length} files with timeout: ${queryTimeoutMs}ms`);
    sortedParquetPaths.slice(0, 3).forEach(p => log(`[duckdb_utils] File: ${p}`));
  }
  
  // Preserve original channel names from request (for response mapping)
  // CRITICAL: We need to map from requested channel names (may be lowercase) to actual case from parquet files
  // The parquet files have the original case (e.g., Twa_cor_deg, Tws_cor_kts, Bsp_kts)
  // We'll discover the actual case from the parquet files and use that in the response
  const channelNames = channelList.map(ch => ch.name).filter(name => name !== 'ts' && name !== 'Datetime');
  const allChannelNames = ['ts', ...(channelList.some(ch => ch.name === 'Datetime') ? ['Datetime'] : []), ...channelNames];
  
  // Build mapping from lowercase requested names to actual case from parquet files
  // This will be populated when we discover the actual column names from the first file
  const channelCaseMap = new Map();
  // Initialize with requested names (will be updated with actual case from parquet files)
  allChannelNames.forEach(ch => {
    channelCaseMap.set(ch.toLowerCase(), ch);
  });
  
  // Query each file separately and merge results - matches old implementation behavior
  // The old code processes each file independently, only querying channels that exist in that file
  // We'll query each file with all requested columns, and DuckDB will return NULL for missing columns
  // Then merge all results together
  const startTime = Date.now();
  let allResults = [];
  let resamplingLogged = false;

  // Wrap the entire query execution in a timeout
  const queryExecution = async () => {
    for (const filePath of sortedParquetPaths) {
    try {
      const escapedPath = filePath.replace(/\\/g, '/').replace(/'/g, "''");
      const fileSQL = `'${escapedPath}'`;
      
      // CRITICAL: Parquet files should have column names matching the requested channel names (same case)
      // Use requested channel names directly in queries - no case conversion needed
      // If a column doesn't exist, DuckDB will return NULL for that column
      // We'll use case-insensitive matching only as a fallback when the initial query fails
      
      // CRITICAL: First, discover actual column names from parquet file to preserve original case
      // Query the schema to get the actual column names (with original case)
      let actualColumnMap = new Map(); // lowercase -> actual case from parquet
      try {
        const schemaQuery = `DESCRIBE SELECT * FROM read_parquet([${fileSQL}]) LIMIT 1`;
        const schemaReader = await conn.runAndReadAll(schemaQuery);
        const schemaRows = schemaReader.getRowObjectsJS();
        schemaRows.forEach(row => {
          const colName = row.column_name;
          actualColumnMap.set(colName.toLowerCase(), colName);
        });
      } catch (schemaErr) {
        // If schema query fails, fall back to using requested names
        log(`[duckdb_utils] Could not query schema for ${filePath}, using requested column names: ${schemaErr.message}`);
      }
      
      // Build WHERE clause for this file
      const whereConditions = [];
      if (startTs !== null && startTs !== undefined) {
        whereConditions.push(`ts >= ${startTs}`);
      }
      if (endTs !== null && endTs !== undefined) {
        whereConditions.push(`ts <= ${endTs}`);
      }
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      // Map requested channel names to actual column names from parquet (preserve original case)
      // CRITICAL: Only include columns that exist in this file - prevents "not found in FROM clause" errors
      // Different files have different schemas (e.g. norm has Tws_kts, fusion has Tws_cor_kph)
      const actualChannelNames = actualColumnMap.size > 0
        ? allChannelNames
            .filter(reqCol => actualColumnMap.has(reqCol.toLowerCase()))
            .map(reqCol => actualColumnMap.get(reqCol.toLowerCase()))
        : allChannelNames.map(reqCol => actualColumnMap.get(reqCol.toLowerCase()) || reqCol);

      // Skip file if no requested columns exist (avoids empty/no-op queries; only when we have schema)
      const fileBasename = path.basename(filePath);
      if (actualColumnMap.size > 0 && actualChannelNames.length === 0) {
        log(`[duckdb_utils] Skipping ${fileBasename}: no requested columns found in file`);
        continue;
      }
      if (actualChannelNames.length > 2 && fileBasename.includes('fusion_corrections')) {
        log(`[duckdb_utils] ${fileBasename}: found ${actualChannelNames.length} of ${allChannelNames.length} requested columns`);
      }
      
      let fileQuery;
      let timeBucketExpr = null;
      let aggregationSQL = null;
      
      if (resolution) {
        // Force resampling to requested resolution - always resample regardless of native data frequency
        const resolutionSeconds = parseResolution(resolution);
        
        if (!resolutionSeconds || resolutionSeconds <= 0) {
          // Invalid resolution - default to full frequency
          log(`[duckdb_utils] Invalid resolution "${resolution}", returning full frequency`);
          // Use actual column names from parquet file (original case)
          const selectColumns = actualChannelNames.map(col => `"${col}"`).join(', ');
          fileQuery = `
            SELECT ${selectColumns}
            FROM read_parquet([${fileSQL}])
            ${whereClause}
            ORDER BY ts
          `;
        } else {
          // Always resample to the requested resolution
          timeBucketExpr = buildTimeBucketSQL(resolutionSeconds);
          // Build aggregation with actual column names from parquet - only include channels that exist in this file
          const channelListWithActualNames = channelList
            .filter(ch => actualColumnMap.has(ch.name.toLowerCase()))
            .map(ch => ({ ...ch, name: actualColumnMap.get(ch.name.toLowerCase()) }));
          const baseAggregationSQL = buildAggregationSQL(channelListWithActualNames, timeBucketExpr);
          aggregationSQL = baseAggregationSQL;
          
          if (env.VITE_VERBOSE === 'true' && !resamplingLogged) {
            log(`[duckdb_utils] Resampling ${sortedParquetPaths.length} files to ${resolutionSeconds.toFixed(3)}s (${resolution})`);
            resamplingLogged = true;
          }
          
          fileQuery = `
            SELECT ${aggregationSQL}
            FROM read_parquet([${fileSQL}])
            ${whereClause}
            GROUP BY ${timeBucketExpr}
            ORDER BY ts
          `;
        }
      } else {
        // Full frequency mode - select all requested channels using actual column names from parquet
        // Use actual column names from parquet file (original case)
        const selectColumns = actualChannelNames.map(col => `"${col}"`).join(', ');
        fileQuery = `
          SELECT ${selectColumns}
          FROM read_parquet([${fileSQL}])
          ${whereClause}
          ORDER BY ts
        `;
      }
      
      // Execute query for this file
      try {
        const reader = await conn.runAndReadAll(fileQuery);
        const fileResults = reader.getRowObjectsJS();
        
        if (fileResults && fileResults.length > 0) {
          // CRITICAL: Use the ACTUAL case from parquet files, not the requested case
          // DuckDB returns column names as they exist in the parquet file
          // We should return them in that original case, regardless of what was requested
          // The keys in fileResults[0] are the actual column names from the parquet file
          // Use them directly - they're already in the correct original case
          const mappedResults = fileResults.map(record => {
            // Use the actual column names from DuckDB results (original case from parquet)
            // Don't remap - just use what DuckDB returned
            return record;
          });
          
          // Log the actual column names for debugging
          if (env.VITE_VERBOSE === 'true' && fileResults.length > 0) {
            const actualColumns = Object.keys(fileResults[0]);
            const requestedLower = allChannelNames.map(ch => ch.toLowerCase());
            const caseMismatches = actualColumns.filter(ac => {
              const requestedMatch = allChannelNames.find(req => req.toLowerCase() === ac.toLowerCase());
              return requestedMatch && requestedMatch !== ac;
            });
            if (caseMismatches.length > 0) {
              log(`[duckdb_utils] Using original case from parquet (${caseMismatches.length} channels):`, caseMismatches.slice(0, 5));
            }
          }
          
          allResults = allResults.concat(mappedResults);
        } else if (resolution && timeBucketExpr && aggregationSQL && startTs !== null && startTs !== undefined && endTs !== null && endTs !== undefined) {
          // If time series query returns no results, fall back to original GROUP BY approach
          // This handles cases where generate_series might not work as expected
          log(`[duckdb_utils] Query returned no results for ${fileBasename}, falling back to GROUP BY`);
          const fallbackQuery = `
            SELECT ${aggregationSQL}
            FROM read_parquet([${fileSQL}])
            ${whereClause}
            GROUP BY ${timeBucketExpr}
            ORDER BY ts
          `;
          try {
              const fallbackReader = await conn.runAndReadAll(fallbackQuery);
              const fallbackResults = fallbackReader.getRowObjectsJS();
              if (fallbackResults && fallbackResults.length > 0) {
                // Parquet files should have matching case - use results directly
                allResults = allResults.concat(fallbackResults);
              } else {
                // Fallback also returned 0 rows - run diagnostic to help debug
                try {
                  const countQuery = `SELECT COUNT(*) as cnt, MIN(ts) as min_ts, MAX(ts) as max_ts FROM read_parquet([${fileSQL}])`;
                  const countReader = await conn.runAndReadAll(countQuery);
                  const countRow = countReader.getRowObjectsJS()?.[0];
                  if (countRow) {
                    log(`[duckdb_utils] ${fileBasename}: file has ${countRow.cnt} rows, ts range [${countRow.min_ts}, ${countRow.max_ts}], request range [${startTs}, ${endTs}]`);
                  }
                } catch (diagErr) {
                  log(`[duckdb_utils] ${fileBasename}: diagnostic query failed: ${diagErr.message}`);
                }
              }
          } catch (fallbackErr) {
            log(`[duckdb_utils] Fallback query also failed for ${fileBasename}: ${fallbackErr.message}`);
          }
        }
      } catch (queryErr) {
        // If query fails due to missing columns, try querying with only columns that exist
        // This handles the case where some columns don't exist in this file
        if (queryErr.message && queryErr.message.includes('not found in FROM clause')) {
          log(`[duckdb_utils] Some columns not found in ${filePath}, trying to query with available columns only`);
          
          // Try to get schema and query only with existing columns
          try {
            const schemaQuery = `DESCRIBE SELECT * FROM read_parquet([${fileSQL}]) LIMIT 1`;
            const schemaReader = await conn.runAndReadAll(schemaQuery);
            const schemaRows = schemaReader.getRowObjectsJS();
            
            // Build case-insensitive mapping: lowercase column name -> actual column name from file
            // This allows matching requested channels (e.g., "Tws_kts") to actual columns (e.g., "tws_kts")
            const columnCaseMap = new Map();
            schemaRows.forEach(row => {
              const colName = row.column_name;
              columnCaseMap.set(colName.toLowerCase(), colName);
            });
            
            // Match requested channels case-insensitively and get actual column names from file
            // Use actual column names in SQL queries (DuckDB is case-sensitive)
            const availableChannelNames = allChannelNames
              .filter(col => {
                // Always include 'ts' and 'Datetime' if they were requested
                if (col === 'ts' || col === 'Datetime') {
                  return columnCaseMap.has(col.toLowerCase());
                }
                return columnCaseMap.has(col.toLowerCase());
              })
              .map(col => {
                // Return actual column name from file (preserves case from parquet file)
                if (col === 'ts' || col === 'Datetime') {
                  return columnCaseMap.get(col.toLowerCase()) || col;
                }
                return columnCaseMap.get(col.toLowerCase()) || col;
              });
            
            if (availableChannelNames.length > 0) {
              // Log case-insensitive matching results for debugging
              if (env.VITE_VERBOSE === 'true') {
                const matchedChannels = allChannelNames
                  .filter(col => columnCaseMap.has(col.toLowerCase()))
                  .map(col => `${col} -> ${columnCaseMap.get(col.toLowerCase())}`);
                log(`[duckdb_utils] Case-insensitive column matching for ${filePath}:`, matchedChannels.slice(0, 10));
              }
              
              // Rebuild query with only available columns (using actual column names from file)
              let retryQuery;
              if (resolution) {
                const resolutionSeconds = parseResolution(resolution);
                // Filter channel list to only available channels (case-insensitive matching)
                const availableChannelList = channelList.filter(ch => {
                  if (ch.name === 'ts' || ch.name === 'Datetime') {
                    return columnCaseMap.has(ch.name.toLowerCase());
                  }
                  return columnCaseMap.has(ch.name.toLowerCase());
                }).map(ch => {
                  // Use actual column name from file for aggregation
                  const actualColName = columnCaseMap.get(ch.name.toLowerCase());
                  return actualColName ? { ...ch, name: actualColName } : ch;
                });
                
                if (!resolutionSeconds || resolutionSeconds <= 0) {
                  // Invalid resolution - default to full frequency
                  const retrySelectColumns = availableChannelNames.map(col => `"${col}"`).join(', ');
                  retryQuery = `
                    SELECT ${retrySelectColumns}
                    FROM read_parquet([${fileSQL}])
                    ${whereClause}
                    ORDER BY ts
                  `;
                } else {
                  // Force resampling to requested resolution
                  const timeBucketExpr = buildTimeBucketSQL(resolutionSeconds);
                  const aggregationSQL = buildAggregationSQL(availableChannelList, timeBucketExpr);
                  
                  retryQuery = `
                    SELECT ${aggregationSQL}
                    FROM read_parquet([${fileSQL}])
                    ${whereClause}
                    GROUP BY ${timeBucketExpr}
                    ORDER BY ts
                  `;
                }
              } else {
                // Use actual column names from file, alias to requested names (original case)
                const selectColumns = availableChannelNames.map(col => {
                  // Find which requested channel this actual column corresponds to
                  const requestedCol = allChannelNames.find(req => {
                    const actualCol = columnCaseMap.get(req.toLowerCase());
                    return actualCol && actualCol.toLowerCase() === col.toLowerCase();
                  });
                  return requestedCol ? `"${col}" AS "${requestedCol}"` : `"${col}"`;
                }).join(', ');
                retryQuery = `
                  SELECT ${selectColumns}
                  FROM read_parquet([${fileSQL}])
                  ${whereClause}
                  ORDER BY ts
                `;
              }
              
              const retryReader = await conn.runAndReadAll(retryQuery);
              const retryResults = retryReader.getRowObjectsJS();
              
              if (retryResults && retryResults.length > 0) {
                // CRITICAL: Map results to use requested channel names (original case)
                // DuckDB may return actual column names even with AS aliases, so we map explicitly
                // Use the channelCaseMap to map from lowercase (from file) to original case (from request)
                const enrichedResults = retryResults.map(record => {
                  const enriched = {};
                  Object.keys(record).forEach(key => {
                    // Map key to original case if we have a mapping
                    const originalCaseKey = channelCaseMap.get(key.toLowerCase());
                    if (originalCaseKey) {
                      // Use original case from request
                      enriched[originalCaseKey] = record[key];
                    } else {
                      // Keep key as-is if not in our mapping (shouldn't happen, but safe fallback)
                      enriched[key] = record[key];
                    }
                  });
                  return enriched;
                });
                allResults = allResults.concat(enrichedResults);
                log(`[duckdb_utils] Successfully queried ${filePath} with ${availableChannelNames.length} of ${allChannelNames.length} columns (case-insensitive matching)`);
              }
            } else {
              log(`[duckdb_utils] No requested columns found in ${filePath} (case-insensitive check), skipping`);
            }
          } catch (schemaErr) {
            log(`[duckdb_utils] Could not query schema for ${filePath}: ${schemaErr.message}`);
          }
        } else {
          // Other errors - log and continue
          log(`[duckdb_utils] Warning: Failed to query file ${filePath}: ${queryErr.message}`);
        }
      }
    } catch (fileErr) {
      // If file processing fails completely, log and continue
      log(`[duckdb_utils] Warning: Failed to process file ${filePath}: ${fileErr.message}`);
      // Continue with other files
    }
    }
    
    if (allResults.length === 0) {
      return [];
    }
    
    // Sort merged results by timestamp
    // IMPORTANT: Always use 'ts' (numeric timestamp) for sorting and joining, never 'Datetime'
    // 'ts' is more reliable for merging data across multiple parquet files
    allResults.sort((a, b) => {
      if (a.ts !== undefined && b.ts !== undefined) {
        return a.ts - b.ts;
      }
      return 0;
    });
    
    // Remove duplicate timestamps (merge data from duplicate timestamps)
    // This can happen when the same timestamp appears in multiple files
    // The new method merges duplicates to create a single record per timestamp
    // IMPORTANT: Always join/merge by 'ts' value, never by 'Datetime'
    const timestampMap = new Map();
    let recordsWithoutTimestamp = 0;
    
    for (const record of allResults) {
      // Always use 'ts' for joining - it's numeric and more reliable than Datetime strings
      if (record.ts !== undefined && record.ts !== null && !isNaN(record.ts)) {
        const tsCanon = canonicalTsSeconds(record.ts);
        if (tsCanon === null) {
          recordsWithoutTimestamp++;
          timestampMap.set(`no_ts_${recordsWithoutTimestamp}`, { ...record });
          continue;
        }
        const tsKey = tsCanon;
        if (!timestampMap.has(tsKey)) {
          const merged = { ...record, ts: tsCanon };
          timestampMap.set(tsKey, merged);
        } else {
          // Duplicate timestamp - merge data from this record into the existing one
          const existingRecord = timestampMap.get(tsKey);
          existingRecord.ts = tsKey;
          // Default: first non-null wins. For fusion outputs (_cor_*, *offset*), later rows win so
          // fusion_corrections (queried last) overlays processed/norm when both supply the same ts.
          Object.keys(record).forEach(key => {
            if (key === 'ts') return;
            const incoming = record[key];
            if (incoming === undefined || incoming === null) return;
            const cur = existingRecord[key];
            if (cur === undefined || cur === null) {
              existingRecord[key] = incoming;
            } else if (isFusionOverlayColumn(key)) {
              existingRecord[key] = incoming;
            }
          });
        }
      } else {
        // Records without valid timestamps - keep them (shouldn't happen with proper data)
        recordsWithoutTimestamp++;
        timestampMap.set(`no_ts_${recordsWithoutTimestamp}`, { ...record });
      }
    }
    
    // Convert map to array and sort by timestamp
    const deduplicatedResults = Array.from(timestampMap.values()).sort((a, b) => {
      if (a.ts !== undefined && b.ts !== undefined) {
        return a.ts - b.ts;
      }
      // Records without ts go to the end
      if (a.ts === undefined || a.ts === null) return 1;
      if (b.ts === undefined || b.ts === null) return -1;
      return 0;
    });
    
    // Convert BigInt values to Number (DuckDB may return BigInt for large integers)
    // This prevents frontend errors when using isNaN() or arithmetic operations
    const convertedResults = deduplicatedResults.map(record => {
      const converted = {};
      Object.keys(record).forEach(key => {
        const value = record[key];
        if (typeof value === 'bigint') {
          // Convert BigInt to Number (may lose precision for very large numbers, but fine for our use case)
          converted[key] = Number(value);
        } else {
          converted[key] = value;
        }
      });
      return converted;
    });
  
    const queryTime = Date.now() - startTime;
    const duplicatesRemoved = allResults.length - deduplicatedResults.length;
    log(`[duckdb_utils] Query completed in ${queryTime}ms, returned ${convertedResults.length} rows${duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicates merged)` : ''}`);
    
    return convertedResults;
  };
  
  // Create a timeout promise that will reject if query takes too long
  let queryTimeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    queryTimeoutId = setTimeout(() => {
      reject(new Error(`DuckDB query timeout after ${queryTimeoutMs}ms (queried files; partial rows: ${allResults.length})`));
    }, queryTimeoutMs);
  });

  // Race the query execution against the timeout
  try {
    const result = await Promise.race([queryExecution(), timeoutPromise]);
    if (queryTimeoutId) clearTimeout(queryTimeoutId);
    return result;
  } catch (err) {
    if (queryTimeoutId) clearTimeout(queryTimeoutId);
    if (err.message && err.message.includes('timeout')) {
      error(`[duckdb_utils] DuckDB query timed out after ${queryTimeoutMs}ms`);
      error(`[duckdb_utils] Rows accumulated: ${allResults.length}, parquet files: ${sortedParquetPaths.length}`);
      error(`[duckdb_utils] Consider: 1) Reducing number of files, 2) Adding time filters, 3) Increasing DUCKDB_QUERY_TIMEOUT_MS`);
      throw err;
    }
    throw err;
  }
}

/**
 * Extract channel names from parquet files using DuckDB
 * @param {Array<string>} filePaths - Array of parquet file paths
 * @returns {Promise<Array<string>>} Array of unique channel names across all files
 */
async function extractChannelsFromParquetFiles(filePaths) {
  const conn = await initializeDuckDB();
  const channelSet = new Set();
  
  // Validate file paths exist
  const validPaths = [];
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      validPaths.push(filePath);
    } else {
      log(`[extractChannelsFromParquetFiles] Warning: File does not exist: ${filePath}`);
    }
  }
  
  if (validPaths.length === 0) {
    return [];
  }
  
  // Convert file paths for Docker compatibility
  const convertedPaths = validPaths.map(convertPathForContainer);
  
  // Query each file's schema to get channel names
  for (const filePath of convertedPaths) {
    try {
      const escapedPath = filePath.replace(/\\/g, '/').replace(/'/g, "''");
      const fileSQL = `'${escapedPath}'`;
      
      // Use SELECT * LIMIT 0 to get column names (safer than DESCRIBE which can cause crashes)
      const schemaQuery = `SELECT * FROM read_parquet([${fileSQL}]) LIMIT 0`;
      
      try {
        const reader = await conn.runAndReadAll(schemaQuery);
        
        let columns = [];
        // Get column names from the result metadata
        if (reader.getColumnNames) {
          columns = reader.getColumnNames();
        } else {
          // Fallback: try to get from result structure (unlikely to work with LIMIT 0 if getColumnNames is missing)
          const rows = reader.getRowObjectsJS();
          if (rows && rows.length > 0) {
            columns = Object.keys(rows[0]);
          }
        }
        
        if (columns && columns.length > 0) {
          columns.forEach(col => {
            if (col) {
              channelSet.add(col);
            }
          });
          log(`[extractChannelsFromParquetFiles] Successfully extracted ${columns.length} channels from ${require('path').basename(filePath)} using SELECT LIMIT 0`);
        } else {
          // If SELECT LIMIT 0 failed to get columns, try DESCRIBE as fallback
          log(`[extractChannelsFromParquetFiles] SELECT LIMIT 0 returned no columns for ${require('path').basename(filePath)}, trying DESCRIBE`);
          
          try {
            const describeQuery = `DESCRIBE SELECT * FROM read_parquet([${fileSQL}]) LIMIT 0`;
            const describeReader = await conn.runAndReadAll(describeQuery);
            const schemaRows = describeReader.getRowObjectsJS();
            
            if (schemaRows && schemaRows.length > 0) {
              schemaRows.forEach(row => {
                const columnName = row.column_name;
                if (columnName) {
                  channelSet.add(columnName);
                }
              });
              log(`[extractChannelsFromParquetFiles] Successfully extracted ${schemaRows.length} channels from ${require('path').basename(filePath)} using DESCRIBE`);
            } else {
              log(`[extractChannelsFromParquetFiles] DESCRIBE returned no rows for ${require('path').basename(filePath)}`);
            }
          } catch (describeErr) {
            log(`[extractChannelsFromParquetFiles] DESCRIBE failed for ${require('path').basename(filePath)}: ${describeErr.message}`);
          }
        }
      } catch (queryErr) {
        log(`[extractChannelsFromParquetFiles] Query failed for ${require('path').basename(filePath)}: ${queryErr.message}`);
        // Try fallback if SELECT failed
      }
    } catch (fileErr) {
      log(`[extractChannelsFromParquetFiles] Error processing file ${filePath}: ${fileErr.message}`);
      // Continue with other files
    }
  }
  
  const channels = Array.from(channelSet);
  
  // CRITICAL: DuckDB queries require 'ts' for joining channels across files
  // Always include 'ts' in the channel list when using parquet files (DuckDB)
  const hasTs = channels.some(ch => ch.toLowerCase() === 'ts');
  if (!hasTs && channels.length > 0) {
    channels.unshift('ts');
    log(`[extractChannelsFromParquetFiles] Added 'ts' channel to discovered channels (required for DuckDB joins). Total channels: ${channels.length}`);
  }
  
  return channels;
}

/**
 * Convert DuckDB result to Apache Arrow format
 * @param {Array} result - Array of result objects from DuckDB
 * @returns {Promise<Buffer>} Arrow format buffer
 */
async function convertToArrow(result) {
  if (!result || result.length === 0) {
    // Return empty Arrow table
    const table = arrow.tableFromJSON([]);
    const writer = await arrow.RecordBatchStreamWriter.writeAll(table);
    const uint8 = await writer.toUint8Array();
    return Buffer.from(uint8);
  }
  
  // Debug: Check for binary data before Arrow conversion
  let binaryFound = false;
  const cleanedResult = result.map((row, idx) => {
    const cleanedRow = {};
    Object.keys(row).forEach(key => {
      const value = row[key];
      if (Buffer.isBuffer(value)) {
        binaryFound = true;
        // Try to convert buffer to string or number
        try {
          const strValue = value.toString('utf8');
          const numValue = parseFloat(strValue);
          cleanedRow[key] = isNaN(numValue) ? strValue : numValue;
          if (idx < 3) {
            debug(`[convertToArrow] Converted Buffer[${key}] to ${isNaN(numValue) ? 'string' : 'number'}: ${cleanedRow[key]}`);
          }
        } catch (err) {
          warn(`[convertToArrow] Failed to convert Buffer[${key}]: ${err.message}`);
          cleanedRow[key] = null;
        }
      } else if (value instanceof Uint8Array) {
        binaryFound = true;
        try {
          const buffer = Buffer.from(value);
          const strValue = buffer.toString('utf8');
          const numValue = parseFloat(strValue);
          cleanedRow[key] = isNaN(numValue) ? strValue : numValue;
          if (idx < 3) {
            debug(`[convertToArrow] Converted Uint8Array[${key}] to ${isNaN(numValue) ? 'string' : 'number'}: ${cleanedRow[key]}`);
          }
        } catch (err) {
          warn(`[convertToArrow] Failed to convert Uint8Array[${key}]: ${err.message}`);
          cleanedRow[key] = null;
        }
      } else {
        cleanedRow[key] = value;
      }
    });
    return cleanedRow;
  });
  
  if (binaryFound) {
    warn(`[convertToArrow] Found and converted binary data before Arrow conversion`);
  }
  
  if (cleanedResult.length > 0 && cleanedResult.length <= 3) {
    debug(`[convertToArrow] Sample row before conversion: ${JSON.stringify(cleanedResult[0], null, 2).substring(0, 500)}`);
  }
  
  // Convert to Arrow table
  const table = arrow.tableFromJSON(cleanedResult);
  const writer = await arrow.RecordBatchStreamWriter.writeAll(table);
  const uint8 = await writer.toUint8Array();
  return Buffer.from(uint8);
}

module.exports = {
  initializeDuckDB,
  parseResolution,
  buildTimeBucketSQL,
  buildAggregationSQL,
  queryParquetFiles,
  convertToArrow,
  convertPathForContainer,
  normalizeChannelType,
  extractChannelsFromParquetFiles
};
