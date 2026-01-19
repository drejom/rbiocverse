/**
 * Security-critical input validation
 * Prevents command injection in sbatch commands
 *
 * Also provides Joi schemas for API request validation.
 */

const { partitionLimits, clusters, gpuConfig } = require('../config');

// Joi is optional - gracefully handle if not installed
let Joi = null;
try {
  Joi = require('joi');
} catch (e) {
  // Joi not installed - schema validation will be a no-op
}

// ============================================
// Joi Schemas for API Validation
// ============================================

/**
 * Create validation schemas (only if Joi is available)
 */
const schemas = Joi ? {
  // User management schemas
  updateUser: Joi.object({
    fullName: Joi.string().max(100).allow('', null).optional(),
  }),

  bulkUserAction: Joi.object({
    action: Joi.string().valid('delete', 'delete-keys').required(),
    usernames: Joi.array().items(Joi.string().max(50)).min(1).max(100).required(),
  }),

  // Session launch schemas
  launchSession: Joi.object({
    hpc: Joi.string().valid('gemini', 'apollo').required(),
    ide: Joi.string().valid('vscode', 'rstudio', 'jupyter').required(),
    cpus: Joi.alternatives().try(
      Joi.number().integer().min(1).max(128),
      Joi.string().pattern(/^\d+$/)
    ).required(),
    memory: Joi.string().pattern(/^\d+[gGmM]$/).required(),
    walltime: Joi.string().pattern(/^(\d{1,2}-)?\d{1,2}:\d{2}:\d{2}$/).required(),
    releaseVersion: Joi.string().pattern(/^[\d.]+$/).optional(),
    gpu: Joi.string().valid('', 'a100', 'v100').optional(),
    account: Joi.string().max(50).optional(),
    shiny: Joi.boolean().optional(),
    liveServer: Joi.boolean().optional(),
  }),

  // Search query
  searchQuery: Joi.object({
    q: Joi.string().min(2).max(100).required(),
  }),

  // Pagination
  pagination: Joi.object({
    limit: Joi.number().integer().min(1).max(1000).default(100),
    offset: Joi.number().integer().min(0).default(0),
    days: Joi.number().integer().min(1).max(365).default(30),
  }),

  // Username param
  usernameParam: Joi.object({
    username: Joi.string().max(50).pattern(/^[a-zA-Z0-9._-]+$/).required(),
  }),
} : {};

/**
 * Express middleware factory for Joi validation
 * @param {Object} schema - Joi schema
 * @param {string} [property='body'] - Request property to validate ('body', 'query', 'params')
 * @returns {Function} Express middleware
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    if (!Joi || !schema) {
      return next(); // Skip validation if Joi not available
    }

    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const details = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
      }));

      return res.status(400).json({
        error: 'Validation failed',
        details,
      });
    }

    // Replace with validated/sanitized values
    req[property] = value;
    next();
  };
}

/**
 * Check if Joi is available
 * @returns {boolean}
 */
function isJoiAvailable() {
  return Joi !== null;
}

// ============================================
// Query Parameter Helpers
// ============================================

/**
 * Parse integer query parameter with default value
 * @param {Object} query - Express req.query object
 * @param {string} name - Parameter name
 * @param {number} defaultValue - Default if missing or invalid
 * @param {Object} [options]
 * @param {number} [options.min] - Minimum allowed value
 * @param {number} [options.max] - Maximum allowed value
 * @returns {number}
 */
function parseQueryInt(query, name, defaultValue, options = {}) {
  const raw = query?.[name];
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }

  // Apply bounds if specified
  if (options.min !== undefined && parsed < options.min) {
    return options.min;
  }
  if (options.max !== undefined && parsed > options.max) {
    return options.max;
  }

  return parsed;
}

/**
 * Extract common pagination/filter params from query
 * @param {Object} query - Express req.query object
 * @param {Object} [defaults]
 * @param {number} [defaults.days=30]
 * @param {number} [defaults.limit=100]
 * @param {number} [defaults.offset=0]
 * @returns {{ days: number, limit: number, offset: number }}
 */
function parseQueryParams(query, defaults = {}) {
  return {
    days: parseQueryInt(query, 'days', defaults.days ?? 30, { min: 1, max: 365 }),
    limit: parseQueryInt(query, 'limit', defaults.limit ?? 100, { min: 1, max: 1000 }),
    offset: parseQueryInt(query, 'offset', defaults.offset ?? 0, { min: 0 }),
  };
}

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
  // Sbatch validation
  validateSbatchInputs,
  validateHpcName,
  getPartitionLimits,
  parseTimeToSeconds,
  parseMemToMB,

  // Joi schemas and middleware
  schemas,
  validate,
  isJoiAvailable,

  // Query parameter helpers
  parseQueryInt,
  parseQueryParams,
};
