const crypto = require('crypto');
const db = require('../../server_app/middleware/db');

function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Validate Personal/Service API Token (PAT) from Authorization: Bearer <token>
 * - Looks up token by SHA-256 hash in admin.personal_api_tokens
 * - Verifies not revoked and not expired
 * - Optionally checks IP allowlist
 * - Attaches req.user and req.pat with scopes and restrictions
 */
async function validatePAT(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return next(); // no bearer token; skip

    const rawToken = header.split(' ')[1];
    if (!rawToken) return next();

    // Check for SYSTEM_KEY (system token for internal server communication)
    // This allows Python scripts to authenticate using SYSTEM_KEY
    const SYSTEM_KEY = process.env.SYSTEM_KEY;
    if (SYSTEM_KEY && rawToken === SYSTEM_KEY) {
      // SYSTEM_KEY is valid - attach system user context
      req.user = req.user || {};
      req.user.user_id = req.user.user_id || 'system';
      req.user.username = 'system';
      req.user.email = 'system@internal';
      req.user.role = 'system';
      req.pat = {
        token_id: 'system',
        scopes: ['read', 'write', 'admin'],
        project_ids: []
      };
      return next();
    }

    // If it's a JWT (three sections), let JWT middleware handle it
    if (rawToken.split('.').length === 3) {
      return next();
    }

    // Non-JWT bearer tokens are treated as Personal API Tokens
    const tokenHash = sha256(rawToken);

    const sql = `
      SELECT token_id, user_id, scopes, ip_allowlist, project_ids, expires_at, revoked_at
      FROM admin.personal_api_tokens
      WHERE token_hash = $1
      LIMIT 1`;
    const rows = await db.GetRows(sql, [tokenHash]);
    const token = rows && rows[0];
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    if (token.revoked_at) return res.status(401).json({ success: false, message: 'Token revoked' });
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(401).json({ success: false, message: 'Token expired' });
    }

    // IP allowlist check
    if (Array.isArray(token.ip_allowlist) && token.ip_allowlist.length > 0) {
      const reqIp = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
      // Basic check: ensure client IP string is contained in any CIDR (simplified: exact match)
      // For full CIDR matching, integrate a CIDR library later
      const ipStr = Array.isArray(reqIp) ? reqIp[0] : String(reqIp);
      const simpleAllowed = token.ip_allowlist.some(cidr => ipStr.startsWith(String(cidr).split('/')[0]));
      if (!simpleAllowed) return res.status(403).json({ success: false, message: 'IP not allowed' });
    }

    // Attach user context (merge with any existing user)
    req.user = req.user || {};
    req.user.user_id = req.user.user_id || token.user_id;
    req.pat = {
      token_id: token.token_id,
      scopes: token.scopes || [],
      project_ids: token.project_ids || []
    };

    // Update last_used_at (non-blocking)
    db.ExecuteCommand(
      'UPDATE admin.personal_api_tokens SET last_used_at = now() WHERE token_id = $1',
      [token.token_id]
    ).catch(() => {});

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Token validation error' });
  }
}

function requirePatScopes(requiredScopes) {
  return (req, res, next) => {
    const scopes = req.pat?.scopes || [];
    const ok = requiredScopes.every(s => scopes.includes(s));
    if (!ok) return res.status(403).json({ success: false, message: 'Insufficient token scopes' });
    next();
  };
}

function requirePatScopesIfPat(requiredAny) {
  return (req, res, next) => {
    if (!req.pat) return next();
    const scopes = req.pat?.scopes || [];
    const ok = requiredAny.some(s => scopes.includes(s));
    if (!ok) return res.status(403).json({ success: false, message: 'Insufficient token scopes' });
    next();
  };
}

module.exports = { validatePAT, requirePatScopes, requirePatScopesIfPat, sha256 };


