/**
 * E2E Tests for HPC Code Server Launcher
 * Tests full user journeys via headless browser
 */

const puppeteer = require('puppeteer');
const { expect } = require('chai');

// Test against live deployment or local
const BASE_URL = process.env.E2E_BASE_URL || 'https://hpc.omeally.com';

// Use system Chrome if available (bundled Chromium has network sandbox issues on macOS)
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('E2E: Launcher Page', function() {
  this.timeout(30000); // Allow 30s for browser tests

  let browser;
  let page;

  before(async () => {
    const launchOptions = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };

    // Use system Chrome if path exists
    try {
      require('fs').accessSync(CHROME_PATH);
      launchOptions.executablePath = CHROME_PATH;
    } catch (e) {
      // Fall back to bundled Chromium
    }

    browser = await puppeteer.launch(launchOptions);
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
  });

  afterEach(async () => {
    if (page) {
      await page.close();
    }
  });

  describe('Page Load', () => {
    it('should load the launcher page', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      const title = await page.title();
      expect(title).to.equal('HPC Code Server');
    });

    it('should display both cluster cards', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      const geminiCard = await page.$('#gemini-card');
      const apolloCard = await page.$('#apollo-card');

      expect(geminiCard).to.not.be.null;
      expect(apolloCard).to.not.be.null;
    });

    it('should show cache indicator with refresh button', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      // Wait for cache indicator to be populated (not just exist)
      await page.waitForFunction(
        () => {
          const indicator = document.querySelector('#cache-indicator');
          return indicator && indicator.textContent.includes('Updated');
        },
        { timeout: 15000 }
      );

      const cacheText = await page.$eval('#cache-indicator', el => el.textContent);
      expect(cacheText).to.include('Updated');
    });

    it('should display cluster status after loading', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      // Wait for status to load (not "Loading...")
      await page.waitForFunction(
        () => {
          const geminiStatus = document.querySelector('#gemini-status-text');
          return geminiStatus && !geminiStatus.textContent.includes('Loading');
        },
        { timeout: 15000 }
      );

      const geminiStatus = await page.$eval('#gemini-status-text', el => el.textContent);
      expect(['Running', 'No session', 'Pending']).to.include(geminiStatus);
    });
  });

  describe('Cluster Card States', () => {
    it('should show launch form for idle clusters', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      // Wait for status to load
      await page.waitForFunction(
        () => !document.querySelector('#gemini-status-text')?.textContent.includes('Loading'),
        { timeout: 15000 }
      );

      // Check if either cluster is idle and has launch form
      const hasLaunchForm = await page.evaluate(() => {
        const geminiContent = document.querySelector('#gemini-content');
        const apolloContent = document.querySelector('#apollo-content');
        return (
          geminiContent?.querySelector('.launch-form') !== null ||
          apolloContent?.querySelector('.launch-form') !== null ||
          geminiContent?.querySelector('.btn-success') !== null ||
          apolloContent?.querySelector('.btn-success') !== null
        );
      });

      // At least one cluster should have either a launch form (idle) or connect button (running)
      expect(hasLaunchForm).to.be.true;
    });

    it('should show connect button for running clusters', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      await page.waitForFunction(
        () => !document.querySelector('#gemini-status-text')?.textContent.includes('Loading'),
        { timeout: 15000 }
      );

      // Check if any running cluster has connect button
      const hasConnectButton = await page.evaluate(() => {
        const buttons = document.querySelectorAll('.btn-success');
        return Array.from(buttons).some(btn => btn.textContent.includes('Connect'));
      });

      // Check status - if running, should have connect button
      const geminiStatus = await page.$eval('#gemini-status-text', el => el.textContent);
      const apolloStatus = await page.$eval('#apollo-status-text', el => el.textContent);

      if (geminiStatus === 'Running' || apolloStatus === 'Running') {
        expect(hasConnectButton).to.be.true;
      }
    });

    it('should display time remaining pie chart for running jobs', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      await page.waitForFunction(
        () => !document.querySelector('#gemini-status-text')?.textContent.includes('Loading'),
        { timeout: 15000 }
      );

      const geminiStatus = await page.$eval('#gemini-status-text', el => el.textContent);
      const apolloStatus = await page.$eval('#apollo-status-text', el => el.textContent);

      if (geminiStatus === 'Running' || apolloStatus === 'Running') {
        const hasPieChart = await page.evaluate(() => {
          return document.querySelector('.time-pie') !== null;
        });
        expect(hasPieChart).to.be.true;
      }
    });
  });

  describe('Cache Refresh', () => {
    it('should refresh status when clicking refresh button', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      // Wait for initial load
      await page.waitForSelector('#cache-indicator', { timeout: 10000 });
      await page.waitForFunction(
        () => document.querySelector('#refresh-btn') !== null,
        { timeout: 10000 }
      );

      // Get initial cache age text
      const initialText = await page.$eval('#cache-indicator', el => el.textContent);

      // Click refresh
      await page.click('#refresh-btn');

      // Wait for refresh to complete (button stops spinning)
      await page.waitForFunction(
        () => !document.querySelector('#refresh-btn')?.classList.contains('spinning'),
        { timeout: 10000 }
      );

      // Cache should show fresh data
      const newText = await page.$eval('#cache-indicator', el => el.textContent);
      expect(newText).to.include('Updated');
    });
  });

  describe('API Endpoints', () => {
    it('should return health check', async () => {
      const response = await page.goto(`${BASE_URL}/api/health`, {
        waitUntil: 'networkidle2',
      });

      expect(response.status()).to.equal(200);

      const body = await response.json();
      expect(body.status).to.equal('ok');
    });

    it('should return cluster status', async () => {
      const response = await page.goto(`${BASE_URL}/api/cluster-status`, {
        waitUntil: 'networkidle2',
      });

      expect(response.status()).to.equal(200);

      const body = await response.json();
      expect(body).to.have.property('gemini');
      expect(body).to.have.property('apollo');
      expect(body.gemini).to.have.property('status');
      expect(body.apollo).to.have.property('status');
    });

    it('should include cache metadata in cluster status', async () => {
      const response = await page.goto(`${BASE_URL}/api/cluster-status`, {
        waitUntil: 'networkidle2',
      });

      const body = await response.json();
      expect(body).to.have.property('cacheTtl');
      expect(body).to.have.property('updatedAt');
    });
  });

  describe('Responsive Design', () => {
    it('should render correctly on mobile viewport', async () => {
      await page.setViewport({ width: 375, height: 667 }); // iPhone SE
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      const launcher = await page.$('.launcher');
      expect(launcher).to.not.be.null;

      // Cards should still be visible
      const geminiCard = await page.$('#gemini-card');
      expect(geminiCard).to.not.be.null;
    });

    it('should render correctly on tablet viewport', async () => {
      await page.setViewport({ width: 768, height: 1024 }); // iPad
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

      const launcher = await page.$('.launcher');
      expect(launcher).to.not.be.null;
    });
  });
});

describe('E2E: VS Code Session (requires running job)', function() {
  this.timeout(60000); // Allow 60s for session tests

  let browser;
  let page;

  before(async () => {
    const launchOptions = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };

    // Use system Chrome if path exists
    try {
      require('fs').accessSync(CHROME_PATH);
      launchOptions.executablePath = CHROME_PATH;
    } catch (e) {
      // Fall back to bundled Chromium
    }

    browser = await puppeteer.launch(launchOptions);
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
  });

  afterEach(async () => {
    if (page) {
      await page.close();
    }
  });

  it('should redirect to /code/ when session is active and connect is clicked', async function() {
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

    // Wait for status
    await page.waitForFunction(
      () => !document.querySelector('#gemini-status-text')?.textContent.includes('Loading'),
      { timeout: 15000 }
    );

    // Check if any session is running
    const hasRunningSession = await page.evaluate(() => {
      const gemini = document.querySelector('#gemini-status-text')?.textContent;
      const apollo = document.querySelector('#apollo-status-text')?.textContent;
      return gemini === 'Running' || apollo === 'Running';
    });

    if (!hasRunningSession) {
      this.skip(); // Skip if no running session
      return;
    }

    // Click connect button
    const connectButton = await page.$('.btn-success');
    if (connectButton) {
      // Set up navigation promise before clicking
      const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

      await connectButton.click();

      await navigationPromise;

      // Should be at /code/ path
      expect(page.url()).to.include('/code/');
    }
  });

  it('should load VS Code wrapper page at /code/', async function() {
    // First check if session is running via API
    const statusResponse = await page.goto(`${BASE_URL}/api/cluster-status`, {
      waitUntil: 'networkidle2',
    });
    const status = await statusResponse.json();

    const hasRunningSession = status.gemini?.status === 'running' || status.apollo?.status === 'running';

    if (!hasRunningSession) {
      this.skip();
      return;
    }

    await page.goto(`${BASE_URL}/code/`, { waitUntil: 'networkidle2' });

    // Should have VS Code iframe or redirect
    const hasIframe = await page.evaluate(() => {
      return document.querySelector('iframe') !== null;
    });

    // Either has iframe or shows error page
    const pageContent = await page.content();
    const hasVscodeContent = hasIframe || pageContent.includes('vscode') || pageContent.includes('VS Code');

    expect(hasVscodeContent).to.be.true;
  });
});
