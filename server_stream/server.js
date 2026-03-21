const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const http = require('http');
const { WebSocketServer } = require('ws');
const { csrfProtection } = require('../shared/middleware/csrf');
const { installConsoleGate, logAlways, log, error, warn, debug } = require('../shared');

const config = require('./middleware/config');
const streamRoutes = require('./routes/stream');
const ClientWebSocketServer = require('./controllers/websocket');
const redisStorage = require('./controllers/redis');

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
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
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

// Routes
app.use('/api/stream', streamRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const health = {
    status: 'ok',
    service: 'stream',
    uptime: process.uptime(),
    timestamp: Date.now(),
    websocket: {
      serverInitialized: !!wss,
      clientWSSInitialized: !!clientWSS,
      activeConnections: clientWSS ? clientWSS.getClientCount() : 0,
      jwtSecretConfigured: !!(config.JWT_SECRET || process.env.JWT_SECRET)
    }
  };
  res.json(health);
});

// Readiness check (Redis connectivity will be checked by routes)
app.get('/api/ready', (req, res) => {
  const ready = {
    status: 'ready',
    service: 'stream',
    timestamp: Date.now(),
    websocket: {
      serverInitialized: !!wss,
      clientWSSInitialized: !!clientWSS,
      jwtSecretConfigured: !!(config.JWT_SECRET || process.env.JWT_SECRET)
    }
  };
  res.json(ready);
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  path: '/api/stream/ws'
});

// Store WebSocket server instance for use in controllers
app.locals.wss = wss;
log('[Server] WebSocket server created on path /api/stream/ws');

// Initialize client WebSocket server
const clientWSS = new ClientWebSocketServer(wss);
app.locals.clientWSS = clientWSS;
// Also store globally for access in stream controller
if (typeof global !== 'undefined') {
  global.streamClientWSS = clientWSS;
}

// Verify JWT_SECRET is configured
const jwtSecret = config.JWT_SECRET || process.env.JWT_SECRET;
if (!jwtSecret) {
  error('[Server] WARNING: JWT_SECRET not configured - WebSocket authentication will fail!');
} else {
  log('[Server] JWT_SECRET configured for WebSocket authentication');
}

// Redis connection will be established when streaming starts
// No need to connect on startup if streaming is not active
log('[Server] Redis connection will be established when streaming starts');

// Error handling
app.use((err, req, res, next) => {
  error('Unhandled error:', err?.message);
  res.status(err?.status || 500).json({ success: false, message: err?.message || 'Internal Server Error' });
});

// For Docker containers, bind to 0.0.0.0 to accept connections from outside
const appHost = (process.env.DOCKER_CONTAINER === 'true' || process.env.NODE_ENV === 'production') ? 
  '0.0.0.0' : 
  (config.VITE_API_HOST ? 
    config.VITE_API_HOST.replace(/^https?:\/\//, '').split(':')[0] : 
    '127.0.0.1');

const STREAM_PORT = config.STREAM_PORT || 8099;

server.listen(STREAM_PORT, appHost, (err) => {
  if (err) {
    error('Failed to start stream server:', err.message);
    process.exit(1);
  }
  const timestamp = new Date().toISOString();
  logAlways(`[${timestamp}] Stream server running on ${appHost}:${STREAM_PORT}`);
});

// Graceful shutdown
// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - log and continue
});

process.on('uncaughtException', (err) => {
  error('[Server] Uncaught Exception:', err);
  error('[Server] Stack:', err.stack);
  // Don't exit immediately - log and try to continue
  // The process manager will restart if needed
});

process.on('SIGINT', async () => {
  log('Received SIGINT, shutting down gracefully...');
  try {
    // Cleanup WebSocket server
    if (clientWSS) {
      clientWSS.cleanup();
    }
    // Close WebSocket connections
    wss.clients.forEach(client => {
      client.close();
    });
    wss.close();
    log('WebSocket server closed');
  } catch (err) {
    error('Error closing WebSocket server:', err);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down gracefully...');
  try {
    // Cleanup WebSocket server
    if (clientWSS) {
      clientWSS.cleanup();
    }
    // Close WebSocket connections
    wss.clients.forEach(client => {
      client.close();
    });
    wss.close();
    log('WebSocket server closed');
  } catch (err) {
    error('Error closing WebSocket server:', err);
  }
  process.exit(0);
});

