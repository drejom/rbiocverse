# Changelog

All notable changes to the HPC Code Server Manager.

## [Unreleased]

### Breaking Changes

- **Method Renames in HpcService** (`services/hpc.js`)
  - `buildVscodeWrap()` → `buildVscodeScript()`
  - `buildRstudioWrap()` → `buildRstudioScript()`
  - `buildJupyterWrap()` → `buildJupyterScript()`
  - These methods now return full bash scripts (heredoc format) instead of `--wrap` command strings

- **Job Submission Format**
  - Jobs now submitted via heredoc (`<<'SLURM_SCRIPT'`) instead of `sbatch --wrap`
  - Shell variables use `$VAR` (unescaped) instead of `\\$VAR`
  - Cleaner scripts, easier debugging

- **VS Code CLI 1.107+ Compatibility**
  - Removed `--extensions-dir` and `--user-data-dir` flags (no longer supported)
  - Only `--server-data-dir` is used
  - Keybindings now written to `server-data-dir/data/User/` instead of separate user-data dir

### Added

- **Parallel Processing Environment Variables**
  - `OMP_NUM_THREADS` - OpenMP threads (all IDEs)
  - `MKL_NUM_THREADS` - Intel MKL threads (all IDEs)
  - `OPENBLAS_NUM_THREADS` - OpenBLAS threads (all IDEs)
  - `NUMEXPR_NUM_THREADS` - NumPy numexpr threads (all IDEs)
  - `MC_CORES` - R `parallel::mclapply` cores (all IDEs)
  - `BIOCPARALLEL_WORKER_NUMBER` - BiocParallel workers (all IDEs)
  - All set from SLURM CPU allocation (`cpus` parameter)

- **Release Selector Support**
  - `releaseVersion` parameter in all build methods
  - `getReleasePaths(cluster, releaseVersion)` helper
  - Dynamic `R_LIBS_USER` path based on release (e.g., `$HOME/R/bioc-3.22`)
  - Per-release Singularity images and R library paths

- **Job Debugging**
  - `exec 2>$HOME/.{ide}-slurm/job.err` - stderr capture to file
  - `set -ex` - fail fast with command trace
  - Easier debugging of job startup failures

### Changed

- **Singularity Command Generation**
  - Environment args now built as arrays with `.filter(Boolean).join()`
  - Cleaner multiline formatting with line continuations
  - Paths from `getReleasePaths()` instead of hardcoded cluster properties

### Fixed

- **VS Code Auth Flow (1.107+)**
  - Cookie rewriting to work through proxy domain
  - Token injection when cookie not present
  - Root path token handling for new auth flow

- **Proxy Path Preservation**
  - Full path now preserved in VS Code and Jupyter proxy requests
  - Fixed path rewriting for nested resources
