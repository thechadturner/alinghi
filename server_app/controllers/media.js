const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');

// Retrieve media by type
exports.getMediaSources = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/media', "function": 'getMediaSources'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
      const { class_name, project_id } = req.query; 
      let { date } = req.query;
      // Normalize date to YYYY-MM-DD. Match on media.date (calendar day the media is associated with), not start_time UTC date.
      if (date) {
        try {
          if (/^\d{8}$/.test(date)) {
            date = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
          } else if (/^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(date)) {
            date = date.replace(/\//g, '-');
          } else {
            const d = new Date(date);
            if (!isNaN(d.getTime())) {
              const yyyy = d.getFullYear();
              const mm = String(d.getMonth() + 1).padStart(2, '0');
              const dd = String(d.getDate()).padStart(2, '0');
              date = `${yyyy}-${mm}-${dd}`;
            }
          }
        } catch (_) {}
      }
  
      let result = await check_permissions(req, 'read', project_id)
  
      if (result) {
        let params = [project_id, date];

        let sql = `SELECT media_source FROM ${class_name}.media WHERE project_id = $1 AND date = $2::date GROUP BY media_source ORDER BY media_source;`;

        let rows = await db.GetRows(sql, params);

        if (rows) {
            return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
        } else {
            return sendResponse(res, info, 204, false, "No media sources found on date "+date, null);
        }
      } else {
        return sendResponse(res, info, 401, false, "Unauthorized", null);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve media by type
exports.getMediaBySource = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/media', "function": 'getMediaBySource'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
      const { class_name, project_id, media_source } = req.query; 
      let { date } = req.query;
      // Normalize date to YYYY-MM-DD. Match on media.date (calendar day the media is associated with), not start_time UTC date.
      if (date) {
        try {
          if (/^\d{8}$/.test(date)) {
            date = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
          } else if (/^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(date)) {
            date = date.replace(/\//g, '-');
          } else {
            const d = new Date(date);
            if (!isNaN(d.getTime())) {
              const yyyy = d.getFullYear();
              const mm = String(d.getMonth() + 1).padStart(2, '0');
              const dd = String(d.getDate()).padStart(2, '0');
              date = `${yyyy}-${mm}-${dd}`;
            }
          }
        } catch (_) {}
      }
  
      let result = await check_permissions(req, 'read', project_id)
  
      if (result) {
        let params = [media_source, date];

        // Return start_time/end_time as timestamptz so the driver gives Date objects; JSON serializes them to ISO UTC (with Z). timezone is used for video sync known-time (local) conversion.
        let sql = `SELECT 
          media_id, 
          media_source, 
          start_time, 
          end_time, 
          file_name, 
          timezone 
          FROM ${class_name}.media 
          WHERE LOWER(media_source) = LOWER($1) AND date = $2::date;`
        
        let rows = await db.GetRows(sql, params);
  
        if (rows) {
            return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
        } else {
            return sendResponse(res, info, 204, false, "No media found for source "+media_source+" on date "+date, null);
        }
      } else {
        return sendResponse(res, info, 401, false, "Unauthorized", null);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};