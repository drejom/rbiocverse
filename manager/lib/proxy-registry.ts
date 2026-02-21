/**
 * Per-session HTTP proxy registry for IDE routing.
 *
 * With dynamic port allocation (see ports.ts), each session gets a unique local port.
 * This registry stores proxy instances keyed by sessionKey, allowing the server to
 * route requests to the correct session's tunnel port.
 *
 * Session key format: `${user}-${hpc}-${ide}` (e.g., "domeally-gemini-vscode")
 */

import * as http from 'http';
import httpProxy from 'http-proxy';
import type { ProxyTargetUrl, StartCallback } from 'http-proxy';
import { PortRegistry } from './ports';
import { getCookieToken, isVscodeRootPath } from './proxy-helpers';
import { log } from './logger';
import { config } from '../config';

// Activity update callback type
type OnActivityCallback = () => void;

// Express adds originalUrl to requests but http.IncomingMessage doesn't declare it
interface ProxiedRequest extends http.IncomingMessage {
  originalUrl?: string;
}

// Type alias for the proxy server instance
type Server = ReturnType<typeof httpProxy.createProxyServer>;

/**
 * Per-session proxy instance wrapper
 * Stores both the proxy server and IDE-specific metadata
 */
interface SessionProxy {
  proxy: Server;
  ide: string;
  port: number;
  sessionKey: string;
}

/**
 * Registry of per-session proxies
 * Key: sessionKey (user-hpc-ide), Value: SessionProxy
 */
export const ProxyRegistry: Map<string, SessionProxy> = new Map();

/**
 * Token lookup callback for authentication
 * Returns the session token for a given IDE (e.g., VS Code, Jupyter)
 */
type GetSessionTokenFn = (ide: string) => string | null;

// Global token lookup function - set by server.ts on init
let getSessionToken: GetSessionTokenFn = () => null;

// Global activity update callback - set by server.ts on init
let onActivity: OnActivityCallback = () => {};

/**
 * Set the session token lookup function
 * Called by server.ts to enable proxy authentication
 */
export function setGetSessionToken(fn: GetSessionTokenFn): void {
  getSessionToken = fn;
}

/**
 * Set the activity update callback
 * Called by server.ts to enable idle session tracking
 */
export function setOnActivity(fn: OnActivityCallback): void {
  onActivity = fn;
}

/**
 * Create a VS Code proxy for a session
 */
function createVsCodeProxy(sessionKey: string, localPort: number): Server {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    target: `http://127.0.0.1:${localPort}`,
    changeOrigin: true,
  });

  proxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
    log.proxyError('VS Code proxy error', { error: err.message, sessionKey });
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<h1>VS Code not available</h1><p><a href="/">Back to launcher</a></p>');
    }
  });

  proxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
    const cookieToken = getCookieToken(req.headers.cookie || '');
    const sessionToken = getSessionToken('vscode');
    const hasValidCookie = cookieToken && sessionToken && cookieToken === sessionToken;

    const originalUrl = (req as ProxiedRequest).originalUrl || req.url || '';

    let targetPath: string;
    if (originalUrl.startsWith('/vscode-direct')) {
      targetPath = originalUrl;
    } else if (originalUrl.startsWith('/code')) {
      targetPath = originalUrl.replace(/^\/code/, '/vscode-direct');
    } else {
      targetPath = originalUrl;
    }

    const isRootPath = isVscodeRootPath(targetPath);
    if (!hasValidCookie && sessionToken && isRootPath) {
      proxyReq.path = `/?tkn=${sessionToken}`;
      log.debugFor('vscode', 'auth via root path', {
        sessionKey,
        originalUrl,
        reason: cookieToken ? 'stale cookie' : 'no cookie',
      });
    } else {
      proxyReq.path = targetPath;
    }

    log.debugFor('vscode', 'proxyReq', {
      sessionKey,
      method: req.method,
      url: req.url,
      path: proxyReq.path,
      hasValidCookie,
      hasCookie: !!cookieToken,
      hasSessionToken: !!sessionToken,
    });
  });

  proxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage, res: http.ServerResponse) => {
    if (proxyRes.statusCode === 403) {
      const cookieToken = getCookieToken(req.headers.cookie || '');
      if (cookieToken) {
        log.warn('VS Code 403 with stale cookie, redirecting to re-auth', { sessionKey, url: req.url });
        proxyRes.resume();
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

    const setCookies = proxyRes.headers['set-cookie'];
    if (setCookies && proxyRes.statusCode !== 403) {
      proxyRes.headers['set-cookie'] = setCookies.map(cookie => {
        return cookie
          .replace(/;\s*Domain=[^;]*/gi, '')
          .replace(/;\s*Path=[^;]*/gi, '; Path=/');
      });
    }

    log.debugFor('vscode', 'proxyRes', { sessionKey, status: proxyRes.statusCode, url: req.url });
    onActivity();
  });

  proxy.on('open', () => {
    log.debugFor('vscode', 'proxy socket opened', { sessionKey });
    onActivity();
  });

  proxy.on('close', () => {
    log.debugFor('vscode', 'proxy connection closed', { sessionKey });
  });

  return proxy;
}

/**
 * Create an RStudio proxy for a session
 */
function createRstudioProxy(sessionKey: string, localPort: number): Server {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    target: `http://127.0.0.1:${localPort}`,
    changeOrigin: true,
    proxyTimeout: 5 * 60 * 1000,
    timeout: 5 * 60 * 1000,
    agent: new http.Agent({ keepAlive: false }),
  });

  proxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
    const code = 'code' in err ? (err as { code: string }).code : undefined;
    log.proxyError('RStudio proxy error', { error: err.message, code, url: req?.url, sessionKey, stack: err.stack });
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<h1>RStudio not available</h1><p><a href="/">Back to launcher</a></p>');
    }
  });

  proxy.on('start', ((req: http.IncomingMessage, res: http.ServerResponse, target: ProxyTargetUrl) => {
    const targetString = typeof target === 'string'
      ? target
      : (target && 'href' in target ? (target as { href: string | null }).href : JSON.stringify(target));
    log.debugFor('rstudio', 'proxy start', { sessionKey, url: req.url, target: targetString });
  }) as StartCallback);

  proxy.on('end', (req: http.IncomingMessage, res: http.ServerResponse, proxyRes: http.IncomingMessage) => {
    log.debugFor('rstudio', 'proxy end', { sessionKey, url: req.url, status: proxyRes?.statusCode });
  });

  proxy.on('open', () => {
    log.debugFor('rstudio', 'proxy socket opened', { sessionKey });
    onActivity();
  });

  proxy.on('close', () => {
    log.debugFor('rstudio', 'proxy connection closed', { sessionKey });
  });

  proxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
    proxyReq.setHeader('X-RStudio-Root-Path', '/rstudio-direct');
    log.debugFor('rstudio', 'proxyReq', {
      sessionKey,
      method: req.method,
      url: req.url,
      cookies: req.headers.cookie || 'none',
    });
  });

  proxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
    const status = proxyRes.statusCode;
    const location = proxyRes.headers['location'];
    const setCookies = proxyRes.headers['set-cookie'];

    delete proxyRes.headers['x-frame-options'];

    const isRpc = req.url?.includes('/rpc/');
    log.debugFor('rstudio', 'proxyRes', {
      sessionKey,
      status,
      url: req.url,
      location: location || 'none',
      setCookies: setCookies ? 'yes' : 'none',
    });

    if (isRpc) {
      let dataSize = 0;
      proxyRes.on('data', (chunk: Buffer) => {
        dataSize += chunk.length;
        if (dataSize <= chunk.length) {
          log.debugFor('rstudio', 'RPC data start', { sessionKey, url: req.url, firstChunkSize: chunk.length });
        }
      });
      proxyRes.on('end', () => {
        log.debugFor('rstudio', 'RPC data end', { sessionKey, url: req.url, totalSize: dataSize });
      });
      proxyRes.on('error', (err: Error) => {
        log.error(`RStudio RPC stream error`, { sessionKey, url: req.url, error: err.message });
      });
    }

    if (setCookies && Array.isArray(setCookies)) {
      proxyRes.headers['set-cookie'] = setCookies.map(cookie => {
        let modified = cookie.replace(/path=\/rstudio-direct\/?/i, 'path=/rstudio-direct');
        modified = modified.replace(/;\s*samesite=[^;]*/gi, '');
        if (!/;\s*secure/i.test(modified)) {
          modified = modified + '; Secure';
        }
        return modified + '; SameSite=None';
      });
    }

    if (location) {
      const localLoopbackPattern = new RegExp(`^https?://127\\.0\\.0\\.1:${localPort}`);
      let rewritten = location
        .replace(localLoopbackPattern, '/rstudio-direct')
        .replace(/^https?:\/\/[^/]+\/rstudio-direct/, '/rstudio-direct');

      if (rewritten.startsWith('/') && !rewritten.startsWith('/rstudio-direct')) {
        rewritten = '/rstudio-direct' + rewritten;
      }

      if (rewritten !== location) {
        proxyRes.headers['location'] = rewritten;
      }
    }
    onActivity();
  });

  return proxy;
}

/**
 * Create a JupyterLab proxy for a session
 */
function createJupyterProxy(sessionKey: string, localPort: number): Server {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    target: `http://127.0.0.1:${localPort}`,
    changeOrigin: true,
  });

  proxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
    log.proxyError('JupyterLab proxy error', { error: err.message, sessionKey });
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<h1>JupyterLab not available</h1><p><a href="/">Back to launcher</a></p>');
    }
  });

  proxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
    const originalUrl = (req as ProxiedRequest).originalUrl || req.url || '';

    if (originalUrl.startsWith('/jupyter-direct')) {
      proxyReq.path = originalUrl;
    } else if (originalUrl.startsWith('/jupyter')) {
      proxyReq.path = originalUrl.replace(/^\/jupyter/, '/jupyter-direct');
    }

    const token = getSessionToken('jupyter');
    const hasTokenInUrl = proxyReq.path.includes('token=');
    if (token && !hasTokenInUrl) {
      const separator = proxyReq.path.includes('?') ? '&' : '?';
      proxyReq.path = `${proxyReq.path}${separator}token=${token}`;
    }

    log.debugFor('jupyter', 'proxyReq', {
      sessionKey,
      method: req.method,
      url: req.url,
      path: proxyReq.path,
      hasSessionToken: !!token,
    });
  });

  proxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
    log.debugFor('jupyter', 'proxyRes', { sessionKey, status: proxyRes.statusCode, url: req.url });
    onActivity();
  });

  proxy.on('open', () => {
    log.debugFor('jupyter', 'proxy socket opened', { sessionKey });
    onActivity();
  });

  proxy.on('close', () => {
    log.debugFor('jupyter', 'proxy connection closed', { sessionKey });
  });

  return proxy;
}

/**
 * Create a port proxy for hpc-proxy (dev server routing)
 */
function createPortProxy(sessionKey: string, localPort: number): Server {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    target: `http://127.0.0.1:${localPort}`,
    changeOrigin: true,
  });

  proxy.on('error', (err: Error, req: http.IncomingMessage, res: http.ServerResponse | import('net').Socket) => {
    log.debugFor('port-proxy', 'proxy error', { error: err.message, sessionKey, url: req.url });
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Dev server unavailable. Is it running?');
    }
  });

  proxy.on('proxyReq', (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
    log.debugFor('port-proxy', 'proxyReq', {
      sessionKey,
      method: req.method,
      url: req.url,
      path: proxyReq.path,
    });
  });

  proxy.on('proxyRes', (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
    log.debugFor('port-proxy', 'proxyRes', { sessionKey, status: proxyRes.statusCode, url: req.url });
    onActivity();
  });

  proxy.on('open', () => {
    log.debugFor('port-proxy', 'proxy socket opened', { sessionKey });
    onActivity();
  });

  proxy.on('close', () => {
    log.debugFor('port-proxy', 'proxy connection closed', { sessionKey });
  });

  return proxy;
}

/**
 * Create a proxy for a session
 * @param sessionKey - Session key (user-hpc-ide)
 * @param ide - IDE type ('vscode', 'rstudio', 'jupyter', or 'port')
 * @returns The created proxy instance
 * @throws If session key not found in PortRegistry
 */
export function createSessionProxy(sessionKey: string, ide: 'vscode' | 'rstudio' | 'jupyter' | 'port'): Server {
  // The 'port' proxy targets the fixed hpc-proxy local port (config.hpcProxyLocalPort,
  // default 9000). It is forwarded as an extra SSH -L when VS Code launches with
  // options.proxyPort set. No PortRegistry entry is created for it, so we must not
  // look one up.
  const localPort = ide === 'port'
    ? config.hpcProxyLocalPort
    : PortRegistry.get(sessionKey);

  if (localPort === undefined) {
    throw new Error(`No port registered for session key: ${sessionKey}. Has the tunnel been started?`);
  }

  let proxy: Server;
  switch (ide) {
    case 'vscode':
      proxy = createVsCodeProxy(sessionKey, localPort);
      break;
    case 'rstudio':
      proxy = createRstudioProxy(sessionKey, localPort);
      break;
    case 'jupyter':
      proxy = createJupyterProxy(sessionKey, localPort);
      break;
    case 'port':
      proxy = createPortProxy(sessionKey, localPort);
      break;
    default:
      throw new Error(`Unknown IDE type: ${ide}`);
  }

  const sessionProxy: SessionProxy = {
    proxy,
    ide,
    port: localPort,
    sessionKey,
  };

  ProxyRegistry.set(sessionKey, sessionProxy);
  log.debugFor('proxy', `Created ${ide} proxy for session ${sessionKey}`, { port: localPort });
  return proxy;
}

/**
 * Get a proxy for a session
 * @param sessionKey - Session key (user-hpc-ide)
 * @returns The proxy instance or undefined if not found
 */
export function getProxy(sessionKey: string): Server | undefined {
  const sessionProxy = ProxyRegistry.get(sessionKey);
  if (!sessionProxy) {
    return undefined;
  }

  // Verify the proxy still targets the correct port
  // If the port changed (tunnel restarted), return undefined to force recreation
  const currentPort = PortRegistry.get(sessionKey);
  if (currentPort !== sessionProxy.port) {
    log.debugFor('proxy', `Port changed for ${sessionKey}, proxy stale`, {
      oldPort: sessionProxy.port,
      newPort: currentPort,
    });
    destroySessionProxy(sessionKey);
    return undefined;
  }

  return sessionProxy.proxy;
}

/**
 * Destroy and remove a proxy for a session
 * @param sessionKey - Session key (user-hpc-ide)
 */
export function destroySessionProxy(sessionKey: string): void {
  const sessionProxy = ProxyRegistry.get(sessionKey);
  if (!sessionProxy) {
    return;
  }

  const { proxy, ide, port } = sessionProxy;
  proxy.close();
  ProxyRegistry.delete(sessionKey);
  log.debugFor('proxy', `Destroyed ${ide} proxy for session ${sessionKey}`, { port });
}

/**
 * Destroy all proxies
 */
export function destroyAllProxies(): void {
  for (const [sessionKey, sessionProxy] of ProxyRegistry.entries()) {
    const { proxy, ide, port } = sessionProxy;
    proxy.close();
    log.debugFor('proxy', `Destroyed ${ide} proxy for session ${sessionKey}`, { port });
  }
  ProxyRegistry.clear();
}

// CommonJS compatibility for existing require() calls
module.exports = {
  ProxyRegistry,
  createSessionProxy,
  destroySessionProxy,
  getProxy,
  destroyAllProxies,
  setGetSessionToken,
  setOnActivity,
};
