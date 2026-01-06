/**
 * Live Data Feed
 *
 * Connects to Polymarket CLOB API for real-time market data.
 * Supports both REST polling and WebSocket subscriptions.
 */

import pino from 'pino';
import { EventEmitter } from 'eventemitter3';
import WebSocket from 'ws';
import type {
  FeedConfig,
  FeedState,
  FeedStatus,
  LiveMarket,
  LivePrice,
  OrderBook,
  Trade,
  TradingEvent,
} from '../types/index.js';

const logger = pino({ name: 'LiveDataFeed' });

// ============================================
// Types
// ============================================

export interface LiveDataFeedEvents {
  'status': (status: FeedStatus) => void;
  'price': (price: LivePrice) => void;
  'orderbook': (orderbook: OrderBook) => void;
  'trade': (trade: Trade) => void;
  'market': (market: LiveMarket) => void;
  'error': (error: Error) => void;
}

interface ClobMarketResponse {
  condition_id: string;
  question_id: string;
  question: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  volume: number;
  liquidity: number;
  end_date_iso: string;
  active: boolean;
}

interface ClobPriceResponse {
  token_id: string;
  price: number;
  bid: number;
  ask: number;
}

interface ClobOrderBookResponse {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
}

// WebSocket message types for Polymarket
interface WsSubscribeMessage {
  type: 'subscribe';
  channel: string;
  market?: string;
  assets_ids?: string[];
}

interface WsUnsubscribeMessage {
  type: 'unsubscribe';
  channel: string;
  market?: string;
}

interface WsPriceChangeMessage {
  event_type: 'price_change';
  market: string;
  asset_id: string;
  price: string;
  side: string;
  size: string;
  timestamp: string;
}

interface WsBookMessage {
  event_type: 'book';
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
}

interface WsTradeMessage {
  event_type: 'last_trade_price';
  market: string;
  asset_id: string;
  price: string;
  size: string;
  side: string;
  timestamp: string;
}

type WsMessage = WsPriceChangeMessage | WsBookMessage | WsTradeMessage;

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: FeedConfig = {
  apiUrl: 'https://clob.polymarket.com',
  wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  reconnectIntervalMs: 5000,
  maxReconnectAttempts: 10,
  heartbeatIntervalMs: 30000,
  subscriptionBatchSize: 50,
};

// ============================================
// Live Data Feed
// ============================================

export class LiveDataFeed extends EventEmitter<LiveDataFeedEvents> {
  private config: FeedConfig;
  private state: FeedState;
  private ws: WebSocket | null = null;
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private marketCache: Map<string, LiveMarket> = new Map();
  private priceCache: Map<string, LivePrice> = new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(config?: Partial<FeedConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      status: 'DISCONNECTED',
      connectedAt: null,
      lastMessageAt: null,
      reconnectAttempts: 0,
      subscriptions: [],
      error: null,
    };
  }

  // ============================================
  // Connection Management
  // ============================================

  /**
   * Connect to the data feed
   */
  async connect(): Promise<void> {
    if (this.state.status === 'CONNECTED' || this.state.status === 'CONNECTING') {
      logger.warn('Already connected or connecting');
      return;
    }

    this.updateStatus('CONNECTING');

    try {
      // First, verify API is reachable
      await this.healthCheck();

      // Start polling for subscribed markets
      this.startPolling();

      // Optionally connect WebSocket for real-time updates
      if (this.config.wsUrl) {
        await this.connectWebSocket();
      }

      this.state.connectedAt = new Date();
      this.state.reconnectAttempts = 0;
      this.updateStatus('CONNECTED');

      logger.info('Connected to Polymarket data feed');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.state.error = err.message;
      this.updateStatus('ERROR');
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the data feed
   */
  disconnect(): void {
    logger.info('Disconnecting from data feed');

    // Clear all intervals
    this.pollingIntervals.forEach(interval => clearInterval(interval));
    this.pollingIntervals.clear();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.updateStatus('DISCONNECTED');
  }

  /**
   * Connect WebSocket for real-time updates
   */
  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config.wsUrl) {
        resolve();
        return;
      }

      try {
        logger.info({ url: this.config.wsUrl }, 'Connecting to Polymarket WebSocket');

        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          logger.info('WebSocket connected');

          // Subscribe to all current subscriptions
          for (const marketId of this.state.subscriptions) {
            this.sendWsSubscribe(marketId);
          }

          // Start heartbeat
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleWsMessage(data);
        });

        this.ws.on('error', (error: Error) => {
          logger.error({ error: error.message }, 'WebSocket error');
          this.emit('error', error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
          this.ws = null;

          if (this.state.status === 'CONNECTED') {
            this.scheduleReconnect();
          }
        });

        // Timeout for initial connection
        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            logger.warn('WebSocket connection timeout, continuing with REST polling');
            resolve();
          }
        }, 10000);

      } catch (error) {
        logger.error({ error }, 'Failed to create WebSocket');
        // Don't reject - fall back to REST polling
        resolve();
      }
    });
  }

  /**
   * Send WebSocket subscription message
   */
  private sendWsSubscribe(marketId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const subscribeMsg: WsSubscribeMessage = {
      type: 'subscribe',
      channel: 'market',
      market: marketId,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.debug({ marketId }, 'Sent WebSocket subscription');
  }

  /**
   * Send WebSocket unsubscription message
   */
  private sendWsUnsubscribe(marketId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const unsubscribeMsg: WsUnsubscribeMessage = {
      type: 'unsubscribe',
      channel: 'market',
      market: marketId,
    };

    this.ws.send(JSON.stringify(unsubscribeMsg));
    logger.debug({ marketId }, 'Sent WebSocket unsubscription');
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleWsMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as WsMessage | WsMessage[];
      this.state.lastMessageAt = new Date();

      // Handle array of messages
      const messages = Array.isArray(message) ? message : [message];

      for (const msg of messages) {
        this.processWsMessage(msg);
      }
    } catch (error) {
      logger.debug({ error, data: data.toString().substring(0, 200) }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Process a single WebSocket message
   */
  private processWsMessage(msg: WsMessage): void {
    switch (msg.event_type) {
      case 'price_change': {
        const price: LivePrice = {
          marketId: msg.market,
          outcome: msg.asset_id,
          price: parseFloat(msg.price),
          bid: msg.side === 'BUY' ? parseFloat(msg.price) : 0,
          ask: msg.side === 'SELL' ? parseFloat(msg.price) : 0,
          spread: 0,
          timestamp: new Date(msg.timestamp),
        };

        // Update cache and merge with existing data
        const existing = this.priceCache.get(`${price.marketId}:${price.outcome}`);
        if (existing) {
          if (msg.side === 'BUY') {
            price.ask = existing.ask;
          } else {
            price.bid = existing.bid;
          }
          price.spread = price.ask - price.bid;
        }

        this.priceCache.set(`${price.marketId}:${price.outcome}`, price);
        this.emit('price', price);
        logger.debug({ marketId: msg.market, price: msg.price }, 'Price update received');
        break;
      }

      case 'book': {
        const orderbook: OrderBook = {
          marketId: msg.market,
          outcome: msg.asset_id,
          bids: msg.bids.map(b => ({
            price: parseFloat(b.price),
            size: parseFloat(b.size),
          })),
          asks: msg.asks.map(a => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
          })),
          timestamp: new Date(msg.timestamp),
        };

        this.emit('orderbook', orderbook);

        // Extract best bid/ask for price
        if (orderbook.bids.length > 0 || orderbook.asks.length > 0) {
          const bestBid = orderbook.bids[0]?.price ?? 0;
          const bestAsk = orderbook.asks[0]?.price ?? 1;
          const midPrice = (bestBid + bestAsk) / 2;

          const price: LivePrice = {
            marketId: msg.market,
            outcome: msg.asset_id,
            price: midPrice,
            bid: bestBid,
            ask: bestAsk,
            spread: bestAsk - bestBid,
            timestamp: new Date(msg.timestamp),
          };

          this.priceCache.set(`${price.marketId}:${price.outcome}`, price);
          this.emit('price', price);
        }
        break;
      }

      case 'last_trade_price': {
        const trade: Trade = {
          marketId: msg.market,
          outcome: msg.asset_id,
          price: parseFloat(msg.price),
          size: parseFloat(msg.size),
          side: msg.side as 'BUY' | 'SELL',
          timestamp: new Date(msg.timestamp),
        };

        this.emit('trade', trade);

        // Also emit as price update
        const existingPrice = this.priceCache.get(`${trade.marketId}:${trade.outcome}`);
        const price: LivePrice = {
          marketId: trade.marketId,
          outcome: trade.outcome,
          price: trade.price,
          bid: existingPrice?.bid ?? trade.price,
          ask: existingPrice?.ask ?? trade.price,
          spread: existingPrice?.spread ?? 0,
          timestamp: trade.timestamp,
        };

        this.priceCache.set(`${price.marketId}:${price.outcome}`, price);
        this.emit('price', price);
        break;
      }
    }
  }

  /**
   * Start WebSocket heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.state.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      return;
    }

    this.state.reconnectAttempts++;
    this.updateStatus('RECONNECTING');

    const delay = this.config.reconnectIntervalMs * Math.pow(1.5, this.state.reconnectAttempts - 1);

    logger.info({ attempt: this.state.reconnectAttempts, delayMs: delay }, 'Scheduling reconnect');

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Health check the API
   */
  private async healthCheck(): Promise<void> {
    const response = await fetch(`${this.config.apiUrl}/`);
    if (!response.ok) {
      throw new Error(`API health check failed: ${response.status}`);
    }
  }

  // ============================================
  // Subscription Management
  // ============================================

  /**
   * Subscribe to a market
   */
  subscribe(marketId: string): void {
    if (this.state.subscriptions.includes(marketId)) {
      return;
    }

    this.state.subscriptions.push(marketId);
    logger.info({ marketId }, 'Subscribed to market');

    // Start polling for this market if connected
    if (this.state.status === 'CONNECTED') {
      this.startMarketPolling(marketId);

      // Also subscribe via WebSocket if connected
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendWsSubscribe(marketId);
      }
    }
  }

  /**
   * Subscribe to multiple markets
   */
  subscribeMany(marketIds: string[]): void {
    marketIds.forEach(id => this.subscribe(id));
  }

  /**
   * Unsubscribe from a market
   */
  unsubscribe(marketId: string): void {
    const index = this.state.subscriptions.indexOf(marketId);
    if (index === -1) return;

    this.state.subscriptions.splice(index, 1);

    // Stop polling for this market
    const interval = this.pollingIntervals.get(marketId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(marketId);
    }

    // Unsubscribe via WebSocket if connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendWsUnsubscribe(marketId);
    }

    logger.info({ marketId }, 'Unsubscribed from market');
  }

  /**
   * Get all subscribed market IDs
   */
  getSubscriptions(): string[] {
    return [...this.state.subscriptions];
  }

  // ============================================
  // Polling Implementation
  // ============================================

  /**
   * Start polling for all subscribed markets
   */
  private startPolling(): void {
    for (const marketId of this.state.subscriptions) {
      this.startMarketPolling(marketId);
    }
  }

  /**
   * Start polling for a specific market
   */
  private startMarketPolling(marketId: string): void {
    if (this.pollingIntervals.has(marketId)) {
      return;
    }

    // Immediate first fetch
    this.fetchMarketData(marketId);

    // Then poll every 5 seconds
    const interval = setInterval(() => {
      this.fetchMarketData(marketId);
    }, 5000);

    this.pollingIntervals.set(marketId, interval);
  }

  /**
   * Fetch market data from API
   */
  private async fetchMarketData(marketId: string): Promise<void> {
    try {
      // Fetch market info (includes prices)
      const market = await this.fetchMarket(marketId);

      if (market) {
        this.marketCache.set(marketId, market);
        this.emit('market', market);

        // Emit price updates for each outcome from market data
        for (let i = 0; i < market.outcomes.length; i++) {
          const outcome = market.outcomes[i];
          const outPrice = market.outcomePrices[i];

          const price: LivePrice = {
            marketId,
            outcome,
            price: outPrice,
            bid: outPrice * 0.99, // Estimate bid/ask from mid price
            ask: outPrice * 1.01,
            spread: outPrice * 0.02,
            timestamp: new Date(),
          };

          this.priceCache.set(`${price.marketId}:${price.outcome}`, price);
          this.emit('price', price);
          logger.debug({ marketId, outcome, price: outPrice }, 'Price update emitted');
        }
      }

      this.state.lastMessageAt = new Date();
    } catch (error) {
      logger.error({ error, marketId }, 'Failed to fetch market data');
    }
  }

  /**
   * Fetch market information
   */
  private async fetchMarket(marketId: string): Promise<LiveMarket | null> {
    try {
      const response = await fetch(`${this.config.apiUrl}/markets/${marketId}`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as ClobMarketResponse;

      return {
        id: marketId,
        conditionId: data.condition_id,
        question: data.question,
        outcomes: data.tokens.map(t => t.outcome),
        outcomePrices: data.tokens.map(t => t.price),
        volume: data.volume,
        liquidity: data.liquidity,
        endDate: new Date(data.end_date_iso),
        isActive: data.active,
        lastUpdate: new Date(),
      };
    } catch (error) {
      logger.debug({ error, marketId }, 'Failed to fetch market');
      return null;
    }
  }

  /**
   * Fetch current prices for a market
   */
  private async fetchPrices(marketId: string): Promise<LivePrice[]> {
    try {
      const response = await fetch(`${this.config.apiUrl}/prices?market=${marketId}`);
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as ClobPriceResponse[];

      return data.map(p => ({
        marketId,
        outcome: p.token_id,
        price: p.price,
        bid: p.bid,
        ask: p.ask,
        spread: p.ask - p.bid,
        timestamp: new Date(),
      }));
    } catch (error) {
      logger.debug({ error, marketId }, 'Failed to fetch prices');
      return [];
    }
  }

  /**
   * Fetch order book for a market
   */
  async fetchOrderBook(marketId: string, outcome: string): Promise<OrderBook | null> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}/book?market=${marketId}&asset_id=${outcome}`
      );
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as ClobOrderBookResponse;

      const orderbook: OrderBook = {
        marketId,
        outcome,
        bids: data.bids.map(b => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: data.asks.map(a => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })),
        timestamp: new Date(data.timestamp),
      };

      this.emit('orderbook', orderbook);
      return orderbook;
    } catch (error) {
      logger.error({ error, marketId, outcome }, 'Failed to fetch order book');
      return null;
    }
  }

  // ============================================
  // Data Access
  // ============================================

  /**
   * Get cached market data
   */
  getMarket(marketId: string): LiveMarket | undefined {
    return this.marketCache.get(marketId);
  }

  /**
   * Get cached price data
   */
  getPrice(marketId: string, outcome: string): LivePrice | undefined {
    return this.priceCache.get(`${marketId}:${outcome}`);
  }

  /**
   * Get all cached markets
   */
  getAllMarkets(): LiveMarket[] {
    return Array.from(this.marketCache.values());
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): LivePrice[] {
    return Array.from(this.priceCache.values());
  }

  /**
   * Get current feed state
   */
  getState(): FeedState {
    return { ...this.state };
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state.status === 'CONNECTED';
  }

  // ============================================
  // Internal Helpers
  // ============================================

  /**
   * Update connection status
   */
  private updateStatus(status: FeedStatus): void {
    this.state.status = status;
    this.emit('status', status);
  }
}

/**
 * Create a live data feed with optional config
 */
export function createLiveDataFeed(config?: Partial<FeedConfig>): LiveDataFeed {
  return new LiveDataFeed(config);
}
