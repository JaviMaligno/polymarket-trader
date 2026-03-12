import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export type SyncState = 'NORMAL' | 'DEGRADED' | 'CRITICAL';

export interface AdaptiveSyncConfig {
  lagThresholdDegraded: number;    // ms — enter DEGRADED (default: 500)
  lagThresholdCritical: number;    // ms — enter CRITICAL (default: 1000)
  recoveryThreshold: number;       // ms — below this to recover (default: 200)
  checkIntervalMs: number;         // how often to sample lag (default: 10000)
  degradedChecksRequired: number;  // consecutive high-lag checks before DEGRADED (default: 3)
  recoveryDurationMs: number;      // how long lag must stay low to recover (default: 300000)
  maxIntervalMultiplier: number;   // ceiling for interval stretch (default: 4)
  skipEscalationThreshold: number; // consecutive skips before escalation (default: 3)
}

const DEFAULT_CONFIG: AdaptiveSyncConfig = {
  lagThresholdDegraded: 500,
  lagThresholdCritical: 1000,
  recoveryThreshold: 200,
  checkIntervalMs: 10000,
  degradedChecksRequired: 3,
  recoveryDurationMs: 300000,
  maxIntervalMultiplier: 4,
  skipEscalationThreshold: 3,
};

export class AdaptiveSyncManager {
  private config: AdaptiveSyncConfig;
  private state: SyncState = 'NORMAL';

  // Lag tracking
  private consecutiveHighLagChecks = 0;
  private lowLagSinceMs: number | null = null;

  // Per-job skip counters
  private jobSkipCounts: Map<string, number> = new Map();

  // Event loop monitoring
  private histogram: IntervalHistogram | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  // Pluggable clock for testability
  private now: () => number;

  constructor(config: Partial<AdaptiveSyncConfig> = {}, clock: () => number = Date.now) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = clock;
  }

  /**
   * Start event loop monitoring and the periodic lag check interval.
   */
  start(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();

    this.checkInterval = setInterval(() => {
      if (this.histogram) {
        // histogram.mean is in nanoseconds — convert to ms
        const lagMs = this.histogram.mean / 1e6;
        this.histogram.reset();
        this.reportLag(lagMs);
      }
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop monitoring and clear the check interval.
   */
  stop(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
  }

  /**
   * Process a lag sample and transition state as needed.
   * Called internally by the check interval; also callable directly in tests.
   */
  reportLag(lagMs: number): void {
    const { lagThresholdCritical, lagThresholdDegraded, degradedChecksRequired,
            recoveryThreshold, recoveryDurationMs } = this.config;

    // CRITICAL: immediate transition on a single sample above critical threshold
    if (lagMs > lagThresholdCritical) {
      this.state = 'CRITICAL';
      this.consecutiveHighLagChecks = 0;
      this.lowLagSinceMs = null;
      return;
    }

    // High lag (degraded range)
    if (lagMs > lagThresholdDegraded) {
      this.consecutiveHighLagChecks++;
      this.lowLagSinceMs = null;

      if (this.state === 'NORMAL' && this.consecutiveHighLagChecks >= degradedChecksRequired) {
        this.state = 'DEGRADED';
      }
      return;
    }

    // Low lag (potential recovery)
    this.consecutiveHighLagChecks = 0;

    if (lagMs < recoveryThreshold) {
      const now = this.now();
      if (this.lowLagSinceMs === null) {
        this.lowLagSinceMs = now;
      } else if (now - this.lowLagSinceMs >= recoveryDurationMs) {
        // Sustained low lag long enough — recover
        this.state = 'NORMAL';
        this.lowLagSinceMs = null;
      }
    } else {
      // Between recoveryThreshold and lagThresholdDegraded: reset recovery timer
      this.lowLagSinceMs = null;
    }
  }

  /**
   * Called by Scheduler when a job tick is skipped because isRunning=true.
   * Increments per-job skip counter and escalates to DEGRADED if threshold reached.
   */
  reportJobSkip(jobName: string): void {
    const current = this.jobSkipCounts.get(jobName) ?? 0;
    const next = current + 1;
    this.jobSkipCounts.set(jobName, next);

    if (next >= this.config.skipEscalationThreshold && this.state === 'NORMAL') {
      this.state = 'DEGRADED';
    }
  }

  /**
   * Called by Scheduler when a job finishes. Resets per-job skip counter.
   */
  reportJobComplete(jobName: string): void {
    this.jobSkipCounts.set(jobName, 0);
  }

  /**
   * Returns true if the skip count for the given job has reached the escalation threshold.
   */
  shouldEscalateForJob(jobName: string): boolean {
    return (this.jobSkipCounts.get(jobName) ?? 0) >= this.config.skipEscalationThreshold;
  }

  /**
   * Returns the current sync state.
   */
  getState(): SyncState {
    return this.state;
  }

  /**
   * Returns the interval multiplier based on current state, capped at maxIntervalMultiplier.
   *   NORMAL   → 1
   *   DEGRADED → 2
   *   CRITICAL → 3
   */
  getIntervalMultiplier(): number {
    const base: Record<SyncState, number> = {
      NORMAL: 1,
      DEGRADED: 2,
      CRITICAL: 3,
    };
    return Math.min(base[this.state], this.config.maxIntervalMultiplier);
  }
}
