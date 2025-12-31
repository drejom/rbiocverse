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

### Step 1: Sync DESCRIPTION with Current Environment
Run from INSIDE the current container/environment to capture all ~1600 packages:
```sh
# Preview what will change
Rscript scripts/update-description.R sync

# Apply: adds all installed packages to DESCRIPTION
Rscript scripts/update-description.R sync --apply
```

### Step 2: Check Availability for New Bioconductor
Some packages may not be available in the new Bioconductor version:
```sh
# Check which packages are unavailable
Rscript scripts/update-description.R check

# Remove unavailable packages from DESCRIPTION
Rscript scripts/update-description.R check --apply
```

### Step 3: Update Remotes and Bump Version
```sh
# Update GitHub remote pins to latest tags/commits
Rscript scripts/update-description.R remotes --apply

# Bump version for new Bioconductor release (3.22.0 -> 3.23.0)
Rscript scripts/update-description.R bump bioc
```

### Step 4: Update Container
```sh
# Edit Dockerfile line 3 to match DESCRIPTION version
ARG BIOC_VERSION=RELEASE_3_23  # Match rbiocverse/DESCRIPTION

# Build locally (optional test)
docker buildx build --load --platform linux/amd64 -t ghcr.io/drejom/vscode-rbioc:latest .

# Commit and tag to trigger CI build
git add -A && git commit -m "Bump to Bioconductor 3.23"
git tag v2025-MM-DD
git push && git push --tags
```

### Step 5: Pull to HPC
```sh
# Gemini
module load singularity
singularity pull -F /packages/singularity/shared_cache/rbioc/vscode-rbioc_3.23.sif \
  docker://ghcr.io/drejom/vscode-rbioc:latest

# Apollo
singularity pull -F /opt/singularity-images/rbioc/vscode-rbioc_3.23.sif \
  docker://ghcr.io/drejom/vscode-rbioc:latest
```

### Step 6: Install Packages
```sh
# Create new library directory (Gemini example)
mkdir -p /packages/singularity/shared_cache/rbioc/rlibs/bioc-3.23

# Option A: Direct install (uses all CPUs)
singularity exec \
  --env R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.23 \
  /packages/singularity/shared_cache/rbioc/vscode-rbioc_3.23.sif \
  Rscript /opt/rbiocverse/scripts/install.R

# Option B: SLURM job array (20 parallel jobs)
R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.23 \
  Rscript scripts/install.R --slurm 20
sbatch slurm_install/install.slurm
```

### Step 7: Update Launch Scripts
Update `R_LIBS_SITE` in `~/bin/ij` and job scripts:
```sh
R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.23
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

The `rbiocverse/` directory contains a metapackage that serves as the **single source of truth** for the R package environment:

- **DESCRIPTION** defines all packages to install (CRAN, Bioconductor, GitHub)
- **Version** in DESCRIPTION drives container versioning (3.22.0 = Bioconductor 3.22)
- GitHub remotes are pinned to specific commits/tags for reproducibility

See `rbiocverse/DESCRIPTION` for the full package list organized by category:
- Development (BiocManager, devtools, targets, renv)
- Tidyverse & Data
- Bioconductor Core
- Single Cell (Seurat, scran, harmony, slingshot, etc.)
- Bulk RNA-seq (DESeq2, edgeR, limma)
- Visualization (ggplot2, ComplexHeatmap, dittoSeq)

## Scripts

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `update-description.R sync` | Sync DESCRIPTION with installed packages | Step 1: Capture current ~1600 packages |
| `update-description.R check` | Check/remove unavailable packages | Step 2: Before new Bioconductor release |
| `update-description.R remotes` | Update GitHub remote pins | Step 3: Pin to latest tags/commits |
| `update-description.R bump` | Bump version number | Step 3: After sync/check |
| `install.R` | Install packages from DESCRIPTION | Step 6: After pulling new container |
| `migrate-packages.R` | Export/compare package environments | Auditing, troubleshooting |

## Files

```
├── .devcontainer/
│   └── devcontainer.json       # VSCode devcontainer config
├── .github/workflows/
│   └── publish-to-github-package.yaml
├── rbiocverse/
│   ├── DESCRIPTION             # Package manifest (source of truth)
│   ├── LICENSE
│   └── NAMESPACE
├── scripts/
│   ├── update-description.R    # Pre-release: check/update packages
│   ├── install.R               # Post-deploy: install from DESCRIPTION
│   ├── migrate-packages.R      # Audit: export/compare environments
│   └── slurm-wrappers.sh       # SLURM SSH wrapper installer
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
