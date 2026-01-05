/**
 * HPC Code Server Manager
 * Main Express server - orchestration only
 *
 * Frontend assets are served from public/
 * Business logic is in services/ and lib/
 * API routes are in routes/
 */

const express = require('express');
const http = require('http');
const path = require('path');
const httpProxy = require('http-proxy');
const { StateManager } = require('./lib/state');
const { config, ides } = require('./config');
const HpcService = require('./services/hpc');
const createApiRouter = require('./routes/api');
const { HpcError } = require('./lib/errors');
const { log } = require('./lib/logger');

const app = express();
// NOTE: Do NOT use express.json() globally - it consumes request body streams
// which breaks http-proxy for POST requests (like RStudio's /rpc/client_init).
// Body parsing is applied only to /api routes in routes/api.js

// Prevent caching issues - VS Code uses service workers that can cache stale paths
// Safari is particularly aggressive about caching, so we use multiple headers
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Multi-session state - track sessions per HPC
// Using StateManager for persistence across container restarts
const stateManager = new StateManager();
const state = stateManager.state;

// Activity tracking for idle session cleanup
// Updates lastActivity timestamp on proxy traffic (like JupyterHub's CHP)
function updateActivity() {
  const { activeSession } = state;
  if (activeSession) {
    const sessionKey = `${activeSession.hpc}-${activeSession.ide}`;
    if (state.sessions[sessionKey]) {
      state.sessions[sessionKey].lastActivity = Date.now();
    }
  }
}

// Get token for active session's IDE
// Used by proxies to inject authentication tokens into requests
function getSessionToken(ide) {
  const { activeSession } = state;
  if (!activeSession) return null;
  const sessionKey = `${activeSession.hpc}-${ide}`;
  return state.sessions[sessionKey]?.token || null;
}

// Mount API routes
app.use('/api', createApiRouter(stateManager));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Proxy for forwarding to VS Code when tunnel is active
const vscodeProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${ides.vscode.port}`,
  changeOrigin: true,
});

vscodeProxy.on('error', (err, req, res) => {
  log.proxyError('VS Code proxy error', { error: err.message });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>VS Code not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Extract token value from vscode-tkn cookie
function getCookieToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/vscode-tkn=([^;]+)/);
  return match ? match[1] : null;
}

// Log VS Code proxy events for debugging (enable with DEBUG_COMPONENTS=vscode)
// Rewrite path and inject connection token for VS Code authentication
vscodeProxy.on('proxyReq', (proxyReq, req, res) => {
  // VS Code serve-web 1.107+ auth flow:
  // 1. Token must be passed at root path: /?tkn=TOKEN
  // 2. Server sets vscode-tkn cookie and redirects to --server-base-path
  // 3. Subsequent requests use cookie for auth
  //
  // Important: We must verify the cookie token matches our session token.
  // Stale cookies from previous sessions cause 403 errors because VS Code
  // validates the token against its current session.
  const cookieToken = getCookieToken(req.headers.cookie);
  const sessionToken = getSessionToken('vscode');
  const hasValidCookie = cookieToken && sessionToken && cookieToken === sessionToken;

  // Determine the target path
  let targetPath;
  if (req.originalUrl.startsWith('/vscode-direct')) {
    targetPath = req.originalUrl;
  } else if (req.originalUrl.startsWith('/code')) {
    targetPath = req.originalUrl.replace(/^\/code/, '/vscode-direct');
  } else {
    targetPath = req.originalUrl;
  }

  // Re-authenticate if:
  // 1. No cookie at all, or
  // 2. Cookie token doesn't match session token (stale cookie from old session)
  // Strip query string for root path check (URL may have ?t=timestamp)
  const pathWithoutQuery = targetPath.split('?')[0];
  const isRootPath = pathWithoutQuery === '/vscode-direct' || pathWithoutQuery === '/vscode-direct/';
  if (!hasValidCookie && sessionToken && isRootPath) {
    // Initial page load or stale cookie - use root auth flow to get fresh cookie
    proxyReq.path = `/?tkn=${sessionToken}`;
    log.debugFor('vscode', 'auth via root path', {
      originalUrl: req.originalUrl,
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

vscodeProxy.on('proxyRes', (proxyRes, req, res) => {
  // On 403 Forbidden with stale cookie, intercept and redirect to re-authenticate
  // This handles the case where browser sends stale cookie from previous session
  if (proxyRes.statusCode === 403) {
    const cookieToken = getCookieToken(req.headers.cookie);
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
    log.debugFor('vscode', 'redirect location', { location, originalUrl: req.originalUrl });
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
  target: `http://127.0.0.1:${ides.rstudio.port}`,
  changeOrigin: true,
  proxyTimeout: 5 * 60 * 1000,  // 5 minutes for long-polling
  timeout: 5 * 60 * 1000,       // 5 minutes connection timeout
  // Fix "Parse Error: Data after Connection: close" with RStudio
  // rserver sends Connection: close but http-proxy keeps connection open
  agent: new http.Agent({ keepAlive: false }),
});

rstudioProxy.on('error', (err, req, res) => {
  log.proxyError('RStudio proxy error', { error: err.message, code: err.code, url: req?.url, stack: err.stack });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>RStudio not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Log all proxy events for debugging (enable with DEBUG_COMPONENTS=rstudio)
rstudioProxy.on('start', (req, res, target) => {
  log.debugFor('rstudio', 'proxy start', { url: req.url, target: target.href });
});

rstudioProxy.on('end', (req, res, proxyRes) => {
  log.debugFor('rstudio', 'proxy end', { url: req.url, status: proxyRes?.statusCode });
});

// Log when proxy successfully connects to target
rstudioProxy.on('open', (proxySocket) => {
  log.debugFor('rstudio', 'proxy socket opened');
  updateActivity();
});

rstudioProxy.on('close', (res, socket, head) => {
  log.debugFor('rstudio', 'proxy connection closed');
});

// Log proxy requests for debugging
rstudioProxy.on('proxyReq', (proxyReq, req, res) => {
  proxyReq.setHeader('X-RStudio-Root-Path', '/rstudio-direct');
  log.debugFor('rstudio', 'proxyReq', {
    method: req.method,
    url: req.url,
    cookies: req.headers.cookie || 'none',
  });
});

// Rewrite RStudio redirects and fix cookie/header attributes for iframe embedding
// Handle absolute URLs, root-relative redirects, and cookie path/secure issues
rstudioProxy.on('proxyRes', (proxyRes, req, res) => {
  const status = proxyRes.statusCode;
  const location = proxyRes.headers['location'];
  const setCookies = proxyRes.headers['set-cookie'];

  // Remove X-Frame-Options header - RStudio sets 'deny' which blocks iframe embedding
  // Our wrapper loads RStudio in an iframe, so we must strip this header
  delete proxyRes.headers['x-frame-options'];

  // Debug: log ALL responses to diagnose proxy issues
  const isRpc = req.url.includes('/rpc/');
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
    proxyRes.on('data', (chunk) => {
      dataSize += chunk.length;
      if (dataSize <= chunk.length) { // First chunk
        log.debugFor('rstudio', 'RPC data start', { url: req.url, firstChunkSize: chunk.length });
      }
    });
    proxyRes.on('end', () => {
      log.debugFor('rstudio', 'RPC data end', { url: req.url, totalSize: dataSize });
    });
    proxyRes.on('error', (err) => {
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
      /^https?:\/\/[^\/]+\/rstudio-direct/,
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

// Proxy for Live Server (port 5500) - allows accessing dev server through manager
const liveServerProxy = httpProxy.createProxyServer({
  ws: true,
  target: 'http://127.0.0.1:5500',
  changeOrigin: true,
});

liveServerProxy.on('error', (err, req, res) => {
  // Expected when Live Server isn't running - use liveserver component
  log.debugFor('liveserver', 'proxy error', { error: err.message });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Live Server not available</h1><p>Make sure Live Server is running in VS Code (port 5500)</p><p><a href="/code/">Back to VS Code</a></p>');
  }
});

// Proxy for Shiny Server (port 3838) - R Shiny apps
const shinyProxy = httpProxy.createProxyServer({
  ws: true,
  target: 'http://127.0.0.1:3838',
  changeOrigin: true,
});

shinyProxy.on('error', (err, req, res) => {
  log.debugFor('shiny', 'proxy error', { error: err.message });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Shiny Server not available</h1><p>Make sure a Shiny app is running (port 3838)</p><p><a href="/code/">Back to VS Code</a></p>');
  }
});

// Proxy for JupyterLab (port 8888)
const jupyterProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${ides.jupyter.port}`,
  changeOrigin: true,
});

jupyterProxy.on('error', (err, req, res) => {
  log.proxyError('JupyterLab proxy error', { error: err.message });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>JupyterLab not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Log Jupyter proxy events for debugging (enable with DEBUG_COMPONENTS=jupyter)
// Rewrite path and inject authentication token for JupyterLab
jupyterProxy.on('proxyReq', (proxyReq, req, res) => {
  // Jupyter expects all requests at /jupyter-direct (--ServerApp.base_url)
  // Requests from /jupyter/* need to be rewritten to /jupyter-direct/*
  // Requests from /jupyter-direct/* already have correct path in originalUrl
  if (req.originalUrl.startsWith('/jupyter-direct')) {
    proxyReq.path = req.originalUrl;
  } else if (req.originalUrl.startsWith('/jupyter')) {
    // Rewrite /jupyter/foo -> /jupyter-direct/foo
    proxyReq.path = req.originalUrl.replace(/^\/jupyter/, '/jupyter-direct');
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

jupyterProxy.on('proxyRes', (proxyRes, req, res) => {
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

// Check if any session is running
function hasRunningSession() {
  return Object.values(state.sessions).some(s => s && s.status === 'running');
}

// Landing page - serve static index.html or redirect to active IDE if session running
app.get('/', (req, res) => {
  // Allow ?menu=1 to bypass redirect (for "Main Menu" button)
  if (req.query.menu) {
    log.ui('Main menu opened via ?menu=1');
  }
  log.debugFor('ui', 'root request', { menu: req.query.menu, hasSession: hasRunningSession() });
  if (!req.query.menu && hasRunningSession()) {
    // Redirect to the active IDE's proxy path
    const activeIde = state.activeSession?.ide || 'vscode';
    const proxyPath = ides[activeIde]?.proxyPath || '/code/';
    return res.redirect(proxyPath);
  }
  log.ui('Serving launcher page');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the menu iframe content
app.get('/hpc-menu-frame', (req, res) => {
  log.ui('Serving floating menu iframe');
  res.sendFile(path.join(__dirname, 'public', 'menu-frame.html'));
});

// Proxy VS Code asset paths directly (stable-xxx, vscode-xxx, etc.)
app.use((req, res, next) => {
  if (req.path.match(/^\/(stable-|vscode-|oss-dev)/)) {
    if (!hasRunningSession()) {
      return res.redirect('/');
    }
    return vscodeProxy.web(req, res);
  }
  next();
});

// /code/ main page serves wrapper, /code/* paths proxy directly
app.use('/code', (req, res, next) => {
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
app.use('/vscode-direct', (req, res, next) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  vscodeProxy.web(req, res);
});

// RStudio proxy - serves at /rstudio/
app.use('/rstudio', (req, res, next) => {
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
app.use('/rstudio-direct', (req, res, next) => {
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

// Proxy to Live Server (port 5500) - access at /live/
app.use('/live', (req, res, next) => {
  if (!hasRunningSession()) {
    log.debugFor('liveserver', 'rejected - no running session');
    return res.redirect('/');
  }
  log.debugFor('liveserver', `${req.method} ${req.path}`);
  liveServerProxy.web(req, res);
});

// Proxy to Shiny Server (port 3838) - access at /shiny/
app.use('/shiny', (req, res, next) => {
  if (!hasRunningSession()) {
    log.debugFor('shiny', 'rejected - no running session');
    return res.redirect('/');
  }
  log.debugFor('shiny', `${req.method} ${req.path}`);
  shinyProxy.web(req, res);
});

// JupyterLab proxy - serves at /jupyter/
app.use('/jupyter', (req, res, next) => {
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
app.use('/jupyter-direct', (req, res, next) => {
  log.debugFor('jupyter', `direct ${req.method} ${req.path}`);
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  jupyterProxy.web(req, res);
});

// Global error handler - catches HpcError and returns structured JSON
app.use((err, req, res, next) => {
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
let server;

stateManager.load().then(() => {
  log.info('State manager initialized');

  // Start background polling with HpcService factory
  stateManager.startPolling(hpc => new HpcService(hpc));

  server = app.listen(PORT, () => {
    log.info(`HPC Code Server Manager listening on port ${PORT}`);
    log.info(`Default HPC: ${config.defaultHpc}`);
  });

  // Handle WebSocket upgrades for VS Code, RStudio, JupyterLab, Live Server, and Shiny
  server.on('upgrade', (req, socket, head) => {
    log.proxy(`WebSocket upgrade: ${req.url}`);
    if (hasRunningSession()) {
      // Live Server WebSocket (for hot reload)
      if (req.url.startsWith('/live')) {
        liveServerProxy.ws(req, socket, head);
      }
      // Shiny WebSocket
      else if (req.url.startsWith('/shiny')) {
        log.debugFor('shiny', `WebSocket upgrade: ${req.url}`);
        shinyProxy.ws(req, socket, head);
      }
      // JupyterLab WebSocket (both /jupyter and /jupyter-direct paths)
      else if (req.url.startsWith('/jupyter')) {
        log.debugFor('jupyter', `WebSocket upgrade: ${req.url}`);
        jupyterProxy.ws(req, socket, head);
      }
      // RStudio WebSocket (both /rstudio and /rstudio-direct paths)
      else if (req.url.startsWith('/rstudio')) {
        log.debugFor('rstudio', `WebSocket upgrade: ${req.url}`);
        rstudioProxy.ws(req, socket, head);
      }
      // VS Code WebSocket for /vscode-direct, /stable-, /vscode-, /oss-dev paths
      else if (req.url.startsWith('/code') ||
          req.url.startsWith('/vscode-direct') ||
          req.url.startsWith('/stable-') ||
          req.url.startsWith('/vscode-') ||
          req.url.startsWith('/oss-dev') ||
          req.url === '/' ||
          req.url.startsWith('/?')) {
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
        const safeStartedAtTs = Date.parse(session.startedAt) || 0;
        const lastActivity = session.lastActivity || safeStartedAtTs;
        if (!lastActivity) continue;

        const idleMs = Date.now() - lastActivity;

        if (idleMs > timeoutMs) {
          // Parse hpc and ide from composite key (e.g., 'gemini-vscode' -> ['gemini', 'vscode'])
          const [hpc, ide] = sessionKey.split('-');
          const idleMins = Math.round(idleMs / 60000);
          log.info(`Session ${sessionKey} idle for ${idleMins} minutes, cancelling job`, {
            sessionKey,
            hpc,
            jobId: session.jobId,
            ide: session.ide,
          });

          try {
            const hpcService = new HpcService(hpc);
            await hpcService.cancelJob(session.jobId);
            // Clear session using StateManager API
            await stateManager.clearSession(hpc, ide);
            log.info(`Idle session ${sessionKey} cancelled successfully`);
          } catch (err) {
            log.error(`Failed to cancel idle session ${sessionKey}`, { error: err.message });
          }
        }
      }
    }, 60 * 1000); // Check every minute
  }
}).catch(err => {
  log.error('Failed to load state', { error: err.message });
  process.exit(1);
});
