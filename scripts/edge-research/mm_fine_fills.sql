-- B2 export: per trade, the maker fill candidate + forward mids. 100% of trades.
-- WINDOW override: psql -v win='7 days' (default 7 days).
--
-- Perf note (2026-06-22): the book lookups (mid_before + forward mids) query
-- mm_book_events DIRECTLY via the existing index idx_mm_book_token_time
-- (token_id, time) instead of materialising a `be` TEMP TABLE of every book
-- event in the window. The temp scanned ~4M rows into a 1GB-RAM e2-micro and
-- spilled to disk — the dominant cost of the weekly MM export, which timed out
-- at the 40-min job limit. Each trade only needs one book row per lookup; the
-- index serves each as a LIMIT-1 scan, so cost is O(trades) not O(book).
-- The non-null bid/ask filter is kept identical to the old `be` predicate, so
-- the output is row-for-row equivalent.
\if :{?win}
\else
  \set win '7 days'
\endif

CREATE TEMP TABLE te AS
  SELECT token_id, market_id, time AS tt, price, size
  FROM mm_trade_events WHERE time > NOW() - INTERVAL :'win';

COPY (
  WITH j AS (
    SELECT t.market_id, t.token_id, t.tt, t.price, t.size,
           b.best_bid, b.best_ask, b.mid AS mid_before,
           b.best_bid_size, b.best_ask_size
    FROM te t
    LEFT JOIN LATERAL (
      SELECT best_bid, best_ask, mid, best_bid_size, best_ask_size
      FROM mm_book_events be
      WHERE be.token_id = t.token_id AND be.time <= t.tt
        AND be.best_bid IS NOT NULL AND be.best_ask IS NOT NULL
      ORDER BY be.time DESC LIMIT 1) b ON true
  ),
  withmids AS (
    SELECT j.*,
      (SELECT mid FROM mm_book_events be WHERE be.token_id=j.token_id AND be.best_bid IS NOT NULL AND be.best_ask IS NOT NULL AND be.time > j.tt AND be.time <= j.tt + INTERVAL '10 seconds'  ORDER BY be.time DESC LIMIT 1) AS mid_10s,
      (SELECT mid FROM mm_book_events be WHERE be.token_id=j.token_id AND be.best_bid IS NOT NULL AND be.best_ask IS NOT NULL AND be.time > j.tt AND be.time <= j.tt + INTERVAL '60 seconds'  ORDER BY be.time DESC LIMIT 1) AS mid_60s,
      (SELECT mid FROM mm_book_events be WHERE be.token_id=j.token_id AND be.best_bid IS NOT NULL AND be.best_ask IS NOT NULL AND be.time > j.tt AND be.time <= j.tt + INTERVAL '300 seconds' ORDER BY be.time DESC LIMIT 1) AS mid_300s
    FROM j
  )
  SELECT w.market_id, m.market_type, w.token_id, w.tt AS time, w.size, w.price,
         w.best_bid, w.best_ask, w.mid_before, w.best_bid_size, w.best_ask_size, w.mid_10s, w.mid_60s, w.mid_300s,
         -- maker side & sign — matches H-MM-1's sign(price-mid) convention in
         -- mm_trade_spreads.sql, so retained = maker_sign*(maker_price - mid_after):
         --   trade below mid => hit the bid => maker BOUGHT at best_bid, sign -1
         --     => retained = -1*(best_bid - mid_after) = mid_after - best_bid (gain if mid rises)
         --   trade above mid => lifted the ask => maker SOLD at best_ask, sign +1
         --     => retained = +1*(best_ask - mid_after) = best_ask - mid_after (gain if mid falls)
         CASE WHEN w.price < w.mid_before THEN w.best_bid ELSE w.best_ask END AS maker_price,
         CASE WHEN w.price < w.mid_before THEN -1 ELSE 1 END AS maker_sign
  -- mm_trade_events.market_id stores the CLOB condition_id (0x hash), not the
  -- numeric markets.id — the recorder works off the CLOB feed, which keys markets
  -- by condition hash. (H-MM-1's mm_trade_spreads.sql reads the legacy `trades`
  -- table, whose market_id IS the numeric markets.id, hence it joins on m.id.)
  -- Joining on m.id here matched 0 rows → H-MM-3 would verdict on an empty set
  -- forever, regardless of capture volume. Verified on VM 2026-06-09:
  -- m.condition_id = market_id matches 2034 events / 15 markets.
  FROM withmids w JOIN markets m ON m.condition_id = w.market_id
  WHERE w.mid_before IS NOT NULL AND w.price <> w.mid_before
) TO STDOUT WITH CSV HEADER;
