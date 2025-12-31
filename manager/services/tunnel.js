/**
 * Tunnel Service
 * Manages SSH tunnels to HPC compute nodes
 */

const { spawn } = require('child_process');
const net = require('net');
const { config, clusters } = require('../config');
const { log } = require('../lib/logger');

class TunnelService {
  constructor() {
    // Map of HPC name to tunnel process
    this.tunnels = new Map();
  }

  /**
   * Check if a port is open
   * @param {number} port - Port to check
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<boolean>} True if port is open
   */
  checkPort(port, timeout = 1000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, '127.0.0.1');
    });
  }

  /**
   * Start SSH tunnel to compute node
   * @param {string} hpcName - HPC cluster name
   * @param {string} node - Compute node name
   * @param {Function} onExit - Optional callback when tunnel exits
   * @returns {Promise<Object>} Tunnel process
   */
  async start(hpcName, node, onExit = null) {
    const cluster = clusters[hpcName];
    if (!cluster) {
      throw new Error(`Unknown cluster: ${hpcName}`);
    }

    const port = config.codeServerPort;

    // Build port forwarding arguments
    const portForwards = [`-L`, `${port}:${node}:${port}`];

    // Add additional ports (Live Server, React dev server, etc.)
    for (const extraPort of config.additionalPorts) {
      portForwards.push('-L', `${extraPort}:${node}:${extraPort}`);
    }

    const allPorts = [port, ...config.additionalPorts].join(', ');
    log.tunnel(`Starting: localhost:{${allPorts}} -> ${node}:{${allPorts}}`, { hpc: hpcName, host: cluster.host });

    const tunnel = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-N',
      ...portForwards,
      `${config.hpcUser}@${cluster.host}`
    ]);

    // Log SSH errors
    tunnel.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) log.ssh(line, { hpc: hpcName });
    });

    tunnel.on('error', (err) => {
      log.error('Tunnel spawn error', { hpc: hpcName, error: err.message });
      this.tunnels.delete(hpcName);
    });

    tunnel.on('exit', (code) => {
      log.tunnel(`Exited`, { hpc: hpcName, code });
      this.tunnels.delete(hpcName);
      if (onExit) {
        onExit(code);
      }
    });

    // Wait for tunnel to establish (check port becomes available)
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if tunnel process died
      if (tunnel.exitCode !== null) {
        throw new Error(`Tunnel exited with code ${tunnel.exitCode}`);
      }

      // Check if port is open (debug level to avoid poll noise)
      const portOpen = await this.checkPort(port);
      log.portCheck(port, portOpen, { hpc: hpcName, attempt: i + 1 });
      if (portOpen) {
        log.tunnel(`Established on port ${port}`, { hpc: hpcName });
        this.tunnels.set(hpcName, tunnel);
        return tunnel;
      }
    }

    // Timeout - kill tunnel and throw
    tunnel.kill();
    throw new Error('Tunnel failed to establish after 30 seconds');
  }

  /**
   * Stop tunnel for an HPC
   * @param {string} hpcName - HPC cluster name
   */
  stop(hpcName) {
    const tunnel = this.tunnels.get(hpcName);
    if (tunnel) {
      tunnel.kill();
      this.tunnels.delete(hpcName);
    }
  }

  /**
   * Check if tunnel exists for an HPC
   * @param {string} hpcName - HPC cluster name
   * @returns {boolean} True if tunnel exists
   */
  isActive(hpcName) {
    return this.tunnels.has(hpcName);
  }

  /**
   * Get tunnel process for an HPC
   * @param {string} hpcName - HPC cluster name
   * @returns {Object|null} Tunnel process or null
   */
  getTunnel(hpcName) {
    return this.tunnels.get(hpcName) || null;
  }

  /**
   * Stop all tunnels
   */
  stopAll() {
    for (const [hpcName, tunnel] of this.tunnels.entries()) {
      tunnel.kill();
    }
    this.tunnels.clear();
  }
}

module.exports = TunnelService;
