const { logMessage } = require("../middleware/logging");

const isValidateName = (name) => {
    const nameRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    return nameRegex.test(name);
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

const sendResponse = (res, info, status, success, message, data = null) => {
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
        // 204 No Content is a valid success response (no data to return)
        state = 'info';
        break;
    default:
        state = 'warning';
    }

    if (state !== 'info' && info) {
        let auth_token = getAuthToken(info.auth_token)

        logMessage(
            auth_token || null,
            info.location || 'unknown',
            state,
            info.function || 'unknown',
            message
        );
    }
    
    // Check if response has already been sent to avoid "Cannot set headers after they are sent" error
    if (res.headersSent) {
        // Silently return - response was already sent successfully
        // Don't log or warn - this is expected in some cases (e.g., auth middleware intercepts)
        return;
    }
    
    // Log response being sent for debugging
    const { log, error: logError } = require('../../shared');
    log(`[sendResponse] Sending response: status=${status}, success=${success}, hasData=${data != null}, function=${info?.function || 'unknown'}, headersSent=${res.headersSent}`);
    
    try {
        if (data != null) {
            res.status(status).json({ "success": success, "data": data, "message": message });
        } else {
            res.status(status).json({ "success": success, "message": message });
        }
        
        log(`[sendResponse] Response sent successfully: status=${status}, headersSent=${res.headersSent}, finished=${res.finished}`);
    } catch (sendError) {
        logError(`[sendResponse] ERROR sending response:`, sendError);
        logError(`[sendResponse] Error details: status=${status}, headersSent=${res.headersSent}, finished=${res.finished}`);
        // Try to send error response if headers not sent yet
        if (!res.headersSent) {
            try {
                res.status(500).json({ "success": false, "message": "Internal server error" });
            } catch (fallbackError) {
                logError(`[sendResponse] Failed to send fallback error response:`, fallbackError);
            }
        }
        throw sendError; // Re-throw to let caller handle
    }
}

module.exports = {
    getAuthToken,
    isValidateName,
    sendResponse
};