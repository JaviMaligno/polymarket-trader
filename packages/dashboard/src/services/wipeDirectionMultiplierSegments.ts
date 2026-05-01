import { tradingConfigRepo } from '../database/repositories.js';
import {
  DEFAULT_DIRECTION_MULTIPLIER_POLICY,
  type DirectionMultiplierPolicy,
} from './DirectionMultiplierPolicy.js';

/**
 * Idempotent wipe of `direction_multiplier_policy.segments[]` in trading_config.
 *
 * Why: when the DirectionMultiplierLearningService is disabled, any previously
 * persisted segments would still be picked up by `resolveDirectionMultiplier()`
 * and given priority over the new `perMarketType` values composed from
 * `signal_weights`. This helper ensures the resolver falls through to the
 * per-type layer (or the global fallback) by leaving segments empty.
 *
 * Preserves `global`, `minMultiplier`, `maxMultiplier`, and `perMarketType`
 * if present. Only `segments` is wiped.
 */
export async function wipeDirectionMultiplierSegments(): Promise<void> {
  const existing = await tradingConfigRepo.get<DirectionMultiplierPolicy>(
    'direction_multiplier_policy'
  );

  const next: DirectionMultiplierPolicy = {
    global: existing?.global ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY.global,
    minMultiplier: existing?.minMultiplier ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY.minMultiplier,
    maxMultiplier: existing?.maxMultiplier ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY.maxMultiplier,
    segments: [],
    ...(existing?.perMarketType ? { perMarketType: existing.perMarketType } : {}),
  };

  // Skip the write when the policy is already in the wiped state.
  if (existing && Array.isArray(existing.segments) && existing.segments.length === 0) {
    return;
  }

  await tradingConfigRepo.set(
    'direction_multiplier_policy',
    next,
    'wipe_segments_after_dm_per_type_migration'
  );
}
