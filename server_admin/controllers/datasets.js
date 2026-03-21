const { validationResult } = require('express-validator');
const { logMessage } = require("../middleware/logging");
const { check_permissions } = require("../middleware/auth_jwt");
const { ExecuteCommand, GetValue } = require("../middleware/db");
const { sendResponse } = require('../middleware/helpers');

//ADD or UPDATE DATASET OBJECT
exports.addDatasetObject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/datasets', "function": 'addDatasetObject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, parent_name, object_name, json } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Check if object exists
        const selectSQL = `SELECT object_id "value" FROM ${class_name}.dataset_objects WHERE dataset_id = $1 AND parent_name = $2 AND object_name = $3`;
        const existingObject = await GetValue(selectSQL, [dataset_id, parent_name,object_name]);

        let query, params;
        if (existingObject === null) {
            query = `INSERT INTO ${class_name}.dataset_objects (dataset_id, parent_name, object_name, json, date_modified) VALUES ($1, $2, $3, $4::jsonb, CURRENT_DATE)`;
            params = [dataset_id, parent_name, object_name, json];
        } else {
            query = `UPDATE ${class_name}.dataset_objects SET json = $4::jsonb, date_modified = CURRENT_DATE WHERE dataset_id = $1 AND parent_name = $2 AND object_name = $3`;
            params = [dataset_id, parent_name, object_name, json];
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
exports.addDatasetPage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/datasets', "function": 'addDatasetPage'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, page_name } = req.body;

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
            const selectSQL = `SELECT page_id "value" FROM ${class_name}.dataset_pages WHERE dataset_id = $1 AND page_id = $2`;
            const existingObject = await GetValue(selectSQL, [dataset_id, page_id]);

            if (existingObject === null) {
                query = `INSERT INTO ${class_name}.dataset_pages (dataset_id, page_id, date_modified) VALUES ($1, $2, CURRENT_DATE)`;
                params = [dataset_id, page_id];
            } else {
                query = `UPDATE ${class_name}.dataset_pages SET date_modified = CURRENT_DATE WHERE dataset_id = $1 AND page_id = $2`;
                params = [dataset_id, page_id];
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

//ADD or UPDATE DAY PAGE (day_pages table: project_id, date, page_id, date_modified)
exports.addDayPage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/datasets', "function": 'addDayPage'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, date, page_name } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Normalize date to YYYYMMDD
        const dateNorm = (date && typeof date === 'string') ? date.replace(/[-/]/g, '').trim() : String(date).replace(/[-/]/g, '').trim();
        if (dateNorm.length !== 8) {
            return sendResponse(res, info, 400, false, 'date must be YYYY-MM-DD or YYYYMMDD', null, true);
        }

        // Resolve page_id from pages where page_type = 'day/reports' (day report pages only)
        const pageNameNorm = (page_name && String(page_name).trim()) ? String(page_name).trim().toUpperCase() : '';
        let query, params;
        query = `SELECT page_id "value" FROM ${class_name}.pages WHERE page_type = 'day/reports' AND UPPER(TRIM(page_name)) = $1`;
        const page_id = await GetValue(query, [pageNameNorm]);

        if (page_id > 0) {
            // Check if row exists (project_id, date, page_id)
            const selectSQL = `SELECT page_id "value" FROM ${class_name}.day_pages WHERE project_id = $1 AND date = $2 AND page_id = $3`;
            const existingObject = await GetValue(selectSQL, [project_id, dateNorm, page_id]);

            if (existingObject === null) {
                query = `INSERT INTO ${class_name}.day_pages (project_id, date, page_id, date_modified) VALUES ($1, $2, $3, CURRENT_DATE)`;
                params = [project_id, dateNorm, page_id];
            } else {
                query = `UPDATE ${class_name}.day_pages SET date_modified = CURRENT_DATE WHERE project_id = $1 AND date = $2 AND page_id = $3`;
                params = [project_id, dateNorm, page_id];
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
            return sendResponse(res, info, 400, false, 'No day/reports page found for that page_name', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// REMOVE DAY PAGE (day_pages: project_id, date, page_id from day/reports)
exports.removeDayPage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/datasets', "function": 'removeDayPage'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, date, page_name } = req.body;

        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        const dateNorm = (date && typeof date === 'string') ? date.replace(/[-/]/g, '').trim() : String(date).replace(/[-/]/g, '').trim();
        if (dateNorm.length !== 8) {
            return sendResponse(res, info, 400, false, 'date must be YYYY-MM-DD or YYYYMMDD', null, true);
        }

        const pageNameNorm = (page_name && String(page_name).trim()) ? String(page_name).trim().toUpperCase() : '';
        let query = `SELECT page_id "value" FROM ${class_name}.pages WHERE page_type = 'day/reports' AND UPPER(TRIM(page_name)) = $1`;
        const page_id = await GetValue(query, [pageNameNorm]);

        if (page_id > 0) {
            const sql = `DELETE FROM ${class_name}.day_pages WHERE project_id = $1 AND date = $2 AND page_id = $3`;
            const success = await ExecuteCommand(sql, [project_id, dateNorm, page_id]);

            if (success) {
                return sendResponse(res, info, 200, true, 'Delete successful', false);
            }
            return sendResponse(res, info, 500, false, 'Delete failed', null, true);
        }
        return sendResponse(res, info, 400, false, 'No day/reports page found for that page_name', null, true);
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//REMOVE DATASET PAGE
exports.removeDatasetPage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/datasets', "function": 'removeDatasetPage'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, page_name } = req.body;

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
            const sql = `DELETE FROM ${class_name}.dataset_pages WHERE dataset_id = $1 AND page_id = $2`;
            const success = await ExecuteCommand(sql, [dataset_id, page_id]);

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

// Update dataset date_modified
exports.updateDatasetDateModified = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/datasets', "function": 'updateDatasetDateModified'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, dataset_id, source_id, date } = req.body;

        // Check permissions
        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        let actualDatasetId = dataset_id;
        
        // If dataset_id not provided, get it from source_id and date
        if (!actualDatasetId && source_id && date) {
            const sanitizedDate = date.replace(/[-/]/g, "");
            const sql = `SELECT dataset_id "value" FROM ${class_name}.datasets WHERE source_id = $1 AND date = $2 ORDER BY dataset_id DESC LIMIT 1`;
            actualDatasetId = await GetValue(sql, [source_id, sanitizedDate]);
            
            if (!actualDatasetId) {
                return sendResponse(res, info, 404, false, 'Dataset not found for source_id and date', null, true);
            }
        }
        
        if (!actualDatasetId) {
            return sendResponse(res, info, 400, false, 'Either dataset_id or (source_id and date) must be provided', null, true);
        }

        // Update date_modified to current timestamp
        const sql = `UPDATE ${class_name}.datasets SET date_modified = CURRENT_TIMESTAMP WHERE dataset_id = $1`;
        const success = await ExecuteCommand(sql, [actualDatasetId]);
        
        if (success) {
            return sendResponse(res, info, 200, true, "Dataset date_modified updated successfully", null, false);
        } else {
            return sendResponse(res, info, 500, false, 'Failed to update dataset date_modified', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};