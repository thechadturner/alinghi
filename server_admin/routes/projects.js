const express = require("express");
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/projects');
const router = express.Router();

/**
 * @route POST /api/projects/object
 * @desc Add Projects Object
 */

router.post(
  '/object',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    body('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
    body('json').exists().withMessage('message is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addProjectObject
);

/**
 * @route POST /api/projects/page
 * @desc Add Projects page
 */

router.post(
  '/page',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('page_name').exists().withMessage('page_name is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.addProjectPage
);

/**
 * @route DELETE /api/projects/page
 * @desc Delete Projects page
 */

router.delete(
  '/page',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('page_name').exists().withMessage('page_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.removeProjectPage
);

module.exports = router;