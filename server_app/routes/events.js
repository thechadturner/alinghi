const express = require('express');
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/events');
const router = express.Router();

/**
 * @route GET /api/events
 * @desc Get events id
*/

router.get(
  '/',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars')
  ],
  controller.getEvents
);

/**
 * @route GET /api/events/info
 * @desc Get events info
*/

router.get(
  '/info',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    query('event_type').isString().withMessage('event_type is required').trim(),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars')
  ],
  controller.getEventsInfo
);

/**
 * @route GET /api/events/times
 * @desc Get events times
*/

router.get(
  '/times',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').optional().bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    query('source_id').optional().bail().isInt().withMessage('source_id must be an integer').toInt(),
    query('date').optional().isString().trim().isLength({ min: 1, max: 32 }).withMessage('date must be 1-32 chars'),
    query('event_list').isString().withMessage('event_list is required').trim(),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars')
  ],
  controller.getEventTimes
);

/**
 * @route POST /api/events/times
 * @desc Get events times (POST version for long event lists)
*/

router.post(
  '/times',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').optional().bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('source_id').optional().bail().isInt().withMessage('source_id must be an integer').toInt(),
    body('date').optional().isString().trim().isLength({ min: 1, max: 32 }).withMessage('date must be 1-32 chars'),
    body('event_list').isString().withMessage('event_list is required').trim(),
    body('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars')
  ],
  controller.getEventTimes
);

/**
 * @route GET /api/events/object
 * @desc Get event object
*/

router.get(
  '/object',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('datasetId').exists().withMessage('datasetId is required').bail().isInt().withMessage('datasetId must be an integer').toInt(),
    query('table').isString().withMessage('table is required').trim(),
    query('desc').isString().withMessage('desc is required').trim().customSanitizer((value) => value.toLowerCase())
  ],
  controller.getEventObject
);

/**
 * @route GET /api/events/dataset-time-range
 * @desc Get min start_time and max end_time for DATASET events across multiple datasets
 * @query dataset_ids - JSON array or comma-separated list of dataset IDs
 */

router.get(
  '/dataset-time-range',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_ids').exists().withMessage('dataset_ids is required').trim(),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars')
  ],
  controller.getDatasetEventTimeRange
);

/**
 * @route GET /api/events/maneuver-loss-averages
 * @desc Get average Loss_total_tgt by maneuver type (TACK, GYBE, ROUNDUP, BEARAWAY) for race/leg, GRADE > 1
 */
router.get(
  '/maneuver-loss-averages',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_ids').exists().withMessage('dataset_ids is required').trim(),
    query('scope').optional().isString().trim().toLowerCase().isIn(['race', 'leg', 'both']).withMessage('scope must be race, leg, or both')
  ],
  controller.getManeuverLossAverages
);

module.exports = router;