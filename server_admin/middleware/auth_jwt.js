const { authenticate, requirePermission, requireSuperUser, optionalAuth } = require('../../shared/auth/middleware');
const { sendResponse } = require('./helpers');

/**
 * JWT authentication middleware using shared auth module
 */

// Re-export shared middleware with custom error handling
const authenticateWithResponse = (req, res, next) => {
  // Allow Personal API Tokens (PAT) to satisfy authentication if present
  if (req.pat && req.pat.token_id) {
    return next();
  }
  // Delegate to shared authenticate; it will handle responses (including debug) itself
  authenticate(req, res, (err) => {
    // If the shared middleware already sent a response, do not continue
    if (res.headersSent) return;
    if (err) {
      const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/auth_jwt', "function": 'authenticate' };
      return sendResponse(res, info, 401, false, 'Unauthorized', null);
    }
    next();
  });
};

const requirePermissionWithResponse = (accessType, projectIdParam = 'project_id') => {
  return (req, res, next) => {
    requirePermission(accessType, projectIdParam)(req, res, (err) => {
      if (err) {
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/auth_jwt', "function": 'requirePermission' };
        return sendResponse(res, info, 403, false, 'Insufficient permissions', null);
      }
      next();
    });
  };
};

const requireSuperUserWithResponse = (req, res, next) => {
  requireSuperUser(req, res, (err) => {
    if (err) {
      const info = { "auth_token": req.cookies?.auth_token, "location": 'server_admin/auth_jwt', "function": 'requireSuperUser' };
      return sendResponse(res, info, 403, false, 'Super user access required', null);
    }
    next();
  });
};

// Permission checking function (backward compatibility)
async function check_permissions(req, access_type, project_id) {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return false;
    }

    // System user (from SYSTEM_KEY) has full permissions - bypass database check
    if (userId === 'system' && req.pat && req.pat.token_id === 'system') {
      const requiredScopes = {
        'read': ['read'],
        'write': ['write', 'read'],
        'delete': ['write', 'read'],
        'admin': ['admin', 'write', 'read']
      };
      
      const scopes = req.pat.scopes || [];
      const required = requiredScopes[access_type] || ['read'];
      
      // Check if PAT has required scopes
      const hasScope = required.some(scope => scopes.includes(scope));
      return hasScope; // System user with valid scopes has permission
    }

    const { authManager } = require('../../shared/auth');
    return await authManager.checkPermission(userId, project_id, access_type);
  } catch (error) {
    return false;
  }
}

module.exports = {
  authenticate: authenticateWithResponse,
  requirePermission: requirePermissionWithResponse,
  requireSuperUser: requireSuperUserWithResponse,
  optionalAuth,
  check_permissions
};
