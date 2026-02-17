<p align="center">
  <img src="manager/public/images/rbiocverse-logo.svg" alt="Rbiocverse Logo" width="120" height="120">
</p>

# rbiocverse

[![Tests](https://github.com/drejom/rbiocverse/actions/workflows/test.yml/badge.svg)](https://github.com/drejom/rbiocverse/actions/workflows/test.yml)
[![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/drejom/5309bba1b50ac79e6b1744fd0ccfd20d/raw/coverage-main.json)](https://github.com/drejom/rbiocverse/actions/workflows/test.yml)

Unified R/Bioconductor development environment for HPC clusters. Provides browser-based IDE access (VS Code, RStudio, JupyterLab) to SLURM compute nodes via SSH tunneling.

## Components

### Container (`container/`)
Docker container extending [Bioconductor Docker](https://bioconductor.org/help/docker/) for HPC.

**Included:**
- **R 4.5** with ~1500 Bioconductor/CRAN packages (Seurat, DESeq2, etc.)
- **Python 3.12** with SCverse ecosystem (scanpy, scvi-tools, etc.)
- **JupyterLab** with LSP, formatting, resource monitor, git integration
- **pixi** for additional package management
- **Genomics tools**: bcftools, samtools, bedtools, sra-tools

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

## Deployment

### Pre-built Images (Recommended)

```bash
# Copy environment template and configure
cp .env.example .env
# Edit .env with your settings

# Pull and start
docker compose pull
docker compose up -d
```

**Images:**
- `ghcr.io/drejom/rbiocverse` - Bioconductor container for HPC
- `ghcr.io/drejom/rbiocverse-manager` - Web session manager

### Environment Configurations

| File | Environment | Description |
|------|-------------|-------------|
| `.env.dokploy.example` | Dokploy/TrueNAS | Double jump host SSH, Traefik routing |
| `.env.cgt.example` | cgt.coh.org | Direct HPC access from work VM |

## Development

```bash
# Manager (Node.js)
cd manager
npm install
npm test
npm start

# Container (Docker)
cd container
docker buildx build --platform linux/amd64 -t rbiocverse:test .
```

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
