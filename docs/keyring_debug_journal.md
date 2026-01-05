# Keyring Debug Journal: VS Code serve-web Credential Persistence

**Date**: 2026-01-05
**Issue**: GitHub Copilot credentials not persisting across page refreshes in VS Code serve-web
**Related Issues**: [vscode-rbioc#17](https://github.com/drejom/vscode-rbioc/issues/17), [omhq-hpc-code-server-stack#28](https://github.com/drejom/omhq-hpc-code-server-stack/issues/28)

## Executive Summary

After extensive debugging, we discovered that **VS Code `serve-web` uses browser-based secret storage, not server-side keyring storage**. This is a fundamental architectural difference from desktop VS Code. The gnome-keyring setup works correctly, but VS Code serve-web doesn't use it.

## Background

### The Problem
Users running VS Code via `code serve-web` in Singularity containers on HPC clusters lose their GitHub/Copilot authentication on every page refresh. They must re-authenticate repeatedly, which is disruptive to workflow.

### Initial Hypothesis
VS Code stores OAuth tokens in the OS keyring. In headless/container environments without a keyring daemon, tokens are lost. Solution: add gnome-keyring packages to the container and initialize the keyring daemon before VS Code starts.

## Implementation Steps

### Phase 1: Container Packages (vscode-rbioc)

Added to Dockerfile:
```dockerfile
# Keyring for VS Code token persistence (#17)
gnome-keyring libsecret-1-0 libsecret-tools dbus-x11 \
```

### Phase 2: Manager Integration (omhq-hpc-code-server-stack)

#### Environment Variables Added
```javascript
const singularityEnvArgs = [
  // ... other env vars ...
  '--env VSCODE_KEYRING_PASS=hpc-code-server',
  '--env GNOME_DESKTOP_SESSION_ID=this-triggers-gnome-keyring',
];
```

#### XDG Directory Setup
```bash
export XDG_RUNTIME_DIR=$HOME/.vscode-slurm/xdg-runtime
export XDG_DATA_HOME=$HOME/.vscode-slurm/xdg-data
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME/keyrings"
chmod 700 "$XDG_RUNTIME_DIR"
```

**Why custom XDG paths?** Singularity mounts `/run` as read-only, so we can't use the standard `/run/user/<uid>` location.

#### Keyring Initialization in Job Script
```bash
sh -c 'eval "$(dbus-launch --sh-syntax)" && \
       echo -n "$VSCODE_KEYRING_PASS" | gnome-keyring-daemon --unlock --components=secrets && \
       export GNOME_KEYRING_CONTROL=$XDG_RUNTIME_DIR/keyring && \
       exec code serve-web ...'
```

**Key learnings:**
- `gnome-keyring-daemon --unlock` does NOT output environment variables (unlike `--start`)
- Must manually set `GNOME_KEYRING_CONTROL=$XDG_RUNTIME_DIR/keyring`
- D-Bus session must be started first with `dbus-launch`

## Verification: Keyring Works Correctly

### Test Commands
```bash
# Set environment (adjust DBUS path per session)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-XXX,guid=...
export GNOME_KEYRING_CONTROL=$HOME/.vscode-slurm/xdg-runtime/keyring
export XDG_RUNTIME_DIR=$HOME/.vscode-slurm/xdg-runtime
export XDG_DATA_HOME=$HOME/.vscode-slurm/xdg-data

# Store a secret
echo -n "test-value" | secret-tool store --label="Test" service test account test

# Retrieve it
secret-tool lookup service test account test
# Output: test-value

# List all secrets
secret-tool search --all xdg:schema org.freedesktop.Secret.Generic
```

### Results
- Keyring daemon runs correctly (PID visible in `ps aux`)
- Secrets persist in `~/.vscode-slurm/xdg-data/keyrings/login.keyring`
- `secret-tool` can store/retrieve secrets successfully
- Secrets survive across SSH sessions (same job)

## The Discovery: VS Code serve-web Doesn't Use Server Keyring

### Evidence from Logs

Location: `~/.vscode-slurm/.vscode-server/data/logs/<timestamp>/exthost*/vscode.github-authentication/*.log`

```
14:14:28.005 [info] Storing 1 sessions...
14:14:28.096 [info] Reading sessions from keychain...
14:14:28.097 [info] Stored 1 sessions!
14:14:28.098 [info] Login success!
...
# User refreshes page ~1 minute later
...
14:15:43.181 [info] Reading sessions from keychain...
14:15:43.181 [info] Got 0 sessions for ...
```

VS Code claims to "store" sessions successfully, but they're gone after page refresh.

### Keyring Contents After Authentication
```bash
$ secret-tool search --all xdg:schema org.freedesktop.Secret.Generic

# Only test secrets - NO VS Code secrets!
[/org/freedesktop/secrets/collection/login/1]
label = Test
secret = test123
...
```

VS Code is NOT writing to the gnome-keyring at all.

## Root Cause Analysis

### Architecture Difference: Desktop vs serve-web

| Aspect | Desktop VS Code | serve-web |
|--------|-----------------|-----------|
| Runtime | Electron (Node + Chromium) | Browser + Node server |
| Secret Storage | Electron's `oscrypt` module | Browser `ISecretStorageProvider` |
| Backend | libsecret/keyring/Keychain | localStorage/IndexedDB |
| Persistence | OS keyring (survives restarts) | Browser storage (ephemeral) |

### How Desktop VS Code Stores Secrets
1. Uses Electron's `safeStorage` API
2. Encryption key stored in OS keyring via `oscrypt` module
3. On Linux: uses libsecret to access gnome-keyring/kwallet
4. Secrets encrypted and stored in keyring

### How serve-web Stores Secrets
1. Uses `ISecretStorageProvider` interface (browser-side)
2. Secrets stored in browser localStorage/IndexedDB
3. Server provides a key component for encryption (`getServerKeyPart()`)
4. On page refresh, browser context resets, secrets lost

### Configuration That Only Works for Desktop
- `--password-store=gnome-libsecret` flag (Electron only)
- `~/.vscode/argv.json` with `"password-store": "gnome-libsecret"` (desktop only)
- `GNOME_DESKTOP_SESSION_ID` environment variable (affects Electron's oscrypt)

**serve-web ignores all of these** because it doesn't use Electron's oscrypt module.

## Related VS Code Issues

### Issue #191861: Add `--github-auth` to serve-web
- Feature request to add GitHub auth persistence to serve-web
- Status: Partially implemented, still has issues
- The `--github-auth` flag exists but doesn't work reliably

### Issue #228036: secrets.provider lost on page reload
- Secrets lost when backend is offline during page load
- Fixed in October 2024 (PR #230560)
- Different issue from ours - this was about network disconnection

### Issue #238303: Settings not honored in serve-web
- serve-web doesn't support `--user-data-dir`, `--extensions-dir` flags
- Confirms serve-web has limited configuration support

## What We Tried

| Attempt | Result |
|---------|--------|
| Install gnome-keyring packages | Works (keyring functional) |
| Set `GNOME_DESKTOP_SESSION_ID` | No effect on serve-web |
| Set `GNOME_KEYRING_CONTROL` | Keyring accessible, VS Code ignores it |
| Custom `XDG_RUNTIME_DIR` | Works for keyring, VS Code ignores it |
| Update `~/.vscode/argv.json` | serve-web doesn't read it |
| Try `--password-store` flag | serve-web rejects the flag |

## Current State

### What Works
- Keyring infrastructure is fully functional
- D-Bus session properly initialized
- Secrets can be stored/retrieved via `secret-tool`
- Keyring persists across sessions
- All environment variables correctly set

### What Doesn't Work
- VS Code serve-web credential persistence
- This is a **fundamental architectural limitation** of serve-web

## Potential Alternatives

### 1. VS Code Tunnels (`code tunnel`)
- Uses desktop VS Code on the server
- Proper Electron-based secret storage
- Requires VS Code desktop installation
- Different architecture from serve-web

### 2. code-server (Coder's fork)
- May have different secret handling
- More configuration options
- Active development on enterprise features

### 3. GitHub Codespaces / gitpod
- Cloud-hosted dev environments
- Handle auth at platform level

### 4. Accept the Limitation
- Sessions persist while browser tab is open
- Re-auth required on page refresh
- May be acceptable for some workflows

## Environment Details

### Container
- Base: `bioconductor/bioconductor_docker:RELEASE_3_22`
- VS Code CLI: 1.107.1 (latest stable as of 2026-01-05)
- Packages: gnome-keyring, libsecret-1-0, libsecret-tools, dbus-x11

### HPC Environment
- Cluster: Gemini (also applies to Apollo)
- Container runtime: Singularity 3.7.0
- Filesystem: NFS with bind mounts

### Key Paths
```
Container:        /packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif
XDG_RUNTIME_DIR:  ~/.vscode-slurm/xdg-runtime
XDG_DATA_HOME:    ~/.vscode-slurm/xdg-data
Keyring file:     ~/.vscode-slurm/xdg-data/keyrings/login.keyring
Keyring socket:   ~/.vscode-slurm/xdg-runtime/keyring/control
VS Code data:     ~/.vscode-slurm/.vscode-server/
```

## Commits Related to This Investigation

### vscode-rbioc
- Added gnome-keyring packages to Dockerfile
- Updated README with keyring documentation
- Updated CHANGELOG for 3.22.0

### omhq-hpc-code-server-stack (dev branch)
- `569fdc6`: Fix GNOME_KEYRING_CONTROL not being set
- `83a7934`: Use VSCODE_KEYRING_PASS env var instead of hardcoded password
- `779c222`: Add GNOME_DESKTOP_SESSION_ID to trigger gnome-libsecret backend

## Conclusion

The gnome-keyring implementation is correct and functional. The issue is that **VS Code serve-web has a fundamentally different architecture** that stores secrets in the browser, not on the server. This is not a configuration issue but an architectural limitation of the serve-web command.

To achieve persistent GitHub/Copilot authentication, we need to consider alternative approaches like VS Code tunnels or accept the limitation of serve-web.

## References

- [VS Code Secret Storage Discussion #748](https://github.com/microsoft/vscode-discussions/discussions/748)
- [VS Code Issue #187338: OS keyring not identified](https://github.com/microsoft/vscode/issues/187338)
- [VS Code Issue #191861: Add --github-auth to serve-web](https://github.com/microsoft/vscode/issues/191861)
- [VS Code Issue #228036: secrets.provider lost on reload](https://github.com/microsoft/vscode/issues/228036)
- [VS Code Issue #238303: Settings not honored in serve-web](https://github.com/microsoft/vscode/issues/238303)
- [GNOME Keyring - ArchWiki](https://wiki.archlinux.org/title/GNOME/Keyring)
