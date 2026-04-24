-- Sub-project B.2: consensus discount floor for the signal combiner.
-- Optuna optimizer will tune this value empirically. Default 0.5 until it
-- converges. Column persisted in signal_weights so the combiner reads it
-- via the same path as momentum/mean_reversion/etc. weights.
ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS consensus_discount_floor FLOAT NOT NULL DEFAULT 0.5;
