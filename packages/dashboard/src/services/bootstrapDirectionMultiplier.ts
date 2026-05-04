import { query } from '../database/index.js';

export async function bootstrapDirectionMultiplierRows(): Promise<void> {
  await query(
    `INSERT INTO signal_weights (signal_type, market_type, weight, updated_at, is_enabled)
     VALUES
       -- 2026-05-04: flipped seeds -1 → +1 after empirical reverse-direction
       -- analysis (n=386, 84.7% counter-WR). See DirectionMultiplierPolicy.ts header.
       ('direction_multiplier', 'crypto_intraday', 1.0, NOW(), true),
       ('direction_multiplier', 'crypto_daily',    1.0, NOW(), true),
       ('direction_multiplier', 'event_short',     1.0, NOW(), true),
       ('direction_multiplier', 'event_long',      1.0, NOW(), true),
       ('direction_multiplier', 'event_financial', 1.0, NOW(), true)
     ON CONFLICT (signal_type, market_type) DO NOTHING`
  );
}
