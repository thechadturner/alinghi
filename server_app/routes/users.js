const express = require('express');
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/users');
const router = express.Router();

/**
 * @route GET /api/users/all
 * @desc Get all users
 */

router.get(
  '/all',
  authenticate, 
  controller.getUsers
);

/**
 * @route GET /api/users/active
 * @desc Get users activity status
 */

router.get(
  '/active',
  authenticate, 
  [
    query('id').exists().withMessage('id is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getUserStatus
);

/**
 * @route GET /api/users/permissions
 * @desc Get user permissions
 */

router.get(
  '/permissions',
  authenticate, 
  [
    query('id').exists().withMessage('id is required').bail().customSanitizer(value => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getUserPermissions
);

/**
 * @route GET /api/users/api_key
 * @desc Get user api_key
 */

router.get(
  '/api_key',
  authenticate, 
  [
    query('id').exists().withMessage('id is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getUserApiKey
);

/**
 * @route GET /api/users/subscription
 * @desc Get subscription
 */

router.get(
  '/subscription',
  authenticate, 
  controller.getSubscription
);

/**
 * @route GET /api/users
 * @desc Get user info
 */

router.get(
  '/',
  authenticate, 
  [
    query('id').exists().withMessage('id is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getUser
);

/**
 * @route POST /api/users
 * @desc Add user
 */

router.post(
  '/',
  authenticate, 
  [
    body('user_name')
      .exists().withMessage('user_name is required')
      .notEmpty().withMessage('user_name cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),
    
    body('first_name')
      .exists().withMessage('first_name is required')
      .notEmpty().withMessage('first_name cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('last_name')
      .exists().withMessage('last_name is required')
      .notEmpty().withMessage('last_name cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('email')
      .exists().withMessage('email is required')
      .isEmail().withMessage('Invalid email format')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('password_hash')
      .exists().withMessage('password_hash is required')
      .notEmpty().withMessage('password_hash cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),
  ],
  controller.addUser
);

/**
 * @route PUT /api/users/update
 * @desc Update user
 */

router.put(
  '/update',
  authenticate, 
  [
    body('id')
      .exists().withMessage('id is required')
      .notEmpty().withMessage('id cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('user_name')
      .exists().withMessage('user_name is required')
      .notEmpty().withMessage('user_name cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),
    
    body('first_name')
      .exists().withMessage('first_name is required')
      .notEmpty().withMessage('first_name cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('last_name')
      .exists().withMessage('last_name is required')
      .notEmpty().withMessage('last_name cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('email')
      .exists().withMessage('email is required')
      .isEmail().withMessage('Invalid email format')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('tags')
      .optional()
      .custom(value => {
        try {
          JSON.parse(value);
          return true;
        } catch {
          throw new Error('Invalid JSON format');
        }
      }),
  ],
  controller.updateUser
);

/**
 * @route PUT /api/users/update/subscription
 * @desc Update subscription
 */

router.put(
  '/update/subscription',
  authenticate, 
  [
    body('id')
      .exists().withMessage('id is required')
      .notEmpty().withMessage('id cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('subscription_type')
      .exists().withMessage('subscription_type is required')
      .notEmpty().withMessage('subscription_type cannot be empty')
      .bail()
      .customSanitizer(value => String(value).trim()),

    body('duration')
      .exists().withMessage('duration is required').bail().isInt().withMessage('duration must be an integer').toInt()
  ],
  controller.updateSubscription
);

/**
 * @route DISABLE /api/users/disable
 * @desc Disable user
 */

router.put(
  '/disable',
  authenticate, 
  [
    query('id').exists().withMessage('id is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.disableUser
);

/**
 * @route DELETE /api/users
 * @desc Delete user
 */

router.delete(
  '/',
  authenticate, 
  [
    query('id').exists().withMessage('id is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.deleteUser
);

/**
 * @route GET /api/users/objects
 * @desc Get User Objects
 */

router.get(
  '/object/names',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
    query('parent_name').exists().withMessage('parent_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getUserObjectNames
);

/**
 * @route GET /api/users/object
 * @desc Get User Object
 */

router.get(
  '/object',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
    query('parent_name').exists().withMessage('parent_name is required').bail().customSanitizer(value => String(value).trim()),
    query('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.getUserObject
);

/**
 * @route POST /api/users/object
 * @desc Add User Object
 */

router.post(
  '/object',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
    body('parent_name').exists().withMessage('parent_name is required').bail().customSanitizer(value => String(value).trim()),
    body('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
    body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addUserObject
);

/**
 * @route DELETE /api/users/object
 * @desc Delete User Object
 */

router.delete(
  '/object',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
    body('parent_name').exists().withMessage('parent_name is required').bail().customSanitizer(value => String(value).trim()),
    body('object_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim())
  ],
  controller.deleteUserObject
);

/**
 * @route POST /api/users/page
 * @desc Add User Page
 */

router.post(
  '/page',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer(value => String(value).trim()),
    body('page_type').exists().withMessage('page_type is required').bail().customSanitizer(value => String(value).trim()),
    body('page_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.addUserPage
);

/**
 * @route DELETE /api/users/page
 * @desc Delete User Page
 */

router.delete(
  '/page',
  authenticate, 
  [
    body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer(value => String(value).trim()),
    body('page_type').exists().withMessage('page_type is required').bail().customSanitizer(value => String(value).trim()),
    body('page_name').exists().withMessage('object_name is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.removeUserPage
);

/**
 * @route GET /api/users/settings
 * @desc Get User Settings
 */

router.get(
  '/settings',
  authenticate, 
  [
    query('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
  ],
  controller.getUserSettings
);

/**
 * @route POST /api/users/settings
 * @desc Save User Settings (upsert)
 */

router.post(
  '/settings',
  authenticate, 
  [
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
    body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.saveUserSettings
);

/**
 * @route PUT /api/users/settings
 * @desc Update User Settings (upsert)
 */

router.put(
  '/settings',
  authenticate, 
  [
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
    body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim()),
  ],
  controller.saveUserSettings
);

/**
 * @route DELETE /api/users/settings
 * @desc Delete User Settings
 */

router.delete(
  '/settings',
  authenticate, 
  [
    body('user_id').exists().withMessage('user_id is required').bail().customSanitizer((value) => String(value).trim()),
  ],
  controller.deleteUserSettings
);

module.exports = router;