-- Top-N liquid market-making candidates to subscribe (event_financial +
-- event_long + event_short). Liquid = tight recent book AND active recent trade
-- flow. Emits both YES and NO tokens per market.
WITH recent_book AS (
  SELECT token_id, AVG(best_ask - best_bid) AS avg_spread, COUNT(*) AS n_snap
  FROM orderbook_snapshots
  WHERE time > NOW() - INTERVAL '24 hours'
    AND best_bid IS NOT NULL AND best_ask IS NOT NULL
  GROUP BY token_id
),
recent_trades AS (
  SELECT token_id, COUNT(*) AS n_trades
  FROM trades WHERE time > NOW() - INTERVAL '24 hours'
  GROUP BY token_id
),
ranked AS (
  SELECT m.id AS market_id, m.condition_id, m.clob_token_id_yes, m.clob_token_id_no,
         m.end_date, rb.avg_spread, COALESCE(rt.n_trades, 0) AS n_trades
  FROM markets m
  JOIN recent_book rb ON rb.token_id = m.clob_token_id_yes
  LEFT JOIN recent_trades rt ON rt.token_id = m.clob_token_id_yes
  WHERE m.market_type IN ('event_financial', 'event_long', 'event_short')
    AND m.tracking_status = 'active'
    AND rb.avg_spread <= 0.05
  ORDER BY rb.avg_spread ASC, n_trades DESC
  LIMIT $1
)
SELECT market_id, condition_id, end_date, clob_token_id_yes AS token_id FROM ranked
UNION ALL
SELECT market_id, condition_id, end_date, clob_token_id_no AS token_id FROM ranked;
