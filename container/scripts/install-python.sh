#!/bin/bash
# install-python.sh
# POST-RELEASE: Install Python packages to shared PYTHONPATH
# Run this AFTER pulling the new container
#
# This script:
# 1. Runs in the specified (--to) Bioc version container
# 2. Generates a SLURM job to install Python packages from pyproject.toml
# 3. Installs to the shared Python path
#
# Usage:
#   ./scripts/install-python.sh --to 3.22 [--submit]
#
# Options:
#   --to VERSION   Target Bioconductor version (default: from DESCRIPTION)
#   --submit       Submit SLURM job immediately (default: just generate)

set -euo pipefail

# Source shared cluster configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/cluster-config.sh"

usage() {
    echo "Usage: $0 [--to VERSION] [--submit]"
    echo ""
    echo "Install Python packages from pyproject.toml into shared PYTHONPATH."
    echo ""
    echo "Options:"
    echo "  --to VERSION   Target Bioconductor version (default: $(get_bioc_version) from DESCRIPTION)"
    echo "  --submit       Submit SLURM job immediately (default: just generate)"
    echo ""
    echo "Example:"
    echo "  $0 --to 3.22 --submit"
}

# =============================================================================
# Main
# =============================================================================

main() {
    local to_version=""
    local submit=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --to)
                to_version="$2"
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

    echo "=== Python Package Install ==="
    echo ""
    echo "Cluster:         $cluster"
    echo "Target Version:  $to_version"
    echo ""

    # Validate container exists
    local container python_lib
    container=$(get_container_path "$cluster" "$to_version")
    python_lib=$(get_python_path "$cluster" "$to_version")

    if [[ ! -f "$container" ]]; then
        echo "ERROR: Container not found: $container" >&2
        echo "Run ./scripts/pull-container.sh first" >&2
        exit 1
    fi

    # Create Python library directory if needed
    if [[ ! -d "$python_lib" ]]; then
        echo "Creating Python library directory: $python_lib"
        mkdir -p "$python_lib"
    fi

    local bind_paths module
    bind_paths=$(get_bind_paths "$cluster")
    module=$(get_singularity_module "$cluster")

    echo "Container:       $container"
    echo "Python Library:  $python_lib"
    echo ""

    # Get repo root for mounting
    local repo_root
    repo_root="${REPO_ROOT:-$(dirname "$SCRIPT_DIR")}"

    # Determine if GPU packages should be installed
    local pip_extras=""
    if has_gpu_support "$cluster"; then
        pip_extras="[gpu]"
        echo "GPU Support:     yes (installing GPU packages)"
    else
        echo "GPU Support:     no (skipping GPU packages)"
    fi
    echo ""

    # Create SLURM output directory
    mkdir -p slurm_install

    # Generate SLURM script
    local slurm_script="slurm_install/install_python.slurm"
    echo "Generating SLURM script: $slurm_script"

    cat > "$slurm_script" << EOF
#!/bin/bash
#SBATCH --job-name=python-install
#SBATCH --output=slurm_install/python_install_%j.log
#SBATCH --error=slurm_install/python_install_%j.log
#SBATCH --time=2:00:00
#SBATCH --cpus-per-task=20
#SBATCH --mem=32G
#SBATCH --partition=$(get_slurm_partition "$cluster")

# Python Package Installation for Bioconductor $to_version
# Generated: $(date)

set -euo pipefail

echo "=== Python Package Install ==="
echo "Date: \$(date)"
echo "Host: \$(hostname)"
echo "Cluster: $cluster"
echo ""

# Load singularity
module load $module

# Set up paths
CONTAINER="$container"
PYTHON_LIB="$python_lib"
REPO_ROOT="$repo_root"

echo "Container: \$CONTAINER"
echo "Python Library: \$PYTHON_LIB"
echo ""

# Install packages using pip
echo "Installing Python packages..."
singularity exec \\
    --env PYTHONPATH="\$PYTHON_LIB" \\
    -B "$bind_paths","\$REPO_ROOT":/mnt/rbiocverse \\
    "\$CONTAINER" \\
    pip3 install --no-cache-dir --break-system-packages \\
        --target="\$PYTHON_LIB" \\
        /mnt/rbiocverse/rbiocverse${pip_extras}

echo ""
echo "=== Installation Complete ==="
echo "Date: \$(date)"

# Verify installation
echo ""
echo "Verifying scanpy installation..."
singularity exec \\
    --env PYTHONPATH="\$PYTHON_LIB" \\
    -B "$bind_paths" \\
    "\$CONTAINER" \\
    python3 -c "import scanpy; print(f'scanpy version: {scanpy.__version__}')"

echo ""
echo "Python packages installed to: \$PYTHON_LIB"
EOF

    chmod +x "$slurm_script"

    # Generate submit script
    local submit_script="slurm_install/submit_python.sh"
    cat > "$submit_script" << EOF
#!/bin/bash
# Submit Python install job
sbatch $slurm_script
EOF
    chmod +x "$submit_script"

    echo ""

    if [[ "$submit" == true ]]; then
        echo "Submitting SLURM job..."
        bash "$submit_script"
    else
        echo "SLURM script generated: $slurm_script"
        echo ""
        echo "To submit job:"
        echo "  ./slurm_install/submit_python.sh"
        echo ""
        echo "Or run this script with --submit:"
        echo "  $0 --to $to_version --submit"
    fi
}

main "$@"
