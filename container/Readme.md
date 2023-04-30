# Bioconductor on Apollo

This repository provides a Dockerfile that extends the official [Bioconductor Docker](https://bioconductor.org/help/docker/) image by adding some packages including the HPC job scheduler SLURM. GitHub actions build the image and push it to GitHub Packages.

## Additionally supported packages
[Bioconductor Docker](https://bioconductor.org/help/docker/) containers are based on [Rocker](https://rocker-project.org/) project images, which provide RStudio Server, a full featured IDE via a web browser. To the Rocker project's images, the Bioconductor developers add all the system dependencies required to support Bioconductor R libraries. We extend the container further by adding: 

- System dependencies to support `bedr`, `ctrdata`, `monocle3`, `fnmate` and `datapasta`
- genomics tools like `bcftools` and `bedops`
- DNANexus support (DX toolkit, dxfuse)
- SLURM
- Jupyter Lab & VSCode
- LiveShare, R devcontainer [dependencies](https://github.com/microsoft/vscode-dev-containers/blob/main/containers/r/.devcontainer/devcontainer.json)

## Bioconductor version **3.17**

Build the container for the HPC:

```sh
module load singularity
singularity pull -F /opt/singularity-images/rbioc/vscode-rbioc_3.17.sif docker://ghcr.io/drejom/vscode-rbioc:latest
```
And launch on the HPC:

```sh
sbatch /opt/singularity-images/rbioc/rbioc317.job
```
## Bioconductor version **3.16**

Build the container for the HPC:

```sh
module load singularity
singularity pull -F /opt/singularity-images/rbioc/vscode-rbioc_3.16.sif docker://ghcr.io/drejom/vscode-rbioc:latest
```

And launch on the HPC:

```sh
sbatch /opt/singularity-images/rbioc/rbioc316.job
```

## Bioconductor version **3.15**

Build the container for the HPC:

```sh
module load singularity
singularity pull -F /opt/singularity-images/rbioc/vscode-rbioc_3.15.sif docker://ghcr.io/drejom/vscode-rbioc:v2022-10-14
```

And launch on the HPC:

```sh
sbatch /opt/singularity-images/rbioc/rbioc.job
```

# Docker

Build the Docker container locally:

```sh
docker build . -t ghcr.io/drejom/vscode-rbioc:latest
```

Get a shell locally:

```sh
docker run -it --user $(id -u):$(id -g) ghcr.io/drejom/vscode-rbioc:latest /bin/bash
```