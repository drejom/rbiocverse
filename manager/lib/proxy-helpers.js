/**
 * Proxy helper functions for VS Code and Jupyter authentication
 * Extracted for testability
 */

/**
 * Extract token value from vscode-tkn cookie
 * @param {string} cookieHeader - Cookie header string
 * @returns {string|null} Token value or null
 */
function getCookieToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/vscode-tkn=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Check if a path is the VS Code root path (for token injection)
 * Handles query strings and trailing slashes robustly
 * @param {string} targetPath - The path to check
 * @returns {boolean} True if this is the root path
 */
function isVscodeRootPath(targetPath) {
  const pathname = new URL(targetPath, 'http://localhost').pathname.replace(/\/$/, '');
  return pathname === '/vscode-direct';
}

module.exports = {
  getCookieToken,
  isVscodeRootPath,
};
