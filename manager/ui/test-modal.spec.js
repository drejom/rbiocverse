import { test, expect } from '@playwright/test';

test('SSH Key Management Modal Layout', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');

  // Login first
  await page.fill('input[type="text"], input[placeholder*="username"]', 'domeally');
  await page.fill('input[type="password"]', 'biddy41$');
  await page.click('button:has-text("Sign in")');

  // Wait for login to complete - wait for user menu to appear
  await page.waitForSelector('.user-menu-trigger', { timeout: 10000 });
  await page.screenshot({ path: 'test-results/01-after-login.png', fullPage: true });

  // Click user menu trigger (avatar dropdown)
  await page.click('.user-menu-trigger');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/02-menu-open.png', fullPage: true });

  // Click Manage Keys in dropdown
  await page.click('button:has-text("Manage Keys")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/03-modal.png', fullPage: true });

  // Get modal element
  const modal = page.locator('.loading-overlay > div').first();
  await modal.waitFor({ state: 'visible', timeout: 5000 });

  const box = await modal.boundingBox();
  console.log('Modal dimensions:', JSON.stringify(box));
  await modal.screenshot({ path: 'test-results/04-modal-only.png' });

  // Get button row dimensions
  const keyActions = modal.locator('.key-actions');
  if (await keyActions.isVisible()) {
    const btnBox = await keyActions.boundingBox();
    console.log('Button row dimensions:', JSON.stringify(btnBox));
  }
});
