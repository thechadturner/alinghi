/**
 * Automated test for performance-test.html page
 * Uses Playwright to test the page functionality
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

test.describe('Performance Test Page', () => {
  test.beforeEach(async ({ page }) => {
    // Start Vite dev server or use existing
    const port = 5173;
    await page.goto(`http://localhost:${port}/examples/performance-test.html`);
    
    // Wait for page to load
    await page.waitForSelector('.container', { timeout: 10000 });
  });

  test('should connect to database', async ({ page }) => {
    // Click connect button
    const connectBtn = page.locator('#btnConnect');
    await connectBtn.click();
    
    // Wait for success message
    await expect(page.locator('.output')).toContainText('Database connected successfully', { timeout: 10000 });
  });

  test('should create JSON table', async ({ page }) => {
    // Connect first
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    
    // Create table
    await page.locator('#btnCreateTable').click();
    
    // Wait for success
    await expect(page.locator('.output')).toContainText('JSON table created successfully', { timeout: 5000 });
  });

  test('should batch insert documents', async ({ page }) => {
    // Connect and create table
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    
    // Batch insert 100
    await page.locator('#btnBatch100').click();
    
    // Wait for success
    await expect(page.locator('.output')).toContainText('Batch wrote 100 documents', { timeout: 10000 });
  });

  test('should warm cache', async ({ page }) => {
    // Setup
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnBatch100').click();
    await page.waitForTimeout(2000);
    
    // Warm cache
    await page.locator('#btnCacheWarm').click();
    
    // Wait for completion
    await expect(page.locator('.output')).toContainText('Cache warmed', { timeout: 10000 });
  });

  test('should test cache and show hits', async ({ page }) => {
    // Full setup
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnBatch100').click();
    await page.waitForTimeout(2000);
    await page.locator('#btnCacheWarm').click();
    await page.waitForTimeout(2000);
    
    // Test cache
    await page.locator('#btnCacheTest').click();
    
    // Wait for completion and check for hits
    await expect(page.locator('.output')).toContainText('Cache test completed', { timeout: 15000 });
    
    // Check that we have some hits (should be > 0)
    const output = await page.locator('.output').textContent();
    const hitsMatch = output.match(/(\d+) hits/);
    if (hitsMatch) {
      const hits = parseInt(hitsMatch[1]);
      console.log(`Cache hits: ${hits}`);
      // We should have some hits after warming
      expect(hits).toBeGreaterThan(0);
    }
  });

  test('should create FTS index', async ({ page }) => {
    // Setup
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnBatch100').click();
    await page.waitForTimeout(2000);
    
    // Create FTS
    await page.locator('#btnCreateFTS').click();
    
    // Wait for success
    await expect(page.locator('.output')).toContainText('FTS5 index created', { timeout: 15000 });
  });

  test('should search FTS', async ({ page }) => {
    // Full setup
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnBatch100').click();
    await page.waitForTimeout(2000);
    await page.locator('#btnCreateFTS').click();
    await page.waitForTimeout(3000);
    
    // Search
    await page.locator('#btnSearchFTS').click();
    
    // Wait for results
    await expect(page.locator('.output')).toContainText('Search results', { timeout: 10000 });
  });

  test('should update metrics', async ({ page }) => {
    // Connect
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    
    // Check metrics are displayed
    const metricsGrid = page.locator('.metrics-grid');
    await expect(metricsGrid).toBeVisible();
    
    // Do some operations
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnBatch100').click();
    await page.waitForTimeout(2000);
    
    // Check metrics updated
    const queryCount = page.locator('.metric-card').first();
    const countText = await queryCount.textContent();
    expect(countText).toContain('Query Count');
    
    // Metrics should show some queries
    const metricsText = await metricsGrid.textContent();
    expect(metricsText).toMatch(/\d+/); // Should have some numbers
  });
});

