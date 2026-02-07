/**
 * Integration tests for Stats API (routes/stats.js)
 */

const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const statsRouter = require('../../routes/stats');

describe('Stats API (integration)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock state manager
    const mockStateManager = {
      getClusterHealth: () => ({
        gemini: {
          current: {
            online: true,
            cpus: { percent: 72, used: 360, total: 500 },
            memory: { percent: 55 },
            nodes: { percent: 80, idle: 5, busy: 20, down: 0 },
            gpus: { percent: 60 },
            runningJobs: 145,
            pendingJobs: 23,
            lastChecked: new Date().toISOString(),
          }
        },
        apollo: {
          current: {
            online: false,
            cpus: { percent: 0, used: 0, total: 600 },
            memory: { percent: 0 },
            nodes: { percent: 0, idle: 0, busy: 0, down: 5 },
            runningJobs: 0,
            pendingJobs: 0,
            lastChecked: new Date().toISOString(),
          }
        }
      })
    };

    statsRouter.setStateManager(mockStateManager);
    app.use('/api/stats', statsRouter);

    // Add error handler
    app.use((err, req, res, _next) => {
      res.status(500).json({ error: err.message });
    });
  });

  describe('GET /api/stats/clusters', () => {
    it('should return cluster health summary', async () => {
      const res = await request(app)
        .get('/api/stats/clusters')
        .expect(200);

      expect(res.body.clusters).to.have.property('gemini');
      expect(res.body.clusters).to.have.property('apollo');
      expect(res.body.clusters.gemini.online).to.be.true;
      expect(res.body.clusters.apollo.online).to.be.false;
      expect(res.body.generatedAt).to.be.a('string');
    });

    it('should include CPU, memory, and node stats', async () => {
      const res = await request(app)
        .get('/api/stats/clusters')
        .expect(200);

      const gemini = res.body.clusters.gemini;
      expect(gemini.cpus.percent).to.equal(72);
      expect(gemini.memory.percent).to.equal(55);
      expect(gemini.nodes.percent).to.equal(80);
    });

    it('should include running and pending job counts', async () => {
      const res = await request(app)
        .get('/api/stats/clusters')
        .expect(200);

      expect(res.body.clusters.gemini.runningJobs).to.equal(145);
      expect(res.body.clusters.gemini.pendingJobs).to.equal(23);
    });
  });

  describe('GET /api/stats/usage', () => {
    it('should return usage stats with default period', async () => {
      const res = await request(app)
        .get('/api/stats/usage')
        .expect(200);

      expect(res.body.period.days).to.equal(7);
      expect(res.body.summary).to.be.an('object');
      expect(res.body.generatedAt).to.be.a('string');
    });

    it('should accept custom days parameter', async () => {
      const res = await request(app)
        .get('/api/stats/usage?days=30')
        .expect(200);

      expect(res.body.period.days).to.equal(30);
    });

    it('should include release stats', async () => {
      const res = await request(app)
        .get('/api/stats/usage')
        .expect(200);

      expect(res.body.releases).to.be.an('array');
    });

    it('should include IDE stats', async () => {
      const res = await request(app)
        .get('/api/stats/usage')
        .expect(200);

      expect(res.body.ides).to.be.an('array');
    });

    it('should include feature usage percentages', async () => {
      const res = await request(app)
        .get('/api/stats/usage')
        .expect(200);

      expect(res.body.features).to.have.property('shinyPercent');
      expect(res.body.features).to.have.property('liveServerPercent');
    });
  });

  describe('GET /api/stats/variables', () => {
    it('should return variables for markdown interpolation', async () => {
      const res = await request(app)
        .get('/api/stats/variables')
        .expect(200);

      expect(res.body.variables).to.be.an('object');
      expect(res.body.generatedAt).to.be.a('string');
    });

    it('should include session count variables', async () => {
      const res = await request(app)
        .get('/api/stats/variables')
        .expect(200);

      expect(res.body.variables).to.have.property('totalSessionsThisWeek');
      expect(res.body.variables).to.have.property('avgSessionsPerDay');
    });

    it('should include queue wait time variables', async () => {
      const res = await request(app)
        .get('/api/stats/variables')
        .expect(200);

      expect(res.body.variables).to.have.property('avgQueueWaitFormatted');
    });

    it('should include cluster health variables', async () => {
      const res = await request(app)
        .get('/api/stats/variables')
        .expect(200);

      // These come from the mock stateManager
      expect(res.body.variables).to.have.property('geminiOnline');
      expect(res.body.variables.geminiOnline).to.be.true;
      expect(res.body.variables).to.have.property('geminiCpuPercent');
    });
  });

  describe('GET /api/stats/queue/:cluster', () => {
    it('should return queue stats or 404 for valid cluster', async () => {
      // Queue stats require session data in the database
      // In a fresh test environment, there may be no data
      const res = await request(app)
        .get('/api/stats/queue/gemini');

      // Either 200 with stats or 404 with no data message
      expect([200, 404]).to.include(res.status);

      if (res.status === 200) {
        expect(res.body.cluster).to.equal('gemini');
        expect(res.body.stats).to.be.an('object');
      } else {
        expect(res.body.error).to.include('No queue data');
        expect(res.body.availableClusters).to.be.an('array');
      }
    });

    it('should return 404 for unknown cluster', async () => {
      const res = await request(app)
        .get('/api/stats/queue/unknown')
        .expect(404);

      expect(res.body.error).to.include('No queue data');
      expect(res.body.availableClusters).to.be.an('array');
    });

    it('should accept days parameter', async () => {
      // Queue stats require session data in the database
      const res = await request(app)
        .get('/api/stats/queue/gemini?days=14');

      expect([200, 404]).to.include(res.status);

      if (res.status === 200) {
        expect(res.body.period.days).to.equal(14);
      }
    });
  });

  describe('No auth required', () => {
    it('should not require authentication', async () => {
      // Stats endpoints should work without any auth headers
      const res = await request(app)
        .get('/api/stats/clusters')
        .expect(200);

      expect(res.body.clusters).to.be.an('object');
    });
  });
});
