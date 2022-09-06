# Bioconductor on Apollo

This repository provides a `Dockerfile` that extends the official [Bioconductor Docker](https://bioconductor.org/help/docker/) image by adding system and python packages and the HPC job scheduler SLURM. GitHub actions build the image and push it to GitHub Packages.

## Additionally supported packages
Bioconductor Docker containers are based on the Rocker project images, which provide RStudio Server, a full featured RStudio session via a webbrowser. To the Rocker project's images, the Bioconductor developers add all the system dependencies that are required to support Bioconductor R libraries. We extend the container further by adding: 

- System dependencies to support `fnmate` and `datapasta`
- System dependencies to support `monocle3`
- DNANexus support (DX toolkit, dxfuse)
- SLURM
- VSCode LiveShare, R devcontainers

## Bioconductor version **3.15**

Build the container for the HPC:

```sh
module load singualrity   
singularity pull /opt/singularity-images/rbioc/vscode-rbioc.img docker://ghcr.io/drejom/vscode-rbioc:main
```

And launch on the HPC:

```sh
sbatch /opt/singularity-images/rbioc/rstudio.job
```
