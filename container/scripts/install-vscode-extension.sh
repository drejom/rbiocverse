#!/bin/bash
# Download and install VS Code extension from marketplace
# Usage: install-vscode-extension.sh <publisher.extension> <extensions_dir>
#
# This script downloads extensions directly from the VS Code Marketplace,
# which is necessary because the standalone VS Code CLI cannot install
# extensions without a full VS Code installation.

set -euo pipefail

EXTENSION_ID="${1:?Usage: $0 <publisher.extension> <extensions_dir>}"
EXTENSIONS_DIR="${2:?Usage: $0 <publisher.extension> <extensions_dir>}"

# Parse publisher and extension name
PUBLISHER="${EXTENSION_ID%%.*}"
EXTENSION_NAME="${EXTENSION_ID#*.}"

echo "Installing VS Code extension: ${EXTENSION_ID}"

# Create extensions directory if it doesn't exist
mkdir -p "${EXTENSIONS_DIR}"

# Create temp directory for download
TEMP_DIR=$(mktemp -d)
trap "rm -rf ${TEMP_DIR}" EXIT

# Download extension from VS Code Marketplace
# The marketplace API endpoint for downloading extensions
VSIX_URL="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${PUBLISHER}/vsextensions/${EXTENSION_NAME}/latest/vspackage"

echo "  Downloading from marketplace..."
curl -fsSL "${VSIX_URL}" -o "${TEMP_DIR}/extension.vsix.gz"

# The marketplace returns gzip-compressed VSIX files
# Decompress first, then extract (VSIX is a ZIP file)
echo "  Extracting extension..."
cd "${TEMP_DIR}"
gunzip -f extension.vsix.gz
unzip -q extension.vsix

# Get the actual version from package.json in the extracted extension
if [[ -f "extension/package.json" ]]; then
    VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' extension/package.json | head -1 | cut -d'"' -f4)
else
    VERSION="latest"
fi

# Create the extension directory with the correct naming convention
# VS Code expects: <publisher>.<name>-<version>
EXTENSION_DEST="${EXTENSIONS_DIR}/${PUBLISHER}.${EXTENSION_NAME}-${VERSION}"

echo "  Installing to ${EXTENSION_DEST}"
mkdir -p "${EXTENSION_DEST}"
cp -r extension/* "${EXTENSION_DEST}/"

echo "  Done: ${EXTENSION_ID} v${VERSION}"
