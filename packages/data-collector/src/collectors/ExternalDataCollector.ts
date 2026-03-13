import { pino } from 'pino';
import { query } from '../database/connection.js';
import { MetaculusSource } from './sources/MetaculusSource.js';
import { ManifoldSource } from './sources/ManifoldSource.js';
import { MarketMatcher } from './MarketMatcher.js';

const logger = pino({ name: 'external-data-collector' });

export class ExternalDataCollector {
  private metaculus: MetaculusSource;
  private manifold: ManifoldSource;
  private matcher: MarketMatcher | null;
  private schemaReady = false;

  constructor(anthropicApiKey?: string) {
    this.metaculus = new MetaculusSource();
    this.manifold = new ManifoldSource();
    this.matcher = anthropicApiKey ? new MarketMatcher(anthropicApiKey) : null;
  }

  /**
   * Ensure the external data tables exist (idempotent — safe to call repeatedly).
   * Runs the 004_external_data_schema.sql DDL inline so the data-collector
   * self-heals when the migration has not been applied to the database yet.
   */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS market_crossref (
          polymarket_id VARCHAR(128) NOT NULL,
          platform VARCHAR(50) NOT NULL,
          external_id VARCHAR(255) NOT NULL,
          external_question TEXT,
          external_price DECIMAL(10,6),
          match_confidence FLOAT NOT NULL DEFAULT 0.0,
          matched_at TIMESTAMPTZ DEFAULT NOW(),
          last_fetched_at TIMESTAMPTZ,
          PRIMARY KEY (polymarket_id, platform)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_crossref_platform ON market_crossref(platform)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_crossref_confidence ON market_crossref(match_confidence)`);
      await query(`
        CREATE TABLE IF NOT EXISTS external_signals (
          id SERIAL PRIMARY KEY,
          market_id VARCHAR(128) NOT NULL,
          source VARCHAR(50) NOT NULL,
          signal_type VARCHAR(50) NOT NULL,
          value FLOAT NOT NULL,
          confidence FLOAT DEFAULT 0.5,
          metadata JSONB DEFAULT '{}',
          fetched_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_external_signals_market ON external_signals(market_id, fetched_at DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_external_signals_source ON external_signals(source, signal_type)`);
      this.schemaReady = true;
      logger.info('External data schema verified/created');
    } catch (error) {
      logger.error({ error }, 'Failed to ensure external data schema');
    }
  }

  /**
   * Fetch current prices from external platforms for all matched markets
   * and store price divergence signals. Runs hourly.
   */
  async fetchMatchedMarketPrices(): Promise<number> {
    await this.ensureSchema();
    const crossrefResult = await query(
      `SELECT polymarket_id, platform, external_id
       FROM market_crossref
       WHERE match_confidence >= 0.7`
    );

    const rows = crossrefResult.rows;
    if (rows.length === 0) {
      logger.debug('No matched markets found in market_crossref');
      return 0;
    }

    let storedCount = 0;

    for (const row of rows) {
      try {
        const { polymarket_id, platform, external_id } = row;

        // Fetch external probability
        let probability: number | null = null;
        if (platform === 'metaculus') {
          const data = await this.metaculus.fetchQuestionById(external_id);
          probability = data?.probability ?? null;
        } else if (platform === 'manifold') {
          const data = await this.manifold.fetchMarketById(external_id);
          probability = data?.probability ?? null;
        } else {
          logger.warn({ platform }, 'Unknown external platform, skipping');
          continue;
        }

        if (probability === null) {
          logger.debug({ polymarket_id, platform, external_id }, 'No probability returned, skipping');
          continue;
        }

        // Fetch Polymarket current price
        const priceResult = await query(
          `SELECT current_price_yes FROM markets WHERE id = $1`,
          [polymarket_id]
        );

        if (priceResult.rows.length === 0 || priceResult.rows[0].current_price_yes === null) {
          logger.debug({ polymarket_id }, 'No Polymarket price found, skipping');
          continue;
        }

        const polymarketPrice: number = parseFloat(priceResult.rows[0].current_price_yes);
        const divergence = probability - polymarketPrice;

        await query(
          `INSERT INTO external_signals (market_id, source, signal_type, value, confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            polymarket_id,
            platform,
            'price_divergence',
            divergence,
            0.8,
            JSON.stringify({ externalPrice: probability, polymarketPrice }),
          ]
        );

        storedCount++;
        logger.debug(
          { polymarket_id, platform, divergence, probability, polymarketPrice },
          'Stored price divergence signal'
        );
      } catch (error) {
        logger.warn({ error, row }, 'Failed to process crossref row (non-fatal)');
      }
    }

    logger.info({ stored: storedCount, total: rows.length }, 'Fetched matched market prices');
    return storedCount;
  }

  /**
   * Query unmatched long-duration markets, fetch external candidates,
   * and use Haiku to find matches. Runs daily at 3 UTC.
   */
  async runDailyMatching(): Promise<number> {
    await this.ensureSchema();
    if (!this.matcher) {
      logger.info('No ANTHROPIC_API_KEY provided — skipping daily market matching');
      return 0;
    }

    // Query long-duration unmatched active markets
    const unmatchedResult = await query(
      `SELECT id, question FROM markets
       WHERE is_active = true AND is_resolved = false
         AND end_date > NOW() + INTERVAL '30 days'
         AND id NOT IN (SELECT polymarket_id FROM market_crossref)
       LIMIT 40`
    );

    const pmMarkets: Array<{ id: string; question: string }> = unmatchedResult.rows.map(r => ({
      id: r.id as string,
      question: r.question as string,
    }));
    if (pmMarkets.length === 0) {
      logger.info('No unmatched long-duration markets found');
      return 0;
    }

    logger.info({ count: pmMarkets.length }, 'Fetching external candidates for daily matching');

    // Fetch candidates from both platforms
    const [metaculusCandidates, manifoldCandidates] = await Promise.all([
      this.metaculus.fetchActiveQuestions(100),
      this.manifold.fetchActiveMarkets(100),
    ]);

    const allExternal = [
      ...metaculusCandidates.map(m => ({ id: m.id, question: m.question, platform: m.platform })),
      ...manifoldCandidates.map(m => ({ id: m.id, question: m.question, platform: m.platform })),
    ];

    if (allExternal.length === 0) {
      logger.warn('No external candidates fetched');
      return 0;
    }

    logger.info(
      { pmMarkets: pmMarkets.length, externalCandidates: allExternal.length },
      'Running batch market matching'
    );

    const matchResults = await this.matcher.matchBatch(pmMarkets, allExternal);

    let storedCount = 0;

    for (const match of matchResults) {
      try {
        await query(
          `INSERT INTO market_crossref (polymarket_id, platform, external_id, match_confidence)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (polymarket_id, platform) DO UPDATE SET
             external_id = EXCLUDED.external_id,
             match_confidence = EXCLUDED.match_confidence,
             matched_at = NOW()`,
          [match.polymarketId, match.platform, match.externalId, match.confidence]
        );
        storedCount++;
        logger.debug(
          { polymarketId: match.polymarketId, platform: match.platform, confidence: match.confidence },
          'Upserted market crossref match'
        );
      } catch (error) {
        logger.warn({ error, match }, 'Failed to upsert crossref match (non-fatal)');
      }
    }

    logger.info({ stored: storedCount, matches: matchResults.length }, 'Daily market matching complete');
    return storedCount;
  }
}
