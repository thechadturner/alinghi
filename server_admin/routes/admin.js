const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const controller = require('../controllers/admin');
const router = express.Router();

/**
 * @route DELETE /api/admin/logs
 * @desc Clear all logs by calling admin.truncate_logs()
 * Note: Nginx routes /api/admin/logs to /api/logs on this server
 */
router.delete(
  '/logs',
  authenticate,
  controller.clearLogs
);

/**
 * @route POST /api/admin/truncate-datasets-cascade
 * @desc Truncate datasets tables with CASCADE and reset identities
 * Requires super user authentication
 */
router.post(
  '/truncate-datasets-cascade',
  authenticate,
  controller.truncateDatasetsCascade
);

/**
 * @route POST /api/admin/events/grade-by-vmg
 * @desc Update dataset_events.tags GRADE by Vmg_perc from events_aggregate (day-scoped).
 * Requires: API key (Bearer token in Authorization header) and class_name.
 * Body: { class_name, project_id, date } — SQL is scoped by project and date (YYYYMMDD).
 */
router.post(
  '/admin/events/grade-by-vmg',
  authenticate,
  [
    body('class_name').exists().withMessage('class_name is required').trim().isIn(['ac40']).withMessage('class_name must be ac40'),
    body('project_id').exists().withMessage('project_id is required').isInt().toInt(),
    body('date').exists().withMessage('date is required').trim().isLength({ min: 8 }).withMessage('date must be YYYYMMDD')
  ],
  controller.gradeByVmg
);

module.exports = router;

