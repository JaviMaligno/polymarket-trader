import { afinn165 } from 'afinn-165';

/**
 * Simple AFINN-165 sentiment scorer for headlines.
 * Returns a score normalized to [-1, +1].
 */
export class SentimentScorer {
  private lexicon: Record<string, number>;

  constructor() {
    this.lexicon = afinn165;
  }

  /**
   * Score a headline string. Returns [-1, +1] where:
   *  -1 = very negative, 0 = neutral, +1 = very positive
   */
  score(text: string): number {
    if (!text) return 0;

    const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    let total = 0;
    let scored = 0;

    for (const word of words) {
      const val = this.lexicon[word];
      if (val !== undefined) {
        total += val;
        scored++;
      }
    }

    if (scored === 0) return 0;

    // AFINN scores range -5 to +5 per word. Normalize by dividing by
    // max possible magnitude (5 * scored words) and clamp to [-1, 1]
    const normalized = total / (5 * scored);
    return Math.max(-1, Math.min(1, normalized));
  }
}
