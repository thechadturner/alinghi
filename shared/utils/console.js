// Server-side console utility for development debugging
// Controlled by VITE_VERBOSE environment variable
// This handles console output only - persistent logging is handled by logging.js

// Capture original console methods at module load so *_Always can bypass gating
const __originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug ? console.debug.bind(console) : console.log.bind(console))
};

/**
 * Check if verbose logging is enabled
 * @returns {boolean} True if verbose logging is enabled
 */
function isVerboseEnabled() {
  const val = (process.env.VITE_VERBOSE || '').toString().toLowerCase();
  return val === 'true' || val === '1' || val === 'yes';
}

/**
 * Get caller information for logging context
 * @returns {string} Formatted caller info or empty string
 */
function getCallerInfo() {
  // Only create stack trace if verbose logging is enabled
  if (!isVerboseEnabled()) return '';
  return getCallerInfoForced();
}

// Forced variant used by *_Always functions: always compute caller info
function getCallerInfoForced() {
  try {
    const stack = new Error().stack;
    if (!stack) return '';
    
    const lines = stack.split('\n');
    
    // Skip: Error, getCallerInfoForced, getCallerInfo, console.log (lines 0, 1, 2, 3)
    // The actual caller is at line 4
    const callerLine = lines[4];
    if (!callerLine) return '';
    
    const match = callerLine.match(/\(([^:]+):(\d+):\d+\)|([^:]+):(\d+):\d+/);
    if (match) {
      const filePath = match[1] || match[3];
      const lineNumber = match[2] || match[4];
      
      if (filePath && lineNumber) {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
        
        // Determine source based on file path
        let source = 'Unknown';
        if (filePath.includes('server_app')) {
          source = 'Server App';
        } else if (filePath.includes('server_admin')) {
          source = 'Admin Server';
        } else if (filePath.includes('server_file')) {
          source = 'File Server';
        } else if (filePath.includes('server_media')) {
          source = 'Media Server';
        } else if (filePath.includes('shared')) {
          source = 'Shared';
        }
        
        return `[${source}][${fileName}:${lineNumber}]`;
      }
    }
  } catch (error) {
    // Silently fail if stack trace parsing fails
  }
  return '';
}

/**
 * Log to database and file if enabled for this level
 * @param {string} level - Log level
 * @param {Array} args - Log arguments
 * @param {string} location - Caller location
 */
async function logToDatabase(level, args, location) {
  // Only log to database if verbose logging is enabled for non-error levels
  const shouldLogToDb = (level === 'error') || 
                       (level === 'warn' && isVerboseEnabled()) ||
                       (level === 'info' && isVerboseEnabled()) ||
                       (level === 'debug' && isVerboseEnabled());
  
  if (!shouldLogToDb) return;
  
  try {
    // Import logging functions dynamically to avoid circular dependency
    const { logMessage, writeLogToFile } = require('./logging');
    
    // Create Error object from first argument if it's not already an Error
    let errorObj;
    if (args[0] instanceof Error) {
      errorObj = args[0];
    } else {
      errorObj = new Error(args[0]?.toString() || 'Unknown error');
    }
    
    // Parse location to extract filename and line number
    let fileName = 'unknown';
    let lineNumber = null;
    let actualMessage = 'Unknown error';
    
    // FIRST: Try to extract filename from location parameter (from getCallerInfo)
    // This is the most reliable source for direct error() calls
    if (location) {
      // Location format is like "[Media Server][server.js:141]" or "[Server App][file.js:123]"
      const locationMatch = location.match(/\[([^\]]+)\]\[([^:]+)(?::(\d+))?\]/);
      if (locationMatch) {
        // locationMatch[1] is the source (e.g., "Media Server")
        // locationMatch[2] is the filename
        fileName = locationMatch[2].split('?')[0]; // Remove query parameters
        if (locationMatch[3]) {
          lineNumber = parseInt(locationMatch[3]);
        }
      } else {
        // Try simpler format without source prefix
        const simpleMatch = location.match(/\[([^:]+)(?::(\d+))?\]/);
        if (simpleMatch) {
          fileName = simpleMatch[1].split('?')[0];
          if (simpleMatch[2]) {
            lineNumber = parseInt(simpleMatch[2]);
          }
        } else {
          // Fallback: remove brackets and take first part
          const cleaned = location.replace(/[\[\]]/g, '').split(':')[0].split('?')[0];
          if (cleaned && cleaned !== '') {
            fileName = cleaned;
          }
        }
      }
    }
    
    // Extract message from args
    // When called like error('message:', err.message), args[0] is the message prefix
    // and args[1] is the actual error message
    if (args && args.length > 0) {
      if (args.length === 1) {
        // Single argument - use it as the message
        actualMessage = String(args[0]);
      } else {
        // Multiple arguments - combine them
        actualMessage = args.map(arg => {
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        }).join(' ').trim();
      }
    }
    
    // If we still don't have a message, try to get it from errorObj
    if (!actualMessage || actualMessage === 'Unknown error') {
      if (errorObj && errorObj.message) {
        actualMessage = errorObj.message;
      }
    }
    
    // Log to database based on level
    switch (level) {
      case 'error':
        await logMessage(0, 0, fileName, 'error', actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
      case 'warn':
        await logMessage(0, 0, fileName, 'warn', actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
      case 'info':
        await logMessage(0, 0, fileName, 'info', actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
      case 'debug':
        await logMessage(0, 0, fileName, 'debug', actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
    }
    
    // Also write to file based on level
    const fileLogMessage = `${level.toUpperCase()}: ${actualMessage} | File: ${fileName} | Line: ${lineNumber || 'unknown'} | Context: ${JSON.stringify({ consoleArgs: args, timestamp: new Date().toISOString() })}`;
    
    switch (level) {
      case 'error':
        writeLogToFile("exception", fileLogMessage);
        break;
      case 'warn':
        writeLogToFile("warnings", fileLogMessage);
        break;
      case 'debug':
        writeLogToFile("debug", fileLogMessage);
        break;
      default:
        writeLogToFile("activity", fileLogMessage);
        break;
    }
  } catch (err) {
    // Silently fail if database logging fails to avoid infinite loops
    console.error('Failed to log to database:', err);
  }
}

/**
 * Console logger object with gated output
 */
const console_logger = {
  log: (...args) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      console.log(location ? `${location} ` : '', ...args);
    }
  },
  
  warn: (...args) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      console.warn(location ? `${location} ` : '', ...args);
      
      // Log warnings to database (always enabled for warnings)
      logToDatabase('warn', args, location);
    }
  },
  
  error: (...args) => {
    // Always show errors regardless of verbose setting
    const location = getCallerInfo();
    console.error(location ? `${location} ` : '', ...args);
    
    // Always log errors to database (they're important) - get location even if verbose is disabled
    const dbLocation = getCallerInfoForced();
    logToDatabase('error', args, dbLocation);
  },
  
  info: (...args) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      console.info(location ? `${location} ` : '', ...args);
      
      // Log info to database only in verbose mode
      logToDatabase('info', args, location);
    }
  },
  
  debug: (...args) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      console.debug(location ? `${location} ` : '', ...args);
      
      // Log debug to database only in verbose mode
      logToDatabase('debug', args, location);
    }
  },
  
  // Specialized logging for API operations
  api: (message, data) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[API]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  },
  
  // Specialized logging for database operations
  db: (message, data) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[DB]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  },
  
  // Specialized logging for authentication operations
  auth: (message, data) => {
    if (isVerboseEnabled()) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[AUTH]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  }
};

// Always-print helpers (bypass verbose gating, but do not force DB logging)
function logAlways(...args) {
  __originalConsole.log(...args);
}

function infoAlways(...args) {
  __originalConsole.info(...args);
}

function warnAlways(...args) {
  __originalConsole.warn(...args);
}

function debugAlways(...args) {
  __originalConsole.debug(...args);
}

function apiAlways(message, data) {
  if (data !== undefined) {
    __originalConsole.log(message, data);
  } else {
    __originalConsole.log(message);
  }
}

function dbAlways(message, data) {
  if (data !== undefined) {
    __originalConsole.log(message, data);
  } else {
    __originalConsole.log(message);
  }
}

function authAlways(message, data) {
  if (data !== undefined) {
    __originalConsole.log(message, data);
  } else {
    __originalConsole.log(message);
  }
}

/**
 * Install global console wrapper so legacy console.* calls are gated by VITE_VERBOSE
 * This should be called early in server startup
 */
function installConsoleGate() {
  try {
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
    };

    console.log = (...args) => {
      if (isVerboseEnabled()) {
        const location = getCallerInfo();
        original.log(location ? `${location} ` : '', ...args);
      }
    };

    console.info = (...args) => {
      if (isVerboseEnabled()) {
        const location = getCallerInfo();
        original.info(location ? `${location} ` : '', ...args);
      }
    };

    console.warn = (...args) => {
      if (isVerboseEnabled()) {
        const location = getCallerInfo();
        original.warn(location ? `${location} ` : '', ...args);
        //logToDatabase('warn', args, location);
      }
    };

    console.error = (...args) => {
      // Always show errors regardless of verbose setting
      const location = getCallerInfo();
      original.error(location ? `${location} ` : '', ...args);
      //logToDatabase('error', args, location);
    };

    console.debug = (...args) => {
      if (isVerboseEnabled()) {
        const location = getCallerInfo();
        original.debug(location ? `${location} ` : '', ...args);
        logToDatabase('debug', args, location);
      }
    };
  } catch (err) {
    // no-op if console is not available
  }
}

// Export individual functions for convenience
const { log, warn, error, info, debug, api, db, auth } = console_logger;

module.exports = {
  console_logger,
  log,
  warn,
  error,
  info,
  debug,
  api,
  db,
  auth,
  // Always-print helpers
  logAlways,
  infoAlways,
  warnAlways,
  debugAlways,
  apiAlways,
  dbAlways,
  authAlways,
  isVerboseEnabled,
  installConsoleGate
};
