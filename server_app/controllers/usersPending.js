const db = require("../middleware/db");
const { validationResult } = require('express-validator');
const { check_permissions } = require('../middleware/auth_jwt');
const { sendResponse } = require('../middleware/helpers');
const { log, error: logError } = require('../../shared');
const emailService = require('../middleware/email');

// Retrieve all pending users
exports.getPendingUsers = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/usersPending', "function": 'getPendingUsers'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id } = req.query;

        let result = await check_permissions(req, 'read', project_id)

        if (result) {
            const sql = "SELECT * FROM admin.users_pending where project_id = $1";
            const params = [ project_id ];

            let rows = await db.GetRows(sql, params)

            if (rows) {
                return sendResponse(res, info, 200, true, rows.length+" records found", rows, false);
            } else {
                return sendResponse(res, info, 500, false, "Failed to retrieve pending users", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Add a new pending user
exports.addPendingUser = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/usersPending', "function": 'addPendingUser'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id, email, permission } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            // Try to include status column if it exists, otherwise just use the basic columns
            // First try with status column
            let sql = "INSERT INTO admin.users_pending (project_id, email, permission, status) VALUES ($1, $2, $3, $4)";
            let params = [project_id, email, permission, 'pending'];
            
            log(sql, params)
            
            let insertResult = await db.ExecuteCommand(sql, params)
        
            if (!insertResult) {
                // If insert failed, try without status column (column may not exist)
                sql = "INSERT INTO admin.users_pending (project_id, email, permission) VALUES ($1, $2, $3)";
                params = [project_id, email, permission];
                log('Retrying without status column:', sql, params);
                insertResult = await db.ExecuteCommand(sql, params);
            }
            
            if (insertResult) {
                return sendResponse(res, info, 201, true, "Pending user added successfully", null);
            } else {
                return sendResponse(res, info, 500, false, "Failed to added pending user", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};
  
// Update a pending user's permission
exports.updatePendingUser = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/usersPending', "function": 'updatePendingUser'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id, email, permission } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            const sql = "UPDATE admin.users_pending SET permission = $3 WHERE project_id = $1 AND email = $2";
            const params = [project_id, email, permission];
        
            let result = await db.ExecuteCommand(sql, params)
        
            if (result) {
                return sendResponse(res, info, 200, true, "Pending user permission updated successfully", null, false);
            } else {
                return sendResponse(res, info, 500, false, "Failed to update pending user permission", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Delete a pending user
exports.deletePendingUser = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/usersPending', "function": 'deletePendingUser'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id, email } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            const sql = "DELETE FROM admin.users_pending WHERE project_id = $1 and email = $2";
            const params = [ project_id, email ];
        
            let result = await db.ExecuteCommand(sql, params)
        
            if (result) {
                return sendResponse(res, info, 200, true, "Pending user deleted successfully", null, false);
            } else {
                return sendResponse(res, info, 500, false, "Failed to delete pending user", null, true);
            }
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};

// Send invitation email to pending user
exports.sendInvite = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_app/usersPending', "function": 'sendInvite'}

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null);
    }

    try {
        const { project_id, email, permission } = req.body;

        let result = await check_permissions(req, 'write', project_id)

        if (result) {
            // Get admin's first name
            const adminFirstName = req.user.first_name || 'Administrator';
            
            // Get project info to retrieve class_name and project_name
            const projectSql = `SELECT project_id, project_name, a.class_id, class_name FROM admin.projects a inner join admin.classes b on a.class_id = b.class_id WHERE project_id = $1 limit 1`;
            const projectRows = await db.GetRows(projectSql, [project_id]);
            
            if (!projectRows || projectRows.length === 0) {
                return sendResponse(res, info, 404, false, "Project not found", null);
            }
            
            const projectName = projectRows[0].project_name;
            const class_name = projectRows[0].class_name.toLowerCase();
            
            // Get project header from project_objects
            let projectHeader = "RACESIGHT";
            try {
                const today = '1970-01-01'; // YYYY-MM-DD format
                const headerSql = `SELECT json "value" FROM ${class_name}.project_objects where project_id = $1 and date = $2 and object_name = $3 order by date_modified desc limit 1`;
                const headerValue = await db.GetValue(headerSql, [project_id, today, 'header']);
                
                if (headerValue) {
                    const headerObj = typeof headerValue === 'string' ? JSON.parse(headerValue) : headerValue;
                    projectHeader = headerObj?.header || "RACESIGHT";
                }
            } catch (headerError) {
                logError('Error fetching project header:', headerError);
                // Use default header
            }
            
            // Get base URL for registration link
            // Try to get from environment or construct from request
            const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || 'https://racesight.cloud';
            const registrationUrl = `${frontendUrl}/register`;
            
            // Generate HTML email template
            const htmlContent = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <p>Hello,</p>
                    <p>You've been invited to join <strong>${projectHeader}</strong> on RACESIGHT.cloud.</p>
                    <p>To get started, please click the button below to register your account:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${registrationUrl}" style="display: inline-block; padding: 12px 24px; background-color: #0066cc; color: #ffffff; text-decoration: none; border-radius: 5px; font-weight: bold;">Register Now</a>
                    </div>
                    <p>If you don't recognize this message, please ignore this email.</p>
                    <p>
                        Thank you,<br><br>
                        The RACESIGHT Team
                    </p>
                </div>
            `;
            
            // Generate plain text version
            const textContent = `Hello,

You've been invited to join ${projectHeader} on RACESIGHT.cloud.

To get started, please visit ${registrationUrl} to register your account.

If you don't recognize this message, please ignore this email.

Thank you,

The RACESIGHT Team`;

            // Send email
            const emailResult = await emailService.sendHtmlEmail(
                email,
                `You've been invited to join ${projectHeader} on RACESIGHT.cloud`,
                htmlContent,
                textContent
            );

            if (!emailResult.success) {
                logError(`Failed to send invitation email to ${email}:`, emailResult.error);
                return sendResponse(res, info, 500, false, `Failed to send invitation email: ${emailResult.error}`, null, true);
            }
            
            // Update user status from "pending" to "invited"
            // Try to update status column if it exists
            const updateSql = "UPDATE admin.users_pending SET status = $3 WHERE project_id = $1 AND email = $2";
            const updateResult = await db.ExecuteCommand(updateSql, [project_id, email, 'invited']);
            
            if (!updateResult) {
                // If update failed, status column might not exist - log but don't fail
                log('Status column may not exist in users_pending table, continuing without status update');
            } else {
                log(`Updated user ${email} status to 'invited' for project ${project_id}`);
            }
            
            log(`Invitation email sent successfully to ${email} for project ${project_id}`);
            return sendResponse(res, info, 200, true, "Invitation email sent successfully", null, false);
        } else {
            return sendResponse(res, info, 401, false, "Unauthorized", null);
        }
    } catch (error) {
        logError('Error sending invitation email:', error);
        return sendResponse(res, info, 500, false, error.message, null, true);
    }
};