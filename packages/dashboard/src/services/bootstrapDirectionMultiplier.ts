import { query } from '../database/index.js';

export async function bootstrapDirectionMultiplierRows(): Promise<void> {
  // direction='__all__' because direction_multiplier is itself a multiplier on
  // the combined signal's direction — splitting it per-direction is not meaningful.
  // See docs/plans/2026-05-13-per-direction-weights-design.md.
  await query(
    `INSERT INTO signal_weights (signal_type, market_type, direction, weight, updated_at, is_enabled)
     VALUES
       -- 2026-05-04: flipped seeds -1 → +1 after empirical reverse-direction
       -- analysis (n=386, 84.7% counter-WR). See DirectionMultiplierPolicy.ts header.
       ('direction_multiplier', 'crypto_intraday', '__all__', 1.0, NOW(), true),
       ('direction_multiplier', 'crypto_daily',    '__all__', 1.0, NOW(), true),
       ('direction_multiplier', 'event_short',     '__all__', 1.0, NOW(), true),
       ('direction_multiplier', 'event_long',      '__all__', 1.0, NOW(), true),
       ('direction_multiplier', 'event_financial', '__all__', 1.0, NOW(), true)
     ON CONFLICT (signal_type, market_type, direction) DO NOTHING`
  );
}
