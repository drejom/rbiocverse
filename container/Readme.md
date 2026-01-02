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

The migration has two phases: **pre-release** (capture packages from old) and **post-release** (install to new).

### Phase 1: Pre-Release (Sync from Old Environment)

Run on HPC cluster to capture packages from the current version:

```sh
# 1. Sync DESCRIPTION with packages from current (e.g., 3.19) environment
./scripts/sync-packages.sh --from 3.19         # Preview
./scripts/sync-packages.sh --from 3.19 --apply # Apply

# 2. Check availability in new Bioconductor version
Rscript scripts/update-description.R check --apply

# 3. Update GitHub remotes and bump version
Rscript scripts/update-description.R remotes --apply
Rscript scripts/update-description.R bump bioc

# 4. Update Dockerfile
# Edit line 3: ARG BIOC_VERSION=RELEASE_3_22

# 5. Commit and tag to trigger CI build
git add -A && git commit -m "Bump to Bioconductor 3.22"
git tag v2025-MM-DD
git push && git push --tags
```

### Phase 2: Post-Release (Install to New Environment)

Run after the new container is built and available:

```sh
# 1. Pull new container (auto-detects cluster: Gemini/Apollo)
./scripts/pull-container.sh --force

# 2. Generate and submit two-phase SLURM install
./scripts/install-packages.sh --to 3.22 --submit

# Or generate without submitting:
./scripts/install-packages.sh --to 3.22
./slurm_install/submit_install.sh
```

### Two-Phase Installation Strategy

The install uses a two-phase SLURM strategy to avoid NFS lock contention:

1. **Phase 1 (single job)**: Install core dependencies with high CPU/memory
2. **Phase 2 (job array)**: Install remaining packages in parallel

Each job uses a local pak cache (`/tmp/pak_cache_*`) to prevent NFS lock issues.

### Update Launch Scripts
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

### Wrapper Scripts (recommended)
| Script | Purpose | When to Use |
|--------|---------|-------------|
| `sync-packages.sh --from X.Y` | Sync DESCRIPTION from existing library | Pre-release: capture packages |
| `install-packages.sh --to X.Y` | Generate/submit SLURM install jobs | Post-release: install packages |
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
│   ├── DESCRIPTION             # Package manifest (source of truth)
│   ├── LICENSE
│   └── NAMESPACE
├── scripts/
│   ├── cluster-config.sh       # Shared cluster detection and paths
│   ├── sync-packages.sh        # Pre-release: sync from old environment
│   ├── install-packages.sh     # Post-release: install to new environment
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

## Previous Versions

| Bioconductor | Container Tag | R_LIBS_SITE |
|--------------|---------------|-------------|
| 3.22 | `ghcr.io/drejom/vscode-rbioc:latest` | `rlibs/bioc-3.22` |
| 3.19 | `ghcr.io/drejom/vscode-rbioc:v2024-7-17` | `rlibs/bioc-3.19` |
| 3.18 | `ghcr.io/drejom/vscode-rbioc:v2023-11-27` | `rlibs/bioc-3.18` |
| 3.17 | `ghcr.io/drejom/vscode-rbioc:v2023-9-26` | `rlibs/bioc-3.17` |
