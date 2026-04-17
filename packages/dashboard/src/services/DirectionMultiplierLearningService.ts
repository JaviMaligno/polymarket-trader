import { EventEmitter } from 'events';
import { isDatabaseConfigured, query } from '../database/index.js';
import { signalWeightsRepo, tradingConfigRepo } from '../database/repositories.js';
import {
  clampDirectionMultiplier,
  getDirectionPriceBucket,
  getDirectionPriceBucketRange,
  sanitizeDirectionMultiplierPolicy,
  type DirectionDurationBand,
  type DirectionMultiplierPolicy,
  type DirectionMultiplierSegment,
} from './DirectionMultiplierPolicy.js';

export interface DirectionMultiplierLearningConfig {
  enabled: boolean;
  evaluationIntervalMs: number;
  lookbackDays: number;
  minSegmentTrades: number;
  minCandidateTrades: number;
  minImprovementPerTrade: number;
  minWinRateLift: number;
  maxSegments: number;
  minMultiplier: number;
  maxMultiplier: number;
  maxPositiveMultiplier: number;
}

export interface DirectionLearningRow {
  marketType: string;
  priceBucket: string;
  durationBand: DirectionDurationBand;
  realizedPnl: number;
  directionMultiplier: number;
}

interface CandidateStats {
  count: number;
  totalPnl: number;
  wins: number;
  sumDirectionMultiplier: number;
}

interface SegmentSummary {
  segmentId: string;
  marketType: string;
  priceBucket: string;
  durationBand: DirectionDurationBand;
  totalTrades: number;
  selectedBucket: string;
  multiplier: number;
  avgPnl: number;
  winRate: number;
  baselineBucket: string | null;
  baselineAvgPnl: number | null;
  baselineWinRate: number | null;
}

export interface DirectionMultiplierLearningSummary {
  evaluatedAt: string;
  lookbackDays: number;
  sampleSize: number;
  segmentCount: number;
  segments: SegmentSummary[];
}

const DEFAULT_CONFIG: DirectionMultiplierLearningConfig = {
  enabled: true,
  evaluationIntervalMs: 6 * 60 * 60 * 1000,
  lookbackDays: 30,
  minSegmentTrades: 24,
  minCandidateTrades: 8,
  minImprovementPerTrade: 0.75,
  minWinRateLift: 0.08,
  maxSegments: 8,
  minMultiplier: -1.25,
  maxMultiplier: 0.1,
  maxPositiveMultiplier: 0.1,
};

function bucketDirectionMultiplier(multiplier: number): string {
  if (multiplier <= -1.1) return 'strong_negative';
  if (multiplier < -0.25) return 'weak_negative';
  return 'non_negative';
}

function scoreCandidate(stats: CandidateStats): number {
  const avgPnl = stats.totalPnl / stats.count;
  const winRate = stats.wins / stats.count;
  return avgPnl + (winRate - 0.5) * 2;
}

function averageDirectionMultiplier(
  stats: CandidateStats,
  config: Pick<DirectionMultiplierLearningConfig, 'minMultiplier' | 'maxMultiplier' | 'maxPositiveMultiplier'>
): number {
  const raw = stats.sumDirectionMultiplier / stats.count;
  const maxMultiplier = raw > 0 ? config.maxPositiveMultiplier : config.maxMultiplier;
  return Math.max(config.minMultiplier, Math.min(maxMultiplier, raw));
}

function buildSegmentId(row: Pick<DirectionLearningRow, 'marketType' | 'priceBucket' | 'durationBand'>): string {
  return `${row.marketType}-${row.priceBucket}-${row.durationBand}`;
}

export function deriveDirectionMultiplierPolicy(
  rows: DirectionLearningRow[],
  globalMultiplier: number,
  config: DirectionMultiplierLearningConfig = DEFAULT_CONFIG
): {
  policy: DirectionMultiplierPolicy;
  summary: DirectionMultiplierLearningSummary;
} {
  const segmentMap = new Map<string, Map<string, CandidateStats>>();

  for (const row of rows) {
    const segmentId = buildSegmentId(row);
    const bucket = bucketDirectionMultiplier(row.directionMultiplier);

    if (!segmentMap.has(segmentId)) {
      segmentMap.set(segmentId, new Map());
    }

    const candidateMap = segmentMap.get(segmentId)!;
    const stats = candidateMap.get(bucket) ?? {
      count: 0,
      totalPnl: 0,
      wins: 0,
      sumDirectionMultiplier: 0,
    };
    stats.count += 1;
    stats.totalPnl += row.realizedPnl;
    stats.wins += row.realizedPnl > 0 ? 1 : 0;
    stats.sumDirectionMultiplier += row.directionMultiplier;
    candidateMap.set(bucket, stats);
  }

  const globalBucket = bucketDirectionMultiplier(globalMultiplier);
  const segmentSummaries: SegmentSummary[] = [];
  const segments: DirectionMultiplierSegment[] = [];

  for (const [segmentId, candidateMap] of segmentMap.entries()) {
    const [marketType, priceBucket, durationBandRaw] = segmentId.split('-');
    const durationBand = durationBandRaw as DirectionDurationBand;
    const totalTrades = Array.from(candidateMap.values()).reduce((sum, stats) => sum + stats.count, 0);
    if (totalTrades < config.minSegmentTrades) continue;

    const viableCandidates = Array.from(candidateMap.entries())
      .filter(([, stats]) => stats.count >= config.minCandidateTrades)
      .map(([bucket, stats]) => ({
        bucket,
        stats,
        score: scoreCandidate(stats),
        avgPnl: stats.totalPnl / stats.count,
        winRate: stats.wins / stats.count,
        multiplier: averageDirectionMultiplier(stats, config),
      }))
      .sort((a, b) => b.score - a.score);

    if (viableCandidates.length === 0) continue;

    const best = viableCandidates[0];
    const baseline = viableCandidates.find(candidate => candidate.bucket === globalBucket) ?? null;
    const baselineAvgPnl = baseline?.avgPnl ?? null;
    const baselineWinRate = baseline?.winRate ?? null;

    const betterThanBaseline = baseline == null
      ? best.avgPnl > 0
      : (best.avgPnl - baseline.avgPnl >= config.minImprovementPerTrade) ||
        (best.winRate - baseline.winRate >= config.minWinRateLift);

    if (!betterThanBaseline) continue;

    const bucketRange = getDirectionPriceBucketRange(priceBucket);
    if (!bucketRange) continue;

    const multiplier = clampDirectionMultiplier(best.multiplier, {
      minMultiplier: config.minMultiplier,
      maxMultiplier: best.multiplier > 0 ? config.maxPositiveMultiplier : config.maxMultiplier,
    });

    segments.push({
      id: segmentId,
      multiplier,
      marketTypes: [marketType],
      priceRange: bucketRange,
      durationBands: [durationBand],
      rationale: baseline == null
        ? `${best.bucket} selected on ${best.stats.count} trades`
        : `${best.bucket} beat ${baseline.bucket} by ${(best.avgPnl - baseline.avgPnl).toFixed(2)} avg PnL/trade`,
    });

    segmentSummaries.push({
      segmentId,
      marketType,
      priceBucket,
      durationBand,
      totalTrades,
      selectedBucket: best.bucket,
      multiplier,
      avgPnl: best.avgPnl,
      winRate: best.winRate,
      baselineBucket: baseline?.bucket ?? null,
      baselineAvgPnl,
      baselineWinRate,
    });
  }

  segmentSummaries.sort((a, b) => b.avgPnl - a.avgPnl);
  const topSegments = segmentSummaries.slice(0, config.maxSegments);
  const topSegmentIds = new Set(topSegments.map(segment => segment.segmentId));

  const policy = sanitizeDirectionMultiplierPolicy({
    global: globalMultiplier,
    minMultiplier: config.minMultiplier,
    maxMultiplier: config.maxMultiplier,
    segments: segments.filter(segment => topSegmentIds.has(segment.id)),
  }, globalMultiplier);

  return {
    policy,
    summary: {
      evaluatedAt: new Date().toISOString(),
      lookbackDays: config.lookbackDays,
      sampleSize: rows.length,
      segmentCount: policy.segments.length,
      segments: topSegments,
    },
  };
}

export class DirectionMultiplierLearningService extends EventEmitter {
  private config: DirectionMultiplierLearningConfig;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastEvaluation: Date | null = null;
  private lastSummary: DirectionMultiplierLearningSummary | null = null;

  constructor(config?: Partial<DirectionMultiplierLearningConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!this.config.enabled || !isDatabaseConfigured()) return;

    this.isRunning = true;
    await this.evaluate();
    this.timer = setInterval(() => {
      this.evaluate().catch(error => {
        console.error('[DirectionMultiplierLearning] Evaluation failed:', error);
      });
    }, this.config.evaluationIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  async evaluate(): Promise<DirectionMultiplierLearningSummary | null> {
    if (!this.config.enabled || !isDatabaseConfigured()) return null;

    const currentDirectionMultiplier = await signalWeightsRepo.get('direction_multiplier');
    const globalMultiplier = currentDirectionMultiplier
      ? Number(currentDirectionMultiplier.weight)
      : -1.0;

    const result = await query<{
      market_type: string | null;
      yes_entry_price: string;
      duration_band: DirectionDurationBand;
      realized_pnl: string;
      direction_multiplier: string;
    }>(
      `SELECT
         COALESCE(m.market_type, 'unknown') AS market_type,
         CASE
           WHEN pp.side = 'long' THEN pp.avg_entry_price
           ELSE 1 - pp.avg_entry_price
         END AS yes_entry_price,
         CASE
           WHEN m.end_date IS NULL THEN 'medium'
           WHEN m.end_date - pp.opened_at <= INTERVAL '1 day' THEN 'intraday'
           WHEN m.end_date - pp.opened_at <= INTERVAL '7 days' THEN 'short'
           WHEN m.end_date - pp.opened_at <= INTERVAL '30 days' THEN 'medium'
           ELSE 'long'
         END AS duration_band,
         COALESCE(pp.realized_pnl, 0) AS realized_pnl,
         COALESCE(dm.weight, $2) AS direction_multiplier
       FROM paper_positions pp
       JOIN markets m ON m.id = pp.market_id
       LEFT JOIN LATERAL (
         SELECT swh.weight
         FROM signal_weights_history swh
         WHERE swh.signal_type = 'direction_multiplier'
           AND swh.time <= pp.opened_at
         ORDER BY swh.time DESC
         LIMIT 1
       ) dm ON TRUE
       WHERE pp.closed_at IS NOT NULL
         AND pp.opened_at >= NOW() - INTERVAL '1 day' * $1`,
      [this.config.lookbackDays, globalMultiplier]
    );

    const rows: DirectionLearningRow[] = result.rows.map(row => ({
      marketType: row.market_type ?? 'unknown',
      priceBucket: getDirectionPriceBucket(Number(row.yes_entry_price)),
      durationBand: row.duration_band,
      realizedPnl: Number(row.realized_pnl),
      directionMultiplier: Number(row.direction_multiplier),
    }));

    const { policy, summary } = deriveDirectionMultiplierPolicy(rows, globalMultiplier, this.config);
    await tradingConfigRepo.set(
      'direction_multiplier_policy',
      policy,
      'Automatically learned contextual direction multiplier policy'
    );
    await tradingConfigRepo.set(
      'direction_multiplier_policy_summary',
      summary,
      'Latest direction multiplier policy learning summary'
    );

    this.lastEvaluation = new Date();
    this.lastSummary = summary;
    this.emit('evaluation:complete', { policy, summary });
    return summary;
  }

  getStatus(): {
    isRunning: boolean;
    lastEvaluation: Date | null;
    config: DirectionMultiplierLearningConfig;
    lastSummary: DirectionMultiplierLearningSummary | null;
  } {
    return {
      isRunning: this.isRunning,
      lastEvaluation: this.lastEvaluation,
      config: { ...this.config },
      lastSummary: this.lastSummary,
    };
  }
}

let directionMultiplierLearningService: DirectionMultiplierLearningService | null = null;

export function getDirectionMultiplierLearningService(): DirectionMultiplierLearningService {
  if (!directionMultiplierLearningService) {
    directionMultiplierLearningService = new DirectionMultiplierLearningService();
  }
  return directionMultiplierLearningService;
}

export function initializeDirectionMultiplierLearningService(
  config?: Partial<DirectionMultiplierLearningConfig>
): DirectionMultiplierLearningService {
  directionMultiplierLearningService = new DirectionMultiplierLearningService(config);
  return directionMultiplierLearningService;
}
