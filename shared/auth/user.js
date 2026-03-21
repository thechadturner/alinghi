const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../database/connection');
const { logMessage, logFailedLogin } = require('../utils/logging');
const { PERMISSIONS, ACCESS_TYPES, USER_STATUS } = require('./constants');

/**
 * User Management Functions
 * Integrates with existing admin.users and admin.user_projects tables
 */
class UserManager {
  constructor() {
    this.saltRounds = 10;
  }

  /**
   * Verify user password
   * @param {string} plainPassword - Plain text password
   * @param {string} hashedPassword - Hashed password from database
   * @returns {Promise<boolean>} Password match status
   */
  async verifyPassword(plainPassword, hashedPassword) {
    try {
      const isMatch = await bcrypt.compare(plainPassword, hashedPassword);
      
      if (!isMatch) {
        logMessage(null, 'shared/auth/user.js', 'warning', 'verifyPassword', 'Password is incorrect!');
      }
      
      return isMatch;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'verifyPassword', error.message);
      return false;
    }
  }

  /**
   * Hash a password
   * @param {string} password - Plain text password
   * @returns {Promise<string>} Hashed password
   */
  async hashPassword(password) {
    try {
      return await bcrypt.hash(password, this.saltRounds);
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'hashPassword', error.message);
      throw new Error('Failed to hash password');
    }
  }

  /**
   * Check if user is active
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} User active status
   */
  async isUserActive(userId) {
    try {
      const sql = `SELECT is_active "value" FROM admin.users WHERE user_id = $1`;
      const params = [userId];

      const result = await db.getValue(sql, params);
      return result === true;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'isUserActive', error.message);
      return false;
    }
  }

  /**
   * Check if user is verified
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} User verified status
   */
  async isUserVerified(userId) {
    try {
      const sql = `SELECT is_verified "value" FROM admin.users WHERE user_id = $1`;
      const params = [userId];

      const result = await db.getValue(sql, params);
      return result === true;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'isUserVerified', error.message);
      return false;
    }
  }

  /**
   * Get user by email
   * @param {string} email - User email
   * @returns {Promise<Object|null>} User data
   */
  async getUserByEmail(email) {
    try {
      const sql = `
        SELECT user_id, user_name, first_name, last_name, email, password_hash, 
               is_active, is_verified, last_login_at, created_at, updated_at
        FROM admin.users 
        WHERE email = $1 AND deleted_at IS NULL
      `;
      const params = [email];

      const result = await db.getRows(sql, params);
      return result ? result[0] : null;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'getUserByEmail', error.message);
      return null;
    }
  }

  /**
   * Get user by ID
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} User data
   */
  async getUserById(userId) {
    try {
      const sql = `
        SELECT user_id, user_name, first_name, last_name, email, password_hash,
               is_active, is_verified, last_login_at, created_at, updated_at
        FROM admin.users 
        WHERE user_id = $1 AND deleted_at IS NULL
      `;
      const params = [userId];

      const result = await db.getRows(sql, params);
      return result ? result[0] : null;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'getUserById', error.message);
      return null;
    }
  }

  /**
   * Get user permissions for a specific project
   * @param {string} userId - User ID
   * @param {string} projectId - Project ID
   * @returns {Promise<string|null>} Permission level
   */
  async getUserProjectPermission(userId, projectId) {
    try {
      const sql = `
        SELECT permission "value" 
        FROM admin.user_projects 
        WHERE user_id = $1 AND project_id = $2
      `;
      const params = [userId, projectId];

      const result = await db.getValue(sql, params);
      return result;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'getUserProjectPermission', error.message);
      return null;
    }
  }

  /**
   * Get all user permissions
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of project permissions
   */
  async getAllUserPermissions(userId) {
    try {
      const sql = `
        SELECT project_id, permission 
        FROM admin.user_projects 
        WHERE user_id = $1
      `;
      const params = [userId];

      const result = await db.getRows(sql, params);
      return result || [];
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'getAllUserPermissions', error.message);
      return [];
    }
  }

  /**
   * Check if user has permission for a specific action
   * @param {string} userId - User ID
   * @param {string} projectId - Project ID
   * @param {string} accessType - Access type (read, write, delete, admin)
   * @returns {Promise<boolean>} Permission status
   */
  async checkUserPermission(userId, projectId, accessType) {
    try {
      // Check if user is super user
      if (userId === db.getSuperUser()) {
        return true;
      }

      const permission = await this.getUserProjectPermission(userId, projectId);
      if (!permission) {
        return false;
      }

      // Check permission based on access type
      switch (accessType) {
        case ACCESS_TYPES.READ:
          return true; // All users with project access can read
        case ACCESS_TYPES.WRITE:
          return [
            PERMISSIONS.SUPERUSER,
            PERMISSIONS.ADMINISTRATOR,
            PERMISSIONS.PUBLISHER,
            PERMISSIONS.CONTRIBUTOR
          ].includes(permission);
          
        case ACCESS_TYPES.DELETE:
          return [
            PERMISSIONS.SUPERUSER,
            PERMISSIONS.ADMINISTRATOR
          ].includes(permission);
          
        case ACCESS_TYPES.ADMIN:
          return [
            PERMISSIONS.SUPERUSER,
            PERMISSIONS.ADMINISTRATOR
          ].includes(permission);
          
        default:
          return false;
      }
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'checkUserPermission', error.message);
      return false;
    }
  }

  /**
   * Update user's last login time
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  async updateLastLogin(userId) {
    try {
      const sql = `
        UPDATE admin.users 
        SET last_login_at = CURRENT_TIMESTAMP 
        WHERE user_id = $1
      `;
      const params = [userId];

      const result = await db.executeCommand(sql, params);
      return result;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'updateLastLogin', error.message);
      return false;
    }
  }

  /**
   * Update user's last activity time
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  async updateUserActivity(userId) {
    try {
      const sql = `
        UPDATE admin.users 
        SET updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = $1
      `;
      const params = [userId];

      const result = await db.executeCommand(sql, params);
      return result;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'updateUserActivity', error.message);
      return false;
    }
  }

  /**
   * Log failed login attempt
   * @param {string} userId - User ID
   * @param {string} ipAddress - IP address
   * @returns {Promise<boolean>} Success status
   */
  async logFailedLoginAttempt(userId, ipAddress) {
    try {
      await logFailedLogin(userId, ipAddress);
      return true;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'logFailedLoginAttempt', error.message);
      return false;
    }
  }

  /**
   * Verify user email exists and is verified
   * @param {string} email - User email
   * @returns {Promise<boolean>} Email verification status
   */
  async verifyEmail(email) {
    try {
      const sql = `
        SELECT is_verified "value" 
        FROM admin.users 
        WHERE email = $1 AND deleted_at IS NULL
      `;
      const params = [email];

      const result = await db.getValue(sql, params);
      return result === true;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'verifyEmail', error.message);
      return false;
    }
  }

  /**
   * Create a new user
   * @param {Object} userData - User data
   * @returns {Promise<Object|null>} Created user data
   */
  async createUser(userData) {
    try {
      const { first_name, last_name, email, password } = userData;
      const user_name = first_name[0] + last_name[0];
      const password_hash = await this.hashPassword(password);
      const secret_code = Math.floor(1000 + Math.random() * 9000).toString();

      const sql = `
        INSERT INTO admin.users (user_name, first_name, last_name, email, password_hash, secret_code)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING user_id, user_name, first_name, last_name, email, is_active, is_verified, created_at
      `;
      const params = [user_name, first_name, last_name, email, password_hash, secret_code];

      const result = await db.getRows(sql, params);
      return result ? result[0] : null;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'createUser', error.message);
      throw error;
    }
  }

  /**
   * Verify user with secret code
   * @param {string} userId - User ID
   * @param {string} secretCode - Secret verification code
   * @param {boolean} verified - Verification status
   * @returns {Promise<boolean>} Success status
   */
  async verifyUser(userId, secretCode, verified = true) {
    try {
      const sql = `
        UPDATE admin.users 
        SET is_verified = $2, secret_code = $3 
        WHERE user_id = $1
      `;
      const params = [userId, verified, secretCode];

      const result = await db.executeCommand(sql, params);
      return result;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'verifyUser', error.message);
      return false;
    }
  }

  /**
   * Get user status (active, inactive, pending, deleted)
   * @param {string} userId - User ID
   * @returns {Promise<string>} User status
   */
  async getUserStatus(userId) {
    try {
      const sql = `
        SELECT 
          CASE 
            WHEN deleted_at IS NOT NULL THEN 'deleted'
            WHEN is_active = false THEN 'inactive'
            WHEN is_verified = false THEN 'pending'
            ELSE 'active'
          END as status
        FROM admin.users 
        WHERE user_id = $1
      `;
      const params = [userId];

      const result = await db.getValue(sql, params);
      return result || USER_STATUS.INACTIVE;
    } catch (error) {
      logMessage(null, 'shared/auth/user.js', 'error', 'getUserStatus', error.message);
      return USER_STATUS.INACTIVE;
    }
  }
}

// Create singleton instance
const userManager = new UserManager();

module.exports = userManager;
