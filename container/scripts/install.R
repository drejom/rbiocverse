#!/usr/bin/env Rscript
# install.R
# Install all packages from rbiocverse/DESCRIPTION
# Run this FROM the new container to populate R_LIBS_SITE
#
# Usage:
#   singularity exec --env R_LIBS_SITE=/path/to/rlibs container.sif \
#     Rscript /mnt/rbiocverse/scripts/install.R
#
# Or for HPC parallel install (two-phase: deps first, then leaves):
#   Rscript /mnt/rbiocverse/scripts/install.R --slurm-smart 20
#
# Or legacy single-phase (may have lock contention):
#   Rscript /mnt/rbiocverse/scripts/install.R --slurm 20

# =============================================================================
# Configuration
# =============================================================================

# Path to DESCRIPTION (mounted at /mnt/rbiocverse in container)
DESCRIPTION_PATH <- Sys.getenv(
  "RBIOCVERSE_DESCRIPTION",
  "/mnt/rbiocverse/rbiocverse/DESCRIPTION"
)

# =============================================================================
# Cluster Configuration
# =============================================================================

#' Detect which HPC cluster we're on
detect_cluster <- function() {
  # Check for Gemini paths first

if (dir.exists("/packages/singularity")) return("gemini")
  # Check for Apollo paths
  if (dir.exists("/opt/singularity-images")) return("apollo")
  # Default to gemini if can't detect (e.g., local dev)
  "gemini"
}

#' Get cluster-specific configuration
#' @param cluster Cluster name ("gemini" or "apollo")
#' @param bioc_version Bioconductor version (e.g., "3.22")
get_cluster_config <- function(cluster = detect_cluster(), bioc_version = "3.22") {
  configs <- list(
    gemini = list(
      name = "Gemini",
      sif = sprintf("/packages/singularity/shared_cache/rbioc/vscode-rbioc_%s.sif", bioc_version),
      lib = sprintf("/packages/singularity/shared_cache/rbioc/rlibs/bioc-%s", bioc_version),
      bind = "/packages,/scratch",
      # Phase 1: core deps - high CPU for parallel compilation
      phase1_cpus = 32,
      phase1_mem = "64G",
      phase1_time = "4:00:00",
      # Phase 2: leaf packages - moderate CPU
      phase2_cpus = 8,
      phase2_mem = "16G",
      phase2_time = "2:00:00"
    ),
    apollo = list(
      name = "Apollo",
      sif = sprintf("/opt/singularity-images/rbioc/vscode-rbioc_%s.sif", bioc_version),
      lib = sprintf("/opt/singularity-images/rbioc/rlibs/bioc-%s", bioc_version),
      bind = "/opt,/labs,/run,/ref_genome",
      # Apollo has smaller nodes (median 28 CPUs)
      phase1_cpus = 24,
      phase1_mem = "48G",
      phase1_time = "4:00:00",
      phase2_cpus = 4,
      phase2_mem = "16G",
      phase2_time = "2:00:00"
    )
  )

  if (!cluster %in% names(configs)) {
    stop("Unknown cluster: ", cluster, ". Use 'gemini' or 'apollo'.", call. = FALSE)
  }

  configs[[cluster]]
}

# =============================================================================
# Helper Functions
# =============================================================================

#' Validate R_LIBS_SITE is set
validate_lib <- function() {
  lib <- Sys.getenv("R_LIBS_SITE")
  if (lib == "") {
    stop(
      "R_LIBS_SITE is not set.\n",
      "Run with: --env R_LIBS_SITE=/path/to/rlibs",
      call. = FALSE
    )
  }
  if (!dir.exists(lib)) {
    message("Creating library directory: ", lib)
    dir.create(lib, recursive = TRUE)
  }
  lib
}

#' Parse DESCRIPTION file and extract packages
parse_description <- function(path = DESCRIPTION_PATH) {
  if (!file.exists(path)) {
    stop("DESCRIPTION not found: ", path, "\n",
         "Are you running from inside the container?", call. = FALSE)
  }

  desc <- read.dcf(path, all = TRUE)

  # Parse Imports (remove comments and clean)
  imports_str <- desc$Imports
  imports_str <- gsub("#[^\n]*", "", imports_str)
  imports <- strsplit(imports_str, ",\\s*")[[1]]
  imports <- trimws(imports)
  imports <- imports[imports != ""]
  # Remove version constraints
  imports <- gsub("\\s*\\([^)]+\\)", "", imports)

  # Parse Remotes and create a mapping from package name to remote spec
  remotes <- character(0)
  remote_map <- list()
  if (!is.null(desc$Remotes) && !is.na(desc$Remotes)) {
    remotes <- strsplit(desc$Remotes, ",\\s*")[[1]]
    remotes <- trimws(remotes)
    remotes <- remotes[remotes != ""]

    # Build mapping from package name to remote spec
    # Known repo->package name mappings for GitHub packages with non-standard names
    repo_to_pkg <- c(
      "seurat-data" = "SeuratData",
      "seurat-disk" = "SeuratDisk",
      "seurat-wrappers" = "SeuratWrappers"
    )

    for (remote in remotes) {
      # Extract package name from remote spec
      # url::https://...pkg_version.tar.gz -> pkg
      # user/repo@ref -> repo
      # user/repo/subdir@ref -> repo (not subdir!)
      if (grepl("^url::", remote)) {
        # URL remote: extract package name from filename
        # e.g., url::https://cran.r-project.org/.../grr_0.9.5.tar.gz -> grr
        pkg_name <- sub(".*/([-a-zA-Z0-9.]+)_[0-9].*\\.tar\\.gz$", "\\1", remote)
      } else {
        # GitHub remote: user/repo[@ref] or user/repo/subdir[@ref]
        # First strip @ref
        base <- sub("@.*$", "", remote)
        # Split by /
        parts <- strsplit(base, "/")[[1]]
        # repo is always the second part (user/repo or user/repo/subdir)
        repo_name <- if (length(parts) >= 2) parts[2] else parts[1]
        # Use explicit mapping if available, otherwise use repo name as-is
        pkg_name <- if (repo_name %in% names(repo_to_pkg)) repo_to_pkg[[repo_name]] else repo_name
      }
      remote_map[[pkg_name]] <- remote
    }
  }

  list(
    version = desc$Version,
    imports = imports,
    remotes = remotes,
    remote_map = remote_map
  )
}

#' Get core dependencies that should be installed first
#' These are packages that many other packages depend on
get_core_deps <- function() {
  # Core Bioconductor infrastructure (install order matters)
  bioc_core <- c(
    "BiocGenerics", "S4Vectors", "IRanges", "GenomeInfoDb", "XVector",
    "GenomicRanges", "Biostrings", "Rsamtools", "GenomicAlignments",
    "SummarizedExperiment", "SingleCellExperiment", "DelayedArray",
    "HDF5Array", "rhdf5", "Rhdf5lib", "BiocParallel", "BiocFileCache",
    "AnnotationDbi", "AnnotationHub", "ExperimentHub", "biomaRt",
    "GenomicFeatures", "rtracklayer", "BSgenome", "Biobase"
  )

  # Core tidyverse/data manipulation
  tidyverse_core <- c(
    "rlang", "vctrs", "cli", "glue", "lifecycle", "pillar", "tibble",
    "dplyr", "tidyr", "purrr", "stringr", "forcats", "lubridate",
    "readr", "readxl", "haven", "ggplot2", "scales", "tidyverse"
  )

  # Core data.table and matrix operations
  data_core <- c(
    "data.table", "Matrix", "MatrixGenerics", "sparseMatrixStats",
    "DelayedMatrixStats", "matrixStats", "Rcpp", "RcppArmadillo",
    "RcppEigen", "RcppParallel"
  )

  # Core stats/ML
  stats_core <- c(
    "MASS", "lattice", "nlme", "mgcv", "survival", "lme4",
    "caret", "randomForest", "xgboost", "glmnet"
  )

  # Single-cell core (Seurat deps)
  sc_core <- c(
    "Seurat", "SeuratObject", "sctransform", "future", "future.apply",
    "irlba", "RANN", "uwot", "leiden", "igraph", "scran", "scater",
    "scuttle", "DropletUtils", "batchelor"
  )

  # Visualization
  viz_core <- c(
    "ggplot2", "cowplot", "patchwork", "gridExtra", "ggrepel",
    "ComplexHeatmap", "circlize", "RColorBrewer", "viridis", "pheatmap"
  )

  # Development tools
dev_core <- c(
    "devtools", "usethis", "testthat", "roxygen2", "pkgdown",
    "knitr", "rmarkdown", "pak"
  )

  unique(c(bioc_core, tidyverse_core, data_core, stats_core, sc_core, viz_core, dev_core))
}

# =============================================================================
# Install Functions
# =============================================================================

#' Install all packages using pak
#' @param ncpus Number of parallel workers
install_all <- function(ncpus = parallel::detectCores()) {
  lib <- validate_lib()
  pkgs <- parse_description()

  message("=== rbiocverse ", pkgs$version, " ===")
  message("Installing to: ", lib)
  message("Packages: ", length(pkgs$imports), " imports + ", length(pkgs$remotes), " remotes")
  message("CPUs: ", ncpus)
  message("")

  # Ensure pak is available
  if (!requireNamespace("pak", quietly = TRUE)) {
    message("Installing pak...")
    install.packages("pak", lib = lib)
  }

  options(Ncpus = ncpus)

  # Install CRAN/Bioc packages
  message("=== Installing CRAN/Bioconductor packages ===")
  tryCatch(
    pak::pkg_install(pkgs$imports, lib = lib, upgrade = FALSE),
    error = function(e) {
      message("Some packages failed. Continuing with remotes...")
      message("Error: ", conditionMessage(e))
    }
  )

  # Install GitHub packages using remotes (pak has issues with subdirectory syntax)
  if (length(pkgs$remotes) > 0) {
    message("\n=== Installing GitHub packages ===")
    if (!requireNamespace("remotes", quietly = TRUE)) {
      message("Installing remotes...")
      install.packages("remotes", lib = lib)
    }
    for (remote in pkgs$remotes) {
      message("Installing: ", remote)
      tryCatch({
        # Parse remote to determine install method
        if (grepl("^url::", remote)) {
          # URL-based remote (archived CRAN packages)
          pak::pkg_install(remote, lib = lib, upgrade = FALSE)
        } else {
          # GitHub remote - use remotes:: to handle subdirectories properly
          remotes::install_github(remote, lib = lib, upgrade = "never")
        }
      }, error = function(e) message("  FAILED: ", conditionMessage(e)))
    }
  }

  message("\n=== Installation complete ===")
  message("Library: ", lib)
}

#' Generate legacy SLURM job array (single phase, may have lock contention)
generate_slurm <- function(jobs = 20, output_dir = "slurm_install",
                           cluster = detect_cluster(), bioc_version = "3.22") {
  lib <- Sys.getenv("R_LIBS_SITE")
  if (lib == "") {
    stop("R_LIBS_SITE must be set for SLURM generation", call. = FALSE)
  }

  config <- get_cluster_config(cluster, bioc_version)
  pkgs <- parse_description()
  all_pkgs <- c(pkgs$imports, pkgs$remotes)

  # Split into chunks
  chunks <- split(all_pkgs, cut(seq_along(all_pkgs), jobs, labels = FALSE))

  # Use absolute path for output directory
  dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
  output_dir_abs <- normalizePath(output_dir)

  # Write package lists
  for (i in seq_along(chunks)) {
    writeLines(chunks[[i]], file.path(output_dir_abs, sprintf("pkgs_%03d.txt", i)))
  }

  # Generate SLURM script with absolute paths
  slurm_script <- sprintf('#!/bin/bash
#SBATCH --job-name=rbiocverse_install
#SBATCH --array=1-%d
#SBATCH --cpus-per-task=%d
#SBATCH --mem=%s
#SBATCH --time=%s
#SBATCH --output=%s/install_%%a.log

# Cluster: %s
SINGULARITY_IMAGE="%s"
BIND_PATHS="%s"
R_LIBS_SITE="%s"

module load singularity 2>/dev/null || true

PKGFILE=%s/pkgs_$(printf "%%03d" $SLURM_ARRAY_TASK_ID).txt

if [ ! -f "$PKGFILE" ]; then
    echo "Package file not found: $PKGFILE"
    exit 1
fi

echo "Installing packages from: $PKGFILE"
echo "Target library: $R_LIBS_SITE"

singularity exec \\
  --env R_LIBS=/usr/local/lib/R/site-library \\
  --env R_LIBS_SITE=$R_LIBS_SITE \\
  --env SLURM_CPUS=$SLURM_CPUS_PER_TASK \\
  -B $BIND_PATHS \\
  "$SINGULARITY_IMAGE" \\
  Rscript -e "
    ncpus <- as.integer(Sys.getenv(\\"SLURM_CPUS\\", parallel::detectCores()))
    options(Ncpus = ncpus)
    lib <- Sys.getenv(\\"R_LIBS_SITE\\")
    pkgs <- readLines(\\"$PKGFILE\\")
    for (pkg in pkgs) {
      message(sprintf(\\"Installing %%s...\\", pkg))
      tryCatch({
        if (grepl(\\\"^url::\\\", pkg)) {
          # URL remote (archived CRAN)
          pak::pkg_install(pkg, lib = lib, upgrade = FALSE)
        } else if (grepl(\\\"/\\\", pkg)) {
          # GitHub remote - use remotes:: to handle subdirs properly
          remotes::install_github(pkg, lib = lib, upgrade = \\"never\\")
        } else {
          # CRAN/Bioc package
          pak::pkg_install(pkg, lib = lib, upgrade = FALSE)
        }
      }, error = function(e) message(sprintf(\\"  FAILED: %%s\\", conditionMessage(e))))
    }
  "
', jobs, config$phase2_cpus, config$phase2_mem, config$phase2_time,
   output_dir_abs, config$name, config$sif, config$bind, lib, output_dir_abs)

  script_path <- file.path(output_dir_abs, "install.slurm")
  writeLines(slurm_script, script_path)

  message("Generated SLURM job array (legacy mode):")
  message("  Cluster: ", config$name)
  message("  Jobs: ", jobs)
  message("  Packages per job: ~", ceiling(length(all_pkgs) / jobs))
  message("  Output: ", output_dir_abs, "/")
  message("")
  message("Submit with:")
  message("  sbatch ", script_path)

  invisible(script_path)
}

#' Generate two-phase SLURM install (deps first, then leaves)
#' This avoids lock contention by installing shared deps in phase 1
generate_slurm_smart <- function(jobs = 20, output_dir = "slurm_install",
                                  cluster = detect_cluster(), bioc_version = "3.22") {
  config <- get_cluster_config(cluster, bioc_version)

  # Use config lib path (not environment - we're generating scripts, not installing)
  lib <- config$lib
  pkgs <- parse_description()

  # Helper to convert package name to install spec (using remote if available)
  to_install_spec <- function(pkg_names) {
    sapply(pkg_names, function(pkg) {
      if (pkg %in% names(pkgs$remote_map)) {
        pkgs$remote_map[[pkg]]
      } else {
        pkg
      }
    }, USE.NAMES = FALSE)
  }

  # All packages to install (imports only, remotes are handled via remote_map)
  all_pkgs <- pkgs$imports

  # Get core deps to install first
  core_deps <- get_core_deps()
  core_deps <- intersect(core_deps, all_pkgs)  # Only include deps we actually need

  # Add packages with special remotes (URL/GitHub) to core deps
  # These must be installed first so their dependents can find them
  remote_pkgs <- names(pkgs$remote_map)
  core_deps <- unique(c(core_deps, intersect(remote_pkgs, all_pkgs)))

  # Remaining packages after core deps
  leaf_pkgs <- setdiff(all_pkgs, core_deps)

  # Use absolute path for output directory
  dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
  output_dir_abs <- normalizePath(output_dir)

  # Write core deps list (with remote specs where applicable)
  writeLines(to_install_spec(core_deps), file.path(output_dir_abs, "pkgs_deps.txt"))

  # Split leaf packages into chunks (with remote specs where applicable)
  chunks <- split(leaf_pkgs, cut(seq_along(leaf_pkgs), jobs, labels = FALSE))
  for (i in seq_along(chunks)) {
    writeLines(to_install_spec(chunks[[i]]), file.path(output_dir_abs, sprintf("pkgs_leaf_%03d.txt", i)))
  }

  # Phase 1: Install core dependencies (single job, high resources)
  phase1_script <- sprintf('#!/bin/bash
#SBATCH --job-name=rbioc_deps
#SBATCH --cpus-per-task=%d
#SBATCH --mem=%s
#SBATCH --time=%s
#SBATCH --output=%s/install_deps.log

# Phase 1: Install core dependencies
# Cluster: %s
SINGULARITY_IMAGE="%s"
BIND_PATHS="%s"
R_LIBS_SITE="%s"

module load singularity 2>/dev/null || true

echo "=== Phase 1: Installing core dependencies ==="
echo "Cluster: %s"
echo "Container: $SINGULARITY_IMAGE"
echo "Library: $R_LIBS_SITE"
echo "Packages: %d core dependencies"
echo ""

# Use job-local cache to avoid NFS lock contention
export PAK_CACHE_DIR=/tmp/pak_cache_phase1
mkdir -p $PAK_CACHE_DIR

singularity exec \\
  --env R_LIBS=/usr/local/lib/R/site-library \\
  --env R_LIBS_SITE=$R_LIBS_SITE \\
  --env SLURM_CPUS=$SLURM_CPUS_PER_TASK \\
  --env R_USER_CACHE_DIR=$PAK_CACHE_DIR \\
  -B $BIND_PATHS,/tmp \\
  "$SINGULARITY_IMAGE" \\
  Rscript -e "
    ncpus <- as.integer(Sys.getenv(\\"SLURM_CPUS\\", parallel::detectCores()))
    options(Ncpus = ncpus)
    lib <- Sys.getenv(\\"R_LIBS_SITE\\")
    pkgs <- readLines(\\"%s/pkgs_deps.txt\\")
    message(\\"Installing \\", length(pkgs), \\" core dependencies using \\", ncpus, \\" CPUs...\\")

    # Separate URL remotes, GitHub remotes, and regular packages
    url_pkgs <- pkgs[grepl(\\\"^url::\\\", pkgs)]
    github_pkgs <- pkgs[grepl(\\\"/\\\", pkgs) & !grepl(\\\"^url::\\\", pkgs)]
    cran_bioc_pkgs <- pkgs[!grepl(\\\"/\\\", pkgs) & !grepl(\\\"^url::\\\", pkgs)]

    # Install CRAN/Bioc packages with pak
    if (length(cran_bioc_pkgs) > 0) {
      message(\\"Installing \\", length(cran_bioc_pkgs), \\" CRAN/Bioc packages...\\")
      tryCatch(
        pak::pkg_install(cran_bioc_pkgs, lib = lib, upgrade = FALSE),
        error = function(e) {
          message(\\"Batch install failed, trying one by one...\\")
          for (pkg in cran_bioc_pkgs) {
            tryCatch(
              pak::pkg_install(pkg, lib = lib, upgrade = FALSE),
              error = function(e) message(sprintf(\\"  FAILED: %%s - %%s\\", pkg, conditionMessage(e)))
            )
          }
        }
      )
    }

    # Install URL remotes (archived CRAN) with pak
    if (length(url_pkgs) > 0) {
      message(\\"Installing \\", length(url_pkgs), \\" archived packages...\\")
      for (pkg in url_pkgs) {
        tryCatch(
          pak::pkg_install(pkg, lib = lib, upgrade = FALSE),
          error = function(e) message(sprintf(\\"  FAILED: %%s - %%s\\", pkg, conditionMessage(e)))
        )
      }
    }

    # Install GitHub remotes with remotes:: (pak has issues with subdirs)
    if (length(github_pkgs) > 0) {
      message(\\"Installing \\", length(github_pkgs), \\" GitHub packages...\\")
      for (pkg in github_pkgs) {
        tryCatch(
          remotes::install_github(pkg, lib = lib, upgrade = \\"never\\"),
          error = function(e) message(sprintf(\\"  FAILED: %%s - %%s\\", pkg, conditionMessage(e)))
        )
      }
    }

    message(\\"Phase 1 complete\\")
  "
', config$phase1_cpus, config$phase1_mem, config$phase1_time, output_dir_abs,
   config$name, config$sif, config$bind, lib, config$name, length(core_deps), output_dir_abs)

  phase1_path <- file.path(output_dir_abs, "install_phase1_deps.slurm")
  writeLines(phase1_script, phase1_path)

  # Phase 2: Install leaf packages (job array, depends on phase 1)
  phase2_script <- sprintf('#!/bin/bash
#SBATCH --job-name=rbioc_leaves
#SBATCH --array=1-%d
#SBATCH --cpus-per-task=%d
#SBATCH --mem=%s
#SBATCH --time=%s
#SBATCH --output=%s/install_leaf_%%a.log

# Phase 2: Install leaf packages (depends on phase 1)
# Cluster: %s
SINGULARITY_IMAGE="%s"
BIND_PATHS="%s"
R_LIBS_SITE="%s"

module load singularity 2>/dev/null || true

PKGFILE=%s/pkgs_leaf_$(printf "%%03d" $SLURM_ARRAY_TASK_ID).txt

if [ ! -f "$PKGFILE" ]; then
    echo "Package file not found: $PKGFILE"
    exit 1
fi

echo "=== Phase 2: Installing leaf packages (task $SLURM_ARRAY_TASK_ID) ==="
echo "Package file: $PKGFILE"
echo "Library: $R_LIBS_SITE"

# Use job-local cache to avoid NFS lock contention
export PAK_CACHE_DIR=/tmp/pak_cache_$SLURM_ARRAY_TASK_ID
mkdir -p $PAK_CACHE_DIR

singularity exec \\
  --env R_LIBS=/usr/local/lib/R/site-library \\
  --env R_LIBS_SITE=$R_LIBS_SITE \\
  --env SLURM_CPUS=$SLURM_CPUS_PER_TASK \\
  --env R_USER_CACHE_DIR=$PAK_CACHE_DIR \\
  -B $BIND_PATHS,/tmp \\
  "$SINGULARITY_IMAGE" \\
  Rscript -e "
    ncpus <- as.integer(Sys.getenv(\\"SLURM_CPUS\\", parallel::detectCores()))
    options(Ncpus = ncpus)
    lib <- Sys.getenv(\\"R_LIBS_SITE\\")
    pkgs <- readLines(\\"$PKGFILE\\")
    for (pkg in pkgs) {
      message(sprintf(\\"Installing %%s...\\", pkg))
      tryCatch({
        if (grepl(\\\"^url::\\\", pkg)) {
          # URL remote (archived CRAN)
          pak::pkg_install(pkg, lib = lib, upgrade = FALSE)
        } else if (grepl(\\\"/\\\", pkg)) {
          # GitHub remote - use remotes:: to handle subdirs properly
          remotes::install_github(pkg, lib = lib, upgrade = \\"never\\")
        } else {
          # CRAN/Bioc package
          pak::pkg_install(pkg, lib = lib, upgrade = FALSE)
        }
      }, error = function(e) message(sprintf(\\"  FAILED: %%s\\", conditionMessage(e))))
    }
  "
', jobs, config$phase2_cpus, config$phase2_mem, config$phase2_time, output_dir_abs,
   config$name, config$sif, config$bind, lib, output_dir_abs)

  phase2_path <- file.path(output_dir_abs, "install_phase2_leaves.slurm")
  writeLines(phase2_script, phase2_path)

  # Phase 3: Summary job (runs after Phase 2)
  phase3_script <- sprintf('#!/bin/bash
#SBATCH --job-name=rbioc_summary
#SBATCH --cpus-per-task=1
#SBATCH --mem=1G
#SBATCH --time=00:10:00
#SBATCH --output=%s/install_summary.log

# Phase 3: Generate installation summary
LOG_DIR="%s"

echo "=============================================="
echo "  rbiocverse Installation Summary"
echo "=============================================="
echo ""
echo "Cluster: %s"
echo "Library: %s"
echo "Generated: $(date)"
echo ""

# Count successful installs
SUCCESS=$(grep -h "✔.*pkg" "$LOG_DIR"/install_*.log 2>/dev/null | wc -l)
echo "Packages processed: $SUCCESS"
echo ""

# Check for failures
FAILURES=$(grep -h "FAILED:" "$LOG_DIR"/install_*.log 2>/dev/null)
if [[ -n "$FAILURES" ]]; then
    echo "=== FAILED PACKAGES ==="
    echo "$FAILURES" | sort -u
    echo ""
fi

# Check for missing system dependencies
MISSING_DEPS=$(grep -h -A1 "✖ Missing" "$LOG_DIR"/install_*.log 2>/dev/null | grep "^+" | sort -u)
if [[ -n "$MISSING_DEPS" ]]; then
    echo "=== MISSING SYSTEM DEPENDENCIES (optional) ==="
    echo "These are warnings only - packages installed but some features may be limited:"
    echo "$MISSING_DEPS"
    echo ""
fi

# Verify installed packages
echo "=== VERIFICATION ==="
INSTALLED=$(ls -1 "%s" 2>/dev/null | wc -l)
echo "Packages in library: $INSTALLED"
echo ""

echo "Installation complete."
', output_dir_abs, output_dir_abs, config$name, lib, lib)

  phase3_path <- file.path(output_dir_abs, "install_phase3_summary.slurm")
  writeLines(phase3_script, phase3_path)

  # Generate submission script
  submit_script <- sprintf('#!/bin/bash
# Submit three-phase installation
# Phase 1 -> Phase 2 -> Phase 3 (summary)

echo "Submitting Phase 1 (core dependencies)..."
JOB1=$(sbatch %s | awk \'{print $4}\')
echo "Phase 1 job ID: $JOB1"

echo "Submitting Phase 2 (leaf packages) with dependency on Phase 1..."
JOB2=$(sbatch --dependency=afterok:$JOB1 %s | awk \'{print $4}\')
echo "Phase 2 job ID: $JOB2"

echo "Submitting Phase 3 (summary) with dependency on Phase 2..."
JOB3=$(sbatch --dependency=afterany:$JOB2 %s | awk \'{print $4}\')
echo "Phase 3 job ID: $JOB3"

echo ""
echo "Monitor with: squeue -u $USER"
echo "Logs in: %s/"
echo "Summary will be in: %s/install_summary.log"
', phase1_path, phase2_path, phase3_path, output_dir_abs, output_dir_abs)

  submit_path <- file.path(output_dir_abs, "submit_install.sh")
  writeLines(submit_script, submit_path)
  Sys.chmod(submit_path, "755")

  message("Generated three-phase SLURM install:")
  message("  Cluster: ", config$name)
  message("  Phase 1: ", length(core_deps), " core dependencies (",
          config$phase1_cpus, " CPUs, ", config$phase1_mem, ")")
  message("  Phase 2: ", length(leaf_pkgs), " leaf packages in ", jobs, " jobs (",
          config$phase2_cpus, " CPUs each)")
  message("  Phase 3: Summary report")
  message("  Output: ", output_dir_abs, "/")
  message("")
  message("Submit with:")
  message("  ", submit_path)
  message("")
  message("Or manually:")
  message("  JOB1=$(sbatch ", phase1_path, " | awk '{print $4}')")
  message("  JOB2=$(sbatch --dependency=afterok:$JOB1 ", phase2_path, " | awk '{print $4}')")
  message("  sbatch --dependency=afterany:$JOB2 ", phase3_path)

  invisible(submit_path)
}

#' Show what would be installed (dry run)
show_packages <- function() {
  pkgs <- parse_description()
  core_deps <- get_core_deps()
  core_deps <- intersect(core_deps, c(pkgs$imports, pkgs$remotes))
  leaf_pkgs <- setdiff(c(pkgs$imports, pkgs$remotes), core_deps)

  message("=== rbiocverse ", pkgs$version, " ===")
  message("")
  message("Total packages: ", length(pkgs$imports) + length(pkgs$remotes))
  message("  Core deps (phase 1): ", length(core_deps))
  message("  Leaf packages (phase 2): ", length(leaf_pkgs))
  message("  GitHub remotes: ", length(pkgs$remotes))
  message("")
  message("Core dependencies:")
  cat(paste("  ", head(core_deps, 20), collapse = "\n"), "\n")
  if (length(core_deps) > 20) message("  ... and ", length(core_deps) - 20, " more")
}

# =============================================================================
# CLI
# =============================================================================

if (!interactive()) {
  args <- commandArgs(trailingOnly = TRUE)

  # Parse arguments
  slurm_mode <- "--slurm" %in% args
  slurm_smart_mode <- "--slurm-smart" %in% args
  dry_run <- "--dry-run" %in% args || "-n" %in% args

  # Get cluster override
  cluster <- detect_cluster()
  cluster_idx <- which(args == "--cluster")
  if (length(cluster_idx) > 0 && length(args) > cluster_idx) {
    cluster <- args[cluster_idx + 1]
  }

  # Get bioc version
  bioc_version <- "3.22"
  bioc_idx <- which(args == "--bioc-version")
  if (length(bioc_idx) > 0 && length(args) > bioc_idx) {
    bioc_version <- args[bioc_idx + 1]
  }

  # Get jobs count if specified
  jobs <- 20
  for (flag in c("--slurm", "--slurm-smart")) {
    flag_idx <- which(args == flag)
    if (length(flag_idx) > 0 && length(args) > flag_idx) {
      next_arg <- args[flag_idx + 1]
      if (!startsWith(next_arg, "-")) {
        jobs <- as.integer(next_arg)
      }
    }
  }

  if (dry_run) {
    show_packages()
  } else if (slurm_smart_mode) {
    generate_slurm_smart(jobs = jobs, cluster = cluster, bioc_version = bioc_version)
  } else if (slurm_mode) {
    generate_slurm(jobs = jobs, cluster = cluster, bioc_version = bioc_version)
  } else if (length(args) == 0 || args[1] == "install") {
    install_all()
  } else if (args[1] == "--help" || args[1] == "-h") {
    message("Usage: Rscript install.R [options]")
    message("")
    message("Options:")
    message("  (none)              Install all packages directly")
    message("  --dry-run, -n       Show packages without installing")
    message("  --slurm [N]         Generate legacy SLURM job array (N jobs, default 20)")
    message("  --slurm-smart [N]   Generate two-phase SLURM install (recommended)")
    message("  --cluster NAME      Override cluster detection (gemini|apollo)")
    message("  --bioc-version X.Y  Bioconductor version (default: 3.22)")
    message("")
    message("Environment:")
    message("  R_LIBS_SITE                Target library path (required for SLURM)")
    message("  RBIOCVERSE_DESCRIPTION     Path to DESCRIPTION")
    message("")
    message("Examples:")
    message("  # Direct install (in container)")
    message("  singularity exec --env R_LIBS_SITE=/path/to/rlibs container.sif \\")
    message("    Rscript /mnt/rbiocverse/scripts/install.R")
    message("")
    message("  # Two-phase SLURM install (recommended)")
    message("  R_LIBS_SITE=/path/to/rlibs Rscript install.R --slurm-smart 20")
    message("")
    message("  # Specify cluster and version")
    message("  R_LIBS_SITE=/path/to/rlibs Rscript install.R --slurm-smart 20 \\")
    message("    --cluster apollo --bioc-version 3.22")
  } else {
    stop("Unknown option: ", args[1], call. = FALSE)
  }
}
