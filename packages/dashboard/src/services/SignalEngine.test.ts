import { describe, it, expect } from 'vitest';

/**
 * Extract the pure Bayesian confidence cap computation for testing.
 * Mirrors the logic in SignalEngine.computeBayesianConfidenceCap().
 *
 * The Beta-Binomial model uses variance reduction from a Beta(1,1) prior.
 * With many observations, posterior variance is always much smaller than prior
 * variance, so the cap is high even with 0 informative bars. The MIN_CAP
 * floor is a safety net for very small sample sizes.
 */
function computeBayesianConfidenceCap(
  priceBars: { close: number; source?: string }[],
  minCap: number = 0.15
): number {
  const totalBars = priceBars.length;
  if (totalBars === 0) return 0;

  let informativeBars = 0;
  for (let i = 1; i < priceBars.length; i++) {
    const priceChanged = Math.abs(priceBars[i].close - priceBars[i - 1].close) > 1e-8;
    const isRealTrade = priceBars[i].source === 'trade';
    if (priceChanged || isRealTrade) informativeBars++;
  }

  const alpha0 = 1, beta0 = 1;
  const alpha = alpha0 + informativeBars;
  const beta = beta0 + (totalBars - informativeBars);
  const priorVar = (alpha0 * beta0) / ((alpha0 + beta0) ** 2 * (alpha0 + beta0 + 1));
  const posteriorVar = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const cap = 1 - (posteriorVar / priorVar);
  return Math.max(minCap, Math.min(1, cap));
}

describe('Bayesian Confidence Cap', () => {
  it('returns 0 for empty bars', () => {
    expect(computeBayesianConfidenceCap([])).toBe(0);
  });

  it('returns minCap floor for single bar', () => {
    // 1 bar: totalBars=1, loop doesn't execute, informativeBars=0
    // alpha=1, beta=2 => posteriorVar=2/36=0.0556, priorVar=1/12=0.0833
    // cap = 1 - 0.667 = 0.333 > minCap=0.15
    const bars = [{ close: 0.5, source: 'snapshot' }];
    const cap = computeBayesianConfidenceCap(bars);
    expect(cap).toBeGreaterThanOrEqual(0.15);
    expect(cap).toBeLessThan(0.5);
  });

  it('returns high cap when prices change frequently with trade source', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      close: 0.5 + i * 0.01,
      source: 'trade',
    }));
    // All 19 comparisons are informative (price changes + trade source)
    expect(computeBayesianConfidenceCap(bars)).toBeGreaterThan(0.8);
  });

  it('counts trade-sourced bars as informative even if price unchanged', () => {
    // 10 bars, all same price, all source='trade'
    // informativeBars = 9 (all counted as trade), totalBars=10
    const tradeBars = Array.from({ length: 10 }, () => ({
      close: 0.5,
      source: 'trade',
    }));
    const tradeCap = computeBayesianConfidenceCap(tradeBars);

    // Trade bars should produce a meaningfully high cap (well above minCap)
    expect(tradeCap).toBeGreaterThan(0.5);

    // Verify trade source DOES count as informative by checking informativeBars > 0
    // If source wasn't checked, informativeBars would be 0 (same prices)
    // With informativeBars=9: alpha=10, beta=2 => different posterior than informativeBars=0
    // We verify by comparing against bars that have changing prices but no trade source
    const changingPriceBars = Array.from({ length: 10 }, (_, i) => ({
      close: 0.5 + i * 0.001,
      source: 'snapshot' as string,
    }));
    const changingCap = computeBayesianConfidenceCap(changingPriceBars);
    // Both have 9 informative bars (trade vs price-change), so caps should be equal
    expect(tradeCap).toBeCloseTo(changingCap, 10);
  });

  it('treats bars without source as non-trade (snapshot-like)', () => {
    // Bars with no source and same price: no informative bars
    const noSource = Array.from({ length: 10 }, () => ({ close: 0.5 }));
    const withSnapshot = Array.from({ length: 10 }, () => ({
      close: 0.5,
      source: 'snapshot',
    }));

    // Both should produce the same cap (no informative bars in either case)
    expect(computeBayesianConfidenceCap(noSource))
      .toBe(computeBayesianConfidenceCap(withSnapshot));
  });

  it('increases cap as more informative bars are added', () => {
    // 5 informative out of 10 (price changes starting at index 5)
    const mixed5 = Array.from({ length: 10 }, (_, i) => ({
      close: i < 5 ? 0.5 : 0.5 + (i - 4) * 0.01,
      source: 'snapshot' as string,
    }));
    const cap5 = computeBayesianConfidenceCap(mixed5);

    // 9 informative out of 10 (all prices different)
    const mixed9 = Array.from({ length: 10 }, (_, i) => ({
      close: 0.5 + i * 0.01,
      source: 'snapshot' as string,
    }));
    const cap9 = computeBayesianConfidenceCap(mixed9);

    expect(cap9).toBeGreaterThan(cap5);
  });

  it('minCap floor prevents 0 for very few non-informative bars', () => {
    // 2 bars, same price, snapshot: informativeBars=0, totalBars=2
    // alpha=1, beta=3 => posteriorVar=3/48=0.0625, priorVar=0.0833
    // cap = 1 - 0.75 = 0.25 > 0.15
    const bars = [
      { close: 0.5, source: 'snapshot' },
      { close: 0.5, source: 'snapshot' },
    ];
    const cap = computeBayesianConfidenceCap(bars);
    expect(cap).toBeGreaterThanOrEqual(0.15);
  });

  it('cap is always between minCap and 1 for non-empty bars', () => {
    // Test with various sizes
    for (const n of [2, 5, 10, 50, 100]) {
      const bars = Array.from({ length: n }, () => ({
        close: 0.5,
        source: 'snapshot',
      }));
      const cap = computeBayesianConfidenceCap(bars);
      expect(cap).toBeGreaterThanOrEqual(0.15);
      expect(cap).toBeLessThanOrEqual(1);
    }
  });

  it('respects custom minCap of 0 (no floor)', () => {
    // With minCap=0, result should still be positive (variance always reduces)
    const bars = Array.from({ length: 5 }, () => ({ close: 0.5, source: 'snapshot' }));
    const cap = computeBayesianConfidenceCap(bars, 0.0);
    expect(cap).toBeGreaterThan(0);
  });
});

/**
 * Test the 50/50 market filter in setActiveMarkets().
 * Uses the same standalone approach: replicate the filter logic to avoid
 * importing SignalEngine (which requires @polymarket-trader/signals).
 */
describe('SignalEngine — 50/50 Market Filter', () => {
  function filterMarkets(markets: { currentPrice: number }[]): number {
    const MIN_PRICE = 0.05;
    const MAX_PRICE = 0.95;
    const FIFTY_FIFTY_MIN = 0.45;
    const FIFTY_FIFTY_MAX = 0.55;

    return markets.filter(m => {
      const price = m.currentPrice;
      if (price < MIN_PRICE || price > MAX_PRICE) return false;
      if (price >= FIFTY_FIFTY_MIN && price <= FIFTY_FIFTY_MAX) return false;
      return true;
    }).length;
  }

  it('should filter out markets with price in 0.45-0.55 range', () => {
    const markets = [
      { currentPrice: 0.50 },  // 50/50 → filtered
      { currentPrice: 0.48 },  // 50/50 → filtered
      { currentPrice: 0.70 },  // OK
      { currentPrice: 0.30 },  // OK
      { currentPrice: 0.45 },  // boundary → filtered
      { currentPrice: 0.55 },  // boundary → filtered
      { currentPrice: 0.44 },  // just outside → OK
      { currentPrice: 0.56 },  // just outside → OK
    ];

    expect(filterMarkets(markets)).toBe(4); // 0.70, 0.30, 0.44, 0.56
  });

  it('should not filter markets outside the 50/50 band', () => {
    const markets = [
      { currentPrice: 0.20 },
      { currentPrice: 0.80 },
      { currentPrice: 0.10 },
      { currentPrice: 0.90 },
    ];

    expect(filterMarkets(markets)).toBe(4);
  });

  it('should filter all if every market is 50/50', () => {
    const markets = [
      { currentPrice: 0.50 },
      { currentPrice: 0.51 },
      { currentPrice: 0.49 },
    ];

    expect(filterMarkets(markets)).toBe(0);
  });
});
