/**
 * Port allocation utilities for per-session SSH tunnel management.
 *
 * `allocateLocalPort()` asks the OS for a free ephemeral port by binding a
 * TCP server to port 0, recording the assigned port, then immediately closing
 * the server.  The port is *not* held open, so there is a small TOCTOU window;
 * callers should start listening on the returned port promptly.
 *
 * `PortRegistry` is a Map<sessionKey, localPort> that lets the tunnel and proxy
 * layers share the same port assignment for a given session without passing the
 * value through every call-site.
 */

import * as net from 'net';

/**
 * Map of sessionKey → local TCP port allocated for that session's SSH tunnel.
 * Format of sessionKey: `${user}-${hpc}-${ide}` (e.g. "domeally-gemini-vscode")
 */
export const PortRegistry: Map<string, number> = new Map();

/**
 * Ask the OS for a free local TCP port.
 * Binds a server to port 0, captures the assigned port, then closes the server.
 *
 * @returns Resolved port number (1024–65535 range, OS-assigned)
 * @throws If the server cannot be bound or the port cannot be read
 */
export function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to read OS-assigned port from server address')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

// CommonJS compatibility for existing require() calls
module.exports = { allocateLocalPort, PortRegistry };
