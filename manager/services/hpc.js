/**
 * HPC Service Layer
 * Handles SLURM job management and SSH operations for HPC clusters
 */

const { exec } = require('child_process');
const { config, clusters } = require('../config');
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
   * Get job information from SLURM queue
   * @returns {Promise<Object|null>} Job info or null if no job found
   */
  async getJobInfo() {
    try {
      const output = await this.sshExec(
        `squeue --user=${config.hpcUser} --name=code-server --states=R,PD -h -O JobID,State,NodeList,TimeLeft,TimeLimit,NumCPUs,MinMemory,StartTime 2>/dev/null | head -1`
      );

      if (!output) return null;

      const parts = output.split(/\s+/);
      const [jobId, jobState, node, timeLeft, timeLimit, cpus, memory, ...startTimeParts] = parts;
      const startTime = startTimeParts.join(' '); // StartTime may have spaces

      return {
        jobId,
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
   * Submit a new SLURM job for code-server
   * @param {string} cpus - Number of CPUs
   * @param {string} mem - Memory (e.g., "40G")
   * @param {string} time - Walltime (e.g., "12:00:00")
   * @returns {Promise<string>} Job ID
   */
  async submitJob(cpus, mem, time) {
    const logDir = `/home/${config.hpcUser}/vscode-slurm-logs`;

    const submitCmd = [
      'sbatch',
      '--job-name=code-server',
      '--nodes=1',
      `--cpus-per-task=${cpus}`,
      `--mem=${mem}`,
      `--partition=${this.cluster.partition}`,
      `--time=${time}`,
      `--output=${logDir}/code-server_%j.log`,
      `--error=${logDir}/code-server_%j.err`,
      `--wrap='mkdir -p ${logDir} && ${this.cluster.singularityBin} exec`,
      '--env TERM=xterm-256color',
      `--env R_LIBS_SITE=${this.cluster.rLibsSite}`,
      `-B ${this.cluster.bindPaths}`,
      `${this.cluster.singularityImage}`,
      'code serve-web',
      '--host 0.0.0.0',
      `--port ${config.codeServerPort}`,
      '--without-connection-token',
      '--accept-server-license-terms',
      '--disable-telemetry',
      '--server-base-path /vscode-direct',
      '--server-data-dir ~/.vscode-slurm/.vscode-server',
      '--extensions-dir ~/.vscode-slurm/.vscode-server/extensions',
      "--user-data-dir ~/.vscode-slurm/user-data'",
    ].join(' ');

    const output = await this.sshExec(submitCmd);
    const match = output.match(/Submitted batch job (\d+)/);

    if (!match) {
      throw new Error('Failed to parse job ID from: ' + output);
    }

    log.job(`Submitted`, { cluster: this.clusterName, jobId: match[1], cpus, mem, time });
    return match[1];
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
   * @param {number} maxAttempts - Maximum polling attempts (default 60 = 5 minutes)
   * @returns {Promise<string>} Node name
   */
  async waitForNode(jobId, maxAttempts = 60) {
    let attempts = 0;

    while (attempts < maxAttempts) {
      const jobInfo = await this.getJobInfo();

      if (!jobInfo) {
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
