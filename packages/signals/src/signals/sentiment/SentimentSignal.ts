import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
} from '../../core/types/signal.types.js';

/**
 * Sentiment source types
 */
export type SentimentSource = 'twitter' | 'news' | 'reddit' | 'polymarket_comments';

/**
 * Sentiment analysis result from external source
 */
export interface SentimentAnalysis {
  /** Source of the sentiment */
  source: SentimentSource;
  /** Raw text that was analyzed */
  rawText: string;
  /** Sentiment score from -1 (negative) to +1 (positive) */
  sentiment: number;
  /** Confidence in the sentiment analysis (0-1) */
  confidence: number;
  /** Relevance to the market (0-1) */
  relevanceScore: number;
  /** When this was analyzed */
  timestamp: Date;
  /** Number of mentions/posts */
  mentionCount?: number;
  /** Keywords found */
  keywords?: string[];
}

/**
 * Sentiment data provider interface
 * Implementations should fetch sentiment from external sources
 */
export interface ISentimentProvider {
  /** Get sentiment for a market */
  getSentiment(marketId: string, question: string): Promise<SentimentAnalysis[]>;
  /** Get provider name */
  getName(): string;
}

/**
 * Configuration parameters for Sentiment Signal
 */
export interface SentimentSignalConfig extends Record<string, unknown> {
  /** Minimum relevance score to include sentiment - default: 0.3 */
  minRelevance?: number;
  /** Minimum confidence to include sentiment - default: 0.4 */
  minSentimentConfidence?: number;
  /** Time decay half-life in hours - default: 6 */
  decayHalfLifeHours?: number;
  /** Weight for Twitter sentiment - default: 0.35 */
  twitterWeight?: number;
  /** Weight for news sentiment - default: 0.40 */
  newsWeight?: number;
  /** Weight for Reddit sentiment - default: 0.15 */
  redditWeight?: number;
  /** Weight for Polymarket comments - default: 0.10 */
  polymarketWeight?: number;
  /** Minimum mentions to generate signal - default: 3 */
  minMentions?: number;
  /** Sentiment strength multiplier - default: 1.5 */
  strengthMultiplier?: number;
  /** Minimum strength to emit signal - default: 0.15 */
  minStrength?: number;
  /** Minimum confidence to emit signal - default: 0.25 */
  minConfidence?: number;
}

interface SentimentParams extends Record<string, unknown> {
  minRelevance: number;
  minSentimentConfidence: number;
  decayHalfLifeHours: number;
  twitterWeight: number;
  newsWeight: number;
  redditWeight: number;
  polymarketWeight: number;
  minMentions: number;
  strengthMultiplier: number;
  minStrength: number;
  minConfidence: number;
}

/** Default parameters for Sentiment Signal */
export const DEFAULT_SENTIMENT_PARAMS: SentimentParams = {
  minRelevance: 0.3,
  minSentimentConfidence: 0.4,
  decayHalfLifeHours: 6,
  twitterWeight: 0.35,
  newsWeight: 0.40,
  redditWeight: 0.15,
  polymarketWeight: 0.10,
  minMentions: 3,
  strengthMultiplier: 1.5,
  minStrength: 0.15,
  minConfidence: 0.25,
};

/**
 * Sentiment Signal
 *
 * Analyzes sentiment from multiple sources (Twitter, news, Reddit)
 * to predict market direction. Uses time decay to weight recent
 * sentiment more heavily.
 *
 * Positive sentiment = expect price to increase (LONG)
 * Negative sentiment = expect price to decrease (SHORT)
 *
 * Note: Requires external sentiment providers to be registered.
 * Without providers, this signal will not generate outputs.
 */
export class SentimentSignal extends BaseSignal {
  readonly signalId = 'sentiment';
  readonly name = 'Sentiment Analysis';
  readonly description = 'Analyzes social media and news sentiment for market prediction';

  protected parameters: SentimentParams;
  private providers: ISentimentProvider[] = [];
  private sentimentCache: Map<string, { data: SentimentAnalysis[]; timestamp: Date }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config?: SentimentSignalConfig) {
    super();
    this.parameters = {
      ...DEFAULT_SENTIMENT_PARAMS,
      ...config,
    };
  }

  /**
   * Register a sentiment provider
   */
  registerProvider(provider: ISentimentProvider): void {
    this.providers.push(provider);
    this.logger.info({ provider: provider.getName() }, 'Sentiment provider registered');
  }

  /**
   * Remove a sentiment provider
   */
  unregisterProvider(providerName: string): void {
    this.providers = this.providers.filter(p => p.getName() !== providerName);
  }

  getRequiredLookback(): number {
    return 1; // Sentiment doesn't need price history
  }

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const params = this.parameters;

    // Get sentiment from all providers
    const sentiments = await this.fetchSentiments(context.market.id, context.market.question);

    if (sentiments.length === 0) {
      return null;
    }

    // Filter by relevance and confidence
    const filteredSentiments = sentiments.filter(s =>
      s.relevanceScore >= params.minRelevance &&
      s.confidence >= params.minSentimentConfidence
    );

    if (filteredSentiments.length < params.minMentions) {
      return null;
    }

    // Calculate weighted sentiment by source
    const sourceSentiments = this.aggregateBySources(filteredSentiments, params);
    const combinedSentiment = this.combineSentiments(sourceSentiments, params);

    // Apply time decay to get final strength
    const decayedSentiment = this.applyTimeDecay(filteredSentiments, combinedSentiment, params);

    // Calculate strength and confidence
    const strength = Math.max(-1, Math.min(1, decayedSentiment.sentiment * params.strengthMultiplier));
    const confidence = this.calculateConfidence(filteredSentiments, decayedSentiment, params);

    const direction = this.getDirection(strength, params.minStrength);

    // Filter weak signals
    if (Math.abs(strength) < params.minStrength || confidence < params.minConfidence) {
      return null;
    }

    return this.createOutput(context, direction, strength, confidence, {
      features: [
        combinedSentiment.sentiment,
        combinedSentiment.twitterSentiment ?? 0,
        combinedSentiment.newsSentiment ?? 0,
        combinedSentiment.redditSentiment ?? 0,
        filteredSentiments.length,
        confidence,
      ],
      metadata: {
        combinedSentiment: combinedSentiment.sentiment,
        twitterSentiment: combinedSentiment.twitterSentiment,
        newsSentiment: combinedSentiment.newsSentiment,
        redditSentiment: combinedSentiment.redditSentiment,
        polymarketSentiment: combinedSentiment.polymarketSentiment,
        totalMentions: filteredSentiments.length,
        avgRelevance: this.average(filteredSentiments.map(s => s.relevanceScore)),
        avgConfidence: this.average(filteredSentiments.map(s => s.confidence)),
        sources: this.countBySources(filteredSentiments),
      },
    });
  }

  /**
   * Fetch sentiments from all providers with caching
   */
  private async fetchSentiments(marketId: string, question: string): Promise<SentimentAnalysis[]> {
    // Check cache
    const cached = this.sentimentCache.get(marketId);
    if (cached && Date.now() - cached.timestamp.getTime() < this.CACHE_TTL_MS) {
      return cached.data;
    }

    // Fetch from all providers
    const allSentiments: SentimentAnalysis[] = [];

    for (const provider of this.providers) {
      try {
        const sentiments = await provider.getSentiment(marketId, question);
        allSentiments.push(...sentiments);
      } catch (error) {
        this.logger.warn({
          provider: provider.getName(),
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to fetch sentiment from provider');
      }
    }

    // Cache results
    this.sentimentCache.set(marketId, {
      data: allSentiments,
      timestamp: new Date(),
    });

    return allSentiments;
  }

  /**
   * Aggregate sentiments by source type
   */
  private aggregateBySources(
    sentiments: SentimentAnalysis[],
    params: SentimentParams
  ): Map<SentimentSource, { sentiment: number; count: number; avgConfidence: number }> {
    const bySource = new Map<SentimentSource, SentimentAnalysis[]>();

    for (const s of sentiments) {
      const existing = bySource.get(s.source) || [];
      existing.push(s);
      bySource.set(s.source, existing);
    }

    const aggregated = new Map<SentimentSource, { sentiment: number; count: number; avgConfidence: number }>();

    for (const [source, items] of bySource) {
      // Weight by confidence and relevance
      let totalWeight = 0;
      let weightedSentiment = 0;

      for (const item of items) {
        const weight = item.confidence * item.relevanceScore;
        weightedSentiment += item.sentiment * weight;
        totalWeight += weight;
      }

      aggregated.set(source, {
        sentiment: totalWeight > 0 ? weightedSentiment / totalWeight : 0,
        count: items.length,
        avgConfidence: this.average(items.map(i => i.confidence)),
      });
    }

    return aggregated;
  }

  /**
   * Combine sentiments from different sources
   */
  private combineSentiments(
    sourceSentiments: Map<SentimentSource, { sentiment: number; count: number; avgConfidence: number }>,
    params: SentimentParams
  ): {
    sentiment: number;
    twitterSentiment?: number;
    newsSentiment?: number;
    redditSentiment?: number;
    polymarketSentiment?: number;
  } {
    const weights: Record<SentimentSource, number> = {
      twitter: params.twitterWeight,
      news: params.newsWeight,
      reddit: params.redditWeight,
      polymarket_comments: params.polymarketWeight,
    };

    let totalWeight = 0;
    let weightedSentiment = 0;

    const result: {
      sentiment: number;
      twitterSentiment?: number;
      newsSentiment?: number;
      redditSentiment?: number;
      polymarketSentiment?: number;
    } = { sentiment: 0 };

    for (const [source, data] of sourceSentiments) {
      const weight = weights[source] || 0;
      weightedSentiment += data.sentiment * weight;
      totalWeight += weight;

      // Store individual source sentiments
      switch (source) {
        case 'twitter':
          result.twitterSentiment = data.sentiment;
          break;
        case 'news':
          result.newsSentiment = data.sentiment;
          break;
        case 'reddit':
          result.redditSentiment = data.sentiment;
          break;
        case 'polymarket_comments':
          result.polymarketSentiment = data.sentiment;
          break;
      }
    }

    result.sentiment = totalWeight > 0 ? weightedSentiment / totalWeight : 0;
    return result;
  }

  /**
   * Apply time decay to sentiment (recent sentiment matters more)
   */
  private applyTimeDecay(
    sentiments: SentimentAnalysis[],
    combinedSentiment: { sentiment: number },
    params: SentimentParams
  ): { sentiment: number; recentWeight: number } {
    const now = Date.now();
    const halfLifeMs = params.decayHalfLifeHours * 60 * 60 * 1000;

    let totalWeight = 0;
    let weightedSentiment = 0;

    for (const s of sentiments) {
      const ageMs = now - s.timestamp.getTime();
      const decayWeight = Math.pow(0.5, ageMs / halfLifeMs);
      const weight = decayWeight * s.confidence * s.relevanceScore;

      weightedSentiment += s.sentiment * weight;
      totalWeight += weight;
    }

    return {
      sentiment: totalWeight > 0 ? weightedSentiment / totalWeight : combinedSentiment.sentiment,
      recentWeight: totalWeight,
    };
  }

  /**
   * Calculate confidence based on data quality
   */
  private calculateConfidence(
    sentiments: SentimentAnalysis[],
    decayedSentiment: { sentiment: number; recentWeight: number },
    params: SentimentParams
  ): number {
    let confidence = 0;

    // Volume bonus: more mentions = higher confidence
    const volumeBonus = Math.min(0.3, sentiments.length / 50);
    confidence += volumeBonus;

    // Agreement bonus: if sources agree, higher confidence
    const sources = this.countBySources(sentiments);
    const sourceCount = Object.keys(sources).length;
    if (sourceCount >= 2) {
      const sourceSentiments = Object.values(sources).map(s => s.avgSentiment);
      const allSameSign = sourceSentiments.every(s => Math.sign(s) === Math.sign(decayedSentiment.sentiment));
      if (allSameSign) {
        confidence += 0.25;
      }
    }

    // Recency bonus: recent data adds confidence
    const avgAge = this.averageAge(sentiments);
    const recencyBonus = Math.max(0, 0.25 - (avgAge / (params.decayHalfLifeHours * 2)));
    confidence += recencyBonus;

    // Strength bonus: stronger sentiment = more confident
    confidence += Math.abs(decayedSentiment.sentiment) * 0.2;

    return Math.min(1, confidence);
  }

  /**
   * Count sentiments by source
   */
  private countBySources(sentiments: SentimentAnalysis[]): Record<string, { count: number; avgSentiment: number }> {
    const counts: Record<string, { count: number; totalSentiment: number }> = {};

    for (const s of sentiments) {
      if (!counts[s.source]) {
        counts[s.source] = { count: 0, totalSentiment: 0 };
      }
      counts[s.source].count++;
      counts[s.source].totalSentiment += s.sentiment;
    }

    const result: Record<string, { count: number; avgSentiment: number }> = {};
    for (const [source, data] of Object.entries(counts)) {
      result[source] = {
        count: data.count,
        avgSentiment: data.totalSentiment / data.count,
      };
    }

    return result;
  }

  /**
   * Calculate average
   */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Calculate average age of sentiments in hours
   */
  private averageAge(sentiments: SentimentAnalysis[]): number {
    if (sentiments.length === 0) return Infinity;
    const now = Date.now();
    const totalAgeHours = sentiments.reduce((sum, s) =>
      sum + (now - s.timestamp.getTime()) / (1000 * 60 * 60), 0);
    return totalAgeHours / sentiments.length;
  }

  /**
   * Clear sentiment cache
   */
  clearCache(): void {
    this.sentimentCache.clear();
  }

  /**
   * Set sentiment data directly (for testing or manual input)
   */
  setSentimentData(marketId: string, data: SentimentAnalysis[]): void {
    this.sentimentCache.set(marketId, {
      data,
      timestamp: new Date(),
    });
  }
}
