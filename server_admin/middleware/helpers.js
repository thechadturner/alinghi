const jwt = require('jsonwebtoken');
const env = require('./config');
const { error } = require('../../shared');

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
    default:
        state = 'warning';
    }

    // Send response immediately without waiting for logging
    if (data != null) {
        res.status(status).json({ "success": success, "data": data });
    } else {
        res.status(status).json({ "success": success, "message": message });
    }

    // Handle logging asynchronously (don't await)
    if ((state !== 'info' && info) | (log == true && info)){
        setImmediate(async () => {
            try {
                let auth_token = getAuthToken(info.auth_token)
                
                // Lazy load logMessage to avoid circular dependency
                const { logMessage } = require("./logging");

                if (auth_token == null) {
                    await logMessage(
                        0, 
                        0, 
                        info.location || 'unknown',
                        state,
                        info.function || 'unknown',
                        message
                    );
                } else {
                    const decoded = jwt.verify(auth_token, env.JWT_SECRET);

                    await logMessage(
                        decoded.client_ip || 0, 
                        decoded.user_id || 0,
                        info.location || 'unknown',
                        state,
                        info.function || 'unknown',
                        message
                    );
                }
            } catch (error) {
                // Log errors to console but don't block response
                error('Async logging error:', error.message);
            }
        });
    }
}

async function postData(auth_token, url, body_json, signal) {
    const fetchOptions = {
        method: "POST",
        headers: { 
            "Content-Type": "application/json", 
            "Authorization": `Bearer ${auth_token}` 
        },
        body: JSON.stringify(body_json)
    };

    if (signal) {
        fetchOptions.signal = signal;
    }

    try {
        // @ts-ignore
        const response = await fetch(url, fetchOptions);

        if (response.ok) {
            const response_json = await response.json()
            return response_json;
        } else {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
    } catch (err) {
        // Provide more descriptive error messages for common fetch failures
        if (err.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
            throw new Error(`Failed to connect to ${url}. Is the service running?`);
        } else if (err.name === 'AbortError') {
            throw new Error('Request was aborted');
        } else if (err.message) {
            throw err;
        } else {
            throw new Error(`Request failed: ${err.toString()}`);
        }
    }
}

async function putData(auth_token, url, body_json, signal) {
    const fetchOptions = {
        method: "PUT",
        headers: { 
            "Content-Type": "application/json", 
            "Authorization": `Bearer ${auth_token}` 
        },
        body: JSON.stringify(body_json)
    };

    if (signal) {
        fetchOptions.signal = signal;
    }

    try {
        // @ts-ignore
        const response = await fetch(url, fetchOptions);

        if (response.ok) {
            const response_json = await response.json()
            return response_json;
        } else {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
    } catch (err) {
        // Provide more descriptive error messages for common fetch failures
        if (err.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
            throw new Error(`Failed to connect to ${url}. Is the service running?`);
        } else if (err.name === 'AbortError') {
            throw new Error('Request was aborted');
        } else if (err.message) {
            throw err;
        } else {
            throw new Error(`Request failed: ${err.toString()}`);
        }
    }
}

module.exports = {
    getAuthToken,
    isValidateName,
    sendResponse,
    postData,
    putData
};