/**
 * Proxy helper functions for VS Code and Jupyter authentication
 * Extracted for testability
 */

/**
 * Extract token value from vscode-tkn cookie
 * @param cookieHeader - Cookie header string
 * @returns Token value or null
 */
export function getCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/vscode-tkn=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Check if a path is the VS Code root path (for token injection)
 * Handles query strings and trailing slashes robustly
 * @param targetPath - The path to check
 * @returns True if this is the root path
 */
export function isVscodeRootPath(targetPath: string): boolean {
  const pathname = new URL(targetPath, 'http://localhost').pathname.replace(/\/$/, '');
  return pathname === '/vscode-direct';
}

// CommonJS compatibility for existing require() calls
module.exports = {
  getCookieToken,
  isVscodeRootPath,
};
