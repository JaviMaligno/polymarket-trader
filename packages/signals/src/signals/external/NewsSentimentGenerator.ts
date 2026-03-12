import { BaseSignal } from '../../core/base/BaseSignal.js';
import type {
  SignalContext,
  SignalOutput,
  SignalDirection,
} from '../../core/types/signal.types.js';

interface NewsSentimentParams extends Record<string, unknown> {
  minSentimentMagnitude: number;
  minArticleCount: number;
}

/**
 * Infers market direction from recent news headline sentiment.
 * Requires pre-computed sentiment data in context.custom.
 */
export class NewsSentimentGenerator extends BaseSignal<NewsSentimentParams> {
  readonly signalId = 'news_sentiment';
  readonly name = 'News Headline Sentiment';
  readonly description = 'Infers market direction from recent news headline sentiment';

  protected parameters: NewsSentimentParams = {
    minSentimentMagnitude: 0.3,
    minArticleCount: 2,
  };

  async compute(context: SignalContext): Promise<SignalOutput | null> {
    const sentimentScore = (context.custom?.newsSentiment as number) ?? 0;
    const articleCount = (context.custom?.newsArticleCount as number) ?? 0;

    const { minSentimentMagnitude, minArticleCount } = this.parameters;

    if (Math.abs(sentimentScore) < minSentimentMagnitude) {
      return null;
    }

    if (articleCount < minArticleCount) {
      return null;
    }

    const direction: SignalDirection = sentimentScore > 0 ? 'LONG' : 'SHORT';
    const directionSign = sentimentScore > 0 ? 1 : -1;

    const strength =
      Math.abs(sentimentScore) * Math.min(articleCount / 5, 1.0) * directionSign;

    const confidence = Math.min(
      1.0,
      0.3 + Math.abs(sentimentScore) * 0.4 + articleCount * 0.05
    );

    return this.createOutput(context, direction, strength, confidence, {
      metadata: { sentimentScore, articleCount },
    });
  }

  getRequiredLookback(): number {
    return 0;
  }

  isReady(context: SignalContext): boolean {
    return context.custom?.newsSentiment !== undefined;
  }
}
