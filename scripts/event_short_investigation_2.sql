-- A. Cuantos markets event_short tienen end_date pasado vs is_active=true (zombie zombies)
SELECT
  COUNT(*) FILTER (WHERE end_date IS NOT NULL AND end_date < NOW()) AS expired_but_active,
  COUNT(*) FILTER (WHERE end_date IS NOT NULL AND end_date >= NOW()) AS future,
  COUNT(*) FILTER (WHERE end_date IS NULL) AS no_end_date,
  COUNT(*) AS total
FROM markets WHERE market_type='event_short' AND is_active=true AND COALESCE(is_resolved,false)=false;

-- B. Sample de shadow event_short LONG wins — qué markets son realmente (puede ser misclassification antigua)
SELECT
  LEFT(m.question, 100) AS q,
  m.market_type AS current_type,
  s.market_type AS shadow_recorded_type,
  ROUND(s.theoretical_pnl::numeric, 2) AS pnl,
  ROUND(EXTRACT(EPOCH FROM (s.resolved_at - s.time))/86400, 1) AS days_held
FROM shadow_trades s
JOIN markets m ON m.id = s.market_id
WHERE s.market_type='event_short' AND s.direction='long' AND s.resolved_at IS NOT NULL
  AND s.theoretical_pnl > 0
  AND s.time >= NOW() - INTERVAL '30 days'
GROUP BY m.question, m.market_type, s.market_type, s.theoretical_pnl, s.time, s.resolved_at
ORDER BY s.theoretical_pnl DESC
LIMIT 5;

-- C. Misma vista para LOSSES
SELECT
  LEFT(m.question, 100) AS q,
  m.market_type AS current_type,
  s.market_type AS shadow_recorded_type,
  ROUND(s.theoretical_pnl::numeric, 2) AS pnl,
  ROUND(EXTRACT(EPOCH FROM (s.resolved_at - s.time))/86400, 1) AS days_held
FROM shadow_trades s
JOIN markets m ON m.id = s.market_id
WHERE s.market_type='event_short' AND s.direction='long' AND s.resolved_at IS NOT NULL
  AND s.theoretical_pnl < 0
  AND s.time >= NOW() - INTERVAL '30 days'
GROUP BY m.question, m.market_type, s.market_type, s.theoretical_pnl, s.time, s.resolved_at
ORDER BY s.theoretical_pnl ASC
LIMIT 5;

-- D. Cuantos shadow event_short LONG son ahora event_financial (misclassification drift)?
SELECT
  m.market_type AS current_type,
  COUNT(*) AS shadow_n,
  ROUND(AVG(s.theoretical_pnl)::numeric, 2) AS avg_pnl,
  ROUND(100.0 * COUNT(*) FILTER (WHERE s.theoretical_pnl > 0) / NULLIF(COUNT(*), 0), 1) AS wr_pct
FROM shadow_trades s
JOIN markets m ON m.id = s.market_id
WHERE s.market_type='event_short' AND s.direction='long' AND s.resolved_at IS NOT NULL
  AND s.time >= NOW() - INTERVAL '30 days'
GROUP BY m.market_type
ORDER BY shadow_n DESC;
