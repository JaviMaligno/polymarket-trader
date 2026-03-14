import { describe, it, expect } from 'vitest';

function filterMarkets(markets: Array<{ currentPrice: number; isActive?: boolean; isResolved?: boolean }>) {
  const MIN_PRICE = 0.05;
  const MAX_PRICE = 0.95;
  const FIFTY_FIFTY_MIN = 0.45;
  const FIFTY_FIFTY_MAX = 0.55;

  return markets.filter(m => {
    if (m.isActive === false) return false;
    if (m.isResolved === true) return false;
    const price = m.currentPrice;
    if (price < MIN_PRICE || price > MAX_PRICE) return false;
    if (price >= FIFTY_FIFTY_MIN && price <= FIFTY_FIFTY_MAX) return false;
    return true;
  });
}

describe('setActiveMarkets 50/50 filter', () => {
  it('should filter out markets at exactly 0.50', () => {
    const markets = [
      { currentPrice: 0.50, isActive: true },
      { currentPrice: 0.30, isActive: true },
    ];
    expect(filterMarkets(markets)).toHaveLength(1);
    expect(filterMarkets(markets)[0].currentPrice).toBe(0.30);
  });

  it('should filter out markets in 0.45-0.55 range', () => {
    const markets = [
      { currentPrice: 0.45, isActive: true },
      { currentPrice: 0.55, isActive: true },
      { currentPrice: 0.44, isActive: true },
      { currentPrice: 0.56, isActive: true },
    ];
    const filtered = filterMarkets(markets);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(m => m.currentPrice)).toEqual([0.44, 0.56]);
  });

  it('should keep markets outside 50/50 range', () => {
    const markets = [
      { currentPrice: 0.10, isActive: true },
      { currentPrice: 0.90, isActive: true },
    ];
    expect(filterMarkets(markets)).toHaveLength(2);
  });

  it('should still filter extreme prices', () => {
    const markets = [
      { currentPrice: 0.03, isActive: true },
      { currentPrice: 0.97, isActive: true },
    ];
    expect(filterMarkets(markets)).toHaveLength(0);
  });
});
