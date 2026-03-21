const express = require("express");
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/media');
const router = express.Router();

/**
 * @route POST /api/media
 * @desc Add media
*/

router.post(
    '/',
    authenticate, 
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('date')
            .exists().withMessage('date is required')
            .bail()
            .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
            .customSanitizer(value => String(value).trim()),
        body("start_time").isISO8601().toDate().withMessage("Invalid start time format"),
        body("end_time").isISO8601().toDate().withMessage("Invalid end time format"),
        body('duration').exists().withMessage('duration is required').bail().isFloat().withMessage('duration must be a float').toFloat(),
        // Allow full file paths with directories and placeholders like {res}
        body('file_name')
            .exists().withMessage('file_name is required')
            .bail()
            .isString().withMessage('file_name must be a string')
            .bail()
            .custom((value) => {
                const v = String(value);
                if (v.length < 3) throw new Error('file_name too short');
                if (v.includes('\u0000')) throw new Error('file_name contains invalid characters');
                return true;
            })
            .customSanitizer((value) => String(value).trim()),
        body('media_source').exists().withMessage('media_source is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid media_source');} return true;}).customSanitizer((value) => String(value).trim()),
        body("tags").isString().withMessage('tags is required').trim(),
        body('shared').exists().withMessage('shared is required').bail().isInt().withMessage('shared must be an integer').toInt(),
        body('timezone').optional().isString().withMessage('timezone must be a string').bail().customSanitizer((value) => (value != null && value !== '') ? String(value).trim() : null),
    ],
    controller.addMedia
);

/**
 * @route POST /api/admin/media/convert-local-to-utc
 * @desc Convert a local datetime in a given IANA timezone to UTC (for video sync known time).
 */
router.post(
    '/convert-local-to-utc',
    authenticate,
    [
        body('local_datetime').exists().withMessage('local_datetime is required').isString().trim(),
        body('timezone').exists().withMessage('timezone is required').isString().trim(),
    ],
    controller.convertLocalToUtc
);

/**
 * @route PUT /api/media
 * @desc Edit media
*/

router.put(
    '/',
    authenticate, 
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('media_id').exists().withMessage('media_id is required').bail().isInt().withMessage('media_id must be an integer').toInt(),
        body("start_time").isISO8601().toDate().withMessage("Invalid start time format"),
        body("end_time").isISO8601().toDate().withMessage("Invalid end time format"),
    ],
    controller.editMedia
);

/**
 * @route DELETE /api/media/by-date
 * @desc Remove all media for a project and date (physical files + DB rows)
 */
router.delete(
    '/by-date',
    authenticate,
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; }).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('date')
            .exists().withMessage('date is required')
            .bail()
            .matches(/^(\d{4}-\d{2}-\d{2}|\d{8})$/).withMessage('date must be YYYY-MM-DD or YYYYMMDD')
            .customSanitizer((value) => String(value).trim()),
    ],
    controller.removeMediaByDate
);

/**
 * @route DELETE /api/media
 * @desc Remove media (single file by file_name and media_source)
 */
router.delete(
    '/',
    authenticate, 
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('file_name').exists().withMessage('file_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid file_name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('media_source').exists().withMessage('media_source is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid media_source');} return true;}).customSanitizer((value) => String(value).trim())
    ],
    controller.removeMedia
);

module.exports = router;