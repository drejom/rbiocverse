# Bioconductor on Apollo

This repository provides a Dockerfile that extends the official [Bioconductor Docker](https://bioconductor.org/help/docker/) image by adding some packages including the HPC job scheduler SLURM. GitHub actions build the image and push it to GitHub Packages.

## Additionally supported packages
[Bioconductor Docker](https://bioconductor.org/help/docker/) containers are based on [Rocker](https://rocker-project.org/) project images, which provide RStudio Server, a full featured IDE via a web browser. To the Rocker project's images, the Bioconductor developers add all the system dependencies required to support Bioconductor R libraries. We extend the container further by adding: 

- System dependencies to support `jqr`, `monocle3`, `fnmate` and `datapasta`
- DNANexus support (DX toolkit, dxfuse)
- SLURM
- VSCode LiveShare, R devcontainer [dependencies](https://github.com/microsoft/vscode-dev-containers/blob/main/containers/r/.devcontainer/devcontainer.json)

## Bioconductor version **3.15**

Build the container for the HPC:

```sh
module load singularity
singularity pull /opt/singularity-images/rbioc/vscode-rbioc.img docker://ghcr.io/drejom/vscode-rbioc:main
```

And launch on the HPC:

```sh
sbatch /opt/singularity-images/rbioc/rbioc.job
```
