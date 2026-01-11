import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  WalletActivity,
} from '../../core/types/signal.types.js';

/**
 * Enhanced Wallet Profile with performance metrics
 */
export interface WalletProfile {
  address: string;
  isTracked: boolean;
  winRate?: number;
  totalVolume?: number;
  avgTradeSize?: number;
  lastActivity?: Date;
  /** First activity timestamp */
  firstSeen?: Date;
  /** Total profit in USD */
  totalProfit?: number;
  /** Average return per trade */
  avgReturn?: number;
  /** Number of total trades */
  totalTrades?: number;
  /** Profit factor (gross profit / gross loss) */
  profitFactor?: number;
  /** Sharpe ratio of returns */
  sharpeRatio?: number;
  /** Known wallet cluster/group ID */
  clusterId?: string;
  /** Related wallet addresses (network) */
  relatedWallets?: string[];
  /** Category: whale, smart_money, fresh, regular */
  category?: 'whale' | 'smart_money' | 'fresh' | 'regular';
}

/**
 * Top trader for copy-trading
 */
export interface TopTrader {
  address: string;
  winRate: number;
  avgReturn: number;
  totalProfit: number;
  totalTrades: number;
  profitFactor: number;
  recentTrades: WalletActivity[];
  lastActive: Date;
  /** Rank by performance */
  rank: number;
  /** Copy-trading delay in seconds */
  recommendedDelay: number;
}

/**
 * Wallet cluster for network analysis
 */
export interface WalletCluster {
  clusterId: string;
  wallets: string[];
  /** How often these wallets trade together */
  coTradingFrequency: number;
  /** Average time between trades in cluster */
  avgTimeBetweenTrades: number;
  /** Is this cluster suspicious (coordinated trading) */
  isSuspicious: boolean;
  /** Combined win rate */
  combinedWinRate: number;
  /** Last cluster activity */
  lastActivity: Date;
}

/**
 * Configuration for enhanced Wallet Tracking Signal
 */
export interface WalletTrackingConfig extends Record<string, unknown> {
  /** Minimum trade size in USD to consider */
  minTradeSize?: number;
  /** Time window to look back for activity (ms) */
  lookbackWindowMs?: number;
  /** Minimum number of whale trades to trigger signal */
  minWhaleTrades?: number;
  /** Weight for fresh wallet detection */
  freshWalletWeight?: number;
  /** Weight for whale movement detection */
  whaleMovementWeight?: number;
  /** Weight for smart money (high win-rate) detection */
  smartMoneyWeight?: number;
  /** Weight for copy-trading signal */
  copyTradingWeight?: number;
  /** Weight for network/cluster signal */
  networkWeight?: number;
  /** Threshold to consider a wallet as "fresh" (days since first seen) */
  freshWalletDays?: number;
  /** Minimum win rate to consider "smart money" */
  smartMoneyWinRate?: number;
  /** Number of top traders to track for copy-trading */
  topTradersCount?: number;
  /** Time decay half-life for trade influence (hours) */
  timeDecayHalfLifeHours?: number;
  /** Enable network/cluster analysis */
  enableNetworkAnalysis?: boolean;
  /** Enable copy-trading signal */
  enableCopyTrading?: boolean;
  /** Minimum co-trading frequency to form cluster */
  minCoTradingFrequency?: number;
}

interface WalletTrackingParams extends Record<string, unknown> {
  minTradeSize: number;
  lookbackWindowMs: number;
  minWhaleTrades: number;
  freshWalletWeight: number;
  whaleMovementWeight: number;
  smartMoneyWeight: number;
  copyTradingWeight: number;
  networkWeight: number;
  freshWalletDays: number;
  smartMoneyWinRate: number;
  topTradersCount: number;
  timeDecayHalfLifeHours: number;
  enableNetworkAnalysis: boolean;
  enableCopyTrading: boolean;
  minCoTradingFrequency: number;
}

/** Default parameters */
export const DEFAULT_WALLET_TRACKING_PARAMS: WalletTrackingParams = {
  minTradeSize: 100,
  lookbackWindowMs: 60 * 60 * 1000, // 1 hour
  minWhaleTrades: 3,
  freshWalletWeight: 0.25,
  whaleMovementWeight: 0.25,
  smartMoneyWeight: 0.20,
  copyTradingWeight: 0.15,
  networkWeight: 0.15,
  freshWalletDays: 7,
  smartMoneyWinRate: 0.6,
  topTradersCount: 20,
  timeDecayHalfLifeHours: 6,
  enableNetworkAnalysis: true,
  enableCopyTrading: true,
  minCoTradingFrequency: 3,
};

/**
 * Enhanced Wallet Tracking Signal
 *
 * Detects potential insider or smart money activity by analyzing:
 * 1. Fresh wallets making significant trades (potential insider)
 * 2. Whale movements (large traders moving in one direction)
 * 3. Smart money activity (wallets with high historical win rates)
 * 4. Copy-trading: Following top traders' positions
 * 5. Network analysis: Detecting coordinated wallet clusters
 * 6. Time-weighted influence: Recent trades have more impact
 */
export class WalletTrackingSignal extends BaseSignal {
  readonly signalId = 'wallet_tracking';
  readonly name = 'Wallet Tracking';
  readonly description = 'Detects insider, whale, smart money, and coordinated wallet activity';

  protected parameters: WalletTrackingParams = { ...DEFAULT_WALLET_TRACKING_PARAMS };

  /** Cache for wallet profiles */
  private walletProfiles: Map<string, WalletProfile> = new Map();
  /** Top traders for copy-trading */
  private topTraders: TopTrader[] = [];
  /** Detected wallet clusters */
  private walletClusters: Map<string, WalletCluster> = new Map();
  /** Co-trading matrix (wallet pairs that trade together) */
  private coTradingMatrix: Map<string, Map<string, number>> = new Map();
  /** Recent trades by market for network analysis */
  private recentTradesByMarket: Map<string, WalletActivity[]> = new Map();
  /** Maximum entries in co-trading matrix to prevent unbounded growth */
  private readonly MAX_CO_TRADING_WALLETS = 5000;
  /** Last cleanup timestamp */
  private lastCleanupTime: number = 0;
  /** Cleanup interval in ms (every hour) */
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

  constructor(config?: WalletTrackingConfig) {
    super();
    if (config) {
      this.parameters = { ...DEFAULT_WALLET_TRACKING_PARAMS, ...config };
    }
  }

  getRequiredLookback(): number {
    return 1; // Wallet tracking doesn't need price bars, just activity
  }

  isReady(context: SignalContext): boolean {
    // Need wallet activities to compute
    return (context.walletActivities?.length || 0) > 0;
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const activities = context.walletActivities || [];

    if (activities.length === 0) {
      return null;
    }

    const params = this.parameters;
    const cutoffTime = new Date(context.currentTime.getTime() - params.lookbackWindowMs);

    // Filter recent activities with valid addresses
    // FIXED: Added address validation to prevent processing invalid data
    const recentActivities = activities.filter(
      a => a.time >= cutoffTime &&
           a.size * a.price >= params.minTradeSize &&
           this.isValidAddress(a.address)
    );

    if (recentActivities.length === 0) {
      return null;
    }

    // FIXED: Periodic cleanup to prevent memory leak
    this.maybeCleanupCoTradingMatrix(context.currentTime);

    // Update network analysis data
    if (params.enableNetworkAnalysis) {
      this.updateCoTradingMatrix(context.market.id, recentActivities);
    }

    // Analyze different signals with time decay
    const freshWalletScore = this.analyzeFreshWalletsWithDecay(recentActivities, context.currentTime, params);
    const whaleScore = this.analyzeWhaleMovementsWithDecay(recentActivities, context.currentTime, params);
    const smartMoneyScore = this.analyzeSmartMoneyWithDecay(recentActivities, context.currentTime, params);

    // New: Copy-trading score
    const copyTradingScore = params.enableCopyTrading
      ? this.analyzeCopyTradingSignal(recentActivities, context.currentTime, params)
      : { score: 0, count: 0, topTraders: [] };

    // New: Network/cluster score
    const networkScore = params.enableNetworkAnalysis
      ? this.analyzeNetworkActivity(recentActivities, context.market.id, params)
      : { score: 0, count: 0, suspiciousClusters: 0 };

    // Combine scores with weights
    const combinedScore =
      freshWalletScore.score * params.freshWalletWeight +
      whaleScore.score * params.whaleMovementWeight +
      smartMoneyScore.score * params.smartMoneyWeight +
      copyTradingScore.score * params.copyTradingWeight +
      networkScore.score * params.networkWeight;

    // Determine direction based on net flow with time decay
    const netFlow = this.calculateNetFlowWithDecay(recentActivities, context.currentTime, params);
    const direction = this.getDirection(netFlow);

    // Enhanced confidence calculation
    const confidence = this.calculateEnhancedConfidence(
      recentActivities,
      freshWalletScore,
      whaleScore,
      smartMoneyScore,
      copyTradingScore,
      networkScore
    );

    // Only emit signal if we have meaningful activity
    if (Math.abs(combinedScore) < 0.1 || confidence < 0.2) {
      return null;
    }

    // Adjust strength based on direction
    const strength = combinedScore * Math.sign(netFlow);

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        freshWalletScore.score,
        whaleScore.score,
        smartMoneyScore.score,
        copyTradingScore.score,
        networkScore.score,
        netFlow,
        recentActivities.length,
      ],
      metadata: {
        freshWalletTrades: freshWalletScore.count,
        whaleTrades: whaleScore.count,
        smartMoneyTrades: smartMoneyScore.count,
        copyTradingTrades: copyTradingScore.count,
        networkTrades: networkScore.count,
        suspiciousClusters: networkScore.suspiciousClusters,
        topTradersActive: copyTradingScore.topTraders,
        totalActivities: recentActivities.length,
        netFlowDirection: netFlow > 0 ? 'BUY' : 'SELL',
        timeDecayApplied: true,
      },
    });
  }

  // ==================== Time-Decay Enhanced Analysis ====================

  /**
   * Calculate time decay weight for a trade
   */
  private calculateTimeDecay(tradeTime: Date, currentTime: Date, halfLifeHours: number): number {
    const ageMs = currentTime.getTime() - tradeTime.getTime();
    const halfLifeMs = halfLifeHours * 60 * 60 * 1000;
    return Math.pow(0.5, ageMs / halfLifeMs);
  }

  /**
   * Analyze fresh wallets with time decay weighting
   */
  private analyzeFreshWalletsWithDecay(
    activities: WalletActivity[],
    currentTime: Date,
    params: WalletTrackingParams
  ): { score: number; count: number } {
    let freshWalletBuys = 0;
    let freshWalletSells = 0;
    let freshWalletCount = 0;

    for (const activity of activities) {
      const profile = this.walletProfiles.get(activity.address);
      const isFresh = !profile || this.isWalletFresh(profile, params.freshWalletDays);

      if (isFresh) {
        freshWalletCount++;
        const value = activity.size * activity.price;
        const decay = this.calculateTimeDecay(activity.time, currentTime, params.timeDecayHalfLifeHours);

        if (activity.side === 'BUY') {
          freshWalletBuys += value * decay;
        } else {
          freshWalletSells += value * decay;
        }
      }
    }

    const total = freshWalletBuys + freshWalletSells;
    if (total === 0) return { score: 0, count: 0 };

    return { score: (freshWalletBuys - freshWalletSells) / total, count: freshWalletCount };
  }

  /**
   * Analyze whale movements with time decay weighting
   */
  private analyzeWhaleMovementsWithDecay(
    activities: WalletActivity[],
    currentTime: Date,
    params: WalletTrackingParams
  ): { score: number; count: number } {
    const sortedBySize = [...activities].sort(
      (a, b) => b.size * b.price - a.size * a.price
    );

    const whaleCount = Math.max(1, Math.floor(sortedBySize.length * 0.2));
    const whaleActivities = sortedBySize.slice(0, whaleCount);

    let whaleBuys = 0;
    let whaleSells = 0;

    for (const activity of whaleActivities) {
      const value = activity.size * activity.price;
      const decay = this.calculateTimeDecay(activity.time, currentTime, params.timeDecayHalfLifeHours);

      if (activity.side === 'BUY') {
        whaleBuys += value * decay;
      } else {
        whaleSells += value * decay;
      }
    }

    const total = whaleBuys + whaleSells;
    if (total === 0) return { score: 0, count: 0 };

    return { score: (whaleBuys - whaleSells) / total, count: whaleActivities.length };
  }

  /**
   * Analyze smart money with time decay weighting
   */
  private analyzeSmartMoneyWithDecay(
    activities: WalletActivity[],
    currentTime: Date,
    params: WalletTrackingParams
  ): { score: number; count: number } {
    let smartMoneyBuys = 0;
    let smartMoneySells = 0;
    let smartMoneyCount = 0;

    for (const activity of activities) {
      const profile = this.walletProfiles.get(activity.address);

      if (profile?.winRate && profile.winRate >= params.smartMoneyWinRate) {
        smartMoneyCount++;
        const value = activity.size * activity.price;
        const decay = this.calculateTimeDecay(activity.time, currentTime, params.timeDecayHalfLifeHours);
        const winRateMultiplier = profile.winRate;

        if (activity.side === 'BUY') {
          smartMoneyBuys += value * winRateMultiplier * decay;
        } else {
          smartMoneySells += value * winRateMultiplier * decay;
        }
      }
    }

    const total = smartMoneyBuys + smartMoneySells;
    if (total === 0) return { score: 0, count: 0 };

    return { score: (smartMoneyBuys - smartMoneySells) / total, count: smartMoneyCount };
  }

  /**
   * Calculate net flow with time decay
   */
  private calculateNetFlowWithDecay(
    activities: WalletActivity[],
    currentTime: Date,
    params: WalletTrackingParams
  ): number {
    let totalBuys = 0;
    let totalSells = 0;

    for (const activity of activities) {
      const value = activity.size * activity.price;
      const decay = this.calculateTimeDecay(activity.time, currentTime, params.timeDecayHalfLifeHours);

      if (activity.side === 'BUY') {
        totalBuys += value * decay;
      } else {
        totalSells += value * decay;
      }
    }

    const total = totalBuys + totalSells;
    if (total === 0) return 0;

    return (totalBuys - totalSells) / total;
  }

  // ==================== Copy-Trading Analysis ====================

  /**
   * Analyze copy-trading signals from top traders
   */
  private analyzeCopyTradingSignal(
    activities: WalletActivity[],
    currentTime: Date,
    params: WalletTrackingParams
  ): { score: number; count: number; topTraders: string[] } {
    if (this.topTraders.length === 0) {
      return { score: 0, count: 0, topTraders: [] };
    }

    const topTraderAddresses = new Set(this.topTraders.map(t => t.address));
    let topTraderBuys = 0;
    let topTraderSells = 0;
    let topTraderCount = 0;
    const activeTopTraders: string[] = [];

    for (const activity of activities) {
      if (topTraderAddresses.has(activity.address)) {
        topTraderCount++;
        const value = activity.size * activity.price;
        const decay = this.calculateTimeDecay(activity.time, currentTime, params.timeDecayHalfLifeHours);

        // Find trader's rank and weight by performance
        const trader = this.topTraders.find(t => t.address === activity.address);
        const rankWeight = trader ? (params.topTradersCount - trader.rank + 1) / params.topTradersCount : 0.5;
        const performanceWeight = trader ? trader.winRate : 0.5;

        const weight = decay * rankWeight * performanceWeight;

        if (activity.side === 'BUY') {
          topTraderBuys += value * weight;
        } else {
          topTraderSells += value * weight;
        }

        if (!activeTopTraders.includes(activity.address)) {
          activeTopTraders.push(activity.address);
        }
      }
    }

    const total = topTraderBuys + topTraderSells;
    if (total === 0) return { score: 0, count: 0, topTraders: [] };

    return {
      score: (topTraderBuys - topTraderSells) / total,
      count: topTraderCount,
      topTraders: activeTopTraders,
    };
  }

  // ==================== Network Analysis ====================

  /**
   * Update co-trading matrix for network analysis
   */
  private updateCoTradingMatrix(marketId: string, activities: WalletActivity[]): void {
    // Store recent trades by market
    const existing = this.recentTradesByMarket.get(marketId) || [];
    const combined = [...existing, ...activities].slice(-500); // Keep last 500 trades
    this.recentTradesByMarket.set(marketId, combined);

    // Group activities by time window (5 minute windows)
    const timeWindowMs = 5 * 60 * 1000;
    const windows: Map<number, string[]> = new Map();

    for (const activity of combined) {
      const windowKey = Math.floor(activity.time.getTime() / timeWindowMs);
      const wallets = windows.get(windowKey) || [];
      if (!wallets.includes(activity.address)) {
        wallets.push(activity.address);
      }
      windows.set(windowKey, wallets);
    }

    // Update co-trading counts
    for (const wallets of windows.values()) {
      if (wallets.length >= 2) {
        for (let i = 0; i < wallets.length; i++) {
          for (let j = i + 1; j < wallets.length; j++) {
            const wallet1 = wallets[i];
            const wallet2 = wallets[j];

            if (!this.coTradingMatrix.has(wallet1)) {
              this.coTradingMatrix.set(wallet1, new Map());
            }
            if (!this.coTradingMatrix.has(wallet2)) {
              this.coTradingMatrix.set(wallet2, new Map());
            }

            const count1 = this.coTradingMatrix.get(wallet1)!.get(wallet2) || 0;
            const count2 = this.coTradingMatrix.get(wallet2)!.get(wallet1) || 0;

            this.coTradingMatrix.get(wallet1)!.set(wallet2, count1 + 1);
            this.coTradingMatrix.get(wallet2)!.set(wallet1, count2 + 1);
          }
        }
      }
    }

    // Detect clusters from co-trading matrix
    this.detectClusters();
  }

  /**
   * Detect wallet clusters using co-trading patterns
   */
  private detectClusters(): void {
    const params = this.parameters;
    const visited = new Set<string>();
    const newClusters: WalletCluster[] = [];

    for (const [wallet, coTraders] of this.coTradingMatrix) {
      if (visited.has(wallet)) continue;

      // Find wallets that frequently trade together
      const clusterWallets: string[] = [wallet];
      visited.add(wallet);

      for (const [coWallet, frequency] of coTraders) {
        if (frequency >= params.minCoTradingFrequency && !visited.has(coWallet)) {
          clusterWallets.push(coWallet);
          visited.add(coWallet);
        }
      }

      // Only form cluster if multiple wallets
      if (clusterWallets.length >= 2) {
        const cluster: WalletCluster = {
          clusterId: `cluster_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          wallets: clusterWallets,
          coTradingFrequency: this.getAvgCoTradingFrequency(clusterWallets),
          avgTimeBetweenTrades: 0, // Would need more data to calculate
          isSuspicious: clusterWallets.length >= 3 && this.getAvgCoTradingFrequency(clusterWallets) >= 5,
          combinedWinRate: this.getCombinedWinRate(clusterWallets),
          lastActivity: new Date(),
        };

        newClusters.push(cluster);
        this.walletClusters.set(cluster.clusterId, cluster);
      }
    }
  }

  /**
   * Get average co-trading frequency for a set of wallets
   */
  private getAvgCoTradingFrequency(wallets: string[]): number {
    let totalFreq = 0;
    let pairs = 0;

    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        const freq = this.coTradingMatrix.get(wallets[i])?.get(wallets[j]) || 0;
        totalFreq += freq;
        pairs++;
      }
    }

    return pairs > 0 ? totalFreq / pairs : 0;
  }

  /**
   * Get combined win rate for cluster
   */
  private getCombinedWinRate(wallets: string[]): number {
    let totalWinRate = 0;
    let count = 0;

    for (const wallet of wallets) {
      const profile = this.walletProfiles.get(wallet);
      if (profile?.winRate) {
        totalWinRate += profile.winRate;
        count++;
      }
    }

    return count > 0 ? totalWinRate / count : 0.5;
  }

  /**
   * Analyze network activity for coordinated trading
   */
  private analyzeNetworkActivity(
    activities: WalletActivity[],
    marketId: string,
    params: WalletTrackingParams
  ): { score: number; count: number; suspiciousClusters: number } {
    // Find which activities are from cluster members
    const clusterActivities: WalletActivity[] = [];
    let suspiciousCount = 0;

    for (const cluster of this.walletClusters.values()) {
      const clusterSet = new Set(cluster.wallets);
      const clusterTrades = activities.filter(a => clusterSet.has(a.address));

      if (clusterTrades.length > 0) {
        clusterActivities.push(...clusterTrades);
        if (cluster.isSuspicious) {
          suspiciousCount++;
        }
      }
    }

    if (clusterActivities.length === 0) {
      return { score: 0, count: 0, suspiciousClusters: 0 };
    }

    // Calculate cluster signal
    let clusterBuys = 0;
    let clusterSells = 0;

    for (const activity of clusterActivities) {
      const value = activity.size * activity.price;
      if (activity.side === 'BUY') {
        clusterBuys += value;
      } else {
        clusterSells += value;
      }
    }

    const total = clusterBuys + clusterSells;
    if (total === 0) return { score: 0, count: 0, suspiciousClusters: 0 };

    return {
      score: (clusterBuys - clusterSells) / total,
      count: clusterActivities.length,
      suspiciousClusters: suspiciousCount,
    };
  }

  // ==================== Enhanced Confidence ====================

  /**
   * Calculate enhanced confidence with all signal types
   */
  private calculateEnhancedConfidence(
    activities: WalletActivity[],
    freshScore: { score: number; count: number },
    whaleScore: { score: number; count: number },
    smartMoneyScore: { score: number; count: number },
    copyTradingScore: { score: number; count: number; topTraders: string[] },
    networkScore: { score: number; count: number; suspiciousClusters: number }
  ): number {
    // Base confidence on number of activities
    const activityConfidence = Math.min(1, activities.length / 20);

    // Higher confidence if multiple signal types agree
    const scores = [
      freshScore.score,
      whaleScore.score,
      smartMoneyScore.score,
      copyTradingScore.score,
      networkScore.score,
    ];
    const nonZeroScores = scores.filter(s => Math.abs(s) > 0.1);
    const dominantSign = nonZeroScores.length > 0
      ? Math.sign(nonZeroScores.reduce((a, b) => a + b, 0))
      : 0;
    const agreement = nonZeroScores.length > 0
      ? nonZeroScores.filter(s => Math.sign(s) === dominantSign).length / nonZeroScores.length
      : 0;
    const agreementBonus = agreement > 0.6 ? 0.15 * agreement : 0;

    // Higher confidence with more unique wallets
    const uniqueWallets = new Set(activities.map(a => a.address)).size;
    const walletDiversity = Math.min(1, uniqueWallets / 10);

    // Bonus for top trader activity
    const topTraderBonus = copyTradingScore.topTraders.length > 0 ? 0.1 : 0;

    // Bonus for cluster/network signals
    const networkBonus = networkScore.count > 0 ? 0.05 : 0;

    // Penalty for suspicious clusters (could be manipulation)
    const suspiciousPenalty = networkScore.suspiciousClusters > 1 ? -0.1 : 0;

    return Math.min(
      1,
      Math.max(
        0,
        activityConfidence * 0.3 +
          walletDiversity * 0.25 +
          agreementBonus +
          topTraderBonus +
          networkBonus +
          suspiciousPenalty
      )
    );
  }

  // ==================== Utility Methods ====================

  /**
   * Validate wallet address format
   * FIXED: Added to prevent processing invalid addresses
   */
  private isValidAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    // Ethereum-style address validation (0x + 40 hex chars)
    // Also accept Polygon addresses which follow the same format
    const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;
    return ethAddressRegex.test(address);
  }

  /**
   * Periodic cleanup of co-trading matrix to prevent memory leak
   * FIXED: Added to prevent unbounded memory growth
   */
  private maybeCleanupCoTradingMatrix(currentTime: Date): void {
    const now = currentTime.getTime();
    if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL_MS) return;

    this.lastCleanupTime = now;

    // If under limit, no cleanup needed
    if (this.coTradingMatrix.size <= this.MAX_CO_TRADING_WALLETS) return;

    // Remove wallets with lowest co-trading activity
    const walletActivity: Array<{ wallet: string; totalActivity: number }> = [];

    for (const [wallet, coTraders] of this.coTradingMatrix) {
      let total = 0;
      for (const count of coTraders.values()) {
        total += count;
      }
      walletActivity.push({ wallet, totalActivity: total });
    }

    // Sort by activity (ascending) and remove bottom 20%
    walletActivity.sort((a, b) => a.totalActivity - b.totalActivity);
    const toRemove = Math.floor(walletActivity.length * 0.2);

    for (let i = 0; i < toRemove; i++) {
      const wallet = walletActivity[i].wallet;
      // Remove from matrix
      this.coTradingMatrix.delete(wallet);
      // Also remove references from other wallets
      for (const coTraders of this.coTradingMatrix.values()) {
        coTraders.delete(wallet);
      }
    }

    this.logger.debug({ removed: toRemove, remaining: this.coTradingMatrix.size }, 'Cleaned up co-trading matrix');
  }

  /**
   * Check if wallet is considered "fresh"
   */
  private isWalletFresh(profile: WalletProfile, daysThreshold: number): boolean {
    if (!profile.firstSeen) return true;

    const daysSinceFirst =
      (Date.now() - profile.firstSeen.getTime()) / (1000 * 60 * 60 * 24);

    return daysSinceFirst <= daysThreshold;
  }

  // ==================== Data Management ====================

  /**
   * Update wallet profile
   */
  updateWalletProfile(profile: WalletProfile): void {
    this.walletProfiles.set(profile.address, profile);
  }

  /**
   * Load wallet profiles from database
   */
  loadWalletProfiles(profiles: WalletProfile[]): void {
    for (const profile of profiles) {
      this.walletProfiles.set(profile.address, profile);
    }
    this.logger.info({ count: profiles.length }, 'Loaded wallet profiles');
  }

  /**
   * Update top traders list for copy-trading
   */
  updateTopTraders(traders: TopTrader[]): void {
    this.topTraders = traders.sort((a, b) => b.totalProfit - a.totalProfit);

    // Assign ranks
    this.topTraders.forEach((t, idx) => {
      t.rank = idx + 1;
    });

    this.logger.info({ count: traders.length }, 'Updated top traders list');
  }

  /**
   * Get top traders for external use
   */
  getTopTraders(): TopTrader[] {
    return [...this.topTraders];
  }

  /**
   * Get wallet clusters for external use
   */
  getWalletClusters(): WalletCluster[] {
    return Array.from(this.walletClusters.values());
  }

  /**
   * Get suspicious clusters
   */
  getSuspiciousClusters(): WalletCluster[] {
    return this.getWalletClusters().filter(c => c.isSuspicious);
  }

  /**
   * Clear network analysis data
   */
  clearNetworkData(): void {
    this.coTradingMatrix.clear();
    this.walletClusters.clear();
    this.recentTradesByMarket.clear();
  }
}
