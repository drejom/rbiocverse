/**
 * AppFooter - Shows version and GitHub link
 * Fixed to bottom-right of viewport
 */
import { Github } from 'lucide-react';

function AppFooter() {
  return (
    <div className="app-footer">
      <a
        href={__REPO_URL__}
        target="_blank"
        rel="noopener noreferrer"
        title={`View source on GitHub (v${__APP_VERSION__})`}
      >
        <Github size={14} />
        <span>v{__APP_VERSION__}</span>
      </a>
    </div>
  );
}

export default AppFooter;
