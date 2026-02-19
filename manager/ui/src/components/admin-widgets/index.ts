/**
 * Widget registry for admin panel
 * Maps widget names to React components
 */
import { ComponentType } from 'react';
import { AdminStats } from './AdminStats';
import { UserTable } from './UserTable';
import { ClusterDetail } from './ClusterDetail';
import { PartitionLimits } from './PartitionLimits';
import { UsageReport } from './UsageReport';

// Analytics widgets
import { SessionHeatmap } from './SessionHeatmap';
import { ClusterHeatmap } from './ClusterHeatmap';
import { ReleaseUsage } from './ReleaseUsage';
import { IdePopularity } from './IdePopularity';
import { GrowthTrend } from './GrowthTrend';
import { PowerUsers } from './PowerUsers';
import { InactiveUsers } from './InactiveUsers';
import { AccountUsage } from './AccountUsage';
import { ResourceDistribution } from './ResourceDistribution';
import { FeatureUsage } from './FeatureUsage';
import { AdoptionCurve } from './AdoptionCurve';
import { QueueWaitTime } from './QueueWaitTime';

// Shared components
import { DateRangeSelector } from './DateRangeSelector';
import { ExportButton } from './ExportButton';

import type { ClusterHealth, ClusterHistoryPoint } from '../../types';
import type { ParsedWidget } from '../ContentPanel';
export type { ParsedWidget };

export interface AdminWidgetProps {
  health?: Record<string, ClusterHealth | null>;
  history?: Record<string, ClusterHistoryPoint[]>;
  partitions?: Record<string, unknown>;
  onRefreshPartitions?: () => Promise<void>;
  isRefreshing?: boolean;
  getAuthHeader?: () => Record<string, string>;
  cluster?: string;
  hpc?: string;
  version?: string;
  type?: string;
  days?: number;
  data?: unknown[];
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const widgetRegistry: Record<string, ComponentType<any>> = {
  AdminStats,
  UserTable,
  ClusterDetail,
  PartitionLimits,
  UsageReport,

  // Analytics widgets
  SessionHeatmap,
  ClusterHeatmap,
  ReleaseUsage,
  IdePopularity,
  GrowthTrend,
  PowerUsers,
  InactiveUsers,
  AccountUsage,

  // Resource & feature analytics
  ResourceDistribution,
  FeatureUsage,
  AdoptionCurve,
  QueueWaitTime,

  // Shared (not typically used directly in markdown)
  DateRangeSelector,
  ExportButton,

  // Placeholder widgets for future implementation
  RecentActivity: () => null,
  ClusterTrends: () => null,
  ReportExport: () => null,
};

/**
 * Parse widget props from string format
 */
export function parseWidgetProps(propsString: string): Record<string, string> {
  const props: Record<string, string> = {};
  if (!propsString) return props;

  const propRegex = /(\w+)=["']([^"']+)["']/g;
  let match;
  while ((match = propRegex.exec(propsString)) !== null) {
    props[match[1]] = match[2];
  }

  return props;
}

/**
 * Parse widget syntax from markdown content
 */
export function parseWidgets(content: string): ParsedWidget[] {
  const widgets: ParsedWidget[] = [];
  const widgetRegex = /:::widget\s+(\w+)([^:]*?):::/g;
  let match;
  let idCounter = 0;

  while ((match = widgetRegex.exec(content)) !== null) {
    const [fullMatch, name, propsStr] = match;
    const id = `admin-widget-${idCounter++}`;
    widgets.push({
      id,
      name,
      props: parseWidgetProps(propsStr.trim()),
      fullMatch,
    });
  }

  return widgets;
}

/**
 * Replace widget syntax with placeholder divs
 */
export function replaceWidgetsWithPlaceholders(content: string, widgets: ParsedWidget[]): string {
  let result = content;
  for (const widget of widgets) {
    result = result.replace(
      widget.fullMatch,
      `<div data-widget-id="${widget.id}" data-widget-name="${widget.name}"></div>`
    );
  }
  return result;
}
