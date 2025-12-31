#!/usr/bin/env Rscript
# install.R
# Install all packages from rbiocverse/DESCRIPTION
# Run this FROM the new container to populate R_LIBS_SITE
#
# Usage:
#   singularity exec --env R_LIBS_SITE=/path/to/rlibs container.sif \
#     Rscript /opt/rbiocverse/scripts/install.R
#
# Or for HPC parallel install:
#   Rscript /opt/rbiocverse/scripts/install.R --slurm 20

# =============================================================================
# Configuration
# =============================================================================

# Path to DESCRIPTION (in container at /opt/rbiocverse)
DESCRIPTION_PATH <- Sys.getenv(
"RBIOCVERSE_DESCRIPTION",
  "/opt/rbiocverse/DESCRIPTION"
)

# SLURM configuration (for --slurm mode)
DEFAULT_SINGULARITY_IMAGE <- Sys.getenv(
  "RBIOC_SINGULARITY_IMAGE",
  "/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif"
)
DEFAULT_BIND_PATHS <- Sys.getenv(
  "RBIOC_BIND_PATHS",
  "/packages,/scratch"
)

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

 # Parse Remotes
  remotes <- character(0)
  if (!is.null(desc$Remotes) && !is.na(desc$Remotes)) {
    remotes <- strsplit(desc$Remotes, ",\\s*")[[1]]
    remotes <- trimws(remotes)
    remotes <- remotes[remotes != ""]
  }

  list(
    version = desc$Version,
    imports = imports,
    remotes = remotes
  )
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

  # Install GitHub packages
  if (length(pkgs$remotes) > 0) {
    message("\n=== Installing GitHub packages ===")
    for (remote in pkgs$remotes) {
      message("Installing: ", remote)
      tryCatch(
        pak::pkg_install(remote, lib = lib, upgrade = FALSE),
        error = function(e) message("  FAILED: ", conditionMessage(e))
      )
    }
  }

  message("\n=== Installation complete ===")
  message("Library: ", lib)
}

#' Generate SLURM job array for parallel HPC install
generate_slurm <- function(jobs = 20, output_dir = "slurm_install") {
  lib <- Sys.getenv("R_LIBS_SITE")
  if (lib == "") {
    stop("R_LIBS_SITE must be set for SLURM generation", call. = FALSE)
  }

  pkgs <- parse_description()
  all_pkgs <- c(pkgs$imports, pkgs$remotes)

  # Split into chunks
  chunks <- split(all_pkgs, cut(seq_along(all_pkgs), jobs, labels = FALSE))

  dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

  # Write package lists
  for (i in seq_along(chunks)) {
    writeLines(chunks[[i]], file.path(output_dir, sprintf("pkgs_%03d.txt", i)))
  }

  # Generate SLURM script
  slurm_script <- sprintf('#!/bin/bash
#SBATCH --job-name=rbiocverse_install
#SBATCH --array=1-%d
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=4:00:00
#SBATCH --output=%s/install_%%a.log

# Configuration - edit for your HPC
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
  --env R_LIBS_SITE=$R_LIBS_SITE \\
  -B $BIND_PATHS \\
  "$SINGULARITY_IMAGE" \\
  Rscript -e "
    pkgs <- readLines(\\"$PKGFILE\\")
    lib <- Sys.getenv(\\"R_LIBS_SITE\\")
    for (pkg in pkgs) {
      message(sprintf(\\"Installing %%s...\\", pkg))
      tryCatch(
        pak::pkg_install(pkg, lib = lib, upgrade = FALSE),
        error = function(e) message(sprintf(\\"  FAILED: %%s\\", conditionMessage(e)))
      )
    }
  "
', jobs, output_dir, DEFAULT_SINGULARITY_IMAGE, DEFAULT_BIND_PATHS, lib, output_dir)

  script_path <- file.path(output_dir, "install.slurm")
  writeLines(slurm_script, script_path)

  message("Generated SLURM job array:")
  message("  Jobs: ", jobs)
  message("  Packages per job: ~", ceiling(length(all_pkgs) / jobs))
  message("  Output: ", output_dir, "/")
  message("")
  message("Submit with:")
  message("  sbatch ", script_path)

  invisible(script_path)
}

#' Show what would be installed (dry run)
show_packages <- function() {
  pkgs <- parse_description()

  message("=== rbiocverse ", pkgs$version, " ===")
  message("")
  message("Imports (", length(pkgs$imports), "):")
  cat(paste("  ", pkgs$imports, collapse = "\n"), "\n")
  message("")
  message("Remotes (", length(pkgs$remotes), "):")
  cat(paste("  ", pkgs$remotes, collapse = "\n"), "\n")
}

# =============================================================================
# CLI
# =============================================================================

if (!interactive()) {
  args <- commandArgs(trailingOnly = TRUE)

  # Parse arguments
  slurm_mode <- "--slurm" %in% args
  dry_run <- "--dry-run" %in% args || "-n" %in% args

  # Get jobs count if specified
  jobs <- 20
  slurm_idx <- which(args == "--slurm")
  if (length(slurm_idx) > 0 && length(args) > slurm_idx) {
    next_arg <- args[slurm_idx + 1]
    if (!startsWith(next_arg, "-")) {
      jobs <- as.integer(next_arg)
    }
  }

  if (dry_run) {
    show_packages()
  } else if (slurm_mode) {
    generate_slurm(jobs = jobs)
  } else if (length(args) == 0 || args[1] == "install") {
    install_all()
  } else if (args[1] == "--help" || args[1] == "-h") {
    message("Usage: Rscript install.R [options]")
    message("")
    message("Options:")
    message("  (none)           Install all packages directly")
    message("  --dry-run, -n    Show packages without installing")
    message("  --slurm [jobs]   Generate SLURM job array (default: 20 jobs)")
    message("")
    message("Environment:")
    message("  R_LIBS_SITE      Target library path (required)")
    message("  RBIOCVERSE_DESCRIPTION  Path to DESCRIPTION (default: /opt/rbiocverse/DESCRIPTION)")
    message("")
    message("Examples:")
    message("  # Direct install")
    message("  singularity exec --env R_LIBS_SITE=/path/to/rlibs container.sif \\")
    message("    Rscript /opt/rbiocverse/scripts/install.R")
    message("")
    message("  # Generate SLURM jobs")
    message("  R_LIBS_SITE=/path/to/rlibs Rscript install.R --slurm 20")
  } else {
    stop("Unknown option: ", args[1], call. = FALSE)
  }
}
