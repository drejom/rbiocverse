/**
 * AdminPanel - Slide-out admin panel (left side)
 * Provides user management, cluster status, and reports
 */

import { useState, useEffect, useCallback, memo } from 'react';
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

  // Fetch partitions when panel opens
  useEffect(() => {
    if (isOpen) {
      fetchPartitions();
    }
  }, [isOpen, fetchPartitions]);

  return (
    <ContentPanel
      panelClass="admin-panel"
      headerIcon={<LayoutDashboard size={20} style={{ marginRight: 8 }} />}
      title="Admin Panel"
      isOpen={isOpen}
      onClose={onClose}
      health={health}
      history={history}
      menuEndpoint="/api/admin/index"
      contentEndpoint={(id) => `/api/admin/content/${id}`}
      searchEndpoint="/api/admin/search"
      defaultSection="overview"
      linkPattern={/^\/(?:api\/)?admin(?:\/content)?\/(.+)$/}
      iconMap={iconMap}
      widgetModule={widgetModule}
      getAuthHeader={getAuthHeader}
      purifyAddAttr={['target', 'data-widget-id', 'data-widget-name']}
      extraWidgetProps={{
        partitions,
        onRefreshPartitions: handleRefreshPartitions,
        isRefreshingPartitions,
      }}
    />
  );
}

export default memo(AdminPanel);
