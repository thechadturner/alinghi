const { log, error, warn, debug } = require('../../shared');
const db = require('./db');
const env = require('./config');

// Import file server's channel discovery functions directly
let extractChannelsFromParquetFiles = null;
let getChannelsFromInfluxDB = null;
try {
  const duckdbUtils = require('../../server_file/middleware/duckdb_utils');
  const influxdbUtils = require('../../server_file/middleware/influxdb_utils');
  extractChannelsFromParquetFiles = duckdbUtils.extractChannelsFromParquetFiles;
  getChannelsFromInfluxDB = influxdbUtils.getChannelsFromInfluxDB;
  log('[channels] Successfully imported file server channel discovery functions');
} catch (err) {
  error('[channels] Could not import file server functions:', err);
}

/**
 * Get source_name from source_id via JOIN with sources table
 * @param {string} class_name - Class name (e.g., 'gp50')
 * @param {number} source_id - Source ID
 * @returns {Promise<string|null>} Source name or null if not found
 */
async function getSourceNameFromSourceId(class_name, source_id) {
  try {
    const sql = `SELECT source_name FROM ${class_name}.sources WHERE source_id = $1 LIMIT 1`;
    const params = [source_id];
    const result = await db.GetRows(sql, params);
    
    if (result && result.length > 0 && result[0].source_name) {
      return result[0].source_name;
    }
    return null;
  } catch (err) {
    error('[getSourceNameFromSourceId] error:', err);
    return null;
  }
}

// Re-export file server's path construction logic
const path = require('path');
const fs = require('fs');
const safeJoin = (...paths) => path.join(...paths);

/**
 * Get FILE channels using file server's logic
 * @param {string} class_name - Class name (e.g., 'gp50')
 * @param {number} project_id - Project ID
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} source_name - Source name
 * @returns {Promise<string[]>} Array of channel names
 */
async function getFileChannels(class_name, project_id, date, source_name) {
  if (!extractChannelsFromParquetFiles) {
    error('[getFileChannels] File server extractChannelsFromParquetFiles not available');
    return [];
  }
  
  try {
    const classLower = String(class_name || '').toLowerCase();
    const sourceNameUpper = source_name ? source_name.toUpperCase() : '';
    const actualSourceName = (sourceNameUpper === 'ALL' || sourceNameUpper === 'ALL_INFLUX') ? 'GER' : source_name;
    
    const sourcePath = safeJoin(env.DATA_DIRECTORY, "System", String(project_id), classLower, date, actualSourceName);
    
    log(`[getFileChannels] Using file server logic: source_name=${source_name}, date=${date}`);
    
    if (!fs.existsSync(sourcePath)) {
      debug(`[getFileChannels] Source path does not exist: ${sourcePath}`);
      return [];
    }

    const allParquet = fs.readdirSync(sourcePath).filter((file) => file.endsWith('.parquet'));
    // Exclude influx_data.parquet so FILE = channels from normalization + fusion parquet only
    // (matches file server getChannelList when data_source=file)
    const INFLUX_PARQUET = 'influx_data.parquet';
    const files = allParquet.filter((file) => file !== INFLUX_PARQUET);
    if (allParquet.includes(INFLUX_PARQUET)) {
      debug(`[getFileChannels] Excluding ${INFLUX_PARQUET} from FILE channel discovery`);
    }

    if (files.length === 0) {
      debug(`[getFileChannels] No parquet files found in source path (after excluding influx): ${sourcePath}`);
      return [];
    }

    const filePaths = files.map(file => safeJoin(sourcePath, file));
    const channels = await extractChannelsFromParquetFiles(filePaths);
    
    log(`[getFileChannels] Discovered ${channels.length} FILE channels for ${source_name}/${date}: ${channels.slice(0, 10).join(', ')}${channels.length > 10 ? '...' : ''}`);
    return channels || [];
  } catch (err) {
    error('[getFileChannels] error:', err);
    return [];
  }
}

/**
 * Get INFLUX channels using file server's logic
 * @param {string} date - Date in YYYYMMDD format
 * @param {string} source_name - Source name
 * @param {string} level - Data level ('strm' or 'log'), defaults to 'strm'
 * @param {boolean} skipCache - If true, bypass file server's Influx channel cache and query InfluxDB for a fresh list
 * @returns {Promise<string[]>} Array of channel names
 */
async function getInfluxChannels(date, source_name, level = 'strm', skipCache = false) {
  if (!getChannelsFromInfluxDB) {
    error('[getInfluxChannels] File server getChannelsFromInfluxDB not available');
    return [];
  }
  
  try {
    log(`[getInfluxChannels] Using file server logic: source_name=${source_name}, date=${date}, level=${level}, skipCache=${skipCache}`);
    const channels = await getChannelsFromInfluxDB(date, source_name, level, false, skipCache);
    log(`[getInfluxChannels] Discovered ${channels.length} INFLUX channels for ${source_name}/${date}/${level}: ${channels.slice(0, 10).join(', ')}${channels.length > 10 ? '...' : ''}`);
    return channels || [];
  } catch (err) {
    // Log error but don't throw - INFLUX might be unavailable
    warn(`[getInfluxChannels] Error getting INFLUX channels for ${source_name}/${date}/${level}:`, err.message);
    return [];
  }
}

/**
 * Check if channels already exist for a given date (any source)
 * @param {string} date - Date in YYYYMMDD format
 * @returns {Promise<boolean>} True if channels exist for this date
 */
async function channelsExistForDate(date) {
  try {
    const sql = `SELECT COUNT(*) as count FROM gp50.channels WHERE date = $1`;
    const params = [date];
    const result = await db.GetRows(sql, params);
    
    if (result && result.length > 0 && result[0].count > 0) {
      return true;
    }
    return false;
  } catch (err) {
    error('[channelsExistForDate] error:', err);
    return false;
  }
}

/**
 * Check if channels already exist for a given date and dataset (so we don't skip when another source has channels for same date)
 * @param {string} date - Date in YYYYMMDD format
 * @param {number} dataset_id - Dataset ID
 * @returns {Promise<boolean>} True if channels exist for this date and dataset
 */
async function channelsExistForDateAndDataset(date, dataset_id) {
  try {
    const sql = `SELECT COUNT(*) as count FROM gp50.channels WHERE date = $1 AND dataset_id = $2`;
    const params = [date, dataset_id];
    const result = await db.GetRows(sql, params);
    
    if (result && result.length > 0 && result[0].count > 0) {
      return true;
    }
    return false;
  } catch (err) {
    error('[channelsExistForDateAndDataset] error:', err);
    return false;
  }
}

/**
 * Insert or update channels in gp50.channels table
 * @param {number} dataset_id - Dataset ID
 * @param {string} date - Date in YYYYMMDD format
 * @param {string[]} channels - Array of channel names
 * @param {string} data_source - Data source ('FILE' or 'INFLUX')
 * @returns {Promise<number>} Number of channels inserted/updated
 */
async function insertChannels(dataset_id, date, channels, data_source) {
  if (!channels || channels.length === 0) {
    debug(`[insertChannels] No channels to insert for date ${date}, data_source ${data_source}`);
    return 0;
  }
  
  try {
    let insertedCount = 0;
    let errorCount = 0;
    
    log(`[insertChannels] Attempting to insert ${channels.length} ${data_source} channels for date ${date}, dataset_id ${dataset_id}`);
    
    // Use ExecuteCommand but wrap in try-catch to get error details
    // First, verify table exists
    try {
      const checkTableSql = `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'gp50' AND table_name = 'channels'`;
      const tableCheck = await db.GetRows(checkTableSql, []);
      if (!tableCheck || tableCheck.length === 0 || tableCheck[0].count === 0) {
        throw new Error('Table gp50.channels does not exist. Please run the database migration.');
      }
    } catch (checkErr) {
      error('[insertChannels] Error checking table existence:', checkErr);
      throw new Error(`Table gp50.channels does not exist or is not accessible: ${checkErr.message}`);
    }
    
    // Use shared database connection for better error handling
    const sharedDb = require('../../shared/database/connection');
    
    for (const channel_name of channels) {
      if (!channel_name || typeof channel_name !== 'string') {
        debug(`[insertChannels] Skipping invalid channel name:`, channel_name);
        continue;
      }
      
      const sql = `
        INSERT INTO gp50.channels (dataset_id, date, channel_name, data_source, last_update)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (date, channel_name, data_source) 
        DO UPDATE SET 
          dataset_id = EXCLUDED.dataset_id,
          last_update = CURRENT_TIMESTAMP
      `;
      const params = [dataset_id, date, channel_name, data_source];
      
      try {
        // Use shared db.executeCommand which uses pool directly
        const success = await sharedDb.executeCommand(sql, params);
        if (success) {
          insertedCount++;
        } else {
          errorCount++;
          error(`[insertChannels] executeCommand returned false for channel ${channel_name}`);
        }
      } catch (insertErr) {
        errorCount++;
        error(`[insertChannels] Error inserting channel ${channel_name}:`, {
          error: insertErr.message,
          code: insertErr.code,
          detail: insertErr.detail,
          hint: insertErr.hint
        });
        // Continue with other channels even if one fails
      }
    }
    
    if (errorCount > 0) {
      warn(`[insertChannels] Inserted/updated ${insertedCount} ${data_source} channels for date ${date}, ${errorCount} errors`);
    } else {
      log(`[insertChannels] Successfully inserted/updated ${insertedCount} ${data_source} channels for date ${date}`);
    }
    return insertedCount;
  } catch (err) {
    error('[insertChannels] error:', err);
    throw err;
  }
}

/**
 * Main function to populate channels for a date from both FILE and INFLUX sources
 * Only updates once per unique date (checks if date already exists)
 * @param {string} class_name - Class name (e.g., 'gp50')
 * @param {number} project_id - Project ID
 * @param {number} source_id - Source ID
 * @param {string} date - Date in YYYYMMDD format (will be normalized)
 * @param {number} dataset_id - Dataset ID (optional, will be looked up if not provided)
 * @param {boolean} forceRefresh - If true, skip the existence check and force re-population
 * @returns {Promise<{fileChannels: number, influxChannels: number}>} Count of channels inserted
 */
async function populateChannelsForDate(class_name, project_id, source_id, date, dataset_id = null, forceRefresh = false) {
  try {
    // Normalize date format (remove dashes if present)
    const normalizedDate = date.replace(/[-/]/g, '');
    
    log(`[populateChannelsForDate] Starting population for date: ${date} (normalized: ${normalizedDate}), source_id: ${source_id}, project_id: ${project_id}, class: ${class_name}, forceRefresh: ${forceRefresh}`);
    
    if (normalizedDate.length !== 8 || !/^\d+$/.test(normalizedDate)) {
      throw new Error(`Invalid date format: ${date}. Expected YYYYMMDD format.`);
    }
    
    // Get source_name from source_id (needed before dataset_id lookup)
    log(`[populateChannelsForDate] Looking up source_name for source_id ${source_id} in class ${class_name}`);
    const source_name = await getSourceNameFromSourceId(class_name, source_id);
    if (!source_name) {
      warn(`[populateChannelsForDate] Could not find source_name for source_id ${source_id} in class ${class_name}`);
      return { fileChannels: 0, influxChannels: 0, error: 'Source not found' };
    }
    log(`[populateChannelsForDate] Found source_name: ${source_name} for source_id ${source_id}`);
    
    // Get dataset_id if not provided (needed for skip check so we don't skip when another source has channels for same date)
    if (!dataset_id) {
      const sql = `SELECT dataset_id FROM ${class_name}.datasets WHERE source_id = $1 AND date = $2 ORDER BY dataset_id DESC LIMIT 1`;
      const params = [source_id, normalizedDate];
      log(`[populateChannelsForDate] Looking up dataset_id with query: ${sql}, params: [${params.join(', ')}]`);
      const rows = await db.GetRows(sql, params);
      if (rows && rows.length > 0) {
        dataset_id = rows[0].dataset_id;
        log(`[populateChannelsForDate] Found dataset_id: ${dataset_id}`);
      } else {
        warn(`[populateChannelsForDate] Could not find dataset_id for source_id ${source_id}, date ${normalizedDate}. This is OK - will use a placeholder dataset_id.`);
        // Use a placeholder dataset_id if none found - channels table doesn't strictly require it
        dataset_id = 0;
      }
    }
    
    // Check if channels already exist for this date and dataset (unless forcing refresh)
    // Use date+dataset_id so we still populate when a second source has the same date
    if (!forceRefresh) {
      const exists = await channelsExistForDateAndDataset(normalizedDate, dataset_id);
      if (exists) {
        debug(`[populateChannelsForDate] Channels already exist for date ${normalizedDate} dataset_id ${dataset_id}, skipping population`);
        return { fileChannels: 0, influxChannels: 0, skipped: true };
      }
    } else {
      log(`[populateChannelsForDate] Force refresh enabled - will re-populate channels even if they exist`);
    }
    
    log(`[populateChannelsForDate] Populating channels for date ${normalizedDate}, source ${source_name}, dataset ${dataset_id}, project ${project_id}`);
    
    // Get channels from both sources in parallel. INFLUX: query both strm and log, then merge.
    log(`[populateChannelsForDate] Starting parallel channel discovery for FILE and INFLUX (strm+log) using file server functions (skipInfluxCache=${forceRefresh})...`);
    const [fileChannels, influxStrm, influxLog] = await Promise.all([
      getFileChannels(class_name, project_id, normalizedDate, source_name),
      getInfluxChannels(normalizedDate, source_name, 'strm', forceRefresh),
      getInfluxChannels(normalizedDate, source_name, 'log', forceRefresh)
    ]);
    const influxMerge = new Map();
    [...(influxStrm || []), ...(influxLog || [])].forEach(ch => {
      if (ch && typeof ch === 'string') {
        const lower = ch.toLowerCase();
        if (!influxMerge.has(lower)) influxMerge.set(lower, ch);
      }
    });
    const influxChannels = Array.from(influxMerge.values()).sort();
    log(`[populateChannelsForDate] Channel discovery completed: ${fileChannels.length} FILE channels, ${influxChannels.length} INFLUX channels (strm=${(influxStrm || []).length}, log=${(influxLog || []).length})`);
    
    // Insert channels into database
    const fileCount = await insertChannels(dataset_id, normalizedDate, fileChannels, 'FILE');
    const influxCount = await insertChannels(dataset_id, normalizedDate, influxChannels, 'INFLUX');
    
    log(`[populateChannelsForDate] Successfully populated channels: ${fileCount} FILE, ${influxCount} INFLUX for date ${normalizedDate}`);
    
    return { fileChannels: fileCount, influxChannels: influxCount };
  } catch (err) {
    error('[populateChannelsForDate] error:', err);
    throw err;
  }
}

module.exports = {
  getSourceNameFromSourceId,
  getFileChannels,
  getInfluxChannels,
  populateChannelsForDate,
  insertChannels,
  channelsExistForDate
};
