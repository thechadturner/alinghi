const express = require("express");
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/datasets');
const router = express.Router();

/**
 * @route POST /api/datasets/object
 * @desc Add Dataset Object
 */

router.post(
  '/object',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
    body('json').exists().withMessage('message is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addDatasetObject
);

/**
 * @route POST /api/datasets/page
 * @desc Add Dataset Page
 */

router.post(
  '/page',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('page_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addDatasetPage
);

/**
 * @route POST /api/datasets/day-page
 * @desc Add or update Day Page (day_pages table)
 */

router.post(
  '/day-page',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('date').exists().withMessage('date is required').bail().matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD').customSanitizer((value) => String(value).trim()),
    body('page_name').exists().withMessage('page_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addDayPage
);

/**
 * @route DELETE /api/datasets/day-page
 * @desc Remove a row from day_pages (day/reports page by name)
 */
router.delete(
  '/day-page',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('date').exists().withMessage('date is required').bail().matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD').customSanitizer((value) => String(value).trim()),
    body('page_name').exists().withMessage('page_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.removeDayPage
);

/**
 * @route DELETE /api/datasets/page
 * @desc Delete Dataset Page
 */

router.delete(
  '/page',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('page_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.removeDatasetPage
);

/**
 * @route PUT /api/datasets/date-modified
 * @desc Update Dataset Date Modified
 */

router.put(
  '/date-modified',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').optional().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('source_id').optional().isInt().withMessage('source_id must be an integer').toInt(),
    body('date').optional().isString().withMessage('date must be a string').customSanitizer((value) => String(value).trim()),
  ],
  controller.updateDatasetDateModified
);

module.exports = router;