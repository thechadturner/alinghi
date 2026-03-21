const express = require("express");
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth_jwt');
const { isValidateName } = require('../middleware/helpers');
const controller = require('../controllers/targets');
const router = express.Router();

/**
 * @route POST /api/targets
 * @desc Add targets
*/

router.post(
    '/',
    authenticate, 
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('name').exists().withMessage('target name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid target name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('json').exists().withMessage('json is required').bail().customSanitizer(value => String(value).trim()),
        body('isPolar').exists().withMessage('isPolar is required').bail().isInt().withMessage('isPolar must be an integer').toInt()
    ],
    controller.addTarget
);

/**
 * @route POST /api/targets
 * @desc Remove targets
*/

router.delete(
    '/',
    authenticate, 
    [
        body('class_name').exists().withMessage('class_name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid class name');} return true;}).customSanitizer((value) => String(value).trim()),
        body('project_id').exists().withMessage('project_id is required').bail().isInt().withMessage('project_id must be an integer').toInt(),
        body('name').exists().withMessage('target name is required').bail().custom((value) => {if (!isValidateName(value)) { throw new Error('Invalid target name');} return true;}).customSanitizer((value) => String(value).trim())
    ],
    controller.removeTarget
);

module.exports = router;