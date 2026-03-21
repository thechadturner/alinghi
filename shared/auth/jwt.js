const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database/connection');
const { logMessage } = require('../utils/logging');
const { JWT_CONFIG, TOKEN_TYPES } = require('./constants');
const path = require('path');
const dotenv = require("dotenv");

// Determine environment mode
const isProduction = process.env.NODE_ENV === "production";

// Get project root (two levels up from shared/auth/)
const projectRoot = path.join(__dirname, "../../");

// Load environment files based on mode
// Development: .env -> .env.local
// Production: .env.production -> .env.production.local
const baseEnvFile = isProduction ? ".env.production" : ".env";
const localEnvFile = isProduction ? ".env.production.local" : ".env.local";

const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// Load base .env file first (defaults)
const env = dotenv.config({ path: baseEnvPath, quiet: true }).parsed || {};

// Load local .env file second (overrides base, gitignored secrets)
const envLocal = dotenv.config({ path: localEnvPath, quiet: true }).parsed || {};

// Merge: base env -> local env -> process.env (highest priority, Docker/system)
// This ensures environment variables from Docker/process are used if set
const config = Object.assign({}, env, envLocal, process.env);

/**
 * JWT Token Management
 * Handles generation, validation, and blacklisting of JWT tokens
 */
class JWTManager {
  constructor() {
    this.secret = config.JWT_SECRET;
    if (!this.secret) {
      throw new Error('JWT_SECRET is not configured. Please set JWT_SECRET in your .env file or environment variables.');
    }
    this.issuer = config.JWT_ISSUER || JWT_CONFIG.ISSUER;
    this.audience = config.JWT_AUDIENCE || JWT_CONFIG.AUDIENCE;
  }

  /**
   * Generate a JWT token
   * @param {Object} payload - Token payload
   * @param {string} type - Token type (access, refresh, system)
   * @param {Object} options - Additional options
   * @returns {string} JWT token
   */
  generateToken(payload, type = TOKEN_TYPES.ACCESS, options = {}) {
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Set expiration based on token type
      let expiresIn;
      switch (type) {
        case TOKEN_TYPES.ACCESS:
          expiresIn = JWT_CONFIG.ACCESS_TOKEN_EXPIRY;
          break;
        case TOKEN_TYPES.REFRESH:
          expiresIn = JWT_CONFIG.REFRESH_TOKEN_EXPIRY;
          break;
        case TOKEN_TYPES.SYSTEM:
          expiresIn = JWT_CONFIG.SYSTEM_TOKEN_EXPIRY;
          break;
        default:
          expiresIn = JWT_CONFIG.ACCESS_TOKEN_EXPIRY;
      }

      // Create JWT payload
      const jwtPayload = {
        ...payload,
        type,
        jti: crypto.randomUUID(), // Unique token ID for blacklisting
        iat: now,
        iss: this.issuer,
        aud: this.audience
      };

      // Generate token
      const token = jwt.sign(jwtPayload, this.secret, {
        expiresIn,
        ...options
      });

      return token;
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'generateToken', error.message);
      throw new Error('Failed to generate token');
    }
  }

  /**
   * Verify and decode a JWT token
   * @param {string} token - JWT token to verify
   * @param {boolean} checkBlacklist - Whether to check if token is blacklisted
   * @returns {Object} Decoded token payload
   */
  async verifyToken(token, checkBlacklist = true) {
    try {
      // Verify token signature and expiration
      const decoded = jwt.verify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience
      });

      // Check if token is blacklisted
      if (checkBlacklist) {
        const isBlacklisted = await this.isTokenBlacklisted(decoded.jti);
        if (isBlacklisted) {
          throw new Error('Token has been revoked');
        }
      }

      return decoded;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new Error('Token has expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new Error('Invalid token');
      } else {
        logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'verifyToken', error.message);
        throw error;
      }
    }
  }

  /**
   * Generate access and refresh token pair
   * @param {Object} userData - User data for token payload
   * @param {Object} permissions - User permissions
   * @returns {Object} Token pair with access and refresh tokens
   */
  async generateTokenPair(userData, permissions = {}) {
    try {
      console.log('JWT generateTokenPair - permissions parameter:', permissions);
      console.log('JWT generateTokenPair - permissions type:', typeof permissions);
      
      const basePayload = {
        user_id: userData.user_id,
        user_name: userData.user_name,
        first_name: userData.first_name,
        last_name: userData.last_name,
        email: userData.email,
        is_verified: userData.is_verified || false,
        permissions
      };
      
      console.log('JWT basePayload:', basePayload);

      // Generate access token (short-lived)
      const accessToken = this.generateToken(basePayload, TOKEN_TYPES.ACCESS);

      // Generate refresh token (long-lived, no permissions)
      const refreshPayload = {
        user_id: userData.user_id,
        user_name: userData.user_name,
        first_name: userData.first_name,
        last_name: userData.last_name,
        email: userData.email,
        is_verified: userData.is_verified || false
      };
      const refreshToken = this.generateToken(refreshPayload, TOKEN_TYPES.REFRESH);

      return {
        accessToken,
        refreshToken,
        expiresIn: this.getTokenExpiry(JWT_CONFIG.ACCESS_TOKEN_EXPIRY)
      };
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'generateTokenPair', error.message);
      throw new Error('Failed to generate token pair');
    }
  }

  /**
   * Refresh an access token using a refresh token
   * @param {string} refreshToken - Refresh token
   * @returns {Object} New access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      // Verify refresh token
      const decoded = await this.verifyToken(refreshToken);
      
      if (decoded.type !== TOKEN_TYPES.REFRESH) {
        throw new Error('Invalid token type for refresh');
      }

      // Get fresh user data and permissions
      const userData = await this.getUserData(decoded.user_id);
      if (!userData) {
        throw new Error('User not found');
      }

      const permissions = await this.getUserPermissions(decoded.user_id);

      // Generate new access token
      const basePayload = {
        user_id: userData.user_id,
        user_name: userData.user_name,
        first_name: userData.first_name,
        last_name: userData.last_name,
        email: userData.email,
        is_verified: userData.is_verified,
        permissions
      };

      const accessToken = this.generateToken(basePayload, TOKEN_TYPES.ACCESS);

      return {
        accessToken,
        refreshToken,
        expiresIn: this.getTokenExpiry(JWT_CONFIG.ACCESS_TOKEN_EXPIRY)
      };
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'refreshAccessToken', error.message);
      throw new Error('Failed to refresh token');
    }
  }

  /**
   * Blacklist a token (revoke it)
   * @param {string} token - JWT token to blacklist
   * @param {string} reason - Reason for blacklisting
   * @returns {boolean} Success status
   */
  async blacklistToken(token, reason = 'user_logout') {
    try {
      const decoded = await this.verifyToken(token, false); // Don't check blacklist when blacklisting
      
      const sql = `
        INSERT INTO admin.token_blacklist (token_jti, user_id, expires_at, reason) 
        VALUES ($1, $2, $3, $4)
      `;
      const params = [
        decoded.jti,
        decoded.user_id,
        new Date(decoded.exp * 1000), // Convert to Date object
        reason
      ];

      const result = await db.executeCommand(sql, params);
      return result;
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'blacklistToken', error.message);
      return false;
    }
  }

  /**
   * Check if a token is blacklisted
   * @param {string} jti - Token JTI (JWT ID)
   * @returns {boolean} True if blacklisted
   */
  async isTokenBlacklisted(jti) {
    try {
      const sql = `
        SELECT 1 FROM admin.token_blacklist 
        WHERE token_jti = $1 AND expires_at > NOW()
      `;
      const params = [jti];

      const result = await db.getValueExists(sql, params);
      return result;
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'isTokenBlacklisted', error.message);
      return false;
    }
  }

  /**
   * Get user data from database
   * @param {string} userId - User ID
   * @returns {Object|null} User data
   */
  async getUserData(userId) {
    try {
      const sql = `
        SELECT user_id, user_name, first_name, last_name, email, is_active, is_verified
        FROM admin.users 
        WHERE user_id = $1 AND is_active = true
      `;
      const params = [userId];

      const result = await db.getRows(sql, params);
      return result ? result[0] : null;
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'getUserData', error.message);
      return null;
    }
  }

  /**
   * Get user permissions for all projects
   * @param {string} userId - User ID
   * @returns {string} Highest permission level as string
   */
  async getUserPermissions(userId) {
    try {
      const sql = `
        SELECT project_id, permission 
        FROM admin.user_projects 
        WHERE user_id = $1
      `;
      const params = [userId];

      const result = await db.getRows(sql, params);
      
      if (!result || result.length === 0) {
        return 'reader'; // default permission
      }

      // Return the highest permission level as a single string
      const permissionLevels = ['reader', 'contributor', 'publisher', 'administrator', 'superuser'];
      let highestPermission = 'reader'; // default
      
      result.forEach(row => {
        const currentIndex = permissionLevels.indexOf(row.permission);
        const highestIndex = permissionLevels.indexOf(highestPermission);
        if (currentIndex > highestIndex) {
          highestPermission = row.permission;
        }
      });

      return highestPermission;
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'getUserPermissions', error.message);
      return 'reader';
    }
  }

  /**
   * Get token expiry time in seconds
   * @param {string} expiresIn - Expiry string (e.g., '15m', '7d')
   * @returns {number} Expiry time in seconds
   */
  getTokenExpiry(expiresIn) {
    // Parse time string (e.g., '15m', '7d') to seconds
    const timeString = expiresIn.toString();
    const match = timeString.match(/^(\d+)([smhd])$/);
    
    if (!match) {
      return 0; // Invalid format
    }
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 's': return value; // seconds
      case 'm': return value * 60; // minutes
      case 'h': return value * 60 * 60; // hours
      case 'd': return value * 24 * 60 * 60; // days
      default: return 0;
    }
  }

  /**
   * Clean up expired tokens from blacklist
   * @returns {boolean} Success status
   */
  async cleanupExpiredTokens() {
    try {
      const sql = 'DELETE FROM admin.token_blacklist WHERE expires_at < NOW()';
      const result = await db.executeCommand(sql);
      return result;
    } catch (error) {
      logMessage(0, 0, 'shared/auth/jwt.js', 'error', 'cleanupExpiredTokens', error.message);
      return false;
    }
  }
}

// Create singleton instance
const jwtManager = new JWTManager();

module.exports = jwtManager;
