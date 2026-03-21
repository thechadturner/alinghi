const jwt = require("jsonwebtoken");
const db = require("../middleware/db");
const env = require('../middleware/config');
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');
const { log, warn, error, debug } = require('../../shared');

// Retrieve all users
exports.getUsers = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUsers'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id

    // Check if user is super user or has enterprise subscription
    let isAuthorized = false;
    
    if (user_id == db.GetSuperUser()) {
      isAuthorized = true;
    } else {
      // Check user's subscription type
      const subscriptionCheckSql = `
        SELECT s.subscription_type 
        FROM latest_user_subscriptions s 
        WHERE s.user_id = $1
      `;

      debug('Checking subscription for user_id:', user_id);
      const subscriptionResult = await db.GetRows(subscriptionCheckSql, [user_id]);
      debug('Subscription result:', subscriptionResult);
      
      if (subscriptionResult && subscriptionResult.length > 0 && subscriptionResult[0].subscription_type === 'enterprise') {
        debug('User has enterprise subscription, authorized');
        isAuthorized = true;
      } else {
        debug('User does not have enterprise subscription');
      }
    }

    if (isAuthorized) {
      const sql = `SELECT 
          u.user_id,
          CONCAT(u.first_name,' ',u.last_name,' (',u.user_name,')') as user,
          u.email,
          u.created_at,
          u.last_login_at AS last_login,
          u.is_active,
          s.subscription_type,
          COALESCE(p.PAT, 0) AS PAT,
          b.billing_status
        FROM admin.users u
        JOIN admin.latest_user_subscriptions s ON u.user_id = s.user_id
        LEFT JOIN admin.active_personal_api_tokens p ON u.user_id = p.user_id
        LEFT JOIN admin.latest_billing_events b ON s.subscription_id = b.subscription_id`

      let rows = await db.GetRows(sql, [])
 
      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" records found", rows, false);
      } else {
        debug(sql)

        return sendResponse(res, info, 500, false, "Failed to retrieve users", null, true);
      }
    } else {
      return sendResponse(res, info, 403, false, "Access denied. Enterprise subscription required to view user list.", null);
    }
  } catch (error) {
    error('Error in getUsers:', error);
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Check if user is active
exports.getUserStatus = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUserStatus'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id } = req.query;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = `SELECT is_active "value" from admin.users where user_id = $1`
		const params = [id]

    const result = await db.GetValue(sql, params)	

    if (result) {
      return sendResponse(res, info, 200, true, "User active", true, false);
    } else {
      return sendResponse(res, info, 500, false, "User not active", false, true);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Check if user permissions
exports.getUserPermissions = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUserPermissions'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id, project_id } = req.query;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = `SELECT permission "value" FROM admin.user_projects WHERE user_id = $1 and project_id = $2 limit 1`;
    const params = [id, project_id];

    const value = await db.GetValue(sql, params)	

    if (value) {
      return sendResponse(res, info, 200, true, "User permission", value, false);
    } else {
      return sendResponse(res, info, 500, false, "User not permission not found", false, true);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Check if user api_key
exports.getUserApiKey = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUserApiKey'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id } = req.query;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = `SELECT token_hash "value" from admin.active_personal_api_tokens where user_id = $1 and pat = 1`
		const params = [ id ]

    const result = await db.GetValue(sql, params)	

    if (result) {
      return sendResponse(res, info, 200, true, "1 record found", result, false);
    } else {
      debug(sql)

      return sendResponse(res, info, 204, false, "User API key not found", null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve user by ID
exports.getUser = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUser'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id } = req.query;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
    
    const sql = "SELECT * FROM admin.users WHERE user_id = $1 limit 1";
    const params = [id];

    let rows = await db.GetRows(sql, params)

    if (rows) {
      return sendResponse(res, info, 200, true, "1 record found", rows[0], false);
    } else {
      return sendResponse(res, info, 204, false, "User not found", null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Add a new user
exports.addUser = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'addUser'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id

    if (user_id == db.GetSuperUser()) {
      const { user_name, first_name, last_name, email, password_hash } = req.body;

      let sql = `INSERT INTO admin.users (user_name, first_name, last_name, email, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING user_id`;
      let params = [user_name, first_name, last_name, email, password_hash];

      let rows = await db.GetRows(sql, params)

      if (rows && rows.length > 0) {
        const newUserId = rows[0].user_id;
        
        // Check if user was in users_pending table and transfer permissions
        const checkPendingSql = `SELECT * FROM admin.users_pending WHERE email = $1`;
        const pendingUsers = await db.GetRows(checkPendingSql, [email]);
        
        if (pendingUsers && pendingUsers.length > 0) {
          // Transfer project permissions from users_pending to user_projects
          for (const pending of pendingUsers) {
            // Check if permission already exists
            const checkSql = `SELECT permission FROM admin.user_projects WHERE user_id = $1 AND project_id = $2`;
            const existingPermission = await db.GetRows(checkSql, [newUserId, pending.project_id]);
            
            let result;
            if (existingPermission && existingPermission.length > 0) {
              // Update existing permission
              const updateSql = `UPDATE admin.user_projects SET permission = $3 WHERE user_id = $1 AND project_id = $2`;
              result = await db.ExecuteCommand(updateSql, [newUserId, pending.project_id, pending.permission]);
            } else {
              // Insert new permission
              const insertSql = `INSERT INTO admin.user_projects (user_id, project_id, permission) VALUES ($1, $2, $3)`;
              result = await db.ExecuteCommand(insertSql, [newUserId, pending.project_id, pending.permission]);
            }
            
            if (result) {
              log(`Transferred project permission for ${email}: project_id=${pending.project_id}, permission=${pending.permission}`);
            } else {
              error(`Failed to transfer project permission for ${email}: project_id=${pending.project_id}, permission=${pending.permission}`);
            }
          }
          
          // Remove user from users_pending table
          const deletePendingSql = `DELETE FROM admin.users_pending WHERE email = $1`;
          const deleteResult = await db.ExecuteCommand(deletePendingSql, [email]);
          
          if (deleteResult) {
            log(`Removed user from users_pending table: ${email}`);
          } else {
            error(`Failed to remove user from users_pending table: ${email}`);
          }
        }
        
        return sendResponse(res, info, 201, true, "User added successfully", null);
      } else {
        return sendResponse(res, info, 500, false, "Failed to add user", null, true);
      }
    } else {
      return sendResponse(res, info, 401, false, "Unauthorized", null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Update user by ID
exports.updateUser = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'updateUser'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id, user_name, first_name, last_name, email, tags } = req.body;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = "UPDATE admin.users SET user_name = $1, first_name = $2, last_name = $3, email = $4, tags = $5::jsonb WHERE user_id = $6";
    const params = [user_name, first_name, last_name, email, tags, id];

    let result = await db.ExecuteCommand(sql, params)

    if (result) {
      const user_info = {user_id: user_id, user_name: user_name, first_name: first_name, last_name: last_name, email: email}
      const auth_token = jwt.sign(user_info, process.env.JWT_SECRET, {expiresIn: "7d",});

      res.cookie("auth_token", auth_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        // sameSite: "None", //"Strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return sendResponse(res, info, 200, true, "User updated successfully", user_info, false);
    } else {
      return sendResponse(res, info, 500, false, "Failed to update user", null, true);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Get Subscription
exports.getSubscription = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getSubscription'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id } = req.query;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = `SELECT subscription_type "value" FROM admin.user_subscriptions WHERE user_id = $1 and status = 'active' order by created_at desc limit 1`;
    const params = [id];

    let result = await db.GetValue(sql, params)

    if (result) {
      return sendResponse(res, info, 200, true, "Subscription found!", result, false);
    } else {
      return sendResponse(res, info, 200, false, "No subscription found...", 'none');
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Subscription
exports.updateSubscription = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getSubscription'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id, subscription_type, duration } = req.body;

    debug('Update subscription request:', { user_id, id, subscription_type, duration });

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    // First, check if the table exists
    let tableExists = false;
    try {
      const tableCheckSql = `SELECT EXISTS (
          SELECT 1 
          FROM information_schema.tables 
          WHERE table_schema = 'admin' 
            AND table_name = 'user_subscriptions'
        ) AS value`;

      tableExists = await db.GetValue(tableCheckSql, []);
      debug('Table exists:', tableExists);
    } catch (tableCheckError) {
      error('Error checking if table exists:', tableCheckError);
    }

    // Check if user has any existing subscriptions
    let existingCount = 0;
    if (tableExists) {
      let checkSql = `SELECT COUNT(*) as "value" FROM admin.user_subscriptions WHERE user_id = $1`;
      let checkParams = [ id ];
      debug('Checking existing subscriptions:', { checkSql, checkParams });
      
      try {
        const countResult = await db.GetValue(checkSql, checkParams);
        existingCount = countResult || 0;
        debug('Existing subscriptions count:', existingCount);
      } catch (checkError) {
        error('Error checking existing subscriptions:', checkError);
        existingCount = 0;
      }
    } else {
      debug('Table does not exist, will try to create it or use alternative approach');
    }

    // Only cancel existing subscriptions if they exist
    if (existingCount && existingCount > 0) {
      let sql = "UPDATE admin.user_subscriptions SET status = 'canceled', canceled_at = now(), end_date = now() WHERE user_id = $1";
      let params = [ id ];

      debug('Canceling existing subscriptions:', { sql, params });
      let result = await db.ExecuteCommand(sql, params)
      debug('Cancel result:', result);
      
      // Let's also check what the existing subscription looks like
      try {
        const existingSql = "SELECT * FROM admin.user_subscriptions WHERE user_id = $1 LIMIT 1";
        const existingData = await db.GetRows(existingSql, [id]);
        debug('Existing subscription data:', existingData);
      } catch (existingError) {
        error('Error fetching existing subscription:', existingError);
      }
    }

    if (subscription_type == 'none') {
      return res.status(200).json({ success: true, message: "Subscription updated successfully."});
    } else if (!tableExists) {
      debug('Table does not exist, returning success without database storage');
      return res.status(200).json({ success: true, message: "Subscription updated successfully (table not found)."});
    } else {
      const now = new Date(); 
      const futureDate = new Date(now);  
      futureDate.setDate(futureDate.getDate() + Math.max(duration, 1)); // Ensure at least 1 day duration

      const end_date = futureDate.toISOString();
      const start_date = new Date().toISOString().slice(0, 10); // store as date (YYYY-MM-DD)
      const end_date_date = end_date.slice(0, 10); // ensure DATE type
   
      sql = `INSERT INTO admin.user_subscriptions (user_id, subscription_type, status, start_date, end_date, auto_renew) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
      params = [ id, subscription_type, 'active', start_date, end_date_date, false ];

      debug('Inserting new subscription:', { sql, params });
      try {
        const insertResult = await db.GetRows(sql, params);
        debug('Insert result:', insertResult);
        result = insertResult && insertResult.length > 0;

        if (result) {
          // Update project pages for the user's owned projects based on subscription type
          try {
            await updateProjectPagesForSubscription(id, subscription_type);
          } catch (pageUpdateError) {
            error('Failed to update project pages for subscription change:', pageUpdateError);
            // Don't fail the subscription update if project pages update fails
          }
          
          return sendResponse(res, info, 200, true, "Subscription updated successfully.", null, false);
        } else {
          // Try to get more specific error information
          error('Insert failed - checking table structure...');
          try {
            const tableCheckSql = "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'user_subscriptions' AND table_schema = 'admin' ORDER BY ordinal_position";
            const tableStructure = await db.GetRows(tableCheckSql, []);
            debug('Table structure:', tableStructure);
          } catch (tableError) {
            error('Error checking table structure:', tableError);
          }
          
          return sendResponse(res, info, 500, false, "Failed to insert subscription - check table constraints", null, true);
        }
      } catch (insertError) {
        error('Error inserting subscription:', insertError);
        return sendResponse(res, info, 500, false, "Database error: " + insertError.message, null, true);
      }
    }
  } catch (error) {
    error('Error in updateSubscription:', error);
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Disable user by ID
exports.disableUser = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'disableUser'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id } = req.body;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = "UPDATE admin.users SET is_active = false, deleted_at = now() where user_id = $1";
    const params = [id];

    let result = await db.ExecuteCommand(sql, params)

    if (result) {
      return sendResponse(res, info, 200, true, "User disabled successfully", null, false);
    } else {
      return sendResponse(res, info, 500, false, "Failed to disable user", null, true);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Delete user by ID
exports.deleteUser = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'deleteUser'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_id = req.user.user_id
    const { id } = req.body;

    // Check permissions
    if (user_id != id && user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = "DELETE FROM admin.users WHERE user_id = $1";
    const params = [id];

    let result = await db.ExecuteCommand(sql, params)

    if (result) {
      return sendResponse(res, info, 200, true, "User deleted successfully", null, false);
    } else {
      return sendResponse(res, info, 500, false, "Failed to delete user", null, true);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Get user objects
exports.getUserObjectNames = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUserObjectNames'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, user_id, parent_name } = req.query;

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Include own objects + others' public charts (shared = 1 or true). Limit 50 so non-admins see public charts.
      const sharedCondition = `(json ->> 'shared' = '1' OR json ->> 'shared' = 'true')`;
      // When requesting fleet_* (day mode), also include shared charts from non-fleet parent so dataset-mode public charts appear in day view
      const altParent = (parent_name === 'fleet_timeseries') ? 'timeseries' : (parent_name === 'fleet_scatter') ? 'scatter' : (parent_name === 'fleet_probability') ? 'probability' : null;
      let sql = `SELECT object_id, object_name, date_modified, isMine from (
        SELECT object_id, object_name, date_modified, 1 as isMine FROM ${class_name}.user_objects 
        WHERE user_id = $1 and parent_name = $2 
        UNION ALL 
        SELECT object_id, object_name, date_modified, 0 as isMine FROM ${class_name}.user_objects 
        WHERE user_id <> $1 and parent_name = $2 and ${sharedCondition}`;
      const params = [user_id, parent_name];
      if (altParent) {
        sql += `
        UNION ALL 
        SELECT object_id, object_name, date_modified, 0 as isMine FROM ${class_name}.user_objects 
        WHERE user_id <> $1 and parent_name = $3 and ${sharedCondition}`;
        params.push(altParent);
      }
      sql += `
      ) order by date_modified desc limit 50`;

      let rows = await db.GetRows(sql, params);

      debug('getUserObjectNames', { parent_name, user_id: user_id?.toString?.()?.slice(0, 8), rowCount: rows?.length ?? 0, altParent: altParent || '-' });
      if (rows && rows.length > 0) {
        return sendResponse(res, info, 200, true, rows.length + " records found", rows, false);
      } else {
        return sendResponse(res, info, 204, false, `No objects found for ${parent_name}`, null);
      }
    } else {
      debug('getUserObjectNames permission denied', { parent_name, user_id: user_id?.toString?.()?.slice(0, 8) });
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Get user object
exports.getUserObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUserObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, user_id, parent_name, object_name } = req.query; 
    
    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Query for objects owned by user OR shared objects owned by others (shared = 1 or true)
      const sharedCondition = `(json ->> 'shared' = '1' OR json ->> 'shared' = 'true')`;
      const altParent = (parent_name === 'fleet_timeseries') ? 'timeseries' : (parent_name === 'fleet_scatter') ? 'scatter' : (parent_name === 'fleet_probability') ? 'probability' : null;
      let sql = `SELECT json "value" FROM (
        SELECT json, date_modified FROM ${class_name}.user_objects 
        WHERE user_id = $1 AND parent_name = $2 AND object_name = $3
        UNION ALL 
        SELECT json, date_modified FROM ${class_name}.user_objects 
        WHERE user_id <> $1 AND parent_name = $2 AND object_name = $3 AND ${sharedCondition}`;
      const params = [user_id, parent_name, object_name];
      if (altParent) {
        sql += `
        UNION ALL 
        SELECT json, date_modified FROM ${class_name}.user_objects 
        WHERE user_id <> $1 AND parent_name = $4 AND object_name = $3 AND ${sharedCondition}`;
        params.push(altParent);
      }
      sql += `
      ) ORDER BY date_modified DESC LIMIT 1`;
      
      let value;
      try {
        value = await db.GetValue(sql, params);
      } catch (sqlError) {
        error('getUserObject - SQL Error:', sqlError);
        // If table doesn't exist, return 404 instead of 500
        if (sqlError.message.includes('does not exist') || sqlError.message.includes('relation') || sqlError.message.includes('schema')) {
          return sendResponse(res, info, 404, false, 'User objects table not found', null);
        }
        throw sqlError; // Re-throw if it's a different error
      }

      if (value != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, `No objects found for ${parent_name} and ${object_name}`, null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

//Add/update user object
exports.addUserObject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'addUserObject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
      const { class_name, project_id, user_id, parent_name, object_name, json } = req.body;

      // Check permissions: readers can save their own chart objects; writers can too
      const hasPermission = (await check_permissions(req, 'write', project_id)) || (await check_permissions(req, 'read', project_id));
      if (!hasPermission) {
          return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
      }

      // Check if object exists
      const selectSQL = `SELECT object_id "value" FROM ${class_name}.user_objects WHERE user_id = $1 AND parent_name = $2 AND object_name = $3`;
      const existingObject = await db.GetValue(selectSQL, [user_id, parent_name, object_name]);

      let query, params;
      if (existingObject === null) {
          query = `INSERT INTO ${class_name}.user_objects (user_id, parent_name, object_name, json, date_modified) VALUES ($1, $2, $3, $4::jsonb, CURRENT_DATE)`;
          params = [user_id, parent_name, object_name, json];
      } else {
          query = `UPDATE ${class_name}.user_objects SET json = $4::jsonb, date_modified = CURRENT_DATE WHERE user_id = $1 AND parent_name = $2 AND object_name = $3`;
          params = [user_id, parent_name, object_name, json];
      }

      // Execute query
      const success = await db.ExecuteCommand(query, params);
      const action = existingObject === null ? 'insert' : 'update';
      
      if (success) {
          return sendResponse(res, info, 200, true, `${action} successful`, true, false);
      } else {
          return sendResponse(res, info, 500, false, `${action} failed`, null, true);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

//Delete user object
exports.deleteUserObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'deleteUserObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
  }

  try {
    const { class_name, project_id, user_id, parent_name, object_name } = req.body;

    // Check permissions: readers can delete their own chart objects; writers can too
    const hasPermission = (await check_permissions(req, 'write', project_id)) || (await check_permissions(req, 'read', project_id));
    if (!hasPermission) {
        return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
    }

    // Check if object exists
    const selectSQL = `SELECT object_id "value" FROM ${class_name}.user_objects WHERE user_id = $1 AND parent_name = $2 AND object_name = $3`;
    const existingObject = await db.GetValue(selectSQL, [user_id, parent_name, object_name]);

    if (existingObject === null) {
        return sendResponse(res, info, 404, false, 'Object not found', null, true);
    }

    // Delete the object
    const deleteSQL = `DELETE FROM ${class_name}.user_objects WHERE user_id = $1 AND parent_name = $2 AND object_name = $3`;
    const success = await db.ExecuteCommand(deleteSQL, [user_id, parent_name, object_name]);
    
    if (success) {
        return sendResponse(res, info, 200, true, 'Delete successful', true, false);
    } else {
        return sendResponse(res, info, 500, false, 'Delete failed', null, true);
    }
  } catch (error) {
      return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

//ADD or UPDATE USER PAGE
exports.addUserPage = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/users', "function": 'addUserPage'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
  }

  try {
      const { class_name, project_id, user_id, page_type, page_name } = req.body;

      // Check permissions
      const hasPermission = await check_permissions(req, 'read', project_id);
      if (!hasPermission) {
          return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
      }

      let query, params;
      
      query = `SELECT page_id "value" FROM ${class_name}.pages WHERE page_type = $1 and UPPER(page_name) = $2`;
      const page_id = await db.GetValue(query, [page_type, page_name.toUpperCase()]);

      if (page_id > 0) {
          // Check if object exists
          const selectSQL = `SELECT page_id "value" FROM ${class_name}.user_pages WHERE user_id = $1 AND page_id = $2`;
          const existingObject = await db.GetValue(selectSQL, [user_id, page_id]);

          if (existingObject === null) {
              query = `INSERT INTO ${class_name}.user_pages (user_id, page_id, date_modified) VALUES ($1, $2, CURRENT_DATE)`;
              params = [user_id, page_id];
          } else {
              query = `UPDATE ${class_name}.user_pages SET date_modified = CURRENT_DATE WHERE user_id = $1 AND page_id = $2`;
              params = [user_id, page_id];
          }

          // Execute query
          const success = await db.ExecuteCommand(query, params);
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

//REMOVE USER PAGE
exports.removeUserPage = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/users', "function": 'removeUserPage'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
  }

  try {
      const { class_name, project_id, user_id, page_type, page_name } = req.body;

      // Check permissions
      const hasPermission = await check_permissions(req, 'read', project_id);
      if (!hasPermission) {
          return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
      }

      // Get page_id
      let query = `SELECT page_id "value" FROM ${class_name}.pages WHERE page_type = $1 and UPPER(page_name) = $2`;
      const page_id = await db.GetValue(query, [page_type, page_name.toUpperCase()]);

      if (page_id > 0) {
          // Check if object exists
          const sql = `DELETE FROM ${class_name}.user_pages WHERE user_id = $1 AND page_id = $2`;
          const success = await db.ExecuteCommand(sql, [user_id, page_id]);

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

// Helper function to update project pages based on subscription type
async function updateProjectPagesForSubscription(user_id, subscription_type) {
  try {
    // Map subscription type to permission level
    let permissionLevel;
    switch (subscription_type) {
      case 'free':
        permissionLevel = 1;
        break;
      case 'standard':
        permissionLevel = 2;
        break;
      case 'pro':
        permissionLevel = 3;
        break;
      case 'member':
        // Members don't own projects, so skip
        return true;
      default:
        return true;
    }

    // Get user's projects with class names
    const projectsSql = `
      SELECT p.project_id, p.class_id, c.class_name 
      FROM admin.projects p
      INNER JOIN admin.classes c ON p.class_id = c.class_id
      WHERE p.user_id = $1
    `;
    
    const projects = await db.GetRows(projectsSql, [user_id]);
    
    if (!projects || projects.length === 0) {
      return true;
    }

    // Update project_pages for each project
    for (const project of projects) {
      const { project_id, class_name } = project;
      
      try {
        // Delete existing project_pages entries
        const deleteSql = `DELETE FROM ${class_name}.project_pages WHERE project_id = $1`;
        const deleteResult = await db.ExecuteCommand(deleteSql, [project_id]);
        
        if (!deleteResult) {
          error(`Failed to delete existing project_pages for project ${project_id} in class ${class_name}`);
          continue;
        }

        // Get pages with permission level <= subscription level
        const pagesSql = `SELECT page_id FROM ${class_name}.pages WHERE permission_level <= $1`;
        const pages = await db.GetRows(pagesSql, [permissionLevel]);
        
        if (pages && pages.length > 0) {
          // Insert new project_pages entries
          const insertSql = `
            INSERT INTO ${class_name}.project_pages (project_id, page_id, date_modified)
            VALUES ($1, $2, CURRENT_DATE)
          `;
          
          for (const page of pages) {
            const insertResult = await db.ExecuteCommand(insertSql, [project_id, page.page_id]);
            if (!insertResult) {
              error(`Failed to insert project_page for project ${project_id}, page ${page.page_id} in class ${class_name}`);
            }
          }
        }
        
      } catch (projectError) {
        error(`Error updating project_pages for project ${project_id} in class ${class_name}:`, projectError);
        // Continue with other projects even if one fails
      }
    }

    return true;
  } catch (error) {
    error('Error in updateProjectPagesForSubscription:', error);
    throw error;
  }
}

// ===== USER SETTINGS ENDPOINTS =====

// GET user settings
exports.getUserSettings = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'getUserSettings'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { user_id } = req.query;
    
    // Check if user is requesting their own settings or is authorized
    if (req.user.user_id !== user_id && req.user.user_id !== db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const sql = `SELECT json "value" FROM admin.user_settings WHERE user_id = $1 ORDER BY date_modified DESC LIMIT 1`;
    const params = [user_id];
    
    let settings;
    try {
      settings = await db.GetValue(sql, params);
      // Debug logging (only in debug mode)
      debug('getUserSettings - Retrieved from DB:', { 
        hasSettings: !!settings,
        type: typeof settings, 
        isNull: settings === null, 
        isUndefined: settings === undefined
      });
    } catch (sqlError) {
      error('getUserSettings - SQL Error:', sqlError);
      if (sqlError.message.includes('does not exist') || sqlError.message.includes('relation')) {
        return sendResponse(res, info, 404, false, 'User settings table not found', null);
      }
      throw sqlError;
    }

    // Check if settings is null, undefined, or empty
    if (settings === null || settings === undefined) {
      debug('getUserSettings - Settings is null/undefined, returning 200 with null data');
      return sendResponse(res, info, 200, true, 'No settings found', null);
    }

    // Ensure settings is returned as data (even if it's an empty object)
    // db.GetValue for JSONB should return the object directly, but ensure it's valid
    debug('getUserSettings - Returning settings:', { 
      hasSettings: !!settings, 
      settingsType: typeof settings,
      settingsKeys: typeof settings === 'object' ? Object.keys(settings).length : 0
    });
    return sendResponse(res, info, 200, true, 'Settings retrieved successfully', settings);
  } catch (error) {
    error('getUserSettings - Error:', error);
    return sendResponse(res, info, 500, false, 'Internal server error', null);
  }
};

// POST/PUT user settings (upsert)
exports.saveUserSettings = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'saveUserSettings'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
  }

  try {
    const { user_id, json } = req.body;

    // Check if user is saving their own settings or is authorized
    if (req.user.user_id !== user_id && req.user.user_id !== db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
    }

    // Check if settings exist
    const selectSQL = `SELECT object_id "value" FROM admin.user_settings WHERE user_id = $1`;
    const existingSettings = await db.GetValue(selectSQL, [user_id]);

    let query, params, action;
    if (existingSettings === null) {
      // INSERT new settings
      query = `INSERT INTO admin.user_settings (user_id, json, date_modified) VALUES ($1, $2::jsonb, CURRENT_DATE)`;
      params = [user_id, json];
      action = 'insert';
    } else {
      // UPDATE existing settings
      query = `UPDATE admin.user_settings SET json = $2::jsonb, date_modified = CURRENT_DATE WHERE user_id = $1`;
      params = [user_id, json];
      action = 'update';
    }

    // Execute query
    const success = await db.ExecuteCommand(query, params);
    
    if (success) {
      return sendResponse(res, info, 200, true, `${action} successful`, true, false);
    } else {
      return sendResponse(res, info, 500, false, `${action} failed`, null, true);
    }
  } catch (error) {
    error('saveUserSettings - Error:', error);
    return sendResponse(res, info, 500, false, 'Internal server error', null, true);
  }
};

// DELETE user settings
exports.deleteUserSettings = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/users', "function": 'deleteUserSettings'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
  }

  try {
    const { user_id } = req.body;

    // Check if user is deleting their own settings or is authorized
    if (req.user.user_id !== user_id && req.user.user_id !== db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
    }

    const selectSQL = `SELECT object_id "value" FROM admin.user_settings WHERE user_id = $1`;
    const existingSettings = await db.GetValue(selectSQL, [user_id]);

    if (existingSettings === null) {
      return sendResponse(res, info, 404, false, 'Settings not found', null, true);
    }

    const deleteSQL = `DELETE FROM admin.user_settings WHERE user_id = $1`;
    const success = await db.ExecuteCommand(deleteSQL, [user_id]);
    
    if (success) {
      return sendResponse(res, info, 200, true, 'Delete successful', true, false);
    } else {
      return sendResponse(res, info, 500, false, 'Delete failed', null, true);
    }
  } catch (error) {
    error('deleteUserSettings - Error:', error);
    return sendResponse(res, info, 500, false, 'Internal server error', null, true);
  }
};