# Secrets Configuration

## Required Environment Variables

Set these in Dokploy UI (NOT in git):

### Docker/Deployment
- `COMPOSE_PROJECT_NAME`: Deployment name (e.g., `omhq-hpc-code-server-prod`)
- `PUID`: User ID (default: 568)
- `PGID`: Group ID (default: 568)
- `TZ`: Timezone (default: America/Los_Angeles)

### Authentication (Required)
- `JWT_SECRET`: Secret key for JWT token signing (REQUIRED - no default)
- `TEST_USERNAME`: Username for test/dev authentication (REQUIRED - no default)
- `TEST_PASSWORD`: Password for test/dev authentication (REQUIRED - no default)
- `SESSION_EXPIRY_DAYS`: Session token expiry in days (default: 14)

### HPC Configuration
- `HPC_SSH_USER`: Username for HPC login (default: domeally)
- `GEMINI_SSH_HOST`: Gemini login node (default: gemini-login2.coh.org)
- `APOLLO_SSH_HOST`: Apollo login node (default: ppxhpcacc01.coh.org)
- `DEFAULT_HPC`: Default cluster (default: gemini)
- `DEFAULT_IDE`: Default IDE (default: vscode)
- `DEFAULT_CPUS`: Default CPU cores (default: 2)
- `DEFAULT_MEM`: Default memory (default: 40G)
- `DEFAULT_TIME`: Default walltime (default: 12:00:00)
- `ADDITIONAL_PORTS`: Comma-separated list of extra ports to tunnel (optional)
- `SESSION_IDLE_TIMEOUT`: Idle timeout in minutes, 0 = disabled (default: 0)

### Logging
- `LOG_LEVEL`: Log level - debug, info, warn, error (default: info)
- `LOG_FILE`: Path to log file (default: /data/logs/manager.log in production)
- `ERROR_LOG_FILE`: Path to error log file (default: /data/logs/errors.json)
- `DEBUG_COMPONENTS`: Comma-separated list of components for debug logging (optional)

### State Persistence
- `STATE_FILE`: Path to state persistence file (default: /data/state.json)
- `ENABLE_STATE_PERSISTENCE`: Enable state persistence to disk (default: false)
- `STATUS_CACHE_TTL`: Cache TTL for status in ms (default: 1800000 / 30 min)

### Admin Notifications (Optional)
- `ADMIN_EMAIL`: Email address for admin notifications
- `SMTP_HOST`: SMTP server hostname
- `SMTP_PORT`: SMTP server port (default: 587)
- `SMTP_USER`: SMTP authentication username
- `SMTP_PASS`: SMTP authentication password
- `SMTP_FROM`: From address for emails (default: rbiocverse@localhost)

## SSH Keys

SSH keys are mounted from `/mnt/ssd/docker/hpc-ssh/` on TrueNAS host.

Required files:
- `id_ed25519` - Private key with HPC access
- `known_hosts` - Contains HPC host keys
- `config` - SSH config with ProxyJump settings

## Test Configuration

For E2E tests:
- `E2E_BASE_URL`: Base URL for E2E tests (default: https://hpc.omeally.com)
- `CHROME_PATH`: Path to Chrome binary for Puppeteer tests
