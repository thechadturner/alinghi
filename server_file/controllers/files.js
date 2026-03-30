const fs = require('fs');
const path = require('path');
const env = require('../middleware/config');
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse, getAuthToken } = require('../middleware/helpers');
const arrow = require('apache-arrow');
const { log, error, warn, debug } = require('../../shared');
const db = require('../../shared/database/connection'); 

const {
  groupChannelsByFilename
} = require('../middleware/files');

const {
  queryParquetFiles,
  convertToArrow,
  extractChannelsFromParquetFiles
} = require('../middleware/duckdb_utils');

const {
  getSourcesFromInfluxDB,
  getChannelsFromInfluxDB,
  getChannelsFromInfluxDBBothLevels,
  getChannelValuesFromInfluxDB,
  getChannelValuesFromInfluxDBWithFallback,
  checkInfluxDBHealth,
  saveInfluxDataToParquet,
  influxParquetBasenameFromApiResolution,
  isInfluxTierParquetBasename,
} = require('../middleware/influxdb_utils');

// Utility to safely join paths
const safeJoin = (...paths) => path.join(...paths);

/**
 * Resolve source directory with case-insensitive match so parquet is found
 * when frontend sends "GER" but disk has "ger" (or vice versa).
 * @param {string} parentDir - e.g. DATA_DIRECTORY/System/project_id/class_name/date
 * @param {string} sourceName - requested source name (e.g. "GER" or "ger")
 * @returns {string} Resolved path (exact match if exists, else case-insensitive match, else parentDir/sourceName)
 */
function resolveSourcePath(parentDir, sourceName) {
  const exactPath = safeJoin(parentDir, sourceName);
  if (fs.existsSync(exactPath)) {
    return exactPath;
  }
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const match = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === sourceName.toLowerCase()
    );
    if (match) {
      const resolved = safeJoin(parentDir, match.name);
      log(`[files] Resolved source path case-insensitively: ${sourceName} -> ${match.name} (${resolved})`);
      return resolved;
    }
  } catch (err) {
    debug('[files] resolveSourcePath: could not list parent dir', err.message);
  }
  return exactPath;
}

/**
 * Influx query resolution for unified backfill when API sends RAW (null): env INFLUX_BACKFILL_RAW_RESOLUTION or 100ms.
 */
function influxResolutionForChannelValuesBackfill(resolution) {
  if (resolution === null) {
    const raw = env.INFLUX_BACKFILL_RAW_RESOLUTION;
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '100ms';
  }
  if (typeof resolution === 'string' && resolution.trim() !== '') return resolution.trim();
  return '1s';
}

/**
 * DuckDB reads: all non-Influx parquets + Influx tier parquets for channel-values.
 * - When the tier matching API resolution exists: include it plus legacy influx_data.parquet if present
 *   (some boats only wrote certain channels to legacy; 1hz may exist but be sparse for those columns).
 * - When that tier file is missing: include every influx tier parquet on disk so data is still returned
 *   (e.g. only legacy, or only 1hz while API asked for 10hz — queryParquetFiles resamples to the request).
 * Merge order: API-matching tier first, then supplemental tiers by INFLUX_SUPPLEMENT_QUERY_ORDER so
 * later files fill nulls for the same ts (see duckdb_utils timestampMap merge).
 */
const INFLUX_SUPPLEMENT_QUERY_ORDER = {
  'influx_data_1hz.parquet': 10,
  'influx_data_10hz.parquet': 20,
  'influx_data.parquet': 30,
  'influx_data_raw.parquet': 40,
};

function listParquetPathsForDuckDbChannelValues(sourcePath, apiResolution) {
  if (!fs.existsSync(sourcePath)) return [];
  const all = fs.readdirSync(sourcePath).filter((f) => f.endsWith('.parquet'));
  const wantedBasename = influxParquetBasenameFromApiResolution(apiResolution);
  const wantedLower = wantedBasename.toLowerCase();
  const hasWantedFile = all.some((x) => x.toLowerCase() === wantedLower);

  const nonInflux = [];
  const influxTierNames = [];
  for (const f of all) {
    if (!isInfluxTierParquetBasename(f)) {
      nonInflux.push(safeJoin(sourcePath, f));
    } else {
      influxTierNames.push(f);
    }
  }

  const influxPaths = [];
  if (hasWantedFile) {
    const wantedName = influxTierNames.find((x) => x.toLowerCase() === wantedLower);
    if (wantedName) {
      influxPaths.push(safeJoin(sourcePath, wantedName));
    }
    const legacyName = influxTierNames.find((x) => x.toLowerCase() === 'influx_data.parquet');
    if (legacyName) {
      influxPaths.push(safeJoin(sourcePath, legacyName));
    }
  } else {
    for (const f of influxTierNames) {
      influxPaths.push(safeJoin(sourcePath, f));
    }
  }

  const seenBasename = new Set();
  const dedupedInflux = influxPaths.filter((p) => {
    const key = path.basename(p).toLowerCase();
    if (seenBasename.has(key)) return false;
    seenBasename.add(key);
    return true;
  });

  dedupedInflux.sort((a, b) => {
    const ba = path.basename(a).toLowerCase();
    const bb = path.basename(b).toLowerCase();
    const priA = ba === wantedLower ? -1 : 0;
    const priB = bb === wantedLower ? -1 : 0;
    if (priA !== priB) return priA - priB;
    const oa = INFLUX_SUPPLEMENT_QUERY_ORDER[ba] ?? 99;
    const ob = INFLUX_SUPPLEMENT_QUERY_ORDER[bb] ?? 99;
    return oa - ob;
  });

  return [...nonInflux, ...dedupedInflux];
}

// Helper function to get dataset_id from source_name, date, class_name, and project_id
// Date may be YYYYMMDD or YYYY-MM-DD (dataset date is stored in local time); try both so lookup works regardless of DB column type/format.
async function getDatasetIdFromSource(class_name, project_id, date, source_name) {
  if (!date || String(date).trim() === '') {
    return null;
  }
  try {
    const normalizedDate = String(date).replace(/[-/]/g, '');
    const sql = `SELECT a.dataset_id FROM ${class_name}.datasets a 
      INNER JOIN ${class_name}.sources b ON a.source_id = b.source_id 
      WHERE b.project_id = $1 AND b.source_name = $2 AND a.date = $3 
      ORDER BY a.dataset_id DESC LIMIT 1`;
    let params = [project_id, source_name, normalizedDate];
    let rows = await db.getRows(sql, params);
    if (rows && rows.length > 0) {
      return rows[0].dataset_id;
    }
    // If DB stores date as YYYY-MM-DD (e.g. TEXT or DATE returned as ISO), try that format
    if (normalizedDate.length === 8) {
      const dateWithDashes = `${normalizedDate.slice(0, 4)}-${normalizedDate.slice(4, 6)}-${normalizedDate.slice(6, 8)}`;
      params = [project_id, source_name, dateWithDashes];
      rows = await db.getRows(sql, params);
      if (rows && rows.length > 0) {
        return rows[0].dataset_id;
      }
    }
    return null;
  } catch (err) {
    error('[getDatasetIdFromSource] error:', err);
    return null;
  }
}

// Helper function to get dataset timezone
async function getDatasetTimezone(class_name, dataset_id) {
  try {
    const sql = `SELECT timezone FROM ${class_name}.datasets WHERE dataset_id = $1 LIMIT 1`;
    const params = [dataset_id];
    const rows = await db.getRows(sql, params);
    
    if (rows && rows.length > 0 && rows[0].timezone) {
      const timezone = String(rows[0].timezone).trim();
      if (timezone && timezone !== '' && timezone !== 'null' && timezone !== 'undefined') {
        return timezone;
      }
    }
    return null;
  } catch (err) {
    error('[getDatasetTimezone] error:', err);
    return null;
  }
}

// Helper function to get dataset date (local calendar date) for parquet folder path. Returns YYYYMMDD or null.
async function getDatasetDate(class_name, dataset_id) {
  if (!dataset_id) return null;
  try {
    const sql = `SELECT date FROM ${class_name}.datasets WHERE dataset_id = $1 LIMIT 1`;
    const params = [dataset_id];
    const rows = await db.getRows(sql, params);
    if (rows && rows.length > 0 && rows[0].date != null) {
      const d = rows[0].date;
      const str = typeof d === 'string' ? d : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
      const normalized = str.replace(/[-/]/g, '').slice(0, 8);
      if (normalized.length === 8 && /^\d{8}$/.test(normalized)) return normalized;
      return null;
    }
    return null;
  } catch (err) {
    error('[getDatasetDate] error:', err);
    return null;
  }
}

// Convert dataset local date (YYYYMMDD) + timezone to UTC date (YYYYMMDD). Influx expects UTC for full-day range (e.g. NZ 13 Feb local = 12 Feb UTC).
function localDateToUtcDate(localDateYyyyMmDd, timezone) {
  if (!localDateYyyyMmDd || String(localDateYyyyMmDd).length !== 8 || !/^\d{8}$/.test(String(localDateYyyyMmDd))) {
    return localDateYyyyMmDd;
  }
  if (!timezone || String(timezone).toUpperCase() === 'UTC') {
    return localDateYyyyMmDd;
  }
  try {
    const y = parseInt(localDateYyyyMmDd.slice(0, 4), 10);
    const m = parseInt(localDateYyyyMmDd.slice(4, 6), 10) - 1;
    const d = parseInt(localDateYyyyMmDd.slice(6, 8), 10);
    const utcMidnight = Date.UTC(y, m, d, 0, 0, 0);
    const inTz = new Date(utcMidnight).toLocaleString('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const match = inTz.match(/(\d{1,2})[:\s]*(\d{1,2})[:\s]*(\d{1,2})/);
    const hour = match ? parseInt(match[1], 10) : 0;
    const min = match ? parseInt(match[2], 10) : 0;
    const sec = match ? parseInt(match[3], 10) : 0;
    const offsetMs = (hour * 3600 + min * 60 + sec) * 1000;
    const localMidnightUtc = utcMidnight - offsetMs;
    const utcDate = new Date(localMidnightUtc);
    const uy = utcDate.getUTCFullYear();
    const um = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    const ud = String(utcDate.getUTCDate()).padStart(2, '0');
    return `${uy}${um}${ud}`;
  } catch (err) {
    warn('[localDateToUtcDate] error:', err.message, 'using local date');
    return localDateYyyyMmDd;
  }
}

// Normalize ts from parquet to a number (handles string/scientific e.g. "1.768623e+09")
function normalizeTs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return isNaN(value) ? null : value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  return null;
}

// Format datetime to match Racesight Python parquet: "2026-01-17 04:15:05.800000+00:00"
// timestamp: Unix seconds (number or string e.g. 1.768623e+09) or ms if >= 1e12
function formatDatetimeRacesight(timestamp) {
  try {
    const ts = normalizeTs(timestamp);
    if (ts === null) return null;
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const date = new Date(ms);
    if (isNaN(date.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const hours = date.getUTCHours();
    const mins = date.getUTCMinutes();
    const secs = date.getUTCSeconds();
    const micro = Math.floor((date.getUTCMilliseconds() / 1000) * 1e6);
    const padMicro = (n) => String(n).padStart(6, '0');
    return `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(mins)}:${pad(secs)}.${padMicro(micro)}+00:00`;
  } catch (err) {
    error('[formatDatetimeRacesight] error:', err);
    return null;
  }
}

// Helper function to format datetime with timezone (Racesight format for parquet/chart compatibility)
// Always outputs UTC in form "2026-01-17 04:15:05.800000+00:00" so charts and Python match
function formatDatetimeWithTimezone(timestamp, timezone) {
  const str = formatDatetimeRacesight(timestamp);
  if (str) return str;
  try {
    const ts = normalizeTs(timestamp);
    if (ts === null) return null;
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  } catch (err) {
    error('[formatDatetimeWithTimezone] error:', err);
    return new Date(normalizeTs(timestamp) * 1000).toISOString();
  }
}

// Get all class names
exports.getClasses = async (req, res) => {
  log('[getClasses] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header)

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'getClasses'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }
  
  const { project_id } = req.query;

  // Check permissions (read: list classes is viewing metadata)
  const hasPermission = await check_permissions(req, 'read', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 403, false, 'Forbidden - read permission required', null);
  }

  try {
    const classes = fs.readdirSync(safeJoin(env.DATA_DIRECTORY, "System", project_id)).filter((dir) =>
      fs.statSync(safeJoin(env.DATA_DIRECTORY, "System", project_id, dir)).isDirectory()
    );

    return sendResponse(res, info, 200, true, classes.length+" records found", classes);
  } catch (err) {
    error('[getClasses] error:', err);
    return sendResponse(res, info, 500, false, err.message, []);
  }
};

// Get all dates for a given class
exports.getDates = async (req, res) => {
  log('[getDates] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header)

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'getDates'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const { project_id, class_name } = req.query;

  // Normalize class_name to lowercase for consistent directory structure
  const classLower = String(class_name || '').toLowerCase();

  // Check permissions (read: list dates is viewing metadata)
  const hasPermission = await check_permissions(req, 'read', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 403, false, 'Forbidden - read permission required', null);
  }

  const classPath = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower);

  if (!fs.existsSync(classPath))
    return res.status(404).json({ success: false, message: 'Class not found' });

  try {
    const dates = fs.readdirSync(classPath).filter((dir) =>
      fs.statSync(safeJoin(classPath, dir)).isDirectory()
    );

    return sendResponse(res, info, 200, true, dates.length+" records found", dates);
  } catch (err) {
    error('[getDates] error:', err);
    return sendResponse(res, info, 500, false, err.message, []);
  }
};

// Get all sources for a given class and date
exports.getSources = async (req, res) => {
  log('[getSources] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header)

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'getSources'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const { project_id, class_name, date, data_source, level } = req.query;

  // Normalize date to YYYYMMDD so path matches folder names (e.g. 20260213)
  const dateYyyyMmDd = String(date || '').replace(/[-/]/g, '');

  // Default to 'file' for backward compatibility
  const dataSource = data_source || 'file';

  // Check permissions (read: list sources is viewing metadata)
  const hasPermission = await check_permissions(req, 'read', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 403, false, 'Forbidden - read permission required', null);
  }

  // If data_source is 'influx', query InfluxDB
  if (dataSource === 'influx') {
    try {
      const dataLevel = level || 'strm';
      const sources = await getSourcesFromInfluxDB(dateYyyyMmDd, dataLevel);
      return sendResponse(res, info, 200, true, sources.length + " records found", sources);
    } catch (err) {
      error('[getSources] InfluxDB error:', err);
      
      // Check for timeout
      const isTimeout = err.statusCode === 504 || 
                        (err.message && (err.message.includes('504') || err.message.includes('Gateway Time-out')));
      
      if (isTimeout) {
        return sendResponse(res, info, 504, false, `InfluxDB query timed out.`, []);
      }
      
      return sendResponse(res, info, 500, false, `InfluxDB query failed: ${err.message}`, []);
    }
  }

  // Otherwise, use existing filesystem-based implementation
  // Normalize class_name to lowercase for consistent directory structure
  const classLower = String(class_name || '').toLowerCase();

  const datePath = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, dateYyyyMmDd);

  if (!fs.existsSync(datePath))
    return res.status(404).json({ success: false, message: 'Date not found' });

  try {
    const sources = fs.readdirSync(datePath).filter((dir) =>
      fs.statSync(safeJoin(datePath, dir)).isDirectory()
    );

    return sendResponse(res, info, 200, true, sources.length+" records found", sources);
  } catch (err) {
    error('[getSources] error:', err);
    return sendResponse(res, info, 500, false, err.message, []);
  }
};

exports.getChannelList = async (req, res) => {
  log('[getChannelList] called');
  log(`[getChannelList] Request path: ${req.path}, URL: ${req.url}, method: ${req.method}`);
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header)

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'getChannelList'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    log(`[getChannelList] Validation errors: ${JSON.stringify(errors.array())}`);
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const { project_id, class_name, date, source_name, data_source, level, refresh_influx, refresh } = req.query;

  // Date is dataset local date (YYYYMMDD). Normalize so path matches folder names (e.g. 20260213).
  const dateYyyyMmDd = String(date || '').replace(/[-/]/g, '');

  // When true, bypass Influx channel cache and re-query InfluxDB for a fresh channel list (avoids stale list).
  const skipInfluxCache = refresh_influx === 'true' || refresh === 'true';

  log(`[getChannelList] Query params: project_id=${project_id}, class_name=${class_name}, date=${dateYyyyMmDd}, source_name=${source_name}, data_source=${data_source}, level=${level}, skipInfluxCache=${skipInfluxCache}`);

  // Default to 'file' for backward compatibility
  const dataSource = data_source || 'file';

  // Check permissions (read: list channels is viewing metadata)
  const hasPermission = await check_permissions(req, 'read', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 403, false, 'Forbidden - read permission required', null);
  }

  // If data_source is 'unified', query both FILE and INFLUX (strm+log) and merge
  if (dataSource === 'unified') {
    try {
      const sourceNameUpper = source_name ? source_name.toUpperCase() : '';
      const actualSourceName = (sourceNameUpper === 'ALL' || sourceNameUpper === 'ALL_INFLUX') ? 'GER' : source_name;
      
      log(`[getChannelList] Querying unified channels (FILE + INFLUX strm+log): date=${dateYyyyMmDd}, source=${actualSourceName} (requested: ${source_name})`);
      
      // Query both sources in parallel
      const [fileChannels, influxChannels] = await Promise.all([
        // Query FILE channels
        // IMPORTANT: Always return FILE channels if they exist, even if there are errors
        (async () => {
          try {
            const classLower = String(class_name || '').toLowerCase();
            const sourcePath = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, dateYyyyMmDd, actualSourceName);
            
            if (!fs.existsSync(sourcePath)) {
              log(`[getChannelList] FILE source path does not exist: ${sourcePath} - returning empty array`);
              return [];
            }
            
            const files = fs.readdirSync(sourcePath).filter((file) =>
              file.endsWith('.parquet')
            );
            
            if (files.length === 0) {
              log(`[getChannelList] No parquet files found in FILE source path: ${sourcePath} - returning empty array`);
              return [];
            }
            
            const filePaths = files.map(file => safeJoin(sourcePath, file));
            const channels = await extractChannelsFromParquetFiles(filePaths);
            log(`[getChannelList] FILE channels discovered: ${channels.length} channels from ${files.length} file(s)`);
            return channels;
          } catch (err) {
            // Log error but always return empty array (not throw) so unified discovery can continue
            // FILE channel errors should not prevent INFLUX channels from being returned
            error('[getChannelList] Error querying FILE channels (returning empty array to allow INFLUX channels):', err);
            return [];
          }
        })(),
        // Query INFLUX channels (both strm and log levels merged)
        (async () => {
          try {
            const channels = await getChannelsFromInfluxDBBothLevels(dateYyyyMmDd, actualSourceName, false, skipInfluxCache);
            log(`[getChannelList] InfluxDB returned ${channels.length} channels (strm+log) for ${actualSourceName}/${dateYyyyMmDd}`);
            return channels;
          } catch (err) {
            // Log error but continue - return empty array so FILE channels are still returned
            if (err.statusCode === 504 || (err.message && err.message.includes('504')) || (err.message && err.message.includes('Gateway Time-out'))) {
              warn(`[getChannelList] InfluxDB gateway timeout (504) for ${actualSourceName}/${dateYyyyMmDd} (strm+log) - will return FILE channels only`);
            } else {
              error(`[getChannelList] Error querying INFLUX channels for ${actualSourceName}/${dateYyyyMmDd}:`, err);
            }
            return [];
          }
        })()
      ]);
      
      // Merge and deduplicate channels (case-insensitive)
      const channelMap = new Map();
      [...fileChannels, ...influxChannels].forEach(ch => {
        if (ch && typeof ch === 'string') {
          const lower = ch.toLowerCase();
          if (!channelMap.has(lower)) {
            channelMap.set(lower, ch); // Preserve original casing from first occurrence
          }
        }
      });
      
      const unifiedChannels = Array.from(channelMap.values()).sort();
      
      log(`[getChannelList] Unified channels: ${fileChannels.length} from FILE, ${influxChannels.length} from INFLUX, ${unifiedChannels.length} unique total`);
      
      // Debug: Log if we're returning empty results
      if (unifiedChannels.length === 0) {
        warn(`[getChannelList] WARNING: Returning empty unified channel list for ${actualSourceName}/${dateYyyyMmDd}`);
        warn(`[getChannelList] FILE channels: ${fileChannels.length}, INFLUX channels: ${influxChannels.length}`);
      }
      
      // Even if InfluxDB failed, return FILE channels (unifiedChannels will contain FILE channels)
      return sendResponse(res, info, 200, true, unifiedChannels.length + " records found", unifiedChannels);
    } catch (err) {
      error('[getChannelList] Unified query error:', err);
      error('[getChannelList] Error stack:', err.stack);
      return sendResponse(res, info, 500, false, `Unified channel query failed: ${err.message}`, []);
    }
  }

  // If data_source is 'influx', query InfluxDB (both strm and log levels merged)
  if (dataSource === 'influx') {
    try {
      // For source_name=ALL or ALL_INFLUX, use GER as default
      const sourceNameUpper = source_name ? source_name.toUpperCase() : '';
      const actualSourceName = (sourceNameUpper === 'ALL' || sourceNameUpper === 'ALL_INFLUX') ? 'GER' : source_name;
      log(`[getChannelList] Querying InfluxDB channels (strm+log): date=${dateYyyyMmDd}, source=${actualSourceName} (requested: ${source_name}), skipInfluxCache=${skipInfluxCache}`);
      const channels = await getChannelsFromInfluxDBBothLevels(dateYyyyMmDd, actualSourceName, false, skipInfluxCache);
      log(`[getChannelList] InfluxDB returned ${channels.length} channels: ${channels.slice(0, 10).join(', ')}${channels.length > 10 ? '...' : ''}`);
      
      // Ensure channels is an array
      if (!Array.isArray(channels)) {
        error(`[getChannelList] Channels is not an array: ${typeof channels}`, channels);
        return sendResponse(res, info, 500, false, 'Invalid channel format returned from InfluxDB', []);
      }
      
      return sendResponse(res, info, 200, true, channels.length + " records found", channels);
    } catch (err) {
      error('[getChannelList] InfluxDB error:', err);
      error('[getChannelList] Error stack:', err.stack);
      
      // Check for timeout
      const isTimeout = err.statusCode === 504 || 
                        (err.message && (err.message.includes('504') || err.message.includes('Gateway Time-out')));
      
      if (isTimeout) {
        return sendResponse(res, info, 504, false, `InfluxDB query timed out. Try checking InfluxDB health or reducing load.`, []);
      }
      
      return sendResponse(res, info, 500, false, `InfluxDB query failed: ${err.message}`, []);
    }
  }

  // Otherwise, use DuckDB-based implementation for parquet files
  // Normalize class_name to lowercase for consistent directory structure
  const classLower = String(class_name || '').toLowerCase();

  try {
    // Handle special case: source_name=ALL or ALL_INFLUX - use GER as default
    const sourceNameUpper = source_name ? source_name.toUpperCase() : '';
    const actualSourceName = (sourceNameUpper === 'ALL' || sourceNameUpper === 'ALL_INFLUX') ? 'GER' : source_name;
    
    // Normal case: single source (or GER when ALL is specified); resolve case-insensitively so parquet is found
    const parentDir = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, dateYyyyMmDd);
    const sourcePath = resolveSourcePath(parentDir, actualSourceName);

    // Return empty array instead of 404 if source doesn't exist - allows unified discovery to continue
    if (!fs.existsSync(sourcePath)) {
      log(`[getChannelList] Source path does not exist: ${sourcePath} - returning empty channels array`);
      return sendResponse(res, info, 200, true, "0 records found", []);
    }

    const allFiles = fs.readdirSync(sourcePath).filter((file) =>
      file.endsWith('.parquet')
    );

    // When data_source is 'file', exclude Influx tier parquets so "FILE" = normalization parquets only.
    const files = dataSource === 'file'
      ? allFiles.filter((file) => !isInfluxTierParquetBasename(file))
      : allFiles;
    if (dataSource === 'file') {
      const excluded = allFiles.filter((file) => isInfluxTierParquetBasename(file));
      if (excluded.length > 0) {
        log(`[getChannelList] data_source=file: excluding Influx tier parquets: ${excluded.join(', ')}`);
      }
    }

    // Return empty array instead of 404 if no files found - allows unified discovery to continue
    if (files.length === 0) {
      log(`[getChannelList] No parquet files found in source path: ${sourcePath} (after filter) - returning empty channels array`);
      return sendResponse(res, info, 200, true, "0 records found", []);
    }

    // Build file paths array
    const filePaths = files.map(file => safeJoin(sourcePath, file));
    
    log(`[getChannelList] Querying ${filePaths.length} parquet files using DuckDB for channel discovery`);
    log(`[getChannelList] Source path: ${sourcePath}`);
    log(`[getChannelList] File paths: ${filePaths.slice(0, 3).map(f => require('path').basename(f)).join(', ')}${filePaths.length > 3 ? '...' : ''}`);
    
    // Use DuckDB to extract channels from all parquet files
    const channels_list = await extractChannelsFromParquetFiles(filePaths);
    
    if (channels_list.length === 0) {
      warn(`[getChannelList] No channels discovered from ${files.length} parquet file(s) in ${sourcePath}`);
      warn(`[getChannelList] This may indicate DuckDB schema extraction failed. Check server logs for extractChannelsFromParquetFiles errors.`);
      // Return empty array instead of 404 - this is a valid response (no channels found)
      // The frontend will handle this gracefully
    }

    log(`[getChannelList] Returning ${channels_list.length} channels: ${channels_list.slice(0, 10).join(', ')}${channels_list.length > 10 ? '...' : ''}`);
    
    // Debug: Log the exact response being sent
    if (channels_list.length === 0) {
      warn(`[getChannelList] WARNING: Returning empty channel list for class=${class_name}, project=${project_id}, date=${dateYyyyMmDd}, source=${source_name}`);
      warn(`[getChannelList] Source path exists: ${fs.existsSync(sourcePath)}, Files found: ${files.length}`);
    } else {
      log(`[getChannelList] Successfully returning ${channels_list.length} channels to client`);
    }
    
    // Debug: Check response state before sending
    log(`[getChannelList] Before sendResponse: headersSent=${res.headersSent}, finished=${res.finished}, writableEnded=${res.writableEnded}`);
    log(`[getChannelList] About to call sendResponse with ${channels_list.length} channels`);
    
    try {
      const result = sendResponse(res, info, 200, true, channels_list.length+" records found", channels_list);
      
      // Debug: Check response state after sending
      log(`[getChannelList] After sendResponse: headersSent=${res.headersSent}, finished=${res.finished}, writableEnded=${res.writableEnded}`);
      log(`[getChannelList] sendResponse returned, result=${result}`);
      
      return result;
    } catch (sendError) {
      error(`[getChannelList] Error in sendResponse:`, sendError);
      // Try to send error response
      if (!res.headersSent) {
        return sendResponse(res, info, 500, false, `Failed to send response: ${sendError.message}`, []);
      }
      throw sendError;
    }
  } catch (err) {
    error('[getChannelList] error:', err);
    return sendResponse(res, info, 500, false, err.message, []);
  }
};

// Get channel values using DuckDB
exports.getChannelValues = async (req, res) => {
  log('[getChannelValues] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header);

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'getChannelValues'};

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    log('[getChannelValues] Validation errors:', JSON.stringify(errors.array(), null, 2));
    log('[getChannelValues] Request body:', JSON.stringify(req.body, null, 2));
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const { project_id, class_name, date, source_name, channel_list, start_ts, end_ts, resolution, timezone, data_source } = req.body;

  // Date is dataset local date (YYYYMMDD). Used for folder path; we convert to UTC only when calling Influx. Normalize to YYYYMMDD (remove dashes). Sanitizer does not mutate req.body.
  const dateYyyyMmDd = String(date || '').replace(/[-/]/g, '');

  // Extract data_source from request body; default 'file' for backward compatibility
  const dataSource = data_source || 'file';
  const isUnified = (data_source === 'auto' || data_source === 'unified' || data_source == null);
  log(`[getChannelValues] data_source: ${dataSource}, isUnified: ${isUnified}`);

  // Normalize class_name early (used by multiple paths)
  const classLower = String(class_name || '').toLowerCase();

  // If data_source is 'influx', query InfluxDB (strm then log for missing) and save to tier parquet (raw / 10hz / 1hz) before responding
  if (dataSource === 'influx') {
    try {
      const sourceNameUpper = source_name ? source_name.toUpperCase() : '';
      const actualSourceName = (sourceNameUpper === 'ALL' || sourceNameUpper === 'ALL_INFLUX') ? 'GER' : source_name;
      // Resolve timezone so we can convert local date to UTC for Influx (folders stay local date)
      let influxTz = timezone;
      if (!influxTz && dateYyyyMmDd && dateYyyyMmDd.length === 8) {
        const datasetId = await getDatasetIdFromSource(class_name, project_id, dateYyyyMmDd, source_name);
        if (datasetId) influxTz = await getDatasetTimezone(class_name, datasetId);
      }
      const influxDateUtc = localDateToUtcDate(dateYyyyMmDd, influxTz || 'UTC');
      if (influxDateUtc !== dateYyyyMmDd) {
        log(`[getChannelValues] INFLUX path: date in UTC for Influx: ${dateYyyyMmDd} (local) -> ${influxDateUtc} (UTC)`);
      }
      // Convert channel_list to the format expected by getChannelValuesFromInfluxDBWithFallback
      const influxChannelList = Array.isArray(channel_list)
        ? channel_list.map(ch => typeof ch === 'string' ? { name: ch, type: 'float' } : ch)
        : [];
      const measurementCount = influxChannelList.filter(ch => {
        const n = ch && (ch.name || ch.channel);
        return n && n !== 'ts' && n !== 'Datetime';
      }).length;

      const influxQueryRes = influxResolutionForChannelValuesBackfill(
        resolution === undefined ? '1s' : resolution
      );
      const saveTierResolution = resolution === null ? null : (typeof resolution === 'string' && resolution.trim() !== '' ? resolution.trim() : '1s');
      const tierBasename = influxParquetBasenameFromApiResolution(saveTierResolution);
      log(`[getChannelValues] INFLUX path: querying InfluxDB then saving to ${tierBasename}; date=${dateYyyyMmDd} (local), influxDate=${influxDateUtc} (UTC), source=${actualSourceName}, channel_list.length=${influxChannelList.length}, data_channels=${measurementCount}`);

      // Query InfluxDB with fallback: strm first, then log for any channel with no data
      const influxData = await getChannelValuesFromInfluxDBWithFallback(
        influxDateUtc,
        actualSourceName,
        influxChannelList,
        influxQueryRes,
        start_ts,
        end_ts,
        'UTC',
        true // skipMissing
      );

      if (!influxData || influxData.length === 0) {
        log(`[getChannelValues] InfluxDB returned no data - ${tierBasename} will NOT be written (returning 204)`, {
          date: dateYyyyMmDd,
          source: actualSourceName,
          channel_count: influxChannelList.length,
          data_channels: measurementCount,
          channel_names: influxChannelList.map(c => (c && c.name) || c).slice(0, 10)
        });
        return sendResponse(res, info, 204, true, 'No channel values found', []);
      }

      log(`[getChannelValues] InfluxDB returned ${influxData.length} records; saving to parquet before sending response`);

      // Save InfluxDB data to parquet so API can serve from file in future sessions.
      // CRITICAL: await save so response is sent only after parquet is written.
      const filePath = await saveInfluxDataToParquet(
        influxData,
        project_id,
        class_name,
        dateYyyyMmDd,
        actualSourceName,
        saveTierResolution
      );
      if (filePath) {
        log(`[getChannelValues] Successfully saved InfluxDB data to ${filePath}`);
      } else {
        warn('[getChannelValues] saveInfluxDataToParquet returned no path (may have failed); next request may hit Influx again');
      }

      // Convert to Arrow format and send only after parquet save completed
      const buffer = await convertToArrow(influxData);

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="channel-values.arrow"');
      res.setHeader('Content-Length', buffer.byteLength);
      return res.status(200).send(buffer);
    } catch (err) {
      error('[getChannelValues] InfluxDB error:', err);
      error('[getChannelValues] Error stack:', err.stack);
      return sendResponse(res, info, 500, false, `InfluxDB query failed: ${err.message}`, []);
    }
  }

  // Unified path: split channels into in-file vs not-in-file, backfill missing from Influx, then serve all from DuckDB
  // Align with UploadDatasets (Influx upload page): use dataset timezone for Influx so local date range matches normalization.
  if (isUnified) {
    try {
      // Date must be YYYYMMDD (dataset local date) for folder path. We convert to UTC only for Influx.
      if (!dateYyyyMmDd || dateYyyyMmDd.length !== 8 || !/^\d{8}$/.test(dateYyyyMmDd)) {
        log(`[getChannelValues] Unified: invalid or missing date (expected YYYYMMDD local), got: ${dateYyyyMmDd ? `"${dateYyyyMmDd}"` : 'empty'}`);
        return sendResponse(res, info, 400, false, 'date is required for unified channel-values and must be YYYYMMDD (dataset local date)', null);
      }
      // Resolve dataset so we use the dataset's own date and timezone for parquet path and Influx (local timezone from the data).
      const dataset_id = await getDatasetIdFromSource(class_name, project_id, dateYyyyMmDd, source_name);
      let pathDateYyyyMmDd = dateYyyyMmDd;
      if (dataset_id) {
        const datasetDate = await getDatasetDate(class_name, dataset_id);
        if (datasetDate) {
          pathDateYyyyMmDd = datasetDate;
          if (pathDateYyyyMmDd !== dateYyyyMmDd) {
            log(`[getChannelValues] Unified: using dataset local date for path: request ${dateYyyyMmDd} -> ${pathDateYyyyMmDd} (from datasets table)`);
          }
        }
      }
      const parentDir = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, pathDateYyyyMmDd);
      const sourcePath = resolveSourcePath(parentDir, source_name);

      // Resolve timezone from dataset so Influx full-day range matches normalization (local date).
      let targetTimezone = timezone;
      if (!targetTimezone && dataset_id) {
        targetTimezone = await getDatasetTimezone(class_name, dataset_id);
      }
      if (!targetTimezone) {
        targetTimezone = 'UTC';
        warn(`[getChannelValues] Unified: could not resolve dataset timezone (date=${pathDateYyyyMmDd}, source=${source_name}); using UTC. Influx full-day range may not match local date.`);
      }
      log(`[getChannelValues] Unified: using timezone ${targetTimezone} for Influx backfill and DuckDB output`);

      // Channels in file: discover from parquet files (do not 404 if path or files missing)
      let channelsInFileSet = new Set();
      if (fs.existsSync(sourcePath)) {
        const filesInitial = fs.readdirSync(sourcePath).filter((f) => f.endsWith('.parquet'));
        if (filesInitial.length > 0) {
          const filePathsInitial = filesInitial.map((f) => safeJoin(sourcePath, f));
          const channelsInFile = await extractChannelsFromParquetFiles(filePathsInitial);
          channelsInFile.forEach((ch) => channelsInFileSet.add(ch.toLowerCase()));
        }
      }
      log(`[getChannelValues] Unified: channels in file: ${channelsInFileSet.size}`);

      // Normalize requested channel list (ensure ts present)
      let normalizedChannelList = Array.isArray(channel_list) ? channel_list.map(ch => typeof ch === 'string' ? { name: ch, type: 'float' } : ch) : [];
      const hasTs = normalizedChannelList.some(ch => (ch.name === 'ts' || ch.channel === 'ts'));
      if (!hasTs) {
        normalizedChannelList.unshift({ name: 'ts', type: 'float' });
      }
      const requestedNames = normalizedChannelList.map(ch => ch.name || ch.channel).filter(Boolean);

      // Split: channels not in file (data channels only for Influx; ts/Datetime excluded from Influx request)
      const channelsNotInFile = requestedNames.filter((name) => {
        const lower = String(name).toLowerCase();
        if (lower === 'ts' || lower === 'datetime') return false;
        return !channelsInFileSet.has(lower);
      });

      const dataChannelsNotInFile = channelsNotInFile.filter((name) => {
        const lower = String(name).toLowerCase();
        return lower !== 'ts' && lower !== 'datetime';
      });

      // Backfill from Influx if any data channels are missing from file. Pass UTC date to Influx; use dataset local date for folder (pathDateYyyyMmDd).
      if (dataChannelsNotInFile.length > 0) {
        const sourceNameUpper = source_name ? source_name.toUpperCase() : '';
        const actualSourceName = (sourceNameUpper === 'ALL' || sourceNameUpper === 'ALL_INFLUX') ? 'GER' : source_name;
        const influxChannelList = dataChannelsNotInFile.map((name) => ({ name, type: 'float' }));
        const influxDateUtc = localDateToUtcDate(pathDateYyyyMmDd, targetTimezone);
        if (influxDateUtc !== pathDateYyyyMmDd) {
          log(`[getChannelValues] Unified: Influx date in UTC: ${pathDateYyyyMmDd} (local) -> ${influxDateUtc} (UTC), tz=${targetTimezone}`);
        }
        const influxQueryRes = influxResolutionForChannelValuesBackfill(resolution);
        log(`[getChannelValues] Unified: backfilling ${dataChannelsNotInFile.length} channels from Influx at ${influxQueryRes} (API resolution=${resolution === null ? 'RAW' : resolution || 'default 1s'}):`, dataChannelsNotInFile.slice(0, 5));

        const influxData = await getChannelValuesFromInfluxDBWithFallback(
          influxDateUtc,
          actualSourceName,
          influxChannelList,
          influxQueryRes,
          start_ts,
          end_ts,
          'UTC',
          true
        );
        if (influxData && influxData.length > 0) {
          const writtenPath = await saveInfluxDataToParquet(
            influxData,
            project_id,
            class_name,
            pathDateYyyyMmDd,
            actualSourceName,
            resolution
          );
          if (writtenPath) {
            log(`[getChannelValues] Unified: saved ${influxData.length} Influx rows to ${influxParquetBasenameFromApiResolution(resolution)} at ${writtenPath}`);
          } else {
            warn('[getChannelValues] Unified: saveInfluxDataToParquet returned null (parquet not written - check server logs for saveInfluxDataToParquet errors)');
          }
        }
      }

      // DuckDB: non-Influx parquets + one Influx tier matching this request's resolution
      let sourcePathForDuck = sourcePath;
      if (!fs.existsSync(sourcePathForDuck)) {
        log('[getChannelValues] Unified: no source path after backfill, returning 204');
        return sendResponse(res, info, 204, true, 'No channel values found', []);
      }
      const filePaths = listParquetPathsForDuckDbChannelValues(sourcePathForDuck, resolution);
      if (filePaths.length === 0) {
        return sendResponse(res, info, 204, true, 'No channel values found', []);
      }

      const hasPermission = await check_permissions(req, 'read', project_id);
      if (!hasPermission) {
        return sendResponse(res, info, 400, false, 'Unauthorized', null);
      }

      // targetTimezone already resolved above for Influx backfill; use for DuckDB output
      log(`[getChannelValues] Unified: Querying ${filePaths.length} files from ${sourcePathForDuck}`);
      let result = await queryParquetFiles(filePaths, normalizedChannelList, start_ts, end_ts, resolution || null);
      // If time-filtered query returned no rows but we have files, retry without time filter (full day)
      // so we don't return 204 when data exists but dataset event range doesn't overlap parquet ts range
      if ((!result || result.length === 0) && (start_ts != null || end_ts != null)) {
        log(`[getChannelValues] Unified: time range [${start_ts}, ${end_ts}] returned 0 rows; retrying full day`);
        result = await queryParquetFiles(filePaths, normalizedChannelList, null, null, resolution || null);
      }
      if (!result || result.length === 0) {
        return sendResponse(res, info, 204, true, 'No channel values found', []);
      }
      // Process results (same as file path: filter, map, sort, then Arrow)
      const processedResults = result
        .filter(record => {
          let tsValue = record.ts;
          if (typeof tsValue === 'bigint') tsValue = Number(tsValue);
          if (tsValue !== undefined && tsValue !== null && !isNaN(tsValue)) return true;
          if (record.Datetime) {
            try {
              return !isNaN(new Date(record.Datetime).getTime());
            } catch { return false; }
            }
          return false;
        })
        .map(record => {
          const cleaned = {};
          const requestedChannelNames = new Set();
          if (Array.isArray(channel_list)) {
            channel_list.forEach(ch => { if (ch && ch.name) requestedChannelNames.add(ch.name); });
          }
          Object.keys(record).forEach(key => {
            if (record[key] !== undefined) {
              let value = record[key];
              if (key === 'ts') {
                value = normalizeTs(value);
                if (value !== null) cleaned[key] = value;
              } else if (typeof value === 'bigint') {
                cleaned[key] = Number(value);
              } else {
                cleaned[key] = value;
              }
            } else if (requestedChannelNames.has(key)) {
              const ch = Array.isArray(channel_list) && channel_list.find(c => c && c.name === key);
              const channelType = ch ? ch.type : null;
              cleaned[key] = (channelType && (String(channelType).toLowerCase() === 'string' || String(channelType).toLowerCase() === 'str')) ? '' : null;
            }
          });
          requestedChannelNames.forEach(channelName => {
            if (!(channelName in cleaned)) {
              const ch = Array.isArray(channel_list) && channel_list.find(c => c && (c.name === channelName || (typeof c === 'string' && c === channelName)));
              const channelType = ch ? (ch.type || (typeof ch === 'string' ? null : ch)) : null;
              cleaned[channelName] = (channelType && typeof channelType === 'string' && (channelType.toLowerCase() === 'string' || channelType.toLowerCase() === 'str')) ? '' : null;
            } else if (cleaned[channelName] === null) {
              const ch = Array.isArray(channel_list) && channel_list.find(c => c && (c.name === channelName || (typeof c === 'string' && c === channelName)));
              if (ch && typeof ch.type === 'string' && (ch.type.toLowerCase() === 'string' || ch.type.toLowerCase() === 'str')) cleaned[channelName] = '';
            }
          });
          let timestamp = normalizeTs(cleaned.ts);
          if (timestamp === undefined || timestamp === null) {
            if (cleaned.Datetime != null) {
              if (typeof cleaned.Datetime === 'number') timestamp = cleaned.Datetime;
              else if (typeof cleaned.Datetime === 'bigint') timestamp = Number(cleaned.Datetime);
              else if (typeof cleaned.Datetime === 'string') timestamp = isNaN(new Date(cleaned.Datetime).getTime()) ? null : new Date(cleaned.Datetime).getTime() / 1000;
              else timestamp = null;
            } else timestamp = null;
          }
          if (timestamp != null && !isNaN(timestamp)) {
            cleaned.Datetime = formatDatetimeWithTimezone(timestamp, targetTimezone);
          }
          return cleaned;
        })
        .sort((a, b) => {
          let tsA = a.ts, tsB = b.ts;
          if (typeof tsA === 'bigint') tsA = Number(tsA);
          if (typeof tsB === 'bigint') tsB = Number(tsB);
          if (tsA !== undefined && tsB !== undefined) return tsA - tsB;
          return new Date(a.Datetime) - new Date(b.Datetime);
        });
      const buffer = await convertToArrow(processedResults);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="channel-values.arrow"');
      res.setHeader('Content-Length', buffer.byteLength);
      return res.status(200).send(buffer);
    } catch (err) {
      error('[getChannelValues] Unified path error:', err);
      return sendResponse(res, info, 500, false, err.message, []);
    }
  }

  // File-only path: use DuckDB-based implementation for parquet files
  // CRITICAL: DuckDB queries MUST include 'ts' in the channel list
  let normalizedChannelList = Array.isArray(channel_list) ? [...channel_list] : [];
  const hasTs = normalizedChannelList.some(ch =>
    (typeof ch === 'string' ? ch === 'ts' : (ch.name === 'ts' || ch.channel === 'ts'))
  );
  if (!hasTs) {
    normalizedChannelList.unshift({ name: 'ts', type: 'float' });
    log(`[getChannelValues] Added missing 'ts' channel to channel_list`);
  }

  // Check permissions
  const hasPermission = await check_permissions(req, 'read', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 400, false, 'Unauthorized', null);
  }

  // Resolve source path case-insensitively so parquet is found when frontend sends "GER" but disk has "ger"
  const parentDir = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, dateYyyyMmDd);
  const sourcePath = resolveSourcePath(parentDir, source_name);

  if (!fs.existsSync(sourcePath))
    return res.status(404).json({ success: false, message: 'Source not found' });

  const files = fs.readdirSync(sourcePath).filter((file) =>
    file.endsWith('.parquet')
  );

  if (files.length === 0)
    return res.status(404).json({ success: false, message: 'No files found in source' });

  try {
    // Determine timezone: use provided timezone, or look up dataset timezone, or default to UTC
    let targetTimezone = timezone;
    if (!targetTimezone) {
      const dataset_id = await getDatasetIdFromSource(class_name, project_id, dateYyyyMmDd, source_name);
      if (dataset_id) {
        targetTimezone = await getDatasetTimezone(class_name, dataset_id);
      }
      if (!targetTimezone) {
        targetTimezone = 'UTC';
      }
    }
    
    log(`[getChannelValues] Using timezone: ${targetTimezone}`);
    if (resolution) {
      log(`[getChannelValues] Using resolution: ${resolution} (will resample to this frequency)`);
    } else {
      log(`[getChannelValues] Full frequency mode (no resolution) - returning native data frequency`);
    }

    const filePaths = listParquetPathsForDuckDbChannelValues(sourcePath, resolution);
    if (filePaths.length === 0) {
      return res.status(404).json({ success: false, message: 'No parquet files match this resolution' });
    }

    log(`[getChannelValues] Querying ${filePaths.length} files from ${sourcePath}`);
    log(`[getChannelValues] Channel list (${normalizedChannelList.length} channels):`, normalizedChannelList.map(ch => typeof ch === 'string' ? ch : ch.name));

    // Query parquet files using DuckDB
    let result;
    try {
      // Log DuckDB module status for debugging
      try {
        const { DuckDBInstance } = require('@duckdb/node-api');
        log(`[getChannelValues] DuckDB module loaded: ${typeof DuckDBInstance}`);
      } catch (moduleErr) {
        error('[getChannelValues] DuckDB module not available:', moduleErr.message);
        return sendResponse(res, info, 500, false, `DuckDB module not available: ${moduleErr.message}`, []);
      }
      
      result = await queryParquetFiles(filePaths, normalizedChannelList, start_ts, end_ts, resolution || null);
      // If time-filtered query returned no rows, retry without time filter (full day)
      if ((!result || result.length === 0) && (start_ts != null || end_ts != null)) {
        log(`[getChannelValues] time range [${start_ts}, ${end_ts}] returned 0 rows; retrying full day`);
        result = await queryParquetFiles(filePaths, normalizedChannelList, null, null, resolution || null);
      }
    } catch (err) {
      error('[getChannelValues] DuckDB query error:', err);
      error('[getChannelValues] Error stack:', err.stack);
      return sendResponse(res, info, 500, false, `DuckDB query failed: ${err.message}`, []);
    }

    if (!result || result.length === 0) {
      log('[getChannelValues] No data to return.');
      return sendResponse(res, info, 204, true, 'No channel values found', []);
    }

    // Process results to match existing format
    const processedResults = result
      .filter(record => {
        // Filter out records without valid timestamp
        // Convert BigInt ts to Number for comparison
        let tsValue = record.ts;
        if (typeof tsValue === 'bigint') {
          tsValue = Number(tsValue);
        }
        if (tsValue !== undefined && tsValue !== null && !isNaN(tsValue)) {
          return true;
        }
        if (record.Datetime) {
          try {
            const dateObj = new Date(record.Datetime);
            return !isNaN(dateObj.getTime());
          } catch {
            return false;
          }
        }
        return false;
      })
      .map(record => {
        // Ensure all requested channels are present
        const cleaned = {};
        const requestedChannelNames = new Set();
        if (Array.isArray(channel_list)) {
          channel_list.forEach(ch => {
            if (ch && ch.name) {
              requestedChannelNames.add(ch.name);
            }
          });
        }

        // Copy all fields from record and convert BigInt to Number; normalize ts to number (parquet can return string/scientific e.g. "1.768623e+09")
        Object.keys(record).forEach(key => {
          if (record[key] !== undefined) {
            let value = record[key];
            if (key === 'ts') {
              value = normalizeTs(value);
              if (value !== null) cleaned[key] = value;
            } else if (typeof value === 'bigint') {
              cleaned[key] = Number(value);
            } else {
              cleaned[key] = value;
            }
          } else if (requestedChannelNames.has(key)) {
            // Find channel type to use appropriate default value
            let channelType = null;
            if (Array.isArray(channel_list)) {
              const channel = channel_list.find(ch => ch && ch.name === key);
              channelType = channel ? channel.type : null;
            }
            // Use empty string for string channels, null for others
            if (channelType && (channelType.toLowerCase() === 'string' || channelType.toLowerCase() === 'str')) {
              cleaned[key] = '';
            } else {
              cleaned[key] = null;
            }
          }
        });

        // Ensure all requested channels are present
        requestedChannelNames.forEach(channelName => {
          if (!(channelName in cleaned)) {
            // Find channel type to use appropriate default value
            let channelType = null;
            if (Array.isArray(channel_list)) {
              try {
                const channel = channel_list.find(ch => ch && (ch.name === channelName || (typeof ch === 'string' && ch === channelName)));
                channelType = channel ? (channel.type || (typeof channel === 'string' ? null : channel)) : null;
              } catch (err) {
                // If find fails, channelType remains null
              }
            }
            // Use empty string for string channels, null for others
            if (channelType && typeof channelType === 'string' && (channelType.toLowerCase() === 'string' || channelType.toLowerCase() === 'str')) {
              cleaned[channelName] = '';
            } else {
              cleaned[channelName] = null;
            }
          } else if (cleaned[channelName] === null) {
            // Convert null to empty string for string channels
            let channelType = null;
            if (Array.isArray(channel_list)) {
              try {
                const channel = channel_list.find(ch => ch && (ch.name === channelName || (typeof ch === 'string' && ch === channelName)));
                channelType = channel ? (channel.type || (typeof channel === 'string' ? null : channel)) : null;
              } catch (err) {
                // If find fails, channelType remains null
              }
            }
            if (channelType && typeof channelType === 'string' && (channelType.toLowerCase() === 'string' || channelType.toLowerCase() === 'str')) {
              cleaned[channelName] = '';
            }
          }
        });

        // Derive Datetime from ts when missing (parquet often has ts but Datetime as null - charts need Datetime for x-axis)
        let timestamp = normalizeTs(cleaned.ts);
        if (timestamp === undefined || timestamp === null) {
          if (cleaned.Datetime !== undefined && cleaned.Datetime !== null) {
            if (typeof cleaned.Datetime === 'number') {
              timestamp = cleaned.Datetime;
            } else if (typeof cleaned.Datetime === 'bigint') {
              timestamp = Number(cleaned.Datetime);
            } else if (typeof cleaned.Datetime === 'string') {
              const dateObj = new Date(cleaned.Datetime);
              timestamp = isNaN(dateObj.getTime()) ? null : dateObj.getTime() / 1000;
            } else {
              timestamp = null;
            }
          } else {
            timestamp = null;
          }
        }
        if (timestamp !== null && !isNaN(timestamp)) {
          cleaned.Datetime = formatDatetimeWithTimezone(timestamp, targetTimezone);
        }

        return cleaned;
      })
      .sort((a, b) => {
        // Sort by ts (timestamp) if available, otherwise by Datetime
        // Convert BigInt to Number for comparison
        let tsA = a.ts;
        let tsB = b.ts;
        if (typeof tsA === 'bigint') tsA = Number(tsA);
        if (typeof tsB === 'bigint') tsB = Number(tsB);
        
        if (tsA !== undefined && tsB !== undefined) {
          return tsA - tsB;
        }
        const dateA = new Date(a.Datetime);
        const dateB = new Date(b.Datetime);
        return dateA - dateB;
      });

    // Convert to Arrow format
    const buffer = await convertToArrow(processedResults);

    if (env.VITE_VERBOSE === 'true') {
      debug('[getChannelValues] returned rows:', processedResults.length);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="channel-values.arrow"');
    res.setHeader('Content-Length', buffer.byteLength);
    return res.status(200).send(buffer);
  } catch (err) {
    error('[getChannelValues] error:', err);
    return sendResponse(res, info, 500, false, err.message, []);
  }
};

// Group channels by filename
exports.getChannelGroups = async (req, res) => {
  log('[getChannelGroups] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header);

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'getChannelGroups'};

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const { project_id, class_name, date, source_name, channel_names } = req.body;

  // Normalize date to YYYYMMDD so path matches folder names (e.g. 20260213). Sanitizer does not mutate req.body.
  const dateYyyyMmDd = String(date || '').replace(/[-/]/g, '');

  // Normalize class_name to lowercase for consistent directory structure
  const classLower = String(class_name || '').toLowerCase();

  // Check permissions
  const hasPermission = await check_permissions(req, 'read', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 400, false, 'Unauthorized', null);
  }

  // Resolve source path case-insensitively so parquet is found when frontend sends "GER" but disk has "ger"
  const parentDirForGroup = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, dateYyyyMmDd);
  const sourcePath = resolveSourcePath(parentDirForGroup, source_name);

  if (!fs.existsSync(sourcePath))
    return res.status(404).json({ success: false, message: 'Source not found' });

  if (!Array.isArray(channel_names) || channel_names.length === 0) {
    return res.status(400).json({ success: false, message: 'channel_names must be a non-empty array. Received: ' + JSON.stringify(channel_names) });
  }

  try {
    let groups = await groupChannelsByFilename(sourcePath, channel_names);

    // Filter out groups with only one channel or only 'Datetime'
    groups = groups.filter(group => {
      // group.channels or group.channel_names depending on your structure
      const channels = group.channels || group.channel_names || [];
      if (channels.length <= 1) {
        // Only skip if single channel and it's 'Datetime'
        return !(channels.length === 1 && channels[0] === 'Datetime');
      }
      // Keep groups with more than one channel
      return true;
    });

    return sendResponse(res, info, 200, true, "Channel groups by file", groups);
  } catch (err) {
    error('[getChannelGroups] error:', err);
    return sendResponse(res, info, 500, false, err.message, []);
  }
};

/**
 * Check if InfluxDB is available and healthy
 * Tests actual connection health, not just environment variable presence
 */
exports.checkInfluxDBAvailable = async (req, res) => {
  log('[checkInfluxDBAvailable] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header);

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'checkInfluxDBAvailable'};

  try {
    const influxHost = env.INFLUX_HOST;
    const available = !!(influxHost && influxHost.trim() !== '');
    
    if (!available) {
      return sendResponse(res, info, 200, true, 'InfluxDB not available (INFLUX_HOST not configured)', { 
        available: false,
        healthy: false,
        error: 'INFLUX_HOST environment variable is not set'
      });
    }

    // Perform actual health check
    try {
      await checkInfluxDBHealth(influxHost);
      return sendResponse(res, info, 200, true, 'InfluxDB is available and healthy', { 
        available: true,
        healthy: true
      });
    } catch (healthErr) {
      error('[checkInfluxDBAvailable] Health check failed:', healthErr.message);
      return sendResponse(res, info, 200, true, 'InfluxDB is configured but health check failed', { 
        available: true,
        healthy: false,
        error: healthErr.message
      });
    }
  } catch (err) {
    error('[checkInfluxDBAvailable] error:', err);
    return sendResponse(res, info, 500, false, err.message, { 
      available: false,
      healthy: false,
      error: err.message
    });
  }
};

/**
 * Edit channel data in parquet files for a given time range
 * Overwrites channel values within the specified time range
 */
exports.editChannelData = async (req, res) => {
  log('[editChannelData] called');
  const auth_header = req.cookies?.auth_token ?? req.headers.authorization;
  const auth_token = getAuthToken(auth_header);

  const info = {"auth_token": auth_token, "location": 'server_file/files', "function": 'editChannelData'};

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    log('[editChannelData] Validation errors:', JSON.stringify(errors.array(), null, 2));
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  const { project_id, class_name, date, source_name, channel_name, start_ts, end_ts, channel_value } = req.body;

  // Normalize date to YYYYMMDD
  const dateYyyyMmDd = String(date || '').replace(/[-/]/g, '');

  // Normalize class_name to lowercase
  const classLower = String(class_name || '').toLowerCase();

  // Check permissions
  const hasPermission = await check_permissions(req, 'write', project_id);
  if (!hasPermission) {
    return sendResponse(res, info, 403, false, 'Unauthorized - write permission required', null);
  }

  // Resolve source path
  const parentDir = safeJoin(env.DATA_DIRECTORY, "System", project_id, classLower, dateYyyyMmDd);
  const sourcePath = resolveSourcePath(parentDir, source_name);

  if (!fs.existsSync(sourcePath)) {
    return sendResponse(res, info, 404, false, 'Source path not found', null);
  }

  try {
    log(`[editChannelData] Editing channel ${channel_name} in ${sourcePath} for time range ${start_ts} to ${end_ts}`);
    
    // Get all parquet files in the source directory
    const files = fs.readdirSync(sourcePath).filter((file) => file.endsWith('.parquet'));
    
    if (files.length === 0) {
      return sendResponse(res, info, 404, false, 'No parquet files found in source', null);
    }

    // Import the edit function
    const { editChannelInParquetFiles } = require('../middleware/parquet_editor');
    
    // Edit the channel data across all parquet files
    const filePaths = files.map(file => safeJoin(sourcePath, file));
    const result = await editChannelInParquetFiles(
      filePaths,
      channel_name,
      parseFloat(start_ts),
      parseFloat(end_ts),
      channel_value
    );

    log(`[editChannelData] Successfully edited ${result.rowsModified} rows across ${result.filesModified} files`);
    
    return sendResponse(res, info, 200, true, 'Channel data updated successfully', {
      filesModified: result.filesModified,
      rowsModified: result.rowsModified,
      filesProcessed: result.filesProcessed
    });
  } catch (err) {
    error('[editChannelData] error:', err);
    error('[editChannelData] error stack:', err.stack);
    return sendResponse(res, info, 500, false, `Failed to edit channel data: ${err.message}`, null);
  }
};