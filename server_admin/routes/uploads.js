const express = require('express');
const { body, query } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const { uploadFiles, uploadData, uploadTargets, uploadPolars, uploadVideo, listCsvFiles, checkFileExists } = require('../controllers/uploads');
const router = express.Router();
const { requirePatScopesIfPat } = require('../middleware/pat');
const { handleValidation } = require('../../shared/middleware/validation');

/**
 * @route POST /api/uploads/data
 * @desc Upload data
 */
router.post(
    '/data',
    authenticate,
    requirePatScopesIfPat(['upload']),
    uploadFiles.array('files'), 
    [
        body('class_name')
            .exists().withMessage('class_name is required')
            .bail()
            .custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; })
            .customSanitizer((value) => String(value).trim()),
        body('project_id')
            .exists().withMessage('project_id is required')
            .bail()
            .isInt().withMessage('project_id must be an integer')
            .toInt(),
        body('source_name')
            .isString().withMessage('source_name is required')
            .bail()
            .trim()
            .isLength({ min: 1, max: 128 }).withMessage('source_name must be 1-128 chars')
            .matches(/^[\w\-\s]+$/).withMessage('source_name may contain letters, numbers, spaces, _ and -'),
    ],
    handleValidation,
    uploadData
);

/**
 * @route POST /api/uploads/targets
 * @desc Upload targets
 */
router.post(
    '/target',
    authenticate,
    requirePatScopesIfPat(['upload']),
    uploadFiles.array('files'), 
    [
        body('class_name')
            .exists().withMessage('class_name is required')
            .bail()
            .custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; })
            .customSanitizer((value) => String(value).trim()),
        body('project_id')
            .exists().withMessage('project_id is required')
            .bail()
            .isInt().withMessage('project_id must be an integer')
            .toInt()
    ],
    handleValidation,
    uploadTargets
);

/**
 * @route POST /api/uploads/polars
 * @desc Upload polars
 */
router.post(
    '/polar',
    authenticate,
    requirePatScopesIfPat(['upload']),
    uploadFiles.array('files'), 
    [
        body('class_name')
            .exists().withMessage('class_name is required')
            .bail()
            .custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; })
            .customSanitizer((value) => String(value).trim()),
        body('project_id')
            .exists().withMessage('project_id is required')
            .bail()
            .isInt().withMessage('project_id must be an integer')
            .toInt()
    ],
    handleValidation,
    uploadPolars
);

/**
 * @route POST /api/uploads/video
 * @desc Upload video
 */
router.post(
    '/video',
    authenticate,
    requirePatScopesIfPat(['upload']),
    uploadFiles.array('files'), 
    [
        body('class_name')
            .exists().withMessage('class_name is required')
            .bail()
            .custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; })
            .customSanitizer((value) => String(value).trim()),
        body('project_id')
            .exists().withMessage('project_id is required')
            .bail()
            .isInt().withMessage('project_id must be an integer')
            .toInt(),
        body('date')
            .exists().withMessage('date is required')
            .bail()
            .isString().withMessage('date must be a string')
            .bail()
            .customSanitizer((value) => String(value).trim())
            .matches(/^\d{8}$/).withMessage('date must be YYYYMMDD'),
        body('media_source')
            .optional({ nullable: false })
            .isString().withMessage('media_source must be a string')
            .bail()
            .customSanitizer((value) => String(value).trim()),
        body('timezone')
            .optional()
            .isString().withMessage('timezone must be a string')
            .bail()
            .customSanitizer((value) => (value != null && value !== '') ? String(value).trim() : null),
        body('use_file_datetime')
            .optional()
            .customSanitizer((value) => {
                if (value === false || value === 'false' || value === 0 || value === '0') return false;
                return true;
            })
    ],
    handleValidation,
    uploadVideo
);

/**
 * @route GET /api/uploads/check-file
 * @desc Check if a file exists with the same name and size before uploading
 */
router.get(
    '/check-file',
    authenticate,
    [
        query('class_name')
            .exists().withMessage('class_name is required')
            .bail()
            .custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; })
            .customSanitizer((value) => String(value).trim()),
        query('project_id')
            .exists().withMessage('project_id is required')
            .bail()
            .isInt().withMessage('project_id must be an integer')
            .toInt(),
        query('source_name')
            .isString().withMessage('source_name is required')
            .bail()
            .trim()
            .isLength({ min: 1, max: 128 }).withMessage('source_name must be 1-128 chars'),
        query('date')
            .exists().withMessage('date is required')
            .bail()
            .isString().withMessage('date must be a string'),
        query('file_name')
            .exists().withMessage('file_name is required')
            .bail()
            .isString().withMessage('file_name must be a string'),
        query('file_size')
            .exists().withMessage('file_size is required')
            .bail()
            .isInt().withMessage('file_size must be an integer')
            .toInt(),
        query('is_xml')
            .optional()
            .customSanitizer((value) => {
              if (value === 'true' || value === true) return true;
              if (value === 'false' || value === false) return false;
              return false;
            })
    ],
    handleValidation,
    checkFileExists
);

/**
 * @route GET /api/uploads/csv-files
 * @desc List CSV files in a directory for a given project, class, date, and source
 */
router.get(
    '/csv-files',
    authenticate,
    [
        query('class_name')
            .exists().withMessage('class_name is required')
            .bail()
            .custom((value) => { if (!isValidateName(value)) { throw new Error('Invalid class name'); } return true; })
            .customSanitizer((value) => String(value).trim()),
        query('project_id')
            .exists().withMessage('project_id is required')
            .bail()
            .isInt().withMessage('project_id must be an integer')
            .toInt(),
        query('date')
            .exists().withMessage('date is required')
            .bail()
            .isString().withMessage('date must be a string'),
        query('source_name')
            .isString().withMessage('source_name is required')
            .bail()
            .trim()
            .isLength({ min: 1, max: 128 }).withMessage('source_name must be 1-128 chars')
    ],
    handleValidation,
    listCsvFiles
);

module.exports = router;
