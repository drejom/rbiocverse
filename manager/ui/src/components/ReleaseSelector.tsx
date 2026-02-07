/**
 * Bioconductor release selector component
 * Apple-like design with logo and dropdown
 */

import { useTheme } from '../contexts/ThemeContext';
import { SyntheticEvent } from 'react';

interface ReleaseInfo {
  clusters?: string[];
  name?: string;
}

interface ReleaseSelectorProps {
  releases: Record<string, ReleaseInfo>;
  selectedVersion: string | null;
  onSelect: (version: string) => void;
  cluster: string;
}

export function ReleaseSelector({ releases, selectedVersion, onSelect, cluster }: ReleaseSelectorProps) {
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
          onError={(e: SyntheticEvent<HTMLImageElement>) => { (e.target as HTMLImageElement).style.display = 'none'; }}
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
