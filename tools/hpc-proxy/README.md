# HPC Proxy

Per-user reverse proxy for multi-user HPC environments. Routes `/port/:port/*` requests to `localhost:port`, allowing multiple users to run development servers on the same compute node without port conflicts.

## Problem Solved

In shared HPC environments, multiple users may run development servers (Live Server, Shiny, etc.) on fixed ports. When two users on the same node both start Live Server on port 5500, the second user gets "Address in use".

HPC Proxy solves this by:
1. Each user runs their own hpc-proxy on a unique port
2. Only ONE port (the proxy port) is tunneled back to the manager
3. The proxy routes `/port/5500/*` → `localhost:5500`, `/port/3838/*` → `localhost:3838`, etc.
4. Users can run any local service on any port - just access it via `/port/:port/`

## Usage

```bash
# Basic usage (auto-assigns port, writes to ~/.hpc-proxy/port)
hpc-proxy --port 0

# Specific port
hpc-proxy --port 9001

# With base tag injection for relative URL handling
hpc-proxy --port 9001 --base-rewrite

# Custom port file location
hpc-proxy --port 0 --port-file /tmp/my-proxy-port

# Verbose logging
hpc-proxy --port 0 --verbose
```

## Route Pattern

All requests matching `/port/:port/*` are proxied to `localhost:port`:

| Request | Proxied To |
|---------|------------|
| `/port/5500/index.html` | `localhost:5500/index.html` |
| `/port/3838/` | `localhost:3838/` |
| `/port/8080/api/users` | `localhost:8080/api/users` |

## Features

- **Dynamic port routing**: Any port works without configuration
- **WebSocket support**: Full WebSocket proxying for Shiny, browser-sync, etc.
- **Base tag injection**: Optional `--base-rewrite` flag injects `<base href="/port/:port/">` into HTML responses
- **Auto port assignment**: Use `--port 0` to let the OS assign a free port
- **Port file**: Writes actual port to `~/.hpc-proxy/port` for discovery

## Building

```bash
# Build for current platform
make build

# Cross-compile for Linux (HPC clusters)
make build-linux

# Clean
make clean
```

## Integration

### SLURM Job Script

```bash
# Start proxy (auto-assigns port and writes to ~/.hpc-proxy/port)
~/bin/hpc-proxy --port 0 &
```

### Manager Tunnel

The manager reads `~/.hpc-proxy/port` to discover the proxy port, then tunnels only that single port instead of multiple service ports.

## Architecture

```
Manager                          HPC Node (User A)
├── /port/5500/* ─────┐
├── /port/3838/* ─────┼── tunnel ←── hpc-proxy :9001 ←── /port/:port/* → localhost:port
├── /port/8080/* ─────┘

                                 HPC Node (User B)
├── /port/5500/* ─────┬── tunnel ←── hpc-proxy :9002 ←── /port/:port/* → localhost:port
├── /port/3838/* ─────┘
```
