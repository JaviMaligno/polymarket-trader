# MM Quoter — Fase Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shadow quoting engine dentro de `packages/mm-recorder` — quotes virtuales join-the-touch con cola exacta y dos drain bounds, PnL descompuesto e inventario virtual, persistido para el validator H-MM-4.

**Architecture:** Módulos nuevos bajo `packages/mm-recorder/src/quoter/`, activados por `MM_QUOTER_MODE=shadow` (default `off` — cero cambio de comportamiento). El QuoteEngine se engancha al flujo de eventos del wsClient vía un hook opcional `onEvent`. QuotePolicy es función pura (idéntica para shadow y live futuro). El ShadowLedger lleva por quote dos colas paralelas (bound `trades` y `cancels`) y emite fills anclados al precio de colocación. Reloj = event time (replay determinista).

**Tech Stack:** TypeScript ESM (imports `.js`), vitest, pg, pino — los del paquete. Validator en Python (pandas) en `scripts/edge-research/`.

**Spec:** `docs/superpowers/specs/2026-06-12-h-mm-level3-live-quoting-design.md`

**Convención de signos** (la misma que H-MM-3 / `mm_fine_fills.sql`): `side = -1` bid (maker compra), `side = +1` ask (maker vende). `retained = side * (placement_price − mid_after)`.

---

## File Structure

```
packages/mm-recorder/src/quoter/
  config.ts          # env → QuoterConfig (defaults del spec; shadow = permisivo)
  types.ts           # Side, PolicyInput, DesiredQuotes, ShadowFill, RewardsParams
  volTracker.ts      # max |Δmid| en ventana reciente, por token
  quotePolicy.ts     # función pura: PolicyInput → DesiredQuotes (guards + modos)
  inventoryBook.ts   # contabilidad: fills → cash/posición/realized; M2M
  shadowLedger.ts    # quotes virtuales, colas duales, fills anclados, TTL/price-out
  eligibility.ts     # elegibilidad rewards por minuto en memoria → agregado por hora
  persistence.ts     # CREATE TABLE IF NOT EXISTS + inserts (fills, pnl, eligibility, state)
  engine.ts          # orquestador: eventos → vol/policy/ledger/persistencia
  *.test.ts          # uno por módulo
packages/mm-recorder/src/bookState.ts    # + levelSize()
packages/mm-recorder/src/wsClient.ts     # + RecorderDeps.onEvent hook
packages/mm-recorder/src/index.ts        # + arranque del engine en modo shadow
packages/mm-recorder/src/selectUniverse.sql  # + end_date (guard near-resolution)
scripts/edge-research/mm_shadow_fills.sql    # export con forward mids
scripts/edge-research/validators/mm_shadow.py # validator H-MM-4
scripts/edge-research/registry.yaml          # + H-MM-4
scripts/edge-research/run.py                 # + wiring H-MM-4
scripts/edge-research/data.py                # + dataset mm_shadow_fills
scripts/edge-research/tests/test_mm_shadow.py
.github/workflows/edge-research-weekly.yml   # + export mm_shadow_fills
```

---

### Task 1: Config y tipos del quoter

**Files:**
- Create: `packages/mm-recorder/src/quoter/types.ts`
- Create: `packages/mm-recorder/src/quoter/config.ts`
- Test: `packages/mm-recorder/src/quoter/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/mm-recorder/src/quoter/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to off mode with shadow-permissive thresholds', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('off');
    expect(cfg.quoteSize).toBe(20);
    expect(cfg.orderTtlMs).toBe(30 * 60_000);
    expect(cfg.requoteMinMs).toBe(1000);
    expect(cfg.nearResolutionMs).toBe(24 * 3_600_000);
    // shadow mide todo: sin floor de spread, sin vol pause
    expect(cfg.minSpread).toBe(0);
    expect(cfg.volPause).toBe(Infinity);
    expect(cfg.volWindowMs).toBe(60_000);
    expect(cfg.maxInvPerMarket).toBe(20);
    expect(cfg.maxInvTotal).toBe(60);
    expect(cfg.maxCumLoss).toBe(50);
    expect(cfg.softInvPerMarket).toBe(10);
    expect(cfg.tick).toBe(0.01);
  });

  it('reads overrides from env-like record', () => {
    const cfg = loadConfig({
      MM_QUOTER_MODE: 'shadow', MM_QUOTE_SIZE: '40', MM_ORDER_TTL_MS: '600000',
      MM_VOL_PAUSE: '0.02', MM_MIN_SPREAD: '0.01', MM_TICK: '0.001',
    });
    expect(cfg.mode).toBe('shadow');
    expect(cfg.quoteSize).toBe(40);
    expect(cfg.orderTtlMs).toBe(600_000);
    expect(cfg.volPause).toBe(0.02);
    expect(cfg.minSpread).toBe(0.01);
    expect(cfg.tick).toBe(0.001);
  });

  it('rejects unknown mode', () => {
    expect(() => loadConfig({ MM_QUOTER_MODE: 'yolo' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`

- [ ] **Step 3: Write types and implementation**

```typescript
// packages/mm-recorder/src/quoter/types.ts
export type Side = -1 | 1; // -1 bid (maker buys), +1 ask (maker sells) — H-MM-3 maker_sign

export interface RewardsParams {
  minSize: number | null;
  maxSpreadCents: number | null; // Gamma lo reporta en centavos (3.5–4.5)
  dailyRate: number | null;
}

export interface PolicyInput {
  bestBid: number | null;
  bestAsk: number | null;
  recentVol: number;             // max |Δmid| en la ventana (VolTracker)
  msToResolution: number | null; // null = end_date desconocido (no bloquea)
  rewards: RewardsParams | null;
  inventoryShares: number;       // con signo, este mercado
  inventoryNotional: number;     // abs $, este mercado
  totalNotional: number;         // abs $, todos los mercados
}

export interface DesiredQuote { price: number; size: number; flags: string[] }
export interface DesiredQuotes { bid: DesiredQuote | null; ask: DesiredQuote | null }

export type DrainBound = 'trades' | 'cancels';

export interface ShadowFill {
  time: Date;
  tokenId: string;
  marketId: string;
  side: Side;
  bound: DrainBound;
  price: number;             // placement price (anclado)
  size: number;
  queueInitial: number;
  spreadAtPlacement: number | null;
  volAtPlacement: number;
  flags: string;             // csv: rewards_constrained, exit_improve
  midAtFill: number | null;
}
```

```typescript
// packages/mm-recorder/src/quoter/config.ts
export interface QuoterConfig {
  mode: 'off' | 'shadow' | 'live';
  quoteSize: number;
  orderTtlMs: number;
  requoteMinMs: number;
  nearResolutionMs: number;
  minSpread: number;
  volPause: number;
  volWindowMs: number;
  maxInvPerMarket: number;
  maxInvTotal: number;
  maxCumLoss: number;
  softInvPerMarket: number;
  tick: number;
}

const num = (v: string | undefined, d: number): number =>
  v === undefined || v === '' ? d : Number(v);

export function loadConfig(env: Record<string, string | undefined>): QuoterConfig {
  const mode = env.MM_QUOTER_MODE ?? 'off';
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'live') {
    throw new Error(`MM_QUOTER_MODE inválido: ${mode}`);
  }
  return {
    mode,
    quoteSize: num(env.MM_QUOTE_SIZE, 20),
    orderTtlMs: num(env.MM_ORDER_TTL_MS, 30 * 60_000),
    requoteMinMs: num(env.MM_REQUOTE_MIN_MS, 1000),
    nearResolutionMs: num(env.MM_NEAR_RESOLUTION_HOURS, 24) * 3_600_000,
    // shadow-permisivo por defecto: quotar todo y medir; live endurece con datos
    minSpread: num(env.MM_MIN_SPREAD, 0),
    volPause: env.MM_VOL_PAUSE ? Number(env.MM_VOL_PAUSE) : Infinity,
    volWindowMs: num(env.MM_VOL_WINDOW_MS, 60_000),
    maxInvPerMarket: num(env.MM_MAX_INVENTORY_PER_MARKET, 20),
    maxInvTotal: num(env.MM_MAX_INVENTORY_TOTAL, 60),
    maxCumLoss: num(env.MM_MAX_CUM_LOSS, 50),
    softInvPerMarket: num(env.MM_SOFT_INVENTORY_PER_MARKET, 10),
    tick: num(env.MM_TICK, 0.01),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/types.ts packages/mm-recorder/src/quoter/config.ts packages/mm-recorder/src/quoter/config.test.ts
git commit -m "feat(mm-quoter): config y tipos del quoter (defaults shadow-permisivos)"
```

---

### Task 2: BookState.levelSize()

El bound `cancels` necesita el size actual del nivel donde está nuestra quote.

**Files:**
- Modify: `packages/mm-recorder/src/bookState.ts`
- Test: `packages/mm-recorder/src/bookState.test.ts` (añadir al final)

- [ ] **Step 1: Write the failing test** (añadir a `bookState.test.ts`)

```typescript
describe('levelSize', () => {
  it('returns the ladder size at a price level and null when unknown', () => {
    const s = new BookState();
    s.apply({
      time: new Date('2026-06-12T10:00:00Z'), tokenId: 'T', marketId: 'M',
      eventType: 'book',
      bids: [{ price: 0.49, size: 100 }, { price: 0.48, size: 50 }],
      asks: [{ price: 0.51, size: 80 }],
    });
    expect(s.levelSize('T', -1, 0.49)).toBe(100);
    expect(s.levelSize('T', -1, 0.48)).toBe(50);
    expect(s.levelSize('T', 1, 0.51)).toBe(80);
    expect(s.levelSize('T', -1, 0.40)).toBeNull(); // nivel inexistente
    expect(s.levelSize('X', -1, 0.49)).toBeNull(); // token desconocido
  });

  it('tracks deltas: a price_change updates the level size', () => {
    const s = new BookState();
    s.apply({
      time: new Date('2026-06-12T10:00:00Z'), tokenId: 'T', marketId: 'M',
      eventType: 'book', bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.51, size: 80 }],
    });
    s.apply({
      time: new Date('2026-06-12T10:00:01Z'), tokenId: 'T', marketId: 'M',
      eventType: 'price_change', price: 0.49, size: 30, side: 'BUY',
      reportedBestBid: 0.49, reportedBestAsk: 0.51,
    });
    expect(s.levelSize('T', -1, 0.49)).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/bookState.test.ts`
Expected: FAIL — `levelSize is not a function`

- [ ] **Step 3: Implement** (añadir método a `BookState`)

```typescript
  /** Size actual del nivel `price` en el lado `side` (-1 bids, +1 asks);
   *  null si el token o el nivel no se conocen. */
  levelSize(tokenId: string, side: -1 | 1, price: number): number | null {
    const ladder = this.books.get(tokenId);
    if (!ladder) return null;
    const m = side === -1 ? ladder.bids : ladder.asks;
    const v = m.get(price);
    return v ?? null;
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd packages/mm-recorder && npx vitest run src/bookState.test.ts`
Expected: PASS (suite completa del fichero)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/bookState.ts packages/mm-recorder/src/bookState.test.ts
git commit -m "feat(mm-quoter): BookState.levelSize para el drain bound de cancels"
```

---

### Task 3: VolTracker

**Files:**
- Create: `packages/mm-recorder/src/quoter/volTracker.ts`
- Test: `packages/mm-recorder/src/quoter/volTracker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { VolTracker } from './volTracker.js';

const t = (s: number) => new Date(Date.UTC(2026, 5, 12, 10, 0, s));

describe('VolTracker', () => {
  it('reports max |Δmid| within the window', () => {
    const v = new VolTracker(60_000);
    v.add('T', t(0), 0.50);
    v.add('T', t(10), 0.53);
    v.add('T', t(20), 0.51);
    expect(v.recentVol('T', t(20))).toBeCloseTo(0.03, 10); // 0.53-0.50
  });

  it('drops samples older than the window', () => {
    const v = new VolTracker(60_000);
    v.add('T', t(0), 0.10);
    v.add('T', t(70), 0.50);
    v.add('T', t(80), 0.505);
    expect(v.recentVol('T', t(80))).toBeCloseTo(0.005, 10);
  });

  it('returns 0 with fewer than 2 samples', () => {
    const v = new VolTracker(60_000);
    expect(v.recentVol('T', t(0))).toBe(0);
    v.add('T', t(0), 0.5);
    expect(v.recentVol('T', t(0))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/volTracker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/mm-recorder/src/quoter/volTracker.ts
interface Sample { time: number; mid: number }

export class VolTracker {
  private samples = new Map<string, Sample[]>();
  constructor(private windowMs: number) {}

  add(tokenId: string, time: Date, mid: number): void {
    const arr = this.samples.get(tokenId) ?? [];
    arr.push({ time: time.getTime(), mid });
    const cutoff = time.getTime() - this.windowMs;
    while (arr.length && arr[0].time < cutoff) arr.shift();
    this.samples.set(tokenId, arr);
  }

  /** max(mid) − min(mid) entre las muestras dentro de la ventana. */
  recentVol(tokenId: string, now: Date): number {
    const cutoff = now.getTime() - this.windowMs;
    const arr = (this.samples.get(tokenId) ?? []).filter((s) => s.time >= cutoff);
    if (arr.length < 2) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const s of arr) { if (s.mid < lo) lo = s.mid; if (s.mid > hi) hi = s.mid; }
    return hi - lo;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/volTracker.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/volTracker.ts packages/mm-recorder/src/quoter/volTracker.test.ts
git commit -m "feat(mm-quoter): VolTracker (max delta-mid en ventana) para el volatility pause"
```

---

### Task 4: QuotePolicy (función pura)

**Files:**
- Create: `packages/mm-recorder/src/quoter/quotePolicy.ts`
- Test: `packages/mm-recorder/src/quoter/quotePolicy.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { desiredQuotes } from './quotePolicy.js';
import { loadConfig } from './config.js';
import type { PolicyInput } from './types.js';

const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow' });

const base: PolicyInput = {
  bestBid: 0.48, bestAsk: 0.52,
  recentVol: 0, msToResolution: 7 * 24 * 3_600_000,
  rewards: null,
  inventoryShares: 0, inventoryNotional: 0, totalNotional: 0,
};

describe('desiredQuotes — guards', () => {
  it('joins the touch on both sides in the happy path', () => {
    const q = desiredQuotes(base, cfg);
    expect(q.bid).toEqual({ price: 0.48, size: 20, flags: [] });
    expect(q.ask).toEqual({ price: 0.52, size: 20, flags: [] });
  });

  it('no quote when the book is one-sided', () => {
    expect(desiredQuotes({ ...base, bestAsk: null }, cfg)).toEqual({ bid: null, ask: null });
    expect(desiredQuotes({ ...base, bestBid: null }, cfg)).toEqual({ bid: null, ask: null });
  });

  it('no quote near resolution', () => {
    const q = desiredQuotes({ ...base, msToResolution: 23 * 3_600_000 }, cfg);
    expect(q).toEqual({ bid: null, ask: null });
  });

  it('unknown end_date does NOT block', () => {
    expect(desiredQuotes({ ...base, msToResolution: null }, cfg).bid).not.toBeNull();
  });

  it('volatility pause pulls both sides when recentVol exceeds threshold', () => {
    const tight = { ...cfg, volPause: 0.02 };
    expect(desiredQuotes({ ...base, recentVol: 0.03 }, tight)).toEqual({ bid: null, ask: null });
    expect(desiredQuotes({ ...base, recentVol: 0.01 }, tight).bid).not.toBeNull();
  });

  it('spread floor suppresses quotes on tight books', () => {
    const floor = { ...cfg, minSpread: 0.05 };
    expect(desiredQuotes(base, floor)).toEqual({ bid: null, ask: null }); // spread 0.04
  });
});

describe('desiredQuotes — rewards', () => {
  it('uses max(quoteSize, rewardsMinSize)', () => {
    const q = desiredQuotes({ ...base, rewards: { minSize: 50, maxSpreadCents: null, dailyRate: 10 } }, cfg);
    expect(q.bid!.size).toBe(50);
  });

  it('rewards_constrained: touch fuera de banda -> quote en el borde elegible', () => {
    // mid=0.50, maxSpread 1¢ -> banda [0.49, 0.51]; touch bid 0.48 queda fuera
    const q = desiredQuotes({ ...base, rewards: { minSize: null, maxSpreadCents: 1, dailyRate: 10 } }, cfg);
    expect(q.bid!.price).toBeCloseTo(0.49, 10);
    expect(q.bid!.flags).toContain('rewards_constrained');
    expect(q.ask!.price).toBeCloseTo(0.51, 10);
  });

  it('touch dentro de banda -> join the touch sin flag', () => {
    const q = desiredQuotes({ ...base, rewards: { minSize: null, maxSpreadCents: 5, dailyRate: 10 } }, cfg);
    expect(q.bid!.price).toBe(0.48);
    expect(q.bid!.flags).toEqual([]);
  });
});

describe('desiredQuotes — inventario', () => {
  it('hard cap per market: suprime el lado que aumenta inventario', () => {
    // long 0.48*50=24$ > maxInvPerMarket 20 -> bid (aumenta long) fuera; ask sigue
    const q = desiredQuotes({ ...base, inventoryShares: 50, inventoryNotional: 24, totalNotional: 24 }, cfg);
    expect(q.bid).toBeNull();
    expect(q.ask).not.toBeNull();
  });

  it('hard cap total: suprime el lado que aumenta cualquier inventario', () => {
    const q = desiredQuotes({ ...base, inventoryShares: 10, inventoryNotional: 5, totalNotional: 61 }, cfg);
    expect(q.bid).toBeNull();
    expect(q.ask).not.toBeNull(); // reduce el long de este mercado
  });

  it('exit_improve: sobre el soft cap, el lado reductor mejora 1 tick', () => {
    // long sobre softInvPerMarket=10 -> ask (reduce) mejora: bestAsk - tick
    const q = desiredQuotes({ ...base, inventoryShares: 30, inventoryNotional: 15, totalNotional: 15 }, cfg);
    expect(q.ask!.price).toBeCloseTo(0.51, 10); // 0.52 - 0.01
    expect(q.ask!.flags).toContain('exit_improve');
    expect(q.bid).not.toBeNull(); // bajo el hard cap, el bid sigue
  });

  it('exit_improve nunca cruza: queda al menos 1 tick del lado opuesto', () => {
    const narrow = { ...base, bestBid: 0.50, bestAsk: 0.51, inventoryShares: 30, inventoryNotional: 15, totalNotional: 15 };
    const q = desiredQuotes(narrow, cfg);
    expect(q.ask!.price).toBeCloseTo(0.51, 10); // no puede mejorar sin cruzar -> se queda al touch
    expect(q.ask!.flags).not.toContain('exit_improve');
  });

  it('short inventory: espejo — bid reduce y puede mejorar', () => {
    const q = desiredQuotes({ ...base, inventoryShares: -30, inventoryNotional: 15, totalNotional: 15 }, cfg);
    expect(q.bid!.price).toBeCloseTo(0.49, 10);
    expect(q.bid!.flags).toContain('exit_improve');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/quotePolicy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/mm-recorder/src/quoter/quotePolicy.ts
import type { QuoterConfig } from './config.js';
import type { DesiredQuote, DesiredQuotes, PolicyInput } from './types.js';

const NONE: DesiredQuotes = { bid: null, ask: null };
const round = (p: number, tick: number) => Math.round(p / tick) * tick;

/** Política pura de quoting. Orden de guards: one-sided -> near-resolution ->
 *  vol pause -> spread floor. Después: precio (join-touch / rewards band),
 *  tamaño, e inventario (hard caps suprimen el lado que aumenta; soft cap
 *  permite exit_improve de 1 tick en el lado reductor, nunca cruzando). */
export function desiredQuotes(inp: PolicyInput, cfg: QuoterConfig): DesiredQuotes {
  const { bestBid, bestAsk } = inp;
  if (bestBid === null || bestAsk === null) return NONE;
  if (inp.msToResolution !== null && inp.msToResolution < cfg.nearResolutionMs) return NONE;
  if (inp.recentVol > cfg.volPause) return NONE;
  const spread = bestAsk - bestBid;
  if (spread < cfg.minSpread) return NONE;

  const mid = (bestBid + bestAsk) / 2;
  const size = Math.max(cfg.quoteSize, inp.rewards?.minSize ?? 0);

  const mk = (side: -1 | 1): DesiredQuote => {
    const flags: string[] = [];
    let price = side === -1 ? bestBid : bestAsk;
    const band = inp.rewards?.maxSpreadCents != null ? inp.rewards.maxSpreadCents / 100 : null;
    if (band !== null && Math.abs(mid - price) > band) {
      price = round(side === -1 ? mid - band : mid + band, cfg.tick);
      flags.push('rewards_constrained');
    }
    return { price, size, flags };
  };

  let bid: DesiredQuote | null = mk(-1);
  let ask: DesiredQuote | null = mk(1);

  // Inventario: bid aumenta long; ask reduce long (y viceversa con short).
  const long = inp.inventoryShares > 0;
  const short = inp.inventoryShares < 0;
  const hard = inp.inventoryNotional >= cfg.maxInvPerMarket || inp.totalNotional >= cfg.maxInvTotal;
  if (hard) {
    if (!short) bid = null;  // long o flat: bid aumenta
    if (!long) ask = null;   // short o flat: ask aumenta
  }

  // exit_improve: sobre el soft cap, el lado reductor mejora 1 tick si no cruza.
  if (inp.inventoryNotional >= cfg.softInvPerMarket) {
    if (long && ask) {
      const better = round(ask.price - cfg.tick, cfg.tick);
      if (better > bestBid) { ask = { ...ask, price: better, flags: [...ask.flags, 'exit_improve'] }; }
    }
    if (short && bid) {
      const better = round(bid.price + cfg.tick, cfg.tick);
      if (better < bestAsk) { bid = { ...bid, price: better, flags: [...bid.flags, 'exit_improve'] }; }
    }
  }

  return { bid, ask };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/quotePolicy.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/quotePolicy.ts packages/mm-recorder/src/quoter/quotePolicy.test.ts
git commit -m "feat(mm-quoter): QuotePolicy pura — guards, rewards band, exit_improve"
```

---

### Task 5: InventoryBook (contabilidad con invariantes)

**Files:**
- Create: `packages/mm-recorder/src/quoter/inventoryBook.ts`
- Test: `packages/mm-recorder/src/quoter/inventoryBook.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { InventoryBook } from './inventoryBook.js';

describe('InventoryBook', () => {
  it('round-trip completo: realized = (ask - bid) * size, posición 0', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.48, 20); // maker compra 20 @ .48
    b.applyFill('M1', 1, 0.52, 20);  // maker vende 20 @ .52
    expect(b.position('M1')).toBe(0);
    expect(b.realized('M1')).toBeCloseTo(0.04 * 20, 10);
    expect(b.cash()).toBeCloseTo(0.04 * 20, 10);
  });

  it('invariante: equity = cash + sum(pos * mid) en todo momento', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.48, 20);
    b.applyFill('M2', 1, 0.70, 10); // short 10 @ .70
    const mids = new Map([['M1', 0.50], ['M2', 0.65]]);
    // M1: compró a .48, vale .50 -> +0.4; M2: vendió a .70, vale .65 -> +0.5
    expect(b.equity(mids)).toBeCloseTo(0.4 + 0.5, 10);
    expect(b.equity(mids)).toBeCloseTo(b.cash() + b.m2m(mids), 10);
  });

  it('reducción parcial realiza proporcionalmente', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 30);
    b.applyFill('M1', 1, 0.50, 10);
    expect(b.position('M1')).toBe(20);
    expect(b.realized('M1')).toBeCloseTo(0.10 * 10, 10);
  });

  it('cruce de signo: realiza el cierre y abre el resto al nuevo precio', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 10);
    b.applyFill('M1', 1, 0.50, 25); // cierra 10 (+1.0) y abre short 15 @ .50
    expect(b.position('M1')).toBe(-15);
    expect(b.realized('M1')).toBeCloseTo(1.0, 10);
    expect(b.avgPrice('M1')).toBeCloseTo(0.50, 10);
  });

  it('inventario = suma con signo de los fills', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 10);
    b.applyFill('M1', -1, 0.42, 5);
    b.applyFill('M1', 1, 0.45, 7);
    expect(b.position('M1')).toBe(10 + 5 - 7);
  });

  it('notional usa el avg price de la posición abierta', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 10);
    b.applyFill('M1', -1, 0.50, 10);
    expect(b.avgPrice('M1')).toBeCloseTo(0.45, 10);
    expect(b.notional('M1')).toBeCloseTo(0.45 * 20, 10);
    expect(b.totalNotional()).toBeCloseTo(0.45 * 20, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/inventoryBook.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/mm-recorder/src/quoter/inventoryBook.ts
import type { Side } from './types.js';

interface Pos { shares: number; avg: number; realized: number }

/** Contabilidad de fills sombra por mercado. side -1 = compra, +1 = venta.
 *  Invariante: equity(mids) === cash() + m2m(mids). */
export class InventoryBook {
  private pos = new Map<string, Pos>();
  private cashAcc = 0;

  applyFill(marketId: string, side: Side, price: number, size: number): void {
    const p = this.pos.get(marketId) ?? { shares: 0, avg: 0, realized: 0 };
    const delta = side === -1 ? size : -size;       // compra suma shares
    this.cashAcc += side === -1 ? -price * size : price * size;

    const sameSign = p.shares === 0 || Math.sign(p.shares) === Math.sign(delta);
    if (sameSign) {
      const newShares = p.shares + delta;
      p.avg = newShares === 0 ? 0 : (p.avg * Math.abs(p.shares) + price * Math.abs(delta)) / Math.abs(newShares);
      p.shares = newShares;
    } else {
      const closing = Math.min(Math.abs(p.shares), Math.abs(delta));
      // long cerrado por venta gana (price - avg); short cerrado por compra gana (avg - price)
      p.realized += closing * (p.shares > 0 ? price - p.avg : p.avg - price);
      const remaining = Math.abs(delta) - closing;
      p.shares = p.shares + delta;
      if (remaining > 0) p.avg = price;             // posición nueva al otro lado
      else if (p.shares === 0) p.avg = 0;
    }
    this.pos.set(marketId, p);
  }

  position(m: string): number { return this.pos.get(m)?.shares ?? 0 }
  avgPrice(m: string): number { return this.pos.get(m)?.avg ?? 0 }
  realized(m: string): number { return this.pos.get(m)?.realized ?? 0 }
  notional(m: string): number { const p = this.pos.get(m); return p ? Math.abs(p.shares) * p.avg : 0 }
  totalNotional(): number { let t = 0; for (const m of this.pos.keys()) t += this.notional(m); return t }
  cash(): number { return this.cashAcc }

  m2m(mids: Map<string, number>): number {
    let t = 0;
    for (const [m, p] of this.pos) t += p.shares * (mids.get(m) ?? p.avg);
    return t;
  }
  equity(mids: Map<string, number>): number { return this.cashAcc + this.m2m(mids) }
  totalRealized(): number { let t = 0; for (const p of this.pos.values()) t += p.realized; return t }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/inventoryBook.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/inventoryBook.ts packages/mm-recorder/src/quoter/inventoryBook.test.ts
git commit -m "feat(mm-quoter): InventoryBook con invariantes contables (cash + M2M = equity)"
```

---

### Task 6: ShadowLedger — colocación, drain por trades, fill anclado

**Files:**
- Create: `packages/mm-recorder/src/quoter/shadowLedger.ts`
- Test: `packages/mm-recorder/src/quoter/shadowLedger.test.ts`

Semántica de drain (bound `trades`): para una quote bid a precio P —
`trade.price < P` ⇒ el libro traspasó nuestro nivel ⇒ fill del resto;
`trade.price === P` ⇒ drena `trade.size` de la cola; al agotarse, fill.
Simétrico para el ask (`trade.price > P` traspasa). El precio del fill es
SIEMPRE el de colocación (anclado — lección del fix de `mm_fine.py` 2026-06-12).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { ShadowLedger } from './shadowLedger.js';

const t = (s: number) => new Date(Date.UTC(2026, 5, 12, 10, 0, s));

const place = (l: ShadowLedger, side: -1 | 1, price: number, queue: number, size = 20, flags: string[] = []) =>
  l.place({ tokenId: 'T', marketId: 'M', side, price, size, queueInitial: queue,
            time: t(0), spread: 0.04, vol: 0, flags });

describe('ShadowLedger — drain por trades, precio anclado', () => {
  it('trade at our price drains the queue; crossing it fills the remainder', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 30);
    expect(l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 10 }, null)).toEqual([]);
    const fills = l.onTrade({ tokenId: 'T', time: t(2), price: 0.48, size: 25 }, null);
    const f = fills.find((x) => x.bound === 'trades')!;
    expect(f.price).toBe(0.48);          // anclado
    expect(f.size).toBe(20);
    expect(f.side).toBe(-1);
  });

  it('a trade below our bid fills immediately (level swept)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 100);
    const fills = l.onTrade({ tokenId: 'T', time: t(1), price: 0.45, size: 1 }, null);
    expect(fills.find((x) => x.bound === 'trades')!.price).toBe(0.48);
  });

  it('ask mirror: trade above our ask fills; at our ask drains', () => {
    const l = new ShadowLedger();
    place(l, 1, 0.52, 10);
    const fills = l.onTrade({ tokenId: 'T', time: t(1), price: 0.55, size: 1 }, null);
    expect(fills.find((x) => x.bound === 'trades')!.side).toBe(1);
  });

  it('PRICE MOVES BETWEEN PLACEMENT AND FILL: fill price stays anchored', () => {
    // La clase de bug del re-pricing fantasma: el libro desliza, el fill
    // debe registrarse al precio de colocación.
    const l = new ShadowLedger();
    place(l, -1, 0.48, 30);
    l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 20 }, null);
    // el bid baja a 0.46; un trade a 0.46 < 0.48 traspasa nuestro nivel
    const fills = l.onTrade({ tokenId: 'T', time: t(2), price: 0.46, size: 5 }, null);
    expect(fills.find((x) => x.bound === 'trades')!.price).toBe(0.48); // NO 0.46
  });

  it('partial fills accumulate up to quote size', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 0, 20); // queue 0: front of queue
    const f1 = l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 8 }, null);
    expect(f1.find((x) => x.bound === 'trades')!.size).toBe(8);
    const f2 = l.onTrade({ tokenId: 'T', time: t(2), price: 0.48, size: 30 }, null);
    expect(f2.find((x) => x.bound === 'trades')!.size).toBe(12); // resto
    // quote agotada: nada más
    expect(l.onTrade({ tokenId: 'T', time: t(3), price: 0.48, size: 5 }, null)).toEqual([]);
  });

  it('trades on other tokens or the opposite side do not touch our queue', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    expect(l.onTrade({ tokenId: 'X', time: t(1), price: 0.40, size: 99 }, null)).toEqual([]);
    expect(l.onTrade({ tokenId: 'T', time: t(1), price: 0.52, size: 99 }, null)).toEqual([]);
  });

  it('profit/adverse matrix: retained sign comes from anchored price vs later mid (computed offline)', () => {
    // El ledger NO calcula retained (lo hace el validator con mids forward);
    // aquí verificamos que el fill registra los datos necesarios.
    const l = new ShadowLedger();
    place(l, 1, 0.52, 0, 20, ['exit_improve']);
    const f = l.onTrade({ tokenId: 'T', time: t(1), price: 0.52, size: 20 }, null)
      .find((x) => x.bound === 'trades')!;
    expect(f.flags).toBe('exit_improve');
    expect(f.queueInitial).toBe(0);
    expect(f.spreadAtPlacement).toBe(0.04);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/shadowLedger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** (núcleo; el bound `cancels` llega en Task 7)

```typescript
// packages/mm-recorder/src/quoter/shadowLedger.ts
import type { DrainBound, ShadowFill, Side } from './types.js';

export interface Placement {
  tokenId: string; marketId: string; side: Side;
  price: number; size: number; queueInitial: number;
  time: Date; spread: number | null; vol: number; flags: string[];
}

export interface LedgerTrade { tokenId: string; time: Date; price: number; size: number }

interface BoundState { queue: number; remaining: number }

interface Quote extends Placement {
  bounds: Record<DrainBound, BoundState>;
}

/** Quotes virtuales con dos colas paralelas (bound trades / cancels).
 *  Fill SIEMPRE al precio de colocación (anclado). */
export class ShadowLedger {
  private quotes = new Map<string, Quote>(); // key = tokenId:side

  private key(tokenId: string, side: Side): string { return `${tokenId}:${side}` }

  place(p: Placement): void {
    this.quotes.set(this.key(p.tokenId, p.side), {
      ...p,
      bounds: {
        trades: { queue: p.queueInitial, remaining: p.size },
        cancels: { queue: p.queueInitial, remaining: p.size },
      },
    });
  }

  active(tokenId: string, side: Side): Quote | undefined {
    return this.quotes.get(this.key(tokenId, side));
  }

  cancel(tokenId: string, side: Side): void {
    this.quotes.delete(this.key(tokenId, side));
  }

  /** levelSize: size actual del nivel de nuestra quote (bound cancels);
   *  null si no se conoce. */
  onTrade(tr: LedgerTrade, levelSize: number | null): ShadowFill[] {
    const fills: ShadowFill[] = [];
    for (const side of [-1, 1] as Side[]) {
      const q = this.quotes.get(this.key(tr.tokenId, side));
      if (!q) continue;
      const crossed = side === -1 ? tr.price < q.price : tr.price > q.price;
      const atLevel = tr.price === q.price;
      if (!crossed && !atLevel) continue;

      for (const bound of ['trades', 'cancels'] as DrainBound[]) {
        const st = q.bounds[bound];
        if (st.remaining <= 0) continue;
        if (bound === 'cancels' && levelSize !== null) {
          st.queue = Math.min(st.queue, levelSize); // cota optimista: cancels drenan
        }
        let fillSize = 0;
        if (crossed) {
          fillSize = st.remaining;                  // nivel traspasado: fill del resto
        } else {
          const drained = Math.max(0, tr.size - Math.max(0, st.queue));
          st.queue = Math.max(0, st.queue - tr.size);
          fillSize = Math.min(st.remaining, drained);
        }
        if (fillSize > 0) {
          st.remaining -= fillSize;
          fills.push({
            time: tr.time, tokenId: q.tokenId, marketId: q.marketId, side: q.side,
            bound, price: q.price, size: fillSize, queueInitial: q.queueInitial,
            spreadAtPlacement: q.spread, volAtPlacement: q.vol,
            flags: q.flags.join(','), midAtFill: null,
          });
        }
      }
      if (q.bounds.trades.remaining <= 0 && q.bounds.cancels.remaining <= 0) {
        this.quotes.delete(this.key(tr.tokenId, side));
      }
    }
    return fills;
  }

  clearToken(tokenId: string): void {
    this.quotes.delete(this.key(tokenId, -1));
    this.quotes.delete(this.key(tokenId, 1));
  }

  clearAll(): void { this.quotes.clear() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/shadowLedger.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/shadowLedger.ts packages/mm-recorder/src/quoter/shadowLedger.test.ts
git commit -m "feat(mm-quoter): ShadowLedger — colas duales, drain por trades, fill anclado"
```

---

### Task 7: ShadowLedger — bound `cancels` + invariantes property-style

**Files:**
- Modify: `packages/mm-recorder/src/quoter/shadowLedger.ts` (ya soporta levelSize — esta task lo testea a fondo)
- Test: `packages/mm-recorder/src/quoter/shadowLedger.test.ts` (añadir)

- [ ] **Step 1: Write the failing tests** (añadir al test file)

```typescript
describe('ShadowLedger — bound cancels', () => {
  it('cancels bound fills earlier when the level shrinks without trades', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 50);
    // El nivel se encogió a 5 (cancels delante asumidos): el bound cancels
    // se llena con un trade de 10; el bound trades aún no (cola 50).
    const fills = l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 10 }, 5);
    expect(fills.map((f) => f.bound)).toEqual(['cancels']);
    expect(fills[0].size).toBe(5); // 10 - queue(5)
  });

  it('cancels queue never exceeds trades queue (invariant: cancels fills first)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 40);
    // secuencia generada: el bound cancels nunca debe llenarse DESPUÉS del trades
    const seq: Array<{ size: number; level: number | null }> = [
      { size: 5, level: 35 }, { size: 10, level: 20 }, { size: 15, level: 10 }, { size: 25, level: 2 },
    ];
    let tradesFilled = 0, cancelsFilled = 0, i = 0;
    for (const s of seq) {
      i += 1;
      for (const f of l.onTrade({ tokenId: 'T', time: t(i), price: 0.48, size: s.size }, s.level)) {
        if (f.bound === 'trades') tradesFilled += f.size;
        if (f.bound === 'cancels') cancelsFilled += f.size;
      }
      expect(cancelsFilled).toBeGreaterThanOrEqual(tradesFilled);
    }
  });

  it('queue never goes negative after reset (re-place)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 100 }, null); // fill total
    place(l, -1, 0.47, 30); // re-place
    const q = l.active('T', -1)!;
    expect(q.bounds.trades.queue).toBe(30);
    expect(q.bounds.trades.remaining).toBe(20);
  });

  it('out-of-order trade events do not crash and are processed deterministically', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 20);
    const f1 = l.onTrade({ tokenId: 'T', time: t(5), price: 0.48, size: 15 }, null);
    const f2 = l.onTrade({ tokenId: 'T', time: t(3), price: 0.48, size: 15 }, null); // anterior en el tiempo
    expect(f1).toEqual([]);
    expect(f2.find((x) => x.bound === 'trades')!.size).toBe(10); // 30 acumulado - 20 cola
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/shadowLedger.test.ts`
Expected: PASS si la Task 6 dejó el `cancels` bound correcto; si algo falla, ajustar `onTrade` hasta verde. (El procesamiento es en orden de llegada — el evento fuera de orden simplemente se procesa; el test fija ese comportamiento como contrato.)

- [ ] **Step 3: Commit**

```bash
git add packages/mm-recorder/src/quoter/shadowLedger.test.ts packages/mm-recorder/src/quoter/shadowLedger.ts
git commit -m "test(mm-quoter): bound cancels + invariantes (orden de fills, colas, out-of-order)"
```

---

### Task 8: ShadowLedger lifecycle en el engine — price-out, TTL, histéresis, gaps

La lógica de cuándo (re)colocar vive en el QuoteEngine (Task 10), pero el
contrato del ledger para expiración/replace se fija aquí.

**Files:**
- Modify: `packages/mm-recorder/src/quoter/shadowLedger.ts`
- Test: `packages/mm-recorder/src/quoter/shadowLedger.test.ts` (añadir)

- [ ] **Step 1: Write the failing tests**

```typescript
describe('ShadowLedger — expiración y reemplazo', () => {
  it('expired() lists quotes past their TTL (event-time clock)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10); // placed at t(0)
    expect(l.expired(t(60), 30_000).map((q) => q.side)).toEqual([-1]);
    expect(l.expired(t(10), 30_000)).toEqual([]);
  });

  it('replace cancels and re-places with fresh queue (priority lost)', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    l.onTrade({ tokenId: 'T', time: t(1), price: 0.48, size: 8 }, null); // cola 2
    l.cancel('T', -1);
    place(l, -1, 0.49, 25); // nuevo touch, nueva cola
    const q = l.active('T', -1)!;
    expect(q.price).toBe(0.49);
    expect(q.bounds.trades.queue).toBe(25);
  });

  it('clearToken on gap invalidates both sides', () => {
    const l = new ShadowLedger();
    place(l, -1, 0.48, 10);
    place(l, 1, 0.52, 10);
    l.clearToken('T');
    expect(l.active('T', -1)).toBeUndefined();
    expect(l.active('T', 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/shadowLedger.test.ts`
Expected: FAIL — `expired is not a function`

- [ ] **Step 3: Implement** (añadir a `ShadowLedger`)

```typescript
  /** Quotes cuya colocación es anterior a now − ttlMs (reloj = event time). */
  expired(now: Date, ttlMs: number): Quote[] {
    const out: Quote[] = [];
    for (const q of this.quotes.values()) {
      if (now.getTime() - q.time.getTime() >= ttlMs) out.push(q);
    }
    return out;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/shadowLedger.test.ts`
Expected: PASS (suite completa)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/shadowLedger.ts packages/mm-recorder/src/quoter/shadowLedger.test.ts
git commit -m "feat(mm-quoter): TTL expiry y contrato de replace en ShadowLedger"
```

---

### Task 9: EligibilityTracker (agregado horario — NO por minuto en DB)

**Files:**
- Create: `packages/mm-recorder/src/quoter/eligibility.ts`
- Test: `packages/mm-recorder/src/quoter/eligibility.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { EligibilityTracker } from './eligibility.js';

const at = (h: number, m: number) => new Date(Date.UTC(2026, 5, 12, h, m, 0));

describe('EligibilityTracker', () => {
  it('accumulates eligible minutes in memory and flushes one row per market-hour', () => {
    const tr = new EligibilityTracker();
    // dos muestras del mismo minuto cuentan una vez
    tr.sample('M1', at(10, 0), true);
    tr.sample('M1', at(10, 0), true);
    tr.sample('M1', at(10, 1), true);
    tr.sample('M1', at(10, 2), false); // quoted pero no elegible
    const rows = tr.flushHour(at(11, 0));
    expect(rows).toEqual([
      { hour: at(10, 0), marketId: 'M1', eligibleMinutes: 2, quotedMinutes: 3 },
    ]);
    expect(tr.flushHour(at(11, 0))).toEqual([]); // ya flusheado
  });

  it('does not flush the still-open hour', () => {
    const tr = new EligibilityTracker();
    tr.sample('M1', at(10, 30), true);
    expect(tr.flushHour(at(10, 45))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/eligibility.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/mm-recorder/src/quoter/eligibility.ts
export interface EligibilityRow {
  hour: Date; marketId: string; eligibleMinutes: number; quotedMinutes: number;
}

/** Elegibilidad rewards por minuto EN MEMORIA; persistencia agregada por hora.
 *  (45 mercados x 1440 min/día en DB hundiría la e2-micro — spec §Operativa.) */
export class EligibilityTracker {
  // key marketId -> hourMs -> minute -> eligible
  private acc = new Map<string, Map<number, Map<number, boolean>>>();

  sample(marketId: string, time: Date, eligible: boolean): void {
    const hourMs = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), time.getUTCHours());
    const minute = time.getUTCMinutes();
    const hours = this.acc.get(marketId) ?? new Map();
    const mins = hours.get(hourMs) ?? new Map();
    mins.set(minute, (mins.get(minute) ?? false) || eligible);
    hours.set(hourMs, mins);
    this.acc.set(marketId, hours);
  }

  /** Devuelve y purga las horas COMPLETADAS (anteriores a la hora de `now`). */
  flushHour(now: Date): EligibilityRow[] {
    const nowHour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    const out: EligibilityRow[] = [];
    for (const [marketId, hours] of this.acc) {
      for (const [hourMs, mins] of hours) {
        if (hourMs >= nowHour) continue;
        let eligible = 0;
        for (const e of mins.values()) if (e) eligible += 1;
        out.push({ hour: new Date(hourMs), marketId, eligibleMinutes: eligible, quotedMinutes: mins.size });
        hours.delete(hourMs);
      }
    }
    return out.sort((a, b) => a.hour.getTime() - b.hour.getTime() || a.marketId.localeCompare(b.marketId));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/eligibility.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/eligibility.ts packages/mm-recorder/src/quoter/eligibility.test.ts
git commit -m "feat(mm-quoter): EligibilityTracker — minutos en memoria, filas por hora"
```

---

### Task 10: Persistence (tablas runtime + inserts)

**Files:**
- Create: `packages/mm-recorder/src/quoter/persistence.ts`
- Test: `packages/mm-recorder/src/quoter/persistence.test.ts`

- [ ] **Step 1: Write the failing tests** (patrón de `sink.test.ts`: exec mockeado)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { QuoterPersistence } from './persistence.js';

const fill = {
  time: new Date('2026-06-12T10:00:00Z'), tokenId: 'T', marketId: 'M',
  side: -1 as const, bound: 'trades' as const, price: 0.48, size: 20,
  queueInitial: 30, spreadAtPlacement: 0.04, volAtPlacement: 0.01,
  flags: '', midAtFill: 0.50,
};

describe('QuoterPersistence', () => {
  it('ensureSchema creates the four tables idempotently', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).ensureSchema();
    const sql = exec.mock.calls.map((c) => c[0]).join('\n');
    for (const t of ['mm_shadow_fills', 'mm_quoter_state', 'mm_quote_eligibility', 'mm_shadow_pnl']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });

  it('insertFill writes all fill columns', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).insertFill(fill);
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toContain('INSERT INTO mm_shadow_fills');
    expect(params).toEqual([
      fill.time, 'T', 'M', -1, 'trades', 0.48, 20, 30, 0.04, 0.01, '', 0.50,
    ]);
  });

  it('upsertState merges json state under a key', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    await new QuoterPersistence(exec).upsertState('engine', { mode: 'shadow', fills: 3 });
    const [sql, params] = exec.mock.calls[0];
    expect(sql).toContain('INSERT INTO mm_quoter_state');
    expect(sql).toContain('ON CONFLICT (key)');
    expect(params[0]).toBe('engine');
    expect(JSON.parse(params[1] as string)).toEqual({ mode: 'shadow', fills: 3 });
  });

  it('insertEligibility and insertPnl write hourly rows', async () => {
    const exec = vi.fn().mockResolvedValue({ rows: [] });
    const p = new QuoterPersistence(exec);
    await p.insertEligibility({ hour: fill.time, marketId: 'M', eligibleMinutes: 50, quotedMinutes: 60 }, 1.25);
    await p.insertPnl({ hour: fill.time, marketId: 'M', bound: 'trades', spreadPnl: 0.4, inventoryPnl: -0.1, estRewards: 1.25, fills: 3, replaces: 7 });
    expect(exec.mock.calls[0][0]).toContain('INSERT INTO mm_quote_eligibility');
    expect(exec.mock.calls[1][0]).toContain('INSERT INTO mm_shadow_pnl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/persistence.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/mm-recorder/src/quoter/persistence.ts
import type { ShadowFill } from './types.js';
import type { EligibilityRow } from './eligibility.js';

type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface PnlRow {
  hour: Date; marketId: string; bound: string;
  spreadPnl: number; inventoryPnl: number; estRewards: number | null;
  fills: number; replaces: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_shadow_fills (
  time timestamptz NOT NULL,
  token_id text NOT NULL,
  market_id text NOT NULL,
  side smallint NOT NULL,
  bound text NOT NULL,
  price numeric NOT NULL,
  size numeric NOT NULL,
  queue_initial numeric,
  spread_at_placement numeric,
  vol_at_placement numeric,
  flags text NOT NULL DEFAULT '',
  mid_at_fill numeric
);
CREATE INDEX IF NOT EXISTS mm_shadow_fills_tok_time ON mm_shadow_fills(token_id, time);
CREATE TABLE IF NOT EXISTS mm_quoter_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mm_quote_eligibility (
  hour timestamptz NOT NULL,
  market_id text NOT NULL,
  eligible_minutes int NOT NULL,
  quoted_minutes int NOT NULL,
  est_reward numeric,
  PRIMARY KEY (hour, market_id)
);
CREATE TABLE IF NOT EXISTS mm_shadow_pnl (
  hour timestamptz NOT NULL,
  market_id text NOT NULL,
  bound text NOT NULL,
  spread_pnl numeric NOT NULL,
  inventory_pnl numeric NOT NULL,
  est_rewards numeric,
  fills int NOT NULL,
  replaces int NOT NULL,
  PRIMARY KEY (hour, market_id, bound)
);
`;

export class QuoterPersistence {
  constructor(private exec: Exec) {}

  async ensureSchema(): Promise<void> { await this.exec(SCHEMA) }

  async insertFill(f: ShadowFill): Promise<void> {
    await this.exec(
      `INSERT INTO mm_shadow_fills(time,token_id,market_id,side,bound,price,size,queue_initial,spread_at_placement,vol_at_placement,flags,mid_at_fill)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [f.time, f.tokenId, f.marketId, f.side, f.bound, f.price, f.size,
       f.queueInitial, f.spreadAtPlacement, f.volAtPlacement, f.flags, f.midAtFill]);
  }

  async upsertState(key: string, value: object): Promise<void> {
    await this.exec(
      `INSERT INTO mm_quoter_state(key,value,updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]);
  }

  async insertEligibility(r: EligibilityRow, estReward: number | null): Promise<void> {
    await this.exec(
      `INSERT INTO mm_quote_eligibility(hour,market_id,eligible_minutes,quoted_minutes,est_reward)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (hour,market_id) DO UPDATE
       SET eligible_minutes = EXCLUDED.eligible_minutes, quoted_minutes = EXCLUDED.quoted_minutes, est_reward = EXCLUDED.est_reward`,
      [r.hour, r.marketId, r.eligibleMinutes, r.quotedMinutes, estReward]);
  }

  async insertPnl(r: PnlRow): Promise<void> {
    await this.exec(
      `INSERT INTO mm_shadow_pnl(hour,market_id,bound,spread_pnl,inventory_pnl,est_rewards,fills,replaces)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (hour,market_id,bound) DO UPDATE
       SET spread_pnl = EXCLUDED.spread_pnl, inventory_pnl = EXCLUDED.inventory_pnl,
           est_rewards = EXCLUDED.est_rewards, fills = EXCLUDED.fills, replaces = EXCLUDED.replaces`,
      [r.hour, r.marketId, r.bound, r.spreadPnl, r.inventoryPnl, r.estRewards, r.fills, r.replaces]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/persistence.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/persistence.ts packages/mm-recorder/src/quoter/persistence.test.ts
git commit -m "feat(mm-quoter): persistencia runtime (fills, state, eligibility, pnl horario)"
```

---

### Task 11: QuoteEngine (orquestador)

**Files:**
- Create: `packages/mm-recorder/src/quoter/engine.ts`
- Test: `packages/mm-recorder/src/quoter/engine.test.ts`

El engine recibe eventos ya parseados (book aplicado + trade), decide
(re)colocaciones con histéresis y TTL, alimenta dos InventoryBooks (uno por
bound) y persiste. Reloj = event time. La elegibilidad se muestrea en cada
evento de book (cubre cada minuto con actividad).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { QuoteEngine } from './engine.js';
import { loadConfig } from './config.js';
import { BookState } from '../bookState.js';

const t = (s: number) => new Date(Date.UTC(2026, 5, 12, 10, 0, s));

function setup(over: Record<string, string> = {}) {
  const cfg = loadConfig({ MM_QUOTER_MODE: 'shadow', ...over });
  const state = new BookState();
  const persistence = {
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    insertFill: vi.fn().mockResolvedValue(undefined),
    upsertState: vi.fn().mockResolvedValue(undefined),
    insertEligibility: vi.fn().mockResolvedValue(undefined),
    insertPnl: vi.fn().mockResolvedValue(undefined),
  };
  const engine = new QuoteEngine({
    cfg, state, persistence: persistence as never,
    marketByToken: new Map([['T', 'M']]),
    endDateByMarket: new Map([['M', new Date('2026-12-31T00:00:00Z')]]),
    rewardsByMarket: new Map(),
  });
  const book = (s: number, bid: number, ask: number, bidSize = 100, askSize = 100) => {
    const input = {
      time: t(s), tokenId: 'T', marketId: 'M', eventType: 'book' as const,
      bids: [{ price: bid, size: bidSize }], asks: [{ price: ask, size: askSize }],
    };
    const row = state.apply(input);
    engine.onBook(input, row);
  };
  return { engine, persistence, book };
}

describe('QuoteEngine', () => {
  it('places virtual quotes at the touch after a book event', () => {
    const { engine, book } = setup();
    book(0, 0.48, 0.52);
    expect(engine.activeQuote('T', -1)?.price).toBe(0.48);
    expect(engine.activeQuote('T', 1)?.price).toBe(0.52);
    expect(engine.activeQuote('T', -1)?.queueInitial).toBe(100); // cola = touch al colocar
  });

  it('a trade draining the queue produces persisted fills and inventory', async () => {
    const { engine, persistence, book } = setup();
    book(0, 0.48, 0.52, 10, 100);
    await engine.onTrade({ time: t(1), tokenId: 'T', marketId: 'M', price: 0.48, size: 50, side: 'SELL' });
    expect(persistence.insertFill).toHaveBeenCalled();
    const fill = persistence.insertFill.mock.calls[0][0];
    expect(fill.price).toBe(0.48);
    expect(engine.inventory('trades').position('M')).toBeGreaterThan(0);
  });

  it('re-quotes on price-out only after the hysteresis interval', () => {
    const { engine, book } = setup({ MM_REQUOTE_MIN_MS: '5000' });
    book(0, 0.48, 0.52);
    book(2, 0.49, 0.52);              // price-out a 2s < 5s -> mantiene
    expect(engine.activeQuote('T', -1)?.price).toBe(0.48);
    book(6, 0.49, 0.52);              // 6s >= 5s -> re-place al nuevo touch
    expect(engine.activeQuote('T', -1)?.price).toBe(0.49);
  });

  it('does not re-quote when our price is still the touch', () => {
    const { engine, book } = setup();
    book(0, 0.48, 0.52);
    const q0 = engine.activeQuote('T', -1);
    book(2, 0.48, 0.52, 500, 100);    // solo cambió el size
    expect(engine.activeQuote('T', -1)).toBe(q0); // misma quote, cola intacta
  });

  it('TTL expiry re-places with fresh queue', () => {
    const { engine, book } = setup({ MM_ORDER_TTL_MS: '10000' });
    book(0, 0.48, 0.52, 30, 100);
    book(11, 0.48, 0.52, 80, 100);    // TTL 10s superado -> re-place
    expect(engine.activeQuote('T', -1)?.queueInitial).toBe(80);
  });

  it('gap invalidates virtual quotes', () => {
    const { engine, book } = setup();
    book(0, 0.48, 0.52);
    engine.onGap();
    expect(engine.activeQuote('T', -1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/mm-recorder/src/quoter/engine.ts
import type { BookEvent, BookInput, TradeEvent } from '../types.js';
import type { BookState } from '../bookState.js';
import type { QuoterConfig } from './config.js';
import type { RewardsParams, Side } from './types.js';
import { desiredQuotes } from './quotePolicy.js';
import { InventoryBook } from './inventoryBook.js';
import { ShadowLedger, type Placement } from './shadowLedger.js';
import { VolTracker } from './volTracker.js';
import { EligibilityTracker } from './eligibility.js';
import type { QuoterPersistence } from './persistence.js';

export interface EngineDeps {
  cfg: QuoterConfig;
  state: BookState;
  persistence: QuoterPersistence;
  marketByToken: Map<string, string>;
  endDateByMarket: Map<string, Date>;
  rewardsByMarket: Map<string, RewardsParams>;
}

export class QuoteEngine {
  private ledger = new ShadowLedger();
  private vol: VolTracker;
  private eligibility = new EligibilityTracker();
  private inv = { trades: new InventoryBook(), cancels: new InventoryBook() };
  private lastRequote = new Map<string, number>(); // tokenId:side -> ms
  private replaces = 0;
  private mids = new Map<string, number>();

  constructor(private deps: EngineDeps) {
    this.vol = new VolTracker(deps.cfg.volWindowMs);
  }

  activeQuote(tokenId: string, side: Side) { return this.ledger.active(tokenId, side) }
  inventory(bound: 'trades' | 'cancels'): InventoryBook { return this.inv[bound] }

  onBook(input: BookInput, row: BookEvent | null): void {
    if (!row || row.mid === null) return;
    const { cfg } = this.deps;
    const tokenId = row.tokenId;
    this.vol.add(tokenId, row.time, row.mid);
    this.mids.set(row.marketId, row.mid);

    const marketId = this.deps.marketByToken.get(tokenId) ?? row.marketId;
    const endDate = this.deps.endDateByMarket.get(marketId);
    const invBook = this.inv.trades; // política usa el bound conservador
    const desired = desiredQuotes({
      bestBid: row.bestBid, bestAsk: row.bestAsk,
      recentVol: this.vol.recentVol(tokenId, row.time),
      msToResolution: endDate ? endDate.getTime() - row.time.getTime() : null,
      rewards: this.deps.rewardsByMarket.get(marketId) ?? null,
      inventoryShares: invBook.position(marketId),
      inventoryNotional: invBook.notional(marketId),
      totalNotional: invBook.totalNotional(),
    }, cfg);

    for (const side of [-1, 1] as Side[]) {
      const want = side === -1 ? desired.bid : desired.ask;
      const have = this.ledger.active(tokenId, side);
      const now = row.time.getTime();
      const key = `${tokenId}:${side}`;

      if (have && now - have.time.getTime() >= cfg.orderTtlMs) {
        this.replace(tokenId, side, want, row, 'ttl');
        continue;
      }
      if (!want) { if (have) { this.ledger.cancel(tokenId, side); this.replaces += 1; } continue }
      if (!have) { this.placeNew(tokenId, marketId, side, want.price, want.size, want.flags, row); continue }
      if (have.price !== want.price) {
        const last = this.lastRequote.get(key) ?? -Infinity;
        if (now - last >= cfg.requoteMinMs) this.replace(tokenId, side, want, row, 'priceout');
      }
    }

    // elegibilidad rewards: ambos lados quotados dentro de banda con >= minSize
    const rw = this.deps.rewardsByMarket.get(marketId);
    if (rw?.dailyRate) {
      const bid = this.ledger.active(tokenId, -1);
      const ask = this.ledger.active(tokenId, 1);
      const band = rw.maxSpreadCents != null ? rw.maxSpreadCents / 100 : Infinity;
      const minSize = rw.minSize ?? 0;
      const ok = !!bid && !!ask &&
        Math.abs(row.mid - bid.price) <= band && Math.abs(ask.price - row.mid) <= band &&
        bid.size >= minSize && ask.size >= minSize;
      this.eligibility.sample(marketId, row.time, ok);
    }
  }

  private placeNew(tokenId: string, marketId: string, side: Side, price: number,
                   size: number, flags: string[], row: BookEvent): void {
    const queue = this.deps.state.levelSize(tokenId, side, price) ?? 0;
    const spread = row.bestBid !== null && row.bestAsk !== null ? row.bestAsk - row.bestBid : null;
    const p: Placement = {
      tokenId, marketId, side, price, size, queueInitial: queue,
      time: row.time, spread, vol: this.vol.recentVol(tokenId, row.time), flags,
    };
    this.ledger.place(p);
    this.lastRequote.set(`${tokenId}:${side}`, row.time.getTime());
  }

  private replace(tokenId: string, side: Side,
                  want: { price: number; size: number; flags: string[] } | null,
                  row: BookEvent, _why: string): void {
    this.ledger.cancel(tokenId, side);
    this.replaces += 1;
    if (want) {
      const marketId = this.deps.marketByToken.get(tokenId) ?? row.marketId;
      this.placeNew(tokenId, marketId, side, want.price, want.size, want.flags, row);
    }
  }

  async onTrade(tr: TradeEvent): Promise<void> {
    if (tr.size === null) return;
    for (const side of [-1, 1] as Side[]) {
      const q = this.ledger.active(tr.tokenId, side);
      if (!q) continue;
      const level = this.deps.state.levelSize(tr.tokenId, side, q.price);
      const fills = this.ledger.onTrade(
        { tokenId: tr.tokenId, time: tr.time, price: tr.price, size: tr.size }, level);
      for (const f of fills) {
        f.midAtFill = this.mids.get(f.marketId) ?? null;
        this.inv[f.bound].applyFill(f.marketId, f.side, f.price, f.size);
        await this.deps.persistence.insertFill(f);
      }
    }
  }

  onGap(): void { this.ledger.clearAll() }

  /** Flush horario: elegibilidad + pnl + estado. Llamar con un timer. */
  async flushHourly(now: Date): Promise<void> {
    for (const row of this.eligibility.flushHour(now)) {
      const rw = this.deps.rewardsByMarket.get(row.marketId);
      const est = rw?.dailyRate ? (rw.dailyRate * row.eligibleMinutes) / (24 * 60) : null;
      await this.deps.persistence.insertEligibility(row, est);
    }
    for (const bound of ['trades', 'cancels'] as const) {
      const book = this.inv[bound];
      for (const marketId of this.deps.marketByToken.values()) {
        if (book.position(marketId) === 0 && book.realized(marketId) === 0) continue;
        const mid = this.mids.get(marketId);
        await this.deps.persistence.insertPnl({
          hour: new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 3_600_000),
          marketId, bound,
          spreadPnl: book.realized(marketId),
          inventoryPnl: book.position(marketId) * ((mid ?? book.avgPrice(marketId)) - book.avgPrice(marketId)),
          estRewards: null, fills: 0, replaces: this.replaces,
        });
      }
    }
    await this.deps.persistence.upsertState('engine', {
      mode: this.deps.cfg.mode, replaces: this.replaces,
      equityTrades: this.inv.trades.equity(this.mids),
      equityCancels: this.inv.cancels.equity(this.mids),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/engine.test.ts`
Expected: PASS (6 tests). Si la mecánica difiere en detalles, ajustar implementación (no los contratos del test).

- [ ] **Step 5: Run full package suite**

Run: `cd packages/mm-recorder && npx vitest run`
Expected: PASS — todos los tests del paquete (los previos + quoter)

- [ ] **Step 6: Commit**

```bash
git add packages/mm-recorder/src/quoter/engine.ts packages/mm-recorder/src/quoter/engine.test.ts
git commit -m "feat(mm-quoter): QuoteEngine — orquestación de policy/ledger/persistencia"
```

---

### Task 12: Wiring — onEvent hook, universo con end_date, arranque shadow

**Files:**
- Modify: `packages/mm-recorder/src/wsClient.ts` (hook `onEvent` en `RecorderDeps`)
- Modify: `packages/mm-recorder/src/selectUniverse.sql` y `selectUniverse.ts` (añadir `end_date`)
- Modify: `packages/mm-recorder/src/index.ts` (arranque del engine si `MM_QUOTER_MODE=shadow`)
- Test: `packages/mm-recorder/src/wsClient.test.ts` (añadir)

- [ ] **Step 1: Write the failing test** (hook en wsClient — añadir a su test file, siguiendo el patrón de mocks existente del fichero)

```typescript
describe('onEvent hook', () => {
  it('RecorderDeps accepts an optional onEvent that receives parsed events', () => {
    // Test de tipo/contrato: construir deps con onEvent y verificar que
    // el handler de mensajes lo invoca para book y trade.
    const calls: string[] = [];
    const deps = {
      assetIds: ['T'],
      state: { apply: () => null, midOf: () => null } as never,
      sink: { addBook: async () => {}, addTrade: async () => {} } as never,
      recordGap: async () => {},
      onEvent: (kind: string) => calls.push(kind),
    };
    // handleMessage se extrae para testearlo sin WS real
    handleMessage(deps as never, JSON.stringify([
      { event_type: 'last_trade_price', asset_id: 'T', market: '0x1', price: '0.5', size: '10', side: 'SELL', timestamp: '1760000000000' },
    ]));
    expect(calls).toContain('trade');
  });
});
```

- [ ] **Step 2: Refactor wsClient** — extraer el cuerpo de `ws.on('message')` a una función exportada `handleMessage(deps, raw)` y añadir el hook:

```typescript
export interface RecorderDeps {
  assetIds: string[];
  state: BookState;
  sink: BatchSink;
  recordGap: (start: Date, end: Date, reason: string) => Promise<void>;
  /** Hook opcional para consumidores adicionales (QuoteEngine). Se llama
   *  DESPUÉS de aplicar el evento al BookState. */
  onEvent?: (kind: 'book' | 'trade', event: unknown, row: unknown) => void;
}

export async function handleMessage(deps: RecorderDeps, raw: string): Promise<void> {
  if (raw === 'PONG') return;
  for (const out of parseMessage(raw)) {
    if (out.kind === 'book') {
      const row = deps.state.apply(out.event);
      if (row) await deps.sink.addBook(row);
      deps.onEvent?.('book', out.event, row);
    } else if (out.kind === 'trade') {
      await deps.sink.addTrade(out.event);
      deps.onEvent?.('trade', out.event, null);
    }
  }
}
// y en connect(): ws.on('message', (data) => void handleMessage(deps, data.toString()));
```

El gap del reconnect también notifica: en `ws.on('open')`, tras `gaps.up(...)`, llamar `deps.onEvent?.('book', { gap: true }, null)` NO — más limpio: añadir `onGap?: () => void` a deps y llamarlo donde se registra el gap. Implementarlo así:

```typescript
  onGap?: () => void;
// en open(), si gap !== null: deps.onGap?.();
```

- [ ] **Step 3: Universo con end_date** — en `selectUniverse.sql` añadir `m.end_date` al SELECT; en `selectUniverse.ts` añadir `end_date: Date | null` al tipo de fila devuelta. Verificar con el test existente del selector (ajustar fixture si lo hay).

- [ ] **Step 4: Arranque en index.ts** (después de `runRecorder`, sustituyendo la construcción de `handle`):

```typescript
import { loadConfig } from './quoter/config.js';
import { QuoteEngine } from './quoter/engine.js';
import { QuoterPersistence } from './quoter/persistence.js';
import type { BookInput, TradeEvent } from './types.js';

// ... dentro de main(), tras crear sink/state:
const quoterCfg = loadConfig(process.env);
let engine: QuoteEngine | null = null;
if (quoterCfg.mode === 'shadow') {
  const persistence = new QuoterPersistence((sql, params) => query(sql, params ?? []));
  await persistence.ensureSchema();
  const rewardsByMarket = new Map<string, import('./quoter/types.js').RewardsParams>();
  const loadRewards = async () => {
    const r = await query(
      `SELECT DISTINCT ON (market_id) market_id, min_size, max_spread, daily_rate
       FROM mm_reward_snapshots ORDER BY market_id, time DESC`, []);
    for (const row of (r as { rows: Array<Record<string, unknown>> }).rows) {
      rewardsByMarket.set(String(row.market_id), {
        minSize: row.min_size === null ? null : Number(row.min_size),
        maxSpreadCents: row.max_spread === null ? null : Number(row.max_spread),
        dailyRate: row.daily_rate === null ? null : Number(row.daily_rate),
      });
    }
  };
  await loadRewards().catch((e) => logger.warn({ e }, 'rewards load failed'));
  setInterval(() => loadRewards().catch(() => undefined), 24 * 60 * 60 * 1000);

  engine = new QuoteEngine({
    cfg: quoterCfg, state, persistence,
    marketByToken,
    endDateByMarket: new Map(universe.filter((r) => r.end_date).map((r) => [r.market_id, new Date(r.end_date!)])),
    rewardsByMarket,
  });
  setInterval(() => engine!.flushHourly(new Date()).catch((e) => logger.warn({ e }, 'quoter flush failed')), 5 * 60_000);
  logger.info('shadow quoter started');
}

const handle = runRecorder({
  assetIds, state: stateProxy, sink, recordGap,
  onEvent: engine ? (kind, event, row) => {
    if (kind === 'book') engine!.onBook(event as BookInput, row as never);
    else void engine!.onTrade(event as TradeEvent);
  } : undefined,
  onGap: engine ? () => engine!.onGap() : undefined,
});
```

Nota: `mm_reward_snapshots.market_id` guarda el **condition_id** (fix `d739823`); `marketByToken` mapea token→market_id del universo. El engine indexa rewards por el market_id del universo — usar `universe` para construir un mapa `condition_id → market_id` y traducir al cargar:

```typescript
  const marketByCondition = new Map(universe.filter((r) => r.condition_id).map((r) => [r.condition_id!, r.market_id]));
  // en loadRewards(): const mkt = marketByCondition.get(String(row.market_id)); if (mkt) rewardsByMarket.set(mkt, {...});
```

- [ ] **Step 5: Run full suite + typecheck**

Run: `cd packages/mm-recorder && npx vitest run && npx tsc --noEmit`
Expected: PASS / sin errores

- [ ] **Step 6: Commit**

```bash
git add packages/mm-recorder/src/wsClient.ts packages/mm-recorder/src/wsClient.test.ts packages/mm-recorder/src/selectUniverse.sql packages/mm-recorder/src/selectUniverse.ts packages/mm-recorder/src/index.ts
git commit -m "feat(mm-quoter): wiring — onEvent/onGap hooks, end_date en universo, arranque shadow"
```

---

### Task 13: Replay fixture de regresión

**Files:**
- Create: `packages/mm-recorder/src/quoter/replay.test.ts`
- Create: `packages/mm-recorder/src/quoter/fixtures/replay-day.json` (generado en el step 1)
- Create: `packages/mm-recorder/src/quoter/fixtures/replay-expected.json` (snapshot)

- [ ] **Step 1: Build the fixture** — secuencia sintética-realista de ~200 eventos (book snapshots, deltas, trades) para 2 tokens cubriendo: barrido direccional, mean-reversion, price-out, TTL, gap. Generarla con un script inline en el test (determinista, sin `Math.random`) y volcarla a `replay-day.json` — o construirla a mano. El formato: `Array<{ kind: 'book'|'trade'|'gap', ...evento }>`.

- [ ] **Step 2: Write the replay test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { QuoteEngine } from './engine.js';
import { loadConfig } from './config.js';
import { BookState } from '../bookState.js';

it('replay fixture produces the committed fill sequence (regression)', async () => {
  const events = JSON.parse(readFileSync(new URL('./fixtures/replay-day.json', import.meta.url), 'utf-8'));
  const fills: unknown[] = [];
  const persistence = {
    ensureSchema: vi.fn(), insertFill: vi.fn((f) => { fills.push(f); return Promise.resolve(); }),
    upsertState: vi.fn().mockResolvedValue(undefined),
    insertEligibility: vi.fn().mockResolvedValue(undefined),
    insertPnl: vi.fn().mockResolvedValue(undefined),
  };
  const state = new BookState();
  const engine = new QuoteEngine({
    cfg: loadConfig({ MM_QUOTER_MODE: 'shadow' }), state, persistence: persistence as never,
    marketByToken: new Map([['T1', 'M1'], ['T2', 'M2']]),
    endDateByMarket: new Map([['M1', new Date('2026-12-31')], ['M2', new Date('2026-12-31')]]),
    rewardsByMarket: new Map([['M1', { minSize: 20, maxSpreadCents: 3.5, dailyRate: 50 }]]),
  });
  for (const e of events) {
    if (e.kind === 'gap') engine.onGap();
    else if (e.kind === 'book') { const input = { ...e.event, time: new Date(e.event.time) }; engine.onBook(input, state.apply(input)); }
    else await engine.onTrade({ ...e.event, time: new Date(e.event.time) });
  }
  const expected = JSON.parse(readFileSync(new URL('./fixtures/replay-expected.json', import.meta.url), 'utf-8'));
  expect(JSON.parse(JSON.stringify(fills))).toEqual(expected);
});
```

- [ ] **Step 3: Generate the snapshot** — primera ejecución: volcar `fills` a `replay-expected.json`, **revisar a mano que los fills tienen sentido** (precios anclados, bounds ordenados, flags correctos) y committear.

- [ ] **Step 4: Run to verify deterministic pass**

Run: `cd packages/mm-recorder && npx vitest run src/quoter/replay.test.ts` (2 veces)
Expected: PASS ambas

- [ ] **Step 5: Commit**

```bash
git add packages/mm-recorder/src/quoter/replay.test.ts packages/mm-recorder/src/quoter/fixtures/
git commit -m "test(mm-quoter): replay fixture de regresión con snapshot de fills"
```

---

### Task 14: Export SQL + validator H-MM-4 + registry + weekly cron

**Files:**
- Create: `scripts/edge-research/mm_shadow_fills.sql`
- Create: `scripts/edge-research/validators/mm_shadow.py`
- Modify: `scripts/edge-research/data.py` (dataset `mm_shadow_fills`)
- Modify: `scripts/edge-research/registry.yaml` (entrada H-MM-4)
- Modify: `scripts/edge-research/run.py` (wiring)
- Modify: `.github/workflows/edge-research-weekly.yml` (export)
- Test: `scripts/edge-research/tests/test_mm_shadow.py`

- [ ] **Step 1: Export SQL** (patrón de `mm_fine_fills.sql` — forward mids desde `mm_book_events`):

```sql
-- H-MM-4 export: shadow fills + forward mids. WINDOW: psql -v win='14 days'.
\if :{?win}
\else
  \set win '14 days'
\endif

CREATE TEMP TABLE be AS
  SELECT token_id, time AS bt, mid FROM mm_book_events
  WHERE time > NOW() - INTERVAL :'win' AND mid IS NOT NULL;
CREATE INDEX ON be (token_id, bt);
ANALYZE be;

COPY (
  SELECT f.time, f.token_id, f.market_id, m.market_type, f.side, f.bound,
         f.price, f.size, f.queue_initial, f.spread_at_placement,
         f.vol_at_placement, f.flags,
    (SELECT mid FROM be WHERE be.token_id=f.token_id AND be.bt > f.time AND be.bt <= f.time + INTERVAL '10 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_10s,
    (SELECT mid FROM be WHERE be.token_id=f.token_id AND be.bt > f.time AND be.bt <= f.time + INTERVAL '60 seconds'  ORDER BY be.bt DESC LIMIT 1) AS mid_60s,
    (SELECT mid FROM be WHERE be.token_id=f.token_id AND be.bt > f.time AND be.bt <= f.time + INTERVAL '300 seconds' ORDER BY be.bt DESC LIMIT 1) AS mid_300s
  FROM mm_shadow_fills f
  JOIN markets m ON m.condition_id = f.market_id OR m.id::text = f.market_id
  WHERE f.time > NOW() - INTERVAL :'win'
) TO STDOUT WITH CSV HEADER;
```

(Nota: el join doble cubre que `market_id` del quoter es el market_id del universo — verificar en la implementación cuál persiste y simplificar el join al campo correcto.)

- [ ] **Step 2: Validator test** (patrón `test_mm_fine.py` — helpers `_ctx`/`_row` adaptados):

```python
import pandas as pd
import types
from validators.mm_shadow import MMShadowValidator

def _ctx(df, min_n=1):
    return types.SimpleNamespace(datasets={"mm_shadow_fills": df}, cost=0.005,
                                 computed_at="x", n_bins=10, min_n=200,
                                 mm_min_n=min_n, seed=7)

def _row(tt, side, bound, price, mid_after, market_type="event_financial", flags="", spread=0.04):
    return {"time": pd.Timestamp(tt, tz="UTC"), "token_id": "T", "market_id": "M",
            "market_type": market_type, "side": side, "bound": bound,
            "price": price, "size": 20, "queue_initial": 30,
            "spread_at_placement": spread, "vol_at_placement": 0.0, "flags": flags,
            "mid_10s": mid_after, "mid_60s": mid_after, "mid_300s": mid_after}

def test_profitable_bid_fill_passes():
    rows = [_row(f"2026-06-12T10:{i:02d}:00", -1, "trades", 0.48, 0.50) for i in range(60)]
    v = MMShadowValidator()
    out = v.run(_ctx(pd.DataFrame(rows)))
    fin = next(r for r in out if r.class_metric["cohort"] == "event_financial:60s:trades")
    assert fin.status == "pass"
    assert fin.edge_net_pct > 0

def test_adverse_ask_fill_fails():
    rows = [_row(f"2026-06-12T10:{i:02d}:00", 1, "trades", 0.48, 0.52) for i in range(60)]
    v = MMShadowValidator()
    out = v.run(_ctx(pd.DataFrame(rows)))
    fin = next(r for r in out if r.class_metric["cohort"] == "event_financial:60s:trades")
    assert fin.status == "fail"

def test_flagged_fills_form_their_own_cohort():
    rows = ([_row(f"2026-06-12T10:{i:02d}:00", -1, "trades", 0.48, 0.50) for i in range(30)] +
            [_row(f"2026-06-12T11:{i:02d}:00", -1, "trades", 0.49, 0.50, flags="exit_improve") for i in range(30)])
    v = MMShadowValidator()
    labels = {r.class_metric["cohort"] for r in v.run(_ctx(pd.DataFrame(rows)))}
    assert "flag:exit_improve:60s:trades" in labels
```

- [ ] **Step 3: Implement validator** (estructura calcada de `mm_fine.py`, sin walk — los fills ya vienen hechos):

```python
# scripts/edge-research/validators/mm_shadow.py
from __future__ import annotations
import numpy as np
from verdict import Verdict
from validators.base import bootstrap_ci

_CAVEAT = ("shadow live-quoting: cola inicial exacta, drain bounds trades/cancels; "
           "cancels-ahead inobservable (bound optimista); sin órdenes reales")
_HORIZONS = [("10s", "mid_10s"), ("60s", "mid_60s"), ("300s", "mid_300s")]


class MMShadowValidator:
    """H-MM-4 — retained de fills sombra del quoter (cola exacta)."""

    hypothesis_id = "H-MM-4"
    hclass = "market_making"

    def required_inputs(self):
        return ["mm_shadow_fills"]

    def run(self, ctx):
        df = ctx.datasets["mm_shadow_fills"].copy()
        df["tradeable"] = df["market_type"] != "event_long"
        for hname, hcol in _HORIZONS:
            df[f"ret_{hname}"] = df["side"] * (df["price"] - df[hcol])

        groups = [("headline:tradeable", df["tradeable"])]
        for mt in sorted(df["market_type"].dropna().unique()):
            groups.append((mt, df["market_type"] == mt))
        for flag in ("exit_improve", "rewards_constrained"):
            m = df["flags"].fillna("").str.contains(flag)
            if m.any():
                groups.append((f"flag:{flag}", m))

        out = []
        for label, mask in groups:
            base = df[mask]
            for hname, _ in _HORIZONS:
                for bound in ("trades", "cancels"):
                    sub = base[base["bound"] == bound]
                    out.append(self._verdict(ctx, f"{label}:{hname}:{bound}", sub, f"ret_{hname}"))
        return out

    def _verdict(self, ctx, cohort, sub, retcol):
        floor = getattr(ctx, "mm_min_n", 200)
        vals = sub[retcol].dropna().to_numpy(float) if len(sub) else np.array([])
        n = int(vals.size)
        if n < floor:
            return Verdict(self.hypothesis_id, self.hclass, n, None, None, None,
                           "full", {"cohort": cohort}, "maker_fee_0", "inconclusive",
                           [_CAVEAT, f"n={n} below floor {floor}"], ctx.computed_at)
        edge = float(vals.mean())
        lo, hi = bootstrap_ci(vals, seed=ctx.seed)
        status = "pass" if (edge > 0 and lo > 0) else "fail"
        return Verdict(self.hypothesis_id, self.hclass, n, edge, edge,
                       float((hi - lo) / 2), "full", {"cohort": cohort}, "maker_fee_0",
                       status, [_CAVEAT], ctx.computed_at)
```

- [ ] **Step 4: Wire dataset + registry + run.py** — en `data.py` añadir bloque análogo a `mm_fine_fills` para `mm_shadow_fills.csv` (date_cols `["time"]`); en `registry.yaml` la entrada H-MM-4 (`requires: [mm_shadow_fills]`, clase market_making); en `run.py` importar y registrar `"H-MM-4": MMShadowValidator` en `VALIDATORS`. En el weekly yml, añadir el export con el mismo patrón scp + `docker exec -i` que `mm_fine_fills.sql`.

- [ ] **Step 5: Run python tests**

Run: `cd scripts/edge-research && python -m pytest tests/ -q`
Expected: PASS (suite completa + test_mm_shadow)

- [ ] **Step 6: Commit**

```bash
git add scripts/edge-research/mm_shadow_fills.sql scripts/edge-research/validators/mm_shadow.py scripts/edge-research/data.py scripts/edge-research/registry.yaml scripts/edge-research/run.py scripts/edge-research/tests/test_mm_shadow.py .github/workflows/edge-research-weekly.yml
git commit -m "feat(edge-research): validator H-MM-4 (shadow quoter) + export semanal"
```

---

### Task 15: Activación en compose (PR de deploy)

**Files:**
- Modify: `docker-compose.gcp.yml` (servicio mm-recorder: añadir `MM_QUOTER_MODE=shadow` y, explícitos, `MM_QUOTE_SIZE=20`, `MM_ORDER_TTL_MS=1800000`)

- [ ] **Step 1:** Añadir las env vars al servicio mm-recorder del compose. NO añadir `MM_MIN_SPREAD` ni `MM_VOL_PAUSE` (defaults shadow-permisivos correctos).

- [ ] **Step 2:** Commit + push a main (deploy vía CI). En la VM: `docker compose -f docker-compose.gcp.yml pull && docker compose -f docker-compose.gcp.yml up -d mm-recorder` (perfil capture).

- [ ] **Step 3: Verificación en VM (gate de cierre del plan):**

```bash
# contenedor sano y quoter arrancado
docker logs polymarket-mm-recorder --since 10m 2>&1 | grep -E "shadow quoter started|recorder started"
# fills sombra acumulándose (tras ~1h)
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading \
  -c "SELECT bound, COUNT(*), MIN(time), MAX(time) FROM mm_shadow_fills GROUP BY 1;"
# RAM dentro de budget
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}' | grep mm-recorder
```

Expected: log de arranque presente; filas en ambos bounds creciendo; RAM < 120MB.

- [ ] **Step 4: Commit final y nota**

Anotar en la memoria del proyecto la fecha de activación (el reloj de los ≥7 días del gate shadow→real empieza aquí).

---

## Self-Review (ejecutada al escribir)

- **Spec coverage:** QuotePolicy guards/exit_improve/rewards_constrained (T4), cola exacta + bounds (T6-7), TTL/price-out/histéresis (T8, T11), elegibilidad agregada (T9), PnL descompuesto e inventario (T5, T11), persistencia 4 tablas (T10), identidad shadow↔live (la garantiza la arquitectura: una sola QuotePolicy pura — el test de policy ES el contrato), replay fixture (T13), H-MM-4 + cron (T14), activación + verificación (T15). El kill-switch live y OrderGateway quedan para el plan de la fase real (gate).
- **Round-trip completion:** cubierta por `mm_shadow_pnl.spread_pnl` (realized = round-trips) vs `inventory_pnl`; la query del gate la lee de ahí.
- **Vol pause y spread floor:** implementados y testeados en policy; el shadow corre permisivo (defaults) y registra `vol_at_placement`/`spread_at_placement` por fill para aprender los umbrales — como pide el spec.
- **Type consistency:** `Side`, `DrainBound`, `ShadowFill`, `RewardsParams` definidos en T1 y usados idénticos en T6-T11; `levelSize(tokenId, side, price)` definido en T2 y usado en T11.
