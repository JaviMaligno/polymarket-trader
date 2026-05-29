import axios, { AxiosInstance } from 'axios';
import { pino } from 'pino';
import { getRateLimiter } from '../services/RateLimiter.js';
import { query, transaction } from '../database/connection.js';
import type { PolymarketEvent, PolymarketMarket } from '../types/index.js';

const logger = pino({ name: 'gamma-collector' });

const GAMMA_API_URL = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const MAX_SYNC_PAGES = parseInt(process.env.MAX_SYNC_PAGES || '10', 10);
const RESOLUTION_BUDGET_PER_RUN = parseInt(process.env.RESOLUTION_BUDGET_PER_RUN || '500', 10);
const RESOLUTION_BATCH_SIZE = parseInt(process.env.RESOLUTION_BATCH_SIZE || '20', 10);
const RESOLUTION_RECHECK_HOURS = parseInt(process.env.RESOLUTION_RECHECK_HOURS || '24', 10);

/**
 * Infer category from market question using keyword matching
 */
function inferCategoryFromQuestion(question: string): string | null {
  const q = question.toLowerCase();

  // Politics
  if (/trump|biden|democrat|republican|election|president|congress|senate|governor|vote|poll/i.test(q)) {
    return 'Politics';
  }
  // Crypto
  if (/bitcoin|btc|ethereum|eth|crypto|solana|sol|token|blockchain|defi/i.test(q)) {
    return 'Crypto';
  }
  // Sports
  if (/nfl|nba|mlb|nhl|soccer|football|basketball|tennis|golf|championship|super bowl|world cup|olympics/i.test(q)) {
    return 'Sports';
  }
  // Entertainment
  if (/oscar|emmy|grammy|movie|film|album|artist|celebrity|netflix|spotify|tiktok/i.test(q)) {
    return 'Entertainment';
  }
  // Science & Tech
  if (/spacex|nasa|ai |artificial intelligence|openai|google|apple|microsoft|tesla|launch|rocket/i.test(q)) {
    return 'Science & Tech';
  }
  // Finance
  if (/stock|s&p|nasdaq|fed|interest rate|inflation|gdp|recession|market|economy/i.test(q)) {
    return 'Finance';
  }
  // Weather
  if (/hurricane|earthquake|weather|temperature|climate|storm/i.test(q)) {
    return 'Weather';
  }
  // World Affairs
  if (/ukraine|russia|china|war|military|nato|un |united nations/i.test(q)) {
    return 'World Affairs';
  }

  return null; // Unknown category
}

interface GammaMarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}

interface GammaEventsResponse {
  data: PolymarketEvent[];
  next_cursor?: string;
}

/**
 * Parse Gamma `outcomePrices` (JSON string like '["1","0"]') into a resolution
 * outcome. YES price ≥0.99 → 'yes', ≤0.01 → 'no', otherwise (50-50, invalid,
 * malformed) → null. MarketPerformanceTracker treats any non-'yes' as 0.0 PnL,
 * so we only mark clean yes/no resolutions.
 */
export function parseResolutionOutcome(outcomePrices: string | null | undefined): 'yes' | 'no' | null {
  try {
    const prices = JSON.parse(outcomePrices || '[]');
    const yesPrice = prices[0] != null ? parseFloat(prices[0]) : null;
    if (yesPrice === null || isNaN(yesPrice)) return null;
    if (yesPrice >= 0.99) return 'yes';
    if (yesPrice <= 0.01) return 'no';
    return null;
  } catch {
    return null;
  }
}

export class GammaCollector {
  private client: AxiosInstance;
  private rateLimiter = getRateLimiter();

  constructor() {
    this.client = axios.create({
      baseURL: GAMMA_API_URL,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Fetch a single market by ID
   */
  async fetchMarket(marketId: string): Promise<PolymarketMarket | null> {
    await this.rateLimiter.acquire('gamma_general');

    try {
      const response = await this.client.get<PolymarketMarket>(`/markets/${marketId}`);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Sync all markets to database (streaming to avoid memory issues)
   */
  async syncMarketsToDb(): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    let cursor: string | undefined;
    let page = 0;

    logger.info('Syncing markets to database (streaming)');

    do {
      await this.rateLimiter.acquire('gamma_markets');

      const params: Record<string, string> = {
        limit: '100',
        active: 'true',
        closed: 'false',
      };

      if (cursor) {
        params.next_cursor = cursor;
      }

      try {
        const response = await this.client.get<PolymarketMarket[]>('/markets', { params });
        const markets = response.data;

        if (!markets || markets.length === 0) {
          break;
        }

        // Batch upsert the whole page at once
        try {
          const result = await this.batchUpsertMarkets(markets);
          inserted += result.inserted;
          updated += result.updated;
        } catch (error: any) {
          logger.error({ err: error.message || String(error), page }, 'Error batch upserting markets page');
        }

        page++;
        logger.debug({ page, batchSize: markets.length, inserted, updated }, 'Processed markets batch');

        if (markets.length < 100) {
          break;
        }

        if (page >= MAX_SYNC_PAGES) {
          logger.info(`[GammaCollector] Reached MAX_SYNC_PAGES (${MAX_SYNC_PAGES}), stopping market sync`);
          break;
        }

        cursor = markets[markets.length - 1]?.id;

      } catch (error) {
        logger.error({ error, page }, 'Error fetching markets page');
        throw error;
      }
    } while (cursor);

    logger.info({ inserted, updated }, 'Finished syncing markets');
    return { inserted, updated };
  }

  /**
   * Sync resolution status for markets that have closed on Polymarket.
   * Only UPDATES existing rows (never INSERTs) — we don't need resolved
   * markets we never tracked. Populates `is_resolved`, `resolution_outcome`,
   * and `resolved_at` so that `resolveShadowTrades` (daily cron) can score
   * shadow trades against actual outcomes.
   */
  async syncResolvedMarketsToDb(): Promise<{ resolved: number; scanned: number }> {
    let resolved = 0;
    let scanned = 0;
    let offset = 0;
    let pageCount = 0;
    const limit = 100;

    logger.info('Syncing resolved markets');

    while (true) {
      await this.rateLimiter.acquire('gamma_markets');

      let markets: any[] = [];
      try {
        const response = await this.client.get<any[]>('/markets', {
          params: {
            limit: limit.toString(),
            offset: offset.toString(),
            closed: 'true',
            // Newest resolutions first — sort desc by updatedAt if supported; Gamma
            // doesn't reject unknown params, so this is a best-effort hint.
            order: 'updatedAt',
            ascending: 'false',
          },
        });
        markets = response.data || [];
      } catch (error: any) {
        logger.error({ err: error.message || String(error), offset }, 'Error fetching closed markets page');
        break;
      }

      if (markets.length === 0) break;

      // Build batched UPDATE by id. Only rows that are NOT already resolved are
      // touched (WHERE is_resolved = false), so re-runs are idempotent and cheap.
      for (const market of markets) {
        scanned++;
        if (!market.id || !market.closed) continue;

        // Schema: `markets.resolution_outcome` is VARCHAR(10) with values
        // 'yes' | 'no' | 'invalid'. MarketPerformanceTracker interprets any
        // non-'yes' value as 0.0 in PnL, so invalid markets are skipped here to
        // avoid polluting shadow resolution.
        const resolutionOutcome = parseResolutionOutcome(market.outcomePrices);

        if (resolutionOutcome === null) continue;

        // Prefer the API's closedTime; fall back to now for rows missing it.
        const resolvedAt = market.closedTime
          ? new Date(market.closedTime.replace(' ', 'T').replace('+00', 'Z'))
          : new Date();

        try {
          const result = await query(
            `
            UPDATE markets
            SET is_resolved = true,
                resolution_outcome = $1,
                resolved_at = $2,
                is_active = false,
                updated_at = NOW()
            WHERE id = $3
              AND COALESCE(is_resolved, false) = false
            `,
            [resolutionOutcome, resolvedAt, market.id]
          );
          if (result.rowCount && result.rowCount > 0) {
            resolved++;
          }
        } catch (err: any) {
          logger.warn({ err: err.message || String(err), marketId: market.id }, 'Failed to mark market resolved');
        }
      }

      pageCount++;
      logger.debug({ offset, batchSize: markets.length, resolved, scanned }, 'Processed closed markets batch');

      if (markets.length < limit) break;
      if (pageCount >= MAX_SYNC_PAGES) {
        logger.info(`[GammaCollector] Reached MAX_SYNC_PAGES (${MAX_SYNC_PAGES}), stopping resolved-market sync`);
        break;
      }

      offset += limit;
    }

    logger.info({ resolved, scanned }, 'Finished syncing resolved markets');
    return { resolved, scanned };
  }

  /**
   * Sync all events to database (streaming to avoid memory issues)
   */
  async syncEventsToDb(): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    let offset = 0;
    let pageCount = 0;
    const limit = 100;

    logger.info('Syncing events to database (streaming)');

    while (true) {
      await this.rateLimiter.acquire('gamma_events');

      try {
        const response = await this.client.get<PolymarketEvent[]>('/events', {
          params: {
            limit: limit.toString(),
            offset: offset.toString(),
            active: 'true',
            closed: 'false',
          },
        });

        const events = response.data;

        if (!events || events.length === 0) {
          break;
        }

        // Process batch immediately to avoid memory buildup
        for (const event of events) {
          try {
            const result = await this.upsertEvent(event);
            if (result === 'inserted') {
              inserted++;
            } else {
              updated++;
            }
          } catch (error: any) {
            logger.error({ err: error.message || String(error), eventId: event.id }, 'Error upserting event');
          }
        }

        pageCount++;
        logger.debug({ offset, batchSize: events.length, inserted, updated }, 'Processed events batch');

        if (events.length < limit) {
          break;
        }

        if (pageCount >= MAX_SYNC_PAGES) {
          logger.info(`[GammaCollector] Reached MAX_SYNC_PAGES (${MAX_SYNC_PAGES}), stopping event sync`);
          break;
        }

        offset += limit;

      } catch (error) {
        logger.error({ error, offset }, 'Error fetching events page');
        throw error;
      }
    }

    logger.info({ inserted, updated }, 'Finished syncing events');
    return { inserted, updated };
  }

  /**
   * Batch upsert markets to database (100 per query instead of 1)
   */
  private async batchUpsertMarkets(markets: any[]): Promise<{ inserted: number; updated: number }> {
    if (markets.length === 0) return { inserted: 0, updated: 0 };

    let totalProcessed = 0;

    // Process in batches of 100
    const BATCH_SIZE = 100;
    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const batch = markets.slice(i, i + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      batch.forEach((market, idx) => {
        const offset = idx * 18;

        // Parse CLOB token IDs (same logic as upsertMarket)
        let tokenIdYes = '';
        let tokenIdNo: string | null = null;
        try {
          const tokenIds = JSON.parse(market.clobTokenIds || '[]');
          tokenIdYes = tokenIds[0] || '';
          tokenIdNo = tokenIds[1] || null;
        } catch {
          // keep defaults
        }

        // Parse outcome prices (same logic as upsertMarket)
        let priceYes: number | null = null;
        let priceNo: number | null = null;
        try {
          const prices = JSON.parse(market.outcomePrices || '[]');
          priceYes = prices[0] ? parseFloat(prices[0]) : null;
          priceNo = prices[1] ? parseFloat(prices[1]) : null;
        } catch {
          priceYes = market.bestBid || market.lastTradePrice || null;
        }

        values.push(
          market.id,
          tokenIdYes,
          tokenIdNo,
          market.conditionId,
          market.question,
          market.description,
          inferCategoryFromQuestion(market.question || ''),
          market.endDate ? new Date(market.endDate) : null,
          priceYes,
          priceNo,
          market.spread || null,
          market.volume24hr || null,
          market.liquidityNum || null,
          market.bestBid || null,
          market.bestAsk || null,
          market.lastTradePrice || null,
          market.active && !market.closed,
          !market.active && market.closed,
        );
        placeholders.push(
          `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11},$${offset+12},$${offset+13},$${offset+14},$${offset+15},$${offset+16},$${offset+17},$${offset+18},NOW(),NOW())`
        );
      });

      await query(`
        INSERT INTO markets (
          id, clob_token_id_yes, clob_token_id_no, condition_id, question, description,
          category, end_date, current_price_yes, current_price_no, spread,
          volume_24h, liquidity, best_bid, best_ask, last_trade_price,
          is_active, is_resolved, created_at, updated_at
        ) VALUES ${placeholders.join(',')}
        ON CONFLICT (id) DO UPDATE SET
          current_price_yes = EXCLUDED.current_price_yes,
          current_price_no = EXCLUDED.current_price_no,
          spread = EXCLUDED.spread,
          volume_24h = EXCLUDED.volume_24h,
          liquidity = EXCLUDED.liquidity,
          best_bid = EXCLUDED.best_bid,
          best_ask = EXCLUDED.best_ask,
          last_trade_price = EXCLUDED.last_trade_price,
          updated_at = NOW()
      `, values);

      totalProcessed += batch.length;
    }

    return { inserted: 0, updated: totalProcessed };
  }

  /**
   * Upsert a single market to the database
   */
  private async upsertMarket(market: PolymarketMarket): Promise<'inserted' | 'updated'> {
    // Parse CLOB token IDs (format: "[id1,id2]" or "[id1]")
    let tokenIdYes = '';
    let tokenIdNo: string | null = null;

    try {
      const tokenIds = JSON.parse(market.clobTokenIds || '[]');
      tokenIdYes = tokenIds[0] || '';
      tokenIdNo = tokenIds[1] || null;
    } catch {
      logger.warn({ marketId: market.id, clobTokenIds: market.clobTokenIds }, 'Failed to parse CLOB token IDs');
    }

    // Parse outcome prices
    let priceYes: number | null = null;
    let priceNo: number | null = null;

    try {
      const prices = JSON.parse(market.outcomePrices || '[]');
      priceYes = prices[0] ? parseFloat(prices[0]) : null;
      priceNo = prices[1] ? parseFloat(prices[1]) : null;
    } catch {
      // Use direct price fields if available
      priceYes = market.bestBid || market.lastTradePrice || null;
    }

    const result = await query(
      `
      INSERT INTO markets (
        id, clob_token_id_yes, clob_token_id_no, condition_id, question, description,
        category, end_date, current_price_yes, current_price_no, spread,
        volume_24h, liquidity, best_bid, best_ask, last_trade_price,
        is_active, is_resolved, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        current_price_yes = EXCLUDED.current_price_yes,
        current_price_no = EXCLUDED.current_price_no,
        spread = EXCLUDED.spread,
        volume_24h = EXCLUDED.volume_24h,
        liquidity = EXCLUDED.liquidity,
        best_bid = EXCLUDED.best_bid,
        best_ask = EXCLUDED.best_ask,
        last_trade_price = EXCLUDED.last_trade_price,
        updated_at = NOW()
      RETURNING (xmax = 0) AS is_insert
      `,
      [
        market.id,
        tokenIdYes,
        tokenIdNo,
        market.conditionId,
        market.question,
        market.description,
        inferCategoryFromQuestion(market.question || ''),
        market.endDate ? new Date(market.endDate) : null,
        priceYes,
        priceNo,
        market.spread || null,
        market.volume24hr || null,
        market.liquidityNum || null,
        market.bestBid || null,
        market.bestAsk || null,
        market.lastTradePrice || null,
        market.active && !market.closed,
        !market.active && market.closed,
      ]
    );

    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
  }

  /**
   * Upsert a single event to the database
   */
  private async upsertEvent(event: PolymarketEvent): Promise<'inserted' | 'updated'> {
    // Make slug unique by appending event id to handle potential duplicates
    const slug = event.slug ? `${event.slug}-${event.id}` : `event-${event.id}`;

    try {
      const result = await query(
        `
        INSERT INTO events (
          id, slug, title, description, start_date, end_date,
          category, tags, is_active, is_closed, liquidity, volume,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          is_active = EXCLUDED.is_active,
          is_closed = EXCLUDED.is_closed,
          liquidity = EXCLUDED.liquidity,
          volume = EXCLUDED.volume,
          updated_at = NOW()
        RETURNING (xmax = 0) AS is_insert
        `,
        [
          event.id,
          slug,
          event.title,
          event.description,
          event.startDate ? new Date(event.startDate) : null,
          event.endDate ? new Date(event.endDate) : null,
          event.category,
          JSON.stringify(event.tags || []),
          event.active,
          event.closed,
          event.liquidity || 0,
          event.volume || 0,
        ]
      );

      // Link event's markets (market data is synced separately by syncMarketsToDb)
      if (event.markets && event.markets.length > 0) {
        const marketIds = event.markets.map((m: any) => m.id).filter(Boolean);
        if (marketIds.length > 0) {
          await query(
            `UPDATE markets SET event_id = $1, category = COALESCE($3, category) WHERE id = ANY($2::varchar[])`,
            [event.id, marketIds, event.category || null]
          );
        }
      }

      return result.rows[0]?.is_insert ? 'inserted' : 'updated';
    } catch (error: any) {
      // If slug conflict, try to update by id only
      if (error.code === '23505' && error.constraint?.includes('slug')) {
        logger.warn({ eventId: event.id, slug }, 'Slug conflict, updating by id');
        await query(
          `
          UPDATE events SET
            title = $1,
            is_active = $2,
            is_closed = $3,
            liquidity = $4,
            volume = $5,
            updated_at = NOW()
          WHERE id = $6
          `,
          [event.title, event.active, event.closed, event.liquidity || 0, event.volume || 0, event.id]
        );
        return 'updated';
      }
      throw error;
    }
  }

  /**
   * Resolve OUR ended-but-unresolved markets by querying Gamma per-id, instead of
   * scanning Polymarket's global closed feed (which the 5-min crypto firehose
   * starves — see docs/superpowers/specs/2026-05-29-resolution-from-our-universe-design.md).
   * Consumers (shadow_trades / market_panel) and tradeable types are resolved first.
   * Batch path used: Gamma /markets?id=...&id=... returns multiple rows (verified rows:2).
   */
  async resolveOurMarkets(): Promise<{ resolved: number; checked: number }> {
    // Idempotent schema guard (init SQL only runs on first volume init).
    await query(`ALTER TABLE markets ADD COLUMN IF NOT EXISTS last_resolution_check TIMESTAMPTZ`);

    const sel = await query<{ id: string }>(
      `
      SELECT m.id
      FROM markets m
      WHERE m.end_date < NOW()
        AND NOT COALESCE(m.is_resolved, false)
        AND (m.last_resolution_check IS NULL
             OR m.last_resolution_check < NOW() - ($1 || ' hours')::interval)
      ORDER BY
        (EXISTS (SELECT 1 FROM shadow_trades s WHERE s.market_id = m.id AND s.resolved_at IS NULL)) DESC,
        (EXISTS (SELECT 1 FROM market_panel mp WHERE mp.market_id = m.id AND mp.resolved_at IS NULL)) DESC,
        (m.market_type IN ('crypto_daily','event_financial','event_short')) DESC,
        m.end_date DESC
      LIMIT $2
      `,
      [String(RESOLUTION_RECHECK_HOURS), RESOLUTION_BUDGET_PER_RUN]
    );

    const ids = sel.rows.map((r) => String(r.id));
    if (ids.length === 0) {
      logger.info('No unresolved-ended markets in budget window');
      return { resolved: 0, checked: 0 };
    }

    let resolved = 0;
    for (let i = 0; i < ids.length; i += RESOLUTION_BATCH_SIZE) {
      const chunk = ids.slice(i, i + RESOLUTION_BATCH_SIZE);
      await this.rateLimiter.acquire('gamma_markets');

      let rows: any[] = [];
      try {
        const params = new URLSearchParams();
        for (const id of chunk) params.append('id', id);
        params.append('closed', 'true');
        const response = await this.client.get<any[]>('/markets', { params });
        rows = response.data || [];
      } catch (err: any) {
        // Transient — do NOT throttle; retry next run.
        logger.error({ err: err.message || String(err), chunkSize: chunk.length }, 'Resolution batch fetch failed');
        continue;
      }

      const returned = new Set<string>();
      for (const m of rows) {
        returned.add(String(m.id));
        const outcome = parseResolutionOutcome(m.outcomePrices);
        if (outcome === null) {
          await this.bumpResolutionCheck(String(m.id)); // 50-50 / invalid — don't re-query hourly
          continue;
        }
        const resolvedAt = m.closedTime
          ? new Date(String(m.closedTime).replace(' ', 'T').replace('+00', 'Z'))
          : new Date();
        try {
          await query(
            `UPDATE markets SET is_resolved=true, resolution_outcome=$1, resolved_at=$2,
                    is_active=false, updated_at=NOW()
             WHERE id=$3 AND COALESCE(is_resolved,false)=false`,
            [outcome, resolvedAt, m.id]
          );
          resolved++;
        } catch (err: any) {
          logger.warn({ err: err.message || String(err), marketId: m.id }, 'Failed to mark market resolved');
        }
      }
      // Requested-but-absent (still open) → throttle.
      for (const id of chunk) {
        if (!returned.has(id)) await this.bumpResolutionCheck(id);
      }
    }

    logger.info({ resolved, checked: ids.length }, 'Finished resolving our markets');
    return { resolved, checked: ids.length };
  }

  private async bumpResolutionCheck(id: string): Promise<void> {
    try {
      await query(`UPDATE markets SET last_resolution_check = NOW() WHERE id = $1`, [id]);
    } catch (err: any) {
      logger.warn({ err: err.message || String(err), marketId: id }, 'Failed to bump last_resolution_check');
    }
  }

  /**
   * Get market statistics
   */
  async getMarketStats(): Promise<{
    totalMarkets: number;
    activeMarkets: number;
    resolvedMarkets: number;
    categories: Record<string, number>;
  }> {
    const [totalResult, activeResult, resolvedResult, categoryResult] = await Promise.all([
      query('SELECT COUNT(*) as count FROM markets'),
      query('SELECT COUNT(*) as count FROM markets WHERE is_active = true'),
      query('SELECT COUNT(*) as count FROM markets WHERE is_resolved = true'),
      query('SELECT category, COUNT(*) as count FROM markets WHERE category IS NOT NULL GROUP BY category'),
    ]);

    const categories: Record<string, number> = {};
    for (const row of categoryResult.rows) {
      categories[row.category] = parseInt(row.count);
    }

    return {
      totalMarkets: parseInt(totalResult.rows[0]?.count || '0'),
      activeMarkets: parseInt(activeResult.rows[0]?.count || '0'),
      resolvedMarkets: parseInt(resolvedResult.rows[0]?.count || '0'),
      categories,
    };
  }
}

// Singleton instance
let gammaCollectorInstance: GammaCollector | null = null;

export function getGammaCollector(): GammaCollector {
  if (!gammaCollectorInstance) {
    gammaCollectorInstance = new GammaCollector();
  }
  return gammaCollectorInstance;
}
