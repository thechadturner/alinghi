const { authenticate, requirePermission, requireSuperUser, optionalAuth } = require('../../shared/auth/middleware');
const { validatePAT } = require('./pat');
const { sendResponse } = require('./helpers');

/**
 * Combined authentication middleware supporting both PATs and JWTs
 * PATs are checked first, then falls back to JWT authentication
 */

// Combined authentication middleware that supports both PATs and JWTs
const authenticateWithResponse = async (req, res, next) => {
  try {
    // First try PAT validation
    await new Promise((resolve, reject) => {
      validatePAT(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // If PAT authentication succeeded, we're done
    if (req.user && req.user.user_id) {
      return next();
    }

    // If no PAT was found/valid, try JWT authentication
    authenticate(req, res, (err) => {
      if (err) {
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'authenticate' };
        return sendResponse(res, info, 401, false, 'Unauthorized', null);
      }
      next();
    });
  } catch (err) {
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'authenticate' };
    return sendResponse(res, info, 401, false, 'Authentication failed', null);
  }
};

const requirePermissionWithResponse = (accessType, projectIdParam = 'project_id') => {
  return (req, res, next) => {
    requirePermission(accessType, projectIdParam)(req, res, (err) => {
      if (err) {
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'requirePermission' };
        return sendResponse(res, info, 403, false, 'Insufficient permissions', null);
      }
      next();
    });
  };
};

const requireSuperUserWithResponse = (req, res, next) => {
  requireSuperUser(req, res, (err) => {
    if (err) {
      const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'requireSuperUser' };
      return sendResponse(res, info, 403, false, 'Super user access required', null);
    }
    next();
  });
};

// Permission checking function (supports both PATs and JWTs)
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

    // If using PAT, check scopes first
    if (req.pat) {
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
      if (!hasScope) {
        return false;
      }

      // Check project restrictions if PAT has project_ids
      if (req.pat.project_ids && req.pat.project_ids.length > 0) {
        const projectIdInt = parseInt(project_id);
        if (!req.pat.project_ids.includes(projectIdInt)) {
          return false;
        }
      }
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
