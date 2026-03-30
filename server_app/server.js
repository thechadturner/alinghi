const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { csrfProtection } = require('../shared/middleware/csrf');
const db = require('../shared/database/connection');
const { installConsoleGate, logAlways, log, error, warn, debug } = require('../shared');

const config = require('./middleware/config');
const { resolveAllowedOrigins } = require('../shared/utils/allowedOrigins');
const adminRoutes = require('./routes/admin');
const authJwtRoutes = require('./routes/auth_jwt');
const userRoutes = require('./routes/users');
const usersPendingRoutes = require('./routes/usersPending');
const classRoutes = require('./routes/classes');
const projectRoutes = require('./routes/projects');
const sourceRoutes = require('./routes/sources');
const datasetRoutes = require('./routes/datasets');
const eventRoutes = require('./routes/events');
const commentRoutes = require('./routes/comments');
const mediaRoutes = require('./routes/media');
const pageRoutes = require('./routes/pages');
const dataRoutes = require('./routes/data');
const targetRoutes = require('./routes/targets');
const emailRoutes = require('./routes/email');

// Install console gate early to wrap all console.* calls
installConsoleGate();

const app = express();

// Middleware
// CORS + CSRF: production uses CORS_ORIGINS only; dev merges localhost (Vite) origins
const allowedOrigins = resolveAllowedOrigins(config.CORS_ORIGINS);

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
// Increased limits for large payloads (e.g., large event lists, overlay data)
app.use(express.json({ 
  limit: '100mb',
  parameterLimit: 50000, // Increase parameter limit for large objects
  strict: false // Allow non-strict JSON parsing
}));
app.use(express.urlencoded({ 
  limit: '100mb', 
  extended: true,
  parameterLimit: 50000
}));
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

// CSRF protection should come after cookie parser and before routes
app.use(csrfProtection(allowedOrigins));

// Routes
app.use('/api/auth', authJwtRoutes); // JWT-based auth endpoints
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/usersPending', usersPendingRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/sources', sourceRoutes);
app.use('/api/datasets', datasetRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/pages', pageRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/targets', targetRoutes);
app.use('/api/email', emailRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'app', uptime: process.uptime(), timestamp: Date.now() });
});

// Readiness check (DB connectivity)
app.get('/api/ready', async (req, res) => {
  try {
    const val = await db.getValue('SELECT 1 as value');
    if (val === 1) {
      return res.json({ status: 'ready', service: 'app', db: 'ok', timestamp: Date.now() });
    }
    return res.status(503).json({ status: 'degraded', service: 'app', db: 'fail', timestamp: Date.now() });
  } catch (err) {
    return res.status(503).json({ status: 'unready', service: 'app', db: 'error', message: err?.message });
  }
});

// Error handler for payload too large (must come before general error handler)
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.status === 413) {
    error('Request entity too large:', {
      message: err.message,
      limit: err.limit,
      length: err.length,
      url: req.url,
      method: req.method
    });
    return res.status(413).json({ 
      success: false, 
      message: `Request payload too large. Maximum size is ${err.limit || '100mb'}.`,
      limit: err.limit,
      length: err.length
    });
  }
  next(err);
});

// Centralized error handler
app.use((err, req, res, next) => {
  error('Unhandled error:', err?.message);
  res.status(err?.status || 500).json({ success: false, message: err?.message || 'Internal Server Error' });
});

// For Docker containers, bind to 0.0.0.0 to accept connections from outside
// Otherwise, use VITE_API_HOST if set, or default to localhost for local development
// Priority: Docker check first, then VITE_API_HOST, then default
const appHost = (process.env.DOCKER_CONTAINER === 'true' || process.env.NODE_ENV === 'production') ? 
  '0.0.0.0' : 
  (config.VITE_API_HOST ? 
    config.VITE_API_HOST.replace(/^https?:\/\//, '').split(':')[0] : 
    '127.0.0.1');

app.listen(config.APP_PORT, appHost, (err) => {
  if (err) {
    error('Failed to start server:', err.message);
    process.exit(1);
  }
  const timestamp = new Date().toISOString();
  logAlways(`[${timestamp}] Application server running on ${appHost}:${config.APP_PORT}`);
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