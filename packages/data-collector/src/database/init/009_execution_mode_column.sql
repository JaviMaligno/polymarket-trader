-- Migration 009: Add execution_mode column to paper_trades and paper_positions
--
-- Root cause: repositories.ts includes execution_mode in INSERT statements for
-- both paper_trades and paper_positions (to track paper vs real execution mode),
-- but this column was never added to the DB schema. This causes ALL trade
-- execution attempts to fail with:
--   "column "execution_mode" of relation "paper_trades" does not exist"

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'paper';

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'paper';
