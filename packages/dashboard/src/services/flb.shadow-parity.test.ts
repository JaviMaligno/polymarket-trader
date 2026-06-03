import { describe, it, expect } from 'vitest';
import { computeExecutedNoPrice, settle } from './flbMath.js';

// Shadow recorder (flb-shadow-snapshot.js) net per unit, zero entry cost:
//   NO  -> entry_yes / (1 - entry_yes)
//   YES -> -1
function shadowNetPerDollar(yes: number, outcome: 'yes' | 'no'): number {
  return outcome === 'no' ? yes / (1 - yes) : -1;
}

describe('FLB executor ties out to the shadow recorder at zero spread', () => {
  for (const yes of [0.02, 0.05, 0.08, 0.10]) {
    it(`NO resolution matches shadow at yes=${yes}`, () => {
      const executedNoPrice = computeExecutedNoPrice(yes, 0); // spread 0
      const stake = 100;
      const noSize = stake / executedNoPrice;
      const { netPnl } = settle(stake, noSize, 0, 'no');
      const perDollar = netPnl / stake;
      expect(perDollar).toBeCloseTo(shadowNetPerDollar(yes, 'no'), 6);
    });
    it(`YES wipeout matches shadow at yes=${yes}`, () => {
      const executedNoPrice = computeExecutedNoPrice(yes, 0);
      const stake = 100;
      const noSize = stake / executedNoPrice;
      const { netPnl } = settle(stake, noSize, 0, 'yes');
      expect(netPnl / stake).toBeCloseTo(shadowNetPerDollar(yes, 'yes'), 6);
    });
  }
});
