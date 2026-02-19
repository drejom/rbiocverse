/**
 * ClusterHealthPoller - fixed-interval cluster health polling and history management.
 * Extracted from StateManager for separation of concerns.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { clusters } from '../../config';
import { log } from '../logger';
import { errorDetails } from '../errors';
import { MS_PER_MINUTE, MS_PER_HOUR } from '../time';
import * as dbHealth from '../db/health';
import { POLLING_CONFIG, ONE_DAY_MS } from './types';
import type { AppState, HpcServiceFactory, ClusterHealthState, HealthHistoryEntry } from './types';

export class ClusterHealthPoller {
  private healthPollTimer: ReturnType<typeof setTimeout> | null = null;
  lastHealthPollTime: number | null = null;

  constructor(
    private state: AppState,
    private useSqlite: boolean,
    private stateFile: string,
    private getHpcServiceFactory: () => HpcServiceFactory | null,
    private isPollingStopped: () => boolean,
    private getUserAccount: (user: string | null) => string | null,
    private save: () => Promise<void>,
  ) {}

  /**
   * Start health polling - immediately or after remaining TTL if cached data is fresh
   */
  start(): void {
    const { INTERVAL_MS } = POLLING_CONFIG.HEALTH_POLLING;
    const clusterNames = Object.keys(clusters);
    const allClustersHaveFreshHealth = clusterNames.length > 0 &&
      clusterNames.every(hpc => {
        const h = this.state.clusterHealth?.[hpc];
        return h?.current?.lastChecked &&
               h?.current?.online !== false &&
               (Date.now() - h.current.lastChecked) < INTERVAL_MS;
      });

    if (allClustersHaveFreshHealth) {
      log.state('Using cached cluster health data (all clusters < 30 min old)');
      const oldestCheck = Math.min(
        ...clusterNames
          .map(hpc => this.state.clusterHealth![hpc]?.current?.lastChecked)
          .filter((ts): ts is number => ts !== undefined && ts !== null)
      );
      const elapsed = Date.now() - oldestCheck;
      const remaining = Math.max(INTERVAL_MS - elapsed, 1000);
      this.healthPollTimer = setTimeout(() => this.healthPoll(), remaining);
    } else {
      this.healthPoll();
    }
  }

  /**
   * Stop health polling
   */
  stop(): void {
    if (this.healthPollTimer) {
      clearTimeout(this.healthPollTimer);
      this.healthPollTimer = null;
    }
  }

  /**
   * Get cluster health data for API responses
   */
  getClusterHealth(): Record<string, ClusterHealthState> {
    const clusterHealth = this.state.clusterHealth || {};

    if (this.useSqlite) {
      try {
        const dbHistory = dbHealth.getAllHealthHistory({ days: 1 });
        for (const hpc of Object.keys(clusterHealth)) {
          if (clusterHealth[hpc]) {
            clusterHealth[hpc].history = dbHistory[hpc] || [];
          }
        }
      } catch (err) {
        log.error('Failed to get cluster history from SQLite', errorDetails(err));
      }
    }

    return clusterHealth;
  }

  /**
   * Get cluster health history from database
   */
  getClusterHistory(options: { days?: number } = {}): Record<string, HealthHistoryEntry[]> {
    if (!this.useSqlite) {
      const result: Record<string, HealthHistoryEntry[]> = {};
      for (const [hpc, data] of Object.entries(this.state.clusterHealth || {})) {
        result[hpc] = data.history || [];
      }
      return result;
    }

    try {
      return dbHealth.getAllHealthHistory(options);
    } catch (err) {
      log.error('Failed to get cluster history from SQLite', errorDetails(err));
      return {};
    }
  }

  /**
   * Execute a health poll cycle
   */
  private async healthPoll(): Promise<void> {
    this.lastHealthPollTime = Date.now();

    try {
      await this.refreshClusterHealth();
    } catch (e) {
      log.error('Health poll cycle failed', errorDetails(e));
    }

    if (!this.isPollingStopped()) {
      const { INTERVAL_MS } = POLLING_CONFIG.HEALTH_POLLING;
      this.healthPollTimer = setTimeout(() => this.healthPoll(), INTERVAL_MS);
      log.debugFor('state', `Next health poll in ${Math.round(INTERVAL_MS / MS_PER_MINUTE)} min`);
    }
  }

  /**
   * Refresh cluster health for all clusters
   */
  private async refreshClusterHealth(): Promise<void> {
    const factory = this.getHpcServiceFactory();
    if (!factory) return;

    const now = Date.now();

    if (!this.state.clusterHealth) {
      this.state.clusterHealth = {};
    }

    const clusterNames = Object.keys(clusters);

    for (const hpc of clusterNames) {
      if (!this.state.clusterHealth[hpc]) {
        this.state.clusterHealth[hpc] = {
          current: null,
          history: [],
          lastRolloverAt: 0,
          consecutiveFailures: 0,
        };
      }
    }

    const userAccount = this.getUserAccount(null);
    const healthPromises = clusterNames.map(async (hpc) => {
      try {
        const hpcService = factory(hpc);
        const health = await hpcService.getClusterHealth({ userAccount });

        this.state.clusterHealth![hpc].consecutiveFailures = 0;
        this.state.clusterHealth![hpc].current = health;

        if (this.useSqlite) {
          try {
            dbHealth.saveClusterCache(hpc, health);
            if (health.online && health.cpus && health.memory && health.nodes) {
              dbHealth.addHealthSnapshot(hpc, health);
            }
          } catch (err) {
            log.error('Failed to save cluster health to SQLite', { hpc, ...errorDetails(err) });
          }
        }

        if (health.online && health.cpus && health.memory && health.nodes) {
          this.state.clusterHealth![hpc].history.push({
            timestamp: now,
            cpus: health.cpus.percent ?? 0,
            memory: health.memory.percent ?? 0,
            nodes: health.nodes.percent ?? 0,
            gpus: health.gpus?.percent ?? null,
            runningJobs: health.runningJobs,
            pendingJobs: health.pendingJobs,
          });

          if (!this.useSqlite) {
            const ROLLOVER_MIN_INTERVAL_MS = MS_PER_HOUR;
            const lastRolloverAt = this.state.clusterHealth![hpc].lastRolloverAt || 0;
            if (now - lastRolloverAt >= ROLLOVER_MIN_INTERVAL_MS) {
              await this.rolloverHealthHistory(hpc);
              this.state.clusterHealth![hpc].lastRolloverAt = now;
            }
          }
        }

        log.debugFor('state', `Cluster health refreshed: ${hpc}`, {
          cpus: health.cpus?.percent,
          memory: health.memory?.percent,
          nodes: health.nodes,
        });
      } catch (e) {
        this.state.clusterHealth![hpc].consecutiveFailures =
          (this.state.clusterHealth![hpc].consecutiveFailures || 0) + 1;

        this.state.clusterHealth![hpc].current = {
          online: false,
          error: (e as Error).message,
          lastChecked: now,
          cpus: null,
          memory: null,
          nodes: null,
          gpus: null,
          partitions: null,
          runningJobs: 0,
          pendingJobs: 0,
          fairshare: null,
          consecutiveFailures: this.state.clusterHealth![hpc].consecutiveFailures,
        };

        const failures = this.state.clusterHealth![hpc].consecutiveFailures;
        if (failures >= 5) {
          log.error('Cluster health check failing persistently', { hpc, failures, ...errorDetails(e) });
        } else {
          log.warn('Failed to refresh cluster health', { hpc, failures, ...errorDetails(e) });
        }
      }
    });

    await Promise.all(healthPromises);
    await this.save();
  }

  /**
   * Roll over history entries older than 24h to dated archive files
   */
  private async rolloverHealthHistory(hpc: string): Promise<void> {
    const history = this.state.clusterHealth?.[hpc]?.history || [];
    const cutoff = Date.now() - ONE_DAY_MS;

    const toArchive = history.filter(e => e.timestamp < cutoff);
    if (toArchive.length === 0) return;

    const byDate: Record<string, HealthHistoryEntry[]> = {};
    for (const entry of toArchive) {
      const date = new Date(entry.timestamp).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(entry);
    }

    const archiveDir = path.join(path.dirname(this.stateFile), 'health-history');
    await fs.mkdir(archiveDir, { recursive: true });

    for (const [date, entries] of Object.entries(byDate)) {
      const archiveFile = path.join(archiveDir, `${hpc}-${date}.json`);

      let existing: { cluster: string; date: string; entries: HealthHistoryEntry[] } = { cluster: hpc, date, entries: [] };
      try {
        const data = await fs.readFile(archiveFile, 'utf8');
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
          existing = parsed;
        } else {
          log.warn('Invalid archive JSON structure, using fresh archive', { archiveFile, hpc, date });
        }
      } catch (e) {
        const nodeErr = e as NodeJS.ErrnoException;
        if (nodeErr.code !== 'ENOENT') {
          log.warn('Failed to read archive file, using fresh archive', { archiveFile, hpc, date, ...errorDetails(e) });
        }
      }

      const allEntries = [...existing.entries, ...entries];
      const downsampled = this.downsampleToHourly(allEntries);

      existing.entries = downsampled;
      await fs.writeFile(archiveFile, JSON.stringify(existing, null, 2));
      log.state(`Archived health entries`, { hpc, date, raw: entries.length, downsampled: downsampled.length });
    }

    this.state.clusterHealth![hpc].history = history.filter(e => e.timestamp >= cutoff);
  }

  /**
   * Downsample health entries to one per hour
   */
  private downsampleToHourly(entries: HealthHistoryEntry[]): (HealthHistoryEntry & { sampleCount?: number })[] {
    if (entries.length === 0) return [];

    const byHour: Record<string, HealthHistoryEntry[]> = {};
    for (const entry of entries) {
      const hourKey = new Date(entry.timestamp).toISOString().slice(0, 13);
      if (!byHour[hourKey]) byHour[hourKey] = [];
      byHour[hourKey].push(entry);
    }

    const result: (HealthHistoryEntry & { sampleCount?: number })[] = [];
    for (const hourEntries of Object.values(byHour)) {
      const sortedByTime = hourEntries.sort((a, b) => a.timestamp - b.timestamp);
      const midIndex = Math.floor(sortedByTime.length / 2);

      result.push({
        timestamp: sortedByTime[midIndex].timestamp,
        cpus: this.median(hourEntries.map(e => e.cpus)),
        memory: this.median(hourEntries.map(e => e.memory)),
        nodes: this.median(hourEntries.map(e => e.nodes)),
        gpus: this.medianNullable(hourEntries.map(e => e.gpus)),
        runningJobs: Math.round(this.median(hourEntries.map(e => e.runningJobs))),
        pendingJobs: Math.round(this.median(hourEntries.map(e => e.pendingJobs))),
        sampleCount: hourEntries.length,
      });
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Calculate median of numeric array
   */
  private median(values: (number | null)[]): number {
    const sorted = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /**
   * Calculate median for nullable values (e.g., GPUs which may be null)
   */
  private medianNullable(values: (number | null)[]): number | null {
    const nonNull = values.filter((v): v is number => v !== null && typeof v === 'number');
    if (nonNull.length === 0) return null;
    return this.median(nonNull);
  }
}
