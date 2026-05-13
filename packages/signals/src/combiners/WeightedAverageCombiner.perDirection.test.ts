/**
 * PR-B 2026-05-13: per-direction weight lookup + SIGNAL_DIRECTIONS_DISABLED.
 *
 * These tests exercise the combiner's per-direction lookup path in isolation
 * from the SignalEngine / DB. The goal is to prove:
 *   1. When perDirectionTypeWeights is empty, behaviour is identical to PR-A
 *      (lookup goes via typeWeights / legacy '__all__').
 *   2. When a per-direction weight exists, it overrides the legacy '__all__'
 *      value for that (signalId, direction).
 *   3. When a per-direction weight is MISSING for one direction but exists for
 *      the other, the missing direction falls back to '__all__'.
 *   4. disabledSignalDirections (signalId:direction) zeroes the weight for
 *      ONLY the specified direction; the other direction is unaffected.
 *   5. parameter set/get round-trip works.
 */
import { describe, expect, it } from 'vitest';
import { WeightedAverageCombiner } from './WeightedAverageCombiner.js';
import type { SignalOutput } from '../core/types/signal.types.js';

function sig(
  signalId: string,
  direction: 'LONG' | 'SHORT',
  strength: number,
  marketType = 'event_financial'
): SignalOutput {
  return {
    signalId,
    marketId: 'm-1',
    tokenId: 't-1',
    direction,
    strength,
    confidence: 1,
    timestamp: new Date(),
    ttlMs: 60_000,
    metadata: { marketType },
  };
}

describe('WeightedAverageCombiner per-direction (PR-B)', () => {
  const baseParams = { minCombinedStrength: 0.01, minCombinedConfidence: 0.01 };

  it("falls back to typeWeights ('__all__') when no per-direction row exists", () => {
    const c = new WeightedAverageCombiner({ momentum: 1 }, baseParams);
    c.setDirectionMultiplier(1);
    c.setTypeWeights({ event_financial: { momentum: 1, mean_reversion: 1 } });
    // No setPerDirectionTypeWeights — should behave exactly like PR-A.

    const out = c.combine([sig('momentum', 'LONG', 0.5), sig('mean_reversion', 'LONG', 0.5)], undefined, 'event_financial');
    expect(out).not.toBeNull();
    expect(out!.direction).toBe('LONG');
  });

  it('uses per-direction weight when present, ignoring the legacy value for that direction only', () => {
    const c = new WeightedAverageCombiner({ momentum: 1 }, baseParams);
    c.setDirectionMultiplier(1);
    c.setTypeWeights({ event_financial: { mean_reversion: 1 } });
    // Override: mean_reversion LONG weighs 2, SHORT weighs 0.
    c.setPerDirectionTypeWeights({
      event_financial: { mean_reversion: { long: 2, short: 0 } },
    });

    // LONG signal → per-direction lookup hits 2 → LONG output.
    const longOut = c.combine([sig('mean_reversion', 'LONG', 0.5)], undefined, 'event_financial');
    expect(longOut?.direction).toBe('LONG');

    // SHORT signal of equal magnitude → per-direction lookup hits 0 → NEUTRAL.
    const shortOut = c.combine([sig('mean_reversion', 'SHORT', -0.5)], undefined, 'event_financial');
    expect(shortOut?.direction === 'NEUTRAL' || shortOut === null).toBe(true);
  });

  it('falls back to legacy weight when only one direction is per-direction-overridden', () => {
    const c = new WeightedAverageCombiner({ momentum: 1 }, baseParams);
    c.setDirectionMultiplier(1);
    c.setTypeWeights({ event_financial: { mean_reversion: 0.5 } });
    // Per-direction override only for LONG. SHORT falls back to '__all__' = 0.5.
    c.setPerDirectionTypeWeights({
      event_financial: { mean_reversion: { long: 3 } },
    });

    const longOut = c.combine([sig('mean_reversion', 'LONG', 0.5)], undefined, 'event_financial');
    const shortOut = c.combine([sig('mean_reversion', 'SHORT', -0.5)], undefined, 'event_financial');
    expect(longOut?.direction).toBe('LONG');
    // Fallback to 0.5 means SHORT still produces a SHORT (just weighted less than LONG).
    expect(shortOut?.direction).toBe('SHORT');
  });

  it('disabledSignalDirections zeros out only the specified direction', () => {
    const c = new WeightedAverageCombiner({ momentum: 1 }, baseParams);
    c.setDirectionMultiplier(1);
    c.setTypeWeights({ event_financial: { momentum: 1 } });
    c.setDisabledSignalDirections(['momentum:short']);

    // LONG: not in disabled set → goes through.
    const longOut = c.combine([sig('momentum', 'LONG', 0.5)], undefined, 'event_financial');
    expect(longOut?.direction).toBe('LONG');

    // SHORT: matches `momentum:short` → weight 0 → no signal.
    const shortOut = c.combine([sig('momentum', 'SHORT', -0.5)], undefined, 'event_financial');
    expect(shortOut === null || shortOut!.direction === 'NEUTRAL').toBe(true);
  });

  it('setDisabledSignalDirections round-trips through getDisabledSignalDirections', () => {
    const c = new WeightedAverageCombiner({}, baseParams);
    c.setDisabledSignalDirections(['momentum:short', 'ofi:long']);
    const got = c.getDisabledSignalDirections();
    expect(got.has('momentum:short')).toBe(true);
    expect(got.has('ofi:long')).toBe(true);
    expect(got.size).toBe(2);
  });

  it('does not interfere with disabledSignalIds (whole-signal disable still works)', () => {
    const c = new WeightedAverageCombiner({ momentum: 1 }, baseParams);
    c.setDirectionMultiplier(1);
    c.setTypeWeights({ event_financial: { momentum: 1, mean_reversion: 1 } });
    c.setDisabledSignalIds(['mean_reversion']);
    // Per-direction set is independent (empty here).

    const out = c.combine(
      [sig('momentum', 'LONG', 0.5), sig('mean_reversion', 'LONG', 0.5)],
      undefined,
      'event_financial'
    );
    expect(out?.componentSignals?.some((s) => s.signalId === 'mean_reversion')).toBe(false);
  });
});
