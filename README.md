# HPC Code Server Stack

[![Tests](https://github.com/drejom/omhq-hpc-code-server-stack/actions/workflows/test.yml/badge.svg)](https://github.com/drejom/omhq-hpc-code-server-stack/actions/workflows/test.yml)
[![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/drejom/5309bba1b50ac79e6b1744fd0ccfd20d/raw/coverage-main.json)](https://github.com/drejom/omhq-hpc-code-server-stack/actions/workflows/test.yml)

Browser-based IDE access to HPC SLURM clusters via SSH tunneling.

## Features

- **VS Code** - Full VS Code Server in browser
- **RStudio** - RStudio Server for R development
- **JupyterLab** - Jupyter notebooks with Python/R kernels
- **GPU Support** - A100/V100 on Gemini cluster
- **Multi-User Auth** - JWT authentication with per-user SSH keys
- **Themes** - Light and dark mode with system preference detection
- **Built-in Help** - Contextual documentation with live cluster data
- **Floating Menu** - Switch IDEs, stop sessions without leaving the editor

## Architecture

See [manager/docs/ARCHITECTURE.md](manager/docs/ARCHITECTURE.md)

## Development

```bash
cd manager
npm install
npm test
npm start
```

## API

See [manager/docs/API.md](manager/docs/API.md)
