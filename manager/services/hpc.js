/**
 * HPC Service Layer
 * Handles SLURM job management and SSH operations for HPC clusters
 */

const { exec } = require('child_process');
const crypto = require('crypto');
const { config, clusters, ides, gpuConfig, releases, defaultReleaseVersion, getReleasePaths, vscodeDefaults, rstudioDefaults } = require('../config');
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
 * @param {number} defaultPort - Starting port to try
 * @param {string} portFile - Path to write the chosen port (e.g., ~/.vscode-slurm/port)
 * @returns {string} Shell script snippet (base64 encoded for safe transport)
 */
function buildPortFinderScript(defaultPort, portFile) {
  const dollar = '$';
  const script = `#!/bin/sh
# Find available port starting from ${defaultPort}
PORT=${defaultPort}
while ss -tln | grep -q ":${dollar}PORT "; do
  PORT=${dollar}((PORT + 1))
  # Safety: don't search forever
  if [ ${dollar}PORT -gt ${dollar}((${defaultPort} + 100)) ]; then
    echo "ERROR: Could not find available port after 100 attempts" >&2
    exit 1
  fi
done
echo ${dollar}PORT > ${portFile}
export IDE_PORT=${dollar}PORT
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
   * Execute SSH command on cluster
   * @param {string} command - Command to execute
   * @returns {Promise<string>} Command output
   */
  sshExec(command) {
    return new Promise((resolve, reject) => {
      log.ssh(`Executing on ${this.clusterName}`, { command: command.substring(0, 100) });
      log.debugFor('ssh', 'full command', { cluster: this.clusterName, command });
      exec(
        `ssh -o StrictHostKeyChecking=no ${config.hpcUser}@${this.cluster.host} "${command}"`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            log.error('SSH command failed', { cluster: this.clusterName, error: stderr || error.message });
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout.trim());
          }
        }
      );
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
   * @returns {Promise<Object>} Map of ide -> job info (or null)
   */
  async getAllJobs() {
    // Build comma-separated list of job names
    const jobNames = Object.values(ides).map(ide => ide.jobName).join(',');

    // Single SSH call for all IDEs
    const output = await this.sshExec(
      `squeue --user=${config.hpcUser} --name=${jobNames} --states=R,PD -h -O JobID,Name,State,NodeList,TimeLeft,TimeLimit,NumCPUs,MinMemory,StartTime 2>/dev/null`
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

      results[ide] = {
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
    }

    return results;
  }

  /**
   * Build sbatch wrap command for VS Code
   * Writes Machine settings and bootstraps extensions before starting server
   * @param {Object} options - Build options
   * @param {string} options.token - Connection token for authentication
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   */
  buildVscodeWrap(options = {}) {
    const { token, releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides.vscode;
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    // Paths (using \\$ for SSH escaping)
    const dataDir = '\\$HOME/.vscode-slurm/.vscode-server';
    const machineSettingsDir = `${dataDir}/data/Machine`;
    const extensionsDir = `${dataDir}/extensions`;
    const userDataDir = '\\$HOME/.vscode-slurm/user-data';
    const builtinExtDir = vscodeDefaults.builtinExtensionsDir;

    // Machine settings JSON (base64 encoded to avoid escaping issues)
    const machineSettings = JSON.stringify(vscodeDefaults.settings, null, 2);
    const machineSettingsBase64 = Buffer.from(machineSettings).toString('base64');

    // Keybindings JSON (only written if doesn't exist - preserves user customizations)
    const keybindings = JSON.stringify(vscodeDefaults.keybindings, null, 2);
    const keybindingsBase64 = Buffer.from(keybindings).toString('base64');

    // Setup: create dirs, write Machine settings, bootstrap extensions (if available)
    // Extension bootstrap: copy from image's builtin dir to user dir if not present
    // Conditional: older images (3.19) don't have builtin extensions - gracefully skip
    // See: https://github.com/drejom/vscode-rbioc/issues/14

    // Bootstrap script - base64 encoded to avoid escaping hell (see docs/ESCAPING.md)
    const dollar = '$';
    const bootstrapScript = `#!/bin/sh
# Bootstrap extensions from container image (if available)
if [ -d ${builtinExtDir} ]; then
  for ext in ${builtinExtDir}/*; do
    name=${dollar}{ext##*/}
    [ -d "${dollar}HOME/.vscode-slurm/.vscode-server/extensions/${dollar}name" ] || cp -r "${dollar}ext" "${dollar}HOME/.vscode-slurm/.vscode-server/extensions/"
  done
fi
# Bootstrap keybindings (only if user hasn't customized)
keybindingsFile="${dollar}HOME/.vscode-slurm/user-data/User/keybindings.json"
if [ ! -f "${dollar}keybindingsFile" ]; then
  mkdir -p "${dollar}HOME/.vscode-slurm/user-data/User"
  echo '${keybindingsBase64}' | base64 -d > "${dollar}keybindingsFile"
fi
`;
    const bootstrapBase64 = Buffer.from(bootstrapScript).toString('base64');

    // Port finder script - finds available port and writes to ~/.vscode-slurm/port
    // Handles port collisions when multiple users land on the same compute node
    const portFile = '\\$HOME/.vscode-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    const setup = [
      `mkdir -p ${machineSettingsDir} ${extensionsDir}`,
      `echo ${machineSettingsBase64} | base64 -d > ${machineSettingsDir}/settings.json`,
      // Run bootstrap script (extensions + keybindings)
      `echo ${bootstrapBase64} | base64 -d | sh`,
      // Find available port and export as IDE_PORT
      `eval \\$(echo ${portFinderBase64} | base64 -d | sh -s)`,
    ].join(' && ');

    // Python site-packages env (null if not configured for this cluster)
    const pythonEnvArg = pythonSitePackages ? `--env PYTHONPATH=${pythonSitePackages}` : null;

    // Singularity command - uses IDE_PORT from port finder
    const singularityCmd = [
      `${this.cluster.singularityBin} exec`,
      `--env TERM=xterm-256color`,
      `--env R_LIBS_SITE=${releasePaths.rLibsSite}`,
      pythonEnvArg,
      // Use file-based keyring instead of gnome-keyring (not available in container)
      // See: https://github.com/drejom/omhq-hpc-code-server-stack/issues/4
      `--env VSCODE_KEYRING_PASS=hpc-code-server`,
      `-B ${this.cluster.bindPaths}`,
      releasePaths.singularityImage,
      `code serve-web`,
      `--host 0.0.0.0`,
      `--port \\$IDE_PORT`,
      token ? `--connection-token=${token}` : '--without-connection-token',
      `--accept-server-license-terms`,
      `--disable-telemetry`,
      `--server-base-path /vscode-direct`,
      `--server-data-dir ${dataDir}`,
      `--extensions-dir ${extensionsDir}`,
      `--user-data-dir ${userDataDir}`,
    ].filter(Boolean).join(' ');

    return `${setup} && ${singularityCmd}`;
  }

  /**
   * Build sbatch wrap command for RStudio
   * Based on proven /opt/singularity-images/rbioc/rbioc319.job script
   * Uses auth-none=1 mode (like jupyter-rsession-proxy) - no login required.
   * Requires --env USER for user-id cookie when using --cleanenv.
   * @param {number} cpus - Number of CPUs
   * @param {Object} options - Build options
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   * @returns {string} sbatch wrap command
   */
  buildRstudioWrap(cpus, options = {}) {
    const { releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides.rstudio;
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    // ESCAPING: Two different contexts require different escaping strategies
    // See docs/ESCAPING.md for full explanation.
    //
    // 1. INLINE SHELL COMMANDS (setup array, singularity binds):
    //    These go through: JS -> SSH double-quotes -> shell on compute node
    //    Use \\$HOME which becomes \$HOME after JS, then $HOME on compute node
    //
    // 2. BASE64-ENCODED SCRIPTS (rsessionScript, config files):
    //    These are base64-encoded in JS, decoded on compute node, then executed
    //    Use ${dollar} pattern: JS interprets ${dollar} as '$', base64 preserves it
    //
    // WARNING: Do NOT use ${dollar} for inline commands - it produces bare $
    // which expands on the LOCAL machine (Dokploy container), not the compute node!

    // workdir is used in INLINE commands - needs \\$ escaping for SSH context
    const workdir = '\\$HOME/.rstudio-slurm/workdir';

    // dollar is used in BASE64-ENCODED scripts only - see warning above
    const dollar = '$';

    // Use base64 encoding for ALL config files to avoid escaping issues

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
    // See config/index.js for settings (HPC-friendly, fonts, terminal)
    const rstudioPrefs = JSON.stringify(rstudioDefaults);
    const rstudioPrefsBase64 = Buffer.from(rstudioPrefs).toString('base64');

    // Extract major.minor version from releaseVersion for R_LIBS_USER path
    const biocVersion = releaseVersion;
    const rsessionScript = `#!/bin/sh
exec 2>>${dollar}HOME/.rstudio-slurm/rsession.log
set -x
export R_HOME=/usr/local/lib/R
export LD_LIBRARY_PATH=/usr/local/lib/R/lib:/usr/local/lib
export OMP_NUM_THREADS=${cpus}
export R_LIBS_SITE=${releasePaths.rLibsSite}
export R_LIBS_USER=${dollar}HOME/R/bioc-${biocVersion}
export TMPDIR=/tmp
export TZ=America/Los_Angeles
exec /usr/lib/rstudio-server/bin/rsession "${dollar}@"
`;
    const rsessionBase64 = Buffer.from(rsessionScript).toString('base64');

    // Port finder script - finds available port and writes to ~/.rstudio-slurm/port
    // Handles port collisions when multiple users land on the same compute node
    const portFile = '\\$HOME/.rstudio-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    // IMPORTANT: Do NOT use quotes around base64 strings!
    // The sbatch --wrap='...' uses single quotes, so any single quotes inside
    // would break shell parsing. Base64 is alphanumeric + /+= so no quotes needed.
    const setup = [
      `mkdir -p ${workdir}/run ${workdir}/tmp ${workdir}/var/lib/rstudio-server`,
      `echo ${dbConfBase64} | base64 -d > ${workdir}/database.conf`,
      `echo ${rserverConfBase64} | base64 -d > ${workdir}/rserver.conf`,
      `echo ${rstudioPrefsBase64} | base64 -d > ${workdir}/rstudio-prefs.json`,
      `echo ${rsessionBase64} | base64 -d > ${workdir}/rsession.sh && chmod +x ${workdir}/rsession.sh`,
      // Find available port and export as IDE_PORT
      `eval \\$(echo ${portFinderBase64} | base64 -d | sh -s)`,
    ].join(' && ');

    // Build singularity bind paths for RStudio
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

    // Build rserver command - uses IDE_PORT from port finder
    // Use auth-none=1 mode like jupyter-rsession-proxy - no login required
    // See: https://github.com/jupyterhub/jupyter-rsession-proxy
    // --secure-cookie-key-file must be unique per session to avoid conflicts
    // --www-frame-origin=same allows iframe embedding from same origin
    // --www-verify-user-agent=0 relaxes browser agent checks
    const envSetup = [
      'export SINGULARITYENV_RSTUDIO_SESSION_TIMEOUT=0',
    ].join(' && ');

    // Python site-packages env (null if not configured for this cluster)
    const pythonEnvArg = pythonSitePackages ? `--env PYTHONPATH=${pythonSitePackages}` : null;

    const singularityCmd = [
      `${this.cluster.singularityBin} exec --cleanenv`,
      `--env R_LIBS_SITE=${releasePaths.rLibsSite}`,
      pythonEnvArg,
      '--env USER=\\$(whoami)',  // Required for auth-none - user-id cookie needs username
      `-B ${rstudioBinds}`,
      `${releasePaths.singularityImage}`,
      `rserver`,
      '--www-address=0.0.0.0',
      `--www-port=\\$IDE_PORT`,
      `--server-user=\\$(whoami)`,
      '--auth-none=1',
      '--www-frame-origin=same',
      '--www-verify-user-agent=0',
      `--secure-cookie-key-file=${workdir}/secure-cookie-key`,
      '--rsession-path=/etc/rstudio/rsession.sh',
    ].filter(Boolean).join(' ');

    const rserverCmd = `${envSetup} && ${singularityCmd}`;

    return `${setup} && ${rserverCmd}`;
  }

  /**
   * Build sbatch wrap command for JupyterLab
   * Uses shared Python site-packages (mirrors R_LIBS_SITE pattern)
   * @param {Object} options - Options including gpu type, token, and release version
   * @param {string} options.gpu - GPU type ('none', 'a100', 'v100')
   * @param {string} options.token - Authentication token
   * @param {string} options.releaseVersion - Bioconductor release version (e.g., '3.22')
   * @returns {string} sbatch wrap command
   */
  buildJupyterWrap(options = {}) {
    const { gpu = 'none', token, releaseVersion = defaultReleaseVersion } = options;
    const ideConfig = ides.jupyter;
    const workdir = '\\$HOME/.jupyter-slurm';
    const releasePaths = getReleasePaths(this.clusterName, releaseVersion);
    const pythonSitePackages = releasePaths.pythonEnv || '';

    // Port finder script - finds available port and writes to ~/.jupyter-slurm/port
    // Handles port collisions when multiple users land on the same compute node
    const portFile = '\\$HOME/.jupyter-slurm/port';
    const portFinderBase64 = buildPortFinderScript(ideConfig.port, portFile);

    const setup = [
      `mkdir -p ${workdir}`,
      `mkdir -p ${workdir}/runtime`,
      // Find available port and export as IDE_PORT
      `eval \\$(echo ${portFinderBase64} | base64 -d | sh -s)`,
    ].join(' && ');

    // GPU passthrough flag (--nv enables NVIDIA GPU access in container)
    const nvFlag = gpu !== 'none' ? '--nv' : null;

    // Token env var for authentication (null if no token = disable auth)
    const tokenEnv = token ? `--env JUPYTER_TOKEN=${token}` : null;
    const tokenArg = token ? null : `--ServerApp.token=''`;

    // Python site-packages env (null if not configured for this cluster)
    const pythonEnvArg = pythonSitePackages ? `--env PYTHONPATH=${pythonSitePackages}` : null;

    // Singularity command - uses IDE_PORT from port finder
    const singularityCmd = [
      this.cluster.singularityBin,
      'exec',
      nvFlag,
      `--env TERM=xterm-256color`,
      tokenEnv,
      pythonEnvArg,
      `--env R_LIBS_SITE=${releasePaths.rLibsSite}`,
      `--env JUPYTER_DATA_DIR=${workdir}`,
      `--env JUPYTER_RUNTIME_DIR=${workdir}/runtime`,
      `-B ${this.cluster.bindPaths}`,
      releasePaths.singularityImage,
      `jupyter lab`,
      `--ip=0.0.0.0`,
      `--port=\\$IDE_PORT`,
      `--no-browser`,
      tokenArg,
      `--ServerApp.password=''`,
      `--ServerApp.root_dir=\\$HOME`,
      `--ServerApp.base_url=/jupyter-direct`,
      `--ServerApp.allow_remote_access=True`,
    ].filter(Boolean).join(' ');

    return `${setup} && ${singularityCmd}`;
  }

  /**
   * Submit a new SLURM job for an IDE
   * @param {string} cpus - Number of CPUs
   * @param {string} mem - Memory (e.g., "40G")
   * @param {string} time - Walltime (e.g., "12:00:00")
   * @param {string} ide - IDE type ('vscode', 'rstudio', 'jupyter')
   * @param {Object} options - Additional options
   * @param {string} options.gpu - GPU type ('none', 'a100', 'v100') - Gemini only
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
    let gresArg = null;

    if (gpu) {
      const clusterGpu = gpuConfig[this.clusterName];
      if (!clusterGpu || !clusterGpu[gpu]) {
        throw new Error(`GPU type '${gpu}' not available on ${this.clusterName}`);
      }
      const gpuOpts = clusterGpu[gpu];
      partition = gpuOpts.partition;
      gresArg = `--gres=${gpuOpts.gres}`;
    }

    // Logs written to /tmp on compute node - node name available in server logs
    // To locate logs if needed: ssh <node> cat /tmp/hpc-vscode_<jobid>.log
    const logDir = '/tmp';

    // Build IDE-specific wrap command (pass releaseVersion for release-specific paths)
    let wrapCmd;
    switch (ide) {
      case 'vscode':
        wrapCmd = this.buildVscodeWrap({ token, releaseVersion });
        break;
      case 'rstudio':
        wrapCmd = this.buildRstudioWrap(cpus, { releaseVersion });
        break;
      case 'jupyter':
        wrapCmd = this.buildJupyterWrap({ gpu, token, releaseVersion });
        break;
      default:
        throw new Error(`Unknown IDE: ${ide}`);
    }

    const submitCmd = [
      'sbatch',
      `--job-name=${ideConfig.jobName}`,
      '--nodes=1',
      `--cpus-per-task=${cpus}`,
      `--mem=${mem}`,
      `--partition=${partition}`,
      gresArg,
      `--time=${time}`,
      `--output=${logDir}/${ideConfig.jobName}_%j.log`,
      `--error=${logDir}/${ideConfig.jobName}_%j.err`,
      `--wrap='${wrapCmd}'`,
    ].filter(Boolean).join(' ');

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

    // Port file paths match those in build*Wrap methods
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
      const cmd = `ssh ${node} "ss -tln 2>/dev/null | grep -E '${pattern}'"`;
      const output = await this.sshExec(cmd);

      // Parse output - each line shows a listening port
      for (const port of ports) {
        if (output.includes(`:${port}`)) {
          result[port] = true;
        }
      }
      log.debugFor('tunnel', `Port check on ${node}`, { ports: result, cluster: this.clusterName });
    } catch (e) {
      // SSH failed or no ports listening - return all false
      log.debugFor('tunnel', `Port check failed on ${node}`, { error: e.message, cluster: this.clusterName });
    }

    return result;
  }
}

module.exports = HpcService;
