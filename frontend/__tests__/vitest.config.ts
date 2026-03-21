/**
 * Vitest Configuration for TeamShare Tests
 * 
 * Configures test environment, coverage, and test organization
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    // Test environment
    environment: 'jsdom',
    
    // Test file patterns
    include: [
      'frontend/__tests__/**/*.{test,spec}.{js,ts,jsx,tsx}',
      'frontend/**/*.{test,spec}.{js,ts,jsx,tsx}'
    ],
    
    // Exclude patterns
    exclude: [
      'node_modules',
      'dist',
      'build',
      'coverage',
      'frontend/__tests__/fixtures',
      'frontend/__tests__/mocks'
    ],
    
    // Test timeout
    testTimeout: 10000,
    
    // Setup files
    setupFiles: [
      './frontend/__tests__/setup/testSetup.ts'
    ],
    
    // Global test configuration
    globals: true,
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: [
        'frontend/**/*.{js,ts,jsx,tsx}'
      ],
      exclude: [
        'frontend/**/*.{test,spec}.{js,ts,jsx,tsx}',
        'frontend/__tests__/**/*',
        'frontend/**/*.d.ts',
        'frontend/index.tsx',
        'frontend/App.tsx'
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80
        }
      }
    },
    
    // Test organization
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false
      }
    },
    
    // Reporter configuration
    reporter: ['verbose', 'json', 'html'],
    // Keep Vitest artifacts out of project root
    outputFile: {
      json: './assets/vitest/test-results.json',
      html: './assets/vitest-test-results.html'
    },
    
    // Watch mode configuration
    watch: false,
    
    // Test retry configuration
    retry: 2,
    
    // Test isolation
    isolate: true,
    
    // Mock configuration
    mockReset: true,
    restoreMocks: true,
    clearMocks: true
  },
  
  // Resolve configuration
  resolve: {
    alias: {
      '@': resolve(__dirname, '../frontend'),
      '@tests': resolve(__dirname, '../frontend/__tests__'),
      '@fixtures': resolve(__dirname, '../frontend/__tests__/fixtures'),
      '@mocks': resolve(__dirname, '../frontend/__tests__/mocks'),
      '@utils': resolve(__dirname, '../frontend/__tests__/utils'),
      // Allow frontend code imports like "@config/env" to resolve in tests.
      // Point directly at a stub inside the test root that re-exports the real module.
      '@config': resolve(process.cwd(), 'frontend/config'),
      '@config/env': resolve(process.cwd(), 'frontend/config/env.js')
    }
  },
  
  // Define configuration
  define: {
    'import.meta.env.DEV': true,
    'import.meta.env.PROD': false,
    'import.meta.env.VITE_LOG_LEVEL': 'debug'
  }
});
