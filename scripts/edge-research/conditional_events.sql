-- conditional_events export (H-INE-4). Expects the pairs CSV pre-loaded into a
-- TEMP table `cp(pair_id, market_id_a, market_id_b, relation)` by the caller:
--   \copy cp FROM '/tmp/conditional_pairs.csv' WITH CSV HEADER
-- so this script is wrapped by the export step (see the run command in the plan).
--
-- Determinacy: only A's YES outcome makes B determinate for the relations we use,
-- so we require outcome_a = 1. b_implied_value = 1 for implies_yes, else 0.
-- negRisk guard: drop pairs whose A and B share an event_id (netted sum-arb).
-- Entry price: B's first flb_backtest_prices.yes_price at/after t_a + offset.
WITH base AS (
  SELECT cp.pair_id, cp.relation,
         a.id AS a_id, a.resolved_at AS t_a,
         (a.resolution_outcome = 'yes')::int AS outcome_a,
         b.id AS b_id, b.market_type AS market_type_b,
         b.resolved_at AS b_resolved_at,
         (b.resolution_outcome = 'yes')::int AS b_outcome,
         CASE WHEN cp.relation = 'implies_yes' THEN 1 ELSE 0 END AS b_implied_value
  FROM cp
  JOIN markets a ON a.id = cp.market_id_a
  JOIN markets b ON b.id = cp.market_id_b
  WHERE a.is_resolved AND b.is_resolved
    AND a.resolution_outcome = 'yes'            -- determinate round only
    AND b.resolution_outcome IN ('yes','no')
    AND a.resolved_at IS NOT NULL AND b.resolved_at IS NOT NULL
    AND a.resolved_at < b.resolved_at           -- A resolves before B
    AND a.event_id IS DISTINCT FROM b.event_id  -- negRisk guard
),
offsets AS (
  SELECT * FROM (VALUES ('1h', INTERVAL '1 hour'), ('1d', INTERVAL '1 day')) AS o(entry_offset, dt)
)
COPY (
  SELECT base.pair_id, base.relation, base.market_type_b,
         base.t_a, base.outcome_a, o.entry_offset,
         (SELECT p.yes_price FROM flb_backtest_prices p
          WHERE p.market_id = base.b_id AND p.ts >= base.t_a + o.dt
          ORDER BY p.ts ASC LIMIT 1) AS b_entry_price,
         base.b_implied_value, base.b_outcome, base.b_resolved_at,
         EXTRACT(EPOCH FROM (base.b_resolved_at - base.t_a)) / 86400.0 AS hold_days
  FROM base CROSS JOIN offsets o
  WHERE EXISTS (SELECT 1 FROM flb_backtest_prices p
                WHERE p.market_id = base.b_id AND p.ts >= base.t_a + o.dt)
) TO STDOUT WITH CSV HEADER;
