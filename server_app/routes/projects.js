const express = require("express");
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const controller = require('../controllers/projects');
const router = express.Router();

/**
 * @route GET /api/projects/users
 * @desc Get project users
 */

router.get(
  '/users',
  authenticate, 
  [
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  controller.getProjectUsers
);

/**
 * @route GET /api/projects/type
 * @desc Get projects by type
 */

router.get(
  '/type',
  authenticate, 
  [
    query('type').exists().withMessage('type is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getProjectsByType
);

/**
 * @route GET /api/projects/class
 * @desc Get projects class
 */

router.get(
  '/class',
  authenticate, 
  [
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  controller.getProjectClass
);

/**
 * @route GET /api/projects/id
 * @desc Get projects by id
 */

router.get(
  '/id',
  authenticate, 
  [
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  controller.getProject
);

/**
 * @route GET /api/projects/object
 * @desc Get projects object
 */

router.get(
  '/object',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().customSanitizer(value => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    query('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getProjectObject
);

/**
 * @route GET /api/projects/object/latest
 * @desc Get latest project object by date
 */

router.get(
  '/object/latest',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().customSanitizer(value => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getLatestProjectObject
);

/**
 * @route POST /api/projects/object
 * @desc Add or update project object
 */

router.post(
  '/object',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().customSanitizer(value => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('date')
      .exists().withMessage('date is required')
      .bail()
      .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
      .customSanitizer(value => String(value).trim()),
    body('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
    body('json').exists().withMessage('json is required'),
  ],
  controller.addProjectObject
);

/**
 * @route POST /api/projects
 * @desc Add project
 */

router.post(
  '/',
  authenticate, 
  [
    body('project_name').exists().withMessage('project_name is required').bail().customSanitizer(value => String(value).trim()),
    body('class_id').exists().withMessage('class_id is required').bail().isInt().withMessage('class_id must be an integer').toInt(),
  ],
  controller.addProject
);

/**
 * @route PUT /api/projects
 * @desc Update project
 */

router.put(
  '/',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('project_name').exists().withMessage('project_name is required').bail().customSanitizer(value => String(value).trim()),
    body('class_id').exists().withMessage('class_id is required').bail().isInt().withMessage('class_id must be an integer').toInt(),
  ],
  controller.updateProject
);

/**
 * @route PUT /api/projects/users/permission
 * @desc Update user project permission
 */

router.put(
  '/users/permission',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('email').exists().withMessage('email is required').bail().customSanitizer(value => String(value).trim()),
    body('permission').exists().withMessage('permission is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.updateUserProjectPermission
);

/**
 * @route DELETE /api/projects/user
 * @desc Remove user from project
 */

router.delete(
  '/user',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('email').exists().withMessage('email is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.removeUserFromProject
);

/**
 * @route DELETE /api/projects
 * @desc Delete project
 */

router.delete(
  '/',
  authenticate, 
  [
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
  ],
  controller.deleteProject
);

module.exports = router;