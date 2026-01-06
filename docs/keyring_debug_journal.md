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

## New Finding: serve-web DOES Have Secret Storage (PR #191538)

**Update**: Further investigation revealed that serve-web actually **does** have a secret storage mechanism, added in [PR #191538](https://github.com/microsoft/vscode/pull/191538) (August 2023).

### How serve-web Secret Storage Works

The implementation uses a **two-part encryption key system**:

1. **Client-side**: Stores an encryption key in browser localStorage
2. **Server-side**: Maintains a key and issues an HTTP-only cookie to the client
3. **Combined**: Client requests server to merge keys, then encrypts/decrypts secrets

The key endpoint is `/_vscode-cli/mint-key`:
- Called via POST with `credentials: 'include'`
- Returns server key as ArrayBuffer
- XORed with client's AES-GCM 256-bit key

### Related Issue: server-base-path Bug (#212369)

There was a bug where `SECRET_KEY_MINT_PATH` didn't honor `--server-base-path`:
- We use `--server-base-path /vscode-direct`
- The mint-key endpoint wasn't including this prefix
- **Fixed in PR #214250** (June 2024, VS Code ~1.91)

Our VS Code 1.107.1 should have this fix, but we need to verify:
1. Is the `/_vscode-cli/mint-key` endpoint being called?
2. Are the cookies (`vscode-secret-key-path`, `vscode-cli-secret-half`) being set?
3. Is the proxy correctly passing these cookies?

### Proxy Cookie Handling

The manager's proxy (`server.js`) already handles VS Code secret cookies:

```javascript
// On 403, clears secret cookies
res.setHeader('Set-Cookie', [
  'vscode-tkn=; Path=/; Expires=...',
  'vscode-secret-key-path=; Path=/; Expires=...',
  'vscode-cli-secret-half=; Path=/; Expires=...',
]);

// Rewrites Set-Cookie headers for proxy
proxyRes.headers['set-cookie'] = setCookies.map(cookie => {
  return cookie
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*Path=[^;]*/gi, '; Path=/');
});
```

### Next Steps to Investigate

1. Use browser DevTools to check:
   - Network tab: Look for `mint-key` or `_vscode-cli` requests
   - Application tab → Cookies: Check for `vscode-secret-key-path`

2. Check if the mint-key endpoint is accessible through the proxy

3. Verify cookie path/domain settings are correct for our setup

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
| Try `--password-store` flag | serve-web rejects the flag (Electron-only) |
| Bind writable `/run` directory | No effect - serve-web uses browser storage |
| Create `/run/user/<uid>` with 700 perms | Fixes socket errors but not secret persistence |

## Detailed Investigation of Browser Secret Storage

### Verified Working Components
1. **`/_vscode-cli/mint-key` endpoint** - Called successfully, returns 200
2. **Cookies are set correctly**:
   - `vscode-secret-key-path`: Points to mint-key endpoint
   - `vscode-cli-secret-half`: Server's key half (httpOnly, persists across refresh)
   - `vscode-tkn`: Connection token
3. **Cookie values persist** - Same `vscode-cli-secret-half` value before and after refresh
4. **Server logs show "Stored 1 sessions!"** - Login succeeds

### What Fails
1. **After page refresh, "Got 0 sessions"** - Secrets are lost
2. **`secrets.provider` in localStorage** - Present during session, behavior unclear on refresh
3. **New extension host process** - Each refresh spawns new exthost, can't read previous secrets

### The Actual Problem
The two-part encryption key system (PR #191538) stores:
- Server half: In httpOnly cookie (works, persists)
- Client half: In browser localStorage (supposed to persist)
- Combined key: Used to encrypt/decrypt secrets

Even though cookies persist, something in the client-side key handling or
secret decryption fails on page reload. This may be a VS Code bug or a
subtle interaction with our proxy setup.

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
- `b890fa2`: Revert keyring init - was breaking VS Code startup (sh -c wrapper failed silently)
- `f2bcf56`: Bind writable /run directory for VS Code sockets
- `5bc4264`: Remove invalid --password-store flag (Electron-only, broke serve-web)
- `9606f3f`: Add --cli-data-dir to isolate serve-web key storage

## Deep Dive: Playwright Testing of Secret Storage (2026-01-05)

### Test Setup
Created Playwright scripts to automate testing of the secret storage mechanism:
- `test-proxy-cookies.mjs` - Test cookie handling through proxy
- `test-mint-key-direct.mjs` - Direct calls to mint-key endpoint

### Verified Working Components

1. **mint-key endpoint responds correctly**:
   ```
   POST /vscode-direct/_vscode-cli/mint-key → 200 OK
   Body: 44 bytes (32-byte key, base64 encoded)
   ```

2. **All cookies are set and persist across refresh**:
   ```
   vscode-tkn: [token] (path=/vscode-direct, httpOnly=false)
   vscode-secret-key-path: /vscode-direct/_vscode-cli/mint-key (path=/, httpOnly=false)
   vscode-cli-secret-half: [server-key] (path=/, httpOnly=true)
   ```

3. **Server-side key file exists** (after adding `--cli-data-dir`):
   ```
   ~/.vscode-slurm/.vscode-server/cli/serve-web-key-half
   ```

4. **Proxy cookie rewriting works**:
   - Domain stripped correctly
   - Path changed to `/` for all cookies

### The Root Cause: `secrets.provider` Not in localStorage

**Critical finding**: After login, `localStorage['secrets.provider']` is **empty**.

```javascript
// Expected: secrets.provider should contain encrypted secrets
localStorage.getItem('secrets.provider')  // Returns: null

// What IS in localStorage:
// - profileAssociations
// - userDataProfiles
// - DefaultOverridesCacheExists
// - monaco-parts-splash
```

VS Code's browser secret storage is supposed to:
1. Get server key via POST to `/_vscode-cli/mint-key`
2. Generate client-side AES-GCM 256-bit key
3. XOR server + client keys to create encryption key
4. Encrypt secrets and store in `localStorage['secrets.provider']`

**Step 4 is not happening** - secrets are never written to localStorage.

### Hypothesis: Why secrets.provider is Empty

Possible causes under investigation:
1. **Client-side key generation fails** - WebCrypto API issue?
2. **Key XOR operation fails** - Server key format mismatch?
3. **Encryption fails silently** - AES-GCM error not surfaced?
4. **localStorage write blocked** - Storage quota or permissions?
5. **Proxy interfering with response** - Body or headers modified?

### What We Ruled Out

| Component | Status | Evidence |
|-----------|--------|----------|
| mint-key endpoint | ✅ Working | Returns 200 with 44-byte body |
| Cookie persistence | ✅ Working | Same vscode-cli-secret-half before/after refresh |
| Server key file | ✅ Working | serve-web-key-half exists in --cli-data-dir |
| Proxy cookie rewrite | ✅ Working | Cookies have correct path=/ |
| VS Code auth logs | ✅ Shows login success | "Stored 1 sessions!", "Login success!" |

### Updated What We Tried Table

| Attempt | Result |
|---------|--------|
| Install gnome-keyring packages | Works (keyring functional) |
| Set `GNOME_DESKTOP_SESSION_ID` | No effect on serve-web |
| Set `GNOME_KEYRING_CONTROL` | Keyring accessible, VS Code ignores it |
| Custom `XDG_RUNTIME_DIR` | Works for keyring, VS Code ignores it |
| Update `~/.vscode/argv.json` | serve-web doesn't read it |
| Try `--password-store` flag | serve-web rejects the flag (Electron-only) |
| Bind writable `/run` directory | Fixes socket errors, not secrets |
| Add `--cli-data-dir` | Isolates key storage, doesn't fix secrets |
| Verify mint-key via Playwright | Endpoint works, cookies set correctly |
| Check localStorage | **secrets.provider is EMPTY** |

## How code-server (Coder) Solved This Problem

### Background

code-server (maintained by Coder) initially had the same credential persistence issues. They solved it in [PR #6450](https://github.com/coder/code-server/pull/6450) by implementing the mint-key endpoint and patching VS Code.

### Their Solution

1. **Created a `/mint-key` endpoint** in their Express router (`src/node/routes/vscode.ts`):
   ```typescript
   private mintKey: express.Handler = async (req, res, next) => {
     if (!this.mintKeyPromise) {
       this.mintKeyPromise = new Promise(async (resolve) => {
         const keyPath = path.join(req.args["user-data-dir"], "serve-web-key-half")
         const key = crypto.randomBytes(32)
         await fs.writeFile(keyPath, key)
         resolve(key)
       })
     }
     const key = await this.mintKeyPromise
     res.end(key)
   }
   ```

2. **Patched VS Code's `base-path.diff`** to:
   - Generate the secret key path from `window.location.pathname + "/mint-key"` (avoiding cookie issues)
   - Enable `ServerKeyedAESCrypto` instead of falling back to `TransparentCrypto`

### Key Difference from Our Setup

- **code-server patches the VS Code source** to hardcode the mint-key path directly
- **Official `serve-web`** relies on the `vscode-secret-key-path` cookie to tell the browser where the mint-key endpoint is

### Related Issues

- [code-server #5072](https://github.com/coder/code-server/issues/5072#issuecomment-1703762507): GitHub login session lost after restart
  - Root cause: "Switching to using in-memory credential store instead because Keytar failed to load"
  - Workaround: D-Bus session with gnome-keyring: `dbus-run-session sh -c 'echo pass | gnome-keyring-daemon --unlock --replace ; code-server'`
  - Note: This only works for code-server, not for official `serve-web`

- [code-server #6395](https://github.com/coder/code-server/issues/6395): SecretStorage not retrieving values
  - Fixed in PR #6450 by implementing the mint-key endpoint

### VS Code workbench.ts Logic

The secret storage provider is conditionally configured in `src/vs/code/browser/workbench/workbench.ts`:

```javascript
// Simplified logic:
if (secretStorageKeyPath && crypto.subtle) {
  // Use ServerKeyedAESCrypto with browser localStorage
  secretStorageCrypto = new ServerKeyedAESCrypto(secretStorageKeyPath)
} else {
  // Fall back to TransparentCrypto (unencrypted)
  secretStorageCrypto = new TransparentCrypto()
}

// For remote authority without embedder storage:
secretStorageProvider = config.remoteAuthority && !secretStorageKeyPath
  ? undefined  // Use remote storage
  : new LocalStorageSecretStorageProvider(secretStorageCrypto)
```

### Our Current Verification Status

All components appear to be working correctly:

| Component | Status | Value |
|-----------|--------|-------|
| `vscode-secret-key-path` cookie | ✅ Set | `/vscode-direct/_vscode-cli/mint-key` |
| mint-key endpoint | ✅ Working | Returns 200 with 32-byte key |
| `vscode-cli-secret-half` cookie | ✅ Set | httpOnly, persists |
| WebCrypto available | ✅ Yes | `crypto.subtle.generateKey` exists |
| Server key file | ✅ Exists | `~/.vscode-slurm/.vscode-server/cli/serve-web-key-half` |

**Yet `localStorage['secrets.provider']` remains empty.**

### Possible Remaining Causes

1. **remoteAuthority condition**: VS Code may be detecting `remoteAuthority` and using remote storage instead of localStorage
2. **Timing issue**: Secret storage initialization may fail silently during workbench startup
3. **Frame/origin mismatch**: Secrets stored in wrong frame/origin context
4. **VS Code bug**: Similar to [Issue #228036](https://github.com/microsoft/vscode/issues/228036) but different trigger

### Next Steps to Investigate

1. Check if VS Code is detecting `remoteAuthority` (would skip localStorage)
2. Add console logging to VS Code's secret storage initialization
3. Try disabling the proxy wrapper (direct access to vscode-direct)
4. Test with a fresh browser profile

### Additional Testing Results (2026-01-05 late session)

#### Cookie Accessibility Verification
Tested `document.cookie` access from VS Code frames:

| Frame | Has vscode-secret-key-path | Notes |
|-------|---------------------------|-------|
| `/code/` | ✅ Yes | Wrapper frame |
| `/vscode-direct` | ✅ Yes | Main VS Code frame |
| `/vscode-direct/stable-xxx/static/...` | ✅ Yes | Workbench frame |
| `vscode-cdn.net/...` | ❌ No | CDN frames (different domain) |

The cookie is accessible from all `test-hpc.omeally.com` frames, including the main workbench frame where secret storage is initialized.

#### workbench.ts Logic Analysis

From VS Code source (`src/vs/code/browser/workbench/workbench.ts`):

```javascript
// 1. Read secret key path from cookie
const secretStorageKeyPath = readCookie('vscode-secret-key-path');

// 2. Choose crypto provider
const secretStorageCrypto = secretStorageKeyPath && ServerKeyedAESCrypto.supported()
    ? new ServerKeyedAESCrypto(secretStorageKeyPath)  // Uses mint-key endpoint
    : new TransparentCrypto();  // Unencrypted fallback

// 3. Choose storage provider
secretStorageProvider: config.remoteAuthority && !secretStorageKeyPath
    ? undefined  // Delegate to remote storage
    : new LocalStorageSecretStorageProvider(secretStorageCrypto)
```

**Expected behavior with our setup:**
- `secretStorageKeyPath` = `/vscode-direct/_vscode-cli/mint-key` (from cookie) ✓
- `ServerKeyedAESCrypto.supported()` = true (crypto.subtle exists) ✓
- `config.remoteAuthority` = defined (remote connection) ✓
- Since `secretStorageKeyPath` exists → should use `LocalStorageSecretStorageProvider` ✓

**Yet secrets are not being stored in localStorage.**

#### Server-Side Logs
Checked VS Code server logs - no secret storage messages logged. This is expected because with `serve-web`, secret storage initialization happens in the browser, not on the server.

#### Critical Discovery: No mint-key Requests

**Playwright instrumentation revealed:**
- Total mint-key requests during VS Code load: **0**
- No AES-GCM crypto operations (only AES-CBC for unrelated operations)
- `localStorage.getItem('secrets.provider')` returns `null` immediately

**Yet all prerequisites appear to be met:**
- Cookie `vscode-secret-key-path` is set to `/vscode-direct/_vscode-cli/mint-key`
- Cookie is accessible via `document.cookie` in the VS Code frame
- `crypto.subtle` is available
- `readCookie('vscode-secret-key-path')` returns the correct value

**The problem:** VS Code is NOT calling the mint-key endpoint despite having the cookie!

#### How code-server Solved This

Examined [code-server's `base-path.diff`](https://github.com/coder/code-server/blob/main/patches/base-path.diff) patch:

**VS Code original (`workbench.ts`):**
```javascript
const secretStorageKeyPath = readCookie('vscode-secret-key-path');
const secretStorageCrypto = secretStorageKeyPath && ServerKeyedAESCrypto.supported()
    ? new ServerKeyedAESCrypto(secretStorageKeyPath) : new TransparentCrypto();
```

**code-server patched:**
```javascript
const secretStorageKeyPath = (window.location.pathname + "/mint-key").replace(/\/\/+/g, "/");
const secretStorageCrypto = secretStorageKeyPath && ServerKeyedAESCrypto.supported()
    ? new ServerKeyedAESCrypto(secretStorageKeyPath) : new TransparentCrypto();
```

**Key difference:** code-server **bypasses the cookie entirely** and constructs the mint-key path from `window.location.pathname`. This avoids any issues with cookie timing, path mismatches, or cookie reading.

#### Frame Analysis

| Frame | Has Cookie | `readCookie()` Works | Notes |
|-------|-----------|---------------------|-------|
| `/vscode-direct` | ✅ | ✅ | Main frame, cookie accessible |
| `/vscode-direct/stable-xxx/.../worker.html` | ✅ | ✅ | Worker frame |
| `vscode-cdn.net/...` | ❌ | ❌ | CDN frames have no cookies (different domain) |

The cookie IS being set and IS readable. The issue must be in VS Code's workbench.ts logic itself.

#### Possible Root Causes (Still Investigating)

1. **~~Silent failure in ServerKeyedAESCrypto~~**: Ruled out - mint-key never called
2. **Timing issue**: Cookie may not be set when workbench.ts reads it (investigating)
3. **remoteAuthority condition**: VS Code may be delegating to remote storage
4. **VS Code bug in cookie reading**: The `readCookie` function may behave differently
5. **workbench.js initialization order**: Cookie may arrive after workbench config is set

### Debug Strategy and Next Steps

**Current approach:** Using Playwright to instrument VS Code's browser-side behavior:
1. ✅ Verified cookies are set correctly via Playwright context
2. ✅ Verified cookies are accessible via `document.cookie` in VS Code frames
3. ✅ Verified `crypto.subtle` is available
4. ✅ Confirmed 0 mint-key requests are being made
5. ✅ Intercepted `workbench.js` - cookie IS available at script start
6. ✅ Found the minified secret storage initialization code

### workbench.js Deep Analysis (2026-01-05)

**Intercepted workbench.js** (12.7 MB minified) and found the relevant code:

**Minified secret storage initialization:**
```javascript
// Reading the cookie (minified as a0n):
const s = a0n("vscode-secret-key-path");

// Creating crypto provider (FFi = ServerKeyedAESCrypto, n0n = TransparentCrypto):
const n = s && FFi.supported() ? new FFi(s) : new n0n;

// secretStorageProvider decision (OFi = LocalStorageSecretStorageProvider):
secretStorageProvider: t.remoteAuthority && !s ? void 0 : new OFi(n)
```

**Key finding:** The cookie IS being read correctly (confirmed via console logging), but:
- `FFi` (ServerKeyedAESCrypto) is available
- `n0n` (TransparentCrypto) is the fallback
- The decision logic is: `remoteAuthority && !s ? undefined : LocalStorageSecretStorageProvider`

**If `s` (secretStorageKeyPath) is truthy:**
- Should use `LocalStorageSecretStorageProvider` with `ServerKeyedAESCrypto`
- But NO mint-key requests are being made!

**This means:** Even though the cookie is set and readable, something is preventing `ServerKeyedAESCrypto` from calling the mint-key endpoint.

### Timing Confirmed: Cookie Available at workbench.js Start

```
[DEEP DEBUG] Workbench.js executing
[DEEP DEBUG] document.cookie: vscode-tkn=...; vscode-secret-key-path=/vscode-direct/_vscode-cli/mint-key; ...
[DEEP DEBUG] vscode-secret-key-path: /vscode-direct/_vscode-cli/mint-key
[DEEP DEBUG] crypto.subtle available: true
```

**Conclusion from this test:** Timing is NOT the issue. The cookie is present when workbench.js starts.

### CRITICAL DISCOVERY: mint-key IS Called, But Lazily! (2026-01-05)

**Breakthrough finding from `debug-secret-store.mjs`:**

The mint-key endpoint IS being called successfully - but it's **lazy/deferred**. It only fires when a secret is actually stored, which happens approximately **10+ seconds after page load**.

**Console output showing the lazy call:**
```
--- State After Load ---
secrets.provider: NOT SET      # <-- After 5 seconds, still empty

--- Waiting 10 more seconds ---
[SECRET STORE DEBUG] Fetch #250: POST /vscode-direct/_vscode-cli/mint-key   # <-- CALLED!
[NETWORK] POST https://test-hpc.omeally.com/vscode-direct/_vscode-cli/mint-key
[SECRET STORE DEBUG] crypto.subtle.encrypt called
[SECRET STORE DEBUG] Algorithm: AES-GCM
[SECRET STORE DEBUG] Encryption succeeded, length: 155
[SECRET STORE DEBUG] localStorage.setItem: secrets.provider length: 268
secrets.provider after wait: IoPqMKgPFeZx...   # <-- NOW SET!
```

**Timeline of secret storage initialization:**
1. Page loads, workbench.js runs
2. `ServerKeyedAESCrypto` is instantiated with the cookie value
3. **No mint-key call yet** - crypto object is lazy
4. ~10 seconds later, GitHub auth extension stores a secret
5. `ServerKeyedAESCrypto.getServerKeyPart()` is called
6. mint-key POST request fires, returns server key
7. Keys are XOR'd, AES-GCM encryption succeeds
8. Encrypted secret written to `localStorage['secrets.provider']`

**This changes everything!** The system IS working correctly. The issue must be in:
1. **Secret retrieval on page refresh** - decryption may be failing
2. **Cookie persistence** - httpOnly `vscode-cli-secret-half` may not persist
3. **Key mismatch** - server key file may change between sessions

### Verification of All Working Components

| Component | Status | Evidence |
|-----------|--------|----------|
| Cookie reading | ✅ Working | Cookie available when workbench.js starts |
| `FFi.supported()` | ✅ True | Test key generation succeeds |
| `isSecureContext` | ✅ True | Required for crypto.subtle |
| `crypto.subtle.generateKey` | ✅ Working | AES-GCM 256-bit key succeeds |
| `ServerKeyedAESCrypto` instantiation | ✅ Working | No errors |
| mint-key endpoint | ✅ Working | POST returns 200, 44 bytes |
| AES-GCM encryption | ✅ Working | 155-byte encrypted result |
| localStorage write | ✅ Working | `secrets.provider` length: 268 |

### Crypto Operations Observed

During page load:
- `crypto.subtle.decrypt` with AES-CBC (5x) - used for other VS Code operations
- **No AES-GCM until secret is stored** - confirms lazy initialization

During secret storage (~10s after load):
- `crypto.subtle.encrypt` with AES-GCM (1x) - encrypts the secret

### Next Investigation: Why Secrets Don't Persist Across Refresh

Now that we know secrets ARE being stored correctly, the question becomes:
**Why do they disappear after page refresh?**

Hypotheses to test:
1. **Server key changes on restart** - `serve-web-key-half` file regenerated?
2. **httpOnly cookie `vscode-cli-secret-half` lost** - Browser not persisting?
3. **Decryption fails silently** - Key mismatch causes silent failure?
4. **localStorage cleared on refresh** - Browser storage issue?
5. **Different origin on reload** - Cookie/storage scoped differently?

### Debug Scripts Created

All in `/tmp/`:
- `debug-secret-store.mjs` - **KEY SCRIPT** - monitors all secret operations, found the lazy mint-key call
- `debug-ffi-supported.mjs` - Verifies crypto.subtle and FFi.supported()
- `debug-workbench-timing.mjs` - Confirms cookie present at workbench.js start
- `debug-workbench-deep.mjs` - Pattern analysis of minified workbench.js
- `debug-refresh-persistence.mjs` - **CRITICAL** - tests secret persistence across refresh

### BREAKTHROUGH: Secrets DO Persist in Playwright! (2026-01-05)

**`debug-refresh-persistence.mjs` revealed that secret storage WORKS correctly in Playwright:**

```
========== FIRST LOAD ==========
After 5s - secrets.provider: NOT SET
[mint-key fetch: POST /vscode-direct/_vscode-cli/mint-key → 200]
[localStorage.setItem(secrets.provider), length: 268]
After 20s total - secrets.provider: length=268

========== PAGE REFRESH ==========
[localStorage.getItem(secrets.provider): length=268]      <-- PRESERVED!
[mint-key fetch: POST /vscode-direct/_vscode-cli/mint-key → 200]
[crypto.subtle.decrypt, algo: AES-GCM → SUCCESS, length: 139]  <-- DECRYPTED!

--- Comparison ---
secrets.provider preserved: YES (same)
Cookies match: YES
```

**What this proves:**
1. ✅ `localStorage['secrets.provider']` persists across page refresh
2. ✅ Cookies persist correctly
3. ✅ mint-key endpoint returns the same key
4. ✅ AES-GCM decryption succeeds (139 bytes decrypted)
5. ✅ The secret storage system IS working correctly

**The mystery deepens:** If the system works in Playwright, why doesn't it work in the real browser?

### Hypotheses for Real-World Failure

Since Playwright tests pass, the issue must be environmental:

1. **Server restarts between sessions**
   - SLURM job restarts → new `serve-web-key-half` file → old secrets can't decrypt
   - User closes tab, job ends, job restarts → key mismatch

2. **Cookie domain/path mismatch in real browser**
   - Playwright ignores HTTPS errors, sets up context differently
   - Real browser may not receive httpOnly cookie correctly

3. **Different browser storage partitioning**
   - Modern browsers partition localStorage by origin
   - Proxy path differences may cause storage isolation

4. **Extension host process boundaries**
   - GitHub auth runs in extension host
   - May have different localStorage context than main workbench

5. **Browser "refresh" vs "navigate back to URL"**
   - Users may be typing URL or clicking link, not F5 refresh
   - Different navigation types may behave differently

### Key Observation: Server Key Stability

In Playwright, the **same Playwright session** means:
- Same serve-web process running throughout
- Same `serve-web-key-half` file
- Same server key returned by mint-key

In real world:
- User closes browser tab → may end SLURM job
- Job restarts → **new serve-web process** → **new key file**
- Old encrypted secrets can't be decrypted with new key

**This is likely the root cause!**

### Verification Completed (2026-01-05)

**Server key file DOES persist across restarts:**
```rust
// From VS Code CLI serve_web.rs:
fn get_server_key_half(paths: &LauncherPaths) -> SecretKeyPart {
    let ps = PersistedState::new(paths.root().join("serve-web-key-half"));
    let value: String = ps.load();
    if let Ok(sk) = SecretKeyPart::decode(&value) {
        return sk;  // <-- READS EXISTING KEY IF PRESENT
    }
    // Only generates new key if load fails
    let key = SecretKeyPart::new();
    let _ = ps.save(key.encode());
    key
}
```

**Playwright tests confirm the system works:**
```
========== PAGE REFRESH (F5) ==========
Cookies after refresh: all present, same values
secrets.provider after refresh: length=268 ✓

========== CLOSE TAB & OPEN NEW ==========
Cookies in new tab: all present, same values
secrets.provider in new tab: length=268 ✓
```

Both F5 refresh AND close-tab/open-new work correctly in Playwright.

### ROOT CAUSE FOUND: vscode-wrapper.js Clears localStorage! (2026-01-05)

**The bug is in our own code!**

`vscode-wrapper.js` (the wrapper page at `/code/`) calls `localStorage.clear()` on every page load:

```javascript
// From vscode-wrapper.js analysis:
*** FOUND: localStorage.clear ***
*** FOUND: .clear() calls ***
  Match 0:       localStorage.clear();
  Match 1:       sessionStorage.clear();
```

**Console output during reload shows:**
```
[CONSOLE] [WRAPPER.JS START] secrets.provider: EXISTS
[CONSOLE] [WRAPPER.JS] *** localStorage.clear() CALLED ***
... later scripts see secrets.provider as NULL
```

**This is why:**
1. User authenticates → secrets stored in `localStorage['secrets.provider']`
2. User refreshes → `/code/` wrapper loads
3. `vscode-wrapper.js` runs and calls `localStorage.clear()`
4. All secrets are wiped
5. VS Code iframe loads → sees empty `secrets.provider` → user logged out

**The VS Code secret storage system works correctly!** The issue is our wrapper clearing localStorage on every load.

### The Fix (Applied 2026-01-05)

**File:** `manager/public/js/vscode-wrapper.js`

**Before:**
```javascript
// Clear localStorage and sessionStorage (Safari aggressive caching fix)
try {
  localStorage.clear();
  sessionStorage.clear();
} catch(e) { console.log('Storage clear:', e); }
```

**After:**
```javascript
// Clear sessionStorage (Safari aggressive caching fix)
// Note: DO NOT clear localStorage - it contains VS Code's encrypted secrets (secrets.provider)
// which are needed for persistent GitHub/Copilot authentication across page reloads
try {
  sessionStorage.clear();
} catch(e) { console.log('Storage clear:', e); }
```

**Why this is safe:**
- `sessionStorage` is tab-specific and cleared on tab close anyway
- `localStorage` contains VS Code's encrypted secrets (`secrets.provider`) that must persist
- The original "Safari caching fix" was too aggressive - Safari's caching issues don't require clearing localStorage

### Alternative Approaches (No longer needed)

These were being considered but are not needed since we found and fixed the root cause:

1. ~~**Switch to code-server**: Their patch bypasses the cookie entirely~~
2. ~~**Create our own workbench patch**: Similar to code-server's approach~~
3. ~~**File VS Code issue**: Report the bug upstream with detailed findings~~

## Conclusion (RESOLVED 2026-01-05)

### Root Cause

**The bug was in our own `vscode-wrapper.js` code**, not VS Code!

The wrapper page at `/code/` was calling `localStorage.clear()` on every page load as a "Safari caching fix". This wiped VS Code's encrypted secrets (`secrets.provider`) every time the user refreshed the page.

### The Fix

Removed `localStorage.clear()` from `manager/public/js/vscode-wrapper.js`. Only `sessionStorage.clear()` is now called.

### What We Learned

1. **VS Code serve-web's secret storage works correctly**
   - Uses two-part encryption (client key + server key)
   - Cookies and localStorage persist properly
   - The system is well-designed and robust

2. **Playwright testing was invaluable**
   - Allowed us to instrument browser behavior
   - Showed that the core system worked
   - Helped narrow down the cause to our wrapper code

3. **gnome-keyring is NOT used by serve-web**
   - serve-web uses browser localStorage, not server-side keyring
   - The keyring setup is still useful for other tools that use libsecret

### Debug Scripts Created

All debug scripts in `/tmp/` (kept for future reference):
- `debug-secret-store.mjs` - Monitors all secret operations
- `debug-refresh-persistence.mjs` - Tests secret persistence across refresh
- `debug-localstorage-clearing.mjs` - Tracks localStorage operations
- `debug-vscode-wrapper.mjs` - Found the root cause!
- And several others for cookie/crypto analysis

## References

- [VS Code Secret Storage Discussion #748](https://github.com/microsoft/vscode-discussions/discussions/748)
- [VS Code Issue #187338: OS keyring not identified](https://github.com/microsoft/vscode/issues/187338)
- [VS Code Issue #191861: Add --github-auth to serve-web](https://github.com/microsoft/vscode/issues/191861)
- [VS Code Issue #212369: SECRET_KEY_MINT_PATH doesn't honor server-base-path](https://github.com/microsoft/vscode/issues/212369)
- [VS Code Issue #228036: secrets.provider lost on reload](https://github.com/microsoft/vscode/issues/228036)
- [VS Code Issue #238303: Settings not honored in serve-web](https://github.com/microsoft/vscode/issues/238303)
- [VS Code PR #191538: Secret storage provider for serve-web](https://github.com/microsoft/vscode/pull/191538)
- [VS Code PR #214250: Fix SECRET_KEY_MINT_PATH with server-base-path](https://github.com/microsoft/vscode/pull/214250)
- [GNOME Keyring - ArchWiki](https://wiki.archlinux.org/title/GNOME/Keyring)
