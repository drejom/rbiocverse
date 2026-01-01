/**
 * Tunnel Service
 * Manages SSH tunnels to HPC compute nodes
 */

const { spawn } = require('child_process');
const net = require('net');
const { config, clusters, ides } = require('../config');
const { log } = require('../lib/logger');

class TunnelService {
  constructor() {
    // Map of session key (hpc-ide) to tunnel process
    this.tunnels = new Map();
  }

  /**
   * Generate session key for tunnel tracking
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type
   * @returns {string} Session key
   */
  getSessionKey(hpcName, ide) {
    return `${hpcName}-${ide}`;
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
   * Start SSH tunnel to compute node for a specific IDE
   * @param {string} hpcName - HPC cluster name
   * @param {string} node - Compute node name
   * @param {string} ide - IDE type ('vscode', 'rstudio')
   * @param {Function} onExit - Optional callback when tunnel exits
   * @returns {Promise<Object>} Tunnel process
   */
  async start(hpcName, node, ide = 'vscode', onExit = null) {
    const cluster = clusters[hpcName];
    if (!cluster) {
      throw new Error(`Unknown cluster: ${hpcName}`);
    }

    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    const sessionKey = this.getSessionKey(hpcName, ide);
    const port = ideConfig.port;

    // Build port forwarding arguments
    const portForwards = [`-L`, `${port}:${node}:${port}`];

    // Add additional ports (Live Server, React dev server, etc.) - only for VS Code
    if (ide === 'vscode') {
      for (const extraPort of config.additionalPorts) {
        portForwards.push('-L', `${extraPort}:${node}:${extraPort}`);
      }
    }

    const allPorts = ide === 'vscode'
      ? [port, ...config.additionalPorts].join(', ')
      : port.toString();
    log.tunnel(`Starting: localhost:{${allPorts}} -> ${node}:{${allPorts}}`, { hpc: hpcName, ide, host: cluster.host });

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
      if (line) log.ssh(line, { hpc: hpcName, ide });
    });

    tunnel.on('error', (err) => {
      log.error('Tunnel spawn error', { hpc: hpcName, ide, error: err.message });
      this.tunnels.delete(sessionKey);
    });

    tunnel.on('exit', (code) => {
      log.tunnel(`Exited`, { hpc: hpcName, ide, code });
      this.tunnels.delete(sessionKey);
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
      log.portCheck(port, portOpen, { hpc: hpcName, ide, attempt: i + 1 });
      if (portOpen) {
        log.tunnel(`Established on port ${port}`, { hpc: hpcName, ide });
        this.tunnels.set(sessionKey, tunnel);
        return tunnel;
      }
    }

    // Timeout - kill tunnel and throw
    tunnel.kill();
    throw new Error('Tunnel failed to establish after 30 seconds');
  }

  /**
   * Stop tunnel for an HPC-IDE session
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type (optional, stops all if not provided)
   */
  stop(hpcName, ide = null) {
    if (ide) {
      // Stop specific IDE tunnel
      const sessionKey = this.getSessionKey(hpcName, ide);
      const tunnel = this.tunnels.get(sessionKey);
      if (tunnel) {
        tunnel.kill();
        this.tunnels.delete(sessionKey);
      }
    } else {
      // Stop all tunnels for this HPC (backward compatibility)
      for (const [key, tunnel] of this.tunnels.entries()) {
        if (key.startsWith(`${hpcName}-`)) {
          tunnel.kill();
          this.tunnels.delete(key);
        }
      }
    }
  }

  /**
   * Check if tunnel exists for an HPC-IDE session
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type
   * @returns {boolean} True if tunnel exists
   */
  isActive(hpcName, ide = 'vscode') {
    const sessionKey = this.getSessionKey(hpcName, ide);
    return this.tunnels.has(sessionKey);
  }

  /**
   * Get tunnel process for an HPC-IDE session
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type
   * @returns {Object|null} Tunnel process or null
   */
  getTunnel(hpcName, ide = 'vscode') {
    const sessionKey = this.getSessionKey(hpcName, ide);
    return this.tunnels.get(sessionKey) || null;
  }

  /**
   * Stop all tunnels
   */
  stopAll() {
    for (const [key, tunnel] of this.tunnels.entries()) {
      tunnel.kill();
    }
    this.tunnels.clear();
  }
}

module.exports = TunnelService;
