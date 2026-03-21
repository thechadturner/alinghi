const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');

/**
 * Build params and SQL for querying day_pages by project_id and date.
 * Used for date-gated day content (e.g. day/reports after pipelines upsert day_pages). Not used for day/explore (user_pages).
 * @param {string} class_name - Schema/class name
 * @param {number} project_id - Project id
 * @param {string} dateNorm - Date in YYYYMMDD
 * @param {string|null} [page_type] - If provided, filter by a.page_type (e.g. 'day/reports'); otherwise return all pages for the date
 * @returns {{ params: any[], sql: string }}
 */
function buildDayPagesQuery(class_name, project_id, dateNorm, page_type) {
    const orderBy = ' order by a.sort_id asc nulls last, a.page_id asc';
    if (page_type) {
        const sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.day_pages b on a.page_id = b.page_id where b.project_id = $1 and b.date = to_date($2, 'YYYYMMDD') and a.page_type = $3` + orderBy;
        return { params: [project_id, dateNorm, page_type], sql };
    }
    const sql = `SELECT a.page_name, a.description, CONCAT('${class_name}','/',a.page_type,'/',a.path_name) "file_path", a.icon, a.is_multiple, a.has_builder FROM ${class_name}.pages a INNER JOIN ${class_name}.day_pages b ON a.page_id = b.page_id WHERE b.project_id = $1 AND b.date = to_date($2, 'YYYYMMDD')` + orderBy;
    return { params: [project_id, dateNorm], sql };
}

function normalizeDateParam(date) {
    if (!date || typeof date !== 'string') return '';
    return String(date).trim().replace(/[-/]/g, '');
}

exports.getPageSelection = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/pages', "function": 'getPageSelection'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { class_name, project_id, user_id, page_type } = req.query; 
    
        let result = await check_permissions(req, 'read', project_id)
    
        if (result) {
            let params = [user_id, project_id, page_type];
            let sql = `select page_name, selected from (
            select page_name, true "selected", sort_id 
            FROM ${class_name}.pages a 
            inner join ${class_name}.project_pages b on a.page_id = b.page_id and b.is_visible = 1
            inner join ${class_name}.user_pages c on a.page_id = c.page_id
            WHERE page_type = $3 and user_id = $1 and project_id = $2
            UNION ALL
            SELECT page_name, false "selected", sort_id
            FROM ${class_name}.pages a
            inner join ${class_name}.project_pages b on a.page_id = b.page_id and b.is_visible = 1
            WHERE page_name NOT IN (
                SELECT page_name 
                FROM ${class_name}.pages a 
                INNER JOIN ${class_name}.project_pages b ON a.page_id = b.page_id AND b.is_visible = 1
                INNER JOIN ${class_name}.user_pages c ON b.page_id = c.page_id 
                WHERE page_type = $3 AND user_id = $1 AND project_id = $2
            ) and page_type = $3 and project_id = $2) Q order by sort_id`
            
            let rows = await db.GetRows(sql, params);

            if (rows) {
                return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
            } else {
                return sendResponse(res, info, 204, false, 'No pages found' , null);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized' , null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

exports.getPages = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/pages', "function": 'getPages'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { class_name, project_id, user_id, page_type, dataset_id, date } = req.query;

        let result = await check_permissions(req, 'read', project_id);

        if (result) {
            let params;
            let sql;

            if (page_type.indexOf('dataset') > -1) {
                if (page_type.indexOf('explore') > -1) {
                    // dataset/explore: user-specific explore pages (user_pages); fallback to project_pages when user_id not provided (e.g. add-dataset state)
                    if (user_id != null && String(user_id).trim() !== '') {
                        params = [user_id, page_type];
                        sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.user_pages b on a.page_id = b.page_id where user_id = $1 and page_type = $2 order by sort_id`;
                    } else {
                        params = [project_id, page_type];
                        sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.project_pages b on a.page_id = b.page_id and b.is_visible = 1 where b.project_id = $1 and page_type = $2 order by sort_id`;
                    }
                } else {
                    // dataset/reports: dataset_pages when dataset_id provided, else project_pages
                    const datasetId = dataset_id != null ? parseInt(dataset_id, 10) : null;
                    if (datasetId && !isNaN(datasetId)) {
                        params = [datasetId, page_type];
                        sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.dataset_pages b on a.page_id = b.page_id where b.dataset_id = $1 and a.page_type = $2 order by a.sort_id`;
                    } else {
                        params = [project_id, page_type];
                        sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.project_pages b on a.page_id = b.page_id and b.is_visible = 1 where b.project_id = $1 and page_type = $2 order by sort_id`;
                    }
                }
            } else if (page_type.indexOf('day') > -1 && page_type.indexOf('explore') > -1) {
                // day/explore: user-chosen widgets (user_pages), same pattern as dataset/explore; not scoped by day_pages/date
                if (user_id != null && String(user_id).trim() !== '') {
                    params = [user_id, page_type];
                    sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.user_pages b on a.page_id = b.page_id where user_id = $1 and page_type = $2 order by sort_id`;
                } else {
                    params = [project_id, page_type];
                    sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.project_pages b on a.page_id = b.page_id and b.is_visible = 1 where b.project_id = $1 and page_type = $2 order by sort_id`;
                }
            } else if (page_type.indexOf('day') > -1) {
                const dateNorm = normalizeDateParam(date);
                if (!dateNorm || dateNorm.length !== 8) {
                    return sendResponse(res, info, 400, false, 'date is required (YYYY-MM-DD or YYYYMMDD) for day page types that use day_pages (e.g. day/reports)', null);
                }
                const dayQuery = buildDayPagesQuery(class_name, project_id, dateNorm, page_type);
                params = dayQuery.params;
                sql = dayQuery.sql;
            } else {
                params = [project_id, page_type];
                sql = `select page_name, description, CONCAT('${class_name}','/',page_type,'/',path_name) "file_path", icon, is_multiple, has_builder from ${class_name}.pages a inner join ${class_name}.project_pages b on a.page_id = b.page_id and b.is_visible = 1 where b.project_id = $1 and page_type = $2 order by sort_id`;
            }

            let rows = await db.GetRows(sql, params);

            if (rows) {
                return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
            } else {
                return sendResponse(res, info, 204, false, 'No pages found' , null);
            }
        } else {
            return sendResponse(res, info, 401, false, 'Unauthorized' , null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

