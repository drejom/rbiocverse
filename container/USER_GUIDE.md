# User Guide

This guide covers what's available in the rbiocverse container and how to use it for data science workflows.

## Getting Started

### HPC Interactive Session
```bash
~/bin/ij 4  # Request 4 CPUs
```

### HPC Batch Job
```bash
sbatch /packages/singularity/shared_cache/rbioc/rbioc322.job
```

### Docker (Local)
```bash
docker run -it --rm ghcr.io/drejom/vscode-rbioc:latest /bin/bash
```

## Quick Reference

| Category | Tools |
|----------|-------|
| **Languages** | R 4.5, Python 3.12, GNU Octave, Bash, SAS (via server) |
| **IDEs** | JupyterLab, VS Code (serve-web/tunnels), RStudio |
| **Package Managers** | pak (R), pip (Python), pixi (conda-forge) |
| **Kernels** | IRkernel, ipykernel, octave_kernel, SoS (polyglot) |

## JupyterLab

JupyterLab comes pre-configured with extensions for a productive data science experience.

### Available Kernels

| Kernel | Language | Use Case |
|--------|----------|----------|
| **Python 3** | Python | General Python, SCverse single-cell analysis |
| **R (ir)** | R | R analysis, Bioconductor workflows |
| **Octave** | GNU Octave | MATLAB-compatible scripts (free alternative) |
| **SoS** | Multi-language | Polyglot notebooks mixing R, Python, Bash |
| **Bash** | Shell | Command-line workflows |
| **SAS** | SAS | Requires external SAS server connection |

### Code Intelligence (LSP)

The container includes **jupyterlab-lsp** with full Python language server support:

- **Autocomplete** - Context-aware suggestions as you type
- **Go to Definition** - Jump to function/class definitions
- **Hover Documentation** - See docstrings on hover
- **Linting** - Real-time error detection
- **Rename** - Refactor symbols across files

### Code Formatting

Format Python code automatically with **black** and **isort**:

1. Select code or entire cell
2. Right-click → "Format Cell" or use keyboard shortcut
3. Code is formatted according to black style

### Productivity Extensions

| Extension | What it Does |
|-----------|--------------|
| **Execute Time** | Shows execution time for each cell |
| **Spellchecker** | Highlights misspelled words in markdown |
| **Resource Usage** | Displays CPU/RAM usage in status bar |
| **Git** | Visual git interface (stage, commit, diff) |
| **Table of Contents** | Navigate long notebooks by headings |

### Jupytext - Notebooks as Scripts

Save notebooks as plain Python (.py) or R Markdown (.Rmd) files for better version control:

1. File → Save Notebook As → choose format
2. Or use command palette: "Jupytext: Pair notebook"

Benefits:
- Cleaner git diffs (no JSON/base64 noise)
- Edit in any text editor
- Sync automatically with .ipynb

## Proxying Dev Servers (Shiny, Streamlit, Gradio)

The container includes **jupyter-server-proxy** for accessing web applications through JupyterLab's authenticated session.

### Shiny Apps (R)

```r
# In R console or notebook
library(shiny)
runApp("my_app/", port = 3838, host = "0.0.0.0")
```

Access at: `https://<jupyter-url>/proxy/3838/`

### Streamlit Apps (Python)

```bash
# In terminal
streamlit run app.py --server.port 8501 --server.address 0.0.0.0
```

Access at: `https://<jupyter-url>/proxy/8501/`

### Gradio Interfaces (Python)

```python
import gradio as gr

demo = gr.Interface(fn=my_function, inputs="text", outputs="text")
demo.launch(server_port=7860, server_name="0.0.0.0")
```

Access at: `https://<jupyter-url>/proxy/7860/`

### Common Ports

| Application | Default Port | Proxy URL |
|-------------|--------------|-----------|
| Shiny | 3838 | `/proxy/3838/` |
| Streamlit | 8501 | `/proxy/8501/` |
| Gradio | 7860 | `/proxy/7860/` |
| Bokeh | 5006 | `/proxy/5006/` |
| Panel | 5006 | `/proxy/5006/` |

## SoS Polyglot Notebooks

Run multiple languages in a single notebook with data exchange between them.

### Quick Start

1. Create new notebook with SoS kernel
2. Change cell kernel using dropdown (top-right of cell)
3. Pass data between languages using `%get` and `%put` magics

### Example: R to Python

```python
# Cell 1 (R kernel)
df <- data.frame(x = 1:5, y = rnorm(5))
```

```python
# Cell 2 (Python kernel)
%get df --from R
print(df.describe())
```

### Supported Languages

- Python 3
- R
- Bash
- SAS (requires server)
- MATLAB/Octave (via sos-matlab)

## pixi - Package Manager

**pixi** is a fast conda alternative for installing additional packages. It's 10x faster than conda and supports both conda-forge and PyPI packages.

### Quick Start

```bash
# Initialize a new project
pixi init my_project
cd my_project

# Add conda-forge packages
pixi add numpy pandas scanpy

# Add PyPI packages
pixi add --pypi requests

# Run commands in the environment
pixi run python script.py

# Or activate the shell
pixi shell
```

### Why Use pixi?

| Feature | pixi | conda |
|---------|------|-------|
| Speed | ~10x faster | Slow |
| Lockfiles | Native (pixi.lock) | Requires conda-lock |
| PyPI support | Built-in | Separate tool |
| Reproducibility | Excellent | Manual effort |

### Common Commands

```bash
pixi init                    # Create new project
pixi add <package>           # Add conda-forge package
pixi add --pypi <package>    # Add PyPI package
pixi install                 # Install from lockfile
pixi run <command>           # Run in environment
pixi shell                   # Activate environment
pixi list                    # List installed packages
pixi update                  # Update packages
```

### Project Structure

```
my_project/
├── pixi.toml      # Project manifest
├── pixi.lock      # Lockfile (reproducible)
└── .pixi/         # Environment (gitignored)
```

## Pre-installed Packages

### R Packages (~1500 packages)

The shared R library includes:

**Single-Cell Analysis**
- Seurat v5, scran, scater, SingleCellExperiment
- monocle3, slingshot, destiny (trajectory)
- harmony, liger, Azimuth (integration)
- CellChat, cellassign, DoubletFinder

**Bulk RNA-seq**
- DESeq2, edgeR, limma-voom
- tximport, tximeta, biomaRt

**Visualization**
- ggplot2, ComplexHeatmap, dittoSeq
- EnhancedVolcano, pheatmap

**Development**
- devtools, usethis, testthat, roxygen2
- targets, renv, pak

### Python Packages

**In Container (always available)**
- numpy, scipy, scikit-learn
- matplotlib, seaborn, plotly
- rpy2 (R integration)
- jupyterlab + extensions

**Shared Library (SCverse ecosystem)**
- scanpy, anndata, scvi-tools
- squidpy, cellrank, muon, pertpy
- harmonypy, bbknn, scanorama
- scrublet, doubletdetection

**GPU Packages (Gemini only)**
- rapids-singlecell
- cupy-cuda12x
- jax[cuda12]

### Genomics Tools

Available in PATH:
- `bcftools`, `samtools`, `tabix`
- `bedtools`, `bedops`
- `vcftools`
- `picard-tools`
- `fasterq-dump`, `prefetch` (sra-tools)

### Utilities

- `qpdf` - PDF manipulation
- `lftp` - FTP client
- `git-filter-repo` - Git history rewriting
- `rclone` - Cloud storage sync
- `dxfuse` - DNAnexus filesystem

## VS Code Integration

### Pre-installed Extensions

These extensions are available for HPC Code Server sessions:

- **R** (REditorSupport.r) - R language support
- **R Debugger** - Debug R code
- **Python** - Python language support

### R Session Watcher

The container is pre-configured for the VS Code R extension. Features:

- View data frames in VS Code
- Plot viewer
- Help viewer
- Workspace browser

### Using VS Code Tunnels

```bash
# Start a tunnel (requires GitHub auth)
code tunnel

# Or serve web interface
code serve-web --host 0.0.0.0 --port 8080
```

## Tips and Tricks

### Check Available Resources

```python
# In JupyterLab - look at status bar for CPU/RAM
# Or in terminal:
htop
```

### Find Installed Packages

```r
# R
installed.packages()[, c("Package", "Version")]

# Or search
pak::pkg_search("seurat")
```

```python
# Python
pip list | grep scanpy
```

### Using renv with Shared Library

The container's shared library works alongside renv projects:

```r
# In your project
renv::init()
renv::install("new_package")  # Uses shared cache
```

### SLURM Commands from Container

SLURM commands work via SSH passthrough:

```bash
squeue -u $USER
sbatch job.sh
scancel <jobid>
```

## Persistent GitHub Copilot Authentication

VS Code stores OAuth tokens in the OS keyring. In headless/container environments, tokens are lost on process exit unless a keyring daemon is running. This container includes `gnome-keyring` for token persistence.

### How It Works

The [HPC Code Server Manager](https://github.com/drejom/omhq-hpc-code-server-stack) handles keyring initialization automatically in job scripts. Your Copilot authentication persists across sessions.

### Testing the Keyring

Verify the keyring is working with `secret-tool`:

```bash
# Store a test secret
echo -n "test-value" | secret-tool store --label="Test" service test-service account test

# Retrieve it
secret-tool lookup service test-service account test
```

### Packages Included

- `gnome-keyring` - GNOME keyring daemon
- `libsecret-1-0` - Secret storage library
- `libsecret-tools` - `secret-tool` CLI
- `dbus-x11` - D-Bus session support
