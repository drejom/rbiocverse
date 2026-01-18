# {{icon:rocket}} Quick Start

Get up and running in minutes.

## Launch Your First Session

1. **Select your cluster** - Gemini (GPU available) or Apollo (CPU-focused)
2. **Choose your IDE** - VS Code, RStudio, or JupyterLab
3. **Pick a Bioconductor release** - Determines R/Python versions
4. **Adjust resources** if needed (defaults work for most tasks)
5. **Click Launch** - Wait for the job to start

## Current Cluster Status

| Cluster | Status | CPU | Memory | Nodes |
|---------|--------|-----|--------|-------|
| Gemini  | {{gemini.online ? "🟢 Online" : "🔴 Offline"}} | {{gemini.cpus.percent}}% | {{gemini.memory.percent}}% | {{gemini.nodes.percent}}% |
| Apollo  | {{apollo.online ? "🟢 Online" : "🔴 Offline"}} | {{apollo.cpus.percent}}% | {{apollo.memory.percent}}% | {{apollo.nodes.percent}}% |

**Live health bars:**

:::widget ClusterHealth cluster="gemini":::

:::widget ClusterHealth cluster="apollo":::

## Check Cluster Health First

Look at the health indicators before launching:

- **Green bars** = resources available, fast queue
- **Green sparklines** = utilization decreasing (good time to launch)
- **Red bars** = cluster busy, may queue longer

## Install as App (Recommended)

For the best experience, install as a Progressive Web App:

1. In Chrome/Edge, click the **install icon** in the address bar
2. Click "Install" in the prompt
3. The app opens in its own window with better keyboard support

**Why PWA?** Browser tabs capture shortcuts like `Ctrl+N` and `Ctrl+W`. PWA mode gives your IDE full keyboard access.

## Reconnecting

If you navigate away or disconnect:

1. Return to the launcher
2. Your running session appears on the cluster card
3. Click **Connect** to resume

Your work is preserved - the SLURM job keeps running on the cluster.

## Tips

- **Start small** - Request only what you need. Smaller jobs queue faster.
- **Check both clusters** - If one is busy, try the other.
- **Save often** - Jobs end when walltime expires.
- **Stop when done** - Free resources for others.
