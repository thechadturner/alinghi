const db = require('../middleware/db');
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');

const SCHEMA = 'ac40';
const TABLE = `${SCHEMA}.user_events`;

/** Query/body ids vs pg driver can mix number and string — avoid false 404 from `!==`. */
function sameProjectId(dbVal, reqVal) {
  return Number(dbVal) === Number(reqVal);
}

function isSailCrewEventType(eventType) {
  const et = String(eventType || '').toUpperCase();
  return et === 'SAILS' || et === 'CREW';
}

/** jsonb from pg: object; tolerate string or null. */
function tagsFromDbRow(raw) {
  if (raw == null) {
    return {};
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      if (o != null && typeof o === 'object' && !Array.isArray(o)) {
        return o;
      }
    } catch {
      return { Comment: raw };
    }
  }
  return {};
}

/** String used by Tagger UI / legacy `comment` field in API responses. */
function commentDisplayFromTags(tags, eventType) {
  const t = tags != null && typeof tags === 'object' && !Array.isArray(tags) ? tags : {};
  if (isSailCrewEventType(eventType)) {
    return JSON.stringify(t);
  }
  const c = t.Comment != null ? t.Comment : t.comment;
  return c != null ? String(c) : '';
}

/**
 * Request body → jsonb object. Prefer `tags`; else map legacy `comment`.
 */
function normalizeTagsFromBody(body, eventType) {
  const et = String(eventType || '').toUpperCase();
  const rawTags = body.tags;
  if (rawTags != null && typeof rawTags === 'object' && !Array.isArray(rawTags)) {
    return rawTags;
  }
  const comment = body.comment;
  if (isSailCrewEventType(et)) {
    if (typeof comment === 'string' && comment.trim() !== '') {
      try {
        const o = JSON.parse(comment);
        if (o != null && typeof o === 'object' && !Array.isArray(o)) {
          return o;
        }
      } catch {
        return {};
      }
    }
    return {};
  }
  return { Comment: comment != null ? String(comment) : '' };
}

/**
 * Normalize row keys for JSON (camelCase optional — keep DB column names as returned by pg)
 */
function rowFromDb(r) {
  if (!r) return null;
  const dm = r.date_modified;
  const tags = tagsFromDbRow(r.tags);
  return {
    user_event_id: r.user_event_id,
    project_id: r.project_id,
    user_id: r.user_id,
    user_name: r.user_name != null ? r.user_name : null,
    date: r.date,
    focus_time: r.focus_time,
    start_time: r.start_time,
    end_time: r.end_time,
    event_type: r.event_type,
    tags,
    comment: commentDisplayFromTags(tags, r.event_type),
    date_modified: dm != null ? (dm instanceof Date ? dm.toISOString() : String(dm)) : null,
  };
}

exports.listUserEvents = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/user_events', function: 'listUserEvents' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { project_id, date_from, date_to, after_user_event_id, modified_after } = req.query;
    const allowed = await check_permissions(req, 'read', project_id);
    if (!allowed) {
      // 403: authenticated but no access to this project — do not use 401 (client clears session on 401).
      return sendResponse(res, info, 403, false, 'Forbidden', null);
    }

    const dateOnly = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

    let modifiedAfterMs = null;
    if (modified_after != null && String(modified_after).trim() !== '') {
      const d = new Date(String(modified_after));
      if (Number.isNaN(d.getTime())) {
        return sendResponse(res, info, 400, false, 'Invalid modified_after', null);
      }
      modifiedAfterMs = d;
    }

    let sql = `
      SELECT e.user_event_id, e.project_id, e.user_id, u.user_name AS user_name, e.date,
             e.focus_time, e.start_time, e.end_time,
             e.event_type, e.tags, e.date_modified
      FROM ${TABLE} e
      LEFT JOIN admin.users u ON u.user_id = e.user_id
      WHERE e.project_id = $1`;
    const params = [project_id];
    let p = 2;

    const afterId =
      after_user_event_id !== undefined && after_user_event_id !== null && after_user_event_id !== ''
        ? parseInt(String(after_user_event_id), 10)
        : NaN;
    const useAfterId = Number.isFinite(afterId) && afterId >= 0 && modifiedAfterMs == null;

    if (modifiedAfterMs != null) {
      sql += ` AND e.date_modified > $${p}`;
      params.push(modifiedAfterMs);
      p += 1;
    } else if (useAfterId) {
      sql += ` AND e.user_event_id > $${p}`;
      params.push(afterId);
      p += 1;
    } else {
      if (date_from && dateOnly(date_from)) {
        sql += ` AND e.date_modified::date >= $${p}::date`;
        params.push(date_from);
        p += 1;
      }
      if (date_to && dateOnly(date_to)) {
        sql += ` AND e.date_modified::date <= $${p}::date`;
        params.push(date_to);
        p += 1;
      }
    }
    sql += ` ORDER BY COALESCE(e.date_modified, e.focus_time, e.start_time, e.date::timestamp) DESC NULLS LAST, e.user_event_id DESC`;

    const rows = await db.GetRows(sql, params);
    const countSql = `SELECT COUNT(*)::int AS c FROM ${TABLE} WHERE project_id = $1`;
    const countRows = await db.GetRows(countSql, [project_id]);
    const total = countRows[0]?.c != null ? Number(countRows[0].c) : 0;
    const data = { rows: rows.map(rowFromDb), total };
    return sendResponse(res, info, 200, true, `${data.rows.length} rows returned`, data, false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.createUserEvent = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/user_events', function: 'createUserEvent' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { project_id, date, focus_time, start_time, end_time, event_type } = req.body;
    const tags = normalizeTagsFromBody(req.body, event_type);
    // Project readers and contributors can add tags (same bar as viewing the project).
    const allowed = await check_permissions(req, 'read', project_id);
    if (!allowed) {
      return sendResponse(res, info, 403, false, 'Forbidden', null);
    }

    const userId = req.user?.user_id;
    if (!userId) {
      return sendResponse(res, info, 401, false, 'User context required', null);
    }

    const sql = `
      INSERT INTO ${TABLE} (project_id, user_id, date, focus_time, start_time, end_time, event_type, tags, date_modified)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING user_event_id, project_id, user_id, date,
                focus_time, start_time, end_time,
                event_type, tags, date_modified,
                (SELECT u.user_name FROM admin.users u WHERE u.user_id = user_id LIMIT 1) AS user_name`;
    const params = [
      project_id,
      userId,
      date ?? null,
      focus_time ?? null,
      start_time ?? null,
      end_time ?? null,
      event_type,
      tags,
    ];

    const rows = await db.GetRows(sql, params);
    const row = rows[0];
    if (!row) {
      return sendResponse(res, info, 500, false, 'Insert failed', null, true);
    }
    return sendResponse(res, info, 200, true, 'User event created', rowFromDb(row), false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.updateUserEvent = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/user_events', function: 'updateUserEvent' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_event_id = parseInt(req.params.user_event_id, 10);
    const { project_id, date, focus_time, start_time, end_time, event_type } = req.body;
    const tags = normalizeTagsFromBody(req.body, event_type);

    const allowed = await check_permissions(req, 'read', project_id);
    if (!allowed) {
      return sendResponse(res, info, 403, false, 'Forbidden', null);
    }

    const checkSql = `SELECT project_id FROM ${TABLE} WHERE user_event_id = $1`;
    const existing = await db.GetRows(checkSql, [user_event_id]);
    if (!existing.length || !sameProjectId(existing[0].project_id, project_id)) {
      return sendResponse(res, info, 404, false, 'Event not found', null);
    }

    const sql = `
      UPDATE ${TABLE}
      SET date = $1, focus_time = $2, start_time = $3, end_time = $4, event_type = $5, tags = $6, date_modified = NOW()
      WHERE user_event_id = $7 AND project_id = $8
      RETURNING user_event_id, project_id, user_id, date,
                focus_time, start_time, end_time,
                event_type, tags, date_modified,
                (SELECT u.user_name FROM admin.users u WHERE u.user_id = user_id LIMIT 1) AS user_name`;
    const params = [
      date ?? null,
      focus_time ?? null,
      start_time ?? null,
      end_time ?? null,
      event_type,
      tags,
      user_event_id,
      project_id,
    ];

    const rows = await db.GetRows(sql, params);
    const row = rows[0];
    if (!row) {
      return sendResponse(res, info, 500, false, 'Update failed', null, true);
    }
    return sendResponse(res, info, 200, true, 'User event updated', rowFromDb(row), false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.deleteUserEvent = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/user_events', function: 'deleteUserEvent' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const user_event_id = parseInt(req.params.user_event_id, 10);
    const project_id = req.query.project_id;

    const allowed = await check_permissions(req, 'read', project_id);
    if (!allowed) {
      return sendResponse(res, info, 403, false, 'Forbidden', null);
    }

    const checkSql = `SELECT project_id FROM ${TABLE} WHERE user_event_id = $1`;
    const existing = await db.GetRows(checkSql, [user_event_id]);
    if (!existing.length || !sameProjectId(existing[0].project_id, project_id)) {
      return sendResponse(res, info, 404, false, 'Event not found', null);
    }

    const delSql = `DELETE FROM ${TABLE} WHERE user_event_id = $1 AND project_id = $2`;
    const ok = await db.ExecuteCommand(delSql, [user_event_id, Number(project_id)]);
    if (!ok) {
      return sendResponse(res, info, 500, false, 'Delete failed', null, true);
    }
    return sendResponse(res, info, 200, true, 'User event deleted', { user_event_id }, false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
