/**
 * HPC Code Server Manager
 * Main Express server - orchestration only
 *
 * Frontend assets are served from public/
 * Business logic is in services/ and lib/
 * API routes are in routes/
 */

const express = require('express');
const path = require('path');
const httpProxy = require('http-proxy');
const StateManager = require('./lib/state');
const { config, ides } = require('./config');
const createApiRouter = require('./routes/api');
const { HpcError } = require('./lib/errors');
const { log } = require('./lib/logger');

const app = express();
app.use(express.json());

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

// Proxy for forwarding to RStudio when tunnel is active
// proxyTimeout: 5 minutes for long-polling (RStudio uses HTTP long-poll for updates)
// timeout: 5 minutes for connection timeout
const rstudioProxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${ides.rstudio.port}`,
  changeOrigin: true,
  proxyTimeout: 5 * 60 * 1000,  // 5 minutes for long-polling
  timeout: 5 * 60 * 1000,       // 5 minutes connection timeout
});

rstudioProxy.on('error', (err, req, res) => {
  log.proxyError('RStudio proxy error', { error: err.message });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>RStudio not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Inject X-RStudio-Root-Path header so RStudio knows its proxy path
rstudioProxy.on('proxyReq', (proxyReq, req, res) => {
  proxyReq.setHeader('X-RStudio-Root-Path', '/rstudio-direct');
  log.debug(`RStudio proxyReq`, {
    method: req.method,
    url: req.url,
    cookies: req.headers.cookie ? req.headers.cookie.substring(0, 100) : 'none',
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

  // Debug: log all responses with cookies or redirects (full cookie details)
  if (status >= 300 && status < 400 || setCookies) {
    log.debug(`RStudio proxyRes`, {
      status,
      url: req.url,
      location: location || 'none',
      setCookies: setCookies || 'none',
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

      // Ensure path matches our proxy mount - NO trailing slash for broader cookie matching
      // path=/rstudio-direct matches both /rstudio-direct and /rstudio-direct/*
      // path=/rstudio-direct/ would NOT match /rstudio-direct (no slash) per RFC 6265
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
        log.debug(`Cookie rewritten: ${cookie} -> ${modified}`);
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

    // Rewrite root-relative redirects (e.g., "/" or "/auth-sign-in")
    // that aren't already prefixed with our proxy path
    if (rewritten.startsWith('/') && !rewritten.startsWith('/rstudio-direct')) {
      rewritten = '/rstudio-direct' + rewritten;
    }

    if (rewritten !== location) {
      proxyRes.headers['location'] = rewritten;
      log.debug(`RStudio redirect rewritten: ${location} -> ${rewritten}`);
    }
  }
});

// Proxy for Live Server (port 5500) - allows accessing dev server through manager
const liveServerProxy = httpProxy.createProxyServer({
  ws: true,
  target: 'http://127.0.0.1:5500',
  changeOrigin: true,
});

liveServerProxy.on('error', (err, req, res) => {
  log.proxyError('Live Server proxy error', { error: err.message });
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Live Server not available</h1><p>Make sure Live Server is running in VS Code (port 5500)</p><p><a href="/code/">Back to VS Code</a></p>');
  }
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
  log.debug(`[RStudio-Direct] ${req.method} ${req.path}`, {
    hasSession: hasRunningSession(),
    cookies: req.headers.cookie ? req.headers.cookie.substring(0, 100) : 'none',
  });
  if (!hasRunningSession()) {
    log.debug('[RStudio-Direct] No session, redirecting to /');
    return res.redirect('/');
  }
  rstudioProxy.web(req, res);
});

// Proxy to Live Server (port 5500) - access at /live/
app.use('/live', (req, res, next) => {
  if (!hasRunningSession()) {
    log.proxy('Live Server rejected - no running session');
    return res.redirect('/');
  }
  log.proxy(`Live Server: ${req.method} ${req.path}`);
  liveServerProxy.web(req, res);
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
  server = app.listen(PORT, () => {
    log.info(`HPC Code Server Manager listening on port ${PORT}`);
    log.info(`Default HPC: ${config.defaultHpc}`);
  });

  // Handle WebSocket upgrades for VS Code, RStudio, and Live Server
  server.on('upgrade', (req, socket, head) => {
    log.proxy(`WebSocket upgrade: ${req.url}`);
    if (hasRunningSession()) {
      // Live Server WebSocket (for hot reload)
      if (req.url.startsWith('/live')) {
        liveServerProxy.ws(req, socket, head);
      }
      // RStudio WebSocket (both /rstudio and /rstudio-direct paths)
      else if (req.url.startsWith('/rstudio')) {
        log.debug(`[WebSocket] RStudio upgrade: ${req.url}`);
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
}).catch(err => {
  log.error('Failed to load state', { error: err.message });
  process.exit(1);
});
