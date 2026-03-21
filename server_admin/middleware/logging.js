// Use shared logging implementation instead of duplicating code
const { logMessage: sharedLogMessage, logActivity: sharedLogActivity } = require("../../shared/utils/logging");
const { log } = require('../../shared');

function isVerboseEnabled() {
    try {
        const val = (process.env.VITE_VERBOSE || '').toString().toLowerCase();
        return val === 'true' || val === '1' || val === 'yes';
    } catch {
        return false;
    }
}

exports.logMessage = async (client_ip, user_id, file_name, message_type, message, context) => {
    if (isVerboseEnabled()) {
        try { log(file_name, message_type, message, context); } catch {}
      }
    // Delegate to shared logging implementation
    return await sharedLogMessage(client_ip, user_id, file_name, message_type, message, context);
};

exports.logActivity = async (client_ip, user_id, project_id, dataset_id, file_name, message, context) => {
    // Delegate to shared logging implementation
    return await sharedLogActivity(client_ip, user_id, project_id, dataset_id, file_name, message, context);
};

// Import batch logging from shared implementation
const { logMessageBatch: sharedLogMessageBatch } = require("../../shared/utils/logging");

// Delegate batch logging to shared implementation
exports.logMessageBatch = (client_ip, user_id, file_name, message_type, message, context) => {
    return sharedLogMessageBatch(client_ip, user_id, file_name, message_type, message, context);
};