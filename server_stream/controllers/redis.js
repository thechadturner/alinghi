const Redis = require('ioredis');
const fs = require('fs');
const { log, error, warn, debug } = require('../../shared');
const config = require('../middleware/config');
const EventEmitter = require('events');

/**
 * Redis Time-Series Storage
 * Uses Redis sorted sets (ZADD) for time-series storage
 * Key pattern: stream:source_name (one key per source, like a table)
 * Score: timestamp (primary key)
 * Member: JSON object with all channel values at that timestamp
 * Implements data retention policies and batch writes
 * Ensures unique timestamps per source_name (no duplicates)
 */

class RedisStorage extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isConnected = false;
    this.isInitialConnection = true; // Track if this is the first connection attempt
    this.connectionStartTime = null; // Track when connection attempt started
    this.writeBuffer = new Map(); // source_name -> Map(timestamp -> Map(channel -> value))
    this.pendingDataPoints = new Map(); // source_name -> Map(timestamp -> {channels: Map})
    this.batchWriteInterval = null;
    this.batchSize = 100; // Write batch when buffer reaches this size
    this.batchInterval = 5000; // Write batch every 5 seconds
    this.retentionHours = 24; // Keep last 24 hours of data
    this.flushDelay = 10; // Delay in ms before flushing accumulated channels (reduced from 100ms for better performance)
    // Track actual Redis write stats (separate from buffering stats)
    this.flushStats = {
      successCount: 0,
      errorCount: 0,
      lastError: null,
      lastErrorTime: null,
      lastSuccessTime: null,
      lastFlushedTimestamp: null,
      lastFlushedSource: null
    };
    
    // Lua script for atomic add-or-replace at timestamp (faster than check-then-add)
    // This ensures only one entry per timestamp in a single Redis operation
    this.addOrReplaceScript = `
      local key = KEYS[1]
      local score = tonumber(ARGV[1])
      local member = ARGV[2]
      
      -- Remove any existing entries at this exact timestamp
      local existing = redis.call('ZRANGEBYSCORE', key, score, score, 'LIMIT', 0, 10)
      if #existing > 0 then
        for i = 1, #existing do
          redis.call('ZREM', key, existing[i])
        end
      end
      
      -- Add the new entry
      redis.call('ZADD', key, score, member)
      return 1
    `;
    this.addOrReplaceSha = null; // Will be loaded on first use
  }

  /**
   * Connect to Redis
   */
  async connect() {
    try {
      // If we have an existing client that's disconnected, clean it up first
      if (this.client && !this.isConnected) {
        try {
          await this.client.quit();
        } catch (err) {
          // Ignore errors during cleanup
        }
        this.client = null;
      }

      // If creating a new client (no existing client or disconnected), treat as initial connection
      if (!this.client) {
        this.isInitialConnection = true;
        this.connectionStartTime = Date.now();
      }

      // Detect if running in Docker
      const isDocker = config.DOCKER_CONTAINER === 'true' || 
                      config.DOCKER_CONTAINER === true ||
                      fs.existsSync('/.dockerenv');
      
      // Determine Redis host
      let redisHost = config.REDIS_HOST;
      if (!redisHost) {
        // No REDIS_HOST set, use default based on environment
        redisHost = isDocker ? 'redis' : 'localhost';
      } else if (redisHost === 'redis' && !isDocker) {
        // REDIS_HOST is "redis" but we're not in Docker - fall back to localhost
        warn(`[RedisStorage] REDIS_HOST is set to "redis" but not running in Docker. Using "localhost" instead.`);
        redisHost = 'localhost';
      }

      const redisConfig = {
        host: redisHost,
        port: config.REDIS_PORT || 6379,
        password: config.REDIS_PASSWORD || undefined,
        db: config.REDIS_DB || 0,
        retryStrategy: (times) => {
          // For initial connection, allow longer delays to handle Redis AOF loading
          // Redis can take 10-30 seconds to load AOF files on startup
          if (this.isInitialConnection) {
            // Exponential backoff with longer max delay for initial connection
            // First few retries: 100ms, 200ms, 400ms, 800ms, 1600ms...
            // Cap at 5 seconds for initial connection (to handle AOF loading)
            const delay = Math.min(100 * Math.pow(2, times - 1), 5000);
            return delay;
          } else {
            // For reconnections after initial connection, use shorter delays
            const delay = Math.min(times * 50, 2000);
            return delay;
          }
        },
        maxRetriesPerRequest: 3,
        connectTimeout: 10000, // 10 second connection timeout
        lazyConnect: false // Connect immediately
      };

      log(`[RedisStorage] Connecting to Redis at ${redisConfig.host}:${redisConfig.port}`);
      
      // Log configuration for debugging
      if (config.REDIS_HOST) {
        log(`[RedisStorage] REDIS_HOST from environment: ${config.REDIS_HOST} (using: ${redisHost})`);
      } else {
        log(`[RedisStorage] Using default REDIS_HOST: ${redisHost} (Docker: ${isDocker})`);
      }

      this.client = new Redis(redisConfig);

      this.client.on('connect', () => {
        log('[RedisStorage] Connected to Redis');
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        log('[RedisStorage] Redis client ready');
        // Mark initial connection as complete once we're ready
        if (this.isInitialConnection) {
          const connectionTime = Date.now() - this.connectionStartTime;
          log(`[RedisStorage] Initial connection established in ${connectionTime}ms`);
          this.isInitialConnection = false;
          this.connectionStartTime = null;
        }
      });

      this.client.on('error', (err) => {
        // During initial connection, Redis might be loading AOF files
        // Use warn/debug instead of error to reduce noise
        const isInitialConnectionError = this.isInitialConnection && 
                                        (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT');
        const elapsedTime = this.connectionStartTime ? Date.now() - this.connectionStartTime : 0;
        
        if (isInitialConnectionError && elapsedTime < 30000) {
          // During first 30 seconds, these errors are likely due to Redis startup
          debug(`[RedisStorage] Redis connection attempt failed (Redis may still be loading): ${err.message}`);
          debug(`[RedisStorage] Elapsed time: ${elapsedTime}ms - will retry with exponential backoff`);
        } else {
          error('[RedisStorage] Redis error:', err.message);
          debug(`[RedisStorage] Redis connection details: host=${redisConfig.host}, port=${redisConfig.port}`);
          
          if (err.code === 'ENOTFOUND') {
            error(`[RedisStorage] DNS resolution failed for hostname "${redisConfig.host}". Check your REDIS_HOST environment variable.`);
            error(`[RedisStorage] If running locally, use "localhost". If in Docker, use the Redis service name.`);
          } else if (err.code === 'ECONNREFUSED') {
            if (this.isInitialConnection && elapsedTime < 30000) {
              // Still in initial connection window - likely Redis startup
              warn(`[RedisStorage] Connection refused to ${redisConfig.host}:${redisConfig.port} (Redis may still be loading AOF files)`);
              warn(`[RedisStorage] This is normal during Redis startup. Will continue retrying...`);
            } else {
              // Past initial window or not initial connection - treat as real error
              error(`[RedisStorage] Connection refused to ${redisConfig.host}:${redisConfig.port}. Possible causes:`);
              error(`[RedisStorage] 1. Redis service is not running - check with: docker ps | grep redis`);
              error(`[RedisStorage] 2. Redis is not listening on ${redisConfig.host}:${redisConfig.port}`);
              error(`[RedisStorage] 3. Firewall or network configuration is blocking the connection`);
              error(`[RedisStorage] 4. Wrong REDIS_HOST or REDIS_PORT environment variable`);
              error(`[RedisStorage] If in Docker, ensure services are on the same network (hunico-network)`);
              error(`[RedisStorage] If running locally, ensure Redis is running: redis-cli ping`);
            }
          }
        }
        this.isConnected = false;
      });

      this.client.on('close', () => {
        warn('[RedisStorage] Redis connection closed');
        this.isConnected = false;
      });

      this.client.on('reconnecting', (delay) => {
        if (this.isInitialConnection) {
          const elapsedTime = this.connectionStartTime ? Date.now() - this.connectionStartTime : 0;
          debug(`[RedisStorage] Reconnecting to Redis... (attempt after ${elapsedTime}ms, retry delay: ${delay}ms)`);
        } else {
          log(`[RedisStorage] Reconnecting to Redis... (retry delay: ${delay}ms)`);
        }
      });

      // Start batch write interval
      this.startBatchWrites();

      // Start retention cleanup interval
      this.startRetentionCleanup();

      return true;
    } catch (err) {
      error('[RedisStorage] Failed to connect to Redis:', err.message);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Store a data point (channel value)
   * Accumulates channels for the same timestamp before storing
   * @param {string} source_name - Source name (normalized, uppercase)
   * @param {string} channel - Channel name
   * @param {number} timestamp - Timestamp (score)
   * @param {*} value - Value to store
   */
  async store(source_name, channel, timestamp, value) {
    // Validate source_name
    if (!source_name || typeof source_name !== 'string') {
      warn(`[RedisStorage] Invalid or missing source_name, rejecting data point for channel ${channel}`);
      return;
    }

    // Normalize source_name
    const normalizedSourceName = String(source_name).toUpperCase().trim();
    
    if (!this.isConnected || !this.client) {
      warn('[RedisStorage] Redis not connected, buffering data point');
      this.bufferWrite(normalizedSourceName, channel, timestamp, value);
      return;
    }

    try {
      // Get or create pending data point for this timestamp
      if (!this.pendingDataPoints.has(normalizedSourceName)) {
        this.pendingDataPoints.set(normalizedSourceName, new Map());
      }

      const sourcePending = this.pendingDataPoints.get(normalizedSourceName);
      
      // If timestamp already exists in buffer, merge channels into existing entry
      if (!sourcePending.has(timestamp)) {
        sourcePending.set(timestamp, {
          channels: new Map(),
          flushTimer: null
        });
      }

      const dataPoint = sourcePending.get(timestamp);
      dataPoint.channels.set(channel, value);

      // Clear existing flush timer and set new one
      if (dataPoint.flushTimer) {
        clearTimeout(dataPoint.flushTimer);
      }

      // Schedule flush after delay (allows more channels to arrive)
      dataPoint.flushTimer = setTimeout(() => {
        this.flushDataPoint(normalizedSourceName, timestamp);
      }, this.flushDelay);

    } catch (err) {
      error(`[RedisStorage] Error storing data point for source "${normalizedSourceName}", channel ${channel}:`, err.message);
      // Buffer the write for retry
      this.bufferWrite(normalizedSourceName, channel, timestamp, value);
    }
  }

  /**
   * Store a complete data point (all channels for a timestamp) directly to Redis
   * Bypasses batching delay - use when all channels arrive together
   * @param {string} source_name - Source name (normalized, uppercase)
   * @param {number} timestamp - Timestamp
   * @param {Object} channels - Object with channel name -> value mappings
   */
  async storeDataPoint(source_name, timestamp, channels) {
    // Validate source_name
    if (!source_name || typeof source_name !== 'string') {
      warn(`[RedisStorage] Invalid or missing source_name, rejecting data point`);
      return;
    }

    // Normalize source_name
    const normalizedSourceName = String(source_name).toUpperCase().trim();
    
    if (!this.isConnected || !this.client) {
      warn('[RedisStorage] Redis not connected, cannot store data point');
      return;
    }

    try {
      // Create JSON object with all channel values
      const dataObject = { ...channels };
      // Add timestamp to the object for convenience
      dataObject.timestamp = timestamp;

      const key = this.getKey(normalizedSourceName);
      const score = timestamp;
      const member = JSON.stringify(dataObject);
      const latestKey = this.getLatestKey(normalizedSourceName);

      // OPTIMIZED: Use Lua script for atomic add-or-replace in single round trip
      // This ensures only one entry per timestamp without multiple Redis operations
      try {
        // Load script on first use (or use cached SHA)
        if (!this.addOrReplaceSha) {
          this.addOrReplaceSha = await this.client.script('LOAD', this.addOrReplaceScript);
        }
        
        // Execute script atomically (one round trip)
        await this.client.evalsha(this.addOrReplaceSha, 1, key, score.toString(), member);
      } catch (err) {
        // If script execution fails (e.g., script not loaded), fall back to simple ZADD
        // This handles edge cases where script might not be available
        if (err.message && err.message.includes('NOSCRIPT')) {
          // Script not loaded, load it and retry
          this.addOrReplaceSha = await this.client.script('LOAD', this.addOrReplaceScript);
          await this.client.evalsha(this.addOrReplaceSha, 1, key, score.toString(), member);
        } else {
          // Fallback to simple ZADD if script fails
          await this.client.zadd(key, score, member);
        }
      }
      
      // Update hash with latest snapshot (after successful ZADD)
      // Use pipeline for atomic update of hash fields
      try {
        await this.client.hset(latestKey, {
          data: member,
          timestamp: timestamp.toString(),
          updated_at: Date.now().toString()
        });
      } catch (hashErr) {
        // Hash update failure is non-critical - log but don't fail the operation
        // The sorted set update succeeded, so we continue
        warn(`[RedisStorage] Failed to update hash for latest snapshot (non-critical): ${hashErr.message}`);
      }
      
      // Update metadata asynchronously (don't wait for it - fire and forget)
      // Metadata is not critical for write completion, so we don't block on it
      setImmediate(() => {
        this.updateMetadata(normalizedSourceName, timestamp, Object.keys(channels)).catch(err => {
          // Silently handle metadata update errors - not critical
          debug(`[RedisStorage] Metadata update failed (non-critical): ${err.message}`);
        });
      });

      // Track successful write
      this.flushStats.successCount++;
      this.flushStats.lastSuccessTime = Date.now();
      this.flushStats.lastFlushedTimestamp = timestamp;
      this.flushStats.lastFlushedSource = normalizedSourceName;
      
      // Emit event for tracking (async, don't wait)
      setImmediate(() => {
        this.emit('flushSuccess', { source_name: normalizedSourceName, timestamp, channels: Object.keys(channels) });
      });

    } catch (err) {
      // Track failed write
      this.flushStats.errorCount++;
      this.flushStats.lastError = err.message;
      this.flushStats.lastErrorTime = Date.now();
      
      // Log detailed error information
      error(`[RedisStorage] Error storing data point for "${normalizedSourceName}" at timestamp ${timestamp}:`, {
        error: err.message,
        errorStack: err.stack,
        source_name: normalizedSourceName,
        timestamp,
        channelCount: channels ? Object.keys(channels).length : 0,
        isConnected: this.isConnected,
        hasClient: !!this.client,
        clientReady: this.client?.status === 'ready'
      });
      
      // Emit event for tracking
      this.emit('flushError', { source_name: normalizedSourceName, timestamp, error: err.message });
    }
  }

  /**
   * Flush a complete data point (all channels for a timestamp) to Redis
   * Ensures unique timestamps by removing existing entries before adding
   * @param {string} source_name - Source name (normalized)
   * @param {number} timestamp - Timestamp
   */
  async flushDataPoint(source_name, timestamp) {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const sourcePending = this.pendingDataPoints.get(source_name);
      if (!sourcePending || !sourcePending.has(timestamp)) {
        return;
      }

      const dataPoint = sourcePending.get(timestamp);
      const channels = dataPoint.channels;

      // Clear the flush timer
      if (dataPoint.flushTimer) {
        clearTimeout(dataPoint.flushTimer);
        dataPoint.flushTimer = null;
      }

      // Create JSON object with all channel values
      const dataObject = {};
      for (const [channel, value] of channels.entries()) {
        dataObject[channel] = value;
      }

      // Add timestamp to the object for convenience
      dataObject.timestamp = timestamp;

      const key = this.getKey(source_name);
      const score = timestamp;
      const member = JSON.stringify(dataObject);

      // CRITICAL: Ensure unique timestamps - check if entry exists at this exact timestamp
      const existing = await this.client.zrangebyscore(key, score, score, 'LIMIT', 0, 10);
      
      if (existing.length > 0) {
        // Entry exists at this timestamp - remove old entries and add merged one
        // This ensures only one entry per timestamp (no duplicates)
        for (const oldMember of existing) {
          await this.client.zrem(key, oldMember);
        }
        
        // Parse existing data and merge with new channels
        if (existing.length > 0) {
          try {
            const existingData = JSON.parse(existing[0]);
            // Merge: new channels override old ones
            const mergedData = { ...existingData, ...dataObject };
            // Ensure timestamp is correct
            mergedData.timestamp = timestamp;
            await this.client.zadd(key, score, JSON.stringify(mergedData));
          } catch (parseErr) {
            // If parse fails, just use new data
            await this.client.zadd(key, score, member);
          }
        } else {
          await this.client.zadd(key, score, member);
        }
      } else {
        // No existing entry, add new one
        await this.client.zadd(key, score, member);
      }

      // Update metadata
      await this.updateMetadata(source_name, timestamp, Array.from(channels.keys()));

      // Remove from pending
      sourcePending.delete(timestamp);
      if (sourcePending.size === 0) {
        this.pendingDataPoints.delete(source_name);
      }

      // Track successful flush
      this.flushStats.successCount++;
      this.flushStats.lastSuccessTime = Date.now();
      this.flushStats.lastFlushedTimestamp = timestamp;
      this.flushStats.lastFlushedSource = source_name;
      
      // Emit event for tracking
      this.emit('flushSuccess', { source_name, timestamp, channels: Array.from(channels.keys()) });

    } catch (err) {
      // Track failed flush
      this.flushStats.errorCount++;
      this.flushStats.lastError = err.message;
      this.flushStats.lastErrorTime = Date.now();
      
      error(`[RedisStorage] Error flushing data point for "${source_name}" at timestamp ${timestamp}:`, err.message);
      
      // Emit event for tracking
      this.emit('flushError', { source_name, timestamp, error: err.message });
    }
  }

  /**
   * Buffer a write for batch processing
   * @param {string} source_name - Source name (normalized)
   * @param {string} channel - Channel name
   * @param {number} timestamp - Timestamp
   * @param {*} value - Value to store
   */
  bufferWrite(source_name, channel, timestamp, value) {
    if (!this.writeBuffer.has(source_name)) {
      this.writeBuffer.set(source_name, new Map());
    }

    const sourceBuffer = this.writeBuffer.get(source_name);
    
    // Group by timestamp
    if (!sourceBuffer.has(timestamp)) {
      sourceBuffer.set(timestamp, new Map());
    }

    // Store channel value for this timestamp
    sourceBuffer.get(timestamp).set(channel, value);

    // Check if we should flush the buffer
    const totalBuffered = Array.from(this.writeBuffer.values())
      .reduce((sum, timestamps) => 
        sum + Array.from(timestamps.values()).reduce((s, channels) => s + channels.size, 0), 0);

    if (totalBuffered >= this.batchSize) {
      this.flushBuffer();
    }
  }

  /**
   * Start batch write interval
   */
  startBatchWrites() {
    if (this.batchWriteInterval) {
      clearInterval(this.batchWriteInterval);
    }

    this.batchWriteInterval = setInterval(() => {
      this.flushBuffer();
    }, this.batchInterval);
  }

  /**
   * Flush write buffer to Redis
   * Groups channels by timestamp and stores as JSON objects
   * Ensures unique timestamps by removing existing entries before adding
   */
  async flushBuffer() {
    if (this.writeBuffer.size === 0 || !this.isConnected || !this.client) {
      return;
    }

    try {
      for (const [source_name, timestamps] of this.writeBuffer.entries()) {
        for (const [timestamp, channels] of timestamps.entries()) {
          // Create JSON object with all channels for this timestamp
          const dataObject = {};
          for (const [channel, value] of channels.entries()) {
            dataObject[channel] = value;
          }
          dataObject.timestamp = timestamp;

          const key = this.getKey(source_name);
          const score = timestamp;
          const member = JSON.stringify(dataObject);

          // CRITICAL: Ensure unique timestamps
          const existing = await this.client.zrangebyscore(key, score, score, 'LIMIT', 0, 10);
          
          if (existing.length > 0) {
            // Remove existing entries at this timestamp
            for (const oldMember of existing) {
              await this.client.zrem(key, oldMember);
            }
            
            // Merge with existing data if possible
            if (existing.length > 0) {
              try {
                const existingData = JSON.parse(existing[0]);
                const mergedData = { ...existingData, ...dataObject };
                mergedData.timestamp = timestamp;
                await this.client.zadd(key, score, JSON.stringify(mergedData));
              } catch (parseErr) {
                await this.client.zadd(key, score, member);
              }
            } else {
              await this.client.zadd(key, score, member);
            }
          } else {
            await this.client.zadd(key, score, member);
          }

          // Update metadata
          await this.updateMetadata(source_name, timestamp, Array.from(channels.keys()));
        }
      }

      // Clear buffer
      this.writeBuffer.clear();

      debug(`[RedisStorage] Flushed write buffer`);

    } catch (err) {
      error('[RedisStorage] Error flushing buffer:', err.message);
    }
  }

  /**
   * Query data by time range
   * @param {string} source_name - Source name (normalized)
   * @param {string} channel - Channel name to extract
   * @param {number} startTime - Start timestamp
   * @param {number} endTime - End timestamp
   * @returns {Array} - Array of data points with {timestamp, value}
   */
  async query(source_name, channel, startTime, endTime) {
    if (!this.isConnected || !this.client) {
      warn('[RedisStorage] Redis not connected, cannot query');
      return [];
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const key = this.getKey(normalizedSourceName);
      const results = await this.client.zrangebyscore(
        key,
        startTime,
        endTime,
        'WITHSCORES'
      );

      const dataPoints = [];
      for (let i = 0; i < results.length; i += 2) {
        try {
          const dataObject = JSON.parse(results[i]);
          const timestamp = parseFloat(results[i + 1]);
          
          // Extract requested channel from the data object
          const value = dataObject[channel] !== undefined ? dataObject[channel] : null;
          
          dataPoints.push({ timestamp, value });
        } catch (parseErr) {
          // Skip invalid JSON entries
          debug(`[RedisStorage] Skipping invalid JSON entry at timestamp ${results[i + 1]}`);
        }
      }

      // CRITICAL: Ensure data is sorted by timestamp (millisecond precision)
      // Redis zrangebyscore should return sorted data, but we sort explicitly to guarantee order
      dataPoints.sort((a, b) => a.timestamp - b.timestamp);

      return dataPoints;

    } catch (err) {
      error(`[RedisStorage] Error querying data for source "${source_name}", channel ${channel}:`, err.message);
      return [];
    }
  }

  /**
   * Get latest data point for a channel
   * @param {string} source_name - Source name (normalized)
   * @param {string} channel - Channel name to extract
   * @returns {Object|null} - Latest data point with {timestamp, value} or null
   */
  async getLatest(source_name, channel) {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const latestKey = this.getLatestKey(normalizedSourceName);
      
      // Try hash first (O(1) lookup)
      const hashData = await this.client.hgetall(latestKey);
      
      if (hashData && hashData.data) {
        try {
          const dataObject = JSON.parse(hashData.data);
          const timestamp = parseFloat(hashData.timestamp || dataObject.timestamp);
          
          // Extract requested channel from the data object
          const value = dataObject[channel] !== undefined ? dataObject[channel] : null;

          return { timestamp, value };
        } catch (parseErr) {
          warn(`[RedisStorage] Error parsing hash data for source "${source_name}":`, parseErr.message);
          // Fall through to sorted set fallback
        }
      }
      
      // Fallback to sorted set (backward compatibility)
      const key = this.getKey(normalizedSourceName);
      const results = await this.client.zrange(key, -1, -1, 'WITHSCORES');

      if (results.length === 0) {
        return null;
      }

      try {
        const dataObject = JSON.parse(results[0]);
        const timestamp = parseFloat(results[1]);
        
        // Extract requested channel from the data object
        const value = dataObject[channel] !== undefined ? dataObject[channel] : null;

        return { timestamp, value };
      } catch (parseErr) {
        error(`[RedisStorage] Error parsing latest data for source "${source_name}":`, parseErr.message);
        return null;
      }

    } catch (err) {
      error(`[RedisStorage] Error getting latest for source "${source_name}", channel ${channel}:`, err.message);
      return null;
    }
  }

  /**
   * Get available channels for a source
   * @param {string} source_name - Source name (normalized)
   * @returns {Array<string>} - Array of channel names
   */
  async getChannels(source_name) {
    if (!this.isConnected || !this.client) {
      return [];
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const key = this.getKey(normalizedSourceName);
      
      // Get latest entry to extract channel names
      const results = await this.client.zrange(key, -1, -1, 'WITHSCORES');
      
      if (results.length === 0) {
        return [];
      }

      try {
        const dataObject = JSON.parse(results[0]);
        // Return all keys except timestamp
        const channels = Object.keys(dataObject).filter(k => k !== 'timestamp');
        return channels;
      } catch (parseErr) {
        error(`[RedisStorage] Error parsing channels for source "${source_name}":`, parseErr.message);
        return [];
      }

    } catch (err) {
      error(`[RedisStorage] Error getting channels for source "${source_name}":`, err.message);
      return [];
    }
  }

  /**
   * Get the latest timestamp for a source
   * @param {string} source_name - Source name (normalized)
   * @returns {number|null} - Latest timestamp or null if no data exists
   */
  async getLatestTimestamp(source_name) {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const key = this.getKey(normalizedSourceName);
      
      // Get latest entry (highest score = latest timestamp)
      const results = await this.client.zrange(key, -1, -1, 'WITHSCORES');
      
      if (results.length === 0) {
        return null;
      }

      return parseFloat(results[1]);

    } catch (err) {
      error(`[RedisStorage] Error getting latest timestamp for source "${source_name}":`, err.message);
      return null;
    }
  }

  /**
   * Get latest snapshot from hash (O(1) lookup)
   * Falls back to sorted set if hash doesn't exist (backward compatibility)
   * @param {string} source_name - Source name (normalized)
   * @returns {Object|null} - Latest data point as parsed JSON object, or null if no data
   */
  async getLatestSnapshot(source_name) {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const latestKey = this.getLatestKey(normalizedSourceName);
      
      // Try hash first (O(1) lookup)
      const hashData = await this.client.hgetall(latestKey);
      
      if (hashData && hashData.data) {
        try {
          const dataObject = JSON.parse(hashData.data);
          return dataObject;
        } catch (parseErr) {
          warn(`[RedisStorage] Error parsing hash data for source "${source_name}":`, parseErr.message);
          // Fall through to sorted set fallback
        }
      }
      
      // Fallback to sorted set (backward compatibility)
      const key = this.getKey(normalizedSourceName);
      const results = await this.client.zrange(key, -1, -1, 'WITHSCORES');
      
      if (results.length === 0) {
        return null;
      }

      try {
        const dataObject = JSON.parse(results[0]);
        return dataObject;
      } catch (parseErr) {
        error(`[RedisStorage] Error parsing latest data from sorted set for source "${source_name}":`, parseErr.message);
        return null;
      }

    } catch (err) {
      error(`[RedisStorage] Error getting latest snapshot for source "${source_name}":`, err.message);
      return null;
    }
  }

  /**
   * Get earliest timestamp for a source
   * @param {string} source_name - Source name (normalized)
   * @returns {number|null} - Earliest timestamp or null if no data
   */
  async getEarliestTimestamp(source_name) {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const key = this.getKey(normalizedSourceName);
      
      // Get earliest entry (lowest score = earliest timestamp)
      // Use ZRANGE to get first element (index 0) which has the lowest score
      const results = await this.client.zrange(key, 0, 0, 'WITHSCORES');
      
      if (results.length < 2) {
        return null;
      }

      // WITHSCORES returns: [member0, score0]
      // results[0] = member (JSON data), results[1] = score (timestamp)
      return parseFloat(results[1]);

    } catch (err) {
      error(`[RedisStorage] Error getting earliest timestamp for source "${source_name}":`, err.message);
      return null;
    }
  }

  /**
   * Update metadata for a source
   * @param {string} source_name - Source name (normalized)
   * @param {number} timestamp - Latest timestamp
   * @param {Array<string>} channels - Array of channel names
   */
  async updateMetadata(source_name, timestamp, channels) {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const normalizedSourceName = String(source_name).toUpperCase().trim();
      const metadataKey = this.getMetadataKey(normalizedSourceName);
      
      // Use pipeline to batch metadata updates (faster than sequential HSETs)
      const pipeline = this.client.pipeline();
      pipeline.hset(metadataKey, 'last_timestamp', timestamp);
      pipeline.hset(metadataKey, 'last_update', Date.now());
      await pipeline.exec();

    } catch (err) {
      error(`[RedisStorage] Error updating metadata for source "${source_name}":`, err.message);
    }
  }

  /**
   * Start retention cleanup interval
   */
  startRetentionCleanup() {
    // Run cleanup every hour
    setInterval(async () => {
      await this.cleanupOldData();
    }, 3600000); // 1 hour
  }

  /**
   * Cleanup old data based on retention policy
   */
  async cleanupOldData() {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const cutoffTime = Date.now() - (this.retentionHours * 3600000);
      
      // Find all stream keys (excluding metadata keys)
      const keys = await this.client.keys('stream:*');
      const dataKeys = keys.filter(k => !k.endsWith(':meta'));
      
      for (const key of dataKeys) {
        // Remove data older than retention period
        await this.client.zremrangebyscore(key, 0, cutoffTime);
      }

      log(`[RedisStorage] Cleaned up data older than ${this.retentionHours} hours`);

    } catch (err) {
      error('[RedisStorage] Error during cleanup:', err.message);
    }
  }

  /**
   * Get Redis key for a source
   * @param {string} source_name - Source name (normalized)
   * @returns {string} - Redis key
   */
  getKey(source_name) {
    const normalizedSourceName = String(source_name).toUpperCase().trim();
    return `stream:${normalizedSourceName}`;
  }

  /**
   * Get metadata key for a source
   * @param {string} source_name - Source name (normalized)
   * @returns {string} - Metadata key
   */
  getMetadataKey(source_name) {
    const normalizedSourceName = String(source_name).toUpperCase().trim();
    return `stream:${normalizedSourceName}:meta`;
  }

  /**
   * Get latest snapshot hash key for a source
   * @param {string} source_name - Source name (normalized)
   * @returns {string} - Latest snapshot hash key
   */
  getLatestKey(source_name) {
    const normalizedSourceName = String(source_name).toUpperCase().trim();
    return `hash:${normalizedSourceName}:latest`;
  }

  /**
   * Flush entire Redis database (remove all keys)
   * Use with caution - this deletes all data!
   */
  async flushDatabase() {
    if (!this.isConnected || !this.client) {
      warn('[RedisStorage] Cannot flush database - not connected to Redis');
      return false;
    }

    try {
      log('[RedisStorage] Flushing Redis database...');
      await this.client.flushdb();
      log('[RedisStorage] Redis database flushed successfully');
      return true;
    } catch (err) {
      error('[RedisStorage] Error flushing database:', err.message);
      return false;
    }
  }

  /**
   * Get the latest timestamp across all sources in Redis
   * Returns the most recent timestamp, or null if no data exists
   */
  async getLatestTimestampAcrossAllSources() {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      // Use SCAN instead of KEYS to avoid blocking and memory issues
      const dataKeys = [];
      let cursor = '0';
      const maxIterations = 100; // Limit iterations to prevent infinite loops
      let iterations = 0;

      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', 'stream:*', 'COUNT', 100);
        cursor = nextCursor;
        
        // Filter out metadata keys and invalid keys
        for (const key of keys) {
          if (!key.endsWith(':meta')) {
            const sourcePart = key.replace('stream:', '');
            // Skip keys with colons (malformed/old format)
            if (!sourcePart.includes(':')) {
              dataKeys.push(key);
            }
          }
        }
        
        iterations++;
        // Safety check to prevent infinite loops
        if (iterations >= maxIterations) {
          warn('[RedisStorage] getLatestTimestampAcrossAllSources: Reached max iterations, stopping scan');
          break;
        }
      } while (cursor !== '0');

      if (dataKeys.length === 0) {
        return null;
      }

      let latestTimestamp = null;
      const maxSourcesToCheck = 50; // Limit sources checked to prevent memory issues

      // Check latest timestamp for each source (limit to prevent memory issues)
      for (let i = 0; i < Math.min(dataKeys.length, maxSourcesToCheck); i++) {
        const key = dataKeys[i];
        const sourceName = key.replace('stream:', '');
        
        try {
          const timestamp = await this.getLatestTimestamp(sourceName);
          if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
            latestTimestamp = timestamp;
          }
        } catch (err) {
          // Skip sources that error - continue with others
          debug(`[RedisStorage] Error getting timestamp for ${sourceName}:`, err.message);
        }
      }

      return latestTimestamp;
    } catch (err) {
      error('[RedisStorage] Error getting latest timestamp across all sources:', err.message);
      return null;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    // Flush buffer before disconnecting
    await this.flushBuffer();

    if (this.batchWriteInterval) {
      clearInterval(this.batchWriteInterval);
      this.batchWriteInterval = null;
    }

    if (this.client) {
      await this.client.quit();
      this.client = null;
    }

    this.isConnected = false;
    log('[RedisStorage] Disconnected from Redis');
  }
}

// Singleton instance
const redisStorage = new RedisStorage();

module.exports = redisStorage;

