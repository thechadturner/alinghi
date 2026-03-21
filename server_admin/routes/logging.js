const express = require("express");
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const controller = require('../controllers/logging');
const router = express.Router();

/**
 * @route POST /api/logging/activity
 * @desc Log Activity
 */

router.post(
  '/activity',
  authenticate, 
  [
    body('project_id').optional().isInt().withMessage('project_id must be an integer').toInt(),
    body('dataset_id').optional().isInt().withMessage('dataset_id must be an integer').toInt(),
    body('file_name').exists().withMessage('file_name is required').bail().customSanitizer(value => String(value).trim()),
    body('message').exists().withMessage('message is required').bail().customSanitizer(value => String(value).trim()),
    body('context').exists().withMessage('context is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.LogActivity
);

/**
 * @route POST /api/logging/message
 * @desc Log Message
 */

router.post(
    '/message',
    authenticate, 
    [
      body('file_name').exists().withMessage('file_name is required').bail().customSanitizer(value => String(value).trim()),
      body('message_type').exists().withMessage('message_type is required').bail().customSanitizer(value => String(value).trim()),
      body('message').exists().withMessage('message is required').bail().customSanitizer(value => String(value).trim()),
      body('context').exists().withMessage('context is required').bail().customSanitizer(value => String(value).trim()),
    ],
    controller.LogMessage
  );

/**
 * @route POST /api/logging/user-activity
 * @desc Log User Activity
 */

router.post(
  '/user-activity',
  authenticate,
  [
    body('user_id').exists().withMessage('user_id is required'),
    body('activity_type').exists().withMessage('activity_type is required'),
    body('page').optional(),
    body('previous_page').optional(),
    body('session_id').optional(),
    body('user_agent').optional(),
    body('url').optional(),
    body('project_id').optional().isInt().toInt(),
    body('dataset_id').optional().isInt().toInt(),
    body('context').optional()
  ],
  controller.LogUserActivity
);

module.exports = router;