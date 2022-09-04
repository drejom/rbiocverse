# Bioconductor on Apollo

This repository provides a `Dockerfile` that extends the official [Bioconductor Docker](https://bioconductor.org/help/docker/) image by adding a few system packages and the HPC job scheduler SLURM. GitHub actions build the image and push it to GitHub Packages.

## Additionally supported packages
Bioconductor Docker containers are based on the Rocker project images, which provide RStudio Server, a full featured RStudio session via a webbrowser. To the Rocker project's images, the Bioconductor maintainers add all the system dependencies that are required to support Bioconductor R libraries. To this, we extend the container further to support: 

- System dependencies to support `fnmate` and `datapasta`
- System dependencies to support `monocle3`
- Quarto cli support
- DNANexus support (DX toolkit, dxfuse)
- SLURM

## Bioconductor version **3.14**

Build the container for the HPC with:

```
 module load singualrity   
 singularity pull rstudio-rbioc.img docker://ghcr.io/drejom/rstudio-rbioc:main
```

And launched on the HPC by:
```
sbatch /opt/singularity-images/rbioc/rstudio.job
```
