#!/bin/bash
# install-packages.sh
# POST-RELEASE: Install packages to a Bioconductor library
# Run this AFTER pulling the new container
#
# This script:
# 1. Runs in the specified (--to) Bioc version container
# 2. Generates two-phase SLURM jobs to install all packages from DESCRIPTION
# 3. Installs to the specified library path
#
# Usage:
#   ./scripts/install-packages.sh --to 3.22 [--jobs N] [--submit]
#
# Options:
#   --to VERSION   Target Bioconductor version (default: from DESCRIPTION)
#   --jobs N       Number of parallel jobs for phase 2 (default: 20)
#   --submit       Submit SLURM jobs immediately (default: just generate)

set -euo pipefail

# Source shared cluster configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/cluster-config.sh"

usage() {
    echo "Usage: $0 [--to VERSION] [--jobs N] [--submit]"
    echo ""
    echo "Install packages from DESCRIPTION into a Bioconductor library."
    echo ""
    echo "Options:"
    echo "  --to VERSION   Target Bioconductor version (default: $(get_bioc_version) from DESCRIPTION)"
    echo "  --jobs N       Number of parallel jobs for phase 2 (default: 20)"
    echo "  --submit       Submit SLURM jobs immediately (default: just generate)"
    echo ""
    echo "Example:"
    echo "  $0 --to 3.22 --submit"
}

# =============================================================================
# Main
# =============================================================================

main() {
    local to_version=""
    local jobs=20
    local submit=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --to)
                to_version="$2"
                shift 2
                ;;
            --jobs)
                jobs="$2"
                shift 2
                ;;
            --submit)
                submit=true
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

    # Default to version from DESCRIPTION if not specified
    if [[ -z "$to_version" ]]; then
        to_version=$(get_bioc_version)
    fi

    # Must run on host, not inside container
    require_host "$@" || exit 1

    # Validate cluster
    local cluster
    cluster=$(validate_cluster) || exit 1

    echo "=== Post-Release Package Install ==="
    echo ""
    echo "Cluster:         $cluster"
    echo "Target Version:  $to_version"
    echo "Jobs:            $jobs"
    echo ""

    # Validate container exists
    local container lib
    container=$(get_container_path "$cluster" "$to_version")
    lib=$(get_library_path "$cluster" "$to_version")

    if [[ ! -f "$container" ]]; then
        echo "ERROR: Container not found: $container" >&2
        echo "Run ./scripts/pull-container.sh first" >&2
        exit 1
    fi

    # Create library directory if needed
    if [[ ! -d "$lib" ]]; then
        echo "Creating library directory: $lib"
        mkdir -p "$lib"
    fi

    local bind_paths module
    bind_paths=$(get_bind_paths "$cluster")
    module=$(get_singularity_module "$cluster")

    echo "Container:       $container"
    echo "Library:         $lib"
    echo ""

    # Load singularity
    load_singularity "$cluster"

    # Get repo root for mounting
    local repo_root
    repo_root="${REPO_ROOT:-$(dirname "$SCRIPT_DIR")}"

    # Generate SLURM scripts
    echo "Generating two-phase SLURM install scripts..."
    echo ""

    singularity exec \
        --env R_LIBS=/usr/local/lib/R/site-library \
        --env R_LIBS_SITE="$lib" \
        -B "$bind_paths","$repo_root":/mnt/rbiocverse \
        "$container" \
        Rscript /mnt/rbiocverse/scripts/install.R \
            --slurm-smart "$jobs" \
            --cluster "$cluster" \
            --bioc-version "$to_version"

    echo ""

    if [[ "$submit" == true ]]; then
        local submit_script="slurm_install/submit_install.sh"
        if [[ -f "$submit_script" ]]; then
            echo "Submitting SLURM jobs..."
            bash "$submit_script"
        else
            echo "ERROR: Submit script not found: $submit_script" >&2
            exit 1
        fi
    else
        echo "SLURM scripts generated in slurm_install/"
        echo ""
        echo "To submit jobs:"
        echo "  ./slurm_install/submit_install.sh"
        echo ""
        echo "Or run this script with --submit:"
        echo "  $0 --to $to_version --submit"
    fi
}

main "$@"
