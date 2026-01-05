#!/usr/bin/env node
/**
 * CLI helper to output the exact wrap command from hpc.js
 * Used by test-ide.sh to ensure single source of truth
 *
 * Usage: node get-wrap-command.js <cluster> <ide> [cpus]
 * Example: node get-wrap-command.js gemini vscode 4
 */

// Change to manager directory for correct relative imports
process.chdir(__dirname + '/..');

const HpcService = require('../services/hpc');

const [,, clusterName, ide, cpusArg] = process.argv;

if (!clusterName || !ide) {
  console.error('Usage: node get-wrap-command.js <cluster> <ide> [cpus]');
  console.error('  cluster: gemini | apollo');
  console.error('  ide: vscode | rstudio | jupyter');
  console.error('  cpus: number of CPUs (default: 1)');
  process.exit(1);
}

const cpus = parseInt(cpusArg) || 1;

try {
  const hpc = new HpcService(clusterName);

  let wrapCmd;
  switch (ide) {
    case 'vscode':
      wrapCmd = hpc.buildVscodeWrap();
      break;
    case 'rstudio':
      wrapCmd = hpc.buildRstudioWrap(cpus);
      break;
    case 'jupyter':
      wrapCmd = hpc.buildJupyterWrap();
      break;
    default:
      console.error(`Unknown IDE: ${ide}. Use vscode, rstudio, or jupyter`);
      process.exit(1);
  }

  // Output just the wrap command (for shell consumption)
  console.log(wrapCmd);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
