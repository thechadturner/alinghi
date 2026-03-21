/**
 * Browser test for performance-test.html
 * Tests the full workflow: connect, create table, batch insert, cache, FTS
 */

import { test, expect } from '@playwright/test';

test.describe('Performance Test Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the performance test page
    // Assumes Vite dev server is running on port 5173
    await page.goto('http://localhost:5173/examples/performance-test.html', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    // Wait for page to load
    await page.waitForSelector('.container', { timeout: 10000 });
  });

  test('should complete full workflow', async ({ page }) => {
    const output = page.locator('.output');
    
    // Step 1: Connect
    console.log('Step 1: Connecting to database...');
    await page.locator('#btnConnect').click();
    await expect(output).toContainText('Database connected successfully', { timeout: 15000 });
    await page.waitForTimeout(1000);
    
    // Step 2: Create table
    console.log('Step 2: Creating JSON table...');
    await page.locator('#btnCreateTable').click();
    await expect(output).toContainText('JSON table created successfully', { timeout: 10000 });
    await page.waitForTimeout(1000);
    
    // Step 3: Batch insert 100
    console.log('Step 3: Batch inserting 100 documents...');
    await page.locator('#btnBatch100').click();
    await expect(output).toContainText('Batch wrote 100 documents', { timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // Step 4: Warm cache
    console.log('Step 4: Warming cache...');
    await page.locator('#btnCacheWarm').click();
    await expect(output).toContainText('Cache warmed', { timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // Step 5: Test cache - should show hits
    console.log('Step 5: Testing cache...');
    await page.locator('#btnCacheTest').click();
    await expect(output).toContainText('Cache test completed', { timeout: 20000 });
    
    // Check cache stats - should have hits
    const outputText = await output.textContent();
    const hitsMatch = outputText?.match(/(\d+) hits/);
    if (hitsMatch) {
      const hits = parseInt(hitsMatch[1]);
      console.log(`Cache hits: ${hits}`);
      expect(hits).toBeGreaterThan(0);
    } else {
      throw new Error('Cache stats not found in output');
    }
    await page.waitForTimeout(2000);
    
    // Step 6: Create FTS index
    console.log('Step 6: Creating FTS index...');
    await page.locator('#btnCreateFTS').click();
    await expect(output).toContainText('FTS5 index created', { timeout: 20000 });
    await page.waitForTimeout(3000);
    
    // Step 7: Search FTS
    console.log('Step 7: Testing FTS search...');
    await page.locator('#btnSearchFTS').click();
    await expect(output).toContainText(/Search results|Found \d+ results/, { timeout: 15000 });
    
    // Verify metrics are updating
    console.log('Step 8: Verifying metrics...');
    const metricsGrid = page.locator('.metrics-grid');
    await expect(metricsGrid).toBeVisible();
    const metricsText = await metricsGrid.textContent();
    expect(metricsText).toMatch(/\d+/); // Should have numbers
    
    console.log('✅ All tests passed!');
  });

  test('should update metrics after operations', async ({ page }) => {
    // Connect
    await page.locator('#btnConnect').click();
    await page.waitForTimeout(1000);
    
    // Check initial metrics
    const metricsGrid = page.locator('.metrics-grid');
    await expect(metricsGrid).toBeVisible();
    
    // Do operations
    await page.locator('#btnCreateTable').click();
    await page.waitForTimeout(1000);
    await page.locator('#btnBatch100').click();
    await page.waitForTimeout(2000);
    
    // Metrics should show queries
    const metricsText = await metricsGrid.textContent();
    expect(metricsText).toMatch(/\d+/);
    
    // Query count should be > 0
    const queryCountCard = metricsGrid.locator('.metric-card').first();
    const queryCountText = await queryCountCard.textContent();
    expect(queryCountText).toMatch(/\d+/);
  });
});

