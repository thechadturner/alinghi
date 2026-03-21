const { Pool } = require("pg");
const path = require('path');
const dotenv = require("dotenv");
const fs = require("fs");

// Determine environment mode
const isProduction = process.env.NODE_ENV === "production";

// Get project root (two levels up from shared/database/)
const projectRoot = path.join(__dirname, "../../");

// Load environment files based on mode
// Development: .env -> .env.local
// Production: .env.production -> .env.production.local
const baseEnvFile = isProduction ? ".env.production" : ".env";
const localEnvFile = isProduction ? ".env.production.local" : ".env.local";

const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// Debug logging for environment loading
console.log(`[CONFIG] NODE_ENV: ${process.env.NODE_ENV || 'undefined'}`);
console.log(`[CONFIG] isProduction: ${isProduction}`);
console.log(`[CONFIG] Loading base env file: ${baseEnvPath} (exists: ${fs.existsSync(baseEnvPath)})`);
console.log(`[CONFIG] Loading local env file: ${localEnvPath} (exists: ${fs.existsSync(localEnvPath)})`);

// Load base .env file first (defaults)
const env = dotenv.config({ path: baseEnvPath, quiet: true }).parsed || {};

// Load local .env file second (overrides base, gitignored secrets)
const envLocal = dotenv.config({ path: localEnvPath, quiet: true }).parsed || {};

// Merge: base env -> local env -> process.env (highest priority, Docker/system)
// This ensures Docker environment variables work correctly
const config = Object.assign({}, env, envLocal, process.env);

// Debug logging for SUPER_USER (masked for security)
const superUserValue = config.SUPER_USER;
if (superUserValue) {
  const masked = superUserValue.length > 8 
    ? `${superUserValue.substring(0, 4)}...${superUserValue.substring(superUserValue.length - 4)}`
    : '***';
  console.log(`[CONFIG] SUPER_USER loaded: ${masked} (length: ${superUserValue.length})`);
  // Check for whitespace issues
  if (superUserValue !== superUserValue.trim()) {
    console.warn(`[CONFIG] WARNING: SUPER_USER has leading/trailing whitespace! Original length: ${superUserValue.length}, Trimmed length: ${superUserValue.trim().length}`);
  }
} else {
  console.warn(`[CONFIG] WARNING: SUPER_USER is not set!`);
  console.log(`[CONFIG] Available env keys: ${Object.keys(config).filter(k => k.includes('SUPER') || k.includes('USER')).join(', ') || 'none'}`);
}

// Remove circular dependency - logging will be handled by caller

/**
 * Centralized database connection pool
 * Wraps existing database connection patterns from server_app
 */
class DatabaseConnection {
  constructor() {
    // Use config (merged env + process.env) instead of just env
    // For Docker: use host.docker.internal or the host IP (192.168.0.18)
    // For local: use localhost
    const dbHost = config.DB_HOST || '192.168.0.18';
    const dbPort = config.DB_PORT || 5432;
    const dbName = config.DB_NAME || 'hunico';
    const dbUser = config.DB_USER || 'postgres';
    const dbPassword = config.DB_PASSWORD || '';
    
    // SSL configuration for PostgreSQL
    // Default: SSL enabled (required for hosted PostgreSQL services like AWS RDS, Azure, etc.)
    // Set DB_SSL=false in .env to disable SSL for local development
    // For hosted services, typically set:
    //   DB_SSL=true (or omit, defaults to true)
    //   DB_SSL_REJECT_UNAUTHORIZED=false (for self-signed certs) or true (for CA-signed certs)
    const sslEnabled = config.DB_SSL !== 'false' && config.DB_SSL !== '0' && config.DB_SSL !== '';
    const sslConfig = sslEnabled ? {
      rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED === 'true' || config.DB_SSL_REJECT_UNAUTHORIZED === '1'
    } : false;
    
    this.pool = new Pool({
      host: dbHost,
      port: dbPort,
      database: dbName,
      user: dbUser,
      password: dbPassword,
      ssl: sslConfig,
      max: 20,                        // Maximum number of clients in the pool
      min: 2,                         // Minimum number of clients in the pool
      connectionTimeoutMillis: 10000, // 10 second timeout
      idleTimeoutMillis: 300000,      // 5 minute idle timeout
      acquireTimeoutMillis: 30000     // 30 second acquire timeout
    });

    this.pool.on('error', (err, client) => {
      console.error('Database pool error:', err);
      process.exit(-1);
    });
  }

  /**
   * Execute a command (INSERT, UPDATE, DELETE)
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<boolean>} Success status
   */
  async executeCommand(sql, params = []) {
    const client = await this.pool.connect();
    try {
      await client.query(sql, params);
      return true;
    } catch (error) {
      console.error('Database executeCommand error:', error.message);
      console.error('SQL:', sql);
      console.error('Params:', params);
      console.error('Full error:', error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Get a single value from query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<any>} Single value or null
   */
  async getValue(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rowCount > 0 ? result.rows[0]["value"] : null;
    } catch (error) {
      console.error('Database getValue error:', error.message);
      return null;
    } finally {
      client.release();
    }
  }

  /**
   * Get multiple rows from query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>} Array of rows or null
   */
  async getRows(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rowCount > 0 ? result.rows : null;
    } catch (error) {
      console.error('Database getRows error:', error.message);
      return null;
    } finally {
      client.release();
    }
  }

  /**
   * Check if a value exists
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<boolean>} Exists status
   */
  async getValueExists(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rowCount > 0;
    } catch (error) {
      console.error('Database getValueExists error:', error.message);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Get super user ID from environment
   * @returns {string} Super user ID (trimmed to remove whitespace)
   */
  getSuperUser() {
    const superUser = config.SUPER_USER;
    return superUser ? superUser.trim() : superUser;
  }

  /**
   * Close the connection pool
   */
  async close() {
    await this.pool.end();
  }
}

// Create singleton instance
const db = new DatabaseConnection();

module.exports = db;
