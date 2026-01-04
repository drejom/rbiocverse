#!/bin/bash
# pull-container.sh
# Pull the vscode-rbioc container to the correct location based on cluster
# Uses Bioconductor version from rbiocverse/DESCRIPTION as single source of truth
#
# Usage: ./scripts/pull-container.sh [--tag TAG] [--force] [--dry-run]
#
# Tagging scheme:
#   - Dev releases:    vYYYY-M-DD (e.g., v2026-1-4)
#   - Stable releases: vX.Y.Z     (e.g., v3.22.0)
#   - Also available:  latest, RELEASE_X_YY
#
# Examples:
#   ./scripts/pull-container.sh                    # Pull :latest (skip if exists)
#   ./scripts/pull-container.sh --tag v2026-1-4   # Pull specific dev release
#   ./scripts/pull-container.sh --tag v3.22.0     # Pull specific stable release
#   ./scripts/pull-container.sh --force           # Overwrite existing container

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Source shared cluster configuration
source "$SCRIPT_DIR/cluster-config.sh"

# =============================================================================
# Main
# =============================================================================

main() {
    local dry_run=false
    local force=false
    local tag="latest"

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                dry_run=true
                shift
                ;;
            --force)
                force=true
                shift
                ;;
            --tag)
                tag="$2"
                shift 2
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--tag TAG] [--force] [--dry-run]"
                exit 1
                ;;
        esac
    done

    # Get version and detect cluster
    local bioc_version
    bioc_version=$(get_bioc_version)

    local cluster
    cluster=$(detect_cluster)

    if [[ "$cluster" == "unknown" ]]; then
        echo "ERROR: Could not detect cluster (not Gemini or Apollo)"
        exit 1
    fi

    local container_path
    container_path=$(get_container_path "$cluster" "$bioc_version")

    local library_path
    library_path=$(get_library_path "$cluster" "$bioc_version")

    local singularity_module
    singularity_module=$(get_singularity_module "$cluster")

    local image_url="docker://ghcr.io/drejom/vscode-rbioc:${tag}"

    echo "=== Container Pull Configuration ==="
    echo "Cluster:           $cluster"
    echo "Bioc Version:      $bioc_version"
    echo "Image Tag:         $tag"
    echo "Image URL:         $image_url"
    echo "Container Path:    $container_path"
    echo "Library Path:      $library_path"
    echo "Singularity:       $singularity_module"
    echo ""

    # Determine pull flags
    local pull_flags=""
    if [[ "$force" == true ]]; then
        pull_flags="-F"
    fi

    if [[ "$dry_run" == true ]]; then
        echo "[DRY RUN] Would execute:"
        echo "  module load $singularity_module"
        echo "  mkdir -p $library_path"
        echo "  singularity pull $pull_flags $container_path $image_url"
        exit 0
    fi

    # Check if container already exists
    if [[ -f "$container_path" && "$force" != true ]]; then
        echo "ERROR: Container already exists: $container_path"
        echo "Use --force to overwrite"
        exit 1
    fi

    # Create library directory if needed
    if [[ ! -d "$library_path" ]]; then
        echo "Creating library directory: $library_path"
        mkdir -p "$library_path"
    fi

    # Generate and submit SLURM job
    local job_script="/tmp/pull_container_${bioc_version}.slurm"
    local log_file="$(dirname "$container_path")/pull_${bioc_version}.log"

    cat > "$job_script" << EOF
#!/bin/bash
#SBATCH --job-name=pull_${bioc_version}
#SBATCH --time=04:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --output=${log_file}

module load ${singularity_module}
echo "Pulling container from: ${image_url}"
echo "Pulling container to:   ${container_path}"
singularity pull ${pull_flags} "${container_path}" "${image_url}"

echo ""
echo "=== Verification ==="
singularity exec "${container_path}" Rscript -e 'cat("R:", R.version.string, "\\n"); cat("Bioc:", as.character(BiocManager::version()), "\\n"); cat("pak:", as.character(packageVersion("pak")), "\\n")'
EOF

    echo "Submitting SLURM job..."
    local job_id
    job_id=$(sbatch "$job_script" | awk '{print $4}')

    echo ""
    echo "=== Job Submitted ==="
    echo "Job ID:    $job_id"
    echo "Log file:  $log_file"
    echo ""
    echo "Monitor with: squeue -j $job_id"
    echo "View log:     tail -f $log_file"
}

main "$@"
