-- 029_signal_weights_per_direction.sql
-- Extends signal_weights to support per-direction rows. Existing rows become
-- direction='__all__' (legacy/global semantics). Per-direction rows seeded
-- later by scripts/seed-per-direction-weights.sql (PR-D).
--
-- Design: docs/plans/2026-05-13-per-direction-weights-design.md
-- Trigger: P2 cost-aware t-stat (2026-05-13) showed directional asymmetry
-- the (signal_type, market_type) key cannot express. E.g. mean_reversion
-- crypto_intraday: SHORT t_net=+6.44, LONG t_net=-23.96.

ALTER TABLE signal_weights
  ADD COLUMN IF NOT EXISTS direction VARCHAR(8) NOT NULL DEFAULT '__all__';

-- Add CHECK constraint defensively (NOT VALID then VALIDATE would lock briefly
-- on huge tables; here ~50 rows so just ADD).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signal_weights_direction_check'
      AND conrelid = 'signal_weights'::regclass
  ) THEN
    ALTER TABLE signal_weights
      ADD CONSTRAINT signal_weights_direction_check
      CHECK (direction IN ('__all__','long','short'));
  END IF;
END $$;

-- PK swap to include direction. Idempotent — discovers existing PK by name
-- so it survives multiple boots and the previous per-type swap (025).
DO $$
DECLARE pkey_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_weights_pkey_per_direction') THEN
    RETURN;
  END IF;

  SELECT conname INTO pkey_name
  FROM pg_constraint
  WHERE conrelid = 'signal_weights'::regclass AND contype = 'p';

  IF pkey_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE signal_weights DROP CONSTRAINT %I', pkey_name);
  END IF;

  ALTER TABLE signal_weights
    ADD CONSTRAINT signal_weights_pkey_per_direction
    PRIMARY KEY (signal_type, market_type, direction);
END $$;

-- Hot path index for combiner lookups (PR-B uses this).
CREATE INDEX IF NOT EXISTS idx_signal_weights_lookup
  ON signal_weights (signal_type, market_type, direction)
  WHERE is_enabled = true;
