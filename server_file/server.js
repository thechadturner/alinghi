const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const http = require('http'); 
const { csrfProtection } = require('../shared/middleware/csrf');
const db = require('../shared/database/connection');
const { installConsoleGate, logAlways, log, error, warn, debug } = require('../shared');

const config = require('./middleware/config');
const fileRoutes = require('./routes/files');
const { checkInfluxDBHealth } = require('./middleware/influxdb_utils');

// Install console gate early to wrap all console.* calls
installConsoleGate();

const app = express();

// Middleware
// Read allowed origins strictly from env var; no hardcoded defaults
const allowedOrigins = (config.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Helmet with CSP (stricter in production)
if (process.env.NODE_ENV === 'production') {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"] ,
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'", ...allowedOrigins],
          "object-src": ["'none'"],
          "worker-src": ["'self'", "blob:"],
        }
      },
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    })
  );
} else {
  app.use(helmet());
}
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Compression middleware with optimized settings
// Compress JSON responses and other text-based content
app.use(compression({
  level: 6, // Compression level (0-9): 6 provides good balance between compression ratio and CPU usage
  threshold: 1024, // Only compress responses larger than 1KB
  filter: (req, res) => {
    // Compress JSON, text, and other compressible content types
    // Skip compression for already compressed formats (images, videos, etc.)
    if (req.headers['x-no-compression']) {
      return false;
    }
    const contentType = res.getHeader('content-type') || '';
    return /json|text|javascript|css|xml|html|svg/i.test(contentType);
  }
}));

// CORS configuration
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
    exposedHeaders: ['X-CSRF-Token'],
    optionsSuccessStatus: 204,
  })
);

// CSRF protection
app.use(csrfProtection(allowedOrigins));

// Log ALL incoming requests at the very start (before routes)
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    log(`[server_file] Incoming request: ${req.method} ${req.path} (url=${req.url}, originalUrl=${req.originalUrl}, ip=${req.ip})`);
    log(`[server_file] Request headers: ${JSON.stringify({
      'content-type': req.headers['content-type'],
      'authorization': req.headers['authorization'] ? 'Bearer ***' : 'none',
      'user-agent': req.headers['user-agent']?.substring(0, 50)
    })}`);
  }
  next();
});

// Diagnostic endpoint to list all registered routes (must be BEFORE router mounts)
app.get('/api/file/routes', (req, res) => {
  const routes = [];
  
  // Get routes from fileRoutes
  fileRoutes.stack.forEach((r) => {
    if (r.route) {
      const methods = Object.keys(r.route.methods).join(',').toUpperCase();
      routes.push({
        method: methods,
        path: r.route.path,
        fullPath: `/api/file${r.route.path}`
      });
    }
  });
  
  res.json({
    status: 'ok',
    message: 'Registered routes',
    routes: routes,
    total: routes.length
  });
});

// Routes
// Mount more specific route first to avoid path matching issues
// This ensures /api/file/* routes are matched before /api/* routes
// When a request comes to /api/file/channels, Express will:
// 1. Try /api/file mount first (more specific)
// 2. Strip /api/file from path, leaving /channels
// 3. Match /channels route in the router
// 
// Available routes when mounted at /api/file:
// - GET /api/file/channels - Get list of channels
// - GET /api/file/influxdb/available - Check InfluxDB availability
// - GET /api/file/classes - Get list of classes
// - GET /api/file/dates - Get list of dates
// - GET /api/file/sources - Get list of sources
// - POST /api/file/channel-values - Get channel values (DuckDB)
// - POST /api/file/channel-groups - Group channels by filename
app.use('/api/file', fileRoutes); // Handle /api/file routes (for direct access without nginx)
app.use('/api', fileRoutes); // JWT-based file endpoints (also accessible at /api/channels, etc.)

// Log registered routes in development
if (config.VITE_VERBOSE === 'true' || process.env.NODE_ENV !== 'production') {
  log('[server_file] File routes mounted at /api/file and /api');
  log('[server_file] Available endpoints: /channels, /influxdb/available, /channel-values, etc.');
  // Log the router stack to verify routes are registered
  fileRoutes.stack.forEach((r) => {
    if (r.route) {
      const methods = Object.keys(r.route.methods).join(',').toUpperCase();
      log(`[server_file] Route registered: ${methods} ${r.route.path}`);
    }
  });
}

// Debug: Log all unmatched routes (before error handler)
// This middleware runs after route matching, so unmatched routes will be logged
// NOTE: Async routes may not have sent response yet, so we check after a delay
// REMOVED: This was causing issues with async route handlers - the 404 handler below will catch unmatched routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'file', uptime: process.uptime(), timestamp: Date.now() });
});

// DuckDB health check
app.get('/api/health/duckdb', async (req, res) => {
  try {
    const { DuckDBInstance } = require('@duckdb/node-api');
    const testResult = {
      moduleLoaded: typeof DuckDBInstance === 'function' && typeof DuckDBInstance.create === 'function',
      connectionTest: false,
      queryTest: false,
      error: null
    };
    
    if (testResult.moduleLoaded) {
      try {
        const instance = await DuckDBInstance.create(':memory:');
        testResult.connectionTest = true;
        
        const conn = await instance.connect();
        
        // Test query
        const reader = await conn.runAndReadAll('SELECT 1 as test');
        const result = reader.getRowObjectsJS();
        if (result && result.length > 0) {
          testResult.queryTest = true;
        }
      } catch (err) {
        testResult.error = err.message;
      }
    }
    
    const status = testResult.moduleLoaded && testResult.connectionTest && testResult.queryTest ? 200 : 503;
    res.status(status).json({
      status: status === 200 ? 'ok' : 'degraded',
      service: 'file',
      duckdb: testResult,
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'file',
      duckdb: { error: err.message },
      timestamp: Date.now()
    });
  }
});

// InfluxDB health check
app.get('/api/health/influxdb', async (req, res) => {
  try {
    const influxHost = config.INFLUX_HOST;
    if (!influxHost || influxHost.trim() === '') {
      return res.status(503).json({
        status: 'unavailable',
        service: 'file',
        influxdb: { 
          available: false,
          error: 'INFLUX_HOST environment variable is not set'
        },
        timestamp: Date.now()
      });
    }

    try {
      await checkInfluxDBHealth(influxHost);
      return res.json({
        status: 'ok',
        service: 'file',
        influxdb: {
          available: true,
          healthy: true
        },
        timestamp: Date.now()
      });
    } catch (err) {
      return res.status(503).json({
        status: 'degraded',
        service: 'file',
        influxdb: {
          available: true,
          healthy: false,
          error: err.message
        },
        timestamp: Date.now()
      });
    }
  } catch (err) {
    return res.status(503).json({
      status: 'error',
      service: 'file',
      influxdb: {
        available: false,
        healthy: false,
        error: err.message
      },
      timestamp: Date.now()
    });
  }
});

// Readiness check (DB connectivity)
app.get('/api/ready', async (req, res) => {
  try {
    const val = await db.getValue('SELECT 1 as value');
    if (val === 1) {
      return res.json({ status: 'ready', service: 'file', db: 'ok', timestamp: Date.now() });
    }
    return res.status(503).json({ status: 'degraded', service: 'file', db: 'fail', timestamp: Date.now() });
  } catch (err) {
    return res.status(503).json({ status: 'unready', service: 'file', db: 'error', message: err?.message });
  }
});

// Create an HTTP server
const server = http.createServer(app);

// 404 handler for unmatched routes (must come after all routes)
// Express automatically waits for async route handlers to complete before
// moving to the next middleware, so this only runs if no route matched
app.use((req, res, next) => {
  // Only handle API routes
  if (req.path.startsWith('/api')) {
    // Check if a route matched (routes set req.routeMatched = true)
    // OR if response was already sent (route handler completed successfully)
    // Only send 404 if we're certain no route matched AND response wasn't sent
    if (!req.routeMatched && !res.headersSent && !res.finished && !res.writableEnded) {
      warn(`[server_file] 404 Handler triggered: ${req.method} ${req.path} (url=${req.url}, originalUrl=${req.originalUrl})`);
      warn(`[server_file] Available routes in fileRoutes:`, fileRoutes.stack
        .filter(r => r.route)
        .map(r => `${Object.keys(r.route.methods).join(',').toUpperCase()} ${r.route.path}`)
        .join(', '));
      res.status(404).json({ success: false, message: 'Route not found', path: req.path });
    }
    // If route matched or response was sent, do nothing (handler already processed request)
  } else {
    // For non-API routes, let Express handle 404 naturally
    next();
  }
});

// Error handling
app.use((err, req, res, next) => {
  error(err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start the HTTP and WebSocket server
// For Docker containers, bind to 0.0.0.0 to accept connections from outside
// Otherwise, use VITE_API_HOST if set, or default to localhost for local development
// Priority: Docker check first, then VITE_API_HOST, then default
const appHost = (process.env.DOCKER_CONTAINER === 'true' || process.env.NODE_ENV === 'production') ? 
  '0.0.0.0' : 
  (config.VITE_API_HOST ? 
    config.VITE_API_HOST.replace(/^https?:\/\//, '').split(':')[0] : 
    '127.0.0.1');

server.listen(config.FILE_PORT, appHost, (err) => {
  if (err) {
    error('Failed to start file server:', err.message);
    process.exit(1);
  }
  const timestamp = new Date().toISOString();
  logAlways(`[${timestamp}] File server running on ${appHost}:${config.FILE_PORT}`);
});

// Catch uncaught exceptions to prevent server crashes
process.on('uncaughtException', (err) => {
  error('[server_file] Uncaught Exception:', err);
  error('[server_file] Stack:', err.stack);
  // Don't exit - let the server continue running, but log the error
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  error('[server_file] Unhandled Rejection at:', promise);
  error('[server_file] Reason:', reason);
  // Don't exit - let the server continue running, but log the error
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  try {
    await db.close();
    console.log('Database connections closed');
  } catch (error) {
    console.error('Error closing database connections:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  try {
    await db.close();
    console.log('Database connections closed');
  } catch (error) {
    console.error('Error closing database connections:', error);
  }
  process.exit(0);
});

