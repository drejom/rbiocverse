# StateManager Refactor Plan

## Problem

`api.js` directly mutates `stateManager.state.sessions` instead of going through StateManager methods. This caused a reference bug where `api.js` held a stale reference after `load()` replaced `this.state`.

**Current anti-pattern in api.js:**
```javascript
const state = stateManager.state;  // Captures reference at startup
state.sessions[sessionKey] = createIdleSession(ide);  // Direct mutation
session.status = 'running';
session.jobId = result.jobId;
await stateManager.save();  // Separate save call
```

## Goal

Make StateManager the **single source of truth** with proper encapsulation:
- All state mutations go through StateManager methods
- No direct access to `stateManager.state` from api.js
- Save happens automatically after mutations
- Clear separation: StateManager owns state, api.js handles HTTP

## Proposed StateManager API

```javascript
class StateManager {
  // Session lifecycle
  createSession(hpc, ide) → session
  getSession(hpc, ide) → session | null
  getSessionByKey(sessionKey) → session | null
  updateSession(hpc, ide, updates) → session
  clearSession(hpc, ide)

  // Session queries
  getAllSessions() → { [sessionKey]: session }
  getActiveSessions() → { [sessionKey]: session }  // running/pending only
  hasActiveSession(hpc, ide) → boolean

  // Active session (for UI focus)
  setActiveSession(hpc, ide)
  clearActiveSession()
  getActiveSession() → { hpc, ide } | null

  // Cluster health (already encapsulated)
  getClusterHealth() → health data

  // Polling info
  getPollingInfo() → polling metadata
}
```

## Changes Required

### 1. StateManager (lib/state.js)

Add methods:
```javascript
createSession(hpc, ide, initialProperties = {}) {
  const sessionKey = `${hpc}-${ide}`;
  const newSession = createIdleSession(ide);
  this.state.sessions[sessionKey] = Object.assign(newSession, initialProperties);
  this.save();
  return this.state.sessions[sessionKey];
}

updateSession(hpc, ide, updates) {
  const sessionKey = `${hpc}-${ide}`;
  const session = this.state.sessions[sessionKey];
  if (!session) throw new Error(`No session: ${sessionKey}`);
  Object.assign(session, updates);
  this.save();
  return session;
}

clearSession(hpc, ide) {
  const sessionKey = `${hpc}-${ide}`;
  delete this.state.sessions[sessionKey];  // Use delete, not null (cleaner, no null checks needed)
  this._clearActiveSessionIfMatches(hpc, ide);
  this.save();
}

getSession(hpc, ide) {
  return this.state.sessions[`${hpc}-${ide}`] || null;
}

getAllSessions() {
  return { ...this.state.sessions };
}
```

### 2. api.js

Replace direct state access:

**Before:**
```javascript
const state = stateManager.state;
state.sessions[sessionKey] = createIdleSession(ide);
session.status = 'pending';
session.jobId = result.jobId;
await stateManager.save();
```

**After:**
```javascript
// Single call with initial properties (one disk write)
const session = stateManager.createSession(hpc, ide, {
  status: 'pending',
  jobId: result.jobId,
});
```

### 3. Remove from api.js

- `const state = stateManager.state;` (line 152)
- `createIdleSession` import (use StateManager method instead)
- Direct `state.sessions[...]` access throughout
- Explicit `stateManager.save()` calls (auto-save in methods)

## Migration Steps

1. Add new methods to StateManager (backwards compatible)
2. Update api.js to use new methods one endpoint at a time
3. Remove direct state access from api.js
4. Remove `createIdleSession` export (internal only)
5. Make `state` private (or document as internal)

## Endpoints to Update

Search for `state.sessions` in api.js:
- `/api/launch` - creates/updates session
- `/api/stop` - clears session
- `/api/status` - reads sessions (use getAllSessions)
- `/api/cluster-status` - reads sessions for enrichment
- `/api/connect` - reads session
- `/api/reconnect` - updates session
- `/api/extend` - updates session

## Testing

- Existing tests should pass (methods encapsulate same logic)
- Add unit tests for new StateManager methods
- Integration test: launch → restart → verify session persisted

## Benefits

1. **No reference bugs** - api.js doesn't hold state reference
2. **Auto-save** - mutations automatically persist
3. **Testable** - can mock StateManager methods
4. **Clear ownership** - StateManager owns state, api.js handles HTTP
5. **Validation** - can add validation in StateManager methods

## Branch

Create: `feature/state-manager-encapsulation`
Base: `dev` (after merging `feature/batch-job-polling`)
