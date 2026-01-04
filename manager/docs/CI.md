# CI/CD Setup

## GitHub Actions

Tests run automatically on push/PR to `main` and `dev` branches.

### Workflow: `.github/workflows/test.yml`

- Runs `npm test` and `npm run test:coverage`
- Extracts coverage percentage from Jest output
- Updates coverage badge via gist on main/dev pushes

## Coverage Badge Setup

The coverage badge uses [shields.io dynamic badges](https://shields.io/endpoint) with a GitHub gist for storage. No paid service required.

### Required Secrets/Variables

Add these in GitHub repo Settings → Secrets and variables → Actions:

**Secret: `GIST_TOKEN`**
1. Go to https://github.com/settings/tokens
2. Generate new token (classic) with `gist` scope only
3. Add as repository secret named `GIST_TOKEN`

**Variable: `COVERAGE_GIST_ID`**
1. Go to Variables tab
2. Add: `COVERAGE_GIST_ID` = `5309bba1b50ac79e6b1744fd0ccfd20d`

### How It Works

1. Jest generates `coverage/coverage-summary.json`
2. Workflow extracts `total.lines.pct` percentage
3. [dynamic-badges-action](https://github.com/schneegans/dynamic-badges-action) updates gist
4. shields.io reads gist and renders badge

### Badge Colors

| Coverage | Color |
|----------|-------|
| ≥ 80% | Green |
| ≥ 60% | Yellow |
| < 60% | Red |

### Manual Badge Update

If needed, update the gist directly:

```bash
gh gist edit 5309bba1b50ac79e6b1744fd0ccfd20d
```

Content format:
```json
{"schemaVersion":1,"label":"coverage","message":"75%","color":"yellow"}
```
