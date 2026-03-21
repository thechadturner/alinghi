import { render } from 'solid-js/web';
import { getData } from "./utils/global";
import { authManager } from "./utils/authManager";
import { setIsLoggedIn, setUser, setSubscription } from "./store/userStore"; // Import global state
import { clearSelectionOnStartup, initializeSelectionStore } from "./store/selectionStore"; // Import selection store functions
import { setIsPlaying } from "./store/playbackStore"; // Import playback store functions
import { debug, warn, log } from "./utils/console";
import { isMobileDevice } from "./utils/deviceDetection";

debug('[App Init] index.tsx module loading started');

// Initialize fetch interceptor early to ensure CSRF tokens are included
import "./utils/fetchInterceptor";

// Initialize Mapbox token early to prevent frozen object issues
import "./utils/mapboxInit";
// Load Mapbox GL CSS in app entry so it is present before any code-split chunk creates a map
// (avoids "missing CSS declarations" warning when map loads in split window / lazy routes)
import "./styles/thirdparty/mapbox-gl.css";

import App from './App';

import "./styles/Styles.css";

// TEMPORARILY DISABLED: Install console gate early so all console output respects VITE_VERBOSE
// Re-enabled to debug production issues
// import { installConsoleGate } from './utils/console';
// installConsoleGate();

// Global error handler to filter out BroadcastChannel errors from @solidjs/sync
// These errors are expected and harmless when the BroadcastChannel is closed
// (e.g., during page unload, tab switching, or in certain browser states)
if (typeof window !== 'undefined') {
  const originalError = window.console.error;
  const originalWarn = window.console.warn;
  
  window.console.error = function(...args: any[]) {
    // Filter out BroadcastChannel errors from sync library
    // Check all arguments for the error pattern
    const errorText = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg?.message) return arg.message;
      if (arg?.toString) return arg.toString();
      return '';
    }).join(' ');
    
    // Filter out expected/harmless errors
    if (errorText.includes('Sync error') && 
        (errorText.includes('BroadcastChannel') || errorText.includes('Channel is closed') || errorText.includes('InvalidStateError'))) {
      // Silently ignore these expected errors from @solidjs/sync
      return;
    }
    
    // Filter out ResizeObserver warnings (benign browser warning when callbacks trigger layout changes)
    if (errorText.includes('ResizeObserver loop completed with undelivered notifications') ||
        errorText.includes('ResizeObserver loop limit exceeded')) {
      // Silently ignore ResizeObserver warnings - these are harmless browser notifications
      return;
    }
    
    // Filter out AbortErrors - they're expected when requests are cancelled
    // Check if any argument is an AbortError or contains "request aborted" message
    const isAbortError = args.some(arg => {
      if (arg instanceof Error) {
        return arg.name === 'AbortError' || 
               arg.message?.toLowerCase().includes('request aborted') ||
               arg.message?.toLowerCase().includes('aborted');
      }
      if (arg && typeof arg === 'object') {
        return arg.name === 'AbortError' || 
               (arg as any).type === 'AbortError' ||
               (arg.message && typeof arg.message === 'string' && 
                (arg.message.toLowerCase().includes('request aborted') || 
                 arg.message.toLowerCase().includes('aborted')));
      }
      return false;
    });
    
    if (isAbortError || errorText.toLowerCase().includes('request aborted') || 
        errorText.toLowerCase().includes('aborted')) {
      // Silently ignore AbortErrors - they're expected when requests are cancelled
      return;
    }
    
    // Call original error handler for all other errors
    originalError.apply(window.console, args);
  };
  
  // Suppress SQLite OPFS warnings (expected when COOP/COEP headers are not set)
  window.console.warn = function(...args: any[]) {
    const warnText = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg?.message) return arg.message;
      if (arg?.toString) return arg.toString();
      return '';
    }).join(' ');
    
    // Filter out SQLite OPFS warnings
    if (warnText.includes('OPFS') || 
        warnText.includes('sqlite3_vfs') || 
        warnText.includes('SharedArrayBuffer') || 
        warnText.includes('Atomics') ||
        warnText.includes('COOP/COEP')) {
      // Silently ignore SQLite OPFS warnings
      return;
    }
    // Call original warn handler for all other warnings
    originalWarn.apply(window.console, args);
  };
  
  // Also suppress SQLite OPFS log messages
  const originalLog = window.console.log;
  window.console.log = function(...args: any[]) {
    const logText = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg?.message) return arg.message;
      if (arg?.toString) return arg.toString();
      return '';
    }).join(' ');
    
    // Filter out SQLite OPFS log messages
    if (logText.includes('Ignoring inability to install OPFS') || 
        logText.includes('sqlite3_vfs') || 
        logText.includes('OPFS async proxy worker')) {
      // Silently ignore SQLite OPFS log messages
      return;
    }
    // Call original log handler for all other logs
    originalLog.apply(window.console, args);
  };
}

// Check and perform IndexedDB migration if needed
// Don't block app initialization - run migration in background
import { checkAndMigrate } from './utils/indexedDBMigration';
checkAndMigrate().then((migrated: boolean) => {
  if (migrated) {
    debug('[App Init] IndexedDB migration completed - cache cleared for improved architecture');
  }
}).catch((migError: any) => {
  warn('[App Init] IndexedDB migration error (non-critical):', migError);
});

// Add global localStorage diagnostic utilities for debugging
// Also clean up old pending logs on startup
if (typeof window !== 'undefined') {
  import('./utils/logging').then(({ getLocalStorageStats, clearPendingLogs, cleanupOldLogs }) => {
    // First, remove logs older than 7 days
    const removedOldCount = cleanupOldLogs(7 * 24 * 60 * 60 * 1000);
    if (removedOldCount > 0) {
      debug(`[App Init] Removed ${removedOldCount} old pending logs (>7 days)`);
    }
    
    // Check for excessive pending logs on startup and clean them up
    const stats = getLocalStorageStats();
    const MAX_STARTUP_LOGS = 100; // If more than 100 logs, they're likely stale
    
    if (stats.pendingLogsCount > MAX_STARTUP_LOGS) {
      warn(`[App Init] Found ${stats.pendingLogsCount} pending logs (${(stats.pendingLogsSize / 1024).toFixed(2)} KB) - clearing stale logs`);
      clearPendingLogs();
      debug('[App Init] Stale pending logs cleared');
    } else if (stats.pendingLogsCount > 0) {
      debug(`[App Init] Found ${stats.pendingLogsCount} pending logs (${(stats.pendingLogsSize / 1024).toFixed(2)} KB) - will flush on login`);
    }
    
    // Install diagnostic utilities
    (window as any).logStorageStats = () => {
      const stats = getLocalStorageStats();
      log('=== localStorage Statistics ===');
      log(`Total size: ${(stats.totalSize / 1024).toFixed(2)} KB`);
      log(`Pending logs size: ${(stats.pendingLogsSize / 1024).toFixed(2)} KB`);
      log(`Pending logs count: ${stats.pendingLogsCount}`);
      log(`Other data size: ${(stats.otherSize / 1024).toFixed(2)} KB`);
      log('================================');
      log('To clear pending logs, run: clearPendingLogs()');
      return stats;
    };
    
    (window as any).clearPendingLogs = () => {
      clearPendingLogs();
      log('Pending logs cleared successfully');
      const stats = getLocalStorageStats();
      log(`New pending logs count: ${stats.pendingLogsCount}`);
    };
    
    debug('[App Init] localStorage diagnostic utilities installed: logStorageStats(), clearPendingLogs()');
  }).catch(err => {
    warn('[App Init] Failed to install localStorage diagnostic utilities:', err);
  });
}

const root = document.getElementById('root');

// Initialize the selection store FIRST - sync signals are created at module load time
// but we need to ensure the store is properly initialized before clearing
initializeSelectionStore();

// Clear all selection and cut data on application startup
// This runs AFTER sync signals are initialized to avoid race conditions
// It will check if selection was intentionally cleared and handle accordingly
clearSelectionOnStartup();

// Check if this is the first load by looking for a flag in sessionStorage
if (!sessionStorage.getItem('appInitialized')) {
  // Ensure playback is stopped on startup
  setIsPlaying(false);
  sessionStorage.setItem('appInitialized', 'true');
}

// Always ensure playback is stopped on application startup
// This handles cases where playback might have been running when the browser was closed
setIsPlaying(false);

// Start dataset retention cleanup (only on desktop, not mobile)
if (!isMobileDevice()) {
  import('./store/huniDBStore.js').then(({ huniDBStore }) => {
    huniDBStore.startDatasetRetentionCleanup();
    debug('[App Init] Started dataset retention cleanup');
  }).catch(err => {
    warn('[App Init] Failed to start dataset retention cleanup:', err);
  });
} else {
  debug('[App Init] Skipping HuniDB retention cleanup on mobile device');
}

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got mispelled?',
  );
} else {
  // Authentication handshake - try to validate existing tokens
  // Don't block app rendering - check auth in background
  const hasTokens = authManager.getAccessToken() && authManager.getRefreshToken();
  
  if (hasTokens) {
    // Set initial state optimistically, then verify in background
    // This allows the app to render immediately
    debug('[App Init] Tokens found, verifying authentication in background...');
    
    authManager.getCurrentUser().then((result) => {
      if (result.success && result.data) {
        // Authentication successful - set user data
        const user_info = result.data;
        
        getData(`/api/users/subscription?id=${encodeURIComponent(user_info.user_id)}`).then((subscriptionResult) => {
          setSubscription(subscriptionResult.data);
    }).catch((subErr: any) => {
      // Subscription fetch failed, but user is still authenticated
      debug('Could not fetch subscription data', subErr);
    });
        
        setIsLoggedIn(true);
        setUser(user_info);
        
        // Load persistent settings from API after successful authentication
        // Note: Settings will be loaded when the sidebar initializes with projects
        debug('[App Init] User authenticated, settings will be loaded by sidebar initialization');
      } else {
        // Invalid response - clear tokens and set logged out state
        authManager.clearTokens();
        setIsLoggedIn(false);
        setUser(null);
        setSubscription(null);
      }
    }).catch((err: any) => {
      // Authentication failed - clear tokens and set logged out state
      debug('[App Init] Authentication check failed:', err);
      authManager.clearTokens();
      setIsLoggedIn(false);
      setUser(null);
      setSubscription(null);
    });
  } else {
    // No tokens present - user is not logged in
    setIsLoggedIn(false);
    setUser(null);
    setSubscription(null);
  }
}

// Render app immediately - don't wait for auth check
debug('[App Init] Rendering app...');
render(() => <App />, root);

// Flush all HuniDB databases when app closes to ensure data is persisted
// Lazy load huniDBStore only when needed (pagehide handlers)
// This prevents blocking initial load, especially on mobile devices
if (typeof window !== 'undefined') {
  // Use pagehide as primary mechanism - more reliable than beforeunload
  // pagehide fires in more cases (navigation, tab close, browser close) and
  // can sometimes wait for promises to complete
  window.addEventListener('pagehide', async (event) => {
    // If page is being cached (bfcache), we don't need to flush
    // But if page is unloading, we should flush
    if (!event.persisted) {
      try {
        // Check if we're on a live page (which doesn't use HuniDB)
        const isLivePage = window.location.pathname.includes('/live/');
        if (isLivePage) {
          // Live pages use Redis/streamingStore, not HuniDB - skip flush
          return;
        }
        // Lazy load huniDBStore only when page is actually unloading
        const { huniDBStore } = await import('./store/huniDBStore');
        debug('[App] Page unloading, flushing HuniDB databases...');
        // Flush immediately on page unload - this is critical for data persistence
        const flushPromise = huniDBStore.flushAll(true);
        // For browsers that support it, try to keep the page alive briefly
        // This is a best-effort approach - some browsers will still close
        flushPromise
          .then(() => {
            debug('[App] Successfully flushed HuniDB databases on pagehide');
          })
          .catch(err => {
            warn('[App] Error flushing databases on pagehide:', err);
          });
      } catch (err) {
        warn('[App] Could not load huniDBStore for flush:', err);
      }
    } else {
      debug('[App] Page being cached (bfcache), skipping flush');
    }
  });
  
  // Use beforeunload as backup (less reliable, but some browsers support it better)
  window.addEventListener('beforeunload', async () => {
    // Note: async operations in beforeunload are unreliable
    // The engine's scheduled save should have already saved most data
    // This is just a last-ditch effort
    try {
      // Check if we're on a live page (which doesn't use HuniDB)
      const isLivePage = window.location.pathname.includes('/live/');
      if (isLivePage) {
        // Live pages use Redis/streamingStore, not HuniDB - skip flush
        return;
      }
      const { huniDBStore } = await import('./store/huniDBStore');
      // Flush immediately on beforeunload - this is critical for data persistence
      huniDBStore.flushAll(true).catch(() => {
        // Silently fail - this is expected in beforeunload
      });
    } catch (err) {
      // Silently fail - huniDBStore might not be needed
    }
  });
  
  // Use visibilitychange to flush when tab becomes hidden (user might close tab)
  // This gives us an earlier opportunity to save before the page actually closes
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      try {
        // Lazy load huniDBStore only when tab becomes hidden
        const { huniDBStore } = await import('./store/huniDBStore');
        // Check if we're on a live page (which doesn't use HuniDB)
        const isLivePage = window.location.pathname.includes('/live/');
        if (isLivePage) {
          // Live pages use Redis/streamingStore, not HuniDB - skip flush
          return;
        }
        debug('[App] Tab became hidden, flushing HuniDB databases...');
        // Flush immediately when tab becomes hidden (user might be closing it)
        // This is our best chance to save data before browser closes
        huniDBStore.flushAll(true)
          .then(() => {
            debug('[App] Successfully flushed HuniDB databases on visibility change');
          })
          .catch(err => {
            warn('[App] Error flushing databases on visibility change:', err);
          });
      } catch (err) {
        warn('[App] Could not load huniDBStore for flush:', err);
      }
    }
  });
}