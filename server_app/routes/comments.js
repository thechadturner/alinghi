const express = require('express');
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/comments');
const router = express.Router();

/**
 * @route GET /api/comments
 * @desc Get comments
*/

router.get(
  '/',
  authenticate, 
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
    query('timezone').optional().isString().trim().isLength({ min: 1, max: 128 }).withMessage('timezone must be 1-128 chars')
  ],
  controller.getComments
);

/**
 * @route POST /api/comment
 * @desc Add comment
*/

router.post(
    '/',
    authenticate, 
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
        body("user_id").isString().withMessage('user_id is required').trim(),
        body("datetime").isISO8601().toDate().withMessage("Invalid datetime format"),
        body("comment").isString().withMessage('comment is required').trim()
    ],
    controller.addComment
);

/**
 * @route DELETE /api/comment
 * @desc Delete comment
*/

router.delete(
  '/',
  authenticate, 
  [
      body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
      body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
      body('dataset_id').exists().withMessage('dataset_id is required').bail().isInt().withMessage('dataset_id must be an integer').toInt(),
      body("user_id").isString().withMessage('user_id is required').trim(),
      body("datetime").isISO8601().toDate().withMessage("Invalid datetime format"),
      body("comment").isString().withMessage('comment is required').trim()
  ],
  controller.deleteComment
);

module.exports = router;