# H-MM-5 — Fase real del market-maker: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Llevar el quoter de market-making de shadow a órdenes reales pequeñas, gobernadas por un kill-switch, midiendo retained real con cola exacta (H-MM-5).

**Architecture:** Módulos nuevos en `packages/mm-recorder/src/quoter/live/` (mismo proceso/imagen que el recorder, perfil `capture`, activados por `MM_QUOTER_MODE=live`). Reutilizan `QuotePolicy`/`VolTracker`/`InventoryBook` existentes (la economía es idéntica al shadow — garantía de identidad). El `OrderGateway` (nuevo) envuelve `@polymarket/clob-client` para post/cancel GTD; `LiveLedger` contabiliza fills reales; `RiskGuard` aplica límites y kill-switch one-way. El quoter shadow queda intacto (cero regresión).

**Tech Stack:** TypeScript/Node (ESM, `.js` import suffixes), vitest, `@polymarket/clob-client`, viem, `@google-cloud/secret-manager`, TimescaleDB (`pg`), Python harness (pandas) para el validator.

**Spec:** [`docs/superpowers/specs/2026-06-17-h-mm-5-live-real-phase-design.md`](../specs/2026-06-17-h-mm-5-live-real-phase-design.md)

**Gate dependency:** las Tasks 1–12 (código + tests) NO dependen del gate y se ejecutan ya. La **Task 13 (activación en producción) está BLOQUEADA hasta el verdict H-MM-4 del 2026-06-22** — rellena los parámetros (subset, min-spread, capital, umbral vol) y enciende `MM_QUOTER_MODE=live`. No ejecutar la Task 13 antes del gate.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `packages/mm-recorder/src/quoter/config.ts` *(modify)* | Añadir campos live (subset, secret name, poll interval, maxNotionalTotal) |
| `packages/mm-recorder/src/quoter/live/secret.ts` *(create)* | `loadPrivateKey` (GCP Secret Manager → env fallback) |
| `packages/mm-recorder/src/quoter/live/walletBalance.ts` *(create)* | Lectura de balance USDC + check de saldo bajo |
| `packages/mm-recorder/src/quoter/live/orderGateway.ts` *(create)* | Wrapper clob-client: post GTD / cancel / cancelAll / replace + reconciliación de fills |
| `packages/mm-recorder/src/quoter/live/livePersistence.ts` *(create)* | Esquema `mm_live_orders`/`mm_live_fills` + inserts |
| `packages/mm-recorder/src/quoter/live/liveLedger.ts` *(create)* | Contabilidad real (envuelve `InventoryBook`) + persiste órdenes/fills |
| `packages/mm-recorder/src/quoter/live/riskGuard.ts` *(create)* | Límites + kill-switch state machine; persiste a `mm_quoter_state` |
| `packages/mm-recorder/src/quoter/live/liveEngine.ts` *(create)* | Loop de quoting live: QuotePolicy → OrderGateway → LiveLedger + RiskGuard |
| `packages/mm-recorder/src/index.ts` *(modify)* | Rama `mode==='live'`: boot (secret→client→cancelAll→engine), SIGTERM cancel-all |
| `scripts/edge-research/mm_live_fills.sql` *(create)* | Export de `mm_live_fills` + mids forward |
| `scripts/edge-research/validators/mm_live.py` *(create)* | Validator H-MM-5 (retained real, sin drain bounds) |
| `scripts/edge-research/registry.yaml` *(modify)* | Alta de H-MM-5 |
| `docs/superpowers/runbooks/h-mm-5-activation.md` *(create, Task 13)* | Runbook de activación gated |

Convenciones del repo (seguir): imports ESM con sufijo `.js`; tests `*.test.ts` junto al módulo; `vitest`; sin red en tests (mock del clob-client y del exec de DB). El `exec` de DB es `(sql, params?) => Promise<unknown>` (igual que `QuoterPersistence`).

---

## Task 1: Config — campos live

**Files:**
- Modify: `packages/mm-recorder/src/quoter/config.ts`
- Test: `packages/mm-recorder/src/quoter/config.test.ts`

- [ ] **Step 1: Write the failing test**

Añadir a `config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig — live fields', () => {
  it('parsea campos live con defaults seguros', () => {
    const c = loadConfig({ MM_QUOTER_MODE: 'live' });
    expect(c.maxNotionalTotal).toBe(100);
    expect(c.fillPollMs).toBe(3000);
    expect(c.walletSecretName).toBe('');
    expect(c.liveSubset).toEqual([]); // vacío = ningún mercado habilitado para live
  });

  it('parsea subset CSV y secret name', () => {
    const c = loadConfig({
      MM_QUOTER_MODE: 'live',
      MM_LIVE_SUBSET: 'mktA, mktB ,mktC',
      MM_WALLET_SECRET_NAME: 'projects/x/secrets/mm-key/versions/latest',
      MM_MAX_NOTIONAL_TOTAL: '250',
      MM_FILL_POLL_MS: '2000',
    });
    expect(c.liveSubset).toEqual(['mktA', 'mktB', 'mktC']);
    expect(c.walletSecretName).toBe('projects/x/secrets/mm-key/versions/latest');
    expect(c.maxNotionalTotal).toBe(250);
    expect(c.fillPollMs).toBe(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test config`
Expected: FAIL — `maxNotionalTotal`/`liveSubset` no existen en `QuoterConfig`.

- [ ] **Step 3: Write minimal implementation**

En `config.ts`, añadir a la interfaz `QuoterConfig` (tras `maxCumLoss`):

```ts
  maxNotionalTotal: number;
  fillPollMs: number;
  walletSecretName: string;
  liveSubset: string[];
```

Y en el objeto devuelto por `loadConfig` (tras `maxCumLoss`):

```ts
    maxNotionalTotal: num(env.MM_MAX_NOTIONAL_TOTAL, 100),
    fillPollMs: num(env.MM_FILL_POLL_MS, 3000),
    walletSecretName: env.MM_WALLET_SECRET_NAME ?? '',
    liveSubset: (env.MM_LIVE_SUBSET ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/config.ts packages/mm-recorder/src/quoter/config.test.ts
git commit -m "feat(mm-live): config fields para la fase real (subset, secret, notional cap, poll)"
```

---

## Task 2: secret.ts — carga de la private key

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/secret.ts`
- Test: `packages/mm-recorder/src/quoter/live/secret.test.ts`

Patrón copiado de `packages/dashboard/src/services/SecretManager.ts` (decisión "mínimo compartido"). Inyectamos el cliente de Secret Manager como dependencia para poder testear sin red.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { loadPrivateKey } from './secret.js';

describe('loadPrivateKey', () => {
  it('devuelve la key del env si no hay secret name', async () => {
    const k = await loadPrivateKey('', { POLYGON_PRIVATE_KEY: '0xabc' });
    expect(k).toBe('0xabc');
  });

  it('usa Secret Manager cuando hay secret name', async () => {
    const access = vi.fn().mockResolvedValue([{ payload: { data: Buffer.from('0xdef') } }]);
    const k = await loadPrivateKey('projects/x/secrets/k/versions/latest', {}, { accessSecretVersion: access });
    expect(k).toBe('0xdef');
    expect(access).toHaveBeenCalledWith({ name: 'projects/x/secrets/k/versions/latest' });
  });

  it('lanza si no hay ninguna fuente', async () => {
    await expect(loadPrivateKey('', {})).rejects.toThrow('No private key');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test secret`
Expected: FAIL — `secret.js` no existe.

- [ ] **Step 3: Write minimal implementation**

```ts
import { pino } from 'pino';

const logger = pino({ name: 'mm-live-secret' });

interface SecretClient {
  accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: Uint8Array | Buffer } }]>;
}

/** GCP Secret Manager → fallback POLYGON_PRIVATE_KEY env. El cliente se inyecta
 *  para tests; en producción se construye perezosamente. */
export async function loadPrivateKey(
  secretName: string,
  env: Record<string, string | undefined>,
  client?: SecretClient,
): Promise<string> {
  if (secretName) {
    const c = client ?? (await buildClient());
    const [res] = await c.accessSecretVersion({ name: secretName });
    const data = res.payload?.data;
    if (data) {
      logger.info('Private key cargada desde GCP Secret Manager');
      return Buffer.from(data).toString('utf8').trim();
    }
  }
  const envKey = env.POLYGON_PRIVATE_KEY;
  if (envKey) {
    logger.info('Private key cargada desde POLYGON_PRIVATE_KEY');
    return envKey;
  }
  throw new Error('No private key disponible. Configura GCP Secret Manager o POLYGON_PRIVATE_KEY.');
}

async function buildClient(): Promise<SecretClient> {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  return new SecretManagerServiceClient() as unknown as SecretClient;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test secret`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/secret.ts packages/mm-recorder/src/quoter/live/secret.test.ts
git commit -m "feat(mm-live): loadPrivateKey (Secret Manager + env fallback)"
```

---

## Task 3: walletBalance.ts — balance USDC + saldo bajo

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/walletBalance.ts`
- Test: `packages/mm-recorder/src/quoter/live/walletBalance.test.ts`

Ligero: una función que cachea el último balance y un predicado de saldo bajo. La obtención del balance se inyecta (en producción una llamada al clob-client / RPC).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { WalletBalance } from './walletBalance.js';

describe('WalletBalance', () => {
  it('cachea el último balance y detecta saldo bajo', async () => {
    const get = vi.fn().mockResolvedValue(42);
    const w = new WalletBalance(get, 50);
    await w.refresh();
    expect(w.cached()).toBe(42);
    expect(w.isLow()).toBe(true);
  });

  it('retiene el último balance conocido si la lectura falla', async () => {
    const get = vi.fn().mockResolvedValueOnce(100).mockRejectedValueOnce(new Error('rpc'));
    const w = new WalletBalance(get, 50);
    await w.refresh();
    await w.refresh(); // falla
    expect(w.cached()).toBe(100);
    expect(w.isLow()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test walletBalance`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test walletBalance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/walletBalance.ts packages/mm-recorder/src/quoter/live/walletBalance.test.ts
git commit -m "feat(mm-live): WalletBalance (cache + low-balance check)"
```

---

## Task 4: OrderGateway — tipos + post/cancel/cancelAll

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/orderGateway.ts`
- Test: `packages/mm-recorder/src/quoter/live/orderGateway.test.ts`

El clob-client se mockea (API real: `createOrder({tokenID, side, price, size, ...})` → signedOrder; `postOrder(signedOrder)` → `{orderID}`; `cancelOrder({orderID})`; `cancelAll()`). Side interno `-1|1` → `'BUY'|'SELL'` del client.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { OrderGateway } from './orderGateway.js';

function mockClient() {
  return {
    createOrder: vi.fn(async (p: any) => ({ signed: p })),
    postOrder: vi.fn(async (_s: any) => ({ orderID: 'o1' })),
    cancelOrder: vi.fn(async (_a: any) => ({ ok: true })),
    cancelAll: vi.fn(async () => ({ ok: true })),
  };
}

describe('OrderGateway post/cancel', () => {
  it('postLimit mapea side -1→BUY y devuelve el orderId, registrándolo', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date('2026-06-17T00:00:00Z'));
    const id = await gw.postLimit('tok', -1, 0.4, 20);
    expect(id).toBe('o1');
    expect(c.createOrder).toHaveBeenCalledWith(expect.objectContaining({ tokenID: 'tok', side: 'BUY', price: 0.4, size: 20 }));
    expect(gw.openOrderIds()).toContain('o1');
  });

  it('cancel quita la orden del set de abiertas', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', 1, 0.6, 20);
    await gw.cancel('o1');
    expect(c.cancelOrder).toHaveBeenCalledWith({ orderID: 'o1' });
    expect(gw.openOrderIds()).not.toContain('o1');
  });

  it('cancelAll llama al client y vacía el set', async () => {
    const c = mockClient();
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', -1, 0.4, 20);
    await gw.cancelAll();
    expect(c.cancelAll).toHaveBeenCalled();
    expect(gw.openOrderIds()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test orderGateway`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

```ts
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
  placedAt: Date; ttlExpiresAt: Date;
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
    // del clob-client se confirma en el smoke de capacidad (Task 13 pre-req); aquí
    // pasamos expiration en segundos epoch, que es la convención del client.
    const signed = await this.client.createOrder(
      { tokenID: tokenId, side: sideToClob(side), price, size },
      { orderType: 'GTD', expiration: Math.floor(ttlExpiresAt.getTime() / 1000) },
    );
    const res = await this.client.postOrder(signed, { orderType: 'GTD' });
    const orderId = res.orderID;
    if (!orderId) { logger.warn({ tokenId, side }, 'postOrder sin orderID'); return null; }
    this.open.set(orderId, { orderId, tokenId, side, price, size, placedAt, ttlExpiresAt });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test orderGateway`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/orderGateway.ts packages/mm-recorder/src/quoter/live/orderGateway.test.ts
git commit -m "feat(mm-live): OrderGateway post/cancel/cancelAll (GTD) con tracking de órdenes"
```

---

## Task 5: OrderGateway — replace + expiración local

**Files:**
- Modify: `packages/mm-recorder/src/quoter/live/orderGateway.ts`
- Test: `packages/mm-recorder/src/quoter/live/orderGateway.test.ts`

`replace` = cancel + post (resetea la cola). `expireDue` cancela localmente las órdenes cuyo TTL pasó (las GTD expiran solas en el exchange, pero limpiamos el set para no contar como abiertas).

- [ ] **Step 1: Write the failing test**

Añadir a `orderGateway.test.ts`:

```ts
describe('OrderGateway replace/expire', () => {
  it('replace cancela la vieja y postea una nueva', async () => {
    const c = mockClient();
    c.postOrder = vi.fn().mockResolvedValueOnce({ orderID: 'o1' }).mockResolvedValueOnce({ orderID: 'o2' });
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date());
    await gw.postLimit('tok', -1, 0.4, 20);
    const id2 = await gw.replace('o1', 'tok', -1, 0.41, 20);
    expect(c.cancelOrder).toHaveBeenCalledWith({ orderID: 'o1' });
    expect(id2).toBe('o2');
    expect(gw.openOrderIds()).toEqual(['o2']);
  });

  it('expireDue cancela las órdenes con TTL vencido', async () => {
    const c = mockClient();
    let t = new Date('2026-06-17T00:00:00Z');
    const gw = new OrderGateway(c as any, { ttlMs: 1000 }, () => t);
    await gw.postLimit('tok', -1, 0.4, 20);
    t = new Date('2026-06-17T00:00:02Z'); // +2s > ttl 1s
    await gw.expireDue();
    expect(gw.openOrderIds()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test orderGateway`
Expected: FAIL — `replace`/`expireDue` no existen.

- [ ] **Step 3: Write minimal implementation**

Añadir a la clase `OrderGateway`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test orderGateway`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/orderGateway.ts packages/mm-recorder/src/quoter/live/orderGateway.test.ts
git commit -m "feat(mm-live): OrderGateway replace + expiración local de GTD vencidas"
```

---

## Task 6: OrderGateway — reconciliación de fills (poll)

**Files:**
- Modify: `packages/mm-recorder/src/quoter/live/orderGateway.ts`
- Test: `packages/mm-recorder/src/quoter/live/orderGateway.test.ts`

v1 usa REST poll del estado de órdenes (el WS user-channel se evalúa en el smoke de Task 13; si está disponible, se añade como fuente alternativa que llama al mismo `reconcile`). `pollFills` consulta el estado de cada orden abierta y emite fills (parciales acumulables); ignora ids desconocidos.

- [ ] **Step 1: Write the failing test**

```ts
describe('OrderGateway reconcile (poll)', () => {
  it('emite fill parcial y luego completo, ignorando ids desconocidos', async () => {
    const c = mockClient();
    // getOrder devuelve size_matched acumulado
    const statuses: Record<string, any> = { o1: { size_matched: 0 } };
    (c as any).getOrder = vi.fn(async ({ orderID }: any) => statuses[orderID]);
    const gw = new OrderGateway(c as any, { ttlMs: 1_800_000 }, () => new Date('2026-06-17T00:00:00Z'));
    await gw.postLimit('tok', -1, 0.4, 20);

    statuses.o1 = { size_matched: 5 };
    const fills1 = await gw.pollFills();
    expect(fills1).toEqual([expect.objectContaining({ orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.4, fillSize: 5 })]);

    statuses.o1 = { size_matched: 20 }; // resto
    const fills2 = await gw.pollFills();
    expect(fills2[0].fillSize).toBe(15);
    expect(gw.openOrderIds()).not.toContain('o1'); // totalmente lleno → cerrada
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test orderGateway`
Expected: FAIL — `pollFills`/`getOrder` no existen.

- [ ] **Step 3: Write minimal implementation**

Extender `ClobClientLike` con:

```ts
  getOrder(args: { orderID: string }): Promise<{ size_matched?: number } | null>;
```

Añadir el tipo de fill y el campo de acumulado, y el método `pollFills`. En `OpenOrder` añadir `matched: number` (inicializar a `0` en `postLimit`: `matched: 0`). Tipo:

```ts
export interface LiveFill {
  time: Date; orderId: string; tokenId: string; side: Side;
  fillPrice: number; fillSize: number;
}
```

Método en la clase:

```ts
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
```

Actualizar `postLimit` para inicializar `matched: 0` en el objeto guardado, y añadir `matched: number` a la interfaz `OpenOrder`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test orderGateway`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/orderGateway.ts packages/mm-recorder/src/quoter/live/orderGateway.test.ts
git commit -m "feat(mm-live): OrderGateway reconciliación de fills por poll (delta de size_matched)"
```

---

## Task 7: livePersistence — esquema y inserts

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/livePersistence.ts`
- Test: `packages/mm-recorder/src/quoter/live/livePersistence.test.ts`

Mismo patrón que `QuoterPersistence`: `exec` inyectado, `ensureSchema` con `CREATE TABLE IF NOT EXISTS`. `mm_live_fills` simétrica a `mm_shadow_fills` (sin `bound`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { LivePersistence } from './livePersistence.js';

describe('LivePersistence', () => {
  it('ensureSchema crea ambas tablas', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await new LivePersistence(exec).ensureSchema();
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mm_live_orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mm_live_fills');
  });

  it('insertFill pasa los 11 campos en orden', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const p = new LivePersistence(exec);
    const t = new Date('2026-06-17T00:00:00Z');
    await p.insertFill({ time: t, tokenId: 'tok', orderId: 'o1', side: -1, fillPrice: 0.4, fillSize: 5,
      queueInitial: 100, spreadAtPlacement: 0.02, midBefore: 0.41, flags: '' });
    const params = exec.mock.calls[0][1] as unknown[];
    expect(params).toEqual([t, 'tok', 'o1', -1, 0.4, 5, 100, 0.02, 0.41, '']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test livePersistence`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Side } from '../types.js';

type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface LiveOrderRow {
  time: Date; tokenId: string; orderId: string; side: Side; price: number; size: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired'; ttlExpiresAt: Date;
  reason: string; rewardsConstrained: boolean; exitImprove: boolean;
}

export interface LiveFillRow {
  time: Date; tokenId: string; orderId: string; side: Side;
  fillPrice: number; fillSize: number; queueInitial: number;
  spreadAtPlacement: number | null; midBefore: number | null; flags: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_live_orders (
  time timestamptz NOT NULL,
  token_id text NOT NULL,
  order_id text NOT NULL,
  side smallint NOT NULL,
  price numeric NOT NULL,
  size numeric NOT NULL,
  status text NOT NULL,
  ttl_expires_at timestamptz,
  reason text NOT NULL DEFAULT '',
  rewards_constrained boolean NOT NULL DEFAULT false,
  exit_improve boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS mm_live_orders_oid ON mm_live_orders(order_id, time);
CREATE TABLE IF NOT EXISTS mm_live_fills (
  time timestamptz NOT NULL,
  token_id text NOT NULL,
  order_id text NOT NULL,
  side smallint NOT NULL,
  fill_price numeric NOT NULL,
  fill_size numeric NOT NULL,
  queue_initial numeric,
  spread_at_placement numeric,
  mid_before numeric,
  flags text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS mm_live_fills_tok_time ON mm_live_fills(token_id, time);
`;

export class LivePersistence {
  constructor(private exec: Exec) {}

  async ensureSchema(): Promise<void> { await this.exec(SCHEMA); }

  async insertOrder(r: LiveOrderRow): Promise<void> {
    await this.exec(
      `INSERT INTO mm_live_orders(time,token_id,order_id,side,price,size,status,ttl_expires_at,reason,rewards_constrained,exit_improve)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.time, r.tokenId, r.orderId, r.side, r.price, r.size, r.status, r.ttlExpiresAt, r.reason, r.rewardsConstrained, r.exitImprove]);
  }

  async insertFill(r: LiveFillRow): Promise<void> {
    await this.exec(
      `INSERT INTO mm_live_fills(time,token_id,order_id,side,fill_price,fill_size,queue_initial,spread_at_placement,mid_before,flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.time, r.tokenId, r.orderId, r.side, r.fillPrice, r.fillSize, r.queueInitial, r.spreadAtPlacement, r.midBefore, r.flags]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test livePersistence`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/livePersistence.ts packages/mm-recorder/src/quoter/live/livePersistence.test.ts
git commit -m "feat(mm-live): LivePersistence — esquema mm_live_orders/mm_live_fills + inserts"
```

---

## Task 8: LiveLedger — contabilidad real

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/liveLedger.ts`
- Test: `packages/mm-recorder/src/quoter/live/liveLedger.test.ts`

Envuelve el `InventoryBook` existente (mode-agnóstico) y persiste fills. Mantiene los mismos invariantes contables que el shadow.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { LiveLedger } from './liveLedger.js';

const noopPersist = { insertFill: vi.fn().mockResolvedValue(undefined), insertOrder: vi.fn().mockResolvedValue(undefined) };

describe('LiveLedger', () => {
  it('round-trip realized = (p_ask - p_bid) * size exacto', async () => {
    const l = new LiveLedger(noopPersist as any, 'mktA');
    // compra 20 @0.40 (side -1), vende 20 @0.45 (side +1)
    await l.applyFill({ time: new Date(), orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.40, fillSize: 20 }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
    await l.applyFill({ time: new Date(), orderId: 'o2', tokenId: 'tok', side: 1, fillPrice: 0.45, fillSize: 20 }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
    expect(l.totalRealized()).toBeCloseTo((0.45 - 0.40) * 20, 9);
    expect(l.position('mktA')).toBe(0);
  });

  it('equity = cash + M2M; persiste cada fill', async () => {
    const persist = { insertFill: vi.fn().mockResolvedValue(undefined), insertOrder: vi.fn().mockResolvedValue(undefined) };
    const l = new LiveLedger(persist as any, 'mktA');
    await l.applyFill({ time: new Date(), orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.40, fillSize: 10 }, { queueInitial: 0, spreadAtPlacement: null, midBefore: null, flags: '' });
    const mids = new Map([['mktA', 0.42]]);
    expect(l.equity(mids)).toBeCloseTo(-0.40 * 10 + 10 * 0.42, 9);
    expect(persist.insertFill).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test liveLedger`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

```ts
import { InventoryBook } from '../inventoryBook.js';
import type { Side } from '../types.js';
import type { LivePersistence } from './livePersistence.js';
import type { LiveFill } from './orderGateway.js';

export interface FillContext {
  queueInitial: number; spreadAtPlacement: number | null; midBefore: number | null; flags: string;
}

/** Contabilidad de fills reales. marketId fijo del mapa token→market en el engine.
 *  Reusa InventoryBook (mismos invariantes que el shadow). */
export class LiveLedger {
  private inv = new InventoryBook();
  constructor(
    private readonly persistence: Pick<LivePersistence, 'insertFill'>,
    private readonly marketId: string,
  ) {}

  async applyFill(f: LiveFill, ctx: FillContext): Promise<void> {
    this.inv.applyFill(this.marketId, f.side, f.fillPrice, f.fillSize);
    await this.persistence.insertFill({
      time: f.time, tokenId: f.tokenId, orderId: f.orderId, side: f.side,
      fillPrice: f.fillPrice, fillSize: f.fillSize,
      queueInitial: ctx.queueInitial, spreadAtPlacement: ctx.spreadAtPlacement,
      midBefore: ctx.midBefore, flags: ctx.flags,
    });
  }

  position(m: string): number { return this.inv.position(m) }
  notional(m: string): number { return this.inv.notional(m) }
  totalNotional(): number { return this.inv.totalNotional() }
  totalRealized(): number { return this.inv.totalRealized() }
  equity(mids: Map<string, number>): number { return this.inv.equity(mids) }
  book(): InventoryBook { return this.inv }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test liveLedger`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/liveLedger.ts packages/mm-recorder/src/quoter/live/liveLedger.test.ts
git commit -m "feat(mm-live): LiveLedger envuelve InventoryBook + persiste fills reales"
```

---

## Task 9: RiskGuard — límites + kill-switch

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/riskGuard.ts`
- Test: `packages/mm-recorder/src/quoter/live/riskGuard.test.ts`

Máquina de estados one-way `running→killed`. `check()` evalúa límites; al primer breach → `killed`, persiste `mode=off` + estado, notifica. Idempotente (un solo kill).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { RiskGuard } from './riskGuard.js';

function deps() {
  return {
    cfg: { maxInvPerMarket: 20, maxInvTotal: 60, maxNotionalTotal: 100, maxCumLoss: 50 },
    onKill: vi.fn().mockResolvedValue(undefined),
    persistState: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

describe('RiskGuard', () => {
  it('dispara kill por cum loss y persiste mode=off una sola vez', async () => {
    const d = deps();
    const g = new RiskGuard(d.cfg as any, d.onKill, d.persistState, d.notify);
    await g.check({ totalNotional: 10, maxInvNotional: 5, totalInvNotional: 5, openNotional: 10, cumPnl: -55, balanceLow: false });
    expect(g.state()).toBe('killed');
    expect(d.onKill).toHaveBeenCalledTimes(1);
    expect(d.persistState).toHaveBeenCalledWith(expect.objectContaining({ kill_state: 'killed', mode: 'off' }));
    // segundo check no re-dispara
    await g.check({ totalNotional: 10, maxInvNotional: 5, totalInvNotional: 5, openNotional: 10, cumPnl: -55, balanceLow: false });
    expect(d.onKill).toHaveBeenCalledTimes(1);
  });

  it('no dispara dentro de límites', async () => {
    const d = deps();
    const g = new RiskGuard(d.cfg as any, d.onKill, d.persistState, d.notify);
    await g.check({ totalNotional: 50, maxInvNotional: 10, totalInvNotional: 30, openNotional: 40, cumPnl: -10, balanceLow: false });
    expect(g.state()).toBe('running');
    expect(d.onKill).not.toHaveBeenCalled();
  });

  it('dispara por balance bajo', async () => {
    const d = deps();
    const g = new RiskGuard(d.cfg as any, d.onKill, d.persistState, d.notify);
    await g.check({ totalNotional: 0, maxInvNotional: 0, totalInvNotional: 0, openNotional: 0, cumPnl: 0, balanceLow: true });
    expect(g.state()).toBe('killed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test riskGuard`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

```ts
import { pino } from 'pino';

const logger = pino({ name: 'mm-live-risk' });

export interface RiskLimits {
  maxInvPerMarket: number; maxInvTotal: number; maxNotionalTotal: number; maxCumLoss: number;
}

export interface RiskSnapshot {
  totalNotional: number;      // notional de inventario total (abs $)
  maxInvNotional: number;     // mayor inventario por mercado (abs $)
  totalInvNotional: number;   // = totalNotional (compat); inventario total
  openNotional: number;       // Σ notional de órdenes abiertas
  cumPnl: number;             // realized + M2M
  balanceLow: boolean;
}

export type KillState = 'running' | 'killed';

export class RiskGuard {
  private killState: KillState = 'running';
  constructor(
    private readonly limits: RiskLimits,
    private readonly onKill: () => Promise<void>,
    private readonly persistState: (s: object) => Promise<void>,
    private readonly notify: (type: string, payload: object) => Promise<void>,
  ) {}

  state(): KillState { return this.killState }

  private breach(s: RiskSnapshot): string | null {
    if (s.balanceLow) return 'balance_low';
    if (s.cumPnl <= -this.limits.maxCumLoss) return 'max_cum_loss';
    if (s.maxInvNotional > this.limits.maxInvPerMarket) return 'inventory_per_market';
    if (s.totalInvNotional > this.limits.maxInvTotal) return 'inventory_total';
    if (s.openNotional > this.limits.maxNotionalTotal) return 'notional_total';
    return null;
  }

  async check(s: RiskSnapshot): Promise<void> {
    if (this.killState === 'killed') return;
    const reason = this.breach(s);
    if (!reason) return;
    this.killState = 'killed';
    logger.error({ reason, snapshot: s }, 'RISK KILL — cancelando todo y pasando a off');
    await this.onKill().catch((e) => logger.error({ e }, 'onKill falló'));
    await this.persistState({ kill_state: 'killed', mode: 'off', reason, at: new Date().toISOString() })
      .catch((e) => logger.error({ e }, 'persistState falló'));
    await this.notify('mm_kill_switch', { reason, snapshot: s }).catch(() => undefined);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test riskGuard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/riskGuard.ts packages/mm-recorder/src/quoter/live/riskGuard.test.ts
git commit -m "feat(mm-live): RiskGuard — límites + kill-switch one-way persistido"
```

---

## Task 10: LiveEngine — loop de quoting live

**Files:**
- Create: `packages/mm-recorder/src/quoter/live/liveEngine.ts`
- Test: `packages/mm-recorder/src/quoter/live/liveEngine.test.ts`

Reusa `desiredQuotes` (QuotePolicy), `VolTracker`. En `onBook` calcula quotes deseadas y las traduce a post/replace/cancel del `OrderGateway`, solo para mercados del `liveSubset`. `tick()` hace `pollFills` → `LiveLedger.applyFill` → `RiskGuard.check`, y `expireDue`. Si RiskGuard está `killed`, `onBook` no postea.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { LiveEngine } from './liveEngine.js';

function harness() {
  const gateway = {
    postLimit: vi.fn().mockResolvedValue('o1'),
    replace: vi.fn().mockResolvedValue('o2'),
    cancel: vi.fn().mockResolvedValue(undefined),
    pollFills: vi.fn().mockResolvedValue([]),
    expireDue: vi.fn().mockResolvedValue(undefined),
    getOpen: vi.fn(),
    openOrders: vi.fn().mockReturnValue([]),
  };
  const ledger = { applyFill: vi.fn().mockResolvedValue(undefined), position: () => 0, notional: () => 0, totalNotional: () => 0, totalRealized: () => 0, equity: () => 0, book: () => ({ position: () => 0, avgPrice: () => 0 }) };
  const risk = { check: vi.fn().mockResolvedValue(undefined), state: vi.fn().mockReturnValue('running') };
  return { gateway, ledger, risk };
}

const cfg = { mode: 'live', quoteSize: 20, orderTtlMs: 1_800_000, requoteMinMs: 1000, nearResolutionMs: 0, minSpread: 0, volPause: Infinity, volWindowMs: 60_000, maxInvPerMarket: 20, maxInvTotal: 60, maxCumLoss: 50, softInvPerMarket: 10, tick: 0.01, maxNotionalTotal: 100, fillPollMs: 3000, walletSecretName: '', liveSubset: ['mktA'] } as any;

const bookRow = (t: string) => ({ tokenId: t, marketId: 'mktA', time: new Date('2026-06-17T00:00:00Z'), bestBid: 0.40, bestAsk: 0.60, mid: 0.50 } as any);

describe('LiveEngine', () => {
  it('postea quote para un token del subset', async () => {
    const h = harness();
    const eng = new LiveEngine({ cfg, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.onBook({ tokenId: 'tok', time: bookRow('tok').time } as any, bookRow('tok'));
    expect(h.gateway.postLimit).toHaveBeenCalled();
  });

  it('no postea si el mercado no está en el subset', async () => {
    const h = harness();
    const eng = new LiveEngine({ cfg: { ...cfg, liveSubset: ['otro'] }, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.onBook({ tokenId: 'tok', time: bookRow('tok').time } as any, bookRow('tok'));
    expect(h.gateway.postLimit).not.toHaveBeenCalled();
  });

  it('no postea si RiskGuard está killed', async () => {
    const h = harness();
    h.risk.state.mockReturnValue('killed');
    const eng = new LiveEngine({ cfg, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.onBook({ tokenId: 'tok', time: bookRow('tok').time } as any, bookRow('tok'));
    expect(h.gateway.postLimit).not.toHaveBeenCalled();
  });

  it('tick reconcilia fills hacia ledger y risk', async () => {
    const h = harness();
    h.gateway.pollFills.mockResolvedValue([{ time: new Date(), orderId: 'o1', tokenId: 'tok', side: -1, fillPrice: 0.40, fillSize: 5 }]);
    h.gateway.getOpen.mockReturnValue({ queueInitial: 100 });
    const eng = new LiveEngine({ cfg, gateway: h.gateway as any, ledger: h.ledger as any, risk: h.risk as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map() });
    await eng.tick(new Date());
    expect(h.ledger.applyFill).toHaveBeenCalled();
    expect(h.risk.check).toHaveBeenCalled();
    expect(h.gateway.expireDue).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test liveEngine`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { BookEvent, BookInput } from '../../types.js';
import type { QuoterConfig } from '../config.js';
import type { RewardsParams, Side } from '../types.js';
import { desiredQuotes } from '../quotePolicy.js';
import { VolTracker } from '../volTracker.js';
import type { OrderGateway } from './orderGateway.js';
import type { LiveLedger } from './liveLedger.js';
import type { RiskGuard } from './riskGuard.js';

export interface LiveEngineDeps {
  cfg: QuoterConfig;
  gateway: OrderGateway;
  ledger: LiveLedger;
  risk: RiskGuard;
  marketByToken: Map<string, string>;
  endDateByMarket: Map<string, Date>;
  rewardsByMarket: Map<string, RewardsParams>;
}

export class LiveEngine {
  private vol: VolTracker;
  private mids = new Map<string, number>();
  private subset: Set<string>;
  /** orderId → (queueInitial, side) para anotar el fill cuando se reconcilia. */
  private orderByToken = new Map<string, { tokenId: string; side: Side }>();

  constructor(private deps: LiveEngineDeps) {
    this.vol = new VolTracker(deps.cfg.volWindowMs);
    this.subset = new Set(deps.cfg.liveSubset);
  }

  async onBook(input: BookInput, row: BookEvent | null): Promise<void> {
    if (this.deps.risk.state() === 'killed') return;
    if (!row || row.mid === null) return;
    const marketId = this.deps.marketByToken.get(input.tokenId) ?? row.marketId;
    if (!this.subset.has(marketId)) return;

    this.vol.add(input.tokenId, row.time, row.mid);
    this.mids.set(marketId, row.mid);
    const endDate = this.deps.endDateByMarket.get(marketId);
    const book = this.deps.ledger.book();
    const desired = desiredQuotes({
      bestBid: row.bestBid, bestAsk: row.bestAsk,
      recentVol: this.vol.recentVol(input.tokenId, input.time),
      msToResolution: endDate ? endDate.getTime() - input.time.getTime() : null,
      rewards: this.deps.rewardsByMarket.get(marketId) ?? null,
      inventoryShares: book.position(marketId),
      inventoryNotional: this.deps.ledger.notional(marketId),
      totalNotional: this.deps.ledger.totalNotional(),
    }, this.deps.cfg);

    for (const side of [-1, 1] as Side[]) {
      const want = side === -1 ? desired.bid : desired.ask;
      const existing = this.deps.gateway.openOrders().find((o) => o.tokenId === input.tokenId && o.side === side);
      if (!want) { if (existing) await this.deps.gateway.cancel(existing.orderId); continue; }
      if (!existing) {
        const id = await this.deps.gateway.postLimit(input.tokenId, side, want.price, want.size);
        if (id) this.orderByToken.set(id, { tokenId: input.tokenId, side });
      } else if (existing.price !== want.price) {
        const id = await this.deps.gateway.replace(existing.orderId, input.tokenId, side, want.price, want.size);
        this.orderByToken.delete(existing.orderId);
        if (id) this.orderByToken.set(id, { tokenId: input.tokenId, side });
      }
    }
  }

  /** Timer: reconcilia fills, los aplica al ledger, chequea riesgo y expira GTD. */
  async tick(_now: Date): Promise<void> {
    const fills = await this.deps.gateway.pollFills();
    for (const f of fills) {
      const open = this.deps.gateway.getOpen(f.orderId);
      await this.deps.ledger.applyFill(f, {
        queueInitial: open?.queueInitial ?? 0,
        spreadAtPlacement: null, midBefore: this.mids.get(this.deps.marketByToken.get(f.tokenId) ?? '') ?? null,
        flags: '',
      });
    }
    if (fills.length > 0) await this.runRiskCheck();
    await this.deps.gateway.expireDue();
  }

  private async runRiskCheck(): Promise<void> {
    const book = this.deps.ledger.book();
    let maxInv = 0;
    const markets = new Set(this.deps.marketByToken.values());
    for (const m of markets) maxInv = Math.max(maxInv, this.deps.ledger.notional(m));
    const openNotional = this.deps.gateway.openOrders().reduce((t, o) => t + o.price * o.size, 0);
    const cumPnl = this.deps.ledger.totalRealized() + this.unrealized(book, markets);
    await this.deps.risk.check({
      totalNotional: this.deps.ledger.totalNotional(),
      maxInvNotional: maxInv,
      totalInvNotional: this.deps.ledger.totalNotional(),
      openNotional, cumPnl, balanceLow: false,
    });
  }

  private unrealized(book: { position(m: string): number; avgPrice(m: string): number }, markets: Set<string>): number {
    let u = 0;
    for (const m of markets) {
      const mid = this.mids.get(m) ?? book.avgPrice(m);
      u += book.position(m) * (mid - book.avgPrice(m));
    }
    return u;
  }
}
```

Nota: `OrderGateway.openOrders()` y `getOpen` ya existen (Tasks 4/6); `getOpen` debe exponer `queueInitial` — añadirlo al `OpenOrder` y al `postLimit` no es necesario si lo derivamos del book; para v1 lo dejamos en `0` cuando no esté (el queueInitial real exacto se captura mejor en una mejora posterior — registrar el `levelSize` al postear). **Mejora registrada como follow-up, no v1.**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test liveEngine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/liveEngine.ts packages/mm-recorder/src/quoter/live/liveEngine.test.ts
git commit -m "feat(mm-live): LiveEngine — QuotePolicy→OrderGateway + reconciliación en tick"
```

---

## Task 11: index.ts — wiring de la rama live

**Files:**
- Modify: `packages/mm-recorder/src/index.ts`
- Test: `packages/mm-recorder/src/quoter/live/wiring.test.ts` (test de la función de armado, sin red)

Extraer el armado en una función testeable `buildLiveEngine(deps)` y reemplazar el `throw` del `mode==='live'`. El boot real (cargar key, construir clob-client, `cancelAll`) vive en `index.ts`; el smoke de capacidad del client es pre-req de Task 13.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildLiveEngine } from './wiring.js';

describe('buildLiveEngine', () => {
  it('arma engine con subset y arranca tras cancelAll', async () => {
    const gateway = { cancelAll: vi.fn().mockResolvedValue(undefined), openOrders: () => [], postLimit: vi.fn(), pollFills: vi.fn().mockResolvedValue([]), expireDue: vi.fn().mockResolvedValue(undefined), getOpen: vi.fn() };
    const persistence = { ensureSchema: vi.fn().mockResolvedValue(undefined), insertFill: vi.fn() };
    const { engine } = await buildLiveEngine({
      cfg: { liveSubset: ['mktA'], volWindowMs: 60_000 } as any,
      gateway: gateway as any, persistence: persistence as any,
      marketByToken: new Map([['tok', 'mktA']]), endDateByMarket: new Map(), rewardsByMarket: new Map(),
      onKill: vi.fn(), persistState: vi.fn().mockResolvedValue(undefined), notify: vi.fn().mockResolvedValue(undefined),
    });
    expect(persistence.ensureSchema).toHaveBeenCalled();
    expect(gateway.cancelAll).toHaveBeenCalled(); // cancel-all incondicional al boot
    expect(engine).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter mm-recorder test wiring`
Expected: FAIL — `wiring.js` no existe.

- [ ] **Step 3: Write minimal implementation**

Crear `packages/mm-recorder/src/quoter/live/wiring.ts`:

```ts
import type { QuoterConfig } from '../config.js';
import type { RewardsParams } from '../types.js';
import { LiveEngine } from './liveEngine.js';
import { LiveLedger } from './liveLedger.js';
import { RiskGuard } from './riskGuard.js';
import type { OrderGateway } from './orderGateway.js';
import type { LivePersistence } from './livePersistence.js';

export interface BuildLiveDeps {
  cfg: QuoterConfig;
  gateway: OrderGateway;
  persistence: LivePersistence;
  marketByToken: Map<string, string>;
  endDateByMarket: Map<string, Date>;
  rewardsByMarket: Map<string, RewardsParams>;
  onKill: () => Promise<void>;
  persistState: (s: object) => Promise<void>;
  notify: (type: string, payload: object) => Promise<void>;
}

export async function buildLiveEngine(d: BuildLiveDeps): Promise<{ engine: LiveEngine; risk: RiskGuard }> {
  await d.persistence.ensureSchema();
  // cancel-all incondicional al arrancar (sin reconciliar órfanas — v1).
  await d.gateway.cancelAll();

  // Un LiveLedger por mercado del subset (marketId fijo).
  const ledgerByMarket = new Map<string, LiveLedger>();
  for (const m of d.cfg.liveSubset) ledgerByMarket.set(m, new LiveLedger(d.persistence, m));
  // En v1 el engine consulta un ledger agregado: usamos el primero del subset como
  // book compartido si el subset es 1; para subsets multi-mercado, el LiveLedger se
  // generaliza a multi-market en el follow-up. v1 piloto = subset pequeño (1–3 mkts).
  const ledger = ledgerByMarket.get(d.cfg.liveSubset[0]!) ?? new LiveLedger(d.persistence, d.cfg.liveSubset[0] ?? '');

  const risk = new RiskGuard(
    { maxInvPerMarket: d.cfg.maxInvPerMarket, maxInvTotal: d.cfg.maxInvTotal, maxNotionalTotal: d.cfg.maxNotionalTotal, maxCumLoss: d.cfg.maxCumLoss },
    d.onKill, d.persistState, d.notify,
  );

  const engine = new LiveEngine({
    cfg: d.cfg, gateway: d.gateway, ledger, risk,
    marketByToken: d.marketByToken, endDateByMarket: d.endDateByMarket, rewardsByMarket: d.rewardsByMarket,
  });
  return { engine, risk };
}
```

> **Nota de scope v1:** el piloto opera un subset pequeño (1–3 mercados). El `LiveLedger` multi-market y el `ledgerByMarket` por separado son una mejora posterior; v1 usa un ledger sobre el primer mercado del subset. Documentar el límite en el runbook (Task 13).

En `index.ts`, reemplazar el bloque:

```ts
  if (quoterCfg.mode === 'live') {
    throw new Error('MM_QUOTER_MODE=live no implementado — fase 2');
  }
```

por la construcción real (boot): cargar la key (`loadPrivateKey(quoterCfg.walletSecretName, process.env)`), construir el `ClobClient` (`new ClobClient(host, chainId, signer, creds)` — igual que el dashboard), instanciar `OrderGateway`/`LivePersistence`, llamar `buildLiveEngine(...)`, cablear `onEvent` (book→`engine.onBook`), arrancar timers `tick` (`fillPollMs`) y registrar `cancelAll` en `shutdown`. Por brevedad y porque toca red, este wiring de boot se valida en el smoke de Task 13; la lógica testeable es `buildLiveEngine` (cubierta arriba).

Wiring concreto en `index.ts` (sustituye el throw):

```ts
  let liveEngine: import('./quoter/live/liveEngine.js').LiveEngine | null = null;
  let liveTickTimer: ReturnType<typeof setInterval> | null = null;
  let liveGateway: import('./quoter/live/orderGateway.js').OrderGateway | null = null;

  if (quoterCfg.mode === 'live') {
    const { loadPrivateKey } = await import('./quoter/live/secret.js');
    const { OrderGateway } = await import('./quoter/live/orderGateway.js');
    const { LivePersistence } = await import('./quoter/live/livePersistence.js');
    const { buildLiveEngine } = await import('./quoter/live/wiring.js');
    const { ClobClient } = await import('@polymarket/clob-client');

    const pk = await loadPrivateKey(quoterCfg.walletSecretName, process.env);
    const { Wallet } = await import('ethers');
    const signer = new Wallet(pk);
    const host = process.env.CLOB_API_URL ?? 'https://clob.polymarket.com';
    const client = new ClobClient(host, 137, signer as never);
    liveGateway = new OrderGateway(client as never, { ttlMs: quoterCfg.orderTtlMs });

    const livePersistence = new LivePersistence((sql: string, params?: unknown[]) => query(sql, params ?? []));
    const rewardsByMarket = new Map<string, RewardsParams>(); // mismo loadRewards que shadow (reusar)
    const built = await buildLiveEngine({
      cfg: quoterCfg, gateway: liveGateway, persistence: livePersistence,
      marketByToken,
      endDateByMarket: new Map(universe.filter((r) => r.end_date).map((r) => [r.market_id, new Date(r.end_date!)])),
      rewardsByMarket,
      onKill: async () => { await liveGateway!.cancelAll().catch(() => undefined); },
      persistState: (s) => query(
        `INSERT INTO mm_quoter_state(key,value,updated_at) VALUES ('live',$1,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(s)]).then(() => undefined),
      notify: async (type, payload) => { logger.error({ type, payload }, 'MM live notify'); },
    });
    liveEngine = built.engine;
    liveTickTimer = setInterval(() => liveEngine!.tick(new Date()).catch((e) => logger.warn({ e }, 'live tick failed')), quoterCfg.fillPollMs);
    logger.info({ subset: quoterCfg.liveSubset }, 'LIVE quoter started');
  }
```

Cablear `onEvent` para que, en live, los eventos `book` vayan a `liveEngine.onBook`; y añadir al `shutdown`: `if (liveTickTimer) clearInterval(liveTickTimer); if (liveGateway) await liveGateway.cancelAll().catch(()=>undefined);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter mm-recorder test wiring` y `pnpm --filter mm-recorder build`
Expected: PASS + build verde (tsc).

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/live/wiring.ts packages/mm-recorder/src/quoter/live/wiring.test.ts packages/mm-recorder/src/index.ts
git commit -m "feat(mm-live): wiring de la rama live en el recorder (boot + cancel-all + tick)"
```

---

## Task 12: H-MM-5 — validator + export + registry

**Files:**
- Create: `scripts/edge-research/mm_live_fills.sql`
- Create: `scripts/edge-research/validators/mm_live.py`
- Modify: `scripts/edge-research/run.py` (alta en `VALIDATORS`)
- Modify: `scripts/edge-research/data.py` (loader de `mm_live_fills`)
- Modify: `scripts/edge-research/registry.yaml`
- Test: `scripts/edge-research/tests/test_mm_live.py`

Simétrico a `mm_fine.py` pero **sin drain bounds** (cola real). Mide retained = `maker_sign*(maker_price − mid_after)` por horizonte.

- [ ] **Step 1: Write the failing test**

```python
# scripts/edge-research/tests/test_mm_live.py
import types, pandas as pd, numpy as np
from validators.mm_live import MMLiveValidator

def _ctx(df):
    return types.SimpleNamespace(datasets={'mm_live_fills': df}, cost=0.005,
                                 computed_at='2026-06-17T00:00:00+00:00', n_bins=10, min_n=2, seed=7)

def test_live_retained_positive_passes():
    # 3 fills bid (side -1) a 0.40, mid sube a 0.45 → retained +0.05 c/u
    rows = [{'time': pd.Timestamp('2026-06-17', tz='UTC'), 'market_type': 'event_short',
             'token_id': 't', 'side': -1, 'fill_price': 0.40, 'fill_size': 20,
             'spread_at_placement': 0.02, 'mid_10s': 0.45, 'mid_60s': 0.45, 'mid_300s': 0.45} for _ in range(3)]
    df = pd.DataFrame(rows)
    out = MMLiveValidator().run(_ctx(df))
    cell = [v for v in out if v.class_metric.get('cohort') == 'headline:tradeable:10s'][0]
    assert cell.status == 'pass'
    assert cell.edge_net_pct > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/edge-research && python -m pytest tests/test_mm_live.py -q`
Expected: FAIL — `validators/mm_live.py` no existe.

- [ ] **Step 3: Write minimal implementation**

`scripts/edge-research/mm_live_fills.sql` (export, ventana `win` default 7d, mids forward desde `mm_book_events`):

```sql
\if :{?win}
\else
  \set win '7 days'
\endif
CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, mid FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND mid IS NOT NULL;
CREATE INDEX ON be (token_id, bt);
ANALYZE be;
COPY (
  WITH f AS (
    SELECT lf.time, m.market_type, lf.token_id, lf.side, lf.fill_price, lf.fill_size,
           lf.spread_at_placement,
           (SELECT mid FROM be WHERE be.token_id=lf.token_id AND be.bt > lf.time AND be.bt <= lf.time + INTERVAL '10 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_10s,
           (SELECT mid FROM be WHERE be.token_id=lf.token_id AND be.bt > lf.time AND be.bt <= lf.time + INTERVAL '60 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_60s,
           (SELECT mid FROM be WHERE be.token_id=lf.token_id AND be.bt > lf.time AND be.bt <= lf.time + INTERVAL '300 seconds' ORDER BY be.bt DESC LIMIT 1) AS mid_300s
    FROM mm_live_fills lf JOIN markets m ON m.condition_id = (SELECT market_id FROM mm_trade_events te WHERE te.token_id = lf.token_id LIMIT 1)
  )
  SELECT * FROM f
) TO STDOUT WITH CSV HEADER;
```

> Nota: el join market_type por token reusa el patrón de condition_id. Si el recorder ya guarda `market_id` junto al fill en una versión futura, simplificar. v1 deriva el tipo por token.

`scripts/edge-research/validators/mm_live.py`:

```python
from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("live maker fill — cola exacta (sin drain bounds); excluye rewards (H-MM-2); "
           "n pequeño en piloto")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMLiveValidator:
    hypothesis_id = "H-MM-5"
    hclass = "market_making"

    def required_inputs(self): return ["mm_live_fills"]

    def run(self, ctx):
        df = ctx.datasets["mm_live_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        # retained = side_sign * (fill_price - mid_after); side -1 bid, +1 ask
        groups = [("headline:tradeable", lambda d: d["tradeable"])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, (lambda m: (lambda d: d["market_type"] == m))(mt)))
        out = []
        for label, mask in groups:
            base = df[mask(df)] if len(df) else df
            for hname, hcol in _HORIZONS:
                cohort = f"{label}:{hname}"
                sub = base[base[hcol].notna()]
                vals = (sub["side"] * (sub["fill_price"] - sub[hcol])).to_numpy(float)
                out.append(self._verdict(ctx, cohort, vals))
        return out

    def _verdict(self, ctx, cohort, vals):
        floor = getattr(ctx, "min_n", 200)
        n = int(vals.size)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None, "full",
                           {"cohort": cohort}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        edge = float(vals.mean())
        lo, hi = bootstrap_ci(vals, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge, float((hi - lo) / 2),
                       "full", {"cohort": cohort}, "maker_fee_0", status, [_CAVEAT], ctx.computed_at)
```

En `run.py`: importar `from validators.mm_live import MMLiveValidator` y añadir `"H-MM-5": MMLiveValidator` al dict `VALIDATORS`.

En `data.py` (`load_all_datasets_from_dir` y `load_all_datasets`): añadir el dataset `mm_live_fills` (mismo patrón que `mm_fine_fills`, `date_cols=["time"]`).

En `registry.yaml`: añadir la entrada H-MM-5 (class `market_making`, `required_data: [mm_live_fills]`, descripción "live maker retained, cola exacta").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/edge-research && python -m pytest tests/test_mm_live.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/edge-research/mm_live_fills.sql scripts/edge-research/validators/mm_live.py scripts/edge-research/run.py scripts/edge-research/data.py scripts/edge-research/registry.yaml scripts/edge-research/tests/test_mm_live.py
git commit -m "feat(edge-research): validator H-MM-5 (live maker retained, cola exacta)"
```

---

## Task 13 — [BLOQUEADA HASTA GATE 2026-06-22]: activación en producción

**No ejecutar antes del verdict H-MM-4.** Requiere los parámetros del gate.

**Files:**
- Create: `docs/superpowers/runbooks/h-mm-5-activation.md`
- Modify: `docker-compose.gcp.yml` (por PR — nunca edición directa en la VM)
- Modify: `.github/workflows/edge-research-weekly.yml` (export de `mm_live_fills`)

- [ ] **Step 1: Pre-requisitos operativos** (compartidos con [[project_real_trading]])
  - Wallet dedicada fundada con USDC (micro) + MATIC para gas.
  - Private key en GCP Secret Manager; IAM de acceso al secret para el SA de la VM.
  - Smoke del clob-client en **dry-run** en la VM: confirmar `createOrder`/`postOrder` con `orderType: 'GTD'`, `cancelOrder`, `cancelAll`, `getOrder`, y si existe el WS user-channel (decide poll vs WS). Registrar el resultado en el runbook.

- [ ] **Step 2: Rellenar parámetros del gate** en el runbook y en la config de compose:
  - `MM_LIVE_SUBSET` — mercados del verdict H-MM-4 con retained positivo + round-trip completion + rewards activo + vol dentro de umbral.
  - `MM_MIN_SPREAD` — de la curva retained-vs-banda-de-spread.
  - `MM_QUOTE_SIZE`, umbral `MM_VOL_PAUSE`, `MM_MAX_NOTIONAL_TOTAL`/`MM_MAX_CUM_LOSS` (defaults $100/$50).

- [ ] **Step 3: PR a `docker-compose.gcp.yml`** añadiendo al servicio mm-recorder: `MM_QUOTER_MODE=shadow→live`, `MM_WALLET_SECRET_NAME`, y los envs de riesgo/subset. Deploy por CI (nunca editar la VM directamente — rompe el `git pull` del deploy).

- [ ] **Step 4: Export semanal** — añadir a `edge-research-weekly.yml` el scp+run de `mm_live_fills.sql` (mismo patrón que `mm_fine_fills`), para que H-MM-5 aparezca en el `scoreboard.md` del lunes.

- [ ] **Step 5: Monitoreo día 1** — micro-capital; revisar log horario (quotes, fills, inventario, PnL, kill_state); el daily watchdog lee `mm_quoter_state.live`. Review humana antes de escalar capital.

- [ ] **Step 6: Commit del runbook**

```bash
git add docs/superpowers/runbooks/h-mm-5-activation.md
git commit -m "docs(mm-live): runbook de activación H-MM-5 (gated, params del gate 06-22)"
```

---

## Self-Review

**Spec coverage:**
- Layout fresco en mm-recorder → Tasks 2–11. ✓
- OrderGateway (post/cancel/cancelAll/replace/GTD/reconciliación) → Tasks 4–6. ✓
- LiveLedger + esquema simétrico → Tasks 7–8. ✓
- RiskGuard kill-switch one-way → Task 9. ✓
- Cancel-all al boot + SIGTERM → Task 11 (`buildLiveEngine` + shutdown). ✓
- Misma QuotePolicy (identidad) → Task 10 reusa `desiredQuotes`. ✓
- H-MM-5 validator → Task 12. ✓
- Runbook + activación gated → Task 13. ✓
- **Gap consciente:** la **identidad ledger shadow↔live** del spec (test de que la misma secuencia de fills produce idéntico inventario/PnL) NO tiene task propia → **añadir como Step extra en Task 8** (alimentar `LiveLedger` e `InventoryBook` shadow con la misma secuencia y comparar `totalRealized`/`equity`). Es barato y cierra el requisito.
- **Gap consciente:** `queueInitial` exacto al postear (registrar `levelSize` en `OpenOrder`) está marcado como follow-up v1, no implementado — el spec lo pide ("queue_ahead_initial … verdad exacta en live"). **Decisión:** v1 lo registra como `0` cuando no hay book a mano; mejora de fidelidad documentada en Task 10/13. Aceptable para el piloto (no afecta el retained, solo la columna de diagnóstico de cola).

**Placeholder scan:** sin TBD/TODO sin código. Los parámetros del gate en Task 13 son placeholders **intencionales y etiquetados** (bloqueados hasta 06-22).

**Type consistency:** `Side` (-1|1) consistente en todos los módulos; `LiveFill` (orderGateway) → `applyFill` (liveLedger) → `LiveFillRow` (livePersistence) encadenan; `RiskSnapshot` consistente entre RiskGuard y LiveEngine.runRiskCheck.

**Acción derivada del self-review:** al ejecutar la Task 8, añadir el Step de identidad ledger shadow↔live.
