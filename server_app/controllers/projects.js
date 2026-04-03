const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');
const { error: logError, debug: logDebug } = require('../../shared/utils/console');

// Retrieve project users
exports.getProjectUsers = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'getProjectUsers'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
      const { project_id } = req.query; 
  
      let result = await check_permissions(req, 'read', project_id)
  
      if (result) {
        let params = [project_id];
        // Note: admin.users_pending table does not have a status column, so we always use 'inactive' for pending users
        let sql = `select email, permission, status from (`
        sql += `select email, permission, 'active' "status" from admin.users a inner join admin.user_projects b on a.user_id = b.user_id where b.project_id = $1 `
        sql +=`union all `
        sql +=`select email, permission, 'inactive' "status" from admin.users_pending where project_id = $1 `
        sql +=`) as Q group by email, permission, status order by permission, email`;
        
        let rows = await db.GetRows(sql, params);

        if (rows) {
            return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
        } else {
            return sendResponse(res, info, 204, false, "No projects found", null);
        }
      } else {
        return sendResponse(res, info, 401, false, "Unauthorized", null);
      }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve all projects
exports.getProjectsByType = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'getProjectsByType'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { type } = req.query; 

        let sql;
        let params = [];

        if (type === "all") {
            if (req.user.user_id === db.GetSuperUser()) {
                sql = `SELECT * FROM admin.projects ORDER BY project_id`;
            } else {
                return sendResponse(res, info, 403, false, "Forbidden: You do not have access to all projects", null);
            }
        } else if (type === "user") {
            sql = `
                SELECT DISTINCT a.project_id, 
                CONCAT(class_name, ' - ', project_name) AS description, 
                TO_CHAR(a.date_modified, 'YYYY-MM-DD') AS date_modified 
                FROM admin.projects a 
                INNER JOIN admin.classes b ON a.class_id = b.class_id 
                LEFT JOIN admin.user_projects c ON a.project_id = c.project_id
                WHERE a.user_id = $1 OR c.user_id = $1
                ORDER BY a.project_id`;
            params = [req.user.user_id];
        } else if (type === "shared") {
            sql = `
                SELECT * FROM admin.projects a 
                INNER JOIN admin.user_projects b ON a.project_id = b.project_id 
                WHERE b.user_id = $1 
                ORDER BY project_id`;
            params = [req.user.user_id];
        } else {
            return sendResponse(res, info, 400, false, "Invalid project type parameter", null);
        }

        const rows = await db.GetRows(sql, params);

        if (rows && rows.length > 0) {
            return sendResponse(res, info, 200, true, rows.length+" rows returned...", rows, false);
        } else {
            return sendResponse(res, info, 204, false, "No projects found", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve class by project_id
exports.getProjectClass = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'getProjectClass'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id } = req.query; 

        let result = await check_permissions(req, 'read', project_id)

        if (result) {
            const sql = `SELECT class_name, icon, size_m FROM admin.classes a INNER JOIN admin.projects b ON a.class_id = b.class_id WHERE project_id = $1 limit 1`;
            const params = [project_id];
            
            let rows = await db.GetRows(sql, params);

            if (rows && rows.length > 0) {
                const row = rows[0];
                // Return object with class_name (for backward compatibility), icon, and size_m
                // Handle both 'icon' and 'Icon' column names, and empty strings
                const iconValue = row.icon || row.Icon || null;
                const icon = (iconValue && iconValue.trim() !== '') ? iconValue : null;
                // Handle size_m (could be numeric or string)
                const sizeM = row.size_m !== null && row.size_m !== undefined ? Number(row.size_m) : null;
                const result = {
                    class_name: row.class_name,
                    icon: icon,
                    size_m: sizeM
                };
                logDebug('[getProjectClass] Returning class data:', { class_name: result.class_name, icon: result.icon, size_m: result.size_m, rawIcon: iconValue });
                return sendResponse(res, info, 200, true, "1 row returned...", result, false);
            } else {
                return sendResponse(res, info, 204, false, "Project Class not found", null);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Retrieve project object
exports.getProjectObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'getProjectObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date, object_name } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      const sql = `SELECT json "value" FROM ${class_name}.project_objects where project_id = $1 and date = $2 and object_name = $3 order by date_modified desc limit 1`;
      const params = [project_id, date, object_name];
      
      let value = await db.GetValue(sql, params);

      if (value != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", value, false);
      } else {
        return sendResponse(res, info, 204, false, 'Project object not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Get latest project object by date
exports.getLatestProjectObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'getLatestProjectObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, object_name } = req.query; 

    let result = await check_permissions(req, 'read', project_id)

    if (result) {
      // Get the latest project object by date (order by date desc, then date_modified desc)
      const sql = `SELECT json, date FROM ${class_name}.project_objects WHERE project_id = $1 AND object_name = $2 ORDER BY date DESC, date_modified DESC LIMIT 1`;
      const params = [project_id, object_name];
      
      let rows = await db.GetRows(sql, params);

      if (rows && rows.length > 0 && rows[0].json != null) {
        return sendResponse(res, info, 200, true, "1 row returned...", { json: rows[0].json, date: rows[0].date }, false);
      } else {
        return sendResponse(res, info, 204, false, 'Project object not found', null);
      } 
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized' , null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Add or update project object
exports.addProjectObject = async (req, res) => {
  const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'addProjectObject'}

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
  }

  try {
    const { class_name, project_id, date, object_name, json } = req.body;

    let result = await check_permissions(req, 'write', project_id)

    if (result) {
      // Check if object exists
      const selectSQL = `SELECT object_id "value" FROM ${class_name}.project_objects WHERE project_id = $1 AND date = $2 AND object_name = $3`;
      const existingObject = await db.GetValue(selectSQL, [project_id, date, object_name]);

      let query, params;
      if (existingObject === null) {
        query = `INSERT INTO ${class_name}.project_objects (project_id, date, object_name, json, date_modified) VALUES ($1, $2, $3, $4::jsonb, CURRENT_DATE)`;
        params = [project_id, date, object_name, json];
      } else {
        query = `UPDATE ${class_name}.project_objects SET json = $4::jsonb, date_modified = CURRENT_DATE WHERE project_id = $1 AND date = $2 AND object_name = $3`;
        params = [project_id, date, object_name, json];
      }

      // Execute query
      const success = await db.ExecuteCommand(query, params);
      const action = existingObject === null ? 'insert' : 'update';
      
      if (success) {
        return sendResponse(res, info, 200, true, `${action} successful`, null, false);
      } else {
        return sendResponse(res, info, 500, false, `${action} failed`, null, true);
      }
    } else {
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Retrieve project by ID
exports.getProject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'getProject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id } = req.query; 

        let result = await check_permissions(req, 'read', project_id)

        if (result) {
            const sql = `SELECT project_id, project_name, a.class_id, class_name, a.speed_units FROM admin.projects a inner join admin.classes b on a.class_id = b.class_id WHERE project_id = $1 limit 1`;
            const params = [project_id];
            
            let rows = await db.GetRows(sql, params);

            if (rows) {
                return sendResponse(res, info, 200, true, "1 row returned...", rows[0], false);
            } else {
                return sendResponse(res, info, 204, false, "Project not found", null);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Helper function to initialize default pages for a new project
async function initializeProjectPages(project_id, class_name, user_id) {
  try {
    logDebug(`Initializing default pages for project ${project_id} in class ${class_name}`);
    
    // Get all pages with permission_level <= 2 (default for new projects)
    // This includes basic pages that should be available to all projects
    const pagesSql = `SELECT page_id, page_type FROM ${class_name}.pages WHERE permission_level <= 2 ORDER BY sort_id`;
    const pages = await db.GetRows(pagesSql, []);
    
    if (!pages || pages.length === 0) {
      logDebug(`No pages found for class ${class_name} with permission_level <= 2`);
      return true; // Not an error - class might not have pages configured yet
    }
    
    // Insert all pages into project_pages
    const insertProjectPagesSql = `
      INSERT INTO ${class_name}.project_pages (project_id, page_id, date_modified)
      VALUES ($1, $2, CURRENT_DATE)
      ON CONFLICT (project_id, page_id) DO NOTHING
    `;
    
    let projectPagesCount = 0;
    for (const page of pages) {
      const insertResult = await db.ExecuteCommand(insertProjectPagesSql, [project_id, page.page_id]);
      if (insertResult) {
        projectPagesCount++;
      }
    }
    
    logDebug(`Inserted ${projectPagesCount} pages into project_pages for project ${project_id}`);
    
    // Also initialize user_pages with default explore pages for the creating user
    // This ensures the sidebar shows menus when viewing datasets
    const explorePages = pages.filter(p => p.page_type && p.page_type.indexOf('explore') > -1);
    
    if (explorePages.length > 0) {
      const insertUserPagesSql = `
        INSERT INTO ${class_name}.user_pages (user_id, page_id, date_modified)
        VALUES ($1, $2, CURRENT_DATE)
        ON CONFLICT (user_id, page_id) DO NOTHING
      `;
      
      let userPagesCount = 0;
      for (const page of explorePages) {
        const insertResult = await db.ExecuteCommand(insertUserPagesSql, [user_id, page.page_id]);
        if (insertResult) {
          userPagesCount++;
        }
      }
      
      logDebug(`Inserted ${userPagesCount} explore pages into user_pages for user ${user_id}`);
    }
    
    return true;
  } catch (error) {
    logError(`Error initializing project pages for project ${project_id} in class ${class_name}:`, error);
    // Don't throw - allow project creation to succeed even if page initialization fails
    return false;
  }
}

// Add a new project
exports.addProject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'addProject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_name, class_id } = req.body;
        const user_id = req.user.user_id

        let sql = `SELECT project_id "value" from admin.projects WHERE project_name = $1 and class_id = $2 and user_id = $3 order by project_id desc limit 1`;
        let params = [project_name,class_id,user_id];

        let project_id = await db.GetValue(sql, params);

        if (project_id == null) {
            let result = await check_permissions(req, 'write', project_id)

            if (result) {
                sql = `INSERT INTO admin.projects (project_name, class_id, user_id) VALUES ($1, $2, $3)`;
                params = [project_name,class_id,user_id];
                
                let result = await db.ExecuteCommand(sql, params);
            
                if (result) {
                    sql = `SELECT project_id "value" from admin.projects WHERE user_id = $1 order by project_id desc limit 1`;
                    params = [user_id]
                
                    project_id = await db.GetValue(sql, params);
                
                    if (project_id != null) {
                        sql = `INSERT INTO admin.user_projects (user_id, project_id, permission) VALUES ($1, $2, $3)`;
                        params = [user_id, project_id,'administrator'];
                
                        result = await db.ExecuteCommand(sql, params);
                
                        if (result) {
                            // Get class_name for page initialization
                            sql = `SELECT class_name "value" FROM admin.classes WHERE class_id = $1`;
                            params = [class_id];
                            const class_name = await db.GetValue(sql, params);
                            
                            if (class_name) {
                                // Initialize default pages for the new project
                                await initializeProjectPages(project_id, class_name, user_id);
                            }
                            
                            return sendResponse(res, info, 201, true, "Project added successfully", project_id);
                        } else {
                            return sendResponse(res, info, 500, false, "Failed to add project user", null, true);
                        }
                    } else {
                        return sendResponse(res, info, 500, false, "Failed to add project", null, true);
                    }
                } else {
                    return sendResponse(res, info, 500, false, "Failed to add project", null, true);
                }
            } else {
                return sendResponse(res, info, 401, false, "Unauthorized", null);
            }
        } else {
            return sendResponse(res, info, 200, true, "Project found!", project_id, false);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Update project by ID
exports.updateProject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'updateProject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id, project_name, class_id, speed_units } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            const sql = `UPDATE admin.projects SET project_name = $1, class_id = $2, speed_units = $3 WHERE project_id = $4`;
            const params = [project_name, class_id, speed_units ?? null, project_id];

            result = await db.ExecuteCommand(sql, params);

            if (result) {
                return sendResponse(res, info, 200, true, "Project updated successfully", null, false);
            } else {
                return sendResponse(res, info, 500, false, "Failed to updated project", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Update user project permission
exports.updateUserProjectPermission = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'updateUserProjectPermission'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id, email, permission } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            // First get user_id from email
            const userSql = `SELECT user_id FROM admin.users WHERE email = $1`;
            const userRows = await db.GetRows(userSql, [email]);

            if (!userRows || userRows.length === 0) {
                return sendResponse(res, info, 404, false, "User not found", null, true);
            }

            const user_id = userRows[0].user_id;

            // Update permission in user_projects
            const sql = `UPDATE admin.user_projects SET permission = $3 WHERE user_id = $1 AND project_id = $2`;
            const params = [user_id, project_id, permission];

            result = await db.ExecuteCommand(sql, params);

            if (result) {
                return sendResponse(res, info, 200, true, "User project permission updated successfully", null, false);
            } else {
                return sendResponse(res, info, 500, false, "Failed to update user project permission", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Remove user from project (handles both active and pending users)
exports.removeUserFromProject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'removeUserFromProject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
    
    try {
        const { project_id, email } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            // First, try to remove from user_projects (active users)
            const userSql = `SELECT user_id FROM admin.users WHERE email = $1`;
            const userRows = await db.GetRows(userSql, [email]);

            if (userRows && userRows.length > 0) {
                const user_id = userRows[0].user_id;
                const deleteUserProjectSql = `DELETE FROM admin.user_projects WHERE user_id = $1 AND project_id = $2`;
                const deleteResult = await db.ExecuteCommand(deleteUserProjectSql, [user_id, project_id]);
                
                if (deleteResult) {
                    return sendResponse(res, info, 200, true, "User removed from project successfully", null, false);
                }
            }

            // If not found in user_projects, try to remove from users_pending
            const deletePendingSql = `DELETE FROM admin.users_pending WHERE project_id = $1 AND email = $2`;
            const deletePendingResult = await db.ExecuteCommand(deletePendingSql, [project_id, email]);

            if (deletePendingResult) {
                return sendResponse(res, info, 200, true, "Pending user removed from project successfully", null, false);
            } else {
                return sendResponse(res, info, 404, false, "User not found in project", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Delete project by ID
exports.deleteProject = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/projects', "function": 'deleteProject'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }
    
    try {
        const { project_id } = req.body;

        result = await check_permissions(req, 'delete', project_id)

        if (result) {
            const sql = `DELETE FROM admin.projects WHERE project_id = $1`;
            const params = [project_id];

            result = await db.ExecuteCommand(sql, params);

            if (result) {
                return sendResponse(res, info, 200, true, "Project deleted successfully", null, false);
            } else {
                return sendResponse(res, info, 500, false, "Failed to delete project", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};