# Set ARG defaults
ARG VARIANT=RELEASE_3_17
FROM bioconductor/bioconductor_docker:${VARIANT}

ARG HUB_VERSION=4.0.6

FROM --platform=linux/amd64 bioconductor/bioconductor_docker:${VARIANT} 

### Install vscode stuff
# [Option] Install zsh
ARG INSTALL_ZSH=FALSE
# [Option] Upgrade OS packages to their latest versions
ARG UPGRADE_PACKAGES=FALSE
ARG USERNAME=rstudio
ARG USER_UID=automatic
ARG USER_GID=automatic
ARG NB_USER=jovyan
ARG NB_UID=1000
ARG NB_GID=100

USER root
ADD assets/common-debian.sh /tmp/

ENV CONDA_DIR=/opt/conda \
    MAMBA_ROOT_PREFIX=${CONDA_DIR} \
    PATH=${CONDA_DIR}/bin:${PATH} \
    SHELL=/bin/bash \
    NB_USER=${NB_USER} \
    NB_UID=${NB_UID} \
    NB_GID=${NB_GID} 

#&& /bin/bash /tmp/common-debian.sh ${INSTALL_ZSH} ${USERNAME} ${USER_UID} ${USER_GID} ${UPGRADE_PACKAGES} true true && \

# Install common dependencies
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && /bin/bash /tmp/common-debian.sh "${INSTALL_ZSH}" "${USERNAME}" "${USER_UID}" "${USER_GID}" "${UPGRADE_PACKAGES}" "true" "true" \
    && usermod -a -G staff ${USERNAME} \
    && apt-get -y install \
    libgit2-dev \
    libssl-dev \
    libxml2-dev \
    libxt-dev \
    libfontconfig1-dev \
    libcairo2-dev \
    squashfs-tools \
    gdal-bin \
    libcurl4-openssl-dev \
    pandoc \
    pandoc-citeproc \
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
    libxml-libxml-perl \
    xsel ripgrep \
    run-one texlive-xetex texlive-fonts-recommended texlive-plain-generic xclip \
    libzmq3-dev build-essential cm-super dvipng ffmpeg \
    libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev \
    libjq-dev php php-xml php-json \
    fonts-powerline \
    bedtools bedops \
    bcftools vcftools samtools tabix picard-tools libvcflib-tools libvcflib-dev freebayes \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts \
    && install2.r --error --skipinstalled --ncpus -1 \
    devtools \
    languageserver \
    httpgd \
    IRkernel \
    && rm -rf /tmp/common-debian.sh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# # Install VSCode
# RUN apt-get -y install gpg \
#     && wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg \
#     && install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg \
#     && sh -c 'echo "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list' \
#     && rm -f packages.microsoft.gpg \
#     && apt-get -y install apt-transport-https \
#     && apt-get update \
#     && apt-get -y install code \
#     && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts

# VSCode R Debugger dependency. Install the latest release version from GitHub without using GitHub API.
# See https://github.com/microsoft/vscode-dev-containers/issues/1032
RUN export TAG=$(git ls-remote --tags --refs --sort='version:refname' https://github.com/ManuelHentschel/vscDebugger v\* | tail -n 1 | cut --delimiter='/' --fields=3) \
    && Rscript -e "remotes::install_git('https://github.com/ManuelHentschel/vscDebugger.git', ref = '"${TAG}"', dependencies = FALSE)"

# R Session watcher settings.
# See more details: https://github.com/REditorSupport/vscode-R/wiki/R-Session-watcher
RUN echo 'if (interactive() && Sys.getenv("TERM_PROGRAM") == "vscode") source(file.path(Sys.getenv("HOME"), ".vscode-R", "init.R"))' >> "${R_HOME}/etc/Rprofile.site"

# Install micromamba
# RUN if [ "$(uname -m)" = "x86_64" ]; then \
#     curl -L -O https://micromamba.snakepit.net/api/micromamba/linux-64/latest; \
#     elif [ "$(uname -m)" = "aarch64" ]; then \
#     curl -L -O https://micromamba.snakepit.net/api/micromamba/linux-aarch64/latest; \
#     fi && \
#     mkdir -p /opt/conda && \
#     tar -xvjf latest -C /opt/conda && \
#     rm latest

# ## Install Python & conda-forge packages
# ADD assets/environment.yml /tmp/

# # Use mamba to update the base environment
# RUN /opt/conda/bin/micromamba shell init -s bash -p /opt/conda && \
#     echo "micromamba activate" >> ~/.bashrc && \
#     /bin/bash -c "source ~/.bashrc && micromamba install -y -n base -f /tmp/environment.yml" && \
#     rm /tmp/environment.yml

# # Set up the environment so that all users have access to the binaries
# RUN echo "export MAMBA_ROOT_PREFIX=/opt/conda" >> /etc/profile.d/micromamba.sh && \
#     echo ". /opt/conda/etc/profile.d/mamba.sh" >> /etc/profile.d/micromamba.sh && \
#   #  echo 'eval "$(starship init bash)"' >> /etc/profile.d/starship.sh && \
#     chmod +x /etc/profile.d/micromamba.sh


# radian, DNAnexus DX toolkit, jupyterlab
RUN pip3 install --no-cache-dir \
    dxpy radian \
    jupyterlab jupyterhub==${HUB_VERSION} jupyterlab-ai \
    nodejs npm \
    && rm -rf /tmp/downloaded_packages

# Install R packages
# COPY assets/packages.R /tmp/
# RUN Rscript /tmp/packages.R
RUN /usr/local/bin/R -e "IRkernel::installspec(user = FALSE)"

### Install other software
# Install dxfuse
RUN wget https://github.com/dnanexus/dxfuse/releases/latest/download/dxfuse-linux -P /usr/local/bin/ \
    && mv /usr/local/bin/dxfuse-linux /usr/local/bin/dxfuse \
    && chmod +x /usr/local/bin/dxfuse

# Install sra-tools
RUN wget https://ftp-trace.ncbi.nlm.nih.gov/sra/sdk/current/sratoolkit.current-ubuntu64.tar.gz && \
    tar -xzf sratoolkit.current-ubuntu64.tar.gz -C /usr/local --strip-components=1 && \
    rm sratoolkit.current-ubuntu64.tar.gz

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
