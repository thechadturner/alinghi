const express = require("express");
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName, isValidateTargetName } = require('../middleware/helpers');
const controller = require('../controllers/targets');
const router = express.Router();

/**
 * @route GET /api/targets/channels
 * @desc Get target channels
 */

router.get(
  '/channels',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt()
  ],
  controller.getTargetChannels
);

/**
 * @route GET /api/targets
 * @desc Get targets
 */

router.get(
    '/',
    authenticate,
    [
      query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
      query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
      query('isPolar').exists().withMessage('isPolar is required').bail().isInt().withMessage('isPolar must be an integer').toInt()
    ],
    controller.getTargets
  );

/**
 * @route GET /api/targets/data
 * @desc Get targets data
 */

router.get(
    '/data',
    authenticate,
    [
      query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
      query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
      query('name').exists().withMessage('name is required').bail().custom((value) => {if (!isValidateTargetName(value)) { throw new Error('Invalid name');} return true;}).customSanitizer((value) => String(value).trim()),
      query('isPolar').exists().withMessage('isPolar is required').bail().isInt().withMessage('isPolar must be an integer').toInt()
    ],
    controller.getTargetData
  );

/**
 * @route GET /api/targets/latest
 * @desc Get latest targets
 */

router.get(
    '/latest',
    authenticate,
    [
      query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
      query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
      query('isPolar').exists().withMessage('isPolar is required').bail().isInt().withMessage('isPolar must be an integer').toInt()
    ],
    controller.getLatestTargets
  );

module.exports = router;