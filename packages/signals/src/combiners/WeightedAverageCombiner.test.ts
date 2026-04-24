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
