/**
 * Tunnel Service
 * Manages SSH tunnels to HPC compute nodes
 */

const { spawn, execSync } = require('child_process');
const net = require('net');
const http = require('http');
const { config, clusters, ides } = require('../config');
const { log } = require('../lib/logger');

class TunnelService {
  constructor() {
    // Map of session key (user-hpc-ide) to tunnel process
    this.tunnels = new Map();

    // Kill any orphaned SSH tunnel processes on startup
    this.cleanupOrphanedTunnels();
  }

  /**
   * Generate session key for tunnel tracking
   * Multi-user ready: includes user in key
   * @param {string} user - Username
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type
   * @returns {string} Session key
   */
  getSessionKey(user, hpcName, ide) {
    const effectiveUser = user || config.hpcUser;
    return `${effectiveUser}-${hpcName}-${ide}`;
  }

  /**
   * Kill orphaned SSH tunnel processes from previous server runs
   * These are SSH processes forwarding to IDE ports that weren't cleaned up
   */
  cleanupOrphanedTunnels() {
    const idePorts = Object.values(ides).map(ide => ide.port);
    const additionalPorts = config.additionalPorts || [];
    const allPorts = [...new Set([...idePorts, ...additionalPorts])];

    let killed = 0;
    let failed = 0;

    for (const port of allPorts) {
      try {
        // Find SSH processes listening on this port
        // Use portable xargs pattern (xargs -r is GNU-only, not available on macOS)
        const result = execSync(
          `lsof -i :${port} -t 2>/dev/null | xargs sh -c 'test -n "$*" && ps -o pid=,comm= "$@"' sh 2>/dev/null | grep ssh | awk '{print $1}'`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (result) {
          const pids = result.split('\n').filter(Boolean);
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid, 10), 'SIGTERM');
              log.tunnel(`Killed orphaned SSH tunnel`, { pid, port });
              killed++;
            } catch (e) {
              log.warn(`Failed to kill orphaned tunnel`, { pid, port, error: e.message });
              failed++;
            }
          }
        }
      } catch (e) {
        // No processes found or command failed - that's fine
      }
    }

    // Log summary
    if (killed > 0 || failed > 0) {
      log.tunnel(`Orphan cleanup complete`, { killed, failed, ports: allPorts });
    } else {
      log.tunnel(`Orphan cleanup: no orphaned tunnels found`, { ports: allPorts });
    }
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
   * Check if IDE is actually responding (not just port open)
   * Makes HTTP request to verify the IDE server is ready
   * @param {number} port - Port to check
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<boolean>} True if IDE responds
   */
  checkIdeReady(port, timeout = 2000) {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        timeout,
      }, (res) => {
        // Any HTTP response means the IDE is ready (even redirects/errors)
        // Consume response to prevent resource leak
        res.resume();
        resolve(true);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', () => {
        resolve(false);
      });

      req.end();
    });
  }

  /**
   * Wait for IDE to be ready after tunnel establishes
   * @param {number} port - Port to check
   * @param {string} ide - IDE type for logging
   * @param {string} hpcName - HPC name for logging
   * @param {number} maxAttempts - Maximum attempts (default 15 = ~30s)
   * @returns {Promise<boolean>} True if IDE became ready
   */
  async waitForIdeReady(port, ide, hpcName, maxAttempts = 15) {
    for (let i = 0; i < maxAttempts; i++) {
      const ready = await this.checkIdeReady(port);
      log.debugFor('tunnel', `IDE ready check`, { port, ide, hpc: hpcName, attempt: i + 1, ready });
      if (ready) {
        log.tunnel(`IDE ready`, { hpc: hpcName, ide, port, attempts: i + 1 });
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    log.tunnel(`IDE not ready after ${maxAttempts} attempts`, { hpc: hpcName, ide, port });
    return false;
  }

  /**
   * Start SSH tunnel to compute node for a specific IDE
   * @param {string} hpcName - HPC cluster name
   * @param {string} node - Compute node name
   * @param {string} ide - IDE type ('vscode', 'rstudio')
   * @param {Function} onExit - Optional callback when tunnel exits
   * @param {Object} options - Additional options
   * @param {number} options.remotePort - Remote port (from port file), defaults to IDE config port
   * @param {string} options.user - Username for session tracking (multi-user support)
   * @returns {Promise<Object>} Tunnel process
   */
  async start(hpcName, node, ide = 'vscode', onExit = null, options = {}) {
    const cluster = clusters[hpcName];
    if (!cluster) {
      throw new Error(`Unknown cluster: ${hpcName}`);
    }

    const ideConfig = ides[ide];
    if (!ideConfig) {
      throw new Error(`Unknown IDE: ${ide}`);
    }

    const user = options.user || config.hpcUser;
    const sessionKey = this.getSessionKey(user, hpcName, ide);
    // Use dynamic remote port if provided, otherwise default port
    // Local port always uses default (UI expects fixed ports)
    const localPort = ideConfig.port;
    const remotePort = options.remotePort || ideConfig.port;

    // Stop any existing tunnel using this port (same IDE type, any cluster)
    // This prevents "Address in use" errors when switching between clusters
    const stoppedTunnel = this.stopByIde(ide);

    // Brief delay for OS to release the port after tunnel termination
    if (stoppedTunnel) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Build port forwarding arguments
    // Maps local default port to remote dynamic port: localhost:8000 -> node:8001
    const portForwards = [`-L`, `${localPort}:${node}:${remotePort}`];

    // Add additional ports (Live Server, React dev server, etc.) - only for VS Code
    // These always use same port on both ends (no dynamic assignment for dev servers)
    if (ide === 'vscode') {
      for (const extraPort of config.additionalPorts) {
        portForwards.push('-L', `${extraPort}:${node}:${extraPort}`);
      }
    }

    const allPorts = ide === 'vscode'
      ? [localPort, ...config.additionalPorts].join(', ')
      : localPort.toString();
    const remoteInfo = remotePort !== localPort ? ` (remote: ${remotePort})` : '';
    log.tunnel(`Starting: localhost:{${allPorts}} -> ${node}:{${allPorts}}${remoteInfo}`, { hpc: hpcName, ide, host: cluster.host });
    log.debugFor('tunnel', 'spawn args', { portForwards, host: cluster.host, localPort, remotePort });

    const tunnel = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ControlMaster=no',  // Don't use SSH multiplexing - we manage our own tunnels
      '-N',
      ...portForwards,
      `${config.hpcUser}@${cluster.host}`
    ]);

    // Capture stderr for error reporting
    let lastError = '';

    // Log SSH tunnel messages
    // "Connection refused" on additional ports (Live Server, etc.) is expected when not running
    tunnel.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (!line) return;

      // Expected message when dev server isn't running - use separate component
      if (line.includes('Connection refused') || line.includes('open failed')) {
        log.debugFor('liveserver', line, { hpc: hpcName, ide });
      } else {
        log.ssh(line, { hpc: hpcName, ide });
        // Capture meaningful errors for user-facing message
        if (line.includes('Address already in use') ||
            line.includes('Permission denied') ||
            line.includes('Host key verification') ||
            line.includes('Connection refused') ||
            line.includes('No route to host') ||
            line.includes('Could not resolve')) {
          lastError = line;
        }
      }
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

    // Wait for tunnel to establish (check local port becomes available)
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if tunnel process died
      if (tunnel.exitCode !== null) {
        // Provide user-friendly error based on stderr
        const userMessage = this._getUserFriendlyError(tunnel.exitCode, lastError, localPort);
        throw new Error(userMessage);
      }

      // Check if local port is open (debug level to avoid poll noise)
      const portOpen = await this.checkPort(localPort);
      log.portCheck(localPort, portOpen, { hpc: hpcName, ide, attempt: i + 1 });
      if (portOpen) {
        log.tunnel(`Established on port ${localPort}`, { hpc: hpcName, ide });
        this.tunnels.set(sessionKey, tunnel);

        // Wait for IDE to actually be ready (responds to HTTP)
        // This prevents ECONNRESET errors when IDE is still starting
        const ideReady = await this.waitForIdeReady(localPort, ide, hpcName);
        if (!ideReady) {
          log.tunnel(`Warning: IDE may not be fully ready`, { hpc: hpcName, ide });
        }

        return tunnel;
      }
    }

    // Timeout - kill tunnel and throw
    tunnel.kill();
    throw new Error('Tunnel failed to establish after 30 seconds');
  }

  /**
   * Stop tunnel for a user's HPC-IDE session
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type (optional, stops all for user if not provided)
   * @param {string} user - Username (optional, defaults to config.hpcUser)
   */
  stop(hpcName, ide = null, user = null) {
    const effectiveUser = user || config.hpcUser;
    if (ide) {
      // Stop specific IDE tunnel
      const sessionKey = this.getSessionKey(effectiveUser, hpcName, ide);
      const tunnel = this.tunnels.get(sessionKey);
      if (tunnel) {
        log.tunnel(`Stopping tunnel`, { user: effectiveUser, hpc: hpcName, ide });
        tunnel.kill();
        this.tunnels.delete(sessionKey);
      }
    } else {
      // Stop all tunnels for this user on this HPC
      const prefix = `${effectiveUser}-${hpcName}-`;
      for (const [key, tunnel] of this.tunnels.entries()) {
        if (key.startsWith(prefix)) {
          log.tunnel(`Stopping tunnel`, { key });
          tunnel.kill();
          this.tunnels.delete(key);
        }
      }
    }
  }

  /**
   * Convert SSH exit code and stderr to user-friendly error message
   * @param {number} exitCode - SSH exit code
   * @param {string} stderrMsg - Last stderr message
   * @param {number} port - Local port that failed
   * @returns {string} User-friendly error message
   * @private
   */
  _getUserFriendlyError(exitCode, stderrMsg, port) {
    // Check for specific error patterns in stderr
    if (stderrMsg.includes('Address already in use')) {
      return `Port ${port} is already in use. Another tunnel or application may be running. Try restarting the manager.`;
    }
    if (stderrMsg.includes('Permission denied')) {
      return 'SSH authentication failed. Your SSH keys may need to be set up or refreshed.';
    }
    if (stderrMsg.includes('Host key verification')) {
      return 'SSH host key verification failed. The cluster host key may have changed.';
    }
    if (stderrMsg.includes('Connection refused')) {
      return 'Connection refused by the cluster. The login node may be down or unreachable.';
    }
    if (stderrMsg.includes('No route to host') || stderrMsg.includes('Could not resolve')) {
      return 'Cannot reach the cluster. Check your network connection or VPN.';
    }
    if (stderrMsg.includes('Connection timed out')) {
      return 'Connection timed out. The cluster may be slow or unreachable.';
    }

    // Generic fallback with exit code
    if (exitCode === 255) {
      return `SSH connection failed (code 255). ${stderrMsg || 'Check your network and SSH configuration.'}`;
    }
    return `Tunnel failed with exit code ${exitCode}. ${stderrMsg || ''}`.trim();
  }

  /**
   * Stop all tunnels for a specific IDE type (across all clusters)
   * Used to free the local port before starting a new tunnel
   * @param {string} ide - IDE type ('vscode', 'rstudio')
   * @returns {boolean} True if any tunnel was stopped
   */
  stopByIde(ide) {
    let stopped = false;
    for (const [key, tunnel] of this.tunnels.entries()) {
      if (key.endsWith(`-${ide}`)) {
        log.tunnel(`Stopping existing tunnel for port reuse`, { key, ide });
        tunnel.kill();
        this.tunnels.delete(key);
        stopped = true;
      }
    }
    return stopped;
  }

  /**
   * Check if tunnel exists for a user's HPC-IDE session
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type
   * @param {string} user - Username (optional)
   * @returns {boolean} True if tunnel exists
   */
  isActive(hpcName, ide = 'vscode', user = null) {
    const sessionKey = this.getSessionKey(user, hpcName, ide);
    return this.tunnels.has(sessionKey);
  }

  /**
   * Get tunnel process for a user's HPC-IDE session
   * @param {string} hpcName - HPC cluster name
   * @param {string} ide - IDE type
   * @param {string} user - Username (optional)
   * @returns {Object|null} Tunnel process or null
   */
  getTunnel(hpcName, ide = 'vscode', user = null) {
    const sessionKey = this.getSessionKey(user, hpcName, ide);
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
