/**
 * HPC Service Layer
 * Handles SLURM job management and SSH operations for HPC clusters
 */

const { exec } = require('child_process');
const { config, clusters, ides } = require('../config');
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
   * @returns {Promise<Object>} Map of ide -> job info (or null)
   */
  async getAllJobs() {
    const results = {};
    for (const ide of Object.keys(ides)) {
      results[ide] = await this.getJobInfo(ide);
    }
    return results;
  }

  /**
   * Build sbatch wrap command for VS Code
   */
  buildVscodeWrap() {
    const ideConfig = ides.vscode;
    return `${this.cluster.singularityBin} exec ` +
      `--env TERM=xterm-256color ` +
      `--env R_LIBS_SITE=${this.cluster.rLibsSite} ` +
      `-B ${this.cluster.bindPaths} ` +
      `${this.cluster.singularityImage} ` +
      `code serve-web ` +
      `--host 0.0.0.0 ` +
      `--port ${ideConfig.port} ` +
      `--without-connection-token ` +
      `--accept-server-license-terms ` +
      `--disable-telemetry ` +
      `--server-base-path /vscode-direct ` +
      `--server-data-dir ~/.vscode-slurm/.vscode-server ` +
      `--extensions-dir ~/.vscode-slurm/.vscode-server/extensions ` +
      `--user-data-dir ~/.vscode-slurm/user-data`;
  }

  /**
   * Build sbatch wrap command for RStudio
   * Based on proven /opt/singularity-images/rbioc/rbioc319.job script
   * Uses auth-none=1 mode (like jupyter-rsession-proxy) - no login required
   * @param {number} cpus - Number of CPUs
   * @returns {string} sbatch wrap command
   */
  buildRstudioWrap(cpus) {
    const ideConfig = ides.rstudio;
    // Use ${dollar} pattern to inject shell $ into base64-encoded scripts
    // JS template literals interpret ${...} as substitution, so we use ${dollar}
    // to inject a literal $ character. The dollar variable is set to '$' below.
    // See docs/ESCAPING.md for full explanation.
    const dollar = '$';
    const workdir = `${dollar}HOME/.rstudio-slurm/workdir`;

    // Use base64 encoding for ALL config files to avoid escaping issues
    // See docs/ESCAPING.md for rationale

    const dbConf = `provider=sqlite
directory=/var/lib/rstudio-server
`;
    const dbConfBase64 = Buffer.from(dbConf).toString('base64');

    const rserverConf = `rsession-which-r=/usr/local/bin/R
auth-cookies-force-secure=0
www-root-path=/rstudio-direct
session-save-action-default=no
`;
    const rserverConfBase64 = Buffer.from(rserverConf).toString('base64');

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

    const setup = [
      `mkdir -p ${workdir}/run ${workdir}/tmp ${workdir}/var/lib/rstudio-server`,
      `echo '${dbConfBase64}' | base64 -d > ${workdir}/database.conf`,
      `echo '${rserverConfBase64}' | base64 -d > ${workdir}/rserver.conf`,
      `echo '${rsessionBase64}' | base64 -d > ${workdir}/rsession.sh && chmod +x ${workdir}/rsession.sh`,
    ].join(' && ');

    // Build singularity bind paths for RStudio
    const rstudioBinds = [
      `${workdir}/run:/run`,
      `${workdir}/tmp:/tmp`,
      `${workdir}/database.conf:/etc/rstudio/database.conf`,
      `${workdir}/rserver.conf:/etc/rstudio/rserver.conf`,
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
      `-B ${rstudioBinds}`,
      `${this.cluster.singularityImage}`,
      `rserver`,
      '--www-address=0.0.0.0',
      `--www-port=${ideConfig.port}`,
      `--server-user=$(whoami)`,
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

    const logDir = `/home/${config.hpcUser}/hpc-slurm-logs`;

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
      `--wrap='mkdir -p ${logDir} && ${wrapCmd}'`,
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
   * @param {number} maxAttempts - Maximum polling attempts (default 60 = 5 minutes)
   * @returns {Promise<string>} Node name
   */
  async waitForNode(jobId, ide = 'vscode', maxAttempts = 60) {
    let attempts = 0;

    while (attempts < maxAttempts) {
      const jobInfo = await this.getJobInfo(ide);

      if (!jobInfo || jobInfo.jobId !== jobId) {
        throw new Error('Job disappeared from queue');
      }

      if (jobInfo.state === 'RUNNING' && jobInfo.node) {
        return jobInfo.node;
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
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
