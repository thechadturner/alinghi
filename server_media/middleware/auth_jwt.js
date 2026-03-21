const { authenticate, requirePermission, requireSuperUser, optionalAuth } = require('../../shared/auth/middleware');

/**
 * JWT authentication middleware using shared auth module
 * This provides the same authentication as server_app and server_file
 */

// Re-export shared middleware with custom error handling for media server
const authenticateWithResponse = (req, res, next) => {
  authenticate(req, res, (err) => {
    if (err) {
      const info = { 
        "auth_token": req.cookies?.auth_token, 
        "location": 'server_media/auth_jwt', 
        "function": 'authenticate' 
      };
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized', 
        ...info 
      });
    }
    next();
  });
};

const requirePermissionWithResponse = (accessType, projectIdParam = 'project_id') => {
  return (req, res, next) => {
    requirePermission(accessType, projectIdParam)(req, res, (err) => {
      if (err) {
        const info = { 
          "auth_token": req.cookies?.auth_token, 
          "location": 'server_media/auth_jwt', 
          "function": 'requirePermission',
          "accessType": accessType,
          "projectIdParam": projectIdParam
        };
        return res.status(403).json({ 
          success: false, 
          message: 'Insufficient permissions', 
          ...info 
        });
      }
      next();
    });
  };
};

const requireSuperUserWithResponse = (req, res, next) => {
  requireSuperUser(req, res, (err) => {
    if (err) {
      const info = { 
        "auth_token": req.cookies?.auth_token, 
        "location": 'server_media/auth_jwt', 
        "function": 'requireSuperUser' 
      };
      return res.status(403).json({ 
        success: false, 
        message: 'Super user access required', 
        ...info 
      });
    }
    next();
  });
};

const optionalAuthWithResponse = (req, res, next) => {
  optionalAuth(req, res, (err) => {
    // Optional auth - continue even if authentication fails
    next();
  });
};

module.exports = {
  authenticate: authenticateWithResponse,
  requirePermission: requirePermissionWithResponse,
  requireSuperUser: requireSuperUserWithResponse,
  optionalAuth: optionalAuthWithResponse
};
