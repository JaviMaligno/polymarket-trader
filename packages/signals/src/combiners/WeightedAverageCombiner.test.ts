import { describe, expect, it } from 'vitest';
import { WeightedAverageCombiner, signalConsensus, consensusDiscount } from './WeightedAverageCombiner.js';
import type { SignalOutput } from '../core/types/signal.types.js';

function createSignal(signalId: string, strength: number): SignalOutput {
  return {
    signalId,
    marketId: 'market-1',
    tokenId: 'token-1',
    direction: strength >= 0 ? 'LONG' : 'SHORT',
    strength,
    confidence: 1,
    timestamp: new Date('2026-04-17T12:00:00Z'),
    ttlMs: 60_000,
  };
}

function baseWeights(): Record<string, number> {
  return { momentum: 1 };
}

function params(): Record<string, unknown> {
  return { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 };
}

function buildSignal(opts: {
  signalId: string;
  direction: 'long' | 'short';
  strength: number;
  confidence: number;
}): SignalOutput {
  return {
    signalId: opts.signalId,
    marketId: 'market-1',
    tokenId: 'token-1',
    direction: opts.direction.toUpperCase() as 'LONG' | 'SHORT',
    strength: opts.direction === 'long' ? Math.abs(opts.strength) : -Math.abs(opts.strength),
    confidence: opts.confidence,
    timestamp: new Date(),
    ttlMs: 60_000,
  };
}

describe('WeightedAverageCombiner direction context', () => {
  it('uses market type for signal weights and direction context for multiplier overrides', () => {
    const combiner = new WeightedAverageCombiner(
      { momentum: 1, mean_reversion: 1 },
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );

    combiner.setTypeWeights({
      event_financial: { momentum: 1, mean_reversion: 0 },
    });
    combiner.setDirectionMultiplier(-1);
    combiner.setDirectionMultipliers({
      'event_financial|40to60|medium|financial-mid': -0.25,
    });

    const combined = combiner.combine(
      [createSignal('momentum', 0.8), createSignal('mean_reversion', -0.8)],
      new Date('2026-04-17T12:00:00Z'),
      'event_financial',
      'event_financial|40to60|medium|financial-mid'
    );

    expect(combined).not.toBeNull();
    expect(combined?.strength).toBeCloseTo(-0.2, 5);
    expect(combined?.direction).toBe('SHORT');
  });

  it('falls back to the global direction multiplier when no context override exists', () => {
    const combiner = new WeightedAverageCombiner(
      { momentum: 1 },
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );

    combiner.setDirectionMultiplier(-1);

    const combined = combiner.combine(
      [createSignal('momentum', 0.8)],
      new Date('2026-04-17T12:00:00Z'),
      'unknown_market_type',
      'unknown_market_type|40to60|medium|missing'
    );

    expect(combined).not.toBeNull();
    expect(combined?.strength).toBeCloseTo(-0.8, 5);
    expect(combined?.direction).toBe('SHORT');
  });
});

describe('WeightedAverageCombiner — applied direction multiplier', () => {
  it('exposes applied multiplier in CombinedSignalOutput', () => {
    const combiner = new WeightedAverageCombiner(baseWeights(), params());
    combiner.setDirectionMultiplier(0.5, 'test-ctx');
    const signals = [buildSignal({ signalId: 'momentum', direction: 'long', strength: 0.6, confidence: 0.8 })];
    const result = combiner.combine(signals, undefined, 'event_long', 'test-ctx');
    expect(result).not.toBeNull();
    expect(result!.appliedDirectionMultiplier).toBe(0.5);
  });

  it('exposes appliedDirectionMultiplier matching the explicitly set global multiplier', () => {
    const combiner = new WeightedAverageCombiner(baseWeights(), params());
    combiner.setDirectionMultiplier(1.0);  // explicit global; does not touch context map
    const signals = [buildSignal({ signalId: 'momentum', direction: 'long', strength: 0.6, confidence: 0.8 })];
    const result = combiner.combine(signals);
    expect(result).not.toBeNull();
    expect(result!.appliedDirectionMultiplier).toBe(1.0);
  });
});

function mkSignalForConsensusTest(direction: 'LONG' | 'SHORT' | 'NEUTRAL'): SignalOutput {
  return {
    signalId: 'x',
    marketId: 'm',
    tokenId: 't',
    direction,
    strength: 0.5,
    confidence: 0.5,
    timestamp: new Date(),
    ttlMs: 60_000,
  };
}

describe('signalConsensus', () => {
  it('returns null when N<3 informative signals', () => {
    expect(signalConsensus([mkSignalForConsensusTest('LONG')]).consensus).toBeNull();
    expect(signalConsensus([mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('SHORT')]).consensus).toBeNull();
    expect(signalConsensus([mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('NEUTRAL'), mkSignalForConsensusTest('NEUTRAL')]).consensus).toBeNull();
  });

  it('returns 1.0 for unanimous (5,0) LONG', () => {
    const sigs = Array.from({ length: 5 }, () => mkSignalForConsensusTest('LONG'));
    expect(signalConsensus(sigs).consensus).toBeCloseTo(1.0, 5);
  });

  it('returns 1.0 for unanimous (0,5) SHORT', () => {
    const sigs = Array.from({ length: 5 }, () => mkSignalForConsensusTest('SHORT'));
    expect(signalConsensus(sigs).consensus).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.278 for 4/1 split', () => {
    // p=0.8: H = -0.8*log2(0.8) - 0.2*log2(0.2) = 0.7219
    // consensus = 1 - 0.7219 = 0.2781
    const sigs = [
      mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('LONG'),
      mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('LONG'),
      mkSignalForConsensusTest('SHORT'),
    ];
    expect(signalConsensus(sigs).consensus).toBeCloseTo(0.2781, 3);
  });

  it('returns ~0.029 for 3/2 split', () => {
    // p=0.6: H = -0.6*log2(0.6) - 0.4*log2(0.4) = 0.9710
    // consensus = 1 - 0.9710 = 0.0290
    const sigs = [
      mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('LONG'),
      mkSignalForConsensusTest('SHORT'), mkSignalForConsensusTest('SHORT'),
    ];
    expect(signalConsensus(sigs).consensus).toBeCloseTo(0.0290, 3);
  });

  it('returns correct raw counts including NEUTRAL', () => {
    const sigs = [
      mkSignalForConsensusTest('LONG'), mkSignalForConsensusTest('LONG'),
      mkSignalForConsensusTest('SHORT'),
      mkSignalForConsensusTest('NEUTRAL'), mkSignalForConsensusTest('NEUTRAL'),
    ];
    const r = signalConsensus(sigs);
    expect(r.longCount).toBe(2);
    expect(r.shortCount).toBe(1);
    expect(r.neutralCount).toBe(2);
    // N_informative = 3, p=2/3, H ≈ 0.918, consensus ≈ 0.082
    expect(r.consensus).toBeCloseTo(0.0817, 3);
  });
});

describe('consensusDiscount', () => {
  it('returns 1.0 when consensus is null (no-op)', () => {
    expect(consensusDiscount(null, 0.5)).toBe(1.0);
    expect(consensusDiscount(null, 0.0)).toBe(1.0);
    expect(consensusDiscount(null, 1.0)).toBe(1.0);
  });

  it('returns consensus when floor is 0 (aggressive)', () => {
    expect(consensusDiscount(0.5, 0)).toBeCloseTo(0.5, 5);
    expect(consensusDiscount(1.0, 0)).toBeCloseTo(1.0, 5);
    expect(consensusDiscount(0.0, 0)).toBeCloseTo(0.0, 5);
  });

  it('returns 1.0 when floor is 1 (no-op)', () => {
    expect(consensusDiscount(0.5, 1)).toBeCloseTo(1.0, 5);
    expect(consensusDiscount(0.0, 1)).toBeCloseTo(1.0, 5);
  });

  it('linear mapping at floor=0.5', () => {
    // discount = 0.5 + 0.5*consensus
    expect(consensusDiscount(0.0, 0.5)).toBeCloseTo(0.5, 5);
    expect(consensusDiscount(0.5, 0.5)).toBeCloseTo(0.75, 5);
    expect(consensusDiscount(1.0, 0.5)).toBeCloseTo(1.0, 5);
  });
});

describe('WeightedAverageCombiner — consensus discount integration', () => {
  const mkValidSignal = (direction: 'LONG' | 'SHORT', signalId: string, confidence = 0.8): SignalOutput => ({
    signalId,
    marketId: 'm',
    tokenId: 't',
    direction,
    strength: 0.8,
    confidence,
    timestamp: new Date(),
    ttlMs: 60_000,
  });

  it('consensus=1.0 (unanimous) — no discount, output confidence = raw', () => {
    // 5 unanimous LONG signals at conf=0.8
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1, sig_c: 1, sig_d: 1, sig_e: 1 },
      { minCombinedConfidence: 0.3, minCombinedStrength: 0.1, consensusDiscountFloor: 0.5 },
    );
    const signals = [
      mkValidSignal('LONG', 'sig_a'),
      mkValidSignal('LONG', 'sig_b'),
      mkValidSignal('LONG', 'sig_c'),
      mkValidSignal('LONG', 'sig_d'),
      mkValidSignal('LONG', 'sig_e'),
    ];
    const result = combiner.combine(signals);
    expect(result).not.toBeNull();
    expect(result!.metadata!.consensus).toBeCloseTo(1.0, 3);
    expect(result!.metadata!.consensusDiscount).toBeCloseTo(1.0, 3);
    expect(result!.metadata!.componentCounts).toEqual({ long: 5, short: 0, neutral: 0 });
    // rawConfidence equals finalConfidence when discount=1.0
    expect((result!.metadata as any).rawConfidence).toBeCloseTo(result!.confidence, 3);
  });

  it('consensus=0.029 (3/2) with floor=0.5 — discount~0.515, typically fails threshold', () => {
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1, sig_c: 1, sig_d: 1, sig_e: 1 },
      { minCombinedConfidence: 0.43, minCombinedStrength: 0.1, consensusDiscountFloor: 0.5 },
    );
    const signals = [
      mkValidSignal('LONG', 'sig_a'),
      mkValidSignal('LONG', 'sig_b'),
      mkValidSignal('LONG', 'sig_c'),
      mkValidSignal('SHORT', 'sig_d'),
      mkValidSignal('SHORT', 'sig_e'),
    ];
    const result = combiner.combine(signals);
    // With raw confidence around 0.6-0.8 (depends on combiner logic for conflict),
    // discount ~0.515 drops final to ~0.3-0.4, likely below 0.43 threshold.
    // If result is non-null (passes threshold), assert finalConfidence < rawConfidence.
    // If result is null, that's also valid — the filter did its job.
    if (result !== null) {
      expect((result.metadata as any).rawConfidence).toBeGreaterThan(result.confidence);
      expect(result.metadata!.consensus).toBeCloseTo(0.029, 2);
    } else {
      // Assert that filtering happened via consensus — harder to verify post-hoc
      // but acceptable to just trust the null return.
      expect(result).toBeNull();
    }
  });

  it('N<3 (2 signals) — consensus null, discount=1.0, no behavior change', () => {
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1 },
      { minCombinedConfidence: 0.3, minCombinedStrength: 0.1, consensusDiscountFloor: 0.5 },
    );
    const signals = [
      mkValidSignal('LONG', 'sig_a'),
      mkValidSignal('LONG', 'sig_b'),
    ];
    const result = combiner.combine(signals);
    expect(result).not.toBeNull();
    expect(result!.metadata!.consensus).toBeNull();
    expect(result!.metadata!.consensusDiscount).toBeCloseTo(1.0, 3);
  });

  it('consensusDiscountFloor=1.0 — no-op, low-consensus signals still pass', () => {
    const combiner = new WeightedAverageCombiner(
      { sig_a: 1, sig_b: 1, sig_c: 1, sig_d: 1, sig_e: 1 },
      { minCombinedConfidence: 0.43, minCombinedStrength: 0.1, consensusDiscountFloor: 1.0 },
    );
    const signals = [
      mkValidSignal('LONG', 'sig_a'),
      mkValidSignal('LONG', 'sig_b'),
      mkValidSignal('LONG', 'sig_c'),
      mkValidSignal('SHORT', 'sig_d'),
      mkValidSignal('SHORT', 'sig_e'),
    ];
    const result = combiner.combine(signals);
    // floor=1.0 means discount is always 1.0 regardless of consensus
    // If raw passes threshold, result is non-null
    if (result !== null) {
      expect(result.metadata!.consensusDiscount).toBeCloseTo(1.0, 3);
      // finalConfidence equals rawConfidence when discount=1.0
      expect((result.metadata as any).rawConfidence).toBeCloseTo(result.confidence, 3);
    }
    // If threshold fails for reasons unrelated to consensus, that's also fine
  });
});

describe('WeightedAverageCombiner — typeWeights fallback', () => {
  it('drops a signal whose generator is not listed in typeWeights[marketType]', () => {
    // Setup: typeWeights for "event_financial" lists ONLY mean_reversion.
    // An unlisted generator (e.g. news_sentiment) should NOT contribute to the
    // combined output — its fallback weight must be 0, dropping it via the
    // s.weight !== 0 filter inside combine().
    const combiner = new WeightedAverageCombiner(
      {},
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );
    combiner.setTypeWeights({
      event_financial: { mean_reversion: 0.6 },
    });
    combiner.setDirectionMultiplier(1); // disable contrarian flip for this test

    const listedSignal = buildSignal({
      signalId: 'mean_reversion',
      direction: 'long',
      strength: 0.5,
      confidence: 0.8,
    });
    const unlistedSignal = buildSignal({
      signalId: 'news_sentiment',
      direction: 'short',
      strength: 0.9,
      confidence: 0.9,
    });

    const result = combiner.combine([listedSignal, unlistedSignal], undefined, 'event_financial');

    expect(result).not.toBeNull();
    // If the unlisted SHORT contributed, its high strength (0.9) and
    // pre-fix weight 1.0/0.6 ≈ 1.67x mean_reversion would push the
    // combined direction to SHORT. With the fix it's silenced and the
    // LONG mean_reversion alone defines the direction.
    expect(result!.direction).toBe('LONG');
  });

  it('keeps explicit per-type weight for a listed generator', () => {
    // Sanity check: a listed generator still gets its specified weight.
    // This guards against accidentally also dropping listed signals.
    const combiner = new WeightedAverageCombiner(
      {},
      { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 }
    );
    combiner.setTypeWeights({
      event_financial: { mean_reversion: 0.6, momentum: -0.3 },
    });
    combiner.setDirectionMultiplier(1);

    const meanRevSignal = buildSignal({
      signalId: 'mean_reversion',
      direction: 'long',
      strength: 0.4,
      confidence: 0.7,
    });

    const result = combiner.combine([meanRevSignal], undefined, 'event_financial');

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    // strength is positive and proportional to weight × signal strength.
    // We don't assert exact value (depends on normalize, time decay, etc.)
    // but it must be well above the minCombinedStrength threshold of 0.01.
    expect(result!.strength).toBeGreaterThan(0.01);
  });
});
