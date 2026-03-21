const express = require('express');
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/classes');
const router = express.Router();

/**
 * @route GET /api/classes
 * @desc Get classes
 */

router.get(
  '/',
  authenticate,
  controller.getClasses
);

/**
 * @route GET /api/classes/object
 * @desc Get classes object
 */

router.get(
  '/object',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.getClassObject
);

module.exports = router;