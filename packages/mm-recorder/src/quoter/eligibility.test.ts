import { describe, it, expect } from 'vitest';
import { EligibilityTracker } from './eligibility.js';

const at = (h: number, m: number) => new Date(Date.UTC(2026, 5, 12, h, m, 0));

describe('EligibilityTracker', () => {
  it('accumulates eligible minutes in memory and flushes one row per market-hour', () => {
    const tr = new EligibilityTracker();
    // dos muestras del mismo minuto cuentan una vez
    tr.sample('M1', at(10, 0), true);
    tr.sample('M1', at(10, 0), true);
    tr.sample('M1', at(10, 1), true);
    tr.sample('M1', at(10, 2), false); // quoted pero no elegible
    const rows = tr.flushHour(at(11, 0));
    expect(rows).toEqual([
      { hour: at(10, 0), marketId: 'M1', eligibleMinutes: 2, quotedMinutes: 3 },
    ]);
    expect(tr.flushHour(at(11, 0))).toEqual([]); // ya flusheado
  });

  it('does not flush the still-open hour', () => {
    const tr = new EligibilityTracker();
    tr.sample('M1', at(10, 30), true);
    expect(tr.flushHour(at(10, 45))).toEqual([]);
  });
});
