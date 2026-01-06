import axios, { AxiosInstance } from 'axios';
import { pino } from 'pino';
import { getRateLimiter } from '../services/RateLimiter.js';
import { query, transaction } from '../database/connection.js';
import type { PolymarketEvent, PolymarketMarket } from '../types/index.js';

const logger = pino({ name: 'gamma-collector' });

const GAMMA_API_URL = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';

interface GammaMarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}

interface GammaEventsResponse {
  data: PolymarketEvent[];
  next_cursor?: string;
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
   * Fetch all active markets from Gamma API
   * Uses pagination to get all markets
   */
  async fetchAllMarkets(): Promise<PolymarketMarket[]> {
    const allMarkets: PolymarketMarket[] = [];
    let cursor: string | undefined;
    let page = 0;

    logger.info('Starting to fetch all markets from Gamma API');

    do {
      await this.rateLimiter.acquire('gamma_markets');

      const params: Record<string, string> = {
        limit: '100',
        active: 'true',
        closed: 'false',  // Only fetch non-closed markets to avoid downloading thousands of historical markets
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

        allMarkets.push(...markets);
        page++;

        logger.debug({ page, count: markets.length, total: allMarkets.length }, 'Fetched markets page');

        // Gamma API uses offset-based pagination
        if (markets.length < 100) {
          break;
        }

        // Use last market ID as cursor for next page
        cursor = markets[markets.length - 1]?.id;

      } catch (error) {
        logger.error({ error, page }, 'Error fetching markets page');
        throw error;
      }
    } while (cursor);

    logger.info({ totalMarkets: allMarkets.length }, 'Finished fetching all markets');
    return allMarkets;
  }

  /**
   * Fetch all events from Gamma API
   */
  async fetchAllEvents(): Promise<PolymarketEvent[]> {
    const allEvents: PolymarketEvent[] = [];
    let offset = 0;
    const limit = 100;

    logger.info('Starting to fetch all events from Gamma API');

    while (true) {
      await this.rateLimiter.acquire('gamma_events');

      try {
        const response = await this.client.get<PolymarketEvent[]>('/events', {
          params: {
            limit: limit.toString(),
            offset: offset.toString(),
            active: 'true',
            closed: 'false',  // Only fetch non-closed events
          },
        });

        const events = response.data;

        if (!events || events.length === 0) {
          break;
        }

        allEvents.push(...events);
        logger.debug({ offset, count: events.length, total: allEvents.length }, 'Fetched events page');

        if (events.length < limit) {
          break;
        }

        offset += limit;

      } catch (error) {
        logger.error({ error, offset }, 'Error fetching events page');
        throw error;
      }
    }

    logger.info({ totalEvents: allEvents.length }, 'Finished fetching all events');
    return allEvents;
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
   * Sync all markets to database
   */
  async syncMarketsToDb(): Promise<{ inserted: number; updated: number }> {
    const markets = await this.fetchAllMarkets();
    let inserted = 0;
    let updated = 0;

    logger.info({ count: markets.length }, 'Syncing markets to database');

    for (const market of markets) {
      try {
        const result = await this.upsertMarket(market);
        if (result === 'inserted') {
          inserted++;
        } else {
          updated++;
        }
      } catch (error) {
        logger.error({ error, marketId: market.id }, 'Error upserting market');
      }
    }

    logger.info({ inserted, updated }, 'Finished syncing markets');
    return { inserted, updated };
  }

  /**
   * Sync all events to database
   */
  async syncEventsToDb(): Promise<{ inserted: number; updated: number }> {
    const events = await this.fetchAllEvents();
    let inserted = 0;
    let updated = 0;

    logger.info({ count: events.length }, 'Syncing events to database');

    for (const event of events) {
      try {
        const result = await this.upsertEvent(event);
        if (result === 'inserted') {
          inserted++;
        } else {
          updated++;
        }
      } catch (error) {
        logger.error({ error, eventId: event.id }, 'Error upserting event');
      }
    }

    logger.info({ inserted, updated }, 'Finished syncing events');
    return { inserted, updated };
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
        is_active = EXCLUDED.is_active,
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
        null, // category - would need to be parsed from event
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
        is_active = EXCLUDED.is_active,
        is_closed = EXCLUDED.is_closed,
        liquidity = EXCLUDED.liquidity,
        volume = EXCLUDED.volume,
        updated_at = NOW()
      RETURNING (xmax = 0) AS is_insert
      `,
      [
        event.id,
        event.slug,
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

    // Also sync the event's markets
    if (event.markets && event.markets.length > 0) {
      for (const market of event.markets) {
        try {
          await this.upsertMarket(market);
          // Update market's event_id
          await query(
            'UPDATE markets SET event_id = $1, category = $2 WHERE id = $3',
            [event.id, event.category, market.id]
          );
        } catch (error) {
          logger.error({ error, marketId: market.id, eventId: event.id }, 'Error upserting event market');
        }
      }
    }

    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
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
