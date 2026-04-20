import {
  resolveDirectionMultiplier,
  type DirectionMultiplierContext,
  type DirectionMultiplierPolicy,
} from './DirectionMultiplierPolicy.js';

export type DirectionResolveReason = 'segment' | 'global' | 'exploration' | 'breaker_tripped';

export interface DirectionResolution {
  multiplier: number;
  contextKey: string;
  segmentId: string | null;
  wasExploration: boolean;
  reason: DirectionResolveReason;
}

export interface DirectionExplorationConfig {
  enabled: boolean;
  epsilon: number;
  min: number;
  max: number;
  breakerMinTrades: number;
  breakerWindowDays: number;
  breakerMaxCumLoss: number;
  breakerCacheTtlMs: number;
}

export interface DirectionResolverPaperPositionsRepo {
  getExplorationStats(windowDays: number): Promise<{ count: number; pnl: number }>;
}

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface DirectionResolverDeps {
  policyProvider: () => Promise<DirectionMultiplierPolicy>;
  explorationConfig: DirectionExplorationConfig;
  paperPositionsRepo: DirectionResolverPaperPositionsRepo;
  logger: Logger;
  rng?: () => number;
  setTradingConfig?: (key: string, value: unknown, changeReason: string) => Promise<void>;
}

export class DirectionResolver {
  private readonly rng: () => number;
  private breakerCache: { tripped: boolean; fetchedAt: number; stats: { count: number; pnl: number } } | null = null;

  constructor(private readonly deps: DirectionResolverDeps) {
    this.rng = deps.rng ?? Math.random;
  }

  private async isBreakerTripped(): Promise<boolean> {
    const now = Date.now();
    if (this.breakerCache && now - this.breakerCache.fetchedAt < this.deps.explorationConfig.breakerCacheTtlMs) {
      return this.breakerCache.tripped;
    }
    const stats = await this.deps.paperPositionsRepo.getExplorationStats(
      this.deps.explorationConfig.breakerWindowDays,
    );
    const tripped =
      stats.count >= this.deps.explorationConfig.breakerMinTrades &&
      stats.pnl < this.deps.explorationConfig.breakerMaxCumLoss;

    const prevTripped = this.breakerCache?.tripped ?? null;
    this.breakerCache = { tripped, fetchedAt: now, stats };

    if (this.deps.setTradingConfig && (prevTripped === null || prevTripped !== tripped)) {
      const status = {
        state: tripped ? 'tripped' : 'active',
        transitionAt: new Date(now).toISOString(),
        exploreCount: stats.count,
        explorePnl: stats.pnl,
        thresholdTrades: this.deps.explorationConfig.breakerMinTrades,
        thresholdLoss: this.deps.explorationConfig.breakerMaxCumLoss,
      };
      try {
        await this.deps.setTradingConfig(
          'direction_exploration_status',
          status,
          `Direction exploration breaker ${status.state}`,
        );
      } catch (err) {
        this.deps.logger.warn({ err }, 'Failed to persist direction_exploration_status');
      }
    }

    return tripped;
  }

  async resolve(context: DirectionMultiplierContext): Promise<DirectionResolution> {
    const policy = await this.deps.policyProvider();
    const base = resolveDirectionMultiplier(policy, context);

    if (base.segmentId !== null) {
      return {
        multiplier: base.multiplier,
        contextKey: base.contextKey,
        segmentId: base.segmentId,
        wasExploration: false,
        reason: 'segment',
      };
    }

    // Segment miss — consider exploration.
    if (!this.deps.explorationConfig.enabled) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'global',
      };
    }

    if (await this.isBreakerTripped()) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'breaker_tripped',
      };
    }

    const roll = this.rng();
    if (roll >= this.deps.explorationConfig.epsilon) {
      return {
        multiplier: policy.global,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'global',
      };
    }

    const { min, max } = this.deps.explorationConfig;
    const sampled = min + this.rng() * (max - min);
    return {
      multiplier: sampled,
      contextKey: base.contextKey,
      segmentId: null,
      wasExploration: true,
      reason: 'exploration',
    };
  }
}
