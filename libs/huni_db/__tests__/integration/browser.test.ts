import { test, expect } from '@playwright/test';

test.describe('HuniDB Browser Integration Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the example page (served by Vite dev server)
    await page.goto('/basic.html');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
  });

  test('should initialize database', async ({ page }) => {
    // Click initialize button
    await page.click('#btnInit');
    
    // Wait for success message
    await expect(page.locator('#output')).toContainText('✓ Database connected successfully');
    
    // Verify other buttons are enabled
    await expect(page.locator('#btnInfo')).toBeEnabled();
    await expect(page.locator('#btnMigrate')).toBeEnabled();
  });

  test('should run migrations', async ({ page }) => {
    // Initialize first
    await page.click('#btnInit');
    await page.waitForSelector('#output:has-text("✓ Database connected")');
    
    // Run migrations
    await page.click('#btnMigrate');
    
    // Wait for migration success
    await expect(page.locator('#output')).toContainText('✓ Migrations completed');
  });

  test('should insert and query data', async ({ page }) => {
    // Initialize and migrate
    await page.click('#btnInit');
    await page.waitForSelector('#output:has-text("✓ Database connected")');
    await page.click('#btnMigrate');
    await page.waitForSelector('#output:has-text("✓ Migrations completed")');
    
    // Insert data
    await page.click('#btnInsert');
    
    // Wait for insert success
    await expect(page.locator('#output')).toContainText('✓ Inserted 3 users');
    
    // Query data
    await page.click('#btnQuery');
    
    // Verify query results
    await expect(page.locator('#output')).toContainText('Found');
    await expect(page.locator('#output')).toContainText('users');
  });

  test('should handle transactions', async ({ page }) => {
    // Initialize and migrate
    await page.click('#btnInit');
    await page.waitForSelector('#output:has-text("✓ Database connected")');
    await page.click('#btnMigrate');
    await page.waitForSelector('#output:has-text("✓ Migrations completed")');
    
    // Run transaction
    await page.click('#btnTransaction');
    
    // Verify transaction success
    await expect(page.locator('#output')).toContainText('✓ Transaction completed');
  });

  test('should show storage info', async ({ page }) => {
    // Initialize
    await page.click('#btnInit');
    await page.waitForSelector('#output:has-text("✓ Database connected")');
    
    // Get storage info
    await page.click('#btnInfo');
    
    // Verify storage info is displayed
    await expect(page.locator('#output')).toContainText('Storage Information');
    await expect(page.locator('#output')).toContainText('Type:');
  });

  test('should show performance metrics', async ({ page }) => {
    // Initialize, migrate, and do some operations
    await page.click('#btnInit');
    await page.waitForSelector('#output:has-text("✓ Database connected")');
    await page.click('#btnMigrate');
    await page.waitForSelector('#output:has-text("✓ Migrations completed")');
    await page.click('#btnInsert');
    await page.waitForSelector('#output:has-text("✓ Inserted")');
    await page.click('#btnQuery');
    await page.waitForSelector('#output:has-text("Found")');
    
    // Get metrics
    await page.click('#btnMetrics');
    
    // Verify metrics are displayed
    await expect(page.locator('#output')).toContainText('Performance Metrics');
    await expect(page.locator('#output')).toContainText('Queries:');
  });
});

