# JupyterLab configuration for HPC environment
# See: https://github.com/drejom/vscode-rbioc/issues/15
#
# This configuration is designed for running JupyterLab behind an
# authentication proxy (HPC Code Server Manager).

c = get_config()  # noqa: F821

# Server settings
c.ServerApp.root_dir = '/home'
c.ServerApp.open_browser = False
c.ServerApp.ip = '0.0.0.0'

# Disable authentication (handled by HPC proxy)
c.ServerApp.token = ''
c.ServerApp.password = ''
c.ServerApp.allow_remote_access = True
c.ServerApp.disable_check_xsrf = True

# Allow root access (for container environments)
c.ServerApp.allow_root = True

# Notebook settings
c.ServerApp.notebook_dir = '/home'
