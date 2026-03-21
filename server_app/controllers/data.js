const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse, sanitizeChannelNames, listtostring, formatDatetimeUTC } = require('../middleware/helpers');

/**
 * Shared filter builder for maneuver queries
 * @param {Object} filtersObj - Parsed filters object
 * @param {string} class_name - Class name (e.g., 'GP50')
 * @param {boolean} isHistory - If true, includes YEAR, EVENT, CONFIG filters; if false, only GRADE, STATE, SOURCE_NAME
 * @param {string} tableAlias - Table alias for dataset_events (usually 'b')
 * @param {string} datasetAlias - Table alias for datasets (usually 'c' or 'd')
 * @param {string} sourceAlias - Table alias for sources (usually 'd' or 'e')
 * @returns {Object} { filterClauses: string[], filterParams: any[] }
 */
function buildManeuverFilters(filtersObj, class_name, isHistory, tableAlias = 'b', datasetAlias = 'c', sourceAlias = 'd') {
  const filterClauses = [];
  const filterParams = [];

  if (!filtersObj || class_name.toUpperCase() !== 'GP50') {
    return { filterClauses, filterParams };
  }

  // GRADE filter: Filter on dataset_events.tags->>'GRADE'
  // Use "greater than" logic to match client-side behavior (selecting grade 0 shows grades > 0, i.e., 1-5)
  // -1 means "All" (grade > -1, i.e. all grades 0-5). Allowed only when !isHistory (maneuver/fleet maneuver pages).
  // For history endpoints, always enforce minimum grade > 1 (users cannot see grades 0 or 1)
  if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
    const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= -1 && g <= 5);
    if (gradeValues.length > 0) {
      // Use minimum grade value for "greater than" logic (consistent with client-side filter behavior)
      const minGrade = Math.min(...gradeValues);
      // For history endpoints, ensure minimum grade is always > 1 (enforce grade > 1 even when filter is provided)
      if (isHistory) {
        // Ensure the filter enforces at least grade > 1 (ignore -1 "All" for history)
        const effectiveMinGrade = Math.max(minGrade, 1);
        filterClauses.push(`(${tableAlias}.tags->>'GRADE')::int > ${effectiveMinGrade}`);
      } else {
        filterClauses.push(`(${tableAlias}.tags->>'GRADE')::int > ${minGrade}`);
      }
    }
  }

  // STATE filter: Filter on dataset_events.tags->>'FOILING_STATE' (case-insensitive)
  if (filtersObj.STATE && Array.isArray(filtersObj.STATE) && filtersObj.STATE.length > 0) {
    const stateValues = filtersObj.STATE.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
    if (stateValues.length > 0) {
      filterParams.push(stateValues);
      filterClauses.push(`UPPER(${tableAlias}.tags->>'FOILING_STATE') = ANY($FILTER_PLACEHOLDER::text[])`);
    }
  }

  // SOURCE_NAME filter: Filter on source_name (case-insensitive)
  if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
    const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
    if (sourceValues.length > 0) {
      const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
      filterParams.push(lowerSourceValues);
      filterClauses.push(`LOWER(${sourceAlias}.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
    }
  }

  // TRAINING_RACING filter: Filter on dataset_events.tags->'RACES'->>'Race_number'
  // RACING = exclude training (race_number not -1 / TRAINING / training); TRAINING = only training (-1 or TRAINING/training)
  if (filtersObj.TRAINING_RACING && Array.isArray(filtersObj.TRAINING_RACING) && filtersObj.TRAINING_RACING.length > 0) {
    const tr = String(filtersObj.TRAINING_RACING[0]).trim().toUpperCase();
    if (tr === 'TRAINING') {
      filterClauses.push(`LOWER(TRIM(COALESCE(${tableAlias}.tags -> 'RACES' ->> 'Race_number', ''))) IN ('-1', 'training')`);
    } else if (tr === 'RACING') {
      filterClauses.push(`(${tableAlias}.tags -> 'RACES' ->> 'Race_number' IS NOT NULL AND LOWER(TRIM(${tableAlias}.tags -> 'RACES' ->> 'Race_number')) NOT IN ('-1', 'training'))`);
    }
  }

  // History-only filters
  if (isHistory) {
    // YEAR filter: Filter on datasets.year_name
    if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
      const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
      if (yearValues.length > 0) {
        filterParams.push(yearValues);
        filterClauses.push(`${datasetAlias}.year_name = ANY($FILTER_PLACEHOLDER)`);
      }
    }

    // EVENT filter: Filter on datasets.event_name (case-insensitive)
    if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
      const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
      if (eventValues.length > 0) {
        const lowerEventValues = eventValues.map(e => e.toLowerCase());
        filterParams.push(lowerEventValues);
        filterClauses.push(`LOWER(${datasetAlias}.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
      }
    }

    // CONFIG filter: Filter on dataset_events.tags->>'CONFIG' (case-insensitive)
    if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
      const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
      if (configValues.length > 0) {
        const lowerConfigValues = configValues.map(c => c.toLowerCase());
        filterParams.push(lowerConfigValues);
        filterClauses.push(`LOWER(${tableAlias}.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
      }
    }
  }

  return { filterClauses, filterParams };
}

/**
 * Apply filter placeholders with correct parameter indices
 * @param {string} filterWhereClause - Filter clause with $FILTER_PLACEHOLDER
 * @param {number} startParamIndex - Starting parameter index
 * @returns {string} Filter clause with replaced placeholders
 */
function applyFilterPlaceholders(filterWhereClause, startParamIndex) {
  if (!filterWhereClause || !filterWhereClause.includes('$FILTER_PLACEHOLDER')) {
    return filterWhereClause;
  }
  let paramIndex = startParamIndex;
  return filterWhereClause.replace(/\$FILTER_PLACEHOLDER/g, () => `$${paramIndex++}`);
}

/**
 * Build common filter SELECT fields
 * @param {string} tableAlias - Table alias for dataset_events
 * @param {string} datasetAlias - Table alias for datasets
 * @param {string} sourceAlias - Table alias for sources
 * @returns {string} Filter SELECT fields
 */
function buildFilterSelectFields(tableAlias = 'b', datasetAlias = 'c', sourceAlias = 'd') {
  return `${tableAlias}.tags -> 'RACES' ->> 'Race_number' "Race_number",
    ${tableAlias}.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
    (${tableAlias}.tags->>'GRADE')::int "Grade", 
    ${tableAlias}.tags->>'CONFIG' "Config", 
    ${tableAlias}.tags->>'FOILING_STATE' "State",
    ${datasetAlias}.year_name "Year",
    ${datasetAlias}.event_name "Event",
    ${sourceAlias}.source_name "source_name"`;
}

/**
 * Build GP50-specific TWS bin logic
 * @param {string} class_name - Class name
 * @param {string} statsAlias - Alias for maneuver_stats table (usually 'a' or 'c')
 * @returns {Object} { twsBinWhereClause, twsBinPartitionExpr, twsBinFinalFilter, orderByExpr }
 */
function buildGP50TwsBinLogic(class_name, statsAlias = 'a') {
  const isGP50 = class_name.toUpperCase() === 'GP50';
  const bins = [5, 10, 15, 20, 25, 30, 35, 40, 45];

  let twsBinWhereClause = '';
  let twsBinPartitionExpr = `${statsAlias}."Tws_bin"`;
  let twsBinFinalFilter = '';
  let orderByExpr = 'Q.tws_bin';

  if (isGP50) {
    // Build OR conditions for each bin: Tws_avg >= (bin - 2.5) AND Tws_avg < (bin + 2.5)
    const binConditions = bins.map(bin => {
      const minTws = bin - 2.5;
      const maxTws = bin + 2.5;
      return `(${statsAlias}."Tws_avg" >= ${minTws} AND ${statsAlias}."Tws_avg" < ${maxTws})`;
    }).join(' OR ');
    twsBinWhereClause = `AND (${binConditions})`;
    // Partition by calculated bin (round to nearest multiple of 5)
    twsBinPartitionExpr = `ROUND(${statsAlias}."Tws_avg" / 5) * 5`;
    // Final filter also checks Tws_avg range (use lowercase alias tws_avg)
    twsBinFinalFilter = `AND (${binConditions.replace(new RegExp(`${statsAlias}\\.\"Tws_avg\"`, 'g'), 'Q.tws_avg')})`;
    // Order by calculated bin (use lowercase alias tws_avg)
    orderByExpr = `ROUND(Q.tws_avg / 5) * 5`;
  }

  return { twsBinWhereClause, twsBinPartitionExpr, twsBinFinalFilter, orderByExpr };
}

exports.getBestManeuvers_TableData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getBestManeuvers' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, start_date, end_date, event_type, channels, filters } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Sanitize channels - sanitizeChannelNames expects a JSON string
      let safeChannels = [];
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      const eventTypeLower = event_type.toLowerCase();

      // Build channels string - prefix each channel with "a." and handle special cases
      let channelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();

        // tws_bin is now a column in the table, so use a.Tws_bin directly but alias as lowercase
        if (channelLower === 'tws_bin') {
          channelFields.push(`a."Tws_bin" "tws_bin"`);
          return;
        }

        // Handle special computed fields - aliases should be lowercase per repo rules
        if (channelLower === 'twa_entry_n') {
          // For takeoff events, twa_entry comes from twa_start
          if (eventTypeLower === 'takeoff') {
            channelFields.push(`abs(a."Twa_start") "twa_entry_n"`);
          } else {
            channelFields.push(`abs(a."Twa_entry") "twa_entry_n"`);
          }
        } else if (channelLower === 'twa_exit_n') {
          channelFields.push(`abs(a."Twa_exit") "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          channelFields.push(`abs(a."Twa_build") "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          channelFields.push(`abs(a."Twa_drop") "twa_drop_n"`);
        } else if (channelLower === 'twa_entry' && eventTypeLower === 'takeoff') {
          // For takeoff, twa_entry comes from twa_start
          channelFields.push(`a."Twa_start" as "twa_entry"`);
        } else {
          // Use mixed-case column name from DB but alias as lowercase for frontend
          channelFields.push(`a."${channel}" "${channelLower}"`);
        }
      });
      const channelStr = channelFields.join(', ');

      // Parse filters if provided
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Build filter WHERE clauses and parameters - class-specific for this query
      let filterClauses = [];
      let filterParams = [];

      if (filtersObj) {
        if (class_name.toUpperCase() === 'GP50') {
          // GRADE filter: Filter on dataset_events.tags->>'GRADE'
          if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
            const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
            if (gradeValues.length > 0) {
              filterParams.push(gradeValues);
              filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // YEAR filter: Filter on datasets.year_name
          if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
            const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
            if (yearValues.length > 0) {
              filterParams.push(yearValues);
              filterClauses.push(`c.year_name = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // EVENT filter: Filter on datasets.event_name (case-insensitive)
          if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
            const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
            if (eventValues.length > 0) {
              const lowerEventValues = eventValues.map(e => e.toLowerCase());
              filterParams.push(lowerEventValues);
              filterClauses.push(`LOWER(c.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // CONFIG filter: Filter on dataset_events.tags->>'CONFIG' (case-insensitive)
          if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
            const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
            if (configValues.length > 0) {
              const lowerConfigValues = configValues.map(c => c.toLowerCase());
              filterParams.push(lowerConfigValues);
              filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // STATE filter: Filter on dataset_events.tags->>'FOILING_STATE' (case-insensitive)
          if (filtersObj.STATE && Array.isArray(filtersObj.STATE) && filtersObj.STATE.length > 0) {
            const stateValues = filtersObj.STATE.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
            if (stateValues.length > 0) {
              filterParams.push(stateValues);
              filterClauses.push(`UPPER(b.tags->>'FOILING_STATE') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }
        }
        // Add more class-specific filter logic here as needed
      }

      // Combine filter clauses
      const filterWhereClause = filterClauses.length > 0 ? ' AND ' + filterClauses.join(' AND ') : '';

      // Build date range WHERE clause
      let dateWhereClause = '';
      if (start_date === end_date) {
        dateWhereClause = `c.date = $3`;
      } else {
        dateWhereClause = `c.date > $3 AND c.date <= $4`;
      }

      let baseParams = [source_id, event_type, start_date];
      if (start_date !== end_date) {
        baseParams.push(end_date);
      }
      let allParams = [...baseParams, ...filterParams];

      // Use Tws_bin column directly from table
      const twsBinExpr = `a."Tws_bin"`;

      // For GP50, filter by Tws_avg within ±2.5 of bin values instead of exact tws_bin matches
      const isGP50 = class_name.toUpperCase() === 'GP50';

      // WHERE conditions - only grade filter (class-specific)
      let whereConditions;
      if (class_name.toUpperCase() === 'GP50') {
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      } else {
        // Default fallback
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      }

      // Build filter clause with correct parameter indices
      let binFilterClause = filterWhereClause;
      if (filterClauses.length > 0) {
        let paramIndex = baseParams.length + 1;
        binFilterClause = filterWhereClause.replace(/\$FILTER_PLACEHOLDER/g, () => `$${paramIndex++}`);
      }

      // Build filter SELECT fields - class-specific for this query structure
      let filter_str;
      let bins = [];
      bins = [5, 10, 15, 20, 25, 30, 35, 40, 45];
      filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
        b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
        (b.tags->>'GRADE')::int "Grade", 
        b.tags->>'CONFIG' "Config", 
        b.tags->>'FOILING_STATE' "State",
        c.year_name "Year",
        c.event_name "Event",
        d.source_name "source_name"`;

      // Datetime in UTC; clients use row timezone for display
      const datetimeExpr = formatDatetimeUTC('a."Datetime"', '"Datetime"');

      // Single query: use tws_bin column and tack_side, then pick top 10 per bin and tack
      // Check if tws_bin is already in channelStr to avoid duplicate selection
      const hasTwsBinInChannels = safeChannels.some(ch => ch.toLowerCase() === 'tws_bin');
      const twsBinSelect = hasTwsBinInChannels ? '' : `${twsBinExpr} as tws_bin,`;

      // For GP50: filter by Tws_avg within ±2.5 of bin values, partition by calculated bin
      let twsBinWhereClause = '';
      let twsBinPartitionExpr = twsBinExpr;
      let twsBinFinalFilter = '';
      let orderByExpr = 'Q.tws_bin';

      if (isGP50) {
        // Build OR conditions for each bin: Tws_avg >= (bin - 2.5) AND Tws_avg < (bin + 2.5)
        const binConditions = bins.map(bin => {
          const minTws = bin - 2.5;
          const maxTws = bin + 2.5;
          return `(a."Tws_avg" >= ${minTws} AND a."Tws_avg" < ${maxTws})`;
        }).join(' OR ');
        twsBinWhereClause = `AND (${binConditions})`;
        // Partition by calculated bin (round to nearest multiple of 5)
        twsBinPartitionExpr = `ROUND(a."Tws_avg" / 5) * 5`;
        // Final filter also checks Tws_avg range (use lowercase alias from channelStr)
        twsBinFinalFilter = `AND (${binConditions.replace(/a\.\"Tws_avg\"/g, 'Q."tws_avg"')})`;
        // Order by calculated bin (use lowercase alias)
        orderByExpr = `ROUND(Q."tws_avg" / 5) * 5`;
      }

      const sql = `SELECT * FROM (
        SELECT 
          a.event_id,
          ${twsBinSelect}
          ${datetimeExpr},
          c.timezone AS "timezone",
          ${filter_str},
          ${channelStr},
          CASE WHEN a."Twa_entry" > 0 THEN 1 ELSE -1 END as tack_side,
          ROW_NUMBER() OVER (
            PARTITION BY 
              ${twsBinPartitionExpr},
              (CASE WHEN a."Twa_entry" > 0 THEN 1 ELSE -1 END)
            ORDER BY a."Vmg_perc_avg" DESC
          ) as row_num
        FROM ${class_name}.maneuver_stats a
        INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id
        INNER JOIN ${class_name}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${class_name}.sources d ON c.source_id = d.source_id
        WHERE c.source_id = $1 
          AND c.visible = 1 
          AND lower(b.event_type) = lower($2)
          AND ${dateWhereClause}
          AND ${whereConditions}
          ${binFilterClause}
          ${twsBinWhereClause}
      ) Q
      WHERE Q.row_num <= 10
      ${twsBinFinalFilter}
      ORDER BY ${orderByExpr}, Q.tack_side, Q."vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, allParams);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        console.log('getBestManeuvers', Date.now(), sql + '...', allParams);
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('getBestManeuvers unexpected error:', error);
    if (error && error.stack) {
      console.error('getBestManeuvers stack:', error.stack);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getBestFleetManeuvers_TableData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getBestFleetManeuvers_TableData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block

  try {
    const { class_name, project_id, start_date, end_date, event_type, count = 10, channels, filters } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Sanitize channels - sanitizeChannelNames expects a JSON string
      let safeChannels = [];
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      const eventTypeLower = event_type.toLowerCase();

      // Build channels string for subquery - handle special computed fields
      let subqueryChannelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();
        // Handle special computed fields
        if (channelLower === 'twa_entry_n') {
          if (eventTypeLower === 'takeoff') {
            subqueryChannelFields.push(`abs(a."Twa_start") "twa_entry_n"`);
          } else {
            subqueryChannelFields.push(`abs(a."Twa_entry") "twa_entry_n"`);
          }
        } else if (channelLower === 'twa_exit_n') {
          subqueryChannelFields.push(`abs(a."Twa_exit") "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          subqueryChannelFields.push(`abs(a."Twa_build") "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          subqueryChannelFields.push(`abs(a."Twa_drop") "twa_drop_n"`);
        } else if (channelLower === 'twa_entry' && eventTypeLower === 'takeoff') {
          subqueryChannelFields.push(`a."Twa_start" as twa_entry`);
        }
      });
      const subqueryChannelStr = subqueryChannelFields.length > 0 ? ', ' + subqueryChannelFields.join(', ') : '';

      // Build channels string for outer query - reference from Q
      // All channels (regular and computed) are available in Q since a.* is in subquery
      // Normalize all aliases to lowercase per repo rules
      let outerChannelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();
        if (channelLower === 'tws_bin') {
          outerChannelFields.push(`Q."Tws_bin" "tws_bin"`);
        } else if (channelLower === 'twa_entry_n') {
          outerChannelFields.push(`Q."twa_entry_n" "twa_entry_n"`);
        } else if (channelLower === 'twa_exit_n') {
          outerChannelFields.push(`Q."twa_exit_n" "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          outerChannelFields.push(`Q."twa_build_n" "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          outerChannelFields.push(`Q."twa_drop_n" "twa_drop_n"`);
        } else {
          // Reference channel from Q with proper quoting, but alias as lowercase
          outerChannelFields.push(`Q."${channel}" "${channelLower}"`);
        }
      });
      const outerChannelStr = outerChannelFields.length > 0 ? ', ' + outerChannelFields.join(', ') : '';

      // Parse filters if provided
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Build filter WHERE clauses and parameters - class-specific for this query
      let filterClauses = [];
      let filterParams = [];

      if (filtersObj) {
        if (class_name.toUpperCase() === 'GP50') {
          // GRADE filter: Filter on dataset_events.tags->>'GRADE'
          if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
            const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
            if (gradeValues.length > 0) {
              filterParams.push(gradeValues);
              filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // YEAR filter: Filter on datasets.year_name
          if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
            const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
            if (yearValues.length > 0) {
              filterParams.push(yearValues);
              filterClauses.push(`c.year_name = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // EVENT filter: Filter on datasets.event_name (case-insensitive)
          if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
            const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
            if (eventValues.length > 0) {
              const lowerEventValues = eventValues.map(e => e.toLowerCase());
              filterParams.push(lowerEventValues);
              filterClauses.push(`LOWER(c.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // CONFIG filter: Filter on dataset_events.tags->>'CONFIG' (case-insensitive)
          if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
            const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
            if (configValues.length > 0) {
              const lowerConfigValues = configValues.map(c => c.toLowerCase());
              filterParams.push(lowerConfigValues);
              filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // STATE filter: Filter on dataset_events.tags->>'FOILING_STATE' (case-insensitive)
          if (filtersObj.STATE && Array.isArray(filtersObj.STATE) && filtersObj.STATE.length > 0) {
            const stateValues = filtersObj.STATE.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
            if (stateValues.length > 0) {
              filterParams.push(stateValues);
              filterClauses.push(`UPPER(b.tags->>'FOILING_STATE') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // SOURCE_NAME filter: Filter on source_name (case-insensitive)
          if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
            const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
            if (sourceValues.length > 0) {
              const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
              filterParams.push(lowerSourceValues);
              filterClauses.push(`LOWER(d.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }
        }
        // Add more class-specific filter logic here as needed
      }

      // Combine filter clauses
      const filterWhereClause = filterClauses.length > 0 ? ' AND ' + filterClauses.join(' AND ') : '';

      // Build date range WHERE clause
      let dateWhereClause = '';
      if (start_date === end_date) {
        dateWhereClause = `c.date = $3`;
      } else {
        dateWhereClause = `c.date > $3 AND c.date <= $4`;
      }

      // Use Tws_bin column directly from table
      const twsBinExpr = `a."Tws_bin"`;

      // Build subquery select fields - class-specific for this query structure
      let filter_str;
      filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
        b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
        (b.tags->>'GRADE')::int "Grade", 
        b.tags->>'CONFIG' "Config", 
        b.tags->>'FOILING_STATE' "State",
        c.year_name "Year",
        c.event_name "Event"`;

      const baseSubqueryFields = `a.*, 
        d.source_name as source_name,
        a."Tws_bin" as tws_bin_sub,
        a."Vmg_perc_avg" as vmg_perc_avg,
        cast(a."Datetime" as text) as datetime_sub,
        ${filter_str}`;

      // Add twa_entry mapping for takeoff events if twa_entry is in channels
      let twaEntryMapping = '';
      if (eventTypeLower === 'takeoff' && safeChannels.some(c => c.toLowerCase() === 'twa_entry')) {
        twaEntryMapping = ', a."Twa_start" as "twa_entry"';
      }

      const subquerySelectFields = `${baseSubqueryFields}${twaEntryMapping}${subqueryChannelStr}`;

      // Build outer select fields - always include base fields
      // Use the text-casted datetime_sub from the subquery and expose it as Datetime
      let baseOuterFields;
      baseOuterFields = `Q.event_id "event_id", Q.source_name, Q.datetime_sub as "Datetime", 
        Q."Race_number" "Race_number", Q."Leg_number" "Leg_number",
        Q."Grade" "Grade", Q."Config" "Config",
        Q."Year" "Year", Q."Event" "Event", Q.source_name "source_name"`;

      const outerSelectFields = `${baseOuterFields}${outerChannelStr}`;

      // WHERE conditions - only grade filter (class-specific)
      let whereConditions;
      if (class_name.toUpperCase() === 'GP50') {
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      } else {
        // Default fallback
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      }

      // Build base parameters
      let baseParams = [project_id, event_type, start_date];
      let countParamIndex = 4;
      if (start_date !== end_date) {
        baseParams.push(end_date);
        countParamIndex = 5;
      }
      baseParams.push(parseInt(count));

      // Replace filter placeholder with correct parameter indices
      let finalFilterClause = filterWhereClause;
      if (filterClauses.length > 0) {
        let paramIndex = countParamIndex + 1; // Start after count parameter
        finalFilterClause = filterWhereClause.replace(/\$FILTER_PLACEHOLDER/g, () => `$${paramIndex++}`);
      }

      const params = [...baseParams, ...filterParams];

      const sql = `SELECT ${outerSelectFields} FROM (
        SELECT ${subquerySelectFields},
        ROW_NUMBER() OVER (
          PARTITION BY 
            source_name,
            ${twsBinExpr},
            (CASE WHEN a."Twa_entry" > 0 THEN 1 ELSE -1 END)
          ORDER BY a."Vmg_perc_avg" DESC
        ) AS row_num
        FROM ${class_name}.maneuver_stats a
        INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id
        INNER JOIN ${class_name}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${class_name}.sources d ON c.source_id = d.source_id
        WHERE d.project_id = $1
        AND c.visible = 1
        AND lower(b.event_type) = lower($2)
        AND ${dateWhereClause}
        AND ${whereConditions}
        ${finalFilterClause}
      ) Q WHERE Q.row_num <= $${countParamIndex} ORDER BY Q.source_name, Q.vmg_perc_avg DESC`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        console.log('getBestFleetManeuvers', Date.now(), sql, params);
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getBestFleetManeuvers_TableData error:', error);
    console.error('getBestFleetManeuvers_TableData error stack:', error.stack);
    if (sql) {
      console.error('getBestFleetManeuvers_TableData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve all classes
exports.getDatasetManeuvers_TableData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getDatasetManeuvers_TableData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block
  let safeChannels = []; // Declare safeChannels here to be accessible in catch block

  try {
    const { class_name, project_id, dataset_id, event_type, channels, filters } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Datetime in UTC; clients use row timezone for display
      const datetimeExpr = formatDatetimeUTC('a."Datetime"', '"Datetime"');
      // Sanitize channels - sanitizeChannelNames expects a JSON string
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      const eventTypeLower = event_type.toLowerCase();

      // Helper function to convert channel name to mixed-case database column name
      // Pattern: capitalize only the first letter of the entire string, rest lowercase
      // Database columns use format like "Tws_avg", "Vmg_perc_avg" (not "Tws_Avg", "Vmg_Perc_Avg")
      // e.g., "tws_avg" -> "Tws_avg", "Tws_avg" -> "Tws_avg", "vmg_perc_avg" -> "Vmg_perc_avg"
      const toDbColumnName = (channelName) => {
        if (!channelName || channelName.length === 0) return channelName;
        // Normalize to lowercase first, then capitalize only first letter
        const normalized = channelName.toLowerCase();
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      };

      // TAKEOFF-specific channel -> DB column mapping (maneuver_stats from takeoffs pipeline)
      const TAKEOFF_CHANNEL_DB_COLUMNS = {
        tws_avg: 'Tws_avg',
        mmg: 'Mmg',
        vmg_perc_avg: 'Vmg_perc_avg',
        bsp_start: 'Bsp_start',
        twa_build: 'Twa_build',
        time_accel: 'Time_accel',
        exit_time: 'Exit_time',
        bsp_exit: 'Bsp_exit',
        twa_exit: 'Twa_exit',
        cant_accmax: 'Cant_accmax',
        pitch_accmax: 'Pitch_accmax',
        heel_accmax: 'Heel_accmax',
        jib_sheet_pct_accmax: 'Jib_sheet_pct_accmax',
        jib_lead_ang_accmax: 'Jib_lead_ang_accmax',
        jib_cunno_load_accmax: 'Jib_cunno_load_accmax',
        wing_clew_pos_accmax: 'Wing_clew_pos_accmax',
        wing_twist_accmax: 'Wing_twist_accmax',
        rud_rake_accmax: 'Rud_rake_accmax',
        rud_diff_accmax: 'Rud_diff_accmax',
        wing_ca1_accmax: 'Wing_ca1_accmax',
        rake_accmax: 'Rake_accmax'
      };

      // Build channels string - prefix each channel with "a." and handle special cases
      // Normalize all aliases to lowercase per repo rules: "All data fields from the API are stored in lowercase"
      let channelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();

        // tws_bin is now a column, so use a.Tws_bin directly but alias as lowercase
        if (channelLower === 'tws_bin') {
          channelFields.push(`a."Tws_bin" "tws_bin"`);
        } else if (channelLower === 'twa_entry_n') {
          // For takeoff events, twa_entry comes from twa_start
          if (eventTypeLower === 'takeoff') {
            channelFields.push(`abs(a."Twa_start") "twa_entry_n"`);
          } else {
            channelFields.push(`abs(a."Twa_entry") "twa_entry_n"`);
          }
        } else if (channelLower === 'twa_exit_n') {
          channelFields.push(`abs(a."Twa_exit") "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          channelFields.push(`abs(a."Twa_build") "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          channelFields.push(`abs(a."Twa_drop") "twa_drop_n"`);
        } else if (channelLower === 'twa_entry' && eventTypeLower === 'takeoff') {
          // For takeoff, twa_entry comes from twa_start
          channelFields.push(`a."Twa_start" as "twa_entry"`);
        } else if (channelLower === 'loss_inv_avg') {
          channelFields.push(`a."Loss_inv_vmg" "loss_inv_avg"`);
        } else if (channelLower === 'loss_turn_avg') {
          channelFields.push(`a."Loss_turn_vmg" "loss_turn_avg"`);
        } else if (channelLower === 'loss_build_avg') {
          channelFields.push(`a."Loss_build_vmg" "loss_build_avg"`);
        } else if (channelLower === 'loss_total_avg') {
          channelFields.push(`a."Loss_total_vmg" "loss_total_avg"`);
        } else if (channelLower === 'bsp_drop') {
          // Explicit handling for Bsp_drop to ensure it's included
          channelFields.push(`a."Bsp_drop" "bsp_drop"`);
        } else if (channelLower === 'drop_time') {
          channelFields.push(`a."Drop_time" "drop_time"`);
        } else if (eventTypeLower === 'takeoff' && TAKEOFF_CHANNEL_DB_COLUMNS[channelLower]) {
          // TAKEOFF-specific columns (big table / scatter): use explicit DB column names
          const dbCol = TAKEOFF_CHANNEL_DB_COLUMNS[channelLower];
          channelFields.push(`a."${dbCol}" "${channelLower}"`);
        } else {
          // Convert lowercase channel name to mixed-case database column name
          const dbColumnName = toDbColumnName(channelLower);
          channelFields.push(`a."${dbColumnName}" "${channelLower}"`);
        }
      });

      const channel_str = channelFields.join(', ');

      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Build filters (single date type - only GRADE, STATE, SOURCE_NAME)
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, false, 'b', 'c', 'd');

      // Build filter SELECT fields - class-specific for this query structure
      const filter_str = buildFilterSelectFields('b', 'c', 'd');

      // Base parameters
      let baseParams = [dataset_id, event_type];
      let paramIndex = 3;

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
      }

      const params = [...baseParams, ...filterParams];

      sql = `SELECT 
          a.event_id "event_id", 
          ${datetimeExpr},
          c.timezone AS "timezone",
          ${filter_str},
          ${channel_str}
        FROM ${class_name}.maneuver_stats a 
        inner join ${class_name}.dataset_events b on a.event_id = b.event_id 
        inner join ${class_name}.datasets c on b.dataset_id = c.dataset_id 
        inner join ${class_name}.sources d on c.source_id = d.source_id
        where b.dataset_id = $1 and lower(b.event_type) = lower($2)
          ${finalFilterClause}
        order by a."Vmg_perc_avg" desc`;

      console.log('getDatasetManeuvers', Date.now(), sql, params);
      console.log('getDatasetManeuvers channels:', safeChannels);
      console.log('getDatasetManeuvers channel_str:', channel_str);
      // Debug: Check if bsp_drop and drop_time are in the channel string
      if (channel_str.includes('bsp_drop') || channel_str.includes('drop_time')) {
        console.log('getDatasetManeuvers: bsp_drop/drop_time found in channel_str');
      } else {
        console.warn('getDatasetManeuvers: bsp_drop/drop_time NOT found in channel_str!');
        console.log('Looking for channels:', safeChannels.filter(c => c.toLowerCase().includes('bsp_drop') || c.toLowerCase().includes('drop_time')));
      }

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        console.log(sql, params);
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('getDatasetManeuvers_TableData error:', error);
    console.error('getDatasetManeuvers_TableData error message:', error.message);
    if (error && error.stack) {
      console.error('getDatasetManeuvers_TableData error stack:', error.stack);
    }
    if (sql) {
      console.error('getDatasetManeuvers_TableData SQL:', sql);
    }
    if (safeChannels) {
      console.error('getDatasetManeuvers_TableData channels:', safeChannels);
    }
    return sendResponse(res, info, 500, false, error.message || 'Internal server error', null, true);
  }
};

exports.getManeuvers_MapData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_MapData' }

  console.log('getManeuvers_MapData1 - endpoint called');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('getManeuvers_MapData - validation errors:', JSON.stringify(errors.array()));
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block

  try {
    const { class_name, project_id, desc, event_list } = req.query;

    console.log('getManeuvers_MapData2 - query params:', { class_name, project_id, desc, event_list: event_list ? 'present' : 'missing' });

    // Validate required parameters
    if (!class_name) {
      console.log('getManeuvers_MapData - missing class_name');
      return sendResponse(res, info, 400, false, 'class_name is required', null);
    }
    if (!desc) {
      console.log('getManeuvers_MapData - missing desc');
      return sendResponse(res, info, 400, false, 'desc is required', null);
    }
    if (!event_list) {
      console.log('getManeuvers_MapData - missing event_list');
      return sendResponse(res, info, 400, false, 'event_list is required', null);
    }

    let result = await check_permissions(req, 'read', project_id)

    console.log('getManeuvers_MapData3 - permissions check result:', result);

    if (result) {
      let params;

      // event_list is now required: always filter by explicit list of event_ids and matching description
      try {
        const raw = JSON.parse(event_list);
        const ids = Array.isArray(raw)
          ? raw.map(v => parseInt(v)).filter(v => Number.isInteger(v) && v > 0)
          : [];
        if (ids.length === 0) {
          return sendResponse(res, info, 400, false, 'event_list must contain positive integer event_ids', null);
        }

        let filter_str = '';
        filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
          b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
          (b.tags->>'GRADE')::int "Grade", 
          b.tags->>'CONFIG' "Config", 
          b.tags->>'FOILING_STATE' "State",
          d.year_name "Year",
          d.event_name "Event",
          e.source_name "source_name"`;

        params = [ids, desc];
        sql = `SELECT a.event_id "event_id", 
          ${filter_str},
          c."Tws_bin" "tws_bin", c."Vmg_perc_avg" "vmg_perc_avg", c."Twa_entry" "twa_entry", a.json 
          FROM ${class_name}.events_mapdata a 
          inner join ${class_name}.dataset_events b on a.event_id = b.event_id 
          inner join ${class_name}.maneuver_stats c on b.event_id = c.event_id 
          inner join ${class_name}.datasets d on b.dataset_id = d.dataset_id
          inner join ${class_name}.sources e on d.source_id = e.source_id
          where a.event_id = ANY($1) and LOWER(a.description) = LOWER($2)`;
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid event_list JSON', null);
      }

      console.log('getManeuvers_MapData', Date.now(), sql, params);

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('getManeuvers_MapData error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_MapData error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_MapData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getManeuvers_TimeSeriesData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_TimeSeriesData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block

  try {
    const { class_name, project_id, desc, event_list } = req.query;

    // Validate required parameters
    if (!class_name) {
      return sendResponse(res, info, 400, false, 'class_name is required', null);
    }
    if (!desc) {
      return sendResponse(res, info, 400, false, 'desc is required', null);
    }
    if (!event_list) {
      return sendResponse(res, info, 400, false, 'event_list is required', null);
    }

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      let params;

      // event_list is now required: always filter by explicit list of event_ids and matching description
      try {
        const raw = JSON.parse(event_list);
        const ids = Array.isArray(raw)
          ? raw.map(v => parseInt(v)).filter(v => Number.isInteger(v) && v > 0)
          : [];
        if (ids.length === 0) {
          return sendResponse(res, info, 400, false, 'event_list must contain positive integer event_ids', null);
        }

        let filter_str = '';
        filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
          b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
          (b.tags->>'GRADE')::int "Grade", 
          b.tags->>'CONFIG' "Config", 
          b.tags->>'FOILING_STATE' "State",
          d.year_name "Year",
          d.event_name "Event",
          e.source_name "source_name"`;

        params = [ids, desc];
        sql = `SELECT a.event_id "event_id",
          ${filter_str},
          c."Tws_bin" "tws_bin", c."Vmg_perc_avg" "vmg_perc_avg", c."Twa_entry" "twa_entry", a.json
          FROM ${class_name}.events_timeseries a 
          inner join ${class_name}.dataset_events b on a.event_id = b.event_id 
          inner join ${class_name}.maneuver_stats c on b.event_id = c.event_id 
          inner join ${class_name}.datasets d on b.dataset_id = d.dataset_id
          inner join ${class_name}.sources e on d.source_id = e.source_id
          where a.event_id = ANY($1) and LOWER(a.description) = LOWER($2)`;
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid event_list JSON', null);
      }

      console.log('getManeuvers_TimeSeriesData', Date.now(), sql, params);

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('getManeuvers_TimeSeriesData error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_TimeSeriesData error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_TimeSeriesData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getManeuvers_MapDataByRange = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_MapDataByRange' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block

  try {
    const { class_name, project_id, desc, start_date, end_date, event_type, source_id, filters } = req.query;

    console.log('[getManeuvers_MapDataByRange] Request params:', {
      class_name,
      project_id,
      desc,
      start_date,
      end_date,
      event_type,
      source_id,
      filters: filters ? JSON.parse(filters) : null
    });

    // Validate required parameters
    if (!class_name) {
      return sendResponse(res, info, 400, false, 'class_name is required', null);
    }
    if (!desc) {
      return sendResponse(res, info, 400, false, 'desc is required', null);
    }
    if (!start_date || !end_date) {
      return sendResponse(res, info, 400, false, 'start_date and end_date are required', null);
    }
    if (!event_type) {
      return sendResponse(res, info, 400, false, 'event_type is required', null);
    }

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Parse filters if provided
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Build filter WHERE clauses and parameters
      let filterClauses = [];
      let filterParams = [];

      if (filtersObj) {
        if (class_name.toUpperCase() === 'GP50') {
          // GRADE filter
          if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
            const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
            if (gradeValues.length > 0) {
              filterParams.push(gradeValues);
              filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // YEAR filter
          if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
            const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
            if (yearValues.length > 0) {
              filterParams.push(yearValues);
              filterClauses.push(`d.year_name = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // EVENT filter
          if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
            const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
            if (eventValues.length > 0) {
              const lowerEventValues = eventValues.map(e => e.toLowerCase());
              filterParams.push(lowerEventValues);
              filterClauses.push(`LOWER(d.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // CONFIG filter
          if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
            const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
            if (configValues.length > 0) {
              const lowerConfigValues = configValues.map(c => c.toLowerCase());
              filterParams.push(lowerConfigValues);
              filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // STATE filter
          if (filtersObj.STATE && Array.isArray(filtersObj.STATE) && filtersObj.STATE.length > 0) {
            const stateValues = filtersObj.STATE.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
            if (stateValues.length > 0) {
              filterParams.push(stateValues);
              filterClauses.push(`UPPER(b.tags->>'FOILING_STATE') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // SOURCE_NAME filter
          if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
            const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
            if (sourceValues.length > 0) {
              const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
              filterParams.push(lowerSourceValues);
              filterClauses.push(`LOWER(e.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }
        }
      }

      // Build parameters in order: project_id, event_type, start_date, end_date (if different), source_id (if provided), desc, then filters
      let params = [parseInt(project_id), event_type.toLowerCase()];
      let paramIndex = 3;

      // Build date range WHERE clause
      let dateWhereClause = '';
      if (start_date === end_date) {
        dateWhereClause = `d.date = $${paramIndex}`;
        params.push(start_date);
        paramIndex++;
      } else {
        dateWhereClause = `d.date >= $${paramIndex} AND d.date <= $${paramIndex + 1}`;
        params.push(start_date, end_date);
        paramIndex += 2;
      }

      // Add source_id filter if provided
      let sourceWhereClause = '';
      if (source_id) {
        sourceWhereClause = `AND e.source_id = $${paramIndex}`;
        params.push(parseInt(source_id));
        paramIndex++;
      }

      // Add desc parameter
      params.push(desc.toLowerCase());
      const descParamIndex = paramIndex;
      paramIndex++;

      // Replace filter placeholder with correct parameter indices
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        finalFilterClause = ' AND ' + filterClauses.join(' AND ').replace(/\$FILTER_PLACEHOLDER/g, () => {
          const currentIndex = paramIndex;
          paramIndex++;
          return `$${currentIndex}`;
        });
        params.push(...filterParams);
      }

      // WHERE conditions - only grade filter (class-specific)
      let whereConditions;
      if (class_name.toUpperCase() === 'GP50') {
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      } else {
        // Default fallback
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      }

      // Use Tws_bin column directly from table
      const twsBinExpr = `c."Tws_bin"`;

      // For GP50, filter by Tws_avg within ±2.5 of bin values instead of exact tws_bin matches
      const isGP50 = class_name.toUpperCase() === 'GP50';
      let bins = [5, 10, 15, 20, 25, 30, 35, 40, 45];

      // For GP50: filter by Tws_avg within ±2.5 of bin values, partition by calculated bin
      let twsBinWhereClause = '';
      let twsBinPartitionExpr = twsBinExpr;
      let twsBinFinalFilter = '';
      let orderByExpr = 'Q.tws_bin';

      if (isGP50) {
        // Build OR conditions for each bin: Tws_avg >= (bin - 2.5) AND Tws_avg < (bin + 2.5)
        const binConditions = bins.map(bin => {
          const minTws = bin - 2.5;
          const maxTws = bin + 2.5;
          return `(c."Tws_avg" >= ${minTws} AND c."Tws_avg" < ${maxTws})`;
        }).join(' OR ');
        twsBinWhereClause = `AND (${binConditions})`;
        // Partition by calculated bin (round to nearest multiple of 5)
        twsBinPartitionExpr = `ROUND(c."Tws_avg" / 5) * 5`;
        // Final filter also checks Tws_avg range
        twsBinFinalFilter = `AND (${binConditions.replace(/c\.\"Tws_avg\"/g, 'Q.tws_avg')})`;
        // Order by calculated bin
        orderByExpr = `ROUND(Q.tws_avg / 5) * 5`;
      }

      let filter_str = '';
      filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
        b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
        (b.tags->>'GRADE')::int "Grade", 
        b.tags->>'CONFIG' "Config", 
        b.tags->>'FOILING_STATE' "State",
        d.year_name "Year",
        d.event_name "Event",
        e.source_name "source_name"`;

      // Wrap query in subquery with window function to get top 10 per TWS bin/tack combination
      sql = `SELECT * FROM (
        SELECT 
          a.event_id "event_id",
          ${filter_str},
          c."Tws_bin" "tws_bin",
          ${isGP50 ? 'c."Tws_avg" "tws_avg",' : ''}
          c."Vmg_perc_avg" "vmg_perc_avg", 
          c."Twa_entry" "twa_entry", 
          a.json,
          CASE WHEN c."Twa_entry" > 0 THEN 1 ELSE -1 END as tack_side,
          ROW_NUMBER() OVER (
            PARTITION BY 
              ${twsBinPartitionExpr},
              (CASE WHEN c."Twa_entry" > 0 THEN 1 ELSE -1 END)
            ORDER BY c."Vmg_perc_avg" DESC
          ) as row_num
        FROM ${class_name}.events_mapdata a 
        inner join ${class_name}.dataset_events b on a.event_id = b.event_id 
        inner join ${class_name}.maneuver_stats c on b.event_id = c.event_id 
        inner join ${class_name}.datasets d on b.dataset_id = d.dataset_id
        inner join ${class_name}.sources e on d.source_id = e.source_id
        where e.project_id = $1
        and d.visible = 1
        and lower(b.event_type) = lower($2)
        and ${dateWhereClause}
        and LOWER(a.description) = LOWER($${descParamIndex})
        and ${whereConditions}
        ${sourceWhereClause}
        ${finalFilterClause}
        ${twsBinWhereClause}
      ) Q
      WHERE Q.row_num <= 10
      ${twsBinFinalFilter}
      ORDER BY ${orderByExpr}, Q.tack_side, Q."vmg_perc_avg" DESC`;

      console.log('getManeuvers_MapDataByRange', Date.now(), sql.substring(0, 200) + '...', params.length + ' params');
      console.log('[getManeuvers_MapDataByRange] Full SQL:', sql);
      console.log('[getManeuvers_MapDataByRange] Params:', JSON.stringify(params));

      let rows = await db.GetRows(sql, params);

      console.log('[getManeuvers_MapDataByRange] Query returned', rows?.length || 0, 'rows');

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuvers_MapDataByRange error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_MapDataByRange error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_MapDataByRange SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getManeuvers_TimeSeriesDataByRange = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_TimeSeriesDataByRange' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block

  try {
    const { class_name, project_id, desc, start_date, end_date, event_type, source_id, filters } = req.query;

    // Validate required parameters
    if (!class_name) {
      return sendResponse(res, info, 400, false, 'class_name is required', null);
    }
    if (!desc) {
      return sendResponse(res, info, 400, false, 'desc is required', null);
    }
    if (!start_date || !end_date) {
      return sendResponse(res, info, 400, false, 'start_date and end_date are required', null);
    }
    if (!event_type) {
      return sendResponse(res, info, 400, false, 'event_type is required', null);
    }

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Parse filters if provided
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Build filter WHERE clauses and parameters
      let filterClauses = [];
      let filterParams = [];

      if (filtersObj) {
        if (class_name.toUpperCase() === 'GP50') {
          // GRADE filter
          if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
            const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
            if (gradeValues.length > 0) {
              filterParams.push(gradeValues);
              filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // YEAR filter
          if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
            const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
            if (yearValues.length > 0) {
              filterParams.push(yearValues);
              filterClauses.push(`d.year_name = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // EVENT filter
          if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
            const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
            if (eventValues.length > 0) {
              const lowerEventValues = eventValues.map(e => e.toLowerCase());
              filterParams.push(lowerEventValues);
              filterClauses.push(`LOWER(d.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // CONFIG filter
          if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
            const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
            if (configValues.length > 0) {
              const lowerConfigValues = configValues.map(c => c.toLowerCase());
              filterParams.push(lowerConfigValues);
              filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // STATE filter
          if (filtersObj.STATE && Array.isArray(filtersObj.STATE) && filtersObj.STATE.length > 0) {
            const stateValues = filtersObj.STATE.map(s => String(s).trim().toUpperCase()).filter(s => s === 'H0' || s === 'H1' || s === 'H2');
            if (stateValues.length > 0) {
              filterParams.push(stateValues);
              filterClauses.push(`UPPER(b.tags->>'FOILING_STATE') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // SOURCE_NAME filter
          if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
            const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
            if (sourceValues.length > 0) {
              const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
              filterParams.push(lowerSourceValues);
              filterClauses.push(`LOWER(e.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }
        }
      }

      // Build parameters in order: project_id, event_type, start_date, end_date (if different), source_id (if provided), desc, then filters
      let params = [parseInt(project_id), event_type.toLowerCase()];
      let paramIndex = 3;

      // Build date range WHERE clause
      let dateWhereClause = '';
      if (start_date === end_date) {
        dateWhereClause = `d.date = $${paramIndex}`;
        params.push(start_date);
        paramIndex++;
      } else {
        dateWhereClause = `d.date >= $${paramIndex} AND d.date <= $${paramIndex + 1}`;
        params.push(start_date, end_date);
        paramIndex += 2;
      }

      // Add source_id filter if provided
      let sourceWhereClause = '';
      if (source_id) {
        sourceWhereClause = `AND e.source_id = $${paramIndex}`;
        params.push(parseInt(source_id));
        paramIndex++;
      }

      // Add desc parameter
      params.push(desc.toLowerCase());
      const descParamIndex = paramIndex;
      paramIndex++;

      // Replace filter placeholder with correct parameter indices
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        finalFilterClause = ' AND ' + filterClauses.join(' AND ').replace(/\$FILTER_PLACEHOLDER/g, () => {
          const currentIndex = paramIndex;
          paramIndex++;
          return `$${currentIndex}`;
        });
        params.push(...filterParams);
      }

      // WHERE conditions - only grade filter (class-specific)
      let whereConditions;
      if (class_name.toUpperCase() === 'GP50') {
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      } else {
        // Default fallback
        whereConditions = `(b.tags->>'GRADE')::int > 1`;
      }

      // Use Tws_bin column directly from table
      const twsBinExpr = `c."Tws_bin"`;

      // For GP50, filter by Tws_avg within ±2.5 of bin values instead of exact tws_bin matches
      const isGP50 = class_name.toUpperCase() === 'GP50';
      let bins = [5, 10, 15, 20, 25, 30, 35, 40, 45];

      // For GP50: filter by Tws_avg within ±2.5 of bin values, partition by calculated bin
      let twsBinWhereClause = '';
      let twsBinPartitionExpr = twsBinExpr;
      let twsBinFinalFilter = '';
      let orderByExpr = 'Q.tws_bin';

      if (isGP50) {
        // Build OR conditions for each bin: Tws_avg >= (bin - 2.5) AND Tws_avg < (bin + 2.5)
        const binConditions = bins.map(bin => {
          const minTws = bin - 2.5;
          const maxTws = bin + 2.5;
          return `(c."Tws_avg" >= ${minTws} AND c."Tws_avg" < ${maxTws})`;
        }).join(' OR ');
        twsBinWhereClause = `AND (${binConditions})`;
        // Partition by calculated bin (round to nearest multiple of 5)
        twsBinPartitionExpr = `ROUND(c."Tws_avg" / 5) * 5`;
        // Final filter also checks Tws_avg range
        twsBinFinalFilter = `AND (${binConditions.replace(/c\.\"Tws_avg\"/g, 'Q.tws_avg')})`;
        // Order by calculated bin
        orderByExpr = `ROUND(Q.tws_avg / 5) * 5`;
      }

      let filter_str = '';
      filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
        b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
        (b.tags->>'GRADE')::int "Grade", 
        b.tags->>'CONFIG' "Config", 
        b.tags->>'FOILING_STATE' "State",
        d.year_name "Year",
        d.event_name "Event",
        e.source_name "source_name"`;

      // Wrap query in subquery with window function to get top 10 per TWS bin/tack combination
      sql = `SELECT * FROM (
        SELECT 
          a.event_id "event_id",
          ${filter_str},
          c."Tws_bin" "tws_bin",
          ${isGP50 ? 'c."Tws_avg" "tws_avg",' : ''}
          c."Vmg_perc_avg" "vmg_perc_avg", 
          c."Twa_entry" "twa_entry", 
          a.json,
          CASE WHEN c."Twa_entry" > 0 THEN 1 ELSE -1 END as tack_side,
          ROW_NUMBER() OVER (
            PARTITION BY 
              ${twsBinPartitionExpr},
              (CASE WHEN c."Twa_entry" > 0 THEN 1 ELSE -1 END)
            ORDER BY c."Vmg_perc_avg" DESC
          ) as row_num
        FROM ${class_name}.events_timeseries a 
        inner join ${class_name}.dataset_events b on a.event_id = b.event_id 
        inner join ${class_name}.maneuver_stats c on b.event_id = c.event_id 
        inner join ${class_name}.datasets d on b.dataset_id = d.dataset_id
        inner join ${class_name}.sources e on d.source_id = e.source_id
        where e.project_id = $1
        and d.visible = 1
        and lower(b.event_type) = lower($2)
        and ${dateWhereClause}
        and LOWER(a.description) = LOWER($${descParamIndex})
        and ${whereConditions}
        ${sourceWhereClause}
        ${finalFilterClause}
        ${twsBinWhereClause}
      ) Q
      WHERE Q.row_num <= 10
      ${twsBinFinalFilter}
      ORDER BY ${orderByExpr}, Q.tack_side, Q."vmg_perc_avg" DESC`;

      console.log('getManeuvers_TimeSeriesDataByRange', Date.now(), sql.substring(0, 200) + '...', params.length + ' params');

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuvers_TimeSeriesDataByRange error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_TimeSeriesDataByRange error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_TimeSeriesDataByRange SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve all classes
exports.getFleetManeuvers_TableData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getFleetManeuvers_TableData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block

  try {
    const { class_name, project_id, source_id, date, event_type, channels } = req.query;

    // Validate required parameters
    if (!class_name) {
      return sendResponse(res, info, 400, false, 'class_name is required', null);
    }
    if (!source_id) {
      return sendResponse(res, info, 400, false, 'source_id is required', null);
    }
    if (!date) {
      return sendResponse(res, info, 400, false, 'date is required', null);
    }
    if (!event_type) {
      return sendResponse(res, info, 400, false, 'event_type is required', null);
    }

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Sanitize channels - sanitizeChannelNames expects a JSON string
      let safeChannels = [];
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      const eventTypeLower = (event_type || '').toLowerCase();

      const toDbColumnName = (channelName) => {
        if (!channelName || channelName.length === 0) return channelName;
        const normalized = channelName.toLowerCase();
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      };

      const TAKEOFF_CHANNEL_DB_COLUMNS_FLEET = {
        tws_avg: 'Tws_avg',
        mmg: 'Mmg',
        vmg_perc_avg: 'Vmg_perc_avg',
        bsp_start: 'Bsp_start',
        twa_build: 'Twa_build',
        time_accel: 'Time_accel',
        exit_time: 'Exit_time',
        bsp_exit: 'Bsp_exit',
        twa_exit: 'Twa_exit',
        cant_accmax: 'Cant_accmax',
        pitch_accmax: 'Pitch_accmax',
        heel_accmax: 'Heel_accmax',
        jib_sheet_pct_accmax: 'Jib_sheet_pct_accmax',
        jib_lead_ang_accmax: 'Jib_lead_ang_accmax',
        jib_cunno_load_accmax: 'Jib_cunno_load_accmax',
        wing_clew_pos_accmax: 'Wing_clew_pos_accmax',
        wing_twist_accmax: 'Wing_twist_accmax',
        rud_rake_accmax: 'Rud_rake_accmax',
        rud_diff_accmax: 'Rud_diff_accmax',
        wing_ca1_accmax: 'Wing_ca1_accmax',
        rake_accmax: 'Rake_accmax'
      };

      // Build channels string - prefix each channel with "a." and handle special cases
      let channelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();
        if (channelLower === 'tws_bin') {
          channelFields.push(`a."Tws_bin" "tws_bin"`);
        } else if (channelLower === 'twa_entry_n') {
          if (eventTypeLower === 'takeoff') {
            channelFields.push(`abs(a."Twa_start") "twa_entry_n"`);
          } else {
            channelFields.push(`abs(a."Twa_entry") "twa_entry_n"`);
          }
        } else if (channelLower === 'twa_exit_n') {
          channelFields.push(`abs(a."Twa_exit") "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          channelFields.push(`abs(a."Twa_build") "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          channelFields.push(`abs(a."Twa_drop") "twa_drop_n"`);
        } else if (channelLower === 'twa_entry' && eventTypeLower === 'takeoff') {
          channelFields.push(`a."Twa_start" as "twa_entry"`);
        } else if (eventTypeLower === 'takeoff' && TAKEOFF_CHANNEL_DB_COLUMNS_FLEET[channelLower]) {
          const dbCol = TAKEOFF_CHANNEL_DB_COLUMNS_FLEET[channelLower];
          channelFields.push(`a."${dbCol}" "${channelLower}"`);
        } else {
          const dbColumnName = toDbColumnName(channelLower);
          channelFields.push(`a."${dbColumnName}" "${channelLower}"`);
        }
      });
      const channelStr = channelFields.join(', ');

      let filter_str = '';
      filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
        b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
        (b.tags->>'GRADE')::int "Grade", 
        b.tags->>'CONFIG' "Config", 
        b.tags->>'FOILING_STATE' "State",
        c.year_name "Year",
        c.event_name "Event",
        d.source_name "source_name"`;

      let params = [source_id, date, event_type];
      // Datetime in UTC; clients use row timezone for display
      sql = `SELECT 
          a.event_id "event_id", 
          ${formatDatetimeUTC('a."Datetime"', '"Datetime"')},
          c.timezone AS "timezone",
          ${filter_str},
          ${channelStr}
        FROM ${class_name}.maneuver_stats a 
        inner join ${class_name}.dataset_events b on a.event_id = b.event_id 
        inner join ${class_name}.datasets c on b.dataset_id = c.dataset_id 
        inner join ${class_name}.sources d on c.source_id = d.source_id
        where d.source_id = $1 and c.date = $2 and lower(b.event_type) = lower($3)
        order by a."Vmg_perc_avg" desc LIMIT 10`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        console.log('getFleetManeuvers_TableData', Date.now(), sql, params);
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('getFleetManeuvers_TableData error:', error);
    if (error && error.stack) {
      console.error('getFleetManeuvers_TableData error stack:', error.stack);
    }
    if (sql) {
      console.error('getFleetManeuvers_TableData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getChannels = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getChannels' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, table_name } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Restrict table updates to specified tables
      const allowedTables = ['events_aggregate', 'events_cloud', 'maneuver_stats'];
      if (!allowedTables.includes(table_name)) {
        return sendResponse(res, info, 400, false, 'Table not allowed', null, true);
      }

      let params = [class_name, table_name];
      let sql = `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 and table_name = $2 and column_name not in ('agr_id', 'obs_id', 'event_id', 'agr_type', 'tag');`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No channels found', null);
      }

    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getPerformanceData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getPerformanceData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, start_date, end_date, event_type, agr_type, channels, filters } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      if (channels && channels.length > 0) {
        let safeChannels = sanitizeChannelNames(channels)

        if (safeChannels.length === 0) {
          return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
        }

        // Build channel_str with table prefix for proper column references
        // For Twa_deg, use subquery to get from AVG aggregate when querying STD/AAV
        // Also ensure Twa_deg is included for STD/AAV even if not in channel list (needed for classification)
        let channel_str = safeChannels.map(ch => {
          if (ch === 'Twa_deg' && agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE') {
            return `(SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1) AS "Twa_deg"`;
          }
          return `a."${ch}"`;
        }).join(', ');

        // For STD/AAV aggregates, ensure Twa_deg is included if not already in channel list
        if (agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE') {
          const hasTwaDeg = safeChannels.some(ch => ch === 'Twa_deg');
          if (!hasTwaDeg) {
            channel_str += `, (SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1) AS "Twa_deg"`;
          }
        }

        // Parse filters if provided
        let filtersObj = null;
        if (filters) {
          try {
            filtersObj = JSON.parse(filters);
          } catch (e) {
            return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
          }
        }

        // Build filter WHERE clauses and parameters - class-specific for this query
        let filterClauses = [];
        let filterParams = [];

        if (filtersObj) {
          if (class_name.toUpperCase() === 'GP50') {
            // GRADE filter: Check GRADE in the event's own tags
            if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
              const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
              if (gradeValues.length > 0) {
                filterParams.push(gradeValues);
                filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
              }
            }

            // YEAR filter: Filter on datasets.year_name
            if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
              const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
              if (yearValues.length > 0) {
                filterParams.push(yearValues);
                filterClauses.push(`c.year_name = ANY($FILTER_PLACEHOLDER)`);
              }
            }

            // EVENT filter: Filter on datasets.event_name (case-insensitive)
            if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
              const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
              if (eventValues.length > 0) {
                const lowerEventValues = eventValues.map(e => e.toLowerCase());
                filterParams.push(lowerEventValues);
                filterClauses.push(`LOWER(c.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
              }
            }

            // CONFIG filter: Filter on dataset_events.tags->>'CONFIG' (case-insensitive)
            if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
              const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
              if (configValues.length > 0) {
                const lowerConfigValues = configValues.map(c => c.toLowerCase());
                filterParams.push(lowerConfigValues);
                filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
              }
            }

            // SOURCE_NAME filter: Filter on source_name (case-insensitive) - align with getFleetPerformanceData
            if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
              const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
              if (sourceValues.length > 0) {
                const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
                filterParams.push(lowerSourceValues);
                filterClauses.push(`LOWER(d.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
              }
            }

            // NOTE: STATE filter is intentionally NOT applied at API level
            // STATE filtering is handled client-side for better cache efficiency
            // STATE values are still returned in the response for client-side filtering
          }
          // Add more class-specific filter logic here as needed
        }

        // Combine filter clauses
        const filterWhereClause = filterClauses.length > 0 ? ' AND ' + filterClauses.join(' AND ') : '';

        let params = [];
        let sql = '';
        let baseParamCount = 0;

        // Build filter SELECT fields - class-specific for this query structure
        let filter_str;
        filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
          b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
          (b.tags->>'GRADE')::int "Grade", 
          b.tags->>'CONFIG' "Config", 
          b.tags->>'FOILING_STATE' "State",
          c.year_name "Year",
          c.event_name "Event",
          d.source_name "source_name"`;

        // Datetime in UTC; clients use row timezone for display
        const datetimeExpr = formatDatetimeUTC('a."Datetime"', '"Datetime"');

        // Twa_deg_avg is metadata - always from AVG aggregate type, used for filtering and TACK
        // Twa_deg remains the actual data field for the queried aggregate type (AVG, STD, AAV)
        // Use subquery to get Twa_deg from AVG aggregate
        const twaAvgExpr = agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE'
          ? `(SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1)`
          : 'a."Twa_deg"';

        // Build select_str with TACK metadata for aggregate queries, without for cloud queries
        let select_str_aggregate = `select a.event_id "event_id", c.dataset_id, d.source_id, d.project_id, ${datetimeExpr},
          ${filter_str},
          c.timezone AS "timezone",
          CASE WHEN ${twaAvgExpr} > 0 THEN 'STBD' ELSE 'PORT' END AS "Tack",
          CASE 
            WHEN abs(${twaAvgExpr}) < 75 THEN 'UPWIND'
            WHEN abs(${twaAvgExpr}) > 120 THEN 'DOWNWIND'
            ELSE 'REACHING'
          END AS "PointofSail",
          ${twaAvgExpr} AS "Twa_deg_avg",
          ${channel_str}`;

        let select_str_cloud = `select a.event_id "event_id", c.dataset_id, d.source_id, d.project_id, ${datetimeExpr},
          ${filter_str},
          c.timezone AS "timezone",
          ${channel_str}`;

        if (agr_type != 'NONE') {
          if (start_date == end_date) {
            baseParamCount = 4; // source_id, start_date, event_type, agr_type
            params = [source_id, start_date, event_type, agr_type, ...filterParams];
            sql = `${select_str_aggregate} 
              FROM ${class_name}.events_aggregate a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE d.source_id = $1 
              AND c.date = $2
              AND lower(b.event_type) = lower($3)
              AND lower(a.agr_type) = lower($4)
              AND c.visible = 1
              ${filterWhereClause}`;
          } else {
            baseParamCount = 5; // source_id, start_date, end_date, event_type, agr_type
            params = [source_id, start_date, end_date, event_type, agr_type, ...filterParams];
            sql = `${select_str_aggregate} 
              FROM ${class_name}.events_aggregate a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE d.source_id = $1 
              AND c.date > $2
              AND c.date <= $3
              AND lower(b.event_type) = lower($4)
              AND lower(a.agr_type) = lower($5)
              AND c.visible = 1
              ${filterWhereClause}`;
          }
        } else {
          if (start_date == end_date) {
            baseParamCount = 3; // source_id, start_date, event_type
            params = [source_id, start_date, event_type, ...filterParams]
            sql = `${select_str_cloud} 
              FROM ${class_name}.events_cloud a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE d.source_id = $1 
              AND c.date = $2
              AND lower(b.event_type) = lower($3)
              AND c.visible = 1
              ${filterWhereClause}`;
          } else {
            baseParamCount = 4; // source_id, start_date, end_date, event_type
            params = [source_id, start_date, end_date, event_type, ...filterParams];
            sql = `${select_str_cloud} 
              FROM ${class_name}.events_cloud a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE d.source_id = $1 
              AND c.date > $2
              AND c.date <= $3
              AND lower(b.event_type) = lower($4)
              AND c.visible = 1
              ${filterWhereClause}`;
          }
        }

        // Fix parameter placeholders in filter clauses
        if (filterClauses.length > 0) {
          let paramIndex = baseParamCount + 1;
          // Replace each $FILTER_PLACEHOLDER with the correct parameter number
          sql = sql.replace(/\$FILTER_PLACEHOLDER/g, () => `$${paramIndex++}`);
        }

        console.log('sql', sql, params)

        let rows = await db.GetRows(sql, params);

        // Debug: Log first row to see what columns are returned
        if (rows && rows.length > 0) {
          console.log('[getPerformanceData] First row sample:', {
            event_id: rows[0].event_id,
            Twa_deg_avg: rows[0].Twa_deg_avg ?? rows[0].twa_deg_avg,
            Twa_deg: rows[0].Twa_deg ?? rows[0].twa_deg,
            Tack: rows[0].Tack ?? rows[0].tack,
            allKeys: Object.keys(rows[0]).slice(0, 30)
          });
        }

        if (rows) {
          return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
        } else {
          console.log('performance data', Date.now(), sql, params);
          return sendResponse(res, info, 204, false, 'No data found', null);
        }
      } else {
        return sendResponse(res, info, 404, false, 'No valid channels provided', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('[getPerformanceData] error:', error);
    if (error && error.stack) {
      console.error('[getPerformanceData] error stack:', error.stack);
    }
    if (sql) {
      console.error('[getPerformanceData] SQL:', sql);
    }
    if (params) {
      console.error('[getPerformanceData] Params:', params);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getFleetPerformanceData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getFleetPerformanceData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = ''; // Declare sql here to be accessible in catch block
  let params = []; // Declare params here to be accessible in catch block

  try {
    const { class_name, project_id, start_date, end_date, event_type, agr_type, channels, filters } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Sanitize channels - sanitizeChannelNames expects a JSON string
      let safeChannels = [];
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      // Build channel_str with table prefix for proper column references
      // For Twa_deg, use subquery to get from AVG aggregate when querying STD/AAV
      // Also ensure Twa_deg is included for STD/AAV even if not in channel list (needed for classification)
      let channel_str = safeChannels.map(ch => {
        if (ch === 'Twa_deg' && agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE') {
          return `(SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1) AS "Twa_deg"`;
        }
        return `a."${ch}"`;
      }).join(', ');

      // For STD/AAV aggregates, ensure Twa_deg is included if not already in channel list
      if (agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE') {
        const hasTwaDeg = safeChannels.some(ch => ch === 'Twa_deg');
        if (!hasTwaDeg) {
          channel_str += `, (SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1) AS "Twa_deg"`;
        }
      }

      // Parse filters if provided
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Build filter WHERE clauses and parameters - class-specific for this query
      let filterClauses = [];
      let filterParams = [];

      if (filtersObj) {
        if (class_name.toUpperCase() === 'GP50') {
          // GRADE filter: Check GRADE in the event's own tags
          if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
            const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
            if (gradeValues.length > 0) {
              filterParams.push(gradeValues);
              filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // YEAR filter: Filter on datasets.year_name
          if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
            const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
            if (yearValues.length > 0) {
              filterParams.push(yearValues);
              filterClauses.push(`c.year_name = ANY($FILTER_PLACEHOLDER)`);
            }
          }

          // EVENT filter: Filter on datasets.event_name (case-insensitive)
          if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
            const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
            if (eventValues.length > 0) {
              const lowerEventValues = eventValues.map(e => e.toLowerCase());
              filterParams.push(lowerEventValues);
              filterClauses.push(`LOWER(c.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // CONFIG filter: Filter on dataset_events.tags->>'CONFIG' (case-insensitive)
          if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
            const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
            if (configValues.length > 0) {
              const lowerConfigValues = configValues.map(c => c.toLowerCase());
              filterParams.push(lowerConfigValues);
              filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // SOURCE_NAME filter: Filter on source_name (case-insensitive)
          if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
            const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
            if (sourceValues.length > 0) {
              const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
              filterParams.push(lowerSourceValues);
              filterClauses.push(`LOWER(d.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
            }
          }

          // NOTE: STATE filter is intentionally NOT applied at API level
          // STATE filtering is handled client-side for better cache efficiency
          // STATE values are still returned in the response for client-side filtering
        }
        // Add more class-specific filter logic here as needed
      }

      // Combine filter clauses
      const filterWhereClause = filterClauses.length > 0 ? ' AND ' + filterClauses.join(' AND ') : '';

      let baseParamCount = 0;

      // Build filter SELECT fields - class-specific for this query structure
      let filter_str;
      filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
          b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
          (b.tags->>'GRADE')::int "Grade", 
          b.tags->>'CONFIG' "Config", 
          b.tags->>'FOILING_STATE' "State",
          c.year_name "Year",
          c.event_name "Event",
          d.source_name "source_name"`;

      // Datetime in UTC; clients use row timezone for display
      const datetimeExpr = formatDatetimeUTC('a."Datetime"', '"Datetime"');

      // Twa_deg_avg is metadata - always from AVG aggregate type, used for filtering and TACK
      // Twa_deg remains the actual data field for the queried aggregate type (AVG, STD, AAV)
      // Use subquery to get Twa_deg from AVG aggregate
      const twaAvgExpr = agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE'
        ? `(SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1)`
        : 'a."Twa_deg"';

      let select_str = `select a.event_id "event_id", c.dataset_id, d.source_id, d.project_id, ${datetimeExpr},
          ${filter_str},
          c.timezone AS "timezone",
          CASE WHEN ${twaAvgExpr} > 0 THEN 'STBD' ELSE 'PORT' END AS "Tack",
          CASE 
            WHEN abs(${twaAvgExpr}) < 75 THEN 'UPWIND'
            WHEN abs(${twaAvgExpr}) > 120 THEN 'DOWNWIND'
            ELSE 'REACHING'
          END AS "PointofSail",
          ${twaAvgExpr} AS "Twa_deg_avg",
          ${channel_str}`

      if (agr_type != 'NONE') {
        if (start_date == end_date) {
          baseParamCount = 4; // start_date, event_type, agr_type, project_id
          params = [start_date, event_type, agr_type, project_id, ...filterParams];
          sql = `${select_str}  
              FROM ${class_name}.events_aggregate a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE c.date = $1 and lower(b.event_type) = lower($2) and lower(a.agr_type) = lower($3) and d.project_id = $4 and c.visible = 1
              ${filterWhereClause}`;
        } else {
          baseParamCount = 5; // start_date, end_date, event_type, agr_type, project_id
          params = [start_date, end_date, event_type, agr_type, project_id, ...filterParams];
          sql = `${select_str}  
              FROM ${class_name}.events_aggregate a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE c.date > $1 and c.date <= $2 and lower(b.event_type) = lower($3) and lower(a.agr_type) = lower($4) and d.project_id = $5 and c.visible = 1
              ${filterWhereClause}`;
        }
      } else {
        if (start_date == end_date) {
          baseParamCount = 3; // start_date, event_type, project_id
          params = [start_date, event_type, project_id, ...filterParams];
          sql = `${select_str} 
              FROM ${class_name}.events_cloud a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE c.date = $1 and lower(b.event_type) = lower($2) and d.project_id = $3 and c.visible = 1${filterWhereClause}`;
        } else {
          baseParamCount = 4; // start_date, end_date, event_type, project_id
          params = [start_date, end_date, event_type, project_id, ...filterParams];
          sql = `${select_str}  
              FROM ${class_name}.events_cloud a 
              INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
              INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
              INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
              WHERE c.date > $1 and c.date <= $2 and lower(b.event_type) = lower($3) and d.project_id = $4 and c.visible = 1
              ${filterWhereClause}`;
        }
      }

      // Replace placeholder with correct parameter indices
      if (filterClauses.length > 0) {
        let paramIndex = baseParamCount + 1;
        sql = sql.replace(/\$FILTER_PLACEHOLDER/g, () => `$${paramIndex++}`);
      }

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        console.log('[getFleetPerformanceData] No data found. Full SQL:', sql);
        console.log('[getFleetPerformanceData] Params:', params);
        return sendResponse(res, info, 204, false, 'No data found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    // Explicitly log unexpected errors so they appear in server logs
    console.error('[getFleetPerformanceData] error:', error);
    if (error && error.stack) {
      console.error('[getFleetPerformanceData] error stack:', error.stack);
    }
    if (sql) {
      console.error('[getFleetPerformanceData] SQL:', sql);
    }
    if (params) {
      console.error('[getFleetPerformanceData] Params:', params);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getSharedCloudData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getHistoricalCloudData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, source_id, table_name, event_type, agr_type, start_date, end_date, channels, filters } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      if (channels && channels.length > 0) {
        let safeChannels = sanitizeChannelNames(channels)

        if (safeChannels.length === 0) {
          return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
        }

        let channel_str = listtostring(safeChannels)

        // Parse filters if provided
        let filtersObj = null;
        if (filters) {
          try {
            filtersObj = JSON.parse(filters);
          } catch (e) {
            return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
          }
        }

        // Build filter WHERE clauses and parameters - class-specific for this query
        let filterClauses = [];
        let filterParams = [];

        if (filtersObj) {
          if (class_name.toUpperCase() === 'GP50') {
            // GRADE filter: Check GRADE in the event's own tags
            if (filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0) {
              const gradeValues = filtersObj.GRADE.map(g => parseInt(g)).filter(g => !isNaN(g) && g >= 0 && g <= 5);
              if (gradeValues.length > 0) {
                filterParams.push(gradeValues);
                filterClauses.push(`(b.tags->>'GRADE')::int = ANY($FILTER_PLACEHOLDER)`);
              }
            }

            // YEAR filter: Filter on datasets.year_name
            if (filtersObj.YEAR && Array.isArray(filtersObj.YEAR) && filtersObj.YEAR.length > 0) {
              const yearValues = filtersObj.YEAR.map(y => parseInt(y)).filter(y => !isNaN(y));
              if (yearValues.length > 0) {
                filterParams.push(yearValues);
                filterClauses.push(`c.year_name = ANY($FILTER_PLACEHOLDER)`);
              }
            }

            // EVENT filter: Filter on datasets.event_name (case-insensitive)
            if (filtersObj.EVENT && Array.isArray(filtersObj.EVENT) && filtersObj.EVENT.length > 0) {
              const eventValues = filtersObj.EVENT.map(e => String(e).trim()).filter(e => e.length > 0);
              if (eventValues.length > 0) {
                const lowerEventValues = eventValues.map(e => e.toLowerCase());
                filterParams.push(lowerEventValues);
                filterClauses.push(`LOWER(c.event_name) = ANY($FILTER_PLACEHOLDER::text[])`);
              }
            }

            // CONFIG filter: Filter on dataset_events.tags->>'CONFIG' (case-insensitive)
            if (filtersObj.CONFIG && Array.isArray(filtersObj.CONFIG) && filtersObj.CONFIG.length > 0) {
              const configValues = filtersObj.CONFIG.map(c => String(c).trim()).filter(c => c.length > 0);
              if (configValues.length > 0) {
                const lowerConfigValues = configValues.map(c => c.toLowerCase());
                filterParams.push(lowerConfigValues);
                filterClauses.push(`LOWER(b.tags->>'CONFIG') = ANY($FILTER_PLACEHOLDER::text[])`);
              }
            }

            // SOURCE_NAME filter: Filter on source_name (case-insensitive)
            if (filtersObj.SOURCE_NAME && Array.isArray(filtersObj.SOURCE_NAME) && filtersObj.SOURCE_NAME.length > 0) {
              const sourceValues = filtersObj.SOURCE_NAME.map(s => String(s).trim()).filter(s => s.length > 0);
              if (sourceValues.length > 0) {
                const lowerSourceValues = sourceValues.map(s => s.toLowerCase());
                filterParams.push(lowerSourceValues);
                filterClauses.push(`LOWER(d.source_name) = ANY($FILTER_PLACEHOLDER::text[])`);
              }
            }
          }
          // Add more class-specific filter logic here as needed
        }

        // Combine filter clause
        const filterWhereClause = filterClauses.length > 0 ? ' AND ' + filterClauses.join(' AND ') : '';

        let params = [];
        let sql = "";
        let baseParamCount = 0;

        // Build filter SELECT fields - class-specific for this query structure
        let filter_str;
        filter_str = `b.tags -> 'RACES' ->> 'Race_number' "Race_number",
          b.tags -> 'RACES' ->> 'Leg_number' "Leg_number",
          (b.tags->>'GRADE')::int "Grade", 
          b.tags->>'CONFIG' "Config", 
          b.tags->>'FOILING_STATE' "State",
          c.year_name "Year",
          c.event_name "Event",
          d.source_name "source_name"`;

        // Twa_deg_avg is metadata - always from AVG aggregate type, used for filtering and TACK
        // Twa_deg remains the actual data field for the queried aggregate type (AVG, STD, AAV)
        // Use subquery to get Twa_deg from AVG aggregate
        const twaAvgExpr = agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE'
          ? `(SELECT avg_sub."Twa_deg" FROM ${class_name}.events_aggregate avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1)`
          : 'a."Twa_deg"';

        // Build select_str with TACK metadata for aggregate queries, without for cloud queries
        let select_str_aggregate = `select a.event_id "event_id", c.dataset_id, d.source_id, d.project_id, cast(a."Datetime" as text) "Datetime",
          ${filter_str},
          CASE WHEN ${twaAvgExpr} > 0 THEN 'STBD' ELSE 'PORT' END AS "Tack",
          CASE 
            WHEN abs(${twaAvgExpr}) < 75 THEN 'UPWIND'
            WHEN abs(${twaAvgExpr}) > 120 THEN 'DOWNWIND'
            ELSE 'REACHING'
          END AS "PointofSail",
          ${twaAvgExpr} AS "Twa_deg_avg",
          ${channel_str}`;

        let select_str_cloud = `select a.event_id "event_id", c.dataset_id, d.source_id, d.project_id, cast(a."Datetime" as text) "Datetime",
          ${filter_str},
          ${channel_str}`;

        if (table_name == 'events_aggregate') {
          if (source_id > 0) {
            // Handle same-day queries (start_date == end_date) with equality check
            if (start_date == end_date) {
              baseParamCount = 5; // project_id, source_id, event_type, start_date, agr_type
              params = [project_id, source_id, event_type, start_date, agr_type, ...filterParams];
              sql = `${select_str_aggregate} 
                FROM ${class_name}.events_aggregate a 
                INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
                INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
                INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
                WHERE c.date = $4 and lower(b.event_type) = lower($3) and lower(a.agr_type) = lower($5)
                and d.source_id != $2 and (d.project_id = $1 or c.shared = 1)
                ${filterWhereClause}`;
            } else {
              baseParamCount = 6; // project_id, source_id, event_type, start_date, end_date, agr_type
              params = [project_id, source_id, event_type, start_date, end_date, agr_type, ...filterParams];
              sql = `${select_str_aggregate} 
                FROM ${class_name}.events_aggregate a 
                INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
                INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
                INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
                WHERE c.date > $4 and c.date <= $5 and lower(b.event_type) = lower($3) and lower(a.agr_type) = lower($6)
                and d.source_id != $2 and (d.project_id = $1 or c.shared = 1)
                ${filterWhereClause}`;
            }
          } else {
            if (agr_type != 'NONE') {
              baseParamCount = 5; // project_id, event_type, start_date, end_date, agr_type
              params = [project_id, event_type, start_date, end_date, agr_type, ...filterParams];
              sql = `${select_str_aggregate}  
                FROM ${class_name}.events_aggregate a 
                INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
                INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
                INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
                WHERE c.date > $3 and c.date <= $4 and lower(b.event_type) = lower($2) and lower(a.agr_type) = lower($5)
                and (d.project_id = $1 or c.shared = 1)
                ${filterWhereClause}`;
            } else {
              baseParamCount = 3; // project_id, event_type, start_date
              params = [project_id, event_type, start_date, ...filterParams];
              sql = `${select_str_cloud}  
                FROM ${class_name}.events_cloud a 
                INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
                INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
                INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
                WHERE c.date = $3 and lower(b.event_type) = lower($2)
                and (d.project_id = $1 or c.shared = 1)
                ${filterWhereClause}`;
            }
          }
        } else {
          baseParamCount = 5; // project_id, source_id, event_type, start_date, end_date
          params = [project_id, source_id, event_type, start_date, end_date, ...filterParams];
          sql = `${select_str_cloud} 
            FROM ${class_name}.maneuver_stats a 
            INNER JOIN ${class_name}.dataset_events b on a.event_id = b.event_id 
            INNER JOIN ${class_name}.datasets c on b.dataset_id = c.dataset_id
            INNER JOIN ${class_name}.sources d on c.source_id = d.source_id
            WHERE c.date > $4 and c.date <= $5 and lower(b.event_type) = lower($3)
            and d.source_id != $2 and (d.project_id = $1 or c.shared = 1)
            ${filterWhereClause}`;
        }

        // Replace placeholder with correct parameter indices
        if (filterClauses.length > 0) {
          let paramIndex = baseParamCount + 1;
          sql = sql.replace(/\$FILTER_PLACEHOLDER/g, () => `$${paramIndex++}`);
        }

        let rows = await db.GetRows(sql, params);

        if (rows) {
          return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
        } else {
          console.log('shared cloud data', Date.now(), sql, params);
          return sendResponse(res, info, 204, false, 'No data found', null);
        }
      } else {
        return sendResponse(res, info, 404, false, 'No valid channels provided', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

exports.getAggregateData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getAggregateData' }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, dataset_id, table_name, event_type, agr_type, channels } = req.query;

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      if (channels && channels.length > 0) {
        let safeChannels = sanitizeChannelNames(channels)

        if (safeChannels.length === 0) {
          return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
        }

        // Build filter SELECT fields - class-specific for this query structure
        let filter_str;
        filter_str = `b.tags -> 'RACES' ->> 'Race_number' AS "Race_number",
          b.tags -> 'RACES' ->> 'Leg_number' AS "Leg_number",
          (b.tags->>'GRADE')::int "Grade", 
          b.tags ->> 'CONFIG' AS "Config",
          b.tags->>'FOILING_STATE' "State"`;

        let params = [dataset_id, event_type, agr_type];

        // Always use Twa_deg from AVG aggregate type for TACK calculation
        // This ensures correct port/stbd coloring for STD and AAV aggregate types
        // Use subquery to get Twa_deg from AVG aggregate
        const twaAvgExpr = agr_type && agr_type.toUpperCase() !== 'AVG' && agr_type.toUpperCase() !== 'NONE'
          ? `(SELECT avg_sub."Twa_deg" FROM ${class_name}.${table_name} avg_sub WHERE avg_sub.event_id = a.event_id AND lower(avg_sub.agr_type) = 'avg' LIMIT 1)`
          : 'a."Twa_deg"';

        // Twa_deg_avg is metadata - always from AVG aggregate type, used for filtering and TACK
        // Twa_deg remains the actual data field for the queried aggregate type (AVG, STD, AAV)
        // This allows querying STD/AAV Twa_deg while still having AVG Twa_deg for metadata purposes
        // Select Twa_deg_avg BEFORE a.* to ensure it's included and not overwritten
        let sql = `SELECT sub.* FROM (
            SELECT 
              ${filter_str},
              b.duration,
              c.timezone AS "timezone",
              CASE WHEN ${twaAvgExpr} > 0 THEN 'STBD' ELSE 'PORT' END AS "Tack",
              CASE 
                WHEN abs(${twaAvgExpr}) < 75 THEN 'UPWIND'
                WHEN abs(${twaAvgExpr}) > 120 THEN 'DOWNWIND'
                ELSE 'REACHING'
              END AS "PointofSail",
              ${twaAvgExpr} AS "Twa_deg_avg",
              a.*
            FROM ${class_name}.${table_name} a
            INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id
            INNER JOIN ${class_name}.datasets c ON b.dataset_id = c.dataset_id
            WHERE b.dataset_id = $1 AND lower(b.event_type) = lower($2) AND lower(a.agr_type) = lower($3)
          ) sub
          ORDER BY sub."event_id"`;

        let rows = await db.GetRows(sql, params);

        if (rows) {
          return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
        } else {
          console.log('aggregate data', Date.now(), sql, params);
          return sendResponse(res, info, 204, false, 'No data found', null);
        }
      } else {
        return sendResponse(res, info, 404, false, 'No valid channels provided', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// ============================================================================
// NEW SIMPLIFIED MANEUVER API ENDPOINTS
// ============================================================================

/**
 * History query: Get top N maneuvers per tack per source per wind speed bin
 * Returns table data from maneuver_stats
 */
exports.getManeuversHistory_TableData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuversHistory_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = '';

  try {
    const { class_name, project_id, source_names, start_date, end_date, event_type, channels, filters, count = 5 } = req.query;

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Validate that source_names is provided
      if (!source_names) {
        return sendResponse(res, info, 400, false, 'source_names is required', null);
      }

      // Sanitize channels
      let safeChannels = [];
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      const eventTypeLower = event_type.toLowerCase();
      const countNum = parseInt(count) || 5;

      // TAKEOFF-specific channel -> DB column mapping (same as getDatasetManeuvers_TableData)
      const TAKEOFF_CHANNEL_DB_COLUMNS_HISTORY = {
        tws_avg: 'Tws_avg',
        mmg: 'Mmg',
        vmg_perc_avg: 'Vmg_perc_avg',
        loss_total_tgt: 'Loss_total_tgt',
        bsp_start: 'Bsp_start',
        twa_build: 'Twa_build',
        time_accel: 'Time_accel',
        exit_time: 'Exit_time',
        bsp_exit: 'Bsp_exit',
        twa_exit: 'Twa_exit',
        cant_accmax: 'Cant_accmax',
        pitch_accmax: 'Pitch_accmax',
        heel_accmax: 'Heel_accmax',
        jib_sheet_pct_accmax: 'Jib_sheet_pct_accmax',
        jib_lead_ang_accmax: 'Jib_lead_ang_accmax',
        jib_cunno_load_accmax: 'Jib_cunno_load_accmax',
        wing_clew_pos_accmax: 'Wing_clew_pos_accmax',
        wing_twist_accmax: 'Wing_twist_accmax',
        rud_rake_accmax: 'Rud_rake_accmax',
        rud_diff_accmax: 'Rud_diff_accmax',
        wing_ca1_accmax: 'Wing_ca1_accmax',
        rake_accmax: 'Rake_accmax'
      };

      // Build channels string
      let channelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();
        if (channelLower === 'tws_bin') {
          channelFields.push(`a."Tws_bin" "tws_bin"`);
        } else if (channelLower === 'twa_entry_n') {
          if (eventTypeLower === 'takeoff') {
            channelFields.push(`abs(a."Twa_start") "twa_entry_n"`);
          } else {
            channelFields.push(`abs(a."Twa_entry") "twa_entry_n"`);
          }
        } else if (channelLower === 'twa_exit_n') {
          channelFields.push(`abs(a."Twa_exit") "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          channelFields.push(`abs(a."Twa_build") "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          channelFields.push(`abs(a."Twa_drop") "twa_drop_n"`);
        } else if (channelLower === 'twa_entry' && eventTypeLower === 'takeoff') {
          channelFields.push(`a."Twa_start" as "twa_entry"`);
        } else if (channelLower === 'loss_inv_avg') {
          channelFields.push(`a."Loss_inv_vmg" "loss_inv_avg"`);
        } else if (channelLower === 'loss_turn_avg') {
          channelFields.push(`a."Loss_turn_vmg" "loss_turn_avg"`);
        } else if (channelLower === 'loss_build_avg') {
          channelFields.push(`a."Loss_build_vmg" "loss_build_avg"`);
        } else if (channelLower === 'loss_total_avg') {
          channelFields.push(`a."Loss_total_vmg" "loss_total_avg"`);
        } else if (channelLower === 'bsp_drop') {
          channelFields.push(`a."Bsp_drop" "bsp_drop"`);
        } else if (channelLower === 'drop_time') {
          channelFields.push(`a."Drop_time" "drop_time"`);
        } else if (eventTypeLower === 'takeoff' && TAKEOFF_CHANNEL_DB_COLUMNS_HISTORY[channelLower]) {
          const dbCol = TAKEOFF_CHANNEL_DB_COLUMNS_HISTORY[channelLower];
          channelFields.push(`a."${dbCol}" "${channelLower}"`);
        } else if (eventTypeLower === 'takeoff') {
          // TAKEOFF maneuver_stats may not have tack/gybe columns; return NULL so the query does not fail
          channelFields.push(`NULL AS "${channelLower}"`);
        } else {
          const dbColumnName = channelLower.charAt(0).toUpperCase() + channelLower.slice(1);
          channelFields.push(`a."${dbColumnName}" "${channelLower}"`);
        }
      });
      const channelStr = channelFields.join(', ');

      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Parse source_names (required)
      let sourceNamesList = null;
      try {
        sourceNamesList = JSON.parse(source_names);
        if (!Array.isArray(sourceNamesList)) {
          return sendResponse(res, info, 400, false, 'source_names must be a JSON array', null);
        }
        // Normalize to lowercase for case-insensitive matching
        sourceNamesList = sourceNamesList.map(name => String(name).trim().toLowerCase()).filter(name => name.length > 0);
        if (sourceNamesList.length === 0) {
          return sendResponse(res, info, 400, false, 'source_names must contain at least one valid source name', null);
        }
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid source_names JSON', null);
      }

      // Build filters (history type - includes YEAR, EVENT, CONFIG)
      // Note: SOURCE_NAME filter in filtersObj will be handled by buildManeuverFilters
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, true, 'b', 'c', 'd');

      // For takeoff, twa_entry in maneuver_stats comes from Twa_start
      const twaEntryCol = eventTypeLower === 'takeoff' ? 'a."Twa_start"' : 'a."Twa_entry"';

      // Build source filter clause
      let baseParams = [parseInt(project_id), event_type];
      let paramIndex = 3;
      const sourceWhereClause = `AND LOWER(d.source_name) = ANY($${paramIndex})`;
      baseParams.push(sourceNamesList);
      paramIndex++;

      // Build date range WHERE clause
      let dateWhereClause = '';
      if (start_date === end_date) {
        dateWhereClause = `c.date = $${paramIndex}`;
        baseParams.push(start_date);
        paramIndex++;
      } else {
        dateWhereClause = `c.date > $${paramIndex} AND c.date <= $${paramIndex + 1}`;
        baseParams.push(start_date, end_date);
        paramIndex += 2;
      }

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
      }

      // Base WHERE conditions - only apply default GRADE > 1 if no GRADE filter is provided
      // If GRADE filter is provided, it will use "greater than" logic in the filter clause
      // For TAKEOFF, do not apply default grade > 1 (takeoff events may not have GRADE tag or use different values)
      const hasGradeFilter = filtersObj && filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0;
      const whereConditions = (hasGradeFilter || eventTypeLower === 'takeoff') ? '' : `(b.tags->>'GRADE')::int > 1`;

      // Build filter SELECT fields
      const filter_str = buildFilterSelectFields('b', 'c', 'd');

      // Datetime in UTC; clients use row timezone for display
      const datetimeExpr = formatDatetimeUTC('a."Datetime"', '"Datetime"');

      // GP50 TWS bin logic
      const { twsBinWhereClause, twsBinPartitionExpr, twsBinFinalFilter, orderByExpr } = buildGP50TwsBinLogic(class_name, 'a');
      const isGP50 = class_name.toUpperCase() === 'GP50';

      // Check if tws_bin is already in channels
      const hasTwsBinInChannels = safeChannels.some(ch => ch.toLowerCase() === 'tws_bin');
      const twsBinSelect = hasTwsBinInChannels ? '' : `a."Tws_bin" as tws_bin,`;
      // For GP50, we need to select Tws_avg for the outer query's twsBinFinalFilter and orderByExpr
      // But only if it's not already in the channels list (to avoid ambiguous column reference)
      const hasTwsAvgInChannels = safeChannels.some(ch => ch.toLowerCase() === 'tws_avg');
      const twsAvgSelect = (isGP50 && !hasTwsAvgInChannels) ? 'a."Tws_avg" "tws_avg",' : '';

      const params = [...baseParams, ...filterParams];

      sql = `SELECT * FROM (
        SELECT 
          a.event_id,
          ${twsBinSelect}
          ${twsAvgSelect}
          ${datetimeExpr},
          ${filter_str},
          c.timezone AS "timezone",
          ${channelStr},
          CASE WHEN ${twaEntryCol} > 0 THEN 1 ELSE -1 END as tack_side,
          ROW_NUMBER() OVER (
            PARTITION BY 
              d.source_name,
              ${twsBinPartitionExpr},
              (CASE WHEN ${twaEntryCol} > 0 THEN 1 ELSE -1 END)
            ORDER BY a."Vmg_perc_avg" DESC
          ) as row_num
        FROM ${class_name}.maneuver_stats a
        INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id
        INNER JOIN ${class_name}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${class_name}.sources d ON c.source_id = d.source_id
        WHERE d.project_id = $1
          ${sourceWhereClause}
          AND c.visible = 1 
          AND lower(b.event_type) = lower($2)
          AND ${dateWhereClause}${whereConditions ? ' AND ' + whereConditions : ''}
          ${finalFilterClause}
          ${twsBinWhereClause}
      ) Q
      WHERE Q.row_num <= ${countNum}
      ${twsBinFinalFilter}
      ORDER BY Q.source_name, ${orderByExpr}, Q.tack_side, Q."vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuversHistory_TableData error:', error);
    if (error && error.stack) {
      console.error('getManeuversHistory_TableData error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuversHistory_TableData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * History query: Get top N maneuvers per tack per source per wind speed bin
 * Returns map JSON data from events_mapdata
 */
exports.getManeuversHistory_MapData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuversHistory_MapData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = '';

  try {
    const { class_name, project_id, source_names, start_date, end_date, event_type, desc, filters, count = 5 } = req.query;

    if (!class_name || !desc) {
      return sendResponse(res, info, 400, false, 'class_name and desc are required', null);
    }

    // Validate that source_names is provided
    if (!source_names) {
      return sendResponse(res, info, 400, false, 'source_names is required', null);
    }

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Parse source_names (required)
      let sourceNamesList = null;
      try {
        sourceNamesList = JSON.parse(source_names);
        if (!Array.isArray(sourceNamesList)) {
          return sendResponse(res, info, 400, false, 'source_names must be a JSON array', null);
        }
        sourceNamesList = sourceNamesList.map(name => String(name).trim().toLowerCase()).filter(name => name.length > 0);
        if (sourceNamesList.length === 0) {
          return sendResponse(res, info, 400, false, 'source_names must contain at least one valid source name', null);
        }
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid source_names JSON', null);
      }

      // Build filters (history type - includes YEAR, EVENT, CONFIG)
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, true, 'b', 'd', 'e');

      // Build date range WHERE clause
      let dateWhereClause = '';
      let baseParams = [parseInt(project_id), event_type.toLowerCase()];
      let paramIndex = 3;

      if (start_date === end_date) {
        dateWhereClause = `d.date = $${paramIndex}`;
        baseParams.push(start_date);
        paramIndex++;
      } else {
        dateWhereClause = `d.date >= $${paramIndex} AND d.date <= $${paramIndex + 1}`;
        baseParams.push(start_date, end_date);
        paramIndex += 2;
      }

      // Add source filter (required)
      const sourceWhereClause = `AND LOWER(e.source_name) = ANY($${paramIndex})`;
      baseParams.push(sourceNamesList);
      paramIndex++;

      // Add desc parameter
      baseParams.push(desc.toLowerCase());
      const descParamIndex = paramIndex;
      paramIndex++;

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
        baseParams.push(...filterParams);
      }

      // Base WHERE conditions - only apply default GRADE > 1 if no GRADE filter is provided
      // For TAKEOFF, do not apply default grade > 1 (takeoff events may not have GRADE tag or use different values)
      const eventTypeLowerMap = (event_type || '').toLowerCase();
      const hasGradeFilter = filtersObj && filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0;
      const whereConditions = (hasGradeFilter || eventTypeLowerMap === 'takeoff') ? '' : `(b.tags->>'GRADE')::int > 1`;

      // Build filter SELECT fields
      const filter_str = buildFilterSelectFields('b', 'd', 'e');

      // For takeoff, twa_entry in maneuver_stats comes from Twa_start
      const twaEntryCol = eventTypeLowerMap === 'takeoff' ? 'c."Twa_start"' : 'c."Twa_entry"';

      // GP50 TWS bin logic
      const { twsBinWhereClause, twsBinPartitionExpr, twsBinFinalFilter, orderByExpr } = buildGP50TwsBinLogic(class_name, 'c');
      const countNum = parseInt(count) || 5;

      sql = `SELECT * FROM (
        SELECT 
          a.event_id "event_id",
          ${filter_str},
          c."Tws_bin" "tws_bin",
          ${class_name.toUpperCase() === 'GP50' ? 'c."Tws_avg" "tws_avg",' : ''}
          c."Vmg_perc_avg" "vmg_perc_avg", 
          ${twaEntryCol} "twa_entry", 
          a.json,
          CASE WHEN ${twaEntryCol} > 0 THEN 1 ELSE -1 END as tack_side,
          ROW_NUMBER() OVER (
            PARTITION BY 
              e.source_name,
              ${twsBinPartitionExpr},
              (CASE WHEN ${twaEntryCol} > 0 THEN 1 ELSE -1 END)
            ORDER BY c."Vmg_perc_avg" DESC
          ) as row_num
        FROM ${class_name}.events_mapdata a 
        INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id 
        INNER JOIN ${class_name}.maneuver_stats c ON b.event_id = c.event_id 
        INNER JOIN ${class_name}.datasets d ON b.dataset_id = d.dataset_id
        INNER JOIN ${class_name}.sources e ON d.source_id = e.source_id
        WHERE e.project_id = $1
          AND d.visible = 1
          AND lower(b.event_type) = lower($2)
          AND ${dateWhereClause}
          AND LOWER(a.description) = LOWER($${descParamIndex})
          ${whereConditions ? ' AND ' + whereConditions : ''}
          ${sourceWhereClause}
          ${finalFilterClause}
          ${twsBinWhereClause}
      ) Q
      WHERE Q.row_num <= ${countNum}
      ${twsBinFinalFilter}
      ORDER BY Q.source_name, ${orderByExpr}, Q.tack_side, Q."vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, baseParams);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuversHistory_MapData error:', error);
    if (error && error.stack) {
      console.error('getManeuversHistory_MapData error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuversHistory_MapData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * History query: Get top N maneuvers per tack per source per wind speed bin
 * Returns timeseries JSON data from events_timeseries
 */
exports.getManeuversHistory_TimeSeriesData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuversHistory_TimeSeriesData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = '';

  try {
    const { class_name, project_id, source_names, start_date, end_date, event_type, desc, filters, count = 5 } = req.query;

    if (!class_name || !desc) {
      return sendResponse(res, info, 400, false, 'class_name and desc are required', null);
    }

    // Validate that source_names is provided
    if (!source_names) {
      return sendResponse(res, info, 400, false, 'source_names is required', null);
    }

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Parse source_names (required)
      let sourceNamesList = null;
      try {
        sourceNamesList = JSON.parse(source_names);
        if (!Array.isArray(sourceNamesList)) {
          return sendResponse(res, info, 400, false, 'source_names must be a JSON array', null);
        }
        sourceNamesList = sourceNamesList.map(name => String(name).trim().toLowerCase()).filter(name => name.length > 0);
        if (sourceNamesList.length === 0) {
          return sendResponse(res, info, 400, false, 'source_names must contain at least one valid source name', null);
        }
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid source_names JSON', null);
      }

      // Build filters (history type - includes YEAR, EVENT, CONFIG)
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, true, 'b', 'd', 'e');

      // Build date range WHERE clause
      let dateWhereClause = '';
      let baseParams = [parseInt(project_id), event_type.toLowerCase()];
      let paramIndex = 3;

      if (start_date === end_date) {
        dateWhereClause = `d.date = $${paramIndex}`;
        baseParams.push(start_date);
        paramIndex++;
      } else {
        dateWhereClause = `d.date >= $${paramIndex} AND d.date <= $${paramIndex + 1}`;
        baseParams.push(start_date, end_date);
        paramIndex += 2;
      }

      // Add source filter (required)
      const sourceWhereClause = `AND LOWER(e.source_name) = ANY($${paramIndex})`;
      baseParams.push(sourceNamesList);
      paramIndex++;

      // Add desc parameter
      baseParams.push(desc.toLowerCase());
      const descParamIndex = paramIndex;
      paramIndex++;

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
        baseParams.push(...filterParams);
      }

      // Base WHERE conditions - only apply default GRADE > 1 if no GRADE filter is provided
      // For TAKEOFF, do not apply default grade > 1 (takeoff events may not have GRADE tag or use different values)
      const eventTypeLowerTs = (event_type || '').toLowerCase();
      const hasGradeFilter = filtersObj && filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0;
      const whereConditions = (hasGradeFilter || eventTypeLowerTs === 'takeoff') ? '' : `(b.tags->>'GRADE')::int > 1`;

      // Build filter SELECT fields
      const filter_str = buildFilterSelectFields('b', 'd', 'e');

      // For takeoff, twa_entry in maneuver_stats comes from Twa_start
      const twaEntryCol = eventTypeLowerTs === 'takeoff' ? 'c."Twa_start"' : 'c."Twa_entry"';

      // GP50 TWS bin logic
      const { twsBinWhereClause, twsBinPartitionExpr, twsBinFinalFilter, orderByExpr } = buildGP50TwsBinLogic(class_name, 'c');
      const countNum = parseInt(count) || 5;

      sql = `SELECT * FROM (
        SELECT 
          a.event_id "event_id",
          ${filter_str},
          c."Tws_bin" "tws_bin",
          ${class_name.toUpperCase() === 'GP50' ? 'c."Tws_avg" "tws_avg",' : ''}
          c."Vmg_perc_avg" "vmg_perc_avg", 
          ${twaEntryCol} "twa_entry", 
          a.json,
          CASE WHEN ${twaEntryCol} > 0 THEN 1 ELSE -1 END as tack_side,
          ROW_NUMBER() OVER (
            PARTITION BY 
              e.source_name,
              ${twsBinPartitionExpr},
              (CASE WHEN ${twaEntryCol} > 0 THEN 1 ELSE -1 END)
            ORDER BY c."Vmg_perc_avg" DESC
          ) as row_num
        FROM ${class_name}.events_timeseries a 
        INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id 
        INNER JOIN ${class_name}.maneuver_stats c ON b.event_id = c.event_id 
        INNER JOIN ${class_name}.datasets d ON b.dataset_id = d.dataset_id
        INNER JOIN ${class_name}.sources e ON d.source_id = e.source_id
        WHERE e.project_id = $1
          AND d.visible = 1
          AND lower(b.event_type) = lower($2)
          AND ${dateWhereClause}
          AND LOWER(a.description) = LOWER($${descParamIndex})${whereConditions ? ' AND ' + whereConditions : ''}
          ${sourceWhereClause}
          ${finalFilterClause}
          ${twsBinWhereClause}
      ) Q
      WHERE Q.row_num <= ${countNum}
      ${twsBinFinalFilter}
      ORDER BY Q.source_name, ${orderByExpr}, Q.tack_side, Q."vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, baseParams);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuversHistory_TimeSeriesData error:', error);
    if (error && error.stack) {
      console.error('getManeuversHistory_TimeSeriesData error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuversHistory_TimeSeriesData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * Single date query: Get all maneuvers for a specific date with simple filters
 * Returns table data from maneuver_stats
 */
exports.getManeuvers_TableData = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = '';

  try {
    const { class_name, project_id, source_names, source_id: sourceIdParam, date, event_type, channels, filters } = req.query;

    // Require either source_names or source_id (validation allows both; controller resolves source_id to names)
    if (!source_names && !sourceIdParam) {
      return sendResponse(res, info, 400, false, 'either source_names or source_id is required', null);
    }

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Sanitize channels
      let safeChannels = [];
      if (channels) {
        try {
          safeChannels = sanitizeChannelNames(channels);
          if (safeChannels.length === 0) {
            return sendResponse(res, info, 400, false, 'No valid channels provided after sanitization', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid channels JSON', null);
        }
      } else {
        return sendResponse(res, info, 400, false, 'channels is required', null);
      }

      const eventTypeLower = event_type.toLowerCase();

      // TAKEOFF-specific channel -> DB column mapping (same as getDatasetManeuvers_TableData / getFleetManeuvers_TableData)
      const TAKEOFF_CHANNEL_DB_COLUMNS = {
        tws_avg: 'Tws_avg',
        mmg: 'Mmg',
        vmg_perc_avg: 'Vmg_perc_avg',
        bsp_start: 'Bsp_start',
        twa_build: 'Twa_build',
        time_accel: 'Time_accel',
        exit_time: 'Exit_time',
        bsp_exit: 'Bsp_exit',
        twa_exit: 'Twa_exit',
        cant_accmax: 'Cant_accmax',
        pitch_accmax: 'Pitch_accmax',
        heel_accmax: 'Heel_accmax',
        jib_sheet_pct_accmax: 'Jib_sheet_pct_accmax',
        jib_lead_ang_accmax: 'Jib_lead_ang_accmax',
        jib_cunno_load_accmax: 'Jib_cunno_load_accmax',
        wing_clew_pos_accmax: 'Wing_clew_pos_accmax',
        wing_twist_accmax: 'Wing_twist_accmax',
        rud_rake_accmax: 'Rud_rake_accmax',
        rud_diff_accmax: 'Rud_diff_accmax',
        wing_ca1_accmax: 'Wing_ca1_accmax',
        rake_accmax: 'Rake_accmax'
      };

      const toDbColumnName = (channelName) => {
        if (!channelName || channelName.length === 0) return channelName;
        const normalized = channelName.toLowerCase();
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      };

      // Build channels string
      let channelFields = [];
      safeChannels.forEach(channel => {
        const channelLower = channel.toLowerCase();
        if (channelLower === 'tws_bin') {
          channelFields.push(`a."Tws_bin" "tws_bin"`);
        } else if (channelLower === 'twa_entry_n') {
          if (eventTypeLower === 'takeoff') {
            channelFields.push(`abs(a."Twa_start") "twa_entry_n"`);
          } else {
            channelFields.push(`abs(a."Twa_entry") "twa_entry_n"`);
          }
        } else if (channelLower === 'twa_exit_n') {
          channelFields.push(`abs(a."Twa_exit") "twa_exit_n"`);
        } else if (channelLower === 'twa_build_n') {
          channelFields.push(`abs(a."Twa_build") "twa_build_n"`);
        } else if (channelLower === 'twa_drop_n') {
          channelFields.push(`abs(a."Twa_drop") "twa_drop_n"`);
        } else if (channelLower === 'twa_entry' && eventTypeLower === 'takeoff') {
          channelFields.push(`a."Twa_start" as "twa_entry"`);
        } else if (channelLower === 'loss_inv_avg') {
          channelFields.push(`a."Loss_inv_vmg" "loss_inv_avg"`);
        } else if (channelLower === 'loss_turn_avg') {
          channelFields.push(`a."Loss_turn_vmg" "loss_turn_avg"`);
        } else if (channelLower === 'loss_build_avg') {
          channelFields.push(`a."Loss_build_vmg" "loss_build_avg"`);
        } else if (channelLower === 'loss_total_avg') {
          channelFields.push(`a."Loss_total_vmg" "loss_total_avg"`);
        } else if (channelLower === 'bsp_drop') {
          channelFields.push(`a."Bsp_drop" "bsp_drop"`);
        } else if (channelLower === 'drop_time') {
          channelFields.push(`a."Drop_time" "drop_time"`);
        } else if (eventTypeLower === 'takeoff' && TAKEOFF_CHANNEL_DB_COLUMNS[channelLower]) {
          const dbCol = TAKEOFF_CHANNEL_DB_COLUMNS[channelLower];
          channelFields.push(`a."${dbCol}" "${channelLower}"`);
        } else {
          const dbColumnName = toDbColumnName(channelLower);
          channelFields.push(`a."${dbColumnName}" "${channelLower}"`);
        }
      });
      const channelStr = channelFields.join(', ');

      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Parse source_names or resolve source_id to source name(s)
      let sourceNamesList = null;
      if (source_names) {
        try {
          sourceNamesList = JSON.parse(source_names);
          if (!Array.isArray(sourceNamesList)) {
            return sendResponse(res, info, 400, false, 'source_names must be a JSON array', null);
          }
          sourceNamesList = sourceNamesList.map(name => String(name).trim().toLowerCase()).filter(name => name.length > 0);
          if (sourceNamesList.length === 0) {
            return sendResponse(res, info, 400, false, 'source_names must contain at least one valid source name', null);
          }
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid source_names JSON', null);
        }
      } else {
        // Backward compatibility: resolve source_id to source name
        const sourceId = parseInt(sourceIdParam, 10);
        if (!Number.isInteger(sourceId) || sourceId < 1) {
          return sendResponse(res, info, 400, false, 'source_id must be a positive integer', null);
        }
        const lookupSql = `SELECT source_name FROM ${class_name}.sources WHERE source_id = $1 AND project_id = $2 LIMIT 1`;
        const lookupRows = await db.GetRows(lookupSql, [sourceId, parseInt(project_id, 10)]);
        if (!lookupRows || lookupRows.length === 0) {
          return sendResponse(res, info, 400, false, 'source_id not found or not in project', null);
        }
        sourceNamesList = [String(lookupRows[0].source_name).trim().toLowerCase()];
        if (sourceNamesList[0].length === 0) {
          return sendResponse(res, info, 400, false, 'source has no name', null);
        }
      }

      // Build filters (single date type - only GRADE, STATE, SOURCE_NAME)
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, false, 'b', 'c', 'd');

      // Build source filter clause (required)
      let baseParams = [parseInt(project_id), date, event_type];
      let paramIndex = 4;
      const sourceWhereClause = `AND LOWER(d.source_name) = ANY($${paramIndex})`;
      baseParams.push(sourceNamesList);
      paramIndex++;

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
      }

      // Fleet single-date only: allow user's grade filter to override default (e.g. grade > 0).
      // History and Fleet Maneuvers History use buildManeuverFilters(..., isHistory: true), which
      // enforces at least grade > 1; they do not use this handler.
      // For TAKEOFF, do not apply default grade > 1 when user sends no GRADE filter, so fleet
      // matches single-source (getDatasetManeuvers_TableData) behavior and takeoff data is returned.
      const hasGradeFilter = filtersObj && filtersObj.GRADE && Array.isArray(filtersObj.GRADE) && filtersObj.GRADE.length > 0;
      const whereConditions = (hasGradeFilter || eventTypeLower === 'takeoff')
        ? ''
        : `(b.tags->>'GRADE')::int > 1`;

      // Build filter SELECT fields
      const filter_str = buildFilterSelectFields('b', 'c', 'd');

      const params = [...baseParams, ...filterParams];

      sql = `SELECT 
        a.event_id "event_id", 
        cast(a."Datetime" as text) "Datetime", 
        ${filter_str},
        c.timezone AS "timezone",
        ${channelStr}
      FROM ${class_name}.maneuver_stats a 
      INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id 
      INNER JOIN ${class_name}.datasets c ON b.dataset_id = c.dataset_id
      INNER JOIN ${class_name}.sources d ON c.source_id = d.source_id
      WHERE d.project_id = $1
        AND c.date = $2 
        AND lower(b.event_type) = lower($3)
        AND c.visible = 1
        ${sourceWhereClause}
        ${whereConditions ? ' AND ' + whereConditions : ''}
        ${finalFilterClause}
      ORDER BY a."Vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuvers_TableData error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_TableData error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_TableData SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * Single date query: Get all maneuvers for a specific date with simple filters
 * Returns map JSON data from events_mapdata
 */
exports.getManeuvers_MapDataByDate = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_MapDataByDate' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = '';

  try {
    const { class_name, project_id, source_names, date, event_type, desc, filters } = req.query;

    if (!class_name || !desc) {
      return sendResponse(res, info, 400, false, 'class_name and desc are required', null);
    }

    // Validate that source_names is provided
    if (!source_names) {
      return sendResponse(res, info, 400, false, 'source_names is required', null);
    }

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Parse source_names (required)
      let sourceNamesList = null;
      try {
        sourceNamesList = JSON.parse(source_names);
        if (!Array.isArray(sourceNamesList)) {
          return sendResponse(res, info, 400, false, 'source_names must be a JSON array', null);
        }
        sourceNamesList = sourceNamesList.map(name => String(name).trim().toLowerCase()).filter(name => name.length > 0);
        if (sourceNamesList.length === 0) {
          return sendResponse(res, info, 400, false, 'source_names must contain at least one valid source name', null);
        }
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid source_names JSON', null);
      }

      // Build filters (single date type - only GRADE, STATE, SOURCE_NAME)
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, false, 'b', 'd', 'e');

      // Build source filter clause (required)
      let baseParams = [parseInt(project_id), date, event_type.toLowerCase(), desc.toLowerCase()];
      let paramIndex = 5;
      const sourceWhereClause = `AND LOWER(e.source_name) = ANY($${paramIndex})`;
      baseParams.push(sourceNamesList);
      paramIndex++;

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
      }

      // Base WHERE conditions
      const whereConditions = `(b.tags->>'GRADE')::int > 1`;

      // Build filter SELECT fields
      const filter_str = buildFilterSelectFields('b', 'd', 'e');

      const params = [...baseParams, ...filterParams];

      sql = `SELECT 
        a.event_id "event_id", 
        ${filter_str},
        c."Tws_bin" "tws_bin", 
        c."Vmg_perc_avg" "vmg_perc_avg", 
        c."Twa_entry" "twa_entry", 
        a.json 
      FROM ${class_name}.events_mapdata a 
      INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id 
      INNER JOIN ${class_name}.maneuver_stats c ON b.event_id = c.event_id 
      INNER JOIN ${class_name}.datasets d ON b.dataset_id = d.dataset_id
      INNER JOIN ${class_name}.sources e ON d.source_id = e.source_id
      WHERE e.project_id = $1
        AND d.date = $2 
        AND lower(b.event_type) = lower($3)
        AND LOWER(a.description) = LOWER($4)
        AND d.visible = 1
        ${sourceWhereClause}
        AND ${whereConditions}
        ${finalFilterClause}
      ORDER BY c."Vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuvers_MapDataByDate error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_MapDataByDate error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_MapDataByDate SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * Single date query: Get all maneuvers for a specific date with simple filters
 * Returns timeseries JSON data from events_timeseries
 */
exports.getManeuvers_TimeSeriesDataByDate = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/data', "function": 'getManeuvers_TimeSeriesDataByDate' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  let sql = '';

  try {
    const { class_name, project_id, source_names, date, event_type, desc, filters } = req.query;

    if (!class_name || !desc) {
      return sendResponse(res, info, 400, false, 'class_name and desc are required', null);
    }

    // Validate that source_names is provided
    if (!source_names) {
      return sendResponse(res, info, 400, false, 'source_names is required', null);
    }

    let result = await check_permissions(req, 'read', project_id);

    if (result) {
      // Parse filters
      let filtersObj = null;
      if (filters) {
        try {
          filtersObj = JSON.parse(filters);
        } catch (e) {
          return sendResponse(res, info, 400, false, 'Invalid filters JSON', null);
        }
      }

      // Parse source_names (required)
      let sourceNamesList = null;
      try {
        sourceNamesList = JSON.parse(source_names);
        if (!Array.isArray(sourceNamesList)) {
          return sendResponse(res, info, 400, false, 'source_names must be a JSON array', null);
        }
        sourceNamesList = sourceNamesList.map(name => String(name).trim().toLowerCase()).filter(name => name.length > 0);
        if (sourceNamesList.length === 0) {
          return sendResponse(res, info, 400, false, 'source_names must contain at least one valid source name', null);
        }
      } catch (e) {
        return sendResponse(res, info, 400, false, 'Invalid source_names JSON', null);
      }

      // Build filters (single date type - only GRADE, STATE, SOURCE_NAME)
      const { filterClauses, filterParams } = buildManeuverFilters(filtersObj, class_name, false, 'b', 'd', 'e');

      // Build source filter clause (required)
      let baseParams = [parseInt(project_id), date, event_type.toLowerCase(), desc.toLowerCase()];
      let paramIndex = 5;
      const sourceWhereClause = `AND LOWER(e.source_name) = ANY($${paramIndex})`;
      baseParams.push(sourceNamesList);
      paramIndex++;

      // Apply filter placeholders
      let finalFilterClause = '';
      if (filterClauses.length > 0) {
        const filterWhereClause = ' AND ' + filterClauses.join(' AND ');
        finalFilterClause = applyFilterPlaceholders(filterWhereClause, paramIndex);
      }

      // Base WHERE conditions
      const whereConditions = `(b.tags->>'GRADE')::int > 1`;

      // Build filter SELECT fields
      const filter_str = buildFilterSelectFields('b', 'd', 'e');

      const params = [...baseParams, ...filterParams];

      sql = `SELECT 
        a.event_id "event_id",
        ${filter_str},
        c."Tws_bin" "tws_bin", 
        c."Vmg_perc_avg" "vmg_perc_avg", 
        c."Twa_entry" "twa_entry", 
        a.json
      FROM ${class_name}.events_timeseries a 
      INNER JOIN ${class_name}.dataset_events b ON a.event_id = b.event_id 
      INNER JOIN ${class_name}.maneuver_stats c ON b.event_id = c.event_id 
      INNER JOIN ${class_name}.datasets d ON b.dataset_id = d.dataset_id
      INNER JOIN ${class_name}.sources e ON d.source_id = e.source_id
      WHERE e.project_id = $1
        AND d.date = $2 
        AND lower(b.event_type) = lower($3)
        AND LOWER(a.description) = LOWER($4)
        AND d.visible = 1
        ${sourceWhereClause}
        AND ${whereConditions}
        ${finalFilterClause}
      ORDER BY c."Vmg_perc_avg" DESC`;

      let rows = await db.GetRows(sql, params);

      if (rows) {
        return sendResponse(res, info, 200, true, rows.length + " rows returned...", rows, false);
      } else {
        return sendResponse(res, info, 204, false, 'No maneuvers found', null);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    console.error('getManeuvers_TimeSeriesDataByDate error:', error);
    if (error && error.stack) {
      console.error('getManeuvers_TimeSeriesDataByDate error stack:', error.stack);
    }
    if (sql) {
      console.error('getManeuvers_TimeSeriesDataByDate SQL:', sql);
    }
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

/**
 * Get race summary: positions per race per source and total (sum of positions) for a given date.
 * Builds the pivot query dynamically based on available races where race_number > 0.
 * @query class_name, project_id, date (YYYY-MM-DD or YYYYMMDD)
 */
exports.getRaceDayResults_TableData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getRaceDayResults_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const normalizedDate = String(date).replace(/[-/]/g, '');
    if (normalizedDate.length !== 8) {
      return sendResponse(res, info, 400, false, 'date must be YYYY-MM-DD or YYYYMMDD', null);
    }

    const schema = String(class_name).trim();
    const projectId = parseInt(project_id, 10);
    if (!schema || isNaN(projectId) || projectId < 1) {
      return sendResponse(res, info, 400, false, 'class_name and project_id required', null);
    }

    // Normalize Race_number so "8", "8.0", " 8 " all become "8"; include only positive integers (final race may be stored as e.g. "10.0")
    const raceKeyExpr = `(CASE WHEN TRIM(b.tags ->> 'Race_number') ~ '^[0-9]+\\.?[0-9]*$' AND CAST(CAST(TRIM(b.tags ->> 'Race_number') AS NUMERIC) AS INT) > 0 THEN (CAST(CAST(TRIM(b.tags ->> 'Race_number') AS NUMERIC) AS INT))::text ELSE NULL END)`;
    const raceKeyFilter = `${raceKeyExpr} IS NOT NULL`;

    // 1) Get all race keys for this date where race_number > 0 (show all races; some may be excluded from total/average)
    const racesSql = `
      SELECT race_key FROM (
        SELECT DISTINCT ${raceKeyExpr} AS race_key
        FROM ${schema}.race_stats a
        INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
        INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
        WHERE d.project_id = $1
          AND c.date = $2
          AND LOWER(b.event_type) = 'race'
          AND ${raceKeyFilter}
      ) sub
      ORDER BY race_key::int`;

    const raceRows = await db.GetRows(racesSql, [projectId, normalizedDate]);
    let races = Array.isArray(raceRows)
      ? raceRows.map(r => String(r.race_key ?? '')).filter(Boolean)
      : [];

    let useTrainingHours = false;
    if (races.length === 0) {
      const hourKeyExpr = `(b.tags ->> 'HOUR')`;
      // HOUR can be legacy numeric (0,1,2) or string "11:00", "12:00"; order supports both
      const hoursSql = `
        SELECT hour_key FROM (
          SELECT DISTINCT ${hourKeyExpr} AS hour_key
          FROM ${schema}.race_stats a
          INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
          INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
          INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
          WHERE d.project_id = $1 AND c.date = $2 AND LOWER(b.event_type) = 'training'
            AND b.tags ->> 'HOUR' IS NOT NULL AND b.tags ->> 'HOUR' != ''
        ) sub
        ORDER BY CASE WHEN hour_key ~ '^[0-9]+$' THEN (hour_key::int) ELSE 999 END, hour_key`;
      const hourRows = await db.GetRows(hoursSql, [projectId, normalizedDate]);
      if (hourRows && hourRows.length > 0) {
        races = hourRows.map(r => String(r.hour_key ?? '')).filter(Boolean);
        useTrainingHours = true;
      } else {
        return sendResponse(res, info, 200, true, 'No races with race_number > 0 for this date', { rows: [], races: [], excludedRaces: [] }, false);
      }
    }

    const keyExpr = useTrainingHours ? `(b.tags ->> 'HOUR')` : raceKeyExpr;
    const eventKeyFilter = useTrainingHours
      ? `LOWER(b.event_type) = 'training' AND b.tags ->> 'HOUR' IS NOT NULL AND b.tags ->> 'HOUR' != ''`
      : `LOWER(b.event_type) = 'race' AND ${raceKeyFilter}`;

    // 2) Races/hours where only 3 or fewer teams have positions: exclude from total and average
    const qualifyingSql = `
      SELECT race_key FROM (
        SELECT ${keyExpr} AS race_key, d.source_id
        FROM ${schema}.race_stats a
        INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
        INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
        WHERE d.project_id = $1 AND c.date = $2 AND ${eventKeyFilter}
      ) sub
      GROUP BY race_key
      HAVING COUNT(DISTINCT source_id) > 3`;
    const qualifyingRows = await db.GetRows(qualifyingSql, [projectId, normalizedDate]);
    const qualifyingSet = new Set(
      Array.isArray(qualifyingRows) ? qualifyingRows.map(r => String(r.race_key ?? '')) : []
    );
    const excludedRaces = races.filter(r => !qualifyingSet.has(r));

    // 3) Build pivot: one column per race (all races), total and average only from qualifying races. Total rank (position) by total elapsed time.
    const raceColumns = races.map((r, i) => `MAX(CASE WHEN race_key = $${i + 3} THEN position END) AS race${i + 1}`);
    const qualifyingIndices = races.map((_, i) => qualifyingSet.has(races[i]) ? i : -1).filter(i => i >= 0);
    const totalParts = qualifyingIndices.map(i => `COALESCE(MAX(CASE WHEN race_key = $${i + 3} THEN position END), 0)`);
    const totalExpr = totalParts.length > 0 ? `(${totalParts.join(' + ')}) AS total` : '0 AS total';
    const totalElapsedParts = qualifyingIndices.map(i => `COALESCE(MAX(CASE WHEN race_key = $${i + 3} THEN duration_sec END), 0)`);
    const totalElapsedExpr = totalElapsedParts.length > 0 ? `(${totalElapsedParts.join(' + ')})::numeric AS total_elapsed_sec` : 'NULL::numeric AS total_elapsed_sec';
    const qualifyingCount = qualifyingIndices.length;
    const averageExpr = qualifyingCount > 0
      ? `ROUND(((${totalParts.join(' + ')})::numeric / ${qualifyingCount}), 2) AS average`
      : 'NULL::numeric AS average';
    const raceColNames = races.map((_, i) => `race${i + 1}`).join(', ');

    const pivotSql = `
      SELECT
        ROW_NUMBER() OVER (ORDER BY total_elapsed_sec ASC NULLS LAST)::int AS position,
        source_name,
        ${raceColNames},
        average,
        total,
        total_elapsed_sec
      FROM (
        SELECT
          source_name,
          ${raceColumns.join(',\n          ')},
          ${averageExpr},
          ${totalExpr},
          ${totalElapsedExpr}
        FROM (
          SELECT
            d.source_name,
            ${keyExpr} AS race_key,
            a."Position" AS position,
            a."Duration_sec" AS duration_sec
          FROM ${schema}.race_stats a
          INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
          INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
          INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
          WHERE d.project_id = $1
            AND c.date = $2
            AND ${eventKeyFilter}
        ) Q
        GROUP BY source_name
      ) pivot
      ORDER BY total_elapsed_sec ASC NULLS LAST`;

    const params = [projectId, normalizedDate, ...races];
    const rows = await db.GetRows(pivotSql, params);

    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', { rows: rows || [], races, excludedRaces }, false);
  } catch (err) {
    console.error('getRaceDayResults_TableData error:', err);
    if (err && err.stack) console.error('getRaceDayResults_TableData stack:', err.stack);
    const code = err.code || (err.message && String(err.message));
    const msg = err.message ? String(err.message) : '';
    const isMissingTable = code === '42P01' || /relation\s+["']?[\w.]*race_stats["']?\s+does not exist/i.test(msg);
    if (isMissingTable) {
      return sendResponse(res, info, 200, true, 'race_stats table not present for this schema', { rows: [], races: [], excludedRaces: [] }, false);
    }
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get race summary table: one row per source for a single race, or when race is omitted/zero, one row per source with aggregates across all races (averages for most metrics; max_speed is MAX across races).
 * @query class_name, project_id, date (YYYY-MM-DD or YYYYMMDD), race (e.g. '26011805'; optional—if missing or '0', returns averages by source)
 */
exports.getRaceSummary_TableData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getRaceSummary_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date, race, summary_type } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const normalizedDate = String(date).replace(/[-/]/g, '');
    if (normalizedDate.length !== 8) {
      return sendResponse(res, info, 400, false, 'date must be YYYY-MM-DD or YYYYMMDD', null);
    }

    const schema = String(class_name).trim();
    const projectId = parseInt(project_id, 10);
    const raceKey = race == null || String(race).trim() === '' ? '' : String(race).trim();
    const isTrainingSummary = String(summary_type || '').trim().toLowerCase() === 'training';
    // When summary_type=training, "All"/"0"/empty means aggregate across all training hours
    const hasRace = raceKey !== '' && raceKey !== '0' && raceKey.toLowerCase() !== 'all';

    if (!schema || isNaN(projectId) || projectId < 1) {
      return sendResponse(res, info, 400, false, 'class_name and project_id are required', null);
    }

    // Race summary: all columns from race_stats only (no events_aggregate). Joins only for project/date/source_name and race tag.
    let rows;
    if (hasRace) {
      const sql = `
      SELECT d.source_name,
        COALESCE(b.tags -> 'RACES' ->> 'Race_number', b.tags ->> 'Race_number', b.tags ->> 'HOUR') AS race,
        a."Tws_avg_kph" AS tws_avg_kph,
        a."Bsp_avg_kph" AS bsp_avg_kph,
        a."Vmg_avg_kph" AS vmg_avg,
        a."Vmg_perc_avg" AS vmg_perc_avg,
        a."Polar_perc_avg" AS polar_perc_avg,
        a."Distance_m" AS distance_m,
        a."Bsp_max_kph" AS max_speed,
        a."Foiling_perc" AS foiling_perc,
        a."Phase_duration_avg_sec" AS phase_dur_avg_sec,
        a."Maneuver_count" AS maneuver_count,
        a."Tack_loss_avg" AS tack_loss_avg,
        a."Gybe_loss_avg" AS gybe_loss_avg,
        a."Roundup_loss_avg" AS roundup_loss_avg,
        a."Bearaway_loss_avg" AS bearaway_loss_avg
      FROM ${schema}.race_stats a
      INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
      INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
      INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
      WHERE d.project_id = $1 AND c.date = $2
        AND (
          (LOWER(b.event_type) = 'race' AND NULLIF(TRIM(COALESCE(b.tags -> 'RACES' ->> 'Race_number', b.tags ->> 'Race_number')), '') = $3)
          OR (LOWER(b.event_type) = 'training' AND b.tags ->> 'HOUR' = $3)
        )
      ORDER BY a."Vmg_perc_avg" DESC NULLS LAST, d.source_name`;
      rows = await db.GetRows(sql, [projectId, normalizedDate, raceKey]);
    } else {
      const eventTypeFilter = isTrainingSummary ? "LOWER(b.event_type) = 'training'" : "LOWER(b.event_type) = 'race'";
      const sqlBySource = `
      SELECT d.source_name,
        NULL::text AS race,
        AVG(a."Tws_avg_kph") AS tws_avg_kph,
        AVG(a."Bsp_avg_kph") AS bsp_avg_kph,
        AVG(a."Vmg_avg_kph") AS vmg_avg,
        AVG(a."Vmg_perc_avg") AS vmg_perc_avg,
        AVG(a."Polar_perc_avg") AS polar_perc_avg,
        AVG(a."Distance_m") AS distance_m,
        MAX(a."Bsp_max_kph") AS max_speed,
        AVG(a."Foiling_perc") AS foiling_perc,
        AVG(a."Phase_duration_avg_sec") AS phase_dur_avg_sec,
        AVG(a."Maneuver_count") AS maneuver_count,
        AVG(a."Tack_loss_avg") AS tack_loss_avg,
        AVG(a."Gybe_loss_avg") AS gybe_loss_avg,
        AVG(a."Roundup_loss_avg") AS roundup_loss_avg,
        AVG(a."Bearaway_loss_avg") AS bearaway_loss_avg
      FROM ${schema}.race_stats a
      INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
      INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
      INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
      WHERE d.project_id = $1 AND c.date = $2 AND ${eventTypeFilter}
      GROUP BY d.source_id, d.source_name
      ORDER BY vmg_perc_avg DESC NULLS LAST`;
      rows = await db.GetRows(sqlBySource, [projectId, normalizedDate]);
    }

    // Normalize row keys to lowercase so frontend always gets e.g. vmg_perc_avg (driver may return Vmg_perc_avg)
    const normalizedRows = (rows || []).map((row) => {
      const out = {};
      for (const k of Object.keys(row)) {
        out[k.toLowerCase()] = row[k];
      }
      return out;
    });

    return sendResponse(res, info, 200, true, normalizedRows.length + ' rows returned', { rows: normalizedRows }, false);
  } catch (err) {
    console.error('getRaceSummary_TableData error:', err);
    if (err && err.stack) console.error('getRaceSummary_TableData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get cheat sheet table: group by Channel (one row per CONFIG for a wind band) or group by Wind (one row per CONFIG with columns per wind bin).
 * Removes outliers via IQR (Q1–Q3 on rank metric), then keeps upper 10% of cleaned set (Vmg_perc or Bsp_polar_perc >= P90 of IQR) and averages metrics per CONFIG.
 * @query class_name, project_id, group_by (channel|wind), tws_low, tws_high (when group_by=channel), leg_type (upwind|downwind|reaching), config (optional when group_by=wind), source_id (optional, single-source filter)
 */
exports.getCheatSheet_TableData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getCheatSheet_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, group_by, tws, tws_low, tws_high, leg_type, config, source_id, source_names, metric } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const schema = String(class_name).trim();
    const projectId = parseInt(project_id, 10);
    const groupBy = String(group_by || '').trim().toLowerCase();
    const legType = String(leg_type || 'upwind').trim().toLowerCase();

    let cheatSourceNamesArray = [];
    if (source_names != null && String(source_names).trim() !== '') {
      try {
        const parsed = JSON.parse(source_names);
        cheatSourceNamesArray = Array.isArray(parsed) ? parsed.map(s => String(s).trim()).filter(s => s.length > 0) : [];
      } catch (e) {
        return sendResponse(res, info, 400, false, 'source_names must be a JSON array of strings', null);
      }
    }
    const sourceIdParam = source_id != null && String(source_id).trim() !== '' ? parseInt(source_id, 10) : null;
    const hasSourceNamesFilter = cheatSourceNamesArray.length > 0;
    const hasSourceFilter = !hasSourceNamesFilter && sourceIdParam != null && !isNaN(sourceIdParam) && sourceIdParam > 0;
    const cheatSourceNamesLower = cheatSourceNamesArray.map(s => s.toLowerCase());

    if (!schema || isNaN(projectId) || projectId < 1) {
      return sendResponse(res, info, 400, false, 'class_name and project_id are required', null);
    }
    if (groupBy !== 'channel' && groupBy !== 'wind') {
      return sendResponse(res, info, 400, false, 'group_by must be channel or wind', null);
    }
    const validLegTypes = ['upwind', 'downwind', 'reaching'];
    if (!validLegTypes.includes(legType)) {
      return sendResponse(res, info, 400, false, 'leg_type must be upwind, downwind, or reaching', null);
    }

    // TWA predicate by leg type (same as race-setup logic: upwind |Twa| <= 90, downwind > 90, reaching = leg 1 / ~90)
    let twaPredicate;
    if (legType === 'upwind') {
      twaPredicate = 'a."Twa_n_deg" < 75';
    } else if (legType === 'downwind') {
      twaPredicate = 'a."Twa_n_deg" > 105';
    } else {
      twaPredicate = 'a."Twa_n_deg" >= 75 AND a."Twa_n_deg" <= 105';
    }

    // Ranking: use Bsp_polar_perc when Point of Sail is REACH (reaching), else Vmg_perc
    const rankColumn = legType === 'reaching' ? 'Bsp_polar_perc' : 'Vmg_perc';
    // Reaching allows grade 1; upwind/downwind use grade > 1 only
    const gradeCondition = legType === 'reaching' ? '>= 1' : '> 1';

    const sourceJoin = `INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${schema}.sources d ON c.source_id = d.source_id`;
    const hasAnySourceFilterCheat = hasSourceFilter || hasSourceNamesFilter;

    let rows;
    if (groupBy === 'channel') {
      let twsLow, twsHigh;
      const twsCenter = tws != null && String(tws).trim() !== '' ? parseFloat(tws) : NaN;
      if (!isNaN(twsCenter)) {
        twsLow = twsCenter - 2.5;
        twsHigh = twsCenter + 2.5;
      } else {
        twsLow = parseFloat(tws_low);
        twsHigh = parseFloat(tws_high);
      }
      if (isNaN(twsLow) || isNaN(twsHigh) || twsLow >= twsHigh) {
        return sendResponse(res, info, 400, false, 'tws is required when group_by=channel (single value, band is tws ± 2.5)', null);
      }
      const percentileTws = `a2."Tws_kph" > ${twsLow - 0.5} AND a2."Tws_kph" < ${twsHigh + 0.5}`;
      const mainTws = `a."Tws_kph" > $${hasAnySourceFilterCheat ? 3 : 2} AND a."Tws_kph" < $${hasAnySourceFilterCheat ? 4 : 3}`;
      const params = hasSourceFilter
        ? [projectId, sourceIdParam, twsLow, twsHigh]
        : hasSourceNamesFilter
          ? [projectId, cheatSourceNamesLower, twsLow, twsHigh]
          : [projectId, twsLow, twsHigh];
      const percentileWhereCheatChannel = hasSourceFilter
        ? `b2.event_type = 'BIN 10' AND a2.agr_type = 'AVG' AND ${percentileTws} AND ${twaPredicate.replace(/^a\./, 'a2.')} AND CAST(b2.tags ->> 'GRADE' AS integer) ${gradeCondition} AND d2.project_id = $1 AND d2.source_id = $2`
        : hasSourceNamesFilter
          ? `b2.event_type = 'BIN 10' AND a2.agr_type = 'AVG' AND ${percentileTws} AND ${twaPredicate.replace(/^a\./, 'a2.')} AND CAST(b2.tags ->> 'GRADE' AS integer) ${gradeCondition} AND d2.project_id = $1 AND LOWER(d2.source_name) = ANY($2::text[])`
          : `b2.event_type = 'BIN 10' AND a2.agr_type = 'AVG' AND ${percentileTws} AND ${twaPredicate.replace(/^a\./, 'a2.')} AND CAST(b2.tags ->> 'GRADE' AS integer) ${gradeCondition} AND d2.project_id = $1`;
      const baseFromCheatChannel = `${schema}.events_aggregate a2
           JOIN ${schema}.dataset_events b2 ON a2.event_id = b2.event_id
           JOIN ${schema}.datasets c2 ON b2.dataset_id = c2.dataset_id
           JOIN ${schema}.sources d2 ON c2.source_id = d2.source_id`;
      const cteCheatQ1 = `(SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a2."${rankColumn}") AS v FROM ${baseFromCheatChannel} WHERE ${percentileWhereCheatChannel})`;
      const cteCheatQ3 = `(SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a2."${rankColumn}") AS v FROM ${baseFromCheatChannel} WHERE ${percentileWhereCheatChannel})`;
      const cteCheatP90Iqr = `(SELECT PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY a2."${rankColumn}") AS v FROM ${baseFromCheatChannel} WHERE ${percentileWhereCheatChannel} AND a2."${rankColumn}" >= (SELECT v FROM q1_c) AND a2."${rankColumn}" <= (SELECT v FROM q3_c))`;
      const sourceWhereCheat = hasSourceFilter ? 'AND d.source_id = $2' : hasSourceNamesFilter ? 'AND LOWER(d.source_name) = ANY($2::text[])' : '';
      const sql = `
        WITH q1_c AS ${cteCheatQ1},
             q3_c AS ${cteCheatQ3},
             p90_iqr_c AS ${cteCheatP90Iqr}
        SELECT
          b.tags ->> 'CONFIG' AS config,
          AVG(a."Bsp_kph") AS bsp,
          AVG(a."Twa_n_deg") AS twa,
          AVG(a."Vmg_kph") AS vmg,
          AVG(a."Heel_n_deg") AS heel_n,
          AVG(a."Pitch_deg") AS pitch,
          AVG(a."RH_lwd_mm") AS rh_lwd,
          AVG(a."RUD_rake_ang_deg") AS rud_rake,
          AVG(a."RUD_diff_ang_deg") AS rud_diff,
          AVG(a."DB_cant_lwd_deg") AS db_cant,
          AVG(a."DB_cant_eff_lwd_deg") AS db_cant_eff,
          AVG(a."DB_cant_stow_tgt_deg") AS db_cant_stow,
          AVG(a."CA1_ang_n_deg") AS wing_ca1,
          AVG(a."WING_twist_n_deg") AS wing_twist,
          AVG(a."WING_clew_pos_mm") AS wing_clew,
          AVG(a."JIB_sheet_load_kgf") AS jib_sht,
          AVG(a."JIB_cunno_load_kgf") AS jib_cunno,
          AVG(a."JIB_lead_ang_deg") AS jib_lead
        FROM ${schema}.events_aggregate a
        JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
        ${sourceJoin}
        WHERE b.event_type = 'BIN 10'
          AND a.agr_type = 'AVG'
          AND d.project_id = $1
          ${sourceWhereCheat}
          AND ${mainTws}
          AND ${twaPredicate}
          AND CAST(b.tags ->> 'GRADE' AS integer) ${gradeCondition}
          AND a."${rankColumn}" >= (SELECT v FROM q1_c)
          AND a."${rankColumn}" <= (SELECT v FROM q3_c)
          AND a."${rankColumn}" >= (SELECT v FROM p90_iqr_c)
        GROUP BY b.tags ->> 'CONFIG'
        ORDER BY b.tags ->> 'CONFIG'`;
      rows = await db.GetRows(sql, params);
    } else {
      // group_by = wind: one row per CONFIG, columns = config, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55 (selected metric per bin)
      const CHEAT_SHEET_METRIC_TO_DB = {
        bsp: 'Bsp_kph',
        twa: 'Twa_n_deg',
        vmg: 'Vmg_kph',
        heel_n: 'Heel_n_deg',
        pitch: 'Pitch_deg',
        rh_lwd: 'RH_lwd_mm',
        rud_rake: 'RUD_rake_ang_deg',
        rud_diff: 'RUD_diff_ang_deg',
        db_cant: 'DB_cant_lwd_deg',
        db_cant_eff: 'DB_cant_eff_lwd_deg',
        db_cant_stow: 'DB_cant_stow_tgt_deg',
        wing_ca1: 'CA1_ang_n_deg',
        wing_twist: 'WING_twist_n_deg',
        wing_clew: 'WING_clew_pos_mm',
        jib_sht: 'JIB_sheet_load_kgf',
        jib_cunno: 'JIB_cunno_load_kgf',
        jib_lead: 'JIB_lead_ang_deg'
      };
      const metricKey = (metric != null && String(metric).trim() !== '' ? String(metric).trim().toLowerCase() : 'bsp');
      const dbColumn = CHEAT_SHEET_METRIC_TO_DB[metricKey];
      if (!dbColumn) {
        return sendResponse(res, info, 400, false, 'metric must be one of: ' + Object.keys(CHEAT_SHEET_METRIC_TO_DB).join(', '), null);
      }
      const bins = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
      const configVal = config != null && String(config).trim() !== '' ? String(config).trim() : null;
      const configFilter = configVal ? `AND (b.tags ->> 'CONFIG') = $${hasAnySourceFilterCheat ? 3 : 2}` : '';
      const percentileWhereCheatWind = hasSourceFilter
        ? `b2.event_type = 'BIN 10' AND a2.agr_type = 'AVG' AND ${twaPredicate.replace(/^a\./, 'a2.')} AND CAST(b2.tags ->> 'GRADE' AS integer) ${gradeCondition} AND d2.project_id = $1 AND d2.source_id = $2`
        : hasSourceNamesFilter
          ? `b2.event_type = 'BIN 10' AND a2.agr_type = 'AVG' AND ${twaPredicate.replace(/^a\./, 'a2.')} AND CAST(b2.tags ->> 'GRADE' AS integer) ${gradeCondition} AND d2.project_id = $1 AND LOWER(d2.source_name) = ANY($2::text[])`
          : `b2.event_type = 'BIN 10' AND a2.agr_type = 'AVG' AND ${twaPredicate.replace(/^a\./, 'a2.')} AND CAST(b2.tags ->> 'GRADE' AS integer) ${gradeCondition} AND d2.project_id = $1`;
      const baseFromCheatWind = `${schema}.events_aggregate a2
           JOIN ${schema}.dataset_events b2 ON a2.event_id = b2.event_id
           JOIN ${schema}.datasets c2 ON b2.dataset_id = c2.dataset_id
           JOIN ${schema}.sources d2 ON c2.source_id = d2.source_id`;
      const cteCheatWindQ1 = `(SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a2."${rankColumn}") AS v FROM ${baseFromCheatWind} WHERE ${percentileWhereCheatWind})`;
      const cteCheatWindQ3 = `(SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a2."${rankColumn}") AS v FROM ${baseFromCheatWind} WHERE ${percentileWhereCheatWind})`;
      const cteCheatWindP90Iqr = `(SELECT PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY a2."${rankColumn}") AS v FROM ${baseFromCheatWind} WHERE ${percentileWhereCheatWind} AND a2."${rankColumn}" >= (SELECT v FROM q1_wc) AND a2."${rankColumn}" <= (SELECT v FROM q3_wc))`;

      const selectParts = ['b.tags ->> \'CONFIG\' AS config'];
      bins.forEach((bin) => {
        const filterBin = `ROUND(a."Tws_kph" / 5) * 5 = ${bin}`;
        selectParts.push(`AVG(a."${dbColumn}") FILTER (WHERE ${filterBin}) AS "${bin}"`);
      });

      const sourceWhereWindCheat = hasSourceFilter ? 'AND d.source_id = $2' : hasSourceNamesFilter ? 'AND LOWER(d.source_name) = ANY($2::text[])' : '';
      const sqlWind = `
        WITH q1_wc AS ${cteCheatWindQ1},
             q3_wc AS ${cteCheatWindQ3},
             p90_iqr_wc AS ${cteCheatWindP90Iqr}
        SELECT ${selectParts.join(', ')}
        FROM ${schema}.events_aggregate a
        JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
        ${sourceJoin}
        WHERE b.event_type = 'BIN 10'
          AND a.agr_type = 'AVG'
          AND ${twaPredicate}
          AND CAST(b.tags ->> 'GRADE' AS integer) ${gradeCondition}
          AND d.project_id = $1
          ${sourceWhereWindCheat}
          ${configFilter}
          AND a."${rankColumn}" >= (SELECT v FROM q1_wc)
          AND a."${rankColumn}" <= (SELECT v FROM q3_wc)
          AND a."${rankColumn}" >= (SELECT v FROM p90_iqr_wc)
        GROUP BY b.tags ->> 'CONFIG'
        ORDER BY b.tags ->> 'CONFIG'`;
      const windParams = hasSourceFilter
        ? (configVal ? [projectId, sourceIdParam, configVal] : [projectId, sourceIdParam])
        : hasSourceNamesFilter
          ? (configVal ? [projectId, cheatSourceNamesLower, configVal] : [projectId, cheatSourceNamesLower])
          : (configVal ? [projectId, configVal] : [projectId]);
      rows = await db.GetRows(sqlWind, windParams);
    }

    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', { rows: rows || [] }, false);
  } catch (err) {
    console.error('getCheatSheet_TableData error:', err);
    if (err && err.stack) console.error('getCheatSheet_TableData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get maneuver cheat sheet table: group by Channel (one row per CONFIG for a wind band) or group by Wind (one row per CONFIG with columns per wind bin).
 * Uses gp50.maneuver_stats + dataset_events, event_type in TACK/GYBE/ROUNDUP/BEARAWAY. Removes outliers via IQR (Q1–Q3 on Loss_total_tgt), then keeps lowest 10% of cleaned set (Loss_total_tgt <= P10 of IQR) and averages metrics per CONFIG.
 * @query class_name, project_id, group_by (channel|wind), tws (when group_by=channel), metric (when group_by=wind), maneuver_type (tack|gybe|roundup|bearaway), source_id (optional)
 */
exports.getManeuverCheatSheet_TableData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getManeuverCheatSheet_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, group_by, tws, maneuver_type, config, source_id, source_names, metric } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const schema = String(class_name).trim();
    const projectId = parseInt(project_id, 10);
    const groupBy = String(group_by || '').trim().toLowerCase();
    const maneuverType = String(maneuver_type || 'tack').trim().toLowerCase();
    const eventTypeUpper = maneuverType.toUpperCase(); // TACK, GYBE, ROUNDUP, BEARAWAY

    let sourceNamesArray = [];
    if (source_names != null && String(source_names).trim() !== '') {
      try {
        const parsed = JSON.parse(source_names);
        sourceNamesArray = Array.isArray(parsed) ? parsed.map(s => String(s).trim()).filter(s => s.length > 0) : [];
      } catch (e) {
        return sendResponse(res, info, 400, false, 'source_names must be a JSON array of strings', null);
      }
    }
    const sourceIdParam = source_id != null && String(source_id).trim() !== '' ? parseInt(source_id, 10) : null;
    const hasSourceNamesFilter = sourceNamesArray.length > 0;
    const hasSourceFilter = !hasSourceNamesFilter && sourceIdParam != null && !isNaN(sourceIdParam) && sourceIdParam > 0;

    if (!schema || isNaN(projectId) || projectId < 1) {
      return sendResponse(res, info, 400, false, 'class_name and project_id are required', null);
    }
    if (groupBy !== 'channel' && groupBy !== 'wind') {
      return sendResponse(res, info, 400, false, 'group_by must be channel or wind', null);
    }
    const validManeuverTypes = ['tack', 'gybe', 'roundup', 'bearaway'];
    if (!validManeuverTypes.includes(maneuverType)) {
      return sendResponse(res, info, 400, false, 'maneuver_type must be tack, gybe, roundup, or bearaway', null);
    }

    const sourceJoin = `INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
        INNER JOIN ${schema}.sources d ON c.source_id = d.source_id`;
    const eventTypeParam = eventTypeUpper;

    const hasAnySourceFilter = hasSourceFilter || hasSourceNamesFilter;
    const sourceNamesLower = sourceNamesArray.map(s => s.toLowerCase());

    let rows;
    if (groupBy === 'channel') {
      const twsCenter = tws != null && String(tws).trim() !== '' ? parseFloat(tws) : NaN;
      if (isNaN(twsCenter)) {
        return sendResponse(res, info, 400, false, 'tws is required when group_by=channel (single value, band is tws ± 2.5)', null);
      }
      const twsLow = twsCenter - 2.5;
      const twsHigh = twsCenter + 2.5;
      const percentileTws = `a2."Tws_avg" > ${twsLow - 0.5} AND a2."Tws_avg" < ${twsHigh + 0.5}`;
      const baseWhereChannel = hasSourceFilter
        ? `d.project_id = $1 AND d.source_id = $2 AND b.event_type = $3 AND CAST(b.tags ->> 'GRADE' AS integer) > 1`
        : hasSourceNamesFilter
          ? `d.project_id = $1 AND LOWER(d.source_name) = ANY($2::text[]) AND b.event_type = $3 AND CAST(b.tags ->> 'GRADE' AS integer) > 1`
          : `d.project_id = $1 AND b.event_type = $2 AND CAST(b.tags ->> 'GRADE' AS integer) > 1`;
      const mainTws = hasAnySourceFilter
        ? 'a."Tws_avg" > $4 AND a."Tws_avg" < $5'
        : 'a."Tws_avg" > $3 AND a."Tws_avg" < $4';
      const percentileWhere = hasSourceFilter
        ? `d2.project_id = $1 AND d2.source_id = $2 AND b2.event_type = $3 AND ${percentileTws} AND CAST(b2.tags ->> 'GRADE' AS integer) > 1`
        : hasSourceNamesFilter
          ? `d2.project_id = $1 AND LOWER(d2.source_name) = ANY($2::text[]) AND b2.event_type = $3 AND ${percentileTws} AND CAST(b2.tags ->> 'GRADE' AS integer) > 1`
          : `d2.project_id = $1 AND b2.event_type = $2 AND ${percentileTws} AND CAST(b2.tags ->> 'GRADE' AS integer) > 1`;
      const baseFromPercentile = `${schema}.maneuver_stats a2
           JOIN ${schema}.dataset_events b2 ON a2.event_id = b2.event_id
           JOIN ${schema}.datasets c2 ON b2.dataset_id = c2.dataset_id
           JOIN ${schema}.sources d2 ON c2.source_id = d2.source_id`;
      const cteQ1 = `(SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a2."Loss_total_tgt") AS v FROM ${baseFromPercentile} WHERE ${percentileWhere})`;
      const cteQ3 = `(SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a2."Loss_total_tgt") AS v FROM ${baseFromPercentile} WHERE ${percentileWhere})`;
      const cteP10Iqr = `(SELECT PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY a2."Loss_total_tgt") AS v FROM ${baseFromPercentile} WHERE ${percentileWhere} AND a2."Loss_total_tgt" >= (SELECT v FROM q1) AND a2."Loss_total_tgt" <= (SELECT v FROM q3))`;
      const params = hasSourceFilter
        ? [projectId, sourceIdParam, eventTypeParam, twsLow, twsHigh]
        : hasSourceNamesFilter
          ? [projectId, sourceNamesLower, eventTypeParam, twsLow, twsHigh]
          : [projectId, eventTypeParam, twsLow, twsHigh];

      const sql = `
        WITH q1 AS ${cteQ1},
             q3 AS ${cteQ3},
             p10_iqr AS ${cteP10Iqr}
        SELECT
          b.tags ->> 'CONFIG' AS config,
          AVG(a."Bsp_drop") AS bsp_drop,
          AVG(a."Drop_time") AS drop_time,
          AVG(a."Turn_rate_max") AS turn_rate_max,
          AVG(ABS(a."Twa_exit")) AS twa_exit,
          AVG(a."Overshoot_angle") AS overshoot_angle,
          AVG(a."Raise_time") AS raise_time,
          AVG(a."Time_two_boards") AS time_two_boards,
          AVG(a."Pitch_accmax") AS pitch_accmax,
          AVG(a."Heel_accmax") AS heel_accmax,
          AVG(a."Cant_eff_accmax") AS cant_eff_accmax,
          AVG(a."Wing_twist_accmax") AS wing_twist_accmax,
          AVG(a."Wing_clew_pos_accmax") AS wing_clew_pos_accmax,
          AVG(a."Jib_sheet_pct_accmax") AS jib_sheet_pct_accmax,
          AVG(a."Jib_lead_ang_accmax") AS jib_lead_ang_accmax,
          AVG(a."Loss_inv_tgt") AS loss_inv_tgt,
          AVG(a."Loss_turn_tgt") AS loss_turn_tgt,
          AVG(a."Loss_build_tgt") AS loss_build_tgt,
          AVG(a."Loss_total_tgt") AS loss_total_tgt
        FROM ${schema}.maneuver_stats a
        JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
        ${sourceJoin}
        WHERE ${baseWhereChannel}
          AND ${mainTws}
          AND a."Loss_total_tgt" >= (SELECT v FROM q1)
          AND a."Loss_total_tgt" <= (SELECT v FROM q3)
          AND a."Loss_total_tgt" <= (SELECT v FROM p10_iqr)
        GROUP BY b.tags ->> 'CONFIG'
        ORDER BY b.tags ->> 'CONFIG'`;
      rows = await db.GetRows(sql, params);
    } else {
      const MANEUVER_CHEAT_SHEET_METRIC_TO_DB = {
        drop_time: 'Drop_time',
        bsp_drop: 'Bsp_drop',
        turn_rate_max: 'Turn_rate_max',
        twa_exit: 'Twa_exit',
        overshoot_angle: 'Overshoot_angle',
        raise_time: 'Raise_time',
        time_two_boards: 'Time_two_boards',
        pitch_accmax: 'Pitch_accmax',
        heel_accmax: 'Heel_accmax',
        cant_eff_accmax: 'Cant_eff_accmax',
        wing_twist_accmax: 'Wing_twist_accmax',
        wing_clew_pos_accmax: 'Wing_clew_pos_accmax',
        jib_sheet_pct_accmax: 'Jib_sheet_pct_accmax',
        jib_lead_ang_accmax: 'Jib_lead_ang_accmax',
        loss_inv_tgt: 'Loss_inv_tgt',
        loss_turn_tgt: 'Loss_turn_tgt',
        loss_build_tgt: 'Loss_build_tgt',
        loss_total_tgt: 'Loss_total_tgt'
      };
      const metricKey = (metric != null && String(metric).trim() !== '' ? String(metric).trim().toLowerCase() : 'drop_time');
      const dbColumn = MANEUVER_CHEAT_SHEET_METRIC_TO_DB[metricKey];
      if (!dbColumn) {
        return sendResponse(res, info, 400, false, 'metric must be one of: ' + Object.keys(MANEUVER_CHEAT_SHEET_METRIC_TO_DB).join(', '), null);
      }
      const bins = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
      const configVal = config != null && String(config).trim() !== '' ? String(config).trim() : null;
      const baseWhereWind = hasSourceFilter
        ? `d.project_id = $1 AND d.source_id = $2 AND b.event_type = $3 AND CAST(b.tags ->> 'GRADE' AS integer) > 1`
        : hasSourceNamesFilter
          ? `d.project_id = $1 AND LOWER(d.source_name) = ANY($2::text[]) AND b.event_type = $3 AND CAST(b.tags ->> 'GRADE' AS integer) > 1`
          : `d.project_id = $1 AND b.event_type = $2 AND CAST(b.tags ->> 'GRADE' AS integer) > 1`;
      const configFilter = configVal
        ? (hasAnySourceFilter ? ' AND (b.tags ->> \'CONFIG\') = $4' : ' AND (b.tags ->> \'CONFIG\') = $3')
        : '';
      const percentileWhereWind = hasSourceFilter
        ? `d2.project_id = $1 AND d2.source_id = $2 AND b2.event_type = $3 AND CAST(b2.tags ->> 'GRADE' AS integer) > 1`
        : hasSourceNamesFilter
          ? `d2.project_id = $1 AND LOWER(d2.source_name) = ANY($2::text[]) AND b2.event_type = $3 AND CAST(b2.tags ->> 'GRADE' AS integer) > 1`
          : `d2.project_id = $1 AND b2.event_type = $2 AND CAST(b2.tags ->> 'GRADE' AS integer) > 1`;
      const baseFromPercentileWind = `${schema}.maneuver_stats a2
           JOIN ${schema}.dataset_events b2 ON a2.event_id = b2.event_id
           JOIN ${schema}.datasets c2 ON b2.dataset_id = c2.dataset_id
           JOIN ${schema}.sources d2 ON c2.source_id = d2.source_id`;
      const cteWindQ1 = `(SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY a2."Loss_total_tgt") AS v FROM ${baseFromPercentileWind} WHERE ${percentileWhereWind})`;
      const cteWindQ3 = `(SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY a2."Loss_total_tgt") AS v FROM ${baseFromPercentileWind} WHERE ${percentileWhereWind})`;
      const cteWindP10Iqr = `(SELECT PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY a2."Loss_total_tgt") AS v FROM ${baseFromPercentileWind} WHERE ${percentileWhereWind} AND a2."Loss_total_tgt" >= (SELECT v FROM q1_w) AND a2."Loss_total_tgt" <= (SELECT v FROM q3_w))`;

      const selectParts = ['b.tags ->> \'CONFIG\' AS config'];
      const avgExpr = dbColumn === 'Twa_exit' ? 'ABS(a."Twa_exit")' : `a."${dbColumn}"`;
      bins.forEach((bin) => {
        const filterBin = `ROUND(a."Tws_avg" / 5) * 5 = ${bin}`;
        selectParts.push(`AVG(${avgExpr}) FILTER (WHERE ${filterBin}) AS "${bin}"`);
      });

      const sqlWind = `
        WITH q1_w AS ${cteWindQ1},
             q3_w AS ${cteWindQ3},
             p10_iqr_w AS ${cteWindP10Iqr}
        SELECT ${selectParts.join(', ')}
        FROM ${schema}.maneuver_stats a
        JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
        ${sourceJoin}
        WHERE ${baseWhereWind}
          ${configFilter}
          AND a."Loss_total_tgt" >= (SELECT v FROM q1_w)
          AND a."Loss_total_tgt" <= (SELECT v FROM q3_w)
          AND a."Loss_total_tgt" <= (SELECT v FROM p10_iqr_w)
        GROUP BY b.tags ->> 'CONFIG'
        ORDER BY b.tags ->> 'CONFIG'`;
      const windParams = hasSourceFilter
        ? (configVal ? [projectId, sourceIdParam, eventTypeParam, configVal] : [projectId, sourceIdParam, eventTypeParam])
        : hasSourceNamesFilter
          ? (configVal ? [projectId, sourceNamesLower, eventTypeParam, configVal] : [projectId, sourceNamesLower, eventTypeParam])
          : (configVal ? [projectId, eventTypeParam, configVal] : [projectId, eventTypeParam]);
      rows = await db.GetRows(sqlWind, windParams);
    }

    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', { rows: rows || [] }, false);
  } catch (err) {
    console.error('getManeuverCheatSheet_TableData error:', err);
    if (err && err.stack) console.error('getManeuverCheatSheet_TableData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get prestart summary table: one row per source for a single race from start_stats (view: prestart | acceleration | leg1).
 * @query class_name, project_id, date (YYYY-MM-DD or YYYYMMDD), race (e.g. '26011805'), view (prestart|acceleration|maxbsp|reach|leg1)
 */
exports.getPrestartSummary_TableData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getPrestartSummary_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date, race, view } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const normalizedDate = String(date).replace(/[-/]/g, '');
    if (normalizedDate.length !== 8) {
      return sendResponse(res, info, 400, false, 'date must be YYYY-MM-DD or YYYYMMDD', null);
    }

    const schema = String(class_name).trim();
    const projectId = parseInt(project_id, 10);
    const raceKey = String(race).trim();
    const viewKey = String(view).trim().toLowerCase();
    if (!schema || isNaN(projectId) || projectId < 1 || !raceKey) {
      return sendResponse(res, info, 400, false, 'class_name, project_id and race are required', null);
    }

    const baseFrom = `
      FROM ${schema}.start_stats a
      INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
      INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
      INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
      INNER JOIN ${schema}.dataset_events race_ev ON race_ev.dataset_id = c.dataset_id AND lower(race_ev.event_type) = 'race' AND race_ev.tags ->> 'Race_number' = $3
      WHERE d.project_id = $1 AND c.date = $2 AND b.tags ->> 'Race_number' = $3`;

    let sql;
    if (viewKey === 'courseaxis') {
      sql = `
        SELECT a."Course_axis" "Course_axis"
        ${baseFrom}
        LIMIT 1`;
    } else if (viewKey === 'prestart') {
      sql = `
        WITH base AS (
          SELECT d.source_id,
            a.event_id, d.source_name AS "TEAM",
            MIN(race_ev.start_time) OVER () AS "race_start_time",
            a."Course_axis" "Course_axis",
            a."Prestart_dist", a."Time_bspmin", a."Bsp_avg_pre", a."Time_turnback", a."DTL_turnback", a."RATIO_turnback", a."TTK_turnback", a."TTK_burn", a."DTL_start", a."LINE_PERC_start", a."Bsp_start", a."Twa_start"
          ${baseFrom}
        )
        SELECT ROW_NUMBER() OVER (ORDER BY "Prestart_dist" DESC NULLS LAST) AS "RANK",
          event_id, "TEAM", "race_start_time", "Course_axis",
          "Prestart_dist", "Time_bspmin", "Bsp_avg_pre", "Time_turnback", "DTL_turnback", "RATIO_turnback", "TTK_turnback", "TTK_burn", "DTL_start", "LINE_PERC_start", "Bsp_start", "Twa_start"
        FROM (
          SELECT DISTINCT ON (source_id) * FROM base ORDER BY source_id, "Prestart_dist" DESC NULLS LAST
        ) sub
        ORDER BY "Prestart_dist" DESC NULLS LAST`;
    } else if (viewKey === 'acceleration') {
      sql = `
        WITH base AS (
          SELECT d.source_id,
            a.event_id, d.source_name AS "TEAM",
            MIN(race_ev.start_time) OVER () AS "race_start_time",
            a."Course_axis" "Course_axis",
            a."Time_accmax", a."Accel_max", a."Bsp_accmax", a."Twa_accmax", a."Heel_accmax", a."RH_lwd_accmax", a."Cant_accmax", a."Jib_sheet_load_accmax", a."Jib_cunno_load_accmax", a."Jib_lead_ang_accmax", a."Wing_clew_pos_accmax", a."Wing_twist_accmax", a."CA1_accmax"
          ${baseFrom}
        )
        SELECT ROW_NUMBER() OVER (ORDER BY "Accel_max" DESC) AS "RANK",
          event_id, "TEAM", "race_start_time", "Course_axis",
          "Time_accmax", "Accel_max", "Bsp_accmax", "Twa_accmax", "Heel_accmax", "RH_lwd_accmax", "Cant_accmax", "Jib_sheet_load_accmax", "Jib_cunno_load_accmax", "Jib_lead_ang_accmax", "Wing_clew_pos_accmax", "Wing_twist_accmax", "CA1_accmax"
        FROM (
          SELECT DISTINCT ON (source_id) * FROM base ORDER BY source_id, "Accel_max" DESC
        ) sub
        ORDER BY "Accel_max" DESC`;
    } else if (viewKey === 'maxbsp') {
      sql = `
        WITH base AS (
          SELECT d.source_id,
            a.event_id, d.source_name AS "TEAM",
            MIN(race_ev.start_time) OVER () AS "race_start_time",
            a."Course_axis" "Course_axis",
            a."Time_bspmax", a."Bsp_max", a."Twa_bspmax", a."Heel_bspmax", a."RH_lwd_bspmax", a."Cant_bspmax", a."Jib_sheet_load_bspmax", a."Jib_cunno_load_bspmax", a."Jib_lead_ang_bspmax", a."Wing_clew_pos_bspmax", a."Wing_twist_bspmax", a."CA1_bspmax"
          ${baseFrom}
        )
        SELECT ROW_NUMBER() OVER (ORDER BY "Bsp_max" DESC) AS "RANK",
          event_id, "TEAM", "race_start_time", "Course_axis",
          "Time_bspmax", "Bsp_max", "Twa_bspmax", "Heel_bspmax", "RH_lwd_bspmax", "Cant_bspmax", "Jib_sheet_load_bspmax", "Jib_cunno_load_bspmax", "Jib_lead_ang_bspmax", "Wing_clew_pos_bspmax", "Wing_twist_bspmax", "CA1_bspmax"
        FROM (
          SELECT DISTINCT ON (source_id) * FROM base ORDER BY source_id, "Bsp_max" DESC
        ) sub
        ORDER BY "Bsp_max" DESC`;
    } else if (viewKey === 'reach') {
      sql = `
        WITH base AS (
          SELECT d.source_id,
            a.event_id, d.source_name AS "TEAM",
            MIN(race_ev.start_time) OVER () AS "race_start_time",
            a."Course_axis" "Course_axis",
            a."Reach_dist", a."Bsp_avg_reach", a."TTK_turnback", a."RATIO_turnback", a."DTL_start", a."LINE_PERC_start", a."Bsp_start", a."Twa_start", a."Accel_max", a."Bsp_max"
          ${baseFrom}
        )
        SELECT ROW_NUMBER() OVER (ORDER BY "Reach_dist" DESC NULLS LAST) AS "RANK",
          event_id, "TEAM", "race_start_time", "Course_axis",
          "Reach_dist", "Bsp_avg_reach", "TTK_turnback", "RATIO_turnback", "DTL_start", "LINE_PERC_start", "Bsp_start", "Twa_start", "Accel_max", "Bsp_max"
        FROM (
          SELECT DISTINCT ON (source_id) * FROM base ORDER BY source_id, "Reach_dist" DESC NULLS LAST
        ) sub
        ORDER BY "Reach_dist" DESC NULLS LAST`;
    } else {
      sql = `
        WITH base AS (
          SELECT d.source_id,
            a.event_id, d.source_name AS "TEAM",
            MIN(race_ev.start_time) OVER () AS "race_start_time",
            a."Course_axis" "Course_axis",
            a."Leg1_dist", a."TTK_turnback", a."RATIO_turnback", a."DTL_start", a."LINE_PERC_start", a."Bsp_start", a."Twa_start", a."Accel_max", a."Bsp_max"
          ${baseFrom}
        )
        SELECT ROW_NUMBER() OVER (ORDER BY "Leg1_dist" DESC NULLS LAST) AS "RANK",
          event_id, "TEAM", "race_start_time", "Course_axis",
          "Leg1_dist", "TTK_turnback", "RATIO_turnback", "DTL_start", "LINE_PERC_start", "Bsp_start", "Twa_start", "Accel_max", "Bsp_max"
        FROM (
          SELECT DISTINCT ON (source_id) * FROM base ORDER BY source_id, "Leg1_dist" DESC NULLS LAST
        ) sub
        ORDER BY "Leg1_dist" DESC NULLS LAST`;
    }

    const rows = await db.GetRows(sql, [projectId, normalizedDate, raceKey]);

    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', { rows: rows || [] }, false);
  } catch (err) {
    console.error('getPrestartSummary_TableData error:', err);
    if (err && err.stack) console.error('getPrestartSummary_TableData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get prestart map data from events_mapdata by event_list and desc (no maneuver_stats join).
 * @query class_name, project_id, event_list (JSON array), desc (e.g. 0_Normalized, 1_Normalized, 2_Normalized)
 */
exports.getPrestart_MapData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getPrestart_MapData' };
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }
  let sql = '';
  try {
    const { class_name, project_id, event_list, desc } = req.query;
    if (!class_name || !desc || !event_list) {
      return sendResponse(res, info, 400, false, 'class_name, desc and event_list are required', null);
    }
    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
    let ids;
    try {
      const raw = JSON.parse(event_list);
      ids = Array.isArray(raw)
        ? raw.map(v => parseInt(v, 10)).filter(v => Number.isInteger(v) && v > 0)
        : [];
    } catch (e) {
      return sendResponse(res, info, 400, false, 'Invalid event_list JSON', null);
    }
    if (ids.length === 0) {
      return sendResponse(res, info, 400, false, 'event_list must contain positive integer event_ids', null);
    }
    const schema = String(class_name).trim();
    sql = `SELECT a.event_id "event_id", e.source_name "source_name", a.json
      FROM ${schema}.events_mapdata a
      INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
      INNER JOIN ${schema}.datasets d ON b.dataset_id = d.dataset_id
      INNER JOIN ${schema}.sources e ON d.source_id = e.source_id
      WHERE e.project_id = $1 AND a.event_id = ANY($2) AND LOWER(a.description) = LOWER($3)`;
    const rows = await db.GetRows(sql, [parseInt(project_id, 10), ids, String(desc).trim()]);
    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', rows || [], false);
  } catch (err) {
    console.error('getPrestart_MapData error:', err);
    if (err && err.stack) console.error('getPrestart_MapData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get prestart timeseries data from events_timeseries by event_list and desc (no maneuver_stats join).
 * @query class_name, project_id, event_list (JSON array), desc (e.g. 0_Basics, 1_Details, 2_Details)
 */
exports.getPrestart_TimeSeriesData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getPrestart_TimeSeriesData' };
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }
  let sql = '';
  try {
    const { class_name, project_id, event_list, desc } = req.query;
    if (!class_name || !desc || !event_list) {
      return sendResponse(res, info, 400, false, 'class_name, desc and event_list are required', null);
    }
    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
    let ids;
    try {
      const raw = JSON.parse(event_list);
      ids = Array.isArray(raw)
        ? raw.map(v => parseInt(v, 10)).filter(v => Number.isInteger(v) && v > 0)
        : [];
    } catch (e) {
      return sendResponse(res, info, 400, false, 'Invalid event_list JSON', null);
    }
    if (ids.length === 0) {
      return sendResponse(res, info, 400, false, 'event_list must contain positive integer event_ids', null);
    }
    const schema = String(class_name).trim();
    sql = `SELECT a.event_id "event_id", e.source_name "source_name", a.json
      FROM ${schema}.events_timeseries a
      INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
      INNER JOIN ${schema}.datasets d ON b.dataset_id = d.dataset_id
      INNER JOIN ${schema}.sources e ON d.source_id = e.source_id
      WHERE e.project_id = $1 AND a.event_id = ANY($2) AND LOWER(a.description) = LOWER($3)`;
    const rows = await db.GetRows(sql, [parseInt(project_id, 10), ids, String(desc).trim()]);
    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', rows || [], false);
  } catch (err) {
    console.error('getPrestart_TimeSeriesData error:', err);
    if (err && err.stack) console.error('getPrestart_TimeSeriesData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};

/**
 * Get race setup table: one row per source_name with position and leg-averaged metrics (upwind / downwind / reaching).
 * @query class_name, project_id, date (YYYY-MM-DD or YYYYMMDD), leg_type (upwind|downwind|reaching), race (optional), data_mode (optional: phases|best_modes|displacement)
 */
exports.getRaceSetup_TableData = async (req, res) => {
  const info = { auth_token: req.cookies?.auth_token, location: 'server_app/data', function: 'getRaceSetup_TableData' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date, leg_type, race, data_mode } = req.query;

    const hasPermission = await check_permissions(req, 'read', project_id);
    if (!hasPermission) {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }

    const normalizedDate = String(date).replace(/[-/]/g, '');
    if (normalizedDate.length !== 8) {
      return sendResponse(res, info, 400, false, 'date must be YYYY-MM-DD or YYYYMMDD', null);
    }

    const schema = String(class_name).trim();
    const projectId = parseInt(project_id, 10);
    const legType = String(leg_type).trim().toLowerCase();
    const validLegTypes = ['upwind', 'downwind', 'reaching'];
    if (!schema || isNaN(projectId) || projectId < 1 || !validLegTypes.includes(legType)) {
      return sendResponse(res, info, 400, false, 'class_name, project_id and leg_type (upwind|downwind|reaching) are required', null);
    }

    const validDataModes = ['phases', 'best_modes', 'displacement'];
    const dataMode = (data_mode != null && validDataModes.includes(String(data_mode).trim().toLowerCase()))
      ? String(data_mode).trim().toLowerCase()
      : 'phases';

    const raceFilter = race != null && String(race).trim() !== '' ? String(race).trim() : null;

    let rows;
    // Shared predicate/conditions for both phase and bin 10 (leg_type, grade, leg_number, order)
    let twaPredicate;
    if (legType === 'upwind') {
      twaPredicate = 'a."Twa_n_deg" < 75';
    } else if (legType === 'downwind') {
      twaPredicate = 'a."Twa_n_deg" > 115';
    } else {
      twaPredicate = 'a."Twa_n_deg" >= 65 AND a."Twa_n_deg" <= 115';
    }
    const gradeCondition = legType === 'reaching' ? '> 0' : '> 1';
    const legNumberCondition = legType === 'reaching'
      ? " AND (b.tags -> 'RACES' ->> 'Leg_number') IS NOT NULL AND (b.tags -> 'RACES' ->> 'Leg_number') ~ '^[0-9]+$' AND CAST(b.tags -> 'RACES' ->> 'Leg_number' AS integer) = 1"
      : '';
    const raceFilterCondition = raceFilter
      ? ` AND (
          (b.tags -> 'RACES' ->> 'Race_number') = $3
          OR EXISTS (
            SELECT 1 FROM ${schema}.dataset_events tr
            WHERE tr.dataset_id = c.dataset_id AND LOWER(tr.event_type) = 'training'
              AND tr.tags->>'HOUR' = $3
              AND b.start_time >= tr.start_time AND b.start_time <= tr.end_time
          )
        )`
      : '';
    const orderByClause = legType === 'reaching'
      ? 'ORDER BY avg_polar_perc DESC NULLS LAST'
      : 'ORDER BY avg_vmg_perc DESC NULLS LAST';

    const eventType = dataMode === 'phases' ? 'phase' : 'bin 10';
    const stateCondition = (dataMode === 'displacement')
      ? " AND (b.tags ->> 'FOILING_STATE') IS NOT NULL AND (b.tags ->> 'FOILING_STATE') ~ '^[0-9]+$' AND CAST(b.tags ->> 'FOILING_STATE' AS integer) > 0"
      : '';

    const sql = `
      WITH pos AS (
        SELECT d2.source_id, AVG(rs."Position") AS position
        FROM ${schema}.race_stats rs
        INNER JOIN ${schema}.dataset_events de ON rs.event_id = de.event_id
        INNER JOIN ${schema}.datasets ds ON de.dataset_id = ds.dataset_id
        INNER JOIN ${schema}.sources d2 ON ds.source_id = d2.source_id
        WHERE d2.project_id = $1 AND ds.date = $2 AND LOWER(de.event_type) = 'race'
        ${raceFilter ? ' AND (de.tags -> \'RACES\' ->> \'Race_number\') = $3' : ''}
        GROUP BY d2.source_id
      ),
      avg_only AS (
        SELECT DISTINCT ON (event_id) event_id, "Tws_kph", "Bsp_kph", "Twa_n_deg", "Vmg_kph", "Vmg_perc", "Bsp_polar_perc",
          "Heel_n_deg", "Pitch_deg", "RH_lwd_mm", "DB_cant_lwd_deg", "DB_cant_eff_lwd_deg", "RUD_rake_ang_deg",
          "WING_clew_pos_mm", "CA1_ang_n_deg", "WING_twist_n_deg", "JIB_sheet_load_kgf", "JIB_lead_ang_deg", "JIB_cunno_load_kgf"
        FROM ${schema}.events_aggregate
        WHERE LOWER(agr_type) = 'avg'
        ORDER BY event_id
      ),
      std_only AS (
        SELECT DISTINCT ON (event_id) event_id, "Heel_n_deg" AS std_heel, "Pitch_deg" AS std_pitch, "RH_lwd_mm" AS std_rh
        FROM ${schema}.events_aggregate
        WHERE LOWER(agr_type) = 'std'
        ORDER BY event_id
      )
      SELECT
        d.source_name,
        pos.position,
        AVG(a."Tws_kph") AS avg_tws,
        AVG(a."Bsp_kph") AS avg_bsp,
        AVG(a."Twa_n_deg") AS avg_twa,
        AVG(a."Vmg_kph") AS avg_vmg_kph,
        AVG(a."Vmg_perc") AS avg_vmg_perc,
        AVG(a."Bsp_polar_perc") AS avg_polar_perc,
        AVG(a."Heel_n_deg") AS avg_heel, AVG(s.std_heel) AS std_heel,
        AVG(a."Pitch_deg") AS avg_pitch, AVG(s.std_pitch) AS std_pitch,
        AVG(a."RH_lwd_mm") AS avg_rh, AVG(s.std_rh) AS std_rh,
        AVG(a."DB_cant_lwd_deg") AS avg_cant,
        AVG(a."DB_cant_eff_lwd_deg") AS avg_cant_eff,
        AVG(a."RUD_rake_ang_deg") AS avg_rud_rake,
        AVG(a."WING_clew_pos_mm") AS avg_wing_clew,
        AVG(a."CA1_ang_n_deg") AS avg_wing_ca1,
        AVG(a."WING_twist_n_deg") AS avg_wing_twist,
        AVG(a."JIB_sheet_load_kgf") AS avg_jib_sheet,
        AVG(a."JIB_lead_ang_deg") AS avg_jib_lead,
        AVG(a."JIB_cunno_load_kgf") AS avg_jib_cunno
      FROM avg_only a
      INNER JOIN ${schema}.dataset_events b ON a.event_id = b.event_id
      INNER JOIN ${schema}.datasets c ON b.dataset_id = c.dataset_id
      INNER JOIN ${schema}.sources d ON c.source_id = d.source_id
      LEFT JOIN std_only s ON s.event_id = b.event_id
      LEFT JOIN pos ON pos.source_id = d.source_id
      WHERE d.project_id = $1
        AND c.date = $2
        AND LOWER(b.event_type) = '${eventType}'
        AND (b.tags ->> 'GRADE') IS NOT NULL AND (b.tags ->> 'GRADE') ~ '^[0-9]+$' AND CAST(b.tags ->> 'GRADE' AS integer) ${gradeCondition}
        ${legNumberCondition}
        ${stateCondition}
        AND ${twaPredicate}
        ${raceFilterCondition}
      GROUP BY d.source_name, pos.position
      ${orderByClause}`;

    const params = raceFilter ? [projectId, normalizedDate, raceFilter] : [projectId, normalizedDate];
    console.log('getRaceSetup_TableData (' + eventType + ' events from events_aggregate) sql:', sql, 'params:', params);
    try {
      rows = await db.GetRows(sql, params);
    } catch (setupErr) {
      const code = setupErr.code || (setupErr.message && String(setupErr.message));
      const msg = setupErr.message ? String(setupErr.message) : '';
      const isMissingTable = code === '42P01' || /relation\s+["']?[\w.]*events_aggregate["']?\s+does not exist/i.test(msg);
      if (isMissingTable) {
        return sendResponse(res, info, 200, true, 'events_aggregate not present for this schema', { rows: [] }, false);
      }
      throw setupErr;
    }

    return sendResponse(res, info, 200, true, (rows?.length || 0) + ' rows returned', { rows: rows || [] }, false);
  } catch (err) {
    console.error('getRaceSetup_TableData error:', err);
    if (err && err.stack) console.error('getRaceSetup_TableData stack:', err.stack);
    return sendResponse(res, info, 500, false, err.message, null, true);
  }
};