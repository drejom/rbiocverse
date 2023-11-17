# Set ARG defaults
ARG VARIANT=RELEASE_3_18

FROM --platform=linux/amd64 bioconductor/bioconductor_docker:${VARIANT} 

### Install vscode stuff
# [Option] Install zsh
ARG INSTALL_ZSH=FALSE
# [Option] Upgrade OS packages to their latest versions
ARG UPGRADE_PACKAGES="true"

# Install needed packages and setup non-root user. Use a separate RUN statement to add your own dependencies.
ARG USERNAME=rstudio
ARG USER_UID=1000
ARG USER_GID=$USER_UID
USER root
ADD assets/common-debian.sh /tmp/
ENV SHELL=/bin/bash 

RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && /bin/bash /tmp/common-debian.sh "${INSTALL_ZSH}" "${USERNAME}" "${USER_UID}" "${USER_GID}" "${UPGRADE_PACKAGES}" "true" "true" \
    && usermod -a -G staff ${USERNAME} \
    && apt-get update && apt-get -y install \
    libgit2-dev \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    libxt-dev \
    libfontconfig1-dev \
    libcairo2-dev \
    squashfs-tools \
    gdal-bin \
    pandoc \
    pandoc-citeproc \
    && rm -rf /tmp/downloaded_packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# # VSCode R Debugger dependency. Install the latest release version from GitHub without using GitHub API.
# # See https://github.com/microsoft/vscode-dev-containers/issues/1032
# RUN export TAG=$(git ls-remote --tags --refs --sort='version:refname' https://github.com/ManuelHentschel/vscDebugger v\* | tail -n 1 | cut --delimiter='/' --fields=3) \
#     && Rscript -e "remotes::install_git('https://github.com/ManuelHentschel/vscDebugger.git', ref = '"${TAG}"', dependencies = FALSE)"

# R Session watcher settings.
# See more details: https://github.com/REditorSupport/vscode-R/wiki/R-Session-watcher
RUN echo 'if (interactive() && Sys.getenv("TERM_PROGRAM") == "vscode") source(file.path(Sys.getenv("HOME"), ".vscode-R", "init.R"))' >>"${R_HOME}/etc/Rprofile.site"

### Install additional OS packages 
# Seurat v5: libhdf5-dev
# fnmate and datapasta: ripgrep xsel
# vscode jupyter: libzmq3-dev
# jupyter-minimal-notebook: run-one texlive-xetex texlive-fonts-recommended texlive-plain-generic xclip 
# jupyter-scikit-learn: build-essential cm-super dvipng ffmpeg
# monocle3: libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev
# ctrdata: libjq-dev, php, php-xm, php-json
# bedr: bedtools bedops
# genomics: bcftools vcftools samtools tabix picard-tools freebayes   
# reticulate: python3-venv python3-dev
# proffer: golang-go
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    libhdf5-dev libxml-libxml-perl \
    xsel ripgrep \
    run-one texlive-xetex texlive-fonts-recommended texlive-plain-generic xclip \
    libzmq3-dev build-essential cm-super dvipng ffmpeg \
    libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev \
    libjq-dev php php-xml php-json \
    fonts-powerline \
    bedtools bedops \
    bcftools vcftools samtools tabix picard-tools freebayes \
    python3-venv python3-dev \
    golang-go \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts 

### Install miniconda
RUN wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh \
    && bash miniconda.sh -b -u -p /usr/local/bin \
    && rm -rf miniconda.sh

### Install Python packages
# radian, DNAnexus DX toolkit, jupyterlab
RUN pip3 install --no-cache-dir \
    dxpy radian \
    nodejs npm \
    jupyterlab 

### Install other software
# Install dxfuse
RUN wget https://github.com/dnanexus/dxfuse/releases/download/v0.23.2/dxfuse-linux -P /usr/local/bin/ \
    && mv /usr/local/bin/dxfuse-linux /usr/local/bin/dxfuse \
    && chmod +x /usr/local/bin/dxfuse

# Install sra-tools
RUN wget https://ftp-trace.ncbi.nlm.nih.gov/sra/sdk/current/sratoolkit.current-ubuntu64.tar.gz  \
    && tar -xzf sratoolkit.current-ubuntu64.tar.gz -C /usr/local --strip-components=1 \
    && rm sratoolkit.current-ubuntu64.tar.gz

# Install FiraCode (no starship for now)
RUN latest_url=$(curl -s https://api.github.com/repos/ryanoasis/nerd-fonts/releases/latest | grep "browser_download_url" | grep "FiraCode.zip" | cut -d '"' -f 4) \
    && curl -L -o FiraCode.zip $latest_url \
    && unzip FiraCode.zip -d /usr/share/fonts \
    && fc-cache -fv \
    && rm FiraCode.zip 
    # && curl -sS https://starship.rs/install.sh | sh -s -- --yes \
    # && echo 'eval "$(starship init bash)"' >> /etc/profile

### SLURM FROM WITHIN THE CONTAINER VIA SSH
# https://github.com/gearslaboratory/gears-singularity/blob/master/singularity-definitions/general_use/Singularity.gears-general
# https://groups.google.com/a/lbl.gov/g/singularity/c/syLcsIWWzdo/m/NZvF2Ud2AAAJ
RUN echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sacct $@' >> /usr/local/bin/sacct && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sacctmgr $@' >> /usr/local/bin/sacctmgr && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) salloc $@' >> /usr/local/bin/salloc && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sattach $@' >> /usr/local/bin/sattach && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sbatch $@' >> /usr/local/bin/sbatch && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sbcast $@' >> /usr/local/bin/sbcast && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) scancel $@' >> /usr/local/bin/scancel && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) scontrol $@' >> /usr/local/bin/scontrol && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sdiag $@' >> /usr/local/bin/sdiag && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sgather $@' >> /usr/local/bin/sgather && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sinfo $@' >> /usr/local/bin/sinfo && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) smap $@' >> /usr/local/bin/smap && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sprio $@' >> /usr/local/bin/sprio && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) squeue $@' >> /usr/local/bin/squeue && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sreport $@' >> /usr/local/bin/sreport && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) srun $@' >> /usr/local/bin/srun && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sshare $@' >> /usr/local/bin/sshare && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sstat $@' >> /usr/local/bin/sstat && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) strigger $@' >> /usr/local/bin/strigger && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) sview $@' >> /usr/local/bin/sview && \
    echo '#!/bin/bash \n\
ssh $(whoami)@$(hostname) strigger $@' >> /usr/local/bin/seff && \
    cd /usr/local/bin && \
    chmod 755 sacct salloc sbatch scancel sdiag sinfo sprio sreport sshare strigger sacctmgr sattach sbcast scontrol sgather smap squeue srun sstat sview seff   

# Init command for s6-overlay
CMD [ "/init" ]
