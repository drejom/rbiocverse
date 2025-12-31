# R/Bioconductor Development Container
# Change BIOC_VERSION to update to a new Bioconductor release
ARG BIOC_VERSION=RELEASE_3_22

# Tool versions - pin for reproducibility
ARG DXFUSE_VERSION=0.23.2
ARG SRATOOLKIT_VERSION=3.1.1
ARG VSCODE_CLI_BUILD=stable

FROM --platform=linux/amd64 bioconductor/bioconductor_docker:${BIOC_VERSION}

# Re-declare ARGs after FROM and export as ENV for runtime access
ARG BIOC_VERSION
ARG DXFUSE_VERSION
ARG SRATOOLKIT_VERSION
ENV BIOC_VERSION=${BIOC_VERSION}
ENV DXFUSE_VERSION=${DXFUSE_VERSION}
ENV SRATOOLKIT_VERSION=${SRATOOLKIT_VERSION}

USER root
ENV SHELL=/bin/bash
ENV DEBIAN_FRONTEND=noninteractive

# =============================================================================
# System Dependencies (single consolidated layer)
# =============================================================================
# Core dev tools: libgit2-dev libcurl4-openssl-dev libssl-dev libxml2-dev
# Graphics: libxt-dev libfontconfig1-dev libcairo2-dev libpng-dev
# Seurat v5: libhdf5-dev
# monocle3: libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev
#           libgdal-dev libgeos-dev libproj-dev
# velocyto.R: libboost-all-dev libomp-dev
# ctrdata: libjq-dev php php-xml php-json
# fnmate/datapasta: ripgrep xsel
# Jupyter: libzmq3-dev
# LaTeX: texlive-xetex texlive-fonts-recommended texlive-plain-generic
# Build tools: build-essential cm-super dvipng ffmpeg
# Utilities from issues: qpdf (#12), lftp (#11), git-filter-repo (#9)
# reticulate: python3-venv python3-dev
# proffer: golang-go
# b64: cargo
# bedr deps: bedtools bedops
# genomics: bcftools vcftools samtools tabix picard-tools
# NOTE: freebayes not available in Ubuntu Noble (24.04)

RUN apt-get update && apt-get -y install --no-install-recommends \
    # Core dev libraries
    libgit2-dev libcurl4-openssl-dev libssl-dev libxml2-dev libxt-dev \
    libfontconfig1-dev libcairo2-dev libpng-dev squashfs-tools \
    gdal-bin pandoc \
    # Seurat v5
    libhdf5-dev libxml-libxml-perl \
    # monocle3
    libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev \
    libgdal-dev libgeos-dev libproj-dev \
    # velocyto.R
    libboost-all-dev libomp-dev \
    # ctrdata
    libjq-dev php php-xml php-json \
    # fnmate/datapasta
    xsel ripgrep \
    # Jupyter/LaTeX
    libzmq3-dev run-one texlive-xetex texlive-fonts-recommended \
    texlive-plain-generic xclip \
    # Build tools
    build-essential cm-super dvipng ffmpeg \
    # Utilities (from issues #12, #11, #9)
    qpdf lftp git-filter-repo \
    # Fonts
    fonts-powerline \
    # Python
    python3-venv python3-dev \
    # proffer/b64
    golang-go cargo \
    # Genomics tools (bedr deps + general)
    bedtools bedops \
    bcftools vcftools samtools tabix picard-tools \
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Python Packages
# =============================================================================
# radian: Better R console
# dxpy: DNAnexus toolkit
# jupyterlab: Jupyter notebook server
# Seurat Python deps (#6): numpy scipy scikit-learn umap-learn leidenalg

RUN pip3 install --no-cache-dir \
    radian \
    dxpy \
    jupyterlab \
    numpy scipy scikit-learn umap-learn leidenalg

# =============================================================================
# External Tools (pinned versions for reproducibility)
# =============================================================================

# dxfuse - DNAnexus FUSE filesystem
# Pinned to specific version for reproducibility
RUN curl -fsSL "https://github.com/dnanexus/dxfuse/releases/download/v${DXFUSE_VERSION}/dxfuse-linux" -o /usr/local/bin/dxfuse \
    && chmod +x /usr/local/bin/dxfuse

# sra-tools - NCBI SRA toolkit (pinned version)
RUN curl -fsSL "https://ftp-trace.ncbi.nlm.nih.gov/sra/sdk/${SRATOOLKIT_VERSION}/sratoolkit.${SRATOOLKIT_VERSION}-ubuntu64.tar.gz" -o sratoolkit.tar.gz \
    && tar -xzf sratoolkit.tar.gz -C /usr/local --strip-components=1 \
    && rm sratoolkit.tar.gz

# VSCode CLI - for code serve-web and tunnels
RUN curl -fsSL "https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64" -o vscode_cli.tar.gz \
    && tar -xzf vscode_cli.tar.gz \
    && chmod +x code \
    && mv code /usr/local/bin/ \
    && rm vscode_cli.tar.gz

# =============================================================================
# SLURM Wrappers (SSH passthrough for HPC container usage)
# =============================================================================
COPY scripts/slurm-wrappers.sh /tmp/
RUN bash /tmp/slurm-wrappers.sh && rm /tmp/slurm-wrappers.sh

# =============================================================================
# R Configuration
# =============================================================================

# VSCode R session watcher
RUN echo 'if (interactive() && Sys.getenv("TERM_PROGRAM") == "vscode") source(file.path(Sys.getenv("HOME"), ".vscode-R", "init.R"))' >> "${R_HOME}/etc/Rprofile.site"

# renv cache directory (shared across projects)
RUN mkdir -p /opt/renv/cache && chmod 777 /opt/renv/cache
ENV RENV_PATHS_CACHE=/opt/renv/cache

# Configure renv to use Posit Package Manager for fast binary installs
# NOTE: Bioconductor 3.22 uses Ubuntu Noble (24.04)
ENV RENV_CONFIG_REPOS_OVERRIDE="https://packagemanager.posit.co/cran/__linux__/noble/latest"

# =============================================================================
# Finalize
# =============================================================================

# Copy metapackage and scripts for easy package installation
COPY rbiocverse/ /opt/rbiocverse/
COPY scripts/install.R /opt/rbiocverse/scripts/
COPY scripts/migrate-packages.R /opt/rbiocverse/scripts/

# Default user (matches Bioconductor base image)
USER rstudio
WORKDIR /home/rstudio

# Init command for s6-overlay (inherited from base)
CMD ["/init"]
