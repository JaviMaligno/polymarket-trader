-- Migration 015: Create news_articles table for dedup and audit trail
--
-- Stores fetched news articles from all sources (Google News RSS, Finnhub).
-- Used for deduplication (by URL) and audit trail of what news was processed.

CREATE TABLE IF NOT EXISTS news_articles (
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(50) NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    category VARCHAR(50),
    raw_sentiment DECIMAL(5,4),
    language VARCHAR(10) DEFAULT 'en',
    metadata JSONB DEFAULT '{}'
);

SELECT create_hypertable('news_articles', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Non-unique index (TimescaleDB requires time in unique indexes; dedup handled in app layer)
CREATE INDEX IF NOT EXISTS idx_news_articles_url ON news_articles (url, time);

SELECT add_retention_policy('news_articles', INTERVAL '7 days', if_not_exists => TRUE);
