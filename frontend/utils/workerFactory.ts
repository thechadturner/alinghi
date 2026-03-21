/**
 * Safari-compatible Worker Factory
 * 
 * Handles Safari-specific issues with ES module workers
 * 
 * Safari has known issues with:
 * - new URL() with import.meta.url for module workers
 * - Module workers in general (especially older versions)
 * - Worker URL resolution
 * 
 * This utility provides fallbacks and Safari-specific handling
 */

import { log, error as logError, warn } from './console';

/**
 * Detect if running in Safari
 */
function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // Check for Safari but exclude Chrome (which also contains Safari in UA)
  return /^((?!chrome|android).)*safari/i.test(ua) || 
         (ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium'));
}

/**
 * Get Safari version if available
 */
function getSafariVersion(): number | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  const match = ua.match(/Version\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if running in production mode
 */
function isProduction(): boolean {
  // Check for common production indicators
  return (
    typeof __PROD__ !== 'undefined' && __PROD__ === true ||
    import.meta.env.PROD === true ||
    import.meta.env.MODE === 'production'
  );
}

/**
 * Resolve worker path for production
 * In production, worker paths may need adjustment since they're bundled
 */
function resolveWorkerPath(workerPath: string | URL): string {
  const isProd = isProduction();
  
  // If it's already a URL object, use its href
  if (workerPath instanceof URL) {
    return workerPath.href;
  }
  
  // If it's a string URL (starts with http/https), use as-is
  if (typeof workerPath === 'string' && (workerPath.startsWith('http://') || workerPath.startsWith('https://'))) {
    return workerPath;
  }
  
  // If it's an absolute path (starts with /), use as-is
  if (typeof workerPath === 'string' && workerPath.startsWith('/')) {
    return workerPath;
  }
  
  // In production, if path doesn't start with /, it's likely a bundled path
  // Try to resolve it relative to the base URL
  if (isProd && typeof workerPath === 'string') {
    // Check if this looks like a Vite-generated path (contains hash)
    if (workerPath.includes('-') && /[a-f0-9]{8}/.test(workerPath)) {
      // Already a hashed production path, prepend / if needed
      return workerPath.startsWith('/') ? workerPath : `/${workerPath}`;
    }
    
    // Otherwise try to resolve relative to assets/js/
    // This matches the worker output configuration in vite.config.mjs
    log(`Production worker path resolution: ${workerPath}`);
    // For now, just ensure it starts with /
    return workerPath.startsWith('/') ? workerPath : `/${workerPath}`;
  }
  
  // Development or unrecognized format - use as-is
  return workerPath;
}

/**
 * Create a worker with Safari compatibility
 * 
 * Safari has issues with:
 * - new URL() with import.meta.url for module workers
 * - Module workers in general (especially older versions)
 * 
 * This function provides fallbacks for Safari compatibility and production path resolution
 */
export function createWorker(
  workerPath: string | URL,
  options: { type?: 'module' | 'classic' } = {}
): Worker | null {
  if (typeof Worker === 'undefined') {
    warn('Web Workers not supported in this environment');
    return null;
  }

  const isSafariBrowser = isSafari();
  const safariVersion = getSafariVersion();
  
  // Safari 15+ supports module workers, but with limitations
  // For older Safari versions, prefer classic workers
  const preferClassic = isSafariBrowser && (safariVersion === null || safariVersion < 15);
  const useModule = options.type === 'module' && !preferClassic;

  // Resolve worker path (especially important in production)
  let workerUrl: string;
  try {
    workerUrl = resolveWorkerPath(workerPath);
    log(`Creating worker with resolved path: ${workerUrl}`);
  } catch (resolveError: any) {
    logError('Failed to resolve worker path:', resolveError);
    // Fallback: use original path
    workerUrl = workerPath instanceof URL ? workerPath.href : workerPath;
  }

  try {
    // Method 1: Try with the resolved URL/path and preferred type
    try {
      if (preferClassic) {
        // Safari < 15: try classic worker first
        const worker = new Worker(workerUrl, { type: 'classic' });
        log('Created classic worker for Safari compatibility');
        return worker;
      } else {
        // Modern browsers and Safari 15+: try module worker
        const worker = new Worker(workerUrl, { type: useModule ? 'module' : 'classic' });
        if (useModule) {
          log('Created module worker');
        } else {
          log('Created classic worker');
        }
        return worker;
      }
    } catch (primaryError: any) {
      logError('Primary worker creation failed:', primaryError?.message || String(primaryError));
      
      // Method 2: For Safari, try alternative URL formats
      if (isSafariBrowser) {
        try {
          // Try with absolute path if not already absolute
          if (!workerUrl.startsWith('http') && !workerUrl.startsWith('/')) {
            const absolutePath = `/${workerUrl}`;
            try {
              const worker = new Worker(absolutePath, { type: 'classic' });
              log('Created worker with absolute path for Safari');
              return worker;
            } catch (absoluteError) {
              logError('Absolute path worker creation failed:', absoluteError);
            }
          }
          
          // Try classic worker as fallback
          if (useModule) {
            try {
              const worker = new Worker(workerUrl, { type: 'classic' });
              log('Created classic worker as fallback for Safari');
              return worker;
            } catch (classicError) {
              logError('Classic worker fallback failed:', classicError);
            }
          }
        } catch (safariFallbackError: any) {
          logError('Safari fallback worker creation failed:', safariFallbackError);
        }
      }
      
      // Method 3: Try the opposite type as last resort
      try {
        const fallbackType = useModule ? 'classic' : 'module';
        const worker = new Worker(workerUrl, { type: fallbackType });
        log(`Created ${fallbackType} worker as last resort fallback`);
        return worker;
      } catch (fallbackError: any) {
        logError('All worker creation methods failed:', fallbackError);
        throw fallbackError;
      }
    }
  } catch (error: any) {
    logError(`Failed to create worker:`, {
      path: workerUrl,
      originalPath: workerPath instanceof URL ? workerPath.href : workerPath,
      error: error?.message || String(error),
      stack: error?.stack,
      isSafari: isSafariBrowser,
      safariVersion: safariVersion,
      isProduction: isProduction()
    });
    return null;
  }
}

/**
 * Create a module worker (with Safari fallback)
 */
export function createModuleWorker(workerPath: string | URL): Worker | null {
  return createWorker(workerPath, { type: 'module' });
}

/**
 * Create a classic worker (for Safari compatibility)
 */
export function createClassicWorker(workerPath: string | URL): Worker | null {
  return createWorker(workerPath, { type: 'classic' });
}

/**
 * Check if workers are supported in the current environment
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Check if module workers are supported
 * Safari 15+ supports module workers, but with limitations
 */
export function isModuleWorkerSupported(): boolean {
  if (!isWorkerSupported()) return false;
  
  const isSafariBrowser = isSafari();
  const safariVersion = getSafariVersion();
  
  // Safari 15+ supports module workers
  if (isSafariBrowser) {
    return safariVersion !== null && safariVersion >= 15;
  }
  
  // Other modern browsers support module workers
  return true;
}

