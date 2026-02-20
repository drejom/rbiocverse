/**
 * HPC Code Server Manager
 * Main Express server - orchestration only
 *
 * Frontend assets are served from public/
 * Business logic is in services/ and lib/
 * API routes are in routes/
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import path from 'path';
import { StateManager } from './lib/state';
import { config } from './config';
import HpcService from './services/hpc';
import createApiRouter from './routes/api';
import authRouter from './routes/auth';
import helpRouter from './routes/help';
import adminRouter from './routes/admin';
import statsRouter from './routes/stats';
import clientErrorsRouter from './routes/client-errors';
import { HpcError } from './lib/errors';
import { log } from './lib/logger';
import * as partitionService from './lib/partitions';
import * as proxyRegistry from './lib/proxy-registry';

// Type alias for the proxy server instance
type Server = ReturnType<typeof httpProxy.createProxyServer>;

interface Session {
  status?: string;
  jobId?: string;
  token?: string;
  lastActivity?: number;
  startedAt?: string;
  ide?: string;
}

interface ActiveSession {
  user: string;
  hpc: string;
  ide: string;
}

interface State {
  sessions: Record<string, Session | null>;
  activeSession: ActiveSession | null;
}

const app = express();
// NOTE: Do NOT use express.json() globally - it consumes request body streams
// which breaks http-proxy for POST requests (like RStudio's /rpc/client_init).
// Body parsing is applied only to /api routes in routes/api.js

// Prevent caching issues - VS Code uses service workers that can cache stale paths
// Safari is particularly aggressive about caching, so we use multiple headers
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Multi-session state - track sessions per HPC
// Using StateManager for persistence across container restarts
const stateManager = new StateManager();
const state = stateManager.getState() as unknown as State;

// Activity tracking for idle session cleanup
// Updates lastActivity timestamp on proxy traffic (like JupyterHub's CHP)
function updateActivity(): void {
  const { activeSession } = state;
  if (activeSession) {
    // Session key format: user-hpc-ide (multi-user prep)
    const sessionKey = `${activeSession.user}-${activeSession.hpc}-${activeSession.ide}`;
    if (state.sessions[sessionKey]) {
      state.sessions[sessionKey]!.lastActivity = Date.now();
    }
  }
}

// Get token for active session's IDE
// Used by proxies to inject authentication tokens into requests
function getSessionToken(ide: string): string | null {
  const { activeSession } = state;
  if (!activeSession) return null;
  // Session key format: user-hpc-ide (multi-user prep)
  const sessionKey = `${activeSession.user}-${activeSession.hpc}-${ide}`;
  return state.sessions[sessionKey]?.token || null;
}

// Register session token and activity callbacks with ProxyRegistry
proxyRegistry.setGetSessionToken(getSessionToken);
proxyRegistry.setOnActivity(updateActivity);

// Mount auth routes (before general /api to avoid conflicts)
app.use('/api/auth', authRouter);

// Mount help routes (inject stateManager for template processing)
(helpRouter as unknown as { setStateManager: (sm: StateManager) => void }).setStateManager(stateManager);
app.use('/api/help', helpRouter);

// Mount admin routes (inject stateManager for cluster data)
(adminRouter as unknown as { setStateManager: (sm: StateManager) => void }).setStateManager(stateManager);
app.use('/api/admin', adminRouter);

// Mount public stats API (no auth required, inject stateManager)
(statsRouter as unknown as { setStateManager: (sm: StateManager) => void }).setStateManager(stateManager);
app.use('/api/stats', statsRouter);

// Mount client error reporting (for frontend error logging)
app.use('/api/client-errors', clientErrorsRouter);

// Mount API routes (general /api/* - must come after more specific routes)
app.use('/api', createApiRouter(stateManager as unknown as Parameters<typeof createApiRouter>[0]));

// Serve static files from public directory (images, wrapper pages)
app.use(express.static(path.join(__dirname, 'public')));

// Serve React UI build assets (launcher) from ui/dist/
// In development, Vite dev server proxies to Express API
// Assets are built to /assets/ by Vite
app.use('/assets', express.static(path.join(__dirname, 'ui', 'dist', 'assets')));

// Check if any session is running
function hasRunningSession(): boolean {
  return Object.values(state.sessions).some(s => s && s.status === 'running');
}

/**
 * Get or create a proxy for the active session's IDE
 * Creates a proxy instance if one doesn't exist for the session,
 * or returns the existing proxy from ProxyRegistry.
 */
function getSessionProxy(ide: 'vscode' | 'rstudio' | 'jupyter' | 'port'): Server | undefined {
  const { activeSession } = state;
  if (!activeSession) {
    return undefined;
  }

  const sessionKey = `${activeSession.user}-${activeSession.hpc}-${ide}`;

  // Try to get existing proxy
  let proxy = proxyRegistry.getProxy(sessionKey);
  if (proxy) {
    return proxy;
  }

  // Create new proxy for this session
  try {
    proxy = proxyRegistry.createSessionProxy(sessionKey, ide);
    return proxy;
  } catch (err) {
    log.warn('Failed to create session proxy', {
      sessionKey,
      ide,
      error: (err as Error).message,
    });
    return undefined;
  }
}

// Landing page - always serve React launcher (no auto-redirect)
app.get('/', (req: Request, res: Response) => {
  log.ui('Serving launcher page');
  res.sendFile(path.join(__dirname, 'ui', 'dist', 'index.html'));
});

// Serve the menu iframe content
app.get('/hpc-menu-frame', (req: Request, res: Response) => {
  log.ui('Serving floating menu iframe');
  res.sendFile(path.join(__dirname, 'public', 'menu-frame.html'));
});

// Proxy VS Code asset paths directly (stable-xxx, vscode-xxx, etc.)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.match(/^\/(stable-|vscode-|oss-dev)/)) {
    if (!hasRunningSession()) {
      return res.redirect('/');
    }
    const proxy = getSessionProxy('vscode');
    if (proxy) {
      return proxy.web(req, res);
    }
    return res.redirect('/');
  }
  next();
});

// /code/ main page serves wrapper, /code/* paths proxy directly
app.use('/code', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }

  // Main /code/ page gets wrapper with floating menu
  if (req.path === '/' || req.path === '') {
    return res.sendFile(path.join(__dirname, 'public', 'vscode-wrapper.html'));
  }

  // All other /code/* paths proxy directly
  const proxy = getSessionProxy('vscode');
  if (proxy) {
    proxy.web(req, res);
  } else {
    res.redirect('/');
  }
});

// Direct proxy to VS Code (used by wrapper iframe)
app.use('/vscode-direct', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  const proxy = getSessionProxy('vscode');
  if (proxy) {
    proxy.web(req, res);
  } else {
    res.redirect('/');
  }
});

// RStudio proxy - serves at /rstudio/
app.use('/rstudio', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }

  // Main /rstudio/ page gets wrapper with floating menu
  if (req.path === '/' || req.path === '') {
    return res.sendFile(path.join(__dirname, 'public', 'rstudio-wrapper.html'));
  }

  // All other /rstudio/* paths proxy directly
  const proxy = getSessionProxy('rstudio');
  if (proxy) {
    proxy.web(req, res);
  } else {
    res.redirect('/');
  }
});

// Direct proxy to RStudio (used by wrapper iframe)
// Proxy auth handles authentication via X-RStudio-Username header
app.use('/rstudio-direct', (req: Request, res: Response) => {
  log.debugFor('rstudio', `direct ${req.method} ${req.path}`, {
    hasSession: hasRunningSession(),
    cookies: req.headers.cookie || 'none',
  });
  if (!hasRunningSession()) {
    log.debugFor('rstudio', 'No session, redirecting to /');
    return res.redirect('/');
  }
  const proxy = getSessionProxy('rstudio');
  if (proxy) {
    proxy.web(req, res);
  } else {
    res.redirect('/');
  }
});

// JupyterLab proxy - serves at /jupyter/
app.use('/jupyter', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }

  // Main /jupyter/ page gets wrapper with floating menu
  if (req.path === '/' || req.path === '') {
    return res.sendFile(path.join(__dirname, 'public', 'jupyter-wrapper.html'));
  }

  // All other /jupyter/* paths proxy directly
  const proxy = getSessionProxy('jupyter');
  if (proxy) {
    proxy.web(req, res);
  } else {
    res.redirect('/');
  }
});

// Direct proxy to JupyterLab (used by wrapper iframe)
app.use('/jupyter-direct', (req: Request, res: Response) => {
  log.debugFor('jupyter', `direct ${req.method} ${req.path}`);
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  const proxy = getSessionProxy('jupyter');
  if (proxy) {
    proxy.web(req, res);
  } else {
    res.redirect('/');
  }
});

// Route /port/:port/* through hpc-proxy for dev server access
// hpc-proxy handles the /port/:port/* -> localhost:port routing on HPC node
app.use('/port', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    log.debugFor('port-proxy', 'rejected - no running session');
    return res.redirect('/');
  }
  const proxy = getSessionProxy('port');
  if (!proxy) {
    res.redirect('/');
    return;
  }
  // Preserve full path - Express strips /port prefix, but hpc-proxy needs it
  req.url = req.originalUrl;
  log.debugFor('port-proxy', `${req.method} ${req.originalUrl}`);
  proxy.web(req, res);
});

// Global error handler - catches HpcError and returns structured JSON
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HpcError) {
    log.error(`${err.name}: ${err.message}`, err.details);
    return res.status(err.code).json(err.toJSON());
  }

  // Unexpected errors
  log.error('Unexpected error', { error: err.message, stack: err.stack });
  res.status(500).json({
    error: 'Internal Server Error',
    code: 500,
    type: 'UnexpectedError',
    timestamp: new Date().toISOString(),
  });
});

// Start server only after state manager is ready
const PORT = 3000;
let server: http.Server;

stateManager.load().then(async () => {
  log.info('State manager initialized');

  // Initialize partition service (inject HpcService for SSH operations)
  partitionService.setHpcService(HpcService);
  await partitionService.initialize();

  // Start background polling with HpcService factory
  // Cast to match the minimal interface required by StateManager
  stateManager.startPolling(((hpc: string) => new HpcService(hpc)) as unknown as Parameters<typeof stateManager.startPolling>[0]);

  server = app.listen(PORT, () => {
    log.info(`HPC Code Server Manager listening on port ${PORT}`);
    log.info(`Default HPC: ${config.defaultHpc}`);
  });

  // Handle WebSocket upgrades for VS Code, RStudio, JupyterLab, Live Server, Shiny, and port proxy
  server.on('upgrade', (req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
    log.proxy(`WebSocket upgrade: ${req.url}`);
    if (!hasRunningSession()) {
      log.proxy('WebSocket rejected: no session');
      socket.destroy();
      return;
    }

    let proxy: Server | undefined;
    let ide: string | undefined;

    // Port proxy WebSocket (dev servers on custom ports)
    if (req.url?.startsWith('/port/')) {
      proxy = getSessionProxy('port');
      ide = 'port';
    }
    // JupyterLab WebSocket (both /jupyter and /jupyter-direct paths)
    else if (req.url?.startsWith('/jupyter')) {
      proxy = getSessionProxy('jupyter');
      ide = 'jupyter';
    }
    // RStudio WebSocket (both /rstudio and /rstudio-direct paths)
    else if (req.url?.startsWith('/rstudio')) {
      proxy = getSessionProxy('rstudio');
      ide = 'rstudio';
    }
    // VS Code WebSocket for /vscode-direct, /stable-, /vscode-, /oss-dev paths
    else if (req.url?.startsWith('/code') ||
        req.url?.startsWith('/vscode-direct') ||
        req.url?.startsWith('/stable-') ||
        req.url?.startsWith('/vscode-') ||
        req.url?.startsWith('/oss-dev') ||
        req.url === '/' ||
        req.url?.startsWith('/?')) {
      proxy = getSessionProxy('vscode');
      ide = 'vscode';
    }

    if (proxy && ide) {
      log.debugFor(ide, `WebSocket upgrade: ${req.url}`);
      proxy.ws(req, socket, head);
    } else {
      log.proxy(`WebSocket rejected: ${req.url}`);
      socket.destroy();
    }
  });

  // Idle session cleanup (disabled by default, enable with SESSION_IDLE_TIMEOUT env var)
  // Checks every minute if any session has been idle longer than timeout, cancels SLURM job
  if (config.sessionIdleTimeout > 0) {
    const timeoutMs = config.sessionIdleTimeout * 60 * 1000;
    log.info(`Idle session cleanup enabled: ${config.sessionIdleTimeout} minutes`);

    setInterval(async () => {
      for (const sessionKey of Object.keys(state.sessions)) {
        const session = state.sessions[sessionKey];

        if (!session || session.status !== 'running' || !session.jobId) continue;

        // Calculate last activity, handling NaN from invalid date strings
        // Date.parse returns NaN for invalid dates, which || 0 handles
        const safeStartedAtTs = Date.parse(session.startedAt || '') || 0;
        const lastActivity = session.lastActivity || safeStartedAtTs;
        if (!lastActivity) continue;

        const idleMs = Date.now() - lastActivity;

        if (idleMs > timeoutMs) {
          // Parse user, hpc and ide from composite key (e.g., 'testuser-gemini-vscode')
          const parts = sessionKey.split('-');
          const ide = parts.pop()!;
          const hpc = parts.pop()!;
          const user = parts.join('-'); // Handle usernames with dashes
          const idleMins = Math.round(idleMs / 60000);
          log.info(`Session ${sessionKey} idle for ${idleMins} minutes, cancelling job`, {
            sessionKey,
            user,
            hpc,
            jobId: session.jobId,
            ide: session.ide,
          });

          try {
            const hpcService = new HpcService(hpc);
            await hpcService.cancelJob(session.jobId);
            // Clear session using StateManager API
            await stateManager.clearSession(user, hpc, ide, { endReason: 'timeout' });
            log.info(`Idle session ${sessionKey} cancelled successfully`);
          } catch (err) {
            log.error(`Failed to cancel idle session ${sessionKey}`, { error: (err as Error).message });
          }
        }
      }
    }, 60 * 1000); // Check every minute
  }
}).catch((err: Error) => {
  log.error('Failed to load state', { error: err.message });
  process.exit(1);
});

export { app, stateManager };

// CommonJS compatibility
module.exports = { app, stateManager };
