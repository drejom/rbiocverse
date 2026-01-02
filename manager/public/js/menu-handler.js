/**
 * Shared menu frame message handler
 * Used by vscode-wrapper and rstudio-wrapper to handle floating menu events
 */

function initMenuHandler(menuFrameId) {
  const menuFrame = document.getElementById(menuFrameId || 'hpc-menu-frame');
  if (!menuFrame) return;

  window.addEventListener('message', function(e) {
    // Security: validate message origin
    if (e.origin !== window.location.origin) return;
    if (!e.data) return;

    // Handle navigation
    if (e.data.type === 'hpc-menu-navigate') {
      window.location.href = e.data.url;
    }

    // Handle drag events (uses dx/dy deltas)
    if (e.data.type === 'hpc-menu-drag') {
      const rect = menuFrame.getBoundingClientRect();
      let newTop = rect.top + e.data.dy;
      let newRight = (window.innerWidth - rect.right) - e.data.dx;
      // Clamp to viewport bounds
      newTop = Math.max(0, Math.min(window.innerHeight - 60, newTop));
      newRight = Math.max(0, Math.min(window.innerWidth - 60, newRight));
      menuFrame.style.top = newTop + 'px';
      menuFrame.style.right = newRight + 'px';
    }

    // Handle expand/collapse for dynamic sizing
    if (e.data.type === 'hpc-menu-expand') {
      menuFrame.classList.add('expanded');
    }
    if (e.data.type === 'hpc-menu-collapse') {
      menuFrame.classList.remove('expanded');
    }
  });
}
