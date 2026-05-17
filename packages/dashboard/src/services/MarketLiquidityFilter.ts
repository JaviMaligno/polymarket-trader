import { query } from '../database/index.js';

/**
 * MarketLiquidityFilter
 *
 * Filters markets by orderbook spread before signal generation. Empirical
 * snapshot 2026-05-17: 30 of 54 tracked markets had spread > 5% of mid;
 * 22 had > 10%; 18 had > 20%. On a 1% generator edge, a 5% round-trip
 * spread cost is fatal — the trade is dead before it opens. The filter
 * gives generators (and the optimizer measuring them) a chance to operate
 * on markets where their predicted edge is not immediately consumed by
 * friction.
 *
 * Default OFF behind ENABLE_LIQUIDITY_FILTER env. When enabled, the filter
 * still always logs what WOULD be filtered so operators can see the impact
 * before the gate hardens.
 */

export interface MarketWithSpread {
  marketId: string;
  /**
   * (best_ask - best_bid) / mid_price. Undefined / NaN / negative all mean
   * "no usable orderbook data" — the filter treats them per filterMissing
   * policy rather than as bad spreads.
   */
  spreadPct?: number;
}

export interface LiquidityFilterParams {
  /** Strict upper bound on accepted spread, as fraction of mid. */
  maxSpreadPct: number;
  /**
   * When `true`, markets without orderbook data are filtered (assume the
   * worst). When `false`, they pass through unchanged. Default `false` is
   * conservative — we don't want to silently drop markets just because the
   * data-collector hasn't snapshotted them yet.
   */
  filterMissing: boolean;
}

export const DEFAULT_LIQUIDITY_FILTER_PARAMS: LiquidityFilterParams = {
  maxSpreadPct: 0.05,
  filterMissing: false,
};

const SPREAD_CAP = 1.0;

/**
 * Pure: split a market list into kept/filtered by spread quality.
 *
 * Markets are filtered when `spreadPct > maxSpreadPct`. Equality is kept
 * (cheap markets right at the threshold survive; only strictly-worse get
 * dropped). Missing or invalid spread data is routed by `filterMissing`.
 */
export function filterMarketsByLiquidity(
  markets: MarketWithSpread[],
  params: LiquidityFilterParams,
): { kept: MarketWithSpread[]; filtered: MarketWithSpread[] } {
  const kept: MarketWithSpread[] = [];
  const filtered: MarketWithSpread[] = [];

  for (const market of markets) {
    const spread = market.spreadPct;
    const isUsable =
      spread !== undefined &&
      typeof spread === 'number' &&
      !Number.isNaN(spread) &&
      spread >= 0;

    if (!isUsable) {
      if (params.filterMissing) {
        filtered.push(market);
      } else {
        kept.push(market);
      }
      continue;
    }

    if (spread > params.maxSpreadPct) {
      filtered.push(market);
    } else {
      kept.push(market);
    }
  }

  return { kept, filtered };
}

export interface LiquidityFilterEnvParse {
  enabled: boolean;
  params: LiquidityFilterParams;
}

/**
 * Parse the ENABLE_LIQUIDITY_FILTER env value into a config.
 *
 * Accepted forms:
 *   - unset / "" / "false" / "0"      → disabled
 *   - "true" / "1"                     → enabled with defaults
 *   - "<number>" (e.g. "0.07")        → enabled with that threshold; clamped to [0, 1]
 *
 * Invalid values fall back to disabled so a typo never silently changes the
 * filter behaviour.
 */
export function parseLiquidityFilterEnv(raw: string | undefined): LiquidityFilterEnvParse {
  if (raw === undefined) return { enabled: false, params: DEFAULT_LIQUIDITY_FILTER_PARAMS };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'false' || trimmed === '0') {
    return { enabled: false, params: DEFAULT_LIQUIDITY_FILTER_PARAMS };
  }
  if (trimmed === 'true' || trimmed === '1') {
    return { enabled: true, params: DEFAULT_LIQUIDITY_FILTER_PARAMS };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { enabled: false, params: DEFAULT_LIQUIDITY_FILTER_PARAMS };
  }
  const clamped = Math.min(SPREAD_CAP, parsed);
  return {
    enabled: true,
    params: { ...DEFAULT_LIQUIDITY_FILTER_PARAMS, maxSpreadPct: clamped },
  };
}

/**
 * Load the latest spread per market from orderbook_snapshots. Returns a Map
 * of marketId → spreadPct (relative to mid). Markets without recent (last
 * `withinMinutes` minutes) book snapshots are absent from the Map.
 *
 * Uses a single DISTINCT ON query so it scales linearly with the tracked
 * set. The query is bounded by `withinMinutes` because a 6-hour-old book
 * is not what trading will execute against now.
 */
export async function loadMarketSpreads(
  marketIds: string[],
  options: { withinMinutes?: number } = {},
): Promise<Map<string, number>> {
  const withinMinutes = options.withinMinutes ?? 30;
  if (marketIds.length === 0) return new Map();

  const result = await query<{ market_id: string; spread_pct: string }>(
    `SELECT DISTINCT ON (market_id)
       market_id,
       (spread / NULLIF(mid_price, 0))::text AS spread_pct
     FROM orderbook_snapshots
     WHERE market_id = ANY($1::varchar[])
       AND time > NOW() - ($2::int || ' minutes')::interval
       AND spread IS NOT NULL
       AND mid_price IS NOT NULL
       AND mid_price > 0
     ORDER BY market_id, time DESC`,
    [marketIds, withinMinutes],
  );

  const map = new Map<string, number>();
  for (const row of result.rows) {
    const value = parseFloat(row.spread_pct);
    if (Number.isFinite(value) && value >= 0) {
      map.set(row.market_id, value);
    }
  }
  return map;
}
