const express = require("express");
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/usersPending');
const router = express.Router();

/**
 * @route GET /api/users/all
 * @desc Get all pending users
 */

router.get(
  '/',
  authenticate, 
  [
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  controller.getPendingUsers
);

/**
 * @route POST /api/users
 * @desc Add pending user
 */

router.post(
  '/',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('email').exists().withMessage('email is required').bail().customSanitizer(value => String(value).trim()),
    body('permission').exists().withMessage('permission is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.addPendingUser
);

/**
 * @route PUT /api/usersPending
 * @desc Update pending user permission
 */

router.put(
  '/',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('email').exists().withMessage('email is required').bail().customSanitizer(value => String(value).trim()),
    body('permission').exists().withMessage('permission is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.updatePendingUser
);

/**
 * @route DELETE /api/users
 * @desc Delete pending user
 */

router.delete(
  '/',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('email').exists().withMessage('email is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.deletePendingUser
);

/**
 * @route POST /api/usersPending/invite
 * @desc Send invitation email to pending user
 */

router.post(
  '/invite',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('email').exists().withMessage('email is required').bail().isEmail().withMessage('Invalid email format').customSanitizer(value => String(value).trim()),
    body('permission').exists().withMessage('permission is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.sendInvite
);

module.exports = router;

