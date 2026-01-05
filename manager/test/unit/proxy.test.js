const { expect } = require('chai');
const { getCookieToken, isVscodeRootPath } = require('../../lib/proxy-helpers');

describe('Proxy Helpers', () => {
  describe('isVscodeRootPath', () => {
    it('should return true for /vscode-direct', () => {
      expect(isVscodeRootPath('/vscode-direct')).to.be.true;
    });

    it('should return true for /vscode-direct/', () => {
      expect(isVscodeRootPath('/vscode-direct/')).to.be.true;
    });

    it('should return true for /vscode-direct?t=123', () => {
      expect(isVscodeRootPath('/vscode-direct?t=123')).to.be.true;
    });

    it('should return true for /vscode-direct/?t=123', () => {
      expect(isVscodeRootPath('/vscode-direct/?t=123')).to.be.true;
    });

    it('should return true for /vscode-direct?t=123&foo=bar', () => {
      expect(isVscodeRootPath('/vscode-direct?t=123&foo=bar')).to.be.true;
    });

    it('should return false for /vscode-direct/foo', () => {
      expect(isVscodeRootPath('/vscode-direct/foo')).to.be.false;
    });

    it('should return false for /vscode-direct/foo?bar=1', () => {
      expect(isVscodeRootPath('/vscode-direct/foo?bar=1')).to.be.false;
    });

    it('should return false for /code', () => {
      expect(isVscodeRootPath('/code')).to.be.false;
    });

    it('should return false for /', () => {
      expect(isVscodeRootPath('/')).to.be.false;
    });

    it('should return false for /stable-abc123', () => {
      expect(isVscodeRootPath('/stable-abc123')).to.be.false;
    });
  });

  describe('getCookieToken', () => {
    it('should return null for null cookie header', () => {
      expect(getCookieToken(null)).to.be.null;
    });

    it('should return null for undefined cookie header', () => {
      expect(getCookieToken(undefined)).to.be.null;
    });

    it('should return null for empty cookie header', () => {
      expect(getCookieToken('')).to.be.null;
    });

    it('should return null when vscode-tkn cookie is not present', () => {
      expect(getCookieToken('foo=bar; baz=qux')).to.be.null;
    });

    it('should extract token from vscode-tkn cookie', () => {
      expect(getCookieToken('vscode-tkn=abc123')).to.equal('abc123');
    });

    it('should extract token when multiple cookies present', () => {
      expect(getCookieToken('foo=bar; vscode-tkn=abc123; baz=qux')).to.equal('abc123');
    });

    it('should extract token with hex characters', () => {
      expect(getCookieToken('vscode-tkn=FAKE_TEST_TOKEN_00000000')).to.equal('FAKE_TEST_TOKEN_00000000');
    });

    it('should handle token at end of cookie string', () => {
      expect(getCookieToken('other=value; vscode-tkn=token123')).to.equal('token123');
    });
  });
});
