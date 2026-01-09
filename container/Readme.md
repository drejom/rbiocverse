[![Build and publish Docker image](https://github.com/drejom/vscode-rbioc/actions/workflows/publish-to-github-package.yaml/badge.svg)](https://github.com/drejom/vscode-rbioc/actions/workflows/publish-to-github-package.yaml)

# Bioconductor Development Container

Docker container extending [Bioconductor Docker](https://bioconductor.org/help/docker/) for HPC (Apollo/Gemini) and VSCode devcontainer workflows.

## Documentation

| Guide | Audience | Content |
|-------|----------|---------|
| [User Guide](USER_GUIDE.md) | End users | JupyterLab, pixi, available packages, how-to guides |
| [Developer Guide](DEVELOPER_GUIDE.md) | Maintainers | Building, upgrading Bioconductor, adding packages |
| [Changelog](CHANGELOG.md) | Everyone | Version history and changes |

## What's Included

### Languages & Environments
- **R 4.5** with ~1500 Bioconductor/CRAN packages (Seurat, DESeq2, etc.)
- **Python 3.12** with SCverse ecosystem (scanpy, scvi-tools, etc.)
- **GNU Octave** (free MATLAB alternative)
- **SoS polyglot notebooks** (mix R, Python, Bash in one notebook)

### JupyterLab
Pre-configured with productivity extensions:
- Code intelligence (LSP), formatting (black), spellchecker
- Execution time, resource monitor, git integration
- Dev server proxying (Shiny, Streamlit, Gradio)

### Tools
- **pixi** - Fast conda alternative for installing additional packages
- **Genomics** - bcftools, samtools, bedtools, sra-tools
- **VS Code CLI** - serve-web and tunnel support

## Quick Start

### VSCode Devcontainer (Local)
1. Install [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Open repo in VSCode → "Reopen in Container"

### HPC Interactive Session
```bash
~/bin/ij 4  # Request 4 CPUs
```

### Docker
```bash
docker run -it --rm ghcr.io/drejom/vscode-rbioc:latest /bin/bash
```

## Architecture

```
Container (lean, ~2-3GB)          Shared Libraries (HPC storage)
┌─────────────────────────┐       ┌─────────────────────────────┐
│ System deps, tools      │       │ rlibs/bioc-3.22/ (R)        │
│ JupyterLab + extensions │──────▶│ python/bioc-3.22/ (Python)  │
│ pixi, VS Code CLI       │       │ Shared by all users         │
└─────────────────────────┘       └─────────────────────────────┘
```

## Container Tags

| Tag | Example | Use Case |
|-----|---------|----------|
| `latest` | `:latest` | Most recent build |
| `RELEASE_X_YY` | `:RELEASE_3_22` | Specific Bioconductor version |
| `vX.Y.Z` | `:v3.22.0` | Stable release |
| `vYYYY-M-DD` | `:v2026-1-8` | Dev release |

## License

MIT
