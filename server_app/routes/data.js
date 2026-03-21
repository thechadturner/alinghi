const express = require("express");
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/data');
const { sanitizeChannelNames } = require('../middleware/helpers');
const router = express.Router();
const { handleValidation } = require('../../shared/middleware/validation');

/**
 * @route GET /api/data/maeuvers-table-data
 * @desc Get Maneuvers Table Data
 */

router.get(
  '/maneuvers-table-data',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt({ min: 0 }).withMessage('dataset_id must be a non-negative integer').toInt(),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
  query('channels')
    .exists().withMessage('channels is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
    .customSanitizer((value) => {
      try {
        const cleaned = sanitizeChannelNames(value);
        return JSON.stringify(cleaned);
      } catch {
        return value;
      }
    })
    .custom((value) => {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('channels must be an array');
        if (arr.length === 0) throw new Error('channels must not be empty');
        if (arr.length > 200) throw new Error('channels too large');
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid channels');
      }
    }),
  query('filters')
    .optional()
    .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
    .custom((value) => {
      if (!value) return true;
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
        // Validate filter keys - dataset endpoint allows GRADE, STATE, SOURCE_NAME (single date type)
        const allowedKeys = ['GRADE', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
        for (const key in obj) {
          if (!allowedKeys.includes(key)) {
            throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
          }
          if (!Array.isArray(obj[key])) {
            throw new Error(`Filter value for ${key} must be an array`);
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid filters');
      }
    }),
  query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
  ],
  handleValidation,
  controller.getDatasetManeuvers_TableData
);

/**
* @route GET /api/data/maeuvers-map-data
* @desc Get Maneuvers Map Data
*/

router.get(
  '/maneuvers-map-data',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('desc')
    .exists().withMessage('desc is required')
    .bail()
    .customSanitizer((value) => String(value).trim())
    .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
    .customSanitizer((value) => value.toLowerCase()),
  // Required list of event_ids to allow reuse of this endpoint across reports
  query('event_list')
    .exists().withMessage('event_list is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('event_list must be a JSON array string')
    .custom((value) => {
      if (!value) return true;
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('event_list must be an array');
        if (arr.length === 0) throw new Error('event_list must not be empty');
        for (const v of arr) {
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error('event_list values must be positive integers');
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid event_list');
      }
    })
  ],
  handleValidation,
  controller.getManeuvers_MapData
);

/**
* @route GET /api/data/maeuvers-timeseries-data
* @desc Get Maneuvers Time Series Data
*/

router.get(
  '/maneuvers-timeseries-data',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('desc')
    .exists().withMessage('desc is required')
    .bail()
    .customSanitizer((value) => String(value).trim())
    .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
    .customSanitizer((value) => value.toLowerCase()),
  // Required list of event_ids to allow reuse of this endpoint across reports
  query('event_list')
    .exists().withMessage('event_list is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('event_list must be a JSON array string')
    .custom((value) => {
      if (!value) return true;
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('event_list must be an array');
        if (arr.length === 0) throw new Error('event_list must not be empty');
        for (const v of arr) {
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error('event_list values must be positive integers');
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid event_list');
      }
    })
  ],
  handleValidation,
  controller.getManeuvers_TimeSeriesData
);

/**
* @route GET /api/data/maneuvers-map-data-by-range
* @desc Get Maneuvers Map Data by Time Range and Filters (for large event lists)
*/

router.get(
  '/maneuvers-map-data-by-range',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('desc')
    .exists().withMessage('desc is required')
    .bail()
    .customSanitizer((value) => String(value).trim())
    .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
    .customSanitizer((value) => value.toLowerCase()),
  query('start_date')
    .exists().withMessage('start_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('end_date')
    .exists().withMessage('end_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
  query('source_id').optional().isInt({ min: 1 }).withMessage('source_id must be a positive integer').toInt(),
  query('filters')
    .optional()
    .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
    .custom((value) => {
      if (!value) return true;
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
        const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
        for (const key in obj) {
          if (!allowedKeys.includes(key)) {
            throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
          }
          if (!Array.isArray(obj[key])) {
            throw new Error(`Filter value for ${key} must be an array`);
          }
          if (key === 'GRADE') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 0 || num > 5) {
                throw new Error(`GRADE values must be integers between 0 and 5`);
              }
            }
          }
          if (key === 'YEAR') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                throw new Error(`YEAR values must be integers between 1900 and 2100`);
              }
            }
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid filters');
      }
    })
  ],
  handleValidation,
  controller.getManeuvers_MapDataByRange
);

/**
* @route GET /api/data/maneuvers-timeseries-data-by-range
* @desc Get Maneuvers Time Series Data by Time Range and Filters (for large event lists)
*/

router.get(
  '/maneuvers-timeseries-data-by-range',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('desc')
    .exists().withMessage('desc is required')
    .bail()
    .customSanitizer((value) => String(value).trim())
    .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
    .customSanitizer((value) => value.toLowerCase()),
  query('start_date')
    .exists().withMessage('start_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('end_date')
    .exists().withMessage('end_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
  query('source_id').optional().isInt({ min: 1 }).withMessage('source_id must be a positive integer').toInt(),
  query('filters')
    .optional()
    .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
    .custom((value) => {
      if (!value) return true;
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
        const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
        for (const key in obj) {
          if (!allowedKeys.includes(key)) {
            throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
          }
          if (!Array.isArray(obj[key])) {
            throw new Error(`Filter value for ${key} must be an array`);
          }
          if (key === 'GRADE') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 0 || num > 5) {
                throw new Error(`GRADE values must be integers between 0 and 5`);
              }
            }
          }
          if (key === 'YEAR') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                throw new Error(`YEAR values must be integers between 1900 and 2100`);
              }
            }
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid filters');
      }
    })
  ],
  handleValidation,
  controller.getManeuvers_TimeSeriesDataByRange
);

/**
 * @route GET /api/data/maeuvers-table-data
 * @desc Get Maneuvers Table Data
 */

router.get(
    '/fleet-maneuvers-table-data',
    authenticate,
    [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .exists().withMessage('source_names is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('date')
    .exists().withMessage('date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type')
    ],
  handleValidation,
  controller.getFleetManeuvers_TableData
);

/**
 * @route GET /api/data/race-summary
 * @desc Get race summary: positions per race per source and total (dynamic columns by race count)
 */
router.get(
  '/race-day-results',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
  ],
  handleValidation,
  controller.getRaceDayResults_TableData
);

/**
 * @route GET /api/data/race-summary
 * @desc Get race summary table for a single race (positions, duration, losses, etc.). When summary_type=training, race may be omitted or "0"/"All" for aggregate across all training hours.
 */
router.get(
  '/race-summary',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('race').optional().isString().trim(),
    query('summary_type').optional().isString().trim(),
  ],
  handleValidation,
  controller.getRaceSummary_TableData
);

/**
 * @route GET /api/data/cheat-sheet
 * @desc Get cheat sheet table: group by Channel (wind band) or group by Wind (bins 25/30/35)
 */
router.get(
  '/cheat-sheet',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('group_by').exists().withMessage('group_by is required').bail().isString().trim().toLowerCase().isIn(['channel', 'wind']).withMessage('group_by must be channel or wind'),
    query('tws').optional().isFloat().toFloat(),
    query('tws_low').optional().isFloat().toFloat(),
    query('tws_high').optional().isFloat().toFloat(),
    query('leg_type').optional().isString().trim().toLowerCase().isIn(['upwind', 'downwind', 'reaching']).withMessage('leg_type must be upwind, downwind, or reaching'),
    query('config').optional().isString().trim(),
    query('source_id').optional().isInt({ min: 1 }).toInt(),
    query('source_names').optional().isString().trim(),
    query('metric').optional().isString().trim().toLowerCase(),
  ],
  handleValidation,
  controller.getCheatSheet_TableData
);

/**
 * @route GET /api/data/maneuver-cheat-sheet
 * @desc Get maneuver cheat sheet table: group by Channel (wind band) or group by Wind (bins 20–45), top 15% by Loss_total_tgt
 */
router.get(
  '/maneuver-cheat-sheet',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('group_by').exists().withMessage('group_by is required').bail().isString().trim().toLowerCase().isIn(['channel', 'wind']).withMessage('group_by must be channel or wind'),
    query('tws').optional().isFloat().toFloat(),
    query('maneuver_type').exists().withMessage('maneuver_type is required').bail().isString().trim().toLowerCase().isIn(['tack', 'gybe', 'roundup', 'bearaway']).withMessage('maneuver_type must be tack, gybe, roundup, or bearaway'),
    query('config').optional().isString().trim(),
    query('source_id').optional().isInt({ min: 1 }).toInt(),
    query('source_names').optional().isString().trim(),
    query('metric').optional().isString().trim().toLowerCase(),
  ],
  handleValidation,
  controller.getManeuverCheatSheet_TableData
);

/**
 * @route GET /api/data/prestart-summary
 * @desc Get prestart summary table for a single race (prestart / acceleration / maxbsp / reach / leg1 view)
 */
router.get(
  '/prestart-summary',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('race').exists().withMessage('race is required').bail().isString().trim().notEmpty().withMessage('race must be non-empty'),
    query('view')
      .exists().withMessage('view is required')
      .bail()
      .isString().trim().toLowerCase()
      .isIn(['prestart', 'acceleration', 'maxbsp', 'reach', 'leg1', 'courseaxis']).withMessage('view must be prestart, acceleration, maxbsp, reach, leg1, or courseaxis'),
  ],
  handleValidation,
  controller.getPrestartSummary_TableData
);

/**
 * @route GET /api/data/prestart-mapdata
 * @desc Get prestart map data by event_list and desc (events_mapdata, no maneuver_stats)
 */
router.get(
  '/prestart-mapdata',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('event_list').exists().withMessage('event_list is required').bail().isString().notEmpty().withMessage('event_list must be non-empty'),
    query('desc').exists().withMessage('desc is required').bail().isString().trim().notEmpty().withMessage('desc must be non-empty'),
  ],
  handleValidation,
  controller.getPrestart_MapData
);

/**
 * @route GET /api/data/prestart-timeseries
 * @desc Get prestart timeseries data by event_list and desc (events_timeseries, no maneuver_stats)
 */
router.get(
  '/prestart-timeseries',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('event_list').exists().withMessage('event_list is required').bail().isString().notEmpty().withMessage('event_list must be non-empty'),
    query('desc').exists().withMessage('desc is required').bail().isString().trim().notEmpty().withMessage('desc must be non-empty'),
  ],
  handleValidation,
  controller.getPrestart_TimeSeriesData
);

/**
 * @route GET /api/data/race-setup
 * @desc Get race setup table by leg type (upwind / downwind / reaching), optional race filter
 */
router.get(
  '/race-setup',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('leg_type')
      .exists().withMessage('leg_type is required')
      .bail()
      .isString().trim().toLowerCase()
      .isIn(['upwind', 'downwind', 'reaching']).withMessage('leg_type must be one of: upwind, downwind, reaching'),
    query('race').optional().isString().trim(),
    query('data_mode').optional().isString().trim().toLowerCase().isIn(['phases', 'best_modes', 'displacement']).withMessage('data_mode must be phases, best_modes, or displacement'),
  ],
  handleValidation,
  controller.getRaceSetup_TableData
);

/**
 * @route GET /api/data/channels
 * @desc Get Channels
 */

router.get(
    '/channels',
    authenticate,
    [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('table_name').isString().withMessage('table_name is required').bail().trim().matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/).withMessage('invalid table_name'),
    ],
    handleValidation,
    controller.getChannels
);

/**
 * @route GET /api/data/performance-data
 * @desc Get Performance Data
 */

router.get(
    '/performance-data',
    authenticate,
    [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_id').exists().withMessage('source_id is required').bail().isInt({ min: 1 }).withMessage('source_id must be a positive integer').toInt(),
    query('start_date')
      .exists().withMessage('start_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('end_date')
      .exists().withMessage('end_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['bin 10','phase','period']).withMessage('invalid event_type'),
    query('agr_type').isString().withMessage('agr_type is required').bail().trim().toLowerCase().isIn(['none','avg','min','max','std','aav']).withMessage('invalid agr_type'),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
    query('channels')
      .exists().withMessage('channels is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
      .customSanitizer((value) => {
        try {
          const cleaned = sanitizeChannelNames(value);
          return JSON.stringify(cleaned);
        } catch {
          return value;
        }
      })
      .custom((value) => {
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('channels must be an array');
          if (arr.length === 0) throw new Error('channels must not be empty');
          if (arr.length > 200) throw new Error('channels too large');
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid channels');
        }
      }),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true; // Optional, so empty is fine
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          // Validate filter keys and values - performance-data endpoint does NOT allow SOURCE_NAME (uses source_id parameter)
          const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            // Validate GRADE values are integers 0-5
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
            // Validate YEAR values are integers
            if (key === 'YEAR') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                  throw new Error(`YEAR values must be integers between 1900 and 2100`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
    ],
    handleValidation,
    controller.getPerformanceData
);

/**
 * @route GET /api/data/fleet_performance-data
 * @desc Get Fleet Performance Data
 */

router.get(
  '/fleet-performance-data',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('start_date')
    .exists().withMessage('start_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('end_date')
    .exists().withMessage('end_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['bin 10','phase','period']).withMessage('invalid event_type'),
  query('agr_type').isString().withMessage('agr_type is required').bail().trim().toLowerCase().isIn(['none','avg','min','max','std','aav']).withMessage('invalid agr_type'),
  query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
  query('channels')
    .exists().withMessage('channels is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
    .customSanitizer((value) => {
      try {
        const cleaned = sanitizeChannelNames(value);
        return JSON.stringify(cleaned);
      } catch {
        return value;
      }
    })
    .custom((value) => {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('channels must be an array');
        if (arr.length === 0) throw new Error('channels must not be empty');
        if (arr.length > 200) throw new Error('channels too large');
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid channels');
      }
    }),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true; // Optional, so empty is fine
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          // Validate filter keys and values - fleet endpoint allows SOURCE_NAME
          const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'SOURCE_NAME', 'STATE'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            // Validate GRADE values are integers 0-5
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
            // Validate YEAR values are integers
            if (key === 'YEAR') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                  throw new Error(`YEAR values must be integers between 1900 and 2100`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getFleetPerformanceData
);

/**
 * @route GET /api/data/shared-cloud-data
 * @desc Get Shared Cloud Data
 */

router.get(
  '/shared-cloud-data',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('source_id').exists().withMessage('source_id is required').bail().isInt({ min: 1 }).withMessage('source_id must be a positive integer').toInt(),
  query('table_name').isString().withMessage('table_name is required').bail().trim().toLowerCase().isIn(['events_aggregate','maneuver_stats']).withMessage('invalid table_name'),
  query('start_date')
    .exists().withMessage('start_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('end_date')
    .exists().withMessage('end_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['bin 10','phase','period','tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
  query('agr_type').isString().withMessage('agr_type is required').bail().trim().toLowerCase().isIn(['none','avg','min','max','std','aav']).withMessage('invalid agr_type'),
  query('channels')
    .exists().withMessage('channels is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
    .customSanitizer((value) => {
      try {
        const cleaned = sanitizeChannelNames(value);
        return JSON.stringify(cleaned);
      } catch {
        return value;
      }
    })
    .custom((value) => {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('channels must be an array');
        if (arr.length === 0) throw new Error('channels must not be empty');
        if (arr.length > 200) throw new Error('channels too large');
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid channels');
      }
    }),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true; // Optional, so empty is fine
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          // Validate filter keys and values - fleet endpoint allows SOURCE_NAME
          const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'SOURCE_NAME', 'STATE'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            // Validate GRADE values are integers 0-5
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
            // Validate YEAR values are integers
            if (key === 'YEAR') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                  throw new Error(`YEAR values must be integers between 1900 and 2100`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getSharedCloudData
);

/**
 * @route GET /api/data/aggregate-data
 * @desc Get Aggregate Data
 */

router.get(
  '/aggregate-data',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt({ min: 1 }).withMessage('dataset_id must be a positive integer').toInt(),
  query('table_name').isString().withMessage('table_name is required').bail().trim().toLowerCase().isIn(['events_aggregate']).withMessage('invalid table_name'),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['bin 10','phase','period']).withMessage('invalid event_type'),
  query('agr_type').isString().withMessage('agr_type is required').bail().trim().toLowerCase().isIn(['avg','min','max','std','aav']).withMessage('invalid agr_type'),
  query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
  query('channels')
    .exists().withMessage('channels is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
    .customSanitizer((value) => {
      try {
        const cleaned = sanitizeChannelNames(value);
        return JSON.stringify(cleaned);
      } catch {
        return value;
      }
    })
    .custom((value) => {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('channels must be an array');
        if (arr.length === 0) throw new Error('channels must not be empty');
        if (arr.length > 200) throw new Error('channels too large');
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid channels');
      }
    }), 
  ],
  handleValidation,
  controller.getAggregateData
);

/**
 * @route GET /api/data/best-maneuvers
 * @desc Get Best Maneuvers for a single source across all datasets
 */

router.get(
  '/best-maneuvers',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('source_id').exists().withMessage('source_id is required').bail().isInt({ min: 1 }).withMessage('source_id must be a positive integer').toInt(),
  query('start_date')
    .exists().withMessage('start_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('end_date')
    .exists().withMessage('end_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
  query('channels')
    .exists().withMessage('channels is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
    .customSanitizer((value) => {
      try {
        const cleaned = sanitizeChannelNames(value);
        return JSON.stringify(cleaned);
      } catch {
        return value;
      }
    })
    .custom((value) => {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('channels must be an array');
        if (arr.length === 0) throw new Error('channels must not be empty');
        if (arr.length > 200) throw new Error('channels too large');
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid channels');
      }
    }),
  query('filters')
    .optional()
    .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
    .custom((value) => {
      if (!value) return true;
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
        // Validate filter keys - best-maneuvers endpoint does NOT allow SOURCE_NAME (uses source_id parameter)
        const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE'];
        for (const key in obj) {
          if (!allowedKeys.includes(key)) {
            throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
          }
          if (!Array.isArray(obj[key])) {
            throw new Error(`Filter value for ${key} must be an array`);
          }
          // Validate GRADE values are integers 0-5
          if (key === 'GRADE') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 0 || num > 5) {
                throw new Error(`GRADE values must be integers between 0 and 5`);
              }
            }
          }
          // Validate YEAR values are integers
          if (key === 'YEAR') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                throw new Error(`YEAR values must be integers between 1900 and 2100`);
              }
            }
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid filters');
      }
    }),
  query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
  ],
  handleValidation,
  controller.getBestManeuvers_TableData
);

/**
 * @route GET /api/data/best-fleet-maneuvers
 * @desc Get Best Maneuvers for each source across all datasets
 */

router.get(
  '/best-fleet-maneuvers',
  authenticate,
  [
  query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
  query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
  query('start_date')
    .exists().withMessage('start_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('end_date')
    .exists().withMessage('end_date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
  query('count').optional().isInt({ min: 1, max: 100 }).withMessage('count must be between 1 and 100').toInt(),
  query('channels')
    .exists().withMessage('channels is required')
    .bail()
    .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
    .customSanitizer((value) => {
      try {
        const cleaned = sanitizeChannelNames(value);
        return JSON.stringify(cleaned);
      } catch {
        return value;
      }
    })
    .custom((value) => {
      try {
        const arr = JSON.parse(value);
        if (!Array.isArray(arr)) throw new Error('channels must be an array');
        if (arr.length === 0) throw new Error('channels must not be empty');
        if (arr.length > 200) throw new Error('channels too large');
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid channels');
      }
    }),
  query('filters')
    .optional()
    .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
    .custom((value) => {
      if (!value) return true;
      try {
        const obj = JSON.parse(value);
        if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
        // Validate filter keys - fleet endpoint allows SOURCE_NAME
        const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'SOURCE_NAME'];
        for (const key in obj) {
          if (!allowedKeys.includes(key)) {
            throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
          }
          if (!Array.isArray(obj[key])) {
            throw new Error(`Filter value for ${key} must be an array`);
          }
          // Validate GRADE values are integers 0-5
          if (key === 'GRADE') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 0 || num > 5) {
                throw new Error(`GRADE values must be integers between 0 and 5`);
              }
            }
          }
          // Validate YEAR values are integers
          if (key === 'YEAR') {
            for (const val of obj[key]) {
              const num = Number(val);
              if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                throw new Error(`YEAR values must be integers between 1900 and 2100`);
              }
            }
          }
        }
        return true;
      } catch (e) {
        throw new Error(e.message || 'invalid filters');
      }
    }),
  ],
  handleValidation,
  controller.getBestFleetManeuvers_TableData
);

/**
 * @route GET /api/data/maneuvers-history
 * @desc Get top N maneuvers per tack per source per wind speed bin (history query)
 */
router.get(
  '/maneuvers-history',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .exists().withMessage('source_names is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('start_date')
      .exists().withMessage('start_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('end_date')
      .exists().withMessage('end_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
    query('channels')
      .exists().withMessage('channels is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
      .customSanitizer((value) => {
        try {
          const cleaned = sanitizeChannelNames(value);
          return JSON.stringify(cleaned);
        } catch {
          return value;
        }
      })
      .custom((value) => {
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('channels must be an array');
          if (arr.length === 0) throw new Error('channels must not be empty');
          if (arr.length > 200) throw new Error('channels too large');
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid channels');
        }
      }),
    query('count').optional().isInt({ min: 1, max: 100 }).withMessage('count must be between 1 and 100').toInt(),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true;
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
            if (key === 'YEAR') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                  throw new Error(`YEAR values must be integers between 1900 and 2100`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
  ],
  handleValidation,
  controller.getManeuversHistory_TableData
);

/**
 * @route GET /api/data/maneuvers-history-mapdata
 * @desc Get top N maneuvers map data per tack per source per wind speed bin (history query)
 */
router.get(
  '/maneuvers-history-mapdata',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .exists().withMessage('source_names is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('start_date')
      .exists().withMessage('start_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('end_date')
      .exists().withMessage('end_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
    query('desc')
      .exists().withMessage('desc is required')
      .bail()
      .customSanitizer((value) => String(value).trim())
      .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
      .customSanitizer((value) => value.toLowerCase()),
    query('count').optional().isInt({ min: 1, max: 100 }).withMessage('count must be between 1 and 100').toInt(),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true;
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
            if (key === 'YEAR') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                  throw new Error(`YEAR values must be integers between 1900 and 2100`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getManeuversHistory_MapData
);

/**
 * @route GET /api/data/maneuvers-history-timeseries
 * @desc Get top N maneuvers timeseries data per tack per source per wind speed bin (history query)
 */
router.get(
  '/maneuvers-history-timeseries',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .exists().withMessage('source_names is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('start_date')
      .exists().withMessage('start_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('start_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('end_date')
      .exists().withMessage('end_date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('end_date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
    query('desc')
      .exists().withMessage('desc is required')
      .bail()
      .customSanitizer((value) => String(value).trim())
      .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
      .customSanitizer((value) => value.toLowerCase()),
    query('count').optional().isInt({ min: 1, max: 100 }).withMessage('count must be between 1 and 100').toInt(),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true;
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          const allowedKeys = ['GRADE', 'YEAR', 'EVENT', 'CONFIG', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
            if (key === 'YEAR') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 1900 || num > 2100) {
                  throw new Error(`YEAR values must be integers between 1900 and 2100`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getManeuversHistory_TimeSeriesData
);

/**
 * @route GET /api/data/maneuvers
 * @desc Get all maneuvers for a single date with simple filters
 * Accepts either source_names (JSON array) or source_id (single source) for backward compatibility.
 */
router.get(
  '/maneuvers',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .optional()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('source_id')
      .optional()
      .isInt({ min: 1 }).withMessage('source_id must be a positive integer').toInt()
      .custom((value, { req }) => {
        const hasSourceNames = req.query.source_names && String(req.query.source_names).trim().length >= 2;
        if (!value && !hasSourceNames) {
          throw new Error('either source_names or source_id is required');
        }
        return true;
      }),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
    query('channels')
      .exists().withMessage('channels is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 10000 }).withMessage('channels must be a JSON array string')
      .customSanitizer((value) => {
        try {
          const cleaned = sanitizeChannelNames(value);
          return JSON.stringify(cleaned);
        } catch {
          return value;
        }
      })
      .custom((value) => {
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('channels must be an array');
          if (arr.length === 0) throw new Error('channels must not be empty');
          if (arr.length > 200) throw new Error('channels too large');
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid channels');
        }
      }),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true;
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          const allowedKeys = ['GRADE', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                // Allow -1 for "All" (grade > -1) on maneuver/fleet maneuver pages only
                if (!Number.isInteger(num) || num < -1 || num > 5) {
                  throw new Error(`GRADE values must be integers between -1 and 5 (-1 = All)`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getManeuvers_TableData
);

/**
 * @route GET /api/data/maneuvers-mapdata
 * @desc Get all maneuvers map data for a single date with simple filters
 */
router.get(
  '/maneuvers-mapdata',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .exists().withMessage('source_names is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
    query('desc')
      .exists().withMessage('desc is required')
      .bail()
      .customSanitizer((value) => String(value).trim())
      .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
      .customSanitizer((value) => value.toLowerCase()),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true;
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          const allowedKeys = ['GRADE', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getManeuvers_MapDataByDate
);

/**
 * @route GET /api/data/maneuvers-timeseries
 * @desc Get all maneuvers timeseries data for a single date with simple filters
 */
router.get(
  '/maneuvers-timeseries',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt({ min: 1 }).withMessage('project_id must be a positive integer').toInt(),
    query('source_names')
      .exists().withMessage('source_names is required')
      .bail()
      .isString().trim().isLength({ min: 2, max: 1000 }).withMessage('source_names must be a JSON array string')
      .custom((value) => {
        if (!value) return true;
        try {
          const arr = JSON.parse(value);
          if (!Array.isArray(arr)) throw new Error('source_names must be an array');
          if (arr.length === 0) throw new Error('source_names must not be empty');
          if (arr.length > 50) throw new Error('source_names too large (max 50)');
          for (const v of arr) {
            if (typeof v !== 'string' || v.trim().length === 0) {
              throw new Error('source_names values must be non-empty strings');
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid source_names');
        }
      }),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('event_type').isString().withMessage('event_type is required').bail().trim().toLowerCase().isIn(['tack','gybe','roundup','bearaway','takeoff']).withMessage('invalid event_type'),
    query('desc')
      .exists().withMessage('desc is required')
      .bail()
      .customSanitizer((value) => String(value).trim())
      .isLength({ min: 1, max: 128 }).withMessage('desc must be 1-128 chars')
      .customSanitizer((value) => value.toLowerCase()),
    query('filters')
      .optional()
      .isString().trim().isLength({ min: 2, max: 5000 }).withMessage('filters must be a JSON object string')
      .custom((value) => {
        if (!value) return true;
        try {
          const obj = JSON.parse(value);
          if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('filters must be an object');
          const allowedKeys = ['GRADE', 'STATE', 'SOURCE_NAME', 'TRAINING_RACING'];
          for (const key in obj) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Invalid filter key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`);
            }
            if (!Array.isArray(obj[key])) {
              throw new Error(`Filter value for ${key} must be an array`);
            }
            if (key === 'GRADE') {
              for (const val of obj[key]) {
                const num = Number(val);
                if (!Number.isInteger(num) || num < 0 || num > 5) {
                  throw new Error(`GRADE values must be integers between 0 and 5`);
                }
              }
            }
          }
          return true;
        } catch (e) {
          throw new Error(e.message || 'invalid filters');
        }
      }),
  ],
  handleValidation,
  controller.getManeuvers_TimeSeriesDataByDate
);

module.exports = router;