import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  MarketInfo,
} from '../../core/types/signal.types.js';

/**
 * Supported external platforms for cross-platform arbitrage
 */
export type ExternalPlatform = 'kalshi' | 'predictit' | 'metaculus' | 'manifold' | 'polymarket';

/**
 * Fee structure for platforms
 */
export interface PlatformFees {
  /** Winner fee (e.g., 0.02 = 2%) */
  winnerFee: number;
  /** Maker fee */
  makerFee: number;
  /** Taker fee */
  takerFee: number;
  /** Withdrawal fee (flat) */
  withdrawalFee: number;
  /** Minimum bet size */
  minBetSize: number;
}

/** Default platform fees */
export const PLATFORM_FEES: Record<ExternalPlatform, PlatformFees> = {
  polymarket: {
    winnerFee: 0.02, // 2% winner fee
    makerFee: 0,
    takerFee: 0,
    withdrawalFee: 0,
    minBetSize: 1,
  },
  kalshi: {
    winnerFee: 0,
    makerFee: 0,
    takerFee: 0.07, // 7 cents per contract
    withdrawalFee: 0,
    minBetSize: 1,
  },
  predictit: {
    winnerFee: 0.10, // 10% winner fee
    makerFee: 0,
    takerFee: 0,
    withdrawalFee: 0.05, // 5% withdrawal fee
    minBetSize: 1,
  },
  metaculus: {
    winnerFee: 0,
    makerFee: 0,
    takerFee: 0,
    withdrawalFee: 0,
    minBetSize: 0,
  },
  manifold: {
    winnerFee: 0,
    makerFee: 0,
    takerFee: 0,
    withdrawalFee: 0,
    minBetSize: 1,
  },
};

/**
 * External platform market data
 */
export interface ExternalMarketData {
  platform: ExternalPlatform;
  marketId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  liquidity: number;
  lastUpdate: Date;
  /** Latency to fetch this data in ms */
  latencyMs: number;
  /** Whether data is from WebSocket (real-time) or REST (polled) */
  isRealTime: boolean;
}

/**
 * Cross-platform arbitrage opportunity
 */
export interface CrossPlatformOpportunity {
  polymarketMarket: MarketInfo;
  externalMarket: ExternalMarketData;
  /** Price difference after fees */
  netDivergence: number;
  /** Expected profit after all fees */
  expectedNetProfit: number;
  /** ROI after fees */
  netROI: number;
  /** Which side to buy on Polymarket */
  polymarketSide: 'YES' | 'NO';
  /** Which side to buy on external platform */
  externalSide: 'YES' | 'NO';
  /** Detection latency in ms */
  detectionLatencyMs: number;
  /** Time window before opportunity likely closes */
  estimatedWindowMs: number;
  /** Risk score (0-1, higher = riskier) */
  riskScore: number;
}

/**
 * External platform data provider interface
 */
export interface IExternalPlatformProvider {
  /** Platform name */
  getPlatform(): ExternalPlatform;
  /** Get market data by ID */
  getMarket(marketId: string): Promise<ExternalMarketData | null>;
  /** Find similar markets to a Polymarket question */
  findSimilarMarkets(question: string, category: string): Promise<ExternalMarketData[]>;
  /** Subscribe to real-time updates (returns unsubscribe function) */
  subscribe(marketId: string, callback: (data: ExternalMarketData) => void): () => void;
  /** Get connection latency estimate */
  getLatencyEstimate(): number;
}

/**
 * Configuration for enhanced arbitrage signal
 */
export interface CrossMarketArbitrageConfig extends Record<string, unknown> {
  /** Minimum correlation to consider markets related */
  minCorrelation?: number;
  /** Minimum price divergence to signal (%) */
  minDivergencePct?: number;
  /** Lookback period for correlation calculation */
  correlationLookback?: number;
  /** Maximum spread to consider opportunity */
  maxSpreadPct?: number;
  /** Decay factor for stale correlations */
  correlationDecay?: number;
  /** Minimum net ROI after fees (%) - default: 1.5 */
  minNetROIPct?: number;
  /** Maximum acceptable latency (ms) - default: 500 */
  maxLatencyMs?: number;
  /** Enable cross-platform arbitrage - default: true */
  enableCrossPlatform?: boolean;
  /** Platforms to consider for cross-platform arb */
  enabledPlatforms?: ExternalPlatform[];
  /** Minimum liquidity required - default: 1000 */
  minLiquidity?: number;
  /** Risk tolerance (0-1) - default: 0.5 */
  riskTolerance?: number;
}

interface ArbitrageParams extends Record<string, unknown> {
  minCorrelation: number;
  minDivergencePct: number;
  correlationLookback: number;
  maxSpreadPct: number;
  correlationDecay: number;
  minNetROIPct: number;
  maxLatencyMs: number;
  enableCrossPlatform: boolean;
  enabledPlatforms: ExternalPlatform[];
  minLiquidity: number;
  riskTolerance: number;
}

/** Default parameters */
export const DEFAULT_ARBITRAGE_PARAMS: ArbitrageParams = {
  minCorrelation: 0.7,
  minDivergencePct: 3,
  correlationLookback: 30,
  maxSpreadPct: 5,
  correlationDecay: 0.95,
  minNetROIPct: 1.5,
  maxLatencyMs: 500,
  enableCrossPlatform: true,
  enabledPlatforms: ['kalshi', 'predictit'],
  minLiquidity: 1000,
  riskTolerance: 0.5,
};

/**
 * Market correlation data
 */
export interface MarketCorrelation {
  marketA: string;
  marketB: string;
  correlation: number;
  relationship: 'positive' | 'negative' | 'complementary';
  lastUpdated: Date;
}

/**
 * Enhanced Cross-Market Arbitrage Signal
 *
 * Detects price discrepancies between related prediction markets:
 * 1. Correlated markets that should move together
 * 2. Complementary markets (e.g., Yes/No of related events)
 * 3. Mutually exclusive events that must sum to 1
 * 4. Cross-platform arbitrage (Polymarket vs Kalshi, PredictIt, etc.)
 *
 * New features:
 * - Cross-platform integration with external providers
 * - Net ROI calculation after all fees (2% winner fee on Polymarket)
 * - Latency-aware opportunity detection
 * - Risk scoring for arbitrage opportunities
 *
 * Example opportunities:
 * - "Biden wins 2024" vs "Trump wins 2024" should sum to ~1
 * - "BTC > $100K by Dec" and "BTC > $90K by Dec" should be ordered
 * - Markets on same event across different platforms
 */
export class CrossMarketArbitrageSignal extends BaseSignal {
  readonly signalId = 'cross_market_arb';
  readonly name = 'Cross-Market Arbitrage';
  readonly description = 'Detects price discrepancies between related markets with cross-platform support';

  protected parameters: ArbitrageParams = { ...DEFAULT_ARBITRAGE_PARAMS };

  /** Cache of market correlations */
  private correlations: Map<string, MarketCorrelation> = new Map();
  /** External platform providers */
  private externalProviders: Map<ExternalPlatform, IExternalPlatformProvider> = new Map();
  /** Cache of external market data */
  private externalMarketCache: Map<string, { data: ExternalMarketData; expiry: number }> = new Map();
  /** Active cross-platform opportunities */
  private crossPlatformOpportunities: CrossPlatformOpportunity[] = [];
  /** Latency tracking per platform */
  private platformLatencies: Map<ExternalPlatform, number[]> = new Map();

  private readonly CACHE_TTL_MS = 5000; // 5 seconds for external data
  private readonly MAX_LATENCY_SAMPLES = 100;

  constructor(config?: CrossMarketArbitrageConfig) {
    super();
    if (config) {
      this.parameters = { ...DEFAULT_ARBITRAGE_PARAMS, ...config };
    }
  }

  /**
   * Register an external platform provider
   */
  registerProvider(provider: IExternalPlatformProvider): void {
    this.externalProviders.set(provider.getPlatform(), provider);
    this.logger.info({ platform: provider.getPlatform() }, 'External platform provider registered');
  }

  /**
   * Remove an external platform provider
   */
  unregisterProvider(platform: ExternalPlatform): void {
    this.externalProviders.delete(platform);
  }

  getRequiredLookback(): number {
    return this.parameters.correlationLookback;
  }

  isReady(context: SignalContext): boolean {
    // Can work with related markets OR external providers
    const hasRelatedMarkets = (context.relatedMarkets?.length || 0) > 0;
    const hasExternalProviders = this.externalProviders.size > 0;
    return (hasRelatedMarkets || hasExternalProviders) && super.isReady(context);
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const params = this.parameters;
    const currentMarket = context.market;
    const relatedMarkets = context.relatedMarkets || [];

    // Track detection start time for latency measurement
    const detectionStartMs = Date.now();

    // Find best intra-platform arbitrage opportunity
    let bestIntraPlatform: {
      relatedMarket: MarketInfo;
      divergence: number;
      expectedDirection: 'LONG' | 'SHORT';
      correlation: MarketCorrelation | null;
      netROI: number;
    } | null = null;

    for (const relatedMarket of relatedMarkets) {
      const opportunity = this.analyzeMarketPair(
        currentMarket,
        relatedMarket,
        context,
        params
      );

      if (opportunity) {
        // Calculate net ROI after Polymarket fees
        const netROI = this.calculateNetROI(
          opportunity.divergence,
          'polymarket',
          'polymarket'
        );

        if (netROI >= params.minNetROIPct / 100) {
          if (!bestIntraPlatform || netROI > bestIntraPlatform.netROI) {
            bestIntraPlatform = { ...opportunity, netROI };
          }
        }
      }
    }

    // Find best cross-platform arbitrage opportunity
    let bestCrossPlatform: CrossPlatformOpportunity | null = null;

    if (params.enableCrossPlatform && this.externalProviders.size > 0) {
      bestCrossPlatform = await this.findBestCrossPlatformOpportunity(
        currentMarket,
        params,
        detectionStartMs
      );
    }

    // Choose best overall opportunity
    const useCrossPlatform = bestCrossPlatform &&
      (!bestIntraPlatform || bestCrossPlatform.netROI > bestIntraPlatform.netROI);

    if (useCrossPlatform && bestCrossPlatform) {
      return this.createCrossPlatformOutput(context, bestCrossPlatform, params);
    }

    if (bestIntraPlatform) {
      return this.createIntraPlatformOutput(context, bestIntraPlatform, params);
    }

    return null;
  }

  /**
   * Find best cross-platform arbitrage opportunity
   */
  private async findBestCrossPlatformOpportunity(
    polymarketMarket: MarketInfo,
    params: ArbitrageParams,
    detectionStartMs: number
  ): Promise<CrossPlatformOpportunity | null> {
    let bestOpportunity: CrossPlatformOpportunity | null = null;

    for (const [platform, provider] of this.externalProviders) {
      if (!params.enabledPlatforms.includes(platform)) continue;

      try {
        // Check latency
        const estimatedLatency = provider.getLatencyEstimate();
        if (estimatedLatency > params.maxLatencyMs) {
          this.logger.debug({ platform, latency: estimatedLatency }, 'Skipping platform due to high latency');
          continue;
        }

        // Find similar markets on external platform
        const startTime = Date.now();
        const externalMarkets = await provider.findSimilarMarkets(
          polymarketMarket.question,
          polymarketMarket.category || ''
        );
        const fetchLatency = Date.now() - startTime;

        // Track latency
        this.trackLatency(platform, fetchLatency);

        for (const externalMarket of externalMarkets) {
          // Check liquidity
          if (externalMarket.liquidity < params.minLiquidity) continue;

          // Check total latency
          const totalLatency = fetchLatency + externalMarket.latencyMs;
          if (totalLatency > params.maxLatencyMs) continue;

          // Analyze opportunity
          const opportunity = this.analyzeCrossPlatformPair(
            polymarketMarket,
            externalMarket,
            totalLatency,
            detectionStartMs,
            params
          );

          if (opportunity && opportunity.netROI >= params.minNetROIPct / 100) {
            if (!bestOpportunity || opportunity.netROI > bestOpportunity.netROI) {
              bestOpportunity = opportunity;
            }
          }
        }
      } catch (error) {
        this.logger.warn({
          platform,
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to fetch external platform data');
      }
    }

    return bestOpportunity;
  }

  /**
   * Analyze cross-platform pair for arbitrage
   */
  private analyzeCrossPlatformPair(
    polymarketMarket: MarketInfo,
    externalMarket: ExternalMarketData,
    latencyMs: number,
    detectionStartMs: number,
    params: ArbitrageParams
  ): CrossPlatformOpportunity | null {
    const polyYes = polymarketMarket.currentPriceYes ?? 0.5;
    const polyNo = 1 - polyYes;
    const extYes = externalMarket.yesPrice;
    const extNo = externalMarket.noPrice;

    // Calculate potential arbitrage scenarios:
    // 1. Buy YES on Poly, Buy NO on External (if polyYes + extNo < 1)
    // 2. Buy NO on Poly, Buy YES on External (if polyNo + extYes < 1)

    const scenario1Cost = polyYes + extNo;
    const scenario2Cost = polyNo + extYes;

    let bestScenario: {
      polySide: 'YES' | 'NO';
      extSide: 'YES' | 'NO';
      grossProfit: number;
    } | null = null;

    if (scenario1Cost < 0.98) { // ~2% margin needed for fees
      bestScenario = {
        polySide: 'YES',
        extSide: 'NO',
        grossProfit: 1 - scenario1Cost,
      };
    } else if (scenario2Cost < 0.98) {
      bestScenario = {
        polySide: 'NO',
        extSide: 'YES',
        grossProfit: 1 - scenario2Cost,
      };
    }

    if (!bestScenario) return null;

    // Calculate net ROI after fees
    // FIXED: Correct fee calculation for arbitrage
    const polyFees = PLATFORM_FEES.polymarket;
    const extFees = PLATFORM_FEES[externalMarket.platform];

    // In arbitrage, we buy BOTH sides upfront (one on each platform)
    // Cost includes purchase prices AND any taker fees paid at purchase time
    // Payout is $1 from the winning side minus winner fee

    // Determine the actual cost and potential payouts for the chosen scenario
    let cost: number;
    let payoutIfPolyWins: number;
    let payoutIfExtWins: number;

    if (bestScenario.polySide === 'YES') {
      // Scenario 1: Buy YES on Poly, Buy NO on External
      cost = polyYes + extNo + polyFees.takerFee + extFees.takerFee;
      // If YES wins (event happens): Poly wins, External loses
      payoutIfPolyWins = 1 - polyFees.winnerFee;
      // If NO wins (event doesn't happen): External wins, Poly loses
      payoutIfExtWins = 1 - extFees.winnerFee;
    } else {
      // Scenario 2: Buy NO on Poly, Buy YES on External
      cost = polyNo + extYes + polyFees.takerFee + extFees.takerFee;
      // If NO wins (event doesn't happen): Poly wins, External loses
      payoutIfPolyWins = 1 - polyFees.winnerFee;
      // If YES wins (event happens): External wins, Poly loses
      payoutIfExtWins = 1 - extFees.winnerFee;
    }

    // For arbitrage, we care about the WORST-CASE payout (guaranteed profit)
    const minPayout = Math.min(payoutIfPolyWins, payoutIfExtWins);
    const expectedNet = minPayout - cost;

    if (expectedNet <= 0) return null;

    // cost is already calculated above
    const netROI = expectedNet / cost;

    // Calculate risk score
    const riskScore = this.calculateCrossPlatformRisk(
      polymarketMarket,
      externalMarket,
      latencyMs,
      params
    );

    // Estimate time window (opportunity likely to close)
    const estimatedWindow = this.estimateOpportunityWindow(
      bestScenario.grossProfit,
      externalMarket.volume24h
    );

    return {
      polymarketMarket,
      externalMarket,
      netDivergence: bestScenario.grossProfit,
      expectedNetProfit: expectedNet,
      netROI,
      polymarketSide: bestScenario.polySide,
      externalSide: bestScenario.extSide,
      detectionLatencyMs: Date.now() - detectionStartMs,
      estimatedWindowMs: estimatedWindow,
      riskScore,
    };
  }

  /**
   * Calculate net ROI after platform fees
   */
  calculateNetROI(
    grossDivergence: number,
    buyPlatform: ExternalPlatform,
    sellPlatform: ExternalPlatform
  ): number {
    const buyFees = PLATFORM_FEES[buyPlatform];
    const sellFees = PLATFORM_FEES[sellPlatform];

    // Account for winner fees and trading fees
    const totalFees = buyFees.winnerFee + buyFees.takerFee + sellFees.takerFee;
    const netProfit = grossDivergence - totalFees;

    return netProfit;
  }

  /**
   * Calculate risk score for cross-platform arbitrage
   */
  private calculateCrossPlatformRisk(
    polyMarket: MarketInfo,
    extMarket: ExternalMarketData,
    latencyMs: number,
    params: ArbitrageParams
  ): number {
    let risk = 0;

    // Latency risk (higher latency = higher risk of price change)
    risk += Math.min(0.3, latencyMs / params.maxLatencyMs * 0.3);

    // Liquidity risk
    const minLiquidity = Math.min(polyMarket.volume24h || 0, extMarket.liquidity);
    risk += Math.max(0, 0.2 - minLiquidity / (params.minLiquidity * 10) * 0.2);

    // Data staleness risk
    if (!extMarket.isRealTime) {
      risk += 0.15;
    }

    // Price volatility risk (approximated by spread)
    const polySpread = (polyMarket.currentPriceYes ?? 0.5) - (1 - (polyMarket.currentPriceYes ?? 0.5));
    const extSpread = extMarket.yesPrice + extMarket.noPrice - 1;
    const avgSpread = (Math.abs(polySpread) + Math.abs(extSpread)) / 2;
    risk += Math.min(0.2, avgSpread * 2);

    // Execution risk (platform reliability)
    // Could be based on historical success rates

    return Math.min(1, risk);
  }

  /**
   * Estimate how long arbitrage opportunity will last
   */
  private estimateOpportunityWindow(profit: number, volume24h: number): number {
    // Higher volume = faster closure, larger profit = longer window
    const baseWindow = 60000; // 1 minute base
    const volumeFactor = Math.max(0.1, Math.min(2, 10000 / (volume24h + 1)));
    const profitFactor = Math.max(0.5, Math.min(3, profit * 20));

    return baseWindow * volumeFactor * profitFactor;
  }

  /**
   * Track platform latency
   */
  private trackLatency(platform: ExternalPlatform, latencyMs: number): void {
    if (!this.platformLatencies.has(platform)) {
      this.platformLatencies.set(platform, []);
    }
    const samples = this.platformLatencies.get(platform)!;
    samples.push(latencyMs);
    if (samples.length > this.MAX_LATENCY_SAMPLES) {
      samples.shift();
    }
  }

  /**
   * Get average latency for a platform
   */
  getAverageLatency(platform: ExternalPlatform): number {
    const samples = this.platformLatencies.get(platform);
    if (!samples || samples.length === 0) return Infinity;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  /**
   * Create output for cross-platform opportunity
   */
  private createCrossPlatformOutput(
    context: SignalContext,
    opportunity: CrossPlatformOpportunity,
    params: ArbitrageParams
  ): SignalOutput {
    const direction = opportunity.polymarketSide === 'YES' ? 'LONG' : 'SHORT';
    const strength = Math.min(1, opportunity.netROI * 5); // Scale ROI to strength
    const confidence = Math.max(0, 1 - opportunity.riskScore);

    // Store for external access
    this.crossPlatformOpportunities.push(opportunity);
    if (this.crossPlatformOpportunities.length > 10) {
      this.crossPlatformOpportunities.shift();
    }

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        opportunity.netDivergence,
        opportunity.netROI,
        opportunity.riskScore,
        opportunity.detectionLatencyMs,
      ],
      metadata: {
        type: 'cross_platform',
        externalPlatform: opportunity.externalMarket.platform,
        externalMarketId: opportunity.externalMarket.marketId,
        polymarketSide: opportunity.polymarketSide,
        externalSide: opportunity.externalSide,
        netROI: opportunity.netROI,
        expectedNetProfit: opportunity.expectedNetProfit,
        detectionLatencyMs: opportunity.detectionLatencyMs,
        estimatedWindowMs: opportunity.estimatedWindowMs,
        riskScore: opportunity.riskScore,
        polyPrice: opportunity.polymarketSide === 'YES'
          ? context.market.currentPriceYes
          : 1 - (context.market.currentPriceYes ?? 0.5),
        externalPrice: opportunity.externalSide === 'YES'
          ? opportunity.externalMarket.yesPrice
          : opportunity.externalMarket.noPrice,
      },
    });
  }

  /**
   * Create output for intra-platform opportunity
   */
  private createIntraPlatformOutput(
    context: SignalContext,
    opportunity: {
      relatedMarket: MarketInfo;
      divergence: number;
      expectedDirection: 'LONG' | 'SHORT';
      correlation: MarketCorrelation | null;
      netROI: number;
    },
    params: ArbitrageParams
  ): SignalOutput {
    const strength = this.calculateStrength(opportunity);
    const confidence = this.calculateConfidence(opportunity, params);

    return this.createOutput(context, opportunity.expectedDirection, strength, confidence, {
      features: [
        opportunity.divergence,
        opportunity.correlation?.correlation || 0,
        context.market.currentPriceYes || 0,
        opportunity.relatedMarket.currentPriceYes || 0,
        opportunity.netROI,
      ],
      metadata: {
        type: 'intra_platform',
        relatedMarketId: opportunity.relatedMarket.id,
        relatedMarketQuestion: opportunity.relatedMarket.question,
        divergence: opportunity.divergence,
        netROI: opportunity.netROI,
        correlation: opportunity.correlation?.correlation,
        relationship: opportunity.correlation?.relationship,
        currentPrice: context.market.currentPriceYes,
        relatedPrice: opportunity.relatedMarket.currentPriceYes,
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
