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
const { config } = require('./config');
const createApiRouter = require('./routes/api');

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

// Load persisted state on startup
stateManager.load().then(() => {
  console.log('State manager initialized');
}).catch(err => {
  console.error('Failed to load state:', err.message);
});

// Mount API routes
app.use('/api', createApiRouter(stateManager));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Proxy for forwarding to code-server when tunnel is active
const proxy = httpProxy.createProxyServer({
  ws: true,
  target: `http://127.0.0.1:${config.codeServerPort}`,
  changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Code server not available</h1><p><a href="/">Back to launcher</a></p>');
  }
});

// Proxy for Live Server (port 5500) - allows accessing dev server through manager
const liveServerProxy = httpProxy.createProxyServer({
  ws: true,
  target: 'http://127.0.0.1:5500',
  changeOrigin: true,
});

liveServerProxy.on('error', (err, req, res) => {
  console.error('Live Server proxy error:', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<h1>Live Server not available</h1><p>Make sure Live Server is running in VS Code (port 5500)</p><p><a href="/code/">Back to VS Code</a></p>');
  }
});

// Check if any session is running
function hasRunningSession() {
  return Object.values(state.sessions).some(s => s && s.status === 'running');
}

// Landing page - serve static index.html or redirect to /code/ if session running
app.get('/', (req, res) => {
  // Allow ?menu=1 to bypass redirect (for "Main Menu" button)
  if (req.query.menu) {
    console.log('[UI] Main menu opened via ?menu=1');
  }
  if (!req.query.menu && hasRunningSession()) {
    return res.redirect('/code/');
  }
  console.log('[UI] Serving launcher page');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the menu iframe content
app.get('/hpc-menu-frame', (req, res) => {
  console.log('[UI] Serving floating menu iframe');
  res.sendFile(path.join(__dirname, 'public', 'menu-frame.html'));
});

// Proxy VS Code asset paths directly (stable-xxx, vscode-xxx, etc.)
app.use((req, res, next) => {
  if (req.path.match(/^\/(stable-|vscode-|oss-dev)/)) {
    if (!hasRunningSession()) {
      return res.redirect('/');
    }
    return proxy.web(req, res);
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
  proxy.web(req, res);
});

// Direct proxy to VS Code (used by wrapper iframe)
app.use('/vscode-direct', (req, res, next) => {
  if (!hasRunningSession()) {
    return res.redirect('/');
  }
  proxy.web(req, res);
});

// Proxy to Live Server (port 5500) - access at /live/
app.use('/live', (req, res, next) => {
  if (!hasRunningSession()) {
    console.log('[Live Server] Rejected - no running session');
    return res.redirect('/');
  }
  console.log(`[Live Server] Proxying ${req.method} ${req.path}`);
  liveServerProxy.web(req, res);
});

// Start server
const PORT = 3000;
const server = app.listen(PORT, () => {
  console.log(`HPC Code Server Manager listening on port ${PORT}`);
  console.log(`Default HPC: ${config.defaultHpc}`);
});

// Handle WebSocket upgrades for code-server and Live Server
server.on('upgrade', (req, socket, head) => {
  console.log(`WebSocket: ${req.url}`);
  if (hasRunningSession()) {
    // Live Server WebSocket (for hot reload)
    if (req.url.startsWith('/live')) {
      liveServerProxy.ws(req, socket, head);
    }
    // Proxy WebSocket for /vscode-direct, /stable-, /vscode-, /oss-dev paths
    else if (req.url.startsWith('/code') ||
        req.url.startsWith('/stable-') ||
        req.url.startsWith('/vscode-') ||
        req.url.startsWith('/oss-dev') ||
        req.url === '/' ||
        req.url.startsWith('/?')) {
      proxy.ws(req, socket, head);
    } else {
      console.log(`WebSocket rejected: ${req.url}`);
      socket.destroy();
    }
  } else {
    console.log('WebSocket rejected: no session');
    socket.destroy();
  }
});
