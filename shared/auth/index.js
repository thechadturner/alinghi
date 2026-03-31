/**
 * TeamShare Shared Authentication Module
 * Main entry point for authentication functionality
 */

const jwtManager = require('./jwt');
const userManager = require('./user');
const { debug, error } = require('../utils/console');
const { JWT_CONFIG, PERMISSIONS, ACCESS_TYPES, TOKEN_TYPES, USER_STATUS, LOG_LEVELS } = require('./constants');

/**
 * Main authentication class that combines JWT and user management
 */
class AuthManager {
  constructor() {
    this.jwt = jwtManager;
    this.user = userManager;
  }

  /**
   * Authenticate user with email and password
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {string} clientIp - Client IP address
   * @returns {Promise<Object|null>} Authentication result with tokens
   */
  async authenticateUser(email, password, clientIp = '0.0.0.0') {
    try {
      // Get user by email
      const user = await this.user.getUserByEmail(email);
      if (!user) {
        await this.user.logFailedLoginAttempt(null, clientIp);
        return null;
      }

      // Check if user is active
      if (!user.is_active) {
        await this.user.logFailedLoginAttempt(user.user_id, clientIp);
        return null;
      }

      // Verify password
      const isPasswordValid = await this.user.verifyPassword(password, user.password_hash);
      if (!isPasswordValid) {
        await this.user.logFailedLoginAttempt(user.user_id, clientIp);
        return null;
      }

      // Get user permissions
      const permissions = await this.user.getAllUserPermissions(user.user_id);
      debug('shared/auth/index.js', 'Raw permissions from database:', permissions);

      // Return the highest permission level as a single string
      const permissionLevels = ['reader', 'contributor', 'publisher', 'administrator', 'superuser'];
      let highestPermission = 'reader'; // default

      permissions.forEach(p => {
        const currentIndex = permissionLevels.indexOf(p.permission);
        const highestIndex = permissionLevels.indexOf(highestPermission);
        if (currentIndex > highestIndex) {
          highestPermission = p.permission;
        }
      });

      const permissionsMap = highestPermission;

      // Generate token pair
      const tokenPair = await this.jwt.generateTokenPair(user, permissionsMap);

      // Update last login
      await this.user.updateLastLogin(user.user_id);

      // Check if user is super user
      const db = require('../database/connection');
      const isSuperUser = user.user_id === db.getSuperUser();

      return {
        success: true,
        user: {
          user_id: user.user_id,
          user_name: user.user_name,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          is_verified: user.is_verified,
          is_super_user: isSuperUser
        },
        ...tokenPair
      };
    } catch (err) {
      error('shared/auth/index.js', 'Authentication error:', err);
      // Do not mask DB/network failures as "wrong password" — propagate for HTTP 503/500
      throw err;
    }
  }

  /**
   * Verify JWT token and return user data
   * @param {string} token - JWT token
   * @returns {Promise<Object|null>} Decoded token with user data
   */
  async verifyToken(token) {
    try {
      const decoded = await this.jwt.verifyToken(token);
      
      // Verify user is still active
      const isActive = await this.user.isUserActive(decoded.user_id);
      if (!isActive) {
        throw new Error('User is no longer active');
      }

      return decoded;
    } catch (error) {
      return null;
    }
  }

  /**
   * Refresh access token using refresh token
   * @param {string} refreshToken - Refresh token
   * @returns {Promise<Object|null>} New access token
   */
  async refreshToken(refreshToken) {
    try {
      return await this.jwt.refreshAccessToken(refreshToken);
    } catch (error) {
      return null;
    }
  }

  /**
   * Logout user by blacklisting tokens
   * @param {string} accessToken - Access token to blacklist
   * @param {string} refreshToken - Refresh token to blacklist (optional)
   * @returns {Promise<boolean>} Success status
   */
  async logoutUser(accessToken, refreshToken = null) {
    try {
      let success = true;

      // Blacklist access token
      const accessResult = await this.jwt.blacklistToken(accessToken, 'user_logout');
      if (!accessResult) success = false;

      // Blacklist refresh token if provided
      if (refreshToken) {
        const refreshResult = await this.jwt.blacklistToken(refreshToken, 'user_logout');
        if (!refreshResult) success = false;
      }

      return success;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check user permission for a project
   * @param {string} userId - User ID
   * @param {string} projectId - Project ID
   * @param {string} accessType - Access type (read, write, delete, admin)
   * @returns {Promise<boolean>} Permission status
   */
  async checkPermission(userId, projectId, accessType) {
    try {
      return await this.user.checkUserPermission(userId, projectId, accessType);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get user data by ID
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} User data
   */
  async getUserData(userId) {
    try {
      return await this.user.getUserById(userId);
    } catch (error) {
      return null;
    }
  }

  /**
   * Create a new user account
   * @param {Object} userData - User registration data
   * @returns {Promise<Object|null>} Created user data
   */
  async createUser(userData) {
    try {
      return await this.user.createUser(userData);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Verify user email with secret code
   * @param {string} email - User email
   * @param {string} code - Verification code
   * @returns {Promise<Object|null>} Verification result with tokens
   */
  async verifyUserEmail(email, code) {
    try {
      // Get user by email and code
      const sql = `
        SELECT user_id, user_name, first_name, last_name, email, is_active, is_verified
        FROM admin.users 
        WHERE email = $1 AND secret_code = $2
      `;
      const result = await this.jwt.db.getRows(sql, [email, code]);
      
      if (!result || result.length === 0) {
        return null;
      }

      const user = result[0];

      // Verify user
      const verifyResult = await this.user.verifyUser(user.user_id, code, true);
      if (!verifyResult) {
        return null;
      }

      // Get user permissions
      const permissions = await this.user.getAllUserPermissions(user.user_id);
      // Return the highest permission level as a single string
      const permissionLevels = ['reader', 'contributor', 'publisher', 'administrator', 'superuser'];
      let highestPermission = 'reader'; // default
      
      permissions.forEach(p => {
        const currentIndex = permissionLevels.indexOf(p.permission);
        const highestIndex = permissionLevels.indexOf(highestPermission);
        if (currentIndex > highestIndex) {
          highestPermission = p.permission;
        }
      });
      
      const permissionsMap = highestPermission;

      // Generate token pair
      const tokenPair = await this.jwt.generateTokenPair(user, permissionsMap);

      // Check if user is super user
      const db = require('../database/connection');
      const isSuperUser = user.user_id === db.getSuperUser();

      return {
        success: true,
        user: {
          user_id: user.user_id,
          user_name: user.user_name,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          is_verified: true,
          is_super_user: isSuperUser
        },
        ...tokenPair
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Generate system token for internal server communication
   * @returns {string} System JWT token
   */
  generateSystemToken() {
    const systemUser = {
      user_id: '3dbcc8d0-6666-4359-8f60-211277d27326',
      user_name: 'System',
      first_name: 'System',
      last_name: 'System',
      email: 'System@RACESIGHT',
      is_verified: true
    };

    return this.jwt.generateToken(systemUser, TOKEN_TYPES.SYSTEM);
  }

  /**
   * Clean up expired tokens
   * @returns {Promise<boolean>} Success status
   */
  async cleanupExpiredTokens() {
    try {
      return await this.jwt.cleanupExpiredTokens();
    } catch (error) {
      return false;
    }
  }
}

// Create singleton instance
const authManager = new AuthManager();

// Export individual managers and the main auth manager
module.exports = {
  // Main auth manager
  authManager,
  
  // Individual managers
  jwt: jwtManager,
  user: userManager,
  
  // Constants
  JWT_CONFIG,
  PERMISSIONS,
  ACCESS_TYPES,
  TOKEN_TYPES,
  USER_STATUS,
  LOG_LEVELS
};
