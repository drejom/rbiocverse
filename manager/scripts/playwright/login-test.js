/**
 * Test login flow
 * Verifies authentication and main panel loading
 */
const { chromium } = require('playwright');

const TARGET_URL = process.env.TEST_URL || 'http://localhost:3000';
const USERNAME = process.env.TEST_USERNAME || 'testuser';
const PASSWORD = process.env.TEST_PASSWORD || 'testpass';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  try {
    console.log('Navigating to', TARGET_URL);
    await page.goto(TARGET_URL);
    await page.waitForTimeout(1000);

    // Check if already logged in
    const loginForm = page.locator('input[type="password"]');
    if (await loginForm.count() === 0) {
      console.log('Already logged in');
      await page.screenshot({ path: '/tmp/login-already-authenticated.png' });
      await browser.close();
      return;
    }

    // Fill login form
    console.log('Logging in as', USERNAME);
    await page.fill('input[placeholder*="username" i]', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.screenshot({ path: '/tmp/login-1-filled.png' });

    // Submit
    await page.click('button:has-text("Sign in")');
    await page.waitForTimeout(2000);

    // Check for errors
    const errorMsg = page.locator('.error-message, .login-error');
    if (await errorMsg.count() > 0 && await errorMsg.isVisible()) {
      const error = await errorMsg.textContent();
      console.log('Login error:', error);
      await page.screenshot({ path: '/tmp/login-error.png' });
    } else {
      console.log('Login successful');
      await page.screenshot({ path: '/tmp/login-2-success.png' });
    }

    // Verify main panel loaded
    const mainPanel = page.locator('.main-panel, .cluster-selector');
    if (await mainPanel.count() > 0) {
      console.log('Main panel loaded');
    }

  } catch (error) {
    console.error('Test failed:', error.message);
    await page.screenshot({ path: '/tmp/login-error.png' });
  } finally {
    await browser.close();
  }
})();
