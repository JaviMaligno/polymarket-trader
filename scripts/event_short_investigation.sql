-- 1. Markets event_short ACTIVE+COLD por horizon end_date
SELECT
  CASE
    WHEN end_date IS NULL THEN '(null end_date)'
    WHEN end_date < NOW() THEN 'past (expired)'
    WHEN end_date < NOW() + INTERVAL '24 hours' THEN '< 24h'
    WHEN end_date < NOW() + INTERVAL '7 days' THEN '1-7 days'
    WHEN end_date < NOW() + INTERVAL '30 days' THEN '7-30 days'
    WHEN end_date < NOW() + INTERVAL '90 days' THEN '30-90 days'
    ELSE '> 90 days'
  END AS horizon,
  COUNT(*) AS n
FROM markets
WHERE market_type='event_short' AND is_active=true AND COALESCE(is_resolved,false)=false
GROUP BY 1 ORDER BY 1;

-- 2. Sub-cohorts via question prefix (all currently event_short active markets)
SELECT
  CASE
    WHEN question ~* '^will [a-z ]+ win on [0-9]' THEN 'sports_match_dated'
    WHEN question ~* 'world cup|fifa|nba|nfl|nhl|mlb|ufc|formula|olympics|tennis' THEN 'sports_tournament_other'
    WHEN question ~* 'election|senate|president|governor|congress|democrat|republican' THEN 'politics_us'
    WHEN question ~* 'fed|cpi|ppi|gdp|unemployment|inflation|rate cut|rate hike' THEN 'macro_data'
    WHEN question ~* 'bitcoin|btc|ethereum|eth|crypto|sol|altcoin' THEN 'crypto_misc'
    ELSE 'other'
  END AS bucket,
  COUNT(*) AS n,
  COUNT(*) FILTER (WHERE end_date < NOW() + INTERVAL '7 days') AS within_7d,
  COUNT(*) FILTER (WHERE volume_24h > 0) AS with_volume_24h
FROM markets
WHERE market_type='event_short' AND is_active=true AND COALESCE(is_resolved,false)=false
GROUP BY 1 ORDER BY 2 DESC;

-- 3. Shadow event_short LONG sub-cohorts (resolved last 30d)
SELECT
  CASE
    WHEN m.question ~* '^will [a-z ]+ win on [0-9]' THEN 'sports_match_dated'
    WHEN m.question ~* 'world cup|fifa|nba|nfl|nhl|mlb|ufc|formula|olympics|tennis' THEN 'sports_tournament_other'
    WHEN m.question ~* 'election|senate|president|governor|congress' THEN 'politics_us'
    WHEN m.question ~* 'fed|cpi|ppi|gdp|unemployment|inflation' THEN 'macro_data'
    ELSE 'other'
  END AS bucket,
  COUNT(*) AS n,
  ROUND(AVG(s.theoretical_pnl)::numeric, 2) AS avg_pnl,
  COUNT(*) FILTER (WHERE s.theoretical_pnl > 0) AS wins,
  ROUND(100.0 * COUNT(*) FILTER (WHERE s.theoretical_pnl > 0) / NULLIF(COUNT(*), 0), 1) AS wr_pct
FROM shadow_trades s
JOIN markets m ON m.id = s.market_id
WHERE s.market_type='event_short' AND s.direction='long' AND s.resolved_at IS NOT NULL
  AND s.time >= NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 2 DESC;

-- 4. Hold horizon (time → resolved_at) en shadow event_short LONG
SELECT
  CASE
    WHEN EXTRACT(EPOCH FROM (s.resolved_at - s.time))/86400 < 1 THEN '< 1 day'
    WHEN EXTRACT(EPOCH FROM (s.resolved_at - s.time))/86400 < 7 THEN '1-7 days'
    WHEN EXTRACT(EPOCH FROM (s.resolved_at - s.time))/86400 < 30 THEN '7-30 days'
    ELSE '> 30 days'
  END AS held_horizon,
  COUNT(*) AS n,
  ROUND(AVG(s.theoretical_pnl)::numeric, 2) AS avg_pnl,
  ROUND(100.0 * COUNT(*) FILTER (WHERE s.theoretical_pnl > 0) / NULLIF(COUNT(*), 0), 1) AS wr_pct
FROM shadow_trades s
WHERE s.market_type='event_short' AND s.direction='long' AND s.resolved_at IS NOT NULL
  AND s.time >= NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1;

-- 5. Sample of resolved event_short LONG shadow trades (top wins + losses) for context
SELECT
  LEFT(m.question, 80) AS q,
  m.market_type,
  ROUND(s.theoretical_pnl::numeric, 2) AS pnl,
  ROUND(EXTRACT(EPOCH FROM (s.resolved_at - s.time))/86400, 1) AS days_held
FROM shadow_trades s
JOIN markets m ON m.id = s.market_id
WHERE s.market_type='event_short' AND s.direction='long' AND s.resolved_at IS NOT NULL
  AND s.time >= NOW() - INTERVAL '30 days'
ORDER BY s.theoretical_pnl DESC
LIMIT 10;
