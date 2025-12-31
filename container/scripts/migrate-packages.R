#!/usr/bin/env Rscript
# migrate-packages.R
# Tools for migrating R packages between Bioconductor versions
# Leverages HPC parallelization for fast installation

# =============================================================================
# Configuration (override via environment variables)
# =============================================================================

# Default paths - override with environment variables for your HPC
DEFAULT_SINGULARITY_IMAGE <- Sys.getenv(

  "RBIOC_SINGULARITY_IMAGE",
  "/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif"
)
DEFAULT_BIND_PATHS <- Sys.getenv(

"RBIOC_BIND_PATHS",
  "/packages,/scratch"
)

# =============================================================================
# Helper: Validate library path
# =============================================================================

validate_lib <- function(lib) {
  if (is.null(lib) || lib == "") {
    stop(
      "R_LIBS_SITE is not set. Please set the environment variable or pass 'lib' explicitly.\n",
      "Example: R_LIBS_SITE=/path/to/rlibs Rscript migrate-packages.R ...",
      call. = FALSE
    )
  }
  if (!dir.exists(lib)) {
    stop(sprintf("Library path does not exist: %s", lib), call. = FALSE)
  }
  invisible(lib)
}

# =============================================================================
# Export current environment
# =============================================================================

#' Export installed packages to a file
#' @param file Output file path (.rds or .csv)
#' @param lib Library path to export (default: all libraries)
#' @export
migrate_export <- function(file = "packages.rds", lib = NULL) {
  pkgs <- installed.packages(lib.loc = lib)[, c("Package", "Version", "Repository", "LibPath")]
  pkgs <- as.data.frame(pkgs, stringsAsFactors = FALSE)

  # Classify source
  pkgs$Source <- ifelse(
    grepl("bioconductor", pkgs$Repository, ignore.case = TRUE), "Bioconductor",
    ifelse(is.na(pkgs$Repository) | pkgs$Repository == "", "GitHub/Local", "CRAN")
  )

  if (grepl("\\.csv$", file)) {
    write.csv(pkgs, file, row.names = FALSE)
  } else {
    saveRDS(pkgs, file)
  }

  message(sprintf("Exported %d packages to %s", nrow(pkgs), file))
  message(sprintf("  CRAN: %d, Bioconductor: %d, GitHub/Local: %d",
                  sum(pkgs$Source == "CRAN"),
                  sum(pkgs$Source == "Bioconductor"),
                  sum(pkgs$Source == "GitHub/Local")))
  invisible(pkgs)
}

# =============================================================================
# Install packages using pak (fast, parallel)
# =============================================================================

#' Install packages from export file using pak
#' @param file Package list file (.rds or .csv)
#' @param lib Target library path
#' @param ncpus Number of CPUs for parallel installation
#' @export
migrate_install_pak <- function(file = "packages.rds", lib = NULL, ncpus = parallel::detectCores()) {
  if (!requireNamespace("pak", quietly = TRUE)) {
    install.packages("pak")
  }

  # Validate lib if provided
if (!is.null(lib) && lib != "") {
    validate_lib(lib)
  }

  pkgs <- if (grepl("\\.csv$", file)) read.csv(file) else readRDS(file)
  pkg_names <- pkgs$Package

  message(sprintf("Installing %d packages using pak with %d cores...", length(pkg_names), ncpus))

  # pak handles CRAN, Bioconductor, and GitHub automatically
  options(Ncpus = ncpus)
  pak::pkg_install(pkg_names, lib = lib, upgrade = FALSE)
}

# =============================================================================
# HPC Parallel Installation (for large package sets)
# =============================================================================

#' Generate SLURM job array script for parallel package installation
#' @param file Package list file
#' @param lib Target library path (required)
#' @param jobs Number of parallel jobs
#' @param output_dir Directory for job scripts
#' @param singularity_image Path to Singularity image (default from env)
#' @param bind_paths Singularity bind paths (default from env)
#' @export
migrate_generate_slurm <- function(file = "packages.rds",
                                    lib = Sys.getenv("R_LIBS_SITE"),
                                    jobs = 20,
                                    output_dir = "slurm_install",
                                    singularity_image = DEFAULT_SINGULARITY_IMAGE,
                                    bind_paths = DEFAULT_BIND_PATHS) {

  # Validate required parameters
  validate_lib(lib)

  if (!file.exists(singularity_image)) {
    warning(sprintf(
      "Singularity image not found: %s\n  Update RBIOC_SINGULARITY_IMAGE or edit the generated script.",
      singularity_image
    ))
  }

  pkgs <- if (grepl("\\.csv$", file)) read.csv(file) else readRDS(file)
  pkg_names <- pkgs$Package

  # Split packages into chunks
  chunks <- split(pkg_names, cut(seq_along(pkg_names), jobs, labels = FALSE))

  dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

  # Write package lists
  for (i in seq_along(chunks)) {
    writeLines(chunks[[i]], file.path(output_dir, sprintf("pkgs_%03d.txt", i)))
  }

  # Generate SLURM array script
  slurm_script <- sprintf('#!/bin/bash
#SBATCH --job-name=pkg_install
#SBATCH --array=1-%d
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=4:00:00
#SBATCH --output=%s/install_%%a.log

# Configuration - edit these paths for your HPC environment
SINGULARITY_IMAGE="%s"
BIND_PATHS="%s"
R_LIBS_SITE="%s"

# Load singularity module (adjust for your HPC)
module load singularity 2>/dev/null || true

PKGFILE=%s/pkgs_$(printf "%%03d" $SLURM_ARRAY_TASK_ID).txt

if [ ! -f "$PKGFILE" ]; then
    echo "Package file not found: $PKGFILE"
    exit 1
fi

singularity exec \\
  --env R_LIBS_SITE=$R_LIBS_SITE \\
  -B $BIND_PATHS \\
  "$SINGULARITY_IMAGE" \\
  Rscript -e "
    pkgs <- readLines(\\"$PKGFILE\\")
    for (pkg in pkgs) {
      message(sprintf(\\"Installing %%s...\\", pkg))
      tryCatch(
        pak::pkg_install(pkg, lib = Sys.getenv(\\"R_LIBS_SITE\\"), upgrade = FALSE),
        error = function(e) message(sprintf(\\"  FAILED: %%s\\", conditionMessage(e)))
      )
    }
  "
', jobs, output_dir, singularity_image, bind_paths, lib, output_dir)

  script_path <- file.path(output_dir, "install_packages.slurm")
  writeLines(slurm_script, script_path)

  message(sprintf("Generated SLURM job array in %s/", output_dir))
  message(sprintf("  %d jobs, each installing ~%d packages", jobs, ceiling(length(pkg_names)/jobs)))
  message(sprintf("  Singularity image: %s", singularity_image))
  message(sprintf("  Target library: %s", lib))
  message(sprintf("\nReview and edit paths in the script if needed, then submit with:"))
  message(sprintf("  sbatch %s", script_path))

  invisible(script_path)
}

# =============================================================================
# Install from metapackage DESCRIPTION
# =============================================================================

#' Install all packages listed in rbiocverse DESCRIPTION
#' @param path Path to rbiocverse package
#' @param lib Target library path
#' @param ncpus Number of CPUs
#' @export
install_rbiocverse <- function(path = "/opt/rbiocverse",
                                lib = Sys.getenv("R_LIBS_SITE"),
                                ncpus = parallel::detectCores()) {
  if (!requireNamespace("pak", quietly = TRUE)) {
    install.packages("pak")
  }

  # Validate lib if provided and not empty
  if (!is.null(lib) && lib != "") {
    validate_lib(lib)
  }

  desc_file <- file.path(path, "DESCRIPTION")
  if (!file.exists(desc_file)) {
    stop(sprintf("DESCRIPTION not found at: %s", desc_file), call. = FALSE)
  }

  desc <- read.dcf(desc_file)

  # Parse Imports
  imports <- desc[, "Imports"]
  imports <- gsub("#.*", "", imports)  # Remove comments
  imports <- strsplit(imports, ",\\s*")[[1]]
  imports <- trimws(imports)
  imports <- imports[imports != ""]

  # Parse Remotes (GitHub packages)
  remotes <- if ("Remotes" %in% colnames(desc)) {
    strsplit(desc[, "Remotes"], ",\\s*")[[1]]
  } else {
    character(0)
  }
  remotes <- trimws(remotes)

  message(sprintf("Installing %d packages from rbiocverse...", length(imports)))
  message(sprintf("  Including %d GitHub packages", length(remotes)))

  options(Ncpus = ncpus)

  # Install CRAN/Bioc packages first
  pak::pkg_install(imports, lib = lib, upgrade = FALSE)

  # Install GitHub packages
  if (length(remotes) > 0) {
    pak::pkg_install(remotes, lib = lib, upgrade = FALSE)
  }
}

# =============================================================================
# Compare environments
# =============================================================================

#' Compare two package environments
#' @param old_file Old environment export
#' @param new_lib New library path to compare
#' @export
migrate_compare <- function(old_file, new_lib = .libPaths()[1]) {
  old <- if (grepl("\\.csv$", old_file)) read.csv(old_file) else readRDS(old_file)
  new <- installed.packages(lib.loc = new_lib)[, c("Package", "Version")]
  new <- as.data.frame(new, stringsAsFactors = FALSE)

  missing <- setdiff(old$Package, new$Package)
  added <- setdiff(new$Package, old$Package)

  # Version changes
  common <- intersect(old$Package, new$Package)
  old_common <- old[old$Package %in% common, ]
  new_common <- new[new$Package %in% common, ]
  merged <- merge(old_common, new_common, by = "Package", suffixes = c(".old", ".new"))
  upgraded <- merged[merged$Version.old != merged$Version.new, ]

  list(
    missing = missing,
    added = added,
    upgraded = upgraded
  )
}

# =============================================================================
# CLI
# =============================================================================

if (!interactive()) {
  args <- commandArgs(trailingOnly = TRUE)

  if (length(args) == 0) {
    message("Usage: Rscript migrate-packages.R <command> [options]")
    message("")
    message("Commands:")
    message("  export [file]           Export installed packages")
    message("  install [file]          Install packages from export")
    message("  slurm [file] [jobs]     Generate SLURM job array")
    message("  rbiocverse [path]       Install from rbiocverse metapackage")
    message("  compare [old] [new]     Compare environments")
    message("")
    message("Environment variables:")
    message("  R_LIBS_SITE              Target library path (required for slurm)")
    message("  RBIOC_SINGULARITY_IMAGE  Singularity image path")
    message("  RBIOC_BIND_PATHS         Singularity bind paths")
    quit(status = 0)
  }

  cmd <- args[1]

  if (cmd == "export") {
    file <- if (length(args) > 1) args[2] else "packages.rds"
    migrate_export(file)
  } else if (cmd == "install") {
    file <- if (length(args) > 1) args[2] else "packages.rds"
    migrate_install_pak(file)
  } else if (cmd == "slurm") {
    file <- if (length(args) > 1) args[2] else "packages.rds"
    jobs <- 20
    if (length(args) > 2) {
      jobs <- as.integer(args[3])
    }
    migrate_generate_slurm(file, jobs = jobs)
  } else if (cmd == "rbiocverse") {
    path <- if (length(args) > 1) args[2] else "/opt/rbiocverse"
    install_rbiocverse(path)
  } else if (cmd == "compare") {
    if (length(args) < 2) stop("Need old file")
    result <- migrate_compare(args[2])
    message(sprintf("Missing: %d packages", length(result$missing)))
    message(sprintf("Added: %d packages", length(result$added)))
    message(sprintf("Upgraded: %d packages", nrow(result$upgraded)))
  } else {
    stop(sprintf("Unknown command: %s", cmd), call. = FALSE)
  }
}
