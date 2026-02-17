import { test } from '@playwright/test';

// Test credentials from environment variables
const TEST_USERNAME = process.env.TEST_USERNAME || 'test-user';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test-password';

test('Light theme cluster cards', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');

  // Login
  await page.fill('input[type="text"], input[placeholder*="username"]', TEST_USERNAME);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button:has-text("Sign in")');

  // Wait for launcher
  await page.waitForSelector('.user-menu-trigger', { timeout: 10000 });

  // Switch to light theme
  await page.click('.user-menu-trigger');
  await page.waitForTimeout(300);

  // Click light theme option
  const lightBtn = page.locator('button[title="Light"]');
  if (await lightBtn.isVisible()) {
    await lightBtn.click();
  }
  await page.waitForTimeout(500);

  // Close menu by clicking elsewhere
  await page.click('body', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'test-results/theme-light-01.png', fullPage: true });

  // Screenshot a cluster card
  const clusterCard = page.locator('.cluster-card').first();
  if (await clusterCard.isVisible()) {
    await clusterCard.screenshot({ path: 'test-results/theme-light-02-card.png' });
  }
});
