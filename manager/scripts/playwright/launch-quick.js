/**
 * Quick launch test - VS Code with default resources
 * Tests the happy path where job starts quickly
 */
const { chromium } = require('playwright');

const TARGET_URL = process.env.TEST_URL || 'http://localhost:3000';
const USERNAME = process.env.TEST_USERNAME;
const PASSWORD = process.env.TEST_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('TEST_USERNAME and TEST_PASSWORD must be set');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  try {
    console.log('Navigating to', TARGET_URL);
    await page.goto(TARGET_URL);
    await page.waitForTimeout(1000);

    // Login if needed
    const loginForm = page.locator('input[type="password"]');
    if (await loginForm.count() > 0) {
      console.log('Logging in...');
      await page.fill('input[placeholder*="username" i]', USERNAME);
      await page.fill('input[type="password"]', PASSWORD);
      await page.click('button:has-text("Sign in")');
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: '/tmp/quick-1-initial.png' });

    // Cancel existing job if any
    const cancelBtn = page.locator('button.btn-cancel:has-text("Cancel")');
    if (await cancelBtn.count() > 0 && await cancelBtn.isVisible()) {
      console.log('Cancelling existing job...');
      await cancelBtn.click();
      await page.waitForTimeout(3000);
    }

    // Click Launch button (uses defaults)
    const launchBtn = page.locator('button.btn-primary:has-text("Launch")');
    if (await launchBtn.isVisible() && await launchBtn.isEnabled()) {
      console.log('Clicking Launch...');
      await launchBtn.click();

      // Monitor progress modal
      for (let i = 1; i <= 30; i++) {
        await page.waitForTimeout(500);

        const loadingOverlay = page.locator('.loading-overlay');
        const sessionCard = page.locator('.session-card');
        const progressStep = page.locator('.progress-step');

        if (await loadingOverlay.count() > 0 && await loadingOverlay.isVisible()) {
          const stepText = await progressStep.textContent().catch(() => '');
          console.log(`Step ${i}: Modal - "${stepText}"`);

          // Capture key stages
          if (i === 1 || stepText.includes('Almost ready')) {
            await page.screenshot({ path: `/tmp/quick-${i}-${stepText.replace(/[^a-z]/gi, '')}.png` });
          }
        } else if (await sessionCard.count() > 0 && await sessionCard.isVisible()) {
          console.log(`Step ${i}: Session card appeared`);
          await page.screenshot({ path: '/tmp/quick-session-card.png' });
          break;
        } else {
          // Check if redirected to IDE
          if (page.url().includes('/code/') || page.url().includes('/rstudio/')) {
            console.log('Redirected to IDE:', page.url());
            await page.screenshot({ path: '/tmp/quick-ide-loaded.png' });
            break;
          }
        }
      }
    } else {
      console.log('Launch button not available');
      await page.screenshot({ path: '/tmp/quick-no-launch.png' });
    }

  } catch (error) {
    console.error('Test failed:', error.message);
    await page.screenshot({ path: '/tmp/quick-error.png' });
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();
  }
})();
