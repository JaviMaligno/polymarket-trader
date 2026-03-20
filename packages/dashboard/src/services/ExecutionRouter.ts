import pino from 'pino';
import type { OrderIntent, OrderResult } from './RealExecutor.js';

const logger = pino({ name: 'ExecutionRouter' });

export type ExecutionMode = 'real' | 'paper' | 'dry_run';

export interface ExecutionResult {
  execution_mode: ExecutionMode;
  realOrderResult?: OrderResult;
}

interface TradingModeConfig {
  real_trading_enabled: boolean;
  real_trading_dry_run: boolean;
  min_balance_threshold: number;
}

interface ExecutionRouterDeps {
  realExecutor: { execute: (intent: OrderIntent, dryRun?: boolean) => Promise<OrderResult> };
  getCachedBalance: () => number;
  getConfig: () => Promise<TradingModeConfig>;
  notify: (type: string, payload: Record<string, unknown>) => Promise<void>;
}

export class ExecutionRouter {
  constructor(private readonly deps: ExecutionRouterDeps) {}

  async getMode(): Promise<ExecutionMode> {
    return this.resolveMode();
  }

  async execute(intent: OrderIntent): Promise<ExecutionResult> {
    const mode = await this.resolveMode();

    if (mode === 'paper') {
      return { execution_mode: 'paper' };
    }

    // Both 'real' and 'dry_run' go through the real executor
    // Pass dryRun=true when mode is 'dry_run' so the executor respects current config
    const result = await this.deps.realExecutor.execute(intent, mode === 'dry_run');

    if (!result.success) {
      logger.warn({ error: result.error, intent }, 'Real execution failed, falling back to paper');
      await this.deps.notify('error', {
        message: `Real order failed: ${result.error}. Trade recorded as paper.`,
      });
      return { execution_mode: 'paper', realOrderResult: result };
    }

    logger.info({ mode, orderId: result.orderId }, 'Real execution succeeded');
    return {
      execution_mode: mode === 'dry_run' ? 'dry_run' : 'real',
      realOrderResult: result,
    };
  }

  private async resolveMode(): Promise<ExecutionMode> {
    try {
      const config = await this.deps.getConfig();

      if (!config.real_trading_enabled) return 'paper';

      const balance = this.deps.getCachedBalance();
      if (balance < config.min_balance_threshold) return 'paper';

      if (config.real_trading_dry_run) return 'dry_run';

      return 'real';
    } catch (err) {
      logger.error({ err }, 'Failed to resolve execution mode, defaulting to paper');
      return 'paper';
    }
  }
}

let instance: ExecutionRouter | null = null;

export function setExecutionRouter(router: ExecutionRouter): void {
  instance = router;
}

export function getExecutionRouter(): ExecutionRouter | null {
  return instance;
}
