/**
 * AdminPanel - Slide-out admin panel (left side)
 * Provides user management, cluster status, and reports
 */

import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { LayoutDashboard, Server, Users, BarChart, Activity, LucideIcon } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import log from '../lib/logger';
import { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders } from './admin-widgets';
import ContentPanel from './ContentPanel';
import type { ClusterHealth, ClusterHistoryPoint } from '../types';

// Icon mapping for sections (LucideIcon only, no devicons)
const iconMap: Record<string, LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  server: Server,
  users: Users,
  'bar-chart': BarChart,
  activity: Activity,
};

const widgetModule = { widgetRegistry, parseWidgets, replaceWidgetsWithPlaceholders };

// Module-level constants — avoid new references on every render.
//
// contentEndpoint: in ContentPanel's content-loading useEffect dep array; an inline
// arrow function would cause the effect to re-run every 2s (poll cycle), reloading
// content and showing the spinner on each poll.
//
// linkPattern: a regex *literal* creates a new RegExp object each render, making
// handleLinkClick → BoundMarkdownContent unstable. BoundMarkdownContent is used as a
// JSX component type, so a new reference causes React to unmount+remount
// MarkdownContentMemo. That replaces the portal-target placeholder divs with fresh DOM
// nodes while WidgetPortals still holds stale mount-point references to the old
// (detached) nodes — widget content disappears and leaves empty border boxes.
const PURIFY_ADD_ATTR = ['target', 'data-widget-id', 'data-widget-name'];
const adminContentEndpoint = (id: string) => `/api/admin/content/${id}`;
const ADMIN_LINK_PATTERN = /^\/(?:api\/)?admin(?:\/content)?\/(.+)$/;

interface PartitionData {
  [cluster: string]: unknown;
}

interface AdminPanelProps {
  isOpen: boolean;
  onClose: () => void;
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
}

function AdminPanel({ isOpen, onClose, health, history }: AdminPanelProps) {
  const [partitions, setPartitions] = useState<PartitionData>({});
  const [isRefreshingPartitions, setIsRefreshingPartitions] = useState(false);
  const [isScanningHostKeys, setIsScanningHostKeys] = useState(false);
  const [hostKeyScanResult, setHostKeyScanResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { getAuthHeader } = useAuth();

  // Fetch partition data
  const fetchPartitions = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/partitions', {
        headers: getAuthHeader(),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch partitions: ${res.status}`);
      }
      const data = await res.json();
      setPartitions(data.partitions || {});
    } catch (err) {
      log.error('Failed to fetch partitions', { error: err });
    }
  }, [getAuthHeader]);

  // Refresh partitions (admin action)
  const handleRefreshPartitions = useCallback(async () => {
    setIsRefreshingPartitions(true);
    try {
      const res = await fetch('/api/admin/partitions/refresh', {
        method: 'POST',
        headers: getAuthHeader(),
      });
      const data = await res.json();
      setPartitions(data.partitions || {});
    } catch (err) {
      log.error('Failed to refresh partitions', { error: err });
    } finally {
      setIsRefreshingPartitions(false);
    }
  }, [getAuthHeader]);

  const handleScanHostKeys = useCallback(async () => {
    setIsScanningHostKeys(true);
    setHostKeyScanResult(null);
    try {
      const res = await fetch('/api/admin/ssh/scan-hosts', {
        method: 'POST',
        headers: getAuthHeader(),
      });
      const data = await res.json() as { keyLines?: number; hosts?: string[]; error?: string };
      if (!res.ok) {
        setHostKeyScanResult({ ok: false, message: data.error ?? 'Scan failed' });
      } else {
        setHostKeyScanResult({
          ok: true,
          message: `Enrolled ${data.keyLines ?? 0} key lines for ${(data.hosts ?? []).join(', ')}`,
        });
      }
    } catch (err) {
      setHostKeyScanResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setIsScanningHostKeys(false);
    }
  }, [getAuthHeader]);

  // Fetch partitions when panel opens
  useEffect(() => {
    if (isOpen) {
      fetchPartitions();
    }
  }, [isOpen, fetchPartitions]);

  const extraWidgetProps = useMemo(() => ({
    partitions,
    onRefreshPartitions: handleRefreshPartitions,
    isRefreshing: isRefreshingPartitions,
    onScanHostKeys: handleScanHostKeys,
    isScanningHostKeys,
    hostKeyScanResult,
    getAuthHeader,
  }), [partitions, handleRefreshPartitions, isRefreshingPartitions, handleScanHostKeys, isScanningHostKeys, hostKeyScanResult, getAuthHeader]);

  return (
    <ContentPanel
      panelClass="admin-panel"
      navClassPrefix="admin"
      headerIcon={<LayoutDashboard size={20} style={{ marginRight: 8 }} />}
      title="Admin Panel"
      isOpen={isOpen}
      onClose={onClose}
      health={health}
      history={history}
      menuEndpoint="/api/admin/index"
      contentEndpoint={adminContentEndpoint}
      searchEndpoint="/api/admin/search"
      defaultSection="overview"
      linkPattern={ADMIN_LINK_PATTERN}
      iconMap={iconMap}
      widgetModule={widgetModule}
      getAuthHeader={getAuthHeader}
      purifyAddAttr={PURIFY_ADD_ATTR}
      extraWidgetProps={extraWidgetProps}
    />
  );
}

export default memo(AdminPanel);
