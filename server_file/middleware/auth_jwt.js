const { authenticate, requirePermission, optionalAuth } = require('../../shared/auth/middleware');
const { validatePAT } = require('./pat');
const { sendResponse } = require('./helpers');

/**
 * Combined authentication middleware supporting both PATs and JWTs
 * PATs are checked first, then falls back to JWT authentication
 */

// Combined authentication middleware that supports both PATs and JWTs
const authenticateWithResponse = async (req, res, next) => {
  const { log, warn: logWarn } = require('../../shared');
  log(`[auth_jwt] authenticateWithResponse called for ${req.method} ${req.path}`);
  
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
      log(`[auth_jwt] PAT authentication succeeded, calling next()`);
      return next();
    }
    
    log(`[auth_jwt] No PAT found, trying JWT authentication`);

    // If no PAT was found/valid, try JWT authentication
    // authenticate is async Express middleware that:
    // - Sends response directly (res.status(401).json()) on failure and returns early
    // - Calls next() on success after setting req.user
    // We need to wrap it to properly handle the async flow
    let responseSent = false;
    const originalEnd = res.end.bind(res);
    const originalJson = res.json.bind(res);
    
    // Intercept res.end and res.json to detect if response was sent
    res.end = function(...args) {
      responseSent = true;
      res.end = originalEnd; // Restore
      res.json = originalJson; // Restore
      return originalEnd.apply(this, args);
    };
    
    res.json = function(body) {
      responseSent = true;
      res.end = originalEnd; // Restore
      res.json = originalJson; // Restore
      return originalJson.apply(this, arguments);
    };
    
    // Create a wrapper next function that restores methods and verifies req.user is set
    const wrappedNext = () => {
      res.end = originalEnd; // Restore
      res.json = originalJson; // Restore
      
      // Verify req.user was set by authenticate
      if (req.user && req.user.user_id) {
        next(); // Continue to next middleware
      } else {
        // This shouldn't happen, but handle it gracefully
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_file/auth_jwt', "function": 'authenticate' };
        sendResponse(res, info, 401, false, 'Authentication failed: user not set', null);
      }
    };
    
    // Call authenticate - it will send response on failure or call wrappedNext on success
    await authenticate(req, res, wrappedNext);
    
    // Restore original methods in case authenticate didn't call next or send response
    res.end = originalEnd;
    res.json = originalJson;
    
    // If response was sent, authentication failed and response already sent - don't call next
    if (responseSent) {
      logWarn(`[auth_jwt] Response was sent by authenticate middleware (auth failed)`);
      return;
    }
    
    // If we get here and response wasn't sent, check if req.user was set
    // (This handles edge cases where authenticate might not call next or send response)
    if (req.user && req.user.user_id) {
      log(`[auth_jwt] JWT authentication succeeded, calling next()`);
      next();
    } else {
      logWarn(`[auth_jwt] JWT authentication failed - req.user not set, sending 401`);
      const info = { "auth_token": req.cookies?.auth_token, "location": 'server_file/auth_jwt', "function": 'authenticate' };
      return sendResponse(res, info, 401, false, 'Authentication failed: user not set', null);
    }
  } catch (err) {
    const { error: logError } = require('../../shared');
    logError(`[auth_jwt] Authentication error:`, err);
    const info = { "auth_token": req.cookies?.auth_token, "location": 'server_file/auth_jwt', "function": 'authenticate' };
    return sendResponse(res, info, 401, false, 'Authentication failed', null);
  }
};

const requirePermissionWithResponse = (accessType, projectIdParam = 'project_id') => {
  return (req, res, next) => {
    requirePermission(accessType, projectIdParam)(req, res, (err) => {
      if (err) {
        const info = { "auth_token": req.cookies?.auth_token, "location": 'server_file/auth_jwt', "function": 'requirePermission' };
        return sendResponse(res, info, 403, false, 'Insufficient permissions', null);
      }
      next();
    });
  };
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
  optionalAuth,
  check_permissions
};
