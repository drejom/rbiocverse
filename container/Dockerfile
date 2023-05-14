# Set ARG defaults
ARG VARIANT="RELEASE_3_17"

FROM bioconductor/bioconductor_docker:${VARIANT}

### Install vscode stuff
# [Option] Install zsh
ARG INSTALL_ZSH="true"
# [Option] Upgrade OS packages to their latest versions
ARG UPGRADE_PACKAGES="false"

# Install needed packages and setup non-root user. Use a separate RUN statement to add your own dependencies.
ARG CONDA_DIR=/opt/conda
ARG USERNAME=rstudio
ARG USER_UID=1000
ARG USER_GID=$USER_UID
USER root
ADD assets/common-debian.sh /tmp/
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && /bin/bash /tmp/common-debian.sh "${INSTALL_ZSH}" "${USERNAME}" "${USER_UID}" "${USER_GID}" "${UPGRADE_PACKAGES}" "true" "true" \
    && usermod -a -G staff ${USERNAME} \
    && apt-get -y install \
    python3-pip \
    libgit2-dev \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    libxt-dev \
    libfontconfig1-dev \
    libcairo2-dev \
    squashfs-tools \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts \
    && install2.r --error --skipinstalled --ncpus -1 \
    devtools \
    languageserver \
    httpgd \
    IRkernel \
    && rm -rf /tmp/downloaded_packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install VSCode
RUN apt-get -y install gpg \
    && wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg \
    && install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg \
    && sh -c 'echo "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list' \
    && rm -f packages.microsoft.gpg \
    && apt-get -y install apt-transport-https \
    && apt-get update \
    && apt-get -y install code \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts 

# VSCode R Debugger dependency. Install the latest release version from GitHub without using GitHub API.
# See https://github.com/microsoft/vscode-dev-containers/issues/1032
RUN export TAG=$(git ls-remote --tags --refs --sort='version:refname' https://github.com/ManuelHentschel/vscDebugger v\* | tail -n 1 | cut --delimiter='/' --fields=3) \
    && Rscript -e "remotes::install_git('https://github.com/ManuelHentschel/vscDebugger.git', ref = '"${TAG}"', dependencies = FALSE)"

# R Session watcher settings.
# See more details: https://github.com/REditorSupport/vscode-R/wiki/R-Session-watcher
RUN echo 'if (interactive() && Sys.getenv("TERM_PROGRAM") == "vscode") source(file.path(Sys.getenv("HOME"), ".vscode-R", "init.R"))' >>"${R_HOME}/etc/Rprofile.site"

### Install additional OS packages 
# fnmate and datapasta: ripgrep xsel
# vscode jupyter: libzmq3-dev
# jupyter-minimal-notebook: run-one texlive-xetex texlive-fonts-recommended texlive-plain-generic xclip 
# jupyter-scikit-learn: build-essential cm-super dvipng ffmpeg
# monocle3: libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev
# ctrdata: libjq-dev, php, php-xm, php-json
# bedr: bedtools bedops
# genomics: bcftools vcftools samtools tabix picard-tools libvcflib-tools libvcflib-dev freebayes   
# oh-my-bash: fonts-powerline
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    libxml-libxml-perl \
    xsel ripgrep \
    run-one texlive-xetex texlive-fonts-recommended texlive-plain-generic xclip \
    libzmq3-dev build-essential cm-super dvipng ffmpeg \
    libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev \
    libjq-dev php php-xml php-json \
    fonts-powerline \
    bedtools bedops \
    bcftools vcftools samtools tabix picard-tools libvcflib-tools libvcflib-dev freebayes \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts 

### Install Python packages
# radian, DNAnexus DX toolkit, jupyterlab
RUN pip3 install --no-cache-dir \
    dxpy radian \
    jupyter_core jupyterlab nodejs npm \
    && rm -rf /tmp/downloaded_packages

RUN /usr/local/bin/R -e "IRkernel::installspec(user = FALSE)"

### Install other software
# Install dxfuse
RUN wget https://github.com/dnanexus/dxfuse/releases/download/v0.23.2/dxfuse-linux -P /usr/local/bin/ \
    && mv /usr/local/bin/dxfuse-linux /usr/local/bin/dxfuse \
    && chmod +x /usr/local/bin/dxfuse

# Install mamba and sra-tools
RUN apt-get update && apt-get install -y wget bzip2 \
    && wget -qO- https://micromamba.snakepit.net/api/micromamba/linux-64/latest | tar -xvj bin/micromamba \
    && mv bin/micromamba /usr/local/bin/ \
    && /usr/local/bin/micromamba shell init -s bash -p /usr/local/bin \
    && mamba install -y sra-tool

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
    cd /usr/local/bin && \
        chmod 755 sacct salloc sbatch scancel sdiag sinfo sprio sreport sshare strigger sacctmgr sattach sbcast scontrol sgather smap squeue srun sstat sview    

# Init command for s6-overlay
CMD [ "/init" ]
