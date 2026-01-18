# Changelog

All notable changes to the HPC Code Server Manager.

## [0.0.5] - 2026-01-17

### Added

- **Multi-User Authentication** - JWT-based login with session management
  - Login/logout with test credentials (dev) or LDAP (prod)
  - Session tokens with configurable expiry (7 days default)
  - Timing-safe token verification to prevent timing attacks
  - JWT_SECRET environment variable required (fail-fast on startup)

- **Per-User SSH Key Management** - Ed25519 keypairs for cluster access
  - Automatic SSH test on first login
  - Generate managed keys if user's SSH doesn't work
  - Users copy public key to ~/.ssh/authorized_keys
  - HpcService uses per-user private keys for SSH connections
  - Keys stored in users.json (TODO: AES-256-GCM encryption)

- **Theme Support** - Light and dark themes
  - Theme toggle in header toolbar
  - System preference detection (prefers-color-scheme)
  - Theme persisted in localStorage
  - CSS custom properties for consistent styling

- **Help System** - Built-in contextual documentation
  - Markdown-based help content with template syntax
  - Live cluster data embedding ({{gemini.cpus.percent}})
  - Ternary expressions for conditional display
  - SVG icons with size customization
  - Full-text search across all help sections
  - Widget embedding for React components

### Changed

- **SSH Key Algorithm** - Changed from RSA 4096-bit to Ed25519
  - Modern, faster, smaller keys
  - OpenSSH format for authorized_keys compatibility

- **File Writes** - Atomic writes for data integrity
  - users.json uses temp file + rename pattern
  - ErrorLogger uses same atomic write pattern

### Fixed

- **JWT Token Security** - Added timing-safe signature comparison
- **Icon Regex** - Allow hyphens in icon names (e.g., help-circle)
- **Theme Borders** - Use CSS variable for light mode contrast

## [0.0.4] - 2026-01-08

### Added

- **React UI Migration** - Launcher rebuilt with React + Vite for improved maintainability
- **24hr Trend Sparklines** - Health indicators now show usage trends over past 24 hours
- **GPU Queue Health Display** - Selecting A100/V100 shows GPU-specific utilization stats
- **Per-partition Health Stats** - CPU/memory stats update based on selected GPU partition
- **Stale Session Detection** - Verify SLURM job exists before reconnecting to prevent failed tunnels
- **Shiny Server Support** - Port 3838 passed through for Shiny apps in RStudio/VS Code

### Fixed

- **Session Reconnection** - Preserve releaseVersion and GPU selection on reconnect to existing jobs
- **Cluster Health Polling** - Poll health data when ANY cluster has stale data, not just first
- **GPU Icons** - Fixed GPU icon rendering and layout stability in accelerator toggle
- **RStudio Python** - Correct PYTHONPATH and RETICULATE_PYTHON paths for Python integration
- **Form Validation** - Client-side validation for resource inputs (CPUs, memory, time)

### Changed

- **Health Bar Layout** - Fairshare indicator moved to leftmost position (most important for user)
- **Sparkline Position** - Trend lines displayed above health bars with consistent baseline alignment

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
