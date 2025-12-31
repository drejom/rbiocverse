#!/usr/bin/env Rscript
# update-description.R
# Run BEFORE a release to update rbiocverse/DESCRIPTION
# - Checks package availability on CRAN/Bioconductor
# - Updates GitHub remote pins to latest commits/tags
# - Removes unavailable packages
# - Optionally adds packages from current environment
# - Bumps version number

suppressPackageStartupMessages({
  library(utils)
})

# =============================================================================
# Configuration
# =============================================================================

DESCRIPTION_PATH <- "rbiocverse/DESCRIPTION"

# =============================================================================
# Helper Functions
# =============================================================================

#' Read and parse DESCRIPTION file
read_description <- function(path = DESCRIPTION_PATH) {
  if (!file.exists(path)) {
    stop("DESCRIPTION not found: ", path, call. = FALSE)
  }
  read.dcf(path, all = TRUE)
}

#' Write DESCRIPTION file
write_description <- function(desc, path = DESCRIPTION_PATH) {
  write.dcf(desc, path, width = 80)
  message("Updated: ", path)
}

#' Parse Imports field into package names
parse_imports <- function(imports_str) {
  if (is.na(imports_str) || imports_str == "") return(character(0))
  # Remove comments
  imports_str <- gsub("#[^\n]*", "", imports_str)
  # Split by comma
  pkgs <- strsplit(imports_str, ",\\s*")[[1]]
  # Clean whitespace and empty strings

  pkgs <- trimws(pkgs)
  pkgs <- pkgs[pkgs != ""]
  # Remove version constraints for checking
  gsub("\\s*\\([^)]+\\)", "", pkgs)
}

#' Parse Remotes field into list of repo info
parse_remotes <- function(remotes_str) {
  if (is.na(remotes_str) || remotes_str == "") return(list())

  remotes <- strsplit(remotes_str, ",\\s*")[[1]]
  remotes <- trimws(remotes)
  remotes <- remotes[remotes != ""]

  lapply(remotes, function(r) {
    # Parse user/repo@ref format
    if (grepl("@", r)) {
      parts <- strsplit(r, "@")[[1]]
      repo <- parts[1]
      ref <- parts[2]
    } else {
      repo <- r
      ref <- NULL
    }
    list(full = r, repo = repo, ref = ref)
  })
}

#' Check if package is available on CRAN
check_cran <- function(pkg) {
  tryCatch({
    url <- sprintf("https://cran.r-project.org/package=%s", pkg)
    con <- url(url)
    on.exit(close(con))
    readLines(con, n = 1, warn = FALSE)
    TRUE
  }, error = function(e) FALSE)
}

#' Check if package is available on Bioconductor
check_bioc <- function(pkg) {
  tryCatch({
    # Check both software and annotation
    urls <- c(
      sprintf("https://bioconductor.org/packages/release/bioc/html/%s.html", pkg),
      sprintf("https://bioconductor.org/packages/release/data/annotation/html/%s.html", pkg)
    )
    for (url in urls) {
      con <- url(url)
      on.exit(close(con), add = TRUE)
      result <- tryCatch(readLines(con, n = 1, warn = FALSE), error = function(e) NULL)
      if (!is.null(result)) return(TRUE)
    }
    FALSE
  }, error = function(e) FALSE)
}

#' Check package availability (CRAN or Bioc)
check_package_available <- function(pkg) {
  # Skip base/recommended packages
  base_pkgs <- rownames(installed.packages(priority = "base"))
  if (pkg %in% base_pkgs) return(TRUE)

  # Try CRAN first, then Bioc
  check_cran(pkg) || check_bioc(pkg)
}

#' Get latest GitHub release tag or commit
get_github_latest <- function(repo) {
  tryCatch({
    # Try releases first
    releases_url <- sprintf("https://api.github.com/repos/%s/releases/latest", repo)
    releases <- jsonlite::fromJSON(releases_url)
    if (!is.null(releases$tag_name)) {
      return(list(ref = releases$tag_name, type = "tag"))
    }
  }, error = function(e) NULL)

  tryCatch({
    # Fall back to HEAD commit
    commits_url <- sprintf("https://api.github.com/repos/%s/commits/HEAD", repo)
    commit <- jsonlite::fromJSON(commits_url)
    return(list(ref = substr(commit$sha, 1, 7), type = "commit"))
  }, error = function(e) {
    warning("Could not fetch latest for: ", repo)
    return(NULL)
  })
}

#' Bump version (increment patch by default)
bump_version <- function(version_str, type = c("patch", "minor", "major", "bioc")) {
  type <- match.arg(type)
  parts <- as.integer(strsplit(version_str, "\\.")[[1]])

  if (type == "bioc") {
    # For Bioc updates: e.g., 3.22.0 -> 3.23.0
    parts[2] <- parts[2] + 1
    parts[3] <- 0
  } else if (type == "major") {
    parts[1] <- parts[1] + 1
    parts[2] <- 0
    parts[3] <- 0
  } else if (type == "minor") {
    parts[2] <- parts[2] + 1
    parts[3] <- 0
  } else {
    parts[3] <- parts[3] + 1
  }

  paste(parts, collapse = ".")
}

# =============================================================================
# Main Functions
# =============================================================================

#' Check all packages in DESCRIPTION for availability
#' @param fix If TRUE, remove unavailable packages
#' @export
check_packages <- function(fix = FALSE, path = DESCRIPTION_PATH) {
  desc <- read_description(path)
  imports <- parse_imports(desc$Imports)

  message("Checking ", length(imports), " packages...")

  unavailable <- character(0)

  for (pkg in imports) {
    if (!check_package_available(pkg)) {
      message("  UNAVAILABLE: ", pkg)
      unavailable <- c(unavailable, pkg)
    }
  }

  if (length(unavailable) == 0) {
    message("All packages available!")
  } else {
    message("\n", length(unavailable), " unavailable packages")
    if (fix) {
      message("Removing unavailable packages from DESCRIPTION...")
      available_imports <- setdiff(imports, unavailable)
      imports_str <- paste("    ", sort(available_imports), collapse = ",\n")
      desc$Imports <- paste0("\n", imports_str)
      write_description(desc, path)
      message("Removed ", length(unavailable), " packages, ", length(available_imports), " remaining")
    }
  }

  invisible(unavailable)
}

#' Update GitHub remote pins to latest
#' @param dry_run If TRUE, just show what would change
#' @export
update_remotes <- function(dry_run = TRUE, path = DESCRIPTION_PATH) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("jsonlite required: install.packages('jsonlite')", call. = FALSE)
  }

  desc <- read_description(path)
  remotes <- parse_remotes(desc$Remotes)

  if (length(remotes) == 0) {
    message("No Remotes to update")
    return(invisible(NULL))
  }

  message("Checking ", length(remotes), " GitHub remotes...")

  updated <- character(0)

  for (r in remotes) {
    latest <- get_github_latest(r$repo)
    if (is.null(latest)) next

    new_ref <- sprintf("%s@%s", r$repo, latest$ref)

    if (is.null(r$ref) || r$ref != latest$ref) {
      message(sprintf("  %s -> %s (%s)", r$full, new_ref, latest$type))
      updated <- c(updated, new_ref)
    } else {
      message(sprintf("  %s (current)", r$full))
      updated <- c(updated, r$full)
    }
  }

  if (!dry_run && length(updated) > 0) {
    desc$Remotes <- paste(updated, collapse = ",\n    ")
    write_description(desc, path)
  }

  invisible(updated)
}

#' Add packages from current environment that aren't in DESCRIPTION
#' @param exclude Packages to exclude from consideration
#' @export
suggest_packages <- function(path = DESCRIPTION_PATH,
                              exclude = c("rbiocverse", "base", "stats", "utils")) {
  desc <- read_description(path)
  current_imports <- parse_imports(desc$Imports)
  current_remotes <- parse_remotes(desc$Remotes)
  remote_pkgs <- sapply(current_remotes, function(r) basename(r$repo))

  all_current <- c(current_imports, remote_pkgs)

  # Get installed packages (non-base)
  installed <- installed.packages()[, "Package"]
  base_pkgs <- rownames(installed.packages(priority = c("base", "recommended")))
  installed <- setdiff(installed, base_pkgs)
  installed <- setdiff(installed, exclude)

  # Find packages not in DESCRIPTION
  missing <- setdiff(installed, all_current)

  if (length(missing) > 0) {
    message("Packages installed but not in DESCRIPTION:")
    message(paste("  ", missing, collapse = "\n"))
  } else {
    message("All installed packages are in DESCRIPTION")
  }

  invisible(missing)
}

#' Sync DESCRIPTION with current environment
#' Adds all installed packages to DESCRIPTION, removes unavailable ones
#' @param dry_run If TRUE, just show what would change
#' @param exclude Packages to exclude
#' @export
sync_from_environment <- function(dry_run = TRUE, path = DESCRIPTION_PATH,
                                   exclude = c("rbiocverse")) {
  desc <- read_description(path)
  current_imports <- parse_imports(desc$Imports)
  current_remotes <- parse_remotes(desc$Remotes)
  remote_pkgs <- sapply(current_remotes, function(r) basename(r$repo))

  # Get installed packages (non-base)
  ip <- installed.packages()
  installed <- data.frame(
    Package = ip[, "Package"],
    Repository = if ("Repository" %in% colnames(ip)) ip[, "Repository"] else NA_character_,
    stringsAsFactors = FALSE
  )
  base_pkgs <- rownames(installed.packages(priority = c("base", "recommended")))
  installed <- installed[!installed$Package %in% base_pkgs, ]
  installed <- installed[!installed$Package %in% exclude, ]
  installed <- installed[!installed$Package %in% remote_pkgs, ]  # Keep remotes separate

  # Classify by source
  installed$Source <- ifelse(
    grepl("bioconductor", installed$Repository, ignore.case = TRUE), "Bioconductor",
    ifelse(is.na(installed$Repository) | installed$Repository == "", "Unknown", "CRAN")
  )

  # Include CRAN, Bioconductor, and Unknown (likely CRAN/Bioc installed without repo info)
  cran_bioc <- installed[installed$Source %in% c("CRAN", "Bioconductor", "Unknown"), "Package"]

  # Find what's new vs current
  new_pkgs <- setdiff(cran_bioc, current_imports)
  removed_pkgs <- setdiff(current_imports, cran_bioc)

  message("=== Sync from Environment ===")
  message("Current DESCRIPTION imports: ", length(current_imports))
  message("Installed (CRAN/Bioc): ", length(cran_bioc))
  message("GitHub remotes (unchanged): ", length(remote_pkgs))
  message("")
  message("To add: ", length(new_pkgs))
  message("To remove: ", length(removed_pkgs))

  if (length(new_pkgs) > 0) {
    message("\nNew packages to add:")
    message(paste("  ", head(new_pkgs, 20), collapse = "\n"))
    if (length(new_pkgs) > 20) message("  ... and ", length(new_pkgs) - 20, " more")
  }

  if (length(removed_pkgs) > 0) {
    message("\nPackages to remove (not installed):")
    message(paste("  ", removed_pkgs, collapse = "\n"))
  }

  if (!dry_run) {
    # Sort packages alphabetically
    all_imports <- sort(cran_bioc)

    # Format as DESCRIPTION Imports field
    imports_str <- paste("    ", all_imports, collapse = ",\n")

    desc$Imports <- paste0("\n", imports_str)
    write_description(desc, path)
    message("\nDESCRIPTION updated with ", length(all_imports), " packages")
  } else {
    message("\n[DRY RUN] Re-run with --apply to update DESCRIPTION")
  }

  invisible(list(added = new_pkgs, removed = removed_pkgs, total = length(cran_bioc)))
}

#' Bump version in DESCRIPTION
#' @param type One of "patch", "minor", "major", "bioc"
#' @export
bump <- function(type = "patch", path = DESCRIPTION_PATH) {
  desc <- read_description(path)
  old_version <- desc$Version
  new_version <- bump_version(old_version, type)

  desc$Version <- new_version
  write_description(desc, path)

  message(sprintf("Version: %s -> %s", old_version, new_version))
  invisible(new_version)
}

#' Full update: check packages, update remotes, bump version
#' @export
full_update <- function(bump_type = "patch", dry_run = TRUE, path = DESCRIPTION_PATH) {
  message("=== Checking package availability ===")
  unavailable <- check_packages(fix = !dry_run, path = path)

  message("\n=== Updating GitHub remotes ===")
  update_remotes(dry_run = dry_run, path = path)

  if (!dry_run) {
    message("\n=== Bumping version ===")
    bump(bump_type, path = path)
  }

  if (dry_run) {
    message("\n[DRY RUN] Re-run with dry_run=FALSE to apply changes")
  }
}

# =============================================================================
# CLI
# =============================================================================

if (!interactive()) {
  args <- commandArgs(trailingOnly = TRUE)

  if (length(args) == 0) {
    message("Usage: Rscript update-description.R <command> [options]")
    message("")
    message("Commands:")
    message("  sync [--apply]     Sync DESCRIPTION with installed packages (MIGRATION)")
    message("  check [--apply]    Check package availability, remove unavailable")
    message("  remotes [--apply]  Update GitHub remote pins (dry-run by default)")
    message("  suggest            Show installed packages not in DESCRIPTION")
    message("  bump [type]        Bump version (patch|minor|major|bioc)")
    message("  update [--apply]   Full update (check + remotes + bump)")
    message("")
    message("Migration workflow (3.19 -> 3.22):")
    message("  1. Run from CURRENT environment (3.19):")
    message("     Rscript update-description.R sync --apply")
    message("  2. Check availability for NEW Bioconductor:")
    message("     Rscript update-description.R check --apply")
    message("  3. Update remotes and bump version:")
    message("     Rscript update-description.R update --apply")
    message("")
    message("Examples:")
    message("  Rscript update-description.R sync          # Preview sync")
    message("  Rscript update-description.R sync --apply  # Apply sync")
    message("  Rscript update-description.R check --apply # Remove unavailable")
    message("  Rscript update-description.R bump bioc     # 3.22.0 -> 3.23.0")
    quit(status = 0)
  }

  cmd <- args[1]
  apply_flag <- "--apply" %in% args

  if (cmd == "sync") {
    sync_from_environment(dry_run = !apply_flag)
  } else if (cmd == "check") {
    check_packages(fix = apply_flag)
  } else if (cmd == "remotes") {
    update_remotes(dry_run = !apply_flag)
  } else if (cmd == "suggest") {
    suggest_packages()
  } else if (cmd == "bump") {
    bump_type <- if (length(args) > 1 && !startsWith(args[2], "-")) args[2] else "patch"
    bump(bump_type)
  } else if (cmd == "update") {
    bump_type <- if (length(args) > 1 && !startsWith(args[2], "-")) args[2] else "patch"
    full_update(bump_type = bump_type, dry_run = !apply_flag)
  } else {
    stop("Unknown command: ", cmd, call. = FALSE)
  }
}
