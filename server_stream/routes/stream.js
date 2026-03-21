const express = require('express');
const { query, body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const controller = require('../controllers/stream');
const router = express.Router();

/**
 * @route GET /api/stream/config
 * @desc Get live streaming config (poll interval, buffer) for frontend
 */
router.get(
  '/config',
  authenticate,
  controller.getStreamConfig
);

/**
 * @route GET /api/stream/status
 * @desc Get lightweight streaming status (fast check without querying Redis)
 */
router.get(
  '/status',
  authenticate,
  controller.getStreamingStatus
);

/**
 * @route GET /api/stream/sources
 * @desc Get list of all active sources (source names from Redis)
 */
router.get(
  '/sources',
  authenticate,
  controller.getSources
);

/**
 * @route GET /api/stream/sources/:source_name/status
 * @desc Get source status
 */
router.get(
  '/sources/:source_name/status',
  authenticate,
  [
    param('source_name').notEmpty().withMessage('source_name is required')
  ],
  controller.getSourceStatus
);

/**
 * @route POST /api/stream/sources
 * @desc Add/configure new source connection
 */
router.post(
  '/sources',
  authenticate,
  [
    body('source_id').isInt().withMessage('source_id must be an integer'),
    body('type').isIn(['websocket', 'influxdb']).withMessage('type must be websocket or influxdb'),
    body('config').isObject().withMessage('config must be an object')
  ],
  controller.addSource
);

/**
 * @route DELETE /api/stream/sources/:source_id
 * @desc Remove source connection
 */
router.delete(
  '/sources/:source_id',
  authenticate,
  [
    param('source_id').isInt().withMessage('source_id must be an integer')
  ],
  controller.removeSource
);

/**
 * @route GET /api/stream/sources/:source_name/data
 * @desc Query historical data from Redis
 */
router.get(
  '/sources/:source_name/data',
  authenticate,
  [
    param('source_name').notEmpty().withMessage('source_name is required'),
    query('channel').notEmpty().withMessage('channel is required'),
    query('startTime').optional().isInt().withMessage('startTime must be a timestamp'),
    query('endTime').optional().isInt().withMessage('endTime must be a timestamp')
  ],
  controller.getSourceData
);

/**
 * @route GET /api/stream/sources/:source_name/channels
 * @desc List available channels for a source
 */
router.get(
  '/sources/:source_name/channels',
  authenticate,
  [
    param('source_name').notEmpty().withMessage('source_name is required')
  ],
  controller.getSourceChannels
);

/**
 * @route GET /api/stream/debug/test-influx
 * @desc Test InfluxDB 2.x connection and discovery (no auth required for debugging)
 */
router.get(
  '/debug/test-influx',
  async (req, res) => {
    try {
      const { InfluxDB } = require('@influxdata/influxdb-client');
      
      const influxHost = process.env.INFLUX_HOST;
      const influxToken = process.env.INFLUX_TOKEN;
      const influxDatabase = process.env.INFLUX_DATABASE; // This is the org name
      const influxBucket = process.env.INFLUX_BUCKET;
      
      if (!influxHost || !influxToken || !influxDatabase || !influxBucket) {
        return res.json({
          success: false,
          error: 'Missing InfluxDB environment variables',
          required: ['INFLUX_HOST', 'INFLUX_TOKEN', 'INFLUX_DATABASE', 'INFLUX_BUCKET'],
          found: {
            INFLUX_HOST: !!influxHost,
            INFLUX_TOKEN: !!influxToken,
            INFLUX_DATABASE: !!influxDatabase,
            INFLUX_BUCKET: !!influxBucket
          }
        });
      }
      
      // Handle INFLUX_HOST that might already contain protocol
      let baseUrl = influxHost;
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        baseUrl = `http://${baseUrl}`;
      }
      
      // Test health - try HTTP /health endpoint first (fastest)
      const http = require('http');
      const https = require('https');
      const { URL } = require('url');
      
      const healthResult = await new Promise((resolve) => {
        // First try: HTTP /health endpoint (no auth, fastest)
        const url = new URL(`${baseUrl}/health`);
        const httpModule = url.protocol === 'https:' ? https : http;
        
        const req = httpModule.get(url.toString(), { timeout: 2000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve({ status: 'ok', message: 'Health endpoint OK', method: 'http_health' });
            } else {
              // Fallback to query-based check
              testHealthWithQuery();
            }
          });
        });

        req.on('error', () => {
          // HTTP health failed, try query
          testHealthWithQuery();
        });

        req.on('timeout', () => {
          req.destroy();
          testHealthWithQuery();
        });

        // Fallback: query-based health check
        function testHealthWithQuery() {
          try {
            const influxClient = new InfluxDB({
              url: baseUrl,
              token: influxToken,
              timeout: 2000
            });
            const queryApi = influxClient.getQueryApi(influxDatabase);

            // Minimal query: smallest time range, limit 1
            const testQuery = `from(bucket: "${influxBucket}")
  |> range(start: -10s)
  |> limit(n: 1)`;

            let hasError = false;
            const timeout = setTimeout(() => {
              if (!hasError) {
                hasError = true;
                influxClient.close();
                resolve({ error: 'timeout' });
              }
            }, 2000);

            queryApi.queryRows(testQuery, {
              next() {
                clearTimeout(timeout);
                influxClient.close();
                resolve({ status: 'ok', message: 'Connection successful', method: 'query' });
              },
              error(err) {
                if (!hasError) {
                  hasError = true;
                  clearTimeout(timeout);
                  influxClient.close();
                  resolve({ error: err.message, method: 'query' });
                }
              },
              complete() {
                if (!hasError) {
                  clearTimeout(timeout);
                  influxClient.close();
                  resolve({ status: 'ok', message: 'Connection successful (no data)', method: 'query' });
                }
              }
            });
          } catch (err) {
            resolve({ error: err.message, method: 'query' });
          }
        }
      });
      
      // Test discovery query - optimized for speed
      const fluxQuery = `from(bucket: "${influxBucket}")
  |> range(start: -2m)
  |> filter(fn: (r) => r._field == "value")
  |> filter(fn: (r) => r.level == "strm")
  |> limit(n: 1)
  |> distinct(column: "boat")
  |> limit(n: 50)`;
      
      const queryResult = await new Promise((resolve) => {
        try {
          const influxClient = new InfluxDB({
            url: baseUrl,
            token: influxToken,
            timeout: 5000 // Reduced for faster response
          });
          const queryApi = influxClient.getQueryApi(influxDatabase);

          const sources = new Set();
          let hasError = false;

          const timeout = setTimeout(() => {
            if (!hasError) {
              hasError = true;
              influxClient.close();
              resolve({ error: 'timeout' });
            }
          }, 5000); // Reduced for faster failure

          queryApi.queryRows(fluxQuery, {
            next(row, tableMeta) {
              try {
                const record = tableMeta.toObject(row);
                if (record.boat) {
                  sources.add(record.boat);
                }
              } catch (err) {
                // Continue processing
              }
            },
            error(err) {
              if (!hasError) {
                hasError = true;
                clearTimeout(timeout);
                influxClient.close();
                resolve({ error: err.message });
              }
            },
            complete() {
              if (!hasError) {
                clearTimeout(timeout);
                influxClient.close();
                resolve({ 
                  status: 'ok',
                  sources: Array.from(sources),
                  sourceCount: sources.size
                });
              }
            }
          });
        } catch (err) {
          resolve({ error: err.message });
        }
      });
      
      res.json({
        success: true,
        config: {
          host: influxHost,
          org: influxDatabase,
          bucket: influxBucket,
          baseUrl: baseUrl,
          hasToken: !!influxToken
        },
        health: healthResult,
        discovery: {
          ...queryResult,
          fluxQuery: fluxQuery
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message, stack: err.stack });
    }
  }
);

/**
 * @route GET /api/stream/redis/status
 * @desc Get Redis database status with hours of data per source
 */
router.get(
  '/redis/status',
  authenticate,
  controller.getRedisStatus
);

/**
 * @route POST /api/stream/redis/flush
 * @desc Flush Redis database (clear all data)
 */
router.post(
  '/redis/flush',
  authenticate,
  controller.flushRedis
);

/**
 * @route GET /api/stream/monitoring/status
 * @desc Get detailed streaming monitoring status
 */
router.get(
  '/monitoring/status',
  authenticate,
  controller.getStreamingMonitoringStatus
);

/**
 * @route POST /api/stream/influxdb/enable
 * @desc Enable or disable InfluxDB streaming
 */
router.post(
  '/influxdb/enable',
  authenticate,
  [
    body('enabled').isBoolean().withMessage('enabled must be a boolean')
  ],
  controller.setInfluxDBStreaming
);

/**
 * @route POST /api/stream/start
 * @desc Explicitly start streaming (commanded from admin page)
 */
router.post(
  '/start',
  authenticate,
  controller.startStreaming
);

/**
 * @route POST /api/stream/stop
 * @desc Explicitly stop streaming (commanded from admin page)
 */
router.post(
  '/stop',
  authenticate,
  controller.stopStreaming
);

/**
 * @route GET /api/stream/debug/status
 * @desc Debug endpoint to check system status (no auth required for debugging)
 */
router.get(
  '/debug/status',
  async (req, res) => {
    try {
      const connectionManager = require('../controllers/connections');
      const redisStorage = require('../controllers/redis');
      const { log } = require('../../shared');
      
      const connections = connectionManager.getAllConnections();
      const redisConnected = redisStorage.isConnected;
      
      // Get some sample data from Redis if available
      let sampleData = null;
      let allChannels = [];
      let redisKeys = [];
      
      if (redisConnected) {
        try {
          // Get all source names from Redis
          const keys = await redisStorage.client.keys('stream:*');
          const dataKeys = keys.filter(k => !k.endsWith(':meta'));
          
          if (dataKeys.length > 0) {
            const firstSourceName = dataKeys[0].replace('stream:', '');
            const channels = await redisStorage.getChannels(firstSourceName);
            allChannels = channels;
            
            if (channels.length > 0) {
              const latest = await redisStorage.getLatest(firstSourceName, channels[0]);
              sampleData = {
                source_name: firstSourceName,
                channel: channels[0],
                latest: latest
              };
            }
            
            // Get a sample of actual keys
            redisKeys = dataKeys.slice(0, 10);
          }
        } catch (err) {
          log(`Error getting sample data: ${err.message}`);
        }
      }
      
      res.json({
        success: true,
        data: {
          redis: {
            connected: redisConnected,
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379
          },
          connections: {
            count: connections.length,
            note: "Connection management uses source_id internally, but Redis operations use source_name only"
          },
          sampleData: sampleData,
          channels: allChannels,
          redisKeys: redisKeys,
          note: allChannels.length === 0 && redisKeys.length > 0 ? 'Channels found in Redis but metadata not updated' : null
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;

