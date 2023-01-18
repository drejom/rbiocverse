# Set ARG defaults
ARG VARIANT="RELEASE_3_16"

FROM bioconductor/bioconductor_docker:${VARIANT}

### Install vscode stuff
# [Option] Install zsh
ARG INSTALL_ZSH="true"
# [Option] Upgrade OS packages to their latest versions
ARG UPGRADE_PACKAGES="false"

# Install needed packages and setup non-root user. Use a separate RUN statement to add your own dependencies.
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
    && rm -rf /tmp/downloaded_packages

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
# monocle3: libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev
# ctrdata: libjq-dev, php, php-xm, php-json
# bedr: bedtools bedops
# genomics: bcftools vcftools samtools tabix picard-tools libvcflib-tools libvcflib-dev freebayes   
# oh-my-bash: fonts-powerline
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    xsel ripgrep \
    libzmq3-dev \
    libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev \
    libjq-dev php php-xml php-json \
    fonts-powerline \
    bedtools bedops \
    bcftools vcftools samtools tabix picard-tools libvcflib-tools libvcflib-dev freebayes \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts 

### Instally Python packages
# radian, DNAnexus DX toolkit
RUN pip3 install --no-cache-dir \
    dxpy radian \
    && rm -rf /tmp/downloaded_packages

### Install other software
# Install dxfuse
RUN wget https://github.com/dnanexus/dxfuse/releases/download/v0.23.2/dxfuse-linux -P /usr/local/bin/ \
    && mv /usr/local/bin/dxfuse-linux /usr/local/bin/dxfuse \
    && chmod +x /usr/local/bin/dxfuse

# # Install SLURM
# RUN apt-get update \
#     && export DEBIAN_FRONTEND=noninteractive \
#     && apt-get -y install --no-install-recommends \
#     slurm-wlm libmunge-dev libmunge2 munge \
#     && apt-get autoremove -y && apt-get clean -y \
#     && rm -rf /var/lib/apt/lists/* /tmp/library-scripts 

### SLURM FROM WITHIN THE CONTAINER VIA SSH
# https://github.com/gearslaboratory/gears-singularity/blob/master/singularity-definitions/general_use/Singularity.gears-general
# https://groups.google.com/a/lbl.gov/g/singularity/c/syLcsIWWzdo/m/NZvF2Ud2AAAJ
RUN echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sacct $@' >> /usr/local/bin/sacct && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sacctmgr $@' >> /usr/local/bin/sacctmgr && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME salloc $@' >> /usr/local/bin/salloc && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sattach $@' >> /usr/local/bin/sattach && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sbatch $@' >> /usr/local/bin/sbatch && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sbcast $@' >> /usr/local/bin/sbcast && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME scancel $@' >> /usr/local/bin/scancel && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME scontrol $@' >> /usr/local/bin/scontrol && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sdiag $@' >> /usr/local/bin/sdiag && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sgather $@' >> /usr/local/bin/sgather && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sinfo $@' >> /usr/local/bin/sinfo && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME smap $@' >> /usr/local/bin/smap && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sprio $@' >> /usr/local/bin/sprio && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME squeue $@' >> /usr/local/bin/squeue && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sreport $@' >> /usr/local/bin/sreport && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME srun $@' >> /usr/local/bin/srun && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sshare $@' >> /usr/local/bin/sshare && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sstat $@' >> /usr/local/bin/sstat && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME strigger $@' >> /usr/local/bin/strigger && \
    echo '#!/bin/bash \n\
ssh $USER@$HOSTNAME sview $@' >> /usr/local/bin/sview && \
    cd /usr/local/bin && \
        chmod 755 sacct salloc sbatch scancel sdiag sinfo sprio sreport sshare strigger sacctmgr sattach sbcast scontrol sgather smap squeue srun sstat sview    


# Init command for s6-overlay
CMD ["/init"]
