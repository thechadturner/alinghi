const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { getSourceColor } = require('../middleware/helpers');
const { sendResponse } = require('../middleware/helpers');

// Retrieve project sources
exports.getSources = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/sources', "function": 'getSources'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(JSON.stringify(errors.array())), null);
  }

  try {
    const { class_name, project_id } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
        let params = [ project_id ];
        let sql = `SELECT source_id, source_name, color, visible, fleet, false "show_picker" FROM ${class_name}.sources where project_id = $1 order by source_name desc`;
        
        let rows = await db.GetRows(sql, params);

        if (rows) {
          return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
        } else {
          return sendResponse(res, info, 204, false, "No sources found", null);
        }
    } else {
      return sendResponse(res, info, 401, false, "Unauthorized", null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Add a new source
exports.addSource = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/sources', "function": 'addSource'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  // try {
    let { class_name, project_id, source_name, color } = req.body;
    
    let result = await check_permissions(req, 'write', project_id)

    if (result) {
        let sql = `SELECT source_id "value" from ${class_name}.sources WHERE project_id = $1 and source_name = $2 order by source_id desc limit 1`;
        let params = [project_id,source_name];
    
        let source_id = await db.GetValue(sql, params);
    
        if (source_id === null) {
          if (color === undefined) {
            color = getSourceColor(source_name)
          }

          sql = `INSERT INTO ${class_name}.sources (project_id, source_name, color, visible) VALUES ($1, $2, $3, 1)`;
          params = [project_id,source_name,color];
          
          let result = await db.ExecuteCommand(sql, params);
      
          if (result) {
            sql = `SELECT source_id "value" from ${class_name}.sources order by source_id desc limit 1`;
            params = []
      
            source_id = await db.GetValue(sql, params);
      
            if (source_id != null) {
              return sendResponse(res, info, 201, true, "Source added successfully", source_id);
            } else {
              return sendResponse(res, info, 500, false, "Failed to add source", null, true);
            }
          } else {
            return sendResponse(res, info, 500, false, "Failed to add source", null, true);
          }
        } else {
          return sendResponse(res, info, 200, true, "Source found", source_id, false);
        }
    } else {
      return sendResponse(res, info, 401, false, "Unauthorized", null);
    }
  // } catch (error) {
  //   return sendResponse(res, info, 500, false, error.message, null, true);
  // }
};

// Update source by ID
exports.updateSource = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/sources', "function": 'updateSource'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, source_name, color, fleet, visible } = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
        const sql = `UPDATE ${class_name}.sources SET source_name = $1, color = $2, fleet = $3, visible = $4 WHERE source_id = $5`;
        const params = [source_name, color, fleet, visible, source_id];

        result = await db.ExecuteCommand(sql, params);

        if (result) {
          return sendResponse(res, info, 200, true, "Source updated successfully");
        } else {
          return sendResponse(res, info, 500, false, "Failed to update source", null, false, true);
        }
    } else {
      return sendResponse(res, info, 401, false, "Unauthorized", null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Delete source by ID
exports.deleteSource = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/sources', "function": 'deleteSource'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
      const { class_name, project_id, source_id } = req.body;

      let result = await check_permissions(req, 'write', project_id)

      if (result) {
          const sql = `DELETE FROM ${class_name}.sources WHERE source_id = $1`;
          const params =  [source_id ];
      
          result = await db.ExecuteCommand(sql, params);
      
          if (result) {
            return sendResponse(res, info, 200, true, "Source deleted successfully");
          } else {
            return sendResponse(res, info, 500, false, "Failed to delete source", null, false, true);
          }
      } else {
        return sendResponse(res, info, 401, false, "Unauthorized", null);
      }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};