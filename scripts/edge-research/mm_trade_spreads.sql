-- H-MM-1 export: per trade, the realized-spread decomposition vs the book
-- mid before (mid_t) and after (mid_after), sign via the quote test.
--
-- Designed to run on the e2-micro (1GB RAM, TimescaleDB 350MB): the naive per-trade
-- correlated subquery over compressed chunks crashed the server, so this
--   (1) materialises recent snapshots into an INDEXED session-temp table (no prod
--       schema change, no compressed-chunk scan in the lateral lookups),
--   (2) FRESHNESS-FILTERS to trades within 120s of their preceding snapshot — at
--       10-min book cadence a stale mid_t turns price drift into spurious "spread";
--       keeping only near-snapshot trades makes eff_half ≈ the real quotable spread.
-- gap_sec is exported for transparency; the harness validator ignores extra columns.
-- Run: psql -f this_file  (streams CSV to stdout via server-side COPY).
--
-- WINDOW: defaults to 7 days; override with `psql -v win='30 days' -f ...`.
-- 100% of trades (no hash-sample). Rationale: the original 5% hash-sample was
-- calibrated for the pre-#318 INFLATED trades feed (a mis-attributed global feed,
-- tens of thousands of rows/day). After the #318 fix (per-market query) the feed is
-- correctly attributed and small (~2.5k trades/24h); at 5%×24h the cohorts landed at
-- n≈42, far below the n>=200 validator floor, so H-MM-1 stayed perpetually
-- inconclusive. 100%×7d brings the tradeable cohorts above the floor and is cheap on
-- the e2-micro (snap ~70k rows, strades ~18k rows). See
-- project_trades_collection_corrupt_2026-06-06 / project_market_making_idea.
\if :{?win}
\else
  \set win '7 days'
\endif

CREATE TEMP TABLE snap AS
  SELECT token_id, time AS st, mid_price, best_bid, best_ask
  FROM orderbook_snapshots
  WHERE time > NOW() - INTERVAL :'win'
    AND mid_price IS NOT NULL AND best_bid IS NOT NULL AND best_ask IS NOT NULL;
CREATE INDEX ON snap (token_id, st);
ANALYZE snap;

CREATE TEMP TABLE strades AS
  SELECT market_id, token_id, time AS tt, price, size
  FROM trades
  WHERE time > NOW() - INTERVAL :'win';

COPY (
  WITH j AS (
    SELECT t.market_id, t.token_id, t.tt, t.size, t.price,
           mt.st AS mt_time, mt.mid_price AS mid_t,
           mt.best_bid, mt.best_ask, ma.mid_price AS mid_after
    FROM strades t
    LEFT JOIN LATERAL (
      SELECT st, mid_price, best_bid, best_ask FROM snap
      WHERE snap.token_id = t.token_id AND snap.st <= t.tt
      ORDER BY snap.st DESC LIMIT 1) mt ON true
    LEFT JOIN LATERAL (
      SELECT mid_price FROM snap
      WHERE snap.token_id = t.token_id AND snap.st > t.tt
      ORDER BY snap.st ASC LIMIT 1) ma ON true
  )
  SELECT j.market_id, m.market_type, j.token_id, j.tt AS time, j.size,
         EXTRACT(EPOCH FROM (j.tt - j.mt_time))            AS gap_sec,
         (j.best_ask - j.best_bid) / 2.0                   AS book_half,
         sign(j.price - j.mid_t) * (j.price - j.mid_t)     AS eff_half,
         sign(j.price - j.mid_t) * (j.price - j.mid_after) AS real_half,
         sign(j.price - j.mid_t) * (j.mid_after - j.mid_t) AS impact_half
  FROM j JOIN markets m ON m.id = j.market_id
  WHERE j.mid_t IS NOT NULL AND j.mid_after IS NOT NULL
    AND j.price <> j.mid_t
    AND EXTRACT(EPOCH FROM (j.tt - j.mt_time)) <= 120
    AND (j.best_ask - j.best_bid) <= 0.05   -- tight book: a real quotable two-sided market
) TO STDOUT WITH CSV HEADER;
