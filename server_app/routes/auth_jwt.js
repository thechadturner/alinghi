const express = require('express');
const { body } = require('express-validator');
const { authenticate, rateLimitAuth } = require('../../shared/auth/middleware');
const authController = require('../controllers/auth_jwt');

const router = express.Router();

// Rate limit only login/register/verify/password endpoints to prevent brute force.
// Do NOT apply to /refresh or /user — those are used during normal sessions and
// counting them would kick users out after ~10 token refreshes in 15 min.
const authAttemptLimit = rateLimitAuth(10, 15 * 60 * 1000); // 10 attempts per 15 min per IP

// Validation rules
const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email address'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
  body('rememberMe').optional().isBoolean()
];

const registerValidation = [
  body('first_name')
    .isLength({ min: 1, max: 50 })
    .trim()
    .withMessage('First name is required and must be 1-50 characters'),
  body('last_name')
    .isLength({ min: 1, max: 50 })
    .trim()
    .withMessage('Last name is required and must be 1-50 characters'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .isLength({ max: 255 })
    .withMessage('Please provide a valid email address (max 255 characters)'),
  body('password')
    .isLength({ min: 8, max: 128 })
    .withMessage('Password must be 8-128 characters long')
];

const verifyValidation = [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 4, max: 4 }).isNumeric(),
  body('rememberMe').optional().isBoolean()
];

const refreshValidation = [
  body('refreshToken').notEmpty()
];

const forgotPasswordValidation = [
  body('email').isEmail().normalizeEmail()
];

const resetPasswordValidation = [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 4, max: 4 }).isNumeric(),
  body('newPassword').isLength({ min: 6 })
];

// Routes (rate limit only auth "attempt" endpoints; /refresh and /user are not limited)
router.get('/user', authenticate, authController.getUser);
router.post('/login', authAttemptLimit, loginValidation, authController.Login);
router.post('/register', authAttemptLimit, registerValidation, authController.Register);
router.post('/verify', authAttemptLimit, verifyValidation, authController.Verify);
router.post('/refresh', refreshValidation, authController.RefreshToken);
router.post('/logout', authenticate, authController.Logout);
router.post('/forgot-password', authAttemptLimit, forgotPasswordValidation, authController.ForgotPassword);
router.post('/reset-password', authAttemptLimit, resetPasswordValidation, authController.ResetPassword);

module.exports = router;
