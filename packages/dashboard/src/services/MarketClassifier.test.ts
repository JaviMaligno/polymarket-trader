import { describe, expect, it } from 'vitest';
import { MarketClassifier } from './MarketClassifier.js';

describe('MarketClassifier', () => {
  describe('classifyWithRegex', () => {
    const classifier = new MarketClassifier();
    const shortEndDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const longEndDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    it('does not classify Canada sports markets as crypto from substring matches', () => {
      expect(
        classifier.classifyWithRegex('Will Canada win the 2026 FIFA World Cup?', shortEndDate)
      ).toBe('event_short');
    });

    it('does not classify Hegseth politics markets as crypto from substring matches', () => {
      expect(
        classifier.classifyWithRegex('Will Pete Hegseth resign this month?', shortEndDate)
      ).toBe('event_short');
    });

    it('keeps crypto price markets classified as crypto', () => {
      expect(
        classifier.classifyWithRegex('Will Ethereum exceed $4,000 this week?', shortEndDate)
      ).toBe('crypto_daily');
    });

    it('classifies crypto ecosystem launch markets as events, not crypto', () => {
      expect(
        classifier.classifyWithRegex('Will MegaETH launch a token by May 31, 2026?', longEndDate)
      ).toBe('event_long');
    });

    it('classifies airdrop markets as events, not crypto', () => {
      expect(
        classifier.classifyWithRegex('Will MegaETH perform an airdrop by June 30?', shortEndDate)
      ).toBe('event_short');
    });

    it('classifies FDV post-launch markets as events, not crypto', () => {
      expect(
        classifier.classifyWithRegex('MegaETH market cap (FDV) >$3B one day after launch?', shortEndDate)
      ).toBe('event_short');
    });

    it('classifies S&P 500 markets as event_financial', () => {
      expect(
        classifier.classifyWithRegex('S&P 500 (SPX) Opens Up or Down on April 7?', shortEndDate)
      ).toBe('event_financial');
    });

    it('classifies sports markets as event_short (never NULL)', () => {
      expect(
        classifier.classifyWithRegex('Counter-Strike: FOKUS vs BC.Game Esports (BO3)', shortEndDate)
      ).toBe('event_short');
    });

    it('returns event_short as last-resort default (never NULL)', () => {
      // Question with no keywords at all, no end date → still returns a type
      expect(classifier.classifyWithRegex('Opaque question with no hints', null)).toBe('event_short');
    });

    it('routes year-horizon binary crypto markets to event_long, not crypto_intraday', () => {
      // Real example from 2026-05-12: end_date 2027-01-01, "dip to" phrasing.
      // Pre-fix would have matched isUpDown and returned crypto_intraday despite
      // the year-horizon end_date.
      const yearOut = new Date(Date.now() + 230 * 24 * 60 * 60 * 1000); // ~2027-01
      expect(
        classifier.classifyWithRegex('Will Bitcoin dip to $55,000 by Dec 31, 2026?', yearOut)
      ).toBe('event_long');
    });

    it('routes "hit $X by <far date>" crypto markets to event_long', () => {
      const yearOut = new Date(Date.now() + 230 * 24 * 60 * 60 * 1000);
      expect(
        classifier.classifyWithRegex('Will Bitcoin hit $150k by June 30, 2026?', yearOut)
      ).toBe('event_long');
    });

    it('keeps crypto markets at <= 4h horizon as crypto_intraday', () => {
      const threeHours = new Date(Date.now() + 3 * 60 * 60 * 1000);
      expect(
        classifier.classifyWithRegex('Will Bitcoin reach $100k in the next 3 hours?', threeHours)
      ).toBe('crypto_intraday');
    });
  });
});
