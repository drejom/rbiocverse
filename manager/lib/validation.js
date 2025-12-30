/**
 * Security-critical input validation
 * Prevents command injection in sbatch commands
 */

/**
 * Validate sbatch job parameters
 * @param {string} cpus - Number of CPUs (must be integer 1-128)
 * @param {string} mem - Memory allocation (format: "40G", "100M")
 * @param {string} time - Walltime (format: "HH:MM:SS" or "D-HH:MM:SS")
 * @throws {Error} If any parameter is invalid
 */
function validateSbatchInputs(cpus, mem, time) {
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

module.exports = { validateSbatchInputs, validateHpcName };
