const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse, getDatasetTimezone, formatDatetimeWithTimezone } = require('../middleware/helpers');

exports.getEvents = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/events', "function": 'getEvents'}

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
      
      const startTimeExpr = formatDatetimeWithTimezone('start_time', targetTimezone, '"start_time"');
      const endTimeExpr = formatDatetimeWithTimezone('end_time', targetTimezone, '"end_time"');
      
      const sql = `SELECT event_id, event_type, ${startTimeExpr}, ${endTimeExpr}, tags FROM ${class_name}.dataset_events WHERE dataset_id = $1 order by event_id desc`;
      const params = [dataset_id];

      let rows = await db.GetRows(sql, params);

      if (rows != null) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'Events not found' , null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getEventsInfo = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/events', "function": 'getEventsInfo'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, event_type, timezone } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Get timezone: use provided timezone, or fetch dataset timezone, or default to UTC
      let targetTimezone = timezone;
      if (!targetTimezone) {
        targetTimezone = await getDatasetTimezone(class_name, dataset_id, db);
      }
      
      const startTimeExpr = formatDatetimeWithTimezone('start_time', targetTimezone, '"start_time"');
      const endTimeExpr = formatDatetimeWithTimezone('end_time', targetTimezone, '"end_time"');
      const params = [dataset_id, event_type];

      let sql;
      if (event_type && String(event_type).toUpperCase() === 'RACE') {
        // Include race_stats Duration_sec and Cumulative_sec so consumers can rank position by stored race total
        const startTimeExprB = formatDatetimeWithTimezone('b.start_time', targetTimezone, '"start_time"');
        const endTimeExprB = formatDatetimeWithTimezone('b.end_time', targetTimezone, '"end_time"');
        sql = `SELECT b.event_id, b.event_type, ${startTimeExprB}, ${endTimeExprB}, b.tags, a."Duration_sec" AS duration_sec, a."Cumulative_sec" AS cumulative_sec FROM ${class_name}.dataset_events b LEFT JOIN ${class_name}.race_stats a ON a.event_id = b.event_id WHERE b.dataset_id = $1 AND LOWER(b.event_type) = LOWER($2) ORDER BY b.start_time`;
      } else {
        sql = `SELECT event_id, event_type, ${startTimeExpr}, ${endTimeExpr}, tags FROM ${class_name}.dataset_events WHERE dataset_id = $1 AND LOWER(event_type) = LOWER($2) ORDER BY start_time`;
      }

      // Debug: Log the generated SQL to verify timezone conversion
      console.log('[getEventsInfo] Timezone:', targetTimezone, 'SQL datetime expressions:', { startTimeExpr, endTimeExpr });
      console.log('[getEventsInfo] Generated SQL:', sql);

      let rows = await db.GetRows(sql, params);

      if (rows != null) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'Events not found' , null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getEventTimes = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/events', "function": 'getEventTimes'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    // Support both GET (query) and POST (body) parameters
    const params = req.method === 'POST' ? req.body : req.query;
    const { class_name, project_id, dataset_id, source_id, date, event_list, timezone } = params;

    // Validate that either dataset_id OR (source_id and date) is provided
    if (!dataset_id && (!source_id || !date)) {
      return sendResponse(res, info, 400, false, 'Either dataset_id OR (source_id and date) must be provided', null);
    }

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Resolve dataset_id: use provided dataset_id, or look it up from source_id and date
      let resolvedDatasetId = dataset_id;
      
      if (!resolvedDatasetId && source_id && date) {
        // Normalize date format (remove dashes/slashes to match database format)
        const normalizedDate = String(date).replace(/[-/]/g, '');
        
        const lookupSql = `SELECT dataset_id FROM ${class_name}.datasets 
                          WHERE source_id = $1 AND date = $2 
                          ORDER BY dataset_id DESC LIMIT 1`;
        const lookupParams = [source_id, normalizedDate];
        
        const lookupRows = await db.GetRows(lookupSql, lookupParams);
        
        if (!lookupRows || lookupRows.length === 0) {
          return sendResponse(res, info, 404, false, `No dataset found for source_id=${source_id} and date=${date}`, null);
        }
        
        resolvedDatasetId = lookupRows[0].dataset_id;
      }
      
      if (!resolvedDatasetId) {
        return sendResponse(res, info, 400, false, 'Either dataset_id OR (source_id and date) must be provided', null);
      }

      // Get timezone: use provided timezone, or fetch dataset timezone, or default to UTC
      let targetTimezone = timezone;
      if (!targetTimezone) {
        targetTimezone = await getDatasetTimezone(class_name, resolvedDatasetId, db);
      }
      
      const startTimeExpr = formatDatetimeWithTimezone('start_time', targetTimezone, '"start_time"');
      const endTimeExpr = formatDatetimeWithTimezone('end_time', targetTimezone, '"end_time"');
      
      // Parse event_list properly
      const eventIds = JSON.parse(event_list);
      
      // Create parameterized placeholders for each event ID
      const placeholders = eventIds.map((_, index) => `$${index + 2}`).join(',');
      
      const sql = `SELECT event_id, ${startTimeExpr}, ${endTimeExpr} 
                   FROM ${class_name}.dataset_events 
                   WHERE dataset_id = $1 
                   AND event_id IN (${placeholders})`;
                   
      // Create params array with dataset_id followed by all event IDs
      const params = [resolvedDatasetId, ...eventIds];

      let rows = await db.GetRows(sql, params);

      if (rows != null) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'Events not found' , null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getEventObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/events', "function": 'getEventObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, datasetId, table, desc } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT json "value" FROM ${class_name}.${table} a inner join ${class_name}.dataset_events b on a.event_id = b.event_id WHERE b.dataset_id = $1 AND LOWER(a.description) = LOWER($2) order by a.event_id desc limit 1`;
      const params = [datasetId, desc];

      let value = await db.GetValue(sql, params);
      if (value != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'Event object not found', null);
      }
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null);
  }
};

/**
 * Get the min start_time and max end_time for DATASET events across multiple datasets
 * Used for fleet timeseries to limit x-scale to the actual dataset event ranges
 */
exports.getDatasetEventTimeRange = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/events', "function": 'getDatasetEventTimeRange'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_ids, timezone } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Parse dataset_ids - can be JSON array or comma-separated string
      let datasetIds = [];
      try {
        if (dataset_ids) {
          // Try parsing as JSON first
          const parsed = JSON.parse(dataset_ids);
          datasetIds = Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch (e) {
        // If JSON parse fails, try comma-separated string
        if (typeof dataset_ids === 'string') {
          datasetIds = dataset_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);
        }
      }

      if (datasetIds.length === 0) {
        return sendResponse(res, info, 400, false, 'dataset_ids must be provided as a JSON array or comma-separated list', null);
      }

      // Get timezone: use provided timezone, or fetch dataset timezone from first dataset, or default to UTC
      let targetTimezone = timezone;
      if (!targetTimezone && datasetIds.length > 0) {
        targetTimezone = await getDatasetTimezone(class_name, datasetIds[0], db);
      }
      
      // Use expressions without alias so MIN/MAX get a single scalar (alias inside aggregate is invalid in PostgreSQL)
      const startTimeExpr = formatDatetimeWithTimezone('start_time', targetTimezone, null);
      const endTimeExpr = formatDatetimeWithTimezone('end_time', targetTimezone, null);

      // Create parameterized placeholders for each dataset_id
      const placeholders = datasetIds.map((_, index) => `$${index + 1}`).join(',');

      // Query to get min start_time and max end_time for DATASET events across all provided datasets
      const sql = `SELECT 
                    MIN(${startTimeExpr}) AS start_time,
                    MAX(${endTimeExpr}) AS end_time
                   FROM ${class_name}.dataset_events 
                   WHERE dataset_id IN (${placeholders})
                     AND LOWER(event_type) = 'dataset'`;
      
      const params = datasetIds;

      let rows = await db.GetRows(sql, params);

      if (rows != null && rows.length > 0 && rows[0].start_time && rows[0].end_time) {
        return sendResponse(res, info, 200, true, "Time range returned", {
          start_time: rows[0].start_time,
          end_time: rows[0].end_time
        }, false);
      } else {
        return sendResponse(res, info, 204, false, 'No DATASET events found for the provided datasets', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * Get average Loss_total_tgt from maneuver_stats by maneuver type (TACK, GYBE, ROUNDUP, BEARAWAY),
 * filtered by Race_number, Leg_number (optional), and GRADE > 1.
 * Returns race-level and/or leg-level aggregates for merging into race_stats.
 */
exports.getManeuverLossAverages = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/events', "function": 'getManeuverLossAverages'};

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_ids, scope } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    // Parse dataset_ids - comma-separated or JSON array
    let datasetIds = [];
    try {
      if (dataset_ids) {
        const parsed = JSON.parse(dataset_ids);
        datasetIds = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (e) {
      if (typeof dataset_ids === 'string') {
        datasetIds = dataset_ids.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id) && id > 0);
      }
    }
    if (datasetIds.length === 0) {
      return sendResponse(res, info, 400, false, 'dataset_ids must be a non-empty list of dataset IDs', null);
    }

    const scopeVal = (scope || 'both').toLowerCase();
    const runRace = scopeVal === 'race' || scopeVal === 'both';
    const runLeg = scopeVal === 'leg' || scopeVal === 'both';

    const baseWhere = `e.dataset_id = ANY($1)
  AND e.event_type IN ('TACK','GYBE','ROUNDUP','BEARAWAY')
  AND (e.tags->>'GRADE') IS NOT NULL AND (e.tags->>'GRADE') ~ '^[0-9]+$' AND (e.tags->>'GRADE')::int > 1
  AND (e.tags -> 'RACES' ->> 'Race_number') IS NOT NULL AND (e.tags -> 'RACES' ->> 'Race_number') ~ '^[0-9]+$'`;

    let raceRows = [];
    let legRows = [];

    if (runRace) {
      const raceSql = `SELECT e.dataset_id,
  (e.tags -> 'RACES' ->> 'Race_number')::int AS race_number,
  NULL::int AS leg_number,
  AVG(CASE WHEN e.event_type = 'TACK' THEN m."Loss_total_tgt" END) AS tack_loss_avg,
  AVG(CASE WHEN e.event_type = 'GYBE' THEN m."Loss_total_tgt" END) AS gybe_loss_avg,
  AVG(CASE WHEN e.event_type = 'ROUNDUP' THEN m."Loss_total_tgt" END) AS roundup_loss_avg,
  AVG(CASE WHEN e.event_type = 'BEARAWAY' THEN m."Loss_total_tgt" END) AS bearaway_loss_avg
FROM ${class_name}.dataset_events e
INNER JOIN ${class_name}.maneuver_stats m ON e.event_id = m.event_id
WHERE ${baseWhere}
GROUP BY e.dataset_id, (e.tags -> 'RACES' ->> 'Race_number')`;
      raceRows = await db.GetRows(raceSql, [datasetIds]);
      if (!Array.isArray(raceRows)) raceRows = [];
    }

    if (runLeg) {
      const legSql = `SELECT e.dataset_id,
  (e.tags -> 'RACES' ->> 'Race_number')::int AS race_number,
  (e.tags -> 'RACES' ->> 'Leg_number')::int AS leg_number,
  AVG(CASE WHEN e.event_type = 'TACK' THEN m."Loss_total_tgt" END) AS tack_loss_avg,
  AVG(CASE WHEN e.event_type = 'GYBE' THEN m."Loss_total_tgt" END) AS gybe_loss_avg,
  AVG(CASE WHEN e.event_type = 'ROUNDUP' THEN m."Loss_total_tgt" END) AS roundup_loss_avg,
  AVG(CASE WHEN e.event_type = 'BEARAWAY' THEN m."Loss_total_tgt" END) AS bearaway_loss_avg
FROM ${class_name}.dataset_events e
INNER JOIN ${class_name}.maneuver_stats m ON e.event_id = m.event_id
WHERE ${baseWhere}
  AND (e.tags -> 'RACES' ->> 'Leg_number') IS NOT NULL AND (e.tags -> 'RACES' ->> 'Leg_number') ~ '^[0-9]+$'
GROUP BY e.dataset_id, (e.tags -> 'RACES' ->> 'Race_number'), (e.tags -> 'RACES' ->> 'Leg_number')`;
      legRows = await db.GetRows(legSql, [datasetIds]);
      if (!Array.isArray(legRows)) legRows = [];
    }

    return sendResponse(res, info, 200, true, 'Maneuver loss averages', { race: raceRows, leg: legRows }, false);
  } catch (err) {
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};