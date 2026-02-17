/**
 * Bioconductor release selector component
 * Apple-like design with logo and dropdown
 */

import { useTheme } from '../contexts/ThemeContext';

export function ReleaseSelector({ releases, selectedVersion, onSelect, cluster }) {
  const { theme } = useTheme();

  // Filter releases available for this cluster
  const clusterReleases = Object.entries(releases).filter(
    ([, info]) => info.clusters?.includes(cluster)
  );

  // Use theme-appropriate logo
  const logoSrc = theme === 'light'
    ? '/images/bioconductor-logo-light.svg'
    : '/images/bioconductor-logo-dark.svg';

  return (
    <div className="release-selector">
      <div className="release-brand">
        <img
          src={logoSrc}
          alt="Bioconductor"
          className="bioc-logo"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
        <span className="release-label">Bioconductor</span>
      </div>
      <select
        className="release-dropdown"
        value={selectedVersion || ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {clusterReleases.map(([version]) => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
    </div>
  );
}

export default ReleaseSelector;
