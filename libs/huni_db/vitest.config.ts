import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['__tests__/**/*.test.ts'],
    // Exclude browser-only Playwright tests from the Vitest run
    exclude: ['__tests__/integration/browser.test.ts'],
    // Separate environments for different test types
    testTimeout: 10000, // SQLite WASM loading can take time
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/json/placeholder.ts',
        'src/sync/placeholder.ts',
      ],
    },
  },
});

