const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { csrfProtection } = require('../shared/middleware/csrf');
const db = require('../shared/database/connection');
const { installConsoleGate, logAlways, log, error, warn, debug } = require('../shared');

const config = require('./middleware/config');
const { resolveAllowedOrigins } = require('../shared/utils/allowedOrigins');
const { getReadinessReport } = require('../shared/utils/readiness');
const loggingRoutes = require('./routes/logging');
const { validatePAT } = require('./middleware/pat');
const projectRoutes = require('./routes/projects');
const datasetRoutes = require('./routes/datasets');
const eventRoutes = require('./routes/events');
const targetRoutes = require('./routes/targets');
const mediaRoutes = require('./routes/media');
const tokenRoutes = require('./routes/tokens');
const uploadRoutes = require('./routes/uploads');
const classesRoutes = require('./routes/classes');
const adminRoutes = require('./routes/admin');

installConsoleGate();

const app = express();
const server = http.createServer(app);

app.locals.progressBuffer = [];
const MAX_PROGRESS_BUFFER = 200;

const sseClients = new Set();
const sseConnectionTimestamps = new Map(); // Track connection timestamps
const sseLastActivity = new Map(); // Track last activity
const SSE_CONNECTION_TIMEOUT = 3600000; // 1 hour in milliseconds
const SSE_HEARTBEAT_TIMEOUT = 300000; // 5 minutes in milliseconds
const SSE_CLEANUP_INTERVAL = 60000; // 1 minute in milliseconds
const port = config.ADMIN_PORT || 8059;

// Periodic cleanup of stale SSE connections
const sseCleanupInterval = setInterval(() => {
  const now = Date.now();
  const staleClients = [];
  
  for (const [res, timestamp] of sseConnectionTimestamps.entries()) {
    const connectionAge = now - timestamp;
    const lastActivity = sseLastActivity.get(res) || timestamp;
    const timeSinceActivity = now - lastActivity;
    
    // Mark as stale if:
    // 1. No activity for heartbeat timeout (5 minutes)
    // 2. Connection age exceeds connection timeout (1 hour)
    if (timeSinceActivity > SSE_HEARTBEAT_TIMEOUT || connectionAge > SSE_CONNECTION_TIMEOUT) {
      staleClients.push(res);
    }
  }
  
  // Clean up stale connections
  for (const res of staleClients) {
    try {
      sseClients.delete(res);
      sseConnectionTimestamps.delete(res);
      sseLastActivity.delete(res);
      res.end(); // Close the connection
      log('[SSE] Cleaned up stale connection');
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
  
  if (staleClients.length > 0) {
    log(`[SSE] Cleaned up ${staleClients.length} stale connection(s). Active: ${sseClients.size}`);
  }
}, SSE_CLEANUP_INTERVAL);

app.locals.broadcastProgress = (message) => {
  if (process.env.VITE_VERBOSE === 'true') {
    try { log('[PROGRESS][EMIT]', message?.event?.event || 'unknown', message?.event?.text || '', message?.event?.text || ''); } catch {}
  }
  
  // Handle both new unified format and legacy format
  let payload;
  if (message.success && message.event) {
    // New unified format - send as-is
    payload = JSON.stringify(message);
  } else {
    // Legacy format - wrap in new format for backward compatibility
    payload = JSON.stringify({ type: 'upload_progress', ...message });
  }

  try {
    app.locals.progressBuffer.push({ ts: Date.now(), ...message });
    if (app.locals.progressBuffer.length > MAX_PROGRESS_BUFFER) {
      app.locals.progressBuffer.splice(0, app.locals.progressBuffer.length - MAX_PROGRESS_BUFFER);
    }
  } catch {}
  // SSE broadcast
  const now = Date.now();
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
      // Update activity when message is sent
      sseLastActivity.set(res, now);
    } catch (e) {
      // If write fails, connection is likely dead - remove it
      sseClients.delete(res);
      sseConnectionTimestamps.delete(res);
      sseLastActivity.delete(res);
    }
  }
};

// Progress endpoints (always available, even if WS fails)
app.get('/api/events/upload-progress', (req, res) => {
  // Check for authentication via query parameter (for EventSource compatibility)
  const token = req.query.token;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
      req.user = decoded; // Set user for consistency
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
  }
  
  const origin = req.headers.origin || '*';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Allow cross-origin EventSource (no credentials)
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.flushHeaders?.();
  try { log('[SSE] client connected'); } catch {}
  // Add to sseClients and track connection
  const now = Date.now();
  sseClients.add(res);
  sseConnectionTimestamps.set(res, now);
  sseLastActivity.set(res, now);
  
  // Update activity on keepalive (every 30 seconds)
  const heartbeatInterval = setInterval(() => {
    if (sseClients.has(res)) {
      sseLastActivity.set(res, Date.now());
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000);
  
  req.on('close', () => {
    sseClients.delete(res);
    sseConnectionTimestamps.delete(res);
    sseLastActivity.delete(res);
    clearInterval(heartbeatInterval);
    try { log('[SSE] client disconnected'); } catch {}
  });
});

// Alias for SSE when client uses /api/admin prefix (e.g. proxy forwards full path)
app.get('/api/admin/events/upload-progress', (req, res) => {
  const token = req.query.token;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
      req.user = decoded;
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
  }
  const origin = req.headers.origin || '*';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.flushHeaders?.();
  try { log('[SSE] client connected (admin path)'); } catch {}
  const now = Date.now();
  sseClients.add(res);
  sseConnectionTimestamps.set(res, now);
  sseLastActivity.set(res, now);
  const heartbeatInterval = setInterval(() => {
    if (sseClients.has(res)) {
      sseLastActivity.set(res, Date.now());
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000);
  req.on('close', () => {
    sseClients.delete(res);
    sseConnectionTimestamps.delete(res);
    sseLastActivity.delete(res);
    clearInterval(heartbeatInterval);
    try { log('[SSE] client disconnected'); } catch {}
  });
});

// SSE Statistics endpoint for monitoring
app.get('/api/sse/stats', (req, res) => {
  // Check authentication
  const token = req.query.token || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const now = Date.now();
  const connectionAges = [];
  
  for (const [res, timestamp] of sseConnectionTimestamps.entries()) {
    connectionAges.push(now - timestamp);
  }
  
  const stats = {
    active_connections: sseClients.size,
    oldest_connection_age: connectionAges.length > 0 ? Math.max(...connectionAges) / 1000 : 0,
    newest_connection_age: connectionAges.length > 0 ? Math.min(...connectionAges) / 1000 : 0,
    average_connection_age: connectionAges.length > 0 ? (connectionAges.reduce((a, b) => a + b, 0) / connectionAges.length) / 1000 : 0,
    total_tracked_connections: sseConnectionTimestamps.size,
    connection_timeout: SSE_CONNECTION_TIMEOUT / 1000,
    heartbeat_timeout: SSE_HEARTBEAT_TIMEOUT / 1000
  };
  
  log(`[SSE] Stats requested: ${JSON.stringify(stats)}`);
  res.json({ success: true, message: 'SSE statistics', data: stats });
});

// HTTP polling fallback endpoint (client may request via /api/admin prefix depending on proxy)
function progressPollHandler(req, res) {
  try {
    const since = parseInt(req.query.since || '0', 10) || 0;
    const items = (app.locals.progressBuffer || []).filter(m => m.ts > since);
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    return res.json({ success: true, data: { items, now: Date.now() } });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || 'error' });
  }
}
app.get('/api/upload/progress', progressPollHandler);
app.get('/api/admin/api/upload/progress', progressPollHandler);

// Middleware — CSRF uses this list; dev merges localhost (Vite) even when CORS uses origin: true
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
          "connect-src": ["'self'", ...allowedOrigins, "http:", "https:"],
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
// Add middleware to log incoming request sizes BEFORE body parsing
// This must come before express.json() to catch connection issues
app.use((req, res, next) => {
  if (req.path === '/api/events/object' && req.method === 'POST') {
    const contentLength = req.get('content-length');
    if (contentLength) {
      const sizeMB = parseInt(contentLength) / 1024 / 1024;
      log(`[REQUEST] POST /api/events/object - Content-Length: ${sizeMB.toFixed(2)}MB`);
    }
    // Track body reception
    let bodySize = 0;
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize === chunk.length) {
        log(`[REQUEST] Starting to receive body for /api/events/object`);
      }
    });
    req.on('end', () => {
      if (bodySize > 0) {
        log(`[REQUEST] Finished receiving body: ${(bodySize / 1024 / 1024).toFixed(2)}MB`);
      }
    });
    req.on('error', (err) => {
      log(`[REQUEST] Error receiving body: ${err.message}`);
    });
    req.on('close', () => {
      log(`[REQUEST] Connection closed before body complete. Received: ${(bodySize / 1024 / 1024).toFixed(2)}MB`);
    });
  }
  next();
});

// Increased limits for large payloads from Python scripts
// Python scripts often send large JSON arrays (thousands of records)
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

// CORS configuration (allow any origin in development to simplify WS/SSE)
if (process.env.NODE_ENV === 'production') {
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
} else {
  app.use(
    cors({
      origin: true, // reflect request origin
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
      exposedHeaders: ['X-CSRF-Token'],
      optionsSuccessStatus: 204,
    })
  );
}

app.use(validatePAT);

// CSRF protection
app.use(csrfProtection(allowedOrigins));

// Routes
app.use('/api/log', loggingRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/datasets', datasetRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/targets', targetRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/admin/media', mediaRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/classes', classesRoutes);
app.use('/api', adminRoutes);

// Debug echo endpoint (only when VITE_VERBOSE is enabled)
function isVerboseEnabled() {
  const val = (process.env.VITE_VERBOSE || '').toString().toLowerCase();
  return val === 'true' || val === '1' || val === 'yes';
}
if (isVerboseEnabled()) {
  // Safe echo - no CSRF required, useful to inspect headers/cookies
  app.get('/debug/echo', (req, res) => {
    try {
      const jwt = require('jsonwebtoken');
      const authHeader = req.headers.authorization || '';
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
      const decoded = token ? (jwt.decode(token) || {}) : {};
      log('[AUTH][DEBUG][ECHO][GET] hit');
      return res.json({ ok: true, method: 'GET', headers: { hasAuth: !!authHeader, csrf: req.headers['x-csrf-token'] }, cookies: req.cookies || {}, decoded });
    } catch (e) {
      error('[AUTH][DEBUG][ECHO][GET] Error:', e?.message);
      return res.status(500).json({ ok: false, error: e?.message });
    }
  });

  // POST echo - mirrors what /api/log/* expects (auth + CSRF)
  app.post('/debug/echo', (req, res) => {
    try {
      const jwt = require('jsonwebtoken');
      const authHeader = req.headers.authorization || '';
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
      const decoded = token ? (jwt.decode(token) || {}) : {};
      log('[AUTH][DEBUG][ECHO][POST] hit, hasAuth:', !!authHeader, 'csrf:', req.headers['x-csrf-token']);
      log('[AUTH][DEBUG][ECHO][POST] Cookies:', req.cookies);
      log('[AUTH][DEBUG][ECHO][POST] Decoded claims:', {
        iss: decoded?.iss,
        aud: decoded?.aud,
        sub: decoded?.sub || decoded?.user_id,
        type: decoded?.type,
        exp: decoded?.exp
      });
      return res.json({ ok: true, method: 'POST', headers: { hasAuth: !!authHeader, csrf: req.headers['x-csrf-token'] }, cookies: req.cookies || {}, decoded });
    } catch (e) {
      error('[AUTH][DEBUG][ECHO][POST] Error:', e?.message);
      return res.status(500).json({ ok: false, error: e?.message });
    }
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'admin', uptime: process.uptime(), timestamp: Date.now() });
});

// Readiness: Postgres + data/media bind mounts (when paths are configured)
app.get('/api/ready', async (req, res) => {
  try {
    const report = await getReadinessReport(db, config);
    const payload = {
      status: report.ok ? 'ready' : 'unready',
      service: 'admin',
      timestamp: Date.now(),
      postgres: report.postgres,
      data: report.data,
      media: report.media
    };
    if (report.ok) {
      return res.json(payload);
    }
    return res.status(503).json(payload);
  } catch (err) {
    return res.status(503).json({
      status: 'unready',
      service: 'admin',
      postgres: { ok: false, detail: 'error', message: err?.message },
      timestamp: Date.now()
    });
  }
});

// Centralized error handler
app.use((err, req, res, next) => {
  error('Unhandled error:', err?.message);
  res.status(err?.status || 500).json({ success: false, message: err?.message || 'Internal Server Error' });
});

// For Docker containers, ALWAYS bind to 0.0.0.0 to accept connections from outside
// VITE_API_HOST is the external/public hostname, not the bind address
// Inside Docker, we must bind to 0.0.0.0 to accept connections from NGINX
const appHost = (process.env.DOCKER_CONTAINER === 'true' || process.env.NODE_ENV === 'production') ? 
  '0.0.0.0' : 
  (config.VITE_API_HOST ? config.VITE_API_HOST.replace(/^https?:\/\//, '').split(':')[0] : '127.0.0.1');

// Configure server for large payloads
server.keepAliveTimeout = 300000; // 5 minutes - keep connections alive for large uploads
server.headersTimeout = 310000; // Slightly longer than keepAliveTimeout
server.maxHeadersCount = 2000; // Allow more headers if needed

server.listen(port, appHost, (err) => {
  if (err) {
    error('Failed to start admin server:', err.message);
    process.exit(1);
  }
  const timestamp = new Date().toISOString();
  logAlways(`[${timestamp}] Admin server running on ${appHost}:${port}`);
  if (isVerboseEnabled()) {
    log('[AUTH][DEBUG] VITE_VERBOSE enabled');
    log('[AUTH][DEBUG] Allowed CORS origins:', allowedOrigins);
    log('[AUTH][DEBUG] JWT settings:', {
      issuer: process.env.JWT_ISSUER || 'teamshare-auth',
      audience: process.env.JWT_AUDIENCE || 'teamshare-servers'
    });
  }
});

// Graceful shutdown
// Cleanup SSE connections on shutdown
const cleanupSSE = () => {
  clearInterval(sseCleanupInterval);
  for (const res of sseClients) {
    try {
      res.end();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
  sseClients.clear();
  sseConnectionTimestamps.clear();
  sseLastActivity.clear();
  log('[SSE] All connections cleaned up on shutdown');
};

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  cleanupSSE();
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
  cleanupSSE();
  try {
    await db.close();
    console.log('Database connections closed');
  } catch (error) {
    console.error('Error closing database connections:', error);
  }
  process.exit(0);
});