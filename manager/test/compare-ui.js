/**
 * Compare UI between dev site and local React build
 */
const puppeteer = require('puppeteer');
const path = require('path');

// Test configuration
const NAVIGATION_TIMEOUT_MS = 30000;
const SELECTOR_TIMEOUT_MS = 10000;
const VIEWPORT = { width: 1280, height: 900 };

// CSS to disable all animations for consistent screenshots
const DISABLE_ANIMATIONS_CSS = '*, *::before, *::after { transition: none !important; animation: none !important; }';

async function captureScreenshots() {
  const browser = await puppeteer.launch({ headless: true });

  // Capture dev site (current production)
  console.log('Capturing dev site...');
  const devPage = await browser.newPage();
  await devPage.setViewport(VIEWPORT);
  await devPage.goto('https://test-hpc.omeally.com/?menu=1', { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS });
  await devPage.waitForSelector('.cluster-card', { timeout: SELECTOR_TIMEOUT_MS });
  await devPage.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
  await devPage.screenshot({ path: path.join(__dirname, 'screenshot-dev.png'), fullPage: true });
  console.log('Dev site screenshot saved: test/screenshot-dev.png');

  // Capture local React build
  console.log('Capturing local React build...');
  const localPage = await browser.newPage();
  await localPage.setViewport(VIEWPORT);
  await localPage.goto('http://localhost:3000/?menu=1', { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS });
  await localPage.waitForSelector('.cluster-card', { timeout: SELECTOR_TIMEOUT_MS });
  await localPage.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
  await localPage.screenshot({ path: path.join(__dirname, 'screenshot-local.png'), fullPage: true });
  console.log('Local React screenshot saved: test/screenshot-local.png');

  await browser.close();
  console.log('Done! Compare the screenshots in test/ directory');
}

captureScreenshots().catch(console.error);
