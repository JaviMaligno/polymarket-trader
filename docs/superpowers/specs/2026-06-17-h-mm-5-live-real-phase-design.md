# H-MM-5 — Fase real del market-maker (implementación live)

**Fecha:** 2026-06-17
**Estado:** diseño aprobado en sesión; pendiente de plan de implementación
**Predecesor:** [`2026-06-12-h-mm-level3-live-quoting-design.md`](./2026-06-12-h-mm-level3-live-quoting-design.md)
(fase shadow, ya construida y desplegada gated-off → shadow activado 2026-06-14).

## Contexto

La fase shadow del quoter (`packages/mm-recorder/src/quoter/`) está en producción
desde 2026-06-14 16:05 UTC midiendo con cola exacta. El gate shadow→real (H-MM-4)
se lee a los ≥7 días → **cron del 2026-06-22**. H-MM-1 PASS (proxy passive-maker
~35bps/fill) y H-MM-3 PASS con bounds front/back; el 2026-06-17 cerró la última
cohorte tradeable pendiente (event_short back: 60s +1.00% n=226 PASS, 300s +0.66%
n=233 PASS — corrida manual del harness).

El **diseño** de la fase real ya está esbozado en el spec del 06-12 (secciones
"Fase real — OrderGateway y RiskGuard", "Gate shadow → real", testing). Este
documento es el spec **de implementación plan-ready**: rellena los huecos que el
06-12 dejó (layout de módulos, reconciliación, esquema de tablas live, máquina de
estados del kill-switch, runbook de activación) y deja como **placeholders
explícitos** los parámetros que salen del gate del 06-22.

Este spec NO re-litiga las decisiones del 06-12 (join-the-touch, GTD dead-man's
switch, RiskGuard defaults de prueba, no auto-flatten, cancel-all al boot, key
desde Secret Manager). Las asume y las concreta.

## Decisiones tomadas (2026-06-17)

| Decisión | Elección | Motivo |
|---|---|---|
| Artefacto en paralelo al gate | Spec de implementación live (este doc) | El diseño del 06-12 basta como diseño; falta el plan |
| Reutilización cross-proceso | **Fresco en mm-recorder, mínimo compartido** | El ciclo maker ≠ taker single-shot; cero riesgo al path taker del dashboard |
| Utilidades pequeñas | Copiar patrón `loadPrivateKey` + lectura de balance | ~30 líneas; un paquete compartido no compensa el acoplamiento |
| Kill-switch | One-way `running→killed` en v1 | Fail-safe; re-arm manual por env/PR |
| Validator de la fase | H-MM-5 (reservado en el 06-12) | `mm_live_fills` simétrica a `mm_shadow_fills` |

## ¿Por qué fresco y no reutilizar el taker?

La infra real-trading del dashboard (`packages/dashboard/src/services/`) es
**taker-only**:

- `RealExecutor.execute({tokenId, side, price, size})` → fill-or-fail con
  slippage. Sin ciclo de vida de limit order (post/cancel/replace/GTD), sin
  tracking de órdenes vivas. No sirve para maker quoting.
- `ExecutionRouter` enruta paper/dry_run/real; patrón de modo útil pero
  dashboard-side.
- `WalletMonitor` (balance USDC + kill por saldo bajo) y `SecretManager.loadPrivateKey`
  (GCP Secret Manager → fallback `POLYGON_PRIVATE_KEY`) **son patrones
  reutilizables**, pero viven en otro proceso.

El quoter vive en `packages/mm-recorder` (proceso separado, perfil `capture`).
Compartir cruzaría el límite de proceso y tocaría el path taker en producción.
La duplicación es trivial (`loadPrivateKey` ~30 líneas, una llamada de balance) y
preferible al acoplamiento. **`OrderGateway` es genuinamente nuevo** porque el
ciclo de vida maker no existe en ninguna parte del repo.

## Arquitectura — módulos nuevos

Bajo `packages/mm-recorder/src/quoter/live/` (mismo proceso, perfil `capture`,
activado por `MM_QUOTER_MODE=live`):

```
QuoteEngine (existente)
   │  modo=live
   ├─> QuotePolicy (existente, PURO) ──> quotes deseadas
   │        (el MISMO que alimenta shadow — garantía de identidad)
   v
RiskGuard ──(ok)──> OrderGateway ──post/cancel/replace──> CLOB (clob-client)
   │  (breach→kill)        │
   │                       ├─ fills (WS user-channel | REST poll)
   v                       v
mm_quoter_state        LiveLedger ──> mm_live_orders / mm_live_fills
(kill_state, mode)         │  inventario real (cash + M2M)
                           └─ RiskGuard.check(fill)
```

- `orderGateway.ts` — wrapper de `@polymarket/clob-client`: `postLimit` (GTD),
  `cancel`, `cancelAll`, `replace` (=cancel+post). Reconciliación de fills.
- `liveLedger.ts` — espejo de la interfaz de `shadowLedger` pero con órdenes y
  fills REALES; mantiene el inventario real (cash + mark-to-market); persiste
  `mm_live_orders`/`mm_live_fills`.
- `riskGuard.ts` — límites + kill-switch (máquina de estados); persiste a
  `mm_quoter_state`.
- `secret.ts` — copia del patrón `loadPrivateKey` (Secret Manager → env fallback).
- `walletBalance.ts` — lectura de balance USDC (viem/clob-client) + kill por
  saldo bajo (patrón `WalletMonitor`, ligero, sin la infra de cooldown del
  dashboard salvo lo necesario).
- `notify.ts` — notificación mínima por un canal que funcione (Gmail/issue;
  **NO** el webhook de Slack, documentado muerto).

`QuoteEngine` gana una rama `live` junto a la `shadow` existente. El mismo
`QuotePolicy` (función pura) alimenta ambas: ése es el invariante que garantiza
que lo medido en shadow predice al live.

## OrderGateway — ciclo de vida y reconciliación

- **Post:** orden GTD limit al **precio de colocación** (no al best del momento
  del fill — lección del fix `mm_fine.py` 2026-06-12), TTL=`MM_ORDER_TTL`
  (default 30 min), size=quote size. Devuelve `order_id`; se registra en
  `mm_live_orders` con status `open`.
- **Replace = cancel + post** (resetea la cola). La histéresis del `QuotePolicy`
  (price-out o salida de banda rewards; nunca por cambio de tamaño del touch;
  intervalo mínimo por token) gobierna cuándo se reemplaza.
- **Cancel-all:**
  - Al **boot** en modo live: incondicional, antes de quotar (sin reconciliar
    órdenes órfanas en v1 — fuera de alcance).
  - En **SIGTERM**: graceful (las GTD expirarían solas igualmente — doble
    cinturón).
  - En **kill-switch**.
- **Reconciliación de fills:** preferir el **WS user-channel** si el clob-client
  lo expone; si no, **REST poll** del status de las órdenes abiertas a intervalo
  (~2–5 s). La elección se concreta en implementación tras un smoke de capacidad
  del clob-client (la re-validación de drift del client ya es item del gate). Cada
  fill → `LiveLedger.update(fill)` + `RiskGuard.check()`.
- **Idempotencia:** el gateway trackea sus `order_id`; eventos/fills de ids
  desconocidos se ignoran (defensivo ante eco del WS o doble-entrega).

## LiveLedger y esquema

Dos tablas runtime nuevas (`CREATE TABLE IF NOT EXISTS` al boot — las migraciones
init solo corren en el primer volumen, gotcha conocido):

```sql
mm_live_orders(
  time timestamptz, token_id text, order_id text,
  side smallint,              -- -1 bid, +1 ask
  price double precision, size double precision,
  status text,                -- open | filled | cancelled | expired
  ttl_expires_at timestamptz,
  reason text,                -- placement reason (join_touch | exit_improve | rewards_edge)
  rewards_constrained boolean, exit_improve boolean
);

mm_live_fills(
  time timestamptz, token_id text, order_id text,
  side smallint, fill_price double precision, fill_size double precision,
  queue_ahead_initial double precision,   -- touch size al colocar (verdad exacta en live)
  spread_at_placement double precision,
  mid_before double precision,
  flags text                              -- rewards_constrained, exit_improve
);
```

`mm_live_fills` es **simétrica a `mm_shadow_fills`** a propósito: el validator
H-MM-5 reusa el walk de H-MM-4 **menos la simulación de cola** (los fills son
reales, no hay drain bounds que estimar — la verdad de cola es exacta). Los mids
forward (10s/60s/300s) los calcula el validator desde `mm_book_events`, sin
cómputo extra en runtime.

`LiveLedger` mantiene el **inventario real** por mercado: cash + mark-to-market al
mid. Hereda los invariantes contables del `inventoryBook` shadow (historial de
bugs de signo del proyecto):

- `cash + M2M_inventario = PnL_total`.
- round-trip completo a `p_bid < p_ask` ⇒ `realized = (p_ask − p_bid) × size`
  exacto.

## RiskGuard — máquina de estados del kill-switch

Estado persistido en `mm_quoter_state.kill_state`:

```
running ──(breach)──> killed       [one-way en v1; re-arm = acción manual env/PR]
```

Chequeos en **cada fill** + un **tick periódico** (para el M2M con el book
moviéndose sin fills):

| Límite (env, default prueba) | Acción |
|---|---|
| `MM_MAX_INVENTORY_PER_MARKET=$20` | soft: `QuotePolicy` retira el lado que aumenta; hard breach → kill |
| `MM_MAX_INVENTORY_TOTAL=$60` | igual |
| `MM_MAX_NOTIONAL_TOTAL=$100` | cap sobre Σ notional de órdenes abiertas; breach → no postear más + kill si persiste |
| `MM_MAX_CUM_LOSS=$50` (realized + M2M) | kill |
| balance USDC < umbral | kill |

**Acción de kill:** `cancelAll`, `mode=off` persistido en `mm_quoter_state`,
`notify`. **Sin auto-flatten** — el inventario residual (≤$20/mercado) queda a
decisión humana; cruzar el spread para cerrarlo es pagar lo que intentamos cobrar.

El **daily watchdog** lee `mm_quoter_state` (kill_state, mode, última actividad) y
alerta de staleness si en live no hay renovación GTD en >2×TTL (parada silenciosa:
sin riesgo gracias a las GTD, pero el quoter dejó de quotar).

## Runbook de activación

**Pre-requisitos** (compartidos con el track real-trading, [[project_real_trading]]):

1. Wallet dedicada, fundada con USDC (micro) + MATIC para gas.
2. Private key en **GCP Secret Manager**; en `docker-compose.gcp.yml` va el
   **nombre del secret** (`MM_WALLET_SECRET_NAME`), nunca la key.
3. IAM: rol de acceso al secret para el service account de la VM.

**Parámetros del gate (06-22)** — placeholders a rellenar con el verdict H-MM-4:

- `MM_LIVE_SUBSET` — mercados/cohortes con retained positivo en su banda +
  round-trip completion demostrada + rewards activo + vol dentro del umbral.
- `MM_MIN_SPREAD_CENTS` — de la curva retained-vs-banda-de-spread.
- `MM_QUOTE_SIZE` — `max(rewardsMinSize, default)`.
- umbral de `volatility pause` — de la curva retained-vs-vol-previa.
- capital — `MM_MAX_NOTIONAL_TOTAL` / `MM_MAX_CUM_LOSS` (defaults prueba $100/$50).

**Activación:**

1. Smoke del clob-client en **dry-run** en la VM (post/cancel/GTD-renew, capacidad
   de WS user-channel) — confirma que no hay drift de versión.
2. **PR a `docker-compose.gcp.yml`** con `MM_QUOTER_MODE=live` + envs de riesgo
   (nunca edición directa en la VM — rompe el `git pull` del deploy). Deploy.
3. Día 1 con micro-capital ($100); review humana antes de escalar.
4. Monitoreo: stats horarias al log (quotes activas, fills, inventario, PnL,
   elegibilidad rewards); watchdog diario.

## Medición — H-MM-5

Validator nuevo en `scripts/edge-research/` (alta en `registry.yaml` + export SQL
de `mm_live_fills` en el cron semanal). Mismo bar que el resto: bootstrap, floor
n=200, cohortes por market_type × banda de spread × horizonte. A diferencia de
H-MM-4 **no hay drain bounds** (cola real). Mide retained real por fill + PnL
contable completo (spread + Δinventario + rewards reales si H-MM-2 ya tiene
modelo de reparto). Métricas operativas: fills/día, uptime elegible rewards,
inventario medio/máx, churn de replaces, round-trip completion real.

## Testing (TDD) — sobre la matriz shadow del 06-12

- **OrderGateway**: mock del clob-client (post/cancel/cancel-all/renovación GTD
  con reloj mockeado); reconciliación fill→ledger; fill de `order_id` desconocido
  ignorado; cancel-all en boot, SIGTERM y kill.
- **RiskGuard**: cada límite dispara kill end-to-end sintético; kill persiste
  `mode=off` en `mm_quoter_state`; re-arm exige acción explícita (no se
  auto-resetea).
- **LiveLedger**: invariantes contables (cash+M2M=PnL; round-trip realized
  exacto); fills parciales acumulables.
- **Identidad ledger shadow↔live**: alimentar `LiveLedger` y `ShadowLedger` con
  la misma secuencia de fills produce idéntico inventario/PnL contable.
- **Smoke dry-run** manual en la VM antes del gate.

## Fuera de alcance (v1) — hereda del 06-12

- Pricing-skew continuo por inventario (solo retirada de lado + `exit_improve` 1 tick).
- Auto-flatten del inventario en kill.
- Fair-value model propio (quotamos relativo al book).
- Reconciliación de órdenes órfanas (cancel-all al arrancar).
- Re-arm automático del kill-switch.
- Ampliación del universo más allá del recorder (N=45).

## Riesgos y mitigaciones (adicionales a los del 06-12)

| Riesgo | Mitigación |
|---|---|
| Edge shadow no se traslada a live (cola exacta < proxy) | El gate 06-22 usa H-MM-4 cola-exacta, no H-MM-3; capital micro día 1; H-MM-5 mide la verdad |
| clob-client no expone WS user-channel | Fallback REST poll; capacidad confirmada en smoke pre-gate |
| Fill perdido por reconciliación (poll lag) | order_ids trackeados + RiskGuard sobre inventario real, no sobre fills esperados |
| Doble-entrega de fill (WS eco) | Idempotencia por order_id en el gateway |
| Key filtrada | Solo el nombre del secret en compose; fetch por IAM al boot |
