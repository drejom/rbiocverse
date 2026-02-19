/**
 * ExportButton - Download CSV exports
 */
import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import log from '../../lib/logger';

interface ExportButtonProps {
  type?: 'raw' | 'summary';
  days?: number;
  getAuthHeader: () => Record<string, string>;
}

export function ExportButton({ type = 'raw', days = 30, getAuthHeader }: ExportButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const endpoint = type === 'raw'
        ? `/api/admin/analytics/export/raw?days=${days}`
        : `/api/admin/analytics/export/summary?days=${days}`;

      const res = await fetch(endpoint, { headers: getAuthHeader() });
      const blob = await res.blob();

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sessions-${type}-${days}d.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      log.error('Export failed', { error: err });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className="export-btn"
      onClick={handleExport}
      disabled={loading}
      title={`Export ${type} data as CSV`}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Download size={14} />
      )}
      <span>{type === 'raw' ? 'Raw CSV' : 'Summary CSV'}</span>
    </button>
  );
}
