# HPC Code Server Stack

[![Tests](https://github.com/drejom/omhq-hpc-code-server-stack/actions/workflows/test.yml/badge.svg)](https://github.com/drejom/omhq-hpc-code-server-stack/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/drejom/omhq-hpc-code-server-stack/graph/badge.svg)](https://codecov.io/gh/drejom/omhq-hpc-code-server-stack)

Browser-based IDE access to HPC SLURM clusters via SSH tunneling.

## Features

- **VS Code** - Full VS Code Server in browser
- **RStudio** - RStudio Server for R development
- **JupyterLab** - Jupyter notebooks with Python/R kernels
- **GPU Support** - A100/V100 on Gemini cluster
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
