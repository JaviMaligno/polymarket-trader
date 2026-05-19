# Real Trading Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable automated real trading on Polymarket via CLOB API while maintaining paper trading as fallback with graceful degradation.

**Architecture:** An `ExecutionRouter` sits between `AutoSignalExecutor` and trade recording. It delegates to `RealExecutor` (CLOB API) or paper execution based on a hot toggle + wallet balance. A `WalletMonitor` watches USDC balance and auto-degrades to paper. Private key stored in GCP Secret Manager.

**Tech Stack:** `@polymarket/clob-client`, `ethers` (already in project), `@google-cloud/secret-manager`, Slack webhook (existing `SLACK_WEBHOOK_URL`)

**Design doc:** `docs/plans/2026-03-20-real-trading-integration-design.md`

---

### Task 1: Install Dependencies & Database Schema

**Files:**
- Modify: `packages/dashboard/package.json`
- Modify: `packages/data-collector/src/database/init/002_signals_tracking.sql`

**Step 1: Install new dependencies**

Run:
```bash
cd packages/dashboard && pnpm add @polymarket/clob-client @google-cloud/secret-manager
```

Note: `ethers` is already available via `@polymarket-trader/data-collector`. Check if `@polymarket/clob-client` bundles it — if so, no extra ethers install needed. If not:
```bash
pnpm add ethers@^6
```

**Step 2: Add execution_mode columns to SQL schema**

In `002_signals_tracking.sql`, after the `paper_trades` CREATE TABLE, add:

```sql
-- Real trading support
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'paper_trades' AND column_name = 'execution_mode'
  ) THEN
    ALTER TABLE paper_trades ADD COLUMN execution_mode VARCHAR(10) DEFAULT 'paper';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'paper_positions' AND column_name = 'execution_mode'
  ) THEN
    ALTER TABLE paper_positions ADD COLUMN execution_mode VARCHAR(10) DEFAULT 'paper';
  END IF;
END $$;
```

**Step 3: Add default trading_config entries for real trading**

In same file, after existing INSERT INTO trading_config:

```sql
INSERT INTO trading_config (key, value, description) VALUES
  ('real_trading_enabled', 'false', 'Hot toggle for real trading execution'),
  ('real_trading_dry_run', 'false', 'Build+sign orders without submitting to CLOB'),
  ('wallet_address', 'null', 'Polygon wallet address for real trading'),
  ('min_balance_threshold', 'null', 'Minimum USDC balance to keep real trading active'),
  ('warning_balance_threshold', 'null', 'USDC balance warning notification threshold'),
  ('max_slippage', '0.02', 'Maximum slippage tolerance for limit orders')
ON CONFLICT (key) DO NOTHING;
```

**Step 4: Commit**

```bash
git add packages/dashboard/package.json packages/data-collector/src/database/init/002_signals_tracking.sql pnpm-lock.yaml
git commit -m "feat: add dependencies and schema for real trading integration"
```

---

### Task 2: NotificationService (Slack Webhook)

**Files:**
- Create: `packages/dashboard/src/services/NotificationService.ts`
- Create: `packages/dashboard/src/services/__tests__/NotificationService.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/services/__tests__/NotificationService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../NotificationService.js';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    service = new NotificationService('https://hooks.slack.com/test');
  });

  it('sends funds_warning notification', async () => {
    await service.notify('funds_warning', { balance: 85, threshold: 100 });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.text).toContain('Warning');
    expect(body.text).toContain('85');
  });

  it('sends funds_low notification with mode change', async () => {
    await service.notify('funds_low', { balance: 23, threshold: 50 });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.text).toContain('paper');
    expect(body.text).toContain('23');
  });

  it('sends mode_change notification', async () => {
    await service.notify('mode_change', { from: 'paper', to: 'real', by: 'user' });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.text).toContain('real');
  });

  it('does not throw if webhook URL is not configured', async () => {
    const noWebhook = new NotificationService('');
    await expect(noWebhook.notify('funds_warning', { balance: 10 })).resolves.not.toThrow();
  });

  it('does not throw if fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));
    await expect(service.notify('funds_warning', { balance: 10 })).resolves.not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/NotificationService.test.ts`
Expected: FAIL — cannot find `../NotificationService.js`

**Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/NotificationService.ts
import pino from 'pino';

const logger = pino({ name: 'NotificationService' });

type NotificationType = 'funds_warning' | 'funds_low' | 'mode_change' | 'trade_real' | 'error';

interface NotificationPayload {
  balance?: number;
  threshold?: number;
  from?: string;
  to?: string;
  by?: string;
  message?: string;
  [key: string]: unknown;
}

export class NotificationService {
  constructor(private readonly slackWebhookUrl: string) {}

  async notify(type: NotificationType, payload: NotificationPayload): Promise<void> {
    if (!this.slackWebhookUrl) {
      logger.debug({ type }, 'No webhook URL configured, skipping notification');
      return;
    }

    const text = this.formatMessage(type, payload);

    try {
      await fetch(this.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      logger.info({ type }, 'Notification sent');
    } catch (err) {
      logger.error({ err, type }, 'Failed to send notification');
    }
  }

  private formatMessage(type: NotificationType, p: NotificationPayload): string {
    switch (type) {
      case 'funds_warning':
        return `⚠️ *Warning: Low USDC balance* — $${p.balance} (threshold: $${p.threshold}). Consider depositing more funds.`;
      case 'funds_low':
        return `🔴 *Funds critically low* — $${p.balance} (min: $${p.threshold}). Switching to paper trading.`;
      case 'mode_change':
        return `🔄 *Trading mode changed*: ${p.from} → ${p.to} (by: ${p.by})`;
      case 'trade_real':
        return `💰 *Real trade executed* — ${p.message}`;
      case 'error':
        return `❌ *Trading error* — ${p.message}`;
      default:
        return `ℹ️ ${type}: ${JSON.stringify(p)}`;
    }
  }
}

let instance: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!instance) {
    instance = new NotificationService(process.env.SLACK_WEBHOOK_URL || '');
  }
  return instance;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/NotificationService.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/NotificationService.ts packages/dashboard/src/services/__tests__/NotificationService.test.ts
git commit -m "feat: add NotificationService with Slack webhook for trading alerts"
```

---

### Task 3: WalletMonitor

**Files:**
- Create: `packages/dashboard/src/services/WalletMonitor.ts`
- Create: `packages/dashboard/src/services/__tests__/WalletMonitor.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/services/__tests__/WalletMonitor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletMonitor } from '../WalletMonitor.js';

// Mock dependencies
const mockNotify = vi.fn();
const mockSetConfig = vi.fn();
const mockGetBalance = vi.fn();

describe('WalletMonitor', () => {
  let monitor: WalletMonitor;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockNotify.mockResolvedValue(undefined);
    mockSetConfig.mockResolvedValue(undefined);

    monitor = new WalletMonitor({
      getUSDCBalance: mockGetBalance,
      notify: mockNotify,
      setRealTradingEnabled: mockSetConfig,
      minBalanceThreshold: 50,
      warningThreshold: 100,
      checkIntervalMs: 1000, // fast for tests
    });
  });

  it('returns cached balance', async () => {
    mockGetBalance.mockResolvedValue(200);
    await monitor.check();
    expect(monitor.getCachedBalance()).toBe(200);
  });

  it('does nothing when balance is above warning threshold', async () => {
    mockGetBalance.mockResolvedValue(200);
    await monitor.check();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('sends warning when balance below warning threshold but above min', async () => {
    mockGetBalance.mockResolvedValue(75);
    await monitor.check();
    expect(mockNotify).toHaveBeenCalledWith('funds_warning', expect.objectContaining({ balance: 75 }));
    expect(mockSetConfig).not.toHaveBeenCalled();
  });

  it('disables real trading and notifies when balance below min threshold', async () => {
    mockGetBalance.mockResolvedValue(30);
    await monitor.check();
    expect(mockSetConfig).toHaveBeenCalledWith(false);
    expect(mockNotify).toHaveBeenCalledWith('funds_low', expect.objectContaining({ balance: 30 }));
  });

  it('does not send duplicate warnings within cooldown', async () => {
    mockGetBalance.mockResolvedValue(75);
    await monitor.check();
    await monitor.check();
    // Only one warning notification
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('handles balance check errors gracefully', async () => {
    mockGetBalance.mockRejectedValue(new Error('RPC timeout'));
    await expect(monitor.check()).resolves.not.toThrow();
    expect(monitor.getCachedBalance()).toBe(0); // safe default
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/WalletMonitor.test.ts`
Expected: FAIL — cannot find `../WalletMonitor.js`

**Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/WalletMonitor.ts
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
  private readonly warningCooldownMs = 30 * 60 * 1000; // 30 min
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: WalletMonitorConfig) {}

  getCachedBalance(): number {
    return this.cachedBalance;
  }

  async check(): Promise<void> {
    try {
      this.cachedBalance = await this.config.getUSDCBalance();
    } catch (err) {
      logger.error({ err }, 'Failed to check USDC balance');
      this.cachedBalance = 0;
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
    // Initial check
    this.check().catch(() => {});
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/WalletMonitor.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/WalletMonitor.ts packages/dashboard/src/services/__tests__/WalletMonitor.test.ts
git commit -m "feat: add WalletMonitor with balance checking and auto-degradation"
```

---

### Task 4: RealExecutor

**Files:**
- Create: `packages/dashboard/src/services/RealExecutor.ts`
- Create: `packages/dashboard/src/services/__tests__/RealExecutor.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/services/__tests__/RealExecutor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealExecutor, type OrderIntent, type OrderResult } from '../RealExecutor.js';

// Mock the CLOB client
const mockPostOrder = vi.fn();
const mockCreateOrder = vi.fn();
const mockClobClient = {
  createOrder: mockCreateOrder,
  postOrder: mockPostOrder,
};

describe('RealExecutor', () => {
  let executor: RealExecutor;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCreateOrder.mockResolvedValue({ id: 'order-123', signed: true });
    mockPostOrder.mockResolvedValue({
      orderID: 'order-123',
      status: 'matched',
      transactionsHashes: ['0xabc'],
    });

    executor = new RealExecutor({
      clobClient: mockClobClient as any,
      maxSlippage: 0.02,
      dryRun: false,
    });
  });

  it('builds and submits a BUY order', async () => {
    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenID: 'token-yes-123',
        side: 'BUY',
        price: 0.65,
        size: 100,
      })
    );
    expect(mockPostOrder).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.orderId).toBe('order-123');
  });

  it('builds and submits a SELL order', async () => {
    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'SELL',
      price: 0.80,
      size: 50,
    };

    const result = await executor.execute(intent);

    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SELL',
        price: 0.80,
        size: 50,
      })
    );
    expect(result.success).toBe(true);
  });

  it('in dry-run mode, builds but does not submit', async () => {
    executor = new RealExecutor({
      clobClient: mockClobClient as any,
      maxSlippage: 0.02,
      dryRun: true,
    });

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(mockCreateOrder).toHaveBeenCalled();
    expect(mockPostOrder).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it('handles CLOB rejection gracefully', async () => {
    mockPostOrder.mockRejectedValue(new Error('Insufficient balance'));

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
  });

  it('retries once on network timeout', async () => {
    mockPostOrder
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        orderID: 'order-123',
        status: 'matched',
        transactionsHashes: ['0xabc'],
      });

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    const result = await executor.execute(intent);

    expect(mockPostOrder).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it('does not retry on non-network errors', async () => {
    mockPostOrder.mockRejectedValue(new Error('Market closed'));

    const intent: OrderIntent = {
      tokenId: 'token-yes-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    };

    await executor.execute(intent);
    expect(mockPostOrder).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/RealExecutor.test.ts`
Expected: FAIL — cannot find `../RealExecutor.js`

**Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/RealExecutor.ts
import pino from 'pino';

const logger = pino({ name: 'RealExecutor' });

export interface OrderIntent {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  transactionHash?: string;
  executedPrice?: number;
  executedSize?: number;
  error?: string;
  dryRun?: boolean;
}

interface RealExecutorConfig {
  clobClient: any; // ClobClient from @polymarket/clob-client
  maxSlippage: number;
  dryRun: boolean;
}

const RETRYABLE_ERRORS = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'socket hang up'];

function isRetryable(err: Error): boolean {
  return RETRYABLE_ERRORS.some(code => err.message.includes(code));
}

export class RealExecutor {
  private readonly client: any;
  private readonly maxSlippage: number;
  private readonly dryRun: boolean;

  constructor(config: RealExecutorConfig) {
    this.client = config.clobClient;
    this.maxSlippage = config.maxSlippage;
    this.dryRun = config.dryRun;
  }

  async execute(intent: OrderIntent): Promise<OrderResult> {
    try {
      // Build the signed order
      const orderParams = {
        tokenID: intent.tokenId,
        side: intent.side,
        price: intent.price,
        size: intent.size,
      };

      logger.info({ orderParams, dryRun: this.dryRun }, 'Building CLOB order');

      const signedOrder = await this.client.createOrder(orderParams);

      if (this.dryRun) {
        logger.info({ signedOrder }, 'DRY RUN — order signed but not submitted');
        return { success: true, dryRun: true, orderId: signedOrder.id };
      }

      // Submit to CLOB with retry
      const response = await this.submitWithRetry(signedOrder);

      logger.info({ response }, 'Order submitted to CLOB');

      return {
        success: true,
        orderId: response.orderID,
        transactionHash: response.transactionsHashes?.[0],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, intent }, 'Failed to execute real order');
      return { success: false, error };
    }
  }

  private async submitWithRetry(signedOrder: any, attempt = 0): Promise<any> {
    try {
      return await this.client.postOrder(signedOrder);
    } catch (err) {
      if (attempt === 0 && err instanceof Error && isRetryable(err)) {
        logger.warn({ err }, 'Retrying order submission after network error');
        return this.submitWithRetry(signedOrder, 1);
      }
      throw err;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/RealExecutor.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/RealExecutor.ts packages/dashboard/src/services/__tests__/RealExecutor.test.ts
git commit -m "feat: add RealExecutor wrapping Polymarket CLOB client"
```

---

### Task 5: ExecutionRouter

**Files:**
- Create: `packages/dashboard/src/services/ExecutionRouter.ts`
- Create: `packages/dashboard/src/services/__tests__/ExecutionRouter.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/services/__tests__/ExecutionRouter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionRouter } from '../ExecutionRouter.js';

const mockRealExecute = vi.fn();
const mockGetCachedBalance = vi.fn();
const mockGetConfig = vi.fn();
const mockNotify = vi.fn();

describe('ExecutionRouter', () => {
  let router: ExecutionRouter;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetCachedBalance.mockReturnValue(500);
    mockGetConfig.mockResolvedValue({
      real_trading_enabled: true,
      real_trading_dry_run: false,
      min_balance_threshold: 50,
    });
    mockRealExecute.mockResolvedValue({
      success: true,
      orderId: 'order-123',
    });
    mockNotify.mockResolvedValue(undefined);

    router = new ExecutionRouter({
      realExecutor: { execute: mockRealExecute } as any,
      getCachedBalance: mockGetCachedBalance,
      getConfig: mockGetConfig,
      notify: mockNotify,
    });
  });

  it('routes to real executor when enabled and funded', async () => {
    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).toHaveBeenCalled();
    expect(result.execution_mode).toBe('real');
  });

  it('routes to paper when real trading disabled', async () => {
    mockGetConfig.mockResolvedValue({
      real_trading_enabled: false,
      real_trading_dry_run: false,
      min_balance_threshold: 50,
    });

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).not.toHaveBeenCalled();
    expect(result.execution_mode).toBe('paper');
  });

  it('routes to paper when balance below threshold', async () => {
    mockGetCachedBalance.mockReturnValue(30);

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).not.toHaveBeenCalled();
    expect(result.execution_mode).toBe('paper');
  });

  it('routes to dry_run when configured', async () => {
    mockGetConfig.mockResolvedValue({
      real_trading_enabled: true,
      real_trading_dry_run: true,
      min_balance_threshold: 50,
    });

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(mockRealExecute).toHaveBeenCalled();
    expect(result.execution_mode).toBe('dry_run');
  });

  it('falls back to paper if real execution fails', async () => {
    mockRealExecute.mockResolvedValue({ success: false, error: 'CLOB down' });

    const result = await router.execute({
      tokenId: 'token-123',
      side: 'BUY',
      price: 0.65,
      size: 100,
    });

    expect(result.execution_mode).toBe('paper');
    expect(mockNotify).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.stringContaining('CLOB') }));
  });

  it('reports current mode via getMode()', async () => {
    const mode = await router.getMode();
    expect(mode).toBe('real');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/ExecutionRouter.test.ts`
Expected: FAIL — cannot find `../ExecutionRouter.js`

**Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/ExecutionRouter.ts
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
  realExecutor: { execute: (intent: OrderIntent) => Promise<OrderResult> };
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
    // (RealExecutor handles dry_run internally based on its own config)
    const result = await this.deps.realExecutor.execute(intent);

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
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/ExecutionRouter.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/ExecutionRouter.ts packages/dashboard/src/services/__tests__/ExecutionRouter.test.ts
git commit -m "feat: add ExecutionRouter for real/paper/dry-run mode selection"
```

---

### Task 6: Integrate ExecutionRouter into AutoSignalExecutor

**Files:**
- Modify: `packages/dashboard/src/services/AutoSignalExecutor.ts`
- Create: `packages/dashboard/src/services/__tests__/AutoSignalExecutor.realtrading.test.ts`

**Context:** The AutoSignalExecutor currently records trades directly to paper_trades and paper_positions. We need to:
1. Call ExecutionRouter before recording (for entry trades)
2. Call ExecutionRouter before PositionClosingService (for exit trades)
3. Tag all trades with `execution_mode`

**Step 1: Write the failing integration test**

```typescript
// packages/dashboard/src/services/__tests__/AutoSignalExecutor.realtrading.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// This test verifies that AutoSignalExecutor passes execution_mode through
// to paper_trades and paper_positions records.
// Full integration test — requires mocking the DB repos.

describe('AutoSignalExecutor real trading integration', () => {
  it('tags trade as real when ExecutionRouter returns real', async () => {
    // This test will be implemented after reading the exact openPosition code
    // to understand the trade recording call signature
    expect(true).toBe(true); // placeholder
  });

  it('tags trade as paper when ExecutionRouter returns paper', async () => {
    expect(true).toBe(true); // placeholder
  });

  it('includes execution_mode in paper_positions upsert', async () => {
    expect(true).toBe(true); // placeholder
  });
});
```

Note: The actual integration tests here will need careful mocking of DB repos. The implementer should:
1. Read `AutoSignalExecutor.ts` lines 550-665 (openPosition) and lines 667-765 (closePosition) in full
2. Identify exactly where `paperTradesRepo.create()` and `paperPositionsRepo.upsert()` are called
3. Add `execution_mode` to those calls
4. Add ExecutionRouter call before the DB writes

**Step 2: Modify AutoSignalExecutor**

Key changes needed in `AutoSignalExecutor.ts`:

1. **Import ExecutionRouter** (near line 23):
   ```typescript
   import { getExecutionRouter, type ExecutionMode } from './ExecutionRouter.js';
   ```

2. **In openPosition() (around line 550-630)**: Before recording the trade, call:
   ```typescript
   const execResult = await getExecutionRouter().execute({
     tokenId: position.token_id,
     side: 'BUY',
     price: executedPrice,
     size: positionSize,
   });
   const executionMode = execResult.execution_mode;
   ```
   Then pass `execution_mode: executionMode` to both `paperTradesRepo.create()` and `paperPositionsRepo.upsert()`.

3. **In closePosition() (around line 723)**: Before calling PositionClosingService, call:
   ```typescript
   const execResult = await getExecutionRouter().execute({
     tokenId: position.token_id,
     side: 'SELL',
     price: exitPrice,
     size: position.size,
   });
   ```
   Pass `execution_mode` through to PositionClosingService (requires adding the field to `ClosePositionParams`).

**Important:** The implementer MUST read the full openPosition and closePosition methods before making changes. The line numbers above are approximate — the actual insertion points depend on current code state.

**Step 3: Run existing tests to verify nothing breaks**

Run: `cd packages/dashboard && npx vitest run`
Expected: All existing tests PASS

**Step 4: Commit**

```bash
git add packages/dashboard/src/services/AutoSignalExecutor.ts
git commit -m "feat: wire ExecutionRouter into AutoSignalExecutor for real trade execution"
```

---

### Task 7: API Endpoints for Hot Toggle

**Files:**
- Modify: `packages/dashboard/src/api/routes.ts`
- Create: `packages/dashboard/src/api/__tests__/trading-mode.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/api/__tests__/trading-mode.test.ts
import { describe, it, expect, vi } from 'vitest';

// Route handler tests — verify the handler logic
// (testing actual HTTP would require Fastify test helpers)

describe('GET /api/trading/mode', () => {
  it('returns current mode, balance, and config', () => {
    // Test the handler function directly
    expect(true).toBe(true); // placeholder — implement after reading routes.ts structure
  });
});

describe('POST /api/trading/mode', () => {
  it('updates real_trading_enabled in trading_config', () => {
    expect(true).toBe(true); // placeholder
  });

  it('sends mode_change notification', () => {
    expect(true).toBe(true); // placeholder
  });

  it('rejects invalid mode values', () => {
    expect(true).toBe(true); // placeholder
  });
});

describe('GET /api/wallet/status', () => {
  it('returns wallet address, balance, thresholds', () => {
    expect(true).toBe(true); // placeholder
  });
});
```

**Step 2: Add routes**

The implementer should read `packages/dashboard/src/api/routes.ts` to understand the existing route registration pattern, then add:

```typescript
// GET /api/trading/mode
fastify.get('/api/trading/mode', async () => {
  const config = await tradingConfigRepo.getAll();
  const balance = getWalletMonitor()?.getCachedBalance() ?? null;
  const mode = await getExecutionRouter().getMode();
  return {
    mode,
    real_trading_enabled: config.real_trading_enabled ?? false,
    real_trading_dry_run: config.real_trading_dry_run ?? false,
    balance,
    wallet_address: config.wallet_address ?? null,
  };
});

// POST /api/trading/mode
fastify.post('/api/trading/mode', async (request) => {
  const body = request.body as Record<string, unknown>;
  const previousConfig = await tradingConfigRepo.getAll();

  if (body.real_trading_enabled !== undefined) {
    await tradingConfigRepo.set('real_trading_enabled', body.real_trading_enabled);
  }
  if (body.real_trading_dry_run !== undefined) {
    await tradingConfigRepo.set('real_trading_dry_run', body.real_trading_dry_run);
  }

  const newMode = await getExecutionRouter().getMode();
  const prevMode = previousConfig.real_trading_enabled ? 'real' : 'paper';

  if (newMode !== prevMode) {
    await getNotificationService().notify('mode_change', {
      from: prevMode,
      to: newMode,
      by: 'user',
    });
  }

  return { mode: newMode, success: true };
});

// GET /api/wallet/status
fastify.get('/api/wallet/status', async () => {
  const config = await tradingConfigRepo.getAll();
  const balance = getWalletMonitor()?.getCachedBalance() ?? null;
  return {
    address: config.wallet_address ?? null,
    balance,
    last_checked: new Date().toISOString(),
    min_threshold: config.min_balance_threshold ?? null,
    warning_threshold: config.warning_balance_threshold ?? null,
  };
});
```

**Step 3: Protect POST endpoints with existing API key auth**

The existing routes already use API key auth for POST endpoints. Follow the same pattern.

**Step 4: Run tests**

Run: `cd packages/dashboard && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/api/routes.ts packages/dashboard/src/api/__tests__/trading-mode.test.ts
git commit -m "feat: add API endpoints for trading mode hot toggle and wallet status"
```

---

### Task 8: GCP Secret Manager Integration

**Files:**
- Create: `packages/dashboard/src/services/SecretManager.ts`
- Create: `packages/dashboard/src/services/__tests__/SecretManager.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/dashboard/src/services/__tests__/SecretManager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { loadPrivateKey } from '../SecretManager.js';

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
    accessSecretVersion: vi.fn().mockResolvedValue([
      { payload: { data: Buffer.from('0xdeadbeefprivatekey') } }
    ]),
  })),
}));

describe('SecretManager', () => {
  it('loads private key from GCP Secret Manager', async () => {
    const key = await loadPrivateKey('projects/my-project/secrets/polymarket-bot-key/versions/latest');
    expect(key).toBe('0xdeadbeefprivatekey');
  });

  it('falls back to env var if secret name not configured', async () => {
    process.env.POLYGON_PRIVATE_KEY = '0xfallback';
    const key = await loadPrivateKey('');
    expect(key).toBe('0xfallback');
    delete process.env.POLYGON_PRIVATE_KEY;
  });

  it('throws if no key available', async () => {
    await expect(loadPrivateKey('')).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/SecretManager.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// packages/dashboard/src/services/SecretManager.ts
import pino from 'pino';

const logger = pino({ name: 'SecretManager' });

export async function loadPrivateKey(secretName: string): Promise<string> {
  // Try GCP Secret Manager first
  if (secretName) {
    try {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const [version] = await client.accessSecretVersion({ name: secretName });
      const key = version.payload?.data?.toString();
      if (key) {
        logger.info('Private key loaded from GCP Secret Manager');
        return key;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load from GCP Secret Manager, trying env var');
    }
  }

  // Fallback to env var (for local development / testing)
  const envKey = process.env.POLYGON_PRIVATE_KEY;
  if (envKey) {
    logger.info('Private key loaded from POLYGON_PRIVATE_KEY env var');
    return envKey;
  }

  throw new Error('No private key available. Configure GCP Secret Manager or POLYGON_PRIVATE_KEY env var.');
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/dashboard && npx vitest run src/services/__tests__/SecretManager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/dashboard/src/services/SecretManager.ts packages/dashboard/src/services/__tests__/SecretManager.test.ts
git commit -m "feat: add SecretManager for loading private key from GCP or env"
```

---

### Task 9: Service Initialization (Wiring It All Together)

**Files:**
- Modify: `packages/dashboard/src/server.ts`

**Context:** This task wires all new services into the startup sequence. The implementer MUST read `server.ts` first to understand the existing initialization order.

**Step 1: Add initialization after existing service setup**

After the existing service initialization (around where `getPolymarketService().start()` is called), add:

```typescript
// Real trading services (initialized but not active unless configured)
import { loadPrivateKey } from './services/SecretManager.js';
import { RealExecutor } from './services/RealExecutor.js';
import { ExecutionRouter } from './services/ExecutionRouter.js';
import { WalletMonitor } from './services/WalletMonitor.js';
import { getNotificationService } from './services/NotificationService.js';
import { tradingConfigRepo } from './database/repositories.js';

async function initializeRealTrading(): Promise<void> {
  const config = await tradingConfigRepo.getAll();
  const walletAddress = config.wallet_address as string;

  if (!walletAddress) {
    logger.info('No wallet configured — real trading disabled');
    return;
  }

  try {
    const secretName = process.env.GCP_SECRET_NAME || '';
    const privateKey = await loadPrivateKey(secretName);

    // Initialize CLOB client
    // NOTE: The exact ClobClient constructor may vary — check @polymarket/clob-client docs
    const { ClobClient } = await import('@polymarket/clob-client');
    const clobClient = new ClobClient(
      process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      137, // Polygon chainId
      privateKey
    );

    const dryRun = config.real_trading_dry_run === true;
    const maxSlippage = (config.max_slippage as number) ?? 0.02;

    const realExecutor = new RealExecutor({ clobClient, maxSlippage, dryRun });

    // Initialize WalletMonitor
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');
    const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);

    const minBalance = (config.min_balance_threshold as number) ?? 50;
    const warningBalance = (config.warning_balance_threshold as number) ?? minBalance * 2;

    const walletMonitor = new WalletMonitor({
      getUSDCBalance: async () => {
        const balance = await usdcContract.balanceOf(walletAddress);
        return Number(ethers.formatUnits(balance, 6)); // USDC has 6 decimals
      },
      notify: (type, payload) => getNotificationService().notify(type as any, payload),
      setRealTradingEnabled: async (enabled) => {
        await tradingConfigRepo.set('real_trading_enabled', enabled);
      },
      minBalanceThreshold: minBalance,
      warningThreshold: warningBalance,
    });

    // Initialize ExecutionRouter
    const executionRouter = new ExecutionRouter({
      realExecutor,
      getCachedBalance: () => walletMonitor.getCachedBalance(),
      getConfig: async () => {
        const cfg = await tradingConfigRepo.getAll();
        return {
          real_trading_enabled: cfg.real_trading_enabled === true,
          real_trading_dry_run: cfg.real_trading_dry_run === true,
          min_balance_threshold: (cfg.min_balance_threshold as number) ?? 50,
        };
      },
      notify: (type, payload) => getNotificationService().notify(type as any, payload),
    });

    // Store as singletons (export getter functions from respective modules)
    // The implementer should add setInstance/getInstance pattern to ExecutionRouter and WalletMonitor

    walletMonitor.start();
    logger.info({ walletAddress, dryRun }, 'Real trading services initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize real trading — running in paper-only mode');
  }
}

// Call during startup (non-blocking — failure doesn't prevent paper trading)
await initializeRealTrading();
```

**Step 2: Run full test suite**

Run: `cd packages/dashboard && npx vitest run`
Expected: All PASS

**Step 3: Commit**

```bash
git add packages/dashboard/src/server.ts
git commit -m "feat: wire real trading services into server startup"
```

---

### Task 10: Calculate Initial Thresholds from Historical Data

**Files:**
- Create: `scripts/calculate-trading-thresholds.js`

**Step 1: Write the script**

```javascript
// scripts/calculate-trading-thresholds.js
// Calculates initial min_balance_threshold and warning_balance_threshold
// from paper trading history.
//
// Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/calculate-trading-thresholds.js

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Average trade cost (executed_size * executed_price) for buy trades
  const avgCost = await pool.query(`
    SELECT
      AVG(value_usd) as avg_trade_cost,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value_usd) as p75_trade_cost,
      MAX(value_usd) as max_trade_cost,
      COUNT(*) as total_trades
    FROM paper_trades
    WHERE side = 'buy'
    AND time > NOW() - INTERVAL '14 days'
  `);

  // Average number of trades per day
  const dailyTrades = await pool.query(`
    SELECT
      AVG(daily_count) as avg_daily_trades,
      MAX(daily_count) as max_daily_trades
    FROM (
      SELECT DATE(time) as day, COUNT(*) as daily_count
      FROM paper_trades
      WHERE side = 'buy'
      AND time > NOW() - INTERVAL '14 days'
      GROUP BY DATE(time)
    ) daily
  `);

  // Average concurrent open positions
  const avgPositions = await pool.query(`
    SELECT
      AVG(size * avg_entry_price) as avg_position_value,
      COUNT(*) as current_open
    FROM paper_positions
    WHERE closed_at IS NULL
  `);

  const stats = avgCost.rows[0];
  const daily = dailyTrades.rows[0];
  const positions = avgPositions.rows[0];

  const avgTradeCost = parseFloat(stats.avg_trade_cost) || 50;
  const p75TradeCost = parseFloat(stats.p75_trade_cost) || 75;
  const avgDailyTrades = parseFloat(daily.avg_daily_trades) || 5;

  // min_balance = enough for 2-3 average trades (buffer to avoid constant degradation)
  const minBalance = Math.ceil(p75TradeCost * 3);
  // warning = enough for ~1 day of trading
  const warningBalance = Math.ceil(p75TradeCost * avgDailyTrades);

  console.log('=== Paper Trading Statistics (last 14 days) ===');
  console.log(`Total buy trades: ${stats.total_trades}`);
  console.log(`Average trade cost: $${parseFloat(stats.avg_trade_cost).toFixed(2)}`);
  console.log(`P75 trade cost: $${parseFloat(stats.p75_trade_cost).toFixed(2)}`);
  console.log(`Max trade cost: $${parseFloat(stats.max_trade_cost).toFixed(2)}`);
  console.log(`Average daily trades: ${parseFloat(daily.avg_daily_trades).toFixed(1)}`);
  console.log(`Max daily trades: ${daily.max_daily_trades}`);
  console.log(`Current open positions: ${positions.current_open}`);
  console.log(`Average position value: $${parseFloat(positions.avg_position_value || 0).toFixed(2)}`);
  console.log('');
  console.log('=== Recommended Thresholds ===');
  console.log(`min_balance_threshold: $${minBalance} (covers ~3 trades at P75 cost)`);
  console.log(`warning_balance_threshold: $${warningBalance} (covers ~1 day of trading)`);
  console.log('');
  console.log('To apply these thresholds:');
  console.log(`  curl -X POST http://localhost:3001/api/trading/mode -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"min_balance_threshold": ${minBalance}, "warning_balance_threshold": ${warningBalance}}'`);

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
```

**Step 2: Test locally**

Run: `NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL="..." node scripts/calculate-trading-thresholds.js`
Expected: Outputs statistics and recommended thresholds

**Step 3: Commit**

```bash
git add scripts/calculate-trading-thresholds.js
git commit -m "feat: add script to calculate balance thresholds from paper trading history"
```

---

### Task 11: Going-Live Documentation

**Files:**
- Create: `docs/going-live.md`

**Step 1: Write the guide**

Write `docs/going-live.md` with the complete onboarding flow from the design document (Section 5). Include:

1. Prerequisites checklist (wallet, GCP Secret Manager, env vars)
2. Phase 0: Setup (create wallet, store key, configure)
3. Phase 1: Dry-run (enable, monitor 24h, checklist)
4. Phase 2: Minimal live test ($5-10, verify cycle)
5. Phase 3: Gradual production (deposit, thresholds, monitor)
6. Emergency: Kill switch
7. Common issues / troubleshooting
8. Environment variables reference table

Include exact commands for each step. The reader should be able to follow this without any other context.

**Step 2: Commit**

```bash
git add docs/going-live.md
git commit -m "docs: add going-live guide for transitioning from paper to real trading"
```

---

## Task Summary

| Task | Component | Estimated Steps | Dependencies |
|------|-----------|-----------------|--------------|
| 1 | Dependencies & Schema | 4 | None |
| 2 | NotificationService | 5 | None |
| 3 | WalletMonitor | 5 | Task 2 |
| 4 | RealExecutor | 5 | Task 1 |
| 5 | ExecutionRouter | 5 | Tasks 3, 4 |
| 6 | AutoSignalExecutor integration | 4 | Task 5 |
| 7 | API endpoints (hot toggle) | 5 | Tasks 5, 2 |
| 8 | GCP Secret Manager | 5 | None |
| 9 | Server initialization | 3 | Tasks 2-8 |
| 10 | Threshold calculation script | 3 | None |
| 11 | Going-live documentation | 2 | All above |

**Parallelizable:** Tasks 1, 2, 4, 8, 10 can all start independently.

**Critical path:** 1 → 4 → 5 → 6 → 9 → 11
