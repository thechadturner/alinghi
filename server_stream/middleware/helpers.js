const { logMessage } = require("./logging");

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
    default:
        state = 'warning';
    }

    if (state !== 'info' && info) {
        let auth_token = getAuthToken(info.auth_token)

        // Log message asynchronously but don't wait for it to complete
        // This prevents blocking the response, but errors are caught to prevent unhandled rejections
        // logMessage is async, so we need to handle the promise
        Promise.resolve(logMessage(
            auth_token || null,
            info.location || 'unknown',
            state,
            info.function || 'unknown',
            message
        )).catch(err => {
            // Silently handle logging errors to prevent unhandled promise rejections
            // Logging failures shouldn't break the API response
            console.error('[sendResponse] Error logging message:', err.message);
        });
    }
    
    if (data != null) {
        res.status(status).json({ "success": success, "data": data });
    } else {
        res.status(status).json({ "success": success, "message": message });
    }
}

module.exports = {
    getAuthToken,
    isValidateName,
    sendResponse
};

