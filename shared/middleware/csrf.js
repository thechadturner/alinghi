const crypto = require('crypto');
const { logMessage } = require('../utils/logging');

// Configuration
const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Rate limit for CSRF failures (probes/crawlers): max failures per IP per window. Set to 0 to disable.
const CSRF_FAILURE_RATE_LIMIT = parseInt(process.env.CSRF_FAILURE_RATE_LIMIT || '20', 10);
const CSRF_FAILURE_WINDOW_MS = parseInt(process.env.CSRF_FAILURE_WINDOW_MS || '900000', 10); // 15 min

// IP blocking configuration: block IPs that exceed rate limit for this duration
const CSRF_BLOCK_DURATION_MS = parseInt(process.env.CSRF_BLOCK_DURATION_MS || '3600000', 10); // 1 hour default
const CSRF_BLOCK_ENABLED = process.env.CSRF_BLOCK_ENABLED !== 'false'; // Enabled by default

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getOrigin(req) {
  return req.headers.origin || req.headers.referer || '';
}

function getClientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '0.0.0.0';
}

function sameSiteOption(env) {
  // Default Lax for same-site navigation protection; None required only for cross-site iframes
  return env === 'production' ? 'Lax' : 'Lax';
}

function isSecure(env) {
  return env === 'production';
}

function setCsrfCookie(res, token, env) {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // must be readable by client for double-submit
    sameSite: sameSiteOption(process.env.NODE_ENV || env || 'development'),
    secure: isSecure(process.env.NODE_ENV || env || 'development'),
    path: '/',
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
  });
}

/**
 * Record a CSRF failure for an IP and return true if this IP is over the rate limit.
 * Prunes stale entries. Only counts when CSRF_FAILURE_RATE_LIMIT > 0.
 */
function recordCsrfFailureAndCheckLimit(attempts, clientIp) {
  if (CSRF_FAILURE_RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const windowStart = now - CSRF_FAILURE_WINDOW_MS;
  for (const [ip, data] of attempts.entries()) {
    if (data.timestamp < windowStart) attempts.delete(ip);
  }
  const data = attempts.get(clientIp);
  if (!data) {
    attempts.set(clientIp, { count: 1, timestamp: now });
    return false;
  }
  data.count++;
  return data.count > CSRF_FAILURE_RATE_LIMIT;
}

/**
 * Check if an IP is currently blocked and prune expired blocks.
 * Returns true if the IP is blocked, false otherwise.
 */
function isIpBlocked(blockedIps, clientIp) {
  if (!CSRF_BLOCK_ENABLED) return false;
  const now = Date.now();
  
  // Prune expired blocks
  for (const [ip, blockedUntil] of blockedIps.entries()) {
    if (blockedUntil < now) {
      blockedIps.delete(ip);
    }
  }
  
  const blockedUntil = blockedIps.get(clientIp);
  if (blockedUntil && blockedUntil >= now) {
    return true;
  }
  return false;
}

/**
 * Block an IP address for the configured duration.
 */
function blockIp(blockedIps, clientIp) {
  if (!CSRF_BLOCK_ENABLED) return;
  const now = Date.now();
  blockedIps.set(clientIp, now + CSRF_BLOCK_DURATION_MS);
}

/**
 * CSRF middleware implementing double-submit cookie and basic origin checks.
 * - Issues a `csrf_token` cookie on first request if missing
 * - For unsafe methods, requires header `X-CSRF-Token` to match cookie value
 * - Optionally enforces simple Origin/Referer check when available
 * - Logs client IP on failure; rate-limits repeated failures per IP
 * - Blocks IPs that exceed rate limit for a configurable duration (default 1 hour)
 * - Returns empty body (no JSON) on rejection to minimize server work and give no feedback to bots
 */
function csrfProtection(allowedOrigins = []) {
  const csrfFailureAttempts = new Map();
  const blockedIps = new Map();

  return function csrfMiddleware(req, res, next) {
    try {
      const clientIp = getClientIp(req);
      
      // Check if IP is blocked first (before any other processing)
      if (isIpBlocked(blockedIps, clientIp)) {
        logMessage(clientIp, '0', 'shared/middleware/csrf.js', 'warning', 'csrfProtection', `Blocked IP attempting request: ${clientIp} (path: ${req.path || req.url})`);
        return res.status(403).end();
      }

      // Always ensure a csrf cookie exists
      let csrfCookie = req.cookies?.[CSRF_COOKIE_NAME];
      if (!csrfCookie) {
        csrfCookie = generateToken();
        setCsrfCookie(res, csrfCookie);
      }

      // Skip checks for safe methods
      if (SAFE_METHODS.has(req.method)) {
        return next();
      }

      // Allow JWT-authenticated API calls to bypass CSRF double-submit.
      // Cross-origin clients cannot read same-site cookies to echo them in headers.
      // If a valid Authorization header is present, rely on JWT auth instead of CSRF.
      const authHeader = req.headers.authorization;
      if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return next();
      }

      const origin = getOrigin(req);

      // Basic Origin/Referer check when header exists
      if (origin && allowedOrigins.length > 0) {
        const isAllowed = allowedOrigins.some((o) => origin.startsWith(o));
        if (!isAllowed) {
          const detail = {
            method: req.method,
            path: req.path || req.url,
            origin,
            clientIp,
            userAgent: req.headers['user-agent'] || '(none)',
            referer: req.headers['referer'] || '(none)',
            xForwardedFor: req.headers['x-forwarded-for'] || '(none)'
          };
          logMessage(clientIp, '0', 'shared/middleware/csrf.js', 'warning', 'csrfProtection', `Blocked by origin check: ${JSON.stringify(detail)}`);
          const overLimit = recordCsrfFailureAndCheckLimit(csrfFailureAttempts, clientIp);
          if (overLimit) {
            blockIp(blockedIps, clientIp);
            logMessage(clientIp, '0', 'shared/middleware/csrf.js', 'error', 'csrfProtection', `Rate limit exceeded for CSRF/origin failures - IP blocked: ${clientIp}. Request details: ${JSON.stringify(detail)}`);
            return res.status(403).end();
          }
          return res.status(403).end();
        }
      }

      // Double-submit header vs cookie
      const headerToken = req.headers[CSRF_HEADER_NAME.toLowerCase()];
      if (!headerToken || headerToken !== csrfCookie) {
        const detail = { 
          method: req.method, 
          path: req.path || req.url, 
          origin: origin || '(none)', 
          clientIp,
          userAgent: req.headers['user-agent'] || '(none)',
          referer: req.headers['referer'] || '(none)',
          xForwardedFor: req.headers['x-forwarded-for'] || '(none)'
        };
        logMessage(clientIp, '0', 'shared/middleware/csrf.js', 'warning', 'csrfProtection', `Missing or invalid CSRF token: ${JSON.stringify(detail)}`);
        const overLimit = recordCsrfFailureAndCheckLimit(csrfFailureAttempts, clientIp);
        if (overLimit) {
          blockIp(blockedIps, clientIp);
          logMessage(clientIp, '0', 'shared/middleware/csrf.js', 'error', 'csrfProtection', `Rate limit exceeded for CSRF failures - IP blocked: ${clientIp}. Request details: ${JSON.stringify(detail)}`);
          return res.status(403).end();
        }
        return res.status(403).end();
      }

      return next();
    } catch (err) {
      const clientIp = getClientIp(req);
      logMessage(clientIp, '0', 'shared/middleware/csrf.js', 'error', 'csrfProtection', err?.message || 'CSRF error');
      return res.status(403).end();
    }
  };
}

module.exports = {
  csrfProtection,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
};


