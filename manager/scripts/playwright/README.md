# Playwright Test Scripts

Manual browser automation scripts for testing the rbiocverse manager UI.

## Prerequisites

```bash
# Install Playwright (one-time setup)
npm install playwright
npx playwright install chromium
```

## Usage

```bash
# Run a script
node scripts/playwright/login-test.js
node scripts/playwright/launch-quick.js
node scripts/playwright/launch-pending.js
```

## Scripts

| Script | Description |
|--------|-------------|
| `login-test.js` | Test login flow |
| `launch-quick.js` | Launch VS Code with defaults (quick start) |
| `launch-pending.js` | Launch with large resources to test pending flow |

## Configuration

Set environment variables before running (credentials are required; scripts will fail fast if missing):

```bash
export TEST_USERNAME=youruser
export TEST_PASSWORD=yourpass
export TEST_URL=http://localhost:3000   # optional, defaults to http://localhost:3000
```

Or source from the dev env file:

```bash
source manager/scripts/.env.dev
```

## Tips

- Scripts use `headless: false` by default for visual debugging
- Use `slowMo: 50` to slow down actions for visibility
- Screenshots are saved to `/tmp/` for review
