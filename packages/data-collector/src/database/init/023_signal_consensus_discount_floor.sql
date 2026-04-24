-- Sub-project B.2: seed the consensus_discount_floor config row in signal_weights.
-- signal_weights uses the row-per-config pattern (signal_type PK + scalar weight
-- column) — direction_multiplier is stored the same way. Default 0.5 until
-- Optuna converges.
INSERT INTO signal_weights (signal_type, weight, is_enabled, min_confidence, updated_at)
VALUES ('consensus_discount_floor', 0.5, true, 0.0, NOW())
ON CONFLICT (signal_type) DO NOTHING;
