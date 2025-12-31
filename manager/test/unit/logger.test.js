const { expect } = require('chai');
const sinon = require('sinon');

describe('Logger', () => {
  let logger, log;

  beforeEach(() => {
    // Clear require cache to get fresh logger instance
    delete require.cache[require.resolve('../../lib/logger')];
    const loggerModule = require('../../lib/logger');
    logger = loggerModule.logger;
    log = loggerModule.log;
  });

  describe('log methods', () => {
    it('should have all standard log methods', () => {
      expect(log.debug).to.be.a('function');
      expect(log.info).to.be.a('function');
      expect(log.warn).to.be.a('function');
      expect(log.error).to.be.a('function');
    });

    it('should have domain-specific log methods', () => {
      expect(log.ssh).to.be.a('function');
      expect(log.job).to.be.a('function');
      expect(log.tunnel).to.be.a('function');
      expect(log.lock).to.be.a('function');
      expect(log.api).to.be.a('function');
      expect(log.ui).to.be.a('function');
      expect(log.state).to.be.a('function');
      expect(log.proxy).to.be.a('function');
      expect(log.proxyError).to.be.a('function');
      expect(log.portCheck).to.be.a('function');
    });
  });

  describe('logger configuration', () => {
    it('should have default log level of info', () => {
      expect(logger.level).to.equal('info');
    });

    it('should have console transport', () => {
      const consoleTransport = logger.transports.find(t => t.name === 'console');
      expect(consoleTransport).to.exist;
    });
  });

  describe('portCheck logging', () => {
    it('should be a function that accepts port and open status', () => {
      // Should not throw
      expect(() => log.portCheck(8000, true)).to.not.throw();
      expect(() => log.portCheck(5500, false)).to.not.throw();
      expect(() => log.portCheck(3000, true, { extra: 'data' })).to.not.throw();
    });
  });
});
