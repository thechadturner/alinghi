// Use shared logging implementation instead of HTTP calls
const { logMessage: sharedLogMessage, logActivity: sharedLogActivity } = require("../../shared/utils/logging");

// Extract user info from auth token for logging context
function extractUserInfo(auth_token) {
  if (!auth_token) {
    return { client_ip: '0.0.0.0', user_id: '0' };
  }
  
  try {
    // For now, use default values - in a real implementation you might decode the JWT
    // to extract actual user_id and client_ip
    return { client_ip: '0.0.0.0', user_id: '0' };
  } catch (error) {
    return { client_ip: '0.0.0.0', user_id: '0' };
  }
}

async function logMessage(auth_token, file_name, message_type, message, context) {
  const { client_ip, user_id } = extractUserInfo(auth_token);
  
  // Use shared logging directly
  return await sharedLogMessage(client_ip, user_id, file_name, message_type, message, context);
}

async function logActivity(auth_token, project_id, dataset_id, file_name, message, context) {
  const { client_ip, user_id } = extractUserInfo(auth_token);
  
  // Use shared logging directly
  return await sharedLogActivity(client_ip, user_id, project_id, dataset_id, file_name, message, context);
}

module.exports = {
  logMessage, 
  logActivity
};

