const { expect } = require('chai');
const fs = require('fs').promises;
const path = require('path');
const { StateManager } = require('../../lib/state');

describe('StateManager Integration Tests', () => {
  let stateManager;
  let testStateFile;

  beforeEach(async () => {
    // Use temp file for testing
    testStateFile = path.join(__dirname, '../.test-state.json');
    // Clean up any leftover state file from previous test
    try {
      await fs.unlink(testStateFile);
    } catch (e) {
      // File might not exist
    }
    process.env.STATE_FILE = testStateFile;
    process.env.ENABLE_STATE_PERSISTENCE = 'true';
    // Disable SQLite for these tests - we're testing JSON persistence
    process.env.USE_SQLITE = 'false';
    stateManager = new StateManager();
  });

  afterEach(async () => {
    // Clean up test state file
    try {
      await fs.unlink(testStateFile);
    } catch (e) {
      // File might not exist
    }
    delete process.env.STATE_FILE;
    delete process.env.ENABLE_STATE_PERSISTENCE;
    delete process.env.USE_SQLITE;
  });

  describe('Persistence', () => {
    it('should save and load state correctly', async () => {
      // Create session with initial properties
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
        node: 'node01',
      });

      // Create new instance and load
      const newManager = new StateManager();
      await newManager.load();

      // Verify state was persisted
      const session = newManager.getSession(null, 'gemini', 'vscode');
      expect(session.status).to.equal('running');
      expect(session.jobId).to.equal('12345');
      expect(session.node).to.equal('node01');
      expect(session.tunnelProcess).to.be.null; // Reset after load
    });

    it('should handle non-existent state file gracefully', async () => {
      await stateManager.load();
      // New structure uses dynamic keys and activeSession
      expect(stateManager.getState()).to.deep.equal({
        sessions: {},
        activeSession: null,
      });
    });

    it('should handle corrupted state file gracefully', async () => {
      // Write invalid JSON
      await fs.writeFile(testStateFile, 'invalid json{');

      await stateManager.load();

      // Should fall back to default state
      expect(stateManager.getState()).to.deep.equal({
        sessions: {},
        activeSession: null,
      });
    });

    it('should persist multiple sessions', async () => {
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '111',
      });

      await stateManager.createSession(null, 'apollo', 'jupyter', {
        status: 'running',
        jobId: '222',
      });

      // Load in new instance
      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getSession(null, 'gemini', 'vscode').jobId).to.equal('111');
      expect(newManager.getSession(null, 'apollo', 'jupyter').jobId).to.equal('222');
    });

    it('should clear session and persist', async () => {
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      await stateManager.clearSession(null, 'gemini', 'vscode');

      // Load in new instance
      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getSession(null, 'gemini', 'vscode')).to.be.null;
    });

    it('should clear activeSession when clearing its session', async () => {
      await stateManager.setActiveSession(null, 'gemini', 'vscode');
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      await stateManager.clearSession(null, 'gemini', 'vscode');

      // Load in new instance
      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getActiveSession()).to.be.null;
    });
  });

  describe('Feature Flag', () => {
    it('should not save when persistence is disabled', async () => {
      process.env.ENABLE_STATE_PERSISTENCE = 'false';
      const manager = new StateManager();

      await manager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      // File should not exist
      const exists = await fs.access(testStateFile).then(() => true).catch(() => false);
      expect(exists).to.be.false;
    });

    it('should not load when persistence is disabled', async () => {
      // Create state file first with persistence enabled
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      // Disable persistence and create new manager
      process.env.ENABLE_STATE_PERSISTENCE = 'false';
      const manager = new StateManager();
      await manager.load();

      // Should have default state (not loaded from file)
      expect(manager.getSession(null, 'gemini', 'vscode')).to.be.null;
    });
  });

  describe('Session Management', () => {
    it('should update existing session', async () => {
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'starting',
        jobId: '12345',
      });

      await stateManager.updateSession(null, 'gemini', 'vscode', {
        node: 'node01',
      });

      const session = stateManager.getSession(null, 'gemini', 'vscode');
      expect(session.status).to.equal('starting');
      expect(session.jobId).to.equal('12345');
      expect(session.node).to.equal('node01');
    });

    it('should throw when updating non-existent session', async () => {
      try {
        await stateManager.updateSession(null, 'gemini', 'vscode', {
          status: 'running',
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('No session exists');
      }
    });

    it('should create session with initial properties', async () => {
      const session = await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      expect(session).to.not.be.null;
      expect(session.jobId).to.equal('12345');
      expect(session.status).to.equal('running');
      expect(session.ide).to.equal('vscode'); // From createIdleSession
    });

    it('should set and persist active session', async () => {
      await stateManager.setActiveSession(null, 'gemini', 'vscode');

      const newManager = new StateManager();
      await newManager.load();

      // Active session now includes user (defaults to config.hpcUser = 'domeally')
      expect(newManager.getActiveSession()).to.deep.equal({ user: 'domeally', hpc: 'gemini', ide: 'vscode' });
    });

    it('should get all sessions', async () => {
      await stateManager.createSession(null, 'gemini', 'vscode', { status: 'running' });
      await stateManager.createSession(null, 'apollo', 'jupyter', { status: 'pending' });

      const sessions = stateManager.getAllSessions();
      expect(Object.keys(sessions)).to.have.length(2);
      // Session keys now include user: domeally-gemini-vscode
      expect(sessions['domeally-gemini-vscode'].status).to.equal('running');
      expect(sessions['domeally-apollo-jupyter'].status).to.equal('pending');
    });

    it('should get active sessions only', async () => {
      await stateManager.createSession(null, 'gemini', 'vscode', { status: 'running' });
      await stateManager.createSession(null, 'apollo', 'jupyter', { status: 'idle' });
      await stateManager.createSession(null, 'gemini', 'rstudio', { status: 'pending' });

      const active = stateManager.getActiveSessions();
      expect(Object.keys(active)).to.have.length(2);
      // Session keys now include user: domeally-gemini-vscode
      expect(active['domeally-gemini-vscode']).to.exist;
      expect(active['domeally-gemini-rstudio']).to.exist;
      expect(active['domeally-apollo-jupyter']).to.be.undefined;
    });

    it('should check hasActiveSession', async () => {
      await stateManager.createSession(null, 'gemini', 'vscode', { status: 'running' });
      await stateManager.createSession(null, 'apollo', 'jupyter', { status: 'idle' });

      expect(stateManager.hasActiveSession(null, 'gemini', 'vscode')).to.be.true;
      expect(stateManager.hasActiveSession(null, 'apollo', 'jupyter')).to.be.false;
      expect(stateManager.hasActiveSession(null, 'gemini', 'rstudio')).to.be.false;
    });
  });

  describe('Reconciliation', () => {
    it('should call reconcile on load', async () => {
      // Save state with a running session
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      // Create new manager and load
      const newManager = new StateManager();

      // Mock checkJobExists to return false (job no longer exists)
      newManager.checkJobExists = async () => false;

      await newManager.load();

      // Session should be cleared (deleted)
      expect(newManager.getSession(null, 'gemini', 'vscode')).to.be.null;
    });

    it('should preserve session if job still exists', async () => {
      // Save state with a running session
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'running',
        jobId: '12345',
      });

      // Create new manager and load
      const newManager = new StateManager();

      // Mock checkJobExists to return true (job still exists)
      newManager.checkJobExists = async () => true;

      await newManager.load();

      // Session should still exist
      const session = newManager.getSession(null, 'gemini', 'vscode');
      expect(session).to.not.be.null;
      expect(session.jobId).to.equal('12345');
    });

    it('should only reconcile running sessions', async () => {
      // Save state with a stopped session
      await stateManager.createSession(null, 'gemini', 'vscode', {
        status: 'stopped',
        jobId: '12345',
      });

      // Create new manager and load
      const newManager = new StateManager();
      let reconcileCalled = false;
      newManager.checkJobExists = async () => {
        reconcileCalled = true;
        return false;
      };

      await newManager.load();

      // checkJobExists should not be called for stopped sessions
      expect(reconcileCalled).to.be.false;
    });
  });

  describe('Operation Locks', () => {
    it('should acquire and release locks', () => {
      stateManager.acquireLock('launch:gemini');
      expect(stateManager.isLocked('launch:gemini')).to.be.true;

      stateManager.releaseLock('launch:gemini');
      expect(stateManager.isLocked('launch:gemini')).to.be.false;
    });

    it('should throw LockError when acquiring held lock', () => {
      stateManager.acquireLock('launch:gemini');

      try {
        stateManager.acquireLock('launch:gemini');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.name).to.equal('LockError');
        expect(err.code).to.equal(429);
        expect(err.details.operation).to.equal('launch:gemini');
      }

      stateManager.releaseLock('launch:gemini');
    });

    it('should allow different lock names', () => {
      stateManager.acquireLock('launch:gemini');
      stateManager.acquireLock('launch:apollo');

      expect(stateManager.isLocked('launch:gemini')).to.be.true;
      expect(stateManager.isLocked('launch:apollo')).to.be.true;

      stateManager.releaseLock('launch:gemini');
      stateManager.releaseLock('launch:apollo');
    });

    it('should list active locks', () => {
      stateManager.acquireLock('launch:gemini');
      stateManager.acquireLock('stop:apollo');

      const locks = stateManager.getActiveLocks();
      expect(locks).to.include('launch:gemini');
      expect(locks).to.include('stop:apollo');

      stateManager.releaseLock('launch:gemini');
      stateManager.releaseLock('stop:apollo');
    });

    it('should safely release non-existent lock', () => {
      expect(() => stateManager.releaseLock('nonexistent')).to.not.throw();
    });
  });
});
