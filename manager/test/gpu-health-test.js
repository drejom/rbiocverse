/**
 * Test GPU queue health indicator responsiveness
 */
const puppeteer = require('puppeteer');

const TARGET_URL = 'http://localhost:3000';

async function testGpuHealthIndicators() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  console.log(`Navigating to ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.cluster-card', { timeout: 15000 });
  console.log('Page loaded\n');

  // Helper to get health bar tooltips for Gemini (first cluster)
  async function getGeminiHealthData() {
    return page.evaluate(() => {
      // Get first cluster card (Gemini)
      const geminiCard = document.querySelector('.cluster-card');
      if (!geminiCard) return [];
      const indicators = geminiCard.querySelectorAll('.health-indicator');
      return Array.from(indicators).map(ind => ind.getAttribute('title'));
    });
  }

  // Helper to click GPU button by text
  async function clickGpuButton(text) {
    const clicked = await page.evaluate((btnText) => {
      const buttons = document.querySelectorAll('.gpu-btn');
      for (const btn of buttons) {
        if (btn.textContent.trim().includes(btnText)) {
          btn.click();
          return true;
        }
      }
      return false;
    }, text);
    if (clicked) {
      await new Promise(r => setTimeout(r, 300));
    }
    return clicked;
  }

  // Get initial state (no GPU selected)
  console.log('=== Initial State (CPU mode) ===');
  let healthData = await getGeminiHealthData();
  healthData.forEach(h => console.log(`  ${h}`));
  await page.screenshot({ path: 'test/screenshot-health-cpu.png' });

  // Click A100
  console.log('\n=== Clicking A100 ===');
  if (await clickGpuButton('A100')) {
    healthData = await getGeminiHealthData();
    healthData.forEach(h => console.log(`  ${h}`));
    await page.screenshot({ path: 'test/screenshot-health-a100.png' });
  } else {
    console.log('A100 button not found');
  }

  // Click V100
  console.log('\n=== Clicking V100 ===');
  if (await clickGpuButton('V100')) {
    healthData = await getGeminiHealthData();
    healthData.forEach(h => console.log(`  ${h}`));
    await page.screenshot({ path: 'test/screenshot-health-v100.png' });
  } else {
    console.log('V100 button not found');
  }

  // Click back to CPU
  console.log('\n=== Clicking CPU (back to default) ===');
  if (await clickGpuButton('CPU')) {
    healthData = await getGeminiHealthData();
    healthData.forEach(h => console.log(`  ${h}`));
  }

  // Check API response for partition data
  console.log('\n=== API Partition Data ===');
  const apiData = await page.evaluate(async () => {
    const res = await fetch('/api/cluster-status');
    const data = await res.json();
    const health = data.clusterHealth?.gemini?.current;
    return {
      clusterCpus: health?.cpus,
      partitions: health?.partitions,
      gpus: health?.gpus
    };
  });
  console.log(JSON.stringify(apiData, null, 2));

  console.log('\nScreenshots saved. Keeping browser open for 10 seconds...');
  await new Promise(r => setTimeout(r, 10000));

  await browser.close();
}

testGpuHealthIndicators().catch(console.error);
