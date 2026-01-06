// Polymarket API Types

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  category: string;
  tags: string[];
  markets: PolymarketMarket[];
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  createdAt: string;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  liquidity: string;
  startDate: string;
  volume: string;
  volume24hr: number;
  volumeNum: number;
  liquidityNum: number;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
  competitive: number;
  volume24hrClob: number;
  liquidityClob: number;
  spread: number;
  oneDayPriceChange: number;
  lastTradePrice: number;
  bestBid: number;
  bestAsk: number;
}

export interface PriceHistory {
  t: number;  // timestamp
  p: string;  // price
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface Trade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side: string;
}

// Database Types

export interface DbMarket {
  id: string;
  event_id: string | null;
  clob_token_id_yes: string;
  clob_token_id_no: string | null;
  condition_id: string;
  question: string;
  description: string | null;
  category: string | null;
  end_date: Date | null;
  current_price_yes: number | null;
  current_price_no: number | null;
  spread: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  is_active: boolean;
  is_resolved: boolean;
  resolution_outcome: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DbPriceHistory {
  time: Date;
  market_id: string;
  token_id: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  vwap: number | null;
  trade_count: number | null;
  source: 'api' | 'onchain' | 'derived';
}

export interface DbTrade {
  time: Date;
  market_id: string;
  token_id: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  value_usd: number | null;
  fee: number | null;
  maker_address: string | null;
  taker_address: string | null;
  tx_hash: string | null;
  block_number: number | null;
  source: 'api' | 'onchain';
}

export interface DbWallet {
  address: string;
  label: string | null;
  is_tracked: boolean;
  first_seen: Date;
  last_activity: Date | null;
  total_trades: number;
  total_volume_usd: number;
  total_pnl_usd: number | null;
  win_rate: number | null;
  tags: string[];
}

// Rate Limiter Types

export interface RateLimitConfig {
  endpoint: string;
  requestsPerWindow: number;
  windowMs: number;
}

export interface RateLimitState {
  tokens: number;
  lastRefill: number;
}

// Collector Types

export interface CollectorConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface CollectionJob {
  id: number;
  jobType: string;
  targetId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: Date | null;
  completedAt: Date | null;
  lastFetchedAt: Date | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}
