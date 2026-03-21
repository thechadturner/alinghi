const db = require("../middleware/db");
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');
const { debug } = require('../../shared/utils/console');

exports.getTimeZones = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/admin', "function": 'getTimeZones'}

  try {
    const { project_id } = req.query; 

    // project_id is optional - if provided, check permissions, otherwise allow
    let result = true;
    if (project_id) {
      result = await check_permissions(req, 'read', project_id);
    }

    if (result) {
      let params = [];
      let sql = `SELECT name FROM pg_timezone_names`

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No data found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve user activity
exports.getUserActivity = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/admin', "function": 'getUserActivity'}

    try {
      const user_id = req.user.user_id
      
      if (user_id != db.GetSuperUser()) {
        return sendResponse(res, info, 401, false, 'Unauthorized', null);
      }

      // Parse pagination parameters
      const page = parseInt(req.query.page) || 1;
      const limit = 100; // Fixed limit of 100 results per page
      const offset = (page - 1) * limit;

      // Validate pagination parameters
      if (page < 1) {
        return sendResponse(res, info, 400, false, "Invalid pagination parameters. Page must be >= 1");
      }

      // Get total count for pagination metadata
      const countSql = `SELECT COUNT(*) "value" FROM admin.user_activity a inner join admin.users b on a.user_id = b.user_id`;
      const totalRecords = await db.GetValue(countSql, []);
      const totalPages = Math.ceil(totalRecords / limit);

      // Get paginated data
      const sql = `SELECT CAST(datetime as TEXT), email, client_ip, file_name "location", message, context FROM admin.user_activity a inner join admin.users b on a.user_id = b.user_id ORDER BY id DESC LIMIT $1 OFFSET $2`;

      debug('getUserActivity: SQL query:', sql);
      debug('getUserActivity: Query params:', [limit, offset]);
      let rows = await db.GetRows(sql, [limit, offset]);
      debug('getUserActivity: Query result:', rows);
  
      // GetRows now returns [] for empty results, so we can always proceed
      const paginationInfo = {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      };

      return sendResponse(res, info, 200, true, `${rows.length} rows returned (page ${page} of ${totalPages})...`, {
        data: rows,
        pagination: paginationInfo
      }, false);
    } catch (error) {
      return sendResponse(res, info, 500, false, error.message, true);
    }
};

// Retrieve recent activity
exports.getLogActivity = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/admin', "function": 'getLogActivity'}

    try {
      const user_id = req.user.user_id
      
      if (user_id != db.GetSuperUser()) {
        return sendResponse(res, info, 401, false, 'Unauthorized', null);
      }
      
      // Parse pagination parameters
      const page = parseInt(req.query.page) || 1;
      const limit = 100; // Fixed limit of 100 results per page
      const offset = (page - 1) * limit;

      // Parse search and filter parameters
      const searchTerm = req.query.search || '';
      const logType = req.query.log_type || '';
      const logLevel = req.query.log_level || '';

      // Validate pagination parameters
      if (page < 1) {
        return sendResponse(res, info, 400, false, "Invalid pagination parameters. Page must be >= 1");
      }

      // Build WHERE clause for filtering
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;

      if (searchTerm) {
        whereConditions.push(`(
          LOWER(a.message) LIKE LOWER($${paramIndex}) OR 
          LOWER(b.email) LIKE LOWER($${paramIndex}) OR 
          LOWER(a.file_name) LIKE LOWER($${paramIndex}) OR 
          LOWER(a.log_level) LIKE LOWER($${paramIndex})
        )`);
        queryParams.push(`%${searchTerm}%`);
        paramIndex++;
      }

      if (logType && logType !== 'all') {
        whereConditions.push(`a.log_type = $${paramIndex}`);
        queryParams.push(logType);
        paramIndex++;
      }

      if (logLevel && logLevel !== 'all') {
        whereConditions.push(`a.log_level = $${paramIndex}`);
        queryParams.push(logLevel);
        paramIndex++;
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Get total count for pagination metadata
      const countSql = `SELECT COUNT(*) "value" FROM admin.log_activity a inner join admin.users b on a.user_id = b.user_id ${whereClause}`;
      const totalRecords = await db.GetValue(countSql, queryParams);
      const totalPages = Math.ceil(totalRecords / limit);

      // Get paginated data with filtering
      const sql = `SELECT CAST(datetime as TEXT), email, file_name, log_type, log_level, message, context FROM admin.log_activity a inner join admin.users b on a.user_id = b.user_id ${whereClause} ORDER BY id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      
      const finalParams = [...queryParams, limit, offset];
      let rows = await db.GetRows(sql, finalParams);
  
      // GetRows now returns [] for empty results, so we can always proceed
      const paginationInfo = {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      };

      return sendResponse(res, info, 200, true, `${rows.length} rows returned (page ${page} of ${totalPages})...`, {
        data: rows,
        pagination: paginationInfo
      }, false);
    } catch (error) {
      return sendResponse(res, info, 500, false, error.message, true);
    }
};