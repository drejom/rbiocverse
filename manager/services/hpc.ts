/**
 * HPC Service Layer
 * Handles SLURM job management and SSH operations for HPC clusters
 */

import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config, clusters, ides, gpuConfig, releases, defaultReleaseVersion, getReleasePaths, vscodeDefaults, rstudioDefaults, jupyterlabDefaults } from '../config';
import { log } from '../lib/logger';
import { withClusterQueue } from '../lib/ssh-queue';
import type { JobInfo } from '../lib/state/types';

// Per-user SSH key support - lazy loaded to avoid circular dependency
let getUserPrivateKey: ((username: string) => string | null) | null = null;
let getAdminPrivateKey: (() => Promise<string | null>) | null = null;
function loadAuthModule(): void {
  if (!getUserPrivateKey) {
    const auth = require('../routes/auth');
    getUserPrivateKey = auth.getUserPrivateKey;
    getAdminPrivateKey = auth.getAdminPrivateKey;
  }
}

// Directory for SSH key files (inside data volume, persisted across restarts)
const SSH_KEY_DIR = path.join(__dirname, '..', 'data', 'ssh-keys');

// Directory for SSH ControlMaster sockets (per-user-cluster multiplexing)
// Use /tmp for short paths (Unix socket paths limited to ~104 bytes)
const SSH_SOCKET_DIR = '/tmp/rbiocverse-ssh';


interface JobSubmitResult {
  jobId: string;
  token: string | null;
}

interface SubmitOptions {
  gpu?: string;
  releaseVersion?: string;
}

interface WaitForNodeOptions {
  maxAttempts?: number;
  returnPendingOnTimeout?: boolean;
}

interface WaitForNodeResult {
  node?: string;
  pending?: boolean;
  jobId?: string;
}

interface CancelJobsResult {
  cancelled: string[];
  failed: string[];
}

interface ClusterHealth {
  online: boolean;
  cpus?: { used: number; idle: number; total: number; percent: number };
  memory?: { used: number; total: number; unit: string; percent: number };
  nodes?: { idle: number; busy: number; down: number; total: number; percent?: number };
  gpus?: Record<string, { idle: number; busy: number; total: number }> & { percent?: number } | null;
  partitions?: Record<string, { cpus: { used: number; idle: number; total: number; percent: number } | null }> | null;
  runningJobs?: number;
  pendingJobs?: number;
  fairshare?: number | null;
  lastChecked: number;
  error?: string;
}

interface HealthOptions {
  userAccount?: string;
}

interface VscodeOptions {
  token?: string;
  releaseVersion?: string;
  cpus?: number;
}

interface RstudioOptions {
  releaseVersion?: string;
}

interface JupyterOptions {
  gpu?: string;
  token?: string;
  releaseVersion?: string;
  cpus?: number;
}

/**
 * Get or create a key file for a user
 * Keys are stored in data/ssh-keys/<username>.key
 */
function getKeyFilePath(username: string, privateKey: string): string {
  // Ensure directory exists
  if (!fs.existsSync(SSH_KEY_DIR)) {
    fs.mkdirSync(SSH_KEY_DIR, { mode: 0o700, recursive: true });
  }

  const keyPath = path.join(SSH_KEY_DIR, `${username}.key`);

  // Write key if it doesn't exist or has changed
  // Use hash to detect changes without reading the file
  const keyHash = crypto.createHash('sha256').update(privateKey).digest('hex').substring(0, 8);
  const hashPath = path.join(SSH_KEY_DIR, `${username}.hash`);

  let needsWrite = true;
  if (fs.existsSync(hashPath)) {
    try {
      const existingHash = fs.readFileSync(hashPath, 'utf8').trim();
      needsWrite = (existingHash !== keyHash);
    } catch {
      // Ignore read errors, will rewrite
    }
  }

  if (needsWrite) {
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(hashPath, keyHash, { mode: 0o600 });
    log.debug('Wrote SSH key file', { username, keyPath });
  }

  return keyPath;
}

/**
 * Generate a secure random token for IDE authentication
 */
function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate shell script to find an available port starting from defaultPort.
 * Writes the chosen port to a file for the manager to read when establishing tunnels.
 */
function buildPortFinderScript(defaultPort: number, portFile: string): string {
  const script = `#!/bin/sh
# Find available port starting from ${defaultPort}
PORT=${defaultPort}
until ! netstat -ln | grep "  LISTEN  " | grep -iEo ":[0-9]+" | cut -d: -f2 | grep -wqc $PORT; do
  PORT=$((PORT + 1))
  if [ $PORT -gt $((${defaultPort} + 100)) ]; then
    echo "ERROR: Could not find available port after 100 attempts" >&2
    exit 1
  fi
done
echo $PORT > ${portFile}
echo "export IDE_PORT=$PORT"
`;
  return Buffer.from(script).toString('base64');
}

class HpcService {
  private clusterName: string;
  private cluster: typeof clusters[keyof typeof clusters];
  private username: string | null;

  constructor(clusterName: string, username: string | null = null) {
    this.clusterName = clusterName;
    this.cluster = clusters[clusterName];
    this.username = username;

    if (!this.cluster) {
      throw new Error(`Unknown cluster: ${clusterName}`);
    }
  }

  /**
   * Get user's default SLURM account
   */
  async getUserDefaultAccount(user: string | null = null): Promise<string | null> {
    const effectiveUser = user || config.hpcUser;
    try {
      const output = await this.sshExec(
        `sacctmgr show user ${effectiveUser} format=defaultaccount -nP 2>/dev/null`
      );
      const account = output.trim();
      if (account && account !== '') {
        log.info('User default account', { cluster: this.clusterName, user: effectiveUser, account });
        return account;
      }
      return null;
    } catch (e) {
      log.warn('Failed to get user default account', { cluster: this.clusterName, user: effectiveUser, error: (e as Error).message });
      return null;
    }
  }

  /**
   * Get SSH key options for command execution
   * Returns the key option flag and effective user for socket naming
   */
  private async _getSshKeyOptions(): Promise<{ keyOption: string; effectiveKeyUser: string }> {
    loadAuthModule();

    // Try per-user key first
    if (this.username) {
      const privateKey = getUserPrivateKey!(this.username);
      if (privateKey) {
        const keyPath = getKeyFilePath(this.username, privateKey);
        log.debugFor('ssh', 'using per-user key', { username: this.username, keyPath });
        return { keyOption: `-i ${keyPath} `, effectiveKeyUser: this.username };
      }
    }

    // Fall back to admin key
    if (getAdminPrivateKey) {
      const adminKey = await getAdminPrivateKey();
      if (adminKey) {
        const keyPath = getKeyFilePath('_admin', adminKey);
        log.debugFor('ssh', 'using admin key fallback', { cluster: this.clusterName });
        return { keyOption: `-i ${keyPath} `, effectiveKeyUser: '_admin' };
      }
    }

    // No key available - throw error instead of falling back to system SSH
    throw new Error('No SSH key configured. Please generate or import an SSH key in Key Management.');
  }

  /**
   * Execute SSH command directly (bypasses queue)
   * Internal method - use sshExec() for all external calls
   */
  private async _sshExecDirect(command: string): Promise<string> {
    log.ssh(`Executing on ${this.clusterName}`, { command: command.substring(0, 100) });
    log.debugFor('ssh', 'full command', { cluster: this.clusterName, command });

    // Ensure socket directory exists
    if (!fs.existsSync(SSH_SOCKET_DIR)) {
      fs.mkdirSync(SSH_SOCKET_DIR, { mode: 0o700, recursive: true });
    }

    const { keyOption, effectiveKeyUser } = await this._getSshKeyOptions();

    // SSH ControlMaster for connection multiplexing
    const socketPath = path.join(SSH_SOCKET_DIR, `${effectiveKeyUser}-${this.clusterName}`);
    const controlOptions = `-o ControlMaster=auto -o ControlPath=${socketPath} -o ControlPersist=30m`;

    const sshCmd = `ssh ${keyOption}${controlOptions} -o StrictHostKeyChecking=no ${config.hpcUser}@${this.cluster.host} 'bash -s'`;

    return new Promise((resolve, reject) => {
      const child = exec(
        sshCmd,
        { timeout: 60000 },
        (error, stdout, stderr) => {
          // Filter out OpenSSH post-quantum warnings
          const filteredStderr = stderr
            ?.replace(/\*\* WARNING:.*post-quantum.*\r?\n?/g, '')
            ?.replace(/\*\* This session may be vulnerable.*\r?\n?/g, '')
            ?.replace(/\*\* The server may need.*\r?\n?/g, '')
            ?.trim();

          if (error) {
            const filteredError = error.message
              ?.replace(/\*\* WARNING:.*post-quantum.*\r?\n?/g, '')
              ?.replace(/\*\* This session may be vulnerable.*\r?\n?/g, '')
              ?.replace(/\*\* The server may need.*\r?\n?/g, '')
              ?.trim();
            const errorMsg = filteredStderr || filteredError || 'SSH command failed';
            log.error('SSH command failed', { cluster: this.clusterName, error: errorMsg });
            reject(new Error(errorMsg));
          } else {
            resolve(stdout.trim());
          }
        }
      );

      // Write command to stdin
      child.stdin?.write(command);
      child.stdin?.end();
    });
  }

  /**
   * Execute SSH command on cluster (queued)
   */
  sshExec(command: string): Promise<string> {
    return withClusterQueue(this.clusterName, () => this._sshExecDirect(command));
  }

  /**
   * Get job information from SLURM queue for a specific IDE
   */
  async getJobInfo(ide = 'vscode'): Promise<JobInfo | null> {
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    try {
      // Use pipe delimiter to handle empty fields (e.g., NodeList for pending jobs)
      const output = await this.sshExec(
        `squeue --user=${config.hpcUser} --name=${ideConfig.jobName} --states=R,PD -h -o '%i|%T|%N|%L|%l|%C|%m|%S' 2>/dev/null | head -1`
      );

      if (!output) return null;

      const parts = output.split('|');
      if (parts.length !== 8) {
        log.warn(`Unexpected squeue output format: expected 8 fields, got ${parts.length}: "${output}"`);
        return null;
      }
      const [jobId, jobState, node, timeLeft, timeLimit, cpus, memory, startTime] = parts;

      return {
        jobId,
        ide,
        state: jobState,
        node: (!node || node === '(null)') ? null : node,
        timeLeft: timeLeft === 'INVALID' ? null : timeLeft,
        timeLimit: timeLimit === 'INVALID' ? null : timeLimit,
        cpus: cpus || null,
        memory: memory || null,
        startTime: (!startTime || startTime === 'N/A') ? null : startTime,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get job information for all IDEs on this cluster
   */
  async getAllJobs(user: string | null = null): Promise<Record<string, JobInfo | null>> {
    const effectiveUser = user || config.hpcUser;
    const jobNames = Object.values(ides).map(ide => ide.jobName).join(',');

    // Use pipe delimiter to handle empty fields (e.g., NodeList for pending jobs)
    const output = await this.sshExec(
      `squeue --user=${effectiveUser} --name=${jobNames} --states=R,PD -h -o '%i|%j|%T|%N|%L|%l|%C|%m|%S' 2>/dev/null`
    );

    const results: Record<string, JobInfo | null> = {};
    for (const ide of Object.keys(ides)) {
      results[ide] = null;
    }

    if (!output) return results;

    const lines = output.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      const parts = line.split('|');
      const [jobId, jobName, jobState, node, timeLeft, timeLimit, cpus, memory, startTime] = parts;

      const ide = Object.keys(ides).find(k => ides[k].jobName === jobName);
      if (!ide) continue;

      const parsedTimeLeft = (timeLeft && timeLeft !== 'INVALID' && timeLeft !== 'UNLIMITED')
        ? this.parseTimeToSeconds(timeLeft)
        : null;

      results[ide] = {
        jobId,
        ide,
        state: jobState,
        node: (!node || node === '(null)') ? null : node,
        timeLeft: timeLeft === 'INVALID' ? null : timeLeft,
        timeLeftSeconds: parsedTimeLeft,
        timeLimit: timeLimit === 'INVALID' ? null : timeLimit,
        cpus: cpus || null,
        memory: memory || null,
        startTime: (!startTime || startTime === 'N/A') ? null : startTime,
      };
    }

    return results;
  }

  /**
   * Build job script for VS Code
   */
  buildVscodeScript(options: VscodeOptions = {}): string {
    const { token, releaseVersion = defaultReleaseVersion, cpus = 1 } = options;
    const ideConfig = ides.vscode;
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    const dataDir = '$HOME/.vscode-slurm/.vscode-server';
    const machineSettingsDir = `${dataDir}/data/Machine`;
    const extensionsDir = `${dataDir}/extensions`;
    const builtinExtDir = vscodeDefaults.builtinExtensionsDir;

    const machineSettings = JSON.stringify(vscodeDefaults.settings, null, 2);
    const machineSettingsBase64 = Buffer.from(machineSettings).toString('base64');

    const keybindings = JSON.stringify(vscodeDefaults.keybindings, null, 2);
    const keybindingsBase64 = Buffer.from(keybindings).toString('base64');

    const bootstrapScript = `#!/bin/sh
# Bootstrap extensions from container image (if available)
if [ -d ${builtinExtDir} ]; then
  for ext in ${builtinExtDir}/*; do
    name=\${ext##*/}
    [ -d "$HOME/.vscode-slurm/.vscode-server/extensions/$name" ] || cp -r "$ext" "$HOME/.vscode-slurm/.vscode-server/extensions/"
  done
fi
# Bootstrap keybindings (only if user hasn't customized)
keybindingsFile="$HOME/.vscode-slurm/.vscode-server/data/User/keybindings.json"
if [ ! -f "$keybindingsFile" ]; then
  mkdir -p "$HOME/.vscode-slurm/.vscode-server/data/User"
  echo ${keybindingsBase64} | base64 -d > "$keybindingsFile"
fi
`;
    const bootstrapBase64 = Buffer.from(bootstrapScript).toString('base64');

    const portFile = '$HOME/.vscode-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    const tokenArg = token ? `--connection-token=${token}` : '--without-connection-token';

    const singularityEnvArgs = [
      '--env TERM=xterm-256color',
      `--env R_LIBS_SITE=${releasePaths.rLibsSite}`,
      pythonSitePackages ? `--env PYTHONPATH=${pythonSitePackages}` : '',
      '--env RETICULATE_PYTHON=/usr/bin/python3',
      '--env RETICULATE_PYTHON_FALLBACK=FALSE',
      `--env SHINY_PORT=${ides.shiny?.port || 3838}`,
      `--env OMP_NUM_THREADS=${cpus}`,
      `--env MKL_NUM_THREADS=${cpus}`,
      `--env OPENBLAS_NUM_THREADS=${cpus}`,
      `--env NUMEXPR_NUM_THREADS=${cpus}`,
      `--env MC_CORES=${cpus}`,
      `--env BIOCPARALLEL_WORKER_NUMBER=${cpus}`,
    ].filter(Boolean).join(' \\\n  ');

    return `#!/bin/bash
# Redirect stderr to log file immediately for debugging
exec 2>$HOME/.vscode-slurm/job.err
set -ex

# Setup directories
mkdir -p ${machineSettingsDir} ${extensionsDir}
mkdir -p $HOME/.vscode-slurm/run/user/$(id -u)
chmod 700 $HOME/.vscode-slurm/run/user/$(id -u)

# Write Machine settings
echo ${machineSettingsBase64} | base64 -d > ${machineSettingsDir}/settings.json

# Run bootstrap script (extensions + keybindings)
echo ${bootstrapBase64} | base64 -d | sh

# Find available port and export as IDE_PORT
eval $(echo ${portFinderBase64} | base64 -d | sh -s)

# Start hpc-proxy for dev server port routing (runs inside container)
# Note: hpc-proxy runs in background; SLURM cleans it up when job ends
mkdir -p $HOME/.hpc-proxy
${this.cluster.singularityBin} exec ${releasePaths.singularityImage} \\
  /usr/local/bin/hpc-proxy --port 0 --base-rewrite --verbose > $HOME/.hpc-proxy/proxy.log 2>&1 &

# Wait for proxy to write port file (up to 5 seconds)
for ((i=0; i<10; i++)); do
  [ -f $HOME/.hpc-proxy/port ] && break
  sleep 0.5
done

# Log proxy port for debugging and create status marker
if [ -f $HOME/.hpc-proxy/port ]; then
  echo "hpc-proxy started on port $(cat $HOME/.hpc-proxy/port)" >> $HOME/.vscode-slurm/job.err
  echo "ok" > $HOME/.hpc-proxy/status
else
  echo "WARNING: hpc-proxy failed to start - dev server routing unavailable" >> $HOME/.vscode-slurm/job.err
  echo "failed" > $HOME/.hpc-proxy/status
fi

# Start VS Code server
exec ${this.cluster.singularityBin} exec \\
  ${singularityEnvArgs} \\
  -B $HOME/.vscode-slurm/run:/run \\
  -B ${this.cluster.bindPaths} \\
  ${releasePaths.singularityImage} \\
  code serve-web \\
    --host 0.0.0.0 \\
    --port $IDE_PORT \\
    ${tokenArg} \\
    --accept-server-license-terms \\
    --server-base-path /vscode-direct \\
    --server-data-dir ${dataDir} \\
    --cli-data-dir ${dataDir}/cli
`;
  }

  /**
   * Build job script for RStudio
   */
  buildRstudioScript(cpus: number, options: RstudioOptions = {}): string {
    const { releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides.rstudio;
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';
    const workdir = '$HOME/.rstudio-slurm/workdir';

    const dbConf = `provider=sqlite
directory=/var/lib/rstudio-server
`;
    const dbConfBase64 = Buffer.from(dbConf).toString('base64');

    const rserverConf = `rsession-which-r=/usr/local/bin/R
auth-cookies-force-secure=0
www-root-path=/rstudio-direct
`;
    const rserverConfBase64 = Buffer.from(rserverConf).toString('base64');

    const rstudioPrefs = JSON.stringify(rstudioDefaults);
    const rstudioPrefsBase64 = Buffer.from(rstudioPrefs).toString('base64');

    const biocVersion = releaseVersion;

    const rsessionScript = `#!/bin/sh
exec 2>>$HOME/.rstudio-slurm/rsession.log
set -x
export R_HOME=/usr/local/lib/R
export LD_LIBRARY_PATH=/usr/local/lib/R/lib:/usr/local/lib
export OMP_NUM_THREADS=${cpus}
export MKL_NUM_THREADS=${cpus}
export OPENBLAS_NUM_THREADS=${cpus}
export NUMEXPR_NUM_THREADS=${cpus}
export MC_CORES=${cpus}
export BIOCPARALLEL_WORKER_NUMBER=${cpus}
export R_LIBS_SITE=${releasePaths.rLibsSite}
export R_LIBS_USER=$HOME/R/bioc-${biocVersion}
export TMPDIR=/tmp
export TZ=America/Los_Angeles
export PYTHONPATH=${pythonSitePackages}
export RETICULATE_PYTHON=/usr/bin/python3
export RETICULATE_PYTHON_FALLBACK=FALSE
exec /usr/lib/rstudio-server/bin/rsession "$@"
`;
    const rsessionBase64 = Buffer.from(rsessionScript).toString('base64');

    const portFile = '$HOME/.rstudio-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    const rstudioBinds = [
      `${workdir}/run:/run`,
      `${workdir}/tmp:/tmp`,
      `${workdir}/database.conf:/etc/rstudio/database.conf`,
      `${workdir}/rserver.conf:/etc/rstudio/rserver.conf`,
      `${workdir}/rstudio-prefs.json:/etc/rstudio/rstudio-prefs.json`,
      `${workdir}/rsession.sh:/etc/rstudio/rsession.sh`,
      `${workdir}/var/lib/rstudio-server:/var/lib/rstudio-server`,
      this.cluster.bindPaths,
    ].join(',');

    const singularityEnvArgs = [
      `--env R_LIBS_SITE=${releasePaths.rLibsSite}`,
      pythonSitePackages ? `--env PYTHONPATH=${pythonSitePackages}` : '',
      '--env USER=$(whoami)',
    ].filter(Boolean).join(' \\\n  ');

    return `#!/bin/bash
# Redirect stderr to log file immediately for debugging
exec 2>$HOME/.rstudio-slurm/job.err
set -ex

# Setup directories
mkdir -p ${workdir}/run ${workdir}/tmp ${workdir}/var/lib/rstudio-server

# Write config files
echo ${dbConfBase64} | base64 -d > ${workdir}/database.conf
echo ${rserverConfBase64} | base64 -d > ${workdir}/rserver.conf
echo ${rstudioPrefsBase64} | base64 -d > ${workdir}/rstudio-prefs.json
echo ${rsessionBase64} | base64 -d > ${workdir}/rsession.sh
chmod +x ${workdir}/rsession.sh

# Find available port and export as IDE_PORT
eval $(echo ${portFinderBase64} | base64 -d | sh -s)

# Set RStudio session timeout
export SINGULARITYENV_RSTUDIO_SESSION_TIMEOUT=0

# Start RStudio server
exec ${this.cluster.singularityBin} exec --cleanenv \\
  ${singularityEnvArgs} \\
  -B ${rstudioBinds} \\
  ${releasePaths.singularityImage} \\
  rserver \\
    --www-address=0.0.0.0 \\
    --www-port=$IDE_PORT \\
    --server-user=$(whoami) \\
    --auth-none=1 \\
    --www-frame-origin=same \\
    --www-verify-user-agent=0 \\
    --secure-cookie-key-file=${workdir}/secure-cookie-key \\
    --rsession-path=/etc/rstudio/rsession.sh
`;
  }

  /**
   * Build job script for JupyterLab
   */
  buildJupyterScript(options: JupyterOptions = {}): string {
    const { gpu = 'none', token, releaseVersion = defaultReleaseVersion, cpus = 1 } = options;
    const ideConfig = ides.jupyter;
    const workdir = '$HOME/.jupyter-slurm';
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    const portFile = '$HOME/.jupyter-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    const nvFlag = gpu !== 'none' ? '--nv' : '';
    const tokenArg = token ? '' : "--ServerApp.token=''";

    const overridesJson = JSON.stringify(jupyterlabDefaults, null, 2);
    const overridesBase64 = Buffer.from(overridesJson).toString('base64');

    const singularityArgs = [
      nvFlag,
      '--env TERM=xterm-256color',
      token ? `--env JUPYTER_TOKEN=${token}` : '',
      pythonSitePackages ? `--env PYTHONPATH=${pythonSitePackages}` : '',
      `--env R_LIBS_SITE=${releasePaths.rLibsSite}`,
      '--env RETICULATE_PYTHON=/usr/bin/python3',
      '--env RETICULATE_PYTHON_FALLBACK=FALSE',
      `--env JUPYTER_DATA_DIR=${workdir}`,
      `--env JUPYTER_RUNTIME_DIR=${workdir}/runtime`,
      `--env OMP_NUM_THREADS=${cpus}`,
      `--env MKL_NUM_THREADS=${cpus}`,
      `--env OPENBLAS_NUM_THREADS=${cpus}`,
      `--env NUMEXPR_NUM_THREADS=${cpus}`,
      `--env MC_CORES=${cpus}`,
      `--env BIOCPARALLEL_WORKER_NUMBER=${cpus}`,
    ].filter(Boolean).join(' \\\n  ');

    const jupyterArgs = [
      '--ip=0.0.0.0',
      '--port=$IDE_PORT',
      '--no-browser',
      tokenArg,
      "--ServerApp.password=''",
      '--ServerApp.root_dir=$HOME',
      '--ServerApp.base_url=/jupyter-direct',
      '--ServerApp.allow_remote_access=True',
      '--ServerApp.trust_xheaders=True',
      "--ServerApp.allow_origin='*'",
      '--ServerApp.disable_check_xsrf=True',
    ].filter(Boolean).join(' \\\n    ');

    return `#!/bin/bash
# Redirect stderr to log file immediately for debugging
exec 2>$HOME/.jupyter-slurm/job.err
set -ex

# Setup directories
mkdir -p ${workdir}/runtime ${workdir}/lab/settings

# Bootstrap JupyterLab settings (only if overrides.json doesn't exist)
if [ ! -f ${workdir}/lab/settings/overrides.json ]; then
  echo ${overridesBase64} | base64 -d > ${workdir}/lab/settings/overrides.json
fi

# Find available port and export as IDE_PORT
eval $(echo ${portFinderBase64} | base64 -d | sh -s)

# Start JupyterLab
exec ${this.cluster.singularityBin} exec \\
  ${singularityArgs} \\
  -B ${this.cluster.bindPaths} \\
  -B ${workdir}/lab/settings/overrides.json:/usr/local/share/jupyter/lab/settings/overrides.json \\
  ${releasePaths.singularityImage} \\
  jupyter lab \\
    ${jupyterArgs}
`;
  }

  /**
   * Submit a new SLURM job for an IDE
   */
  async submitJob(cpus: number, mem: string, time: string, ide = 'vscode', options: SubmitOptions = {}): Promise<JobSubmitResult> {
    const { gpu = '', releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    if (!releases[releaseVersion]) {
      throw new Error(`Unknown release: ${releaseVersion}`);
    }

    const token = (ide === 'vscode' || ide === 'jupyter') ? generateToken() : null;

    let partition = this.cluster.partition;
    let gresArg = '';

    if (gpu) {
      const clusterGpu = gpuConfig[this.clusterName];
      if (!clusterGpu || !clusterGpu[gpu]) {
        throw new Error(`GPU type '${gpu}' not available on ${this.clusterName}`);
      }
      const gpuOpts = clusterGpu[gpu];
      partition = gpuOpts.partition;
      gresArg = `--gres=${gpuOpts.gres}`;
    }

    const logDir = '/tmp';

    let script: string;
    switch (ide) {
      case 'vscode':
        script = this.buildVscodeScript({ token: token || undefined, releaseVersion, cpus });
        break;
      case 'rstudio':
        script = this.buildRstudioScript(cpus, { releaseVersion });
        break;
      case 'jupyter':
        script = this.buildJupyterScript({ gpu, token: token || undefined, releaseVersion, cpus });
        break;
      default:
        throw new Error(`Unknown IDE: ${ide}`);
    }

    const sbatchArgs = [
      `--job-name=${ideConfig.jobName}`,
      '--nodes=1',
      `--cpus-per-task=${cpus}`,
      `--mem=${mem}`,
      `--partition=${partition}`,
      gresArg,
      `--time=${time}`,
      `--output=${logDir}/${ideConfig.jobName}_%j.log`,
      `--error=${logDir}/${ideConfig.jobName}_%j.err`,
    ].filter(Boolean).join(' \\\n  ');

    const submitCmd = `sbatch \\
  ${sbatchArgs} \\
  <<'SLURM_SCRIPT'
${script}
SLURM_SCRIPT`;

    const output = await this.sshExec(submitCmd);
    const match = output.match(/Submitted batch job (\d+)/);

    if (!match) {
      throw new Error('Failed to parse job ID from: ' + output);
    }

    log.job(`Submitted`, { cluster: this.clusterName, jobId: match[1], ide, cpus, mem, time, gpu, hasToken: !!token });
    return { jobId: match[1], token };
  }

  /**
   * Cancel a SLURM job
   */
  async cancelJob(jobId: string): Promise<void> {
    log.job(`Cancelling`, { cluster: this.clusterName, jobId });
    await this.sshExec(`scancel ${jobId}`);
  }

  /**
   * Cancel multiple SLURM jobs in a single SSH call
   */
  async cancelJobs(jobIds: string[]): Promise<CancelJobsResult> {
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return { cancelled: [], failed: [] };
    }

    const jobList = jobIds.join(' ');
    try {
      await this.sshExec(`scancel ${jobList}`);
      log.job('Batch cancelled', { cluster: this.clusterName, jobIds, count: jobIds.length });
      return { cancelled: jobIds, failed: [] };
    } catch (e) {
      log.warn('Batch cancel failed', { cluster: this.clusterName, jobIds, error: (e as Error).message });
      return { cancelled: [], failed: jobIds };
    }
  }

  /**
   * Wait for job to get node assignment
   */
  async waitForNode(jobId: string, ide = 'vscode', options: WaitForNodeOptions = {}): Promise<WaitForNodeResult> {
    const { maxAttempts = 60, returnPendingOnTimeout = false } = options;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const jobInfo = await this.getJobInfo(ide);

      if (!jobInfo || jobInfo.jobId !== jobId) {
        throw new Error('Job disappeared from queue');
      }

      if (jobInfo.state === 'RUNNING' && jobInfo.node) {
        return { node: jobInfo.node };
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }

    if (returnPendingOnTimeout) {
      return { pending: true, jobId };
    }

    throw new Error('Timeout waiting for node assignment');
  }

  /**
   * Check if a specific job exists in the queue
   */
  async checkJobExists(jobId: string): Promise<boolean> {
    try {
      const output = await this.sshExec(
        `squeue -j ${jobId} --noheader 2>/dev/null`
      );
      return output.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Parse SLURM time format to seconds
   */
  parseTimeToSeconds(timeStr: string): number | null {
    if (!timeStr) return null;

    let days = 0;
    let rest = timeStr;
    if (timeStr.includes('-')) {
      const [d, r] = timeStr.split('-');
      days = parseInt(d, 10);
      if (isNaN(days)) return null;
      rest = r;
    }

    const parts = rest.split(':').map(p => parseInt(p, 10));
    if (parts.some(p => isNaN(p))) return null;

    let seconds = 0;

    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      seconds = parts[0];
    }

    const total = days * 86400 + seconds;
    return isNaN(total) ? null : total;
  }

  /**
   * Get the actual port the IDE is running on
   */
  async getIdePort(ide: string): Promise<number> {
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    const portFiles: Record<string, string> = {
      vscode: '~/.vscode-slurm/port',
      rstudio: '~/.rstudio-slurm/port',
      jupyter: '~/.jupyter-slurm/port',
    };

    const portFile = portFiles[ide];
    if (!portFile) {
      return ideConfig.port;
    }

    try {
      const output = await this.sshExec(`cat ${portFile} 2>/dev/null`);
      const port = parseInt(output.trim(), 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        log.warn(`Invalid port in ${portFile}: ${output}, using default ${ideConfig.port}`);
        return ideConfig.port;
      }
      if (port !== ideConfig.port) {
        log.info(`Dynamic port discovered`, { ide, port, default: ideConfig.port, cluster: this.clusterName });
      }
      log.debugFor('tunnel', `Read port from ${portFile}`, { ide, port, cluster: this.clusterName });
      return port;
    } catch {
      log.debugFor('tunnel', `Port file not found, using default`, { ide, port: ideConfig.port, cluster: this.clusterName });
      return ideConfig.port;
    }
  }

  /**
   * Get the hpc-proxy port for dev server routing (VS Code only)
   * Returns null if proxy is not running.
   *
   * @param _user Currently unused; the proxy port is read from the SSH user's
   *              home directory (~/.hpc-proxy/port). Parameter kept for API
   *              consistency with other methods and potential future per-user support.
   */
  async getProxyPort(_user: string | null): Promise<number | null> {
    const portFile = '~/.hpc-proxy/port';
    try {
      const output = await this.sshExec(`cat ${portFile} 2>/dev/null`);
      const port = parseInt(output.trim(), 10);
      if (port > 0 && port < 65536) {
        log.debugFor('tunnel', `Read proxy port from ${portFile}`, { port, cluster: this.clusterName });
        return port;
      }
      log.warn(`Invalid proxy port in ${portFile}: ${output}`);
      return null;
    } catch {
      // No proxy running or file doesn't exist
      log.debugFor('tunnel', `No proxy port file found`, { cluster: this.clusterName });
      return null;
    }
  }

  /**
   * Check if multiple ports are listening on a compute node
   */
  async checkPorts(node: string, ports: number[]): Promise<Record<number, boolean>> {
    const result: Record<number, boolean> = {};
    for (const p of ports) {
      result[p] = false;
    }

    try {
      const pattern = ports.map((p) => `:${p}`).join('|');
      const cmd = `ssh ${node} "ss -tln 2>/dev/null | grep -E '${pattern}' || true"`;
      const output = await this.sshExec(cmd);

      for (const port of ports) {
        if (output.includes(`:${port}`)) {
          result[port] = true;
        }
      }
      log.debugFor('tunnel', `Port check on ${node}`, { ports: result, cluster: this.clusterName });
    } catch (e) {
      log.warn(`Port check failed on ${node}`, { error: (e as Error).message, cluster: this.clusterName });
    }

    return result;
  }

  /**
   * Get cluster health status
   */
  async getClusterHealth(options: HealthOptions = {}): Promise<ClusterHealth> {
    const { userAccount } = options;

    const fairshareCmd = userAccount
      ? `echo "===FAIRSHARE===" && sshare -u ${config.hpcUser} -A ${userAccount} -h -P -o "FairShare" 2>/dev/null | tail -1 && `
      : '';

    const partitionCpuCmd = this.clusterName === 'gemini'
      ? `echo "===CPUS_GPU_A100===" && sinfo -p gpu-a100 -h -o '%C' 2>/dev/null && \
echo "===CPUS_GPU_V100===" && sinfo -p gpu-v100 -h -o '%C' 2>/dev/null && `
      : '';

    const cmd = `
echo "===CPUS===" && \
sinfo -h -o '%C' 2>/dev/null && \
${partitionCpuCmd}echo "===NODES===" && \
sinfo -h -o '%D %t' 2>/dev/null && \
echo "===MEMORY===" && \
sinfo -h -N -o '%m %e' 2>/dev/null && \
echo "===RUNNING===" && \
squeue -h -t R 2>/dev/null | wc -l && \
echo "===PENDING===" && \
squeue -h -t PD 2>/dev/null | wc -l && \
echo "===GRES===" && \
sinfo -h -o '%G %D %t' 2>/dev/null | grep -i gpu || echo "none" && \
${fairshareCmd}echo "done"
`;

    try {
      const output = await this.sshExec(cmd);
      return this.parseClusterHealth(output);
    } catch (e) {
      log.warn('Failed to get cluster health', { cluster: this.clusterName, error: (e as Error).message });
      return {
        online: false,
        error: (e as Error).message,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Parse sinfo/squeue output into structured health data
   */
  parseClusterHealth(output: string): ClusterHealth {
    const sections: Record<string, string[]> = {};
    let currentSection: string | null = null;
    const lines = output.split('\n');

    for (const line of lines) {
      const sectionMatch = line.match(/^===(\w+)===$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        sections[currentSection] = [];
      } else if (currentSection && line.trim()) {
        sections[currentSection].push(line.trim());
      }
    }

    // Parse CPUs
    let cpus = { used: 0, idle: 0, total: 0, percent: 0 };
    if (sections.CPUS && sections.CPUS[0]) {
      const cpuParts = sections.CPUS[0].split('/');
      if (cpuParts.length === 4) {
        const cpuNumbers = cpuParts.map(part => Number(part.trim()));
        if (cpuNumbers.every(Number.isFinite)) {
          const [allocated, idle, , total] = cpuNumbers;
          cpus = {
            used: allocated,
            idle: idle,
            total: total,
            percent: total > 0 ? Math.round((allocated / total) * 100) : 0,
          };
        }
      }
    }

    // Parse per-partition CPUs
    const parseCpuString = (str: string): { used: number; idle: number; total: number; percent: number } | null => {
      if (!str) return null;
      const parts = str.split('/');
      if (parts.length !== 4) return null;
      const nums = parts.map(p => Number(p.trim()));
      if (!nums.every(Number.isFinite)) return null;
      const [allocated, idle, , total] = nums;
      return {
        used: allocated,
        idle: idle,
        total: total,
        percent: total > 0 ? Math.round((allocated / total) * 100) : 0,
      };
    };

    const partitions: Record<string, { cpus: { used: number; idle: number; total: number; percent: number } | null }> = {};
    if (sections.CPUS_GPU_A100?.[0]) {
      partitions['gpu-a100'] = { cpus: parseCpuString(sections.CPUS_GPU_A100[0]) };
    }
    if (sections.CPUS_GPU_V100?.[0]) {
      partitions['gpu-v100'] = { cpus: parseCpuString(sections.CPUS_GPU_V100[0]) };
    }

    // Parse nodes
    const nodes = { idle: 0, busy: 0, down: 0, total: 0, percent: 0 };
    if (sections.NODES) {
      for (const line of sections.NODES) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const count = parseInt(parts[0], 10) || 0;
          const state = parts[1].toLowerCase();
          nodes.total += count;
          if (state === 'idle') {
            nodes.idle += count;
          } else if (state === 'mix' || state === 'alloc') {
            nodes.busy += count;
          } else if (state.includes('down') || state.includes('drain')) {
            nodes.down += count;
          } else {
            log.debugFor('hpc', `Unknown node state '${state}' (${count} nodes), counting as busy`);
            nodes.busy += count;
          }
        }
      }
    }

    // Parse memory
    let memory = { used: 0, total: 0, unit: 'GB', percent: 0 };
    if (sections.MEMORY) {
      let totalMem = 0;
      let freeMem = 0;
      for (const line of sections.MEMORY) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const total = parseInt(parts[0].replace(/[^\d]/g, ''), 10) || 0;
          const free = parseInt(parts[1].replace(/[^\d]/g, ''), 10) || 0;
          totalMem += total;
          freeMem += free;
        }
      }
      const totalGB = Math.round(totalMem / 1024);
      const usedGB = Math.round((totalMem - freeMem) / 1024);
      memory = {
        used: usedGB,
        total: totalGB,
        unit: 'GB',
        percent: totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0,
      };
    }

    // Parse jobs
    let runningJobs = 0;
    if (sections.RUNNING && sections.RUNNING[0]) {
      runningJobs = parseInt(sections.RUNNING[0], 10) || 0;
    }

    let pendingJobs = 0;
    if (sections.PENDING && sections.PENDING[0]) {
      pendingJobs = parseInt(sections.PENDING[0], 10) || 0;
    }

    // Parse GPUs
    let gpus: (Record<string, { idle: number; busy: number; total: number }> & { percent?: number }) | null = null;
    if (sections.GRES && sections.GRES[0] !== 'none') {
      gpus = {};
      for (const line of sections.GRES) {
        const match = line.match(/gpu:(\w+):(\d+)\s+(\d+)\s+(\w+)/i);
        if (match) {
          const [, gpuType, gpusPerNode, nodeCount, state] = match;
          const stateLower = state.toLowerCase();
          if (stateLower.includes('down') || stateLower.includes('drain')) {
            continue;
          }
          const totalGpus = parseInt(gpusPerNode, 10) * parseInt(nodeCount, 10);
          if (!gpus[gpuType]) {
            gpus[gpuType] = { idle: 0, busy: 0, total: 0 };
          }
          gpus[gpuType].total += totalGpus;
          if (stateLower === 'idle') {
            gpus[gpuType].idle += totalGpus;
          } else {
            gpus[gpuType].busy += totalGpus;
          }
        }
      }
      if (Object.keys(gpus).length === 0) {
        gpus = null;
      }
    }

    nodes.percent = nodes.total > 0 ? Math.round((nodes.busy / nodes.total) * 100) : 0;

    if (gpus) {
      let totalGpus = 0;
      let busyGpus = 0;
      for (const [key, gpu] of Object.entries(gpus)) {
        if (key !== 'percent' && typeof gpu === 'object') {
          totalGpus += gpu.total || 0;
          busyGpus += gpu.busy || 0;
        }
      }
      gpus.percent = totalGpus > 0 ? Math.round((busyGpus / totalGpus) * 100) : 0;
    }

    // Parse fairshare
    let fairshare: number | null = null;
    if (sections.FAIRSHARE && sections.FAIRSHARE[0]) {
      const parsed = parseFloat(sections.FAIRSHARE[0]);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        fairshare = parsed;
      }
    }

    return {
      online: true,
      cpus,
      memory,
      nodes,
      gpus,
      partitions: Object.keys(partitions).length > 0 ? partitions : null,
      runningJobs,
      pendingJobs,
      fairshare,
      lastChecked: Date.now(),
    };
  }
}

export default HpcService;

// CommonJS compatibility for existing require() calls
module.exports = HpcService;
