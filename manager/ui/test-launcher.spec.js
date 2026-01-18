import { test } from '@playwright/test';

// Test credentials from environment variables
const TEST_USERNAME = process.env.TEST_USERNAME || 'test-user';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test-password';

test('Launcher Modal Style', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');

  // Login
  await page.fill('input[type="text"], input[placeholder*="username"]', TEST_USERNAME);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button:has-text("Sign in")');

  // Wait for launcher
  await page.waitForSelector('.user-menu-trigger', { timeout: 10000 });
  await page.screenshot({ path: 'test-results/launcher-01-main.png', fullPage: true });

  // Click a Launch button to trigger the overlay
  const launchBtn = page.locator('button:has-text("Launch")').first();
  if (await launchBtn.isVisible()) {
    await launchBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/launcher-02-overlay.png', fullPage: true });

    // Screenshot just the modal
    const modal = page.locator('.loading-content').first();
    if (await modal.isVisible()) {
      await modal.screenshot({ path: 'test-results/launcher-03-modal.png' });
      const box = await modal.boundingBox();
      console.log('Launcher modal dimensions:', JSON.stringify(box));
    }
  }
});
