# Multi-User Review: Port Management, Tunnels, and Session Concurrency

This review assesses the codebase's readiness for multi-user environments, specifically focusing on how port management, SSH tunnels, and session concurrency are handled. The goal is to identify potential collision points and evaluate the robustness of the current session management for concurrent users, drawing parallels to systems like JupyterHub.

## Executive Summary

The codebase demonstrates a **strong foundation for multi-user support** in its session management and authentication layers. Sessions are correctly keyed by `user-hpc-ide`, and user-specific SSH keys are managed. Crucially, the system incorporates **dynamic port discovery** on the HPC compute nodes and **per-IDE tunnel management** on the manager side, which are essential for preventing port collisions between concurrent users.

However, the current proxy configuration in `server.js` and the `TunnelService` design still exhibit characteristics that are **not fully multi-user concurrent at the manager level for the same IDE type**. Specifically, the `http-proxy` instances are configured to target fixed local ports (`127.0.0.1:PORT`), and the `TunnelService` actively stops existing tunnels for the *same IDE type* when a new one is started, implying a single active tunnel per IDE type *across all users* on the manager. This design will lead to collisions and unexpected disconnections for concurrent users trying to access the same IDE type (e.g., two users both trying to use VS Code).

To achieve true multi-user concurrency, the manager needs to dynamically allocate local ports for each user's tunnel and configure the `http-proxy` instances to target these user-specific local ports.

## Detailed Findings

### 1. Session Management (`lib/state.js`, `lib/db/sessions.js`, `routes/api.js`)

**Strengths:**

*   **User-Specific Session Keys:** Sessions are uniquely identified by a composite key `user-hpc-ide` (`buildSessionKey` in `lib/state.js` and `lib/db/sessions.js`). This is fundamental for distinguishing sessions belonging to different users.
*   **Database Persistence:** Active sessions are stored in `active_sessions` table (`lib/db/sessions.js`), ensuring persistence across manager restarts and providing a centralized, multi-user-aware session store.
*   **User Context in API:** `routes/api.js` correctly extracts the `username` from `req.user` (after `requireAuth` middleware) for all session-related operations (`launch-session`, `stop-session`, `set-active-session`). This ensures that actions are performed on the correct user's session.
*   **`StateManager` Multi-User Awareness:** The `StateManager` (`lib/state.js`) methods like `getSessionsForUser`, `getActiveSessionsForUser`, `hasActiveSession` all accept a `user` parameter, indicating a design intent for multi-user support.
*   **Adaptive Polling:** The `StateManager`'s adaptive job polling (`refreshAllSessions`) uses `hpcService.getAllJobs(null)` which, in the current `hpc.js`, queries for `config.hpcUser`. This needs to be adapted for multi-user to query for *all* active users' jobs.

**Areas for Improvement / Concerns:**

*   **`config.hpcUser` Default:** In `lib/state.js` and `routes/api.js`, `user || config.hpcUser` is used as the effective user. While this works for single-user mode, it's crucial that in a multi-user environment, `config.hpcUser` is *never* used as a fallback for `user` if `req.user` is available. The comment `// Future: return req.session?.user || req.user?.username || config.hpcUser;` in `routes/api.js` indicates awareness, but this needs to be fully implemented.
*   **`StateManager.refreshAllSessions` for Multi-User:** The current `refreshAllSessions` in `lib/state.js` calls `hpcService.getAllJobs(null)`. The `hpcService.getAllJobs` method in `services/hpc.js` then uses `squeue --user=${effectiveUser}`. For true multi-user, `StateManager` would need to iterate through *all* users with active sessions and call `hpcService.getAllJobs(user)` for each, or `hpcService.getAllJobs` would need to be able to query for multiple users or all users. The current implementation of `getAllJobs` in `hpc.js` is designed for a single `effectiveUser`. This is a **major bottleneck for multi-user job status polling**.
*   **`StateManager.activeSession`:** The `activeSession` field in `StateManager.state` is a single object `{ user, hpc, ide }`. This implies that only one session can be "active" *globally* at any given time, which might be a limitation for users who switch between multiple active sessions or for a manager serving multiple users. This needs to be `activeSessions: { [user]: { hpc, ide } }` or similar.

### 2. Port Management and Tunnels (`server.js`, `config/index.js`, `services/tunnel.js`, `services/hpc.js`)

**Critical Collision Points:**

*   **Fixed Local Proxy Ports:** In `server.js`, the `http-proxy` instances (`vscodeProxy`, `rstudioProxy`, `jupyterProxy`, `liveServerProxy`, `shinyProxy`) are configured with fixed `target` ports (e.g., `http://127.0.0.1:8000` for VS Code). This is the **most significant collision point**. If two users concurrently launch VS Code, both their tunnels will attempt to forward to `127.0.0.1:8000` on the manager, leading to "Address already in use" errors or one user hijacking the other's session.
*   **`TunnelService.stopByIde` Logic:** The `TunnelService.stopByIde(ide)` method actively stops *any* existing tunnel for a given IDE type (e.g., VS Code) across all clusters. This is explicitly designed to "free the local port before starting a new tunnel," which confirms the single-active-tunnel-per-IDE-type limitation on the manager. This will cause disconnections for other users if a new user launches the same IDE type.

**Strengths:**

*   **Dynamic Remote Port Discovery:** `services/hpc.js`'s `buildPortFinderScript` and `getIdePort` are excellent. They ensure that the IDE on the HPC compute node finds an *available remote port* (starting from a default) and writes it to a file. This prevents collisions on the *compute node* if multiple users land on the same node. This is a crucial piece of the multi-user puzzle.
*   **Per-User SSH Keys:** `services/hpc.js` uses `getKeyFilePath` and `getUserPrivateKey` to ensure that SSH connections are made using the authenticated user's specific SSH key, providing proper authentication and isolation on the HPC.
*   **`additionalPorts` Configuration:** `config/index.js` allows defining additional ports to forward for VS Code, which is useful for dev servers (Live Server, Shiny).

**Areas for Improvement / Concerns:**

*   **Dynamic Local Proxy Ports:** To support true multi-user concurrency, the `http-proxy` instances in `server.js` must be dynamically configured to target a *unique local port* for each user's tunnel.
    *   This would require the `TunnelService.start` method to dynamically allocate an available local port on the manager for each tunnel.
    *   The `http-proxy` instances would then need to be created dynamically or configured to use a mapping of `user-hpc-ide` to `localPort`.
    *   The frontend would need to be aware of the dynamically allocated local port to construct the correct proxy URL (e.g., `/code/<dynamic_port>/`).
*   **`TunnelService` Scope:** The `TunnelService` currently manages a single `Map` of `this.tunnels` keyed by `hpc-ide`. For multi-user, this map needs to be keyed by `user-hpc-ide` or `user-localPort` to manage multiple tunnels concurrently.
*   **Proxy Path Ambiguity:** The current proxy paths (`/code`, `/rstudio`, `/jupyter`) are fixed. For multi-user, these would need to be user-specific (e.g., `/user/<username>/code/`) or dynamically routed based on the active session. JupyterHub solves this by having a `/user/<username>/` prefix for all user services.
*   **WebSocket Upgrades:** The `server.on('upgrade', ...)` logic in `server.js` currently checks `hasRunningSession()` (which is based on `state.sessions` and `state.activeSession`) and then proxies to fixed `vscodeProxy.ws`, `rstudioProxy.ws`, etc. This needs to be updated to route WebSocket connections to the correct *user-specific* tunnel based on the request context (e.g., a user-specific path or a session ID in the URL).

### 3. User Isolation

**Strengths:**

*   **Per-User SSH Keys:** As noted, SSH connections use user-specific keys, ensuring that actions on the HPC are performed under the correct user's identity.
*   **SLURM Job Submission:** `hpc.js`'s `submitJob` and `getAllJobs` use `--user=${effectiveUser}` in `sbatch` and `squeue` commands, ensuring jobs are submitted and queried under the correct user.
*   **IDE Configuration:** `hpc.js` builds IDE-specific scripts that set up user-specific directories (`$HOME/.vscode-slurm`, `$HOME/.rstudio-slurm`, `$HOME/.jupyter-slurm`) and environment variables (`R_LIBS_USER`, `JUPYTER_DATA_DIR`), ensuring user environments are isolated on the compute nodes.

**Areas for Improvement / Concerns:**

*   **Shared `config.hpcUser`:** The `config.hpcUser` is still used as a fallback in several places. This needs to be completely removed or replaced with the authenticated user's identity in a multi-user context.
*   **`StateManager.fetchUserAccount`:** This method currently fetches the account for `null` (which resolves to `config.hpcUser`). In a multi-user setup, it needs to fetch and cache accounts for *each* authenticated user.

### 4. Comparison to JupyterHub Model

The current architecture shares some similarities with JupyterHub but also has key differences that need to be addressed for full multi-user concurrency:

**Similarities:**

*   **Centralized Orchestration:** The `manager` acts as a central point for launching and managing user sessions on HPC resources, similar to JupyterHub's Hub component.
*   **Per-User SSH:** The use of per-user SSH keys for authentication to HPC is analogous to how JupyterHub might use user credentials for spawning.
*   **Dynamic Remote Port Allocation:** The `buildPortFinderScript` is a good solution for dynamic port allocation on the compute nodes, similar to how Jupyter servers might bind to an available port.
*   **Proxying:** The use of `http-proxy` to forward traffic to user sessions is a core pattern in JupyterHub.

**Key Differences / Missing Multi-User Features:**

*   **Dynamic Local Port Allocation:** JupyterHub typically allocates a unique local port for each user's spawned server on the Hub machine. The current system uses fixed local ports for proxies, which is a single-user bottleneck.
*   **User-Specific Proxy Paths:** JupyterHub uses URL prefixes like `/user/<username>/` to route requests to the correct user's server. The current system uses fixed paths like `/code/`, `/rstudio/`, which would collide.
*   **Proxy Routing Logic:** The `server.js` proxy logic needs to be enhanced to dynamically route requests based on the authenticated user and their active session's dynamically allocated local port.
*   **`StateManager.activeSession`:** JupyterHub doesn't have a single "active session" concept; it manages multiple concurrent servers for multiple users. The `activeSession` in `StateManager` needs to be re-evaluated for multi-user.
*   **`TunnelService` Design:** The `TunnelService` needs to be able to manage multiple concurrent tunnels, each with its own dynamically allocated local port, without stopping other users' tunnels.

## Recommendations for Multi-User Concurrency

To fully support multiple concurrent users, the following architectural changes are recommended:

1.  **Dynamic Local Port Allocation for Tunnels:**
    *   Modify `TunnelService.start` to dynamically find an available local port on the manager machine for each new tunnel.
    *   Store this allocated local port within the `session` object in `StateManager`.
    *   Update `TunnelService` to manage tunnels keyed by `user-hpc-ide` and their allocated local port.

2.  **Dynamic Proxy Configuration:**
    *   Instead of fixed `vscodeProxy`, `rstudioProxy`, etc., create a single, more generic proxy instance or dynamically create `http-proxy` instances.
    *   Implement a custom proxy routing middleware in `server.js` that, for each incoming request:
        *   Identifies the authenticated user (`req.user.username`).
        *   Looks up the user's active session(s) in `StateManager` to find the dynamically allocated local port for the target IDE.
        *   Dynamically sets the `target` of the `http-proxy` to `http://127.0.0.1:<user_specific_local_port>`.
    *   This might involve modifying the URL paths to include user/session identifiers (e.g., `/user/<username>/code/`).

3.  **Update `StateManager.refreshAllSessions`:**
    *   Modify `StateManager.refreshAllSessions` to iterate through *all* active users (from `dbUsers.getAllUsers()`) and call `hpcService.getAllJobs(user)` for each, or enhance `hpcService.getAllJobs` to query for all users' jobs in a single SSH call (if SLURM allows).

4.  **Refactor `StateManager.activeSession`:**
    *   Change `StateManager.state.activeSession` from a single object to a map keyed by `username` (e.g., `activeSessions: { [username]: { hpc, ide } }`). This allows each user to have their own "active" session.

5.  **Frontend URL Generation:**
    *   The frontend (`ui/src/components/ClusterCard.jsx`, etc.) will need to generate dynamic URLs for connecting to IDEs, incorporating the user-specific local port or proxy path.

6.  **Remove `config.hpcUser` Fallbacks:** Ensure that all instances of `user || config.hpcUser` are replaced with the actual authenticated `user` in a multi-user context.

By implementing these changes, the application can transition from a single-user model (with multi-user *potential*) to a robust multi-user platform capable of handling concurrent sessions without collisions.
