const http = require('http');
const https = require('https');
const { log, error, warn, debug, isVerboseEnabled } = require('../../shared');
const env = require('./config');
const { normalizeChannelType, parseResolution, initializeDuckDB, convertPathForContainer } = require('./duckdb_utils');
const db = require('../../shared/database/connection');

/** Fully-qualified IOx table for InfluxDB v3 SQL */
const IOX_TABLE = '"iox"."universalized_logs"';

/**
 * @param {string|undefined} raw
 * @returns {string}
 */
function normalizeInfluxToken(raw) {
  if (raw == null || raw === '') return '';
  let t = String(raw).trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * @param {string} baseUrl
 * @returns {string} Origin with protocol, host, and INFLUX_PORT when host URL has no port
 */
function mergePortIntoOrigin(baseUrl) {
  let influxUrl = String(baseUrl || '').trim();
  if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
    influxUrl = `http://${influxUrl}`;
  }
  const u = new URL(influxUrl);
  const p = (env.INFLUX_PORT || env.INFLUX_QUERY_PORT || '').trim();
  if (p && !u.port) {
    u.port = p;
  }
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
}

/**
 * @returns {string}
 */
function buildInfluxV3Origin() {
  return mergePortIntoOrigin(env.INFLUX_HOST || '');
}

/** @type {{ origin: string, token: string, database: string, timeoutMs: number } | null} */
let influxV3ConfigCache = null;

/**
 * InfluxDB v3 config (HTTP SQL API). No INFLUX_BUCKET — database name only.
 * @returns {{ origin: string, token: string, database: string, timeoutMs: number }}
 */
function getInfluxV3Config() {
  if (influxV3ConfigCache) {
    return influxV3ConfigCache;
  }

  const token = normalizeInfluxToken(env.INFLUX_TOKEN);
  const database = env.INFLUX_DATABASE;
  const influxHost = env.INFLUX_HOST;

  debug(`[influxdb_utils_v3] Environment check: INFLUX_HOST=${influxHost ? 'SET' : 'NOT SET'}, INFLUX_TOKEN=${token ? 'SET' : 'NOT SET'}, INFLUX_DATABASE=${database ? 'SET' : 'NOT SET'}, INFLUX_PORT=${env.INFLUX_PORT ? 'SET' : 'NOT SET'}`);
  if (!token || !influxHost || !database) {
    warn('[influxdb_utils_v3] Missing InfluxDB v3 config: INFLUX_HOST, INFLUX_TOKEN, INFLUX_DATABASE required');
  }

  if (!token) {
    throw new Error('INFLUX_TOKEN environment variable is not set');
  }
  if (!influxHost) {
    throw new Error('INFLUX_HOST environment variable is not set');
  }
  if (!database) {
    throw new Error('INFLUX_DATABASE environment variable is not set');
  }

  const origin = buildInfluxV3Origin();
  const timeoutMs = parseInt(env.INFLUX_TIMEOUT_MS || '120000', 10);

  log(`[influxdb_utils_v3] InfluxDB v3 SQL: origin=${origin}, db=${database}, timeout=${timeoutMs}ms`);

  influxV3ConfigCache = { origin, token, database, timeoutMs };
  return influxV3ConfigCache;
}

/**
 * @returns {{ origin: string, token: string, database: string, timeoutMs: number }}
 */
function getInfluxV3Client() {
  return getInfluxV3Config();
}

/**
 * @param {string} s
 * @returns {string}
 */
function sqlStringLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * @param {string} name
 * @returns {string}
 */
function sqlQuoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** IOx wide table uses quoted identifiers (e.g. "BoatId"), not Influx 2 tag names (boat). */
function ioxSqlBoatColumnName() {
  return (process.env.INFLUX_V3_SQL_COL_BOAT || 'BoatId').trim();
}

function ioxSqlBoatLiteralForFilter(sourceBoat) {
  const o = (process.env.INFLUX_V3_SQL_BOAT_LITERAL || '').trim();
  return o || String(sourceBoat).trim();
}

/**
 * @param {string} boatColQuoted
 * @param {string} boatForSql
 * @returns {string}
 */
function ioxSqlBoatPredicateSql(boatColQuoted, boatForSql) {
  const lit = sqlStringLiteral(boatForSql);
  const ci = ['1', 'true', 'yes', 'on'].includes((process.env.INFLUX_V3_SQL_BOAT_CI || '').trim().toLowerCase());
  if (ci) {
    return `LOWER(TRIM(CAST(${boatColQuoted} AS VARCHAR))) = LOWER(TRIM(${lit}))`;
  }
  return `${boatColQuoted} = ${lit}`;
}

/**
 * IOx column for strm/log filter; null = omit (wide universalized_logs often has no level column).
 * Set INFLUX_V3_SQL_COL_LEVEL=level (or real column name) when the table has that field.
 * @returns {string | null}
 */
function ioxSqlLevelColumnNameOrNull() {
  const raw = process.env.INFLUX_V3_SQL_COL_LEVEL;
  if (raw === undefined || raw === null) {
    return null;
  }
  const s = String(raw).trim();
  if (s === '' || ['none', '-', 'omit', 'false', '0'].includes(s.toLowerCase())) {
    return null;
  }
  return s;
}

/**
 * Boat (+ optional level) predicate without leading AND.
 * @param {string} boat
 * @param {string} level
 * @returns {string}
 */
function ioxSqlBoatLevelPredicateExpr(boat, level) {
  const b = sqlQuoteIdent(ioxSqlBoatColumnName());
  const boatLit = ioxSqlBoatLiteralForFilter(boat);
  let line = ioxSqlBoatPredicateSql(b, boatLit);
  const lc = ioxSqlLevelColumnNameOrNull();
  if (lc !== null) {
    line += ` AND ${sqlQuoteIdent(lc)} = ${sqlStringLiteral(level)}`;
  }
  return line;
}

/**
 * @param {string} boat
 * @param {string} level
 * @returns {string}
 */
function ioxSqlBoatLevelWhereClause(boat, level) {
  return `  AND ${ioxSqlBoatLevelPredicateExpr(boat, level)}\n`;
}

/**
 * Optional Day (or configured column) equality without leading AND.
 * @param {string} formattedDate YYYY-MM-DD
 * @returns {string}
 */
function ioxSqlDayPredicateExpr(formattedDate) {
  const col = (env.INFLUX_V3_SQL_COL_DAY || '').trim();
  if (!col) return '';
  let val = (env.INFLUX_V3_SQL_DAY_VALUE || '').trim();
  if (!val) {
    const fmt = (env.INFLUX_V3_SQL_DAY_FORMAT || 'iso').trim().toLowerCase();
    val = fmt === 'compact' ? formattedDate.replace(/-/g, '') : formattedDate;
  }
  const asInt = ['1', 'true', 'yes', 'on'].includes((env.INFLUX_V3_SQL_DAY_AS_INTEGER || '').trim().toLowerCase());
  if (asInt) {
    const n = parseInt(String(val).replace(/-/g, ''), 10);
    if (!isNaN(n)) {
      return `${sqlQuoteIdent(col)} = ${n}`;
    }
  }
  return `${sqlQuoteIdent(col)} = ${sqlStringLiteral(val)}`;
}

/** @type {string | null} */
let ioxSqlWhereOrderLogged = null;

/**
 * Multiline WHERE for IOx channel queries. Matches Python ``INFLUX_V3_SQL_WHERE_ORDER``.
 * @param {string} timeRangeSql e.g. time >= '...' AND time <= '...'
 * @param {string} formattedDate
 * @param {string} boat
 * @param {string} level
 * @returns {string}
 */
function ioxSqlWhereBlock(timeRangeSql, formattedDate, boat, level) {
  const primary = (env.INFLUX_V3_SQL_WHERE_ORDER || '').trim().toLowerCase();
  const alias = (env.INFLUX_V3_SQL_FILTER_ORDER || '').trim().toLowerCase();
  let rawOrder;
  if (primary) {
    rawOrder = primary;
  } else if (alias === 'boat_day_time' || alias === 'boat_first') {
    rawOrder = 'boat_day_time';
  } else if (alias === 'day_boat_time') {
    rawOrder = 'day_boat_time';
  } else if (alias === 'time_day_boat' || alias === 'standard' || alias === '') {
    rawOrder = 'time_day_boat';
  } else {
    rawOrder = alias;
  }
  const t = timeRangeSql.trim();
  const dayEx = ioxSqlDayPredicateExpr(formattedDate);
  const boatEx = ioxSqlBoatLevelPredicateExpr(boat, level);
  /** @type {string[]} */
  let parts;
  if (rawOrder === 'boat_day_time' || rawOrder === 'boat_first') {
    parts = [boatEx, dayEx, t].filter(Boolean);
  } else if (rawOrder === 'day_boat_time') {
    parts = [dayEx, boatEx, t].filter(Boolean);
  } else {
    if (!['time_day_boat', 'standard', 'time_first', ''].includes(rawOrder)) {
      warn(`[influxdb_utils_v3] Unknown INFLUX_V3_SQL_WHERE_ORDER=${rawOrder}; using time_day_boat`);
    }
    parts = [t, dayEx, boatEx].filter(Boolean);
  }
  if (parts.length === 0) {
    return 'WHERE 1=1\n';
  }
  const defaultOrders = new Set(['time_day_boat', 'standard', 'time_first', '']);
  if (!defaultOrders.has(rawOrder) && ioxSqlWhereOrderLogged !== rawOrder) {
    ioxSqlWhereOrderLogged = rawOrder;
    log(`[influxdb_utils_v3] WHERE predicate order: ${rawOrder} (planner may still reorder)`);
  }
  const lines = [`WHERE ${parts[0]}`];
  for (let i = 1; i < parts.length; i++) {
    lines.push(`  AND ${parts[i]}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Optional partition-style filter on a calendar column (e.g. Day). Matches Python api_utils INFLUX_V3_SQL_COL_DAY.
 * @param {string} formattedDate YYYY-MM-DD
 * @returns {string}
 */
function ioxSqlDayPredicate(formattedDate) {
  const ex = ioxSqlDayPredicateExpr(formattedDate);
  return ex ? `  AND ${ex}\n` : '';
}

/**
 * Lowercase names to exclude from channel discovery (time + boat/level aliases).
 * @returns {string}
 */
function ioxSchemaMetaLowerNotInList() {
  const boat = ioxSqlBoatColumnName().toLowerCase();
  const lc = ioxSqlLevelColumnNameOrNull();
  const parts = ['time', 'boat', 'level', boat];
  const dayCol = (env.INFLUX_V3_SQL_COL_DAY || '').trim();
  if (dayCol) {
    parts.push(dayCol.toLowerCase());
  }
  if (lc !== null) {
    parts.push(lc.toLowerCase());
  }
  const uniq = [...new Set(parts)];
  return uniq.map((c) => sqlStringLiteral(c)).join(', ');
}

/**
 * Build SQL time filter for a chunk aligned with v2 Flux ranges (exclusive end on UTC hour boundaries except final chunk).
 * @param {number} startSec
 * @param {number} endSec
 * @param {number} overallEndSec
 * @returns {string}
 */
function sqlTimeChunkPredicate(startSec, endSec, overallEndSec) {
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date(endSec * 1000).toISOString();
  const endDate = new Date(endSec * 1000);
  const onUtcHourBoundary =
    endDate.getUTCMinutes() === 0 &&
    endDate.getUTCSeconds() === 0 &&
    endDate.getUTCMilliseconds() === 0;
  const useExclusive = onUtcHourBoundary && endSec < overallEndSec;
  if (useExclusive) {
    return `time >= ${sqlStringLiteral(startIso)} AND time < ${sqlStringLiteral(endIso)}`;
  }
  return `time >= ${sqlStringLiteral(startIso)} AND time <= ${sqlStringLiteral(endIso)}`;
}

/**
 * @param {string[]} measurementBatch
 * @returns {string}
 */
function buildSelectColumnsForMeasurements(measurementBatch) {
  const parts = ['time'];
  for (const m of measurementBatch) {
    parts.push(sqlQuoteIdent(m));
  }
  return parts.join(', ');
}

/**
 * @param {string} body
 * @returns {Array<Record<string, unknown>>}
 */
function parseJsonlResponse(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length === 0) {
    return [];
  }
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      if (out.length === 0 && line.trim().startsWith('{')) {
        const obj = JSON.parse(line);
        const msg = obj.error || obj.message || obj.detail || line;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      throw e;
    }
  }
  return out;
}

/**
 * POST /api/v3/query_sql (jsonl)
 * @param {string} origin
 * @param {string} token
 * @param {string} payload JSON body
 * @param {number} timeoutMs
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
function httpPostQuerySql(origin, token, payload, timeoutMs) {
  const url = new URL(`${origin}/api/v3/query_sql`);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error(`InfluxDB v3 query_sql HTTP ${res.statusCode}: ${buf.slice(0, 800)}`);
            err.statusCode = res.statusCode;
            err.statusMessage = res.statusMessage;
            reject(err);
            return;
          }
          try {
            const rows = parseJsonlResponse(buf);
            resolve(rows);
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`InfluxDB v3 query timeout after ${timeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Execute SQL against InfluxDB v3 and return rows as objects (jsonl).
 * @param {string} sql
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function queryInfluxV3(sql) {
  const { origin, token, database, timeoutMs } = getInfluxV3Config();
  const payload = JSON.stringify({ db: database, q: sql, format: 'jsonl' });
  const rows = await httpPostQuerySql(origin, token, payload, timeoutMs);
  debug(`[influxdb_utils_v3] SQL query completed. Total rows: ${rows.length}`);
  if (isVerboseEnabled() && rows.length > 0) {
    debug(`[influxdb_utils_v3] First row keys: ${Object.keys(rows[0]).join(', ')}`);
  }
  return rows;
}

/**
 * Check InfluxDB health using HTTP /health endpoint first (fastest), falls back to minimal query if needed
 * @param {string} baseUrl - InfluxDB base URL
 * @returns {Promise<boolean>} True if healthy, throws error if not
 */
async function checkInfluxDBHealth(baseUrl) {
  const influxUrl = mergePortIntoOrigin(baseUrl || env.INFLUX_HOST || '');

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
 * Fallback health check using minimal SQL (if /health endpoint unavailable)
 * @param {string} baseUrl - InfluxDB base URL
 * @returns {Promise<boolean>} True if healthy, throws error if not
 */
async function checkInfluxDBHealthWithQuery(baseUrl) {
  const token = normalizeInfluxToken(env.INFLUX_TOKEN);
  const database = env.INFLUX_DATABASE;
  if (!token || !database) {
    throw new Error('InfluxDB environment variables not set (INFLUX_TOKEN, INFLUX_DATABASE)');
  }
  const origin = mergePortIntoOrigin(baseUrl || env.INFLUX_HOST || '');
  const payload = JSON.stringify({ db: database, q: 'SELECT 1', format: 'jsonl' });
  await httpPostQuerySql(origin, token, payload, 2000);
  return true;
}

/**
 * Get list of unique boats (sources) from InfluxDB for a given date
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} level - Data level filter ('strm' or 'log'). Defaults to 'strm'
 * @returns {Promise<Array<string>>} Array of boat names
 */
async function getSourcesFromInfluxDB(date, level = 'strm') {
  const dateStr = String(date);
  if (dateStr.length !== 8 || !/^\d+$/.test(dateStr)) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYYMMDD format.`);
  }
  const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;

  const startTime = `${formattedDate}T00:00:00Z`;
  const stopTime = `${formattedDate}T23:59:59Z`;

  const boatCol = ioxSqlBoatColumnName();
  const levelCol = ioxSqlLevelColumnNameOrNull();
  let whereTime = `time >= ${sqlStringLiteral(startTime)} AND time <= ${sqlStringLiteral(stopTime)}`;
  if (levelCol !== null) {
    whereTime += ` AND ${sqlQuoteIdent(levelCol)} = ${sqlStringLiteral(level)}`;
  }
  const sql = `SELECT DISTINCT ${sqlQuoteIdent(boatCol)} FROM ${IOX_TABLE}
WHERE ${whereTime}
ORDER BY ${sqlQuoteIdent(boatCol)}`;

  try {
    const results = await queryInfluxV3(sql);
    const boats = [...new Set(results.map((r) => r[boatCol]).filter(Boolean))];
    return boats.sort();
  } catch (err) {
    error('[influxdb_utils_v3] Error getting sources from InfluxDB:', err);
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
    
    log('[influxdb_utils_v3] InfluxDB channels metadata table ensured');
  } catch (err) {
    error('[influxdb_utils_v3] Error ensuring metadata table:', err);
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
      debug(`[influxdb_utils_v3] Found ${cachedChannels.length} cached channels for ${sourceName}/${dateStr}/${level}`);
      return cachedChannels;
    }
    
    return null;
  } catch (err) {
    error('[influxdb_utils_v3] Error getting cached channels:', err);
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
    log(`[influxdb_utils_v3] Cached ${channels.length} channels for ${sourceName}/${dateStr}/${level}`);
  } catch (err) {
    error('[influxdb_utils_v3] Error caching channels:', err);
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
        debug('[influxdb_utils_v3] Health check passed before querying channels');
      }
    } catch (err) {
      error('[influxdb_utils_v3] Health check failed before querying channels:', err.message);
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
      log(`[influxdb_utils_v3] Using cached channels (${cachedChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
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
          log(`[influxdb_utils_v3] Using stale cached channels (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level} - skipping InfluxDB query since channels don't change`);
          return staleChannels;
        }
      }
    } catch (cacheErr) {
      debug('[influxdb_utils_v3] Could not check for stale cache:', cacheErr.message);
    }
  } else {
    log(`[influxdb_utils_v3] skipCache=true: bypassing cache and querying InfluxDB for fresh channel list`);
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
    debug('[influxdb_utils_v3] Could not load stale cache for error fallback:', cacheErr.message);
  }

  // No cache (or skipCache) - query InfluxDB v3 for channel columns
  try {
    // Wide table: channel names are columns on iox.universalized_logs (see plan / information_schema).
    log(`[influxdb_utils_v3] Querying InfluxDB v3 for channels (information_schema.universalized_logs)`);
    const schemaSql = `SELECT column_name FROM information_schema.columns WHERE table_schema = 'iox' AND table_name = 'universalized_logs' AND LOWER(column_name) NOT IN (${ioxSchemaMetaLowerNotInList()}) ORDER BY column_name`;

    const queryStartTime = Date.now();
    debug(`[influxdb_utils_v3] SQL: ${schemaSql}`);
    const results = await queryInfluxV3(schemaSql);
    const queryDuration = Date.now() - queryStartTime;
    log(`[influxdb_utils_v3] Channel schema query completed in ${queryDuration}ms, returned ${results.length} rows`);

    let measurements = [...new Set(results.map((r) => r.column_name).filter(Boolean))];
    if (measurements.length === 0) {
      warn(`[influxdb_utils_v3] No channels found for ${sourceName}/${dateStr}/${level}. Possible reasons: no data in InfluxDB, wrong boat name, or wrong level.`);
    }

    const sortedChannels = measurements.sort();
    
    log(`[influxdb_utils_v3] Extracted ${sortedChannels.length} unique channels: ${sortedChannels.slice(0, 10).join(', ')}${sortedChannels.length > 10 ? '...' : ''}`);
    
    // Cache the results for future use (channels don't change, so cache indefinitely)
    await cacheChannels(date, sourceName, level, sortedChannels);
    log(`[influxdb_utils_v3] Successfully cached ${sortedChannels.length} channels for ${sourceName}/${dateStr}/${level}`);
    
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
            log(`[influxdb_utils_v3] Fallback: Retrieved stale cache from database (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
          }
        }
      } catch (cacheErr) {
        debug('[influxdb_utils_v3] Could not retrieve stale cache on error:', cacheErr.message);
      }
    }
    
    // If we have stale cache, return it (for any error, not just timeout)
    if (staleChannels && staleChannels.length > 0) {
      if (isTimeout) {
        log(`[influxdb_utils_v3] InfluxDB gateway timeout (504) - returning stale cached channels (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
      } else {
        warn(`[influxdb_utils_v3] InfluxDB query failed - returning stale cached channels (${staleChannels.length} channels) for ${sourceName}/${dateStr}/${level}`);
      }
      return staleChannels;
    }
    
    // No cache available and InfluxDB failed
    if (isTimeout) {
      warn(`[influxdb_utils_v3] InfluxDB gateway timeout (504) and no cache available for ${sourceName}/${dateStr}/${level}`);
      warn(`[influxdb_utils_v3] Cache needs to be populated when InfluxDB is available. This is expected on first query.`);
    }
    
    error('[influxdb_utils_v3] Error getting channels from InfluxDB:', err);
    error('[influxdb_utils_v3] Error details:', {
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
  log(`[influxdb_utils_v3] getChannelsFromInfluxDBBothLevels: strm=${(strmChannels || []).length}, log=${(logChannels || []).length}, merged=${sorted.length}`);
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
        debug('[influxdb_utils_v3] Health check passed before querying channel values');
      }
    } catch (err) {
      error('[influxdb_utils_v3] Health check failed before querying channel values:', err.message);
      throw new Error(`InfluxDB health check failed: ${err.message}`);
    }
  }

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
    warn('[influxdb_utils_v3] No data measurements to query (only ts/Datetime in channel_list) - returning empty; Influx tier parquet will NOT be written', {
      channel_list_names: channelList.map(ch => typeof ch === 'string' ? ch : (ch && (ch.name || ch.channel))),
      channel_count: channelList.length
    });
    return [];
  }

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
    log(`[influxdb_utils_v3] Large number of measurements (${measurements.length}) exceeds threshold (${MEASUREMENT_CHUNK_THRESHOLD}). Will chunk by measurements.`);
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
      log(`[influxdb_utils_v3] Time range ${timeRange}s (${(timeRange/60).toFixed(1)} minutes) exceeds ${CHUNK_THRESHOLD_SECONDS}s threshold. Splitting into 1-hour chunks aligned to hour boundaries.`);
    }
  } else {
    // Full day query - always chunk to avoid timeouts
    useChunking = true;
    // Will set chunkStartTs and chunkEndTs below when we have the date
    log(`[influxdb_utils_v3] Full day query detected. Will chunk into 1-hour segments to avoid timeouts.`);
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
        log(`[influxdb_utils_v3] Using local date range: ${formattedDate} in ${timezone} -> UTC timestamps ${chunkStartTs} to ${chunkEndTs}`);
      } catch (tzErr) {
        warn(`[influxdb_utils_v3] Could not parse timezone '${timezone}' for local date range, using UTC date:`, tzErr.message);
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
      let batchRaw = parseInt(env.INFLUX_V3_MEASUREMENT_BATCH_SIZE || '30', 10);
      if (isNaN(batchRaw)) batchRaw = 30;
      const BATCH_SIZE = Math.max(5, Math.min(200, batchRaw));
      for (let i = 0; i < measurements.length; i += BATCH_SIZE) {
        measurementBatches.push(measurements.slice(i, i + BATCH_SIZE));
      }
      log(`[influxdb_utils_v3] Split ${measurements.length} measurements into ${measurementBatches.length} batches of ~${BATCH_SIZE} each`);
    } else {
      // Single batch with all measurements
      measurementBatches = [measurements];
    }
    
    // If not time-chunking, create a single time range
    const timeRanges = [];
    if (useChunking && chunkStartTs !== null && chunkEndTs !== null) {
      const timeChunkSec = parseInt(env.INFLUX_V3_TIME_CHUNK_SECONDS || '0', 10) || 0;
      if (timeChunkSec > 0) {
        let cur = chunkStartTs;
        while (cur < chunkEndTs) {
          const nxt = Math.min(cur + timeChunkSec, chunkEndTs);
          timeRanges.push({ start: cur, end: nxt });
          cur = nxt;
        }
        log(`[influxdb_utils_v3] Time chunking: ${timeRanges.length} segment(s) of ~${timeChunkSec}s (INFLUX_V3_TIME_CHUNK_SECONDS)`);
      } else {
        let currentStart = chunkStartTs;
        while (currentStart < chunkEndTs) {
          const currentDate = new Date(currentStart * 1000);
          let currentEnd;

          if (currentDate.getMinutes() !== 0 || currentDate.getSeconds() !== 0 || currentDate.getMilliseconds() !== 0) {
            const nextHour = new Date(currentDate);
            nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
            currentEnd = Math.min(nextHour.getTime() / 1000, chunkEndTs);
          } else {
            const nextHour = new Date(currentDate);
            nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
            currentEnd = Math.min(nextHour.getTime() / 1000, chunkEndTs);
          }

          timeRanges.push({ start: currentStart, end: currentEnd });
          currentStart = currentEnd;
        }
        log(`[influxdb_utils_v3] Time chunking: ${timeRanges.length} hour-aligned segment(s)`);
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
    log(`[influxdb_utils_v3] Executing ${chunkJobs.length} chunk queries with concurrency ${chunkConcurrency}`);

    async function runOneChunkJob(job) {
      const { timeRange, measurementBatch } = job;
      const chunkStartDate = new Date(timeRange.start * 1000);
      const chunkEndDate = new Date(timeRange.end * 1000);
      const chunkStartTime = chunkStartDate.toISOString();
      const chunkStopTime = chunkEndDate.toISOString();
      const windowEndSec =
        chunkEndTs != null && chunkEndTs !== undefined
          ? chunkEndTs
          : startTs !== null &&
              startTs !== undefined &&
              endTs !== null &&
              endTs !== undefined
            ? Number(endTs)
            : Math.floor(new Date(`${formattedDate}T23:59:59Z`).getTime() / 1000);
      const timePred = sqlTimeChunkPredicate(timeRange.start, timeRange.end, windowEndSec);
      const cols = buildSelectColumnsForMeasurements(measurementBatch);
      const whereBlk = ioxSqlWhereBlock(timePred, formattedDate, boat, level);
      const chunkSql = `SELECT ${cols} FROM ${IOX_TABLE}
${whereBlk}ORDER BY time
LIMIT ${queryLimit}`;
      debug(`[influxdb_utils_v3] Chunk SQL: ${chunkStartTime} to ${chunkStopTime}, measurements=${measurementBatch.length}`);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const rows = await queryInfluxV3(chunkSql);
          return Array.isArray(rows) ? rows : [];
        } catch (err) {
          const is504 = err.statusCode === 504 ||
              (err.message && (err.message.includes('504') || err.message.includes('Gateway Time-out')));
          if (is504 && attempt === 1) {
            warn(`[influxdb_utils_v3] Gateway timeout (504) for chunk ${chunkStartTime} to ${chunkStopTime}, measurements=${measurementBatch.length}; retrying once in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          if (is504) {
            warn(`[influxdb_utils_v3] Gateway timeout (504) for chunk ${chunkStartTime} to ${chunkStopTime} after retry. Reduce INFLUX_CHUNK_CONCURRENCY or time range if this persists.`);
          }
          error(`[influxdb_utils_v3] Chunk query failed for ${chunkStartTime} to ${chunkStopTime}, measurements=${measurementBatch.length}:`, err);
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
      warn(`[influxdb_utils_v3] ${truncatedChunks.length} chunk(s) hit row limit (${queryLimit}); result may be truncated. Narrow time range or reduce channels.`);
    }
    // Warn when some chunks returned no data (empty series vs errors: failures also log in runOneChunkJob)
    const emptyChunkCount = chunkResults.filter(r => !r || r.length === 0).length;
    if (emptyChunkCount > 0) {
      const allEmpty = emptyChunkCount === chunkResults.length;
      const ctx = {
        boat,
        date: formattedDate,
        level,
        database: influxDatabase,
        emptyChunks: emptyChunkCount,
        totalChunks: chunkResults.length,
      };
      if (allEmpty) {
        warn(
          `[influxdb_utils_v3] All ${chunkResults.length} Influx v3 chunk(s) returned no rows (boat=${boat}, date=${formattedDate}, level=${level}, db=${influxDatabase}). ` +
            'Common causes: no data for this boat/day/level, boat mismatch vs normalization, wrong INFLUX_DATABASE, empty iox.universalized_logs, or retention. ' +
            'If chunk queries failed, see earlier [influxdb_utils_v3] error lines (504/timeouts).',
          ctx
        );
      } else {
        warn(
          `[influxdb_utils_v3] ${emptyChunkCount} of ${chunkResults.length} chunk(s) returned no data; merged result may be partial. Check timeouts/Influx errors above or sparse data in some hours.`,
          ctx
        );
      }
    }
    
    // Merge all chunk results
    rawResults = chunkResults.flat();
    
    // Remove duplicates that might occur at chunk boundaries (based on time / _time or ts)
    const seenTimestamps = new Set();
    rawResults = rawResults.filter(record => {
      const timestamp = record.time || record._time || record.ts;
      if (timestamp) {
        const tsKey = typeof timestamp === 'string' ? timestamp : timestamp.toString();
        if (seenTimestamps.has(tsKey)) {
          return false;
        }
        seenTimestamps.add(tsKey);
      }
      return true;
    });
    
    log(`[influxdb_utils_v3] Merged ${chunkResults.length} chunks into ${rawResults.length} total rows`);
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
      
      log(`[influxdb_utils_v3] Using timestamp range: ${startTsNum} to ${endTsNum} (${startTime} to ${stopTime})`);
    } else {
      // Use full day based on date
      startTime = `${formattedDate}T00:00:00Z`;
      stopTime = `${formattedDate}T23:59:59Z`;
      log(`[influxdb_utils_v3] Using full day range: ${startTime} to ${stopTime}`);
    }
    
    const cols = buildSelectColumnsForMeasurements(measurements);
    const timeRng = `time >= ${sqlStringLiteral(startTime)} AND time <= ${sqlStringLiteral(stopTime)}`;
    const whereBlk = ioxSqlWhereBlock(timeRng, formattedDate, boat, level);
    const sqlQuery = `SELECT ${cols} FROM ${IOX_TABLE}
${whereBlk}ORDER BY time
LIMIT ${queryLimit}`;

    log(`[influxdb_utils_v3] Executing SQL: db=${influxDatabase}, boat=${boat}, date=${formattedDate}, level=${level}, measurements=${measurements.length}, time_range=${startTime} to ${stopTime}`);
    debug(`[influxdb_utils_v3] SQL: ${sqlQuery}`);

    try {
      rawResults = await queryInfluxV3(sqlQuery);
    } catch (err) {
      // Check if it's a 504 Gateway Timeout
      const isTimeout = err.statusCode === 504 || 
                      (err.message && err.message.includes('504')) ||
                      (err.message && err.message.includes('Gateway Time-out')) ||
                      (err.message && err.message.includes('timeout'));
      
      if (isTimeout) {
        warn(`[influxdb_utils_v3] Gateway timeout (504) detected. Query may be too large. Consider using smaller time ranges or fewer measurements.`);
        warn(`[influxdb_utils_v3] Query parameters: measurements=${measurements.length}, time_range=${startTime} to ${stopTime}`);
      }
      error('[influxdb_utils_v3] InfluxDB query error:', err);
      throw err;
    }
    if (rawResults && rawResults.length >= queryLimit) {
      warn(`[influxdb_utils_v3] Single query hit row limit (${queryLimit}); result may be truncated. Narrow time range or reduce channels.`);
    }
  }
  
  try {
    if (!rawResults || rawResults.length === 0) {
      log(`[influxdb_utils_v3] No data returned from InfluxDB query for boat=${boat}, level=${level}, date=${formattedDate}, measurements=${measurements.join(', ')}`);
      return [];
    }
    
    log(`[influxdb_utils_v3] Retrieved ${rawResults.length} raw rows from InfluxDB`);

    const metaBoatCol = ioxSqlBoatColumnName();
    const metaLevelCol = ioxSqlLevelColumnNameOrNull();
    
    // Debug: Check for binary data before processing
    let binaryFieldsFound = new Set();
    rawResults.forEach((record, idx) => {
      Object.keys(record).forEach(key => {
        const value = record[key];
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
          binaryFieldsFound.add(key);
          if (idx < 3) {
            warn(`[influxdb_utils_v3] Raw result[${idx}][${key}] is binary: ${Buffer.isBuffer(value) ? 'Buffer' : 'Uint8Array'}, length: ${value.length}`);
          }
        }
      });
    });
    if (binaryFieldsFound.size > 0) {
      warn(`[influxdb_utils_v3] WARNING: Found binary data in fields: ${Array.from(binaryFieldsFound).join(', ')}. Attempting conversion...`);
    }
    
    // Convert _time to ts (Unix timestamp in seconds)
    const results = rawResults.map((record, idx) => {
      const result = { ...record };
      
      // Debug first few records
      if (idx < 3) {
        debug(`[influxdb_utils_v3] Processing raw result[${idx}]: keys=${Object.keys(result).join(', ')}`);
      }
      
      // Convert any binary/buffer values to strings or numbers if possible
      Object.keys(result).forEach(key => {
        const value = result[key];
        if (Buffer.isBuffer(value)) {
          // Try to convert buffer to string
          try {
            const strValue = value.toString('utf8');
            debug(`[influxdb_utils_v3] Converted Buffer[${key}] to string: "${strValue.substring(0, 50)}"`);
            result[key] = strValue;
          } catch (err) {
            warn(`[influxdb_utils_v3] Failed to convert Buffer[${key}] to string: ${err.message}`);
            // Try to convert to number if it's a numeric buffer
            try {
              const numValue = parseFloat(value.toString('utf8'));
              if (!isNaN(numValue)) {
                result[key] = numValue;
                debug(`[influxdb_utils_v3] Converted Buffer[${key}] to number: ${numValue}`);
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
            debug(`[influxdb_utils_v3] Converted Uint8Array[${key}] to string: "${strValue.substring(0, 50)}"`);
            result[key] = strValue;
          } catch (err) {
            warn(`[influxdb_utils_v3] Failed to convert Uint8Array[${key}]: ${err.message}`);
            result[key] = null;
          }
        }
      });
      
      // Apply GPS coordinate conversion (divide by 10^7) ONLY for specific channels
      // Only convert LATITUDE_GPS_unk and LONGITUDE_GPS_unk - all other channels should remain unchanged
      Object.keys(result).forEach(key => {
        // Skip metadata fields
        if (
          key === '_time' ||
          key === 'time' ||
          key === 'ts' ||
          key === 'result' ||
          key === 'table' ||
          key === 'boat' ||
          key === 'level' ||
          key === 'BoatId' ||
          key === 'Level' ||
          key === metaBoatCol ||
          (metaLevelCol !== null && key === metaLevelCol)
        ) {
          return;
        }
        
        const value = result[key];
        
        // Only convert these specific channel names
        const shouldConvert = key === 'LATITUDE_GPS_unk' || key === 'LONGITUDE_GPS_unk';
        
        if (shouldConvert && typeof value === 'number' && value !== null && !isNaN(value)) {
          const convertedValue = value / 10000000; // Move decimal 7 places to the left
          if (idx < 3) {
            debug(`[influxdb_utils_v3] Converting GPS coordinate ${key}: ${value} -> ${convertedValue} (divided by 10^7)`);
          }
          result[key] = convertedValue;
        }
      });
      
      const timeRaw = result.time || result._time;
      if (timeRaw) {
        const date = new Date(timeRaw);
        result.ts = Math.round(date.getTime() / 1000 * 1000) / 1000; // Round to 3 decimals
        delete result.time;
        delete result._time;
      }
      
      if (idx < 3) {
        debug(`[influxdb_utils_v3] Processed result[${idx}]: keys=${Object.keys(result).join(', ')}, sample values: ${JSON.stringify(Object.fromEntries(Object.entries(result).slice(0, 3)))}`);
      }
      
      return result;
    });
    
    // Dataset size check
    if (results.length > 10000000) {
      error(`[influxdb_utils_v3] Large dataset detected: ${results.length} rows. May cause memory issues.`);
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
    error('[influxdb_utils_v3] Error getting channel values from InfluxDB:', err);
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
    log(`[influxdb_utils_v3] getChannelValuesFromInfluxDBWithFallback: all ${measurementNames.length} channels had data in strm`);
    return strmResult;
  }
  log(`[influxdb_utils_v3] getChannelValuesFromInfluxDBWithFallback: ${channelsWithNoDataInStrm.length} channels had no data in strm, querying log: ${channelsWithNoDataInStrm.slice(0, 5).join(', ')}${channelsWithNoDataInStrm.length > 5 ? '...' : ''}`);
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
 * Influx backfill parquet basename aligned with channel-values API resolution (one file per tier).
 * @param {string|null|undefined} resolution - API body: null = RAW, '100ms' = 10 Hz, else 1 Hz (incl. undefined)
 * @returns {string} e.g. influx_data_raw.parquet, influx_data_10hz.parquet, influx_data_1hz.parquet
 */
function influxParquetBasenameFromApiResolution(resolution) {
  if (resolution === null) return 'influx_data_raw.parquet';
  if (typeof resolution === 'string' && resolution.trim().toLowerCase() === '100ms') {
    return 'influx_data_10hz.parquet';
  }
  return 'influx_data_1hz.parquet';
}

const INFLUX_TIER_PARQUET_BASENAMES_LOWER = new Set([
  'influx_data.parquet',
  'influx_data_raw.parquet',
  'influx_data_10hz.parquet',
  'influx_data_1hz.parquet',
]);

function isInfluxTierParquetBasename(name) {
  return INFLUX_TIER_PARQUET_BASENAMES_LOWER.has(String(name || '').toLowerCase());
}

/**
 * Save InfluxDB data to parquet file (tier-specific filename).
 * Each tier merges only with the same file (no cross-resolution overwrite).
 *
 * @param {Array} data - Array of data objects from InfluxDB query
 * @param {string} projectId - Project ID
 * @param {string} className - Class name (will be lowercased)
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} sourceName - Source name
 * @param {string|null|undefined} apiResolution - channel-values resolution: null RAW, '100ms', else 1 Hz
 * @returns {Promise<string>} Path to saved parquet file
 */
async function saveInfluxDataToParquet(data, projectId, className, date, sourceName, apiResolution) {
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
    
    const basename = influxParquetBasenameFromApiResolution(apiResolution);
    const filePath = path.join(
      env.DATA_DIRECTORY,
      'system',
      String(projectId),
      classLower,
      date,
      sourceName,
      basename
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

    // Influx tier parquet: only time-series columns (ts, Datetime, measurements).
    // Strip metadata columns so they are never written; metadata lives in other parquets and is merged at read time via DuckDB.
    // Config is not a timeseries channel and must not appear in Influx tier parquets.
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
  getInfluxV3Client,
  queryInfluxV3,
  checkInfluxDBHealth,
  checkInfluxDBHealthWithQuery,
  getSourcesFromInfluxDB,
  getChannelsFromInfluxDB,
  getChannelsFromInfluxDBBothLevels,
  getChannelValuesFromInfluxDB,
  getChannelValuesFromInfluxDBWithFallback,
  saveInfluxDataToParquet,
  influxParquetBasenameFromApiResolution,
  isInfluxTierParquetBasename,
};
