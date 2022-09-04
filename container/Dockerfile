# Set ARG defaults
ARG VARIANT="RELEASE_3_15"

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
COPY assets/*.sh /tmp/
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
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/* /tmp/library-scripts \
    && python3 -m pip --no-cache-dir install radian \
    && install2.r --error --skipinstalled --ncpus -1 \
    devtools \
    languageserver \
    httpgd \
    && rm -rf /tmp/downloaded_packages

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
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    xsel ripgrep \
    libzmq3-dev \
    libmysqlclient-dev default-libmysqlclient-dev libudunits2-dev libgdal-dev libgeos-dev libproj-dev \
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

# VSCode live share dependencies. 
# See https://docs.microsoft.com/en-us/visualstudio/liveshare/reference/linux#install-linux-prerequisites
RUN wget -O ~/vsls-reqs https://aka.ms/vsls-linux-prereq-script \
    && chmod +x ~/vsls-reqs \
    && ~/vsls-reqs \
    && rm ~/vsls-reqs 

# Install SLURM
ADD assets/slurm-21.08.7.tar.bz2 /tmp/slurm

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    libmunge-dev libmunge2 munge libtool m4 automake \
    && apt-get autoremove -y && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/* /tmp/library-scripts \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3 1 \
    && cd /tmp/slurm/slurm-21.08.7 \
    && ./configure --prefix=/usr/local --sysconfdir=/etc/slurm && make -j2 && make install \
    && rm -rf /tmp/slurm/slurm-21.08.7 \
    && useradd slurm \
    && mkdir -p /etc/slurm \
    /var/spool/slurm/ctld \
    /var/spool/slurm/d \
    /var/log/slurm \
    && chown slurm /var/spool/slurm/ctld /var/spool/slurm/d /var/log/slurm

RUN rm -rf /tmp/slurm/slurm*

# Init command for s6-overlay
CMD ["/init"]
