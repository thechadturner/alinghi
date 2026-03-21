const { validationResult } = require('express-validator');
const db = require("../middleware/db");
const { sendResponse } = require('../middleware/helpers');
const { check_permissions } = require('../middleware/auth_jwt');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const execAsync = promisify(exec);

/** Allowed class names (schema) for grade-by-vmg updates to avoid SQL injection */
const ALLOWED_CLASS_NAMES = ['gp50'];

// Clear all logs
exports.clearLogs = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/admin', "function": 'clearLogs'}

  try {
    const user_id = req.user.user_id
    
    if (user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    // Call the database function to truncate logs
    const sql = `SELECT admin.truncate_logs()`;
    const success = await db.ExecuteCommand(sql, []);

    if (success) {
      return sendResponse(res, info, 200, true, 'Logs cleared successfully', null, false);
    } else {
      return sendResponse(res, info, 500, false, 'Failed to clear logs', null, true);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, true);
  }
};

// Truncate datasets cascade
exports.truncateDatasetsCascade = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/admin', "function": 'truncateDatasetsCascade'}

  try {
    const user_id = req.user.user_id
    
    // Check if user is super user
    if (user_id != db.GetSuperUser()) {
      return sendResponse(res, info, 403, false, 'Super user access required', null);
    }

    // Get the script path (relative to project root)
    // __dirname is server_admin/controllers, so go up two levels to project root
    const projectRoot = path.resolve(__dirname, '../../');
    const scriptPath = path.resolve(projectRoot, 'scripts', 'truncate_datasets_cascade.js');

    // Verify the script file exists
    if (!fs.existsSync(scriptPath)) {
      return sendResponse(res, info, 500, false, `Script not found at: ${scriptPath}`, {
        projectRoot: projectRoot,
        scriptPath: scriptPath,
        __dirname: __dirname
      }, true);
    }

    // Execute the script
    const { stdout, stderr } = await execAsync(`node "${scriptPath}"`, {
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
    });

    // Combine stdout and stderr for response
    const output = stdout + (stderr ? '\n' + stderr : '');

    return sendResponse(res, info, 200, true, 'Datasets truncated successfully', {
      output: output
    }, false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, {
      output: error.stdout || error.stderr || error.message
    }, true);
  }
};

/**
 * Update dataset_events.tags GRADE by VMG percent from events_aggregate.
 * API requires: API key (Bearer token) and class_name in the request; SQL is scoped by project and date.
 * POST body: { class_name, project_id, date } (date as YYYYMMDD).
 */
exports.gradeByVmg = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/admin', "function": 'gradeByVmg' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, false);
  }

  try {
    const { class_name, project_id, date } = req.body || {};

    if (!class_name || typeof class_name !== 'string') {
      return sendResponse(res, info, 400, false, 'class_name is required', null, false);
    }
    const cn = String(class_name).trim();
    if (!ALLOWED_CLASS_NAMES.includes(cn)) {
      return sendResponse(res, info, 400, false, `class_name must be one of: ${ALLOWED_CLASS_NAMES.join(', ')}`, null, false);
    }
    if (project_id == null || project_id === '') {
      return sendResponse(res, info, 400, false, 'project_id is required', null, false);
    }
    const pid = parseInt(project_id, 10);
    if (Number.isNaN(pid)) {
      return sendResponse(res, info, 400, false, 'project_id must be an integer', null, false);
    }
    if (!date || typeof date !== 'string' || String(date).trim().length < 8) {
      return sendResponse(res, info, 400, false, 'date is required (YYYYMMDD)', null, false);
    }
    const dateStr = String(date).trim().replace(/[-/]/g, '').slice(0, 8);
    if (dateStr.length !== 8) {
      return sendResponse(res, info, 400, false, 'date must be YYYYMMDD', null, false);
    }

    const hasPermission = await check_permissions(req, 'write', pid);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null, true);
    }

    // SQL scope: project ($1) and date ($2) limit updates to datasets for that project and day
    const datasetScope = `
      AND de.dataset_id IN (
        SELECT d.dataset_id FROM ${cn}.datasets d
        JOIN ${cn}.sources s ON d.source_id = s.source_id
        WHERE s.project_id = $1 AND d.date = TO_DATE($2, 'YYYYMMDD')
      )`;
    const params = [pid, dateStr];

    const updates = [
      {
        sql: `UPDATE ${cn}.dataset_events de SET tags = jsonb_set(COALESCE(de.tags, '{}'::jsonb), '{GRADE}', '0'::jsonb, true)
              WHERE de.event_id IN (SELECT a.event_id FROM ${cn}.events_aggregate a WHERE a."Vmg_perc" > 140 AND a.agr_type = 'AVG') ${datasetScope}`,
        grade: '0'
      },
      {
        sql: `UPDATE ${cn}.dataset_events de SET tags = jsonb_set(COALESCE(de.tags, '{}'::jsonb), '{GRADE}', '3'::jsonb, true)
              WHERE de.event_id IN (SELECT a.event_id FROM ${cn}.events_aggregate a WHERE a."Vmg_perc" > 100 AND a."Vmg_perc" < 120 AND a.agr_type = 'AVG') ${datasetScope}`,
        grade: '3'
      },
      {
        sql: `UPDATE ${cn}.dataset_events de SET tags = jsonb_set(COALESCE(de.tags, '{}'::jsonb), '{GRADE}', '1'::jsonb, true)
              WHERE de.event_id IN (SELECT a.event_id FROM ${cn}.events_aggregate a WHERE a."Vmg_perc" < 50 AND a.agr_type = 'AVG') ${datasetScope}`,
        grade: '1'
      }
    ];

    const results = [];
    for (const u of updates) {
      const result = await db.ExecuteCommandWithError(u.sql, params);
      if (!result.success) {
        return sendResponse(res, info, 500, false, `Grade-by-VMG update failed (GRADE=${u.grade}): ${result.error}`, { grade: u.grade, error: result.error }, true);
      }
      results.push({ grade: u.grade, success: true });
    }

    return sendResponse(res, info, 200, true, 'Grade-by-VMG updates applied', { updates: results }, false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

