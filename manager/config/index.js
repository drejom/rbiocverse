/**
 * Configuration management
 * Centralizes all environment variables and cluster-specific settings
 */

// Parse additional ports from comma-separated string (e.g., "5500,3000,5173")
// Returns default [5500] if env var not set, empty array if set to empty string
function parseAdditionalPorts(envValue, defaultValue = '5500') {
  // If env var is explicitly set (even to empty string), use it
  if (envValue !== undefined) {
    if (envValue === '') return [];
    return envValue
      .split(',')
      .map(p => parseInt(p.trim()))
      .filter(p => !isNaN(p) && p > 0 && p < 65536);
  }
  // Default to Live Server port
  return parseAdditionalPorts(defaultValue);
}

const config = {
  hpcUser: process.env.HPC_SSH_USER || 'domeally',
  defaultHpc: process.env.DEFAULT_HPC || 'gemini',
  codeServerPort: parseInt(process.env.CODE_SERVER_PORT) || 8000,
  defaultCpus: process.env.DEFAULT_CPUS || '2',
  defaultMem: process.env.DEFAULT_MEM || '40G',
  defaultTime: process.env.DEFAULT_TIME || '12:00:00',
  // Additional ports to forward through SSH tunnel (e.g., Live Server: 5500, React: 3000)
  additionalPorts: parseAdditionalPorts(process.env.ADDITIONAL_PORTS),
};

const clusters = {
  gemini: {
    host: process.env.GEMINI_SSH_HOST || 'gemini-login2.coh.org',
    partition: 'compute',
    singularityBin: '/packages/easy-build/software/singularity/3.7.0/bin/singularity',
    singularityImage: '/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.19.sif',
    rLibsSite: '/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.19',
    bindPaths: '/packages,/run,/scratch,/ref_genomes',
  },
  apollo: {
    host: process.env.APOLLO_SSH_HOST || 'ppxhpcacc01.coh.org',
    partition: 'fast,all',
    singularityBin: '/opt/singularity/3.7.0/bin/singularity',
    singularityImage: '/opt/singularity-images/rbioc/vscode-rbioc_3.19.sif',
    rLibsSite: '/opt/singularity-images/rbioc/rlibs/bioc-3.19',
    bindPaths: '/opt,/run,/labs',
  },
};

module.exports = { config, clusters };
