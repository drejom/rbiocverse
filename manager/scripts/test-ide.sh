#!/bin/bash
# Test IDE setup on HPC clusters - uses hpc.js wrap commands directly
# Usage: ./test-ide.sh [gemini|apollo] [vscode|rstudio|jupyter] [--gpu auto|a100|v100]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLUSTER=${1:-gemini}
IDE=${2:-vscode}
GPU=""
if [ "$3" = "--gpu" ]; then
  GPU=${4:-auto}
fi

JOB_NAME="test-${IDE}-$$"

# Cluster-specific settings (mirrors config/index.js)
case $CLUSTER in
  gemini)
    HOST="gemini-login2.coh.org"
    SINGULARITY="/packages/easy-build/software/singularity/3.7.0/bin/singularity"
    IMAGE="/packages/singularity/shared_cache/rbioc/rbiocverse_3.22.sif"
    R_LIBS_SITE="/packages/singularity/shared_cache/rbioc/rlibs/bioc-3.22"
    PYTHON_PATH="/packages/singularity/shared_cache/rbioc/python/bioc-3.22"
    BIND_PATHS="/packages,/scratch,/ref_genomes"
    PARTITION="compute"
    ;;
  apollo)
    HOST="ppxhpcacc01.coh.org"
    SINGULARITY="/opt/singularity/3.7.0/bin/singularity"
    IMAGE="/opt/singularity-images/rbioc/rbiocverse_3.22.sif"
    R_LIBS_SITE="/opt/singularity-images/rbioc/rlibs/bioc-3.22"
    PYTHON_PATH="/opt/singularity-images/rbioc/python/bioc-3.22"
    BIND_PATHS="/opt,/labs"
    PARTITION="fast"
    ;;
  *)
    echo "Usage: $0 [gemini|apollo] [vscode|rstudio|jupyter] [--gpu auto|a100|v100]"
    exit 1
    ;;
esac

# IDE-specific settings (mirrors config/index.js ides object)
case $IDE in
  vscode)
    PORT=8000
    ;;
  rstudio)
    PORT=8787
    ;;
  jupyter)
    PORT=8888
    ;;
  *)
    echo "Unknown IDE: $IDE. Use vscode, rstudio, or jupyter"
    exit 1
    ;;
esac

# GPU settings (Gemini only)
GPU_ARGS=""
NV_FLAG=""
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
    echo "   V100 nodes available: $V100_IDLE, A100 nodes available: $A100_IDLE"

    if [ "$V100_IDLE" -gt 0 ] && [ "$V100_IDLE" -ge "$A100_IDLE" ] 2>/dev/null; then
      GPU="v100"
      echo "   Selected: V100"
    elif [ "$A100_IDLE" -gt 0 ]; then
      GPU="a100"
      echo "   Selected: A100"
    else
      GPU="v100"
      echo "   Selected: V100 (default)"
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
  NV_FLAG="--nv"
fi

echo "=== Testing $IDE on $CLUSTER ==="
echo "Host: $HOST"
echo "Image: $IMAGE"
echo "Port: $PORT"
if [ -n "$GPU" ]; then
  echo "GPU: $GPU (partition: $PARTITION)"
fi
echo ""

# Test 1: Check container exists
echo "1. Checking container exists..."
ssh $HOST "test -f $IMAGE && echo '   ✓ Container found' || echo '   ✗ Container NOT found'"

# Test 2: Check IDE binary
echo ""
echo "2. Checking $IDE binary..."
case $IDE in
  vscode)
    ssh $HOST "$SINGULARITY exec $IMAGE code --version 2>/dev/null | head -1"
    ;;
  rstudio)
    ssh $HOST "$SINGULARITY exec $IMAGE rserver --version 2>/dev/null | head -1 || $SINGULARITY exec $IMAGE which rserver"
    ;;
  jupyter)
    ssh $HOST "$SINGULARITY exec $IMAGE jupyter --version 2>/dev/null | head -3"
    ;;
esac

# Test 3: Check paths
echo ""
echo "3. Checking paths..."
ssh $HOST "test -d $R_LIBS_SITE && echo '   ✓ R_LIBS_SITE exists' || echo '   ✗ R_LIBS_SITE NOT found'"
if [ -n "$PYTHON_PATH" ]; then
  ssh $HOST "test -d $PYTHON_PATH && echo '   ✓ PYTHONPATH exists' || echo '   ✗ PYTHONPATH NOT found (may need setup)'"
fi

# Get wrap command from hpc.js (single source of truth)
echo ""
echo "4. Getting wrap command from hpc.js..."
CPUS=1
WRAP_CMD=$(node "$SCRIPT_DIR/get-wrap-command.js" "$CLUSTER" "$IDE" "$CPUS")
if [ $? -ne 0 ]; then
  echo "   ✗ Failed to get wrap command"
  echo "   Error: $WRAP_CMD"
  exit 1
fi
echo "   ✓ Wrap command obtained from hpc.js"

# Add GPU flag to singularity exec if needed
if [ -n "$NV_FLAG" ]; then
  # Insert --nv after 'singularity exec'
  WRAP_CMD=$(echo "$WRAP_CMD" | sed 's/singularity exec/singularity exec --nv/')
fi

# Test 5: Submit job
echo ""
echo "5. Submitting SLURM job..."

MEM="4G"
TIME="00:05:00"

# Escape wrap command for SSH
WRAP_CMD_ESCAPED=$(printf '%s' "$WRAP_CMD" | sed "s/'/'\\\\''/g")
SBATCH_CMD="sbatch --parsable --job-name=$JOB_NAME --nodes=1 --cpus-per-task=$CPUS --mem=$MEM --partition=$PARTITION $GPU_ARGS --time=$TIME --wrap='$WRAP_CMD_ESCAPED'"

JOB_ID=$(ssh $HOST "$SBATCH_CMD" 2>&1 | grep -E '^[0-9]+$' | tail -1)
if [ -z "$JOB_ID" ]; then
  echo "   ✗ Failed to submit job"
  exit 1
fi
echo "   Job submitted: $JOB_ID"

# Test 6: Wait for job to start
echo ""
echo "6. Waiting for job to start..."
NODE=""
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

if [ "$STATE" = "RUNNING" ] && [ -n "$NODE" ]; then
  # Test 7: Wait for IDE to respond
  echo ""
  echo "7. Waiting for $IDE to respond (up to 30s)..."

  for i in {1..15}; do
    RESPONSE=$(ssh $HOST "curl -s -o /dev/null -w '%{http_code}' http://$NODE:$PORT/ 2>/dev/null || echo '000'")
    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "302" ]; then
      echo "   ✓ $IDE responding (HTTP $RESPONSE) after ${i}x2 seconds"
      break
    fi
    echo -n "."
    sleep 2
  done
  echo ""

  if [ "$RESPONSE" != "200" ] && [ "$RESPONSE" != "302" ]; then
    echo "   ✗ $IDE not responding (got: $RESPONSE)"
    echo "   Checking job logs..."
    ssh $HOST "cat ~/slurm-$JOB_ID.out 2>/dev/null | tail -30"
  fi

  # Test 8: GPU verification (if requested)
  if [ -n "$GPU" ]; then
    echo ""
    echo "8. Verifying GPU access..."
    GPU_CHECK=$(ssh $HOST "srun --jobid=$JOB_ID --overlap $SINGULARITY exec --nv $IMAGE nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'FAILED'")
    if [ "$GPU_CHECK" != "FAILED" ] && [ -n "$GPU_CHECK" ]; then
      echo "   ✓ GPU detected: $GPU_CHECK"
    else
      echo "   ✗ GPU not accessible"
    fi
  fi

  # Test 9: Cancel job
  echo ""
  echo "9. Cancelling test job..."
  ssh $HOST "scancel $JOB_ID"
  echo "   ✓ Job cancelled"
else
  echo ""
  echo "Job did not start. State: $STATE"
  echo "Cancelling..."
  ssh $HOST "scancel $JOB_ID 2>/dev/null || true"
fi

echo ""
echo "=== Test complete: $IDE on $CLUSTER ==="
