-- Direction multiplier exploration: per-trade multiplier provenance
-- Adds two columns to paper_positions so the learner can bucket trades
-- by the actual applied multiplier (not just the contemporaneous global).
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS applied_direction_multiplier NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS was_exploration BOOLEAN NOT NULL DEFAULT false;
