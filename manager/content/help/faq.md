# {{icon:question}} FAQ

Frequently asked questions about rbiocverse.

## General

### What is rbiocverse?

rbiocverse provides browser-based access to VS Code, RStudio, and JupyterLab running on HPC clusters. Your code runs on powerful compute nodes while you work from any browser.

### Which cluster should I use?

- **Gemini** - Has GPUs (A100, V100). Use for deep learning, GPU-accelerated computation.
- **Apollo** - CPU-focused with high memory. Use for general workloads, large-memory jobs.

Check health indicators - use whichever has more availability.

### Can I run multiple sessions?

Yes! You can run sessions on different clusters simultaneously. For example, RStudio on Gemini and VS Code on Apollo.

### How long can my session run?

Up to 14 days on most partitions. GPU partitions have shorter limits (4-8 days). See the [Environment](/help/environment) section for partition limits.

### What happens when time runs out?

Your SLURM job ends and the IDE disconnects. **Save your work before time expires.** Unsaved changes in open editors will be lost.

## Data & Files

### Where should I save my files?

Your home directory (`$HOME`) is shared across all clusters and sessions. Save work there for persistence.

### Is my data backed up?

Home directories are backed up by cluster administrators. For critical data, maintain your own backups or use version control.

### Can I access network drives?

Cluster network mounts are available in your sessions. Check with your admin for mount paths.

## Sessions & Jobs

### Why is my job pending?

The cluster is busy. Smaller resource requests queue faster. Check health indicators and consider the other cluster.

### Can I pause my session?

Not directly, but you can:
1. Disconnect and reconnect later (job keeps running)
2. Save work, stop the job, relaunch when ready

### What if I forget to stop my job?

Jobs end automatically at walltime. Unused jobs consume cluster resources - please stop sessions when done.

## Technical

### Why install as PWA?

PWA (Progressive Web App) mode gives your IDE better keyboard shortcut access. Browsers capture shortcuts like `Ctrl+N` that IDEs need. PWA mode bypasses most of these restrictions.

### Can I use my own VS Code extensions?

Yes! Install extensions normally - they persist in your home directory between sessions.

### How does authentication work?

Currently single-user mode. Multi-user authentication uses your COH credentials (coming soon).

### Where are IDE settings stored?

- **VS Code**: `~/.vscode-slurm/`
- **RStudio**: `~/.rstudio-hpc/`
- **JupyterLab**: `~/.jupyter/`

Settings persist between sessions.

## Python & R

### Which Python version?

Python comes from the container image, matched to your Bioconductor release. Check with `python --version` in terminal.

### Can I install packages?

Yes:
- **R**: `install.packages()` installs to `R_LIBS_USER`
- **Python**: `pip install --user` or create a virtualenv

### Why won't my package install?

Common causes:
1. **Disk quota** - Check with `quota` command
2. **Compilation needs** - Some packages need system libraries
3. **Version conflicts** - Try creating a fresh environment

## Getting Help

### How do I report an issue?

Contact support with:
1. Your username
2. Which cluster
3. What you were doing
4. Any error messages

### Is there documentation?

You're reading it! Browse the help sections for specific topics.

### Where can I learn more about HPC?

- Cluster documentation from your HPC team
- SLURM documentation: https://slurm.schedmd.com/
- Software Carpentry HPC lessons
