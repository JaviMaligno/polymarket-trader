-- B1 fine-cadence recorder tables. Separate from orderbook_snapshots (prod).
-- create_hypertable is wrapped so this file also works on a plain Postgres
-- (local taster) where TimescaleDB is absent.

CREATE TABLE IF NOT EXISTS mm_book_events (
  time        TIMESTAMPTZ NOT NULL,
  token_id    VARCHAR(128) NOT NULL,
  market_id   VARCHAR(128) NOT NULL,
  event_type  TEXT NOT NULL,
  best_bid      DECIMAL(10,6),
  best_ask      DECIMAL(10,6),
  mid           DECIMAL(10,6),
  best_bid_size DECIMAL(20,6),
  best_ask_size DECIMAL(20,6)
);
CREATE INDEX IF NOT EXISTS idx_mm_book_token_time ON mm_book_events (token_id, time);
ALTER TABLE mm_book_events ADD COLUMN IF NOT EXISTS best_bid_size DECIMAL(20,6);
ALTER TABLE mm_book_events ADD COLUMN IF NOT EXISTS best_ask_size DECIMAL(20,6);

CREATE TABLE IF NOT EXISTS mm_trade_events (
  time        TIMESTAMPTZ NOT NULL,
  token_id    VARCHAR(128) NOT NULL,
  market_id   VARCHAR(128) NOT NULL,
  price       DECIMAL(10,6) NOT NULL,
  size        DECIMAL(20,6),
  side        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mm_trade_token_time ON mm_trade_events (token_id, time);

CREATE TABLE IF NOT EXISTS mm_capture_gaps (
  token_id    VARCHAR(128),
  gap_start   TIMESTAMPTZ NOT NULL,
  gap_end     TIMESTAMPTZ NOT NULL,
  reason      TEXT
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('mm_book_events', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
    PERFORM create_hypertable('mm_trade_events', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
  END IF;
END $$;
