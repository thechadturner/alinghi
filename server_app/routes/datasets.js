const express = require("express");
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/datasets');
const router = express.Router();
const { handleValidation } = require('../../shared/middleware/validation');

/**
 * @route GET /api/datasets/date/races
 * @desc Get races for a given date
 */

router.get(
  '/date/races',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('date')
    .exists().withMessage('date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  ],
  controller.getRaces
);

/**
 * @route GET /api/datasets/date/dataset_id
 * @desc Get dataset_ids for a given date
 */

router.get(
  '/date/dataset_id',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('date')
    .exists().withMessage('date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  ],
  controller.getDatasetIds
);

/**
 * @route GET /api/datasets/date/datasets_with_duration
 * @desc Get datasets for a date with each DATASET event's start_time, end_time, duration (ordered by duration DESC)
 */
router.get(
  '/date/datasets_with_duration',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('date')
    .exists().withMessage('date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  ],
  controller.getDateDatasetsWithDuration
);

/**
 * @route GET /api/datasets/date/timezone
 * @desc Get timezone for a given date
 */
router.get(
  '/date/timezone',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('date')
    .exists().withMessage('date is required')
    .bail()
    .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
    .customSanitizer(value => String(value).trim()),
  ],
  controller.getDateTimezone
);

/**
 * @route GET /api/datasets/day
 * @desc Get dataset day
 */

router.get(
  '/day',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
    query('event_name').exists().withMessage('event_name is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.getDatasetDay
);

/**
 * @route GET /api/datasets/last_date
 * @desc Get last dataset
 */

router.get(
  '/last_date',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
  ],
  controller.getLastDatasetDate
);

/**
 * @route GET /api/datasets/desc
 * @desc Get dataset description
 */

router.get(
  '/desc',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
  ],
  controller.getDatasetDesc
);

/**
 * @route GET /api/datasets/years
 * @desc Get dataset years
 */

router.get(
  '/years',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
  ],
  controller.getDatasetYears
);

/**
 * @route GET /api/datasets/events
 * @desc Get dataset events
 */

router.get(
  '/events',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
    query('year_name').exists().withMessage('year_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  handleValidation,
  controller.getDatasetEvents
);

/**
 * @route GET /api/datasets/info
 * @desc Get dataset info
 */

router.get(
  '/info',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
  ],
  handleValidation,
  controller.getDatasetInfo
);

/**
 * @route GET /api/datasets/tags
 * @desc Get dataset tags
 */

router.get(
  '/tags',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
  ],
  handleValidation,
  controller.getDatasetTags
);

/**
 * @route GET /api/datasets/count
 * @desc Get dataset count
 */

router.get(
  '/count',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  handleValidation,
  controller.getDatasetCount
);

/**
 * @route GET /api/datasets/id
 * @desc Get dataset by id
 */

router.get(
  '/id',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
  ],
  handleValidation,
  controller.getDataset
);

/**
 * @route GET /api/datasets
 * @desc Get datasets
 */

router.get(
  '/',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
    query('year_name').exists().withMessage('year_name is required').bail().customSanitizer(value => String(value).trim()),
    query('event_name').exists().withMessage('event_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  handleValidation,
  controller.getDatasets
);

/**
 * @route GET /api/datasets/fleet
 * @desc Get fleet datasets
 */

router.get(
  '/fleet',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('year_name').exists().withMessage('year_name is required').bail().customSanitizer(value => String(value).trim()),
    query('event_name').exists().withMessage('event_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  handleValidation,
  controller.getFleetDatasets
);

/**
 * @route GET /api/dataset
 * @desc Get datasets
 */

router.get(
  '/object',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    query('parent_name').exists().withMessage('parent_name is required').bail().customSanitizer(value => String(value).trim()),
    query('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim())
  ],
  handleValidation,
  controller.getDatasetObject
);

/**
 * @route POST /api/dataset
 * @desc Add dataset
 */

router.post(
  '/',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
    body('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    body('year_name')
      .exists().withMessage('year_name is required')
      .bail()
      .isInt({ min: 1970, max: 2100 }).withMessage('year_name must be a 4-digit year (>=1970)')
      .toInt(),
    body('event_name')
      .exists().withMessage('event_name is required')
      .bail()
      .trim()
      .isLength({ min: 1, max: 128 }).withMessage('event_name must be 1-128 chars')
      .matches(/^[\w\-\s]+$/).withMessage('event_name may contain letters, numbers, spaces, _ and -'),
    body('report_name')
      .exists().withMessage('report_name is required')
      .bail()
      .trim()
      .isLength({ min: 1, max: 128 }).withMessage('report_name must be 1-128 chars')
      .matches(/^[\w\-\s]+$/).withMessage('report_name may contain letters, numbers, spaces, _ and -'),
    body('description')
      .exists().withMessage('description is required')
      .bail()
      .trim()
      .isLength({ min: 0, max: 2048 }).withMessage('description must be <= 2048 chars'),
    body('tags')
      .exists().withMessage('tags is required')
      .bail()
      .custom(value => {
        try {
          return typeof JSON.parse(value) === 'object';
        } catch (err) {
          throw new Error('tags must be a valid JSON object');
        }
      })
      .customSanitizer(value => JSON.parse(value)),
  ],
  handleValidation,
  controller.addDataset
);

/**
 * @route POST /api/datasets/target
 * @desc Add dataset target
 */

router.post(
  '/target',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('target_id').exists().withMessage('target_id is required').bail().isInt().withMessage('target_id must be an integer').toInt(),
    body('tack')
    .exists().withMessage('tack is required')
    .bail()
    .trim()
    .custom((value) => {
      const lowerValue = String(value).toLowerCase();
      if (!['both', 'port', 'stbd'].includes(lowerValue)) {
        throw new Error('tack must be BOTH, PORT, or STBD');
      }
      return true;
    })
    .customSanitizer((value) => String(value).trim()),
  ],
  handleValidation,
  controller.addDatasetTarget
);

/**
 * @route PUT /api/dataset
 * @desc Update dataset
 */

router.put(
  '/',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('event_name')
      .exists().withMessage('event_name is required')
      .bail()
      .trim()
      .isLength({ min: 1, max: 128 }).withMessage('event_name must be 1-128 chars')
      .matches(/^[\w\-\s]+$/).withMessage('event_name may contain letters, numbers, spaces, _ and -'),
    body('report_name')
      .exists().withMessage('report_name is required')
      .bail()
      .trim()
      .isLength({ min: 1, max: 128 }).withMessage('report_name must be 1-128 chars')
      .matches(/^[\w\-\s]+$/).withMessage('report_name may contain letters, numbers, spaces, _ and -'),
    body('description')
      .exists().withMessage('description is required')
      .bail()
      .trim()
      .isLength({ min: 0, max: 2048 }).withMessage('description must be <= 2048 chars'),
    body('timezone').exists().withMessage('timezone is required').bail().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars'),
    body('tws').exists().withMessage('tws is required').bail().customSanitizer(value => JSON.stringify(value).trim()),
    body('twd').exists().withMessage('twd is required').bail().customSanitizer(value => JSON.stringify(value).trim()),
    body('shared').exists().withMessage('shared is required').bail().isInt({ min: 0, max: 1 }).withMessage('shared must be 0 or 1').toInt(),
  ],
  handleValidation,
  controller.updateDataset
);

/**
 * @route PUT /api/datasets/tags
 * @desc Update dataset tags
 */

router.put(
  '/tags',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('tags').exists().withMessage('tags is required').bail().customSanitizer(value => String(value).trim()),
  ],
  handleValidation,
  controller.updateDatasetTags
);

/**
 * @route POST /api/datasets/channels/populate
 * @desc Populate channels for dates (called after upload dataset process completes)
 */
router.post(
  '/channels/populate',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dates').exists().withMessage('dates is required').bail().isArray().withMessage('dates must be an array'),
    body('dates.*.date').exists().withMessage('date is required in dates array').bail().matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD'),
    body('dates.*.source_id').exists().withMessage('source_id is required in dates array').bail().isInt().withMessage('source_id must be an integer'),
  ],
  handleValidation,
  controller.populateChannelsForDates
);

/**
 * @route GET /api/datasets/channels
 * @desc Get channels for a date
 */
router.get(
  '/channels',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('data_source').optional().isIn(['FILE', 'INFLUX', 'UNIFIED']).withMessage('data_source must be FILE, INFLUX, or UNIFIED'),
  ],
  handleValidation,
  controller.getChannels
);

/**
 * @route PUT /api/datasets/visible
 * @desc Update dataset visibility
 */

router.put(
  '/visibility',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('visible').exists().withMessage('visible is required').bail().isInt({ min: 0, max: 1 }).withMessage('visible must be 0 or 1').toInt(),
  ],
  handleValidation,
  controller.updateDatasetVisibility
);

/**
 * @route DELETE /api/dataset
 * @desc Delete dataset
 */

router.delete(
  '/',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
  ],
  handleValidation,
  controller.deleteDataset
);

module.exports = router;