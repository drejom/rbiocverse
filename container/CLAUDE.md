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

### Deploy to HPC (Singularity)
```sh
# Gemini
singularity pull -F /packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif docker://ghcr.io/drejom/vscode-rbioc:latest

# Apollo
singularity pull -F /opt/singularity-images/rbioc/vscode-rbioc_3.22.sif docker://ghcr.io/drejom/vscode-rbioc:latest
```

## Package Migration (New Bioconductor Version)

```sh
# 1. Export current packages
Rscript scripts/migrate-packages.R export packages-3.19.rds

# 2. Generate SLURM job array for parallel install (uses HPC)
Rscript scripts/migrate-packages.R slurm packages-3.19.rds 20

# 3. Submit to cluster
sbatch slurm_install/install_packages.slurm

# Or install from rbiocverse metapackage:
Rscript scripts/migrate-packages.R rbiocverse /opt/rbiocverse
```

## Key Files

- `Dockerfile` - Main container (extends `bioconductor/bioconductor_docker:${BIOC_VERSION}`)
- `.devcontainer/devcontainer.json` - VSCode devcontainer config
- `rbiocverse/DESCRIPTION` - Metapackage listing standard R packages
- `scripts/migrate-packages.R` - Package migration tools with HPC support
- `scripts/slurm-wrappers.sh` - SLURM SSH wrapper installer

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
