const db = require("../middleware/db");
const { sendResponse } = require('../middleware/helpers');
const { check_permissions } = require('../middleware/auth_jwt');
const { validationResult } = require('express-validator');
const { error } = require('../../shared');

// Add or update class object
exports.addClassObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/classes', "function": 'addClassObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, object_name, json } = req.body; 
    
    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      // Check if object exists
      const selectSQL = `SELECT object_id "value" FROM ${class_name}.class_objects WHERE object_name = $1`;
      let object_id = await db.GetValue(selectSQL, [object_name]);

      let query, params;
      if (object_id === null) {
        query = `INSERT INTO ${class_name}.class_objects (object_name, json, date_modified) VALUES ($1, $2::jsonb, CURRENT_DATE)`;
        params = [object_name, json];
      } else {
        query = `UPDATE ${class_name}.class_objects SET json = $2::jsonb, date_modified = CURRENT_DATE WHERE object_id = $1`;
        params = [object_id, json];
      }

      // Execute query
      const success = await db.ExecuteCommand(query, params);
      const action = object_id === null ? 'insert' : 'update';
      
      if (success) {
        return sendResponse(res, info, 200, true, `${action} successful`, null, false);
      } else {
        return sendResponse(res, info, 500, false, `${action} failed`, null, true);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (err) {
    error('addClassObject - Error:', err);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
}