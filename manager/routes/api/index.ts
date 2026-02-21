/**
 * API Routes - Combined router
 * Mounts sub-routers for status, sessions, and streaming endpoints.
 *
 * Multi-user ready: All session operations accept a user parameter.
 * In single-user mode, user defaults to config.hpcUser.
 * When auth is added, user will come from req.session.user or similar.
 *
 * Body parsing: express.json() is applied here (not globally) to avoid
 * consuming request body streams for http-proxy POST requests.
 */

import express, { Request, Response, Router } from 'express';
import { log } from '../../lib/logger';
import { tunnelService } from './helpers';
import type { StateManager } from './helpers';
import { createStatusRouter } from './status';
import { createSessionsRouter } from './sessions';
import { createStreamingRouter } from './streaming';

export function createApiRouter(stateManager: StateManager): Router {
  const router = express.Router();

  // Parse JSON bodies only for API routes (not globally, which breaks http-proxy)
  router.use(express.json());

  // Set up callback to stop tunnels when sessions are cleared
  // This handles: job expiry (walltime), reconcile cleanup, manual clear
  stateManager.onSessionCleared = (user: string, hpc: string, ide: string) => {
    log.tunnel('Session cleared, stopping tunnel', { user, hpc, ide });
    tunnelService.stop(hpc, ide, user);
  };

  // Logging middleware for user actions
  router.use((req: Request, _res: Response, next: () => void) => {
    if (req.method !== 'GET') {
      log.api(`${req.method} ${req.path}`, req.body || {});
    }
    next();
  });

  // Mount sub-routers
  router.use('/', createStatusRouter(stateManager));
  router.use('/', createSessionsRouter(stateManager));
  router.use('/', createStreamingRouter(stateManager));

  return router;
}

export default createApiRouter;

// CommonJS compatibility for existing require() calls
module.exports = createApiRouter;
module.exports.default = createApiRouter;
