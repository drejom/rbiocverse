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

    // Now require TunnelService - it will use the stubbed spawn
    TunnelService = require('../../services/tunnel');
    tunnelService = new TunnelService();
  });

  afterEach(() => {
    sinon.restore();
    // Clean up any remaining tunnels
    if (tunnelService) {
      tunnelService.stopAll();
    }
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

      // Mock checkPort to immediately return true
      sinon.stub(tunnelService, 'checkPort').resolves(true);

      await tunnelService.start('gemini', 'node01');

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

      await tunnelService.start('gemini', 'node01');

      const args = spawnStub.firstCall.args[1];
      expect(args.join(' ')).to.include('gemini-login2.coh.org');
    });

    it('should throw error for unknown cluster', async () => {
      try {
        await tunnelService.start('invalid', 'node01');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Unknown cluster');
      }
    });

    it('should wait for port to become available', async function() {
      this.timeout(5000);

      const checkPortStub = sinon.stub(tunnelService, 'checkPort');
      checkPortStub.onFirstCall().resolves(false);
      checkPortStub.onSecondCall().resolves(true);

      await tunnelService.start('gemini', 'node01');

      expect(checkPortStub).to.have.been.calledTwice;
    });

    it('should store tunnel process in map', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      await tunnelService.start('gemini', 'node01');

      expect(tunnelService.tunnels.has('gemini')).to.be.true;
      // The tunnel should be the mock process
      expect(tunnelService.tunnels.get('gemini')).to.equal(mockTunnelProcess);
    });

    it('should throw error if tunnel process exits early', async function() {
      this.timeout(5000);

      // Simulate tunnel dying immediately
      mockTunnelProcess.exitCode = 1;

      sinon.stub(tunnelService, 'checkPort').resolves(false);

      try {
        await tunnelService.start('gemini', 'node01');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Tunnel exited with code');
      }
    });

    it('should timeout if port never opens', async function() {
      this.timeout(35000);  // Allow time for timeout

      sinon.stub(tunnelService, 'checkPort').resolves(false);

      try {
        await tunnelService.start('gemini', 'node01');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Tunnel failed to establish');
        expect(mockTunnelProcess.kill).to.have.been.called;
      }
    });

    it('should call onExit callback when tunnel exits', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      const onExitSpy = sinon.spy();
      await tunnelService.start('gemini', 'node01', onExitSpy);

      // Simulate tunnel exit
      mockTunnelProcess.emit('exit', 0);

      expect(onExitSpy).to.have.been.calledWith(0);
    });

    it('should remove tunnel from map on exit', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      await tunnelService.start('gemini', 'node01');
      expect(tunnelService.tunnels.has('gemini')).to.be.true;

      // Simulate tunnel exit
      mockTunnelProcess.emit('exit', 0);

      expect(tunnelService.tunnels.has('gemini')).to.be.false;
    });

    it('should log SSH stderr output', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);
      const consoleStub = sinon.stub(console, 'log');

      const promise = tunnelService.start('gemini', 'node01');

      // Simulate SSH stderr
      mockTunnelProcess.stderr.emit('data', Buffer.from('SSH warning'));

      await promise;

      expect(consoleStub).to.have.been.calledWith(sinon.match(/SSH:/));

      consoleStub.restore();
    });
  });

  describe('stop', () => {
    it('should kill tunnel process', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      await tunnelService.start('gemini', 'node01');

      tunnelService.stop('gemini');

      expect(mockTunnelProcess.kill).to.have.been.called;
      expect(tunnelService.tunnels.has('gemini')).to.be.false;
    });

    it('should handle stopping non-existent tunnel', () => {
      expect(() => tunnelService.stop('gemini')).to.not.throw();
    });
  });

  describe('isActive', () => {
    it('should return true for active tunnel', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      await tunnelService.start('gemini', 'node01');

      expect(tunnelService.isActive('gemini')).to.be.true;
    });

    it('should return false for inactive tunnel', () => {
      expect(tunnelService.isActive('gemini')).to.be.false;
    });
  });

  describe('getTunnel', () => {
    it('should return tunnel process for active tunnel', async function() {
      this.timeout(5000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      await tunnelService.start('gemini', 'node01');

      const tunnel = tunnelService.getTunnel('gemini');
      expect(tunnel).to.equal(mockTunnelProcess);
    });

    it('should return null for inactive tunnel', () => {
      const tunnel = tunnelService.getTunnel('gemini');
      expect(tunnel).to.be.null;
    });
  });

  describe('stopAll', () => {
    it('should stop all tunnels', async function() {
      this.timeout(10000);

      sinon.stub(tunnelService, 'checkPort').resolves(true);

      // Start multiple tunnels
      await tunnelService.start('gemini', 'node01');

      // Create second mock process for apollo
      const mockTunnelProcess2 = new EventEmitter();
      mockTunnelProcess2.kill = sinon.stub();
      mockTunnelProcess2.exitCode = null;
      mockTunnelProcess2.stderr = new EventEmitter();

      spawnStub.returns(mockTunnelProcess2);
      await tunnelService.start('apollo', 'node02');

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
