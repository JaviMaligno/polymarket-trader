import { describe, expect, it } from 'vitest';
import { WeightedAverageCombiner } from './WeightedAverageCombiner.js';
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
