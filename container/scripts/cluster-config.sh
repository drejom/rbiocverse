#!/bin/bash
# cluster-config.sh
# Shared configuration and cluster detection for rbiocverse scripts
# Source this file from other scripts: source "$(dirname "$0")/cluster-config.sh"

# =============================================================================
# Version Detection
# =============================================================================

# Get Bioc version from DESCRIPTION (target version for new release)
get_bioc_version() {
    local repo_root="${REPO_ROOT:-$(dirname "$(dirname "${BASH_SOURCE[0]}")")}"
    grep "^Version:" "$repo_root/rbiocverse/DESCRIPTION" | awk '{print $2}' | cut -d. -f1,2
}

# List available library versions on this cluster
get_available_versions() {
    local cluster="${1:-$(detect_cluster)}"
    local lib_base

    case "$cluster" in
        gemini)
            lib_base="/packages/singularity/shared_cache/rbioc/rlibs"
            ;;
        apollo)
            lib_base="/opt/singularity-images/rbioc/rlibs"
            ;;
        *)
            return 1
            ;;
    esac

    if [[ -d "$lib_base" ]]; then
        ls -1 "$lib_base" 2>/dev/null | sed 's/bioc-//' | sort -V
    fi
}

# =============================================================================
# Cluster Detection
# =============================================================================

detect_cluster() {
    if [[ -d "/packages/singularity" ]]; then
        echo "gemini"
    elif [[ -d "/opt/singularity-images" ]]; then
        echo "apollo"
    else
        echo "unknown"
    fi
}

# =============================================================================
# Cluster-specific Paths
# =============================================================================

get_container_path() {
    local cluster="$1"
    local version="$2"

    case "$cluster" in
        gemini)
            echo "/packages/singularity/shared_cache/rbioc/vscode-rbioc_${version}.sif"
            ;;
        apollo)
            echo "/opt/singularity-images/rbioc/vscode-rbioc_${version}.sif"
            ;;
        *)
            echo ""
            ;;
    esac
}

get_library_path() {
    local cluster="$1"
    local version="$2"

    case "$cluster" in
        gemini)
            echo "/packages/singularity/shared_cache/rbioc/rlibs/bioc-${version}"
            ;;
        apollo)
            echo "/opt/singularity-images/rbioc/rlibs/bioc-${version}"
            ;;
        *)
            echo ""
            ;;
    esac
}

get_python_path() {
    local cluster="$1"
    local version="$2"

    case "$cluster" in
        gemini)
            echo "/packages/singularity/shared_cache/rbioc/python/bioc-${version}"
            ;;
        apollo)
            echo "/opt/singularity-images/rbioc/python/bioc-${version}"
            ;;
        *)
            echo ""
            ;;
    esac
}

# Check if cluster has GPU support
has_gpu_support() {
    local cluster="$1"
    [[ "$cluster" == "gemini" ]]
}

get_bind_paths() {
    local cluster="$1"

    case "$cluster" in
        gemini)
            echo "/packages,/home,/tmp"
            ;;
        apollo)
            echo "/opt,/labs,/run,/ref_genome,/home,/tmp"
            ;;
        *)
            echo "/tmp"
            ;;
    esac
}

get_singularity_module() {
    local cluster="$1"

    case "$cluster" in
        gemini)
            echo "singularity/3.11.5"
            ;;
        apollo)
            echo "singularity/4.1.3"
            ;;
        *)
            echo "singularity"
            ;;
    esac
}

# Check if running inside a container
is_in_container() {
    # Check for singularity
    [[ -n "${SINGULARITY_CONTAINER:-}" ]] && return 0
    # Check for docker/podman
    [[ -f /.dockerenv ]] && return 0
    # Check cgroup for container indicators
    grep -q 'docker\|lxc\|kubepods' /proc/1/cgroup 2>/dev/null && return 0
    return 1
}

# Require host environment (not inside container)
require_host() {
    if is_in_container; then
        local script_path
        script_path="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)/$(basename "${BASH_SOURCE[1]}")"
        echo "ERROR: This script must run on the host, not inside a container." >&2
        echo "" >&2
        echo "You appear to be inside a container. Run from the host instead:" >&2
        echo "  ssh localhost '$script_path $*'" >&2
        echo "" >&2
        echo "Or exit the container first and run from a login shell." >&2
        return 1
    fi
}

# Load environment modules (needed for singularity)
load_modules() {
    # Source the modules init script if module command not available
    if ! type module &>/dev/null; then
        if [[ -f /etc/profile.d/modules.sh ]]; then
            source /etc/profile.d/modules.sh
        elif [[ -f /usr/share/Modules/init/bash ]]; then
            source /usr/share/Modules/init/bash
        fi
    fi
}

# Load singularity for the current cluster
load_singularity() {
    local cluster="${1:-$(detect_cluster)}"
    local module
    module=$(get_singularity_module "$cluster")

    load_modules
    module load "$module" 2>/dev/null || true
}

# =============================================================================
# SLURM Configuration
# =============================================================================

get_slurm_partition() {
    local cluster="$1"
    case "$cluster" in
        gemini) echo "all" ;;
        apollo) echo "all" ;;
        *) echo "all" ;;
    esac
}

# =============================================================================
# Helper: Run R script in container
# =============================================================================

# Run an R command in the appropriate container
# Usage: run_in_container VERSION "R expression"
run_in_container() {
    local version="$1"
    local r_code="$2"
    local cluster
    cluster=$(detect_cluster)

    local container lib bind_paths
    container=$(get_container_path "$cluster" "$version")
    lib=$(get_library_path "$cluster" "$version")
    bind_paths=$(get_bind_paths "$cluster")

    if [[ ! -f "$container" ]]; then
        echo "ERROR: Container not found: $container" >&2
        return 1
    fi

    singularity exec \
        --env R_LIBS=/usr/local/lib/R/site-library \
        --env R_LIBS_SITE="$lib" \
        -B "$bind_paths" \
        "$container" \
        Rscript -e "$r_code"
}

# =============================================================================
# Validation
# =============================================================================

validate_cluster() {
    local cluster
    cluster=$(detect_cluster)
    if [[ "$cluster" == "unknown" ]]; then
        echo "ERROR: Could not detect cluster (not Gemini or Apollo)" >&2
        echo "This script must be run on a supported HPC cluster." >&2
        return 1
    fi
    echo "$cluster"
}

validate_container() {
    local cluster="$1"
    local version="$2"
    local container
    container=$(get_container_path "$cluster" "$version")

    if [[ ! -f "$container" ]]; then
        echo "ERROR: Container not found: $container" >&2
        echo "Run ./scripts/pull-container.sh first" >&2
        return 1
    fi
    echo "$container"
}

validate_library() {
    local cluster="$1"
    local version="$2"
    local lib
    lib=$(get_library_path "$cluster" "$version")

    if [[ ! -d "$lib" ]]; then
        echo "WARNING: Library directory does not exist: $lib" >&2
        echo "Creating it now..." >&2
        mkdir -p "$lib"
    fi
    echo "$lib"
}

# =============================================================================
# Display Configuration
# =============================================================================

show_config() {
    local cluster version container lib python_lib bind_paths module gpu_support
    cluster=$(detect_cluster)
    version=$(get_bioc_version)
    container=$(get_container_path "$cluster" "$version")
    lib=$(get_library_path "$cluster" "$version")
    python_lib=$(get_python_path "$cluster" "$version")
    bind_paths=$(get_bind_paths "$cluster")
    module=$(get_singularity_module "$cluster")
    gpu_support=$(has_gpu_support "$cluster" && echo "yes" || echo "no")

    echo "=== Cluster Configuration ==="
    echo "Cluster:        $cluster"
    echo "Bioc Version:   $version"
    echo "Container:      $container"
    echo "R Library:      $lib"
    echo "Python Library: $python_lib"
    echo "GPU Support:    $gpu_support"
    echo "Bind Paths:     $bind_paths"
    echo "Singularity:    $module"
    echo ""
}
