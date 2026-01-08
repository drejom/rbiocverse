/**
 * GPU Selector Layout Test
 * Verifies GPU icon rendering and layout stability when clicking GPU buttons
 */

const puppeteer = require('puppeteer');

async function testGpuSelector() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1024 });

  try {
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

    // Wait for cluster status to load (give API time to respond)
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Wait for cluster cards to load
    await page.waitForSelector('.cluster-card', { timeout: 10000 });

    // Click on Gemini cluster card to expand it and show the launch form
    console.log('Clicking Gemini cluster to expand...');
    const clusterCards = await page.$$('.cluster-card');
    console.log(`Found ${clusterCards.length} cluster cards`);
    if (clusterCards.length > 0) {
      await clusterCards[0].click();
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Debug: Check what's in the DOM
    const debugInfo = await page.evaluate(() => {
      const cards = document.querySelectorAll('.cluster-card');
      const gpuToggle = document.querySelector('.gpu-toggle');
      const gpuSelector = document.querySelector('.gpu-selector');
      const gpuButtons = document.querySelectorAll('.gpu-btn');
      return {
        cardCount: cards.length,
        hasGpuToggle: !!gpuToggle,
        hasGpuSelector: !!gpuSelector,
        gpuButtonCount: gpuButtons.length,
        gpuToggleId: gpuToggle ? gpuToggle.id : 'no id',
        gpuSelectorHTML: gpuSelector ? gpuSelector.outerHTML.substring(0, 300) : 'not found'
      };
    });
    console.log('DOM Debug:', debugInfo);

    // Take initial screenshot
    await page.screenshot({ path: 'test/screenshot-initial.png', fullPage: true });
    console.log('Screenshot 1: Initial state');

    // Check if GPU selector exists (use class selector, not ID)
    const gpuToggle = await page.$('.gpu-toggle');
    if (gpuToggle) {
      console.log('GPU selector found');

      // Get initial cluster card and GPU toggle dimensions
      const initialDims = await page.evaluate(() => {
        const card = document.querySelector('.cluster-card');
        const toggle = document.querySelector('.gpu-toggle');
        const launcher = document.querySelector('.launcher');
        return {
          cardHeight: card ? card.offsetHeight : 0,
          cardWidth: card ? card.offsetWidth : 0,
          toggleWidth: toggle ? toggle.offsetWidth : 0,
          toggleHeight: toggle ? toggle.offsetHeight : 0,
          launcherWidth: launcher ? launcher.offsetWidth : 0,
          cardComputedWidth: card ? window.getComputedStyle(card).width : 0,
        };
      });
      console.log('Initial dimensions:', initialDims);

      // Debug: check data-gpu values
      const gpuDataValues = await page.evaluate(() => {
        const btns = document.querySelectorAll('.gpu-btn');
        return Array.from(btns).map(b => ({
          dataGpu: b.getAttribute('data-gpu'),
          text: b.textContent.trim(),
          classes: b.className
        }));
      });
      console.log('GPU button data values:', gpuDataValues);

      // Click first button (CPU)
      await page.click('.gpu-btn:first-child');
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.screenshot({ path: 'test/screenshot-cpu-selected.png', fullPage: true });
      console.log('Screenshot 2: CPU selected');

      const dims1 = await page.evaluate(() => ({
        cardHeight: document.querySelector('.cluster-card').offsetHeight,
        cardWidth: document.querySelector('.cluster-card').offsetWidth,
        toggleWidth: document.querySelector('.gpu-toggle').offsetWidth,
        toggleHeight: document.querySelector('.gpu-toggle').offsetHeight
      }));
      console.log('After CPU click:', dims1);

      // Click A100 button (second button)
      await page.click('.gpu-btn:nth-child(2)');
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.screenshot({ path: 'test/screenshot-a100-selected.png', fullPage: true });
      console.log('Screenshot 3: A100 selected');

      const dims2 = await page.evaluate(() => ({
        cardHeight: document.querySelector('.cluster-card').offsetHeight,
        cardWidth: document.querySelector('.cluster-card').offsetWidth,
        toggleWidth: document.querySelector('.gpu-toggle').offsetWidth,
        toggleHeight: document.querySelector('.gpu-toggle').offsetHeight
      }));
      console.log('After A100 click:', dims2);

      // Click V100 button (third button)
      await page.click('.gpu-btn:nth-child(3)');
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.screenshot({ path: 'test/screenshot-v100-selected.png', fullPage: true });
      console.log('Screenshot 4: V100 selected');

      const dims3 = await page.evaluate(() => {
        const card = document.querySelector('.cluster-card');
        const launcher = document.querySelector('.launcher');
        const body = document.body;

        return {
          cardWidth: card.offsetWidth,
          launcherWidth: launcher.offsetWidth,
          launcherScrollWidth: launcher.scrollWidth,
          bodyWidth: body.offsetWidth,
          bodyScrollWidth: body.scrollWidth,
          viewportWidth: window.innerWidth,
          launcherComputedWidth: getComputedStyle(launcher).width,
          launcherComputedMaxWidth: getComputedStyle(launcher).maxWidth,
        };
      });
      console.log('After V100 click:', dims3);

      // Check if dimensions changed significantly (more than 2px tolerance)
      const tolerance = 2;
      const heightChanged = Math.abs(dims1.cardHeight - initialDims.cardHeight) > tolerance ||
                           Math.abs(dims2.cardHeight - initialDims.cardHeight) > tolerance ||
                           Math.abs(dims3.cardHeight - initialDims.cardHeight) > tolerance;

      const widthChanged = Math.abs(dims1.cardWidth - initialDims.cardWidth) > tolerance ||
                          Math.abs(dims2.cardWidth - initialDims.cardWidth) > tolerance ||
                          Math.abs(dims3.cardWidth - initialDims.cardWidth) > tolerance;

      const toggleWidthChanged = Math.abs(dims1.toggleWidth - initialDims.toggleWidth) > tolerance ||
                                Math.abs(dims2.toggleWidth - initialDims.toggleWidth) > tolerance ||
                                Math.abs(dims3.toggleWidth - initialDims.toggleWidth) > tolerance;

      const toggleHeightChanged = Math.abs(dims1.toggleHeight - initialDims.toggleHeight) > tolerance ||
                                 Math.abs(dims2.toggleHeight - initialDims.toggleHeight) > tolerance ||
                                 Math.abs(dims3.toggleHeight - initialDims.toggleHeight) > tolerance;

      if (heightChanged) {
        console.error('ERROR: Cluster card HEIGHT changed when clicking GPU buttons!');
      } else {
        console.log('SUCCESS: Cluster card height remained stable');
      }

      if (widthChanged) {
        console.error('ERROR: Cluster card WIDTH changed when clicking GPU buttons!');
      } else {
        console.log('SUCCESS: Cluster card width remained stable');
      }

      if (toggleWidthChanged) {
        console.error('ERROR: GPU toggle WIDTH changed when clicking buttons!');
      } else {
        console.log('SUCCESS: GPU toggle width remained stable');
      }

      if (toggleHeightChanged) {
        console.error('ERROR: GPU toggle HEIGHT changed when clicking buttons!');
      } else {
        console.log('SUCCESS: GPU toggle height remained stable');
      }

      // Check GPU icon rendering in buttons
      const gpuIconCount = await page.evaluate(() => {
        return document.querySelectorAll('.gpu-btn svg').length;
      });
      console.log('GPU icons in buttons:', gpuIconCount);
      if (gpuIconCount === 0) {
        console.error('ERROR: No SVG icons rendered in GPU selector buttons');
      } else {
        console.log('SUCCESS: GPU icons are rendering');
      }

      // Check cluster health GPU icon
      const healthGpuIconCount = await page.evaluate(() => {
        return document.querySelectorAll('.health-indicator svg').length;
      });
      console.log('Health indicator SVG icons:', healthGpuIconCount);

    } else {
      console.log('GPU selector not visible (cluster may not support GPU)');
    }

    // Keep browser open for 10 seconds for inspection
    console.log('Keeping browser open for inspection...');
    await new Promise(resolve => setTimeout(resolve, 10000));

  } catch (error) {
    console.error('Test error:', error);
  } finally {
    await browser.close();
  }
}

testGpuSelector();
