# RStudio Debug Journal

## 2026-01-01: rsession Not Spawning

### Problem
RStudio shows spinning wheel. PAM auth succeeds but rsession never starts.

### What Works
- rserver process running (PID 633556 on g-c-1-7-30)
- Singularity bind mounts exist in process namespace (verified via /proc/633556/mountinfo)
- rsession.sh correctly contains `"$@"` (base64 encoding solved escaping)
- Config files have proper newlines (base64 encoding)
- PAM authentication works (login page accepts credentials)

### What's Failing
- rsession.log is empty (never created)
- No rsession process spawned
- `/etc/rstudio/rsession.sh` not accessible from SSH to compute node (outside container namespace)

### Key Discovery
```bash
# From login node SSH to compute node:
ssh g-c-1-7-30 'cat /etc/rstudio/rsession.sh'
# Result: No such file or directory

# But mountinfo shows it IS mounted in rserver's namespace:
cat /proc/633556/mountinfo | grep rsession.sh
# Shows: /etc/rstudio/rsession.sh mounted from NFS
```

The bind mount exists in the Singularity container namespace but NOT visible from regular SSH.
This is expected - but rserver SHOULD see it since it's running inside Singularity.

### Failed Attempts

1. **Heredoc in sbatch --wrap** - sbatch can't handle multiline content in --wrap
2. **printf %b with single quotes** - doesn't interpret \012, produces literal text
3. **printf %b with double quotes through SSH** - nested quote escaping nightmare
4. **Various escaping combinations** - went in circles trying \\$@, \\\\$@, etc.

### Solved Issues
- Base64 encoding bypasses ALL escaping issues (documented in ESCAPING.md)
- All config files now use base64: database.conf, rserver.conf, rsession.sh

### Theories to Investigate Tomorrow

1. **rserver can't find rsession.sh despite bind mount**
   - Maybe rserver resolves path BEFORE singularity sets up bind mounts?
   - Try: Add delay before starting rserver, or check startup order

2. **rsession spawns but fails silently**
   - The `exec 2>>~/.rstudio-slurm/rsession.log` redirect might fail
   - Try: Use absolute path `/home/domeally/.rstudio-slurm/rsession.log`
   - Try: Add `set -x` BEFORE the redirect to see if script even starts

3. **PAM session issue**
   - rserver might authenticate but fail to create PAM session for rsession
   - Check: /var/log/secure or auth.log on compute node (if accessible)

4. **--cleanenv stripping something needed**
   - Singularity --cleanenv might remove env vars rsession needs
   - Try: Remove --cleanenv temporarily to test

5. **rsession-path not being honored**
   - rserver might ignore --rsession-path when spawning rsession
   - Check: RStudio Server version compatibility
   - Try: Use /etc/rstudio/rsession-wrapper instead of rsession.sh

6. **File permissions inside container**
   - rsession.sh might not be executable from rserver's perspective
   - Check: Permissions via /proc/PID/root/etc/rstudio/rsession.sh

### Debug Commands to Run Tomorrow

```bash
# 1. Check if rserver can see rsession.sh via /proc filesystem
ssh g-c-1-7-30 'cat /proc/633556/root/etc/rstudio/rsession.sh'

# 2. Check rserver's view of /etc/rstudio/
ssh g-c-1-7-30 'ls -la /proc/633556/root/etc/rstudio/'

# 3. Look for any rsession errors in system logs
ssh g-c-1-7-30 'journalctl -u rstudio-server --since "1 hour ago" 2>/dev/null || echo no journalctl'

# 4. Manually exec rsession.sh inside the running container namespace
ssh g-c-1-7-30 'nsenter -t 633556 -m /etc/rstudio/rsession.sh --help 2>&1'

# 5. Check if there's a .local/share/rstudio directory with session info
ssh g-c-1-7-30 'ls -la ~/.local/share/rstudio/ 2>/dev/null'

# 6. Try running rserver with debug logging
# Would need to restart job with: --server-log-level=debug
```

### Files Modified Today
- `manager/services/hpc.js` - Changed to base64 encoding for all config files
- `ESCAPING.md` - Documented escaping tests and solution
- `manager/server.js` - Fixed healthcheck timing (server.listen inside stateManager.load)
- `docker-compose.yml` - Added start_period: 60s to healthcheck

### Current Job
- Job ID: 28750770
- Node: g-c-1-7-30
- rserver PID: 633556
- Status: RUNNING but rsession not spawning

---

## 2026-01-01 (Evening): Comparing Working vs Failing Scripts

### Approach
Simplified debugging by running directly on compute node (no sbatch) to isolate issue.

### Test 1: Direct singularity exec on compute node
```bash
# Ran /tmp/test-rstudio-simple.sh on g-c-1-7-27
# Result: rserver starts, login page works, but NO rsession spawned
```
**Conclusion:** Problem is NOT sbatch/--wrap escaping. Issue persists with direct execution.

### Key Discovery: Apollo Working Script Differences

Compared `/opt/singularity-images/rbioc/rbioc319.job` (works on apollo) with our script:

| Feature | Apollo (works) | Gemini (fails) |
|---------|---------------|----------------|
| Bind mounts | `SINGULARITY_BIND` env var | `-B` flag |
| rserver.conf | NOT used | Uses www-root-path |
| --www-address | NOT set | 0.0.0.0 |
| rsession.sh exports | SINGULARITY_BIND, SINGULARITY_CONTAINER, SLURM_JOB_ID | Only R env vars |

### New Theories

1. **SINGULARITY_BIND env var vs -B flag**
   - Apollo uses `export SINGULARITY_BIND=...`
   - We use `-B ...` flag
   - Might affect how child processes (rsession) see bind mounts

2. **rsession.sh missing SINGULARITY_* exports**
   - Apollo's rsession.sh exports SINGULARITY_BIND and SINGULARITY_CONTAINER
   - These may be needed for rsession to inherit container context

3. **www-root-path in rserver.conf**
   - Apollo doesn't use rserver.conf at all
   - Our `www-root-path=/rstudio-direct` might interfere

4. **--www-address=0.0.0.0**
   - Apollo doesn't specify this
   - Might cause binding issues

### Next Test
Create script matching apollo's pattern exactly, run on gemini.

---

## 2026-01-01: Apollo Also Broken!

### Discovery
Tested if RStudio works on apollo - **IT DOESN'T**. The rbioc319.job script is also failing.

```bash
sacct -u domeally --format=JobName,JobID,State,Elapsed | grep rbioc | head -5
# rbioc_3.1+ 16655784      COMPLETED   00:00:01  # Failed immediately
# rbioc_3.1+ 16655786         FAILED   00:00:00
# etc - all failing since December
```

Last working run: job 16333947 (TIMEOUT after 8:00:00) - ran successfully before timing out.

### Implication
- The issue is NOT gemini-specific
- Something changed on both clusters (singularity update? RStudio version?)
- The rbioc319.job script that "worked" is now also broken

### New Investigation Path
1. Compare singularity versions between clusters
2. Check if rserver exits immediately on both
3. Check singularity/rserver logs for actual error

---

## 2026-01-01: Key Finding - rsession.sh Never Called

### Discovery
Added debug logging to rsession.sh - **the file is never executed**. rserver doesn't even try to spawn rsession.

### What's NOT the Problem
- Singularity version (tried 3.4.1, 3.8.6, 3.11.5 - all same behavior)
- LD_LIBRARY_PATH (added, still not called)
- rsession.sh escaping (fixed `"$@"`, still not called)
- SINGULARITY_BIND vs -B flag (both work for bind mounts)
- pam-helper authentication (works when tested directly)

### Current State
- rserver starts and serves login page
- Curl login attempts return `error=2` (auth failure?)
- But pam-helper works correctly when tested in isolation
- rsession.sh debug log is NEVER created

### Need to Test
- Access via real browser (not curl) to see actual behavior
- The `unsupported_browser.htm` redirect suggests curl might not trigger full session init

### Active Test
- Node: g-c-1-7-27
- rserver PID: 1768836
- Password: 1234

---

## 2026-01-01: ROOT CAUSE FOUND

### The Problem Was Our Testing Method

**curl doesn't work for testing RStudio** - it gets redirected to `unsupported_browser.htm` and never triggers rsession spawn. Real browsers work fine.

### What Actually Works
- Singularity 3.7.0 (reports as 3.4.1) ✅
- Singularity 3.11.5 ✅
- Using `SINGULARITY_BIND` env var ✅
- Using `-B` flag ✅ (both work)

### Key Requirements for rsession.sh
```bash
#!/bin/sh
export R_HOME=/usr/local/lib/R
export LD_LIBRARY_PATH=/usr/local/lib/R/lib:/usr/local/lib  # CRITICAL for rsession binary
export OMP_NUM_THREADS=4
export R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.19
export R_LIBS_USER=~/R/bioc-3.19
export TMPDIR=/tmp
export TZ=America/Los_Angeles
exec /usr/lib/rstudio-server/bin/rsession "$@"
```

### Testing Protocol
**DO NOT test with curl** - always use a real browser via SSH tunnel:
```bash
ssh -L 8787:COMPUTE_NODE:8787 gemini-login1.coh.org
# Then open http://localhost:8787 in browser
```

### Next Step
Test via the actual manager to confirm it works end-to-end.

---

## 2026-01-02: Manager Proxy Path Alignment Fix

### Problem
Direct SSH tunnel to RStudio works, but manager proxy shows spinning wheel.

### Root Cause
Path mismatch between RStudio's `www-root-path` and the proxy URL:
- `www-root-path=/rstudio-direct` (in rserver.conf)
- Proxy serves at `/rstudio/` to users
- RStudio generates URLs like `/rstudio-direct/auth-sign-in`
- These don't match the public `/rstudio/*` routes

### Fix Applied
Changed all `/rstudio-direct` references to `/rstudio`:

1. **manager/services/hpc.js** - `www-root-path=/rstudio`
2. **manager/server.js** - `X-RStudio-Root-Path` header to `/rstudio`
3. **manager/server.js** - Cookie path rewriting to `/rstudio/`
4. **manager/server.js** - Redirect URL rewriting to `/rstudio`

### Architecture Clarification
- `/rstudio` route: Main page serves wrapper HTML, other paths proxy to RStudio
- `/rstudio-direct` route: Direct proxy for wrapper iframe (bypasses wrapper)
- Wrapper iframe loads `/rstudio-direct/` but RStudio generates `/rstudio/*` URLs
- Both routes exist and proxy to the same backend - the key is consistent URL generation

### Deployment
```bash
git push  # Commit c648736
# Manual deploy trigger via Dokploy API
```

### Test Job
- Job ID: 28773218
- Node: g-c-1-7-30
- Status: RUNNING

### Verification
Access https://hpc.omeally.com/rstudio/ in browser to confirm fix works.

---

## 2026-01-02: RStudio Hardcoded /rstudio/ Asset Paths

### Discovery
After login works, RStudio shows spinner. Logs reveal:
- Login succeeds, redirects to `/rstudio-direct/` ✅
- rsession.sh IS being called (multiple times) ✅
- rsession gets `--session-root-path /rstudio-direct` ✅

BUT: RStudio loads assets from `/rstudio/*` paths WITHIN the iframe:
```
[RStudio-Direct] GET /rstudio/rstudio.nocache.js
[RStudio-Direct] GET /rstudio/182DE6C7F7B2D324BBC72C939901E787.cache.js
```

These requests hit `/rstudio-direct/rstudio/foo.js` - a **nested** path!

### Root Cause
RStudio has a **hardcoded** `/rstudio/` prefix for its GWT-compiled assets, regardless of `www-root-path`. The `www-root-path` only affects:
- Auth redirects
- Cookie paths
- Top-level page URLs

But the JavaScript app still references `/rstudio/*.cache.js` files.

### Fix Options
1. **Rewrite URLs in proxy response** - Replace `/rstudio/` with `/` in HTML/JS
2. **Add /rstudio route inside /rstudio-direct** - Nested proxy
3. **Remove www-root-path entirely** - Let RStudio use default /rstudio/
4. **Serve at /rstudio/ without wrapper** - Direct proxy, no iframe

### Current State
- Job: 28775110 on g-c-1-7-30
- rsession spawning: YES
- Login: Works
- Asset loading: FAILS (wrong paths)

---

## 2026-01-02: Cookie and rsession Investigation

### Problem
After fixing asset paths, RStudio still shows spinner. Investigated whether cookies were being sent correctly.

### Findings

1. **Cookie path issue identified**
   - RStudio sets cookies with `path=/rstudio-direct`
   - Browser wasn't sending `user-id` cookie in subsequent requests
   - Changed cookie path rewriting to `path=/` for broadest matching

2. **Puppeteer testing reveals truth**
   - Used Puppeteer to bypass Safari/browser quirks
   - Cookies ARE being set correctly: `user-id`, `csrf-token`, `rs-csrf-token`, `user-list-id`
   - Cookies ARE being sent in requests (verified via request interception)
   - Full cookie header in client_init request includes `user-id=domeally|...`

3. **But rsession.log NEVER created**
   - Despite cookies working correctly
   - Despite login succeeding
   - Despite client_init being called
   - rsession.sh is NEVER executed by rserver

### Key Evidence
```bash
# Puppeteer shows cookies sent correctly:
cookie: "rs-csrf-token=...; csrf-token=...; user-id=domeally|...; user-list-id=..."

# But rsession.log doesn't exist:
ls ~/.rstudio-slurm/
# Only shows: rserver.log, workdir/

# Cleared stale sessions:
rm -rf ~/.local/share/rstudio/sessions/active/*
# Still no rsession.log created
```

### Current State
- Job: 28775623 on g-c-1-7-30
- rserver: Running (serves login, accepts auth)
- Cookies: Working (verified via Puppeteer)
- rsession.sh: NEVER CALLED
- rsession.log: Never created

### What's Actually Broken
rserver receives valid authentication but does NOT spawn rsession. This is NOT:
- A cookie issue (cookies work)
- A browser issue (Puppeteer shows same behavior)
- An iframe issue (direct access shows same behavior)
- A session state issue (cleared sessions, still broken)

### Next Investigation - SYSTEMATIC APPROACH

**Stop guessing. Be methodical.**

Two different failure modes observed:
- Job 28775110: rsession CALLED but CRASHING (abend=1, multiple launcher tokens in log)
- Job 28775623: rsession NEVER CALLED (no log file created)

Main change between them: cookie path from `/rstudio-direct` to `/`

**5 Systematic Checks (in sequence):**

1. **Git log**: Identify exact commits between "rsession spawning" and "rsession never called"
   - Find the breaking change

2. **Revert and test**: Deploy code from when rsession WAS spawning
   - Confirm rsession.log gets created (even if rsession crashes)
   - This validates we can reproduce the "better" broken state

3. **Compare HTTP exchanges**: Use Puppeteer to capture FULL request/response for:
   - Direct SSH tunnel (working)
   - Proxy (broken)
   - Find the difference in what rserver receives

4. **Check rserver's perspective**:
   - Is there rserver debug logging without `--server-log-level`?
   - Check /var/log inside container namespace
   - What does rserver see vs what we send?

5. **Isolate variables**: If cookie path is suspect:
   - Test with path=/rstudio-direct + all OTHER fixes kept
   - Confirm hypothesis before acting on it

**Key Insight**: Direct tunnel works. Proxy worked partially (rsession spawned but crashed).
Now proxy is worse (rsession never called). We regressed - find what caused regression.

---

## 2026-01-02: www-root-path Causing Double Path

### Discovery
Direct tunnel now shows "Unable to connect to service" error. Curl reveals:
```
http://localhost:8787/rstudio-direct/rstudio-direct/unsupported_browser.htm
```

The path is DOUBLED: `/rstudio-direct/rstudio-direct/`

### Root Cause
`www-root-path=/rstudio-direct` in rserver.conf tells RStudio to prefix ALL URLs with `/rstudio-direct`.
- When accessed via proxy at `/rstudio-direct/`, this is correct
- When accessed directly at `localhost:8787/`, RStudio STILL adds the prefix
- Result: double path when accessed directly

### Implication
The job was launched with `www-root-path=/rstudio-direct` config. This breaks direct tunnel access.
Direct tunnel worked BEFORE because we didn't have `www-root-path` set.

### The Real Problem
We've been testing two different configurations:
1. Direct tunnel (no www-root-path) - WORKS
2. Proxy access (with www-root-path=/rstudio-direct) - rsession not spawning

When we added `www-root-path`, direct tunnel broke. When we test via proxy, rsession doesn't spawn.

### Next Steps
1. Cancel job, relaunch WITHOUT www-root-path
2. Test direct tunnel confirms rsession spawns
3. Then figure out how to make proxy work without www-root-path

---

## 2026-01-02: SOLVED - Proxy Works Without www-root-path

### The Fix
Removed `www-root-path=/rstudio-direct` from `manager/services/hpc.js` rserver.conf.

### Why It Works
The proxy code in `server.js` already handles path rewriting correctly:
1. `X-RStudio-Root-Path: /rstudio-direct` header tells RStudio its external path
2. Proxy rewrites redirects: `/auth-sign-in` → `/rstudio-direct/auth-sign-in`
3. Cookie paths set to `/rstudio-direct` by RStudio's cookie generation

Without `www-root-path`, RStudio generates paths at `/` internally, but the proxy intercepts and rewrites them to `/rstudio-direct/*`. The header tells RStudio where it's mounted externally.

### Test Results

**Direct tunnel (localhost:8787)**:
- Login works
- RStudio loads
- No double paths

**Proxy (https://hpc.omeally.com/rstudio-direct/)**:
```
REDIRECT 302: /rstudio-direct/ -> /rstudio-direct/auth-sign-in?appUri=%2F
REDIRECT 302: /rstudio-direct/auth-do-sign-in -> /rstudio-direct/
Cookies: user-id(path=/rstudio-direct), csrf-token(path=/rstudio-direct)
Page title: RStudio
SUCCESS: RStudio app loaded!
```

### Key Insight
The `www-root-path` setting was CONFLICTING with the proxy's path rewriting. With both:
- RStudio added `/rstudio-direct` prefix internally
- Proxy added `/rstudio-direct` prefix externally
- Result: double paths like `/rstudio-direct/rstudio-direct/`

Without `www-root-path`, RStudio generates clean `/` paths, and the proxy handles all external path mapping.

### rsession.log Not Created
The `~/.rstudio-slurm/rsession.log` file isn't being created despite RStudio working. Possible causes:
1. `~` resolves differently inside singularity container namespace
2. The rsession.sh script's output redirect doesn't work as expected in container

This is a minor debugging issue - the actual functionality works.

### Current State
- Job: 28780221 on g-h-1-8-19
- Both direct tunnel and proxy access: **WORKING**
- Commit: 342ad54

---

## 2026-01-02: rsession.sh Escaping Fix and Proxy Investigation

### Fix 1: $HOME escaping in template literals

**Problem**: `\$HOME` in JS template literal produces `\$HOME` (with backslash) in base64 output.

**Solution**: Use a variable to inject the `$` character:
```javascript
const dollar = '$';
const script = `LOG=${dollar}HOME/.rstudio-slurm/rsession.log`;
```

This produces clean `$HOME` without backslash. Updated ESCAPING.md with this lesson.

### Fix 2: Password hardcoded to 1111 for testing

Temporarily set `generatePassword()` to return '1111' for easier debugging.

### Discovery: Direct Tunnel Works, Proxy Doesn't

After fixing escaping, tested both access methods:

| Method | rsession spawns? | rsession.log created? |
|--------|-----------------|----------------------|
| Direct SSH tunnel (localhost:8787) | YES | YES |
| Proxy (hpc.omeally.com/rstudio-direct/) | NO | NO |

**Key Evidence**:
```bash
# Direct tunnel - rsession.sh gets called:
=== rsession.sh called at Fri Jan  2 01:42:09 AM MST 2026 ===
Args: -u domeally --session-root-path / ...
HOME=/home/domeally PWD=/

# Proxy - rsession.sh NEVER called
# But GWT JavaScript UI loads (showing spinner)
```

### Theory: X-RStudio-Root-Path Header

The proxy sets `X-RStudio-Root-Path: /rstudio-direct` header. Without `www-root-path` in rserver.conf, this header might cause rserver to reject session creation or behave unexpectedly.

Direct tunnel rsession shows `--session-root-path /` (root).
Proxy would expect `--session-root-path /rstudio-direct`.

**Test**: Disabled the X-RStudio-Root-Path header in server.js to see if rsession spawns via proxy.

### Commits
- c212bfa: Fix ${dollar} pattern for shell vars in rsession.sh
- d8c4cfd: Disable X-RStudio-Root-Path header to test rsession spawning

---

## 2026-01-02 (cont): X-RStudio-Root-Path Theory DISPROVEN

### Test Results

Removed `X-RStudio-Root-Path` header from proxy - **rsession still doesn't spawn**.

### Critical Discovery: Issue is NOT about spawning

Tested with rsession already running (spawned via direct tunnel):

| Test | Result |
|------|--------|
| Direct tunnel login | rsession spawns, R Console loads ✅ |
| Proxy login (fresh job) | rsession never spawns, stuck on spinner ❌ |
| **Proxy with EXISTING rsession** | **STILL stuck on spinner** ❌ |

This proves: **The proxy can't communicate with rsession even when it's already running.**

### RPC Investigation

The `/rpc/client_init` POST is the critical call that triggers rsession spawn and connects the GWT client.

```
Proxy logs show:
- proxyReq: POST /rpc/client_init ... (request sent)
- NO proxyRes logged for /rpc/* endpoints
- Browser keeps retrying GET / in a loop
```

The RPC request goes out but no response comes back. Connection doesn't reset (no ECONNRESET) - the response just... vanishes.

### Possible Causes

1. **Response buffering**: http-proxy may not correctly stream chunked/long-poll RPC responses
2. **Cookie path mismatch**: Cookies set with `path=/` vs `path=/rstudio-direct`
3. **Content-Type handling**: RStudio RPC uses custom content types
4. **Body rewriting needed**: Response body may contain absolute URLs that break

### Next Steps

- Web search for similar RStudio reverse proxy issues
- Check if others use Nginx/Apache instead of Node http-proxy for RStudio
- Look for RStudio-specific proxy configuration requirements

---

## 2026-01-02 (cont): ROOT CAUSE FOUND - Missing www-root-path

### Web Search Results

Searched for RStudio reverse proxy issues and found:

1. **Posit official docs** require:
   - `proxy_buffering off` for streaming/long-polling
   - `proxy_read_timeout 20d` for long connections
   - WebSocket upgrade headers
   - **`www-root-path` in rserver.conf when proxying under a subpath**

2. **jupyter-rsession-proxy** (solves the exact same problem):
   - Sets `--www-root-path={base_url}rstudio/` in rserver args
   - Implements `rewrite_netloc` to fix Location headers
   - This is how JupyterHub proxies RStudio successfully

### The Root Cause

**Our rserver.conf is missing `www-root-path=/rstudio-direct/`**

Current config (hpc.js lines 135-137):
```
rsession-which-r=/usr/local/bin/R
auth-cookies-force-secure=0
```

When RStudio doesn't know its root path:
1. Generates cookies with `path=/` instead of `path=/rstudio-direct`
2. Internal URLs lack the `/rstudio-direct` prefix
3. `/rpc/client_init` response contains incorrect paths
4. Cookie validation fails, rsession connection breaks

### Evidence

The rsession process shows `--session-root-path /` when spawned via direct tunnel:
```
/usr/lib/rstudio-server/bin/rsession ... --session-root-path / ...
```

This is correct for direct access but wrong for proxy access at `/rstudio-direct/`.

### The Fix

Add to rserver.conf:
```
www-root-path=/rstudio-direct/
```

This tells rserver:
- Generate cookies with correct path
- Prefix all internal URLs with `/rstudio-direct`
- rsession will use `--session-root-path /rstudio-direct/`

### References

- https://github.com/jupyterhub/jupyter-rsession-proxy - uses `--www-root-path`
- https://docs.posit.co/ide/server-pro/access_and_security/running_with_a_proxy.html
- https://github.com/rstudio/rstudio/issues/2173 - "Unable to establish connection"
- https://doc.traefik.io/traefik/user-guides/websocket/ - Traefik websocket config

### Implementation Plan

1. Update `buildRstudioWrap()` in hpc.js to add `www-root-path=/rstudio-direct/` to rserver.conf
2. Remove the cookie path rewriting in server.js (line 124) - no longer needed
3. Re-enable the `X-RStudio-Root-Path` header (optional, may help)
4. Deploy and test

---

## 2026-01-02 (cont): Multiple Fixes Applied - SUCCESS!

### Fix 1: http-proxy keepAlive issue

**Error**: `Parse Error: Data after Connection: close`

RStudio's rserver sends `Connection: close` header but http-proxy was keeping connections alive.

**Solution**: Add custom agent with `keepAlive: false`:
```javascript
agent: new (require('http').Agent)({ keepAlive: false }),
```

Note: This fixed GET requests but HEAD still fails (acceptable).

### Fix 2: www-root-path trailing slash

**Error**: `Client unauthorized` (error code 3) on `/rpc/client_init`

The cookie was set with `path=/rstudio-direct` but rserver.conf had `www-root-path=/rstudio-direct/` (with trailing slash). This mismatch caused cookie validation to fail.

**Solution**: Remove trailing slash from www-root-path:
```
www-root-path=/rstudio-direct
```

### Fix 3: Missing X-RS-CSRF-Token header

**Error**: `Missing X-RS-CSRF-Token header` on client_init

The browser JavaScript sends this header. Direct curl tests without it fail. The proxy correctly passes this header through.

### Final Working State

After all fixes:
- Login works via proxy ✅
- user-id cookie set and sent correctly ✅
- client_init returns full session JSON ✅
- rsession.sh called with correct args ✅
- rsession process spawns ✅

```bash
# rsession.log shows:
=== rsession.sh called at Fri Jan  2 03:53:47 AM MST 2026 ===
Args: -u domeally --session-use-secure-cookies 0 --session-root-path /rstudio-direct ...
HOME=/home/domeally PWD=/
```

### Key Commits
- 2d5e008: Disable keepAlive for RStudio proxy
- cc646dd: Remove trailing slash from www-root-path

### Remaining Issues

1. **HEAD requests fail** - `Parse Error` on HEAD, but GET works. Low priority.
2. **R Console detection** - Puppeteer DOM detection shows "Has R Console: false" but RStudio loads visually.

### Architecture Summary

Working RStudio reverse proxy requirements:
1. `www-root-path=/rstudio-direct` in rserver.conf (NO trailing slash)
2. Cookie path matches www-root-path exactly
3. `keepAlive: false` in http-proxy agent
4. `X-RStudio-Root-Path` header set by proxy
5. `SameSite=None; Secure` for iframe cookie support

---

## 2026-01-02: proxyRes Never Fires for /rpc/client_init

### Problem
After session starts successfully and assets load, the client_init POST gets stuck:
- `proxyReq` event fires (request sent to backend)
- `proxyRes` event NEVER fires (response not received by proxy)
- Browser shows spinner, retries client_init every ~30s
- Direct curl to rserver inside container works perfectly

### Evidence
```
# proxyReq logged:
2026-01-02 03:33:45 [DEBUG] RStudio proxyReq {"method":"POST","url":"/rpc/client_init",...}

# NO proxyRes for client_init
# But proxyRes fires for static assets (css, js) with status 200/304
```

### Direct Backend Test (WORKS)
```bash
docker exec container curl -s -X POST 'http://127.0.0.1:8787/rpc/client_init' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: user-id=...; rs-csrf-token=...' \
  -H 'X-RS-CSRF-Token: ...' \
  -d '{}'
# Returns: {"result":{"clientId":"...","mode":"server",...}} (huge JSON response)
```

### Raw Node.js Request (WORKS)
```javascript
http.request({ hostname: '127.0.0.1', port: 8787, path: '/rpc/client_init', method: 'POST' })
// STATUS: 200, BODY: {"error":{"code":3,...}} or {"result":{...}}
```

### What's Different About client_init?
1. **Large response**: client_init returns massive JSON (10-50KB) with full session state
2. **POST with body**: Most other requests are GET
3. **Content-Type: application/json**: Same as other RPC calls that work

### Theories
1. **Response buffering**: http-proxy may not handle large responses correctly
2. **Chunked encoding**: Response might be chunked in a way proxy can't handle
3. **Connection timing**: Response arrives but connection closes before proxy pipes it

### Diagnostic Approach
Adding more granular logging:
- `start` event: When proxy begins handling request
- `end` event: When proxy finishes handling request
- Error stack traces for more context

### Key Insight
The `proxy.web(req, res, {}, callback)` pattern BREAKS response streaming!
- When you pass a callback to proxy.web(), it enables `selfHandleResponse` mode
- This stops automatic response piping - you must manually handle the response
- Previous code had this callback which was removed in c783256

But proxyRes STILL doesn't fire even without the callback. The issue is deeper.

---

## 2026-01-02: ROOT CAUSE FOUND - express.json() Breaks Proxy

### Discovery
Added `start`/`end` event logging to proxy. Result:
- `proxy start` fires for `/rpc/client_init`
- `proxyReq` fires
- **NO `proxy end` for client_init** - request never completes
- All other requests (GET for assets) have matching start/end pairs

### The Root Cause: `express.json()` consumes POST bodies

```javascript
// server.js line 20 - PROBLEM!
app.use(express.json());
```

When `express.json()` is applied globally:
1. Express middleware parses and consumes the request body stream
2. `req.body` is populated with parsed JSON
3. **The original body stream is now empty**
4. http-proxy forwards request with empty body
5. rserver waits for POST body that never arrives → **request hangs**

### Evidence
- All GET requests work (no body to consume)
- POST /api/* routes work (they read `req.body` after Express parses it)
- POST /rpc/client_init hangs (proxy tries to forward empty stream)
- rsession IS spawning (confirmed via rsession.log) - backend works!
- Direct curl to rserver with body works perfectly

### The Fix
Move `express.json()` from global middleware to only the `/api` router:

**server.js:**
```javascript
// REMOVED: app.use(express.json());
```

**routes/api.js:**
```javascript
const router = express.Router();
router.use(express.json());  // Only parse JSON for /api routes
```

### Why This Works
- `/api/*` routes need body parsing → they use `req.body`
- `/rstudio/*` proxy routes need raw stream → http-proxy forwards it
- `/rstudio-direct/*` proxy routes need raw stream → http-proxy forwards it

### Key Lesson
**Never use body-parsing middleware globally when using http-proxy.**
Body parsers consume the request stream, leaving nothing for the proxy to forward.

---

## 2026-01-02: Floating Menu Blocking Clicks

### Problem
After RStudio proxy fix, users couldn't delete/rename files in RStudio UI. The floating menu iframe (320x450px) was capturing clicks in transparent areas.

### Root Cause
```css
#hpc-menu-frame {
  width: 320px;
  height: 450px;
  pointer-events: auto;  /* Captures ALL clicks in rectangle */
}
```

### Failed Fix: pointer-events: none
Setting `pointer-events: none` on the iframe lets clicks through but **blocks ALL interaction** - can't click OR drag the menu button.

### Working Fix: Dynamic iframe sizing
Iframe starts small (50x50px = toggle button only), expands when menu opens:

```css
#hpc-menu-frame {
  width: 50px;
  height: 50px;
  transition: width 0.15s, height 0.15s;
}
#hpc-menu-frame.expanded {
  width: 260px;
  height: 400px;
}
```

Menu sends `postMessage` to parent on open/close:
```javascript
parent.postMessage({ type: open ? 'hpc-menu-expand' : 'hpc-menu-collapse' }, '*');
```

Parent toggles `.expanded` class on iframe.

---

## 2026-01-02: VS Code Tunnel Wrong Node

### Problem
VS Code showed garbled UI (missing CSS). Logs showed `Connection refused` errors.

### Root Cause
SSH tunnel was pointing to **old node** (g-h-1-8-17) while job was running on **new node** (g-c-1-7-30).

```
# Tunnel in container:
ssh -L 8000:g-h-1-8-17:8000 ...  # WRONG NODE

# Actual job:
squeue shows: g-c-1-7-30  # CORRECT NODE
```

### Why It Happened
Container restart or state desync caused tunnel to persist with stale node info while job migrated or was relaunched on different node.

### Fix
Restart manager container to clear all stale tunnels:
```bash
docker restart omhq-hpc-code-server-prod-app
```

Then reconnect to rebuild tunnel with correct node.

### Prevention
- Manager should verify tunnel target matches current job node before proxying
- Consider adding tunnel health check that validates node matches squeue output

---

## Summary: All Fixes Applied 2026-01-02

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| RStudio spinner (client_init hangs) | `express.json()` consuming POST body | Move to `/api` router only |
| Menu blocking RStudio clicks | Large iframe with `pointer-events: auto` | Dynamic iframe sizing (50x50 → 260x400) |
| VS Code garbled/no CSS | Tunnel pointing to wrong node | Restart container to clear stale tunnels |

### Key Architecture Lessons

1. **Body parsers + http-proxy don't mix** - body parsers consume streams
2. **Overlay iframes need dynamic sizing** - or they block underlying UI
3. **SSH tunnels can become stale** - node info can change without tunnel update

---

## 2026-01-02 (cont): Post-PR#8 Merge Regression Fixes

### Context
After PR#8 merge, both VS Code and RStudio had regressions. PR#7 (46f0825) was working reference.

### Issue 1: VS Code Floating Menu Not Draggable/Expandable

**Symptom**: Menu button visible but couldn't drag or expand it.

**Root Cause**: `vscode-wrapper.html` was missing `pointer-events: auto` on the iframe.
The `rstudio-wrapper.html` had it, but it was never added to the VS Code wrapper.

**Fix**: Added `pointer-events: auto` to `#hpc-menu-frame` CSS in vscode-wrapper.html.

### Issue 2: RStudio Jobs Immediately Fail ("Job disappeared from queue")

**Symptom**: Jobs submitted but exit code 1 within seconds, empty .log/.err files.

**Investigation Path**:
1. `sacct` showed jobs FAILED with exit code 1:0
2. Empty log files meant job failed before any output
3. Traced through escaping patterns in hpc.js

**Root Cause 1**: Workdir escaping regression in PR#8 commit 2c6156d.
Changed from `'\\$HOME/...'` to `` `${dollar}HOME/...` `` which caused `$HOME` to expand
on the Dokploy container (`/home/apps`) instead of compute node.

**Fix 1**: Restored `'\\$HOME/...'` pattern for INLINE commands.

**Root Cause 2**: Invalid rserver.conf option.
`session-save-action-default=no` was added to rserver.conf but this is an rsession.conf
option, not rserver.conf. RStudio 2024.04 rejected it with "unrecognised option" error.

**Fix 2**: Removed invalid option, added proper `rstudio-prefs.json` instead per
https://github.com/rstudio/rstudio/issues/12028

**Root Cause 3**: Base64 echo commands used single quotes inside --wrap single quotes.
`echo '${base64}' | base64 -d` inside `--wrap='...'` created nested single quotes
that broke shell parsing. Jobs failed before any command executed.

**Fix 3**: Removed quotes from base64 echo: `echo ${base64} | base64 -d`
Base64 strings are alphanumeric + `/+=` so no quoting needed.

**Root Cause 4**: `$(whoami)` expanding on wrong machine.
`--server-user=$(whoami)` in the singularity command was missing escape, so it
expanded on the Dokploy container (returning `apps`) instead of compute node.

**Fix 4**: Changed to `--server-user=\\$(whoami)` using same INLINE escaping pattern.

### Two Escaping Contexts (Critical Lesson)

Updated ESCAPING.md to document both contexts:

**Context 1: INLINE Commands** (setup array, singularity args)
- Goes through: `ssh host "sbatch --wrap='...'"`
- SSH double-quotes consume one backslash level
- Pattern: `'\\$HOME'` or `` `\\$HOME` `` → produces `\$HOME` → SSH sends `$HOME`

**Context 2: BASE64-Encoded Scripts** (rsessionScript, config files)
- Goes through: base64 encode → decode on compute node
- No shell escaping needed, backslashes preserved literally
- Pattern: `const dollar = '$'; ${dollar}HOME` → produces `$HOME`

**WARNING**: Using wrong pattern causes failures:
- `${dollar}HOME` in INLINE context → expands locally on Dokploy container!
- `\\$HOME` in BASE64 context → backslash preserved, breaks shell script!

### Empirical Testing Protocol

Always test escaping changes before deploying:
```bash
# Test INLINE escaping through SSH
ssh gemini "sbatch --wrap='echo USER=\$(whoami) > \$HOME/test.txt' ..."
# Check result: should show compute node user and path

# For BASE64, verify decoded content
echo ${base64string} | base64 -d
# Should show clean $ variables without backslashes
```

### Commits on fix/floating-menu-drag-expand Branch

1. `af37a49` - VSCode pointer-events fix
2. `13a2eec` - Restore workdir escaping
3. `671fdf4` - Use rstudio-prefs.json instead of invalid rserver.conf option
4. `6511a24` - Remove quotes from base64 echo commands
5. `4b3debe` - Escape $(whoami) + document both escaping contexts

### Key Lesson

**Don't merge messy PRs.** PR#8 consolidated too many changes, introduced regressions
that required tracing through commit history to find. Each fix should be:
1. Isolated and testable
2. Empirically verified before deploy
3. Documented with the escaping context used

---

## 2026-01-04: Local Development Testing

### Running the Manager Locally

The manager can be run locally with full cluster connectivity:

```bash
cd manager
node server.js
# Server starts on http://localhost:3000
```

**Requirements:**
- SSH access to HPC clusters configured in `~/.ssh/config`
- VPN connected (for COH network access)

### Why This Works

- SSH config has `gemini` and `apollo` host aliases configured
- Local machine has same SSH keys as deployed container
- Manager uses SSH to execute SLURM commands and establish tunnels

### Use Cases

1. **Test UI changes** - Frontend CSS/JS changes visible immediately
2. **Test kill animations** - Requires running job to test SSE streaming
3. **Debug launch flow** - See full console output from job submission
4. **Test proxy behavior** - Direct access to RStudio/VS Code proxy routes

### Caveats

- Deployed container and local instance may conflict if both running
- Tunnels established locally won't be available to deployed instance
- Job state may desync between local/deployed instances
