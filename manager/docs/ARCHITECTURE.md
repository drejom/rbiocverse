# HPC Code Server Manager - Architecture

## Overview

The HPC Code Server Manager is a web application that provides browser-based IDE experiences (VS Code, RStudio, JupyterLab) on HPC SLURM clusters. It manages job submission, SSH tunneling, and proxies requests to IDEs running in Singularity containers on compute nodes.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Browser                                 │
│  ┌─────────────┐  ┌──────────────────────────────────────────────┐  │
│  │  Launcher   │  │     IDE (iframe) - VS Code / RStudio / Jupyter│  │
│  │    Page     │  │  /code/ │ /rstudio/ │ /jupyter/ → proxy      │  │
│  └─────────────┘  └──────────────────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ HTTPS
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    HPC Code Server Manager                           │
│                      (Express.js on Dokploy)                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  server.js - Main orchestration                               │   │
│  │    ├── Static files (public/)                                 │   │
│  │    ├── API routes (/api/*)                                    │   │
│  │    └── HTTP Proxy (VS Code :8000, RStudio :8787, Jupyter :8888)│   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────┐   │
│  │ HpcService │ │TunnelService│ │StateManager│ │   Validation   │   │
│  │(SLURM ops) │ │ (SSH tunnels)│ │(persistence)│ │   (security)   │   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────────┘   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ SSH Tunnel (IDE port + additional ports)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    HPC Login Node                                    │
│                 (gemini-login2 / ppxhpcacc01)                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SSH tunnel: localhost:<port> → compute-node:<port>          │   │
│  │  Ports: 8000 (VS Code), 8787 (RStudio), 8888 (Jupyter)       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SLURM Compute Node                                │
│                     (e.g., g-h-1-9-25)                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Singularity Container (vscode-rbioc_X.XX.sif)               │   │
│  │    ├── VS Code: code serve-web on port 8000                  │   │
│  │    ├── RStudio: rserver on port 8787                         │   │
│  │    └── JupyterLab: jupyter lab on port 8888                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Supported IDEs

| IDE | Port | Proxy Path | Releases |
|-----|------|------------|----------|
| VS Code | 8000 | `/code/` | All (3.17-3.22) |
| RStudio | 8787 | `/rstudio/` | All (3.17-3.22) |
| JupyterLab | 8888 | `/jupyter/` | 3.22 only |

## Directory Structure

```
manager/
├── server.js              # Main Express server
├── config/
│   └── index.js           # Configuration and cluster definitions
├── lib/
│   ├── validation.js      # Security-critical input validation
│   ├── helpers.js         # Time parsing and formatting utilities
│   ├── state.js           # StateManager with persistence and locks
│   ├── errors.js          # Custom error classes
│   └── logger.js          # Winston structured logging
├── services/
│   ├── hpc.js             # HpcService - SLURM operations via SSH
│   └── tunnel.js          # TunnelService - SSH tunnel management
├── routes/
│   ├── api.js             # API endpoints (/api/*)
│   ├── auth.js            # Authentication endpoints
│   └── help.js            # Help content with template processing
├── content/
│   └── help/              # Markdown help files + index.json
├── ui/                    # React frontend (Vite)
│   └── src/
│       ├── components/    # React components
│       │   ├── HelpPanel.jsx
│       │   └── help-widgets/  # Embeddable help widgets
│       └── hooks/         # Custom React hooks
├── public/                # Static assets, wrapper pages
├── test/
│   ├── unit/              # Unit tests (mocha + chai)
│   └── integration/       # API integration tests
└── docs/                  # Documentation
```

## Key Components

### 1. StateManager (`lib/state.js`)

Manages application state with persistence and operation locks.

```javascript
const StateManager = require('./lib/state');
const stateManager = new StateManager();

// State structure - sessions keyed by "${hpc}-${ide}"
{
  sessions: {
    'gemini-vscode': {
      status: 'running',        // idle | pending | running
      jobId: '28692461',
      node: 'g-h-1-9-25',
      ide: 'vscode',
      port: 8000,               // Dynamically discovered
      releaseVersion: '3.22',
      gpu: 'a100',              // null for CPU-only
      cpus: '4',
      memory: '40G',
      walltime: '12:00:00',
      startedAt: '2025-01-01T10:00:00.000Z',
      lastActivity: 1704268800000,  // Unix timestamp (ms)
      shinyPort: 7777,          // VS Code only, if Shiny detected
    },
    'gemini-rstudio': { ... },
    'apollo-vscode': { ... },
  },
  activeHpc: 'gemini' | 'apollo' | null
}

// Persistence
await stateManager.load();  // Load from /data/state.json
await stateManager.save();  // Persist changes

// Operation locks (prevent race conditions)
stateManager.acquireLock('launch:gemini');  // Throws if locked
stateManager.releaseLock('launch:gemini');
```

### 2. HpcService (`services/hpc.js`)

Handles SLURM operations via SSH. Builds IDE-specific bash scripts for job submission.

```javascript
const HpcService = require('./services/hpc');
const hpc = new HpcService('gemini');

// Submit job with IDE and release-specific settings
const { jobId, token } = await hpc.submitJob('4', '40G', '12:00:00', 'vscode', {
  releaseVersion: '3.22',
  gpu: 'a100',  // or '' for CPU
});

// Get job info (from squeue)
const info = await hpc.getJobInfo('vscode');
// { jobId, state, node, timeLeft, timeLimit, cpus, memory, startTime }

// Wait for node assignment
const { node } = await hpc.waitForNode(jobId);

// Cancel job
await hpc.cancelJob(jobId);

// IDE-specific script builders (return full bash scripts)
// All set parallel processing env vars from cpus parameter
hpc.buildVscodeScript({ token, releaseVersion: '3.22', cpus: 4 });
hpc.buildRstudioScript(4, { releaseVersion: '3.22' });
hpc.buildJupyterScript({ token, releaseVersion: '3.22', cpus: 4 });
```

**Parallel Processing Environment Variables** (set automatically from SLURM allocation):
- `OMP_NUM_THREADS` - OpenMP
- `MKL_NUM_THREADS` - Intel MKL
- `OPENBLAS_NUM_THREADS` - OpenBLAS
- `NUMEXPR_NUM_THREADS` - NumPy numexpr
- `MC_CORES` - R parallel::mclapply
- `BIOCPARALLEL_WORKER_NUMBER` - BiocParallel

### 3. TunnelService (`services/tunnel.js`)

Manages SSH tunnels to compute nodes.

```javascript
const TunnelService = require('./services/tunnel');
const tunnelService = new TunnelService();

// Start tunnel (ports 8000 + 5500)
const process = await tunnelService.start('gemini', 'g-h-1-9-25', callback);

// Stop tunnel
tunnelService.stop('gemini');

// Check if active
tunnelService.isActive('gemini');
```

### 4. Validation (`lib/validation.js`)

Security-critical input validation to prevent command injection.

```javascript
const { validateSbatchInputs, validateHpcName } = require('./lib/validation');

// Validates CPUs (1-128), memory (e.g., "40G"), time (e.g., "12:00:00")
validateSbatchInputs(cpus, mem, time);

// Validates cluster name
validateHpcName('gemini');  // OK
validateHpcName('invalid'); // Throws
```

## Data Flow

### Launch Session Flow (SSE Streaming)

```
1. User selects IDE (VS Code), release (3.22), GPU (A100), resources
2. GET /api/launch/gemini/vscode/stream?releaseVersion=3.22&gpu=a100&cpus=4&mem=40G&time=12:00:00
3. SSE connection opened, progress events streamed to browser
4. API acquires lock ('launch:gemini-vscode')
5. HpcService.submitJob() → SSH sbatch with GPU partition
6. HpcService.waitForNode() → polls squeue until RUNNING
7. TunnelService.start() → SSH -L 8000:node:8000
8. State updated: { status: 'running', jobId, node, ide, releaseVersion, gpu }
9. Lock released
10. Final SSE event with redirect URL → browser navigates to /code/
```

### Proxy Flow

```
1. User loads /code/ (or /rstudio/ or /jupyter/)
2. Express serves ide-wrapper.html (iframe)
3. iframe src="/vscode-direct/" (or /rstudio-direct/, /jupyter-direct/)
4. http-proxy forwards to localhost:<port>
   - VS Code: 8000, RStudio: 8787, JupyterLab: 8888
5. SSH tunnel forwards to compute-node:<port>
6. IDE server responds
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | (required) | Secret for signing JWT tokens. **Must be set** or server exits. |
| `HPC_SSH_USER` | `domeally` | SSH username for HPC clusters |
| `DEFAULT_HPC` | `gemini` | Default cluster for new sessions |
| `CODE_SERVER_PORT` | `8000` | Port for code-server |
| `STATE_FILE` | `/data/state.json` | State persistence file |
| `ENABLE_STATE_PERSISTENCE` | `true` | Enable/disable state persistence |
| `STATUS_CACHE_TTL` | `120000` | Cluster status cache TTL (ms) |
| `LOG_LEVEL` | `info` | Winston log level |
| `SESSION_IDLE_TIMEOUT` | `0` | Minutes of inactivity before auto-cancel (0 = disabled) |
| `SESSION_EXPIRY_DAYS` | `7` | JWT token expiry (days) for "remember me" |
| `ADDITIONAL_PORTS` | `5500` | Extra ports to tunnel (comma-separated) |
| `TEST_USERNAME` | (dev only) | Test username for development auth |
| `TEST_PASSWORD` | (dev only) | Test password for development auth |

### IDE Global Defaults (`config/index.js`)

VS Code and RStudio global settings are defined in `vscodeDefaults` and `rstudioDefaults`:

- **VS Code**: Machine settings (radian terminal, nerdfont fallback, R httpgd) + extension pre-install
- **RStudio**: rstudio-prefs.json (JetBrains Mono font, bash terminal, HPC-friendly workspace)

User settings override Machine settings. See `config/index.js` for full settings.

### Cluster Configuration (`config/index.js`)

```javascript
clusters: {
  gemini: {
    host: 'gemini-login2.coh.org',
    partition: 'compute',
    singularityBin: '/packages/.../singularity',
    bindPaths: '/packages,/scratch,/ref_genomes',
  },
  apollo: { ... }
}
```

### Bioconductor Releases (`config/index.js`)

Release-specific Singularity images and library paths:

```javascript
releases: {
  '3.22': {
    name: 'Bioconductor 3.22',
    ides: ['vscode', 'rstudio', 'jupyter'],  // JupyterLab only on 3.22
    paths: {
      gemini: {
        singularityImage: '/packages/.../vscode-rbioc_3.22.sif',
        rLibsSite: '/packages/.../rlibs/bioc-3.22',
        pythonEnv: '/packages/.../python/bioc-3.22',
      },
      apollo: { ... }
    }
  },
  '3.19': { ides: ['vscode', 'rstudio'], ... },
  '3.18': { ides: ['vscode', 'rstudio'], ... },
  '3.17': { ides: ['vscode', 'rstudio'], ... },
}

// Helper to get release-specific paths
const paths = getReleasePaths('gemini', '3.22');
// { singularityImage, rLibsSite, pythonEnv }
```

### GPU Configuration (Gemini only)

```javascript
gpuConfig: {
  gemini: {
    a100: { partition: 'gpu-a100', gres: 'gpu:A100:1', maxTime: '4-00:00:00', mem: '256G' },
    v100: { partition: 'gpu-v100', gres: 'gpu:V100:1', maxTime: '8-00:00:00', mem: '96G' },
  },
  apollo: null,  // No GPU support
}
```

## Security

### Input Validation

All user inputs are validated before use in shell commands:

- **CPUs**: Integer 1-128 only
- **Memory**: Format `\d+[gGmM]` (e.g., "40G", "100M")
- **Time**: Format `HH:MM:SS` or `D-HH:MM:SS`
- **HPC name**: Whitelist (`gemini`, `apollo`)

### Command Injection Prevention

All sbatch parameters are validated with strict regex patterns. No user input is interpolated directly into shell commands without validation.

### State Security

- State file contains no secrets
- SSH authentication uses system keys (not stored in app)
- No passwords or tokens in state

## Testing

```bash
# Unit + Integration tests (226 tests)
npm test

# E2E browser tests (15 tests)
npm run test:e2e

# All tests
npm run test:all

# Coverage report
npm run test:coverage
```

## Logging

Uses Winston with domain-specific log methods:

```javascript
const { log } = require('./lib/logger');

log.ssh('Executing command', { cluster: 'gemini' });
log.job('Submitted', { jobId: '12345' });
log.tunnel('Established', { port: 8000 });
log.api('POST /launch', { hpc: 'gemini' });
log.error('Failed', { error: err.message });
```

Log levels: `error`, `warn`, `info`, `debug`

## Session Activity Tracking

The manager tracks user activity via proxy traffic events. This enables optional idle session cleanup to free HPC resources.

### How It Works

```
User interacts with IDE → Proxy event fires → lastActivity timestamp updated
                                                      ↓
                                    Cleanup interval checks every 60s
                                                      ↓
                              If idle > SESSION_IDLE_TIMEOUT → scancel job
```

### Activity Sources

Activity is tracked on these proxy events for all IDEs (VS Code, RStudio, JupyterLab):
- `proxyRes` - HTTP response received from IDE
- `open` - WebSocket connection opened

### Idle Cleanup (Opt-in)

**Disabled by default** (`SESSION_IDLE_TIMEOUT=0`). Enable with caution:

```bash
# Cancel session after 2 hours of inactivity
SESSION_IDLE_TIMEOUT=120 npm start
```

**Warning**: Activity tracking is based on proxy traffic, not CPU usage. A long-running simulation with no UI interaction will appear "idle" and get cancelled. For batch workloads, submit separate SLURM jobs instead of running in the IDE.

### State

Activity timestamp stored in session state (keyed by `${hpc}-${ide}`):
```javascript
state.sessions['gemini-vscode'] = {
  status: 'running',
  jobId: '12345',
  lastActivity: 1704268800000,  // Unix timestamp (ms)
  // ...
};
```

## Authentication

Multi-user authentication with JWT tokens and per-user SSH key management.

### Flow

1. User logs in with credentials (dev: env vars, prod: LDAP)
2. System tests SSH to both clusters
3. If SSH works → mark setup complete, no managed key needed
4. If SSH fails → generate Ed25519 keypair, user installs public key
5. On subsequent SSH operations, HpcService uses user's private key

### Key Management

| State | Meaning |
|-------|---------|
| `publicKey: null` | No managed key - user's own SSH works |
| `publicKey: "ssh-ed25519..."` | Managed key exists - may need installation |
| `privateKey: "-----BEGIN..."` | Stored private key for SSH connections |
| `setupComplete: true` | SSH verified working |
| `setupComplete: false` | User needs to install managed key |

**Per-User SSH Keys:**

When a user has a managed key, HpcService writes the private key to a temp file with 600 permissions and uses `-i keyfile` for SSH connections. This allows multiple users to share the same Manager instance with isolated SSH access.

```javascript
// HpcService uses getUserPrivateKey() from auth.js
const privateKey = getUserPrivateKey(username);
if (privateKey) {
  const keyPath = getKeyFilePath(username, privateKey);
  sshCmd = `ssh -i ${keyPath} ...`;
}
```

Temp keys are stored in `/tmp/hpc-ssh-keys/` with secure permissions.

### API Endpoints (`routes/auth.js`)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/auth/login` | Authenticate, test SSH, generate key if needed |
| `POST /api/auth/logout` | Invalidate session (for audit logging) |
| `GET /api/auth/session` | Check session validity, return user info |
| `POST /api/auth/test-connection-both` | Test SSH to both clusters |
| `POST /api/auth/test-connection/:cluster` | Test SSH to specific cluster |
| `POST /api/auth/generate-key` | Generate managed Ed25519 key |
| `POST /api/auth/regenerate-key` | Replace existing managed key |
| `POST /api/auth/remove-key` | Remove managed key (requires working SSH) |
| `GET /api/auth/public-key` | Get user's public key for copying |
| `POST /api/auth/complete-setup` | Mark setup complete |

### Security

- **JWT Tokens**: HMAC-SHA256 signed with `JWT_SECRET` (required env var)
- **Timing-safe verification**: `crypto.timingSafeEqual` prevents timing attacks
- **Session expiry**: Configurable (default 7 days, 1 day without "remember me")
- **User data**: `data/users.json` with atomic writes (temp file + rename)
- **Private keys**: Stored in users.json (TODO: AES-256-GCM encryption with JWT_SECRET)

## Help System

Built-in documentation with live cluster data. See [HELP_SYSTEM.md](HELP_SYSTEM.md) for details.

### Features

- **Template syntax**: `{{gemini.cpus.percent}}` renders live values
- **Ternary expressions**: `{{cluster.online ? "🟢" : "🔴"}}`
- **Widget embedding**: `:::widget ClusterHealth cluster="gemini":::`
- **Search**: Full-text search across all help sections

### Key Files

| File | Purpose |
|------|---------|
| `routes/help.js` | API + server-side template processing |
| `ui/src/components/HelpPanel.jsx` | React panel + widget mounting |
| `ui/src/components/help-widgets/` | Embeddable widget components |
| `content/help/*.md` | Markdown content |
