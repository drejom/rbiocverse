const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Must set DB_PATH before requiring db modules
const testDbPath = path.join(os.tmpdir(), `test-sessions-${process.pid}.db`);
process.env.DB_PATH = testDbPath;

const { initializeDb, closeDb } = require('../../lib/db');
const {
  getActiveSession,
  saveActiveSession,
  getAllActiveSessions,
  updateActiveSession,
  markDevServerUsed,
  archiveSession,
  getSessionHistory,
  getSessionHistoryCount,
  buildSessionKey,
  parseSessionKey,
} = require('../../lib/db/sessions');

describe('Session DB Operations', () => {
  beforeEach(() => {
    // Clean up and reinitialize database
    try {
      fs.unlinkSync(testDbPath);
    } catch {
      // File might not exist
    }
    initializeDb(testDbPath);
  });

  afterEach(() => {
    closeDb();
    try {
      fs.unlinkSync(testDbPath);
    } catch {
      // File might not exist
    }
  });

  describe('markDevServerUsed', () => {
    it('should mark session as using dev server', () => {
      const sessionKey = 'testuser-gemini-vscode';
      const session = {
        ide: 'vscode',
        cluster: 'gemini',
        status: 'running',
        jobId: '12345',
        node: 'node01',
        port: 8000,
        tunnelProcess: null,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        usedDevServer: false,
      };

      // Save session
      saveActiveSession(sessionKey, session);

      // Verify initial state
      let retrieved = getActiveSession(sessionKey);
      expect(retrieved.usedDevServer).to.equal(false);

      // Mark as using dev server
      markDevServerUsed(sessionKey);

      // Verify updated state
      retrieved = getActiveSession(sessionKey);
      expect(retrieved.usedDevServer).to.equal(true);
    });

    it('should handle marking non-existent session gracefully', () => {
      // Should not throw
      expect(() => markDevServerUsed('nonexistent-session')).to.not.throw();
    });

    it('should persist usedDevServer across session reads', () => {
      const sessionKey = 'testuser-apollo-vscode';
      const session = {
        ide: 'vscode',
        cluster: 'apollo',
        status: 'running',
        jobId: '54321',
        node: 'node02',
        port: 8001,
        tunnelProcess: null,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        usedDevServer: false,
      };

      saveActiveSession(sessionKey, session);
      markDevServerUsed(sessionKey);

      // Read multiple times to ensure consistency
      for (let i = 0; i < 3; i++) {
        const retrieved = getActiveSession(sessionKey);
        expect(retrieved.usedDevServer).to.equal(true);
      }
    });
  });

  describe('saveActiveSession with usedDevServer', () => {
    it('should save session with usedDevServer false by default', () => {
      const sessionKey = 'testuser-gemini-jupyter';
      const session = {
        ide: 'jupyter',
        cluster: 'gemini',
        status: 'running',
        jobId: '11111',
        node: 'node03',
        port: 8888,
        tunnelProcess: null,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        usedDevServer: false,
      };

      saveActiveSession(sessionKey, session);
      const retrieved = getActiveSession(sessionKey);

      expect(retrieved.usedDevServer).to.equal(false);
    });

    it('should preserve usedDevServer when updating session', () => {
      const sessionKey = 'testuser-gemini-rstudio';
      const session = {
        ide: 'rstudio',
        cluster: 'gemini',
        status: 'running',
        jobId: '22222',
        node: 'node04',
        port: 8787,
        tunnelProcess: null,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        usedDevServer: false,
      };

      saveActiveSession(sessionKey, session);
      markDevServerUsed(sessionKey);

      // Update other fields
      updateActiveSession(sessionKey, { status: 'stopping' });

      // usedDevServer should still be true
      const retrieved = getActiveSession(sessionKey);
      expect(retrieved.usedDevServer).to.equal(true);
    });
  });

  describe('getAllActiveSessions', () => {
    it('should return sessions with correct usedDevServer values', () => {
      const session1 = {
        ide: 'vscode',
        cluster: 'gemini',
        status: 'running',
        jobId: '33333',
        node: 'node05',
        port: 8000,
        tunnelProcess: null,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        usedDevServer: false,
      };
      const session2 = {
        ide: 'jupyter',
        cluster: 'apollo',
        status: 'running',
        jobId: '44444',
        node: 'node06',
        port: 8888,
        tunnelProcess: null,
        submittedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        lastActivity: Date.now(),
        usedDevServer: false,
      };

      saveActiveSession('user1-gemini-vscode', session1);
      saveActiveSession('user2-apollo-jupyter', session2);

      // Mark only first session as using dev server
      markDevServerUsed('user1-gemini-vscode');

      const allSessions = getAllActiveSessions();

      expect(allSessions['user1-gemini-vscode'].usedDevServer).to.equal(true);
      expect(allSessions['user2-apollo-jupyter'].usedDevServer).to.equal(false);
    });
  });

  describe('buildSessionKey and parseSessionKey', () => {
    it('should build session key from components', () => {
      const key = buildSessionKey('testuser', 'gemini', 'vscode');
      expect(key).to.equal('testuser-gemini-vscode');
    });

    it('should parse session key into components', () => {
      const parsed = parseSessionKey('testuser-gemini-vscode');
      expect(parsed).to.deep.equal({
        user: 'testuser',
        hpc: 'gemini',
        ide: 'vscode',
      });
    });

    it('should return null for invalid session key', () => {
      expect(parseSessionKey('invalid')).to.be.null;
      expect(parseSessionKey('only-two')).to.be.null;
      expect(parseSessionKey('')).to.be.null;
    });

    it('should handle user with hyphen in name', () => {
      const parsed = parseSessionKey('user-name-gemini-vscode');
      expect(parsed).to.deep.equal({
        user: 'user-name',
        hpc: 'gemini',
        ide: 'vscode',
      });
    });
  });

  describe('archiveSession', () => {
    it('should archive session to history', () => {
      const sessionKey = 'testuser-gemini-vscode';
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60000);

      const session = {
        ide: 'vscode',
        cluster: 'gemini',
        status: 'running',
        jobId: '55555',
        node: 'node07',
        port: 8000,
        tunnelProcess: null,
        submittedAt: fiveMinutesAgo.toISOString(),
        startedAt: fiveMinutesAgo.toISOString(),
        lastActivity: now.getTime(),
        usedDevServer: true,
        cpus: 4,
        memory: '40G',
        gpuType: null,
        release: '3.20',
      };

      saveActiveSession(sessionKey, session);
      archiveSession(session, sessionKey, 'user_stopped', null);

      // Check history - use days=1 to include recent sessions
      const history = getSessionHistory({ user: 'testuser', days: 1 });
      expect(history).to.have.length.at.least(1);
      const archived = history.find(h => h.job_id === '55555');
      expect(archived).to.exist;
      expect(archived.job_id).to.equal('55555');
      expect(archived.end_reason).to.equal('user_stopped');
      expect(archived.used_dev_server).to.equal(1);
    });

    it('should calculate wait time and duration', () => {
      const sessionKey = 'testuser-apollo-jupyter';
      const now = new Date();
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60000);
      const nineMinutesAgo = new Date(now.getTime() - 9 * 60000);

      const session = {
        ide: 'jupyter',
        cluster: 'apollo',
        status: 'running',
        jobId: '66666',
        node: 'node08',
        port: 8888,
        tunnelProcess: null,
        submittedAt: tenMinutesAgo.toISOString(),
        startedAt: nineMinutesAgo.toISOString(),
        lastActivity: now.getTime(),
        usedDevServer: false,
        cpus: 2,
        memory: '20G',
        gpuType: null,
        release: '3.20',
      };

      saveActiveSession(sessionKey, session);
      archiveSession(session, sessionKey, 'job_ended', null);

      const history = getSessionHistory({ user: 'testuser', days: 1 });
      const archived = history.find(h => h.job_id === '66666');

      expect(archived).to.exist;
      // Wait time should be ~60 seconds (1 minute between submitted and started)
      expect(archived.wait_seconds).to.be.closeTo(60, 5);
      // Duration should be ~9 minutes
      expect(archived.duration_minutes).to.be.closeTo(9, 1);
    });

    it('should include error message when provided', () => {
      const sessionKey = 'testuser-gemini-rstudio';
      const now = new Date();
      const session = {
        ide: 'rstudio',
        cluster: 'gemini',
        status: 'error',
        jobId: '77777',
        node: null,
        port: 8787,
        tunnelProcess: null,
        submittedAt: now.toISOString(),
        startedAt: now.toISOString(), // Need started_at for the time filter
        lastActivity: Date.now(),
        usedDevServer: false,
      };

      saveActiveSession(sessionKey, session);
      archiveSession(session, sessionKey, 'error', 'Connection timeout');

      const history = getSessionHistory({ user: 'testuser', days: 1 });
      const archived = history.find(h => h.job_id === '77777');

      expect(archived).to.exist;
      expect(archived.end_reason).to.equal('error');
      expect(archived.error_message).to.equal('Connection timeout');
    });
  });

  describe('getSessionHistoryCount', () => {
    it('should count all sessions in history', () => {
      // Archive a few sessions
      for (let i = 0; i < 3; i++) {
        const sessionKey = `user${i}-gemini-vscode`;
        const session = {
          ide: 'vscode',
          cluster: 'gemini',
          status: 'running',
          jobId: `count${i}`,
          node: 'node01',
          port: 8000,
          tunnelProcess: null,
          submittedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          lastActivity: Date.now(),
          usedDevServer: false,
        };
        saveActiveSession(sessionKey, session);
        archiveSession(session, sessionKey, 'user_stopped', null);
      }

      const count = getSessionHistoryCount();
      expect(count).to.equal(3);
    });

    it('should filter by user', () => {
      const users = ['alice', 'bob', 'alice'];
      for (let i = 0; i < users.length; i++) {
        const sessionKey = `${users[i]}-gemini-vscode`;
        const session = {
          ide: 'vscode',
          cluster: 'gemini',
          status: 'running',
          jobId: `filter${i}`,
          node: 'node01',
          port: 8000,
          tunnelProcess: null,
          submittedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          lastActivity: Date.now(),
          usedDevServer: false,
        };
        saveActiveSession(sessionKey, session);
        archiveSession(session, sessionKey, 'user_stopped', null);
      }

      const aliceCount = getSessionHistoryCount({ user: 'alice' });
      const bobCount = getSessionHistoryCount({ user: 'bob' });

      expect(aliceCount).to.equal(2);
      expect(bobCount).to.equal(1);
    });
  });
});
