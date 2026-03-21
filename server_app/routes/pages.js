const express = require("express");
const { query } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName, isValidatePath } = require('../middleware/helpers');
const controller = require('../controllers/pages');
const router = express.Router();

/**
 * @route GET /api/pages/selection
 * @desc Get all pages
 */

router.get(
  '/selection',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('user_id').exists().withMessage('user_id is required').bail().customSanitizer(value => String(value).trim()),
    query('page_type').exists().withMessage('page_type is required').bail().custom((value) => {if (!isValidatePath(value)) { throw new Error('Invalid page type');} return true;}).customSanitizer((value) => String(value).trim()),
  ],
  controller.getPageSelection
);

/**
 * @route GET /api/pages
 * @desc Get pages by page_type. dataset/explore and day/explore use user_pages (or project_pages if no user_id). dataset/reports uses dataset_pages when dataset_id provided. Other day/* (e.g. day/reports) uses day_pages (date required). Else project_pages.
 */

router.get(
  '/',
  authenticate,
  [
    query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
    query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
    query('page_type').exists().withMessage('page_type is required').bail().custom((value) => {if (!isValidatePath(value)) { throw new Error('Invalid page type');} return true;}).customSanitizer((value) => String(value).trim()),
    query('user_id').optional().customSanitizer((value) => value != null ? String(value).trim() : value),
    query('dataset_id').optional().isInt().withMessage('dataset_id must be an integer').toInt(),
    query('date').optional().customSanitizer((value) => value != null ? String(value).trim() : value),
  ],
  controller.getPages
);

module.exports = router;