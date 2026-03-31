const { Pool } = require("pg");
const { pgSocketFamily } = require('../../shared/database/pgFamily');
const env = require('./config');
const { error, log } = require('../../shared');

// SSL configuration for PostgreSQL
// Default: SSL enabled (required for hosted PostgreSQL services like AWS RDS, Azure, etc.)
// Set DB_SSL=false in .env to disable SSL for local development
// For hosted services, typically set:
//   DB_SSL=true (or omit, defaults to true)
//   DB_SSL_REJECT_UNAUTHORIZED=false (for self-signed certs) or true (for CA-signed certs)
const sslEnabled = env.DB_SSL !== 'false' && env.DB_SSL !== '0' && env.DB_SSL !== '';
const sslConfig = sslEnabled ? {
  rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED === 'true' || env.DB_SSL_REJECT_UNAUTHORIZED === '1'
} : false;

const connectionTimeoutMillis = Math.min(
  120000,
  Math.max(1000, parseInt(String(env.DB_CONNECTION_TIMEOUT_MS || '10000'), 10) || 10000)
);

const family = pgSocketFamily(env.DB_HOST, env);
const poolOpts = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl: sslConfig,
  max: 20,                        // Maximum number of clients in the pool
  min: 2,                         // Minimum number of clients in the pool
  connectionTimeoutMillis,
  idleTimeoutMillis: 300000,      // 5 minute idle timeout
  acquireTimeoutMillis: 300000    // 5 minute acquire timeout (increased for large payload operations)
};
if (family !== undefined) poolOpts.family = family;
const pool = new Pool(poolOpts);

pool.on('error', (err, client) => {
  error('Database pool error:', err);
  process.exit(-1);
});

// Monitor pool usage (optional - can be removed in production)
pool.on('connect', (client) => {
  // Set timezone to UTC for all connections to ensure timestamps are interpreted as UTC
  // Use query without await since event handlers can't be async
  client.query('SET timezone = \'UTC\'').catch(err => {
    error('Failed to set timezone to UTC:', err);
  });
  log('Database client connected. Total clients:', pool.totalCount, 'Idle:', pool.idleCount, 'Waiting:', pool.waitingCount);
});

pool.on('remove', (client) => {
  log('Database client removed. Total clients:', pool.totalCount, 'Idle:', pool.idleCount, 'Waiting:', pool.waitingCount);
});

function formatSql(sql) {
	try {
		function replaceAll(string, search, replace) {
			return string.split(search).join(replace);
		}

		let output = replaceAll(sql,'@#','"')

		return output
	} 
	catch 
	{
		return undefined
	}
}

function GetSuperUser() {
	const superUser = env.SUPER_USER;
	return superUser ? superUser.trim() : superUser;
}

async function GetValue(sql, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(sql, params);
		return result.rowCount > 0 ? result.rows[0]["value"] : null;
	} catch (error) {
		db_logger('GetValue', 'Error in GetValue: '+error)
		return null;
	} finally {
		client.release();
	}
}

async function GetRows(sql, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(sql, params);
		return result.rowCount > 0 ? result.rows : null;
	} catch (error) {
		db_logger('GetRows', 'Error in GetRows: '+error)
		return null;
	} finally {
		client.release();
	}
}

async function GetRow(sql, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(sql, params);
		return result.rowCount > 0 ? result.rows[0] : null;
	} catch (error) {
		db_logger('GetRow', 'Error in GetRow: '+error)
		return null;
	} finally {
		client.release();
	}
}

async function ExecuteCommand(sql, params) {
	const client = await pool.connect();
	try {
		// Set timezone to UTC to ensure all timestamps are interpreted as UTC
		await client.query('SET timezone = \'UTC\'');
		// Set statement timeout to 10 minutes for large JSONB operations
		// This is especially important for large payload inserts/updates
		await client.query('SET statement_timeout = 600000'); // 10 minutes in milliseconds
		await client.query(sql, params);
		return true;
	} catch (error) {
		db_logger('ExecuteCommand', 'Error in ExecuteCommand: '+error)
		return false;
	} finally {
		client.release();
	}
}

/**
 * Like ExecuteCommand but returns { success: true } or { success: false, error: message } so callers can surface the DB error.
 */
async function ExecuteCommandWithError(sql, params) {
	const client = await pool.connect();
	try {
		await client.query('SET timezone = \'UTC\'');
		await client.query('SET statement_timeout = 600000');
		await client.query(sql, params);
		return { success: true };
	} catch (error) {
		db_logger('ExecuteCommandWithError', 'Error in ExecuteCommandWithError: ' + error);
		return { success: false, error: error && (error.message || String(error)) };
	} finally {
		client.release();
	}
}

async function db_logger(location, message) {
	const client = await pool.connect();
	try {
		const client_ip = '0.0.0.0'
        const user_id = '3dbcc8d0-6666-4359-8f60-211277d27326'
		const file_name = 'server_admin/db.js'
		const message_type = 'error'

		const sql = `INSERT INTO admin.log_activity (client_ip, user_id, file_name, log_type, log_level, message, context) VALUES ($1, $2, $3, $4, 'admin/server', $5, $6)`;
        const params = [ client_ip, user_id, file_name, message_type, location, message ];
        
		await client.query(sql, params);
		return true;
	} catch (error) {
		// Lazy load logMessage to avoid circular dependency
		const { logMessage } = require('./logging');
		logMessage('0.0.0.0', '0', 'database', 'error', `Database error: ${error.message}`, { error: error.stack });
		return false;
	} finally {
		client.release();
	}
}

module.exports = {
	formatSql,
	GetSuperUser,
	ExecuteCommand,
	ExecuteCommandWithError,
	GetValue,
	GetRows,
	GetRow
};
