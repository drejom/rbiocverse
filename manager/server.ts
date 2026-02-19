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
import path from 'path';
import httpProxy from 'http-proxy';
import type * as HttpProxy from 'http-proxy';
import { StateManager } from './lib/state';
import { config, ides } from './config';
import HpcService from './services/hpc';
import createApiRouter from './routes/api';
import authRouter from './routes/auth';
import helpRouter, { setStateManager as helpSetStateManager } from './routes/help';
import adminRouter, { setStateManager as adminSetStateManager } from './routes/admin';
import statsRouter, { setStateManager as statsSetStateManager } from './routes/stats';
import clientErrorsRouter from './routes/client-errors';
import { HpcError } from './lib/errors';
import { log } from './lib/logger';
import { getCookieToken, isVscodeRootPath } from './lib/proxy-helpers';
import * as partitionService from './lib/partitions';

// Types
interface IdeConfig {
  port: number;
  name: string;
  icon?: string;
  proxyPath?: string;
}

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

// Mount auth routes (before general /api to avoid conflicts)
app.use('/api/auth', authRouter);

// Mount help routes (inject stateManager for template processing)
helpSetStateManager(stateManager);
app.use('/api/help', helpRouter);

// Mount admin routes (inject stateManager for cluster data)
adminSetStateManager(stateManager);
app.use('/api/admin', adminRouter);

// Mount public stats API (no auth required, inject stateManager)
statsSetStateManager(stateManager);
app.use('/api/stats', statsRouter);

// Mount client error reporting (for frontend error logging)
app.use('/api/client-errors', clientErrorsRouter);

// Mount API routes (general /api/* - must come after more specific routes)
app.use('/api', createApiRouter(stateManager));

// Serve static files from public directory (images, wrapper pages)
app.use(express.static(path.join(__dirname, 'public')));

// Serve React UI build assets (launcher) from ui/dist/
// In development, Vite dev server proxies to Express API
// Assets are built to /assets/ by Vite
app.use('/assets', express.static(path.join(__dirname, 'ui', 'dist', 'assets')));

// Proxy for forwarding to VS Code when tunnel is active
const vscodeProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${(ides.vscode as IdeConfig).port}`,
  changeOrigin: true,
});

vscodeProxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
  log.proxyError('VS Code proxy error', { error: err.message });
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>VS Code not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Log VS Code proxy events for debugging (enable with DEBUG_COMPONENTS=vscode)
// Rewrite path and inject connection token for VS Code authentication
vscodeProxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
  // VS Code serve-web 1.107+ auth flow:
  // 1. Token must be passed at root path: /?tkn=TOKEN
  // 2. Server sets vscode-tkn cookie and redirects to --server-base-path
  // 3. Subsequent requests use cookie for auth
  //
  // Important: We must verify the cookie token matches our session token.
  // Stale cookies from previous sessions cause 403 errors because VS Code
  // validates the token against its current session.
  const cookieToken = getCookieToken(req.headers.cookie || '');
  const sessionToken = getSessionToken('vscode');
  const hasValidCookie = cookieToken && sessionToken && cookieToken === sessionToken;

  const originalUrl = (req as Request).originalUrl || req.url || '';

  // Determine the target path
  let targetPath: string;
  if (originalUrl.startsWith('/vscode-direct')) {
    targetPath = originalUrl;
  } else if (originalUrl.startsWith('/code')) {
    targetPath = originalUrl.replace(/^\/code/, '/vscode-direct');
  } else {
    targetPath = originalUrl;
  }

  // Re-authenticate if:
  // 1. No cookie at all, or
  // 2. Cookie token doesn't match session token (stale cookie from old session)
  const isRootPath = isVscodeRootPath(targetPath);
  if (!hasValidCookie && sessionToken && isRootPath) {
    // Initial page load or stale cookie - use root auth flow to get fresh cookie
    proxyReq.path = `/?tkn=${sessionToken}`;
    log.debugFor('vscode', 'auth via root path', {
      originalUrl,
      reason: cookieToken ? 'stale cookie' : 'no cookie',
    });
  } else {
    // Cookie matches session token, or sub-resource request
    proxyReq.path = targetPath;
  }

  log.debugFor('vscode', 'proxyReq', {
    method: req.method,
    url: req.url,
    path: proxyReq.path,
    hasValidCookie,
    hasCookie: !!cookieToken,
    hasSessionToken: !!sessionToken,
    isRootPath,
  });
});

vscodeProxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage, res: http.ServerResponse) => {
  // On 403 Forbidden with stale cookie, intercept and redirect to re-authenticate
  // This handles the case where browser sends stale cookie from previous session
  if (proxyRes.statusCode === 403) {
    const cookieToken = getCookieToken(req.headers.cookie || '');
    if (cookieToken) {
      log.warn('VS Code 403 with stale cookie, redirecting to re-auth', { url: req.url });
      // Consume the original response to prevent it being sent
      proxyRes.resume();
      // Clear stale cookies and redirect to root for fresh auth
      res.setHeader('Set-Cookie', [
        'vscode-tkn=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'vscode-secret-key-path=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'vscode-cli-secret-half=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ]);
      res.writeHead(302, { Location: '/code/' });
      res.end();
      return;
    }
  }

  // Rewrite Set-Cookie headers to work through proxy
  // VS Code sets cookies for the backend domain, but browser accesses via proxy domain
  // We need to strip domain/path restrictions so cookies work through proxy
  const setCookies = proxyRes.headers['set-cookie'];
  if (setCookies && proxyRes.statusCode !== 403) {
    proxyRes.headers['set-cookie'] = setCookies.map(cookie => {
      // Remove Domain= attribute (let browser use current domain)
      // Change Path= to / so cookies work for all proxy paths
      return cookie
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*Path=[^;]*/gi, '; Path=/');
    });
    log.debugFor('vscode', 'rewrote cookies', { original: setCookies, rewritten: proxyRes.headers['set-cookie'] });
  }

  // Rewrite Location headers to point back through proxy
  const location = proxyRes.headers['location'];
  if (location) {
    log.debugFor('vscode', 'redirect location', { location, originalUrl: (req as Request).originalUrl });
  }

  log.debugFor('vscode', 'proxyRes', { status: proxyRes.statusCode, url: req.url });
  updateActivity();
});

vscodeProxy.on('open', () => {
  log.debugFor('vscode', 'proxy socket opened');
  updateActivity();
});

vscodeProxy.on('close', () => {
  log.debugFor('vscode', 'proxy connection closed');
});

// Proxy for forwarding to RStudio when tunnel is active
// proxyTimeout: 5 minutes for long-polling (RStudio uses HTTP long-poll for updates)
// timeout: 5 minutes for connection timeout
const rstudioProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${(ides.rstudio as IdeConfig).port}`,
  changeOrigin: true,
  proxyTimeout: 5 * 60 * 1000,  // 5 minutes for long-polling
  timeout: 5 * 60 * 1000,       // 5 minutes connection timeout
  // Fix "Parse Error: Data after Connection: close" with RStudio
  // rserver sends Connection: close but http-proxy keeps connection open
  agent: new http.Agent({ keepAlive: false }),
});

rstudioProxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
  const code = 'code' in err ? (err as { code: string }).code : undefined;
  log.proxyError('RStudio proxy error', { error: err.message, code, url: req?.url, stack: err.stack });
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>RStudio not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Log all proxy events for debugging (enable with DEBUG_COMPONENTS=rstudio)
rstudioProxy.on('start', ((req: http.IncomingMessage, res: http.ServerResponse, target: HttpProxy.ProxyTargetUrl) => {
  const targetString = typeof target === 'string' ? target : (target && 'href' in target ? (target as { href: string | null }).href : JSON.stringify(target));
  log.debugFor('rstudio', 'proxy start', { url: req.url, target: targetString });
}) as HttpProxy.StartCallback);

rstudioProxy.on('end', (req: http.IncomingMessage, res: http.ServerResponse, proxyRes: http.IncomingMessage) => {
  log.debugFor('rstudio', 'proxy end', { url: req.url, status: proxyRes?.statusCode });
});

// Log when proxy successfully connects to target
rstudioProxy.on('open', () => {
  log.debugFor('rstudio', 'proxy socket opened');
  updateActivity();
});

rstudioProxy.on('close', () => {
  log.debugFor('rstudio', 'proxy connection closed');
});

// Log proxy requests for debugging
rstudioProxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
  proxyReq.setHeader('X-RStudio-Root-Path', '/rstudio-direct');
  log.debugFor('rstudio', 'proxyReq', {
    method: req.method,
    url: req.url,
    cookies: req.headers.cookie || 'none',
  });
});

// Rewrite RStudio redirects and fix cookie/header attributes for iframe embedding
// Handle absolute URLs, root-relative redirects, and cookie path/secure issues
rstudioProxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
  const status = proxyRes.statusCode;
  const location = proxyRes.headers['location'];
  const setCookies = proxyRes.headers['set-cookie'];

  // Remove X-Frame-Options header - RStudio sets 'deny' which blocks iframe embedding
  // Our wrapper loads RStudio in an iframe, so we must strip this header
  delete proxyRes.headers['x-frame-options'];

  // Debug: log ALL responses to diagnose proxy issues
  const isRpc = req.url?.includes('/rpc/');
  log.debugFor('rstudio', 'proxyRes', {
    status,
    url: req.url,
    location: location || 'none',
    setCookies: setCookies ? 'yes' : 'none',
    contentLength: proxyRes.headers['content-length'] || 'unknown',
  });

  // For RPC calls, log when data starts flowing
  if (isRpc) {
    let dataSize = 0;
    proxyRes.on('data', (chunk: Buffer) => {
      dataSize += chunk.length;
      if (dataSize <= chunk.length) { // First chunk
        log.debugFor('rstudio', 'RPC data start', { url: req.url, firstChunkSize: chunk.length });
      }
    });
    proxyRes.on('end', () => {
      log.debugFor('rstudio', 'RPC data end', { url: req.url, totalSize: dataSize });
    });
    proxyRes.on('error', (err: Error) => {
      log.error(`RStudio RPC stream error`, { url: req.url, error: err.message });
    });
  }

  // Rewrite Set-Cookie headers for iframe compatibility
  // RStudio is loaded in an iframe, which requires SameSite=None; Secure for cookies
  // to be sent in cross-context requests (even same-origin iframes in some browsers)
  if (setCookies && Array.isArray(setCookies)) {
    proxyRes.headers['set-cookie'] = setCookies.map(cookie => {
      let modified = cookie;

      // DO NOT modify cookie values - RStudio signs them with HMAC and any
      // modification (like URL-encoding pipes) will cause signature validation
      // to fail, resulting in redirect loops.

      // Keep path=/rstudio-direct - RStudio validates cookies match www-root-path
      // Changing to path=/ breaks rsession spawning (rserver rejects mismatched cookies)
      // NO trailing slash for RFC 6265 compliance
      modified = modified.replace(/path=\/rstudio-direct\/?/i, 'path=/rstudio-direct');

      // For iframe compatibility: SameSite=None requires Secure flag
      // Remove any existing SameSite directive first
      modified = modified.replace(/;\s*samesite=[^;]*/gi, '');

      // Ensure Secure flag is present (required for SameSite=None)
      if (!/;\s*secure/i.test(modified)) {
        modified = modified + '; Secure';
      }

      // Add SameSite=None for iframe cookie support
      modified = modified + '; SameSite=None';

      if (modified !== cookie) {
        log.debugFor('rstudio', `Cookie rewritten: ${cookie} -> ${modified}`);
      }
      return modified;
    });
  }

  if (location) {
    let rewritten = location;

    // Rewrite absolute URLs pointing to the internal RStudio port
    rewritten = rewritten.replace(
      /^https?:\/\/127\.0\.0\.1:8787/,
      '/rstudio-direct'
    );

    // Rewrite absolute URLs pointing to external host (RStudio generates these)
    // e.g., https://hpc.omeally.com:443/rstudio-direct/ -> /rstudio-direct/
    rewritten = rewritten.replace(
      /^https?:\/\/[^/]+\/rstudio-direct/,
      '/rstudio-direct'
    );

    // Rewrite root-relative redirects (e.g., "/" or "/auth-sign-in")
    // that aren't already prefixed with our proxy path
    if (rewritten.startsWith('/') && !rewritten.startsWith('/rstudio-direct')) {
      rewritten = '/rstudio-direct' + rewritten;
    }

    if (rewritten !== location) {
      proxyRes.headers['location'] = rewritten;
      log.debugFor('rstudio', `redirect rewritten: ${location} -> ${rewritten}`);
    }
  }
  updateActivity();
});

// Proxy for JupyterLab (port 8888)
const jupyterProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${(ides.jupyter as IdeConfig).port}`,
  changeOrigin: true,
});

jupyterProxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
  log.proxyError('JupyterLab proxy error', { error: err.message });
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>JupyterLab not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Log Jupyter proxy events for debugging (enable with DEBUG_COMPONENTS=jupyter)
// Rewrite path and inject authentication token for JupyterLab
jupyterProxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
  const originalUrl = (req as Request).originalUrl || req.url || '';

  // Jupyter expects all requests at /jupyter-direct (--ServerApp.base_url)
  // Requests from /jupyter/* need to be rewritten to /jupyter-direct/*
  // Requests from /jupyter-direct/* already have correct path in originalUrl
  if (originalUrl.startsWith('/jupyter-direct')) {
    proxyReq.path = originalUrl;
  } else if (originalUrl.startsWith('/jupyter')) {
    // Rewrite /jupyter/foo -> /jupyter-direct/foo
    proxyReq.path = originalUrl.replace(/^\/jupyter/, '/jupyter-direct');
  }

  // JupyterLab uses query param ?token=TOKEN for authentication
  // Inject token if we have one and it's not already in the URL
  const token = getSessionToken('jupyter');
  const hasTokenInUrl = proxyReq.path.includes('token=');
  if (token && !hasTokenInUrl) {
    const separator = proxyReq.path.includes('?') ? '&' : '?';
    proxyReq.path = `${proxyReq.path}${separator}token=${token}`;
  }

  log.debugFor('jupyter', 'proxyReq', {
    method: req.method,
    url: req.url,
    path: proxyReq.path,
    hasSessionToken: !!token,
    tokenInjected: !!(token && !hasTokenInUrl),
  });
});

jupyterProxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
  log.debugFor('jupyter', 'proxyRes', { status: proxyRes.statusCode, url: req.url });
  updateActivity();
});

jupyterProxy.on('open', () => {
  updateActivity();
  log.debugFor('jupyter', 'proxy socket opened');
});

jupyterProxy.on('close', () => {
  log.debugFor('jupyter', 'proxy connection closed');
});

// Proxy for hpc-proxy port routing (dev servers via /port/:port/*)
// Routes /port/:port/* requests to hpc-proxy which forwards to localhost:port on HPC node
const portProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${config.hpcProxyLocalPort}`,
  changeOrigin: true,
});

portProxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
  log.debugFor('port-proxy', 'proxy error', { error: err.message, url: req.url });
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Dev server unavailable. Is it running?');
  }
});

portProxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
  log.debugFor('port-proxy', 'proxyReq', {
    method: req.method,
    url: req.url,
    path: proxyReq.path,
  });
});

portProxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
  log.debugFor('port-proxy', 'proxyRes', { status: proxyRes.statusCode, url: req.url });
  updateActivity();
});

portProxy.on('open', () => {
  updateActivity();
  log.debugFor('port-proxy', 'proxy socket opened');
});

portProxy.on('close', () => {
  log.debugFor('port-proxy', 'proxy connection closed');
});

// Check if any session is running
function hasRunningSession(): boolean {
  return Object.values(state.sessions).some(s => s && s.status === 'running');
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
    return vscodeProxy.web(req, res);
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
  vscodeProxy.web(req, res);
});

// Direct proxy to VS Code (used by wrapper iframe)
app.use('/vscode-direct', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  vscodeProxy.web(req, res);
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
  rstudioProxy.web(req, res);
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
  rstudioProxy.web(req, res);
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
  jupyterProxy.web(req, res);
});

// Direct proxy to JupyterLab (used by wrapper iframe)
app.use('/jupyter-direct', (req: Request, res: Response) => {
  log.debugFor('jupyter', `direct ${req.method} ${req.path}`);
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  jupyterProxy.web(req, res);
});

// Route /port/:port/* through hpc-proxy for dev server access
// hpc-proxy handles the /port/:port/* -> localhost:port routing on HPC node
app.use('/port', (req: Request, res: Response) => {
  if (!hasRunningSession()) {
    log.debugFor('port-proxy', 'rejected - no running session');
    return res.redirect('/');
  }
  // Preserve full path - Express strips /port prefix, but hpc-proxy needs it
  req.url = req.originalUrl;
  log.debugFor('port-proxy', `${req.method} ${req.originalUrl}`);
  portProxy.web(req, res);
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
  stateManager.startPolling((hpc: string) => new HpcService(hpc));

  server = app.listen(PORT, () => {
    log.info(`HPC Code Server Manager listening on port ${PORT}`);
    log.info(`Default HPC: ${config.defaultHpc}`);
  });

  // Handle WebSocket upgrades for VS Code, RStudio, JupyterLab, Live Server, Shiny, and port proxy
  server.on('upgrade', (req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
    log.proxy(`WebSocket upgrade: ${req.url}`);
    if (hasRunningSession()) {
      // Port proxy WebSocket (dev servers on custom ports)
      if (req.url?.startsWith('/port/')) {
        log.debugFor('port-proxy', `WebSocket upgrade: ${req.url}`);
        portProxy.ws(req, socket, head);
      }
      // JupyterLab WebSocket (both /jupyter and /jupyter-direct paths)
      else if (req.url?.startsWith('/jupyter')) {
        log.debugFor('jupyter', `WebSocket upgrade: ${req.url}`);
        jupyterProxy.ws(req, socket, head);
      }
      // RStudio WebSocket (both /rstudio and /rstudio-direct paths)
      else if (req.url?.startsWith('/rstudio')) {
        log.debugFor('rstudio', `WebSocket upgrade: ${req.url}`);
        rstudioProxy.ws(req, socket, head);
      }
      // VS Code WebSocket for /vscode-direct, /stable-, /vscode-, /oss-dev paths
      else if (req.url?.startsWith('/code') ||
          req.url?.startsWith('/vscode-direct') ||
          req.url?.startsWith('/stable-') ||
          req.url?.startsWith('/vscode-') ||
          req.url?.startsWith('/oss-dev') ||
          req.url === '/' ||
          req.url?.startsWith('/?')) {
        vscodeProxy.ws(req, socket, head);
      } else {
        log.proxy(`WebSocket rejected: ${req.url}`);
        socket.destroy();
      }
    } else {
      log.proxy('WebSocket rejected: no session');
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
