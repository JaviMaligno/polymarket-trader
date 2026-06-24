-- Resolved-market catalog for conditional-pair identification (LLM input).
-- One row per resolved market with the fields the LLM needs to spot logical
-- dependence between markets, plus event_id so the export can drop same-event
-- (negRisk-netted) pairs. Only markets with usable price history and a clean
-- yes/no resolution.
COPY (
  SELECT m.id AS market_id, m.event_id, m.market_type, m.question,
         e.title AS event_title, e.category AS event_category,
         m.end_date, m.resolved_at,
         (m.resolution_outcome = 'yes')::int AS outcome_yes
  FROM markets m
  LEFT JOIN events e ON e.id = m.event_id
  WHERE m.is_resolved = true
    AND m.resolution_outcome IN ('yes', 'no')
    AND m.resolved_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM flb_backtest_prices p WHERE p.market_id = m.id)
  ORDER BY e.category NULLS LAST, m.event_id, m.resolved_at
) TO STDOUT WITH CSV HEADER;
