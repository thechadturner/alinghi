const db = require("../middleware/db");
const { sendResponse } = require('../middleware/helpers');
const { check_permissions } = require('../middleware/auth_jwt');
const { validationResult } = require('express-validator');
const { error } = require('../../shared');

// Retrieve all classes
exports.getClasses = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/classes', "function": 'getClasses'}

  try {
    const sql = "SELECT * FROM admin.classes ORDER BY class_name";
    const rows = await db.GetRows(sql, []);

    if (rows && rows.length > 0) {
      return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
    }

    return sendResponse(res, info, 204, false, "No classes found", null);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve class object
exports.getClassObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/classes', "function": 'getClassObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, object_name } = req.query; 
    
    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Use proper parameterization for schema name
      const sql = `SELECT json as "value" FROM ${class_name}.class_objects WHERE object_name = $1 ORDER BY date_modified DESC LIMIT 1`;
      const params = [ object_name ];
      
      let value;
      try {
        value = await db.GetValue(sql, params);
      } catch (sqlError) {
        error('getClassObject - SQL Error:', sqlError);
        // If table doesn't exist, return 404 instead of 500
        if (sqlError.message.includes('does not exist') || sqlError.message.includes('relation') || sqlError.message.includes('schema')) {
          return sendResponse(res, info, 404, false, 'Class objects table not found', null);
        }
        throw sqlError; // Re-throw if it's a different error
      }

      if (value != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'Class object not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (err) {
    error('getClassObject - Error:', err);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
}