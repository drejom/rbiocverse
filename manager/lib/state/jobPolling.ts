/**
 * JobPoller - adaptive SLURM job polling loop.
 * Extracted from StateManager for separation of concerns.
 */

import { clusters } from '../../config';
import { log } from '../logger';
import { errorDetails, errorMessage } from '../errors';
import { POLLING_CONFIG, parseSessionKey } from './types';
import type { AppState, HpcServiceFactory, JobInfo, PollingInfo } from './types';

export class JobPoller {
  private jobPollTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveUnchangedPolls = 0;
  private lastStateSnapshot: string | null = null;
  lastJobPollTime: number | null = null;
  nextJobPollTime: number | null = null;

  constructor(
    private state: AppState,
    private getHpcServiceFactory: () => HpcServiceFactory | null,
    private isPollingStopped: () => boolean,
    private clearActiveSessionIfMatches: (user: string | null, hpc: string, ide: string) => void,
    private save: () => Promise<void>,
    private getOnSessionCleared: () => ((user: string, hpc: string, ide: string) => void) | null,
    private clearSession: (user: string, hpc: string, ide: string, options?: { endReason?: string }) => Promise<void>,
  ) {}

  /**
   * Start job polling immediately
   */
  start(): void {
    this.scheduleJobPoll();
  }

  /**
   * Stop job polling
   */
  stop(): void {
    if (this.jobPollTimer) {
      clearTimeout(this.jobPollTimer);
      this.jobPollTimer = null;
    }
  }

  /**
   * Trigger faster polling when session state changes to pending
   */
  triggerFastPoll(): void {
    if (this.isPollingStopped() || !this.getHpcServiceFactory()) return;

    if (this.jobPollTimer) {
      clearTimeout(this.jobPollTimer);
      this.jobPollTimer = null;
    }

    this.scheduleJobPoll();
    log.state('Rescheduled polling for pending session');
  }

  /**
   * Check if job exists in squeue
   */
  async checkJobExists(hpc: string, jobId: string): Promise<boolean> {
    const factory = this.getHpcServiceFactory();
    if (!factory) {
      return true; // No HPC service factory - assume job exists (safer)
    }

    try {
      const hpcService = factory(hpc);
      return await hpcService.checkJobExists(jobId);
    } catch (e) {
      log.warn('Failed to check job existence, assuming exists', { hpc, jobId, ...errorDetails(e) });
      return true; // Safe fallback
    }
  }

  /**
   * Get polling info for API responses
   */
  getPollingInfo(): PollingInfo {
    return {
      jobPolling: {
        lastPollTime: this.lastJobPollTime,
        nextPollTime: this.nextJobPollTime,
        consecutiveUnchangedPolls: this.consecutiveUnchangedPolls,
        currentInterval: this.getOptimalJobPollInterval(),
      },
      healthPolling: {
        lastPollTime: null, // Provided by ClusterHealthPoller
        interval: POLLING_CONFIG.HEALTH_POLLING.INTERVAL_MS,
      },
    };
  }

  /**
   * Get polling info merged with health poll time
   */
  getPollingInfoWith(lastHealthPollTime: number | null): PollingInfo {
    return {
      jobPolling: {
        lastPollTime: this.lastJobPollTime,
        nextPollTime: this.nextJobPollTime,
        consecutiveUnchangedPolls: this.consecutiveUnchangedPolls,
        currentInterval: this.getOptimalJobPollInterval(),
      },
      healthPolling: {
        lastPollTime: lastHealthPollTime,
        interval: POLLING_CONFIG.HEALTH_POLLING.INTERVAL_MS,
      },
    };
  }

  /**
   * Calculate optimal job polling interval based on session state and backoff
   */
  getOptimalJobPollInterval(): number {
    const { THRESHOLDS_SECONDS, INTERVALS_MS, BACKOFF } = POLLING_CONFIG.JOB_POLLING;

    let hasPending = false;
    let minTimeLeft = Infinity;
    let hasAnySessions = false;

    for (const session of Object.values(this.state.sessions)) {
      if (!session) continue;

      if (session.status === 'pending') {
        hasPending = true;
        hasAnySessions = true;
      } else if (session.status === 'running') {
        hasAnySessions = true;
        const timeLeft = session.timeLeftSeconds || Infinity;
        if (timeLeft < minTimeLeft) {
          minTimeLeft = timeLeft;
        }
      }
    }

    if (hasPending) {
      return INTERVALS_MS.FREQUENT;
    }

    if (!hasAnySessions) {
      return INTERVALS_MS.IDLE;
    }

    let baseInterval: number;
    if (minTimeLeft < THRESHOLDS_SECONDS.NEAR_EXPIRY) {
      baseInterval = INTERVALS_MS.FREQUENT;
    } else if (minTimeLeft < THRESHOLDS_SECONDS.APPROACHING_END) {
      baseInterval = INTERVALS_MS.MODERATE;
    } else if (minTimeLeft < THRESHOLDS_SECONDS.MODERATE) {
      baseInterval = INTERVALS_MS.RELAXED;
    } else if (minTimeLeft < THRESHOLDS_SECONDS.STABLE) {
      baseInterval = INTERVALS_MS.INFREQUENT;
    } else {
      baseInterval = INTERVALS_MS.IDLE;
    }

    if (this.consecutiveUnchangedPolls >= BACKOFF.START_THRESHOLD) {
      const exponent = Math.min(
        this.consecutiveUnchangedPolls - BACKOFF.START_THRESHOLD + 1,
        BACKOFF.MAX_EXPONENT
      );
      const backoffMultiplier = Math.pow(BACKOFF.MULTIPLIER, exponent);
      const backedOffInterval = baseInterval * backoffMultiplier;
      return Math.min(backedOffInterval, INTERVALS_MS.MAX);
    }

    return baseInterval;
  }

  /**
   * Schedule next job poll with adaptive interval
   */
  private scheduleJobPoll(): void {
    if (this.isPollingStopped()) return;
    const interval = this.getOptimalJobPollInterval();
    this.nextJobPollTime = Date.now() + interval;
    this.jobPollTimer = setTimeout(() => this.jobPoll(), interval);
    log.debugFor('state', `Next job poll in ${Math.round(interval / 1000)}s`);
  }

  /**
   * Execute a job poll cycle
   */
  private async jobPoll(): Promise<void> {
    this.lastJobPollTime = Date.now();

    try {
      const changed = await this.refreshAllSessions();

      if (changed) {
        this.consecutiveUnchangedPolls = 0;
        log.debugFor('state', 'Job poll detected changes, resetting backoff');
      } else {
        this.consecutiveUnchangedPolls++;
        log.debugFor('state', `No job changes for ${this.consecutiveUnchangedPolls} polls`);
      }
    } catch (e) {
      log.error('Job poll cycle failed', errorDetails(e));
    } finally {
      this.scheduleJobPoll();
    }
  }

  /**
   * Refresh all sessions from SLURM using batch queries
   */
  private async refreshAllSessions(): Promise<boolean> {
    const factory = this.getHpcServiceFactory();
    if (!factory) return false;

    let significantChange = false;
    const snapshotBefore = JSON.stringify(this.state.sessions);

    const clusterNames = Object.keys(clusters);
    const jobResults = await Promise.all(
      clusterNames.map(async (hpc) => {
        try {
          const hpcService = factory(hpc);
          const jobs = await hpcService.getAllJobs();
          return { hpc, jobs, error: null };
        } catch (e) {
          log.warn('Failed to fetch jobs from cluster', { hpc, ...errorDetails(e) });
          return { hpc, jobs: {} as Record<string, JobInfo | null>, error: errorMessage(e) };
        }
      })
    );

    const jobsByCluster: Record<string, Record<string, JobInfo | null>> = {};
    for (const { hpc, jobs } of jobResults) {
      jobsByCluster[hpc] = jobs;
    }

    for (const [sessionKey, session] of Object.entries(this.state.sessions)) {
      if (!session || !session.jobId) continue;
      if (session.status !== 'running' && session.status !== 'pending') continue;

      const parsed = parseSessionKey(sessionKey);
      if (!parsed) {
        log.warn('Failed to parse session key during refresh', { sessionKey });
        continue;
      }
      const { user, hpc, ide } = parsed;
      const clusterJobs = jobsByCluster[hpc] || {};
      const jobInfo = clusterJobs[ide];

      if (!jobInfo || jobInfo.jobId !== session.jobId) {
        log.state(`Job ${session.jobId} no longer in squeue`, { sessionKey });
        await this.clearSession(user, hpc, ide, { endReason: 'completed' });
        significantChange = true;
        continue;
      }

      if (jobInfo.state === 'RUNNING' && session.status !== 'running') {
        session.status = 'running';
        session.node = jobInfo.node || null;
        session.estimatedStartTime = null;
        significantChange = true;
      } else if (jobInfo.state === 'PENDING') {
        if (session.status !== 'pending') {
          session.status = 'pending';
          significantChange = true;
        }
        log.debugFor('state', 'Pending job startTime', { sessionKey, startTime: jobInfo.startTime, current: session.estimatedStartTime });
        if (jobInfo.startTime && jobInfo.startTime !== session.estimatedStartTime) {
          session.estimatedStartTime = jobInfo.startTime;
          log.state('Updated estimatedStartTime', { sessionKey, startTime: jobInfo.startTime });
        }
      }

      if (jobInfo.timeLeftSeconds !== undefined) {
        session.timeLeftSeconds = jobInfo.timeLeftSeconds;
      }
    }

    const snapshotAfter = JSON.stringify(this.state.sessions);
    if (snapshotBefore !== snapshotAfter) {
      await this.save();
    }

    if (!significantChange && snapshotBefore !== this.lastStateSnapshot) {
      significantChange = true;
    }
    this.lastStateSnapshot = snapshotAfter;

    return significantChange;
  }
}
