# User Interface Guide

Complete guide to the HPC Code Server launcher interface.

## Overview

The launcher displays cluster cards for each available HPC cluster. Each card shows cluster health, any running sessions, and a form to launch new IDE sessions.

## Cluster Card

### Header

```
Gemini  [health indicators]                    ● RStudio running
```

- **Cluster name** - The HPC cluster (Gemini, Apollo)
- **Health indicators** - Visual bars showing cluster utilization (see below)
- **Session status** - Shows if you have a running session on this cluster

### Health Indicators

Each cluster displays 4 health indicators in the header:

| Icon | Metric | What it means |
|------|--------|---------------|
| Gauge | **Fairshare** | Your queue priority (higher = better). Based on recent usage vs allocation |
| CPU/GPU | **CPU/GPU** | Processor utilization. Shows CPU by default; shows GPU when A100/V100 selected |
| Memory | **Memory** | RAM utilization across the cluster |
| Server | **Nodes** | Compute node availability |

#### Health Bar Colors

- **Green** - Low utilization (<60%) - resources readily available
- **Yellow/Orange** - Moderate utilization (60-85%) - some wait time possible
- **Red** - High utilization (>85%) - expect longer queue times

#### Sparkline Trends

Above each health bar is a small trend line showing the 24-hour pattern:

- **Line shape** - Shows how utilization has varied over the past 24 hours
- **Line color** - Based on the **recent 2-hour trend**:
  - **Green** - Usage decreasing (good time to launch)
  - **Yellow** - Stable
  - **Red** - Usage increasing (may face longer waits)

The sparkline helps answer "should I launch now?" - a green trend means conditions are improving.

### Running Session Panel

When you have an active session, it appears in a highlighted box:

```
┌─────────────────────────────────────────────┐
│ RStudio                           g-c-1-4-07│
│ ◐ 10h 12m   ⚙ 2   ▭ 40G                     │
│ [Connect]  [Stop]                           │
└─────────────────────────────────────────────┘
```

- **IDE name** - The running IDE (VS Code, RStudio, JupyterLab)
- **Node** - The compute node running your job (e.g., g-c-1-4-07)
- **Time remaining** - Countdown showing walltime left (pie chart + text)
- **Resources** - CPUs and memory allocated to your job
- **Connect** - Open your IDE in a new tab
- **Stop** - Cancel the SLURM job and free resources

## Launch Form

### Bioconductor Release

```
🧬 Bioconductor  [3.22 ▼]
```

Select the Bioconductor/R version. Each release includes:
- Specific R version
- Pre-installed Bioconductor packages
- Matching Python environment

### IDE Selection

```
[ VS Code ]  [ RStudio ]  [ JupyterLab ]
```

Choose your development environment:

| IDE | Best for |
|-----|----------|
| **VS Code** | General development, Python, multi-language projects |
| **RStudio** | R development, Shiny apps, R Markdown |
| **JupyterLab** | Interactive notebooks, data exploration |

### Resource Inputs

```
CPUs        Memory      Time
[ 2    ]    [ 40G  ]    [ 12:00:00 ]
```

- **CPUs** - Number of CPU cores (1-128 depending on partition)
- **Memory** - RAM allocation with unit suffix (e.g., `40G`, `100M`)
- **Time** - Maximum job duration in `HH:MM:SS` or `D-HH:MM:SS` format

**Tips:**
- Start small - smaller requests queue faster
- You can always stop and relaunch with different resources
- Check partition limits in cluster tooltips

### Accelerator Toggle (Gemini only)

```
Accelerator
[ CPU ]  [ A100 ]  [ V100 ]
```

Select compute type:

| Option | Description | Use case |
|--------|-------------|----------|
| **CPU** | Standard compute partition | General workloads |
| **A100** | NVIDIA A100 GPUs (newest) | Deep learning, large models |
| **V100** | NVIDIA V100 GPUs | ML training, CUDA workloads |

When you select a GPU type:
- The CPU health indicator changes to show GPU utilization
- Resource limits adjust to match the GPU partition
- Your job will be allocated 1 GPU

### Launch Button

```
[▷ Launch VS Code]
```

Submits a SLURM job with your selected resources. Progress is shown during:
1. Job submission
2. Queue wait
3. Node startup
4. Tunnel establishment

## Session States

| Status | Meaning |
|--------|---------|
| **No session** | No active job on this cluster |
| **Pending** | Job submitted, waiting in queue |
| **Running** | Job active, IDE accessible |
| **Stopping** | Job being cancelled |

## Multiple Sessions

You can run sessions on multiple clusters simultaneously (e.g., RStudio on Gemini and VS Code on Apollo). Each cluster card manages its own session independently.

## Tips for Best Experience

### Check Health Before Launching

- **Green bars + green sparklines** = ideal time to launch
- **Red bars + red sparklines** = cluster is busy and getting busier
- **Fairshare matters** - if your fairshare is low (red), your jobs queue longer

### Resource Selection

- **2-4 CPUs** is usually sufficient for interactive work
- **40G memory** handles most R/Python workloads
- **12 hours** is a good default; extend if needed
- **GPU jobs** queue separately - GPU queues may be shorter than CPU queues

### Reconnecting

If your browser disconnects or you navigate away:
1. Return to the launcher
2. Your session panel shows your running job
3. Click **Connect** to reopen the IDE

Your work is preserved - the SLURM job continues running on the cluster.

### When to Stop

- **Stop** your job when done to free resources for others
- Jobs automatically end when walltime expires
- Save your work before the timer runs out

## Troubleshooting

### Health indicators not showing

- Cluster may be unreachable (network issue)
- Wait for next poll (up to 30 minutes) or refresh the page

### "Pending" for a long time

- Cluster is busy - check health indicators
- Try requesting fewer resources
- Consider using the other cluster if available

### IDE won't connect

- Click **Connect** again (tunnel may have dropped)
- Check if the job is still running (look at time remaining)
- If time expired, launch a new session

### Slow IDE performance

- Request more CPUs/memory
- Check if you're running memory-intensive operations
- Large files or many open tabs can slow VS Code

## Help Panel

Click the **?** icon (top-right) to open built-in documentation.

### Features

- **Search** - Find topics across all help sections
- **Navigation** - Tabbed sections: Quick Start, Environment, IDEs, Support
- **Live data** - Real-time cluster status embedded in help content
- **Keyboard** - Press `Escape` to close

### Live Cluster Data

The Quick Start section displays current cluster metrics:
- Online/offline status with emoji indicators
- CPU, memory, and node utilization percentages
- Live health bars matching the main launcher

This helps you decide which cluster to use without leaving the help panel.

## See Also

- [USER_GUIDE.md](USER_GUIDE.md) - Keyboard shortcuts, Python/R setup
- [IDE_CUSTOMIZATIONS.md](IDE_CUSTOMIZATIONS.md) - Default settings and keybindings
- [HELP_SYSTEM.md](HELP_SYSTEM.md) - Help system architecture (for developers)
