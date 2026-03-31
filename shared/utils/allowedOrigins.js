/**
 * Resolve allowed CORS / CSRF origins from CORS_ORIGINS and environment.
 * Production: use only the comma-separated list from env (no implicit dev origins).
 * Non-production: merge common localhost / Vite origins so local and Docker dev work.
 */

function parseOriginsList(value) {
  if (value == null || value === '') return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} corsOriginsEnv - Usually config.CORS_ORIGINS (from env merge)
 * @returns {string[]} Origin prefixes; CSRF checks with origin.startsWith(entry)
 */
function resolveAllowedOrigins(corsOriginsEnv) {
  const fromEnv = parseOriginsList(
    corsOriginsEnv !== undefined && corsOriginsEnv !== null && corsOriginsEnv !== ''
      ? corsOriginsEnv
      : process.env.CORS_ORIGINS
  );

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    return fromEnv;
  }

  const devExtras = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost',
    'http://127.0.0.1',
    'https://localhost:3000',
    'https://127.0.0.1:3000',
  ];

  const seen = new Set(fromEnv);
  const merged = [...fromEnv];
  for (const o of devExtras) {
    if (!seen.has(o)) {
      seen.add(o);
      merged.push(o);
    }
  }
  return merged;
}

module.exports = {
  resolveAllowedOrigins,
};
