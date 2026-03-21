/**
 * Authentication constants and configuration
 */

// JWT Configuration
const JWT_CONFIG = {
  ACCESS_TOKEN_EXPIRY: '4h',         // 4 hours
  REFRESH_TOKEN_EXPIRY: '7d',        // 7 days
  SYSTEM_TOKEN_EXPIRY: '365d',       // 1 year for system tokens
  ISSUER: 'teamshare-auth',
  AUDIENCE: 'teamshare-servers'
};

// Permission Levels (matching existing admin.user_projects.permission values)
const PERMISSIONS = {
  SUPERUSER: 'superuser',
  ADMINISTRATOR: 'administrator', 
  PUBLISHER: 'publisher',
  CONTRIBUTOR: 'contributor',
  READER: 'reader'
};

// Access Types for permission checking
const ACCESS_TYPES = {
  READ: 'read',
  WRITE: 'write', 
  DELETE: 'delete',
  ADMIN: 'admin'
};

// Token Types
const TOKEN_TYPES = {
  ACCESS: 'access',
  REFRESH: 'refresh',
  SYSTEM: 'system'
};

// User Status
const USER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  PENDING: 'pending',
  DELETED: 'deleted'
};

// Logging Levels
const LOG_LEVELS = {
  ERROR: 'error',
  WARNING: 'warning', 
  INFO: 'info',
  DEBUG: 'debug'
};

module.exports = {
  JWT_CONFIG,
  PERMISSIONS,
  ACCESS_TYPES,
  TOKEN_TYPES,
  USER_STATUS,
  LOG_LEVELS
};
