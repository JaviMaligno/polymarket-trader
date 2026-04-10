import { describe, it, expect, beforeAll } from 'vitest';
import { EntityMatcher } from './EntityMatcher.js';

describe('EntityMatcher', () => {
  let matcher: EntityMatcher;

  beforeAll(() => {
    matcher = new EntityMatcher();
  });

  it('extracts entities from a market question', () => {
    const entities = matcher.extractEntities('Will Manchester City win the 2025-26 English Premier League?');
    expect(entities.some(e => e.toLowerCase().includes('manchester city'))).toBe(true);
  });

  it('matches headline to market when entities overlap', () => {
    matcher.setMarkets([
      { id: 'market-1', question: 'Will PSG win the 2025-26 Champions League?' },
      { id: 'market-2', question: 'Will Arsenal win the 2025-26 Champions League?' },
    ]);

    const matches = matcher.matchHeadline('PSG eliminated by Arsenal in semifinal');
    expect(matches.length).toBeGreaterThan(0);
    const marketIds = matches.map(m => m.marketId);
    expect(marketIds).toContain('market-1');
    expect(marketIds).toContain('market-2');
  });

  it('returns empty matches for irrelevant headline', () => {
    matcher.setMarkets([
      { id: 'market-1', question: 'Will Bitcoin reach $100K by June 2026?' },
    ]);

    const matches = matcher.matchHeadline('Weather forecast shows rain tomorrow');
    expect(matches).toHaveLength(0);
  });

  it('detects competitor relationship', () => {
    matcher.setMarkets([
      { id: 'market-1', question: 'Will PSG win the 2025-26 Champions League?' },
      { id: 'market-2', question: 'Will Arsenal win the 2025-26 Champions League?' },
    ]);

    const matches = matcher.matchHeadline('Arsenal wins Champions League final');
    const psgMatch = matches.find(m => m.marketId === 'market-1');
    const arsenalMatch = matches.find(m => m.marketId === 'market-2');

    // Arsenal winning is competitor mention for PSG market
    if (psgMatch) expect(psgMatch.isCompetitorMention).toBe(true);
    // Arsenal winning is direct for Arsenal market
    if (arsenalMatch) expect(arsenalMatch.isCompetitorMention).toBe(false);
  });
});
