const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');
const { error: logError, log } = require('../../shared');

// Retrieve Races for a given date
exports.getRaces = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getRaces'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [project_id, date];

      // Query mapdata instead of events to get all actual race numbers in the data
      // Include race_number = -1 (Training races) by changing filter to >= -1
      // Handle 'TRAINING' string values (stored as TEXT in map.data) by converting to -1
      let sql = `SELECT "Race_number" from (
        SELECT 
          CASE 
            WHEN UPPER(TRIM(a.tags ->> 'Race_number')) = 'TRAINING' THEN -1
            WHEN a.tags ->> 'Race_number' IS NOT NULL AND a.tags ->> 'Race_number' != '' THEN 
              CASE 
                WHEN (a.tags ->> 'Race_number')::text ~ '^-?[0-9]+$' THEN
                  CASE 
                    WHEN CAST(a.tags ->> 'Race_number' AS FLOAT) = -1 THEN -1
                    ELSE CAST(CAST(a.tags ->> 'Race_number' AS FLOAT) AS INT)
                  END
                ELSE NULL
              END
            ELSE NULL
          END AS "Race_number"
        FROM ${class_name}.dataset_events a
        INNER JOIN ${class_name}.datasets b on a.dataset_id = b.dataset_id
        INNER JOIN ${class_name}.sources c on b.source_id = c.source_id
        WHERE c.project_id = $1 AND b.date = $2
          AND (a.tags ->> 'Race_number' IS NOT NULL AND a.tags ->> 'Race_number' != '')
        ) 
        WHERE "Race_number" IS NOT NULL AND "Race_number" >= -1
        GROUP BY "Race_number"
        ORDER BY "Race_number" ASC`

      let rows = await db.GetRows(sql, params);

      const hasPositiveRace = Array.isArray(rows) && rows.some((r) => {
        const n = r.Race_number;
        return n != null && Number(n) > 0;
      });
      if (hasPositiveRace) {
        return sendResponse(res, info, 200, true, rows.length + ' rows returned...', rows, false);
      }

      const hoursSql = `
        SELECT "HOUR" FROM (
          SELECT DISTINCT (a.tags ->> 'HOUR') AS "HOUR"
          FROM ${class_name}.dataset_events a
          INNER JOIN ${class_name}.datasets b ON a.dataset_id = b.dataset_id
          INNER JOIN ${class_name}.sources c ON b.source_id = c.source_id
          WHERE c.project_id = $1 AND b.date = $2
            AND LOWER(a.event_type) = 'training'
            AND a.tags ->> 'HOUR' IS NOT NULL AND a.tags ->> 'HOUR' != ''
        ) sub
        ORDER BY CASE WHEN "HOUR" ~ '^[0-9]+$' THEN "HOUR"::int ELSE 999 END, "HOUR"`;
      const hourRows = await db.GetRows(hoursSql, params);
      if (hourRows && hourRows.length > 0) {
        const trainingRows = hourRows.map((r) => ({ Race_number: r.HOUR, HOUR: r.HOUR }));
        return sendResponse(res, info, 200, true, trainingRows.length + ' training hours returned...', trainingRows, false);
      }

      if (rows && rows.length > 0) {
        return sendResponse(res, info, 200, true, rows.length + ' rows returned...', rows, false);
      }
      return sendResponse(res, info, 204, false, 'No races found', null);
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve Dataset_ids for a given date
exports.getDatasetIds = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetIds'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [project_id, date];
      let sql = `SELECT a.dataset_id, b.source_id, b.source_name FROM ${class_name}.datasets a
        INNER JOIN ${class_name}.sources b on a.source_id = b.source_id
        WHERE b.project_id = $1 and a.date = $2
        GROUP BY a.dataset_id, b.source_id, b.source_name`

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No races found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve datasets for a date with each DATASET event's start_time, end_time, and duration (from dataset_events.duration).
// Used by Events page date mode to pick the longest-duration dataset as primary.
exports.getDateDatasetsWithDuration = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDateDatasetsWithDuration'};

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date } = req.query;

    const result = await check_permissions(req, 'read', project_id);
    if (!result) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const params = [project_id, date];
    const sql = `SELECT a.dataset_id, b.source_id, b.source_name,
        e.start_time, e.end_time, e.duration
      FROM ${class_name}.datasets a
      INNER JOIN ${class_name}.sources b ON a.source_id = b.source_id
      LEFT JOIN ${class_name}.dataset_events e ON e.dataset_id = a.dataset_id AND e.event_type = 'DATASET'
      WHERE b.project_id = $1 AND a.date = $2
      ORDER BY ABS(COALESCE(e.duration, 0)) DESC NULLS LAST`;

    const rows = await db.GetRows(sql, params) || [];
    return sendResponse(res, info, 200, true, rows.length + ' rows returned...', rows, false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve timezone for a given date
exports.getDateTimezone = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDateTimezone'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [project_id, date];
      // Get timezone and dataset_id from the first dataset for this date/project
      // All datasets for the same date/project should have the same timezone
      let sql = `SELECT a.dataset_id, a.timezone 
        FROM ${class_name}.datasets a
        INNER JOIN ${class_name}.sources b on a.source_id = b.source_id
        WHERE b.project_id = $1 and a.date = $2 and a.timezone IS NOT NULL and a.timezone != ''
        LIMIT 1`

      let rows = await db.GetRows(sql, params);

      if (rows && rows.length > 0 && rows[0].timezone) {
        const row = rows[0];
        return sendResponse(res, info, 200, true, "Timezone found", { 
          timezone: row.timezone.trim(),
          dataset_id: row.dataset_id
        }, false);
      } else {
        return sendResponse(res, info, 204, false, 'No timezone found for this date', { timezone: null, dataset_id: null }, false);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve Day
exports.getDatasetDay = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetDay'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, event_name} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [source_id, event_name];
      let sql = `SELECT COUNT(dataset_id) "value" FROM ${class_name}.datasets WHERE source_id = $1 AND event_name = $2`

      let value = await db.GetValue(sql, params);

      if (value) {
        return sendResponse(res, info, 200, true, value+" returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'No years found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve last Date
exports.getLastDatasetDate = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getLastDatasetDate'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [];
      let sql = ""

      if (source_id > 0) {
        params = [ source_id, project_id ];
        sql = `SELECT date "value" FROM  ${class_name}.datasets a 
          INNER JOIN ${class_name}.sources b on a.source_id = b.source_id 
          WHERE b.source_id = $1 AND b.project_id = $2 ORDER BY date DESC LIMIT 1`
      } else {
        params = [ project_id ];
        sql = `SELECT date "value" FROM  ${class_name}.datasets a 
          INNER JOIN ${class_name}.sources b on a.source_id = b.source_id 
          WHERE b.project_id = $1 ORDER BY date DESC LIMIT 1`
      }

      let value = await db.GetValue(sql, params);

      if (value) {
        return sendResponse(res, info, 200, true, value+" returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'No years found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve Dataset Description
exports.getDatasetDesc = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetDesc'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [dataset_id];
      let sql = `SELECT races from (
        SELECT tags -> 'Race_number' "races" FROM ${class_name}.dataset_events where dataset_id = $1 and event_type = 'RACE'
        ) group by races order by races`

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No years found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve dataset years
exports.getDatasetYears = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetYears'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [source_id];
      let sql = `SELECT year_name FROM ${class_name}.datasets where source_id = $1 group by year_name order by year_name`;
      
      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No years found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Retrieve dataset events
exports.getDatasetEvents = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetEvents'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, year_name} = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let sql = ``
      let params = [];
       
      // Validator enforces integer; treat 1970 as sentinel for ALL years
      if (source_id == 0) {
        params = [project_id];
        sql = `SELECT a.event_name FROM ${class_name}.datasets a
        INNER JOIN ${class_name}.sources b on a.source_id = b.source_id
        WHERE b.project_id = $1 GROUP BY a.event_name ORDER BY MIN(a.date) ASC`;
      } else if (year_name === 'ALL') {
        params = [source_id];
        sql = `SELECT event_name FROM ${class_name}.datasets WHERE source_id = $1 GROUP BY event_name ORDER BY MIN(date) ASC`;
      } else {
        params = [source_id, year_name];
        sql = `SELECT event_name FROM ${class_name}.datasets WHERE source_id = $1 AND year_name = $2 GROUP BY event_name ORDER BY MIN(date) ASC`;
      }

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, "No events found", null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Retrieve dataset info
exports.getDatasetInfo = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetInfo'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT CAST(date as TEXT) "date", source_name, TO_CHAR(a.date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets a inner join ${class_name}.sources b on a.source_id = b.source_id WHERE dataset_id = $1 limit 1`;
      const params = [dataset_id];
      
      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" row returned...", rows[0]);
      } else {
        return sendResponse(res, info, 204, false, 'Dataset not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve dataset tags
exports.getDatasetTags = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetTags'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT tags "value" FROM ${class_name}.datasets WHERE dataset_id = $1`;
      const params = [dataset_id];
      
      let tags = await db.GetValue(sql, params);

      if (tags != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", tags, false);
      } else {
        return sendResponse(res, info, 204, false, 'Dataset tags not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Retrieve dataset by ID
exports.getDatasetCount = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetCount'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT count(dataset_id) "value" FROM ${class_name}.datasets a inner join ${class_name}.sources b on a.source_id = b.source_id where b.project_id = $1`;
      const params = [project_id];
      
      let value = await db.GetValue(sql, params);

      if (value != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'Datasets not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Retrieve dataset by ID
exports.getDataset = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDataset'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT source_name, cast(date as TEXT) "date", event_name, report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", shared, TO_CHAR(a.date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets a inner join ${class_name}.sources b on a.source_id = b.source_id WHERE dataset_id = $1 limit 1`;
      const params = [dataset_id];
      
      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, "1 row returned...", rows[0], false);
      } else {
        return sendResponse(res, info, 204, false, 'Datasets not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Retrieve datasets
exports.getDatasets = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasets'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, year_name, event_name } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [];
      let sql = ``;

      let result = await check_permissions(req, 'write', project_id)

      if (result) {
        if (year_name === 'ALL') {
          if (event_name != undefined & event_name != 'ALL') {
            params = [source_id, event_name];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, visible, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and event_name = $2 order by date desc`;
          } else {
            params = [source_id];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, visible, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 order by date desc`;
          }
        } else {
          if (event_name != undefined & event_name != 'ALL') {
            params = [source_id, year_name, event_name];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, visible, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and year_name = $2 and event_name = $3 order by date desc`;
          } else {
            params = [source_id, year_name];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, visible, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and year_name = $2 order by date desc`;
          }
        }
      } else {
        if (year_name === 'ALL') {
          if (event_name != undefined & event_name != 'ALL') {
            params = [source_id, event_name];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and event_name = $2 and visible = 1 order by date desc`;
          } else {
            params = [source_id];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and visible = 1 order by date desc`;
          }
        } else {
          if (event_name != undefined & event_name != 'ALL') {
            params = [source_id, year_name, event_name];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and year_name = $2 and event_name = $3 and visible = 1 order by date desc`;
          } else {
            params = [source_id, year_name];
            sql = `SELECT dataset_id, cast(date as text) "date", report_name, description, timezone, tags -> 'Weather' ->> 'TWS' "tws", tags -> 'Weather' ->> 'TWD' "twd", event_name, TO_CHAR(date_modified, 'YYYY-MM-DD HH24:MI:SS') AS date_modified FROM ${class_name}.datasets where source_id = $1 and year_name = $2 and visible = 1 order by date desc`;
          }
        }
      }

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'Datasets not found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve datasets
exports.getFleetDatasets = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getFleetDatasets'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, year_name, event_name } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params = [];
      let sql = ``;

      let result = await check_permissions(req, 'write', project_id)

      if (result) {
        if (year_name === 'ALL') {
          if (event_name != undefined & event_name != 'ALL') {
            params = [event_name];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets WHERE event_name = $1 order by date desc`;
          } else {
            params = [];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets order by date desc`;
          }
        } else {
          if (event_name != undefined & event_name != 'ALL') {
            params = [year_name, event_name];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets WHERE year_name = $1 and event_name = $2 order by date desc`;
          } else {
            params = [year_name];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets WHERE year_name = $1 order by date desc`;
          }
        }
      } else {
        // Fleet datasets - no visible filter as fleet_datasets table doesn't have this column
        if (year_name === 'ALL') {
          if (event_name != undefined & event_name != 'ALL') {
            params = [event_name];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets WHERE event_name = $1 order by date desc`;
          } else {
            params = [];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets order by date desc`;
          }
        } else {
          if (event_name != undefined & event_name != 'ALL') {
            params = [year_name, event_name];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets WHERE year_name = $1 and event_name = $2 order by date desc`;
          } else {
            params = [year_name];
            sql = `SELECT CAST(date as TEXT) "date", report_name, year_name, event_name, sources FROM ${class_name}.fleet_datasets WHERE year_name = $1 order by date desc`;
          }
        }
      }

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
      } else {
        console.log(sql, params);
        return sendResponse(res, info, 204, false, 'Datasets not found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve dataset object
exports.getDatasetObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getDatasetObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, parent_name, object_name } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT json "value" FROM ${class_name}.dataset_objects where dataset_id = $1 and parent_name = $2 and object_name = $3 order by date_modified desc limit 1`;
      const params = [dataset_id, parent_name,object_name];
      
      let value = await db.GetValue(sql, params);

      if (value != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'Dataset object not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
}
  
// Add a new dataset
exports.addDataset = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'addDataset'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, date, year_name, event_name, report_name, description, timezone, tags } = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      let params = [source_id, date];
      let sql = `SELECT dataset_id "value" from ${class_name}.datasets WHERE source_id = $1 and date = $2 order by dataset_id desc limit 1`;
      
      let dataset_id = await db.GetValue(sql, params);
  
      if (dataset_id == null) {
        // Include timezone if provided, otherwise use NULL (database default)
        if (timezone) {
          sql = `INSERT INTO ${class_name}.datasets (source_id, date, year_name, event_name, report_name, description, timezone, tags) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING dataset_id`;
          params = [source_id, date, year_name, event_name, report_name, description, timezone, tags];
        } else {
          sql = `INSERT INTO ${class_name}.datasets (source_id, date, year_name, event_name, report_name, description, tags) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING dataset_id`;
          params = [source_id, date, year_name, event_name, report_name, description, tags];
        }

        // Use GetRows with RETURNING to capture both the result and any database errors
        try {
          const insertResult = await db.GetRows(sql, params);
          
          if (insertResult && insertResult.length > 0 && insertResult[0].dataset_id) {
            dataset_id = insertResult[0].dataset_id;
            return sendResponse(res, info, 201, true, "Dataset added successfully", dataset_id);
          } else {
            // Fallback to querying for the dataset_id if RETURNING didn't work
            sql = `SELECT dataset_id "value" from ${class_name}.datasets order by dataset_id desc limit 1`;
            params = [];
            dataset_id = await db.GetValue(sql, params);
            
            if (dataset_id != null) {
              return sendResponse(res, info, 201, true, "Dataset added successfully", dataset_id);
            } else {
              return sendResponse(res, info, 500, false, 'Failed to add dataset: Could not retrieve created dataset_id', null, true);
            }
          }
        } catch (dbError) {
          // Capture and return the actual database error
          logError('Database error in addDataset:', dbError);
          const errorMessage = dbError.message || 'Database error during insert';
          return sendResponse(res, info, 500, false, `Failed to add dataset: ${errorMessage}`, null, true);
        }
      } else {
        return sendResponse(res, info, 200, true, "Dataset found!", dataset_id, false);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Add a new dataset target
exports.addDatasetTarget = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'addDatasetTarget'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, target_id, tack } = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      let params = [dataset_id];
      let sql = `SELECT target_id "value" from ${class_name}.dataset_targets WHERE dataset_id = $1 limit 1`;
      let target_value = await db.GetValue(sql, params);

      if (target_value == null) {
        sql = `INSERT INTO ${class_name}.dataset_targets (dataset_id, target_id, tack) VALUES ($1, $2, $3)`;
        params = [dataset_id, target_id, tack];

        result = await db.ExecuteCommand(sql, params);
    
        if (result) {
          return sendResponse(res, info, 200, true, "Target added!", null, false);
        } else {
          return sendResponse(res, info, 500, false, 'Failed to add dataset', null);
        }
      } else {
        params = [dataset_id, tack];
        sql = `SELECT target_id "value" from ${class_name}.dataset_targets WHERE dataset_id = $1 and tack = $2 limit 1`;
        let tack_value = await db.GetValue(sql, params);

        if (tack_value == null) {
          if (tack == 'BOTH') {
            sql = `DELETE FROM ${class_name}.dataset_targets where dataset_id = $1 and target_id = $2`;
            params = [dataset_id, target_id];

            result = await db.ExecuteCommand(sql, params);
        
            if (result) {
              sql = `INSERT INTO ${class_name}.dataset_targets (dataset_id, target_id, tack) VALUES ($1, $2, $3)`;
              params = [dataset_id, target_id, tack];
      
              result = await db.ExecuteCommand(sql, params);
          
              if (result) {
                return sendResponse(res, info, 200, true, "Target added!", null, false);
              } else {
                return sendResponse(res, info, 500, false, 'Failed to add dataset', null);
              }
            }
          } else {
            sql = `INSERT INTO ${class_name}.dataset_targets (dataset_id, target_id, tack) VALUES ($1, $2, $3)`;
            params = [dataset_id, target_id, tack];
    
            result = await db.ExecuteCommand(sql, params);
        
            if (result) {
              return sendResponse(res, info, 200, true, "Target added!", null, false);
            } else {
              return sendResponse(res, info, 500, false, 'Failed to add dataset', null);
            }
          }
        }
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Update dataset
exports.updateDataset = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'updateDataset'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, event_name, report_name, description, timezone, tws, twd, shared } = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      const params = [dataset_id, event_name, report_name, description, timezone, tws, twd, shared];
      const sql = `UPDATE ${class_name}.datasets 
          SET event_name = $2, report_name = $3, description = $4, timezone = $5, 
          tags = jsonb_set(jsonb_set(COALESCE(tags, '{}'),'{Weather,TWS}',$6::jsonb,true),'{Weather,TWD}',$7::jsonb,true),
          shared = $8, date_modified = CURRENT_TIMESTAMP
          WHERE dataset_id = $1`;

      result = await db.ExecuteCommand(sql, params);

      if (result) {
        return sendResponse(res, info, 200, true, "Dataset updated successfully", null, false);
      } else {
        return sendResponse(res, info, 500, false, 'Failed to update dataset', null, true);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Update dataset tags
exports.updateDatasetTags = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'updateDatasetTags'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, tags } = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      const params = [dataset_id, tags];
      const sql = `UPDATE ${class_name}.datasets SET tags = $2::jsonb, date_modified = CURRENT_TIMESTAMP WHERE dataset_id = $1`;

      result = await db.ExecuteCommand(sql, params);

      if (result) {
        return sendResponse(res, info, 200, true, "Dataset updated successfully", null, false);
      } else {
        return sendResponse(res, info, 500, false, 'Failed to update dataset', null, true);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Populate channels for dates (called after upload dataset process completes)
exports.populateChannelsForDates = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'populateChannelsForDates'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logError('[populateChannelsForDates] Validation errors:', errors.array());
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dates, force_refresh } = req.body; // dates is array of {date, source_id} objects

    log(`[populateChannelsForDates] Called with class_name=${class_name}, project_id=${project_id}, dates count=${dates?.length || 0}, force_refresh=${force_refresh || false}`);

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      // Only populate for gp50 class
      if (class_name !== 'gp50') {
        log(`[populateChannelsForDates] Skipping - class_name is ${class_name}, not gp50`);
        return sendResponse(res, info, 200, true, "Channel population only supported for gp50 class", null);
      }

      if (!Array.isArray(dates) || dates.length === 0) {
        logError('[populateChannelsForDates] dates array is empty or not an array:', dates);
        return sendResponse(res, info, 400, false, "dates array is required and must not be empty", null);
      }

      const { populateChannelsForDate } = require('../middleware/channels');
      const results = [];
      const errors = [];

      // Process each unique date (only populate once per date)
      const processedDates = new Set();
      
      log(`[populateChannelsForDates] Processing ${dates.length} date entries`);
      
      for (const dateInfo of dates) {
        const { date, source_id } = dateInfo;
        
        if (!date || !source_id) {
          logError(`[populateChannelsForDates] Missing date or source_id in entry:`, dateInfo);
          errors.push({ date: date || 'missing', source_id: source_id || 'missing', error: 'Missing date or source_id' });
          continue;
        }
        
        // Normalize date format
        const normalizedDate = date.replace(/[-/]/g, '');
        const dateKey = `${normalizedDate}_${source_id}`;
        
        // Skip if we've already processed this date+source combination
        if (processedDates.has(dateKey)) {
          log(`[populateChannelsForDates] Skipping duplicate date+source: ${dateKey}`);
          continue;
        }
        processedDates.add(dateKey);

        log(`[populateChannelsForDates] Processing date ${normalizedDate}, source_id ${source_id}`);
        
        try {
          // Pass force_refresh flag to bypass existence check if requested
          const result = await populateChannelsForDate(class_name, project_id, source_id, normalizedDate, null, force_refresh === true);
          log(`[populateChannelsForDates] Success for date ${normalizedDate}, source ${source_id}:`, result);
          results.push({ date: normalizedDate, source_id, ...result });
        } catch (err) {
          logError(`[populateChannelsForDates] Error populating channels for date ${normalizedDate}, source ${source_id}:`, err);
          errors.push({ date: normalizedDate, source_id, error: err.message });
        }
      }

      const summary = {
        total: dates.length,
        processed: results.length,
        error_count: errors.length,
        results,
        errors: errors.length > 0 ? errors : undefined
      };

      log(`[populateChannelsForDates] Completed: ${results.length} dates processed, ${errors.length} errors`);
      return sendResponse(res, info, 200, true, `Channel population completed: ${results.length} dates processed, ${errors.length} errors`, summary);
    } else {
      logError('[populateChannelsForDates] Unauthorized - permission check failed');
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    logError('[populateChannelsForDates] error:', error);
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Get channels for a date
exports.getChannels = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'getChannels'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date, data_source } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Normalize date format (remove dashes if present)
      const normalizedDate = date.replace(/[-/]/g, '');
      
      if (normalizedDate.length !== 8 || !/^\d+$/.test(normalizedDate)) {
        return sendResponse(res, info, 400, false, `Invalid date format: ${date}. Expected YYYY-MM-DD or YYYYMMDD`, null);
      }

      // Build query based on data_source filter
      let sql = `SELECT DISTINCT channel_name FROM gp50.channels WHERE date = $1`;
      const params = [normalizedDate];
      
      if (data_source) {
        const dataSourceUpper = data_source.toUpperCase();
        if (dataSourceUpper === 'FILE' || dataSourceUpper === 'INFLUX') {
          sql += ` AND data_source = $2`;
          params.push(dataSourceUpper);
        }
        // If data_source is 'UNIFIED' or anything else, return both FILE and INFLUX
      }
      
      sql += ` ORDER BY channel_name`;

      const rows = await db.GetRows(sql, params);
      const channels = rows ? rows.map(row => row.channel_name) : [];

      return sendResponse(res, info, 200, true, `${channels.length} channels found`, channels);
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    logError('[getChannels] error:', error);
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Update dataset
exports.updateDatasetVisibility = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'updateDatasetVisibility'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, visible} = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      const params = [dataset_id, visible];
      const sql = `UPDATE ${class_name}.datasets SET visible = $2, date_modified = CURRENT_TIMESTAMP WHERE dataset_id = $1`;

      result = await db.ExecuteCommand(sql, params);

      if (result) {
        return sendResponse(res, info, 200, true, "Dataset visibility set to "+visible, null, false);
      } else {
        return sendResponse(res, info, 500, false, 'Failed to update dataset visibility', null, true);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
  
// Delete dataset
exports.deleteDataset = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/datasets', "function": 'deleteDataset'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
      const { class_name, project_id, dataset_id } = req.body;

      let result = await check_permissions(req, 'write', project_id)

      if (result) {       
        const params = [dataset_id];
        const sql = `DELETE FROM ${class_name}.datasets WHERE dataset_id = $1`;
    
        result = await db.ExecuteCommand(sql, params);
    
        if (result) {
          return sendResponse(res, info, 200, true, "Dataset deleted successfully", null, false);
        } else {
          return sendResponse(res, info, 500, false, 'Failed to delete dataset', null, true);
        }
      } else {
        return sendResponse(res, info, 401, false, 'Unauthorized' , null);
      }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};