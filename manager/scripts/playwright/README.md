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

Edit the constants at the top of each script:
- `TARGET_URL` - Manager URL (default: http://localhost:3000)
- `USERNAME` / `PASSWORD` - Test credentials

## Tips

- Scripts use `headless: false` by default for visual debugging
- Use `slowMo: 50` to slow down actions for visibility
- Screenshots are saved to `/tmp/` for review
