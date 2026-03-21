const { authManager } = require('./index');
const jwt = require('jsonwebtoken');
const { logMessage } = require('../utils/logging');
const requestIp = require('request-ip');

function isVerboseEnabled() {
  const val = (process.env.VITE_VERBOSE || '').toString().toLowerCase();
  return val === 'true' || val === '1' || val === 'yes';
}

/**
 * Express middleware for authentication
 */

/**
 * Extract token from request (cookie or Authorization header)
 * @param {Object} req - Express request object
 * @returns {string|null} Extracted token
 */
function getAuthToken(req) {
  // Try cookie first
  if (req.cookies?.auth_token) {
    return req.cookies.auth_token;
  }

  // Try Authorization header
  if (req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.split(' ')[1];
    }
  }

  return null;
}

/**
 * Authentication middleware - verifies JWT token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function authenticate(req, res, next) {
  try {
    const token = getAuthToken(req);
    
    if (!token) {
      const debugAllowed = isVerboseEnabled();
      if (debugAllowed) {
        console.warn('[AUTH][DEBUG] Missing auth token');
      }
      const debug = debugAllowed ? { reason: 'missing_token' } : undefined;
      return res.status(401).json({
        success: false,
        message: 'No authentication token provided',
        ...(debug ? { debug } : {})
      });
    }

    // Verify token
    let decoded = null;
    try {
      decoded = await authManager.verifyToken(token);
    } catch (e) {
      // Explicitly log verification error
      logMessage(0, 'shared/auth/middleware.js', 'error', 'authenticate.verifyToken', e?.message || 'verify error');
      const debugAllowed = isVerboseEnabled();
      if (debugAllowed) {
        console.error('[AUTH][DEBUG] Verify exception:', e?.message);
        // Only log token claims when verification fails
        try {
          const decodedLoose = jwt.decode(token) || {};
          const expMs = decodedLoose?.exp ? decodedLoose.exp * 1000 : null;
          const msLeft = expMs ? (expMs - Date.now()) : null;
          console.log('[AUTH][DEBUG] Invalid token claims:', {
            iss: decodedLoose?.iss,
            aud: decodedLoose?.aud,
            sub: decodedLoose?.sub || decodedLoose?.user_id,
            type: decodedLoose?.type,
            exp: decodedLoose?.exp,
            msUntilExpiry: msLeft
          });
        } catch {}
      }
      const debug = debugAllowed ? { reason: 'verify_exception', error: e?.message } : undefined;
      return res.status(401).json({ success: false, message: 'Unauthorized', ...(debug ? { debug } : {}) });
    }
    
    if (!decoded) {
      const debugAllowed = isVerboseEnabled();
      if (debugAllowed) {
        console.warn('[AUTH][DEBUG] Invalid or expired token');
        // Only log token claims when verification fails
        try {
          const decodedLoose = jwt.decode(token) || {};
          const expMs = decodedLoose?.exp ? decodedLoose.exp * 1000 : null;
          const msLeft = expMs ? (expMs - Date.now()) : null;
          console.log('[AUTH][DEBUG] Invalid token claims:', {
            iss: decodedLoose?.iss,
            aud: decodedLoose?.aud,
            sub: decodedLoose?.sub || decodedLoose?.user_id,
            type: decodedLoose?.type,
            exp: decodedLoose?.exp,
            msUntilExpiry: msLeft
          });
        } catch {}
      }
      const debug = debugAllowed ? { reason: 'invalid_or_expired' } : undefined;
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        ...(debug ? { debug } : {})
      });
    }

    // Add user info to request
    req.user = decoded;
    req.user.client_ip = requestIp.getClientIp(req);

    next();
  } catch (error) {
    logMessage(0, 'shared/auth/middleware.js', 'error', 'authenticate', error?.message || 'auth error');
    const debugAllowed = isVerboseEnabled();
    if (debugAllowed) {
      console.error('[AUTH][DEBUG] Auth middleware exception:', error?.message);
    }
    const debug = debugAllowed ? { reason: 'exception', error: error?.message } : undefined;
    return res.status(401).json({
      success: false,
      message: 'Authentication failed',
      ...(debug ? { debug } : {})
    });
  }
}

/**
 * Permission checking middleware factory
 * @param {string} accessType - Required access type (read, write, delete, admin)
 * @param {string} projectIdParam - Request parameter name containing project ID
 * @returns {Function} Express middleware function
 */
function requirePermission(accessType, projectIdParam = 'project_id') {
  return async (req, res, next) => {
    try {
      const userId = req.user?.user_id;
      const projectId = req.params[projectIdParam] || req.query[projectIdParam] || req.body[projectIdParam];

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated'
        });
      }

      if (!projectId) {
        return res.status(400).json({
          success: false,
          message: 'Project ID required'
        });
      }

      // Check permission
      const hasPermission = await authManager.checkPermission(userId, projectId, accessType);
      
      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          message: `Insufficient permissions for ${accessType} access`
        });
      }

      next();
    } catch (error) {
      logMessage(null, 'shared/auth/middleware.js', 'error', 'requirePermission', error.message);
      return res.status(500).json({
        success: false,
        message: 'Permission check failed'
      });
    }
  };
}

/**
 * Super user only middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function requireSuperUser(req, res, next) {
  try {
    const userId = req.user?.user_id;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Check if user is super user
    const db = require('../database/connection');
    if (userId !== db.getSuperUser()) {
      return res.status(403).json({
        success: false,
        message: 'Super user access required'
      });
    }

    next();
  } catch (error) {
    logMessage(null, 'shared/auth/middleware.js', 'error', 'requireSuperUser', error.message);
    return res.status(500).json({
      success: false,
      message: 'Super user check failed'
    });
  }
}

/**
 * Optional authentication middleware - doesn't fail if no token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function optionalAuth(req, res, next) {
  try {
    const token = getAuthToken(req);
    
    if (token) {
      const decoded = await authManager.verifyToken(token);
      if (decoded) {
        req.user = decoded;
        req.user.client_ip = requestIp.getClientIp(req);
      }
    }

    next();
  } catch (error) {
    // Log error but don't fail the request
    logMessage(null, 'shared/auth/middleware.js', 'warning', 'optionalAuth', error.message);
    next();
  }
}

/**
 * Rate limiting middleware for auth endpoints
 * @param {number} maxAttempts - Maximum attempts per window
 * @param {number} windowMs - Window size in milliseconds
 * @returns {Function} Express middleware function
 */
function rateLimitAuth(maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const attempts = new Map();

  return (req, res, next) => {
    const clientIp = requestIp.getClientIp(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old entries
    for (const [ip, data] of attempts.entries()) {
      if (data.timestamp < windowStart) {
        attempts.delete(ip);
      }
    }

    // Check current attempts
    const clientData = attempts.get(clientIp);
    if (clientData) {
      if (clientData.count >= maxAttempts) {
        return res.status(429).end();
      }
      clientData.count++;
    } else {
      attempts.set(clientIp, { count: 1, timestamp: now });
    }

    next();
  };
}

module.exports = {
  authenticate,
  requirePermission,
  requireSuperUser,
  optionalAuth,
  rateLimitAuth,
  getAuthToken
};
