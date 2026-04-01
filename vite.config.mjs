import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { visualizer } from 'rollup-plugin-visualizer';

import { loadEnv } from 'vite';

/**
 * Parse port from env string; fall back when missing or invalid.
 * @param {string | undefined} v
 * @param {number} fallback
 */
function parsePort(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * When running `vite` on localhost:3000 without nginx, forward /api/* to local
 * Node/Python services (same split as docker/nginx/nginx-dev.conf).
 * @param {Record<string, string>} env from loadEnv
 */
function createDevApiProxy(env) {
  const appPort = parsePort(env.VITE_APP_PORT, 8069);
  const adminPort = parsePort(env.VITE_ADMIN_PORT, 8059);
  const filePort = parsePort(env.VITE_FILE_PORT, 8079);
  const mediaPort = parsePort(env.VITE_MEDIA_PORT, 8089);
  const streamPort = parsePort(env.VITE_STREAM_PORT, 8099);
  const pythonPort = parsePort(env.VITE_PYTHON_PORT, 8049);

  const app = `http://127.0.0.1:${appPort}`;
  const admin = `http://127.0.0.1:${adminPort}`;
  const file = `http://127.0.0.1:${filePort}`;
  const media = `http://127.0.0.1:${mediaPort}`;
  const stream = `http://127.0.0.1:${streamPort}`;
  const python = `http://127.0.0.1:${pythonPort}`;

  const forward = (target, rewrite) => ({
    target,
    changeOrigin: true,
    ...(rewrite ? { rewrite: (path) => rewrite(path) } : {}),
  });

  /** @type {import('vite').ProxyOptions} */
  const base = { changeOrigin: true };

  // Longest / most specific paths first (first match wins in dev).
  return {
    '/api/admin/events/upload-progress': forward(admin, (path) =>
      path.replace(/^\/api\/admin\/events\/upload-progress/, '/api/events/upload-progress')
    ),
    '/api/admin/api/upload/progress': forward(admin, (path) =>
      path.replace(/^\/api\/admin\/api\/upload\/progress/, '/api/upload/progress')
    ),
    '/api/admin/log_activity': { ...base, target: app },
    '/api/admin/user_activity': { ...base, target: app },
    '/api/admin/timezones': { ...base, target: app },
    '/api/file/health': forward(file, () => '/api/health'),
    '/api/file': { ...base, target: file },
    '/api/stream/ws': { ...base, target: stream, ws: true },
    '/api/stream': { ...base, target: stream, ws: true },
    '/api/python': forward(python, (path) => path.replace(/^\/api\/python/, '/api')),
    '/api/media/video': forward(media, (path) => path.replace(/^\/api\/media\/video/, '/api/video')),
    '/api/media/': { ...base, target: app },
    '/api/log': { ...base, target: admin },
    '/api/admin/': forward(admin, (path) => path.replace(/^\/api\/admin\/?/, '/api/')),
    '/api': { ...base, target: app },
  };
}

// Repo root (directory containing this config); avoids hardcoded machine paths
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname);
const repoParent = resolve(repoRoot, '..');
const syncstoreExternal = resolve(repoParent, 'WebApps', 'SolidJs', 'syncstore');
const webappsRoot = resolve(repoParent, 'WebApps');

// Plugin to ensure solid-icons JSX is transformed correctly
const transformSolidIconsPlugin = () => {
  return {
    name: 'transform-solid-icons',
    enforce: 'pre',
    transform(code, id) {
      // Only process solid-icons package JSX files
      if (id.includes('node_modules/solid-icons') && id.endsWith('.jsx') && typeof code === 'string') {
        let transformed = code;
        
        // Remove any React imports that might have been incorrectly added
        transformed = transformed.replace(/import\s+.*\s+from\s+["']react["'];?\n?/g, '');
        transformed = transformed.replace(/import\s+.*\s+from\s+["']react\/jsx-runtime["'];?\n?/g, '');
        
        // Ensure SolidJS imports are present
        if (!transformed.includes("from 'solid-js'") && !transformed.includes('from "solid-js"')) {
          // Add SolidJS import if missing (shouldn't be needed, but safety check)
          const hasSolidJSImport = transformed.includes('solid-js');
          if (!hasSolidJSImport && transformed.includes('createSignal') || transformed.includes('createEffect')) {
            // File uses SolidJS but might be missing import - this shouldn't happen but safety check
          }
        }
        
        if (transformed !== code) {
          return { code: transformed, map: null };
        }
      }
      return null;
    },
  };
};

// Plugin to prevent React references in SolidJS build
const preventReactPlugin = () => {
  return {
    name: 'prevent-react',
    enforce: 'pre',
    transform(code, id) {
      // Check for React references in source code (not node_modules)
      if (!id.includes('node_modules') && typeof code === 'string') {
        // Check for React imports or usage
        if (code.includes('from "react"') || code.includes("from 'react'") || 
            code.includes('require("react"') || code.includes("require('react'") ||
            code.includes('React.') || code.includes('React[')) {
          throw new Error(
            `React reference found in ${id}. This is a SolidJS application - React should not be used.`
          );
        }
      }
      return null;
    },
  };
};

// Plugin to rewrite /public/assets/ paths to /assets/ for SQLite worker files
// This fixes Vite warnings about public directory paths
const rewritePublicPathsPlugin = () => {
  return {
    name: 'rewrite-public-paths',
    // Process both application code and node_modules (especially SQLite library)
    enforce: 'pre', // Run before other plugins
    transform(code, id) {
      // Process all files, including node_modules, to catch SQLite worker paths
      // Replace /public/assets/ with /assets/ in string literals
      // This handles paths like '/public/assets/sqlite3-opfs-async-proxy.js?worker_file&type=classic'
      let transformed = code;
      
      // Handle single quotes: '/public/assets/...'
      transformed = transformed.replace(
        /'\/public\/assets\/([^']+)'/g,
        "'/assets/$1'"
      );
      
      // Handle double quotes: "/public/assets/..."
      transformed = transformed.replace(
        /"\/public\/assets\/([^"]+)"/g,
        '"/assets/$1"'
      );
      
      // Handle template literals: `/public/assets/...`
      transformed = transformed.replace(
        /`\/public\/assets\/([^`]+)`/g,
        '`/assets/$1`'
      );
      
      // Handle concatenated strings: '/public/' + 'assets/...'
      transformed = transformed.replace(
        /(['"`])\/public\/(['"`])\s*\+\s*(['"`])assets\//g,
        "$3/assets/"
      );
      
      // Specifically handle SQLite worker file paths that Vite might detect
      // Only replace paths that reference sqlite3-opfs-async-proxy files
      transformed = transformed.replace(
        /\/public\/assets\/sqlite3-opfs-async-proxy\.js/g,
        '/assets/sqlite3-opfs-async-proxy.js'
      );
      
      if (transformed !== code) {
        return { code: transformed, map: null };
      }
      return null;
    },
    // Also handle during module resolution
    resolveId(source, importer) {
      if (source && typeof source === 'string' && source.includes('/public/assets/')) {
        const rewritten = source.replace('/public/assets/', '/assets/');
        return rewritten;
      }
      return null;
    },
    // Configure server to rewrite paths at runtime
    configureServer(server) {
      // Rewrite /public/assets/ requests to /assets/
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.includes('/public/assets/')) {
          req.url = req.url.replace('/public/assets/', '/assets/');
        }
        next();
      });
      
      // Suppress Vite warnings about /public/assets/ paths
      // These are handled correctly by locateFile at runtime
      const originalWarn = server.config.logger.warn;
      server.config.logger.warn = (msg, options) => {
        if (typeof msg === 'string') {
          // Suppress warnings about public directory paths for SQLite workers
          if (msg.includes('/public/assets/') && msg.includes('sqlite3-opfs-async-proxy')) {
            return; // Suppress this warning
          }
          if (msg.includes('Files in the public directory') && msg.includes('sqlite3-opfs-async-proxy')) {
            return; // Suppress this warning
          }
        }
        // Use default warning handler for other warnings
        originalWarn.call(server.config.logger, msg, options);
      };
    },
  };
};

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const isProd = mode === 'production';
  
  // Load environment variables from .env files
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    // Service worker + other static root files (copied to dist as-is)
    publicDir: resolve(repoRoot, 'static-pwa'),
    plugins: [
      // Transform solid-icons to remove React references
      transformSolidIconsPlugin(),
      // Prevent React references in SolidJS build
      preventReactPlugin(),
      solidPlugin({
        // Enable Solid DevTools in development
        devtools: isDev,
        // Optimize for production
        hot: isDev,
        // Enable SSR if needed in future
        ssr: false,
        // Ensure JSX is transformed to SolidJS, not React
        solid: {
          generate: 'dom',
          hydratable: false,
        },
        // Include solid-icons in transformation
        include: ['**/*.{js,jsx,ts,tsx}', '**/node_modules/solid-icons/**/*.{js,jsx}'],
      }),
      // Rewrite /public/assets/ paths to /assets/ for SQLite worker files
      rewritePublicPathsPlugin(),
      // Bundle analyzer for production builds
      mode === 'analyze' && visualizer({
        filename: 'dist/bundle-analysis.html',
        open: true,
        gzipSize: true,
        brotliSize: true,
      }),
    ].filter(Boolean),
    
    // Define environment variables for logging
    define: {
      // Development vs Production flags
      __DEV__: isDev,
      __PROD__: isProd,
      // Logging level configuration - can be overridden with VITE_LOG_LEVEL
      __LOG_LEVEL__: isDev ? '"debug"' : '"error"',
      // Additional environment flags
      __BUILD_MODE__: JSON.stringify(mode),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      // Console logger optimization flags
      __ENABLE_LOGGING__: isDev,
      __ENABLE_DEBUG_LOGS__: isDev,
    },
  
  // Development server configuration
  server: {
    port: 3000,
    host: true, // Allow external connections
    // Forward /api to local backends (login, data, file, admin, …) — same roles as nginx in Docker
    proxy: isDev ? createDevApiProxy(env) : undefined,
    // Middleware to rewrite /public/assets/ paths to /assets/ for SQLite worker files
    // This handles runtime requests that Vite detects
    middlewareMode: false,
    hmr: {
      overlay: true, // Show error overlay
      // HMR WebSocket configuration
      // Vite auto-detects protocol (ws/wss) based on window.location.protocol
      // When page is served over HTTPS, Vite will use wss:// automatically
      // clientPort should match the nginx port (443 for HTTPS, 80 for HTTP)
      // If not set, Vite uses the dev server port, but we proxy through nginx
      // Setting to undefined lets Vite auto-detect from the page URL
      path: '/@vite/client',
      // Note: Vite will use wss:// when page protocol is https://
      // The port will be inferred from window.location.port or default to 443 for HTTPS
    },
    // Disable source maps in dev for faster reloads (enable only when debugging)
    sourcemapIgnoreList: false,
    // Allow access to files outside the workspace root
    // This is needed for @solidjs/sync package that may be referenced from external directories
    fs: {
      allow: [
        process.cwd(),
        repoRoot,
        // Optional: local @solidjs/sync / syncstore checkout next to this repo (../WebApps/SolidJs/syncstore)
        syncstoreExternal,
        webappsRoot,
        repoParent,
      ],
    },
    // Optimize file watching - exclude unnecessary directories
    watch: {
      // Exclude directories that don't need to be watched
      ignored: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/.git/**',
        '**/server_*/**', // All server directories
        '**/database/**',
        '**/docker/**',
        '**/docs/**',
        '**/libs/**',
        '**/shared/**',
        '**/scripts/**',
        '**/*.log',
        '**/*.sql',
        '**/*.db',
        '**/*.sqlite',
        '**/*.sqlite3',
        '**/*.parquet',
        '**/*.arrow',
        '**/*.csv',
        '**/uploads/**',
        '**/media/**',
        '**/.vite/**',
        '**/build/**',
        // Additional exclusions for faster watching
        '**/cursor_files/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
      ],
      // Optimize for Windows - use polling with longer interval for better performance
      usePolling: false, // Keep false unless file watching is unreliable
      interval: 1000, // Polling interval in ms (only used if usePolling is true)
    },
    // COOP/COEP headers required for SharedArrayBuffer (SQLite WASM OPFS)
    // Only set for trustworthy origins (localhost, 127.0.0.1, or HTTPS)
    // Network IPs (like 192.168.0.18) are not trustworthy for these headers
    headers: (req) => {
      const host = req.headers.host || '';
      const isTrustworthy = host.includes('localhost') || 
                           host.includes('127.0.0.1') || 
                           host.includes('[::1]');
      if (isTrustworthy) {
        return {
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Opener-Policy': 'same-origin'
        };
      }
      return {};
    }
  },

  // Build configuration
  build: {
    target: 'esnext',
    // Use esbuild for minification to avoid d3 mangling issues with terser
    // Terser was mangling d3 namespace imports to M, breaking d3.selectAll calls
    minify: isProd ? 'esbuild' : 'esbuild', // Changed from terser to esbuild to fix d3 mangling
    sourcemap: isProd, // Only generate source maps in production (disabled in dev for faster reloads)
    
    // Chunk splitting for better caching - Optimized for Solid.js
    rollupOptions: {
      // Suppress warnings about /public/assets/ paths for SQLite workers
      // These are handled correctly by locateFile at runtime
      onwarn(warning, warn) {
        // Suppress warnings about public directory paths for SQLite worker files
        if (warning.message && typeof warning.message === 'string') {
          if (warning.message.includes('/public/assets/') && 
              warning.message.includes('sqlite3-opfs-async-proxy')) {
            return; // Suppress this warning
          }
          // Also suppress the general "Files in the public directory" warning for SQLite workers
          if (warning.message.includes('Files in the public directory') &&
              warning.message.includes('sqlite3-opfs-async-proxy')) {
            return; // Suppress this warning
          }
        }
        // Use default warning handler for other warnings
        warn(warning);
      },
      output: {
        manualChunks: (id) => {
          // HuniDB library (libs/huni_db) - separate chunk for caching; do not match store names (e.g. huniDBStore)
          if (id.includes('huni_db')) {
            return 'vendor-hunidb';
          }
          // Report components - keep each class in its own chunk for better code splitting
          if (id.includes('/reports/')) {
            // Extract class name from path (e.g., frontend/reports/ac40/UploadDatasets.tsx)
            const match = id.match(/reports\/([^/]+)\//);
            if (match) {
              const className = match[1];
              return `reports-${className}`;
            }
            return 'reports';
          }
          
          // Only process node_modules for vendor chunking
          if (!id.includes('node_modules')) {
            return;
          }
          
          // Large libraries - each in their own chunk
          if (id.includes('d3')) {
            return 'vendor-d3';
          }
          if (id.includes('mapbox-gl')) {
            return 'vendor-mapbox';
          }
          if (id.includes('leaflet')) {
            return 'vendor-leaflet';
          }
          if (id.includes('apache-arrow')) {
            return 'vendor-arrow';
          }
          if (id.includes('quill')) {
            return 'vendor-quill';
          }
          
          // Solid.js ecosystem - keep together as they're often used together
          if (id.includes('solid-js') || id.includes('@solidjs')) {
            return 'vendor-solid';
          }
          
          // UI/utility libraries - group smaller ones
          if (id.includes('dompurify') || id.includes('robust-point-in-polygon')) {
            return 'vendor-utils';
          }
          
          // Remaining node_modules - split into smaller chunks by package name
          // This prevents a single massive vendor chunk
          const match = id.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
          if (match) {
            const packageName = match[1];
            // Group small packages together
            if (packageName.startsWith('@')) {
              // Scoped packages - keep in vendor-scoped chunk
              return 'vendor-scoped';
            } else {
              // Regular packages - group by first letter to create multiple chunks
              const firstLetter = packageName.charAt(0).toLowerCase();
              if (firstLetter >= 'a' && firstLetter <= 'f') {
                return 'vendor-a-f';
              } else if (firstLetter >= 'g' && firstLetter <= 'm') {
                return 'vendor-g-m';
              } else if (firstLetter >= 'n' && firstLetter <= 's') {
                return 'vendor-n-s';
              } else {
                return 'vendor-t-z';
              }
            }
          }
          
          // Fallback for any remaining node_modules
          return 'vendor-other';
        },
        // Optimize chunk file names
        chunkFileNames: (chunkInfo) => {
          // Don't mangle d3 vendor chunk - preserve d3 namespace
          if (chunkInfo.name && (chunkInfo.name.includes('d3') || chunkInfo.name.includes('vendor-d3'))) {
            return 'assets/js/[name]-[hash].js';
          }
          return 'assets/js/[name]-[hash].js';
        },
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
        // Ensure JSX files are properly handled
        preserveModules: false,
      },
    },
    
    // Optimize bundle size
    // Limit 1600 kB: manualChunks already split vendor (d3, mapbox, solid) and reports; some chunks (e.g. main app + hunidb/sqlite) remain large
    chunkSizeWarningLimit: 1600,
    
    // Single CSS bundle so production matches dev (no chunk-order or missing prestart/report styles)
    cssCodeSplit: false,
    
    // Terser configuration for production builds
    terserOptions: isProd ? {
      compress: {
        // Remove console.log statements in production builds (but keep console.error and console.warn)
        drop_console: false, // Temporarily disabled to debug production issues
        drop_debugger: true,
        // Remove unused code
        dead_code: true,
        // Remove unused variables
        unused: true,
        // Optimize conditionals
        conditionals: true,
        // Optimize comparisons
        comparisons: true,
        // Optimize boolean contexts
        booleans: true,
        // Optimize loops
        loops: true,
        // Remove unused function arguments
        arguments: true,
        // Remove unused function parameters
        keep_fargs: false,
        // Solid.js specific optimizations
        // DO NOT mark SolidJS functions as pure - they have side effects (reactive updates)
        // pure_funcs: ['createSignal', 'createEffect', 'createMemo'],
      },
      mangle: {
        // Mangle variable names for smaller bundle
        toplevel: false, // Keep toplevel names to prevent breaking SolidJS reactivity
        // Mangle function names - but preserve SolidJS and framework function names
        keep_fnames: true, // Keep function names to prevent breaking SolidJS reactivity
        // Preserve class names and function names that SolidJS relies on
        // Also preserve d3 to prevent it from being mangled to M
        reserved: ['createSignal', 'createEffect', 'createMemo', 'createStore', 'render', 'Show', 'For', 'Switch', 'Match', 'Dynamic', 'lazy', 'useNavigate', 'useLocation', 'useParams', 'useSearchParams', 'd3'],
        // Don't mangle d3 namespace object properties
        properties: {
          keep_quoted: true, // Keep quoted properties
        }
      },
      format: {
        // Remove comments
        comments: false,
      },
    } : undefined,
  },

  // CSS configuration
  css: {
    postcss: './postcss.config.js',
    devSourcemap: false, // Disable CSS source maps in dev for faster reloads
  },

  // Environment variables configuration
  envDir: '.', // Look for .env files in the project root
  envPrefix: ['VITE_'], // Only expose variables prefixed with VITE_

  // Path resolution
  resolve: {
    alias: {
      '@': resolve(__dirname, 'frontend'),
      '@components': resolve(__dirname, 'frontend/components'),
      '@pages': resolve(__dirname, 'frontend/pages'),
      '@store': resolve(__dirname, 'frontend/store'),
      '@utils': resolve(__dirname, 'frontend/utils'),
      '@styles': resolve(__dirname, 'frontend/styles'),
      '@config': resolve(__dirname, 'frontend/config'),
      '@services': resolve(__dirname, 'frontend/services'),
      // Always use built HuniDB distribution for the main application
      '@hunico/hunidb': resolve(__dirname, 'libs/huni_db/dist/index.js'),
    },
  },

  // Optimize dependencies - Solid.js specific
  // Reduced list for faster initial optimization - only include critical dependencies
  optimizeDeps: {
    include: [
      'solid-js',
      '@solidjs/router',
      // solid-icons excluded - let SolidJS plugin handle transformation to prevent React references
      // Include CommonJS modules that use default imports to ensure proper transformation
      // This fixes the "does not provide an export named 'default'" error
      'mapbox-gl',  // CommonJS module with default import
      'leaflet',    // CommonJS module with default import (import L from "leaflet")
      'quill',      // CommonJS module with default import (import Quill from "quill")
      'dompurify',  // CommonJS module with default import (import DOMPurify from "dompurify")
      // Include d3 to prevent Vite from trying to load individual source files during navigation
      // This fixes ERR_FAILED errors when navigating between pages that use d3
      'd3',
      // Only include most commonly used libraries to speed up initial optimization
    ],
    exclude: [
      '@solidjs/sync',
      '@sqlite.org/sqlite-wasm',  // Exclude from optimization - let it load dynamically
      'solid-icons',  // Exclude from optimization - let SolidJS plugin handle transformation
      // Exclude heavy libraries from pre-optimization - they'll be optimized on-demand
      // Note: apache-arrow uses namespace imports (* as) so it's safe
      'apache-arrow',
    ],
    // Force optimization for Solid.js
    esbuildOptions: {
      target: 'esnext',
    },
    // Speed up dependency optimization
    force: false, // Don't force re-optimization unless needed
  },

  // Performance optimizations
  esbuild: {
    treeShaking: true,
    minifyIdentifiers: isProd,
    minifySyntax: isProd,
    minifyWhitespace: isProd,
    // Solid.js JSX handling
    jsx: 'preserve',
    // Optimize for faster dev builds
    legalComments: 'none', // Remove comments in dev for faster processing
    logOverride: { 'this-is-undefined-in-esm': 'silent' },
  },

  // Worker configuration - use ES modules for code splitting support
  worker: {
    format: 'es',
    plugins: () => [],
    rollupOptions: {
      external: (id) => {
        // Exclude store imports from worker bundling to avoid circular dependencies
        // Workers that need stores should use ?url instead of ?worker
        if (id.includes('/store/') || id.includes('huniDBStore')) {
          return true;
        }
        return false;
      },
      output: {
        // Workers are output to dist/workers/ by default
        // Keep them there for easier organization
        entryFileNames: 'workers/[name]-[hash].js',
        chunkFileNames: 'workers/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash][extname]',
      },
    },
  },

  // Preview server (for testing production builds)
  preview: {
    port: 4173,
    host: true,
  },
  };
});

