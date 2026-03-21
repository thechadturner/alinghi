const { validationResult } = require('express-validator');
const { logMessage } = require("../middleware/logging");
const { check_permissions } = require("../middleware/auth_jwt");
const { ExecuteCommand, GetValue } = require("../middleware/db");
const { sendResponse } = require('../middleware/helpers');

//ADD or UPDATE DATASET OBJECT
exports.addProjectObject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/projects', "function": 'addProjectObject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, date, object_name, json } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Check if object exists
        const selectSQL = `SELECT object_id "value" FROM ${class_name}.project_objects WHERE project_id = $1 AND date = $2 AND object_name = $3`;
        const existingObject = await GetValue(selectSQL, [project_id, date, object_name]);

        let query, params;
        if (existingObject === null) {
            query = `INSERT INTO ${class_name}.project_objects (project_id, date, object_name, json, date_modified) VALUES ($1, $2, $3, $4::jsonb, CURRENT_DATE)`;
            params = [project_id, date, object_name, json];
        } else {
            query = `UPDATE ${class_name}.project_objects SET json = $4::jsonb, date_modified = CURRENT_DATE WHERE project_id = $1 AND date = $2 AND object_name = $3`;
            params = [project_id, date, object_name, json];
        }

        // Execute query
        const success = await ExecuteCommand(query, params);
        const action = existingObject === null ? 'insert' : 'update';
        
        if (success) {
            return sendResponse(res, info, 200, true, `${action} successful`, false);
        } else {
            return sendResponse(res, info, 500, false, `${action} failed`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//ADD or UPDATE DATASET PAGE
exports.addProjectPage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/projects', "function": 'addProjectPage'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, page_name } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Get page_id
        let query, params;
        query = `SELECT page_id "value" FROM ${class_name}.pages WHERE UPPER(page_name) = $1`;
        const page_id = await GetValue(query, [page_name.toUpperCase()]);

        if (page_id > 0) {
            // Check if object exists
            const selectSQL = `SELECT page_id "value" FROM ${class_name}.project_pages WHERE project_id = $1 AND page_id = $2`;
            const existingObject = await GetValue(selectSQL, [dataset_id, page_id]);

            if (existingObject === null) {
                query = `INSERT INTO ${class_name}.project_pages (project_id, page_id, date_modified) VALUES ($1, $2, CURRENT_DATE)`;
                params = [project_id, page_id];
            } else {
                query = `UPDATE ${class_name}.project_pages SET date_modified = CURRENT_DATE WHERE project_id = $1 AND page_id = $2`;
                params = [project_id, page_id];
            }

            // Execute query
            const success = await ExecuteCommand(query, params);
            const action = existingObject === null ? 'insert' : 'update';

            if (success) {
                return sendResponse(res, info, 200, true, `${action} successful`, false);
            } else {
                return sendResponse(res, info, 500, false, `${action} failed`, null, true);
            }
        } else {
            return sendResponse(res, info, 500, false, `No page found...`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//REMOVE DATASET PAGE
exports.removeProjectPage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/projects', "function": 'removeProjectPage'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, page_name } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Get page_id
        let query = `SELECT page_id "value" FROM ${class_name}.pages WHERE UPPER(page_name) = $1`;
        const page_id = await GetValue(query, [page_name.toUpperCase()]);

        if (page_id > 0) {
            // Check if object exists
            const sql = `DELETE FROM ${class_name}.project_pages WHERE project_id = $1 AND page_id = $2`;
            const success = await ExecuteCommand(sql, [project_id, page_id]);

            if (success) {
                return sendResponse(res, info, 200, true, `Delete successful`, false);
            } else {
                return sendResponse(res, info, 500, false, `Delete failed`, null, true);
            }
        } else {
            return sendResponse(res, info, 500, false, `No page found...`, null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};