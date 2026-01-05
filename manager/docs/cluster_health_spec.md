# Cluster Health Status Indicator

> **Status**: Draft - awaiting user modifications

## Overview

Add a comprehensive cluster status indicator to the HPC Code Server Manager UI showing real-time cluster health information.

### Features

- **Cluster online/offline** - SSH reachability check
- **Queue availability** - Partition status and pending job count
- **Resource usage** - CPU/memory/GPU utilization across the cluster
- **Node health** - Available vs busy/down nodes per partition

## Current State

### Existing UI Structure

The UI already has status dot and text placeholders in `public/index.html`:

```html
<div class="cluster-status">
  <span class="status-dot" id="gemini-dot"></span>
  <span id="gemini-status-text">Loading...</span>
</div>
```

### Existing Patterns

Test scripts already use `sinfo` for node availability checks:

```bash
# Get idle V100 nodes
sinfo -p gpu-v100 -h -t mix,idle -o '%D' | awk '{s+=$1}END{print s+0}'

# Get idle A100 nodes
sinfo -p gpu-a100 -h -t mix,idle -o '%D' | awk '{s+=$1}END{print s+0}'
```

## SLURM Commands Reference

| Information | Command | Output |
|-------------|---------|--------|
| Partition status | `sinfo -p <partition> -h -o '%P %a %D %t'` | `main* up 60 idle` |
| Node counts by state | `sinfo -h -o '%P %D %t'` | `main 45 idle`, `main 12 mix` |
| Queue depth (pending) | `squeue -p <partition> -h -t PD \| wc -l` | `23` |
| Available nodes | `sinfo -p <partition> -h -t idle,mix -o '%D'` | `57` |
| Down/drained nodes | `sinfo -p <partition> -h -t down,drain -o '%D'` | `3` |
| Total nodes | `sinfo -p <partition> -h -o '%D' \| awk '{s+=$1}END{print s}'` | `60` |

### Single SSH Call Pattern

Combine multiple queries to minimize SSH overhead:

```bash
echo "===PARTITIONS===" && \
sinfo -h -o '%P %a %D %t' && \
echo "===PENDING===" && \
squeue -h -t PD | wc -l
```

## Implementation Plan

### Phase 1: Backend - HpcService Method

**File**: `services/hpc.js`

Add `getClusterHealth()` method:

```javascript
/**
 * Get cluster health status including partition info and queue depth
 * Single SSH call for efficiency
 * @returns {Promise<Object>} Cluster health data
 */
async getClusterHealth() {
  const cmd = `
    echo "===PARTITIONS===" && \
    sinfo -h -o '%P %a %D %t' 2>/dev/null && \
    echo "===PENDING===" && \
    squeue -h -t PD 2>/dev/null | wc -l
  `;

  try {
    const output = await this.sshExec(cmd);
    return this.parseClusterHealth(output);
  } catch (e) {
    return {
      online: false,
      error: e.message,
      lastChecked: Date.now()
    };
  }
}

/**
 * Parse sinfo/squeue output into structured data
 */
parseClusterHealth(output) {
  const sections = output.split(/===(\w+)===/);
  const partitions = {};
  let pendingJobs = 0;

  // Parse PARTITIONS section
  // Each line: "partition_name up/down node_count state"
  // e.g., "main* up 45 idle", "main up 12 mix"

  // Parse PENDING section
  // Single number: count of pending jobs

  return {
    online: true,
    partitions: {
      main: { idle: 45, mix: 12, down: 3, total: 60 },
      'gpu-v100': { idle: 8, mix: 4, down: 0, total: 12 },
      'gpu-a100': { idle: 2, mix: 2, down: 0, total: 4 }
    },
    pendingJobs,
    totalAvailable: /* sum of idle + mix across partitions */,
    totalDown: /* sum of down nodes */,
    lastChecked: Date.now()
  };
}
```

### Phase 2: Backend - API Endpoint

**File**: `routes/api.js`

Add `/api/cluster-health` endpoint:

```javascript
/**
 * GET /api/cluster-health
 * Returns health status for all clusters
 * Cached for 60 seconds to reduce SSH load
 */
router.get('/cluster-health', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  // Check cache first (similar to cluster-status pattern)
  if (!forceRefresh && healthCache.isValid()) {
    return res.json(healthCache.data);
  }

  const results = {};

  // Fetch in parallel for both clusters
  const promises = ['gemini', 'apollo'].map(async (cluster) => {
    try {
      const hpc = new HpcService(cluster);
      results[cluster] = await hpc.getClusterHealth();
    } catch (e) {
      results[cluster] = {
        online: false,
        error: e.message,
        lastChecked: Date.now()
      };
    }
  });

  await Promise.all(promises);

  healthCache.set(results);
  res.json(results);
});
```

### Phase 3: Frontend - Status Display

**File**: `public/js/launcher.js`

Add health fetching and UI updates:

```javascript
let clusterHealth = {};

async function fetchClusterHealth() {
  try {
    const res = await fetch('/api/cluster-health');
    clusterHealth = await res.json();
    updateClusterHealthUI();
  } catch (e) {
    console.error('Failed to fetch cluster health:', e);
  }
}

function updateClusterHealthUI() {
  for (const [cluster, health] of Object.entries(clusterHealth)) {
    const dot = document.getElementById(`${cluster}-dot`);
    const text = document.getElementById(`${cluster}-status-text`);

    if (!dot || !text) continue;

    // Remove existing classes
    dot.classList.remove('online', 'offline', 'degraded');

    if (!health.online) {
      dot.classList.add('offline');
      text.textContent = 'Offline';
    } else if (health.totalDown > 0) {
      dot.classList.add('degraded');
      text.textContent = `${health.totalAvailable} nodes · ${health.totalDown} down`;
    } else {
      dot.classList.add('online');
      text.textContent = `${health.totalAvailable} nodes available`;
    }

    // Add tooltip with details
    dot.title = formatHealthTooltip(health);
  }
}

function formatHealthTooltip(health) {
  if (!health.online) return `Offline: ${health.error}`;

  const lines = ['Partitions:'];
  for (const [name, info] of Object.entries(health.partitions)) {
    lines.push(`  ${name}: ${info.idle} idle, ${info.mix} busy, ${info.down} down`);
  }
  lines.push(`Pending jobs: ${health.pendingJobs}`);
  return lines.join('\n');
}
```

### Phase 4: Frontend - Styling

**File**: `public/css/style.css`

```css
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 6px;
  background-color: var(--text-muted);
}

.status-dot.online {
  background-color: #22c55e;  /* Green */
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}

.status-dot.offline {
  background-color: #ef4444;  /* Red */
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
}

.status-dot.degraded {
  background-color: #f59e0b;  /* Yellow/Orange */
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.5);
}

.cluster-status {
  display: flex;
  align-items: center;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
```

### Phase 5: Polling Integration

Health checks should run less frequently than session status:

- Session status: every 5-15 seconds (handled by StateManager)
- Cluster health: every 60 seconds

```javascript
// In launcher.js initialization
setInterval(fetchClusterHealth, 60000);  // Every 60s
fetchClusterHealth();  // Initial fetch
```

## Files to Modify

| File | Changes |
|------|---------|
| `services/hpc.js` | Add `getClusterHealth()` and `parseClusterHealth()` methods |
| `routes/api.js` | Add `/api/cluster-health` endpoint with caching |
| `public/js/launcher.js` | Add `fetchClusterHealth()`, UI update functions |
| `public/css/style.css` | Add status dot styling (online/offline/degraded) |
| `public/index.html` | Minor tweaks if needed for tooltip display |

## UI Mockups

### Expanded View (on hover/click)

```
┌─────────────────────────────────────┐
│ Gemini                    ● Online  │
│ ├─ main: 45 idle, 12 busy, 3 down   │
│ ├─ gpu-v100: 8 idle, 4 busy         │
│ └─ gpu-a100: 2 idle, 2 busy         │
│ Pending jobs: 23                    │
└─────────────────────────────────────┘
```

### Compact View (default)

```
┌─────────────────────────────────────┐
│ Gemini                    ● Online  │
│ 57 nodes available · 23 pending     │
└─────────────────────────────────────┘
```

### Offline State

```
┌─────────────────────────────────────┐
│ Gemini                    ● Offline │
│ Connection failed                   │
└─────────────────────────────────────┘
```

### Degraded State

```
┌─────────────────────────────────────┐
│ Gemini                   ● Degraded │
│ 54 nodes available · 3 down         │
└─────────────────────────────────────┘
```

## API Response Format

```json
{
  "gemini": {
    "online": true,
    "partitions": {
      "main": { "idle": 45, "mix": 12, "down": 3, "total": 60 },
      "gpu-v100": { "idle": 8, "mix": 4, "down": 0, "total": 12 },
      "gpu-a100": { "idle": 2, "mix": 2, "down": 0, "total": 4 }
    },
    "pendingJobs": 23,
    "totalAvailable": 57,
    "totalDown": 3,
    "lastChecked": 1704394800000
  },
  "apollo": {
    "online": true,
    "partitions": {
      "defq": { "idle": 30, "mix": 18, "down": 2, "total": 50 }
    },
    "pendingJobs": 15,
    "totalAvailable": 48,
    "totalDown": 2,
    "lastChecked": 1704394800000
  }
}
```

## Testing Checklist

- [ ] Cluster shows "Online" when SSH succeeds
- [ ] Cluster shows "Offline" when SSH fails
- [ ] Cluster shows "Degraded" when nodes are down
- [ ] Pending job count displays correctly
- [ ] Tooltip shows partition breakdown
- [ ] Health refreshes every 60 seconds
- [ ] Cache prevents excessive SSH calls
- [ ] Both clusters fetch in parallel

## Notes for User Modifications

> **TODO**: User to specify any modifications to this spec before implementation.

Potential areas for customization:
- Which partitions to display per cluster
- Polling interval (currently 60s)
- Whether to show detailed or compact view by default
- Additional metrics to display
- Color scheme for status indicators
