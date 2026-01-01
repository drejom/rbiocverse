const { expect } = require('chai');

describe('Configuration', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    // Clear require cache to reload config with new env vars
    delete require.cache[require.resolve('../../config')];
  });

  describe('config object', () => {
    it('should use default values when env vars are not set', () => {
      // Clear all HPC-related env vars
      delete process.env.HPC_SSH_USER;
      delete process.env.DEFAULT_HPC;
      delete process.env.DEFAULT_IDE;
      delete process.env.DEFAULT_CPUS;
      delete process.env.DEFAULT_MEM;
      delete process.env.DEFAULT_TIME;

      const { config } = require('../../config');

      expect(config.hpcUser).to.equal('domeally');
      expect(config.defaultHpc).to.equal('gemini');
      expect(config.defaultIde).to.equal('vscode');
      expect(config.defaultCpus).to.equal('2');
      expect(config.defaultMem).to.equal('40G');
      expect(config.defaultTime).to.equal('12:00:00');
    });

    it('should use environment variables when set', () => {
      process.env.HPC_SSH_USER = 'testuser';
      process.env.DEFAULT_HPC = 'apollo';
      process.env.DEFAULT_IDE = 'rstudio';
      process.env.DEFAULT_CPUS = '8';
      process.env.DEFAULT_MEM = '64G';
      process.env.DEFAULT_TIME = '24:00:00';

      // Reload config with new env vars
      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.hpcUser).to.equal('testuser');
      expect(config.defaultHpc).to.equal('apollo');
      expect(config.defaultIde).to.equal('rstudio');
      expect(config.defaultCpus).to.equal('8');
      expect(config.defaultMem).to.equal('64G');
      expect(config.defaultTime).to.equal('24:00:00');
    });
  });

  describe('additionalPorts', () => {
    it('should default to port 5500 (Live Server)', () => {
      delete process.env.ADDITIONAL_PORTS;

      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.additionalPorts).to.deep.equal([5500]);
    });

    it('should parse single additional port', () => {
      process.env.ADDITIONAL_PORTS = '3000';

      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.additionalPorts).to.deep.equal([3000]);
    });

    it('should parse multiple comma-separated ports', () => {
      process.env.ADDITIONAL_PORTS = '5500,3000,5173';

      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.additionalPorts).to.deep.equal([5500, 3000, 5173]);
    });

    it('should handle whitespace in port list', () => {
      process.env.ADDITIONAL_PORTS = '5500 , 3000 , 5173';

      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.additionalPorts).to.deep.equal([5500, 3000, 5173]);
    });

    it('should filter out invalid ports', () => {
      process.env.ADDITIONAL_PORTS = '5500,invalid,3000,-1,99999';

      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.additionalPorts).to.deep.equal([5500, 3000]);
    });

    it('should return empty array for empty string', () => {
      process.env.ADDITIONAL_PORTS = '';

      delete require.cache[require.resolve('../../config')];
      const { config } = require('../../config');

      expect(config.additionalPorts).to.deep.equal([]);
    });
  });

  describe('clusters object', () => {
    it('should contain gemini configuration', () => {
      const { clusters } = require('../../config');

      expect(clusters).to.have.property('gemini');
      expect(clusters.gemini).to.have.property('host');
      expect(clusters.gemini).to.have.property('partition');
      expect(clusters.gemini).to.have.property('singularityBin');
      expect(clusters.gemini).to.have.property('singularityImage');
      expect(clusters.gemini).to.have.property('rLibsSite');
      expect(clusters.gemini).to.have.property('bindPaths');
    });

    it('should contain apollo configuration', () => {
      const { clusters } = require('../../config');

      expect(clusters).to.have.property('apollo');
      expect(clusters.apollo).to.have.property('host');
      expect(clusters.apollo).to.have.property('partition');
      expect(clusters.apollo).to.have.property('singularityBin');
      expect(clusters.apollo).to.have.property('singularityImage');
      expect(clusters.apollo).to.have.property('rLibsSite');
      expect(clusters.apollo).to.have.property('bindPaths');
    });

    it('should use GEMINI_SSH_HOST environment variable', () => {
      process.env.GEMINI_SSH_HOST = 'custom-gemini.example.com';

      delete require.cache[require.resolve('../../config')];
      const { clusters } = require('../../config');

      expect(clusters.gemini.host).to.equal('custom-gemini.example.com');
    });

    it('should use APOLLO_SSH_HOST environment variable', () => {
      process.env.APOLLO_SSH_HOST = 'custom-apollo.example.com';

      delete require.cache[require.resolve('../../config')];
      const { clusters } = require('../../config');

      expect(clusters.apollo.host).to.equal('custom-apollo.example.com');
    });

    it('should have valid singularity paths for gemini', () => {
      const { clusters } = require('../../config');

      expect(clusters.gemini.singularityBin).to.include('singularity');
      expect(clusters.gemini.singularityImage).to.include('.sif');
      expect(clusters.gemini.rLibsSite).to.include('rlibs');
    });

    it('should have valid singularity paths for apollo', () => {
      const { clusters } = require('../../config');

      expect(clusters.apollo.singularityBin).to.include('singularity');
      expect(clusters.apollo.singularityImage).to.include('.sif');
      expect(clusters.apollo.rLibsSite).to.include('rlibs');
    });

    it('should have different partitions for each cluster', () => {
      const { clusters } = require('../../config');

      expect(clusters.gemini.partition).to.equal('compute');
      expect(clusters.apollo.partition).to.equal('fast,all');
    });

    it('should have different bind paths for each cluster', () => {
      const { clusters } = require('../../config');

      expect(clusters.gemini.bindPaths).to.include('/packages');
      expect(clusters.apollo.bindPaths).to.include('/opt');
      expect(clusters.gemini.bindPaths).to.not.equal(clusters.apollo.bindPaths);
    });
  });

  describe('module exports', () => {
    it('should export config and clusters', () => {
      const exports = require('../../config');

      expect(exports).to.have.property('config');
      expect(exports).to.have.property('clusters');
    });

    it('should export valid config structure', () => {
      const { config } = require('../../config');

      expect(config).to.be.an('object');
      // hpcUser, defaultHpc, defaultIde, defaultCpus, defaultMem, defaultTime, additionalPorts
      expect(Object.keys(config).length).to.be.at.least(6);
    });

    it('should export valid clusters structure', () => {
      const { clusters } = require('../../config');

      expect(clusters).to.be.an('object');
      expect(Object.keys(clusters)).to.have.lengthOf(2);
    });

    it('should export valid ides structure', () => {
      const { ides } = require('../../config');

      expect(ides).to.be.an('object');
      expect(ides).to.have.property('vscode');
      expect(ides).to.have.property('rstudio');
      expect(ides.vscode).to.have.property('port');
      expect(ides.vscode).to.have.property('jobName');
      expect(ides.rstudio).to.have.property('port');
      expect(ides.rstudio).to.have.property('jobName');
    });
  });
});
