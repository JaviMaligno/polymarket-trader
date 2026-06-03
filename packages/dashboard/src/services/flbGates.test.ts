import { describe, it, expect } from 'vitest';
import { evaluateSignal, type FLBCandidate, type FLBContext } from './flbGates.js';
import { getFLBConfig } from './FLBConfig.js';
import { isoWeekKey } from './flbMath.js';

const cfg = () => getFLBConfig(); // defaults: band [0.02,0.10], ttr 48, cost 1.0, pos 0.21, locked 5.0, sameWeek 50

function ctx(over: Partial<FLBContext> = {}): FLBContext {
  return {
    now: new Date('2026-06-03T00:00:00Z'),
    initialCapital: 10000,
    lockedCapital: 0,
    openMarketIds: new Set<string>(),
    sameWeekOpenCounts: new Map<string, number>(),
    ...over,
  };
}

function cand(over: Partial<FLBCandidate> = {}): FLBCandidate {
  return {
    marketId: 'm1', marketType: 'event_short', yesPrice: 0.05, spread: 0.01,
    ttrHours: 96, noTokenId: 'noTok', endDate: '2026-09-01T00:00:00Z',
    ...over,
  };
}

describe('evaluateSignal gate chain', () => {
  it('accepts a qualifying spread-path candidate', () => {
    const d = evaluateSignal(cand(), ctx(), cfg());
    expect(d.accept).toBe(true);
    expect(d.fillSource).toBe('spread');
    expect(d.noStake).toBeCloseTo(21, 6);
    expect(d.executedNoPrice).toBeCloseTo(0.955, 6);
    expect(d.noSize).toBeCloseTo(21 / 0.955, 6); // 21 / 0.955 ≈ 21.99
    expect(d.entryCostPct).toBeCloseTo(0.5263, 3);
    expect(d.feePaid).toBe(0);
    expect(d.slippagePct).toBe(0);
    expect(d.isoWeekKey).toBe(isoWeekKey(new Date('2026-09-01T00:00:00Z')));
  });

  it('rejects ineligible market type (flb_0a)', () => {
    const d = evaluateSignal(cand({ marketType: 'crypto_intraday' }), ctx(), cfg());
    expect(d.accept).toBe(false);
    expect(d.reason).toBe('market_type_not_eligible');
  });

  it('rejects TTR below min (flb_0b)', () => {
    expect(evaluateSignal(cand({ ttrHours: 24 }), ctx(), cfg()).reason).toBe('ttr_below_min');
  });

  it('rejects out-of-band low (flb_0c)', () => {
    expect(evaluateSignal(cand({ yesPrice: 0.01 }), ctx(), cfg()).reason).toBe('out_of_band');
  });

  it('rejects out-of-band high (flb_0c)', () => {
    expect(evaluateSignal(cand({ yesPrice: 0.15 }), ctx(), cfg()).reason).toBe('out_of_band');
  });

  it('rejects wide spread over cost ceiling (flb_0d)', () => {
    expect(evaluateSignal(cand({ spread: 0.04 }), ctx(), cfg()).reason).toBe('entry_cost_too_high');
  });

  it('rejects null/zero spread on the spread path (flb_0d)', () => {
    expect(evaluateSignal(cand({ spread: null }), ctx(), cfg()).reason).toBe('no_spread');
    expect(evaluateSignal(cand({ spread: 0 }), ctx(), cfg()).reason).toBe('no_spread');
  });

  it('uses the book-walk price when provided (flb_0d orderbook path)', () => {
    const d = evaluateSignal(cand({ bookExecuted: true, bookExecutedNoPrice: 0.953 }), ctx(), cfg());
    expect(d.accept).toBe(true);
    expect(d.fillSource).toBe('orderbook');
    expect(d.executedNoPrice).toBeCloseTo(0.953, 6);
  });

  it('rejects when the book walk is unfillable (flb_0d)', () => {
    expect(evaluateSignal(cand({ bookExecuted: false }), ctx(), cfg()).reason).toBe('book_unfillable');
  });

  it('rejects orderbook path when entry cost exceeds ceiling (flb_0d)', () => {
    // yesPrice=0.05 → noMid=0.95; bookExecutedNoPrice=0.97 → ((0.97-0.95)/0.95)*100 ≈ 2.1% > 1.0%
    const d = evaluateSignal(
      cand({ bookExecuted: true, bookExecutedNoPrice: 0.97 }),
      ctx(),
      cfg(),
    );
    expect(d.accept).toBe(false);
    expect(d.reason).toBe('entry_cost_too_high');
  });

  it('rejects when ISO-week cap reached (flb_0e)', () => {
    const endDate = '2026-09-01T00:00:00Z';
    const counts = new Map<string, number>([[isoWeekKey(new Date(endDate)), 50]]);
    const d = evaluateSignal(cand({ endDate }), ctx({ sameWeekOpenCounts: counts }), cfg());
    expect(d.reason).toBe('same_week_cap');
  });

  it('rejects when locked-capital cap would be exceeded (flb_0f)', () => {
    const d = evaluateSignal(cand(), ctx({ lockedCapital: 490 }), cfg());
    expect(d.reason).toBe('locked_capital_cap');
  });

  it('rejects a duplicate open market (flb_0g)', () => {
    const d = evaluateSignal(cand({ marketId: 'dup' }), ctx({ openMarketIds: new Set(['dup']) }), cfg());
    expect(d.reason).toBe('duplicate_market');
  });
});
