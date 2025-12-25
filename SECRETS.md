# Secrets Configuration

## Required Environment Variables

Set these in Dokploy UI (NOT in git):

- `COMPOSE_PROJECT_NAME`: Deployment name (e.g., `omhq-hpc-code-server-prod`)
- `PUID`: User ID (default: 568)
- `PGID`: Group ID (default: 568)
- `TZ`: Timezone (default: America/Los_Angeles)

## SSH Keys

SSH keys are mounted from `/mnt/ssd/docker/hpc-ssh/` on TrueNAS host.

Required files:
- `id_ed25519` - Private key with HPC access
- `known_hosts` - Contains HPC host keys
- `config` - SSH config with ProxyJump settings

## HPC Configuration

Configured via environment:
- `HPC_SSH_USER`: Username for HPC login (default: domeally)
- `GEMINI_SSH_HOST`: Gemini login node (default: gemini-login2.coh.org)
- `APOLLO_SSH_HOST`: Apollo login node (default: ppxhpcacc01.coh.org)
- `DEFAULT_HPC`: Default cluster (default: gemini)
- `DEFAULT_CPUS`: Default CPU cores (default: 4)
- `DEFAULT_MEM`: Default memory (default: 40G)
- `DEFAULT_TIME`: Default walltime (default: 12:00:00)
