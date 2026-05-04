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
  // trading_config.value is TEXT (JSON.stringify'd by tradingConfigRepo.set), so
  // tradingConfigRepo.get returns the raw string, not a parsed object. Without
  // explicit parse, every field access here returns undefined and the function
  // silently overwrites the persisted policy with DEFAULT_DIRECTION_MULTIPLIER_POLICY
  // on every server restart — exactly what reset the +1 flip back to -1 on
  // 2026-05-04 until this fix.
  const raw = await tradingConfigRepo.get<DirectionMultiplierPolicy | string>(
    'direction_multiplier_policy'
  );
  let existing: DirectionMultiplierPolicy | null = null;
  if (typeof raw === 'string') {
    try { existing = JSON.parse(raw) as DirectionMultiplierPolicy; }
    catch { existing = null; }
  } else if (raw && typeof raw === 'object') {
    existing = raw as DirectionMultiplierPolicy;
  }

  // Skip the write when the policy is already in the wiped state.
  if (existing && Array.isArray(existing.segments) && existing.segments.length === 0) {
    return;
  }

  const next: DirectionMultiplierPolicy = {
    global: existing?.global ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY.global,
    minMultiplier: existing?.minMultiplier ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY.minMultiplier,
    maxMultiplier: existing?.maxMultiplier ?? DEFAULT_DIRECTION_MULTIPLIER_POLICY.maxMultiplier,
    segments: [],
    ...(existing?.perMarketType ? { perMarketType: existing.perMarketType } : {}),
  };

  await tradingConfigRepo.set(
    'direction_multiplier_policy',
    next,
    'wipe_segments_after_dm_per_type_migration'
  );
}
