const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse, getDatasetTimezone, formatDatetimeWithTimezone } = require('../middleware/helpers');

exports.getComments = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/comments', "function": 'getComments'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, timezone } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Get timezone: use provided timezone, or fetch dataset timezone, or default to UTC
      let targetTimezone = timezone;
      if (!targetTimezone) {
        targetTimezone = await getDatasetTimezone(class_name, dataset_id, db);
      }
      
      // Format datetime expressions - wrap expressions in parentheses for timezone conversion
      const datetimeExpr1 = formatDatetimeWithTimezone('a.datetime', targetTimezone, 'datetime');
      const datetimeExpr2 = formatDatetimeWithTimezone('(start_time + INTERVAL \'20 seconds\')', targetTimezone, 'datetime');
      const datetimeExpr3 = formatDatetimeWithTimezone('start_time', targetTimezone, 'datetime');
      
      const sql = `SELECT event_type, datetime, comment, user_name FROM (
        SELECT 
          'NOTE' AS event_type, 
          ${datetimeExpr1}, 
          COALESCE(comment, '') AS comment, 
          COALESCE(user_name, '') AS user_name
        FROM ${class_name}.comments a 
        INNER JOIN admin.users b ON a.user_id = b.user_id  
        WHERE a.dataset_id = $1

        UNION ALL

        SELECT 
          event_type, 
          ${datetimeExpr2}, 
          COALESCE((tags -> 'NOTE')::text, '') AS comment, 
          'System' AS user_name
        FROM ${class_name}.dataset_events  
        WHERE event_type not in ('DATASET','BIN 5','BIN 10','PHASE','PERIOD','MAINSAIL','HEADSAIL','GRADE') 
          and dataset_id = $1
          and tags IS NOT NULL
          and tags ? 'NOTE'

        UNION ALL

        SELECT 
          event_type, 
          ${datetimeExpr3}, 
          COALESCE((tags -> 'NOTE')::text, '') AS comment, 
          'System' AS user_name
        FROM ${class_name}.dataset_events  
        WHERE event_type in ('MAINSAIL','HEADSAIL','GRADE') 
          and dataset_id = $1
          and tags IS NOT NULL
          and tags ? 'NOTE'
      ) AS combined
      WHERE comment IS NOT NULL AND comment != ''
      ORDER BY datetime`;
      const params = [dataset_id];

      console.log(sql);

      let rows = await db.GetRows(sql, params);

      if (rows != null) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'Events table data not found' , null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    // Enhanced error logging to help debug the issue
    const errorDetails = {
      message: error.message,
      stack: error.stack,
      class_name: req.query?.class_name,
      dataset_id: req.query?.dataset_id,
      project_id: req.query?.project_id
    };
    console.error('getComments error:', JSON.stringify(errorDetails, null, 2));
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.addComment = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/comments', "function": 'addComment'}

    console.log(req.body);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null), true;
    }
  
    try {
        const { class_name, project_id, dataset_id, user_id, datetime, comment } = req.body;
    
        let result = await check_permissions(req, 'write', project_id)
    
        if (result) {
            const datetime_obj = new Date(datetime);
    
            let sql = `INSERT INTO ${class_name}.comments (dataset_id, user_id, datetime, comment) VALUES ($1, $2, $3, $4)`;
            let params = [dataset_id, user_id, datetime_obj.toISOString(), comment];
            
            let result = await db.ExecuteCommand(sql, params);
    
            if (result) {
                sql = `SELECT comment_id "value" FROM ${class_name}.comments WHERE dataset_id = $1 AND user_id = $2 AND datetime = $3 AND comment = $4 order by comment_id desc limit 1`;
                params = [dataset_id, user_id, datetime_obj.toISOString(), comment];
        
                result = await db.GetValue(sql, params);
        
                if (result) {
                    return sendResponse(res, info, 200, true, "Comment inserted successfully!", result, false);
                } else {
                    return sendResponse(res, info, 500, false, "Unable to insert comment...", null, true);
                }
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.deleteComment = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/comments', "function": 'deleteComment'}

  console.log(req.body);

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null), true;
  }

  try {
      const { class_name, project_id, dataset_id, user_id, datetime, comment } = req.body;
  
      let result = await check_permissions(req, 'write', project_id)
  
      if (result) {
          const datetime_obj = new Date(datetime);

          let sql = `SELECT comment_id "value" FROM ${class_name}.comments WHERE dataset_id = $1 AND user_id = $2 AND datetime = $3 AND comment = $4 order by comment_id desc limit 1`;
          let params = [dataset_id, user_id, datetime_obj.toISOString(), comment];
          
          let comment_id = await db.GetValue(sql, params);
  
          if (comment_id) {
              sql = `DELETE FROM ${class_name}.comments WHERE comment_id = $1`;
              params = [comment_id];
      
              result = await db.ExecuteCommand(sql, params);
      
              if (result) {
                  return sendResponse(res, info, 200, true, "Comment removed successfully!", result, false);
              } else {
                  return sendResponse(res, info, 500, false, "Unable to remove comment...", null, true);
              }
          }
      } else {
          return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
      }
  } catch (error) {
      return sendResponse(res, info, 500, false, error.message, null, true);
  }
};