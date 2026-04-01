import { apiEndpoints } from "@config/env";
import { warn, error as consoleError } from "./console";

// Persistent logging system for database and file storage
// This handles all persistent logging - console output is handled by console.ts

// Guard to prevent infinite recursion when logging fails
let isLogging = false;
let loggingErrorCount = 0;
const MAX_LOGGING_ERRORS = 5; // Stop trying after 5 consecutive failures

// Enhanced log levels
export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warning', 
  INFO: 'info',
  DEBUG: 'debug'
} as const;

type LogLevel = typeof LOG_LEVELS[keyof typeof LOG_LEVELS];

interface LogPayload {
  file_name: string;
  message_type: string;
  message: string;
  context: string;
}

interface ActivityPayload {
  project_id: number;
  dataset_id: number;
  file_name: string;
  message: string;
  context: string;
}

interface PendingLog {
  type: 'message' | 'activity' | 'user_activity';
  payload: LogPayload | ActivityPayload;
  timestamp: string;
}

interface ErrorContext {
  stack?: string;
  name?: string;
  message?: string;
  timestamp: string;
  userAgent: string;
  url: string;
  [key: string]: any;
}

// Enhanced context builder
const buildContext = (error: Error, additionalContext: Record<string, any> = {}): ErrorContext => {
  return {
    ...additionalContext,
    stack: error?.stack,
    name: error?.name,
    message: error?.message,
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Worker',
    url: typeof window !== 'undefined' ? window.location.href : 'Worker'
  };
};

// System user IDs (from existing codebase) - currently unused but kept for future reference
// const SYSTEM_USER_ID = '3dbcc8d0-6666-4359-8f60-211277d27326'; // System user
// const UNKNOWN_USER_ID = '9613b232-7fa7-4af1-817d-2516fbd362ae'; // Unknown/fallback user

// Flag to prevent infinite recursion in storeLocalLog
let isStoringLocalLog = false;

// Track quota errors to disable localStorage if it's consistently failing
let quotaErrorCount = 0;
const MAX_QUOTA_ERRORS = 3;
let localStorageDisabled = false;

// Helper function to truncate messages to prevent oversized payloads
const truncateMessage = (message: string, maxLength: number = 500): string => {
  if (typeof message !== 'string') {
    return String(message).substring(0, maxLength);
  }
  return message.length > maxLength ? message.substring(0, maxLength) + '...' : message;
};

// Store logs locally when not authenticated
export const storeLocalLog = (type: 'message' | 'activity' | 'user_activity', payload: LogPayload | ActivityPayload): void => {
  // Prevent infinite recursion
  if (isStoringLocalLog) {
    return;
  }
  
  // Check if localStorage is available (not available in Web Workers)
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  
  // If localStorage is disabled due to quota errors, don't try to use it
  if (localStorageDisabled) {
    return;
  }
  
  isStoringLocalLog = true;
  try {
    // Truncate message in payload before storing
    const truncatedPayload = {
      ...payload,
      message: truncateMessage(payload.message || '')
    };
    
    const logs: PendingLog[] = JSON.parse(localStorage.getItem('pending_logs') || '[]');
    logs.push({
      type,
      payload: truncatedPayload,
      timestamp: new Date().toISOString()
    });
    
    // Keep only last 50 logs to prevent storage bloat and quota issues
    if (logs.length > 50) {
      logs.splice(0, logs.length - 50);
    }
    
    // Try to store, but handle quota errors gracefully
    try {
      localStorage.setItem('pending_logs', JSON.stringify(logs));
      // Success - reset quota error count
      quotaErrorCount = 0;
    } catch (quotaError: any) {
      // If quota exceeded, clear old logs and try again with just the new one
      if (quotaError.name === 'QuotaExceededError' || quotaError.code === 22) {
        quotaErrorCount++;
        
        // If we've hit quota errors too many times, disable localStorage logging
        if (quotaErrorCount >= MAX_QUOTA_ERRORS) {
          localStorageDisabled = true;
          // Clear all pending logs to free up space
          try {
            localStorage.removeItem('pending_logs');
          } catch (e) {
            // Ignore errors when clearing
          }
          return;
        }
        
        // Try to clear all logs and store just the most recent one
        try {
          localStorage.removeItem('pending_logs');
          localStorage.setItem('pending_logs', JSON.stringify([{
            type,
            payload: truncatedPayload,
            timestamp: new Date().toISOString()
          }]));
        } catch (retryError) {
          // If even a single log fails, disable localStorage
          localStorageDisabled = true;
          try {
            localStorage.removeItem('pending_logs');
          } catch (e) {
            // Ignore errors when clearing
          }
        }
      } else {
        throw quotaError;
      }
    }
  } catch (error) {
    // Silently fail - DO NOT log to console to avoid recursion
    // The error is already being displayed in the browser console from the original throw
  } finally {
    isStoringLocalLog = false;
  }
};

/** Browser offline (DevTools throttling, airplane mode, etc.) — avoid pointless fetches and auth retries. */
function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// Ensure CSRF cookie exists for the target service by calling its /health endpoint
const ensureCsrfFor = async (targetUrl: string): Promise<void> => {
  try {
    if (isBrowserOffline()) {
      return;
    }
    // Skip in Web Workers (no window, no CSRF needed)
    if (typeof window === 'undefined') {
      return;
    }
    
    // Handle both relative (nginx) and absolute URLs
    let serviceOrigin: string;
    if (targetUrl.startsWith('/') || targetUrl.startsWith('./')) {
      // Relative URL - use current origin
      serviceOrigin = window.location.origin;
    } else {
      // Absolute URL - extract origin
      serviceOrigin = new URL(targetUrl).origin;
    }
    const healthUrl = serviceOrigin + '/api/health';
    await fetch(healthUrl, { method: 'GET', credentials: 'include' });
  } catch (_) {
    // ignore preflight failures; main call may still succeed
  }
};

// Enhanced logMessage with better error handling
export async function logMessage(file_name: string, message_type: LogLevel, message: string, context: Record<string, any> | string = {}): Promise<void> {
  // Truncate message to prevent oversized payloads
  const truncatedMessage = truncateMessage(message);
  
  // Prevent infinite recursion - if we're already logging or have too many errors, just store locally
  if (isLogging || loggingErrorCount >= MAX_LOGGING_ERRORS) {
    storeLocalLog('message', {
      file_name: file_name,
      message_type: message_type,
      message: truncatedMessage,
      context: typeof context === 'string' ? context : JSON.stringify(context)
    });
    return;
  }

  // Use /api/log/message (not /api/admin/log/message) - matches server_admin route
  const url = `/api/log/message`;
  const payload: LogPayload = {
    file_name: file_name, 
    message_type: message_type, 
    message: truncatedMessage, 
    context: typeof context === 'string' ? context : JSON.stringify(context)
  };

  isLogging = true;
  try {
    // Import authManager to get authentication
    const { authManager } = await import('./authManager');
    
    // Check if user is authenticated
    if (!authManager.isAuthenticated()) {
      storeLocalLog('message', payload);
      return;
    }

    // Offline: skip network (no /api/health, no log POST, no makeAuthenticatedRequest retries).
    // Debug lines already printed in the browser console via console.ts.
    if (isBrowserOffline()) {
      if (message_type === LOG_LEVELS.DEBUG) {
        return;
      }
      storeLocalLog('message', payload);
      return;
    }

    // Make sure CSRF cookie for admin service exists
    await ensureCsrfFor(url);

    const response = await authManager.makeAuthenticatedRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      loggingErrorCount++;
      const errorText = await response.text();
      // Only log to console if it's a real error (not just unauthenticated or endpoint not found)
      // NEVER call logError here - it would cause infinite recursion!
      // 404 means endpoint doesn't exist - don't log as error (endpoint may not be deployed)
      if (response.status !== 401 && response.status !== 403 && response.status !== 404 && response.status !== 502) {
        consoleError(`[Logging] Failed to log message: ${response.status} ${response.statusText}`, errorText);
      }
      // DON'T store locally if authenticated - it means the endpoint is failing/missing
      // Only store locally when NOT authenticated (handled by the check above at line 193)
      // This prevents infinite accumulation of logs when the logging endpoint is down/missing
    } else {
      // Success - reset error count
      loggingErrorCount = 0;
    }
  } catch (err) {
    loggingErrorCount++;
    // NEVER call logError here - it would cause infinite recursion!
    // Connection refused/502 errors are expected when server_admin is down - don't spam console
    if (err instanceof Error && !err.message.includes('Connection') && !err.message.includes('Failed to fetch') && !err.message.includes('502')) {
      consoleError('[Logging] Exception log failed:', err);
    }
    // DON'T store locally if we're authenticated - it means the server is down
    // The check at line 193 already stored it locally if not authenticated
  } finally {
    isLogging = false;
  }
}

// New: Structured error logging
export async function logError(file_name: string, error: Error, additionalContext: Record<string, any> = {}): Promise<void> {
  // Truncate error message to prevent oversized payloads
  const truncatedErrorMessage = truncateMessage(error.message);
  
  // Prevent infinite recursion - if logging is failing, don't try to log errors
  if (isLogging || loggingErrorCount >= MAX_LOGGING_ERRORS) {
    // Just store locally without attempting to send
    storeLocalLog('message', {
      file_name: file_name,
      message_type: LOG_LEVELS.ERROR,
      message: truncatedErrorMessage,
      context: JSON.stringify(buildContext(error, additionalContext))
    });
    return;
  }
  
  const context = buildContext(error, additionalContext);
  await logMessage(file_name, LOG_LEVELS.ERROR, truncatedErrorMessage, context);
}

// New: Warning logging
export async function logWarning(file_name: string, message: string, context: Record<string, any> = {}): Promise<void> {
  await logMessage(file_name, LOG_LEVELS.WARN, message, context);
}

// New: Info logging
export async function logInfo(file_name: string, message: string, context: Record<string, any> = {}): Promise<void> {
  await logMessage(file_name, LOG_LEVELS.INFO, message, context);
}

// New: Debug logging
export async function logDebug(file_name: string, message: string, context: Record<string, any> = {}): Promise<void> {
  await logMessage(file_name, LOG_LEVELS.DEBUG, message, context);
}

// Enhanced activity logging - logs to user_activity table
export async function logActivity(project_id: number, dataset_id: number, file_name: string, message: string, context: Record<string, any> | string): Promise<void> {
  // Truncate message to prevent oversized payloads
  const truncatedMessage = truncateMessage(message);
  
  // Use /api/log/activity (not /api/admin/log/activity) - matches server_admin route
  const url = `/api/log/activity`;
  const payload: ActivityPayload = {
    project_id: project_id, 
    dataset_id: dataset_id, 
    file_name: file_name, 
    message: truncatedMessage, 
    context: typeof context === 'string' ? context : JSON.stringify(context)
  };

  try {
    // Import authManager to get authentication
    const { authManager } = await import('./authManager');
    
    // Check if user is authenticated
    if (!authManager.isAuthenticated()) {
      storeLocalLog('activity', payload);
      return;
    }

    if (isBrowserOffline()) {
      storeLocalLog('activity', payload);
      return;
    }

    // Ensure CSRF cookie for admin service exists
    await ensureCsrfFor(url);

    const response = await authManager.makeAuthenticatedRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Only log to console if it's a real error (not just unauthenticated)
      if (response.status !== 401 && response.status !== 403 && response.status !== 404) {
        consoleError(`[Logging] Activity logging failed: ${response.status} ${response.statusText}`, errorText);
      }
      // DON'T store locally if authenticated - it means the endpoint is failing/missing
      // Only store locally when NOT authenticated (handled by the check above at line 296)
    }
  } catch (err) {
    // Only log to console if it's a real error (not just connection refused from unauthenticated state)
    // Connection refused errors are expected when not logged in - don't spam console
    if (err instanceof Error && !err.message.includes('Connection') && !err.message.includes('Failed to fetch') && !err.message.includes('502')) {
      consoleError('[Logging] Exception activity log failed:', err);
    }
    // DON'T store locally if we're authenticated - it means the server is down
  }
}

// Helper function to get current project and dataset IDs
export const getCurrentProjectDatasetIds = async (): Promise<{ project_id: number; dataset_id: number }> => {
  try {
    const { persistantStore } = await import('../store/persistantStore');
    const project_id = persistantStore.selectedProjectId() || 0;
    const dataset_id = persistantStore.selectedDatasetId() || 0;
    return { project_id, dataset_id };
  } catch (error) {
    warn('Could not get project/dataset IDs, using defaults:', error);
    return { project_id: 0, dataset_id: 0 };
  }
};

// Helper function to log page load activity
export const logPageLoad = async (fileName: string, pageName: string, context: string = 'Loaded'): Promise<void> => {
  const { project_id, dataset_id } = await getCurrentProjectDatasetIds();
  await logActivity(project_id, dataset_id, fileName, pageName, context);
};


// Flush pending logs when user logs in
export async function flushPendingLogs(): Promise<void> {
  try {
    if (isBrowserOffline()) {
      return;
    }

    const logs: PendingLog[] = JSON.parse(localStorage.getItem('pending_logs') || '[]');
    
    if (logs.length === 0) {
      return;
    }

    for (const log of logs) {
      try {
        if (log.type === 'message') {
          const messagePayload = log.payload as LogPayload;
          await logMessage(messagePayload.file_name, messagePayload.message_type as LogLevel, messagePayload.message, messagePayload.context);
        } else if (log.type === 'activity') {
          const activityPayload = log.payload as ActivityPayload;
          await logActivity(activityPayload.project_id, activityPayload.dataset_id, activityPayload.file_name, activityPayload.message, activityPayload.context);
        } else if (log.type === 'user_activity') {
          // For user activity, we need to use the user-activity endpoint
          const { authManager } = await import('./authManager');
          // Use /api/log/user-activity (not /api/admin/log/user-activity) - matches server_admin route
          const url = `/api/log/user-activity`;
          await ensureCsrfFor(url);
          
          const response = await authManager.makeAuthenticatedRequest(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(log.payload)
          });
          
          if (!response.ok) {
            logError("Failed to flush user activity log:", response.status);
          }
        }
        
        // Small delay to prevent overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logError('Failed to flush log:', error);
      }
    }

    // Clear pending logs after successful flush
    localStorage.removeItem('pending_logs');
    
    // Reset quota error tracking after successful flush
    quotaErrorCount = 0;
    localStorageDisabled = false;
  } catch (error) {
    logError('Failed to flush pending logs:', error);
  }
}

// Clear all pending logs and reset localStorage logging
export function clearPendingLogs(): void {
  try {
    localStorage.removeItem('pending_logs');
    quotaErrorCount = 0;
    localStorageDisabled = false;
  } catch (error) {
    // Silently fail
  }
}

// Clean up old pending logs (older than maxAgeMs)
export function cleanupOldLogs(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
  try {
    const logs: PendingLog[] = JSON.parse(localStorage.getItem('pending_logs') || '[]');
    const now = Date.now();
    const cutoffTime = now - maxAgeMs;
    
    const freshLogs = logs.filter(log => {
      try {
        const logTime = new Date(log.timestamp).getTime();
        return logTime > cutoffTime;
      } catch (e) {
        // Invalid timestamp - remove it
        return false;
      }
    });
    
    const removedCount = logs.length - freshLogs.length;
    
    if (removedCount > 0) {
      if (freshLogs.length > 0) {
        localStorage.setItem('pending_logs', JSON.stringify(freshLogs));
      } else {
        localStorage.removeItem('pending_logs');
      }
    }
    
    return removedCount;
  } catch (error) {
    // Silently fail
    return 0;
  }
}

// Get localStorage usage statistics
export function getLocalStorageStats(): { totalSize: number; pendingLogsSize: number; pendingLogsCount: number; otherSize: number } {
  try {
    let totalSize = 0;
    let pendingLogsSize = 0;
    let pendingLogsCount = 0;
    
    // Calculate total size
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const value = localStorage.getItem(key) || '';
        const itemSize = key.length + value.length;
        totalSize += itemSize;
        
        if (key === 'pending_logs') {
          pendingLogsSize = itemSize;
          try {
            const logs = JSON.parse(value);
            pendingLogsCount = Array.isArray(logs) ? logs.length : 0;
          } catch (e) {
            // Invalid JSON
          }
        }
      }
    }
    
    return {
      totalSize,
      pendingLogsSize,
      pendingLogsCount,
      otherSize: totalSize - pendingLogsSize
    };
  } catch (error) {
    return {
      totalSize: 0,
      pendingLogsSize: 0,
      pendingLogsCount: 0,
      otherSize: 0
    };
  }
}
