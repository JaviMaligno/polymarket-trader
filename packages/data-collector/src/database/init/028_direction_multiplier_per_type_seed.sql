-- Bootstrap directionMultiplier per-(market_type) rows in signal_weights.
-- See docs/plans/2026-04-30-direction-multiplier-per-type-design.md for rationale.
--
-- crypto_*, event_short, event_long: -1 (status quo or shadow-validated).
-- event_financial: +1 (live 7d evidence: dm=-1 produces WR=17%; estimated WR=81% with +1).

INSERT INTO signal_weights (signal_type, market_type, weight, updated_at, is_enabled)
VALUES
  ('direction_multiplier', 'crypto_intraday', -1.0, NOW(), true),
  ('direction_multiplier', 'crypto_daily',    -1.0, NOW(), true),
  ('direction_multiplier', 'event_short',     -1.0, NOW(), true),
  ('direction_multiplier', 'event_long',      -1.0, NOW(), true),
  ('direction_multiplier', 'event_financial', 1.0,  NOW(), true)
ON CONFLICT (signal_type, market_type) DO NOTHING;
