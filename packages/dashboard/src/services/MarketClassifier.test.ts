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
  });
});
