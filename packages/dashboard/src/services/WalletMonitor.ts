import pino from 'pino';

const logger = pino({ name: 'WalletMonitor' });

export interface WalletMonitorConfig {
  getUSDCBalance: () => Promise<number>;
  notify: (type: string, payload: Record<string, unknown>) => Promise<void>;
  setRealTradingEnabled: (enabled: boolean) => Promise<void>;
  minBalanceThreshold: number;
  warningThreshold: number;
  checkIntervalMs?: number;
}

export class WalletMonitor {
  private cachedBalance = 0;
  private lastWarningAt = 0;
  private lastLowAt = 0;
  private lastCheckedAt: Date | null = null;
  private readonly warningCooldownMs = 30 * 60 * 1000; // 30 min
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: WalletMonitorConfig) {}

  getCachedBalance(): number {
    return this.cachedBalance;
  }

  getLastCheckedAt(): Date | null {
    return this.lastCheckedAt;
  }

  async check(): Promise<void> {
    try {
      this.cachedBalance = await this.config.getUSDCBalance();
      this.lastCheckedAt = new Date();
    } catch (err) {
      logger.error({ err }, 'Failed to check USDC balance');
      logger.warn({ cachedBalance: this.cachedBalance }, 'Retaining last known balance after RPC error');
      return;
    }

    const now = Date.now();

    if (this.cachedBalance < this.config.minBalanceThreshold) {
      if (now - this.lastLowAt > this.warningCooldownMs) {
        await this.config.setRealTradingEnabled(false);
        await this.config.notify('funds_low', {
          balance: this.cachedBalance,
          threshold: this.config.minBalanceThreshold,
        });
        this.lastLowAt = now;
      }
      return;
    }

    if (this.cachedBalance < this.config.warningThreshold) {
      if (now - this.lastWarningAt > this.warningCooldownMs) {
        await this.config.notify('funds_warning', {
          balance: this.cachedBalance,
          threshold: this.config.warningThreshold,
        });
        this.lastWarningAt = now;
      }
    }
  }

  start(): void {
    const intervalMs = this.config.checkIntervalMs ?? 5 * 60 * 1000;
    logger.info({ intervalMs }, 'WalletMonitor started');
    this.intervalHandle = setInterval(() => this.check(), intervalMs);
    this.check().catch(() => {});
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

let walletMonitorInstance: WalletMonitor | null = null;

export function setWalletMonitor(monitor: WalletMonitor): void {
  walletMonitorInstance = monitor;
}

export function getWalletMonitor(): WalletMonitor | null {
  return walletMonitorInstance;
}
