import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  
  // Dev mode: serve examples
  if (isDev) {
    return {
      root: resolve(__dirname, 'examples'),
      server: {
        port: 5174,
        host: '0.0.0.0', // Allow access from network (use your machine's IP like 192.168.0.18:5174)
        headers: (req) => {
          // Only set COOP/COEP headers for localhost (trustworthy origin)
          // For network IPs, these headers are ignored and cause warnings
          const isLocalhost = req.headers.host?.includes('localhost') || req.headers.host?.includes('127.0.0.1');
          if (isLocalhost) {
            return {
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
            };
          }
          return {};
        },
      },
      resolve: {
        alias: {
          '@hunico/hunidb': resolve(__dirname, 'src/index.ts'),
        },
      },
      optimizeDeps: {
        exclude: ['@sqlite.org/sqlite-wasm'],
      },
    };
  }
  
  // Build mode: library build
  return {
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'HuniDB',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [],
      output: {
        globals: {},
        // Preserve WASM and worker files
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/[name][extname]';
          }
          if (assetInfo.name?.endsWith('.worker.js')) {
            return 'assets/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
        // Ensure proper code splitting for WASM
        manualChunks: undefined,
      },
    },
    sourcemap: true,
    minify: 'esbuild',
    target: 'es2020',
    // Copy WASM files to assets
    assetsDir: 'assets',
    copyPublicDir: false,
  },
  plugins: [],
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
    plugins: () => [],
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    headers: (req) => {
      // Only set COOP/COEP headers for localhost (trustworthy origin)
      const isLocalhost = req.headers.host?.includes('localhost') || req.headers.host?.includes('127.0.0.1');
      if (isLocalhost) {
        return {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        };
      }
      return {};
    },
  },
  };
});

