# {{icon:box}} Environment

Understanding your development environment on HPC clusters.

## Bioconductor Releases

Each release includes a matched set of:
- **R version** - Corresponding R release
- **Bioconductor packages** - Pre-installed and tested together
- **Python environment** - Matching Python with curated packages

Select your release from the dropdown. All IDEs share the same environment.

## Resource Allocation

### Choosing Resources

| Resource | Default | Recommendation |
|----------|---------|----------------|
| **CPUs** | 2 | 2-4 for interactive work, more for parallelized code |
| **Memory** | 40G | 40G handles most R/Python workloads |
| **Time** | 12:00:00 | Extend for long-running analyses |

### Partition Limits

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

### Format

- **Memory**: Use `G` or `M` suffix (e.g., `40G`, `100M`)
- **Time**: `HH:MM:SS` or `D-HH:MM:SS` (e.g., `12:00:00`, `1-00:00:00`)

## GPU Computing (Gemini)

Select GPU type in the Accelerator toggle:

| GPU | Use Case |
|-----|----------|
| **A100** | Deep learning, large models, latest CUDA |
| **V100** | ML training, CUDA workloads |

When you select a GPU:
- The health bar shows GPU utilization instead of CPU
- Resource limits adjust to match the GPU partition
- Your job gets 1 GPU allocated

## Python and Reticulate

### Default Setup

Python is pre-configured:
- `RETICULATE_PYTHON=/usr/bin/python3` - Container Python
- `PYTHONPATH` points to curated cluster packages (Bioc 3.22+)

When you call `library(reticulate)`, it uses system Python directly.

### Custom Packages

For packages not in the cluster library, create a virtualenv:

```r
library(reticulate)
virtualenv_create("my-project")
use_virtualenv("my-project")
py_install("some-package")
```

This keeps custom packages isolated while accessing cluster packages.

## File Storage

Your home directory (`$HOME`) is shared across:
- All clusters
- All IDEs
- All sessions

Save files in your home directory to access them anywhere.
