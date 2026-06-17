import { pino } from 'pino';

const logger = pino({ name: 'mm-live-wallet' });

export class WalletBalance {
  private balance = 0;
  private seen = false;
  constructor(
    private readonly get: () => Promise<number>,
    private readonly minThreshold: number,
  ) {}

  async refresh(): Promise<void> {
    try {
      this.balance = await this.get();
      this.seen = true;
    } catch (err) {
      logger.warn({ err, cached: this.balance }, 'balance USDC: lectura falló, retengo el último');
    }
  }

  cached(): number { return this.balance }
  /** Solo es "low" una vez que hemos visto al menos una lectura real. */
  isLow(): boolean { return this.seen && this.balance < this.minThreshold }
}
