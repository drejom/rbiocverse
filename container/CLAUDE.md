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

| Cluster | Container Path | Library Path |
|---------|---------------|--------------|
| Gemini  | `/packages/singularity/shared_cache/rbioc/vscode-rbioc_X.Y.sif` | `/packages/singularity/shared_cache/rbioc/rlibs/bioc-X.Y` |
| Apollo  | `/opt/singularity-images/rbioc/vscode-rbioc_X.Y.sif` | `/opt/singularity-images/rbioc/rlibs/bioc-X.Y` |

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

## Scripts Reference

### Cluster Configuration
- `scripts/cluster-config.sh` - Shared cluster detection and path functions
  - Auto-detects Gemini vs Apollo based on filesystem paths
  - Provides: `get_bioc_version`, `get_available_versions`, `get_container_path`, `get_library_path`, `run_in_container`

### Pre-Release Scripts
- `scripts/sync-packages.sh` - Sync DESCRIPTION from current environment
- `scripts/update-description.R` - Check availability, update remotes, bump version

### Post-Release Scripts
- `scripts/pull-container.sh` - Pull container to cluster storage
- `scripts/install-packages.sh` - Generate/submit SLURM install jobs
- `scripts/install.R` - Core R installation logic, SLURM generation

### Generated Files
- `slurm_install/` - Generated SLURM scripts and package lists (gitignored)

## Key Files

- `Dockerfile` - Main container (extends `bioconductor/bioconductor_docker:${BIOC_VERSION}`)
- `.devcontainer/devcontainer.json` - VSCode devcontainer config
- `rbiocverse/DESCRIPTION` - Metapackage listing standard R packages
- `scripts/cluster-config.sh` - Shared cluster detection and paths
- `scripts/sync-packages.sh` - Pre-release package sync
- `scripts/install-packages.sh` - Post-release package installation
- `scripts/install.R` - R installation functions and SLURM generation
- `scripts/update-description.R` - DESCRIPTION management tools

## CI/CD

GitHub Actions (`.github/workflows/publish-to-github-package.yaml`) builds on:
- Push of version tags (`v*`)
- Manual workflow dispatch (can specify BIOC_VERSION)

## Design Decisions

- SLURM commands use SSH wrappers to passthrough from container to host
- Container targets `linux/amd64` only (HPC requirement)
- R session watcher pre-configured for VSCode R extension
- renv cache at `/opt/renv/cache` with Posit Package Manager for fast binary installs
- `R_LIBS_SITE` configurable via environment variable for flexibility
- GitHub packages use `remotes::install_github` (pak has issues with subdirectory syntax)
- URL remotes for archived CRAN packages use pak
- All scripts auto-detect cluster (Gemini/Apollo) from filesystem paths
