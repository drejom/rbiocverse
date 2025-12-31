#!/usr/bin/env Rscript
# migrate-packages.R
# Utility for auditing installed packages
# - Export current environment for comparison
# - Find packages not in rbiocverse DESCRIPTION
# - Compare two environments
#
# NOTE: For installing packages, use install.R instead.
# This script is for auditing/comparison only.

# =============================================================================
# Export Functions
# =============================================================================

#' Export installed packages to a file
#' @param file Output file path (.rds or .csv)
#' @param lib Library path to export (default: all libraries)
#' @export
export_packages <- function(file = "packages.rds", lib = NULL) {
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
# Comparison Functions
# =============================================================================

#' Compare installed packages against rbiocverse DESCRIPTION
#' @param description_path Path to rbiocverse DESCRIPTION
#' @export
compare_to_rbiocverse <- function(description_path = "rbiocverse/DESCRIPTION") {
  if (!file.exists(description_path)) {
    stop("DESCRIPTION not found: ", description_path, call. = FALSE)
  }

  # Parse DESCRIPTION
  desc <- read.dcf(description_path, all = TRUE)

  imports_str <- gsub("#[^\n]*", "", desc$Imports)
  imports <- strsplit(imports_str, ",\\s*")[[1]]
  imports <- trimws(imports)
  imports <- imports[imports != ""]
  imports <- gsub("\\s*\\([^)]+\\)", "", imports)

  remotes <- character(0)
  if (!is.null(desc$Remotes) && !is.na(desc$Remotes)) {
    remotes <- strsplit(desc$Remotes, ",\\s*")[[1]]
    remotes <- trimws(remotes)
    # Extract package name from user/repo@ref
    remotes <- sapply(remotes, function(r) {
      r <- gsub("@.*", "", r)  # Remove @ref
      basename(r)              # Get repo name
    })
  }

  rbiocverse_pkgs <- c(imports, remotes)

  # Get installed packages
  installed <- installed.packages()[, "Package"]
  base_pkgs <- rownames(installed.packages(priority = c("base", "recommended")))
  installed <- setdiff(installed, base_pkgs)

  # Compare
  in_rbiocverse <- intersect(installed, rbiocverse_pkgs)
  extra <- setdiff(installed, rbiocverse_pkgs)
  missing <- setdiff(rbiocverse_pkgs, installed)

  message("=== Comparison with rbiocverse ===")
  message("rbiocverse packages: ", length(rbiocverse_pkgs))
  message("Installed (non-base): ", length(installed))
  message("")
  message("In both: ", length(in_rbiocverse))
  message("Extra (installed but not in rbiocverse): ", length(extra))
  message("Missing (in rbiocverse but not installed): ", length(missing))

  if (length(extra) > 0) {
    message("\nExtra packages (consider adding to DESCRIPTION):")
    message(paste("  ", head(extra, 20), collapse = "\n"))
    if (length(extra) > 20) message("  ... and ", length(extra) - 20, " more")
  }

  if (length(missing) > 0) {
    message("\nMissing packages:")
    message(paste("  ", missing, collapse = "\n"))
  }

  invisible(list(
    in_both = in_rbiocverse,
    extra = extra,
    missing = missing
  ))
}

#' Compare two exported package lists
#' @param old_file Old environment export
#' @param new_file New environment export (or NULL to compare with current)
#' @export
compare_exports <- function(old_file, new_file = NULL) {
  old <- if (grepl("\\.csv$", old_file)) read.csv(old_file) else readRDS(old_file)

  if (is.null(new_file)) {
    new <- installed.packages()[, c("Package", "Version")]
    new <- as.data.frame(new, stringsAsFactors = FALSE)
  } else {
    new <- if (grepl("\\.csv$", new_file)) read.csv(new_file) else readRDS(new_file)
  }

  removed <- setdiff(old$Package, new$Package)
  added <- setdiff(new$Package, old$Package)

  # Version changes
  common <- intersect(old$Package, new$Package)
  old_common <- old[old$Package %in% common, c("Package", "Version")]
  new_common <- new[new$Package %in% common, c("Package", "Version")]
  merged <- merge(old_common, new_common, by = "Package", suffixes = c(".old", ".new"))
  changed <- merged[merged$Version.old != merged$Version.new, ]

  message("=== Environment Comparison ===")
  message("Old: ", nrow(old), " packages")
  message("New: ", nrow(new), " packages")
  message("")
  message("Removed: ", length(removed))
  message("Added: ", length(added))
  message("Version changed: ", nrow(changed))

  if (length(removed) > 0) {
    message("\nRemoved:")
    message(paste("  ", head(removed, 10), collapse = "\n"))
  }

  if (length(added) > 0) {
    message("\nAdded:")
    message(paste("  ", head(added, 10), collapse = "\n"))
  }

  invisible(list(
    removed = removed,
    added = added,
    changed = changed
  ))
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
    message("  export [file]              Export installed packages (default: packages.rds)")
    message("  compare-rbiocverse [path]  Compare installed vs rbiocverse DESCRIPTION")
    message("  compare <old> [new]        Compare two exports (or old vs current)")
    message("")
    message("NOTE: For installing packages, use install.R instead.")
    message("")
    message("Examples:")
    message("  Rscript migrate-packages.R export packages-3.19.rds")
    message("  Rscript migrate-packages.R compare-rbiocverse")
    message("  Rscript migrate-packages.R compare packages-3.19.rds packages-3.22.rds")
    quit(status = 0)
  }

  cmd <- args[1]

  if (cmd == "export") {
    file <- if (length(args) > 1) args[2] else "packages.rds"
    export_packages(file)
  } else if (cmd == "compare-rbiocverse") {
    path <- if (length(args) > 1) args[2] else "rbiocverse/DESCRIPTION"
    compare_to_rbiocverse(path)
  } else if (cmd == "compare") {
    if (length(args) < 2) stop("Need at least one file to compare", call. = FALSE)
    old_file <- args[2]
    new_file <- if (length(args) > 2) args[3] else NULL
    compare_exports(old_file, new_file)
  } else {
    stop("Unknown command: ", cmd, call. = FALSE)
  }
}
