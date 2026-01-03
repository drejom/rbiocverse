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

#' Make authenticated GitHub API request
#' Uses gh CLI if available (handles auth automatically), otherwise falls back to direct API
#' @param endpoint GitHub API endpoint (e.g., "repos/owner/repo")
#' @return Parsed JSON response or NULL on error
github_api_get <- function(endpoint) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) return(NULL)

  # Remove full URL prefix if present

  endpoint <- sub("^https://api.github.com/", "", endpoint)

  # Try using gh CLI first (handles auth automatically)
  gh_available <- tryCatch({
    system2("gh", "--version", stdout = FALSE, stderr = FALSE) == 0
  }, error = function(e) FALSE)

  if (gh_available) {
    result <- tryCatch({
      output <- system2("gh", c("api", endpoint), stdout = TRUE, stderr = FALSE)
      if (length(output) > 0) {
        jsonlite::fromJSON(paste(output, collapse = "\n"))
      } else {
        NULL
      }
    }, error = function(e) NULL, warning = function(w) NULL)

    if (!is.null(result)) return(result)
  }

  # Fall back to direct API call (may hit rate limits)
  url <- paste0("https://api.github.com/", endpoint)
  tryCatch({
    jsonlite::fromJSON(url)
  }, error = function(e) NULL)
}

#' Validate a GitHub remote: check if ref exists and if package is now on CRAN/Bioc
#' @param remote_str Full remote string (e.g., "user/repo@ref")
#' @param available_pkgs Vector of available CRAN/Bioc package names
#' @return List with status, message, and suggested action
validate_github_remote <- function(remote_str, available_pkgs = NULL) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    return(list(valid = TRUE, message = "jsonlite not available, skipping validation"))
  }

  # Skip URL remotes
  if (grepl("^url::", remote_str)) {
    return(list(valid = TRUE, message = "URL remote, skipping"))
  }

  # Parse the remote string
  if (grepl("@", remote_str)) {
    parts <- strsplit(remote_str, "@")[[1]]
    repo <- parts[1]
    ref <- parts[2]
  } else {
    repo <- remote_str
    ref <- NULL
  }

  # Extract package name (last part of repo path, handling subdirs)
  repo_parts <- strsplit(repo, "/")[[1]]
  pkg_name <- repo_parts[length(repo_parts)]
  user_repo <- paste(repo_parts[1:min(2, length(repo_parts))], collapse = "/")

  result <- list(
    remote = remote_str,
    package = pkg_name,
    valid = TRUE,
    on_cran = FALSE,
    ref_exists = TRUE,
    message = "OK",
    action = NULL
  )

  # Check if package is now on CRAN/Bioconductor
  if (!is.null(available_pkgs) && pkg_name %in% available_pkgs) {
    result$on_cran <- TRUE
    result$message <- sprintf("Package '%s' is now on CRAN/Bioconductor", pkg_name)
    result$action <- "remove_remote"
  }

  # Check if repo exists at all first
  repo_url <- sprintf("https://api.github.com/repos/%s", user_repo)
  repo_info <- github_api_get(repo_url)
  repo_exists <- !is.null(repo_info)

  # Check if the ref exists (only if we have a specific ref and repo exists)
  if (repo_exists && !is.null(ref) && ref != "HEAD" && ref != "main" && ref != "master") {
    # Try as a branch first
    branch_url <- sprintf("https://api.github.com/repos/%s/branches/%s", user_repo, ref)
    branch_info <- github_api_get(branch_url)

    if (is.null(branch_info)) {
      # Try as a tag
      tag_url <- sprintf("https://api.github.com/repos/%s/git/refs/tags/%s", user_repo, ref)
      tag_info <- github_api_get(tag_url)

      if (is.null(tag_info)) {
        # Try as a commit SHA
        commit_url <- sprintf("https://api.github.com/repos/%s/commits/%s", user_repo, ref)
        commit_info <- github_api_get(commit_url)

        if (is.null(commit_info)) {
          result$valid <- FALSE
          result$ref_exists <- FALSE
          result$message <- sprintf("Ref '%s' not found for %s", ref, user_repo)
          result$action <- "update_ref"
        }
      }
    }
  }

  if (!repo_exists) {
    result$valid <- FALSE
    result$message <- sprintf("Repository '%s' not found (may have moved or been deleted)", user_repo)
    result$action <- "remove_or_update"
  }

  result
}

#' Validate all GitHub remotes in DESCRIPTION
#' @param fix If TRUE, remove remotes that are now on CRAN/Bioc
#' @param path Path to DESCRIPTION file
#' @return List of validation results
#' @export
validate_remotes <- function(fix = FALSE, path = DESCRIPTION_PATH) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("jsonlite required: install.packages('jsonlite')", call. = FALSE)
  }

  desc <- read_description(path)
  remotes <- parse_remotes(desc$Remotes)

  if (length(remotes) == 0) {
    message("No Remotes to validate")
    return(invisible(list()))
  }

  message("Validating ", length(remotes), " GitHub remotes...")

  # Get available packages for CRAN/Bioc check
  available <- get_available_packages()

  results <- list()
  issues <- list()
  to_remove <- character(0)

  for (r in remotes) {
    result <- validate_github_remote(r$full, available)
    results[[r$full]] <- result

    if (isFALSE(result$valid) || isTRUE(result$on_cran)) {
      issues[[r$full]] <- result

      if (isTRUE(result$on_cran)) {
        message(sprintf("  NOW ON CRAN: %s -> remove from Remotes", r$full))
        to_remove <- c(to_remove, r$full)
      } else if (isFALSE(result$ref_exists)) {
        message(sprintf("  INVALID REF: %s - %s", r$full, result$message))
      } else {
        message(sprintf("  INVALID: %s - %s", r$full, result$message))
      }
    }
  }

  if (length(issues) == 0) {
    message("All remotes valid!")
  } else {
    message("\n", length(issues), " remotes need attention")

    if (fix && length(to_remove) > 0) {
      message("\nRemoving ", length(to_remove), " remotes now on CRAN/Bioc...")
      current_remotes <- sapply(remotes, function(r) r$full)
      new_remotes <- setdiff(current_remotes, to_remove)

      if (length(new_remotes) > 0) {
        remotes_str <- paste("    ", new_remotes, collapse = ",\n")
        desc$Remotes <- paste0("\n", remotes_str)
      } else {
        desc$Remotes <- NULL
      }
      write_description(desc, path)
      message("Removed ", length(to_remove), " remotes")
    }
  }

  invisible(list(results = results, issues = issues, removed = to_remove))
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
#' @param bioc_version Bioconductor version to check (default: 3.22)
#' @return Character vector of available package names
get_available_packages <- function(bioc_version = "3.22") {
  message("Fetching available packages from CRAN and Bioconductor ", bioc_version, "...")

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

  # Bioconductor repos - use specified version, not "release"
  bioc_repos <- c(
    sprintf("https://bioconductor.org/packages/%s/bioc", bioc_version),
    sprintf("https://bioconductor.org/packages/%s/data/annotation", bioc_version),
    sprintf("https://bioconductor.org/packages/%s/data/experiment", bioc_version),
    sprintf("https://bioconductor.org/packages/%s/workflows", bioc_version)
  )

  bioc_pkgs <- character(0)
  for (repo in bioc_repos) {
    pkgs <- tryCatch({
      # Use filters = list() to disable R version filtering
      # Bioc 3.22 requires R >= 4.5 but we check existence, not compatibility
      ap <- available.packages(repos = repo, filters = list())
      rownames(ap)
    }, error = function(e) character(0))
    bioc_pkgs <- c(bioc_pkgs, pkgs)
  }
  bioc_pkgs <- unique(bioc_pkgs)
  message("  Bioconductor ", bioc_version, ": ", length(bioc_pkgs), " packages")

  all_pkgs <- unique(c(cran_pkgs, bioc_pkgs))
  message("  Total available: ", length(all_pkgs), " packages")

  all_pkgs
}

#' Check all packages in DESCRIPTION for availability
#' Produces a changelog-ready report categorizing packages by status
#' @param fix If TRUE, remove unavailable packages
#' @param bioc_version Bioconductor version to check against (target)
#' @param cluster Cluster name for changelog file (e.g., "gemini", "apollo")
#' @export
check_packages <- function(fix = FALSE, path = DESCRIPTION_PATH, bioc_version = "3.22", cluster = NULL) {
  desc <- read_description(path)
  imports <- parse_imports(desc$Imports)

  message("Checking ", length(imports), " packages against CRAN and Bioconductor ", bioc_version, "...")

  # Get all available packages (fast batch lookup)
  available <- get_available_packages(bioc_version)

  # Base packages are always available
  base_pkgs <- rownames(installed.packages(priority = "base"))
  available <- unique(c(available, base_pkgs))

  # Get packages with Remotes entries - these are handled separately
  remote_pkgs <- character(0)
  remote_map <- list()  # pkg_name -> remote_spec
  if (!is.null(desc$Remotes) && !is.na(desc$Remotes)) {
    remotes <- strsplit(desc$Remotes, ",\\s*")[[1]]
    remotes <- trimws(remotes)
    remotes <- remotes[remotes != ""]

    # Known repo->package name mappings for GitHub packages with non-standard names
    repo_to_pkg <- c(
      "azimuth" = "Azimuth",
      "seurat-data" = "SeuratData",
      "seurat-disk" = "SeuratDisk",
      "seurat-wrappers" = "SeuratWrappers"
    )
    # Packages provided by seurat-data (datasets)
    seurat_data_pkgs <- c("pbmc3k.SeuratData", "ifnb.SeuratData", "pbmcsca.SeuratData",
                          "celegans.embryo.SeuratData", "hcabm40k.SeuratData",
                          "stxBrain.SeuratData", "thp1.eccite.SeuratData")

    for (remote in remotes) {
      repo_name <- NULL
      if (grepl("^url::", remote)) {
        pkg_name <- sub(".*/([-a-zA-Z0-9.]+)_[0-9].*", "\\1", remote)
      } else {
        clean <- sub("@.*$", "", remote)
        parts <- strsplit(clean, "/")[[1]]
        repo_name <- parts[2]
        pkg_name <- if (repo_name %in% names(repo_to_pkg)) {
          repo_to_pkg[repo_name]
        } else {
          repo_name
        }
      }
      remote_pkgs <- c(remote_pkgs, pkg_name)
      remote_map[[pkg_name]] <- remote
      # If this is seurat-data, also add all dataset packages it provides
      if (!is.null(repo_name) && repo_name == "seurat-data") {
        remote_pkgs <- c(remote_pkgs, seurat_data_pkgs)
      }
    }
    message("  Packages with Remotes entries: ", length(unique(remote_pkgs)))
  }

  # Categorize unavailable packages
  unavailable <- setdiff(imports, c(available, unique(remote_pkgs)))

  # Detailed categorization for changelog
  categories <- list(
    cran_archived = character(0),
    bioc_deprecated = character(0),
    bioc_build_fail = character(0),
    github_only = character(0),
    unknown = character(0)
  )

  if (length(unavailable) > 0) {
    message("\nAnalyzing ", length(unavailable), " unavailable packages...")

    for (pkg in unavailable) {
      # Check CRAN archive
      cran_archive <- tryCatch({
        url <- sprintf("https://cran.r-project.org/src/contrib/Archive/%s/", pkg)
        readLines(url, n = 1, warn = FALSE)
        TRUE
      }, error = function(e) FALSE)

      # Check Bioconductor page
      bioc_page <- tryCatch({
        url <- sprintf("https://bioconductor.org/packages/%s/bioc/html/%s.html", bioc_version, pkg)
        html <- readLines(url, warn = FALSE)
        list(
          exists = TRUE,
          deprecated = any(grepl("deprecated", html, ignore.case = TRUE)),
          content = paste(html, collapse = "\n")
        )
      }, error = function(e) list(exists = FALSE, deprecated = FALSE, content = ""))

      # Categorize
      if (bioc_page$exists && bioc_page$deprecated) {
        categories$bioc_deprecated <- c(categories$bioc_deprecated, pkg)
      } else if (bioc_page$exists) {
        # Page exists but not in PACKAGES = build failure
        categories$bioc_build_fail <- c(categories$bioc_build_fail, pkg)
      } else if (cran_archive) {
        categories$cran_archived <- c(categories$cran_archived, pkg)
      } else {
        # Check if it might be GitHub-only
        categories$unknown <- c(categories$unknown, pkg)
      }
    }
  }

  # Print changelog-ready report
  message("\n", paste(rep("=", 60), collapse = ""))
  message("PACKAGE AVAILABILITY REPORT - Bioconductor ", bioc_version)
  message(paste(rep("=", 60), collapse = ""))
  message("\nTotal packages in DESCRIPTION: ", length(imports))
  message("Available (CRAN/Bioc): ", sum(imports %in% available))
  message("Via Remotes: ", length(remote_pkgs))
  message("Unavailable: ", length(unavailable))

  if (length(categories$cran_archived) > 0) {
    message("\n## Archived on CRAN (", length(categories$cran_archived), ")")
    message("   Action: Add URL remotes for archived versions")
    for (pkg in sort(categories$cran_archived)) {
      message("   - ", pkg)
    }
  }

  if (length(categories$bioc_deprecated) > 0) {
    message("\n## Deprecated in Bioconductor (", length(categories$bioc_deprecated), ")")
    message("   Action: Remove from DESCRIPTION")
    for (pkg in sort(categories$bioc_deprecated)) {
      message("   - ", pkg)
    }
  }

  if (length(categories$bioc_build_fail) > 0) {
    message("\n## Bioconductor Build Failures (", length(categories$bioc_build_fail), ")")
    message("   Action: Wait for upstream fix or remove")
    for (pkg in sort(categories$bioc_build_fail)) {
      message("   - ", pkg, " (check: https://bioconductor.org/checkResults/", bioc_version, "/bioc-LATEST/", pkg, "/)")
    }
  }

  if (length(categories$unknown) > 0) {
    message("\n## Unknown/GitHub-only (", length(categories$unknown), ")")
    message("   Action: Add GitHub remote or remove")
    for (pkg in sort(categories$unknown)) {
      message("   - ", pkg)
    }
  }

  if (length(unavailable) == 0) {
    message("\n✓ All packages available!")
  }

  message("\n", paste(rep("=", 60), collapse = ""))

  # Apply fixes if requested
  if (fix && length(unavailable) > 0) {
    # Only auto-remove deprecated packages
    to_remove <- c(categories$bioc_deprecated)
    if (length(to_remove) > 0) {
      message("\nRemoving ", length(to_remove), " deprecated packages from DESCRIPTION...")
      available_imports <- setdiff(imports, to_remove)
      imports_str <- paste("    ", sort(available_imports), collapse = ",\n")
      desc$Imports <- paste0("\n", imports_str)
      write_description(desc, path)
      message("Removed: ", paste(to_remove, collapse = ", "))
    }

    # Report what still needs manual attention
    manual_action <- c(categories$cran_archived, categories$bioc_build_fail, categories$unknown)
    if (length(manual_action) > 0) {
      message("\nManual action needed for ", length(manual_action), " packages:")
      message("  - Archived CRAN: add URL remotes")
      message("  - Build failures: wait or remove")
      message("  - Unknown: investigate and add remotes or remove")
    }
  }

  # Create cluster-versioned changelog file if cluster specified
  if (!is.null(cluster) && fix) {
    changelog_file <- file.path(dirname(path),
                                sprintf("DESCRIPTION.%s.%s.to", cluster, bioc_version))
    file.copy(path, changelog_file, overwrite = TRUE)
    message("\nCreated changelog file: ", changelog_file)
  }

  invisible(list(
    unavailable = unavailable,
    categories = categories,
    remote_pkgs = remote_pkgs
  ))
}

#' Generate changelog between Bioconductor versions
#' Compares .from and .to files to show what changed per cluster
#' @param from_version Source Bioconductor version (e.g., "3.19")
#' @param to_version Target Bioconductor version (e.g., "3.22")
#' @param path Directory containing DESCRIPTION files
#' @export
generate_changelog <- function(from_version, to_version, path = dirname(DESCRIPTION_PATH)) {
  # Find all changelog files
  from_pattern <- sprintf("DESCRIPTION\\..*\\.%s\\.from$", from_version)
  to_pattern <- sprintf("DESCRIPTION\\..*\\.%s\\.to$", to_version)

  from_files <- list.files(path, pattern = from_pattern, full.names = TRUE)
  to_files <- list.files(path, pattern = to_pattern, full.names = TRUE)

  if (length(from_files) == 0) {
    stop("No .from files found for version ", from_version, call. = FALSE)
  }
  if (length(to_files) == 0) {
    stop("No .to files found for version ", to_version, call. = FALSE)
  }

  # Extract cluster names
  extract_cluster <- function(f, version, suffix) {
    basename(f) |>
      sub("^DESCRIPTION\\.", "", x = _) |>
      sub(sprintf("\\.%s\\.%s$", version, suffix), "", x = _)
  }

  from_clusters <- sapply(from_files, extract_cluster, from_version, "from")
  to_clusters <- sapply(to_files, extract_cluster, to_version, "to")

  # Read imports from each file
  read_imports <- function(file) {
    desc <- read_description(file)
    sort(parse_imports(desc$Imports))
  }

  read_remotes_list <- function(file) {
    desc <- read_description(file)
    if (is.null(desc$Remotes) || is.na(desc$Remotes)) return(character(0))
    remotes <- strsplit(desc$Remotes, ",\\s*")[[1]]
    sort(trimws(remotes[trimws(remotes) != ""]))
  }

  # Collect data from all clusters
  from_data <- lapply(setNames(from_files, from_clusters), function(f) {
    list(imports = read_imports(f), remotes = read_remotes_list(f))
  })

  to_data <- lapply(setNames(to_files, to_clusters), function(f) {
    list(imports = read_imports(f), remotes = read_remotes_list(f))
  })

  # Get final DESCRIPTION
  final_desc <- file.path(path, "DESCRIPTION")
  final_imports <- if (file.exists(final_desc)) read_imports(final_desc) else character(0)
  final_remotes <- if (file.exists(final_desc)) read_remotes_list(final_desc) else character(0)

  # Calculate union of all .from imports (what we started with across clusters)
  all_from_imports <- unique(unlist(lapply(from_data, `[[`, "imports")))
  all_from_remotes <- unique(unlist(lapply(from_data, `[[`, "remotes")))

  # Print report
  message("")
  message(paste(rep("=", 70), collapse = ""))
  message(sprintf("CHANGELOG: Bioconductor %s -> %s", from_version, to_version))
  message(paste(rep("=", 70), collapse = ""))
  message("")

  # Package counts per cluster
  message("## Source Environments (", from_version, ")")
  message("")
  for (cluster in names(from_data)) {
    message(sprintf("   %-10s: %d packages, %d remotes",
                    cluster,
                    length(from_data[[cluster]]$imports),
                    length(from_data[[cluster]]$remotes)))
  }
  message(sprintf("   %-10s: %d packages (union)", "Combined", length(all_from_imports)))
  message("")

  # Target counts
  message("## Target Environment (", to_version, ")")
  message("")
  message(sprintf("   Final:      %d packages, %d remotes",
                  length(final_imports), length(final_remotes)))
  message("")

  # Packages added (in final but not in any .from)
  added <- setdiff(final_imports, all_from_imports)
  if (length(added) > 0) {
    message("## Packages Added (", length(added), ")")
    message("")
    # Show which cluster(s) each came from in .to files
    for (pkg in sort(added)) {
      sources <- character(0)
      for (cluster in names(to_data)) {
        if (pkg %in% to_data[[cluster]]$imports) {
          sources <- c(sources, cluster)
        }
      }
      source_str <- if (length(sources) > 0) paste(sources, collapse = ", ") else "manual"
      message(sprintf("   + %-30s [%s]", pkg, source_str))
    }
    message("")
  }

  # Packages removed (in .from but not in final)
  removed <- setdiff(all_from_imports, final_imports)
  if (length(removed) > 0) {
    message("## Packages Removed (", length(removed), ")")
    message("")
    # Show which cluster(s) had the package
    for (pkg in sort(removed)) {
      sources <- character(0)
      for (cluster in names(from_data)) {
        if (pkg %in% from_data[[cluster]]$imports) {
          sources <- c(sources, cluster)
        }
      }
      source_str <- paste(sources, collapse = ", ")
      message(sprintf("   - %-30s [was in: %s]", pkg, source_str))
    }
    message("")
  }

  # Cluster discrepancies (packages only on one cluster in .from)
  if (length(from_data) > 1) {
    message("## Cluster Discrepancies in Source (", from_version, ")")
    message("")
    clusters <- names(from_data)
    discrepancies <- list()

    for (i in seq_along(clusters)) {
      for (j in seq_along(clusters)) {
        if (i < j) {
          c1 <- clusters[i]
          c2 <- clusters[j]
          only_c1 <- setdiff(from_data[[c1]]$imports, from_data[[c2]]$imports)
          only_c2 <- setdiff(from_data[[c2]]$imports, from_data[[c1]]$imports)

          if (length(only_c1) > 0 || length(only_c2) > 0) {
            message(sprintf("   %s vs %s:", c1, c2))
            if (length(only_c1) > 0) {
              pkg_list <- paste(head(sort(only_c1), 10), collapse = ", ")
              if (length(only_c1) > 10) pkg_list <- paste0(pkg_list, ", ...")
              message(sprintf("     Only in %s (%d): %s", c1, length(only_c1), pkg_list))
            }
            if (length(only_c2) > 0) {
              pkg_list <- paste(head(sort(only_c2), 10), collapse = ", ")
              if (length(only_c2) > 10) pkg_list <- paste0(pkg_list, ", ...")
              message(sprintf("     Only in %s (%d): %s", c2, length(only_c2), pkg_list))
            }
            message("")
          }
        }
      }
    }
  }

  # Remotes added
  added_remotes <- setdiff(final_remotes, all_from_remotes)
  if (length(added_remotes) > 0) {
    message("## Remotes Added (", length(added_remotes), ")")
    message("")
    for (r in sort(added_remotes)) {
      # Shorten URL remotes for display
      display <- if (grepl("^url::", r)) {
        sub(".*Archive/", "url::Archive/", r)
      } else {
        r
      }
      message(sprintf("   + %s", display))
    }
    message("")
  }

  # Remotes removed
  removed_remotes <- setdiff(all_from_remotes, final_remotes)
  if (length(removed_remotes) > 0) {
    message("## Remotes Removed (", length(removed_remotes), ")")
    message("")
    for (r in sort(removed_remotes)) {
      display <- if (grepl("^url::", r)) {
        sub(".*Archive/", "url::Archive/", r)
      } else {
        r
      }
      message(sprintf("   - %s", display))
    }
    message("")
  }

  message(paste(rep("=", 70), collapse = ""))

  invisible(list(
    added = added,
    removed = removed,
    added_remotes = added_remotes,
    removed_remotes = removed_remotes,
    from_data = from_data,
    to_data = to_data
  ))
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

#' Full update: check packages, validate remotes, update remotes, bump version
#' @export
full_update <- function(bump_type = "patch", dry_run = TRUE, path = DESCRIPTION_PATH) {
  # Get current state before changes
  desc_before <- read_description(path)
  imports_before <- parse_imports(desc_before$Imports)

  message("=== Checking package availability ===")
  unavailable <- check_packages(fix = !dry_run, path = path)

  message("\n=== Validating GitHub remotes ===")
  validate_remotes(fix = !dry_run, path = path)

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
    message("  check [--apply] [--cluster NAME] [--to VERSION]")
    message("                     Check package availability, remove unavailable")
    message("                     --cluster: cluster name for changelog (gemini|apollo)")
    message("                     --to: target Bioconductor version (default: 3.22)")
    message("  validate [--apply] Validate GitHub remotes (refs exist, not on CRAN)")
    message("  remotes [--apply]  Update GitHub remote pins (dry-run by default)")
    message("  suggest            Show installed packages not in DESCRIPTION")
    message("  bump [type]        Bump version (patch|minor|major|bioc)")
    message("  update [--apply]   Full update (check + validate + remotes + bump)")
    message("  changelog --from VERSION --to VERSION")
    message("                     Generate changelog from .from/.to files")
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

  # Parse --cluster, --from, and --to arguments
  cluster_arg <- NULL
  from_version <- NULL
  to_version <- "3.22"  # default
  for (i in seq_along(args)) {
    if (args[i] == "--cluster" && i < length(args)) {
      cluster_arg <- args[i + 1]
    }
    if (args[i] == "--from" && i < length(args)) {
      from_version <- args[i + 1]
    }
    if (args[i] == "--to" && i < length(args)) {
      to_version <- args[i + 1]
    }
  }

  if (cmd == "sync") {
    sync_from_environment(dry_run = !apply_flag, merge = merge_mode)
  } else if (cmd == "check") {
    check_packages(fix = apply_flag, bioc_version = to_version, cluster = cluster_arg)
  } else if (cmd == "validate") {
    validate_remotes(fix = apply_flag)
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
  } else if (cmd == "changelog") {
    if (is.null(from_version)) {
      stop("changelog requires --from VERSION", call. = FALSE)
    }
    generate_changelog(from_version = from_version, to_version = to_version)
  } else {
    stop("Unknown command: ", cmd, call. = FALSE)
  }
}
