/**
 * Shared menu frame message handler
 * Used by vscode-wrapper and rstudio-wrapper to handle floating menu events
 */

function initMenuHandler(menuFrameId) {
  const menuFrame = document.getElementById(menuFrameId || 'hpc-menu-frame');
  if (!menuFrame) return;

  // Track position in JS to avoid getBoundingClientRect() on every drag (causes lag)
  // Read initial position from computed styles to avoid coupling with CSS
  const computedStyle = window.getComputedStyle(menuFrame);
  let posTop = parseFloat(computedStyle.top);
  let posRight = parseFloat(computedStyle.right);

  window.addEventListener('message', function(e) {
    // Security: validate message origin
    if (e.origin !== window.location.origin) return;
    if (!e.data) return;

    // Handle navigation
    if (e.data.type === 'hpc-menu-navigate') {
      window.location.href = e.data.url;
    }

    // Handle drag events (uses dx/dy deltas)
    // Avoid getBoundingClientRect() - it forces reflow and causes lag
    if (e.data.type === 'hpc-menu-drag') {
      posTop += e.data.dy;
      posRight -= e.data.dx;
      // Clamp to viewport bounds
      posTop = Math.max(0, Math.min(window.innerHeight - 60, posTop));
      posRight = Math.max(0, Math.min(window.innerWidth - 60, posRight));
      menuFrame.style.top = posTop + 'px';
      menuFrame.style.right = posRight + 'px';
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
