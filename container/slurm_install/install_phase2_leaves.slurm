#!/bin/bash
#SBATCH --job-name=rbioc_leaves
#SBATCH --array=1-20
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
#SBATCH --time=2:00:00
#SBATCH --output=/home/domeally/workspaces/vscode-rbioc/slurm_install/install_leaf_%a.log

# Phase 2: Install leaf packages (depends on phase 1)
# Cluster: Gemini
SINGULARITY_IMAGE="/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif"
BIND_PATHS="/packages,/scratch"
R_LIBS_SITE="/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22"

module load singularity 2>/dev/null || true

PKGFILE=/home/domeally/workspaces/vscode-rbioc/slurm_install/pkgs_leaf_$(printf "%03d" $SLURM_ARRAY_TASK_ID).txt

if [ ! -f "$PKGFILE" ]; then
    echo "Package file not found: $PKGFILE"
    exit 1
fi

echo "=== Phase 2: Installing leaf packages (task $SLURM_ARRAY_TASK_ID) ==="
echo "Package file: $PKGFILE"
echo "Library: $R_LIBS_SITE"

singularity exec \
  --env R_LIBS_SITE=$R_LIBS_SITE \
  -B $BIND_PATHS \
  "$SINGULARITY_IMAGE" \
  Rscript -e "
    lib <- Sys.getenv(\"R_LIBS_SITE\")
    pkgs <- readLines(\"$PKGFILE\")
    for (pkg in pkgs) {
      message(sprintf(\"Installing %s...\", pkg))
      tryCatch(
        pak::pkg_install(pkg, lib = lib, upgrade = FALSE),
        error = function(e) message(sprintf(\"  FAILED: %s\", conditionMessage(e)))
      )
    }
  "

