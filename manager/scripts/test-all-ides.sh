#!/bin/bash
# Batch test all IDEs on all clusters
# Usage: ./test-all-ides.sh [--no-gpu]
#
# Default: 9 tests (3 IDEs x 2 clusters CPU + 3 GPU tests on Gemini)
# With --no-gpu: 6 tests (CPU only)
#
# Runs tests sequentially to avoid port conflicts on same node

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INCLUDE_GPU=true
if [ "$1" = "--no-gpu" ]; then
  INCLUDE_GPU=false
fi

IDES="vscode rstudio jupyter"
RESULTS_FILE=$(mktemp)
trap "rm -f $RESULTS_FILE" EXIT

get_host() {
  case $1 in
    gemini) echo "gemini-login2.coh.org" ;;
    apollo) echo "ppxhpcacc01.coh.org" ;;
  esac
}

get_singularity() {
  case $1 in
    gemini) echo "/packages/easy-build/software/singularity/3.7.0/bin/singularity" ;;
    apollo) echo "/opt/singularity/3.7.0/bin/singularity" ;;
  esac
}

get_image() {
  case $1 in
    gemini) echo "/packages/singularity/shared_cache/rbioc/rbiocverse_3.22.sif" ;;
    apollo) echo "/opt/singularity-images/rbioc/rbiocverse_3.22.sif" ;;
  esac
}

get_partition() {
  case $1 in
    gemini) echo "compute" ;;
    apollo) echo "fast" ;;
  esac
}

get_port() {
  case $1 in
    vscode) echo "8000" ;;
    rstudio) echo "8787" ;;
    jupyter) echo "8888" ;;
  esac
}

# Run a single test
run_test() {
  local CLUSTER=$1
  local IDE=$2
  local GPU_TYPE=$3  # empty, "a100", or "v100"

  local HOST=$(get_host $CLUSTER)
  local PARTITION=$(get_partition $CLUSTER)
  local PORT=$(get_port $IDE)
  local SINGULARITY=$(get_singularity $CLUSTER)
  local IMAGE=$(get_image $CLUSTER)
  local KEY="${CLUSTER}-${IDE}"
  local GPU_ARGS=""

  if [ -n "$GPU_TYPE" ]; then
    KEY="${KEY}-gpu"
    case $GPU_TYPE in
      a100) PARTITION="gpu-a100"; GPU_ARGS="--gres=gpu:A100:1" ;;
      v100) PARTITION="gpu-v100"; GPU_ARGS="--gres=gpu:V100:1" ;;
    esac
  fi

  # Get wrap command from hpc.js
  # hpc.js outputs \$ for shell vars (designed for ssh "sbatch --wrap='...'"")
  # We need to strip the backslashes since we're using base64 direct execution
  local WRAP_CMD=$(node "$SCRIPT_DIR/get-wrap-command.js" "$CLUSTER" "$IDE" 1 | sed 's/\\\$/$/g')
  if [ -n "$GPU_TYPE" ]; then
    WRAP_CMD=$(echo "$WRAP_CMD" | sed 's/singularity exec/singularity exec --nv/')
  fi
  local WRAP_B64=$(echo "$WRAP_CMD" | base64)

  # Submit job - decode wrap command on remote to avoid escaping problems
  local JOB_NAME="test-${IDE}-$$"
  local JOB_ID=$(ssh $HOST "sbatch --parsable --job-name=$JOB_NAME --nodes=1 --cpus-per-task=1 --mem=4G --partition=$PARTITION $GPU_ARGS --time=00:05:00 --wrap=\"\$(echo '$WRAP_B64' | base64 -d)\"" 2>&1 | grep -E '^[0-9]+$' | tail -1)

  if [ -z "$JOB_ID" ]; then
    echo "  $KEY: ✗ FAIL (submit)"
    echo "$KEY fail" >> $RESULTS_FILE
    return
  fi

  # Wait for job to start (max 10min)
  local NODE=""
  for i in {1..300}; do
    local STATUS=$(ssh $HOST "squeue -j $JOB_ID -h -o '%T %N' 2>/dev/null || echo 'GONE'")
    if echo "$STATUS" | grep -q "^RUNNING"; then
      NODE=$(echo "$STATUS" | awk '{print $2}')
      break
    elif ! echo "$STATUS" | grep -q "^PENDING"; then
      break
    fi
    sleep 2
  done

  if [ -z "$NODE" ]; then
    echo "  $KEY: ✗ FAIL (start)"
    ssh $HOST "scancel $JOB_ID 2>/dev/null" || true
    echo "$KEY fail" >> $RESULTS_FILE
    return
  fi

  # Wait for HTTP response (max 20s)
  # Use IDE-specific paths (Jupyter has base_url=/jupyter-direct)
  local CHECK_PATH="/"
  [ "$IDE" = "jupyter" ] && CHECK_PATH="/jupyter-direct/"
  local PASSED=""
  for i in {1..10}; do
    local RESPONSE=$(ssh $HOST "curl -s -o /dev/null -w '%{http_code}' http://$NODE:$PORT$CHECK_PATH 2>/dev/null || echo '000'")
    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "302" ]; then
      PASSED="yes"
      break
    fi
    sleep 2
  done

  if [ -n "$PASSED" ]; then
    if [ -n "$GPU_TYPE" ]; then
      local GPU_NAME=$(ssh $HOST "srun --jobid=$JOB_ID --overlap $SINGULARITY exec --nv $IMAGE nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo ''")
      if [ -n "$GPU_NAME" ]; then
        echo "  $KEY: ✓ PASS (GPU: $GPU_NAME)"
        echo "$KEY pass" >> $RESULTS_FILE
      else
        echo "  $KEY: ✗ FAIL (no GPU)"
        echo "$KEY fail" >> $RESULTS_FILE
      fi
    else
      echo "  $KEY: ✓ PASS"
      echo "$KEY pass" >> $RESULTS_FILE
    fi
  else
    echo "  $KEY: ✗ FAIL (HTTP)"
    echo "$KEY fail" >> $RESULTS_FILE
  fi

  # Cancel job
  ssh $HOST "scancel $JOB_ID 2>/dev/null" || true
}

echo "=== Batch IDE Testing ==="
if [ "$INCLUDE_GPU" = true ]; then
  echo "GPU tests: enabled (Gemini only)"
else
  echo "GPU tests: DISABLED (use without --no-gpu to enable)"
fi
echo ""

# Determine GPU partition
GPU_TYPE=""
if [ "$INCLUDE_GPU" = true ]; then
  V100_IDLE=$(ssh $(get_host gemini) "sinfo -p gpu-v100 -h -t mix,idle -o '%D' | awk '{s+=\$1}END{print s+0}'")
  A100_IDLE=$(ssh $(get_host gemini) "sinfo -p gpu-a100 -h -t mix,idle -o '%D' | awk '{s+=\$1}END{print s+0}'")
  if [ "$V100_IDLE" -gt 0 ] && [ "$V100_IDLE" -ge "$A100_IDLE" ] 2>/dev/null; then
    GPU_TYPE="v100"
  else
    GPU_TYPE="a100"
  fi
  echo "GPU: $GPU_TYPE (V100: $V100_IDLE, A100: $A100_IDLE)"
  echo ""
fi

# Run all tests
for cluster in gemini apollo; do
  echo "--- $cluster ---"
  for ide in $IDES; do
    run_test $cluster $ide ""
  done

  if [ "$cluster" = "gemini" ] && [ -n "$GPU_TYPE" ]; then
    echo "--- $cluster (GPU) ---"
    for ide in $IDES; do
      run_test $cluster $ide $GPU_TYPE
    done
  fi
done

# Summary
echo ""
echo "=== Summary ==="
PASS=$(grep -c " pass" $RESULTS_FILE || true)
FAIL=$(grep -c " fail" $RESULTS_FILE || true)
echo "Passed: $PASS / $((PASS + FAIL))"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failed:"
  grep " fail" $RESULTS_FILE | cut -d' ' -f1 | sed 's/^/  - /'
  exit 1
fi

echo ""
echo "=== All tests passed! ==="
