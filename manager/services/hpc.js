/**
 * HPC Service Layer
 * Handles SLURM job management and SSH operations for HPC clusters
 */

const { exec } = require('child_process');
const crypto = require('crypto');
const { config, clusters, ides, gpuConfig, releases, defaultReleaseVersion, getReleasePaths, vscodeDefaults, rstudioDefaults, jupyterlabDefaults } = require('../config');
const { log } = require('../lib/logger');

/**
 * Generate a secure random token for IDE authentication
 * @returns {string} 32-character hex token
 */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate shell script to find an available port starting from defaultPort.
 * Writes the chosen port to a file for the manager to read when establishing tunnels.
 * This handles port collisions when multiple users land on the same compute node.
 * See: https://github.com/drejom/omhq-hpc-code-server-stack/issues/18
 *
 * Uses netstat pattern from proven /opt/singularity-images/rbioc/rbioc319.job script.
 * (ss command not available on all compute nodes)
 *
 * IMPORTANT: This script is called via `eval $(... | sh -s)` so the LAST LINE must
 * echo the export statement for eval to capture. Don't just execute `export` - that
 * runs in a subshell and doesn't propagate to the parent.
 *
 * @param {number} defaultPort - Starting port to try
 * @param {string} portFile - Path to write the chosen port (e.g., $HOME/.vscode-slurm/port)
 * @returns {string} Shell script (base64 encoded for safe transport)
 */
function buildPortFinderScript(defaultPort, portFile) {
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
  constructor(clusterName) {
    this.clusterName = clusterName;
    this.cluster = clusters[clusterName];

    if (!this.cluster) {
      throw new Error(`Unknown cluster: ${clusterName}`);
    }
  }

  /**
   * Get user's default SLURM account
   * Called once per user to determine which account to use for fairshare queries
   * @param {string} user - Username (defaults to config.hpcUser for single-user mode)
   * @returns {Promise<string|null>} Default account name or null if not found
   */
  async getUserDefaultAccount(user = null) {
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
      log.warn('Failed to get user default account', { cluster: this.clusterName, user: effectiveUser, error: e.message });
      return null;
    }
  }

  /**
   * Execute SSH command on cluster
   * Supports multi-line commands (heredocs) via stdin
   * @param {string} command - Command to execute
   * @returns {Promise<string>} Command output
   */
  sshExec(command) {
    return new Promise((resolve, reject) => {
      log.ssh(`Executing on ${this.clusterName}`, { command: command.substring(0, 100) });
      log.debugFor('ssh', 'full command', { cluster: this.clusterName, command });

      // Use bash -s to read script from stdin - handles heredocs cleanly
      const sshCmd = `ssh -o StrictHostKeyChecking=no ${config.hpcUser}@${this.cluster.host} 'bash -s'`;

      const child = exec(
        sshCmd,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          // Filter out OpenSSH post-quantum warnings (not actual errors)
          const filteredStderr = stderr
            ?.replace(/\*\* WARNING:.*post-quantum.*\r?\n?/g, '')
            ?.replace(/\*\* This session may be vulnerable.*\r?\n?/g, '')
            ?.replace(/\*\* The server may need.*\r?\n?/g, '')
            ?.trim();

          if (error) {
            const errorMsg = filteredStderr || error.message;
            log.error('SSH command failed', { cluster: this.clusterName, error: errorMsg });
            reject(new Error(errorMsg));
          } else {
            resolve(stdout.trim());
          }
        }
      );

      // Write command to stdin
      child.stdin.write(command);
      child.stdin.end();
    });
  }

  /**
   * Get job information from SLURM queue for a specific IDE
   * @param {string} ide - IDE type ('vscode', 'rstudio')
   * @returns {Promise<Object|null>} Job info or null if no job found
   */
  async getJobInfo(ide = 'vscode') {
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    try {
      const output = await this.sshExec(
        `squeue --user=${config.hpcUser} --name=${ideConfig.jobName} --states=R,PD -h -O JobID,State,NodeList,TimeLeft,TimeLimit,NumCPUs,MinMemory,StartTime 2>/dev/null | head -1`
      );

      if (!output) return null;

      const parts = output.split(/\s+/);
      const [jobId, jobState, node, timeLeft, timeLimit, cpus, memory, ...startTimeParts] = parts;
      const startTime = startTimeParts.join(' '); // StartTime may have spaces

      return {
        jobId,
        ide,
        state: jobState,
        node: node === '(null)' ? null : node,
        timeLeft: timeLeft === 'INVALID' ? null : timeLeft,
        timeLimit: timeLimit === 'INVALID' ? null : timeLimit,
        cpus: cpus || null,
        memory: memory || null,
        startTime: startTime === 'N/A' ? null : startTime,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get job information for all IDEs on this cluster
   * Single SSH call with comma-separated job names, then parse by Name field
   * @param {string} user - Username (defaults to config.hpcUser for single-user mode)
   * @returns {Promise<Object>} Map of ide -> job info (or null)
   */
  async getAllJobs(user = null) {
    const effectiveUser = user || config.hpcUser;
    // Build comma-separated list of job names
    const jobNames = Object.values(ides).map(ide => ide.jobName).join(',');

    // Single SSH call for all IDEs
    const output = await this.sshExec(
      `squeue --user=${effectiveUser} --name=${jobNames} --states=R,PD -h -O JobID,Name,State,NodeList,TimeLeft,TimeLimit,NumCPUs,MinMemory,StartTime 2>/dev/null`
    );

    // Initialize results with null for all IDEs
    const results = {};
    for (const ide of Object.keys(ides)) {
      results[ide] = null;
    }

    if (!output) return results;

    // Parse each line and match to IDE by job name
    const lines = output.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const [jobId, jobName, jobState, node, timeLeft, timeLimit, cpus, memory, ...startTimeParts] = parts;
      const startTime = startTimeParts.join(' ');

      // Find IDE by job name
      const ide = Object.keys(ides).find(k => ides[k].jobName === jobName);
      if (!ide) continue;

      // Parse timeLeft to seconds for adaptive polling
      const parsedTimeLeft = (timeLeft && timeLeft !== 'INVALID' && timeLeft !== 'UNLIMITED')
        ? this.parseTimeToSeconds(timeLeft)
        : null;

      results[ide] = {
        jobId,
        ide,
        state: jobState,
        node: node === '(null)' ? null : node,
        timeLeft: timeLeft === 'INVALID' ? null : timeLeft,
        timeLeftSeconds: parsedTimeLeft,
        timeLimit: timeLimit === 'INVALID' ? null : timeLimit,
        cpus: cpus || null,
        memory: memory || null,
        startTime: startTime === 'N/A' ? null : startTime,
      };
    }

    return results;
  }

  /**
   * Build job script for VS Code
   * Writes Machine settings and bootstraps extensions before starting server
   * @param {Object} options - Build options
   * @param {string} options.token - Connection token for authentication
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   * @param {number} options.cpus - Number of CPUs for parallel processing
   * @returns {string} Shell script content
   */
  buildVscodeScript(options = {}) {
    const { token, releaseVersion = defaultReleaseVersion, cpus = 1 } = options;
    const ideConfig = ides.vscode;
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    // Paths - no escaping needed with heredocs!
    const dataDir = '$HOME/.vscode-slurm/.vscode-server';
    const machineSettingsDir = `${dataDir}/data/Machine`;
    const extensionsDir = `${dataDir}/extensions`;
    const builtinExtDir = vscodeDefaults.builtinExtensionsDir;

    // Machine settings JSON (base64 encoded for clean embedding)
    const machineSettings = JSON.stringify(vscodeDefaults.settings, null, 2);
    const machineSettingsBase64 = Buffer.from(machineSettings).toString('base64');

    // Keybindings JSON (only written if doesn't exist - preserves user customizations)
    const keybindings = JSON.stringify(vscodeDefaults.keybindings, null, 2);
    const keybindingsBase64 = Buffer.from(keybindings).toString('base64');

    // Bootstrap script - base64 encoded for clean embedding
    // NOTE: VS Code serve-web 1.107+ only supports --server-data-dir, not --user-data-dir
    // So keybindings must be written to server-data-dir/data/User/ not a separate user-data dir
    const bootstrapScript = `#!/bin/sh
# Bootstrap extensions from container image (if available)
if [ -d ${builtinExtDir} ]; then
  for ext in ${builtinExtDir}/*; do
    name=\${ext##*/}
    [ -d "$HOME/.vscode-slurm/.vscode-server/extensions/$name" ] || cp -r "$ext" "$HOME/.vscode-slurm/.vscode-server/extensions/"
  done
fi
# Bootstrap keybindings (only if user hasn't customized)
# serve-web 1.107+ looks in server-data-dir/data/User/, not separate user-data-dir
keybindingsFile="$HOME/.vscode-slurm/.vscode-server/data/User/keybindings.json"
if [ ! -f "$keybindingsFile" ]; then
  mkdir -p "$HOME/.vscode-slurm/.vscode-server/data/User"
  echo ${keybindingsBase64} | base64 -d > "$keybindingsFile"
fi
`;
    const bootstrapBase64 = Buffer.from(bootstrapScript).toString('base64');

    // Port finder script
    const portFile = '$HOME/.vscode-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    // Token handling
    const tokenArg = token ? `--connection-token=${token}` : '--without-connection-token';

    // Build singularity env args (filter out empty strings)
    // Set parallel processing env vars to match SLURM allocation
    // RETICULATE_PYTHON_FALLBACK=FALSE prevents auto-creation of ~/.virtualenvs/r-reticulate
    // SHINY_PORT sets default Shiny port (container Rprofile.site reads this)
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
# Create writable /run/user/<uid> directory for VS Code sockets
mkdir -p $HOME/.vscode-slurm/run/user/$(id -u)
chmod 700 $HOME/.vscode-slurm/run/user/$(id -u)

# Write Machine settings
echo ${machineSettingsBase64} | base64 -d > ${machineSettingsDir}/settings.json

# Run bootstrap script (extensions + keybindings)
echo ${bootstrapBase64} | base64 -d | sh

# Find available port and export as IDE_PORT
eval $(echo ${portFinderBase64} | base64 -d | sh -s)

# Start VS Code server
# Note: serve-web only supports --server-data-dir, not --extensions-dir or --user-data-dir
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
   * Based on proven /opt/singularity-images/rbioc/rbioc319.job script
   * Uses auth-none=1 mode (like jupyter-rsession-proxy) - no login required.
   * @param {number} cpus - Number of CPUs
   * @param {Object} options - Build options
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   * @returns {string} Shell script content
   */
  buildRstudioScript(cpus, options = {}) {
    const { releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides.rstudio;
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';
    const workdir = '$HOME/.rstudio-slurm/workdir';

    // Config files (base64 encoded for clean embedding)
    const dbConf = `provider=sqlite
directory=/var/lib/rstudio-server
`;
    const dbConfBase64 = Buffer.from(dbConf).toString('base64');

    const rserverConf = `rsession-which-r=/usr/local/bin/R
auth-cookies-force-secure=0
www-root-path=/rstudio-direct
`;
    const rserverConfBase64 = Buffer.from(rserverConf).toString('base64');

    // rstudio-prefs.json - global defaults from config
    const rstudioPrefs = JSON.stringify(rstudioDefaults);
    const rstudioPrefsBase64 = Buffer.from(rstudioPrefs).toString('base64');

    // Use releaseVersion for R_LIBS_USER path (e.g., bioc-3.22)
    const biocVersion = releaseVersion;

    // rsession wrapper script
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
# Python config for reticulate
export PYTHONPATH=${pythonSitePackages}
export RETICULATE_PYTHON=/usr/bin/python3
export RETICULATE_PYTHON_FALLBACK=FALSE
exec /usr/lib/rstudio-server/bin/rsession "$@"
`;
    const rsessionBase64 = Buffer.from(rsessionScript).toString('base64');

    // Port finder script
    const portFile = '$HOME/.rstudio-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    // Build bind paths
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

    // Build singularity env args (filter out empty strings)
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
   * Uses shared Python site-packages (mirrors R_LIBS_SITE pattern)
   * @param {Object} options - Options including gpu type, token, and release version
   * @param {string} options.gpu - GPU type ('none', 'a100', 'v100')
   * @param {string} options.token - Authentication token
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   * @param {number} options.cpus - Number of CPUs for parallel processing
   * @returns {string} Shell script content
   */
  buildJupyterScript(options = {}) {
    const { gpu = 'none', token, releaseVersion = defaultReleaseVersion, cpus = 1 } = options;
    const ideConfig = ides.jupyter;
    const workdir = '$HOME/.jupyter-slurm';
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    // Port finder script
    const portFile = '$HOME/.jupyter-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    // GPU passthrough flag (--nv enables NVIDIA GPU access in container)
    const nvFlag = gpu !== 'none' ? '--nv' : '';

    // Token handling
    const tokenArg = token ? '' : "--ServerApp.token=''";

    // JupyterLab overrides.json (base64 encoded for clean embedding)
    const overridesJson = JSON.stringify(jupyterlabDefaults, null, 2);
    const overridesBase64 = Buffer.from(overridesJson).toString('base64');

    // Build singularity args (filter out empty strings)
    // Set parallel processing env vars to match SLURM allocation
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

    // Build jupyter args (filter out empty strings)
    const jupyterArgs = [
      '--ip=0.0.0.0',
      '--port=$IDE_PORT',
      '--no-browser',
      tokenArg,
      "--ServerApp.password=''",
      '--ServerApp.root_dir=$HOME',
      '--ServerApp.base_url=/jupyter-direct',
      '--ServerApp.allow_remote_access=True',
      // Proxy support flags (fixes "Not Found" when clicking notebooks)
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
# Sets terminal font (Nerd Font fallback), code font, line numbers
if [ ! -f ${workdir}/lab/settings/overrides.json ]; then
  echo ${overridesBase64} | base64 -d > ${workdir}/lab/settings/overrides.json
fi

# Find available port and export as IDE_PORT
eval $(echo ${portFinderBase64} | base64 -d | sh -s)

# Start JupyterLab
# Bind overrides.json into container's app settings directory
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
   * Submit a new SLURM job for an IDE using heredoc
   * @param {string} cpus - Number of CPUs
   * @param {string} mem - Memory (e.g., "40G")
   * @param {string} time - Walltime (e.g., "12:00:00")
   * @param {string} ide - IDE type ('vscode', 'rstudio', 'jupyter')
   * @param {Object} options - Additional options
   * @param {string} options.gpu - GPU type ('' for none, 'a100', 'v100') - Gemini only
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   * @returns {Promise<{jobId: string, token: string}>} Job ID and auth token
   */
  async submitJob(cpus, mem, time, ide = 'vscode', options = {}) {
    const { gpu = '', releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    // Validate releaseVersion
    if (!releases[releaseVersion]) {
      throw new Error(`Unknown release: ${releaseVersion}`);
    }

    // Generate auth token for VS Code and JupyterLab (RStudio uses auth-none)
    const token = (ide === 'vscode' || ide === 'jupyter') ? generateToken() : null;

    // GPU handling (Gemini only)
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

    // Logs written to /tmp on compute node
    const logDir = '/tmp';

    // Build IDE-specific script (pass releaseVersion and cpus for release-specific paths and parallelism)
    let script;
    switch (ide) {
      case 'vscode':
        script = this.buildVscodeScript({ token, releaseVersion, cpus });
        break;
      case 'rstudio':
        script = this.buildRstudioScript(cpus, { releaseVersion });
        break;
      case 'jupyter':
        script = this.buildJupyterScript({ gpu, token, releaseVersion, cpus });
        break;
      default:
        throw new Error(`Unknown IDE: ${ide}`);
    }

    // Submit using heredoc - no escaping nightmares!
    // The <<'SLURM_SCRIPT' (quoted) prevents any expansion until the script runs
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
   * @param {string} jobId - Job ID to cancel
   * @returns {Promise<void>}
   */
  async cancelJob(jobId) {
    log.job(`Cancelling`, { cluster: this.clusterName, jobId });
    await this.sshExec(`scancel ${jobId}`);
  }

  /**
   * Wait for job to get node assignment
   * @param {string} jobId - Job ID to monitor
   * @param {string} ide - IDE type ('vscode', 'rstudio')
   * @param {Object} options - Configuration options
   * @param {number} options.maxAttempts - Maximum polling attempts (default 60)
   * @param {boolean} options.returnPendingOnTimeout - Return pending status instead of throwing on timeout (default false)
   * @returns {Promise<{node: string}|{pending: true, jobId: string}>} Node name or pending status
   */
  async waitForNode(jobId, ide = 'vscode', options = {}) {
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

    // Return pending status for graceful handling (SSE flow)
    if (returnPendingOnTimeout) {
      return { pending: true, jobId };
    }

    throw new Error('Timeout waiting for node assignment');
  }

  /**
   * Check if a specific job exists in the queue
   * @param {string} jobId - Job ID to check
   * @returns {Promise<boolean>} True if job exists
   */
  async checkJobExists(jobId) {
    try {
      const output = await this.sshExec(
        `squeue -j ${jobId} --noheader 2>/dev/null`
      );
      return output.length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Parse SLURM time format to seconds
   * Formats: DD-HH:MM:SS, HH:MM:SS, MM:SS, SS
   * @param {string} timeStr - Time string from SLURM
   * @returns {number|null} Seconds or null if invalid
   */
  parseTimeToSeconds(timeStr) {
    if (!timeStr) return null;

    // Handle days format: DD-HH:MM:SS
    let days = 0;
    let rest = timeStr;
    if (timeStr.includes('-')) {
      const [d, r] = timeStr.split('-');
      days = parseInt(d, 10);
      if (isNaN(days)) return null;
      rest = r;
    }

    const parts = rest.split(':').map(p => parseInt(p, 10));

    // Validate all parsed values are numbers
    if (parts.some(p => isNaN(p))) return null;

    let seconds = 0;

    if (parts.length === 3) {
      // HH:MM:SS
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      // MM:SS
      seconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      // SS
      seconds = parts[0];
    }

    const total = days * 86400 + seconds;
    return isNaN(total) ? null : total;
  }

  /**
   * Get the actual port the IDE is running on
   * Reads from the port file written by the job's port finder script.
   * Falls back to default port if file doesn't exist (backwards compatibility).
   * @param {string} ide - IDE type ('vscode', 'rstudio', 'jupyter')
   * @returns {Promise<number>} The port number
   */
  async getIdePort(ide) {
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    // Port file paths match those in build*Script methods
    const portFiles = {
      vscode: '~/.vscode-slurm/port',
      rstudio: '~/.rstudio-slurm/port',
      jupyter: '~/.jupyter-slurm/port',
    };

    const portFile = portFiles[ide];
    if (!portFile) {
      return ideConfig.port; // Fallback to default
    }

    try {
      const output = await this.sshExec(`cat ${portFile} 2>/dev/null`);
      const port = parseInt(output.trim(), 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        log.warn(`Invalid port in ${portFile}: ${output}, using default ${ideConfig.port}`);
        return ideConfig.port;
      }
      // Log at info level if port differs from default (port collision was resolved)
      if (port !== ideConfig.port) {
        log.info(`Dynamic port discovered`, { ide, port, default: ideConfig.port, cluster: this.clusterName });
      }
      log.debugFor('tunnel', `Read port from ${portFile}`, { ide, port, cluster: this.clusterName });
      return port;
    } catch (e) {
      // File doesn't exist or can't be read - use default port
      log.debugFor('tunnel', `Port file not found, using default`, { ide, port: ideConfig.port, cluster: this.clusterName });
      return ideConfig.port;
    }
  }

  /**
   * Check if multiple ports are listening on a compute node
   * Used for dev server detection (Live Server, Shiny)
   * @param {string} node - Compute node hostname
   * @param {number[]} ports - Array of ports to check
   * @returns {Promise<Object>} Map of port -> boolean (listening)
   */
  async checkPorts(node, ports) {
    const result = {};
    for (const p of ports) {
      result[p] = false;
    }

    try {
      // Build regex pattern: :5500|:3838
      const pattern = ports.map((p) => `:${p}`).join('|');
      // SSH to login node, then ssh to compute node to check ports
      // Use || true to prevent grep exit code 1 (no matches) from being an error
      const cmd = `ssh ${node} "ss -tln 2>/dev/null | grep -E '${pattern}' || true"`;
      const output = await this.sshExec(cmd);

      // Parse output - each line shows a listening port (empty if none)
      for (const port of ports) {
        if (output.includes(`:${port}`)) {
          result[port] = true;
        }
      }
      log.debugFor('tunnel', `Port check on ${node}`, { ports: result, cluster: this.clusterName });
    } catch (e) {
      // Actual SSH failure (connection refused, timeout, etc.)
      log.warn(`Port check failed on ${node}`, { error: e.message, cluster: this.clusterName });
    }

    return result;
  }

  /**
   * Get cluster health status including CPU, memory, node, and GPU usage
   * Uses single SSH call for efficiency
   *
   * @returns {Promise<Object>} Cluster health data:
   *   - online {boolean} - Whether cluster responded
   *   - cpus {{ used, idle, total, percent }} - CPU allocation
   *   - memory {{ used, total, unit, percent }} - Memory in GB
   *   - nodes {{ idle, busy, down, total, percent }} - Node counts by state
   *   - gpus {Object|null} - GPU data by type, with overall percent
   *   - pendingJobs {number} - Jobs in queue
   *   - runningJobs {number} - Jobs currently running
   *   - fairshare {number|null} - User's fairshare score (0-1, higher is better)
   *   - lastChecked {number} - Timestamp
   *   - error {string} - Error message if offline
   *
   * @param {Object} options - Options
   * @param {string} options.userAccount - User's default SLURM account for fairshare query
   */
  async getClusterHealth(options = {}) {
    const { userAccount } = options;

    // Single SSH call to get all health info
    // %C = CPUs (A/I/O/T = allocated/idle/other/total)
    // %e = free memory per node
    // %m = total memory per node
    // %D = node count
    // %t = state (idle, mix, alloc, down, drain)
    // Fairshare: user's queue priority (0-1, higher is better)
    const fairshareCmd = userAccount
      ? `echo "===FAIRSHARE===" && sshare -u ${config.hpcUser} -A ${userAccount} -h -P -o "FairShare" 2>/dev/null | tail -1 && `
      : '';

    // Per-partition CPU queries for Gemini (gpu-a100, gpu-v100)
    // Apollo doesn't have GPU partitions, so we only need aggregate stats there
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
      log.warn('Failed to get cluster health', { cluster: this.clusterName, error: e.message });
      return {
        online: false,
        error: e.message,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Parse sinfo/squeue output into structured health data
   * @param {string} output - Raw command output
   * @returns {Object} Parsed health data
   */
  parseClusterHealth(output) {
    const sections = {};
    let currentSection = null;
    const lines = output.split('\n');

    // Split output into sections
    for (const line of lines) {
      const sectionMatch = line.match(/^===(\w+)===$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        sections[currentSection] = [];
      } else if (currentSection && line.trim()) {
        sections[currentSection].push(line.trim());
      }
    }

    // Parse CPUs: "450/150/0/1200" -> allocated/idle/other/total
    let cpus = { used: 0, idle: 0, total: 0, percent: 0 };
    if (sections.CPUS && sections.CPUS[0]) {
      const cpuParts = sections.CPUS[0].split('/');
      if (cpuParts.length === 4) {
        const cpuNumbers = cpuParts.map(part => Number(part.trim()));
        // Validate all parsed values are finite numbers
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

    // Parse per-partition CPUs (Gemini only: gpu-a100, gpu-v100)
    // Helper to parse CPU string
    const parseCpuString = (str) => {
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

    const partitions = {};
    if (sections.CPUS_GPU_A100?.[0]) {
      partitions['gpu-a100'] = { cpus: parseCpuString(sections.CPUS_GPU_A100[0]) };
    }
    if (sections.CPUS_GPU_V100?.[0]) {
      partitions['gpu-v100'] = { cpus: parseCpuString(sections.CPUS_GPU_V100[0]) };
    }

    // Parse nodes by state
    // Known SLURM states: idle, mix, alloc, down, drain, draining, drained, resv, maint, comp
    const nodes = { idle: 0, busy: 0, down: 0, total: 0 };
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
            // Unknown/other states (resv, maint, comp, etc.) - count as busy
            log.debugFor('hpc', `Unknown node state '${state}' (${count} nodes), counting as busy`);
            nodes.busy += count;
          }
        }
      }
    }

    // Parse memory: sum across all nodes (in MB)
    let memory = { used: 0, total: 0, unit: 'GB', percent: 0 };
    if (sections.MEMORY) {
      let totalMem = 0;
      let freeMem = 0;
      for (const line of sections.MEMORY) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          // Memory values might have + suffix or be in various formats
          const total = parseInt(parts[0].replace(/[^\d]/g, ''), 10) || 0;
          const free = parseInt(parts[1].replace(/[^\d]/g, ''), 10) || 0;
          totalMem += total;
          freeMem += free;
        }
      }
      // Convert to GB (sinfo reports in MB)
      const totalGB = Math.round(totalMem / 1024);
      const usedGB = Math.round((totalMem - freeMem) / 1024);
      memory = {
        used: usedGB,
        total: totalGB,
        unit: 'GB',
        percent: totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0,
      };
    }

    // Parse running jobs count
    let runningJobs = 0;
    if (sections.RUNNING && sections.RUNNING[0]) {
      runningJobs = parseInt(sections.RUNNING[0], 10) || 0;
    }

    // Parse pending jobs count
    let pendingJobs = 0;
    if (sections.PENDING && sections.PENDING[0]) {
      pendingJobs = parseInt(sections.PENDING[0], 10) || 0;
    }

    // Parse GPUs (if available)
    // Note: GPUs on down/drained nodes are excluded from counts
    let gpus = null;
    if (sections.GRES && sections.GRES[0] !== 'none') {
      gpus = {};
      for (const line of sections.GRES) {
        // Format: "gpu:v100:4 2 mix" or "gpu:a100:8 1 idle"
        const match = line.match(/gpu:(\w+):(\d+)\s+(\d+)\s+(\w+)/i);
        if (match) {
          const [, gpuType, gpusPerNode, nodeCount, state] = match;
          const stateLower = state.toLowerCase();
          // Skip GPUs on down/drained nodes - they're not available
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
            // mix, alloc, allocated = busy
            gpus[gpuType].busy += totalGpus;
          }
        }
      }
      // Remove if empty
      if (Object.keys(gpus).length === 0) {
        gpus = null;
      }
    }

    // Calculate node usage percentage
    nodes.percent = nodes.total > 0 ? Math.round((nodes.busy / nodes.total) * 100) : 0;

    // Calculate GPU usage percentage (if GPUs present)
    if (gpus) {
      let totalGpus = 0;
      let busyGpus = 0;
      for (const gpu of Object.values(gpus)) {
        totalGpus += gpu.total || 0;
        busyGpus += gpu.busy || 0;
      }
      gpus.percent = totalGpus > 0 ? Math.round((busyGpus / totalGpus) * 100) : 0;
    }

    // Parse user's fairshare score (0-1, higher is better queue priority)
    let fairshare = null;
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

module.exports = HpcService;
