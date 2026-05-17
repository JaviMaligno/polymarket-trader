/**
 * MarketSelector — pure helpers for ranking + force-include during the
 * PolymarketService.selectDiversifiedMarkets step.
 *
 * The historical selector ordered markets by `volume` descending and grouped
 * by category. That picked up high-action markets but systematically excluded
 * markets in the cohorts that several generators (resolution_prior v1+v2,
 * favorite_longshot_bias) need to fire on — those tend to have lower volume
 * but high `MarketScorer.score`. This module replaces the pure-volume sort
 * with a rank-based blend of volume and `market_score`, plus an opt-in
 * `FORCE_INCLUDE_MARKET_IDS` env knob for controlled experiments.
 *
 * Pure: no DB / env access from `rankMarketsByVolumeScoreBlend`. Env access
 * is isolated to the parse helpers so the wiring can be tested with explicit
 * inputs.
 */

export interface RankableMarket {
  id: string;
  volume: number;
  /** `markets.market_score`. Optional — populated when PolymarketService
   *  fetches it from the DB. Absent markets sink to the bottom of the score
   *  ranking but remain selectable via the volume rank. */
  marketScore?: number;
}

/** Default ratio of volume vs market_score in the blended rank. 0.5 means
 *  equal weight. Configurable via `MARKET_SELECTION_VOLUME_WEIGHT` env. */
export const DEFAULT_VOLUME_WEIGHT = 0.5;

/**
 * Parse `FORCE_INCLUDE_MARKET_IDS` env var into a Set of market IDs.
 *
 * Comma-separated, whitespace-tolerant. Empty / unset → empty set (no-op).
 * Markets in the returned set will be added to the active set regardless of
 * volume / score / diversification rules. Useful for diagnostic experiments
 * ("force the longshot 1323366 in so we can validate that
 * favorite_longshot_bias actually fires on it end-to-end").
 */
export function parseForceIncludeIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Parse `MARKET_SELECTION_VOLUME_WEIGHT` env var (a number in [0, 1]).
 *
 * `1` reproduces the legacy pure-volume behaviour. `0` selects purely by
 * market_score. Default (`0.5`) gives equal weight, the recommended
 * starting point. Invalid input falls back to default to avoid silent
 * misconfiguration.
 */
export function parseVolumeWeight(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_VOLUME_WEIGHT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_VOLUME_WEIGHT;
  return Math.max(0, Math.min(1, parsed));
}

export interface RankedMarket<T extends RankableMarket> {
  market: T;
  /** Normalised rank in `[1/N, 1]`; lower is better. */
  blendedRank: number;
  /** 1-indexed rank by volume (1 = highest volume). */
  volumeRank: number;
  /** 1-indexed rank by market_score (1 = highest). Markets without a score
   *  share the bottom rank — counted once per missing-score entry. */
  scoreRank: number;
}

/**
 * Rank a list of markets by a convex combination of volume rank and
 * market_score rank. Returns markets sorted ascending by blended rank
 * (best first).
 *
 * Why rank-based and not value-based: one whale market with 100× the
 * volume of the rest would dominate any value-based blend. Ranks compress
 * everything into `[1, N]` so a high-score-low-volume market and a
 * high-volume-mediocre-score market can both surface.
 */
export function rankMarketsByVolumeScoreBlend<T extends RankableMarket>(
  markets: T[],
  volumeWeight: number,
): RankedMarket<T>[] {
  if (markets.length === 0) return [];

  const N = markets.length;
  const w = Math.max(0, Math.min(1, volumeWeight));

  // Volume rank: 1 = highest volume. Stable sort preserves input order on ties.
  const byVolume = [...markets].sort((a, b) => b.volume - a.volume);
  const volumeRankMap = new Map<string, number>();
  byVolume.forEach((m, i) => volumeRankMap.set(m.id, i + 1));

  // Score rank: 1 = highest score. Markets without a score get pushed to the
  // bottom — they share the same effective rank N. This way a market with
  // missing score is comparable but never beats a scored market on the
  // score axis.
  const byScore = [...markets].sort((a, b) => {
    const aScore = a.marketScore ?? -Infinity;
    const bScore = b.marketScore ?? -Infinity;
    return bScore - aScore;
  });
  const scoreRankMap = new Map<string, number>();
  byScore.forEach((m, i) => scoreRankMap.set(m.id, i + 1));

  const ranked = markets.map((market) => {
    const volumeRank = volumeRankMap.get(market.id)!;
    const scoreRank = scoreRankMap.get(market.id)!;
    // Normalise to [1/N, 1]; lower is better.
    const blendedRank = (w * volumeRank + (1 - w) * scoreRank) / N;
    return { market, blendedRank, volumeRank, scoreRank };
  });

  ranked.sort((a, b) => a.blendedRank - b.blendedRank);
  return ranked;
}
