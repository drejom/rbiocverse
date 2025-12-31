[![Build and publish Docker image](https://github.com/drejom/vscode-rbioc/actions/workflows/publish-to-github-package.yaml/badge.svg)](https://github.com/drejom/vscode-rbioc/actions/workflows/publish-to-github-package.yaml)

# Bioconductor Development Container

Docker container extending [Bioconductor Docker](https://bioconductor.org/help/docker/) for HPC (Apollo/Gemini) and VSCode devcontainer workflows.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Container (lean, ~2-3GB)                                   │
│  - System dependencies (libhdf5, libgdal, etc.)            │
│  - Genomics tools (bcftools, bedtools, sra-tools)          │
│  - Python (dxpy, jupyterlab, radian)                       │
│  - VSCode CLI, SLURM wrappers                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ mounts R_LIBS_SITE
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Shared Library (on HPC storage)                           │
│  /packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22  │
│  - 1500+ R packages                                         │
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

### Step 1: Update Container
```sh
# Edit Dockerfile line 3
ARG BIOC_VERSION=RELEASE_3_22  # Change to new version

# Build locally (optional test)
docker buildx build --load --platform linux/amd64 -t ghcr.io/drejom/vscode-rbioc:latest .

# Push tag to trigger CI build (use format vYYYY-MM-DD or vX.Y.Z)
git tag vYYYY-MM-DD
git push --tags
```

### Step 2: Pull to HPC
```sh
# Gemini
module load singularity
singularity pull -F /packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif \
  docker://ghcr.io/drejom/vscode-rbioc:latest

# Apollo
singularity pull -F /opt/singularity-images/rbioc/vscode-rbioc_3.22.sif \
  docker://ghcr.io/drejom/vscode-rbioc:latest
```

### Step 3: Parallel Package Install
```sh
# Create new library directory
mkdir -p /packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22

# Export current packages
Rscript scripts/migrate-packages.R export packages-3.19.rds

# Generate SLURM array job (20 parallel workers)
Rscript scripts/migrate-packages.R slurm packages-3.19.rds 20

# Submit to cluster
sbatch slurm_install/install_packages.slurm
```

Or install from the metapackage:
```r
# In R
devtools::install_local("/opt/rbiocverse", dependencies = TRUE)
```

### Step 4: Update Launch Scripts
Update `R_LIBS_SITE` in `~/bin/ij` and job scripts:
```sh
R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22
```

## What's Included

### System Dependencies
- Seurat v5: libhdf5-dev
- monocle3: libmysqlclient-dev, libudunits2-dev, libgdal-dev, libgeos-dev, libproj-dev
- velocyto.R: libboost-all-dev, libomp-dev
- bedr: bedtools, bedops
- ctrdata: libjq-dev, php, php-xml

### Genomics Tools
bcftools, vcftools, samtools, tabix, bedtools, bedops, picard-tools, freebayes, sra-tools

### Python
- radian (better R console)
- dxpy (DNAnexus toolkit)
- jupyterlab
- numpy, scipy, scikit-learn, umap-learn, leidenalg (Seurat Python deps)

### Other
- VSCode CLI (`code serve-web`, tunnels)
- DNAnexus dxfuse
- SLURM SSH wrappers
- qpdf, lftp, git-filter-repo

## rbiocverse Metapackage

The `rbiocverse/` directory contains a metapackage that documents and installs standard packages:

```r
# Install all standard packages
devtools::install_local("rbiocverse")

# Or use pak
pak::local_install("rbiocverse")
```

See `rbiocverse/DESCRIPTION` for the full package list organized by category:
- Development (BiocManager, devtools, targets, renv)
- Tidyverse & Data
- Bioconductor Core
- Single Cell (Seurat, scran, harmony, slingshot, etc.)
- Bulk RNA-seq (DESeq2, edgeR, limma)
- Visualization (ggplot2, ComplexHeatmap, dittoSeq)

## Files

```
├── .devcontainer/
│   └── devcontainer.json     # VSCode devcontainer config
├── .github/workflows/
│   └── publish-to-github-package.yaml
├── rbiocverse/
│   ├── DESCRIPTION           # Metapackage manifest
│   ├── LICENSE
│   └── NAMESPACE
├── scripts/
│   ├── migrate-packages.R    # Package migration tools
│   └── slurm-wrappers.sh     # SLURM SSH wrapper installer
├── Dockerfile
├── CLAUDE.md
└── Readme.md
```

## Previous Versions

| Bioconductor | Container Tag | R_LIBS_SITE |
|--------------|---------------|-------------|
| 3.22 | `ghcr.io/drejom/vscode-rbioc:latest` | `rlibs/bioc-3.22` |
| 3.19 | `ghcr.io/drejom/vscode-rbioc:v2024-7-17` | `rlibs/bioc-3.19` |
| 3.18 | `ghcr.io/drejom/vscode-rbioc:v2023-11-27` | `rlibs/bioc-3.18` |
| 3.17 | `ghcr.io/drejom/vscode-rbioc:v2023-9-26` | `rlibs/bioc-3.17` |
