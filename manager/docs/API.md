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
    "status": "running",
    "jobId": "28692461",
    "node": "g-h-1-9-25",
    "timeLeft": "10:58:13",
    "timeLeftSeconds": 39493,
    "timeLeftHuman": "10h 58m",
    "timeLimit": "12:00:00",
    "timeLimitSeconds": 43200,
    "cpus": "2",
    "memory": "40G",
    "startTime": "2025-12-30T23:28:20"
  },
  "apollo": {
    "status": "idle"
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

### Launch Session

```
POST /api/launch
```

Launches a new VS Code session or reconnects to existing job.

**Request Body:**
```json
{
  "hpc": "gemini",
  "cpus": "4",
  "mem": "40G",
  "time": "12:00:00"
}
```

**Parameters:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hpc` | string | `gemini` | Cluster name (`gemini` or `apollo`) |
| `cpus` | string | `2` | Number of CPUs (1-128) |
| `mem` | string | `40G` | Memory allocation (e.g., `40G`, `100M`) |
| `time` | string | `12:00:00` | Walltime (HH:MM:SS or D-HH:MM:SS) |

**Success Response (200):**
```json
{
  "status": "running",
  "jobId": "28692461",
  "node": "g-h-1-9-25",
  "hpc": "gemini"
}
```

**Reconnect Response (200):**
If session already running, reconnects to existing job:
```json
{
  "status": "connected",
  "hpc": "gemini",
  "jobId": "28692461",
  "node": "g-h-1-9-25"
}
```

**Error Responses:**

- `400 Bad Request` - Invalid input
```json
{
  "error": "Invalid CPU value: must be integer 1-128"
}
```

- `429 Too Many Requests` - Operation in progress
```json
{
  "error": "Operation already in progress"
}
```

- `500 Internal Server Error` - Launch failed
```json
{
  "error": "SSH connection failed"
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
```

Stops the SSH tunnel and optionally cancels the SLURM job.

**URL Parameters:**
- `hpc` (optional) - Specific cluster to stop. Defaults to active HPC.

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

### Launch a session with curl

```bash
curl -X POST https://hpc.omeally.com/api/launch \
  -H "Content-Type: application/json" \
  -d '{"hpc": "gemini", "cpus": "4", "mem": "40G", "time": "12:00:00"}'
```

### Check status

```bash
curl https://hpc.omeally.com/api/cluster-status
```

### Force refresh status

```bash
curl https://hpc.omeally.com/api/cluster-status?refresh=true
```

### Kill a job

```bash
curl -X POST https://hpc.omeally.com/api/stop/gemini \
  -H "Content-Type: application/json" \
  -d '{"cancelJob": true}'
```
