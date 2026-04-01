const express = require('express');
const { query, body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const controller = require('../controllers/user_events');

const router = express.Router();

router.get(
  '/',
  authenticate,
  [
    query('project_id')
      .exists()
      .withMessage('project_id is required')
      .bail()
      .isInt()
      .withMessage('project_id must be an integer')
      .toInt(),
    query('date_from').optional().isString().trim().isLength({ min: 1, max: 32 }),
    query('date_to').optional().isString().trim().isLength({ min: 1, max: 32 }),
    query('after_user_event_id')
      .optional()
      .isInt({ min: 0 })
      .withMessage('after_user_event_id must be a non-negative integer')
      .toInt(),
    query('modified_after')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 4, max: 64 })
      .withMessage('modified_after must be an ISO 8601 timestamp string'),
  ],
  controller.listUserEvents
);

router.post(
  '/',
  authenticate,
  [
    body('project_id')
      .exists()
      .withMessage('project_id is required')
      .bail()
      .isInt()
      .withMessage('project_id must be an integer')
      .toInt(),
    body('event_type')
      .exists()
      .withMessage('event_type is required')
      .bail()
      .isString()
      .trim()
      .isLength({ min: 1, max: 256 }),
    body('tags')
      .optional()
      .custom((v) => v == null || (typeof v === 'object' && !Array.isArray(v)))
      .withMessage('tags must be a plain object'),
    body('comment').optional().isString(),
    body('date').optional({ nullable: true }).isISO8601().toDate(),
    body('focus_time').optional({ nullable: true }).isISO8601().toDate(),
    body('start_time').optional({ nullable: true }).isISO8601().toDate(),
    body('end_time').optional({ nullable: true }).isISO8601().toDate(),
  ],
  controller.createUserEvent
);

router.put(
  '/:user_event_id',
  authenticate,
  [
    param('user_event_id').isInt().withMessage('user_event_id must be an integer').toInt(),
    body('project_id')
      .exists()
      .withMessage('project_id is required')
      .bail()
      .isInt()
      .withMessage('project_id must be an integer')
      .toInt(),
    body('event_type')
      .exists()
      .withMessage('event_type is required')
      .bail()
      .isString()
      .trim()
      .isLength({ min: 1, max: 256 }),
    body('tags')
      .optional()
      .custom((v) => v == null || (typeof v === 'object' && !Array.isArray(v)))
      .withMessage('tags must be a plain object'),
    body('comment').optional().isString(),
    body('date').optional({ nullable: true }).isISO8601().toDate(),
    body('focus_time').optional({ nullable: true }).isISO8601().toDate(),
    body('start_time').optional({ nullable: true }).isISO8601().toDate(),
    body('end_time').optional({ nullable: true }).isISO8601().toDate(),
  ],
  controller.updateUserEvent
);

router.delete(
  '/:user_event_id',
  authenticate,
  [
    param('user_event_id').isInt().withMessage('user_event_id must be an integer').toInt(),
    query('project_id')
      .exists()
      .withMessage('project_id is required')
      .bail()
      .isInt()
      .withMessage('project_id must be an integer')
      .toInt(),
  ],
  controller.deleteUserEvent
);

module.exports = router;
