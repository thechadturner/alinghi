const { validationResult } = require('express-validator');
const { check_permissions } = require("../middleware/auth_jwt");
const { sendResponse } = require('../middleware/helpers');
const db = require("../middleware/db");

exports.addTarget = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/targets', "function": 'addTarget'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }
  
    try {
        const { class_name, project_id, name, json, isPolar } = req.body;

        let result = await check_permissions(req, 'write', project_id)
    
        if (result) {
            let sql = `select target_id "value" from ${class_name}.targets where project_id = $1 and name = $2`
            let params = [project_id, name]

            let result = await db.GetValue(sql, params);

            if (result) {
                sql = `update ${class_name}.targets set name = $2, json = $3::jsonb, date_modified = CURRENT_DATE where target_id = $1`
                params = [result, name, json]

                result = await db.ExecuteCommand(sql, params);

                if (result) {
                    return sendResponse(res, info, 200, true, "Targets updated successfully!", true, false);
                } else {
                    return sendResponse(res, info, 500, false, "Unable to update targets...", null, true);
                }
            } else {
                sql = `insert into ${class_name}.targets (project_id, name, json, date_modified, "isPolar") values ($1,$2,$3::jsonb,CURRENT_DATE,$4)`
                params = [project_id, name, json, isPolar]

                result = await db.ExecuteCommand(sql, params);

                if (result) {
                    return sendResponse(res, info, 200, true, "Targets inserted successfully!", true, false);
                } else {
                    return sendResponse(res, info, 500, false, "Unable to insert targets...", null, true);
                }
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.removeTarget = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/targets', "function": 'removeTarget'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
    
    try {
      const { class_name, project_id, name } = req.body;
  
      let result = await check_permissions(req, 'write', project_id)
  
      if (result) {  
        const sql = `DELETE FROM ${class_name}.targets WHERE name = $1`;
        const params = [name]; 
  
        let result = await db.ExecuteCommand(sql, params);
  
        if (result) {
            return sendResponse(res, info, 200, true, "Target removed successfully!", true, false);
        } else {
            return sendResponse(res, info, 204, false, "Target not removed", null, true);
        }
      } else {
        return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};