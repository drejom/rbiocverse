# JupyterLab

Interactive notebooks for Python, R, and more.

## Getting Started

JupyterLab launches with your selected Bioconductor environment. Both Python and R kernels are available.

### Creating Notebooks

1. Click **File → New → Notebook**
2. Select your kernel:
   - **Python 3** - Container Python with cluster packages
   - **R** - R with Bioconductor packages

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Shift+Enter` | Run cell, advance |
| `Ctrl+Enter` | Run cell, stay |
| `Esc` then `A` | Insert cell above |
| `Esc` then `B` | Insert cell below |
| `Esc` then `DD` | Delete cell |
| `Esc` then `M` | Change to Markdown |
| `Esc` then `Y` | Change to Code |

## Available Kernels

### Python Kernel

The Python kernel uses the container's Python with:
- Standard scientific stack (numpy, pandas, scipy, matplotlib)
- Cluster-specific packages via `PYTHONPATH`
- GPU support when using A100/V100 nodes

### R Kernel (IRkernel)

Run R code in notebooks with:
- Full Bioconductor package access
- Interactive plots
- Reticulate for Python interop

## Jupyter Server Proxy

JupyterLab can proxy other web applications. Common use cases:

### Bokeh/Panel Apps

```python
import panel as pn
pn.serve(app, port=5006, show=False)
# Access via /jupyter-direct/proxy/5006/
```

### Dash Apps

```python
from dash import Dash
app.run_server(port=8050, mode='external')
# Access via /jupyter-direct/proxy/8050/
```

### Streamlit

```python
# In terminal:
streamlit run app.py --server.port 8501
# Access via /jupyter-direct/proxy/8501/
```

## Extensions

JupyterLab comes with common extensions pre-installed:
- Variable inspector
- Table of contents
- Git integration

Additional extensions can be installed per-user and persist in your home directory.

## Tips

### Working with Large Data

- Use `dask` for out-of-core computation
- Load only needed columns: `pd.read_csv(file, usecols=[...])`
- Monitor memory with `%memit` magic

### Notebook Best Practices

- Clear outputs before committing to git
- Use relative paths for portability
- Restart kernel periodically to free memory

### R in Notebooks

For R-heavy work, consider RStudio instead - it has better R tooling. Notebooks are ideal for:
- Documentation with results
- Sharing reproducible analyses
- Mixed Python/R workflows

## Troubleshooting

### Kernel dies unexpectedly

Usually out of memory. Request more memory when launching your session.

### Package not found

Packages install to your home directory. Try:

```python
# Python
!pip install --user package_name

# R
install.packages("package", lib=Sys.getenv("R_LIBS_USER"))
```

### Slow startup

First launch caches extensions. Subsequent starts are faster.
