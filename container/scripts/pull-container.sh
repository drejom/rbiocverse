#!/bin/bash
# pull-container.sh
# Pull the vscode-rbioc container to both HPC clusters via SSH
# Uses Bioconductor version from rbiocverse/DESCRIPTION as single source of truth
#
# Usage: ./scripts/pull-container.sh [--tag TAG] [--force] [--dry-run] [--cluster CLUSTER]
#
# Tagging scheme:
#   - Dev releases:    vYYYY-M-DD (e.g., v2026-1-4)
#   - Stable releases: vX.Y.Z     (e.g., v3.22.0)
#   - Also available:  latest, RELEASE_X_YY
#
# Examples:
#   ./scripts/pull-container.sh                       # Pull :latest to both clusters
#   ./scripts/pull-container.sh --tag v2026-1-8      # Pull specific tag to both clusters
#   ./scripts/pull-container.sh --cluster gemini     # Pull to Gemini only
#   ./scripts/pull-container.sh --force              # Overwrite existing containers
#   ./scripts/pull-container.sh --dry-run            # Show what would be done

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# =============================================================================
# Cluster Configuration
# =============================================================================

# Supported clusters
CLUSTERS="gemini apollo"

get_ssh_host() {
    local cluster="$1"
    case "$cluster" in
        gemini) echo "gemini" ;;
        apollo) echo "apollo" ;;
        *) echo "" ;;
    esac
}

get_container_base() {
    local cluster="$1"
    case "$cluster" in
        gemini) echo "/packages/singularity/shared_cache/rbioc" ;;
        apollo) echo "/opt/singularity-images/rbioc" ;;
        *) echo "" ;;
    esac
}

get_singularity_module() {
    local cluster="$1"
    case "$cluster" in
        gemini) echo "singularity/3.11.5" ;;
        apollo) echo "singularity/4.1.3" ;;
        *) echo "singularity" ;;
    esac
}

# =============================================================================
# Functions
# =============================================================================

get_bioc_version() {
    grep "^Version:" "$REPO_ROOT/rbiocverse/DESCRIPTION" | awk '{print $2}' | cut -d. -f1,2
}

get_container_path() {
    local cluster="$1"
    local version="$2"
    local base
    base=$(get_container_base "$cluster")
    echo "${base}/vscode-rbioc_${version}.sif"
}

get_library_path() {
    local cluster="$1"
    local version="$2"
    local base
    base=$(get_container_base "$cluster")
    echo "${base}/rlibs/bioc-${version}"
}

is_valid_cluster() {
    local cluster="$1"
    [[ " $CLUSTERS " == *" $cluster "* ]]
}

submit_pull_job() {
    local cluster="$1"
    local tag="$2"
    local force="$3"
    local dry_run="$4"
    local bioc_version="$5"

    local ssh_host
    ssh_host=$(get_ssh_host "$cluster")
    local container_path
    container_path=$(get_container_path "$cluster" "$bioc_version")
    local library_path
    library_path=$(get_library_path "$cluster" "$bioc_version")
    local singularity_module
    singularity_module=$(get_singularity_module "$cluster")
    local image_url="docker://ghcr.io/drejom/vscode-rbioc:${tag}"
    local log_dir
    log_dir=$(dirname "$container_path")
    local log_file="${log_dir}/pull_${bioc_version}.log"

    local pull_flags=""
    if [[ "$force" == true ]]; then
        pull_flags="-F"
    fi

    echo ""
    echo "=== $cluster ==="
    echo "SSH Host:        $ssh_host"
    echo "Container Path:  $container_path"
    echo "Library Path:    $library_path"
    echo "Image URL:       $image_url"

    if [[ "$dry_run" == true ]]; then
        echo "[DRY RUN] Would submit SLURM job via SSH"
        return 0
    fi

    # Check SSH connectivity
    if ! ssh -o ConnectTimeout=5 "$ssh_host" "echo ok" &>/dev/null; then
        echo "ERROR: Cannot connect to $ssh_host via SSH"
        return 1
    fi

    # Generate SLURM job script content
    local job_script
    job_script=$(cat <<EOF
#!/bin/bash
#SBATCH --job-name=pull_${bioc_version}
#SBATCH --time=04:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --output=${log_file}

module load ${singularity_module}

# Create library directory if needed
mkdir -p "${library_path}"

echo "Pulling container from: ${image_url}"
echo "Pulling container to:   ${container_path}"
singularity pull ${pull_flags} "${container_path}" "${image_url}"

echo ""
echo "=== Verification ==="
singularity exec "${container_path}" Rscript -e 'cat("R:", R.version.string, "\\n"); cat("Bioc:", as.character(BiocManager::version()), "\\n"); cat("pak:", as.character(packageVersion("pak")), "\\n")'

echo ""
echo "=== Container Info ==="
ls -lh "${container_path}"
EOF
)

    # Submit job via SSH
    local job_id
    job_id=$(ssh "$ssh_host" "
        job_file=\"/tmp/pull_container_${bioc_version}_\$\$.slurm\"
        cat > \"\$job_file\" <<'SLURM_EOF'
${job_script}
SLURM_EOF
        sbatch \"\$job_file\" | awk '{print \$4}'
        rm -f \"\$job_file\"
    ")

    if [[ -n "$job_id" ]]; then
        echo "Job submitted:   $job_id"
        echo "Log file:        $log_file"
        echo "Monitor:         ssh $ssh_host squeue -j $job_id"
    else
        echo "ERROR: Failed to submit job to $cluster"
        return 1
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    local dry_run=false
    local force=false
    local tag="latest"
    local target_cluster=""

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
            --cluster)
                target_cluster="$2"
                shift 2
                ;;
            -h|--help)
                echo "Usage: $0 [--tag TAG] [--force] [--dry-run] [--cluster CLUSTER]"
                echo ""
                echo "Options:"
                echo "  --tag TAG        Container tag to pull (default: latest)"
                echo "  --force          Overwrite existing container"
                echo "  --dry-run        Show what would be done without executing"
                echo "  --cluster NAME   Pull to specific cluster only (gemini or apollo)"
                echo ""
                echo "Examples:"
                echo "  $0 --tag v2026-1-8 --force    # Pull dev release to both clusters"
                echo "  $0 --cluster gemini           # Pull latest to Gemini only"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--tag TAG] [--force] [--dry-run] [--cluster CLUSTER]"
                exit 1
                ;;
        esac
    done

    local bioc_version
    bioc_version=$(get_bioc_version)

    echo "=== Container Pull Configuration ==="
    echo "Bioc Version:    $bioc_version"
    echo "Image Tag:       $tag"
    echo "Force:           $force"

    # Determine which clusters to target
    local target_clusters
    if [[ -n "$target_cluster" ]]; then
        if ! is_valid_cluster "$target_cluster"; then
            echo "ERROR: Unknown cluster: $target_cluster (valid: $CLUSTERS)"
            exit 1
        fi
        target_clusters="$target_cluster"
    else
        target_clusters="$CLUSTERS"
    fi

    echo "Target Clusters: $target_clusters"

    # Submit jobs to each cluster
    local failed=0
    for cluster in $target_clusters; do
        if ! submit_pull_job "$cluster" "$tag" "$force" "$dry_run" "$bioc_version"; then
            ((failed++)) || true
        fi
    done

    echo ""
    if [[ "$dry_run" == true ]]; then
        echo "=== Dry Run Complete ==="
    elif [[ $failed -eq 0 ]]; then
        echo "=== All Jobs Submitted ==="
        echo "Monitor with: ssh gemini squeue -u \$USER"
    else
        echo "=== $failed job(s) failed to submit ==="
        exit 1
    fi
}

main "$@"
