import { pino } from 'pino';
import type { Side } from '../types.js';

const logger = pino({ name: 'mm-live-gateway' });

export interface ClobClientLike {
  createOrder(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  postOrder(signed: unknown, options?: Record<string, unknown>): Promise<{ orderID?: string }>;
  cancelOrder(args: { orderID: string }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
  getOrder(args: { orderID: string }): Promise<{ size_matched?: number } | null>;
}

export interface GatewayConfig { ttlMs: number }

export interface LiveFill {
  time: Date; orderId: string; tokenId: string; side: Side;
  fillPrice: number; fillSize: number;
}

export interface OpenOrder {
  orderId: string; tokenId: string; side: Side; price: number; size: number;
  placedAt: Date; ttlExpiresAt: Date; matched: number;
  queueInitial?: number; // v1: unset (filled by a later follow-up from book level size); engine defaults to 0
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
    // `signed` es opaco (tipo unknown) hasta confirmar la API real del clob-client en el smoke de capacidad.
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
    // Idempotente: cancelar un id desconocido (ya retirado / nunca emitido) no llega al exchange.
    if (!this.open.has(orderId)) return;
    try {
      await this.client.cancelOrder({ orderID: orderId });
    } finally {
      // Dead-man's switch: siempre soltamos el slot localmente. Si el cancel falló, la
      // expiración GTD es la red de seguridad; retener el id bloquearía el re-quote del slot.
      this.open.delete(orderId);
    }
  }

  async cancelAll(): Promise<void> {
    // Operación de alto impacto (boot / SIGTERM / kill-switch): dejar rastro en logs.
    logger.info({ open: this.open.size }, 'cancelAll');
    await this.client.cancelAll();
    this.open.clear();
  }

  async replace(oldId: string, tokenId: string, side: Side, price: number, size: number): Promise<string | null> {
    await this.cancel(oldId);
    return this.postLimit(tokenId, side, price, size);
  }

  /** Cancela localmente (y en el exchange) las órdenes cuyo TTL ya pasó. */
  async expireDue(): Promise<void> {
    const now = this.now().getTime();
    for (const o of [...this.open.values()]) {
      if (o.ttlExpiresAt.getTime() <= now) {
        await this.cancel(o.orderId).catch(() => this.open.delete(o.orderId));
      }
    }
  }

  /** Poll del estado de cada orden abierta; emite el delta de size_matched como fill.
   *  Acumulable: solo el incremento desde el último poll. Orden 100% llena → se cierra. */
  async pollFills(): Promise<LiveFill[]> {
    const out: LiveFill[] = [];
    for (const o of [...this.open.values()]) {
      const st = await this.client.getOrder({ orderID: o.orderId }).catch(() => null);
      if (!st) continue;
      const matched = st.size_matched ?? 0;
      const delta = matched - o.matched;
      if (delta > 0) {
        out.push({ time: this.now(), orderId: o.orderId, tokenId: o.tokenId, side: o.side, fillPrice: o.price, fillSize: delta });
        o.matched = matched;
      }
      if (matched >= o.size - 1e-9) this.open.delete(o.orderId);
    }
    return out;
  }

  openOrderIds(): string[] { return [...this.open.keys()] }
  getOpen(orderId: string): OpenOrder | undefined { return this.open.get(orderId) }
  openOrders(): OpenOrder[] { return [...this.open.values()] }
}
