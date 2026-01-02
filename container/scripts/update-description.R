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
    on.exit(try(close(con), silent = TRUE))
    readLines(con, n = 1, warn = FALSE)
    TRUE
  }, error = function(e) FALSE, warning = function(w) FALSE)
}

#' Check if package is available on Bioconductor
check_bioc <- function(pkg) {
  # Check both software, data/annotation, and data/experiment repos
  urls <- c(
    sprintf("https://bioconductor.org/packages/release/bioc/html/%s.html", pkg),
    sprintf("https://bioconductor.org/packages/release/data/annotation/html/%s.html", pkg),
    sprintf("https://bioconductor.org/packages/release/data/experiment/html/%s.html", pkg)
  )
  for (url in urls) {
    result <- tryCatch({
      con <- url(url)
      on.exit(try(close(con), silent = TRUE))
      readLines(con, n = 1, warn = FALSE)
      TRUE
    }, error = function(e) FALSE, warning = function(w) FALSE)
    if (isTRUE(result)) return(TRUE)
  }
  FALSE
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

#' Get tag for a GitHub commit (if one exists)
#' @param user GitHub username
#' @param repo GitHub repo name
#' @param sha Commit SHA
#' @return Tag name if found, NULL otherwise
get_tag_for_commit <- function(user, repo, sha) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) return(NULL)

  tryCatch({
    # Get tags and find one pointing to this SHA
    tags_url <- sprintf("https://api.github.com/repos/%s/%s/tags", user, repo)
    tags <- jsonlite::fromJSON(tags_url, simplifyVector = FALSE)

    for (tag in tags) {
      if (substr(tag$commit$sha, 1, 7) == substr(sha, 1, 7)) {
        return(tag$name)
      }
    }
    NULL
  }, error = function(e) NULL)
}

#' Get GitHub remote info from an installed package's DESCRIPTION
#' @param pkg Package name
#' @param lib Library path (defaults to .libPaths()[1])
#' @param use_tags If TRUE, look up tags for commits (requires network)
#' @return List with repo, ref, subdir info or NULL if not a GitHub package
get_installed_github_info <- function(pkg, lib = .libPaths()[1], use_tags = TRUE) {
  desc_path <- file.path(lib, pkg, "DESCRIPTION")
  if (!file.exists(desc_path)) return(NULL)

  desc <- tryCatch(read.dcf(desc_path, all = TRUE), error = function(e) NULL)
  if (is.null(desc)) return(NULL)

  # Check if it's a GitHub package
  remote_type <- desc$RemoteType
  if (is.null(remote_type) || !grepl("github", remote_type, ignore.case = TRUE)) {
    return(NULL)
  }

  # Extract GitHub info
  user <- desc$GithubUsername %||% desc$RemoteUsername
  repo <- desc$GithubRepo %||% desc$RemoteRepo
  sha <- desc$GithubSHA1 %||% desc$RemoteSha
  subdir <- desc$GithubSubdir %||% desc$RemoteSubdir
  # Check if already installed from a ref (tag/branch)
  ref <- desc$GithubRef %||% desc$RemoteRef

  if (is.null(user) || is.null(repo)) return(NULL)

  # Determine the best ref to use: tag > existing ref > commit SHA
  best_ref <- NULL
  ref_type <- "commit"

  if (!is.null(ref) && ref != "HEAD" && ref != "master" && ref != "main") {
    # Already has a meaningful ref (likely a tag)
    best_ref <- ref
    ref_type <- "tag"
  } else if (use_tags && !is.null(sha)) {
    # Try to find a tag for this commit
    tag <- get_tag_for_commit(user, repo, sha)
    if (!is.null(tag)) {
      best_ref <- tag
      ref_type <- "tag"
    }
  }

  # Fall back to commit SHA
  if (is.null(best_ref) && !is.null(sha) && sha != "") {
    best_ref <- substr(sha, 1, 7)
    ref_type <- "commit"
  }

  # Build the remote string
  remote <- paste0(user, "/", repo)
  if (!is.null(subdir) && subdir != "" && subdir != ".") {
    remote <- paste0(remote, "/", subdir)
  }
  if (!is.null(best_ref)) {
    remote <- paste0(remote, "@", best_ref)
  }

  list(
    package = pkg,
    user = user,
    repo = repo,
    sha = sha,
    subdir = subdir,
    ref = best_ref,
    ref_type = ref_type,
    remote = remote
  )
}

#' Discover all GitHub-installed packages in a library
#' @param lib Library path
#' @return List of remote strings for GitHub packages
discover_github_packages <- function(lib = .libPaths()[1]) {
  pkgs <- list.dirs(lib, recursive = FALSE, full.names = FALSE)

  github_pkgs <- list()
  for (pkg in pkgs) {
    info <- get_installed_github_info(pkg, lib)
    if (!is.null(info)) {
      github_pkgs[[pkg]] <- info
    }
  }

  github_pkgs
}

# Helper for NULL coalescing (if not already defined)
`%||%` <- function(x, y) if (is.null(x) || is.na(x) || x == "") y else x

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

#' Generate changelog entry for package changes
#' @param added Character vector of added packages
#' @param removed Character vector of removed packages
#' @param version Version string for this release
#' @param changelog_path Path to CHANGELOG.md
generate_changelog <- function(added, removed, version, changelog_path = "CHANGELOG.md") {
  today <- format(Sys.Date(), "%Y-%m-%d")

  # Build the new entry
  entry <- sprintf("## [%s] - %s\n", version, today)

  if (length(added) > 0) {
    entry <- paste0(entry, "\n### Added\n")
    # Group by likely source
    for (pkg in sort(added)) {
      entry <- paste0(entry, sprintf("- `%s`\n", pkg))
    }
  }

  if (length(removed) > 0) {
    entry <- paste0(entry, "\n### Removed\n")
    for (pkg in sort(removed)) {
      entry <- paste0(entry, sprintf("- `%s`\n", pkg))
    }
  }

  if (length(added) == 0 && length(removed) == 0) {
    entry <- paste0(entry, "\n### Changed\n- No package changes\n")
  }

  # Add package stats
  entry <- paste0(entry, sprintf("\n### Package Statistics\n- Added: %d\n- Removed: %d\n",
                                  length(added), length(removed)))
  entry <- paste0(entry, "\n---\n\n")

  # Read existing changelog or create new
  if (file.exists(changelog_path)) {
    existing <- readLines(changelog_path)
    # Find where to insert (after the header)
    header_end <- grep("^## \\[", existing)[1]
    if (is.na(header_end)) header_end <- length(existing) + 1

    # Check if this version already exists
    if (any(grepl(sprintf("^## \\[%s\\]", version), existing))) {
      message("Changelog entry for version ", version, " already exists")
      return(invisible(NULL))
    }

    # Insert new entry
    new_content <- c(
      existing[1:(header_end - 1)],
      strsplit(entry, "\n")[[1]],
      existing[header_end:length(existing)]
    )
  } else {
    # Create new changelog
    header <- c(
      "# Changelog",
      "",
      "All notable changes to the rbiocverse package collection will be documented in this file.",
      "",
      ""
    )
    new_content <- c(header, strsplit(entry, "\n")[[1]])
  }

  writeLines(new_content, changelog_path)
  message("Updated: ", changelog_path)
  invisible(entry)
}

# =============================================================================
# Main Functions
# =============================================================================

#' Get all available packages from CRAN and Bioconductor
#' @return Character vector of available package names
get_available_packages <- function() {
  message("Fetching available packages from CRAN and Bioconductor...")

  # Use filters=NULL to ignore R version constraints
  # This ensures we check package existence, not compatibility with current R
  cran_pkgs <- tryCatch({
    ap <- available.packages(repos = "https://cloud.r-project.org", filters = NULL)
    rownames(ap)
  }, error = function(e) {
    warning("Could not fetch CRAN packages: ", e$message)
    character(0)
  })
  message("  CRAN: ", length(cran_pkgs), " packages")

  # Bioconductor repos
  bioc_repos <- c(
    "https://bioconductor.org/packages/release/bioc",
    "https://bioconductor.org/packages/release/data/annotation",
    "https://bioconductor.org/packages/release/data/experiment"
  )

  bioc_pkgs <- character(0)
  for (repo in bioc_repos) {
    pkgs <- tryCatch({
      ap <- available.packages(repos = repo, filters = NULL)
      rownames(ap)
    }, error = function(e) character(0))
    bioc_pkgs <- c(bioc_pkgs, pkgs)
  }
  bioc_pkgs <- unique(bioc_pkgs)
  message("  Bioconductor: ", length(bioc_pkgs), " packages")

  all_pkgs <- unique(c(cran_pkgs, bioc_pkgs))
  message("  Total available: ", length(all_pkgs), " packages")

  all_pkgs
}

#' Check all packages in DESCRIPTION for availability
#' @param fix If TRUE, remove unavailable packages
#' @export
check_packages <- function(fix = FALSE, path = DESCRIPTION_PATH) {
  desc <- read_description(path)
  imports <- parse_imports(desc$Imports)

  message("Checking ", length(imports), " packages...")

  # Get all available packages (fast batch lookup)
  available <- get_available_packages()

  # Base packages are always available
  base_pkgs <- rownames(installed.packages(priority = "base"))
  available <- unique(c(available, base_pkgs))

  unavailable <- setdiff(imports, available)

  if (length(unavailable) > 0) {
    message("\nUnavailable packages:")
    for (pkg in unavailable) {
      message("  UNAVAILABLE: ", pkg)
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
#' Adds all installed packages to DESCRIPTION
#' Also discovers GitHub packages and updates Remotes with pinned commits
#' @param dry_run If TRUE, just show what would change
#' @param merge If TRUE (default), only add packages, never remove. Set FALSE to replace.
#' @param exclude Packages to exclude
#' @param lib Library path to scan (defaults to R_LIBS_SITE or .libPaths()[1])
#' @export
sync_from_environment <- function(dry_run = TRUE, path = DESCRIPTION_PATH,
                                   merge = TRUE,
                                   exclude = c("rbiocverse"),
                                   lib = Sys.getenv("R_LIBS_SITE", .libPaths()[1])) {
  desc <- read_description(path)
  current_imports <- parse_imports(desc$Imports)
  current_remotes <- parse_remotes(desc$Remotes)

  # Discover GitHub packages from installed library (with commit pins)
  message("Scanning library for GitHub packages: ", lib)
  github_pkgs <- discover_github_packages(lib)
  message("Found ", length(github_pkgs), " GitHub-installed packages")

  # Build list of remote strings from discovered packages
  discovered_remotes <- sapply(github_pkgs, function(x) x$remote)
  github_pkg_names <- names(github_pkgs)

  # Merge with existing remotes (discovered takes precedence for updates)
  # But keep URL-based remotes (archived CRAN packages) from current
  existing_url_remotes <- current_remotes[grepl("^url::", sapply(current_remotes, function(r) r$full))]
  url_remote_strs <- sapply(existing_url_remotes, function(r) r$full)

  # Get installed packages (non-base, non-GitHub)
  ip <- installed.packages(lib.loc = lib)
  installed <- data.frame(
    Package = ip[, "Package"],
    Repository = if ("Repository" %in% colnames(ip)) ip[, "Repository"] else NA_character_,
    stringsAsFactors = FALSE
  )
  base_pkgs <- rownames(installed.packages(priority = c("base", "recommended")))
  installed <- installed[!installed$Package %in% base_pkgs, ]
  installed <- installed[!installed$Package %in% exclude, ]
  installed <- installed[!installed$Package %in% github_pkg_names, ]  # Exclude GitHub packages

  # Classify by source
  installed$Source <- ifelse(
    grepl("bioconductor", installed$Repository, ignore.case = TRUE), "Bioconductor",
    ifelse(is.na(installed$Repository) | installed$Repository == "", "Unknown", "CRAN")
  )

  # Include CRAN, Bioconductor, and Unknown (likely CRAN/Bioc installed without repo info)
  cran_bioc <- installed[installed$Source %in% c("CRAN", "Bioconductor", "Unknown"), "Package"]

  # GitHub packages should be in Imports too (the package name)
  installed_pkgs <- unique(c(cran_bioc, github_pkg_names))

  # In merge mode: union of current + installed (never remove)
  # In replace mode: just installed packages
  if (merge) {
    all_imports_set <- unique(c(current_imports, installed_pkgs))
  } else {
    all_imports_set <- installed_pkgs
  }

  # Find what's new vs current
  new_pkgs <- setdiff(installed_pkgs, current_imports)
  removed_pkgs <- if (merge) character(0) else setdiff(current_imports, installed_pkgs)

  # Compare remotes
  current_remote_strs <- sapply(current_remotes, function(r) r$full)
  new_remotes <- setdiff(discovered_remotes, current_remote_strs)
  updated_remotes <- character(0)

  # Check for updated commits on existing remotes
  for (pkg in github_pkg_names) {
    info <- github_pkgs[[pkg]]
    # Find if this package exists in current remotes (by repo name)
    matching <- sapply(current_remotes, function(r) {
      grepl(paste0("/", info$repo, "(/|@|$)"), r$full, ignore.case = TRUE)
    })
    if (any(matching)) {
      old_remote <- current_remotes[matching][[1]]$full
      if (old_remote != info$remote) {
        updated_remotes <- c(updated_remotes, sprintf("%s -> %s", old_remote, info$remote))
      }
    }
  }

  message("=== Sync from Environment ===")
  message("Library: ", lib)
  message("Mode: ", if (merge) "merge (add only)" else "replace")
  message("Current DESCRIPTION imports: ", length(current_imports))
  message("Installed (CRAN/Bioc): ", length(cran_bioc))
  message("Installed (GitHub): ", length(github_pkg_names))
  message("URL remotes (archived): ", length(url_remote_strs))
  message("")
  message("Imports to add: ", length(new_pkgs))
  message("Imports to remove: ", length(removed_pkgs))
  message("New GitHub remotes: ", length(new_remotes))
  message("Updated GitHub remotes: ", length(updated_remotes))

  if (length(new_pkgs) > 0) {
    message("\nNew packages to add:")
    message(paste("  ", head(new_pkgs, 20), collapse = "\n"))
    if (length(new_pkgs) > 20) message("  ... and ", length(new_pkgs) - 20, " more")
  }

  if (length(removed_pkgs) > 0) {
    message("\nPackages to remove (not installed):")
    message(paste("  ", removed_pkgs, collapse = "\n"))
  }

  if (length(new_remotes) > 0) {
    message("\nNew GitHub remotes:")
    message(paste("  ", new_remotes, collapse = "\n"))
  }

  if (length(updated_remotes) > 0) {
    message("\nUpdated GitHub remotes:")
    message(paste("  ", updated_remotes, collapse = "\n"))
  }

  if (!dry_run) {
    # Sort packages alphabetically
    all_imports <- sort(all_imports_set)

    # Format as DESCRIPTION Imports field
    imports_str <- paste("    ", all_imports, collapse = ",\n")
    desc$Imports <- paste0("\n", imports_str)

    # Merge remotes: keep existing + add/update from discovered
    if (merge) {
      # Build a map of repo -> remote string for merging
      # Start with current remotes
      remote_map <- list()
      for (r in current_remotes) {
        # Extract repo identifier (user/repo) for deduplication
        repo_key <- gsub("@.*$", "", r$full)  # Remove @ref suffix
        repo_key <- gsub("^url::", "", repo_key)  # Handle URL remotes
        remote_map[[repo_key]] <- r$full
      }
      # Update/add discovered remotes (these take precedence)
      for (pkg in github_pkg_names) {
        info <- github_pkgs[[pkg]]
        repo_key <- paste0(info$user, "/", info$repo)
        if (!is.null(info$subdir) && info$subdir != "" && info$subdir != ".") {
          repo_key <- paste0(repo_key, "/", info$subdir)
        }
        remote_map[[repo_key]] <- info$remote
      }
      all_remotes <- unname(unlist(remote_map))
    } else {
      # Replace mode: URL remotes + discovered GitHub remotes
      all_remotes <- c(url_remote_strs, discovered_remotes)
    }

    if (length(all_remotes) > 0) {
      remotes_str <- paste("    ", all_remotes, collapse = ",\n")
      desc$Remotes <- paste0("\n", remotes_str)
    }

    write_description(desc, path)
    message("\nDESCRIPTION updated:")
    message("  Imports: ", length(all_imports), " packages")
    message("  Remotes: ", length(all_remotes), " entries")

    # Generate changelog entry if there are changes
    if (length(new_pkgs) > 0 || length(removed_pkgs) > 0) {
      changelog_path <- file.path(dirname(dirname(path)), "CHANGELOG.md")
      generate_changelog(new_pkgs, removed_pkgs, desc$Version, changelog_path)
    }
  } else {
    message("\n[DRY RUN] Re-run with --apply to update DESCRIPTION")
  }

  invisible(list(
    added = new_pkgs,
    removed = removed_pkgs,
    total_imports = length(all_imports_set),
    github_remotes = discovered_remotes,
    url_remotes = url_remote_strs
  ))
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
  # Get current state before changes
  desc_before <- read_description(path)
  imports_before <- parse_imports(desc_before$Imports)

  message("=== Checking package availability ===")
  unavailable <- check_packages(fix = !dry_run, path = path)

  message("\n=== Updating GitHub remotes ===")
  update_remotes(dry_run = dry_run, path = path)

  if (!dry_run) {
    message("\n=== Bumping version ===")
    new_version <- bump(bump_type, path = path)

    # Generate changelog if packages were removed
    if (length(unavailable) > 0) {
      changelog_path <- file.path(dirname(dirname(path)), "CHANGELOG.md")
      generate_changelog(
        added = character(0),
        removed = unavailable,
        version = new_version,
        changelog_path = changelog_path
      )
    }
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
    message("  sync [--apply] [--merge|--replace]")
    message("                     Sync DESCRIPTION with installed packages")
    message("                     --merge (default): only add packages, never remove")
    message("                     --replace: replace with installed packages")
    message("  check [--apply]    Check package availability, remove unavailable")
    message("  remotes [--apply]  Update GitHub remote pins (dry-run by default)")
    message("  suggest            Show installed packages not in DESCRIPTION")
    message("  bump [type]        Bump version (patch|minor|major|bioc)")
    message("  update [--apply]   Full update (check + remotes + bump)")
    message("")
    message("Multi-cluster sync workflow:")
    message("  1. Sync from Cluster A (merge mode, adds packages):")
    message("     Rscript update-description.R sync --apply")
    message("  2. Sync from Cluster B (merge mode, adds more packages):")
    message("     Rscript update-description.R sync --apply")
    message("  3. Check availability and cleanup:")
    message("     Rscript update-description.R check --apply")
    message("")
    message("Examples:")
    message("  Rscript update-description.R sync              # Preview (merge mode)")
    message("  Rscript update-description.R sync --apply      # Apply (merge mode)")
    message("  Rscript update-description.R sync --replace    # Preview (replace mode)")
    message("  Rscript update-description.R check --apply     # Remove unavailable")
    message("  Rscript update-description.R bump bioc         # 3.22.0 -> 3.23.0")
    quit(status = 0)
  }

  cmd <- args[1]
  apply_flag <- "--apply" %in% args
  replace_flag <- "--replace" %in% args
  merge_mode <- !replace_flag  # merge is default

  if (cmd == "sync") {
    sync_from_environment(dry_run = !apply_flag, merge = merge_mode)
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
