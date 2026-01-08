# HPC Code Server User Guide

Quick start and tips for using VS Code, RStudio, and JupyterLab on HPC clusters.

## Getting Started

1. Navigate to the HPC Code Server launcher
2. Select your cluster (Gemini or Apollo)
3. Choose your IDE and Bioconductor release
4. Adjust resources (CPUs, memory, time) as needed
5. Click **Launch**

## Best Experience: Install as App (PWA)

For the best experience, install HPC Code Server as a Progressive Web App:

1. In Chrome/Edge, click the **install icon** in the address bar (or Menu → "Install...")
2. Click "Install" in the prompt
3. The app opens in its own window with better keyboard shortcut support

**Why PWA?** Browser tabs capture certain keyboard shortcuts (like Ctrl+N, Ctrl+W) before they reach VS Code. Installing as a PWA gives the IDE more control over shortcuts.

## Keyboard Shortcuts

### Browser Limitations

Some VS Code shortcuts don't work in browser mode because they're reserved by the browser:

| Shortcut | Browser Action | VS Code Action |
|----------|---------------|----------------|
| `Ctrl+N` | New browser window | New file |
| `Ctrl+W` | Close browser tab | Close editor |
| `Ctrl+T` | New browser tab | Go to symbol |
| `Ctrl+Shift+N` | New incognito window | - |

**Solutions:**

1. **Install as PWA** (recommended) - unlocks most shortcuts
2. **Use Command Palette** (`Ctrl+Shift+P` or `F1`) - type any action
3. **Use VS Code alternatives** that work in browser:
   - `Ctrl+K Ctrl+W` - close editor (works)
   - `Ctrl+O` - open file (works)
   - `Ctrl+Shift+E` - file explorer (works)

### R Development Shortcuts

Pre-configured for R development (see [IDE_CUSTOMIZATIONS.md](IDE_CUSTOMIZATIONS.md)):

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+,` | Insert `<-` (assignment) |
| `Ctrl+Shift+M` | Insert `\|>` (pipe) |
| `Ctrl+Shift+S` | `str()` on selection |
| `Ctrl+Shift+H` | `head()` on selection |
| `Ctrl+Shift+G` | `dplyr::glimpse()` on selection |
| `Ctrl+\`` | Toggle terminal/editor |

## Resource Allocation

### Partition Limits

Each cluster has resource limits per partition:

**Gemini:**
| Partition | Max CPUs | Max Memory | Max Time |
|-----------|----------|------------|----------|
| compute | 44 | 625G | 14 days |
| gpu-a100 | 34 | 375G | 4 days |
| gpu-v100 | 128 | 96G | 8 days |

**Apollo:**
| Partition | Max CPUs | Max Memory | Max Time |
|-----------|----------|------------|----------|
| fast,all | 128 | 500G | 14 days |

### Tips

- **Start small**: Request only what you need - it's easier to get resources
- **Memory format**: Use `G` or `M` suffix (e.g., `40G`, `100M`)
- **Time format**: `HH:MM:SS` or `D-HH:MM:SS` (e.g., `12:00:00`, `1-00:00:00`)
- **GPU jobs**: Select GPU type in the accelerator toggle - limits adjust automatically

## Session Management

### Reconnecting

If you navigate away or your browser disconnects:
1. Return to the launcher
2. Click **Connect** on your running session
3. Your work is preserved (the SLURM job keeps running)

### Stopping Jobs

Click **Stop** to cancel your SLURM job and free resources for others.

### Session Timeout

Jobs automatically end when their walltime expires. Save your work before the timer runs out!

## Python and Reticulate

### Default Configuration

Python is pre-configured to use the container's Python with cluster-managed packages:

- `RETICULATE_PYTHON=/usr/bin/python3` - container Python
- `PYTHONPATH` - points to curated cluster packages (Bioc 3.22+)

When you call `library(reticulate)`, it uses the system Python directly - no virtualenv is created.

### Installing Custom Python Packages

To install packages not in the cluster library, create a virtualenv:

```r
library(reticulate)
virtualenv_create("my-project")
use_virtualenv("my-project")
py_install("some-package")
```

This keeps your custom packages isolated while still accessing cluster packages via `PYTHONPATH`.

## Troubleshooting

### "Connection lost" or blank screen

1. Check if your SLURM job is still running (look at the launcher)
2. Try clicking **Connect** again
3. If the job ended, launch a new session

### Extensions not loading

VS Code extensions are stored in your home directory. First launch may take longer as extensions initialize.

### Slow performance

- Reduce CPU/memory requests if you're not using them
- Check cluster health bars - high utilization means contention
- Consider using Apollo if Gemini is busy (or vice versa)

## See Also

- [IDE_CUSTOMIZATIONS.md](IDE_CUSTOMIZATIONS.md) - Default settings and keybindings
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical documentation
