const path = require('path');
const fs = require('fs');
const dotenv = require("dotenv");

// Determine environment mode
const isProduction = process.env.NODE_ENV === "production";

// Get project root (two levels up from shared/utils/)
const projectRoot = path.join(__dirname, '../../');

// Load environment files based on mode
// Development: .env -> .env.local
// Production: .env.production -> .env.production.local
const baseEnvFile = isProduction ? ".env.production" : ".env";
const localEnvFile = isProduction ? ".env.production.local" : ".env.local";

const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// Load base .env file first (defaults)
dotenv.config({ path: baseEnvPath, quiet: true });

// Load local .env file second (overrides base, gitignored secrets)
dotenv.config({ path: localEnvPath, quiet: true, override: true });

// Get parsed environment (already loaded into process.env)
const env = process.env;

// File logging utilities
const getLogFilePath = (type) => {
    const date = new Date().toISOString().split("T")[0]; 
    return path.join(__dirname, "logs", `${type}-${date}.log`);
};

// Ensure logs directory exists
if (!fs.existsSync(path.join(__dirname, "logs"))) {
    fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });
}

// Function to write logs to file
const writeLogToFile = async (type, message) => {
    try {
        const logFilePath = getLogFilePath(type);
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp} - ${message}\n`;
    
        fs.appendFile(logFilePath, logMessage, (err) => {
            if (err) console.error("Error writing to log file:", err);
        });
    } catch (error) {
        // Log error to file instead of console
        writeLogToFile("exception", `Logging system error: ${error.message}`);
    }
};

/**
 * Centralized logging utility
 * Integrates with existing admin.log_activity table
 * Matches admin server logging functionality
 */
class Logger {
  constructor() {
    this.defaultUserId = '3dbcc8d0-6666-4359-8f60-211277d27326';
    this.defaultClientIp = '127.0.0.1';
    
    // Batch logging for high-volume operations
    this.logBuffer = [];
    this.BATCH_SIZE = 50;
    this.BATCH_TIMEOUT = 5000; // 5 seconds
    
    // Log retention settings (in days)
    this.LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10); // Default 30 days
    this.CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Run cleanup once per day
    
    // Set up batch flushing
    setInterval(() => this.flushLogBuffer(), this.BATCH_TIMEOUT);
    
    // Set up log file cleanup (run once per day)
    this.scheduleLogCleanup();
  }
  
  /**
   * Clean up old log files based on retention policy
   */
  async cleanupOldLogFiles() {
    try {
      const logsDir = path.join(__dirname, "logs");
      if (!fs.existsSync(logsDir)) {
        return; // No logs directory, nothing to clean
      }
      
      const files = fs.readdirSync(logsDir);
      const now = new Date();
      const cutoffDate = new Date(now);
      cutoffDate.setDate(cutoffDate.getDate() - this.LOG_RETENTION_DAYS);
      
      let deletedCount = 0;
      let totalSizeFreed = 0;
      
      for (const file of files) {
        // Only process log files matching our pattern: {type}-{YYYY-MM-DD}.log
        const match = file.match(/^(.+)-(\d{4}-\d{2}-\d{2})\.log$/);
        if (!match) {
          continue; // Skip files that don't match the pattern
        }
        
        const [, type, dateStr] = match;
        const fileDate = new Date(dateStr + 'T00:00:00Z');
        
        if (fileDate < cutoffDate) {
          const filePath = path.join(logsDir, file);
          try {
            const stats = fs.statSync(filePath);
            totalSizeFreed += stats.size;
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (err) {
            console.error(`Error deleting log file ${file}:`, err.message);
          }
        }
      }
      
      if (deletedCount > 0) {
        const sizeMB = (totalSizeFreed / (1024 * 1024)).toFixed(2);
        console.log(`[Logger] Cleaned up ${deletedCount} old log file(s), freed ${sizeMB} MB`);
        // Log the cleanup activity
        writeLogToFile("activity", `Log cleanup: Deleted ${deletedCount} file(s) older than ${this.LOG_RETENTION_DAYS} days, freed ${sizeMB} MB`);
      }
    } catch (error) {
      console.error('[Logger] Error during log file cleanup:', error);
      writeLogToFile("exception", `Log cleanup error: ${error.message}`);
    }
  }
  
  /**
   * Schedule periodic log cleanup
   */
  scheduleLogCleanup() {
    // Run cleanup immediately on startup (in case server was down for a while)
    setImmediate(() => this.cleanupOldLogFiles());
    
    // Then schedule daily cleanup
    setInterval(() => this.cleanupOldLogFiles(), this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Log a message to the database and file
   * Matches admin server logMessage function exactly
   * @param {string} client_ip - Client IP address
   * @param {string} user_id - User ID
   * @param {string} file_name - File name
   * @param {string} type - Message type (error, warning, info, debug)
   * @param {string} message - Log message
   * @param {string} context - Additional context (optional)
   */
  async logMessage(client_ip, user_id, file_name, type, message, context) {
    try {
      // Use default values if not provided (matching admin server behavior)
      if (!client_ip || client_ip === '0' || client_ip === '::1' || client_ip === '0:0:0:0:0:0:0:1' || client_ip === '127.0.0.1') { 
        client_ip = this.defaultClientIp; 
      }
      // Handle "system" user_id from PAT authentication - convert to default UUID
      if (!user_id || user_id === '0' || user_id === 'system') { user_id = this.defaultUserId; }
      
      // Auto-extract server source (level) from file_name path
      let level = 'client'; // Default for client-side files
      if (file_name && typeof file_name === 'string') {
        // Check if it's a Python script first
        if (file_name.includes('.py')) {
          level = 'Script';
        } else {
          // Handle full paths like "Server App][\MyGit\WebApps\TeamShare\server_app\controllers\users.js"
          if (file_name.includes('\\') || file_name.includes('/')) {
            // Extract server source from full path
            if (file_name.includes('server_app')) {
              level = 'server_app';
            } else if (file_name.includes('server_admin')) {
              level = 'server_admin';
            } else if (file_name.includes('server_file')) {
              level = 'server_file';
            } else if (file_name.includes('server_media')) {
              level = 'server_media';
            } else if (file_name.includes('server_stream')) {
              level = 'server_stream';
            } else if (file_name.includes('shared')) {
              level = 'shared';
            }
          } else {
            // Extract server source from file path (e.g., "server_admin/test" -> "server_admin")
            const pathParts = file_name.split('/');
            if (pathParts.length > 0) {
              const firstPart = pathParts[0];
              if (firstPart.startsWith('server_')) {
                level = firstPart; // e.g., "server_admin", "server_app", "server_file", "server_media", "server_stream"
              } else if (firstPart === 'shared') {
                level = 'shared';
              }
            }
          }
        }
      }
      
      // Parse context if it's a JSON string
      let parsedContext = context;
      try {
        parsedContext = typeof context === 'string' ? JSON.parse(context) : context;
      } catch {
        // Keep as string if parsing fails
      }
      
      // Extract just the filename from full path
      let cleanFileName = file_name;
      if (file_name && typeof file_name === 'string') {
        // Handle full paths like "Server App][\MyGit\WebApps\TeamShare\server_app\controllers\users.js"
        if (file_name.includes('\\') || file_name.includes('/')) {
          // Split by both backslash and forward slash, then get the last part
          const pathParts = file_name.split(/[\\\/]/);
          cleanFileName = pathParts[pathParts.length - 1];
        }
      }
          
      const sql = `INSERT INTO admin.log_activity (client_ip, user_id, file_name, log_type, log_level, message, context) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
      const params = [client_ip, user_id, cleanFileName, type, level, message, JSON.stringify(parsedContext)];
      
      // Use shared database connection instead of creating new pool
      const db = require('../database/connection');
      await db.executeCommand(sql, params);

      // Enhanced file logging with levels (matching admin server)
      const logMessage = `${type.toUpperCase()}: ${message} | Context: ${JSON.stringify(parsedContext)}`;
      
      if (type === 'error') {
        writeLogToFile("exception", logMessage);
      } else if (type === 'warn') {
        writeLogToFile("warnings", logMessage);
      } else if (type === 'debug') {
        writeLogToFile("debug", logMessage);
      } else {
        writeLogToFile("activity", logMessage);
      }
    } catch (error) {
      console.error("Logging error:", error);
      writeLogToFile("exception", `Logging system error: ${error.message}`);
    }
  }

  /**
   * Log user activity
   * Matches admin server logActivity function exactly
   * @param {string} client_ip - Client IP address
   * @param {string} user_id - User ID
   * @param {string} project_id - Project ID
   * @param {string} dataset_id - Dataset ID
   * @param {string} file_name - File name
   * @param {string} message - Activity message
   * @param {string} context - Additional context (optional)
   */
  async logActivity(client_ip, user_id, project_id, dataset_id, file_name, message, context) {
    try {
      // Use default values if not provided (matching admin server behavior)
      if (!client_ip || client_ip === '0' || client_ip === '::1' || client_ip === '0:0:0:0:0:0:0:1' || client_ip === '127.0.0.1') { 
        client_ip = this.defaultClientIp; 
      }
      // Handle "system" user_id from PAT authentication - convert to default UUID
      if (!user_id || user_id === '0' || user_id === 'system') { user_id = this.defaultUserId; }
      
      // Extract just the filename from full path
      let cleanFileName = file_name;
      if (file_name && typeof file_name === 'string') {
        // Handle full paths like "Server App][\MyGit\WebApps\TeamShare\server_app\controllers\users.js"
        if (file_name.includes('\\') || file_name.includes('/')) {
          // Split by both backslash and forward slash, then get the last part
          const pathParts = file_name.split(/[\\\/]/);
          cleanFileName = pathParts[pathParts.length - 1];
        }
      }
      
      const sql = `INSERT INTO admin.user_activity (client_ip, user_id, project_id, dataset_id, file_name, message, context) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
      const params = [client_ip, user_id, project_id, dataset_id, cleanFileName, message, context];
      
      // Use shared database connection instead of creating new pool
      const db = require('../database/connection');
      await db.executeCommand(sql, params);

      writeLogToFile("activity", message + ": " + context);
    } catch (error) {
      // Log error to file instead of console
      writeLogToFile("exception", `Logging system error: ${error.message}`);
    }
  }

  /**
   * Log failed login attempt
   * @param {string} userId - User ID
   * @param {string} ipAddress - IP address
   */
  async logFailedLogin(userId, ipAddress) {
    try {
      // Use default values if not provided
      if (!ipAddress || ipAddress === '0' || ipAddress === '::1' || ipAddress === '0:0:0:0:0:0:0:1' || ipAddress === '127.0.0.1') { 
        ipAddress = this.defaultClientIp; 
      }
      
      const sql = `INSERT INTO admin.failed_logins (user_id, ip_address, attempted_at) VALUES ($1, $2, NOW())`;
      const params = [userId, ipAddress];
      
      // Use shared database connection instead of creating new pool
      const db = require('../database/connection');
      await db.executeCommand(sql, params);
    } catch (error) {
      console.error('Failed to log failed login:', error);
    }
  }

  /**
   * Batch logging for high-volume operations
   * Matches admin server batch logging functionality
   */
  async flushLogBuffer() {
    if (this.logBuffer.length === 0) return;
    
    const logsToProcess = this.logBuffer.splice(0, this.BATCH_SIZE);
    
    try {
      const values = logsToProcess.map((log, index) => {
        const paramOffset = index * 7;
        return `($${paramOffset + 1}, $${paramOffset + 2}, $${paramOffset + 3}, $${paramOffset + 4}, $${paramOffset + 5}, $${paramOffset + 6}, $${paramOffset + 7})`;
      }).join(', ');
      
      const sql = `INSERT INTO admin.log_activity (client_ip, user_id, file_name, log_type, log_level, message, context) VALUES ${values}`;
      const params = logsToProcess.flatMap(log => [log.client_ip, log.user_id, log.file_name, log.type, log.level, log.message, log.context]);
      
      const db = require('../database/connection');
      await db.executeCommand(sql, params);
      
      // Write to files
      logsToProcess.forEach(log => {
        const logMessage = `${log.type.toUpperCase()}: ${log.message} | Context: ${log.context}`;
        writeLogToFile("activity", logMessage);
      });
    } catch (error) {
      console.error('Batch logging error:', error.message);
      // Fallback to individual logging
      for (const log of logsToProcess) {
        try {
          await this.logMessage(log.client_ip, log.user_id, log.file_name, log.type, log.message, log.context);
        } catch (err) {
          console.error('Individual logging fallback error:', err.message);
        }
      }
    }
  }

  /**
   * Add log to batch buffer
   * Matches admin server logMessageBatch function
   * @param {string} client_ip - Client IP address
   * @param {string} user_id - User ID
   * @param {string} file_name - File name
   * @param {string} type - Message type
   * @param {string} level - Log level (server source)
   * @param {string} message - Log message
   * @param {string} context - Additional context
   */
  logMessageBatch(client_ip, user_id, file_name, type, level, message, context) {
    if (!client_ip || client_ip === '0' || client_ip === '::1' || client_ip === '0:0:0:0:0:0:0:1' || client_ip === '127.0.0.1') client_ip = this.defaultClientIp;
    if (!user_id || user_id === '0') user_id = this.defaultUserId;
    
    const parsedContext = typeof context === 'string' ? context : JSON.stringify(context);
    
    this.logBuffer.push({
      client_ip,
      user_id,
      file_name,
      type,
      level,
      message,
      context: parsedContext
    });
    
    // Flush immediately if buffer is full
    if (this.logBuffer.length >= this.BATCH_SIZE) {
      setImmediate(() => this.flushLogBuffer());
    }
  }
}

// Create singleton instance
const logger = new Logger();

// Export individual functions matching admin server API
const logMessage = (client_ip, user_id, file_name, type, message, context) => {
  return logger.logMessage(client_ip, user_id, file_name, type, message, context);
};

const logActivity = (client_ip, user_id, project_id, dataset_id, file_name, message, context) => {
  return logger.logActivity(client_ip, user_id, project_id, dataset_id, file_name, message, context);
};

const logUserActivity = (clientIp, userId, projectId, datasetId, fileName, message, context) => {
  return logger.logActivity(clientIp, userId, projectId, datasetId, fileName, message, context);
};

const logFailedLogin = (userId, ipAddress) => {
  return logger.logFailedLogin(userId, ipAddress);
};

const logMessageBatch = (client_ip, user_id, file_name, type, level, message, context) => {
  return logger.logMessageBatch(client_ip, user_id, file_name, type, level, message, context);
};

// Export file logging function for external use
const writeLogToFileExport = (type, message) => {
  return writeLogToFile(type, message);
};

module.exports = {
  Logger,
  logMessage,
  logActivity,
  logUserActivity,
  logFailedLogin,
  logMessageBatch,
  writeLogToFile: writeLogToFileExport
};
