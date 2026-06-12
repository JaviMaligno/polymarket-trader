-- H-MM-4 export: shadow quoter fills + forward mids from mm_book_events.
-- WINDOW override: psql -v win='14 days' (default 14 days).
--
-- Join note: mm_shadow_fills.market_id stores the UNIVERSE market id
-- (markets.id as text) — the QuoteEngine translates from condition_id at
-- write time. Contrast with mm_fine_fills.sql, whose mm_trade_events.market_id
-- stores the CLOB condition_id and therefore joins on m.condition_id.
-- Here we join on m.id::text = f.market_id.
\if :{?win}
\else
  \set win '14 days'
\endif

CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, mid
  FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND mid IS NOT NULL;
CREATE INDEX ON be (token_id, bt);
ANALYZE be;

COPY (
  SELECT f.time, f.token_id, f.market_id, m.market_type, f.side, f.bound,
         f.price, f.size, f.queue_initial, f.spread_at_placement,
         f.vol_at_placement, f.flags,
    (SELECT mid FROM be WHERE be.token_id = f.token_id
     AND be.bt > f.time AND be.bt <= f.time + INTERVAL '10 seconds'
     ORDER BY be.bt DESC LIMIT 1) AS mid_10s,
    (SELECT mid FROM be WHERE be.token_id = f.token_id
     AND be.bt > f.time AND be.bt <= f.time + INTERVAL '60 seconds'
     ORDER BY be.bt DESC LIMIT 1) AS mid_60s,
    (SELECT mid FROM be WHERE be.token_id = f.token_id
     AND be.bt > f.time AND be.bt <= f.time + INTERVAL '300 seconds'
     ORDER BY be.bt DESC LIMIT 1) AS mid_300s
  FROM mm_shadow_fills f
  -- market_id is the universe markets.id (text) — NOT a condition_id hash
  JOIN markets m ON m.id::text = f.market_id
  WHERE f.time > NOW() - INTERVAL :'win'
) TO STDOUT WITH CSV HEADER;
