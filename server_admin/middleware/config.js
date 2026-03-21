const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

// Determine environment mode
const isProduction = process.env.NODE_ENV === "production";

// Get project root (two levels up from server_admin/middleware/)
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
// This ensures environment variables from Docker/process are used if set
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

module.exports = config;
