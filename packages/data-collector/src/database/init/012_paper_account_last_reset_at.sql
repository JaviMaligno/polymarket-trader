-- Add last_reset_at to paper_account for accurate reset epoch tracking.
-- Used by daily-review.sh to exclude pre-reset trades from invariant checks.

ALTER TABLE paper_account
  ADD COLUMN IF NOT EXISTS last_reset_at TIMESTAMPTZ;

-- Backfill the known last reset timestamp (reset #7, 2026-03-30 ~17:30 UTC,
-- after the final corrupted position was closed at ~17:21 UTC).
UPDATE paper_account
  SET last_reset_at = '2026-03-30T17:30:00Z'
  WHERE last_reset_at IS NULL;
