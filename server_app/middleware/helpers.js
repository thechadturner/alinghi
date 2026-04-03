const { logMessage } = require("./logging");
const { error: logError, warn: logWarn } = require('../../shared');

const getSourceColor = (source_name) => {
    switch (source_name.toUpperCase()) {
        case 'ITA':
            return "#008000"; // Green
        case 'SUI':
            return "#FF0000"; // Red
        case 'FRA':
            return "#800080"; // Purple
        case 'NZL':
            return "#000000"; // Black (Confirm if correct)
        case 'GBR':
            return "#FFA500"; // Orange
        case 'USA':
            return "#0000FF"; // Blue
        default:
            return "#00008B"; // Dark Blue (Default)
    }
}

const isValidateName = (name) => {
    const nameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    return nameRegex.test(name);
}

const isValidateTargetName = (name) => {
    // Allow target names with letters, numbers, spaces, underscores, hyphens, and dots
    // This matches file names which can have spaces, dots, and start with numbers
    const targetNameRegex = /^[a-zA-Z0-9_\-\.\s]+$/;
    return targetNameRegex.test(name) && name.trim().length > 0 && name.length <= 255;
}

// Media source names (e.g. "Camera 1") - allow letters, numbers, spaces, underscores; must be non-empty
const isValidateMediaSourceName = (name) => {
    if (typeof name !== 'string' || !name.trim()) return false;
    const mediaSourceRegex = /^[a-zA-Z0-9_\s]+$/;
    return mediaSourceRegex.test(name) && name.length <= 255;
}

const isValidatePath = (path) => {
    // Allow paths with forward slashes, alphanumeric characters, underscores, hyphens, and dots
    // Examples: "folder/file.js", "src/components/Button.jsx", "ac40/dataset/explore/TimeSeries"
    const pathRegex = /^[a-zA-Z0-9_\-\.\/]+$/;
    return pathRegex.test(path);
}

/**
 * Map legacy PostgreSQL class schema names to the current schema (after migrations).
 * Clients may still send gp50 from cached state while the DB schema was renamed to ac40.
 * @param {string|undefined|null} class_name
 * @returns {string|undefined|null}
 */
function normalizeClassSchemaName(class_name) {
    if (class_name == null || typeof class_name !== 'string') {
        return class_name;
    }
    const trimmed = class_name.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'gp50') {
        return 'ac40';
    }
    return trimmed;
}

const sanitizeChannelNames = (channelString) => {
    try {
        const channelNames = JSON.parse(channelString);

        // Ensure it's an array
        if (!Array.isArray(channelNames)) {
            logError('Channel names must be an array, got:', typeof channelNames);
            return [];
        }

        // Regex to allow only letters, numbers, and underscores
        const safePattern = /^[a-zA-Z0-9_]+$/;
        
        const sqlInjectionKeywords = [
            "SELECT", "DROP", "DELETE", "INSERT", "UPDATE", "EXEC", "UNION", "--", ";", 
            " OR ", " AND ", "' OR 1=1", "\" OR \"1\"=\"1\"", "' OR '1'='1'"
        ];

        // Trim, validate, and preserve original case
        const cleaned = channelNames
            .map(n => (typeof n === 'string' ? n.trim() : ''))
            .filter(name => {
                if (!name) return false;
                const nameUpper = name.toUpperCase(); // only for keyword check
                if (!safePattern.test(name)) {
                    logWarn(`Warning: '${name}' contains unsafe characters!`);
                    return false;
                }
                // Check for SQL injection keywords, but only if the entire name matches or contains dangerous patterns
                // Allow legitimate channel names that contain keywords as substrings (e.g., "Drop_time", "Bsp_drop")
                // Only flag if the name is exactly a keyword or contains dangerous SQL patterns
                const isExactKeyword = sqlInjectionKeywords.includes(nameUpper);
                const hasDangerousPattern = sqlInjectionKeywords.some(keyword => {
                    // Only flag if keyword appears as a standalone word or dangerous pattern
                    // Keywords like "DROP" should only be flagged if they're the entire name or part of a dangerous pattern
                    if (keyword.length > 2) {
                        // For multi-character keywords, check if they appear as exact matches or dangerous patterns
                        return nameUpper === keyword || 
                               (keyword.includes(' OR ') && nameUpper.includes(' OR ')) ||
                               (keyword.includes(' AND ') && nameUpper.includes(' AND ')) ||
                               (keyword.includes("' OR 1=1") && nameUpper.includes("' OR 1=1"));
                    }
                    return false;
                });
                if (isExactKeyword || hasDangerousPattern) {
                    logWarn(`Warning: '${name}' contains potential SQL injection keywords!`);
                    return false;
                }
                return true;
            });

        return cleaned;
    } catch (err) {
        logError('Error parsing channel names JSON:', err);
        logError('Channel string received:', channelString);
        return [];
    }
}

const listtostring = (list) => {
    let string = undefined
    list.forEach(item => {
        if (string == undefined) {
            string = `"${item}"`
        } else {
            string += `, "${item}"`
        }
    })

    return string;
}

function getAuthToken(authHeader) {
    if (typeof authHeader !== 'string' || authHeader.trim() === '') {
      return undefined;
    }
    
    let splitheader = authHeader;
    if (authHeader.startsWith("Bearer ")) {
        splitheader = authHeader.split(" ")[1];
    }

    if (typeof splitheader !== 'string' || splitheader.trim() === '' || splitheader === 'null' ) {
        return undefined;
    }
    
    return splitheader;
}

const sendResponse = (res, info, status, success, message, data = null, log = false) => {
    let state;
    switch (status) {
    case 500:
        state = 'error';
        break;
    case 200:
        state = 'info';
        break;
    case 201:
        state = 'info';
        break;
    case 204:
        state = 'info';
        break;
    default:
        state = 'warning';
    }

    // Send response immediately without waiting for logging
    if (status === 204) {
        res.status(status).end();
    } else if (data != null) {
        res.status(status).json({ "success": success, "data": data });
    } else {
        res.status(status).json({ "success": success, "message": message });
    }

    // Handle logging asynchronously (don't await)
    if ((state !== 'info' && info) || (log == true && info)){
        setImmediate(async () => {
            try {
                let auth_token = getAuthToken(info.auth_token)

                await logMessage(
                    auth_token || null,
                    info.location || 'unknown',
                    state,
                    info.function || 'unknown',
                    message
                );
            } catch (err) {
                logError('Async logging error:', err.message);
            }
        });
    }
}

/**
 * Get dataset timezone from database
 * @param {string} class_name - Class name (schema)
 * @param {number} dataset_id - Dataset ID
 * @param {object} db - Database module with GetValue method
 * @returns {Promise<string|null>} Timezone string or null if not found
 */
async function getDatasetTimezone(class_name, dataset_id, db) {
    try {
        const schema = normalizeClassSchemaName(class_name);
        const sql = `SELECT timezone FROM ${schema}.datasets WHERE dataset_id = $1 LIMIT 1`;
        const params = [dataset_id];
        const timezone = await db.GetValue(sql, params);
        
        // Return timezone if it's a valid non-empty string, otherwise return null
        if (timezone && typeof timezone === 'string' && timezone.trim() !== '') {
            return timezone.trim();
        }
        return null;
    } catch (error) {
        logError('Error getting dataset timezone:', error);
        return null;
    }
}

/**
 * Format datetime column with timezone conversion for SQL
 * Returns timezone-aware ISO 8601 strings (e.g., '2024-01-01T12:00:00+01:00')
 * @param {string} columnName - Column name (e.g., 'start_time', 'a."Datetime"')
 * @param {string|null} timezone - Timezone string (e.g., 'UTC', 'Europe/Madrid') or null for UTC default
 * @param {string|null} alias - Optional alias for the column (e.g., '"start_time"')
 * @returns {string} SQL fragment for timezone-aware datetime conversion
 */
function formatDatetimeWithTimezone(columnName, timezone, alias = null) {
    // Default to UTC if timezone is null, undefined, or empty
    const tz = (timezone && typeof timezone === 'string' && timezone.trim() !== '') 
        ? timezone.trim() 
        : 'UTC';
    
    // Escape timezone name to prevent SQL injection (basic validation)
    // PostgreSQL timezone names are typically alphanumeric with underscores, slashes, and hyphens
    const tzPattern = /^[a-zA-Z0-9_\/\-]+$/;
    if (!tzPattern.test(tz)) {
        logWarn(`Invalid timezone format: ${tz}, defaulting to UTC`);
        const safeTz = 'UTC';
        // For UTC, return ISO string with Z suffix
        const sql = `to_char(${columnName} AT TIME ZONE '${safeTz}', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
        return alias ? `${sql} AS ${alias}` : sql;
    }
    
    // For UTC, return ISO string with Z suffix
    if (tz.toUpperCase() === 'UTC') {
        const sql = `to_char(${columnName} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
        return alias ? `${sql} AS ${alias}` : sql;
    }
    
    // For other timezones, convert to target timezone and format as ISO with offset
    // Strategy: 
    // 1. Convert UTC timestamptz to timestamp in target timezone
    // 2. Convert that timestamp back to timestamptz (interpreting it as being in target tz)
    // 3. Calculate offset as difference between original UTC and converted UTC
    // 4. Format as ISO 8601 with offset
    const sql = `(
        SELECT 
            to_char(ts_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 
            CASE 
                WHEN offset_sec >= 0 
                THEN '+' || LPAD((offset_sec / 3600)::int::text, 2, '0') || 
                     ':' || LPAD(((offset_sec % 3600) / 60)::int::text, 2, '0')
                ELSE '-' || LPAD((ABS(offset_sec) / 3600)::int::text, 2, '0') || 
                     ':' || LPAD(((ABS(offset_sec) % 3600) / 60)::int::text, 2, '0')
            END
        FROM (
            SELECT 
                ${columnName} AT TIME ZONE '${tz}' AS ts_local,
                EXTRACT(EPOCH FROM ((${columnName} AT TIME ZONE '${tz}') AT TIME ZONE '${tz}')) - 
                EXTRACT(EPOCH FROM ${columnName}) AS offset_sec
        ) AS tz_data
    )`;
    
    return alias ? `${sql} AS ${alias}` : sql;
}

/**
 * Format datetime column as UTC ISO string (no timezone conversion).
 * Used by performance/maneuver endpoints; clients use row timezone for display.
 * @param {string} columnName - Column name (e.g., 'a."Datetime"')
 * @param {string|null} alias - Optional alias (e.g., '"Datetime"')
 * @returns {string} SQL fragment: to_char(column AT TIME ZONE 'UTC', '...Z') AS alias
 */
function formatDatetimeUTC(columnName, alias = null) {
    const sql = `to_char(${columnName} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    return alias ? `${sql} AS ${alias}` : sql;
}

module.exports = {
    getAuthToken,
    getSourceColor,
    isValidateName,
    isValidateMediaSourceName,
    isValidateTargetName,
    isValidatePath,
    normalizeClassSchemaName,
    sanitizeChannelNames,
    listtostring,
    sendResponse,
    getDatasetTimezone,
    formatDatetimeWithTimezone,
    formatDatetimeUTC
};