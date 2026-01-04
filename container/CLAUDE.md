# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository builds a Docker container extending the official Bioconductor Docker image for use on HPC clusters (Apollo and Gemini) and local development via VSCode devcontainers. The container provides:
- System dependencies for R packages: Seurat v5, monocle3, velocyto.R, bedr, ctrdata
- Genomics tools: sra-tools, bcftools, bedtools, bedops, samtools, vcftools
- DNAnexus support (dxpy, dxfuse)
- JupyterLab, VSCode CLI
- SLURM job scheduler wrappers (SSH passthrough for HPC)

## Architecture

The setup uses a **lean container + mounted library** pattern:
- Container has system deps only (~2-3GB)
- R packages live in mounted `R_LIBS_SITE` on shared storage
- All users share the same package library
- Package updates don't require container rebuilds

```
Container (GHCR):     bioconductor/bioconductor_docker + system deps
R_LIBS_SITE:          /packages/singularity/shared_cache/rbioc/rlibs/bioc-X.Y (mounted)
rbiocverse/:          Metapackage manifest for R_LIBS_SITE contents
```

### Cluster Paths

| Cluster | Container Path | R Library Path | Python Library Path |
|---------|---------------|----------------|---------------------|
| Gemini  | `/packages/singularity/shared_cache/rbioc/vscode-rbioc_X.Y.sif` | `/packages/singularity/shared_cache/rbioc/rlibs/bioc-X.Y` | `/packages/singularity/shared_cache/rbioc/python/bioc-X.Y` |
| Apollo  | `/opt/singularity-images/rbioc/vscode-rbioc_X.Y.sif` | `/opt/singularity-images/rbioc/rlibs/bioc-X.Y` | `/opt/singularity-images/rbioc/python/bioc-X.Y` |

## Build Commands

### Update Bioconductor Version
Change `BIOC_VERSION` ARG in Dockerfile (line 3):
```dockerfile
ARG BIOC_VERSION=RELEASE_3_22
```

### Local Docker Build
```sh
docker buildx create --use
docker buildx build --load --platform linux/amd64 -t ghcr.io/drejom/vscode-rbioc:latest --progress=plain . 2>&1 | tee build.log
```

### Test Container
```sh
docker run -it --rm ghcr.io/drejom/vscode-rbioc:latest /bin/bash
```

## Package Migration (New Bioconductor Version)

### Complete Workflow

The migration workflow has two phases: **pre-release** (sync from old) and **post-release** (install to new).

#### Pre-Release: Sync from Current Environment

Run on HPC cluster to capture packages from OLD version:

```sh
# 1. Sync DESCRIPTION with packages from current (e.g., 3.19) environment
./scripts/sync-packages.sh --from 3.19 --apply

# 2. Check availability in new Bioconductor version
Rscript scripts/update-description.R check --apply

# 3. Update GitHub remotes and bump version
Rscript scripts/update-description.R update --apply

# 4. Commit changes
git add -A && git commit -m "Update packages for 3.22"
git push
```

#### Post-Release: Install to New Environment

Run after building and pulling new container:

```sh
# 1. Pull new container (auto-detects cluster)
./scripts/pull-container.sh --force

# 2. Generate and run two-phase SLURM install to target version
./scripts/install-packages.sh --to 3.22 --submit

# Or generate without submitting:
./scripts/install-packages.sh --to 3.22
./slurm_install/submit_install.sh
```

### Two-Phase Installation Strategy

The install uses a two-phase SLURM strategy to avoid NFS lock contention:

1. **Phase 1 (single job)**: Install core dependencies (BiocGenerics, S4Vectors, Seurat, tidyverse, etc.) with high CPU/memory
2. **Phase 2 (job array)**: Install remaining packages in parallel with moderate resources

Each job uses a local pak cache (`/tmp/pak_cache_*`) to prevent NFS lock issues.

## Python Package Migration

Python packages follow a similar workflow to R, with a **staging model** for packages added between releases.

### Package Categories

| Category | Source | Description |
|----------|--------|-------------|
| **Core** | `[project.dependencies]` | Blessed SCverse stack (scanpy, anndata, scvi-tools, etc.) |
| **GPU** | `[optional-dependencies.gpu]` | GPU packages (Gemini only: rapids-singlecell, cupy, jax) |
| **Staged** | `[optional-dependencies.staged]` | Packages added between releases, reviewed at upgrade |

### Pre-Release: Sync Python Packages

```sh
# 1. Capture installed packages, compare to pyproject.toml
./scripts/sync-python-packages.sh --from 3.22

# 2. Review output - decide for each "NEW STAGED CANDIDATE":
#    - PROMOTE: move to [project.dependencies] (core)
#    - KEEP: add to [optional-dependencies.staged]
#    - DROP: don't carry forward (was experimental)

# 3. Edit rbiocverse/pyproject.toml accordingly

# 4. Commit changes
git add rbiocverse/pyproject.toml rbiocverse/pyproject.toml.*.from
git commit -m "Update Python packages for 3.23"
```

### Post-Release: Install Python Packages

```sh
# Install Python packages (includes core + staged + gpu on Gemini)
./scripts/install-python.sh --to 3.23 --submit
```

## Scripts Reference

### Cluster Configuration
- `scripts/cluster-config.sh` - Shared cluster detection and path functions
  - Auto-detects Gemini vs Apollo based on filesystem paths
  - Provides: `get_bioc_version`, `get_available_versions`, `get_container_path`, `get_library_path`, `run_in_container`

### Pre-Release Scripts (R)
- `scripts/sync-packages.sh` - Sync DESCRIPTION from current R environment
- `scripts/update-description.R` - Check availability, update remotes, bump version

### Pre-Release Scripts (Python)
- `scripts/sync-python-packages.sh` - Sync pyproject.toml from current Python environment
- `scripts/sync-python.py` - Helper to categorize packages (core/gpu/staged/transitive)

### Post-Release Scripts
- `scripts/pull-container.sh` - Pull container to cluster storage
- `scripts/install-packages.sh` - Generate/submit SLURM R install jobs
- `scripts/install.R` - Core R installation logic, SLURM generation
- `scripts/install-python.sh` - Generate/submit SLURM Python install jobs

### Generated Files
- `slurm_install/` - Generated SLURM scripts and package lists (gitignored)

## Key Files

- `Dockerfile` - Main container (extends `bioconductor/bioconductor_docker:${BIOC_VERSION}`)
- `.devcontainer/devcontainer.json` - VSCode devcontainer config
- `rbiocverse/DESCRIPTION` - Metapackage listing standard R packages
- `rbiocverse/pyproject.toml` - Python package manifest (SCverse ecosystem)
- `scripts/cluster-config.sh` - Shared cluster detection and paths
- `scripts/sync-packages.sh` - Pre-release R package sync
- `scripts/sync-python-packages.sh` - Pre-release Python package sync
- `scripts/install-packages.sh` - Post-release R package installation
- `scripts/install-python.sh` - Post-release Python package installation
- `scripts/install.R` - R installation functions and SLURM generation
- `scripts/update-description.R` - DESCRIPTION management tools

## CI/CD

GitHub Actions (`.github/workflows/publish-to-github-package.yaml`) builds on:
- Push of version tags (`v*`)
- Manual workflow dispatch (can specify BIOC_VERSION)

### Container Tagging Scheme

Two tagging schemes are used:

| Tag Type | Format | Example | When to Use |
|----------|--------|---------|-------------|
| **Dev releases** | `vYYYY-M-DD` | `v2026-1-4` | Incremental updates, bug fixes, new packages |
| **Stable releases** | Semver `vX.Y.Z` | `v3.22.0` | Major Bioconductor version upgrades |

Both schemes trigger CI builds and push to GHCR. Additional auto-generated tags:
- `:latest` - always points to most recent build
- `:RELEASE_X_YY` - matches Bioconductor version (e.g., `RELEASE_3_22`)

**Examples:**
```sh
# Dev release (incremental update)
git tag v2026-1-15
git push --tags

# Stable release (new Bioconductor version)
git tag v3.23.0
git push --tags
```

## Design Decisions

- SLURM commands use SSH wrappers to passthrough from container to host
- Container targets `linux/amd64` only (HPC requirement)
- R session watcher pre-configured for VSCode R extension
- renv cache at `/usr/local/share/renv/cache` with Posit Package Manager for fast binary installs
- Container paths use `/usr/local/share/` instead of `/opt/` (Apollo bind mounts `/opt` from host)
- `R_LIBS_SITE` configurable via environment variable for flexibility
- GitHub packages use `remotes::install_github` (pak has issues with subdirectory syntax)
- URL remotes for archived CRAN packages use pak
- All scripts auto-detect cluster (Gemini/Apollo) from filesystem paths
