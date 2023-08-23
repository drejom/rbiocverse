ARG VARIANT="RELEASE_3_17"
ARG HUB_VERSION=4.0.2

FROM bioconductor/bioconductor_docker:${VARIANT} 
ENV HUB_VERSION=$HUB_VERSION

ENV JUPYTER_PORT=8888
EXPOSE $JUPYTER_PORT

RUN pip3 install \
    jupyterhub==$HUB_VERSION \
    jupyterlab \
    notebook

# create a user, since we don't want to run as root
RUN useradd -m jovyan
ENV HOME=/home/jovyan
WORKDIR $HOME
USER jovyan

CMD ["jupyterhub-singleuser"]
