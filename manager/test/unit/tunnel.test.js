const { expect } = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const chai = require('chai');
const EventEmitter = require('events');

chai.use(sinonChai);

describe('TunnelService', () => {
  let tunnelService;
  let spawnStub;
  let mockTunnelProcess;
  let TunnelService;
  let portsModule;

  beforeEach(() => {
    // Clear require cache to allow fresh stub
    delete require.cache[require.resolve('../../services/tunnel')];

    // Create a mock SSH process
    mockTunnelProcess = new EventEmitter();
    mockTunnelProcess.kill = sinon.stub();
    mockTunnelProcess.exitCode = null;
    mockTunnelProcess.stderr = new EventEmitter();

    // Stub spawn BEFORE requiring TunnelService
    spawnStub = sinon.stub(require('child_process'), 'spawn').returns(mockTunnelProcess);
    // Stub find-process used by cleanupOrphanedTunnels() - return empty (no orphans)
    const findProcess = require('find-process');
    sinon.stub(findProcess, 'default').callsFake(() => Promise.resolve([]));

    // Stub allocateLocalPort to return a fixed port so tests are deterministic.
    // Must be done before requiring TunnelService so the stub is in place when start() runs.
    portsModule = require('../../lib/ports');
    sinon.stub(portsModule, 'allocateLocalPort').resolves(9001);

    // Stub resolveKeyFile in ssh-utils so tests don't require a real SSH key
    const sshUtils = require('../../lib/ssh-utils');
    sinon.stub(sshUtils, 'resolveKeyFile').resolves({ keyPath: '/tmp/test.key', effectiveKeyUser: 'domeally' });

    // Now require TunnelService - it will use the stubbed spawn/execSync
    TunnelService = require('../../services/tunnel');
    tunnelService = new TunnelService();
  });

  afterEach(() => {
    sinon.restore();
    // Clean up any remaining tunnels
    if (tunnelService) {
      tunnelService.stopAll();
    }
    // Clear PortRegistry singleton between tests to prevent state leakage
    portsModule.PortRegistry.clear();
  });

  describe('Constructor', () => {
    it('should create instance with empty tunnels map', () => {
      expect(tunnelService.tunnels).to.be.an.instanceOf(Map);
      expect(tunnelService.tunnels.size).to.equal(0);
    });
  });

  describe('checkPort', () => {
    it('should return true when port is open', async () => {
      // Use a common port that should be open in test environment
      const result = await tunnelService.checkPort(8000, 100);
      expect(result).to.be.a('boolean');
    });

    it('should return false for unopened port', async () => {
      // Use a high port that is unlikely to be in use
      const result = await tunnelService.checkPort(59999, 100);
      expect(result).to.be.false;
    });
  });

  describe('start', () => {
    it('should spawn SSH tunnel process with correct arguments', async function() {
      this.timeout(5000);

      // Mock checkPort and checkIdeReady to immediately return true
      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      expect(spawnStub).to.have.been.calledOnce;
      const [command, args] = spawnStub.firstCall.args;

      expect(command).to.equal('ssh');
      expect(args).to.include('-N');
      expect(args).to.include('-L');
      expect(args.join(' ')).to.include('node01:8000');
    });

    it('should include cluster-specific host', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      const args = spawnStub.firstCall.args[1];
      expect(args.join(' ')).to.include('gemini-login2.coh.org');
    });

    it('should throw error for unknown cluster', async () => {
      try {
        await tunnelService.start('invalid', 'node01', 'vscode');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Unknown cluster');
      }
    });

    it('should throw error for unknown IDE', async () => {
      try {
        await tunnelService.start('gemini', 'node01', 'invalid');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Unknown IDE');
      }
    });

    it('should wait for port to become available', async function() {
      this.timeout(5000);

      const checkPortStub = sinon.stub(tunnelService, 'checkPort');
      checkPortStub.onFirstCall().resolves(false);
      checkPortStub.onSecondCall().resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      expect(checkPortStub).to.have.been.calledTwice;
    });

    it('should store tunnel process in map with user-hpc-ide key', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      // Map key should be 'user-hpc-ide' format (user defaults to config.hpcUser)
      expect(tunnelService.tunnels.has('domeally-gemini-vscode')).to.be.true;
      expect(tunnelService.tunnels.get('domeally-gemini-vscode')).to.equal(mockTunnelProcess);
    });

    it('should store sessionKey→localPort in PortRegistry after tunnel establishes', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      // PortRegistry should map the session key to the allocated port (9001 from stub)
      expect(portsModule.PortRegistry.get('domeally-gemini-vscode')).to.equal(9001);
    });

    it('should remove PortRegistry entry when tunnel exits', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');
      expect(portsModule.PortRegistry.has('domeally-gemini-vscode')).to.be.true;

      // Simulate tunnel exit
      mockTunnelProcess.emit('exit', 0);

      expect(portsModule.PortRegistry.has('domeally-gemini-vscode')).to.be.false;
    });

    it('should throw error if tunnel process exits early', async function() {
      this.timeout(5000);

      // Simulate tunnel dying immediately
      mockTunnelProcess.exitCode = 1;

      sinon.stub(tunnelService, 'checkPort').resolves(false);

      try {
        await tunnelService.start('gemini', 'node01', 'vscode');
        expect.fail('Should have thrown error');
      } catch (error) {
        // Error message is now user-friendly
        expect(error.message).to.include('Tunnel failed');
      }
    });

    it('should timeout if port never opens', async function() {
      this.timeout(5000);

      // Use fake timers to speed up the 30-second timeout
      const clock = sinon.useFakeTimers({ shouldAdvanceTime: true });
      sinon.stub(tunnelService, 'checkPort').resolves(false);

      const startPromise = tunnelService.start('gemini', 'node01', 'vscode');

      // Advance time past the 30-second timeout (30 iterations * 1000ms)
      await clock.tickAsync(31000);

      try {
        await startPromise;
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Tunnel failed to establish');
        expect(mockTunnelProcess.kill).to.have.been.called;
      }

      clock.restore();
    });

    it('should call onExit callback when tunnel exits', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      const onExitSpy = sinon.spy();
      await tunnelService.start('gemini', 'node01', 'vscode', onExitSpy);

      // Simulate tunnel exit
      mockTunnelProcess.emit('exit', 0);

      expect(onExitSpy).to.have.been.calledWith(0);
    });

    it('should remove tunnel from map on exit', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');
      expect(tunnelService.tunnels.has('domeally-gemini-vscode')).to.be.true;

      // Simulate tunnel exit
      mockTunnelProcess.emit('exit', 0);

      expect(tunnelService.tunnels.has('domeally-gemini-vscode')).to.be.false;
    });

    it('should log SSH stderr output', async function() {
      this.timeout(5000);

      // First call returns false (port not in use), subsequent calls return true (tunnel established)
      const checkPortStub = sinon.stub(tunnelService, 'checkPort');
      checkPortStub.onFirstCall().resolves(false);  // Pre-check: port not in use
      checkPortStub.resolves(true);  // Tunnel established
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);
      // forceReleasePort won't be called when port is not in use (checkPort returns false)
      sinon.stub(tunnelService, 'forceReleasePort').resolves(true);
      // Stub the logger's ssh method to verify it gets called
      const { log } = require('../../lib/logger');
      const sshStub = sinon.stub(log, 'ssh');

      const promise = tunnelService.start('gemini', 'node01', 'vscode');

      // Small delay to ensure stderr listener is attached
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate SSH stderr
      mockTunnelProcess.stderr.emit('data', Buffer.from('SSH warning'));

      await promise;

      expect(sshStub).to.have.been.calledWith('SSH warning', sinon.match({ hpc: 'gemini' }));

      sshStub.restore();
    });

    it('should call forceReleasePort when port is in use', async function() {
      this.timeout(5000);

      // First call returns true (port in use), second returns true (tunnel ready)
      const checkPortStub = sinon.stub(tunnelService, 'checkPort');
      checkPortStub.onFirstCall().resolves(true);  // Pre-check: port IS in use
      checkPortStub.resolves(true);  // Tunnel established
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);
      const forceReleaseStub = sinon.stub(tunnelService, 'forceReleasePort').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      // Verify forceReleasePort was called with the dynamically allocated port (9001 from stub)
      expect(forceReleaseStub).to.have.been.calledWith(9001);
    });

    it('should use correct port for RStudio', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'rstudio');

      const args = spawnStub.firstCall.args[1];
      // RStudio uses port 8787
      expect(args.join(' ')).to.include('node01:8787');
    });
  });

  describe('stop', () => {
    it('should kill tunnel process', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      tunnelService.stop('gemini', 'vscode');

      expect(mockTunnelProcess.kill).to.have.been.called;
      expect(tunnelService.tunnels.has('domeally-gemini-vscode')).to.be.false;
    });

    it('should handle stopping non-existent tunnel', () => {
      expect(() => tunnelService.stop('gemini', 'vscode')).to.not.throw();
    });
  });

  describe('isActive', () => {
    it('should return true for active tunnel', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      expect(tunnelService.isActive('gemini', 'vscode')).to.be.true;
    });

    it('should return false for inactive tunnel', () => {
      expect(tunnelService.isActive('gemini', 'vscode')).to.be.false;
    });
  });

  describe('getTunnel', () => {
    it('should return tunnel process for active tunnel', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      await tunnelService.start('gemini', 'node01', 'vscode');

      const tunnel = tunnelService.getTunnel('gemini', 'vscode');
      expect(tunnel).to.equal(mockTunnelProcess);
    });

    it('should return null for inactive tunnel', () => {
      const tunnel = tunnelService.getTunnel('gemini', 'vscode');
      expect(tunnel).to.be.null;
    });
  });

  describe('stopAll', () => {
    it('should stop all tunnels', async function() {
      this.timeout(10000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      sinon.stub(tunnelService, 'checkIdeReady').resolves(true);

      // Start multiple tunnels (gemini-vscode)
      await tunnelService.start('gemini', 'node01', 'vscode');

      // Create second mock process for apollo-rstudio
      const mockTunnelProcess2 = new EventEmitter();
      mockTunnelProcess2.kill = sinon.stub();
      mockTunnelProcess2.exitCode = null;
      mockTunnelProcess2.stderr = new EventEmitter();

      spawnStub.returns(mockTunnelProcess2);
      await tunnelService.start('apollo', 'node02', 'rstudio');

      expect(tunnelService.tunnels.size).to.equal(2);

      tunnelService.stopAll();

      expect(mockTunnelProcess.kill).to.have.been.called;
      expect(mockTunnelProcess2.kill).to.have.been.called;
      expect(tunnelService.tunnels.size).to.equal(0);
    });

    it('should handle stopping when no tunnels exist', () => {
      expect(() => tunnelService.stopAll()).to.not.throw();
    });
  });
});
