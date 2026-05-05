import { describe, it, expect, beforeEach } from 'vitest';
import { NewsSentimentGenerator } from './NewsSentimentGenerator.js';
import type { SignalContext, MarketInfo } from '../../core/types/signal.types.js';

function makeContext(
  newsSentiment: number | undefined,
  newsArticleCount: number | undefined
): SignalContext {
  const market: MarketInfo = {
    id: 'market-1',
    question: 'Will X happen?',
    isActive: true,
    isResolved: false,
    tokenIdYes: 'token-yes-1',
    currentPriceYes: 0.5,
  };
  return {
    currentTime: new Date(),
    market,
    priceBars: [],
    recentTrades: [],
    custom: {
      ...(newsSentiment !== undefined ? { newsSentiment } : {}),
      ...(newsArticleCount !== undefined ? { newsArticleCount } : {}),
    },
  };
}

describe('NewsSentimentGenerator', () => {
  let generator: NewsSentimentGenerator;

  beforeEach(() => {
    generator = new NewsSentimentGenerator();
  });

  it('has signalId === "news_sentiment"', () => {
    expect(generator.signalId).toBe('news_sentiment');
  });

  it('returns null when |sentiment| < minSentimentMagnitude (0.2)', async () => {
    const ctx = makeContext(0.15, 3);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires when |sentiment| just clears the 0.2 threshold (with enough articles)', async () => {
    // 2026-05-05 calibration: aggregated weighted-average sentiment lands in
    // 0.2-0.3 on real multi-article markets. The threshold was lowered
    // specifically so this case fires.
    const ctx = makeContext(0.25, 3);
    const result = await generator.compute(ctx);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
  });

  it('returns null when articleCount < minArticleCount (2)', async () => {
    const ctx = makeContext(0.8, 1);
    const result = await generator.compute(ctx);
    expect(result).toBeNull();
  });

  it('fires LONG when sentiment=0.7, count=3', async () => {
    const ctx = makeContext(0.7, 3);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('LONG');
    expect(result!.strength).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it('fires SHORT when sentiment=-0.7, count=3', async () => {
    const ctx = makeContext(-0.7, 3);
    const result = await generator.compute(ctx);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('SHORT');
    expect(result!.strength).toBeLessThan(0);
  });

  it('strength scales with article count (more articles = higher |strength| up to cap)', async () => {
    const ctxFew = makeContext(0.7, 2);
    const ctxMany = makeContext(0.7, 5);
    const ctxMore = makeContext(0.7, 10);

    const resultFew = await generator.compute(ctxFew);
    const resultMany = await generator.compute(ctxMany);
    const resultMore = await generator.compute(ctxMore);

    expect(resultFew).not.toBeNull();
    expect(resultMany).not.toBeNull();
    expect(resultMore).not.toBeNull();

    // More articles → stronger signal up to cap at 5
    expect(resultMany!.strength).toBeGreaterThan(resultFew!.strength);
    // Capped: 10 articles should equal 5 articles (min(10/5, 1.0) = min(2,1) = 1.0)
    expect(resultMore!.strength).toBeCloseTo(resultMany!.strength, 5);
  });

  it('getRequiredLookback returns 0', () => {
    expect(generator.getRequiredLookback()).toBe(0);
  });

  it('isReady returns true when newsSentiment is defined', () => {
    const ctx = makeContext(0.5, 3);
    expect(generator.isReady(ctx)).toBe(true);
  });

  it('isReady returns false when newsSentiment is undefined', () => {
    const ctx = makeContext(undefined, 3);
    expect(generator.isReady(ctx)).toBe(false);
  });
});
