# rbiocverse

Unified monorepo for R/Bioconductor HPC development environment.

## Repository Structure

```
rbiocverse/
├── container/          # Bioconductor Docker container for HPC
│   ├── Dockerfile
│   ├── scripts/        # Package migration, cluster config
│   └── rbiocverse/     # Package manifest (DESCRIPTION, pyproject.toml)
├── manager/            # Web-based session manager (Express + React)
│   ├── server.ts       # Main Express server
│   ├── config/         # Cluster and IDE configuration
│   ├── services/       # HPC, tunnel, notification services
│   ├── routes/         # API endpoints
│   ├── lib/            # Shared utilities
│   └── ui/             # React frontend
├── docker-compose.yml  # Unified deployment
└── .github/workflows/  # CI/CD for both components
```

## HPC Cluster Access

SSH to clusters (ProxyJump configured in ~/.ssh/config):

```bash
ssh apollo.coh.org
ssh gemini-login1.coh.org
```

**Hostnames:**
- **Apollo**: `apollo.coh.org` or `ppxhpcacc01.coh.org`
- **Gemini**: `gemini-login1.coh.org` or `gemini-login2.coh.org`

## Container Paths

| Cluster | Container Path | R Library | Python Library |
|---------|---------------|-----------|----------------|
| Gemini  | `/packages/singularity/shared_cache/rbioc/rbiocverse_X.Y.sif` | `.../rlibs/bioc-X.Y` | `.../python/bioc-X.Y` |
| Apollo  | `/opt/singularity-images/rbioc/rbiocverse_X.Y.sif` | `.../rlibs/bioc-X.Y` | `.../python/bioc-X.Y` |

## Development

### Manager

```bash
cd manager
npm install
npm test                 # Run tests
npm run test:coverage    # With coverage
npm start                # Start server
```

### Container

```bash
cd container
docker buildx build --platform linux/amd64 -t ghcr.io/drejom/rbiocverse:test .
docker run -it --rm ghcr.io/drejom/rbiocverse:test /bin/bash
```

## Deployment

### Images

- `ghcr.io/drejom/rbiocverse` - Bioconductor container for HPC
- `ghcr.io/drejom/rbiocverse-manager` - Web session manager

### Quick Deploy

```bash
# Configure environment
cp .env.dokploy.example .env  # or .env.cgt.example

# Pull and start
docker compose pull && docker compose up -d
```

### Environment Files

| File | Use Case |
|------|----------|
| `.env.dokploy.example` | Dokploy/TrueNAS (double jump host SSH) |
| `.env.cgt.example` | cgt.coh.org work VM (direct HPC access) |

## CI/CD Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `test.yml` | Push to main/dev, PR | Run manager tests |
| `build-container.yml` | Tag push (v*), container changes | Build Bioconductor container |
| `build-manager.yml` | Push to main, manager changes | Build manager container |
| `release.yml` | Manual dispatch | Coordinated release (both images) |

## Key Files

### Manager
- `manager/config/index.ts` - Cluster definitions, IDE config, resource limits
- `manager/services/hpc.ts` - SLURM commands, job submission
- `manager/services/tunnel.ts` - SSH tunnel management
- `manager/lib/state.ts` - Session state management
- `manager/routes/api.ts` - REST API endpoints
- `manager/routes/auth.ts` - Authentication endpoints

### Container
- `container/Dockerfile` - Main container build
- `container/rbiocverse/DESCRIPTION` - R package manifest
- `container/rbiocverse/pyproject.toml` - Python package manifest
- `container/scripts/pull-container.sh` - Deploy to HPC clusters
- `container/scripts/install-packages.sh` - Install R packages via SLURM
