'use strict';

const { expect } = require('chai');
const net = require('net');

// Clear module cache before each test so PortRegistry starts fresh
function loadPorts() {
  delete require.cache[require.resolve('../../lib/ports')];
  return require('../../lib/ports');
}

describe('ports', () => {
  describe('allocateLocalPort()', () => {
    it('should return a valid port number', async () => {
      const { allocateLocalPort } = loadPorts();
      const port = await allocateLocalPort();
      expect(port).to.be.a('number');
      expect(Number.isInteger(port)).to.be.true;
      expect(port).to.be.greaterThan(1023);
      expect(port).to.be.lessThanOrEqual(65535);
    });

    it('should return a port that is actually free (bindable)', async () => {
      const { allocateLocalPort } = loadPorts();
      const maxAttempts = 3;

      // allocateLocalPort() does not reserve the port (TOCTOU window), so another
      // process could claim it between allocation and our bind attempt.
      // Retry a few times on EADDRINUSE to reduce flakiness on busy CI hosts.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const port = await allocateLocalPort();

        try {
          await new Promise((resolve, reject) => {
            const server = net.createServer();
            server.on('error', reject);
            server.listen(port, '127.0.0.1', () => {
              server.close(resolve);
            });
          });
          return; // Successfully bound; test passes
        } catch (err) {
          if (err && err.code === 'EADDRINUSE' && attempt < maxAttempts) {
            continue; // Port was claimed between allocation and bind; retry
          }
          throw err;
        }
      }
    });

    it('should return unique ports across multiple concurrent calls', async () => {
      const { allocateLocalPort } = loadPorts();
      const ports = await Promise.all([
        allocateLocalPort(),
        allocateLocalPort(),
        allocateLocalPort(),
      ]);
      const unique = new Set(ports);
      expect(unique.size).to.equal(3);
    });
  });

  describe('PortRegistry', () => {
    it('should be a Map', () => {
      const { PortRegistry } = loadPorts();
      expect(PortRegistry).to.be.an.instanceOf(Map);
    });

    it('should store and retrieve sessionKey→port mappings', () => {
      const { PortRegistry } = loadPorts();
      PortRegistry.set('domeally-gemini-vscode', 54321);
      expect(PortRegistry.get('domeally-gemini-vscode')).to.equal(54321);
    });

    it('should allow deletion of entries', () => {
      const { PortRegistry } = loadPorts();
      PortRegistry.set('domeally-apollo-rstudio', 49152);
      PortRegistry.delete('domeally-apollo-rstudio');
      expect(PortRegistry.has('domeally-apollo-rstudio')).to.be.false;
    });

    it('should be shared across imports of the same module instance', () => {
      // Both require() calls inside one test share the same cached module
      const mod1 = require('../../lib/ports');
      const mod2 = require('../../lib/ports');
      mod1.PortRegistry.set('test-key', 9999);
      expect(mod2.PortRegistry.get('test-key')).to.equal(9999);
    });
  });
});
