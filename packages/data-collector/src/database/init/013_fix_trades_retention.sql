-- Migration 013: Fix trades table retention policy
--
-- Problem: The trades table (raw Polymarket orderflow) has no drop-retention policy
-- in production, causing it to grow at ~1 GB/day and fill the 30 GB disk.
-- At the time of this migration the disk hit 96% full (2026-04-09).
--
-- Fix: Remove any existing retention policy on trades, then add a 7-day policy.
-- 7 days is sufficient for signal generation. The table had a compression-only
-- policy (compress after 30 days) but no drop policy.

-- Remove the old policy if it already exists with a different interval
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
    WHERE proc_name = 'policy_retention'
      AND hypertable_name = 'trades'
  ) THEN
    PERFORM remove_retention_policy('trades', if_not_exists => TRUE);
  END IF;
END $$;

-- Add 7-day retention
SELECT add_retention_policy('trades', INTERVAL '7 days', if_not_exists => TRUE);

-- Drop existing chunks older than 7 days immediately to reclaim space
SELECT drop_chunks('trades', older_than => INTERVAL '7 days');
