#!/bin/bash
# Test RStudio/R setup on HPC clusters
# Usage: ./test-rstudio.sh [gemini|apollo] [--gpu auto|a100|v100]

set -e

CLUSTER=${1:-gemini}
GPU=""
if [ "$2" = "--gpu" ]; then
  GPU=${3:-auto}
fi
PORT=8787
JOB_NAME="test-rstudio-$$"

# Cluster-specific settings
case $CLUSTER in
  gemini)
    HOST="gemini-login2.coh.org"
    SINGULARITY="/packages/easy-build/software/singularity/3.7.0/bin/singularity"
    IMAGE="/packages/singularity/shared_cache/rbioc/vscode-rbioc_3.22.sif"
    R_LIBS_SITE="/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22"
    PYTHON_PATH="/packages/singularity/shared_cache/rbioc/python/bioc-3.22"
    BIND_PATHS="/packages,/scratch,/ref_genomes"
    PARTITION="compute"
    ;;
  apollo)
    HOST="ppxhpcacc01.coh.org"
    SINGULARITY="/opt/singularity/3.7.0/bin/singularity"
    IMAGE="/opt/singularity-images/rbioc/vscode-rbioc_3.22.sif"
    R_LIBS_SITE="/opt/singularity-images/rbioc/rlibs/bioc-3.22"
    PYTHON_PATH="/opt/singularity-images/rbioc/python/bioc-3.22"
    BIND_PATHS="/opt,/labs"
    PARTITION="fast"
    ;;
  *)
    echo "Usage: $0 [gemini|apollo] [--gpu auto|a100|v100]"
    exit 1
    ;;
esac

# GPU settings (Gemini only)
GPU_ARGS=""
SINGULARITY_GPU=""
if [ -n "$GPU" ]; then
  if [ "$CLUSTER" != "gemini" ]; then
    echo "ERROR: GPU only available on Gemini"
    exit 1
  fi

  # Auto-select GPU queue based on idle nodes
  if [ "$GPU" = "auto" ]; then
    echo "Checking GPU queue availability..."
    V100_IDLE=$(ssh $HOST "sinfo -p gpu-v100 -h -t mix,idle -o '%D' | awk '{s+=\$1}END{print s+0}'")
    A100_IDLE=$(ssh $HOST "sinfo -p gpu-a100 -h -t mix,idle -o '%D' | awk '{s+=\$1}END{print s+0}'")
    echo "   V100 nodes with idle GPUs: $V100_IDLE, A100 nodes with idle GPUs: $A100_IDLE"

    if [ "$V100_IDLE" -gt 0 ] && [ "$V100_IDLE" -ge "$A100_IDLE" ] 2>/dev/null; then
      GPU="v100"
      echo "   Selected: V100"
    elif [ "$A100_IDLE" -gt 0 ]; then
      GPU="a100"
      echo "   Selected: A100"
    else
      GPU="v100"
      echo "   Selected: V100 (default - both queues busy)"
    fi
  fi

  case $GPU in
    a100)
      PARTITION="gpu-a100"
      GPU_ARGS="--gres=gpu:A100:1"
      ;;
    v100)
      PARTITION="gpu-v100"
      GPU_ARGS="--gres=gpu:V100:1"
      ;;
    *)
      echo "ERROR: Invalid GPU type. Use a100, v100, or auto"
      exit 1
      ;;
  esac
  SINGULARITY_GPU="--nv"
fi

echo "=== Testing R/RStudio on $CLUSTER ==="
echo "Host: $HOST"
echo "Image: $IMAGE"
if [ -n "$GPU" ]; then
  echo "GPU: $GPU (partition: $PARTITION)"
fi
echo ""

# Test 1: Check container exists
echo "1. Checking container exists..."
ssh $HOST "test -f $IMAGE && echo '   ✓ Container found' || echo '   ✗ Container NOT found'"

# Test 2: Check R version
echo ""
echo "2. Checking R installation..."
ssh $HOST "$SINGULARITY exec $IMAGE R --version 2>/dev/null | head -1"

# Test 3: Check Bioconductor version
echo ""
echo "3. Checking Bioconductor version..."
ssh $HOST "$SINGULARITY exec --env R_LIBS_SITE=$R_LIBS_SITE -B $BIND_PATHS $IMAGE Rscript -e 'cat(\"Bioconductor\", as.character(BiocManager::version()), \"\n\")' 2>/dev/null"

# Test 4: Check R libs path exists
echo ""
echo "4. Checking R libs..."
ssh $HOST "test -d $R_LIBS_SITE && echo '   ✓ R libs path exists' || echo '   ✗ R libs path NOT found'"
ssh $HOST "ls $R_LIBS_SITE 2>/dev/null | wc -l | xargs -I{} echo '   {} packages in site library'"

# Test 5: Check key packages
echo ""
echo "5. Checking key R packages..."
ssh $HOST "$SINGULARITY exec --env R_LIBS_SITE=$R_LIBS_SITE -B $BIND_PATHS $IMAGE Rscript -e '
pkgs <- c(\"Seurat\", \"SingleCellExperiment\", \"scater\", \"reticulate\", \"tensorflow\", \"keras\")
for (p in pkgs) {
  if (requireNamespace(p, quietly=TRUE)) {
    v <- as.character(packageVersion(p))
    cat(\"   ✓\", p, v, \"\n\")
  } else {
    cat(\"   ✗\", p, \"not found\n\")
  }
}
' 2>/dev/null"

# Test 6: Check radian (enhanced R terminal)
echo ""
echo "6. Checking radian..."
ssh $HOST "$SINGULARITY exec $IMAGE which radian 2>/dev/null && echo '   ✓ radian available' || echo '   ✗ radian not found'"

# Test 7: Submit test job (RStudio Server)
echo ""
echo "7. Submitting test SLURM job..."

# Build RStudio wrap command with required setup (mirrors hpc.js buildRstudioWrap)
RSTUDIO_SETUP="mkdir -p \$HOME/.rstudio-slurm/db \$HOME/.rstudio-slurm/run \$HOME/.rstudio-slurm/lib \$HOME/.rstudio-slurm/log"
RSTUDIO_CMD="rserver --www-port=$PORT --www-address=0.0.0.0 --auth-none=1 --server-daemonize=0 --database-config-file=/dev/null --server-data-dir=\$HOME/.rstudio-slurm/run --server-pid-file=\$HOME/.rstudio-slurm/run/rserver.pid"

# Minimal resources for quick test
SBATCH_CMD="sbatch --parsable --job-name=$JOB_NAME --partition=$PARTITION $GPU_ARGS --cpus-per-task=1 --mem=4G --time=00:05:00 --wrap='$RSTUDIO_SETUP && $SINGULARITY exec $SINGULARITY_GPU --env TERM=xterm-256color --env R_LIBS_SITE=$R_LIBS_SITE --env PYTHONPATH=$PYTHON_PATH -B $BIND_PATHS $IMAGE $RSTUDIO_CMD'"

JOB_ID=$(ssh $HOST "$SBATCH_CMD")
echo "   Job submitted: $JOB_ID"

# Wait for job to start
echo ""
echo "8. Waiting for job to start..."
for i in {1..30}; do
  STATE=$(ssh $HOST "squeue -j $JOB_ID -h -o %T 2>/dev/null || echo 'UNKNOWN'")
  if [ "$STATE" = "RUNNING" ]; then
    NODE=$(ssh $HOST "squeue -j $JOB_ID -h -o %N")
    echo "   ✓ Job running on node: $NODE"
    break
  elif [ "$STATE" = "PENDING" ]; then
    echo -n "."
    sleep 2
  else
    echo "   Job state: $STATE"
    break
  fi
done
echo ""

# Get node if running
if [ "$STATE" = "RUNNING" ]; then
  echo ""
  echo "9. Waiting for RStudio to start (up to 30s)..."

  for i in {1..15}; do
    RESPONSE=$(ssh $HOST "curl -s -o /dev/null -w '%{http_code}' http://$NODE:$PORT/ 2>/dev/null || echo '000'")
    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "302" ]; then
      echo "   ✓ RStudio responding (HTTP $RESPONSE) after ${i}x2 seconds"
      break
    fi
    echo -n "."
    sleep 2
  done
  echo ""

  if [ "$RESPONSE" != "200" ] && [ "$RESPONSE" != "302" ]; then
    echo "   ✗ RStudio not responding (got: $RESPONSE)"
    echo "   Checking job logs..."
    ssh $HOST "cat ~/slurm-$JOB_ID.out 2>/dev/null | tail -20"
  fi

  # GPU verification
  if [ -n "$GPU" ]; then
    echo ""
    echo "10. Verifying GPU access from R..."

    # Check nvidia-smi first
    GPU_CHECK=$(ssh $HOST "srun --jobid=$JOB_ID $SINGULARITY exec --nv $IMAGE nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'FAILED'")
    if [ "$GPU_CHECK" != "FAILED" ] && [ -n "$GPU_CHECK" ]; then
      echo "   ✓ GPU detected: $GPU_CHECK"
    else
      echo "   ✗ GPU not accessible via nvidia-smi"
    fi

    # Check tensorflow GPU support in R
    echo ""
    echo "11. Checking R tensorflow GPU support..."
    TF_GPU=$(ssh $HOST "srun --jobid=$JOB_ID $SINGULARITY exec --nv --env R_LIBS_SITE=$R_LIBS_SITE --env PYTHONPATH=$PYTHON_PATH -B $BIND_PATHS $IMAGE Rscript -e '
suppressMessages(library(tensorflow))
gpus <- tf\$config\$list_physical_devices(\"GPU\")
if (length(gpus) > 0) {
  cat(\"✓ TensorFlow GPU available:\", length(gpus), \"device(s)\n\")
} else {
  cat(\"✗ TensorFlow installed but no GPU detected\n\")
}
' 2>&1 || echo 'FAILED'")
    echo "   $TF_GPU"
  fi

  echo ""
  echo "12. Cancelling test job..."
  ssh $HOST "scancel $JOB_ID"
  echo "   ✓ Job cancelled"
else
  echo ""
  echo "Job did not start in time. Current state: $STATE"
  echo "Cancelling job..."
  ssh $HOST "scancel $JOB_ID 2>/dev/null || true"
fi

echo ""
echo "=== Test complete for $CLUSTER ==="
