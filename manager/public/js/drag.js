/**
 * HPC Menu Drag Handler
 * Allows dragging the floating menu iframe within the parent window
 */

(function() {
  function initDrag() {
    const frame = document.getElementById('hpc-menu-frame');
    if (!frame) {
      setTimeout(initDrag, 100);
      return;
    }

    window.addEventListener('message', function(e) {
      if (!e.data) return;

      if (e.data.type === 'hpc-menu-drag') {
        const rect = frame.getBoundingClientRect();
        let newTop = rect.top + e.data.dy;
        let newRight = (window.innerWidth - rect.right) - e.data.dx;

        newTop = Math.max(0, Math.min(window.innerHeight - 60, newTop));
        newRight = Math.max(0, Math.min(window.innerWidth - 60, newRight));

        frame.style.top = newTop + 'px';
        frame.style.right = newRight + 'px';
      }

      if (e.data.type === 'hpc-menu-navigate') {
        window.location.href = e.data.url;
      }
    });
  }
  initDrag();
})();
