#!/bin/bash
#SBATCH --job-name=rbiocverse_install
#SBATCH --array=1-20
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=4:00:00
#SBATCH --output=/home/domeally/workspaces/vscode-rbioc/slurm_install/install_%a.log

# Configuration - edit for your HPC
SINGULARITY_IMAGE="/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif"
BIND_PATHS="/packages,/scratch"
R_LIBS_SITE="/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22"

module load singularity 2>/dev/null || true

PKGFILE=/home/domeally/workspaces/vscode-rbioc/slurm_install/pkgs_$(printf "%03d" $SLURM_ARRAY_TASK_ID).txt

if [ ! -f "$PKGFILE" ]; then
    echo "Package file not found: $PKGFILE"
    exit 1
fi

echo "Installing packages from: $PKGFILE"
echo "Target library: $R_LIBS_SITE"

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

