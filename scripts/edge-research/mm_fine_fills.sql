-- B2 export: per trade, the maker fill candidate + forward mids. 100% of trades.
-- WINDOW override: psql -v win='7 days' (default 7 days).
\if :{?win}
\else
  \set win '7 days'
\endif

CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, best_bid, best_ask, mid
  FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND best_bid IS NOT NULL AND best_ask IS NOT NULL;
CREATE INDEX ON be (token_id, bt);
ANALYZE be;

CREATE TEMP TABLE te AS
  SELECT token_id, market_id, time AS tt, price, size
  FROM mm_trade_events WHERE time > NOW() - INTERVAL :'win';

COPY (
  WITH j AS (
    SELECT t.market_id, t.token_id, t.tt, t.price, t.size,
           b.best_bid, b.best_ask, b.mid AS mid_before
    FROM te t
    LEFT JOIN LATERAL (
      SELECT best_bid, best_ask, mid FROM be
      WHERE be.token_id = t.token_id AND be.bt <= t.tt
      ORDER BY be.bt DESC LIMIT 1) b ON true
  ),
  withmids AS (
    SELECT j.*,
      (SELECT mid FROM be WHERE be.token_id=j.token_id AND be.bt > j.tt AND be.bt <= j.tt + INTERVAL '10 seconds'  ORDER BY be.bt ASC LIMIT 1) AS mid_10s,
      (SELECT mid FROM be WHERE be.token_id=j.token_id AND be.bt > j.tt AND be.bt <= j.tt + INTERVAL '60 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_60s,
      (SELECT mid FROM be WHERE be.token_id=j.token_id AND be.bt > j.tt AND be.bt <= j.tt + INTERVAL '300 seconds' ORDER BY be.bt DESC LIMIT 1) AS mid_300s
    FROM j
  )
  SELECT w.market_id, m.market_type, w.token_id, w.tt AS time, w.size, w.price,
         w.best_bid, w.best_ask, w.mid_before, w.mid_10s, w.mid_60s, w.mid_300s,
         -- maker side: trade price below mid => hit the bid => maker_price = best_bid (+1 sign);
         -- above mid => lifted the ask => maker_price = best_ask (-1 sign)
         CASE WHEN w.price < w.mid_before THEN w.best_bid ELSE w.best_ask END AS maker_price,
         CASE WHEN w.price < w.mid_before THEN 1 ELSE -1 END AS maker_sign
  FROM withmids w JOIN markets m ON m.id = w.market_id
  WHERE w.mid_before IS NOT NULL AND w.price <> w.mid_before
) TO STDOUT WITH CSV HEADER;
