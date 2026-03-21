const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/classes');
const router = express.Router();

/**
 * @route POST /api/classes/object
 * @desc Add classes object
 */

router.post(
  '/object',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
    body('json')
    .exists().withMessage('json is required')
    .bail()
    .custom(value => {
      try {
        return typeof JSON.parse(value) === 'object';
      } catch (err) {
        throw new Error('json must be a valid JSON object');
      }
    })
    .customSanitizer(value => JSON.parse(value)),
  ],
  controller.addClassObject
);

module.exports = router;