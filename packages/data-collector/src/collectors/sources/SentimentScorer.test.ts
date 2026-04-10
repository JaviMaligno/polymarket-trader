import { describe, it, expect } from 'vitest';
import { SentimentScorer } from './SentimentScorer.js';

describe('SentimentScorer', () => {
  const scorer = new SentimentScorer();

  it('scores clearly positive headline', () => {
    const score = scorer.score('Manchester City wins Premier League title');
    expect(score).toBeGreaterThan(0);
  });

  it('scores clearly negative headline', () => {
    const score = scorer.score('PSG suffer heavy defeat in Champions League loss');
    expect(score).toBeLessThan(0);
  });

  it('returns 0 for neutral headline', () => {
    const score = scorer.score('Match scheduled for Tuesday at 8pm');
    expect(score).toBe(0);
  });

  it('normalizes score to [-1, 1] range', () => {
    const score = scorer.score('Amazing wonderful fantastic brilliant superb excellent great');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('handles empty string', () => {
    expect(scorer.score('')).toBe(0);
  });
});
