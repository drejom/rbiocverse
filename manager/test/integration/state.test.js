const { expect } = require('chai');
const fs = require('fs').promises;
const path = require('path');
const StateManager = require('../../lib/state');

describe('StateManager Integration Tests', () => {
  let stateManager;
  let testStateFile;

  beforeEach(() => {
    // Use temp file for testing
    testStateFile = path.join(__dirname, '../.test-state.json');
    process.env.STATE_FILE = testStateFile;
    process.env.ENABLE_STATE_PERSISTENCE = 'true';
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
  });

  describe('Persistence', () => {
    it('should save and load state correctly', async () => {
      // Update session
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
        node: 'node01',
      });

      // Create new instance and load
      const newManager = new StateManager();
      await newManager.load();

      // Verify state was persisted
      expect(newManager.getSession('gemini')).to.deep.equal({
        status: 'running',
        jobId: '12345',
        node: 'node01',
      });
    });

    it('should handle non-existent state file gracefully', async () => {
      await stateManager.load();
      expect(stateManager.getState()).to.deep.equal({
        sessions: {
          gemini: null,
          apollo: null,
        },
        activeHpc: null,
      });
    });

    it('should handle corrupted state file gracefully', async () => {
      // Write invalid JSON
      await fs.writeFile(testStateFile, 'invalid json{');

      await stateManager.load();

      // Should fall back to default state
      expect(stateManager.getState()).to.deep.equal({
        sessions: {
          gemini: null,
          apollo: null,
        },
        activeHpc: null,
      });
    });

    it('should persist multiple sessions', async () => {
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '111',
      });

      await stateManager.updateSession('apollo', {
        status: 'running',
        jobId: '222',
      });

      // Load in new instance
      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getSession('gemini').jobId).to.equal('111');
      expect(newManager.getSession('apollo').jobId).to.equal('222');
    });

    it('should clear session and persist', async () => {
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      await stateManager.clearSession('gemini');

      // Load in new instance
      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getSession('gemini')).to.be.null;
    });

    it('should clear activeHpc when clearing its session', async () => {
      await stateManager.setActiveHpc('gemini');
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      await stateManager.clearSession('gemini');

      // Load in new instance
      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getState().activeHpc).to.be.null;
    });
  });

  describe('Feature Flag', () => {
    it('should not save when persistence is disabled', async () => {
      process.env.ENABLE_STATE_PERSISTENCE = 'false';
      const manager = new StateManager();

      await manager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      // File should not exist
      const exists = await fs.access(testStateFile).then(() => true).catch(() => false);
      expect(exists).to.be.false;
    });

    it('should not load when persistence is disabled', async () => {
      // Create state file first with persistence enabled
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      // Disable persistence and create new manager
      process.env.ENABLE_STATE_PERSISTENCE = 'false';
      const manager = new StateManager();
      await manager.load();

      // Should have default state (not loaded from file)
      expect(manager.getSession('gemini')).to.be.null;
    });
  });

  describe('Session Management', () => {
    it('should update existing session', async () => {
      await stateManager.updateSession('gemini', {
        status: 'starting',
        jobId: '12345',
      });

      await stateManager.updateSession('gemini', {
        node: 'node01',
      });

      const session = stateManager.getSession('gemini');
      expect(session.status).to.equal('starting');
      expect(session.jobId).to.equal('12345');
      expect(session.node).to.equal('node01');
    });

    it('should create new session if none exists', async () => {
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      expect(stateManager.getSession('gemini')).to.not.be.null;
      expect(stateManager.getSession('gemini').jobId).to.equal('12345');
    });

    it('should set and persist active HPC', async () => {
      await stateManager.setActiveHpc('gemini');

      const newManager = new StateManager();
      await newManager.load();

      expect(newManager.getState().activeHpc).to.equal('gemini');
    });
  });

  describe('Reconciliation', () => {
    it('should call reconcile on load', async () => {
      // Save state with a running session
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      // Create new manager and load
      const newManager = new StateManager();

      // Mock checkJobExists to return false (job no longer exists)
      newManager.checkJobExists = async () => false;

      await newManager.load();

      // Session should be cleared
      expect(newManager.getSession('gemini')).to.be.null;
    });

    it('should preserve session if job still exists', async () => {
      // Save state with a running session
      await stateManager.updateSession('gemini', {
        status: 'running',
        jobId: '12345',
      });

      // Create new manager and load
      const newManager = new StateManager();

      // Mock checkJobExists to return true (job still exists)
      newManager.checkJobExists = async () => true;

      await newManager.load();

      // Session should still exist
      expect(newManager.getSession('gemini')).to.not.be.null;
      expect(newManager.getSession('gemini').jobId).to.equal('12345');
    });

    it('should only reconcile running sessions', async () => {
      // Save state with a stopped session
      await stateManager.updateSession('gemini', {
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
});
