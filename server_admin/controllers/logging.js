const { validationResult } = require('express-validator');
const { writeLogToFile, logActivity, logMessage } = require("../middleware/logging");
const env = require('../middleware/config');
const { sendResponse } = require('../middleware/helpers');

// Log Activity
exports.LogActivity = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/logging', "function": 'LogActivity'}
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const user_id = req.user.user_id;
        const client_ip = req.user.client_ip;
        const { project_id = 0, dataset_id = 0, file_name, message, context} = req.body;

        logActivity(client_ip, user_id, project_id, dataset_id, file_name, message, context)
    } catch (error) {
        writeLogToFile("exception", error);
    }

    return res.json({ success: true });
};

// Log Message
exports.LogMessage = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/logging', "function": 'LogActivity'}
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const user_id = req.user.user_id;
        const client_ip = req.user.client_ip;
        const { file_name, message_type, message, context } = req.body;

        logMessage(client_ip, user_id, file_name, message_type, message, context)
    } catch (error) {
        writeLogToFile("exception", error);
    }

    return res.json({ success: true });
};

// Log User Activity
exports.LogUserActivity = async (req, res) => {
    const info = {"auth_token": req.cookies?.auth_token, "location": 'server_admin/logging', "function": 'LogUserActivity'}
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, info, 400, false, JSON.stringify(errors.array()), null, true);
    }

    try {
        const user_id = req.user.user_id;
        const client_ip = req.user.client_ip;
        const { project_id = 0, dataset_id = 0, activity_type, page, context } = req.body;

        // Use the existing logActivity function
        await logActivity(client_ip, user_id, project_id, dataset_id, 'userActivity', 
          `${activity_type}: ${page || 'unknown'}`, context);
        
        return res.json({ success: true });
    } catch (error) {
        writeLogToFile("exception", error);
        return sendResponse(res, info, 500, false, error.message);
    }
};