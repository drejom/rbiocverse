#!/bin/bash
#SBATCH --job-name=rbioc_deps
#SBATCH --cpus-per-task=32
#SBATCH --mem=64G
#SBATCH --time=4:00:00
#SBATCH --output=/home/domeally/workspaces/vscode-rbioc/slurm_install/install_deps.log

# Phase 1: Install core dependencies
# Cluster: Gemini
SINGULARITY_IMAGE="/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif"
BIND_PATHS="/packages,/scratch"
R_LIBS_SITE="/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22"

module load singularity 2>/dev/null || true

echo "=== Phase 1: Installing core dependencies ==="
echo "Cluster: Gemini"
echo "Container: $SINGULARITY_IMAGE"
echo "Library: $R_LIBS_SITE"
echo "Packages: 89 core dependencies"
echo ""

singularity exec \
  --env R_LIBS_SITE=$R_LIBS_SITE \
  -B $BIND_PATHS \
  "$SINGULARITY_IMAGE" \
  Rscript -e "
    lib <- Sys.getenv(\"R_LIBS_SITE\")
    pkgs <- readLines(\"/home/domeally/workspaces/vscode-rbioc/slurm_install/pkgs_deps.txt\")
    message(\"Installing \", length(pkgs), \" core dependencies...\")
    tryCatch(
      pak::pkg_install(pkgs, lib = lib, upgrade = FALSE),
      error = function(e) {
        message(\"Batch install failed, trying one by one...\")
        for (pkg in pkgs) {
          tryCatch(
            pak::pkg_install(pkg, lib = lib, upgrade = FALSE),
            error = function(e) message(sprintf(\"  FAILED: %s - %s\", pkg, conditionMessage(e)))
          )
        }
      }
    )
    message(\"Phase 1 complete\")
  "

