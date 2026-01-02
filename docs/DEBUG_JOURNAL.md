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
- Base64 encoding bypasses ALL escaping issues (documented in docs/ESCAPING.md)
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
- `docs/ESCAPING.md` - Documented escaping tests and solution
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
