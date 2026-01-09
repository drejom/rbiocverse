# Developer Guide

This guide covers how to maintain, update, and build the rbiocverse container.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Container (lean, ~2-3GB)                                   │
│  - System dependencies (libhdf5, libgdal, etc.)            │
│  - Genomics tools (bcftools, bedtools, sra-tools)          │
│  - Python packages (jupyterlab, radian, rpy2)              │
│  - VSCode CLI, pixi, SLURM wrappers                        │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ mounts R_LIBS_SITE + PYTHONPATH
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Shared Libraries (on HPC storage)                         │
│  /packages/singularity/shared_cache/rbioc/                 │
│  ├── rlibs/bioc-X.Y/    # ~1500 R packages                 │
│  └── python/bioc-X.Y/   # SCverse Python packages          │
└─────────────────────────────────────────────────────────────┘
```

**Design Principles:**
- Container has system deps only (~2-3GB) - fast to pull/update
- R/Python packages live on shared storage - updated independently
- All users share the same library - single point of maintenance
- Package updates don't require container rebuilds

### Cluster Paths

| Cluster | Container | R Library | Python Library |
|---------|-----------|-----------|----------------|
| Gemini | `/packages/singularity/shared_cache/rbioc/vscode-rbioc_X.Y.sif` | `.../rlibs/bioc-X.Y` | `.../python/bioc-X.Y` |
| Apollo | `/opt/singularity-images/rbioc/vscode-rbioc_X.Y.sif` | `.../rlibs/bioc-X.Y` | `.../python/bioc-X.Y` |

## Local Development

### Build Container Locally

```bash
docker buildx create --use
docker buildx build --load --platform linux/amd64 \
    -t ghcr.io/drejom/vscode-rbioc:latest \
    --progress=plain . 2>&1 | tee build.log
```

### Test Container

```bash
# Interactive shell
docker run -it --rm ghcr.io/drejom/vscode-rbioc:latest /bin/bash

# Test specific tools
docker run --rm ghcr.io/drejom/vscode-rbioc:latest pixi --version
docker run --rm ghcr.io/drejom/vscode-rbioc:latest R --version
docker run --rm ghcr.io/drejom/vscode-rbioc:latest jupyter --version
```

### VSCode Devcontainer

1. Install [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Open repo in VSCode
3. Click "Reopen in Container"

## Bioconductor Version Upgrade

The upgrade has two phases: **pre-release** (sync from old) and **post-release** (install to new).

### Phase 1: Pre-Release (Before New Bioc Release)

Run on HPC to capture packages from the current environment:

#### 1. Sync R Packages

```bash
# Preview what will change
./scripts/sync-packages.sh --from 3.22

# Apply changes to DESCRIPTION
./scripts/sync-packages.sh --from 3.22 --apply
```

#### 2. Sync Python Packages

```bash
# Compare installed vs pyproject.toml
./scripts/sync-python-packages.sh --from 3.22

# Review output - for each "NEW STAGED CANDIDATE":
#   PROMOTE: move to [project.dependencies]
#   KEEP: add to [optional-dependencies.staged]
#   DROP: don't carry forward

# Edit rbiocverse/pyproject.toml accordingly
```

#### 3. Check Package Availability

```bash
# Check if packages exist in new Bioconductor
Rscript scripts/update-description.R check --apply

# Update GitHub remotes (pin to tags/commits)
Rscript scripts/update-description.R remotes --apply

# Bump version
Rscript scripts/update-description.R bump bioc
```

#### 4. Update Dockerfile

Edit line 3 of `Dockerfile`:
```dockerfile
ARG BIOC_VERSION=RELEASE_3_23
```

#### 5. Commit and Tag

```bash
git add -A
git commit -m "Bump to Bioconductor 3.23"

# Choose tag format:
git tag v2026-1-15    # Dev release (date-based)
git tag v3.23.0       # Stable release (semver)

git push && git push --tags
```

### Phase 2: Post-Release (After Container Built)

#### 1. Pull Container

```bash
# Auto-detects cluster (Gemini/Apollo)
./scripts/pull-container.sh --force
```

#### 2. Install R Packages

```bash
# Generate and submit SLURM jobs
./scripts/install-packages.sh --to 3.23 --submit

# Or generate without submitting
./scripts/install-packages.sh --to 3.23
./slurm_install/submit_install.sh
```

#### 3. Install Python Packages

```bash
# Generate and submit SLURM job
./scripts/install-python.sh --to 3.23 --submit

# Or generate without submitting
./scripts/install-python.sh --to 3.23
./slurm_install/submit_python.sh
```

#### 4. Update Launch Scripts

Update `R_LIBS_SITE` and `PYTHONPATH` in user scripts:
```bash
R_LIBS_SITE=/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.23
PYTHONPATH=/packages/singularity/shared_cache/rbioc/python/bioc-3.23
```

## Two-Phase SLURM Installation

The install uses a two-phase strategy to avoid NFS lock contention:

1. **Phase 1 (single job)**: Install core dependencies (BiocGenerics, S4Vectors, Seurat, tidyverse) with high CPU/memory
2. **Phase 2 (job array)**: Install remaining packages in parallel with moderate resources

Each job uses a local pak cache (`/tmp/pak_cache_*`) to prevent NFS lock issues.

## System Dependencies Reference

The Dockerfile includes system libraries required by specific R packages:

| R Package | System Dependencies |
|-----------|---------------------|
| Seurat v5 | libhdf5-dev |
| monocle3 | libmysqlclient-dev, libudunits2-dev, libgdal-dev, libgeos-dev, libproj-dev |
| velocyto.R | libboost-all-dev, libomp-dev |
| bedr | bedtools, bedops |
| ctrdata | libjq-dev, php, php-xml, php-json |
| IRkernel/Jupyter | libzmq3-dev |
| General graphics | libcairo2-dev, libfontconfig1-dev, libpng-dev |

## Adding New Packages

### R Packages

Edit `rbiocverse/DESCRIPTION`:

```
Imports:
    existing_package,
    new_package
```

For GitHub packages, also add to Remotes:
```
Remotes:
    github::user/repo
```

For archived CRAN packages:
```
Remotes:
    url::https://cran.r-project.org/src/contrib/Archive/pkg/pkg_1.0.0.tar.gz
```

### Python Packages

Edit `rbiocverse/pyproject.toml`:

**Core packages** (always installed):
```toml
[project.dependencies]
new-package = ">=1.0"
```

**GPU packages** (Gemini only):
```toml
[optional-dependencies.gpu]
gpu-package = ">=1.0"
```

**Staged packages** (experimental, reviewed at upgrade):
```toml
[optional-dependencies.staged]
experimental-package = ">=1.0"
```

### Container Packages (Dockerfile)

For packages that must be in the container (not shared library):

**Python packages** - add to pip install section:
```dockerfile
RUN pip3 install --no-cache-dir --break-system-packages \
    existing \
    new_package \
```

**System dependencies** - add to apt-get section:
```dockerfile
RUN apt-get update && apt-get -y install --no-install-recommends \
    existing-dev \
    new-dev \
```

## CI/CD

GitHub Actions (`.github/workflows/publish-to-github-package.yaml`) builds on:
- Push of version tags (`v*`)
- Manual workflow dispatch

### Container Tags

| Tag Type | Format | Example | When to Use |
|----------|--------|---------|-------------|
| Dev releases | `vYYYY-M-DD` | `v2026-1-15` | Incremental updates |
| Stable releases | `vX.Y.Z` | `v3.23.0` | Major Bioc upgrades |
| Latest | `latest` | - | Auto-generated |
| Bioc version | `RELEASE_X_YY` | `RELEASE_3_23` | Auto-generated |

### Triggering a Build

```bash
# Dev release
git tag v2026-1-15
git push --tags

# Stable release
git tag v3.23.0
git push --tags
```

### Version History

| Bioconductor | Stable Tag | Dev Tags | R_LIBS_SITE |
|--------------|------------|----------|-------------|
| 3.22 | `v3.22.0` | `v2026-1-4`, `v2026-1-3` | `rlibs/bioc-3.22` |
| 3.19 | - | `v2024-7-17` | `rlibs/bioc-3.19` |
| 3.18 | - | `v2023-11-27` | `rlibs/bioc-3.18` |
| 3.17 | - | `v2023-9-26` | `rlibs/bioc-3.17` |

## Scripts Reference

### Wrapper Scripts

| Script | Purpose |
|--------|---------|
| `sync-packages.sh --from X.Y` | Sync R DESCRIPTION from existing library |
| `sync-python-packages.sh --from X.Y` | Sync Python pyproject.toml from existing library |
| `install-packages.sh --to X.Y` | Generate/submit SLURM R package install |
| `install-python.sh --to X.Y` | Generate/submit SLURM Python install |
| `pull-container.sh` | Pull container to cluster storage |

### R Scripts

| Script | Purpose |
|--------|---------|
| `update-description.R sync` | Sync DESCRIPTION with installed packages |
| `update-description.R check` | Check/remove unavailable packages |
| `update-description.R remotes` | Update GitHub remote pins |
| `update-description.R bump` | Bump version number |
| `install.R` | Core installation logic, SLURM generation |
| `migrate-packages.R` | Export/compare package environments |

### Utility Scripts

| Script | Purpose |
|--------|---------|
| `cluster-config.sh` | Shared cluster detection and path functions |
| `slurm-wrappers.sh` | Install SLURM SSH passthrough wrappers |
| `install-vscode-extension.sh` | Download VS Code extensions from marketplace |

## File Structure

```
├── .devcontainer/
│   └── devcontainer.json       # VSCode devcontainer config
├── .github/workflows/
│   └── publish-to-github-package.yaml
├── config/
│   └── jupyter_lab_config.py   # JupyterLab HPC defaults
├── rbiocverse/                 # Package manifests (source of truth)
│   ├── DESCRIPTION             # R packages (CRAN, Bioconductor, GitHub)
│   ├── pyproject.toml          # Python packages (SCverse, GPU deps)
│   ├── LICENSE
│   └── NAMESPACE
├── scripts/
│   ├── cluster-config.sh       # Cluster detection
│   ├── sync-packages.sh        # Pre-release: R sync
│   ├── sync-python-packages.sh # Pre-release: Python sync
│   ├── sync-python.py          # Python categorization helper
│   ├── install-packages.sh     # Post-release: R install
│   ├── install-python.sh       # Post-release: Python install
│   ├── pull-container.sh       # Pull container
│   ├── update-description.R    # DESCRIPTION management
│   ├── install.R               # R install logic
│   ├── migrate-packages.R      # Environment comparison
│   ├── slurm-wrappers.sh       # SLURM SSH wrappers
│   └── install-vscode-extension.sh
├── slurm_install/              # Generated (gitignored)
├── Dockerfile
├── CHANGELOG.md
├── CLAUDE.md                   # AI assistant instructions
├── DEVELOPER_GUIDE.md          # This file
├── USER_GUIDE.md               # End-user documentation
└── Readme.md                   # Overview
```

## Troubleshooting

### Package Installation Failures

**NFS lock errors:**
- Ensure using local pak cache (`/tmp/pak_cache_*`)
- Check SLURM job isn't sharing cache directory

**Compilation errors:**
- Check system dependencies in Dockerfile
- Look for missing `-dev` packages

**GitHub rate limits:**
- Use `GITHUB_PAT` environment variable
- Consider pinning to specific commits

### Container Build Issues

**Platform mismatch:**
- Always build with `--platform linux/amd64`
- HPC clusters require x86_64

**Layer caching:**
- Order Dockerfile commands by change frequency
- System deps first, Python packages after

### JupyterLab Extension Issues

**Extension not loading:**
- Some extensions (like jupyter-server-proxy) must be in Dockerfile, not PYTHONPATH
- Check `jupyter server extension list`

**LSP not working:**
- Ensure `python-lsp-server[all]` is installed
- Check JupyterLab console for errors

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `/usr/local/share/` not `/opt/` | Apollo bind mounts `/opt` from host |
| pak over install.packages | 10x faster, better dependency resolution |
| pixi over conda | 10x faster, native lockfiles |
| Two-phase SLURM | Avoids NFS lock contention |
| Shared library mount | Updates without container rebuilds |
| GitHub packages via remotes | pak has issues with subdirectory syntax |
| jupyter-server-proxy in Dockerfile | Extensions need auto-registration |
