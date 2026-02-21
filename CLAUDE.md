# rbiocverse

Unified monorepo for R/Bioconductor HPC development environment.

## Repository Structure

```
rbiocverse/
├── container/          # Bioconductor Docker container for HPC
│   ├── Dockerfile
│   ├── scripts/        # Package migration, cluster config
│   └── rbiocverse/     # Package manifest (DESCRIPTION, pyproject.toml)
├── manager/            # Web-based session manager (Express + React)
│   ├── server.ts       # Main Express server
│   ├── config/         # Cluster and IDE configuration
│   ├── services/       # HPC, tunnel, notification services
│   ├── routes/         # API endpoints
│   ├── lib/            # Shared utilities
│   └── ui/             # React frontend
├── tools/              # Auxiliary tools
│   └── hpc-proxy/      # Go binary for multi-user port routing
├── docker-compose.yml  # Unified deployment
└── .github/workflows/  # CI/CD for both components
```

## HPC Cluster Access

SSH to clusters (ProxyJump configured in ~/.ssh/config):

```bash
ssh apollo.coh.org
ssh gemini-login1.coh.org
```

**Hostnames:**
- **Apollo**: `apollo.coh.org` or `ppxhpcacc01.coh.org`
- **Gemini**: `gemini-login1.coh.org` or `gemini-login2.coh.org`

## Container Paths

| Cluster | Container Path | R Library | Python Library |
|---------|---------------|-----------|----------------|
| Gemini  | `/packages/singularity/shared_cache/rbioc/rbiocverse_X.Y.sif` | `.../rlibs/bioc-X.Y` | `.../python/bioc-X.Y` |
| Apollo  | `/opt/singularity-images/rbioc/rbiocverse_X.Y.sif` | `.../rlibs/bioc-X.Y` | `.../python/bioc-X.Y` |

## Development

### Manager Dev Server

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

Run the full CI-equivalent check sequence from `manager/`:

```bash
cd manager
npm run typecheck              # backend types
(cd ui && npm run typecheck)   # frontend types
npm run lint                   # backend lint
(cd ui && npm run lint)        # frontend lint
(cd ui && npm run build)       # frontend build
npm test
```

> CI runs these steps in order (see `.github/workflows/test.yml`). Always run `typecheck` + `lint` + frontend `build` before pushing, not just `npm test`.

### Playwright Browser Tests

**USE THE PLAYWRIGHT SKILL** (`/playwright-skill`) for all browser automation.

**USE THE HELPER SCRIPTS** in `manager/scripts/playwright/`:
- `helpers.js` - Reusable functions: `login()`, `selectCluster()`, `selectIde()`, `clickLaunch()`, `monitorLaunchModal()`
- `login-test.js` - Example: login and verify
- `launch-quick.js` - Example: full launch flow
- `launch-pending.js` - Example: launch with queue monitoring

**Credentials** are in `manager/scripts/.env.dev` (gitignored). Load them before running tests.

**DO NOT hardcode credentials** - always read from env vars or `.env.dev`.

**Setup** (run once per worktree):
```bash
npm install playwright
npx playwright install chromium
```

**Example** using helpers:
```javascript
const { login, selectCluster, selectIde, clickLaunch } = require('./helpers');
// ...
await login(page, process.env.TEST_USERNAME, process.env.TEST_PASSWORD);
await selectCluster(page, 'Gemini');
await selectIde(page, 'VS Code');
await clickLaunch(page);
```

### Playwright Browser Tests

**USE THE PLAYWRIGHT SKILL** (`/playwright-skill`) for all browser automation.

**USE THE HELPER SCRIPTS** in `manager/scripts/playwright/`:
- `helpers.js` - Reusable functions: `login()`, `selectCluster()`, `selectIde()`, `clickLaunch()`, `monitorLaunchModal()`
- `login-test.js` - Example: login and verify
- `launch-quick.js` - Example: full launch flow
- `launch-pending.js` - Example: launch with queue monitoring

**Credentials** are in `manager/scripts/.env.dev` (gitignored). Load them before running tests.

**DO NOT hardcode credentials** - always read from env vars or `.env.dev`.

**Setup** (run once per worktree):
```bash
npm install playwright
npx playwright install chromium
```

**Example** using helpers:
```javascript
const { login, selectCluster, selectIde, clickLaunch } = require('./helpers');
// ...
await login(page, process.env.TEST_USERNAME, process.env.TEST_PASSWORD);
await selectCluster(page, 'Gemini');
await selectIde(page, 'VS Code');
await clickLaunch(page);
```
### Container Build

```bash
cd container
docker buildx build --platform linux/amd64 -t ghcr.io/drejom/rbiocverse:test .
docker run -it --rm ghcr.io/drejom/rbiocverse:test /bin/bash
```

## Coding Standards

### DRY (Don't Repeat Yourself)

- **Reuse existing functions** - Search codebase before writing new utilities
- **Single source of truth** - Types, constants, and logic should exist in one place
- **Extract common patterns** - If code appears twice, extract to shared module

### TypeScript

- **Strict mode enabled** - Backend uses `strict: true` in tsconfig.json
- **Types must match API schemas** - Frontend types should exactly mirror backend response shapes
- **Avoid `as` casts** - If you need a cast, the type is probably wrong. Use `instanceof` checks instead
- **Use proper property names** - Don't rename fields between layers (e.g., API returns `cpus`, frontend uses `cpus`)
- **Error handling** - Use `err instanceof Error ? { error: err.message, stack: err.stack } : { detail: String(err) }` pattern in catch blocks
- **Proxy handlers** - Handle both `http.ServerResponse` and `net.Socket` for WebSocket proxy errors
- **Import types explicitly** - Use `import type { KeyboardEvent } from 'react'` not `React.KeyboardEvent`
- **Validate external data** - Use `parseInt(x, 10)` with radix, check `Number.isFinite()` for parsed values
- **Validate localStorage** - Check stored values against allowed options before casting to union types

### API/Frontend Alignment

- **Property names match** - If backend returns `{ cpus, memory, nodes }`, frontend type uses same names
- **Check API responses** - Use Playwright or browser DevTools to verify actual response structure
- **Update types when API changes** - Types in `ui/src/types/` must stay in sync with backend

### Testing Changes

1. **Type check**: `npm run typecheck` (backend) and `cd manager/ui && npm run typecheck` (frontend)
2. **Rebuild frontend**: `cd manager/ui && npm run build` (vite doesn't type-check, only transpiles)
3. **Restart server**: `./scripts/dev.sh restart`
4. **Verify visually**: Use Playwright or manual browser testing

### UI Patterns

- **Theme-specific assets** - Use `-dark.svg`/`-light.svg` suffixes with `.logo-dark`/`.logo-light` CSS classes toggled by `:root.light-theme`
- **Accessible toggles** - Use `aria-expanded`, `aria-controls`, and action-oriented `aria-label` (e.g., "Change theme (currently System)")
- **Scoped DOM IDs** - When generating IDs dynamically, include a unique key (e.g., `toc-${contentKey}-heading-${index}`) to avoid collisions
- **Draggable images** - Add `draggable="false"` to `<img>` in draggable containers to prevent browser drag ghost

## Deployment

### Images

- `ghcr.io/drejom/rbiocverse` - Bioconductor container for HPC
- `ghcr.io/drejom/rbiocverse-manager` - Web session manager

### Environment Files

| File | Use Case |
|------|----------|
| `.env.dokploy.example` | Dokploy/TrueNAS (double jump host SSH) |
| `.env.cgt.example` | cgt.coh.org work VM (direct HPC access) |

## CI/CD Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `test.yml` | Push to main/dev, PR | Run manager tests |
| `build-container.yml` | Tag push (v*), container changes | Build Bioconductor container |
| `build-manager.yml` | Push to main, manager changes | Build manager container |
| `release.yml` | Manual dispatch | Coordinated release (both images) |

## Key Files

### Manager
- `manager/config/index.ts` - Cluster definitions, IDE config, resource limits
- `manager/services/hpc.ts` - SLURM commands, job submission
- `manager/services/tunnel.ts` - SSH tunnel management
- `manager/lib/state.ts` - Session state management
- `manager/routes/api.ts` - REST API endpoints
- `manager/routes/auth.ts` - Authentication endpoints

### Container
- `container/Dockerfile` - Main container build
- `container/rbiocverse/DESCRIPTION` - R package manifest
- `container/rbiocverse/pyproject.toml` - Python package manifest
- `container/scripts/pull-container.sh` - Deploy to HPC clusters
- `container/scripts/install-packages.sh` - Install R packages via SLURM
