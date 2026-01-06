import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  MarketInfo,
} from '../../core/types/signal.types.js';

interface ArbitrageParams extends Record<string, unknown> {
  /** Minimum correlation to consider markets related */
  minCorrelation: number;
  /** Minimum price divergence to signal (%) */
  minDivergencePct: number;
  /** Lookback period for correlation calculation */
  correlationLookback: number;
  /** Maximum spread to consider opportunity */
  maxSpreadPct: number;
  /** Decay factor for stale correlations */
  correlationDecay: number;
}

interface MarketCorrelation {
  marketA: string;
  marketB: string;
  correlation: number;
  relationship: 'positive' | 'negative' | 'complementary';
  lastUpdated: Date;
}

/**
 * Cross-Market Arbitrage Signal
 *
 * Detects price discrepancies between related prediction markets:
 * 1. Correlated markets that should move together
 * 2. Complementary markets (e.g., Yes/No of related events)
 * 3. Mutually exclusive events that must sum to 1
 *
 * Example opportunities:
 * - "Biden wins 2024" vs "Trump wins 2024" should sum to ~1
 * - "BTC > $100K by Dec" and "BTC > $90K by Dec" should be ordered
 * - Markets on same event across different platforms
 */
export class CrossMarketArbitrageSignal extends BaseSignal {
  readonly signalId = 'cross_market_arb';
  readonly name = 'Cross-Market Arbitrage';
  readonly description = 'Detects price discrepancies between related markets';

  protected parameters: ArbitrageParams = {
    minCorrelation: 0.7,
    minDivergencePct: 3,
    correlationLookback: 30,
    maxSpreadPct: 5,
    correlationDecay: 0.95,
  };

  // Cache of market correlations
  private correlations: Map<string, MarketCorrelation> = new Map();

  getRequiredLookback(): number {
    return this.parameters.correlationLookback;
  }

  isReady(context: SignalContext): boolean {
    // Need related markets to analyze
    return (context.relatedMarkets?.length || 0) > 0 && super.isReady(context);
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    if (!this.isReady(context)) {
      return null;
    }

    const params = this.parameters;
    const currentMarket = context.market;
    const relatedMarkets = context.relatedMarkets || [];

    // Find best arbitrage opportunity
    let bestOpportunity: {
      relatedMarket: MarketInfo;
      divergence: number;
      expectedDirection: 'LONG' | 'SHORT';
      correlation: MarketCorrelation | null;
    } | null = null;

    for (const relatedMarket of relatedMarkets) {
      const opportunity = this.analyzeMarketPair(
        currentMarket,
        relatedMarket,
        context,
        params
      );

      if (opportunity && (!bestOpportunity || Math.abs(opportunity.divergence) > Math.abs(bestOpportunity.divergence))) {
        bestOpportunity = opportunity;
      }
    }

    if (!bestOpportunity || Math.abs(bestOpportunity.divergence) < params.minDivergencePct / 100) {
      return null;
    }

    // Calculate strength and confidence
    const strength = this.calculateStrength(bestOpportunity);
    const confidence = this.calculateConfidence(bestOpportunity, params);
    const direction = bestOpportunity.expectedDirection;

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        bestOpportunity.divergence,
        bestOpportunity.correlation?.correlation || 0,
        currentMarket.currentPriceYes || 0,
        bestOpportunity.relatedMarket.currentPriceYes || 0,
      ],
      metadata: {
        relatedMarketId: bestOpportunity.relatedMarket.id,
        relatedMarketQuestion: bestOpportunity.relatedMarket.question,
        divergence: bestOpportunity.divergence,
        correlation: bestOpportunity.correlation?.correlation,
        relationship: bestOpportunity.correlation?.relationship,
        currentPrice: currentMarket.currentPriceYes,
        relatedPrice: bestOpportunity.relatedMarket.currentPriceYes,
      },
    });
  }

  /**
   * Analyze a pair of markets for arbitrage opportunity
   */
  private analyzeMarketPair(
    currentMarket: MarketInfo,
    relatedMarket: MarketInfo,
    context: SignalContext,
    params: ArbitrageParams
  ): {
    relatedMarket: MarketInfo;
    divergence: number;
    expectedDirection: 'LONG' | 'SHORT';
    correlation: MarketCorrelation | null;
  } | null {
    const currentPrice = currentMarket.currentPriceYes;
    const relatedPrice = relatedMarket.currentPriceYes;

    if (currentPrice === undefined || relatedPrice === undefined) {
      return null;
    }

    // Get or calculate correlation
    const correlationKey = this.getCorrelationKey(currentMarket.id, relatedMarket.id);
    let correlation = this.correlations.get(correlationKey);

    // Check for different types of relationships

    // 1. Complementary markets (should sum to ~1)
    const complementaryOpportunity = this.checkComplementaryMarkets(
      currentMarket,
      relatedMarket,
      currentPrice,
      relatedPrice
    );
    if (complementaryOpportunity) {
      return complementaryOpportunity;
    }

    // 2. Mutually exclusive markets (probabilities should be ordered)
    const exclusiveOpportunity = this.checkMutuallyExclusiveMarkets(
      currentMarket,
      relatedMarket,
      currentPrice,
      relatedPrice
    );
    if (exclusiveOpportunity) {
      return exclusiveOpportunity;
    }

    // 3. Correlated markets (should move together)
    if (correlation && correlation.correlation >= params.minCorrelation) {
      return this.checkCorrelatedMarkets(
        currentMarket,
        relatedMarket,
        currentPrice,
        relatedPrice,
        correlation
      );
    }

    return null;
  }

  /**
   * Check for complementary market arbitrage
   * E.g., "Biden wins" + "Trump wins" ≈ 100% for a two-way race
   */
  private checkComplementaryMarkets(
    currentMarket: MarketInfo,
    relatedMarket: MarketInfo,
    currentPrice: number,
    relatedPrice: number
  ): {
    relatedMarket: MarketInfo;
    divergence: number;
    expectedDirection: 'LONG' | 'SHORT';
    correlation: MarketCorrelation | null;
  } | null {
    // Detect if markets are complementary by category and question analysis
    // This is a simplified heuristic - in production would use NLP
    const isComplementary = this.areMarketsComplementary(currentMarket, relatedMarket);

    if (!isComplementary) {
      return null;
    }

    // For complementary markets, prices should sum to 1 (minus spread)
    const sum = currentPrice + relatedPrice;
    const expectedSum = 0.98; // Account for ~2% spread

    if (sum < expectedSum - 0.03) {
      // Both underpriced - arbitrage opportunity exists
      // Buy the one that's more underpriced relative to its "fair" value
      const currentFair = expectedSum / 2;
      const relatedFair = expectedSum / 2;

      const currentUnderpriced = currentFair - currentPrice;
      const relatedUnderpriced = relatedFair - relatedPrice;

      if (currentUnderpriced > relatedUnderpriced) {
        return {
          relatedMarket,
          divergence: currentUnderpriced,
          expectedDirection: 'LONG',
          correlation: {
            marketA: currentMarket.id,
            marketB: relatedMarket.id,
            correlation: -1,
            relationship: 'complementary',
            lastUpdated: new Date(),
          },
        };
      }
    } else if (sum > 1.02) {
      // Both overpriced - sell opportunity
      const excess = sum - 1;
      return {
        relatedMarket,
        divergence: -excess / 2,
        expectedDirection: 'SHORT',
        correlation: {
          marketA: currentMarket.id,
          marketB: relatedMarket.id,
          correlation: -1,
          relationship: 'complementary',
          lastUpdated: new Date(),
        },
      };
    }

    return null;
  }

  /**
   * Check for mutually exclusive market mispricing
   * E.g., "BTC > $100K" should be <= "BTC > $90K"
   */
  private checkMutuallyExclusiveMarkets(
    currentMarket: MarketInfo,
    relatedMarket: MarketInfo,
    currentPrice: number,
    relatedPrice: number
  ): {
    relatedMarket: MarketInfo;
    divergence: number;
    expectedDirection: 'LONG' | 'SHORT';
    correlation: MarketCorrelation | null;
  } | null {
    // Detect ordered relationships (more restrictive condition should have lower price)
    const orderRelation = this.detectOrderRelation(currentMarket, relatedMarket);

    if (!orderRelation) {
      return null;
    }

    const { moreRestrictive, lessRestrictive } = orderRelation;
    const morePrice = moreRestrictive === 'current' ? currentPrice : relatedPrice;
    const lessPrice = lessRestrictive === 'current' ? currentPrice : relatedPrice;

    // More restrictive should have lower or equal probability
    if (morePrice > lessPrice + 0.02) {
      // Mispricing detected
      const divergence = morePrice - lessPrice;

      if (moreRestrictive === 'current') {
        // Current market is overpriced (more restrictive but higher price)
        return {
          relatedMarket,
          divergence: -divergence,
          expectedDirection: 'SHORT',
          correlation: null,
        };
      } else {
        // Current market is underpriced
        return {
          relatedMarket,
          divergence,
          expectedDirection: 'LONG',
          correlation: null,
        };
      }
    }

    return null;
  }

  /**
   * Check for correlated market divergence
   */
  private checkCorrelatedMarkets(
    currentMarket: MarketInfo,
    relatedMarket: MarketInfo,
    currentPrice: number,
    relatedPrice: number,
    correlation: MarketCorrelation
  ): {
    relatedMarket: MarketInfo;
    divergence: number;
    expectedDirection: 'LONG' | 'SHORT';
    correlation: MarketCorrelation;
  } | null {
    // For positively correlated markets, prices should move together
    // Divergence = current deviating from expected based on related price

    if (correlation.relationship === 'positive') {
      // Expected: if related is high, current should be high
      const expectedPrice = relatedPrice * correlation.correlation;
      const divergence = expectedPrice - currentPrice;

      if (Math.abs(divergence) > 0.03) {
        return {
          relatedMarket,
          divergence,
          expectedDirection: divergence > 0 ? 'LONG' : 'SHORT',
          correlation,
        };
      }
    } else if (correlation.relationship === 'negative') {
      // Expected: if related is high, current should be low
      const expectedPrice = (1 - relatedPrice) * Math.abs(correlation.correlation);
      const divergence = expectedPrice - currentPrice;

      if (Math.abs(divergence) > 0.03) {
        return {
          relatedMarket,
          divergence,
          expectedDirection: divergence > 0 ? 'LONG' : 'SHORT',
          correlation,
        };
      }
    }

    return null;
  }

  /**
   * Calculate signal strength based on opportunity
   */
  private calculateStrength(opportunity: {
    divergence: number;
    correlation: MarketCorrelation | null;
  }): number {
    // Strength proportional to divergence, max at ~10%
    const baseStrength = Math.min(1, Math.abs(opportunity.divergence) / 0.1);

    // Boost if correlation is strong
    const correlationBoost = opportunity.correlation
      ? Math.abs(opportunity.correlation.correlation) * 0.2
      : 0;

    return Math.sign(opportunity.divergence) * Math.min(1, baseStrength + correlationBoost);
  }

  /**
   * Calculate confidence
   */
  private calculateConfidence(
    opportunity: {
      divergence: number;
      correlation: MarketCorrelation | null;
    },
    params: ArbitrageParams
  ): number {
    // Base confidence from divergence magnitude
    const divergenceConfidence = Math.min(1, Math.abs(opportunity.divergence) / 0.15);

    // Correlation confidence
    const correlationConfidence = opportunity.correlation
      ? Math.abs(opportunity.correlation.correlation)
      : 0.5;

    return divergenceConfidence * 0.5 + correlationConfidence * 0.5;
  }

  /**
   * Simple heuristic to detect complementary markets
   */
  private areMarketsComplementary(marketA: MarketInfo, marketB: MarketInfo): boolean {
    // Same category and similar end dates suggest related markets
    if (marketA.category !== marketB.category) {
      return false;
    }

    // Check for opposing keywords in questions
    const questionA = marketA.question.toLowerCase();
    const questionB = marketB.question.toLowerCase();

    // Simple pattern matching for complementary pairs
    const opposites = [
      ['win', 'lose'],
      ['yes', 'no'],
      ['above', 'below'],
      ['over', 'under'],
    ];

    for (const [word1, word2] of opposites) {
      if (
        (questionA.includes(word1) && questionB.includes(word2)) ||
        (questionA.includes(word2) && questionB.includes(word1))
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect order relation between markets
   */
  private detectOrderRelation(
    marketA: MarketInfo,
    marketB: MarketInfo
  ): { moreRestrictive: 'current' | 'related'; lessRestrictive: 'current' | 'related' } | null {
    // Look for numerical thresholds in questions
    const numberPattern = /\$?([\d,]+)k?/gi;

    const numbersA = [...marketA.question.matchAll(numberPattern)].map(m =>
      parseFloat(m[1].replace(',', ''))
    );
    const numbersB = [...marketB.question.matchAll(numberPattern)].map(m =>
      parseFloat(m[1].replace(',', ''))
    );

    if (numbersA.length > 0 && numbersB.length > 0) {
      // Higher threshold = more restrictive for "above" type questions
      if (marketA.question.toLowerCase().includes('above') ||
          marketA.question.toLowerCase().includes('over')) {
        if (numbersA[0] > numbersB[0]) {
          return { moreRestrictive: 'current', lessRestrictive: 'related' };
        } else if (numbersB[0] > numbersA[0]) {
          return { moreRestrictive: 'related', lessRestrictive: 'current' };
        }
      }
    }

    return null;
  }

  /**
   * Get correlation cache key
   */
  private getCorrelationKey(marketA: string, marketB: string): string {
    return [marketA, marketB].sort().join('_');
  }

  /**
   * Update correlation between markets
   */
  updateCorrelation(correlation: MarketCorrelation): void {
    const key = this.getCorrelationKey(correlation.marketA, correlation.marketB);
    this.correlations.set(key, correlation);
  }

  /**
   * Calculate correlation between two price series
   */
  calculateCorrelation(pricesA: number[], pricesB: number[]): number {
    if (pricesA.length !== pricesB.length || pricesA.length < 10) {
      return 0;
    }

    const n = pricesA.length;
    const meanA = pricesA.reduce((a, b) => a + b, 0) / n;
    const meanB = pricesB.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denomA = 0;
    let denomB = 0;

    for (let i = 0; i < n; i++) {
      const diffA = pricesA[i] - meanA;
      const diffB = pricesB[i] - meanB;
      numerator += diffA * diffB;
      denomA += diffA * diffA;
      denomB += diffB * diffB;
    }

    const denominator = Math.sqrt(denomA * denomB);
    return denominator > 0 ? numerator / denominator : 0;
  }
}
