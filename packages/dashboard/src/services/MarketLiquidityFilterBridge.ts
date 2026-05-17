import {
  filterMarketsByLiquidity,
  loadMarketSpreads,
  parseLiquidityFilterEnv,
} from './MarketLiquidityFilter.js';

/**
 * Bridge between PolymarketService and the (pure + DB-bound) liquidity
 * filter. Reads the ENABLE_LIQUIDITY_FILTER env var, loads spreads for the
 * given markets when enabled, and returns a filtered copy of the input.
 *
 * No-op (returns the input unchanged) when the env var is unset, "false",
 * or invalid. Always logs the filter outcome so operators can see impact
 * before tightening the gate.
 *
 * Generic over the market shape — only `id` is required. Keeps the pure
 * filter agnostic to `ActiveMarket` and other consumer-specific types.
 */
export async function applyLiquidityFilter<T extends { id: string }>(
  markets: T[],
): Promise<T[]> {
  const envParse = parseLiquidityFilterEnv(process.env.ENABLE_LIQUIDITY_FILTER);
  if (!envParse.enabled || markets.length === 0) {
    return markets;
  }

  const spreads = await loadMarketSpreads(markets.map((m) => m.id));
  const withSpread = markets.map((m) => ({
    marketId: m.id,
    spreadPct: spreads.get(m.id),
  }));
  const { kept, filtered } = filterMarketsByLiquidity(withSpread, envParse.params);
  const keptIds = new Set(kept.map((m) => m.marketId));

  console.log(
    `[LiquidityFilter] threshold=${envParse.params.maxSpreadPct} kept=${kept.length} filtered=${filtered.length} (missing_data=${
      withSpread.filter((m) => m.spreadPct === undefined).length
    })`,
  );

  return markets.filter((m) => keptIds.has(m.id));
}
