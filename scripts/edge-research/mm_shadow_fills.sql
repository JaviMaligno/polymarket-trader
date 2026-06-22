-- H-MM-4 export: shadow quoter fills + forward mids from mm_book_events.
-- WINDOW override: psql -v win='14 days' (default 14 days).
--
-- Join note: mm_shadow_fills.market_id stores the UNIVERSE market id
-- (markets.id as text) — the QuoteEngine translates from condition_id at
-- write time. Contrast with mm_fine_fills.sql, whose mm_trade_events.market_id
-- stores the CLOB condition_id and therefore joins on m.condition_id.
-- Here we join on m.id::text = f.market_id.
--
-- Perf note (2026-06-22): the forward mids query mm_book_events DIRECTLY via the
-- existing index idx_mm_book_token_time (token_id, time) instead of first
-- materialising a `be` TEMP TABLE of every book event in the window. The temp
-- approach scanned ~4M rows into a 1GB-RAM e2-micro and spilled to disk (a manual
-- full-window run took 105 min then dropped the SSH). Each fill only needs the
-- last non-null mid in (t, t+H]; the index serves that as a LIMIT-1 backward scan,
-- so cost is O(fills) not O(book), and the window can be large for free.
\if :{?win}
\else
  \set win '14 days'
\endif

COPY (
  SELECT f.time, f.token_id, f.market_id, m.market_type, f.side, f.bound,
         f.price, f.size, f.queue_initial, f.spread_at_placement,
         f.vol_at_placement, f.flags,
    (SELECT b.mid FROM mm_book_events b WHERE b.token_id = f.token_id
     AND b.mid IS NOT NULL AND b.time > f.time AND b.time <= f.time + INTERVAL '10 seconds'
     ORDER BY b.time DESC LIMIT 1) AS mid_10s,
    (SELECT b.mid FROM mm_book_events b WHERE b.token_id = f.token_id
     AND b.mid IS NOT NULL AND b.time > f.time AND b.time <= f.time + INTERVAL '60 seconds'
     ORDER BY b.time DESC LIMIT 1) AS mid_60s,
    (SELECT b.mid FROM mm_book_events b WHERE b.token_id = f.token_id
     AND b.mid IS NOT NULL AND b.time > f.time AND b.time <= f.time + INTERVAL '300 seconds'
     ORDER BY b.time DESC LIMIT 1) AS mid_300s
  FROM mm_shadow_fills f
  -- market_id is the universe markets.id (text) — NOT a condition_id hash
  JOIN markets m ON m.id::text = f.market_id
  WHERE f.time > NOW() - INTERVAL :'win'
) TO STDOUT WITH CSV HEADER;
