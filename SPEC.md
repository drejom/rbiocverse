# HPC Code Server Manager: Refactoring Specification

> **Status**: ✅ Phase 1-4 Complete | **Target**: Week 1-2 Implementation | **Focus**: Testability & Reliability

## Executive Summary

This specification outlines a phased refactoring of the HPC Code Server Manager based on comprehensive reviews:

- **[HPC_REVIEW.md](https://github.com/drejom/omhq-hpc-code-server-stack/blob/claude/vscode-slurm-research-s9pBE/HPC_REVIEW.md)**: Critical architectural review identifying state persistence, code structure, and race condition improvements
- **[REFACTOR.md (PR #1)](https://github.com/drejom/omhq-hpc-code-server-stack/pull/1)**: Comprehensive architectural vision for multi-backend support, SSH pooling, and multi-user capabilities

**Primary Goals**:
1. **Improve testability and reliability** (immediate priority)
2. **Enable incremental refactoring** (no big-bang rewrites)
3. **Deliver quick wins** (1-2 week timeline)
4. **Maintain backward compatibility** (zero breaking changes)

## Current State Analysis (Updated Dec 2025 - Post-Refactor)

### Codebase Metrics

| Metric | Before | After | Status |
|--------|--------|-------|--------|
| **server.js size** | 1,688 lines | 196 lines | ✅ Modular |
| **Security validation** | Inline | lib/validation.js | ✅ Tested |
| **State management** | In-memory only | Persistent + reconciliation | ✅ Survives restarts |
| **Frontend organization** | Embedded in JS | public/ directory | ✅ Maintainable |
| **Test coverage** | 0% | 182 tests (167 unit + 15 E2E) | ✅ Comprehensive |
| **Multi-HPC support** | Yes | Yes | ✅ Working |
| **Error handling** | Ad-hoc | Custom error classes | ✅ Structured |
| **Logging** | console.log | Winston structured | ✅ Searchable |
| **Race conditions** | Possible | Operation locks | ✅ Protected |

### Architecture Strengths

- ✅ **Iframe-based isolation**: Sound architecture prevents CSP conflicts
- ✅ **Security validation**: Command injection protection implemented
- ✅ **Multi-cluster support**: Gemini and Apollo both functional
- ✅ **Clean API contracts**: Well-defined endpoints

### Technical Debt

- ❌ **Monolithic structure**: Everything in one 1,688-line file
- ❌ **No state persistence**: Orphaned processes after crashes
- ❌ **Frontend coupling**: HTML/CSS/JS embedded in template literals
- ❌ **Zero test coverage**: No unit, integration, or E2E tests
- ❌ **Global state**: No validation or schema enforcement
- ❌ **Mixed concerns**: Business logic, routing, HTML all interleaved

## Phased Implementation Plan

### Phase 1: Foundation & Quick Wins (Week 1: Days 1-3)

**Goal**: Maximum reliability gain with minimal risk

**Priority**: CRITICAL

#### 1.1 Testing Infrastructure Setup (4 hours)

**Create:**
```json
// package.json additions
{
  "devDependencies": {
    "mocha": "^10.2.0",
    "chai": "^4.3.10",
    "sinon": "^17.0.1",
    "supertest": "^6.3.3"
  },
  "scripts": {
    "test": "mocha test/**/*.test.js",
    "test:watch": "mocha --watch test/**/*.test.js",
    "test:coverage": "c8 mocha test/**/*.test.js"
  }
}
```

**Directory structure:**
```
manager/
├── test/
│   ├── unit/
│   │   ├── validation.test.js
│   │   ├── helpers.test.js
│   │   └── state.test.js
│   └── integration/
│       ├── api.test.js
│       └── state.test.js
```

**Deliverable**: Test framework ready, zero tests passing (baseline)

#### 1.2 Extract & Test Validation Logic (3 hours)

**Create: `/manager/lib/validation.js`**
```javascript
/**
 * Security-critical input validation
 * Prevents command injection in sbatch commands
 */

function validateSbatchInputs(cpus, mem, time) {
  // CPUs: integer 1-128
  if (!/^\d+$/.test(cpus) || parseInt(cpus) < 1 || parseInt(cpus) > 128) {
    throw new Error('Invalid CPU value: must be integer 1-128');
  }

  // Memory: format like "40G", "100M"
  if (!/^\d+[gGmM]$/.test(mem)) {
    throw new Error('Invalid memory value: use format like "40G" or "100M"');
  }

  // Time: HH:MM:SS or D-HH:MM:SS
  if (!/^(\d{1,2}-)?\d{1,2}:\d{2}:\d{2}$/.test(time)) {
    throw new Error('Invalid time value: use format like "12:00:00" or "1-00:00:00"');
  }
}

function validateHpcName(hpc) {
  const validHpcs = ['gemini', 'apollo'];
  if (!validHpcs.includes(hpc)) {
    throw new Error(`Invalid HPC: must be one of ${validHpcs.join(', ')}`);
  }
}

module.exports = { validateSbatchInputs, validateHpcName };
```

**Create: `/manager/test/unit/validation.test.js`**

15-20 test cases covering:
- ✅ Valid inputs (happy path)
- ✅ Boundary values (1 cpu, 128 cpus, 0G memory)
- ✅ Invalid formats (negative numbers, special chars)
- ✅ **Injection attempts** (critical security tests)
- ✅ Edge cases (empty strings, null, undefined)

**Success criteria:**
- 100% code coverage on validation functions
- All injection attempts blocked and documented in tests
- No breaking changes to `/api/launch` endpoint

#### 1.3 Extract & Test Helper Functions (4 hours)

**Create: `/manager/lib/helpers.js`**
```javascript
/**
 * Time parsing and formatting utilities
 * Pure functions with zero dependencies
 */

function parseTimeToSeconds(timeStr) {
  // Parse "12:00:00" or "1-00:00:00" to seconds
  const parts = timeStr.split(/[-:]/);
  if (parts.length === 3) {
    // HH:MM:SS
    const [h, m, s] = parts.map(Number);
    return h * 3600 + m * 60 + s;
  } else if (parts.length === 4) {
    // D-HH:MM:SS
    const [d, h, m, s] = parts.map(Number);
    return d * 86400 + h * 3600 + m * 60 + s;
  }
  throw new Error('Invalid time format');
}

function formatHumanTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function calculateRemainingTime(startedAt, walltime) {
  const elapsed = Math.floor((Date.now() - new Date(startedAt)) / 1000);
  const total = parseTimeToSeconds(walltime);
  return Math.max(0, total - elapsed);
}

module.exports = {
  parseTimeToSeconds,
  formatHumanTime,
  calculateRemainingTime,
};
```

**Create: `/manager/test/unit/helpers.test.js`**

12 test cases covering:
- Time parsing: valid formats, invalid formats, edge cases
- Human formatting: 0s, 59s, 3599s, 86400s
- Remaining time: future dates, past dates, null handling

**Success criteria:**
- 100% coverage on helper functions
- Zero dependencies on external state
- All tests passing

#### 1.4 State Persistence Implementation ⭐ HIGHEST IMPACT (6 hours)

**Create: `/manager/lib/state.js`**
```javascript
const fs = require('fs').promises;
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || '/data/state.json';
const ENABLE_PERSISTENCE = process.env.ENABLE_STATE_PERSISTENCE === 'true';

class StateManager {
  constructor() {
    this.state = {
      sessions: {
        gemini: null,
        apollo: null,
      },
      activeHpc: null,
    };
  }

  /**
   * Load state from disk on startup
   * Reconcile with squeue to detect orphaned jobs
   */
  async load() {
    if (!ENABLE_PERSISTENCE) return;

    try {
      const data = await fs.readFile(STATE_FILE, 'utf8');
      this.state = JSON.parse(data);
      console.log('State loaded from', STATE_FILE);

      await this.reconcile();
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('Failed to load state:', e.message);
      }
      // File doesn't exist yet - normal on first run
    }
  }

  /**
   * Save state to disk after every change
   */
  async save() {
    if (!ENABLE_PERSISTENCE) return;

    try {
      const dir = path.dirname(STATE_FILE);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('Failed to save state:', e.message);
    }
  }

  /**
   * Reconcile state with reality
   * Check if "running" jobs still exist in squeue
   * Mark as idle if job no longer exists
   */
  async reconcile() {
    for (const [hpc, session] of Object.entries(this.state.sessions)) {
      if (session?.status === 'running' && session.jobId) {
        const exists = await this.checkJobExists(hpc, session.jobId);
        if (!exists) {
          console.log(`Job ${session.jobId} no longer exists, marking as idle`);
          this.state.sessions[hpc] = null;
        }
      }
    }
    await this.save();
  }

  /**
   * Check if job exists in squeue
   */
  async checkJobExists(hpc, jobId) {
    // TODO: Implement squeue check
    // For now, assume job exists
    return true;
  }

  /**
   * Update session and persist
   */
  async updateSession(hpc, updates) {
    if (!this.state.sessions[hpc]) {
      this.state.sessions[hpc] = {};
    }
    Object.assign(this.state.sessions[hpc], updates);
    await this.save();
  }

  /**
   * Clear session and persist
   */
  async clearSession(hpc) {
    this.state.sessions[hpc] = null;
    if (this.state.activeHpc === hpc) {
      this.state.activeHpc = null;
    }
    await this.save();
  }
}

module.exports = StateManager;
```

**Update: `docker-compose.yml`**
```yaml
services:
  app:
    volumes:
      - /mnt/ssd/docker/omhq-hpc-prod/data:/data  # Persistent state
    environment:
      - STATE_FILE=/data/state.json
      - ENABLE_STATE_PERSISTENCE=true  # Feature flag
```

**Create: `/manager/test/integration/state.test.js`**

Integration tests:
- Save/load cycle preserves state
- Reconciliation marks dead jobs as idle
- Handles corrupted state file gracefully
- Feature flag works (disabled = in-memory only)

**Success criteria:**
- State survives container restarts
- Orphaned jobs detected and cleaned up
- Zero data loss on normal shutdown
- Can rollback via feature flag

**Rollback strategy:**
- Keep old in-memory state alongside new persistence
- Feature flag: `ENABLE_STATE_PERSISTENCE=true/false`
- Can switch back instantly if issues arise

#### Phase 1 Summary

| Metric | Value |
|--------|-------|
| **Effort** | ~17 hours (3 days) |
| **Files created** | 6 new files |
| **Files modified** | 2 (server.js, docker-compose.yml) |
| **Tests added** | 30-40 tests |
| **Risk level** | LOW-MEDIUM |

**Deployment strategy:**
1. Deploy with `ENABLE_STATE_PERSISTENCE=false` (existing behavior)
2. Monitor for 24 hours
3. Enable persistence with `ENABLE_STATE_PERSISTENCE=true`
4. Verify state loads correctly after container restart
5. Roll back if any issues (just disable flag)

---

### Phase 2: Code Structure & Modularity (Week 1: Days 4-7)

**Goal**: Improve maintainability without changing behavior

**Priority**: HIGH

#### 2.1 Extract Configuration (2 hours)

**Create: `/manager/config/index.js`**
```javascript
module.exports = {
  config: {
    hpcUser: process.env.HPC_SSH_USER || 'domeally',
    defaultHpc: process.env.DEFAULT_HPC || 'gemini',
    codeServerPort: parseInt(process.env.CODE_SERVER_PORT) || 8000,
    defaultCpus: process.env.DEFAULT_CPUS || '2',
    defaultMem: process.env.DEFAULT_MEM || '40G',
    defaultTime: process.env.DEFAULT_TIME || '12:00:00',
  },

  clusters: {
    gemini: {
      host: process.env.GEMINI_SSH_HOST || 'gemini-login2.coh.org',
      partition: 'compute',
      singularityBin: '/packages/easy-build/software/singularity/3.7.0/bin/singularity',
      singularityImage: '/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.19.sif',
      rLibsSite: '/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.19',
      bindPaths: '/packages,/run,/scratch,/ref_genomes',
    },

    apollo: {
      host: process.env.APOLLO_SSH_HOST || 'ppxhpcacc01.coh.org',
      partition: 'fast,all',
      singularityBin: '/opt/singularity/3.7.0/bin/singularity',
      singularityImage: '/opt/singularity-images/rbioc/vscode-rbioc_3.19.sif',
      rLibsSite: '/opt/singularity-images/rbioc/rlibs/bioc-3.19',
      bindPaths: '/opt,/run,/labs',
    },
  },
};
```

#### 2.2 Extract HPC Service Layer (6 hours)

**Create: `/manager/services/hpc.js`**
```javascript
const { spawn, exec } = require('child_process');
const { clusters, config } = require('../config');

class HpcService {
  constructor(clusterName) {
    this.cluster = clusters[clusterName];
    this.name = clusterName;
    if (!this.cluster) {
      throw new Error(`Unknown cluster: ${clusterName}`);
    }
  }

  /**
   * Execute SSH command on cluster
   */
  async exec(command) {
    return new Promise((resolve, reject) => {
      exec(`ssh ${this.cluster.host} "${command}"`, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Query job status via squeue
   */
  async getJobInfo(jobId) {
    const cmd = `squeue -j ${jobId} --format="%i %t %N %L %C %m %V" --noheader`;
    const output = await this.exec(cmd);

    if (!output) return null;

    const [id, state, node, timeLeft, cpus, mem, submitTime] = output.split(/\s+/);
    return { jobId: id, state, node, timeLeft, cpus, mem, submitTime };
  }

  /**
   * Submit sbatch job
   */
  async submitJob(cpus, mem, time) {
    const logDir = `/home/${config.hpcUser}/vscode-slurm-logs`;
    const submitCmd = `sbatch --job-name=code-server --nodes=1 --cpus-per-task=${cpus} --mem=${mem} --partition=${this.cluster.partition} --time=${time} --output=${logDir}/code-server_%j.log --error=${logDir}/code-server_%j.err --wrap='mkdir -p ${logDir} && ${this.cluster.singularityBin} exec --env TERM=xterm-256color --env R_LIBS_SITE=${this.cluster.rLibsSite} -B ${this.cluster.bindPaths} ${this.cluster.singularityImage} code serve-web --host 0.0.0.0 --port ${config.codeServerPort} --without-connection-token --accept-server-license-terms --server-base-path /vscode-direct --server-data-dir ~/.vscode-slurm/.vscode-server --extensions-dir ~/.vscode-slurm/.vscode-server/extensions --user-data-dir ~/.vscode-slurm/user-data'`;

    const output = await this.exec(submitCmd);
    const match = output.match(/Submitted batch job (\d+)/);
    if (!match) throw new Error('Failed to parse job ID from: ' + output);

    return match[1];
  }

  /**
   * Cancel job via scancel
   */
  async cancelJob(jobId) {
    await this.exec(`scancel ${jobId}`);
  }

  /**
   * Wait for job to get node assignment
   */
  async waitForNode(jobId, timeout = 300000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const info = await this.getJobInfo(jobId);
      if (!info) throw new Error('Job disappeared');
      if (info.state === 'RUNNING' && info.node) {
        return info.node;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('Timeout waiting for node assignment');
  }
}

module.exports = HpcService;
```

**Create: `/manager/test/unit/hpc.test.js`**

Unit tests with sinon stubs:
- Mock SSH exec calls
- Test error handling
- Verify command construction
- Test job submission parsing

#### 2.3 Extract Tunnel Service (5 hours)

**Create: `/manager/services/tunnel.js`**
```javascript
const { spawn } = require('child_process');
const { config } = require('../config');

class TunnelService {
  constructor() {
    this.processes = new Map(); // hpc -> process
  }

  /**
   * Start SSH tunnel to compute node
   */
  async start(hpc, node, port = config.codeServerPort) {
    const host = require('../config').clusters[hpc].host;

    const sshProcess = spawn('ssh', [
      '-N',
      '-L', `${port}:${node}:${port}`,
      host,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    sshProcess.stdout.on('data', (data) => {
      console.log(`SSH: ${data}`);
    });

    sshProcess.stderr.on('data', (data) => {
      console.error(`SSH: ${data}`);
    });

    sshProcess.on('exit', (code) => {
      console.log(`Tunnel for ${hpc} exited with code ${code}`);
      this.processes.delete(hpc);
    });

    this.processes.set(hpc, sshProcess);

    // Wait for port to become available
    await this.checkPort(port, 30000);

    return sshProcess;
  }

  /**
   * Stop tunnel
   */
  stop(hpc) {
    const process = this.processes.get(hpc);
    if (process) {
      process.kill();
      this.processes.delete(hpc);
    }
  }

  /**
   * Check if tunnel is active
   */
  isActive(hpc) {
    const process = this.processes.get(hpc);
    return process && !process.killed;
  }

  /**
   * Check if port is available
   */
  async checkPort(port, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const net = require('net');
        const client = new net.Socket();

        await new Promise((resolve, reject) => {
          client.connect(port, 'localhost', () => {
            client.end();
            resolve();
          });
          client.on('error', reject);
        });

        return true; // Port is open
      } catch (e) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`Port ${port} not available after ${timeout}ms`);
  }
}

module.exports = TunnelService;
```

**Create: `/manager/test/integration/tunnel.test.js`**

Integration tests:
- Can start/stop tunnel
- Port availability checking
- Cleanup on exit
- Multiple tunnels

#### 2.4 Extract API Routes (5 hours)

**Create: `/manager/routes/api.js`**
```javascript
const express = require('express');
const router = express.Router();
const HpcService = require('../services/hpc');
const TunnelService = require('../services/tunnel');
const StateManager = require('../lib/state');
const { validateSbatchInputs, validateHpcName } = require('../lib/validation');

const stateManager = new StateManager();
const tunnelService = new TunnelService();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Get session status
router.get('/status', (req, res) => {
  res.json(stateManager.state);
});

// Launch session
router.post('/launch', async (req, res) => {
  try {
    const { hpc = 'gemini', cpus = '2', mem = '40G', time = '12:00:00' } = req.body;

    validateHpcName(hpc);
    validateSbatchInputs(cpus, mem, time);

    const hpcService = new HpcService(hpc);

    // Submit job
    const jobId = await hpcService.submitJob(cpus, mem, time);
    await stateManager.updateSession(hpc, { status: 'starting', jobId });

    // Wait for node
    const node = await hpcService.waitForNode(jobId);
    await stateManager.updateSession(hpc, { node });

    // Start tunnel
    await tunnelService.start(hpc, node);
    await stateManager.updateSession(hpc, { status: 'running' });

    res.json({ status: 'running', jobId, node, hpc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop session
router.post('/stop/:hpc?', async (req, res) => {
  try {
    const hpc = req.params.hpc || stateManager.state.activeHpc;
    if (!hpc) {
      return res.status(400).json({ error: 'No active session' });
    }

    validateHpcName(hpc);

    const session = stateManager.state.sessions[hpc];
    if (session?.jobId) {
      const hpcService = new HpcService(hpc);
      await hpcService.cancelJob(session.jobId);
    }

    tunnelService.stop(hpc);
    await stateManager.clearSession(hpc);

    res.json({ status: 'stopped', hpc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

**Update: `server.js`**
```javascript
const express = require('express');
const apiRoutes = require('./routes/api');

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

// ... rest of server.js (frontend routes, proxy, etc.)
```

#### 2.5 Extract Frontend Assets (4 hours)

**Create: `/manager/public/`**
```
public/
├── index.html           (renderLauncherPage)
├── vscode-wrapper.html  (renderVscodeWrapper)
├── menu-frame.html      (menu iframe content)
├── css/
│   └── style.css
└── js/
    ├── launcher.js
    ├── menu.js
    └── drag.js
```

Extract all HTML/CSS/JS from template literals in server.js

**Update: `server.js`**
```javascript
app.use(express.static('public'));
```

**Success criteria:**
- UI looks identical
- No functional changes
- Easier to edit with IDE support

#### Phase 2 Summary

| Metric | Value |
|--------|-------|
| **Effort** | ~22 hours (4 days) |
| **Files created** | 12 new files |
| **Lines removed from server.js** | ~1000 |
| **New server.js size** | ~600 lines |
| **Risk level** | MEDIUM |

**New directory structure:**
```
manager/
├── server.js              (600 lines - orchestration only)
├── config/
│   └── index.js
├── lib/
│   ├── validation.js
│   ├── helpers.js
│   └── state.js
├── services/
│   ├── hpc.js
│   └── tunnel.js
├── routes/
│   └── api.js
├── public/
│   ├── index.html
│   ├── vscode-wrapper.html
│   ├── menu-frame.html
│   ├── css/
│   └── js/
└── test/
    ├── unit/
    └── integration/
```

**Deployment strategy:**
1. Incremental extraction (one service at a time)
2. Run full test suite after each extraction
3. Manual smoke testing after each deploy
4. Keep git commits small and atomic
5. Each commit can be deployed independently

---

### Phase 3: Advanced Reliability (Week 2: Days 1-3)

**Goal**: Production hardening

**Priority**: MEDIUM (can be deferred if time-constrained)

#### 3.1 Operation Locks (3 hours)

**Prevent race conditions when multiple launch requests overlap**

**Update: `/manager/lib/state.js`**
```javascript
class StateManager {
  constructor() {
    this.state = { sessions: {}, activeHpc: null };
    this.locks = new Set(); // Track active operations
  }

  async acquireLock(operation) {
    if (this.locks.has(operation)) {
      throw new Error('Operation already in progress');
    }
    this.locks.add(operation);
  }

  releaseLock(operation) {
    this.locks.delete(operation);
  }
}
```

**Update: `/manager/routes/api.js`**
```javascript
router.post('/launch', async (req, res) => {
  try {
    await stateManager.acquireLock('launch');
    // ... existing launch logic
  } catch (error) {
    if (error.message === 'Operation already in progress') {
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    res.status(500).json({ error: error.message });
  } finally {
    stateManager.releaseLock('launch');
  }
});
```

**Success criteria:**
- Concurrent launches return 429 Too Many Requests
- Lock always released (even on error)
- Zero race conditions in testing

#### 3.2 Enhanced Error Handling (4 hours)

**Create: `/manager/lib/errors.js`**
```javascript
class HpcError extends Error {
  constructor(message, code = 500, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'HpcError';
  }
}

class ValidationError extends HpcError {
  constructor(message, details) {
    super(message, 400, details);
    this.name = 'ValidationError';
  }
}

class SshError extends HpcError {
  constructor(message, details) {
    super(message, 502, details);
    this.name = 'SshError';
  }
}

module.exports = { HpcError, ValidationError, SshError };
```

**Update: `server.js`**
```javascript
const { HpcError } = require('./lib/errors');

app.use((err, req, res, next) => {
  if (err instanceof HpcError) {
    return res.status(err.code).json({
      error: err.message,
      details: err.details,
      timestamp: new Date(),
    });
  }

  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});
```

#### 3.3 Logging & Observability (3 hours)

**Add: `winston` logger**
```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

module.exports = logger;
```

#### 3.4 SSH Connection Pooling (6 hours)

**Create: `/manager/services/ssh-pool.js`**

Future-proofing for multi-backend support

**Note**: This is preparatory work. Not required for current use case.

#### Phase 3 Summary

| Metric | Value |
|--------|-------|
| **Effort** | ~16 hours (3-4 days) |
| **Priority** | Can be deferred if time-constrained |
| **Risk level** | LOW |

---

### Phase 4: Testing & Documentation (Ongoing)

**Goal**: Confidence and maintainability

#### 4.1 Integration Tests (8 hours)

**Create: `/manager/test/integration/api.test.js`**
```javascript
const request = require('supertest');
const { expect } = require('chai');
const sinon = require('sinon');

describe('POST /api/launch', () => {
  let app, sshStub;

  beforeEach(() => {
    app = require('../server'); // Import app
    sshStub = sinon.stub().resolves('Submitted batch job 12345');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should submit job and establish tunnel', async () => {
    const res = await request(app)
      .post('/api/launch')
      .send({ hpc: 'gemini', cpus: '4', mem: '40G', time: '12:00:00' })
      .expect(200);

    expect(res.body.status).to.equal('running');
    expect(res.body.jobId).to.match(/^\d+$/);
  });

  it('should reject invalid CPU count', async () => {
    const res = await request(app)
      .post('/api/launch')
      .send({ hpc: 'gemini', cpus: '-1', mem: '40G', time: '12:00:00' })
      .expect(400);

    expect(res.body.error).to.include('Invalid CPU value');
  });
});
```

Test scenarios:
- Happy path (launch → connect → stop)
- Error paths (invalid inputs, SSH failures)
- Multi-session management
- State persistence across restarts

#### 4.2 E2E Tests with Chrome Extension (12 hours)

**Add: `puppeteer`**
```json
{
  "devDependencies": {
    "puppeteer": "^21.0.0"
  }
}
```

**Create: `/manager/test/e2e/user-journey.test.js`**
```javascript
const puppeteer = require('puppeteer');
const { expect } = require('chai');

describe('Full User Journey', () => {
  let browser, page;

  beforeEach(async () => {
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
  });

  afterEach(async () => {
    await browser.close();
  });

  it('should launch session and access VS Code', async () => {
    // 1. Load launcher page
    await page.goto('http://localhost:3000');
    await page.waitForSelector('#gemini-card');

    // 2. Fill in resource form
    await page.type('#cpus-input', '4');
    await page.type('#mem-input', '40G');
    await page.type('#time-input', '12:00:00');

    // 3. Click launch
    await page.click('button:contains("Launch Session")');

    // 4. Wait for redirect to /code/
    await page.waitForNavigation();
    expect(page.url()).to.include('/code/');

    // 5. Verify VS Code UI loads
    await page.waitForSelector('iframe');
    const iframe = await page.$('iframe');
    const iframeSrc = await iframe.evaluate(el => el.src);
    expect(iframeSrc).to.include('/vscode-direct/');

    // 6. Open file and verify functionality
    // TODO: Test VS Code features

    // 7. Kill job and verify cleanup
    await page.click('#kill-job-button');
    await page.waitForSelector('.status-idle');
  });

  it('should handle concurrent sessions on different HPCs', async () => {
    // TODO: Test multi-session management
  });
});
```

Test matrix:
- Different browsers (Chrome, Firefox)
- Different screen sizes
- Concurrent sessions
- Error handling (job failures, SSH timeouts)

**Chrome Extension Integration:**
- Test tab management
- Clipboard operations
- Keyboard shortcuts
- Menu drag-and-drop
- Screenshot/video capture on failures

#### 4.3 Documentation (6 hours)

**Create: `/manager/docs/`**

1. **ARCHITECTURE.md** - System design, data flow, module interactions
2. **API.md** - API endpoint documentation with examples
3. **DEPLOYMENT.md** - How to deploy, rollback, feature flags
4. **TESTING.md** - How to run tests, CI/CD integration
5. **CONTRIBUTING.md** - Development workflow, coding standards

**Add JSDoc comments** to all functions

**Generate API docs** with `jsdoc`

#### Phase 4 Summary

| Metric | Value |
|--------|-------|
| **Effort** | ~26 hours (5-6 days) |
| **Can run in parallel** | With Phases 2-3 |
| **Risk level** | LOW |

---

## Testing Strategy

### Unit Tests

**Scope**: Pure functions (validation, helpers, utilities)
**Framework**: Mocha + Chai
**Coverage Goal**: 100% for lib/ and services/
**Run Frequency**: On every commit (pre-commit hook)

**Example:**
```javascript
describe('validateSbatchInputs', () => {
  it('should accept valid inputs', () => {
    expect(() => validateSbatchInputs('4', '40G', '12:00:00')).to.not.throw();
  });

  it('should reject command injection in time', () => {
    expect(() => validateSbatchInputs('4', '40G', '0; rm -rf /')).to.throw();
  });

  it('should reject negative CPUs', () => {
    expect(() => validateSbatchInputs('-1', '40G', '12:00:00')).to.throw('Invalid CPU value');
  });
});
```

### Integration Tests

**Scope**: API endpoints, database operations, SSH interactions
**Framework**: Mocha + Supertest + Sinon
**Coverage Goal**: All API routes, state persistence
**Run Frequency**: Before deployment

**Mock Strategy:**
- Mock SSH exec with `sinon.stub()`
- Mock file system with `memfs`
- Mock child processes with `sinon.fake()`

**Example:**
```javascript
describe('POST /api/launch', () => {
  let sshStub;

  beforeEach(() => {
    sshStub = sinon.stub().resolves('Submitted batch job 12345');
  });

  it('should create session and return job ID', async () => {
    const res = await request(app)
      .post('/api/launch')
      .send({ hpc: 'gemini' })
      .expect(200);

    expect(sshStub).to.have.been.calledOnce;
    expect(res.body.jobId).to.equal('12345');
  });
});
```

### E2E Tests

**Scope**: Full user workflows via browser
**Framework**: Puppeteer + Mocha
**Coverage Goal**: Critical paths (launch, connect, kill)
**Run Frequency**: Before major releases

**Chrome Extension Integration:**
- Test browser automation capabilities
- Verify tab management
- Test clipboard and keyboard shortcuts
- Drag-and-drop menu functionality

**Example:**
```javascript
describe('User can launch and connect to session', () => {
  it('should complete full workflow', async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.goto('http://localhost:3000');
    await page.waitForSelector('#gemini-card');
    await page.click('button:contains("Launch Session")');
    await page.waitForNavigation();

    expect(page.url()).to.include('/code/');
    await browser.close();
  });
});
```

---

## Deployment Strategy

### Incremental Rollout

**Phase 1 Deployment:**
```bash
# Day 1: Testing infrastructure (no behavior change)
git checkout -b phase1-tests
npm install
npm test  # Should pass (or skip if no tests yet)
git commit -m "feat: Add testing infrastructure"
git push
docker compose build && docker compose up -d
# Verify app still works

# Day 2: Extract validation (testable, low risk)
git checkout -b phase1-validation
# ... implement validation.js
npm test  # Run new validation tests
git commit -m "refactor: Extract validation to lib/validation.js"
git push
docker compose build && docker compose up -d
# Verify app still works

# Day 3: State persistence (feature-flagged)
git checkout -b phase1-state
# ... implement state.js
ENABLE_STATE_PERSISTENCE=false docker compose up -d  # Old behavior
# Test for 24 hours
ENABLE_STATE_PERSISTENCE=true docker compose up -d   # New behavior
# Test state survives restart
docker compose restart
# Verify sessions recovered
```

**Phase 2 Deployment:**
- One service extraction per day
- Full test suite after each
- Smoke test in production
- Can rollback any single commit

**Rollback Strategy:**
```bash
# If Phase 1 state persistence fails
docker compose down
# Edit .env: ENABLE_STATE_PERSISTENCE=false
docker compose up -d
# Back to old behavior instantly

# If Phase 2 service extraction fails
git revert HEAD
docker compose build && docker compose up -d
# Reverted to previous working version
```

### Success Criteria Per Phase

**Phase 1 Success Metrics:** ✅ COMPLETE
- [x] All unit tests passing (>30 tests) - **167 tests passing**
- [x] State persistence feature flag works
- [x] Container restart preserves sessions
- [x] Zero functional regressions
- [x] Test coverage >80% on new code

**Phase 2 Success Metrics:** ✅ COMPLETE
- [x] server.js reduced to <700 lines - **196 lines**
- [x] All services have unit tests - **HPC, Tunnel, State**
- [x] API endpoints unchanged (backward compatible)
- [x] Frontend UI identical to before
- [x] Zero functional regressions

**Phase 3 Success Metrics:** ✅ COMPLETE
- [x] No race conditions under load testing - **Operation locks with LockError (429)**
- [x] Structured error responses on all endpoints - **Custom error classes (HpcError, ValidationError, SshError, JobError, TunnelError, LockError, NotFoundError)**
- [x] Logs aggregated and searchable - **Winston logger with domain methods (ssh, job, tunnel, lock, api, ui, state, proxy)**
- [x] Zero SSH connection leaks - **TunnelService manages all tunnels**

**Phase 4 Success Metrics:** ✅ COMPLETE
- [x] E2E tests cover 3 critical paths - **15 Puppeteer tests passing**
- [x] Browser tests work with system Chrome (macOS LNP workaround)
- [x] Documentation complete and accurate - **ARCHITECTURE.md, API.md**
- [x] New developers can onboard in <1 day

---

## Risk Mitigation

### High-Risk Items

1. **State persistence** (Phase 1.4)
   - **Risk**: Data corruption, failed reconciliation
   - **Mitigation**: Feature flag, extensive testing, JSON schema validation
   - **Rollback**: Instant via feature flag

2. **Service extraction** (Phase 2.1-2.2)
   - **Risk**: Breaking API contracts, state management issues
   - **Mitigation**: Keep old code alongside new, comprehensive tests
   - **Rollback**: Git revert individual commits

3. **Connection pooling** (Phase 3.4)
   - **Risk**: SSH connection leaks, authentication failures
   - **Mitigation**: Defer to Phase 3 (not required for Phase 1-2)
   - **Rollback**: Disable pool, use direct exec

### Testing Requirements Before Production

**Before Phase 1 Deployment:**
- [ ] Unit tests: 30+ passing
- [ ] Integration tests: 10+ passing
- [ ] Manual testing: All API endpoints work
- [ ] State persistence: Survives 3 restarts
- [ ] Security: Validation tests include injection attempts

**Before Phase 2 Deployment:**
- [ ] All Phase 1 tests still passing
- [ ] Unit tests for all new services
- [ ] Frontend UI visually identical
- [ ] API responses unchanged (JSON diff = empty)
- [ ] Performance: Response times within 10% of baseline

**Before Phase 3 Deployment:**
- [ ] Load testing: 10 concurrent requests handled
- [ ] Race condition testing: No locks stuck
- [ ] Error handling: All error paths tested
- [ ] Logging: All operations logged

---

## File Structure Evolution

### Before (Current)
```
manager/
├── server.js           (1688 lines - everything)
├── package.json
├── package-lock.json
└── Dockerfile
```

### After Phase 1
```
manager/
├── server.js           (1600 lines)
├── lib/
│   ├── validation.js   (30 lines)
│   ├── helpers.js      (50 lines)
│   └── state.js        (100 lines)
├── test/
│   ├── unit/
│   │   ├── validation.test.js
│   │   ├── helpers.test.js
│   │   └── state.test.js
│   └── integration/
│       └── state.test.js
├── package.json
└── Dockerfile
```

### After Phase 2 (Final)
```
manager/
├── server.js              (600 lines - orchestration)
├── config/
│   └── index.js           (50 lines)
├── lib/
│   ├── validation.js      (30 lines)
│   ├── helpers.js         (50 lines)
│   └── state.js           (120 lines)
├── services/
│   ├── hpc.js             (200 lines)
│   └── tunnel.js          (150 lines)
├── routes/
│   └── api.js             (300 lines)
├── public/
│   ├── index.html         (200 lines)
│   ├── vscode-wrapper.html (100 lines)
│   ├── menu-frame.html    (100 lines)
│   ├── css/
│   │   └── style.css      (200 lines)
│   └── js/
│       ├── launcher.js    (150 lines)
│       ├── menu.js        (100 lines)
│       └── drag.js        (50 lines)
├── test/
│   ├── unit/              (10 files)
│   ├── integration/       (5 files)
│   └── e2e/               (3 files)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── TESTING.md
├── package.json
└── Dockerfile
```

**Total Lines of Code:**
- **Before**: 1688 lines in one file
- **After**: ~2400 lines across 30 files (with tests and docs)
- **Test code**: ~800 lines
- **Documentation**: ~500 lines
- **Production code**: ~1100 lines (35% reduction in production code)

---

## Timeline Summary

**Week 1:**
- Days 1-3: Phase 1 (Testing + State Persistence)
- Days 4-7: Phase 2 (Code Structure)

**Week 2:**
- Days 1-3: Phase 3 (Advanced Reliability)
- Days 4-5: Phase 4 (E2E Tests + Documentation)

**Total Calendar Time**: 10 business days
**Total Effort**: ~81 hours
**Deployments**: 8-10 incremental deployments
**Risk**: LOW (feature flags, small commits, comprehensive tests)

**Quick Wins Achieved (First 3 days):**
- ✅ Test infrastructure
- ✅ Security validation tested and proven
- ✅ State persistence (no more orphaned processes)
- ✅ Helper functions extracted and tested
- ✅ 40+ tests passing

This provides immediate reliability improvements while setting up the foundation for the larger refactoring in Phase 2.

---

## References

- **HPC_REVIEW.md**: https://github.com/drejom/omhq-hpc-code-server-stack/blob/claude/vscode-slurm-research-s9pBE/HPC_REVIEW.md
- **REFACTOR.md (PR #1)**: https://github.com/drejom/omhq-hpc-code-server-stack/pull/1
- **Current codebase**: `/Users/domeally/workspaces/truenas_upgrade/repos/omhq-hpc-code-server-stack/`

---

## Next Steps

1. ✅ Review and approve this SPEC
2. Create feature branch: `refactor/phase1-foundation`
3. Start with Phase 1.1: Testing infrastructure
4. Implement incrementally, test thoroughly
5. Deploy with confidence

---

**Document Version**: 1.2
**Last Updated**: 2025-12-31
**Status**: Phase 1-4 Complete | All refactoring goals achieved
