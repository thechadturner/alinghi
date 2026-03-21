const { Pool } = require("pg");
const env = require('./config');
const { logMessage } = require('./logging');
const { error } = require('../../shared');

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

const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl: sslConfig,
  max: 20,                        // Maximum number of clients in the pool
  min: 2,                         // Minimum number of clients in the pool
  connectionTimeoutMillis: 10000, // 10 second timeout
  idleTimeoutMillis: 300000,      // 5 minute idle timeout
  acquireTimeoutMillis: 30000     // 30 second acquire timeout
});

pool.on('error', (err, client) => {
  error('Error:', err);
  process.exit(-1);
});

function GetSuperUser() {
	const superUser = env.SUPER_USER;
	return superUser ? superUser.trim() : superUser;
}

async function ExecuteCommand(sql, params) {
	const client = await pool.connect();
	try {
		await client.query(sql, params);
		return true;
    } catch (error) {
        logMessage(null, 'server_app/db.js', 'error', 'Error in ExecuteCommand: '+error)
		return false;
	} finally {
		client.release();
	}
}

async function GetValueExists(sql, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(sql, params);
		return result.rowCount > 0;
    } catch (error) {
        logMessage(null, 'server_app/db.js', 'error', 'Error in GetValueExists: '+error)
		return false;
	} finally {
		client.release();
	}
}

async function GetValue(sql, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(sql, params);
		return result.rowCount > 0 ? result.rows[0]["value"] : null;
    } catch (error) {
        logMessage(null, 'server_app/db.js', 'error', 'Error in GetValue: '+error)
		return null;
	} finally {
		client.release();
	}
}

async function GetRows(sql, params) {
	const client = await pool.connect();
	try {
		const result = await client.query(sql, params);
		return result.rows || [];
    } catch (error) {
        logMessage(null, 'server_app/db.js', 'error', 'Error in GetRows: '+error)
		throw error; // Re-throw error so caller can handle it
	} finally {
		client.release();
	}
}

module.exports = {
	GetSuperUser,
  	ExecuteCommand,
  	GetValueExists,
  	GetValue,
  	GetRows,
};
