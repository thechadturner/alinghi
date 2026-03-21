const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');

// Retrieve target channels
exports.getTargetChannels = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/targets', "function": 'getTargetChannels'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { class_name, project_id} = req.query; 

        let result = await check_permissions(req, 'read', project_id)

        if (result) {
        let params = [project_id];
        let sql = `SELECT DISTINCT jsonb_object_keys(value::jsonb) AS keys FROM ${class_name}.targets, jsonb_array_elements(json->'UPWIND') AS value WHERE "isPolar" = 0 and project_id = $1`
        
        let rows = await db.GetRows(sql, params);

        if (rows) {
            return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
        } else {
            return sendResponse(res, info, 204, false, 'No channels found', null);
        }
        } else {
        return sendResponse(res, info, 401, false, 'Unauthorized' , null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve targets
exports.getTargets = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/targets', "function": 'getTargets'}
  
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
  
    try {
      const { class_name, project_id, isPolar} = req.query; 
  
      let result = await check_permissions(req, 'read', project_id)
  
      if (result) {
            let params = [project_id, isPolar];
            let sql = `SELECT name FROM ${class_name}.targets where project_id = $1 and "isPolar" = $2 order by date_modified`
            
            let rows = await db.GetRows(sql, params);
    
            if (rows) {
                return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
            } else {
                return sendResponse(res, info, 204, false, 'No targets found', null);
            }
      } else {
            return sendResponse(res, info, 401, false, 'Unauthorized' , null);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve target data
exports.getTargetData = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/targets', "function": 'getTargetData'}
  
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
  
    try {
      const { class_name, project_id, name, isPolar} = req.query; 
  
      let result = await check_permissions(req, 'read', project_id)
  
      if (result) {
            let params = [project_id, name, isPolar];
            let sql = `SELECT json "value" FROM ${class_name}.targets where project_id = $1 and name = $2 and "isPolar" = $3`
            
            let value = await db.GetValue(sql, params);
    
            if (value != null) {
                return sendResponse(res, info, 200, true, "Data returned...", value, false);
            } else {
                return sendResponse(res, info, 204, false, 'No data found', null);
            }
      } else {
            return sendResponse(res, info, 401, false, 'Unauthorized' , null);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve latest target data
exports.getLatestTargets = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/targets', "function": 'getLatestTargets'}
  
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
  
    try {
      const { class_name, project_id, isPolar} = req.query; 
  
      let result = await check_permissions(req, 'read', project_id)
  
      if (result) {
            let params = [project_id, isPolar];
            let sql = `SELECT target_id, name, json FROM ${class_name}.targets where project_id = $1 and "isPolar" = $2 order by date_modified desc limit 1`
            
            let value = await db.GetRows(sql, params);
    
            if (value != null) {
                return sendResponse(res, info, 200, true, "Data returned...", value, false);
            } else {
                return sendResponse(res, info, 204, false, 'No data found', null);
            }
      } else {
            return sendResponse(res, info, 401, false, 'Unauthorized' , null);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};