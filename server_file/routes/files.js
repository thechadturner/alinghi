const express = require('express');
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/files');
const router = express.Router();

// Middleware to mark that a route matched (prevents 404 handler from running)
router.use((req, res, next) => {
  req.routeMatched = true;
  next();
});

/**
 * @route GET /api/classes
 * @desc Get list of all class names
 */
router.get(
  '/classes', 
  authenticate,
  query('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
  controller.getClasses
);

/**
 * @route GET /api/dates
 * @desc Get list of dates for a given class
 */
router.get(
  '/dates',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.getDates
);

/**
 * @route GET /api/channels
 * @desc Get list of channels for a given class, date, and source
 * NOTE: Also available as /api/get-available-channels to avoid conflicts
 */
router.get(
  '/channels',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
    query('date').isString().withMessage('date is required').trim().customSanitizer((value) => {return value.replace(/[-/]/g, '')}),
    query('source_name').isString().withMessage('source_name is required').trim(),
    query('data_source').optional().isIn(['influx', 'file', 'unified']).withMessage('data_source must be one of: influx, file, unified'),
    query('level').optional().isIn(['strm', 'log']).withMessage('level must be one of: strm, log'),
  ],
  controller.getChannelList
);

/**
 * @route GET /api/get-available-channels
 * @desc Get list of channels for a given class, date, and source (alias for /channels)
 */
router.get(
  '/get-available-channels',
  (req, res, next) => {
    const { log } = require('../../shared');
    log(`[routes/files] Route matched: GET /get-available-channels, path=${req.path}, url=${req.url}, originalUrl=${req.originalUrl}`);
    next();
  },
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
    query('date').isString().withMessage('date is required').trim().customSanitizer((value) => {return value.replace(/[-/]/g, '')}),
    query('source_name').isString().withMessage('source_name is required').trim(),
    query('data_source').optional().isIn(['influx', 'file', 'unified']).withMessage('data_source must be one of: influx, file, unified'),
    query('level').optional().isIn(['strm', 'log']).withMessage('level must be one of: strm, log'),
  ],
  controller.getChannelList
);

/**
 * @route GET /api/sources
 * @desc Get list of sources for a given class and date
 */
router.get(
  '/sources',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
    query('date').isString().withMessage('date is required').trim().customSanitizer((value) => {return value.replace(/[-/]/g, '')}),
    query('data_source').optional().isIn(['influx', 'file', 'unified']).withMessage('data_source must be one of: influx, file, unified'),
    query('level').optional().isIn(['strm', 'log']).withMessage('level must be one of: strm, log'),
  ],
  controller.getSources
);

/**
 * @route POST /api/channel-values
 * @desc Get values for specified channels using DuckDB (with optional resolution)
 */
router.post(
  '/channel-values',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
    body('date').isString().withMessage('date is required').trim().customSanitizer((value) => {return value.replace(/[-/]/g, '')}),
    body('source_name').isString().withMessage('source_name is required').trim(),
    body('channel_list').isArray().withMessage('channel_list must be an array of dictionaries containing channel names and types'),
    body('start_ts').optional({ values: 'null' }).custom((value) => value === null || !isNaN(value)).withMessage('startTime must be a timestamp or null'),
    body('end_ts').optional({ values: 'null' }).custom((value) => value === null || !isNaN(value)).withMessage('endTime must be a timestamp or null'),
    body('resolution').optional().custom((value) => {
      if (value === null || value === undefined) return true;
      if (typeof value !== 'string') return false;
      // Match patterns like '1s', '100ms', '200ms', '500ms', '1min', '1h', etc.
      return /^\d+(\.\d+)?(ms|s|min|m|h)$/i.test(value.trim());
    }).withMessage('resolution must be a string like "1s", "100ms", "200ms", etc., or null/undefined'),
    body('timezone').optional().isString().withMessage('timezone must be a string').trim().customSanitizer((value) => value ? String(value).trim() : null),
    body('data_source').optional().isIn(['influx', 'file', 'auto', 'unified']).withMessage('data_source must be one of: influx, file, auto, unified')
  ],
  controller.getChannelValues
);

/**
 * @route POST /api/channel-groups
 * @desc Group channels by the filename in which they are found
 */
router.post(
  '/channel-groups',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
    body('date').isString().withMessage('date is required').trim().customSanitizer((value) => {return value.replace(/[-/]/g, '')}),
    body('source_name').isString().withMessage('source_name is required').trim(),
    body('channel_names').isArray().withMessage('channel_names must be an array of channel names')
  ],
  controller.getChannelGroups
);

/**
 * @route GET /api/influxdb/available
 * @desc Check if InfluxDB is available (INFLUX_HOST is configured)
 */
router.get(
  '/influxdb/available',
  authenticate,
  controller.checkInfluxDBAvailable
);

/**
 * @route GET /api/test-get-available-channels
 * @desc Test route to verify routing works (no auth, no validation)
 */
router.get(
  '/test-get-available-channels',
  (req, res) => {
    const { log } = require('../../shared');
    log(`[routes/files] Test route hit: GET /test-get-available-channels`);
    res.json({ 
      status: 'ok', 
      message: 'Test route works',
      path: req.path,
      url: req.url,
      originalUrl: req.originalUrl,
      query: req.query
    });
  }
);

/**
 * @route POST /api/edit-channel-data
 * @desc Edit channel data in parquet files for a given time range
 */
router.post(
  '/edit-channel-data',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
    body('date').isString().withMessage('date is required').trim().customSanitizer((value) => {return value.replace(/[-/]/g, '')}),
    body('source_name').isString().withMessage('source_name is required').trim(),
    body('channel_name').isString().withMessage('channel_name is required').trim(),
    body('start_ts').isNumeric().withMessage('start_ts must be a numeric timestamp'),
    body('end_ts').isNumeric().withMessage('end_ts must be a numeric timestamp'),
    body('channel_value').exists().withMessage('channel_value is required')
  ],
  controller.editChannelData
);

module.exports = router;

