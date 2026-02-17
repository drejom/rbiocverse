<p align="center">
  <img src="manager/public/images/rbiocverse-logo.svg" alt="Rbiocverse Logo" width="120" height="120">
</p>

# rbiocverse

[![Tests](https://github.com/drejom/rbiocverse/actions/workflows/test.yml/badge.svg)](https://github.com/drejom/rbiocverse/actions/workflows/test.yml)
[![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/drejom/5309bba1b50ac79e6b1744fd0ccfd20d/raw/coverage-main.json)](https://github.com/drejom/rbiocverse/actions/workflows/test.yml)

Unified R/Bioconductor development environment for HPC clusters. Provides browser-based IDE access (VS Code, RStudio, JupyterLab) to SLURM compute nodes via SSH tunneling.

## Components

### Container (`container/`)
Lean Docker container (~2-3GB) extending [Bioconductor Docker](https://bioconductor.org/help/docker/) for HPC. Contains system dependencies and tools; R/Python packages live on cluster shared storage.

**Included:**
- System deps for R packages (Seurat, monocle3, velocyto.R, etc.)
- **JupyterLab** with LSP, formatting, resource monitor, git integration
- **pixi** for additional package management
- **Genomics tools**: bcftools, samtools, bedtools, sra-tools
- **VS Code CLI** for serve-web and tunnels

See [container/USER_GUIDE.md](container/USER_GUIDE.md) for usage.

### Manager (`manager/`)
Web-based session manager for launching IDE sessions on HPC.

**Features:**
- **VS Code** - Full VS Code Server in browser
- **RStudio** - RStudio Server for R development
- **JupyterLab** - Jupyter notebooks with Python/R kernels
- **GPU Support** - A100/V100 on Gemini cluster
- **Multi-User Auth** - JWT authentication with per-user SSH keys
- **Themes** - Light and dark mode with system preference detection

See [manager/docs/ARCHITECTURE.md](manager/docs/ARCHITECTURE.md) for details.

## Architecture

```
Browser → Manager → SSH Tunnel → SLURM Job → Container
   │         │           │            │           │
   │         │           │            │           └─ Runs IDE (VS Code/RStudio/Jupyter)
   │         │           │            └─ Requests compute resources
   │         │           └─ Establishes port forwarding
   │         └─ Manages sessions, auth, proxy routing
   └─ Accesses IDE through web interface
```

### HPC Storage Layout

```
Container (lean, ~2-3GB)          Shared Libraries (HPC storage)
┌─────────────────────────┐       ┌─────────────────────────────┐
│ System deps, tools      │       │ rlibs/bioc-3.22/ (R)        │
│ JupyterLab + extensions │──────▶│ python/bioc-3.22/ (Python)  │
│ pixi, VS Code CLI       │       │ Shared by all users         │
└─────────────────────────┘       └─────────────────────────────┘
```

## Deployment

### Manager (Docker Compose)

The manager runs on a host with SSH access to HPC clusters.

```bash
# Clone and configure
git clone https://github.com/drejom/rbiocverse.git
cd rbiocverse
cp .env.cgt.example .env   # or .env.dokploy.example
# Edit .env with your settings (SSH paths, JWT secret, etc.)

# Start manager
docker compose up -d
```

| Environment | SSH Config | Use `.env` template |
|-------------|------------|---------------------|
| cgt.coh.org | Direct access to HPC | `.env.cgt.example` |
| Dokploy/TrueNAS | Double jump host | `.env.dokploy.example` |

### HPC Container (Singularity)

The Bioconductor container is built by GitHub Actions and pulled to clusters as a Singularity image.

```bash
# On HPC: Pull latest container (submits SLURM job)
cd container
./scripts/pull-container.sh --tag latest

# Install/update R packages to shared storage
./scripts/install-packages.sh --to 3.22 --submit

# Install/update Python packages
./scripts/install-python.sh --to 3.22 --submit
```

## Development

```bash
# Manager
cd manager
npm install
./scripts/dev.sh start   # Start dev server at http://localhost:3000
npm test                 # Run tests

# Container
cd container
docker buildx build --platform linux/amd64 -t rbiocverse:test .
```

## Documentation

| Document | Description |
|----------|-------------|
| [container/USER_GUIDE.md](container/USER_GUIDE.md) | End-user guide for JupyterLab, pixi, packages |
| [container/DEVELOPER_GUIDE.md](container/DEVELOPER_GUIDE.md) | Building containers, upgrading Bioconductor |
| [manager/docs/ARCHITECTURE.md](manager/docs/ARCHITECTURE.md) | Manager system design |
| [manager/docs/API.md](manager/docs/API.md) | REST API reference |
| [SECRETS.md](SECRETS.md) | Sensitive configuration documentation |

## License

MIT
