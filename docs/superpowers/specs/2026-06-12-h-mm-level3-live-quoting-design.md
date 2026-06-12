# H-MM Nivel 3 — Live Quoting Pilot (shadow → real mínimo)

**Fecha:** 2026-06-12
**Estado:** diseño aprobado en sesión; pendiente de plan de implementación
**Contexto previo:** H-MM-1 PASS (+0.15–0.23%/fill, proxy Δ≈10min), H-MM-3 PASS
con bounds front/back y precio anclado (fix 2026-06-12: headline back
+0.69/+0.54/+0.37% a 10s/60s/300s). Caveat estructural restante: la posición de
cola es inobservable offline. H-MM-2 (rewards) verdict ~2026-06-24.

## Objetivo

Cerrar el caveat de cola y producir el primer verdict de market-making con cola
exacta, en dos fases:

1. **Shadow** — quotes virtuales contra el libro real en vivo, sin órdenes.
   Cola inicial exacta (acabamos de llegar al touch), bounds estrechos sobre el
   drenaje. Sin riesgo, sin pre-requisitos operativos.
2. **Real mínimo** — órdenes reales pequeñas tras pasar un gate explícito.
   Cierra la cola a verdad exacta. Capital decidido en el gate con datos
   (defaults de prueba: $100 notional / $50 max loss).

El objetivo del piloto es **medir**, no ganar: con ~0.5% retenido/fill y $100
rotando, el PnL esperado es ~$1–3/día.

## Decisiones tomadas (con el usuario, 2026-06-12)

| Decisión | Elección |
|---|---|
| Naturaleza del piloto | Escalonado: shadow → real mínimo con gate |
| Rewards (H-MM-2) | Integrados desde el diseño como inputs de primera clase |
| Presupuesto de riesgo | Parametrizado; defaults $100/$50 para pruebas; monto final en el gate |
| Arquitectura | Módulo dentro de `packages/mm-recorder` (opción A) |

## Arquitectura

Componentes nuevos en `packages/mm-recorder`, mismo proceso y perfil `capture`,
activados por `MM_QUOTER_MODE=off|shadow|live` (default `off` — el recorder
desplegado no cambia de comportamiento hasta activarlo).

```
WS CLOB (existente) ──> BookState L2 (existente) ──┐
                   ──> TradeEvents (existente) ────┤
mm_reward_snapshots (existente) ───────────────────┤
                                                   v
                                            QuoteEngine (loop reactivo)
                                                   │
                              ┌────────────────────┼────────────────────┐
                              v                    v                    v
                        QuotePolicy          RiskGuard            (modo live)
                     quotes deseadas      límites + kill         OrderGateway
                              │              switch                    │
                              v                                        v
                        ShadowLedger                             LiveLedger
                              │                                        │
                              └──────────────┬─────────────────────────┘
                                             v
              mm_quote_state / mm_shadow_fills / mm_live_orders / mm_live_fills
                     (TimescaleDB, CREATE TABLE IF NOT EXISTS en runtime)
```

- **QuoteEngine**: reactivo a eventos del book (no polling). Cambio de book →
  recalcular quotes deseadas → ledger activo y/o gateway.
- **QuotePolicy**: función pura `(book, rewards, inventario, config) →
  {bid, ask, size} | no-quote`. Toda la economía vive aquí; testeable sin red.
- **ShadowLedger**: quotes virtuales con cola exacta (ver abajo).
- **OrderGateway** (solo live): wrapper de `@polymarket/clob-client`.
- **RiskGuard**: límites + kill switch; estado persistido en `mm_quoter_state`.

Tablas creadas en runtime (las migraciones init solo corren en el primer
volumen — gotcha conocido).

**Universo:** shadow hereda el universo del recorder (N=45,
event_financial+long+short). El subset live se elige en el gate (tradeable con
mejor cohorte + programa de rewards).

## QuotePolicy — economía

- **Precio: join-the-touch**, exactamente la política que H-MM-1/H-MM-3
  midieron. Excepción etiquetada: con programa de rewards y touch fuera de la
  banda elegible (`spread quote-vs-mid > rewardsMaxSpread`), quotar en el borde
  elegible (mejora el book). Fills de ese modo llevan flag
  `rewards_constrained` y se analizan como cohorte aparte (no medida offline).
- **Guards (no quotar):** near-resolution (<24h a end_date, parám.); libro
  one-sided o vacío; inventario al cap → se retira solo el lado que lo
  aumentaría (sin pricing-skew continuo en v1).
- **Umbral de spread: aprendido, no hardcodeado.** En shadow se quota todo y se
  mide retained por banda de spread; `MM_MIN_SPREAD_CENTS` para live se fija en
  el gate con esa curva. (Motivado por la auditoría 2026-06-12: el retained se
  concentra en spreads anchos.)
- **Tamaño:** `max(rewardsMinSize, MM_QUOTE_SIZE=20 shares)` — el shadow simula
  el tamaño que el live usaría para que la cola simulada sea la real.
- **Re-quote con histéresis:** cancel/replace solo por price-out o por salida
  de banda rewards; nunca por cambios de tamaño del touch. Cada replace resetea
  la cola. Intervalo mínimo entre replaces por token (default 1s).
- **Rewards:** registro por minuto de elegibilidad (two-sided, en banda,
  ≥minSize) → subsidio devengado estimado con `mm_reward_snapshots`. El modelo
  de reparto se sustituye por el de H-MM-2 cuando haya verdict.

## ShadowLedger — cola exacta

La mejora central sobre H-MM-3: al colocar nosotros la quote, la posición
inicial de cola es exacta — `queue_ahead = touch_size` en ese instante (somos
los últimos del nivel). La incertidumbre restante son las cancelaciones delante
(un cancel observado en el nivel puede ser de delante o detrás). Dos contadores
por quote:

- `drain_trades_only` — conservador: los cancels no acercan el fill.
- `drain_with_cancels` — optimista: todo cancel del nivel drena.

Bounds mucho más estrechos que front/back; la fase real los colapsa a verdad.

Mecánica:

- **Precio anclado al de colocación** por construcción (lección del fix
  2026-06-12 en `mm_fine.py`).
- **Fills parciales** acumulables hasta `quote_size`.
- **Price-out** → cierre de quote virtual sin fill + re-quote con cola nueva.
  Churn de replaces/hora registrado (input del rate budget live).
- **TTL simulado**: el shadow renueva quotes al mismo `MM_ORDER_TTL` que usará
  el live (las GTD expiran), para que la proyección incluya el coste de cola
  perdido en cada renovación.
- **Disconnect WS** → invalidar quotes virtuales (patrón GapTracker).
- **Inventario virtual** por mercado con mark-to-market al mid; los caps de
  inventario se aplican en shadow igual que en live (retirada de lado
  incluida). PnL sombra descompuesto: spread capturado + Δ inventario +
  rewards estimados. El inventario es el riesgo que el offline no midió.
- Fills → `mm_shadow_fills` (time, token, side, placement_price, size,
  queue_ahead_initial, drain mode, spread_at_placement, flags). Los mids
  forward (10s/60s/300s) los calcula el validator desde `mm_book_events` — sin
  cómputo extra en runtime.

## Medición y verdict

- **H-MM-4** (shadow live-quoting): validator nuevo en el harness
  (`scripts/edge-research/`), mismo bar que todo lo demás — bootstrap, floor
  n=200, cohortes por market_type × banda de spread × horizonte × drain bound.
  Alta en `registry.yaml` + export SQL en el cron semanal.
- **H-MM-5** (live real): reservado para la fase 2; mide retained real por fill
  + PnL contable completo.
- Métricas operativas además del retained: fills/día, uptime elegible rewards,
  inventario medio/máximo, churn de replaces.

## Gate shadow → real (todos necesarios)

1. ≥7 días de shadow estable: sin crashes, sin leaks, RAM del contenedor en
   budget (límite 120MB).
2. H-MM-4 PASS en la cohorte objetivo, con ambos drain bounds coherentes.
3. Proyección publicada de fills/día y PnL/día → decisión de capital con datos
   (defaults de prueba $100 notional / $50 max loss).
4. Churn de replaces dentro del rate budget del CLOB.
5. Wallet dedicada + GCP Secret Manager + USDC listos (pre-reqs compartidos con
   el track real-trading, arranque ~2026-06-15).

## Fase real — OrderGateway y RiskGuard

- **OrderGateway**: `@polymarket/clob-client` (validar drift de versión: la
  integración taker es de 2026-03; `pnpm outdated` + smoke antes de confiar).
  Post limit / cancel / cancel-all; replace = cancel+post. Reconciliación de
  fills por user-channel del WS si el client lo expone, si no polling REST.
  Arranque en live → **cancel-all incondicional** (sin reconciliar órfanas en
  v1).
- **Dead-man's switch: órdenes GTD** con TTL renovable (`MM_ORDER_TTL`, default
  30 min) en lugar de GTC — si el proceso muere, las órdenes expiran solas.
  SIGTERM → cancel-all graceful además.
- **RiskGuard** (env, defaults de prueba): `MM_MAX_NOTIONAL_TOTAL=$100`,
  `MM_MAX_INVENTORY_PER_MARKET=$20`, `MM_MAX_INVENTORY_TOTAL=$60`,
  `MM_MAX_CUM_LOSS=$50` (realized + M2M). Violación → kill switch: cancel-all,
  modo off persistido en `mm_quoter_state`, alerta. **Sin auto-flatten** — el
  inventario residual (≤$20/mercado) queda a decisión humana; cruzar el spread
  para cerrarlo es pagar lo que intentamos cobrar.
- **Watchdog**: el daily watchdog lee `mm_quoter_state` (kill switch, modo,
  última actividad).

## Operativa

- Misma imagen Docker mm-recorder; activar shadow = cambio de env en compose +
  restart, sin deploy nuevo.
- Stats horarias al log: quotes activas, fills, inventario, PnL, elegibilidad.
- Wallet dedicada compartida con el track real-trading; key en Secret Manager.

## Testing (TDD)

- **QuotePolicy**: unitarios por guard + modo `rewards_constrained` (función
  pura).
- **ShadowLedger**: matriz direccional sintética — precio moviéndose entre
  colocación y fill, BUY/SELL × profit/adverse (la clase de bug del re-pricing
  fantasma); fills parciales; price-out; TTL churn; ambos drain counters; gaps.
- **OrderGateway**: mock del clob-client; smoke dry-run manual en VM antes del
  gate.
- **RiskGuard**: cada límite dispara kill; cancel-all en SIGTERM.
- **Integración**: replay determinista de un día real de
  `mm_book_events`/`mm_trade_events` como fixture de regresión del shadow.

## Fuera de alcance (v1)

- Pricing-skew continuo por inventario (solo retirada de lado).
- Auto-flatten del inventario en kill.
- Fair-value model propio (quotamos relativo al book, no a un fair teórico).
- Reconciliación de órdenes órfanas (cancel-all al arrancar).
- Ampliación del universo más allá del recorder (N=45).

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| RAM en e2-micro | Mismo proceso que el recorder; ledger ligero; límite 120MB vigilado en gate |
| Proceso muere con órdenes vivas | GTD TTL (dead-man's switch) + cancel-all en SIGTERM |
| Adverse selection mayor que lo medido | Caps de inventario + `MM_MAX_CUM_LOSS` + kill switch |
| Resolución contra inventario | Guard near-resolution 24h + cap $20/mercado |
| clob-client drift | Re-validación explícita antes del gate |
| Shadow optimista (cancels) | Dos drain bounds reportados; verdad en fase real |
