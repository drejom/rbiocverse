# HPC Code Server Stack

## HPC Cluster Access

SSH to clusters (ProxyJump configured in ~/.ssh/config):

```bash
ssh apollo.coh.org
ssh gemini-login1.coh.org
```

Hostnames:
- **Apollo**: `apollo.coh.org`
- **Gemini**: `gemini-login1.coh.org`

## Development

### Dev Server

Use `dev.sh` to manage the development server:

```bash
cd manager
./scripts/dev.sh start    # Start server (http://localhost:3000)
./scripts/dev.sh stop     # Stop server
./scripts/dev.sh restart  # Restart (use after code changes)
./scripts/dev.sh status   # Check if running
./scripts/dev.sh logs     # Tail server logs
```

Configure via `manager/scripts/.env.dev`:
```bash
TEST_USERNAME=domeally
TEST_PASSWORD=yourpassword
ADMIN_USER=domeally
```

### Frontend Build

```bash
cd manager/ui
npm install     # Install dependencies (first time)
npm run build   # Production build (catches type errors)
npm run dev     # Vite dev server with HMR
```

### Tests

```bash
cd manager
npm test
npm run test:coverage
```

## Coding Standards

### DRY (Don't Repeat Yourself)

- **Reuse existing functions** - Search codebase before writing new utilities
- **Single source of truth** - Types, constants, and logic should exist in one place
- **Extract common patterns** - If code appears twice, extract to shared module

### TypeScript

- **Types must match API schemas** - Frontend types should exactly mirror backend response shapes
- **Avoid `as` casts** - If you need a cast, the type is probably wrong
- **Use proper property names** - Don't rename fields between layers (e.g., API returns `cpus`, frontend uses `cpus`)

### API/Frontend Alignment

- **Property names match** - If backend returns `{ cpus, memory, nodes }`, frontend type uses same names
- **Check API responses** - Use Playwright or browser DevTools to verify actual response structure
- **Update types when API changes** - Types in `ui/src/types/` must stay in sync with backend

### Testing Changes

1. **Rebuild frontend**: `cd manager/ui && npm run build` (catches type errors)
2. **Restart server**: `./scripts/dev.sh restart`
3. **Verify visually**: Use Playwright or manual browser testing

## Deployment

- **Dev**: Push to `dev` branch, Dokploy auto-deploys via webhook
- **Production**: Use GitHub Actions "Release to Production" workflow
