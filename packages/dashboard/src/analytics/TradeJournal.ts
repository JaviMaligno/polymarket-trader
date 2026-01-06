/**
 * Trade Journal
 *
 * Records and manages detailed trade history with notes and analysis.
 */

import type {
  TradeEntry,
  JournalFilter,
  JournalStats,
  TradeSummary,
} from '../types/index.js';

export class TradeJournal {
  private entries: Map<string, TradeEntry> = new Map();
  private listeners: Array<(entry: TradeEntry) => void> = [];

  /**
   * Record a new trade entry
   */
  recordTrade(entry: Omit<TradeEntry, 'id'>): TradeEntry {
    const id = this.generateId();
    const fullEntry: TradeEntry = { id, ...entry };

    this.entries.set(id, fullEntry);
    this.notifyListeners(fullEntry);

    return fullEntry;
  }

  /**
   * Update an existing trade (e.g., when closed)
   */
  updateTrade(id: string, updates: Partial<TradeEntry>): TradeEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    const updated = { ...entry, ...updates };
    this.entries.set(id, updated);
    this.notifyListeners(updated);

    return updated;
  }

  /**
   * Close a trade with exit details
   */
  closeTrade(
    id: string,
    exitPrice: number,
    exitFees: number,
    exitTimestamp: Date = new Date()
  ): TradeEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    // Calculate P&L
    const entryValue = entry.size * entry.price;
    const exitValue = entry.size * exitPrice;
    const fees = entry.fees + exitFees;

    let realizedPnl: number;
    if (entry.side === 'BUY') {
      realizedPnl = exitValue - entryValue - fees;
    } else {
      realizedPnl = entryValue - exitValue - fees;
    }

    // Calculate holding period in hours
    const holdingPeriod = (exitTimestamp.getTime() - entry.timestamp.getTime()) / (1000 * 60 * 60);

    return this.updateTrade(id, {
      exitTimestamp,
      exitPrice,
      exitFees,
      realizedPnl,
      holdingPeriod,
    });
  }

  /**
   * Add notes to a trade
   */
  addNotes(id: string, notes: string): TradeEntry | null {
    return this.updateTrade(id, { notes });
  }

  /**
   * Add tags to a trade
   */
  addTags(id: string, tags: string[]): TradeEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    const existingTags = entry.tags ?? [];
    const newTags = [...new Set([...existingTags, ...tags])];

    return this.updateTrade(id, { tags: newTags });
  }

  /**
   * Get a single trade entry
   */
  getTrade(id: string): TradeEntry | null {
    return this.entries.get(id) ?? null;
  }

  /**
   * Get all entries with optional filtering
   */
  getEntries(filter?: JournalFilter): TradeEntry[] {
    let entries = Array.from(this.entries.values());

    if (filter) {
      entries = this.applyFilter(entries, filter);
    }

    // Sort by timestamp descending (most recent first)
    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get open positions (trades without exit)
   */
  getOpenPositions(): TradeEntry[] {
    return Array.from(this.entries.values())
      .filter(e => !e.exitTimestamp)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get closed trades
   */
  getClosedTrades(): TradeEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.exitTimestamp)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Get journal statistics
   */
  getStats(filter?: JournalFilter): JournalStats {
    const entries = filter ? this.applyFilter(Array.from(this.entries.values()), filter) : Array.from(this.entries.values());

    const openPositions = entries.filter(e => !e.exitTimestamp);
    const closedTrades = entries.filter(e => e.exitTimestamp);

    const wins = closedTrades.filter(e => (e.realizedPnl ?? 0) > 0);
    const losses = closedTrades.filter(e => (e.realizedPnl ?? 0) < 0);

    const totalPnl = closedTrades.reduce((sum, e) => sum + (e.realizedPnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;

    const avgWin = wins.length > 0
      ? wins.reduce((sum, e) => sum + (e.realizedPnl ?? 0), 0) / wins.length
      : 0;

    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((sum, e) => sum + (e.realizedPnl ?? 0), 0)) / losses.length
      : 0;

    // Find best and worst trades
    let bestTrade: TradeSummary | null = null;
    let worstTrade: TradeSummary | null = null;

    if (closedTrades.length > 0) {
      const sorted = [...closedTrades].sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0));

      const best = sorted[0];
      const worst = sorted[sorted.length - 1];

      bestTrade = this.entryToSummary(best);
      worstTrade = this.entryToSummary(worst);
    }

    return {
      totalEntries: entries.length,
      openPositions: openPositions.length,
      closedTrades: closedTrades.length,
      totalPnl,
      winRate,
      avgWin,
      avgLoss,
      bestTrade,
      worstTrade,
    };
  }

  /**
   * Get trades by strategy
   */
  getTradesByStrategy(strategyId: string): TradeEntry[] {
    return this.getEntries({ strategyId });
  }

  /**
   * Get trades by market
   */
  getTradesByMarket(marketId: string): TradeEntry[] {
    return this.getEntries({ marketId });
  }

  /**
   * Get trades for a date range
   */
  getTradesInRange(startDate: Date, endDate: Date): TradeEntry[] {
    return this.getEntries({ startDate, endDate });
  }

  /**
   * Get winning trades
   */
  getWinningTrades(): TradeEntry[] {
    return this.getClosedTrades().filter(e => (e.realizedPnl ?? 0) > 0);
  }

  /**
   * Get losing trades
   */
  getLosingTrades(): TradeEntry[] {
    return this.getClosedTrades().filter(e => (e.realizedPnl ?? 0) < 0);
  }

  /**
   * Export journal to JSON
   */
  export(): string {
    const entries = this.getEntries();
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Import journal from JSON
   */
  import(json: string): number {
    const entries: TradeEntry[] = JSON.parse(json);
    let count = 0;

    for (const entry of entries) {
      // Convert date strings back to Date objects
      const parsed: TradeEntry = {
        ...entry,
        timestamp: new Date(entry.timestamp),
        exitTimestamp: entry.exitTimestamp ? new Date(entry.exitTimestamp) : undefined,
      };

      this.entries.set(parsed.id, parsed);
      count++;
    }

    return count;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Subscribe to new trade entries
   */
  subscribe(listener: (entry: TradeEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Apply filters to entries
   */
  private applyFilter(entries: TradeEntry[], filter: JournalFilter): TradeEntry[] {
    return entries.filter(entry => {
      if (filter.startDate && entry.timestamp < filter.startDate) {
        return false;
      }

      if (filter.endDate && entry.timestamp > filter.endDate) {
        return false;
      }

      if (filter.strategyId && entry.strategyId !== filter.strategyId) {
        return false;
      }

      if (filter.marketId && entry.marketId !== filter.marketId) {
        return false;
      }

      if (filter.side && entry.side !== filter.side) {
        return false;
      }

      if (filter.minPnl !== undefined && (entry.realizedPnl ?? -Infinity) < filter.minPnl) {
        return false;
      }

      if (filter.maxPnl !== undefined && (entry.realizedPnl ?? Infinity) > filter.maxPnl) {
        return false;
      }

      if (filter.tags && filter.tags.length > 0) {
        const entryTags = entry.tags ?? [];
        if (!filter.tags.some(tag => entryTags.includes(tag))) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Convert entry to summary
   */
  private entryToSummary(entry: TradeEntry): TradeSummary {
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      marketId: entry.marketId,
      marketQuestion: entry.marketQuestion,
      outcome: entry.outcome,
      side: entry.side,
      size: entry.size,
      price: entry.price,
      fees: entry.fees,
      pnl: entry.realizedPnl,
      strategyId: entry.strategyId,
    };
  }

  /**
   * Notify listeners of changes
   */
  private notifyListeners(entry: TradeEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        console.error('Trade journal listener error:', error);
      }
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `trade_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export function createTradeJournal(): TradeJournal {
  return new TradeJournal();
}
