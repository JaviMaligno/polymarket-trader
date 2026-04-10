import { pino } from 'pino';

const logger = pino({ name: 'budget-tracker' });

const HAIKU_INPUT_COST = 0.25e-6;
const HAIKU_OUTPUT_COST = 1.25e-6;

export class BudgetTracker {
  private spentUSD = 0;
  private lastResetDate: string;
  private limitUSD: number;

  constructor(limitUSD?: number) {
    this.limitUSD = limitUSD ?? parseFloat(process.env.LLM_DAILY_BUDGET_USD || '1.0');
    this.lastResetDate = new Date().toISOString().slice(0, 10);
  }

  canSpend(): boolean {
    this.resetIfNewDay();
    return this.spentUSD < this.limitUSD;
  }

  record(inputTokens: number, outputTokens: number): void {
    const cost = inputTokens * HAIKU_INPUT_COST + outputTokens * HAIKU_OUTPUT_COST;
    this.spentUSD += cost;
    logger.debug({ inputTokens, outputTokens, cost, totalSpent: this.spentUSD, limit: this.limitUSD }, 'LLM cost recorded');
  }

  getSpentUSD(): number {
    return this.spentUSD;
  }

  resetIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      logger.info({ previousSpend: this.spentUSD, date: this.lastResetDate }, 'Daily budget reset');
      this.spentUSD = 0;
      this.lastResetDate = today;
    }
  }
}
