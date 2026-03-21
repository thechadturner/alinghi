const express = require('express');
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/sources');
const router = express.Router();

/**
 * @route GET /api/sources
 * @desc Get sources
 */

router.get(
  '/',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  controller.getSources
);

/**
 * @route POST /api/sources
 * @desc Add source
 */

router.post(
  '/',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('source_name').exists().withMessage('source_name is required').bail().customSanitizer(value => String(value).trim()),
    body('color').exists().withMessage('color is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addSource
);

/**
 * @route PUT /api/sources
 * @desc Add source
 */

router.put(
  '/',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
    body('source_name').exists().withMessage('source_name is required').bail().customSanitizer(value => String(value).trim()),
    body('color').exists().withMessage('color is required').bail().customSanitizer(value => String(value).trim()),
    body('fleet').exists().withMessage('fleet is required').bail().isInt().withMessage('fleet must be an integer').toInt(),
    body('visible').exists().withMessage('visible is required').bail().isInt().withMessage('visible must be an integer').toInt(),
  ],
  controller.updateSource
);

/**
 * @route DELETE /api/sources
 * @desc Delete source
 */

router.delete(
  '/',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('source_id').exists().withMessage('source_id is required').bail().isInt().withMessage('source_id must be an integer').toInt(),
  ],
  controller.deleteSource
);

module.exports = router;