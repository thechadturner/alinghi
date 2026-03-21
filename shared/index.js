/**
 * TeamShare Shared Modules
 * Main entry point for shared functionality
 */

// Database
const db = require('./database/connection');

// Authentication
const auth = require('./auth');

// Utilities
const { logMessage, logUserActivity, logFailedLogin } = require('./utils/logging');
const { console_logger, log, warn, error, info, debug, api, db: dbConsole, auth: authConsole, isVerboseEnabled, installConsoleGate, logAlways, infoAlways, warnAlways, debugAlways, apiAlways, dbAlways, authAlways } = require('./utils/console');

// Constants
const { JWT_CONFIG, PERMISSIONS, ACCESS_TYPES, TOKEN_TYPES, USER_STATUS, LOG_LEVELS } = require('./auth/constants');

module.exports = {
  // Database
  db,
  
  // Authentication
  auth,
  
  // Utilities
  logMessage,
  logUserActivity,
  logFailedLogin,
  
  // Console utilities
  console_logger,
  log,
  warn,
  error,
  info,
  debug,
  api,
  db: dbConsole,
  auth: authConsole,
  // Always-print console helpers
  logAlways,
  infoAlways,
  warnAlways,
  debugAlways,
  apiAlways,
  dbAlways,
  authAlways,
  isVerboseEnabled,
  installConsoleGate,
  
  // Constants
  JWT_CONFIG,
  PERMISSIONS,
  ACCESS_TYPES,
  TOKEN_TYPES,
  USER_STATUS,
  LOG_LEVELS
};
