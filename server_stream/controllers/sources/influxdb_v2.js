const { InfluxDB } = require('@influxdata/influxdb-client');
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

/**
 * InfluxDB 2.x Data Source Connector
 * Connects to InfluxDB 2.x using Flux queries via the official client library
 * Supports real-time polling with time-based queries
 * Matches connection pattern from 1_normalization_influx.py
 */

class InfluxDBSource extends EventEmitter {
  constructor(source_id, config) {
    super();
    this.source_id = source_id;
    this.config = config;
    this.influxClient = null;
    this.queryApi = null;
    this.isConnecting = false;
    this.shouldReconnect = true;
    this.pollInterval = null;
    this.lastQueryTime = null; // Track last query time for incremental polling
    this.lastDataTimestamp = null; // Track last data timestamp from Redis
    this.queryCount = 0; // Track query count for reduced logging
    this.bucket = null;
    this.org = null;
    this.sourceFilter = null; // Boat/source name filter
    this.source_name = null; // Source name (normalized) - used as unique identifier in Redis
  }

  /**
   * Connect to InfluxDB 2.x
   */
  async connect() {
    if (this.isConnecting) {
      warn(`[InfluxDBSource_v2] Source ${this.source_id} already connecting`);
      return;
    }

    this.isConnecting = true;
    connectionManager.updateState(this.source_id, 'connecting');

    try {
      // Get InfluxDB configuration from environment variables (matching 1_normalization_influx.py)
      const influxToken = process.env.INFLUX_TOKEN;
      const influxHost = process.env.INFLUX_HOST;
      const influxDatabase = process.env.INFLUX_DATABASE; // This is the org name
      const influxBucket = process.env.INFLUX_BUCKET;

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
      const timeoutMs = parseInt(process.env.INFLUX_TIMEOUT_MS || '120000', 10);

      // Source filter from config (e.g., 'NZL', 'GBR') - maps to 'boat' tag in InfluxDB
      this.sourceFilter = this.config.source || this.config.boat;
      
      // Store source_name for Redis operations (normalized, uppercase)
      // This is the unique identifier used in Redis, not source_id
      this.source_name = this.sourceFilter ? String(this.sourceFilter).toUpperCase().trim() : null;

      this.bucket = influxBucket;
      this.org = influxDatabase;

      log(`[InfluxDBSource_v2] Connecting source ${this.source_id} to InfluxDB 2.x: host=${influxUrl}, org=${influxDatabase}, bucket=${influxBucket}, boat=${this.sourceFilter || 'all'}`);

      // Initialize InfluxDB client
      this.influxClient = new InfluxDB({
        url: influxUrl,
        token: influxToken,
        timeout: timeoutMs
      });
      this.queryApi = this.influxClient.getQueryApi(influxDatabase);

      // Test connection by executing a simple query
      await this.checkHealth();

      this.isConnecting = false;
      connectionManager.updateState(this.source_id, 'connected');
      log(`[InfluxDBSource_v2] Source ${this.source_id} connected to InfluxDB 2.x`);

      // Start polling if configured
      const pollInterval = this.config.pollInterval || 1000; // Default 1 second
      this.startPolling(pollInterval);

      this.emit('connected');

    } catch (err) {
      this.isConnecting = false;
      error(`[InfluxDBSource_v2] Failed to connect source ${this.source_id}:`, err.message);
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
   * Check InfluxDB health using minimal query (fast and non-intrusive)
   * Uses smallest possible time range and limit to minimize impact
   */
  async checkHealth() {
    return new Promise((resolve, reject) => {
      if (!this.queryApi) {
        reject(new Error('Query API not initialized'));
        return;
      }

      // Minimal query: smallest time range (-10s), limit to 1 row, no filters
      // This is the fastest possible query that still validates the connection works
      const testQuery = `from(bucket: "${this.bucket}")
  |> range(start: -10s)
  |> limit(n: 1)`;

      let hasData = false;
      let hasError = false;

      // Reduced timeout for faster failure detection
      const timeout = setTimeout(() => {
        if (!hasData && !hasError) {
          hasError = true;
          reject(new Error('Health check timeout'));
        }
      }, 2000); // 2 seconds - fast timeout

      this.queryApi.queryRows(testQuery, {
        next() {
          // Got data immediately - resolve fast
          hasData = true;
          clearTimeout(timeout);
          resolve();
        },
        error(err) {
          if (!hasError) {
            hasError = true;
            clearTimeout(timeout);
            reject(new Error(`Health check error: ${err.message}`));
          }
        },
        complete() {
          // Query completed (with or without data) - connection is OK
          if (!hasError) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
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

    log(`[InfluxDBSource_v2] Starting polling for source ${this.source_id} every ${interval}ms`);

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

        // Build Flux query for recent data
        // Query from 1 second before lastDataTimestamp to have overlap and catch any missed data
        // This fills gaps if the service was down or there were network issues
        let timeRangeStart;
        if (this.lastDataTimestamp) {
          // Query from 1 second before lastDataTimestamp to have overlap
          // This ensures we catch any data that might have been written with slightly earlier timestamps
          // The duplicate detection logic will skip points we've already seen
          const bufferMs = 1000; // 1 second overlap
          const startTime = new Date(this.lastDataTimestamp - bufferMs);
          timeRangeStart = startTime.toISOString();
        } else {
          // No previous data, query last 5 seconds to get initial data
          timeRangeStart = '-5s';
        }
        
        // Build regex pattern for required measurements (escape special regex characters)
        const measurementsPattern = REQUIRED_CHANNELS.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        
        // Build Flux query matching pattern from 1_normalization_influx.py
        // Filter by specific measurements only (not all measurements)
        // Use time() function if we have a specific timestamp, otherwise use relative time
        const rangeClause = typeof timeRangeStart === 'string' && timeRangeStart.startsWith('-')
          ? `range(start: ${timeRangeStart})`
          : `range(start: time(v: "${timeRangeStart}"))`;
        
        let fluxQuery = `from(bucket: "${this.bucket}")
  |> ${rangeClause}
  |> filter(fn: (r) => r._measurement =~ /^(${measurementsPattern})$/)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")`;

        // Add boat filter if source is specified
        if (this.sourceFilter) {
          fluxQuery += `\n  |> filter(fn: (r) => r.boat == "${this.sourceFilter}")`;
        }

        // Aggregate data into 1-second windows using mean
        // This reduces data volume and provides consistent time intervals
        fluxQuery += `\n  |> aggregateWindow(every: 1s, fn: mean, createEmpty: false)`;

        // Pivot to get measurements as columns
        fluxQuery += `\n  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> drop(columns: ["_start", "_stop", "_field", "level", "result", "table"])
  |> sort(columns: ["_time"])`;
        
        // OPTIMIZED: Reduce logging - only log every query
        if (this.queryCount % 10 === 0) {
          const queryInfo = this.lastDataTimestamp 
            ? `querying from ${timeRangeStart} (lastDataTimestamp: ${new Date(this.lastDataTimestamp).toISOString()})`
            : `querying from ${timeRangeStart} (no previous data)`;
          debug(`[InfluxDBSource_v2] Source ${this.source_id} ${queryInfo}`);
        }

        // Track if query returns new data (will be set by queryData if data is emitted)
        let queryReturnedNewData = false;
        const dataListener = () => {
          queryReturnedNewData = true;
        };
        this.once('data', dataListener);
        
        await this.queryData(fluxQuery);
        
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
          debug(`[InfluxDBSource_v2] Source ${this.source_id} query completed`);
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
        
        error(`[InfluxDBSource_v2] Error polling source ${this.source_id}:`, err.message);
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
      warn(`[InfluxDBSource_v2] Invalid timeRange format: ${timeRange}, using default 1 minute`);
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
        warn(`[InfluxDBSource_v2] Cannot initialize last timestamp - source_name not set for source_id ${this.source_id}`);
        return;
      }
      const latestTimestamp = await redisStorage.getLatestTimestamp(this.source_name);
      if (latestTimestamp) {
        this.lastDataTimestamp = latestTimestamp;
        log(`[InfluxDBSource_v2] Initialized last timestamp from Redis for source_name "${this.source_name}": ${latestTimestamp} (${new Date(latestTimestamp).toISOString()})`);
      } else {
        log(`[InfluxDBSource_v2] No existing data in Redis for source_name "${this.source_name}" (source_id ${this.source_id}), will query from config timeRange`);
      }
    } catch (err) {
      warn(`[InfluxDBSource_v2] Error initializing last timestamp for source_name "${this.source_name}":`, err.message);
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
        log(`[InfluxDBSource_v2] Source_name "${this.source_name}" (source_id ${this.source_id}) updated last timestamp from Redis: ${latestTimestamp} (${new Date(latestTimestamp).toISOString()})`);
      }
    } catch (err) {
      warn(`[InfluxDBSource_v2] Source_name "${this.source_name}" (source_id ${this.source_id}) error updating last timestamp:`, err.message);
    }
  }

  /**
   * Query data from InfluxDB 2.x using Flux
   */
  async queryData(fluxQuery) {
    return new Promise((resolve, reject) => {
      if (!this.queryApi) {
        reject(new Error('Query API not initialized'));
        return;
      }

      // Capture 'this' for use in callbacks
      const self = this;
      const dataPoints = [];
      const timestampGroups = new Map();
      let hasError = false;

      const timeout = setTimeout(() => {
        if (!hasError) {
          hasError = true;
          reject(new Error('Query timeout'));
        }
      }, 30000);

      this.queryApi.queryRows(fluxQuery, {
        next(row, tableMeta) {
          try {
            // Convert row to object using tableMeta.toObject
            const record = tableMeta.toObject(row);
            
            // Extract timestamp from _time (RFC3339 string) and convert to milliseconds
            let timestamp = null;
            if (record._time) {
              const timeDate = new Date(record._time);
              timestamp = timeDate.getTime(); // milliseconds
            } else {
              return; // Skip rows without timestamp
            }

            // Get or create data point for this timestamp
            if (!timestampGroups.has(timestamp)) {
              timestampGroups.set(timestamp, {
                source_id: self.source_id,
                timestamp: timestamp,
                data: {
                  source: record.boat || self.sourceFilter,
                  source_name: record.boat || self.sourceFilter
                }
              });
            }

            const dataPoint = timestampGroups.get(timestamp);

            // Add all measurement fields to data point (excluding metadata fields)
            for (const [key, value] of Object.entries(record)) {
              if (key !== '_time' && key !== '_start' && key !== '_stop' && 
                  key !== '_field' && key !== '_measurement' && key !== 'level' && 
                  key !== 'result' && key !== 'table' && key !== 'boat') {
                if (value !== undefined && value !== null && value !== '') {
                  // Apply GPS coordinate conversion (divide by 10^7) ONLY for specific channels
                  // Only convert LATITUDE_GPS_unk and LONGITUDE_GPS_unk - all other channels should remain unchanged
                  const shouldConvert = key === 'LATITUDE_GPS_unk' || key === 'LONGITUDE_GPS_unk';
                  
                  if (shouldConvert && typeof value === 'number' && !isNaN(value)) {
                    // Convert GPS coordinate: move decimal 7 places to the left
                    const convertedValue = value / 10000000;
                    dataPoint.data[key] = convertedValue;
                    if (self.queryCount % 100 === 0) { // Log occasionally
                      debug(`[InfluxDBSource_v2] Converting GPS coordinate ${key}: ${value} -> ${convertedValue} (divided by 10^7)`);
                    }
                  } else {
                    // Try to parse as number, otherwise keep as string
                    const numValue = parseFloat(value);
                    dataPoint.data[key] = isNaN(numValue) ? value : numValue;
                  }
                }
              }
            }
          } catch (err) {
            warn(`[InfluxDBSource_v2] Error processing row: ${err.message}`);
            // Continue processing other rows
          }
        },
        error(err) {
          if (!hasError) {
            hasError = true;
            clearTimeout(timeout);
            reject(new Error(`Query error: ${err.message}`));
          }
        },
        complete() {
          if (!hasError) {
            clearTimeout(timeout);
            
            // Convert map to array
            dataPoints.push(...Array.from(timestampGroups.values()));

            // Emit ALL new data points (those with timestamps > lastDataTimestamp)
            // This fills gaps when the service resumes after being down
            let maxTimestamp = self.lastDataTimestamp || 0;
            let newPointsCount = 0;
            let skippedPointsCount = 0;
            
            if (dataPoints.length === 0) {
              // Only log empty queries occasionally
              if (self.queryCount % 20 === 0) {
                debug(`[InfluxDBSource_v2] Source ${self.source_id} query returned no data points`);
              }
            } else {
              // Sort data points by timestamp to ensure chronological order
              dataPoints.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
              
              // Emit all points that are newer than lastDataTimestamp
              for (const point of dataPoints) {
                if (point.timestamp && typeof point.timestamp === 'number') {
                  const pointTime = point.timestamp;
                  
                  // Only emit points that are newer than lastDataTimestamp (with small tolerance for clock drift)
                  // Use 500ms tolerance to handle minor timestamp differences
                  const toleranceMs = 500;
                  const isNewPoint = !self.lastDataTimestamp || pointTime > (self.lastDataTimestamp - toleranceMs);
                  
                  if (isNewPoint) {
                    self.emit('data', point);
                    newPointsCount++;
                    
                    // Update maxTimestamp to track the latest point we've seen
                    if (pointTime > maxTimestamp) {
                      maxTimestamp = pointTime;
                    }
                  } else {
                    skippedPointsCount++;
                  }
                }
              }
              
              // OPTIMIZED: Reduce logging - only log every 10th query
              if (self.queryCount % 10 === 0 && (newPointsCount > 0 || skippedPointsCount > 0)) {
                debug(`[InfluxDBSource_v2] Source ${self.source_id} emitted ${newPointsCount} new points, skipped ${skippedPointsCount} old points (total: ${dataPoints.length})`);
              }
            }
            
            // Update lastDataTimestamp if we got newer data
            if (maxTimestamp && maxTimestamp !== self.lastDataTimestamp) {
              self.lastDataTimestamp = maxTimestamp;
              // OPTIMIZED: Only log timestamp updates occasionally
              if (self.queryCount % 10 === 0) {
                debug(`[InfluxDBSource_v2] Source ${self.source_id} updated lastDataTimestamp to ${maxTimestamp} (${new Date(maxTimestamp).toISOString()})`);
              }
            }

            resolve();
          }
        }
      });
    });
  }


  /**
   * Disconnect from InfluxDB 2.x
   */
  disconnect() {
    this.shouldReconnect = false;

    // Stop polling immediately - clear interval first to prevent any pending queries
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      log(`[InfluxDBSource_v2] Source ${this.source_id} polling interval cleared`);
    }

    // Clean up InfluxDB client connection
    // Note: InfluxDB v2 client doesn't have a close() method - it's stateless
    // Just clear references to allow garbage collection
    if (this.influxClient) {
      // The InfluxDB client from @influxdata/influxdb-client is stateless
      // and doesn't require explicit cleanup. Just clear the reference.
      this.influxClient = null;
    }
    this.queryApi = null;
    this.lastQueryTime = null;

    connectionManager.updateState(this.source_id, 'disconnected');
    log(`[InfluxDBSource_v2] Source ${this.source_id} disconnected from InfluxDB 2.x`);
  }

  /**
   * Get connection state
   */
  getState() {
    if (!this.influxClient || !this.queryApi) {
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

