import {
  resolveDirectionMultiplier,
  type DirectionMultiplierContext,
  type DirectionMultiplierPolicy,
} from './DirectionMultiplierPolicy.js';

export type DirectionResolveReason = 'segment' | 'per_type' | 'global' | 'exploration' | 'breaker_tripped';

export interface DirectionResolution {
  multiplier: number;
  contextKey: string;
  segmentId: string | null;
  wasExploration: boolean;
  reason: DirectionResolveReason;
}

export interface DirectionExplorationConfig {
  /** Fraction of segment-miss resolves that enter the exploration slot.
   *  Set to 0 to disable exploration entirely (kill switch). */
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

    // Per-market-type match: priority between segment and exploration.
    // resolveDirectionMultiplier already applied the perMarketType lookup and
    // returned its value via `base.multiplier` (with segmentId=null). We MUST
    // honor it here — without this branch, the multiplier is discarded and the
    // resolver falls through to exploration/global, silently overriding the
    // per-type policy. Exploration is for "no information" cases; perMarketType
    // is information.
    const perTypeMultiplier = context.marketType
      ? policy.perMarketType?.[context.marketType]
      : undefined;
    if (perTypeMultiplier !== undefined && Number.isFinite(perTypeMultiplier)) {
      return {
        multiplier: perTypeMultiplier,
        contextKey: base.contextKey,
        segmentId: null,
        wasExploration: false,
        reason: 'per_type',
      };
    }

    // Segment miss AND no per-type match — consider exploration.
    // Kill switch: DIRECTION_EXPLORATION_EPSILON=0 makes `roll < epsilon` always false → global fallthrough.
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
