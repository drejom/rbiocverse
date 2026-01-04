/**
 * Security-critical input validation
 * Prevents command injection in sbatch commands
 */

const { partitionLimits, clusters, gpuConfig } = require('../config');

/**
 * Parse time string to seconds
 * @param {string} time - Time in format "HH:MM:SS" or "D-HH:MM:SS"
 * @returns {number} Time in seconds
 */
function parseTimeToSeconds(time) {
  const dayMatch = time.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    const [, days, hours, mins, secs] = dayMatch.map(Number);
    return days * 86400 + hours * 3600 + mins * 60 + secs;
  }
  const timeMatch = time.match(/^(\d+):(\d+):(\d+)$/);
  if (timeMatch) {
    const [, hours, mins, secs] = timeMatch.map(Number);
    return hours * 3600 + mins * 60 + secs;
  }
  return 0;
}

/**
 * Parse memory string to MB
 * @param {string} mem - Memory like "40G" or "100M"
 * @returns {number} Memory in MB
 */
function parseMemToMB(mem) {
  const match = mem.match(/^(\d+)([gGmM])$/);
  if (!match) return 0;
  const [, value, unit] = match;
  return unit.toLowerCase() === 'g' ? parseInt(value) * 1024 : parseInt(value);
}

/**
 * Get partition limits for a cluster and GPU type
 * @param {string} hpc - Cluster name
 * @param {string} gpu - GPU type ('' for none)
 * @returns {Object} Partition limits { maxCpus, maxMemMB, maxTime }
 */
function getPartitionLimits(hpc, gpu = '') {
  const clusterLimits = partitionLimits[hpc];
  if (!clusterLimits) return null;

  // Determine partition based on GPU selection
  let partition;
  if (gpu && gpuConfig[hpc] && gpuConfig[hpc][gpu]) {
    partition = gpuConfig[hpc][gpu].partition;
  } else {
    partition = clusters[hpc].partition;
  }

  return clusterLimits[partition] || null;
}

/**
 * Validate sbatch job parameters against cluster limits
 * @param {string} cpus - Number of CPUs
 * @param {string} mem - Memory allocation (format: "40G", "100M")
 * @param {string} time - Walltime (format: "HH:MM:SS" or "D-HH:MM:SS")
 * @param {string} hpc - Cluster name (required for limit checking)
 * @param {string} gpu - GPU type (optional, affects partition limits)
 * @throws {Error} If any parameter is invalid or exceeds limits
 */
function validateSbatchInputs(cpus, mem, time, hpc, gpu = '') {
  // CPUs: must be integer 1-128
  if (!/^\d+$/.test(cpus) || parseInt(cpus) < 1 || parseInt(cpus) > 128) {
    throw new Error('Invalid CPU value: must be integer 1-128');
  }

  // Memory: must match pattern like "40G", "100M", "8g"
  if (!/^\d+[gGmM]$/.test(mem)) {
    throw new Error('Invalid memory value: use format like "40G" or "100M"');
  }

  // Time: must match HH:MM:SS or D-HH:MM:SS format
  if (!/^(\d{1,2}-)?\d{1,2}:\d{2}:\d{2}$/.test(time)) {
    throw new Error('Invalid time value: use format like "12:00:00" or "1-00:00:00"');
  }

  // Validate against partition limits
  const limits = getPartitionLimits(hpc, gpu);
  if (limits) {
    const cpuVal = parseInt(cpus);
    const memMB = parseMemToMB(mem);
    const timeSecs = parseTimeToSeconds(time);
    const maxTimeSecs = parseTimeToSeconds(limits.maxTime);

    if (cpuVal > limits.maxCpus) {
      throw new Error(`CPU limit exceeded: ${hpc} allows max ${limits.maxCpus} CPUs`);
    }
    if (memMB > limits.maxMemMB) {
      const maxMemG = Math.floor(limits.maxMemMB / 1024);
      throw new Error(`Memory limit exceeded: ${hpc} allows max ${maxMemG}G`);
    }
    if (timeSecs > maxTimeSecs) {
      throw new Error(`Time limit exceeded: ${hpc} allows max ${limits.maxTime}`);
    }
  }
}

/**
 * Validate HPC cluster name
 * @param {string} hpc - Cluster name
 * @throws {Error} If cluster name is invalid
 */
function validateHpcName(hpc) {
  const validHpcs = ['gemini', 'apollo'];
  if (!validHpcs.includes(hpc)) {
    throw new Error(`Invalid HPC: must be one of ${validHpcs.join(', ')}`);
  }
}

module.exports = {
  validateSbatchInputs,
  validateHpcName,
  getPartitionLimits,
  parseTimeToSeconds,
  parseMemToMB,
};
