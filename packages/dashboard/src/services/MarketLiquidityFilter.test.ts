import { describe, it, expect } from 'vitest';
import {
  filterMarketsByLiquidity,
  parseLiquidityFilterEnv,
  DEFAULT_LIQUIDITY_FILTER_PARAMS,
  type MarketWithSpread,
} from './MarketLiquidityFilter.js';

describe('filterMarketsByLiquidity', () => {
  describe('default thresholds (5% spread)', () => {
    it('keeps markets below threshold', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: 0.02 },
        { marketId: 'b', spreadPct: 0.04 },
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, DEFAULT_LIQUIDITY_FILTER_PARAMS);
      expect(kept.map(m => m.marketId)).toEqual(['a', 'b']);
      expect(filtered).toEqual([]);
    });

    it('filters out markets at or above threshold (strict >)', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: 0.05 },  // exactly threshold — KEEP (>= boundary not strict)
        { marketId: 'b', spreadPct: 0.0501 },
        { marketId: 'c', spreadPct: 0.20 },
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, { maxSpreadPct: 0.05, filterMissing: false });
      expect(kept.map(m => m.marketId)).toEqual(['a']);
      expect(filtered.map(m => m.marketId)).toEqual(['b', 'c']);
    });
  });

  describe('missing orderbook data', () => {
    it('keeps markets without spread data by default (filterMissing=false)', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: 0.02 },
        { marketId: 'b' },  // no orderbook data
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, { maxSpreadPct: 0.05, filterMissing: false });
      expect(kept.map(m => m.marketId)).toEqual(['a', 'b']);
      expect(filtered).toEqual([]);
    });

    it('filters markets without spread data when filterMissing=true', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: 0.02 },
        { marketId: 'b' },
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, { maxSpreadPct: 0.05, filterMissing: true });
      expect(kept.map(m => m.marketId)).toEqual(['a']);
      expect(filtered.map(m => m.marketId)).toEqual(['b']);
    });
  });

  describe('edge cases', () => {
    it('handles empty list', () => {
      const { kept, filtered } = filterMarketsByLiquidity([], DEFAULT_LIQUIDITY_FILTER_PARAMS);
      expect(kept).toEqual([]);
      expect(filtered).toEqual([]);
    });

    it('handles negative spreads as missing data (data corruption)', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: -0.01 },
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, { maxSpreadPct: 0.05, filterMissing: false });
      // Negative spread = data corruption. Conservative: treat as missing → keep when filterMissing=false.
      expect(kept.map(m => m.marketId)).toEqual(['a']);
      expect(filtered).toEqual([]);
    });

    it('handles NaN spreads as missing data', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: NaN },
      ];
      const { kept } = filterMarketsByLiquidity(markets, { maxSpreadPct: 0.05, filterMissing: false });
      expect(kept.map(m => m.marketId)).toEqual(['a']);
    });
  });

  describe('threshold parameter respected', () => {
    it('uses a relaxed 10% threshold', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: 0.06 },  // would be filtered at 5%
        { marketId: 'b', spreadPct: 0.11 },
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, { maxSpreadPct: 0.10, filterMissing: false });
      expect(kept.map(m => m.marketId)).toEqual(['a']);
      expect(filtered.map(m => m.marketId)).toEqual(['b']);
    });

    it('with maxSpreadPct=Infinity, nothing is filtered by spread', () => {
      const markets: MarketWithSpread[] = [
        { marketId: 'a', spreadPct: 0.50 },
      ];
      const { kept, filtered } = filterMarketsByLiquidity(markets, { maxSpreadPct: Infinity, filterMissing: false });
      expect(kept.map(m => m.marketId)).toEqual(['a']);
      expect(filtered).toEqual([]);
    });
  });
});

describe('parseLiquidityFilterEnv', () => {
  it('returns disabled when env var unset', () => {
    const result = parseLiquidityFilterEnv(undefined);
    expect(result.enabled).toBe(false);
  });

  it('returns disabled when env var is "false"', () => {
    expect(parseLiquidityFilterEnv('false').enabled).toBe(false);
    expect(parseLiquidityFilterEnv('0').enabled).toBe(false);
    expect(parseLiquidityFilterEnv('').enabled).toBe(false);
  });

  it('returns enabled with defaults when env var is "true"', () => {
    const result = parseLiquidityFilterEnv('true');
    expect(result.enabled).toBe(true);
    expect(result.params).toEqual(DEFAULT_LIQUIDITY_FILTER_PARAMS);
  });

  it('accepts numeric threshold form: "0.07"', () => {
    const result = parseLiquidityFilterEnv('0.07');
    expect(result.enabled).toBe(true);
    expect(result.params.maxSpreadPct).toBe(0.07);
  });

  it('ignores invalid numeric values, falls back to disabled', () => {
    const result = parseLiquidityFilterEnv('abc');
    expect(result.enabled).toBe(false);
  });

  it('clamps absurd thresholds to a sensible bound', () => {
    // > 1.0 means "100% spread allowed" — clearly a typo. Cap at 1.0.
    const result = parseLiquidityFilterEnv('2.0');
    expect(result.enabled).toBe(true);
    expect(result.params.maxSpreadPct).toBeLessThanOrEqual(1.0);
  });
});
