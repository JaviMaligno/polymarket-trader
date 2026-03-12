import { pino } from 'pino';

const logger = pino({ name: 'google-trends-source' });

export interface TrendsData {
  keyword: string;
  interest: number;   // 0-100 relative interest
  baseline: number;   // 30-day rolling average
  fetchedAt: Date;
}

const STOP_WORDS = new Set([
  'will', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'by', 'for',
  'is', 'be', 'or', 'and', 'this', 'that', 'it', 'with', 'from', 'as', 'has', 'have',
  'before', 'after', 'win', 'yes', 'no', 'does', 'do', 'can', 'who', 'what', 'when',
  'which', 'how', 'its', 'not',
]);

export class GoogleTrendsSource {
  private dailyRequestCount = 0;
  private readonly dailyLimit = 60;
  private lastResetDate: string = new Date().toDateString();

  extractKeywords(question: string): string[] {
    const cleaned = question.replace(/[?.,!'"]/g, '');
    const tokens = cleaned.split(/\s+/);
    const filtered = tokens.filter(
      (token) => token.length > 2 && !STOP_WORDS.has(token.toLowerCase()),
    );
    // Sort by length descending, return first 3
    filtered.sort((a, b) => b.length - a.length);
    return filtered.slice(0, 3);
  }

  async fetchInterest(keywords: string[]): Promise<TrendsData[]> {
    this.resetIfNewDay();

    if (this.dailyRequestCount >= this.dailyLimit) {
      logger.warn('Daily request limit reached');
      return [];
    }

    // Skeleton — Google Trends API is unofficial and needs separate investigation
    const results: TrendsData[] = keywords.map((keyword) => ({
      keyword,
      interest: 0,
      baseline: 0,
      fetchedAt: new Date(),
    }));

    this.dailyRequestCount += keywords.length;
    return results;
  }

  getRemainingRequests(): number {
    this.resetIfNewDay();
    return this.dailyLimit - this.dailyRequestCount;
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRequestCount = 0;
      this.lastResetDate = today;
    }
  }
}
