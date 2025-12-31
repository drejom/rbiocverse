#!/bin/bash
# SLURM command wrappers (SSH passthrough for container environments)
# These allow SLURM commands to work from within Singularity/Docker containers
# by tunneling through SSH to the host system.

set -e

SLURM_COMMANDS=(
    sacct
    sacctmgr
    salloc
    sattach
    sbatch
    sbcast
    scancel
    scontrol
    sdiag
    sgather
    sinfo
    smap
    sprio
    squeue
    sreport
    srun
    sshare
    sstat
    strigger
    sview
    seff
)

for cmd in "${SLURM_COMMANDS[@]}"; do
    cat > "/usr/local/bin/${cmd}" << WRAPPER
#!/bin/bash
ssh \$(whoami)@\$(hostname) ${cmd} "\$@"
WRAPPER
    chmod 755 "/usr/local/bin/${cmd}"
done

echo "SLURM wrappers installed for: ${SLURM_COMMANDS[*]}"
