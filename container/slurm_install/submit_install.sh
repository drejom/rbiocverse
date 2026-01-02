#!/bin/bash
# Submit two-phase installation
# Phase 1 must complete before Phase 2 starts

echo "Submitting Phase 1 (core dependencies)..."
JOB1=$(sbatch /home/domeally/workspaces/vscode-rbioc/slurm_install/install_phase1_deps.slurm | awk '{print $4}')
echo "Phase 1 job ID: $JOB1"

echo "Submitting Phase 2 (leaf packages) with dependency on Phase 1..."
JOB2=$(sbatch --dependency=afterok:$JOB1 /home/domeally/workspaces/vscode-rbioc/slurm_install/install_phase2_leaves.slurm | awk '{print $4}')
echo "Phase 2 job ID: $JOB2"

echo ""
echo "Monitor with: squeue -u $USER"
echo "Logs in: /home/domeally/workspaces/vscode-rbioc/slurm_install/"

