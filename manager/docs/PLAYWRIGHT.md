# PLAYWRIGHT

Browser automation bypassing CrowdStrike via Docker container.

## Setup

```bash
# Create wrapper script
cat > ~/bin/playwright << 'EOF'
#!/bin/bash
IMAGE="mcr.microsoft.com/playwright:v1.57.0-jammy"
exec docker run --rm \
  -v "${PWD}:/work" \
  -w /work \
  --network host \
  "${IMAGE}" \
  npx playwright "$@"
EOF
chmod +x ~/bin/playwright

# Add to PATH
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Usage

```bash
# Version check
playwright --version

# Interactive codegen
playwright codegen https://example.com

# Run test files
playwright test test/my-test.spec.js
```

## Writing Tests

Test files use ES module syntax:

```javascript
// test/example.spec.js
import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('http://localhost:3000');
  await page.waitForSelector('.my-element');

  const data = await page.evaluate(() => {
    return document.body.innerText;
  });
  console.log(data);

  await page.screenshot({ path: 'test/screenshot.png' });
  await browser.close();
}

run().catch(console.error);
```

## Running with Node

For standalone scripts that need playwright installed:

```bash
docker run --rm \
  -v "${PWD}:/work" \
  -w /work \
  --network host \
  mcr.microsoft.com/playwright:v1.57.0-jammy \
  bash -c "npm install --no-save playwright && node test/my-test.spec.js"
```

## Network Access

The `--network host` flag allows the container to access:
- `localhost` services on your machine
- Local network hosts (e.g., `test-hpc.omeally.com`)
- External URLs

## Screenshots

Screenshots save to the mounted `/work` directory (your project root):

```javascript
await page.screenshot({ path: 'test/screenshot.png', fullPage: true });
```

## Debugging

Add waits and console logs to debug issues:

```javascript
// Wait for network to settle
await page.goto(url, { waitUntil: 'networkidle' });

// Check page content
const html = await page.content();
console.log(html.substring(0, 1000));

// Evaluate in browser context
const state = await page.evaluate(() => ({
  title: document.title,
  text: document.body.innerText.substring(0, 500)
}));
console.log(state);
```
