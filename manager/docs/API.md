# HPC Code Server Manager - API Reference

Base URL: `https://hpc.omeally.com/api`

## Endpoints

### Health Check

```
GET /api/health
```

Returns server health status.

**Response:**
```json
{
  "status": "ok"
}
```

---

### Get Cluster Status

```
GET /api/cluster-status
GET /api/cluster-status?refresh=true
```

Returns current status of both HPC clusters. Results are cached for 120 seconds by default.

**Query Parameters:**
- `refresh=true` - Force cache refresh

**Response:**
```json
{
  "gemini": {
    "vscode": {
      "status": "running",
      "jobId": "28692461",
      "node": "g-h-1-9-25",
      "ide": "vscode",
      "port": 8000,
      "releaseVersion": "3.22",
      "gpu": "a100",
      "timeLeft": "10:58:13",
      "timeLeftSeconds": 39493,
      "timeLeftHuman": "10h 58m",
      "timeLimit": "12:00:00",
      "timeLimitSeconds": 43200,
      "cpus": "4",
      "memory": "40G",
      "startTime": "2025-12-30T23:28:20",
      "shinyPort": 7777
    },
    "rstudio": { "status": "idle" },
    "jupyter": { "status": "idle" }
  },
  "apollo": {
    "vscode": { "status": "idle" },
    "rstudio": { "status": "idle" }
  },
  "releases": {
    "3.22": { "name": "Bioconductor 3.22", "ides": ["vscode", "rstudio", "jupyter"], "clusters": ["gemini", "apollo"] },
    "3.19": { "name": "Bioconductor 3.19", "ides": ["vscode", "rstudio"], "clusters": ["gemini", "apollo"] },
    "3.18": { "name": "Bioconductor 3.18", "ides": ["vscode", "rstudio"], "clusters": ["gemini", "apollo"] },
    "3.17": { "name": "Bioconductor 3.17", "ides": ["vscode", "rstudio"], "clusters": ["gemini", "apollo"] }
  },
  "defaultReleaseVersion": "3.22",
  "gpuConfig": {
    "gemini": {
      "a100": { "partition": "gpu-a100", "gres": "gpu:A100:1", "maxTime": "4-00:00:00", "mem": "256G" },
      "v100": { "partition": "gpu-v100", "gres": "gpu:V100:1", "maxTime": "8-00:00:00", "mem": "96G" }
    },
    "apollo": null
  },
  "ides": {
    "vscode": { "name": "VS Code", "port": 8000, "proxyPath": "/code/" },
    "rstudio": { "name": "RStudio", "port": 8787, "proxyPath": "/rstudio/" },
    "jupyter": { "name": "JupyterLab", "port": 8888, "proxyPath": "/jupyter/" }
  },
  "activeHpc": "gemini",
  "updatedAt": "2025-12-31T07:30:10.318Z",
  "cached": true,
  "cacheAge": 45,
  "cacheTtl": 120
}
```

**Status values:**
- `idle` - No active job
- `pending` - Job submitted, waiting for resources
- `running` - Job running on compute node

---

### Get Session Status

```
GET /api/status
```

Returns internal session state (less frequently used than cluster-status).

**Response:**
```json
{
  "sessions": {
    "gemini": {
      "status": "running",
      "jobId": "28692461",
      "node": "g-h-1-9-25",
      "cpus": "2",
      "memory": "40G",
      "walltime": "12:00:00",
      "startedAt": "2025-12-30T23:43:56.000Z"
    },
    "apollo": {
      "status": "idle"
    }
  },
  "activeHpc": "gemini",
  "config": {
    "defaultHpc": "gemini",
    "defaultCpus": "2",
    "defaultMem": "40G",
    "defaultTime": "12:00:00"
  }
}
```

---

### Launch Session (SSE Streaming)

```
GET /api/launch/:hpc/:ide/stream
```

Launches a new IDE session via Server-Sent Events. Progress events are streamed to the client.

**URL Parameters:**
- `hpc` - Cluster name (`gemini` or `apollo`)
- `ide` - IDE name (`vscode`, `rstudio`, or `jupyter`)

**Query Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cpus` | string | `2` | Number of CPUs (1-128) |
| `mem` | string | `40G` | Memory allocation (e.g., `40G`, `100M`) |
| `time` | string | `12:00:00` | Walltime (HH:MM:SS or D-HH:MM:SS) |
| `releaseVersion` | string | `3.22` | Bioconductor release (`3.22`, `3.19`, `3.18`, `3.17`) |
| `gpu` | string | (none) | GPU type (`a100`, `v100`, or empty for CPU) |

**SSE Events:**

Progress events during launch:
```
event: progress
data: {"step":"submitting","message":"Submitting SLURM job..."}

event: progress
data: {"step":"waiting","message":"Waiting for node allocation...","jobId":"28692461"}

event: progress
data: {"step":"starting","message":"Node assigned: g-h-1-9-25","node":"g-h-1-9-25"}

event: progress
data: {"step":"tunnel","message":"Establishing SSH tunnel..."}
```

Final success event:
```
event: complete
data: {"status":"running","jobId":"28692461","node":"g-h-1-9-25","hpc":"gemini","ide":"vscode","releaseVersion":"3.22","gpu":"a100","redirectUrl":"/code/"}
```

Reconnect event (session already running):
```
event: complete
data: {"status":"reconnected","jobId":"28692461","node":"g-h-1-9-25","hpc":"gemini","ide":"vscode","redirectUrl":"/code/"}
```

Error event:
```
event: error
data: {"error":"SSH connection failed","code":"SSH_ERROR"}
```

**Validation Errors (400):**
```json
{
  "error": "JupyterLab is only available on Bioconductor 3.22"
}
```

```json
{
  "error": "Release 3.22 is not available on cluster apollo"
}
```

---

### Switch Active HPC

```
POST /api/switch/:hpc
```

Switches the active tunnel to a different running session.

**URL Parameters:**
- `hpc` - Target cluster (`gemini` or `apollo`)

**Success Response (200):**
```json
{
  "status": "switched",
  "hpc": "apollo"
}
```

**Error Response (400):**
```json
{
  "error": "No running session on apollo"
}
```

---

### Stop Session

```
POST /api/stop
POST /api/stop/:hpc
POST /api/stop/:hpc/:ide
```

Stops the SSH tunnel and optionally cancels the SLURM job.

**URL Parameters:**
- `hpc` (optional) - Specific cluster to stop. Defaults to active HPC.
- `ide` (optional) - Specific IDE session to stop. Defaults to active IDE.

**Request Body:**
```json
{
  "cancelJob": true
}
```

**Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cancelJob` | boolean | `false` | Also cancel the SLURM job |

**Success Response (200):**
```json
{
  "status": "stopped",
  "hpc": "gemini"
}
```

---

## Error Handling

All errors return JSON with an `error` field:

```json
{
  "error": "Error message here",
  "details": { ... },
  "timestamp": "2025-12-31T07:30:10.318Z"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Bad Request - Invalid input |
| `429` | Too Many Requests - Operation locked |
| `500` | Internal Server Error |
| `502` | Bad Gateway - Proxy/SSH error |

### Custom Error Types

The API uses typed errors internally:

- `ValidationError` (400) - Input validation failed
- `LockError` (429) - Operation already in progress
- `SshError` (502) - SSH command failed
- `JobError` (500) - SLURM job error
- `TunnelError` (500) - SSH tunnel error
- `NotFoundError` (404) - Resource not found

---

## Rate Limiting

- **Launch operations** are locked per-cluster to prevent race conditions
- **Status endpoints** are cached (120s default) to reduce SSH load
- No explicit rate limiting - protected by operation locks

---

## Examples

### Launch VS Code session (SSE)

```bash
# Launch VS Code on Gemini with Bioconductor 3.22 and A100 GPU
curl -N "https://hpc.omeally.com/api/launch/gemini/vscode/stream?\
releaseVersion=3.22&gpu=a100&cpus=4&mem=40G&time=12:00:00"
```

### Launch RStudio session

```bash
# Launch RStudio on Apollo with Bioconductor 3.19
curl -N "https://hpc.omeally.com/api/launch/apollo/rstudio/stream?\
releaseVersion=3.19&cpus=2&mem=40G&time=8:00:00"
```

### Launch JupyterLab session

```bash
# JupyterLab only available on 3.22
curl -N "https://hpc.omeally.com/api/launch/gemini/jupyter/stream?\
releaseVersion=3.22&cpus=4&mem=80G&time=4:00:00"
```

### Check status

```bash
curl https://hpc.omeally.com/api/cluster-status
```

### Force refresh status

```bash
curl https://hpc.omeally.com/api/cluster-status?refresh=true
```

### Kill a specific IDE session

```bash
curl -X POST https://hpc.omeally.com/api/stop/gemini/vscode \
  -H "Content-Type: application/json" \
  -d '{"cancelJob": true}'
```
