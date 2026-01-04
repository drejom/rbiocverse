#!/bin/bash
# =============================================================================
# sync-python-packages.sh - Capture installed Python packages for upgrade review
#
# Usage:
#   ./scripts/sync-python-packages.sh --from 3.22
#
# This script:
#   1. Runs pip freeze inside the container to capture installed packages
#   2. Compares against rbiocverse/pyproject.toml to categorize packages
#   3. Generates a snapshot file for audit trail
#   4. Reports new packages that should be considered for [staged]
#
# Output:
#   - Console report showing package categories
#   - rbiocverse/pyproject.toml.<cluster>.<version>.from (snapshot file)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Source cluster configuration
source "$SCRIPT_DIR/cluster-config.sh"

# =============================================================================
# Help
# =============================================================================

show_help() {
    cat << EOF
Usage: $(basename "$0") --from <version>

Capture installed Python packages from an existing environment for upgrade review.

Options:
    --from VERSION    Source Bioconductor version to sync from (e.g., 3.22)
    --skip-transitive Skip transitive dependency check (faster but less accurate)
    --help            Show this help message

Examples:
    $(basename "$0") --from 3.22
    $(basename "$0") --from 3.22 --skip-transitive

Output:
    - Console report showing package categories
    - rbiocverse/pyproject.toml.<cluster>.<version>.from (snapshot)
EOF
}

# =============================================================================
# Main
# =============================================================================

from_version=""
skip_transitive=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --from)
            from_version="$2"
            shift 2
            ;;
        --skip-transitive)
            skip_transitive="--skip-transitive-check"
            shift
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

if [[ -z "$from_version" ]]; then
    echo "Error: --from is required"
    show_help
    exit 1
fi

# Detect cluster
cluster=$(detect_cluster)
echo "=== Python Package Sync ==="
echo ""
echo "Cluster:        $cluster"
echo "From Version:   $from_version"
echo ""

# Get paths
container=$(get_container_path "$cluster" "$from_version")
python_lib=$(get_python_path "$cluster" "$from_version")
bind_paths=$(get_bind_paths "$cluster")
module=$(get_singularity_module "$cluster")

# Verify paths exist
if [[ ! -f "$container" ]]; then
    echo "Error: Container not found: $container"
    exit 1
fi

if [[ ! -d "$python_lib" ]]; then
    echo "Error: Python library not found: $python_lib"
    exit 1
fi

echo "Container:      $container"
echo "Python Library: $python_lib"
echo ""

# Create temp directory for intermediate files
tmp_dir=$(mktemp -d)
trap "rm -rf $tmp_dir" EXIT

freeze_file="$tmp_dir/pip_freeze.txt"
pyproject_file="$REPO_ROOT/rbiocverse/pyproject.toml"
snapshot_file="$REPO_ROOT/rbiocverse/pyproject.toml.${cluster}.${from_version}.from"

# Load singularity module if needed
if [[ -n "$module" ]]; then
    source /opt/lmod/lmod/init/bash 2>/dev/null || \
    source /etc/profile.d/modules.sh 2>/dev/null || \
    source /usr/share/Modules/init/bash 2>/dev/null || true
    module load "$module" 2>/dev/null || true
fi

echo "Capturing installed packages..."

# Run pip freeze inside container
singularity exec \
    --env PYTHONPATH="$python_lib" \
    -B "$bind_paths" \
    "$container" \
    pip3 freeze > "$freeze_file"

pkg_count=$(wc -l < "$freeze_file")
echo "Found $pkg_count packages"
echo ""

# Check if sync-python.py exists
sync_script="$SCRIPT_DIR/sync-python.py"
if [[ ! -f "$sync_script" ]]; then
    echo "Error: sync-python.py not found at $sync_script"
    exit 1
fi

# Run analysis inside container (needs tomllib from Python 3.11+)
echo "Analyzing packages..."
echo ""

# Copy scripts to temp for container access
cp "$sync_script" "$tmp_dir/"
cp "$pyproject_file" "$tmp_dir/"

singularity exec \
    --env PYTHONPATH="$python_lib" \
    -B "$bind_paths","$tmp_dir":/mnt/sync \
    "$container" \
    python3 /mnt/sync/sync-python.py \
        --freeze /mnt/sync/pip_freeze.txt \
        --pyproject /mnt/sync/pyproject.toml \
        --output /mnt/sync/snapshot.toml \
        --cluster "$cluster" \
        --version "$from_version" \
        $skip_transitive || true

# Copy snapshot to final location
if [[ -f "$tmp_dir/snapshot.toml" ]]; then
    cp "$tmp_dir/snapshot.toml" "$snapshot_file"
    echo ""
    echo "Snapshot saved: $snapshot_file"
fi

echo ""
echo "=== Next Steps ==="
echo "1. Review the report above"
echo "2. Decide which 'NEW STAGED CANDIDATES' to keep:"
echo "   - Add to [project.optional-dependencies.staged] in pyproject.toml"
echo "   - Or drop if they were one-off experiments"
echo "3. Commit changes:"
echo "   git add rbiocverse/pyproject.toml rbiocverse/pyproject.toml.*.from"
echo "   git commit -m 'Sync Python packages for upgrade'"
