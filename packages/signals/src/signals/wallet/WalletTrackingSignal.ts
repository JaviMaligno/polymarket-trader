import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  WalletActivity,
} from '../../core/types/signal.types.js';

interface WalletProfile {
  address: string;
  isTracked: boolean;
  winRate?: number;
  totalVolume?: number;
  avgTradeSize?: number;
  lastActivity?: Date;
}

interface WalletTrackingParams extends Record<string, unknown> {
  /** Minimum trade size in USD to consider */
  minTradeSize: number;
  /** Time window to look back for activity (ms) */
  lookbackWindowMs: number;
  /** Minimum number of whale trades to trigger signal */
  minWhaleTrades: number;
  /** Weight for fresh wallet detection */
  freshWalletWeight: number;
  /** Weight for whale movement detection */
  whaleMovementWeight: number;
  /** Weight for smart money (high win-rate) detection */
  smartMoneyWeight: number;
  /** Threshold to consider a wallet as "fresh" (days since first seen) */
  freshWalletDays: number;
  /** Minimum win rate to consider "smart money" */
  smartMoneyWinRate: number;
}

/**
 * Wallet Tracking Signal
 *
 * Detects potential insider or smart money activity by analyzing:
 * 1. Fresh wallets making significant trades (potential insider)
 * 2. Whale movements (large traders moving in one direction)
 * 3. Smart money activity (wallets with high historical win rates)
 */
export class WalletTrackingSignal extends BaseSignal {
  readonly signalId = 'wallet_tracking';
  readonly name = 'Wallet Tracking';
  readonly description = 'Detects insider, whale, and smart money activity';

  protected parameters: WalletTrackingParams = {
    minTradeSize: 100, // $100 minimum
    lookbackWindowMs: 60 * 60 * 1000, // 1 hour
    minWhaleTrades: 3,
    freshWalletWeight: 0.4,
    whaleMovementWeight: 0.35,
    smartMoneyWeight: 0.25,
    freshWalletDays: 7,
    smartMoneyWinRate: 0.6,
  };

  // Cache for wallet profiles (in production, load from DB)
  private walletProfiles: Map<string, WalletProfile> = new Map();

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

    // Filter recent activities
    const recentActivities = activities.filter(
      a => a.time >= cutoffTime && a.size * a.price >= params.minTradeSize
    );

    if (recentActivities.length === 0) {
      return null;
    }

    // Analyze different signals
    const freshWalletScore = this.analyzeFreshWallets(recentActivities, params);
    const whaleScore = this.analyzeWhaleMovements(recentActivities, params);
    const smartMoneyScore = this.analyzeSmartMoney(recentActivities, params);

    // Combine scores with weights
    const combinedScore =
      freshWalletScore.score * params.freshWalletWeight +
      whaleScore.score * params.whaleMovementWeight +
      smartMoneyScore.score * params.smartMoneyWeight;

    // Determine direction based on net flow
    const netFlow = this.calculateNetFlow(recentActivities);
    const direction = this.getDirection(netFlow);

    // Confidence based on activity volume and consistency
    const confidence = this.calculateConfidence(
      recentActivities,
      freshWalletScore,
      whaleScore,
      smartMoneyScore
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
        netFlow,
        recentActivities.length,
      ],
      metadata: {
        freshWalletTrades: freshWalletScore.count,
        whaleTrades: whaleScore.count,
        smartMoneyTrades: smartMoneyScore.count,
        totalActivities: recentActivities.length,
        netFlowDirection: netFlow > 0 ? 'BUY' : 'SELL',
      },
    });
  }

  /**
   * Analyze activity from fresh (new) wallets
   * Fresh wallets making trades might indicate insider activity
   */
  private analyzeFreshWallets(
    activities: WalletActivity[],
    params: WalletTrackingParams
  ): { score: number; count: number } {
    let freshWalletBuys = 0;
    let freshWalletSells = 0;
    let freshWalletCount = 0;

    for (const activity of activities) {
      const profile = this.walletProfiles.get(activity.address);

      // Consider fresh if no profile or recently created
      const isFresh = !profile || this.isWalletFresh(profile, params.freshWalletDays);

      if (isFresh) {
        freshWalletCount++;
        const value = activity.size * activity.price;
        if (activity.side === 'BUY') {
          freshWalletBuys += value;
        } else {
          freshWalletSells += value;
        }
      }
    }

    const total = freshWalletBuys + freshWalletSells;
    if (total === 0) return { score: 0, count: 0 };

    // Score from -1 (all sells) to +1 (all buys)
    const score = (freshWalletBuys - freshWalletSells) / total;

    return { score, count: freshWalletCount };
  }

  /**
   * Analyze whale (large trader) movements
   */
  private analyzeWhaleMovements(
    activities: WalletActivity[],
    params: WalletTrackingParams
  ): { score: number; count: number } {
    // Sort by trade size to find whales
    const sortedBySize = [...activities].sort(
      (a, b) => b.size * b.price - a.size * a.price
    );

    // Take top 20% as "whales"
    const whaleCount = Math.max(1, Math.floor(sortedBySize.length * 0.2));
    const whaleActivities = sortedBySize.slice(0, whaleCount);

    let whaleBuys = 0;
    let whaleSells = 0;

    for (const activity of whaleActivities) {
      const value = activity.size * activity.price;
      if (activity.side === 'BUY') {
        whaleBuys += value;
      } else {
        whaleSells += value;
      }
    }

    const total = whaleBuys + whaleSells;
    if (total === 0) return { score: 0, count: 0 };

    const score = (whaleBuys - whaleSells) / total;

    return { score, count: whaleActivities.length };
  }

  /**
   * Analyze smart money (historically successful traders)
   */
  private analyzeSmartMoney(
    activities: WalletActivity[],
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

        // Weight by win rate
        const winRateMultiplier = profile.winRate;

        if (activity.side === 'BUY') {
          smartMoneyBuys += value * winRateMultiplier;
        } else {
          smartMoneySells += value * winRateMultiplier;
        }
      }
    }

    const total = smartMoneyBuys + smartMoneySells;
    if (total === 0) return { score: 0, count: 0 };

    const score = (smartMoneyBuys - smartMoneySells) / total;

    return { score, count: smartMoneyCount };
  }

  /**
   * Calculate net flow direction
   */
  private calculateNetFlow(activities: WalletActivity[]): number {
    let totalBuys = 0;
    let totalSells = 0;

    for (const activity of activities) {
      const value = activity.size * activity.price;
      if (activity.side === 'BUY') {
        totalBuys += value;
      } else {
        totalSells += value;
      }
    }

    const total = totalBuys + totalSells;
    if (total === 0) return 0;

    return (totalBuys - totalSells) / total;
  }

  /**
   * Calculate confidence based on activity patterns
   */
  private calculateConfidence(
    activities: WalletActivity[],
    freshScore: { score: number; count: number },
    whaleScore: { score: number; count: number },
    smartMoneyScore: { score: number; count: number }
  ): number {
    // Base confidence on number of activities
    const activityConfidence = Math.min(1, activities.length / 20);

    // Higher confidence if multiple signal types agree
    const scores = [freshScore.score, whaleScore.score, smartMoneyScore.score];
    const nonZeroScores = scores.filter(s => Math.abs(s) > 0.1);
    const agreement = nonZeroScores.length > 0
      ? nonZeroScores.every(s => Math.sign(s) === Math.sign(nonZeroScores[0]))
      : false;
    const agreementBonus = agreement && nonZeroScores.length >= 2 ? 0.2 : 0;

    // Higher confidence with more unique wallets
    const uniqueWallets = new Set(activities.map(a => a.address)).size;
    const walletDiversity = Math.min(1, uniqueWallets / 10);

    return Math.min(1, activityConfidence * 0.4 + walletDiversity * 0.4 + agreementBonus);
  }

  /**
   * Check if wallet is considered "fresh"
   */
  private isWalletFresh(profile: WalletProfile, daysThreshold: number): boolean {
    if (!profile.lastActivity) return true;

    const daysSinceActivity =
      (Date.now() - profile.lastActivity.getTime()) / (1000 * 60 * 60 * 24);

    return daysSinceActivity <= daysThreshold;
  }

  /**
   * Update wallet profile (call this when processing trades)
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
}
