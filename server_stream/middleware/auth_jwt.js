const { authenticate, requirePermission, requireSuperUser, optionalAuth } = require('../../shared/auth/middleware');
const { sendResponse } = require('./helpers');

/**
 * Combined authentication middleware supporting both PATs and JWTs
 * PATs are checked first, then falls back to JWT authentication
 */

// Combined authentication middleware that supports both PATs and JWTs
const authenticateWithResponse = async (req, res, next) => {
  try {
    // Try JWT authentication
    authenticate(req, res, (err) => {
      if (err) {
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/auth_jwt', "function": 'authenticate' };
        return sendResponse(res, info, 401, false, 'Unauthorized', null);
      }
      next();
    });
  } catch (err) {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/auth_jwt', "function": 'authenticate' };
    return sendResponse(res, info, 401, false, 'Authentication failed', null);
  }
};

const requirePermissionWithResponse = (accessType, projectIdParam = 'project_id') => {
  return (req, res, next) => {
    requirePermission(accessType, projectIdParam)(req, res, (err) => {
      if (err) {
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/auth_jwt', "function": 'requirePermission' };
        return sendResponse(res, info, 403, false, 'Insufficient permissions', null);
      }
      next();
    });
  };
};

const requireSuperUserWithResponse = (req, res, next) => {
  requireSuperUser(req, res, (err) => {
    if (err) {
      const info = { "auth_token": req.cookies?.auth_token, "location": 'server_stream/auth_jwt', "function": 'requireSuperUser' };
      return sendResponse(res, info, 403, false, 'Super user access required', null);
    }
    next();
  });
};

// Permission checking function
async function check_permissions(req, access_type, project_id) {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return false;
    }

    // Use shared auth manager for permission checking
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

