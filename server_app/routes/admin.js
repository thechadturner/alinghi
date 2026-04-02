const express = require('express');
const { authenticate } = require('../middleware/auth_jwt');
const controller = require('../controllers/admin');
const router = express.Router();

/**
 * @route GET /api/admin/log_activity
 * @desc Get log_activity
 */
router.get(
  '/timezones',
  authenticate,
  controller.getTimeZones
);

/**
 * @route GET /api/admin/log_activity
 * @desc Get log_activity
 */
router.get(
  '/log_activity',
  authenticate,
  controller.getLogActivity
);

/**
 * @route GET /api/admin/user_activity/summary
 * @desc Top users, pages, and days (aggregates)
 */
router.get(
  '/user_activity/summary',
  authenticate,
  controller.getUserActivitySummary
);

/**
 * @route GET /api/admin/user_activity
 * @desc Get user_activity
 */
router.get(
  '/user_activity',
  authenticate,
  controller.getUserActivity
);

module.exports = router;