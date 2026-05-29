-- Throttle column for resolution detection (resolveOurMarkets). Markets Gamma
-- cannot yet resolve (not closed, delisted) get their last_resolution_check
-- bumped so they don't consume the per-run budget every cron cycle.
-- NOTE: init SQL only runs on FIRST volume init. The running VM gets this column
-- via the idempotent ALTER in GammaCollector.resolveOurMarkets() and the manual
-- ALTER in the deploy task. This file covers fresh installs.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS last_resolution_check TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_markets_resolution_backlog
  ON markets (end_date)
  WHERE COALESCE(is_resolved, false) = false;
