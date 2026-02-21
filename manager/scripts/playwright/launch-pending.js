/**
 * Pending job test - Launch with large resources to test pending flow
 * Tests: modal shows "Job queued", transitions to session card with estimated time
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

    await page.screenshot({ path: '/tmp/pending-1-initial.png' });

    // Cancel existing job if any
    const cancelBtn = page.locator('button.btn-cancel:has-text("Cancel")');
    if (await cancelBtn.count() > 0 && await cancelBtn.isVisible()) {
      console.log('Cancelling existing job...');
      await cancelBtn.click();
      await page.waitForTimeout(3000);
    }

    // Set large resources to ensure pending
    // Note: Input selectors may need adjustment based on UI structure
    console.log('Setting large resources (A100 GPU)...');

    // Select A100 GPU (will likely queue)
    const a100Btn = page.locator('button:has-text("A100")');
    if (await a100Btn.count() > 0 && await a100Btn.isVisible()) {
      await a100Btn.click();
      console.log('Selected A100 GPU');
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: '/tmp/pending-2-before-launch.png' });

    // Click Launch
    const launchBtn = page.locator('button.btn-primary:has-text("Launch")');
    if (await launchBtn.isVisible() && await launchBtn.isEnabled()) {
      console.log('Clicking Launch...');
      await launchBtn.click();

      let sawPendingModal = false;
      let sawSessionCard = false;

      // Monitor progress
      for (let i = 1; i <= 30; i++) {
        await page.waitForTimeout(500);
        await page.screenshot({ path: `/tmp/pending-${String(i).padStart(2, '0')}.png` });

        const loadingOverlay = page.locator('.loading-overlay');
        const sessionCard = page.locator('.session-card');
        const progressStep = page.locator('.progress-step');

        if (await loadingOverlay.count() > 0 && await loadingOverlay.isVisible()) {
          const stepText = await progressStep.textContent().catch(() => '');
          console.log(`Step ${i}: Modal - "${stepText}"`);

          if (stepText.toLowerCase().includes('queued') || stepText.toLowerCase().includes('pending')) {
            sawPendingModal = true;
            console.log('>>> Pending message shown in modal');
          }
        } else if (await sessionCard.count() > 0 && await sessionCard.isVisible()) {
          sawSessionCard = true;
          const cardText = await sessionCard.first().textContent().catch(() => '');
          console.log(`Step ${i}: Session card - "${cardText.substring(0, 80)}"`);

          // Check if estimated time is shown
          if (cardText.includes('Est:') || cardText.includes('in ')) {
            console.log('>>> Estimated start time displayed');
          } else if (cardText.includes('Waiting for start time')) {
            console.log('>>> Waiting for start time (poll not updated yet)');
          }
          break;
        }
      }

      // Summary
      console.log('\n--- Test Summary ---');
      console.log('Pending modal shown:', sawPendingModal ? 'YES' : 'NO');
      console.log('Session card appeared:', sawSessionCard ? 'YES' : 'NO');

    } else {
      console.log('Launch button not available');
    }

  } catch (error) {
    console.error('Test failed:', error.message);
    await page.screenshot({ path: '/tmp/pending-error.png' });
  } finally {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/pending-end.png' });
    await browser.close();
  }
})();
