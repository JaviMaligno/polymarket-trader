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
  // In-memory cache of last sync time per token_id
  // Eliminates expensive SELECT MAX(time) queries on compressed chunks
  private lastSyncTimeCache: Map<string, Date> = new Map();

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
   * Fetch recent trades for a MARKET from the Data API (public, no auth).
   * NOTE: the data-api ignores `asset_id` (returns a global feed); only `market`
   * (the conditionId) filters. Each returned trade carries its real `asset`.
   */
  async fetchTrades(conditionId: string): Promise<any[]> {
    await this.rateLimiter.acquire('data_trades');

    try {
      const response = await axios.get('https://data-api.polymarket.com/trades', {
        params: { market: conditionId, limit: '100' },
        timeout: 15000,
      });
      return Array.isArray(response.data) ? response.data : [];
    } catch (error: any) {
      if (error.response?.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Sync a market's trades to the DB. One `market=conditionId` query returns both
   * outcomes' trades; each is stored under its real `asset` (token_id). Guards to
   * the market's two known tokens. Dedupes via the unique (time, tx_hash, token_id,
   * side, price, size) index.
   */
  async syncTradesToDb(market: {
    id: string;
    condition_id: string;
    clob_token_id_yes: string;
    clob_token_id_no: string | null;
  }): Promise<{ inserted: number }> {
    const cacheKey = `trades:${market.id}`;
    const lastSync = this.lastSyncTimeCache.get(cacheKey);

    const trades = await this.fetchTrades(market.condition_id);
    if (trades.length === 0) {
      this.lastSyncTimeCache.set(cacheKey, new Date());
      return { inserted: 0 };
    }

    const validTokens = new Set(
      [market.clob_token_id_yes, market.clob_token_id_no].filter(Boolean) as string[]
    );

    const newTrades = trades.filter((t: any) => {
      if (!validTokens.has(String(t.asset))) return false;
      if (lastSync) return new Date((t.timestamp || 0) * 1000) > lastSync;
      return true;
    });

    if (newTrades.length === 0) {
      this.lastSyncTimeCache.set(cacheKey, new Date());
      return { inserted: 0 };
    }

    const values: any[] = [];
    const placeholders: string[] = [];
    newTrades.forEach((t: any, idx: number) => {
      const baseIdx = idx * 8;
      placeholders.push(
        `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8})`
      );
      const tradeTime = new Date((t.timestamp || 0) * 1000);
      const side = (t.side || 'BUY').toUpperCase() === 'BUY' ? 'buy' : 'sell';
      values.push(
        tradeTime,
        market.id,
        String(t.asset),
        side,
        parseFloat(t.price) || 0,
        parseFloat(t.size) || 0,
        t.proxyWallet || null,
        t.transactionHash || null,
      );
    });

    try {
      const result = await query(
        `INSERT INTO trades (time, market_id, token_id, side, price, size, maker_address, tx_hash)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (time, tx_hash, token_id, side, price, size) DO NOTHING`,
        values
      );
      const inserted = result.rowCount || 0;
      this.lastSyncTimeCache.set(cacheKey, new Date());
      if (inserted > 0) {
        logger.debug({ marketId: market.id, inserted, total: newTrades.length }, 'Synced trades');
      }
      return { inserted };
    } catch (error) {
      logger.error({ error, marketId: market.id }, 'Error inserting trades');
      return { inserted: 0 };
    }
  }

  /**
   * Sync trades for all active markets
   * Respects MAX_TRACKED_MARKETS config
   */
  async syncAllTrades(): Promise<{ markets: number; totalInserted: number; errors: number }> {
    const marketsResult = await query(
      `SELECT id, condition_id, clob_token_id_yes, clob_token_id_no
       FROM markets
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND condition_id IS NOT NULL
       ORDER BY market_score DESC NULLS LAST`
    );

    const markets = marketsResult.rows;
    let totalInserted = 0;
    let errors = 0;

    for (const market of markets) {
      try {
        const res = await this.syncTradesToDb(market as {
          id: string;
          condition_id: string;
          clob_token_id_yes: string;
          clob_token_id_no: string | null;
        });
        totalInserted += res.inserted;
      } catch (error) {
        logger.error({ error, marketId: market.id }, 'Error syncing trades');
        errors++;
      }
    }

    logger.info({ markets: markets.length, totalInserted, errors }, 'Trades synced');
    return { markets: markets.length, totalInserted, errors };
  }

  /**
   * Estimate volatility from recent price changes
   */
  private estimateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0.02; // Default 2% volatility

    // Calculate standard deviation of returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        returns.push(Math.log(prices[i] / prices[i - 1]));
      }
    }

    if (returns.length === 0) return 0.02;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Clamp between 0.5% and 10%
    return Math.max(0.005, Math.min(0.10, stdDev));
  }

  /**
   * Sync price history for a market to database
   */
  async syncPriceHistoryToDb(
    marketId: string,
    tokenId: string,
    fidelity: FidelityLevel = 60
  ): Promise<{ inserted: number; skipped: number }> {
    // Use in-memory cache for last sync time (avoids slow SELECT MAX(time) on compressed chunks)
    // Falls back to DB query only on cold start (cache miss)
    let lastTime: Date | null = this.lastSyncTimeCache.get(tokenId) || null;

    if (!lastTime) {
      const lastRecord = await query(
        'SELECT MAX(time) as last_time FROM price_history WHERE token_id = $1',
        [tokenId]
      );
      lastTime = lastRecord.rows[0]?.last_time || null;
    }

    const startTs = lastTime
      ? Math.floor(new Date(lastTime).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // 30 days ago

    logger.debug({ tokenId, startTs, lastTime }, 'Fetching price history');

    const history = await this.fetchPriceHistory(tokenId, fidelity, startTs);

    if (history.length === 0) {
      // Cache the current time so we don't re-query MAX(time) next cycle
      if (lastTime) {
        this.lastSyncTimeCache.set(tokenId, lastTime);
      } else {
        this.lastSyncTimeCache.set(tokenId, new Date());
      }
      return { inserted: 0, skipped: 0 };
    }

    let inserted = 0;
    let skipped = 0;

    // Estimate volatility from recent prices for realistic OHLC simulation
    const recentPrices = history.slice(-20).map(p => parseFloat(p.p));
    const volatility = this.estimateVolatility(recentPrices);

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

        const close = parseFloat(point.p);

        // Build realistic OHLC bars using estimated volatility
        // This gives signal generators actual variation to work with
        const prevClose = idx > 0 ? parseFloat(batch[idx - 1].p) : close;
        const open = prevClose;

        // High/Low simulated with realistic spread based on volatility
        const halfRange = close * volatility * 0.5;
        // Ensure high >= max(open, close) and low <= min(open, close)
        const high = Math.max(open, close) + halfRange * Math.random();
        const low = Math.min(open, close) - halfRange * Math.random();

        values.push(
          new Date(point.t * 1000),  // time
          marketId,                   // market_id
          tokenId,                    // token_id
          open,                       // open (continuity from previous)
          high,                       // high (simulated with volatility)
          low,                        // low (simulated with volatility)
          close,                      // close (actual price from API)
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

    // Update cache with the latest timestamp from this sync
    if (history.length > 0) {
      const latestTs = Math.max(...history.map(p => p.t));
      this.lastSyncTimeCache.set(tokenId, new Date(latestTs * 1000));
    }

    logger.debug({ tokenId, inserted, skipped, total: history.length, volatility }, 'Synced price history with realistic OHLC');
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

    // CLOB API returns bids ascending, asks descending — sort for correct best prices
    const sortedBids = [...orderBook.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    const sortedAsks = [...orderBook.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    const bestBid = sortedBids[0] ? parseFloat(sortedBids[0].price) : null;
    const bestAsk = sortedAsks[0] ? parseFloat(sortedAsks[0].price) : null;
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
      // Parse timestamp safely - CLOB API sometimes returns invalid timestamps
      const parsedTime = new Date(orderBook.timestamp);
      const snapshotTime = isNaN(parsedTime.getTime()) ? new Date() : parsedTime;

      await query(
        `
        INSERT INTO orderbook_snapshots (
          time, market_id, token_id, best_bid, best_ask, spread, mid_price,
          bids, asks, bid_depth_10pct, ask_depth_10pct
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          snapshotTime,
          marketId,
          tokenId,
          bestBid,
          bestAsk,
          spread,
          midPrice,
          JSON.stringify(sortedBids.slice(0, 10)),  // Store top 10 BEST bid levels
          JSON.stringify(sortedAsks.slice(0, 10)),  // Store top 10 BEST ask levels
          bidDepth,
          askDepth,
        ]
      );

      // Also update market's current prices — only update current_price_yes when this
      // is the Yes token, and current_price_no when this is the No token.
      // Previously this always wrote midPrice to current_price_yes regardless of
      // which token was being synced, causing the No token's mid-price (≈1-yesPrice)
      // to overwrite current_price_yes and trigger phantom inversions in price_history.
      await query(
        `
        UPDATE markets SET
          best_bid = COALESCE($1, best_bid),
          best_ask = COALESCE($2, best_ask),
          spread = COALESCE($3, spread),
          current_price_yes = CASE WHEN clob_token_id_yes = $5 THEN COALESCE($4, current_price_yes) ELSE current_price_yes END,
          current_price_no  = CASE WHEN clob_token_id_no  = $5 THEN COALESCE($4, current_price_no)  ELSE current_price_no  END,
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
   * Sync order book snapshots for all active markets
   * Respects MAX_TRACKED_MARKETS config to limit API calls
   */
  async syncAllOrderBooks(): Promise<{ synced: number; errors: number }> {
    const marketsResult = await query(
      `
      SELECT id, clob_token_id_yes, clob_token_id_no
      FROM markets
      WHERE tracking_status IN ('warming', 'active', 'cooling')
        AND clob_token_id_yes IS NOT NULL
      ORDER BY market_score DESC NULLS LAST
      `
    );

    const markets = marketsResult.rows;
    let synced = 0;
    let errors = 0;

    for (const market of markets) {
      try {
        const yesOk = await this.syncOrderBookToDb(market.id, market.clob_token_id_yes);
        if (yesOk) synced++;

        if (market.clob_token_id_no) {
          const noOk = await this.syncOrderBookToDb(market.id, market.clob_token_id_no);
          if (noOk) synced++;
        }
      } catch (error) {
        logger.error({ error, marketId: market.id }, 'Error syncing order book');
        errors++;
      }
    }

    logger.info({ synced, errors, markets: markets.length }, 'Order books synced');
    return { synced, errors };
  }

  /**
   * Sync price history for all active markets
   * Respects MAX_TRACKED_MARKETS config to limit storage usage
   */
  async syncAllMarketsPriceHistory(): Promise<{
    markets: number;
    totalInserted: number;
    totalSkipped: number;
    errors: number;
  }> {
    // Get tracked markets ordered by score
    const marketsResult = await query(
      `
      SELECT id, clob_token_id_yes
      FROM markets
      WHERE tracking_status IN ('warming', 'active', 'cooling')
        AND clob_token_id_yes IS NOT NULL
      ORDER BY market_score DESC NULLS LAST
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
   * Update current prices for active markets
   * Respects MAX_TRACKED_MARKETS config to limit API calls
   */
  async updateAllMarketPrices(): Promise<{ updated: number; errors: number }> {
    // Get tracked markets ordered by score
    const tokensResult = await query(
      `
      SELECT id, clob_token_id_yes, clob_token_id_no
      FROM markets
      WHERE tracking_status IN ('warming', 'active', 'cooling')
        AND clob_token_id_yes IS NOT NULL
      ORDER BY market_score DESC NULLS LAST
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

        const yesUpdates: { id: string; price: number }[] = [];
        const noUpdates: { id: string; price: number }[] = [];

        for (const [tokenId, price] of prices) {
          const mapping = tokenToMarket.get(tokenId);
          if (!mapping) continue;

          if (mapping.side === 'yes') {
            yesUpdates.push({ id: mapping.marketId, price });
          } else {
            noUpdates.push({ id: mapping.marketId, price });
          }
          updated++;
        }

        // Batch update YES prices
        if (yesUpdates.length > 0) {
          const ids = yesUpdates.map((u, i) => `$${i * 2 + 1}`).join(',');
          const sets = yesUpdates.map((u, i) => `WHEN id = $${i * 2 + 1} THEN $${i * 2 + 2}`).join(' ');
          const params = yesUpdates.flatMap(u => [u.id, u.price]);
          await query(
            `UPDATE markets SET current_price_yes = CASE ${sets} END, updated_at = NOW() WHERE id IN (${ids})`,
            params
          );
        }

        // Batch update NO prices
        if (noUpdates.length > 0) {
          const ids = noUpdates.map((u, i) => `$${i * 2 + 1}`).join(',');
          const sets = noUpdates.map((u, i) => `WHEN id = $${i * 2 + 1} THEN $${i * 2 + 2}`).join(' ');
          const params = noUpdates.flatMap(u => [u.id, u.price]);
          await query(
            `UPDATE markets SET current_price_no = CASE ${sets} END, updated_at = NOW() WHERE id IN (${ids})`,
            params
          );
        }
      } catch (error) {
        logger.error({ error, batchStart: i }, 'Error updating batch prices');
        errors++;
      }
    }

    logger.info({ updated, errors, totalTokens: allTokenIds.length, batched: true }, 'Updated market prices');
    return { updated, errors };
  }

  /**
   * Snapshot current_price_yes into price_history for all tracked markets.
   * This ensures markets have continuous price bars even when CLOB /prices-history
   * returns nothing (no trades). The Bayesian confidence cap in SignalEngine
   * handles flat bars (same price) by counting them as non-informative.
   */
  async snapshotCurrentPricesToHistory(): Promise<{ inserted: number }> {
    const marketsResult = await query(
      `SELECT id, clob_token_id_yes, current_price_yes
       FROM markets
       WHERE tracking_status IN ('warming', 'active', 'cooling')
         AND clob_token_id_yes IS NOT NULL
         AND current_price_yes IS NOT NULL
         AND current_price_yes > 0
       ORDER BY market_score DESC NULLS LAST`
    );

    if (marketsResult.rows.length === 0) return { inserted: 0 };

    const now = new Date();
    // Round to nearest 5 minutes to align with sync interval
    now.setSeconds(0, 0);
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5);

    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < marketsResult.rows.length; i += batchSize) {
      const batch = marketsResult.rows.slice(i, i + batchSize);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (const row of batch) {
        const price = parseFloat(row.current_price_yes);
        if (isNaN(price) || price <= 0) continue;

        const idx = values.length;
        placeholders.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8})`);
        values.push(now, row.id, row.clob_token_id_yes, price, price, price, price, 'snapshot');
      }

      if (placeholders.length === 0) continue;

      const result = await query(
        `INSERT INTO price_history (time, market_id, token_id, open, high, low, close, source)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (time, market_id, token_id) DO NOTHING`,
        values
      );
      inserted += result.rowCount ?? 0;
    }

    if (inserted > 0) {
      logger.info({ inserted, markets: marketsResult.rows.length }, 'Price snapshots inserted');
    }
    return { inserted };
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
