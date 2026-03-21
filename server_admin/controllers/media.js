const fs = require('fs');
const path = require('path');
const { validationResult } = require('express-validator');
const { check_permissions } = require("../middleware/auth_jwt");
const { sendResponse } = require('../middleware/helpers');
const db = require("../middleware/db");
const { log } = require('../../shared');
const env = require('../middleware/config');

/**
 * Convert a local date/time in an IANA timezone to UTC using PostgreSQL.
 * Ensures consistent behavior across Windows and Linux (avoids Intl/ICU differences).
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timeStr - HH:mm or HH:mm:ss
 * @param {string} timezone - IANA (e.g. Pacific/Auckland)
 * @returns {Promise<string|null>} ISO UTC string or null
 */
async function localTimeInTimezoneToUtc(dateStr, timeStr, timezone) {
    if (!dateStr || !timezone || String(timezone).trim() === '') return null;
    const normalized = String(timeStr).trim();
    const parts = normalized.split(':');
    let timeNormalized = normalized;
    if (parts.length === 2) timeNormalized = `${parts[0]}:${parts[1]}:00`;
    else if (parts.length === 1) timeNormalized = `${parts[0]}:00:00`;
    const localTimestampString = `${dateStr} ${timeNormalized}`.trim();

    try {
        const sql = `SELECT ($1::timestamp AT TIME ZONE $2) AS value`;
        const value = await db.GetValue(sql, [localTimestampString, timezone]);
        if (value == null) return null;
        const dateObj = value instanceof Date ? value : new Date(value);
        return isNaN(dateObj.getTime()) ? null : dateObj.toISOString();
    } catch (e) {
        return null;
    }
}

/**
 * POST /api/admin/media/convert-local-to-utc
 * Body: { local_datetime: "2026-02-15T11:29:28" or "2026-02-15 11:29:28", timezone: "Pacific/Auckland" }
 * Returns: { success, utc: "2026-02-14T22:29:28.000Z" } so frontend can use for sync.
 * Ensures local→UTC conversion is done in one place (backend) for video sync.
 */
exports.convertLocalToUtc = async (req, res) => {
    const info = { auth_token: req.cookies?.auth_token, location: 'server_admin/media', function: 'convertLocalToUtc' };
    try {
        const { local_datetime, timezone } = req.body || {};
        const raw = (local_datetime != null ? String(local_datetime).trim() : '');
        const tz = (timezone != null && String(timezone).trim() !== '') ? String(timezone).trim() : null;
        if (!raw || !tz) {
            return sendResponse(res, info, 400, false, 'local_datetime and timezone are required', null, true);
        }
        let dateStr;
        let timeStr = '00:00:00';
        const sep = raw.indexOf('T') >= 0 ? 'T' : (raw.indexOf(' ') >= 0 ? ' ' : null);
        if (sep) {
            const idx = raw.indexOf(sep);
            dateStr = raw.slice(0, idx).trim();
            timeStr = raw.slice(idx + 1).trim();
        } else {
            dateStr = raw.slice(0, 10);
            if (raw.length > 10) timeStr = raw.slice(10).trim();
        }
        if (!dateStr || dateStr.length < 8) {
            return sendResponse(res, info, 400, false, 'Invalid local_datetime format', null, true);
        }
        dateStr = dateStr.replace(/\//g, '-');
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            // already YYYY-MM-DD
        } else if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
            const [d, m, y] = dateStr.split('-');
            dateStr = `${y}-${m}-${d}`;
        } else if (dateStr.length >= 8 && dateStr.length <= 10) {
            const nums = dateStr.replace(/-/g, '').replace(/\//g, '');
            if (nums.length === 8 && /^\d+$/.test(nums)) {
                dateStr = `${nums.slice(0, 4)}-${nums.slice(4, 6)}-${nums.slice(6, 8)}`;
            }
        }
        const parts = timeStr.split(':');
        if (parts.length === 2) timeStr = `${parts[0]}:${parts[1]}:00`;
        else if (parts.length === 1) timeStr = `${parts[0]}:00:00`;

        const utcIso = await localTimeInTimezoneToUtc(dateStr, timeStr, tz);
        if (!utcIso) {
            return sendResponse(res, info, 400, false, 'Could not convert local time to UTC for the given timezone', null, true);
        }
        return sendResponse(res, info, 200, true, 'OK', { utc: utcIso }, false);
    } catch (err) {
        return sendResponse(res, info, 500, false, err.message || 'Conversion failed', null, true);
    }
};

exports.addMedia = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/media', "function": 'addMedia'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }
  
    try {
        const { class_name, project_id, date, start_time, end_time, duration, file_name, media_source, tags, shared, timezone } = req.body;
        const tzVal = (timezone != null && typeof timezone === 'string' && timezone.trim() !== '') ? timezone.trim() : null;

        let result = await check_permissions(req, 'write', project_id)
    
        if (result) {
            // Check if media exists using project_id, file_name, media_source, and date
            let sql = `select media_id "value" from ${class_name}.media where project_id = $1 and file_name = $2 and media_source = $3 and date = $4`
            let params = [project_id, file_name, media_source, date]

            let result = await db.GetValue(sql, params);

            if (result) {
                // Update existing record including date and timezone
                sql = `update ${class_name}.media set date = $2, start_time = $3, end_time = $4, duration = $5, file_name = $6, media_source = $7, tags = $8::jsonb, shared = $9, timezone = $10 where media_id = $1`
                params = [result, date, start_time, end_time, duration, file_name, media_source, tags, shared, tzVal]

                const updateResult = await db.ExecuteCommandWithError(sql, params);

                if (updateResult.success) {
                    return sendResponse(res, info, 200, true, "Media updated successfully!", true, false);
                } else {
                    if (env.VITE_VERBOSE === 'true') {
                        log(sql, params)
                    }
                    const errMsg = updateResult.error ? `Unable to update media: ${updateResult.error}` : "Unable to update media...";
                    return sendResponse(res, info, 500, false, errMsg, null, true);
                }
            } else {
                // Insert new record including date and timezone
                sql = `insert into ${class_name}.media (project_id, date, start_time, end_time, duration, file_name, media_source, tags, shared, timezone) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`
                params = [project_id, date, start_time, end_time, duration, file_name, media_source, tags, shared, tzVal]

                const insertResult = await db.ExecuteCommandWithError(sql, params);

                if (insertResult.success) {
                    return sendResponse(res, info, 200, true, "Media inserted successfully!", true, false);
                } else {
                    if (env.VITE_VERBOSE === 'true') {
                        log(sql, params)
                    }
                    const errMsg = insertResult.error ? `Unable to insert media: ${insertResult.error}` : "Unable to insert media...";
                    return sendResponse(res, info, 500, false, errMsg, null, true);
                }
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.editMedia = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/media', "function": 'editMedia'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }
  
    try {
        const { class_name, project_id, media_id, start_time, end_time } = req.body;
        // start_time/end_time must be ISO 8601 UTC (e.g. with Z). Normalize to UTC ISO string so DB stores correct instant regardless of server TZ.
        const toUtcIso = (v) => {
            if (v instanceof Date) return v.toISOString();
            const s = String(v).trim();
            if (!s) return s;
            if (/Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
            return s.replace(/\.\d{3}$/, '') + 'Z';
        };
        const startIso = toUtcIso(start_time);
        const endIso = toUtcIso(end_time);

        let result = await check_permissions(req, 'write', project_id)
    
        if (result) {
            sql = `update ${class_name}.media set start_time = $2::timestamptz, end_time = $3::timestamptz where media_id = $1`
            params = [media_id, startIso, endIso]

            result = await db.ExecuteCommand(sql, params);

            if (result) {
                return sendResponse(res, info, 200, true, "Media updated successfully!", true, false);
            } else {
                if (env.VITE_VERBOSE === 'true') {
                    log(sql, params)
                }
                
                return sendResponse(res, info, 500, false, "Unable to update media...", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.removeMedia = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/events', "function": 'removeMedia'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
    
    try {
      const { class_name, project_id, file_name, media_source } = req.body;
  
      let result = await check_permissions(req, 'write', project_id)

      if (result) {
        const sql = `DELETE FROM ${class_name}.media WHERE project_id = $1 and file_name = $2 and media_source = $3`;
        const params = [project_id, file_name, media_source];

        let result = await db.ExecuteCommand(sql, params);
  
        if (result) {
            return sendResponse(res, info, 200, true, "Media removed successfully!", true, false);
        } else {
            if (env.VITE_VERBOSE === 'true') {
                log(sql, params)
            }
            
            return sendResponse(res, info, 204, false, "Media not removed", null, true);
        }
      } else {
        return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

/**
 * Remove all media for a given project_id and date: remove the date folder on disk then delete DB rows.
 */
exports.removeMediaByDate = async (req, res) => {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/media', "function": 'removeMediaByDate' };

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const { class_name, project_id, date } = req.body;

        const hasPermission = await check_permissions(req, 'write', project_id);
        if (!hasPermission) {
            return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
        }

        // Normalize date to YYYY-MM-DD for SQL
        let normalizedDate = String(date).trim();
        if (/^\d{8}$/.test(normalizedDate)) {
            normalizedDate = `${normalizedDate.slice(0, 4)}-${normalizedDate.slice(4, 6)}-${normalizedDate.slice(6, 8)}`;
        } else if (/^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(normalizedDate)) {
            normalizedDate = normalizedDate.replace(/\//g, '-');
        }

        let mediaBase = env?.MEDIA_DIRECTORY || 'C:/MyApps/Hunico/Uploads/Media';
        mediaBase = path.normalize(mediaBase).replace(/[\\/]+$/, '');
        const classLower = String(class_name || '').toLowerCase();
        const dateYyyyMmDd = normalizedDate;
        const dateYyyyMmdd = normalizedDate.replace(/-/g, '');

        for (const dateSegment of [dateYyyyMmdd, dateYyyyMmDd]) {
            const dateDir = path.join(mediaBase, 'System', String(project_id), classLower, dateSegment);
            try {
                if (fs.existsSync(dateDir)) {
                    fs.rmSync(dateDir, { recursive: true, force: true });
                    if (env.VITE_VERBOSE === 'true') {
                        log(info.location, info.function, 'Removed directory:', dateDir);
                    }
                }
            } catch (err) {
                log(info.location, info.function, 'Error removing directory (continuing):', dateDir, err.message);
            }
        }

        const deleteSql = `DELETE FROM ${class_name}.media WHERE project_id = $1 AND date = $2::date`;
        const deleteResult = await db.ExecuteCommand(deleteSql, [project_id, normalizedDate]);

        if (deleteResult) {
            return sendResponse(res, info, 200, true, 'Media removed for date successfully.', true, false);
        } else {
            return sendResponse(res, info, 500, false, 'Failed to delete media rows.', null, true);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};