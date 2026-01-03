#!/bin/bash
# sync-packages.sh
# PRE-RELEASE: Sync DESCRIPTION with packages from existing environment
# Run this BEFORE updating to a new Bioconductor version
#
# This script:
# 1. Runs in the specified (--from) Bioc version container
# 2. Scans the library for installed packages
# 3. Outputs to DESCRIPTION.{cluster}.{from_version}.from for changelog tracking
# 4. Merges into main DESCRIPTION (unless --replace)
#
# Default behavior (merge mode):
# - Only ADDS packages to DESCRIPTION, never removes
# - This allows running on multiple clusters sequentially to build a union
# - Use --replace to replace DESCRIPTION with exactly what's installed
#
# Usage:
#   ./scripts/sync-packages.sh --from 3.19 [--apply] [--replace]
#
# The --apply flag writes changes to DESCRIPTION. Without it, dry-run only.
# Creates DESCRIPTION.{cluster}.{version}.from for release changelog tracking.

set -euo pipefail

# Source shared cluster configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/cluster-config.sh"

usage() {
    echo "Usage: $0 --from VERSION [--apply] [--replace]"
    echo ""
    echo "Sync DESCRIPTION with packages from an existing Bioconductor library."
    echo ""
    echo "Options:"
    echo "  --from VERSION   Source Bioconductor version to scan (required)"
    echo "  --apply          Apply changes to DESCRIPTION (default: dry-run)"
    echo "  --replace        Replace mode: remove packages not installed (default: merge)"
    echo ""
    echo "Modes:"
    echo "  merge (default): Only add packages, never remove. Run on multiple clusters"
    echo "                   to build the union of all installed packages."
    echo "  replace:         Replace DESCRIPTION with exactly what's installed."
    echo ""
    echo "Available versions on this cluster:"
    get_available_versions | sed 's/^/  /'
    echo ""
    echo "Multi-cluster workflow:"
    echo "  1. Run on Cluster A:  $0 --from 3.19 --apply"
    echo "  2. Git commit, push, pull on Cluster B"
    echo "  3. Run on Cluster B:  $0 --from 3.19 --apply"
    echo "  4. Git commit - DESCRIPTION now contains union of both clusters"
}

# =============================================================================
# Main
# =============================================================================

main() {
    local from_version=""
    local apply_flag=""
    local replace_flag=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --from)
                from_version="$2"
                shift 2
                ;;
            --apply)
                apply_flag="--apply"
                shift
                ;;
            --replace)
                replace_flag="--replace"
                shift
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                usage >&2
                exit 1
                ;;
        esac
    done

    # Validate --from is provided
    if [[ -z "$from_version" ]]; then
        echo "ERROR: --from VERSION is required" >&2
        echo "" >&2
        usage >&2
        exit 1
    fi

    # Must run on host, not inside container
    require_host "$@" || exit 1

    # Validate cluster
    local cluster
    cluster=$(validate_cluster) || exit 1

    echo "=== Pre-Release Package Sync ==="
    echo ""
    echo "Cluster:         $cluster"
    echo "Source Version:  $from_version"
    echo "Target:          rbiocverse/DESCRIPTION"
    echo ""

    # Validate container and library exist
    local container lib
    container=$(get_container_path "$cluster" "$from_version")
    lib=$(get_library_path "$cluster" "$from_version")

    if [[ ! -f "$container" ]]; then
        echo "ERROR: Container not found: $container" >&2
        echo "" >&2
        echo "Available versions:" >&2
        get_available_versions | sed 's/^/  /' >&2
        exit 1
    fi

    if [[ ! -d "$lib" ]]; then
        echo "ERROR: Library directory does not exist: $lib" >&2
        echo "Cannot sync from non-existent library." >&2
        exit 1
    fi

    local bind_paths module
    bind_paths=$(get_bind_paths "$cluster")
    module=$(get_singularity_module "$cluster")

    echo "Container:       $container"
    echo "Library:         $lib"
    echo "Mode:            ${apply_flag:-dry-run}"
    echo "Sync mode:       ${replace_flag:-merge}"
    echo ""

    # Load singularity
    load_singularity "$cluster"

    # Get repo root for mounting
    local repo_root
    repo_root="${REPO_ROOT:-$(dirname "$SCRIPT_DIR")}"

    # Run sync in container with specified library
    echo "Syncing from $from_version environment..."
    echo ""

    singularity exec \
        --env R_LIBS=/usr/local/lib/R/site-library \
        --env R_LIBS_SITE="$lib" \
        --pwd /mnt/rbiocverse \
        -B "$bind_paths","$repo_root":/mnt/rbiocverse \
        "$container" \
        Rscript /mnt/rbiocverse/scripts/update-description.R sync $apply_flag $replace_flag

    echo ""
    if [[ -n "$apply_flag" ]]; then
        # Create cluster-versioned changelog file
        local changelog_file="$repo_root/rbiocverse/DESCRIPTION.${cluster}.${from_version}.from"
        cp "$repo_root/rbiocverse/DESCRIPTION" "$changelog_file"
        echo "Created changelog file: $changelog_file"
        echo ""
        echo "DESCRIPTION updated from $from_version environment."
        echo ""
        echo "Next steps:"
        echo "  1. Review changes: git diff rbiocverse/DESCRIPTION"
        echo "  2. Check availability for new Bioc:"
        echo "     Rscript scripts/update-description.R check --apply --cluster $cluster --to VERSION"
        echo "  3. Update remotes and bump version:"
        echo "     Rscript scripts/update-description.R update --apply"
        echo "  4. Commit and push: git add -A && git commit -m 'Update packages'"
    else
        echo "Dry-run complete. Run with --apply to update DESCRIPTION."
    fi
}

main "$@"
