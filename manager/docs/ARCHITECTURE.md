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
├── server.js              # Main Express server (196 lines)
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
│   └── api.js             # API endpoints (/api/*)
├── public/
│   ├── index.html         # Launcher page
│   ├── css/style.css      # Styles
│   └── js/launcher.js     # Frontend JavaScript
├── test/
│   ├── unit/              # Unit tests (mocha + chai)
│   ├── integration/       # API integration tests
│   └── e2e/               # Puppeteer browser tests
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

Handles SLURM operations via SSH. Builds IDE-specific Singularity wrapper scripts.

```javascript
const HpcService = require('./services/hpc');
const hpc = new HpcService('gemini');

// Submit job with IDE and release-specific settings
const jobId = await hpc.submitJob('vscode', '4', '40G', '12:00:00', {
  releaseVersion: '3.22',
  gpu: 'a100',  // or null for CPU
});

// Get job info (from squeue)
const info = await hpc.getJobInfo('vscode');
// { jobId, state, node, timeLeft, timeLimit, cpus, memory, startTime }

// Wait for node assignment
const node = await hpc.waitForNode(jobId);

// Cancel job
await hpc.cancelJob(jobId);

// IDE-specific wrap builders (use release-specific paths)
hpc.buildVscodeWrap({ token, releaseVersion: '3.22' });
hpc.buildRstudioWrap({ releaseVersion: '3.22' });
hpc.buildJupyterWrap({ token, releaseVersion: '3.22' });
```

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
| `HPC_SSH_USER` | `domeally` | SSH username for HPC clusters |
| `DEFAULT_HPC` | `gemini` | Default cluster for new sessions |
| `CODE_SERVER_PORT` | `8000` | Port for code-server |
| `STATE_FILE` | `/data/state.json` | State persistence file |
| `ENABLE_STATE_PERSISTENCE` | `true` | Enable/disable state persistence |
| `STATUS_CACHE_TTL` | `120000` | Cluster status cache TTL (ms) |
| `LOG_LEVEL` | `info` | Winston log level |
| `SESSION_IDLE_TIMEOUT` | `0` | Minutes of inactivity before auto-cancel (0 = disabled) |
| `ADDITIONAL_PORTS` | `5500` | Extra ports to tunnel (comma-separated) |

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
# Unit + Integration tests (167 tests)
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
