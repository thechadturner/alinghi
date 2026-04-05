// Console logger utility for development debugging
// Controlled by VITE_VERBOSE environment variable
// This handles console output only - persistent logging is handled by logging.ts

// Extend window/self interface to include logging flag (for both main thread and workers)
declare global {
  interface Window {
    isLoggingToDatabase?: boolean;
  }
  interface WorkerGlobalScope {
    isLoggingToDatabase?: boolean;
  }
}

// Build-time constants for better tree-shaking
const isDev = import.meta.env.DEV;
const isProd = !isDev;

// Check VERBOSE flag - when true, show all messages; when false, hide logs but show errors
// Try both VITE_VERBOSE and VERBOSE for compatibility
const isVerbose = import.meta.env.VITE_VERBOSE === 'true' || import.meta.env.VITE_VERBOSE === '1' || import.meta.env.VITE_VERBOSE === 'yes'

// TEMPORARILY DISABLED FOR DEBUGGING: Use VERBOSE flag to control logging behavior
// Re-enabled all logging to debug production issues
const enableLogging = true; // TEMP: Always enable for debugging
const enableDebugLogs = true; // TEMP: Always enable for debugging

// Database logging controls
const enableDatabaseLogging = true; // Always log errors to database
const enableDebugDatabaseLogging = isVerbose; // Log debug info to database only in verbose mode

// Get log level from environment or use build-time defaults
const logLevel = import.meta.env.VITE_LOG_LEVEL || (isVerbose ? 'debug' : (isProd ? 'error' : 'debug'));

// Log levels (higher number = more verbose)
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
} as const;

const currentLogLevel = LOG_LEVELS[logLevel as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.debug;

/** Max length for log message sent to DB to avoid huge payloads (e.g. stringified response data). */
const MAX_LOG_MESSAGE_LENGTH = 500;

const truncateForDbMessage = (s: string): string =>
  s.length <= MAX_LOG_MESSAGE_LENGTH ? s : s.substring(0, MAX_LOG_MESSAGE_LENGTH) + '...';

// Optimized shouldLog function that can be tree-shaken in production
const shouldLog = (level: keyof typeof LOG_LEVELS) => {
  // Debug logs should always log if we're in verbose mode OR debug mode
  if (level === 'debug') {
    return isVerbose || logLevel === 'debug';
  }
  
  // TEMPORARILY DISABLED FOR DEBUGGING
  // When VERBOSE is false, only show errors regardless of environment
  // if (!isVerbose) {
  //   return level === 'error';
  // }
  
  // When VERBOSE is true, use normal log level filtering
  if (!enableLogging) return false;
  
  return LOG_LEVELS[level] <= currentLogLevel;
};

// Get caller location info with performance optimization
const getCallerInfo = (alwaysGetInfo: boolean = false) => {
  // Only create stack trace if logging is enabled OR if we always need info (for database logging)
  if (!enableLogging && !alwaysGetInfo) return '';
  
  try {
    const stack = new Error().stack;
    if (!stack) return '';
    
    const lines = stack.split('\n');
    // Skip: Error, getCallerInfo, and the logging function (lines 0, 1, 2)
    // Get the actual caller (line 3)
    const callerLine = lines[3];
    if (!callerLine) return '';
    
    // Extract file name and line number from patterns like:
    // "    at functionName (file:///path/to/file.js:123:45)"
    // "    at file:///path/to/file.js:123:45"
    const match = callerLine.match(/\(([^:]+):(\d+):\d+\)|([^:]+):(\d+):\d+/);
    if (match) {
      const filePath = match[1] || match[3];
      const lineNumber = match[2] || match[4];
      
      if (filePath && lineNumber) {
        // Extract just the filename from the full path
        const fileName = filePath.split('/').pop() || filePath;
        return `[${fileName}:${lineNumber}]`;
      }
    }
  } catch (error) {
    // Silently fail if stack trace parsing fails
  }
  
  return '';
};

// Database logging function - controls what gets passed to logging.ts
const logToDatabase = async (level: 'error' | 'warn' | 'info' | 'debug', args: any[], location: string) => {
  // Only log to database if enabled for this level
  const shouldLogToDb = (level === 'error' && enableDatabaseLogging) || 
                       (level === 'warn' && enableDatabaseLogging) ||
                       (level === 'info' && enableDebugDatabaseLogging) ||
                       (level === 'debug' && enableDebugDatabaseLogging);
  
  if (!shouldLogToDb) return;
  
  // Prevent recursive calls by checking if we're already in a logging operation
  // Check if window exists (not available in Web Workers)
  // Support both window (main thread) and self (workers)
  const globalObj = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
  if (globalObj && (globalObj as any).isLoggingToDatabase) return;
  if (globalObj) {
    (globalObj as any).isLoggingToDatabase = true;
  }
  
  // Silently ignore AbortErrors - they're expected when requests are cancelled
  // Check if any argument is an AbortError or contains "request aborted" message
  const isAbortError = args.some(arg => {
    if (arg instanceof Error) {
      return arg.name === 'AbortError' || 
             arg.message?.toLowerCase().includes('request aborted') ||
             arg.message?.toLowerCase().includes('aborted');
    }
    if (arg && typeof arg === 'object') {
      return arg.name === 'AbortError' || 
             (arg as any).type === 'AbortError' ||
             (arg.message && typeof arg.message === 'string' && 
              (arg.message.toLowerCase().includes('request aborted') || 
               arg.message.toLowerCase().includes('aborted')));
    }
    // Check string arguments for "request aborted" or "aborted"
    if (typeof arg === 'string') {
      const lowerArg = arg.toLowerCase();
      return lowerArg.includes('request aborted') || lowerArg.includes('aborted');
    }
    return false;
  });
  
  if (isAbortError) {
    // Reset the logging flag before returning
    if (globalObj) {
      (globalObj as any).isLoggingToDatabase = false;
    }
    return; // Don't log AbortErrors - they're expected
  }
  
  try {
    // Import logging functions dynamically to avoid circular dependency
    const { logError, logWarning, logInfo, logDebug } = await import('./logging');
    
    // Parse location to extract filename and line number
    let fileName = 'unknown';
    let lineNumber: number | null = null;
    let errorObj: Error | null = null;
    let actualMessage = 'Unknown error';
    let functionName = '';
    
    // FIRST: Try to extract filename from location parameter (from getCallerInfo)
    // This is the most reliable source for direct error() calls
    if (location) {
      const locationMatch = location.match(/\[([^:]+)(?::(\d+))?\]/);
      if (locationMatch) {
        fileName = locationMatch[1].split('?')[0]; // Remove query parameters
        if (locationMatch[2]) {
          lineNumber = parseInt(locationMatch[2]);
        }
      } else {
        // Fallback: remove brackets and take first part
        const cleaned = location.replace(/[\[\]]/g, '').split(':')[0].split('?')[0];
        if (cleaned && cleaned !== '') {
          fileName = cleaned;
        }
      }
    }
    
    // Helper function to check if an object is an Error-like object
    const isErrorLike = (obj: any): obj is Error => {
      return obj instanceof Error || 
             (obj && typeof obj === 'object' && 
              (typeof obj.message === 'string' || typeof obj.name === 'string') &&
              (obj.stack || obj.statusCode !== undefined || obj.name === 'AppError' || obj.name === 'ValidationError' || obj.name === 'AuthError' || obj.name === 'NotFoundError' || obj.name === 'NetworkError'));
    };
    
    // Helper function to extract message from Error-like object
    const getErrorMessage = (obj: any): string => {
      if (!obj) return 'Unknown error';
      
      // Try multiple ways to get the message property
      // 1. Direct access (works for Error instances)
      if (obj.message && typeof obj.message === 'string' && obj.message.trim() && !obj.message.startsWith('[')) {
        return obj.message;
      }
      
      // 2. Try to get from property descriptor (for non-enumerable properties)
      try {
        const messageDesc = Object.getOwnPropertyDescriptor(obj, 'message');
        if (messageDesc && messageDesc.value && typeof messageDesc.value === 'string' && messageDesc.value.trim() && !messageDesc.value.startsWith('[')) {
          return messageDesc.value;
        }
      } catch (e) {
        // Ignore errors accessing property descriptor
      }
      
      // 3. Try to get from prototype chain
      try {
        const proto = Object.getPrototypeOf(obj);
        if (proto && proto.message && typeof proto.message === 'string' && proto.message.trim() && !proto.message.startsWith('[')) {
          return proto.message;
        }
      } catch (e) {
        // Ignore errors accessing prototype
      }
      
      // 4. For Error instances, try to extract from stack trace
      if (obj instanceof Error && obj.stack) {
        const stackLines = obj.stack.split('\n');
        const firstLine = stackLines[0];
        // Extract message from stack trace first line if it's not just the error name
        if (firstLine && !firstLine.includes('Error: [')) {
          const match = firstLine.match(/^(\w+):\s*(.+)$/);
          if (match && match[2] && !match[2].startsWith('[')) {
            return match[2].trim();
          }
        }
      }
      
      // 5. For AppError and similar custom errors, try to access message via different methods
      if (obj && typeof obj === 'object') {
        if (obj.name === 'AppError' || obj.name === 'ValidationError' || obj.name === 'AuthError' || obj.name === 'NotFoundError' || obj.name === 'NetworkError') {
          // Try to access message via Object.getOwnPropertyNames to find non-enumerable properties
          try {
            const ownProps = Object.getOwnPropertyNames(obj);
            for (const prop of ownProps) {
              if (prop === 'message') {
                const propDesc = Object.getOwnPropertyDescriptor(obj, prop);
                if (propDesc && propDesc.value && typeof propDesc.value === 'string' && propDesc.value.trim() && !propDesc.value.startsWith('[')) {
                  return propDesc.value;
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
          
          // Try to get message from prototype chain
          try {
            let current = obj;
            for (let i = 0; i < 5 && current; i++) {
              const proto = Object.getPrototypeOf(current);
              if (proto && proto.message && typeof proto.message === 'string' && proto.message.trim() && !proto.message.startsWith('[')) {
                return proto.message;
              }
              current = proto;
            }
          } catch (e) {
            // Ignore errors
          }
          
          // Check if there's a message in the context (from additionalContext parameter)
          // This is a fallback if the message property isn't accessible
          if (args && args.length > 2 && typeof args[2] === 'object' && args[2] !== null) {
            const context = args[2] as any;
            // Sometimes the actual error message might be in the context
            if (context.jsonError && typeof context.jsonError === 'string' && !context.jsonError.startsWith('[')) {
              return context.jsonError;
            }
          }
        }
      }
      
      // Last resort: return a generic message based on error type
      if (obj && typeof obj === 'object' && obj.name) {
        return `${obj.name} occurred`;
      }
      
      return 'Unknown error';
    };
    
    // Find the Error object in args (could be in args[0] or args[1])
    // When called from handleError, pattern is: error([file_name], errorObj, context)
    // So args[0] is location string, args[1] is Error object
    if (args && args.length > 0) {
      // Check if args[0] is an Error (direct error call)
      if (isErrorLike(args[0])) {
        errorObj = args[0] instanceof Error ? args[0] : new Error(getErrorMessage(args[0]));
        actualMessage = getErrorMessage(args[0]);
      } 
      // Check if args[0] is a location string and args[1] is an Error (handleError pattern)
      else if (typeof args[0] === 'string' && args[0].startsWith('[') && args.length > 1 && isErrorLike(args[1])) {
        // Preserve the original error object if it's an Error instance
        if (args[1] instanceof Error) {
          errorObj = args[1];
          // Get message directly from the error object
          actualMessage = args[1].message || getErrorMessage(args[1]);
        } else {
          // For Error-like objects that aren't Error instances, create a new Error
          // but try to preserve the original message
          const errorMessage = getErrorMessage(args[1]);
          errorObj = new Error(errorMessage);
          // Try to copy over properties from the original error object
          const errorLike = args[1] as any;
          if (errorLike && errorLike.name) {
            errorObj.name = errorLike.name;
          }
          if (errorLike && errorLike.stack) {
            errorObj.stack = errorLike.stack;
          }
          actualMessage = errorMessage;
        }
        
        // Parse filename from args[0] (location string like "[global.ts]" or "[filename:line]")
        const locationStr = args[0];
        const match = locationStr.match(/\[([^:]+)(?::(\d+))?\]/);
        if (match) {
          fileName = match[1].split('?')[0]; // Remove query parameters
          if (match[2]) {
            lineNumber = parseInt(match[2]);
          }
        } else {
          // Fallback: remove brackets
          fileName = locationStr.replace(/[\[\]]/g, '').split('?')[0];
        }
      }
      // Check if args[1] is an Error (other patterns)
      else if (args.length > 1 && isErrorLike(args[1])) {
        errorObj = args[1] instanceof Error ? args[1] : new Error(getErrorMessage(args[1]));
        actualMessage = getErrorMessage(args[1]);
      }
      // No Error object found, create one from args
      else {
        const firstArg = args[0];
        // Check if firstArg is a location string (pattern: [filename] or [filename:line])
        // Location strings are typically short and match the pattern exactly (nothing after the closing bracket)
        const locationPattern = /^\[([^:\]]+)(?::(\d+))?\]$/;
        if (typeof firstArg === 'string' && locationPattern.test(firstArg)) {
          // It's a location string, parse it
          const match = firstArg.match(locationPattern);
          if (match) {
            fileName = match[1].split('?')[0];
            if (match[2]) {
              lineNumber = parseInt(match[2]);
            }
          }
          // Get message from remaining args
          if (args.length > 1) {
            actualMessage = args.slice(1).map(arg => {
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
        } else {
          // Not a location string - treat entire firstArg as message (or all args)
          // This handles cases like: info('[HuniDBStore] Retrieved 12 cached datasets')
          // where the entire string is the message, not a location prefix
          if (args.length === 1 && typeof firstArg === 'string') {
            actualMessage = firstArg;
          } else {
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
        // Fallback: if we still don't have a message, ensure we have something
        if (!actualMessage || actualMessage === 'Unknown error') {
          // Try to extract from all args, skipping location strings
          const messageParts = args.map(arg => {
            if (typeof arg === 'string' && locationPattern.test(arg)) {
              return ''; // Skip location strings
            }
            if (typeof arg === 'object' && arg !== null) {
              try {
                return JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            }
            return String(arg);
          }).filter(msg => msg && msg.trim());
          
          actualMessage = messageParts.join(' ').trim() || 'Unknown error';
        }
        errorObj = new Error(actualMessage);
      }
    }
    
    // If filename is still unknown, try to extract from error stack trace
    if (fileName === 'unknown' && errorObj && errorObj.stack) {
      const stackLines = errorObj.stack.split('\n');
      // Look for the first stack frame that's not from console.ts or errorHandler.ts
      for (let i = 1; i < Math.min(6, stackLines.length); i++) {
        const line = stackLines[i];
        // Match patterns like "    at functionName (file:///path/to/file.js:123:45)" or "    at file:///path/to/file.js:123:45"
        const match = line.match(/\(([^:]+):(\d+):\d+\)|([^:]+):(\d+):\d+/);
        if (match) {
          const filePath = match[1] || match[3];
          const lineNum = match[2] || match[4];
          // Skip internal files
          if (filePath && !filePath.includes('console.ts') && !filePath.includes('errorHandler.ts')) {
            const extractedFileName = filePath.split('/').pop() || filePath;
            fileName = extractedFileName.split('?')[0]; // Remove query parameters
            if (lineNum) {
              lineNumber = parseInt(lineNum);
            }
            break;
          }
        }
      }
    }
    
    // Extract function name from Error stack trace if available
    if (errorObj && errorObj.stack) {
      const stackLines = errorObj.stack.split('\n');
      // Look for function name in stack trace (usually in the second or third line)
      // Skip the first line which is the error message
      for (let i = 1; i < Math.min(5, stackLines.length); i++) {
        const line = stackLines[i];
        // Match patterns like "    at functionName (file:line)" or "    at Object.functionName (file:line)"
        // or "    at ClassName.functionName (file:line)"
        const funcMatch = line.match(/at\s+(?:[^\s]+\.)?(\w+)\s*\(/);
        if (funcMatch && funcMatch[1]) {
          const candidateName = funcMatch[1];
          // Skip internal error handling functions
          if (candidateName !== 'handleError' && 
              candidateName !== 'error' && 
              candidateName !== 'logToDatabase' &&
              candidateName !== 'AppError' &&
              candidateName !== 'ValidationError' &&
              candidateName !== 'AuthError' &&
              candidateName !== 'NotFoundError' &&
              candidateName !== 'NetworkError') {
            functionName = candidateName;
            break;
          }
        }
      }
    }
    
    // Never send huge messages to DB (e.g. stringified arrays from "Server error response captured" or similar)
    if (actualMessage) {
      actualMessage = truncateForDbMessage(actualMessage);
    }
    
    // Combine function name with message if function name is found
    if (functionName && actualMessage) {
      actualMessage = `${functionName}: ${actualMessage}`;
    } else if (!actualMessage && errorObj) {
      actualMessage = errorObj.message ? truncateForDbMessage(errorObj.message) : errorObj.message;
    }
    
    // Ensure we have an Error object for error logging
    if (!errorObj) {
      errorObj = new Error(actualMessage);
    } else if (actualMessage && errorObj.message !== actualMessage) {
    // Update the error message to include function name if found.
    // Some error types (e.g., DOMException) may have a readonly message, so guard this.
    try {
      (errorObj as any).message = actualMessage;
    } catch {
      // Ignore if message is not writable; we'll log using the original message.
    }
    }
    
    // Log based on level
    switch (level) {
      case 'error':
        await logError(fileName, errorObj, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
      case 'warn':
        await logWarning(fileName, actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
      case 'info':
        await logInfo(fileName, actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
      case 'debug':
        await logDebug(fileName, actualMessage, { 
          consoleArgs: args,
          timestamp: new Date().toISOString(),
          lineNumber: lineNumber
        });
        break;
    }
  } catch (err) {
    // Silently fail if database logging fails to avoid infinite loops
    console.error('Failed to log to database:', err);
  } finally {
    // Support both window (main thread) and self (workers)
    const globalObj = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
    if (globalObj) {
      (globalObj as any).isLoggingToDatabase = false;
    }
  }
};

export const console_logger = {
  log: (...args: any[]) => {
    if (shouldLog('info')) {
      const location = getCallerInfo();
      console.log(location ? `${location} ` : '', ...args);
    }
  },
  
  warn: (...args: any[]) => {
    // ALWAYS show warnings in console, regardless of verbose setting
    const location = getCallerInfo(true);
    console.warn(location ? `${location} ` : '', ...args);
    
    // Log warnings to database (always enabled) - get location even if logging is disabled
    const dbLocation = getCallerInfo(true);
    logToDatabase('warn', args, dbLocation);
  },
  
  error: (...args: any[]) => {
    // ALWAYS show errors in console, regardless of verbose setting
    const location = getCallerInfo(true);
    console.error(location ? `${location} ` : '', ...args);
    
    // Always log errors to database (they're important) - get location even if logging is disabled
    const dbLocation = getCallerInfo(true);
    logToDatabase('error', args, dbLocation);
  },
  
  info: (...args: any[]) => {
    if (shouldLog('info')) {
      const location = getCallerInfo();
      console.info(location ? `${location} ` : '', ...args);
    }
    
    // Log info to database only in debug mode - get location even if logging is disabled
    if (enableDebugDatabaseLogging) {
      const dbLocation = getCallerInfo(true);
      logToDatabase('info', args, dbLocation);
    }
  },
  
  debug: (...args: any[]) => {
    if (shouldLog('debug')) {
      const location = getCallerInfo();
      console.debug(location ? `${location} ` : '', ...args);
    }
    
    // Log debug to database only in debug mode - get location even if logging is disabled
    if (enableDebugDatabaseLogging) {
      const dbLocation = getCallerInfo(true);
      logToDatabase('debug', args, dbLocation);
    }
  },
  
  // Specialized logging for data operations
  data: (message: string, data?: any) => {
    if (shouldLog('debug')) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[Data]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  },
  
  // Specialized logging for IndexedDB operations
  indexedDB: (message: string, data?: any) => {
    if (shouldLog('debug')) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[IndexedDB]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  },
  
  // Specialized logging for API operations
  api: (message: string, data?: any) => {
    if (shouldLog('info')) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[API]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  },
  
  // Specialized logging for chart operations
  chart: (message: string, data?: any) => {
    if (shouldLog('info')) {
      const location = getCallerInfo();
      const prefix = location ? `${location}` : '[Chart]';
      if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  },

  /**
   * Always prints to the browser console (ignores VITE_VERBOSE). Use for page-level diagnostics
   * where operators must see output (e.g. report data loaded).
   */
  pageReport: (message: string, data?: unknown) => {
    const location = getCallerInfo(true);
    const prefix = location ? `${location} ` : '';
    if (data !== undefined) {
      console.log(`${prefix}${message}`, data);
    } else {
      console.log(`${prefix}${message}`);
    }
  },
};

// Export individual functions for convenience
export const { log, warn, error, info, debug, data, indexedDB, api, chart, pageReport } = console_logger;

// Optional: install global console wrapper so legacy console.* calls are gated by VITE_VERBOSE
export function installConsoleGate(): void {
  try {
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
    };

    console.log = (...args: any[]) => {
      if (shouldLog('info')) {
        const location = getCallerInfo();
        original.log(location ? `${location} ` : '', ...args);
      }
    };

    console.info = (...args: any[]) => {
      if (shouldLog('info')) {
        const location = getCallerInfo();
        original.info(location ? `${location} ` : '', ...args);
      }
    };

    console.warn = (...args: any[]) => {
      // ALWAYS show warnings in console, regardless of verbose setting
      const location = getCallerInfo(true);
      original.warn(location ? `${location} ` : '', ...args);
      logToDatabase('warn', args, location);
    };

    console.error = (...args: any[]) => {
      // ALWAYS show errors in console, regardless of verbose setting
      const location = getCallerInfo(true);
      original.error(location ? `${location} ` : '', ...args);
      logToDatabase('error', args, location);
    };

    console.debug = (...args: any[]) => {
      if (shouldLog('debug')) {
        const location = getCallerInfo();
        original.debug(location ? `${location} ` : '', ...args);
        logToDatabase('debug', args, location);
      }
    };
  } catch (_) {
    // no-op if console is not available
  }
}