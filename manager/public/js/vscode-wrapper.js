/**
 * VS Code Wrapper - Cache clearing and iframe management
 */

// Clear all cached content and storage before loading VS Code
// This fixes Safari normal mode caching issues (works in private mode because it starts fresh)
(async function() {
  try {
    // Clear localStorage and sessionStorage (Safari aggressive caching fix)
    try {
      localStorage.clear();
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
})();

// Handle navigation messages from menu frame
window.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'hpc-menu-navigate') {
    window.location.href = e.data.url;
  }
  if (e.data.type === 'hpc-menu-drag') {
    const frame = document.getElementById('hpc-menu-frame');
    const rect = frame.getBoundingClientRect();
    let newTop = rect.top + e.data.dy;
    let newRight = (window.innerWidth - rect.right) - e.data.dx;
    newTop = Math.max(0, Math.min(window.innerHeight - 60, newTop));
    newRight = Math.max(0, Math.min(window.innerWidth - 60, newRight));
    frame.style.top = newTop + 'px';
    frame.style.right = newRight + 'px';
  }
});
