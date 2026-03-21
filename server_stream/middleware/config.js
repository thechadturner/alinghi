const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

// Determine environment mode
const isProduction = process.env.NODE_ENV === "production";

// Get project root (two levels up from server_stream/middleware/)
const projectRoot = path.join(__dirname, "../../");

// Load environment files based on mode
// Development: .env -> .env.local
// Production: .env.production -> .env.production.local
const baseEnvFile = isProduction ? ".env.production" : ".env";
const localEnvFile = isProduction ? ".env.production.local" : ".env.local";

const baseEnvPath = path.join(projectRoot, baseEnvFile);
const localEnvPath = path.join(projectRoot, localEnvFile);

// In Docker containers, .env files don't exist - Docker Compose sets env vars via env_file
// In local development, .env files exist and should be loaded
// Priority: process.env (Docker/system) > .env.production.local > .env.production

// Start with process.env (highest priority - includes Docker env vars)
const config = Object.assign({}, process.env);

// Only load from files if they exist (for local development)
// In Docker, these files don't exist, so we rely on process.env set by Docker Compose
if (fs.existsSync(baseEnvPath)) {
  const env = dotenv.config({ path: baseEnvPath, quiet: true }).parsed || {};
  // Only add properties that aren't already set in process.env
  Object.keys(env).forEach(key => {
    if (!(key in config) || config[key] === undefined || config[key] === '') {
      config[key] = env[key];
    }
  });
}

if (fs.existsSync(localEnvPath)) {
  const envLocal = dotenv.config({ path: localEnvPath, quiet: true }).parsed || {};
  // Local env file can override base, but not process.env (Docker vars)
  Object.keys(envLocal).forEach(key => {
    if (!(key in config) || config[key] === undefined || config[key] === '') {
      config[key] = envLocal[key];
    }
  });
}

module.exports = config;

