# rbiocverse Manager - Architecture

## Overview

The rbiocverse Manager is a web application that provides browser-based IDE experiences (VS Code, RStudio, JupyterLab) on HPC SLURM clusters. It manages job submission, SSH tunneling, and proxies requests to IDEs running in Singularity containers on compute nodes.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Browser                                 │
│  ┌─────────────┐  ┌──────────────────────────────────────────────┐  │
│  │  Launcher   │  │     IDE (iframe) - VS Code / RStudio / Jupyter│  │
│  │    (React)  │  │  /code/ │ /rstudio/ │ /jupyter/ → proxy      │  │
│  └─────────────┘  └──────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ HTTPS
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    rbiocverse Manager                                │
│                      (Express.js on Dokploy)                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  server.ts - Main orchestration                               │   │
│  │    ├── Static files (public/, ui/dist/)                       │   │
│  │    ├── API routes (/api/*)                                    │   │
│  │    └── HTTP Proxy (VS Code :8000, RStudio :8787, Jupyter :8888│   │
│  │                     hpc-proxy :9000)                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────┐   │
│  │ HpcService │ │TunnelService│ │StateManager│ │   Validation   │   │
│  │(SLURM ops) │ │ (SSH tunnels)│ │(sub-modules)│ │   (security)   │   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────────┘   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ SSH Tunnel (IDE port via hpc-proxy)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    HPC Login Node                                    │
│                 (gemini-login2 / ppxhpcacc01)                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SSH tunnel: localhost:9000 → compute-node:<hpc-proxy-port>  │   │
│  │  hpc-proxy routes /port/:port/* to localhost:<port> on node  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SLURM Compute Node                                │
│                     (e.g., g-h-1-9-25)                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Singularity Container (rbiocverse_X.XX.sif)                 │   │
│  │    ├── VS Code: code serve-web on dynamic port (~8000)       │   │
│  │    ├── RStudio: rserver on dynamic port (~8787)              │   │
│  │    ├── JupyterLab: jupyter lab on dynamic port (~8888)       │   │
│  │    └── hpc-proxy: Go binary routing /port/:port/* requests   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Supported IDEs

| IDE | Default Port | Proxy Path | Bioc 3.22 | Bioc 3.19 | Bioc 3.18 | Bioc 3.17 |
|-----|-------------|------------|-----------|-----------|-----------|-----------|
| VS Code | 8000 | `/code/` | ✓ | ✓ | ✓ | ✓ |
| RStudio | 8787 | `/rstudio/` | ✓ | ✓ | ✓ | ✓ |
| JupyterLab | 8888 | `/jupyter/` | ✓ | — | — | — |

Ports are dynamically discovered — the job script finds a free port and writes it to `~/.<ide>-slurm/port`, which the manager reads via SSH after node assignment.

## Directory Structure

```
manager/
├── server.ts              # Main Express server + IDE proxies
├── config/
│   └── index.ts           # Cluster, IDE, GPU and release configuration
├── lib/
│   ├── validation.ts      # Security-critical input validation
│   ├── helpers.ts         # Time parsing and formatting utilities
│   ├── state.ts           # StateManager orchestrator (thin, delegates to sub-modules)
│   ├── state/
│   │   ├── types.ts       # Shared types, constants, and utility functions
│   │   ├── index.ts       # Barrel re-export
│   │   ├── locking.ts     # LockManager - operation mutex
│   │   ├── sessions.ts    # SessionManager - in-memory session CRUD
│   │   ├── jobPolling.ts  # JobPoller - adaptive SLURM job polling loop
│   │   └── clusterHealth.ts # ClusterHealthPoller - fixed-interval health polling
│   ├── db.ts              # SQLite initialization and connection
│   ├── db/
│   │   ├── users.ts       # User account CRUD
│   │   ├── sessions.ts    # Active session write-through and archiving
│   │   ├── health.ts      # Cluster health snapshots and cache
│   │   ├── analytics.ts   # Analytics queries (usage, growth, queue wait)
│   │   ├── partitions.ts  # Partition limits CRUD
│   │   └── migrate.ts     # JSON → SQLite migration
│   ├── errors.ts          # Custom error classes and helpers
│   ├── logger.ts          # Winston structured logging with domain prefixes
│   └── asyncHandler.ts    # Express async route error wrapper
├── services/
│   ├── hpc.ts             # HpcService - SLURM operations via SSH
│   ├── tunnel.ts          # TunnelService - SSH tunnel management
│   └── notifications.ts   # Email/notification service
├── routes/
│   ├── api/
│   │   ├── index.ts       # Combined API router factory
│   │   ├── helpers.ts     # Shared helpers, interfaces, singletons
│   │   ├── status.ts      # /health, /status, /cluster-status, /dev-servers
│   │   ├── sessions.ts    # /launch, /switch, /stop, /stop-all
│   │   └── streaming.ts   # SSE: /launch/:hpc/:ide/stream, /stop/:hpc/:ide/stream
│   ├── auth.ts            # Authentication endpoints (/api/auth/*)
│   ├── help.ts            # Help content with template processing (/api/help/*)
│   ├── admin.ts           # Admin dashboard endpoints (/api/admin/*)
│   ├── stats.ts           # Public stats endpoints (/api/stats/*)
│   └── clientErrors.ts    # Frontend error reporting (/api/client-errors)
├── content/
│   ├── help/              # Markdown help files + index.json
│   └── admin/             # Markdown admin docs + index.json
├── ui/                    # React 19 frontend (Vite 7)
│   └── src/
│       ├── App.tsx        # Root component with provider hierarchy
│       ├── components/    # React components
│       │   ├── ContentPanel.tsx   # Shared slide-out panel (Help + Admin)
│       │   ├── HelpPanel.tsx      # Help slide-out (uses ContentPanel)
│       │   ├── AdminPanel.tsx     # Admin slide-out (uses ContentPanel)
│       │   ├── help-widgets/      # Embeddable help widgets
│       │   └── admin-widgets/     # Admin analytics widgets (D3.js)
│       ├── contexts/      # React contexts (Auth, SessionState, Theme)
│       ├── hooks/         # Custom hooks (useApi, useClusterStatus, useLaunch)
│       └── types/         # TypeScript type definitions
├── tools/
│   └── hpc-proxy/         # Go binary: /port/:port/* reverse proxy (in container)
├── public/                # Static assets, wrapper pages (menu-frame.html)
├── test/
│   ├── unit/              # Unit tests (mocha + chai)
│   └── integration/       # API integration tests
└── docs/                  # Documentation
```

## Key Components

### 1. StateManager (`lib/state.ts` + `lib/state/`)

The StateManager is a thin orchestrator (~100 lines) that delegates to four focused sub-managers sharing a common `AppState` object by reference:

| Sub-manager | File | Responsibility |
|---|---|---|
| `LockManager` | `lib/state/locking.ts` | Mutex per operation name; prevents concurrent launches |
| `SessionManager` | `lib/state/sessions.ts` | In-memory session CRUD, SQLite write-through |
| `JobPoller` | `lib/state/jobPolling.ts` | Adaptive SLURM polling (15s–30min backoff) |
| `ClusterHealthPoller` | `lib/state/clusterHealth.ts` | Fixed 30-min health polling + history |

```typescript
// State structure - sessions keyed by "${user}-${hpc}-${ide}"
{
  sessions: {
    'domeally-gemini-vscode': {
      status: 'running',        // idle | starting | pending | running
      jobId: '28692461',
      node: 'g-h-1-9-25',
      ide: 'vscode',
      releaseVersion: '3.22',
      gpu: 'a100',              // null for CPU-only
      cpus: 4,
      memory: '40G',
      walltime: '12:00:00',
      startedAt: '2025-01-01T10:00:00.000Z',
      submittedAt: '2025-01-01T09:59:50.000Z',
    },
  },
  activeSession: { user: 'domeally', hpc: 'gemini', ide: 'vscode' } | null,
  clusterHealth: { gemini: { current: {...}, history: [...] }, apollo: {...} }
}

// Lifecycle
await stateManager.load();           // Load from SQLite, reconcile with SLURM
stateManager.startPolling(factory);  // Start background polling loops
stateManager.stopPolling();          // Stop polling (graceful shutdown)

// Operation locks (prevent concurrent launches per user/cluster/ide)
stateManager.acquireLock('launch:domeally-gemini-vscode');  // Throws if locked
stateManager.releaseLock('launch:domeally-gemini-vscode');
```

**Adaptive polling intervals** (based on session activity):
- 15 seconds: any pending/near-expiry session
- 1 minute: running session
- 5–30 minutes: exponential backoff when stable (no state changes)

### 2. HpcService (`services/hpc.ts`)

Handles SLURM operations via SSH with ControlMaster multiplexing. All SSH commands are serialized per cluster via `withClusterQueue` to prevent connection flooding.

```typescript
const hpc = new HpcService('gemini', 'domeally');

// Submit job with IDE and release-specific settings
const { jobId, token } = await hpc.submitJob(4, '40G', '12:00:00', 'vscode', {
  releaseVersion: '3.22',
  gpu: 'a100',  // or '' for CPU
});

// Get current job info (from squeue, pipe-delimited)
const info = await hpc.getJobInfo('vscode');
// { jobId, state, node, timeLeft, timeLimit, cpus, memory, startTime }

// Get all IDE jobs for user in one SSH call
const jobs = await hpc.getAllJobs();
// { vscode: JobInfo|null, rstudio: JobInfo|null, jupyter: JobInfo|null }

// Read dynamic port written by job script
const port = await hpc.getIdePort('vscode');  // reads ~/.vscode-slurm/port
const proxyPort = await hpc.getProxyPort('domeally');  // reads ~/.hpc-proxy/port

// Cancel job(s)
await hpc.cancelJob(jobId);
await hpc.cancelJobs([jobId1, jobId2]);  // batch scancel
```

**Parallel processing env vars** set automatically in all job scripts:
- `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS` (linear algebra)
- `NUMEXPR_NUM_THREADS` (NumPy), `MC_CORES` (R parallel), `BIOCPARALLEL_WORKER_NUMBER`

**SSH key management:** Per-user private keys loaded from in-memory session store, written to `data/ssh-keys/<username>.key` with 600 permissions. ControlMaster sockets at `/tmp/rbiocverse-ssh/<user>-<cluster>`.

### 3. TunnelService (`services/tunnel.ts`)

Manages SSH tunnels to compute nodes. Session key format: `<user>-<hpc>-<ide>`.

```typescript
// Start tunnel with dynamic port discovery
const tunnelProcess = await tunnelService.start('gemini', 'g-h-1-9-25', 'vscode', onExit, {
  remotePort: 8012,   // dynamically discovered port on compute node
  user: 'domeally',
  proxyPort: 43721,   // hpc-proxy port (VS Code only)
});

// Stop/check tunnel
tunnelService.stop('gemini', 'vscode', 'domeally');
tunnelService.isActive('gemini', 'vscode', 'domeally');
```

**VS Code tunneling** (via hpc-proxy): Maps `localhost:9000 → node:<hpc-proxy-port>`. The hpc-proxy Go binary inside the container routes `/port/<targetPort>/*` to any dev server (Live Server, Shiny, etc.) without individual per-port tunnels.

**Legacy tunneling** (RStudio, JupyterLab): Direct `-L <localPort>:node:<remotePort>` SSH forwarding with `ServerAliveInterval=30`, `ExitOnForwardFailure=yes`.

### 4. hpc-proxy (`tools/hpc-proxy/`)

A Go binary (`main.go` + `proxy.go`) running inside the Singularity container on the compute node.

**Routes:** `GET/POST/WebSocket /port/<targetPort>/...` — strips the prefix, proxies to `127.0.0.1:<targetPort>`.

**HTML rewriting** (`--base-rewrite` flag): Injects `<base>` tags, rewrites `href`/`src` absolute paths, and fixes `Location` redirect headers so apps served at `/port/5500/` resolve relative URLs correctly.

The VS Code job script launches hpc-proxy at startup and writes its port to `~/.hpc-proxy/port`. After node assignment, the manager reads this port via SSH and establishes a single tunnel for all dev servers.

### 5. Validation (`lib/validation.ts`)

Security-critical input validation to prevent command injection in SLURM parameters.

```typescript
// Validates CPUs (1-128), memory (e.g., "40G"), time ("HH:MM:SS" or "D-HH:MM:SS")
// Also checks against per-partition limits when hpc and gpu are provided
validateSbatchInputs(cpus, mem, time, hpc, gpu);

// Validates cluster name against whitelist
validateHpcName('gemini');  // OK
validateHpcName('invalid'); // Throws
```

## API Endpoints

### Authentication (`routes/auth.ts`)

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login` | Verify credentials, issue JWT, test SSH, decrypt key |
| `POST /api/auth/logout` | Invalidate server-side session |
| `GET /api/auth/session` | Check validity, return user info (sliding token refresh) |
| `POST /api/auth/complete-setup` | Mark SSH setup complete |
| `POST /api/auth/test-connection/:cluster` | Test SSH connectivity |
| `POST /api/auth/test-connection-both` | Test both clusters in parallel |
| `POST /api/auth/generate-key` | Generate Ed25519 managed key |
| `POST /api/auth/regenerate-key` | Replace existing managed key |
| `POST /api/auth/remove-key` | Remove managed key (SSH must be working) |
| `GET /api/auth/public-key` | Return user's public key |
| `POST /api/auth/import-key` | Import existing private key (tests SSH, encrypts) |

### Session Management (`routes/api/`)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check (503 during startup) |
| `GET /api/status` | Instant session state from cache (no SSH) |
| `GET /api/cluster-status` | SLURM + health data; cached 30 min, invalidated on user action |
| `GET /api/dev-servers` | Check active dev server ports (5500, 3838) on compute node |
| `GET /api/launch/:hpc/:ide/stream` | **SSE** - launch with real-time progress events |
| `GET /api/stop/:hpc/:ide/stream` | **SSE** - stop with indeterminate progress |
| `POST /api/launch` | Launch (blocking, no SSE - legacy) |
| `POST /api/switch/:hpc/:ide` | Switch active session to different cluster/IDE |
| `POST /api/stop/:hpc/:ide` | Stop session (optionally cancel SLURM job) |
| `POST /api/stop-all/:hpc` | Batch cancel all user's jobs on a cluster |

### Help / Admin / Stats

| Route | Endpoints |
|---|---|
| `GET /api/help/*` | Help content with live `{{template}}` interpolation |
| `GET /api/admin/*` | Admin dashboard, user management, analytics (auth required) |
| `GET /api/stats/*` | Public anonymized stats (no auth) |
| `POST /api/client-errors` | Frontend error reporting |

## Data Flow

### Launch Session Flow (SSE Streaming)

```
1. User selects cluster/IDE/release/GPU/resources in React UI
2. GET /api/launch/gemini/vscode/stream?releaseVersion=3.22&gpu=a100&cpus=4&mem=40G
3. SSE connection opened; LoadingOverlay shown in UI
4. API acquires lock ('launch:domeally-gemini-vscode')
5. HpcService.submitJob() → SSH sbatch → jobId returned
6. HpcService.checkJobStatus() → quick squeue poll (2 attempts, ~5s)
   - If RUNNING: continue to step 7
   - If PENDING: send { type: 'pending', startTime } → overlay closes, pending card shown
7. HpcService.getIdePort() + getProxyPort() → read dynamic ports via SSH
8. TunnelService.start() → SSH -L 9000:node:<proxyPort>; wait for IDE HTTP ready
9. StateManager.updateSession() → { status: 'running', jobId, node, ... }
10. Lock released; SSE { type: 'complete', redirectUrl: '/code/' } → browser navigates
```

### Proxy Flow

```
1. User loads /code/ (or /rstudio/ or /jupyter/)
2. Express serves ide-wrapper.html (iframe)
3. iframe src="/vscode-direct/" (or /rstudio-direct/, /jupyter-direct/)
4. http-proxy forwards to localhost:8000 (or 8787, 8888)
5. SSH tunnel forwards to compute-node:<hpc-proxy-port> (VS Code)
   or directly to compute-node:<remotePort> (RStudio, JupyterLab)
6. IDE server responds
```

### Dev Server Proxy Flow (VS Code only)

```
1. User opens Shiny app or Live Server preview at /port/5500/
2. Express portProxy → localhost:9000 (hpc-proxy tunnel)
3. hpc-proxy on compute node routes /port/5500/* → localhost:5500
4. Dev server responds; hpc-proxy optionally rewrites HTML base tags
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | (required) | HMAC-SHA256 secret for JWTs. Min 32 chars or server exits. |
| `HPC_SSH_USER` | `domeally` | SSH username for HPC clusters |
| `GEMINI_SSH_HOST` | `gemini-login2.coh.org` | Gemini login node hostname |
| `APOLLO_SSH_HOST` | `ppxhpcacc01.coh.org` | Apollo login node hostname |
| `DEFAULT_HPC` | `gemini` | Default cluster for new sessions |
| `DEFAULT_IDE` | `vscode` | Default IDE for new sessions |
| `DEFAULT_CPUS` | `2` | Default CPU count |
| `DEFAULT_MEM` | `40G` | Default memory allocation |
| `DEFAULT_TIME` | `12:00:00` | Default walltime |
| `DB_PATH` | `/data/app.db` | SQLite database path |
| `STATE_FILE` | `/data/state.json` | JSON state file (legacy; used with `ENABLE_STATE_PERSISTENCE`) |
| `ENABLE_STATE_PERSISTENCE` | `true` | Also write sessions to JSON file (SQLite is always used) |
| `STATUS_CACHE_TTL` | `1800000` | Cluster status cache TTL in ms (30 min default) |
| `LOG_LEVEL` | `info` | Winston log level |
| `DEBUG_COMPONENTS` | (empty) | Comma-separated debug namespaces (e.g., `ssh,state,tunnel,all`) |
| `SESSION_IDLE_TIMEOUT` | `0` | Minutes idle before auto-cancel (0 = disabled) |
| `SESSION_EXPIRY_DAYS` | `7` | JWT token expiry |
| `ADDITIONAL_PORTS` | `5500,3838` | Dev server ports checked by `/api/dev-servers` |
| `HPC_PROXY_LOCAL_PORT` | `9000` | Local port for hpc-proxy SSH tunnel |

### Clusters (`config/index.ts`)

```typescript
clusters: {
  gemini: {
    host: 'gemini-login2.coh.org',
    partition: 'compute',
    singularityBin: '/packages/easy-build/software/singularity/3.7.0/bin/singularity',
    bindPaths: '/packages,/scratch,/ref_genomes',
  },
  apollo: {
    host: 'ppxhpcacc01.coh.org',
    partition: 'fast,all',
    singularityBin: '/opt/singularity/3.7.0/bin/singularity',
    bindPaths: '/opt,/labs',
  }
}
```

### Bioconductor Releases (`config/index.ts`)

```typescript
releases: {
  '3.22': {
    name: 'Bioconductor 3.22',
    ides: ['vscode', 'rstudio', 'jupyter'],
    paths: {
      gemini: {
        singularityImage: '/packages/singularity/shared_cache/rbioc/rbiocverse_3.22.sif',
        rLibsSite: '/packages/.../rlibs/bioc-3.22',
        pythonEnv: '/packages/.../python/bioc-3.22',
      },
      apollo: {
        singularityImage: '/opt/singularity-images/rbioc/rbiocverse_3.22.sif',
        ...
      }
    }
  },
  '3.19': { ides: ['vscode', 'rstudio'], ... },
  '3.18': { ides: ['vscode', 'rstudio'], ... },
  '3.17': { ides: ['vscode', 'rstudio'], ... },
}
```

### GPU Configuration (Gemini only)

```typescript
gpuConfig: {
  gemini: {
    a100: { partition: 'gpu-a100', gres: 'gpu:A100:1', maxTime: '4-00:00:00', mem: '256G' },
    v100: { partition: 'gpu-v100', gres: 'gpu:V100:1', maxTime: '8-00:00:00', mem: '96G' },
  },
  apollo: null,  // No GPU support
}
```

## Database

SQLite (better-sqlite3, WAL mode) at `/data/app.db`.

| Table | Purpose |
|---|---|
| `users` | User accounts, encrypted SSH keys, `setup_complete` flag |
| `active_sessions` | Live SLURM sessions written through from `SessionManager` |
| `session_history` | Completed/archived sessions for analytics |
| `cluster_health` | Time-series health snapshots (30-min interval) |
| `cluster_cache` | Current cluster health state (last check result) |
| `partition_limits` | Dynamic SLURM partition info fetched from `sinfo` |
| `app_state` | Key-value store (currently: `activeSession`) |

Session keys (`<user>-<hpc>-<ide>`) are used consistently across `active_sessions`, `session_history`, and the in-memory `AppState.sessions` map.

## Security

### Input Validation

All user inputs are validated before use in shell commands:

- **CPUs**: Integer within partition limits (up to 128)
- **Memory**: Format `\d+[gGmM]` (e.g., "40G", "100M"); within partition limits
- **Time**: Format `HH:MM:SS` or `D-HH:MM:SS`; within partition limits
- **HPC name**: Whitelist (`gemini`, `apollo`)
- **GPU type**: Validated against `gpuConfig` for the cluster

### SSH Key Security

- Private keys encrypted at rest with AES-256-GCM using server-derived key (v3 format)
- Keys stored in `data/ssh-keys/<username>.key` with 600 permissions
- Per-user isolation: each SSH connection uses only the requesting user's key
- ControlMaster sockets at `/tmp/rbiocverse-ssh/<user>-<cluster>` (30-min persist)

### JWT Authentication

- HMAC-SHA256 signed, configurable expiry (default 7 days)
- Sliding session refresh: token auto-renewed when >50% expired (`X-Refreshed-Token` response header)
- Timing-safe comparison via `crypto.timingSafeEqual`

## Frontend (React UI)

React 19 SPA built with Vite 7 and TypeScript. No UI framework; custom CSS only.

**Provider hierarchy:**
```
ThemeProvider → AuthProvider → SessionStateProvider → AppContent
```

**Key hooks:**
- `useClusterStatus` — polls `GET /api/cluster-status` every 2 seconds
- `useLaunch` — manages SSE `EventSource` for launch/connect flows
- `useCountdown` — client-side 1-second countdown for running job time
- `useApi` — central HTTP client with JWT header injection and auto-logout on 401

**SSE event types** (launch stream):
- `progress` — updates dual progress bars in `LoadingOverlay`
- `pending` — job queued; closes stream, shows pending session card
- `complete` — closes stream, navigates to IDE (`window.location.href`)
- `error` — shows error; SSH errors offer "Set up SSH Keys" shortcut

## Testing

```bash
# Unit + integration tests (471 tests)
npm test

# With coverage report
npm run test:coverage

# Type check (backend)
npm run typecheck

# Type check (frontend)
cd ui && npm run typecheck

# Frontend production build
cd ui && npm run build
```

## Logging

Winston with domain-specific log methods (`lib/logger.ts`):

```typescript
log.ssh('Executing command', { cluster: 'gemini' });
log.job('Submitted', { jobId: '12345' });
log.tunnel('Established', { port: 8000 });
log.api('POST /launch', { hpc: 'gemini' });
log.state('Session updated', { user, hpc, ide });
log.audit('Session started', { user, hpc, ide, jobId });  // Always logged
log.error('Failed', errorDetails(err));                   // With stack trace
```

Set `DEBUG_COMPONENTS=ssh,state,tunnel,cache,db,port-proxy,perf` for verbose output.
In production: logs at `/data/logs/manager.log` (5 MB max, 3 rotations).

## Help System

Built-in documentation with live cluster data. See [HELP_SYSTEM.md](HELP_SYSTEM.md) for details.

- **Template syntax**: `{{gemini.cpus.percent}}` renders live values
- **Ternary expressions**: `{{cluster.online ? "🟢" : "🔴"}}`
- **Widget embedding**: `:::widget ClusterHealth cluster="gemini":::`
- **Search**: Full-text search across all help sections

| File | Purpose |
|---|---|
| `routes/help.ts` | API + server-side template processing |
| `ui/src/components/HelpPanel.tsx` | Slide-out panel (uses ContentPanel) |
| `ui/src/components/ContentPanel.tsx` | Shared panel renderer (Help + Admin) |
| `ui/src/components/help-widgets/` | Embeddable live data widgets |
| `content/help/*.md` | Markdown content |
