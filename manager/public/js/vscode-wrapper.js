/**
 * VS Code Wrapper - Cache clearing and iframe management
 */

// Clear all cached content and storage before loading VS Code
// This fixes Safari normal mode caching issues (works in private mode because it starts fresh)
(async function() {
  try {
    // Clear sessionStorage (Safari aggressive caching fix)
    // Note: DO NOT clear localStorage - it contains VS Code's encrypted secrets (secrets.provider)
    // which are needed for persistent GitHub/Copilot authentication across page reloads
    try {
      sessionStorage.clear();
    } catch(e) { console.log('Storage clear:', e); }

    // Clear service workers
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
    }

    // Clear caches
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch(e) { console.log('Cache clear:', e); }

  // Now load VS Code with cache-busting timestamp
  document.getElementById('loading').style.display = 'none';
  const frame = document.getElementById('vscode-frame');
  frame.style.display = 'block';
  frame.src = '/vscode-direct/?t=' + Date.now();

  // Initialize shared menu handler
  initMenuHandler('hpc-menu-frame');
})();
