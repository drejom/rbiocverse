# hpc-proxy Integration Plan

## Problem Statement

When multiple users run development servers on the same HPC compute node, they conflict on fixed ports:
- User A starts Live Server on port 5500
- User B (same node) tries to start Live Server on port 5500 → "Address in use"

## Solution: hpc-proxy

A per-user reverse proxy running on the compute node:
- Listens on ONE dynamically-allocated port per user
- Routes `/port/:port/*` → `localhost:port`
- Only the proxy port gets tunneled back to manager

```
Current (fixed ports):
Browser → Manager → Tunnel(5500) → Node:5500 (Live Server)
         ↓
Problem: Two users on same node both want port 5500

With hpc-proxy:
Browser → Manager → /port/5500/* → Tunnel(proxyPort) → hpc-proxy → localhost:5500
         ↓
User A: proxyPort=9001 → hpc-proxy routes /port/5500/* → localhost:5500
User B: proxyPort=9002 → hpc-proxy routes /port/5500/* → localhost:5500 (different process)
```

## What hpc-proxy is NOT

**hpc-proxy does NOT solve multi-user IDE tunnel routing.**

That's a separate problem:
- Currently: VS Code uses fixed local port 8000 on manager
- Only ONE user can have an active VS Code tunnel at a time
- Solution: Dynamic local port allocation per user (see `multi_user_review.md`)

## Scope: VS Code Only

- **VS Code**: Needs hpc-proxy (no built-in port proxy)
- **JupyterLab**: Has `jupyter-server-proxy` built-in (`/proxy/:port/`)
- **RStudio**: Has built-in proxy for Shiny apps

## Implementation Tasks

### Phase 1: SLURM Script (VS Code only)

Modify `buildVscodeScript()` in `services/hpc.ts`:

```bash
# Before VS Code starts:

# Start hpc-proxy on dynamic port
mkdir -p ~/.hpc-proxy
/usr/local/bin/hpc-proxy --port 0 --verbose &
HPC_PROXY_PID=$!

# Wait for proxy to write port file
for i in {1..10}; do
  [ -f ~/.hpc-proxy/port ] && break
  sleep 0.5
done

# Read proxy port for tunnel discovery
HPC_PROXY_PORT=$(cat ~/.hpc-proxy/port 2>/dev/null || echo "")
```

### Phase 2: Manager - Read Proxy Port

Add to `services/hpc.ts`:

```typescript
async getProxyPort(user: string | null): Promise<number | null> {
  const portFile = '~/.hpc-proxy/port';
  try {
    const output = await this.sshExec(`cat ${portFile} 2>/dev/null`, user);
    const port = parseInt(output.trim(), 10);
    if (port > 0 && port < 65536) {
      return port;
    }
  } catch (e) {
    // No proxy running
  }
  return null;
}
```

### Phase 3: Manager - Tunnel Proxy Port

Modify `services/tunnel.ts`:
- Instead of forwarding `additionalPorts` (5500, 3838, etc.)
- Forward the single proxy port

```typescript
// For VS Code, forward proxy port instead of individual dev server ports
if (ide === 'vscode' && proxyPort) {
  portForwards.push('-L', `${PROXY_LOCAL_PORT}:${node}:${proxyPort}`);
}
```

### Phase 4: Manager - Route `/port/:port/*`

Add proxy route in `server.ts`:

```typescript
// Route /port/:port/* through hpc-proxy
app.use('/port/:port/*', (req, res) => {
  const targetPort = parseInt(req.params.port, 10);
  // Forward to tunneled hpc-proxy
  portProxy.web(req, res, {
    target: `http://127.0.0.1:${PROXY_LOCAL_PORT}`,
    // Path rewriting handled by hpc-proxy
  });
});
```

### Phase 5: WebSocket Support

Handle WebSocket upgrades for `/port/:port/*`:

```typescript
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/port/')) {
    portProxy.ws(req, socket, head, {
      target: `http://127.0.0.1:${PROXY_LOCAL_PORT}`,
    });
  }
  // ... existing IDE WebSocket handling
});
```

## Configuration

New environment variable:
```
HPC_PROXY_LOCAL_PORT=9000  # Local port for hpc-proxy tunnel (default: 9000)
```

## Testing Plan

1. Start VS Code session
2. Verify hpc-proxy starts and port file is written
3. Verify proxy port is tunneled
4. Start Live Server in VS Code (port 5500)
5. Access `/port/5500/` - should show Live Server content
6. Test WebSocket (browser-sync live reload)
7. Test two users on same node - both should work independently

## Files to Modify

| File | Change |
|------|--------|
| `services/hpc.ts` | Add hpc-proxy startup to VS Code script |
| `services/hpc.ts` | Add `getProxyPort()` method |
| `services/tunnel.ts` | Forward proxy port instead of additionalPorts |
| `server.ts` | Add `/port/:port/*` proxy route |
| `config/index.ts` | Add `hpcProxyLocalPort` config |

## Future Work (Out of Scope)

- Multi-user IDE tunnel routing (dynamic local ports per user)
- Integration with RStudio/JupyterLab (they have built-in proxies)
