const { queryInfluxV3 } = require('../../../server_file/middleware/influxdb_utils_v3');
const { log, error, warn, debug } = require('../../../shared');
const connectionManager = require('../connections');
const redisStorage = require('../redis');
const EventEmitter = require('events');

/**
 * List of required channels from normalization script (1_normalization_influx.py)
 * These are the InfluxDB measurement names that should be queried
 */
const REQUIRED_CHANNELS = [
  // Core time and location
  'LATITUDE_GPS_unk',
  'LONGITUDE_GPS_unk',
  'TRK_RACE_NUM_unk',
  'TRK_LEG_NUM_unk',
  'TIME_RACE_s',
  'TRK_COURSE_AXIS_deg',
  // Wind measurements
  'TWS_SGP_km_h_1',
  'TWS_BOW_SGP_km_h_1',
  'TWS_MHU_SGP_km_h_1',
  'TWS_TM_km_h_1',
  'TWD_SGP_deg',
  'TWD_BOW_SGP_deg',
  'TWD_MHU_SGP_deg',
  'TWD_TM_deg',
  'TWA_SGP_deg',
  'TWA_BOW_SGP_deg',
  'TWA_MHU_SGP_deg',
  'TARG_TWA_deg',
  'TWA_TM_deg',
  // Apparent wind
  'AWS_SGP_km_h_1',
  'AWS_BOW_SGP_km_h_1',
  'AWS_MHU_SGP_km_h_1',
  'AWA_SGP_deg',
  'AWA_BOW_SGP_deg',
  'AWA_MHU_SGP_deg',
  'AWA_TM_deg',
  // Course and heading
  'HEADING_deg',
  'GPS_COG_deg',
  // Speed measurements
  'GPS_SOG_km_h_1',
  'BOAT_SPEED_km_h_1',
  'TARG_BOAT_SPEED_km_h_1',
  'POLAR_BOAT_SPEED_km_h_1',
  'VMG_km_h_1',
  'TARG_VMG_km_h_1',
  // Boat attitude
  'PITCH_deg',
  'HEEL_deg',
  'LEEWAY_deg',
  // Rates
  'RATE_PITCH_deg_s_1',
  'RATE_YAW_deg_s_1',
  'RATE_ROLL_deg_s_1',
  // Righting hull
  'LENGTH_RH_P_mm',
  'LENGTH_RH_S_mm',
  'LENGTH_RH_BOW_mm',
  // Rudder
  'ANGLE_RUDDER_deg',
  'ANGLE_RUD_AVG_deg',
  'ANGLE_RUD_DIFF_TACK_deg',
  'LENGTH_IMMERSION_RUD_P_mm',
  'LENGTH_IMMERSION_RUD_S_mm',
  // Daggerboard
  'ANGLE_DB_RAKE_P_deg',
  'ANGLE_DB_RAKE_S_deg',
  'ANGLE_DB_RAKE_P_AOA_deg',
  'ANGLE_DB_RAKE_S_AOA_deg',
  'ANGLE_DB_CANT_P_deg',
  'ANGLE_DB_CANT_S_deg',
  'ANGLE_DB_CANT_P_EFF_deg',
  'ANGLE_DB_CANT_S_EFF_deg',
  'LENGTH_DB_H_P_mm',
  'LENGTH_DB_H_S_mm',
  'LENGTH_IMMERSION_DB_P_mm',
  'LENGTH_IMMERSION_DB_S_mm',
  'LENGTH_DB_PIERCING_P_m',
  'LENGTH_DB_PIERCING_S_m',
  // Wing controls
  'ANGLE_CA1_deg',
  'ANGLE_CA2_deg',
  'ANGLE_CA3_deg',
  'ANGLE_CA4_deg',
  'ANGLE_CA5_deg',
  'ANGLE_CA6_deg',
  'ANGLE_WING_TWIST_deg',
  'ANGLE_WING_ROT_deg',
  'AWA_-_E1_deg',
  'ANGLE_CLEW_deg',
  'LENGTH_WING_CLEW_mm',
  // Jib
  'PER_JIB_SHEET_pct',
  'LOAD_JIB_SHEET_kgf',
  'LOAD_JIB_CUNNO_kgf',
  'ANGLE_JIB_SHT_deg',
  'PER_JIB_LEAD_pct',
  // Rig loads
  'LOAD_BOBSTAY_tf',
  'LOAD_SHRD_LWR_P_tf',
  'LOAD_SHRD_LWR_S_tf',
  'LOAD_SHRD_UPR_P_tf',
  'LOAD_SHRD_UPR_S_tf'
];

const IOX_TABLE = '"iox"."universalized_logs"';

/** @param {string} s */
function sqlStringLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** @param {string} name */
function sqlQuoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * InfluxDB 3.x Data Source Connector
 * Connects via HTTP /api/v3/query_sql against iox.universalized_logs (wide table).
 * Supports real-time polling with time-based SQL queries.
 */

class InfluxDBSource extends EventEmitter {
  constructor(source_id, config) {
    super();
    this.source_id = source_id;
    this.config = config;
    this.connected = false;
    this.isConnecting = false;
    this.shouldReconnect = true;
    this.pollInterval = null;
    this.lastQueryTime = null; // Track last query time for incremental polling
    this.lastDataTimestamp = null; // Track last data timestamp from Redis
    this.queryCount = 0; // Track query count for reduced logging
    /** @type {string | null} InfluxDB v3 database name */
    this.database = null;
    this.sourceFilter = null; // Boat/source name filter
    this.source_name = null; // Source name (normalized) - used as unique identifier in Redis
  }

  /**
   * Connect to InfluxDB 3.x (HTTP SQL)
   */
  async connect() {
    if (this.isConnecting) {
      warn(`[InfluxDBSource_v3] Source ${this.source_id} already connecting`);
      return;
    }

    this.isConnecting = true;
    connectionManager.updateState(this.source_id, 'connecting');

    try {
      const influxToken = process.env.INFLUX_TOKEN;
      const influxHost = process.env.INFLUX_HOST;
      const influxDatabase = process.env.INFLUX_DATABASE;

      if (!influxToken) {
        throw new Error('INFLUX_TOKEN environment variable is not set');
      }
      if (!influxHost) {
        throw new Error('INFLUX_HOST environment variable is not set');
      }
      if (!influxDatabase) {
        throw new Error('INFLUX_DATABASE environment variable is not set');
      }

      let influxUrl = influxHost;
      if (!influxUrl.startsWith('http://') && !influxUrl.startsWith('https://')) {
        influxUrl = `http://${influxUrl}`;
      }

      this.sourceFilter = this.config.source || this.config.boat;
      this.source_name = this.sourceFilter ? String(this.sourceFilter).toUpperCase().trim() : null;
      this.database = influxDatabase;

      log(`[InfluxDBSource_v3] Connecting source ${this.source_id} to InfluxDB 3.x: host=${influxUrl}, db=${influxDatabase}, boat=${this.sourceFilter || 'all'}`);

      await this.checkHealth();

      this.connected = true;
      this.isConnecting = false;
      connectionManager.updateState(this.source_id, 'connected');
      log(`[InfluxDBSource_v3] Source ${this.source_id} connected to InfluxDB 3.x`);

      // Start polling if configured
      const pollInterval = this.config.pollInterval || 1000; // Default 1 second
      this.startPolling(pollInterval);

      this.emit('connected');

    } catch (err) {
      this.isConnecting = false;
      error(`[InfluxDBSource_v3] Failed to connect source ${this.source_id}:`, err.message);
      connectionManager.updateState(this.source_id, 'error', err);
      this.emit('error', err);

      // Schedule reconnection
      if (this.shouldReconnect) {
        connectionManager.scheduleReconnect(this.source_id, () => {
          this.connect();
        });
      }
    }
  }

  /**
   * Check InfluxDB v3 health using minimal SQL
   */
  async checkHealth() {
    await queryInfluxV3('SELECT 1');
  }

  /**
   * Start polling InfluxDB simulator for new data
   */
  startPolling(interval) {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // Build query based on configuration
    const timeRange = this.config.timeRange || '1s'; 
    const fields = this.config.fields || '*'; // Default: all fields
    
    // Build InfluxQL query - simulator supports 'now() - X' syntax (with space)
    let query = `SELECT ${fields} FROM sailgp WHERE time > now() - ${timeRange}`;
    
    // Add source filter if configured
    if (this.sourceFilter) {
      query += ` AND source = '${this.sourceFilter}'`;
    }

    // Store query for reuse
    this.baseQuery = query;
    this.pollIntervalMs = interval;

    log(`[InfluxDBSource_v3] Starting polling for source ${this.source_id} every ${interval}ms`);

    // Initialize: get last timestamp from Redis
    this.initializeLastTimestamp();

    this.pollInterval = setInterval(async () => {
      // Check if InfluxDB streaming is disabled - skip query if disabled
      if (typeof global !== 'undefined' && global.influxDBStreamingEnabled === false) {
        // Streaming is disabled, skip this query
        return;
      }
      
      const queryStartTime = Date.now();
      try {
        // Increment query count for logging optimization
        this.queryCount = (this.queryCount || 0) + 1;
        
        // Track query attempt
        if (typeof global !== 'undefined' && global.influxDBQueryStats) {
          global.influxDBQueryStats.totalQueries++;
          global.influxDBQueryStats.lastQueryTime = queryStartTime;
          
          // Track per-source stats
          if (!global.influxDBQueryStats.sources.has(this.source_id)) {
            global.influxDBQueryStats.sources.set(this.source_id, {
              lastQueryTime: null,
              lastError: null,
              errorCount: 0,
              successCount: 0
            });
          }
          const sourceStats = global.influxDBQueryStats.sources.get(this.source_id);
          sourceStats.lastQueryTime = queryStartTime;
        }
        
        // Update last timestamp from Redis before querying
        await this.updateLastTimestampFromRedis();

        let timeStartIso;
        if (this.lastDataTimestamp) {
          const bufferMs = 1000;
          timeStartIso = new Date(this.lastDataTimestamp - bufferMs).toISOString();
        } else {
          timeStartIso = new Date(Date.now() - 5000).toISOString();
        }

        const cols = ['time', ...REQUIRED_CHANNELS.map(sqlQuoteIdent)].join(', ');
        let pollSql = `SELECT ${cols} FROM ${IOX_TABLE}
WHERE time >= ${sqlStringLiteral(timeStartIso)} AND level = ${sqlStringLiteral('strm')}`;
        if (this.sourceFilter) {
          pollSql += ` AND boat = ${sqlStringLiteral(this.sourceFilter)}`;
        }
        pollSql += ' ORDER BY time LIMIT 500';

        if (this.queryCount % 10 === 0) {
          const queryInfo = this.lastDataTimestamp
            ? `querying from ${timeStartIso} (lastDataTimestamp: ${new Date(this.lastDataTimestamp).toISOString()})`
            : `querying from ${timeStartIso} (no previous data)`;
          debug(`[InfluxDBSource_v3] Source ${this.source_id} ${queryInfo}`);
        }

        let queryReturnedNewData = false;
        const dataListener = () => {
          queryReturnedNewData = true;
        };
        this.once('data', dataListener);

        await this.queryData(pollSql);
        
        // Remove listener if it wasn't called
        this.removeListener('data', dataListener);
        
        // Track successful query
        if (typeof global !== 'undefined' && global.influxDBQueryStats) {
          global.influxDBQueryStats.successfulQueries++;
          global.influxDBQueryStats.lastSuccessfulQueryTime = Date.now();
          global.influxDBQueryStats.lastQueryTime = queryStartTime;
          // Clear error on successful query
          global.influxDBQueryStats.lastQueryError = null;
          global.influxDBQueryStats.lastQueryErrorTime = null;
          
          // Track if query returned NEW data
          if (queryReturnedNewData) {
            global.influxDBQueryStats.queriesWithNewData++;
            global.influxDBQueryStats.lastQueryWithNewDataTime = Date.now();
          }
          
          const sourceStats = global.influxDBQueryStats.sources.get(this.source_id);
          if (sourceStats) {
            sourceStats.successCount++;
            sourceStats.lastQueryTime = queryStartTime;
            // Clear source-level error on successful query
            sourceStats.lastError = null;
            if (queryReturnedNewData) {
              sourceStats.queriesWithNewData = (sourceStats.queriesWithNewData || 0) + 1;
            }
          }
        }
        
        // OPTIMIZED: Reduce logging - only log every 10th query completion
        if (!this.queryCount || this.queryCount % 10 === 0) {
          debug(`[InfluxDBSource_v3] Source ${this.source_id} query completed`);
        }
        this.lastQueryTime = Date.now();
      } catch (err) {
        // Track failed query
        if (typeof global !== 'undefined' && global.influxDBQueryStats) {
          global.influxDBQueryStats.failedQueries++;
          global.influxDBQueryStats.lastQueryError = err.message;
          global.influxDBQueryStats.lastQueryErrorTime = Date.now();
          const sourceStats = global.influxDBQueryStats.sources.get(this.source_id);
          if (sourceStats) {
            sourceStats.errorCount++;
            sourceStats.lastError = err.message;
            sourceStats.lastQueryTime = queryStartTime;
          }
        }
        
        error(`[InfluxDBSource_v3] Error polling source ${this.source_id}:`, err.message);
        this.emit('error', err);
      }
    }, interval);
  }

  /**
   * Parse time range string to milliseconds
   * Supports: '1s', '1m', '1h', '1d' format
   */
  parseTimeRange(timeRange) {
    const match = timeRange.match(/^(\d+)([smhd])$/);
    if (!match) {
      warn(`[InfluxDBSource_v3] Invalid timeRange format: ${timeRange}, using default 1 minute`);
      return 60000; // Default to 1 minute
    }
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    const multipliers = {
      's': 1000,        // seconds to milliseconds
      'm': 60000,       // minutes to milliseconds
      'h': 3600000,     // hours to milliseconds
      'd': 86400000     // days to milliseconds
    };
    
    return value * (multipliers[unit] || 60000);
  }

  /**
   * Initialize last timestamp from Redis
   * Uses source_name (not source_id) as the unique identifier in Redis
   */
  async initializeLastTimestamp() {
    try {
      if (!this.source_name) {
        warn(`[InfluxDBSource_v3] Cannot initialize last timestamp - source_name not set for source_id ${this.source_id}`);
        return;
      }
      const latestTimestamp = await redisStorage.getLatestTimestamp(this.source_name);
      if (latestTimestamp) {
        this.lastDataTimestamp = latestTimestamp;
        log(`[InfluxDBSource_v3] Initialized last timestamp from Redis for source_name "${this.source_name}": ${latestTimestamp} (${new Date(latestTimestamp).toISOString()})`);
      } else {
        log(`[InfluxDBSource_v3] No existing data in Redis for source_name "${this.source_name}" (source_id ${this.source_id}), will query from config timeRange`);
      }
    } catch (err) {
      warn(`[InfluxDBSource_v3] Error initializing last timestamp for source_name "${this.source_name}":`, err.message);
    }
  }

  /**
   * Update last timestamp from Redis
   * Uses source_name (not source_id) as the unique identifier in Redis
   */
  async updateLastTimestampFromRedis() {
    try {
      if (!this.source_name) {
        return; // Silently skip if source_name not set
      }
      const latestTimestamp = await redisStorage.getLatestTimestamp(this.source_name);
      if (latestTimestamp && (!this.lastDataTimestamp || latestTimestamp > this.lastDataTimestamp)) {
        this.lastDataTimestamp = latestTimestamp;
        log(`[InfluxDBSource_v3] Source_name "${this.source_name}" (source_id ${this.source_id}) updated last timestamp from Redis: ${latestTimestamp} (${new Date(latestTimestamp).toISOString()})`);
      }
    } catch (err) {
      warn(`[InfluxDBSource_v3] Source_name "${this.source_name}" (source_id ${this.source_id}) error updating last timestamp:`, err.message);
    }
  }

  /**
   * Query data from InfluxDB 3.x using SQL (jsonl rows)
   * @param {string} sql
   */
  async queryData(sql) {
    const self = this;
    const records = await queryInfluxV3(sql);
    const timestampGroups = new Map();

    for (const record of records) {
      try {
        const timeVal = record.time || record._time;
        if (!timeVal) continue;
        const timestamp = new Date(timeVal).getTime();
        if (Number.isNaN(timestamp)) continue;

        if (!timestampGroups.has(timestamp)) {
          timestampGroups.set(timestamp, {
            source_id: self.source_id,
            timestamp,
            data: {
              source: record.boat || self.sourceFilter,
              source_name: record.boat || self.sourceFilter,
            },
          });
        }

        const dataPoint = timestampGroups.get(timestamp);

        for (const [key, value] of Object.entries(record)) {
          if (
            key === 'time' ||
            key === '_time' ||
            key === '_start' ||
            key === '_stop' ||
            key === '_field' ||
            key === '_measurement' ||
            key === 'level' ||
            key === 'result' ||
            key === 'table' ||
            key === 'boat'
          ) {
            continue;
          }
          if (value !== undefined && value !== null && value !== '') {
            const shouldConvert = key === 'LATITUDE_GPS_unk' || key === 'LONGITUDE_GPS_unk';
            if (shouldConvert && typeof value === 'number' && !Number.isNaN(value)) {
              const convertedValue = value / 10000000;
              dataPoint.data[key] = convertedValue;
              if (self.queryCount % 100 === 0) {
                debug(`[InfluxDBSource_v3] Converting GPS coordinate ${key}: ${value} -> ${convertedValue} (divided by 10^7)`);
              }
            } else {
              const numValue = parseFloat(String(value));
              dataPoint.data[key] = Number.isNaN(numValue) ? value : numValue;
            }
          }
        }
      } catch (err) {
        warn(`[InfluxDBSource_v3] Error processing row: ${err.message}`);
      }
    }

    const dataPoints = Array.from(timestampGroups.values());
    let maxTimestamp = self.lastDataTimestamp || 0;
    let newPointsCount = 0;
    let skippedPointsCount = 0;

    if (dataPoints.length === 0) {
      if (self.queryCount % 20 === 0) {
        debug(`[InfluxDBSource_v3] Source ${self.source_id} query returned no data points`);
      }
    } else {
      dataPoints.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const toleranceMs = 500;
      for (const point of dataPoints) {
        if (point.timestamp && typeof point.timestamp === 'number') {
          const pointTime = point.timestamp;
          const isNewPoint = !self.lastDataTimestamp || pointTime > (self.lastDataTimestamp - toleranceMs);
          if (isNewPoint) {
            self.emit('data', point);
            newPointsCount++;
            if (pointTime > maxTimestamp) maxTimestamp = pointTime;
          } else {
            skippedPointsCount++;
          }
        }
      }
      if (self.queryCount % 10 === 0 && (newPointsCount > 0 || skippedPointsCount > 0)) {
        debug(`[InfluxDBSource_v3] Source ${self.source_id} emitted ${newPointsCount} new points, skipped ${skippedPointsCount} old points (total: ${dataPoints.length})`);
      }
    }

    if (maxTimestamp && maxTimestamp !== self.lastDataTimestamp) {
      self.lastDataTimestamp = maxTimestamp;
      if (self.queryCount % 10 === 0) {
        debug(`[InfluxDBSource_v3] Source ${self.source_id} updated lastDataTimestamp to ${maxTimestamp} (${new Date(maxTimestamp).toISOString()})`);
      }
    }
  }


  /**
   * Disconnect from InfluxDB 3.x
   */
  disconnect() {
    this.shouldReconnect = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      log(`[InfluxDBSource_v3] Source ${this.source_id} polling interval cleared`);
    }

    this.connected = false;
    this.lastQueryTime = null;

    connectionManager.updateState(this.source_id, 'disconnected');
    log(`[InfluxDBSource_v3] Source ${this.source_id} disconnected from InfluxDB 3.x`);
  }

  /**
   * Get connection state
   */
  getState() {
    if (!this.connected) {
      return 'disconnected';
    }
    return this.isConnecting ? 'connecting' : 'connected';
  }
}

/**
 * Create and manage InfluxDB source connection
 * @param {number} source_id - Source identifier
 * @param {Object} config - InfluxDB configuration
 * @returns {InfluxDBSource} - InfluxDB source instance
 */
function createInfluxDBSource(source_id, config) {
  const connectionInfo = connectionManager.getConnection(source_id);
  if (!connectionInfo) {
    throw new Error(`Connection for source_id ${source_id} not found in connection manager`);
  }

  const influxSource = new InfluxDBSource(source_id, config);
  
  // Forward events to connection manager
  influxSource.on('connected', () => {
    connectionManager.updateState(source_id, 'connected');
  });

  influxSource.on('error', (err) => {
    connectionManager.updateState(source_id, 'error', err);
  });

  influxSource.on('data', (data) => {
    // Emit to global event for processor
    connectionManager.emit('data', data);
  });

  return influxSource;
}

module.exports = {
  InfluxDBSource,
  createInfluxDBSource
};

