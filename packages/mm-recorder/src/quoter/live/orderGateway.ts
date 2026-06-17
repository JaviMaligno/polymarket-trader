import { pino } from 'pino';
import type { Side } from '../types.js';

const logger = pino({ name: 'mm-live-gateway' });

export interface ClobClientLike {
  createOrder(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  postOrder(signed: unknown, options?: Record<string, unknown>): Promise<{ orderID?: string }>;
  cancelOrder(args: { orderID: string }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
}

export interface GatewayConfig { ttlMs: number }

export interface OpenOrder {
  orderId: string; tokenId: string; side: Side; price: number; size: number;
  placedAt: Date; ttlExpiresAt: Date; matched: number;
}

const sideToClob = (s: Side): 'BUY' | 'SELL' => (s === -1 ? 'BUY' : 'SELL');

export class OrderGateway {
  private open = new Map<string, OpenOrder>();
  constructor(
    private readonly client: ClobClientLike,
    private readonly cfg: GatewayConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async postLimit(tokenId: string, side: Side, price: number, size: number): Promise<string | null> {
    const placedAt = this.now();
    const ttlExpiresAt = new Date(placedAt.getTime() + this.cfg.ttlMs);
    // GTD: orden con expiración (dead-man's switch). El campo exacto de expiración
    // del clob-client se confirma en el smoke de capacidad (deploy); aquí pasamos
    // expiration en segundos epoch, que es la convención del client.
    const signed = await this.client.createOrder(
      { tokenID: tokenId, side: sideToClob(side), price, size },
      { orderType: 'GTD', expiration: Math.floor(ttlExpiresAt.getTime() / 1000) },
    );
    const res = await this.client.postOrder(signed, { orderType: 'GTD' });
    const orderId = res.orderID;
    if (!orderId) { logger.warn({ tokenId, side }, 'postOrder sin orderID'); return null; }
    this.open.set(orderId, { orderId, tokenId, side, price, size, placedAt, ttlExpiresAt, matched: 0 });
    return orderId;
  }

  async cancel(orderId: string): Promise<void> {
    await this.client.cancelOrder({ orderID: orderId });
    this.open.delete(orderId);
  }

  async cancelAll(): Promise<void> {
    await this.client.cancelAll();
    this.open.clear();
  }

  openOrderIds(): string[] { return [...this.open.keys()] }
  getOpen(orderId: string): OpenOrder | undefined { return this.open.get(orderId) }
  openOrders(): OpenOrder[] { return [...this.open.values()] }
}
