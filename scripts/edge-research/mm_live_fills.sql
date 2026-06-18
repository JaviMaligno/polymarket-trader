-- H-MM-5 export: live maker fills + forward mids. Window override: psql -v win='7 days'.
\if :{?win}
\else
  \set win '7 days'
\endif

CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, mid FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND mid IS NOT NULL;
CREATE INDEX ON be (token_id, bt);
ANALYZE be;

COPY (
  WITH f AS (
    SELECT lf.time,
           -- market_type por token: mm_trade_events guarda el condition_id (0x hash)
           -- junto al token; lo cruzamos con markets.condition_id (mismo patrón que mm_fine_fills).
           (SELECT m.market_type
              FROM mm_trade_events te JOIN markets m ON m.condition_id = te.market_id
              WHERE te.token_id = lf.token_id LIMIT 1) AS market_type,
           lf.token_id, lf.side, lf.fill_price, lf.fill_size, lf.spread_at_placement,
           (SELECT mid FROM be WHERE be.token_id=lf.token_id AND be.bt > lf.time AND be.bt <= lf.time + INTERVAL '10 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_10s,
           (SELECT mid FROM be WHERE be.token_id=lf.token_id AND be.bt > lf.time AND be.bt <= lf.time + INTERVAL '60 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_60s,
           (SELECT mid FROM be WHERE be.token_id=lf.token_id AND be.bt > lf.time AND be.bt <= lf.time + INTERVAL '300 seconds' ORDER BY be.bt DESC LIMIT 1) AS mid_300s
    FROM mm_live_fills lf
    WHERE lf.time > NOW() - INTERVAL :'win'
  )
  SELECT * FROM f
) TO STDOUT WITH CSV HEADER;
