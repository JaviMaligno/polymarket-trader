import { query } from '../database/index.js';

export interface SimulationConfig {
  maxSnapshotAgeMs: number;
  estimatedSlippageFloor: number;
  estimatedBaseRate: number;
  estimatedVolumeFactor: number;
  feeRate: number;
  maxSlippagePct: number;
  minFillRatio: number;
}

export interface SimulationResult {
  executed: boolean;
  executedPrice: number;
  executedSize: number;
  slippagePct: number;
  fee: number;
  fillSource: 'orderbook' | 'estimated';
  snapshotAgeMs: number | null;
  availableDepth: number;
  bestBid: number | null;
  bestAsk: number | null;
  rejectReason?: string;
}

const DEFAULT_CONFIG: SimulationConfig = {
  maxSnapshotAgeMs: 60_000,
  estimatedSlippageFloor: 0.01,
  estimatedBaseRate: 0.002,
  estimatedVolumeFactor: 0.10,
  feeRate: 0.001,
  maxSlippagePct: 0.05,
  minFillRatio: 0.10,
};

export class OrderBookExecutionSimulator {
  private config: SimulationConfig;

  constructor(config?: Partial<SimulationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async simulateBuy(
    marketId: string, tokenId: string, size: number, signalPrice: number
  ): Promise<SimulationResult> {
    return this.simulate(marketId, tokenId, size, signalPrice, 'buy');
  }

  async simulateSell(
    marketId: string, tokenId: string, size: number, signalPrice: number
  ): Promise<SimulationResult> {
    return this.simulate(marketId, tokenId, size, signalPrice, 'sell');
  }

  private async simulate(
    marketId: string, tokenId: string, size: number, signalPrice: number, side: 'buy' | 'sell'
  ): Promise<SimulationResult> {
    const snapshot = await this.getLatestSnapshot(marketId, tokenId);

    if (snapshot && snapshot.snapshotAgeMs <= this.config.maxSnapshotAgeMs) {
      return this.executeWithOrderBook(snapshot, size, signalPrice, side);
    }

    return this.executeWithEstimate(marketId, size, signalPrice, side);
  }

  private async getLatestSnapshot(marketId: string, tokenId: string) {
    const result = await query<{
      best_bid: string; best_ask: string; spread: string;
      asks: string; bids: string;
      ask_depth_10pct: string; bid_depth_10pct: string;
      snapshot_age_ms: string;
    }>(
      `SELECT best_bid, best_ask, spread,
              asks::text, bids::text,
              ask_depth_10pct, bid_depth_10pct,
              EXTRACT(EPOCH FROM (NOW() - time)) * 1000 AS snapshot_age_ms
       FROM orderbook_snapshots
       WHERE market_id = $1 AND token_id = $2
       ORDER BY time DESC LIMIT 1`,
      [marketId, tokenId]
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      bestBid: parseFloat(row.best_bid) || null,
      bestAsk: parseFloat(row.best_ask) || null,
      asks: JSON.parse(row.asks || '[]') as { price: string; size: string }[],
      bids: JSON.parse(row.bids || '[]') as { price: string; size: string }[],
      askDepth: parseFloat(row.ask_depth_10pct) || 0,
      bidDepth: parseFloat(row.bid_depth_10pct) || 0,
      snapshotAgeMs: Math.round(parseFloat(row.snapshot_age_ms)),
    };
  }

  private executeWithOrderBook(
    snapshot: NonNullable<Awaited<ReturnType<typeof this.getLatestSnapshot>>>,
    size: number, _signalPrice: number, side: 'buy' | 'sell'
  ): SimulationResult {
    const levels = side === 'buy' ? snapshot.asks : snapshot.bids;
    const bestPrice = side === 'buy' ? snapshot.bestAsk : snapshot.bestBid;
    const availableDepth = side === 'buy' ? snapshot.askDepth : snapshot.bidDepth;

    if (!bestPrice || levels.length === 0) {
      return {
        executed: false, executedPrice: 0, executedSize: 0,
        slippagePct: 0, fee: 0, fillSource: 'orderbook',
        snapshotAgeMs: snapshot.snapshotAgeMs, availableDepth: 0,
        bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk,
        rejectReason: 'no orderbook levels available',
      };
    }

    // Walk the book
    let filled = 0;
    let totalCost = 0;
    for (const level of levels) {
      const levelPrice = parseFloat(level.price);
      const levelSize = parseFloat(level.size);
      const remaining = size - filled;
      if (remaining <= 0) break;
      const fillAtLevel = Math.min(remaining, levelSize);
      totalCost += fillAtLevel * levelPrice;
      filled += fillAtLevel;
    }

    // Check minimum fill ratio
    if (filled < size * this.config.minFillRatio) {
      return {
        executed: false, executedPrice: 0, executedSize: filled,
        slippagePct: 0, fee: 0, fillSource: 'orderbook',
        snapshotAgeMs: snapshot.snapshotAgeMs, availableDepth,
        bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk,
        rejectReason: `insufficient liquidity: ${filled}/${size} shares (${Math.round(filled / size * 100)}%)`,
      };
    }

    const avgPrice = totalCost / filled;
    const slippagePct = Math.abs(avgPrice - bestPrice) / bestPrice * 100;

    // Check max slippage
    if (slippagePct / 100 > this.config.maxSlippagePct) {
      return {
        executed: false, executedPrice: avgPrice, executedSize: filled,
        slippagePct, fee: 0, fillSource: 'orderbook',
        snapshotAgeMs: snapshot.snapshotAgeMs, availableDepth,
        bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk,
        rejectReason: `slippage ${slippagePct.toFixed(2)}% exceeds max ${this.config.maxSlippagePct * 100}%`,
      };
    }

    const fee = filled * avgPrice * this.config.feeRate;

    return {
      executed: true, executedPrice: avgPrice, executedSize: filled,
      slippagePct, fee, fillSource: 'orderbook',
      snapshotAgeMs: snapshot.snapshotAgeMs, availableDepth,
      bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk,
    };
  }

  private async executeWithEstimate(
    marketId: string, size: number, signalPrice: number, side: 'buy' | 'sell'
  ): Promise<SimulationResult> {
    const volResult = await query<{ volume_24h: string }>(
      `SELECT volume_24h FROM markets WHERE id = $1`,
      [marketId]
    );

    if (volResult.rows.length === 0 || !volResult.rows[0].volume_24h) {
      return {
        executed: false, executedPrice: 0, executedSize: 0,
        slippagePct: 0, fee: 0, fillSource: 'estimated',
        snapshotAgeMs: null, availableDepth: 0,
        bestBid: null, bestAsk: null,
        rejectReason: 'no market data available (no snapshot, no volume)',
      };
    }

    const volume24h = parseFloat(volResult.rows[0].volume_24h);
    const orderValue = size * signalPrice;
    const volumeRatio = volume24h > 0 ? orderValue / volume24h : 1;

    const slippage = Math.max(
      this.config.estimatedSlippageFloor,
      this.config.estimatedBaseRate + volumeRatio * this.config.estimatedVolumeFactor
    );

    if (slippage > this.config.maxSlippagePct) {
      return {
        executed: false, executedPrice: 0, executedSize: 0,
        slippagePct: slippage * 100, fee: 0, fillSource: 'estimated',
        snapshotAgeMs: null, availableDepth: 0,
        bestBid: null, bestAsk: null,
        rejectReason: `estimated slippage ${(slippage * 100).toFixed(2)}% exceeds max ${this.config.maxSlippagePct * 100}%`,
      };
    }

    const executedPrice = side === 'buy'
      ? signalPrice * (1 + slippage)
      : signalPrice * (1 - slippage);

    const fee = size * executedPrice * this.config.feeRate;

    return {
      executed: true, executedPrice, executedSize: size,
      slippagePct: slippage * 100, fee, fillSource: 'estimated',
      snapshotAgeMs: null, availableDepth: 0,
      bestBid: null, bestAsk: null,
    };
  }

  updateConfig(partial: Partial<SimulationConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
