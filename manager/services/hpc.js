/**
 * HPC Service Layer
 * Handles SLURM job management and SSH operations for HPC clusters
 */

const { exec } = require('child_process');
const { config, clusters, ides, vscodeDefaults, rstudioDefaults } = require('../config');
const { log } = require('../lib/logger');

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
   */
  buildVscodeWrap() {
    const ideConfig = ides.vscode;

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

    const setup = [
      `mkdir -p ${machineSettingsDir} ${extensionsDir}`,
      `echo ${machineSettingsBase64} | base64 -d > ${machineSettingsDir}/settings.json`,
      // Run bootstrap script (extensions + keybindings)
      `echo ${bootstrapBase64} | base64 -d | sh`,
    ].join(' && ');

    // Singularity command
    const singularityCmd = [
      `${this.cluster.singularityBin} exec`,
      `--env TERM=xterm-256color`,
      `--env R_LIBS_SITE=${this.cluster.rLibsSite}`,
      // Use file-based keyring instead of gnome-keyring (not available in container)
      // See: https://github.com/drejom/omhq-hpc-code-server-stack/issues/4
      `--env VSCODE_KEYRING_PASS=hpc-code-server`,
      `-B ${this.cluster.bindPaths}`,
      this.cluster.singularityImage,
      `code serve-web`,
      `--host 0.0.0.0`,
      `--port ${ideConfig.port}`,
      `--without-connection-token`,
      `--accept-server-license-terms`,
      `--disable-telemetry`,
      `--server-base-path /vscode-direct`,
      `--server-data-dir ${dataDir}`,
      `--extensions-dir ${extensionsDir}`,
      `--user-data-dir ${userDataDir}`,
    ].join(' ');

    return `${setup} && ${singularityCmd}`;
  }

  /**
   * Build sbatch wrap command for RStudio
   * Based on proven /opt/singularity-images/rbioc/rbioc319.job script
   * Uses auth-none=1 mode (like jupyter-rsession-proxy) - no login required.
   * Requires --env USER for user-id cookie when using --cleanenv.
   * @param {number} cpus - Number of CPUs
   * @returns {string} sbatch wrap command
   */
  buildRstudioWrap(cpus) {
    const ideConfig = ides.rstudio;

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

    const rsessionScript = `#!/bin/sh
exec 2>>${dollar}HOME/.rstudio-slurm/rsession.log
set -x
export R_HOME=/usr/local/lib/R
export LD_LIBRARY_PATH=/usr/local/lib/R/lib:/usr/local/lib
export OMP_NUM_THREADS=${cpus}
export R_LIBS_SITE=${this.cluster.rLibsSite}
export R_LIBS_USER=${dollar}HOME/R/bioc-3.19
export TMPDIR=/tmp
export TZ=America/Los_Angeles
exec /usr/lib/rstudio-server/bin/rsession "${dollar}@"
`;
    const rsessionBase64 = Buffer.from(rsessionScript).toString('base64');

    // IMPORTANT: Do NOT use quotes around base64 strings!
    // The sbatch --wrap='...' uses single quotes, so any single quotes inside
    // would break shell parsing. Base64 is alphanumeric + /+= so no quotes needed.
    const setup = [
      `mkdir -p ${workdir}/run ${workdir}/tmp ${workdir}/var/lib/rstudio-server`,
      `echo ${dbConfBase64} | base64 -d > ${workdir}/database.conf`,
      `echo ${rserverConfBase64} | base64 -d > ${workdir}/rserver.conf`,
      `echo ${rstudioPrefsBase64} | base64 -d > ${workdir}/rstudio-prefs.json`,
      `echo ${rsessionBase64} | base64 -d > ${workdir}/rsession.sh && chmod +x ${workdir}/rsession.sh`,
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

    // Build rserver command
    // Use auth-none=1 mode like jupyter-rsession-proxy - no login required
    // See: https://github.com/jupyterhub/jupyter-rsession-proxy
    // --secure-cookie-key-file must be unique per session to avoid conflicts
    // --www-frame-origin=same allows iframe embedding from same origin
    // --www-verify-user-agent=0 relaxes browser agent checks
    const envSetup = [
      'export SINGULARITYENV_RSTUDIO_SESSION_TIMEOUT=0',
    ].join(' && ');

    const singularityCmd = [
      `${this.cluster.singularityBin} exec --cleanenv`,
      `--env R_LIBS_SITE=${this.cluster.rLibsSite}`,
      '--env USER=\\$(whoami)',  // Required for auth-none - user-id cookie needs username
      `-B ${rstudioBinds}`,
      `${this.cluster.singularityImage}`,
      `rserver`,
      '--www-address=0.0.0.0',
      `--www-port=${ideConfig.port}`,
      `--server-user=\\$(whoami)`,
      '--auth-none=1',
      '--www-frame-origin=same',
      '--www-verify-user-agent=0',
      `--secure-cookie-key-file=${workdir}/secure-cookie-key`,
      '--rsession-path=/etc/rstudio/rsession.sh',
    ].join(' ');

    const rserverCmd = `${envSetup} && ${singularityCmd}`;

    return `${setup} && ${rserverCmd}`;
  }

  /**
   * Submit a new SLURM job for an IDE
   * @param {string} cpus - Number of CPUs
   * @param {string} mem - Memory (e.g., "40G")
   * @param {string} time - Walltime (e.g., "12:00:00")
   * @param {string} ide - IDE type ('vscode', 'rstudio')
   * @returns {Promise<{jobId: string}>} Job ID
   */
  async submitJob(cpus, mem, time, ide = 'vscode') {
    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    // Logs written to /tmp on compute node - node name available in server logs
    // To locate logs if needed: ssh <node> cat /tmp/hpc-vscode_<jobid>.log
    const logDir = '/tmp';

    // Build IDE-specific wrap command
    let wrapCmd;
    switch (ide) {
      case 'vscode':
        wrapCmd = this.buildVscodeWrap();
        break;
      case 'rstudio':
        wrapCmd = this.buildRstudioWrap(cpus);
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
      `--partition=${this.cluster.partition}`,
      `--time=${time}`,
      `--output=${logDir}/${ideConfig.jobName}_%j.log`,
      `--error=${logDir}/${ideConfig.jobName}_%j.err`,
      `--wrap='${wrapCmd}'`,
    ].join(' ');

    const output = await this.sshExec(submitCmd);
    const match = output.match(/Submitted batch job (\d+)/);

    if (!match) {
      throw new Error('Failed to parse job ID from: ' + output);
    }

    log.job(`Submitted`, { cluster: this.clusterName, jobId: match[1], ide, cpus, mem, time });
    return { jobId: match[1] };
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
}

module.exports = HpcService;
