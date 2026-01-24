/**
 * Security-critical input validation
 * Prevents command injection in sbatch commands
 *
 * Also provides Joi schemas for API request validation.
 */

import { Request, Response, NextFunction } from 'express';
import { partitionLimits, clusters, gpuConfig, GpuPartitionConfig } from '../config';
import * as dynamicPartitions from './partitions';

// Joi is optional - gracefully handle if not installed
let Joi: typeof import('joi') | null = null;
try {
  Joi = require('joi');
} catch {
  // Joi not installed - schema validation will be a no-op
}

// Type for partition limits
interface PartitionLimit {
  maxCpus: number;
  maxMemMB: number;
  maxTime: string;
  gpuType?: string;
  gpuCount?: number;
  restricted?: boolean;
  restrictionReason?: string | null;
}

// Type for Joi validation error detail
interface JoiErrorDetail {
  path: (string | number)[];
  message: string;
}

// Type for Joi validation result
interface JoiValidationResult<T> {
  error?: { details: JoiErrorDetail[] };
  value: T;
}

// Type for Joi schema
interface JoiSchema {
  validate(data: unknown, options?: { abortEarly?: boolean; stripUnknown?: boolean }): JoiValidationResult<unknown>;
}

// ============================================
// Joi Schemas for API Validation
// ============================================

/**
 * Create validation schemas (only if Joi is available)
 */
export const schemas: Record<string, JoiSchema | null> = Joi ? {
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
 * @param schema - Joi schema
 * @param property - Request property to validate ('body', 'query', 'params')
 * @returns Express middleware
 */
export function validate(
  schema: JoiSchema | null | undefined,
  property: 'body' | 'query' | 'params' = 'body'
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[property] = value;
    next();
  };
}

/**
 * Check if Joi is available
 * @returns Whether Joi is installed
 */
export function isJoiAvailable(): boolean {
  return Joi !== null;
}

// ============================================
// Query Parameter Helpers
// ============================================

/**
 * Safely extract a string query parameter
 * Express query params can be string | string[] | ParsedQs | ParsedQs[] | undefined
 * This normalizes to string | undefined
 * @param value - Query param value
 * @returns String value or undefined
 */
export function queryString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

interface ParseQueryIntOptions {
  min?: number;
  max?: number;
}

/**
 * Parse integer query parameter with default value
 * @param query - Express req.query object
 * @param name - Parameter name
 * @param defaultValue - Default if missing or invalid
 * @param options - Min/max bounds
 * @returns Parsed integer value
 */
export function parseQueryInt(
  query: Record<string, unknown> | undefined,
  name: string,
  defaultValue: number,
  options: ParseQueryIntOptions = {}
): number {
  const raw = query?.[name];
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(String(raw), 10);
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

interface QueryParams {
  days: number;
  limit: number;
  offset: number;
}

interface QueryParamsDefaults {
  days?: number;
  limit?: number;
  offset?: number;
}

/**
 * Extract common pagination/filter params from query
 * @param query - Express req.query object
 * @param defaults - Default values
 * @returns Parsed query parameters
 */
export function parseQueryParams(
  query: Record<string, unknown> | undefined,
  defaults: QueryParamsDefaults = {}
): QueryParams {
  return {
    days: parseQueryInt(query, 'days', defaults.days ?? 30, { min: 1, max: 365 }),
    limit: parseQueryInt(query, 'limit', defaults.limit ?? 100, { min: 1, max: 1000 }),
    offset: parseQueryInt(query, 'offset', defaults.offset ?? 0, { min: 0 }),
  };
}

/**
 * Parse time string to seconds
 * @param time - Time in format "HH:MM:SS" or "D-HH:MM:SS"
 * @returns Time in seconds
 */
export function parseTimeToSeconds(time: string): number {
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
 * @param mem - Memory like "40G" or "100M"
 * @returns Memory in MB
 */
export function parseMemToMB(mem: string): number {
  const match = mem.match(/^(\d+)([gGmM])$/);
  if (!match) return 0;
  const [, value, unit] = match;
  return unit.toLowerCase() === 'g' ? parseInt(value) * 1024 : parseInt(value);
}

/**
 * Get partition name for a cluster and GPU type
 * @param hpc - Cluster name
 * @param gpu - GPU type ('' for none)
 * @returns Partition name
 */
export function getPartitionName(hpc: string, gpu: string = ''): string | null {
  if (gpu && gpuConfig[hpc]) {
    const clusterGpuConfig = gpuConfig[hpc] as Record<string, GpuPartitionConfig> | null;
    if (clusterGpuConfig && clusterGpuConfig[gpu]) {
      return clusterGpuConfig[gpu].partition;
    }
  }
  return clusters[hpc]?.partition || null;
}

/**
 * Get partition limits for a cluster and GPU type
 * Uses dynamic limits from SLURM with fallback to config
 *
 * @param hpc - Cluster name
 * @param gpu - GPU type ('' for none)
 * @returns Partition limits { maxCpus, maxMemMB, maxTime }
 */
export function getPartitionLimits(hpc: string, gpu: string = ''): PartitionLimit | null {
  const partition = getPartitionName(hpc, gpu);
  if (!partition) return null;

  // Try dynamic limits first (from SLURM via SSH)
  const dynamicLimits = dynamicPartitions.getPartitionLimits(hpc, partition);
  if (dynamicLimits && dynamicLimits.maxCpus && dynamicLimits.maxMemMB && dynamicLimits.maxTime) {
    return dynamicLimits;
  }

  // Fall back to hardcoded config values
  const clusterLimits = partitionLimits[hpc];
  if (!clusterLimits) return null;

  return clusterLimits[partition] || null;
}

/**
 * Validate sbatch job parameters against cluster limits
 * @param cpus - Number of CPUs
 * @param mem - Memory allocation (format: "40G", "100M")
 * @param time - Walltime (format: "HH:MM:SS" or "D-HH:MM:SS")
 * @param hpc - Cluster name (required for limit checking)
 * @param gpu - GPU type (optional, affects partition limits)
 * @throws Error if any parameter is invalid or exceeds limits
 */
export function validateSbatchInputs(
  cpus: string,
  mem: string,
  time: string,
  hpc: string,
  gpu: string = ''
): void {
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
 * @param hpc - Cluster name
 * @throws Error if cluster name is invalid
 */
export function validateHpcName(hpc: string): void {
  const validHpcs = ['gemini', 'apollo'];
  if (!validHpcs.includes(hpc)) {
    throw new Error(`Invalid HPC: must be one of ${validHpcs.join(', ')}`);
  }
}

// CommonJS compatibility for existing require() calls
module.exports = {
  validateSbatchInputs,
  validateHpcName,
  getPartitionLimits,
  parseTimeToSeconds,
  parseMemToMB,
  schemas,
  validate,
  isJoiAvailable,
  parseQueryInt,
  parseQueryParams,
  queryString,
};
