const { expect } = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const chai = require('chai');
const HpcService = require('../../services/hpc');

chai.use(sinonChai);

describe('HpcService', () => {
  let hpcService;
  let sshExecStub;

  beforeEach(() => {
    hpcService = new HpcService('gemini');
    sshExecStub = sinon.stub(hpcService, 'sshExec');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Constructor', () => {
    it('should create instance for valid cluster', () => {
      const gemini = new HpcService('gemini');
      expect(gemini.clusterName).to.equal('gemini');
      expect(gemini.cluster).to.have.property('host');
    });

    it('should create instance for apollo cluster', () => {
      const apollo = new HpcService('apollo');
      expect(apollo.clusterName).to.equal('apollo');
      expect(apollo.cluster).to.have.property('host');
    });

    it('should throw error for invalid cluster', () => {
      expect(() => new HpcService('invalid')).to.throw('Unknown cluster: invalid');
    });

    it('should have cluster configuration', () => {
      expect(hpcService.cluster).to.have.property('partition');
      expect(hpcService.cluster).to.have.property('singularityBin');
      expect(hpcService.cluster).to.have.property('singularityImage');
    });
  });

  describe('getJobInfo', () => {
    it('should parse job info from squeue output', async () => {
      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.resolves('12345|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00');

      const jobInfo = await hpcService.getJobInfo('vscode');

      expect(jobInfo).to.deep.equal({
        jobId: '12345',
        ide: 'vscode',
        state: 'RUNNING',
        node: 'node01',
        timeLeft: '11:30:00',
        timeLimit: '12:00:00',
        cpus: '4',
        memory: '40000M',
        startTime: '2025-12-29T10:00:00',
      });
    });

    it('should return null for no output', async () => {
      sshExecStub.resolves('');

      const jobInfo = await hpcService.getJobInfo();

      expect(jobInfo).to.be.null;
    });

    it('should handle null node for pending jobs', async () => {
      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.resolves('12345|PENDING|(null)|INVALID|12:00:00|4|40000M|N/A');

      const jobInfo = await hpcService.getJobInfo();

      expect(jobInfo.state).to.equal('PENDING');
      expect(jobInfo.node).to.be.null;
      expect(jobInfo.timeLeft).to.be.null;
      expect(jobInfo.timeLimit).to.equal('12:00:00');
      expect(jobInfo.startTime).to.be.null;
    });

    it('should return null on SSH error', async () => {
      sshExecStub.rejects(new Error('SSH connection failed'));

      const jobInfo = await hpcService.getJobInfo();

      expect(jobInfo).to.be.null;
    });

    it('should handle start time with timezone', async () => {
      // Uses pipe delimiter - startTime is a single field
      sshExecStub.resolves('12345|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00-05:00');

      const jobInfo = await hpcService.getJobInfo();

      expect(jobInfo.startTime).to.equal('2025-12-29T10:00:00-05:00');
    });
  });

  describe('submitJob', () => {
    it('should submit job and return job ID', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      const result = await hpcService.submitJob('4', '40G', '12:00:00');

      expect(result.jobId).to.equal('12345');
      expect(result).to.not.have.property('password');  // No password in response
      expect(sshExecStub).to.have.been.calledOnce;
    });

    it('should include correct sbatch parameters', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('8', '64G', '24:00:00', 'vscode');

      const sshCommand = sshExecStub.firstCall.args[0];
      expect(sshCommand).to.include('sbatch');
      expect(sshCommand).to.include('--cpus-per-task=8');
      expect(sshCommand).to.include('--mem=64G');
      expect(sshCommand).to.include('--time=24:00:00');
      expect(sshCommand).to.include('--job-name=hpc-vscode');
    });

    it('should use RStudio job name for rstudio IDE', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'rstudio');

      const sshCommand = sshExecStub.firstCall.args[0];
      expect(sshCommand).to.include('--job-name=hpc-rstudio');
      expect(sshCommand).to.include('rserver');
    });

    it('should include cluster-specific partition', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00');

      const sshCommand = sshExecStub.firstCall.args[0];
      expect(sshCommand).to.include('--partition=compute');
    });

    it('should include singularity container configuration', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00');

      const sshCommand = sshExecStub.firstCall.args[0];
      expect(sshCommand).to.include('singularity');
      expect(sshCommand).to.include('.sif');
      expect(sshCommand).to.include('code serve-web');
    });

    it('should throw error if job ID cannot be parsed', async () => {
      sshExecStub.resolves('Some other output');

      try {
        await hpcService.submitJob('4', '40G', '12:00:00');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Failed to parse job ID');
      }
    });

    it('should propagate SSH errors', async () => {
      sshExecStub.rejects(new Error('SSH connection failed'));

      try {
        await hpcService.submitJob('4', '40G', '12:00:00');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('SSH connection failed');
      }
    });
  });

  describe('cancelJob', () => {
    it('should call scancel with job ID', async () => {
      sshExecStub.resolves('');

      await hpcService.cancelJob('12345');

      expect(sshExecStub).to.have.been.calledWith('scancel 12345');
    });

    it('should handle scancel errors', async () => {
      sshExecStub.rejects(new Error('Job not found'));

      try {
        await hpcService.cancelJob('12345');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Job not found');
      }
    });
  });

  describe('cancelJobs (batch)', () => {
    it('should return empty result for empty array', async () => {
      const result = await hpcService.cancelJobs([]);

      expect(result).to.deep.equal({ cancelled: [], failed: [] });
      expect(sshExecStub).to.not.have.been.called;
    });

    it('should return empty result for non-array', async () => {
      const result = await hpcService.cancelJobs(null);

      expect(result).to.deep.equal({ cancelled: [], failed: [] });
      expect(sshExecStub).to.not.have.been.called;
    });

    it('should use cancelJob for single job', async () => {
      sshExecStub.resolves('');

      const result = await hpcService.cancelJobs(['12345']);

      expect(result).to.deep.equal({ cancelled: ['12345'], failed: [] });
      expect(sshExecStub).to.have.been.calledWith('scancel 12345');
    });

    it('should batch multiple jobs into single scancel call', async () => {
      sshExecStub.resolves('');

      const result = await hpcService.cancelJobs(['12345', '12346', '12347']);

      expect(result).to.deep.equal({ cancelled: ['12345', '12346', '12347'], failed: [] });
      expect(sshExecStub).to.have.been.calledOnce;
      expect(sshExecStub).to.have.been.calledWith('scancel 12345 12346 12347');
    });

    it('should return all as failed on batch error', async () => {
      sshExecStub.rejects(new Error('SSH connection failed'));

      const result = await hpcService.cancelJobs(['12345', '12346']);

      expect(result).to.deep.equal({ cancelled: [], failed: ['12345', '12346'] });
    });

    it('should return single job as failed on single job error', async () => {
      sshExecStub.rejects(new Error('Job not found'));

      const result = await hpcService.cancelJobs(['12345']);

      expect(result).to.deep.equal({ cancelled: [], failed: ['12345'] });
    });
  });

  describe('waitForNode', () => {
    it('should wait for node assignment', async function() {
      this.timeout(15000); // Increase timeout for polling test

      // First call: pending, second call: running with node
      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.onFirstCall().resolves('12345|PENDING|(null)|INVALID|12:00:00|4|40000M|N/A');
      sshExecStub.onSecondCall().resolves('12345|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00');

      const result = await hpcService.waitForNode('12345');

      expect(result).to.deep.equal({ node: 'node01' });
      expect(sshExecStub).to.have.been.calledTwice;
    });

    it('should return immediately if job already running', async () => {
      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.resolves('12345|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00');

      const result = await hpcService.waitForNode('12345');

      expect(result).to.deep.equal({ node: 'node01' });
      expect(sshExecStub).to.have.been.calledOnce;
    });

    it('should throw error if job disappears', async () => {
      sshExecStub.resolves('');

      try {
        await hpcService.waitForNode('12345');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Job disappeared');
      }
    });

    it('should timeout after max attempts', async function() {
      this.timeout(15000); // Increase timeout for polling test

      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.resolves('12345|PENDING|(null)|INVALID|12:00:00|4|40000M|N/A');

      try {
        // Pass options object with maxAttempts: 2
        await hpcService.waitForNode('12345', 'vscode', { maxAttempts: 2 });
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Timeout waiting for node assignment');
      }
    });

    it('should continue polling if node is null', async function() {
      this.timeout(15000); // Increase timeout for polling test

      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.onFirstCall().resolves('12345|RUNNING|(null)|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00');
      sshExecStub.onSecondCall().resolves('12345|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00');

      const result = await hpcService.waitForNode('12345');

      expect(result).to.deep.equal({ node: 'node01' });
    });

    it('should return pending status when returnPendingOnTimeout is true', async function() {
      this.timeout(15000);

      // Uses pipe delimiter: %i|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.resolves('12345|PENDING|(null)|INVALID|12:00:00|4|40000M|N/A');

      const result = await hpcService.waitForNode('12345', 'vscode', {
        maxAttempts: 1,
        returnPendingOnTimeout: true,
      });

      expect(result).to.deep.equal({ pending: true, jobId: '12345' });
    });
  });

  describe('checkJobExists', () => {
    it('should return true if job exists', async () => {
      sshExecStub.resolves('12345 RUNNING node01');

      const exists = await hpcService.checkJobExists('12345');

      expect(exists).to.be.true;
      expect(sshExecStub).to.have.been.calledWith('squeue -j 12345 --noheader 2>/dev/null');
    });

    it('should return false if job does not exist', async () => {
      sshExecStub.resolves('');

      const exists = await hpcService.checkJobExists('12345');

      expect(exists).to.be.false;
    });

    it('should return false on SSH error', async () => {
      sshExecStub.rejects(new Error('Job not found'));

      const exists = await hpcService.checkJobExists('12345');

      expect(exists).to.be.false;
    });
  });

  describe('getAllJobs', () => {
    it('should return all job info for multiple IDEs', async () => {
      // Uses pipe delimiter: %i|%j|%T|%N|%L|%l|%C|%m|%S (note: includes %j for job name)
      sshExecStub.resolves(
        '12345|hpc-vscode|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00\n' +
        '12346|hpc-rstudio|PENDING|(null)|INVALID|8:00:00|2|20000M|N/A'
      );

      const jobs = await hpcService.getAllJobs();

      expect(jobs.vscode).to.deep.equal({
        jobId: '12345',
        ide: 'vscode',
        state: 'RUNNING',
        node: 'node01',
        timeLeft: '11:30:00',
        timeLeftSeconds: 41400, // 11:30:00 = 11*3600 + 30*60 = 41400
        timeLimit: '12:00:00',
        cpus: '4',
        memory: '40000M',
        startTime: '2025-12-29T10:00:00',
      });
      expect(jobs.rstudio).to.deep.equal({
        jobId: '12346',
        ide: 'rstudio',
        state: 'PENDING',
        node: null,
        timeLeft: null,
        timeLeftSeconds: null, // INVALID -> null
        timeLimit: '8:00:00',
        cpus: '2',
        memory: '20000M',
        startTime: null,
      });
    });

    it('should return null for IDEs with no jobs', async () => {
      // Uses pipe delimiter: %i|%j|%T|%N|%L|%l|%C|%m|%S
      sshExecStub.resolves('12345|hpc-vscode|RUNNING|node01|11:30:00|12:00:00|4|40000M|2025-12-29T10:00:00');

      const jobs = await hpcService.getAllJobs();

      expect(jobs.vscode).to.not.be.null;
      expect(jobs.rstudio).to.be.null;
      expect(jobs.jupyter).to.be.null;
    });

    it('should return all nulls when no jobs running', async () => {
      sshExecStub.resolves('');

      const jobs = await hpcService.getAllJobs();

      expect(jobs.vscode).to.be.null;
      expect(jobs.rstudio).to.be.null;
      expect(jobs.jupyter).to.be.null;
    });

    it('should ignore unknown job names', async () => {
      sshExecStub.resolves('12345 unknown-job RUNNING node01 11:30:00 12:00:00 4 40000M 2025-12-29T10:00:00');

      const jobs = await hpcService.getAllJobs();

      expect(jobs.vscode).to.be.null;
      expect(jobs.rstudio).to.be.null;
      expect(jobs.jupyter).to.be.null;
    });
  });

  describe('getJobInfo edge cases', () => {
    it('should throw error for unknown IDE', async () => {
      try {
        await hpcService.getJobInfo('invalid');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Unknown IDE');
      }
    });
  });

  describe('submitJob edge cases', () => {
    it('should throw error for unknown IDE', async () => {
      try {
        await hpcService.submitJob('4', '40G', '12:00:00', 'invalid');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Unknown IDE');
      }
    });
  });

  describe('Token Generation', () => {
    it('should generate token for VS Code', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      const result = await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      expect(result.token).to.be.a('string');
      expect(result.token).to.have.lengthOf(32);  // 16 bytes = 32 hex chars
    });

    it('should generate token for JupyterLab', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      const result = await hpcService.submitJob('4', '40G', '12:00:00', 'jupyter');

      expect(result.token).to.be.a('string');
      expect(result.token).to.have.lengthOf(32);
    });

    it('should NOT generate token for RStudio', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      const result = await hpcService.submitJob('4', '40G', '12:00:00', 'rstudio');

      expect(result.token).to.be.null;  // RStudio uses auth-none
    });

    it('should include connection token in VS Code command', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      const sshCommand = sshExecStub.firstCall.args[0];
      expect(sshCommand).to.include('--connection-token=');
      expect(sshCommand).to.not.include('--without-connection-token');
    });

    it('should include token env var in JupyterLab command', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'jupyter');

      const sshCommand = sshExecStub.firstCall.args[0];
      expect(sshCommand).to.include('--env JUPYTER_TOKEN=');
      expect(sshCommand).to.not.include("--ServerApp.token=''");
    });

    it('should generate unique tokens for each job', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      const result1 = await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      sshExecStub.resolves('Submitted batch job 12346');
      const result2 = await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      expect(result1.token).to.not.equal(result2.token);
    });
  });

  describe('getIdePort (dynamic port discovery)', () => {
    it('should return port from port file when available', async () => {
      sshExecStub.resolves('8001');

      const port = await hpcService.getIdePort('vscode');

      expect(port).to.equal(8001);
      expect(sshExecStub).to.have.been.calledWith('cat ~/.vscode-slurm/port 2>/dev/null');
    });

    it('should return default port when port file is missing', async () => {
      sshExecStub.rejects(new Error('No such file'));

      const port = await hpcService.getIdePort('vscode');

      expect(port).to.equal(8000); // Default VS Code port
    });

    it('should return default port when port file has invalid content', async () => {
      sshExecStub.resolves('invalid');

      const port = await hpcService.getIdePort('vscode');

      expect(port).to.equal(8000); // Default VS Code port
    });

    it('should return default port when port is out of range', async () => {
      sshExecStub.resolves('99999');

      const port = await hpcService.getIdePort('vscode');

      expect(port).to.equal(8000); // Default VS Code port
    });

    it('should use correct port file for each IDE', async () => {
      sshExecStub.resolves('8001');

      await hpcService.getIdePort('vscode');
      expect(sshExecStub).to.have.been.calledWith('cat ~/.vscode-slurm/port 2>/dev/null');

      sshExecStub.resetHistory();
      await hpcService.getIdePort('rstudio');
      expect(sshExecStub).to.have.been.calledWith('cat ~/.rstudio-slurm/port 2>/dev/null');

      sshExecStub.resetHistory();
      await hpcService.getIdePort('jupyter');
      expect(sshExecStub).to.have.been.calledWith('cat ~/.jupyter-slurm/port 2>/dev/null');
    });

    it('should throw error for unknown IDE', async () => {
      try {
        await hpcService.getIdePort('invalid');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Unknown IDE');
      }
    });

    it('should handle whitespace in port file', async () => {
      sshExecStub.resolves('  8001\n');

      const port = await hpcService.getIdePort('vscode');

      expect(port).to.equal(8001);
    });
  });

  describe('buildVscodeScript (port finder integration)', () => {
    it('should include port finder script in heredoc command', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      const sshCommand = sshExecStub.firstCall.args[0];
      // Port finder writes to ~/.vscode-slurm/port and uses $IDE_PORT (unescaped in heredoc)
      expect(sshCommand).to.include('IDE_PORT');
      expect(sshCommand).to.include('--port $IDE_PORT');
    });
  });

  describe('buildRstudioScript (port finder integration)', () => {
    it('should include port finder script in heredoc command', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'rstudio');

      const sshCommand = sshExecStub.firstCall.args[0];
      // Port finder uses $IDE_PORT (unescaped in heredoc)
      expect(sshCommand).to.include('IDE_PORT');
      expect(sshCommand).to.include('--www-port=$IDE_PORT');
    });
  });

  describe('buildJupyterScript (port finder integration)', () => {
    it('should include port finder script in heredoc command', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'jupyter');

      const sshCommand = sshExecStub.firstCall.args[0];
      // Port finder uses $IDE_PORT (unescaped in heredoc)
      expect(sshCommand).to.include('IDE_PORT');
      expect(sshCommand).to.include('--port=$IDE_PORT');
    });
  });

  describe('hpc-proxy integration', () => {
    it('should start hpc-proxy with --base-rewrite flag for VS Code', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      const sshCommand = sshExecStub.firstCall.args[0];
      // hpc-proxy should be started with base-rewrite for URL rewriting
      expect(sshCommand).to.include('hpc-proxy');
      expect(sshCommand).to.include('--base-rewrite');
      expect(sshCommand).to.include('--verbose');
    });

    it('should create hpc-proxy directory and status marker', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'vscode');

      const sshCommand = sshExecStub.firstCall.args[0];
      // Should create directory for proxy files
      expect(sshCommand).to.include('mkdir -p $HOME/.hpc-proxy');
      // Should create status marker on success
      expect(sshCommand).to.include('.hpc-proxy/status');
    });

    it('should not include hpc-proxy for RStudio', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'rstudio');

      const sshCommand = sshExecStub.firstCall.args[0];
      // RStudio has its own proxy support, doesn't need hpc-proxy
      expect(sshCommand).to.not.include('hpc-proxy');
    });

    it('should not include hpc-proxy for Jupyter', async () => {
      sshExecStub.resolves('Submitted batch job 12345');

      await hpcService.submitJob('4', '40G', '12:00:00', 'jupyter');

      const sshCommand = sshExecStub.firstCall.args[0];
      // Jupyter has its own proxy support, doesn't need hpc-proxy
      expect(sshCommand).to.not.include('hpc-proxy');
    });
  });

  describe('getProxyPort', () => {
    it('should read port from ~/.hpc-proxy/port file', async () => {
      sshExecStub.resolves('34567');

      const port = await hpcService.getProxyPort(null);

      expect(port).to.equal(34567);
      expect(sshExecStub).to.have.been.calledWith('cat ~/.hpc-proxy/port 2>/dev/null');
    });

    it('should return null when port file is missing', async () => {
      sshExecStub.rejects(new Error('No such file'));

      const port = await hpcService.getProxyPort(null);

      expect(port).to.be.null;
    });

    it('should return null for invalid port content', async () => {
      sshExecStub.resolves('invalid');

      const port = await hpcService.getProxyPort(null);

      expect(port).to.be.null;
    });

    it('should handle whitespace in port file', async () => {
      sshExecStub.resolves('  34567\n');

      const port = await hpcService.getProxyPort(null);

      expect(port).to.equal(34567);
    });
  });
});
