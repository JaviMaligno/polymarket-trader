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
}

export class DirectionResolver {
  private readonly rng: () => number;

  constructor(private readonly deps: DirectionResolverDeps) {
    this.rng = deps.rng ?? Math.random;
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
