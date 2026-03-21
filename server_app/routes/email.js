const express = require('express');
const { authenticate } = require('../middleware/auth_jwt');
const { body, validationResult } = require('express-validator');
const controller = require('../controllers/email');
const router = express.Router();

/**
 * @route POST /api/email/send
 * @desc Send an email
 * @access Private (requires authentication)
 */
router.post(
  '/send',
  authenticate,
  [
    body('to')
      .exists().withMessage('Recipient email address (to) is required')
      .isEmail().withMessage('Invalid recipient email format')
      .custom((value) => {
        // Support both single email and array of emails
        if (Array.isArray(value)) {
          return value.every(email => {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
          });
        }
        return true;
      }),
    body('subject')
      .exists().withMessage('Email subject is required')
      .trim()
      .isLength({ min: 1, max: 255 }).withMessage('Subject must be between 1 and 255 characters'),
    body('text')
      .optional()
      .isString().withMessage('Text body must be a string'),
    body('html')
      .optional()
      .isString().withMessage('HTML body must be a string'),
    body('cc')
      .optional()
      .custom((value) => {
        if (Array.isArray(value)) {
          return value.every(email => {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
          });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value);
      }),
    body('bcc')
      .optional()
      .custom((value) => {
        if (Array.isArray(value)) {
          return value.every(email => {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(email);
          });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value);
      }),
    body('replyTo')
      .optional()
      .isEmail().withMessage('Invalid reply-to email format')
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }
    next();
  },
  controller.sendEmail
);

/**
 * @route GET /api/email/verify
 * @desc Verify email service connection
 * @access Private (requires authentication)
 */
router.get(
  '/verify',
  authenticate,
  controller.verifyEmailService
);

/**
 * @route POST /api/email/process-completion
 * @desc Send process completion notification email (called by Python server)
 * @access Private (requires SYSTEM_KEY or authentication)
 */
router.post(
  '/process-completion',
  [
    body('user_id')
      .exists().withMessage('user_id is required')
      .isString().withMessage('user_id must be a string'),
    body('process_id')
      .exists().withMessage('process_id is required')
      .isString().withMessage('process_id must be a string'),
    body('script_name')
      .exists().withMessage('script_name is required')
      .isString().withMessage('script_name must be a string'),
    body('status')
      .optional()
      .isString().withMessage('status must be a string'),
    body('message')
      .optional()
      .isString().withMessage('message must be a string'),
    body('class_name')
      .optional()
      .isString().withMessage('class_name must be a string'),
    body('return_code')
      .optional()
      .isInt().withMessage('return_code must be an integer'),
    body('error_lines')
      .optional()
      .isArray().withMessage('error_lines must be an array')
  ],
  // Use authenticateWithResponse which handles SYSTEM_KEY, PAT, and JWT authentication
  // This ensures all requests are properly authenticated
  authenticate,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }
    next();
  },
  controller.sendProcessCompletionEmail
);

module.exports = router;
