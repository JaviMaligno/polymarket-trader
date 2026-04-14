import Anthropic from '@anthropic-ai/sdk';
import { query, isDatabaseConfigured } from '../database/index.js';

export type MarketType = 'crypto_intraday' | 'crypto_daily' | 'event_financial' | 'event_short' | 'event_long';

const VALID_TYPES: MarketType[] = ['crypto_intraday', 'crypto_daily', 'event_financial', 'event_short', 'event_long'];

const CLASSIFICATION_PROMPT = `Classify this prediction market into exactly one category.
Categories: crypto_intraday, crypto_daily, event_financial, event_short, event_long

Market: "{question}"
End date: {end_date}

Rules:
- crypto_intraday: cryptocurrency price markets resolving within 4 hours
- crypto_daily: cryptocurrency markets resolving in 4 hours to 7 days
- event_financial: markets with a continuously-priced financial underlying (commodities like WTI crude oil, gold, silver; stocks, S&P 500, Nasdaq, indices; Fed rates, interest rates, inflation; forex pairs). NOT crypto.
- event_short: non-financial, non-crypto events resolving within 30 days (politics, sports, news, entertainment)
- event_long: non-financial, non-crypto events resolving in 30+ days

Respond with ONLY the category name, nothing else.`;

export class MarketClassifier {
  private client: Anthropic | null = null;
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    } else {
      console.warn('[MarketClassifier] No ANTHROPIC_API_KEY set - using regex fallback only');
    }
  }

  /**
   * Start periodic classification of unclassified markets
   */
  start(intervalMs: number = 30 * 60 * 1000): void {
    if (this.intervalId) return;

    console.log(`[MarketClassifier] Started (interval: ${intervalMs / 60000}min)`);

    // Run immediately, then on interval
    this.classifyPendingMarkets().catch(err =>
      console.error('[MarketClassifier] Initial classification failed:', err)
    );

    this.intervalId = setInterval(() => {
      this.classifyPendingMarkets().catch(err =>
        console.error('[MarketClassifier] Classification cycle failed:', err)
      );
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[MarketClassifier] Stopped');
    }
  }

  /**
   * Classify all markets that don't have a market_type yet
   */
  async classifyPendingMarkets(): Promise<number> {
    if (!isDatabaseConfigured()) return 0;

    const result = await query<{
      id: string;
      question: string;
      end_date: Date | null;
    }>(`
      SELECT id, question, end_date
      FROM markets
      WHERE market_type IS NULL
        AND is_active = true
        AND is_resolved = false
      LIMIT 50
    `);

    if (result.rows.length === 0) return 0;

    let classified = 0;
    for (const market of result.rows) {
      try {
        const marketType = await this.classifyMarket(market.question, market.end_date);
        await query(
          'UPDATE markets SET market_type = $1, updated_at = NOW() WHERE id = $2',
          [marketType, market.id]
        );
        classified++;
      } catch (error) {
        console.error(`[MarketClassifier] Failed to classify ${market.id}:`, error);
      }
    }

    if (classified > 0) {
      console.log(`[MarketClassifier] Classified ${classified}/${result.rows.length} markets`);
    }

    return classified;
  }

  /**
   * Classify a single market using Haiku, with regex fallback
   */
  async classifyMarket(question: string, endDate: Date | null): Promise<MarketType> {
    // Try Haiku first
    if (this.client) {
      try {
        return await this.classifyWithHaiku(question, endDate);
      } catch (error) {
        console.warn('[MarketClassifier] Haiku failed, using regex fallback:', error);
      }
    }

    // Regex fallback
    return this.classifyWithRegex(question, endDate);
  }

  private async classifyWithHaiku(question: string, endDate: Date | null): Promise<MarketType> {
    const endDateStr = endDate ? endDate.toISOString().split('T')[0] : 'unknown';
    const prompt = CLASSIFICATION_PROMPT
      .replace('{question}', question)
      .replace('{end_date}', endDateStr);

    const response = await this.client!.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text'
      ? response.content[0].text.trim().toLowerCase()
      : '';

    if (VALID_TYPES.includes(text as MarketType)) {
      // Sanity-check Haiku: if it labels as crypto but the question contains no
      // crypto keyword, override to event_*. Haiku has been observed to mislabel
      // sports/politics markets ("Will Canada win the 2026 FIFA World Cup?") as
      // crypto_daily, which would let the execution gate trade them as crypto.
      if ((text === 'crypto_intraday' || text === 'crypto_daily') && !this.questionLooksCryptoPriceMarket(question)) {
        const fallback = this.classifyWithRegex(question, endDate);
        console.warn(`[MarketClassifier] Haiku said "${text}" but question does not look like a crypto price market, overriding to ${fallback}: "${question.slice(0, 60)}"`);
        return fallback;
      }
      // Same sanity check for event_financial — ensure it has a financial keyword.
      if (text === 'event_financial' && !this.questionLooksFinancial(question)) {
        const fallback = this.classifyWithRegex(question, endDate);
        console.warn(`[MarketClassifier] Haiku said "event_financial" but question lacks financial keyword, overriding to ${fallback}: "${question.slice(0, 60)}"`);
        return fallback;
      }
      // Inverse check: if Haiku says event_short/event_long but question contains
      // financial keywords (Fed, WTI, S&P), override to event_financial. Haiku often
      // puts commodities/rates markets in event_* because they are "events" in a
      // loose sense.
      if ((text === 'event_short' || text === 'event_long') && this.questionLooksFinancial(question)) {
        console.warn(`[MarketClassifier] Haiku said "${text}" but question looks financial, overriding to event_financial: "${question.slice(0, 60)}"`);
        return 'event_financial';
      }
      return text as MarketType;
    }

    // If Haiku returned something unexpected, fallback to regex
    console.warn(`[MarketClassifier] Haiku returned unexpected: "${text}", using regex`);
    return this.classifyWithRegex(question, endDate);
  }

  /**
   * Strict crypto-keyword check using word boundaries.
   * Used to validate Haiku's "crypto_*" classifications against false positives.
   */
  private questionMentionsCrypto(question: string): boolean {
    const fullWords = /\b(bitcoin|ethereum|solana|cardano|dogecoin|cryptocurrency|crypto|microstrategy|megaeth|satoshi|coinbase|binance|chainlink|polkadot|stellar|monero|polygon|ripple|fdv|stablecoin)\b/i;
    const tickers = /\b(btc|eth|xrp|ada|doge|bnb|sol|usdt|usdc)\b/i;
    return fullWords.test(question) || tickers.test(question);
  }

  /**
   * Crypto markets are only treated as crypto_* when they look like price
   * questions. Crypto ecosystem events (airdrops, launches, FDV, listings)
   * should be classified as event_* so the crypto execution gate stays focused
   * on markets the strategy is actually designed to trade.
   */
  private questionLooksCryptoPriceMarket(question: string): boolean {
    if (!this.questionMentionsCrypto(question)) return false;

    const explicitEventPatterns = /\b(airdrop|launch(?:es|ed|ing)?|mainnet|testnet|listing|list(?:ed|ing)?|points|campaign|fdv|fully diluted|market cap|governance|proposal|vote|partnership|token generation|tge|unlock|vesting)\b/i;
    if (explicitEventPatterns.test(question)) return false;

    const pricePatterns = [
      /\bprice of\b/i,
      /\b(up or down|all time high|ath)\b/i,
      /\b(above|below|greater than|less than|over|under|between|exceed(?:s|ed)?|reach(?:es|ed)?|hit(?:s|ting)?)\b.*\$/i,
      /\$\s*\d/,
    ];

    return pricePatterns.some(pattern => pattern.test(question));
  }

  /**
   * Keyword check for financial markets with continuous underlying.
   * Covers commodities, equities/indices, rates, and forex.
   */
  private questionLooksFinancial(question: string): boolean {
    const commodities = /\b(crude oil|wti|brent|natural gas|gold|silver|copper|platinum|palladium|gasoline)\b/i;
    const equitiesIndices = /\b(s&p ?500|sp500|nasdaq|dow jones|djia|russell|ftse|dax|nikkei|hang seng|vix|stock market|stocks)\b/i;
    const rates = /\b(fed|federal reserve|fomc|interest rate|rate cut|rate hike|rate decision|basis points|\d+ ?bps|inflation|cpi|ppi|pce|jobs report|nfp|unemployment rate|gdp|recession)\b/i;
    const forex = /\b(eur\/usd|usd\/jpy|gbp\/usd|usd\/cny|dxy|dollar index)\b/i;
    return commodities.test(question) || equitiesIndices.test(question) || rates.test(question) || forex.test(question);
  }

  /**
   * Simple regex-based classification as fallback.
   * Priority: crypto > financial > event_{long,short}.
   */
  classifyWithRegex(question: string, endDate: Date | null): MarketType {
    const q = question.toLowerCase();
    const isCrypto = this.questionLooksCryptoPriceMarket(question);
    const isUpDown = /up or down|price.*above|reach.*\$|dip to|hit.*\$/i.test(q);

    if (isCrypto) {
      if (endDate) {
        const hoursUntilEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);
        if (hoursUntilEnd <= 4 || isUpDown) return 'crypto_intraday';
        if (hoursUntilEnd <= 7 * 24) return 'crypto_daily';
      }
      return isUpDown ? 'crypto_intraday' : 'crypto_daily';
    }

    if (this.questionLooksFinancial(question)) {
      return 'event_financial';
    }

    if (endDate) {
      const daysUntilEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilEnd >= 30) return 'event_long';
    }

    return 'event_short';
  }
}
