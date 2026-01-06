import axios, { AxiosInstance } from 'axios';
import { pino } from 'pino';
import { getRateLimiter } from '../services/RateLimiter.js';
import { query } from '../database/connection.js';
import type { PriceHistory, OrderBook, OrderBookLevel } from '../types/index.js';

const logger = pino({ name: 'clob-collector' });

const CLOB_API_URL = process.env.CLOB_API_URL || 'https://clob.polymarket.com';

interface PriceHistoryResponse {
  history: PriceHistory[];
}

interface BookResponse {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

type FidelityLevel = 1 | 60 | 3600 | 86400;  // 1min, 1hour, 1day

export class ClobCollector {
  private client: AxiosInstance;
  private rateLimiter = getRateLimiter();

  constructor() {
    this.client = axios.create({
      baseURL: CLOB_API_URL,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Fetch price history for a token
   * @param tokenId - The CLOB token ID
   * @param fidelity - Resolution in seconds (1=1min, 60=1hour, 3600=1day)
   * @param startTs - Start timestamp (optional, defaults to 30 days ago)
   * @param endTs - End timestamp (optional, defaults to now)
   */
  async fetchPriceHistory(
    tokenId: string,
    fidelity: FidelityLevel = 60,
    startTs?: number,
    endTs?: number
  ): Promise<PriceHistory[]> {
    await this.rateLimiter.acquire('clob_history');

    const params: Record<string, string> = {
      fidelity: fidelity.toString(),
    };

    if (startTs) {
      params.startTs = startTs.toString();
    }

    if (endTs) {
      params.endTs = endTs.toString();
    }

    try {
      const response = await this.client.get<PriceHistoryResponse>(
        `/prices-history`,
        {
          params: {
            ...params,
            market: tokenId,
          },
        }
      );

      return response.data.history || [];
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn({ tokenId }, 'No price history found for token');
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetch current order book for a token
   */
  async fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
    await this.rateLimiter.acquire('clob_books');

    try {
      const response = await this.client.get<BookResponse>(`/book`, {
        params: { token_id: tokenId },
      });

      return {
        market: response.data.market,
        asset_id: response.data.asset_id,
        hash: response.data.hash,
        timestamp: response.data.timestamp,
        bids: response.data.bids || [],
        asks: response.data.asks || [],
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch current price for a token
   */
  async fetchCurrentPrice(tokenId: string): Promise<{ price: number; timestamp: Date } | null> {
    await this.rateLimiter.acquire('clob_prices');

    try {
      const response = await this.client.get<{ price: string }>(`/price`, {
        params: { token_id: tokenId },
      });

      return {
        price: parseFloat(response.data.price),
        timestamp: new Date(),
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch prices for multiple tokens (fetches individually since batch endpoint is unreliable)
   */
  async fetchPricesBatch(tokenIds: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    // Fetch prices individually with rate limiting
    for (const tokenId of tokenIds) {
      try {
        const result = await this.fetchCurrentPrice(tokenId);
        if (result) {
          prices.set(tokenId, result.price);
        }
      } catch (error) {
        // Skip failed individual fetches silently
      }
    }

    return prices;
  }

  /**
   * Sync price history for a market to database
   */
  async syncPriceHistoryToDb(
    marketId: string,
    tokenId: string,
    fidelity: FidelityLevel = 60
  ): Promise<{ inserted: number; skipped: number }> {
    // Get last recorded timestamp for this token
    const lastRecord = await query(
      'SELECT MAX(time) as last_time FROM price_history WHERE token_id = $1',
      [tokenId]
    );

    const lastTime = lastRecord.rows[0]?.last_time;
    const startTs = lastTime
      ? Math.floor(new Date(lastTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // 30 days ago

    logger.debug({ tokenId, startTs, lastTime }, 'Fetching price history');

    const history = await this.fetchPriceHistory(tokenId, fidelity, startTs);

    if (history.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    let inserted = 0;
    let skipped = 0;

    // Batch insert for performance
    const batchSize = 1000;
    for (let i = 0; i < history.length; i += batchSize) {
      const batch = history.slice(i, i + batchSize);

      const values: any[] = [];
      const placeholders: string[] = [];

      batch.forEach((point, idx) => {
        const baseIdx = idx * 7;
        placeholders.push(
          `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7})`
        );

        const price = parseFloat(point.p);
        values.push(
          new Date(point.t * 1000),  // time
          marketId,                   // market_id
          tokenId,                    // token_id
          price,                      // open
          price,                      // high
          price,                      // low
          price,                      // close
        );
      });

      try {
        const result = await query(
          `
          INSERT INTO price_history (time, market_id, token_id, open, high, low, close)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (time, market_id, token_id) DO NOTHING
          `,
          values
        );

        inserted += result.rowCount || 0;
        skipped += batch.length - (result.rowCount || 0);
      } catch (error) {
        logger.error({ error, tokenId, batchStart: i }, 'Error inserting price history batch');
      }
    }

    logger.debug({ tokenId, inserted, skipped, total: history.length }, 'Synced price history');
    return { inserted, skipped };
  }

  /**
   * Sync order book snapshot to database
   */
  async syncOrderBookToDb(marketId: string, tokenId: string): Promise<boolean> {
    const orderBook = await this.fetchOrderBook(tokenId);

    if (!orderBook) {
      return false;
    }

    const bestBid = orderBook.bids[0] ? parseFloat(orderBook.bids[0].price) : null;
    const bestAsk = orderBook.asks[0] ? parseFloat(orderBook.asks[0].price) : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
    const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;

    // Calculate depth within 10% of best price
    let bidDepth = 0;
    let askDepth = 0;

    if (bestBid) {
      const threshold = bestBid * 0.9;
      for (const level of orderBook.bids) {
        if (parseFloat(level.price) >= threshold) {
          bidDepth += parseFloat(level.size);
        }
      }
    }

    if (bestAsk) {
      const threshold = bestAsk * 1.1;
      for (const level of orderBook.asks) {
        if (parseFloat(level.price) <= threshold) {
          askDepth += parseFloat(level.size);
        }
      }
    }

    try {
      await query(
        `
        INSERT INTO orderbook_snapshots (
          time, market_id, token_id, best_bid, best_ask, spread, mid_price,
          bids, asks, bid_depth_10pct, ask_depth_10pct
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          new Date(orderBook.timestamp),
          marketId,
          tokenId,
          bestBid,
          bestAsk,
          spread,
          midPrice,
          JSON.stringify(orderBook.bids.slice(0, 10)),  // Store top 10 levels
          JSON.stringify(orderBook.asks.slice(0, 10)),
          bidDepth,
          askDepth,
        ]
      );

      // Also update market's current prices
      await query(
        `
        UPDATE markets SET
          best_bid = COALESCE($1, best_bid),
          best_ask = COALESCE($2, best_ask),
          spread = COALESCE($3, spread),
          current_price_yes = COALESCE($4, current_price_yes),
          updated_at = NOW()
        WHERE clob_token_id_yes = $5 OR clob_token_id_no = $5
        `,
        [bestBid, bestAsk, spread, midPrice, tokenId]
      );

      return true;
    } catch (error) {
      logger.error({ error, tokenId }, 'Error saving order book snapshot');
      return false;
    }
  }

  /**
   * Sync price history for all active markets
   */
  async syncAllMarketsPriceHistory(): Promise<{
    markets: number;
    totalInserted: number;
    totalSkipped: number;
    errors: number;
  }> {
    // Get all active markets with their token IDs
    const marketsResult = await query(
      `
      SELECT id, clob_token_id_yes, clob_token_id_no
      FROM markets
      WHERE is_active = true AND clob_token_id_yes IS NOT NULL
      ORDER BY volume_24h DESC NULLS LAST
      `
    );

    const markets = marketsResult.rows;
    let totalInserted = 0;
    let totalSkipped = 0;
    let errors = 0;

    logger.info({ marketCount: markets.length }, 'Starting to sync price history for all markets');

    for (const market of markets) {
      try {
        // Sync YES token
        const yesResult = await this.syncPriceHistoryToDb(
          market.id,
          market.clob_token_id_yes,
          60  // 1-minute bars
        );
        totalInserted += yesResult.inserted;
        totalSkipped += yesResult.skipped;

        // Sync NO token if exists
        if (market.clob_token_id_no) {
          const noResult = await this.syncPriceHistoryToDb(
            market.id,
            market.clob_token_id_no,
            60
          );
          totalInserted += noResult.inserted;
          totalSkipped += noResult.skipped;
        }

      } catch (error) {
        logger.error({ error, marketId: market.id }, 'Error syncing market price history');
        errors++;
      }
    }

    logger.info({ markets: markets.length, totalInserted, totalSkipped, errors }, 'Finished syncing price history');

    return {
      markets: markets.length,
      totalInserted,
      totalSkipped,
      errors,
    };
  }

  /**
   * Update current prices for all active markets
   */
  async updateAllMarketPrices(): Promise<{ updated: number; errors: number }> {
    // Get all active token IDs
    const tokensResult = await query(
      `
      SELECT id, clob_token_id_yes, clob_token_id_no
      FROM markets
      WHERE is_active = true AND clob_token_id_yes IS NOT NULL
      `
    );

    const allTokenIds: string[] = [];
    const tokenToMarket: Map<string, { marketId: string; side: 'yes' | 'no' }> = new Map();

    for (const row of tokensResult.rows) {
      if (row.clob_token_id_yes) {
        allTokenIds.push(row.clob_token_id_yes);
        tokenToMarket.set(row.clob_token_id_yes, { marketId: row.id, side: 'yes' });
      }
      if (row.clob_token_id_no) {
        allTokenIds.push(row.clob_token_id_no);
        tokenToMarket.set(row.clob_token_id_no, { marketId: row.id, side: 'no' });
      }
    }

    // Batch fetch prices (20 at a time to avoid API URL length limits)
    let updated = 0;
    let errors = 0;
    const batchSize = 20;

    for (let i = 0; i < allTokenIds.length; i += batchSize) {
      const batch = allTokenIds.slice(i, i + batchSize);

      try {
        const prices = await this.fetchPricesBatch(batch);

        for (const [tokenId, price] of prices) {
          const mapping = tokenToMarket.get(tokenId);
          if (!mapping) continue;

          const column = mapping.side === 'yes' ? 'current_price_yes' : 'current_price_no';

          await query(
            `UPDATE markets SET ${column} = $1, updated_at = NOW() WHERE id = $2`,
            [price, mapping.marketId]
          );
          updated++;
        }
      } catch (error) {
        logger.error({ error, batchStart: i }, 'Error updating batch prices');
        errors++;
      }
    }

    logger.info({ updated, errors, totalTokens: allTokenIds.length }, 'Updated market prices');
    return { updated, errors };
  }
}

// Singleton instance
let clobCollectorInstance: ClobCollector | null = null;

export function getClobCollector(): ClobCollector {
  if (!clobCollectorInstance) {
    clobCollectorInstance = new ClobCollector();
  }
  return clobCollectorInstance;
}
