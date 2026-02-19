/**
 * Shared helper functions for Playwright tests
 */

/**
 * Login to the manager UI
 */
async function login(page, username, password) {
  const loginForm = page.locator('input[type="password"]');
  if (await loginForm.count() === 0) {
    console.log('Already logged in');
    return true;
  }

  console.log('Logging in as', username);
  await page.fill('input[placeholder*="username" i]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(2000);

  // Check for errors
  const errorMsg = page.locator('.error-message, .login-error');
  if (await errorMsg.count() > 0 && await errorMsg.isVisible()) {
    const error = await errorMsg.textContent();
    throw new Error(`Login failed: ${error}`);
  }

  return true;
}

/**
 * Cancel any existing session
 */
async function cancelExistingSession(page) {
  const cancelBtn = page.locator('button.btn-cancel:has-text("Cancel")');
  if (await cancelBtn.count() > 0 && await cancelBtn.isVisible()) {
    console.log('Cancelling existing job...');
    await cancelBtn.click();
    await page.waitForTimeout(3000);
    return true;
  }
  return false;
}

/**
 * Wait for and monitor launch modal
 * Returns: 'running' | 'pending' | 'error' | 'timeout'
 */
async function monitorLaunchModal(page, maxSteps = 30) {
  for (let i = 1; i <= maxSteps; i++) {
    await page.waitForTimeout(500);

    const loadingOverlay = page.locator('.loading-overlay');
    const sessionCard = page.locator('.session-card');
    const progressStep = page.locator('.progress-step');
    const errorEl = page.locator('.progress-error');

    // Check for error
    if (await errorEl.count() > 0 && await errorEl.isVisible()) {
      const errorText = await errorEl.textContent().catch(() => 'Unknown error');
      console.log(`Step ${i}: Error - "${errorText}"`);
      return { status: 'error', message: errorText };
    }

    // Check for modal
    if (await loadingOverlay.count() > 0 && await loadingOverlay.isVisible()) {
      const stepText = await progressStep.textContent().catch(() => '');
      console.log(`Step ${i}: Modal - "${stepText}"`);

      if (stepText.toLowerCase().includes('queued') || stepText.toLowerCase().includes('pending')) {
        return { status: 'pending', step: i };
      }
    }

    // Check for session card (transitioned from modal)
    if (await sessionCard.count() > 0 && await sessionCard.isVisible()) {
      console.log(`Step ${i}: Session card appeared`);
      return { status: 'session-card', step: i };
    }

    // Check for redirect to IDE
    if (page.url().includes('/code/') || page.url().includes('/rstudio/')) {
      console.log(`Step ${i}: Redirected to IDE`);
      return { status: 'running', url: page.url() };
    }
  }

  return { status: 'timeout' };
}

/**
 * Select cluster (Gemini or Apollo)
 */
async function selectCluster(page, cluster) {
  const btn = page.locator(`button:has-text("${cluster}")`).first();
  if (await btn.count() > 0 && await btn.isVisible()) {
    await btn.click();
    await page.waitForTimeout(300);
    console.log(`Selected cluster: ${cluster}`);
    return true;
  }
  return false;
}

/**
 * Select IDE (VS Code, RStudio, JupyterLab)
 */
async function selectIde(page, ide) {
  const btn = page.locator(`.ide-tab:has-text("${ide}")`);
  if (await btn.count() > 0 && await btn.isVisible()) {
    await btn.click();
    await page.waitForTimeout(300);
    console.log(`Selected IDE: ${ide}`);
    return true;
  }
  return false;
}

/**
 * Select GPU type (CPU, A100, V100)
 */
async function selectGpu(page, gpuType) {
  const btn = page.locator(`button:has-text("${gpuType}")`);
  if (await btn.count() > 0 && await btn.isVisible()) {
    await btn.click();
    await page.waitForTimeout(300);
    console.log(`Selected GPU: ${gpuType}`);
    return true;
  }
  return false;
}

/**
 * Click launch button
 */
async function clickLaunch(page) {
  const launchBtn = page.locator('button.btn-primary:has-text("Launch")');
  if (await launchBtn.isVisible() && await launchBtn.isEnabled()) {
    await launchBtn.click();
    console.log('Clicked Launch');
    return true;
  }
  console.log('Launch button not available');
  return false;
}

module.exports = {
  login,
  cancelExistingSession,
  monitorLaunchModal,
  selectCluster,
  selectIde,
  selectGpu,
  clickLaunch,
};
