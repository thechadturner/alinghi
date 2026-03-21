const express = require('express');
const { query, body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName, isValidateMediaSourceName } = require('../middleware/helpers');
const controller = require('../controllers/media');
const { createProxyMiddleware } = require('http-proxy-middleware');
const router = express.Router();

/**
 * @route GET /api/media/sources
 * @desc Get media sources
 */

router.get(
    '/sources',
    authenticate,
    [
      query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
      query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
      query('date')
        .exists().withMessage('date is required')
        .bail()
        .custom((value) => {
          // Allow YYYYMMDD, YYYY-MM-DD, YYYY/MM/DD
          if (/^\d{8}$/.test(value)) return true;
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
          if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return true;
          // Fallback to ISO 8601 check
          if (!isNaN(Date.parse(value))) return true;
          throw new Error('Invalid date format');
        })
        .customSanitizer((value) => String(value).trim())
    ],
    controller.getMediaSources
);

/**
 * @route GET /api/media
 * @desc Get media
 */

router.get(
    '/',
    authenticate,
    [
      query('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
      query('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
      query('media_source').exists().withMessage('media_source is required').bail().custom((value) => {if (!isValidateMediaSourceName(value)) { throw new Error('Invalid media source');} return true;}).customSanitizer((value) => String(value).trim()),
      query('date')
        .exists().withMessage('date is required')
        .bail()
        .custom((value) => {
          // Allow YYYYMMDD, YYYY-MM-DD, YYYY/MM/DD
          if (/^\d{8}$/.test(value)) return true;
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
          if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return true;
          // Fallback to ISO 8601 check
          if (!isNaN(Date.parse(value))) return true;
          throw new Error('Invalid date format');
        })
        .customSanitizer((value) => String(value).trim())
    ],
    controller.getMediaBySource
);

/**
 * @route GET /api/media/video
 * @desc Proxy video requests to media server for same-origin authentication
 */
router.get(
    '/video',
    // Remove authenticate middleware - let media server handle auth
    createProxyMiddleware({
        target: `http://${process.env.API_HOST || '192.168.0.18'}:${process.env.MEDIA_PORT || 8089}`,
        changeOrigin: false, // Don't change origin to preserve cookies
        pathRewrite: {
            '^/api/media/video': '/video'
        },
        onProxyReq: (proxyReq, req, res) => {
            // Forward all headers including authentication
            Object.keys(req.headers).forEach(key => {
                proxyReq.setHeader(key, req.headers[key]);
            });
            
            // Ensure credentials are included
            proxyReq.setHeader('credentials', 'include');
        }
    })
);

module.exports = router;