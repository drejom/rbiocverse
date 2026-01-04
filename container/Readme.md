[![Build and publish Docker image](https://github.com/drejom/vscode-rbioc/actions/workflows/publish-to-github-package.yaml/badge.svg)](https://github.com/drejom/vscode-rbioc/actions/workflows/publish-to-github-package.yaml)

# Bioconductor Development Container

Docker container extending [Bioconductor Docker](https://bioconductor.org/help/docker/) for HPC (Apollo/Gemini) and VSCode devcontainer workflows.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Container (lean, ~2-3GB)                                   │
│  - System dependencies (libhdf5, libgdal, etc.)            │
│  - Genomics tools (bcftools, bedtools, sra-tools)          │
│  - Python (dxpy, jupyterlab, radian, rpy2)                 │
│  - VSCode CLI, SLURM wrappers                              │
│  - JupyterLab with R kernel + SoS polyglot notebooks       │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ mounts R_LIBS_SITE + PYTHONPATH
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Shared Libraries (on HPC storage)                         │
│  /packages/singularity/shared_cache/rbioc/                 │
│  ├── rlibs/bioc-3.22/    # 1500+ R packages                │
│  └── python/bioc-3.22/   # SCverse Python packages         │
│  - Shared by all users                                      │
│  - Updated independently of container                       │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### VSCode Devcontainer (Local)
1. Install [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Open repo in VSCode → "Reopen in Container"

### HPC Interactive Session (Gemini)
```sh
~/bin/ij 4  # Request 4 CPUs
```

### HPC Batch Job
```sh
sbatch /packages/singularity/shared_cache/rbioc/rbioc322.job
```

## Update Path (New Bioconductor Version)

The migration has two phases: **pre-release** (capture packages from old) and **post-release** (install to new).

### Phase 1: Pre-Release (Sync from Old Environment)

Run on HPC cluster to capture packages from the current version:

```sh
# 1. Sync R packages: DESCRIPTION with packages from current (e.g., 3.22) environment
./scripts/sync-packages.sh --from 3.22         # Preview
./scripts/sync-packages.sh --from 3.22 --apply # Apply

# 2. Sync Python packages: compare installed vs pyproject.toml
./scripts/sync-python-packages.sh --from 3.22
# Review output, add new packages to [staged] in pyproject.toml

# 3. Check R package availability in new Bioconductor version
Rscript scripts/update-description.R check --apply

# 4. Update GitHub remotes and bump version
Rscript scripts/update-description.R remotes --apply
Rscript scripts/update-description.R bump bioc

# 5. Update Dockerfile
# Edit line 3: ARG BIOC_VERSION=RELEASE_3_23

# 6. Commit and tag to trigger CI build
# Use date tag for dev releases: vYYYY-M-DD
# Use semver for stable releases: vX.Y.Z (e.g., v3.23.0)
git add -A && git commit -m "Bump to Bioconductor 3.23"
git tag v2026-1-15      # Dev release (date-based)
# git tag v3.23.0       # Stable release (semver)
git push && git push --tags
```

### Phase 2: Post-Release (Install to New Environment)

Run after the new container is built and available:

```sh
# 1. Pull new container (auto-detects cluster: Gemini/Apollo)
./scripts/pull-container.sh --force

# 2. Generate and submit two-phase SLURM install for R packages
./scripts/install-packages.sh --to 3.22 --submit

# 3. Install Python packages (SCverse ecosystem)
./scripts/install-python.sh --to 3.22 --submit

# Or generate without submitting:
./scripts/install-packages.sh --to 3.22
./scripts/install-python.sh --to 3.22
./slurm_install/submit_install.sh
./slurm_install/submit_python.sh
```

### Two-Phase Installation Strategy

The install uses a two-phase SLURM strategy to avoid NFS lock contention:

1. **Phase 1 (single job)**: Install core dependencies with high CPU/memory
2. **Phase 2 (job array)**: Install remaining packages in parallel

Each job uses a local pak cache (`/tmp/pak_cache_*`) to prevent NFS lock issues.

### Update Launch Scripts
Update `R_LIBS_SITE` and `PYTHONPATH` in `~/bin/ij` and job scripts:
```sh
R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22
PYTHONPATH=/packages/singularity/shared_cache/rbioc/python/bioc-3.22
```

## What's Included

### System Dependencies
- Seurat v5: libhdf5-dev
- monocle3: libmysqlclient-dev, libudunits2-dev, libgdal-dev, libgeos-dev, libproj-dev
- velocyto.R: libboost-all-dev, libomp-dev
- bedr: bedtools, bedops
- ctrdata: libjq-dev, php, php-xml

### Genomics Tools
bcftools, vcftools, samtools, tabix, bedtools, bedops, picard-tools, sra-tools

### Python (in container)
- radian (better R console)
- dxpy (DNAnexus toolkit)
- jupyterlab + ipykernel, ipywidgets, jupyterlab-git
- rpy2 (Python → R integration)
- matplotlib, seaborn, plotly
- numpy, scipy, scikit-learn, umap-learn, leidenalg (Seurat Python deps)
- **SoS polyglot notebooks**: sos, sos-notebook, jupyterlab-sos, sos-r, sos-python, sos-bash
- **SAS integration**: saspy, sas_kernel (requires external SAS server)

### Python (shared library via PYTHONPATH)
SCverse single-cell ecosystem:
- scanpy, anndata, scvi-tools, squidpy, cellrank, muon, pertpy
- harmonypy, bbknn, scanorama, scrublet, doubletdetection
- GPU packages on Gemini: rapids-singlecell, cupy, jax[cuda]

### Other
- VSCode CLI (`code serve-web`, tunnels)
- DNAnexus dxfuse
- SLURM SSH wrappers
- qpdf, lftp, git-filter-repo

## rbiocverse Metapackage

The `rbiocverse/` directory contains package manifests that serve as the **single source of truth** for the environment:

**R Packages (`DESCRIPTION`)**:
- Defines all R packages to install (CRAN, Bioconductor, GitHub)
- Version drives container versioning (3.22.0 = Bioconductor 3.22)
- GitHub remotes pinned to specific commits/tags for reproducibility

**Python Packages (`pyproject.toml`)**:
- SCverse ecosystem for single-cell Python analysis
- Optional GPU dependencies for Gemini cluster

See `rbiocverse/DESCRIPTION` for R packages:
- Development (BiocManager, devtools, targets, renv)
- Tidyverse & Data
- Bioconductor Core
- Single Cell (Seurat, scran, harmony, slingshot, etc.)
- Bulk RNA-seq (DESeq2, edgeR, limma)
- Visualization (ggplot2, ComplexHeatmap, dittoSeq)

See `rbiocverse/pyproject.toml` for Python packages:
- SCverse core (scanpy, anndata, scvi-tools, squidpy, cellrank, muon)
- Single-cell utilities (harmonypy, bbknn, scanorama, scrublet)
- GPU acceleration (rapids-singlecell, cupy, jax)

## Scripts

### Wrapper Scripts (recommended)
| Script | Purpose | When to Use |
|--------|---------|-------------|
| `sync-packages.sh --from X.Y` | Sync R DESCRIPTION from existing library | Pre-release: capture R packages |
| `sync-python-packages.sh --from X.Y` | Sync Python pyproject.toml from existing library | Pre-release: capture Python packages |
| `install-packages.sh --to X.Y` | Generate/submit SLURM R package install | Post-release: install R packages |
| `install-python.sh --to X.Y` | Generate/submit SLURM Python install | Post-release: install Python packages |
| `pull-container.sh` | Pull container to cluster storage | Post-release: before install |

### R Scripts (called by wrappers)
| Script | Purpose | When to Use |
|--------|---------|-------------|
| `update-description.R sync` | Sync DESCRIPTION with installed packages | Pre-release (via sync-packages.sh) |
| `update-description.R check` | Check/remove unavailable packages | Pre-release: after sync |
| `update-description.R remotes` | Update GitHub remote pins | Pre-release: pin to tags/commits |
| `update-description.R bump` | Bump version number | Pre-release: after sync/check |
| `install.R --slurm-smart` | Generate two-phase SLURM jobs | Post-release (via install-packages.sh) |

### Utility
| Script | Purpose |
|--------|---------|
| `cluster-config.sh` | Shared cluster detection and path functions |
| `migrate-packages.R` | Export/compare package environments |

## Files

```
├── .devcontainer/
│   └── devcontainer.json       # VSCode devcontainer config
├── .github/workflows/
│   └── publish-to-github-package.yaml
├── rbiocverse/
│   ├── DESCRIPTION             # R package manifest (source of truth)
│   ├── pyproject.toml          # Python package manifest
│   ├── LICENSE
│   └── NAMESPACE
├── config/
│   └── jupyter_lab_config.py   # JupyterLab HPC config
├── scripts/
│   ├── cluster-config.sh       # Shared cluster detection and paths
│   ├── sync-packages.sh        # Pre-release: sync R packages from old environment
│   ├── sync-python-packages.sh # Pre-release: sync Python packages from old environment
│   ├── sync-python.py          # Helper: categorize Python packages
│   ├── install-packages.sh     # Post-release: install R packages
│   ├── install-python.sh       # Post-release: install Python packages
│   ├── pull-container.sh       # Pull container to HPC storage
│   ├── update-description.R    # DESCRIPTION management (sync/check/bump)
│   ├── install.R               # R install logic and SLURM generation
│   ├── migrate-packages.R      # Audit: export/compare environments
│   └── slurm-wrappers.sh       # SLURM SSH wrapper installer
├── slurm_install/              # Generated SLURM scripts (gitignored)
├── Dockerfile
├── CLAUDE.md
└── Readme.md
```

## Container Tags

### Tagging Scheme

The container uses two tagging schemes:

| Tag Type | Format | Example | Use Case |
|----------|--------|---------|----------|
| **Dev releases** | `vYYYY-M-DD` | `v2026-1-4` | Incremental updates during development |
| **Stable releases** | Semver `vX.Y.Z` | `v3.22.0` | Major Bioconductor version releases |
| **Latest** | `latest` | `latest` | Always points to most recent build |
| **Bioc version** | `RELEASE_X_YY` | `RELEASE_3_22` | Matches Bioconductor release branch |

**Recommended usage:**
- Production: Use `:latest` or `:RELEASE_3_22` for stability
- Development: Use date tags like `:v2026-1-4` to pin specific builds
- Upgrades: Use semver tags like `:v3.22.0` for major version upgrades

### Version History

| Bioconductor | Stable Tag | Dev Tags | R_LIBS_SITE |
|--------------|------------|----------|-------------|
| 3.22 | `v3.22.0` | `v2026-1-4`, `v2026-1-3` | `rlibs/bioc-3.22` |
| 3.19 | - | `v2024-7-17` | `rlibs/bioc-3.19` |
| 3.18 | - | `v2023-11-27` | `rlibs/bioc-3.18` |
| 3.17 | - | `v2023-9-26` | `rlibs/bioc-3.17` |
