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

  async execute(intent: OrderIntent, dryRunOverride?: boolean): Promise<OrderResult> {
    const isDryRun = dryRunOverride ?? this.dryRun;

    try {
      // Apply slippage to price
      let adjustedPrice = intent.price;
      if (intent.side === 'BUY') {
        adjustedPrice = Math.min(intent.price + this.maxSlippage, 0.99);
      } else {
        adjustedPrice = Math.max(intent.price - this.maxSlippage, 0.01);
      }

      const orderParams = {
        tokenID: intent.tokenId,
        side: intent.side,
        price: adjustedPrice,
        size: intent.size,
      };

      logger.info({ orderParams, dryRun: isDryRun, originalPrice: intent.price }, 'Building CLOB order');

      const signedOrder = await this.client.createOrder(orderParams);

      if (isDryRun) {
        logger.info({ signedOrder }, 'DRY RUN — order signed but not submitted');
        return { success: true, dryRun: true, orderId: signedOrder.id };
      }

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
