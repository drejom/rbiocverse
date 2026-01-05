#!/bin/bash
# keyring-setup.sh - Initialize gnome-keyring for VS Code token persistence
# See: https://github.com/drejom/vscode-rbioc/issues/17
#
# This script starts D-Bus and gnome-keyring-daemon, then execs the provided command.
# Designed to wrap `code serve-web` inside Singularity containers.
#
# Usage (standalone):
#   ./keyring-setup.sh code serve-web --host 0.0.0.0 --port 8080
#
# Usage (inside Singularity):
#   singularity exec container.sif /path/to/keyring-setup.sh code serve-web ...
#
# The keyring password is fixed but provides sufficient security because:
# 1. Keyring files in ~/.local/share/keyrings/ are protected by Unix permissions
# 2. Only the user (and root) can read their keyring
# 3. The password prevents accidental exposure if files are copied

set -euo pipefail

# Password for unlocking the keyring (fixed for automation)
# Security model relies on Unix file permissions, not this password
KEYRING_PASSWORD="${KEYRING_PASSWORD:-hpc-code-server}"

# Ensure keyring directory exists
mkdir -p "${HOME}/.local/share/keyrings"

# Start a private D-Bus session if not already running
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    eval "$(dbus-launch --sh-syntax)"
    export DBUS_SESSION_BUS_ADDRESS
    echo "Started D-Bus session: ${DBUS_SESSION_BUS_ADDRESS}" >&2
fi

# Unlock (or create) the default keyring
# gnome-keyring-daemon outputs GNOME_KEYRING_CONTROL=path on stdout
eval "$(echo -n "${KEYRING_PASSWORD}" | gnome-keyring-daemon --unlock --components=secrets)"
export GNOME_KEYRING_CONTROL

echo "Keyring initialized. VS Code tokens will persist across sessions." >&2

# If arguments provided, exec them (wrapper mode)
# Otherwise, just setup the environment (source mode)
if [ $# -gt 0 ]; then
    exec "$@"
fi
